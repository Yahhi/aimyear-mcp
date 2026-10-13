/**
 * One structured log line per MCP call, written in the one place every call passes
 * through: the HTTP handler hands us the parsed JSON-RPC body and the transport, and
 * we time each request until its response leaves through transport.send. No tool can
 * forget to log, and a refusal is as visible as a success.
 *
 * On Cloud Run a JSON line on stdout becomes a structured log entry
 * (jsonPayload.evt = "mcp_call"); scripts/mcp-calls.sh reads them back.
 *
 * What is logged: method, tool, ok, an error code, latency, who (uid), which client.
 * What is never logged: argument values. Tasks, summaries and plan titles are the
 * person's own words, so only the argument names and their total length are kept.
 */
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export interface CallContext { user: string; client: string; req: string; auth: 'oauth' | 'token' | 'none'; app?: string }
interface Started { method: string; tool: string | null; args: { keys: string[]; len: number } | null; t0: number; seq: number }

const SKIP = (m: string) => m === 'ping' || m.startsWith('notifications/');

export function summariseArgs(args: unknown): { keys: string[]; len: number } | null {
  if (!args || typeof args !== 'object') return null;
  const keys = Object.keys(args as object).sort();
  let len = 0;
  try { len = JSON.stringify(args).length; } catch { /* unserialisable: length stays 0 */ }
  return { keys, len };
}

export function emit(record: Record<string, unknown>) {
  try {
    const ok = record.ok !== false;
    console.log(JSON.stringify({ severity: ok ? 'INFO' : 'WARNING', evt: 'mcp_call', v: 1, ts: new Date().toISOString(), ms_epoch: Date.now(), ...record }));
  } catch { /* logging must never fail a request */ }
}

/** Log a request the gate refused before any server saw it. */
export function logRefused(body: unknown, ctx: CallContext, status: number) {
  const msgs = (Array.isArray(body) ? body : [body]).filter(m => m && typeof m === 'object') as any[];
  msgs.forEach((m, seq) => {
    if (typeof m.method !== 'string' || SKIP(m.method)) return;
    emit({ ...ctx, method: m.method, tool: m.method === 'tools/call' ? String(m.params?.name ?? '') : null, ok: false, err: `http_${status}`, ms: 0, seq });
  });
}

export function instrument(transport: Transport, body: unknown, ctx: CallContext) {
  try {
    const started = new Map<string | number, Started>();
    const msgs = (Array.isArray(body) ? body : [body]).filter(m => m && typeof m === 'object') as any[];
    msgs.forEach((m, seq) => {
      if (m.id === undefined || typeof m.method !== 'string' || SKIP(m.method)) return;
      const isCall = m.method === 'tools/call';
      started.set(m.id, { method: m.method, tool: isCall ? String(m.params?.name ?? '') : null, args: isCall ? summariseArgs(m.params?.arguments) : null, t0: Date.now(), seq });
      // The app's own name arrives only on initialize; it goes in its own field so the
      // client (user-agent) stays the same across the calls of one session.
      if (m.method === 'initialize') ctx = { ...ctx, app: `${m.params?.clientInfo?.name ?? '?'}/${m.params?.clientInfo?.version ?? '?'}`.slice(0, 60) };
    });
    if (!started.size) return;
    const send = transport.send.bind(transport);
    transport.send = async (msg: JSONRPCMessage, opts?: any) => {
      try {
        const id = (msg as any).id;
        const s = id !== undefined ? started.get(id) : undefined;
        if (s && ('result' in msg || 'error' in msg)) {
          started.delete(id);
          const error = (msg as any).error;
          const toolError = !error && (msg as any).result?.isError === true;
          let err: string | null = null;
          if (error) err = `rpc_${error.code}`;
          else if (toolError) {
            const text = String((msg as any).result?.content?.[0]?.text ?? '');
            err = /Sign in to AimYear/.test(text) ? 'not_signed_in' : /Input validation error/.test(text) ? 'invalid_arguments' : 'tool_error';
          }
          emit({ ...ctx, method: s.method, tool: s.tool, args: s.args, ok: !error && !toolError, err, ms: Date.now() - s.t0, seq: s.seq });
        }
      } catch { /* never fail the response */ }
      return send(msg, opts);
    };
  } catch { /* never fail the request */ }
}
