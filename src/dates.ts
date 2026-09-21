/** Date helpers that respect a user's IANA timezone without a library. */

const partsCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    partsCache.set(tz, f);
  }
  return f;
}

function partsOf(t: Date, tz: string) {
  const p: Record<string, number> = {};
  for (const { type, value } of fmt(tz).formatToParts(t)) if (type !== 'literal') p[type] = Number(value);
  return p;
}

/** Offset of tz from UTC at instant t, in minutes (positive east of UTC). */
export function tzOffsetMinutes(t: Date, tz: string): number {
  const p = partsOf(t, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - t.getTime()) / 60000);
}

/** YYYY-MM-DD of instant t in tz. */
export function localDate(t: Date, tz: string): string {
  const p = partsOf(t, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** HH:MM of instant t in tz. */
export function localTime(t: Date, tz: string): string {
  const p = partsOf(t, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** Instant of local midnight starting the given YYYY-MM-DD in tz. */
export function startOfDay(date: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const off1 = tzOffsetMinutes(new Date(guess), tz);
  let t = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(new Date(t), tz);
  if (off2 !== off1) t = guess - off2 * 60000;
  return new Date(t);
}

export function endOfDay(date: string, tz: string): Date {
  return startOfDay(addDays(date, 1), tz);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Monday of the week containing date. */
export function weekStart(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(date, dow === 0 ? -6 : 1 - dow);
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 60000));
}
