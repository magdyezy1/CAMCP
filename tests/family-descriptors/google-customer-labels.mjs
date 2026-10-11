// google_customer_labels: POST /v25/customers/{id}/customerLabels:mutate (Google Ads API, CustomerLabel) removing a
// manager's label from a customer. A customer label has two fields, both output only: `customer` and `label`, the
// manager label the review names to the person approving the removal; `label` is the decisive field. (A label already
// removed in Google Ads is refused first, as STATE_NOT_FOUND. Google keys a customer label by its label ID, so the
// synthetic change, the same ID resolving to another manager's label, stands for any change of what the review showed.)
import * as g from './_google-ads.mjs';

const link = g.resource('customerLabels', '41');

export default {
  family: 'google_customer_labels',
  risk: 'destructive',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: {...g.connection, accountLoginCustomers: {123: '999'}},
  credentials: {accessToken: 'synthetic'},
  request: {action: 'google_ads_v23_customer_label_mutate_customer_labels', payload: {operations: [{remove: link}]}},
  seed: () => ({
    customer_label: [{resourceName: link, customer: 'customers/123', label: 'customers/999/labels/41'}],
  }),
  paginatedCodes: ['CUSTOMER_LABEL_STATE_UNVERIFIED'],
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, body, state, mode} = request;
    if (g.isSearch(request)) return g.table(request);
    if (path === '/v25/customers/123/customerLabels:mutate') {
      if (mode.partial) return g.partialFailure();
      for (const op of body.operations)
        state.customer_label = state.customer_label.filter(l => l.resourceName !== op.remove);
      return {json: {results: body.operations.map(op => ({resourceName: op.remove}))}};
    }
  },
  decisive: {change: state => (state.customer_label[0].label = 'customers/998/labels/41'), field: /label/},
};
