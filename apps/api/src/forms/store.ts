import { computeCalculated, type FieldValues, type ProcessDefinition, type RuleContext } from '@flux/process-schema';
import { query, type Db } from '../core/db.js';
import { reindexInstance } from '../search/index.js';

export interface FieldMeta {
  source: string;
  sourceAt: string | null;
  updatedAt: string;
}

/** Field values of an instance; line_items fields are assembled from instance_list_row. */
export async function loadFields(db: Db, instanceId: string): Promise<{ values: FieldValues; meta: Record<string, FieldMeta> }> {
  const values: FieldValues = {};
  const meta: Record<string, FieldMeta> = {};
  const rows = await query(db, `select field_key, value, source, source_at, updated_at from instance_field where instance_id = $1`, [instanceId]);
  for (const r of rows) {
    values[r.field_key] = r.value;
    meta[r.field_key] = { source: r.source, sourceAt: r.source_at, updatedAt: r.updated_at };
  }
  const lists = await query(db, `select list_key, values from instance_list_row where instance_id = $1 order by list_key, position`, [instanceId]);
  for (const l of lists) ((values[l.list_key] ??= []) as unknown[]).push(l.values);
  return { values, meta };
}

export async function saveField(
  db: Db,
  instanceId: string,
  key: string,
  value: unknown,
  source: string,
  userId: string | null,
  sourceAt: string | null = null,
): Promise<void> {
  await query(
    db,
    `insert into instance_field (instance_id, field_key, value, source, source_at, updated_by, updated_at)
     values ($1, $2, $3, $4, $5, $6, now())
     on conflict (instance_id, field_key) do update
       set value = excluded.value, source = excluded.source, source_at = excluded.source_at,
           updated_by = excluded.updated_by, updated_at = now()`,
    [instanceId, key, JSON.stringify(value ?? null), source, sourceAt, userId],
  );
}

export async function saveList(db: Db, instanceId: string, listKey: string, rows: Record<string, unknown>[], userId: string | null): Promise<void> {
  await query(db, `delete from instance_list_row where instance_id = $1 and list_key = $2`, [instanceId, listKey]);
  if (!rows.length) return;
  await query(
    db,
    `insert into instance_list_row (instance_id, list_key, position, values, updated_by)
     select $1, $2, ord - 1, v, $4 from jsonb_array_elements($3::jsonb) with ordinality as t(v, ord)`,
    [instanceId, listKey, JSON.stringify(rows), userId],
  );
}

/**
 * Recomputes calculated fields and calculated columns and stores them, so reports and
 * templates read the same numbers the user saw.
 */
export async function refreshCalculated(db: Db, def: ProcessDefinition, instanceId: string, ctx: Omit<RuleContext, 'fields'>): Promise<FieldValues> {
  const { values } = await loadFields(db, instanceId);
  const computed = computeCalculated(def, { ...ctx, fields: values });
  for (const f of def.fields) {
    if (f.type === 'calculated') await saveField(db, instanceId, f.key, computed[f.key], 'calculated', null);
    if (f.type === 'line_items' && f.columns?.some((c) => c.type === 'calculated')) {
      const rows = (computed[f.key] as Record<string, unknown>[] | undefined) ?? [];
      for (let i = 0; i < rows.length; i++) {
        await query(db, `update instance_list_row set values = $4 where instance_id = $1 and list_key = $2 and position = $3`, [
          instanceId,
          f.key,
          i,
          JSON.stringify(rows[i]),
        ]);
      }
    }
  }
  await reindexInstance(db, instanceId);
  return computed;
}
