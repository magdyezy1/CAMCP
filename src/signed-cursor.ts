import {createHmac, timingSafeEqual} from 'node:crypto';
import {sha256, stable} from './security.js';
import type {JsonObject} from './types.js';

/**
 * The signed continuation cursor of the portfolio adapters (ARC-04 stage E). Seven adapters each carried a copy of this
 * codec, and the copies had drifted: Meta accepted a non-canonical base64url encoding the others refused. A cursor is
 * the base64url JSON of its payload with `signature`, the HMAC-SHA256 of the payload's fingerprint under the adapter's
 * key (the fingerprint of the login the read started with). `openCursor` accepts only a canonical encoding within the
 * adapter's length cap, a signature that matches in constant time, version 1, the caller's binding and an expiry within
 * the next five minutes, and throws `CursorRefused` otherwise; the adapter then refuses with its own INVALID_CURSOR
 * message and checks the fields of its own payload. The cap stays per adapter, sized to the largest payload it seals.
 */
export const cursorLifetimeMs = 300000;

/** Thrown by `openCursor`; adapters catch it with their own payload checks and refuse with INVALID_CURSOR. */
export class CursorRefused extends Error {
  constructor() {
    super('The cursor is invalid or expired.');
    this.name = 'CursorRefused';
  }
}
const refuse = (): never => {
  throw new CursorRefused();
};
const isObject = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);

/** The cursor signature: HMAC-SHA256, keyed by `key`, of the payload's fingerprint (sha256 of its stable JSON). */
export const cursorSignature = (payload: JsonObject, key: string) =>
  createHmac('sha256', key)
    .update(sha256(stable(payload)))
    .digest('hex');

/** The cursor of `payload`: base64url JSON of the payload with its signature. */
export function sealCursor(payload: JsonObject, key: string): string {
  return Buffer.from(JSON.stringify({...payload, signature: cursorSignature(payload, key)})).toString('base64url');
}

export interface CursorRules {
  /** The signing key the cursor was sealed with. */
  key: string;
  /** The read's binding; the payload's `binding` must equal it. */
  binding: string;
  /** The longest cursor the adapter seals, in characters. */
  maxLength: number;
  /** The time to check the expiry against (tests); the current time otherwise. */
  now?: number;
}

/** The signed payload of a cursor this adapter sealed for this binding, without its signature; throws CursorRefused. */
export function openCursor(cursor: unknown, rules: CursorRules): JsonObject {
  if (typeof cursor !== 'string' || cursor.length > rules.maxLength || !/^[A-Za-z0-9_-]+$/.test(cursor)) refuse();
  const bytes = Buffer.from(cursor as string, 'base64url');
  // One encoding per payload: trailing bits or padding variants of an accepted cursor are refused.
  if (bytes.toString('base64url') !== cursor) refuse();
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    refuse();
  }
  if (!isObject(parsed)) return refuse();
  const {signature, ...signed} = parsed;
  if (
    typeof signature !== 'string' ||
    !/^[0-9a-f]{64}$/.test(signature) ||
    !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(cursorSignature(signed, rules.key), 'hex'))
  )
    refuse();
  const now = rules.now ?? Date.now();
  if (
    signed.version !== 1 ||
    signed.binding !== rules.binding ||
    !Number.isSafeInteger(signed.expires_at) ||
    signed.expires_at <= now ||
    signed.expires_at > now + cursorLifetimeMs
  )
    refuse();
  return signed;
}
