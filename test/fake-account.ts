import type { AccountBackend, ClientInfo, TokenInfo } from '../src/account.js';

/** OAuth rows, the user's documents and the Firebase Auth users, in memory. */
export class FakeAccountBackend implements AccountBackend {
  tokens = new Map<string, TokenInfo & { uid: string }>();
  clients = new Map<string, ClientInfo>();
  codes = new Map<string, { uid: string }>();
  trees = new Map<string, Record<string, unknown>>();
  topLevel = new Map<string, Record<string, unknown[]>>();
  authUsers = new Set<string>();

  addToken(uid: string, clientId: string, created: string, type: 'access' | 'refresh' = 'refresh') {
    const id = `h${this.tokens.size + 1}`;
    this.tokens.set(id, { id, uid, client_id: clientId, type, created, expires: Math.floor(Date.now() / 1000) + 3600 });
    return id;
  }

  async tokensOf(uid: string) { return [...this.tokens.values()].filter(t => t.uid === uid).map(({ uid: _u, ...t }) => t); }
  async client(id: string) { return this.clients.get(id) ?? null; }
  async clientUsedByOthers(clientId: string, uid: string) { return [...this.tokens.values()].some(t => t.client_id === clientId && t.uid !== uid); }
  async deleteTokens(ids: string[]) { for (const id of ids) this.tokens.delete(id); }
  async deleteClient(id: string) { this.clients.delete(id); }
  async deleteCodesOf(uid: string) { let n = 0; for (const [k, c] of this.codes) if (c.uid === uid) { this.codes.delete(k); n++; } return n; }
  async userTree(uid: string) { return structuredClone(this.trees.get(uid) ?? {}); }
  async deleteUserTree(uid: string) { const n = Object.keys(this.trees.get(uid) ?? {}).length; this.trees.delete(uid); return n; }
  async topLevelOf(uid: string) { return structuredClone(this.topLevel.get(uid) ?? {}); }
  async deleteTopLevelOf(uid: string) { const n = Object.values(this.topLevel.get(uid) ?? {}).reduce((s, x) => s + x.length, 0); this.topLevel.delete(uid); return n; }
  async authUser(uid: string) { return this.authUsers.has(uid) ? { email: `${uid}@example.test`, providers: ['password'] } : null; }
  async deleteAuthUser(uid: string) { if (!this.authUsers.delete(uid)) throw Object.assign(new Error('no user'), { code: 'auth/user-not-found' }); }
}
