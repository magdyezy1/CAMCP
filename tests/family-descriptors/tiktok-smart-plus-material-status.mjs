// tiktok_smart_plus_material_status: POST /v1.3/smart_plus/ad/material_status/update/ (API for Business v1.3). The
// decisive field is the selected creative's `material_operation_status`, the serving state the update changes.
import {failed, list, ok} from './_tiktok.mjs';

const material = (id, item, status = 'ENABLE') => ({
  ad_material_id: id,
  smart_plus_creative_id: 'c' + id,
  material_operation_status: status,
  creative_info: {ad_format: 'SINGLE_VIDEO', tiktok_item_id: item, identity_type: 'TT_USER', identity_id: 'tt-1'},
});

export default {
  family: 'tiktok_smart_plus_material_status',
  risk: 'activation',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {
    action: 'tiktok_smart_plus_ad_material_status_update',
    payload: {smart_plus_ad_id: '5200', ad_material_ids: ['m1'], operation_status: 'DISABLE'},
  },
  seed: () => ({
    ads: {
      5200: {
        smart_plus_ad_id: '5200',
        adgroup_id: '300',
        ad_name: 'Live spark',
        operation_status: 'ENABLE',
        creative_list: [material('m1', '9001'), material('m2', '9003')],
      },
    },
  }),
  partialCodes: ['PLATFORM_ERROR', 'WRITE_REJECTED'],
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/smart_plus/ad/material_status/update/'),
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path.endsWith('/v1.3/smart_plus/ad/get/')) {
      const ids = JSON.parse(url.searchParams.get('filtering')).smart_plus_ad_ids;
      return list(
        ids.filter(id => state.ads[id]).map(id => structuredClone(state.ads[id])),
        mode.paginate,
      );
    }
    if (method === 'POST' && path.endsWith('/v1.3/smart_plus/ad/material_status/update/')) {
      if (mode.partial) return failed('Creative cannot be paused');
      for (const m of state.ads[body.smart_plus_ad_id].creative_list)
        if (body.ad_material_ids.includes(m.ad_material_id)) m.material_operation_status = body.operation_status;
      return ok({
        ad_material_ids: body.ad_material_ids,
        operation_status: body.operation_status,
        smart_plus_ad_id: body.smart_plus_ad_id,
      });
    }
  },
  decisive: {
    change: state => (state.ads[5200].creative_list[0].material_operation_status = 'DISABLE'),
    field: /material_operation_status/,
  },
};
