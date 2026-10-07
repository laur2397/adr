import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { userOf } from '../app.js';
import { getPool, query } from '../core/db.js';
import { forbidden } from '../core/errors.js';
import { hasRole } from '../identity/context.js';

export async function reportingRoutes(app: FastifyInstance) {
  /** Management dashboard: workload per expert, deadlines, average time per step, blockages. */
  app.get<{ Querystring: { from?: string; to?: string; definition?: string } }>('/dashboard', async (req) => {
    const user = userOf(req);
    if (!hasRole(user, 'head_of_unit', 'director', 'functional_admin', 'auditor')) throw forbidden('Tabloul de bord este disponibil conducerii.');
    const pool = getPool();
    const org = user.organizationId;
    const from = req.query.from ?? null;
    const to = req.query.to ?? null;
    const def = req.query.definition ?? null;
    const workload = await query(
      pool,
      `select u.id, u.full_name, count(t.id)::int as open_tasks,
              count(t.id) filter (where t.due_at < now())::int as overdue_tasks,
              coalesce(round(avg(extract(epoch from now() - t.created_at) / 86400)::numeric, 1), 0) as avg_age_days
         from task t join app_user u on u.id = t.assignee_user_id join instance i on i.id = t.instance_id join process_definition d on d.id = i.definition_id
        where t.status = 'open' and i.organization_id = $1 and ($2::text is null or d.key = $2)
        group by u.id, u.full_name order by open_tasks desc`,
      [org, def],
    );
    const queues = await query(
      pool,
      `select r.name, count(t.id)::int as open_tasks from task t join role r on r.id = t.candidate_role_id join instance i on i.id = t.instance_id
        where t.status = 'open' and t.assignee_user_id is null and i.organization_id = $1 group by r.name order by open_tasks desc`,
      [org],
    );
    const deadlines = await query(
      pool,
      `select dd.name, count(*) filter (where d.status = 'met')::int as met, count(*) filter (where d.status = 'breached')::int as breached,
              count(*) filter (where d.status = 'running' and d.due_on < current_date)::int as overdue_running,
              count(*) filter (where d.status in ('running', 'paused'))::int as running
         from deadline d join deadline_definition dd on dd.id = d.definition_id join instance i on i.id = d.instance_id
        where i.organization_id = $1 and ($2::date is null or d.started_on >= $2) and ($3::date is null or d.started_on <= $3)
        group by dd.name order by dd.name`,
      [org, from, to],
    );
    const stepTimes = await query(
      pool,
      `select d.name as process, h.step_key, count(*)::int as passes,
              round(avg(extract(epoch from h.left_at - h.entered_at) / 86400)::numeric, 2) as avg_days,
              round(max(extract(epoch from h.left_at - h.entered_at) / 86400)::numeric, 2) as max_days
         from step_history h join instance i on i.id = h.instance_id join process_definition d on d.id = i.definition_id
        where i.organization_id = $1 and h.left_at is not null and h.actor_user_id is not null
          and ($2::date is null or h.entered_at >= $2) and ($3::date is null or h.entered_at < $3::date + 1) and ($4::text is null or d.key = $4)
        group by d.name, h.step_key order by d.name, avg_days desc`,
      [org, from, to, def],
    );
    const blocked = await query(
      pool,
      `select i.id, i.title, i.reference_no, t.name as step, u.full_name as assignee, t.created_at,
              round((extract(epoch from now() - t.created_at) / 86400)::numeric, 1) as days_waiting
         from task t join instance i on i.id = t.instance_id left join app_user u on u.id = t.assignee_user_id
        where t.status = 'open' and i.organization_id = $1 and t.created_at < now() - interval '5 days'
        order by t.created_at limit 20`,
      [org],
    );
    const volume = await query(
      pool,
      `select d.name, count(*)::int as total, count(*) filter (where i.status = 'active')::int as active,
              count(*) filter (where i.status = 'completed_positive')::int as completed
         from instance i join process_definition d on d.id = i.definition_id
        where i.organization_id = $1 and ($2::date is null or i.started_at >= $2) and ($3::date is null or i.started_at < $3::date + 1)
        group by d.name order by d.name`,
      [org, from, to],
    );
    return { workload, queues, deadlines, stepTimes, blocked, volume };
  });

  /** Tabular export of dossiers for Excel / Power BI. */
  app.get<{ Querystring: { definition?: string } }>('/exports/instances.xlsx', async (req, reply) => {
    const user = userOf(req);
    if (!hasRole(user, 'head_of_unit', 'director', 'functional_admin', 'auditor')) throw forbidden();
    const rows = await query(
      getPool(),
      `select i.reference_no, i.title, d.name as process, i.status, i.started_at, i.finished_at, p.smis_code, b.name as beneficiary, b.cui,
              (select value #>> '{}' from instance_field f where f.instance_id = i.id and f.field_key = 'total_requested') as total_requested,
              (select value #>> '{}' from instance_field f where f.instance_id = i.id and f.field_key = 'total_eligible') as total_eligible,
              (select string_agg(t.name, ', ') from task t where t.instance_id = i.id and t.status = 'open') as current_step,
              (select min(dl.due_on) from deadline dl where dl.instance_id = i.id and dl.status = 'running') as next_due
         from instance i join process_definition d on d.id = i.definition_id
         left join project p on p.id = i.project_id left join beneficiary b on b.id = i.beneficiary_id
        where i.organization_id = $1 and ($2::text is null or d.key = $2) order by i.started_at`,
      [user.organizationId, req.query.definition || null],
    );
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Dosare');
    ws.columns = [
      { header: 'Nr. înregistrare', key: 'reference_no', width: 18 },
      { header: 'Titlu', key: 'title', width: 50 },
      { header: 'Proces', key: 'process', width: 40 },
      { header: 'Stare', key: 'status', width: 18 },
      { header: 'Pornit la', key: 'started_at', width: 20 },
      { header: 'Finalizat la', key: 'finished_at', width: 20 },
      { header: 'Cod SMIS', key: 'smis_code', width: 10 },
      { header: 'Beneficiar', key: 'beneficiary', width: 40 },
      { header: 'CUI', key: 'cui', width: 12 },
      { header: 'Total solicitat', key: 'total_requested', width: 16, style: { numFmt: '#,##0.00' } },
      { header: 'Total eligibil', key: 'total_eligible', width: 16, style: { numFmt: '#,##0.00' } },
      { header: 'Pas curent', key: 'current_step', width: 30 },
      { header: 'Termen', key: 'next_due', width: 12 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      ws.addRow({ ...r, total_requested: r.total_requested ? Number(r.total_requested) : null, total_eligible: r.total_eligible ? Number(r.total_eligible) : null });
    }
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('content-disposition', 'attachment; filename="dosare.xlsx"');
    return reply.send(Buffer.from(await wb.xlsx.writeBuffer()));
  });
}
