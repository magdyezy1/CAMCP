import test from 'node:test';
import assert from 'node:assert/strict';
import {appleQueryPages, appleQueryBounds} from '../dist/src/apple-report-pages.js';
import {assertRefused} from './helpers/assert-refused.mjs';

// V2-RPT-07 Task 13 / F-L7-02. The one bounded paging helper of Apple's reports and entity queries, over answers shaped as
// Apple's pages show them: `pagination` beside `result`, `totalCount` as its total, `pageSize` echoing the size asked in
// every endpoint example and the rows returned in QueryPaginationResult's, a report always stating its total and an entity
// query only when `fetchTotalCount` asks (docs/records/APPLE-ADS-PLATFORM-PINS-2026-11-06.md).
const report = {
  kind: 'report',
  list: 'ad groups',
  path: '/v1/reports/apps/adgroups/query',
  action: 'apple_ads_v1_reports_apps_adgroups',
  stage: 'detail_report',
  body: {timeRange: {start: '2026-08-01', end: '2026-08-07', timeZone: 'UTC'}},
};
const entities = {
  kind: 'entities',
  list: 'ad groups',
  path: '/v1/adgroups/query',
  action: 'apple_ads_v1_adgroups_query',
  stage: 'detail_parents',
  body: {filters: [{field: 'id', operator: 'IN', value: [1, 2, 3]}]},
};
/** A collection whose `run` answers like Apple and records each request it was given. */
function collection(answer) {
  const c = {
    calls: [],
    plan: (path, query, body, origin) => ({path, query, body, origin, method: 'POST'}),
    async run(plan, aggregate, stage) {
      c.calls.push({plan, aggregate, stage});
      return answer(plan.body, c.calls.length);
    },
  };
  return c;
}
/** A list of `count` rows, served as Apple does. */
function listing({count, cap, total = 'count', echo = 'requested', shape = 'report'} = {}) {
  return body => {
    const {offset, pageSize} = body.pagination,
      size = Math.min(pageSize, cap ?? pageSize),
      rows = Array.from({length: Math.max(0, Math.min(size, count - offset))}, (_, i) => ({id: offset + i})),
      pagination = {
        ...(total === 'count' ? {totalCount: count} : total === 'results' ? {totalResults: count} : {}),
        offset,
        pageSize: echo === 'returned' ? rows.length : pageSize,
      };
    return shape === 'report' ? {result: {rows}, pagination} : {result: rows, pagination};
  };
}
const offsets = c => c.calls.map(call => call.plan.body.pagination.offset);

test('pages of the documented size are read to the total, each as one provider request', async () => {
  const c = collection(listing({count: 2500})),
    read = await appleQueryPages(c, report);
  assert.equal(read.rows.length, 2500);
  assert.deepEqual(
    read.rows.map(row => row.id),
    Array.from({length: 2500}, (_, i) => i),
  );
  assert.deepEqual(offsets(c), [0, 1000, 2000]);
  assert.equal(read.pages, 3);
  assert.equal(read.total, 2500);
  for (const call of c.calls) {
    assert.equal(call.plan.body.pagination.pageSize, appleQueryBounds.page_size);
    assert.ok(appleQueryBounds.page_size <= 1000, 'inside the report ceiling (5000) and the campaign query cap (1000)');
    assert.equal(call.aggregate, false, 'a page is one provider request; the helper does the paging');
    assert.equal(call.stage, 'detail_report');
    assert.equal(call.plan.origin, 'https://api.ads.apple.com');
    assert.equal(call.plan.path, report.path);
    assert.deepEqual(call.plan.body.timeRange, report.body.timeRange);
  }
});

test('a report sends no total flag; an entity query asks for the total', async () => {
  const r = collection(listing({count: 5})),
    q = collection(listing({count: 5, shape: 'query'}));
  await appleQueryPages(r, report);
  await appleQueryPages(q, entities);
  assert.deepEqual(Object.keys(r.calls[0].plan.body.pagination).sort(), ['offset', 'pageSize']);
  assert.deepEqual(Object.keys(q.calls[0].plan.body.pagination).sort(), ['fetchTotalCount', 'offset', 'pageSize']);
  assert.equal(q.calls[0].plan.body.pagination.fetchTotalCount, true);
  assert.deepEqual(q.calls[0].plan.body.filters, entities.body.filters, 'the filters are the caller’s');
});

test('a page short of the total continues at the rows received, not at the size asked or the size echoed', async () => {
  for (const echo of ['requested', 'returned']) {
    const c = collection(listing({count: 2500, cap: 700, echo})),
      read = await appleQueryPages(c, report);
    assert.equal(read.rows.length, 2500, echo);
    assert.deepEqual(offsets(c), [0, 700, 1400, 2100], echo);
    assert.deepEqual(
      read.rows.map(row => row.id),
      Array.from({length: 2500}, (_, i) => i),
      echo + ': no row twice, none missed',
    );
  }
});

test('without a total the list is read to an empty page; a count under another name is not a total', async () => {
  for (const total of ['absent', 'results']) {
    const c = collection(listing({count: 2500, total})),
      read = await appleQueryPages(c, report);
    assert.equal(read.rows.length, 2500, total);
    assert.equal(read.total, null, total);
    assert.deepEqual(offsets(c), [0, 1000, 2000, 2500], total + ': the empty page at the end is read');
  }
  // A total inside `result` is not read either: Apple's pages put pagination beside it.
  const nested = collection(body => {
      const page = listing({count: 30})(body);
      return {result: {...page.result, pagination: page.pagination}};
    }),
    read = await appleQueryPages(nested, report);
  assert.equal(read.rows.length, 30);
  assert.equal(read.total, null);
});

test('an empty list with a total of zero, or with none, is complete after one request', async () => {
  for (const total of ['count', 'absent']) {
    const c = collection(listing({count: 0, total})),
      read = await appleQueryPages(c, report);
    assert.deepEqual(read.rows, [], total);
    assert.equal(c.calls.length, 1, total);
  }
});

test('the row limit the caller leaves is the bound, and a total over it refuses before another page is read', async () => {
  const c = collection(listing({count: 10001}));
  await assert.rejects(appleQueryPages(c, report), e =>
    assertRefused(e, 'REPORT_COLLECTION_LIMIT', {status: 422, message: /more than 10,000 ad groups/}),
  );
  assert.equal(c.calls.length, 1, 'the total proved it too long on the first page');
  // The caller passes what is left of the report's rows after the lists it already read.
  const left = collection(listing({count: 2500}));
  await assert.rejects(appleQueryPages(left, report, 1500), e => assertRefused(e, 'REPORT_COLLECTION_LIMIT'));
  assert.equal(left.calls.length, 1);
  const exact = collection(listing({count: 10000}));
  assert.equal((await appleQueryPages(exact, report)).rows.length, 10000, 'the bound itself is allowed');
});

test('without a total, rows past the bound refuse as soon as they are read', async () => {
  const c = collection(listing({count: 50000, total: 'absent'}));
  await assert.rejects(appleQueryPages(c, report), e =>
    assertRefused(e, 'REPORT_COLLECTION_LIMIT', {message: /more than 10,000 ad groups/}),
  );
  assert.equal(c.calls.length, 11);
});

test('short pages that never end stop at the page bound without shortening the list', async () => {
  const c = collection(listing({count: 5000, cap: 100}));
  await assert.rejects(appleQueryPages(c, report), e =>
    assertRefused(e, 'REPORT_INCOMPLETE', {status: 502, message: /over more than 25 pages, the most a report reads/}),
  );
  assert.equal(c.calls.length, appleQueryBounds.pages);
  assert.equal(appleQueryBounds.pages, 25);
});

const refusals = [
  [
    'a total that changes between pages',
    (body, n) => {
      const page = listing({count: 2500})(body);
      if (n > 1) page.pagination.totalCount = 2400;
      return page;
    },
    'REPORT_INCOMPLETE',
    /changed the total it reported for ad groups/,
  ],
  [
    'an empty page before the total',
    (body, n) => {
      const page = listing({count: 2500})(body);
      if (n === 2) page.result.rows = [];
      return page;
    },
    'REPORT_INCOMPLETE',
    /empty page before the total it reported for ad groups/,
  ],
  [
    'more rows than the total',
    body => {
      const page = listing({count: 2500})(body);
      page.pagination.totalCount = 500;
      return page;
    },
    'REPORT_INCOMPLETE',
    /inconsistent pagination while listing ad groups/,
  ],
  [
    'more rows than were asked for',
    body => {
      const page = listing({count: 5000})(body);
      page.result.rows.push(...page.result.rows);
      return page;
    },
    'REPORT_INCOMPLETE',
    /inconsistent pagination while listing ad groups/,
  ],
  [
    'an offset that is not the one asked',
    body => {
      const page = listing({count: 2500})(body);
      page.pagination.offset = body.pagination.offset + 1;
      return page;
    },
    'REPORT_INCOMPLETE',
    /inconsistent pagination/,
  ],
  [
    'a negative page size',
    body => {
      const page = listing({count: 2500})(body);
      page.pagination.pageSize = -1;
      return page;
    },
    'REPORT_INCOMPLETE',
    /inconsistent pagination/,
  ],
  [
    'a page size that is not an integer',
    body => {
      const page = listing({count: 2500})(body);
      page.pagination.pageSize = '1000';
      return page;
    },
    'REPORT_INCOMPLETE',
    /inconsistent pagination/,
  ],
  [
    'a total that is not a whole number',
    body => {
      const page = listing({count: 2500})(body);
      page.pagination.totalCount = '2500';
      return page;
    },
    'REPORT_INCOMPLETE',
    /inconsistent pagination/,
  ],
  [
    'rows that are not a list',
    body => {
      const page = listing({count: 5})(body);
      page.result.rows = {};
      return page;
    },
    'REPORT_SHAPE_CHANGED',
    /ad groups in a shape AMCP cannot read/,
  ],
  [
    'a row that is not an object',
    body => {
      const page = listing({count: 5})(body);
      page.result.rows[1] = 'row';
      return page;
    },
    'REPORT_SHAPE_CHANGED',
    /ad groups in a shape AMCP cannot read/,
  ],
  ['a missing result', () => ({pagination: {totalCount: 0, offset: 0, pageSize: 1000}}), 'REPORT_SHAPE_CHANGED'],
];
for (const [name, answer, code, message] of refusals)
  test('the list is refused, never shortened, for ' + name, async () => {
    const c = collection(answer);
    await assert.rejects(appleQueryPages(c, report), e => assertRefused(e, code, {message}));
  });

test('an entity query is read from a result list beside its pagination', async () => {
  const c = collection(listing({count: 2500, cap: 1000, shape: 'query'})),
    read = await appleQueryPages(c, entities);
  assert.equal(read.rows.length, 2500);
  const flat = collection(() => ({result: {rows: []}, pagination: {totalCount: 0, offset: 0, pageSize: 1000}}));
  await assert.rejects(appleQueryPages(flat, entities), e => assertRefused(e, 'REPORT_SHAPE_CHANGED'));
});
