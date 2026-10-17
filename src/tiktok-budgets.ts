import {assertNoMethodOverride, object} from './write-common.js';
import {normalizeAccount} from './account-id.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * TikTok manual ad group budget updates, per API for Business v1.3 "Update the budgets of manual ad groups" and
 * "Get ad groups" (checked 2026-09-26). `budget` sets lifetime budgets immediately; `scheduled_budget` schedules a
 * daily or dynamic daily budget from 00:00 the next day in the account time zone. Both accept up to 20 ad groups.
 * Campaign-budget-optimized and Smart+ ad groups, and campaign budgets, are outside this contract.
 */
export const tiktokBudgetPath = '/v1.3/adgroup/budget/update/';
type Field = 'budget' | 'scheduled_budget';
const modes: Record<Field, string[]> = {
  budget: ['BUDGET_MODE_TOTAL'],
  scheduled_budget: ['BUDGET_MODE_DAY', 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET'],
};
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const digits = (v: unknown) => typeof v === 'string' && /^\d{1,32}$/.test(v);

export const tiktokBudgetKind = (p: CompiledRequest) =>
  p.gateway === 'tiktok_native_action' && p.method === 'POST' && p.path === tiktokBudgetPath;

function invalid(field: string, message: string): never {
  throw new MirrorError('INVALID_TIKTOK_BUDGET', message, {field});
}
function request(plan: CompiledRequest): {field: Field; rows: {adgroup_id: string; value: number}[]} {
  const b = plan.body as JsonObject,
    field: Field = b.budget !== undefined ? 'budget' : 'scheduled_budget';
  return {
    field,
    rows: (b[field] as JsonObject[]).map(r => ({adgroup_id: String(r.adgroup_id), value: r[field] as number})),
  };
}

/** Validates the request before review; nothing here reads or contacts TikTok. */
export function assertTiktokBudget(plan: CompiledRequest, body: JsonObject): void {
  const extra = Object.keys(body).find(k => !['advertiser_id', 'budget', 'scheduled_budget'].includes(k));
  if (extra) invalid(extra, '"' + extra + '" is outside the qualified budget contract.');
  if (body.advertiser_id !== undefined && String(body.advertiser_id) !== plan.accountId)
    invalid('advertiser_id', 'advertiser_id must equal the selected advertiser.');
  if ((body.budget === undefined) === (body.scheduled_budget === undefined))
    invalid('budget', 'Send exactly one of budget (lifetime) and scheduled_budget (next-day daily).');
  const field: Field = body.budget !== undefined ? 'budget' : 'scheduled_budget',
    rows = body[field];
  if (!Array.isArray(rows) || !rows.length || rows.length > 20) invalid(field, field + ' must list 1 to 20 ad groups.');
  const seen = new Set<string>();
  rows.forEach((r: unknown, i: number) => {
    if (!obj(r)) invalid(field + '/' + i, 'Each entry must be an object.');
    const bad = Object.keys(r).find(k => !['adgroup_id', field].includes(k));
    if (bad) invalid(field + '/' + i + '/' + bad, '"' + bad + '" is outside the qualified budget contract.');
    if (!digits(r.adgroup_id)) invalid(field + '/' + i + '/adgroup_id', 'adgroup_id must be a numeric TikTok ID.');
    if (seen.has(r.adgroup_id)) invalid(field + '/' + i + '/adgroup_id', 'Each ad group may appear once.');
    seen.add(r.adgroup_id);
    const v = r[field];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || Math.abs(v * 100 - Math.round(v * 100)) > 1e-9)
      invalid(field + '/' + i + '/' + field, field + ' must be a positive amount with at most two decimals.');
  });
}

export const tiktokBudgetAdgroupIds = (plan: CompiledRequest) => request(plan).rows.map(r => r.adgroup_id);

const rowsOf = (state: unknown[]) =>
  state.flatMap(s => (obj(s) && obj(s.data) && Array.isArray(s.data.list) ? s.data.list : [])) as JsonObject[];

/** Against the normalized review state: manual ad groups in the budget mode the chosen field applies to. */
export function tiktokBudgetImpact(plan: CompiledRequest, state: unknown[]): JsonObject {
  const {field, rows} = request(plan),
    current = rowsOf(state);
  const changes = rows.map(r => {
    const g = current.find(x => String(x.adgroup_id) === r.adgroup_id);
    if (!g)
      throw new MirrorError('STATE_TARGET_MISMATCH', 'The ad group was not returned for the selected advertiser.', {
        adgroup_id: r.adgroup_id,
      });
    if (g.campaign_automation_type !== undefined && g.campaign_automation_type !== 'MANUAL')
      invalid(
        field,
        'Ad group ' +
          r.adgroup_id +
          ' belongs to a ' +
          g.campaign_automation_type +
          ' campaign; this endpoint updates manual ad groups only.',
      );
    if (g.budget_mode === 'BUDGET_MODE_INFINITE')
      invalid(
        field,
        'Ad group ' + r.adgroup_id + ' uses campaign budget optimization; change the campaign budget instead.',
      );
    if (!modes[field].includes(g.budget_mode))
      invalid(
        field,
        (field === 'budget'
          ? 'Lifetime budget updates need BUDGET_MODE_TOTAL'
          : 'Scheduled budgets need a daily or dynamic daily budget mode') +
          '; ad group ' +
          r.adgroup_id +
          ' is ' +
          g.budget_mode +
          '.',
      );
    return {
      adgroup_id: r.adgroup_id,
      budget_mode: g.budget_mode,
      before: g.budget ?? null,
      after: r.value,
      ...(field === 'scheduled_budget' ? {scheduled_before: g.scheduled_budget ?? null} : {}),
    };
  });
  return {
    provider: 'tiktok',
    effect:
      field === 'budget'
        ? 'Replaces lifetime ad group budgets immediately.'
        : "Schedules daily ad group budgets that take effect from 00:00 tomorrow in the ad account time zone; today's budget is unchanged.",
    changes,
    may_affect_serving: true,
    source: 'https://business-api.tiktok.com/portal/docs/update-the-budgets-of-ad-groups/v1.3',
  };
}

/** Each new amount is compared with its own ad group's current budget under the owner spending policy. */
export function tiktokBudgetPolicyAmounts(plan: CompiledRequest, before: unknown) {
  if (!tiktokBudgetKind(plan)) return;
  const {field, rows} = request(plan),
    current = rowsOf(Array.isArray(before) ? before : []);
  const amount = (path: string, key: string, v: unknown) => {
    if (typeof v !== 'number' || !Number.isFinite(v))
      throw new MirrorError(
        'POLICY_BASELINE_REQUIRED',
        'The current ad group budget is not a finite native amount.',
        {field: path},
        409,
      );
    return {path, key, amount: v, decimal: String(v)};
  };
  return {
    creating: false,
    amounts: rows.map((r, i) => amount('/' + field + '/' + i + '/' + field, 'adgroup:' + r.adgroup_id, r.value)),
    old: rows.map((r, i) =>
      amount(
        '/' + field + '/' + i + '/' + field,
        'adgroup:' + r.adgroup_id,
        current.find(x => String(x.adgroup_id) === r.adgroup_id)?.budget,
      ),
    ),
  };
}

/** One read per ad group confirms the lifetime budget or the next-day scheduled budget. */
export function tiktokBudgetVerification(
  plan: CompiledRequest,
): {path: string; query: JsonObject; expected: JsonObject; id: string}[] {
  const {field, rows} = request(plan);
  return rows.map(r => ({
    path: '/v1.3/adgroup/get/',
    query: {advertiser_id: plan.accountId, filtering: {adgroup_ids: [r.adgroup_id]}, page_size: 100},
    expected: {adgroup_id: r.adgroup_id, [field]: r.value},
    id: r.adgroup_id,
  }));
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokBudgetFamily: ReviewedFamily = {
  name: 'tiktok_budgets',
  files: ['src/tiktok-budgets.ts', ['tests/tiktok-budgets.test.mjs']],
  kind: tiktokBudgetKind,
  assert: (plan, gateway) => {
    assertNoMethodOverride(plan);
    gateway();
    assertTiktokBudget(plan, object(plan.body));
  },
  snapshots: (plan, stateRead) => {
    const id = normalizeAccount(plan.gateway, plan.accountId!);
    const read = stateRead('/v1.3/adgroup/get/', {
      advertiser_id: id,
      filtering: {adgroup_ids: tiktokBudgetAdgroupIds(plan)},
      page_size: 100,
    });
    read.action = 'tiktok_adgroup_get';
    return [read];
  },
  impact: tiktokBudgetImpact,
  verification: (plan, result, before, verificationRead) =>
    tiktokBudgetVerification(plan).map(v => ({
      ...v,
      read: {...verificationRead(v.path, v.query), action: 'tiktok_adgroup_get'},
    })),
  policyAmounts: (plan, before) => tiktokBudgetPolicyAmounts(plan, before),
};
