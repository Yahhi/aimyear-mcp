import { initializeApp, cert, getApps, applicationDefault } from 'firebase-admin/app';
import { getFirestore, Firestore, FieldValue } from 'firebase-admin/firestore';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Goal, Path, Profile, Day, Block, Session, Mode, Workplace } from './types.js';

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
  private aimDoc(name: 'goal' | 'path' | 'profile') { return this.user().collection('aim').doc(name); }
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
