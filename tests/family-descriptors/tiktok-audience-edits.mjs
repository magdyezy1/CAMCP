// tiktok_audience_edits: POST /v1.3/dmp/custom_audience/apply/ (API for Business v1.3, "Apply audiences to ad
// groups"), including one audience in an enabled ad group. The apply edits the ad group's targeted audiences, so the
// decisive field is the ad group's current `audience_ids` in "Get ad groups": an audience list changed in TikTok after
// the review changes whom the edited ad group reaches.
import {failed, ok} from './_tiktok.mjs';

const audience = (name, extra = {}) => ({
  name,
  audience_type: 'Customer File Audience',
  is_valid: true,
  is_expiring: false,
  expired_time: '2030-01-01 00:00:00',
  shared: false,
  is_creator: true,
  ...extra,
});

export default {
  family: 'tiktok_audience_edits',
  risk: 'activation',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {
    action: 'tiktok_dmp_custom_audience_apply',
    payload: {
      advertiser_id: '123',
      custom_audience_id: '602',
      adgroup_ids: ['301'],
      action_mode: 'Apply',
      usage_mode: 'Include',
    },
  },
  seed: () => ({
    audiences: {602: audience('Buyers'), 607: audience('Used')},
    adgroups: {
      301: {adgroup_name: 'Prospecting', operation_status: 'ENABLE', audience_ids: ['607'], excluded_audience_ids: []},
    },
  }),
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/dmp/custom_audience/apply/'),
  provider({method, url, path, body, state, mode}) {
    const q = k => url.searchParams.get(k);
    if (method === 'GET' && path.endsWith('/v1.3/dmp/custom_audience/list/')) {
      const ids = JSON.parse(q('custom_audience_ids'));
      return ok({
        list: ids.filter(id => state.audiences[id]).map(id => ({audience_id: id, ...state.audiences[id]})),
        page_info: {page: 1, page_size: 100, total_number: ids.length, total_page: 1},
      });
    }
    if (method === 'GET' && path.endsWith('/v1.3/adgroup/get/')) {
      const ids = JSON.parse(q('filtering')).adgroup_ids,
        rows = ids
          .filter(id => state.adgroups[id])
          .map(id => ({advertiser_id: '123', adgroup_id: id, ...structuredClone(state.adgroups[id])}));
      // Another page: TikTok declares more named ad groups than the one page the review reads.
      return ok({
        list: rows,
        page_info: {page: 1, page_size: 100, total_number: rows.length, total_page: mode.paginate ? 2 : 1},
      });
    }
    if (method === 'POST' && path.endsWith('/v1.3/dmp/custom_audience/apply/')) {
      if (mode.partial) return failed('Audience is being processed');
      for (const id of body.adgroup_ids) state.adgroups[id].audience_ids.push(body.custom_audience_id);
      return ok({});
    }
  },
  decisive: {change: state => state.adgroups[301].audience_ids.push('609'), field: /include/},
};
