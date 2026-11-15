import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {defineFamily, fail, stateReadOf} from './family-kit.js';
import {tiktokAdvertiserInfoPath, tiktokAdvertiserQuery} from './tiktok-advertiser-state.js';

/**
 * TikTok audiences by rule, per API for Business v1.3 "Create an audience by rule", "Get audience details" and the
 * Enumerations appendix ("Filter Value", "Lookback window"), checked 2026-09-27. Three types are qualified: website
 * traffic (PIXEL, rules on the advertiser's pixels, optionally narrowed by URL keywords or event parameters), ad
 * engagement (ENGAGEMENT, on the advertiser's ad groups, or all of them) and lead generation (LEAD_GENERATION, no event
 * sources). Each rule has one EVENT EQ filter with a value of its type and a lookback window of 7–180 days; rules within
 * a set are joined with OR. "Newly created audiences require at most 48 hours to be analyzed and processed". App, shop,
 * business account, offline and organic or live engagement audiences stay outside.
 */
type Type = 'PIXEL' | 'ENGAGEMENT' | 'LEAD_GENERATION';
type State = {pixels: string[]; adgroups: string[]; audience?: string};
type Read = CompiledRequest & {tiktokRuleAudienceState?: State};
export const tiktokRuleAudiencePath = '/v1.3/dmp/custom_audience/rule/create/';
const gateway = 'tiktok_native_action',
  pixelPageSize = 20,
  maxPixelPages = 5,
  maxRules = 10,
  maxSources = 50,
  nameMax = 128;
const values: Record<Type, string[]> = {
  PIXEL: [
    'PAGE BROWSE',
    'CLICK BUTTON',
    'PIXEL SUBMIT FORM',
    'CONTACT',
    'DOWNLOAD',
    'PIXEL ADD PAYMENT INFO',
    'COMPLETE PAYMENT',
    'INITIATE CHECKOUT',
    'COMPLETE REGISTRATION',
    'PRODUCT DETAIL PAGE BROWSE',
    'PIXEL SEARCH',
    'PIXEL ADD TO CART',
    'PLACE AN ORDER',
    'PIXEL ADD TO WISHLIST',
    'PIXEL SUBSCRIBE',
  ],
  ENGAGEMENT: [
    'CLICK',
    'IMPRESSION',
    'PLAY 2S',
    'PLAY 6S',
    'PLAY 25',
    'PLAY 50',
    'PLAY 75',
    'PLAY OVER',
    'ENGAGEMENT APP PROFILE CLICK',
    'ENGAGEMENT APP PROFILE IMPRESSION',
    'ENGAGEMENT TIKTOK INSTANT CLICK',
    'ENGAGEMENT TIKTOK INSTANT IMPRESSION',
    'ENGAGEMENT COLLECTION ADS CLICK',
    'ENGAGEMENT COLLECTION ADS IMPRESSION',
  ],
  LEAD_GENERATION: ['LEAD GENERATION FORM SUBMISSION', 'FORM VIEW'],
};
// "Get audience details" names the types differently from the creation enum.
const labels: Record<Type, string> = {
  PIXEL: 'Website Audience',
  ENGAGEMENT: 'Engagement Audience',
  LEAD_GENERATION: 'Lead Generation',
};
const lookback = [7, 14, 30, 60, 90, 180],
  parameterFields = ['URL', 'CONTENT_TYPE', 'PRICE', 'VALUE', 'CONTENT_ID', 'CONTENT_CATEGORY'];
const textOperators = ['CONTAINS', 'DOES_NOT_CONTAIN', 'EQ', 'NOT_EQUAL'],
  comparisons = ['IS_LESS_THAN', 'IS_GREATER_THAN', 'IS_LESS_THAN_OR_EQUAL_TO', 'IS_GREATER_THAN_OR_EQUAL_TO'];
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
function invalid(message: string): never {
  return fail('INVALID_TIKTOK_RULE_AUDIENCE', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function tiktokRuleAudienceKind(p: CompiledRequest): boolean {
  return p.gateway === gateway && p.method === 'POST' && !p.specialTransport && p.path === tiktokRuleAudiencePath;
}
const body = (p: CompiledRequest): JsonObject => (obj(p.body) ? p.body : {});
const typeOf = (p: CompiledRequest) => body(p).audience_type as Type;
function only(v: JsonObject, keys: string[], at: string): void {
  const extra = Object.keys(v).filter(k => !keys.includes(k));
  if (extra.length) invalid(at + ' does not take ' + extra.join(', ') + '.');
}
function rulesOf(p: CompiledRequest): JsonObject[] {
  const spec = body(p).rule_spec as JsonObject;
  return [
    ...((spec.inclusion_rule_set as JsonObject).rules as JsonObject[]),
    ...(obj(spec.exclusion_rule_set) ? (spec.exclusion_rule_set.rules as JsonObject[]) : []),
  ];
}
function sourcesOf(p: CompiledRequest): State {
  const ids = [
    ...new Set(rulesOf(p).flatMap(r => (Array.isArray(r.event_source_ids) ? r.event_source_ids.map(String) : []))),
  ].sort();
  return typeOf(p) === 'PIXEL' ? {pixels: ids, adgroups: []} : {pixels: [], adgroups: ids};
}
function parameterFilter(f: unknown, at: string): string {
  if (!obj(f)) invalid(at + ' is an object.');
  only(f, ['field', 'operator', 'values'], at);
  if (!parameterFields.includes(f.field)) invalid(at + '.field is ' + parameterFields.join(', ') + '.');
  const allowed = f.field === 'URL' ? textOperators : [...textOperators, ...comparisons];
  if (!allowed.includes(f.operator)) invalid(at + '.operator is ' + allowed.join(', ') + ' for ' + f.field + '.');
  const v = f.values;
  if (
    !Array.isArray(v) ||
    !v.length ||
    v.length > 10 ||
    v.some(x => typeof x !== 'string' || !x.trim() || [...x].length > 100)
  )
    invalid(at + '.values lists 1–10 values of up to 100 characters.');
  if (comparisons.includes(f.operator) && v.some((x: string) => !/^-?\d+(?:\.\d+)?$/.test(x)))
    invalid(at + ' compares numbers, so each value is a number.');
  return f.field;
}
function ruleSet(set: unknown, type: Type, at: string): void {
  if (!obj(set)) invalid(at + ' is an object.');
  only(set, ['operator', 'rules'], at);
  if (set.operator !== 'OR') invalid(at + '.operator is OR.');
  if (!Array.isArray(set.rules) || !set.rules.length || set.rules.length > maxRules)
    invalid(at + '.rules lists 1–' + maxRules + ' rules.');
  set.rules.forEach((r: unknown, i: number) => {
    const here = at + '.rules[' + i + ']';
    if (!obj(r)) invalid(here + ' is an object.');
    only(r, ['event_source_ids', 'retention_days', 'filter_set'], here);
    const ids = r.event_source_ids;
    if (type === 'LEAD_GENERATION' && ids !== undefined)
      invalid(here + ': lead generation audiences take no event_source_ids.');
    if (type === 'PIXEL' && ids === undefined)
      invalid(here + '.event_source_ids names the pixels of a website audience.');
    if (
      ids !== undefined &&
      (!Array.isArray(ids) ||
        !ids.length ||
        ids.length > maxSources ||
        ids.some(x => !numeric(x)) ||
        new Set(ids).size !== ids.length)
    )
      invalid(
        here +
          '.event_source_ids lists 1–' +
          maxSources +
          ' different numeric ' +
          (type === 'PIXEL' ? 'pixel' : 'ad group') +
          ' IDs.',
      );
    if (!lookback.includes(r.retention_days))
      invalid(here + '.retention_days is a lookback window of ' + lookback.join(', ') + ' days.');
    const fs = r.filter_set;
    if (!obj(fs)) invalid(here + '.filter_set is an object.');
    only(fs, ['operator', 'filters'], here + '.filter_set');
    if (fs.operator !== 'OR') invalid(here + '.filter_set.operator is OR.');
    if (!Array.isArray(fs.filters) || fs.filters.length !== 1 || !obj(fs.filters[0]))
      invalid(here + '.filter_set.filters holds exactly one filter.');
    const f = fs.filters[0] as JsonObject,
      fat = here + '.filter_set.filters[0]';
    only(f, ['field', 'operator', 'value', 'parameter_filters'], fat);
    if (f.field !== 'EVENT' || f.operator !== 'EQ') invalid(fat + ' filters field EVENT with operator EQ.');
    if (!values[type].includes(f.value))
      invalid(fat + '.value is one of the ' + type + ' values: ' + values[type].join(', ') + '.');
    if (f.parameter_filters !== undefined) {
      if (type !== 'PIXEL') invalid(fat + '.parameter_filters narrow website audiences only.');
      if (!Array.isArray(f.parameter_filters) || !f.parameter_filters.length)
        invalid(fat + '.parameter_filters lists at least one filter.');
      const fields = f.parameter_filters.map((x: unknown, j: number) =>
        parameterFilter(x, fat + '.parameter_filters[' + j + ']'),
      );
      if (fields.filter((x: string) => x === 'URL').length > 1 || fields.filter((x: string) => x !== 'URL').length > 10)
        invalid(fat + '.parameter_filters holds at most one URL filter and ten parameter filters.');
    }
  });
}
export function assertTiktokRuleAudience(p: CompiledRequest): void {
  if (!tiktokRuleAudienceKind(p)) return;
  if (Object.keys(p.query).length) invalid('Audience creation takes no query parameters.');
  const b = p.body;
  if (!obj(b)) invalid('Send the request as a JSON object.');
  if (String(b.advertiser_id) !== p.accountId)
    fail('ACCOUNT_SCOPE_MISMATCH', 'advertiser_id must be the selected advertiser.', {}, 403);
  if (['identity_id', 'identity_type', 'identity_authorized_bc_id'].some(k => b[k] !== undefined))
    invalid('Organic and live engagement audiences (identity fields) are not available here.');
  only(
    b,
    [
      'advertiser_id',
      'custom_audience_name',
      'audience_type',
      'audience_sub_type',
      'retention_in_days',
      'is_auto_refresh',
      'rule_spec',
    ],
    'An audience by rule',
  );
  if (!Object.hasOwn(values, String(b.audience_type)))
    invalid(
      'audience_type is PIXEL, ENGAGEMENT or LEAD_GENERATION; app, shop, business account, offline and organic or live engagement audiences are not available here.',
    );
  const n = b.custom_audience_name;
  if (
    typeof n !== 'string' ||
    !n.trim() ||
    n !== n.trim() ||
    [...n].length > nameMax ||
    /[\u0000-\u001f\u007f]/.test(n)
  )
    invalid('custom_audience_name has 1–' + nameMax + ' characters, without leading or trailing spaces.');
  if (b.audience_sub_type !== undefined && !['NORMAL', 'REACH_FREQUENCY'].includes(b.audience_sub_type))
    invalid('audience_sub_type is NORMAL or REACH_FREQUENCY.');
  if (
    b.retention_in_days !== undefined &&
    (!Number.isInteger(b.retention_in_days) || b.retention_in_days < 1 || b.retention_in_days > 365)
  )
    invalid('retention_in_days is 1–365 days.');
  if (b.is_auto_refresh !== undefined && typeof b.is_auto_refresh !== 'boolean')
    invalid('is_auto_refresh is true or false.');
  const spec = b.rule_spec;
  if (!obj(spec)) invalid('rule_spec holds inclusion_rule_set and optionally exclusion_rule_set.');
  only(spec, ['inclusion_rule_set', 'exclusion_rule_set'], 'rule_spec');
  ruleSet(spec.inclusion_rule_set, b.audience_type as Type, 'rule_spec.inclusion_rule_set');
  if (spec.exclusion_rule_set !== undefined)
    ruleSet(spec.exclusion_rule_set, b.audience_type as Type, 'rule_spec.exclusion_rule_set');
}
const read = (p: CompiledRequest, action: string, path: string, query: JsonObject, state?: State): Read =>
  stateReadOf<Read>(p, action, path, {advertiser_id: p.accountId, ...query}, {tiktokRuleAudienceState: state});
/** Website audiences read the pixels and engagement audiences the named ad groups; without event sources the advertiser is read. */
export function tiktokRuleAudienceSnapshots(p: CompiledRequest): Read[] {
  const s = sourcesOf(p);
  if (s.pixels.length)
    return [read(p, 'tiktok_pixel_list_get', '/v1.3/pixel/list/', {page: 1, page_size: pixelPageSize}, s)];
  if (s.adgroups.length)
    return [
      read(
        p,
        'tiktok_adgroup_get',
        '/v1.3/adgroup/get/',
        {filtering: {adgroup_ids: s.adgroups}, page: 1, page_size: 100},
        s,
      ),
    ];
  // Its reader reduces the answer to the advertiser's presence; the read still asks for the identity fields only (T1).
  return [
    {
      ...read(p, 'tiktok_advertiser_info_get', tiktokAdvertiserInfoPath, {}, s),
      query: tiktokAdvertiserQuery(p.accountId!),
    },
  ];
}
export function isTiktokRuleAudienceRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).tiktokRuleAudienceState;
}
function ok(r: TransportResult, label: string): JsonObject {
  const d = r.data;
  if (r.status !== 200 || !obj(d) || d.code !== 0 || !obj(d.data))
    unverified('TikTok did not return the ' + label + '.');
  return (d as JsonObject).data;
}
async function pages(
  first: Read,
  key: string,
  label: string,
  max: number,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<JsonObject[]> {
  const out: JsonObject[] = [];
  let total = 1;
  for (let page = 1; page <= total; page++) {
    if (page > max) unverified('The advertiser has more ' + label + ' than one review reads.');
    const d = ok(
      await request({...first, tiktokRuleAudienceState: undefined, query: {...first.query, page}} as Read),
      label,
    );
    if (d[key] !== undefined && !Array.isArray(d[key])) unverified('TikTok did not list the ' + label + '.');
    const n = Number(obj(d.page_info) ? (d.page_info.total_page ?? 1) : 1);
    if (!Number.isInteger(n) || n < 0) unverified('TikTok returned an invalid page count.');
    if (page === 1) total = Math.max(n, 1);
    for (const row of (d[key] ?? []) as unknown[]) {
      if (!obj(row)) unverified('A row of the ' + label + ' is malformed.');
      out.push(row as JsonObject);
    }
  }
  return out;
}
/** The advertiser's pixels (names only; activity changes with traffic), the named ad groups, the advertiser, or a created audience. */
export async function readTiktokRuleAudiences(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).tiktokRuleAudienceState;
  if (!s) return request(p);
  if (s.audience) {
    const d = ok(await request({...(p as Read), tiktokRuleAudienceState: undefined} as Read), 'audience details');
    const row = (Array.isArray(d.list) ? d.list : [])
      .map((r: unknown) => (obj(r) && obj(r.audience_details) ? r.audience_details : undefined))
      .find((a: JsonObject | undefined) => a && String(a.audience_id) === s.audience);
    return {
      status: 200,
      headers: {},
      data: {
        audience: row
          ? {
              present: true,
              name: row.name ?? null,
              type: row.type ?? null,
              sub_type: row.audience_sub_type ?? null,
              creator: row.is_creator === true,
              auto_refresh: typeof row.is_auto_refresh === 'boolean' ? row.is_auto_refresh : null,
            }
          : {present: false},
      },
    };
  }
  if (!s.pixels.length && !s.adgroups.length) {
    const d = ok(await request({...(p as Read), tiktokRuleAudienceState: undefined} as Read), 'advertiser');
    if (!Array.isArray(d.list) || !d.list.some((a: unknown) => obj(a) && String(a.advertiser_id) === p.accountId))
      unverified('TikTok did not return the selected advertiser.');
    return {status: 200, headers: {}, data: {pixels: [], adgroups: [], advertiser: p.accountId!}};
  }
  if (s.pixels.length) {
    const pixels = (await pages(p as Read, 'pixels', 'pixels', maxPixelPages, request))
      .map(x => ({id: String(x.pixel_id), name: x.pixel_name ?? null}))
      .filter(x => numeric(x.id))
      .sort((a, b) => a.id.localeCompare(b.id));
    return {status: 200, headers: {}, data: {pixels: pixels.filter(x => s.pixels.includes(x.id)), adgroups: []}};
  }
  const groups = s.adgroups.length
    ? (await pages(p as Read, 'list', 'ad groups', 1, request))
        .map(g => ({id: String(g.adgroup_id), name: g.adgroup_name ?? null}))
        .filter(g => {
          if (!s.adgroups.includes(g.id)) unverified('TikTok listed an ad group that was not named.');
          return true;
        })
        .sort((a, b) => a.id.localeCompare(b.id))
    : [];
  return {status: 200, headers: {}, data: {pixels: [], adgroups: groups}};
}
export function validateTiktokRuleAudienceState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).tiktokRuleAudienceState,
    d = r.data;
  if (
    !s ||
    r.status !== 200 ||
    !obj(d) ||
    (s.audience ? !obj(d.audience) : !Array.isArray(d.pixels) || !Array.isArray(d.adgroups))
  )
    unverified('Missing verified audience source state.');
}
export function tiktokRuleAudiencePrerequisites(p: CompiledRequest, states: unknown[]): void {
  if (!tiktokRuleAudienceKind(p)) return;
  const s = states[0];
  if (!obj(s) || !Array.isArray(s.pixels) || !Array.isArray(s.adgroups))
    unverified('Missing verified audience source state.');
  const want = sourcesOf(p),
    have = (rows: unknown[]) => new Set(rows.map(r => (obj(r) ? String(r.id) : '')));
  const missingPixels = want.pixels.filter(id => !have(s.pixels as unknown[]).has(id)),
    missingGroups = want.adgroups.filter(id => !have(s.adgroups as unknown[]).has(id));
  if (missingPixels.length)
    fail('STATE_NOT_FOUND', 'Not a pixel of the selected advertiser: ' + missingPixels.join(', ') + '.', {
      ids: missingPixels,
    });
  if (missingGroups.length)
    fail('STATE_NOT_FOUND', 'Not an ad group of the selected advertiser: ' + missingGroups.join(', ') + '.', {
      ids: missingGroups,
    });
}
export function tiktokRuleAudienceImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  if (!tiktokRuleAudienceKind(p)) return;
  const first = state[0],
    s: JsonObject = obj(first) ? first : {},
    b = body(p),
    type = typeOf(p);
  return {
    provider: 'tiktok',
    scope: 'custom_audience',
    operation: 'create',
    audience_type: type,
    name: b.custom_audience_name,
    sources:
      type === 'PIXEL'
        ? (s.pixels ?? [])
        : type === 'ENGAGEMENT'
          ? sourcesOf(p).adgroups.length
            ? (s.adgroups ?? [])
            : 'all ad groups'
          : 'lead forms',
    expires:
      b.retention_in_days !== undefined
        ? b.retention_in_days + ' days after creation'
        : '365 days after it was last applied to an active ad group or changed',
    may_affect_serving: false,
    effect:
      'Creates a ' +
      labels[type].toLowerCase() +
      ' rule audience. TikTok takes up to 48 hours to process it, and it reaches no one until an ad group includes or excludes it.',
    verification:
      'Reads the new audience and compares its name, type, sub type and refresh setting; TikTok returns the rule in its own format, so the rule is not compared.',
    source: 'https://business-api.tiktok.com/portal/docs/create-an-audience-by-rule/v1.3',
  };
}
export function tiktokRuleAudienceOutcome(_p: CompiledRequest, r: TransportResult): boolean {
  return (
    r.status === 200 && obj(r.data) && r.data.code === 0 && obj(r.data.data) && numeric(r.data.data.custom_audience_id)
  );
}
export function tiktokRuleAudienceVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const id = result.data?.data?.custom_audience_id,
    b = body(p),
    type = typeOf(p);
  if (!numeric(id)) fail('VERIFICATION_UNSUPPORTED', 'The creation receipt has no audience ID.');
  const expected: JsonObject = {
    present: true,
    name: b.custom_audience_name,
    type: labels[type],
    sub_type: b.audience_sub_type ?? 'NORMAL',
    creator: true,
    ...(type !== 'LEAD_GENERATION' ? {auto_refresh: b.is_auto_refresh ?? true} : {}),
  };
  return [
    {
      read: read(
        p,
        'tiktok_dmp_custom_audience_get',
        '/v1.3/dmp/custom_audience/get/',
        {custom_audience_ids: [id]},
        {pixels: [], adgroups: [], audience: id},
      ),
      expected,
      id,
    },
  ];
}
/** The created audience as the fields verification compares. */
export function tiktokRuleAudienceObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return obj(data.audience) ? data.audience : {present: false};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokRuleAudienceFamily: ReviewedFamily = defineFamily({
  name: 'tiktok_rule_audiences',
  files: ['src/tiktok-rule-audiences.ts', ['tests/tiktok-rule-audiences.test.mjs']],
  kind: tiktokRuleAudienceKind,
  assert: assertTiktokRuleAudience,
  snapshots: tiktokRuleAudienceSnapshots,
  isRead: isTiktokRuleAudienceRead,
  reader: readTiktokRuleAudiences,
  validateState: validateTiktokRuleAudienceState,
  prerequisites: tiktokRuleAudiencePrerequisites,
  impact: tiktokRuleAudienceImpact,
  outcome: tiktokRuleAudienceOutcome,
  verification: tiktokRuleAudienceVerification,
  observed: tiktokRuleAudienceObserved,
  exemptFromSpendTextMatch: true,
});
