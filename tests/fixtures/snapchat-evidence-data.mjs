import {zonedMidnight} from '../../dist/src/workflows.js';
export const snapchatEvidenceAccount = '11111111-1111-4111-8111-111111111111';
export const snapchatEvidenceInput = {
  action: 'capture_preset',
  preset: 'snapchat_campaign',
  connection_id: '33333333-3333-4333-8333-333333333333',
  account_id: snapchatEvidenceAccount,
  swipe_up_attribution_window: '7_DAY',
  view_attribution_window: '1_DAY',
  semantics: {
    source_name: 'Synthetic Snapchat purchases',
    currency: 'USD',
    timezone: 'Asia/Riyadh',
    date_from: '2026-09-01',
    date_to: '2026-09-02',
    attribution: 'caller text is not authority',
    conversion_definition: 'caller text is not authority',
    complete: true,
  },
};
export const snapchatEvidenceId = i => '22222222-2222-4222-8222-' + String(i).padStart(12, '0');
export function snapchatEvidenceDates(sem = snapchatEvidenceInput.semantics) {
  const dates = [];
  for (let at = Date.parse(sem.date_from); at <= Date.parse(sem.date_to) + 86400000; at += 86400000)
    dates.push({
      date: new Date(at).toISOString().slice(0, 10),
      time: new Date(zonedMidnight(new Date(at).toISOString().slice(0, 10), sem.timezone, true)).toISOString(),
    });
  return dates;
}
export function snapchatEvidenceEntity(
  level = 'campaign',
  id = snapchatEvidenceId(1),
  sem = snapchatEvidenceInput.semantics,
) {
  const dates = snapchatEvidenceDates(sem);
  return {
    id,
    type: level.toUpperCase(),
    granularity: 'DAY',
    start_time: dates[0].time,
    end_time: dates.at(-1).time,
    timeseries: dates.slice(0, -1).map((d, i) => ({
      start_time: d.time,
      end_time: dates[i + 1].time,
      stats: {spend: '10123456', impressions: 1000, swipes: 30, conversion_purchases: 2},
    })),
  };
}
export function snapchatEvidenceResponse(raw, rows, sem = snapchatEvidenceInput.semantics) {
  const url = new URL(raw),
    account = snapchatEvidenceAccount,
    dates = snapchatEvidenceDates(sem);
  if (url.pathname === '/v1/adaccounts/' + account)
    return {
      request_status: 'SUCCESS',
      adaccounts: [
        {sub_request_status: 'SUCCESS', adaccount: {id: account, currency: sem.currency, timezone: sem.timezone}},
      ],
    };
  if (url.pathname !== '/v1/adaccounts/' + account + '/stats') throw Error('Unexpected Snapchat URL: ' + url.pathname);
  const level = url.searchParams.get('breakdown'),
    all = rows ?? [snapchatEvidenceEntity(level, undefined, sem)],
    offset = Number(url.searchParams.get('cursor') ?? 0),
    page = all.slice(offset, offset + 200),
    next = new URL(url);
  next.searchParams.set('cursor', String(offset + 200));
  return {
    request_status: 'SUCCESS',
    request_id: 'synthetic-source-' + offset,
    paging: offset + 200 < all.length ? {next_link: next.href} : {},
    timeseries_stats: [
      {
        sub_request_status: 'SUCCESS',
        timeseries_stat: {
          id: account,
          type: 'AD_ACCOUNT',
          granularity: 'DAY',
          start_time: dates[0].time,
          end_time: dates.at(-1).time,
          swipe_up_attribution_window: url.searchParams.get('swipe_up_attribution_window'),
          view_attribution_window: url.searchParams.get('view_attribution_window'),
          finalized_data_end_time: dates.at(-1).time,
          conversion_data_processed_end_time: dates.at(-1).time,
          breakdown_stats: {[level]: page},
          split_results: [],
        },
      },
    ],
  };
}
