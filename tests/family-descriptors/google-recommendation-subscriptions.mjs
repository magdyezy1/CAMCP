// google_recommendation_subscriptions: POST
// /v25/customers/{id}/recommendationSubscriptions:mutateRecommendationSubscription (Google Ads API,
// RecommendationSubscription). Enabling a subscription lets Google apply recommendations of that type to the
// campaigns automatically; the update overwrites the subscription's `status`, its decisive field.
import * as g from './_google-ads.mjs';

const subscription = g.resource('recommendationSubscriptions', 'CAMPAIGN_BUDGET');

export default {
  family: 'google_recommendation_subscriptions',
  risk: 'activation',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: g.connection,
  credentials: g.credentials,
  request: {
    action: 'google_ads_v23_recommendation_subscription_mutate_recommendation_subscription',
    payload: {operations: [{update: {resourceName: subscription, status: 'ENABLED'}, updateMask: 'status'}]},
  },
  seed: () => ({
    recommendation_subscription: [
      {resourceName: subscription, type: 'CAMPAIGN_BUDGET', status: 'PAUSED'},
      {resourceName: g.resource('recommendationSubscriptions', 'KEYWORD'), type: 'KEYWORD', status: 'PAUSED'},
    ],
  }),
  // The family reads the subscriptions in one unpaged search and names its own refusal for another page.
  paginatedCodes: ['SUBSCRIPTION_STATE_UNVERIFIED'],
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, body, state, mode} = request;
    if (g.isSearch(request)) return g.table(request);
    if (path === '/v25/customers/123/recommendationSubscriptions:mutateRecommendationSubscription') {
      if (mode.partial) return g.partialFailure();
      for (const op of body.operations)
        state.recommendation_subscription.find(s => s.resourceName === op.update.resourceName).status =
          op.update.status;
      return {json: {results: body.operations.map(op => ({resourceName: op.update.resourceName}))}};
    }
  },
  // Someone enabled it elsewhere after the review, so the review's "from PAUSED" no longer holds. A status has two
  // values, and the family refuses a change to the status it already has while it reads the state again at execute.
  decisive: {
    change: state => (state.recommendation_subscription[0].status = 'ENABLED'),
    field: /status/,
    refusal: {
      code: 'INVALID_GOOGLE_RECOMMENDATION_SUBSCRIPTION',
      message: /CAMPAIGN_BUDGET subscription is already ENABLED/,
    },
  },
};
