import {assertNoMethodOverride, object} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * Upgraded Smart+ ad group budget updates, per API for Business v1.3 "Update the budgets of Upgraded Smart+ Ad
 * Groups" and "Get Upgraded Smart+ Ad Groups" (checked 2026-09-26). `budget` changes take effect immediately for up
 * to 20 ad groups; `scheduled_budget` is allowlist-only and outside this contract. With Goal-based budget increase
 * (AUTO_BUDGET_INCREASE) the budget is the initial daily budget that TikTok may raise during the day.
 */
export const tiktokSmartPlusBudgetPath = '/v1.3/smart_plus/adgroup/budget/update/';
const getPath = '/v1.3/smart_plus/adgroup/get/';
const modes = ['BUDGET_MODE_TOTAL', 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET'];
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown) => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);

export const tiktokSmartPlusBudgetKind = (p: CompiledRequest) =>
  p.gateway === 'tiktok_native_action' && p.method === 'POST' && p.path === tiktokSmartPlusBudgetPath;

function invalid(field: string, message: string): never {
  throw new MirrorError('INVALID_TIKTOK_SMART_PLUS_BUDGET', message, {field});
}
const rowsOf = (plan: CompiledRequest) =>
  ((plan.body as JsonObject).budget as JsonObject[]).map(r => ({
    adgroup_id: String(r.adgroup_id),
    value: r.budget as number,
  }));

/** Validates the request before review; nothing here reads or contacts TikTok. */
export function assertTiktokSmartPlusBudget(plan: CompiledRequest, body: JsonObject): void {
  const extra = Object.keys(body).find(k => !['advertiser_id', 'budget'].includes(k));
  if (extra)
    invalid(
      extra,
      '"' +
        extra +
        '" is outside the qualified Smart+ budget contract' +
        (extra === 'scheduled_budget' ? '; scheduled Smart+ budgets are allowlist-only.' : '.'),
    );
  if (body.advertiser_id !== undefined && String(body.advertiser_id) !== plan.accountId)
    invalid('advertiser_id', 'advertiser_id must equal the selected advertiser.');
  const rows = body.budget;
  if (!Array.isArray(rows) || !rows.length || rows.length > 20)
    invalid('budget', 'budget must list 1 to 20 ad groups.');
  const seen = new Set<string>();
  rows.forEach((r: unknown, i: number) => {
    if (!obj(r)) invalid('budget/' + i, 'Each entry must be an object.');
    const bad = Object.keys(r).find(k => !['adgroup_id', 'budget'].includes(k));
    if (bad) invalid('budget/' + i + '/' + bad, '"' + bad + '" is outside the qualified Smart+ budget contract.');
    if (!numeric(r.adgroup_id)) invalid('budget/' + i + '/adgroup_id', 'adgroup_id must be a numeric TikTok ID.');
    if (seen.has(r.adgroup_id)) invalid('budget/' + i + '/adgroup_id', 'Each ad group may appear once.');
    seen.add(r.adgroup_id);
    const v = r.budget;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || Math.abs(v * 100 - Math.round(v * 100)) > 1e-9)
      invalid('budget/' + i + '/budget', 'budget must be a positive number with at most two decimals.');
  });
}

export function tiktokSmartPlusBudgetRead(plan: CompiledRequest) {
  return {
    path: getPath,
    query: {
      advertiser_id: plan.accountId,
      filtering: {adgroup_ids: rowsOf(plan).map(r => r.adgroup_id)},
      page_size: 100,
    },
    action: 'tiktok_smart_plus_adgroup_get',
  };
}
const current = (state: unknown[]) =>
  state.flatMap(s => (obj(s) && obj(s.data) && Array.isArray(s.data.list) ? s.data.list : [])) as JsonObject[];
/** Against the normalized review state: each ad group exists and has its own lifetime or dynamic daily budget. */
export function tiktokSmartPlusBudgetImpact(plan: CompiledRequest, state: unknown[]): JsonObject {
  const groups = current(state);
  const changes = rowsOf(plan).map(r => {
    const g = groups.find(x => String(x.adgroup_id) === r.adgroup_id);
    if (!g)
      throw new MirrorError(
        'STATE_TARGET_MISMATCH',
        'Smart+ ad group ' + r.adgroup_id + ' was not returned for the selected advertiser.',
        {adgroup_id: r.adgroup_id},
      );
    if (!modes.includes(g.budget_mode) || typeof g.budget !== 'number' || !Number.isFinite(g.budget) || g.budget <= 0)
      invalid(
        'budget',
        'Smart+ ad group ' +
          r.adgroup_id +
          ' has no ad group budget of its own (' +
          (g.budget_mode ?? 'no budget mode') +
          '); campaign-budget-optimized ad groups need their campaign budget changed instead.',
      );
    return {
      adgroup_id: r.adgroup_id,
      name: g.adgroup_name ?? null,
      budget_mode: g.budget_mode,
      before: g.budget,
      after: r.value,
      ...(g.budget_auto_adjust_strategy === 'AUTO_BUDGET_INCREASE'
        ? {
            goal_based_increase:
              'The new amount is the initial daily budget; TikTok may raise spend by 20% steps, up to 10 times a day, and resets it daily.',
          }
        : {}),
    };
  });
  return {
    provider: 'tiktok',
    scope: 'smart_plus_adgroup_budgets',
    may_affect_serving: true,
    effect: 'Replaces the budgets of the listed Upgraded Smart+ ad groups immediately.',
    changes,
    source: 'https://business-api.tiktok.com/portal/docs/update-the-budgets-of-upgraded-smart-ad-groups/v1.3',
  };
}
/** Each new amount is compared with its own ad group's current budget under the owner spending policy. */
export function tiktokSmartPlusBudgetPolicyAmounts(plan: CompiledRequest, before: unknown) {
  if (!tiktokSmartPlusBudgetKind(plan)) return;
  const groups = current(Array.isArray(before) ? before : []),
    rows = rowsOf(plan);
  const amount = (path: string, key: string, v: unknown) => {
    if (typeof v !== 'number' || !Number.isFinite(v))
      throw new MirrorError(
        'POLICY_BASELINE_REQUIRED',
        'The current Smart+ ad group budget is not a finite native amount.',
        {field: path},
        409,
      );
    return {path, key, amount: v, decimal: String(v)};
  };
  return {
    creating: false,
    amounts: rows.map((r, i) => amount('/budget/' + i + '/budget', 'adgroup:' + r.adgroup_id, r.value)),
    old: rows.map((r, i) =>
      amount(
        '/budget/' + i + '/budget',
        'adgroup:' + r.adgroup_id,
        groups.find(x => String(x.adgroup_id) === r.adgroup_id)?.budget,
      ),
    ),
  };
}
/** One read per ad group confirms the new budget. */
export function tiktokSmartPlusBudgetVerification(plan: CompiledRequest) {
  return rowsOf(plan).map(r => ({
    path: getPath,
    query: {advertiser_id: plan.accountId, filtering: {adgroup_ids: [r.adgroup_id]}, page_size: 100},
    expected: {adgroup_id: r.adgroup_id, budget: r.value},
    id: r.adgroup_id,
  }));
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokSmartPlusBudgetFamily: ReviewedFamily = {
  name: 'tiktok_smart_plus_budgets',
  files: ['src/tiktok-smart-plus-budgets.ts', ['tests/tiktok-smart-plus-budgets.test.mjs']],
  kind: tiktokSmartPlusBudgetKind,
  assert: (plan, gateway) => {
    assertNoMethodOverride(plan);
    gateway();
    assertTiktokSmartPlusBudget(plan, object(plan.body));
  },
  snapshots: (plan, stateRead) => {
    const r = tiktokSmartPlusBudgetRead(plan),
      read = stateRead(r.path, r.query);
    read.action = r.action;
    return [read];
  },
  impact: tiktokSmartPlusBudgetImpact,
  verification: (plan, result, before, verificationRead) =>
    tiktokSmartPlusBudgetVerification(plan).map(v => ({
      ...v,
      read: {...verificationRead(v.path, v.query), action: 'tiktok_smart_plus_adgroup_get'},
    })),
  policyAmounts: (plan, before) => tiktokSmartPlusBudgetPolicyAmounts(plan, before),
};
