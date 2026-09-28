import {MirrorError} from './errors.js';
import {stable} from './security.js';
import type {Store} from './store.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';

/**
 * Criteo Retail Media preferred (onsite display) line items on API 2026-01, per the pinned OpenAPI document
 * (CreatePreferredLineItemByCampaignId, UpdatePreferredLineItemByLineItemId, GetPreferredLineItemsByLineItemId,
 * PreferredLineItemCreateModelV2, PreferredLineItemUpdateModelV2, PreferredLineItemV2, CampaignV202301 and Creative2;
 * checked 2026-09-27).
 * - A preferred line item buys a page placement on one retailer for a budget between two dates, with standard or
 *   accelerated pacing, an optional frequency cap and an optional creative of the account.
 * - It belongs to a preferred campaign; the campaign and the retailer are fixed at creation.
 * - The update is a PUT of the whole line item, as for auction line items, so every writable field is sent; users set the
 *   status to active or paused, and Criteo derives scheduled, ended and the budget statuses.
 */
const gateway = 'criteo_native_action',
  origin = 'https://api.criteo.com',
  prefix = '/2026-01/retail-media';
type Kind = 'create' | 'update';
type Scope = {campaignId?: string; lineItemId?: string; creativeId?: string};
const pageTypes = [
  'search',
  'home',
  'browse',
  'checkout',
  'category',
  'productDetail',
  'confirmation',
  'merchandising',
  'deals',
  'favorites',
  'searchBar',
  'categoryMenu',
];
export const criteoPreferredFields = [
  'name',
  'startDate',
  'endDate',
  'status',
  'budget',
  'capping',
  'creativeId',
  'pacing',
  'page',
];
const createFields = [
  'name',
  'startDate',
  'endDate',
  'pacing',
  'page',
  'targetRetailerId',
  'budget',
  'capping',
  'creativeId',
  'status',
];
const running = ['active', 'scheduled', 'budgetHit', 'noFunds', 'ended'];
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v);
const date = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= Number.MAX_SAFE_INTEGER;
function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
function invalid(message: string): never {
  return fail('INVALID_CRITEO_PREFERRED_LINE_ITEM', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
function mismatch(message: string): never {
  return fail('STATE_TARGET_MISMATCH', message, {}, 409);
}

export function criteoPreferredKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || (p.origin && p.origin !== origin) || p.specialTransport) return;
  if (
    p.method === 'POST' &&
    /^\/2026-01\/retail-media\/campaigns\/[1-9][0-9]{0,18}\/preferred-line-items$/.test(p.path)
  )
    return 'create';
  if (p.method === 'PUT' && /^\/2026-01\/retail-media\/preferred-line-items\/[1-9][0-9]{0,18}$/.test(p.path))
    return 'update';
  return;
}
/** The campaign ID of a creation path, or the line item ID of an update path. */
const target = (p: CompiledRequest) => p.path.split('/')[4]!;
const attributes = (p: CompiledRequest): JsonObject => (p.body as JsonObject).data.attributes;
function page(v: unknown): void {
  if (
    !obj(v) ||
    Object.keys(v).some(k => !['pageType', 'categories', 'searchKeywords'].includes(k)) ||
    !pageTypes.includes(v.pageType)
  )
    invalid('page is {pageType, categories, searchKeywords} with pageType ' + pageTypes.join(', ') + '.');
  if (v.categories !== undefined && v.categories !== null) {
    if (v.pageType !== 'category') invalid('categories apply only to the category page type.');
    if (
      !Array.isArray(v.categories) ||
      !v.categories.length ||
      v.categories.length > 100 ||
      v.categories.some(
        c =>
          !obj(c) ||
          Object.keys(c).some(k => !['categoryId', 'includeChildren'].includes(k)) ||
          typeof c.categoryId !== 'string' ||
          !/^[\w.:-]{1,128}$/.test(c.categoryId) ||
          (c.includeChildren !== undefined && typeof c.includeChildren !== 'boolean'),
      )
    )
      invalid('page.categories lists 1–100 {categoryId, includeChildren} of the retailer.');
    if (new Set(v.categories.map((c: JsonObject) => c.categoryId)).size !== v.categories.length)
      invalid('Each category appears once.');
  }
  if (v.searchKeywords !== undefined && v.searchKeywords !== null) {
    if (v.pageType !== 'search') invalid('searchKeywords apply only to the search page type.');
    if (
      !Array.isArray(v.searchKeywords) ||
      !v.searchKeywords.length ||
      v.searchKeywords.length > 100 ||
      v.searchKeywords.some(k => typeof k !== 'string' || !k.trim() || k !== k.trim() || [...k].length > 100)
    )
      invalid('page.searchKeywords lists 1–100 keywords of at most 100 characters.');
    if (new Set(v.searchKeywords.map((k: string) => k.toLowerCase())).size !== v.searchKeywords.length)
      invalid('Each search keyword appears once.');
  }
}
function validate(kind: Kind, a: JsonObject): void {
  const allowed = kind === 'create' ? createFields : criteoPreferredFields,
    unknown = Object.keys(a).filter(k => !allowed.includes(k));
  if (unknown.length)
    invalid(
      (kind === 'update' && unknown.includes('targetRetailerId')
        ? 'The retailer is fixed at creation; leave it out of the update. '
        : '') +
        'Unqualified preferred line item fields: ' +
        unknown.join(', ') +
        '.',
    );
  const required =
    kind === 'create'
      ? ['name', 'startDate', 'endDate', 'pacing', 'page', 'targetRetailerId', 'budget']
      : criteoPreferredFields;
  const missing = required.filter(k => !Object.hasOwn(a, k));
  if (missing.length)
    invalid(
      'Missing: ' +
        missing.join(', ') +
        '.' +
        (kind === 'update'
          ? ' The PUT replaces the whole line item, so send every writable field, with null for no frequency cap or creative.'
          : ''),
    );
  if (
    typeof a.name !== 'string' ||
    !a.name.trim() ||
    a.name !== a.name.trim() ||
    [...a.name].length > 255 ||
    /[\u0000-\u001f]/.test(a.name)
  )
    invalid('name has 1–255 characters without surrounding spaces or control characters.');
  if (!date(a.startDate) || !date(a.endDate) || a.endDate < a.startDate)
    invalid('startDate and endDate are dates (YYYY-MM-DD), the end not before the start.');
  if (!positive(a.budget)) invalid('budget is a positive amount in the account currency.');
  if (!['standard', 'accelerated'].includes(a.pacing)) invalid('pacing is standard or accelerated.');
  page(a.page);
  if (
    a.capping !== undefined &&
    a.capping !== null &&
    (!obj(a.capping) ||
      Object.keys(a.capping).some(k => !['type', 'count'].includes(k)) ||
      !['day', 'session'].includes(a.capping.type) ||
      !Number.isSafeInteger(a.capping.count) ||
      a.capping.count < 1 ||
      a.capping.count > 1000)
  )
    invalid('capping is null or {type: day or session, count: 1–1000}.');
  if (a.creativeId !== undefined && a.creativeId !== null && !id(a.creativeId))
    invalid('creativeId is the numeric ID of a creative of the account, or null.');
  if (kind === 'create') {
    if (!id(a.targetRetailerId)) invalid('targetRetailerId is the numeric ID of the retailer the line item serves on.');
    if (a.status !== undefined && !['draft', 'paused'].includes(a.status))
      invalid('A new preferred line item starts draft or paused; activate it with a reviewed update.');
  } else if (!['active', 'paused'].includes(a.status))
    invalid('status is active or paused; Criteo sets scheduled, ended and the budget statuses itself.');
}
export function assertCriteoPreferred(p: CompiledRequest): void {
  const kind = criteoPreferredKind(p);
  if (!kind) return;
  if (!id(p.accountId) || Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Use one numeric Criteo account without query or header overrides.');
  const b = p.body,
    dataKeys = kind === 'create' ? ['type', 'attributes'] : ['type', 'attributes', 'id'];
  if (
    !obj(b) ||
    Object.keys(b).some(k => k !== 'data') ||
    !obj(b.data) ||
    Object.keys(b.data).some(k => !dataKeys.includes(k)) ||
    !obj(b.data.attributes)
  )
    invalid('Provide the native body {data: {type, attributes}}.');
  if (b.data.type !== undefined && b.data.type !== 'PreferredLineItem')
    invalid('data.type is PreferredLineItem when given.');
  if (kind === 'update' && b.data.id !== undefined && b.data.id !== target(p))
    invalid('data.id must be the line item of the path.');
  validate(kind, b.data.attributes);
}
export function assertCriteoPreferredScopes(c: Connection, write = false): void {
  const required = [
    'RetailMedia_Accounts_Read',
    'RetailMedia_Campaign_Read',
    ...(write ? ['RetailMedia_Campaign_Manage'] : []),
  ];
  if (!required.every(s => c.scopes.includes(s)))
    fail('INSUFFICIENT_SCOPE', 'The selected Criteo connection needs ' + required.join(', ') + '.', {}, 403);
}
const read = (p: CompiledRequest, path: string, query: JsonObject = {}): CompiledRequest => ({
  ...p,
  action: 'AMCP_CRITEO_PREFERRED_READ',
  method: 'GET',
  path,
  query,
  body: undefined,
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  responseControls: undefined,
  specialTransport: undefined,
  queryArrayEncoding: 'repeat',
  criteoPreferredState: undefined,
});
export function criteoPreferredSnapshots(p: CompiledRequest): CompiledRequest[] {
  const kind = criteoPreferredKind(p)!,
    a = attributes(p);
  const scope: Scope = {
    ...(kind === 'create' ? {campaignId: target(p)} : {lineItemId: target(p)}),
    ...(id(a.creativeId) ? {creativeId: a.creativeId} : {}),
  };
  return [
    {
      ...read(p, prefix + '/accounts', {limitToId: [p.accountId!], pageIndex: 0, pageSize: 2}),
      criteoPreferredState: scope,
    },
  ];
}
export function isCriteoPreferredRead(p: CompiledRequest): boolean {
  return p.gateway === gateway && !!p.criteoPreferredState;
}
/** Writes need account-scoped membership of the campaign or line item; internal reads keep the account and the verified context. */
export function authorizeCriteoPreferred(p: CompiledRequest, c: Connection, store: Store, account: string): boolean {
  if (p.gateway !== gateway) return false;
  const kind = criteoPreferredKind(p);
  if (kind) {
    assertCriteoPreferred(p);
    assertCriteoPreferredScopes(c, true);
    const resource =
      kind === 'create' ? 'criteo-report-target/campaigns/' + target(p) : 'preferred-line-items/' + target(p);
    if (!store.ownsResource(c, account, resource))
      fail(
        'RESOURCE_SCOPE_REQUIRED',
        'List the ' +
          (kind === 'create' ? 'campaigns' : 'line items') +
          ' of this account first (GET_' +
          (kind === 'create' ? 'CAMPAIGNS' : 'LINE_ITEMS') +
          '_BY_ACCOUNT_ID with limitToId). Preparation rereads the current membership.',
        {},
        403,
      );
    return true;
  }
  if (p.action !== 'AMCP_CRITEO_PREFERRED_READ') return false;
  assertCriteoPreferredScopes(c);
  if (
    p.accountId !== account ||
    p.method !== 'GET' ||
    !p.readOnly ||
    p.body !== undefined ||
    p.specialTransport ||
    (p.origin && p.origin !== origin) ||
    Object.keys(p.headers).length
  )
    fail('RESOURCE_SCOPE_REQUIRED', 'Preferred line item reads keep their exact account and origin.', {}, 403);
  const q = p.query,
    one = (v: unknown) => Array.isArray(v) && v.length === 1 && id(v[0]),
    context = p.scopeContext ?? {};
  if (p.path === prefix + '/accounts' && stable(q) === stable({limitToId: [account], pageIndex: 0, pageSize: 2}))
    return true;
  if (
    p.path === prefix + '/accounts/' + account + '/campaigns' &&
    one(q.limitToId) &&
    stable(q) === stable({limitToId: q.limitToId, pageIndex: 0, pageSize: 2})
  )
    return true;
  if (
    p.path === prefix + '/accounts/' + account + '/line-items' &&
    one(q.limitToId) &&
    stable(q) === stable({limitToId: q.limitToId, limitToType: 'Preferred', pageIndex: 0, pageSize: 2})
  )
    return true;
  if (
    id(context.criteoPreferredLineItemId) &&
    p.path === prefix + '/preferred-line-items/' + context.criteoPreferredLineItemId &&
    !Object.keys(q).length
  )
    return true;
  if (
    /^\/2026-01\/retail-media\/accounts\/[1-9][0-9]{0,18}\/creatives\/[1-9][0-9]{0,18}$/.test(p.path) &&
    p.path.split('/')[4] === account &&
    !Object.keys(q).length
  )
    return true;
  return fail('RESOURCE_SCOPE_REQUIRED', 'Preferred line item reads need current account-scoped membership.', {}, 403);
}
function envelope(r: TransportResult): JsonObject {
  const d = r.data;
  if (r.status !== 200 || !obj(d) || (Array.isArray(d.errors) && d.errors.length))
    unverified('Criteo returned a failed or unrecognized response.');
  return d as JsonObject;
}
function single(d: JsonObject, wanted: string, label: string): JsonObject {
  const rows = Array.isArray(d.data) ? d.data : [];
  if (rows.length !== 1 || !obj(rows[0]) || String(rows[0].id) !== wanted || !obj(rows[0].attributes))
    mismatch(label + ' ' + wanted + ' is not in the selected account.');
  return rows[0] as JsonObject;
}
/** The line item as the review compares it: writable fields and the status, without telemetry. */
function lineOf(v: unknown, wanted: string, campaign: string): JsonObject {
  const d = obj(v) && obj(v.data) ? v.data : undefined,
    a = obj(d) && obj(d.attributes) ? d.attributes : undefined;
  if (!d || !a || String(d.id) !== wanted || String(a.campaignId) !== campaign)
    mismatch('Criteo returned another preferred line item.');
  return {
    id: wanted,
    campaignId: campaign,
    targetRetailerId: String(a.targetRetailerId),
    name: a.name ?? null,
    startDate: typeof a.startDate === 'string' ? a.startDate.slice(0, 10) : null,
    endDate: typeof a.endDate === 'string' ? a.endDate.slice(0, 10) : null,
    status: a.status ?? null,
    budget: typeof a.budget === 'number' ? a.budget : null,
    pacing: a.pacing ?? null,
    capping: obj(a.capping) ? {type: a.capping.type, count: a.capping.count} : null,
    creativeId: a.creativeId === null || a.creativeId === undefined ? null : String(a.creativeId),
    page: obj(a.page) ? pageOf(a.page) : null,
  };
}
function pageOf(p: JsonObject): JsonObject {
  const categories =
    Array.isArray(p.categories) && p.categories.length
      ? [...p.categories]
          .map((c: JsonObject) => ({categoryId: String(c.categoryId), includeChildren: c.includeChildren === true}))
          .sort((x, y) => (x.categoryId < y.categoryId ? -1 : 1))
      : null;
  const keywords =
    Array.isArray(p.searchKeywords) && p.searchKeywords.length ? [...p.searchKeywords].map(String).sort() : null;
  return {pageType: p.pageType, categories, searchKeywords: keywords};
}
export async function readCriteoPreferred(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const scope = p.criteoPreferredState;
  if (!scope) return fetch(p);
  let requests = 0;
  const get = async (q: CompiledRequest) => {
    if (++requests > 8) unverified('Preferred line item reads exceeded their bound.');
    return envelope(await fetch(q));
  };
  const accountRow = single(await get({...p, criteoPreferredState: undefined}), p.accountId!, 'Account');
  const currency = accountRow.attributes.currency ?? null;
  let campaignId = scope.campaignId,
    line: JsonObject | null = null;
  if (scope.lineItemId) {
    const member = single(
      await get(
        read(p, prefix + '/accounts/' + p.accountId + '/line-items', {
          limitToId: [scope.lineItemId],
          limitToType: 'Preferred',
          pageIndex: 0,
          pageSize: 2,
        }),
      ),
      scope.lineItemId,
      'Preferred line item',
    ).attributes;
    if (String(member.type).toLowerCase() !== 'preferred' || !id(String(member.campaignId)))
      mismatch('Line item ' + scope.lineItemId + ' is not a preferred line item of this account.');
    campaignId = String(member.campaignId);
    // Bound here to the membership just read; external arguments cannot set this context.
    const bound = {...p, scopeContext: {...p.scopeContext, criteoPreferredLineItemId: scope.lineItemId}};
    line = lineOf(
      await get(read(bound, prefix + '/preferred-line-items/' + scope.lineItemId)),
      scope.lineItemId,
      campaignId,
    );
  }
  const c = single(
    await get(
      read(p, prefix + '/accounts/' + p.accountId + '/campaigns', {
        limitToId: [campaignId!],
        pageIndex: 0,
        pageSize: 2,
      }),
    ),
    campaignId!,
    'Campaign',
  ).attributes;
  if (String(c.accountId) !== p.accountId) mismatch('Campaign ' + campaignId + ' is not in the selected account.');
  const campaign = {
    id: campaignId,
    name: c.name ?? null,
    type: c.type ?? null,
    status: c.status ?? null,
    retailerId: c.retailerId === null || c.retailerId === undefined ? null : String(c.retailerId),
  };
  let creative: JsonObject | null = null;
  if (scope.creativeId) {
    const r = await get(read(p, prefix + '/accounts/' + p.accountId + '/creatives/' + scope.creativeId)),
      d = obj(r.data) ? r.data : {},
      a = obj(d.attributes) ? d.attributes : {};
    if (String(d.id) !== scope.creativeId)
      mismatch('Creative ' + scope.creativeId + ' is not a creative of the selected account.');
    creative = {
      id: scope.creativeId,
      retailerId: a.retailerId === undefined ? null : String(a.retailerId),
      status: a.status ?? null,
      name: a.name ?? null,
    };
  }
  return {status: 200, headers: {}, data: {account: {id: p.accountId, currency}, campaign, line, creative}};
}
export function validateCriteoPreferredState(p: CompiledRequest, r: TransportResult): void {
  const d = r.data,
    s = p.criteoPreferredState;
  if (
    !s ||
    r.status !== 200 ||
    !obj(d) ||
    !obj(d.account) ||
    !obj(d.campaign) ||
    (s.lineItemId && !obj(d.line)) ||
    (s.creativeId && !obj(d.creative))
  )
    unverified('Missing verified preferred line item state.');
}
/** The line item as the request leaves it, in the comparison form above. */
function after(p: CompiledRequest, before: JsonObject | null): JsonObject {
  const a = attributes(p),
    kind = criteoPreferredKind(p);
  return {
    ...(before ?? {}),
    name: a.name,
    startDate: a.startDate,
    endDate: a.endDate,
    ...(kind === 'update' || a.status !== undefined ? {status: a.status} : {}),
    budget: a.budget,
    pacing: a.pacing,
    capping: obj(a.capping) ? {type: a.capping.type, count: a.capping.count} : null,
    creativeId: id(a.creativeId) ? a.creativeId : null,
    page: pageOf(a.page as JsonObject),
    ...(kind === 'create' ? {targetRetailerId: a.targetRetailerId} : {}),
  };
}
export function criteoPreferredPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = criteoPreferredKind(p);
  if (!kind) return;
  const s = states[0];
  if (!obj(s) || !obj(s.campaign)) unverified('Missing verified preferred line item state.');
  const campaign = s.campaign as JsonObject,
    a = attributes(p);
  if (campaign.type !== 'preferred')
    invalid(
      'Campaign ' +
        campaign.id +
        ' is a ' +
        String(campaign.type) +
        ' campaign; preferred line items belong to preferred campaigns.',
    );
  const retailer = kind === 'create' ? String(a.targetRetailerId) : String(obj(s.line) ? s.line.targetRetailerId : '');
  if (kind === 'create' && campaign.retailerId !== null && campaign.retailerId !== retailer)
    invalid('Campaign ' + campaign.id + ' serves retailer ' + campaign.retailerId + ', not ' + retailer + '.');
  if (obj(s.creative)) {
    if (['Archived', 'Deleted'].includes(s.creative.status))
      invalid('Creative ' + s.creative.id + ' is ' + s.creative.status + '.');
    if (s.creative.retailerId !== null && s.creative.retailerId !== retailer)
      invalid('Creative ' + s.creative.id + ' is for retailer ' + s.creative.retailerId + ', not ' + retailer + '.');
  }
  if (kind === 'update') {
    const line = s.line as JsonObject;
    if (line.status === 'archived') invalid('Line item ' + line.id + ' is archived.');
    if (stable(after(p, line)) === stable(line)) invalid('Line item ' + line.id + ' already matches this request.');
  }
}
/** An active status lets the line item spend its budget from its start date. */
export function criteoPreferredNeedsConfirmation(p: CompiledRequest): boolean {
  return (
    criteoPreferredKind(p) === 'update' &&
    obj(p.body) &&
    obj(p.body.data) &&
    obj(p.body.data.attributes) &&
    p.body.data.attributes.status === 'active'
  );
}
export function criteoPreferredImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = criteoPreferredKind(p);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = obj(first) ? first : {},
    before = obj(s.line) ? s.line : null,
    next = after(p, before),
    currency = obj(s.account) ? s.account.currency : null;
  const activating = next.status === 'active' && (!before || !running.includes(String(before.status)));
  return {
    provider: 'criteo',
    scope: 'preferred_line_item',
    operation: kind,
    campaign: obj(s.campaign) ? s.campaign : null,
    before,
    after: next,
    currency,
    budget_change: before ? {from: before.budget, to: next.budget} : {to: next.budget},
    may_affect_serving: next.status === 'active' || before?.status === 'active',
    effect:
      kind === 'create'
        ? 'Creates a ' +
          (next.status ?? 'draft') +
          ' preferred line item that buys the ' +
          String(obj(next.page) ? next.page.pageType : '') +
          ' placement between its dates; it spends nothing until it is set to active.'
        : activating
          ? 'Activates the line item: it can spend its budget from its start date.'
          : 'Replaces the whole line item with the values sent.',
    verification: 'Reads the line item again and compares every writable field and the status.',
    source: 'https://developers.criteo.com/retail-media/reference',
  };
}
/** The budget in the account currency, in the form owner spending policies compare (as for auction line items). */
export function criteoPreferredPolicyAmounts(plan: CompiledRequest, before: unknown) {
  const kind = criteoPreferredKind(plan);
  if (!kind) return;
  assertCriteoPreferred(plan);
  const a = attributes(plan),
    line =
      kind === 'update' && Array.isArray(before) && obj(before[0]) && obj(before[0].line) ? before[0].line : undefined,
    path = '/data/attributes/budget';
  return {
    creating: kind === 'create',
    amounts: [{path, key: 'budget', amount: a.budget as number}],
    old:
      kind === 'update'
        ? [{path, key: 'budget', amount: typeof line?.budget === 'number' ? line.budget : (a.budget as number)}]
        : [],
  };
}
export function criteoPreferredOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const d = r.data;
  if (
    ![200, 201].includes(r.status) ||
    !obj(d) ||
    (Array.isArray(d.errors) && d.errors.length) ||
    !obj(d.data) ||
    !id(String(d.data.id)) ||
    !obj(d.data.attributes)
  )
    return false;
  return criteoPreferredKind(p) === 'create'
    ? String(d.data.attributes.campaignId) === target(p)
    : String(d.data.id) === target(p);
}
export function criteoPreferredVerification(
  p: CompiledRequest,
  result: JsonObject,
  before: unknown[],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = criteoPreferredKind(p)!,
    lineId = kind === 'create' ? String(result.data?.data?.id ?? '') : target(p);
  if (!id(lineId)) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no line item to verify.');
  const first = before[0],
    prior = obj(first) && obj(first.line) ? first.line : null,
    expected = after(p, prior);
  if (kind === 'create') delete expected.targetRetailerId;
  const a = attributes(p);
  return [
    {
      read: {
        ...read(p, prefix + '/accounts', {limitToId: [p.accountId!], pageIndex: 0, pageSize: 2}),
        criteoPreferredState: {lineItemId: lineId, ...(id(a.creativeId) ? {creativeId: a.creativeId} : {})},
      },
      expected: {
        line: {...expected, id: lineId, ...(kind === 'create' ? {targetRetailerId: String(a.targetRetailerId)} : {})},
      },
      id: 'preferred line item ' + lineId,
    },
  ];
}
export function criteoPreferredObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {line: obj(data.line) ? data.line : null};
}

/** The preferred line item a verified creation made; its ID becomes readable for the account. */
export function criteoPreferredVerifiedResources(p: CompiledRequest, actual: JsonObject): string[] {
  return criteoPreferredKind(p) === 'create' && typeof actual?.line?.id === 'string'
    ? ['preferred-line-items/' + actual.line.id]
    : [];
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const criteoPreferredFamily: ReviewedFamily = {
  name: 'criteo_preferred_line_items',
  files: ['src/criteo-preferred-line-items.ts', ['tests/criteo-preferred-line-items.test.mjs']],
  kind: criteoPreferredKind,
  assert: assertCriteoPreferred,
  scope: assertCriteoPreferredScopes,
  authorize: (plan, connection, id, store) => authorizeCriteoPreferred(plan, connection, store, id),
  snapshots: criteoPreferredSnapshots,
  isRead: isCriteoPreferredRead,
  reader: readCriteoPreferred,
  validateState: validateCriteoPreferredState,
  prerequisites: criteoPreferredPrerequisites,
  impact: criteoPreferredImpact,
  outcome: criteoPreferredOutcome,
  verification: criteoPreferredVerification,
  observed: criteoPreferredObserved,
  verifiedResources: criteoPreferredVerifiedResources,
  spendConfirmation: {
    needed: p => !!criteoPreferredKind(p),
    message: p =>
      criteoPreferredKind(p) === 'create'
        ? 'The new preferred line item carries a budget that it spends once it is activated. Review it and provide spend_change_confirmed=true.'
        : 'A complete preferred line item PUT replaces its budget, dates, placement and status and can start or change spending. Review it and provide spend_change_confirmed=true.',
  },
  policyAmounts: criteoPreferredPolicyAmounts,
};
