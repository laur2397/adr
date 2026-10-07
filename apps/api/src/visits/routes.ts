import type { FastifyInstance } from 'fastify';
import { ACL_CONDITION, aclParams, requireView } from '../access/policy.js';
import { userOf } from '../app.js';
import { audit } from '../audit/audit.js';
import { getPool, maybeOne, one, query, tx } from '../core/db.js';
import { badRequest, forbidden, notFound, unprocessable } from '../core/errors.js';
import { getFile, putFile } from '../documents/storage.js';
import { actorOf, hasRole, type CurrentUser } from '../identity/context.js';
import { startInstance } from '../workflow/engine.js';
import { loadInstance } from '../workflow/load.js';
import { actingAs, openTasks } from '../workflow/tasks.js';
import { imageInfo, listEvidence } from './evidence.js';

export const VISIT_PROCESS = 'p8_onsite_verification';
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/** The open task at an evidence step that this user may act on (directly or for an absent colleague). */
async function evidenceTask(user: CurrentUser, instanceId: string) {
  const pool = getPool();
  if ((await requireView(pool, user, instanceId)) !== 'edit') throw forbidden();
  const ctx = await loadInstance(pool, instanceId);
  if (ctx.instance.status !== 'active') throw unprocessable('Dosarul este închis.');
  const tasks = await openTasks(pool, instanceId);
  const task = tasks.find((t) => ctx.def.steps.find((s) => s.key === t.step_key)?.evidence && actingAs(user, t, ctx.def.key).ok);
  if (!task) throw forbidden('Fotografiile și semnătura se adaugă de cel care are sarcina de vizită la fața locului.');
  return { ctx, task };
}

const num = (v: string | undefined) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

export async function visitRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/instances/:id/evidence', async (req) => {
    const user = userOf(req);
    await requireView(getPool(), user, req.params.id);
    const items = await listEvidence(getPool(), req.params.id);
    return { items: items.map(({ storage_key: _k, ...e }) => ({ ...e, url: `/api/v1/instances/${req.params.id}/evidence/${e.id}/content` })) };
  });

  app.get<{ Params: { id: string; eid: string } }>('/instances/:id/evidence/:eid/content', async (req, reply) => {
    const user = userOf(req);
    await requireView(getPool(), user, req.params.id);
    const row = await maybeOne(getPool(), `select storage_key, mime_type from visit_evidence where id = $1 and instance_id = $2`, [req.params.eid, req.params.id]);
    if (!row) throw notFound('Fotografia');
    // Content-addressed: the bytes behind an id never change.
    return reply.type(row.mime_type).header('cache-control', 'private, max-age=31536000, immutable').send(await getFile(row.storage_key));
  });

  /**
   * Adds a photo or the representative's signature (multipart: file + kind, caption, takenAt,
   * latitude, longitude, accuracy, clientId, signerName). The device generates clientId, so a
   * re-send after a lost connection returns the stored item instead of a duplicate.
   */
  app.post<{ Params: { id: string } }>('/instances/:id/evidence', async (req, reply) => {
    const user = userOf(req);
    const file = await req.file();
    if (!file) throw badRequest('Alegeți o fotografie.');
    const field = (name: string) => {
      const f = file.fields[name] as { value?: unknown } | undefined;
      return typeof f?.value === 'string' ? f.value : undefined;
    };
    const kind = field('kind') === 'signature' ? 'signature' : 'photo';
    const clientId = field('clientId')?.trim();
    if (!clientId || clientId.length > 100) throw badRequest('Lipsește identificatorul generat de dispozitiv (clientId).');
    const { ctx, task } = await evidenceTask(user, req.params.id);
    const existing = await maybeOne(getPool(), `select id from visit_evidence where instance_id = $1 and client_id = $2`, [req.params.id, clientId]);
    if (existing) return { id: existing.id, duplicate: true };

    const content = await file.toBuffer();
    if (content.length > MAX_IMAGE_BYTES) throw badRequest('Fotografia depășește 15 MB.');
    const info = imageInfo(content);
    if (!info) throw badRequest('Fișierul nu este o imagine JPEG sau PNG.');
    const lat = num(field('latitude'));
    const lon = num(field('longitude'));
    if ((lat === null) !== (lon === null) || (lat !== null && (Math.abs(lat) > 90 || Math.abs(lon!) > 180))) throw badRequest('Poziția GPS nu este validă.');
    const takenAtRaw = field('takenAt');
    const takenAt = takenAtRaw && !Number.isNaN(Date.parse(takenAtRaw)) ? new Date(takenAtRaw).toISOString() : null;
    const stored = await putFile(content);

    const row = await tx(async (db) => {
      if (kind === 'signature') {
        // One signature per visit: a new one replaces the previous.
        await query(db, `update visit_evidence set deleted_at = now(), deleted_by = $2 where instance_id = $1 and kind = 'signature' and deleted_at is null`, [req.params.id, user.id]);
      }
      const r = await one(
        db,
        `insert into visit_evidence (organization_id, instance_id, kind, storage_key, sha256, mime_type, size_bytes, width, height, caption, signer_name,
                                     taken_at, latitude, longitude, accuracy_m, client_id, captured_by, step_key)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) returning id`,
        [
          user.organizationId, req.params.id, kind, stored.storageKey, stored.sha256, info.mime, stored.size, info.width, info.height,
          field('caption')?.trim().slice(0, 300) || null, field('signerName')?.trim().slice(0, 200) || null,
          takenAt, lat, lon, num(field('accuracy')), clientId, user.id, task.step_key,
        ],
      );
      await audit(db, actorOf(user), {
        action: kind === 'signature' ? 'visit.signature.add' : 'visit.photo.add',
        entityType: 'instance',
        entityId: ctx.instance.id,
        newValue: { evidenceId: r.id, sha256: stored.sha256.toString('hex'), takenAt, latitude: lat, longitude: lon, step: task.step_key },
      });
      return r;
    });
    reply.status(201);
    return { id: row.id, duplicate: false };
  });

  app.delete<{ Params: { id: string; eid: string } }>('/instances/:id/evidence/:eid', async (req) => {
    const user = userOf(req);
    const { ctx } = await evidenceTask(user, req.params.id);
    return tx(async (db) => {
      const row = await maybeOne(db, `update visit_evidence set deleted_at = now(), deleted_by = $3 where id = $1 and instance_id = $2 and deleted_at is null returning kind, encode(sha256, 'hex') as sha256`, [
        req.params.eid,
        req.params.id,
        user.id,
      ]);
      if (!row) throw notFound('Fotografia');
      await audit(db, actorOf(user), { action: 'visit.evidence.delete', entityType: 'instance', entityId: ctx.instance.id, oldValue: { evidenceId: req.params.eid, ...row } });
      return { ok: true };
    });
  });

  /** Visits visible to the user: planned, in progress and done, with the main facts of each. */
  app.get<{ Querystring: { status?: string } }>('/visits', async (req) => {
    const user = userOf(req);
    const params: unknown[] = [...aclParams(user), user.organizationId, VISIT_PROCESS];
    const rows = await query(
      getPool(),
      `select i.id, i.title, i.reference_no, i.status, i.started_at, i.finished_at, p.smis_code, p.title as project_title, b.name as beneficiary_name, b.county,
              max(case when f.field_key = 'planned_date' then f.value #>> '{}' end) as planned_date,
              max(case when f.field_key = 'visit_date' then f.value #>> '{}' end) as visit_date,
              max(case when f.field_key = 'location' then f.value #>> '{}' end) as location,
              max(case when f.field_key = 'visit_reason' then f.value #>> '{}' end) as visit_reason,
              max(case when f.field_key = 'result' then f.value #>> '{}' end) as result,
              (select string_agg(t.name, ', ') from task t where t.instance_id = i.id and t.status = 'open') as current_step,
              (select string_agg(coalesce(u.full_name, 'coadă'), ', ') from task t left join app_user u on u.id = t.assignee_user_id where t.instance_id = i.id and t.status = 'open') as current_assignee,
              (select u.full_name from task t join app_user u on u.id = coalesce(t.on_behalf_of, t.completed_by, t.assignee_user_id)
                where t.instance_id = i.id and t.step_key = 'visit' order by t.created_at desc limit 1) as inspector,
              (select count(*) from visit_evidence e where e.instance_id = i.id and e.kind = 'photo' and e.deleted_at is null)::int as photos,
              (select bool_or(e.kind = 'signature') from visit_evidence e where e.instance_id = i.id and e.deleted_at is null) as signed,
              (select exists (select 1 from task t where t.instance_id = i.id and t.status = 'open' and t.step_key = 'visit'
                 and (t.assignee_user_id = $1 or t.assignee_user_id = any($4::uuid[])))) as mine
         from instance i join process_definition d on d.id = i.definition_id
         left join project p on p.id = i.project_id left join beneficiary b on b.id = i.beneficiary_id
         left join instance_field f on f.instance_id = i.id
        where ${ACL_CONDITION} and i.organization_id = $5 and d.key = $6
        group by i.id, p.smis_code, p.title, b.name, b.county
        order by coalesce(max(case when f.field_key = 'visit_date' then f.value #>> '{}' end), max(case when f.field_key = 'planned_date' then f.value #>> '{}' end)) desc nulls first, i.started_at desc`,
      params,
    );
    const labels = await query(
      getPool(),
      `select n.key, i.code, i.label from nomenclature n join nomenclature_item i on i.nomenclature_id = n.id where n.organization_id = $1 and n.key in ('visit_reason', 'visit_result')`,
      [user.organizationId],
    );
    const label = (key: string, code: string | null) => (code ? (labels.find((l) => l.key === key && l.code === code)?.label ?? code) : null);
    return { items: rows.map((r) => ({ ...r, visit_reason_label: label('visit_reason', r.visit_reason), result_label: label('visit_result', r.result) })) };
  });

  /** Opens a P8 dossier for every selected item of a sampling plan that has none yet. */
  app.post<{ Params: { id: string } }>('/sampling/:id/visits', async (req, reply) => {
    const user = userOf(req);
    if (!hasRole(user, 'head_of_unit', 'director', 'functional_admin')) throw forbidden('Vizitele din eșantion se programează de conducere.');
    const plan = await maybeOne(getPool(), `select id, name, items from sampling_plan where id = $1 and organization_id = $2`, [req.params.id, user.organizationId]);
    if (!plan) throw notFound('Planul de eșantionare');
    const selected = (plan.items as Array<{ instanceId: string; selected: boolean; reason?: string }>).filter((i) => i.selected);
    const created = await tx(async (db) => {
      const out: Array<{ sampledId: string; visitId: string }> = [];
      for (const item of selected) {
        const done = await maybeOne(db, `select 1 from sampling_visit where sampling_plan_id = $1 and sampled_instance_id = $2`, [plan.id, item.instanceId]);
        if (done) continue;
        const sampled = await maybeOne(db, `select id, title, reference_no, project_id, beneficiary_id from instance where id = $1 and organization_id = $2`, [
          item.instanceId,
          user.organizationId,
        ]);
        if (!sampled?.project_id) continue;
        const visitId = await startInstance(db, user, {
          definitionKey: VISIT_PROCESS,
          projectId: sampled.project_id,
          beneficiaryId: sampled.beneficiary_id,
          fields: {
            visit_reason: (item.reason ?? '').startsWith('risc') ? 'esantion_risc' : 'esantion_aleator',
            sampled_reference: `${sampled.reference_no ? `Nr. ${sampled.reference_no} – ` : ''}${sampled.title} (plan „${plan.name}”)`,
          },
        });
        await query(db, `insert into sampling_visit (sampling_plan_id, sampled_instance_id, visit_instance_id, created_by) values ($1, $2, $3, $4)`, [
          plan.id,
          item.instanceId,
          visitId,
          user.id,
        ]);
        out.push({ sampledId: item.instanceId, visitId });
      }
      if (out.length) await audit(db, actorOf(user), { action: 'sampling.visits.create', entityType: 'sampling_plan', entityId: plan.id, newValue: { visits: out } });
      return out;
    });
    reply.status(created.length ? 201 : 200);
    return { created, alreadyPlanned: selected.length - created.length };
  });
}
