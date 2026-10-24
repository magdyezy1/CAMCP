import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {isProviderModule, providerRegistries, runtimeGraph} from '../tools/architecture-map.mjs';
import {providerById} from '../dist/src/provider-adapters.js';
import * as sheets from '../dist/src/google-sheets.js';
import * as table from '../dist/src/report-table.js';

/**
 * ARC-01 (reporting): the shared reporting modules name no provider gateway and import no provider module except
 * through a provider registry. Each entry is what the module still holds; a concern that moves provider facts into the
 * providers' modules lowers it here, and nothing may raise it (tools/architecture-map.mjs ratchets the totals).
 */
const remaining = {
  'src/report-presets.ts': {literals: 14, imports: 6},
  'src/decision-reporting.ts': {literals: 7, imports: 10},
  'src/report-metrics.ts': {literals: 11, imports: 0},
  'src/report-resource-scope.ts': {literals: 9, imports: 0},
  'src/report-breakdowns.ts': {literals: 7, imports: 0},
  'src/report-allocation.ts': {literals: 4, imports: 1},
  'src/report-runs.ts': {literals: 3, imports: 0},
  'src/overview-parents.ts': {literals: 0, imports: 2},
  'src/overview-granularity.ts': {literals: 0, imports: 1},
  'src/report-query-access.ts': {literals: 0, imports: 1},
  'src/report-windows.ts': {literals: 0, imports: 1},
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

test('the report table is shared: the Sheets client re-exports it, and its exporters import no Sheets module', () => {
  for (const name of ['assertReportExportable', 'exportCsv', 'recommendationBasis', 'reportTable'])
    assert.equal(sheets[name], table[name], name + ': one function, two import paths');
  const graph = runtimeGraph(process.cwd());
  for (const id of ['src/report-artifacts.ts', 'src/report-file-delivery.ts', 'server/report-download-routes.ts'])
    assert.equal(graph.get(id).has('src/google-sheets.ts'), false, id);
  // A Sheets destination's connection is resolved under the Sheets provider adapter's gateway.
  assert.equal(providerById('sheets').gateway, sheets.sheetsGateway);
});
