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

/** One poll: deliver everything due, clear it, and keep the cadence going. */
export async function tick(notif: Notifications, now = new Date()) {
  const all = await notif.due(now.toISOString());
  // Desktop reminders are pulled by the Mac agent, not pushed. Drop only the ones
  // too old to be worth saying out loud, so the queue cannot grow without bound.
  const stale = new Date(now.getTime() - 30 * 60000).toISOString();
  const due = all.filter(p => p.workplace !== 'desktop');
  for (const p of all) if (p.workplace === 'desktop' && p.dueAt < stale) await notif.remove(p.id);
  const results: { id: string; kind: string; sent: number; failed: number; reason?: string; continued?: string }[] = [];
  for (const p of due) {
    let r: { sent: number; failed: number; reason?: string };
    try { r = await deliver(p, notif); } catch (e) { r = { sent: 0, failed: 0, reason: (e as Error).message }; }
    await notif.remove(p.id);
    let continued: string | undefined;
    // The break is over and she is still in a session, so the timer should keep
    // cycling. Otherwise one block is all she ever gets reminded about.
    if (p.kind === 'break_end') {
      try {
        const running = await notif.runningSessionsOf(p.uid);
        // A break is recorded as a session too. Do not start another work block
        // just because she is still walking.
        const working = running.filter(x => x.area !== 'health');
        if (working.length) {
          const prof = await notif.profileOf(p.uid);
          continued = await notif.continueCadence(
            p.uid, p.workplace,
            prof?.pomodoro.workMin ?? p.minutes,
            prof?.pomodoro.breakMin ?? p.breakMin,
            prof?.pomodoro.standup ?? true,
          );
        }
      } catch (e) { console.error('[tick] cadence continue failed', e); }
    }
    results.push({ id: p.id, kind: p.kind, ...r, continued });
  }
  return { processed: due.length, results };
}
