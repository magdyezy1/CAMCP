import type {ReviewedFamily} from './reviewed-family.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {defineFamily, fail, stateReadOf} from './family-kit.js';

/**
 * Snapchat event details, Marketing API v1 ("Event Details"; checked 2026-09-27). POST
 * /v1/adaccounts/{ad_account_id}/event_details creates the events that Reminder creatives promote, from
 * {event_details: [{event_name, event_time_zone, event_start_time, ad_account_id}]}; the entity "is immutable once
 * created". GET on the same path lists them and DELETE /v1/event_details/{id} deletes one; "there is no way to reinstate a
 * deleted entity" and it should not be used by an active Reminder creative. Creatives name one in
 * reminder_properties.event_details_id (event_detail_id in the guide's example).
 */
type Kind = 'create' | 'delete';
type State = {events: string[]; usage: boolean};
type Read = CompiledRequest & {snapEventState?: State};
const gateway = 'snapchat_native_action',
  origin = 'https://adsapi.snapchat.com',
  maxItems = 10,
  pageSize = 1000,
  maxPages = 5,
  horizon = 3 * 366 * 86400000;
const zones = [
  'Africa/Cairo',
  'Africa/Johannesburg',
  'America/Anchorage',
  'America/Cancun',
  'America/Chicago',
  'America/Dawson',
  'America/Dawson_Creek',
  'America/Denver',
  'America/Edmonton',
  'America/Halifax',
  'America/Hermosillo',
  'America/Los_Angeles',
  'America/Mazatlan',
  'America/Mexico_City',
  'America/Montevideo',
  'America/New_York',
  'America/Phoenix',
  'America/Rainy_River',
  'America/Regina',
  'America/Tijuana',
  'America/Toronto',
  'America/Vancouver',
  'Asia/Amman',
  'Asia/Beirut',
  'Asia/Dubai',
  'Asia/Hong_Kong',
  'Asia/Irkutsk',
  'Asia/Jerusalem',
  'Asia/Kamchatka',
  'Asia/Krasnoyarsk',
  'Asia/Magadan',
  'Asia/Nicosia',
  'Asia/Omsk',
  'Asia/Qatar',
  'Asia/Riyadh',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Vladivostok',
  'Asia/Yakutsk',
  'Asia/Yekaterinburg',
  'Atlantic/Canary',
  'Australia/Perth',
  'Australia/Sydney',
  'Europe/Amsterdam',
  'Europe/Berlin',
  'Europe/Brussels',
  'Europe/Dublin',
  'Europe/Helsinki',
  'Europe/Istanbul',
  'Europe/Kaliningrad',
  'Europe/London',
  'Europe/Luxembourg',
  'Europe/Madrid',
  'Europe/Malta',
  'Europe/Moscow',
  'Europe/Oslo',
  'Europe/Paris',
  'Europe/Rome',
  'Europe/Samara',
  'Europe/Stockholm',
  'Europe/Vienna',
  'Europe/Vilnius',
  'Europe/Warsaw',
  'Europe/Zurich',
  'Pacific/Auckland',
  'Pacific/Honolulu',
  'UTC',
];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const snapId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(v);
const text = (v: unknown, min: number, max: number): v is string =>
  typeof v === 'string' &&
  v === v.trim() &&
  [...v].length >= min &&
  [...v].length <= max &&
  !/[\u0000-\u001f\u007f]/.test(v);
function invalid(message: string): never {
  return fail('INVALID_SNAPCHAT_EVENT_DETAILS', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function snapEventKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.specialTransport || (p.origin && p.origin !== origin)) return;
  if (p.method === 'POST' && /^\/v1\/adaccounts\/[A-Za-z0-9-]{1,64}\/event_details$/.test(p.path)) return 'create';
  if (p.method === 'DELETE' && /^\/v1\/event_details\/[A-Za-z0-9-]{1,64}$/.test(p.path)) return 'delete';
  return;
}
const eventOf = (p: CompiledRequest) => p.path.split('/')[3]!;
const rows = (p: CompiledRequest) =>
  (object(p.body) && Array.isArray(p.body.event_details) ? p.body.event_details : []) as JsonObject[];
/**
 * The instant of an event_start_time: a date with optional hour, minutes and seconds, read as UTC unless it carries an
 * offset (the guide's example writes -04:00:00).
 */
export function eventInstant(v: unknown): string | undefined {
  const m =
    typeof v === 'string'
      ? /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?)?(Z|([+-])(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(
          v,
        )
      : null;
  if (!m) return;
  const n = (i: number) => Number(m[i] ?? 0),
    y = n(1),
    mo = n(2),
    d = n(3),
    h = n(4),
    mi = n(5),
    s = n(6),
    ms = Number((m[7] ?? '0').padEnd(3, '0'));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return;
  let t = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  if (new Date(t).getUTCDate() !== d) return;
  if (m[9]) {
    const off = (Number(m[10]) * 3600 + Number(m[11]) * 60 + Number(m[12] ?? 0)) * 1000;
    if (Number(m[10]) > 14 || Number(m[11]) > 59) return;
    t += m[9] === '+' ? -off : off;
  }
  return new Date(t).toISOString();
}
export function assertSnapEvent(p: CompiledRequest): void {
  const kind = snapEventKind(p);
  if (!kind) return;
  if (!snapId(p.accountId)) fail('ACCOUNT_REQUIRED', 'Select the ad account of the event details.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Event details writes take no query or header overrides.');
  if (kind === 'delete') {
    if (p.body !== undefined && !(object(p.body) && !Object.keys(p.body).length))
      invalid('Deletion takes only the event details in the path.');
    return;
  }
  if (p.path.split('/')[3] !== p.accountId)
    fail('ACCOUNT_SCOPE_MISMATCH', 'Select the ad account in the path.', {}, 403);
  const b = p.body;
  if (
    !object(b) ||
    Object.keys(b).some(k => k !== 'event_details') ||
    !Array.isArray(b.event_details) ||
    !b.event_details.length ||
    b.event_details.length > maxItems
  )
    invalid('Send {event_details: [...]} with 1–' + maxItems + ' events.');
  const seen = new Set<string>(),
    now = Date.now();
  (b.event_details as unknown[]).forEach((e, i) => {
    const at = 'event_details[' + i + ']';
    if (
      !object(e) ||
      Object.keys(e).some(k => !['event_name', 'event_time_zone', 'event_start_time', 'ad_account_id'].includes(k))
    )
      invalid(at + ' takes event_name, event_time_zone, event_start_time and ad_account_id.');
    if (e.ad_account_id !== p.accountId) invalid(at + '.ad_account_id is the selected ad account.');
    if (!text(e.event_name, 1, 300))
      invalid(at + '.event_name has 1–300 characters without surrounding spaces or control characters.');
    if (e.event_time_zone !== undefined && !zones.includes(e.event_time_zone as string))
      invalid(at + ".event_time_zone is one of the guide's time zones, such as America/New_York or UTC.");
    const start = eventInstant(e.event_start_time);
    if (!start)
      invalid(
        at +
          '.event_start_time is a date with optional time, such as 2026-11-16T09:00:00, read as UTC unless it carries an offset.',
      );
    const t = Date.parse(start!);
    if (t <= now || t > now + horizon)
      invalid(
        at + '.event_start_time lies in the future, within three years; the event details cannot be edited later.',
      );
    const key = e.event_name.toLowerCase() + '|' + start;
    if (seen.has(key)) invalid('Each event appears once per request.');
    seen.add(key);
  });
}
const read = (p: CompiledRequest, path: string, state?: State): Read =>
  stateReadOf<Read>(p, 'AMCP_SNAPCHAT_EVENT_DETAILS_READ', path, {limit: pageSize}, {snapEventState: state});
const stateRead = (p: CompiledRequest, state: State) =>
  read(p, '/v1/adaccounts/' + p.accountId + '/event_details', state);
export function snapEventSnapshots(p: CompiledRequest): Read[] {
  return [
    stateRead(p, snapEventKind(p) === 'delete' ? {events: [eventOf(p)], usage: true} : {events: [], usage: false}),
  ];
}
export function isSnapEventRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).snapEventState;
}
/** Writes after validation; internal reads are the account's event details and creatives. */
export function authorizeSnapEvent(p: CompiledRequest, _c: Connection, account: string): boolean {
  if (p.gateway !== gateway) return false;
  if (snapEventKind(p)) {
    assertSnapEvent(p);
    if (p.accountId !== account) fail('ACCOUNT_SCOPE_MISMATCH', 'Select the ad account of the event details.', {}, 403);
    return true;
  }
  if (p.action !== 'AMCP_SNAPCHAT_EVENT_DETAILS_READ' || p.method !== 'GET' || !p.readOnly || p.body !== undefined)
    return false;
  if (
    p.path === '/v1/adaccounts/' + account + '/event_details' ||
    p.path === '/v1/adaccounts/' + account + '/creatives'
  )
    return true;
  return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal event details read.', {}, 403);
}
async function all(
  first: Read,
  key: string,
  item: string,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<JsonObject[]> {
  const out: JsonObject[] = [],
    cursors = new Set<string>();
  let q = first;
  for (let page = 0; ; page++) {
    if (page >= maxPages)
      unverified(
        'The ad account has more ' + key.replace('_', ' ') + ' than one review reads (' + maxPages * pageSize + ').',
      );
    const r = await fetch(q),
      d = r.data;
    if (
      r.status !== 200 ||
      !object(d) ||
      String(d.request_status).toUpperCase() !== 'SUCCESS' ||
      !Array.isArray(d[key])
    )
      unverified('Snapchat did not list the ' + key.replace('_', ' ') + '.');
    for (const row of d[key] as unknown[]) {
      const v = object(row) && object(row[item]) ? row[item] : undefined;
      if (!v || !snapId(v.id)) unverified('A row of the ' + key.replace('_', ' ') + ' is malformed.');
      out.push(v!);
    }
    const link = object(d.paging) ? d.paging.next_link : undefined;
    if (!link) return out;
    let cursor: string | null = null;
    try {
      cursor = new URL(String(link)).searchParams.get('cursor');
    } catch {
      cursor = null;
    }
    if (!cursor || cursors.has(cursor))
      unverified('Snapchat pagination of the ' + key.replace('_', ' ') + ' is repeated or malformed.');
    cursors.add(cursor!);
    q = {...q, query: {...q.query, cursor: cursor!}};
  }
}
export async function readSnapEvents(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).snapEventState;
  if (!s) return fetch(p);
  const account = p.accountId!,
    events: JsonObject = {};
  for (const e of await all(
    {...(p as Read), snapEventState: undefined} as Read,
    'event_details',
    'event_detail',
    fetch,
  )) {
    if (e.ad_account_id !== undefined && e.ad_account_id !== account)
      fail('STATE_TARGET_MISMATCH', 'Snapchat listed event details of another ad account.', {}, 409);
    if (Object.hasOwn(events, 'e' + e.id)) unverified('Event details are listed twice.');
    events['e' + e.id] = {
      present: true,
      id: String(e.id),
      event_name: e.event_name ?? null,
      event_time_zone: e.event_time_zone ?? null,
      start: eventInstant(e.event_start_time) ?? e.event_start_time ?? null,
    };
  }
  for (const id of s.events) if (!Object.hasOwn(events, 'e' + id)) events['e' + id] = {present: false, id};
  const out: JsonObject = {ad_account_id: account, events};
  if (s.usage) {
    const creatives = await all(read(p, '/v1/adaccounts/' + account + '/creatives'), 'creatives', 'creative', fetch),
      used: JsonObject = {};
    for (const id of s.events)
      used['e' + id] = creatives
        .filter(
          c =>
            object(c.reminder_properties) &&
            (c.reminder_properties.event_details_id === id || c.reminder_properties.event_detail_id === id),
        )
        .map(c => ({id: String(c.id), name: c.name ?? null, type: c.type ?? null}))
        .sort((a, b) => a.id.localeCompare(b.id));
    out.used_by = used;
  }
  return {status: 200, headers: {}, data: out};
}
export function validateSnapEventState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).snapEventState,
    d = r.data;
  if (!s || r.status !== 200 || !object(d) || !object(d.events) || s.usage !== object(d.used_by))
    unverified('Missing verified event details state.');
}
export function snapEventPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = snapEventKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !object(s.events)) unverified('Missing verified event details state.');
  const events = s.events as JsonObject;
  if (kind === 'create') {
    const taken = new Set(
      Object.values(events)
        .filter(object)
        .map(e => String(e.event_name).toLowerCase() + '|' + String(e.start)),
    );
    for (const e of rows(p))
      if (taken.has(String(e.event_name).toLowerCase() + '|' + eventInstant(e.event_start_time)))
        fail(
          'CONFIGURATION_EXISTS',
          'The ad account already has event details "' +
            String(e.event_name) +
            '" starting ' +
            eventInstant(e.event_start_time) +
            '.',
          {event_name: String(e.event_name)},
        );
    return;
  }
  const e = events['e' + eventOf(p)];
  if (!object(e) || e.present !== true)
    fail('STATE_NOT_FOUND', 'Event details ' + eventOf(p) + ' are not event details of the selected ad account.', {
      event_details_id: eventOf(p),
    });
  const used = object(s.used_by) ? (s.used_by as JsonObject)['e' + eventOf(p)] : undefined;
  if (!Array.isArray(used)) unverified('Missing event details usage.');
  if ((used as JsonObject[]).length)
    fail(
      'EVENT_DETAILS_IN_USE',
      'Event details ' +
        eventOf(p) +
        ' are promoted by creatives ' +
        (used as JsonObject[]).map(c => String(c.id)).join(', ') +
        '; Snapchat cannot reinstate deleted event details.',
      {creatives: (used as JsonObject[]).map(c => String(c.id))},
      409,
    );
}
export function snapEventImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = snapEventKind(p);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {},
    events: JsonObject = object(s.events) ? s.events : {};
  return {
    provider: 'snapchat',
    scope: 'event_details',
    operation: kind,
    ...(kind === 'create'
      ? {creating: rows(p).map(e => ({...e, start: eventInstant(e.event_start_time)}))}
      : {deleting: events['e' + eventOf(p)] ?? {id: eventOf(p)}}),
    may_affect_serving: false,
    effect:
      kind === 'create'
        ? 'Creates immutable event details that Reminder creatives can promote; nothing serves until a creative names them.'
        : 'Deletes the event details permanently; no creative of the account promotes them.',
    verification:
      kind === 'create'
        ? "Lists the account's event details again and compares each name, start and time zone sent."
        : "Lists the account's event details again and expects these to be gone.",
    source: 'https://developers.snap.com/api/marketing-api/Ads-API/event-details',
  };
}
export function snapEventOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = snapEventKind(p)!,
    d = r.data;
  if (r.status !== 200 || !object(d) || String(d.request_status).toUpperCase() !== 'SUCCESS') return false;
  if (kind === 'delete') return true;
  const out = d.event_details;
  return (
    Array.isArray(out) &&
    out.length === rows(p).length &&
    out.every(
      (x: unknown) =>
        object(x) &&
        String(x.sub_request_status).toUpperCase() === 'SUCCESS' &&
        object(x.event_detail) &&
        snapId(x.event_detail.id),
    )
  );
}
export function snapEventVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  if (snapEventKind(p) === 'delete')
    return [
      {
        read: stateRead(p, {events: [eventOf(p)], usage: false}),
        expected: {events: {['e' + eventOf(p)]: {present: false}}},
        id: 'event details ' + eventOf(p),
      },
    ];
  const expected: JsonObject = {};
  rows(p).forEach((e, i) => {
    const id = result.data?.event_details?.[i]?.event_detail?.id;
    if (!snapId(id)) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no event details to verify.');
    expected['e' + id] = {
      present: true,
      id,
      event_name: e.event_name,
      start: eventInstant(e.event_start_time),
      ...(e.event_time_zone !== undefined ? {event_time_zone: e.event_time_zone} : {}),
    };
  });
  const ids = Object.keys(expected).map(k => k.slice(1));
  return [{read: stateRead(p, {events: ids, usage: false}), expected: {events: expected}, id: ids.join(',')}];
}
export function snapEventObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {events: object(data.events) ? data.events : {}};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const snapEventFamily: ReviewedFamily = defineFamily({
  name: 'snapchat_event_details',
  files: ['src/snapchat-event-details.ts', ['tests/snapchat-event-details.test.mjs']],
  kind: snapEventKind,
  assert: assertSnapEvent,
  authorize: authorizeSnapEvent,
  snapshots: snapEventSnapshots,
  isRead: isSnapEventRead,
  reader: readSnapEvents,
  validateState: validateSnapEventState,
  prerequisites: snapEventPrerequisites,
  impact: snapEventImpact,
  outcome: snapEventOutcome,
  verification: snapEventVerification,
  observed: snapEventObserved,
  exemptFromSpendTextMatch: true,
});
