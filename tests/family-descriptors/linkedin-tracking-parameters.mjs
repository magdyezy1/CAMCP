// linkedin_tracking_parameters: PUT /rest/adTrackingParameters/(adEntity:(sponsoredCampaign:...))?idempotencyToken=
// (LinkedIn Dynamic UTM Tracking, li-lms-2026-09) replacing a running campaign's UTM parameters, which LinkedIn appends to
// the landing page URLs of every creative "without another ad review". The decisive field is the campaign's current
// parameters: parameters replaced in Campaign Manager after the review carry a new idempotencyToken, so the family's own
// prerequisite refuses the reviewed token as the state is read again at execute (LinkedIn would answer 409).
import {account, restliError} from './_linkedin.mjs';

const campaign = 'urn:li:sponsoredCampaign:601',
  key = '(adEntity:(sponsoredCampaign:' + campaign + '))';

export default {
  family: 'linkedin_tracking_parameters',
  risk: 'activation',
  gateway: 'linkedin_native_action',
  account: '507',
  connection: {scopes: ['rw_ads']},
  request: {
    action: 'linkedin_rest_ad_tracking_parameters_ad_entity_campaign_campaign_urn_put',
    path_params: {ad_entity_campaign_campaign_urn: key},
    query: {idempotencyToken: '100'},
    payload: {
      dynamicValueParameters: {utm_campaign: 'CAMPAIGN_NAME', utm_campaign_id: 'CAMPAIGN_ID'},
      customValueParameters: {utm_source: 'linkedin', utm_medium: 'paid social'},
    },
  },
  seed: () => ({
    campaign: {id: 601, account, name: 'Spring launch', status: 'ACTIVE'},
    params: {
      dynamicValueParameters: {utm_campaign: 'CAMPAIGN_NAME'},
      customValueParameters: {utm_source: 'linkedin'},
      idempotencyToken: '100',
    },
  }),
  unpaginated: 'the account, the campaign and its tracking parameters are each read by key as one entity',
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    if (method === 'GET') {
      if (path === '/rest/adAccounts/507') return {json: {id: 507, status: 'ACTIVE', currency: 'SAR'}};
      if (path === '/rest/adAccounts/507/adCampaigns/601') return {json: structuredClone(state.campaign)};
      if (decodeURIComponent(path) === '/rest/adTrackingParameters/' + key)
        return {json: {...structuredClone(state.params), adEntity: {sponsoredCampaign: campaign}}};
      return restliError(404, 'Not found');
    }
    if (method === 'PUT' && decodeURIComponent(path) === '/rest/adTrackingParameters/' + key) {
      // A failed answer: LinkedIn refuses the parameters.
      // An uncertain answer: LinkedIn fails with a 5xx, and the change may or may not have applied.
      if (mode.uncertain) return restliError(503, 'Service unavailable');
      if (mode.partial) return restliError(400, 'Invalid tracking parameter');
      state.params = {...body, idempotencyToken: String(Number(state.params.idempotencyToken) + 1)};
      return {json: {}, status: 200};
    }
  },
  partialCodes: ['UPSTREAM_ERROR', 'WRITE_PARTIAL_OR_FAILED', 'WRITE_OUTCOME_UNCERTAIN'],
  // A 5xx is reported as the provider error (never safe to retry); its replay is WRITE_OUTCOME_UNCERTAIN.
  uncertainCodes: ['UPSTREAM_ERROR', 'WRITE_OUTCOME_UNCERTAIN'],
  decisive: {
    change: state =>
      (state.params = {
        dynamicValueParameters: {utm_campaign: 'CAMPAIGN_NAME'},
        customValueParameters: {utm_source: 'linkedin_ads'},
        idempotencyToken: '107',
      }),
    field: /custom/,
    refusal: {code: 'INVALID_LINKEDIN_TRACKING', message: /is not the token of the current parameters \(107\)/},
  },
};
