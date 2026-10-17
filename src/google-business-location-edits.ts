import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {fail} from './family-kit.js';

/**
 * Business Profile location hours and contact details, per the pinned Business Information API v1 Discovery document
 * (locations.patch and get; Location, BusinessHours, TimePeriod, SpecialHours, SpecialHourPeriod, PhoneNumbers,
 * AdWordsLocationExtensions; checked 2026-09-28). PATCH /v1/locations/{id}?updateMask= "Updates the specified location".
 * Qualified fields: regularHours (periods of open and close day and time, "00:00-24:00"; "The closing time must occur after
 * the opening time"), specialHours ("cannot be set without regular hours"; a period "must represent a range of less than
 * 24 hours", its end date at most one day after its start), phoneNumbers ("During updates, both fields must be set"; up to
 * two additional phones), websiteUri, labels ("NOT user facing ... 1-255 characters per label"; Google Ads location asset
 * filters use them) and adWordsLocationExtensions.adPhone. The title, address, categories, open status, profile, store code
 * and service data stay out: they change what the public listing claims, may trigger re-verification, or must be unique.
 */
type Read = CompiledRequest & {businessLocationEditRead?: true};
const gateway = 'google_business_native_action',
  origin = 'https://mybusinessbusinessinformation.googleapis.com',
  oauthScope = 'https://www.googleapis.com/auth/business.manage';
const action = 'gmb_location_ops/PATCH_LOCATION',
  editable = ['regularHours', 'specialHours', 'phoneNumbers', 'websiteUri', 'labels', 'adWordsLocationExtensions'];
const days = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'],
  maxPeriods = 50,
  maxSpecial = 100,
  maxLabels = 50;
const readMask =
  'name,title,regularHours,specialHours,phoneNumbers,websiteUri,labels,adWordsLocationExtensions,openInfo,metadata';
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(message: string): never {
  return fail('INVALID_BUSINESS_LOCATION_EDIT', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function businessLocationEditKind(p: CompiledRequest): boolean {
  return (
    p.gateway === gateway &&
    p.origin === origin &&
    p.method === 'PATCH' &&
    p.action === action &&
    !p.specialTransport &&
    /^\/v1\/locations\/[1-9][0-9]*$/.test(p.path)
  );
}
const locationOf = (p: CompiledRequest) => p.path.slice(4);
const maskOf = (p: CompiledRequest) => String(p.query.updateMask ?? '').split(',');
const body = (p: CompiledRequest): JsonObject => (obj(p.body) ? p.body : {});
/** Minutes since midnight of a TimeOfDay; proto3 JSON omits zero fields, so {} is 00:00. */
function minutes(v: unknown, label: string): number {
  if (!obj(v) || Object.keys(v).some(k => !['hours', 'minutes', 'seconds', 'nanos'].includes(k)))
    invalid(label + ' is a time of day {hours, minutes}.');
  const h = v.hours ?? 0,
    m = v.minutes ?? 0;
  if (
    !Number.isInteger(h) ||
    !Number.isInteger(m) ||
    (h as number) < 0 ||
    (h as number) > 24 ||
    (m as number) < 0 ||
    (m as number) > 59 ||
    (h === 24 && m !== 0) ||
    (v.seconds ?? 0) !== 0 ||
    (v.nanos ?? 0) !== 0
  )
    invalid(label + ' is between 00:00 and 24:00 in whole minutes.');
  return (h as number) * 60 + (m as number);
}
function date(v: unknown, label: string): number {
  if (!obj(v) || Object.keys(v).some(k => !['year', 'month', 'day'].includes(k)))
    invalid(label + ' is a date {year, month, day}.');
  const {year, month, day} = v as {year: unknown; month: unknown; day: unknown},
    t = Date.UTC(Number(year), Number(month) - 1, Number(day)),
    c = new Date(t);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    c.getUTCFullYear() !== year ||
    c.getUTCMonth() !== (month as number) - 1 ||
    c.getUTCDate() !== day
  )
    invalid(label + ' is a real calendar date.');
  return t / 86400000;
}
function regularHours(v: unknown): void {
  if (
    !obj(v) ||
    Object.keys(v).join() !== 'periods' ||
    !Array.isArray(v.periods) ||
    !v.periods.length ||
    v.periods.length > maxPeriods
  )
    invalid('regularHours is {periods: [...]} with 1–' + maxPeriods + ' periods.');
  (v.periods as unknown[]).forEach((p, i) => {
    const at = 'regularHours.periods[' + i + ']';
    if (!obj(p) || Object.keys(p).some(k => !['openDay', 'openTime', 'closeDay', 'closeTime'].includes(k)))
      invalid(at + ' has openDay, openTime, closeDay and closeTime.');
    if (!days.includes(String(p.openDay)) || !days.includes(String(p.closeDay)))
      invalid(at + ' names days MONDAY to SUNDAY.');
    const open = days.indexOf(String(p.openDay)) * 1440 + minutes(p.openTime, at + '.openTime'),
      close = days.indexOf(String(p.closeDay)) * 1440 + minutes(p.closeTime, at + '.closeTime');
    if ((close - open + 7 * 1440) % (7 * 1440) === 0) invalid(at + ' closes after it opens.');
  });
}
function specialHours(v: unknown): void {
  if (
    !obj(v) ||
    Object.keys(v).join() !== 'specialHourPeriods' ||
    !Array.isArray(v.specialHourPeriods) ||
    v.specialHourPeriods.length > maxSpecial
  )
    invalid('specialHours is {specialHourPeriods: [...]} with at most ' + maxSpecial + ' periods.');
  (v.specialHourPeriods as unknown[]).forEach((p, i) => {
    const at = 'specialHours.specialHourPeriods[' + i + ']';
    if (!obj(p) || Object.keys(p).some(k => !['startDate', 'endDate', 'openTime', 'closeTime', 'closed'].includes(k)))
      invalid(at + ' has startDate, endDate, openTime, closeTime and closed.');
    const start = date(p.startDate, at + '.startDate'),
      end = p.endDate === undefined ? start : date(p.endDate, at + '.endDate');
    if (p.closed !== undefined && typeof p.closed !== 'boolean') invalid(at + '.closed is true or false.');
    if (p.closed === true) {
      if (p.openTime !== undefined || p.closeTime !== undefined || p.endDate !== undefined)
        invalid(at + ' is closed all day: only startDate applies.');
      return;
    }
    if (p.openTime === undefined || p.closeTime === undefined)
      invalid(at + ' needs openTime and closeTime unless it is closed.');
    if (end < start || end - start > 1) invalid(at + ' ends on its start date or the next day.');
    const span = (end - start) * 1440 + minutes(p.closeTime, at + '.closeTime') - minutes(p.openTime, at + '.openTime');
    if (span <= 0 || span >= 1440) invalid(at + ' spans less than 24 hours and closes after it opens.');
  });
}
const phone = (v: unknown) => typeof v === 'string' && /^\+?[0-9][0-9 ()./-]{3,30}[0-9]$/.test(v);
export function assertBusinessLocationEdit(p: CompiledRequest): void {
  if (!businessLocationEditKind(p)) return;
  if (p.accountId !== 'locations/' + locationOf(p).split('/')[1])
    fail(
      'ACCOUNT_SCOPE_MISMATCH',
      'Select this exact locations/{id} grant with location_id; an account grant does not name the location.',
      {},
      403,
    );
  if (Object.keys(p.headers ?? {}).length) invalid('Location edits take no header overrides.');
  if (Object.keys(p.query).some(k => k !== 'updateMask') || typeof p.query.updateMask !== 'string')
    invalid('A location edit takes only updateMask in the query; validateOnly and other options stay out.');
  const mask = maskOf(p);
  if (!mask.length || mask.some(f => !editable.includes(f)) || new Set(mask).size !== mask.length)
    invalid(
      'updateMask lists ' +
        editable.join(', ') +
        '; the title, address, categories, open status, profile, store code and service data stay out.',
    );
  const b = p.body;
  if (!obj(b)) invalid('Provide the Location body.');
  const fields = Object.keys(b).filter(k => k !== 'name');
  if (b.name !== undefined && b.name !== locationOf(p)) invalid('name, when sent, is the location in the path.');
  if (fields.some(k => !mask.includes(k)) || mask.some(k => !Object.hasOwn(b, k)))
    invalid('The body carries exactly the fields named in updateMask.');
  if (b.regularHours !== undefined) regularHours(b.regularHours);
  if (b.specialHours !== undefined) specialHours(b.specialHours);
  if (b.phoneNumbers !== undefined) {
    const n = b.phoneNumbers;
    if (
      !obj(n) ||
      Object.keys(n).sort().join() !== 'additionalPhones,primaryPhone' ||
      !phone(n.primaryPhone) ||
      !Array.isArray(n.additionalPhones) ||
      n.additionalPhones.length > 2 ||
      n.additionalPhones.some(x => !phone(x))
    )
      invalid(
        'phoneNumbers sets both primaryPhone and additionalPhones (at most two, [] for none), as Business Profile requires.',
      );
  }
  if (b.websiteUri !== undefined) {
    let u: URL;
    try {
      u = new URL(String(b.websiteUri));
    } catch {
      return invalid('websiteUri is a complete http(s) URL.');
    }
    if (
      typeof b.websiteUri !== 'string' ||
      !['https:', 'http:'].includes(u.protocol) ||
      u.username ||
      u.password ||
      b.websiteUri.length > 2048
    )
      invalid('websiteUri is an http(s) URL without embedded credentials.');
  }
  if (
    b.labels !== undefined &&
    (!Array.isArray(b.labels) ||
      b.labels.length > maxLabels ||
      b.labels.some(
        l =>
          typeof l !== 'string' ||
          !l.trim() ||
          l !== l.trim() ||
          [...l].length > 255 ||
          /[\u0000-\u001f\u007f]/.test(l),
      ) ||
      new Set(b.labels).size !== b.labels.length)
  )
    invalid('labels lists at most ' + maxLabels + ' distinct labels of 1–255 characters.');
  if (
    b.adWordsLocationExtensions !== undefined &&
    (!obj(b.adWordsLocationExtensions) ||
      Object.keys(b.adWordsLocationExtensions).join() !== 'adPhone' ||
      !phone(b.adWordsLocationExtensions.adPhone))
  )
    invalid('adWordsLocationExtensions is {adPhone} with a phone number.');
}
export function assertBusinessLocationEditScope(c: Connection): void {
  if (!c.scopes.includes(oauthScope))
    fail('INSUFFICIENT_SCOPE', 'Reconnect Business Profile with business.manage.', {}, 403);
}
const read = (p: CompiledRequest): Read => ({
  ...p,
  action: 'gmb_location_ops/GET_LOCATION',
  method: 'GET',
  path: p.path,
  query: {readMask},
  body: undefined,
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  responseControls: undefined,
  specialTransport: undefined,
  businessLocationEditRead: true,
});
/** The validated edit and its read of the same location, for the selected location grant. */
export function authorizeBusinessLocationEdit(p: CompiledRequest, c: Connection, id: string): boolean {
  if (businessLocationEditKind(p)) {
    assertBusinessLocationEdit(p);
    assertBusinessLocationEditScope(c);
    if (p.accountId !== id) fail('ACCOUNT_SCOPE_MISMATCH', 'Select this exact location grant.', {}, 403);
    return true;
  }
  if (
    p.gateway !== gateway ||
    !(p as Read).businessLocationEditRead ||
    p.method !== 'GET' ||
    !p.readOnly ||
    p.origin !== origin ||
    p.path !== '/v1/' + id ||
    p.query.readMask !== readMask ||
    Object.keys(p.query).length !== 1
  )
    return false;
  assertBusinessLocationEditScope(c);
  return true;
}
export function businessLocationEditSnapshots(p: CompiledRequest): Read[] {
  return [read(p)];
}
export function isBusinessLocationEditRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).businessLocationEditRead;
}
const time = (v: unknown) => (obj(v) ? {hours: Number(v.hours ?? 0), minutes: Number(v.minutes ?? 0)} : null);
const periodView = (p: JsonObject) => ({
  openDay: p.openDay,
  openTime: time(p.openTime),
  closeDay: p.closeDay,
  closeTime: time(p.closeTime),
});
const specialView = (p: JsonObject) => ({
  startDate: p.startDate ?? null,
  endDate: p.endDate ?? p.startDate ?? null,
  closed: p.closed === true,
  openTime: p.closed === true ? null : time(p.openTime),
  closeTime: p.closed === true ? null : time(p.closeTime),
});
/** The edited fields in one comparable form: omitted zero times as 00:00, an absent special end as its start. */
function view(d: JsonObject): JsonObject {
  const order = (a: JsonObject, b: JsonObject) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  return {
    regularHours:
      obj(d.regularHours) && Array.isArray(d.regularHours.periods)
        ? (d.regularHours.periods as JsonObject[]).map(periodView).sort(order)
        : [],
    specialHours:
      obj(d.specialHours) && Array.isArray(d.specialHours.specialHourPeriods)
        ? (d.specialHours.specialHourPeriods as JsonObject[]).map(specialView).sort(order)
        : [],
    phoneNumbers: obj(d.phoneNumbers)
      ? {
          primaryPhone: d.phoneNumbers.primaryPhone ?? null,
          additionalPhones: Array.isArray(d.phoneNumbers.additionalPhones) ? d.phoneNumbers.additionalPhones : [],
        }
      : {primaryPhone: null, additionalPhones: []},
    websiteUri: d.websiteUri ?? null,
    labels: Array.isArray(d.labels) ? [...d.labels].sort() : [],
    adPhone: obj(d.adWordsLocationExtensions) ? (d.adWordsLocationExtensions.adPhone ?? null) : null,
  };
}
export async function readBusinessLocationEdits(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  if (!(p as Read).businessLocationEditRead) return request(p);
  const r = await request({...(p as Read), businessLocationEditRead: undefined} as Read),
    d = r.data;
  if (r.status !== 200 || !obj(d) || d.error) unverified('Business Profile did not return the location.');
  if (d.name !== locationOf(p)) fail('STATE_TARGET_MISMATCH', 'Business Profile returned another location.', {}, 409);
  const meta = obj(d.metadata) ? d.metadata : {};
  return {
    status: 200,
    headers: {},
    data: {
      location: {
        name: d.name,
        title: d.title ?? null,
        open: obj(d.openInfo) ? (d.openInfo.status ?? null) : null,
        voiceOfMerchant: meta.hasVoiceOfMerchant === true,
        ...view(d),
      },
    },
  };
}
export function validateBusinessLocationEditState(p: CompiledRequest, r: TransportResult): void {
  const d = r.data;
  if (!(p as Read).businessLocationEditRead || r.status !== 200 || !obj(d) || !obj(d.location))
    unverified('Missing verified location state.');
}
const expectedOf = (p: CompiledRequest): JsonObject => {
  const b = body(p),
    v = view(b),
    out: JsonObject = {};
  for (const k of maskOf(p))
    if (k === 'adWordsLocationExtensions') out.adPhone = v.adPhone;
    else out[k] = v[k];
  return out;
};
export function businessLocationEditPrerequisites(p: CompiledRequest, states: unknown[]): void {
  if (!businessLocationEditKind(p)) return;
  const s = states[0],
    l = obj(s) && obj(s.location) ? s.location : unverified('Missing verified location state.');
  if (l.voiceOfMerchant !== true)
    invalid(
      'The listing has no Voice of Merchant, so Business Profile would not apply edits; check locations.getVoiceOfMerchantState first.',
    );
  if (l.open === 'CLOSED_PERMANENTLY')
    invalid('The location is closed permanently; its hours and contact details no longer change here.');
  const b = body(p);
  if (
    b.specialHours !== undefined &&
    b.regularHours === undefined &&
    !(Array.isArray(l.regularHours) && l.regularHours.length)
  )
    invalid('Special hours need regular hours; set regularHours in the same edit.');
  const want = expectedOf(p);
  if (Object.entries(want).every(([k, v]) => JSON.stringify(l[k]) === JSON.stringify(v)))
    invalid('The location already has these values.');
}
export function businessLocationEditImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  if (!businessLocationEditKind(p)) return;
  const first = state[0],
    l = obj(first) && obj(first.location) ? first.location : {},
    mask = maskOf(p);
  const shown = mask.filter(k => k !== 'labels' && k !== 'adWordsLocationExtensions');
  return {
    provider: 'google_business',
    scope: 'location',
    operation: 'update',
    location: {name: locationOf(p), title: l.title ?? null},
    fields: mask,
    may_affect_serving: mask.includes('labels') || mask.includes('adWordsLocationExtensions'),
    effect:
      (shown.length
        ? 'Changes what the public listing shows (' +
          shown.join(', ') +
          '); Google may review the edit before it appears. '
        : '') +
      (mask.includes('labels')
        ? 'Labels are not shown to customers, but Google Ads location asset filters that use them may select other locations. '
        : '') +
      (mask.includes('adWordsLocationExtensions')
        ? 'The Ads phone replaces the primary phone in Google Ads location assets.'
        : ''),
    verification: 'Reads the location again and compares the edited fields.',
    source: 'https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations/patch',
  };
}
export function businessLocationEditOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const d = r.data;
  return r.status === 200 && obj(d) && !d.error && d.name === locationOf(p);
}
export function businessLocationEditVerification(
  p: CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  return [{read: read(p), expected: {location: expectedOf(p)}, id: locationOf(p)}];
}
export function businessLocationEditObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {location: obj(data.location) ? data.location : null};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const businessLocationEditFamily: ReviewedFamily = {
  name: 'google_business_location_edits',
  files: ['src/google-business-location-edits.ts', ['tests/google-business-location-edits.test.mjs']],
  kind: businessLocationEditKind,
  assert: assertBusinessLocationEdit,
  authorize: authorizeBusinessLocationEdit,
  snapshots: businessLocationEditSnapshots,
  isRead: isBusinessLocationEditRead,
  reader: readBusinessLocationEdits,
  validateState: validateBusinessLocationEditState,
  prerequisites: businessLocationEditPrerequisites,
  impact: businessLocationEditImpact,
  outcome: businessLocationEditOutcome,
  verification: businessLocationEditVerification,
  observed: businessLocationEditObserved,
  exemptFromSpendTextMatch: true,
};
