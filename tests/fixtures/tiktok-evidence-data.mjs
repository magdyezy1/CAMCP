export const tiktokEvidenceDay = offset => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
export const tiktokEvidenceInput = {
  action: 'capture_preset',
  preset: 'tiktok_campaign',
  account_id: '100',
  connection_id: 'ffffffff-1111-4111-8111-111111111113',
  semantics: {
    currency: 'USD',
    timezone: 'Etc/GMT',
    date_from: tiktokEvidenceDay(2),
    date_to: tiktokEvidenceDay(1),
    attribution: 'unknown',
    source_name: 'Synthetic TikTok daily',
    complete: true,
  },
};
export const tiktokEvidenceRow = (entity = 'campaign', id = '9007199254740993') => ({
  dimensions: {[entity + '_id']: id, stat_time_day: tiktokEvidenceInput.semantics.date_from + ' 00:00:00'},
  metrics: {[entity + '_name']: 'Home <img>', spend: '10.123456789', impressions: '100', clicks: '12', conversion: '2'},
});
export function tiktokEvidenceResponse(raw, rows) {
  const url = new URL(raw);
  if (url.pathname.endsWith('/advertiser/info/'))
    return {
      code: 0,
      message: 'OK',
      data: {list: [{advertiser_id: '100', currency: 'USD', timezone: 'Etc/GMT', private: 'PRIVATE-BILLING'}]},
    };
  if (!url.pathname.endsWith('/report/integrated/get/')) throw Error('Unexpected TikTok route');
  const entity = JSON.parse(url.searchParams.get('dimensions'))[0].replace(/_id$/, ''),
    all = rows ?? [tiktokEvidenceRow(entity)],
    page = Number(url.searchParams.get('page')),
    size = Number(url.searchParams.get('page_size'));
  return {
    code: 0,
    message: 'OK',
    data: {
      list: all.slice((page - 1) * size, page * size),
      page_info: {page, page_size: size, total_number: all.length, total_page: Math.ceil(all.length / size)},
    },
  };
}
