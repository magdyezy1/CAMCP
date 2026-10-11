// microsoft_search: PUT https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/Campaigns (Microsoft
// Advertising Campaign Management API v13, UpdateCampaigns). The update overwrites the campaign's `DailyBudget`, what
// the campaign may spend per day; the campaign's current `DailyBudget` is the decisive field (the review shows the
// budget being replaced and the spend limits compare against it).
const microsoftScope = 'https://ads.microsoft.com/msads.manage';

export default {
  family: 'microsoft_search',
  risk: 'budget',
  gateway: 'microsoft_ads_native_action',
  account: '123',
  connection: {accountCustomers: {123: '456'}, scopes: [microsoftScope]},
  credentials: {accessToken: 'synthetic', developerToken: 'synthetic-developer'},
  request: {action: 'UpdateCampaigns', payload: {Campaigns: [{Id: '100', DailyBudget: 30}]}},
  seed: () => ({
    account: {Id: '123', ParentCustomerId: '456', CurrencyCode: 'USD'},
    campaigns: [{Id: '100', Name: 'Campaign', Status: 'Paused', DailyBudget: 10, BudgetType: 'DailyBudgetStandard'}],
  }),
  unpaginated: 'GetAccount and GetCampaignsByIds return the named entities in one response; Microsoft pages neither',
  isWrite: ({path}) => !/\/(Account\/Query|QueryByIds)$/.test(path),
  provider({path, body, state, mode}) {
    if (path.endsWith('/Account/Query')) return {json: {Account: state.account}};
    if (path.endsWith('/Campaigns/QueryByIds'))
      return {json: {Campaigns: state.campaigns.filter(c => body.CampaignIds.includes(c.Id))}};
    if (path === '/CampaignManagement/v13/Campaigns') {
      // A partial answer: Microsoft reports an error for the campaign.
      if (mode.partial) return {json: {PartialErrors: [{Index: 0, Code: 1, Message: 'Synthetic failure'}]}};
      for (const update of body.Campaigns)
        Object.assign(
          state.campaigns.find(c => c.Id === update.Id),
          update,
        );
      return {json: {PartialErrors: null}};
    }
  },
  decisive: {change: state => (state.campaigns[0].DailyBudget = 20), field: /DailyBudget/},
};
