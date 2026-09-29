import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import {stable} from './security.js';
import type {Store} from './store.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {criteoPrefix, criteoRoute} from './criteo-version.js';

/**
 * Budget overrides of Criteo Retail Media campaigns and line items, API 2026-07 (unchanged from 2026-01; pinned OpenAPI
 * document: UpdateCampaignBudgetOverrides, UpdateLineItemBudgetOverrides and their GETs, CampaignBudgetOverrides,
 * CampaignDailyBudgetOverride, CampaignMonthlyBudgetOverride, LineItemBudgetOverrides, DailyLineItemBudgetOverride and
 * MonthlyLineItemBudegetOverride; the "Budget Overrides" guide; checked 2026-09-27). An override replaces the daily or
 * monthly spending cap for a run of days ("1D") or months ("1M"). The PUT replaces every override of the campaign or
 * line item; each list is in chronological order without overlaps, and a null start follows the previous override. As
 * the guide's examples show, Criteo stores back-to-back overrides with equal caps as one and returns the start of an
 * override that follows the previous one as null, so comparisons use merged runs. Whether an expired override left out
 * of the PUT is deleted is undocumented, so a request keeps every expired period with its cap.
 */
type Kind = 'campaign' | 'line';
type Scope = {kind: Kind; id: string};
type Read = CompiledRequest & {criteoOverrideState?: Scope};
const gateway = 'criteo_native_action',
  origin = 'https://api.criteo.com',
  prefix = criteoPrefix;
const lists: Record<Kind, {daily: string; monthly: string}> = {
  campaign: {daily: 'dailyBudgetOverrides', monthly: 'monthlyBudgetOverrides'},
  line: {daily: 'dailyLineItemBudgetOverrides', monthly: 'monthlyLineItemBudgetOverrides'},
};
const maxEntries = 50,
  maxDays = 366,
  maxMonths = 36,
  maxReadEntries = 200;
type Range = {start: string; length: number; cap: number};
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
function invalid(message: string): never {
  return fail('INVALID_CRITEO_BUDGET_OVERRIDE', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
function mismatch(message: string): never {
  return fail('STATE_TARGET_MISMATCH', message, {}, 409);
}
export function criteoOverrideKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.specialTransport || (p.origin && p.origin !== origin) || p.method !== 'PUT') return;
  if (criteoRoute('/campaigns/[1-9][0-9]{0,18}/campaign-budget-overrides$').test(p.path)) return 'campaign';
  if (criteoRoute('/line-items/[1-9][0-9]{0,18}/line-item-budget-overrides$').test(p.path)) return 'line';
  return;
}
const target = (p: CompiledRequest) => p.path.split('/')[4]!;
const dayOk = (v: string) => {
  const t = Date.parse(v + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
};
const dayNumber = (v: string) => Math.round(Date.parse(v + 'T00:00:00Z') / 86400000);
const monthNumber = (v: string) => Number(v.slice(0, 4)) * 12 + Number(v.slice(5, 7)) - 1;
const monthText = (n: number) =>
  String(Math.floor(n / 12)).padStart(4, '0') + '-' + String((n % 12) + 1).padStart(2, '0');
const dayText = (n: number) => new Date(n * 86400000).toISOString().slice(0, 10);
const startNumber = (r: Range, daily: boolean) => (daily ? dayNumber(r.start) : monthNumber(r.start));
/** Back-to-back overrides with equal caps as one run, the way Criteo stores them. */
function merged(list: Range[], daily: boolean): Range[] {
  const out: Range[] = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && last.cap === r.cap && startNumber(last, daily) + last.length === startNumber(r, daily))
      last.length += r.length;
    else out.push({...r});
  }
  return out;
}
/** One list as effective ranges: start, length and cap, each start filled in from the previous override when null. */
function ranges(entries: unknown, daily: boolean, label: string, strict: boolean): Range[] {
  if (!Array.isArray(entries) || entries.length > (strict ? maxEntries : maxReadEntries))
    return strict
      ? invalid(label + ' lists at most ' + maxEntries + ' overrides.')
      : unverified('Criteo returned an unrecognized override list.');
  const out: Range[] = [];
  let end: number | undefined;
  entries.forEach((e, i) => {
    const at = label + '[' + i + ']',
      startKey = daily ? 'startDate' : 'startMonth',
      capKey = daily ? 'maxDailySpend' : 'maxMonthlySpend';
    if (!object(e))
      return strict ? invalid(at + ' is an object.') : unverified('Criteo returned a malformed override.');
    if (!strict && e.status != null && !['Expired', 'Active', 'Upcoming'].includes(e.status as string))
      unverified('Criteo returned an unrecognized override status.');
    if (strict) {
      const extra = Object.keys(e).filter(k => ![startKey, 'duration', capKey].includes(k));
      if (extra.length)
        invalid(
          at +
            ': unqualified fields ' +
            extra.join(', ') +
            (extra.includes('status') ? ' (Criteo computes status)' : '') +
            '.',
        );
    }
    // Stored runs merge back-to-back overrides, so a read may be longer than one requested override.
    const duration =
      typeof e.duration === 'string'
        ? new RegExp('^([1-9][0-9]{0,5})[' + (daily ? 'Dd' : 'Mm') + ']$').exec(e.duration)
        : null;
    const length = duration ? Number(duration[1]) : NaN;
    if (!duration || length > (daily ? maxDays : maxMonths) * (strict ? 1 : maxEntries))
      return strict
        ? invalid(at + '.duration is 1–' + (daily ? maxDays + 'D' : maxMonths + 'M') + '.')
        : unverified('Criteo returned an unrecognized duration.');
    const cap = e[capKey];
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0 || cap > 1e12)
      return strict
        ? invalid(at + '.' + capKey + ' is a spend cap of 0 or more in the account currency.')
        : unverified('Criteo returned an unrecognized cap.');
    let start: number;
    const raw = e[startKey];
    if (raw === undefined || raw === null) {
      if (end === undefined)
        return strict
          ? invalid(at + ': the first override needs ' + startKey + '.')
          : unverified('Criteo returned an override without a start.');
      start = end + 1;
    } else {
      const text = typeof raw === 'string' ? raw.slice(0, daily ? 10 : 7) : '';
      if (daily ? !(/^\d{4}-\d{2}-\d{2}/.test(text) && dayOk(text)) : !/^\d{4}-(0[1-9]|1[0-2])$/.test(text))
        return strict
          ? invalid(at + '.' + startKey + ' is ' + (daily ? 'yyyy-MM-dd' : 'yyyy-MM') + '.')
          : unverified('Criteo returned an unrecognized start.');
      if (strict && typeof raw === 'string' && raw.length !== (daily ? 10 : 7))
        invalid(at + '.' + startKey + ' is ' + (daily ? 'yyyy-MM-dd' : 'yyyy-MM') + ', without a time.');
      start = daily ? dayNumber(text) : monthNumber(text);
      if (end !== undefined && start <= end)
        return strict
          ? invalid(at + ' starts before the previous override ends; overrides are chronological without overlaps.')
          : unverified('Criteo returned overlapping overrides.');
    }
    end = start + length - 1;
    out.push({start: daily ? dayText(start) : monthText(start), length, cap});
  });
  return out;
}
const attributesOf = (p: CompiledRequest): JsonObject => (p.body as JsonObject).data.attributes;
export function assertCriteoOverride(p: CompiledRequest): void {
  const kind = criteoOverrideKind(p);
  if (!kind) return;
  if (!id(p.accountId) || Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Use one numeric Criteo account without query or header overrides.');
  const b = p.body;
  if (
    !object(b) ||
    Object.keys(b).some(k => k !== 'data') ||
    !object(b.data) ||
    Object.keys(b.data).some(k => !['type', 'attributes'].includes(k)) ||
    !object(b.data.attributes)
  )
    invalid('Provide the native body {data: {type, attributes}}.');
  if (b.data.type !== undefined && typeof b.data.type !== 'string') invalid('data.type is a string when given.');
  const a = b.data.attributes,
    l = lists[kind];
  const extra = Object.keys(a).filter(k => ![l.daily, l.monthly].includes(k));
  if (extra.length) invalid('Unqualified fields: ' + extra.join(', ') + '.');
  if (!Array.isArray(a[l.daily]) || !Array.isArray(a[l.monthly]))
    invalid(
      'Send both ' +
        l.daily +
        ' and ' +
        l.monthly +
        ' (an empty list removes every override of that kind): the PUT replaces them all.',
    );
  ranges(a[l.daily], true, l.daily, true);
  ranges(a[l.monthly], false, l.monthly, true);
}
export function assertCriteoOverrideScopes(c: Connection, write = false): void {
  const required = [
    'RetailMedia_Accounts_Read',
    'RetailMedia_Campaign_Read',
    ...(write ? ['RetailMedia_Campaign_Manage'] : []),
  ];
  if (!required.every(s => c.scopes.includes(s)))
    fail('INSUFFICIENT_SCOPE', 'The selected Criteo connection needs ' + required.join(', ') + '.', {}, 403);
}
const read = (p: CompiledRequest, path: string, query: JsonObject = {}): Read => ({
  ...p,
  action: 'AMCP_CRITEO_OVERRIDE_READ',
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
  criteoOverrideState: undefined,
});
const stateRead = (p: CompiledRequest): Read => ({
  ...read(p, prefix + '/accounts', {limitToId: [p.accountId!], pageIndex: 0, pageSize: 2}),
  criteoOverrideState: {kind: criteoOverrideKind(p)!, id: target(p)},
});
export function criteoOverrideSnapshots(p: CompiledRequest): Read[] {
  return [stateRead(p)];
}
export function isCriteoOverrideRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).criteoOverrideState;
}
/** Writes need account-scoped membership of the campaign or line item; reads keep the account and a target the reader proved. */
export function authorizeCriteoOverride(p: CompiledRequest, c: Connection, store: Store, account: string): boolean {
  if (p.gateway !== gateway) return false;
  const kind = criteoOverrideKind(p);
  if (kind) {
    assertCriteoOverride(p);
    assertCriteoOverrideScopes(c, true);
    if (
      !store.ownsResource(
        c,
        account,
        'criteo-report-target/' + (kind === 'campaign' ? 'campaigns/' : 'line-items/') + target(p),
      )
    )
      fail(
        'RESOURCE_SCOPE_REQUIRED',
        'List the ' +
          (kind === 'campaign' ? 'campaign' : 'line item') +
          ' in this account first (GET_' +
          (kind === 'campaign' ? 'CAMPAIGNS' : 'LINE_ITEMS') +
          '_BY_ACCOUNT_ID with limitToId). Preparation rereads the current membership.',
        {},
        403,
      );
    return true;
  }
  if (p.action !== 'AMCP_CRITEO_OVERRIDE_READ') return false;
  assertCriteoOverrideScopes(c);
  if (
    p.accountId !== account ||
    p.method !== 'GET' ||
    !p.readOnly ||
    p.body !== undefined ||
    p.specialTransport ||
    (p.origin && p.origin !== origin) ||
    Object.keys(p.headers).length
  )
    fail('RESOURCE_SCOPE_REQUIRED', 'Budget override reads keep their exact account and origin.', {}, 403);
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
    stable(q) === stable({limitToId: q.limitToId, pageIndex: 0, pageSize: 2})
  )
    return true;
  if (
    id(context.criteoOverrideCampaignId) &&
    p.path === prefix + '/campaigns/' + context.criteoOverrideCampaignId + '/campaign-budget-overrides' &&
    !Object.keys(q).length
  )
    return true;
  if (
    id(context.criteoOverrideLineItemId) &&
    p.path === prefix + '/line-items/' + context.criteoOverrideLineItemId + '/line-item-budget-overrides' &&
    !Object.keys(q).length
  )
    return true;
  return fail('RESOURCE_SCOPE_REQUIRED', 'Budget override reads need current account-scoped membership.', {}, 403);
}
function envelope(r: TransportResult): JsonObject {
  const d = r.data;
  if (
    r.status !== 200 ||
    !object(d) ||
    ['errors', 'warnings'].some(k => d[k] != null && (!Array.isArray(d[k]) || d[k].length))
  )
    unverified('Criteo returned a failed or unrecognized read.');
  return d as JsonObject;
}
function single(d: JsonObject, wanted: string, label: string): JsonObject {
  if (Array.isArray(d.data) && !d.data.length) mismatch(label + ' ' + wanted + ' is not in the selected account.');
  const m = d.metadata;
  if (
    !Array.isArray(d.data) ||
    d.data.length !== 1 ||
    !object(m) ||
    m.currentPageIndex !== 0 ||
    m.nextPage ||
    (m.totalItemsAcrossAllPages != null && m.totalItemsAcrossAllPages !== 1)
  )
    unverified('The filtered account read must return exactly the requested ' + label.toLowerCase() + '.');
  const row = d.data[0];
  if (!object(row) || String(row.id) !== wanted || !object(row.attributes))
    mismatch('The account read returned a different ' + label.toLowerCase() + '.');
  return row;
}
export async function readCriteoOverrides(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).criteoOverrideState;
  if (!s) return fetch(p);
  let requests = 0;
  const get = async (q: Read) => {
    if (++requests > 6) unverified('Budget override reads exceeded their bound.');
    return envelope(await fetch(q));
  };
  const acct = single(await get({...(p as Read), criteoOverrideState: undefined}), p.accountId!, 'Account').attributes;
  if (typeof acct.currency !== 'string' || !/^[A-Z]{3}$/.test(acct.currency))
    unverified('The account currency is required.');
  let owner: JsonObject;
  if (s.kind === 'campaign') {
    const a = single(
      await get(
        read(p, prefix + '/accounts/' + p.accountId + '/campaigns', {limitToId: [s.id], pageIndex: 0, pageSize: 2}),
      ),
      s.id,
      'Campaign',
    ).attributes;
    if (String(a.accountId) !== p.accountId) mismatch('Campaign ' + s.id + ' belongs to another account.');
    owner = {id: s.id, name: a.name ?? null, type: a.type ?? null, status: a.status ?? null};
  } else {
    const a = single(
      await get(
        read(p, prefix + '/accounts/' + p.accountId + '/line-items', {limitToId: [s.id], pageIndex: 0, pageSize: 2}),
      ),
      s.id,
      'Line item',
    ).attributes;
    owner = {
      id: s.id,
      name: a.name ?? null,
      type: a.type ?? null,
      status: a.status ?? null,
      campaignId: a.campaignId ?? null,
    };
  }
  // Bound here to the membership just read; external arguments cannot set this context.
  const bound = {
    ...p,
    scopeContext: {
      ...p.scopeContext,
      ...(s.kind === 'campaign' ? {criteoOverrideCampaignId: s.id} : {criteoOverrideLineItemId: s.id}),
    },
  };
  const path =
    prefix +
    (s.kind === 'campaign'
      ? '/campaigns/' + s.id + '/campaign-budget-overrides'
      : '/line-items/' + s.id + '/line-item-budget-overrides');
  const d = await get(read(bound, path)),
    attrs =
      object(d.data) && object(d.data.attributes)
        ? d.data.attributes
        : unverified('Criteo returned no budget overrides.');
  const l = lists[s.kind];
  const view = (list: unknown, daily: boolean, label: string) => {
    const r = ranges(list, daily, label, false),
      raw = list as JsonObject[];
    return {all: merged(r, daily), expired: r.filter((_, i) => raw[i]!.status === 'Expired')};
  };
  const daily = view(attrs[l.daily] ?? [], true, l.daily),
    monthly = view(attrs[l.monthly] ?? [], false, l.monthly);
  return {
    status: 200,
    headers: {},
    data: {
      account: {id: p.accountId, currency: acct.currency},
      owner,
      kind: s.kind,
      daily: daily.all,
      monthly: monthly.all,
      expired: {daily: daily.expired, monthly: monthly.expired},
    },
  };
}
export function validateCriteoOverrideState(p: CompiledRequest, r: TransportResult): void {
  const d = r.data,
    s = (p as Read).criteoOverrideState;
  if (
    !s ||
    r.status !== 200 ||
    !object(d) ||
    !object(d.owner) ||
    !Array.isArray(d.daily) ||
    !Array.isArray(d.monthly) ||
    !object(d.expired)
  )
    unverified('Missing verified budget override state.');
}
function requested(p: CompiledRequest): {daily: Range[]; monthly: Range[]} {
  const kind = criteoOverrideKind(p)!,
    a = attributesOf(p),
    l = lists[kind];
  return {daily: ranges(a[l.daily], true, l.daily, true), monthly: ranges(a[l.monthly], false, l.monthly, true)};
}
/** The request as Criteo stores it: back-to-back overrides with equal caps merged. */
function stored(p: CompiledRequest): {daily: Range[]; monthly: Range[]} {
  const next = requested(p);
  return {daily: merged(next.daily, true), monthly: merged(next.monthly, false)};
}
export function criteoOverridePrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = criteoOverrideKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !Array.isArray(s.daily) || !Array.isArray(s.monthly) || !object(s.expired))
    unverified('Missing verified budget override state.');
  const next = stored(p);
  for (const daily of [true, false]) {
    const key = daily ? 'daily' : 'monthly',
      expired = (s.expired as JsonObject)[key];
    if (!Array.isArray(expired)) unverified('Missing verified budget override state.');
    for (const e of expired as Range[]) {
      const from = startNumber(e, daily),
        kept = next[key].some(
          r => r.cap === e.cap && startNumber(r, daily) <= from && startNumber(r, daily) + r.length >= from + e.length,
        );
      if (!kept)
        invalid(
          'Keep the expired ' +
            key +
            ' override from ' +
            e.start +
            ' (' +
            e.length +
            (daily ? 'D' : 'M') +
            ', cap ' +
            e.cap +
            ') in the request: the PUT replaces every override, and whether Criteo deletes an expired override left out is undocumented.',
        );
    }
  }
  if (stable(next.daily) === stable(s.daily) && stable(next.monthly) === stable(s.monthly))
    invalid('The ' + (kind === 'campaign' ? 'campaign' : 'line item') + ' already has exactly these overrides.');
}
/** Every override replaces a spending cap for its period. */
export function criteoOverrideNeedsConfirmation(p: CompiledRequest): boolean {
  return !!criteoOverrideKind(p);
}
/**
 * Owner monetary limits cover budgets and paces, not temporary caps of other periods; under such a policy an override
 * cannot be measured, so it is refused.
 */
export function criteoOverridePolicyAmounts(plan: CompiledRequest, _before: unknown, policy: JsonObject = {}) {
  if (!criteoOverrideKind(plan)) return;
  assertCriteoOverride(plan);
  if (
    ['max_budget_native', 'max_budget_increase_percent', 'max_daily_increase_native'].some(k => policy[k] !== undefined)
  )
    fail(
      'POLICY_AMOUNT_UNSUPPORTED',
      'Budget overrides replace daily or monthly caps for set periods, which the owner monetary limits do not measure. Ask the owner to change the policy, or change the budget or pacing instead.',
      {},
    );
  return {creating: false, amounts: [], old: []};
}
export function criteoOverrideImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = criteoOverrideKind(p);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {},
    next = requested(p);
  return {
    provider: 'criteo',
    scope: kind === 'campaign' ? 'campaign_budget_overrides' : 'line_item_budget_overrides',
    owner: object(s.owner) ? s.owner : null,
    currency: object(s.account) ? s.account.currency : null,
    before: {daily: s.daily ?? null, monthly: s.monthly ?? null},
    after: next,
    may_affect_serving: true,
    effect:
      'Replaces every budget override of the ' +
      (kind === 'campaign' ? 'campaign' : 'line item') +
      ': for each period Criteo spends up to the override cap instead of the usual daily or monthly cap. Overrides left out of the request are removed.',
    units: 'Caps are amounts in the account currency; durations are days (D) or months (M) from their start.',
    verification:
      'Reads the overrides again and compares every start, duration and cap, with back-to-back overrides of equal caps merged as Criteo stores them.',
    source: 'https://developers.criteo.com/retail-media/docs/budget-overrides',
  };
}
export function criteoOverrideOutcome(_p: CompiledRequest, r: TransportResult): boolean {
  const d = r.data;
  if (![200, 201, 204].includes(r.status)) return false;
  return (
    d === null ||
    d === undefined ||
    (object(d) && ['errors', 'warnings'].every(k => d[k] == null || (Array.isArray(d[k]) && !d[k].length)))
  );
}
export function criteoOverrideVerification(
  p: CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const next = stored(p);
  return [
    {
      read: stateRead(p),
      expected: {daily: next.daily, monthly: next.monthly},
      id: (criteoOverrideKind(p) === 'campaign' ? 'campaign ' : 'line item ') + target(p),
    },
  ];
}
export function criteoOverrideObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {daily: data.daily ?? null, monthly: data.monthly ?? null};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const criteoOverrideFamily: ReviewedFamily = {
  name: 'criteo_budget_overrides',
  files: ['src/criteo-budget-overrides.ts', ['tests/criteo-budget-overrides.test.mjs']],
  kind: criteoOverrideKind,
  assert: plan => assertCriteoOverride(plan),
  scope: (c, write) => assertCriteoOverrideScopes(c, write),
  authorize: (plan, connection, account, store) => authorizeCriteoOverride(plan, connection, store, account),
  snapshots: criteoOverrideSnapshots,
  isRead: isCriteoOverrideRead,
  reader: (read, next) => readCriteoOverrides(read, next),
  validateState: validateCriteoOverrideState,
  prerequisites: (plan, state) => criteoOverridePrerequisites(plan, state),
  impact: criteoOverrideImpact,
  outcome: criteoOverrideOutcome,
  verification: (plan: CompiledRequest) => criteoOverrideVerification(plan),
  observed: (read: CompiledRequest, data: JsonObject) =>
    data.amcp_absent === true ? data : criteoOverrideObserved(read, data),
  spendConfirmation: {
    needed: plan => !!criteoOverrideNeedsConfirmation(plan),
    message:
      'Budget overrides replace the daily or monthly spending caps of their periods and remove every override left out. Review them and provide spend_change_confirmed=true.',
  },
  policyAmounts: criteoOverridePolicyAmounts,
};
