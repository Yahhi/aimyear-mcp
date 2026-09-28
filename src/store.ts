import { initializeApp, cert, getApps, applicationDefault } from 'firebase-admin/app';
import { getFirestore, Firestore, FieldValue } from 'firebase-admin/firestore';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Goal, Path, Profile, Day, Block, Session, Mode, Workplace, Commitment, Device, Pending, Direction } from './types.js';

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

  /**
   * Due reminders for one user's desktop, claimed and removed so they fire once.
   * Filters in memory on purpose: uid + workplace + dueAt would need a composite
   * index, and a missing index fails the whole endpoint silently.
   */
  async claimDesktop(uid: string, nowIso: string): Promise<Pending[]> {
    const snap = await this.db.collection(PENDING).where('dueAt', '<=', nowIso).limit(100).get();
    const mine = snap.docs.filter(d => {
      const p = d.data() as Pending;
      return p.uid === uid && p.workplace === 'desktop';
    });
    const rows = mine.map(d => d.data() as Pending);
    await Promise.all(mine.map(d => d.ref.delete()));
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

  /**
   * Queues the NEXT stand-up on the same running block. It does not create a
   * block and does not end one: the timer keeps running until she stops it.
   */
  async queueNextStandup(p: Pending, workMin: number): Promise<string | undefined> {
    const block = await this.db.collection('users').doc(p.uid).collection('blocks').doc(p.blockId).get();
    if (!block.exists) return undefined;
    const b = block.data() as Block;
    if (b.ended || b.cancelled || b.direction !== 'up') return undefined;
    const id = `${p.blockId}-standup-${Date.now()}`;
    await this.db.collection(PENDING).doc(id).set({
      id, uid: p.uid, blockId: p.blockId, workplace: p.workplace,
      minutes: workMin, breakMin: p.breakMin, kind: 'standup',
      dueAt: new Date(Date.now() + workMin * 60000).toISOString(),
    });
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
    const lowerBound = new Date(Date.now() - 24 * 3600000).toISOString();
    const snap = await this.blocks().where('start', '>=', lowerBound).get();
    const now = Date.now();
    const running = snap.docs.map(d => d.data() as Block)
      // An up-timer has no end: it runs until it is ended or cancelled.
      .filter(b => !b.ended && !b.cancelled && (b.direction === 'up' || !b.endsAt || new Date(b.endsAt).getTime() > now));
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
