/**
 * The person's account as a whole: the agents connected to it, an export of everything
 * the server keeps about them, and deleting all of it.
 *
 * Connected agents are OAuth clients that hold tokens for this uid (oauth_tokens rows
 * carry uid and client_id). Disconnecting one deletes its tokens for this uid: the agent
 * has to connect again. A client registration can be shared by several people (one
 * install of an app), so the oauth_clients row is removed only when nobody else uses it.
 *
 * Deleting the account removes: users/{uid} with every subcollection (aim, days,
 * sessions, blocks, devices, ops, social logins, posts, Pro status), the top-level rows
 * for the uid (pending_notifications, desktop_reminders, oauth_tokens, oauth_codes), the
 * OAuth clients only this person used, and the Firebase Auth user. It does not touch
 * store subscriptions: Apple, Google and aimyear.com bill on their own.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { initFirestore, PENDING, DESKTOP_REMINDERS } from './store.js';
import { VERSION } from './version.js';

export interface TokenInfo { id: string; client_id: string; type: 'access' | 'refresh'; created: string; expires: number }
export interface ClientInfo { client_id: string; client_name?: string; client_id_issued_at?: number }
export interface AuthUserInfo { email?: string; providers: string[]; created?: string; lastSignIn?: string }

/** Everything the account functions need from storage, so tests can run without Firestore. */
export interface AccountBackend {
  tokensOf(uid: string): Promise<TokenInfo[]>;
  client(clientId: string): Promise<ClientInfo | null>;
  /** Does anyone other than uid hold tokens of this client? */
  clientUsedByOthers(clientId: string, uid: string): Promise<boolean>;
  deleteTokens(ids: string[]): Promise<void>;
  deleteClient(clientId: string): Promise<void>;
  deleteCodesOf(uid: string): Promise<number>;
  /** users/{uid} and everything under it, as { "collection/doc": data, "collection/doc/sub/doc": data }. */
  userTree(uid: string): Promise<Record<string, unknown>>;
  deleteUserTree(uid: string): Promise<number>;
  /** Top-level rows that belong to uid, by collection. */
  topLevelOf(uid: string): Promise<Record<string, unknown[]>>;
  deleteTopLevelOf(uid: string): Promise<number>;
  authUser(uid: string): Promise<AuthUserInfo | null>;
  deleteAuthUser(uid: string): Promise<void>;
}

/** Claude Code registers as "Claude Code (aimyear)"; the app as "AimYear app". */
export function agentName(clientName: string | undefined): string | undefined {
  const n = (clientName ?? '').replace(/\s*\(aimyear\)\s*$/i, '').trim();
  if (!n) return undefined;
  if (/^aimyear( app)?$/i.test(n)) return 'app';
  return n.slice(0, 60);
}

/** A readable agent name from a User-Agent header, for callers without an OAuth client name. */
export function agentFromUserAgent(ua: string | undefined): string | undefined {
  const s = (ua ?? '').trim();
  if (!s) return undefined;
  const known: [RegExp, string][] = [
    [/claude[- ]?code/i, 'Claude Code'], [/claude/i, 'Claude'], [/chatgpt|openai/i, 'ChatGPT'], [/codex/i, 'Codex'],
    [/cursor/i, 'Cursor'], [/gemini|antigravity/i, 'Gemini'], [/dart|flutter|aimyear/i, 'app'],
  ];
  for (const [re, name] of known) if (re.test(s)) return name;
  return s.split(/[\s/]/)[0].slice(0, 40) || undefined;
}

export interface AgentView { client_id: string; name: string; connected_at: string; last_active_at: string; current: boolean }

export class AccountService {
  constructor(private backend: AccountBackend, private uid: string, private currentClientId?: string) {}

  /** Agents with tokens for this person. last_active_at is the newest token: tokens rotate when used. */
  async agents(): Promise<AgentView[]> {
    const tokens = (await this.backend.tokensOf(this.uid)).filter(t => t.expires * 1000 > Date.now());
    const byClient = new Map<string, TokenInfo[]>();
    for (const t of tokens) byClient.set(t.client_id, [...(byClient.get(t.client_id) ?? []), t]);
    const out: AgentView[] = [];
    for (const [clientId, ts] of byClient) {
      const c = await this.backend.client(clientId).catch(() => null);
      const created = ts.map(t => t.created).sort();
      out.push({ client_id: clientId, name: agentName(c?.client_name) ?? 'An AI app', connected_at: created[0], last_active_at: created[created.length - 1], current: clientId === this.currentClientId });
    }
    return out.sort((a, b) => b.last_active_at.localeCompare(a.last_active_at));
  }

  async listAgents() {
    const agents = await this.agents();
    const named = (a: AgentView) => (a.name === 'app' ? 'the AimYear app' : a.name);
    return { agents, speak: agents.length ? `Connected: ${agents.map(a => `${named(a)}${a.current ? ' (this one)' : ''}`).join(', ')}.` : 'No agents are connected. Connect one with https://mcp.aimyear.com/mcp.' };
  }

  /** Deletes this person's tokens for one client. The agent must connect again to come back. */
  async disconnectAgent(clientId: string) {
    const mine = (await this.backend.tokensOf(this.uid)).filter(t => t.client_id === clientId);
    if (!mine.length) return { ok: false, disconnected: null, speak: 'No connected agent has that id. list_agents shows the connected ones.' };
    const c = await this.backend.client(clientId).catch(() => null);
    await this.backend.deleteTokens(mine.map(t => t.id));
    if (!(await this.backend.clientUsedByOthers(clientId, this.uid))) await this.backend.deleteClient(clientId);
    const name = agentName(c?.client_name) ?? 'The agent';
    return { ok: true, disconnected: clientId, speak: `${name === 'app' ? 'The AimYear app' : name} is disconnected: it can no longer read or change your AimYear. Connect it again any time.${clientId === this.currentClientId ? ' That was this connection.' : ''}` };
  }

  /** Everything the server keeps about this person, as JSON. Saved logins stay sealed out of it. */
  async export() {
    const tree = await this.backend.userTree(this.uid);
    for (const [path, data] of Object.entries(tree)) {
      // users/{uid}/social/{network}.secret is the network login, encrypted: never exported.
      if (/^social\/[^/]+$/.test(path) && data && typeof data === 'object') {
        const { secret: _s, ...rest } = data as Record<string, unknown>;
        tree[path] = rest;
      }
    }
    return {
      format: 'aimyear-export', version: 1, server_version: VERSION, exported_at: new Date().toISOString(), uid: this.uid,
      account: await this.backend.authUser(this.uid).catch(() => null),
      data: tree,
      server_rows: await this.backend.topLevelOf(this.uid),
      agents: await this.agents(),
      speak: `Your AimYear data: ${Object.keys(tree).length} records, plus your connected agents. Saved WIP and Bluesky logins are not included.`,
    };
  }

  /** Deletes every trace of this person on the server, and their sign-in. Never touches a store subscription. */
  async deleteEverything() {
    const tokens = await this.backend.tokensOf(this.uid);
    const clients = [...new Set(tokens.map(t => t.client_id))];
    // Sign-ins first, so nothing can write while the data goes.
    await this.backend.deleteTokens(tokens.map(t => t.id));
    const codes = await this.backend.deleteCodesOf(this.uid);
    let clientsDeleted = 0;
    for (const c of clients) if (!(await this.backend.clientUsedByOthers(c, this.uid))) { await this.backend.deleteClient(c); clientsDeleted++; }
    const rows = await this.backend.deleteTopLevelOf(this.uid);
    const docs = await this.backend.deleteUserTree(this.uid);
    let authDeleted = true;
    let authError: string | undefined;
    try { await this.backend.deleteAuthUser(this.uid); } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      if (code === 'auth/user-not-found') authDeleted = true; else { authDeleted = false; authError = 'The sign-in could not be deleted; try again.'; }
    }
    return {
      ok: authDeleted, deleted: { documents: docs, server_rows: rows, oauth_tokens: tokens.length, oauth_codes: codes, oauth_clients: clientsDeleted }, auth_user_deleted: authDeleted, error: authError,
      subscriptions_cancelled: false,
      speak: `Your AimYear account and all its data are deleted, and every connected agent is disconnected.${authDeleted ? '' : ` ${authError}`} This does not cancel a Pro subscription: cancel it where you bought it (App Store, Google Play, or aimyear.com), or it keeps renewing.`,
    };
  }
}

// ---------- Firestore ----------

const C = { tokens: 'oauth_tokens', clients: 'oauth_clients', codes: 'oauth_codes' };

async function deleteQuery(db: Firestore, q: FirebaseFirestore.Query): Promise<number> {
  let n = 0;
  for (;;) {
    const snap = await q.limit(400).get();
    if (snap.empty) return n;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    n += snap.size;
    if (snap.size < 400) return n;
  }
}

export function firestoreAccountBackend(db: Firestore = initFirestore()): AccountBackend {
  const userRef = (uid: string) => db.collection('users').doc(uid);
  return {
    async tokensOf(uid) {
      const snap = await db.collection(C.tokens).where('uid', '==', uid).get();
      return snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<TokenInfo, 'id'>) }));
    },
    async client(id) {
      if (!id || id.length > 200) return null;
      const s = await db.collection(C.clients).doc(id).get();
      return s.exists ? (s.data() as ClientInfo) : null;
    },
    async clientUsedByOthers(clientId, uid) {
      const snap = await db.collection(C.tokens).where('client_id', '==', clientId).limit(50).get();
      return snap.docs.some(d => d.get('uid') !== uid);
    },
    async deleteTokens(ids) {
      for (let i = 0; i < ids.length; i += 400) {
        const batch = db.batch();
        ids.slice(i, i + 400).forEach(id => batch.delete(db.collection(C.tokens).doc(id)));
        await batch.commit();
      }
    },
    async deleteClient(id) { await db.collection(C.clients).doc(id).delete(); },
    async deleteCodesOf(uid) { return deleteQuery(db, db.collection(C.codes).where('uid', '==', uid)); },
    async userTree(uid) {
      const out: Record<string, unknown> = {};
      const root = await userRef(uid).get();
      if (root.exists) out[''] = root.data();
      const walk = async (ref: FirebaseFirestore.DocumentReference, prefix: string) => {
        for (const col of await ref.listCollections()) {
          for (const doc of (await col.get()).docs) {
            const path = `${prefix}${col.id}/${doc.id}`;
            out[path] = JSON.parse(JSON.stringify(doc.data()));
            await walk(doc.ref, `${path}/`);
          }
        }
      };
      await walk(userRef(uid), '');
      return out;
    },
    async deleteUserTree(uid) {
      let n = 0;
      const count = async (ref: FirebaseFirestore.DocumentReference) => { for (const col of await ref.listCollections()) for (const d of (await col.get()).docs) { n++; await count(d.ref); } };
      await count(userRef(uid));
      await db.recursiveDelete(userRef(uid));
      return n;
    },
    async topLevelOf(uid) {
      const out: Record<string, unknown[]> = {};
      for (const col of [PENDING, DESKTOP_REMINDERS]) out[col] = (await db.collection(col).where('uid', '==', uid).get()).docs.map(d => d.data());
      return out;
    },
    async deleteTopLevelOf(uid) {
      let n = 0;
      for (const col of [PENDING, DESKTOP_REMINDERS]) n += await deleteQuery(db, db.collection(col).where('uid', '==', uid));
      return n;
    },
    async authUser(uid) {
      const u = await getAuth().getUser(uid);
      return { email: u.email, providers: u.providerData.map(p => p.providerId), created: u.metadata.creationTime, lastSignIn: u.metadata.lastSignInTime };
    },
    async deleteAuthUser(uid) { await getAuth().deleteUser(uid); },
  };
}
