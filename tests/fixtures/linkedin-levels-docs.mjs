// Synthetic identities and values, shaped from the official li-lms-2026-10 references checked 2026-11-02:
// https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting?view=li-lms-2026-10
// https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaign-groups?view=li-lms-2026-10
// https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaigns?view=li-lms-2026-10
// https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-creatives?view=li-lms-2026-10
export const linkedinLevelRange = {since: '2026-09-01', until: '2026-09-02'};
export const linkedinLevelAccount = {id: 100, currency: 'USD', name: 'Synthetic account'};
export const linkedinLevelGroup = {
  id: 20,
  account: 'urn:li:sponsoredAccount:100',
  name: 'Synthetic group',
  objectiveType: 'BRAND_AWARENESS',
  status: 'PAUSED',
};
export const linkedinLevelCampaign = {
  id: 30,
  account: 'urn:li:sponsoredAccount:100',
  campaignGroup: 'urn:li:sponsoredCampaignGroup:20',
  name: 'Synthetic campaign',
  objectiveType: 'LEAD_GENERATION',
  status: 'PAUSED',
};
export const linkedinLevelCreative = {
  id: 'urn:li:sponsoredCreative:40',
  account: 'urn:li:sponsoredAccount:100',
  campaign: 'urn:li:sponsoredCampaign:30',
  name: 'Synthetic creative',
  intendedStatus: 'PAUSED',
};
const nativeDate = day => {
  const [year, month, date] = day.split('-').map(Number);
  return {year, month, day: date};
};
export function linkedinLevelAnalytics(pivot, extra = {}) {
  const urn = {
    CAMPAIGN_GROUP: 'urn:li:sponsoredCampaignGroup:20',
    CAMPAIGN: 'urn:li:sponsoredCampaign:30',
    CREATIVE: 'urn:li:sponsoredCreative:40',
  }[pivot];
  if (!urn) throw new Error('Unexpected synthetic pivot ' + pivot);
  return {
    elements: [
      {
        pivotValues: [urn],
        dateRange: {start: nativeDate(linkedinLevelRange.since), end: nativeDate(linkedinLevelRange.until)},
        costInLocalCurrency: '100.123456789',
        impressions: 1000,
        clicks: 100,
        externalWebsiteConversions: 20,
        ...extra,
      },
    ],
  };
}
