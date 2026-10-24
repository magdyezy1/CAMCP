import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {criteoPrefix, criteoRoute} from './criteo-version.js';
import {defineFamily, fail, readOf} from './family-kit.js';

/**
 * Audience segments of a Criteo Retail Media account, API 2026-07 (unchanged from 2026-01; pinned OpenAPI document:
 * bulkCreateAudienceSegments, bulkUpdateAudienceSegments, bulkDeleteAudienceSegments and searchAudienceSegments;
 * RmAudienceSegmentCreateEntityV1, RmAudienceSegmentUpdateEntityV1, RmEventsCreateV1, RmEventsUpdateV1 and
 * RmContactListCreateV1; SearchAccountRetailers; checked 2026-09-27). A segment belongs to one retailer and is either
 * an Events segment (shoppers who viewed, bought or added to cart products of categories or brands, within a lookback
 * window and price range) or a ContactList segment, which starts empty: adding contacts is a separate request that
 * carries customer data and is outside this contract.
 */
type Kind = 'create' | 'update' | 'delete';
type Read = CompiledRequest & {criteoSegmentState?: {segments: string[]; retailers: string[]}};
const gateway = 'criteo_native_action',
  origin = 'https://api.criteo.com',
  prefix = criteoPrefix,
  maxItems = 50,
  maxIds = 1000;
const activities = ['View', 'Buy', 'AddToCart'];
const lookbacks = [
  'Last7Days',
  'Last14Days',
  'Last30Days',
  'Last45Days',
  'Last60Days',
  'Last90Days',
  'Last120Days',
  'Last150Days',
  'Last180Days',
];
const identifiers = ['Email', 'UserIdentifier', 'IdentityLink', 'CustomerId', 'PhoneNumber'];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v);
function invalid(message: string): never {
  return fail('INVALID_CRITEO_AUDIENCE_SEGMENT', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function criteoSegmentKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.specialTransport || (p.origin && p.origin !== origin)) return;
  const m = criteoRoute('/accounts/[1-9][0-9]{0,18}/audience-segments(/create|/delete)?$').exec(p.path);
  if (!m) return;
  if (m[1] === '/create') return p.method === 'POST' ? 'create' : undefined;
  if (m[1] === '/delete') return p.method === 'POST' ? 'delete' : undefined;
  return p.method === 'PATCH' ? 'update' : undefined;
}
const accountOf = (p: CompiledRequest) => p.path.split('/')[4]!;
const items = (p: CompiledRequest) => (object(p.body) && Array.isArray(p.body.data) ? p.body.data : []) as JsonObject[];
function text(v: unknown, label: string, max: number, optional = false): void {
  if (optional && (v === undefined || v === null)) return;
  if (typeof v !== 'string' || !v.trim() || v !== v.trim() || [...v].length > max || /[\u0000-\u001f]/.test(v))
    invalid(label + ' has 1–' + max + ' characters without surrounding spaces or control characters.');
}
function ids(v: unknown, label: string): void {
  if (v === undefined) return;
  if (!Array.isArray(v) || v.length > maxIds || v.some(x => !id(x)) || new Set(v).size !== v.length)
    invalid(label + ' lists up to ' + maxIds + ' distinct numeric IDs as strings.');
}
function price(v: unknown, label: string, nillable: boolean): number | null | undefined {
  if (v === undefined) return undefined;
  const raw = nillable
    ? object(v) && Object.keys(v).every(k => k === 'value')
      ? v.value
      : invalid(label + ' is {value}, a price or null.')
    : v;
  if (raw === null && nillable) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1e9)
    invalid(label + ' is a price of 0 or more.');
  return raw as number;
}
function events(v: unknown, at: string, create: boolean): void {
  if (
    !object(v) ||
    Object.keys(v).some(
      k => !['shopperActivity', 'lookbackDays', 'categoryIds', 'brandIds', 'minPrice', 'maxPrice'].includes(k),
    )
  )
    invalid(at + ' takes shopperActivity, lookbackDays, categoryIds, brandIds, minPrice and maxPrice.');
  if ((create || v.shopperActivity !== undefined) && !activities.includes(v.shopperActivity))
    invalid(at + '.shopperActivity is ' + activities.join(', ') + '.');
  if ((create || v.lookbackDays !== undefined) && !lookbacks.includes(v.lookbackDays))
    invalid(at + '.lookbackDays is one of ' + lookbacks.join(', ') + '.');
  ids(v.categoryIds, at + '.categoryIds');
  ids(v.brandIds, at + '.brandIds');
  const min = price(v.minPrice, at + '.minPrice', !create),
    max = price(v.maxPrice, at + '.maxPrice', !create);
  if (typeof min === 'number' && typeof max === 'number' && min > max) invalid(at + ': minPrice is above maxPrice.');
  if (!create && !Object.keys(v).length) invalid(at + ' changes at least one field.');
}
export function assertCriteoSegments(p: CompiledRequest): void {
  const kind = criteoSegmentKind(p);
  if (!kind) return;
  if (accountOf(p) !== p.accountId) fail('ACCOUNT_SCOPE_MISMATCH', 'The path must use the selected account.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Audience segment reviews take no query or header overrides.');
  const b = p.body;
  if (
    !object(b) ||
    Object.keys(b).some(k => k !== 'data') ||
    !Array.isArray(b.data) ||
    !b.data.length ||
    b.data.length > maxItems
  )
    invalid('Send {data: [...]} with 1–' + maxItems + ' segments.');
  const seen = new Set<string>();
  b.data.forEach((raw: unknown, i: number) => {
    const at = 'data[' + i + ']';
    if (!object(raw)) invalid(at + ' is an object.');
    if (raw.type !== undefined && typeof raw.type !== 'string') invalid(at + '.type is a string when given.');
    if (kind === 'create') {
      if (Object.keys(raw).some(k => !['type', 'attributes'].includes(k)) || !object(raw.attributes))
        invalid(at + ' is {type, attributes}; Criteo assigns the ID.');
      const a = raw.attributes;
      if (Object.keys(a).some(k => !['name', 'description', 'retailerId', 'events', 'contactList'].includes(k)))
        invalid(at + '.attributes takes name, description, retailerId, and events or contactList.');
      text(a.name, at + '.attributes.name', 255);
      text(a.description, at + '.attributes.description', 1000, true);
      if (!id(a.retailerId))
        invalid(at + '.attributes.retailerId is the numeric ID of a retailer of the account, as a string.');
      if ((a.events === undefined) === (a.contactList === undefined))
        invalid(at + '.attributes sets exactly one of events or contactList.');
      if (a.events !== undefined) events(a.events, at + '.attributes.events', true);
      else if (
        !object(a.contactList) ||
        Object.keys(a.contactList).some(k => k !== 'identifierType') ||
        !identifiers.includes(a.contactList.identifierType)
      )
        invalid(
          at +
            '.attributes.contactList is {identifierType}, one of ' +
            identifiers.join(', ') +
            '; contacts are added by a separate request that is outside this contract.',
        );
      return;
    }
    if (!id(raw.id)) invalid(at + '.id is the numeric ID of a segment of the account, as a string.');
    if (seen.has(raw.id)) invalid('Each segment appears once.');
    seen.add(raw.id);
    if (kind === 'delete') {
      if (
        Object.keys(raw).some(k => !['id', 'type', 'attributes'].includes(k)) ||
        (raw.attributes !== undefined && !(object(raw.attributes) && !Object.keys(raw.attributes).length))
      )
        invalid(at + ' is {id, type}.');
      return;
    }
    if (Object.keys(raw).some(k => !['id', 'type', 'attributes'].includes(k)) || !object(raw.attributes))
      invalid(at + ' is {id, type, attributes}.');
    const a = raw.attributes;
    if (!Object.keys(a).length || Object.keys(a).some(k => !['name', 'description', 'events'].includes(k)))
      invalid(
        at +
          '.attributes changes name, description or events; the retailer, the type and a contact list identifier cannot change.',
      );
    if (a.name !== undefined) text(a.name, at + '.attributes.name', 255);
    if (
      a.description !== undefined &&
      (!object(a.description) ||
        Object.keys(a.description).some(k => k !== 'value') ||
        (a.description.value !== null &&
          (typeof a.description.value !== 'string' || [...a.description.value].length > 1000)))
    )
      invalid(at + '.attributes.description is {value}, text of up to 1000 characters or null.');
    if (a.events !== undefined) events(a.events, at + '.attributes.events', false);
  });
}
/** Writes need Audience_Manage; the segment search Audience_Read; the retailer search of a creation Campaign_Read. */
export function assertCriteoSegmentScopes(c: {scopes: string[]}, write = false, p?: CompiledRequest): void {
  const required = [
    'RetailMedia_Accounts_Read',
    'RetailMedia_Audience_Read',
    ...(write ? ['RetailMedia_Audience_Manage'] : []),
    ...(p && criteoSegmentKind(p) === 'create' ? ['RetailMedia_Campaign_Read'] : []),
  ];
  if (!required.every(s => c.scopes.includes(s)))
    fail('INSUFFICIENT_SCOPE', 'The selected Criteo connection needs ' + required.join(', ') + '.', {}, 403);
}
const read = (p: CompiledRequest, path: string, body?: JsonObject, query: JsonObject = {}): Read =>
  readOf<Read>(
    p,
    {action: 'AMCP_CRITEO_SEGMENT_READ', method: body ? 'POST' : 'GET', path, query, body},
    {queryArrayEncoding: 'repeat', criteoSegmentState: undefined},
  );
function context(p: CompiledRequest) {
  const kind = criteoSegmentKind(p)!;
  return {
    segments:
      kind === 'create'
        ? []
        : items(p)
            .map(x => String(x.id))
            .sort(),
    retailers: kind === 'create' ? [...new Set(items(p).map(x => String(x.attributes?.retailerId)))].sort() : [],
  };
}
/** The one search a review needs, marked: the segments named, or for creations the retailers named. Both are account-scoped. */
function stateRead(p: CompiledRequest, s: {segments: string[]; retailers: string[]}): Read {
  const account = accountOf(p);
  if (s.segments.length)
    return {
      ...read(
        p,
        prefix + '/accounts/' + account + '/audience-segments/search',
        {data: {type: 'AudienceSegmentSearch', attributes: {audienceSegmentIds: s.segments}}},
        {limit: 500, offset: 0},
      ),
      criteoSegmentState: s,
    };
  return {
    ...read(
      p,
      prefix + '/accounts/' + account + '/retailers/search',
      {data: {type: 'RetailerSearchRequest', attributes: {retailerIdFilter: s.retailers}}},
      {limit: 50, offset: 0},
    ),
    criteoSegmentState: s,
  };
}
export function criteoSegmentSnapshots(p: CompiledRequest): Read[] {
  return [stateRead(p, context(p))];
}
export function isCriteoSegmentRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).criteoSegmentState;
}
function envelope(r: TransportResult, what: string): JsonObject {
  const d = r.data;
  if (
    r.status !== 200 ||
    !object(d) ||
    ['errors', 'warnings'].some(k => d[k] != null && (!Array.isArray(d[k]) || d[k].length))
  )
    unverified('Criteo returned a failed or unrecognized ' + what + ' read.');
  return d as JsonObject;
}
/** One normalized form of a segment. */
function segment(v: JsonObject): JsonObject {
  const a = object(v.attributes) ? v.attributes : {},
    e = object(a.events) ? a.events : null,
    c = object(a.contactList) ? a.contactList : null;
  return {
    id: String(v.id),
    name: a.name ?? null,
    description: a.description ?? null,
    retailerId: a.retailerId == null ? null : String(a.retailerId),
    type: a.type ?? null,
    events: e
      ? {
          shopperActivity: e.shopperActivity ?? null,
          lookbackDays: e.lookbackDays ?? null,
          categoryIds: (Array.isArray(e.categoryIds) ? e.categoryIds.map(String) : []).sort(),
          brandIds: (Array.isArray(e.brandIds) ? e.brandIds.map(String) : []).sort(),
          minPrice: e.minPrice ?? null,
          maxPrice: e.maxPrice ?? null,
        }
      : null,
    contactList: c ? {identifierType: c.identifierType ?? null} : null,
  };
}
/** The retailers named by creations, or the segments named by updates and deletions, through the account's searches. */
export async function readCriteoSegments(
  p: CompiledRequest,
  fetch: (p: Read) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).criteoSegmentState;
  if (!s) return fetch(p);
  const account = accountOf(p),
    first = envelope(
      await fetch({...(p as Read), criteoSegmentState: undefined}),
      s.segments.length ? 'segment' : 'retailer',
    );
  const retailers: JsonObject = {};
  if (!s.segments.length) {
    for (const row of (Array.isArray(first.data) ? first.data : []) as unknown[]) {
      if (object(row) && s.retailers.includes(String(row.id)))
        retailers[String(row.id)] = {name: object(row.attributes) ? (row.attributes.name ?? null) : null};
    }
  }
  const segments: JsonObject = {};
  if (s.segments.length) {
    const r = first;
    if (
      !Array.isArray(r.data ?? []) ||
      (object(r.meta) && typeof r.meta.totalItems === 'number' && r.meta.totalItems > 500)
    )
      unverified('The segment search returned more than one page.');
    for (const row of (r.data ?? []) as unknown[]) {
      if (!object(row) || !id(String(row.id))) unverified('A segment row is malformed.');
      const v = segment(row);
      if (!s.segments.includes(String(v.id))) continue;
      if (object(row.attributes) && row.attributes.accountId != null && String(row.attributes.accountId) !== account)
        fail(
          'STATE_TARGET_MISMATCH',
          'Segment ' + String(v.id) + ' belongs to another account.',
          {segment: String(v.id)},
          409,
        );
      segments[String(v.id)] = v;
    }
  }
  return {status: 200, headers: {}, data: {account: {id: account}, retailers, segments}};
}
export function validateCriteoSegmentState(p: CompiledRequest, r: TransportResult): void {
  const d = r.data;
  if (
    !(p as Read).criteoSegmentState ||
    r.status !== 200 ||
    !object(d) ||
    !object(d.account) ||
    d.account.id !== accountOf(p) ||
    !object(d.retailers) ||
    !object(d.segments)
  )
    unverified('Missing verified audience segment state.');
}
/** Every segment as the request leaves it, for updates, in the normalized form. */
function updated(before: JsonObject, a: JsonObject): JsonObject {
  const out: JsonObject = JSON.parse(JSON.stringify(before));
  if (a.name !== undefined) out.name = a.name;
  if (a.description !== undefined) out.description = a.description.value;
  if (a.events !== undefined) {
    const e = a.events,
      next: JsonObject = {...(out.events as JsonObject)};
    for (const k of ['shopperActivity', 'lookbackDays']) if (e[k] !== undefined) next[k] = e[k];
    for (const k of ['categoryIds', 'brandIds']) if (e[k] !== undefined) next[k] = [...e[k]].map(String).sort();
    for (const k of ['minPrice', 'maxPrice']) if (e[k] !== undefined) next[k] = e[k].value;
    out.events = next;
  }
  return out;
}
export function criteoSegmentPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = criteoSegmentKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !object(s.retailers) || !object(s.segments)) unverified('Missing verified audience segment state.');
  if (kind === 'create') {
    for (const x of items(p)) {
      const r = String(x.attributes.retailerId);
      if (!object(s.retailers[r]))
        fail('STATE_NOT_FOUND', 'Retailer ' + r + ' is not a retailer of account ' + accountOf(p) + '.', {retailer: r});
    }
    return;
  }
  for (const x of items(p)) {
    const v = s.segments[String(x.id)];
    if (!object(v))
      fail('STATE_NOT_FOUND', 'Segment ' + String(x.id) + ' is not a segment of account ' + accountOf(p) + '.', {
        segment: String(x.id),
      });
    if (kind === 'delete') continue;
    if (x.attributes.events !== undefined && v.type !== 'Events')
      invalid(
        'Segment ' + String(x.id) + ' is a ' + String(v.type) + ' segment; only Events segments have event rules.',
      );
    const next = updated(v, x.attributes);
    if (JSON.stringify(next) === JSON.stringify(v)) invalid('Segment ' + String(x.id) + ' already has these values.');
    const e = object(next.events) ? next.events : null;
    if (e && typeof e.minPrice === 'number' && typeof e.maxPrice === 'number' && e.minPrice > e.maxPrice)
      invalid('Segment ' + String(x.id) + ' would have minPrice above maxPrice.');
  }
}
/** New event rules change who line items targeting the segment reach. */
export function criteoSegmentServing(p: CompiledRequest): boolean {
  return (
    criteoSegmentKind(p) === 'update' && items(p).some(x => object(x.attributes) && x.attributes.events !== undefined)
  );
}
export function criteoSegmentRemoves(p: CompiledRequest): boolean {
  return criteoSegmentKind(p) === 'delete';
}
export function criteoSegmentImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = criteoSegmentKind(p);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {},
    segments = object(s.segments) ? s.segments : {};
  const changes = items(p).map(x =>
    kind === 'create'
      ? {operation: 'create', segment: x.attributes}
      : kind === 'delete'
        ? {operation: 'delete', before: segments[String(x.id)] ?? null}
        : {
            operation: 'update',
            before: segments[String(x.id)] ?? null,
            after: object(segments[String(x.id)]) ? updated(segments[String(x.id)] as JsonObject, x.attributes) : null,
          },
  );
  return {
    provider: 'criteo',
    scope: 'audience_segment',
    operation: kind,
    changes,
    may_affect_serving: kind !== 'create',
    effect:
      kind === 'create'
        ? 'Creates segments; nothing serves until a line item targets them. A contact list segment stays empty until contacts are added, which is outside this contract.'
        : kind === 'delete'
          ? 'Deletes the segments; line items that target them lose that audience.'
          : 'Changes the segments; line items that target them reach the new audience.',
    verification:
      kind === 'delete'
        ? 'Searches the segments again and expects them to be gone.'
        : 'Searches the segments again and compares every field written.',
    source: 'https://developers.criteo.com/retail-media/docs/audience-segments',
  };
}
export function criteoSegmentOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = criteoSegmentKind(p)!,
    d = r.data,
    list = items(p);
  if (
    ![200, 201].includes(r.status) ||
    !object(d) ||
    ['errors', 'warnings'].some(k => d[k] != null && (!Array.isArray(d[k]) || d[k].length)) ||
    !Array.isArray(d.data) ||
    d.data.length !== list.length
  )
    return false;
  return d.data.every(
    (row: unknown, i: number) =>
      object(row) && id(String(row.id)) && (kind === 'create' || String(row.id) === String(list[i]!.id)),
  );
}
export function criteoSegmentVerification(
  p: CompiledRequest,
  result: JsonObject,
  before: unknown[],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = criteoSegmentKind(p)!,
    list = items(p),
    rows = (result.data?.data ?? []) as JsonObject[];
  const first = before[0],
    prior: JsonObject = object(first) && object(first.segments) ? first.segments : {},
    expected: JsonObject = {};
  list.forEach((x, i) => {
    const segmentId = kind === 'create' ? String(rows[i]?.id ?? '') : String(x.id);
    if (!id(segmentId)) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no segment to verify.');
    if (kind === 'delete') {
      expected[segmentId] = {present: false};
      return;
    }
    if (kind === 'update') {
      expected[segmentId] = {present: true, ...updated(prior[segmentId] as JsonObject, x.attributes)};
      return;
    }
    const a = x.attributes,
      e = a.events;
    expected[segmentId] = {
      present: true,
      name: a.name,
      description: a.description ?? null,
      retailerId: String(a.retailerId),
      type: e ? 'Events' : 'ContactList',
      ...(e
        ? {
            events: {
              shopperActivity: e.shopperActivity,
              lookbackDays: e.lookbackDays,
              categoryIds: [...(e.categoryIds ?? [])].map(String).sort(),
              brandIds: [...(e.brandIds ?? [])].map(String).sort(),
              minPrice: e.minPrice ?? null,
              maxPrice: e.maxPrice ?? null,
            },
          }
        : {contactList: {identifierType: a.contactList.identifierType}}),
    };
  });
  const probe = stateRead(p, {segments: Object.keys(expected).sort(), retailers: []});
  return [{read: probe, expected: {segments: expected}, id: Object.keys(expected).join(',')}];
}
export function criteoSegmentObserved(read: CompiledRequest, data: JsonObject): JsonObject {
  const found = object(data.segments) ? data.segments : {},
    wanted = (read as Read).criteoSegmentState?.segments ?? [];
  return {
    segments: Object.fromEntries(
      wanted.map(k => [k, object(found[k]) ? {present: true, ...found[k]} : {present: false}]),
    ),
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const criteoSegmentFamily: ReviewedFamily = defineFamily({
  name: 'criteo_audience_segments',
  files: ['src/criteo-audience-segments.ts', ['tests/criteo-audience-segments.test.mjs']],
  kind: criteoSegmentKind,
  assert: assertCriteoSegments,
  scope: assertCriteoSegmentScopes,
  snapshots: criteoSegmentSnapshots,
  isRead: isCriteoSegmentRead,
  reader: readCriteoSegments,
  validateState: validateCriteoSegmentState,
  prerequisites: criteoSegmentPrerequisites,
  impact: criteoSegmentImpact,
  outcome: criteoSegmentOutcome,
  verification: criteoSegmentVerification,
  observed: criteoSegmentObserved,
  spendConfirmation: {
    needed: criteoSegmentServing,
    message:
      'New event rules change who line items targeting these segments reach. Review them and provide spend_change_confirmed=true.',
  },
  exemptFromSpendTextMatch: true,
  activates: criteoSegmentServing,
  destructive: criteoSegmentRemoves,
});
