import { buildApp } from './app.js';
import { config } from './core/config.js';
import { getPool } from './core/db.js';
import { migrate } from './core/migrate.js';

const app = await buildApp();
if (process.env.MIGRATE_ON_START !== 'false') await migrate(getPool(), (m) => app.log.info(m));
await app.listen({ port: config.port, host: config.host });
