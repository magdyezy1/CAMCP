// snapchat_targeting_specs: PUT /v1/adsquads/{ad_squad_id}/targeting_specs (Snapchat Marketing API v1, "Audience
// Targeting", Targeting Specs for more than 500 criteria; the request replaces the ad squad's one GEO spec). The spec's
// `geos` decide where the ad squad serves and spends, and the update replaces every one of them, so they are the
// decisive field in "Get Targeting Specs": a location added in Snapchat after the review would be silently dropped.
import {ok, rows} from './_snapchat.mjs';

const postal = codes => codes.map(c => ({country_code: 'us', postal_code: [c], operation: 'INCLUDE'}));

export default {
  family: 'snapchat_targeting_specs',
  risk: 'budget',
  gateway: 'snapchat_native_action',
  account: 'acct1',
  owned: ['adsquads/sq-big'],
  request: {
    action: 'snapchat_adsquads_ad_squad_id_targeting_specs_update',
    params: {ad_squad_id: 'sq-big'},
    payload: {targeting_specs: [{id: 'spec-1', type: 'GEO', geos: postal(['20001', '20009', '20010'])}]},
  },
  seed: () => ({
    squad: {
      id: 'sq-big',
      campaign_id: 'camp-1',
      status: 'ACTIVE',
      name: 'Postcodes',
      targeting: {separated_types: ['GEO']},
    },
    campaign: {id: 'camp-1', ad_account_id: 'acct1', status: 'ACTIVE'},
    spec: {id: 'spec-1', type: 'GEO', container_id: 'sq-big', geos: postal(['20001', '20009'])},
  }),
  unpaginated:
    'GET /v1/adsquads/{id}, GET /v1/campaigns/{id} and the ad squad targeting_specs read return one entity each',
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    if (method === 'GET' && path === '/v1/adsquads/sq-big') return ok({adsquads: rows('adsquad', [state.squad])});
    if (method === 'GET' && path === '/v1/campaigns/camp-1') return ok({campaigns: rows('campaign', [state.campaign])});
    if (method === 'GET' && path === '/v1/adsquads/sq-big/targeting_specs')
      return ok({targeting_specs: rows('targeting_spec', [state.spec])});
    if (method === 'PUT' && path === '/v1/adsquads/sq-big/targeting_specs') {
      // A failed answer: the request is accepted but the spec row reports an error.
      if (mode.partial)
        return ok({targeting_specs: [{sub_request_status: 'ERROR', sub_request_error_reason: 'Too many criteria'}]});
      Object.assign(state.spec, body.targeting_specs[0]);
      return ok({targeting_specs: rows('targeting_spec', [state.spec])});
    }
  },
  decisive: {change: state => state.spec.geos.push(...postal(['20500'])), field: /geos/},
};
