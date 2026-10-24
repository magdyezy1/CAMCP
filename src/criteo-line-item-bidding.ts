import type {ReviewedFamily} from './reviewed-family.js';
import type {Store} from './store.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {
  assertCriteoLineItemScopes,
  criteoLineItemStateRead,
  criteoKeywordKey,
  criteoKeywordMatchTypes,
  criteoBidMultiplierPages,
} from './criteo-auction-line-items.js';
import {criteoDocs, criteoRoute} from './criteo-version.js';
import {defineFamily, fail} from './family-kit.js';

/**
 * Keywords and bid multipliers of Criteo auction line items on Retail Media API 2026-07 (unchanged from 2026-01), per
 * the pinned OpenAPI document (FetchKeywords, AddRemoveKeywords, SetKeywordBids, GetBidMultipliersByLineItemId,
 * UpdateBidMultipliersByLineItemId) and the 2026.01 "Keywords" and "Bid Multipliers" guides (checked 2026-09-26).
 * - Keywords are added or removed by phrase and match type (positive exact, negative exact, negative broad). Criteo indexes
 *   them by a normalized phrase and lists the phrases supplied for it.
 * - Bids are set by phrase on positive keywords, in the retailer's default currency; null returns to the line item bid.
 * - Bid multipliers scale bids per page type from 0.5 to 6.0. The PUT replaces all of them: a page type left out returns
 *   to 1.0.
 */
const gateway = 'criteo_native_action',
  origin = 'https://api.criteo.com';
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
const phraseOk = (v: unknown): v is string =>
  typeof v === 'string' && v.length >= 1 && v.length <= 255 && v === v.trim() && !/[\u0000-\u001f\u007f]/.test(v);
function invalidKeywords(message: string): never {
  return fail('INVALID_CRITEO_KEYWORDS', message);
}
function invalidMultipliers(message: string): never {
  return fail('INVALID_CRITEO_BID_MULTIPLIERS', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
const list = (items: string[]) =>
  items.slice(0, 10).join(', ') + (items.length > 10 ? ' and ' + (items.length - 10) + ' more' : '');

export function criteoKeywordKind(p: CompiledRequest): 'keywords' | 'bids' | undefined {
  if (p.gateway !== gateway || (p.origin && p.origin !== origin) || p.specialTransport || p.method !== 'POST') return;
  if (
    p.action === 'criteo_catalog_ops/ADD_REMOVE_KEYWORDS' &&
    criteoRoute('/line-items/[1-9][0-9]{0,18}/keywords/add-remove$').test(p.path)
  )
    return 'keywords';
  if (
    p.action === 'criteo_catalog_ops/SET_KEYWORD_BIDS' &&
    criteoRoute('/line-items/[1-9][0-9]{0,18}/keywords/set-bid$').test(p.path)
  )
    return 'bids';
  return;
}
export function criteoBidMultiplierKind(p: CompiledRequest): boolean {
  return (
    p.gateway === gateway &&
    (!p.origin || p.origin === origin) &&
    !p.specialTransport &&
    p.method === 'PUT' &&
    p.action === 'criteo_line_item_ops/UPDATE_BID_MULTIPLIERS_BY_LINE_ITEM_ID' &&
    criteoRoute('/line-items/[1-9][0-9]{0,18}/bid-multipliers$').test(p.path)
  );
}
const lineOf = (p: CompiledRequest) => p.path.split('/')[4]!;
const entries = (p: CompiledRequest): JsonObject[] => (p.body as JsonObject).data.attributes.keywords;
/** The keyword rows of any request body, including one not yet validated. */
const rows = (p: CompiledRequest): JsonObject[] => {
  const k =
    obj(p.body) && obj(p.body.data) && obj(p.body.data.attributes) ? p.body.data.attributes.keywords : undefined;
  return Array.isArray(k) ? k.filter(obj) : [];
};
const multipliersOf = (p: CompiledRequest): JsonObject => (p.body as JsonObject).data.attributes;

function envelope(p: CompiledRequest, type: string, refuse: (message: string) => never): JsonObject {
  if (!id(p.accountId) || Object.keys(p.query).length || Object.keys(p.headers).length)
    refuse('Use one numeric Criteo account without query or header overrides.');
  const b = p.body;
  if (
    !obj(b) ||
    Object.keys(b).some(k => k !== 'data') ||
    !obj(b.data) ||
    Object.keys(b.data).some(k => !['id', 'type', 'attributes'].includes(k)) ||
    !obj(b.data.attributes)
  )
    refuse('Provide the native body {data: {type, attributes}}.');
  if (b.data.id !== undefined && b.data.id !== lineOf(p)) refuse('data.id must be the line item of the path.');
  if (b.data.type !== undefined && b.data.type !== type) refuse('data.type is ' + type + ' when given.');
  return b.data.attributes;
}
export function assertCriteoKeywords(p: CompiledRequest): void {
  const kind = criteoKeywordKind(p);
  if (!kind) return;
  const a = envelope(
    p,
    kind === 'keywords' ? 'RetailMediaKeywordAddRemove' : 'RetailMediaKeywordsSetBid',
    invalidKeywords,
  );
  if (
    Object.keys(a).some(k => k !== 'keywords') ||
    !Array.isArray(a.keywords) ||
    !a.keywords.length ||
    a.keywords.length > 100
  )
    invalidKeywords('Provide attributes.keywords with 1–100 keywords.');
  const fields = kind === 'keywords' ? ['phrase', 'matchType', 'isDeleted'] : ['phrase', 'bid'],
    seen = new Set<string>();
  for (const k of a.keywords) {
    if (!obj(k) || Object.keys(k).length !== fields.length || fields.some(f => !Object.hasOwn(k, f)))
      invalidKeywords(
        kind === 'keywords' ? 'Each keyword is {phrase, matchType, isDeleted}.' : 'Each bid is {phrase, bid}.',
      );
    if (!phraseOk(k.phrase))
      invalidKeywords('A phrase is 1–255 characters without surrounding spaces or control characters.');
    // Criteo folds phrases, so one request names each phrase once.
    const folded = k.phrase.toLowerCase();
    if (seen.has(folded)) invalidKeywords('The phrase "' + k.phrase + '" is listed more than once.');
    seen.add(folded);
    if (kind === 'keywords') {
      if (!criteoKeywordMatchTypes.includes(k.matchType))
        invalidKeywords('matchType must be ' + criteoKeywordMatchTypes.join(', ') + '.');
      if (typeof k.isDeleted !== 'boolean') invalidKeywords('isDeleted must be true or false.');
    } else if (
      k.bid !== null &&
      !(typeof k.bid === 'number' && Number.isFinite(k.bid) && k.bid > 0 && k.bid <= Number.MAX_SAFE_INTEGER)
    )
      invalidKeywords('bid must be a positive amount in the retailer currency, or null to use the line item bid.');
  }
}
export function assertCriteoBidMultipliers(p: CompiledRequest): void {
  if (!criteoBidMultiplierKind(p)) return;
  const a = envelope(p, 'LineItemBidMultipliersV2', invalidMultipliers);
  if (a.id !== undefined && a.id !== lineOf(p)) invalidMultipliers('attributes.id must be the line item of the path.');
  const unknown = Object.keys(a).filter(k => k !== 'id' && !criteoBidMultiplierPages.includes(k));
  if (unknown.length) invalidMultipliers('Unknown page types: ' + unknown.join(', ') + '.');
  const missing = criteoBidMultiplierPages.filter(k => !Object.hasOwn(a, k));
  if (missing.length)
    invalidMultipliers(
      'Include every page type; the PUT returns a page type left out to 1.0. Missing: ' + missing.join(', ') + '.',
    );
  for (const page of criteoBidMultiplierPages) {
    const v = a[page];
    if (v === null && page === 'aiAssistant') continue;
    if (!(typeof v === 'number' && Number.isFinite(v) && v >= 0.5 && v <= 6))
      invalidMultipliers(page + ' must be from 0.5 to 6.0' + (page === 'aiAssistant' ? ', or null' : '') + '.');
  }
}
/** Ownership of the line item comes from the account's line item list or its verified creation through AMCP. */
export function authorizeCriteoLineItemBidding(
  p: CompiledRequest,
  c: Connection,
  store: Store,
  account: string,
): boolean {
  if (!criteoKeywordKind(p) && !criteoBidMultiplierKind(p)) return false;
  assertCriteoKeywords(p);
  assertCriteoBidMultipliers(p);
  assertCriteoLineItemScopes(c, true);
  if (!store.ownsResource(c, account, 'criteo-report-target/line-items/' + lineOf(p)))
    fail(
      'RESOURCE_SCOPE_REQUIRED',
      'List the line item in this account first (GET_LINE_ITEMS_BY_ACCOUNT_ID with limitToId), or create it through AMCP. Preparation rereads the current membership.',
      {},
      403,
    );
  return true;
}
export function criteoLineItemBiddingReads(p: CompiledRequest): CompiledRequest[] {
  return [
    criteoLineItemStateRead(p, {
      lineItemId: lineOf(p),
      siblings: false,
      ...(criteoBidMultiplierKind(p) ? {multipliers: true} : {keywords: true}),
    }),
  ];
}

/** Every supplied phrase of the line item, by match type and folded phrase. */
function supplied(state: JsonObject): Map<string, JsonObject> {
  const m = new Map<string, JsonObject>();
  for (const k of Array.isArray(state.keywords) ? state.keywords : [])
    for (const phrase of k.phrases) m.set(criteoKeywordKey(k.matchType, phrase), k);
  return m;
}
export function validateCriteoLineItemBiddingPrerequisites(plan: CompiledRequest, states: unknown[]): void {
  const kind = criteoKeywordKind(plan),
    multipliers = criteoBidMultiplierKind(plan);
  if (!kind && !multipliers) return;
  const s = states[0];
  if (!obj(s) || !obj(s.line)) unverified('Missing verified Criteo line item state.');
  if (s.line.status === 'archived')
    (multipliers ? invalidMultipliers : invalidKeywords)(
      'Line item ' + s.line.id + ' is archived and cannot be changed.',
    );
  if (multipliers) {
    const m = s.multipliers;
    if (!obj(m)) unverified('Missing verified Criteo bid multipliers.');
    if (Array.isArray(m.unknownFields) && m.unknownFields.length)
      fail(
        'INCOMPLETE_STATE',
        'Line item ' +
          s.line.id +
          ' has bid multipliers for page types this contract does not know (' +
          m.unknownFields.join(', ') +
          '); the PUT would reset them.',
        {fields: m.unknownFields},
        409,
      );
    const a = multipliersOf(plan);
    if (criteoBidMultiplierPages.every(page => (a[page] ?? null) === (m[page] ?? null)))
      invalidMultipliers('The bid multipliers already match this request.');
    return;
  }
  if (!Array.isArray(s.keywords)) unverified('Missing verified Criteo keywords.');
  const current = supplied(s),
    line = s.line.id;
  if (kind === 'keywords') {
    const exists: string[] = [],
      missing: string[] = [],
      other: string[] = [];
    for (const k of entries(plan)) {
      const here = current.has(criteoKeywordKey(k.matchType, k.phrase));
      if (k.isDeleted && !here) missing.push(k.phrase);
      if (!k.isDeleted && here) exists.push(k.phrase);
      // A normalized keyword has one match type; changing it takes a removal first.
      if (
        !k.isDeleted &&
        !here &&
        criteoKeywordMatchTypes.some(t => t !== k.matchType && current.has(criteoKeywordKey(t, k.phrase)))
      )
        other.push(k.phrase);
    }
    if (exists.length)
      fail(
        'CONFIGURATION_EXISTS',
        'Line item ' + line + ' already has these keywords with that match type: ' + list(exists) + '.',
        {phrases: exists.slice(0, 50)},
      );
    if (missing.length)
      fail(
        'STATE_TARGET_MISMATCH',
        'Line item ' +
          line +
          ' has no keyword with that phrase and match type: ' +
          list(missing) +
          '. Remove a phrase as it was supplied.',
        {phrases: missing.slice(0, 50)},
        409,
      );
    if (other.length)
      invalidKeywords(
        'These phrases are keywords of line item ' +
          line +
          ' with another match type; remove them first: ' +
          list(other) +
          '.',
      );
    return;
  }
  const missing: string[] = [],
    same: string[] = [],
    shared = new Map<string, unknown>();
  for (const k of entries(plan)) {
    const e = current.get(criteoKeywordKey('PositiveExactMatch', k.phrase));
    if (!e) {
      missing.push(k.phrase);
      continue;
    }
    if (e.bid === k.bid) same.push(k.phrase);
    // Phrases supplied for one normalized keyword share its bid.
    if (shared.has(e.keyword) && shared.get(e.keyword) !== k.bid)
      invalidKeywords('Phrases of the keyword "' + e.keyword + '" share one bid; give them the same bid.');
    shared.set(e.keyword, k.bid);
  }
  if (missing.length)
    fail(
      'STATE_TARGET_MISMATCH',
      'Bids apply to positive exact keywords of line item ' + line + '; not found: ' + list(missing) + '.',
      {phrases: missing.slice(0, 50)},
      409,
    );
  if (same.length) invalidKeywords('These keywords already have this bid: ' + list(same) + '.');
}
/** Adding positive keywords or removing negative ones widens where a line item that is not paused can serve. */
export function criteoLineItemBiddingServing(plan: CompiledRequest, before: unknown): boolean {
  if (criteoKeywordKind(plan) !== 'keywords' || !criteoKeywordsWiden(plan)) return false;
  const s = Array.isArray(before) ? before[0] : undefined;
  return !(obj(s) && obj(s.line) && s.line.status === 'paused');
}
export function criteoKeywordsWiden(plan: CompiledRequest): boolean {
  return (
    criteoKeywordKind(plan) === 'keywords' &&
    rows(plan).some(k => (k.matchType === 'PositiveExactMatch' ? k.isDeleted !== true : k.isDeleted === true))
  );
}
export function criteoLineItemBiddingImpact(plan: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = criteoKeywordKind(plan),
    multipliers = criteoBidMultiplierKind(plan);
  if (!kind && !multipliers) return;
  const first = state[0],
    s: JsonObject = obj(first) ? first : {},
    line = obj(s.line)
      ? {id: s.line.id, name: s.line.name, status: s.line.status, target_bid: s.line.targetBid, max_bid: s.line.maxBid}
      : null;
  const base = {
    provider: 'criteo',
    line_item: line,
    may_affect_serving: true,
    source: multipliers ? criteoDocs('bid-multipliers') : criteoDocs('keywords'),
  };
  if (multipliers) {
    const a = multipliersOf(plan),
      m = obj(s.multipliers) ? s.multipliers : {};
    const before = Object.fromEntries(criteoBidMultiplierPages.map(page => [page, m[page] ?? null])),
      after = Object.fromEntries(criteoBidMultiplierPages.map(page => [page, a[page] ?? null]));
    return {
      ...base,
      scope: 'bid_multipliers',
      before,
      after,
      changed: criteoBidMultiplierPages.filter(page => before[page] !== after[page]),
      effect:
        'Replaces the bid multiplier of every page type: bids on a page type are multiplied by its value (1.0 is neutral). Page types the retailer does not offer have no effect.',
      verification: 'Reads the bid multipliers again and compares every page type.',
    };
  }
  const current = supplied(s),
    keywords = entries(plan);
  if (kind === 'bids')
    return {
      ...base,
      scope: 'keyword_bids',
      bids: keywords.map(k => {
        const e = current.get(criteoKeywordKey('PositiveExactMatch', k.phrase));
        return {
          phrase: k.phrase,
          keyword: e?.keyword ?? null,
          review_state: e?.reviewState ?? null,
          before: e?.bid ?? null,
          after: k.bid,
        };
      }),
      units:
        'Keyword bids are in the retailer default currency, which can differ from the account currency. They must be at least the minimum bid of the retailer and at most the line item maxBid; null returns to the line item bid.',
      effect: 'Sets the bid of positive keywords of the line item, also while they are in review.',
      verification: 'Reads the keywords again and compares the bid of the keyword each phrase belongs to.',
    };
  const group = (deleted: boolean, type: string) =>
    keywords.filter(k => k.isDeleted === deleted && k.matchType === type).map(k => k.phrase);
  return {
    ...base,
    scope: 'keywords',
    added: Object.fromEntries(criteoKeywordMatchTypes.map(t => [t, group(false, t)])),
    removed: Object.fromEntries(criteoKeywordMatchTypes.map(t => [t, group(true, t)])),
    keywords_before: Array.isArray(s.keywords) ? s.keywords.length : null,
    widens_delivery: criteoKeywordsWiden(plan),
    effect:
      'Adds and removes keywords of the line item. Positive exact keywords are submitted for retailer review; negative keywords stop the line item from bidding on matching searches.',
    verification: 'Reads the keywords again and checks each phrase under its match type.',
  };
}
function accepted(r: TransportResult): boolean {
  const d = r.data;
  if (r.status === 204) return d == null || d === '' || (obj(d) && !Object.keys(d).length);
  return (
    r.status === 200 &&
    (d == null ||
      (obj(d) &&
        d.error === undefined &&
        ['errors', 'warnings'].every(k => d[k] == null || (Array.isArray(d[k]) && !d[k].length))))
  );
}
export function criteoLineItemBiddingOutcome(plan: CompiledRequest, r: TransportResult): boolean {
  if (!accepted(r)) return false;
  return !criteoBidMultiplierKind(plan) || (obj(r.data) && obj(r.data.data) && obj(r.data.data.attributes));
}
export function criteoLineItemBiddingVerification(
  plan: CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const read = criteoLineItemBiddingReads(plan)[0]!,
    line = lineOf(plan);
  if (criteoBidMultiplierKind(plan)) {
    const a = multipliersOf(plan);
    return [
      {
        read,
        expected: {multipliers: Object.fromEntries(criteoBidMultiplierPages.map(page => [page, a[page] ?? null]))},
        id: 'bid multipliers of line item ' + line,
      },
    ];
  }
  const kind = criteoKeywordKind(plan)!,
    expected: JsonObject = {};
  // Presence is compared explicitly, so a missing keyword never matches an expected empty bid.
  for (const k of entries(plan)) {
    if (kind === 'bids') expected[criteoKeywordKey('PositiveExactMatch', k.phrase)] = {present: true, bid: k.bid};
    else expected[criteoKeywordKey(k.matchType, k.phrase)] = k.isDeleted ? null : {present: true};
  }
  return [
    {
      read,
      expected: {keywords: expected},
      id: (kind === 'bids' ? 'keyword bids' : 'keywords') + ' of line item ' + line,
    },
  ];
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const criteoBidMultiplierFamily: ReviewedFamily = defineFamily({
  name: 'criteo_bid_multipliers',
  files: ['src/criteo-line-item-bidding.ts', ['tests/criteo-line-item-bidding.test.mjs']],
  kind: criteoBidMultiplierKind,
  assert: plan => {
    assertCriteoKeywords(plan);
    assertCriteoBidMultipliers(plan);
  },
  scope: (c, write) => assertCriteoLineItemScopes(c, write),
  snapshots: criteoLineItemBiddingReads,
  prerequisites: (plan, state) => validateCriteoLineItemBiddingPrerequisites(plan, state),
  impact: criteoLineItemBiddingImpact,
  outcome: criteoLineItemBiddingOutcome,
  verification: (plan: CompiledRequest) => criteoLineItemBiddingVerification(plan),
  spendConfirmation: {
    needed: plan =>
      !!(criteoKeywordsWiden(plan) || criteoKeywordKind(plan) === 'bids' || criteoBidMultiplierKind(plan)),
    message:
      'Keywords that widen delivery, keyword bids and bid multipliers change where and at what price the line item bids. Review them and provide spend_change_confirmed=true.',
  },
  exemptFromSpendTextMatch: true,
  activates: (plan, before) => !!criteoLineItemBiddingServing(plan, before),
});

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const criteoKeywordFamily: ReviewedFamily = defineFamily({
  name: 'criteo_keywords',
  files: ['src/criteo-line-item-bidding.ts', ['tests/criteo-line-item-bidding.test.mjs']],
  kind: criteoKeywordKind,
  assert: plan => {
    assertCriteoKeywords(plan);
    assertCriteoBidMultipliers(plan);
  },
  scope: (c, write) => assertCriteoLineItemScopes(c, write),
  authorize: (plan, connection, account, store) => authorizeCriteoLineItemBidding(plan, connection, store, account),
  snapshots: criteoLineItemBiddingReads,
  prerequisites: (plan, state) => validateCriteoLineItemBiddingPrerequisites(plan, state),
  impact: criteoLineItemBiddingImpact,
  outcome: criteoLineItemBiddingOutcome,
  verification: (plan: CompiledRequest) => criteoLineItemBiddingVerification(plan),
  spendConfirmation: {
    needed: plan =>
      !!(criteoKeywordsWiden(plan) || criteoKeywordKind(plan) === 'bids' || criteoBidMultiplierKind(plan)),
    message:
      'Keywords that widen delivery, keyword bids and bid multipliers change where and at what price the line item bids. Review them and provide spend_change_confirmed=true.',
  },
  exemptFromSpendTextMatch: true,
  activates: (plan, before) => !!criteoLineItemBiddingServing(plan, before),
});
