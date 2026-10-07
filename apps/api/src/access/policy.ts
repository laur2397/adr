import { maybeOne, query, type Db } from '../core/db.js';
import { notFound } from '../core/errors.js';
import { hasRole, roleIdsFor, type CurrentUser } from '../identity/context.js';

/**
 * SQL condition granting access to instance alias `i` for the user in $1 (user id),
 * $2 (role ids) and $3 (department id). Users acting for an absent colleague also see what that
 * colleague sees ($4: absent user ids).
 */
export const ACL_CONDITION = `exists (
  select 1 from instance_acl a
   where a.instance_id = i.id and (
         (a.principal_type = 'user' and (a.principal_id = $1 or a.principal_id = any($4::uuid[])))
      or (a.principal_type = 'role' and a.principal_id = any($2::uuid[]))
      or (a.principal_type = 'department' and a.principal_id = $3)))`;

export function aclParams(user: CurrentUser): unknown[] {
  return [user.id, roleIdsFor(user), user.departmentId, user.substitutes.map((s) => s.absentUserId)];
}

export async function permissionOn(db: Db, user: CurrentUser, instanceId: string): Promise<'edit' | 'view' | null> {
  const rows = await query(
    db,
    `select a.permission from instance_acl a
      where a.instance_id = $5 and (
            (a.principal_type = 'user' and (a.principal_id = $1 or a.principal_id = any($4::uuid[])))
         or (a.principal_type = 'role' and a.principal_id = any($2::uuid[]))
         or (a.principal_type = 'department' and a.principal_id = $3))`,
    [...aclParams(user), instanceId],
  );
  if (rows.some((r) => r.permission === 'edit')) return 'edit';
  if (rows.length) return 'view';
  return null;
}

/** Throws 404 (not 403) without access, so the existence of the dossier is not revealed. */
export async function requireView(db: Db, user: CurrentUser, instanceId: string): Promise<'edit' | 'view'> {
  const exists = await maybeOne(db, `select organization_id from instance where id = $1`, [instanceId]);
  if (!exists || exists.organization_id !== user.organizationId) throw notFound('Dosarul');
  const p = await permissionOn(db, user, instanceId);
  if (!p) throw notFound('Dosarul');
  return p;
}

export async function grant(
  db: Db,
  instanceId: string,
  principalType: 'user' | 'role' | 'department',
  principalId: string,
  permission: 'view' | 'edit',
  reason: string,
  grantedBy: string | null,
): Promise<void> {
  await query(
    db,
    `insert into instance_acl (instance_id, principal_type, principal_id, permission, reason, granted_by)
     values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
    [instanceId, principalType, principalId, permission, reason, grantedBy],
  );
}

/** Roles that see every dossier of their organization (read-only). */
export const SUPERVISOR_ROLES = ['director', 'head_of_unit', 'auditor'];

export function isAdmin(user: CurrentUser): boolean {
  return hasRole(user, 'functional_admin');
}
