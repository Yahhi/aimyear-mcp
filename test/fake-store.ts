import { DEFAULT_PROFILE } from '../src/store.js';
import type { Block, Commitment, Day, Device, Goal, Mode, Path, Pending, Profile, Session } from '../src/types.js';

/** The Store's interface kept in memory, so service logic can be tested without Firestore. */
export class FakeStore {
  readonly uid = 'fake';
  profile: Profile = DEFAULT_PROFILE('Europe/Madrid');
  goal: Goal | null = null;
  path: Path = { milestones: [], steps: [] };
  commitments: Commitment[] = [];
  days = new Map<string, Day>();
  sessions = new Map<string, Session>();
  blocks = new Map<string, Block>();
  devices = new Map<string, Device>();
  pendings = new Map<string, Pending>();

  async getProfile() { return structuredClone(this.profile); }
  async saveProfile(p: Profile) { this.profile = structuredClone(p); }
  async getGoal() { return structuredClone(this.goal); }
  async saveGoal(g: Goal) { this.goal = structuredClone(g); }
  async getPath() { return structuredClone(this.path); }
  async savePath(p: Path) { this.path = structuredClone(p); }
  async getCommitments() { return structuredClone(this.commitments); }
  async saveCommitments(c: Commitment[]) { this.commitments = structuredClone(c); }
  async getDay(date: string) { const d = this.days.get(date); return d ? structuredClone(d) : null; }
  async getOrCreateDay(date: string, mode: Mode) {
    if (!this.days.has(date)) this.days.set(date, { date, mode, plan: [], createdAt: '', updatedAt: '' });
    return structuredClone(this.days.get(date)!);
  }
  async saveDay(d: Day) { this.days.set(d.date, structuredClone(d)); }
  async getDaysInRange(from: string, to: string) { return [...this.days.values()].filter(d => d.date >= from && d.date <= to).map(d => structuredClone(d)); }
  async saveSession(s: Session) { this.sessions.set(s.id, structuredClone(s)); }
  async getSession(id: string) { const s = this.sessions.get(id); return s ? structuredClone(s) : null; }
  async deleteSession(id: string) { this.sessions.delete(id); }
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
