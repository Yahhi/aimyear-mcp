/**
 * POST /paddle/webhook (src/paddle.ts): Paddle's signature, only AimYear Pro transactions
 * reach RevenueCat, other products' sales are answered 200 and ignored. Paddle and
 * RevenueCat are fakes: no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/http.js';
import { checkoutConfig } from '../src/checkout.js';
import { paddleWebhookConfig, proPurchase, verifyPaddleSignature } from '../src/paddle.js';
import { FirestoreOAuthProvider } from '../src/oauth.js';
import { FakeStore } from './fake-store.js';

// Obviously fake values in the shape Paddle and RevenueCat use.
const ENV = {
  PADDLE_ENV: 'sandbox', PADDLE_CLIENT_TOKEN: 'test_fake_client_token_0000', PADDLE_PRICE_YEARLY: 'pri_fakeyearly01', PADDLE_PRICE_MONTHLY: 'pri_fakemonthly01',
  CHECKOUT_LINK_SECRET: 'a-checkout-link-secret-for-tests-only-0123456789',
};
const cfg = () => checkoutConfig(ENV, () => {})!;
const HOOK = { secret: 'pdl_ntfset_fake_secret_for_tests', rcKey: 'fake_rc_paddle_public_key' };
const BASE = new URL('http://localhost:1');

const sign = (body: string, ts = Math.floor(Date.now() / 1000), secret = HOOK.secret) =>
  `ts=${ts};h1=${createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex')}`;
const txn = (over: { event_type?: string; price?: string; custom?: Record<string, unknown> | null } = {}) => JSON.stringify({
  event_id: 'evt_fake01', event_type: over.event_type ?? 'transaction.completed',
  data: {
    id: 'txn_fake01', status: 'completed',
    custom_data: over.custom === undefined ? { app_user_id: 'u1' } : over.custom,
    items: [{ price: { id: over.price ?? 'pri_fakeyearly01' }, quantity: 1 }],
  },
});

test('paddleWebhookConfig: off and quiet when unset, off with a warning when half set', () => {
  const warned: string[] = [];
  assert.equal(paddleWebhookConfig({}, m => warned.push(m)), null);
  assert.deepEqual(warned, []);
  assert.equal(paddleWebhookConfig({ PADDLE_WEBHOOK_SECRET: 's' }, m => warned.push(m)), null);
  assert.equal(warned.length, 1);
  assert.ok(!warned[0].includes('s;'), 'no secret in the warning');
  assert.deepEqual(paddleWebhookConfig({ PADDLE_WEBHOOK_SECRET: ' s ', REVENUECAT_PADDLE_PUBLIC_KEY: 'k' }), { secret: 's', rcKey: 'k' });
});

test('verifyPaddleSignature: the right secret and a fresh timestamp only; any h1 during a rotation', () => {
  const body = txn(), raw = Buffer.from(body), now = new Date();
  assert.ok(verifyPaddleSignature(HOOK.secret, sign(body), raw, now));
  assert.ok(!verifyPaddleSignature(HOOK.secret, sign(body, undefined, 'another'), raw, now), 'another secret');
  assert.ok(!verifyPaddleSignature(HOOK.secret, sign(body), Buffer.from(body + ' '), now), 'a changed body');
  assert.ok(!verifyPaddleSignature(HOOK.secret, sign(body, Math.floor(now.getTime() / 1000) - 600), raw, now), 'ten minutes old');
  assert.ok(!verifyPaddleSignature(HOOK.secret, undefined, raw, now));
  assert.ok(!verifyPaddleSignature(HOOK.secret, 'ts=1;h1=zz', raw, now));
  const good = sign(body).split(';h1=')[1];
  const ts = sign(body).split(';')[0];
  assert.ok(verifyPaddleSignature(HOOK.secret, `${ts};h1=${'0'.repeat(64)};h1=${good}`, raw, now), 'the second h1 matches');
});

test('proPurchase: a completed transaction with a Pro price and a usable uid; nothing else', () => {
  const c = cfg();
  assert.deepEqual(proPurchase(JSON.parse(txn()), c), { uid: 'u1', txn: 'txn_fake01' });
  assert.deepEqual(proPurchase(JSON.parse(txn({ price: 'pri_fakemonthly01' })), c), { uid: 'u1', txn: 'txn_fake01' });
  assert.equal(proPurchase(JSON.parse(txn({ price: 'pri_readyforagents_check' })), c), null, 'another product in the same Paddle account');
  assert.equal(proPurchase(JSON.parse(txn({ event_type: 'transaction.paid' })), c), null);
  assert.equal(proPurchase(JSON.parse(txn({ custom: null })), c), null, 'no uid');
  assert.equal(proPurchase(JSON.parse(txn({ custom: { project: 'readyforagents' } })), c), null);
  assert.equal(proPurchase(JSON.parse(txn({ custom: { app_user_id: 'bad uid/..' } })), c), null);
});

async function startApp(rc: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const forgot: string[] = [];
  const app = createApp({
    tokens: new Map(), baseUrl: BASE, provider: new FirestoreOAuthProvider(new URL('/mcp', BASE), {} as any),
    storeFor: () => new FakeStore() as any, pro: { isPro: async () => false, forget: (uid: string) => forgot.push(uid) } as any,
    socialDeps: { clients: {} as any, isPro: async () => false }, checkout: cfg(), emailOf: async () => null,
    paddleWebhook: HOOK,
    fetchFn: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return rc(url, init); }) as any,
  });
  let server!: Server;
  await new Promise<void>(r => { server = app.listen(0, () => r()); });
  const url = `http://localhost:${(server.address() as AddressInfo).port}/paddle/webhook`;
  const post = (body: string, signature = sign(body)) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Paddle-Signature': signature }, body });
  return { url, post, calls, forgot, close: () => new Promise<void>(r => server.close(() => r())) };
}

test('POST /paddle/webhook: a Pro purchase is posted to RevenueCat as a Paddle receipt for the uid', async () => {
  const a = await startApp(() => new Response('{}', { status: 200 }));
  try {
    const r = await a.post(txn());
    assert.equal(r.status, 200);
    assert.equal(a.calls.length, 1);
    assert.equal(a.calls[0].url, 'https://api.revenuecat.com/v1/receipts');
    const h = a.calls[0].init.headers as Record<string, string>;
    assert.equal(h.Authorization, `Bearer ${HOOK.rcKey}`);
    assert.equal(h['X-Platform'], 'paddle');
    assert.deepEqual(JSON.parse(String(a.calls[0].init.body)), { app_user_id: 'u1', fetch_token: 'txn_fake01' });
    assert.deepEqual(a.forgot, ['u1'], 'the next Pro check asks RevenueCat again');
  } finally { await a.close(); }
});

test('POST /paddle/webhook: another product\'s sale is 200 and never reaches RevenueCat', async () => {
  const a = await startApp(() => new Response('{}', { status: 200 }));
  try {
    const r = await a.post(txn({ price: 'pri_readyforagents_check', custom: { project: 'readyforagents', plan: 'check' } }));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ignored, true);
    const other = await a.post(JSON.stringify({ event_type: 'customer.created', data: { id: 'ctm_1' } }));
    assert.equal(other.status, 200);
    assert.equal(a.calls.length, 0);
  } finally { await a.close(); }
});

test('POST /paddle/webhook: a bad signature is 401; RevenueCat failing is 500 so Paddle retries', async () => {
  const a = await startApp(() => new Response('{}', { status: 503 }));
  try {
    assert.equal((await a.post(txn(), sign(txn(), undefined, 'not-the-secret'))).status, 401);
    assert.equal(a.calls.length, 0);
    assert.equal((await a.post(txn())).status, 500);
    assert.equal(a.calls.length, 1);
  } finally { await a.close(); }
});

test('GET /: the server\'s own address sends people to aimyear.com', async () => {
  const a = await startApp(() => new Response('{}', { status: 200 }));
  try {
    const r = await fetch(a.url.replace('/paddle/webhook', '/'), { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), 'https://aimyear.com/');
  } finally { await a.close(); }
});
