import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceTool} from '../dist/src/workspace.js';
import {workspaceAction, workspaceWebsitePath, workspaceWorkflows} from '../dist/src/provider-workflows.js';
import {workflowOutcome} from '../dist/src/workflow-outcomes.js';
import {gtmMeasurementAudit} from '../dist/src/gtm-measurement-audit.js';
import {wooCommerceSourcePath} from '../dist/src/woocommerce-workspace.js';
import {providerOf} from '../dist/src/provider-adapters.js';
import {wooSourceFixture} from './fixtures/woocommerce-source-data.mjs';
import {offerParkedProviders, withoutParkedProviders} from './helpers/parked-providers.mjs';
import {assertNamesNoProvider} from './helpers/shared-module-seams.mjs';

// ARC-01 phase B, wave 4c round 6: the workspace tool (src/workspace.ts) answered Tag Manager's, GA4's, Google Ads',
// LinkedIn's, WooCommerce's and X's actions and the measurement ledger in branches of its own, importing eleven
// provider modules, and its outcome links (src/workflow-outcomes.ts) named WooCommerce's gateway. They are the
// providers' workspace entries of the provider workflows registry (src/provider-workflows.ts) now; the tool keeps its
// checks and their order. The first test fails on the build before the move; the others pin the table and the
// providers' answers, and pass on both builds where the old build had the same functions.

test('the workspace tool and its outcome links name no provider and import no provider module', () => {
  assertNamesNoProvider('src/workspace.ts');
  assertNamesNoProvider('src/workflow-outcomes.ts');
});

test('each provider action of the workspace tool is one provider’s listed action; another name is none', () => {
  assert.deepEqual(
    workspaceWorkflows.map(w => [w.provider, Object.keys(w.actions)]),
    [
      ['ga4_native_action', ['measurement_events', 'measurement_event_identity', 'measurement_ga4_config']],
      ['gtm_native_action', ['preview_consent_plan', 'create_consent_plan', 'measurement_audit']],
      ['linkedin_native_action', ['measurement_conversions']],
      ['google_ads_native_action', ['measurement_google_goals', 'change_history']],
      ['measurement', ['measurement_ledger']],
      ['commerce_native_action', ['catalog_source', 'catalog_sources']],
      ['x_ads_native_action', ['preview_catalog_removal', 'create_catalog_removal']],
    ],
  );
  const listed = workspaceTool.inputSchema.properties.action.enum;
  for (const {provider, actions} of workspaceWorkflows) {
    assert.ok(provider === 'measurement' || providerOf(provider), provider + ' is a provider gateway');
    assert.ok(Object.isFrozen(actions), provider);
    for (const [action, run] of Object.entries(actions)) {
      assert.ok(listed.includes(action), action + ' is an action of the workspace tool');
      assert.equal(workspaceAction(action), run, action);
    }
  }
  // The tool's own actions, inherited names and other values are no provider's.
  for (const name of ['portfolio', 'search_overlap', 'catalog_compare', 'constructor', 'toString', '__proto__', 7])
    assert.equal(workspaceAction(name), undefined, String(name));
  assert.equal(workspaceAction(undefined), undefined);
});

test('the workspace tool answers a provider’s action with that provider’s refusal of the tool’s input', async t => {
  withoutParkedProviders(t);
  const f = wooSourceFixture();
  try {
    const refused = async (args, code, message) => {
      const out = await f.service.call('amcp_workspace', args, f.actor);
      assert.equal(out.success, false, JSON.stringify(out));
      assert.equal(out.error.code, code, JSON.stringify(out.error));
      if (message) assert.match(out.error.message, message);
    };
    const meta = {gateway: 'meta_native_action', account_id: '123', connection_id: 'meta-login'};
    await refused({action: 'measurement_events', ...meta}, 'MEASUREMENT_EVENTS_UNQUALIFIED', /GA4 property/);
    await refused({action: 'measurement_ga4_config', ...meta}, 'MEASUREMENT_CONFIG_UNQUALIFIED', /ga4_native_action/);
    await refused({action: 'measurement_conversions', ...meta}, 'MEASUREMENT_CONVERSIONS_UNQUALIFIED', /LinkedIn/);
    await refused({action: 'measurement_google_goals', ...meta}, 'MEASUREMENT_GOALS_UNQUALIFIED', /google_ads_native/);
    await refused({action: 'change_history', ...meta}, 'INVALID_ARGUMENT', /Google Ads customer/);
    // WooCommerce is parked: its store sources are refused after the tool's argument check, as before.
    await refused({action: 'catalog_sources', account_id: 'store-1'}, 'INVALID_ARGUMENT');
    await refused({action: 'catalog_sources'}, 'GATEWAY_NOT_OFFERED');
  } finally {
    f.close();
  }
});

test('an offered WooCommerce lists its configured store sources through its workspace entry', async t => {
  withoutParkedProviders(t);
  offerParkedProviders('woocommerce');
  const f = wooSourceFixture();
  try {
    const out = await f.service.call('amcp_workspace', {action: 'catalog_sources'}, f.actor);
    assert.equal(out.success, true, JSON.stringify(out));
    assert.deepEqual(
      out.data.items.map(s => [s.connection_id, s.account_id]),
      [['woo-login', 'store-1']],
    );
    assert.equal(f.calls.length, 0, 'no store request');
  } finally {
    f.close();
  }
});

test('Tag Manager’s measurement audit reads one workspace through gtm_audit_ops and keeps a refusal’s facts', async () => {
  const actor = {tenantId: 'gtm-audit', userId: 'operator', role: 'operator'},
    resolved = [],
    store = {
      resolveConnection(who, gateway, account, connection) {
        resolved.push([who, gateway, account, connection]);
        return {id: 'gtm-login'};
      },
    },
    input = {
      action: 'measurement_audit',
      account_id: '44',
      connection_id: 'gtm-login',
      requirements: {container_id: '9', workspace_id: '3'},
    },
    calls = [];
  const out = await gtmMeasurementAudit(
    store,
    async (tool, args, who) => {
      calls.push([tool, args, who]);
      return {success: true, data: {containers: [], network_requests: 2}};
    },
    actor,
    input,
  );
  assert.deepEqual(calls, [
    [
      'gtm_native_action',
      {
        operation: 'gtm_audit_ops',
        arguments: {
          connection_id: 'gtm-login',
          account_id: '44',
          container_id: '9',
          workspace_id: '3',
          include_versions: true,
          include_resources: false,
        },
      },
      actor,
    ],
  ]);
  // The connection is resolved before the read and again after it.
  assert.deepEqual(resolved, [
    [actor, 'gtm_native_action', '44', 'gtm-login'],
    [actor, 'gtm_native_action', '44', 'gtm-login'],
  ]);
  assert.deepEqual(out, {
    record_kind: 'measurement_audit',
    scope: {connection_id: 'gtm-login', account_id: '44', container_id: '9', workspace_id: '3'},
    configuration: {containers: [], network_requests: 2},
    event_delivery: 'not_measured',
    meaning:
      'Configuration evidence only. This audit does not establish that real events fire, deduplicate, satisfy consent or attribute correctly.',
    advertising_writes: 0,
  });
  // A provider refusal keeps its code and allow-listed facts, never its body.
  await assert.rejects(
    gtmMeasurementAudit(
      store,
      async () => ({
        success: false,
        error: {code: 'ACCESS_DENIED', message: 'Denied.', details: {http_status: 403, request_id: 'r-1', body: 'x'}},
      }),
      actor,
      input,
    ),
    error => {
      assert.equal(error.code, 'ACCESS_DENIED');
      assert.equal(error.message, 'Denied.');
      assert.deepEqual(error.details, {http_status: 403, request_id: 'r-1'});
      return true;
    },
  );
  await assert.rejects(
    gtmMeasurementAudit(store, async () => ({success: false}), actor, input),
    error => error.code === 'MEASUREMENT_AUDIT_FAILED' && error.message === 'Measurement audit failed.',
  );
  // An unknown requirement is refused before any connection or read.
  const before = resolved.length;
  await assert.rejects(
    gtmMeasurementAudit(store, async () => assert.fail('no read'), actor, {
      ...input,
      requirements: {container_id: '9', tag_ids: []},
    }),
    error => error.code === 'INVALID_ARGUMENT',
  );
  assert.equal(resolved.length, before);
});

test('WooCommerce’s store reads link their Commerce page; its record without a linkable scope gets none', () => {
  const scope = {
    gateway: 'commerce_native_action',
    connection_id: 'woo-login',
    account_id: 'store-1',
    price_field: 'sale_price',
  };
  const inventory = {
    record_kind: 'catalog_source_inventory',
    state: 'complete',
    complete_collected_inventory: true,
    scope: {
      ...scope,
      source_kind: 'inventory',
      absent_source_policy: 'retain',
      api_version: 'wc/v3',
      product_status: 'publish',
      variation_status: 'any',
    },
  };
  assert.equal(
    workflowOutcome('amcp_workspace', inventory, 'catalog_source').website_path,
    '/commerce?woo_inventory=1&connection_id=woo-login&account_id=store-1&price_field=sale_price',
  );
  const selected = {
    record_kind: 'catalog_source',
    complete_selected_evidence: true,
    product_ids: ['101', '102'],
    scope: {...scope, source_kind: 'variations', parent_product_id: '100'},
  };
  assert.equal(
    workflowOutcome('amcp_workspace', selected, 'catalog_source').website_path,
    '/commerce?woo_source=1&connection_id=woo-login&account_id=store-1&product_ids=101%2C102&price_field=sale_price' +
      '&source_kind=variations&parent_product_id=100',
  );
  assert.deepEqual(workspaceWebsitePath(selected), wooCommerceSourcePath(selected));
  // A selected read whose connection cannot be linked is still WooCommerce's record: no later rule links it (an
  // incident list on it named /monitors only after the chain passed it by).
  const unlinked = {...selected, incidents: [], scope: {...selected.scope, connection_id: 'not a connection'}};
  assert.deepEqual(wooCommerceSourcePath(unlinked), {});
  assert.equal(workflowOutcome('amcp_workspace', unlinked, 'catalog_source').website_path, undefined);
  // Another gateway's record, or an incomplete inventory, is not WooCommerce's: the chain goes on.
  const other = {...inventory, scope: {...inventory.scope, gateway: 'meta_native_action'}, incidents: []};
  assert.equal(wooCommerceSourcePath(other), undefined);
  assert.equal(workflowOutcome('amcp_workspace', other, 'catalog_source').website_path, '/monitors');
  assert.equal(wooCommerceSourcePath({...inventory, state: 'incomplete'}), undefined);
});
