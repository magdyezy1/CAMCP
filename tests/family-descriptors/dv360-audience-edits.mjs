// dv360_audience_edits: PATCH /v4/firstPartyAndPartnerAudiences/{id}?advertiserId=&updateMask=displayName (Display &
// Video 360 API v4, firstPartyAndPartnerAudiences.patch; only customer match audiences, fields displayName, description
// and membershipDurationDays). The decisive field is the audience's current `displayName` in
// firstPartyAndPartnerAudiences.get, the value the rename overwrites: a rename made in DV360 after the review must stop
// the reviewed one.
import {notFound, scopes} from './_dv360.mjs';

export default {
  family: 'dv360_audience_edits',
  risk: 'settings',
  gateway: 'dv360_native_action',
  account: '123',
  connection: {scopes},
  arguments: {
    action: 'DV360_FIRST_PARTY_AND_PARTNER_AUDIENCES_PATCH',
    params: {firstPartyAndPartnerAudienceId: '7001', advertiserId: '123', updateMask: 'displayName'},
    body: {displayName: 'Loyal buyers 2026'},
  },
  seed: () => ({
    audience: {
      name: 'firstPartyAndPartnerAudiences/7001',
      firstPartyAndPartnerAudienceId: '7001',
      displayName: 'Loyal buyers',
      description: 'Customers with two orders',
      audienceType: 'CUSTOMER_MATCH_CONTACT_INFO',
      firstPartyAndPartnerAudienceType: 'TYPE_FIRST_PARTY',
      audienceSource: 'DISPLAY_VIDEO_360',
      membershipDurationDays: '540',
    },
  }),
  unpaginated: 'firstPartyAndPartnerAudiences.get returns the one audience; DV360 pages only list methods',
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    if (method === 'GET' && path === '/v4/firstPartyAndPartnerAudiences/7001')
      return {json: structuredClone(state.audience)};
    if (method === 'GET') return notFound();
    if (method === 'PATCH' && path === '/v4/firstPartyAndPartnerAudiences/7001') {
      // An unconfirmed answer: HTTP 200 naming no audience.
      if (mode.partial) return {json: {}};
      Object.assign(state.audience, body);
      return {json: structuredClone(state.audience)};
    }
  },
  decisive: {change: state => (state.audience.displayName = 'Renamed in DV360'), field: /displayName/},
};
