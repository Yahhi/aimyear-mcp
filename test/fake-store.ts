import { DEFAULT_PROFILE, plainOp, type Tx } from '../src/store.js';
import type { AppliedOp, Block, Commitment, Day, Device, Goal, Mode, Path, Pending, Profile, Routine, Session } from '../src/types.js';

/** The Store's interface kept in memory, so service logic can be tested without Firestore. */
export class FakeStore {
  readonly uid = 'fake';
  profile: Profile = DEFAULT_PROFILE('Europe/Madrid');
  goal: Goal | null = null;
  path: Path = { milestones: [], steps: [] };
  commitments: Commitment[] = [];
  routines: Routine[] = [];
  days = new Map<string, Day>();
  sessions = new Map<string, Session>();
  blocks = new Map<string, Block>();
  devices = new Map<string, Device>();
  pendings = new Map<string, Pending>();
  ops = new Map<string, AppliedOp>();
  /** Every write that reached the store (sessions, ops, path), so a test can assert "nothing written". */
  writes = 0;

  async getOp(id: string) { const o = this.ops.get(id); return o ? structuredClone(o) : null; }
  /** Reads see the store as it is; writes are buffered and land together at the end, like a Firestore transaction. */
  async runTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const pending: (() => void)[] = [];
    const tx: Tx = {
      getOp: id => this.getOp(id),
      getSession: id => this.getSession(id),
      getPath: () => this.getPath(),
      saveOp: (id, op) => { pending.push(() => { this.ops.set(id, structuredClone(plainOp(op))); this.writes++; }); },
      saveSession: s => { const copy = structuredClone(s); pending.push(() => { this.sessions.set(copy.id, copy); this.writes++; }); },
      deleteSession: id => { pending.push(() => { this.sessions.delete(id); this.writes++; }); },
      savePath: p => { const copy = structuredClone(p); pending.push(() => { this.path = copy; this.writes++; }); },
    };
    const out = await fn(tx);
    for (const w of pending) w();
    return out;
  }

  async getProfile() { return structuredClone(this.profile); }
  async saveProfile(p: Profile) { this.profile = structuredClone(p); }
  async getGoal() { return structuredClone(this.goal); }
  async saveGoal(g: Goal) { this.goal = structuredClone(g); }
  async getPath() { return structuredClone(this.path); }
  async savePath(p: Path) { this.path = structuredClone(p); this.writes++; }
  async getCommitments() { return structuredClone(this.commitments); }
  async saveCommitments(c: Commitment[]) { this.commitments = structuredClone(c); }
  async getRoutines() { return structuredClone(this.routines); }
  async saveRoutines(r: Routine[]) { this.routines = structuredClone(r); }
  async getDay(date: string) { const d = this.days.get(date); return d ? structuredClone(d) : null; }
  async getOrCreateDay(date: string, mode: Mode) {
    if (!this.days.has(date)) this.days.set(date, { date, mode, plan: [], createdAt: '', updatedAt: '' });
    return structuredClone(this.days.get(date)!);
  }
  async saveDay(d: Day) { this.days.set(d.date, structuredClone(d)); }
  async getDaysInRange(from: string, to: string) { return [...this.days.values()].filter(d => d.date >= from && d.date <= to).map(d => structuredClone(d)); }
  async saveSession(s: Session) { this.sessions.set(s.id, structuredClone(s)); this.writes++; }
  async getSession(id: string) { const s = this.sessions.get(id); return s ? structuredClone(s) : null; }
  async deleteSession(id: string) { this.sessions.delete(id); this.writes++; }
  async getSessionsOverlapping(fromIso: string, toIso: string) {
    return [...this.sessions.values()].filter(s => s.start < toIso && (s.end ?? '9999') > fromIso).map(s => structuredClone(s));
  }
  async getRunningSessions() { return [...this.sessions.values()].filter(s => !s.end).map(s => structuredClone(s)); }
  async saveDevice(d: Device) { this.devices.set(d.token, d); }
  async getDevices() { return [...this.devices.values()]; }
  async removeDevice(t: string) { this.devices.delete(t); }
  async savePending(p: Pending) { this.pendings.set(p.id, p); }
  async clearPendings(blockId: string) { for (const [k, p] of this.pendings) if (p.blockId === blockId) this.pendings.delete(k); }
  async saveBlock(b: Block) { this.blocks.set(b.id, structuredClone(b)); }
  async getRunningBlock() { return [...this.blocks.values()].find(b => !b.ended && !b.cancelled) ?? null; }
  async getBlocksInRange(fromIso: string, toIso: string) { return [...this.blocks.values()].filter(b => b.start >= fromIso && b.start < toIso); }
}
