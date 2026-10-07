import type { ProcessDefinition } from '@flux/process-schema';
import { maybeOne, type Db } from '../core/db.js';
import { AppError } from '../core/errors.js';

export const DEFAULT_COI_STATEMENT =
  'Declar pe propria răspundere că nu mă aflu în situație de conflict de interese în legătură cu acest dosar, beneficiarul ' +
  'sau furnizorii acestuia (Legea 184/2016, art. 61 din Regulamentul (UE, Euratom) 2018/1046) și că voi anunța imediat ' +
  'orice situație apărută ulterior.';

export function requiresCoi(def: ProcessDefinition, stepKey: string): boolean {
  return Boolean(def.conflictOfInterest?.steps.includes(stepKey));
}

/** Throws unless the user declared no conflict of interest for this dossier. */
export async function assertCoiDeclared(db: Db, def: ProcessDefinition, stepKey: string, instanceId: string, userId: string): Promise<void> {
  if (!requiresCoi(def, stepKey)) return;
  const d = await maybeOne(db, `select has_conflict from coi_declaration where instance_id = $1 and user_id = $2`, [instanceId, userId]);
  if (!d) {
    throw new AppError(422, 'Înainte de a lucra la acest dosar completați declarația privind conflictul de interese.', [], { code: 'coi_required' });
  }
  if (d.has_conflict) {
    throw new AppError(403, 'Ați declarat un conflict de interese pentru acest dosar; sarcina trebuie realocată de șeful de serviciu.', [], { code: 'coi_conflict' });
  }
}
