// google_recommendation_apply: POST /v25/customers/{id}/recommendations:apply (Google Ads API,
// RecommendationService.ApplyRecommendation) for a CAMPAIGN_BUDGET recommendation. Applying it overwrites the
// recommendation's campaign budget `amount_micros` with `newBudgetAmountMicros`; the budget's current amount, which the
// review shows as the amount being replaced and which the owner's budget limits compare against, is the decisive field.
import * as g from './_google-ads.mjs';

const recommendation = g.resource('recommendations', 'Budget_rec_1'),
  budget = g.resource('campaignBudgets', '10');

export default {
  family: 'google_recommendation_apply',
  risk: 'budget',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: g.connection,
  credentials: g.credentials,
  request: {
    action: 'google_ads_v23_recommendation_apply_recommendation',
    payload: {
      operations: [{resourceName: recommendation, campaignBudget: {newBudgetAmountMicros: '60000000'}}],
    },
  },
  seed: () => ({
    recommendation: [
      {
        resourceName: recommendation,
        type: 'CAMPAIGN_BUDGET',
        dismissed: false,
        campaign: g.resource('campaigns', '100'),
        campaignBudget: budget,
        campaignBudgetRecommendation: {
          recommendedBudgetAmountMicros: '70000000',
          currentBudgetAmountMicros: '50000000',
        },
      },
    ],
    campaign_budget: [
      {resourceName: budget, amountMicros: '50000000', status: 'ENABLED', explicitlyShared: false, period: 'DAILY'},
    ],
  }),
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, body, state, mode} = request;
    if (g.isSearch(request)) return g.table(request);
    if (path === '/v25/customers/123/recommendations:apply') {
      if (mode.partial) return g.partialFailure();
      for (const op of body.operations) {
        const rec = state.recommendation.find(r => r.resourceName === op.resourceName);
        state.campaign_budget.find(b => b.resourceName === rec.campaignBudget).amountMicros =
          op.campaignBudget.newBudgetAmountMicros;
      }
      return {json: {results: body.operations.map(op => ({resourceName: op.resourceName}))}};
    }
  },
  decisive: {change: state => (state.campaign_budget[0].amountMicros = '55000000'), field: /amountMicros/},
};
