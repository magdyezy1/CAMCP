// tiktok_smart_plus_status: POST /v1.3/smart_plus/campaign/status/update/. The decisive field is the campaign's
// `operation_status`, the value the update changes.
import {failed, filtered, list, ok} from './_tiktok.mjs';

export default {
  family: 'tiktok_smart_plus_status',
  risk: 'activation',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {
    action: 'tiktok_smart_plus_campaign_status_update',
    payload: {campaign_ids: ['100'], operation_status: 'DISABLE'},
  },
  seed: () => ({
    campaign: {
      100: {
        campaign_id: '100',
        campaign_name: 'Smart+ web',
        operation_status: 'ENABLE',
        secondary_status: 'CAMPAIGN_STATUS_ENABLE',
        budget: 500,
      },
    },
  }),
  isWrite: ({method, path}) => method === 'POST' && /\/smart_plus\/campaign\/status\/update\/$/.test(path),
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path.endsWith('/v1.3/smart_plus/campaign/get/'))
      return list(filtered(url, state.campaign, 'campaign_ids'), mode.paginate);
    if (method === 'POST' && path.endsWith('/v1.3/smart_plus/campaign/status/update/')) {
      if (mode.partial) return failed();
      for (const id of body.campaign_ids) state.campaign[id].operation_status = body.operation_status;
      return ok({
        campaign_list: body.campaign_ids.map(id => ({campaign_id: id, status: body.operation_status})),
        error_list: [],
      });
    }
  },
  decisive: {change: state => (state.campaign[100].operation_status = 'DISABLE'), field: /operation_status/},
};
