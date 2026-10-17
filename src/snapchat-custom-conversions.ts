import type {ReviewedFamily} from './reviewed-family.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {fail} from './family-kit.js';

/**
 * Snapchat custom conversions of a pixel, Marketing API v1 ("Custom Conversions"; checked 2026-09-27). POST
 * /v1/pixels/{pixel_id}/custom_conversions creates them from {custom_conversions: [{name, description, event_type,
 * rules: [{key, values, operator}]}]}; each item of the reply carries its sub_request_status and the created conversion;
 * GET on the same path lists the pixel's conversions and DELETE /v1/custom_conversions/{id} deletes one. Rule keys and
 * operators come from the reference's enumerations. Conversions of mobile apps stay outside this contract.
 */
type Kind = 'create' | 'delete';
type Read = CompiledRequest & {snapConversionState?: {pixel?: string; conversion?: string; optional?: true}};
const gateway = 'snapchat_native_action',
  origin = 'https://adsapi.snapchat.com',
  maxItems = 10,
  maxListed = 1000;
const keys = [
  'event_tag',
  'item_id',
  'item_category',
  'currency',
  'search_string',
  'sign_up_method',
  'page_url',
  'category',
  'category_id',
  'brand',
  'delivery_method',
  'customer_status',
  'price',
  'number_items',
];
const operators = [
  'EQUAL_TO',
  'NOT_EQUAL_TO',
  'I_CONTAINS',
  'I_NOT_CONTAINS',
  'CONTAINS',
  'NOT_CONTAINS',
  'STARTS_WITH',
  'I_STARTS_WITH',
  'I_EQUAL_TO',
  'I_NOT_EQUAL_TO',
  'LESS_THAN',
  'LESS_THAN_OR_EQUALS',
  'GREATER_THAN',
  'GREATER_THAN_OR_EQUALS',
];
const numericKeys = ['price', 'number_items'],
  comparisons = ['LESS_THAN', 'LESS_THAN_OR_EQUALS', 'GREATER_THAN', 'GREATER_THAN_OR_EQUALS'];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const snapId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(v);
function invalid(message: string): never {
  return fail('INVALID_SNAPCHAT_CUSTOM_CONVERSION', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function snapConversionKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.specialTransport || (p.origin && p.origin !== origin)) return;
  if (p.method === 'POST' && /^\/v1\/pixels\/[A-Za-z0-9-]{1,64}\/custom_conversions$/.test(p.path)) return 'create';
  if (p.method === 'DELETE' && /^\/v1\/custom_conversions\/[A-Za-z0-9-]{1,64}$/.test(p.path)) return 'delete';
  return;
}
const pixelOf = (p: CompiledRequest) => p.path.split('/')[3]!,
  conversionOf = (p: CompiledRequest) => p.path.split('/')[3]!;
const rows = (p: CompiledRequest) =>
  (object(p.body) && Array.isArray(p.body.custom_conversions) ? p.body.custom_conversions : []) as JsonObject[];
export function assertSnapConversion(p: CompiledRequest): void {
  const kind = snapConversionKind(p);
  if (!kind) return;
  if (!snapId(p.accountId))
    fail('ACCOUNT_REQUIRED', 'Select the ad account whose pixel holds the conversions.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Custom conversion writes take no query or header overrides.');
  if (kind === 'delete') {
    if (p.body !== undefined && !(object(p.body) && !Object.keys(p.body).length)) invalid('Deletion takes no body.');
    return;
  }
  const b = p.body;
  if (
    !object(b) ||
    Object.keys(b).some(k => k !== 'custom_conversions') ||
    !Array.isArray(b.custom_conversions) ||
    !b.custom_conversions.length ||
    b.custom_conversions.length > maxItems
  )
    invalid('Send {custom_conversions: [...]} with 1–' + maxItems + ' conversions.');
  const names = new Set<string>();
  (b.custom_conversions as unknown[]).forEach((c, i) => {
    const at = 'custom_conversions[' + i + ']';
    if (!object(c) || Object.keys(c).some(k => !['name', 'description', 'event_type', 'rules'].includes(k)))
      invalid(at + ' takes name, description, event_type and rules.');
    if (
      typeof c.name !== 'string' ||
      !c.name.trim() ||
      c.name !== c.name.trim() ||
      [...c.name].length > 375 ||
      /[\u0000-\u001f]/.test(c.name)
    )
      invalid(at + '.name has 1–375 characters without surrounding spaces or control characters.');
    if (names.has(c.name.toLowerCase())) invalid('Each conversion name appears once per request.');
    names.add(c.name.toLowerCase());
    if (
      c.description !== undefined &&
      (typeof c.description !== 'string' ||
        [...c.description].length > 1000 ||
        /[\u0000-\u0008\u000b-\u001f]/.test(c.description))
    )
      invalid(at + '.description has at most 1000 characters.');
    if (typeof c.event_type !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(c.event_type))
      invalid(at + '.event_type is a Snap pixel event type such as PURCHASE.');
    if (!Array.isArray(c.rules) || !c.rules.length || c.rules.length > 20) invalid(at + '.rules lists 1–20 rules.');
    (c.rules as unknown[]).forEach((r, j) => {
      const rt = at + '.rules[' + j + ']';
      if (!object(r) || Object.keys(r).some(k => !['key', 'values', 'operator'].includes(k)))
        invalid(rt + ' takes key, values and operator.');
      if (!keys.includes(r.key)) invalid(rt + '.key is one of ' + keys.join(', ') + '.');
      if (!operators.includes(r.operator)) invalid(rt + '.operator is one of ' + operators.join(', ') + '.');
      if (comparisons.includes(r.operator) !== numericKeys.includes(r.key))
        invalid(rt + ': comparison operators apply to price and number_items, and those keys take comparisons only.');
      if (
        !Array.isArray(r.values) ||
        !r.values.length ||
        r.values.length > 50 ||
        r.values.some((x: unknown) => typeof x !== 'string' || !x.trim() || [...x].length > 512)
      )
        invalid(rt + '.values lists 1–50 non-empty strings of up to 512 characters.');
      if (numericKeys.includes(r.key) && (r.values.length !== 1 || !/^\d+(\.\d{1,6})?$/.test(r.values[0])))
        invalid(rt + '.values holds one number for ' + r.key + '.');
    });
  });
}
export function assertSnapConversionScope(_c: Connection): void {}
const read = (p: CompiledRequest, path: string, state: Read['snapConversionState']): Read => ({
  ...p,
  action: 'AMCP_SNAPCHAT_CONVERSION_READ',
  method: 'GET',
  path,
  query: {limit: maxListed},
  body: undefined,
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  responseControls: undefined,
  specialTransport: undefined,
  snapConversionState: state,
});
const pixelsRead = (p: CompiledRequest, state: Read['snapConversionState']) =>
  read(p, '/v1/adaccounts/' + p.accountId + '/pixels', state);
export function snapConversionSnapshots(p: CompiledRequest): Read[] {
  return [pixelsRead(p, snapConversionKind(p) === 'create' ? {pixel: pixelOf(p)} : {conversion: conversionOf(p)})];
}
export function isSnapConversionRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).snapConversionState;
}
/** Writes after validation; the review reads the account's pixels and their conversions through account and pixel paths. */
export function authorizeSnapConversion(p: CompiledRequest, c: Connection, account: string): boolean {
  if (p.gateway !== gateway) return false;
  if (snapConversionKind(p)) {
    assertSnapConversion(p);
    if (p.accountId !== account)
      fail('ACCOUNT_SCOPE_MISMATCH', 'Select the ad account whose pixel holds the conversions.', {}, 403);
    return true;
  }
  if (p.action !== 'AMCP_SNAPCHAT_CONVERSION_READ' || p.method !== 'GET' || !p.readOnly || p.body !== undefined)
    return false;
  if (
    p.path === '/v1/adaccounts/' + account + '/pixels' ||
    (/^\/v1\/pixels\/[A-Za-z0-9-]{1,64}\/custom_conversions$/.test(p.path) &&
      (p as Read & {snapConversionPixel?: string}).snapConversionPixel === p.path.split('/')[3])
  )
    return true;
  return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal custom conversion read.', {}, 403);
}
function list(r: TransportResult, key: string, item: string, label: string): JsonObject[] {
  const d = r.data;
  if (r.status !== 200 || !object(d) || String(d.request_status).toUpperCase() !== 'SUCCESS' || !Array.isArray(d[key]))
    unverified('Snapchat did not list the ' + label + '.');
  if ((object(d.paging) && d.paging.next_link) || (d[key] as unknown[]).length >= maxListed)
    unverified('The account has more ' + label + ' than one review reads (' + maxListed + ').');
  return (d[key] as unknown[]).map(x => {
    const v = object(x) && object(x[item]) ? x[item] : undefined;
    if (!v || !snapId(v.id)) unverified('A row of the ' + label + ' is malformed.');
    return v!;
  });
}
const view = (c: JsonObject) => ({
  present: true,
  id: String(c.id),
  name: c.name ?? null,
  description: c.description ?? null,
  event_type: c.event_type ?? null,
  rules: Array.isArray(c.rules)
    ? (c.rules as JsonObject[]).map(r => ({
        key: r.key ?? null,
        operator: r.operator ?? null,
        values: Array.isArray(r.values) ? [...r.values].map(String) : [],
      }))
    : [],
});
export async function readSnapConversions(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).snapConversionState;
  if (!s) return fetch(p);
  const pixels = list(
    await fetch({...(p as Read), snapConversionState: undefined} as Read),
    'pixels',
    'pixel',
    'pixels',
  );
  const conversions: JsonObject = {},
    owner: JsonObject = {};
  for (const px of pixels.filter(x => !s.pixel || x.id === s.pixel)) {
    // Bound here to a pixel of the account just listed; external arguments cannot set this marker.
    const q = {
      ...read(p, '/v1/pixels/' + px.id + '/custom_conversions', undefined),
      snapConversionPixel: String(px.id),
    } as Read;
    for (const c of list(await fetch(q), 'custom_conversions', 'custom_conversion', 'custom conversions')) {
      if (Object.hasOwn(conversions, 'c' + c.id)) unverified('A custom conversion is listed twice.');
      conversions['c' + c.id] = view(c);
      owner['c' + c.id] = String(px.id);
    }
  }
  const out: JsonObject = {ad_account_id: p.accountId!, pixels: pixels.map(x => String(x.id)).sort(), conversions};
  if (s.conversion)
    out.conversion = object(conversions['c' + s.conversion])
      ? {...(conversions['c' + s.conversion] as JsonObject), pixel: owner['c' + s.conversion]}
      : {present: false, id: s.conversion};
  return {status: 200, headers: {}, data: out};
}
export function validateSnapConversionState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).snapConversionState,
    d = r.data;
  if (
    !s ||
    r.status !== 200 ||
    !object(d) ||
    !Array.isArray(d.pixels) ||
    !object(d.conversions) ||
    !!s.conversion !== object(d.conversion)
  )
    unverified('Missing verified custom conversion state.');
}
export function snapConversionPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = snapConversionKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !Array.isArray(s.pixels) || !object(s.conversions))
    unverified('Missing verified custom conversion state.');
  if (kind === 'delete') {
    const c = s.conversion;
    if (!object(c) || c.present !== true)
      fail(
        'STATE_NOT_FOUND',
        'Custom conversion ' + conversionOf(p) + ' is not a conversion of a pixel of this ad account.',
        {custom_conversion_id: conversionOf(p)},
      );
    return;
  }
  if (!(s.pixels as string[]).includes(pixelOf(p)))
    fail('STATE_NOT_FOUND', 'Pixel ' + pixelOf(p) + ' is not a pixel of the selected ad account.', {
      pixel_id: pixelOf(p),
    });
  const taken = new Set(Object.values(s.conversions).map(v => (object(v) ? String(v.name).toLowerCase() : '')));
  for (const c of rows(p))
    if (taken.has(String(c.name).toLowerCase()))
      fail('CONFIGURATION_EXISTS', 'The pixel already has a custom conversion named "' + String(c.name) + '".', {
        name: String(c.name),
      });
}
export function snapConversionImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = snapConversionKind(p);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {};
  return {
    provider: 'snapchat',
    scope: 'custom_conversion',
    operation: kind,
    ...(kind === 'create'
      ? {pixel: pixelOf(p), creating: rows(p)}
      : {deleting: object(s.conversion) ? s.conversion : {id: conversionOf(p)}}),
    may_affect_serving: kind === 'delete',
    effect:
      kind === 'create'
        ? 'Creates conversions that count matching pixel events; ad squads optimize for them only once they name them.'
        : 'Deletes the conversion; ad squads or reports that use it lose it, which Snapchat does not describe further.',
    verification:
      kind === 'create'
        ? "Lists the pixel's conversions again and compares each one created."
        : 'Lists the conversions again and expects this one to be gone.',
    source: 'https://developers.snap.com/api/marketing-api/Ads-API/custom-conversions',
  };
}
export function snapConversionOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = snapConversionKind(p)!,
    d = r.data;
  if (r.status !== 200 || !object(d) || String(d.request_status).toUpperCase() !== 'SUCCESS') return false;
  if (kind === 'delete') return true;
  const out = d.custom_conversions;
  return (
    Array.isArray(out) &&
    out.length === rows(p).length &&
    out.every(
      (x: unknown) =>
        object(x) &&
        String(x.sub_request_status).toUpperCase() === 'SUCCESS' &&
        object(x.custom_conversion) &&
        snapId(x.custom_conversion.id),
    )
  );
}
export function snapConversionVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = snapConversionKind(p)!;
  if (kind === 'delete')
    return [
      {
        read: pixelsRead(p, {conversion: conversionOf(p), optional: true}),
        expected: {conversion: {present: false}},
        id: 'custom conversion ' + conversionOf(p),
      },
    ];
  const expected: JsonObject = {};
  rows(p).forEach((c, i) => {
    const id = result.data?.custom_conversions?.[i]?.custom_conversion?.id;
    if (!snapId(id)) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no custom conversion to verify.');
    expected['c' + id] = {
      present: true,
      id,
      name: c.name,
      event_type: c.event_type,
      rules: (c.rules as JsonObject[]).map(r => ({
        key: r.key,
        operator: r.operator,
        values: (r.values as string[]).map(String),
      })),
      ...(c.description !== undefined ? {description: c.description} : {}),
    };
  });
  return [
    {
      read: pixelsRead(p, {pixel: pixelOf(p), optional: true}),
      expected: {conversions: expected},
      id: Object.keys(expected)
        .map(k => k.slice(1))
        .join(','),
    },
  ];
}
export function snapConversionObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {
    conversions: object(data.conversions) ? data.conversions : {},
    ...(object(data.conversion) ? {conversion: data.conversion} : {}),
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const snapConversionFamily: ReviewedFamily = {
  name: 'snapchat_custom_conversions',
  files: ['src/snapchat-custom-conversions.ts', ['tests/snapchat-custom-conversions.test.mjs']],
  kind: snapConversionKind,
  assert: assertSnapConversion,
  authorize: authorizeSnapConversion,
  snapshots: snapConversionSnapshots,
  isRead: isSnapConversionRead,
  reader: readSnapConversions,
  validateState: validateSnapConversionState,
  prerequisites: snapConversionPrerequisites,
  impact: snapConversionImpact,
  outcome: snapConversionOutcome,
  verification: snapConversionVerification,
  observed: snapConversionObserved,
  exemptFromSpendTextMatch: true,
};
