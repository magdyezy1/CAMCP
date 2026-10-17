/**
 * The v13 JSON contracts of Microsoft Advertising ad-extension associations (src/microsoft-associations.ts), as data in
 * a leaf module (ARC-04). src/microsoft-native.ts adds them to its contract table while it is evaluated; it and the
 * association family import each other, so when the family module was imported first the table read this list before
 * it was initialized (a ReferenceError at load). A leaf is evaluated before either. WSDL correspondence is checked
 * separately.
 * https://learn.microsoft.com/en-us/advertising/campaign-management-service/setadextensionsassociations?view=bingads-13
 */
export const microsoftExtensionTypes = [
  'LocationAdExtension',
  'CallAdExtension',
  'ImageAdExtension',
  'AppAdExtension',
  'ReviewAdExtension',
  'CalloutAdExtension',
  'SitelinkAdExtension',
  'StructuredSnippetAdExtension',
  'PriceAdExtension',
  'ActionAdExtension',
  'PromotionAdExtension',
  'FilterLinkAdExtension',
  'FlyerAdExtension',
  'VideoAdExtension',
  'DisclaimerAdExtension',
  'LogoAdExtension',
];
const base = '/CampaignManagement/v13/';
export const microsoftAssociationContracts = [
  {
    name: 'GetAdExtensionsByIds',
    method: 'POST',
    path: base + 'AdExtensions/QueryByIds',
    fields: ['AccountId', 'AdExtensionIds', 'AdExtensionType', 'ReturnAdditionalFields'],
    required: ['AccountId', 'AdExtensionIds', 'AdExtensionType'],
    result: 'AdExtensions',
    kind: 'AdExtensions',
  },
  {
    name: 'GetAdExtensionsAssociations',
    method: 'POST',
    path: base + 'AdExtensionsAssociations/Query',
    fields: ['AccountId', 'EntityIds', 'AssociationType', 'AdExtensionType', 'ReturnAdditionalFields'],
    required: ['AccountId', 'EntityIds', 'AssociationType', 'AdExtensionType'],
    result: 'AdExtensionAssociationCollection',
  },
  ...['Set', 'Delete'].map(verb => ({
    name: verb + 'AdExtensionsAssociations',
    method: verb === 'Set' ? 'POST' : 'DELETE',
    path: base + 'AdExtensionsAssociations' + (verb === 'Set' ? '/Set' : ''),
    fields: ['AccountId', 'AdExtensionIdToEntityIdAssociations', 'AssociationType'],
    required: ['AccountId', 'AdExtensionIdToEntityIdAssociations', 'AssociationType'],
    result: 'PartialErrors',
  })),
];
