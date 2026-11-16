import {sha256, stable} from './security.js';
import type {CompiledRequest} from './types.js';

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
 * The same table names where its provider signs links (the value-shape rule below), in two more kinds of entry that are no
 * field names: `signed-host:<host>`, the host of the provider's own asset, preview or licence links (`signed-host:ads.tiktok.com`;
 * `signed-host:*.tiktokcdn.com` for every host below a domain, never the domain itself), and `signed-field:<name>`, a field as
 * `fieldName` spells it that the provider fills with a link it generated. A table with none of them applies no URL rule.
 *
 * Idempotent and monotone, like every rule here: it only drops fields, so a review saved before a table grew is projected
 * again at execute (src/write-review.ts) and what it keeps is exactly what the provider said.
 */
export type ReviewVolatile = readonly string[];
/** No table: nothing is excused by name. What a provider without one keeps is its whole answer. */
export const noReviewVolatile: ReviewVolatile = Object.freeze([]);
const hostEntry = 'signed-host:',
  fieldEntry = 'signed-field:';
/** What a table compiles to: the names it drops, and where its provider signs links. */
interface Scope {
  /** Whether the table drops this field (a name as `fieldName` spells it). */
  readonly drops: (name: string) => boolean;
  /** Whether the provider signs links at this host (lower case, without a port). */
  readonly host: (host: string) => boolean;
  /** Whether the provider fills this field (a name as `fieldName` spells it) with a link it generated. */
  readonly field: (name: string) => boolean;
  /** Whether the table declares any link: with none the URL rule is off, and every URL stays whole. */
  readonly links: boolean;
}
const noScope: Scope = Object.freeze({drops: () => false, host: () => false, field: () => false, links: false});
const scopes = new WeakMap<ReviewVolatile, Scope>();
function scopeOf(table: ReviewVolatile | undefined): Scope {
  if (!table?.length) return noScope;
  let scope = scopes.get(table);
  if (!scope) {
    const hosts = table.filter(entry => entry.startsWith(hostEntry)).map(entry => entry.slice(hostEntry.length)),
      fields = new Set(
        table.filter(entry => entry.startsWith(fieldEntry)).map(entry => entry.slice(fieldEntry.length)),
      ),
      names = table.filter(entry => !entry.startsWith(hostEntry) && !entry.startsWith(fieldEntry)),
      exact = new Set(names.filter(name => !name.endsWith('*'))),
      prefixes = names.filter(name => name.endsWith('*')).map(name => name.slice(0, -1)),
      exactHosts = new Set(hosts.filter(host => !host.startsWith('*.')).map(host => host.toLowerCase())),
      // `*.example.com` is every host that ends in `.example.com`: a lookalike (`evilexample.com`) and the domain itself are not.
      suffixes = hosts.filter(host => host.startsWith('*.')).map(host => host.slice(1).toLowerCase());
    scope = Object.freeze({
      drops: (name: string) => exact.has(name) || prefixes.some(prefix => name.startsWith(prefix)),
      host: (host: string) => exactHosts.has(host) || suffixes.some(suffix => host.endsWith(suffix)),
      field: (name: string) => fields.has(name),
      links: hosts.length + fields.size > 0,
    });
    scopes.set(table, scope);
  }
  return scope;
}
const fieldName = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
/** Whether a provider's table names this field (as the projection reads it: camelCase is snake_case). */
export const isReviewVolatile = (volatile: ReviewVolatile, key: string): boolean =>
  scopeOf(volatile).drops(fieldName(key));
const scalar = (value: unknown) => value === null || ['string', 'number', 'boolean'].includes(typeof value);

/**
 * The value-shape rule of the review projection (R2.5 M1, plan idea 1: the safety net under the per-field rules; lead review
 * S2-2). A provider signs its own links anew on every read: TikTok's licence link carries a `ticket`, an object store's image
 * link its `x-amz-*`, `x-goog-*` or `x-signature` and expiry. Such a value is a credential to a document, never a setting, so
 * it is the same state however often it is read. A string that is a whole http(s) URL on a host the provider's table declares
 * (`signed-host:`), or under a field it declares (`signed-field:`), therefore loses the query parameters that sign or expire
 * it. No other URL is read: a landing page, a tracking URL or any link an advertiser wrote is configuration, whatever its
 * parameters are called (an affiliate `token`, an event `ticket`, a partner's `sig` or `expires`), so it stays in the hash and
 * in the `before_state` the approver reads, and a change of it refuses. The UTM parameters, the path and the fragment of a
 * provider link stay too, byte for byte.
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
/** The host of a URL as the WHATWG parser reads it (lower case, no port, userinfo apart), or '' for one it does not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
/** `text` without the signing parameters of a link of the provider: one on a declared host, or under a declared field. */
function withoutSigningParameters(text: string, scope: Scope, signedField: boolean): string {
  if (!scope.links || !wholeUrl.test(text)) return text;
  const fragment = text.indexOf('#'),
    head = fragment < 0 ? text : text.slice(0, fragment),
    query = head.indexOf('?');
  if (query < 0) return text;
  // Only the provider's own links are signed by it: a URL on any other host is the advertiser's, and stays whole.
  if (!signedField && !scope.host(hostOf(head))) return text;
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
 * The role of a state read in a review, in the words of its two uses: the three a read is stamped with and the TARGET, which is
 * every read that carries none (the objects a write changes).
 */
export type ReadRole = NonNullable<CompiledRequest['stateRole']> | 'target';
/**
 * The role of a state read (R2.5 M1, plan idea 1), decided here and nowhere else, for the hash and for `material` alike (merge
 * r25-m1-merge, the review S3-6 of r25-m1-hash and r25-m1-diff): `account`, `parent` or `reference` as the read was stamped
 * (`CompiledRequest.stateRole`, set where the read is built and never by a caller), and `target` for every read that carries
 * none. What a review keeps of a read follows from it: only an ACCOUNT container is kept to its identity (its provider's
 * `review.identity`, asked by src/review-state.ts), a REFERENCE keeps what the write uses of it, and a PARENT and a TARGET are
 * hashed whole but for the provider's table. What a STATE_CHANGED lists as material follows from the same role
 * (src/review-diff.ts): every changed field of a target, a parent or a reference, and the account's but known noise.
 *
 * A value that is none of the three (a saved review is JSON and may hold anything) or no read at all is a target: what is not
 * placed gets the most protection, never a thinner one. Total, and the only reader of the stamp: tests/review-read-role.test.mjs
 * scans src/ for a second one.
 */
export function readRole(read: unknown): ReadRole {
  const role = (read as {stateRole?: unknown} | null | undefined)?.stateRole;
  return role === 'account' || role === 'parent' || role === 'reference' ? role : 'target';
}

/**
 * What a review keeps of an account row (R2.5 M1, plan idea 1, the role ACCOUNT): the listed fields, as the provider gave
 * them, and nothing else. A parent row is never kept to a list: its budget, bid and flight are what a child spends by (lead
 * review S2-1). A dot reaches into a nested record (`generalConfig.currencyCode`). Idempotent
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

/**
 * `signedField` is true under a field the provider's table declares as a link it generated (and inside its lists and records),
 * `urls` whether the value-shape rule is read at all (a comparison of what a write sent with what is stored does not).
 */
function project(value: unknown, scope: Scope, urls: boolean, key: string, signedField: boolean): unknown {
  if (Array.isArray(value)) {
    const values = value.map(item => project(item, scope, urls, '', signedField));
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
        .filter(([name]) => !scope.drops(fieldName(name)))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, item]) => [name, project(item, scope, urls, name, signedField || scope.field(fieldName(name)))]),
    );
  return urls && typeof value === 'string' ? withoutSigningParameters(value, scope, signedField) : value;
}

/**
 * Configuration projection only; never use this to canonicalize a mutation payload. `volatile` is the table of the
 * provider whose answer this is (its `review.volatile`): what that provider says changes by itself. A caller with no
 * provider passes `noReviewVolatile`, and nothing is dropped by name.
 */
export function normalizeReviewState(value: unknown, volatile: ReviewVolatile): unknown {
  return project(value, scopeOf(volatile), true, '', false);
}
/**
 * The same names and order, without the value-shape rule of URLs: for a comparison of what a write sent with what the
 * provider stores (src/verification-core.ts), where a link is a value the provider must return as it was sent.
 */
export function normalizeComparable(value: unknown, volatile: ReviewVolatile): unknown {
  return project(value, scopeOf(volatile), false, '', false);
}

export const reviewStateHash = (value: unknown, volatile: ReviewVolatile) =>
  sha256(stable(normalizeReviewState(value, volatile)));
/** The hash of the comparable form (`normalizeComparable`): for a verification, which no URL rule may soften. */
export const comparableStateHash = (value: unknown, volatile: ReviewVolatile) =>
  sha256(stable(normalizeComparable(value, volatile)));

/** The JSON paths at which two already normalized states differ. */
function changedPaths(expected: unknown, actual: unknown): string[] {
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
  walk(expected, actual, '$');
  return paths;
}

/**
 * The paths at which two states of the same record differ, as a review compares them (a read at prepare with the same read at
 * execute): the table's names are left out and a link the provider signs itself is the same link however it was signed.
 * JSON paths only: diagnostics must not disclose provider values or credentials.
 */
export function changedStateFields(expected: unknown, actual: unknown, volatile: ReviewVolatile): string[] {
  return changedPaths(normalizeReviewState(expected, volatile), normalizeReviewState(actual, volatile));
}
/**
 * The paths at which what a write SENT and what the provider STORED differ (lead review S3-1): the table's names are left
 * out, and every URL stays whole, because a link a write sent must come back as it was sent. A family that verifies its own
 * write compares with this, never with `changedStateFields`: with the review's rule a link written with one `token` and read
 * back with another would verify as applied (src/verification-core.ts compares the same way).
 */
export function changedComparableFields(expected: unknown, actual: unknown, volatile: ReviewVolatile): string[] {
  return changedPaths(normalizeComparable(expected, volatile), normalizeComparable(actual, volatile));
}
