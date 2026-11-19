/**
 * Renders the weekly review email for two made-up weeks, so it can be looked at in a
 * browser: a good week (time tracking) and a quiet-numbers week with little done. Uses the
 * in-memory store from the tests and a throwaway unsubscribe key: nothing is read from
 * Firestore and nothing is sent.
 *
 *   npx tsx scripts/weekly-review-preview.ts      → tmp/weekly-review-preview*.html / .txt
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { AimService } from '../src/service.js';
import { addDays, localDate, weekStart } from '../src/dates.js';
import { composeReview } from '../src/review/deliver.js';
import { freshStore, seedGoodWeek, seedQuietWeek } from '../test/review-fixtures.js';

const today = localDate(new Date(), 'Europe/Madrid');
const week = addDays(weekStart(today), -7); // the last full week
const out = new URL('../tmp/', import.meta.url);
mkdirSync(out, { recursive: true });
const deps = { baseUrl: new URL('https://mcp.aimyear.com'), key: Buffer.alloc(32, 7) };

for (const [name, tracking, seed] of [['', 'time', seedGoodWeek], ['-quiet', 'quiet', seedQuietWeek]] as const) {
  const store = freshStore(today, tracking);
  seed(store, week);
  const mail = await composeReview(new AimService(store as any, 'preview', 'mobile'), 'preview-user', week, deps);
  const html = new URL(`weekly-review-preview${name}.html`, out);
  writeFileSync(html, mail.html);
  writeFileSync(new URL(`weekly-review-preview${name}.txt`, out), `Subject: ${mail.subject}\n\n${mail.text}\n`);
  console.log(`${html.pathname}\n  Subject: ${mail.subject}`);
}
