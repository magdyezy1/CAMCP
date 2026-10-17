import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {missingNativeMetrics, normalizeNativeRow} from '../dist/src/report-native.js';

/**
 * ARC-04 stage F golden rows: normalizeNativeRow's output for synthetic rows of every reporting platform (full,
 * sparse and refused rows, Meta's omitted-as-zero actions, TikTok result definitions, Snapchat objective conversions,
 * Reddit's upper- and lower-case fields), captured from the platform if-chain before it became one report source per
 * platform. Each row must stay byte-identical, refusals included, and so must the requested native metrics a source
 * reports missing.
 */
const golden = JSON.parse(fs.readFileSync('tests/fixtures/report-source-golden.json', 'utf8'));

test('every platform normalizes its golden rows byte-identically, refusals included', () => {
  assert.equal(golden.schema_version, 1);
  const platforms = new Set(golden.records.map(r => r.platform));
  for (const platform of ['google', 'meta', 'tiktok', 'snapchat', 'linkedin', 'x', 'microsoft', 'apple', 'reddit'])
    assert.ok(platforms.has(platform), platform);
  for (const platform of ['ga4', 'gsc']) assert.ok(platforms.has(platform), platform);
  for (const [i, record] of golden.records.entries()) {
    const raw = structuredClone(record.raw),
      label = i + ' ' + record.platform + ' ' + JSON.stringify(record.raw).slice(0, 80);
    if (record.error) {
      assert.throws(
        () => normalizeNativeRow(record.platform, raw),
        e => e.code === record.error.code && e.message === record.error.message && e.status === record.error.status,
        label,
      );
      continue;
    }
    assert.equal(JSON.stringify(normalizeNativeRow(record.platform, raw)), JSON.stringify(record.output), label);
    assert.deepEqual(raw, record.raw, label + ': the native row is not changed');
  }
});

test('the requested native metrics each platform reports missing are unchanged', () => {
  for (const [platform, missing] of Object.entries(golden.missing)) {
    const rows = golden.records.filter(r => r.platform === platform && r.output).map(r => r.output);
    const requested = {
      google: ['metrics.all_conversions', 'metrics.interactions'],
      meta: ['cost_per_action_type', 'inline_link_clicks'],
      tiktok: ['likes', 'shares'],
      snapchat: ['video_views', 'total_installs', 'swipe_ups'],
      linkedin: ['likes', 'shares'],
      microsoft: ['AllConversions', 'Assists'],
      apple: ['newDownloads'],
      reddit: ['VIDEO_STARTED', 'VIDEO_VIEWABLE_IMPRESSIONS'],
      ga4: ['bounceRate', 'eventCount'],
      gsc: ['ctr'],
      x: ['VIDEO'],
    }[platform];
    assert.deepEqual(missingNativeMetrics(platform, requested, rows), missing, platform);
  }
});
