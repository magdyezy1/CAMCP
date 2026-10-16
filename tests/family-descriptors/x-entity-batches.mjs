// x_entity_batches: POST /12/batch/accounts/{account}/campaigns (X Ads API v12, Campaign Management batch) deleting two
// paused campaigns; "Deleting a campaign is not reversible". The decisive field is each campaign's `entity_status`: a
// campaign activated in X after the review would be deleted while it serves, which the owner never reviewed.
import {account, credentials, missing, reply, suffix} from './_x.mjs';

const campaign = (id, name) => ({
  id,
  account_id: account,
  name,
  funding_instrument_id: 'fi1',
  entity_status: 'PAUSED',
  daily_budget_amount_local_micro: 5000000,
  deleted: false,
  servable: false,
});

export default {
  family: 'x_entity_batches',
  risk: 'destructive',
  gateway: 'x_ads_native_action',
  account,
  credentials,
  request: {
    action: 'x_batch_accounts_account_id_campaigns_post',
    payload: [
      {operation_type: 'Delete', params: {campaign_id: 'c1'}},
      {operation_type: 'Delete', params: {campaign_id: 'c2'}},
    ],
  },
  seed: () => ({campaigns: {c1: campaign('c1', 'Spring'), c2: campaign('c2', 'Summer')}}),
  unpaginated: 'the account and each campaign of the batch are read by ID as one entity each',
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    const s = suffix(path);
    if (method === 'GET') {
      if (s === '') return reply({id: account, name: 'Account', approval_status: 'ACCEPTED', deleted: false});
      const c = /^\/campaigns\/(\w+)$/.exec(s ?? '')?.[1];
      return c && state.campaigns[c] ? reply(state.campaigns[c]) : missing();
    }
    if (method === 'POST' && path === '/12/batch/accounts/' + account + '/campaigns') {
      // A partial answer: X names an item error for the second campaign.
      if (mode.partial)
        return {
          json: {
            data: [],
            operation_errors: [[], [{code: 'INVALID_PARAMETER', message: 'Campaign cannot be deleted'}]],
            request: {params: {}},
          },
        };
      const rows = body.map(o => {
        state.campaigns[o.params.campaign_id] = {...state.campaigns[o.params.campaign_id], deleted: true};
        return state.campaigns[o.params.campaign_id];
      });
      return {json: {data: structuredClone(rows), request: {params: {account_id: account}}}};
    }
  },
  decisive: {change: state => (state.campaigns.c2.entity_status = 'ACTIVE'), field: /entity_status/},
};
