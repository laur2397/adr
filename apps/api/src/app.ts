import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { SESSION_COOKIE, resolveSession } from './auth/session.js';
import { config } from './core/config.js';
import { getPool } from './core/db.js';
import { AppError } from './core/errors.js';
import { loadUser, type CurrentUser } from './identity/context.js';
import { adminRoutes } from './admin/routes.js';
import { authRoutes } from './auth/routes.js';
import { documentRoutes } from './documents/routes.js';
import { referenceRoutes } from './reference/routes.js';
import { registryRoutes } from './registry/routes.js';
import { reportingRoutes } from './reporting/routes.js';
import { signingRoutes } from './signing/routes.js';
import { workflowRoutes } from './workflow/routes.js';

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
    // CSRF: browsers cannot send a custom header cross-site without a CORS preflight, which we never allow.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !path.startsWith('/api/v1/signatures/callback/') && req.headers['x-flux-csrf'] !== '1') {
      throw new AppError(403, 'Cerere respinsă: lipsește antetul X-Flux-Csrf.');
    }
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const session = await resolveSession(getPool(), token);
      if (session) {
        const user = await loadUser(getPool(), session.userId);
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

  return app;
}
