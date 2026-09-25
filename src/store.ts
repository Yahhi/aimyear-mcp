import { initializeApp, cert, getApps, applicationDefault } from 'firebase-admin/app';
import { getFirestore, Firestore, FieldValue } from 'firebase-admin/firestore';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Goal, Path, Profile, Day, Block, Session, Mode, Workplace, Commitment, Device, Pending } from './types.js';

let dbSingleton: Firestore | null = null;
function initFirestore(): Firestore {
  if (dbSingleton) return dbSingleton;
  if (getApps().length === 0) {
    const saPath = process.env.AIMYEAR_SERVICE_ACCOUNT ?? `${process.env.HOME}/.aimyear/service-account.json`;
    if (existsSync(saPath)) {
      const sa = JSON.parse(readFileSync(saPath, 'utf8'));
      initializeApp({ credential: cert(sa), projectId: sa.project_id });
    } else {
      initializeApp({ credential: applicationDefault(), projectId: process.env.AIMYEAR_PROJECT ?? 'aimyear-app' });
    }
  }
  const db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });
  dbSingleton = db;
  return db;
}

export const newId = () => randomUUID().slice(0, 12);

/** Reminders live in one top-level collection so /tick needs a single-field index only. */
export const PENDING = 'pending_notifications';

/** Cross-user helpers used by the /tick endpoint. */
export class Notifications {
  private db: Firestore;
  constructor(db?: Firestore) { this.db = db ?? initFirestore(); }
  async due(nowIso: string, limit = 50): Promise<Pending[]> {
    const snap = await this.db.collection(PENDING).where('dueAt', '<=', nowIso).limit(limit).get();
    return snap.docs.map(d => d.data() as Pending);
  }
  async remove(id: string) { await this.db.collection(PENDING).doc(id).delete(); }

  /** Due reminders for one user's desktop, claimed and removed so they fire once. */
  async claimDesktop(uid: string, nowIso: string): Promise<Pending[]> {
    const snap = await this.db.collection(PENDING)
      .where('uid', '==', uid).where('workplace', '==', 'desktop').where('dueAt', '<=', nowIso).limit(20).get();
    const rows = snap.docs.map(d => d.data() as Pending);
    await Promise.all(snap.docs.map(d => d.ref.delete()));
    return rows;
  }
  async devicesOf(uid: string): Promise<Device[]> {
    const snap = await this.db.collection('users').doc(uid).collection('devices').get();
    return snap.docs.map(d => d.data() as Device).filter(d => !!d.token);
  }
  async dropDevice(uid: string, token: string) {
    const snap = await this.db.collection('users').doc(uid).collection('devices').where('token', '==', token).get();
    await Promise.all(snap.docs.map(d => d.ref.delete()));
  }
  async mainStepOf(uid: string, date: string): Promise<{ title: string; done: boolean } | null> {
    const snap = await this.db.collection('users').doc(uid).collection('days').doc(date).get();
    if (!snap.exists) return null;
    const plan = (snap.data() as Day).plan ?? [];
    const main = plan.find(p => p.isMainStep);
    return main ? { title: main.title, done: main.done } : null;
  }
  /** Sessions still open for a user, ignoring ones stale enough to be a forgotten timer. */
  async runningSessionsOf(uid: string, maxAgeHours = 6): Promise<Session[]> {
    const lower = new Date(Date.now() - maxAgeHours * 3600000).toISOString();
    const snap = await this.db.collection('users').doc(uid).collection('sessions').where('start', '>=', lower).get();
    return snap.docs.map(d => d.data() as Session).filter(x => !x.end);
  }

  /** Starts the next work block of a cadence and queues its reminders. */
  async continueCadence(uid: string, workplace: Workplace, minutes: number, breakMin: number, standup: boolean): Promise<string> {
    const id = newId();
    const start = new Date();
    const endsAt = new Date(start.getTime() + minutes * 60000).toISOString();
    await this.db.collection('users').doc(uid).collection('blocks').doc(id).set({
      id, start: start.toISOString(), endsAt, kind: 'work', minutes, workplace, ended: false, cancelled: false, autoContinued: true,
    });
    const base = { uid, blockId: id, workplace, minutes, breakMin };
    await this.db.collection(PENDING).doc(`${id}-end`).set({ ...base, id: `${id}-end`, dueAt: endsAt, kind: 'block_end' });
    if (standup) {
      await this.db.collection(PENDING).doc(`${id}-break`).set({ ...base, id: `${id}-break`, dueAt: new Date(new Date(endsAt).getTime() + breakMin * 60000).toISOString(), kind: 'break_end' });
    }
    return id;
  }

  async profileOf(uid: string): Promise<Profile | null> {
    const snap = await this.db.collection('users').doc(uid).collection('aim').doc('profile').get();
    return snap.exists ? (snap.data() as Profile) : null;
  }
}

export const DEFAULT_PROFILE = (tz: string): Profile => ({
  timezone: tz,
  pomodoro: { workMin: 25, breakMin: 5, longBreakEvery: 4, longBreakMin: 15, standup: true },
  defaultMode: 'full',
  defaultWorkplace: 'desktop',
});

/** All persistence for one user. Collections live under users/{uid}. */
export class Store {
  private db: Firestore;
  constructor(public readonly uid: string, db?: Firestore) {
    this.db = db ?? initFirestore();
  }

  private user() { return this.db.collection('users').doc(this.uid); }
  private aimDoc(name: 'goal' | 'path' | 'profile' | 'commitments') { return this.user().collection('aim').doc(name); }
  private days() { return this.user().collection('days'); }
  private sessions() { return this.user().collection('sessions'); }
  private blocks() { return this.user().collection('blocks'); }

  // --- profile ---
  async getProfile(): Promise<Profile> {
    const snap = await this.aimDoc('profile').get();
    if (snap.exists) return { ...DEFAULT_PROFILE('UTC'), ...(snap.data() as Partial<Profile>) } as Profile;
    const tz = process.env.AIMYEAR_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
    const p = DEFAULT_PROFILE(tz);
    await this.aimDoc('profile').set(p);
    return p;
  }
  async saveProfile(p: Profile) { await this.aimDoc('profile').set(p); }

  // --- goal & path ---
  async getGoal(): Promise<Goal | null> {
    const snap = await this.aimDoc('goal').get();
    return snap.exists ? (snap.data() as Goal) : null;
  }
  async saveGoal(g: Goal) { await this.aimDoc('goal').set(g); }

  async getPath(): Promise<Path> {
    const snap = await this.aimDoc('path').get();
    return snap.exists ? (snap.data() as Path) : { milestones: [], steps: [] };
  }
  async savePath(p: Path) { await this.aimDoc('path').set(p); }

  async getCommitments(): Promise<Commitment[]> {
    const snap = await this.aimDoc('commitments').get();
    return snap.exists ? ((snap.data() as { items: Commitment[] }).items ?? []) : [];
  }
  async saveCommitments(items: Commitment[]) { await this.aimDoc('commitments').set({ items }); }

  // --- days ---
  async getDay(date: string): Promise<Day | null> {
    const snap = await this.days().doc(date).get();
    return snap.exists ? (snap.data() as Day) : null;
  }
  async getOrCreateDay(date: string, defaultMode: Mode): Promise<Day> {
    const d = await this.getDay(date);
    if (d) return d;
    const now = new Date().toISOString();
    const fresh: Day = { date, mode: defaultMode, plan: [], createdAt: now, updatedAt: now };
    await this.days().doc(date).set(fresh);
    return fresh;
  }
  async saveDay(d: Day) { d.updatedAt = new Date().toISOString(); await this.days().doc(d.date).set(d); }
  async getDaysInRange(from: string, to: string): Promise<Day[]> {
    const snap = await this.days().where('date', '>=', from).where('date', '<=', to).get();
    return snap.docs.map(d => d.data() as Day);
  }

  // --- sessions ---
  async saveSession(s: Session) { await this.sessions().doc(s.id).set(s); }
  async getSession(id: string): Promise<Session | null> {
    const snap = await this.sessions().doc(id).get();
    return snap.exists ? (snap.data() as Session) : null;
  }
  async deleteSession(id: string) { await this.sessions().doc(id).delete(); }
  /** Sessions overlapping [fromIso, toIso). Running sessions (no end) count as overlapping if they started before toIso. */
  async getSessionsOverlapping(fromIso: string, toIso: string): Promise<Session[]> {
    // Firestore can only range on one field: take everything started before toIso and filter in memory.
    // Bound the scan to sessions started within the last 2 days before fromIso (a session never legitimately spans longer).
    const lowerBound = new Date(new Date(fromIso).getTime() - 2 * 86400000).toISOString();
    const snap = await this.sessions().where('start', '>=', lowerBound).where('start', '<', toIso).get();
    return snap.docs.map(d => d.data() as Session).filter(s => (s.end ?? '9999') > fromIso);
  }
  async getRunningSessions(): Promise<Session[]> {
    const lowerBound = new Date(Date.now() - 2 * 86400000).toISOString();
    const snap = await this.sessions().where('start', '>=', lowerBound).get();
    return snap.docs.map(d => d.data() as Session).filter(s => !s.end);
  }

  // --- devices ---
  private devices() { return this.user().collection('devices'); }
  async saveDevice(d: Device) { await this.devices().doc(d.token.slice(-40)).set(d, { merge: true }); }
  async getDevices(): Promise<Device[]> {
    const snap = await this.devices().get();
    return snap.docs.map(x => x.data() as Device).filter(x => !!x.token);
  }
  async removeDevice(token: string) { await this.devices().doc(token.slice(-40)).delete(); }

  // --- pending reminders ---
  async savePending(p: Pending) { await this.db.collection(PENDING).doc(p.id).set(p); }
  async clearPendings(blockId: string) {
    const snap = await this.db.collection(PENDING).where('uid', '==', this.uid).where('blockId', '==', blockId).get();
    await Promise.all(snap.docs.map(d => d.ref.delete()));
  }

  // --- blocks ---
  async saveBlock(b: Block) { await this.blocks().doc(b.id).set(b); }
  async getRunningBlock(): Promise<Block | null> {
    const lowerBound = new Date(Date.now() - 6 * 3600000).toISOString();
    const snap = await this.blocks().where('start', '>=', lowerBound).get();
    const now = Date.now();
    const running = snap.docs.map(d => d.data() as Block).filter(b => !b.ended && !b.cancelled && new Date(b.endsAt).getTime() > now);
    running.sort((a, b) => b.start.localeCompare(a.start));
    return running[0] ?? null;
  }
  async getBlocksInRange(fromIso: string, toIso: string): Promise<Block[]> {
    const snap = await this.blocks().where('start', '>=', fromIso).where('start', '<', toIso).get();
    return snap.docs.map(d => d.data() as Block);
  }
}

export { FieldValue };
export type { Workplace };
