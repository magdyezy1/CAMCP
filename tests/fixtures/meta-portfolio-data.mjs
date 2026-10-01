// Synthetic native inventory for local browser and SDK journeys. Never fetches provider data.
const campaign = id => ({
  id,
  account_id: '100',
  name: id === '10' ? 'Evergreen · مبيعات' : id === '20' ? 'Product launch · leads' : 'Re-engagement',
  status: 'ACTIVE',
  effective_status: 'PAUSED',
  objective: 'OUTCOME_SALES',
  daily_budget: '25000',
  updated_time: '2026-10-01T08:00:00+0000',
});
const adset = id => ({
  id,
  account_id: '100',
  campaign_id: '10',
  name: id === '201' ? 'Website purchases · broad' : 'Returning customers',
  status: 'ACTIVE',
  effective_status: 'CAMPAIGN_PAUSED',
  lifetime_budget: '150000',
  bid_amount: 125,
  optimization_goal: 'OFFSITE_CONVERSIONS',
});
export function metaPortfolioData(url) {
  const route = url.pathname.replace(/^\/v\d+\.0/, '');
  if (route === '/act_100')
    return {id: 'act_100', account_id: '100', currency: 'USD', timezone_name: 'America/New_York'};
  if (route === '/act_100/campaigns')
    return url.searchParams.has('after')
      ? {data: [campaign('30')]}
      : {
          data: [campaign('10'), campaign('20')],
          paging: {cursors: {after: 'synthetic-next'}, next: 'https://graph.facebook.com/unused'},
        };
  if (route === '/10') return campaign('10');
  if (route === '/10/adsets') return {data: [adset('201'), adset('202')]};
  if (route === '/201') return adset('201');
  if (route === '/201/ads')
    return {
      data: [
        {
          id: '301',
          account_id: '100',
          campaign_id: '10',
          adset_id: '201',
          name: 'Ramadan product image',
          status: 'ACTIVE',
          effective_status: 'CAMPAIGN_PAUSED',
        },
      ],
    };
  throw Error('Unexpected synthetic portfolio route ' + route);
}
