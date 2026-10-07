import { fieldAccess, findStep, isEditable, normalizeRow, normalizeValue, type FieldDef } from '@flux/process-schema';
import type { FastifyInstance } from 'fastify';
import { ACL_CONDITION, aclParams, grant, requireView } from '../access/policy.js';
import { userOf } from '../app.js';
import { audit } from '../audit/audit.js';
import { getPool, maybeOne, query, tx } from '../core/db.js';
import { badRequest, forbidden, notFound, unprocessable } from '../core/errors.js';
import { deadlinesForInstance } from '../deadlines/service.js';
import { documentsForInstance } from '../documents/service.js';
import { loadFields, refreshCalculated, saveField, saveList } from '../forms/store.js';
import { actorOf, hasRole, type CurrentUser } from '../identity/context.js';
import { entriesForInstance } from '../registry/service.js';
import { claimTask, reassignTask, startInstance, transition, visiblePaths } from './engine.js';
import { loadInstance, type InstanceContext } from './load.js';
import { actingAs, openTasks, type TaskRow } from './tasks.js';
import { assertCoiDeclared, requiresCoi } from '../controls/coi.js';
import { doubleFundingAlerts, indexInvoices } from '../controls/invoices.js';

const STATUS_LABEL: Record<string, string> = {
  active: 'În lucru',
  suspended: 'Suspendat',
  completed_positive: 'Finalizat',
  completed_negative: 'Închis',
  cancelled: 'Anulat',
};

async function actionableTask(user: CurrentUser, ctx: InstanceContext, taskId?: string): Promise<TaskRow> {
  const tasks = await openTasks(getPool(), ctx.instance.id);
  const task = tasks.find((t) => (!taskId || t.id === taskId) && actingAs(user, t, ctx.def.key).ok);
  if (!task) throw forbidden('Nu aveți o sarcină deschisă în acest dosar care să permită modificarea.');
  await assertCoiDeclared(getPool(), ctx.def, task.step_key, ctx.instance.id, user.id);
  return task;
}

/** Circuit bar: main steps in definition order with their state and last actor. */
async function circuit(ctx: InstanceContext) {
  const hist = await query(
    getPool(),
    `select h.step_key, h.entered_at, h.left_at, h.path_key, h.comment, u.full_name as actor_name, ob.full_name as on_behalf_of_name
       from step_history h left join app_user u on u.id = h.actor_user_id left join app_user ob on ob.id = h.on_behalf_of
      where h.instance_id = $1 order by h.entered_at`,
    [ctx.instance.id],
  );
  const active = await query(getPool(), `select step_key from execution where instance_id = $1 and status = 'active'`, [ctx.instance.id]);
  const activeKeys = new Set(active.map((a) => a.step_key));
  const visibleTypes = new Set(['start', 'human', 'end_positive', 'end_negative']);
  return {
    steps: ctx.def.steps
      .filter((s) => visibleTypes.has(s.type))
      .filter((s) => s.type !== 'end_negative' || hist.some((h) => h.step_key === s.key))
      .map((s) => {
        const visits = hist.filter((h) => h.step_key === s.key);
        const last = visits.at(-1);
        return {
          key: s.key,
          name: s.name,
          type: s.type,
          state: activeKeys.has(s.key) && ctx.instance.status === 'active' ? 'current' : last ? 'done' : ctx.instance.status === 'active' ? 'pending' : 'skipped',
          lastActor: last?.actor_name ?? null,
          onBehalfOf: last?.on_behalf_of_name ?? null,
          lastAt: last?.left_at ?? last?.entered_at ?? null,
          visits: visits.length,
        };
      }),
    history: hist.map((h) => ({
      step: h.step_key,
      stepName: ctx.def.steps.find((s) => s.key === h.step_key)?.name ?? h.step_key,
      enteredAt: h.entered_at,
      leftAt: h.left_at,
      actor: h.actor_name,
      onBehalfOf: h.on_behalf_of_name,
      path: h.path_key,
      pathLabel: ctx.def.steps.find((s) => s.key === h.step_key)?.paths?.find((p) => p.key === h.path_key)?.label ?? null,
      comment: h.comment,
    })),
  };
}

async function checklistView(instanceId: string, checklistKey: string) {
  const pool = getPool();
  const tpl = await maybeOne(
    pool,
    `select t.id, t.name, t.answer_set, t.version from instance_checklist ic join checklist_template t on t.id = ic.template_id
      where ic.instance_id = $1 and ic.checklist_key = $2`,
    [instanceId, checklistKey],
  );
  if (!tpl) throw notFound('Lista de verificare');
  const items = await query(pool, `select id, position, code, question, legal_basis, observation_required_on from checklist_item where template_id = $1 order by position`, [tpl.id]);
  const responses = await query(
    pool,
    `select r.item_id, r.verifier_role, r.answer, r.observation, r.answered_at, u.full_name as answered_by
       from checklist_response r left join app_user u on u.id = r.answered_by where r.instance_id = $1`,
    [instanceId],
  );
  return {
    key: checklistKey,
    name: tpl.name,
    version: tpl.version,
    answerSet: tpl.answer_set,
    items: items.map((i) => ({
      code: i.code,
      question: i.question,
      legalBasis: i.legal_basis,
      observationRequiredOn: i.observation_required_on,
      responses: Object.fromEntries(
        responses.filter((r) => r.item_id === i.id).map((r) => [r.verifier_role, { answer: r.answer, observation: r.observation, answeredBy: r.answered_by, answeredAt: r.answered_at }]),
      ),
    })),
  };
}

export async function workflowRoutes(app: FastifyInstance) {
  app.get('/process-definitions', async (req) => {
    const user = userOf(req);
    const rows = await query(
      getPool(),
      `select key, name, version, definition->'subject' as subject from process_definition where organization_id = $1 and status = 'published' order by name`,
      [user.organizationId],
    );
    return rows;
  });

  app.post<{ Body: { definitionKey: string; projectId?: string; beneficiaryId?: string; title?: string; fields?: Record<string, unknown> } }>(
    '/instances',
    async (req, reply) => {
      const user = userOf(req);
      if (!req.body?.definitionKey) throw badRequest('Alegeți tipul de dosar.');
      const id = await tx((db) => startInstance(db, user, req.body));
      reply.status(201);
      return { id };
    },
  );

  app.get<{ Querystring: { definition?: string; status?: string; program?: string; county?: string; assignee?: string; due?: string; q?: string; limit?: string; offset?: string } }>(
    '/instances',
    async (req) => {
      const user = userOf(req);
      const q = req.query;
      const params: unknown[] = [...aclParams(user), user.organizationId];
      const where = [ACL_CONDITION, `i.organization_id = $5`];
      const add = (sql: string, v: unknown) => {
        params.push(v);
        where.push(sql.replaceAll('?', `$${params.length}`));
      };
      if (q.definition) add(`d.key = ?`, q.definition);
      if (q.status === 'open') where.push(`i.status = 'active'`);
      else if (q.status === 'closed') where.push(`i.status <> 'active'`);
      if (q.program) add(`pr.code = ?`, q.program);
      if (q.county) add(`b.county = ?`, q.county);
      if (q.assignee === 'me') add(`exists (select 1 from task t where t.instance_id = i.id and t.status = 'open' and t.assignee_user_id = ?)`, user.id);
      if (q.due === 'overdue') where.push(`exists (select 1 from deadline dl where dl.instance_id = i.id and dl.status = 'running' and dl.due_on < current_date)`);
      if (q.q) add(`(i.title ilike '%' || ? || '%' or i.reference_no ilike '%' || ? || '%' or b.name ilike '%' || ? || '%' or p.smis_code = ?)`, q.q);
      const limit = Math.min(Number(q.limit ?? 50), 500);
      const offset = Number(q.offset ?? 0);
      const rows = await query(
        getPool(),
        `select i.id, i.title, i.reference_no, i.status, i.started_at, d.key as definition_key, d.name as definition_name,
                p.smis_code, b.name as beneficiary_name, b.county, pr.code as program_code,
                (select string_agg(t.name, ', ') from task t where t.instance_id = i.id and t.status = 'open') as current_steps,
                (select string_agg(coalesce(u.full_name, 'coadă'), ', ') from task t left join app_user u on u.id = t.assignee_user_id
                  where t.instance_id = i.id and t.status = 'open') as current_assignees,
                (select min(dl.due_on) from deadline dl where dl.instance_id = i.id and dl.status = 'running') as next_due
           from instance i join process_definition d on d.id = i.definition_id
           left join project p on p.id = i.project_id left join beneficiary b on b.id = i.beneficiary_id left join program pr on pr.id = i.program_id
          where ${where.join(' and ')}
          order by i.started_at desc limit ${limit} offset ${offset}`,
        params,
      );
      return { items: rows.map((r) => ({ ...r, status_label: STATUS_LABEL[r.status] ?? r.status })) };
    },
  );

  app.get<{ Params: { id: string } }>('/instances/:id', async (req) => {
    const user = userOf(req);
    const pool = getPool();
    const permission = await requireView(pool, user, req.params.id);
    const ctx = await loadInstance(pool, req.params.id);
    const tasks = await query(
      pool,
      `select t.*, u.full_name as assignee_name, r.name as role_name from task t
         left join app_user u on u.id = t.assignee_user_id left join role r on r.id = t.candidate_role_id
        where t.instance_id = $1 and t.status = 'open' order by t.created_at`,
      [ctx.instance.id],
    );
    const myTasks = [];
    for (const t of tasks) {
      const acting = actingAs(user, t as TaskRow, ctx.def.key);
      const step = findStep(ctx.def, t.step_key);
      myTasks.push({
        id: t.id,
        stepKey: t.step_key,
        name: t.name,
        assignee: t.assignee_name,
        queue: t.role_name,
        dueAt: t.due_at,
        canAct: acting.ok && permission === 'edit',
        onBehalfOf: acting.ok ? acting.onBehalfOf : null,
        checklist: step.checklist ?? null,
        checklistVerifier: step.checklistVerifier ?? null,
        evidence: Boolean(step.evidence),
        assignmentNext: null,
        paths: acting.ok
          ? (await visiblePaths(pool, ctx, t as TaskRow, user)).map((p) => ({
              key: p.key,
              label: p.label,
              kind: p.kind ?? 'forward',
              requiresComment: Boolean(p.requiresComment) || p.kind === 'return' || p.kind === 'reject',
              requiresSignatures: p.requiresSignatures ?? [],
              // '' = any user, a role key = users with that role, null = no choice needed
              chooseAssignee: findStep(ctx.def, p.to).assignment?.rule === 'chosen_by_previous' ? (findStep(ctx.def, p.to).assignment?.role ?? '') : null,
            }))
          : [],
      });
    }
    const actionable = myTasks.find((t) => t.canAct);
    // Independent reads run in parallel on the pool.
    const [{ values, meta }, circuitView, checklists, deadlines, documents, documentTitles, registrations] = await Promise.all([
      loadFields(pool, ctx.instance.id),
      circuit(ctx),
      Promise.all((ctx.def.checklists ?? []).map((c) => checklistView(ctx.instance.id, c.key))),
      deadlinesForInstance(pool, ctx.instance.organization_id, ctx.instance.id),
      documentsForInstance(pool, ctx.instance.id, ctx.def),
      query(pool, `select key, name from document_template where organization_id = $1 and key = any($2::text[]) and status = 'published'`, [
        ctx.instance.organization_id,
        (ctx.def.documents ?? []).map((d) => d.template),
      ]),
      entriesForInstance(pool, ctx.instance.id),
    ]);
    const [doubleFunding, coi] = await Promise.all([
      ctx.def.invoiceCheck ? doubleFundingAlerts(pool, ctx.instance.id) : Promise.resolve([]),
      query(pool, `select has_conflict from coi_declaration where instance_id = $1 and user_id = $2`, [ctx.instance.id, user.id]),
    ]);
    const fields = (ctx.def.fields as FieldDef[])
      .map((f) => {
        const access = actionable ? fieldAccess(ctx.def, actionable.stepKey, f) : 'visible';
        return {
          key: f.key,
          label: f.label,
          type: f.type,
          resultType: f.resultType ?? null,
          format: f.format ?? null,
          nomenclature: f.nomenclature ?? null,
          columns: f.columns ?? null,
          access,
          value: values[f.key] ?? null,
          source: meta[f.key]?.source ?? null,
          sourceAt: meta[f.key]?.sourceAt ?? null,
        };
      })
      .filter((f) => f.access !== 'hidden');
    // Reads are audited too; the event is written without making the user wait for the audit lock.
    void audit(pool, actorOf(user), { action: 'instance.view', entityType: 'instance', entityId: ctx.instance.id }).catch((err) => req.log.error(err));
    return {
      id: ctx.instance.id,
      title: ctx.instance.title,
      referenceNo: ctx.instance.reference_no,
      status: ctx.instance.status,
      statusLabel: STATUS_LABEL[ctx.instance.status],
      startedAt: ctx.instance.started_at,
      finishedAt: ctx.instance.finished_at,
      permission,
      definition: { key: ctx.def.key, name: ctx.def.name, version: ctx.definitionVersion },
      project: ctx.project,
      beneficiary: ctx.beneficiary,
      ...circuitView,
      tasks: myTasks,
      fields,
      checklists,
      deadlines,
      documents,
      documentTitles: Object.fromEntries(documentTitles.map((r) => [(ctx.def.documents ?? []).find((d) => d.template === r.key)?.key, r.name])),
      registrations,
      doubleFunding,
      parentInstanceId: ctx.instance.parent_instance_id,
      flow: ctx.def.steps.map((st) => ({
        key: st.key,
        name: st.name,
        type: st.type,
        next: st.next,
        branches: st.branches?.map((b) => ({ to: b.to })),
        paths: st.paths?.map((p) => ({ key: p.key, label: p.label, to: p.to, kind: p.kind ?? 'forward' })),
      })),
      children: await query(
        pool,
        `select c.id, c.title, c.status, c.reference_no, d.name as definition_name from instance c join process_definition d on d.id = c.definition_id
          where c.parent_instance_id = $1 order by c.started_at`,
        [ctx.instance.id],
      ),
      coi: {
        // a declaration is needed before acting on the current task (if the step requires one)
        required: Boolean(actionable && requiresCoi(ctx.def, actionable.stepKey)),
        declared: coi.length > 0,
        hasConflict: coi[0]?.has_conflict ?? false,
      },
    };
  });

  app.patch<{ Params: { id: string }; Body: { taskId: string; fields: Record<string, unknown> } }>('/instances/:id/fields', async (req) => {
    const user = userOf(req);
    await requireView(getPool(), user, req.params.id);
    return tx(async (db) => {
      const ctx = await loadInstance(db, req.params.id, true);
      if (ctx.instance.status !== 'active') throw unprocessable('Dosarul este închis.');
      const task = await actionableTask(user, ctx, req.body?.taskId);
      const { values } = await loadFields(db, ctx.instance.id);
      const errors: Array<{ field: string; message: string }> = [];
      const changes: Record<string, { old: unknown; new: unknown }> = {};
      for (const [key, raw] of Object.entries(req.body?.fields ?? {})) {
        const f = ctx.def.fields.find((x) => x.key === key);
        if (!f || f.type === 'line_items') {
          errors.push({ field: key, message: 'Câmp necunoscut.' });
          continue;
        }
        if (!isEditable(fieldAccess(ctx.def, task.step_key, f))) {
          errors.push({ field: key, message: `Câmpul „${f.label}” nu poate fi modificat la acest pas.` });
          continue;
        }
        try {
          const value = normalizeValue(f, raw);
          if (JSON.stringify(value) !== JSON.stringify(values[key] ?? null)) changes[key] = { old: values[key] ?? null, new: value };
        } catch (e) {
          errors.push({ field: key, message: (e as Error).message });
        }
      }
      if (errors.length) throw unprocessable('Unele valori nu au putut fi salvate.', errors);
      const acting = actingAs(user, task, ctx.def.key);
      const actor = actorOf(user, acting.ok ? acting.onBehalfOf : null);
      for (const [key, c] of Object.entries(changes)) await saveField(db, ctx.instance.id, key, c.new, 'manual', user.id);
      if (Object.keys(changes).length) {
        await audit(db, actor, {
          action: 'instance.field.update',
          entityType: 'instance',
          entityId: ctx.instance.id,
          oldValue: Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, c.old])),
          newValue: Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, c.new])),
        });
      }
      const computed = await refreshCalculated(db, ctx.def, ctx.instance.id, { project: ctx.project, beneficiary: ctx.beneficiary });
      return { fields: computed };
    });
  });

  app.put<{ Params: { id: string; key: string }; Body: { taskId: string; rows: Record<string, unknown>[] } }>('/instances/:id/lists/:key', async (req) => {
    const user = userOf(req);
    await requireView(getPool(), user, req.params.id);
    return tx(async (db) => {
      const ctx = await loadInstance(db, req.params.id, true);
      if (ctx.instance.status !== 'active') throw unprocessable('Dosarul este închis.');
      const task = await actionableTask(user, ctx, req.body?.taskId);
      const f = ctx.def.fields.find((x) => x.key === req.params.key && x.type === 'line_items');
      if (!f) throw notFound('Tabelul');
      if (!isEditable(fieldAccess(ctx.def, task.step_key, f))) throw forbidden(`Tabelul „${f.label}” nu poate fi modificat la acest pas.`);
      const errors: Array<{ field: string; row: number; message: string }> = [];
      const rows = (req.body?.rows ?? []).map((r, i) => {
        try {
          return normalizeRow(f.columns ?? [], r);
        } catch (e) {
          errors.push({ field: f.key, row: i, message: `Rândul ${i + 1}: ${(e as Error).message}` });
          return {};
        }
      });
      if (errors.length) throw unprocessable('Unele rânduri nu au putut fi salvate.', errors);
      const { values } = await loadFields(db, ctx.instance.id);
      await saveList(db, ctx.instance.id, f.key, rows, user.id);
      if (ctx.def.invoiceCheck?.list === f.key) await indexInvoices(db, ctx.def, ctx.instance, rows);
      await audit(db, actorOf(user), { action: 'instance.list.update', entityType: 'instance', entityId: ctx.instance.id, oldValue: { [f.key]: values[f.key] ?? [] }, newValue: { [f.key]: rows } });
      const computed = await refreshCalculated(db, ctx.def, ctx.instance.id, { project: ctx.project, beneficiary: ctx.beneficiary });
      return { fields: computed };
    });
  });

  app.put<{ Params: { id: string; key: string }; Body: { taskId: string; responses: Array<{ code: string; answer: string | null; observation?: string | null }> } }>(
    '/instances/:id/checklists/:key/responses',
    async (req) => {
      const user = userOf(req);
      await requireView(getPool(), user, req.params.id);
      await tx(async (db) => {
        const ctx = await loadInstance(db, req.params.id, true);
        const task = await actionableTask(user, ctx, req.body?.taskId);
        const step = findStep(ctx.def, task.step_key);
        if (step.checklist !== req.params.key) throw forbidden('Lista de verificare nu se completează la acest pas.');
        const verifier = step.checklistVerifier ?? 'primary';
        const tpl = await maybeOne(
          db,
          `select t.id, t.answer_set from instance_checklist ic join checklist_template t on t.id = ic.template_id where ic.instance_id = $1 and ic.checklist_key = $2`,
          [ctx.instance.id, req.params.key],
        );
        if (!tpl) throw notFound('Lista de verificare');
        for (const r of req.body?.responses ?? []) {
          const item = await maybeOne(db, `select id from checklist_item where template_id = $1 and code = $2`, [tpl.id, r.code]);
          if (!item) throw badRequest(`Punctul ${r.code} nu există în lista de verificare.`);
          if (r.answer !== null && !tpl.answer_set.includes(r.answer)) throw badRequest(`Răspunsul „${r.answer}” nu este permis.`);
          await query(
            db,
            `insert into checklist_response (instance_id, item_id, verifier_role, answer, observation, answered_by, answered_at)
             values ($1, $2, $3, $4, $5, $6, now())
             on conflict (instance_id, item_id, verifier_role) do update
               set answer = excluded.answer, observation = excluded.observation, answered_by = excluded.answered_by, answered_at = now()`,
            [ctx.instance.id, item.id, verifier, r.answer, r.observation ?? null, user.id],
          );
        }
        await audit(db, actorOf(user), { action: 'instance.checklist.update', entityType: 'instance', entityId: ctx.instance.id, newValue: { checklist: req.params.key, verifier, responses: req.body?.responses } });
      });
      return checklistView(req.params.id, req.params.key);
    },
  );

  app.post<{ Params: { id: string }; Body: { taskId: string; path: string; comment?: string; assignTo?: string } }>('/instances/:id/transitions', async (req) => {
    const user = userOf(req);
    await requireView(getPool(), user, req.params.id);
    if (!req.body?.taskId || !req.body.path) throw badRequest('Lipsesc sarcina sau acțiunea.');
    return tx((db) => transition(db, user, { instanceId: req.params.id, ...req.body }));
  });

  app.get<{ Params: { id: string } }>('/instances/:id/audit', async (req) => {
    const user = userOf(req);
    await requireView(getPool(), user, req.params.id);
    if (!hasRole(user, 'auditor', 'functional_admin', 'director', 'head_of_unit')) throw forbidden('Jurnalul de audit este disponibil auditorilor și conducerii.');
    const rows = await query(
      getPool(),
      `select e.id, e.occurred_at, e.action, e.entity_type, e.entity_id, e.old_value, e.new_value, host(e.ip) as ip,
              u.full_name as actor, ob.full_name as on_behalf_of
         from audit_event e left join app_user u on u.id = e.actor_user_id left join app_user ob on ob.id = e.on_behalf_of_user_id
        where e.entity_id = $1
           or (e.entity_type in ('document', 'signature', 'register_entry', 'deadline', 'task') and e.entity_id in (
                select id::text from document where instance_id = $2
                union all select id::text from signature where instance_id = $2
                union all select id::text from register_entry where instance_id = $2
                union all select id::text from deadline where instance_id = $2
                union all select id::text from task where instance_id = $2))
        order by e.id`,
      [req.params.id, req.params.id],
    );
    return { items: rows };
  });

  app.post<{ Params: { id: string }; Body: { userId: string; permission: 'view' | 'edit' } }>('/instances/:id/access', async (req) => {
    const user = userOf(req);
    await requireView(getPool(), user, req.params.id);
    if (!hasRole(user, 'head_of_unit', 'director', 'functional_admin')) throw forbidden();
    await tx(async (db) => {
      await grant(db, req.params.id, 'user', req.body.userId, req.body.permission === 'edit' ? 'edit' : 'view', 'granted', user.id);
      await audit(db, actorOf(user), { action: 'access.grant', entityType: 'instance', entityId: req.params.id, newValue: req.body });
    });
    return { ok: true };
  });

  app.get<{ Querystring: { scope?: string } }>('/tasks', async (req) => {
    const user = userOf(req);
    const rows = await query(
      getPool(),
      `select t.id, t.name, t.step_key, t.created_at, t.due_at, t.assignee_user_id, t.candidate_role_id, t.candidate_department_id, t.status,
              t.instance_id, i.title as instance_title, i.reference_no, d.definition->>'key' as process_key, d.name as process_name,
              b.name as beneficiary_name, r.name as queue_name,
              (select min(dl.due_on) from deadline dl where dl.instance_id = i.id and dl.status = 'running') as instance_due
         from task t join instance i on i.id = t.instance_id join process_definition d on d.id = i.definition_id
         left join beneficiary b on b.id = i.beneficiary_id left join role r on r.id = t.candidate_role_id
        where t.status = 'open' and i.organization_id = $1
        order by coalesce(t.due_at::date, (select min(dl.due_on) from deadline dl where dl.instance_id = i.id and dl.status = 'running')) nulls last, t.created_at`,
      [user.organizationId],
    );
    const mine = rows.filter((t) => actingAs(user, t as never, t.process_key).ok);
    const scoped = req.query.scope === 'queue' ? mine.filter((t) => !t.assignee_user_id) : req.query.scope === 'mine' ? mine.filter((t) => t.assignee_user_id) : mine;
    return {
      items: scoped.map((t) => ({
        ...t,
        onBehalfOf: t.assignee_user_id && t.assignee_user_id !== user.id ? t.assignee_user_id : null,
        inQueue: !t.assignee_user_id,
      })),
    };
  });

  app.post<{ Params: { id: string } }>('/tasks/:id/claim', async (req) => {
    const user = userOf(req);
    await tx((db) => claimTask(db, user, req.params.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { userId: string; reason?: string } }>('/tasks/:id/reassign', async (req) => {
    const user = userOf(req);
    await tx((db) => reassignTask(db, user, req.params.id, req.body.userId, req.body.reason ?? ''));
    return { ok: true };
  });

  app.get('/notifications', async (req) => {
    const user = userOf(req);
    const rows = await query(
      getPool(),
      `select id, kind, instance_id, payload, created_at, read_at from notification where user_id = $1 order by created_at desc limit 50`,
      [user.id],
    );
    return { items: rows, unread: rows.filter((r) => !r.read_at).length };
  });

  app.post('/notifications/read', async (req) => {
    const user = userOf(req);
    await query(getPool(), `update notification set read_at = now() where user_id = $1 and read_at is null`, [user.id]);
    return { ok: true };
  });
}
