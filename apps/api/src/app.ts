import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import fastifyStatic from '@fastify/static';
import swaggerUi from '@fastify/swagger-ui';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { SESSION_COOKIE, resolveSession } from './auth/session.js';
import { config } from './core/config.js';
import { getPool } from './core/db.js';
import { AppError } from './core/errors.js';
import { loadUserCached, type CurrentUser } from './identity/context.js';
import { adminRoutes } from './admin/routes.js';
import { authRoutes } from './auth/routes.js';
import { documentRoutes } from './documents/routes.js';
import { referenceRoutes } from './reference/routes.js';
import { registryRoutes } from './registry/routes.js';
import { reportingRoutes } from './reporting/routes.js';
import { signingRoutes } from './signing/routes.js';
import { workflowRoutes } from './workflow/routes.js';
import { collaborationRoutes } from './collaboration/routes.js';
import { debtRoutes } from './debts/routes.js';
import { searchRoutes } from './search/routes.js';
import { controlRoutes } from './controls/routes.js';
import { archiveRoutes } from './archive/routes.js';
import { integrationRoutes } from './integrations/hooks/routes.js';
import { mailRoutes } from './integrations/mail/routes.js';
import { visitRoutes } from './visits/routes.js';
import { resolveApiToken } from './integrations/hooks/token.js';

declare module 'fastify' {
  interface FastifyRequest {
    currentUser: CurrentUser | null;
  }
}

/** The authenticated user, or a 401 for anonymous requests. */
export function userOf(req: FastifyRequest): CurrentUser {
  if (!req.currentUser) throw new AppError(401, 'Sesiunea a expirat. Autentificați-vă din nou.');
  return req.currentUser;
}

const PUBLIC_ROUTES = new Set(['/api/v1/auth/login', '/api/v1/health', '/api/v1/ready']);

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? config.env !== 'test',
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 1 } });
  await app.register(swagger, {
    openapi: {
      info: { title: 'Flux AM API', version: '1.0.0', description: 'API REST pentru dosare, sarcini, registre, documente și semnături.' },
      components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE } } },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  app.decorateRequest('currentUser', null);

  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0]!;
    if (!path.startsWith('/api/v1/')) return;
    // API tokens (integrations): Authorization: Bearer flx_… acts as the token's user; no cookies, so no CSRF risk.
    const bearer = /^Bearer (flx_[A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (bearer) {
      const userId = await resolveApiToken(getPool(), bearer);
      const user = userId ? await loadUserCached(getPool(), userId) : null;
      if (!user) throw new AppError(401, 'Token API invalid, expirat sau revocat.');
      user.ip = req.ip;
      user.userAgent = req.headers['user-agent'] ?? null;
      req.currentUser = user;
      return;
    }
    // CSRF: browsers cannot send a custom header cross-site without a CORS preflight, which we never allow.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !path.startsWith('/api/v1/signatures/callback/') && req.headers['x-flux-csrf'] !== '1') {
      throw new AppError(403, 'Cerere respinsă: lipsește antetul X-Flux-Csrf.');
    }
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const session = await resolveSession(getPool(), token);
      if (session) {
        const user = await loadUserCached(getPool(), session.userId);
        if (user) {
          user.ip = req.ip;
          user.userAgent = req.headers['user-agent'] ?? null;
          req.currentUser = user;
        }
      }
    }
    if (!req.currentUser && !PUBLIC_ROUTES.has(path) && !path.startsWith('/api/v1/signatures/callback/')) {
      throw new AppError(401, 'Autentificați-vă pentru a continua.');
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply
        .status(err.status)
        .type('application/problem+json')
        .send({ status: err.status, title: err.title, errors: err.errors, ...err.extra });
    }
    const e = err as { validation?: unknown; statusCode?: number; message: string };
    if (e.validation) {
      return reply.status(400).type('application/problem+json').send({ status: 400, title: 'Datele trimise nu sunt valide.', errors: [{ message: e.message }] });
    }
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).type('application/problem+json').send({ status: e.statusCode, title: e.message, errors: [] });
    }
    req.log.error(err);
    return reply.status(500).type('application/problem+json').send({
      status: 500,
      title: 'A apărut o eroare neașteptată. Încercați din nou; dacă se repetă, contactați administratorul.',
      errors: [],
    });
  });

  app.get('/api/v1/health', async () => ({ status: 'ok' }));
  app.get('/api/v1/ready', async () => {
    await getPool().query('select 1');
    return { status: 'ready' };
  });

  await app.register(authRoutes, { prefix: '/api/v1' });
  await app.register(adminRoutes, { prefix: '/api/v1' });
  await app.register(referenceRoutes, { prefix: '/api/v1' });
  await app.register(registryRoutes, { prefix: '/api/v1' });
  await app.register(workflowRoutes, { prefix: '/api/v1' });
  await app.register(documentRoutes, { prefix: '/api/v1' });
  await app.register(signingRoutes, { prefix: '/api/v1' });
  await app.register(reportingRoutes, { prefix: '/api/v1' });
  await app.register(collaborationRoutes, { prefix: '/api/v1' });
  await app.register(debtRoutes, { prefix: '/api/v1' });
  await app.register(searchRoutes, { prefix: '/api/v1' });
  await app.register(controlRoutes, { prefix: '/api/v1' });
  await app.register(archiveRoutes, { prefix: '/api/v1' });
  await app.register(integrationRoutes, { prefix: '/api/v1' });
  await app.register(mailRoutes, { prefix: '/api/v1' });
  await app.register(visitRoutes, { prefix: '/api/v1' });

  // Production: the API also serves the built web app (WEB_DIST), with client-side routing fallback.
  const webDist = process.env.WEB_DIST;
  if (webDist && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false, maxAge: '1h' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).type('application/problem+json').send({ status: 404, title: 'Adresa nu există.', errors: [] });
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    });
  }

  app.addHook('onSend', async (req, reply, payload) => {
    // The service worker and the manifest must be revalidated, or browsers keep an old app shell.
    if (req.url === '/sw.js' || req.url === '/manifest.webmanifest') reply.header('cache-control', 'no-cache');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    return payload;
  });

  return app;
}
