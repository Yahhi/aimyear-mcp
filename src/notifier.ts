import { getMessaging, type BaseMessage } from 'firebase-admin/messaging';
import { Notifications, Store } from './store.js';
import { localDate } from './dates.js';
import { AimService } from './service.js';
import { SocialService } from './social/service.js';
import type { Device, DesktopReminder, Pending, Workplace } from './types.js';

const DESKTOP: Device['platform'][] = ['macos', 'windows', 'web'];
const MOBILE: Device['platform'][] = ['ios', 'android'];

/** Devices that match the workplace the block belongs to; falls back to every device. */
export function pickDevices(devices: Device[], workplace: Workplace): Device[] {
  const want = workplace === 'desktop' ? DESKTOP : MOBILE;
  const matched = devices.filter(d => want.includes(d.platform));
  return matched.length ? matched : devices;
}

export function textFor(p: Pending, mainStep: { title: string; done: boolean } | null): { title: string; body: string } {
  if (p.kind === 'standup') {
    const mins = p.elapsedMin ?? p.minutes;
    if (p.final) {
      const h = Math.floor(mins / 60);
      return { title: 'Timer stopped for you', body: `${h} hours with no stop, so I closed it. Tell Claude the real end time and it will fix the record.` };
    }
    return { title: 'Stand up', body: `${mins} minutes sitting. Walk a little. The timer keeps running.` };
  }
  if (p.kind === 'block_end') {
    return {
      title: 'Stand up',
      body: `${p.minutes} minutes done. Walk for ${p.breakMin}. Your spine, not your streak.`,
    };
  }
  if (mainStep && !mainStep.done) return { title: 'Break over', body: `Main step still open: ${mainStep.title}` };
  if (mainStep && mainStep.done) return { title: 'Break over', body: 'Main step is done today. Anything else is a bonus.' };
  return { title: 'Break over', body: 'Back to it, or stop for today.' };
}

/** Builds the posting service for one user; tests pass a fake. */
export type SocialFor = (uid: string) => Pick<SocialService, 'eveningOffer' | 'armOffer'>;
const realSocialFor: SocialFor = uid => { const store = new Store(uid); return new SocialService(store, new AimService(store, 'tick', 'mobile')); };

/** Pushes one message to the given devices and drops tokens that are gone. */
async function push(uid: string, targets: Device[], message: BaseMessage, notif: Notifications) {
  const res = await getMessaging().sendEachForMulticast({ tokens: targets.map(d => d.token), ...message });
  await Promise.all(res.responses.map(async (r, i) => {
    const code = (r.error as { code?: string } | undefined)?.code ?? '';
    if (!r.success && /registration-token-not-registered|invalid-argument/.test(code)) await notif.dropDevice(uid, targets[i].token);
  }));
  return { sent: res.successCount, failed: res.failureCount };
}

/**
 * The evening offer: the day's draft with a Post action (category AIMYEAR_POST_OFFER).
 * The tap calls POST /social/post with data.date and data.text; nothing is posted here.
 * Pro, and only for networks where the user has not posted that day.
 */
export async function deliverPostOffer(p: Pending, notif: Notifications, socialFor: SocialFor = realSocialFor): Promise<{ sent: number; failed: number; reason?: string }> {
  const offer = await socialFor(p.uid).eveningOffer(p.date ?? '');
  if (!offer.send) return { sent: 0, failed: 0, reason: offer.reason };
  const devices = await notif.devicesOf(p.uid);
  if (!devices.length) return { sent: 0, failed: 0, reason: 'no registered devices' };
  return push(p.uid, pickDevices(devices, 'mobile'), {
    notification: { title: offer.title, body: offer.body },
    data: offer.data,
    apns: { payload: { aps: { sound: 'default', category: 'AIMYEAR_POST_OFFER', 'interruption-level': 'active' } } },
    android: { priority: 'normal', notification: { channelId: 'aimyear_posts', clickAction: 'AIMYEAR_POST_OFFER' } },
  }, notif);
}

/** Sends one reminder. Returns how many devices accepted it. */
export async function deliver(p: Pending, notif: Notifications): Promise<{ sent: number; failed: number; reason?: string }> {
  const devices = await notif.devicesOf(p.uid);
  if (!devices.length) return { sent: 0, failed: 0, reason: 'no registered devices' };
  const targets = pickDevices(devices, p.workplace);
  const profile = await notif.profileOf(p.uid);
  const tz = profile?.timezone ?? 'UTC';
  const mainStep = await notif.mainStepOf(p.uid, localDate(new Date(p.dueAt), tz));
  const { title, body } = textFor(p, mainStep);

  // A token that is gone stays gone: push() drops it so the next reminder is not wasted on it.
  return push(p.uid, targets, {
    notification: { title, body },
    data: { kind: p.kind, blockId: p.blockId },
    apns: { payload: { aps: { sound: 'default', 'interruption-level': p.kind === 'block_end' ? 'time-sensitive' : 'active' } } },
    android: { priority: 'high', notification: { channelId: 'aimyear_timer', sound: 'default' } },
  }, notif);
}

/**
 * A stand-up came due on a running up-timer, so queue the next one on the SAME
 * block. It never creates a block and never ends one: the timer runs until she
 * stops it. This replaces the old auto-restarting pomodoro cadence.
 */
export async function queueNextStandup(p: Pending, notif: Notifications): Promise<string | undefined> {
  if (p.kind !== 'standup') return undefined;
  const prof = await notif.profileOf(p.uid);
  return notif.queueNextStandup(p, prof?.pomodoro.workMin ?? p.minutes);
}

/** A desktop reminder older than this is not worth saying out loud any more. */
const DESKTOP_STALE_MS = 30 * 60000;

export function desktopReminder(p: Pending, mainStep: { title: string; done: boolean } | null, now: Date): DesktopReminder {
  return {
    id: p.id, uid: p.uid, kind: p.kind, ...textFor(p, mainStep), blockId: p.blockId, dueAt: p.dueAt, createdAt: now.toISOString(),
    actions: p.kind === 'standup' && !p.final ? ['break', 'snooze'] : [],
  };
}

/**
 * A claimed desktop reminder: put it where the desktop app pulls from (unless it is too
 * old to say), then keep the stand-up cadence going on the same block. The cadence never
 * depends on a desktop app polling: with no app open, the timer still gets its stand-ups
 * and a forgotten one still closes itself.
 */
export async function produceDesktop(p: Pending, notif: Notifications, now = new Date()): Promise<{ reminder?: DesktopReminder; continued?: string }> {
  let reminder: DesktopReminder | undefined;
  if (Date.parse(p.dueAt) >= now.getTime() - DESKTOP_STALE_MS) {
    const tz = (await notif.profileOf(p.uid))?.timezone ?? 'UTC';
    reminder = desktopReminder(p, await notif.mainStepOf(p.uid, localDate(new Date(p.dueAt), tz)), now);
    await notif.saveDesktopReminder(reminder);
  }
  let continued: string | undefined;
  try { continued = await queueNextStandup(p, notif); } catch (e) { console.error('[desktop] standup re-arm failed', e); }
  return { reminder, continued };
}

/**
 * What a desktop app gets when it polls: its due reminders (claimed here if /tick has not
 * reached them yet) and everything /tick already produced for it, each handed out once.
 */
export async function pullDesktop(uid: string, notif: Notifications, now = new Date()) {
  let continued: string | undefined;
  for (const p of await notif.claimDesktop(uid, now.toISOString())) continued = (await produceDesktop(p, notif, now)).continued ?? continued;
  const reminders = (await notif.takeDesktopReminders(uid))
    .filter(r => Date.parse(r.dueAt) >= now.getTime() - DESKTOP_STALE_MS)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  return { reminders, continued };
}

/**
 * One poll: claim each due reminder, deliver it, and re-arm the next stand-up. The
 * claim (a transactional delete) comes before the push: two overlapping ticks both see
 * a reminder due, but only the one that claims it pushes and re-arms; the other skips.
 * Desktop reminders are not pushed: they go to the desktop inbox that the desktop app
 * pulls (POST /desktop/reminders), and their stand-up cadence is kept here too.
 */
export async function tick(notif: Notifications, now = new Date(), socialFor: SocialFor = realSocialFor) {
  const due = await notif.due(now.toISOString());
  const results: { id: string; kind: string; sent: number; failed: number; reason?: string; continued?: string }[] = [];
  for (const p of due) {
    if (!(await notif.claim(p.id))) continue;
    if (p.workplace === 'desktop' && p.kind !== 'post_offer') {
      const r = await produceDesktop(p, notif, now).catch(e => { console.error('[tick] desktop reminder failed', (e as Error).message); return { reminder: undefined, continued: undefined }; });
      results.push({ id: p.id, kind: p.kind, sent: 0, failed: 0, reason: r.reminder ? 'desktop inbox' : 'desktop, too old to say', continued: r.continued });
      continue;
    }
    if (p.kind === 'post_offer') {
      let r: { sent: number; failed: number; reason?: string };
      try { r = await deliverPostOffer(p, notif, socialFor); } catch (e) { r = { sent: 0, failed: 0, reason: (e as Error).message }; }
      // One offer a day: queue the next evening's, whatever happened to this one.
      let continued: string | undefined;
      try { continued = (await socialFor(p.uid).armOffer())?.due_at; } catch (e) { console.error('[tick] post offer re-arm failed', (e as Error).message); }
      results.push({ id: p.id, kind: p.kind, ...r, continued });
      continue;
    }
    let r: { sent: number; failed: number; reason?: string };
    try { r = await deliver(p, notif); } catch (e) { r = { sent: 0, failed: 0, reason: (e as Error).message }; }
    let continued: string | undefined;
    try { continued = await queueNextStandup(p, notif); } catch (e) { console.error('[tick] standup re-arm failed', e); }
    results.push({ id: p.id, kind: p.kind, ...r, continued });
  }
  return { processed: results.length, results };
}
