import type {AllocationDraft} from './report-source.js';
import {bad} from './workspace-core.js';
import {metaCurrencyOffset} from './budget-units.js';
import {metaAllocationBudgets} from './meta-allocation-budgets.js';

/**
 * Meta's native budget draft of an allocation preview (wave 4c round 6, w4c-arc6-reporting: moved from
 * src/allocation-plan.ts, which keeps the conversion, its checks and their order). Each daily budget is set on its
 * current owner, the campaign or its one spending ad set, in whole Meta minor units of the account currency.
 */
export const metaAllocationDraft: AllocationDraft = Object.freeze<AllocationDraft>({
  budgets: (store, call, actor, source, ids) => metaAllocationBudgets(store, call, actor, source, ids),
  // DEC-02: Meta counts budgets in whole minor units of its pinned per-currency offset; refused before any read without
  // one.
  minorUnits(currency) {
    const offset = metaCurrencyOffset(currency);
    if (offset === undefined)
      bad(
        'Meta budgets count in the account currency’s minor unit, and AMCP has no pinned Meta offset for this currency. Pin Meta’s currency table before converting an allocation; nothing was read or saved.',
        'ALLOCATION_PRECISION',
        {currency},
      );
    return offset;
  },
  entity: 'Campaign ',
  owner: t => (t.budget_owner === 'ad_set' ? ' (ad set ' + t.adset_id + ')' : ''),
  nativeAmount: t => ' (' + t.daily_budget_native + ' in Meta minor units)',
  // DEC-02: the budget owner's own reviewed Meta update; the amount is exact Meta minor units.
  step: (_binding, t) =>
    t.budget_owner === 'ad_set'
      ? {
          action: 'meta_ad_set_id_update',
          path_params: {ad_set_id: t.adset_id},
          payload: {daily_budget: t.daily_budget_native},
        }
      : {
          action: 'meta_campaign_id_update',
          path_params: {campaign_id: t.campaign_id},
          payload: {daily_budget: t.daily_budget_native},
        },
  meaning:
    'Preview only. Each Meta daily budget is set on its current owner: the campaign when it has a campaign daily budget, otherwise its one spending ad set. Amounts are whole Meta minor units of the account currency, rounded down; residuals are shown. Meta can spend up to 75% more than a daily budget on a day with better opportunities and at most seven times it over a calendar week. Daily budgets remain in effect until changed; this draft sets no end date and does not approve or execute any change.',
});
