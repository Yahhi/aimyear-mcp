import { getMessaging, type BaseMessage, type MulticastMessage, type BatchResponse } from 'firebase-admin/messaging';
import type { Device } from './types.js';

/** FCM's multicast send; tests pass a fake. */
export type Multicast = (m: MulticastMessage) => Promise<BatchResponse>;
export const realMulticast: Multicast = m => getMessaging().sendEachForMulticast(m);

/** Pushes one message to the given devices and drops (through `drop`) the tokens that are gone. */
export async function pushTo(targets: Device[], message: BaseMessage, drop: (token: string) => Promise<void>, multicast: Multicast = realMulticast) {
  if (!targets.length) return { sent: 0, failed: 0, reason: 'no device to push to' };
  const res = await multicast({ tokens: targets.map(d => d.token), ...message });
  await Promise.all(res.responses.map(async (r, i) => {
    const code = (r.error as { code?: string } | undefined)?.code ?? '';
    if (!r.success && /registration-token-not-registered|invalid-argument/.test(code)) await drop(targets[i].token);
  }));
  return { sent: res.successCount, failed: res.failureCount };
}
