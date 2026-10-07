import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { parseAmount, subtractAmounts, addAmounts, compareAmounts } from '@flux/validators';
import { userOf } from '../app.js';
import { audit } from '../audit/audit.js';
import { today } from '../core/config.js';
import { getPool, maybeOne, query, tx } from '../core/db.js';
import { badRequest, forbidden, notFound } from '../core/errors.js';
import { actorOf, hasRole, type CurrentUser } from '../identity/context.js';

const READERS = ['accountant', 'irregularity_officer', 'head_of_unit', 'director', 'functional_admin', 'auditor'];

function requireReader(user: CurrentUser) {
  if (!hasRole(user, ...READERS)) throw forbidden('Registrul debitorilor este disponibil serviciilor financiar și nereguli, conducerii și auditorilor.');
}

const LIST_SQL = `
  select d.id, d.title_number, d.title_date, d.due_date, d.principal, d.accessories, d.reason, d.status, d.instance_id,
         b.name as beneficiary_name, b.cui, p.smis_code,
         coalesce((select sum(amount) from debt_payment dp where dp.debt_id = d.id), 0)::numeric(18,2) as paid,
         (d.principal + d.accessories - coalesce((select sum(amount) from debt_payment dp where dp.debt_id = d.id), 0))::numeric(18,2) as balance
    from debt d join beneficiary b on b.id = d.beneficiary_id left join project p on p.id = d.project_id
   where d.organization_id = $1`;

export async function debtRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { status?: string; q?: string; format?: string } }>('/debts', async (req, reply) => {
    const user = userOf(req);
    requireReader(user);
    const rows = await query(
      getPool(),
      `${LIST_SQL} and ($2::text is null or d.status = $2) and ($3::text is null or b.name ilike '%' || $3 || '%' or b.cui = $3 or d.title_number ilike $3 || '%')
       order by d.title_date desc`,
      [user.organizationId, req.query.status || null, req.query.q || null],
    );
    const day = today();
    const items: Array<Record<string, any>> = rows.map((r: Record<string, any>) => ({ ...r, overdue: r.status !== 'paid' && r.status !== 'cancelled' && r.due_date < day && Number(r.balance) > 0 }));
    if (req.query.format === 'xlsx') {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Debitori');
      ws.columns = [
        { header: 'Titlu de creanță', key: 'title_number', width: 18 },
        { header: 'Data', key: 'title_date', width: 12 },
        { header: 'Beneficiar', key: 'beneficiary_name', width: 36 },
        { header: 'CUI', key: 'cui', width: 12 },
        { header: 'Cod SMIS', key: 'smis_code', width: 10 },
        { header: 'Debit', key: 'principal', width: 14, style: { numFmt: '#,##0.00' } },
        { header: 'Accesorii', key: 'accessories', width: 12, style: { numFmt: '#,##0.00' } },
        { header: 'Încasat', key: 'paid', width: 14, style: { numFmt: '#,##0.00' } },
        { header: 'Sold', key: 'balance', width: 14, style: { numFmt: '#,##0.00' } },
        { header: 'Scadență', key: 'due_date', width: 12 },
        { header: 'Stare', key: 'status', width: 14 },
      ];
      ws.getRow(1).font = { bold: true };
      for (const r of items) ws.addRow({ ...r, principal: Number(r.principal), accessories: Number(r.accessories), paid: Number(r.paid), balance: Number(r.balance) });
      reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reply.header('content-disposition', 'attachment; filename="registrul-debitorilor.xlsx"');
      return reply.send(Buffer.from(await wb.xlsx.writeBuffer()));
    }
    const totals = items.reduce(
      (t, r) => ({ principal: addAmounts(t.principal, r.principal), paid: addAmounts(t.paid, r.paid), balance: addAmounts(t.balance, r.balance) }),
      { principal: '0.00', paid: '0.00', balance: '0.00' },
    );
    return { items, totals };
  });

  app.get<{ Params: { id: string } }>('/debts/:id', async (req) => {
    const user = userOf(req);
    requireReader(user);
    const debt = await maybeOne(getPool(), `${LIST_SQL} and d.id = $2`, [user.organizationId, req.params.id]);
    if (!debt) throw notFound('Creanța');
    const payments = await query(
      getPool(),
      `select dp.id, dp.amount, dp.paid_on, dp.reference, dp.kind, u.full_name as created_by_name, dp.created_at
         from debt_payment dp join app_user u on u.id = dp.created_by where dp.debt_id = $1 order by dp.paid_on, dp.created_at`,
      [req.params.id],
    );
    return { ...debt, payments };
  });

  /** Records a payment or an offset (compensare); the status follows the balance. */
  app.post<{ Params: { id: string }; Body: { amount: string; paidOn: string; reference: string; kind?: 'payment' | 'offset' } }>(
    '/debts/:id/payments',
    async (req, reply) => {
      const user = userOf(req);
      if (!hasRole(user, 'accountant', 'functional_admin')) throw forbidden('Încasările se înregistrează de serviciul financiar-contabil.');
      let amount: string;
      try {
        amount = parseAmount(String(req.body?.amount ?? ''));
      } catch (e) {
        throw badRequest((e as Error).message, [{ field: 'amount', message: (e as Error).message }]);
      }
      if (compareAmounts(amount, '0.00') <= 0) throw badRequest('Suma trebuie să fie pozitivă.', [{ field: 'amount', message: 'Suma trebuie să fie pozitivă.' }]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body?.paidOn ?? '')) throw badRequest('Completați data plății.', [{ field: 'paidOn', message: 'Obligatoriu' }]);
      if (!req.body?.reference?.trim()) throw badRequest('Completați documentul de plată (ex. OP nr./data).', [{ field: 'reference', message: 'Obligatoriu' }]);
      const result = await tx(async (db) => {
        const debt = await maybeOne(db, `${LIST_SQL} and d.id = $2`, [user.organizationId, req.params.id]);
        if (!debt) throw notFound('Creanța');
        if (debt.status === 'cancelled' || debt.status === 'paid') throw badRequest('Creanța este închisă.');
        if (compareAmounts(amount, debt.balance) > 0) throw badRequest(`Suma depășește soldul de ${debt.balance} lei.`, [{ field: 'amount', message: 'Depășește soldul' }]);
        await query(db, `insert into debt_payment (debt_id, amount, paid_on, reference, kind, created_by) values ($1, $2, $3, $4, $5, $6)`, [
          req.params.id,
          amount,
          req.body.paidOn,
          req.body.reference.trim(),
          req.body.kind === 'offset' ? 'offset' : 'payment',
          user.id,
        ]);
        const balance = subtractAmounts(debt.balance, amount);
        const status = compareAmounts(balance, '0.00') === 0 ? 'paid' : 'partially_paid';
        await query(db, `update debt set status = $2 where id = $1`, [req.params.id, status]);
        await audit(db, actorOf(user), { action: 'debt.payment', entityType: 'debt', entityId: req.params.id, newValue: { amount, paidOn: req.body.paidOn, reference: req.body.reference, balance } });
        return { balance, status };
      });
      reply.status(201);
      return result;
    },
  );

  app.patch<{ Params: { id: string }; Body: { status: 'contested' | 'open' | 'cancelled'; reason: string } }>('/debts/:id', async (req) => {
    const user = userOf(req);
    if (!hasRole(user, 'director', 'head_of_unit', 'functional_admin')) throw forbidden();
    if (!['contested', 'open', 'cancelled'].includes(req.body?.status)) throw badRequest('Stare invalidă.');
    if (!req.body?.reason?.trim()) throw badRequest('Completați motivul (ex. hotărârea instanței, decizia de soluționare a contestației).');
    await tx(async (db) => {
      const r = await query(db, `update debt set status = $3 where id = $1 and organization_id = $2 returning id`, [req.params.id, user.organizationId, req.body.status]);
      if (!r.length) throw notFound('Creanța');
      await audit(db, actorOf(user), { action: 'debt.status', entityType: 'debt', entityId: req.params.id, newValue: req.body });
    });
    return { ok: true };
  });
}
