import type { FastifyInstance } from 'fastify';
import { requireView } from '../access/policy.js';
import { userOf } from '../app.js';
import { audit } from '../audit/audit.js';
import { getPool, maybeOne, one, query, tx } from '../core/db.js';
import { badRequest, forbidden, notFound } from '../core/errors.js';
import { actorOf, hasRole } from '../identity/context.js';
import { notifyUsers } from '../notifications/service.js';
import { signDocument } from '../signing/service.js';
import { loadInstance } from '../workflow/load.js';
import { DEFAULT_COI_STATEMENT } from './coi.js';
import { doubleFundingAlerts } from './invoices.js';
import { FACTOR_LABELS, RISK_WEIGHTS, newSeed, population, select } from './sampling.js';

const EUR_RON = Number(process.env.EUR_RON ?? 4.97);
const IMS_THRESHOLD_EUR = 10_000;

export async function controlRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------- conflict of interest
  app.get<{ Params: { id: string } }>('/instances/:id/coi', async (req) => {
    const user = userOf(req);
    await requireView(getPool(), user, req.params.id);
    const ctx = await loadInstance(getPool(), req.params.id);
    const mine = await maybeOne(getPool(), `select has_conflict, statement, declared_at from coi_declaration where instance_id = $1 and user_id = $2`, [req.params.id, user.id]);
    const all = await query(
      getPool(),
      `select u.full_name, d.has_conflict, d.declared_at from coi_declaration d join app_user u on u.id = d.user_id where d.instance_id = $1 order by d.declared_at`,
      [req.params.id],
    );
    return { required: Boolean(ctx.def.conflictOfInterest), steps: ctx.def.conflictOfInterest?.steps ?? [], statement: ctx.def.conflictOfInterest?.statement ?? DEFAULT_COI_STATEMENT, mine, declarations: all };
  });

  /**
   * Declaration on own responsibility. A declared conflict releases the user's open tasks in the
   * dossier back to the queue and notifies the head of unit.
   */
  app.post<{ Params: { id: string }; Body: { hasConflict: boolean; details?: string } }>('/instances/:id/coi', async (req, reply) => {
    const user = userOf(req);
    await requireView(getPool(), user, req.params.id);
    if (typeof req.body?.hasConflict !== 'boolean') throw badRequest('Precizați dacă vă aflați sau nu în conflict de interese.');
    if (req.body.hasConflict && !req.body.details?.trim()) throw badRequest('Descrieți pe scurt situația de conflict de interese.', [{ field: 'details', message: 'Obligatoriu' }]);
    const ctx = await loadInstance(getPool(), req.params.id);
    const statement = ctx.def.conflictOfInterest?.statement ?? DEFAULT_COI_STATEMENT;
    await tx(async (db) => {
      const exists = await maybeOne(db, `select has_conflict from coi_declaration where instance_id = $1 and user_id = $2`, [req.params.id, user.id]);
      if (exists && !exists.has_conflict && req.body.hasConflict === false) return;
      await query(
        db,
        `insert into coi_declaration (instance_id, user_id, has_conflict, statement) values ($1, $2, $3, $4)
         on conflict (instance_id, user_id) do update set has_conflict = excluded.has_conflict, statement = excluded.statement, declared_at = now()`,
        [req.params.id, user.id, req.body.hasConflict, req.body.hasConflict ? req.body.details!.trim() : statement],
      );
      await audit(db, actorOf(user), { action: 'coi.declare', entityType: 'instance', entityId: req.params.id, newValue: { hasConflict: req.body.hasConflict, details: req.body.details ?? null } });
      if (req.body.hasConflict) {
        // The user's open tasks go back to the queue of the step's role (or to the heads of unit).
        const mineOpen = await query(db, `select id, step_key from task where instance_id = $1 and assignee_user_id = $2 and status = 'open'`, [req.params.id, user.id]);
        for (const t of mineOpen) {
          const roleKey = ctx.def.steps.find((st) => st.key === t.step_key)?.assignment?.role ?? 'head_of_unit';
          await query(
            db,
            `update task set assignee_user_id = null, candidate_role_id = (select id from role where organization_id = $3 and key = $2) where id = $1`,
            [t.id, roleKey, user.organizationId],
          );
        }
        const heads = await query(db, `select d.head_user_id from app_user u join department d on d.id = u.department_id where u.id = $1 and d.head_user_id is not null`, [user.id]);
        await notifyUsers(db, heads.map((h) => h.head_user_id), {
          kind: 'coi_declared',
          instanceId: req.params.id,
          title: `${user.fullName} a declarat conflict de interese: ${ctx.instance.title}. Realocați sarcina.`,
          body: req.body.details,
        });
      }
    });
    reply.status(201);
    return { ok: true };
  });

  // ------------------------------------------------------------- double funding
  app.get<{ Params: { id: string } }>('/instances/:id/double-funding', async (req) => {
    const user = userOf(req);
    await requireView(getPool(), user, req.params.id);
    return { items: await doubleFundingAlerts(getPool(), req.params.id) };
  });

  // ------------------------------------------------------------- batch signing
  /** Signs several documents one after another; each result is reported separately. */
  app.post<{ Body: { items: Array<{ instanceId: string; docKey: string }> } }>('/signatures/batch', async (req) => {
    const user = userOf(req);
    const items = req.body?.items ?? [];
    if (!items.length) throw badRequest('Alegeți documentele de semnat.');
    if (items.length > 50) throw badRequest('Se pot semna cel mult 50 de documente odată.');
    const results = [];
    for (const it of items) {
      try {
        await requireView(getPool(), user, it.instanceId);
        const r = await signDocument(user, it.instanceId, it.docKey);
        results.push({ ...it, ok: true, status: r.status });
      } catch (e) {
        results.push({ ...it, ok: false, error: (e as Error).message });
      }
    }
    return { results, signed: results.filter((r) => r.ok).length };
  });

  // ------------------------------------------------------------- risk-based sampling
  const canSample = (u: ReturnType<typeof userOf>) => hasRole(u, 'head_of_unit', 'director', 'functional_admin', 'auditor');

  app.get('/sampling', async (req) => {
    const user = userOf(req);
    if (!canSample(user)) throw forbidden('Eșantionarea este disponibilă conducerii.');
    return {
      weights: RISK_WEIGHTS,
      factorLabels: FACTOR_LABELS,
      items: await query(
        getPool(),
        `select s.id, s.name, s.definition_key, s.period_from, s.period_to, s.method, s.sample_size, s.population_size, s.seed, s.created_at, u.full_name as created_by_name
           from sampling_plan s join app_user u on u.id = s.created_by where s.organization_id = $1 order by s.created_at desc`,
        [user.organizationId],
      ),
    };
  });

  /** Preview (no seed stored) or create a plan. Creating records the seed and the full selection. */
  app.post<{
    Body: { name: string; definitionKey: string; from?: string; to?: string; method?: 'risk_weighted' | 'simple_random'; sampleSize?: number; percent?: number; threshold?: number; seed?: string; justification?: string; preview?: boolean };
  }>('/sampling', async (req, reply) => {
    const user = userOf(req);
    if (!canSample(user)) throw forbidden('Eșantionarea este disponibilă conducerii.');
    const b = req.body ?? ({} as never);
    if (!b.definitionKey) throw badRequest('Alegeți procesul.');
    const pop = await population(getPool(), user.organizationId, b.definitionKey, b.from || null, b.to || null);
    if (!pop.length) throw badRequest('Nu există dosare în perioada aleasă.');
    const size = b.sampleSize ?? Math.max(1, Math.ceil((pop.length * (b.percent ?? 10)) / 100));
    const method = b.method === 'simple_random' ? 'simple_random' : 'risk_weighted';
    const threshold = b.threshold ?? 70;
    const seed = b.seed?.trim() || newSeed();
    const items = select(pop, size, method, threshold, seed);
    if (b.preview) return { seed, populationSize: pop.length, sampleSize: Math.min(size, pop.length), items };
    if (!b.name?.trim()) throw badRequest('Dați un nume planului de eșantionare.');
    const justification =
      b.justification?.trim() ||
      `Eșantion de ${Math.min(size, pop.length)} din ${pop.length} dosare, metoda ${method === 'risk_weighted' ? 'ponderată cu riscul (toate dosarele cu scor ≥ ' + threshold + ', restul aleator ponderat)' : 'aleatorie simplă'}, sămânța ${seed}.`;
    const plan = await tx(async (db) => {
      const row = await one(
        db,
        `insert into sampling_plan (organization_id, name, definition_key, period_from, period_to, method, sample_size, high_risk_threshold, seed, population_size, items, justification, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
        [user.organizationId, b.name.trim(), b.definitionKey, b.from || null, b.to || null, method, Math.min(size, pop.length), threshold, seed, pop.length, JSON.stringify(items), justification, user.id],
      );
      await audit(db, actorOf(user), {
        action: 'sampling.create',
        entityType: 'sampling_plan',
        entityId: row.id,
        newValue: { seed, method, size, threshold, population: pop.length, selected: items.filter((i) => i.selected).map((i) => i.instanceId) },
      });
      return row;
    });
    reply.status(201);
    return { id: plan.id, seed, items };
  });

  app.get<{ Params: { id: string } }>('/sampling/:id', async (req) => {
    const user = userOf(req);
    if (!canSample(user)) throw forbidden();
    const plan = await maybeOne(getPool(), `select * from sampling_plan where id = $1 and organization_id = $2`, [req.params.id, user.organizationId]);
    if (!plan) throw notFound('Planul de eșantionare');
    const visits = await query(
      getPool(),
      `select v.sampled_instance_id, v.visit_instance_id, i.status, i.reference_no,
              (select string_agg(t.name, ', ') from task t where t.instance_id = i.id and t.status = 'open') as current_step
         from sampling_visit v join instance i on i.id = v.visit_instance_id where v.sampling_plan_id = $1`,
      [plan.id],
    );
    return { ...plan, visits };
  });

  // ------------------------------------------------------------- irregularities for IMS
  /** Confirmed irregularities with the amount converted to EUR and the IMS reporting flag (≥ 10.000 EUR). */
  app.get('/irregularities', async (req) => {
    const user = userOf(req);
    if (!hasRole(user, 'irregularity_officer', 'head_of_unit', 'director', 'functional_admin', 'auditor')) throw forbidden();
    const rows = await query(
      getPool(),
      `select i.id, i.title, i.reference_no, i.status, i.started_at, p.smis_code, b.name as beneficiary_name,
              max(case when f.field_key = 'outcome' then f.value #>> '{}' end) as outcome,
              max(case when f.field_key = 'irregularity_type' then f.value #>> '{}' end) as irregularity_type,
              max(case when f.field_key = 'irregularity_type' then (select ni.label from nomenclature n join nomenclature_item ni on ni.nomenclature_id = n.id
                                                                    where n.organization_id = i.organization_id and n.key = 'irregularity_type' and ni.code = f.value #>> '{}') end) as irregularity_type_label,
              max(case when f.field_key = 'debt_principal' then f.value #>> '{}' end) as debt_principal,
              max(case when f.field_key = 'affected_amount' then f.value #>> '{}' end) as affected_amount,
              max(case when f.field_key = 'ims_report' then f.value #>> '{}' end) as ims_report,
              max(case when f.field_key = 'debt_title_number' then f.value #>> '{}' end) as debt_title_number
         from instance i join process_definition d on d.id = i.definition_id
         left join instance_field f on f.instance_id = i.id
         left join project p on p.id = i.project_id left join beneficiary b on b.id = i.beneficiary_id
        where i.organization_id = $1 and d.key = 'p4_irregularities'
        group by i.id, i.organization_id, p.smis_code, b.name order by i.started_at desc`,
      [user.organizationId],
    );
    return {
      eurRon: EUR_RON,
      thresholdEur: IMS_THRESHOLD_EUR,
      items: rows.map((r) => {
        const ron = Number(r.debt_principal ?? r.affected_amount ?? 0);
        const eur = Math.round((ron / EUR_RON) * 100) / 100;
        return { ...r, amount_eur: eur, ims_reportable: r.outcome === 'confirmata' && (eur >= IMS_THRESHOLD_EUR || r.ims_report === 'true') };
      }),
    };
  });
}
