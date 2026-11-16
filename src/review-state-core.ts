import {sha256, stable} from './security.js';

/**
 * The pure state-projection helpers of the review lifecycle (ARC-04 stage B): the configuration projection a review
 * hashes, the state hash and the changed-field diagnostics. A leaf module, so a family module can use them without
 * importing src/review-state.ts, which imports the family registry; src/review-state.ts re-exports them.
 */

/**
 * What changes by itself, one table per provider (R2.5 M1, plan idea 1: its `review.volatile`, in the provider's hooks).
 * A name is a field as `fieldName` spells it (snake_case; `updatedTime` is `updated_time`), or a prefix ending in `*`
 * (`review_status*`). A review hashes everything else: response envelopes are validated and projected before this, and
 * within a resource an unknown field stays protected, so a new configuration field is never excused by a name list it
 * is not on. This replaces the one set every provider shared: a name that is telemetry in one provider's rows (X's
 * `servable`) is configuration, or nothing, in another's.
 *
 * Idempotent and monotone, like every rule here: it only drops fields, so a review saved before a table grew is projected
 * again at execute (src/write-review.ts) and what it keeps is exactly what the provider said.
 */
export type ReviewVolatile = readonly string[];
/** No table: nothing is excused by name. What a provider without one keeps is its whole answer. */
export const noReviewVolatile: ReviewVolatile = Object.freeze([]);
const matchers = new WeakMap<ReviewVolatile, (name: string) => boolean>();
function volatileMatcher(table: ReviewVolatile | undefined): (name: string) => boolean {
  if (!table?.length) return () => false;
  let matcher = matchers.get(table);
  if (!matcher) {
    const exact = new Set(table.filter(name => !name.endsWith('*'))),
      prefixes = table.filter(name => name.endsWith('*')).map(name => name.slice(0, -1));
    matcher = name => exact.has(name) || prefixes.some(prefix => name.startsWith(prefix));
    matchers.set(table, matcher);
  }
  return matcher;
}
const fieldName = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
/** Whether a provider's table names this field (as the projection reads it: camelCase is snake_case). */
export const isReviewVolatile = (volatile: ReviewVolatile, key: string): boolean =>
  volatileMatcher(volatile)(fieldName(key));
const scalar = (value: unknown) => value === null || ['string', 'number', 'boolean'].includes(typeof value);

/**
 * The value-shape rule of the review projection (R2.5 M1, plan idea 1: the safety net under the per-field rules). A
 * provider signs a link anew on every read: TikTok's licence link carries a `ticket`, an object store's image link its
 * `x-amz-*`, `x-goog-*` or `x-signature` and expiry. Such a value is a credential to a document, never a setting, so it is
 * the same state however often it is read. A string that is a whole http(s) URL therefore loses the query parameters that
 * sign or expire it, whatever key it stands under. A landing page's UTM parameters are configuration and stay, byte for
 * byte, and so does every other part of the URL.
 *
 * Idempotent (what is left holds no signing parameter, so it is left as it is) and monotone (it only deletes query pairs),
 * so a review saved before the rule existed is projected again at execute, and a real change of anything else still
 * changes the state.
 *
 * The names are the plan's list plus `x-signature`, which TikTok's CDN spells for the signature that goes with its
 * `x-expires` (src/security.ts already counts it a signed-URL parameter): with `x-expires` dropped and its signature kept,
 * the same image link would still differ at every read.
 */
const signingParameters: ReadonlySet<string> = new Set([
  'ticket',
  'signature',
  'sig',
  'token',
  'expires',
  'x-expires',
  'x-signature',
]);
const signingParameter = (name: string): boolean =>
  signingParameters.has(name) || name.startsWith('x-amz-') || name.startsWith('x-goog-');
/** A parameter name as a URL spells it: percent-decoded and lower-cased, so `X%2DAmz%2DDate` is `x-amz-date`. */
function parameterName(raw: string): string {
  try {
    return decodeURIComponent(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}
const wholeUrl = /^https?:\/\/[^\s]+$/i;
function withoutSigningParameters(text: string): string {
  if (!wholeUrl.test(text)) return text;
  const fragment = text.indexOf('#'),
    head = fragment < 0 ? text : text.slice(0, fragment),
    query = head.indexOf('?');
  if (query < 0) return text;
  const pairs = head.slice(query + 1).split('&'),
    kept = pairs.filter(pair => {
      const equals = pair.indexOf('=');
      return equals < 0 || !signingParameter(parameterName(pair.slice(0, equals)));
    });
  if (kept.length === pairs.length) return text;
  return head.slice(0, query) + (kept.length ? '?' + kept.join('&') : '') + (fragment < 0 ? '' : text.slice(fragment));
}
// Only fields whose provider contracts define membership, rather than sequence.
// Unknown scalar arrays stay ordered until a contract explicitly qualifies them.
const unorderedFields = new Set([
  'country_codes',
  'countries',
  'genders',
  'age_groups',
  'age_ranges',
  'locales',
  'device_platforms',
  'publisher_platforms',
  'facebook_positions',
  'instagram_positions',
  'messenger_positions',
  'audience_network_positions',
  'placements',
  'included_languages',
  'excluded_languages',
]);

/**
 * What a review keeps of an account or a parent row (R2.5 M1, plan idea 1, the roles ACCOUNT and PARENT): the listed fields,
 * as the provider gave them, and nothing else. A dot reaches into a nested record (`generalConfig.currencyCode`). Idempotent
 * (a row it kept projects to itself) and monotone (it only drops), so a state saved before is projected again at execute. A
 * value that is no record is no row and is left as it is.
 */
export function pickIdentity(row: unknown, paths: readonly string[]): unknown {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const source = row as Record<string, unknown>,
    out: Record<string, unknown> = {},
    nested = new Map<string, string[]>();
  for (const path of paths) {
    const dot = path.indexOf('.'),
      head = dot < 0 ? path : path.slice(0, dot);
    if (!Object.hasOwn(source, head)) continue;
    if (dot < 0) out[head] = source[head];
    else nested.set(head, [...(nested.get(head) ?? []), path.slice(dot + 1)]);
  }
  for (const [head, rest] of nested) {
    const value = source[head];
    if (value && typeof value === 'object' && !Array.isArray(value)) out[head] = pickIdentity(value, rest);
  }
  return out;
}

function project(value: unknown, matches: (name: string) => boolean, urls: boolean, key: string): unknown {
  if (Array.isArray(value)) {
    const values = value.map(item => project(item, matches, urls, ''));
    // Preserve duplicates and types. Arrays of objects may have meaningful order.
    return unorderedFields.has(fieldName(key)) && values.every(scalar)
      ? values.sort((a, b) => {
          const x = stable(a),
            y = stable(b);
          return x < y ? -1 : x > y ? 1 : 0;
        })
      : values;
  }
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([name]) => !matches(fieldName(name)))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, item]) => [name, project(item, matches, urls, name)]),
    );
  return urls && typeof value === 'string' ? withoutSigningParameters(value) : value;
}

/**
 * Configuration projection only; never use this to canonicalize a mutation payload. `volatile` is the table of the
 * provider whose answer this is (its `review.volatile`): what that provider says changes by itself. A caller with no
 * provider passes `noReviewVolatile`, and nothing is dropped by name.
 */
export function normalizeReviewState(value: unknown, volatile: ReviewVolatile): unknown {
  return project(value, volatileMatcher(volatile), true, '');
}
/**
 * The same names and order, without the value-shape rule of URLs: for a comparison of what a write sent with what the
 * provider stores (src/verification-core.ts), where a link is a value the provider must return as it was sent.
 */
export function normalizeComparable(value: unknown, volatile: ReviewVolatile): unknown {
  return project(value, volatileMatcher(volatile), false, '');
}

export const reviewStateHash = (value: unknown, volatile: ReviewVolatile) =>
  sha256(stable(normalizeReviewState(value, volatile)));

/** JSON paths only: diagnostics must not disclose provider values or credentials. */
export function changedStateFields(expected: unknown, actual: unknown, volatile: ReviewVolatile): string[] {
  const paths: string[] = [];
  const walk = (a: unknown, b: unknown, path: string) => {
    if (stable(a) === stable(b)) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const child = path + '[' + i + ']';
        if (i >= a.length || i >= b.length) paths.push(child);
        else walk(a[i], b[i], child);
      }
      return;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        const child = path + '[' + JSON.stringify(key) + ']';
        if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) paths.push(child);
        else walk((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], child);
      }
      return;
    }
    paths.push(path);
  };
  walk(normalizeReviewState(expected, volatile), normalizeReviewState(actual, volatile), '$');
  return paths;
}
