import test from 'node:test';
import assert from 'node:assert/strict';
import {xCampaignReport} from '../dist/src/x-campaign-report.js';
import {xAnalyticsTime} from '../dist/src/x-report-jobs.js';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';

/**
 * X's analytics reference (docs.x.com, read 2026-09-29): start_time and end_time are ISO 8601 "expressed in whole hours
 * (0 minutes and 0 seconds)", e.g. 2026-05-19T07:00:00Z. X refused AMCP's "2026-09-21T21:00:00.000Z" with
 * INVALID_PARAMETER "Expected Time", so every report placement failed.
 */
const utc3Midnight = Date.parse('2026-09-21T21:00:00Z');
const metrics = hours => ({impressions: Array(hours).fill(1), billed_charge_local_micro: Array(hours).fill(0)});

test('the website X report sends whole-hour times without fractional seconds', async () => {
  const seen = [];
  const report = await xCampaignReport(
    [{id: 'c1', name: 'One'}],
    utc3Midnight,
    utc3Midnight + 86400000,
    [],
    async q => {
      seen.push(q);
      return {data: [{id: 'c1', id_data: [{segment: null, metrics: metrics(24)}]}]};
    },
  );
  assert.equal(report.complete, true);
  assert.equal(seen.length, 3);
  for (const q of seen) {
    assert.equal(q.start_time, '2026-09-21T21:00:00Z');
    assert.equal(q.end_time, '2026-09-22T21:00:00Z');
  }
});

test('a half-hour account time zone widens the range to whole UTC hours and says so', async () => {
  const istMidnight = Date.parse('2026-09-21T18:30:00Z'),
    seen = [];
  const report = await xCampaignReport([{id: 'c1'}], istMidnight, istMidnight + 86400000, [], async q => {
    seen.push(q);
    return {data: [{id: 'c1', id_data: [{segment: null, metrics: metrics(25)}]}]};
  });
  assert.equal(seen[0].start_time, '2026-09-21T18:00:00Z');
  assert.equal(seen[0].end_time, '2026-09-22T19:00:00Z');
  assert.match(report.warnings.join(' '), /whole UTC hours/);
});

test('xAnalyticsTime formats whole hours and refuses anything else', () => {
  assert.equal(xAnalyticsTime(utc3Midnight), '2026-09-21T21:00:00Z');
  assert.throws(() => xAnalyticsTime(utc3Midnight + 1000), /whole hours/);
});

test('an X analytics job written with .000Z is sent in the documented form', () => {
  const compiler = new Compiler(new Registry());
  const p = compiler.compile(
    'x_ads_native_action',
    {
      action: 'x_stats_jobs_accounts_account_id_post',
      account_id: '18ce54d4x5t',
      params: {
        entity: 'CAMPAIGN',
        entity_ids: 'c1',
        start_time: '2026-09-21T21:00:00.000Z',
        end_time: '2026-09-22T21:00:00.000Z',
        granularity: 'DAY',
        metric_groups: 'ENGAGEMENT',
        placement: 'ALL_ON_TWITTER',
      },
    },
    {mode: 'enhanced', flags: {}},
  );
  assert.equal(p.query.start_time, '2026-09-21T21:00:00Z');
  assert.equal(p.query.end_time, '2026-09-22T21:00:00Z');
});
