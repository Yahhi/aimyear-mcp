import { getMessaging } from 'firebase-admin/messaging';
import { Notifications } from './store.js';
import { localDate } from './dates.js';
import type { Device, Pending, Workplace } from './types.js';

const DESKTOP: Device['platform'][] = ['macos', 'web'];
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

/** Sends one reminder. Returns how many devices accepted it. */
export async function deliver(p: Pending, notif: Notifications): Promise<{ sent: number; failed: number; reason?: string }> {
  const devices = await notif.devicesOf(p.uid);
  if (!devices.length) return { sent: 0, failed: 0, reason: 'no registered devices' };
  const targets = pickDevices(devices, p.workplace);
  const profile = await notif.profileOf(p.uid);
  const tz = profile?.timezone ?? 'UTC';
  const mainStep = await notif.mainStepOf(p.uid, localDate(new Date(p.dueAt), tz));
  const { title, body } = textFor(p, mainStep);

  const res = await getMessaging().sendEachForMulticast({
    tokens: targets.map(d => d.token),
    notification: { title, body },
    data: { kind: p.kind, blockId: p.blockId },
    apns: { payload: { aps: { sound: 'default', 'interruption-level': p.kind === 'block_end' ? 'time-sensitive' : 'active' } } },
    android: { priority: 'high', notification: { channelId: 'aimyear_timer', sound: 'default' } },
  });

  // A token that is gone stays gone: drop it so the next reminder is not wasted on it.
  await Promise.all(res.responses.map(async (r, i) => {
    const code = (r.error as { code?: string } | undefined)?.code ?? '';
    if (!r.success && /registration-token-not-registered|invalid-argument/.test(code)) {
      await notif.dropDevice(p.uid, targets[i].token);
    }
  }));
  return { sent: res.successCount, failed: res.failureCount };
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

/**
 * One poll: claim each due reminder, deliver it, and re-arm the next stand-up. The
 * claim (a transactional delete) comes before the push: two overlapping ticks both see
 * a reminder due, but only the one that claims it pushes and re-arms; the other skips.
 */
export async function tick(notif: Notifications, now = new Date()) {
  const all = await notif.due(now.toISOString());
  // Desktop reminders are pulled by the Mac agent, not pushed. Drop only the ones
  // too old to be worth saying out loud, so the queue cannot grow without bound.
  const stale = new Date(now.getTime() - 30 * 60000).toISOString();
  const due = all.filter(p => p.workplace !== 'desktop');
  for (const p of all) if (p.workplace === 'desktop' && p.dueAt < stale) await notif.remove(p.id);
  const results: { id: string; kind: string; sent: number; failed: number; reason?: string; continued?: string }[] = [];
  for (const p of due) {
    if (!(await notif.claim(p.id))) continue;
    let r: { sent: number; failed: number; reason?: string };
    try { r = await deliver(p, notif); } catch (e) { r = { sent: 0, failed: 0, reason: (e as Error).message }; }
    let continued: string | undefined;
    try { continued = await queueNextStandup(p, notif); } catch (e) { console.error('[tick] standup re-arm failed', e); }
    results.push({ id: p.id, kind: p.kind, ...r, continued });
  }
  return { processed: results.length, results };
}
