// google_lifecycle_goals: POST /v25/customers/{id}/goals:mutate (Google Ads API v25, Goal). The update overwrites the
// new customer acquisition goal's `value_settings.value_multiplier`, the value Smart Bidding adds for a new customer in
// every campaign linked to the goal; Google requires `high_lifetime_value_multiplier` above it, so the goal's current
// value settings are the decisive field.
import * as g from './_google-ads.mjs';

const goal = g.resource('goals', '40');

export default {
  family: 'google_lifecycle_goals',
  risk: 'budget',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: g.connection,
  credentials: g.credentials,
  request: {
    action: 'google_ads_v23_goal_mutate_goals',
    payload: {
      operations: [
        {
          update: {resourceName: goal, newCustomerAcquisitionGoalSettings: {valueSettings: {valueMultiplier: 2}}},
          updateMask: 'newCustomerAcquisitionGoalSettings.valueSettings.valueMultiplier',
        },
      ],
    },
  },
  seed: () => ({
    goal: [
      {
        resourceName: goal,
        goalType: 'NEW_CUSTOMER_ACQUISITION',
        optimizationEligibility: 'ELIGIBLE',
        newCustomerAcquisitionGoalSettings: {valueSettings: {valueMultiplier: 1.5, highLifetimeValueMultiplier: 3}},
      },
    ],
  }),
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, body, state, mode} = request;
    if (g.isSearch(request)) return g.table(request);
    if (g.mutateOf(path)?.toLowerCase() === 'goals') {
      if (mode.partial) return g.partialFailure();
      for (const op of body.operations) {
        const row = state.goal.find(r => r.resourceName === op.update.resourceName);
        Object.assign(row.newCustomerAcquisitionGoalSettings.valueSettings, {
          ...op.update.newCustomerAcquisitionGoalSettings.valueSettings,
        });
      }
      return {json: {results: body.operations.map(op => ({resourceName: op.update.resourceName}))}};
    }
  },
  decisive: {
    change: state => (state.goal[0].newCustomerAcquisitionGoalSettings.valueSettings.valueMultiplier = 1.8),
    field: /value_multiplier|valueMultiplier|value_settings/,
  },
};
