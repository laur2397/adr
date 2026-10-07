import type { FastifyInstance } from 'fastify';
import { ACL_CONDITION, aclParams } from '../access/policy.js';
import { userOf } from '../app.js';
import { getPool, query } from '../core/db.js';
import { hasRole } from '../identity/context.js';

export async function searchRoutes(app: FastifyInstance) {
  /** Global search: dossiers the user may see, and (for registry readers) register entries. */
  app.get<{ Querystring: { q?: string } }>('/search', async (req) => {
    const user = userOf(req);
    const q = (req.query.q ?? '').trim();
    if (q.length < 2) return { instances: [], entries: [] };
    const instances = await query(
      getPool(),
      `select i.id, i.title, i.reference_no, i.status, d.name as definition_name,
              ts_rank(to_tsvector('flux.ro', i.search_text), websearch_to_tsquery('flux.ro', $6)) as rank,
              ts_headline('flux.ro', i.search_text, websearch_to_tsquery('flux.ro', $6), 'MaxWords=18, MinWords=6, StartSel=«, StopSel=»') as snippet
         from instance i join process_definition d on d.id = i.definition_id
        where i.organization_id = $5 and ${ACL_CONDITION}
          and (to_tsvector('flux.ro', i.search_text) @@ websearch_to_tsquery('flux.ro', $6) or i.reference_no ilike $6 || '%' or i.search_text ilike '%' || $6 || '%')
        order by rank desc, i.started_at desc limit 25`,
      [...aclParams(user), user.organizationId, q],
    );
    const entries = hasRole(user, 'registry_inspector', 'functional_admin', 'head_of_unit', 'director', 'auditor')
      ? await query(
          getPool(),
          `select e.id, e.number_display, e.subject, e.registered_at, e.direction, r.key as register_key, r.name as register_name, e.instance_id
             from register_entry e join register r on r.id = e.register_id
            where r.organization_id = $1 and (e.search_vector @@ websearch_to_tsquery('flux.ro', $2) or e.number_display ilike $2 || '%')
            order by e.registered_at desc limit 15`,
          [user.organizationId, q],
        )
      : [];
    return { instances, entries };
  });
}
