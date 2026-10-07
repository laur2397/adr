import { createHash, randomBytes } from 'node:crypto';
import { query, type Db } from '../core/db.js';

/**
 * Risk-based sampling of dossiers for on-the-spot checks (Reg. 2021/1060 art. 74(2)).
 * The score and the selection are deterministic for a given population and seed, so an auditor
 * can reproduce the sample from the stored plan.
 */

export interface RiskFactors {
  amount: number;
  reduction: number;
  irregularities: number;
  doubleFunding: number;
  newBeneficiary: number;
}

export const RISK_WEIGHTS: RiskFactors = { amount: 30, reduction: 20, irregularities: 25, doubleFunding: 15, newBeneficiary: 10 };

export const FACTOR_LABELS: Record<keyof RiskFactors, string> = {
  amount: 'valoarea solicitată (raportat la populație)',
  reduction: 'ponderea sumelor neeligibile',
  irregularities: 'nereguli confirmate anterior la proiect',
  doubleFunding: 'alerte de dublă finanțare',
  newBeneficiary: 'primul dosar al proiectului',
};

export interface PopulationItem {
  instanceId: string;
  title: string;
  referenceNo: string | null;
  projectId: string | null;
  smisCode: string | null;
  factors: RiskFactors;
  score: number;
}

/** Small, well-known PRNG (sfc32) seeded from SHA-256 of the seed text. */
export function prng(seed: string): () => number {
  const h = createHash('sha256').update(seed).digest();
  let a = h.readUInt32LE(0), b = h.readUInt32LE(4), c = h.readUInt32LE(8), d = h.readUInt32LE(12);
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function newSeed(): string {
  return randomBytes(12).toString('hex');
}

export function riskScore(f: RiskFactors): number {
  const total = Object.values(RISK_WEIGHTS).reduce((s, w) => s + w, 0);
  const score = (Object.keys(RISK_WEIGHTS) as Array<keyof RiskFactors>).reduce((s, k) => s + f[k] * RISK_WEIGHTS[k], 0) / total;
  return Math.round(score * 100) / 100;
}

const num = (v: unknown) => {
  const n = Number(typeof v === 'string' ? v : (v ?? 0));
  return Number.isFinite(n) ? n : 0;
};

export async function population(
  db: Db,
  organizationId: string,
  definitionKey: string,
  from: string | null,
  to: string | null,
): Promise<PopulationItem[]> {
  const rows = await query(
    db,
    `select i.id, i.title, i.reference_no, i.project_id, p.smis_code, i.started_at,
            (select value #>> '{}' from instance_field f where f.instance_id = i.id and f.field_key in ('total_requested', 'total', 'contract_value', 'affected_amount') and f.value is not null and f.value <> 'null'::jsonb limit 1) as amount,
            (select value #>> '{}' from instance_field f where f.instance_id = i.id and f.field_key = 'total_eligible') as eligible,
            (select count(*) from instance x join process_definition xd on xd.id = x.definition_id
               join instance_field xf on xf.instance_id = x.id and xf.field_key = 'outcome' and xf.value = '"confirmata"'
              where xd.key = 'p4_irregularities' and x.project_id = i.project_id and x.project_id is not null)::int as irregularities,
            (select count(*) from invoice_fingerprint f join invoice_fingerprint o on o.organization_id = f.organization_id
               and o.supplier_cui = f.supplier_cui and o.invoice_no = f.invoice_no and o.instance_id <> f.instance_id
              where f.instance_id = i.id)::int as double_funding,
            (select count(*) from instance y where y.definition_id = i.definition_id and y.project_id = i.project_id and y.started_at < i.started_at)::int as previous
       from instance i join process_definition d on d.id = i.definition_id left join project p on p.id = i.project_id
      where i.organization_id = $1 and d.key = $2 and i.status not in ('cancelled', 'completed_negative')
        and ($3::date is null or i.started_at >= $3) and ($4::date is null or i.started_at < $4::date + 1)
      order by i.started_at, i.id`,
    [organizationId, definitionKey, from, to],
  );
  const maxAmount = Math.max(1, ...rows.map((r) => num(r.amount)));
  return rows.map((r) => {
    const amount = num(r.amount);
    const eligible = r.eligible === null ? amount : num(r.eligible);
    const factors: RiskFactors = {
      amount: amount > 0 ? Math.round((Math.log10(1 + amount) / Math.log10(1 + maxAmount)) * 100) : 0,
      reduction: amount > 0 ? Math.min(100, Math.round(((amount - eligible) / amount) * 400)) : 0,
      irregularities: Math.min(100, r.irregularities * 50),
      doubleFunding: r.double_funding > 0 ? 100 : 0,
      newBeneficiary: r.project_id && r.previous === 0 ? 100 : 0,
    };
    return {
      instanceId: r.id,
      title: r.title,
      referenceNo: r.reference_no,
      projectId: r.project_id,
      smisCode: r.smis_code,
      factors,
      score: riskScore(factors),
    };
  });
}

export interface SelectionItem extends PopulationItem {
  selected: boolean;
  reason: string | null;
}

/**
 * risk_weighted: every dossier at or above the threshold is selected (highest first, up to the
 * sample size); the rest of the sample is drawn at random with probability proportional to
 * score + 5, so low-risk dossiers keep a chance. simple_random: uniform draw.
 */
export function select(items: PopulationItem[], size: number, method: 'risk_weighted' | 'simple_random', threshold: number, seed: string): SelectionItem[] {
  const rnd = prng(seed);
  const out: SelectionItem[] = items.map((i) => ({ ...i, selected: false, reason: null }));
  let remaining = Math.min(size, out.length);
  if (method === 'risk_weighted') {
    const high = out.filter((i) => i.score >= threshold).sort((a, b) => b.score - a.score || a.instanceId.localeCompare(b.instanceId));
    for (const i of high.slice(0, remaining)) {
      i.selected = true;
      i.reason = `risc ridicat (scor ${i.score} ≥ ${threshold})`;
    }
    remaining -= Math.min(high.length, remaining);
  }
  while (remaining > 0) {
    const pool = out.filter((i) => !i.selected);
    const weights = pool.map((i) => (method === 'risk_weighted' ? i.score + 5 : 1));
    const total = weights.reduce((s, w) => s + w, 0);
    let r = rnd() * total;
    let k = 0;
    while (k < pool.length - 1 && r >= weights[k]!) {
      r -= weights[k]!;
      k++;
    }
    pool[k]!.selected = true;
    pool[k]!.reason = method === 'risk_weighted' ? 'selecție aleatorie ponderată cu riscul' : 'selecție aleatorie simplă';
    remaining--;
  }
  return out;
}
