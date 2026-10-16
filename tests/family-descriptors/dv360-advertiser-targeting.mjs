// dv360_advertiser_targeting: POST /v4/advertisers/{advertiserId}/targetingTypes/TARGETING_TYPE_KEYWORD/
// assignedTargetingOptions (Display & Video 360 API v4, advertisers.targetingTypes.assignedTargetingOptions.create)
// adding a negative keyword every line item of the advertiser inherits. The decisive field is the advertiser's assigned
// KEYWORD targeting in advertisers.listAssignedTargetingOptions: a keyword assigned or removed in DV360 after the
// review changes the brand-safety list the reviewed one joins.
import {notFound, scopes} from './_dv360.mjs';

const type = 'TARGETING_TYPE_KEYWORD';
const option = (id, keyword) => ({
  name: 'advertisers/123/targetingTypes/' + type + '/assignedTargetingOptions/' + id,
  assignedTargetingOptionId: id,
  targetingType: type,
  inheritance: 'NOT_INHERITED',
  keywordDetails: {keyword, negative: true},
});

export default {
  family: 'dv360_advertiser_targeting',
  risk: 'activation',
  gateway: 'dv360_native_action',
  account: '123',
  connection: {scopes},
  arguments: {
    action: 'DV360_ADVERTISERS_TARGETING_TYPES_ASSIGNED_TARGETING_OPTIONS_CREATE',
    params: {advertiserId: '123', targetingType: type},
    body: {keywordDetails: {keyword: 'lottery', negative: true}},
  },
  seed: () => ({
    advertiser: {
      name: 'advertisers/123',
      advertiserId: '123',
      partnerId: '1',
      displayName: 'Synthetic advertiser',
      entityStatus: 'ENTITY_STATUS_ACTIVE',
    },
    targeting: [option('201', 'free')],
    next: 900,
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path === '/v4/advertisers/123') return {json: structuredClone(state.advertiser)};
    if (method === 'GET' && path === '/v4/advertisers/123:listAssignedTargetingOptions') {
      const types = [...String(url.searchParams.get('filter')).matchAll(/targetingType="([A-Z_]+)"/g)].map(m => m[1]),
        token = url.searchParams.get('pageToken');
      // Another page: DV360 names a next page token; on the next page it names the same token again, which the reader
      // refuses as a repeated page instead of reading its page bound.
      if (mode.paginate) return {json: token ? {nextPageToken: token} : {nextPageToken: '1'}};
      const rows = state.targeting.filter(o => types.includes(o.targetingType));
      return {json: rows.length ? {assignedTargetingOptions: structuredClone(rows)} : {}};
    }
    if (method === 'GET') return notFound();
    if (method === 'POST' && path === '/v4/advertisers/123/targetingTypes/' + type + '/assignedTargetingOptions') {
      // An unconfirmed answer: HTTP 200 naming no created option.
      if (mode.partial) return {json: {}};
      const o = option(String(state.next++), body.keywordDetails.keyword);
      state.targeting.push(o);
      return {json: structuredClone(o)};
    }
  },
  decisive: {change: state => state.targeting.push(option('202', 'casino')), field: /assignedTargetingOptions/},
};
