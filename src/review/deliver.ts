/**
 * Sending the weekly review (docs/weekly-review.md): Sunday 19:00 in the person's timezone,
 * Pro only, on unless they turned it off, once per person and week.
 *
 * It rides on the reminders queue that /tick already drains every minute: one pending doc
 * per person (kind weekly_review), armed by AimService.armWeeklyReview and re-armed here
 * after each Sunday. Once per week holds even when a tick is retried or two overlap: the
 * pending doc is claimed before anything runs (tick), and users/{uid}/weekly_reviews/{monday}
 * is claimed in a transaction before the email goes out.
 *
 * The email goes through Amazon SES (SESv2 SendEmail, Simple content) behind EmailSender,
 * so tests use a fake and nothing here ever sends a real email in a test.
 */
import { AimService } from '../service.js';
import { Store } from '../store.js';
import { isPro as realIsPro } from '../pro.js';
import { firestoreAccountBackend } from '../account.js';
import type { Pending } from '../types.js';
import { gatherReview, renderReview } from './build.js';
import { reviewWindow } from './schedule.js';
import { unsubscribeKey, unsubscribeUrl } from './unsubscribe.js';
import { googleIdentityToken } from '../gcp-identity.js';
import type { FromWebTokenInit } from '@aws-sdk/credential-provider-web-identity';
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';

export const DEFAULT_FROM = 'AimYear <review@aimyear.com>';
/** A failed send on Sunday evening is tried again this much later, while it is still Sunday evening. */
const RETRY_MS = 15 * 60000;

export interface EmailMessage { to: string; from: string; subject: string; text: string; html: string; headers: Record<string, string> }
export interface EmailSender { send(m: EmailMessage): Promise<{ messageId: string }> }

/** The audience of the Google identity token the AWS role aimyear-mcp-ses trusts. */
export const SES_TOKEN_AUDIENCE = 'https://aimyear.com/aws-ses';

type AssumeWithWebIdentity = NonNullable<FromWebTokenInit['roleAssumerWithWebIdentity']>;

/**
 * SES credentials without a stored key: with AWS_ROLE_ARN set (Cloud Run), the service's Google
 * identity token is traded for that role's short-lived credentials (AssumeRoleWithWebIdentity);
 * the SDK keeps them until they expire and then asks again. Without AWS_ROLE_ARN, undefined:
 * the SDK reads the standard env vars (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY), as locally.
 * `token` and `assume` are for tests.
 */
export async function sesCredentials(
  env: Record<string, string | undefined> = process.env,
  token: (audience: string) => Promise<string> = googleIdentityToken,
  assume?: AssumeWithWebIdentity,
): Promise<AwsCredentialIdentityProvider | undefined> {
  const roleArn = env.AWS_ROLE_ARN?.trim();
  if (!roleArn) return undefined;
  const { fromWebToken } = await import('@aws-sdk/credential-provider-web-identity');
  const region = env.AWS_REGION || 'us-east-1';
  return async () => fromWebToken({
    roleArn, roleSessionName: 'aimyear-mcp-review', webIdentityToken: await token(SES_TOKEN_AUDIENCE),
    clientConfig: { region }, ...(assume ? { roleAssumerWithWebIdentity: assume } : {}),
  })();
}

/**
 * Amazon SES v2, region from AWS_REGION (default us-east-1), credentials from sesCredentials;
 * the SDK is loaded on first use.
 */
export function sesSender(env: Record<string, string | undefined> = process.env): EmailSender {
  let client: Promise<{ send: (m: EmailMessage) => Promise<{ messageId: string }> }> | null = null;
  const load = async () => {
    const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
    const credentials = await sesCredentials(env);
    const ses = new SESv2Client({ region: env.AWS_REGION || 'us-east-1', ...(credentials ? { credentials } : {}) });
    return {
      send: async (m: EmailMessage) => {
        const out = await ses.send(new SendEmailCommand({
          FromEmailAddress: m.from,
          Destination: { ToAddresses: [m.to] },
          Content: {
            Simple: {
              Subject: { Data: m.subject, Charset: 'UTF-8' },
              Body: { Text: { Data: m.text, Charset: 'UTF-8' }, Html: { Data: m.html, Charset: 'UTF-8' } },
              Headers: Object.entries(m.headers).map(([Name, Value]) => ({ Name, Value })),
            },
          },
        }));
        return { messageId: out.MessageId ?? '' };
      },
    };
  };
  return { send: async m => (await (client ??= load())).send(m) };
}

export interface ReviewDeps {
  storeFor: (uid: string) => Store;
  isPro: (uid: string) => Promise<boolean>;
  /** The account's email (Firebase Auth), or null when it has none. */
  emailOf: (uid: string) => Promise<string | null>;
  sender: EmailSender;
  /** The server's public URL, for the unsubscribe link. */
  baseUrl: URL;
  /** The HMAC key for unsubscribe links; null means not set up, and nothing is sent. */
  key: Buffer | null;
  from: string;
}

export function realReviewDeps(baseUrl: URL, env: Record<string, string | undefined> = process.env): ReviewDeps {
  const accounts = firestoreAccountBackend();
  return {
    storeFor: uid => new Store(uid), isPro: realIsPro,
    emailOf: async uid => (await accounts.authUser(uid).catch(() => null))?.email ?? null,
    sender: sesSender(env), baseUrl, key: unsubscribeKey(env), from: env.AIMYEAR_REVIEW_FROM?.trim() || DEFAULT_FROM,
  };
}

export interface ReviewResult { sent: number; failed: number; reason?: string; continued?: string }

/** Renders one person's review for the week of `week` (a Monday), with their unsubscribe link. */
export async function composeReview(svc: AimService, uid: string, week: string, deps: Pick<ReviewDeps, 'baseUrl' | 'key'>) {
  if (!deps.key) throw new Error('no unsubscribe key');
  const facts = await gatherReview(svc, week);
  const link = unsubscribeUrl(deps.baseUrl, deps.key, uid);
  return { facts, link, ...renderReview(facts, { unsubscribeUrl: link, appUrl: 'https://aimyear.com' }) };
}

/**
 * One due weekly_review pending, already claimed by the tick. Sends the review when every
 * rule holds, records the week, and queues the next Sunday (or a retry this evening).
 */
export async function deliverWeeklyReview(p: Pending, deps: ReviewDeps, now = new Date()): Promise<ReviewResult> {
  const store = deps.storeFor(p.uid);
  const svc = new AimService(store, 'weekly-review', 'mobile');
  const rearm = async () => (await svc.armWeeklyReview(now))?.due_at;
  const prof = await store.getProfile();
  if (prof.weeklyReviewEmail === false) return { sent: 0, failed: 0, reason: 'weekly review email is off' };
  const win = reviewWindow(prof.timezone, now);
  if (!win.open) return { sent: 0, failed: 0, reason: win.reason, continued: await rearm() };
  // Free gets none (pricing.md). Not re-armed: becoming Pro, opening the app or planning arms it again.
  if (!(await deps.isPro(p.uid))) return { sent: 0, failed: 0, reason: 'not Pro' };
  if (!(await svc.getGoal()).goal) return { sent: 0, failed: 0, reason: 'no aim set', continued: await rearm() };
  if (!deps.key) return { sent: 0, failed: 0, reason: 'no unsubscribe key on this server (AIMYEAR_SOCIAL_KEY or AIMYEAR_UNSUBSCRIBE_KEY)', continued: await rearm() };
  const to = await deps.emailOf(p.uid);
  if (!to) return { sent: 0, failed: 0, reason: 'the account has no email', continued: await rearm() };

  const attemptAt = now.toISOString();
  const claim = await store.claimWeeklyReview({ week: win.week, status: 'sending', attemptAt });
  if (!claim.claimed) return { sent: 0, failed: 0, reason: `week of ${win.week} already ${claim.existing.status}`, continued: await rearm() };
  let mail;
  try { mail = await composeReview(svc, p.uid, win.week, deps); }
  catch (e) {
    await store.saveWeeklyReview({ week: win.week, status: 'failed', attemptAt, error: `compose: ${(e as Error).message}`.slice(0, 300) });
    return { sent: 0, failed: 1, reason: 'could not write the review', continued: await rearm() };
  }
  try {
    const { messageId } = await deps.sender.send({
      to, from: deps.from, subject: mail.subject, text: mail.text, html: mail.html,
      headers: { 'List-Unsubscribe': `<${mail.link}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    });
    await store.saveWeeklyReview({ week: win.week, status: 'sent', attemptAt, sentAt: new Date().toISOString(), messageId });
    return { sent: 1, failed: 0, continued: await rearm() };
  } catch (e) {
    await store.saveWeeklyReview({ week: win.week, status: 'failed', attemptAt, error: String((e as Error).name ?? 'error').slice(0, 100) });
    // Try again later this evening; after that the next Sunday.
    const retry = new Date(now.getTime() + RETRY_MS);
    if (reviewWindow(prof.timezone, retry).open) {
      await store.savePending({ ...p, dueAt: retry.toISOString() });
      return { sent: 0, failed: 1, reason: 'the email service refused it; trying again', continued: retry.toISOString() };
    }
    return { sent: 0, failed: 1, reason: 'the email service refused it', continued: await rearm() };
  }
}
