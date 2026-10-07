import { closePool, tx } from '../core/db.js';
import { getPool } from '../core/db.js';
import { migrate } from '../core/migrate.js';
import { seedBase } from '../seed/base.js';
import { seedDemo } from '../seed/demo.js';

const env = process.env;
const required = (k: string) => {
  const v = env[k];
  if (!v) {
    console.error(`Missing ${k}. See deploy/ghid-instalare.md.`);
    process.exit(1);
  }
  return v;
};

await migrate(getPool(), (m) => console.log(m));
const demo = env.SEED_DEMO === 'true';
const base = {
  organizationName: env.ORG_NAME ?? (demo ? 'Agenția pentru Dezvoltare Regională DEMO' : required('ORG_NAME')),
  organizationCui: env.ORG_CUI ?? (demo ? '1590082' : required('ORG_CUI')),
  adminUsername: env.ADMIN_USERNAME ?? 'admin',
  adminEmail: env.ADMIN_EMAIL ?? 'admin@localhost',
  adminPassword: required('ADMIN_PASSWORD'),
};
await tx(async (db) => {
  const { organizationId } = await seedBase(db, base, (m) => console.log(m));
  if (demo) await seedDemo(db, organizationId, env.DEMO_PASSWORD ?? base.adminPassword, (m) => console.log(m));
});
if (demo && env.SEED_SIMULATE !== 'false') {
  const { simulate } = await import('../seed/simulate.js');
  const already = await (await import('../core/db.js')).query(getPool(), `select count(*)::int as n from flux.instance`);
  if (already[0]!.n === 0) {
    console.log('simulare activitate demo (poate dura câteva minute)...');
    await simulate({ password: env.DEMO_PASSWORD ?? base.adminPassword, days: Number(env.SIMULATE_DAYS ?? 150), log: (m) => console.log(m) });
  } else {
    console.log('există deja dosare; simularea nu se repetă');
  }
}
console.log('seed complete');
await closePool();
