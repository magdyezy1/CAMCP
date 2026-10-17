import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {defineFamily, fail} from './family-kit.js';

/**
 * Curated categories of X Ads pre-roll line items, Ads API v12 (Campaign Management reference, "Line Item Curated
 * Categories" and "Curated Categories"; docs.x.com copy read on 2026-09-24 and rechecked 2026-09-27). A curated category is
 * a set of publishers next to whose videos PREROLL_VIEWS line items run; each category is available in specific countries.
 * POST associates a category with a line item, PUT replaces the category, DELETE removes the association.
 */
type Kind = 'create' | 'update' | 'delete';
type State = {lineItemId?: string; id?: string; categoryId?: string};
type Read = CompiledRequest & {xCuratedState?: State};
const gateway = 'x_ads_native_action',
  nativeId = /^[a-z0-9]{1,32}$/;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(message: string): never {
  return fail('INVALID_X_CURATED_CATEGORY', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function xCuratedKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.specialTransport) return;
  if (p.method === 'POST' && /^\/12\/accounts\/[a-z0-9]{1,32}\/line_item_curated_categories$/.test(p.path))
    return 'create';
  if (
    ['PUT', 'DELETE'].includes(p.method) &&
    /^\/12\/accounts\/[a-z0-9]{1,32}\/line_item_curated_categories\/[a-z0-9]{1,32}$/.test(p.path)
  )
    return p.method === 'PUT' ? 'update' : 'delete';
  return;
}
const account = (p: CompiledRequest) => p.path.split('/')[3]!,
  idOf = (p: CompiledRequest) => p.path.split('/')[5]!;
const body = (p: CompiledRequest): JsonObject => (object(p.body) ? p.body : {});
export function assertXCurated(p: CompiledRequest): void {
  const kind = xCuratedKind(p);
  if (!kind) return;
  if (account(p) !== p.accountId) fail('ACCOUNT_SCOPE_MISMATCH', 'The request must use the selected account.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers ?? {}).length)
    invalid('Curated category writes take their parameters in the body, without query or header overrides.');
  const b = p.body === undefined ? {} : p.body;
  if (!object(b)) invalid('Provide the native parameters.');
  const allowed =
    kind === 'create' ? ['line_item_id', 'curated_category_id'] : kind === 'update' ? ['curated_category_id'] : [];
  const extra = Object.keys(b).filter(k => !allowed.includes(k));
  if (extra.length)
    invalid(
      (kind === 'update' && extra.includes('line_item_id')
        ? 'The line item of an association does not change; delete it and create one for the other line item. '
        : '') +
        'Unqualified fields: ' +
        extra.join(', ') +
        '.',
    );
  if (kind === 'create' && (typeof b.line_item_id !== 'string' || !nativeId.test(b.line_item_id)))
    invalid('line_item_id is the native ID of a line item of the selected account.');
  if (kind !== 'delete' && (typeof b.curated_category_id !== 'string' || !nativeId.test(b.curated_category_id)))
    invalid('curated_category_id is the native ID of a curated category.');
}
function read(p: CompiledRequest, path: string, query: JsonObject = {}): Read {
  return {
    ...p,
    action: 'AMCP_X_CURATED_READ',
    method: 'GET',
    path: '/12/accounts/' + account(p) + path,
    query,
    body: undefined,
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    specialTransport: undefined,
    xCuratedState: undefined,
  };
}
const stateRead = (p: CompiledRequest, state: State): Read => ({...read(p, ''), xCuratedState: state});
export function xCuratedSnapshots(p: CompiledRequest): Read[] {
  const kind = xCuratedKind(p)!,
    b = body(p);
  return [
    stateRead(
      p,
      kind === 'create'
        ? {lineItemId: String(b.line_item_id), categoryId: String(b.curated_category_id)}
        : kind === 'update'
          ? {id: idOf(p), categoryId: String(b.curated_category_id)}
          : {id: idOf(p)},
    ),
  ];
}
export function isXCuratedRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).xCuratedState;
}
const view = (row: JsonObject) => ({
  id: String(row.id),
  lineItemId: String(row.line_item_id),
  categoryId: String(row.curated_category_id),
  deleted: row.deleted === true,
});
export async function readXCurated(
  p: CompiledRequest,
  send: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).xCuratedState;
  if (!s) return send(p);
  let requests = 0;
  const get = async (q: Read) => {
    if (++requests > 12) unverified('Curated category reads exceeded their bound.');
    const r = await send(q),
      d = r.data;
    if (r.status !== 200 || !object(d) || (Array.isArray(d.errors) && d.errors.length))
      unverified('X returned a failed or unrecognized read.');
    return d as JsonObject;
  };
  const acct = await get(read(p, ''));
  if (!object(acct.data) || String(acct.data.id) !== account(p)) unverified('X returned another account.');
  let association: JsonObject | null = null,
    lineItemId = s.lineItemId;
  if (s.id) {
    const d = (await get(read(p, '/line_item_curated_categories/' + s.id, {with_deleted: true}))).data;
    if (!object(d) || String(d.id) !== s.id || !nativeId.test(String(d.line_item_id)))
      fail(
        'STATE_TARGET_MISMATCH',
        'Line item curated category ' + s.id + ' is not in the selected account.',
        {id: s.id},
        409,
      );
    association = view(d);
    lineItemId = String(d.line_item_id);
  }
  const l = (await get(read(p, '/line_items/' + lineItemId, {with_deleted: true}))).data;
  if (!object(l) || String(l.id) !== lineItemId)
    fail(
      'STATE_TARGET_MISMATCH',
      'Line item ' + lineItemId + ' is not a line item of the selected account.',
      {line_item_id: lineItemId!},
      409,
    );
  const campaignId = String(l.campaign_id ?? ''),
    c = nativeId.test(campaignId)
      ? (await get(read(p, '/campaigns/' + campaignId, {with_deleted: true}))).data
      : undefined;
  if (!object(c) || String(c.id) !== campaignId) unverified('Line item ' + lineItemId + ' names no readable campaign.');
  // The list has no line item filter: every association of the account is read, in at most five pages.
  const existing: JsonObject = {};
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= 5) unverified('The account has more line item curated categories than five pages.');
    const listed = await get(read(p, '/line_item_curated_categories', {count: 1000, ...(cursor ? {cursor} : {})}));
    if (!Array.isArray(listed.data)) unverified('X did not list the line item curated categories.');
    for (const row of listed.data as unknown[]) {
      if (!object(row) || !nativeId.test(String(row.id))) unverified('A curated category row is malformed.');
      if (String(row.line_item_id) === lineItemId && row.deleted !== true) {
        const v = view(row);
        existing['a' + v.id] = v;
      }
    }
    if (!listed.next_cursor) break;
    if (typeof listed.next_cursor !== 'string' || listed.next_cursor === cursor)
      unverified('Curated category pagination is repeated or malformed.');
    cursor = listed.next_cursor;
  }
  let category: JsonObject | null = null;
  if (s.categoryId) {
    const d = (await get(read(p, '/curated_categories/' + s.categoryId))).data;
    if (!object(d) || String(d.id) !== s.categoryId)
      fail(
        'STATE_TARGET_MISMATCH',
        'Curated category ' + s.categoryId + ' is not available to the selected account.',
        {curated_category_id: s.categoryId},
        409,
      );
    category = {
      id: s.categoryId,
      name: d.name ?? null,
      countryCodes: Array.isArray(d.country_codes) ? [...d.country_codes].map(String).sort() : [],
    };
  }
  return {
    status: 200,
    headers: {},
    data: {
      accountId: account(p),
      line: {
        id: lineItemId,
        campaignId,
        objective: l.objective ?? null,
        status: l.entity_status ?? null,
        deleted: l.deleted === true,
      },
      campaign: {id: campaignId, status: c.entity_status ?? null, deleted: c.deleted === true},
      association,
      existing,
      category,
    },
  };
}
export function validateXCuratedState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).xCuratedState,
    d = r.data;
  if (
    !s ||
    r.status !== 200 ||
    !object(d) ||
    !object(d.line) ||
    !object(d.campaign) ||
    !object(d.existing) ||
    !!s.id !== object(d.association) ||
    !!s.categoryId !== object(d.category)
  )
    unverified('Missing verified curated category state.');
}
export function xCuratedPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = xCuratedKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !object(s.line) || !object(s.existing)) unverified('Missing verified curated category state.');
  if (kind !== 'create') {
    const a = s.association;
    if (!object(a) || a.deleted === true) invalid('Line item curated category ' + idOf(p) + ' is deleted.');
    if (kind === 'delete') return;
  }
  if (s.line.deleted === true) invalid('Line item ' + s.line.id + ' is deleted.');
  if (s.line.objective !== 'PREROLL_VIEWS')
    invalid(
      'Line item ' +
        s.line.id +
        ' has the ' +
        String(s.line.objective) +
        ' objective; curated categories apply to PREROLL_VIEWS line items.',
    );
  const b = body(p);
  if (kind === 'update' && object(s.association) && s.association.categoryId === b.curated_category_id)
    invalid(
      'Line item curated category ' + idOf(p) + ' already uses curated category ' + String(b.curated_category_id) + '.',
    );
  const same = Object.values(s.existing).find(
    a => object(a) && a.categoryId === b.curated_category_id && a.id !== (kind === 'update' ? idOf(p) : undefined),
  );
  if (object(same))
    fail(
      'CONFIGURATION_EXISTS',
      'Line item ' +
        s.line.id +
        ' already has curated category ' +
        String(b.curated_category_id) +
        ' as ' +
        String(same.id) +
        '.',
      {id: String(same.id)},
    );
}
/** A category decides next to which publishers the line item's pre-roll ads run. */
export function xCuratedNeedsConfirmation(p: CompiledRequest): boolean {
  const k = xCuratedKind(p);
  return k === 'create' || k === 'update';
}
export function xCuratedImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = xCuratedKind(p);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {},
    line = object(s.line) ? s.line : null,
    campaign = object(s.campaign) ? s.campaign : null;
  const serving = line?.status === 'ACTIVE' && campaign?.status === 'ACTIVE';
  return {
    provider: 'x',
    scope: 'line_item_curated_category',
    operation: kind,
    line_item: line,
    campaign,
    before: object(s.association) ? s.association : null,
    after: kind === 'delete' ? null : {category: object(s.category) ? s.category : {id: body(p).curated_category_id}},
    may_affect_serving: serving,
    effect:
      (kind === 'delete'
        ? 'Removes the curated category from the pre-roll line item.'
        : 'Makes the pre-roll line item run next to the publishers of the curated category, in the countries it is available in.') +
      (serving ? ' The line item and its campaign are active, so this applies at once.' : ''),
    verification:
      kind === 'delete'
        ? 'Reads the association again and checks that it is deleted.'
        : 'Reads the association by ID and compares its line item and curated category.',
    source: 'https://docs.x.com/x-ads-api/campaign-management/reference',
  };
}
export function xCuratedOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = xCuratedKind(p)!,
    d = r.data,
    t = object(d) && object(d.data) ? d.data : undefined,
    b = body(p);
  if (
    ![200, 201].includes(r.status) ||
    !t ||
    !nativeId.test(String(t.id)) ||
    (Array.isArray((d as JsonObject).errors) && (d as JsonObject).errors.length)
  )
    return false;
  if (kind === 'create')
    return t.line_item_id === b.line_item_id && t.curated_category_id === b.curated_category_id && t.deleted !== true;
  if (kind === 'update') return t.id === idOf(p) && t.curated_category_id === b.curated_category_id;
  return t.id === idOf(p) && t.deleted === true;
}
export function xCuratedVerification(
  p: CompiledRequest,
  result: JsonObject,
  before: unknown[],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = xCuratedKind(p)!,
    created = result.data?.data?.id,
    id = kind === 'create' ? created : idOf(p),
    b = body(p);
  if (typeof id !== 'string' || !nativeId.test(id))
    fail('VERIFICATION_UNSUPPORTED', 'The receipt names no line item curated category to verify.');
  const first = before[0],
    prior = object(first) && object(first.association) ? first.association : {};
  const expected =
    kind === 'delete'
      ? {id, deleted: true}
      : {
          id,
          lineItemId: kind === 'create' ? b.line_item_id : prior.lineItemId,
          categoryId: b.curated_category_id,
          deleted: false,
        };
  return [{read: stateRead(p, {id}), expected: {association: expected}, id: 'line item curated category ' + id}];
}
export function xCuratedObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {association: object(data.association) ? data.association : null};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const xCuratedFamily: ReviewedFamily = defineFamily({
  name: 'x_curated_categories',
  files: ['src/x-curated-categories.ts', ['tests/x-curated-categories.test.mjs']],
  kind: xCuratedKind,
  assert: assertXCurated,
  snapshots: xCuratedSnapshots,
  isRead: isXCuratedRead,
  reader: readXCurated,
  validateState: validateXCuratedState,
  prerequisites: xCuratedPrerequisites,
  impact: xCuratedImpact,
  outcome: xCuratedOutcome,
  verification: xCuratedVerification,
  observed: xCuratedObserved,
  spendConfirmation: {
    needed: xCuratedNeedsConfirmation,
    message:
      'A curated category decides next to which publishers the pre-roll line item runs. Review it and provide spend_change_confirmed=true.',
  },
  exemptFromSpendTextMatch: true,
  activates: xCuratedNeedsConfirmation,
});
