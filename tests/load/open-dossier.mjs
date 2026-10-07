// Acceptance criterion 6: opening a dossier takes under 1 second with 200 simultaneous users.
// Usage: node tests/load/open-dossier.mjs <base-url> <username> <password> [users=200] [seconds=30] [thinkMs=0]
// The user must be able to see dossiers (e.g. director or auditor). Each virtual user has its own
// session and opens random dossiers; thinkMs is the average pause between two openings
// (0 = back to back, far harsher than 200 people actually working).
const [base = 'http://localhost:3000', username = 'director', password, users = '200', seconds = '30', thinkMs = '0'] = process.argv.slice(2);
if (!password) {
  console.error('usage: node tests/load/open-dossier.mjs <base-url> <username> <password> [users] [seconds]');
  process.exit(2);
}
const api = `${base.replace(/\/$/, '')}/api/v1`;

async function login() {
  const res = await fetch(`${api}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-flux-csrf': '1' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return res.headers.get('set-cookie').split(';')[0];
}

const cookies = [];
for (let i = 0; i < Number(users); i += 20) cookies.push(...(await Promise.all(Array.from({ length: Math.min(20, Number(users) - i) }, login))));
const list = await (await fetch(`${api}/instances?limit=500`, { headers: { cookie: cookies[0] } })).json();
const ids = list.items.map((i) => i.id);
if (!ids.length) throw new Error('no dossiers visible to this user');

const latencies = [];
let errors = 0;
const end = Date.now() + Number(seconds) * 1000;
await Promise.all(
  cookies.map(async (cookie) => {
    while (Date.now() < end) {
      const id = ids[Math.floor(Math.random() * ids.length)];
      const t0 = performance.now();
      const res = await fetch(`${api}/instances/${id}`, { headers: { cookie } });
      await res.arrayBuffer();
      const ms = performance.now() - t0;
      if (res.ok) latencies.push(ms);
      else errors++;
      if (Number(thinkMs)) await new Promise((r) => setTimeout(r, Number(thinkMs) * (0.5 + Math.random())));
    }
  }),
);
latencies.sort((a, b) => a - b);
const p = (q) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))].toFixed(0);
const result = {
  users: Number(users),
  thinkMs: Number(thinkMs),
  seconds: Number(seconds),
  dossiers: ids.length,
  requests: latencies.length,
  errors,
  throughputPerSecond: (latencies.length / Number(seconds)).toFixed(1),
  p50ms: p(0.5),
  p95ms: p(0.95),
  p99ms: p(0.99),
  maxMs: latencies.at(-1).toFixed(0),
};
console.log(JSON.stringify(result, null, 2));
process.exit(errors === 0 && Number(result.p95ms) < 1000 ? 0 : 1);
