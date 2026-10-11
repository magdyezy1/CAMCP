// criteo_budget_overrides: PUT /2026-07/retail-media/line-items/{id}/line-item-budget-overrides (Criteo Retail Media
// 2026-07). The request replaces every override, so the decisive field is an existing override's
// `maxMonthlySpend`: a cap changed in Criteo after the review would be silently replaced.
const prefix = '/2026-07/retail-media';
const page = (rows, more) => ({
  data: rows,
  metadata: {
    currentPageIndex: 0,
    currentPageSize: 2,
    totalItemsAcrossAllPages: rows.length + (more ? 2 : 0),
    totalPages: more ? 2 : 1,
    nextPage: more ? 'https://api.criteo.com' + prefix + '/accounts/123/line-items?pageIndex=1' : null,
    previousPage: null,
  },
  errors: [],
  warnings: [],
});
const overrides = state => ({
  data: {
    type: 'LineItemBudgetOverrides',
    attributes: {
      dailyLineItemBudgetOverrides: state.daily.map(o => ({...o, status: 'Upcoming'})),
      monthlyLineItemBudgetOverrides: state.monthly.map(o => ({...o, status: 'Upcoming'})),
    },
  },
  errors: [],
  warnings: [],
});

export default {
  family: 'criteo_budget_overrides',
  risk: 'budget',
  gateway: 'criteo_native_action',
  account: '123',
  connection: {scopes: ['RetailMedia_Accounts_Read', 'RetailMedia_Campaign_Read', 'RetailMedia_Campaign_Manage']},
  arguments: {
    operation: 'criteo_line_item_ops',
    arguments: {
      action: 'UPDATE_LINE_ITEM_BUDGET_OVERRIDES',
      account_id: '123',
      params: {lineItemId: '789'},
      payload: {
        data: {
          attributes: {
            dailyLineItemBudgetOverrides: [],
            monthlyLineItemBudgetOverrides: [{startMonth: '2030-11', duration: '2M', maxMonthlySpend: 9500}],
          },
        },
      },
    },
  },
  seed: () => ({daily: [], monthly: [{startMonth: '2030-11', duration: '2M', maxMonthlySpend: 9000}]}),
  prime: ({call}) =>
    call('criteo_native_action', {
      operation: 'criteo_line_item_ops',
      arguments: {
        action: 'GET_LINE_ITEMS_BY_ACCOUNT_ID',
        account_id: '123',
        params: {limitToId: ['789'], pageIndex: 0, pageSize: 2},
      },
    }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    const own = path === prefix + '/line-items/789/line-item-budget-overrides';
    if (method === 'GET') {
      if (path === prefix + '/accounts')
        return {
          json: page([
            {
              id: '123',
              type: 'RetailMediaAccount',
              attributes: {name: 'Account', type: 'demand', currency: 'USD', timeZone: 'America/New_York'},
            },
          ]),
        };
      if (path === prefix + '/accounts/123/line-items')
        return {
          json: page(
            url.searchParams
              .getAll('limitToId')
              .filter(id => id === '789')
              .map(id => ({
                id,
                type: 'RetailMediaLineItem',
                attributes: {campaignId: '456', name: 'Line', type: 'auction', status: 'active'},
              })),
            mode.paginate,
          ),
        };
      if (own) return {json: overrides(state)};
      return undefined;
    }
    if (method === 'PUT' && own) {
      // A partial answer: Criteo answers with a warning and no stored overrides.
      if (mode.partial) return {json: {data: null, errors: [], warnings: [{code: 'x'}]}, status: 201};
      state.daily = body.data.attributes.dailyLineItemBudgetOverrides;
      state.monthly = body.data.attributes.monthlyLineItemBudgetOverrides;
      return {json: overrides(state), status: 201};
    }
  },
  // The review keeps each override as {start, duration, cap}: the monthly cap is the projected maxMonthlySpend.
  decisive: {change: state => (state.monthly[0].maxMonthlySpend = 9100), field: /maxMonthlySpend|monthly.*cap/},
};
