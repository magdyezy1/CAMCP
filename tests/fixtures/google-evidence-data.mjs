export const googleEvidenceInput = {
  action: 'capture_preset',
  preset: 'google_campaign',
  account_id: '123',
  connection_id: 'ffffffff-1111-4111-8111-111111111114',
  semantics: {
    currency: 'USD',
    timezone: 'UTC',
    date_from: '2026-09-01',
    date_to: '2026-09-02',
    attribution: 'unknown',
    conversion_definition: 'unknown',
    source_name: 'Synthetic Google evidence',
    complete: true,
  },
};
export const googleEvidenceCustomer = () => ({
  id: '123',
  resourceName: 'customers/123',
  currencyCode: 'USD',
  timeZone: 'UTC',
});
export function googleEvidenceRow(kind = 'campaign', id = '9007199254740993', group = '2', term = 'home') {
  const row = {
    customer: googleEvidenceCustomer(),
    campaign: {id: '1', resourceName: 'customers/123/campaigns/1', name: 'Home <img>'},
    metrics: {costMicros: '9007199254740993', clicks: '12', impressions: '100', conversions: 2, conversionsValue: 30},
  };
  if (kind === 'campaign') row.campaign = {...row.campaign, id, resourceName: 'customers/123/campaigns/' + id};
  if (kind !== 'campaign')
    row.adGroup = {
      id: kind === 'ad_group' ? id : group,
      resourceName: 'customers/123/adGroups/' + (kind === 'ad_group' ? id : group),
      name: 'Group',
    };
  if (kind === 'ad_group_ad')
    row.adGroupAd = {
      resourceName: 'customers/123/adGroupAds/' + group + '~' + id,
      ad: {id, resourceName: 'customers/123/ads/' + id},
    };
  if (kind === 'search_term_view')
    row.searchTermView = {
      resourceName: 'customers/123/searchTermViews/1~' + group + '~' + Buffer.from(term).toString('base64url'),
      searchTerm: term,
    };
  else row.segments = {date: googleEvidenceInput.semantics.date_from};
  return row;
}
export function googleEvidenceResponse(body, rows) {
  const kind = /FROM (\w+)/.exec(body.query)?.[1];
  if (kind === 'customer')
    return {results: [{customer: googleEvidenceCustomer(), private: 'PRIVATE-BILLING'}], totalResultsCount: '1'};
  if (!['campaign', 'ad_group', 'ad_group_ad', 'search_term_view'].includes(kind))
    throw Error('Unexpected Google query');
  const all = rows ?? [googleEvidenceRow(kind)];
  return {results: all, totalResultsCount: String(all.length)};
}
