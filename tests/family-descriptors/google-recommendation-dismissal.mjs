// google_recommendation_dismissal: POST /v25/customers/{id}/recommendations:dismiss (Google Ads API,
// RecommendationService.DismissRecommendation). Dismissal overwrites the recommendation's output-only `dismissed` flag;
// the review shows a recommendation that is not yet dismissed, so its current `dismissed` is the decisive field (one
// dismissed elsewhere in the meantime makes the reviewed dismissal stale).
import * as g from './_google-ads.mjs';

const recommendation = g.resource('recommendations', 'Budget_bid_1');

export default {
  family: 'google_recommendation_dismissal',
  risk: 'destructive',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: g.connection,
  credentials: g.credentials,
  request: {
    action: 'google_ads_v23_recommendation_dismiss_recommendation',
    payload: {operations: [{resourceName: recommendation}], partialFailure: false},
  },
  seed: () => ({
    // The family accepts only the customer fields it selects.
    customer: [{id: g.account, currencyCode: 'EGP', timeZone: 'Africa/Cairo', manager: false}],
    recommendation: [
      {
        resourceName: recommendation,
        type: 'CAMPAIGN_BUDGET',
        dismissed: false,
        campaignBudget: g.resource('campaignBudgets', '10'),
        campaigns: [g.resource('campaigns', '100'), g.resource('campaigns', '200')],
      },
    ],
  }),
  paginatedCodes: ['RECOMMENDATION_STATE_UNVERIFIED'],
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, body, state, mode} = request;
    if (g.isSearch(request)) return g.table(request);
    if (path === '/v25/customers/123/recommendations:dismiss') {
      if (mode.partial) return g.partialFailure();
      for (const op of body.operations)
        state.recommendation.find(r => r.resourceName === op.resourceName).dismissed = true;
      return {json: {results: body.operations.map(op => ({resourceName: op.resourceName}))}};
    }
  },
  decisive: {change: state => (state.recommendation[0].dismissed = true), field: /dismissed/},
};
