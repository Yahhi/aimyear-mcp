/**
 * Pro on the web (src/checkout.ts): the env switch, the signed link, the checkout page and its
 * Content-Security-Policy, get_pro_link and the pro_link on a Pro refusal, and a Paddle
 * purchase reaching src/pro.ts through RevenueCat. Paddle and RevenueCat are fakes: no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, createApp } from '../src/http.js';
import { createPro, type ProStatus } from '../src/pro.js';
import { checkoutConfig, checkoutLink, checkoutToken, verifyCheckoutToken, proOffer, LINK_TTL_MS, type CheckoutConfig } from '../src/checkout.js';
import { FirestoreOAuthProvider } from '../src/oauth.js';
import { FakeStore } from './fake-store.js';
import { rpc, call } from './helpers.js';

// Obviously fake values in the shape Paddle uses: never a real token or price.
const ENV = {
  PADDLE_ENV: 'sandbox', PADDLE_CLIENT_TOKEN: 'test_fake_client_token_0000', PADDLE_PRICE_YEARLY: 'pri_fakeyearly01', PADDLE_PRICE_MONTHLY: 'pri_fakemonthly01',
  CHECKOUT_LINK_SECRET: 'a-checkout-link-secret-for-tests-only-0123456789',
};
const cfg = () => checkoutConfig(ENV, () => {})!;
const BASE = new URL('http://localhost:1');
const NOW = new Date('2026-11-20T12:00:00Z');

test('checkoutConfig: nothing set is off and quiet; anything half set or mismatched is off with a reason', () => {
  const warned: string[] = [];
  const w = (m: string) => warned.push(m);
  assert.equal(checkoutConfig({}, w), null);
  assert.deepEqual(warned, [], 'unset: no warning, everything as before');
  assert.equal(checkoutConfig({ ...ENV, PADDLE_ENV: undefined }, w), null, 'PADDLE_ENV has no default');
  assert.equal(checkoutConfig({ ...ENV, PADDLE_ENV: 'production' }, w), null, 'a test_ token is not a live one');
  assert.equal(checkoutConfig({ ...ENV, PADDLE_CLIENT_TOKEN: 'live_x' }, w), null, 'a live_ token in sandbox');
  assert.equal(checkoutConfig({ ...ENV, PADDLE_PRICE_MONTHLY: '' }, w), null);
  assert.equal(checkoutConfig({ ...ENV, PADDLE_PRICE_MONTHLY: ENV.PADDLE_PRICE_YEARLY }, w), null);
  assert.equal(checkoutConfig({ ...ENV, CHECKOUT_LINK_SECRET: 'short' }, w), null);
  assert.equal(checkoutConfig({ ...ENV, PADDLE_APP_USER_ID_FIELD: 'bad field' }, w), null);
  assert.equal(warned.length, 7);
  assert.ok(warned.every(m => !m.includes(ENV.CHECKOUT_LINK_SECRET) && !m.includes(ENV.PADDLE_CLIENT_TOKEN)), 'warnings never print a secret');
  const c = cfg();
  assert.equal(c.env, 'sandbox');
  assert.equal(c.userIdField, 'app_user_id', 'the default RevenueCat metadata field key');
  assert.deepEqual(c.prices, { yearly: 'pri_fakeyearly01', monthly: 'pri_fakemonthly01' });
  assert.equal(checkoutConfig({ ...ENV, PADDLE_APP_USER_ID_FIELD: 'rc_user' }, w)!.userIdField, 'rc_user');
});

test('the link: signed uid and expiry, an hour long; changed, expired or foreign links name nobody', () => {
  const c = cfg();
  const link = checkoutLink(BASE, c, 'u1', NOW)!;
  assert.equal(new URL(link.url).pathname, '/pro/checkout');
  assert.equal(link.test_mode, true);
  assert.equal(Date.parse(link.expires_at) - NOW.getTime(), LINK_TTL_MS);
  const t = new URL(link.url).searchParams.get('t')!;
  assert.equal(verifyCheckoutToken(c.key, t, NOW), 'u1');
  assert.equal(verifyCheckoutToken(c.key, t, new Date(NOW.getTime() + LINK_TTL_MS - 1000)), 'u1');
  assert.equal(verifyCheckoutToken(c.key, t, new Date(NOW.getTime() + LINK_TTL_MS)), null, 'expired');
  const [, exp, sig] = t.split('.');
  assert.equal(verifyCheckoutToken(c.key, `u2.${exp}.${sig}`, NOW), null, 'another uid');
  assert.equal(verifyCheckoutToken(c.key, `u1.${Number(exp) + 3600}.${sig}`, NOW), null, 'a longer life');
  assert.equal(verifyCheckoutToken(Buffer.from('another-key-another-key-another-key'), t, NOW), null, 'another key');
  for (const bad of [undefined, '', 'u1', 'u1.1.2.3', `$RCAnonymousID:x.${exp}.${sig}`, 'x'.repeat(400)]) assert.equal(verifyCheckoutToken(c.key, bad, NOW), null, String(bad));
  assert.equal(checkoutLink(BASE, c, '$RCAnonymousID:x', NOW), null, 'only a Firebase uid gets a link');
  assert.match(checkoutToken(c.key, 'u1', NOW), /^u1\.\d+\.[\w-]+$/);
});

// ---------- the page ----------

async function startCheckoutApp(opts: { checkout?: CheckoutConfig | null; pro?: boolean; email?: string | null } = {}) {
  const stores = new Map<string, FakeStore>();
  const storeFor = (uid: string) => { if (!stores.has(uid)) stores.set(uid, new FakeStore()); return stores.get(uid)! as any; };
  const proOf = async () => opts.pro ?? false;
  const app = createApp({
    tokens: new Map([['static-token-1', 'u1']]), baseUrl: BASE, provider: new FirestoreOAuthProvider(new URL('/mcp', BASE), {} as any),
    storeFor, pro: { isPro: proOf } as any, socialDeps: { clients: {} as any, isPro: proOf },
    checkout: opts.checkout === undefined ? cfg() : opts.checkout, emailOf: async () => (opts.email === undefined ? 'u1@example.test' : opts.email),
  });
  let server!: Server;
  await new Promise<void>(r => { server = app.listen(0, () => r()); });
  const url = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { url, close: () => new Promise<void>(r => server.close(() => r())) };
}
const pathOf = (link: string) => { const u = new URL(link); return `${u.pathname}${u.search}`; };

test('GET /pro/checkout: Paddle.js in sandbox with the uid as custom data, the email prefilled, and a CSP that allows Paddle only here', async () => {
  const a = await startCheckoutApp({ email: 'u1</script><b>@example.test' });
  try {
    const link = checkoutLink(BASE, cfg(), 'u1', new Date())!;
    const r = await fetch(`${a.url}${pathOf(link.url)}`);
    assert.equal(r.status, 200);
    const html = await r.text();
    const csp = r.headers.get('content-security-policy') ?? '';
    const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
    assert.ok(nonce, csp);
    assert.match(csp, /script-src 'nonce-[^']+' https:\/\/cdn\.paddle\.com;/);
    assert.match(csp, /frame-src https:\/\/sandbox-buy\.paddle\.com;/, 'the sandbox checkout frame, not the live one');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('referrer-policy'), 'strict-origin', 'the token never leaves in a Referer');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    // Every script runs with this response's nonce.
    const scripts = [...html.matchAll(/<script([^>]*)>/g)].map(m => m[1]);
    assert.ok(scripts.every(s => s.includes(`nonce="${nonce}"`) || s.includes('type="application/json"')), scripts.join(' | '));
    assert.ok(html.includes('src="https://cdn.paddle.com/paddle/v2/paddle.js"'));
    assert.ok(html.includes("Paddle.Environment.set('sandbox')"));
    const data = JSON.parse(html.match(/<script id="cfg" type="application\/json">([\s\S]*?)<\/script>/)![1]);
    assert.deepEqual(data.customData, { app_user_id: 'u1' }, 'RevenueCat finds the uid here');
    assert.deepEqual(data.prices, { yearly: 'pri_fakeyearly01', monthly: 'pri_fakemonthly01' });
    assert.equal(data.token, 'test_fake_client_token_0000', 'the client-side token is public by design');
    assert.equal(data.email, 'u1</script><b>@example.test');
    assert.ok(!html.includes('u1</script><b>'), 'the email cannot break out of the page');
    assert.match(html, /aria-checked="true" data-plan="yearly"/, 'yearly preselected (pricing.md)');
    assert.match(html, /Test mode/);
    assert.ok(!html.includes(ENV.CHECKOUT_LINK_SECRET));
    assert.doesNotMatch(html, /\$\d/, 'no price of ours on the page: Paddle shows its own');
  } finally { await a.close(); }
});

test('GET /pro/checkout: a bad or expired link, an account with Pro, and no checkout set up get plain pages with no script', async () => {
  const a = await startCheckoutApp();
  try {
    for (const q of ['', '?t=nope', `?t=${encodeURIComponent(checkoutToken(cfg().key, 'u1', new Date(Date.now() - 1000)))}`]) {
      const r = await fetch(`${a.url}/pro/checkout${q}`);
      assert.equal(r.status, 400, q);
      assert.match(await r.text(), /Ask your agent for a new Pro link/);
      assert.doesNotMatch(r.headers.get('content-security-policy') ?? '', /paddle/);
    }
  } finally { await a.close(); }
  const pro = await startCheckoutApp({ pro: true });
  try {
    const r = await fetch(`${pro.url}${pathOf(checkoutLink(BASE, cfg(), 'u1', new Date())!.url)}`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /You already have Pro/);
    assert.ok(!html.includes('<script'));
  } finally { await pro.close(); }
  const off = await startCheckoutApp({ checkout: null });
  try {
    const r = await fetch(`${off.url}${pathOf(checkoutLink(BASE, cfg(), 'u1', new Date())!.url)}`);
    assert.equal(r.status, 404);
    assert.match(await r.text(), /not sold on the web yet/);
  } finally { await off.close(); }
});

test('no other page gets the Paddle CSP', async () => {
  const a = await startCheckoutApp();
  try {
    const r = await fetch(`${a.url}/email/unsubscribe?t=x`);
    assert.doesNotMatch(r.headers.get('content-security-policy') ?? '', /paddle/);
  } finally { await a.close(); }
});

// ---------- over MCP ----------

async function mcpClient(offer?: ReturnType<typeof proOffer>, isPro = async () => false) {
  const store = new FakeStore();
  const server = buildServer('u1', 'agent-1', 'desktop', { clients: {} as any, isPro }, { storeFor: () => store as any, proOffer: offer });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(b);
  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { ...JSON.parse((r.content as any)[0].text), isError: !!r.isError };
  };
  return { callTool, close: () => client.close() };
}

test('get_pro_link: a link for this account only; none when the user has Pro or there is no web checkout', async () => {
  const c = cfg();
  const free = await mcpClient(proOffer('u1', BASE, c, async () => false, () => NOW));
  try {
    const r = await free.callTool('get_pro_link');
    assert.equal(r.pro, false);
    assert.equal(r.test_mode, true);
    assert.equal(verifyCheckoutToken(c.key, new URL(r.url).searchParams.get('t'), NOW), 'u1');
    assert.ok(r.speak.includes(r.url));
    assert.match(r.speak, /an hour/);
  } finally { await free.close(); }
  const pro = await mcpClient(proOffer('u1', BASE, c, async () => true));
  try {
    const r = await pro.callTool('get_pro_link');
    assert.equal(r.pro, true);
    assert.equal(r.url, null);
    assert.match(r.speak, /already have AimYear Pro/);
  } finally { await pro.close(); }
  for (const offer of [proOffer('u1', BASE, null, async () => false), undefined]) {
    const off = await mcpClient(offer);
    try {
      const r = await off.callTool('get_pro_link');
      assert.equal(r.url, null);
      assert.match(r.speak, /in the AimYear app/);
    } finally { await off.close(); }
  }
});

test('a Pro refusal over MCP carries pro_link when the web checkout is set up, and is unchanged when it is not', async () => {
  const on = await mcpClient(proOffer('u1', BASE, cfg(), async () => false));
  try {
    const r = await on.callTool('add_post', {});
    assert.equal(r.isError, true);
    assert.equal(r.code, 'pro_required');
    assert.equal(verifyCheckoutToken(cfg().key, new URL(r.pro_link).searchParams.get('t'), new Date()), 'u1');
    assert.ok(r.speak.includes(r.pro_link));
  } finally { await on.close(); }
  const off = await mcpClient(proOffer('u1', BASE, null, async () => false));
  try {
    const r = await off.callTool('add_post', {});
    assert.equal(r.code, 'pro_required');
    assert.equal(r.pro_link, undefined);
    assert.equal(r.speak, r.error, 'the same refusal as before');
  } finally { await off.close(); }
});

test('through the HTTP entry point: get_pro_link on /mcp makes a link the same server opens', async () => {
  const a = await startCheckoutApp();
  try {
    const r = await rpc(`${a.url}/mcp`, call(1, 'tools/call', { name: 'get_pro_link', arguments: {} }), { Authorization: 'Bearer static-token-1' });
    assert.equal(r.status, 200);
    const out = JSON.parse(r.json.result.content[0].text);
    assert.equal(new URL(out.url).origin, BASE.origin, 'the link is on the public base URL');
    const page = await fetch(`${a.url}${pathOf(out.url)}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /"app_user_id":"u1"/);
  } finally { await a.close(); }
});

// ---------- the purchase reaches Pro through RevenueCat ----------

test('a Paddle purchase is a RevenueCat event like any store: Pro, with no new source in src/pro.ts', async () => {
  const stored = new Map<string, ProStatus>();
  const pro = createPro({
    env: {}, fetch: (async () => { throw new Error('no network in tests'); }) as any, now: () => NOW,
    getStatus: async uid => stored.get(uid) ?? null, saveStatus: async (uid, s) => { stored.set(uid, s); },
  });
  // The fields RevenueCat sends for a Paddle web purchase: store PADDLE, the uid from the custom data.
  const ev = (type: string, at: number) => ({ api_version: '1.0', event: { type, store: 'PADDLE', environment: 'SANDBOX', app_user_id: 'u1', original_app_user_id: 'u1', product_id: 'pri_fakeyearly01', entitlement_ids: ['AimYear Pro'], event_timestamp_ms: at, expiration_at_ms: Date.parse('2027-11-20T12:00:00Z') } });
  assert.deepEqual(await pro.applyWebhook(ev('INITIAL_PURCHASE', 1000)), ['u1']);
  assert.equal(await pro.isPro('u1'), true);
  assert.equal(stored.get('u1')!.source, 'revenuecat_webhook');
  await pro.applyWebhook(ev('EXPIRATION', 3000));
  assert.equal(await pro.isPro('u1'), false);
  assert.deepEqual(await pro.applyWebhook(ev('RENEWAL', 2000)), [], 'an older event never overwrites a newer one');
});
