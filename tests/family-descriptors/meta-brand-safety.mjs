// meta_brand_safety: POST /act_{id}/account_controls (Meta Marketing API v26.0, Ad Account Account Controls). Each post
// sets the controls as sent and removes what it leaves out, so the decisive field is the account's current
// `placement_controls.placement_exclusions`: an exclusion added in Meta after the review would be silently removed.
import {decode, edge, unsupported, v} from './_meta.mjs';

export default {
  family: 'meta_brand_safety',
  risk: 'activation',
  gateway: 'meta_native_action',
  account: '123',
  connection: {scopes: ['ads_management']},
  request: {
    action: 'meta_ad_account_id_account_controls_create',
    payload: {
      audience_controls: {age_min: 21, geo_locations: {countries: ['US']}},
      placement_controls: {placement_exclusions: ['facebook_rhc']},
    },
  },
  seed: () => ({
    controls: {
      audience_controls: {age_min: 18, geo_locations: {countries: ['US']}},
      placement_controls: {placement_exclusions: ['facebook_rhc']},
    },
  }),
  // Meta keeps at most one set of controls per account; a second page is not a complete state and is refused as a
  // failed read (the family's documented code for this edge).
  paginatedCodes: ['STATE_READ_FAILED', 'INCOMPLETE_STATE'],
  isWrite: ({method}) => method === 'POST',
  provider({method, path, body, state, mode}) {
    if (path !== v + '/act_123/account_controls') return method === 'GET' ? unsupported() : undefined;
    if (method === 'GET')
      return edge(path, [{...state.controls, status: 'ACTIVE', campaigns_with_error: []}], mode.paginate);
    // A failed answer: Meta reports the controls as not applied.
    if (mode.partial) return {json: {id: '555', success: false, error_code: '2641', error_message: 'Restricted'}};
    state.controls = decode(body);
    return {json: {id: '555', success: true}};
  },
  decisive: {
    change: state => state.controls.placement_controls.placement_exclusions.push('facebook_marketplace'),
    field: /placement_exclusions/,
  },
};
