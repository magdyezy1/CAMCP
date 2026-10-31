import type {AllocationDraft} from './report-source.js';
import {googleAllocationBudgets} from './google-allocation-budgets.js';

/**
 * Google Ads' native budget draft of an allocation preview (wave 4c round 6, w4c-arc6-reporting: moved from
 * src/allocation-plan.ts, which keeps the conversion, its checks and their order). A dedicated campaign budget is an
 * average daily budget, set by a campaign budget mutate of its budget resource. An allocation binding that names no
 * gateway is Google's: allocation drafts qualified Google campaign budgets first.
 */
export const googleAllocationDraft: AllocationDraft = Object.freeze<AllocationDraft>({
  // DEC-02: the evidence period, given only by the preview, for Google's Search budget-lost impression share.
  budgets: (store, call, actor, source, ids, _pricing, window) =>
    googleAllocationBudgets(store, call, actor, source, ids, window),
  averageDaily: true,
  entity: 'Campaign ',
  step: (_binding, t) => ({
    action: 'google_ads_v23_campaign_budget_mutate_campaign_budgets',
    payload: {
      operations: [
        {
          update: {resource_name: t.budget_resource, amount_micros: t.daily_budget_micros},
          update_mask: 'amount_micros',
        },
      ],
      partial_failure: false,
    },
  }),
  meaning:
    'Preview only. Daily amounts round down to the smallest unit of the account currency; residuals are shown. These are ongoing average daily budgets, not a scheduled period spending cap. Creating a draft does not approve or execute it.',
  fallback: true,
});
