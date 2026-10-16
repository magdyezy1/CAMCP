// tiktok_smart_plus_adgroups: POST /v1.3/smart_plus/adgroup/create/ (API for Business v1.3, "Create an Upgraded
// Smart+ Ad Group"), paused, in a campaign with campaign budget optimization. The ad group spends from the campaign's
// budget, so the decisive field is the campaign's `budget` in "Get Upgraded Smart+ Campaigns", which the review shows
// as the ad group's budget: a campaign budget changed after the review changes what the new ad group can spend.
import {failed, list, ok} from './_tiktok.mjs';

export default {
  family: 'tiktok_smart_plus_adgroups',
  risk: 'budget',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {
    action: 'tiktok_smart_plus_adgroup_create',
    payload: {
      request_id: '810200300400',
      campaign_id: '80',
      operation_status: 'DISABLE',
      adgroup_name: 'Smart+ KSA signups',
      promotion_type: 'WEBSITE',
      optimization_goal: 'CONVERT',
      pixel_id: '7001',
      optimization_event: 'ON_WEB_REGISTER',
      bid_type: 'BID_TYPE_NO_BID',
      billing_event: 'OCPM',
      targeting_optimization_mode: 'AUTOMATIC',
      targeting_spec: {location_ids: ['102358'], spc_audience_age: 'OVER_EIGHTEEN', languages: ['ar']},
      schedule_type: 'SCHEDULE_FROM_NOW',
      schedule_start_time: '2026-10-01 00:00:00',
    },
  },
  seed: () => ({
    campaigns: {
      80: {
        campaign_id: '80',
        campaign_name: 'CBO web',
        objective_type: 'WEB_CONVERSIONS',
        sales_destination: 'WEBSITE',
        budget_optimize_on: true,
        budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
        budget: 500,
        operation_status: 'DISABLE',
        catalog_enabled: false,
        is_search_campaign: false,
      },
    },
    pixels: {
      7001: {
        pixel_id: '7001',
        pixel_code: 'C7001',
        pixel_name: 'Site pixel',
        asset_ownership: {ownership_status: true},
      },
    },
    groups: 0,
  }),
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/smart_plus/adgroup/create/'),
  provider({method, url, path, body, state, mode}) {
    const q = k => url.searchParams.get(k);
    if (method === 'GET' && path.endsWith('/v1.3/advertiser/info/'))
      return ok({list: [{advertiser_id: '123', name: 'Advertiser', currency: 'SAR', timezone: 'Asia/Riyadh'}]});
    if (method === 'GET' && path.endsWith('/v1.3/smart_plus/campaign/get/')) {
      const ids = JSON.parse(q('filtering')).campaign_ids;
      return list(
        ids.filter(id => state.campaigns[id]).map(id => structuredClone(state.campaigns[id])),
        mode.paginate,
      );
    }
    if (method === 'GET' && path.endsWith('/v1.3/pixel/list/')) {
      const p = state.pixels[q('pixel_id')];
      return ok({
        pixels: p ? [structuredClone(p)] : [],
        page_info: {page: 1, page_size: 10, total_number: p ? 1 : 0, total_page: 1},
      });
    }
    if (method === 'POST' && path.endsWith('/v1.3/smart_plus/adgroup/create/')) {
      if (mode.partial) return failed('Schedule start time is in the past');
      const {advertiser_id: _, request_id: __, ...stored} = body;
      return ok({...stored, adgroup_id: String(9100000000000001 + state.groups++)});
    }
  },
  decisive: {change: state => (state.campaigns[80].budget = 800), field: /budget/},
};
