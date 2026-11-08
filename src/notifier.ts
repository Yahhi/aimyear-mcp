import type { BaseMessage } from 'firebase-admin/messaging';
import { Notifications, Store } from './store.js';
import { syncLive } from './live.js';
import { localDate } from './dates.js';
import { AimService } from './service.js';
import { SocialService } from './social/service.js';
import type { Device, DesktopReminder, Pending } from './types.js';
import { deliverWeeklyReview, type ReviewDeps } from './review/deliver.js';
import { pushTo, type Multicast } from './push.js';

export type { Multicast };

const PHONES: Device['platform'][] = ['ios', 'android'];

/**
 * Every device gets every reminder, whichever device or agent started the timer
 * (docs/notifications.md, 2026-11-07; before, only the block's workplace did).
 * The phones get a push. The desktop apps (macOS, Windows) get the stand-ups from the
 * desktop inbox they pull, with Break and Snooze, so the Mac is not pushed those too
 * (it would show each one twice). The evening post offer is not in the inbox, so it is
 * pushed to every device, the Mac included.
 */
export function pushTargets(devices: Device[], kind: Pending['kind']): Device[] {
  if (kind === 'post_offer') return devices;
  return devices.filter(d => PHONES.includes(d.platform));
}

/**
 * What a delivery reaches outside the reminder store: FCM, the Live Activity of a user's
 * phones, and the weekly review email (SES; without it a due review is not sent).
 */
export interface Deps { multicast?: Multicast; liveFor?: (uid: string) => Promise<unknown>; reviews?: () => ReviewDeps }
const realLiveFor = (uid: string) => syncLive(new Store(uid));

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
export type SocialFor = (uid: string) => Pick<SocialService, 'eveningOffer' | 'armOffer' | 'sendAutoPost'>;
const realSocialFor: SocialFor = uid => { const store = new Store(uid); return new SocialService(store, new AimService(store, 'tick', 'mobile')); };

/** Pushes one message to the given devices and drops tokens that are gone. */
const push = (uid: string, targets: Device[], message: BaseMessage, notif: Notifications, multicast?: Multicast) =>
  pushTo(targets, message, token => notif.dropDevice(uid, token), multicast);

/**
 * The evening offer: the day's draft with a Post action (category AIMYEAR_POST_OFFER).
 * The tap calls POST /social/post with data.date and data.text; nothing is posted here.
 * Pro, and only for networks where the user has not posted that day.
 */
export async function deliverPostOffer(p: Pending, notif: Notifications, socialFor: SocialFor = realSocialFor, multicast?: Multicast): Promise<{ sent: number; failed: number; reason?: string }> {
  const offer = await socialFor(p.uid).eveningOffer(p.date ?? '');
  if (!offer.send) return { sent: 0, failed: 0, reason: offer.reason };
  const devices = await notif.devicesOf(p.uid);
  if (!devices.length) return { sent: 0, failed: 0, reason: 'no registered devices' };
  return push(p.uid, pushTargets(devices, p.kind), {
    notification: { title: offer.title, body: offer.body },
    data: offer.data,
    apns: { payload: { aps: { sound: 'default', category: 'AIMYEAR_POST_OFFER', 'interruption-level': 'active' } } },
    android: { priority: 'normal', notification: { channelId: 'aimyear_posts', clickAction: 'AIMYEAR_POST_OFFER' } },
  }, notif, multicast);
}

/** Pushes one reminder to the phones. Returns how many devices accepted it. */
export async function deliver(p: Pending, notif: Notifications, multicast?: Multicast): Promise<{ sent: number; failed: number; reason?: string }> {
  const devices = await notif.devicesOf(p.uid);
  if (!devices.length) return { sent: 0, failed: 0, reason: 'no registered devices' };
  const targets = pushTargets(devices, p.kind);
  if (!targets.length) return { sent: 0, failed: 0, reason: 'no phone registered' };
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
  }, notif, multicast);
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
 * A claimed stand-up, stop or break-over reminder, to every device: pushed to the phones,
 * and put where the desktop apps pull from (unless it is too old to say). Then the
 * stand-up cadence goes on on the same block. The cadence never depends on a desktop app
 * polling: with no app open, the timer still gets its stand-ups and a forgotten one still
 * closes itself (and its Live Activity ends).
 */
export async function fanOut(p: Pending, notif: Notifications, now = new Date(), deps: Deps = {}): Promise<{ sent: number; failed: number; reason?: string; reminder?: DesktopReminder; continued?: string }> {
  let r: { sent: number; failed: number; reason?: string };
  try { r = await deliver(p, notif, deps.multicast); } catch (e) { r = { sent: 0, failed: 0, reason: (e as Error).message }; }
  let reminder: DesktopReminder | undefined;
  try {
    if (Date.parse(p.dueAt) >= now.getTime() - DESKTOP_STALE_MS) {
      const tz = (await notif.profileOf(p.uid))?.timezone ?? 'UTC';
      reminder = desktopReminder(p, await notif.mainStepOf(p.uid, localDate(new Date(p.dueAt), tz)), now);
      await notif.saveDesktopReminder(reminder);
    }
  } catch (e) { console.error('[remind] desktop inbox failed', (e as Error).message); }
  let continued: string | undefined;
  try { continued = await queueNextStandup(p, notif); } catch (e) { console.error('[remind] standup re-arm failed', e); }
  // The last stand-up closed a forgotten timer: the phone's Live Activity ends with it.
  if (p.kind === 'standup' && p.final) await (deps.liveFor ?? realLiveFor)(p.uid).catch(e => console.error('[remind] live end failed', (e as Error).message));
  const reason = [r.reason, reminder ? 'desktop inbox' : 'desktop, too old to say'].filter(Boolean).join('; ');
  return { sent: r.sent, failed: r.failed, reason, reminder, continued };
}

/**
 * What a desktop app gets when it polls: its due reminders (claimed here if /tick has not
 * reached them yet, and then pushed to the phones too) and everything /tick already
 * produced for it, each handed out once.
 */
export async function pullDesktop(uid: string, notif: Notifications, now = new Date(), deps: Deps = {}) {
  let continued: string | undefined;
  for (const p of await notif.claimDesktop(uid, now.toISOString())) continued = (await fanOut(p, notif, now, deps)).continued ?? continued;
  const reminders = (await notif.takeDesktopReminders(uid))
    .filter(r => Date.parse(r.dueAt) >= now.getTime() - DESKTOP_STALE_MS)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  return { reminders, continued };
}

/**
 * One poll: claim each due reminder, deliver it to every device, and re-arm the next
 * stand-up; send the automatic WIP todos whose undo is over. The claim (a transactional
 * delete) comes before the push: two overlapping ticks both see a reminder due, but only
 * the one that claims it pushes and re-arms; the
 * other skips. Whatever the block's workplace, the phones get a push and the desktop
 * apps find it in the desktop inbox they pull (POST /desktop/reminders).
 */
export async function tick(notif: Notifications, now = new Date(), socialFor: SocialFor = realSocialFor, deps: Deps = {}) {
  const due = await notif.due(now.toISOString());
  // Without a desktop app polling, its reminders would pile up: drop the ones too old to say.
  try { await notif.dropStaleDesktopReminders(new Date(now.getTime() - DESKTOP_STALE_MS).toISOString()); } catch (e) { console.error('[tick] desktop sweep failed', (e as Error).message); }
  const results: { id: string; kind: string; sent: number; failed: number; reason?: string; continued?: string }[] = [];
  for (const p of due) {
    if (!(await notif.claim(p.id))) continue;
    if (p.kind === 'weekly_review') {
      // The weekly review email (src/review/deliver.ts): Sunday 19:00 local, Pro, once a week.
      let r: { sent: number; failed: number; reason?: string; continued?: string };
      try {
        if (!deps.reviews) throw new Error('weekly review email is not set up on this server');
        r = await deliverWeeklyReview(p, deps.reviews(), now);
      } catch (e) { console.error('[tick] weekly review failed', (e as Error).message); r = { sent: 0, failed: 0, reason: (e as Error).message }; }
      results.push({ id: p.id, kind: p.kind, ...r });
      continue;
    }
    if (p.kind === 'auto_post') {
      // An automatic WIP todo whose 10 minutes of undo are over (docs/public-posting.md): sent once.
      let r: { sent: number; failed: number; reason?: string };
      try { r = p.autoPostId ? await socialFor(p.uid).sendAutoPost(p.autoPostId, now) : { sent: 0, failed: 0, reason: 'no auto post id' }; }
      catch (e) { console.error('[tick] auto post failed', (e as Error).message); r = { sent: 0, failed: 0, reason: (e as Error).message }; }
      results.push({ id: p.id, kind: p.kind, ...r });
      continue;
    }
    if (p.kind === 'post_offer') {
      let r: { sent: number; failed: number; reason?: string };
      try { r = await deliverPostOffer(p, notif, socialFor, deps.multicast); } catch (e) { r = { sent: 0, failed: 0, reason: (e as Error).message }; }
      // One offer a day: queue the next evening's, whatever happened to this one.
      let continued: string | undefined;
      try { continued = (await socialFor(p.uid).armOffer())?.due_at; } catch (e) { console.error('[tick] post offer re-arm failed', (e as Error).message); }
      results.push({ id: p.id, kind: p.kind, ...r, continued });
      continue;
    }
    const r = await fanOut(p, notif, now, deps);
    results.push({ id: p.id, kind: p.kind, sent: r.sent, failed: r.failed, reason: r.reason, continued: r.continued });
  }
  return { processed: results.length, results };
}
