import {stable} from './security.js';
import {changedStateFields} from './review-state-core.js';
import {snapchatReviewVolatile} from './snapchat-review-volatile.js';
import {normalGeos} from './snapchat-targeting-specs.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {fail, stateReadOf} from './family-kit.js';

/**
 * Targeting edits of Snapchat ad squads (PRV-06 A), per Snap's Marketing API v1 Audience Targeting and Ad Squads pages
 * (the Ad Squads page shows targeting in update payloads; JSON Patch modifies only the targeted fields). An ad squad with
 * 500 targeting criteria or fewer keeps its targeting inside the ad squad, and one JSON Patch operation of the ad squad
 * route replaces it: PATCH /v1/campaigns/{campaign_id}/adsquads/{ad_squad_id} with exactly
 * [{op: "replace", path: "/targeting", value: <the complete new targeting>}]. That route belongs to the
 * snapchat_nested_updates family (the action ledger names one family per route, from a body-independent sample), which
 * hands this one request shape to the contract below; every other ad squad edit stays a nested update, and a targeting
 * edit never rides along with a budget, status or date edit.
 *
 * The new targeting replaces every dimension: a dimension the request leaves out is removed, and the review says so.
 * Only the documented dimensions are qualified (regulated_content, geos, segments, interests, demographics, devices,
 * auto_expansion_options); an unknown key in the request or in the ad squad's current targeting is refused, so nothing
 * AMCP cannot show is kept or dropped silently. An ad squad whose targeting shows separated_types keeps its criteria in a
 * targeting spec (more than 500) and is changed with snapchat_targeting_specs instead.
 *
 * The review reads the ad account, the campaign (it must belong to the selected account), the ad squad (it must belong
 * to the campaign, and be active or paused) and, when the old or new targeting names segments, the account's segment
 * list: a segment the edit adds must be one of the account's own, and an included one must be targetable (READY). The
 * impact shows each dimension before and after, criterion by criterion. A targeting change changes who the ad squad
 * reaches, so execution always needs spend_change_confirmed; an edit that is not provably narrowing counts as widening
 * delivery, which an owner policy with allow_activation=false forbids while the ad squad is active. Verification reads the
 * ad squad again and compares its targeting in any order and case.
 */
type Send = (p: CompiledRequest) => Promise<TransportResult>;
type Read = CompiledRequest & {snapTargetingRead?: true};
type Route = {campaignId: string; squadId: string};
const gateway = 'snapchat_native_action',
  origin = 'https://adsapi.snapchat.com',
  route = /^\/v1\/campaigns\/([A-Za-z0-9-]{1,128})\/adsquads\/([A-Za-z0-9-]{1,128})$/,
  marker = 'AMCP_SNAPCHAT_TARGETING_READ',
  source = 'https://developers.snap.com/api/marketing-api/Ads-API/audience-targeting',
  specAction = 'snapchat_adsquads_ad_squad_id_targeting_specs_update',
  maxCriteria = 500,
  shown = 50,
  segmentPageSize = 1000,
  segmentPages = 5;
/** The documented targeting dimensions and, for each list dimension, the keys an entry may hold. */
export const snapTargetingDimensions: Readonly<Record<string, readonly string[]>> = Object.freeze({
  geos: ['country_code', 'operation', 'region_id', 'metro_id', 'postal_code'],
  segments: ['segment_id', 'operation'],
  interests: ['category_id', 'operation'],
  demographics: ['age_groups', 'gender', 'languages', 'min_age', 'max_age', 'advanced_demographics', 'operation'],
  devices: [
    'os_type',
    'os_version_min',
    'os_version_max',
    'connection_type',
    'carrier_id',
    'marketing_name',
    'operation',
  ],
});
export const snapTargetingKeys = [
  'regulated_content',
  ...Object.keys(snapTargetingDimensions),
  'auto_expansion_options',
];
const operated = ['geos', 'segments', 'interests'],
  geoLists = ['region_id', 'metro_id', 'postal_code'],
  expansions = ['interest_expansion_option', 'custom_audience_expansion_option'];
/** The value lists of each dimension and the pattern of their values. */
const lists: Record<string, Record<string, RegExp>> = {
  geos: {region_id: /^[A-Za-z0-9 -]{1,20}$/, metro_id: /^[A-Za-z0-9 -]{1,20}$/, postal_code: /^[A-Za-z0-9 -]{1,20}$/},
  segments: {segment_id: /^[A-Za-z0-9-]{1,64}$/},
  interests: {category_id: /^[A-Za-z0-9_-]{1,64}$/},
  demographics: {
    age_groups: /^(?:13-17|18-20|21-24|25-34|35\+)$/,
    languages: /^[A-Za-z]{2,3}$/,
    advanced_demographics: /^[A-Za-z0-9_-]{1,64}$/,
  },
  devices: {carrier_id: /^[A-Za-z0-9_-]{1,64}$/, marketing_name: /^[^\u0000-\u001f\u007f]{1,128}$/},
};
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const isId = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(v) && !Object.hasOwn(Object.prototype, v);
function invalid(message: string, details: JsonObject = {}): never {
  return fail('INVALID_SNAPCHAT_TARGETING', message, {source, ...details});
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}

/** The ad squad a targeting edit replaces the targeting of; undefined for every other request. */
export function snapTargetingKind(p: CompiledRequest): Route | undefined {
  if (p.gateway !== gateway || p.method !== 'PATCH' || p.specialTransport || (p.origin && p.origin !== origin)) return;
  const m = route.exec(p.path);
  if (!m || !isId(m[1]) || !isId(m[2]) || !Array.isArray(p.body) || p.body.length !== 1) return;
  const op = p.body[0];
  return object(op) && op.op === 'replace' && op.path === '/targeting' ? {campaignId: m[1], squadId: m[2]} : undefined;
}
/** The new targeting of a targeting edit, as the request sends it. */
const requested = (p: CompiledRequest): JsonObject => {
  const value = (p.body as JsonObject[])[0]!.value;
  return object(value) ? value : {};
};

function distinctList(value: unknown, field: string, pattern: RegExp): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > maxCriteria ||
    value.some(v => typeof v !== 'string' || !pattern.test(v)) ||
    new Set(value).size !== value.length
  )
    invalid('A targeting list holds 1 to 500 distinct documented values, each a string.', {field});
  return value as string[];
}
const age = (v: unknown) =>
  (typeof v === 'string' && /^\d{2}\+?$/.test(v)) ||
  (Number.isSafeInteger(v) && (v as number) >= 13 && (v as number) <= 99);
/** One entry of a list dimension; returns its number of criteria. */
function entry(dimension: string, v: unknown, i: number): number {
  const at = dimension + '[' + i + ']',
    allowed = snapTargetingDimensions[dimension]!;
  if (!object(v)) invalid('Each entry of a targeting dimension is an object.', {field: at});
  const extra = Object.keys(v).filter(k => !allowed.includes(k));
  if (extra.length)
    invalid('A targeting entry names a key its dimension does not document.', {
      field: at + '.' + extra[0],
      accepted: [...allowed],
    });
  if (Object.keys(v).every(k => k === 'operation')) invalid('A targeting entry names no criterion.', {field: at});
  if (operated.includes(dimension) && !['INCLUDE', 'EXCLUDE'].includes(v.operation as string))
    invalid('Every location, segment and interest entry states operation INCLUDE or EXCLUDE.', {
      field: at + '.operation',
    });
  if (v.operation !== undefined && !['INCLUDE', 'EXCLUDE'].includes(v.operation as string))
    invalid('operation is INCLUDE or EXCLUDE.', {field: at + '.operation'});
  let n = 0;
  for (const [key, pattern] of Object.entries(lists[dimension] ?? {}))
    if (v[key] !== undefined) n += distinctList(v[key], at + '.' + key, pattern).length;
  if (dimension === 'geos') {
    if (typeof v.country_code !== 'string' || !/^[A-Za-z]{2}$/.test(v.country_code))
      invalid('country_code is a two-letter country code.', {field: at + '.country_code'});
    if (geoLists.filter(k => v[k] !== undefined).length > 1)
      invalid('A location entry names one of region_id, metro_id or postal_code; put each in its own entry.', {
        field: at,
      });
    return n || 1;
  }
  if (dimension === 'segments' && v.segment_id === undefined)
    invalid('A segment entry needs segment_id, a list of segment IDs.', {field: at + '.segment_id'});
  if (dimension === 'interests' && v.category_id === undefined)
    invalid('An interest entry needs category_id, a list of interest category IDs.', {field: at + '.category_id'});
  if (dimension === 'demographics') {
    if (v.gender !== undefined && !['MALE', 'FEMALE'].includes(v.gender as string))
      invalid('gender is MALE or FEMALE.', {field: at + '.gender'});
    for (const k of ['min_age', 'max_age'])
      if (v[k] !== undefined && !age(v[k]))
        invalid('min_age and max_age are ages such as "18" or "35+".', {field: at + '.' + k});
    if (v.age_groups !== undefined && (v.min_age !== undefined || v.max_age !== undefined))
      invalid('A demographics entry names age_groups or a min_age and max_age range, not both.', {
        field: at + '.age_groups',
      });
    return n + (v.gender !== undefined ? 1 : 0) + (v.min_age !== undefined || v.max_age !== undefined ? 1 : 0);
  }
  if (dimension === 'devices') {
    if (v.os_type !== undefined && !['iOS', 'ANDROID', 'WEB'].includes(v.os_type as string))
      invalid('os_type is iOS, ANDROID or WEB.', {field: at + '.os_type'});
    if (v.connection_type !== undefined && !['WIFI', 'CELL'].includes(v.connection_type as string))
      invalid('connection_type is WIFI or CELL.', {field: at + '.connection_type'});
    for (const k of ['os_version_min', 'os_version_max'])
      if (v[k] !== undefined && (typeof v[k] !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){0,2}$/.test(v[k] as string)))
        invalid('os_version_min and os_version_max are versions such as "16.0".', {field: at + '.' + k});
    return n + (v.os_type !== undefined ? 1 : 0) + (v.connection_type !== undefined ? 1 : 0);
  }
  return n;
}
/** Validates a complete targeting object; returns its number of criteria. */
export function validateSnapTargeting(t: unknown): number {
  if (!object(t)) invalid('value is the complete new targeting object.', {field: 'value'});
  const extra = Object.keys(t).filter(k => !snapTargetingKeys.includes(k));
  if (extra.includes('separated_types'))
    invalid(
      'separated_types is read-only: an ad squad with more than 500 criteria changes its locations through its targeting spec.',
      {field: 'separated_types', next_action: specAction},
    );
  if (extra.length)
    invalid('Targeting takes only the documented dimensions.', {field: extra[0]!, accepted: snapTargetingKeys});
  if (t.regulated_content !== undefined && typeof t.regulated_content !== 'boolean')
    invalid('regulated_content is true or false.', {field: 'regulated_content'});
  if (t.auto_expansion_options !== undefined) {
    const o = t.auto_expansion_options;
    if (
      !object(o) ||
      Object.keys(o).some(k => !expansions.includes(k)) ||
      Object.values(o).some(x => !object(x) || Object.keys(x).join() !== 'enabled' || typeof x.enabled !== 'boolean')
    )
      invalid(
        'auto_expansion_options holds interest_expansion_option and custom_audience_expansion_option, each {enabled: true or false}.',
        {field: 'auto_expansion_options'},
      );
  }
  if (!Array.isArray(t.geos) || !t.geos.length) invalid('geos lists at least one location.', {field: 'geos'});
  let total = 0;
  for (const dimension of Object.keys(snapTargetingDimensions)) {
    const v = t[dimension];
    if (v === undefined) continue;
    if (!Array.isArray(v) || !v.length || v.length > maxCriteria)
      invalid('A targeting dimension lists 1 to 500 entries; leave it out to remove the dimension.', {
        field: dimension,
      });
    (v as unknown[]).forEach((x, i) => (total += entry(dimension, x, i)));
  }
  if (!(t.geos as JsonObject[]).some(g => g.operation === 'INCLUDE'))
    invalid('geos includes at least one location; exclusions alone target nowhere.', {field: 'geos'});
  // A criterion both included and excluded, or named twice, has no documented meaning.
  const atoms = criteria(t);
  for (const dimension of operated) {
    const values = (atoms[dimension] ?? []).map(a => a.slice(a.indexOf(' ') + 1));
    if (new Set(values).size !== values.length)
      invalid('A targeting dimension names the same criterion twice, or both includes and excludes it.', {
        field: dimension,
      });
  }
  for (const dimension of ['demographics', 'devices'])
    if (new Set(atoms[dimension] ?? []).size !== (atoms[dimension] ?? []).length)
      invalid('A targeting dimension names the same entry twice.', {field: dimension});
  if (total > maxCriteria)
    invalid(
      'An ad squad keeps at most 500 targeting criteria in its own targeting; larger GEO targeting belongs in a targeting spec.',
      {
        field: 'value',
        criteria: total,
        limit: maxCriteria,
        next_action: specAction,
      },
    );
  return total;
}
export function assertSnapTargeting(p: CompiledRequest): void {
  if (!snapTargetingKind(p)) return;
  if (!isId(p.accountId) || Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Select one account and the exact ad squad route, without query or header overrides.');
  const op = (p.body as JsonObject[])[0]!;
  if (Object.keys(op).sort().join() !== 'op,path,value')
    invalid('A targeting edit is exactly one replace /targeting operation whose value is the complete new targeting.');
  validateSnapTargeting(op.value);
}

/** Targeting in one order and case, so Snap's ordering or case never reads as a change. Unknown keys are dropped. */
export function normalSnapTargeting(t: unknown): JsonObject {
  const out: JsonObject = {};
  if (!object(t)) return out;
  if (typeof t.regulated_content === 'boolean') out.regulated_content = t.regulated_content;
  if (object(t.auto_expansion_options)) out.auto_expansion_options = JSON.parse(stable(t.auto_expansion_options));
  if (Array.isArray(t.geos)) out.geos = normalGeos(t.geos);
  for (const dimension of ['segments', 'interests', 'demographics', 'devices']) {
    if (!Array.isArray(t[dimension])) continue;
    out[dimension] = (t[dimension] as unknown[])
      .filter(object)
      .map(e => {
        const row: JsonObject = {};
        for (const key of snapTargetingDimensions[dimension]!) {
          const v = e[key];
          if (v === undefined) continue;
          row[key] = ['min_age', 'max_age'].includes(key)
            ? String(v)
            : Array.isArray(v)
              ? v.map(x => (key === 'languages' ? String(x).toLowerCase() : String(x))).sort()
              : v;
        }
        if (operated.includes(dimension)) row.operation ??= 'INCLUDE';
        return row;
      })
      .sort((a, b) => stable(a).localeCompare(stable(b)));
  }
  return out;
}
/** Each dimension as single criteria ("INCLUDE sa", "EXCLUDE segment_id s1"), for the diff and the narrowing test. */
function criteria(t: JsonObject): Record<string, string[]> {
  const n = normalSnapTargeting(t),
    out: Record<string, string[]> = {};
  for (const dimension of operated) {
    if (!Array.isArray(n[dimension])) continue;
    out[dimension] = (n[dimension] as JsonObject[]).flatMap(e => {
      const op = String(e.operation ?? 'INCLUDE'),
        key = Object.keys(lists[dimension]!).find(k => Array.isArray(e[k])),
        prefix = dimension === 'geos' ? op + ' ' + String(e.country_code) : op;
      return key ? (e[key] as string[]).map(v => prefix + ' ' + key + ' ' + v) : [prefix];
    });
  }
  for (const dimension of ['demographics', 'devices'])
    if (Array.isArray(n[dimension])) out[dimension] = (n[dimension] as JsonObject[]).map(e => stable(e));
  return out;
}
function count(t: JsonObject): number {
  try {
    return validateSnapTargeting(t);
  } catch {
    // The current targeting of an ad squad that holds unqualified values is still shown; its count is an estimate.
    return Object.values(criteria(t)).reduce((n, atoms) => n + atoms.length, 0);
  }
}

function read(p: CompiledRequest, path: string, query: JsonObject = {}): Read {
  return stateReadOf<Read>(p, marker, path, query, {snapTargetingRead: true});
}
/** One entity of a Snapchat single-object read, or a refusal when the answer is failed, partial or another page. */
function single(r: TransportResult, collection: string, singular: string, id: string): JsonObject {
  const d = r.data,
    row = object(d) && Array.isArray(d[collection]) && d[collection].length === 1 ? d[collection][0] : undefined,
    e = object(row) ? row[singular] : undefined;
  if (
    r.status !== 200 ||
    !object(d) ||
    String(d.request_status).toUpperCase() !== 'SUCCESS' ||
    (object(d.paging) && d.paging.next_link) ||
    String(row?.sub_request_status).toUpperCase() !== 'SUCCESS' ||
    !object(e) ||
    e.id !== id ||
    e.deleted === true
  )
    unverified('Snapchat did not return the ad account, campaign and ad squad of the targeting edit completely.');
  return e as JsonObject;
}
/** The account's own segments among `ids`, from its complete segment list (at most five pages). */
async function segmentsOf(p: CompiledRequest, ids: string[], get: (r: Read) => Promise<TransportResult>) {
  const rows = new Map<string, JsonObject>(),
    cursors = new Set<string>();
  let q = read(p, '/v1/adaccounts/' + p.accountId + '/segments', {limit: segmentPageSize});
  for (let page = 0; ; page++) {
    if (page >= segmentPages) unverified('The ad account has more segments than one targeting review reads (5,000).');
    const r = await get(q),
      d = r.data;
    if (
      r.status !== 200 ||
      !object(d) ||
      String(d.request_status).toUpperCase() !== 'SUCCESS' ||
      !Array.isArray(d.segments)
    )
      unverified('Snapchat did not list the segments of the ad account.');
    for (const wrapped of d.segments as unknown[]) {
      const s = object(wrapped) && object(wrapped.segment) ? wrapped.segment : undefined;
      if (!s || typeof s.id !== 'string' || rows.has(s.id))
        unverified('A segment row of the ad account is malformed or repeated.');
      rows.set(s!.id as string, s!);
    }
    const link = object(d.paging) ? d.paging.next_link : undefined;
    if (!link) break;
    let cursor: string | null = null;
    try {
      cursor = new URL(String(link)).searchParams.get('cursor');
    } catch {
      cursor = null;
    }
    if (!cursor || cursors.has(cursor)) unverified('Snapchat pagination of the segments is repeated or malformed.');
    cursors.add(cursor!);
    q = {...q, query: {...q.query, cursor: cursor!}};
  }
  return [...ids].sort().map(id => {
    const s = rows.get(id);
    return s
      ? {
          id,
          listed: true,
          owned: s.ad_account_id === p.accountId,
          name: typeof s.name === 'string' ? s.name : null,
          source_type: s.source_type ?? null,
          status: s.status ?? null,
          targetable_status: s.targetable_status ?? null,
        }
      : {id, listed: false, owned: false};
  });
}
/**
 * Keys of the current targeting this contract cannot show or keep: a dimension it does not document, a key an entry of
 * a documented dimension does not document, or a value of the wrong shape. A replacement would drop them silently.
 */
function unqualifiedKeys(t: JsonObject): string[] {
  const out = Object.keys(t).filter(key => key !== 'separated_types' && !snapTargetingKeys.includes(key));
  for (const [dimension, allowed] of Object.entries(snapTargetingDimensions)) {
    const v = t[dimension];
    if (v === undefined) continue;
    if (!Array.isArray(v)) out.push(dimension);
    else
      for (const e of v as unknown[])
        if (!object(e)) out.push(dimension);
        else for (const key of Object.keys(e)) if (!allowed.includes(key)) out.push(dimension + '.' + key);
  }
  if (t.regulated_content !== undefined && typeof t.regulated_content !== 'boolean') out.push('regulated_content');
  const o = t.auto_expansion_options;
  if (o !== undefined && (!object(o) || Object.keys(o).some(k => !expansions.includes(k))))
    out.push('auto_expansion_options');
  return [...new Set(out)].sort();
}
const segmentIds = (t: JsonObject, op?: string): string[] =>
  Array.isArray(t.segments)
    ? (t.segments as unknown[]).flatMap(e =>
        object(e) && Array.isArray(e.segment_id) && (!op || (e.operation ?? 'INCLUDE') === op)
          ? (e.segment_id as unknown[]).map(String)
          : [],
      )
    : [];

/**
 * The reviewed state of a targeting edit: the account, the campaign, the ad squad with its normalized targeting, and the
 * segments the old or new targeting names. With `check`, refuses what the edit cannot do (at prepare and execute).
 */
export async function readSnapTargetingState(p: CompiledRequest, send: Send, check = true): Promise<unknown[]> {
  assertSnapTargeting(p);
  const k = snapTargetingKind(p)!,
    deadline = performance.now() + 60000;
  let calls = 0,
    bytes = 0;
  const get = async (r: Read) => {
    if (++calls > 3 + segmentPages || performance.now() >= deadline)
      unverified('The targeting review exceeds its request or time bounds.');
    const result = await send(r);
    bytes += Buffer.byteLength(JSON.stringify(result.data ?? null));
    if (bytes > 8 * 1024 * 1024) unverified('The targeting review exceeds eight MiB.');
    return result;
  };
  const account = single(await get(read(p, '/v1/adaccounts/' + p.accountId)), 'adaccounts', 'adaccount', p.accountId!),
    campaign = single(await get(read(p, '/v1/campaigns/' + k.campaignId)), 'campaigns', 'campaign', k.campaignId);
  if (campaign.ad_account_id !== p.accountId)
    fail(
      'ACCOUNT_SCOPE_MISMATCH',
      'The campaign of this ad squad belongs to another ad account.',
      {
        campaign_id: k.campaignId,
      },
      403,
    );
  const squad = single(await get(read(p, '/v1/adsquads/' + k.squadId)), 'adsquads', 'adsquad', k.squadId);
  if (squad.campaign_id !== k.campaignId)
    fail(
      'STATE_TARGET_MISMATCH',
      'The ad squad is not in the campaign of the request.',
      {
        ad_squad_id: k.squadId,
        campaign_id: k.campaignId,
      },
      409,
    );
  if (squad.ad_account_id !== undefined && squad.ad_account_id !== p.accountId)
    fail('ACCOUNT_SCOPE_MISMATCH', 'The ad squad belongs to another ad account.', {ad_squad_id: k.squadId}, 403);
  if (!object(squad.targeting)) unverified('Snapchat did not return the targeting of the ad squad.');
  const current = squad.targeting as JsonObject,
    referenced = [...new Set([...segmentIds(current), ...segmentIds(requested(p))])];
  const state = {
    account: {id: account.id},
    campaign: {id: campaign.id, ad_account_id: campaign.ad_account_id, status: campaign.status ?? null},
    adsquad: {
      id: squad.id,
      campaign_id: squad.campaign_id,
      name: typeof squad.name === 'string' ? squad.name : null,
      status: squad.status ?? null,
      separated_types: Array.isArray(current.separated_types) ? current.separated_types.map(String).sort() : [],
      unqualified_keys: unqualifiedKeys(current),
      targeting: normalSnapTargeting(current),
    },
    segments: referenced.length ? await segmentsOf(p, referenced, get) : [],
  };
  if (check) checkSnapTargeting(p, state);
  return [state];
}
/** Refuses an edit the current state does not allow: a separated or unqualified targeting, a no-op, a foreign segment. */
export function checkSnapTargeting(p: CompiledRequest, state: JsonObject): void {
  const k = snapTargetingKind(p)!,
    squad = state.adsquad as JsonObject;
  if ((squad.separated_types as string[]).length)
    invalid(
      'This ad squad keeps its targeting in a targeting spec (more than 500 criteria); change its locations through the targeting spec.',
      {field: 'targeting', ad_squad_id: k.squadId, separated_types: squad.separated_types, next_action: specAction},
    );
  if ((squad.unqualified_keys as string[]).length)
    invalid(
      'The current targeting of this ad squad uses settings this review cannot show or keep; change it in Snapchat Ads Manager.',
      {field: 'targeting', ad_squad_id: k.squadId, unqualified_keys: squad.unqualified_keys},
    );
  if (!['ACTIVE', 'PAUSED'].includes(String(squad.status)))
    invalid('Only active and paused ad squads change targeting.', {
      ad_squad_id: k.squadId,
      status: squad.status ?? null,
    });
  if (stable(normalSnapTargeting(requested(p))) === stable(squad.targeting))
    invalid('The ad squad already has this targeting.', {field: 'value', ad_squad_id: k.squadId});
  const before = new Set(segmentIds(squad.targeting as JsonObject)),
    named = new Set(segmentIds(requested(p))),
    included = new Set(segmentIds(requested(p), 'INCLUDE'));
  for (const s of state.segments as JsonObject[]) {
    if (before.has(s.id as string) || !named.has(s.id as string)) continue;
    if (!s.listed || !s.owned)
      fail('SNAPCHAT_SEGMENT_UNAVAILABLE', 'A segment the edit adds is not a segment of the selected ad account.', {
        segment_id: s.id,
        reason: s.listed ? 'foreign' : 'not_listed',
      });
    if (included.has(s.id as string) && s.targetable_status !== 'READY')
      fail('SNAPCHAT_SEGMENT_UNAVAILABLE', 'A segment the edit includes is not ready to target (READY) yet.', {
        segment_id: s.id,
        reason: 'not_targetable',
        targetable_status: s.targetable_status ?? null,
      });
  }
}

/** True unless every change narrows the audience: fewer included or more excluded criteria, expansion turned off. */
export function snapTargetingWidens(before: JsonObject, after: JsonObject): boolean {
  const a = criteria(before),
    b = criteria(after),
    includes = (list: string[]) => list.filter(x => x.startsWith('INCLUDE')).length;
  for (const dimension of operated) {
    const old = a[dimension] ?? [],
      next = b[dimension] ?? [];
    if (next.some(x => !old.includes(x) && x.startsWith('INCLUDE'))) return true;
    if (old.some(x => !next.includes(x) && x.startsWith('EXCLUDE'))) return true;
    if (includes(old) && !includes(next)) return true;
  }
  for (const dimension of ['demographics', 'devices'])
    if (stable([...(a[dimension] ?? [])].sort()) !== stable([...(b[dimension] ?? [])].sort())) return true;
  if ((before.regulated_content ?? null) !== (after.regulated_content ?? null)) return true;
  const was = object(before.auto_expansion_options) ? before.auto_expansion_options : {},
    now = object(after.auto_expansion_options) ? after.auto_expansion_options : {},
    on = (o: JsonObject, key: string) => (object(o[key]) ? o[key].enabled : undefined);
  // Turning expansion on, or dropping a setting that kept it off, can only reach more people.
  return expansions.some(
    key => (on(now, key) === true && on(was, key) !== true) || (on(was, key) === false && on(now, key) === undefined),
  );
}
/** Under allow_activation=false: an active ad squad whose audience does not provably narrow starts serving more people. */
export function snapTargetingActivates(p: CompiledRequest, before: unknown): boolean {
  const state = Array.isArray(before) ? before[0] : undefined;
  if (!object(state) || !object(state.adsquad))
    fail('SNAPCHAT_UPDATE_STATE_UNVERIFIED', 'An exact baseline is required for activation policy.', {}, 502);
  const squad = state.adsquad as JsonObject;
  return (
    squad.status === 'ACTIVE' && snapTargetingWidens(squad.targeting as JsonObject, normalSnapTargeting(requested(p)))
  );
}
/** At most `shown` entries of a list, with its total when longer. */
const listed = (name: string, values: string[]): JsonObject =>
  values.length > shown ? {[name]: values.slice(0, shown), [name + '_total']: values.length} : {[name]: values};
function diff(before: JsonObject, after: JsonObject): {changes: JsonObject; unchanged: string[]} {
  const a = criteria(before),
    b = criteria(after),
    changes: JsonObject = {},
    unchanged: string[] = [];
  for (const dimension of Object.keys(snapTargetingDimensions)) {
    const old = a[dimension] ?? [],
      next = b[dimension] ?? [];
    if (stable([...old].sort()) === stable([...next].sort())) {
      if (old.length) unchanged.push(dimension);
      continue;
    }
    changes[dimension] = {
      ...listed(
        'added',
        next.filter(x => !old.includes(x)),
      ),
      ...listed(
        'removed',
        old.filter(x => !next.includes(x)),
      ),
      kept: next.filter(x => old.includes(x)).length,
      ...(old.length && !next.length ? {dimension_removed: true} : {}),
    };
  }
  for (const key of ['regulated_content', 'auto_expansion_options']) {
    if (stable(before[key] ?? null) === stable(after[key] ?? null)) {
      if (before[key] !== undefined) unchanged.push(key);
      continue;
    }
    changes[key] = {before: before[key] ?? null, after: after[key] ?? null};
  }
  return {changes, unchanged};
}
export function snapTargetingImpact(p: CompiledRequest, state: unknown[]): JsonObject {
  const s = object(state[0]) ? state[0] : {},
    squad: JsonObject = object(s.adsquad) ? s.adsquad : {id: snapTargetingKind(p)!.squadId},
    before = object(squad.targeting) ? squad.targeting : {},
    after = normalSnapTargeting(requested(p)),
    widens = snapTargetingWidens(before, after),
    {changes, unchanged} = diff(before, after),
    added = new Set(segmentIds(after).filter(id => !segmentIds(before).includes(id)));
  return {
    provider: 'snapchat',
    scope: 'adsquad_targeting',
    adsquad: {
      id: squad.id ?? null,
      name: squad.name ?? null,
      status: squad.status ?? null,
      campaign_id: squad.campaign_id ?? null,
    },
    criteria: {before: count(before), after: count(after), limit: maxCriteria},
    changes,
    unchanged,
    segments: (Array.isArray(s.segments) ? (s.segments as JsonObject[]) : []).map(x => ({
      id: x.id,
      name: x.name ?? null,
      owned: x.owned,
      targetable_status: x.targetable_status ?? null,
      added: added.has(x.id as string),
    })),
    widens_audience: widens,
    effect:
      'Replaces the whole targeting of the ad squad with this one; a dimension the request leaves out is removed.' +
      (widens
        ? ' The change is not provably narrowing, so it counts as widening delivery.'
        : ' Every change narrows the audience.') +
      (squad.status === 'ACTIVE' ? ' The ad squad is active, so delivery changes at once.' : ''),
    verification: 'Reads the ad squad again and compares its targeting in any order and case.',
    source,
  };
}
/** Read-back of the targeting AMCP sent, compared in any order and case; keys Snap adds on its own are reported. */
export async function verifySnapTargeting(p: CompiledRequest, before: unknown[], send: Send) {
  const [state] = (await readSnapTargetingState(p, send, false)) as JsonObject[],
    squad = state!.adsquad as JsonObject,
    previous = object(before[0]) && object(before[0].adsquad) ? (before[0].adsquad as JsonObject) : {},
    expected = normalSnapTargeting(requested(p)),
    // A dimension the edit removed must be gone; one Snap adds by itself is reported, not compared.
    keys = new Set([...Object.keys(expected), ...Object.keys(object(previous.targeting) ? previous.targeting : {})]),
    pick = (t: JsonObject) => Object.fromEntries(Object.entries(t).filter(([key]) => keys.has(key))),
    actual = squad.targeting as JsonObject,
    changed = changedStateFields(pick(expected), pick(actual), snapchatReviewVolatile).map(
      path => '$["targeting"]' + path.slice(1),
    ),
    added = [
      ...Object.keys(actual).filter(key => !keys.has(key)),
      ...((squad.unqualified_keys as string[]) ?? []),
    ].sort(),
    status = changed.length ? 'inconclusive' : 'verified';
  return {
    status,
    checks: [
      {
        status,
        verification_scope: 'the targeting of the reviewed ad squad, campaign and account, in any order and case',
        changed_fields: changed,
        ...(added.length ? {provider_added: added} : {}),
      },
    ],
  };
}
export const snapTargetingSpendMessage =
  'A targeting change changes who the ad squad reaches, and so its delivery and spending. Review each dimension before and after and provide spend_change_confirmed=true.';
