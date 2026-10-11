import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {MirrorError} from '../src/errors.js';

/**
 * Offline password blocklist (SEC-06 S5). NIST SP 800-63B-4 §3.1.1.2: a verifier SHALL compare a new password against a
 * blocklist of commonly used, expected or compromised values, including context-specific words such as the service
 * name and the person's own name or email. Nothing leaves the server.
 *
 * Two checks run, both offline:
 * - a pattern estimate in the style of public strength estimators: a password made only of well-known password words,
 *   keyboard, letter or number runs, short numbers, years, repeated text, punctuation and the person's own context
 *   (AMCP, the email's local part, their name) is refused. Look-alike characters (p@ssw0rd) count as their letters.
 * - an optional exact list the operator supplies (AMCP_PASSWORD_BLOCKLIST_FILE: one password per line, for example a
 *   vetted public list of common passwords of 15 or more characters), read once, kept only as SHA-256 hashes.
 *
 * Only new passwords are checked: signing in with an existing password never is.
 */
/** Base words of the most common passwords in published breach-frequency lists, plus this product's own words. */
const commonWords = `password passwd passw pass qwerty qwert azerty letmein welcome iloveyou loveyou iloveu admin
administrator root user guest default test tester testing changeme secret private secure security login access master
monkey dragon shadow sunshine princess football baseball soccer hockey basketball superman batman spiderman trustno
michael jennifer jordan hunter ranger buster thomas robert daniel charlie andrew jessica ashley michelle matthew joshua
william taylor hello freedom whatever starwars pokemon computer internet flower cheese summer winter spring autumn love
lovely angel babygirl baby family forever friend friends google facebook apple samsung mustang ferrari harley chelsea
liverpool arsenal barcelona madrid killer pepper ginger cookie chocolate banana orange purple yellow silver golden
diamond matrix hacker ninja money business office company work home house world helloworld sweet sweetheart honey
sexy hottie cool super star rock music guitar dance player gamer game games minecraft fortnite roblox naruto anime
blessed jesus christ heaven peace happy smile nothing unknown abc qwe asd zxc zaq xsw cde qaz wsx edc allah mohammed
muhammad mohamed ahmed ahmad omar fatima saudi riyadh jeddah egypt cairo dubai habibi amcp advert advertising adverts
campaign campaigns marketing agency adwords meta tiktok linkedin snapchat reddit microsoft dragonball bigdaddy
whatsapp instagram iphone android mypassword mypass newpassword oldpassword temppassword passpass correcthorsebatterystaple
letmeinplease youcantguessme qwertyuiop asdfghjkl zxcvbnm`
  .split(/\s+/)
  .filter(Boolean);
/** Keyboard rows and runs, and the alphabet and digits; a run of 3+ characters of any of them, either way, is cheap. */
const runs = [
  'abcdefghijklmnopqrstuvwxyz',
  '01234567890',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
  'qwertzuiop',
  'azertyuiop',
  'qwertyuiopasdfghjklzxcvbnm',
  '1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p',
  'qazwsxedcrfvtgbyhnujmikolp',
  '`1234567890-=',
  '!@#$%^&*()_+',
];
const lookalike: Record<string, string> = {
  '@': 'a',
  '4': 'a',
  '8': 'b',
  '(': 'c',
  '3': 'e',
  '6': 'g',
  '9': 'g',
  '1': 'i',
  '!': 'i',
  '|': 'l',
  '0': 'o',
  '$': 's',
  '5': 's',
  '7': 't',
  '+': 't',
  '2': 'z',
};
/** Below this estimate a password is refused as common (about 2^40 guesses for a targeted guesser). */
const minimumBits = 40;
const words = new Set(commonWords);
const longestWord = Math.max(...commonWords.map(w => w.length));
const bothWays = runs.flatMap(r => [r, [...r].reverse().join('')]);
const inRun = (s: string) => bothWays.some(r => r.includes(s));
let operatorList: Set<string> | undefined;
let operatorListPath: string | undefined;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
/** The operator's exact list, read once per path. An unreadable or oversized list refuses the change (fails closed). */
function operatorBlocklist(env: NodeJS.ProcessEnv): Set<string> | undefined {
  const file = env.AMCP_PASSWORD_BLOCKLIST_FILE;
  if (!file) return;
  if (operatorList && operatorListPath === file) return operatorList;
  const stat = fs.statSync(file);
  if (stat.size > 64 * 1024 * 1024) throw Error('AMCP_PASSWORD_BLOCKLIST_FILE is larger than 64 MiB.');
  const list = new Set<string>();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const value = line.trim().toLowerCase();
    if (value.length >= 8) list.add(digest(value));
  }
  operatorList = list;
  operatorListPath = file;
  return list;
}
export interface PasswordContext {
  email?: unknown;
  name?: unknown;
}
/** The words a person is expected to use: AMCP, their email's local part and its pieces, and their name's parts. */
function contextWords(context: PasswordContext): Set<string> {
  const out = new Set(['amcp']);
  const add = (value: string) => {
    const v = value.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (v.length >= 3) out.add(v);
  };
  if (typeof context.email === 'string') {
    const local = context.email.split('@')[0] ?? '';
    add(local);
    local.split(/[._+-]+/).forEach(add);
    const domain = (context.email.split('@')[1] ?? '').split('.')[0];
    if (domain) add(domain);
  }
  if (typeof context.name === 'string') {
    add(context.name);
    context.name.split(/\s+/).forEach(add);
  }
  return out;
}
/**
 * The estimated guesses (in bits) of the cheapest way to build `password` from common pieces: the minimum-cost
 * segmentation into known words, context words, keyboard and number runs, years, short numbers, repeated chunks,
 * punctuation and, for anything else, single characters.
 */
export function passwordGuessBits(password: string, context: PasswordContext = {}): number {
  const raw = password.toLowerCase(),
    plain = [...raw].map(c => lookalike[c] ?? c).join(''),
    ell = [...raw].map(c => (c === '1' ? 'l' : (lookalike[c] ?? c))).join(''),
    personal = contextWords(context),
    n = raw.length,
    cost = new Array<number>(n + 1).fill(Infinity);
  const dictionary = (s: string) => (personal.has(s) ? 2 : words.has(s) ? 8 : undefined);
  cost[0] = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(cost[i]!)) continue;
    const at = cost[i]!,
      relax = (j: number, bits: number) => {
        if (at + bits < cost[j]!) cost[j] = at + bits;
      };
    // Anything at all: one character, priced by its kind.
    const c = raw[i]!;
    relax(i + 1, /[a-z]/.test(c) ? 4.7 : /[0-9]/.test(c) ? 3.3 : c === ' ' ? 1 : 5);
    for (let j = i + 1; j <= Math.min(n, i + Math.max(longestWord, 32)); j++) {
      const piece = raw.slice(i, j),
        length = j - i;
      if (length >= 3 && length <= longestWord) {
        const known = Math.min(
          dictionary(piece) ?? Infinity,
          (dictionary(plain.slice(i, j)) ?? Infinity) + 1,
          (dictionary(ell.slice(i, j)) ?? Infinity) + 1,
        );
        if (Number.isFinite(known)) relax(j, known);
      }
      if (length >= 3 && inRun(piece)) relax(j, 7);
      if (length >= 2 && new Set(piece).size === 1) relax(j, 5);
      if (/^[0-9]+$/.test(piece)) {
        if (length === 4 && /^(19|20)\d\d$/.test(piece)) relax(j, 7);
        else if (length <= 4) relax(j, 3.3 * length);
      }
      if (/^[^a-z0-9]+$/.test(piece) && length <= 3) relax(j, 2 + 2 * length);
      // A chunk that repeats the text just before it.
      if (length >= 2 && i >= length && raw.slice(i - length, i) === piece) relax(j, 2);
    }
  }
  return cost[n]!;
}
/** Refuses a new password that is common, predictable or built from the person's own details (SEC-06 S5). */
export function assertPasswordNotCommon(password: string, context: PasswordContext = {}, env = process.env) {
  const list = operatorBlocklist(env);
  if ((list && list.has(digest(password.trim().toLowerCase()))) || passwordGuessBits(password, context) < minimumBits)
    throw new MirrorError(
      'PASSWORD_COMMON',
      'This password is too common or too easy to guess. Avoid well-known passwords, keyboard or number runs, repeated text, and your name, email or AMCP.',
    );
}
