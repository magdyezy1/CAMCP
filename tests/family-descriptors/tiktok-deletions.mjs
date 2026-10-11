// tiktok_deletions: POST /v1.3/dmp/saved_audience/delete/ (API for Business v1.3, "Delete Saved Audiences"). The
// deletion is irreversible and names the audience by ID only, so the decisive field is the audience as "Get details of
// Saved Audiences" names it (`saved_audience_name`, what the review shows is deleted): an audience that is no longer
// the reviewed one must not be deleted. (An ad group that starts using it is refused by the family's usage check.)
import {failed, ok} from './_tiktok.mjs';

export default {
  family: 'tiktok_deletions',
  risk: 'destructive',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {action: 'tiktok_dmp_saved_audience_delete', payload: {advertiser_id: '123', saved_audience_ids: ['9901']}},
  seed: () => ({
    saved: {9901: {saved_audience_id: '9901', saved_audience_name: 'Old KSA'}},
    adgroups: [{adgroup_id: '301', adgroup_name: 'Prospecting', saved_audience_id: '9902'}],
  }),
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/dmp/saved_audience/delete/'),
  provider({method, url, path, body, state, mode}) {
    const page = Number(url.searchParams.get('page') ?? 1);
    if (method === 'GET' && path.endsWith('/v1.3/dmp/saved_audience/list/')) {
      const ids = JSON.parse(url.searchParams.get('saved_audience_ids'));
      return ok({saved_audiences: ids.filter(id => state.saved[id]).map(id => ({...state.saved[id]}))});
    }
    if (method === 'GET' && path.endsWith('/v1.3/adgroup/get/'))
      // Another page: TikTok declares more ad group pages (page_info.total_page) than one review reads.
      return ok({
        list: page === 1 ? state.adgroups.map(g => ({...g})) : [],
        page_info: {page, page_size: 1000, total_number: state.adgroups.length, total_page: mode.paginate ? 99 : 1},
      });
    if (method === 'POST' && path.endsWith('/v1.3/dmp/saved_audience/delete/')) {
      if (mode.partial) return failed('Saved audience is in use');
      for (const id of body.saved_audience_ids) delete state.saved[id];
      return ok({});
    }
  },
  decisive: {change: state => (state.saved[9901].saved_audience_name = 'KSA buyers'), field: /name/},
};
