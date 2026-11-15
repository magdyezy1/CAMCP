import {MirrorError} from './errors.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {assertDV360WriteScope} from './dv360-scope.js';
import {accountConflict} from './account-id.js';
import {defineFamily, fail, stateReadOf} from './family-kit.js';

/**
 * Advertiser-owned custom bidding algorithms on Display & Video 360 API v4, per the pinned Discovery document
 * (customBiddingAlgorithms create, patch and get; CustomBiddingAlgorithm; checked 2026-09-27).
 * - An algorithm has a display name ("maximum size of 240 bytes"), an immutable type (SCRIPT_BASED or RULE_BASED) and an
 *   owner: the advertiser in advertiserId, or a partner. Its entityStatus "Controls whether or not the custom bidding
 *   algorithm can be used as a bidding strategy. Accepted values are: ENTITY_STATUS_ACTIVE, ENTITY_STATUS_ARCHIVED".
 * - It bids only after a script or rules are uploaded (file uploads, outside this contract) and a line item uses it, which
 *   is a separate reviewed line item change. "Requests updating a custom bidding algorithm assigned to a line item will
 *   return an error."
 * - The patch path names no advertiser, so the review reads the algorithm with the advertiser as accessor and changes only
 *   algorithms that advertiser owns; the owner rides in the body, which DV360 ignores outside updateMask.
 */
type Kind = 'create' | 'patch';
type State = {algorithmId?: string; optional?: boolean};
type Read = CompiledRequest & {dv360BiddingState?: State};
const gateway = 'dv360_native_action',
  origin = 'https://displayvideo.googleapis.com',
  oauthScope = 'https://www.googleapis.com/auth/display-video';
const algorithms = '/v4/customBiddingAlgorithms',
  types = ['SCRIPT_BASED', 'RULE_BASED'],
  statuses = ['ENTITY_STATUS_ACTIVE', 'ENTITY_STATUS_ARCHIVED'];
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[1-9]\d{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
function invalid(message: string): never {
  return fail('INVALID_DV360_CUSTOM_BIDDING', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
function denied(message: string): never {
  return fail('RESOURCE_SCOPE_REQUIRED', message, {}, 403);
}
export function dv360BiddingKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || (p.origin !== undefined && p.origin !== origin) || p.specialTransport) return;
  if (p.method === 'POST' && p.path === algorithms) return 'create';
  if (p.method === 'PATCH' && /^\/v4\/customBiddingAlgorithms\/[1-9]\d{0,18}$/.test(p.path)) return 'patch';
  return;
}
const algorithmOf = (p: CompiledRequest) => p.path.split('/')[3]!;
const body = (p: CompiledRequest): JsonObject => (obj(p.body) ? p.body : {});
function name(v: unknown): void {
  if (
    typeof v !== 'string' ||
    !v.trim() ||
    v !== v.trim() ||
    Buffer.byteLength(v, 'utf8') > 240 ||
    /[\u0000-\u001f\u007f]/.test(v)
  )
    invalid('displayName has 1–240 bytes of UTF-8 without surrounding spaces or control characters.');
}
export function assertDV360Bidding(p: CompiledRequest): void {
  const kind = dv360BiddingKind(p);
  if (!kind) return;
  if (Object.keys(p.headers ?? {}).length) invalid('Custom bidding writes take no header overrides.');
  const b = p.body;
  if (!obj(b)) invalid('Provide the CustomBiddingAlgorithm body.');
  if (b.advertiserId !== p.accountId || !id(b.advertiserId))
    fail(
      'ACCOUNT_SCOPE_MISMATCH',
      'advertiserId in the body must be the selected advertiser; partner-owned algorithms are outside this contract.',
      // A request that names another advertiser is at fault, not a grant (review S3-2); the compile hook has already sent the
      // number of the selected advertiser's digits as its string (src/dv360-adapter.ts).
      accountConflict(b.advertiserId),
      403,
    );
  if (kind === 'create') {
    if (Object.keys(p.query).length) invalid('Creation takes no query parameters.');
    const extra = Object.keys(b).filter(
      k => !['advertiserId', 'displayName', 'customBiddingAlgorithmType', 'entityStatus'].includes(k),
    );
    if (extra.length)
      invalid(
        (extra.some(k => ['partnerId', 'sharedAdvertiserIds', 'thirdPartyOptimizationPartner'].includes(k))
          ? 'Partner ownership, sharing and third-party partners are outside this contract. '
          : '') +
          'Unqualified fields: ' +
          extra.join(', ') +
          '.',
      );
    name(b.displayName);
    if (!types.includes(b.customBiddingAlgorithmType))
      invalid('customBiddingAlgorithmType is SCRIPT_BASED or RULE_BASED.');
    if (b.entityStatus !== undefined && !statuses.includes(b.entityStatus))
      invalid('entityStatus is ENTITY_STATUS_ACTIVE or ENTITY_STATUS_ARCHIVED.');
    return;
  }
  if (Object.keys(p.query).some(k => k !== 'updateMask') || typeof p.query.updateMask !== 'string')
    invalid('A patch takes only updateMask in the query; the advertiser rides in the body.');
  const mask = String(p.query.updateMask).split(',');
  if (
    !mask.length ||
    mask.some(f => !['displayName', 'entityStatus'].includes(f)) ||
    new Set(mask).size !== mask.length
  )
    invalid('updateMask lists displayName, entityStatus or both; the type and owner are immutable.');
  const fields = Object.keys(b).filter(k => k !== 'advertiserId');
  if (fields.some(k => !mask.includes(k)) || mask.some(k => !Object.hasOwn(b, k)))
    invalid('The body carries advertiserId and exactly the fields named in updateMask.');
  if (b.displayName !== undefined) name(b.displayName);
  if (b.entityStatus !== undefined && !statuses.includes(b.entityStatus))
    invalid('entityStatus is ENTITY_STATUS_ACTIVE or ENTITY_STATUS_ARCHIVED.');
}
/** Writes and algorithm reads name the selected advertiser; partner access is never used. */
export function authorizeDV360Bidding(p: CompiledRequest, c: Connection, account: string): boolean {
  if (p.gateway !== gateway || (p.origin !== undefined && p.origin !== origin) || p.specialTransport) return false;
  if (dv360BiddingKind(p)) {
    assertDV360Bidding(p);
    if (p.accountId !== account)
      fail('ACCOUNT_SCOPE_MISMATCH', 'advertiserId must be the selected advertiser.', {}, 403);
    assertDV360BiddingScope(c);
    return true;
  }
  if (p.method !== 'GET' || !p.readOnly || p.body !== undefined) return false;
  const m = /^\/v4\/customBiddingAlgorithms(?:\/([1-9]\d{0,18}))?$/.exec(p.path);
  if (!m) return false;
  const allowed = m[1] ? ['advertiserId'] : ['advertiserId', 'pageSize', 'pageToken', 'orderBy', 'filter'];
  if (p.query.advertiserId !== account)
    denied(
      'DV360 custom bidding reads name the selected advertiser in advertiserId; partnerId would use partner access, which this connection is not bound to.',
    );
  const extra = Object.keys(p.query).filter(k => !allowed.includes(k));
  if (extra.length) denied('This DV360 read takes only ' + allowed.join(', ') + '.');
  if (Object.keys(p.headers ?? {}).length) denied('DV360 custom bidding reads take no header overrides.');
  assertDV360BiddingScope(c);
  return true;
}
export function assertDV360BiddingScope(c: Connection): void {
  if (!c.scopes.includes(oauthScope))
    fail('INSUFFICIENT_SCOPE', 'Reconnect the selected DV360 connection with display-video scope.', {}, 403);
}
const read = (p: CompiledRequest, path: string, query: JsonObject = {}): Read =>
  stateReadOf<Read>(p, 'AMCP_DV360_CUSTOM_BIDDING_READ', path, query, {dv360BiddingState: undefined});
const stateRead = (p: CompiledRequest, s: State): Read => ({
  ...read(p, '/v4/advertisers/' + p.accountId),
  dv360BiddingState: s,
});
export function dv360BiddingSnapshots(p: CompiledRequest): Read[] {
  return [stateRead(p, dv360BiddingKind(p) === 'patch' ? {algorithmId: algorithmOf(p)} : {})];
}
export function isDV360BiddingRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).dv360BiddingState;
}
function payload(r: TransportResult, label: string): JsonObject {
  if (r.status !== 200 || !obj(r.data)) unverified('DV360 did not return the ' + label + '.');
  return r.data as JsonObject;
}
const view = (a: JsonObject) => ({
  present: true,
  customBiddingAlgorithmId: String(a.customBiddingAlgorithmId),
  displayName: a.displayName ?? null,
  customBiddingAlgorithmType: a.customBiddingAlgorithmType ?? null,
  entityStatus: a.entityStatus ?? null,
  advertiserId: a.advertiserId === undefined ? null : String(a.advertiserId),
  partnerId: a.partnerId === undefined ? null : String(a.partnerId),
});
export async function readDV360Bidding(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).dv360BiddingState;
  if (!s) return fetch(p);
  const advertiser = p.accountId!;
  const a = payload(await fetch({...(p as Read), dv360BiddingState: undefined} as Read), 'advertiser');
  if (String(a.advertiserId) !== advertiser || a.name !== 'advertisers/' + advertiser)
    fail('STATE_TARGET_MISMATCH', 'DV360 returned a different advertiser.', {}, 409);
  const out: JsonObject = {
    advertiser: {
      advertiserId: advertiser,
      partnerId: a.partnerId === undefined ? null : String(a.partnerId),
      entityStatus: a.entityStatus ?? null,
    },
  };
  if (s.algorithmId) {
    let r: TransportResult | undefined;
    try {
      r = await fetch(read(p, algorithms + '/' + s.algorithmId, {advertiserId: advertiser}));
    } catch (e) {
      if (!(e instanceof MirrorError && (e.status === 404 || e.code === 'NOT_FOUND'))) throw e;
      if (!s.optional)
        fail(
          'STATE_NOT_FOUND',
          'Custom bidding algorithm ' + s.algorithmId + ' is not accessible to advertiser ' + advertiser + '.',
          {custom_bidding_algorithm_id: s.algorithmId},
          404,
        );
    }
    if (r) {
      const g = payload(r, 'custom bidding algorithm');
      if (String(g.customBiddingAlgorithmId) !== s.algorithmId || g.name !== 'customBiddingAlgorithms/' + s.algorithmId)
        fail('STATE_TARGET_MISMATCH', 'DV360 returned a different custom bidding algorithm.', {}, 409);
      out.algorithm = view(g);
    } else out.algorithm = {present: false, customBiddingAlgorithmId: s.algorithmId};
  }
  return {status: 200, headers: {}, data: out};
}
export function validateDV360BiddingState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).dv360BiddingState,
    d = r.data;
  if (!s || r.status !== 200 || !obj(d) || !obj(d.advertiser) || !!s.algorithmId !== obj(d.algorithm))
    unverified('Missing verified custom bidding state.');
}
export function dv360BiddingPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = dv360BiddingKind(p);
  if (!kind) return;
  const s = states[0];
  if (!obj(s) || !obj(s.advertiser)) unverified('Missing verified custom bidding state.');
  if (kind === 'create') return;
  const g = s.algorithm;
  if (!obj(g) || g.present !== true) unverified('Missing verified custom bidding state.');
  if (g.advertiserId !== p.accountId)
    fail(
      'ACCOUNT_SCOPE_MISMATCH',
      'Custom bidding algorithm ' +
        algorithmOf(p) +
        ' is owned by ' +
        (g.partnerId ? 'partner ' + g.partnerId : 'another advertiser') +
        '; only its owner changes it.',
      {custom_bidding_algorithm_id: algorithmOf(p)},
      403,
    );
  const b = body(p);
  if (['displayName', 'entityStatus'].every(k => b[k] === undefined || b[k] === g[k]))
    invalid('Custom bidding algorithm ' + algorithmOf(p) + ' already has these values.');
}
export function dv360BiddingImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = dv360BiddingKind(p);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = obj(first) ? first : {},
    b = body(p),
    before = obj(s.algorithm) ? s.algorithm : null;
  return {
    provider: 'dv360',
    scope: 'custom_bidding_algorithm',
    operation: kind,
    advertiser: obj(s.advertiser) ? s.advertiser : null,
    before,
    after: {...(before ?? {}), ...b},
    may_affect_serving: false,
    effect:
      kind === 'create'
        ? 'Creates a ' +
          String(b.customBiddingAlgorithmType) +
          ' custom bidding algorithm of the advertiser; it bids only after a script or rules are uploaded and a line item uses it.'
        : 'Changes the ' +
          Object.keys(b)
            .filter(k => k !== 'advertiserId')
            .join(' and ') +
          ' of the algorithm; DV360 refuses changes to an algorithm assigned to a line item.',
    verification:
      'Reads the algorithm again with the advertiser as accessor and compares its name, type, status and owner.',
    source: 'https://developers.google.com/display-video/api/reference/rest/v4/customBiddingAlgorithms',
  };
}
export function dv360BiddingOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = dv360BiddingKind(p)!,
    d = r.data,
    b = body(p);
  if (r.status !== 200 || !obj(d) || !id(String(d.customBiddingAlgorithmId)) || String(d.advertiserId) !== p.accountId)
    return false;
  if (kind === 'patch' && String(d.customBiddingAlgorithmId) !== algorithmOf(p)) return false;
  return ['displayName', 'customBiddingAlgorithmType', 'entityStatus'].every(k => b[k] === undefined || d[k] === b[k]);
}
export function dv360BiddingVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = dv360BiddingKind(p)!,
    algorithm = kind === 'create' ? String(result.data?.customBiddingAlgorithmId ?? '') : algorithmOf(p),
    b = body(p);
  if (!id(algorithm)) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no custom bidding algorithm to verify.');
  const expected: JsonObject = {
    present: true,
    customBiddingAlgorithmId: algorithm,
    advertiserId: p.accountId!,
    ...Object.fromEntries(
      ['displayName', 'customBiddingAlgorithmType', 'entityStatus'].filter(k => b[k] !== undefined).map(k => [k, b[k]]),
    ),
  };
  return [
    {
      read: stateRead(p, {algorithmId: algorithm, optional: true}),
      expected: {algorithm: expected},
      id: 'custom bidding algorithm ' + algorithm,
    },
  ];
}
export function dv360BiddingObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {algorithm: obj(data.algorithm) ? data.algorithm : null};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const dv360BiddingFamily: ReviewedFamily = defineFamily({
  name: 'dv360_custom_bidding',
  files: ['src/dv360-custom-bidding.ts', ['tests/dv360-custom-bidding.test.mjs']],
  kind: dv360BiddingKind,
  assert: assertDV360Bidding,
  scope: assertDV360WriteScope,
  authorize: authorizeDV360Bidding,
  snapshots: dv360BiddingSnapshots,
  isRead: isDV360BiddingRead,
  reader: readDV360Bidding,
  validateState: validateDV360BiddingState,
  prerequisites: dv360BiddingPrerequisites,
  impact: dv360BiddingImpact,
  outcome: dv360BiddingOutcome,
  verification: dv360BiddingVerification,
  observed: dv360BiddingObserved,
  exemptFromSpendTextMatch: true,
});
