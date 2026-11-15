import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry, listsActions} from '../dist/src/catalog.js';
import {providerHooks, registeredProviderHooks} from '../dist/src/provider-hooks.js';
import {catalogVersions, currentCapture} from '../dist/src/catalog-versions.js';
import {toolHelp} from '../dist/src/tool-help.js';
import {extendGoogleAdsTool, googleAdsVersion} from '../dist/src/google-version.js';
import {metaApiVersion} from '../dist/src/meta-version.js';
import {extendLinkedInTool, linkedinDescribedVersion} from '../dist/src/linkedin-version.js';
import {microsoftActions, microsoftTool} from '../dist/src/microsoft-native.js';
import {appleActions} from '../dist/src/apple-native.js';
import {metaRuleActions} from '../dist/src/meta-rule-routes.js';
import {dataManagerActions} from '../dist/src/google-data-manager-routes.js';
import {isProviderModule, providerRegistries} from '../tools/architecture-map.mjs';

// ARC-01 phase B, the catalog registry (wave 4c): src/catalog.ts keeps how tools, schemas, catalogs and routes are built
// and in what order, validation, lookups, listings and help; each provider's additions are its adapter's catalog hooks
// (src/<provider>-adapter.ts) and the leaf registry's listing fact. These tests fail if the registry names a provider
// again or a provider's addition reaches another gateway.
const registry = new Registry(),
  strict = {mode: 'strict', flags: {}};
const refusal = (code, message) => error => {
  assert.equal(error.code, code, error.message);
  if (message) assert.match(error.message, message);
  return true;
};
/** A registry built from the pinned data without some tools or catalogs. */
const without = ({tools = [], catalogs = []}) =>
  new Registry({
    ...registry.data,
    tools: registry.data.tools.filter(t => !tools.includes(t.name)),
    catalogs: registry.data.catalogs.filter(c => !catalogs.includes(c.gateway)),
  });

test('the catalog registry names no provider: it consults the providers’ catalog hooks', () => {
  const source = fs.readFileSync(new URL('../src/catalog.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /['"][a-z0-9_]+_native_action['"]/, 'no gateway literal in src/catalog.ts');
  for (const [, module] of source.matchAll(/from '\.\/([^']+)\.js'/g))
    assert.ok(
      !isProviderModule('src/' + module + '.ts') || providerRegistries.includes('src/' + module + '.ts'),
      'src/catalog.ts imports no provider module (' + module + ')',
    );
});

test('the providers’ catalog hooks: frozen, of the contract, and each tool extended by one provider', () => {
  // Package r25-m0-errors (Round 2.5, M0: T7) adds `aliases`: the near-miss spellings a provider contributes for its own
  // action names (Google Ads: the version-neutral ones), which src/action-aliases.ts holds to the same rules as its own.
  const known = new Set(['tools', 'action', 'version', 'supplemental', 'own', 'helpArguments', 'help', 'aliases']),
    extended = new Map();
  for (const hooks of registeredProviderHooks.filter(h => h.catalog)) {
    assert.ok(Object.isFrozen(hooks.catalog), hooks.gateway);
    for (const key of Object.keys(hooks.catalog)) assert.ok(known.has(key), hooks.gateway + ' declares ' + key);
    for (const name of Object.keys(hooks.catalog.tools ?? {})) {
      assert.equal(extended.has(name), false, name + ' is extended once');
      extended.set(name, hooks.gateway);
    }
  }
  // A provider extends its own gateway's tool; Meta's post workflow extends AMCP's native workflow tool.
  assert.deepEqual(Object.fromEntries([...extended].sort()), {
    adjust_native_action: 'adjust_native_action',
    amcp_native_action: 'meta_native_action',
    dv360_native_action: 'dv360_native_action',
    google_business_native_action: 'google_business_native_action',
    reddit_native_action: 'reddit_native_action',
    x_ads_native_action: 'x_ads_native_action',
  });
  // The gateways AMCP lists from its catalog although their captured schema has no LIST_ACTIONS: DV360 only.
  assert.deepEqual([...listsActions], ['dv360_native_action']);
});

test('the catalog version moves are each provider’s: Google Ads’, Meta’s and LinkedIn’s, as their adapters declare', () => {
  // src/catalog-versions.ts imported the three providers' version modules (fails on the build before); it now lists
  // their adapters' catalog hooks, in the order the table had them.
  const source = fs.readFileSync(new URL('../src/catalog-versions.ts', import.meta.url), 'utf8');
  for (const [, module] of source.matchAll(/from '\.\/([^']+)\.js'/g))
    assert.ok(
      !isProviderModule('src/' + module + '.ts') || providerRegistries.includes('src/' + module + '.ts'),
      'src/catalog-versions.ts imports no provider module (' + module + ')',
    );
  assert.deepEqual(Object.keys(catalogVersions), [
    'google_ads_native_action',
    'meta_native_action',
    'linkedin_native_action',
  ]);
  for (const [gateway, moved] of Object.entries(catalogVersions)) {
    assert.equal(moved, providerHooks(gateway).catalog.version, gateway);
    assert.ok(Object.isFrozen(moved), gateway);
  }
  assert.equal(catalogVersions.google_ads_native_action.version, googleAdsVersion);
  assert.equal(catalogVersions.meta_native_action.version, metaApiVersion);
  // LinkedIn's is the reviewed version when it is read (PRV-02), not one fixed at load.
  assert.equal(catalogVersions.linkedin_native_action.version, linkedinDescribedVersion());
  assert.equal(catalogVersions.google_ads_native_action.tool, extendGoogleAdsTool);
  assert.equal(catalogVersions.linkedin_native_action.tool, extendLinkedInTool);
  assert.equal(catalogVersions.meta_native_action.tool, undefined);
  // A gateway without a version move answers its captured data as captured.
  const captured = {success: true};
  assert.equal(currentCapture('tiktok_native_action', captured), captured);
});

test('the providers’ documented actions are registered only with the catalog or tool they extend', () => {
  const rule = metaRuleActions[0],
    manager = dataManagerActions[0],
    apple = appleActions[0];
  assert.ok(registry.action('meta_native_action', rule.name), 'Meta rule actions with the Meta catalog');
  assert.ok(registry.action('google_ads_native_action', manager.name), 'Data Manager actions with the Google catalog');
  assert.ok(registry.action('apple_ads_native_action', apple.name), 'Apple v1 actions with the Apple tool');
  const bare = without({
    tools: ['apple_ads_native_action'],
    catalogs: ['meta_native_action', 'google_ads_native_action'],
  });
  assert.equal(bare.action('meta_native_action', rule.name), undefined);
  assert.equal(bare.action('google_ads_native_action', manager.name), undefined);
  assert.equal(bare.action('apple_ads_native_action', apple.name), undefined);
  // No provider's documented action is another gateway's route.
  for (const gateway of ['tiktok_native_action', 'snapchat_native_action', 'linkedin_native_action'])
    for (const action of [rule, manager, apple]) assert.equal(registry.action(gateway, action.name), undefined);
});

test('Microsoft’s own tool and catalog come with AMCP’s tools, and its help is its contracts', () => {
  const gateway = 'microsoft_ads_native_action';
  assert.equal(registry.tools.get(gateway), microsoftTool);
  assert.equal(registry.catalogs.get(gateway).actions, microsoftActions);
  assert.equal(registry.catalogs.get(gateway).denominator_kind, 'LIST_ACTIONS');
  assert.equal(registry.action(gateway, microsoftActions[0].name), microsoftActions[0]);
  // The tool list ends with it, after every captured tool.
  assert.equal([...registry.tools.keys()].at(-1), gateway);
  const bare = without({tools: ['amcp_tool_help']});
  assert.equal(bare.tools.has(gateway), false);
  assert.equal(bare.catalogs.has(gateway), false);
  // amcp_tool_help takes only the gateway and an operation name for it, refused otherwise; other gateways' help
  // arguments are checked by the help tool's schema.
  registry.validate('amcp_tool_help', {gateway, operation: microsoftActions[0].name}, strict);
  for (const input of [
    {gateway, extra: 1},
    {gateway, operation: 7},
  ])
    assert.throws(
      () => registry.validate('amcp_tool_help', input, strict),
      refusal('INVALID_ARGUMENT', /^Invalid Microsoft help arguments\.$/),
    );
  assert.throws(
    () => registry.validate('amcp_tool_help', {gateway: 'meta_native_action', extra: 1}, strict),
    refusal('INVALID_ARGUMENT', /captured gateway schema/),
  );
  const help = registry.help({gateway}, strict);
  assert.equal(help.amcp_actions.length, microsoftActions.length);
  assert.ok(help.inputSchema);
  assert.deepEqual(registry.help({gateway, operation: microsoftActions[0].name}, strict), microsoftActions[0]);
  assert.throws(
    () => registry.help({gateway, operation: 'GetCampaignsByAcountId'}, strict),
    refusal('UNKNOWN_OPERATION', /^Unknown Microsoft operation\. Use LIST_ACTIONS\.$/),
  );
});

test('the help tool’s extension gateways are the providers whose tool and catalog are AMCP’s own', () => {
  // src/tool-help.ts imported Microsoft's module for its gateway name (fails on the build before).
  const source = fs.readFileSync(new URL('../src/tool-help.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /['"][a-z0-9_]+_native_action['"]/, 'no gateway literal in src/tool-help.ts');
  for (const [, module] of source.matchAll(/from '\.\/([^']+)\.js'/g))
    assert.ok(
      !isProviderModule('src/' + module + '.ts') || providerRegistries.includes('src/' + module + '.ts'),
      'src/tool-help.ts imports no provider module (' + module + ')',
    );
  const self = {name: 'amcp_tool_help', description: 'Help.', inputSchema: {type: 'object'}},
    context = {registry, options: strict, listed: () => [self], firstParty: () => []};
  assert.deepEqual(toolHelp(context, {}).amcp_extensions, {gateways: ['microsoft_ads_native_action']});
  assert.equal(
    toolHelp(context, {gateway: 'amcp_tool_help'}).amcp_arguments.gateway,
    'Any tool tools/list shows, including the AMCP tools and microsoft_ads_native_action.',
  );
  assert.deepEqual(
    registeredProviderHooks.filter(h => h.catalog?.own).map(h => h.gateway),
    ['microsoft_ads_native_action'],
  );
});

test('Apple’s help describes its v1 actions and leaves other operations to the registry', () => {
  const gateway = 'apple_ads_native_action',
    overview = registry.help({gateway}, strict);
  assert.equal(overview.amcp_actions.length, appleActions.length);
  assert.match(overview.qualification, /Independent AMCP v1 extensions/);
  const described = registry.help({gateway, operation: appleActions[0].name}, strict);
  assert.equal(described.name, appleActions[0].name);
  assert.match(described.qualification, /no live parity claim/);
  // An operation it does not own is the registry's: refused by name like any other gateway's unknown operation.
  assert.throws(() => registry.help({gateway, operation: 'NO_SUCH_OPERATION'}, strict), refusal('UNKNOWN_OPERATION'));
  // Another gateway's help has no Apple or Microsoft additions.
  const meta = registry.help({gateway: 'meta_native_action'}, strict);
  assert.equal(meta.amcp_actions, undefined);
  assert.equal(meta.qualification, undefined);
});
