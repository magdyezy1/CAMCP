import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {
  currentMetaPath,
  metaApiVersion,
  metaDialogUrl,
  metaGraphUrl,
  metaPrefix,
  metaRoute,
  resolveMetaVersion,
} from '../dist/src/meta-version.js';
import {Registry} from '../dist/src/catalog.js';
import {Introspection} from '../dist/src/introspection.js';
import {metaSdkTag, metaVersion} from '../tools/meta-sdk.mjs';

/**
 * AMCP sends Meta Graph API requests at one version (src/meta-version.ts, v26.0). The SDK evidence, the catalog, its
 * listings and every request path must agree with it, and nothing AMCP sends may be something v26.0 removed.
 */
const gateway = 'meta_native_action',
  registry = new Registry(),
  catalog = registry.catalogs.get(gateway),
  changes = JSON.parse(readFileSync('tests/fixtures/meta-sdk-changes-v26.json', 'utf8'));

test('the version AMCP sends is the version of its SDK evidence, catalog and listings', () => {
  assert.equal(metaApiVersion, 'v26.0');
  assert.equal(metaVersion, metaApiVersion);
  assert.deepEqual(changes.to, {api_version: metaApiVersion, sdk_tag: metaSdkTag});
  // The Advantage+ creative feature allowlist (PRV-06 C) moves with the version too: feature names change between releases.
  for (const file of ['meta-post-sdk-v26.json', 'meta-insights-sdk-v26.json', 'meta-creative-features-sdk-v26.json']) {
    const evidence = JSON.parse(readFileSync('tests/fixtures/' + file, 'utf8'));
    assert.equal(evidence.api_version, metaApiVersion, file);
    assert.equal(evidence.sdk_tag, metaSdkTag, file);
    assert.ok(
      Object.values(evidence.sources).every(s => s.url.includes('/' + metaSdkTag + '/')),
      file,
    );
  }
  assert.equal(catalog.api_version, metaApiVersion);
  for (const action of catalog.actions) assert.ok(action.path.startsWith(metaPrefix), action.name);
  const introspection = new Introspection(registry),
    page = introspection.list(gateway, {action: 'LIST_ACTIONS', limit: 100}, {mode: 'strict', flags: {}}),
    described = introspection.describe(gateway, {target_action: 'meta_ad_account_id_campaigns_get'});
  assert.equal(page.api_version, metaApiVersion);
  assert.ok(page.actions.every(a => a.path.startsWith(metaPrefix)));
  assert.equal(described.api_version, metaApiVersion);
  assert.ok(described.path.startsWith(metaPrefix));
  assert.equal(metaGraphUrl('oauth/access_token'), 'https://graph.facebook.com/v26.0/oauth/access_token');
  assert.equal(metaDialogUrl, 'https://www.facebook.com/v26.0/dialog/oauth');
});

test('only versions AMCP has evidence for can be configured; v25.0 stays available to move back', () => {
  assert.equal(resolveMetaVersion(undefined), 'v26.0');
  assert.equal(resolveMetaVersion('v25.0'), 'v25.0');
  for (const value of ['v27.0', 'v24.0', '26.0', 'v26', '', 26])
    assert.throws(() => resolveMetaVersion(value), {code: 'INVALID_API_VERSION'}, String(value));
});

test('recorded paths move to the current version, and routes recognise only the current version', () => {
  assert.equal(currentMetaPath('/v25.0/act_1/campaigns'), '/v26.0/act_1/campaigns');
  assert.equal(currentMetaPath('/v25.0/'), '/v26.0/');
  assert.equal(currentMetaPath('https://graph.facebook.com/v25.0/me'), 'https://graph.facebook.com/v26.0/me');
  for (const path of ['/v1.3/ad/get/', '/v25/customers/1', 'https://example.com/v25.0/me'])
    assert.equal(currentMetaPath(path), path);
  const route = metaRoute('act_[0-9]+/adimages$');
  assert.ok(route.test('/v26.0/act_12/adimages'));
  for (const path of ['/v25.0/act_12/adimages', '/v26x0/act_12/adimages', '/v26.0/act_12/adimages/x'])
    assert.ok(!route.test(path), path);
});

test('no catalog action lost its request in v26.0; 419 of 591 are compared with the SDK', () => {
  assert.deepEqual(changes.catalog, {actions: 591, with_sdk_request: 419, removed: []});
  for (const name of Object.keys(changes.catalog_requests)) assert.ok(registry.action(gateway, name), name);
  assert.equal(changes.catalog_requests.meta_ad_account_id_campaigns_get, 'AdAccount.get_campaigns');
});

test('nothing AMCP sends to Meta is a field, parameter or value that v26.0 removed', () => {
  // Every name AMCP can send appears in a string literal of its Meta modules or in the catalog's native fields.
  const files = [
      ...readdirSync('src')
        .filter(f => /^meta-.*\.ts$/.test(f))
        .map(f => 'src/' + f),
      'src/media-upload.ts',
      'src/report-native.ts',
      'src/workspace.ts',
      'src/write-verification.ts',
      'src/ad-previews.ts',
      'server/asset-discovery.ts',
    ],
    sent = new Map();
  const add = (token, where) => sent.set(token, new Set([...(sent.get(token) ?? []), where]));
  for (const file of files)
    for (const m of readFileSync(file, 'utf8').matchAll(/'([^'\n]*)'/g))
      for (const token of m[1].split(/[^A-Za-z0-9_]+/)) if (token) add(token, file);
  for (const action of JSON.parse(readFileSync('.mirror/CATALOG/meta_native_action.json', 'utf8')).actions)
    for (const field of action.raw.native_fields ?? []) add(field, 'catalog');
  // v26.0 removed AdSet.time_start, the ad set's own field. The time_start of POST /{campaign or ad set}/budget_schedules
  // stays: SDK 26.0.2 lists it for Campaign.create_budget_schedule and AdSet.create_budget_schedule, and no
  // budget_schedules parameter is among the removals. Only the budget schedule module may send that name, to that edge.
  assert.deepEqual(
    changes.removed.params.filter(p => p.includes('/budget_schedules ')),
    [],
  );
  // v26.0 also removed AdSet.execution_options, the ad set's own field. An ad rule's execution_spec keeps its own
  // execution_options list: Meta's Ad Rules "Execution Spec" page (read 2026-09-30) documents it for every rule action.
  // Only the rule module may send that name, inside execution_spec.
  const otherEdge = {time_start: 'src/meta-budget-schedules.ts', execution_options: 'src/meta-ad-rules.ts'};
  const sentAsRemoved = name =>
    sent.has(name) && !(otherEdge[name] && [...sent.get(name)].every(where => where === otherEdge[name]));
  // Removed enum values belong to removed fields (cost_bidding_mode, budget_source, attribution counting), so the
  // field and parameter names cover them.
  const removed = [
    ...changes.removed.fields.map(f => f.split('.').at(-1)),
    ...changes.removed.params.map(p => p.split(' ').at(-1)),
  ];
  assert.equal(removed.length, 27);
  assert.deepEqual(removed.filter(sentAsRemoved), []);
});
