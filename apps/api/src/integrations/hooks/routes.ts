import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { userOf } from '../../app.js';
import { PUBLIC_EVENTS, audit } from '../../audit/audit.js';
import { encrypt, newToken, sha256 } from '../../auth/crypto.js';
import { getPool, maybeOne, one, query, tx } from '../../core/db.js';
import { badRequest, forbidden, notFound } from '../../core/errors.js';
import { actorOf, hasRole } from '../../identity/context.js';

export async function integrationRoutes(app: FastifyInstance) {
  const admin = (req: Parameters<typeof userOf>[0]) => {
    const user = userOf(req);
    if (!hasRole(user, 'functional_admin', 'it_admin')) throw forbidden('Integrările sunt administrate de IT.');
    return user;
  };

  app.get('/admin/api-tokens', async (req) => {
    const user = admin(req);
    return {
      items: await query(
        getPool(),
        `select t.id, t.name, t.created_at, t.expires_at, t.last_used_at, t.revoked_at, u.full_name as acts_as, c.full_name as created_by_name
           from api_token t join app_user u on u.id = t.user_id join app_user c on c.id = t.created_by where t.organization_id = $1 order by t.created_at desc`,
        [user.organizationId],
      ),
    };
  });

  /** The token is shown once; only its hash is stored. It acts as the chosen (technical) user. */
  app.post<{ Body: { name: string; userId: string; expiresAt?: string } }>('/admin/api-tokens', async (req, reply) => {
    const user = admin(req);
    if (!req.body?.name?.trim()) throw badRequest('Dați un nume tokenului (ex. „Power BI”).');
    const { token } = newToken();
    const value = `flx_${token}`;
    const row = await tx(async (db) => {
      const target = await maybeOne(db, `select id from app_user where id = $1 and organization_id = $2 and active`, [req.body.userId, user.organizationId]);
      if (!target) throw notFound('Utilizatorul');
      const r = await one(
        db,
        `insert into api_token (organization_id, name, token_hash, user_id, created_by, expires_at) values ($1, $2, $3, $4, $5, $6) returning id`,
        [user.organizationId, req.body.name.trim(), sha256(value), target.id, user.id, req.body.expiresAt || null],
      );
      await audit(db, actorOf(user), { action: 'admin.api_token.create', entityType: 'api_token', entityId: r.id, newValue: { name: req.body.name, actsAs: target.id } });
      return r;
    });

    reply.status(201);
    return { id: row.id, token: value };
  });

  app.delete<{ Params: { id: string } }>('/admin/api-tokens/:id', async (req) => {
    const user = admin(req);
    await tx(async (db) => {
      const r = await query(db, `update api_token set revoked_at = now() where id = $1 and organization_id = $2 and revoked_at is null returning id`, [req.params.id, user.organizationId]);
      if (!r.length) throw notFound('Tokenul');
      await audit(db, actorOf(user), { action: 'admin.api_token.revoke', entityType: 'api_token', entityId: req.params.id });
    });
    return { ok: true };
  });

  app.get('/admin/webhooks', async (req) => {
    const user = admin(req);
    const items = await query(
      getPool(),
      `select w.id, w.name, w.url, w.events, w.active, w.created_at,
              (select count(*) from job_outbox j where j.kind = 'webhook' and j.payload->>'webhookId' = w.id::text and j.dispatched_at is not null and j.last_error is null) as delivered,
              (select count(*) from job_outbox j where j.kind = 'webhook' and j.payload->>'webhookId' = w.id::text and j.last_error is not null) as failed
         from webhook w where w.organization_id = $1 order by w.created_at`,
      [user.organizationId],
    );
    return { items, events: PUBLIC_EVENTS };
  });

  /** Deliveries are POSTs with JSON and the header X-Flux-Signature: sha256=<HMAC of the body with the secret>. */
  app.post<{ Body: { name: string; url: string; events: string[] } }>('/admin/webhooks', async (req, reply) => {
    const user = admin(req);
    const b = req.body ?? ({} as never);
    if (!b.name?.trim() || !/^https?:\/\//.test(b.url ?? '')) throw badRequest('Completați numele și adresa (https://…).');
    const events = (b.events ?? []).filter((e) => PUBLIC_EVENTS.includes(e));
    if (!events.length) throw badRequest('Alegeți cel puțin un eveniment.');
    const secret = randomBytes(24).toString('base64url');
    const row = await tx(async (db) => {
      const r = await one(
        db,
        `insert into webhook (organization_id, name, url, events, secret_enc, created_by) values ($1, $2, $3, $4, $5, $6) returning id`,
        [user.organizationId, b.name.trim(), b.url.trim(), events, encrypt(secret), user.id],
      );
      await audit(db, actorOf(user), { action: 'admin.webhook.create', entityType: 'webhook', entityId: r.id, newValue: { name: b.name, url: b.url, events } });
      return r;
    });
    reply.status(201);
    return { id: row.id, secret };
  });

  app.patch<{ Params: { id: string }; Body: { active: boolean } }>('/admin/webhooks/:id', async (req) => {
    const user = admin(req);
    await tx(async (db) => {
      const r = await query(db, `update webhook set active = $3 where id = $1 and organization_id = $2 returning id`, [req.params.id, user.organizationId, Boolean(req.body?.active)]);
      if (!r.length) throw notFound('Webhook-ul');
      await audit(db, actorOf(user), { action: 'admin.webhook.update', entityType: 'webhook', entityId: req.params.id, newValue: req.body });
    });
    return { ok: true };
  });
}
