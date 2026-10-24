import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily, Verified} from './reviewed-family.js';
import {metaPrefix, metaRoute} from './meta-version.js';
import {assertNoMethodOverride} from './write-common.js';
import {optionalMetaRead} from './meta-catalogs.js';
import {
  normalizeEmail,
  normalizePhone,
  reviewedRows,
  type PersonalDataRecord,
  type PersonalDataSpec,
} from './personal-data.js';
import {fail, readOf} from './family-kit.js';

/**
 * Meta customer lists (customer-file custom audiences) under the personal-data policy the owner approved on
 * 2026-09-30. Meta's references (read 2026-09-30):
 * - "Custom Audience Users": POST and DELETE /{custom_audience_id}/users with payload {schema, data} and session;
 *   "only a maximum of 10000 at a time"; changes "usually take up to 24 hours"; the reply's num_received,
 *   num_invalid_entries and invalid_entry_samples (up to 100 samples of the values sent); a list flagged with
 *   operation_status 471 cannot be updated.
 * - "Customer File Custom Audiences": subtype CUSTOM with customer_file_source; EMAIL "Trim leading and trailing white
 *   space, and convert all characters to lowercase"; PHONE digits with the country code; schema EMAIL_SHA256 with
 *   data [["<HASHED_DATA>"], ...], or a multi-key array.
 * - "Custom Audience Terms Of Service": act_{id}?fields=tos_accepted, custom_audience_tos 1 when signed; "The API does
 *   not allow you to create or change Custom Audiences if the terms have not been accepted."
 * - CustomAudience reference: delivery_status 300 "smaller than it should be ... cannot be used"; is_value_based.
 *
 * AMCP creates an empty customer list, adds people and removes them, up to 10,000 per request. It reads the ad
 * account's terms and the list first: a list of the selected account, subtype CUSTOM, not value-based, and not
 * flagged, being replaced or orphaned. Value-based lists (a LOOKALIKE_VALUE column) and replacing a whole list
 * (usersreplace, a session of up to 90 minutes) stay outside.
 */
type Kind = 'list' | 'add' | 'remove';
type State = {kind: Kind; audience?: string; verify?: boolean};
type Read = CompiledRequest & {metaListState?: State};
const gateway = 'meta_native_action',
  marker = 'AMCP_META_CUSTOMER_LIST_READ',
  source = 'https://developers.facebook.com/docs/marketing-api/reference/custom-audience/users/',
  accountFields = 'id,account_id,tos_accepted',
  audienceFields = 'id,account_id,name,subtype,is_value_based,operation_status',
  listFields = 'id,account_id,name,subtype,customer_file_source,description',
  countFields =
    'id,account_id,approximate_count_lower_bound,approximate_count_upper_bound,delivery_status,operation_status',
  // Replacing (414), an inactive owning account (470) and an integrity flag (471) stop changes to the people.
  blockedCodes: Record<number, string> = {
    414: 'a replacement of its people is in progress',
    470: 'the ad account that created it is no longer active',
    471: 'Meta flagged it for integrity reasons; resolve the restriction in Audience Manager first',
  },
  sources = ['USER_PROVIDED_ONLY', 'PARTNER_PROVIDED_ONLY', 'BOTH_USER_AND_PARTNER_PROVIDED'];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const account = (v: unknown) => String(v ?? '').replace(/^act_/, '');
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v === v.trim() && v.length > 0 && [...v].length <= max && !/[\u0000-\u001f\u007f]/.test(v);
function invalid(message: string): never {
  return fail('INVALID_META_CUSTOMER_LIST', message, {source});
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function metaCustomerListKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.specialTransport || (p.origin && p.origin !== 'https://graph.facebook.com')) return;
  if (
    ['meta_ad_account_id_customaudiences_create', 'meta_custom_audience_create'].includes(p.action) &&
    p.method === 'POST' &&
    metaRoute('act_[1-9][0-9]{0,31}/customaudiences$').test(p.path) &&
    object(p.body) &&
    p.body.subtype === 'CUSTOM'
  )
    return 'list';
  if (p.action === 'meta_custom_audience_id_users_create' && p.method === 'POST')
    return metaRoute('[1-9][0-9]{0,31}/users$').test(p.path) ? 'add' : undefined;
  if (p.action === 'meta_custom_audience_id_users_delete' && p.method === 'DELETE')
    return metaRoute('[1-9][0-9]{0,31}/users$').test(p.path) ? 'remove' : undefined;
}
const audienceOf = (p: CompiledRequest) => p.path.split('/')[2]!;
const record = (p: CompiledRequest) => p.personalData as PersonalDataRecord | undefined;

/**
 * The people's part: EMAIL and PHONE, hashed as Meta documents. One key is sent as EMAIL_SHA256 or PHONE_SHA256 with
 * one hash per row; both keys as Meta's multi-key form, a blank for an unknown key. Each request is one session of
 * one batch, under a session id AMCP draws at prepare.
 */
export const metaCustomerListPeople: PersonalDataSpec = {
  platform: 'Meta',
  actions: [gateway + ' meta_custom_audience_id_users_create', gateway + ' meta_custom_audience_id_users_delete'],
  keys: {EMAIL: normalizeEmail, PHONE: normalizePhone},
  maxRows: 10000,
  direction: p => {
    const kind = metaCustomerListKind(p);
    return kind === 'remove' ? 'remove' : kind === 'add' ? 'add' : undefined;
  },
  body(p, rows) {
    const r = record(p)!,
      kept = object(p.body) && object(p.body.session) ? p.body.session : undefined,
      session = {
        session_id: typeof kept?.session_id === 'number' ? kept.session_id : 1 + Math.floor(Math.random() * 2 ** 52),
        batch_seq: 1,
        last_batch_flag: true,
        estimated_num_total: r.counts.sent,
      };
    const schema = r.schema.length === 1 ? r.schema[0] + '_SHA256' : r.schema;
    return {payload: {schema, data: rows}, session};
  },
};

/** The request as AMCP builds it: a customer list's fields, or the people's body with the reviewed rows. */
export function assertMetaCustomerList(p: CompiledRequest): void {
  const kind = metaCustomerListKind(p);
  if (!kind) return;
  assertNoMethodOverride(p);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Customer-list writes take their parameters in the body, without query or header overrides.');
  const b = object(p.body) ? p.body : undefined;
  if (kind === 'list') {
    const extra = Object.keys(b!).filter(k => !['name', 'description', 'subtype', 'customer_file_source'].includes(k));
    if (extra.length)
      invalid(
        'A customer list takes name, description, subtype and customer_file_source; unqualified: ' +
          extra.join(', ') +
          '.',
      );
    if (!text(b!.name, 255)) invalid('name has 1 to 255 characters without surrounding spaces or control characters.');
    if (b!.description !== undefined && (typeof b!.description !== 'string' || [...b!.description].length > 1000))
      invalid('description is text of at most 1,000 characters.');
    if (!sources.includes(String(b!.customer_file_source)))
      invalid('Name customer_file_source, how the people were collected: ' + sources.join(', ') + '.');
    return;
  }
  const r = record(p);
  if (!r)
    fail(
      'PERSONAL_DATA_REQUIRED',
      'Send the people in people, beside arguments: AMCP hashes them in memory and builds the body. Remove payload.',
    );
  const payload = b && object(b.payload) ? b.payload : undefined,
    session = b && object(b.session) ? b.session : undefined;
  if (
    !b ||
    Object.keys(b).join() !== 'payload,session' ||
    !payload ||
    Object.keys(payload).join() !== 'schema,data' ||
    !session ||
    typeof session.session_id !== 'number' ||
    session.batch_seq !== 1 ||
    session.last_batch_flag !== true ||
    session.estimated_num_total !== r.counts.sent ||
    !reviewedRows(r, payload.data)
  )
    fail('PERSONAL_DATA_CHANGED', 'The request body is not the one AMCP built from the reviewed people.');
}

const graph = (p: CompiledRequest, path: string, fields: string, s?: State): Read =>
  readOf<Read>(p, {
    before: {personalData: undefined, metaListState: s},
    action: marker,
    path: metaPrefix + path,
    query: {fields},
  });
export function metaCustomerListSnapshots(p: CompiledRequest): Read[] {
  const kind = metaCustomerListKind(p)!;
  return [
    graph(p, 'act_' + account(p.accountId), accountFields, {
      kind,
      ...(kind === 'list' ? {} : {audience: audienceOf(p)}),
    }),
  ];
}
export function isMetaCustomerListRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).metaListState;
}
/** Writes after validation, and the family's exact reads: the ad account's terms and the list. */
export function authorizeMetaCustomerList(p: CompiledRequest, c: Connection, selected: string): boolean {
  if (metaCustomerListKind(p)) {
    assertMetaCustomerList(p);
    if (!c.scopes.includes('ads_management'))
      fail(
        'INSUFFICIENT_SCOPE',
        'Customer lists need the ads_management permission.',
        {required: ['ads_management']},
        403,
      );
    if (account(p.accountId) !== selected)
      fail('ACCOUNT_SCOPE_MISMATCH', 'Select the ad account the customer list belongs to.', {}, 403);
    return true;
  }
  if (p.gateway !== gateway || p.action !== marker) return false;
  if (p.method !== 'GET' || !p.readOnly || p.body !== undefined || account(p.accountId) !== selected)
    return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal customer-list read.', {}, 403);
  const fields = Object.keys(p.query).join() === 'fields' ? String(p.query.fields) : '';
  if (p.path === metaPrefix + 'act_' + selected && fields === accountFields) return true;
  if (
    /^[1-9][0-9]{0,31}$/.test(p.path.slice(metaPrefix.length)) &&
    [audienceFields, listFields, countFields].includes(fields)
  )
    return true;
  return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal customer-list read.', {}, 403);
}
/** The terms and, for people, the list: only what the review relies on, never counts that change on their own. */
export async function readMetaCustomerLists(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).metaListState;
  if (!s) return fetch(p);
  const list = async (fields: string) => optionalMetaRead(fetch, graph(p, s.audience!, fields), 'customer list');
  if (s.verify) {
    const x = await list(s.kind === 'list' ? listFields : countFields);
    return {status: 200, headers: {}, data: {list: x ? {present: true, ...x} : {present: false}}};
  }
  const acct = await optionalMetaRead(fetch, graph(p, 'act_' + account(p.accountId), accountFields), 'ad account');
  if (!acct) unverified('Meta did not return the ad account.');
  const out: JsonObject = {
    account_id: account(p.accountId),
    terms_accepted: object(acct.tos_accepted) && Number(acct.tos_accepted.custom_audience_tos) === 1,
  };
  if (s.audience) {
    const x = await list(audienceFields);
    const code = object(x?.operation_status) ? Number(x.operation_status.code) : null;
    out.list = x
      ? {
          present: true,
          id: String(x.id),
          account_id: account(x.account_id),
          name: x.name ?? null,
          subtype: x.subtype ?? null,
          value_based: x.is_value_based === true,
          blocked: code !== null && blockedCodes[code] ? code : null,
        }
      : {present: false, id: s.audience};
  }
  return {status: 200, headers: {}, data: out};
}
export function validateMetaCustomerListState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).metaListState,
    d = r.data;
  if (!s || r.status !== 200 || !object(d) || (s.verify ? !object(d.list) : typeof d.terms_accepted !== 'boolean'))
    unverified('Missing verified customer-list state.');
}
export function metaCustomerListPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const s = object(states[0]) ? states[0] : {};
  if (s.terms_accepted !== true)
    fail(
      'PERSONAL_DATA_TERMS_NOT_ACCEPTED',
      'Meta’s Custom Audience terms are not accepted for the business of ad account ' +
        s.account_id +
        '. AMCP never accepts terms: someone with a role in the ad account accepts them in Meta, at business.facebook.com/ads/manage/customaudiences/tos/?act=' +
        s.account_id +
        ', then prepares again.',
      {account_id: s.account_id ?? null},
      403,
    );
  if (metaCustomerListKind(p) === 'list') return;
  const l = object(s.list) ? s.list : {};
  if (l.present !== true || l.account_id !== s.account_id)
    fail(
      'STATE_TARGET_MISMATCH',
      'Customer list ' + audienceOf(p) + ' is not a list of ad account ' + s.account_id + '.',
      {},
      403,
    );
  if (l.subtype !== 'CUSTOM')
    invalid(
      'List ' + l.id + ' is a ' + String(l.subtype).toLowerCase() + ' audience, not a customer list (subtype CUSTOM).',
    );
  if (l.value_based === true)
    invalid('List ' + l.id + ' is value-based: it takes a customer value with each person, which AMCP does not send.');
  if (l.blocked !== null && l.blocked !== undefined)
    invalid(
      'List ' +
        l.id +
        ' cannot change now: ' +
        blockedCodes[Number(l.blocked)] +
        ' (operation_status ' +
        l.blocked +
        ').',
    );
}
export function metaCustomerListImpact(p: CompiledRequest, states: unknown[]): JsonObject {
  const kind = metaCustomerListKind(p)!,
    s = object(states[0]) ? states[0] : {},
    l = object(s.list) ? s.list : {},
    r = record(p);
  if (kind === 'list')
    return {
      provider: 'meta',
      effect: 'Creates an empty customer list (subtype CUSTOM) in ad account ' + s.account_id + '; no people are sent.',
      next: 'Add people with meta_custom_audience_id_users_create once the owner turned personal-data writes on for the account.',
      verification: 'Reads the list back: name, subtype, customer_file_source and description.',
      source,
    };
  const list = '"' + l.name + '" (' + l.id + ')';
  return {
    provider: 'meta',
    effect:
      (kind === 'add' ? 'Adds' : 'Removes') +
      ' up to ' +
      r!.counts.sent +
      ' people, hashed with SHA-256, ' +
      (kind === 'add' ? 'to' : 'from') +
      ' customer list ' +
      list +
      '. Meta usually applies the change within about 24 hours.',
    people: r!.counts,
    ...(kind === 'add'
      ? {
          confirmations: r!.confirmations ?? null,
          approval: 'Only the workspace owner executes this upload: an operator prepares it.',
          removal: 'People are removed with meta_custom_audience_id_users_delete, or the whole list by deleting it.',
          minimum_size:
            'Meta shows whether a list can be used in ads in its delivery_status: 300 means it is too small to use yet. Verification reports it.',
        }
      : {approval: 'An operator may run a removal: it only reduces what Meta holds.'}),
    kept: 'AMCP keeps the counts and one digest of the hashed batch, never the people.',
    verification:
      'Reads the counts Meta returns and the list’s approximate size and delivery status, never the people.',
    source,
  };
}
export function metaCustomerListOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = metaCustomerListKind(p)!,
    d = r.data;
  if (r.status !== 200 || !object(d) || d.error) return false;
  if (kind === 'list') return /^[1-9][0-9]{0,31}$/.test(String(d.id ?? ''));
  return String(d.audience_id ?? '') === audienceOf(p) && typeof d.num_received === 'number';
}
/** Meta's reply without its samples of the values sent: the counts only. */
export function metaCustomerListSafeOutcome(outcome: JsonObject, p: CompiledRequest): JsonObject {
  if (metaCustomerListKind(p) === 'list' || !object(outcome.data)) return outcome;
  const d = outcome.data,
    keep: JsonObject = {};
  for (const k of ['audience_id', 'session_id', 'num_received', 'num_invalid_entries'])
    if (d[k] !== undefined) keep[k] = d[k];
  return {...outcome, data: keep};
}
export function metaCustomerListVerification(p: CompiledRequest, result: JsonObject) {
  const id = String(result.data?.id ?? '');
  if (!/^[1-9][0-9]{0,31}$/.test(id)) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no customer list.');
  const b = object(p.body) ? p.body : {};
  return [
    {
      read: graph(p, 'act_' + account(p.accountId), accountFields, {kind: 'list', audience: id, verify: true}),
      expected: {
        list: {
          present: true,
          id,
          account_id: account(p.accountId),
          name: b.name,
          subtype: 'CUSTOM',
          customer_file_source: b.customer_file_source,
          ...(b.description !== undefined ? {description: b.description} : {}),
        },
      },
      id: 'customer list ' + id,
    },
  ];
}
export function metaCustomerListObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  const l = object(data.list) ? data.list : {present: false};
  return {list: l.present === false ? {present: false} : {...l, account_id: account(l.account_id), id: String(l.id)}};
}
const deliveryMeaning = (code: number | null) =>
  code === 200
    ? 'ready to use in ads'
    : code === 300
      ? 'too small to use in ads yet (Meta’s minimum size)'
      : code === null
        ? 'not reported'
        : 'not usable in ads now';
/** Verification of people: Meta's own counts from the reply, and the list's size and delivery status, never the people. */
async function verifyPeople(
  p: CompiledRequest,
  result: JsonObject,
  read: (q: CompiledRequest) => Promise<TransportResult>,
): Promise<Verified> {
  const r = record(p)!,
    d = object(result.data) ? result.data : {},
    id = audienceOf(p);
  const x = (await read(graph(p, id, countFields))).data as JsonObject;
  if (!object(x) || account(x.account_id) !== account(p.accountId))
    return {
      status: 'unverified',
      checks: [{resource_id: id, status: 'unverified', reason: 'Meta did not return the list for this ad account.'}],
    };
  const delivery = object(x.delivery_status) ? Number(x.delivery_status.code) : null,
    operation = object(x.operation_status) ? Number(x.operation_status.code) : null,
    received = typeof d.num_received === 'number' ? d.num_received : null,
    complete = received === r.counts.sent;
  return {
    status: complete ? 'verified' : 'unverified',
    checks: [
      {
        resource_id: id,
        status: complete ? 'verified' : 'unverified',
        direction: r.direction,
        sent: r.counts.sent,
        received,
        invalid_entries: typeof d.num_invalid_entries === 'number' ? d.num_invalid_entries : null,
        approximate_size: [x.approximate_count_lower_bound ?? null, x.approximate_count_upper_bound ?? null],
        delivery_status: {code: delivery, meaning: deliveryMeaning(delivery)},
        operation_status: {code: operation},
        verification_scope: 'Meta’s counts for this request and the list’s size; the people are never read back',
        note: 'Meta usually applies a change within about 24 hours, so the size may not reflect it yet.',
        ...(complete ? {} : {reason: 'Meta received ' + received + ' of the ' + r.counts.sent + ' people sent.'}),
      },
    ],
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const metaCustomerListFamily: ReviewedFamily = {
  name: 'meta_customer_lists',
  files: ['src/meta-customer-lists.ts', ['tests/meta-customer-lists.test.mjs']],
  kind: metaCustomerListKind,
  assert: plan => assertMetaCustomerList(plan),
  authorize: authorizeMetaCustomerList,
  snapshots: metaCustomerListSnapshots,
  isRead: isMetaCustomerListRead,
  reader: readMetaCustomerLists,
  validateState: validateMetaCustomerListState,
  prerequisites: metaCustomerListPrerequisites,
  impact: metaCustomerListImpact,
  outcome: metaCustomerListOutcome,
  safeOutcome: (outcome, plan) => metaCustomerListSafeOutcome(outcome, plan),
  verification: metaCustomerListVerification,
  observed: metaCustomerListObserved,
  verify: (plan, v) =>
    metaCustomerListKind(plan) === 'list'
      ? undefined
      : verifyPeople(plan, v.result, v.guarded('Customer-list verification must remain read-only.')),
  personalData: metaCustomerListPeople,
  exemptFromSpendTextMatch: true,
  exemptFromActivationScan: true,
  activates: () => false,
  destructive: () => false,
};
