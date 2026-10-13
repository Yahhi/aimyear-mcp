/**
 * OAuth 2.1 for the remote MCP endpoint, with Firebase as the sign-in.
 *
 * The MCP SDK's router (mcpAuthRouter) serves the protocol: the discovery documents,
 * dynamic client registration, /authorize, /token (PKCE checked there) and /revoke.
 * This file is the part it leaves to us:
 *  - storage, in Firestore (clients, pending requests, codes, tokens; codes and tokens
 *    are stored only as SHA-256 hashes);
 *  - the sign-in and consent page. It signs the person in with the same Firebase project
 *    as the AimYear app (Google, Apple, email), so the connector and the app share one
 *    account and one history;
 *  - POST /authorize/approve, where a fresh Firebase ID token turns into a one-time code.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidTokenError, InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { initFirestore } from './store.js';

export const SCOPE = 'aimyear';
const ACCESS_TTL_S = 60 * 60;            // 1 hour
const REFRESH_TTL_S = 60 * 60 * 24 * 60; // 60 days, rotated on every use
const CODE_TTL_S = 5 * 60;
const REQUEST_TTL_S = 15 * 60;            // time to sign in on the consent page

const C = { clients: 'oauth_clients', requests: 'oauth_requests', codes: 'oauth_codes', tokens: 'oauth_tokens' };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const nowS = () => Math.floor(Date.now() / 1000);

/** Public Firebase web config: the same values the app ships in firebase_options.dart. */
export interface FirebaseWebConfig { apiKey: string; authDomain: string; projectId: string; appId: string }
export const FIREBASE_WEB: FirebaseWebConfig = {
  apiKey: process.env.AIMYEAR_FIREBASE_API_KEY ?? 'AIzaSyCo-SsqGvwWlumLYJVCgDgjgUR_rwOw6ik',
  authDomain: process.env.AIMYEAR_FIREBASE_AUTH_DOMAIN ?? 'aimyear-app.firebaseapp.com',
  projectId: process.env.AIMYEAR_PROJECT ?? 'aimyear-app',
  appId: process.env.AIMYEAR_FIREBASE_APP_ID ?? '1:688197867396:web:63a12906e6bbaffe3aefd1',
};

/** redirect_uri rules: https, loopback http (CLI clients), or an app's own scheme. */
export function redirectUriAllowed(uri: string): boolean {
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  return !['javascript:', 'data:', 'file:', 'blob:', 'vbscript:', 'about:'].includes(u.protocol);
}

interface PendingRequest {
  client_id: string; client_name: string; redirect_uri: string; code_challenge: string;
  state?: string; scopes: string[]; resource?: string; expires: number;
}
interface CodeRow { client_id: string; uid: string; redirect_uri: string; code_challenge: string; scopes: string[]; resource?: string; expires: number }
interface TokenRow { type: 'access' | 'refresh'; client_id: string; uid: string; scopes: string[]; resource?: string; expires: number; created: string }

export class FirestoreOAuthProvider implements OAuthServerProvider {
  private db: Firestore;
  constructor(private resourceUrl: URL, db?: Firestore) { this.db = db ?? initFirestore(); }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (id: string) => {
        if (!id || id.length > 200) return undefined;
        const snap = await this.db.collection(C.clients).doc(id).get();
        return snap.exists ? (snap.data() as OAuthClientInformationFull) : undefined;
      },
      registerClient: async (client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) => {
        const bad = (client.redirect_uris ?? []).filter(u => !redirectUriAllowed(String(u)));
        if (!client.redirect_uris?.length || bad.length) throw new InvalidClientMetadataError(`redirect_uris must be https, loopback http or an app scheme: ${bad.join(', ')}`);
        if ((client.client_name ?? '').length > 100) throw new InvalidClientMetadataError('client_name is longer than 100 characters');
        const full = { ...client, client_id: (client as any).client_id ?? randomUUID(), client_id_issued_at: (client as any).client_id_issued_at ?? nowS() } as OAuthClientInformationFull;
        await this.db.collection(C.clients).doc(full.client_id).set(JSON.parse(JSON.stringify(full)));
        return full;
      },
    };
  }

  /** Shows the sign-in + consent page. The page carries only a request id, never the parameters. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const rid = secret();
    const row: PendingRequest = {
      client_id: client.client_id, client_name: client.client_name || 'An AI app', redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge, state: params.state, scopes: params.scopes?.length ? params.scopes : [SCOPE],
      resource: params.resource?.href, expires: nowS() + REQUEST_TTL_S,
    };
    await this.db.collection(C.requests).doc(sha(rid)).set(JSON.parse(JSON.stringify(row)));
    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' });
    res.send(consentPage(rid, row.client_name, new URL(params.redirectUri).host));
  }

  /** POST /authorize/approve {rid, idToken, allow}. Returns where the page should go next. */
  async approve(req: Request, res: Response): Promise<void> {
    res.set('Cache-Control', 'no-store');
    const { rid, idToken, allow } = (req.body ?? {}) as { rid?: string; idToken?: string; allow?: boolean };
    if (typeof rid !== 'string' || !rid) { res.status(400).json({ error: 'missing request id' }); return; }
    const ref = this.db.collection(C.requests).doc(sha(rid));
    const snap = await ref.get();
    const pending = snap.data() as PendingRequest | undefined;
    if (!pending || pending.expires < nowS()) { res.status(400).json({ error: 'This sign-in link expired. Go back to your AI app and connect again.' }); return; }
    const back = new URL(pending.redirect_uri);
    if (pending.state) back.searchParams.set('state', pending.state);
    if (allow !== true) {
      await ref.delete();
      back.searchParams.set('error', 'access_denied');
      res.json({ redirect: back.href });
      return;
    }
    let uid: string;
    try {
      const decoded = await getAuth().verifyIdToken(String(idToken ?? ''), true);
      if (decoded.firebase?.sign_in_provider === 'anonymous') { res.status(400).json({ error: 'Sign in with Google, Apple or email: a guest account cannot be connected.' }); return; }
      uid = decoded.uid;
    } catch {
      res.status(401).json({ error: 'Sign-in could not be verified. Try again.' });
      return;
    }
    await ref.delete();
    const code = secret();
    const row: CodeRow = { client_id: pending.client_id, uid, redirect_uri: pending.redirect_uri, code_challenge: pending.code_challenge, scopes: pending.scopes, resource: pending.resource, expires: nowS() + CODE_TTL_S };
    await this.db.collection(C.codes).doc(sha(code)).set(JSON.parse(JSON.stringify(row)));
    back.searchParams.set('code', code);
    res.json({ redirect: back.href });
  }

  private async codeRow(client: OAuthClientInformationFull, code: string): Promise<CodeRow> {
    const snap = await this.db.collection(C.codes).doc(sha(code)).get();
    const row = snap.data() as CodeRow | undefined;
    if (!row || row.client_id !== client.client_id || row.expires < nowS()) throw new InvalidGrantError('Invalid or expired authorization code');
    return row;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return (await this.codeRow(client, code)).code_challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const row = await this.codeRow(client, code);
    if (redirectUri !== undefined && redirectUri !== row.redirect_uri) throw new InvalidGrantError('redirect_uri does not match the authorization request');
    await this.db.collection(C.codes).doc(sha(code)).delete(); // one use only
    return this.issue(client.client_id, row.uid, row.scopes, row.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    const ref = this.db.collection(C.tokens).doc(sha(refreshToken));
    const row = (await ref.get()).data() as TokenRow | undefined;
    if (!row || row.type !== 'refresh' || row.client_id !== client.client_id || row.expires < nowS()) throw new InvalidGrantError('Invalid or expired refresh token');
    if (scopes?.some(s => !row.scopes.includes(s))) throw new InvalidGrantError('Refresh cannot widen the scope');
    await ref.delete(); // rotation: a refresh token works once
    return this.issue(client.client_id, row.uid, scopes?.length ? scopes : row.scopes, row.resource);
  }

  private async issue(clientId: string, uid: string, scopes: string[], resource?: string): Promise<OAuthTokens> {
    const access = secret(), refresh = secret(), created = new Date().toISOString();
    const base = { client_id: clientId, uid, scopes, resource, created };
    const batch = this.db.batch();
    batch.set(this.db.collection(C.tokens).doc(sha(access)), JSON.parse(JSON.stringify({ ...base, type: 'access', expires: nowS() + ACCESS_TTL_S })));
    batch.set(this.db.collection(C.tokens).doc(sha(refresh)), JSON.parse(JSON.stringify({ ...base, type: 'refresh', expires: nowS() + REFRESH_TTL_S })));
    await batch.commit();
    return { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scopes.join(' ') };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = (await this.db.collection(C.tokens).doc(sha(token)).get()).data() as TokenRow | undefined;
    if (!row || row.type !== 'access' || row.expires < nowS()) throw new InvalidTokenError('Invalid or expired access token');
    return { token, clientId: row.client_id, scopes: row.scopes, expiresAt: row.expires, resource: row.resource ? new URL(row.resource) : undefined, extra: { uid: row.uid } };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const ref = this.db.collection(C.tokens).doc(sha(request.token));
    const row = (await ref.get()).data() as TokenRow | undefined;
    if (row && row.client_id === client.client_id) await ref.delete();
  }

  get resource() { return this.resourceUrl; }
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function consentPage(rid: string, clientName: string, redirectHost: string): string {
  const data = JSON.stringify({ rid, firebase: FIREBASE_WEB }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Connect AimYear</title>
<style>
:root{--bg:#faf8f5;--card:#fff;--fg:#1d1b19;--muted:#6b665f;--line:#e6e1da;--accent:#2f6b4f;--accent-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161514;--card:#1f1e1c;--fg:#f1eee9;--muted:#a39d94;--line:#34312d;--accent:#5fae86;--accent-fg:#0d1a13}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
main{background:var(--card);border:1px solid var(--line);border-radius:16px;max-width:400px;width:100%;padding:28px}
h1{font-size:22px;margin:0 0 6px}p{margin:0 0 16px;color:var(--muted)}
button,input{font:inherit;width:100%;min-height:44px;border-radius:10px}
button{border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;margin-bottom:10px}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg);font-weight:600}
input{border:1px solid var(--line);background:var(--bg);color:var(--fg);padding:0 12px;margin-bottom:10px}
.row{display:flex;gap:10px}.row button{flex:1}.hide{display:none}.err{color:#c0392b}.small{font-size:13px}
hr{border:0;border-top:1px solid var(--line);margin:16px 0}b{color:var(--fg)}
</style></head><body><main>
<h1>Connect AimYear</h1>
<p><b>${esc(clientName)}</b> (${esc(redirectHost)}) wants to use your AimYear: your aim, path, plans, timer and time history.</p>
<section id="signin">
  <button id="google">Continue with Google</button>
  <button id="apple">Continue with Apple</button>
  <hr>
  <form id="emailForm"><input id="email" type="email" autocomplete="email" placeholder="Email" required>
  <input id="password" type="password" autocomplete="current-password" placeholder="Password" required>
  <button class="primary" type="submit">Sign in with email</button></form>
  <p class="small">Use the same account as in the AimYear app. New here? <a href="#" id="create">Create an account</a> with this email and password.</p>
</section>
<section id="consent" class="hide">
  <p>Signed in as <b id="who"></b>.</p>
  <div class="row"><button id="deny">Deny</button><button id="allow" class="primary">Allow</button></div>
  <button id="switch" class="small">Use another account</button>
</section>
<p id="msg" class="err" role="alert"></p>
</main>
<script id="cfg" type="application/json">${data}</script>
<script type="module">
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, GoogleAuthProvider, OAuthProvider, signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
const cfg = JSON.parse(document.getElementById('cfg').textContent);
const auth = getAuth(initializeApp(cfg.firebase));
const $ = id => document.getElementById(id);
const say = t => { $('msg').textContent = t || ''; };
const fail = e => say((e && e.code === 'auth/invalid-credential') ? 'Wrong email or password.' : (e && e.message) || String(e));
onAuthStateChanged(auth, u => {
  const ok = u && !u.isAnonymous;
  $('signin').classList.toggle('hide', !!ok); $('consent').classList.toggle('hide', !ok);
  if (ok) $('who').textContent = u.email || u.displayName || 'your account';
});
$('google').onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch(fail);
$('apple').onclick = () => { const p = new OAuthProvider('apple.com'); p.addScope('email'); signInWithPopup(auth, p).catch(fail); };
$('emailForm').onsubmit = e => { e.preventDefault(); say(); signInWithEmailAndPassword(auth, $('email').value, $('password').value).catch(fail); };
$('create').onclick = e => { e.preventDefault(); say(); createUserWithEmailAndPassword(auth, $('email').value, $('password').value).catch(fail); };
$('switch').onclick = () => signOut(auth);
async function decide(allow) {
  say(); $('allow').disabled = $('deny').disabled = true;
  try {
    const idToken = allow ? await auth.currentUser.getIdToken(true) : undefined;
    const r = await fetch('/authorize/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rid: cfg.rid, idToken, allow }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Something went wrong.');
    location.href = j.redirect;
  } catch (e) { fail(e); $('allow').disabled = $('deny').disabled = false; }
}
$('allow').onclick = () => decide(true);
$('deny').onclick = () => decide(false);
</script></body></html>`;
}
