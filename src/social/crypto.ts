/**
 * Social credentials are sealed with AES-256-GCM before they reach Firestore.
 *
 * The key comes from AIMYEAR_SOCIAL_KEY (32 bytes, base64), set on Cloud Run from Secret
 * Manager. It never lives in this repo. The additional data binds a sealed secret to one
 * user and one network, so a blob copied into another user's doc does not open.
 * Without the key, connecting refuses: credentials are never stored in the clear.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Network, SealedSecret } from '../types.js';

export class SealError extends Error {}

function key(): Buffer {
  const raw = process.env.AIMYEAR_SOCIAL_KEY ?? '';
  const k = Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new SealError('Connecting networks is not set up on this server yet (no encryption key). Nothing was saved.');
  return k;
}

/** What a sealed secret belongs to: a posting network, or the Google Calendar connection. */
export type Sealable = Network | 'google_calendar';
const LABEL: Partial<Record<Sealable, string>> = { google_calendar: 'Google Calendar' };

const aad = (uid: string, network: Sealable) => Buffer.from(`aimyear-social:v1:${uid}:${network}`);

export function seal(plain: Record<string, string>, uid: string, network: Sealable): SealedSecret {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  c.setAAD(aad(uid, network));
  const data = Buffer.concat([c.update(JSON.stringify(plain), 'utf8'), c.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function open(s: SealedSecret, uid: string, network: Sealable): Record<string, string> {
  try {
    const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(s.iv, 'base64'));
    d.setAAD(aad(uid, network));
    d.setAuthTag(Buffer.from(s.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(s.data, 'base64')), d.final()]).toString('utf8'));
  } catch (e) {
    if (e instanceof SealError) throw e;
    // Never say more: the message must not carry any part of the secret.
    const name = LABEL[network] ?? network;
    throw new SealError(`The saved ${name} connection can't be read. Connect ${name} again.`);
  }
}
