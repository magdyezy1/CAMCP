import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Introspection} from '../dist/src/introspection.js';
import {currentCapture} from '../dist/src/catalog-versions.js';
const options = {mode: 'strict', flags: {}},
  registry = new Registry(),
  introspection = new Introspection(registry),
  gateways = ['google_ads_native_action', 'meta_native_action'];
test('operation help uses the effective version of every captured Google and Meta descriptor without changing recorded evidence', () => {
  const original = JSON.stringify(registry.data);
  const descriptors = Object.entries(registry.data.descriptions).filter(([key]) =>
    gateways.some(g => key.startsWith(g + '/')),
  );
  assert.equal(descriptors.length, 8);
  for (const [key, captured] of descriptors) {
    const slash = key.indexOf('/'),
      gateway = key.slice(0, slash),
      operation = key.slice(slash + 1);
    for (const mode of ['strict', 'enhanced']) {
      const result = registry.help({gateway, operation}, {mode, flags: {}});
      assert.deepEqual(result, currentCapture(gateway, captured));
      const described = introspection.describe(gateway, {target_action: operation});
      assert.equal(result.api_version, described.api_version);
      assert.equal(result.path, described.path);
      assert.deepEqual(result.required_fields, described.required_fields);
      result.api_version = 'MUTATED-RETURNED-METADATA';
    }
  }
  assert.equal(JSON.stringify(registry.data), original, 'Help cannot rewrite recorded evidence');
});
test('known uncaptured versioned catalog operations expose only qualified metadata and preserve original names, routes and risk flags', () => {
  const original = JSON.stringify([...registry.catalogs]);
  let total = 0;
  for (const gateway of gateways) {
    const catalog = registry.catalogs.get(gateway);
    for (const action of catalog.actions) {
      if (registry.data.descriptions[gateway + '/' + action.name]) continue;
      total++;
      const result = registry.help({gateway, operation: action.name}, options);
      assert.deepEqual(result, {
        success: true,
        api_version: catalog.api_version,
        ...structuredClone(action.raw),
        mirror_evidence: 'Catalog metadata only; extended DESCRIBE_ACTION response is unverified.',
      });
      assert.equal(result.path, action.raw.path);
      assert.equal(result.method, action.raw.method);
      assert.equal(result.read_only, action.raw.read_only);
      assert.equal(result.destructive, action.raw.destructive);
      assert.deepEqual(result.required_fields, action.raw.required_fields);
      assert.equal(result.mirror_evidence.includes('unverified'), true);
    }
  }
  assert.equal(total, 1039);
  assert.equal(JSON.stringify([...registry.catalogs]), original);
});
test('uncaptured renamed Google shareable-preview requirements match current description and retained canonical action identity', () => {
  const action = 'google_ads_v23_shareable_preview_generate_shareable_previews',
    help = registry.help({gateway: gateways[0], operation: action}, options),
    described = introspection.describe(gateways[0], {target_action: action});
  assert.equal(help.api_version, 'v25');
  assert.equal(help.path, '/v25/customers/{customer_id=*}:generateShareablePreviews');
  assert.deepEqual(help.required_fields, ['customer_id', 'operation']);
  assert.deepEqual(help.required_fields, described.required_fields);
  assert.equal(help.action, action);
  assert.match(help.mirror_evidence, /unverified/);
});
test('unknown operation, nonversioned help, independent extensions and advertised input schemas retain their original boundaries', () => {
  for (const gateway of gateways) {
    const unknown = registry.help({gateway, operation: 'UNKNOWN-PUBLIC-HELP-PROBE'}, options),
      general = registry.help({gateway}, options);
    assert.deepEqual(unknown, general);
  }
  const gateway = 'amcp_native_action',
    operation = 'get_workspace_context',
    definition = registry.tools.get(gateway);
  assert.deepEqual(
    registry.help({gateway, operation}, options),
    definition.operations.find(x => x.operation === operation),
  );
  assert.throws(() => registry.help({gateway, operation: 'UNKNOWN-PUBLIC-HELP-PROBE'}, options), {
    code: 'UNKNOWN_OPERATION',
  });
  for (const g of ['google_ads_native_action', 'meta_native_action', 'amcp_native_action']) {
    const schema = JSON.stringify(registry.schema(registry.tools.get(g), options));
    registry.help({gateway: g}, options);
    assert.equal(JSON.stringify(registry.schema(registry.tools.get(g), options)), schema);
  }
  const microsoft = registry.help({gateway: 'microsoft_ads_native_action'}, options),
    apple = registry.help({gateway: 'apple_ads_native_action'}, options);
  assert.ok(microsoft.amcp_actions.length > 0);
  assert.match(apple.qualification, /no live|Independent/);
});
