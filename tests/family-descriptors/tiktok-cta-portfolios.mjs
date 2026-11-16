// tiktok_cta_portfolios: POST /v1.3/creative/portfolio/create/ (API for Business v1.3, "Create a portfolio") of
// type CTA. The portfolio depends only on the advertiser it is created in, so the decisive field is the advertiser's
// `status` in "Get advertiser info": an advertiser whose status changed after the review is not the reviewed one.
import {failed, ok} from './_tiktok.mjs';

export default {
  family: 'tiktok_cta_portfolios',
  risk: 'settings',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {
    action: 'tiktok_creative_portfolio_create',
    payload: {
      creative_portfolio_type: 'CTA',
      portfolio_content: [{asset_content: 'Learn more', asset_ids: ['201781']}],
    },
  },
  seed: () => ({
    advertiser: {advertiser_id: '123', name: 'Advertiser', timezone: 'Asia/Riyadh', status: 'STATUS_ENABLE'},
    portfolios: 0,
  }),
  unpaginated: 'GET /v1.3/advertiser/info/ returns the named advertisers in one list without page_info or a cursor',
  partialCodes: ['PLATFORM_ERROR', 'WRITE_REJECTED'],
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/creative/portfolio/create/'),
  provider({method, path, state, mode}) {
    if (method === 'GET' && path.endsWith('/v1.3/advertiser/info/')) return ok({list: [{...state.advertiser}]});
    if (method === 'POST' && path.endsWith('/v1.3/creative/portfolio/create/')) {
      if (mode.partial) return failed('CTA is not recommended for this advertiser');
      return ok({creative_portfolio_id: String(7300 + ++state.portfolios)});
    }
  },
  decisive: {change: state => (state.advertiser.status = 'STATUS_LIMIT'), field: /status/},
};
