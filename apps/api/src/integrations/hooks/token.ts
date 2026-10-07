import { maybeOne, type Db } from '../../core/db.js';
import { sha256 } from '../../auth/crypto.js';

/** User id behind a valid API token; records the last use at most once a minute. */
export async function resolveApiToken(db: Db, token: string): Promise<string | null> {
  const row = await maybeOne(
    db,
    `update api_token set last_used_at = now()
      where token_hash = $1 and revoked_at is null and (expires_at is null or expires_at > now())
        and (last_used_at is null or last_used_at < now() - interval '1 minute')
      returning user_id`,
    [sha256(token)],
  );
  if (row) return row.user_id;
  const r2 = await maybeOne(db, `select user_id from api_token where token_hash = $1 and revoked_at is null and (expires_at is null or expires_at > now())`, [sha256(token)]);
  return r2?.user_id ?? null;
}
