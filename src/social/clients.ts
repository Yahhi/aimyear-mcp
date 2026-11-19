/**
 * The two networks AimYear posts to, behind one small interface so tests never reach
 * the real APIs. Error messages are built from status codes and the server's error
 * name only: they never echo a request, so they never carry a key or a password.
 */
import type { Network } from '../types.js';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface FeedPost { id: string; createdAt: string; text: string }
export interface Posted { id: string; url?: string }
/** One of the user's own WIP projects: a todo joins it with #hashtag in its body. */
export interface WipProject { id: string; name: string; hashtag: string | null; pitch?: string; url?: string; websiteUrl?: string; githubUrl?: string; archived?: boolean }
/** One signed-in connection, used for one call and dropped. */
export interface Connection {
  handle: string;
  /** The account's latest own posts (no replies, no reposts), newest first. */
  recent(): Promise<FeedPost[]>;
  post(text: string): Promise<Posted>;
  /** WIP only: the user's own projects. */
  projects?(): Promise<WipProject[]>;
}
export interface NetworkClient { open(secret: Record<string, string>): Promise<Connection> }

export class NetworkError extends Error {
  constructor(public network: Network, public status: number, message: string) { super(message); }
}

const NAME: Record<Network, string> = { wip: 'WIP', bluesky: 'Bluesky' };

async function call(network: Network, f: Fetch, url: string, init: RequestInit): Promise<any> {
  let r: Response;
  try { r = await f(url, { ...init, signal: AbortSignal.timeout(15000) }); }
  catch { throw new NetworkError(network, 0, `${NAME[network]} did not answer. Try again later.`); }
  const body = await r.json().catch(() => null) as any;
  if (!r.ok) {
    // Only an error NAME passes through (atproto's "AuthenticationRequired"), never free text:
    // a server could echo the request back, key and all.
    const raw = String(body?.error ?? '');
    const why = /^[A-Za-z]{3,40}$/.test(raw) ? raw : '';
    const msg = r.status === 401 || r.status === 403 ? `${NAME[network]} refused the saved login (${r.status}${why ? ` ${why}` : ''}). Connect ${network} again.`
      : r.status === 429 ? `${NAME[network]} says too many requests. Try again later.`
        : `${NAME[network]} answered ${r.status}${why ? ` (${why})` : ''}.`;
    throw new NetworkError(network, r.status, msg);
  }
  return body;
}

// ---------- WIP (wip.co) ----------
export const WIP_API = 'https://api.wip.co/v1';

/** WIP with a personal API key. A post is a completed todo. */
export function wipClient(f: Fetch = fetch): NetworkClient {
  return {
    async open(secret) {
      const h = { Authorization: `Bearer ${secret.apiKey}`, Accept: 'application/json' };
      const me = await call('wip', f, `${WIP_API}/users/me`, { headers: h });
      return {
        handle: String(me?.username ?? me?.id ?? 'wip'),
        async recent() {
          const r = await call('wip', f, `${WIP_API}/users/me/todos?limit=20`, { headers: h });
          return ((r?.data ?? []) as any[]).map(t => ({ id: String(t.id), createdAt: String(t.created_at ?? ''), text: String(t.body ?? '') }));
        },
        async post(text) {
          const r = await call('wip', f, `${WIP_API}/todos`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ body: text, completed: true }) });
          return { id: String(r.id), url: r.url ? String(r.url) : undefined };
        },
        // GET /v1/users/me/projects (api.wip.co/v1/openapi.yml), 100 a page, cursor in `after`.
        async projects() {
          const out: WipProject[] = [];
          let after: string | null = null;
          for (let page = 0; page < 5; page++) {
            const r = await call('wip', f, `${WIP_API}/users/me/projects?limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ''}`, { headers: h });
            for (const p of (r?.data ?? []) as any[]) {
              out.push({
                id: String(p.id), name: String(p.name ?? ''), hashtag: p.hashtag ? String(p.hashtag).replace(/^#/, '') : null,
                pitch: p.pitch ? String(p.pitch) : undefined, url: p.url ? String(p.url) : undefined,
                websiteUrl: p.website_url ? String(p.website_url) : undefined, githubUrl: p.github_url ? String(p.github_url) : undefined, archived: p.archived === true,
              });
            }
            after = r?.has_more && r?.after ? String(r.after) : null;
            if (!after) break;
          }
          return out;
        },
      };
    },
  };
}

// ---------- Bluesky ----------
/**
 * Bluesky with an app password (Settings → Privacy and security → App passwords), never
 * the account password. createSession on the bsky.social entryway works for accounts
 * hosted by Bluesky.
 * TODO(oauth): move to atproto OAuth (DPoP, PAR) so no password is stored at all and
 * self-hosted PDS accounts work; then drop the app-password path.
 */
export const BSKY = 'https://bsky.social/xrpc';
export const BLUESKY_MAX = 300;
export const APP_PASSWORD = /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;

export function blueskyClient(f: Fetch = fetch): NetworkClient {
  return {
    async open(secret) {
      const s = await call('bluesky', f, `${BSKY}/com.atproto.server.createSession`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: secret.identifier, password: secret.appPassword }),
      });
      const auth = { Authorization: `Bearer ${s.accessJwt}`, Accept: 'application/json' };
      const did = String(s.did), handle = String(s.handle ?? secret.identifier);
      return {
        handle,
        async recent() {
          const r = await call('bluesky', f, `${BSKY}/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(did)}&limit=30&filter=posts_no_replies`, { headers: auth });
          return ((r?.feed ?? []) as any[])
            .filter(i => !i.reason && i.post?.author?.did === did)
            .map(i => ({ id: String(i.post.uri), createdAt: String(i.post.record?.createdAt ?? i.post.indexedAt ?? ''), text: String(i.post.record?.text ?? '') }));
        },
        async post(text) {
          const record: Record<string, unknown> = { $type: 'app.bsky.feed.post', text, createdAt: new Date().toISOString() };
          const facets = linkFacets(text);
          if (facets.length) record.facets = facets;
          const r = await call('bluesky', f, `${BSKY}/com.atproto.repo.createRecord`, {
            method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: did, collection: 'app.bsky.feed.post', record }),
          });
          const uri = String(r.uri);
          return { id: uri, url: `https://bsky.app/profile/${handle}/post/${uri.split('/').pop()}` };
        },
      };
    },
  };
}

const TLDS = 'com|co|app|dev|io|org|net|social|ai|so';
const LINK = new RegExp(`(https?://[^\\s]+)|(?<![@\\w./-])((?:[a-z0-9-]+\\.)+(?:${TLDS})(?:/[^\\s]*)?)(?![\\w-])`, 'gi');

/**
 * Bluesky shows links only through facets: byte ranges (UTF-8) of the text with a uri.
 * Finds full URLs and bare domains such as aimyear.com.
 */
export function linkFacets(text: string) {
  const enc = new TextEncoder();
  const out: { index: { byteStart: number; byteEnd: number }; features: { $type: string; uri: string }[] }[] = [];
  for (const m of text.matchAll(LINK)) {
    let s = m[0];
    s = s.replace(/[.,;:!?)\]]+$/, '');
    if (!s) continue;
    const byteStart = enc.encode(text.slice(0, m.index)).length;
    out.push({ index: { byteStart, byteEnd: byteStart + enc.encode(s).length }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: /^https?:\/\//i.test(s) ? s : `https://${s}` }] });
  }
  return out;
}

export const graphemes = (s: string) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].length;
