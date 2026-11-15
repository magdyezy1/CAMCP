import test from 'node:test';
import assert from 'node:assert/strict';
import {tiktokPageCheck} from '../dist/src/tiktok-report-pagination.js';
import {assertRefused} from './helpers/assert-refused.mjs';

// r25-hotfix item 1 (V2-RPT-01): TikTok's integrated report answers page_info.page_size with the requested size when the
// report is empty or runs to several pages (the partial last page included), and with its row count when the whole report
// fits on one page (read live on 2026-11-15). The check accepts that second shape for a whole report on page one only, and
// keeps refusing every other page that does not echo the request. Rows and counts here are synthetic.
const rows = count =>
  Array.from({length: count}, (_, i) => ({dimensions: {campaign_id: String(i + 1)}, metrics: {spend: '1'}}));
const page = (count, info) => ({list: rows(count), page_info: info});
const fresh = {total: null, returned: 0};
const check = (data, request = {page: 1, size: 1000}, seen = fresh) => tiktokPageCheck(data, request, seen);
const refusedAs = (rule, data, request, seen) =>
  assert.throws(
    () => check(data, request, seen),
    error => {
      assertRefused(error, 'REPORT_INCOMPLETE');
      assert.equal(error.details.page_facts.rule, rule);
      return true;
    },
  );

test('a whole report on page one that reports its row count as page_size is accepted, for 1 to 999 rows', () => {
  // [requested size, rows]: the live answers (7, 14, 28 and 30 rows of 1000; 2 of 10; 3 of 5) and both ends of 1 to 999.
  for (const [size, count] of [
    [1000, 7],
    [1000, 14],
    [1000, 28],
    [1000, 30],
    [10, 2],
    [5, 3],
    [1000, 1],
    [1000, 999],
  ]) {
    const checked = check(
      page(count, {page: 1, page_size: count, total_number: count, total_page: 1}),
      {page: 1, size},
      fresh,
    );
    assert.deepEqual(
      {rows: checked.rows.length, total: checked.total, pages: checked.pages, facts: checked.facts},
      {rows: count, total: count, pages: 1, facts: null},
      count + ' rows of ' + size,
    );
  }
});

test('a page that fills the request keeps being accepted on the echoed size', () => {
  const checked = check(page(1000, {page: 1, page_size: 1000, total_number: 1000, total_page: 1}));
  assert.equal(checked.rows.length, 1000);
  assert.equal(checked.facts, null);
});

test('a report of several pages echoes the requested size on every page, the partial last page included', () => {
  // Live: requested 20 with 60 rows gave 20 on all three pages; requested 25 gave 25 on pages 1 and 3 (10 rows on page 3).
  for (const [size, counts] of [
    [20, [20, 20, 20]],
    [25, [25, 25, 10]],
  ]) {
    let seen = fresh;
    counts.forEach((count, i) => {
      const number = i + 1,
        checked = check(
          page(count, {page: number, page_size: size, total_number: 60, total_page: 3}),
          {page: number, size},
          seen,
        );
      assert.equal(checked.pages, 3, 'size ' + size + ' page ' + number);
      assert.equal(checked.facts, null, 'size ' + size + ' page ' + number);
      seen = {total: checked.total, returned: seen.returned + checked.rows.length};
    });
    assert.equal(seen.returned, 60);
  }
});

test('an empty report echoes the requested size and is still an empty report', () => {
  const checked = check({list: [], page_info: {page: 1, page_size: 1000, total_number: 0, total_page: 0}});
  assert.equal(checked.total, 0);
  assert.equal(checked.rows.length, 0);
  assert.equal(checked.facts.rule, 'empty_report');
});

// What must keep refusing. Each case differs from an accepted page in one fact.
test('a single page whose page_size is below its row count is refused', () => {
  refusedAs('page_not_echoed', page(7, {page: 1, page_size: 5, total_number: 7, total_page: 1}));
});

test('a single page whose page_size is above its row count, and not the request, is refused', () => {
  refusedAs('page_not_echoed', page(7, {page: 1, page_size: 10, total_number: 7, total_page: 1}));
});

test('a total_number that is not the row count is refused on a total_page of 1', () => {
  refusedAs('page_not_echoed', page(7, {page: 1, page_size: 7, total_number: 9, total_page: 1}));
  refusedAs('page_not_echoed', page(7, {page: 1, page_size: 7, total_number: 5, total_page: 1}));
});

test('a report that is not one page, or does not say so, is refused', () => {
  refusedAs('page_not_echoed', page(7, {page: 1, page_size: 7, total_number: 7, total_page: 2}));
  refusedAs('page_not_echoed', page(7, {page: 1, page_size: 7, total_number: 7, total_page: 0}));
  refusedAs('page_not_echoed', page(7, {page: 1, page_size: 7, total_number: 7}));
});

test('a first page that does not name itself page 1 is refused', () => {
  refusedAs('page_not_echoed', page(7, {page: 2, page_size: 7, total_number: 7, total_page: 1}));
  refusedAs('page_not_echoed', page(7, {page_size: 7, total_number: 7, total_page: 1}));
});

test('counts that are missing or not integers are refused', () => {
  refusedAs('page_not_echoed', page(7, {page: 1, page_size: '7', total_number: 7, total_page: 1}));
  refusedAs('page_not_echoed', page(7, {page: 1, page_size: 7, total_number: '7', total_page: 1}));
  refusedAs('page_not_echoed', page(7, {page: 1, page_size: 7, total_number: null, total_page: 1}));
  refusedAs('page_not_echoed', page(7, {page: 1, total_number: 7, total_page: 1}));
  refusedAs('page_info_missing', {list: rows(7)});
  // Echoed page_size, but the total is absent or not a count.
  refusedAs('total_not_integer', page(7, {page: 1, page_size: 1000}));
  refusedAs('total_not_integer', page(7, {page: 1, page_size: 1000, total_number: 7.5, total_page: 1}));
});

test('a page longer than the size requested is refused, whatever its page_size says', () => {
  // Echoing the size: longer than the page size.
  refusedAs('page_longer_than_size', page(1001, {page: 1, page_size: 1000, total_number: 1001, total_page: 1}));
  // Reporting its own length as page_size: not a whole report that fits the request.
  refusedAs('page_not_echoed', page(1001, {page: 1, page_size: 1001, total_number: 1001, total_page: 1}));
  refusedAs('page_not_echoed', page(7, {page: 1, page_size: 7, total_number: 7, total_page: 1}), {page: 1, size: 5});
});

test('a page beyond the first that does not echo the request is refused', () => {
  const seen = {total: 1500, returned: 1000};
  // Reports its own row count, as a one-page report does.
  refusedAs(
    'page_not_echoed',
    page(500, {page: 2, page_size: 500, total_number: 1500, total_page: 2}),
    {page: 2, size: 1000},
    seen,
  );
  // Satisfies every fact of a one-page report except that it is the first page asked for.
  refusedAs(
    'page_not_echoed',
    page(7, {page: 2, page_size: 7, total_number: 7, total_page: 1}),
    {page: 2, size: 1000},
    fresh,
  );
  // Page 1 of a multi-page report that reports its own length instead of the request.
  refusedAs('page_not_echoed', page(600, {page: 1, page_size: 600, total_number: 1500, total_page: 2}));
});

test('the checks after the page echo still apply to an accepted page', () => {
  const whole = page(7, {page: 1, page_size: 7, total_number: 7, total_page: 1});
  refusedAs('total_changed', whole, {page: 1, size: 1000}, {total: 9, returned: 0});
  refusedAs('more_rows_than_declared', whole, {page: 1, size: 1000}, {total: 7, returned: 1});
  // Echoing the request: a total that changed between pages, and more rows than the total declares.
  refusedAs(
    'total_changed',
    page(500, {page: 2, page_size: 1000, total_number: 1600, total_page: 2}),
    {page: 2, size: 1000},
    {total: 1500, returned: 1000},
  );
  refusedAs('more_rows_than_declared', page(1000, {page: 1, page_size: 1000, total_number: 900, total_page: 1}));
});
