#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomUUID } from 'node:crypto';
import { buildServer, createApp } from './http.js';
import type { Workplace } from './types.js';

async function stdio() {
  const uid = process.env.AIMYEAR_UID;
  if (!uid) { console.error('AIMYEAR_UID is required in stdio mode'); process.exit(2); }
  const workplace = (process.env.AIMYEAR_WORKPLACE as Workplace) ?? 'desktop';
  const server = buildServer(uid, randomUUID(), workplace);
  await server.connect(new StdioServerTransport());
}

/**
 * Remote mode. AIMYEAR_TOKENS="token=uid,token2=uid2" keeps the static tokens working
 * (Claude Code, the menu bar app, the scheduler); everyone else signs in with OAuth.
 * AIMYEAR_BASE_URL is the public URL clients reach, e.g. https://mcp.aimyear.com.
 */
async function http() {
  const port = Number(process.env.PORT ?? 8787);
  const tokens = new Map((process.env.AIMYEAR_TOKENS ?? '').split(',').filter(Boolean).map(p => p.split('=') as [string, string]));
  if (tokens.size === 0) { console.error('AIMYEAR_TOKENS is required in http mode'); process.exit(2); }
  const baseUrl = new URL(process.env.AIMYEAR_BASE_URL ?? `http://localhost:${port}`);
  const extraOrigins = (process.env.AIMYEAR_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean);
  createApp({ tokens, baseUrl, extraOrigins }).listen(port, () => console.error(`aimyear-mcp http on :${port}, public at ${baseUrl.href}`));
}

if (process.argv.includes('--http')) http().catch(e => { console.error(e); process.exit(1); });
else stdio().catch(e => { console.error(e); process.exit(1); });
