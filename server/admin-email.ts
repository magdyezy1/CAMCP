import {createHash, timingSafeEqual} from 'node:crypto';

/**
 * `AMCP_ADMIN_EMAIL` (r25-admin-email, the owner's request of 2026-11-21): one e-mail address whose verified sign-in
 * becomes a second owner of the deployment's workspace. This leaf module holds only what parsing and matching need, so
 * the configuration, the website store and the account code share one definition of "the address".
 */

/** What `loadConfig` throws for an unparseable value. It never repeats the value: an address is personal data. */
export const adminEmailProblem =
  'AMCP_ADMIN_EMAIL must hold exactly one e-mail address (no list, wildcard or domain). Correct or remove it.';
// One address: no whitespace or control characters, no list separators, wildcards, quotes, brackets or angle brackets,
// exactly one `@` and a dotted domain. It is a subset of what accountEmail (server/user-accounts.ts) accepts for an
// account, so a value that passes here can equal an account's address.
const plain = String.raw`[^\s\x00-\x1f\x7f@<>,;*?%"\\()\[\]]`;
const singleAddress = new RegExp('^' + plain + '+@' + plain + '+\\.' + plain + '+$');
/**
 * The configured address, trimmed and lower-cased as accountEmail does for every account, or undefined when the value
 * is unset, empty or blank. Anything else that is not exactly one address throws `adminEmailProblem`.
 */
export function adminEmailFrom(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (value === undefined || value === '') return undefined;
  if (value.length > 254 || !singleAddress.test(value)) throw new Error(adminEmailProblem);
  return value.toLowerCase();
}
const digest = (text: string) => createHash('sha256').update(text).digest();
/**
 * Whether `candidate` is exactly the configured address, ignoring case and surrounding space. The comparison runs over
 * fixed-length digests in constant time, so its duration says nothing about how much of the address a guess had right.
 * Anything that is not a string, and a string longer than any address, never matches; without the setting nothing does.
 */
export function adminEmailMatches(configured: string | undefined, candidate: unknown): boolean {
  if (configured === undefined) return false;
  const text = typeof candidate === 'string' && candidate.length <= 1024 ? candidate.trim().toLowerCase() : '';
  return timingSafeEqual(digest(text), digest(configured)) && text !== '';
}
