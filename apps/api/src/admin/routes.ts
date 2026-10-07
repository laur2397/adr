import type { FastifyInstance } from 'fastify';
import { validateDefinition } from '@flux/process-schema';
import { checkEmail } from '@flux/validators';
import { proposedRomanianHolidays } from '@flux/working-days';
import { userOf } from '../app.js';
import { audit } from '../audit/audit.js';
import { hashPassword, passwordProblems } from '../auth/crypto.js';
import { revokeAllSessions } from '../auth/session.js';
import { getPool, maybeOne, one, query, tx } from '../core/db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { putFile } from '../documents/storage.js';
import { actorOf, hasRole, type CurrentUser } from '../identity/context.js';

function requireAdmin(user: CurrentUser) {
  if (!hasRole(user, 'functional_admin')) throw forbidden('Această secțiune este disponibilă administratorului funcțional.');
}

export async function adminRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- users and roles
  app.get('/admin/users', async (req) => {
    const user = userOf(req);
    requireAdmin(user);
    const users = await query(
      getPool(),
      `select u.id, u.username, u.email, u.full_name, u.job_title, u.department_id, d.name as department, u.active,
              u.totp_secret_enc is not null as totp_enabled
         from app_user u left join department d on d.id = u.department_id where u.organization_id = $1 order by u.full_name`,
      [user.organizationId],
    );
    const roles = await query(
      getPool(),
      `select ra.id, ra.user_id, r.key, r.name, ra.department_id, ra.program_id, ra.valid_from, ra.valid_to
         from role_assignment ra join role r on r.id = ra.role_id where r.organization_id = $1 order by r.name`,
      [user.organizationId],
    );
    return { items: users.map((u) => ({ ...u, roles: roles.filter((r) => r.user_id === u.id) })) };
  });

  app.get('/admin/meta', async (req) => {
    const user = userOf(req);
    const pool = getPool();
    return {
      roles: await query(pool, `select id, key, name from role where organization_id = $1 order by name`, [user.organizationId]),
      departments: await query(pool, `select id, code, name, head_user_id from department where organization_id = $1 and active order by name`, [user.organizationId]),
      programs: await query(pool, `select id, code, name from program where organization_id = $1 and active order by code`, [user.organizationId]),
    };
  });

  app.post<{ Body: { username: string; email: string; fullName: string; jobTitle?: string; departmentId?: string; password: string } }>('/admin/users', async (req, reply) => {
    const user = userOf(req);
    requireAdmin(user);
    const b = req.body ?? ({} as never);
    const errors = [
      ...(b.username?.trim() ? [] : [{ field: 'username', message: 'Obligatoriu' }]),
      ...(b.fullName?.trim() ? [] : [{ field: 'fullName', message: 'Obligatoriu' }]),
      ...(checkEmail(b.email ?? '').ok ? [] : [{ field: 'email', message: 'Adresă de e-mail invalidă' }]),
      ...passwordProblems(b.password ?? '').map((message) => ({ field: 'password', message })),
    ];
    if (errors.length) throw badRequest('Datele utilizatorului nu sunt complete.', errors);
    const id = await tx(async (db) => {
      const exists = await maybeOne(db, `select 1 from app_user where organization_id = $1 and (lower(username) = lower($2) or lower(email) = lower($3))`, [
        user.organizationId,
        b.username,
        b.email,
      ]);
      if (exists) throw conflict('Există deja un utilizator cu acest nume sau e-mail.');
      const row = await one(
        db,
        `insert into app_user (organization_id, username, email, full_name, job_title, department_id, password_hash) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [user.organizationId, b.username.trim(), b.email.trim(), b.fullName.trim(), b.jobTitle ?? null, b.departmentId ?? null, await hashPassword(b.password)],
      );
      await audit(db, actorOf(user), { action: 'admin.user.create', entityType: 'user', entityId: row.id, newValue: { username: b.username, email: b.email, fullName: b.fullName } });
      return row.id;
    });
    reply.status(201);
    return { id };
  });

  app.patch<{ Params: { id: string }; Body: { fullName?: string; jobTitle?: string; departmentId?: string | null; active?: boolean; password?: string } }>(
    '/admin/users/:id',
    async (req) => {
      const user = userOf(req);
      requireAdmin(user);
      const b = req.body ?? {};
      if (b.password) {
        const problems = passwordProblems(b.password);
        if (problems.length) throw badRequest('Parola nu respectă politica.', problems.map((message) => ({ field: 'password', message })));
      }
      await tx(async (db) => {
        const old = await maybeOne(db, `select full_name, job_title, department_id, active from app_user where id = $1 and organization_id = $2`, [req.params.id, user.organizationId]);
        if (!old) throw notFound('Utilizatorul');
        await query(
          db,
          `update app_user set full_name = coalesce($2, full_name), job_title = coalesce($3, job_title),
                  department_id = case when $4::boolean then $5::uuid else department_id end, active = coalesce($6, active),
                  password_hash = coalesce($7, password_hash)
            where id = $1`,
          [req.params.id, b.fullName ?? null, b.jobTitle ?? null, 'departmentId' in b, b.departmentId ?? null, b.active ?? null, b.password ? await hashPassword(b.password) : null],
        );
        if (b.active === false || b.password) await revokeAllSessions(db, req.params.id);
        await audit(db, actorOf(user), { action: 'admin.user.update', entityType: 'user', entityId: req.params.id, oldValue: old, newValue: { ...b, password: b.password ? '***' : undefined } });
      });
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { roleKey: string; departmentId?: string; programId?: string; validFrom?: string; validTo?: string } }>(
    '/admin/users/:id/roles',
    async (req, reply) => {
      const user = userOf(req);
      requireAdmin(user);
      const id = await tx(async (db) => {
        const role = await maybeOne(db, `select id from role where organization_id = $1 and key = $2`, [user.organizationId, req.body?.roleKey]);
        if (!role) throw notFound('Rolul');
        const row = await one(
          db,
          `insert into role_assignment (user_id, role_id, department_id, program_id, valid_from, valid_to) values ($1, $2, $3, $4, coalesce($5::date, current_date), $6) returning id`,
          [req.params.id, role.id, req.body.departmentId ?? null, req.body.programId ?? null, req.body.validFrom ?? null, req.body.validTo ?? null],
        );
        await audit(db, actorOf(user), { action: 'admin.role.assign', entityType: 'user', entityId: req.params.id, newValue: req.body });
        return row.id;
      });
      reply.status(201);
      return { id };
    },
  );

  app.delete<{ Params: { id: string; assignmentId: string } }>('/admin/users/:id/roles/:assignmentId', async (req) => {
    const user = userOf(req);
    requireAdmin(user);
    await tx(async (db) => {
      // Role history is kept: the assignment ends yesterday instead of being deleted.
      const r = await query(db, `update role_assignment set valid_to = greatest(valid_from, current_date - 1) where id = $1 and user_id = $2 returning id`, [
        req.params.assignmentId,
        req.params.id,
      ]);
      if (!r.length) throw notFound('Atribuirea');
      await audit(db, actorOf(user), { action: 'admin.role.revoke', entityType: 'user', entityId: req.params.id, newValue: { assignmentId: req.params.assignmentId } });
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- substitutions
  app.get('/substitutions', async (req) => {
    const user = userOf(req);
    const all = hasRole(user, 'functional_admin', 'head_of_unit');
    return {
      items: await query(
        getPool(),
        `select s.id, s.scope, s.process_definition_key, s.valid_from, s.valid_to, a.full_name as absent_name, b.full_name as substitute_name,
                s.absent_user_id, s.substitute_user_id
           from substitution s join app_user a on a.id = s.absent_user_id join app_user b on b.id = s.substitute_user_id
          where a.organization_id = $1 and s.valid_to > now() and ($2 or s.absent_user_id = $3 or s.substitute_user_id = $3)
          order by s.valid_from`,
        [user.organizationId, all, user.id],
      ),
    };
  });

  app.post<{ Body: { absentUserId?: string; substituteUserId: string; scope: 'tasks' | 'full'; processKey?: string; validFrom: string; validTo: string } }>(
    '/substitutions',
    async (req, reply) => {
      const user = userOf(req);
      const b = req.body ?? ({} as never);
      const absent = b.absentUserId ?? user.id;
      if (absent !== user.id && !hasRole(user, 'functional_admin', 'head_of_unit')) throw forbidden('Puteți stabili doar propriul înlocuitor.');
      if (!['tasks', 'full'].includes(b.scope)) throw badRequest('Alegeți tipul înlocuirii.');
      if (!b.validFrom || !b.validTo || b.validTo <= b.validFrom) throw badRequest('Perioada înlocuirii nu este validă.');
      if (b.substituteUserId === absent) throw badRequest('Înlocuitorul trebuie să fie altă persoană.');
      const id = await tx(async (db) => {
        const sub = await maybeOne(db, `select id from app_user where id = $1 and organization_id = $2 and active`, [b.substituteUserId, user.organizationId]);
        if (!sub) throw notFound('Înlocuitorul');
        const row = await one(
          db,
          `insert into substitution (absent_user_id, substitute_user_id, scope, process_definition_key, valid_from, valid_to, created_by)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [absent, b.substituteUserId, b.scope, b.processKey ?? null, b.validFrom, b.validTo, user.id],
        );
        await audit(db, actorOf(user), { action: 'substitution.create', entityType: 'substitution', entityId: row.id, newValue: { ...b, absentUserId: absent } });
        return row.id;
      });
      reply.status(201);
      return { id };
    },
  );

  app.delete<{ Params: { id: string } }>('/substitutions/:id', async (req) => {
    const user = userOf(req);
    await tx(async (db) => {
      const s = await maybeOne(db, `select * from substitution where id = $1`, [req.params.id]);
      if (!s) throw notFound('Înlocuirea');
      if (s.absent_user_id !== user.id && !hasRole(user, 'functional_admin', 'head_of_unit')) throw forbidden();
      await query(db, `update substitution set valid_to = greatest(valid_from + interval '1 second', now()) where id = $1`, [req.params.id]);
      await audit(db, actorOf(user), { action: 'substitution.end', entityType: 'substitution', entityId: req.params.id });
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- calendar and deadlines
  app.get<{ Params: { year: string } }>('/admin/calendar/:year', async (req) => {
    const user = userOf(req);
    const year = Number(req.params.year);
    const holidays = await query(getPool(), `select day, name from holiday where organization_id = $1 and extract(year from day) = $2 order by day`, [user.organizationId, year]);
    const exceptions = await query(getPool(), `select day, is_working, note from working_day_exception where organization_id = $1 and extract(year from day) = $2 order by day`, [
      user.organizationId,
      year,
    ]);
    return { year, holidays, exceptions, proposal: holidays.length ? null : proposedRomanianHolidays(year) };
  });

  app.put<{ Params: { year: string }; Body: { holidays: Array<{ day: string; name: string }>; exceptions?: Array<{ day: string; isWorking: boolean; note?: string }> } }>(
    '/admin/calendar/:year',
    async (req) => {
      const user = userOf(req);
      requireAdmin(user);
      const year = Number(req.params.year);
      const all = [...(req.body?.holidays ?? []).map((h) => h.day), ...(req.body?.exceptions ?? []).map((e) => e.day)];
      if (all.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d) || Number(d.slice(0, 4)) !== year)) throw badRequest(`Toate datele trebuie să fie din anul ${year}.`);
      await tx(async (db) => {
        await query(db, `delete from holiday where organization_id = $1 and extract(year from day) = $2`, [user.organizationId, year]);
        await query(db, `delete from working_day_exception where organization_id = $1 and extract(year from day) = $2`, [user.organizationId, year]);
        for (const h of req.body.holidays) await query(db, `insert into holiday (organization_id, day, name) values ($1, $2, $3)`, [user.organizationId, h.day, h.name]);
        for (const e of req.body.exceptions ?? []) {
          await query(db, `insert into working_day_exception (organization_id, day, is_working, note) values ($1, $2, $3, $4)`, [user.organizationId, e.day, e.isWorking, e.note ?? null]);
        }
        // Running deadlines move with the calendar.
        const running = await query(db, `select d.id from deadline d join instance i on i.id = d.instance_id where i.organization_id = $1 and d.status in ('running', 'paused')`, [user.organizationId]);
        const { recompute } = await import('../deadlines/service.js');
        for (const d of running) await recompute(db, d.id);
        await audit(db, actorOf(user), { action: 'admin.calendar.update', entityType: 'calendar', entityId: String(year), newValue: req.body });
      });
      return { ok: true };
    },
  );

  app.get('/admin/deadline-definitions', async (req) => {
    const user = userOf(req);
    return {
      items: await query(
        getPool(),
        `select dd.*, u.full_name as validated_by_name from deadline_definition dd left join app_user u on u.id = dd.validated_by
          where dd.organization_id = $1 order by dd.name`,
        [user.organizationId],
      ),
    };
  });

  app.patch<{ Params: { key: string }; Body: Record<string, unknown> }>('/admin/deadline-definitions/:key', async (req) => {
    const user = userOf(req);
    requireAdmin(user);
    const allowed = ['name', 'day_type', 'days', 'start_point', 'pause_mode', 'max_pauses', 'max_paused_days', 'extension_days', 'warn_before_days', 'legal_reference'];
    const b = Object.fromEntries(Object.entries(req.body ?? {}).filter(([k]) => allowed.includes(k)));
    if (!Object.keys(b).length) throw badRequest('Nu ați modificat nimic.');
    await tx(async (db) => {
      const old = await maybeOne(db, `select * from deadline_definition where organization_id = $1 and key = $2 for update`, [user.organizationId, req.params.key]);
      if (!old) throw notFound('Termenul');
      const sets = Object.keys(b).map((k, i) => `${k} = $${i + 3}`);
      // Any change to a legal term sends it back to legal validation.
      await query(db, `update deadline_definition set ${sets.join(', ')}, legal_status = 'to_validate', validated_by = null, validated_at = null where organization_id = $1 and key = $2`, [
        user.organizationId,
        req.params.key,
        ...Object.values(b),
      ]);
      await audit(db, actorOf(user), { action: 'deadline_definition.update', entityType: 'deadline_definition', entityId: old.id, oldValue: old, newValue: b });
    });
    return { ok: true };
  });

  app.post<{ Params: { key: string } }>('/admin/deadline-definitions/:key/validate', async (req) => {
    const user = userOf(req);
    if (!hasRole(user, 'functional_admin', 'legal_advisor', 'director')) throw forbidden('Validarea juridică se face de consilierul juridic sau de director.');
    await tx(async (db) => {
      const r = await query(
        db,
        `update deadline_definition set legal_status = 'validated', validated_by = $3, validated_at = now() where organization_id = $1 and key = $2 returning id`,
        [user.organizationId, req.params.key, user.id],
      );
      if (!r.length) throw notFound('Termenul');
      await audit(db, actorOf(user), { action: 'deadline_definition.validate', entityType: 'deadline_definition', entityId: r[0]!.id });
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- process definitions
  app.get('/admin/process-definitions', async (req) => {
    const user = userOf(req);
    requireAdmin(user);
    return {
      items: await query(
        getPool(),
        `select id, key, version, name, status, created_at, published_at from process_definition where organization_id = $1 order by key, version desc`,
        [user.organizationId],
      ),
    };
  });

  app.get<{ Params: { key: string; version: string } }>('/admin/process-definitions/:key/versions/:version', async (req) => {
    const user = userOf(req);
    requireAdmin(user);
    const row = await maybeOne(getPool(), `select * from process_definition where organization_id = $1 and key = $2 and version = $3`, [
      user.organizationId,
      req.params.key,
      Number(req.params.version),
    ]);
    if (!row) throw notFound('Definiția');
    return row;
  });

  app.post<{ Body: unknown }>('/admin/process-definitions/validate', async (req) => {
    userOf(req);
    const r = validateDefinition(req.body);
    return r.ok ? { ok: true, problems: [] } : { ok: false, problems: r.problems };
  });

  /** Creates a new draft version (from a JSON body). */
  app.post<{ Body: { definition: unknown } }>('/admin/process-definitions', async (req, reply) => {
    const user = userOf(req);
    requireAdmin(user);
    const r = validateDefinition(req.body?.definition);
    if (!r.ok) throw new AppError(422, 'Definiția procesului nu este validă.', r.problems.map((p) => ({ field: p.path, message: p.message })));
    const def = r.definition;
    const row = await tx(async (db) => {
      const { next } = await one(db, `select coalesce(max(version), 0) + 1 as next from process_definition where organization_id = $1 and key = $2`, [user.organizationId, def.key]);
      const created = await one(
        db,
        `insert into process_definition (organization_id, key, version, name, definition, status, created_by) values ($1, $2, $3, $4, $5, 'draft', $6) returning id, version`,
        [user.organizationId, def.key, next, def.name, JSON.stringify(def), user.id],
      );
      await audit(db, actorOf(user), { action: 'definition.create', entityType: 'process_definition', entityId: created.id, newValue: { key: def.key, version: next } });
      return created;
    });
    reply.status(201);
    return row;
  });

  app.put<{ Params: { key: string; version: string }; Body: { definition: unknown } }>('/admin/process-definitions/:key/versions/:version', async (req) => {
    const user = userOf(req);
    requireAdmin(user);
    const r = validateDefinition(req.body?.definition);
    if (!r.ok) throw new AppError(422, 'Definiția procesului nu este validă.', r.problems.map((p) => ({ field: p.path, message: p.message })));
    if (r.definition.key !== req.params.key) throw badRequest('Cheia procesului nu poate fi schimbată.');
    await tx(async (db) => {
      const row = await maybeOne(db, `select id, status from process_definition where organization_id = $1 and key = $2 and version = $3 for update`, [
        user.organizationId,
        req.params.key,
        Number(req.params.version),
      ]);
      if (!row) throw notFound('Definiția');
      if (row.status !== 'draft') throw conflict('O versiune publicată nu se mai modifică. Creați o versiune nouă.');
      await query(db, `update process_definition set definition = $2, name = $3 where id = $1`, [row.id, JSON.stringify(r.definition), r.definition.name]);
      await audit(db, actorOf(user), { action: 'definition.update', entityType: 'process_definition', entityId: row.id });
    });
    return { ok: true };
  });

  app.post<{ Params: { key: string; version: string } }>('/admin/process-definitions/:key/versions/:version/publish', async (req) => {
    const user = userOf(req);
    requireAdmin(user);
    await tx(async (db) => {
      const row = await maybeOne(db, `select id, status, definition from process_definition where organization_id = $1 and key = $2 and version = $3 for update`, [
        user.organizationId,
        req.params.key,
        Number(req.params.version),
      ]);
      if (!row) throw notFound('Definiția');
      if (row.status !== 'draft') throw conflict('Versiunea nu este o ciornă.');
      const r = validateDefinition(row.definition);
      if (!r.ok) throw new AppError(422, 'Definiția procesului nu este validă.', r.problems.map((p) => ({ field: p.path, message: p.message })));
      await query(db, `update process_definition set status = 'retired' where organization_id = $1 and key = $2 and status = 'published'`, [user.organizationId, req.params.key]);
      await query(db, `update process_definition set status = 'published', published_at = now() where id = $1`, [row.id]);
      await audit(db, actorOf(user), { action: 'definition.publish', entityType: 'process_definition', entityId: row.id, newValue: { key: req.params.key, version: Number(req.params.version) } });
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- checklists and templates
  app.get('/admin/checklist-templates', async (req) => {
    const user = userOf(req);
    const rows = await query(getPool(), `select id, key, version, name, status, answer_set from checklist_template where organization_id = $1 order by key, version desc`, [user.organizationId]);
    const items = await query(getPool(), `select template_id, position, code, question, legal_basis, observation_required_on from checklist_item where template_id = any($1::uuid[]) order by position`, [
      rows.map((r) => r.id),
    ]);
    return { items: rows.map((r) => ({ ...r, items: items.filter((i) => i.template_id === r.id) })) };
  });

  app.post<{ Body: { key: string; name: string; answerSet?: string[]; items: Array<{ code: string; question: string; legalBasis?: string; observationRequiredOn?: string[] }>; publish?: boolean } }>(
    '/admin/checklist-templates',
    async (req, reply) => {
      const user = userOf(req);
      requireAdmin(user);
      const b = req.body ?? ({} as never);
      if (!b.key || !b.name || !b.items?.length) throw badRequest('Lista de verificare trebuie să aibă cheie, nume și cel puțin un punct.');
      const row = await tx(async (db) => {
        const { next } = await one(db, `select coalesce(max(version), 0) + 1 as next from checklist_template where organization_id = $1 and key = $2`, [user.organizationId, b.key]);
        if (b.publish) await query(db, `update checklist_template set status = 'retired' where organization_id = $1 and key = $2 and status = 'published'`, [user.organizationId, b.key]);
        const t = await one(
          db,
          `insert into checklist_template (organization_id, key, version, name, answer_set, status) values ($1, $2, $3, $4, $5, $6) returning id, version`,
          [user.organizationId, b.key, next, b.name, b.answerSet ?? ['DA', 'NU', 'NA'], b.publish ? 'published' : 'draft'],
        );
        let pos = 1;
        for (const i of b.items) {
          await query(db, `insert into checklist_item (template_id, position, code, question, legal_basis, observation_required_on) values ($1, $2, $3, $4, $5, $6)`, [
            t.id,
            pos++,
            i.code,
            i.question,
            i.legalBasis ?? null,
            i.observationRequiredOn ?? ['NU'],
          ]);
        }
        await audit(db, actorOf(user), { action: 'checklist_template.create', entityType: 'checklist_template', entityId: t.id, newValue: { key: b.key, version: next, items: b.items.length } });
        return t;
      });
      reply.status(201);
      return row;
    },
  );

  app.get('/admin/document-templates', async (req) => {
    const user = userOf(req);
    return {
      items: await query(
        getPool(),
        `select id, key, version, name, status, encode(sha256, 'hex') as sha256, created_at from document_template where organization_id = $1 order by key, version desc`,
        [user.organizationId],
      ),
    };
  });

  /** Uploads a new DOCX template version (multipart: file, key, name, publish). */
  app.post('/admin/document-templates', async (req, reply) => {
    const user = userOf(req);
    requireAdmin(user);
    const file = await req.file();
    if (!file) throw badRequest('Alegeți fișierul DOCX.');
    if (!file.filename.toLowerCase().endsWith('.docx')) throw badRequest('Șabloanele trebuie să fie fișiere .docx.');
    const content = await file.toBuffer();
    const field = (n: string) => ((file.fields[n] as { value?: unknown } | undefined)?.value as string | undefined) ?? undefined;
    const key = field('key');
    const name = field('name');
    if (!key || !name) throw badRequest('Completați cheia și numele șablonului.');
    const stored = await putFile(content);
    const row = await tx(async (db) => {
      const { next } = await one(db, `select coalesce(max(version), 0) + 1 as next from document_template where organization_id = $1 and key = $2`, [user.organizationId, key]);
      const publish = field('publish') === 'true';
      if (publish) await query(db, `update document_template set status = 'retired' where organization_id = $1 and key = $2 and status = 'published'`, [user.organizationId, key]);
      const t = await one(
        db,
        `insert into document_template (organization_id, key, version, name, storage_key, sha256, status, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id, version`,
        [user.organizationId, key, next, name, stored.storageKey, stored.sha256, publish ? 'published' : 'draft', user.id],
      );
      await audit(db, actorOf(user), { action: 'document_template.create', entityType: 'document_template', entityId: t.id, newValue: { key, version: next, sha256: stored.sha256.toString('hex') } });
      return t;
    });
    reply.status(201);
    return row;
  });

  // ---------------------------------------------------------------- nomenclatures
  app.put<{ Params: { key: string }; Body: { name?: string; items: Array<{ code: string; label: string; active?: boolean }> } }>('/admin/nomenclatures/:key', async (req) => {
    const user = userOf(req);
    requireAdmin(user);
    await tx(async (db) => {
      const n = await one(
        db,
        `insert into nomenclature (organization_id, key, name) values ($1, $2, $3)
         on conflict (organization_id, key) do update set name = coalesce($3, nomenclature.name) returning id`,
        [user.organizationId, req.params.key, req.body?.name ?? req.params.key],
      );
      let pos = 0;
      for (const i of req.body?.items ?? []) {
        await query(
          db,
          `insert into nomenclature_item (nomenclature_id, code, label, position, active) values ($1, $2, $3, $4, $5)
           on conflict (nomenclature_id, code) do update set label = excluded.label, position = excluded.position, active = excluded.active`,
          [n.id, i.code, i.label, pos++, i.active ?? true],
        );
      }
      await audit(db, actorOf(user), { action: 'admin.nomenclature.update', entityType: 'nomenclature', entityId: n.id, newValue: req.body });
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- audit
  app.get('/admin/audit/verify', async (req) => {
    const user = userOf(req);
    if (!hasRole(user, 'auditor', 'functional_admin', 'it_admin')) throw forbidden();
    const broken = await maybeOne(getPool(), `select broken_id from audit_verify_chain()`);
    const stats = await one(getPool(), `select count(*)::int as events, max(id) as last_id, encode((select hash from audit_event order by id desc limit 1), 'hex') as last_hash from audit_event`);
    await audit(getPool(), actorOf(user), { action: 'audit.verify', entityType: 'audit', entityId: 'chain', newValue: { intact: !broken } });
    return { intact: !broken, brokenAt: broken?.broken_id ?? null, ...stats };
  });

  app.get<{ Querystring: { userId?: string; action?: string; from?: string; to?: string; limit?: string } }>('/admin/audit', async (req) => {
    const user = userOf(req);
    if (!hasRole(user, 'auditor', 'functional_admin')) throw forbidden();
    const q = req.query;
    const rows = await query(
      getPool(),
      `select e.id, e.occurred_at, e.action, e.entity_type, e.entity_id, e.new_value, host(e.ip) as ip, u.full_name as actor, ob.full_name as on_behalf_of
         from audit_event e left join app_user u on u.id = e.actor_user_id left join app_user ob on ob.id = e.on_behalf_of_user_id
        where e.organization_id = $1 and ($2::uuid is null or e.actor_user_id = $2) and ($3::text is null or e.action like $3 || '%')
          and ($4::date is null or e.occurred_at >= $4) and ($5::date is null or e.occurred_at < $5::date + 1)
        order by e.id desc limit $6`,
      [user.organizationId, q.userId || null, q.action || null, q.from || null, q.to || null, Math.min(Number(q.limit ?? 200), 2000)],
    );
    return { items: rows };
  });
}
