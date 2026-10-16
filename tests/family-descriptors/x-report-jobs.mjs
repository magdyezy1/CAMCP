// x_report_jobs: POST /12/stats/jobs/accounts/{account} (X Ads API v12, Asynchronous Analytics) creating a report job with
// a frozen definition. X reports in the account's currency and buckets days in its time zone, so the decisive field is
// the account's `currency`: a currency changed in X after the review would give the reviewed report other amounts.
import {account, credentials, missing} from './_x.mjs';

const job = '1120829647711653888';

export default {
  family: 'x_report_jobs',
  risk: 'settings',
  gateway: 'x_ads_native_action',
  account,
  credentials,
  request: {
    action: 'x_stats_jobs_accounts_account_id_post',
    params: {
      entity: 'CAMPAIGN',
      entity_ids: 'camp1',
      metric_groups: 'ENGAGEMENT,BILLING',
      placement: 'ALL_ON_TWITTER',
      granularity: 'TOTAL',
      start_time: '2026-08-01T00:00:00Z',
      end_time: '2026-08-03T00:00:00Z',
    },
  },
  seed: () => ({account: {id: account, currency: 'SAR', timezone: 'UTC', deleted: false, name: 'Account'}, jobs: []}),
  unpaginated: 'the account and each reported entity are read by ID as one entity each',
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, url, state, mode}) {
    const q = Object.fromEntries(url.searchParams);
    if (method === 'GET') {
      if (path === '/12/accounts/' + account) return {json: {data: structuredClone(state.account)}};
      if (path === '/12/accounts/' + account + '/campaigns/camp1')
        return {json: {data: {id: 'camp1', account_id: account, deleted: false, name: 'Spring'}}};
      if (path === '/12/stats/jobs/accounts/' + account)
        return {json: {data: structuredClone(state.jobs), next_cursor: null, request: {params: {}}}};
      return missing();
    }
    if (method === 'POST' && path === '/12/stats/jobs/accounts/' + account) {
      // A partial answer: X answers with an error and no job.
      if (mode.partial) return {json: {errors: [{code: 'INVALID_PARAMETER', message: 'Rejected'}]}};
      const row = {
        ...q,
        entity_ids: q.entity_ids.split(','),
        metric_groups: q.metric_groups.split(','),
        segmentation_type: null,
        country: null,
        platform: null,
        account_id: account,
        id_str: job,
        id: Number(job),
        status: 'PROCESSING',
        url: null,
        expires_at: null,
      };
      state.jobs.push(row);
      return {json: {data: structuredClone(row), request: {params: {}}}};
    }
  },
  decisive: {change: state => (state.account.currency = 'USD'), field: /currency/},
};
