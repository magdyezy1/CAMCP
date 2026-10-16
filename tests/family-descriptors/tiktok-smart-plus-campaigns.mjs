// tiktok_smart_plus_campaigns: POST /v1.3/smart_plus/campaign/create/ (API for Business v1.3, "Create an Upgraded
// Smart+ Campaign"), paused, with a campaign budget. TikTok reads the budget in the account currency, so the decisive
// field is the advertiser's `currency` in "Get advertiser info": a currency changed after the review changes what the
// reviewed budget amount means.
import {failed, ok} from './_tiktok.mjs';

export default {
  family: 'tiktok_smart_plus_campaigns',
  risk: 'budget',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {
    action: 'tiktok_smart_plus_campaign_create',
    payload: {
      request_id: '4242',
      operation_status: 'DISABLE',
      objective_type: 'WEB_CONVERSIONS',
      sales_destination: 'WEBSITE',
      campaign_name: 'Autumn web',
      budget_optimize_on: true,
      budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
      budget: 50,
    },
  },
  seed: () => ({
    advertiser: {advertiser_id: '123', name: 'Advertiser', currency: 'SAR', timezone: 'Asia/Riyadh'},
    campaigns: 0,
  }),
  unpaginated: 'GET /v1.3/advertiser/info/ returns the named advertisers in one list without page_info or a cursor',
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/smart_plus/campaign/create/'),
  provider({method, path, body, state, mode}) {
    if (method === 'GET' && path.endsWith('/v1.3/advertiser/info/')) return ok({list: [{...state.advertiser}]});
    if (method === 'POST' && path.endsWith('/v1.3/smart_plus/campaign/create/')) {
      if (mode.partial) return failed('Budget below minimum');
      const {advertiser_id: _, request_id: __, ...campaign} = body;
      return ok({...campaign, campaign_id: String(8000 + ++state.campaigns)});
    }
  },
  decisive: {change: state => (state.advertiser.currency = 'USD'), field: /currency/},
};
