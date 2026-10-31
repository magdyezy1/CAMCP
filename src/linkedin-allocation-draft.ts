import type {AllocationDraft} from './report-source.js';
import {bad} from './workspace-core.js';
import {currencyText} from './budget-units.js';
import {linkedinStoredVersion} from './linkedin-version.js';
import {linkedinAllocationBudgets} from './linkedin-allocation-budgets.js';

/**
 * LinkedIn's native budget draft of an allocation preview (wave 4c round 6, w4c-arc6-reporting: moved from
 * src/allocation-plan.ts, which keeps the conversion, its checks and their order). An independent campaign's daily
 * budget is a decimal amount in the account currency, within the daily budget limits LinkedIn states for the account,
 * set by a partial update of the campaign at the API version the draft binds.
 */
export const linkedinAllocationDraft: AllocationDraft = Object.freeze<AllocationDraft>({
  // `pricing` is false where the preview already priced LinkedIn's daily limits: one pricing read per draft.
  budgets: (store, call, actor, source, ids, pricing) =>
    linkedinAllocationBudgets(store, call, actor, source, ids, pricing),
  // A saved report's version is reused while reviewed; a sunset (or soon sunset) one moves to the current version.
  source: report => ({api_version: linkedinStoredVersion(report.source_request?.api_version)}),
  daily(daily, {entity_id, currency, limits}) {
    if (
      limits?.status === 'checked' &&
      (daily < BigInt(limits.min_micros) || (limits.max_micros !== null && daily > BigInt(limits.max_micros)))
    )
      bad(
        'A converted daily budget is outside the daily budget limits LinkedIn states for this account. Adjust the model bounds.',
        'ALLOCATION_BUDGET_LIMIT',
        {
          entity_id,
          daily_budget: currencyText(daily, currency),
          minimum: limits.min,
          maximum: limits.max,
          currency,
        },
      );
  },
  name: native => native.campaign.name,
  entity: 'Campaign ',
  step: (binding, t) => ({
    action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_campaign_id_post',
    api_version: binding.api_version,
    restli_method: 'PARTIAL_UPDATE',
    path_params: {ad_account_id: binding.account_id, campaign_id: t.campaign_id},
    payload: {patch: {$set: {dailyBudget: {amount: t.daily_budget, currencyCode: binding.currency}}}},
  }),
  meaning:
    'Preview only. LinkedIn native daily budgets use decimal account-currency amounts, rounded down to the smallest unit of the currency and checked against LinkedIn’s daily budget limits for the account when it states them. Rounding residuals are shown. Daily settings remain in effect until changed, and LinkedIn can charge up to 150% of a daily budget on a day with strong auction opportunities. Existing group caps are preserved. This draft sets no end date or automatic period spending cap, and does not approve or execute any change.',
});
