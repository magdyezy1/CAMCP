import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {defineFamily, fail, stateReadOf} from './family-kit.js';

/**
 * Batch writes of X campaigns and line items, per the X Ads API v12 Campaign Management reference (checked 2026-09-28).
 * POST batch/accounts/:account_id/campaigns and .../line_items take a JSON list of {operation_type, params} items:
 * "The current maximum batch size is 40", "Batch requests fail or succeed together as a group and all API responses for
 * both error and success preserve the item order of the initial request"; request-level errors come under errors and
 * item-level errors under operation_errors. params are the parameters of the single endpoints (POST for Create, PUT for
 * Update); Update and Delete name the entity by campaign_id or line_item_id, as X's Python Ads SDK sends them
 * (Batch.batch_save in xdevplatform/twitter-python-ads-sdk). "Deleting a campaign is not reversible."
 * AMCP reviews one operation type per batch of at most 20 items (an AMCP bound), creates only PAUSED entities like the
 * single reviewed creates, and applies the owner spending policy to each entity's own budgets. standard_delivery is
 * "Deprecated at the campaign level" and is left out there.
 */
type Kind = 'campaigns' | 'line_items';
type Op = 'Create' | 'Update' | 'Delete';
type State = {kind: Kind; op: Op; ids: string[]; parents: string[]; verify?: true};
type Read = CompiledRequest & {xEntityBatchState?: State};
const gateway = 'x_ads_native_action',
  origin = 'https://ads-api.x.com',
  marker = 'AMCP_X_ENTITY_BATCH_READ',
  maxItems = 20;
const route = /^\/12\/batch\/accounts\/([a-z0-9]{1,32})\/(campaigns|line_items)$/,
  native = /^[a-z0-9]{1,32}$/;
const idKey: Record<Kind, string> = {campaigns: 'campaign_id', line_items: 'line_item_id'};
const parentKey: Record<Kind, string> = {campaigns: 'funding_instrument_id', line_items: 'campaign_id'};
const noun: Record<Kind, string> = {campaigns: 'campaign', line_items: 'line item'};
const allowed: Record<Kind, Record<'Create' | 'Update', string[]>> = {
  campaigns: {
    Create: [
      'funding_instrument_id',
      'name',
      'budget_optimization',
      'daily_budget_amount_local_micro',
      'entity_status',
      'purchase_order_number',
      'total_budget_amount_local_micro',
    ],
    Update: [
      'budget_optimization',
      'daily_budget_amount_local_micro',
      'entity_status',
      'name',
      'purchase_order_number',
      'total_budget_amount_local_micro',
    ],
  },
  line_items: {
    Create: [
      'campaign_id',
      'objective',
      'product_type',
      'placements',
      'start_time',
      'end_time',
      'advertiser_domain',
      'android_app_store_identifier',
      'bid_amount_local_micro',
      'categories',
      'ios_app_store_identifier',
      'primary_web_event_tag',
      'advertiser_user_id',
      'audience_expansion',
      'bid_strategy',
      'duration_in_days',
      'entity_status',
      'frequency_cap',
      'goal',
      'name',
      'pay_by',
      'standard_delivery',
      'total_budget_amount_local_micro',
      'daily_budget_amount_local_micro',
    ],
    Update: [
      'advertiser_domain',
      'advertiser_user_id',
      'android_app_store_identifier',
      'audience_expansion',
      'bid_amount_local_micro',
      'bid_strategy',
      'categories',
      'duration_in_days',
      'entity_status',
      'end_time',
      'frequency_cap',
      'goal',
      'ios_app_store_identifier',
      'name',
      'pay_by',
      'start_time',
      'total_budget_amount_local_micro',
      'daily_budget_amount_local_micro',
    ],
  },
};
const choices: Record<string, string[]> = {
  budget_optimization: ['LINE_ITEM'],
  objective: [
    'APP_ENGAGEMENTS',
    'APP_INSTALLS',
    'REACH',
    'FOLLOWERS',
    'ENGAGEMENTS',
    'VIDEO_VIEWS',
    'PREROLL_VIEWS',
    'WEBSITE_CLICKS',
  ],
  product_type: ['MEDIA', 'PROMOTED_ACCOUNT', 'PROMOTED_TWEETS'],
  audience_expansion: ['BROAD', 'DEFINED', 'EXPANDED'],
  bid_strategy: ['AUTO', 'MAX', 'TARGET'],
  goal: [
    'APP_CLICKS',
    'APP_INSTALLS',
    'APP_PURCHASES',
    'ENGAGEMENT',
    'FOLLOWERS',
    'LINK_CLICKS',
    'MAX_REACH',
    'PREROLL',
    'PREROLL_STARTS',
    'REACH_WITH_ENGAGEMENT',
    'SITE_VISITS',
    'VIDEO_VIEW',
    'VIEW_3S_100PCT',
    'VIEW_6S',
    'VIEW_15S',
    'WEBSITE_CONVERSIONS',
  ],
  pay_by: ['APP_CLICK', 'IMPRESSION', 'LINK_CLICK'],
  entity_status: ['ACTIVE', 'PAUSED'],
};
const placementValues = [
  'ALL_ON_TWITTER',
  'PUBLISHER_NETWORK',
  'TAP_BANNER',
  'TAP_FULL',
  'TAP_FULL_LANDSCAPE',
  'TAP_NATIVE',
  'TAP_MRECT',
  'TWITTER_PROFILE',
  'TWITTER_REPLIES',
  'TWITTER_SEARCH',
  'TWITTER_TIMELINE',
];
const budgets = ['daily_budget_amount_local_micro', 'total_budget_amount_local_micro'],
  money = [...budgets, 'bid_amount_local_micro'];
const counts = ['duration_in_days', 'frequency_cap'],
  times = ['start_time', 'end_time'],
  lists = ['placements', 'categories'];
// X states these per read; they change without an advertiser edit.
const volatile = new Set(['servable', 'reasons_not_servable', 'effective_status', 'updated_at']);
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && !!v.trim() && v === v.trim() && [...v].length <= max && !/[\u0000-\u001f\u007f]/.test(v);
function invalid(message: string): never {
  return fail('INVALID_X_ENTITY_BATCH', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function xEntityBatchKind(p: CompiledRequest): Kind | undefined {
  if (
    p.gateway !== gateway ||
    p.method !== 'POST' ||
    p.specialTransport ||
    (p.origin !== undefined && p.origin !== origin)
  )
    return;
  return route.exec(p.path)?.[2] as Kind | undefined;
}
const operations = (p: CompiledRequest): {operation_type: Op; params: JsonObject}[] =>
  Array.isArray(p.body) ? (p.body as {operation_type: Op; params: JsonObject}[]) : [];
const opOf = (p: CompiledRequest): Op => operations(p)[0]!.operation_type;
/** A Delete batch removes entities: the owner policy on deletions applies to it. */
export const xEntityBatchDeletes = (p: CompiledRequest): boolean =>
  !!xEntityBatchKind(p) &&
  Array.isArray(p.body) &&
  (p.body as unknown[]).some(o => object(o) && o.operation_type === 'Delete');
/** Normalized for comparison: lists as sorted sets, times as UTC instants, amounts and counts as numbers. */
function norm(field: string, v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (lists.includes(field))
    return (Array.isArray(v) ? v.map(String) : String(v).split(','))
      .map(x => x.trim())
      .filter(Boolean)
      .sort();
  if (times.includes(field)) {
    const t = Date.parse(String(v));
    return Number.isNaN(t) ? String(v) : new Date(t).toISOString();
  }
  if (money.includes(field) || counts.includes(field)) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^[0-9]+$/.test(v) ? Number(v) : NaN;
    return Number.isFinite(n) ? n : v;
  }
  return v;
}
const same = (field: string, a: unknown, b: unknown) =>
  JSON.stringify(norm(field, a)) === JSON.stringify(norm(field, b));
function checkValue(field: string, v: unknown): void {
  if (money.includes(field)) {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0)
      invalid(field + ' is a positive whole number of micros of the account currency (5500000 is 5.50).');
    return;
  }
  if (field === 'duration_in_days') {
    if (v !== 1 && v !== 7 && v !== 30) invalid('duration_in_days is 1, 7 or 30.');
    return;
  }
  if (field === 'frequency_cap') {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1)
      invalid('frequency_cap is a positive whole number.');
    return;
  }
  if (field === 'standard_delivery') {
    if (typeof v !== 'boolean') invalid('standard_delivery is true or false.');
    return;
  }
  const allowedValues = choices[field];
  if (allowedValues) {
    if (typeof v !== 'string' || !allowedValues.includes(v))
      invalid(field + ' is one of ' + allowedValues.join(', ') + '.');
    return;
  }
  if (field === 'placements') {
    const parts = typeof v === 'string' ? v.split(',') : [];
    if (!parts.length || parts.some(x => !placementValues.includes(x)) || new Set(parts).size !== parts.length)
      invalid('placements is a comma-separated list of distinct placements: ' + placementValues.join(', ') + '.');
    return;
  }
  if (field === 'categories') {
    const parts = typeof v === 'string' ? v.split(',') : [];
    if (
      !parts.length ||
      parts.some(x => !/^IAB[0-9]{1,2}(?:-[0-9]{1,2})?$/.test(x)) ||
      new Set(parts).size !== parts.length
    )
      invalid('categories is a comma-separated list of distinct IAB category codes, such as IAB3-1.');
    return;
  }
  if (times.includes(field)) {
    if (typeof v !== 'string' || !iso.test(v) || Number.isNaN(Date.parse(v)))
      invalid(field + ' is an ISO 8601 time with its zone, such as 2026-10-01T00:00:00Z.');
    return;
  }
  if (field === 'name') {
    if (!text(v, 255)) invalid('name has 1–255 characters without surrounding spaces.');
    return;
  }
  if (field === 'purchase_order_number') {
    if (!text(v, 50)) invalid('purchase_order_number has 1–50 characters without surrounding spaces.');
    return;
  }
  if (field === 'advertiser_domain') {
    if (typeof v !== 'string' || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(v))
      invalid('advertiser_domain is a website domain without the protocol, such as example.com.');
    return;
  }
  if (field === 'android_app_store_identifier') {
    if (typeof v !== 'string' || v.length > 150 || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(v))
      invalid('android_app_store_identifier is a Google Play package name, such as com.example.app.');
    return;
  }
  if (field === 'ios_app_store_identifier') {
    if (typeof v !== 'string' || !/^[0-9]{1,20}$/.test(v))
      invalid('ios_app_store_identifier is the numeric part of the App Store identifier, as a string.');
    return;
  }
  if (field === 'advertiser_user_id') {
    if (typeof v !== 'string' || !/^[1-9][0-9]{0,24}$/.test(v))
      invalid('advertiser_user_id is a numeric X user ID, as a string.');
    return;
  }
  if (['funding_instrument_id', 'campaign_id', 'line_item_id', 'primary_web_event_tag'].includes(field)) {
    if (typeof v !== 'string' || !native.test(v)) invalid(field + ' is an X ID such as 8yn7m.');
    return;
  }
  invalid('Unqualified field ' + field + '.');
}
/** Rules that hold within one item, whatever the entity holds now. */
function checkItem(params: JsonObject, where: string): void {
  const daily = params.daily_budget_amount_local_micro,
    total = params.total_budget_amount_local_micro;
  if (typeof daily === 'number' && typeof total === 'number' && daily > total)
    invalid(where + ': daily_budget_amount_local_micro must not exceed total_budget_amount_local_micro.');
  if (params.bid_strategy === 'AUTO' && params.bid_amount_local_micro !== undefined)
    invalid(where + ': bid_strategy AUTO ignores bid_amount_local_micro; bid MAX or TARGET with it.');
  if (
    typeof params.start_time === 'string' &&
    typeof params.end_time === 'string' &&
    Date.parse(params.end_time) <= Date.parse(params.start_time)
  )
    invalid(where + ': end_time must be after start_time.');
}
export function assertXEntityBatch(p: CompiledRequest): void {
  const kind = xEntityBatchKind(p);
  if (!kind) return;
  if (route.exec(p.path)?.[1] !== p.accountId)
    fail('ACCOUNT_SCOPE_MISMATCH', 'The batch path names the selected account.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers ?? {}).length)
    invalid('A batch takes its operations as the JSON body, without query or header overrides.');
  const ops = p.body;
  if (!Array.isArray(ops) || !ops.length || ops.length > maxItems)
    invalid(
      'Provide 1–' +
        maxItems +
        ' operations. X accepts 40 per batch; ' +
        maxItems +
        ' is the AMCP bound for one review.',
    );
  const first = ops[0],
    type = object(first) ? first.operation_type : undefined;
  if (type !== 'Create' && type !== 'Update' && type !== 'Delete')
    invalid('operation_type is Create, Update or Delete.');
  const ids = new Set<string>();
  (ops as unknown[]).forEach((o, i) => {
    const where = 'operation ' + i;
    if (!object(o) || Object.keys(o).some(k => k !== 'operation_type' && k !== 'params') || !object(o.params))
      invalid(where + ' is {operation_type, params}.');
    if (o.operation_type !== type)
      invalid(
        'AMCP reviews one operation type per batch; ' +
          where +
          ' is ' +
          String(o.operation_type) +
          ', not ' +
          type +
          '.',
      );
    const params = o.params as JsonObject,
      keys = Object.keys(params);
    if (Object.hasOwn(params, 'account_id'))
      invalid('The account comes from the path; drop account_id from ' + where + '.');
    if (type !== 'Create') {
      checkValue(idKey[kind], params[idKey[kind]]);
      const id = params[idKey[kind]] as string;
      if (ids.has(id)) invalid('Each ' + noun[kind] + ' appears once per batch: ' + id + '.');
      ids.add(id);
    }
    if (type === 'Delete') {
      if (keys.length !== 1) invalid('A Delete names only ' + idKey[kind] + ' (' + where + ').');
      return;
    }
    const fields = type === 'Create' ? allowed[kind].Create : [idKey[kind], ...allowed[kind].Update];
    const extra = keys.filter(k => !fields.includes(k));
    if (extra.length)
      invalid(
        'Unqualified fields for a ' +
          noun[kind] +
          ' ' +
          type +
          ' (' +
          where +
          '): ' +
          extra.join(', ') +
          (kind === 'campaigns' && extra.includes('standard_delivery')
            ? '; standard_delivery is deprecated for campaigns and set on line items.'
            : '.'),
      );
    for (const k of keys) if (k !== idKey[kind] || type === 'Create') checkValue(k, params[k]);
    if (type === 'Update' && keys.length < 2)
      invalid('An Update names ' + idKey[kind] + ' and at least one change (' + where + ').');
    if (type === 'Create') {
      if (params.entity_status !== 'PAUSED')
        invalid(
          'Create ' + noun[kind] + 's with entity_status PAUSED (' + where + '); activate them with a reviewed update.',
        );
      const required =
        kind === 'campaigns'
          ? ['funding_instrument_id', 'name']
          : ['campaign_id', 'objective', 'product_type', 'placements'];
      const missing = required.filter(k => params[k] === undefined);
      if (missing.length) invalid(where + ' needs ' + missing.join(', ') + '.');
    }
    checkItem(params, where);
  });
}
function read(p: CompiledRequest, path: string, query: JsonObject = {}, state?: State): Read {
  return stateReadOf<Read>(p, marker, '/12/accounts/' + p.accountId + path, query, {xEntityBatchState: state});
}
function stateOf(p: CompiledRequest): State {
  const kind = xEntityBatchKind(p)!,
    op = opOf(p),
    ops = operations(p);
  return {
    kind,
    op,
    ids: op === 'Create' ? [] : ops.map(o => String(o.params[idKey[kind]])),
    parents: op === 'Create' ? [...new Set(ops.map(o => String(o.params[parentKey[kind]])))].sort() : [],
  };
}
/** One marked read of the account; the reader adds each funding instrument or campaign to create under, or each entity. */
export function xEntityBatchSnapshots(p: CompiledRequest): Read[] {
  return [read(p, '', {}, stateOf(p))];
}
export function isXEntityBatchRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).xEntityBatchState;
}
const notFound = (e: unknown) => e instanceof MirrorError && e.code === 'UPSTREAM_ERROR' && e.status === 404;
const view = (row: JsonObject): JsonObject => Object.fromEntries(Object.entries(row).filter(([k]) => !volatile.has(k)));
export async function readXEntityBatches(
  p: CompiledRequest,
  send: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).xEntityBatchState;
  if (!s) return send(p);
  let requests = 0;
  const get = async (path: string, query: JsonObject = {}): Promise<JsonObject | null> => {
    if (++requests > 2 * maxItems + 1) unverified('Batch reads exceeded their bound.');
    let r: TransportResult;
    try {
      r = await send(read(p, path, query));
    } catch (e) {
      if (notFound(e)) return null;
      throw e;
    }
    const d = r.data;
    if (r.status !== 200 || !object(d) || (Array.isArray(d.errors) && d.errors.length) || !object(d.data))
      unverified('X returned a failed or unrecognized read of ' + (path || 'the account') + '.');
    return d.data as JsonObject;
  };
  const entity = async (id: string): Promise<JsonObject> => {
    const row = await get('/' + s.kind + '/' + id, s.verify ? {with_deleted: true} : {});
    if (!row) return {present: false, id};
    if (String(row.id) !== id)
      fail('STATE_TARGET_MISMATCH', 'X returned another ' + noun[s.kind] + ' for ' + id + '.', {id}, 409);
    return {...view(row), present: row.deleted !== true};
  };
  const entities: JsonObject = {};
  if (s.verify) {
    for (const id of s.ids) entities['e' + id] = await entity(id);
    return {status: 200, headers: {}, data: {entities}};
  }
  const account = await get('');
  if (!account || String(account.id) !== p.accountId) unverified('X did not return the selected account.');
  const parents: JsonObject = {};
  for (const id of s.parents) {
    const row = await get((s.kind === 'campaigns' ? '/funding_instruments/' : '/campaigns/') + id);
    if (!row) {
      parents['p' + id] = {present: false, id};
      continue;
    }
    if (String(row.id) !== id)
      fail(
        'STATE_TARGET_MISMATCH',
        'X returned another ' + (s.kind === 'campaigns' ? 'funding instrument' : 'campaign') + ' for ' + id + '.',
        {id},
        409,
      );
    // A funding instrument keeps only what decides whether it can fund: no description or credit amounts.
    parents['p' + id] =
      s.kind === 'campaigns'
        ? {
            present: row.deleted !== true,
            id,
            account_id: row.account_id ?? null,
            entity_status: row.entity_status ?? null,
            able_to_fund: row.able_to_fund ?? null,
            reasons_not_able_to_fund: row.reasons_not_able_to_fund ?? [],
            currency: row.currency ?? null,
            type: row.type ?? null,
            start_time: row.start_time ?? null,
            end_time: row.end_time ?? null,
          }
        : {...view(row), present: row.deleted !== true};
  }
  for (const id of s.ids) entities['e' + id] = await entity(id);
  return {
    status: 200,
    headers: {},
    data: {
      account: {
        id: String(account.id),
        approval_status: account.approval_status ?? null,
        deleted: account.deleted ?? null,
      },
      parents,
      entities,
    },
  };
}
export function validateXEntityBatchState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).xEntityBatchState,
    d = r.data;
  if (
    !s ||
    r.status !== 200 ||
    !object(d) ||
    !object(d.entities) ||
    s.ids.some(id => !object((d.entities as JsonObject)['e' + id])) ||
    (!s.verify &&
      (!object(d.account) || !object(d.parents) || s.parents.some(id => !object((d.parents as JsonObject)['p' + id]))))
  )
    unverified('Missing verified campaign or line item state.');
}
export function xEntityBatchPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = xEntityBatchKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !object(s.account) || !object(s.parents) || !object(s.entities))
    unverified('Missing verified campaign or line item state.');
  if (s.account.deleted === true) invalid('The selected account is deleted.');
  const op = opOf(p),
    label = noun[kind].charAt(0).toUpperCase() + noun[kind].slice(1) + ' ';
  if (op === 'Create') {
    for (const id of stateOf(p).parents) {
      const e = (s.parents as JsonObject)['p' + id],
        what = kind === 'campaigns' ? 'Funding instrument ' : 'Campaign ';
      if (!object(e) || e.present !== true)
        fail('STATE_NOT_FOUND', what + id + ' was not found in the selected account.', {id}, 404);
      if (e.account_id !== undefined && e.account_id !== null && e.account_id !== p.accountId)
        fail('RESOURCE_SCOPE_REQUIRED', what + id + ' belongs to another account.', {id}, 403);
      if (kind === 'campaigns' && e.able_to_fund !== true)
        invalid(
          'Funding instrument ' +
            id +
            ' cannot fund campaigns' +
            (Array.isArray(e.reasons_not_able_to_fund) && e.reasons_not_able_to_fund.length
              ? ' (' + e.reasons_not_able_to_fund.join(', ') + ')'
              : '') +
            '.',
        );
    }
    return;
  }
  operations(p).forEach((o, i) => {
    const id = String(o.params[idKey[kind]]),
      e = (s.entities as JsonObject)['e' + id];
    if (!object(e) || e.present !== true)
      fail('STATE_NOT_FOUND', label + id + ' was not found in the selected account (or is deleted).', {id}, 404);
    if (e.account_id !== undefined && e.account_id !== null && e.account_id !== p.accountId)
      fail('RESOURCE_SCOPE_REQUIRED', label + id + ' belongs to another account.', {id}, 403);
    if (op === 'Delete') return;
    const changes = Object.keys(o.params).filter(k => k !== idKey[kind]);
    if (changes.every(k => same(k, o.params[k], e[k])))
      invalid(label + id + ' already has these values; nothing would change.');
    checkItem(
      {
        daily_budget_amount_local_micro: o.params.daily_budget_amount_local_micro ?? e.daily_budget_amount_local_micro,
        total_budget_amount_local_micro: o.params.total_budget_amount_local_micro ?? e.total_budget_amount_local_micro,
        bid_strategy: o.params.bid_strategy ?? e.bid_strategy,
        bid_amount_local_micro: o.params.bid_amount_local_micro,
        start_time: o.params.start_time ?? e.start_time,
        end_time: o.params.end_time ?? e.end_time,
      },
      'operation ' + i + ' (' + noun[kind] + ' ' + id + ')',
    );
  });
}
type Amount = {path: string; key: string; amount: number; decimal: string};
/** Each new budget is compared with its own entity's current budget under the owner spending policy; a create has none. */
export function xEntityBatchPolicyAmounts(p: CompiledRequest, before: unknown) {
  const kind = xEntityBatchKind(p);
  if (!kind || !operations(p).length) return;
  const op = opOf(p),
    first = Array.isArray(before) ? before[0] : undefined,
    entities: JsonObject = object(first) && object(first.entities) ? first.entities : {};
  const amounts: Amount[] = [],
    old: Amount[] = [];
  operations(p).forEach((o, i) => {
    const who = op === 'Create' ? 'new' + i : String(o.params[idKey[kind]]);
    for (const f of budgets) {
      const v = o.params[f];
      if (typeof v !== 'number') continue;
      const path = '/' + i + '/params/' + f,
        key = noun[kind] + ':' + who + ':' + f;
      amounts.push({path, key, amount: v, decimal: String(v)});
      const e = entities['e' + who],
        c = op === 'Update' && object(e) ? e[f] : undefined;
      if (typeof c === 'number' && Number.isFinite(c)) old.push({path, key, amount: c, decimal: String(c)});
    }
  });
  return {creating: op === 'Create', amounts, old};
}
export function xEntityBatchImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = xEntityBatchKind(p);
  if (!kind || !operations(p).length) return;
  const op = opOf(p),
    ops = operations(p),
    first = state[0],
    s: JsonObject = object(first) ? first : {},
    entities: JsonObject = object(s.entities) ? s.entities : {};
  const items = ops.map((o, i) => {
    if (op === 'Create')
      return {
        item: i,
        name: o.params.name ?? null,
        [parentKey[kind]]: o.params[parentKey[kind]],
        fields: Object.keys(o.params),
      };
    const id = String(o.params[idKey[kind]]),
      e = entities['e' + id],
      current = object(e) ? e : {};
    return {
      id,
      name: current.name ?? null,
      entity_status: current.entity_status ?? null,
      ...(op === 'Update'
        ? {
            changes: Object.fromEntries(
              Object.keys(o.params)
                .filter(k => k !== idKey[kind])
                .map(k => [k, {from: current[k] ?? null, to: o.params[k]}]),
            ),
          }
        : {}),
    };
  });
  const serving =
    op === 'Delete'
      ? items.some(r => (r as JsonObject).entity_status === 'ACTIVE')
      : op === 'Update' &&
        ops.some(o => Object.keys(o.params).some(k => ![idKey[kind], 'name', 'purchase_order_number'].includes(k)));
  return {
    provider: 'x',
    scope: kind,
    operation: op.toLowerCase() + '_batch',
    items,
    may_affect_serving: serving,
    effect:
      op === 'Create'
        ? 'Creates ' +
          ops.length +
          ' paused ' +
          noun[kind] +
          '(s) in one batch; none serves until a reviewed update activates it.'
        : op === 'Update'
          ? 'Changes ' +
            ops.length +
            ' ' +
            noun[kind] +
            '(s) in one batch; budget, bid, schedule and status changes apply at once to what serves.'
          : 'Deletes ' +
            ops.length +
            ' ' +
            noun[kind] +
            '(s) in one batch; X cannot restore a deleted ' +
            noun[kind] +
            '.',
    limits:
      '1–' +
      maxItems +
      ' operations of one type per review (an AMCP bound; X accepts 40); X applies all of them or none.',
    verification:
      'Reads each ' +
      noun[kind] +
      ' again' +
      (op === 'Delete' ? ' and expects it deleted or gone.' : ' and compares the fields sent.'),
    source: 'https://docs.x.com/x-ads-api/campaign-management/reference',
  };
}
/**
 * Success is every item back in order, without request or item errors; anything else is a failure never resubmitted. X does
 * not document an operation_errors list on success, so any non-empty one fails, as the generic outcome check also decides.
 */
export function xEntityBatchOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = xEntityBatchKind(p)!,
    op = opOf(p),
    ops = operations(p),
    d = r.data;
  if (
    r.status < 200 ||
    r.status >= 300 ||
    !object(d) ||
    (d.error !== undefined && d.error !== null) ||
    (d.errors !== undefined && (!Array.isArray(d.errors) || d.errors.length > 0)) ||
    (d.operation_errors !== undefined &&
      d.operation_errors !== null &&
      !(Array.isArray(d.operation_errors) && !d.operation_errors.length)) ||
    !Array.isArray(d.data) ||
    d.data.length !== ops.length
  )
    return false;
  const seen = new Set<string>();
  return ops.every((o, i) => {
    const row = (d.data as unknown[])[i];
    if (!object(row) || typeof row.id !== 'string' || !native.test(row.id) || seen.has(row.id)) return false;
    seen.add(row.id);
    if (op === 'Create') return row.deleted !== true && row.entity_status === 'PAUSED';
    return row.id === o.params[idKey[kind]] && (op === 'Delete' ? row.deleted === true : row.deleted !== true);
  });
}
export function xEntityBatchVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = xEntityBatchKind(p)!,
    op = opOf(p),
    ops = operations(p),
    rows = object(result.data) ? result.data.data : undefined;
  const ids = ops.map((o, i) =>
    op === 'Create'
      ? Array.isArray(rows) && object(rows[i])
        ? String(rows[i].id)
        : ''
      : String(o.params[idKey[kind]]),
  );
  if (ids.some(id => !native.test(id)))
    fail('VERIFICATION_UNSUPPORTED', 'The batch receipt does not name every new ' + noun[kind] + '.');
  const entities: JsonObject = {};
  ops.forEach((o, i) => {
    if (op === 'Delete') {
      entities['e' + ids[i]] = {present: false};
      return;
    }
    const want: JsonObject = {present: true};
    for (const [k, v] of Object.entries(o.params)) if (k !== idKey[kind] || op === 'Create') want[k] = norm(k, v);
    entities['e' + ids[i]] = want;
  });
  return [
    {
      read: read(p, '', {}, {kind, op, ids, parents: [], verify: true}),
      expected: {entities},
      id: (kind === 'campaigns' ? 'campaigns ' : 'line items ') + ids.join(', '),
    },
  ];
}
export function xEntityBatchObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  const entities: JsonObject = {};
  for (const [k, e] of Object.entries(object(data.entities) ? data.entities : {}))
    entities[k] = object(e)
      ? Object.fromEntries(Object.entries(e).map(([f, v]) => [f, f === 'present' ? v : norm(f, v)]))
      : {present: false};
  return {entities};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const xEntityBatchFamily: ReviewedFamily = defineFamily({
  name: 'x_entity_batches',
  files: ['src/x-entity-batches.ts', ['tests/x-entity-batches.test.mjs']],
  kind: xEntityBatchKind,
  assert: assertXEntityBatch,
  snapshots: xEntityBatchSnapshots,
  isRead: isXEntityBatchRead,
  reader: readXEntityBatches,
  validateState: validateXEntityBatchState,
  prerequisites: xEntityBatchPrerequisites,
  impact: xEntityBatchImpact,
  outcome: xEntityBatchOutcome,
  verification: xEntityBatchVerification,
  observed: xEntityBatchObserved,
  destructive: xEntityBatchDeletes,
  policyAmounts: xEntityBatchPolicyAmounts,
});
