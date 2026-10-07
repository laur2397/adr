import {
  evaluate,
  findStep,
  truthy,
  validateForStep,
  type Action,
  type PathDef,
  type ProcessDefinition,
  type StepDef,
} from '@flux/process-schema';
import { addAmounts } from '@flux/validators';
import { grant, SUPERVISOR_ROLES } from '../access/policy.js';
import { audit, type AuditActor } from '../audit/audit.js';
import { today } from '../core/config.js';
import { maybeOne, one, query, type Db } from '../core/db.js';
import { AppError, forbidden, notFound, unprocessable } from '../core/errors.js';
import { enqueue } from '../core/outbox.js';
import { pauseDeadline, resumeDeadline, startDeadline, stopDeadline, cancelDeadlines } from '../deadlines/service.js';
import { loadFields, refreshCalculated, saveField } from '../forms/store.js';
import { actorOf, type CurrentUser } from '../identity/context.js';
import { notifyUsers, usersWithRole } from '../notifications/service.js';
import { createEntry, lastEntryForInstance, upsertCorrespondent } from '../registry/service.js';
import { invalidateSignaturesSince } from '../signing/invalidate.js';
import { assertCoiDeclared } from '../controls/coi.js';
import { evidenceCounts } from '../visits/evidence.js';
import { loadInstance, type InstanceContext } from './load.js';
import { actingAs, type TaskRow } from './tasks.js';

/** Runtime state for one engine operation (one transaction). */
interface Run {
  db: Db;
  ctx: InstanceContext;
  /** Human who triggered the operation (null for system steps run by the worker). */
  user: CurrentUser | null;
  actor: AuditActor & { userId: string };
  /** For chosen_by_previous assignment. */
  assignTo?: string | null;
  /** Guard against definitions that loop through system steps forever. */
  hops: number;
}

const MAX_HOPS = 100;

async function ruleData(run: Run) {
  const { values } = await loadFields(run.db, run.ctx.instance.id);
  return {
    fields: values,
    project: run.ctx.project,
    beneficiary: run.ctx.beneficiary,
    instance: run.ctx.instance,
    user: run.user ? { id: run.user.id, roles: run.user.roles.map((r) => r.key) } : null,
  };
}

async function roleId(db: Db, organizationId: string, key: string): Promise<string> {
  const r = await maybeOne(db, `select id from role where organization_id = $1 and key = $2`, [organizationId, key]);
  if (!r) throw new AppError(500, `Rolul „${key}” nu există. Contactați administratorul funcțional.`);
  return r.id;
}

async function userHasRole(db: Db, userId: string, roleKey: string): Promise<boolean> {
  const r = await maybeOne(
    db,
    `select 1 from role_assignment ra join role r on r.id = ra.role_id join app_user u on u.id = ra.user_id and u.active
      where ra.user_id = $1 and r.key = $2 and ra.valid_from <= current_date and (ra.valid_to is null or ra.valid_to >= current_date)`,
    [userId, roleKey],
  );
  return Boolean(r);
}

async function lastActorAt(db: Db, instanceId: string, stepKey: string): Promise<string | null> {
  const r = await maybeOne(
    db,
    `select coalesce(on_behalf_of, completed_by) as uid from task where instance_id = $1 and step_key = $2 and status = 'completed'
      order by completed_at desc limit 1`,
    [instanceId, stepKey],
  );
  return r?.uid ?? null;
}

interface Assignee {
  assigneeUserId: string | null;
  candidateRoleId: string | null;
  candidateDepartmentId: string | null;
}

async function resolveAssignment(run: Run, step: StepDef): Promise<Assignee> {
  const { db, ctx } = run;
  const org = ctx.instance.organization_id;
  const a = step.assignment;
  const none: Assignee = { assigneeUserId: null, candidateRoleId: null, candidateDepartmentId: null };
  const queue = async (roleKey: string | undefined): Promise<Assignee> => {
    if (!roleKey) throw new AppError(500, `Pasul „${step.name}” nu are un rol pentru repartizare.`);
    return { ...none, candidateRoleId: await roleId(db, org, roleKey) };
  };
  // The start step belongs to whoever opens the dossier, unless the dossier was opened by another
  // process (sub-flow) and the step names who handles it.
  if (step.type === 'start' && !(a && ctx.instance.parent_instance_id)) return { ...none, assigneeUserId: run.actor.userId };
  if (!a) return queue(undefined);
  switch (a.rule) {
    case 'role_queue':
      return queue(a.role);
    case 'fixed_user': {
      const u = await maybeOne(db, `select id from app_user where organization_id = $1 and username = $2 and active`, [org, a.user]);
      if (!u) throw new AppError(500, `Utilizatorul „${a.user}” din definiția procesului nu există.`);
      return { ...none, assigneeUserId: u.id };
    }
    case 'project_expert': {
      const expert = ctx.project?.responsible_expert_id as string | undefined;
      if (expert && (!a.role || (await userHasRole(db, expert, a.role)))) return { ...none, assigneeUserId: expert };
      return queue(a.role);
    }
    case 'previous_actor': {
      const uid = await lastActorAt(db, ctx.instance.id, a.step!);
      return uid ? { ...none, assigneeUserId: uid } : queue(a.role);
    }
    case 'department_head': {
      // Head of the department of whoever completed `step` (e.g. the expert who drafted the note),
      // else of whoever moved the dossier here, else of the responsible user.
      const ref = (a.step ? await lastActorAt(db, ctx.instance.id, a.step) : null) ?? (run.user?.departmentId ? run.user.id : ctx.instance.responsible_user_id);
      const head = ref
        ? await maybeOne(db, `select d.head_user_id from app_user u join department d on d.id = u.department_id where u.id = $1`, [ref])
        : null;
      if (head?.head_user_id && head.head_user_id !== run.user?.id) return { ...none, assigneeUserId: head.head_user_id };
      return queue(a.role ?? 'head_of_unit');
    }
    case 'least_loaded': {
      const r = await maybeOne(
        db,
        `select ra.user_id, count(t.id) as load from role_assignment ra
           join role r on r.id = ra.role_id join app_user u on u.id = ra.user_id and u.active
           left join task t on t.assignee_user_id = ra.user_id and t.status = 'open'
          where r.organization_id = $1 and r.key = $2 and ra.valid_from <= current_date and (ra.valid_to is null or ra.valid_to >= current_date)
          group by ra.user_id order by load, ra.user_id limit 1`,
        [org, a.role],
      );
      return r ? { ...none, assigneeUserId: r.user_id } : queue(a.role);
    }
    case 'chosen_by_previous': {
      if (!run.assignTo) throw unprocessable(`Alegeți persoana căreia îi repartizați pasul „${step.name}”.`, [{ field: 'assignTo', message: 'Obligatoriu' }]);
      if (a.role && !(await userHasRole(db, run.assignTo, a.role))) throw unprocessable('Persoana aleasă nu are rolul necesar pentru acest pas.');
      return { ...none, assigneeUserId: run.assignTo };
    }
    default:
      return queue(a.role);
  }
}

async function createTask(run: Run, executionId: string, step: StepDef): Promise<string> {
  const { db, ctx } = run;
  const who = await resolveAssignment(run, step);
  let dueAt: string | null = null;
  if (step.deadline) {
    const d = await maybeOne(db, `select due_on from deadline where instance_id = $1 and deadline_key = $2 and status = 'running'`, [
      ctx.instance.id,
      step.deadline,
    ]);
    dueAt = d ? `${d.due_on}T23:59:59` : null;
  }
  const task = await one(
    db,
    `insert into task (instance_id, execution_id, step_key, name, assignee_user_id, candidate_role_id, candidate_department_id, due_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [ctx.instance.id, executionId, step.key, step.name, who.assigneeUserId, who.candidateRoleId, who.candidateDepartmentId, dueAt],
  );
  if (who.assigneeUserId) {
    await grant(db, ctx.instance.id, 'user', who.assigneeUserId, 'edit', 'assignee', null);
    if (who.assigneeUserId !== run.actor.userId) {
      await notifyUsers(db, [who.assigneeUserId], { kind: 'task_assigned', instanceId: ctx.instance.id, title: `Sarcină nouă: ${step.name} – ${ctx.instance.title}` });
    }
  }
  if (who.candidateRoleId) {
    await grant(db, ctx.instance.id, 'role', who.candidateRoleId, 'edit', 'queue', null);
    const key = step.assignment?.role;
    if (key) {
      const members = await usersWithRole(db, ctx.instance.organization_id, key);
      await notifyUsers(db, members, { kind: 'task_queue', instanceId: ctx.instance.id, title: `Sarcină nouă în coada „${step.name}” – ${ctx.instance.title}` });
    }
  }
  if (who.candidateDepartmentId) await grant(db, ctx.instance.id, 'department', who.candidateDepartmentId, 'edit', 'queue', null);
  return task.id;
}

async function history(run: Run, stepKey: string) {
  await query(run.db, `insert into step_history (instance_id, step_key, entered_at) values ($1, $2, clock_timestamp())`, [run.ctx.instance.id, stepKey]);
}

async function closeHistory(run: Run, stepKey: string, actorId: string | null, onBehalfOf: string | null, pathKey: string | null, comment: string | null) {
  await query(
    run.db,
    `update step_history set left_at = clock_timestamp(), actor_user_id = $3, on_behalf_of = $4, path_key = $5, comment = $6
      where id = (select id from step_history where instance_id = $1 and step_key = $2 and left_at is null order by entered_at desc limit 1)`,
    [run.ctx.instance.id, stepKey, actorId, onBehalfOf, pathKey, comment],
  );
}

async function deadlineStartDay(run: Run, definitionKey: string): Promise<string> {
  const def = await maybeOne(run.db, `select start_point from deadline_definition where organization_id = $1 and key = $2`, [
    run.ctx.instance.organization_id,
    definitionKey,
  ]);
  if (def?.start_point === 'submission_date') {
    const { fields } = await ruleData(run);
    if (typeof fields.submitted_at === 'string') return fields.submitted_at;
  }
  if (def?.start_point === 'registration_date') {
    const e = await maybeOne(run.db, `select registered_at from register_entry where instance_id = $1 order by registered_at limit 1`, [run.ctx.instance.id]);
    if (e) return new Date(e.registered_at).toISOString().slice(0, 10);
  }
  return today();
}

async function startDeadlines(run: Run, filter: (d: NonNullable<ProcessDefinition['deadlines']>[number]) => boolean) {
  const candidates = (run.ctx.def.deadlines ?? []).filter(filter);
  const data = candidates.some((d) => d.when !== undefined) ? await ruleData(run) : null;
  for (const d of candidates) {
    if (d.when !== undefined && !truthy(d.when, data)) continue;
    await startDeadline(run.db, {
      organizationId: run.ctx.instance.organization_id,
      instanceId: run.ctx.instance.id,
      key: d.key,
      definitionKey: d.definition,
      startedOn: await deadlineStartDay(run, d.definition),
    });
  }
}

async function headsOf(run: Run): Promise<string[]> {
  const ids = [run.user?.id, run.ctx.instance.responsible_user_id].filter(Boolean);
  const rows = await query(
    run.db,
    `select distinct d.head_user_id from app_user u join department d on d.id = u.department_id where u.id = any($1::uuid[]) and d.head_user_id is not null`,
    [ids],
  );
  return rows.map((r) => r.head_user_id);
}

async function beneficiaryCorrespondent(run: Run): Promise<string | null> {
  const b = run.ctx.beneficiary;
  if (!b) return null;
  return upsertCorrespondent(run.db, run.ctx.instance.organization_id, { name: b.name, cui: b.cui, address: b.address, beneficiaryId: b.id });
}

async function runActions(run: Run, actions: Action[] | undefined) {
  for (const action of actions ?? []) {
    if (action.when !== undefined && !truthy(action.when, await ruleData(run))) continue;
    await runAction(run, action);
  }
}

async function runAction(run: Run, a: Action) {
  const { db, ctx, actor } = run;
  const instanceId = ctx.instance.id;
  switch (a.type) {
    case 'set_field': {
      const value = a.valueFrom !== undefined ? evaluate(a.valueFrom as never, await ruleData(run)) : a.value;
      await saveField(db, instanceId, String(a.field), value, 'calculated', actor.userId);
      return;
    }
    case 'generate_document':
      await enqueue(db, 'generate_document', { instanceId, docKey: a.document, userId: actor.userId });
      return;
    case 'register': {
      const direction = a.direction as 'in' | 'out' | 'internal';
      // once: keep the number already given (e.g. a decision numbered before signing, then returned).
      if (a.once && (await lastEntryForInstance(db, instanceId, String(a.register), direction))) return;
      const related =
        a.relatedTo === 'previous_out' || a.relatedTo === 'previous_in'
          ? await lastEntryForInstance(db, instanceId, String(a.register), a.relatedTo === 'previous_out' ? 'out' : 'in')
          : null;
      // Correspondent: the beneficiary, or (for general correspondence) whoever sent the incoming document.
      const lastIn = await lastEntryForInstance(db, instanceId, String(a.register), 'in');
      const correspondent = (await beneficiaryCorrespondent(run)) ?? lastIn?.sender_id ?? null;
      const doc = typeof a.document === 'string'
        ? await maybeOne(db, `select id from document where instance_id = $1 and doc_key = $2`, [instanceId, a.document])
        : null;
      const entry = await createEntry(db, actor, {
        registerKey: String(a.register),
        direction,
        subject: String(a.subject ?? (ctx.instance.title.startsWith(ctx.def.name) ? ctx.instance.title : `${ctx.def.name} – ${ctx.instance.title}`)),
        senderId: direction === 'in' ? correspondent : null,
        recipientId: direction === 'out' ? correspondent : null,
        instanceId,
        documentId: doc?.id ?? null,
        relatedEntryId: related?.id ?? null,
        channel: direction === 'internal' ? 'internal' : null,
        extra: typeof a.document === 'string' ? { docKey: a.document } : {},
      });
      if (direction === 'in' && !ctx.instance.reference_no) {
        await query(db, `update instance set reference_no = $2 where id = $1`, [instanceId, entry.number_display]);
        ctx.instance.reference_no = entry.number_display;
      }
      await saveField(db, instanceId, `reg_${a.register}_${direction}`, entry.number_display, 'calculated', actor.userId);
      return;
    }
    case 'notify': {
      const title = String(a.title ?? `${ctx.instance.title}: ${a.template}`);
      if (a.to === 'beneficiary_email') {
        await enqueue(db, 'email_beneficiary', { instanceId, template: a.template, attach: a.attach ?? [] });
      } else if (a.to === 'responsible' && ctx.instance.responsible_user_id) {
        await notifyUsers(db, [ctx.instance.responsible_user_id], { kind: 'process', instanceId, title });
      } else if (typeof a.to === 'string' && a.to.startsWith('role:')) {
        await notifyUsers(db, await usersWithRole(db, ctx.instance.organization_id, a.to.slice(5)), { kind: 'process', instanceId, title });
      }
      return;
    }
    case 'grant_access': {
      const permission = a.permission === 'view' ? 'view' : 'edit';
      if (a.principal === 'project_expert' && ctx.project?.responsible_expert_id) {
        await grant(db, instanceId, 'user', ctx.project.responsible_expert_id, permission, 'project_expert', actor.userId);
      } else if (typeof a.principal === 'string' && a.principal.startsWith('role:')) {
        await grant(db, instanceId, 'role', await roleId(db, ctx.instance.organization_id, a.principal.slice(5)), permission, 'process', actor.userId);
      }
      return;
    }
    case 'pause_deadline':
      await pauseDeadline(db, actor, instanceId, String(a.deadline), String(a.reason ?? 'suspendare'), await headsOf(run));
      return;
    case 'resume_deadline':
      await resumeDeadline(db, actor, instanceId, String(a.deadline));
      return;
    case 'update_budget_lines': {
      if (!ctx.project) return;
      const { fields } = await ruleData(run);
      const rows = (fields[String(a.from)] as Array<Record<string, unknown>> | undefined) ?? [];
      const byLine = new Map<string, string>();
      for (const r of rows) {
        const code = String(r.budget_line ?? '');
        if (!code) continue;
        byLine.set(code, addAmounts(byLine.get(code), r[String(a.amount ?? 'eligible')] as string | undefined));
      }
      for (const [code, amount] of byLine) {
        await query(db, `update project_budget_line set approved_to_date = approved_to_date + $3::numeric where project_id = $1 and code = $2`, [
          ctx.project.id,
          code,
          amount,
        ]);
      }
      await audit(db, actor, { action: 'project.budget_lines.update', entityType: 'project', entityId: ctx.project.id, newValue: Object.fromEntries(byLine) });
      return;
    }
    case 'create_debt': {
      // Debt security (titlu de creanta) in the debtor ledger; its number comes from the debtors register.
      if (!ctx.beneficiary) throw new AppError(422, 'Dosarul nu are beneficiar; titlul de creanță nu poate fi emis.');
      const { fields } = await ruleData(run);
      const principal = fields[String(a.principal)];
      const dueDate = fields[String(a.dueDate)];
      if (!principal || !dueDate) throw unprocessable('Completați suma și scadența titlului de creanță.');
      const existing = await maybeOne(db, `select id from debt where instance_id = $1 and status <> 'cancelled'`, [instanceId]);
      if (existing) return;
      const entry = await createEntry(db, actor, {
        registerKey: 'debtors',
        direction: 'internal',
        subject: `Titlu de creanță – ${ctx.beneficiary.name}`,
        instanceId,
      });
      const debt = await one(
        db,
        `insert into debt (organization_id, instance_id, project_id, beneficiary_id, title_number, title_date, due_date, principal, accessories, reason, created_by)
         values ($1, $2, $3, $4, $5, $11, $6, $7, $8, $9, $10) returning id`,
        [
          ctx.instance.organization_id, instanceId, ctx.project?.id ?? null, ctx.beneficiary.id, entry.number_display, dueDate, principal,
          a.accessories ? (fields[String(a.accessories)] ?? 0) : 0, String(fields[String(a.reason)] ?? a.reason), actor.userId, today(),
        ],
      );
      await saveField(db, instanceId, 'debt_title_number', entry.number_display, 'calculated', actor.userId);
      await audit(db, actor, { action: 'debt.create', entityType: 'debt', entityId: debt.id, newValue: { title: entry.number_display, principal, dueDate } });
      return;
    }
    case 'update_project': {
      // Only contractual data an addendum can change.
      const allowed = ['end_date', 'total_value', 'eligible_value', 'non_reimbursable_value', 'contract_number'];
      if (!ctx.project) return;
      const { fields } = await ruleData(run);
      const set = (a.set as Record<string, string>) ?? {};
      const old: Record<string, unknown> = {};
      const changed: Record<string, unknown> = {};
      for (const [column, fieldKey] of Object.entries(set)) {
        if (!allowed.includes(column)) throw new AppError(500, `update_project: coloana „${column}” nu poate fi modificată.`);
        const value = fields[fieldKey];
        if (value === null || value === undefined || value === '') continue;
        old[column] = ctx.project[column];
        changed[column] = value;
        await query(db, `update project set ${column} = $2 where id = $1`, [ctx.project.id, value]);
      }
      if (Object.keys(changed).length) {
        await audit(db, actor, { action: 'project.update', entityType: 'project', entityId: ctx.project.id, oldValue: old, newValue: changed });
      }
      return;
    }
    case 'request_signatures':
      return; // signatures are requested by requiresSignatures on paths; kept for definitions that list it
    case 'call_rest':
      await enqueue(db, 'call_rest', { instanceId, url: a.url, method: a.method ?? 'POST' });
      return;
    case 'start_subflow': {
      // Starts a related dossier without waiting for it (e.g. an irregularity file from a verification).
      await startChild(run, String(a.subflow), (a.inputs as Record<string, string> | undefined) ?? {});
      return;
    }
  }
}

async function startChild(run: Run, definitionKey: string, inputs: Record<string, string>): Promise<string> {
  if (!run.user) throw new AppError(500, 'Un sub-flux poate fi pornit doar de o acțiune a unui utilizator.');
  const { values } = await loadFields(run.db, run.ctx.instance.id);
  const fields: Record<string, unknown> = {};
  // "=value" passes a constant (e.g. the source of an irregularity), otherwise a parent field.
  for (const [childKey, parentKey] of Object.entries(inputs)) fields[childKey] = parentKey.startsWith('=') ? parentKey.slice(1) : (values[parentKey] ?? null);
  const childId = await startInstance(run.db, run.user, {
    definitionKey,
    projectId: run.ctx.instance.project_id,
    beneficiaryId: run.ctx.instance.beneficiary_id,
    fields,
    parentInstanceId: run.ctx.instance.id,
  });
  // Everyone who can see the parent dossier can see the child.
  await query(
    run.db,
    `insert into instance_acl (instance_id, principal_type, principal_id, permission, reason)
     select $1, principal_type, principal_id, 'view', 'parent' from instance_acl where instance_id = $2
     on conflict do nothing`,
    [childId, run.ctx.instance.id],
  );
  await audit(run.db, run.actor, { action: 'instance.subflow.start', entityType: 'instance', entityId: run.ctx.instance.id, newValue: { child: childId, definition: definitionKey } });
  return childId;
}

/** When a child dossier ends, the parent execution waiting for it continues. */
async function resumeParent(run: Run, childStatus: string): Promise<void> {
  const waiting = await maybeOne(
    run.db,
    `select e.id, e.instance_id, e.step_key from execution e where e.child_instance_id = $1 and e.status = 'waiting_join' for update`,
    [run.ctx.instance.id],
  );
  if (!waiting) return;
  const parentCtx = await loadInstance(run.db, waiting.instance_id, true);
  const parentRun: Run = { ...run, ctx: parentCtx, hops: run.hops };
  const step = findStep(parentCtx.def, waiting.step_key);
  const { values } = await loadFields(run.db, run.ctx.instance.id);
  for (const [parentKey, childKey] of Object.entries(step.outputs ?? {})) {
    const value = childKey === '$status' ? childStatus : (values[childKey] ?? null);
    await saveField(run.db, parentCtx.instance.id, parentKey, value, 'calculated', run.actor.userId);
  }
  await query(run.db, `update execution set status = 'active', child_instance_id = null where id = $1`, [waiting.id]);
  await closeHistory(parentRun, step.key, null, null, childStatus, null);
  await enter(parentRun, waiting.id, step.next!);
  await refreshCalculated(run.db, parentCtx.def, parentCtx.instance.id, { project: parentCtx.project, beneficiary: parentCtx.beneficiary });
}

/** Moves an execution into a step and runs it until it waits for a human or ends. */
async function enter(run: Run, executionId: string, stepKey: string): Promise<void> {
  if (++run.hops > MAX_HOPS) throw new AppError(500, 'Definiția procesului conține o buclă fără pași umani.');
  const { db, ctx } = run;
  const step = findStep(ctx.def, stepKey);
  await query(db, `update execution set step_key = $2, entered_at = clock_timestamp(), status = 'active' where id = $1`, [executionId, stepKey]);
  await history(run, stepKey);

  for (const d of ctx.def.deadlines ?? []) {
    if (d.stopsAt?.includes(stepKey)) await stopDeadline(db, ctx.instance.id, d.key);
  }
  await startDeadlines(run, (d) => d.startsAt === stepKey);
  await runActions(run, step.onEnter);

  switch (step.type) {
    case 'start':
    case 'human':
      await createTask(run, executionId, step);
      return;
    case 'system':
      await runActions(run, step.onExit);
      await closeHistory(run, stepKey, null, null, null, null);
      return enter(run, executionId, step.next!);
    case 'decision': {
      const data = await ruleData(run);
      const path = (step.paths ?? []).find((p) => truthy(p.visibleWhen, data));
      if (!path) throw new AppError(500, `Nicio condiție nu este îndeplinită la pasul de decizie „${step.name}”.`);
      await closeHistory(run, stepKey, null, null, path.key, null);
      await runActions(run, path.actions);
      return enter(run, executionId, path.to);
    }
    case 'parallel_split': {
      const data = await ruleData(run);
      const branches = (step.branches ?? []).filter((b) => truthy(b.when, data));
      if (!branches.length) throw new AppError(500, `Nicio ramură nu este activă la pasul „${step.name}”.`);
      await query(db, `update execution set status = 'waiting_join' where id = $1`, [executionId]);
      await closeHistory(run, stepKey, null, null, null, null);
      const children: string[] = [];
      for (const b of branches) {
        const child = await one(db, `insert into execution (instance_id, parent_id, step_key) values ($1, $2, $3) returning id`, [
          ctx.instance.id,
          executionId,
          b.to,
        ]);
        children.push(child.id);
      }
      for (let i = 0; i < branches.length; i++) await enter(run, children[i]!, branches[i]!.to);
      return;
    }
    case 'parallel_join': {
      await closeHistory(run, stepKey, null, null, null, null);
      const exec = await one(db, `select parent_id from execution where id = $1`, [executionId]);
      const parent = exec.parent_id
        ? await maybeOne(db, `select id from execution where id = $1 and status = 'waiting_join' for update`, [exec.parent_id])
        : null;
      if (!parent) {
        // Not inside a parallel region any more (e.g. after a return): just continue.
        return enter(run, executionId, step.next!);
      }
      await query(db, `update execution set status = 'done', left_at = clock_timestamp() where id = $1`, [executionId]);
      // Branches that already reached the join are 'done'; the others are still running.
      const pending = (
        await query(db, `select id from execution where parent_id = $1 and status in ('active', 'waiting_join')`, [parent.id])
      ).map((p) => p.id as string);
      if (step.join === 'any') {
        for (const p of pending) await cancelExecution(run, p);
      } else if (pending.length) {
        return; // wait for the other branches
      }
      return enter(run, parent.id, step.next!);
    }
    case 'end_positive':
    case 'end_negative': {
      await closeHistory(run, stepKey, null, null, null, null);
      await query(db, `update execution set status = 'done', left_at = clock_timestamp() where id = $1`, [executionId]);
      const others = await query(db, `select id from execution where instance_id = $1 and status in ('active', 'waiting_join') and id <> $2`, [
        ctx.instance.id,
        executionId,
      ]);
      for (const o of others) await cancelExecution(run, o.id);
      const status = step.type === 'end_positive' ? 'completed_positive' : 'completed_negative';
      await query(db, `update instance set status = $2, finished_at = now() where id = $1`, [ctx.instance.id, status]);
      if (step.type === 'end_negative') await cancelDeadlines(db, ctx.instance.id);
      for (const d of ctx.def.deadlines ?? []) await stopDeadline(db, ctx.instance.id, d.key);
      await audit(db, run.actor, { action: 'instance.finish', entityType: 'instance', entityId: ctx.instance.id, newValue: { status } });
      await resumeParent(run, status);
      return;
    }
    case 'subflow': {
      const childId = await startChild(run, step.subflow!, step.inputs ?? {});
      await query(db, `update execution set status = 'waiting_join', child_instance_id = $2 where id = $1`, [executionId, childId]);
      return;
    }
  }
}

async function cancelExecution(run: Run, executionId: string) {
  await query(run.db, `update task set status = 'cancelled' where execution_id = $1 and status = 'open'`, [executionId]);
  await query(run.db, `update execution set status = 'cancelled', left_at = clock_timestamp() where id = $1`, [executionId]);
}

function systemActor(organizationId: string, userId: string): AuditActor & { userId: string } {
  return { organizationId, userId };
}

export interface StartInput {
  definitionKey: string;
  projectId?: string | null;
  beneficiaryId?: string | null;
  title?: string | null;
  fields?: Record<string, unknown>;
  parentInstanceId?: string | null;
}

/** Creates an instance on the published definition, prefills its fields and enters the start step. */
export async function startInstance(db: Db, user: CurrentUser, input: StartInput): Promise<string> {
  const defRow = await maybeOne(db, `select id, definition from process_definition where organization_id = $1 and key = $2 and status = 'published'`, [
    user.organizationId,
    input.definitionKey,
  ]);
  if (!defRow) throw notFound(`Procesul „${input.definitionKey}”`);
  const def = defRow.definition as ProcessDefinition;
  const project = input.projectId
    ? await maybeOne(db, `select * from project where id = $1 and organization_id = $2`, [input.projectId, user.organizationId])
    : null;
  if (input.projectId && !project) throw notFound('Proiectul');
  if (def.subject.requires?.includes('project') && !project) throw unprocessable('Alegeți proiectul la care se referă dosarul.', [{ field: 'projectId', message: 'Obligatoriu' }]);
  const beneficiaryId = input.beneficiaryId ?? project?.beneficiary_id ?? null;
  if (def.subject.requires?.includes('beneficiary') && !beneficiaryId) {
    throw unprocessable('Alegeți beneficiarul (sau emitentul) dosarului.', [{ field: 'beneficiaryId', message: 'Obligatoriu' }]);
  }
  const title = input.title?.trim() || `${def.name}${project ? ` – SMIS ${project.smis_code}` : ''}`;
  const inst = await one(
    db,
    `insert into instance (organization_id, definition_id, title, project_id, beneficiary_id, program_id, responsible_user_id, started_by, parent_instance_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [user.organizationId, defRow.id, title, project?.id ?? null, beneficiaryId, project?.program_id ?? null, project?.responsible_expert_id ?? null, user.id, input.parentInstanceId ?? null],
  );
  const ctx = await loadInstance(db, inst.id, true);
  const run: Run = { db, ctx, user, actor: actorOf(user) as AuditActor & { userId: string }, hops: 0 };

  await grant(db, inst.id, 'user', user.id, 'edit', 'starter', user.id);
  for (const key of SUPERVISOR_ROLES) {
    const r = await maybeOne(db, `select id from role where organization_id = $1 and key = $2`, [user.organizationId, key]);
    if (r) await grant(db, inst.id, 'role', r.id, 'view', 'supervisor', null);
  }

  // Prefill with provenance.
  const prev = await maybeOne(
    db,
    `select i.id from instance i where i.definition_id in (select id from process_definition where organization_id = $1 and key = $2)
       and i.project_id = $3 and i.id <> $4 order by i.started_at desc limit 1`,
    [user.organizationId, def.key, project?.id ?? null, inst.id],
  );
  const prevFields = prev ? (await loadFields(db, prev.id)).values : {};
  for (const f of def.fields) {
    const p = f.prefill;
    if (!p) continue;
    let value: unknown;
    let source = 'manual';
    let sourceAt: string | null = null;
    if (p.from === 'project' && ctx.project) {
      value = ctx.project[p.path!];
      source = ctx.project.source === 'mysmis' ? 'mysmis' : 'project';
      sourceAt = ctx.project.source_at ?? null;
    } else if (p.from === 'beneficiary' && ctx.beneficiary) {
      value = ctx.beneficiary[p.path!];
      source = ctx.beneficiary.anaf_fetched_at ? 'anaf' : 'beneficiary';
      sourceAt = ctx.beneficiary.anaf_fetched_at ?? null;
    } else if (p.from === 'previous_instance') {
      value = prevFields[p.path ?? f.key];
      source = 'previous_instance';
    } else if (p.from === 'constant') {
      value = p.value;
      source = 'calculated';
    }
    if (value !== undefined && value !== null) await saveField(db, inst.id, f.key, value, source, user.id, sourceAt);
  }
  for (const [k, v] of Object.entries(input.fields ?? {})) {
    if (def.fields.some((f) => f.key === k && f.type !== 'calculated' && f.type !== 'line_items')) await saveField(db, inst.id, k, v, 'manual', user.id);
  }
  // Pin the checklist templates published now.
  for (const c of def.checklists ?? []) {
    const t = await maybeOne(db, `select id from checklist_template where organization_id = $1 and key = $2 and status = 'published'`, [
      user.organizationId,
      c.template,
    ]);
    if (!t) throw new AppError(500, `Lista de verificare „${c.template}” nu este publicată.`);
    await query(db, `insert into instance_checklist (instance_id, checklist_key, template_id) values ($1, $2, $3)`, [inst.id, c.key, t.id]);
  }
  await refreshCalculated(db, def, inst.id, { project: ctx.project, beneficiary: ctx.beneficiary });
  await audit(db, run.actor, { action: 'instance.create', entityType: 'instance', entityId: inst.id, newValue: { definition: def.key, title } });

  const exec = await one(db, `insert into execution (instance_id, step_key) values ($1, $2) returning id`, [inst.id, def.steps.find((s) => s.type === 'start')!.key]);
  await enter(run, exec.id, def.steps.find((s) => s.type === 'start')!.key);
  return inst.id;
}

export interface TransitionInput {
  instanceId: string;
  taskId: string;
  path: string;
  comment?: string | null;
  assignTo?: string | null;
}

async function checklistErrors(db: Db, instanceId: string, checklistKey: string, verifier: string) {
  const rows = await query(
    db,
    `select ci.code, ci.position, ci.observation_required_on, r.answer, r.observation
       from instance_checklist ic join checklist_item ci on ci.template_id = ic.template_id
       left join checklist_response r on r.instance_id = ic.instance_id and r.item_id = ci.id and r.verifier_role = $3
      where ic.instance_id = $1 and ic.checklist_key = $2 order by ci.position`,
    [instanceId, checklistKey, verifier],
  );
  const errors: Array<{ field: string; message: string }> = [];
  for (const r of rows) {
    if (!r.answer) errors.push({ field: `checklist.${r.code}`, message: `Lista de verificare: punctul ${r.code} nu are răspuns.` });
    else if ((r.observation_required_on as string[]).includes(r.answer) && !r.observation?.trim()) {
      errors.push({ field: `checklist.${r.code}`, message: `Lista de verificare: punctul ${r.code} (${r.answer}) necesită observații.` });
    }
  }
  return errors;
}

/** Paths the user can take on a task now (visibility conditions evaluated). */
export async function visiblePaths(db: Db, ctx: InstanceContext, task: TaskRow, user: CurrentUser): Promise<PathDef[]> {
  const step = findStep(ctx.def, task.step_key);
  const { values } = await loadFields(db, ctx.instance.id);
  const data = { fields: values, project: ctx.project, beneficiary: ctx.beneficiary, instance: ctx.instance, user: { id: user.id } };
  return (step.paths ?? []).filter((p) => truthy(p.visibleWhen, data));
}

/**
 * Completes a task by taking one of its paths. Everything happens in one transaction with the
 * instance row locked: rights, separation of duties, validations, checklist, signatures,
 * actions, deadlines, audit and the move to the next step.
 */
export async function transition(db: Db, user: CurrentUser, input: TransitionInput) {
  const ctx = await loadInstance(db, input.instanceId, true);
  if (ctx.instance.organization_id !== user.organizationId) throw notFound('Dosarul');
  if (ctx.instance.status !== 'active') throw unprocessable('Dosarul este închis; nu mai poate fi modificat.');
  const task = await maybeOne<TaskRow>(db, `select * from task where id = $1 and instance_id = $2 for update`, [input.taskId, input.instanceId]);
  if (!task) throw notFound('Sarcina');
  if (task.status !== 'open') throw unprocessable('Sarcina a fost deja finalizată de altcineva. Reîncărcați dosarul.');
  const acting = actingAs(user, task, ctx.def.key);
  if (!acting.ok) throw forbidden('Această sarcină nu vă este repartizată.');
  const onBehalfOf = acting.onBehalfOf;
  const effective = onBehalfOf ?? user.id;
  const step = findStep(ctx.def, task.step_key);
  await assertCoiDeclared(db, ctx.def, step.key, ctx.instance.id, user.id);
  const path = (await visiblePaths(db, ctx, task, user)).find((p) => p.key === input.path);
  if (!path) throw unprocessable('Acțiunea aleasă nu este disponibilă în acest moment.');
  const comment = input.comment?.trim() || null;
  const kind = path.kind ?? 'forward';
  const errors: Array<{ field?: string; row?: number; message: string }> = [];
  if ((path.requiresComment || kind === 'return' || kind === 'reject') && !comment) {
    errors.push({ field: 'comment', message: 'Completați motivul (comentariul este obligatoriu pentru această acțiune).' });
  }

  for (const rule of ctx.def.separationOfDuties ?? []) {
    if (!rule.steps.includes(step.key)) continue;
    const others = rule.steps.filter((s) => s !== step.key);
    const clash = await maybeOne(
      db,
      `select 1 from task where instance_id = $1 and step_key = any($2::text[]) and status = 'completed' and coalesce(on_behalf_of, completed_by) = $3`,
      [ctx.instance.id, others, effective],
    );
    if (clash) errors.push({ message: rule.message });
  }

  if (kind === 'forward') {
    const { values } = await loadFields(db, ctx.instance.id);
    const data = {
      fields: values,
      project: ctx.project,
      beneficiary: ctx.beneficiary,
      instance: ctx.instance,
      today: today(),
      evidence: step.evidence ? await evidenceCounts(db, ctx.instance.id) : { photos: 0, signature: false },
    };
    if (path.validateFields !== false) errors.push(...validateForStep(ctx.def, step.key, data));
    for (const v of path.validations ?? []) if (!truthy(v.rule, data)) errors.push({ message: v.message });
    if (path.requiresChecklistComplete) {
      errors.push(...(await checklistErrors(db, ctx.instance.id, path.requiresChecklistComplete, step.checklistVerifier ?? 'primary')));
    }
    for (const docKey of path.requiresSignatures ?? []) {
      const signed = await maybeOne(
        db,
        `select 1 from signature s join document d on d.id = s.document_id
          where d.instance_id = $1 and d.doc_key = $2 and s.signer_user_id = $3 and s.status = 'signed'`,
        [ctx.instance.id, docKey, user.id],
      );
      if (!signed) {
        const title = ctx.def.documents?.find((d) => d.key === docKey)?.docType ?? docKey;
        const doc = await maybeOne(db, `select title from document where instance_id = $1 and doc_key = $2`, [ctx.instance.id, docKey]);
        errors.push({ field: `signature.${docKey}`, message: `Semnați documentul „${doc?.title ?? title}” înainte de a continua.` });
      }
    }
  }
  if (errors.length) throw unprocessable('Acțiunea nu poate fi finalizată. Rezolvați problemele de mai jos și încercați din nou.', errors);

  const run: Run = { db, ctx, user, actor: actorOf(user, onBehalfOf) as AuditActor & { userId: string }, assignTo: input.assignTo, hops: 0 };
  await query(
    db,
    `update task set status = 'completed', completed_at = now(), completed_by = $2, on_behalf_of = $3, path_key = $4, comment = $5,
            assignee_user_id = coalesce(assignee_user_id, $2)
      where id = $1`,
    [task.id, user.id, onBehalfOf, path.key, comment],
  );
  await closeHistory(run, step.key, user.id, onBehalfOf, path.key, comment);

  if (kind === 'return') {
    const lastEntry = await maybeOne(db, `select max(entered_at) as at from step_history where instance_id = $1 and step_key = $2`, [
      ctx.instance.id,
      path.to,
    ]);
    if (lastEntry?.at) {
      await invalidateSignaturesSince(db, run.actor, ctx.instance.id, lastEntry.at, `Dosar returnat la pasul „${findStep(ctx.def, path.to).name}”.`);
    }
  }
  await runActions(run, path.actions);
  await runActions(run, step.onExit);
  // Process-level deadlines start once the dossier is registered (start step completed).
  if (step.type === 'start' && kind === 'forward') await startDeadlines(run, (d) => !d.startsAt);
  await audit(db, run.actor, {
    action: kind === 'return' ? 'instance.return' : 'instance.transition',
    entityType: 'instance',
    entityId: ctx.instance.id,
    newValue: { step: step.key, path: path.key, to: path.to, comment, taskId: task.id },
  });
  if (kind === 'reject') await cancelDeadlines(db, ctx.instance.id);
  await enter(run, task.execution_id, path.to);
  await refreshCalculated(db, ctx.def, ctx.instance.id, { project: ctx.project, beneficiary: ctx.beneficiary });
  const status = await one(db, `select status from instance where id = $1`, [ctx.instance.id]);
  return { status: status.status as string };
}

/** Takes a queued task (role/department queue) so colleagues see it is being handled. */
export async function claimTask(db: Db, user: CurrentUser, taskId: string) {
  const task = await maybeOne<TaskRow & { definition: ProcessDefinition }>(
    db,
    `select t.*, d.definition from task t join instance i on i.id = t.instance_id join process_definition d on d.id = i.definition_id
      where t.id = $1 and i.organization_id = $2 for update of t`,
    [taskId, user.organizationId],
  );
  if (!task) throw notFound('Sarcina');
  if (task.assignee_user_id) throw unprocessable('Sarcina este deja preluată.');
  if (!actingAs(user, task, task.definition.key).ok) throw forbidden('Sarcina nu este în coada dumneavoastră.');
  await assertCoiDeclared(db, task.definition, task.step_key, task.instance_id, user.id);
  await query(db, `update task set assignee_user_id = $2 where id = $1`, [taskId, user.id]);
  await grant(db, task.instance_id, 'user', user.id, 'edit', 'assignee', user.id);
  await audit(db, actorOf(user), { action: 'task.claim', entityType: 'task', entityId: taskId });
}

/** Head of unit or functional admin reassigns an open task. */
export async function reassignTask(db: Db, user: CurrentUser, taskId: string, toUserId: string, reason: string) {
  const task = await maybeOne<TaskRow>(
    db,
    `select t.* from task t join instance i on i.id = t.instance_id where t.id = $1 and i.organization_id = $2 for update of t`,
    [taskId, user.organizationId],
  );
  if (!task || task.status !== 'open') throw notFound('Sarcina');
  if (!user.roles.some((r) => ['head_of_unit', 'functional_admin', 'director'].includes(r.key))) throw forbidden('Doar șeful de serviciu poate realoca sarcini.');
  const target = await maybeOne(db, `select id from app_user where id = $1 and organization_id = $2 and active`, [toUserId, user.organizationId]);
  if (!target) throw notFound('Utilizatorul');
  await query(db, `update task set assignee_user_id = $2 where id = $1`, [taskId, toUserId]);
  await grant(db, task.instance_id, 'user', toUserId, 'edit', 'assignee', user.id);
  await notifyUsers(db, [toUserId], { kind: 'task_assigned', instanceId: task.instance_id, title: `Vi s-a realocat sarcina „${task.name}”.` });
  await audit(db, actorOf(user), {
    action: 'task.reassign',
    entityType: 'task',
    entityId: taskId,
    oldValue: { assignee: task.assignee_user_id },
    newValue: { assignee: toUserId, reason },
  });
}

export { systemActor };
