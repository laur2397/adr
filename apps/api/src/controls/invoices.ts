import type { ProcessDefinition } from '@flux/process-schema';
import { normalizeCui, parseAmount } from '@flux/validators';
import { query, type Db } from '../core/db.js';

/** "FCT-0012/2026" -> "FCT122026": upper case, separators removed, leading zeros of number groups removed. */
export function normalizeInvoiceNo(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/\s+/g, '')
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? String(Number(part)) : part.replace(/^0+(?=\d)/, '')))
    .join('');
}

/** Rebuilds the invoice fingerprints of a dossier from its line-items field. */
export async function indexInvoices(db: Db, def: ProcessDefinition, instance: { id: string; organization_id: string; project_id: string | null }, rows: Record<string, unknown>[]) {
  const cfg = def.invoiceCheck;
  if (!cfg) return;
  await query(db, `delete from invoice_fingerprint where instance_id = $1`, [instance.id]);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const supplier = typeof r[cfg.supplier] === 'string' ? normalizeCui(r[cfg.supplier] as string) : '';
    const number = typeof r[cfg.number] === 'string' ? (r[cfg.number] as string) : '';
    if (!supplier || !number.trim()) continue;
    let amount: string | null = null;
    try {
      amount = cfg.amount && r[cfg.amount] ? parseAmount(String(r[cfg.amount])) : null;
    } catch {
      amount = null;
    }
    await query(
      db,
      `insert into invoice_fingerprint (organization_id, instance_id, project_id, supplier_cui, invoice_no, invoice_no_raw, invoice_date, amount, row_position)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [instance.organization_id, instance.id, instance.project_id, supplier, normalizeInvoiceNo(number), number.trim(),
       cfg.date && typeof r[cfg.date] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r[cfg.date] as string) ? r[cfg.date] : null, amount, i],
    );
  }
}

export interface DoubleFundingAlert {
  row: number;
  supplierCui: string;
  invoiceNo: string;
  amount: string | null;
  otherInstanceId: string;
  otherTitle: string;
  otherReference: string | null;
  otherProject: string | null;
  otherAmount: string | null;
  otherStatus: string;
  sameProject: boolean;
}

/**
 * Invoices of this dossier claimed in other (not cancelled) dossiers: same supplier and same
 * normalized number. These are alerts for the verifier, not conclusions.
 */
export async function doubleFundingAlerts(db: Db, instanceId: string): Promise<DoubleFundingAlert[]> {
  const rows = await query(
    db,
    `select f.row_position, f.supplier_cui, f.invoice_no_raw, f.amount, o.instance_id as other_instance_id, i.title as other_title,
            i.reference_no as other_reference, p.smis_code as other_project, o.amount as other_amount, i.status as other_status,
            (o.project_id is not distinct from f.project_id) as same_project
       from invoice_fingerprint f
       join invoice_fingerprint o on o.organization_id = f.organization_id and o.supplier_cui = f.supplier_cui
                                 and o.invoice_no = f.invoice_no and o.instance_id <> f.instance_id
       join instance i on i.id = o.instance_id and i.status not in ('cancelled', 'completed_negative')
       left join project p on p.id = o.project_id
      where f.instance_id = $1
      order by f.row_position`,
    [instanceId],
  );
  return rows.map((r) => ({
    row: r.row_position,
    supplierCui: r.supplier_cui,
    invoiceNo: r.invoice_no_raw,
    amount: r.amount,
    otherInstanceId: r.other_instance_id,
    otherTitle: r.other_title,
    otherReference: r.other_reference,
    otherProject: r.other_project,
    otherAmount: r.other_amount,
    otherStatus: r.other_status,
    sameProject: r.same_project,
  }));
}
