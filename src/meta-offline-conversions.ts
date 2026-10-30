import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily, Verified} from './reviewed-family.js';
import {metaPrefix, metaRoute} from './meta-version.js';
import {assertNoMethodOverride} from './write-common.js';
import {
  fail as personalFail,
  normalizeEmail,
  normalizePhone,
  reviewedRows,
  type PersonalDataRecord,
  type PersonalDataSpec,
  type Row,
} from './personal-data.js';
import {defineFamily, fail, readOf} from './family-kit.js';

/**
 * Meta offline conversions through the Conversions API, under the personal-data policy the owner approved on
 * 2026-09-30 (conversions come after customer lists). Meta's references (read 2026-09-30):
 * - "Using the Conversions API": POST /{pixel_id}/events with `data`; "You can send up to 1,000 events"; "If any event
 *   you send in a batch is invalid, we reject the entire batch"; event_time "up to 7 days before", and physical_store
 *   transactions "within 62 days of the conversion".
 * - "Server Event Parameters": event_name, event_time (Unix seconds), user_data, custom_data, event_id (deduplication)
 *   and action_source (email, website, app, phone_call, chat, physical_store, system_generated, business_messaging,
 *   other); website events need event_source_url and the browser's user agent.
 * - "Customer Information Parameters": em and ph hashed after normalization (trimmed, lower-cased emails; phone digits
 *   with the country code).
 * - "Custom Data Parameters": value and currency "Required for purchase events"; currency ISO 4217.
 * - The Meta Pixel reference: the seventeen standard events.
 *
 * AMCP sends offline events only: website and app events need browser or device data it does not collect. Each event
 * names a person by hashed email or phone, a standard event, its time and where it happened, with an optional value,
 * currency and event_id. The pixel must be one of the ad account's pixels, read first. A sent conversion cannot be
 * recalled; the review says so.
 */
type Read = CompiledRequest & {metaEventsState?: {pixel: string}};
const gateway = 'meta_native_action',
  marker = 'AMCP_META_OFFLINE_CONVERSION_READ',
  source = 'https://developers.facebook.com/docs/marketing-api/conversions-api/using-the-api',
  maxPages = 5,
  day = 86400;
const standardEvents = [
  'AddPaymentInfo',
  'AddToCart',
  'AddToWishlist',
  'CompleteRegistration',
  'Contact',
  'CustomizeProduct',
  'Donate',
  'FindLocation',
  'InitiateCheckout',
  'Lead',
  'Purchase',
  'Schedule',
  'Search',
  'StartTrial',
  'SubmitApplication',
  'Subscribe',
  'ViewContent',
];
// Offline sources: website and app events need the browser's or device's own data.
const actionSources = [
  'email',
  'phone_call',
  'chat',
  'physical_store',
  'system_generated',
  'business_messaging',
  'other',
];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const account = (v: unknown) => String(v ?? '').replace(/^act_/, '');
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function metaOfflineConversionKind(p: CompiledRequest): boolean {
  return (
    p.gateway === gateway &&
    !p.specialTransport &&
    (!p.origin || p.origin === 'https://graph.facebook.com') &&
    ['meta_pixel_id_events_create', 'meta_pixel_events_create'].includes(p.action) &&
    p.method === 'POST' &&
    metaRoute('[1-9][0-9]{0,31}/events$').test(p.path)
  );
}
const pixelOf = (p: CompiledRequest) => p.path.split('/')[2]!;
const record = (p: CompiledRequest) => p.personalData as PersonalDataRecord | undefined;

/** The fields of an event, in the order its row carries them after the hashed email and phone. */
const fields = {
  event_name: (v: unknown) => (typeof v === 'string' && standardEvents.includes(v) ? v : undefined),
  event_time: (v: unknown) => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : undefined),
  action_source: (v: unknown) => (typeof v === 'string' && actionSources.includes(v) ? v : undefined),
  value: (v: unknown) =>
    v === undefined || v === null ? null : typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined,
  currency: (v: unknown) =>
    v === undefined || v === null ? null : typeof v === 'string' && /^[A-Z]{3}$/.test(v) ? v : undefined,
  // Sent as it is, so it may not be an e-mail address: people are only sent hashed.
  event_id: (v: unknown) =>
    v === undefined || v === null
      ? null
      : typeof v === 'string' && v.length > 0 && v.length <= 100 && !/[\u0000-\u001f@]/.test(v)
        ? v
        : undefined,
};
const names = Object.keys(fields);
/** A field of a row: the fields follow the hashed keys, so they are counted from the end. */
const field = (r: Row, name: string) => r[r.length - names.length + names.indexOf(name)]!;
/** The event a row becomes: hashed em and ph when known, and custom_data only with a value. */
function event(r: Row, schema: string[]): JsonObject {
  const f = (name: string) => field(r, name);
  const user: JsonObject = {},
    em = r[schema.indexOf('EMAIL')],
    ph = r[schema.indexOf('PHONE')];
  if (em) user.em = [em];
  if (ph) user.ph = [ph];
  return {
    event_name: f('event_name'),
    event_time: f('event_time'),
    action_source: f('action_source'),
    ...(f('event_id') !== null ? {event_id: f('event_id')} : {}),
    user_data: user,
    ...(f('value') !== null ? {custom_data: {value: f('value'), currency: f('currency')}} : {}),
  };
}
/** The rows back from the events of a body, to check them against the review's digest. */
function rowsOf(data: unknown, schema: string[]): Row[] | undefined {
  if (!Array.isArray(data)) return undefined;
  const rows: Row[] = [];
  for (const e of data) {
    if (!object(e) || !object(e.user_data)) return undefined;
    const em = e.user_data.em,
      ph = e.user_data.ph,
      c = object(e.custom_data) ? e.custom_data : undefined;
    rows.push([
      ...schema.map(k => {
        const v = k === 'EMAIL' ? em : ph;
        return Array.isArray(v) ? String(v[0]) : '';
      }),
      e.event_name as string,
      e.event_time as number,
      e.action_source as string,
      c ? (c.value as number) : null,
      c ? (c.currency as string) : null,
      e.event_id === undefined ? null : (e.event_id as string),
    ]);
  }
  return rows;
}

/** The people's part: EMAIL and PHONE hashed as Meta documents, each row an offline event, at most 1,000 at a time. */
export const metaOfflineConversionPeople: PersonalDataSpec = {
  platform: 'Meta',
  actions: [gateway + ' meta_pixel_id_events_create', gateway + ' meta_pixel_events_create'],
  keys: {EMAIL: normalizeEmail, PHONE: normalizePhone},
  maxRows: 1000,
  direction: p => (metaOfflineConversionKind(p) ? 'add' : undefined),
  fields,
  identifiers: ['event_id'],
  row(f) {
    if (f.event_name === 'Purchase' && (f.value === null || f.currency === null)) return 'purchase_without_value';
    if (f.value !== null && f.currency === null) return 'value_without_currency';
    if (f.value === null && f.currency !== null) return 'currency_without_value';
  },
  check(rows, now) {
    const seconds = Math.floor(now / 1000);
    const future = rows.filter(r => (field(r, 'event_time') as number) > seconds + 300).length,
      old = rows.filter(r => {
        const window = field(r, 'action_source') === 'physical_store' ? 62 : 7;
        return (field(r, 'event_time') as number) < seconds - window * day;
      }).length;
    if (future)
      personalFail('PERSONAL_DATA_INVALID', future + ' events are in the future; event_time is when each happened.', {
        events: future,
      });
    if (old)
      personalFail(
        'PERSONAL_DATA_INVALID',
        old +
          ' events are older than Meta accepts: 7 days, or 62 days for physical_store. Meta rejects the whole batch for one of them.',
        {events: old},
      );
  },
  summarize(rows) {
    const events: Record<string, number> = {},
      value: Record<string, number> = {},
      sources: Record<string, number> = {};
    let earliest = Infinity,
      latest = 0;
    for (const r of rows) {
      const name = String(field(r, 'event_name')),
        src = String(field(r, 'action_source')),
        time = field(r, 'event_time') as number;
      events[name] = (events[name] ?? 0) + 1;
      sources[src] = (sources[src] ?? 0) + 1;
      if (field(r, 'value') !== null) {
        const c = String(field(r, 'currency'));
        value[c] = Math.round(((value[c] ?? 0) + (field(r, 'value') as number)) * 100) / 100;
      }
      earliest = Math.min(earliest, time);
      latest = Math.max(latest, time);
    }
    return {
      events: Object.fromEntries(Object.entries(events).sort()),
      value: Object.fromEntries(Object.entries(value).sort()),
      action_sources: Object.fromEntries(Object.entries(sources).sort()),
      earliest: new Date(earliest * 1000).toISOString(),
      latest: new Date(latest * 1000).toISOString(),
    };
  },
  body: (p, rows) => ({data: rows.map(r => event(r, record(p)!.schema))}),
  // Meta's Conversions API test_event_code sends production events that are not dropped, so Meta has no rehearsal.
  rehearsal: Object.freeze({
    provider: 'Meta Conversions API events',
    note: 'Meta has no rehearsal for conversions: events sent with test_event_code are production events that are not dropped, so AMCP never offers it.',
  }),
};

/** The request as AMCP builds it: the events of the reviewed people, nothing else. */
export function assertMetaOfflineConversion(p: CompiledRequest): void {
  if (!metaOfflineConversionKind(p)) return;
  assertNoMethodOverride(p);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    fail('INVALID_ARGUMENT', 'Conversions take their events in the body, without query or header overrides.');
  const r = record(p);
  if (!r)
    fail(
      'PERSONAL_DATA_REQUIRED',
      'Send the events as people, beside arguments: AMCP hashes them in memory and builds the body. Remove payload.',
    );
  const b = object(p.body) ? p.body : undefined;
  if (!b || Object.keys(b).join() !== 'data' || !reviewedRows(r, rowsOf(b.data, r.schema)))
    fail('PERSONAL_DATA_CHANGED', 'The request body is not the one AMCP built from the reviewed events.');
}
const read = (p: CompiledRequest, query: JsonObject, s?: {pixel: string}): Read =>
  readOf<Read>(p, {
    before: {personalData: undefined, metaEventsState: s},
    action: marker,
    path: metaPrefix + 'act_' + account(p.accountId) + '/adspixels',
    query,
  });
export function metaOfflineConversionSnapshots(p: CompiledRequest): Read[] {
  return [read(p, {fields: 'id,name', limit: 100}, {pixel: pixelOf(p)})];
}
export function isMetaOfflineConversionRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).metaEventsState;
}
/** The write after validation, and the one read: the ad account's pixels, in pages. */
export function authorizeMetaOfflineConversion(p: CompiledRequest, c: Connection, selected: string): boolean {
  if (metaOfflineConversionKind(p)) {
    assertMetaOfflineConversion(p);
    if (!c.scopes.includes('ads_management'))
      fail(
        'INSUFFICIENT_SCOPE',
        'Conversions need the ads_management permission.',
        {required: ['ads_management']},
        403,
      );
    if (account(p.accountId) !== selected)
      fail('ACCOUNT_SCOPE_MISMATCH', 'Select the ad account the pixel belongs to.', {}, 403);
    return true;
  }
  if (p.gateway !== gateway || p.action !== marker) return false;
  const keys = Object.keys(p.query).sort().join();
  if (
    p.method === 'GET' &&
    p.readOnly &&
    p.body === undefined &&
    account(p.accountId) === selected &&
    p.path === metaPrefix + 'act_' + selected + '/adspixels' &&
    p.query.fields === 'id,name' &&
    p.query.limit === 100 &&
    (keys === 'fields,limit' || (keys === 'after,fields,limit' && typeof p.query.after === 'string'))
  )
    return true;
  return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal conversion read.', {}, 403);
}
/** The account's pixels in bounded pages; the state keeps only the named pixel, when it is one of them. */
export async function readMetaOfflineConversions(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).metaEventsState;
  if (!s) return fetch(p);
  let q = read(p, {fields: 'id,name', limit: 100});
  for (let page = 0; ; page++) {
    if (page >= maxPages) unverified('The ad account has more pixels than one review reads.');
    const r = await fetch(q),
      d = r.data;
    if (r.status !== 200 || !object(d) || !Array.isArray(d.data)) unverified('Meta did not list the pixels.');
    const hit = (d.data as unknown[]).find(x => object(x) && String(x.id) === s.pixel) as JsonObject | undefined;
    if (hit)
      return {
        status: 200,
        headers: {},
        data: {account_id: account(p.accountId), pixel: {id: s.pixel, name: hit.name ?? null}},
      };
    const after = object(d.paging) && object(d.paging.cursors) ? d.paging.cursors.after : undefined;
    if (!(object(d.paging) && d.paging.next) || typeof after !== 'string')
      return {status: 200, headers: {}, data: {account_id: account(p.accountId), pixel: null}};
    q = read(p, {fields: 'id,name', limit: 100, after});
  }
}
export function validateMetaOfflineConversionState(p: CompiledRequest, r: TransportResult): void {
  if (!(p as Read).metaEventsState || r.status !== 200 || !object(r.data) || !('pixel' in r.data))
    unverified('Missing verified pixel state.');
}
export function metaOfflineConversionPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const s = object(states[0]) ? states[0] : {};
  if (!object(s.pixel))
    fail(
      'STATE_TARGET_MISMATCH',
      'Meta pixel ' + pixelOf(p) + ' is not a pixel of ad account ' + s.account_id + '.',
      {},
      403,
    );
}
export function metaOfflineConversionImpact(p: CompiledRequest, states: unknown[]): JsonObject {
  const s = object(states[0]) ? states[0] : {},
    x = object(s.pixel) ? s.pixel : {},
    r = record(p)!;
  return {
    provider: 'meta',
    effect:
      'Sends ' +
      r.counts.sent +
      ' offline conversion events, the people hashed with SHA-256, to pixel "' +
      x.name +
      '" (' +
      pixelOf(p) +
      ') of ad account ' +
      s.account_id +
      '.',
    events: r.summary ?? null,
    people: r.counts,
    confirmations: r.confirmations ?? null,
    recall:
      'A conversion cannot be recalled once Meta has received it: Meta uses it for attribution, reporting and delivery.',
    approval: 'Only the workspace owner executes this upload: an operator prepares it.',
    batch: 'Meta rejects the whole batch if one event is invalid.',
    kept: 'AMCP keeps the counts, an aggregate of the events and one digest, never the people.',
    verification: 'Compares the number of events Meta received with the number sent; the events are never read back.',
    source,
  };
}
export function metaOfflineConversionOutcome(_p: CompiledRequest, r: TransportResult): boolean {
  return r.status === 200 && object(r.data) && !r.data.error && typeof r.data.events_received === 'number';
}
/** Meta's reply as it is kept: the count received and Meta's trace id, and how many messages it returned. */
export function metaOfflineConversionSafeOutcome(outcome: JsonObject): JsonObject {
  if (!object(outcome.data)) return outcome;
  const d = outcome.data;
  return {
    ...outcome,
    data: {
      events_received: d.events_received,
      ...(typeof d.fbtrace_id === 'string' ? {fbtrace_id: d.fbtrace_id} : {}),
      ...(Array.isArray(d.messages) && d.messages.length ? {messages: d.messages.length} : {}),
    },
  };
}
function verifyEvents(p: CompiledRequest, result: JsonObject): Verified {
  const r = record(p)!,
    d = object(result.data) ? result.data : {},
    received = typeof d.events_received === 'number' ? d.events_received : null,
    complete = received === r.counts.sent;
  return {
    status: complete ? 'verified' : 'unverified',
    checks: [
      {
        resource_id: pixelOf(p),
        status: complete ? 'verified' : 'unverified',
        sent: r.counts.sent,
        received,
        verification_scope: 'Meta’s count of the events received for this request; the events are never read back',
        ...(complete ? {} : {reason: 'Meta received ' + received + ' of the ' + r.counts.sent + ' events sent.'}),
      },
    ],
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const metaOfflineConversionFamily: ReviewedFamily = defineFamily({
  name: 'meta_offline_conversions',
  files: ['src/meta-offline-conversions.ts', ['tests/meta-offline-conversions.test.mjs']],
  kind: metaOfflineConversionKind,
  assert: plan => assertMetaOfflineConversion(plan),
  authorize: authorizeMetaOfflineConversion,
  snapshots: metaOfflineConversionSnapshots,
  isRead: isMetaOfflineConversionRead,
  reader: readMetaOfflineConversions,
  validateState: validateMetaOfflineConversionState,
  prerequisites: metaOfflineConversionPrerequisites,
  impact: metaOfflineConversionImpact,
  outcome: metaOfflineConversionOutcome,
  safeOutcome: outcome => metaOfflineConversionSafeOutcome(outcome),
  verify: async (plan, v) => verifyEvents(plan, v.result),
  personalData: metaOfflineConversionPeople,
  exemptFromSpendTextMatch: true,
  exemptFromActivationScan: true,
  activates: () => false,
  destructive: () => false,
});
