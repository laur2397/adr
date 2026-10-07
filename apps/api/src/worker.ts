import { closePool } from './core/db.js';
import { processOutboxOnce, runDeadlineScan } from './jobs/runner.js';
import { pollMailbox } from './integrations/mail/intake.js';

const OUTBOX_INTERVAL_MS = Number(process.env.OUTBOX_INTERVAL_MS ?? 2000);
const DEADLINE_INTERVAL_MS = Number(process.env.DEADLINE_INTERVAL_MS ?? 15 * 60_000);
let stopping = false;

async function loop() {
  while (!stopping) {
    try {
      const n = await processOutboxOnce();
      if (n) console.log(JSON.stringify({ msg: 'outbox', processed: n }));
    } catch (err) {
      console.error(err);
    }
    await new Promise((r) => setTimeout(r, OUTBOX_INTERVAL_MS));
  }
}

async function deadlines() {
  try {
    console.log(JSON.stringify({ msg: 'deadline scan', ...(await runDeadlineScan()) }));
  } catch (err) {
    console.error(err);
  }
}

async function mail() {
  try {
    const n = await pollMailbox();
    if (n) console.log(JSON.stringify({ msg: 'mail intake', queued: n }));
  } catch (err) {
    console.error('mail intake failed', err);
  }
}
const mailTimer = process.env.IMAP_URL ? setInterval(mail, Number(process.env.MAIL_INTERVAL_MS ?? 120_000)) : null;
const timer = setInterval(deadlines, DEADLINE_INTERVAL_MS);
void deadlines();
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    stopping = true;
    clearInterval(timer);
    if (mailTimer) clearInterval(mailTimer);
    await closePool();
    process.exit(0);
  });
}
await loop();
