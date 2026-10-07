import type { FastifyInstance } from 'fastify';
import { grant, requireView } from '../access/policy.js';
import { userOf } from '../app.js';
import { audit } from '../audit/audit.js';
import { getPool, one, query, tx } from '../core/db.js';
import { badRequest } from '../core/errors.js';
import { actorOf } from '../identity/context.js';
import { notifyUsers } from '../notifications/service.js';
import { reindexInstance } from '../search/index.js';

export async function collaborationRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/instances/:id/comments', async (req) => {
    const user = userOf(req);
    await requireView(getPool(), user, req.params.id);
    return {
      items: await query(
        getPool(),
        `select c.id, c.body, c.created_at, c.mentions, u.full_name as author, u.job_title, ob.full_name as on_behalf_of
           from instance_comment c join app_user u on u.id = c.author_id left join app_user ob on ob.id = c.on_behalf_of
          where c.instance_id = $1 order by c.created_at`,
        [req.params.id],
      ),
    };
  });

  /**
   * Adds a comment. "@username" mentions notify those colleagues and, when the author can edit the
   * dossier, give them read access to it (the reason is recorded).
   */
  app.post<{ Params: { id: string }; Body: { body: string } }>('/instances/:id/comments', async (req, reply) => {
    const user = userOf(req);
    const permission = await requireView(getPool(), user, req.params.id);
    const body = (req.body?.body ?? '').trim();
    if (!body) throw badRequest('Scrieți comentariul.');
    if (body.length > 5000) throw badRequest('Comentariul poate avea cel mult 5.000 de caractere.');
    const usernames = [...new Set([...body.matchAll(/@([a-z0-9._-]+)/gi)].map((m) => m[1]!.toLowerCase()))];
    const result = await tx(async (db) => {
      const mentioned = usernames.length
        ? await query(db, `select id, full_name from app_user where organization_id = $1 and lower(username) = any($2::text[]) and active`, [user.organizationId, usernames])
        : [];
      const ids = mentioned.map((m) => m.id as string).filter((x) => x !== user.id);
      const row = await one(db, `insert into instance_comment (instance_id, author_id, body, mentions) values ($1, $2, $3, $4) returning id, created_at`, [
        req.params.id,
        user.id,
        body,
        ids,
      ]);
      if (permission === 'edit') for (const uid of ids) await grant(db, req.params.id, 'user', uid, 'view', 'mention', user.id);
      const inst = await one(db, `select title from instance where id = $1`, [req.params.id]);
      await notifyUsers(db, ids, { kind: 'mention', instanceId: req.params.id, title: `${user.fullName} v-a menționat: ${inst.title}`, body });
      await audit(db, actorOf(user), { action: 'instance.comment', entityType: 'instance', entityId: req.params.id, newValue: { commentId: row.id, mentions: ids } });
      await reindexInstance(db, req.params.id);
      return { id: row.id, mentioned: mentioned.map((m) => m.full_name) };
    });
    reply.status(201);
    return result;
  });
}
