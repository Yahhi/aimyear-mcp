/**
 * WIP project hashtags on AimYear projects and levers (docs/public-posting.md). On wip.co a
 * todo joins a project through its #hashtag; AimYear keeps the tag without '#'.
 */
import type { WipTag } from '../types.js';

/** Letters, digits and underscores, as in wip.co hashtags; at most 50. */
export const WIP_HASHTAG = /^[A-Za-z0-9_]{1,50}$/;

/** The hashtag without '#', or null when it is not one. */
export function wipHashtag(raw: string): string | null {
  const t = raw.trim().replace(/^#/, '');
  return WIP_HASHTAG.test(t) ? t : null;
}

/**
 * The tag an entry keeps when set_projects / set_levers replace the list. A list call from
 * an agent that never heard of hashtags must not wipe them: an absent wip_hashtag keeps the
 * one on record for that id; null or '' removes it; a value is the user's (or agent's) own.
 */
export function nextTag(given: string | null | undefined, prev: WipTag | undefined, what: string): WipTag {
  if (given === undefined) return prev?.wipHashtag ? { wipHashtag: prev.wipHashtag, wipHashtagBy: prev.wipHashtagBy ?? 'user' } : {};
  if (given === null || !given.trim()) return {};
  const tag = wipHashtag(given);
  if (!tag) throw new Error(`"${given}" is not a WIP hashtag (${what}): letters, digits and underscores only, like #aimyear.`);
  return { wipHashtag: tag, wipHashtagBy: 'user' };
}
