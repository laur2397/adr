import { query, type Db } from '../core/db.js';
import { enqueue } from '../core/outbox.js';

export interface NotificationInput {
  kind: string;
  instanceId?: string | null;
  title: string;
  body?: string;
}

/** In-app notification for each user, plus an e-mail job (sent only when SMTP is configured). */
export async function notifyUsers(db: Db, userIds: string[], n: NotificationInput): Promise<void> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return;
  await query(
    db,
    `insert into notification (user_id, kind, instance_id, payload)
     select u, $2, $3, $4 from unnest($1::uuid[]) u`,
    [ids, n.kind, n.instanceId ?? null, JSON.stringify({ title: n.title, body: n.body ?? null })],
  );
  await enqueue(db, 'email_users', { userIds: ids, subject: n.title, body: n.body ?? n.title, instanceId: n.instanceId ?? null });
}

export async function usersWithRole(db: Db, organizationId: string, roleKey: string): Promise<string[]> {
  const rows = await query(
    db,
    `select distinct ra.user_id from role_assignment ra
       join role r on r.id = ra.role_id
       join app_user u on u.id = ra.user_id and u.active
      where r.organization_id = $1 and r.key = $2
        and ra.valid_from <= current_date and (ra.valid_to is null or ra.valid_to >= current_date)`,
    [organizationId, roleKey],
  );
  return rows.map((r) => r.user_id);
}
