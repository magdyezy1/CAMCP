// Synthetic BASIC daily pages, shaped like TikTok's documented list/page_info response.
export const reportDay = '2026-09-01';
const rows = (length, start = 1) =>
  Array.from({length}, (_, i) => ({
    dimensions: {campaign_id: String(start + i), stat_time_day: reportDay},
    metrics: {campaign_name: 'Synthetic ' + (start + i), spend: '1', impressions: '10', clicks: '2', conversion: '1'},
  }));
const page = (length, number, total = 1500, pages = 2, start = 1) => ({
  list: rows(length, start),
  page_info: {page: number, page_size: 1000, total_number: total, total_page: pages},
});
export function tiktokPageFixtures() {
  return [
    {name: 'short last page', pages: [page(1000, 1), page(500, 2, 1500, 2, 1001)], expected: {complete: true}},
    {
      name: 'short middle page',
      pages: [page(900, 1), page(500, 2, 1500, 2, 1001)],
      expected: {complete: false, returned: 1400},
    },
    {name: 'empty first page', pages: [page(0, 1), page(0, 2)], expected: {complete: false, returned: 0}},
    {
      name: 'basis mismatch',
      pages: [page(1000, 1, 1500, 3), page(500, 2, 1500, 3, 1001), page(0, 3, 1500, 3)],
      expected: {complete: true, rule: 'total_page_basis_mismatch'},
    },
    {
      name: 'changing totals',
      pages: [page(1000, 1), page(500, 2, 1600, 2, 1001)],
      expected: {code: 'REPORT_INCOMPLETE', rule: 'total_changed'},
    },
    {
      name: 'duplicate tuples',
      pages: [page(1000, 1), page(500, 2)],
      expected: {code: 'REPORT_DUPLICATE_ROWS', rule: 'duplicate_tuple'},
    },
    {
      name: 'page longer than size',
      pages: [page(1001, 1)],
      expected: {code: 'REPORT_INCOMPLETE', rule: 'page_longer_than_size'},
    },
    {
      name: 'more rows than declared',
      pages: [page(1000, 1, 900, 1)],
      expected: {code: 'REPORT_INCOMPLETE', rule: 'more_rows_than_declared'},
    },
    {name: 'zero total', pages: [page(0, 1, 0, 0)], expected: {complete: true}},
    {name: 'missing page_info', pages: [{list: []}], expected: {code: 'REPORT_INCOMPLETE', rule: 'page_info_missing'}},
    {
      name: 'missing totals, empty list',
      pages: [{list: [], page_info: {page: 1, page_size: 1000}}],
      expected: {complete: true, rule: 'empty_report'},
    },
    {
      name: 'missing totals, rows',
      pages: [{list: rows(3), page_info: {page: 1, page_size: 1000}}],
      expected: {code: 'REPORT_INCOMPLETE', rule: 'total_not_integer'},
    },
  ];
}
