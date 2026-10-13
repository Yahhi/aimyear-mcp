/**
 * The whole OAuth chain against the real Firebase project, in-process:
 * register → authorize (consent page) → a real Firebase ID token for a throwaway user →
 * approve → token (PKCE) → tools/call acts as that user → refresh rotation,
 * plus the refusals: reused code, wrong verifier, deny, guest account, bad token.
 * Cleans up the user, its data, its Auth record and every OAuth row it made.
 *
 *   npx tsx test/oauth-e2e.ts
 */
import { createHash, randomBytes } from 'node:crypto';
import { getAuth } from 'firebase-admin/auth';
import { startApp, rpc, call } from './helpers.js';
import { initFirestore } from '../src/store.js';
import { FirestoreOAuthProvider, FIREBASE_WEB } from '../src/oauth.js';

const db = initFirestore();
const app = await startApp({ provider: new FirestoreOAuthProvider(new URL('http://localhost:1/mcp')) });
const uid = 'oauth-e2e-' + Date.now();
const redirect = 'http://localhost:9/callback';
const failures: string[] = [];
const check = (ok: unknown, label: string) => { console.log(ok ? '  ✔' : '  ✖', label); if (!ok) failures.push(label); };
const b64url = (b: Buffer) => b.toString('base64url');
const pkce = () => { const verifier = b64url(randomBytes(32)); return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }; };
const authUsers: string[] = [uid];
let clientId = '';

async function idTokenFor(u: string) {
  const custom = await getAuth().createCustomToken(u);
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_WEB.apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
  return (await r.json()).idToken as string;
}
async function anonymousIdToken() {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_WEB.apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) });
  const j = await r.json();
  authUsers.push(j.localId);
  return j.idToken as string;
}
async function startAuthorize(challenge: string, state: string) {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state, scope: 'aimyear' });
  const r = await fetch(`${app.url}/authorize?${q}`, { redirect: 'manual' });
  const html = await r.text();
  const cfg = html.match(/<script id="cfg" type="application\/json">(.*?)<\/script>/s);
  return { status: r.status, html, rid: cfg ? JSON.parse(cfg[1]).rid as string : '' };
}
const approve = async (body: object) => {
  const r = await fetch(`${app.url}/authorize/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any };
};
const token = async (form: Record<string, string>) => {
  const r = await fetch(`${app.url}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
  return { status: r.status, json: await r.json() as any };
};

try {
  // Registration
  const bad = await fetch(`${app.url}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'x', redirect_uris: ['javascript:alert(1)'], token_endpoint_auth_method: 'none' }) });
  check(bad.status === 400, 'register refuses a javascript: redirect_uri');
  const reg = await fetch(`${app.url}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Conformance <script>', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  const client = await reg.json() as any;
  clientId = client.client_id;
  check(reg.status === 201 && clientId, 'register returns a client_id');

  // Authorize → consent page
  const p1 = pkce();
  const a1 = await startAuthorize(p1.challenge, 'state-1');
  check(a1.status === 200 && a1.rid, 'authorize shows the consent page with a request id');
  check(!a1.html.includes('<script>') || !a1.html.includes('Conformance <script>'), 'client name is escaped on the page');
  check(a1.html.includes('Conformance &lt;script&gt;'), 'client name is shown, escaped');

  // Approve with a real Firebase ID token
  const idToken = await idTokenFor(uid);
  check(!!idToken, 'Firebase issued an ID token for the test user');
  const ok = await approve({ rid: a1.rid, idToken, allow: true });
  const back = new URL(ok.json.redirect ?? 'http://x/');
  const code = back.searchParams.get('code') ?? '';
  check(ok.status === 200 && code && back.searchParams.get('state') === 'state-1' && back.origin + back.pathname === redirect, 'approve redirects back with a code and the state');
  check((await approve({ rid: a1.rid, idToken, allow: true })).status === 400, 'a consent request id works once');

  // Token
  const t1 = await token({ grant_type: 'authorization_code', code, code_verifier: p1.verifier, client_id: clientId, redirect_uri: redirect });
  check(t1.status === 200 && t1.json.access_token && t1.json.refresh_token, 'code + verifier → access and refresh tokens');
  const replay = await token({ grant_type: 'authorization_code', code, code_verifier: p1.verifier, client_id: clientId, redirect_uri: redirect });
  check(replay.status === 400 && replay.json.error === 'invalid_grant', 'a code works once');

  // The token acts as the signed-in person
  const mcp = `${app.url}/mcp`;
  const w = await rpc(mcp, call(1, 'tools/call', { name: 'set_workplace', arguments: { workplace: 'mobile' } }), { Authorization: `Bearer ${t1.json.access_token}` });
  check(w.status === 200 && !w.json?.result?.isError, 'tools/call with the access token works');
  const prof = await db.collection('users').doc(uid).collection('aim').doc('profile').get();
  check(prof.exists && prof.data()?.defaultWorkplace === 'mobile', 'the write landed in the signed-in user\'s own data');
  const badTok = await rpc(mcp, call(2, 'tools/call', { name: 'get_goal', arguments: {} }), { Authorization: 'Bearer not-a-token' });
  check(badTok.status === 401 && /invalid_token/.test(badTok.headers.get('www-authenticate') ?? ''), 'a wrong token is 401 invalid_token');

  // Refresh rotation
  const r1 = await token({ grant_type: 'refresh_token', refresh_token: t1.json.refresh_token, client_id: clientId });
  check(r1.status === 200 && r1.json.access_token && r1.json.refresh_token !== t1.json.refresh_token, 'refresh gives a new pair');
  const r2 = await token({ grant_type: 'refresh_token', refresh_token: t1.json.refresh_token, client_id: clientId });
  check(r2.status === 400, 'an old refresh token works once');

  // Wrong verifier
  const p2 = pkce();
  const a2 = await startAuthorize(p2.challenge, 'state-2');
  const ok2 = await approve({ rid: a2.rid, idToken, allow: true });
  const code2 = new URL(ok2.json.redirect).searchParams.get('code') ?? '';
  const wrong = await token({ grant_type: 'authorization_code', code: code2, code_verifier: pkce().verifier, client_id: clientId, redirect_uri: redirect });
  check(wrong.status === 400, 'a wrong PKCE verifier is refused');

  // Deny
  const a3 = await startAuthorize(pkce().challenge, 'state-3');
  const denied = await approve({ rid: a3.rid, allow: false });
  const db3 = new URL(denied.json.redirect);
  check(db3.searchParams.get('error') === 'access_denied' && db3.searchParams.get('state') === 'state-3' && !db3.searchParams.get('code'), 'deny redirects with access_denied and no code');

  // Guest (anonymous) accounts cannot be connected
  const a4 = await startAuthorize(pkce().challenge, 'state-4');
  const anon = await approve({ rid: a4.rid, idToken: await anonymousIdToken(), allow: true });
  check(anon.status === 400, 'an anonymous Firebase account is refused');

  // A forged ID token
  const a5 = await startAuthorize(pkce().challenge, 'state-5');
  check((await approve({ rid: a5.rid, idToken: 'forged', allow: true })).status === 401, 'a forged ID token is refused');
} finally {
  await db.recursiveDelete(db.collection('users').doc(uid));
  for (const coll of ['oauth_tokens', 'oauth_codes', 'oauth_requests']) {
    const snap = await db.collection(coll).where('client_id', '==', clientId || '-').get();
    await Promise.all(snap.docs.map(d => d.ref.delete()));
  }
  if (clientId) await db.collection('oauth_clients').doc(clientId).delete();
  for (const u of authUsers) await getAuth().deleteUser(u).catch(() => {});
  await app.close();
}
console.log(failures.length ? `\nFAIL: ${failures.length}` : '\nPASS: OAuth chain works end to end');
process.exit(failures.length ? 1 : 0);
