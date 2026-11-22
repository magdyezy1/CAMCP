// always-run: lists the Google fixtures of the pinned version in tests/fixtures
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {
  currentGoogleAdsPath,
  googleAdsContract,
  googleAdsRequestChange,
  googleAdsVersion,
} from '../dist/src/google-version.js';
import {Registry} from '../dist/src/catalog.js';
import {Introspection} from '../dist/src/introspection.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {retiredGoogleAdsActions} from '../dist/src/retired-provider-actions.js';
import {googleVersion} from '../tools/google-protos.mjs';

/**
 * AMCP sends Google Ads requests at one version (src/google-version.ts, v25). Every place that pins a version — the
 * registry's routes, the Discovery contract, the legacy adapter's protobuf descriptors and the evidence tools — must
 * agree with it, and what the captured v23 catalog records must still hold at that version.
 */
const gateway = 'google_ads_native_action',
  registry = new Registry(),
  catalog = registry.catalogs.get(gateway),
  vendor = JSON.parse(readFileSync('generated/vendor-routes.json', 'utf8')),
  discovery = JSON.parse(readFileSync('.mirror/VENDOR/google-ads-' + googleAdsVersion + '.json', 'utf8')).document,
  schemas = discovery.schemas,
  V = 'GoogleAdsGoogleadsV' + googleAdsVersion.slice(1);
const camel = s => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

test('the version AMCP sends is the version of its routes, Discovery contract, descriptors and evidence tools', () => {
  assert.equal(googleAdsVersion, 'v25');
  assert.equal(googleVersion, googleAdsVersion);
  assert.equal(discovery.version, googleAdsVersion);
  assert.equal(googleAdsContract, 'google-ads-' + googleAdsVersion);
  assert.deepEqual(
    Object.keys(vendor.schemaComponents).filter(k => k.startsWith('google-ads-')),
    [googleAdsContract],
  );
  assert.equal(
    JSON.parse(readFileSync('src/google-legacy-mapping.json', 'utf8')).googleProto.version,
    googleAdsVersion,
  );
  assert.equal(catalog.api_version, googleAdsVersion);
  for (const action of catalog.actions.filter(a => a.path))
    assert.match(action.path, new RegExp('^/' + googleAdsVersion + '(?:[/:]|$)'), action.name);
});

test('recorded paths and upload URLs move to the current version; other paths stay as they are', () => {
  assert.equal(currentGoogleAdsPath('/v23/customers/1/campaigns:mutate'), '/v25/customers/1/campaigns:mutate');
  assert.equal(currentGoogleAdsPath('/v23:listPlannableLocations'), '/v25:listPlannableLocations');
  assert.equal(
    currentGoogleAdsPath(
      'https://googleads.googleapis.com/resumable/upload/v23/customers/1/youTubeVideoUploads:create',
    ),
    'https://googleads.googleapis.com/resumable/upload/v25/customers/1/youTubeVideoUploads:create',
  );
  for (const path of ['/api/v23/x', 'https://example.com/v23/customers/1', '/v1.3/ad/get/', '/customers/v23/x'])
    assert.equal(currentGoogleAdsPath(path), path);
});

test('each captured RPC has a v25 route, except the two methods v25 removed, which stay refused by name', () => {
  const routed = new Set(vendor.routes.filter(r => r.gateway === gateway).map(r => r.action)),
    unrouted = catalog.actions.filter(a => a.raw.surface === 'rpc' && !routed.has(a.name)).map(a => a.name);
  assert.deepEqual(unrouted.sort(), [...retiredGoogleAdsActions].sort());
  assert.deepEqual(retiredGoogleAdsActions.sort(), [
    'google_ads_v23_campaign_lifecycle_goal_configure_campaign_lifecycle_goals',
    'google_ads_v23_customer_lifecycle_goal_configure_customer_lifecycle_goals',
  ]);
});

test('every request field the catalog requires exists in the pinned v25 request or its query parameters', () => {
  const routes = new Map(vendor.routes.filter(r => r.gateway === gateway).map(r => [r.action, r]));
  let checked = 0;
  for (const action of catalog.actions.filter(a => routes.has(a.name))) {
    const route = routes.get(action.name),
      request = route.requestSchema?.$ref ? schemas[route.requestSchema.$ref] : route.requestSchema,
      properties = Object.keys(request?.properties ?? {}),
      path = [...(action.path ?? '').matchAll(/\{([a-z_]+)[=}]/g)].map(m => m[1]);
    for (const field of action.required) {
      if (field === 'customer_id' || field === 'resource_name' || path.includes(field)) continue;
      checked++;
      assert.ok(
        properties.includes(camel(field)) || route.parameters?.[camel(field)],
        action.name + ' requires ' + field + ', which v25 does not define',
      );
    }
  }
  assert.ok(checked > 140, String(checked));
  assert.deepEqual(
    catalog.actions.find(a => a.name === 'google_ads_v23_shareable_preview_generate_shareable_previews').required,
    ['customer_id', 'operation'],
  );
  assert.match(
    googleAdsRequestChange('google_ads_v23_shareable_preview_generate_shareable_previews'),
    /"operation".*"assetGroup"/,
  );
  assert.equal(googleAdsRequestChange('google_ads_v23_campaign_mutate_campaigns'), undefined);
});

test('the GAQL fields AMCP pinned from the v23 field reference all exist in v25 with the same cardinality', () => {
  // The field reference pages (selectable, filterable) could not be read for v25; Discovery confirms each field and
  // whether it repeats. Selectability stays as the v23 reference recorded it.
  const leaf = (resource, field) => {
    let schema = schemas[V + 'Resources__' + camel(resource).replace(/^./, c => c.toUpperCase())],
      property;
    for (const part of field.split('.')) {
      property = schema?.properties?.[camel(part)];
      if (!property) return undefined;
      const ref = property.$ref ?? property.items?.$ref;
      schema = ref ? schemas[ref] : undefined;
    }
    return property;
  };
  let fields = 0;
  for (const file of readdirSync('tests/fixtures').filter(f => /^google-.*fields-v23\.json$/.test(f))) {
    const evidence = JSON.parse(readFileSync('tests/fixtures/' + file, 'utf8')),
      groups = evidence.resources
        ? Object.entries(evidence.resources).map(([r, v]) => [r, v.fields])
        : [[evidence.source.split('/').at(-1), evidence.fields]];
    for (const [resource, table] of groups)
      for (const [field, facts] of Object.entries(table)) {
        const property = leaf(resource, field.startsWith(resource + '.') ? field.slice(resource.length + 1) : field);
        assert.ok(property, file + ': ' + resource + '.' + field + ' is absent from v25');
        if (typeof facts.repeated === 'boolean')
          assert.equal(property.type === 'array', facts.repeated, file + ': ' + resource + '.' + field);
        fields++;
      }
  }
  assert.equal(fields, 626);
});

test('legacy names whose v23 operation v25 removed are refused with what to use instead', async () => {
  const key = Buffer.alloc(32, 91).toString('base64'),
    store = new Store(':memory:', key),
    actor = {tenantId: 'v25', userId: 'operator', role: 'operator'},
    c = {
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      scopes: ['https://www.googleapis.com/auth/adwords'],
      enabled: true,
      label: 'Synthetic Ads login',
    };
  store.putConnection({...actor, role: 'admin'}, c, {accessToken: 'synthetic', developerToken: 'synthetic'});
  let requests = 0;
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(async () => {
      requests++;
      throw Error('No request is expected');
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const prepare = (action, payload) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action, account_id: '123', connection_id: c.id, payload}},
      actor,
    );
  try {
    for (const [action, payload, replacement] of [
      [
        'SET_CAMPAIGN_BRAND_SAFETY',
        {resource_name: 'customers/123/campaigns/1', video_brand_safety_suitability: 'LIMITED_INVENTORY'},
        /customer_mutate_customer/,
      ],
      ['CONFIGURE_CUSTOMER_LIFECYCLE_GOAL', {}, /NEW_CUSTOMER_ACQUISITION/],
      ['CONFIGURE_CAMPAIGN_LIFECYCLE_GOAL', {}, /NEW_CUSTOMER_ACQUISITION/],
      ['LIST_CUSTOMER_LIFECYCLE_GOALS', {}, /FROM goal/],
      [
        'google_ads_v23_customer_lifecycle_goal_configure_customer_lifecycle_goals',
        {operation: {}},
        /NEW_CUSTOMER_ACQUISITION/,
      ],
    ]) {
      const r = await prepare(action, payload);
      assert.equal(r.error?.code, 'PROVIDER_ACTION_UNSUPPORTED', action + JSON.stringify(r));
      assert.match(r.error.message, /v25/, action);
      assert.match(JSON.stringify(r.error.details), replacement, action);
    }
    assert.equal(requests, 0);
  } finally {
    store.close();
  }
});

test('what callers read says v25: the tool definition, catalog pages and action descriptions', () => {
  const tool = registry.tools.get(gateway),
    text = JSON.stringify(tool);
  assert.match(tool.description, /^Complete Google Ads API v25 native gateway/);
  assert.doesNotMatch(text, /API v23|v23 proto|v23 request|Canonical v23/);
  const introspection = new Introspection(registry),
    page = introspection.list(
      gateway,
      {action: 'LIST_ACTIONS', surface: 'rpc', limit: 100},
      {mode: 'strict', flags: {}},
    );
  assert.equal(page.api_version, 'v25');
  assert.ok(page.actions.every(a => /^\/v25[/:]/.test(a.path)));
  const previews = introspection.describe(gateway, {
    target_action: 'google_ads_v23_shareable_preview_generate_shareable_previews',
  });
  assert.equal(previews.api_version, 'v25');
  assert.equal(previews.path, '/v25/customers/{customer_id=*}:generateShareablePreviews');
  assert.deepEqual(previews.required_fields, ['customer_id', 'operation']);
  // A description captured at v23 is listed at the version sent.
  const campaigns = introspection.describe(gateway, {target_action: 'google_ads_v23_campaign_mutate_campaigns'});
  assert.equal(campaigns.api_version, 'v25');
  assert.equal(campaigns.path, '/v25/customers/{customer_id=*}/campaigns:mutate');
});
