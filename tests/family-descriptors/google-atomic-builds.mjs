// google_atomic_builds: POST /v25/customers/{id}/googleAds:mutate (Google Ads API, GoogleAdsService.Mutate) adding an
// enabled ad group and keyword to an existing paused campaign. The children spend through the parent campaign's budget,
// so the decisive field is the parent's `campaign_budget`: a campaign moved to another budget in Google Ads after the
// review is STATE_CHANGED. (The parent's `status` is decisive too: any change of it is refused first, as
// PARENT_SERVING, because enabled children may start only under a paused parent.)
import * as g from './_google-ads.mjs';

const campaign = g.resource('campaigns', '77');
const result = {
  campaignBudgets: 'campaignBudgetResult',
  campaigns: 'campaignResult',
  adGroups: 'adGroupResult',
  adGroupCriteria: 'adGroupCriterionResult',
};
const kinds = {
  adGroupOperation: 'adGroups',
  adGroupCriterionOperation: 'adGroupCriteria',
};

export default {
  family: 'google_atomic_builds',
  risk: 'activation',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: g.connection,
  credentials: g.credentials,
  request: {
    action: 'google_ads_v23_google_ads_mutate',
    payload: {
      mutate_operations: [
        {
          ad_group_operation: {
            create: {
              resource_name: 'customers/123/adGroups/-3',
              name: 'Brand',
              campaign,
              status: 'ENABLED',
              type: 'SEARCH_STANDARD',
              cpc_bid_micros: '1500000',
            },
          },
        },
        {
          ad_group_criterion_operation: {
            create: {
              ad_group: 'customers/123/adGroups/-3',
              keyword: {text: 'acme', match_type: 'EXACT'},
              status: 'ENABLED',
            },
          },
        },
      ],
    },
  },
  seed: () => ({
    campaign: [{resourceName: campaign, status: 'PAUSED', campaignBudget: g.resource('campaignBudgets', '7')}],
    created: 0,
  }),
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, body, state, mode} = request;
    if (g.isSearch(request)) return g.table(request);
    if (path === '/v25/customers/123/googleAds:mutate') {
      const operations = body.mutateOperations ?? body.mutate_operations;
      const responses = operations.map(op => {
        const key = Object.keys(op)[0],
          kind = kinds[key] ?? kinds[g.camel(key)],
          id = String(500 + state.created++);
        return {[result[kind]]: {resourceName: g.resource(kind, kind === 'adGroupCriteria' ? '501~' + id : id)}};
      });
      // A partial answer: Google names a result for the first operation only.
      return {json: {mutateOperationResponses: mode.partial ? responses.slice(0, 1) : responses}};
    }
  },
  decisive: {
    change: state => (state.campaign[0].campaignBudget = g.resource('campaignBudgets', '8')),
    field: /campaignBudget|campaign_budget/,
  },
};
