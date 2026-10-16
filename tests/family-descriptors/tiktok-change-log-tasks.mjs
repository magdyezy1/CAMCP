// tiktok_change_log_tasks: POST /v1.3/changelog/task/create/ (API for Business v1.3, "Create a change log download
// task"). The request names no timezone, so TikTok reads its window in the advertiser's time zone: the decisive field
// is the advertiser's `timezone` in "Get advertiser info", which decides which changes the reviewed window covers.
import {failed, ok} from './_tiktok.mjs';

export default {
  family: 'tiktok_change_log_tasks',
  risk: 'settings',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {
    action: 'tiktok_changelog_task_create',
    payload: {
      advertiser_id: '123',
      start_time: '2026-09-01 00:00:00',
      end_time: '2026-09-20 00:00:00',
      object_type: 'CAMPAIGN',
      object_ids: ['100'],
    },
  },
  seed: () => ({
    advertiser: {advertiser_id: '123', name: 'Advertiser', timezone: 'Asia/Riyadh', status: 'STATUS_ENABLE'},
    campaigns: {100: {advertiser_id: '123', campaign_id: '100', campaign_name: 'Spring'}},
    tasks: 0,
  }),
  unpaginated:
    'GET /v1.3/advertiser/info/ returns the one advertiser, and the object read filters by at most 100 IDs with ' +
    'page_size 100, so no second page can hold a named object (one missing from the first is refused as not found)',
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/changelog/task/create/'),
  provider({method, url, path, state, mode}) {
    if (method === 'GET' && path.endsWith('/v1.3/advertiser/info/')) return ok({list: [{...state.advertiser}]});
    if (method === 'GET' && path.endsWith('/v1.3/campaign/get/')) {
      const ids = JSON.parse(url.searchParams.get('filtering')).campaign_ids,
        list = ids.filter(id => state.campaigns[id]).map(id => ({...state.campaigns[id]}));
      return ok({list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}});
    }
    if (method === 'POST' && path.endsWith('/v1.3/changelog/task/create/')) {
      // A partial answer: TikTok accepted the call but named no task.
      if (mode.partial) return ok({});
      return ok({task_id: 'task' + ++state.tasks});
    }
  },
  decisive: {change: state => (state.advertiser.timezone = 'America/New_York'), field: /timezone/},
};
