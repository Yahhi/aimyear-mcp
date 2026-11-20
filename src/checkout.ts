/**
 * Pro on the web, for someone who uses AimYear only through their agent (docs/pricing.md,
 * "Where Pro is bought"): a Paddle checkout behind a short-lived signed link.
 *
 * The purchase is kept by RevenueCat, like the app's: RevenueCat's Paddle integration
 * (Web → Paddle, "Track new purchases from server-to-server notifications", "Metadata field
 * key" = PADDLE_APP_USER_ID_FIELD) reads the RevenueCat app user id from the transaction's
 * custom data. The checkout puts the Firebase uid there, so the purchase lands on the same
 * RevenueCat customer as the app's, and src/pro.ts needs no new source: the REST check and
 * POST /revenuecat/webhook see it like any store purchase.
 *
 * The link: GET /pro/checkout?t=<uid>.<expiry, unix seconds>.<HMAC>, made by get_pro_link
 * (and added to an MCP Pro refusal as pro_link). The page loads Paddle.js and opens the
 * overlay checkout for the chosen price. No sign-in on the page: the link is the proof,
 * it works for LINK_TTL_MS, and it only ever buys for the uid inside it.
 *
 * Env (all needed, else there is no web checkout and everything behaves as before):
 *  PADDLE_ENV            sandbox | production (no default: a sandbox checkout on a live
 *                        server would hand out Pro for a test card)
 *  PADDLE_CLIENT_TOKEN   the client-side token (test_… for sandbox, live_… for production)
 *  PADDLE_PRICE_YEARLY   pri_… of Pro yearly
 *  PADDLE_PRICE_MONTHLY  pri_… of Pro monthly
 *  CHECKOUT_LINK_SECRET  32+ characters, the HMAC key for the links (a secret)
 *  PADDLE_APP_USER_ID_FIELD  optional, default app_user_id: the custom data key, the same
 *                        text as RevenueCat's "Metadata field key"
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { usableUid } from './pro.js';

export const LINK_TTL_MS = 60 * 60_000;
export const DEFAULT_USER_ID_FIELD = 'app_user_id';

export type PaddleEnv = 'sandbox' | 'production';
export interface CheckoutConfig {
  env: PaddleEnv;
  clientToken: string;
  prices: { yearly: string; monthly: string };
  key: Buffer;
  userIdField: string;
}

/** The web checkout's settings, or null when any of them is missing or does not fit. */
export function checkoutConfig(env: Record<string, string | undefined> = process.env, warn: (m: string) => void = m => console.error(`[checkout] ${m}`)): CheckoutConfig | null {
  const v = (k: string) => env[k]?.trim() || '';
  const [mode, clientToken, yearly, monthly, secret] = ['PADDLE_ENV', 'PADDLE_CLIENT_TOKEN', 'PADDLE_PRICE_YEARLY', 'PADDLE_PRICE_MONTHLY', 'CHECKOUT_LINK_SECRET'].map(v);
  if (!mode && !clientToken && !yearly && !monthly && !secret) return null; // not set up: quiet
  const off = (why: string) => { warn(`web checkout off: ${why}`); return null; };
  if (mode !== 'sandbox' && mode !== 'production') return off('PADDLE_ENV must be sandbox or production');
  if (!clientToken.startsWith(mode === 'sandbox' ? 'test_' : 'live_')) return off(`PADDLE_CLIENT_TOKEN is not a ${mode} client-side token`);
  if (!/^pri_[a-z0-9]+$/i.test(yearly) || !/^pri_[a-z0-9]+$/i.test(monthly)) return off('PADDLE_PRICE_YEARLY and PADDLE_PRICE_MONTHLY must be Paddle price ids (pri_…)');
  if (yearly === monthly) return off('the yearly and monthly prices are the same id');
  if (secret.length < 32) return off('CHECKOUT_LINK_SECRET must be 32 characters or more');
  const userIdField = v('PADDLE_APP_USER_ID_FIELD') || DEFAULT_USER_ID_FIELD;
  if (!/^[A-Za-z0-9_]{1,64}$/.test(userIdField)) return off('PADDLE_APP_USER_ID_FIELD must be letters, digits or _');
  return { env: mode, clientToken, prices: { yearly, monthly }, key: Buffer.from(secret, 'utf8'), userIdField };
}

const sig = (key: Buffer, uid: string, exp: number) => createHmac('sha256', key).update(`pro_checkout:v1:${uid}:${exp}`).digest('base64url');

export function checkoutToken(key: Buffer, uid: string, expiresAt: Date): string {
  const exp = Math.floor(expiresAt.getTime() / 1000);
  return `${uid}.${exp}.${sig(key, uid, exp)}`;
}

/** The uid a link was made for, or null when it is not one of ours or has expired. */
export function verifyCheckoutToken(key: Buffer, token: unknown, now: Date): string | null {
  if (typeof token !== 'string' || token.length > 300) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [uid, expText, got] = parts;
  if (!usableUid(uid) || !/^\d{1,12}$/.test(expText)) return null;
  const exp = Number(expText);
  const want = Buffer.from(sig(key, uid, exp)), have = Buffer.from(got);
  if (have.length !== want.length || !timingSafeEqual(have, want)) return null;
  return exp * 1000 > now.getTime() ? uid : null;
}

export interface ProLink { url: string; expires_at: string; test_mode: boolean }

export function checkoutLink(base: URL, cfg: CheckoutConfig, uid: string, now: Date): ProLink | null {
  if (!usableUid(uid)) return null;
  const expiresAt = new Date(now.getTime() + LINK_TTL_MS);
  const u = new URL('/pro/checkout', base);
  u.searchParams.set('t', checkoutToken(cfg.key, uid, expiresAt));
  return { url: u.href, expires_at: new Date(Math.floor(expiresAt.getTime() / 1000) * 1000).toISOString(), test_mode: cfg.env === 'sandbox' };
}

const PADDLE_JS = 'https://cdn.paddle.com/paddle/v2/paddle.js';
const FRAME = { sandbox: 'https://sandbox-buy.paddle.com', production: 'https://buy.paddle.com' } as const;

/**
 * The checkout page's Content-Security-Policy: Paddle.js from cdn.paddle.com, its overlay
 * frame from the environment's buy.paddle.com host, its API calls to *.paddle.com; our own
 * inline scripts only with this response's nonce. Nothing else, and never framed.
 */
export function checkoutCsp(env: PaddleEnv, nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' https://cdn.paddle.com`,
    "style-src 'unsafe-inline' https://cdn.paddle.com",
    'img-src data: https://cdn.paddle.com https://*.paddle.com',
    'font-src https://cdn.paddle.com',
    'connect-src https://*.paddle.com',
    `frame-src ${FRAME[env]}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
/** The other pages (expired link, already Pro, not set up) run no script at all. */
export const PLAIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const newNonce = () => randomBytes(16).toString('base64');

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const STYLE = `:root{--bg:#faf8f5;--card:#fff;--fg:#1d1b19;--muted:#6b665f;--line:#e6e1da;--accent:#2f6b4f;--accent-fg:#fff;--warn:#fff4d6}
@media (prefers-color-scheme:dark){:root{--bg:#161514;--card:#1f1e1c;--fg:#f1eee9;--muted:#a39d94;--line:#34312d;--accent:#5fae86;--accent-fg:#0d1a13;--warn:#3a3220}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
main{background:var(--card);border:1px solid var(--line);border-radius:16px;max-width:420px;width:100%;padding:28px}
h1{font-size:22px;margin:0 0 6px}p{margin:0 0 16px;color:var(--muted)}b{color:var(--fg)}a{color:var(--accent)}
.test{background:var(--warn);border-radius:10px;padding:10px 12px;font-size:14px;color:var(--fg)}
.plan{display:flex;justify-content:space-between;align-items:center;width:100%;min-height:56px;margin-bottom:10px;padding:0 16px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--fg);font:inherit;cursor:pointer;text-align:left}
.plan[aria-checked="true"]{border:2px solid var(--accent)}.plan .price{color:var(--muted)}.tag{font-size:12px;color:var(--accent);font-weight:600;margin-left:6px}
button.go{width:100%;min-height:48px;border:0;border-radius:12px;background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:600;cursor:pointer;margin-top:6px}
button.go:disabled{opacity:.6;cursor:default}.small{font-size:13px}.err{color:#c0392b}.hide{display:none}`;

function shell(title: string, body: string, head = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title><style>${STYLE}</style>${head}</head>
<body><main>${body}</main></body></html>`;
}

const PRO_IS = 'Pro is AimYear working for you: notifications and reminders, the weekly review it writes from your record, and posting your progress to WIP and Bluesky.';
const LEGAL = '<p class="small">By paying you agree to the <a href="https://aimyear.com/terms.html">terms</a>. <a href="https://aimyear.com/privacy.html">Privacy</a>. <a href="https://aimyear.com/refunds.html">Refunds</a>: 30 days, any reason. Paddle handles the payment and sends the receipt.</p>';

/** The pages without a checkout: a link that does not work, an account that already has Pro, no web checkout set up. */
export function checkoutInfoPage(kind: 'invalid' | 'pro' | 'off'): string {
  if (kind === 'pro') return shell('AimYear Pro', '<h1>You already have Pro</h1><p>This account already has AimYear Pro, so there is nothing to buy. Go back to your agent: Pro works there and in the app.</p>');
  if (kind === 'off') return shell('AimYear Pro', '<h1>Pro is not sold on the web yet</h1><p>Get AimYear Pro in the AimYear app (App Store or Google Play) for now.</p>');
  return shell('AimYear Pro', '<h1>This link doesn\'t work</h1><p>It has expired (links work for an hour) or was cut short. Ask your agent for a new Pro link.</p>');
}

/** The checkout page: pick yearly (preselected, docs/pricing.md) or monthly, then Paddle's overlay checkout. */
export function checkoutPage(cfg: CheckoutConfig, uid: string, email: string | null, nonce: string): string {
  const data = JSON.stringify({
    env: cfg.env, token: cfg.clientToken, prices: cfg.prices, email,
    customData: { [cfg.userIdField]: uid },
  }).replace(/</g, '\\u003c');
  const test = cfg.env === 'sandbox'
    ? '<p class="test"><b>Test mode</b> (Paddle sandbox): no real money is taken. Pay with card 4242 4242 4242 4242, any future date, any 3-digit code.</p>'
    : '';
  const who = email ? `For the account <b>${esc(email)}</b>.` : 'For the AimYear account you use with your agent.';
  const body = `<h1>Get AimYear Pro</h1>
<p>${PRO_IS}</p>
${test}
<p>${who} The same Pro as in the app, on every device.</p>
<section id="pick">
<div role="radiogroup" aria-label="Plan">
<button class="plan" type="button" role="radio" aria-checked="true" data-plan="yearly"><span>Yearly<span class="tag">Best value</span></span><span class="price" id="price-yearly"></span></button>
<button class="plan" type="button" role="radio" aria-checked="false" data-plan="monthly"><span>Monthly</span><span class="price" id="price-monthly"></span></button>
</div>
<button class="go" id="go" type="button" disabled>Continue to payment</button>
<p id="msg" class="err small" role="alert"></p>
${LEGAL}
</section>
<section id="done" class="hide"><h1>Thank you</h1><p>Pro turns on for your account in a minute or two, in the app and with your agent. You can close this page and go back to your agent.</p></section>
<script id="cfg" type="application/json">${data}</script>
<script nonce="${nonce}">history.replaceState(null, '', location.pathname);</script>
<script nonce="${nonce}" src="${PADDLE_JS}"></script>
<script nonce="${nonce}">
(function () {
  var cfg = JSON.parse(document.getElementById('cfg').textContent);
  var $ = function (id) { return document.getElementById(id); };
  var plan = 'yearly';
  var say = function (t) { $('msg').textContent = t || ''; };
  if (!window.Paddle) { say('The payment page could not load. Check your connection and reload.'); return; }
  document.querySelectorAll('.plan').forEach(function (b) {
    b.onclick = function () {
      plan = b.getAttribute('data-plan');
      document.querySelectorAll('.plan').forEach(function (x) { x.setAttribute('aria-checked', String(x === b)); });
    };
  });
  if (cfg.env === 'sandbox') Paddle.Environment.set('sandbox');
  Paddle.Initialize({
    token: cfg.token,
    eventCallback: function (e) {
      if (e && e.name === 'checkout.completed') { $('pick').classList.add('hide'); $('done').classList.remove('hide'); }
      if (e && e.name === 'checkout.error') say('The checkout could not open. Reload the page and try again.');
    },
  });
  // Show Paddle's own prices (localized), never a number of ours.
  Paddle.PricePreview({ items: [{ priceId: cfg.prices.yearly, quantity: 1 }, { priceId: cfg.prices.monthly, quantity: 1 }] })
    .then(function (r) {
      (r.data.details.lineItems || []).forEach(function (li) {
        var key = li.price.id === cfg.prices.yearly ? 'yearly' : li.price.id === cfg.prices.monthly ? 'monthly' : null;
        if (key) $('price-' + key).textContent = li.formattedTotals.total + (key === 'yearly' ? ' a year' : ' a month');
      });
    }).catch(function () { /* the checkout shows the price anyway */ });
  $('go').disabled = false;
  $('go').onclick = function () {
    say();
    var open = { items: [{ priceId: cfg.prices[plan], quantity: 1 }], customData: cfg.customData, settings: { displayMode: 'overlay', variant: 'one-page' } };
    if (cfg.email) open.customer = { email: cfg.email };
    Paddle.Checkout.open(open);
  };
})();
</script>`;
  return shell('Get AimYear Pro', body);
}

/** What the MCP tools need for one signed-in person: are they Pro, and a fresh link (null: no web checkout). */
export interface ProOffer { isPro: () => Promise<boolean>; link: () => ProLink | null }

export function proOffer(uid: string, base: URL, cfg: CheckoutConfig | null, isPro: (uid: string) => Promise<boolean>, now: () => Date = () => new Date()): ProOffer {
  return { isPro: () => isPro(uid), link: () => (cfg ? checkoutLink(base, cfg, uid, now()) : null) };
}
