import {assertNoMethodOverride, object} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * TikTok custom conversions for a pixel, per API for Business v1.3 "Create a Custom Conversion", "Get the details
 * of a Custom Conversion", "Get Custom Conversions associated with an event source" and "Get pixels" (checked
 * 2026-09-26). A custom conversion counts a pixel's standard event when it matches 1–10 rules; ad groups can
 * optimize for it once the pixel reports matching activity. At most 100 per pixel and 1,000 per ad account.
 * App (SAN) event sources, custom event mapping, updates and deletion are outside this contract.
 */
export const tiktokCustomConversionPath = '/v1.3/custom_conversion/create/';
export const tiktokPixelListPath = '/v1.3/pixel/list/';
export const tiktokConversionListPath = '/v1.3/custom_conversion/list/';
export const tiktokConversionGetPath = '/v1.3/custom_conversion/get/';
export const tiktokCustomConversionSource =
  'https://business-api.tiktok.com/portal/docs/create-a-custom-conversion/v1.3';
const pixelLimit = 100;
// "List of values for optimization_event", PIXEL rows: display name -> value.
const pixelEvents: Record<string, string> = {
  ADD_BILLING: 'Add Payment Info',
  ON_WEB_CART: 'Add to Cart',
  ON_WEB_ADD_TO_WISHLIST: 'Add to Wishlist',
  APPLICATION_APPROVAL: 'Application Approval',
  BUTTON: 'Click Button',
  ON_WEB_REGISTER: 'Complete Registration',
  CONSULT: 'Contact',
  CUSTOMIZE_PRODUCT: 'Customize Product',
  DOWNLOAD_START: 'Download',
  FIND_LOCATION: 'Find Location',
  INITIATE_ORDER: 'Initiate Checkout',
  PAGE_VIEW: 'Page View',
  ON_WEB_ORDER: 'Place an Order',
  SHOPPING: 'Purchase',
  SCHEDULE: 'Schedule',
  ON_WEB_SEARCH: 'Search',
  START_TRIAL: 'Start Trial',
  SUBMIT_APPLICATION: 'Submit Application',
  ON_WEB_SUBSCRIBE: 'Subscribe',
  ON_WEB_DETAIL: 'View Content',
};
const textParameters = [
  'BRAND',
  'CONTENT_CATEGORY',
  'CONTENT_ID',
  'CONTENT_NAME',
  'CONTENT_TYPE',
  'DESCRIPTION',
  'EVENT_ID',
  'SEARCH_STRING',
  'STATUS',
  'URL',
];
const numberParameters = ['NUM_ITEMS', 'PRICE', 'VALUE'];
const comparisons = ['LT', 'GT', 'LTE', 'GTE'];
const operators: Record<string, string[]> = {
  text: ['CONTAIN', 'NOT_CONTAIN', 'START_WITH', 'EQUAL', 'NOT_EQUAL'],
  number: ['EQUAL', 'NOT_EQUAL', ...comparisons],
  CURRENCY: ['EQUAL', 'NOT_EQUAL'],
};
const currencies = [
  'AED',
  'ALL',
  'AMD',
  'ARS',
  'AUD',
  'AZN',
  'BDT',
  'BGN',
  'BHD',
  'BIF',
  'BOB',
  'BRL',
  'BYN',
  'CAD',
  'CHF',
  'CLP',
  'CNY',
  'COP',
  'CRC',
  'CZK',
  'DKK',
  'DOP',
  'DZD',
  'EGP',
  'EUR',
  'GBP',
  'GEL',
  'GTQ',
  'HKD',
  'HNL',
  'HUF',
  'IDR',
  'ILS',
  'INR',
  'ISK',
  'JOD',
  'JPY',
  'KES',
  'KHR',
  'KRW',
  'KWD',
  'KZT',
  'MAD',
  'MOP',
  'MXN',
  'MYR',
  'NGN',
  'NIO',
  'NOK',
  'NZD',
  'OMR',
  'PAB',
  'PEN',
  'PHP',
  'PKR',
  'PLN',
  'PYG',
  'QAR',
  'RON',
  'RSD',
  'RUB',
  'SAR',
  'SEK',
  'SGD',
  'THB',
  'TND',
  'TRY',
  'TWD',
  'UAH',
  'USD',
  'UZS',
  'VES',
  'VND',
  'ZAR',
];
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const emoji = /\p{Extended_Pictographic}/u;
const squash = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');
const standardNames = new Set(Object.entries(pixelEvents).flatMap(([value, name]) => [squash(value), squash(name)]));
/** Why TikTok would refuse a custom conversion name, or undefined when it is acceptable. */
export function tiktokConversionNameProblem(name: unknown): string | undefined {
  if (typeof name !== 'string' || !/^\p{L}[\p{L}\p{N} _-]*$/u.test(name) || [...name].length > 50)
    return 'name must start with a letter, use only letters, numbers, spaces, underscores or hyphens, and have at most 50 characters.';
  if (standardNames.has(squash(name))) return 'name must not be the name of a standard event.';
  return;
}

export const tiktokCustomConversionKind = (p: CompiledRequest) =>
  p.gateway === 'tiktok_native_action' && p.method === 'POST' && p.path === tiktokCustomConversionPath;

function invalid(field: string, message: string): never {
  throw new MirrorError('INVALID_TIKTOK_CUSTOM_CONVERSION', message, {field});
}
const kindOf = (parameter: string) =>
  textParameters.includes(parameter) ? 'text' : numberParameters.includes(parameter) ? 'number' : 'CURRENCY';

/** Validates the request before review; nothing here reads or contacts TikTok. */
export function assertTiktokCustomConversion(plan: CompiledRequest, body: JsonObject): void {
  const extra = Object.keys(body).find(
    k =>
      ![
        'advertiser_id',
        'name',
        'description',
        'event_source_type',
        'event_source_id',
        'optimization_event',
        'rules',
      ].includes(k),
  );
  if (extra)
    invalid(
      extra,
      '"' +
        extra +
        '" is outside the qualified custom conversion contract' +
        (extra === 'custom_event_type'
          ? '; the details read does not return custom event mappings, so they cannot be verified.'
          : '.'),
    );
  if (body.advertiser_id !== undefined && String(body.advertiser_id) !== plan.accountId)
    invalid('advertiser_id', 'advertiser_id must equal the selected advertiser.');
  const name = body.name;
  if (typeof name !== 'string' || !/^\p{L}[\p{L}\p{N} _-]*$/u.test(name) || [...name].length > 50)
    invalid(
      'name',
      'name must start with a letter, use only letters, numbers, spaces, underscores or hyphens, and have at most 50 characters.',
    );
  if (standardNames.has(squash(name))) invalid('name', 'name must not be the name of a standard event.');
  if (
    body.description !== undefined &&
    (typeof body.description !== 'string' || [...body.description].length > 500 || emoji.test(body.description))
  )
    invalid('description', 'description must be text of at most 500 characters without emoji.');
  if (body.event_source_type !== 'PIXEL')
    invalid('event_source_type', 'Only PIXEL event sources are qualified; app (SAN) custom conversions are not.');
  if (typeof body.event_source_id !== 'string' || !/^[1-9][0-9]{0,31}$/.test(body.event_source_id))
    invalid('event_source_id', 'event_source_id must be the numeric pixel ID from /pixel/list/.');
  if (typeof body.optimization_event !== 'string' || !Object.hasOwn(pixelEvents, body.optimization_event))
    invalid(
      'optimization_event',
      'optimization_event must be one of the documented pixel events: ' + Object.keys(pixelEvents).join(', ') + '.',
    );
  const rules = body.rules;
  if (!Array.isArray(rules) || !rules.length || rules.length > 10)
    invalid('rules', 'rules must list 1 to 10 conditions.');
  const seen = new Set<string>();
  rules.forEach((r: unknown, i: number) => {
    const path = 'rules/' + i;
    if (!obj(r)) invalid(path, 'Each rule must be an object.');
    const bad = Object.keys(r).find(k => !['parameter', 'operator', 'values'].includes(k));
    if (bad) invalid(path + '/' + bad, '"' + bad + '" is outside the qualified rule contract.');
    if (typeof r.parameter !== 'string' || ![...textParameters, ...numberParameters, 'CURRENCY'].includes(r.parameter))
      invalid(path + '/parameter', 'parameter must be a documented rule parameter.');
    const kind = kindOf(r.parameter);
    if (!operators[kind]!.includes(r.operator))
      invalid(path + '/operator', r.parameter + ' allows only ' + operators[kind]!.join(', ') + '.');
    const values = r.values;
    if (!Array.isArray(values) || !values.length || values.length > 100 || values.some(v => typeof v !== 'string'))
      invalid(path + '/values', 'values must be 1 to 100 strings.');
    if (new Set(values).size !== values.length) invalid(path + '/values', 'Rule values must be unique.');
    if (comparisons.includes(r.operator) && values.length !== 1)
      invalid(path + '/values', r.operator + ' compares with exactly one value.');
    for (const v of values as string[]) {
      if (kind === 'text' && (!v.trim() || [...v].length > 100))
        invalid(path + '/values', 'Text values must be nonempty with at most 100 characters.');
      if (kind === 'CURRENCY' && !currencies.includes(v))
        invalid(path + '/values', 'Currency values must be documented currency codes.');
      if (kind === 'number') {
        const pattern =
          r.parameter === 'NUM_ITEMS' ? /^(?:0|[1-9][0-9]{0,9})$/ : /^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?$/;
        if (!pattern.test(v) || Number(v) > 1e9)
          invalid(
            path + '/values',
            r.parameter === 'NUM_ITEMS'
              ? 'NUM_ITEMS values are whole numbers from 0 to 1,000,000,000.'
              : r.parameter + ' values are amounts from 0.00 to 1,000,000,000.00 with at most two decimals.',
          );
      }
    }
    const key = JSON.stringify(ruleKey(r));
    if (seen.has(key)) invalid(path, 'Each rule may appear once.');
    seen.add(key);
  });
}

/** Rules compare as a set: rule order and value order carry no meaning, and numeric values compare as numbers. */
function ruleKey(r: JsonObject): JsonObject {
  const numeric = numberParameters.includes(r.parameter),
    values = (Array.isArray(r.values) ? r.values : []).map((v: unknown) =>
      numeric && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v,
    );
  return {
    parameter: r.parameter,
    operator: r.operator,
    values: [...values].sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)),
  };
}
export function tiktokConversionRules(rules: unknown): JsonObject[] {
  return (Array.isArray(rules) ? rules : [])
    .filter(obj)
    .map(ruleKey)
    .sort((a, b) => {
      const x = JSON.stringify(a),
        y = JSON.stringify(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
}
/** The configuration the details read returns for what was sent; activity and timestamps are observations. */
export function tiktokCustomConversionProjection(v: unknown): JsonObject {
  if (!obj(v)) return {};
  return {
    ...(v.custom_conversion_id !== undefined ? {custom_conversion_id: String(v.custom_conversion_id)} : {}),
    name: v.name,
    ...(v.description !== undefined ? {description: v.description} : {}),
    event_source_type: v.event_source_type,
    event_source_id: v.event_source_id === undefined ? undefined : String(v.event_source_id),
    optimization_event: v.optimization_event,
    rules: tiktokConversionRules(v.rules),
  };
}

/** Stable review state for the pixel read: identity and ownership, not event data TikTok refreshes every few hours. */
export function tiktokPixelState(data: JsonObject): JsonObject {
  return {
    pixels: (Array.isArray(data.data?.pixels) ? data.data.pixels : []).filter(obj).map((p: JsonObject) => ({
      pixel_id: p.pixel_id === undefined ? undefined : String(p.pixel_id),
      pixel_code: p.pixel_code,
      pixel_name: p.pixel_name,
      asset_ownership: obj(p.asset_ownership)
        ? {
            ownership_status: p.asset_ownership.ownership_status,
            asset_relation_status: p.asset_ownership.asset_relation_status ?? null,
          }
        : null,
    })),
  };
}
/** Stable review state for the pixel's custom conversions: definitions, not activity counts. */
export function tiktokConversionListState(data: JsonObject): JsonObject {
  return {
    list: (Array.isArray(data.data?.list) ? data.data.list : [])
      .filter(obj)
      .map(tiktokCustomConversionProjection)
      .sort((a: JsonObject, b: JsonObject) =>
        String(a.custom_conversion_id) < String(b.custom_conversion_id) ? -1 : 1,
      ),
  };
}

export function tiktokCustomConversionReads(
  plan: CompiledRequest,
): {path: string; query: JsonObject; action: string}[] {
  const b = plan.body as JsonObject,
    advertiser_id = plan.accountId;
  return [
    {path: tiktokPixelListPath, query: {advertiser_id, pixel_id: b.event_source_id}, action: 'tiktok_pixel_list_get'},
    {
      path: tiktokConversionListPath,
      query: {advertiser_id, event_source_type: 'PIXEL', event_source_id: b.event_source_id, page: 1, page_size: 1000},
      action: 'tiktok_custom_conversion_list_get',
    },
  ];
}
/** The native envelopes these reads return, checked before projection. */
export function validateTiktokConversionState(
  read: CompiledRequest,
  data: JsonObject,
  sameIds: (actual: unknown[], expected: unknown[]) => void,
): boolean {
  if (read.path === tiktokPixelListPath) {
    if (data.code !== 0 || !Array.isArray(data.data?.pixels))
      throw new MirrorError('STATE_READ_FAILED', 'TikTok pixel state must confirm success and list pixels.');
    sameIds(
      data.data.pixels.map((p: JsonObject) => p?.pixel_id),
      [read.query.pixel_id],
    );
    return true;
  }
  if (read.path === tiktokConversionListPath) {
    if (
      data.code !== 0 ||
      !Array.isArray(data.data?.list) ||
      data.data.list.some((r: unknown) => !obj(r) || String(r.event_source_id) !== String(read.query.event_source_id))
    )
      throw new MirrorError(
        'STATE_READ_FAILED',
        'TikTok custom conversion state must confirm success and list only the requested pixel.',
      );
    return true;
  }
  if (read.path === tiktokConversionGetPath) {
    if (data.code !== 0 || !obj(data.data))
      throw new MirrorError('STATE_READ_FAILED', 'TikTok custom conversion details must confirm success.');
    sameIds([data.data.custom_conversion_id], [read.query.custom_conversion_id]);
    return true;
  }
  return false;
}

const pixelsOf = (state: unknown[]) =>
  state.flatMap(s => (obj(s) && obj(s.data) && Array.isArray(s.data.pixels) ? s.data.pixels : [])) as JsonObject[];
const conversionsOf = (state: unknown[]) =>
  state.flatMap(s => (obj(s) && obj(s.data) && Array.isArray(s.data.list) ? s.data.list : [])) as JsonObject[];
/** Against the normalized review state: an owned pixel with room for another conversion and no conversion of the same name. */
export function tiktokCustomConversionImpact(plan: CompiledRequest, state: unknown[]): JsonObject {
  const b = plan.body as JsonObject,
    pixel = pixelsOf(state).find(p => String(p.pixel_id) === b.event_source_id),
    existing = conversionsOf(state);
  if (!pixel)
    throw new MirrorError('STATE_TARGET_MISMATCH', 'The pixel was not returned for the selected advertiser.', {
      pixel_id: b.event_source_id,
    });
  const ownership = obj(pixel.asset_ownership) ? pixel.asset_ownership : {};
  if (ownership.ownership_status !== true || ['SHARED', 'UNBOUND'].includes(ownership.asset_relation_status))
    invalid(
      'event_source_id',
      'Pixel ' +
        b.event_source_id +
        ' is not owned by this advertiser (' +
        (ownership.asset_relation_status ?? 'ownership not reported') +
        '); custom conversions are qualified only on owned pixels.',
    );
  if (existing.length >= pixelLimit)
    invalid(
      'event_source_id',
      'Pixel ' +
        b.event_source_id +
        ' already has ' +
        existing.length +
        ' custom conversions; TikTok allows ' +
        pixelLimit +
        ' per pixel.',
    );
  if (existing.some(c => c.name === b.name))
    invalid(
      'name',
      'A custom conversion named "' +
        b.name +
        '" already exists on this pixel; names must be unique within the ad account.',
    );
  return {
    provider: 'tiktok',
    scope: 'custom_conversions',
    may_affect_serving: false,
    effect:
      'Creates a custom conversion that counts ' +
      pixelEvents[b.optimization_event] +
      ' (' +
      b.optimization_event +
      ') events on the pixel when they match every rule. Campaigns and ad groups are unchanged; optimizing an ad group for it needs its own review.',
    pixel: {pixel_id: b.event_source_id, pixel_name: pixel.pixel_name ?? null, pixel_code: pixel.pixel_code ?? null},
    conversion: {
      name: b.name,
      optimization_event: b.optimization_event,
      rules: (b.rules as JsonObject[]).map(
        r => r.parameter + ' ' + r.operator + ' ' + (r.values as string[]).length + ' value(s)',
      ),
    },
    pixel_custom_conversions: {existing: existing.length, limit: pixelLimit},
    usable_when:
      'An ad group can use the custom conversion only after the pixel reports matching activity (activity status ACTIVE or NO_RECENT_ACTIVITY); a new one starts as WAITING_FOR_ACTIVITY.',
    source: tiktokCustomConversionSource,
  };
}

/** One details read confirms the created conversion's name, event, source and rules. */
export function tiktokCustomConversionVerification(
  plan: CompiledRequest,
  result: JsonObject,
): {path: string; query: JsonObject; expected: JsonObject; id: string}[] {
  const id = result.data?.data?.custom_conversion_id,
    b = plan.body as JsonObject;
  if (typeof id !== 'string' || !/^[1-9][0-9]{0,31}$/.test(id))
    throw new MirrorError('VERIFICATION_UNSUPPORTED', 'The creation receipt has no custom conversion ID.');
  return [
    {
      path: tiktokConversionGetPath,
      query: {
        advertiser_id: plan.accountId,
        custom_conversion_id: id,
        event_source_type: 'PIXEL',
        event_source_id: b.event_source_id,
      },
      expected: tiktokCustomConversionProjection({...b, custom_conversion_id: id}),
      id,
    },
  ];
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokCustomConversionFamily: ReviewedFamily = {
  name: 'tiktok_custom_conversions',
  files: ['src/tiktok-custom-conversions.ts', ['tests/tiktok-custom-conversions.test.mjs']],
  kind: tiktokCustomConversionKind,
  assert: (plan, gateway) => {
    assertNoMethodOverride(plan);
    gateway();
    assertTiktokCustomConversion(plan, object(plan.body));
  },
  snapshots: (plan, stateRead) =>
    tiktokCustomConversionReads(plan).map(r => {
      const read = stateRead(r.path, r.query);
      read.action = r.action;
      return read;
    }),
  impact: tiktokCustomConversionImpact,
  verification: (plan, result, before, verificationRead) =>
    tiktokCustomConversionVerification(plan, result).map(v => ({
      ...v,
      read: {...verificationRead(v.path, v.query), action: 'tiktok_custom_conversion_get'},
    })),
  exemptFromSpendTextMatch: true,
};
