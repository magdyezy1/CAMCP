import {sha256, stable} from './security.js';

/**
 * The pure state-projection helpers of the review lifecycle (ARC-04 stage B): the configuration projection a review
 * hashes, the state hash and the changed-field diagnostics. A leaf module, so a family module can use them without
 * importing src/review-state.ts, which imports the family registry; src/review-state.ts re-exports them.
 */

// Response envelopes are validated before projection. Within each resource keep
// unknown fields: a new configuration field must remain protected by default.
const volatile = new Set([
  'delivery_status',
  'effective_status',
  'secondary_status',
  'updated_at',
  'updated_time',
  'last_modified_time',
  'last_modified_at',
  'last_modified',
  'update_time',
  'modification_time',
  'modify_time',
  'modified_at',
  'modified_time',
  'last_updated_at',
  'last_update_time',
  'request_id',
  'request_time',
  'trace_id',
  'sub_request_status',
  'request_status',
  'stats',
  'statistics',
  'metrics',
  'insights',
  'reporting',
  'pacing_stats',
  'pacing_metrics',
  'total_stats',
  'timeseries_stats',
  'delivery_metrics',
  'delivery_stats',
  'delivery_pacing',
  'spend_to_date',
  'last_synced_at',
  // A pixel's last event (Reddit last_fired_at, PRV-06 D) is telemetry; a review keeps whether and how recently it fired.
  'last_fired_at',
]);
const fieldName = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
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

/** Configuration projection only; never use this to canonicalize a mutation payload. */
export function normalizeReviewState(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) {
    const values = value.map(item => normalizeReviewState(item));
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
        .filter(([key]) => !volatile.has(fieldName(key)))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, normalizeReviewState(item, key)]),
    );
  return typeof value === 'string' ? withoutSigningParameters(value) : value;
}

export const reviewStateHash = (value: unknown) => sha256(stable(normalizeReviewState(value)));

/** JSON paths only: diagnostics must not disclose provider values or credentials. */
export function changedStateFields(expected: unknown, actual: unknown): string[] {
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
  walk(normalizeReviewState(expected), normalizeReviewState(actual), '$');
  return paths;
}
