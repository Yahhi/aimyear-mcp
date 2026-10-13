import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/http.js';
import { FirestoreOAuthProvider } from '../src/oauth.js';

/** An in-process server on a free port. db is a stub unless a test passes a real one. */
export async function startApp(opts: { tokens?: Map<string, string>; provider?: FirestoreOAuthProvider } = {}) {
  const base = new URL('http://localhost:0');
  let server!: Server;
  await new Promise<void>(resolve => {
    const app = createApp({ tokens: opts.tokens ?? new Map([['t', 'nobody']]), baseUrl: new URL('http://localhost:1'), provider: opts.provider ?? new FirestoreOAuthProvider(new URL('http://localhost:1/mcp'), {} as any) });
    server = app.listen(0, () => resolve());
  });
  base.port = String((server.address() as AddressInfo).port);
  return { url: base.origin, close: () => new Promise<void>(r => server.close(() => r())) };
}

export const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } };

/** POST a JSON-RPC body the way a client does; returns status, headers and the parsed JSON (SSE or plain). */
export async function rpc(url: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const raw = await r.text();
  let json: any = null;
  const data = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
  try { json = JSON.parse(data.length ? data.join('') : raw); } catch { /* not JSON */ }
  return { status: r.status, headers: r.headers, raw, json };
}

export const call = (id: number, method: string, params: unknown = {}) => ({ jsonrpc: '2.0', id, method, params });
