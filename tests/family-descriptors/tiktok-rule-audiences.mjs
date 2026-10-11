// tiktok_rule_audiences: POST /v1.3/dmp/custom_audience/rule/create/ (API for Business v1.3, "Create an audience by
// rule"), an engagement audience of the people who watched one ad group's ads. The audience is built from its event
// source, so the decisive field is that ad group as "Get ad groups" names it (`adgroup_name`, the identity the review
// shows for the source): a source that is no longer the reviewed one must stop the creation.
import {failed, ok} from './_tiktok.mjs';

export default {
  family: 'tiktok_rule_audiences',
  risk: 'settings',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {
    action: 'tiktok_dmp_custom_audience_rule_create',
    payload: {
      custom_audience_name: 'Watched 6s',
      audience_type: 'ENGAGEMENT',
      rule_spec: {
        inclusion_rule_set: {
          operator: 'OR',
          rules: [
            {
              event_source_ids: ['301'],
              retention_days: 14,
              filter_set: {operator: 'OR', filters: [{field: 'EVENT', operator: 'EQ', value: 'PLAY 6S'}]},
            },
          ],
        },
      },
    },
  },
  seed: () => ({adgroups: {301: {adgroup_id: '301', adgroup_name: 'Spring video'}}, created: []}),
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/dmp/custom_audience/rule/create/'),
  provider({method, url, path, state, mode}) {
    if (method === 'GET' && path.endsWith('/v1.3/adgroup/get/')) {
      const ids = JSON.parse(url.searchParams.get('filtering')).adgroup_ids,
        rows = ids.filter(id => state.adgroups[id]).map(id => ({advertiser_id: '123', ...state.adgroups[id]}));
      // Another page: TikTok declares it with page_info.total_page.
      return ok({
        list: rows,
        page_info: {page: 1, page_size: 100, total_number: rows.length, total_page: mode.paginate ? 2 : 1},
      });
    }
    if (method === 'POST' && path.endsWith('/v1.3/dmp/custom_audience/rule/create/')) {
      if (mode.partial) return failed('Audience rule is invalid');
      const id = String(801 + state.created.length);
      state.created.push(id);
      return ok({custom_audience_id: id});
    }
  },
  decisive: {change: state => (state.adgroups[301].adgroup_name = 'Another group'), field: /adgroups.*name/},
};
