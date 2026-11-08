/**
 * Attaching the user's WIP project hashtags to their AimYear projects and levers when WIP is
 * connected from the app, where no agent is present (docs/public-posting.md, "Who attaches
 * the hashtags"). Plain matching on names, hashtags, keywords and repos first; what is left
 * goes to one call to a Claude model. This is the only place AimYear runs a model on its
 * own keys. Nothing here ever replaces a hashtag that is already set.
 */
import Anthropic from '@anthropic-ai/sdk';
import { oidcFederationProvider } from '@anthropic-ai/sdk/lib/credentials/oidc-federation';
import { z } from 'zod';
import type { WipProject } from './clients.js';

/** An AimYear project or lever without a hashtag yet. */
export interface MatchEntry { id: string; kind: 'project' | 'lever'; name: string; keywords: string[]; repos: string[] }
export interface WipMatch { id: string; kind: 'project' | 'lever'; hashtag: string; by: 'name' | 'ai' }

/** The model step, behind an interface so tests use a fake and never call the API. */
export interface ProjectMatcher { match(entries: MatchEntry[], wip: WipProject[]): Promise<{ id: string; hashtag: string }[]> }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const repoName = (s: string) => norm(s.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop() ?? '');
const hostName = (u: string) => { try { return norm(new URL(/^https?:/.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, '').split('.')[0]); } catch { return ''; } };

function entryKeys(e: MatchEntry): Set<string> {
  return new Set([norm(e.name), ...e.keywords.map(norm), ...e.repos.map(repoName)].filter(k => k.length >= 3));
}
function wipKeys(p: WipProject): Set<string> {
  return new Set([norm(p.name), norm(p.hashtag ?? ''), p.githubUrl ? repoName(p.githubUrl) : '', p.websiteUrl ? hostName(p.websiteUrl) : ''].filter(k => k.length >= 3));
}

/**
 * Plain matching: an entry and a WIP project match when a normalized name, keyword, repo,
 * hashtag or site name is the same. Only one-to-one matches count; anything ambiguous is
 * left for the model.
 */
export function plainMatch(entries: MatchEntry[], wip: WipProject[]): { matches: WipMatch[]; entries: MatchEntry[]; wip: WipProject[] } {
  const usable = wip.filter(p => p.hashtag && !p.archived);
  const hits = new Map<string, WipProject[]>();
  for (const e of entries) {
    const ek = entryKeys(e);
    hits.set(e.id, usable.filter(p => [...wipKeys(p)].some(k => ek.has(k))));
  }
  const matches: WipMatch[] = [];
  for (const e of entries) {
    const h = hits.get(e.id)!;
    if (h.length !== 1) continue;
    const others = entries.filter(x => x.id !== e.id && hits.get(x.id)!.includes(h[0]));
    if (others.length) continue;
    matches.push({ id: e.id, kind: e.kind, hashtag: h[0].hashtag!, by: 'name' });
  }
  const done = new Set(matches.map(m => m.id)), used = new Set(matches.map(m => m.hashtag));
  return { matches, entries: entries.filter(e => !done.has(e.id)), wip: usable.filter(p => !used.has(p.hashtag!)) };
}

/**
 * Plain matching, then one model call for what is left. The model's answer is checked:
 * only ids and hashtags that were offered, each used once. A failing model is no match.
 */
export async function matchWipProjects(entries: MatchEntry[], wip: WipProject[], matcher: ProjectMatcher | null): Promise<WipMatch[]> {
  const plain = plainMatch(entries, wip);
  if (!matcher || !plain.entries.length || !plain.wip.length) return plain.matches;
  let ai: { id: string; hashtag: string }[] = [];
  try { ai = await matcher.match(plain.entries, plain.wip); } catch { ai = []; }
  const left = new Map(plain.entries.map(e => [e.id, e]));
  const free = new Map(plain.wip.map(p => [p.hashtag!.toLowerCase(), p.hashtag!]));
  const out = [...plain.matches];
  for (const m of ai) {
    const e = left.get(m.id), tag = free.get(String(m.hashtag ?? '').replace(/^#/, '').toLowerCase());
    if (!e || !tag) continue;
    out.push({ id: e.id, kind: e.kind, hashtag: tag, by: 'ai' });
    left.delete(e.id); free.delete(tag.toLowerCase());
  }
  return out;
}

// ---------- the model step: Claude Haiku 5.5 through Workload Identity Federation ----------

export const MATCH_MODEL = 'claude-haiku-5-5';
const METADATA_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=https://api.anthropic.com&format=full';

/** Cloud Run's identity token for this service, from the metadata server. */
async function googleIdentityToken(): Promise<string> {
  const r = await fetch(METADATA_URL, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!r.ok) throw new Error(`metadata server answered ${r.status}`);
  return r.text();
}

const Answer = z.object({ matches: z.array(z.object({ id: z.string(), hashtag: z.string() })) });
const ANSWER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['matches'],
  properties: { matches: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'hashtag'], properties: { id: { type: 'string' }, hashtag: { type: 'string' } } } } },
};
const SYSTEM = `You match a person's projects in AimYear (a goal tracker) to their projects on WIP (wip.co, a maker community where a todo joins a project through its #hashtag).
Each AimYear entry is a project (a product or other work) or a lever (a kind of work toward their aim; most levers, such as "outreach" or "coding", are not about one product and match nothing).
Match an entry to a WIP project only when they are clearly the same product: same or near-same name, an obvious abbreviation, or keywords and repos that point to it. When unsure, leave it out: a wrong hashtag posts the person's work under the wrong project. Use each WIP hashtag at most once. Answer with the entry id and the WIP hashtag exactly as given.`;

/**
 * The Claude matcher, or null when the server has no federation configured
 * (ANTHROPIC_FEDERATION_RULE_ID and ANTHROPIC_ORGANIZATION_ID): then the step is skipped.
 * The client is built on first use. No API key is read.
 */
export function claudeMatcherFromEnv(env: NodeJS.ProcessEnv = process.env): ProjectMatcher | null {
  const rule = env.ANTHROPIC_FEDERATION_RULE_ID, org = env.ANTHROPIC_ORGANIZATION_ID;
  if (!rule || !org) return null;
  let client: Anthropic | null = null;
  const get = () => client ??= new Anthropic({
    credentials: oidcFederationProvider({
      identityTokenProvider: googleIdentityToken,
      federationRuleId: rule, organizationId: org,
      serviceAccountId: env.ANTHROPIC_SERVICE_ACCOUNT_ID, workspaceId: env.ANTHROPIC_WORKSPACE_ID,
      baseURL: 'https://api.anthropic.com', fetch,
    }),
    // Connecting waits for this: keep it short, and a failure is just "no match".
    timeout: 20_000, maxRetries: 1,
  });
  return {
    async match(entries, wip) {
      const input = {
        aimyear: entries.map(e => ({ id: e.id, kind: e.kind, name: e.name, keywords: e.keywords, repos: e.repos })),
        wip: wip.map(p => ({ hashtag: p.hashtag, name: p.name, pitch: p.pitch ?? null, website: p.websiteUrl ?? null, github: p.githubUrl ?? null })),
      };
      try {
        const r = await get().messages.create({
          model: MATCH_MODEL, max_tokens: 4000, system: SYSTEM,
          output_config: { effort: 'low', format: { type: 'json_schema', schema: ANSWER_SCHEMA } },
          messages: [{ role: 'user', content: JSON.stringify(input) }],
        });
        if (r.stop_reason !== 'end_turn') { console.error('[wip-match] no answer:', r.stop_reason); return []; }
        const text = r.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('');
        const parsed = Answer.safeParse(JSON.parse(text));
        return parsed.success ? parsed.data.matches : [];
      } catch (e) {
        // Only the error's class and status go to the log: never the request.
        if (e instanceof Anthropic.RateLimitError) console.error('[wip-match] rate limited');
        else if (e instanceof Anthropic.APIConnectionError) console.error('[wip-match] could not reach the API');
        else if (e instanceof Anthropic.APIError) console.error('[wip-match] API error', e.status);
        else console.error('[wip-match] failed', (e as Error).name);
        return [];
      }
    },
  };
}
