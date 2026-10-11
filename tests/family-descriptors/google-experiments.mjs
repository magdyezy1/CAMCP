// google_experiments: POST /v25/customers/{id}/experiments/{id}:scheduleExperiment (Google Ads API,
// ExperimentService.ScheduleExperiment) starting a system-managed experiment in SETUP. Once scheduled, each arm takes
// its `traffic_split` share of the base campaign's traffic and budget, so the arms' current split is the decisive
// field: a split changed in Google Ads after the review would start a different trial than the one approved.
import * as g from './_google-ads.mjs';

const experiment = g.resource('experiments', '501'),
  base = g.resource('campaigns', '1001'),
  budget = g.resource('campaignBudgets', '3000');

export default {
  family: 'google_experiments',
  risk: 'activation',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: g.connection,
  credentials: g.credentials,
  request: {
    action: 'google_ads_v23_experiment_schedule_experiment',
    path_params: {resource_name: experiment},
    payload: {},
  },
  seed: () => ({
    customer: [{resourceName: 'customers/123', id: '123', manager: false, timeZone: 'America/New_York'}],
    experiment: [
      {
        resourceName: experiment,
        experimentId: '501',
        name: 'Ready',
        type: 'SEARCH_CUSTOM',
        suffix: '[ready]',
        status: 'SETUP',
        promoteStatus: 'NOT_STARTED',
      },
    ],
    experiment_arm: [
      {
        resourceName: g.resource('experimentArms', '501~1'),
        experiment,
        name: 'Control',
        control: true,
        trafficSplit: '50',
        campaigns: [base],
      },
      {
        resourceName: g.resource('experimentArms', '501~2'),
        experiment,
        name: 'Treatment',
        control: false,
        trafficSplit: '50',
        campaigns: [],
        inDesignCampaigns: [g.resource('campaigns', '8001')],
      },
    ],
    campaign: [
      {
        campaign: {
          resourceName: base,
          id: '1001',
          name: 'Search brand',
          status: 'ENABLED',
          advertisingChannelType: 'SEARCH',
          experimentType: 'BASE',
          campaignBudget: budget,
          missingEuPoliticalAdvertisingDeclaration: false,
        },
        campaignBudget: {explicitlyShared: false, period: 'DAILY'},
      },
    ],
    campaign_budget: [
      {
        resourceName: budget,
        status: 'ENABLED',
        explicitlyShared: false,
        period: 'DAILY',
        referenceCount: 1,
        amountMicros: '50000000',
      },
    ],
  }),
  paginatedCodes: ['EXPERIMENT_STATE_UNVERIFIED'],
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, state, mode} = request;
    if (g.isSearch(request)) return g.table(request);
    if (path === '/v25/customers/123/experiments/501:scheduleExperiment') {
      // A failed answer: the long-running operation ended with an error.
      if (mode.partial)
        return {json: {name: 'customers/123/operations/op-501', done: true, error: {code: 3, message: 'Synthetic'}}};
      state.experiment[0].status = 'ENABLED';
      return {json: {name: 'customers/123/operations/op-501', done: false}};
    }
  },
  decisive: {
    change: state => {
      state.experiment_arm[0].trafficSplit = '30';
      state.experiment_arm[1].trafficSplit = '70';
    },
    field: /trafficSplit/,
  },
};
