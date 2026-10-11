// linkedin_engagement_audiences: DELETE /rest/dmpSegments/{id} (LinkedIn DMP Segments, li-lms-2026-09), which removes
// the segment "altogether" with its destinations and its ad segment. The decisive field is the targeting of the
// account's live campaigns: a campaign that starts targeting the ad segment after the review would lose its audience,
// so the family's own prerequisite refuses the deletion as the state is read again at execute.
import {account, empty, restliError} from './_linkedin.mjs';

const adSegment = 'urn:li:adSegment:9000';
const campaign = (id, status, segments = []) => ({
  id,
  account,
  status,
  name: 'Campaign ' + id,
  targetingCriteria: {
    include: {and: segments.length ? [{or: {'urn:li:adTargetingFacet:audienceMatchingSegments': segments}}] : []},
  },
});

export default {
  family: 'linkedin_engagement_audiences',
  risk: 'destructive',
  gateway: 'linkedin_native_action',
  account: '507',
  connection: {scopes: ['rw_ads']},
  request: {action: 'linkedin_rest_dmp_segments_segment_id_delete', path_params: {segment_id: '100'}},
  seed: () => ({
    segment: {
      id: 100,
      account,
      name: 'Video viewers',
      type: 'USER',
      sourcePlatform: 'VIDEO_ADS',
      destinations: [{destination: 'LINKEDIN', status: 'READY', destinationSegmentId: adSegment}],
    },
    campaigns: [campaign(31, 'ACTIVE'), campaign(32, 'PAUSED')],
  }),
  isWrite: ({method}) => method === 'DELETE',
  provider({method, path, state, mode}) {
    if (method === 'GET') {
      if (path === '/rest/adAccounts/507') return {json: {id: 507, status: 'ACTIVE'}};
      if (path === '/rest/dmpSegments/100')
        return state.segment ? {json: state.segment} : restliError(404, 'Not found');
      // The account's live campaigns, read for their targeting. Another page: LinkedIn names a nextPageToken on every
      // page, more than the review reads.
      if (path === '/rest/adAccounts/507/adCampaigns')
        return {
          json: {elements: structuredClone(state.campaigns), metadata: mode.paginate ? {nextPageToken: 'n'} : {}},
        };
      return restliError(404, 'Not found');
    }
    if (method === 'DELETE' && path === '/rest/dmpSegments/100') {
      if (mode.partial) return restliError(422, 'Segment cannot be deleted');
      state.segment = undefined;
      return empty();
    }
  },
  partialCodes: ['UPSTREAM_ERROR', 'WRITE_PARTIAL_OR_FAILED', 'WRITE_OUTCOME_UNCERTAIN'],
  decisive: {
    change: state => state.campaigns.push(campaign(33, 'ACTIVE', [adSegment])),
    field: /usage/,
    refusal: {code: 'INVALID_LINKEDIN_ENGAGEMENT_AUDIENCE', message: /Campaigns still target these audiences: 33/},
  },
};
