// linkedin_ab_tests: POST /rest/adExperiments/{id} PARTIAL_UPDATE setting userIntendedState ACTIVE (LinkedIn A/B
// Testing Management API, li-lms-2026-09). Running the experiment splits the traffic of its two campaigns by the cells'
// weights, so the decisive field is a cell's `trafficWeight`: a split changed in LinkedIn after the review would run
// a test the owner never saw.
import {account, empty, restliError} from './_linkedin.mjs';

const start = Date.now() + 2 * 86400000;
const campaign = (id, status = 'PAUSED') => ({
  id: Number(id),
  account,
  campaignGroup: 'urn:li:sponsoredCampaignGroup:300',
  status,
});

export default {
  family: 'linkedin_ab_tests',
  risk: 'activation',
  gateway: 'linkedin_native_action',
  account: '507',
  connection: {scopes: ['rw_ads']},
  request: {
    action: 'linkedin_rest_ad_experiments_experiment_id_post',
    restli_method: 'PARTIAL_UPDATE',
    path_params: {experiment_id: '901'},
    payload: {patch: {$set: {userIntendedState: 'ACTIVE'}}},
  },
  seed: () => ({
    experiment: {
      id: 901,
      account,
      name: 'Headline test',
      keyMetric: 'CPC',
      confidence: 90,
      scheduledStartAt: start,
      scheduledEndAt: start + 30 * 86400000,
      userIntendedState: 'DRAFT',
      autoStop: 'AUTO_STOP_AT_END_DATE',
      executionState: 'PENDING',
      cells: [
        {name: 'A', trafficWeight: 50, reference: {campaign: 'urn:li:sponsoredCampaign:401'}},
        {name: 'B', trafficWeight: 50, reference: {campaign: 'urn:li:sponsoredCampaign:402'}},
      ],
    },
    campaigns: {401: campaign('401'), 402: campaign('402')},
  }),
  unpaginated: 'the account, the experiment and each campaign are read by ID as single entities, never as pages',
  partialCodes: ['UPSTREAM_ERROR', 'WRITE_PARTIAL_OR_FAILED', 'WRITE_OUTCOME_UNCERTAIN'],
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    if (method === 'GET') {
      if (path === '/rest/adAccounts/507') return {json: {id: 507, status: 'ACTIVE'}};
      if (path === '/rest/adExperiments/901') return {json: state.experiment};
      const c = /^\/rest\/adAccounts\/507\/adCampaigns\/(\d+)$/.exec(path)?.[1];
      if (c && state.campaigns[c]) return {json: state.campaigns[c]};
      return restliError(404, 'Not found');
    }
    if (method === 'POST' && path === '/rest/adExperiments/901') {
      // A failed answer: LinkedIn refuses to start the experiment.
      if (mode.partial) return restliError(422, 'Experiment cannot start');
      Object.assign(state.experiment, body.patch.$set);
      return empty();
    }
  },
  decisive: {
    change: state => {
      state.experiment.cells[0].trafficWeight = 60;
      state.experiment.cells[1].trafficWeight = 40;
    },
    field: /trafficWeight/,
  },
};
