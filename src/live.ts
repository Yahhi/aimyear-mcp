import { getMessaging, type Message } from 'firebase-admin/messaging';
import type { Device, Goal, Session } from './types.js';

/**
 * The running timer on the iPhone: a Live Activity on the Lock Screen and in the Dynamic
 * Island (docs/notifications.md), started, updated and ended by push through FCM HTTP v1
 * (apns.live_activity_token, https://firebase.google.com/docs/cloud-messaging/customize-messages/live-activity).
 *
 *  - start: to the device's push-to-start token (iOS 17.2+), once per timer run;
 *  - update / end: to the push token of the activity the phone reported (POST
 *    /devices/live-activity), when a session starts, stops or changes.
 *
 * The phone draws the time itself from startedAt (a self-updating timer), so nothing is
 * pushed while the timer just runs. Only registered devices get this, and Free accounts
 * register none (docs/pricing.md).
 */

/** The Swift type in the app (ios/LiveTimer/AimTimerAttributes.swift): the push names it. */
export const ATTRIBUTES_TYPE = 'AimTimerAttributes';

/** The activity's content. Keys match AimTimerAttributes.ContentState in the app. */
export interface LiveContent {
  sessionId: string;
  task: string;
  /** Unix seconds: the session start the phone counts up from. */
  startedAt: number;
  /** "Main step · <the aim>", or just the aim. */
  detail: string;
  /** Sessions running now; the activity shows "+N more" when there are several. */
  count: number;
}

/** A timer this old looks forgotten: the server closes it at about this age (notifier, final stand-up). */
const STALE_AFTER_S = 4 * 3600;

export type SendLive = (m: Message) => Promise<string>;
const realSend: SendLive = m => getMessaging().send(m);

/** What syncLive needs from a user's store (src/store.ts Store). */
export interface LiveStore {
  getDevices(): Promise<Device[]>;
  saveDevice(d: Device): Promise<void>;
  getRunningSessions(): Promise<Session[]>;
  getGoal(): Promise<Goal | null>;
}

/** The session the activity shows: like the app's timer screen, the newest one started in an app, else the newest. */
export function currentSession(running: Session[]): Session | null {
  if (!running.length) return null;
  const sorted = [...running].sort((a, b) => b.start.localeCompare(a.start));
  return sorted.find(s => s.agent === 'app') ?? sorted[0];
}

export function liveContent(running: Session[], goal: Goal | null): LiveContent | null {
  const s = currentSession(running);
  if (!s) return null;
  const detail = [s.classification === 'main_step' ? 'Main step' : null, goal?.title ?? null].filter(Boolean).join(' · ');
  return { sessionId: s.id, task: s.task, startedAt: Math.floor(Date.parse(s.start) / 1000), detail, count: running.length };
}

type LiveEvent = 'start' | 'update' | 'end';

/** One FCM HTTP v1 message for a Live Activity. `fcmToken` addresses the app, `liveToken` the activity. */
export function liveMessage(event: LiveEvent, fcmToken: string, liveToken: string, content: LiveContent | null, now = new Date()): Message {
  const ts = Math.floor(now.getTime() / 1000);
  // An end carries the last state the phone had; with nothing running there is none, so an empty one.
  const state = content ?? { sessionId: '', task: '', startedAt: ts, detail: '', count: 0 };
  const aps: Record<string, unknown> = { timestamp: ts, event, 'content-state': state };
  if (event === 'start') {
    aps['attributes-type'] = ATTRIBUTES_TYPE;
    aps.attributes = {};
    // A push-to-start needs an alert; no sound, so a timer started on the Mac does not ring the phone.
    aps.alert = { title: state.task, body: state.detail ? `Timer running · ${state.detail}` : 'Timer running' };
  }
  if (event !== 'end') aps['stale-date'] = state.startedAt + STALE_AFTER_S;
  else aps['dismissal-date'] = ts; // gone from the Lock Screen at once: the timer stopped
  return {
    token: fcmToken,
    apns: {
      liveActivityToken: liveToken,
      headers: { 'apns-push-type': 'liveactivity', 'apns-priority': '10' },
      payload: { aps },
    },
  };
}

export interface LiveResult { device: string; event: LiveEvent; ok: boolean; error?: string }

/** The activity's token is gone (ended on the phone, app deleted): forget it. */
const GONE = /registration-token-not-registered|invalid-argument|unregistered|not-found/i;

/**
 * Brings every registered iPhone's Live Activity in line with what runs now: start it
 * (push-to-start, once per timer run), update it, or end it. Call after anything that
 * starts, stops or changes a session. `only` limits it to one device (its FCM token).
 * Never throws: a failed push must not fail the write that caused it.
 */
export async function syncLive(store: LiveStore, opts: { send?: SendLive; now?: Date; only?: string } = {}): Promise<LiveResult[]> {
  const send = opts.send ?? realSend;
  const now = opts.now ?? new Date();
  const out: LiveResult[] = [];
  try {
    const phones = (await store.getDevices()).filter(d => d.platform === 'ios' && (d.liveStartToken || d.liveToken || d.liveStartedAt) && (!opts.only || d.token === opts.only));
    if (!phones.length) return out;
    const running = await store.getRunningSessions();
    const content = running.length ? liveContent(running, await store.getGoal()) : null;
    for (const d of phones) {
      const next: Device = { ...d };
      const push = async (event: LiveEvent, liveToken: string) => {
        try {
          await send(liveMessage(event, d.token, liveToken, content, now));
          out.push({ device: `…${d.token.slice(-8)}`, event, ok: true });
          return true;
        } catch (e) {
          const code = `${(e as { code?: string }).code ?? ''} ${(e as Error).message ?? ''}`;
          out.push({ device: `…${d.token.slice(-8)}`, event, ok: false, error: code.trim().slice(0, 120) });
          if (GONE.test(code)) { if (event === 'start') next.liveStartToken = null; else next.liveToken = null; }
          return false;
        }
      };
      if (content) {
        if (d.liveToken) await push('update', d.liveToken);
        else if (d.liveStartToken && !d.liveStartedAt) { if (await push('start', d.liveStartToken)) next.liveStartedAt = now.toISOString(); }
      } else {
        if (d.liveToken) { await push('end', d.liveToken); next.liveToken = null; }
        next.liveStartedAt = null;
      }
      if (next.liveToken !== d.liveToken || next.liveStartToken !== d.liveStartToken || next.liveStartedAt !== d.liveStartedAt) await store.saveDevice(next);
    }
  } catch (e) {
    console.error('[live] sync failed', (e as Error).message);
  }
  return out;
}

/**
 * What the phone tells the server (POST /devices/live-activity): its push-to-start token,
 * the push token of the activity it shows now, or that the activity with that token
 * ended (swiped away, or ended by the phone). null clears a token. A new activity
 * token gets the current state at once, so a change made before it arrived is not lost.
 */
export async function reportLive(store: LiveStore, fcmToken: string, report: { startToken?: string | null; activityToken?: string | null; ended?: boolean }, send?: SendLive) {
  const d = (await store.getDevices()).find(x => x.token === fcmToken);
  if (!d) return { ok: false as const, reason: 'device not registered' };
  const next: Device = { ...d, lastSeen: new Date().toISOString() };
  if (report.startToken !== undefined) next.liveStartToken = report.startToken || null;
  if (report.ended) {
    // The activity with that token is gone; an older one ending must not clear the one that shows.
    if (!report.activityToken || report.activityToken === d.liveToken) {
      next.liveToken = null;
      // Swiped away while the timer runs: not started again for this run (cleared when it stops).
      if ((await store.getRunningSessions()).length) next.liveStartedAt = next.liveStartedAt ?? new Date().toISOString();
    }
  } else if (report.activityToken !== undefined) next.liveToken = report.activityToken || null;
  await store.saveDevice(next);
  const sent = report.activityToken && !report.ended ? await syncLive(store, { send, only: fcmToken }) : [];
  return { ok: true as const, start_token: !!next.liveStartToken, activity: !!next.liveToken, sent };
}
