// microsoft_asset_links: POST /CampaignManagement/v13/AdExtensionsAssociations/Set (campaign.api.bingads.microsoft.com,
// Microsoft Advertising Campaign Management API v13, SetAdExtensionsAssociations). Associating a sitelink extension
// with a campaign shows that extension, with its link, on the campaign's ads at once; the review shows the extension
// being attached, so the extension's `FinalUrls` (where the sitelink leads) is the decisive field.
const microsoftScope = 'https://ads.microsoft.com/msads.manage',
  extension = id => ({
    Id: id,
    Status: 'Active',
    Type: 'SitelinkAdExtension',
    Text: 'Synthetic ' + id,
    FinalUrls: ['https://example.com/' + id],
  });

export default {
  family: 'microsoft_asset_links',
  risk: 'activation',
  gateway: 'microsoft_ads_native_action',
  account: '123',
  connection: {accountCustomers: {123: '456'}, scopes: [microsoftScope]},
  credentials: {accessToken: 'synthetic', developerToken: 'synthetic-developer'},
  request: {
    action: 'SetAdExtensionsAssociations',
    campaign_id: '100',
    ad_extension_types: ['SitelinkAdExtension'],
    payload: {
      AssociationType: 'Campaign',
      AdExtensionIdToEntityIdAssociations: [{EntityId: '100', AdExtensionId: '800'}],
    },
  },
  seed: () => ({
    account: {Id: '123'},
    campaigns: [{Id: '100', Status: 'Paused', CampaignType: 'Search', DailyBudget: 50}],
    extensions: [extension('800')],
    links: [],
  }),
  unpaginated:
    'GetAccount, the Get...ByIds reads and GetAdExtensionsAssociations answer for the named IDs at once, unpaged',
  isWrite: ({path}) => path.endsWith('/AdExtensionsAssociations/Set') || path.endsWith('/AdExtensionsAssociations'),
  provider({path, body, state, mode}) {
    if (path.endsWith('/Account/Query')) return {json: {Account: state.account}};
    if (path.endsWith('/Campaigns/QueryByIds'))
      return {json: {Campaigns: state.campaigns.filter(c => body.CampaignIds.includes(c.Id))}};
    if (path.endsWith('/AdExtensions/QueryByIds'))
      return {
        json: {
          AdExtensions: body.AdExtensionIds.map(id => state.extensions.find(e => e.Id === id) ?? null),
          PartialErrors: [null],
        },
      };
    if (path.endsWith('/AdExtensionsAssociations/Query'))
      return {
        json: {
          AdExtensionAssociationCollection: body.EntityIds.map(id => ({
            AdExtensionAssociations: state.links
              .filter(l => l.EntityId === id)
              .map(l => ({
                EntityId: id,
                AssociationType: body.AssociationType,
                AdExtension: state.extensions.find(e => e.Id === l.AdExtensionId),
                EditorialStatus: 'Active',
              })),
          })),
          PartialErrors: [null],
        },
      };
    if (path.endsWith('/AdExtensionsAssociations/Set')) {
      // A partial answer: Microsoft reports an error for the association.
      if (mode.partial) return {json: {PartialErrors: [{Index: 0, Code: 100, Message: 'Synthetic failure'}]}};
      state.links.push(...body.AdExtensionIdToEntityIdAssociations);
      return {json: {PartialErrors: [null]}};
    }
  },
  decisive: {change: state => (state.extensions[0].FinalUrls = ['https://example.com/other']), field: /FinalUrls/},
};
