import {readFileSync} from 'node:fs';

const {cpc_bid, ...search} = JSON.parse(
  readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'),
).recipe_business;
export const googleConversionBrief = {
  ...search,
  conversion_goal_policy: 'ACCOUNT_DEFAULT',
  target_cpa: '15.250001',
};

/** Synthetic selected-account GAQL only. There are no events, credentials or mutation routes here. */
export function googleRecipeGoalsData(options = {}) {
  const account = googleConversionBrief.account_id,
    customer = {
      id: account,
      currencyCode: 'USD',
      timeZone: 'UTC',
      manager: false,
      conversionTrackingSetting: {googleAdsConversionCustomer: 'customers/' + account},
      ...options.customer,
    },
    goal = (category, biddable) => ({
      resourceName: `customers/${account}/customerConversionGoals/${category}~WEBSITE`,
      category,
      origin: 'WEBSITE',
      biddable,
    }),
    action = (id, category, primaryForGoal, status = 'ENABLED') => ({
      resourceName: `customers/${account}/conversionActions/${id}`,
      name: id === '1' ? 'Synthetic <img onerror=bad> purchase' : 'Synthetic action ' + id,
      category,
      origin: 'WEBSITE',
      primaryForGoal,
      status,
      ownerCustomer: 'customers/' + account,
    }),
    goals = options.goals ?? [goal('PURCHASE', true), goal('SUBMIT_LEAD_FORM', false)],
    actions = options.actions ?? [
      action('1', 'PURCHASE', true),
      action('2', 'PURCHASE', false),
      action('3', 'PURCHASE', true, 'HIDDEN'),
      action('4', 'SUBMIT_LEAD_FORM', true),
    ],
    collections = new Map(),
    requests = [];
  return {
    customer,
    goals,
    actions,
    goal,
    action,
    requests,
    response(raw, init) {
      const url = new URL(String(raw)),
        body = JSON.parse(init.body);
      if (init.method !== 'POST' || !url.pathname.endsWith('/customers/' + account + '/googleAds:search'))
        throw Error('Only synthetic selected-account searches are permitted');
      const resource = / FROM ([a-z_]+)/.exec(body.query)?.[1];
      requests.push({path: url.pathname, body: structuredClone(body), resource});
      if (resource === 'customer' && !body.query.includes('conversion_tracking_setting'))
        return {
          results: [{customer: {id: customer.id, currencyCode: customer.currencyCode, timeZone: customer.timeZone}}],
        };
      if (!['customer', 'customer_conversion_goal', 'conversion_action'].includes(resource))
        throw Error('Unqualified fixture resource: ' + resource);
      const pass = body.pageToken ? (collections.get(resource) ?? 1) : (collections.get(resource) ?? 0) + 1;
      if (!body.pageToken) collections.set(resource, pass);
      const values = resource === 'customer' ? [customer] : resource === 'customer_conversion_goal' ? goals : actions;
      const size = resource === 'customer' ? 1 : (options.pageSize ?? 2);
      const page = body.pageToken ? Number(body.pageToken.replace('synthetic-page-', '')) : 0;
      const kind = resource.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      let envelope = {
        results: structuredClone(values.slice(page * size, (page + 1) * size)).map(row => ({[kind]: row})),
        totalResultsCount: String(values.length),
        ...(values.length > (page + 1) * size ? {nextPageToken: 'synthetic-page-' + (page + 1)} : {}),
      };
      if (options.transform) envelope = options.transform({resource, pass, page, envelope, body, requests}) ?? envelope;
      return envelope;
    },
  };
}
