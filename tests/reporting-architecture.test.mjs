import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {isProviderModule, providerRegistries, runtimeGraph} from '../tools/architecture-map.mjs';
import {providerById} from '../dist/src/provider-adapters.js';
import * as sheets from '../dist/src/google-sheets.js';
import * as table from '../dist/src/report-table.js';
import {reportPlatforms} from '../dist/src/report-metrics.js';

/**
 * ARC-01 (reporting): the shared reporting modules name no provider gateway and import no provider module except
 * through a provider registry. Each entry is what the module still holds; a concern that moves provider facts into the
 * providers' modules lowers it here, and nothing may raise it (tools/architecture-map.mjs ratchets the totals).
 */
const remaining = {
  'src/report-presets.ts': {literals: 14, imports: 6},
  'src/decision-reporting.ts': {literals: 7, imports: 10},
  'src/report-resource-scope.ts': {literals: 9, imports: 0},
  'src/report-breakdowns.ts': {literals: 7, imports: 0},
  'src/report-allocation.ts': {literals: 4, imports: 1},
  'src/report-runs.ts': {literals: 3, imports: 0},
  'src/overview-parents.ts': {literals: 0, imports: 2},
  'src/overview-levels.ts': {literals: 0, imports: 1},
  'src/report-query-access.ts': {literals: 0, imports: 1},
  'src/reporting-overview.ts': {literals: 0, imports: 1},
};
const gatewayLiteral = /['"]([a-z0-9]+(?:_[a-z0-9]+)*)_native_action['"]/g;
const reportingModule = id =>
  /^src\/(?:report-[\w-]+|[\w-]*reporting(?:-[\w-]+)?|overview-[\w-]+|decision-[\w-]+)\.ts$/.test(id) ||
  id === 'server/report-download-routes.ts';

test('the shared reporting modules hold no more provider gateways or provider imports than recorded', () => {
  const graph = runtimeGraph(process.cwd()),
    measured = {};
  for (const id of [...graph.keys()].filter(id => reportingModule(id) && !isProviderModule(id)).sort()) {
    const literals = [...fs.readFileSync(id, 'utf8').matchAll(gatewayLiteral)].filter(m => m[1] !== 'amcp').length,
      imports = [...graph.get(id)].filter(to => isProviderModule(to) && !providerRegistries.includes(to)).length;
    if (literals || imports) measured[id] = {literals, imports};
  }
  assert.deepEqual(measured, remaining);
});

test('each reporting platform reports through its provider adapter gateway, as the platform table named it', () => {
  assert.deepEqual(Object.keys(reportPlatforms), [
    'google',
    'meta',
    'tiktok',
    'snapchat',
    'linkedin',
    'x',
    'microsoft',
    'apple',
    'reddit',
    'ga4',
    'gsc',
  ]);
  assert.deepEqual(
    {...reportPlatforms},
    {
      google: {name: 'Google Ads', gateway: 'google_ads_native_action', kind: 'paid'},
      meta: {name: 'Meta', gateway: 'meta_native_action', kind: 'paid'},
      tiktok: {name: 'TikTok', gateway: 'tiktok_native_action', kind: 'paid'},
      snapchat: {name: 'Snapchat', gateway: 'snapchat_native_action', kind: 'paid'},
      linkedin: {name: 'LinkedIn', gateway: 'linkedin_native_action', kind: 'paid'},
      x: {name: 'X Ads', gateway: 'x_ads_native_action', kind: 'paid'},
      microsoft: {name: 'Microsoft Ads', gateway: 'microsoft_ads_native_action', kind: 'paid'},
      apple: {name: 'Apple Ads', gateway: 'apple_ads_native_action', kind: 'paid'},
      reddit: {name: 'Reddit Ads', gateway: 'reddit_native_action', kind: 'paid'},
      ga4: {name: 'Google Analytics 4', gateway: 'ga4_native_action', kind: 'measurement'},
      gsc: {name: 'Search Console', gateway: 'google_search_console_native_action', kind: 'organic'},
    },
  );
  for (const [id, platform] of Object.entries(reportPlatforms))
    assert.equal(platform.gateway, providerById(id).gateway);
});

test('the report sources reach no guided collector, so the guided reporting modules may consult their registry', () => {
  // ARC-04 stage F: the native detail collectors build on the leaf src/overview-levels.ts, not on the guided
  // collector (src/overview-granularity.ts imports DecisionReporting), so no report source reaches decision reporting.
  const graph = runtimeGraph(process.cwd()),
    reached = new Set(),
    queue = ['src/report-sources.ts'];
  while (queue.length)
    for (const next of graph.get(queue.shift()) ?? []) if (!reached.has(next)) reached.add(next) && queue.push(next);
  for (const id of [
    'src/overview-granularity.ts',
    'src/decision-reporting.ts',
    'src/report-presets.ts',
    'src/report-allocation.ts',
    'src/report-breakdowns.ts',
    'src/reporting-overview.ts',
  ])
    assert.equal(reached.has(id), false, id);
  assert.equal(graph.get('src/overview-native-detail.ts').has('src/overview-granularity.ts'), false);
});

test('the levels and detailed rows moved to a leaf keep their overview-granularity import path', async () => {
  const granularity = await import('../dist/src/overview-granularity.js'),
    levels = await import('../dist/src/overview-levels.js');
  for (const name of [
    'campaignAttributionProfile',
    'detailContractVersion',
    'detailedOverviewRows',
    'overviewEntityLevels',
    'overviewSourceLevel',
  ])
    assert.equal(granularity[name], levels[name], name);
});

test('the report table is shared: the Sheets client re-exports it, and its exporters import no Sheets module', () => {
  for (const name of ['assertReportExportable', 'exportCsv', 'recommendationBasis', 'reportTable'])
    assert.equal(sheets[name], table[name], name + ': one function, two import paths');
  const graph = runtimeGraph(process.cwd());
  for (const id of ['src/report-artifacts.ts', 'src/report-file-delivery.ts', 'server/report-download-routes.ts'])
    assert.equal(graph.get(id).has('src/google-sheets.ts'), false, id);
  // A Sheets destination's connection is resolved under the Sheets provider adapter's gateway.
  assert.equal(providerById('sheets').gateway, sheets.sheetsGateway);
});
