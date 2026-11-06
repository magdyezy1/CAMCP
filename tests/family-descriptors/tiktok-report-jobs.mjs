// tiktok_report_jobs: POST /v1.3/report/task/create/ (API for Business v1.3, "Create an asynchronous report task").
// TikTok reads start_date and end_date in the advertiser's time zone, so the decisive field is the advertiser's
// `timezone` in "Get advertiser info": a time zone changed after the review moves the reviewed reporting window.
const answer = data => ({json: {code: 0, message: 'OK', request_id: 'r', data}});

export default {
  family: 'tiktok_report_jobs',
  risk: 'settings',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {
    action: 'tiktok_report_task_create',
    payload: {
      advertiser_id: '123',
      service_type: 'AUCTION',
      report_type: 'BASIC',
      data_level: 'AUCTION_CAMPAIGN',
      dimensions: ['campaign_id', 'stat_time_day'],
      metrics: ['spend', 'clicks', 'impressions'],
      start_date: '2026-08-01',
      end_date: '2026-08-02',
      output_format: 'CSV_STRING',
      enable_report_title_translation: false,
    },
  },
  seed: () => ({
    advertiser: {advertiser_id: '123', name: 'Advertiser', currency: 'USD', timezone: 'Africa/Cairo'},
    tasks: 0,
  }),
  // The family refuses an advertiser read that carries anything besides its one-row list, page information included.
  paginatedCodes: ['TIKTOK_REPORT_STATE_UNVERIFIED'],
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/report/task/create/'),
  provider({method, path, state, mode}) {
    if (method === 'GET' && path.endsWith('/v1.3/advertiser/info/'))
      return answer({
        list: [{...state.advertiser}],
        ...(mode.paginate ? {page_info: {page: 1, page_size: 1, total_number: 2, total_page: 2}} : {}),
      });
    if (method === 'POST' && path.endsWith('/v1.3/report/task/create/')) {
      // 40002 is a parameter refusal that TikTok's return-code table leaves unmapped (a provider-reported PLATFORM_ERROR);
      // 40001 is a mapped access denial, which the conformance check's code list does not hold.
      if (mode.partial) return {json: {code: 40002, message: 'Rejected', request_id: 'r', data: {}}};
      return answer({task_id: 'job-' + ++state.tasks});
    }
  },
  decisive: {change: state => (state.advertiser.timezone = 'Asia/Riyadh'), field: /timezone/},
};
