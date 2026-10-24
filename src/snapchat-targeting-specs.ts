import {assertNoMethodOverride} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {stable} from './security.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {defineFamily, fail, readOf} from './family-kit.js';

/**
 * Snapchat ad squad targeting specs, per Snap's Audience Targeting page, "Targeting Specs - Greater than 500 rows"
 * (read 2026-09-30): an ad squad with more than 500 targeting criteria keeps them in a targeting_specs sub-resource and
 * shows separated_types instead; "you can no longer use the Ad Squad endpoint to update the targeting criteria". An
 * ad squad has one spec. PUT /v1/adsquads/{ad_squad_id}/targeting_specs replaces it with {targeting_specs: [{id, type:
 * "GEO", geos}]} ("currently only GEO"; "a maximum limit of 4,000 targeting criteria"); GET the same path reads it.
 * A geo names a country_code with its operation (INCLUDE or EXCLUDE) and, within it, region_id, metro_id or
 * postal_code lists. Changing where an ad squad serves changes its delivery, so the review needs spending confirmation.
 */
type Read = CompiledRequest & {snapchatSpecPage?: true; snapchatSpecState?: true; snapchatSpecCheck?: string};
const route = /^\/v1\/adsquads\/([\w-]{1,64})\/targeting_specs$/,
  specId = /^[\w-]{1,64}$/,
  marker = 'AMCP_SNAPCHAT_TARGETING_SPEC_READ',
  source = 'https://developers.snap.com/api/marketing-api/Ads-API/audience-targeting',
  maxCriteria = 4000,
  lists = ['region_id', 'metro_id', 'postal_code'];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(message: string): never {
  return fail('INVALID_SNAPCHAT_TARGETING_SPEC', message, {source});
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function snapchatSpecKind(p: CompiledRequest): boolean {
  return (
    p.gateway === 'snapchat_native_action' &&
    p.method === 'PUT' &&
    !p.specialTransport &&
    (!p.origin || p.origin === 'https://adsapi.snapchat.com') &&
    route.test(p.path)
  );
}
const squad = (p: CompiledRequest) => route.exec(p.path)![1]!;
const spec = (p: CompiledRequest) => ((p.body as JsonObject).targeting_specs as JsonObject[])[0]!;
/** One geo entry: a country, its operation, and at most one list inside it. Returns its number of criteria. */
function geo(v: unknown, i: number): number {
  const at = 'geos[' + i + ']';
  if (!object(v)) invalid(at + ' is an object.');
  const keys = Object.keys(v),
    inner = keys.filter(k => lists.includes(k));
  if (keys.some(k => !['country_code', 'operation', ...lists].includes(k)))
    invalid(at + ' takes country_code, operation and one of ' + lists.join(', ') + '.');
  if (typeof v.country_code !== 'string' || !/^[A-Za-z]{2}$/.test(v.country_code))
    invalid(at + '.country_code is a two-letter country code.');
  if (!['INCLUDE', 'EXCLUDE'].includes(v.operation as string)) invalid(at + '.operation is INCLUDE or EXCLUDE.');
  if (inner.length > 1) invalid(at + ' names one of ' + lists.join(', ') + '; put each in its own entry.');
  if (!inner.length) return 1;
  const list = v[inner[0]!];
  if (
    !Array.isArray(list) ||
    !list.length ||
    list.some(x => typeof x !== 'string' || !/^[A-Za-z0-9 -]{1,20}$/.test(x)) ||
    new Set(list).size !== list.length
  )
    invalid(at + '.' + inner[0] + ' lists distinct IDs or codes as strings.');
  return list.length;
}
export function assertSnapchatSpec(p: CompiledRequest): void {
  if (!snapchatSpecKind(p)) return;
  assertNoMethodOverride(p);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('A targeting spec update takes no query or header overrides.');
  const b = p.body;
  if (!object(b) || Object.keys(b).join() !== 'targeting_specs' || !Array.isArray(b.targeting_specs))
    invalid('The body is {targeting_specs: [{id, type: "GEO", geos}]}.');
  if (b.targeting_specs.length !== 1) invalid('An ad squad has one targeting spec; send exactly one.');
  const s = b.targeting_specs[0];
  if (!object(s) || Object.keys(s).sort().join() !== 'geos,id,type')
    invalid('The targeting spec takes id, type and geos.');
  if (typeof s.id !== 'string' || !specId.test(s.id)) invalid('id is the ID of the ad squad’s targeting spec.');
  if (s.type !== 'GEO') invalid('type is GEO, the only type Snap documents for targeting specs.');
  if (!Array.isArray(s.geos) || !s.geos.length) invalid('geos lists at least one geo entry.');
  const total = (s.geos as unknown[]).reduce<number>((n, g, i) => n + geo(g, i), 0);
  if (total > maxCriteria)
    invalid('A targeting spec holds at most ' + maxCriteria + ' criteria; this one has ' + total + '.');
  if (!(s.geos as JsonObject[]).some(g => g.operation === 'INCLUDE'))
    invalid('geos includes at least one location; exclusions alone target nowhere.');
}
function read(p: CompiledRequest, path: string): Read {
  return readOf<Read>(
    p,
    {action: marker, path, query: {}, clears: ['responseControls']},
    {snapchatSpecPage: true, snapchatSpecState: undefined, snapchatSpecCheck: undefined},
  );
}
export function snapchatSpecSnapshots(p: CompiledRequest): Read[] {
  return [{...read(p, '/v1/adsquads/' + squad(p)), snapchatSpecState: true}];
}
export function isSnapchatSpecRead(p: CompiledRequest): p is Read {
  return !!(p as Read).snapchatSpecState || !!(p as Read).snapchatSpecCheck;
}
/** The family's reads: the ad squad, its campaign and account, and its targeting spec. */
export function authorizeSnapchatSpec(p: CompiledRequest, _c: Connection, selected: string): boolean {
  if (p.gateway !== 'snapchat_native_action' || p.action !== marker) return false;
  if (
    !(p as Read).snapchatSpecPage ||
    p.method !== 'GET' ||
    !p.readOnly ||
    p.body !== undefined ||
    Object.keys(p.query).length ||
    p.accountId !== selected
  )
    return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal targeting spec read.', {}, 403);
  if (
    p.path === '/v1/adaccounts/' + selected ||
    /^\/v1\/(?:adsquads|campaigns)\/[\w-]{1,64}$/.test(p.path) ||
    route.test(p.path)
  )
    return true;
  return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal targeting spec read.', {}, 403);
}
function single(d: unknown, key: string, entity: string, label: string): JsonObject {
  if (
    !object(d) ||
    String(d.request_status).toUpperCase() !== 'SUCCESS' ||
    !Array.isArray(d[key]) ||
    d[key].length !== 1
  )
    unverified('Snapchat did not return ' + label + '.');
  const row = (d[key] as JsonObject[])[0]!,
    e = object(row) ? row[entity] : undefined;
  if (String(row?.sub_request_status).toUpperCase() !== 'SUCCESS' || !object(e))
    unverified('Snapchat did not return ' + label + '.');
  return e as JsonObject;
}
/** Geos in one order and case, so Snap's ordering or case never reads as a change. */
export function normalGeos(v: unknown): JsonObject[] {
  return (Array.isArray(v) ? (v as JsonObject[]) : [])
    .filter(object)
    .map(g => {
      const out: JsonObject = {country_code: String(g.country_code).toLowerCase(), operation: g.operation ?? 'INCLUDE'};
      for (const k of lists) if (Array.isArray(g[k])) out[k] = [...(g[k] as string[])].map(String).sort();
      return out;
    })
    .sort((a, b) => stable(a).localeCompare(stable(b)));
}
const criteria = (geos: JsonObject[]) =>
  geos.reduce(
    (n, g) => n + (lists.map(k => (Array.isArray(g[k]) ? (g[k] as unknown[]).length : 0)).find(x => x) ?? 1),
    0,
  );
function specView(s: JsonObject): JsonObject {
  const geos = normalGeos(s.geos);
  return {id: s.id ?? null, type: s.type ?? null, container_id: s.container_id ?? null, geos, criteria: criteria(geos)};
}
/**
 * An ad squad has one spec, but the targeting_specs read is a collection: an answer that names another page
 * (paging.next_link) is not the whole set, so neither the review nor the read-back uses it.
 */
function morePages(d: JsonObject): void {
  if (object(d.paging) && d.paging.next_link)
    unverified('Snapchat listed the targeting specs of this ad squad on more than one page.');
}
export async function readSnapchatSpec(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const r = p as Read;
  if (r.snapchatSpecCheck) {
    const d = (await request(read(p, '/v1/adsquads/' + r.snapchatSpecCheck + '/targeting_specs'))).data;
    if (!object(d) || String(d.request_status).toUpperCase() !== 'SUCCESS' || !Array.isArray(d.targeting_specs))
      unverified('Snapchat did not return the targeting spec.');
    morePages(d);
    const rows = (d.targeting_specs as JsonObject[]).filter(x => object(x) && object(x.targeting_spec));
    return {
      status: 200,
      headers: {},
      data: {spec: rows.length === 1 ? specView(rows[0]!.targeting_spec as JsonObject) : null},
    };
  }
  if (!r.snapchatSpecState) return request(p);
  const id = p.path.split('/')[3]!;
  const sq = single((await request(read(p, '/v1/adsquads/' + id))).data, 'adsquads', 'adsquad', 'ad squad ' + id);
  if (sq.id !== id) unverified('Snapchat returned another ad squad.');
  const campaignId = String(sq.campaign_id ?? '');
  if (!specId.test(campaignId)) unverified('The ad squad names no campaign.');
  const c = single(
    (await request(read(p, '/v1/campaigns/' + campaignId))).data,
    'campaigns',
    'campaign',
    'campaign ' + campaignId,
  );
  const d = (await request(read(p, '/v1/adsquads/' + id + '/targeting_specs'))).data;
  if (!object(d) || String(d.request_status).toUpperCase() !== 'SUCCESS' || !Array.isArray(d.targeting_specs))
    unverified('Snapchat did not return the targeting spec.');
  morePages(d);
  const specs = (d.targeting_specs as JsonObject[])
    .filter(x => object(x) && object(x.targeting_spec))
    .map(x => specView(x.targeting_spec as JsonObject));
  return {
    status: 200,
    headers: {},
    data: {
      adsquad: {
        id,
        name: sq.name ?? null,
        status: sq.status ?? null,
        campaign_id: campaignId,
        separated_types: Array.isArray(object(sq.targeting) ? sq.targeting.separated_types : undefined)
          ? ((sq.targeting as JsonObject).separated_types as unknown[])
          : [],
      },
      campaign: {id: c.id ?? null, ad_account_id: c.ad_account_id ?? null, status: c.status ?? null},
      specs,
    },
  };
}
export function validateSnapchatSpecState(p: CompiledRequest, r: TransportResult): void {
  const d = r.data;
  if (
    !(p as Read).snapchatSpecState ||
    r.status !== 200 ||
    !object(d) ||
    !object(d.adsquad) ||
    !object(d.campaign) ||
    !Array.isArray(d.specs)
  )
    unverified('Missing verified ad squad and targeting spec state.');
}
/** The read-back: the spec AMCP normalized, or null when Snapchat returned none. */
export function validateSnapchatSpecCheck(r: TransportResult): void {
  if (r.status !== 200 || !object(r.data) || !('spec' in r.data))
    unverified('Snapchat did not return the targeting spec.');
}
export function snapchatSpecPrerequisites(p: CompiledRequest, states: unknown[]): void {
  if (!snapchatSpecKind(p)) return;
  const s = states[0];
  if (!object(s) || !object(s.adsquad) || !object(s.campaign) || !Array.isArray(s.specs))
    unverified('Missing verified ad squad and targeting spec state.');
  if (s.campaign.ad_account_id !== p.accountId)
    fail('ACCOUNT_SCOPE_MISMATCH', 'Ad squad ' + squad(p) + ' belongs to another ad account.', {}, 403);
  if (!['ACTIVE', 'PAUSED'].includes(String(s.adsquad.status)))
    invalid(
      'Ad squad ' +
        squad(p) +
        ' is ' +
        String(s.adsquad.status) +
        '; only active and paused ad squads change targeting.',
    );
  const specs = s.specs as JsonObject[];
  if (!(s.adsquad.separated_types as unknown[]).includes('GEO') || specs.length !== 1)
    invalid(
      'Ad squad ' +
        squad(p) +
        ' keeps its targeting in the ad squad itself (500 criteria or fewer), not in a targeting spec; change it with the ad squad.',
    );
  const current = specs[0]!;
  if (current.id !== spec(p).id)
    invalid(
      'The targeting spec of ad squad ' + squad(p) + ' is ' + String(current.id) + ', not ' + String(spec(p).id) + '.',
    );
  if (current.type !== 'GEO') invalid('Targeting spec ' + String(current.id) + ' is not a GEO spec.');
  if (stable(current.geos) === stable(normalGeos(spec(p).geos)))
    invalid('Targeting spec ' + String(current.id) + ' already has these locations.');
}
function countries(geos: JsonObject[], op: string): string[] {
  return [...new Set(geos.filter(g => g.operation === op).map(g => String(g.country_code)))].sort();
}
export function snapchatSpecImpact(p: CompiledRequest, state: unknown[]): JsonObject {
  const s = object(state[0]) ? state[0] : {},
    before = Array.isArray(s.specs) && object(s.specs[0]) ? (s.specs[0] as JsonObject) : {},
    was = Array.isArray(before.geos) ? (before.geos as JsonObject[]) : [],
    next = normalGeos(spec(p).geos),
    keyed = (list: JsonObject[]) => new Set(list.map(g => stable(g)));
  const a = keyed(was),
    b = keyed(next);
  return {
    provider: 'snapchat',
    scope: 'targeting_spec',
    adsquad: s.adsquad ?? {id: squad(p)},
    spec_id: spec(p).id,
    criteria: {before: before.criteria ?? null, after: criteria(next), limit: maxCriteria},
    countries: {
      included_before: countries(was, 'INCLUDE'),
      included_after: countries(next, 'INCLUDE'),
      excluded_after: countries(next, 'EXCLUDE'),
    },
    entries: {
      added: [...b].filter(x => !a.has(x)).length,
      removed: [...a].filter(x => !b.has(x)).length,
      kept: [...b].filter(x => a.has(x)).length,
    },
    effect:
      'Replaces every location of the ad squad’s targeting spec with these; the ad squad then serves only where they allow.' +
      (s.adsquad && (s.adsquad as JsonObject).status === 'ACTIVE'
        ? ' The ad squad is active, so delivery changes at once.'
        : ''),
    verification: 'Reads the targeting spec again and compares its locations in any order and case.',
    source,
  };
}
const updated = (d: unknown, id: unknown) =>
  object(d) &&
  String(d.request_status).toUpperCase() === 'SUCCESS' &&
  Array.isArray(d.targeting_specs) &&
  d.targeting_specs.length === 1 &&
  object(d.targeting_specs[0]) &&
  String((d.targeting_specs[0] as JsonObject).sub_request_status).toUpperCase() === 'SUCCESS' &&
  object((d.targeting_specs[0] as JsonObject).targeting_spec) &&
  ((d.targeting_specs[0] as JsonObject).targeting_spec as JsonObject).id === id;
export function snapchatSpecOutcome(p: CompiledRequest, r: TransportResult): boolean {
  return r.status === 200 && updated(r.data, spec(p).id);
}
export function snapchatSpecVerification(p: CompiledRequest) {
  return [
    {
      read: {...read(p, '/v1/adsquads/' + squad(p) + '/targeting_specs'), snapchatSpecCheck: squad(p)} as Read,
      expected: {spec: {id: spec(p).id, type: 'GEO', geos: normalGeos(spec(p).geos)}},
      id: 'targeting spec ' + String(spec(p).id),
    },
  ];
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const snapchatSpecFamily: ReviewedFamily = defineFamily({
  name: 'snapchat_targeting_specs',
  files: ['src/snapchat-targeting-specs.ts', ['tests/snapchat-targeting-specs.test.mjs']],
  kind: snapchatSpecKind,
  assert: plan => assertSnapchatSpec(plan),
  authorize: authorizeSnapchatSpec,
  snapshots: snapchatSpecSnapshots,
  isRead: isSnapchatSpecRead,
  reader: (r, next) => readSnapchatSpec(r, next),
  validateState: (r, result, gateway) =>
    (r as Read).snapchatSpecState
      ? validateSnapchatSpecState(r, result)
      : (r as Read).snapchatSpecCheck
        ? validateSnapchatSpecCheck(result)
        : gateway(),
  snapshotState: (r, data, gateway) => ((r as Read).snapchatSpecState ? data : gateway()),
  prerequisites: snapchatSpecPrerequisites,
  impact: snapchatSpecImpact,
  outcome: snapchatSpecOutcome,
  verification: snapchatSpecVerification,
  observed: (r, data, gateway) => ((r as Read).snapchatSpecCheck ? {spec: data.spec ?? null} : gateway()),
  spendConfirmation: {
    needed: () => true,
    message:
      'A new targeting spec changes where the ad squad serves, and so its delivery and spending. Review the locations and provide spend_change_confirmed=true.',
  },
  exemptFromSpendTextMatch: true,
  exemptFromActivationScan: true,
  activates: () => false,
  destructive: () => false,
});
