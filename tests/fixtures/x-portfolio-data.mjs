export const xPortfolioAccount = 'acct1';
export const xPortfolioCampaign = (id = 'camp1') => ({
  id,
  name: 'Native campaign',
  entity_status: 'PAUSED',
  effective_status: 'UNKNOWN',
  servable: false,
  reasons_not_servable: ['PAUSED_BY_ADVERTISER'],
  deleted: false,
  currency: 'USD',
  daily_budget_amount_local_micro: '9007199254740993',
  total_budget_amount_local_micro: null,
  budget_optimization: 'LINE_ITEM',
  created_at: '2026-09-01T00:00:00Z',
  purchase_order_number: 'PRIVATE-INVOICE',
});
export const xPortfolioLine = () => ({
  id: 'line1',
  campaign_id: 'camp1',
  name: 'Native line',
  entity_status: 'ACTIVE',
  deleted: false,
  currency: 'USD',
  objective: 'ENGAGEMENTS',
  product_type: 'PROMOTED_TWEETS',
  bid_strategy: 'MAX',
  placements: ['ALL_ON_TWITTER'],
  bid_amount_local_micro: 320000,
  target_cpa_local_micro: null,
  total_budget_amount_local_micro: '250000000',
  daily_budget_amount_local_micro: null,
  primary_web_event_tag: 'PRIVATE-TRACKING',
  advertiser_user_id: 'PRIVATE-USER',
});
export function xPortfolioResponse(url) {
  const u = new URL(url),
    path = u.pathname,
    query = u.searchParams;
  const response = data => ({request: {params: {account_id: xPortfolioAccount}}, data, private: 'PRIVATE-ENVELOPE'});
  const page = (data, next_cursor = null) => ({...response(data), next_cursor});
  if (path === '/12/accounts/acct1')
    return response({id: 'acct1', timezone: 'America/Los_Angeles', deleted: false, business_name: 'PRIVATE-BUSINESS'});
  if (path.endsWith('/campaigns/camp1')) return response(xPortfolioCampaign());
  if (path.endsWith('/line_items/line1')) return response(xPortfolioLine());
  if (path.endsWith('/campaigns'))
    return query.has('cursor')
      ? page([xPortfolioCampaign('camp3')])
      : page([xPortfolioCampaign(), xPortfolioCampaign('camp2')], 'native-next');
  if (path.endsWith('/line_items')) return page([xPortfolioLine()]);
  if (path.endsWith('/promoted_tweets'))
    return page([
      {
        id: 'post1',
        line_item_id: 'line1',
        tweet_id: '880290790664060928',
        entity_status: 'ACTIVE',
        approval_status: 'ACCEPTED',
        deleted: false,
        tweet: {text: 'PRIVATE-COPY'},
      },
    ]);
  throw Error('Unexpected X portfolio route ' + path);
}
