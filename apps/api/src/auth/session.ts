import { config } from '../core/config.js';
import { maybeOne, query, type Db } from '../core/db.js';
import { newToken, sha256 } from './crypto.js';

export const SESSION_COOKIE = 'flux_session';

export async function createSession(db: Db, userId: string, ip: string | null, userAgent: string | null): Promise<string> {
  const { token, hash } = newToken();
  await query(
    db,
    `insert into user_session (user_id, token_hash, expires_at, ip, user_agent)
     values ($1, $2, now() + make_interval(hours => $3), $4, $5)`,
    [userId, hash, config.sessionHours, ip, userAgent],
  );
  return token;
}

/** Returns the user id for a valid session token and slides the idle window. */
export async function resolveSession(db: Db, token: string): Promise<{ sessionId: string; userId: string } | null> {
  const row = await maybeOne(
    db,
    `update user_session set last_seen_at = now()
      where token_hash = $1 and revoked_at is null and expires_at > now()
      returning id, user_id`,
    [sha256(token)],
  );
  return row ? { sessionId: row.id, userId: row.user_id } : null;
}

export async function revokeSession(db: Db, token: string): Promise<void> {
  await query(db, `update user_session set revoked_at = now() where token_hash = $1`, [sha256(token)]);
}

export async function revokeAllSessions(db: Db, userId: string): Promise<void> {
  await query(db, `update user_session set revoked_at = now() where user_id = $1 and revoked_at is null`, [userId]);
}
