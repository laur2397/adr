import { query, type Db } from '../core/db.js';

/**
 * Rebuilds the text a dossier is found by: title, number, beneficiary, project, text field values,
 * comments and document titles. Called after changes; cheap enough to run inside the transaction.
 */
export async function reindexInstance(db: Db, instanceId: string): Promise<void> {
  await query(
    db,
    `update instance i set search_text = left(concat_ws(' ',
        i.title, i.reference_no,
        (select b.name || ' ' || b.cui from beneficiary b where b.id = i.beneficiary_id),
        (select p.smis_code || ' ' || p.title || ' ' || coalesce(p.contract_number, '') from project p where p.id = i.project_id),
        (select string_agg(f.value #>> '{}', ' ') from instance_field f where f.instance_id = i.id and jsonb_typeof(f.value) = 'string'),
        (select string_agg(v.value, ' ') from instance_list_row r, jsonb_each_text(r.values) v where r.instance_id = i.id and v.value is not null),
        (select string_agg(c.body, ' ') from instance_comment c where c.instance_id = i.id),
        (select string_agg(d.title, ' ') from document d where d.instance_id = i.id),
        (select string_agg(e.number_display, ' ') from register_entry e where e.instance_id = i.id)
      ), 100000)
     where i.id = $1`,
    [instanceId],
  );
}
