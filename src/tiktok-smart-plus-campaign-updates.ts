import {assertNoMethodOverride, object} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {defineFamily} from './family-kit.js';

/**
 * Upgraded Smart+ campaign edits, per API for Business v1.3 "Update an Upgraded Smart+ Campaign" and "Get Upgraded
 * Smart+ Campaigns" (checked 2026-09-26): the name, the campaign budget (the shared budget under campaign budget
 * optimization, or the limit on ad group budgets otherwise) and the PO number. Allowlist-only Goal-based budget
 * increase is outside this contract.
 */
export const tiktokSmartPlusCampaignUpdatePath = '/v1.3/smart_plus/campaign/update/';
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const emoji = /\p{Extended_Pictographic}/u;
const width = (s: string) => [...s].reduce((n, c) => n + (/[぀-ヿ㐀-鿿豈-﫿가-힯]/.test(c) ? 2 : 1), 0);

export const tiktokSmartPlusCampaignUpdateKind = (p: CompiledRequest) =>
  p.gateway === 'tiktok_native_action' && p.method === 'POST' && p.path === tiktokSmartPlusCampaignUpdatePath;

function invalid(field: string, message: string): never {
  throw new MirrorError('INVALID_TIKTOK_SMART_PLUS_CAMPAIGN_UPDATE', message, {field});
}

/** Validates the request before review; nothing here reads or contacts TikTok. */
export function assertTiktokSmartPlusCampaignUpdate(plan: CompiledRequest, body: JsonObject): void {
  const extra = Object.keys(body).find(
    k => !['advertiser_id', 'campaign_id', 'campaign_name', 'budget', 'po_number'].includes(k),
  );
  if (extra)
    invalid(
      extra,
      '"' +
        extra +
        '" is outside the qualified Smart+ campaign edit contract' +
        (extra === 'budget_auto_adjust_strategy' ? '; Goal-based budget increase is allowlist-only.' : '.'),
    );
  if (body.advertiser_id !== undefined && String(body.advertiser_id) !== plan.accountId)
    invalid('advertiser_id', 'advertiser_id must equal the selected advertiser.');
  if (typeof body.campaign_id !== 'string' || !/^[1-9][0-9]{0,31}$/.test(body.campaign_id))
    invalid('campaign_id', 'campaign_id must be the numeric ID of an Upgraded Smart+ campaign.');
  if (!['campaign_name', 'budget', 'po_number'].some(k => body[k] !== undefined))
    invalid('campaign_name', 'Send at least one of campaign_name, budget and po_number.');
  if (
    body.campaign_name !== undefined &&
    (typeof body.campaign_name !== 'string' ||
      !body.campaign_name.trim() ||
      width(body.campaign_name) > 512 ||
      emoji.test(body.campaign_name))
  )
    invalid(
      'campaign_name',
      'campaign_name must be nonempty, at most 512 characters (Chinese and Japanese count twice) and without emoji.',
    );
  if (
    body.budget !== undefined &&
    (typeof body.budget !== 'number' ||
      !Number.isFinite(body.budget) ||
      body.budget <= 0 ||
      Math.abs(body.budget * 100 - Math.round(body.budget * 100)) > 1e-9)
  )
    invalid('budget', 'budget must be a positive amount in the account currency with at most two decimals.');
  if (
    body.po_number !== undefined &&
    (typeof body.po_number !== 'string' ||
      !body.po_number.trim() ||
      [...body.po_number].length > 100 ||
      /[\x00-\x1f]/.test(body.po_number))
  )
    invalid('po_number', 'po_number must be text of at most 100 characters.');
}

export function tiktokSmartPlusCampaignUpdateRead(plan: CompiledRequest) {
  return {
    path: '/v1.3/smart_plus/campaign/get/',
    query: {
      advertiser_id: plan.accountId,
      filtering: {campaign_ids: [(plan.body as JsonObject).campaign_id]},
      page_size: 100,
    },
    action: 'tiktok_smart_plus_campaign_get',
  };
}
const campaignOf = (plan: CompiledRequest, state: unknown[]) =>
  state
    .flatMap(s => (obj(s) && obj(s.data) && Array.isArray(s.data.list) ? s.data.list : []))
    .find((r: JsonObject) => String(r?.campaign_id) === (plan.body as JsonObject).campaign_id) as
    JsonObject | undefined;
/** Against the normalized review state: the campaign exists, and a budget edit applies only to a campaign that has a budget. */
export function tiktokSmartPlusCampaignUpdateImpact(plan: CompiledRequest, state: unknown[]): JsonObject {
  const b = plan.body as JsonObject,
    c = campaignOf(plan, state);
  if (!c)
    throw new MirrorError(
      'STATE_TARGET_MISMATCH',
      'Smart+ campaign ' + b.campaign_id + ' was not returned for the selected advertiser.',
      {campaign_id: b.campaign_id},
    );
  if (
    b.budget !== undefined &&
    (c.budget_mode === 'BUDGET_MODE_INFINITE' || typeof c.budget !== 'number' || c.budget <= 0)
  )
    invalid(
      'budget',
      'Smart+ campaign ' +
        b.campaign_id +
        ' has no campaign budget (' +
        (c.budget_mode ?? 'no budget mode') +
        '); its budget mode cannot be changed after creation.',
    );
  const changes: JsonObject = {};
  for (const k of ['campaign_name', 'budget', 'po_number'])
    if (b[k] !== undefined) changes[k] = {before: c[k] ?? null, after: b[k]};
  const cbo = c.budget_optimize_on !== false;
  return {
    provider: 'tiktok',
    scope: 'smart_plus_campaign_edits',
    may_affect_serving: b.budget !== undefined,
    effect:
      b.budget !== undefined
        ? (cbo
            ? 'Replaces the shared campaign budget immediately'
            : "Replaces the limit on the total of this campaign's ad group budgets immediately") +
          (c.budget_auto_adjust_strategy === 'AUTO_BUDGET_INCREASE'
            ? '; with Goal-based budget increase the amount is the initial daily budget.'
            : '.')
        : 'Renames the campaign or changes its PO number; delivery is unchanged.',
    campaign: {
      campaign_id: b.campaign_id,
      budget_mode: c.budget_mode ?? null,
      campaign_budget_optimization: cbo,
      operation_status: c.operation_status ?? null,
    },
    changes,
    source: 'https://business-api.tiktok.com/portal/docs/update-an-upgraded-smart-campaign/v1.3',
  };
}
/** A budget edit is compared with the campaign's current budget under the owner spending policy. */
export function tiktokSmartPlusCampaignUpdatePolicyAmounts(plan: CompiledRequest, before: unknown) {
  if (!tiktokSmartPlusCampaignUpdateKind(plan)) return;
  const b = plan.body as JsonObject;
  if (b.budget === undefined) return {creating: false, amounts: [], old: []};
  const current = campaignOf(plan, Array.isArray(before) ? before : [])?.budget;
  if (typeof current !== 'number' || !Number.isFinite(current))
    throw new MirrorError(
      'POLICY_BASELINE_REQUIRED',
      'The current Smart+ campaign budget is not a finite native amount.',
      {field: '/budget'},
      409,
    );
  const key = 'campaign:' + b.campaign_id;
  return {
    creating: false,
    amounts: [{path: '/budget', key, amount: b.budget as number, decimal: String(b.budget)}],
    old: [{path: '/budget', key, amount: current, decimal: String(current)}],
  };
}
export function tiktokSmartPlusCampaignUpdateVerification(plan: CompiledRequest) {
  const b = plan.body as JsonObject,
    expected: JsonObject = {campaign_id: b.campaign_id};
  for (const k of ['campaign_name', 'budget', 'po_number']) if (b[k] !== undefined) expected[k] = b[k];
  return [
    {
      path: '/v1.3/smart_plus/campaign/get/',
      query: {advertiser_id: plan.accountId, filtering: {campaign_ids: [b.campaign_id]}, page_size: 100},
      expected,
      id: b.campaign_id as string,
    },
  ];
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokSmartPlusCampaignUpdateFamily: ReviewedFamily = defineFamily({
  name: 'tiktok_smart_plus_campaign_edits',
  files: ['src/tiktok-smart-plus-campaign-updates.ts', ['tests/tiktok-smart-plus-campaign-updates.test.mjs']],
  kind: tiktokSmartPlusCampaignUpdateKind,
  assert: (plan, gateway) => {
    assertNoMethodOverride(plan);
    gateway();
    assertTiktokSmartPlusCampaignUpdate(plan, object(plan.body));
  },
  snapshots: (plan, stateRead) => {
    const r = tiktokSmartPlusCampaignUpdateRead(plan),
      read = stateRead(r.path, r.query);
    read.action = r.action;
    return [read];
  },
  impact: tiktokSmartPlusCampaignUpdateImpact,
  verification: (plan, result, before, verificationRead) =>
    tiktokSmartPlusCampaignUpdateVerification(plan).map(v => ({
      ...v,
      read: {...verificationRead(v.path, v.query), action: 'tiktok_smart_plus_campaign_get'},
    })),
  policyAmounts: (plan, before) => tiktokSmartPlusCampaignUpdatePolicyAmounts(plan, before),
});
