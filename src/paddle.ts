/**
 * Paddle's notification for a paid AimYear Pro transaction, posted to RevenueCat by us.
 *
 * Why: one Paddle account sells AimYear Pro, Ready for Agents and the worklore kit. In
 * RevenueCat's "Automatic" tracking every Paddle transaction became a RevenueCat purchase,
 * and RevenueCat answered 500 to the other products' transaction.completed (seen
 * 2026-11-21: Paddle retried a Ready for Agents order three times, then marked it failed).
 * So RevenueCat's Paddle config uses "Manual" tracking: it creates a purchase only from
 * POST /v1/receipts, and keeps that purchase current from Paddle's notifications by itself
 * (renewals, cancellations, refunds). Other products' notifications get a 200 and nothing
 * else.
 *
 * This file is the "Manual" half: POST /paddle/webhook (our own Paddle notification
 * destination, event transaction.completed) checks Paddle's signature, keeps only
 * transactions that carry an AimYear Pro price (PADDLE_PRICE_YEARLY / _MONTHLY) and the
 * uid in custom data (src/checkout.ts puts it there), and posts {app_user_id: uid,
 * fetch_token: txn_…} to RevenueCat. Anything else is answered 200 and ignored, so Paddle
 * never retries another product's sale here.
 *
 * Env:
 *  PADDLE_WEBHOOK_SECRET          the destination's secret key (Paddle → Developer tools →
 *                                 Notifications → the destination → Secret key)
 *  REVENUECAT_PADDLE_PUBLIC_KEY   the public API key of RevenueCat's Paddle app (RevenueCat →
 *                                 Web → the Paddle config → Public API Key)
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { usableUid } from './pro.js';
import type { CheckoutConfig } from './checkout.js';

const RC_RECEIPTS = 'https://api.revenuecat.com/v1/receipts';
/** How old a signed notification may be. Paddle signs every attempt and replay afresh. */
export const SIGNATURE_TOLERANCE_S = 300;

export interface PaddleWebhookConfig { secret: string; rcKey: string }

/** The webhook's settings, or null when they are not set (then POST /paddle/webhook answers 404). */
export function paddleWebhookConfig(env: Record<string, string | undefined> = process.env, warn: (m: string) => void = m => console.error(`[paddle] ${m}`)): PaddleWebhookConfig | null {
  const secret = env.PADDLE_WEBHOOK_SECRET?.trim() || '';
  const rcKey = env.REVENUECAT_PADDLE_PUBLIC_KEY?.trim() || '';
  if (!secret && !rcKey) return null;
  if (!secret || !rcKey) { warn('webhook off: set both PADDLE_WEBHOOK_SECRET and REVENUECAT_PADDLE_PUBLIC_KEY'); return null; }
  return { secret, rcKey };
}

/**
 * Paddle-Signature: "ts=<unix seconds>;h1=<hex HMAC-SHA256 of `${ts}:${raw body}`>". During a
 * secret rotation there can be more than one h1; any match is enough.
 */
export function verifyPaddleSignature(secret: string, header: string | undefined, raw: Buffer, now: Date, toleranceS = SIGNATURE_TOLERANCE_S): boolean {
  if (!header || header.length > 2000) return false;
  let ts = '';
  const sigs: string[] = [];
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 'ts') ts = v;
    else if (k === 'h1') sigs.push(v);
  }
  if (!/^\d{1,12}$/.test(ts) || !sigs.length) return false;
  if (Math.abs(now.getTime() / 1000 - Number(ts)) > toleranceS) return false;
  const want = createHmac('sha256', secret).update(`${ts}:`).update(raw).digest();
  return sigs.some(s => {
    if (!/^[0-9a-f]{64}$/i.test(s)) return false;
    return timingSafeEqual(Buffer.from(s, 'hex'), want);
  });
}

export interface ProPurchase { uid: string; txn: string }

/** The AimYear Pro purchase in a Paddle notification, or null for anything else. */
export function proPurchase(event: unknown, cfg: CheckoutConfig): ProPurchase | null {
  const e = event as { event_type?: unknown; data?: { id?: unknown; status?: unknown; custom_data?: Record<string, unknown> | null; items?: { price?: { id?: unknown } | null; price_id?: unknown }[] } };
  if (e?.event_type !== 'transaction.completed') return null;
  const d = e.data;
  if (!d || typeof d.id !== 'string' || !/^txn_[a-z0-9]+$/i.test(d.id)) return null;
  const ours = new Set([cfg.prices.yearly, cfg.prices.monthly]);
  const items = Array.isArray(d.items) ? d.items : [];
  if (!items.some(i => ours.has(String(i?.price?.id ?? i?.price_id ?? '')))) return null;
  const uid = d.custom_data?.[cfg.userIdField];
  if (!usableUid(uid)) return null;
  return { uid, txn: d.id };
}

/** Tells RevenueCat about the purchase. Throws when RevenueCat does not take it, so Paddle retries. */
export async function postReceipt(f: typeof fetch, rcKey: string, p: ProPurchase): Promise<void> {
  const r = await f(RC_RECEIPTS, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rcKey}`, 'X-Platform': 'paddle', 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ app_user_id: p.uid, fetch_token: p.txn }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`RevenueCat answered ${r.status}`);
}
