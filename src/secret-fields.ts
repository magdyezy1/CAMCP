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
 * of it before anything is kept or returned (`scrubSecrets`). A review with a held value that is executed without it, with another
 * value, or with arguments that are neither the value alone nor the arguments that prepared the review, is refused before anything is
 * claimed or sent.
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

/**
 * The spellings one secret-like value may be given and echoed in: as it is, with "+" written "%2B" (the way "Apply an authorization code"
 * asks for it), with "%2B" or "%2b" read as the "+" it stands for, and percent-decoded (the way a provider may read it back). A provider
 * that refuses a request may echo the value in any of them, and one that lists it may list it in any of them, so the rule that scrubs a
 * reply and the rule that finds the value in a list are this one (`heldValues` in src/write-review.ts, `matchesCode` in
 * src/tiktok-tt-video-list.ts). A text that is no percent-encoding is read as it is.
 */
export function secretSpellings(value: string): string[] {
  const read = new Set<string>([value, value.replace(/%2b/gi, '+')]);
  try {
    read.add(decodeURIComponent(value));
  } catch {
    // A value with a "%" that starts no percent-encoding is its own spelling.
  }
  const spellings = new Set<string>();
  for (const spelling of read) {
    spellings.add(spelling);
    spellings.add(spelling.replaceAll('+', '%2B'));
  }
  return [...spellings];
}

/** What stands in a reply or an error for a secret-like value it echoed. */
export const secretReplacement = '[secret]';
/**
 * What AMCP writes in an answer, in a request it shows or in a stored row in place of a value it hides: `secretReplacement`, the marks of `redact`
 * (src/security.ts) and the few places that hide a URL, a body or people's data. An agent replays a call it was handed as it was given, so a mark comes
 * back as the value of a secret-like field (S3-3 of the lead's second review: `[secret]` was reviewed as a code, sent to TikTok, refused there, and the
 * review was spent). No value a person gives is a mark of AMCP, so a secret-like value that holds one is refused where a review first reads it and where
 * execute takes it again (`refuseHiddenValueMark` below, called by src/write-review.ts). tests/tiktok-tt-video-authorize.test.mjs reads src for each
 * bracketed word it writes and fails for one that is not listed here.
 */
export const hiddenValueMarks: readonly string[] = [
  secretReplacement,
  '[REDACTED]',
  '[BINARY_REDACTED]',
  '[PRIVATE_OR_INVALID_URL_REDACTED]',
  '[PRIVATE_LICENSE_URL]',
  '[PRIVATE_PREVIEW_URL]',
  '[ENCODED_BODY_OMITTED]',
  '[personal data]',
];
/**
 * Whether a value holds a mark of the list above, as it was given or in another spelling that a code is read in (`secretSpellings`: "%5Bsecret%5D" is the
 * mark), and wherever it stands in the value: a text that was scrubbed of part of a value ends in one.
 */
export const holdsHiddenValueMark = (value: string): boolean =>
  secretSpellings(value).some(spelling => hiddenValueMarks.some(mark => spelling.includes(mark)));
function invalid(message: string, details: JsonObject): never {
  throw new MirrorError('INVALID_ARGUMENT', message, details, 400);
}
/**
 * A secret-like value that holds a mark of AMCP's own is no value: it came back in a call that was handed out with the mark where the value was (a native dry
 * run, the `next_call` of a refusal), and sent on it would be reviewed, sent to the provider and refused there, which spends the review (S3-3 of the lead's second
 * review). A review refuses it where it first reads the value (prepare and inspect, `secrets` in src/write-review.ts) and where execute takes it again
 * (`heldValues`), before its digest is compared, with one sentence; `details.payload_field` names the field. Nothing is sent and no review is spent.
 */
export function refuseHiddenValueMark(name: string, value: string): void {
  if (holdsHiddenValueMark(value))
    invalid(
      'This is a placeholder that AMCP shows where it hides a secret value, such as [secret] or [REDACTED], not the value itself. Ask the user for the value and send that.',
      {field: 'arguments', payload_field: name},
    );
}
/**
 * A text that was cut inside a value it quotes ends with the start of that value, which no whole spelling matches: the provider's sentence of a refusal is cut
 * to 200 characters where the refusal is built (src/provider-error-core.ts), before this scrub sees it, and a cut that falls inside a long code echoed there
 * left nearly all of it (S1-3 of the lead's second review). A text that ends with the first `secretPieceMinimum` characters or more of a spelling (all of
 * them but the last at most: the whole is hidden wherever it stands) has that piece hidden. Only the end of a text is a cut edge: nothing here cuts a text
 * from its start.
 */
export const secretPieceMinimum = 8;
function startAtEnd(text: string, secret: string): number {
  for (let length = Math.min(secret.length - 1, text.length); length >= secretPieceMinimum; length--)
    if (text.charCodeAt(text.length - length) === secret.charCodeAt(0) && text.endsWith(secret.slice(0, length)))
      return length;
  return 0;
}
const hide = (text: string, secrets: ReadonlySet<string>): string => {
  let out = text;
  for (const secret of secrets) if (secret && out.includes(secret)) out = out.split(secret).join(secretReplacement);
  // The longest start of any spelling that the text ends with.
  let piece = 0;
  for (const secret of secrets) if (secret) piece = Math.max(piece, startAtEnd(out, secret));
  return piece ? out.slice(0, out.length - piece) + secretReplacement : out;
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
/**
 * An error as it may be kept and returned after a request that sent a secret-like value: its message and details scrubbed of it.
 *
 * The provider's own sentence of a refusal (`details.provider_message`) is cut where the refusal is built, before this scrub sees it, so it is read again
 * from the whole body the refusal keeps (`details.upstream`), once that is scrubbed: `sentenceOf` reads the sentence of a body and cuts it as the refusal
 * did. It is scrubbed first and cut after, as S1-3 of the lead's second review asks; where it cannot be read again, the sentence is left out, never kept
 * cut. (A refusal that keeps a sentence and no body keeps the scrubbed sentence it has, whose cut edge `scrubSecrets` also hides.)
 */
export function scrubSecretError(
  e: unknown,
  secrets: ReadonlySet<string>,
  sentenceOf?: (body: unknown) => string | undefined,
): unknown {
  if (!(e instanceof MirrorError)) return e;
  const details = scrubSecrets(e.details, secrets) as JsonObject;
  if (sentenceOf && details.provider_message !== undefined && details.upstream !== undefined) {
    let sentence: string | undefined;
    try {
      sentence = sentenceOf(details.upstream);
    } catch {
      sentence = undefined;
    }
    if (sentence === undefined) delete details.provider_message;
    else details.provider_message = sentence;
  }
  return new MirrorError(e.code, String(scrubSecrets(e.message, secrets)), details, e.status, e.retryable);
}
