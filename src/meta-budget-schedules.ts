import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {PolicyAmounts, ReviewedFamily} from './reviewed-family.js';
import {metaPrefix, metaRoute} from './meta-version.js';
import {assertNoMethodOverride} from './write-common.js';
import {fail} from './family-kit.js';

/**
 * Meta budget scheduling (high demand periods), opened by the owner on 2026-09-29 on conditions. Meta's references (read
 * 2026-09-29, "Campaign Budget Schedules", "Ad Set Budget Schedules" and "High Demand Period"): POST
 * /{campaign_id}/budget_schedules and /{ad_set_id}/budget_schedules take budget_value ("Actual budget increase, unit
 * defined by BudgetValueType (e.g. 140 could be $140 or 140%)"), budget_value_type ABSOLUTE or MULTIPLIER, and
 * time_start and time_end as Unix times, and answer {id}. Updating and deleting: "You can't perform this operation on this
 * endpoint" (the SDK's node update and delete are not in the reference, so AMCP does not use them). The account needs
 * CAN_USE_BUDGET_SCHEDULING_API; budget scheduling works with daily budgets only; at most 50 high demand periods per
 * campaign or ad set; "the total budget cannot exceed 8 times the daily budget"; a period lasts 3 hours or more; not for
 * Advantage+ App campaigns.
 *
 * The owner's conditions: a spending policy must protect the account; the full increase counts against its caps when the
 * change is prepared; the review shows start and end in the account's time zone and the maximum extra spend, and needs
 * spend_change_confirmed; the review says how a period is cancelled; the schedule list is read back.
 */
type Level = 'campaign' | 'adset';
type State = {id: string; created?: string};
type Read = CompiledRequest & {metaBudgetScheduleState?: State};
const gateway = 'meta_native_action',
  hour = 3600,
  maxPeriods = 50,
  maxMultiple = 8,
  source = 'https://developers.facebook.com/docs/marketing-api/reference/high-demand-period/';
const actions: Record<string, Level> = {
  meta_campaign_id_budget_schedules_create: 'campaign',
  meta_ad_set_id_budget_schedules_create: 'adset',
};
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
const account = (v: unknown) => String(v ?? '').replace(/^act_/, '');
function invalid(message: string, details: JsonObject = {}): never {
  return fail('INVALID_META_BUDGET_SCHEDULE', message, {source, ...details});
}
function unavailable(message: string, details: JsonObject = {}): never {
  return fail('BUDGET_SCHEDULING_UNAVAILABLE', message, {source, ...details}, 409);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function metaBudgetScheduleKind(p: CompiledRequest): Level | undefined {
  if (p.gateway !== gateway || p.method !== 'POST' || p.specialTransport) return;
  if (p.origin && p.origin !== 'https://graph.facebook.com') return;
  const level = actions[p.action];
  return level && metaRoute('[1-9][0-9]{0,31}/budget_schedules$').test(p.path) ? level : undefined;
}
const targetOf = (p: CompiledRequest) => p.path.split('/')[2]!;
const body = (p: CompiledRequest): JsonObject => (obj(p.body) ? p.body : {});
export function assertMetaBudgetSchedule(p: CompiledRequest, now = Date.now()): void {
  if (!metaBudgetScheduleKind(p)) return;
  assertNoMethodOverride(p);
  if (!numeric(account(p.accountId))) invalid('Select one Meta ad account.');
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('A budget schedule takes no query or header overrides.');
  if (!obj(p.body)) invalid('Send the period as a native object.');
  const b = p.body,
    fields = ['budget_value', 'budget_value_type', 'time_start', 'time_end'];
  const extra = Object.keys(b).filter(k => !fields.includes(k));
  if (extra.length)
    invalid('A period sets only ' + fields.join(', ') + '; unqualified fields: ' + extra.join(', ') + '.', {
      fields: extra,
    });
  for (const k of fields) if (b[k] === undefined) invalid(k + ' is required.', {field: k});
  if (!['ABSOLUTE', 'MULTIPLIER'].includes(b.budget_value_type))
    invalid('budget_value_type is ABSOLUTE (a whole amount of the account currency) or MULTIPLIER (a percentage).', {
      field: 'budget_value_type',
    });
  if (!Number.isSafeInteger(b.budget_value) || b.budget_value < 1)
    invalid('budget_value is a whole number of at least 1.', {field: 'budget_value'});
  if (b.budget_value_type === 'MULTIPLIER' && b.budget_value > (maxMultiple - 1) * 100)
    invalid('Meta allows at most 8 times the daily budget, so a percentage increase is at most 700.', {
      field: 'budget_value',
    });
  for (const k of ['time_start', 'time_end'])
    if (!Number.isSafeInteger(b[k]) || b[k] < 0) invalid(k + ' is a Unix time in whole seconds.', {field: k});
  if (b.time_start * 1000 <= now) invalid('The period must start in the future.', {field: 'time_start'});
  if (b.time_end - b.time_start < 3 * hour) invalid('A high demand period lasts 3 hours or more.', {field: 'time_end'});
}
export function assertMetaBudgetScheduleScope(c: Connection, write = false): void {
  if (write ? !c.scopes.includes('ads_management') : !c.scopes.some(s => s === 'ads_management' || s === 'ads_read'))
    fail('INSUFFICIENT_SCOPE', 'Reconnect Meta with ads_management to schedule budget increases.', {}, 403);
}
const graph = (p: CompiledRequest, path: string, query: JsonObject): CompiledRequest => ({
  ...p,
  action: 'AMCP_META_BUDGET_SCHEDULE_READ',
  method: 'GET',
  path: metaPrefix + path,
  query,
  body: undefined,
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  responseControls: undefined,
  specialTransport: undefined,
});
const read = (p: CompiledRequest, s: State): Read => ({
  ...graph(p, s.id + '/budget_schedules', {
    fields: 'id,budget_value,budget_value_type,recurrence_type,time_start,time_end',
    limit: 100,
  }),
  metaBudgetScheduleState: s,
});
export function metaBudgetScheduleSnapshots(p: CompiledRequest): Read[] {
  return [read(p, {id: targetOf(p)})];
}
export function isMetaBudgetScheduleRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).metaBudgetScheduleState;
}
const seconds = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  const t = typeof v === 'string' ? Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : NaN;
  return Number.isFinite(t) ? Math.round(t / 1000) : null;
};
const period = (x: JsonObject) => ({
  id: String(x.id),
  budget_value: x.budget_value === undefined ? null : Number(x.budget_value),
  budget_value_type: x.budget_value_type ?? null,
  recurrence_type: x.recurrence_type ?? null,
  time_start: seconds(x.time_start),
  time_end: seconds(x.time_end),
});
/** The account (currency, time zone, capability), the campaign or ad set, and every scheduled period of it. */
export async function readMetaBudgetSchedules(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).metaBudgetScheduleState;
  if (!s) return fetch(p);
  const get = async (q: CompiledRequest, label: string) => {
    const r = await fetch(q);
    if (r.status !== 200 || !obj(r.data) || r.data.error) unverified('Meta did not return the ' + label + '.');
    return r.data as JsonObject;
  };
  const periods: JsonObject[] = [];
  let q: CompiledRequest = {...(p as Read), metaBudgetScheduleState: undefined} as Read;
  for (let page = 0; ; page++) {
    if (page >= 3) unverified('Meta listed more budget schedule pages than one review reads.');
    const d = await get(q, 'budget schedules');
    if (!Array.isArray(d.data)) unverified('Meta did not list the budget schedules.');
    for (const row of d.data as unknown[]) {
      if (!obj(row) || !numeric(String(row.id ?? ''))) unverified('A budget schedule row is malformed.');
      periods.push(period(row as JsonObject));
    }
    const after = obj(d.paging) && obj(d.paging.cursors) ? d.paging.cursors.after : undefined;
    if (!(obj(d.paging) && d.paging.next)) break;
    if (typeof after !== 'string' || !after) unverified('Meta listed more budget schedules without a cursor.');
    q = {...q, query: {...q.query, after}};
  }
  periods.sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(periods.map(x => x.id)).size !== periods.length) unverified('Meta listed a budget schedule twice.');
  if (s.created) {
    const row = periods.find(x => x.id === s.created);
    return {status: 200, headers: {}, data: {period: row ? {present: true, ...row} : {present: false, id: s.created}}};
  }
  const acct = await get(
      graph(p, 'act_' + account(p.accountId), {fields: 'id,currency,timezone_name,capabilities'}),
      'ad account',
    ),
    level = metaBudgetScheduleKind(p)!;
  const node = await get(
    graph(p, s.id, {
      fields:
        'id,account_id,name,status,daily_budget,lifetime_budget,' +
        (level === 'campaign' ? 'smart_promotion_type' : 'campaign_id'),
    }),
    level === 'campaign' ? 'campaign' : 'ad set',
  );
  if (String(node.id) !== s.id) unverified('Meta returned a different object.');
  if (account(node.account_id) !== account(p.accountId))
    fail(
      'STATE_TARGET_MISMATCH',
      'This ' + (level === 'campaign' ? 'campaign' : 'ad set') + ' belongs to another ad account.',
      {id: s.id},
      409,
    );
  let promotion = node.smart_promotion_type ?? null;
  if (level === 'adset' && numeric(String(node.campaign_id ?? ''))) {
    const parent = await get(
      graph(p, String(node.campaign_id), {fields: 'id,account_id,smart_promotion_type'}),
      'campaign',
    );
    if (account(parent.account_id) !== account(p.accountId))
      fail('STATE_TARGET_MISMATCH', "This ad set's campaign belongs to another ad account.", {id: s.id}, 409);
    promotion = parent.smart_promotion_type ?? null;
  }
  const money = (v: unknown) => (v === undefined || v === null || v === '' || Number(v) === 0 ? null : Number(v));
  return {
    status: 200,
    headers: {},
    data: {
      account: {
        currency: typeof acct.currency === 'string' ? acct.currency : null,
        timezone: typeof acct.timezone_name === 'string' ? acct.timezone_name : null,
        capable: Array.isArray(acct.capabilities) && acct.capabilities.includes('CAN_USE_BUDGET_SCHEDULING_API'),
      },
      object: {
        level,
        id: s.id,
        name: node.name ?? null,
        status: node.status ?? null,
        daily_budget: money(node.daily_budget),
        lifetime_budget: money(node.lifetime_budget),
        smart_promotion_type: promotion,
      },
      schedules: periods,
    },
  };
}
export function validateMetaBudgetScheduleState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).metaBudgetScheduleState,
    d = r.data;
  if (
    !s ||
    r.status !== 200 ||
    !obj(d) ||
    (s.created ? !obj(d.period) : !obj(d.account) || !obj(d.object) || !Array.isArray(d.schedules))
  )
    unverified('Missing verified budget schedule state.');
}
/** Minor units of an ISO 4217 currency: 2 for USD, 0 for JPY. */
const minorDigits = (currency: string) => {
  try {
    return new Intl.NumberFormat('en', {style: 'currency', currency}).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
};
type Plan = {
  daily: number;
  increase: number;
  peak: number;
  overlapping: {id: string; increase_native: number}[];
  stacked: number;
  days: number;
  currency: string;
  timezone: string;
};
const validZone = (v: unknown): v is string => {
  if (typeof v !== 'string' || !v) return false;
  try {
    new Intl.DateTimeFormat('en', {timeZone: v});
    return true;
  } catch {
    return false;
  }
};
/** The increase of one period in native units: a percentage of the daily budget, or whole currency units. */
const increaseOf = (type: unknown, value: number, daily: number, currency: string) =>
  type === 'MULTIPLIER' ? Math.ceil((daily * value) / 100) : value * 10 ** minorDigits(currency);
/**
 * The increase in Meta's native budget units (the minor units daily_budget uses). An ABSOLUTE value is a whole amount of
 * the account currency ("140 could be $140"), counted with the ISO 4217 minor digits of the currency; Meta's offsets do
 * not exceed ISO's, so any difference can only overstate the increase against the owner's caps.
 */
function planned(p: CompiledRequest, state: unknown): Plan {
  const s = obj(state) ? state : {},
    b = body(p),
    acct: JsonObject = obj(s.account) ? s.account : {},
    node: JsonObject = obj(s.object) ? s.object : {};
  // The review shows the account's own time zone and counts its currency; it never assumes UTC or cents.
  if (!validZone(acct.timezone)) unverified('Meta did not return a usable ad account time zone.');
  if (typeof acct.currency !== 'string' || !/^[A-Z]{3}$/.test(acct.currency))
    unverified('Meta did not return the ad account currency.');
  const daily = Number(node.daily_budget),
    currency = acct.currency,
    timezone = acct.timezone,
    start = Number(b.time_start),
    end = Number(b.time_end);
  const increase = increaseOf(b.budget_value_type, Number(b.budget_value), daily, currency);
  // A period already scheduled over any part of this one may raise the budget at the same time, so the owner's caps hold
  // both. A recurring period counts from its first start, since its later occurrences are not listed.
  const overlapping: Plan['overlapping'] = [];
  for (const row of Array.isArray(s.schedules) ? (s.schedules as JsonObject[]) : []) {
    const once = row.recurrence_type === null || row.recurrence_type === 'ONE_TIME';
    if (typeof row.time_start !== 'number' || (once && typeof row.time_end !== 'number'))
      unverified('A budget schedule row has no times.');
    if (!(row.time_start < end && (!once || Number(row.time_end) > start))) continue;
    if (!Number.isFinite(row.budget_value) || !['ABSOLUTE', 'MULTIPLIER'].includes(String(row.budget_value_type)))
      unverified('An overlapping budget schedule row has no budget value.');
    overlapping.push({
      id: String(row.id),
      increase_native: increaseOf(row.budget_value_type, Number(row.budget_value), daily, currency),
    });
  }
  const days = new Set<string>();
  for (let t = start; t < end; t += hour) days.add(local(t, timezone).slice(0, 10));
  return {
    daily,
    increase,
    peak: daily + increase,
    overlapping,
    stacked: daily + increase + overlapping.reduce((n, x) => n + x.increase_native, 0),
    days: days.size,
    currency,
    timezone,
  };
}
function local(unix: number, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(unix * 1000))
      .map(x => [x.type, x.value]),
  );
  return parts.year + '-' + parts.month + '-' + parts.day + ' ' + parts.hour + ':' + parts.minute;
}
export function metaBudgetSchedulePrerequisites(p: CompiledRequest, states: unknown[]): void {
  const level = metaBudgetScheduleKind(p);
  if (!level) return;
  const s = states[0];
  if (!obj(s) || !obj(s.account) || !obj(s.object) || !Array.isArray(s.schedules))
    unverified('Missing verified budget schedule state.');
  const what = level === 'campaign' ? 'campaign' : 'ad set';
  if (s.account.capable !== true)
    unavailable("This ad account does not have Meta's CAN_USE_BUDGET_SCHEDULING_API capability.", {
      capability: 'CAN_USE_BUDGET_SCHEDULING_API',
    });
  if (!(Number(s.object.daily_budget) > 0) || s.object.lifetime_budget !== null)
    unavailable(
      'Budget scheduling works with daily budgets only, and this ' +
        what +
        (s.object.lifetime_budget !== null
          ? ' has a lifetime budget.'
          : ' has no daily budget of its own (its budget is set at another level).'),
    );
  if (s.object.smart_promotion_type === 'SMART_APP_PROMOTION')
    unavailable('Meta does not offer budget scheduling for Advantage+ App campaigns.');
  if (s.schedules.length >= maxPeriods)
    unavailable(
      'This ' + what + ' already has ' + s.schedules.length + ' high demand periods; Meta allows ' + maxPeriods + '.',
      {
        periods: s.schedules.length,
      },
    );
  const x = planned(p, s);
  if (x.peak > maxMultiple * x.daily)
    invalid(
      'Meta allows a total budget of at most 8 times the daily budget (' +
        maxMultiple * x.daily +
        ' native units here); this period would reach ' +
        x.peak +
        '.',
      {daily_budget_native: x.daily, peak_daily_budget_native: x.peak},
    );
}
export function metaBudgetScheduleImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const level = metaBudgetScheduleKind(p);
  if (!level) return;
  const s: JsonObject = obj(state[0]) ? state[0] : {},
    b = body(p),
    x = planned(p, s),
    node: JsonObject = obj(s.object) ? s.object : {};
  return {
    provider: 'meta',
    scope: 'budget_schedule',
    operation: 'create',
    target: {level, id: targetOf(p), name: node.name ?? null, status: node.status ?? null},
    timezone: x.timezone,
    starts: local(Number(b.time_start), x.timezone),
    ends: local(Number(b.time_end), x.timezone),
    duration_hours: (Number(b.time_end) - Number(b.time_start)) / hour,
    currency: x.currency || null,
    budget_value: b.budget_value,
    budget_value_type: b.budget_value_type,
    daily_budget_native: x.daily,
    increase_native: x.increase,
    peak_daily_budget_native: x.stacked,
    ...(x.overlapping.length ? {overlapping_periods: x.overlapping} : {}),
    days_touched: x.days,
    max_extra_spend_native: x.increase * x.days,
    existing_periods: Array.isArray(s.schedules) ? s.schedules.length : null,
    units:
      'Native units are the minor units Meta uses for daily_budget. ' +
      (b.budget_value_type === 'MULTIPLIER'
        ? 'A MULTIPLIER value is a percentage of the daily budget.'
        : 'An ABSOLUTE value is a whole amount of the account currency ("140 could be $140").'),
    may_affect_serving: true,
    effect:
      'From ' +
      local(Number(b.time_start), x.timezone) +
      ' to ' +
      local(Number(b.time_end), x.timezone) +
      ' (' +
      x.timezone +
      ') Meta raises the daily budget of this ' +
      (level === 'campaign' ? 'campaign' : 'ad set') +
      ' from ' +
      x.daily +
      ' to ' +
      x.peak +
      ' native units' +
      (x.overlapping.length
        ? ' (' +
          x.stacked +
          ' with the ' +
          x.overlapping.length +
          ' period(s) already scheduled over part of it, which the spending caps hold together)'
        : '') +
      ', then returns it to ' +
      x.daily +
      '. The most it can spend beyond the daily budget is ' +
      x.increase * x.days +
      ' native units (' +
      x.increase +
      ' on each of the ' +
      x.days +
      ' day(s) the period touches).',
    cancellation:
      "AMCP cannot cancel or change this period afterwards: Meta's API reference documents no update or delete for budget schedules (\"You can't perform this operation on this endpoint\"). Scheduled periods are reviewed and changed in Ads Manager (the campaign's or ad set's Budget scheduling). To stop the spending at once, pause the campaign or ad set with a reviewed AMCP change.",
    verification: 'Reads the schedule list again and compares the new period.',
    source,
  };
}
/**
 * The whole scheduled increase counts against the owner's caps: the budget during the period, with any period already
 * scheduled over part of it, against its old value.
 */
export function metaBudgetSchedulePolicyAmounts(p: CompiledRequest, before: unknown): PolicyAmounts | undefined {
  if (!metaBudgetScheduleKind(p)) return;
  const state = Array.isArray(before) ? before[0] : before,
    x = planned(p, state);
  if (!(x.daily > 0)) return {creating: false, amounts: [], old: []};
  return {
    creating: false,
    amounts: [{path: '/budget_schedules/daily_budget', key: 'daily_budget', amount: x.stacked}],
    old: [{path: '/daily_budget', key: 'daily_budget', amount: x.daily}],
  };
}
export function metaBudgetScheduleOutcome(_p: CompiledRequest, r: TransportResult): boolean {
  return r.status === 200 && obj(r.data) && numeric(String(r.data.id ?? ''));
}
export function metaBudgetScheduleVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const id = String(result.data?.id ?? '');
  if (!numeric(id)) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no budget schedule.');
  const b = body(p);
  return [
    {
      read: read(p, {id: targetOf(p), created: id}),
      expected: {
        period: {
          present: true,
          budget_value: b.budget_value,
          budget_value_type: b.budget_value_type,
          time_start: b.time_start,
          time_end: b.time_end,
        },
      },
      id: 'budget schedule ' + id,
    },
  ];
}
export function metaBudgetScheduleObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  const x = obj(data.period) ? data.period : {};
  return {
    period: x.present
      ? {
          present: true,
          budget_value: x.budget_value,
          budget_value_type: x.budget_value_type,
          time_start: x.time_start,
          time_end: x.time_end,
        }
      : {present: false},
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const metaBudgetScheduleFamily: ReviewedFamily = {
  name: 'meta_budget_schedules',
  files: ['src/meta-budget-schedules.ts', ['tests/meta-budget-schedules.test.mjs']],
  kind: metaBudgetScheduleKind,
  assert: plan => assertMetaBudgetSchedule(plan),
  scope: assertMetaBudgetScheduleScope,
  snapshots: metaBudgetScheduleSnapshots,
  isRead: isMetaBudgetScheduleRead,
  reader: readMetaBudgetSchedules,
  validateState: validateMetaBudgetScheduleState,
  prerequisites: metaBudgetSchedulePrerequisites,
  impact: metaBudgetScheduleImpact,
  outcome: metaBudgetScheduleOutcome,
  verification: metaBudgetScheduleVerification,
  observed: metaBudgetScheduleObserved,
  policyAmounts: metaBudgetSchedulePolicyAmounts,
  requiresSpendPolicy: true,
  spendConfirmation: {
    needed: () => true,
    message:
      'A scheduled budget increase raises spending during the period. Show the user the period in the account time zone and its maximum extra spend, then set spend_change_confirmed=true.',
  },
  exemptFromSpendTextMatch: true,
};
