// snapchat_nested_updates: PATCH /v1/campaigns/{campaign_id}/adsquads/{ad_squad_id} (Snap Marketing API v1), described
// with the ad squad targeting contract it serves (PRV-06 A): one replace /targeting operation. The decisive field is
// the ad squad's current `targeting`, which the operation replaces whole (Snap's Ad Squads page).
const account = 'acct-conformance',
  wrap = (collection, singular, entity, paged) => ({
    json: {
      request_status: 'SUCCESS',
      [collection]: [{sub_request_status: 'SUCCESS', [singular]: structuredClone(entity)}],
      // Another page: Snapchat names it with paging.next_link.
      ...(paged ? {paging: {next_link: 'https://adsapi.snapchat.com/v1/' + collection + '?cursor=next'}} : {}),
    },
  });
export default {
  family: 'snapchat_nested_updates',
  risk: 'activation',
  gateway: 'snapchat_native_action',
  account,
  owned: ['campaigns/camp-1', 'adsquads/sq-1'],
  request: {
    action: 'snapchat_adsquad_patch',
    path_params: {campaign_id: 'camp-1', ad_squad_id: 'sq-1'},
    payload: [
      {
        op: 'replace',
        path: '/targeting',
        value: {
          regulated_content: false,
          geos: [
            {country_code: 'sa', operation: 'INCLUDE'},
            {country_code: 'kw', operation: 'INCLUDE'},
          ],
        },
      },
    ],
  },
  seed: () => ({
    campaign: {id: 'camp-1', ad_account_id: account, status: 'ACTIVE', name: 'Campaign'},
    squad: {
      id: 'sq-1',
      campaign_id: 'camp-1',
      status: 'PAUSED',
      name: 'Gulf',
      targeting: {regulated_content: false, geos: [{country_code: 'sa', operation: 'INCLUDE'}]},
    },
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    if (method === 'GET' && path === '/v1/adaccounts/' + account)
      return wrap('adaccounts', 'adaccount', {id: account}, mode.paginate);
    if (method === 'GET' && path === '/v1/campaigns/camp-1')
      return wrap('campaigns', 'campaign', state.campaign, mode.paginate);
    if (method === 'GET' && path === '/v1/adsquads/sq-1')
      return wrap('adsquads', 'adsquad', state.squad, mode.paginate);
    if (method === 'PATCH' && path === '/v1/campaigns/camp-1/adsquads/sq-1') {
      // A failed answer: Snapchat refuses the one ad squad of the request.
      if (mode.partial)
        return {
          json: {
            request_status: 'ERROR',
            adsquads: [{sub_request_status: 'ERROR', sub_request_error_reason: 'Synthetic refusal'}],
          },
        };
      state.squad.targeting = structuredClone(body[0].value);
      return wrap('adsquads', 'adsquad', state.squad);
    }
  },
  decisive: {
    change: state => state.squad.targeting.geos.push({country_code: 'om', operation: 'INCLUDE'}),
    field: /targeting/,
  },
};
