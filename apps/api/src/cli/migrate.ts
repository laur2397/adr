import { closePool, getPool } from '../core/db.js';
import { migrate } from '../core/migrate.js';

const applied = await migrate(getPool(), (m) => console.log(m));
console.log(applied.length ? `${applied.length} migration(s) applied` : 'database is up to date');
await closePool();
