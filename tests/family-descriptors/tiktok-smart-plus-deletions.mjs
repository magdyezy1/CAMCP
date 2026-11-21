// tiktok_smart_plus_deletions: POST /v1.3/smart_plus/campaign/status/update/ with operation_status DELETE (API for
// Business v1.3, "Update the operation statuses of Upgraded Smart+ Campaigns"). The deletion is irreversible and names
// the campaign by ID only, so the decisive field is the campaign as "Get Upgraded Smart+ Campaigns" names it
// (`campaign_name`, what the review shows is deleted): a campaign that is no longer the reviewed one must not be
// deleted. (A campaign enabled after the review is refused by the family's pause-first rule.)
import {failed, filtered, list, ok} from './_tiktok.mjs';

export default {
  family: 'tiktok_smart_plus_deletions',
  risk: 'destructive',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {
    action: 'tiktok_smart_plus_campaign_status_update',
    payload: {campaign_ids: ['100'], operation_status: 'DELETE'},
  },
  seed: () => ({
    campaign: {
      100: {
        campaign_id: '100',
        campaign_name: 'Smart+ web DNU',
        operation_status: 'DISABLE',
        secondary_status: 'CAMPAIGN_STATUS_DISABLE',
      },
    },
    adgroup: {200: {adgroup_id: '200', campaign_id: '100', adgroup_name: 'Group A', operation_status: 'ENABLE'}},
    ad: {
      300: {
        smart_plus_ad_id: '300',
        adgroup_id: '200',
        campaign_id: '100',
        ad_name: 'Ad A',
        operation_status: 'ENABLE',
      },
    },
  }),
  partialCodes: ['PLATFORM_ERROR', 'WRITE_REJECTED'],
  isWrite: ({method, path}) => method === 'POST' && /\/smart_plus\/campaign\/status\/update\/$/.test(path),
  provider({method, url, path, body, state, mode}) {
    const get = /\/v1\.3\/smart_plus\/(campaign|adgroup|ad)\/get\/$/.exec(path);
    // The campaign by its ID; its ad groups and ads by the campaign's ID (the children a deletion takes with it).
    if (method === 'GET' && get) return list(filtered(url, state[get[1]], 'campaign_ids'), mode.paginate);
    if (method === 'POST' && path.endsWith('/v1.3/smart_plus/campaign/status/update/')) {
      if (mode.partial) return failed();
      for (const id of body.campaign_ids) delete state.campaign[id];
      return ok({campaign_list: body.campaign_ids.map(id => ({campaign_id: id, status: 'DELETE'})), error_list: []});
    }
  },
  decisive: {change: state => (state.campaign[100].campaign_name = 'Smart+ live'), field: /campaign_name/},
};
