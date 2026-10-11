// tiktok_entity_status: POST /v1.3/adgroup/status/update/ (TikTok API for Business v1.3). The decisive field is the
// ad group's `operation_status`, the value the update changes; a delivery change made in TikTok after the review
// must stop the reviewed one.
export default {
  family: 'tiktok_entity_status',
  risk: 'activation',
  gateway: 'tiktok_native_action',
  account: '123',
  owned: ['100', '200'],
  request: {action: 'tiktok_adgroup_status_update', payload: {adgroup_ids: ['200'], operation_status: 'DISABLE'}},
  seed: () => ({
    adgroup: {200: {adgroup_id: '200', campaign_id: '100', adgroup_name: 'Group A', operation_status: 'ENABLE'}},
    campaign: {100: {campaign_id: '100', campaign_name: 'Spring', operation_status: 'ENABLE'}},
  }),
  isWrite: ({method, path}) => method === 'POST' && /\/status\/update\/$/.test(path),
  provider({method, url, path, body, state, mode}) {
    const get = /\/v1\.3\/(campaign|adgroup|ad)\/get\/$/.exec(path);
    if (method === 'GET' && get) {
      const rows = Object.values(state[get[1]] ?? {}).map(r => ({...r})),
        filtering = JSON.parse(url.searchParams.get('filtering') ?? '{}'),
        list = rows.filter(r =>
          ['campaign_ids', 'adgroup_ids'].every(f => !filtering[f] || filtering[f].includes(r[f.slice(0, -1)])),
        );
      return {
        json: {
          code: 0,
          message: 'OK',
          request_id: 'r',
          data: {
            list,
            page_info: {page: 1, page_size: 1000, total_number: list.length, total_page: mode.paginate ? 2 : 1},
          },
        },
      };
    }
    if (method === 'POST' && path.endsWith('/v1.3/adgroup/status/update/')) {
      // A partial answer: the provider lists none of the requested IDs as changed.
      if (mode.partial)
        return {json: {code: 0, message: 'OK', request_id: 'r', data: {adgroup_ids: [], status: 'DISABLE'}}};
      for (const id of body.adgroup_ids) state.adgroup[id].operation_status = body.operation_status;
      return {
        json: {
          code: 0,
          message: 'OK',
          request_id: 'r',
          data: {adgroup_ids: body.adgroup_ids, status: body.operation_status},
        },
      };
    }
  },
  decisive: {change: state => (state.adgroup[200].operation_status = 'DISABLE'), field: /operation_status/},
};
