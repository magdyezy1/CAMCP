// tiktok_smart_plus_adgroup_edits: POST /v1.3/smart_plus/adgroup/update/ (API for Business v1.3, "Update an upgraded
// Smart+ ad group"). The decisive field is the ad group's current `conversion_bid_price`: the update overwrites it,
// and TikTok applies a bid change to every ad group of the campaign.
import {failed, filtered, list, ok} from './_tiktok.mjs';

const group = (id, extra = {}) => ({
  adgroup_id: id,
  campaign_id: '80',
  adgroup_name: 'Group ' + id,
  operation_status: 'ENABLE',
  promotion_type: 'WEBSITE',
  optimization_goal: 'CONVERT',
  bid_type: 'BID_TYPE_CUSTOM',
  conversion_bid_price: 12,
  budget_mode: 'BUDGET_MODE_INFINITE',
  schedule_type: 'SCHEDULE_START_END',
  schedule_start_time: '2026-09-01 00:00:00',
  schedule_end_time: '2026-12-31 00:00:00',
  dayparting: '1'.repeat(336),
  comment_disabled: false,
  share_disabled: false,
  targeting_spec: {location_ids: ['6252001']},
  placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
  ...extra,
});

export default {
  family: 'tiktok_smart_plus_adgroup_edits',
  risk: 'budget',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {action: 'tiktok_smart_plus_adgroup_update', payload: {adgroup_id: '300', conversion_bid_price: 15}},
  seed: () => ({groups: {300: group('300'), 301: group('301', {adgroup_name: 'Sibling'})}}),
  partialCodes: ['PLATFORM_ERROR', 'WRITE_REJECTED'],
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/smart_plus/adgroup/update/'),
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path.endsWith('/v1.3/smart_plus/adgroup/get/')) {
      const f = JSON.parse(url.searchParams.get('filtering'));
      const rows = f.adgroup_ids
        ? filtered(url, state.groups, 'adgroup_ids')
        : Object.values(state.groups)
            .filter(g => f.campaign_ids.includes(g.campaign_id))
            .map(g => structuredClone(g));
      return list(rows, mode.paginate);
    }
    if (method === 'POST' && path.endsWith('/v1.3/smart_plus/adgroup/update/')) {
      if (mode.partial) return failed('Bid is lower than the minimum');
      const {advertiser_id: _, adgroup_id, ...changes} = body,
        target = state.groups[adgroup_id];
      Object.assign(target, changes);
      for (const other of Object.values(state.groups))
        if (other.campaign_id === target.campaign_id && changes.conversion_bid_price !== undefined)
          other.conversion_bid_price = changes.conversion_bid_price;
      return ok(structuredClone(target));
    }
  },
  decisive: {change: state => (state.groups[300].conversion_bid_price = 13), field: /conversion_bid_price/},
};
