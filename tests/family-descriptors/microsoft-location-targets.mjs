// microsoft_location_targets: POST /CampaignManagement/v13/CampaignCriterions (Microsoft Advertising v13
// AddCampaignCriterions, CriterionType Targets) adding a positive location to a paused Search campaign (CMP-03). The
// decisive state is the campaign's current location criteria (GetCampaignCriterionsByIds, CriterionType Location),
// which the add extends and which decide whether a location is already targeted.
const campaignPath = '/CampaignManagement/v13/Campaigns/QueryByIds',
  criteriaPath = '/CampaignManagement/v13/CampaignCriterions/QueryByIds',
  writePath = '/CampaignManagement/v13/CampaignCriterions';
const criterion = (Id, LocationId) => ({
  Id,
  Type: 'BiddableCampaignCriterion',
  CampaignId: '501',
  Status: 'Active',
  Criterion: {Type: 'LocationCriterion', LocationId, DisplayName: 'Synthetic ' + LocationId, LocationType: 'Country'},
  CriterionBid: {Type: 'BidMultiplier', Multiplier: 0},
});

export default {
  family: 'microsoft_location_targets',
  risk: 'settings',
  gateway: 'microsoft_ads_native_action',
  account: '123',
  connection: {accountCustomers: {123: '456'}, scopes: ['https://ads.microsoft.com/msads.manage']},
  credentials: {accessToken: 'synthetic', developerToken: 'synthetic'},
  request: {
    action: 'AddCampaignCriterions',
    payload: {
      CriterionType: 'Targets',
      CampaignCriterions: [
        {
          Type: 'BiddableCampaignCriterion',
          CampaignId: '501',
          Criterion: {Type: 'LocationCriterion', LocationId: '190'},
        },
      ],
    },
  },
  seed: () => ({
    campaign: {Id: '501', Name: 'Synthetic', Status: 'Paused', CampaignType: 'Search', DailyBudget: 25},
    criteria: [criterion('9001', '32')],
    next: 9100,
  }),
  unpaginated:
    'Microsoft v13 Get…ByIds reads return every requested record in one answer; they have no page token or next link',
  isWrite: ({method, path}) => path === writePath && method !== 'GET',
  provider({method, path, body, state, mode}) {
    if (path === '/CustomerManagement/v13/Account/Query') return {json: {Account: {Id: '123'}}};
    if (path === campaignPath)
      return {json: {Campaigns: body.CampaignIds.map(id => (id === '501' ? structuredClone(state.campaign) : null))}};
    if (path === criteriaPath) {
      const own = state.criteria.filter(r => r.CampaignId === body.CampaignId),
        rows =
          body.CampaignCriterionIds === null
            ? own
            : body.CampaignCriterionIds.map(id => own.find(r => r.Id === id) ?? null);
      return {json: {CampaignCriterions: structuredClone(rows), PartialErrors: null}};
    }
    if (path === writePath && method === 'POST') {
      // A partial answer: Microsoft refuses the row with a nested error and returns no ID for it.
      if (mode.partial)
        return {
          json: {
            CampaignCriterionIds: [null],
            NestedPartialErrors: [{Code: 1043, ErrorCode: 'Synthetic', Message: 'Synthetic refusal', Index: 0}],
          },
        };
      const ids = body.CampaignCriterions.map(r => {
        const Id = String(state.next++);
        state.criteria.push(criterion(Id, r.Criterion.LocationId));
        return Id;
      });
      return {json: {CampaignCriterionIds: ids, NestedPartialErrors: []}};
    }
  },
  decisive: {
    change: state => state.criteria.push(criterion('9002', '44')),
    field: /campaign_?criterions/i,
  },
};
