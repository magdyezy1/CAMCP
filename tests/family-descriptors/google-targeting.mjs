// google_targeting: POST /v25/customers/{id}/campaignCriteria:mutate (Google Ads API, CampaignCriterion). The update
// overwrites a location criterion's `bid_modifier`, the multiplier on every bid the campaign places for that location,
// so the criterion's current `bid_modifier` is the decisive field.
import * as g from './_google-ads.mjs';

const criterion = g.resource('campaignCriteria', '100~2818'),
  campaign = g.resource('campaigns', '100');

export default {
  family: 'google_targeting',
  risk: 'budget',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: g.connection,
  credentials: g.credentials,
  request: {
    action: 'google_ads_v23_campaign_criterion_mutate_campaign_criteria',
    payload: {operations: [{update: {resourceName: criterion, bidModifier: 1.2}, updateMask: 'bid_modifier'}]},
  },
  seed: () => ({
    campaign_criterion: [
      {
        resourceName: criterion,
        campaign,
        type: 'LOCATION',
        negative: false,
        status: 'ENABLED',
        bidModifier: 1.1,
        location: {geoTargetConstant: 'geoTargetConstants/2818'},
      },
    ],
  }),
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, body, state, mode} = request;
    if (g.isSearch(request)) return g.table(request);
    if (path === '/v25/customers/123/campaignCriteria:mutate') {
      if (mode.partial) return g.partialFailure();
      for (const op of body.operations) {
        const {resourceName, ...fields} = op.update;
        Object.assign(
          state.campaign_criterion.find(c => c.resourceName === resourceName),
          fields,
        );
      }
      return {json: {results: body.operations.map(op => ({resourceName: op.update.resourceName}))}};
    }
  },
  decisive: {change: state => (state.campaign_criterion[0].bidModifier = 1.4), field: /bidModifier|bid_modifier/},
};
