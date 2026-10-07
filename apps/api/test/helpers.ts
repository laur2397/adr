import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { closePool, getPool, tx } from '../src/core/db.js';
import { migrate } from '../src/core/migrate.js';
import { processOutboxOnce } from '../src/jobs/runner.js';
import { seedBase } from '../src/seed/base.js';
import { seedDemo } from '../src/seed/demo.js';

export const PASSWORD = 'Parola-test-2026';

/** Recreates the test database, migrates and seeds base + demo data. */
export async function resetDatabase(): Promise<string> {
  const url = new URL(process.env.DATABASE_URL!);
  const name = url.pathname.slice(1);
  const admin = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).toString() });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [name]);
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();
  await closePool();
  await migrate(getPool());
  return tx(async (db) => {
    const { organizationId } = await seedBase(db, {
      organizationName: 'ADR Test',
      organizationCui: '1590082',
      adminUsername: 'admin',
      adminEmail: 'admin@test.ro',
      adminPassword: PASSWORD,
    });
    await seedDemo(db, organizationId, PASSWORD);
    return organizationId;
  });
}

export class Client {
  private cookie = '';
  constructor(private readonly app: FastifyInstance) {}

  async login(username: string, password = PASSWORD) {
    const res = await this.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password }, headers: { 'x-flux-csrf': '1' } });
    if (res.statusCode !== 200) throw new Error(`login ${username}: ${res.statusCode} ${res.body}`);
    const set = res.headers['set-cookie'];
    this.cookie = String(Array.isArray(set) ? set[0] : set).split(';')[0]!;
    return this;
  }

  async req(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<LightMyRequestResponse> {
    return this.app.inject({ method, url: `/api/v1${url}`, payload: payload as never, headers: { cookie: this.cookie, 'x-flux-csrf': '1' } });
  }

  async ok<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<T> {
    const res = await this.req(method, url, payload);
    if (res.statusCode >= 300) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
    return res.json() as T;
  }
}

export async function startApp() {
  return buildApp({ logger: process.env.TEST_LOG === '1' });
}

/** Runs queued jobs (document generation etc.) the way the worker would. */
export async function drainJobs() {
  while ((await processOutboxOnce()) > 0);
}

export async function stop(app: FastifyInstance) {
  await app.close();
  await closePool();
}
