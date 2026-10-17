import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {MirrorService, withExactIntegers} from '../dist/src/service.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {DelegatedNativeCompiler} from '../dist/src/delegated-native.js';
import {compileMicrosoft, microsoftContracts} from '../dist/src/microsoft-native.js';
import {validateGoogleRequest} from '../dist/src/google-contracts.js';
import {NativeTransport, exactIntegerJson, vendorOrigins} from '../dist/src/transport.js';
import {microsoftOrigin} from '../dist/src/microsoft-native.js';
import {dataManagerActions} from '../dist/src/google-data-manager-routes.js';
import {
  assertDataManagerContract,
  assertWireContractMode,
  sealedVendorDocument,
  wireContractCheck,
  wireContractMode,
  wireContractResolver,
} from '../dist/src/wire-contracts.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {offerParkedProviders} from './helpers/parked-providers.mjs';
import {parkedProviderIds} from '../dist/src/provider-adapters.js';

/**
 * PRV-05: pinned vendor request schemas checked on every route that has one (shadow first, enforcement for reviewed
 * writes behind AMCP_WIRE_CONTRACTS=enforce), and unsafe integers of identifier fields kept exact on every gateway.
 */
const registry = new Registry(),
  compiler = new Compiler(registry),
  delegated = new DelegatedNativeCompiler(),
  key = Buffer.alloc(32, 55).toString('base64'),
  admin = {tenantId: 'wire', userId: 'owner', role: 'admin'},
  operator = {tenantId: 'wire', userId: 'operator', role: 'operator'},
  options = {mode: 'enhanced', flags: {}};
function withMode(mode, run) {
  const previous = process.env.AMCP_WIRE_CONTRACTS;
  if (mode === undefined) delete process.env.AMCP_WIRE_CONTRACTS;
  else process.env.AMCP_WIRE_CONTRACTS = mode;
  const restore = () => {
    if (previous === undefined) delete process.env.AMCP_WIRE_CONTRACTS;
    else process.env.AMCP_WIRE_CONTRACTS = previous;
  };
  try {
    const out = run();
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  } catch (e) {
    restore();
    throw e;
  }
}
const gtmTag = extra =>
  delegated.compile('gtm_native_action', {
    operation: 'gtm_ops',
    arguments: {
      action: 'UPDATE_TAG',
      path: 'accounts/1/containers/2/workspaces/3/tags/4',
      payload: {name: 'Tag', type: 'html', parameter: [{type: 'template', key: 'html', value: '<b>x</b>'}], ...extra},
    },
  });
const dv360Campaign = goal =>
  compiler.compile(
    'dv360_native_action',
    {
      action: 'DV360_ADVERTISERS_CAMPAIGNS_CREATE',
      params: {advertiserId: '123'},
      body: {displayName: 'Draft', entityStatus: 'ENTITY_STATUS_PAUSED', campaignGoal: goal},
    },
    options,
  );
const microsoftAds = asset =>
  compileMicrosoft({
    action: 'AddAds',
    account_id: '123',
    payload: {
      AdGroupId: '200',
      Ads: [
        {
          Type: 'ResponsiveSearch',
          FinalUrls: ['https://example.com'],
          Headlines: [{Asset: {Type: 'TextAsset', Text: 'Headline', ...asset}}],
          Descriptions: [{Asset: {Type: 'TextAsset', Text: 'Description'}}],
        },
      ],
    },
  });

test('Google Ads keeps the exact refusals of its Discovery check after the validator was shared (golden)', () => {
  const plan = (body, readOnly = false, path = '/v25/customers/123/campaigns:mutate') => ({
    gateway: 'google_ads_native_action',
    action: 'x',
    method: 'POST',
    path,
    query: {},
    headers: {},
    body,
    readOnly,
  });
  const errors = p => {
    try {
      validateGoogleRequest(p);
      return 'ok';
    } catch (e) {
      assert.equal(e.code, 'INVALID_VENDOR_BODY');
      assert.equal(e.message, 'Request differs from the official Google Ads v25 Discovery contract.');
      return e.details.errors;
    }
  };
  const absent = 'Field absent from the pinned vendor request schema';
  // Recorded from validateGoogleRequest before it was moved onto discoveryIssues (src/wire-contracts.ts).
  assert.equal(errors(plan({operations: [{create: {name: 'A', status: 'PAUSED', manual_cpc: {}}}]})), 'ok');
  assert.deepEqual(
    errors(
      plan({operations: [{create: {name: 'A', statuss: 'PAUSED', network_settings: {target_google_searchh: true}}}]}),
    ),
    [
      {field: '/operations/0/create/statuss', reason: absent},
      {field: '/operations/0/create/networkSettings/targetGoogleSearchh', reason: absent},
    ],
  );
  assert.deepEqual(errors(plan({operations: [{create: {name: 'A', status: 2}}]})), [
    {field: '/operations/0/create/status', reason: 'Use the enum name; a numeric enum value cannot be reviewed'},
  ]);
  assert.equal(errors(plan({operations: [{create: {name: 'A', status: 2}}]}, true)), 'ok');
  assert.deepEqual(
    errors(
      plan({
        operations: [
          {
            create: {
              name: 5,
              id: '1.5',
              campaign_budget: ['x'],
              target_spend: {cpc_bid_ceiling_micros: '99999999999999999999'},
            },
          },
        ],
        partial_failure: 'yes',
      }),
    ),
    [
      {field: '/operations/0/create/name', reason: 'Expected string'},
      {field: '/operations/0/create/id', reason: 'Expected a decimal string or safe integer'},
      {field: '/operations/0/create/campaignBudget', reason: 'Expected string'},
      {
        field: '/operations/0/create/targetSpend/cpcBidCeilingMicros',
        reason: 'Integer outside the declared 64-bit range',
      },
      {field: '/partialFailure', reason: 'Expected boolean'},
    ],
  );
  assert.deepEqual(errors(plan({operations: [{create: {status: 'RUNNING'}}]})), [
    {field: '/operations/0/create/status', reason: 'Value absent from the pinned vendor enum'},
  ]);
  assert.deepEqual(errors(plan({operations: {create: {}}})), [{field: '/operations', reason: 'Expected an array'}]);
  assert.equal(
    errors(plan({operations: Array.from({length: 30}, (_, i) => ({create: {['bogus' + i]: 1}}))})).length,
    20,
  );
  assert.deepEqual(
    errors(plan({query: 'SELECT campaign.id FROM campaign', bogus: 1}, true, '/v25/customers/123/googleAds:search')),
    [{field: '/bogus', reason: absent}],
  );
  assert.equal(errors(plan({operations: [{create: {name: null}}]})), 'ok');
});

test('an unknown nested field is reported on every gateway with a pinned request schema; conforming bodies pass', () => {
  const ga4 = extra =>
    delegated.compile('ga4_native_action', {
      operation: 'ga4_run_report',
      arguments: {
        property: '123',
        request: {dateRanges: [{startDate: '7daysAgo', endDate: 'today', ...extra}], metrics: [{name: 'sessions'}]},
      },
    });
  const gsc = extra =>
    delegated.compile('google_search_console_native_action', {
      operation: 'gsc_analytics_ops',
      arguments: {
        action: 'QUERY_SEARCH_ANALYTICS',
        site_url: 'https://example.com/',
        payload: {
          startDate: '2026-09-01',
          endDate: '2026-09-07',
          dimensionFilterGroups: [{filters: [{dimension: 'QUERY', expression: 'x', ...extra}]}],
        },
      },
    });
  const business = extra =>
    delegated.compile('google_business_native_action', {
      operation: 'gmb_location_ops',
      arguments: {
        action: 'PATCH_LOCATION',
        location_id: '456',
        params: {updateMask: 'storefrontAddress'},
        payload: {storefrontAddress: {regionCode: 'US', addressLines: ['1 Main St'], ...extra}},
      },
    });
  const cases = [
    ['gtm-v2', gtmTag({}), gtmTag({parameter: [{type: 'template', key: 'html', valuee: 'x'}]}), '/parameter/0/valuee'],
    ['ga4-data-v1beta', ga4({}), ga4({endDat: 'today'}), '/dateRanges/0/endDat'],
    ['search-console-v1', gsc({}), gsc({operatr: 'contains'}), '/dimensionFilterGroups/0/filters/0/operatr'],
    ['business-info-v1', business({}), business({postCode: '1'}), '/storefrontAddress/postCode'],
    [
      'dv360-v4',
      dv360Campaign({campaignGoalType: 'CAMPAIGN_GOAL_TYPE_BRAND_AWARENESS'}),
      dv360Campaign({campaignGoalType: 'CAMPAIGN_GOAL_TYPE_BRAND_AWARENESS', performanceGoall: {}}),
      '/campaignGoal/performanceGoall',
    ],
    [
      'microsoft-campaign-management-v13',
      microsoftAds({}),
      microsoftAds({Textt: 'x'}),
      '/Ads/0/Headlines/0/Asset/Textt',
    ],
  ];
  for (const [contract, good, bad, field] of cases) {
    const ok = wireContractCheck(good, 'shadow'),
      found = wireContractCheck(bad, 'shadow');
    assert.equal(ok?.contract, contract, contract);
    assert.equal(ok.status, 'conforms', contract + ' ' + JSON.stringify(ok.issues));
    assert.equal(found.status, 'violations', contract);
    assert.deepEqual(found.issues, [{field, reason: 'Field absent from the pinned vendor request schema'}], contract);
    assert.match(found.document_sha256, /^[0-9a-f]{64}$/);
  }
  // Discovery's `any` takes every JSON value (a Business Profile attribute value).
  const attributes = delegated.compile('google_business_native_action', {
    operation: 'gmb_location_ops',
    arguments: {
      action: 'UPDATE_LOCATION_ATTRIBUTES',
      location_id: '456',
      params: {attributeMask: 'attributes/has_wheelchair_accessible_entrance'},
      payload: {
        name: 'locations/456/attributes',
        attributes: [{name: 'attributes/x', valueType: 'BOOL', values: [true]}],
      },
    },
  });
  assert.equal(wireContractCheck(attributes, 'shadow').status, 'conforms');
  // Microsoft resolves the REST Type discriminator: a field of another derived type is unknown.
  assert.deepEqual(wireContractCheck(microsoftAds({Type: 'ImageAsset'}), 'shadow').issues, [
    {field: '/Ads/0/Headlines/0/Asset/Text', reason: 'Field absent from the pinned vendor request schema'},
  ]);
  // A route without a pinned request schema is not claimed as checked; `off` checks nothing.
  assert.equal(wireContractCheck({...gtmTag({}), gateway: 'meta_native_action'}, 'shadow'), undefined);
  assert.equal(wireContractCheck(gtmTag({bogus: 1}), 'off'), undefined);
});

test('every route with a pinned request schema resolves to its sealed contract, and every reference resolves', () => {
  const routes = JSON.parse(fs.readFileSync('generated/vendor-routes.json', 'utf8')).routes;
  let checked = 0;
  for (const r of routes.filter(
    r =>
      [
        'gtm_native_action',
        'ga4_native_action',
        'google_search_console_native_action',
        'google_business_native_action',
      ].includes(r.gateway) && r.requestSchema,
  )) {
    const plan = {
      gateway: r.gateway,
      action: r.operation + (r.action ? '/' + r.action : ''),
      method: r.method,
      path: '/x',
      query: {},
      headers: {},
      body: {},
      readOnly: r.readOnly,
    };
    const check = wireContractCheck(plan, 'shadow');
    assert.equal(check?.status, 'conforms', plan.gateway + ' ' + plan.action);
    assert.equal(check.vendor_method, r.vendorMethod);
    // Every schema reachable from the request resolves in the pinned document (no runtime VENDOR_SCHEMA_UNAVAILABLE).
    const schemas = sealedVendorDocument(r.sourceFile).envelope.document.schemas,
      seen = new Set();
    const walk = v => {
      if (!v || typeof v !== 'object') return;
      if (typeof v.$ref === 'string' && !seen.has(v.$ref)) {
        seen.add(v.$ref);
        assert.ok(schemas[v.$ref], r.sourceFile + ' lacks ' + v.$ref);
        walk(schemas[v.$ref]);
      }
      for (const child of Object.values(v)) walk(child);
    };
    walk(r.requestSchema);
    checked++;
  }
  assert.ok(checked >= 60, checked + ' delegated routes');
  for (const name of ['gtm-v2', 'ga4-data-v1beta', 'search-console-v1', 'business-info-v1', 'dv360-v4'])
    assert.equal(sealedVendorDocument(name).sealed, true, name);
  // Display & Video 360: each Discovery method with a request body resolves from its own verb and path.
  const dv = sealedVendorDocument('dv360-v4').envelope.document,
    methods = [];
  const visit = r => {
    for (const m of Object.values(r.methods ?? {})) methods.push(m);
    for (const n of Object.values(r.resources ?? {})) visit(n);
  };
  visit(dv);
  let dvChecked = 0;
  for (const m of methods.filter(m => m.request && !m.supportsMediaUpload)) {
    const path = '/' + (m.flatPath ?? m.path).replace(/\{[^}]+\}/g, '123');
    const check = wireContractCheck(
      {
        gateway: 'dv360_native_action',
        action: 'x',
        method: m.httpMethod,
        path,
        query: {},
        headers: {},
        body: {},
        readOnly: false,
      },
      'shadow',
    );
    assert.equal(check?.vendor_method, m.id, path);
    dvChecked++;
  }
  assert.ok(dvChecked >= 70, dvChecked + ' DV360 methods');
  // Microsoft: every operation AMCP sends has a request element in the pinned WSDL model.
  for (const [action] of microsoftContracts) {
    const check = wireContractCheck(
      {
        gateway: 'microsoft_ads_native_action',
        action,
        method: 'POST',
        path: '/x',
        query: {},
        headers: {},
        body: {},
        readOnly: true,
      },
      'shadow',
    );
    assert.equal(check?.status, 'conforms', action);
  }
});

test('shadow mode sends the request and counts the violation; enforce refuses a write before any network call', async () => {
  const store = new Store(':memory:', key);
  let sent = 0;
  const transport = new NativeTransport(async () => {
    sent++;
    return Response.json({tagId: '4'});
  });
  transport.coordination = store;
  const connection = {id: 'c', tenantId: 'wire', gateway: 'gtm_native_action', accounts: ['1'], enabled: true},
    credentials = {accessToken: 'synthetic'};
  try {
    const bad = gtmTag({firingTriggerIdd: ['1']});
    await withMode(undefined, async () => {
      assert.equal(wireContractMode(), 'shadow', 'shadow is the default');
      await transport.request(bad, connection, credentials);
    });
    assert.equal(sent, 1);
    assert.equal(transport.metrics.wireContractViolations, 1);
    assert.equal(store.documents('wire', 'provider_metrics')[0].wire_contract_violations, 1);
    await withMode('enforce', async () => {
      await assert.rejects(transport.request(bad, connection, credentials), e => {
        assertRefused(e, 'INVALID_VENDOR_BODY');
        assert.equal(e.details.contract, 'gtm-v2');
        assert.deepEqual(e.details.errors, [
          {field: '/firingTriggerIdd', reason: 'Field absent from the pinned vendor request schema'},
        ]);
        return true;
      });
      assert.equal(sent, 1, 'nothing was sent');
      // The violation is still counted, and a conforming write is sent.
      assert.equal(transport.metrics.wireContractViolations, 2);
      await transport.request(gtmTag({}), connection, credentials);
      assert.equal(sent, 2);
      // A read is never refused, only recorded, and its violation is counted apart from the writes' enforcement gate.
      await transport.request({...bad, readOnly: true, method: 'GET', body: undefined}, connection, credentials);
      await transport.request({...bad, readOnly: true}, connection, credentials);
      assert.equal(sent, 4);
      assert.equal(transport.metrics.wireContractViolations, 2, 'a read violation is not a write violation');
      assert.equal(transport.metrics.wireContractReadViolations, 1);
      const metrics = store.documents('wire', 'provider_metrics')[0];
      assert.equal(metrics.wire_contract_violations, 2);
      assert.equal(metrics.wire_contract_read_violations, 1);
    });
    await withMode('off', async () => {
      await transport.request(bad, connection, credentials);
      assert.equal(transport.metrics.wireContractViolations, 2, 'off checks nothing');
      assert.equal(transport.metrics.wireContractReadViolations, 1, 'off checks nothing');
    });
  } finally {
    store.close();
  }
});

test('a validator that throws never stops a shadow read or write; an enforced write fails closed (regression)', async () => {
  // Before: a non-MirrorError of the validator (a Discovery array without items, an unexpected envelope) propagated
  // out of transport.request and failed every read and write of six gateways, although shadow mode only reports.
  const store = new Store(':memory:', key);
  let sent = 0;
  const transport = new NativeTransport(async () => {
    sent++;
    return Response.json({tagId: '4'});
  });
  transport.coordination = store;
  const connection = {id: 'c', tenantId: 'wire', gateway: 'gtm_native_action', accounts: ['1'], enabled: true},
    credentials = {accessToken: 'synthetic'},
    original = wireContractResolver.resolve;
  try {
    for (const broken of [
      () => {
        throw new TypeError("Cannot read properties of undefined (reading '$ref')");
      },
      plan => ({...original(plan), check: () => undefined.items}),
    ]) {
      wireContractResolver.resolve = broken;
      const write = gtmTag({}),
        read = {...write, readOnly: true};
      await withMode('shadow', async () => {
        const check = wireContractCheck(write);
        assert.equal(check.status, 'check_failed');
        assert.deepEqual(check.issues, [{field: '', reason: 'Wire-contract check failed: TypeError'}]);
        await transport.request(write, connection, credentials);
        await transport.request(read, connection, credentials);
      });
      await withMode('enforce', async () => {
        // A read still goes out; an enforced write is refused before anything is sent.
        await transport.request(read, connection, credentials);
        const before = sent;
        await assert.rejects(transport.request(write, connection, credentials), e =>
          assertRefused(e, 'VENDOR_SCHEMA_UNAVAILABLE'),
        );
        assert.equal(sent, before, 'nothing was sent');
      });
    }
    assert.equal(sent, 6);
    assert.equal(transport.metrics.wireContractViolations, 0, 'a validator defect is not a body violation');
    assert.equal(transport.metrics.wireContractCheckFailures, 8);
    assert.equal(store.documents('wire', 'provider_metrics')[0].wire_contract_check_failures, 8);
  } finally {
    wireContractResolver.resolve = original;
    store.close();
  }
});

test('a misspelt AMCP_WIRE_CONTRACTS stops startup and fails closed at runtime', () => {
  assert.throws(() => assertWireContractMode('enforced'), /off, shadow or enforce/);
  for (const ok of [undefined, '', 'off', 'shadow', 'enforce']) assertWireContractMode(ok);
  assert.equal(wireContractMode('enforced'), 'enforce');
  assert.equal(wireContractMode(undefined), 'shadow');
});

test('inspect and prepare show the wire contract in evidence; enforce refuses the reviewed write at inspect', async () => {
  const store = new Store(':memory:', key);
  store.putConnection(
    admin,
    {
      id: 'dv',
      tenantId: 'wire',
      gateway: 'dv360_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  let writes = 0;
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(async (input, init) => {
      if (init.method !== 'GET') writes++;
      return Response.json({advertiserId: '123', displayName: 'Account'});
    }),
    undefined,
    {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  );
  const args = {
    action: 'DV360_ADVERTISERS_CAMPAIGNS_CREATE',
    params: {advertiserId: '123'},
    body: {
      displayName: 'Draft',
      entityStatus: 'ENTITY_STATUS_PAUSED',
      campaignGoal: {campaignGoalType: 'CAMPAIGN_GOAL_TYPE_BRAND_AWARENESS', bogus: 1},
    },
  };
  const call = action =>
    service.call(
      'amcp_write',
      {action, gateway: 'dv360_native_action', connection_id: 'dv', arguments: args},
      operator,
    );
  try {
    await withMode('shadow', async () => {
      const inspected = await call('inspect');
      assert.equal(inspected.success, true, JSON.stringify(inspected));
      const wire = inspected.data.contract_evidence.wire_contract;
      assert.equal(wire.status, 'violations');
      assert.equal(wire.enforced, false);
      assert.deepEqual(wire.issues, [
        {field: '/campaignGoal/bogus', reason: 'Field absent from the pinned vendor request schema'},
      ]);
      const prepared = await call('prepare');
      assert.equal(prepared.success, true, JSON.stringify(prepared));
      const audit = store.db
        .prepare("SELECT event FROM audit WHERE tenant_id='wire'")
        .all()
        .map(r => JSON.parse(r.event))
        .find(a => a.event === 'write_prepared');
      assert.equal(audit?.wire_contract?.status, 'violations');
    });
    await withMode('enforce', async () => {
      // Inspect reports the refusal as an unsupported review; prepare refuses before any read or write.
      const inspected = await call('inspect');
      assert.equal(inspected.data.review_contract_supported, false);
      assert.equal(inspected.data.error.code, 'INVALID_VENDOR_BODY');
      const refused = await call('prepare');
      assertRefused(refused, 'INVALID_VENDOR_BODY', {writes: () => writes});
      assert.equal(refused.error.details.contract, 'dv360-v4');
    });
    assert.equal(writes, 0);
  } finally {
    store.close();
  }
});

// Data Manager (PRV-05): Google's Data Manager API v1 Discovery document is pinned in .mirror/VENDOR/datamanager-v1.json
// (fetched with `node tools/fetch-vendor-specs.mjs --refresh datamanager-v1`). These cases read that committed pin;
// before it existed they could only inject a synthetic envelope, and the routes reported `unpinned`.
const dataManagerDiscovery = 'https://datamanager.googleapis.com/$discovery/rest?version=v1';
const dataManagerPlan = (
  body,
  action = 'DATA_MANAGER_INGEST_AUDIENCE_MEMBERS',
  path = '/v1/audienceMembers:ingest',
) => ({
  gateway: 'google_ads_native_action',
  action,
  method: 'POST',
  origin: 'https://datamanager.googleapis.com',
  path,
  query: {},
  headers: {},
  readOnly: false,
  body: {
    destinations: [{operatingAccount: {accountType: 'GOOGLE_ADS', accountId: '123'}, productDestinationId: '456'}],
    audienceMembers: [{userData: {userIdentifiers: [{emailAddress: 'a'.repeat(64)}]}}],
    encoding: 'HEX',
    consent: {adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_GRANTED'},
    termsOfService: {customerMatchTermsOfServiceStatus: 'ACCEPTED'},
    ...body,
  },
});
const unknownField =
  (field, method = 'datamanager.audienceMembers.ingest') =>
  e => {
    assertRefused(e, 'INVALID_VENDOR_BODY');
    assert.equal(e.details.contract, 'datamanager-v1');
    assert.equal(e.details.vendor_method, method);
    assert.deepEqual(e.details.errors, [{field, reason: 'Field absent from the pinned vendor request schema'}]);
    return true;
  };

test('the Data Manager v1 Discovery document is pinned, sealed and the source of the generated route integrity', () => {
  const pinned = sealedVendorDocument('datamanager-v1');
  // Regression (PRV-05): before the pin this was null and every Data Manager route reported `unpinned`.
  assert.ok(pinned, 'commit .mirror/VENDOR/datamanager-v1.json');
  assert.equal(pinned.sealed, true);
  const raw = JSON.parse(fs.readFileSync('.mirror/VENDOR/datamanager-v1.json', 'utf8'));
  // Provenance: the public Discovery URL, when it was read, and the SHA-256 of the document as fetched.
  assert.equal(raw.source, dataManagerDiscovery);
  assert.match(raw.captured_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(raw.evidence, 'VENDOR_DOCUMENTED_NOT_AMCP_OBSERVED');
  assert.equal(createHash('sha256').update(JSON.stringify(raw.document)).digest('hex'), raw.document_sha256);
  assert.equal(raw.document.name, 'datamanager');
  assert.equal(raw.document.version, 'v1');
  const integrity = JSON.parse(fs.readFileSync('generated/vendor-routes.json', 'utf8')).sourceIntegrity[
    'datamanager-v1'
  ];
  assert.deepEqual(integrity, {
    source: dataManagerDiscovery,
    document_sha256: raw.document_sha256,
    revision: raw.document.revision,
  });
  // Each AMCP Data Manager route is one method of the pinned document, with the same verb and path.
  const methods = [];
  const visit = r => {
    for (const m of Object.values(r.methods ?? {})) methods.push(m);
    for (const nested of Object.values(r.resources ?? {})) visit(nested);
  };
  visit(raw.document);
  const expected = {
    DATA_MANAGER_INGEST_AUDIENCE_MEMBERS: 'datamanager.audienceMembers.ingest',
    DATA_MANAGER_REMOVE_AUDIENCE_MEMBERS: 'datamanager.audienceMembers.remove',
    DATA_MANAGER_INGEST_EVENTS: 'datamanager.events.ingest',
    DATA_MANAGER_RETRIEVE_REQUEST_STATUS: 'datamanager.requestStatus.retrieve',
  };
  assert.deepEqual(dataManagerActions.map(a => a.name).sort(), Object.keys(expected).sort());
  for (const action of dataManagerActions) {
    const m = methods.find(x => x.id === expected[action.name]);
    assert.ok(m, action.name);
    assert.equal(m.httpMethod, action.method, action.name);
    assert.equal(new URL(raw.document.rootUrl + m.path).href, action.path, action.name);
    // A write carries its request schema; the status read takes none.
    assert.equal(!!m.request, !action.read_only, action.name);
  }
});

test('a Data Manager body that differs from the committed pin is refused with INVALID_VENDOR_BODY', () => {
  const pinned = sealedVendorDocument('datamanager-v1');
  // The body AMCP's Customer Match builder sends conforms to the committed pin, in every mode.
  for (const mode of ['shadow', 'enforce']) {
    const live = wireContractCheck(dataManagerPlan({}), mode);
    assert.equal(live.status, 'conforms', JSON.stringify(live.issues));
    assert.equal(live.contract, 'datamanager-v1');
    assert.equal(live.vendor_method, 'datamanager.audienceMembers.ingest');
    assert.equal(live.document_sha256, pinned.envelope.document_sha256);
    assertDataManagerContract(dataManagerPlan({}), undefined, mode);
  }
  // An unknown nested field is refused before any personal data is sent, in shadow mode as well as enforce (the default
  // mode, without an injected envelope: the committed pin decides).
  const misspelt = dataManagerPlan({audienceMembers: [{userData: {userIdentifiers: [{emailAdress: 'a'.repeat(64)}]}}]});
  for (const mode of [undefined, 'shadow', 'enforce'])
    assert.throws(
      () => withMode(mode, () => assertDataManagerContract(misspelt)),
      unknownField('/audienceMembers/0/userData/userIdentifiers/0/emailAdress'),
    );
  // Each write is checked against its own method: a removal takes no terms of service, an event no unknown click field.
  const removal = dataManagerPlan({}, 'DATA_MANAGER_REMOVE_AUDIENCE_MEMBERS', '/v1/audienceMembers:remove');
  delete removal.body.consent;
  assert.throws(
    () => assertDataManagerContract(removal, undefined, 'shadow'),
    unknownField('/termsOfService', 'datamanager.audienceMembers.remove'),
  );
  delete removal.body.termsOfService;
  assertDataManagerContract(removal, undefined, 'shadow');
  const event = adIdentifiers => {
    const plan = dataManagerPlan({}, 'DATA_MANAGER_INGEST_EVENTS', '/v1/events:ingest');
    delete plan.body.audienceMembers;
    delete plan.body.termsOfService;
    plan.body.events = [
      {
        adIdentifiers,
        eventTimestamp: '2026-10-01T00:00:00Z',
        conversionValue: 250,
        currency: 'SAR',
        eventSource: 'WEB',
      },
    ];
    return plan;
  };
  assertDataManagerContract(event({gclid: 'Cj0KCQiA'}), undefined, 'shadow');
  assert.throws(
    () => assertDataManagerContract(event({gclidd: 'Cj0KCQiA'}), undefined, 'shadow'),
    unknownField('/events/0/adIdentifiers/gclidd', 'datamanager.events.ingest'),
  );
  // The pinned hash check: an edited copy of the committed document no longer matches its digest and is not used.
  const edited = structuredClone(pinned.envelope);
  edited.document.schemas.Consent.properties.extra = {type: 'string'};
  assert.throws(
    () => assertDataManagerContract(dataManagerPlan({}), edited, 'shadow'),
    e => assertRefused(e, 'VENDOR_SCHEMA_UNAVAILABLE'),
  );
  // `off` skips the check.
  assertDataManagerContract(dataManagerPlan({bogus: 1}), undefined, 'off');
});

const unsafeText =
  '{"id":1800000000000000001,"data":{"list":[{"campaign_id":1800000000000000002,"ad_ids":[1800000000000000003,[1800000000000000004]],"spend":1.5,"big":1.8e19,"safe":12,"text":"1800000000000000006","note":"a: 1800000000000000007, b"}]},"ids":[1,1800000000000000005]}';
test('exactIntegerJson keeps each unsafe integer literal as its exact text and nothing else', () => {
  const exact = exactIntegerJson(unsafeText);
  assert.equal(exact.id, '1800000000000000001');
  const row = exact.data.list[0];
  assert.equal(row.campaign_id, '1800000000000000002');
  assert.deepEqual(row.ad_ids, ['1800000000000000003', ['1800000000000000004']]);
  assert.deepEqual(exact.ids, [1, '1800000000000000005']);
  // Safe integers, fractions, exponent forms and strings keep their JSON value.
  assert.equal(row.spend, 1.5);
  assert.equal(row.big, 1.8e19);
  assert.equal(row.safe, 12);
  assert.equal(row.text, '1800000000000000006');
  assert.equal(row.note, 'a: 1800000000000000007, b');
  assert.deepEqual(exactIntegerJson('[1800000000000000001]'), ['1800000000000000001']);
  // Without an unsafe integer literal there is no second parse and no twin.
  assert.equal(exactIntegerJson('{"id":"1800000000000000001","n":9007199254740991}'), undefined);
  assert.equal(exactIntegerJson('{"note":"x: 1800000000000000007, y"}'), undefined);
  assert.equal(exactIntegerJson('{"n":12345678901234567e2}'), undefined);
});

const synthetic = {
  accessToken: 'synthetic',
  developerToken: 'synthetic',
  clientId: 'synthetic',
  consumerKey: 'synthetic',
  consumerSecret: 'synthetic',
  tokenSecret: 'synthetic',
};
test('every gateway keeps JSON numbers for its checks and carries the exact twin of unsafe integers', async t => {
  // The vendor origins include parked providers' (Amazon Ads, Criteo), which NativeTransport refuses to send to unless
  // the deployment offers them (ARC-01, P9): this check of their response parsing offers them, as AMCP_PROVIDERS would.
  const previous = process.env.AMCP_PROVIDERS;
  t.after(() => {
    if (previous === undefined) delete process.env.AMCP_PROVIDERS;
    else process.env.AMCP_PROVIDERS = previous;
  });
  offerParkedProviders(...parkedProviderIds());
  const origins = {...vendorOrigins, microsoft_ads_native_action: microsoftOrigin};
  let checked = 0;
  for (const gateway of Object.keys(origins)) {
    for (const [text, twin] of [
      [unsafeText, true],
      ['{"id":"1800000000000000001","count":3}', false],
    ]) {
      const transport = new NativeTransport(
        async () => new Response(text, {headers: {'content-type': 'application/json'}}),
      );
      const result = await transport.request(
        {gateway, action: 'READ', method: 'GET', path: '/x', query: {}, headers: {}, readOnly: true, accountId: '1'},
        {
          id: 'c',
          tenantId: 'wire',
          gateway,
          accounts: ['1'],
          enabled: true,
          userAgent: 'amcp-test/1.0',
          accountCustomers: {1: '9'},
        },
        synthetic,
      );
      // `data` is what every family, evidence and contract check saw before PRV-05: an unsafe numeric identity is
      // still a number there, so a check that refuses one still refuses it.
      assert.deepEqual(result.data, JSON.parse(text), gateway);
      if (!twin) {
        assert.equal('exactData' in result, false, gateway);
        continue;
      }
      // The old parse returned 1800000000000000000 for both: another entity's ID.
      assert.equal(result.exactData.id, '1800000000000000001', gateway);
      assert.equal(result.exactData.data.list[0].campaign_id, '1800000000000000002', gateway);
      checked++;
    }
  }
  assert.ok(checked >= 15, checked + ' gateways');
});

test('an MCP native read returns unsafe 64-bit IDs exactly, across aggregated pages (TikTok, Meta)', async () => {
  const store = new Store(':memory:', key),
    admin = {tenantId: 'wire', userId: 'owner', role: 'admin'},
    reader = {tenantId: 'wire', userId: 'reader', role: 'operator'},
    advertiser = '7000000000000000001';
  store.putConnection(
    admin,
    {
      id: 'tt',
      tenantId: 'wire',
      gateway: 'tiktok_native_action',
      accounts: [advertiser],
      enabled: true,
      label: 'S',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  store.putConnection(
    admin,
    {
      id: 'mt',
      tenantId: 'wire',
      gateway: 'meta_native_action',
      accounts: ['123'],
      enabled: true,
      label: 'S',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const transport = new NativeTransport(
    async url => {
      const u = new URL(String(url));
      if (u.hostname.includes('tiktok')) {
        const page = Number(u.searchParams.get('page') ?? 1);
        return new Response(
          '{"code":0,"message":"OK","data":{"list":[{"campaign_id":' +
            (page === 1 ? '1800000000000000001' : '1800000000000000002') +
            ',"campaign_name":"C' +
            page +
            '"}],"page_info":{"page":' +
            page +
            ',"page_size":1,"total_number":2,"total_page":2}}}',
          {headers: {'content-type': 'application/json'}},
        );
      }
      return new Response('{"data":[{"id":1800000000000000003,"name":"M"},{"id":"1800000000000000004"}]}', {
        headers: {'content-type': 'application/json'},
      });
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    100,
  );
  const service = new MirrorService(registry, store, transport),
    server = createMcpServer(service, reader),
    client = new Client({name: 'Synthetic exact integers', version: '1.0.0'}),
    [ct, st] = InMemoryTransport.createLinkedPair();
  const tiktokArgs = {
      action: 'tiktok_campaign_get',
      account_id: advertiser,
      params: {page_size: 1},
      aggregate_pages: true,
    },
    metaArgs = {action: 'meta_campaign_list', account_id: '123', params: {fields: 'id,name'}};
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const tiktok = (await client.callTool({name: 'tiktok_native_action', arguments: tiktokArgs})).structuredContent;
    assert.equal(tiktok.success, true, JSON.stringify(tiktok));
    assert.deepEqual(
      tiktok.data.data.data.list.map(r => r.campaign_id),
      ['1800000000000000001', '1800000000000000002'],
      'the old read showed 1800000000000000000 twice',
    );
    const meta = (await client.callTool({name: 'meta_native_action', arguments: metaArgs})).structuredContent;
    assert.equal(meta.success, true, JSON.stringify(meta));
    assert.deepEqual(
      meta.data.data.data.map(r => r.id),
      ['1800000000000000003', '1800000000000000004'],
    );
    // The same call made by AMCP itself (a worker, a composite tool) keeps the provider's JSON numbers its checks
    // expect, so an AMCP check that refuses an unsafe numeric identity still sees one.
    const internal = await service.call('tiktok_native_action', tiktokArgs, reader);
    assert.equal(typeof internal.data.data.data.list[0].campaign_id, 'number');
    // withExactIntegers covers the outermost call only, never the tools that call makes.
    const outer = await withExactIntegers(() => service.call('tiktok_native_action', tiktokArgs, reader));
    assert.equal(outer.data.data.data.list[0].campaign_id, '1800000000000000001');
  } finally {
    await client.close();
    await server.close();
    store.close();
  }
});
