import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../dist/src/catalog.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {registeredProviderHooks} from '../dist/src/provider-hooks.js';
import {providerOf} from '../dist/src/provider-adapters.js';
import {providerWorkflows} from '../dist/src/provider-workflows.js';
import {isProviderModule, providerRegistries} from '../tools/architecture-map.mjs';
import {contractExplanationSources, inspectContractExplanations} from '../tools/check-locales.mjs';

// ARC-01 phase B, the action contract ledger (wave 4c): src/action-contracts.ts keeps how every captured, supplemental
// and delegated action is classified, in what order, and every shared row; what only a provider says about its rows
// is its adapter's contract hooks (src/<provider>-adapter.ts) or its workflow in the provider workflows registry
// (src/provider-workflows.ts). The first three tests fail on the build before the move (the ledger named Snapchat,
// Google Ads, Apple, Meta, WooCommerce, Tag Manager and Adjust and imported seventeen provider modules); the others pin
// each provider's rule to its own rows and pass on both builds.
const registry = new Registry(),
  rows = actionContracts(registry);
const of = gateway => rows.filter(r => r.gateway === gateway);

test('the action contract ledger names no provider: it consults the contract hooks and the workflows registry', () => {
  const source = fs.readFileSync(new URL('../src/action-contracts.ts', import.meta.url), 'utf8');
  const named = [...source.matchAll(/['"]([a-z0-9_]+)_native_action['"]/g)].map(m => m[1]);
  assert.deepEqual([...new Set(named)], ['amcp'], 'only AMCP’s own native workflow tool is named');
  for (const [, module] of source.matchAll(/from '\.\/([^']+)\.js'/g))
    assert.ok(
      !isProviderModule('src/' + module + '.ts') || providerRegistries.includes('src/' + module + '.ts'),
      'src/action-contracts.ts imports no provider module (' + module + ')',
    );
  assert.ok(providerRegistries.includes('src/provider-workflows.ts'), 'the workflows registry counts as a registry');
});

test('the providers’ contract hooks and workflows: frozen, of the contract, one workflow per tool operation', () => {
  const known = new Set(['readNotes', 'mediaStep', 'legacy']);
  const declared = registeredProviderHooks.filter(h => h.contracts).map(h => h.gateway);
  assert.deepEqual(declared.sort(), [
    'dv360_native_action',
    'google_ads_native_action',
    'snapchat_native_action',
    'tiktok_native_action',
    'x_ads_native_action',
  ]);
  for (const hooks of registeredProviderHooks.filter(h => h.contracts)) {
    assert.ok(Object.isFrozen(hooks.contracts), hooks.gateway + ' contract hooks are frozen');
    for (const key of Object.keys(hooks.contracts)) assert.ok(known.has(key), hooks.gateway + ' declares ' + key);
  }
  assert.ok(Object.isFrozen(providerWorkflows));
  const stages = new Set(['before_diagnostics', 'before_disconnect', 'after_disconnect']);
  for (const workflow of providerWorkflows) {
    assert.ok(Object.isFrozen(workflow) && Object.isFrozen(workflow.contract), workflow.provider);
    assert.ok(providerOf(workflow.provider), workflow.provider + ' is a provider adapter’s gateway');
    assert.ok(stages.has(workflow.contract.stage), workflow.provider);
    assert.ok(
      Object.isFrozen(workflow.contract.row) && Object.isFrozen(workflow.contract.row.tests),
      workflow.provider,
    );
  }
  // Over every delegated tool's operations and actions, at most one workflow lists a row at each stage, so the
  // registry's order between workflows of different tools or operations decides nothing.
  for (const tool of [...registry.tools.values()].filter(t => t.mode === 'delegated'))
    for (const op of tool.operations ?? [])
      for (const action of op.argumentsSchema.properties?.action?.enum ?? [op.operation])
        for (const stage of stages)
          assert.ok(
            providerWorkflows.filter(
              w =>
                w.tool === tool.name &&
                w.contract.stage === stage &&
                w.contract.listed(op.operation, action, {status: 'native_read'}),
            ).length <= 1,
            tool.name + ' ' + op.operation + ' ' + action + ' at ' + stage,
          );
});

test('the localization inventory reads the reasons that moved with the providers’ rules', () => {
  const sources = contractExplanationSources('.');
  for (const file of [
    'src/dv360-adapter.ts',
    'src/google-ads-adapter.ts',
    'src/tiktok-adapter.ts',
    'src/x-adapter.ts',
    'src/provider-workflows.ts',
  ])
    assert.ok(sources.includes(file), file);
  const read = file => inspectContractExplanations(fs.readFileSync(file, 'utf8'), {declarations: true});
  assert.ok(
    read('src/dv360-adapter.ts').has(
      'Native advertiser-scoped POST search for geo regions, POIs and business chains; exact body variants, current scopes, bounded pagination and explicit completeness. It creates no targeting assignments.',
    ),
  );
  const workflows = read('src/provider-workflows.ts'),
    google = read('src/google-ads-adapter.ts');
  assert.ok(
    workflows.has(
      'AMCP scoped read-only configuration audit or local reviewed-write verification job status. This workflow never publishes or resubmits a mutation.',
    ),
  );
  assert.ok(
    google.has(
      'An explicit legacy adapter exists, but its route depends on the requested scope/type. Inspect the exact payload; each selected destination retains its own reviewed contract.',
    ),
  );
  // Only the contract declarations count: TikTok's paging meaning is no contract explanation.
  assert.equal(
    [...read('src/tiktok-adapter.ts')].every(message => !/integrated report/i.test(message)),
    true,
  );
});

test('a provider’s read notes reach its own native reads only, in the ledger’s order', () => {
  const notes = [
    ['dv360_native_action', 'src/dv360-targeting-search.ts', 'tests/dv360-targeting-search.test.ts'],
    ['x_ads_native_action', 'src/x-audience-estimate.ts', 'tests/x-audience-estimate.test.mjs'],
    ['x_ads_native_action', 'src/x-report-jobs.ts / src/x-report-download.ts', 'tests/x-report-jobs.test.ts'],
    ['tiktok_native_action', 'src/tiktok-report-jobs.ts', 'tests/tiktok-report-jobs.test.ts'],
    ['google_ads_native_action', 'src/google-generation.ts', 'tests/google-generation.test.ts'],
  ];
  for (const [gateway, module, testFile] of notes) {
    // A note follows the native read's implementation (a reviewed family's row names only its family's module).
    const noted = rows.filter(r => r.implementation.includes(' / ' + module));
    assert.ok(noted.length, module);
    for (const row of noted) {
      assert.equal(row.gateway, gateway, module + ' is ' + gateway + '’s');
      assert.equal(row.status, 'native_read');
      assert.ok(row.implementation.startsWith('src/compiler.ts / src/delegated-native.ts / src/transport.ts'));
      assert.ok(row.tests.includes(testFile), row.action);
    }
  }
  // X's notes join their tests once.
  for (const row of of('x_ads_native_action').filter(r => r.implementation.includes('src/x-audience-estimate.ts')))
    assert.equal(row.tests.length, new Set(row.tests).size, row.action);
});

test('Google Ads’ legacy actions, Snapchat’s chunked upload steps and the providers’ workflows keep their rows', () => {
  const adapted = of('google_ads_native_action').filter(r => r.status === 'adapter_requires_input');
  assert.equal(adapted.length, 8);
  for (const row of adapted) {
    assert.equal(row.implementation, 'src/google-legacy.ts');
    assert.deepEqual(row.tests, ['tests/google-legacy.test.ts']);
  }
  assert.ok(of('google_ads_native_action').some(r => r.source === 'src/google-legacy-mapping.json'));
  const steps = of('snapchat_native_action').filter(r => /a raw (ADD|FINALIZE) is not accepted/.test(r.reason));
  assert.ok(steps.length >= 2);
  for (const row of steps) assert.equal(row.status, 'media_workflow');
  assert.equal(
    rows.filter(r => /a raw (ADD|FINALIZE) is not accepted/.test(r.reason) && r.gateway !== 'snapchat_native_action')
      .length,
    0,
  );
  const workflow = (gateway, operation) => rows.filter(r => r.gateway === gateway && r.operation === operation);
  assert.equal(
    workflow('commerce_native_action', 'woocommerce_list_stores')[0].implementation,
    'src/woocommerce-source.ts',
  );
  for (const row of workflow('gtm_native_action', 'gtm_audit_ops'))
    assert.equal(row.implementation, 'src/gtm-diagnostics.ts');
  for (const row of workflow('amcp_native_action', 'search_ads_library')) {
    assert.equal(row.implementation, 'src/meta-ad-library.ts');
    assert.equal(row.source, 'https://www.facebook.com/ads/library/api/');
  }
  for (const row of workflow('adjust_native_action', 'adjust_reporting'))
    assert.equal(row.source, 'https://dev.adjust.com/en/api/rs-api/');
  // A workflow's row is its own tool's: no other gateway's row names the workflow modules.
  for (const module of ['src/woocommerce-source.ts', 'src/gtm-diagnostics.ts', 'src/adjust-reporting.ts'])
    assert.equal(new Set(rows.filter(r => r.implementation === module).map(r => r.gateway)).size, 1, module);
});
