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
const emptyReport = (name, data) => ({
  name,
  pages: [data],
  expected: {complete: true, returned: 0, rule: 'empty_report'},
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
    // TikTok documents no values for an empty report (provider-docs T3), so every shape of "nothing" is empty and
    // complete (F-L1-01; the plan's "missing or zero page fields are handled defensively"). E4 to E7 are the shapes
    // the audit probed; the three after them are the other echo failures an empty page can carry.
    emptyReport('empty report, page_info {} (E4)', {list: [], page_info: {}}),
    emptyReport('empty report, page_info absent (E5)', {list: []}),
    emptyReport('empty report, every page field zero (E6)', {
      list: [],
      page_info: {page: 0, page_size: 0, total_number: 0, total_page: 0},
    }),
    emptyReport('empty report, counts without page and page_size (E7)', {
      list: [],
      page_info: {total_number: 0, total_page: 0},
    }),
    emptyReport('empty report, page_size not echoed', {
      list: [],
      page_info: {page: 1, page_size: 10, total_number: 0, total_page: 0},
    }),
    emptyReport('empty report, page zero', {
      list: [],
      page_info: {page: 0, page_size: 1000, total_number: 0, total_page: 0},
    }),
    emptyReport('empty report, page_size zero and one page', {
      list: [],
      page_info: {page: 1, page_size: 0, total_number: 0, total_page: 1},
    }),
    // What stays refused: rows without usable page counts, and counts that say rows exist.
    {
      name: 'rows without page_info',
      pages: [{list: rows(3)}],
      expected: {code: 'REPORT_INCOMPLETE', rule: 'page_info_missing'},
    },
    {
      name: 'rows with an empty page_info',
      pages: [{list: rows(3), page_info: {}}],
      expected: {code: 'REPORT_INCOMPLETE', rule: 'page_not_echoed'},
    },
    {
      name: 'rows with every page field zero',
      pages: [{list: rows(3), page_info: {page: 0, page_size: 0, total_number: 3, total_page: 1}}],
      expected: {code: 'REPORT_INCOMPLETE', rule: 'page_not_echoed'},
    },
    {
      name: 'no rows but a declared total, page fields zero',
      pages: [{list: [], page_info: {page: 0, page_size: 0, total_number: 5, total_page: 1}}],
      expected: {code: 'REPORT_INCOMPLETE', rule: 'page_not_echoed'},
    },
    {
      name: 'no rows, zero total, several pages declared',
      pages: [{list: [], page_info: {page: 0, page_size: 0, total_number: 0, total_page: 3}}],
      expected: {code: 'REPORT_INCOMPLETE', rule: 'page_not_echoed'},
    },
    {
      name: 'no rows, page fields that are not integers',
      pages: [{list: [], page_info: {page: '1', page_size: '1000', total_number: 0, total_page: 0}}],
      expected: {code: 'REPORT_INCOMPLETE', rule: 'page_not_echoed'},
    },
    // The empty-report allowance is for the first page of a collection only: a later page that names no counts, or
    // zero counts, cannot cut a declared collection short.
    {
      name: 'later page without page_info',
      pages: [page(1000, 1), {list: []}],
      expected: {code: 'REPORT_INCOMPLETE', rule: 'page_info_missing'},
    },
    {
      name: 'later page with every page field zero',
      pages: [page(1000, 1), {list: [], page_info: {page: 0, page_size: 0, total_number: 0, total_page: 0}}],
      expected: {code: 'REPORT_INCOMPLETE', rule: 'page_not_echoed'},
    },
    {
      name: 'no rows, null totals',
      pages: [{list: [], page_info: {page: 1, page_size: 1000, total_number: null, total_page: null}}],
      expected: {code: 'REPORT_INCOMPLETE', rule: 'total_not_integer'},
    },
  ];
}
