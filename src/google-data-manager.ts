import {MirrorError} from './errors.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily, Verified, Verification} from './reviewed-family.js';
import {googleAdsCustomers} from './google-version.js';
import {assertNoMethodOverride} from './write-common.js';
import {dataManagerOrigin} from './google-data-manager-routes.js';
import {
  fail as personalFail,
  normalizeGoogleEmail,
  normalizeGooglePhone,
  reviewedRows,
  type Direction,
  type PersonalDataRecord,
  type PersonalDataSpec,
  type Row,
} from './personal-data.js';

/**
 * Google Customer Match and offline conversions through the Data Manager API, which the owner opened on 2026-09-30
 * ("Confirm on google": the datamanager OAuth scope, and the uploader's own confirmation of Google's Customer Match terms
 * sent as the request's terms field). Google's references (read 2026-09-30): audienceMembers:ingest ("At most 10000
 * AudienceMember resources"; termsOfService "must be accepted when ingesting UserData"; request-level consent),
 * audienceMembers:remove, events:ingest ("At most 2000 Event resources"), requestStatus:retrieve (per destination:
 * SUCCESS, PROCESSING, FAILED or PARTIAL_SUCCESS, with record counts), Destination (operatingAccount,
 * productDestinationId "a Google Ads audience ID ... or a Google Ads conversion action ID", loginAccount), and the
 * formatting guide. The list or conversion action is read first through the Google Ads API: a Customer Match list
 * (CRM_BASED, contact information, editable) or an enabled UPLOAD_CLICKS conversion action of the selected customer.
 */
type Kind = 'add' | 'remove' | 'events';
type Read = CompiledRequest & {dataManagerRead?: 'status'};
const gateway = 'google_ads_native_action',
  source = 'https://developers.google.com/data-manager/api/reference/rest',
  datamanager = 'https://www.googleapis.com/auth/datamanager',
  adwords = 'https://www.googleapis.com/auth/adwords',
  statusMarker = 'AMCP_DATA_MANAGER_STATUS_READ',
  stateMarker = 'AMCP_DATA_MANAGER_STATE_READ',
  numeric = /^[1-9][0-9]{0,18}$/,
  day = 86400;
const routes: Record<string, [Kind, string]> = {
  DATA_MANAGER_INGEST_AUDIENCE_MEMBERS: ['add', '/v1/audienceMembers:ingest'],
  DATA_MANAGER_REMOVE_AUDIENCE_MEMBERS: ['remove', '/v1/audienceMembers:remove'],
  DATA_MANAGER_INGEST_EVENTS: ['events', '/v1/events:ingest'],
};
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
function invalid(message: string): never {
  return fail('INVALID_GOOGLE_DATA_MANAGER', message, {source});
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function dataManagerKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.origin !== dataManagerOrigin || p.method !== 'POST' || p.specialTransport) return;
  const r = routes[p.action];
  return r && p.path === r[1] ? r[0] : undefined;
}
const customer = (p: CompiledRequest) => String(p.accountId ?? '').replaceAll('-', '');
const record = (p: CompiledRequest) => p.personalData as PersonalDataRecord | undefined;
const settingsOf = (p: CompiledRequest) => (record(p)?.settings ?? {}) as JsonObject;

/** Google's consent fields, from the uploader, never defaulted (personal-data policy, rule 4). */
function consent(v: unknown): JsonObject {
  const map: Record<string, string> = {GRANTED: 'CONSENT_GRANTED', DENIED: 'CONSENT_DENIED'};
  if (
    !object(v) ||
    Object.keys(v).sort().join() !== 'ad_personalization,ad_user_data' ||
    !map[String(v.ad_user_data)] ||
    !map[String(v.ad_personalization)]
  )
    personalFail(
      'PERSONAL_DATA_CONFIRMATION_REQUIRED',
      'Give Google consent for everyone in this upload: consent: {ad_user_data, ad_personalization}, each GRANTED or DENIED, from the consent the people gave. AMCP never assumes it.',
      {field: 'consent'},
    );
  return {adUserData: map[String(v.ad_user_data)], adPersonalization: map[String(v.ad_personalization)]};
}
/** The request's settings: the list or conversion action, and for uploads Google's consent. Nothing else. */
function settings(p: CompiledRequest, direction: Direction): JsonObject {
  const kind = dataManagerKind(p)!,
    b = object(p.body) ? p.body : {},
    target = kind === 'events' ? 'conversion_action_id' : 'user_list_id',
    allowed = direction === 'add' ? [target, 'consent'] : [target];
  const extra = Object.keys(b).filter(k => !allowed.includes(k));
  if (extra.length)
    invalid('This request takes ' + allowed.join(' and ') + ' in its payload; unqualified: ' + extra.join(', ') + '.');
  if (typeof b[target] !== 'string' || !numeric.test(b[target]))
    invalid(
      target + ' is the numeric ID of the ' + (kind === 'events' ? 'conversion action' : 'Customer Match list') + '.',
    );
  return {[target]: b[target], ...(direction === 'add' ? {consent: consent(b.consent)} : {})};
}
const destination = (p: CompiledRequest, id: unknown) => ({
  operatingAccount: {accountType: 'GOOGLE_ADS', accountId: customer(p)},
  productDestinationId: String(id),
});
const identifiers = (r: Row, schema: string[]) => {
  const out: JsonObject[] = [],
    email = r[schema.indexOf('EMAIL')],
    phone = r[schema.indexOf('PHONE')];
  if (email) out.push({emailAddress: email});
  if (phone) out.push({phoneNumber: phone});
  return out;
};

/** Customer Match: EMAIL and PHONE in Google's formatting, at most 10,000 people per request. */
export const googleCustomerMatchPeople: PersonalDataSpec = {
  platform: 'Google',
  actions: [gateway + ' DATA_MANAGER_INGEST_AUDIENCE_MEMBERS', gateway + ' DATA_MANAGER_REMOVE_AUDIENCE_MEMBERS'],
  keys: {EMAIL: normalizeGoogleEmail, PHONE: normalizeGooglePhone},
  maxRows: 10000,
  direction: p => {
    const k = dataManagerKind(p);
    return k === 'add' ? 'add' : k === 'remove' ? 'remove' : undefined;
  },
  settings,
  body(p, rows) {
    const r = record(p)!,
      s = settingsOf(p);
    return {
      destinations: [destination(p, s.user_list_id)],
      audienceMembers: rows.map(row => ({userData: {userIdentifiers: identifiers(row, r.schema)}})),
      encoding: 'HEX',
      ...(r.direction === 'add'
        ? {
            consent: s.consent,
            // The uploader confirmed that Google's Customer Match terms were accepted (platform_terms_confirmed, required
            // for every upload); AMCP sends that confirmation and never sets it on its own (owner decision, 2026-09-30).
            termsOfService: {customerMatchTermsOfServiceStatus: 'ACCEPTED'},
          }
        : {}),
    };
  },
};

const clickId = /^[A-Za-z0-9_-]{10,500}$/,
  sources = ['WEB', 'IN_STORE', 'PHONE', 'MESSAGE', 'OTHER'];
const optional = (check: (v: unknown) => boolean) => (v: unknown) =>
  v === undefined || v === null ? null : check(v) ? (v as string | number) : undefined;
const fields = {
  gclid: optional(v => typeof v === 'string' && clickId.test(v)),
  gbraid: optional(v => typeof v === 'string' && clickId.test(v)),
  wbraid: optional(v => typeof v === 'string' && clickId.test(v)),
  event_time: (v: unknown) => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : undefined),
  value: optional(v => typeof v === 'number' && Number.isFinite(v) && v >= 0),
  currency: optional(v => typeof v === 'string' && /^[A-Z]{3}$/.test(v)),
  // Sent as it is, so it may not be an e-mail address: people are only sent hashed.
  transaction_id: optional(
    v => typeof v === 'string' && v.length > 0 && v.length <= 100 && !/[\u0000-\u001f@]/.test(v),
  ),
  event_source: optional(v => typeof v === 'string' && sources.includes(v)),
};
const names = Object.keys(fields);
const field = (r: Row, name: string) => r[r.length - names.length + names.indexOf(name)]!;
function event(r: Row, schema: string[]): JsonObject {
  const f = (n: string) => field(r, n),
    ids = identifiers(r, schema),
    click = ['gclid', 'gbraid', 'wbraid'].find(n => f(n) !== null);
  return {
    eventTimestamp: new Date((f('event_time') as number) * 1000).toISOString(),
    ...(f('transaction_id') !== null ? {transactionId: f('transaction_id')} : {}),
    ...(ids.length ? {userData: {userIdentifiers: ids}} : {}),
    ...(click ? {adIdentifiers: {[click]: f(click)}} : {}),
    ...(f('value') !== null ? {conversionValue: f('value'), currency: f('currency')} : {}),
    ...(f('event_source') !== null ? {eventSource: f('event_source')} : {}),
  };
}
/** Offline conversions: one event per row, by hashed email or phone or by click ID, at most 2,000 per request. */
export const googleOfflineConversionPeople: PersonalDataSpec = {
  platform: 'Google',
  actions: [gateway + ' DATA_MANAGER_INGEST_EVENTS'],
  keys: {EMAIL: normalizeGoogleEmail, PHONE: normalizeGooglePhone},
  maxRows: 2000,
  direction: p => (dataManagerKind(p) === 'events' ? 'add' : undefined),
  settings,
  fields,
  identifiers: ['gclid', 'gbraid', 'wbraid', 'transaction_id'],
  keysOptional: true,
  row(f, hasKey) {
    const clicks = ['gclid', 'gbraid', 'wbraid'].filter(n => f[n] !== null).length;
    if (clicks > 1) return 'more_than_one_click_id';
    if (!clicks && !hasKey) return 'no_person_or_click';
    if (f.value !== null && f.currency === null) return 'value_without_currency';
    if (f.value === null && f.currency !== null) return 'currency_without_value';
  },
  check(rows, now) {
    const seconds = Math.floor(now / 1000),
      future = rows.filter(r => (field(r, 'event_time') as number) > seconds + 300).length,
      old = rows.filter(r => (field(r, 'event_time') as number) < seconds - 90 * day).length;
    if (future)
      personalFail('PERSONAL_DATA_INVALID', future + ' events are in the future; event_time is when each happened.', {
        events: future,
      });
    if (old)
      personalFail(
        'PERSONAL_DATA_INVALID',
        old +
          ' events are older than 90 days, the longest click-through window a Google Ads conversion action takes; Google refuses them as too old.',
        {events: old},
      );
  },
  summarize(rows) {
    const value: Record<string, number> = {},
      sources: Record<string, number> = {};
    let clicks = 0,
      earliest = Infinity,
      latest = 0;
    for (const r of rows) {
      if (['gclid', 'gbraid', 'wbraid'].some(n => field(r, n) !== null)) clicks++;
      const src = String(field(r, 'event_source') ?? 'unspecified');
      sources[src] = (sources[src] ?? 0) + 1;
      if (field(r, 'value') !== null) {
        const c = String(field(r, 'currency'));
        value[c] = Math.round(((value[c] ?? 0) + (field(r, 'value') as number)) * 100) / 100;
      }
      earliest = Math.min(earliest, field(r, 'event_time') as number);
      latest = Math.max(latest, field(r, 'event_time') as number);
    }
    return {
      value: Object.fromEntries(Object.entries(value).sort()),
      event_sources: Object.fromEntries(Object.entries(sources).sort()),
      with_click_id: clicks,
      earliest: new Date(earliest * 1000).toISOString(),
      latest: new Date(latest * 1000).toISOString(),
    };
  },
  body(p, rows) {
    const r = record(p)!,
      s = settingsOf(p);
    return {
      destinations: [destination(p, s.conversion_action_id)],
      events: rows.map(row => event(row, r.schema)),
      consent: s.consent,
      encoding: 'HEX',
    };
  },
};

/** The rows back from a body, to check them against the review's digest. */
function rowsOf(p: CompiledRequest, b: JsonObject): Row[] | undefined {
  const r = record(p)!,
    list = dataManagerKind(p) === 'events' ? b.events : b.audienceMembers;
  if (!Array.isArray(list)) return undefined;
  const out: Row[] = [];
  for (const x of list) {
    if (!object(x)) return undefined;
    const ids = (
        object(x.userData) && Array.isArray(x.userData.userIdentifiers) ? x.userData.userIdentifiers : []
      ) as JsonObject[],
      key = (k: string) => String(ids.find(i => object(i) && i[k] !== undefined)?.[k] ?? '');
    const people = r.schema.map(k => (k === 'EMAIL' ? key('emailAddress') : key('phoneNumber')));
    if (dataManagerKind(p) !== 'events') {
      out.push(people);
      continue;
    }
    const a = object(x.adIdentifiers) ? x.adIdentifiers : {},
      time = Date.parse(String(x.eventTimestamp)) / 1000;
    out.push([
      ...people,
      (a.gclid as string) ?? null,
      (a.gbraid as string) ?? null,
      (a.wbraid as string) ?? null,
      time,
      x.conversionValue === undefined ? null : (x.conversionValue as number),
      x.currency === undefined ? null : (x.currency as string),
      x.transactionId === undefined ? null : (x.transactionId as string),
      x.eventSource === undefined ? null : (x.eventSource as string),
    ]);
  }
  return out;
}
/** The request as AMCP builds it from the reviewed people and settings, nothing else. */
export function assertDataManager(p: CompiledRequest): void {
  const kind = dataManagerKind(p);
  if (!kind) return;
  assertNoMethodOverride(p);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Data Manager writes take their parameters in the body, without query or header overrides.');
  const r = record(p);
  if (!r)
    fail(
      'PERSONAL_DATA_REQUIRED',
      'Send the people in people, beside arguments: AMCP hashes them in memory and builds the request.',
    );
  const spec = kind === 'events' ? googleOfflineConversionPeople : googleCustomerMatchPeople,
    b = object(p.body) ? p.body : undefined,
    expected = b ? spec.body(p, []) : undefined,
    list = kind === 'events' ? 'events' : 'audienceMembers';
  if (
    !b ||
    !expected ||
    Object.keys(b).sort().join() !== Object.keys(expected).sort().join() ||
    JSON.stringify({...b, [list]: []}) !== JSON.stringify(expected) ||
    !reviewedRows(r, rowsOf(p, b))
  )
    fail('PERSONAL_DATA_CHANGED', 'The request body is not the one AMCP built from the reviewed people.');
}
/** Both scopes: datamanager for the write and its status, adwords for the reads of the list or action. */
export function assertDataManagerScope(c: Connection): void {
  const missing = [adwords, datamanager].filter(s => !c.scopes.includes(s));
  if (missing.length)
    fail(
      'INSUFFICIENT_SCOPE',
      'Reconnect Google granting ' +
        missing.map(s => s.split('/').pop()).join(' and ') +
        ': Customer Match and offline conversions go through Google’s Data Manager API, which the owner enables in the Google Cloud project.',
      {required: missing},
      403,
    );
}
function stateRead(p: CompiledRequest, query: string): Read {
  return {
    ...p,
    origin: undefined,
    personalData: undefined,
    action: stateMarker,
    method: 'POST',
    path: googleAdsCustomers + customer(p) + '/googleAds:search',
    body: {query},
    query: {},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
  };
}
const queries = (p: CompiledRequest): string[] => {
  const s = settingsOf(p),
    c = 'SELECT customer.id, customer.manager FROM customer LIMIT 1';
  return dataManagerKind(p) === 'events'
    ? [
        c,
        'SELECT conversion_action.resource_name, conversion_action.id, conversion_action.name, conversion_action.type, conversion_action.status, conversion_action.owner_customer FROM conversion_action WHERE conversion_action.id = ' +
          s.conversion_action_id,
      ]
    : [
        c,
        'SELECT user_list.resource_name, user_list.id, user_list.name, user_list.type, user_list.read_only, user_list.membership_status, user_list.crm_based_user_list.upload_key_type FROM user_list WHERE user_list.id = ' +
          s.user_list_id,
      ];
};
export function dataManagerSnapshots(p: CompiledRequest): Read[] {
  return queries(p).map(q => stateRead(p, q));
}
const rowsFrom = (r: TransportResult, key: string): JsonObject[] => {
  if (r.status !== 200 || !object(r.data) || (r.data.results !== undefined && !Array.isArray(r.data.results)))
    unverified('Google did not answer the state read.');
  return ((r.data.results ?? []) as JsonObject[]).map(x => (object(x) && object(x[key]) ? x[key] : {}));
};
/** The customer and the list or conversion action, as the review keeps them: no sizes, which change on their own. */
export async function readDataManagerState(
  p: CompiledRequest,
  read: (q: CompiledRequest) => Promise<TransportResult>,
): Promise<unknown[]> {
  const [c, t] = dataManagerSnapshots(p);
  const cust = rowsFrom(await read(c!), 'customer');
  if (cust.length !== 1 || String(cust[0]!.id) !== customer(p))
    unverified('Google did not return the selected customer.');
  const out: JsonObject = {customer: customer(p), manager: cust[0]!.manager === true};
  if (dataManagerKind(p) === 'events') {
    const rows = rowsFrom(await read(t!), 'conversionAction');
    out.target =
      rows.length === 1
        ? {
            present: true,
            resource: rows[0]!.resourceName ?? null,
            name: rows[0]!.name ?? null,
            type: rows[0]!.type ?? null,
            status: rows[0]!.status ?? null,
            owner: rows[0]!.ownerCustomer ?? null,
          }
        : {present: false};
  } else {
    const rows = rowsFrom(await read(t!), 'userList');
    out.target =
      rows.length === 1
        ? {
            present: true,
            resource: rows[0]!.resourceName ?? null,
            name: rows[0]!.name ?? null,
            type: rows[0]!.type ?? null,
            read_only: rows[0]!.readOnly === true,
            membership: rows[0]!.membershipStatus ?? null,
            upload_key: object(rows[0]!.crmBasedUserList) ? (rows[0]!.crmBasedUserList.uploadKeyType ?? null) : null,
          }
        : {present: false};
  }
  prerequisites(p, out);
  return [out];
}
function prerequisites(p: CompiledRequest, s: JsonObject): void {
  const kind = dataManagerKind(p)!,
    t = object(s.target) ? s.target : {},
    set = settingsOf(p);
  if (s.manager === true) invalid('Select the client account itself: a manager account holds no lists or conversions.');
  if (kind === 'events') {
    if (
      t.present !== true ||
      t.resource !== 'customers/' + customer(p) + '/conversionActions/' + set.conversion_action_id ||
      t.owner !== 'customers/' + customer(p)
    )
      fail(
        'STATE_TARGET_MISMATCH',
        'Conversion action ' + set.conversion_action_id + ' is not an action of customer ' + customer(p) + '.',
        {},
        403,
      );
    if (t.type !== 'UPLOAD_CLICKS')
      invalid(
        'Conversion action ' +
          set.conversion_action_id +
          ' is ' +
          String(t.type) +
          '; offline conversions go to an UPLOAD_CLICKS (import) action.',
      );
    if (t.status !== 'ENABLED')
      invalid('Conversion action ' + set.conversion_action_id + ' is ' + String(t.status) + ', not ENABLED.');
    return;
  }
  if (t.present !== true || t.resource !== 'customers/' + customer(p) + '/userLists/' + set.user_list_id)
    fail(
      'STATE_TARGET_MISMATCH',
      'User list ' + set.user_list_id + ' is not a list of customer ' + customer(p) + '.',
      {},
      403,
    );
  if (t.type !== 'CRM_BASED' || t.upload_key !== 'CONTACT_INFO')
    invalid(
      'User list ' +
        set.user_list_id +
        ' is not a Customer Match list of contact information (CRM_BASED, CONTACT_INFO).',
    );
  if (t.read_only === true) invalid('User list ' + set.user_list_id + ' is read-only for this account.');
  if (kind === 'add' && t.membership !== 'OPEN')
    invalid('User list ' + set.user_list_id + ' is closed; only open lists take people.');
}
export function dataManagerImpact(p: CompiledRequest, state: unknown[]): JsonObject {
  const kind = dataManagerKind(p)!,
    s = object(state[0]) ? state[0] : {},
    t = object(s.target) ? s.target : {},
    r = record(p)!,
    set = settingsOf(p);
  const common = {
    provider: 'google',
    people: r.counts,
    kept: 'AMCP keeps the counts and one digest of the hashed batch, never the people.',
    source,
  };
  if (kind === 'events')
    return {
      ...common,
      effect:
        'Sends ' +
        r.counts.sent +
        ' offline conversions to "' +
        t.name +
        '" (' +
        set.conversion_action_id +
        ') of customer ' +
        customer(p) +
        ' through the Data Manager API.',
      events: r.summary ?? null,
      consent: set.consent,
      confirmations: r.confirmations ?? null,
      recall: 'A conversion cannot be recalled once Google has received it: Google uses it for reporting and bidding.',
      approval: 'Only the workspace owner executes this upload: an operator prepares it.',
      verification: 'Reads the request status: Google’s count of the events it processed and the errors it counted.',
    };
  return {
    ...common,
    effect:
      (kind === 'add' ? 'Adds' : 'Removes') +
      ' up to ' +
      r.counts.sent +
      ' people, hashed with SHA-256, ' +
      (kind === 'add' ? 'to' : 'from') +
      ' Customer Match list "' +
      t.name +
      '" (' +
      set.user_list_id +
      ') of customer ' +
      customer(p) +
      ' through the Data Manager API.',
    ...(kind === 'add'
      ? {
          consent: set.consent,
          confirmations: r.confirmations ?? null,
          terms:
            'The request tells Google its Customer Match terms were accepted, because the uploader confirmed it (platform_terms_confirmed); AMCP never states it on its own.',
          approval: 'Only the workspace owner executes this upload: an operator prepares it.',
          removal: 'People are removed with DATA_MANAGER_REMOVE_AUDIENCE_MEMBERS.',
        }
      : {approval: 'An operator may run a removal: it only reduces what Google holds.'}),
    verification: 'Reads the request status: Google’s count of the records it processed and the match rate range.',
  };
}
const requestIdOf = (d: unknown) =>
  object(d) && typeof d.requestId === 'string' && /^[\w-]{1,200}$/.test(d.requestId) ? d.requestId : undefined;
export function dataManagerOutcome(_p: CompiledRequest, r: TransportResult): boolean {
  return r.status === 200 && !!requestIdOf(r.data);
}
/** Google's reply as it is kept: the request ID, and how many field warnings it gave. */
export function dataManagerSafeOutcome(outcome: JsonObject): JsonObject {
  if (!object(outcome.data)) return outcome;
  const d = outcome.data;
  return {
    ...outcome,
    data: {
      ...(requestIdOf(d) ? {requestId: d.requestId} : {}),
      ...(Array.isArray(d.fieldWarnings) && d.fieldWarnings.length ? {field_warnings: d.fieldWarnings.length} : {}),
    },
  };
}
function statusRead(p: CompiledRequest, requestId: string): Read {
  return {
    ...p,
    origin: dataManagerOrigin,
    personalData: undefined,
    dataManagerRead: 'status',
    action: statusMarker,
    method: 'GET',
    path: '/v1/requestStatus:retrieve',
    query: {requestId},
    body: undefined,
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
  };
}
export function isDataManagerRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).dataManagerRead;
}
/** The writes after validation, and the status read of a request: the only Data Manager read AMCP makes. */
export function authorizeDataManager(p: CompiledRequest, c: Connection, selected: string): boolean {
  if (dataManagerKind(p)) {
    assertDataManager(p);
    assertDataManagerScope(c);
    if (customer(p) !== selected.replaceAll('-', ''))
      fail(
        'ACCOUNT_SCOPE_MISMATCH',
        'Select the Google Ads customer the list or conversion action belongs to.',
        {},
        403,
      );
    return true;
  }
  if (p.gateway !== gateway || p.action !== statusMarker) return false;
  if (
    (p as Read).dataManagerRead === 'status' &&
    p.origin === dataManagerOrigin &&
    p.method === 'GET' &&
    p.readOnly &&
    p.body === undefined &&
    p.path === '/v1/requestStatus:retrieve' &&
    Object.keys(p.query).join() === 'requestId' &&
    typeof p.query.requestId === 'string' &&
    /^[\w-]{1,200}$/.test(p.query.requestId) &&
    customer(p) === selected.replaceAll('-', '')
  ) {
    assertDataManagerScope(c);
    return true;
  }
  return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal Data Manager read.', {}, 403);
}
/** Verification by Google's own counts for the request, per its status: never the people. */
async function verifyDataManager(p: CompiledRequest, v: Verification): Promise<Verified> {
  const r = record(p)!,
    id = requestIdOf(v.result.data);
  if (!id) return {status: 'unverified', checks: [{status: 'unverified', reason: 'The receipt names no request ID.'}]};
  const read = v.guarded('Data Manager verification must remain read-only.', {check: assertDataManagerScope});
  const res = await read(statusRead(p, id)),
    d = res.data;
  const row =
    res.status === 200 &&
    object(d) &&
    Array.isArray(d.requestStatusPerDestination) &&
    object(d.requestStatusPerDestination[0])
      ? (d.requestStatusPerDestination[0] as JsonObject)
      : undefined;
  if (!row)
    return {
      status: 'unverified',
      checks: [{request_id: id, status: 'unverified', reason: 'Google returned no status for the request.'}],
    };
  const state = String(row.requestStatus);
  if (state === 'PROCESSING')
    return {
      status: 'pending',
      checks: [
        {
          request_id: id,
          status: 'pending',
          provider_status: state,
          note: 'Google is still processing the request; verify again later.',
        },
      ],
    };
  const kind = dataManagerKind(p)!,
    counts =
      kind === 'events'
        ? object(row.eventsIngestionStatus)
          ? row.eventsIngestionStatus
          : {}
        : kind === 'add'
          ? object(row.audienceMembersIngestionStatus) &&
            object(row.audienceMembersIngestionStatus.userDataIngestionStatus)
            ? row.audienceMembersIngestionStatus.userDataIngestionStatus
            : {}
          : object(row.audienceMembersRemovalStatus) && object(row.audienceMembersRemovalStatus.userDataRemovalStatus)
            ? row.audienceMembersRemovalStatus.userDataRemovalStatus
            : {};
  const received = counts.recordCount === undefined ? null : Number(counts.recordCount),
    errors =
      object(row.errorInfo) && Array.isArray(row.errorInfo.errorCounts)
        ? Object.fromEntries(
            (row.errorInfo.errorCounts as JsonObject[])
              .filter(object)
              .map(e => [String(e.reason), Number(e.recordCount ?? 0)]),
          )
        : {};
  const complete = state === 'SUCCESS' && received === r.counts.sent,
    status = complete ? 'verified' : state === 'FAILED' ? 'failed' : 'unverified';
  return {
    status,
    checks: [
      {
        request_id: id,
        status,
        provider_status: state,
        sent: r.counts.sent,
        received,
        ...(counts.uploadMatchRateRange ? {match_rate: counts.uploadMatchRateRange} : {}),
        ...(Object.keys(errors).length ? {errors} : {}),
        verification_scope: 'Google’s counts for this request; the people are never read back',
        ...(complete
          ? {}
          : {reason: 'Google reports ' + state + ' with ' + received + ' of the ' + r.counts.sent + ' records sent.'}),
      },
    ],
  };
}
const common = {
  assert: (plan: CompiledRequest) => assertDataManager(plan),
  scope: (c: Connection) => assertDataManagerScope(c),
  authorize: authorizeDataManager,
  snapshots: dataManagerSnapshots,
  state: (plan: CompiledRequest, readers: Parameters<NonNullable<ReviewedFamily['state']>>[1]) =>
    readDataManagerState(
      plan,
      readers.guarded(
        'Data Manager prerequisites must remain read-only.',
        readers.sameLogin('The selected login changed during the list or action checks. Prepare again.'),
      ).read,
    ),
  stateAsRead: true,
  impact: dataManagerImpact,
  outcome: dataManagerOutcome,
  safeOutcome: (outcome: JsonObject) => dataManagerSafeOutcome(outcome),
  verify: (plan: CompiledRequest, v: Verification) => verifyDataManager(plan, v),
  retryReadAfterMs: 60000,
  verifyEveryTime: true,
  exemptFromSpendTextMatch: true,
  exemptFromActivationScan: true,
  activates: () => false,
  destructive: () => false,
};
/** Registers the Customer Match family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const googleCustomerMatchFamily: ReviewedFamily = {
  name: 'google_customer_match',
  files: ['src/google-data-manager.ts', ['tests/google-data-manager.test.mjs']],
  kind: p => {
    const k = dataManagerKind(p);
    return k === 'add' || k === 'remove' ? k : undefined;
  },
  ...common,
  personalData: googleCustomerMatchPeople,
};
/** Registers the offline conversions family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const googleOfflineConversionFamily: ReviewedFamily = {
  name: 'google_offline_conversions',
  files: ['src/google-data-manager.ts', ['tests/google-data-manager.test.mjs']],
  kind: p => dataManagerKind(p) === 'events',
  ...common,
  personalData: googleOfflineConversionPeople,
};
