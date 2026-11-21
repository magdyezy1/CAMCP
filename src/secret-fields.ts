import {createHash} from 'node:crypto';
import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

/**
 * Secret-like body fields of a reviewed write, such as the authorization code a creator's TikTok app produces for a Spark Ads post
 * (r25-m4b-smartpush, matrix A2). A leaf: it imports no lifecycle module.
 *
 * What a review keeps of such a field is its SHA-256 digest, never the value: the digest is in the stored plan (`heldSecrets`) and the
 * body that the plan stores, shows, audits and fingerprints has no such field. The value is secret-like in the sense of src/security.ts
 * (it is a bearer credential for a post of a person who is not the account's owner), so it is not logged, not shown in a review and not
 * in an audit row. It still has to be sent once, so execute takes it again in `arguments.payload`, compares its digest with the
 * reviewed one and puts it into the request that goes to the provider and nowhere else; a reply or an error that echoes it is scrubbed
 * of it before anything is kept or returned (`scrubSecrets`). A review with a held value that is executed without it, or with another
 * value, is refused before anything is claimed or sent.
 */
export interface SecretFields {
  /** The body fields that hold a secret-like value (the others of the body stay in the plan as they are). */
  readonly fields: readonly string[];
  /**
   * The value as the request writes it, where the provider's page asks for another spelling than the one a person copies from the app
   * ("Apply an authorization code": replace "+" with "%2B"). The digest is of the value as the person gave it.
   */
  readonly wire?: (value: string) => string;
}

/** The digest a review keeps of a secret-like value. */
export const secretDigest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** What stands in a reply or an error for a secret-like value it echoed. */
export const secretReplacement = '[secret]';
const hide = (text: string, secrets: ReadonlySet<string>): string => {
  let out = text;
  for (const secret of secrets) if (secret && out.includes(secret)) out = out.split(secret).join(secretReplacement);
  return out;
};
/** A value with every occurrence of a secret-like value (in a text or an object key, at any depth) replaced. */
export function scrubSecrets(value: unknown, secrets: ReadonlySet<string>): unknown {
  if (typeof value === 'string') return hide(value, secrets);
  if (Array.isArray(value)) return value.map(v => scrubSecrets(v, secrets));
  if (value && typeof value === 'object') {
    const out: JsonObject = {};
    // Own data properties only, as Object.fromEntries defined them: a reply key such as __proto__ stays data.
    for (const [key, v] of Object.entries(value as JsonObject))
      Object.defineProperty(out, hide(key, secrets), {
        value: scrubSecrets(v, secrets),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return out;
  }
  return value;
}
/** An error as it may be kept and returned after a request that sent a secret-like value: its message and details scrubbed of it. */
export function scrubSecretError(e: unknown, secrets: ReadonlySet<string>): unknown {
  if (!(e instanceof MirrorError)) return e;
  return new MirrorError(
    e.code,
    String(scrubSecrets(e.message, secrets)),
    scrubSecrets(e.details, secrets) as JsonObject,
    e.status,
    e.retryable,
  );
}
