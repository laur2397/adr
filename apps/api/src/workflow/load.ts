import type { ProcessDefinition } from '@flux/process-schema';
import { maybeOne, type Db } from '../core/db.js';
import { notFound } from '../core/errors.js';

export interface InstanceRow {
  id: string;
  organization_id: string;
  definition_id: string;
  reference_no: string | null;
  title: string;
  status: string;
  project_id: string | null;
  beneficiary_id: string | null;
  program_id: string | null;
  responsible_user_id: string | null;
  parent_instance_id: string | null;
  started_by: string;
  started_at: string;
  finished_at: string | null;
}

export interface InstanceContext {
  instance: InstanceRow;
  def: ProcessDefinition;
  definitionVersion: number;
  project: Record<string, any> | null;
  beneficiary: Record<string, any> | null;
}

export async function loadProject(db: Db, id: string | null) {
  if (!id) return null;
  return maybeOne(
    db,
    `select p.*, pr.code as program_code, pr.name as program_name, u.full_name as responsible_expert_name
       from project p join program pr on pr.id = p.program_id left join app_user u on u.id = p.responsible_expert_id
      where p.id = $1`,
    [id],
  );
}

export async function loadBeneficiary(db: Db, id: string | null) {
  if (!id) return null;
  return maybeOne(db, `select * from beneficiary where id = $1`, [id]);
}

/** Loads an instance with its pinned definition. Use forUpdate inside transitions to serialize them. */
export async function loadInstance(db: Db, instanceId: string, forUpdate = false): Promise<InstanceContext> {
  const instance = await maybeOne<InstanceRow & { definition: ProcessDefinition; version: number }>(
    db,
    `select i.*, d.definition, d.version from instance i join process_definition d on d.id = i.definition_id
      where i.id = $1 ${forUpdate ? 'for update of i' : ''}`,
    [instanceId],
  );
  if (!instance) throw notFound('Dosarul');
  const { definition, version, ...row } = instance;
  return {
    instance: row,
    def: definition,
    definitionVersion: version,
    project: await loadProject(db, row.project_id),
    beneficiary: await loadBeneficiary(db, row.beneficiary_id),
  };
}
