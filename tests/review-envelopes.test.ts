import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {normalizeSnapshot, reviewStateHash, changedStateFields} from '../src/review-state.js';
import {writeContractGateways} from '../src/write-shape.js';
import {validateState} from '../src/write-state.js';
import type {CompiledRequest, JsonObject} from '../src/types.js';

const registry = new Registry(),
  actor = {tenantId: 'envelope', userId: 'writer', role: 'operator' as const},
  admin = {...actor, role: 'admin' as const};
const gateway = 'google_ads_native_action',
  key = Buffer.alloc(32, 92).toString('base64');
for (const surface of ['rpc', 'legacy'])
  for (const change of ['telemetry', 'budget', 'currency', 'missing', 'pagination', 'partial', 'legacy_review'])
    test('Google ' + surface + ' reviewed create: ' + change, async () => {
      const store = new Store(':memory:', key);
      store.putConnection(
        admin,
        {
          id: 'g',
          tenantId: actor.tenantId,
          gateway,
          accounts: ['123'],
          writeAccounts: ['123'],
          enabled: true,
          label: 'Synthetic',
          scopes: [],
        },
        {accessToken: 'synthetic', developerToken: 'synthetic'},
      );
      let executing = false,
        reads = 0,
        writes = 0;
      const service = new MirrorService(
        registry,
        store,
        new NativeTransport(async (url, init) => {
          const path = new URL(String(url)).pathname;
          if (!path.endsWith('/googleAds:search')) {
            writes++;
            return Response.json({results: [{resourceName: 'customers/123/campaigns/333'}]});
          }
          const customer = String(init?.body).includes('FROM customer');
          reads++;
          const data: JsonObject = {
            results: customer
              ? [
                  {
                    customer: {
                      id: '123',
                      currencyCode: executing && change === 'currency' ? 'EUR' : 'EGP',
                      timeZone: 'Africa/Cairo',
                    },
                  },
                ]
              : [
                  {
                    campaignBudget: {
                      resourceName: 'customers/123/campaignBudgets/111',
                      amountMicros: executing && change === 'budget' ? '600000000' : '555550000',
                    },
                  },
                ],
            queryResourceConsumption: String([62, 74, 50, 68, 58, 92][(reads - 1) % 6]),
            requestId: 'synthetic-' + reads,
            fieldMask: customer
              ? 'customer.id,customer.currency_code,customer.time_zone'
              : 'campaign_budget.resource_name,campaign_budget.amount_micros',
            futureEnvelopeTelemetry: {queryCost: reads},
          };
          if (executing && change === 'missing') data.results = [];
          if (executing && change === 'pagination') data.nextPageToken = 'unread-page';
          if (executing && change === 'partial')
            data.partialFailureError = {code: 3, message: 'Synthetic partial read'};
          return Response.json(data);
        }),
        undefined,
        {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
      );
      try {
        const resource = {
          name: 'Synthetic campaign',
          status: 'PAUSED',
          advertisingChannelType: 'SEARCH',
          campaignBudget: 'customers/123/campaignBudgets/111',
          biddingStrategy: 'customers/123/biddingStrategies/222',
        };
        const args =
          surface === 'rpc'
            ? {
                action: 'google_ads_v23_campaign_mutate_campaigns',
                payload: {operations: [{create: resource}], partialFailure: false, validateOnly: false},
              }
            : {action: 'CREATE_CAMPAIGN', payload: {resource}};
        const p = await service.call(
          'amcp_write',
          {action: 'prepare', gateway, arguments: {...args, account_id: '123', dry_run: false}},
          actor,
        );
        assert.equal(p.success, true, JSON.stringify(p));
        assert.equal(writes, 0);
        const r = p.data;
        if (change === 'legacy_review') {
          const old = store.document(actor.tenantId, 'write_review', r.review_id);
          old.state = old.state.map((s: JsonObject) => ({
            ...s,
            queryResourceConsumption: '999',
            futureEnvelopeTelemetry: {queryCost: 999},
          }));
          old.state_hash = reviewStateHash(old.state);
          store.putDocument(actor.tenantId, 'write_review', r.review_id, old);
        }
        executing = true;
        const input = {
          action: 'execute',
          review_id: r.review_id,
          idempotency_key: r.idempotency_key,
          confirmed: true,
          spend_change_confirmed: true,
        };
        const e = await service.call('amcp_write', input, actor);
        if (['telemetry', 'legacy_review'].includes(change)) {
          assert.equal(e.success, true, JSON.stringify(e));
          assert.equal(writes, 1);
          const count = reads;
          assert.equal((await service.call('amcp_write', input, actor)).data.replayed, true);
          assert.equal(writes, 1);
          assert.equal(reads, count);
        } else {
          assert.equal(e.success, false);
          assert.equal(writes, 0);
          if (['budget', 'currency'].includes(change)) {
            assert.equal(e.error.code, 'STATE_CHANGED');
            assert.equal(e.error.details.expected_state_hash, r.state_hash);
            assert.notEqual(e.error.details.actual_state_hash, r.state_hash);
            assert.deepEqual(e.error.details.changed_fields, [
              change === 'budget'
                ? '$[1]["results"][0]["campaignBudget"]["amountMicros"]'
                : '$[0]["results"][0]["customer"]["currencyCode"]',
            ]);
          } else
            assert.equal(
              e.error.code,
              change === 'pagination'
                ? 'INCOMPLETE_STATE'
                : change === 'missing'
                  ? 'STATE_NOT_FOUND'
                  : 'STATE_READ_FAILED',
            );
        }
      } finally {
        store.close();
      }
    });

type Layout = {
  gateway: string;
  path: string;
  body?: JsonObject;
  action?: string;
  wrap: (resource: JsonObject, n: number) => JsonObject;
};
const layouts: Layout[] = [
  {
    gateway,
    path: '/v25/customers/123/googleAds:search',
    body: {
      query:
        "SELECT campaign.resource_name FROM campaign WHERE campaign.resource_name IN ('customers/123/campaigns/1')",
    },
    wrap: (r, n) => ({
      results: [{campaign: {resourceName: 'customers/123/campaigns/1', ...r}}],
      queryResourceConsumption: String(n),
      futureEnvelopeTelemetry: n,
    }),
  },
  {
    gateway: 'tiktok_native_action',
    path: '/v1.3/campaign/get/',
    wrap: (r, n) => ({
      code: 0,
      message: 'OK ' + n,
      request_id: String(n),
      futureEnvelopeTelemetry: n,
      data: {list: [{campaign_id: '1', ...r}], page_info: {page: 1, total_page: 1}, futureEnvelopeTelemetry: n},
    }),
  },
  {
    gateway: 'snapchat_native_action',
    path: '/v1/campaigns/1',
    wrap: (r, n) => ({
      request_status: 'SUCCESS',
      futureEnvelopeTelemetry: n,
      campaigns: [{sub_request_status: 'SUCCESS', futureEnvelopeTelemetry: n, campaign: {id: '1', ...r}}],
    }),
  },
  {
    gateway: 'x_ads_native_action',
    path: '/12/accounts/123/campaigns/1',
    wrap: (r, n) => ({data: {id: '1', ...r}, request: {params: {cursor: 'trace-' + n}}, futureEnvelopeTelemetry: n}),
  },
  {
    gateway: 'reddit_native_action',
    path: '/api/v3/campaigns/1',
    wrap: (r, n) => ({
      data: {id: '1', ad_account_id: '123', ...r},
      pagination: {previous: 'trace-' + n},
      futureEnvelopeTelemetry: n,
    }),
  },
  {
    gateway: 'microsoft_ads_native_action',
    path: '/CampaignManagement/v13/Campaigns/QueryByIds',
    action: 'GetCampaignsByIds',
    wrap: (r, n) => ({
      Campaigns: [{Id: '1', ...r}],
      PartialErrors: null,
      TrackingId: String(n),
      futureEnvelopeTelemetry: n,
    }),
  },
  {
    gateway: 'apple_ads_native_action',
    path: '/v1/campaigns/1',
    wrap: (r, n) => ({result: {id: 1, ...r}, error: null, requestId: String(n), futureEnvelopeTelemetry: n}),
  },
  // Business Profile validates complete pages before constructing keyed link state.
  {
    gateway: 'google_business_native_action',
    path: '/v1/locations/123',
    action: 'AMCP_PLACE_ACTION_READ',
    wrap: (r, n) => ({
      business: {name: 'locations/123', title: 'Synthetic'},
      links: {'locations/123/placeActionLinks/1': {...r, uri: 'https://example.com/book', isEditable: true}},
      requestId: String(n),
    }),
  },
  // Criteo's bounded multi-read adapter validates raw envelopes before building this compound state.
  {
    gateway: 'criteo_native_action',
    path: '/2026-07/retail-media/accounts/123/line-items',
    wrap: (r, n) => ({
      accountId: '123',
      lineItemId: '789',
      campaign: {id: '456', attributes: {}},
      line: {id: '789', attributes: r},
      target: {scope: 'include', storeIds: ['1']},
      audiences: [],
      requestId: String(n),
    }),
  },
  ...[
    'meta_native_action',
    'linkedin_native_action',
    'dv360_native_action',
    'ga4_native_action',
    'gtm_native_action',
    'google_search_console_native_action',
  ].map(gateway => ({
    gateway,
    path: '/resource/1',
    wrap: (r: JsonObject, n: number) => ({...r, requestId: String(n), updatedTime: String(n)}),
  })),
];
test('snapshot regression matrix explicitly covers every enabled write gateway', () =>
  assert.deepEqual(layouts.map(l => l.gateway).sort(), [...writeContractGateways].sort()));

for (const removed of ['absent', 'removed_row', 'still_present'])
  test('Google generic removal read-back distinguishes ' + removed, async () => {
    const store = new Store(':memory:', key),
      name = 'customers/123/campaigns/333';
    let mutated = false,
      writes = 0;
    store.putConnection(
      admin,
      {
        id: 'g',
        tenantId: actor.tenantId,
        gateway,
        accounts: ['123'],
        writeAccounts: ['123'],
        enabled: true,
        label: 'Synthetic',
        scopes: [],
      },
      {accessToken: 'synthetic', developerToken: 'synthetic'},
    );
    const service = new MirrorService(
      registry,
      store,
      new NativeTransport(async url => {
        if (new URL(String(url)).pathname.endsWith('googleAds:search'))
          return Response.json(
            mutated && removed === 'absent'
              ? {}
              : {
                  results: [
                    {
                      campaign: {
                        resourceName: name,
                        name: 'Synthetic campaign',
                        status: mutated && removed === 'removed_row' ? 'REMOVED' : 'PAUSED',
                      },
                    },
                  ],
                  queryResourceConsumption: mutated ? '72' : '62',
                },
          );
        mutated = true;
        writes++;
        return Response.json({results: [{resourceName: name}]});
      }),
      undefined,
      {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
    );
    try {
      const p = await service.call(
        'amcp_write',
        {
          action: 'prepare',
          gateway,
          arguments: {
            action: 'google_ads_v23_campaign_mutate_campaigns',
            account_id: '123',
            payload: {operations: [{remove: name}]},
          },
        },
        actor,
      );
      assert.equal(p.success, true, JSON.stringify(p));
      assert.equal(
        (
          await service.call(
            'amcp_write',
            {
              action: 'execute',
              review_id: p.data.review_id,
              idempotency_key: p.data.idempotency_key,
              confirmed: true,
              spend_change_confirmed: true,
            },
            actor,
          )
        ).success,
        true,
      );
      const v = await service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
      assert.equal(v.data.status, removed === 'still_present' ? 'inconclusive' : 'verified', JSON.stringify(v));
      assert.equal(writes, 1);
    } finally {
      store.close();
    }
  });
for (const layout of layouts)
  test(layout.gateway + ' snapshot ignores qualified metadata and retains resource configuration', () => {
    const read = {...layout, accountId: '123'} as unknown as CompiledRequest;
    const resource = {
      name: 'Draft',
      status: 'PAUSED',
      budget: '100',
      bid: '2',
      schedule: {end: '2026-09-30'},
      targeting: {age: 30},
      etag: 'config-v1',
      orderedSteps: ['first', 'second'],
      futureConfiguration: 'initial',
    };
    const a = normalizeSnapshot(read, layout.wrap(resource, 1)),
      b = normalizeSnapshot(read, layout.wrap(resource, 2));
    assert.equal(reviewStateHash(a), reviewStateHash(b));
    assert.deepEqual(changedStateFields(a, b), []);
    for (const field of Object.keys(resource)) {
      const altered = field === 'orderedSteps' ? ['second', 'first'] : 'changed';
      const next = normalizeSnapshot(read, layout.wrap({...resource, [field]: altered}, 2));
      assert.notEqual(reviewStateHash(a), reviewStateHash(next), field);
      assert.ok(
        changedStateFields(a, next).some(p => p.includes(field)),
        field,
      );
    }
  });

test('Google result order is a resource set; nested configuration order, types and duplicates remain meaningful', () => {
  const read = {
    gateway,
    body: {
      query:
        "SELECT campaign.resource_name FROM campaign WHERE campaign.resource_name IN ('customers/123/campaigns/1', 'customers/123/campaigns/2')",
    },
  } as CompiledRequest;
  const rows = [1, 2].map(id => ({
    campaign: {resourceName: 'customers/123/campaigns/' + id, ordered: ['a', 'b'], labels: ['a', 'a']},
  }));
  const a = normalizeSnapshot(read, {results: rows, queryResourceConsumption: '50'});
  assert.equal(
    reviewStateHash(a),
    reviewStateHash(normalizeSnapshot(read, {results: [...rows].reverse(), queryResourceConsumption: '99'})),
  );
  for (const ordered of [
    ['b', 'a'],
    ['a', 'b', 'b'],
    [1, 'b'],
  ])
    assert.notEqual(
      reviewStateHash(a),
      reviewStateHash(normalizeSnapshot(read, {results: [{campaign: {...rows[0]!.campaign, ordered}}, rows[1]]})),
    );
  assert.throws(() => normalizeSnapshot(read, {results: [rows[0], rows[0]]}), {code: 'STATE_RESOURCE_INVALID'});
});

test('metadata projection cannot legitimize a paginated Microsoft state read', () => {
  const read = {
    gateway: 'microsoft_ads_native_action',
    action: 'GetCampaignsByIds',
    accountId: '123',
    body: {CampaignIds: ['1']},
    readOnly: true,
    method: 'POST',
    path: '/CampaignManagement/v13/Campaigns/QueryByIds',
    query: {},
  } as CompiledRequest;
  assert.throws(
    () =>
      validateState(read, {
        status: 200,
        headers: {},
        data: {Campaigns: [{Id: '1'}], PartialErrors: null, nextPageToken: 'unread'},
      }),
    {code: 'INCOMPLETE_STATE'},
  );
  assert.throws(
    () => validateState(read, {status: 200, headers: {}, data: {Campaigns: [{Id: '1'}], PartialErrors: [{Code: 1}]}}),
    {code: 'MICROSOFT_RESPONSE_FAILED'},
  );
  for (const field of ['Errors', 'OperationErrors', 'PartialErrors'])
    for (const invalid of [{Code: 1}, {}, 'unrecognized', false])
      assert.throws(
        () => validateState(read, {status: 200, headers: {}, data: {Campaigns: [{Id: '1'}], [field]: invalid}}),
        {code: 'MICROSOFT_RESPONSE_FAILED'},
      );
});

test('TikTok exact rows without an explicit native success code cannot become trusted state', () => {
  const read = {
    gateway: 'tiktok_native_action',
    action: 'AMCP_STATE_READ',
    accountId: '123',
    path: '/v1.3/advertiser/info/',
    method: 'GET',
    query: {},
    body: undefined,
  } as CompiledRequest;
  for (const code of [undefined, 1, '0'])
    assert.throws(
      () =>
        validateState(read, {
          status: 200,
          headers: {},
          data: {...(code === undefined ? {} : {code}), data: {list: [{advertiser_id: '123'}]}},
        }),
      {code: 'STATE_READ_FAILED'},
    );
  validateState(read, {status: 200, headers: {}, data: {code: 0, data: {list: [{advertiser_id: '123'}]}}});
});

test('Search Console accepts typed content counters but rejects malformed counts and API errors', () => {
  const read = {
    gateway: 'google_search_console_native_action',
    action: 'AMCP_STATE_READ',
    accountId: 'sc-domain:example.test',
    path: '/webmasters/v3/sites/sc-domain%3Aexample.test/sitemaps/https%3A%2F%2Fexample.test%2Fsitemap.xml',
    method: 'GET',
    query: {},
  } as CompiledRequest;
  const result = (errors: unknown) => ({
    status: 200,
    headers: {},
    data: {path: 'https://example.test/sitemap.xml', errors},
  });
  for (const errors of [0, 2, '0', '123']) validateState(read, result(errors));
  for (const errors of [{}, [], null, false, -1, 1.5, 'invalid', '1.5', {code: 403}])
    assert.throws(() => validateState(read, result(errors)), {code: 'STATE_READ_FAILED'});
  assert.throws(() => validateState(read, {...result(0), data: {...result(0).data, error: {code: 403}}}), {
    code: 'STATE_READ_FAILED',
  });
});

test('provider-specific continuation indicators are rejected before projection', () => {
  const cases: [string, JsonObject][] = [
    ['google_ads_native_action', {results: [], nextPageToken: 'next'}],
    ['meta_native_action', {id: '1', paging: {next: 'next', cursors: {after: 'cursor'}}}],
    ['tiktok_native_action', {code: 0, data: {list: [], page_info: {page: 1, total_page: 2}}}],
    [
      'snapchat_native_action',
      {request_status: 'SUCCESS', paging: {next_link: 'https://adsapi.snapchat.com/v1/campaigns/1?cursor=next'}},
    ],
    ['x_ads_native_action', {data: {id: '1'}, next_cursor: 'next'}],
    [
      'reddit_native_action',
      {data: {id: '1'}, pagination: {next_url: 'https://ads-api.reddit.com/api/v3/campaigns/1?page.token=next'}},
    ],
    ['linkedin_native_action', {id: 1, paging: {start: 0, count: 1, total: 2}}],
    ...[
      'dv360_native_action',
      'ga4_native_action',
      'gtm_native_action',
      'google_search_console_native_action',
      'apple_ads_native_action',
    ].map(g => [g, {id: '1', nextPageToken: 'next'}] as [string, JsonObject]),
  ];
  for (const [gateway, data] of cases) {
    const read = {
      gateway,
      action: 'AMCP_STATE_READ',
      accountId: '123',
      path: gateway === 'reddit_native_action' ? '/api/v3/campaigns/1' : '/v1/campaigns/1',
      query: {},
      method: 'GET',
    } as CompiledRequest;
    assert.throws(() => validateState(read, {status: 200, headers: {}, data}), {code: 'INCOMPLETE_STATE'}, gateway);
  }
});
