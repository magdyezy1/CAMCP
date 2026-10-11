// google_campaign_drafts: POST /v25/customers/{id}/campaignDrafts/{base~draft}:promote (Google Ads API,
// CampaignDraftService.PromoteCampaignDraft). Promotion writes the draft's changes onto its base campaign, so the
// decisive field is the base campaign's `status`: the changes start serving at once when the base serves, and the
// review states which. (A draft promoted, removed or put under an experiment after the review is refused first.)
import * as g from './_google-ads.mjs';

const base = g.resource('campaigns', '1001'),
  draft = g.resource('campaignDrafts', '1001~11');

export default {
  family: 'google_campaign_drafts',
  risk: 'activation',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: g.connection,
  credentials: g.credentials,
  request: {
    action: 'google_ads_v23_campaign_draft_promote_campaign_draft',
    path_params: {campaign_draft: draft},
    payload: {},
  },
  seed: () => ({
    customer: [{resourceName: 'customers/123', id: '123', manager: false}],
    campaign: [
      {
        resourceName: base,
        id: '1001',
        name: 'Search brand',
        status: 'PAUSED',
        advertisingChannelType: 'SEARCH',
        experimentType: 'BASE',
      },
    ],
    campaign_draft: [
      {
        resourceName: draft,
        draftId: '11',
        baseCampaign: base,
        name: 'Existing draft',
        draftCampaign: g.resource('campaigns', '5011'),
        status: 'PROPOSED',
        hasExperimentRunning: false,
      },
    ],
  }),
  paginatedCodes: ['CAMPAIGN_DRAFT_STATE_UNVERIFIED'],
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, state, mode} = request;
    if (g.isSearch(request)) return g.table(request);
    if (path === '/v25/customers/123/campaignDrafts/1001~11:promote') {
      // A failed answer: the long-running operation ended with an error.
      if (mode.partial)
        return {json: {name: 'customers/123/operations/op-11', done: true, error: {code: 3, message: 'Synthetic'}}};
      state.campaign_draft[0].status = 'PROMOTED';
      return {json: {name: 'customers/123/operations/op-11', done: false}};
    }
  },
  decisive: {change: state => (state.campaign[0].status = 'ENABLED'), field: /status/},
};
