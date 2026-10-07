import type { AuditActor } from '../audit/audit.js';
import { query, type Db } from '../core/db.js';

export interface RoleGrant {
  roleId: string;
  key: string;
  departmentId: string | null;
  programId: string | null;
  /** Set when the grant comes from a full substitution: the absent user's id. */
  viaSubstitutionOf: string | null;
  processKey: string | null;
}

export interface Substitution {
  absentUserId: string;
  scope: 'tasks' | 'full';
  processKey: string | null;
}

export interface CurrentUser {
  id: string;
  organizationId: string;
  username: string;
  fullName: string;
  email: string;
  departmentId: string | null;
  roles: RoleGrant[];
  /** Users this user currently replaces. */
  substitutes: Substitution[];
  ip?: string | null;
  userAgent?: string | null;
}

// Short cache: roles, substitutions and deactivation take effect within USER_CACHE_MS.
const USER_CACHE_MS = Number(process.env.USER_CACHE_MS ?? 10_000);
const cache = new Map<string, { at: number; user: CurrentUser | null }>();

export async function loadUserCached(db: Db, userId: string): Promise<CurrentUser | null> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < USER_CACHE_MS) return hit.user ? { ...hit.user } : null;
  const user = await loadUser(db, userId);
  cache.set(userId, { at: Date.now(), user });
  if (cache.size > 5000) cache.clear();
  return user ? { ...user } : null;
}

export function forgetUser(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}

export async function loadUser(db: Db, userId: string): Promise<CurrentUser | null> {
  const [u] = await query(
    db,
    `select id, organization_id, username, full_name, email, department_id from app_user where id = $1 and active`,
    [userId],
  );
  if (!u) return null;
  const subs = await query(
    db,
    `select absent_user_id, scope, process_definition_key from substitution
      where substitute_user_id = $1 and now() >= valid_from and now() < valid_to`,
    [userId],
  );
  const substitutes: Substitution[] = subs.map((s) => ({ absentUserId: s.absent_user_id, scope: s.scope, processKey: s.process_definition_key }));
  const fullFor = substitutes.filter((s) => s.scope === 'full');
  const roleRows = await query(
    db,
    `select ra.user_id, ra.role_id, r.key, ra.department_id, ra.program_id
       from role_assignment ra join role r on r.id = ra.role_id
      where ra.user_id = any($1::uuid[])
        and ra.valid_from <= current_date and (ra.valid_to is null or ra.valid_to >= current_date)`,
    [[userId, ...fullFor.map((s) => s.absentUserId)]],
  );
  const roles: RoleGrant[] = roleRows.map((r) => {
    const via = r.user_id === userId ? null : r.user_id;
    return {
      roleId: r.role_id,
      key: r.key,
      departmentId: r.department_id,
      programId: r.program_id,
      viaSubstitutionOf: via,
      processKey: via ? (fullFor.find((s) => s.absentUserId === via)?.processKey ?? null) : null,
    };
  });
  return {
    id: u.id,
    organizationId: u.organization_id,
    username: u.username,
    fullName: u.full_name,
    email: u.email,
    departmentId: u.department_id,
    roles,
    substitutes,
  };
}

export function hasRole(user: CurrentUser, ...keys: string[]): boolean {
  return user.roles.some((r) => keys.includes(r.key) && r.viaSubstitutionOf === null);
}

/** Role ids usable for a given process (own roles + roles of users fully replaced for that process). */
export function roleIdsFor(user: CurrentUser, processKey?: string): string[] {
  return [...new Set(user.roles.filter((r) => !r.processKey || !processKey || r.processKey === processKey).map((r) => r.roleId))];
}

export function actorOf(user: CurrentUser, onBehalfOf: string | null = null): AuditActor {
  return { organizationId: user.organizationId, userId: user.id, onBehalfOf, ip: user.ip, userAgent: user.userAgent };
}

export const SYSTEM_ACTOR = (organizationId: string): AuditActor => ({ organizationId, userId: null });
