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
import {
  assertDataManagerContract,
  assertWireContractMode,
  sealedVendorDocument,
  wireContractCheck,
  wireContractMode,
} from '../dist/src/wire-contracts.js';
import {assertRefused} from './helpers/assert-refused.mjs';

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
      // A read is never refused, only recorded.
      await transport.request({...bad, readOnly: true, method: 'GET', body: undefined}, connection, credentials);
      await transport.request({...bad, readOnly: true}, connection, credentials);
      assert.equal(sent, 4);
    });
    await withMode('off', async () => {
      await transport.request(bad, connection, credentials);
      assert.equal(transport.metrics.wireContractViolations, 3, 'off checks nothing');
    });
  } finally {
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

/** A synthetic Discovery document in Data Manager's shape: only what this test needs, sealed like a pinned one. */
function syntheticDataManager() {
  const document = {
    name: 'datamanager',
    version: 'v1',
    schemas: {
      IngestAudienceMembersRequest: {
        id: 'IngestAudienceMembersRequest',
        type: 'object',
        properties: {
          destinations: {type: 'array', items: {$ref: 'Destination'}},
          audienceMembers: {type: 'array', items: {$ref: 'AudienceMember'}},
          consent: {$ref: 'Consent'},
          encoding: {type: 'string', enum: ['ENCODING_UNSPECIFIED', 'HEX', 'BASE64']},
          termsOfService: {type: 'object', properties: {customerMatchTermsOfServiceStatus: {type: 'string'}}},
          validateOnly: {type: 'boolean'},
        },
      },
      Destination: {
        id: 'Destination',
        type: 'object',
        properties: {
          operatingAccount: {type: 'object', properties: {accountType: {type: 'string'}, accountId: {type: 'string'}}},
          productDestinationId: {type: 'string'},
        },
      },
      AudienceMember: {
        id: 'AudienceMember',
        type: 'object',
        properties: {
          userData: {
            type: 'object',
            properties: {
              userIdentifiers: {
                type: 'array',
                items: {type: 'object', properties: {emailAddress: {type: 'string'}, phoneNumber: {type: 'string'}}},
              },
            },
          },
        },
      },
      Consent: {
        id: 'Consent',
        type: 'object',
        properties: {adUserData: {type: 'string'}, adPersonalization: {type: 'string'}},
      },
    },
    resources: {
      audienceMembers: {
        methods: {
          ingest: {
            id: 'datamanager.audienceMembers.ingest',
            httpMethod: 'POST',
            path: 'v1/audienceMembers:ingest',
            request: {$ref: 'IngestAudienceMembersRequest'},
          },
        },
      },
    },
  };
  return {document, document_sha256: createHash('sha256').update(JSON.stringify(document)).digest('hex')};
}
const dataManagerPlan = body => ({
  gateway: 'google_ads_native_action',
  action: 'DATA_MANAGER_INGEST_AUDIENCE_MEMBERS',
  method: 'POST',
  origin: 'https://datamanager.googleapis.com',
  path: '/v1/audienceMembers:ingest',
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

test('a Data Manager body that differs from the pinned contract is refused with INVALID_VENDOR_BODY', () => {
  const envelope = syntheticDataManager();
  assertDataManagerContract(dataManagerPlan({}), envelope, 'shadow');
  assert.throws(
    () =>
      assertDataManagerContract(
        dataManagerPlan({audienceMembers: [{userData: {userIdentifiers: [{emailAdress: 'a'.repeat(64)}]}}]}),
        envelope,
        'shadow',
      ),
    e => {
      assertRefused(e, 'INVALID_VENDOR_BODY');
      assert.deepEqual(e.details.errors, [
        {
          field: '/audienceMembers/0/userData/userIdentifiers/0/emailAdress',
          reason: 'Field absent from the pinned vendor request schema',
        },
      ]);
      return true;
    },
  );
  // The pinned hash check: an edited document no longer matches its recorded digest and is not used.
  const edited = structuredClone(envelope);
  edited.document.schemas.Consent.properties.extra = {type: 'string'};
  assert.throws(
    () => assertDataManagerContract(dataManagerPlan({}), edited, 'shadow'),
    e => assertRefused(e, 'VENDOR_SCHEMA_UNAVAILABLE'),
  );
  assertDataManagerContract(dataManagerPlan({bogus: 1}), envelope, 'off');
  // Until Google's document is pinned (tools/fetch-vendor-specs.mjs --refresh datamanager-v1), the route says so.
  const live = wireContractCheck(dataManagerPlan({}), 'shadow');
  if (sealedVendorDocument('datamanager-v1') === null) {
    assert.equal(live.status, 'unpinned');
    assert.equal(live.contract, 'datamanager-v1');
    assertDataManagerContract(dataManagerPlan({bogus: 1}));
  } else assert.equal(live.status, 'conforms');
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
test('every gateway keeps JSON numbers for its checks and carries the exact twin of unsafe integers', async () => {
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
