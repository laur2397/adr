import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';
import { buildApp } from './app.js';
import { config } from './core/config.js';
import { closePool, getPool } from './core/db.js';
import { migrate } from './core/migrate.js';

// WEB_CONCURRENCY processes share the port (Node cluster); default: one per CPU, up to 4, in production.
const workers = Number(process.env.WEB_CONCURRENCY ?? (config.env === 'production' ? Math.min(4, availableParallelism()) : 1));

if (cluster.isPrimary && workers > 1) {
  if (process.env.MIGRATE_ON_START !== 'false') {
    await migrate(getPool(), (m) => console.log(m));
    await closePool();
  }
  for (let i = 0; i < workers; i++) cluster.fork({ MIGRATE_ON_START: 'false' });
  cluster.on('exit', (worker, code) => {
    console.error(`api process ${worker.process.pid} exited (${code}); restarting`);
    cluster.fork({ MIGRATE_ON_START: 'false' });
  });
} else {
  const app = await buildApp();
  if (process.env.MIGRATE_ON_START !== 'false') await migrate(getPool(), (m) => app.log.info(m));
  await app.listen({ port: config.port, host: config.host });
}
