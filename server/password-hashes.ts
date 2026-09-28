import {randomBytes, scrypt, scryptSync, timingSafeEqual} from 'node:crypto';
import {MirrorError} from '../src/errors.js';

/**
 * Password hashes for AMCP's own sign-in: user accounts, and the administrator and reviewer passwords configured on the
 * server. A hash is `form$salt$key`: a 16-byte salt and a 32-byte scrypt key, both in hex. New hashes use scrypt-v3;
 * older forms are still verified, so existing accounts and deployments keep working.
 */
const forms = {
  // Node's defaults: the administrator and reviewer hashes before the review of 2026-09-28 (F-16).
  scrypt: {N: 16384, r: 8, p: 1},
  'scrypt-v2': {N: 32768, r: 8, p: 1},
  'scrypt-v3': {N: 32768, r: 8, p: 3},
};
export type PasswordForm = keyof typeof forms;
const maxmem = 64 * 1024 * 1024;
let running = 0;
/** A password's key in one form. At most four derivations run at once (up to 64 MiB each); more are refused as busy. */
export async function derivePassword(
  password: string,
  salt: string,
  form: PasswordForm = 'scrypt-v3',
): Promise<Buffer> {
  if (running >= 4) throw new MirrorError('AUTH_BUSY', 'Sign-in is busy. Please try again shortly.', {}, 429);
  running++;
  try {
    return await new Promise((resolve, reject) =>
      scrypt(password, salt, 32, {...forms[form], maxmem}, (e, key) => (e ? reject(e) : resolve(key))),
    );
  } finally {
    running--;
  }
}
/** The form, salt and key of a well-formed hash in one of the accepted forms. */
export function passwordHashParts(hash: string, accepted: PasswordForm[]) {
  const [form, salt, key] = hash.split('$');
  return accepted.includes(form as PasswordForm) &&
    /^[a-f0-9]{32}$/.test(salt ?? '') &&
    /^[a-f0-9]{64}$/.test(key ?? '')
    ? {form: form as PasswordForm, salt: salt!, key: Buffer.from(key!, 'hex')}
    : undefined;
}
/** For server start-up and the admin tool, where the password comes from the operator: a scrypt-v3 hash. */
export function passwordHashSync(password: string, salt = randomBytes(16).toString('hex')): string {
  return 'scrypt-v3$' + salt + '$' + scryptSync(password, salt, 32, {...forms['scrypt-v3'], maxmem}).toString('hex');
}
/** For server start-up: whether a password from the environment matches a hash from the environment. */
export function passwordMatchesSync(password: string, hash: string, accepted: PasswordForm[]): boolean {
  const parts = passwordHashParts(hash, accepted);
  return !!parts && timingSafeEqual(scryptSync(password, parts.salt, 32, {...forms[parts.form], maxmem}), parts.key);
}
