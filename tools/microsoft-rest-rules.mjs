// The page rules AMCP relies on for each pinned Microsoft Learn page (F-50, CMP-03). Kept free of side effects so
// tests and tools can import them; tools/microsoft-rest.mjs pins pages against these rules.
export const reliesOn = {
  AddCampaignCriterions: [
    'Location criteria are added with CriterionType Targets, at most 100 criteria per request.',
    'CampaignCriterionIds follows the request rows, null where a row was not added; NestedPartialErrors lists the failures, not aligned with the rows, and can be empty when none failed.',
  ],
  GetCampaignCriterionsByIds: [
    'Targets is not allowed on this read: location criteria are read with CriterionType Location.',
    'CampaignCriterionIds null returns every criterion of that type of the campaign; listed IDs return their criteria in order, null where one was not returned.',
  ],
  DeleteCampaignCriterions: [
    'Location criteria are deleted with CriterionType Targets, by CampaignId and at most 100 CampaignCriterionIds.',
  ],
  BiddableCampaignCriterion: [
    'A targeted (positive) criterion is a BiddableCampaignCriterion; CampaignId and Criterion are required on add, Id and Status are read-only, and Active is its only status.',
    'CriterionBid is optional on add for a location criterion: without it the bid multiplier is 0, no adjustment.',
  ],
  NegativeCampaignCriterion: [
    'An excluded criterion is a NegativeCampaignCriterion: excluding a location targets no location.',
  ],
  LocationCriterion: [
    'LocationId, required on add, is a Location Id of the geographical locations file (GetGeoLocationsFileUrl); DisplayName, EnclosedLocationIds and LocationType are read-only.',
    'A location the file marks PendingDeprecation no longer targets or excludes; a deprecated location cannot be added.',
    'Read back, the criterion type is Location.',
    'An ad group with any location, negative location or radius criterion of its own does not inherit the campaign’s.',
  ],
  LocationIntentCriterion: [
    'The first criterion of a campaign adds a location intent of PeopleInOrSearchingForOrViewingPages (people in, searching for or viewing pages about the locations); PeopleIn targets people in them only.',
    'A location intent criterion cannot be deleted and takes no bid.',
  ],
  BidMultiplier: ['Multiplier is a percentage adjustment of the bid, -90 through 900 for most criterion types.'],
  CampaignCriterionType: [
    'Targets adds, updates and deletes location criteria; reads name the specific type, Location.',
    'A location may be targeted (BiddableCampaignCriterion) or excluded (NegativeCampaignCriterion).',
  ],
  ShowAdsToYourTargetAudience: [
    'A campaign or ad group created through the API has no criteria, and effectively targets all locations (and all ages, days, hours, devices and genders) until criteria are added; Microsoft advises at least a campaign location criterion for the customer’s market.',
    'Location, negative location and radius criteria are one set of geo criteria: an ad group with any of its own inherits none of the campaign’s, and one with none inherits all of them.',
  ],
  GeographicalLocationCodes: [
    'A location criterion takes the Location Id column of the geographical locations file (GetGeoLocationsFileUrl); the Bing Display Name is for presentation only, and several IDs can share one.',
    'This guide says a Pending Deprecation location still targets until it is deprecated within 30 days, while the LocationCriterion page says PendingDeprecation already stops targeting; both say a deprecated location criterion can still be read but no longer targets or excludes.',
  ],
  // Optional (CMP-03 location lookup): written before the page was read; check them when it is first pinned.
  GetGeoLocationsFileUrl: [
    'Version 2.0 is the only supported file version, LanguageLocale en gives its display names in English, and CompressionType GZip is the only supported compression (Zip is reserved for future use; without a value the file is uncompressed).',
    'FileUrl is valid until FileUrlExpiryTimeUtc, and LastModifiedTimeUtc tells whether the file changed since an earlier download.',
  ],
};
