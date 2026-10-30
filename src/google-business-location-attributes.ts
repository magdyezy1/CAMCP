import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {defineFamily, fail, stateReadOf} from './family-kit.js';

/**
 * Business Profile location attributes, per the pinned Business Information API v1 Discovery document
 * (locations.updateAttributes, locations.getAttributes, attributes.list; Attributes, Attribute, AttributeMetadata,
 * RepeatedEnumAttributeValue, UriAttributeValue; checked 2026-09-28). PATCH /v1/locations/{id}/attributes?attributeMask=
 * updates the attributes the mask names; "If you'd like to delete certain attributes, they must be specified in the
 * attribute_mask with no matching entry in the attributes list". A value matches its type: BOOL and ENUM in values, URL in
 * uriValues, REPEATED_ENUM in repeatedEnumValue (setValues and unsetValues). attributes.list with parent returns the
 * attributes available to the location: value type, whether it is repeatable, deprecated ("updates will not be saved")
 * and the supported values. The review reads the location, its attributes and that metadata.
 */
type State = {kind: 'review'} | {kind: 'verify'; mask: string[]};
type Read = CompiledRequest & {businessAttributeState?: State; businessAttributePage?: true};
const gateway = 'google_business_native_action',
  origin = 'https://mybusinessbusinessinformation.googleapis.com',
  oauthScope = 'https://www.googleapis.com/auth/business.manage';
const action = 'gmb_location_ops/UPDATE_LOCATION_ATTRIBUTES',
  maxAttributes = 50,
  pageSize = 200,
  maxPages = 10;
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const attributeName = /^attributes\/[a-z0-9_]{1,100}$/;
function invalid(message: string): never {
  return fail('INVALID_BUSINESS_LOCATION_ATTRIBUTE', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function businessAttributeKind(p: CompiledRequest): boolean {
  return (
    p.gateway === gateway &&
    p.origin === origin &&
    p.method === 'PATCH' &&
    p.action === action &&
    !p.specialTransport &&
    /^\/v1\/locations\/[1-9][0-9]*\/attributes$/.test(p.path)
  );
}
const locationOf = (p: CompiledRequest) => p.path.slice(4, -'/attributes'.length);
const maskOf = (p: CompiledRequest) => String(p.query.attributeMask ?? '').split(',');
const listOf = (p: CompiledRequest): JsonObject[] =>
  obj(p.body) && Array.isArray(p.body.attributes) ? (p.body.attributes as JsonObject[]) : [];
const uri = (v: unknown) => {
  if (typeof v !== 'string' || v.length > 2048) return false;
  try {
    const u = new URL(v);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password;
  } catch {
    return false;
  }
};
export function assertBusinessAttribute(p: CompiledRequest): void {
  if (!businessAttributeKind(p)) return;
  if (p.accountId !== locationOf(p))
    fail(
      'ACCOUNT_SCOPE_MISMATCH',
      'Select this exact locations/{id} grant with location_id; an account grant does not name the location.',
      {},
      403,
    );
  if (Object.keys(p.headers ?? {}).length) invalid('Attribute edits take no header overrides.');
  if (Object.keys(p.query).some(k => k !== 'attributeMask') || typeof p.query.attributeMask !== 'string')
    invalid('An attribute edit takes only attributeMask in the query.');
  const mask = maskOf(p);
  if (
    !mask.length ||
    mask.length > maxAttributes ||
    mask.some(m => !attributeName.test(m)) ||
    new Set(mask).size !== mask.length
  )
    invalid('attributeMask lists 1–' + maxAttributes + ' distinct attributes/{attribute} names.');
  const b = p.body;
  if (
    !obj(b) ||
    Object.keys(b).some(k => !['name', 'attributes'].includes(k)) ||
    b.name !== locationOf(p) + '/attributes' ||
    !Array.isArray(b.attributes)
  )
    invalid('Send {name: "' + locationOf(p) + '/attributes", attributes: [...]}.');
  const names = new Set<string>();
  (b.attributes as unknown[]).forEach((a, i) => {
    const at = 'attributes[' + i + ']';
    if (!obj(a) || !attributeName.test(String(a.name))) invalid(at + ' names attributes/{attribute}.');
    if (names.has(String(a.name))) invalid(at + ' repeats ' + String(a.name) + '.');
    names.add(String(a.name));
    if (!mask.includes(String(a.name))) invalid(at + ' is not in attributeMask; Business Profile would ignore it.');
    const fields = ['values', 'uriValues', 'repeatedEnumValue'].filter(k => a[k] !== undefined);
    if (
      Object.keys(a).some(k => !['name', 'values', 'uriValues', 'repeatedEnumValue'].includes(k)) ||
      fields.length !== 1
    )
      invalid(at + ' carries exactly one of values, uriValues and repeatedEnumValue (valueType is read-only).');
    if (
      a.values !== undefined &&
      (!Array.isArray(a.values) || a.values.length !== 1 || !['boolean', 'string'].includes(typeof a.values[0]))
    )
      invalid(at + '.values holds one true/false or enum value.');
    if (
      a.uriValues !== undefined &&
      (!Array.isArray(a.uriValues) ||
        !a.uriValues.length ||
        a.uriValues.length > 10 ||
        a.uriValues.some(u => !obj(u) || Object.keys(u).join() !== 'uri' || !uri(u.uri)))
    )
      invalid(at + '.uriValues lists 1–10 {uri} http(s) URLs without credentials.');
    if (a.repeatedEnumValue !== undefined) {
      const r = a.repeatedEnumValue,
        ok =
          obj(r) &&
          Object.keys(r).every(k => ['setValues', 'unsetValues'].includes(k)) &&
          ['setValues', 'unsetValues'].every(
            k => r[k] === undefined || (Array.isArray(r[k]) && (r[k] as unknown[]).every(x => typeof x === 'string')),
          );
      const all = ok
        ? [...(((r as JsonObject).setValues as string[]) ?? []), ...(((r as JsonObject).unsetValues as string[]) ?? [])]
        : [];
      if (!ok || !all.length || new Set(all).size !== all.length)
        invalid(at + '.repeatedEnumValue sets and unsets distinct enum values.');
    }
  });
}
export function assertBusinessAttributeScope(c: Connection): void {
  if (!c.scopes.includes(oauthScope))
    fail('INSUFFICIENT_SCOPE', 'Reconnect Business Profile with business.manage.', {}, 403);
}
const read = (p: CompiledRequest, path: string, query: JsonObject, act: string, state?: State): Read =>
  stateReadOf<Read>(p, act, path, query, {businessAttributeState: state, businessAttributePage: true});
const stateRead = (p: CompiledRequest, state: State) =>
  read(p, p.path, {}, 'gmb_location_ops/GET_LOCATION_ATTRIBUTES', state);
/** The validated edit and the reads of the same location: the location, its attributes and the attributes available to it. */
export function authorizeBusinessAttribute(p: CompiledRequest, c: Connection, id: string): boolean {
  if (businessAttributeKind(p)) {
    assertBusinessAttribute(p);
    assertBusinessAttributeScope(c);
    if (p.accountId !== id) fail('ACCOUNT_SCOPE_MISMATCH', 'Select this exact location grant.', {}, 403);
    return true;
  }
  const r = p as Read;
  if (
    p.gateway !== gateway ||
    !r.businessAttributePage ||
    p.method !== 'GET' ||
    !p.readOnly ||
    p.origin !== origin ||
    !id.startsWith('locations/')
  )
    return false;
  assertBusinessAttributeScope(c);
  const q = Object.keys(p.query).sort().join();
  if (p.path === '/v1/' + id + '/attributes' && !q) return true;
  if (p.path === '/v1/' + id && q === 'readMask' && p.query.readMask === 'name,openInfo,metadata') return true;
  if (
    p.path === '/v1/attributes' &&
    p.query.parent === id &&
    String(p.query.pageSize) === String(pageSize) &&
    ['pageSize,parent', 'pageSize,pageToken,parent'].includes(q)
  )
    return true;
  return false;
}
export function businessAttributeSnapshots(p: CompiledRequest): Read[] {
  return [stateRead(p, {kind: 'review'})];
}
export function isBusinessAttributeRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).businessAttributeState;
}
/** An attribute's value in one comparable form; valueType is read from metadata, not trusted from the value. */
function valueOf(a: JsonObject): JsonObject {
  if (Array.isArray(a.uriValues)) return {uriValues: (a.uriValues as JsonObject[]).map(u => String(u.uri)).sort()};
  if (obj(a.repeatedEnumValue))
    return {
      setValues: [...((a.repeatedEnumValue.setValues as string[]) ?? [])].sort(),
      unsetValues: [...((a.repeatedEnumValue.unsetValues as string[]) ?? [])].sort(),
    };
  return {values: Array.isArray(a.values) ? a.values : []};
}
const key = (name: string) => 'a_' + name.slice('attributes/'.length);
export async function readBusinessAttributes(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).businessAttributeState;
  if (!s) return request(p);
  const location = locationOf(p);
  const ok = (r: TransportResult, label: string): JsonObject => {
    if (r.status !== 200 || !obj(r.data) || r.data.error)
      unverified('Business Profile did not return the ' + label + '.');
    return r.data as JsonObject;
  };
  const current = ok(await request({...(p as Read), businessAttributeState: undefined} as Read), 'location attributes');
  if (current.name !== undefined && current.name !== location + '/attributes')
    fail('STATE_TARGET_MISMATCH', 'Business Profile returned the attributes of another location.', {}, 409);
  const attributes: JsonObject = {};
  for (const a of (Array.isArray(current.attributes) ? current.attributes : []) as unknown[]) {
    if (!obj(a) || !attributeName.test(String(a.name))) unverified('An attribute of the location is malformed.');
    attributes[key(String(a.name))] = valueOf(a);
  }
  if (s.kind === 'verify') return {status: 200, headers: {}, data: {attributes}};
  const loc = ok(
    await request(read(p, '/v1/' + location, {readMask: 'name,openInfo,metadata'}, 'gmb_location_ops/GET_LOCATION')),
    'location',
  );
  if (loc.name !== location) fail('STATE_TARGET_MISMATCH', 'Business Profile returned another location.', {}, 409);
  const available: JsonObject = {};
  let token: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= maxPages) unverified('The location has more available attributes than one review reads.');
    const d = ok(
      await request(
        read(
          p,
          '/v1/attributes',
          {parent: location, pageSize, ...(token ? {pageToken: token} : {})},
          'gmb_catalog_ops/LIST_ATTRIBUTES',
        ),
      ),
      'available attributes',
    );
    for (const m of (Array.isArray(d.attributeMetadata) ? d.attributeMetadata : []) as unknown[]) {
      if (!obj(m) || !attributeName.test(String(m.parent))) unverified('Attribute metadata is malformed.');
      available[key(String(m.parent))] = {
        valueType: m.valueType ?? null,
        repeatable: m.repeatable === true,
        deprecated: m.deprecated === true,
        values: Array.isArray(m.valueMetadata)
          ? (m.valueMetadata as JsonObject[])
              .map(v => v.value)
              .filter(v => v !== undefined)
              .sort((a, b) => String(a).localeCompare(String(b)))
          : [],
      };
    }
    token = typeof d.nextPageToken === 'string' && d.nextPageToken ? d.nextPageToken : undefined;
    if (!token) break;
  }
  const meta = obj(loc.metadata) ? loc.metadata : {};
  return {
    status: 200,
    headers: {},
    data: {
      location: {
        name: location,
        open: obj(loc.openInfo) ? (loc.openInfo.status ?? null) : null,
        voiceOfMerchant: meta.hasVoiceOfMerchant === true,
      },
      attributes,
      available,
    },
  };
}
export function validateBusinessAttributeState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).businessAttributeState,
    d = r.data;
  if (
    !s ||
    r.status !== 200 ||
    !obj(d) ||
    !obj(d.attributes) ||
    (s.kind === 'review' && (!obj(d.location) || !obj(d.available)))
  )
    unverified('Missing verified location attribute state.');
}
export function businessAttributePrerequisites(p: CompiledRequest, states: unknown[]): void {
  if (!businessAttributeKind(p)) return;
  const s = states[0];
  if (!obj(s) || !obj(s.location) || !obj(s.attributes) || !obj(s.available))
    unverified('Missing verified location attribute state.');
  const l = s.location as JsonObject,
    available = s.available as JsonObject,
    current = s.attributes as JsonObject;
  if (l.voiceOfMerchant !== true)
    invalid('The listing has no Voice of Merchant, so Business Profile would not apply attribute edits.');
  if (l.open === 'CLOSED_PERMANENTLY')
    invalid('The location is closed permanently; its attributes no longer change here.');
  const sent = new Map(listOf(p).map(a => [String(a.name), a]));
  let changed = false;
  for (const name of maskOf(p)) {
    const m = available[key(name)];
    if (!obj(m)) invalid(name + ' is not available for this location.');
    if (m.deprecated) invalid(name + ' is deprecated: Business Profile would not save it.');
    const a = sent.get(name),
      type = String(m.valueType),
      allowed = m.values as unknown[];
    if (!a) {
      if (current[key(name)] !== undefined) changed = true;
      continue;
    }
    if (type === 'BOOL' && (a.values === undefined || typeof (a.values as unknown[])[0] !== 'boolean'))
      invalid(name + ' is a BOOL attribute: values [true] or [false].');
    if (type === 'ENUM' && (a.values === undefined || !allowed.includes((a.values as unknown[])[0])))
      invalid(name + ' is an ENUM attribute with values ' + allowed.join(', ') + '.');
    if (type === 'URL' && (a.uriValues === undefined || ((a.uriValues as unknown[]).length > 1 && !m.repeatable)))
      invalid(name + ' is a URL attribute: uriValues with ' + (m.repeatable ? 'one or more URLs' : 'one URL') + '.');
    if (type === 'REPEATED_ENUM') {
      const r = a.repeatedEnumValue as JsonObject | undefined;
      if (
        !r ||
        [...((r.setValues as unknown[]) ?? []), ...((r.unsetValues as unknown[]) ?? [])].some(v => !allowed.includes(v))
      )
        invalid(name + ' is a REPEATED_ENUM attribute with values ' + allowed.join(', ') + '.');
    }
    if (!['BOOL', 'ENUM', 'URL', 'REPEATED_ENUM'].includes(type)) invalid(name + ' has an unspecified value type.');
    if (JSON.stringify(current[key(name)]) !== JSON.stringify(valueOf(a))) changed = true;
  }
  if (!changed) invalid('The location already has these attribute values.');
}
export function businessAttributeImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  if (!businessAttributeKind(p)) return;
  const sent = new Set(listOf(p).map(a => String(a.name))),
    clearing = maskOf(p).filter(n => !sent.has(n));
  const first = state[0],
    s: JsonObject = obj(first) ? first : {};
  return {
    provider: 'google_business',
    scope: 'location_attributes',
    operation: 'update',
    location: locationOf(p),
    setting: [...sent],
    clearing,
    before: s.attributes ?? null,
    may_affect_serving: false,
    effect:
      'Changes the attributes the public listing shows' +
      (clearing.length ? ' and clears ' + clearing.join(', ') : '') +
      '; Google may review public edits before they appear.',
    verification: 'Reads the location attributes again and compares the masked attributes (cleared ones absent).',
    source:
      'https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations/updateAttributes',
  };
}
export function businessAttributeOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const d = r.data;
  return r.status === 200 && obj(d) && !d.error && (d.name === undefined || d.name === locationOf(p) + '/attributes');
}
export function businessAttributeVerification(
  p: CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const sent = new Map(listOf(p).map(a => [String(a.name), a])),
    expected: JsonObject = {};
  for (const name of maskOf(p)) {
    const a = sent.get(name);
    expected[key(name)] = a ? {present: true, ...valueOf(a)} : {present: false};
  }
  return [
    {
      read: stateRead(p, {kind: 'verify', mask: maskOf(p)}),
      expected: {attributes: expected},
      id: locationOf(p) + '/attributes',
    },
  ];
}
export function businessAttributeObserved(read: CompiledRequest, data: JsonObject): JsonObject {
  const attributes: JsonObject = {},
    current = obj(data.attributes) ? data.attributes : {};
  for (const [k, v] of Object.entries(current)) attributes[k] = obj(v) ? {present: true, ...v} : v;
  const s = (read as Read).businessAttributeState;
  for (const name of s && s.kind === 'verify' ? s.mask : [])
    if (!Object.hasOwn(attributes, key(name))) attributes[key(name)] = {present: false};
  return {attributes};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const businessAttributeFamily: ReviewedFamily = defineFamily({
  name: 'google_business_location_attributes',
  files: ['src/google-business-location-attributes.ts', ['tests/google-business-location-attributes.test.mjs']],
  kind: businessAttributeKind,
  assert: assertBusinessAttribute,
  authorize: authorizeBusinessAttribute,
  snapshots: businessAttributeSnapshots,
  isRead: isBusinessAttributeRead,
  reader: readBusinessAttributes,
  validateState: validateBusinessAttributeState,
  prerequisites: businessAttributePrerequisites,
  impact: businessAttributeImpact,
  outcome: businessAttributeOutcome,
  verification: businessAttributeVerification,
  observed: businessAttributeObserved,
  exemptFromSpendTextMatch: true,
});
