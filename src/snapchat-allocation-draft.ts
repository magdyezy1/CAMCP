import type {AllocationDraft} from './report-source.js';
import {bad} from './workspace-core.js';
import {snapchatAllocationBudgets} from './snapchat-allocation-budgets.js';

/**
 * Snapchat's native budget draft of an allocation preview (wave 4c round 6, w4c-arc6-reporting: moved from
 * src/allocation-plan.ts, which keeps the conversion, its checks and their order). An ad squad's daily budget is in
 * native micros, at least Snapchat's documented minimum, set by an update of the ad squad under the parent campaign
 * its report was read in.
 */
export const snapchatAllocationDraft: AllocationDraft = Object.freeze<AllocationDraft>({
  budgets: (store, call, actor, source, ids) => snapchatAllocationBudgets(store, call, actor, source, ids),
  source: report => ({parent_campaign_id: report.source_request.path_params.campaign_id}),
  sourceChanged: (report, binding) => report.source_request?.path_params?.campaign_id !== binding.parent_campaign_id,
  daily(daily) {
    if (daily < 5000000n)
      bad(
        'Every Snapchat daily budget must meet the documented minimum of 5000000 native micros.',
        'ALLOCATION_PRECISION',
      );
  },
  entity: 'Ad squad ',
  step: (binding, t) => ({
    action: 'snapchat_adsquad_update',
    path_params: {campaign_id: binding.parent_campaign_id, ad_squad_id: t.entity_id},
    payload: [{op: 'replace', path: '/daily_budget_micro', value: Number(t.daily_budget_micros)}],
  }),
  meaning:
    'Preview only. Daily amounts round down to the smallest unit of the account currency; residuals are shown. These are ongoing daily budgets, not a scheduled period spending cap. Creating a draft does not approve or execute it.',
});
