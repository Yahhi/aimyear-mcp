/**
 * One-click unsubscribe from the weekly review email (RFC 8058). The link carries the uid
 * and an HMAC of it, so it works without signing in and nobody can turn off someone
 * else's email. The key is AIMYEAR_UNSUBSCRIBE_KEY when set, else one derived (HKDF) from
 * AIMYEAR_SOCIAL_KEY, the server secret that already exists, under its own label, so the
 * two uses never share a key. Without either, no review is sent: every email needs a
 * working unsubscribe link.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { usableUid } from '../pro.js';

export function unsubscribeKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const own = env.AIMYEAR_UNSUBSCRIBE_KEY?.trim();
  if (own) return own.length >= 32 ? Buffer.from(own, 'utf8') : null;
  const social = Buffer.from(env.AIMYEAR_SOCIAL_KEY ?? '', 'base64');
  if (social.length !== 32) return null;
  return Buffer.from(hkdfSync('sha256', social, Buffer.from('aimyear'), Buffer.from('aimyear-unsubscribe:v1'), 32));
}

const sig = (key: Buffer, uid: string) => createHmac('sha256', key).update(`weekly_review_email:${uid}`).digest('base64url');

export const unsubscribeToken = (key: Buffer, uid: string) => `${uid}.${sig(key, uid)}`;

/** The uid a token was made for, or null when it is not one of ours. */
export function verifyUnsubscribeToken(key: Buffer, token: unknown): string | null {
  if (typeof token !== 'string' || token.length > 300) return null;
  const i = token.lastIndexOf('.');
  if (i <= 0) return null;
  const uid = token.slice(0, i), got = Buffer.from(token.slice(i + 1));
  if (!usableUid(uid)) return null;
  const want = Buffer.from(sig(key, uid));
  return got.length === want.length && timingSafeEqual(got, want) ? uid : null;
}

export const unsubscribeUrl = (base: URL, key: Buffer, uid: string) => {
  const u = new URL('/email/unsubscribe', base);
  u.searchParams.set('t', unsubscribeToken(key, uid));
  return u.href;
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The tiny pages behind the link: a confirm button (GET), done (POST), or a bad link. */
export function unsubscribePage(kind: 'confirm' | 'done' | 'invalid', token = ''): string {
  const body = kind === 'confirm'
    ? `<h1>Stop the weekly review email?</h1><p>AimYear will stop sending the Sunday evening review of your week. Your record stays as it is.</p>
<form method="post"><input type="hidden" name="t" value="${esc(token)}"><button type="submit">Stop the weekly review</button></form>`
    : kind === 'done'
      ? `<h1>Done</h1><p>No more weekly review emails. To get them again, turn on &ldquo;Weekly review email&rdquo; in the AimYear app (Profile, Settings), or ask your agent.</p>`
      : `<h1>This link doesn't work</h1><p>It may be cut short or changed. Turn off &ldquo;Weekly review email&rdquo; in the AimYear app (Profile, Settings), or ask your agent to turn it off.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark"><title>AimYear weekly review</title>
<style>body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F2F3F7;color:#141828}
main{max-width:440px;margin:12vh auto;padding:28px;background:#fff;border-radius:14px}h1{font-size:22px;margin:0 0 8px}p{color:#5A6173;margin:0 0 20px}
button{font:inherit;font-weight:600;padding:10px 18px;border:0;border-radius:10px;background:#141828;color:#fff;cursor:pointer}
@media (prefers-color-scheme:dark){body{background:#0B0E1A;color:#E6EAF5}main{background:#151A2B}p{color:#A8AEC4}button{background:#E6EAF5;color:#141828}}</style>
</head><body><main>${body}</main></body></html>`;
}
