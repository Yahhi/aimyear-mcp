import type { DesktopReminder, Pending } from '../src/types.js';

/** The cross-user reminder store (src/store.ts Notifications) in memory. */
export class FakeNotifications {
  pending = new Map<string, Pending>();
  inbox = new Map<string, DesktopReminder>();
  requeued: Pending[] = [];
  autoClosed: string[] = [];
  mainStep: { title: string; done: boolean } | null = { title: 'Email 10 people', done: false };

  async due(nowIso: string) { return [...this.pending.values()].filter(p => p.dueAt <= nowIso); }
  async remove(id: string) { this.pending.delete(id); }
  async claim(id: string) { return this.pending.delete(id); }
  async claimDesktop(uid: string, nowIso: string) {
    const mine = [...this.pending.values()].filter(p => p.uid === uid && p.workplace === 'desktop' && p.dueAt <= nowIso);
    return mine.filter(p => this.pending.delete(p.id));
  }
  async saveDesktopReminder(r: DesktopReminder) { this.inbox.set(r.id, structuredClone(r)); }
  async takeDesktopReminders(uid: string) {
    const mine = [...this.inbox.values()].filter(r => r.uid === uid);
    for (const r of mine) this.inbox.delete(r.id);
    return mine;
  }
  async devicesOf() { return []; }
  async dropDevice() {}
  async profileOf() { return null; }
  async mainStepOf() { return this.mainStep; }
  /** Like the real one for a running up-timer: the next stand-up a work interval later, or none after the final one. */
  async queueNextStandup(p: Pending, workMin: number) {
    if (p.final) { this.autoClosed.push(p.blockId); return undefined; }
    const id = `${p.blockId}-standup-${this.requeued.length + 1}`;
    const next: Pending = { ...p, id, dueAt: new Date(Date.parse(p.dueAt) + workMin * 60000).toISOString(), elapsedMin: (p.elapsedMin ?? p.minutes) + workMin };
    this.pending.set(id, next);
    this.requeued.push(next);
    return id;
  }
}
