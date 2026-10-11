// meta_insights_jobs: POST /act_{id}/insights (Meta Marketing API v26.0, Insights, asynchronous jobs) creating a report
// job with a frozen definition. Meta reports the job's dates in the ad account's time zone, so the decisive field is the
// account's `timezone_name`: a time zone changed in Meta after the review would give the reviewed dates another
// meaning.
import {decode, unsupported, v} from './_meta.mjs';

export default {
  family: 'meta_insights_jobs',
  risk: 'settings',
  gateway: 'meta_native_action',
  account: '123',
  connection: {scopes: ['ads_read']},
  request: {
    action: 'meta_ad_account_id_insights_report_create',
    payload: {
      fields: ['account_id', 'account_currency', 'date_start', 'date_stop', 'impressions', 'spend'],
      level: 'account',
      time_range: {since: '2026-08-01', until: '2026-08-03'},
      time_increment: '1',
      use_unified_attribution_setting: true,
    },
  },
  seed: () => ({
    next: 900,
    jobs: {},
    account: {id: 'act_123', account_status: 1, currency: 'USD', timezone_name: 'Africa/Cairo'},
  }),
  unpaginated: 'GET /act_{id} and GET /{report_run_id} return one node each; Meta pages only edges',
  isWrite: ({method}) => method === 'POST',
  provider({method, path, body, state, mode}) {
    if (method === 'POST' && path === v + '/act_123/insights') {
      const b = decode(body),
        id = String(state.next++);
      state.jobs[id] = {
        id,
        account_id: '123',
        async_status: 'Job Completed',
        async_percent_completion: 100,
        date_start: b.time_range.since,
        date_stop: b.time_range.until,
        ...b,
      };
      // A partial answer: Meta names the job beside an error.
      if (mode.partial) return {json: {report_run_id: id, errors: [{message: 'Failed'}]}};
      return {json: {report_run_id: id}};
    }
    if (method !== 'GET') return unsupported();
    if (path === v + '/act_123') return {json: structuredClone(state.account)};
    const job = state.jobs[path.slice(v.length + 1)];
    return job ? {json: structuredClone(job)} : unsupported();
  },
  decisive: {change: state => (state.account.timezone_name = 'Asia/Riyadh'), field: /timezone/},
};
