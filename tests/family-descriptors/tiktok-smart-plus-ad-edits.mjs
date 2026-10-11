// tiktok_smart_plus_ad_edits: POST /v1.3/smart_plus/ad/update/ (API for Business v1.3, "Update an Upgraded Smart+
// Ad"), renaming an ad. The update is incremental, so the decisive field is the ad's current `ad_name` in "Get Upgraded
// Smart+ Ads", the value the edit overwrites.
import {failed, list, ok} from './_tiktok.mjs';

export default {
  family: 'tiktok_smart_plus_ad_edits',
  risk: 'settings',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {action: 'tiktok_smart_plus_ad_update', payload: {smart_plus_ad_id: '5200', ad_name: 'Autumn spark'}},
  seed: () => ({
    ads: {
      5200: {
        smart_plus_ad_id: '5200',
        adgroup_id: '300',
        ad_name: 'Live spark',
        operation_status: 'DISABLE',
        creative_list: [
          {
            ad_material_id: 'm1',
            material_operation_status: 'ENABLE',
            creative_info: {
              ad_format: 'SINGLE_VIDEO',
              tiktok_item_id: '9001',
              identity_type: 'TT_USER',
              identity_id: 'tt-1',
            },
          },
        ],
      },
    },
  }),
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/smart_plus/ad/update/'),
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path.endsWith('/v1.3/smart_plus/ad/get/')) {
      const ids = JSON.parse(url.searchParams.get('filtering')).smart_plus_ad_ids;
      return list(
        ids.filter(id => state.ads[id]).map(id => structuredClone(state.ads[id])),
        mode.paginate,
      );
    }
    if (method === 'POST' && path.endsWith('/v1.3/smart_plus/ad/update/')) {
      if (mode.partial) return failed('Ad name is invalid');
      state.ads[body.smart_plus_ad_id].ad_name = body.ad_name;
      return ok(structuredClone(state.ads[body.smart_plus_ad_id]));
    }
  },
  decisive: {change: state => (state.ads[5200].ad_name = 'Renamed in TikTok'), field: /ad_name/},
};
