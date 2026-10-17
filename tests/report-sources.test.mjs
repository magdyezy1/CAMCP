import test from 'node:test';
import assert from 'node:assert/strict';
import {reportSource, reportSourceList} from '../dist/src/report-sources.js';
import {reportPlatforms} from '../dist/src/report-metrics.js';
import {nativeMetricExamples, normalizeNativeRow, reportRange} from '../dist/src/report-native.js';
import {reportRange as periodRange} from '../dist/src/report-periods.js';

// ARC-04 stage F: one report source per reporting platform; src/report-native.ts normalizes through them.

test('every reporting platform has exactly one report source, in the platforms order', () => {
  assert.deepEqual(
    reportSourceList.map(s => s.platform),
    Object.keys(reportPlatforms),
  );
  for (const source of reportSourceList) {
    assert.equal(reportSource(source.platform), source);
    assert.equal(typeof source.normalize, 'function', source.platform);
    assert.deepEqual(nativeMetricExamples[source.platform], [...source.nativeMetricExamples], source.platform);
  }
  assert.deepEqual(Object.keys(nativeMetricExamples), Object.keys(reportPlatforms));
  // Only Google Ads and TikTok (metrics) and Snapchat (stats) nest requested native metrics in a container.
  assert.deepEqual(
    reportSourceList.filter(s => s.nativeMetricContainer).map(s => [s.platform, s.nativeMetricContainer]),
    [
      ['google', 'metrics'],
      ['tiktok', 'metrics'],
      ['snapchat', 'stats'],
    ],
  );
});

test('a platform without a report source is refused for its missing identifier, never read from an inherited name', () => {
  for (const platform of ['unknown', 'constructor', 'toString', '__proto__', 'hasOwnProperty'])
    assert.throws(
      () => normalizeNativeRow(platform, {id: '1', campaign_id: '1', campaign: {id: '1'}}),
      e => e.code === 'REPORT_ID_MISSING',
      platform,
    );
  assert.equal(reportSource('constructor'), undefined);
});

test('the report date range moved to report-periods.ts and keeps its rule and refusal', () => {
  assert.equal(reportRange, periodRange, 'one function, two import paths');
  assert.deepEqual(reportRange({since: '2026-01-01', until: '2026-12-31'}), {since: '2026-01-01', until: '2026-12-31'});
  for (const range of [
    {since: '2026-01-02', until: '2026-01-01'},
    {since: '2025-01-01', until: '2026-01-02'},
    {since: '2026-02-30', until: '2026-03-01'},
    {since: '2026-1-01', until: '2026-01-02'},
    undefined,
  ])
    assert.throws(
      () => reportRange(range),
      e =>
        e.code === 'INVALID_REPORT_SOURCE' && e.message === 'Choose a valid inclusive date range of at most 366 days.',
      JSON.stringify(range),
    );
});
