import { WorkingCalendar, canPause, computeDeadline, trafficLight, type DeadlineRule, type Pause } from '@flux/working-days';
import { audit, type AuditActor } from '../audit/audit.js';
import { today } from '../core/config.js';
import { maybeOne, one, query, tx, type Db } from '../core/db.js';
import { AppError, notFound } from '../core/errors.js';
import { notifyUsers } from '../notifications/service.js';

export async function loadCalendar(db: Db, organizationId: string): Promise<WorkingCalendar> {
  const holidays = await query(db, `select day from holiday where organization_id = $1`, [organizationId]);
  const exceptions = await query(db, `select day, is_working from working_day_exception where organization_id = $1`, [organizationId]);
  return new WorkingCalendar({
    holidays: holidays.map((h) => h.day as string),
    exceptions: exceptions.map((e) => [e.day as string, e.is_working as boolean] as [string, boolean]),
  });
}

function ruleOf(def: Record<string, any>): DeadlineRule {
  return {
    dayType: def.day_type,
    days: def.days,
    pauseMode: def.pause_mode,
    maxPauses: def.max_pauses,
    maxPausedDays: def.max_paused_days,
    extensionDays: def.extension_days,
  };
}

async function loadDeadline(db: Db, deadlineId: string) {
  const d = await maybeOne(
    db,
    `select d.*, dd.day_type, dd.days, dd.pause_mode, dd.max_pauses, dd.max_paused_days, dd.extension_days, dd.warn_before_days,
            dd.name as definition_name, dd.legal_status, dd.legal_reference, i.organization_id
       from deadline d join deadline_definition dd on dd.id = d.definition_id join instance i on i.id = d.instance_id
      where d.id = $1 for update of d`,
    [deadlineId],
  );
  if (!d) throw notFound('Termenul');
  const pauses = await query(db, `select paused_on, resumed_on from deadline_pause where deadline_id = $1 order by paused_on`, [deadlineId]);
  return { d, pauses: pauses.map((p): Pause => ({ from: p.paused_on, to: p.resumed_on })) };
}

/** Recomputes due_on / pause counters from the pauses and the calendar. */
export async function recompute(db: Db, deadlineId: string): Promise<void> {
  const { d, pauses } = await loadDeadline(db, deadlineId);
  const cal = await loadCalendar(db, d.organization_id);
  const state = computeDeadline(ruleOf(d), d.started_on, pauses, cal, { today: today(), extended: d.extended });
  await query(
    db,
    `update deadline set due_on = coalesce($2, due_on), pause_count = $3, paused_days = $4,
            status = case when status in ('running', 'paused') then $5 else status end
      where id = $1`,
    [deadlineId, state.dueOn, pauses.length, state.pausedDays, state.paused ? 'paused' : 'running'],
  );
}

export async function startDeadline(
  db: Db,
  args: { organizationId: string; instanceId: string; key: string; definitionKey: string; startedOn: string; taskId?: string | null },
): Promise<string | null> {
  const def = await maybeOne(db, `select id from deadline_definition where organization_id = $1 and key = $2`, [args.organizationId, args.definitionKey]);
  if (!def) throw new AppError(500, `Termenul „${args.definitionKey}” nu este configurat. Contactați administratorul funcțional.`);
  const existing = await maybeOne(db, `select id from deadline where instance_id = $1 and deadline_key = $2 and status <> 'cancelled'`, [args.instanceId, args.key]);
  if (existing) return existing.id;
  const row = await one(
    db,
    `insert into deadline (instance_id, task_id, definition_id, deadline_key, started_on, due_on)
     values ($1, $2, $3, $4, $5, $5) returning id`,
    [args.instanceId, args.taskId ?? null, def.id, args.key, args.startedOn],
  );
  await recompute(db, row.id);
  return row.id;
}

async function activeDeadline(db: Db, instanceId: string, key: string) {
  return maybeOne(db, `select id from deadline where instance_id = $1 and deadline_key = $2 and status in ('running', 'paused')`, [instanceId, key]);
}

/**
 * Suspends a deadline (e.g. while the beneficiary answers clarifications). When the cap on
 * suspensions is reached the suspension is refused and the head of unit is notified.
 */
export async function pauseDeadline(db: Db, actor: AuditActor, instanceId: string, key: string, reason: string, headUserIds: string[]): Promise<void> {
  const active = await activeDeadline(db, instanceId, key);
  if (!active) return;
  const { d, pauses } = await loadDeadline(db, active.id);
  if (pauses.some((p) => p.to === null)) return;
  const check = canPause(ruleOf(d), d.pause_count, d.paused_days);
  if (!check.allowed) {
    const message =
      check.reason === 'max_pauses'
        ? `S-a atins numărul maxim de suspendări (${d.max_pauses}) pentru termenul „${d.definition_name}”.`
        : `S-a atins numărul maxim de zile de suspendare (${d.max_paused_days}) pentru termenul „${d.definition_name}”.`;
    const error = new AppError(422, `${message} Termenul nu mai poate fi suspendat; șeful de serviciu a fost anunțat.`, [], { code: check.reason });
    // The transition is rolled back; the notification and its audit event are written afterwards.
    error.onRollback = () =>
      tx(async (after) => {
        await notifyUsers(after, headUserIds, { kind: 'deadline_pause_refused', instanceId, title: message });
        await audit(after, actor, { action: 'deadline.pause_refused', entityType: 'deadline', entityId: active.id, newValue: { reason: check.reason } });
      });
    throw error;
  }
  await query(db, `insert into deadline_pause (deadline_id, paused_on, reason, created_by) values ($1, $2, $3, $4)`, [
    active.id,
    today(),
    reason,
    actor.userId,
  ]);
  await recompute(db, active.id);
  await audit(db, actor, { action: 'deadline.pause', entityType: 'deadline', entityId: active.id, newValue: { reason, from: today() } });
}

export async function resumeDeadline(db: Db, actor: AuditActor, instanceId: string, key: string): Promise<void> {
  const active = await activeDeadline(db, instanceId, key);
  if (!active) return;
  const updated = await query(db, `update deadline_pause set resumed_on = $2 where deadline_id = $1 and resumed_on is null returning id`, [active.id, today()]);
  if (!updated.length) return;
  await recompute(db, active.id);
  await audit(db, actor, { action: 'deadline.resume', entityType: 'deadline', entityId: active.id, newValue: { on: today() } });
}

/** Stops the clock: met when today is on or before the due date, breached otherwise. */
export async function stopDeadline(db: Db, instanceId: string, key: string): Promise<void> {
  const active = await activeDeadline(db, instanceId, key);
  if (!active) return;
  const closed = await query(db, `update deadline_pause set resumed_on = $2 where deadline_id = $1 and resumed_on is null returning id`, [active.id, today()]);
  if (closed.length) await recompute(db, active.id);
  await query(
    db,
    `update deadline set status = case when $2::date <= due_on then 'met' else 'breached' end, closed_at = now() where id = $1`,
    [active.id, today()],
  );
}

export async function cancelDeadlines(db: Db, instanceId: string): Promise<void> {
  await query(db, `update deadline set status = 'cancelled', closed_at = now() where instance_id = $1 and status in ('running', 'paused')`, [instanceId]);
}

export async function deadlinesForInstance(db: Db, organizationId: string, instanceId: string) {
  const cal = await loadCalendar(db, organizationId);
  const rows = await query(
    db,
    `select d.id, d.deadline_key, d.started_on, d.due_on, d.status, d.pause_count, d.paused_days,
            dd.name, dd.day_type, dd.days, dd.max_pauses, dd.legal_status, dd.legal_reference, dd.warn_before_days
       from deadline d join deadline_definition dd on dd.id = d.definition_id
      where d.instance_id = $1 and d.status <> 'cancelled' order by d.started_on`,
    [instanceId],
  );
  return rows.map((r) => ({
    id: r.id,
    key: r.deadline_key,
    name: r.name,
    startedOn: r.started_on,
    dueOn: r.status === 'paused' ? null : r.due_on,
    status: r.status,
    pauseCount: r.pause_count,
    maxPauses: r.max_pauses,
    pausedDays: r.paused_days,
    rule: `${r.days} zile ${r.day_type === 'working' ? 'lucrătoare' : 'calendaristice'}`,
    legalStatus: r.legal_status,
    legalReference: r.legal_reference,
    traffic: r.status === 'running' ? trafficLight(r.due_on, today(), r.warn_before_days, cal) : null,
  }));
}

/**
 * Periodic scan (worker): reminders before the due date and escalation after it.
 * Each deadline gets at most one reminder per day and one escalation.
 */
export async function scanDeadlines(db: Db): Promise<{ reminded: number; escalated: number }> {
  const day = today();
  const rows = await query(
    db,
    `select d.id, d.instance_id, d.due_on, d.task_id, d.last_reminder_at, d.escalated_at, dd.warn_before_days, dd.name,
            i.organization_id, i.title, i.responsible_user_id
       from deadline d join deadline_definition dd on dd.id = d.definition_id join instance i on i.id = d.instance_id
      where d.status = 'running'`,
  );
  let reminded = 0;
  let escalated = 0;
  const calendars = new Map<string, WorkingCalendar>();
  for (const r of rows) {
    let cal = calendars.get(r.organization_id);
    if (!cal) calendars.set(r.organization_id, (cal = await loadCalendar(db, r.organization_id)));
    const assignees = (
      await query(db, `select assignee_user_id from task where instance_id = $1 and status = 'open' and assignee_user_id is not null`, [r.instance_id])
    ).map((t) => t.assignee_user_id as string);
    const light = trafficLight(r.due_on, day, r.warn_before_days, cal);
    if (light === 'red' && !r.escalated_at) {
      const heads = (
        await query(
          db,
          `select distinct dep.head_user_id from app_user u join department dep on dep.id = u.department_id
            where u.id = any($1::uuid[]) and dep.head_user_id is not null`,
          [[...assignees, r.responsible_user_id].filter(Boolean)],
        )
      ).map((h) => h.head_user_id as string);
      await notifyUsers(db, [...heads, ...assignees], {
        kind: 'deadline_breached',
        instanceId: r.instance_id,
        title: `Termen depășit: ${r.name} – ${r.title}`,
        body: `Termenul „${r.name}” a expirat la ${r.due_on}.`,
      });
      await query(db, `update deadline set escalated_at = now() where id = $1`, [r.id]);
      escalated++;
    } else if (light === 'yellow' && (!r.last_reminder_at || new Date(r.last_reminder_at).toISOString().slice(0, 10) !== day)) {
      await notifyUsers(db, assignees, {
        kind: 'deadline_warning',
        instanceId: r.instance_id,
        title: `Termen apropiat: ${r.name} – ${r.title}`,
        body: `Termenul „${r.name}” expiră la ${r.due_on}.`,
      });
      await query(db, `update deadline set last_reminder_at = now() where id = $1`, [r.id]);
      reminded++;
    }
  }
  return { reminded, escalated };
}
