import type { FastifyInstance } from 'fastify';
import { userOf } from '../app.js';
import { audit } from '../audit/audit.js';
import { config } from '../core/config.js';
import { getPool, maybeOne, query, tx } from '../core/db.js';
import { AppError, badRequest } from '../core/errors.js';
import { actorOf } from '../identity/context.js';
import { decrypt, encrypt, hashPassword, newTotpSecret, passwordProblems, verifyPassword, verifyTotp } from './crypto.js';
import { SESSION_COOKIE, createSession, revokeAllSessions, revokeSession } from './session.js';

const cookieOpts = () => ({
  path: '/',
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: config.secureCookies,
  maxAge: config.sessionHours * 3600,
});

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: { username: string; password: string; totp?: string } }>(
    '/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          properties: { username: { type: 'string' }, password: { type: 'string' }, totp: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const pool = getPool();
      const u = await maybeOne(pool, `select id, organization_id, password_hash, totp_secret_enc from app_user where lower(username) = lower($1) and active`, [
        req.body.username,
      ]);
      const ok = await verifyPassword(req.body.password, u?.password_hash ?? null);
      if (!u || !ok) {
        if (u) await audit(pool, { organizationId: u.organization_id, userId: u.id, ip: req.ip }, { action: 'auth.login_failed', entityType: 'user', entityId: u.id });
        throw new AppError(401, 'Utilizatorul sau parola nu sunt corecte.');
      }
      if (u.totp_secret_enc) {
        if (!req.body.totp) throw new AppError(401, 'Introduceți codul din aplicația de autentificare.', [], { code: 'totp_required' });
        if (!verifyTotp(decrypt(u.totp_secret_enc), req.body.totp)) {
          await audit(pool, { organizationId: u.organization_id, userId: u.id, ip: req.ip }, { action: 'auth.totp_failed', entityType: 'user', entityId: u.id });
          throw new AppError(401, 'Codul de autentificare nu este corect sau a expirat.', [], { code: 'totp_required' });
        }
      }
      const token = await createSession(pool, u.id, req.ip, req.headers['user-agent'] ?? null);
      await audit(pool, { organizationId: u.organization_id, userId: u.id, ip: req.ip, userAgent: req.headers['user-agent'] ?? null }, {
        action: 'auth.login', entityType: 'user', entityId: u.id,
      });
      reply.setCookie(SESSION_COOKIE, token, cookieOpts());
      return { ok: true };
    },
  );

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await revokeSession(getPool(), token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', async (req) => {
    const user = userOf(req);
    const [extra] = await query(getPool(), `select totp_secret_enc is not null as totp_enabled from app_user where id = $1`, [user.id]);
    const substitutedBy = await query(
      getPool(),
      `select s.substitute_user_id, u.full_name, s.scope, s.valid_from, s.valid_to from substitution s join app_user u on u.id = s.substitute_user_id
        where s.absent_user_id = $1 and s.valid_to > now() order by s.valid_from`,
      [user.id],
    );
    const replacing = await query(
      getPool(),
      `select u.id, u.full_name from app_user u where u.id = any($1::uuid[])`,
      [user.substitutes.map((s) => s.absentUserId)],
    );
    return {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      email: user.email,
      departmentId: user.departmentId,
      roles: [...new Set(user.roles.filter((r) => !r.viaSubstitutionOf).map((r) => r.key))],
      totpEnabled: extra?.totp_enabled ?? false,
      replacing: replacing.map((r) => ({ id: r.id, fullName: r.full_name, scope: user.substitutes.find((s) => s.absentUserId === r.id)?.scope })),
      substitutedBy: substitutedBy.map((s) => ({ userId: s.substitute_user_id, fullName: s.full_name, scope: s.scope, from: s.valid_from, to: s.valid_to })),
    };
  });

  app.post<{ Body: { currentPassword: string; newPassword: string } }>('/me/password', async (req) => {
    const user = userOf(req);
    const problems = passwordProblems(req.body.newPassword ?? '');
    if (problems.length) throw badRequest('Parola nouă nu respectă politica.', problems.map((message) => ({ field: 'newPassword', message })));
    await tx(async (db) => {
      const u = await maybeOne(db, `select password_hash from app_user where id = $1`, [user.id]);
      if (!(await verifyPassword(req.body.currentPassword ?? '', u?.password_hash ?? null))) throw new AppError(400, 'Parola curentă nu este corectă.');
      await query(db, `update app_user set password_hash = $2 where id = $1`, [user.id, await hashPassword(req.body.newPassword)]);
      await audit(db, actorOf(user), { action: 'auth.password_change', entityType: 'user', entityId: user.id });
    });
    return { ok: true };
  });

  /** Step 1 of enabling 2FA: returns a secret to scan; it is stored only after confirmation. */
  app.post('/me/totp/setup', async (req) => {
    const user = userOf(req);
    const secret = newTotpSecret();
    const label = encodeURIComponent(`Flux AM:${user.username}`);
    return { secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=Flux%20AM` };
  });

  app.post<{ Body: { secret: string; code: string } }>('/me/totp/confirm', async (req) => {
    const user = userOf(req);
    if (!verifyTotp(req.body.secret, req.body.code)) throw badRequest('Codul nu corespunde. Verificați ora telefonului și încercați din nou.');
    await tx(async (db) => {
      await query(db, `update app_user set totp_secret_enc = $2 where id = $1`, [user.id, encrypt(req.body.secret)]);
      await audit(db, actorOf(user), { action: 'auth.totp_enable', entityType: 'user', entityId: user.id });
      await revokeAllSessions(db, user.id);
    });
    return { ok: true, reloginRequired: true };
  });
}
