import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {writeOutcome} from '../src/write-outcome.js';
import type {Actor, JsonObject, CompiledRequest} from '../src/types.js';
const registry = new Registry(),
  key = Buffer.alloc(32, 24).toString('base64'),
  actor: Actor = {tenantId: 'test', userId: 'writer', role: 'operator'},
  admin: Actor = {...actor, role: 'admin'},
  policy = {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true};
const snapRecord = (kind: string, id: string) => ({
  request_status: 'SUCCESS',
  [kind]: [
    {
      sub_request_status: 'SUCCESS',
      [kind === 'adsquads' ? 'adsquad' : kind.slice(0, -1)]: {id, status: 'PAUSED', name: 'Draft'},
    },
  ],
});
const li = 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns',
  google = 'google_ads_v23_campaign_mutate_campaigns';
const cases: {
  gateway: string;
  label: string;
  args: JsonObject;
  response: unknown;
  status?: number;
  headers?: Record<string, string>;
}[] = [
  {
    gateway: 'meta',
    label: 'create',
    args: {action: 'meta_campaign_create', payload: {name: 'Draft', status: 'PAUSED'}},
    response: {id: '111'},
  },
  {
    gateway: 'meta',
    label: 'update',
    args: {action: 'meta_campaign_update', path_params: {campaign_id: '111'}, payload: {name: 'Renamed'}},
    response: {success: true},
  },
  {
    gateway: 'meta',
    label: 'delete',
    args: {action: 'meta_campaign_delete', path_params: {campaign_id: '111'}},
    response: {success: true},
  },
  {
    gateway: 'tiktok',
    label: 'create',
    args: {
      action: 'tiktok_campaign_create',
      payload: {campaign_name: 'Draft', objective_type: 'TRAFFIC', operation_status: 'DISABLE'},
    },
    response: {code: 0, data: {campaign_id: '111'}},
  },
  {
    gateway: 'tiktok',
    label: 'update',
    args: {action: 'tiktok_campaign_update', payload: {campaign_id: '111', campaign_name: 'Renamed'}},
    response: {code: 0, data: {}},
  },
  {
    gateway: 'tiktok',
    label: 'delete',
    args: {action: 'tiktok_campaign_status_update', payload: {campaign_ids: ['111'], operation_status: 'DELETE'}},
    response: {code: 0, data: {}},
  },
  {
    gateway: 'snapchat',
    label: 'create',
    args: {
      action: 'snapchat_campaign_create',
      payload: {campaigns: [{name: 'Draft', ad_account_id: '123', status: 'PAUSED'}]},
    },
    response: snapRecord('campaigns', '111'),
  },
  {
    gateway: 'snapchat',
    label: 'replace',
    args: {
      action: 'snapchat_campaign_replace',
      payload: {
        campaigns: [
          {id: '111', name: 'Renamed', ad_account_id: '123', status: 'PAUSED', start_time: '2026-09-01T00:00:00Z'},
        ],
      },
    },
    response: snapRecord('campaigns', '111'),
  },
  {
    gateway: 'snapchat',
    label: 'patch',
    args: {
      action: 'snapchat_campaign_update',
      path_params: {campaign_id: '111'},
      payload: [{op: 'replace', path: '/name', value: 'Renamed'}],
    },
    response: snapRecord('campaigns', '111'),
  },
  {
    gateway: 'snapchat',
    label: 'delete',
    args: {action: 'snapchat_campaign_delete', path_params: {campaign_id: '111'}},
    response: {request_status: 'success', campaigns: []},
  },
  {
    gateway: 'google_ads',
    label: 'create',
    args: {
      action: google,
      payload: {operations: [{create: {name: 'Draft', status: 'PAUSED', advertising_channel_type: 'SEARCH'}}]},
    },
    response: {results: [{resourceName: 'customers/123/campaigns/111'}]},
  },
  {
    gateway: 'google_ads',
    label: 'update',
    args: {
      action: google,
      payload: {
        operations: [{update: {resource_name: 'customers/123/campaigns/111', name: 'Renamed'}, update_mask: 'name'}],
      },
    },
    response: {results: [{resourceName: 'customers/123/campaigns/111'}]},
  },
  {
    gateway: 'google_ads',
    label: 'delete',
    args: {action: google, payload: {operations: [{remove: 'customers/123/campaigns/111'}]}},
    response: {results: [{resourceName: 'customers/123/campaigns/111'}]},
  },
  {
    gateway: 'linkedin',
    label: 'create',
    args: {action: li + '_post', payload: {name: 'Draft', status: 'PAUSED', account: 'urn:li:sponsoredAccount:123'}},
    response: null,
    status: 201,
    headers: {'x-restli-id': '111'},
  },
  {
    gateway: 'linkedin',
    label: 'update',
    args: {
      action: li + '_campaign_id_post',
      path_params: {campaign_id: '111'},
      restli_method: 'PARTIAL_UPDATE',
      payload: {patch: {$set: {status: 'ACTIVE'}}},
    },
    response: null,
    status: 204,
  },
  {
    gateway: 'linkedin',
    label: 'delete',
    args: {action: li + '_campaign_id_delete', path_params: {campaign_id: '111'}},
    response: null,
    status: 204,
  },
  {
    gateway: 'x_ads',
    label: 'create',
    args: {action: 'x_accounts_account_id_campaigns_post', payload: {name: 'Draft', entity_status: 'PAUSED'}},
    response: {data: {id: '111'}},
  },
  {
    gateway: 'x_ads',
    label: 'update',
    args: {
      action: 'x_accounts_account_id_campaigns_campaign_id_put',
      path_params: {campaign_id: '111'},
      payload: {name: 'Renamed'},
    },
    response: {data: {id: '111'}},
  },
  {
    gateway: 'x_ads',
    label: 'delete',
    args: {action: 'x_accounts_account_id_campaigns_campaign_id_delete', path_params: {campaign_id: '111'}},
    response: {data: {id: '111', deleted: true}},
  },
  {
    gateway: 'dv360',
    label: 'create',
    args: {
      action: 'DV360_ADVERTISERS_CAMPAIGNS_CREATE',
      params: {advertiserId: '123'},
      body: {displayName: 'Draft', entityStatus: 'ENTITY_STATUS_PAUSED'},
    },
    response: {campaignId: '111'},
  },
  {
    gateway: 'dv360',
    label: 'update',
    args: {
      action: 'DV360_ADVERTISERS_CAMPAIGNS_PATCH',
      params: {advertiserId: '123', campaignId: '111', updateMask: 'displayName'},
      body: {displayName: 'Renamed'},
    },
    response: {campaignId: '111'},
  },
  {
    gateway: 'dv360',
    label: 'delete',
    args: {action: 'DV360_ADVERTISERS_CAMPAIGNS_DELETE', params: {advertiserId: '123', campaignId: '111'}},
    response: {},
  },
];
for (const c of cases)
  test(
    'reviewed ' + c.gateway + ' campaign ' + c.label + ' validates state and sends one native mutation',
    async () => {
      const gateway = c.gateway + '_native_action',
        store = new Store(':memory:', key),
        connection = {
          id: 'connection',
          tenantId: 'test',
          gateway,
          accounts: ['123'],
          writeAccounts: ['123'],
          enabled: true,
          label: 'Synthetic',
          scopes: [],
        };
      store.putConnection(admin, connection, {
        accessToken: 'synthetic',
        developerToken: 'synthetic',
        consumerKey: 'synthetic',
        consumerSecret: 'synthetic',
        tokenSecret: 'synthetic',
      });
      store.rememberResource(connection, '123', c.gateway === 'snapchat' ? 'campaigns/111' : '111');
      let writes = 0,
        reads = 0;
      const args = {...(c.gateway === 'dv360' ? {} : {account_id: '123'}), ...c.args};
      const service = new MirrorService(
        registry,
        store,
        new NativeTransport((async (input, init) => {
          const url = new URL(String(input)),
            p = url.pathname.replace('/open_api', ''),
            isRead = init!.method === 'GET' || p.endsWith('/googleAds:search');
          if (!isRead) {
            writes++;
            if (c.gateway === 'snapchat' && c.label === 'patch')
              assert.equal(new Headers(init!.headers).get('Content-Type'), 'application/json-patch+json');
            return new Response(c.response === null ? null : JSON.stringify(c.response), {
              status: c.status ?? 200,
              headers: c.headers,
            });
          }
          reads++;
          let d: unknown;
          const id = p.split('/').at(-1)!;
          if (c.gateway === 'meta')
            d = id === 'act_123' ? {id, account_status: 1, currency: 'USD'} : {id, name: 'Draft', status: 'PAUSED'};
          if (c.gateway === 'tiktok')
            d = {
              code: 0,
              data: {
                list: p.includes('/advertiser/')
                  ? [{advertiser_id: '123'}]
                  : [{campaign_id: '111', campaign_name: 'Draft', operation_status: 'DISABLE'}],
              },
            };
          if (c.gateway === 'snapchat') d = snapRecord(p.split('/').at(-2)!, id);
          if (c.gateway === 'google_ads')
            d = String(init!.body).includes('FROM customer')
              ? {results: [{customer: {id: '123', currencyCode: 'USD', timeZone: 'UTC'}}]}
              : {results: [{campaign: {resourceName: 'customers/123/campaigns/111', name: 'Draft', status: 'PAUSED'}}]};
          if (c.gateway === 'linkedin') d = {id: Number(id), name: 'Draft', status: 'PAUSED'};
          if (c.gateway === 'x_ads') d = {data: {id, name: 'Draft', entity_status: 'PAUSED'}};
          if (c.gateway === 'dv360')
            d = p.endsWith('/123')
              ? {advertiserId: '123', displayName: 'Account'}
              : {campaignId: '111', displayName: 'Draft', entityStatus: 'ENTITY_STATUS_PAUSED'};
          // This fixture varies telemetry only. The old invented target_labels field assumed
          // every scalar array was a set; ordered/unknown arrays have separate conflict tests.
          d = {
            ...(d as JsonObject),
            request_id: String(reads),
            updated_at: String(reads),
            delivery_status: reads % 2 ? ['A', 'B'] : ['B', 'A'],
            stats: {spend: reads},
          };
          if (['google_ads', 'tiktok', 'snapchat', 'x_ads'].includes(c.gateway))
            d = {
              ...(d as JsonObject),
              futureEnvelopeTelemetry: {cost: reads},
              ...(c.gateway === 'google_ads' ? {queryResourceConsumption: String(reads * 17)} : {}),
              ...(c.gateway === 'x_ads' ? {request: {params: {trace: String(reads)}}} : {}),
            };
          return new Response(JSON.stringify(d));
        }) as typeof fetch),
        undefined,
        policy,
      );
      try {
        const prepared = await service.call('amcp_write', {action: 'prepare', gateway, arguments: args}, actor);
        assert.equal(prepared.success, true, JSON.stringify(prepared));
        assert.equal(writes, 0);
        assert.ok(reads > 0);
        const r = prepared.data;
        const execute = {
          action: 'execute',
          review_id: r.review_id,
          idempotency_key: r.idempotency_key,
          confirmed: true,
          spend_change_confirmed: true,
        };
        const out = await service.call('amcp_write', execute, actor);
        assert.equal(out.success, true, JSON.stringify(out));
        assert.equal(writes, 1);
        assert.equal((await service.call('amcp_write', execute, actor)).data.replayed, true);
        assert.equal(writes, 1);
        const malformed = writeOutcome(
          {data: {unrelated: 'value'}, status: 200, headers: {}},
          r.request as CompiledRequest,
        );
        assert.equal(malformed.success, false);
      } finally {
        store.close();
      }
    },
  );

test('revocation, expiry or role changes during state verification prevent mutation egress', async () => {
  for (const change of ['revoke', 'expire', 'demote']) {
    const store = new Store(':memory:', key);
    try {
      store.putConnection(
        admin,
        {
          id: 'c',
          tenantId: 'test',
          gateway: 'meta_native_action',
          accounts: ['123'],
          writeAccounts: ['123'],
          enabled: true,
          label: 'Synthetic',
          scopes: [],
        },
        {accessToken: 'synthetic'},
      );
      const token = store.createKey(actor),
        authenticated = store.authenticate(token);
      let reads = 0,
        writes = 0;
      const service = new MirrorService(
        registry,
        store,
        new NativeTransport((async (_input, init) => {
          if (init!.method !== 'GET') {
            writes++;
            return new Response('{"id":"111"}');
          }
          if (++reads === 2) {
            if (change === 'revoke') store.revokeKey(token);
            else
              store.db.exec(
                change === 'expire' ? 'UPDATE api_keys SET expires_at=0' : "UPDATE api_keys SET role='reader'",
              );
          }
          return new Response('{"id":"act_123","currency":"USD","account_status":1}');
        }) as typeof fetch),
        undefined,
        policy,
      );
      const prepared = await service.call(
        'amcp_write',
        {action: 'prepare', gateway: 'meta_native_action', arguments: {account_id: '123', ...cases[0]!.args}},
        authenticated,
      );
      assert.equal(prepared.success, true);
      const r = prepared.data;
      const result = await service.call(
        'amcp_write',
        {action: 'execute', review_id: r.review_id, idempotency_key: r.idempotency_key, confirmed: true},
        authenticated,
      );
      assert.equal(result.error.code, 'UNAUTHORIZED');
      assert.equal(writes, 0);
    } finally {
      store.close();
    }
  }
});

test('Snapchat JSON Patch cannot change account scope or activate without spend confirmation', async () => {
  const store = new Store(':memory:', key),
    gateway = 'snapchat_native_action',
    connection = {
      id: 'c',
      tenantId: 'test',
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    };
  store.putConnection(admin, connection, {accessToken: 'synthetic'});
  store.rememberResource(connection, '123', 'campaigns/111');
  let calls = 0;
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport((async () => {
      calls++;
      return new Response(JSON.stringify(snapRecord('campaigns', '111')));
    }) as typeof fetch),
    undefined,
    policy,
  );
  try {
    const base = {
      action: 'prepare',
      gateway,
      arguments: {action: 'snapchat_campaign_update', account_id: '123', path_params: {campaign_id: '111'}},
    };
    for (const patch of [
      {op: 'replace', path: '/ad_account_id', value: '999'},
      {op: 'remove', path: '/ad_account_id'},
    ]) {
      const result = await service.call(
        'amcp_write',
        {...base, arguments: {...base.arguments, payload: [patch]}},
        actor,
      );
      assert.equal(result.error.code, 'ACCOUNT_SCOPE_MISMATCH');
    }
    assert.equal(calls, 0);
    const prepared = await service.call(
      'amcp_write',
      {...base, arguments: {...base.arguments, payload: [{op: 'replace', path: '/status', value: 'ACTIVE'}]}},
      actor,
    );
    assert.equal(prepared.success, true);
    const r = prepared.data;
    const denied = await service.call(
      'amcp_write',
      {action: 'execute', review_id: r.review_id, idempotency_key: r.idempotency_key, confirmed: true},
      actor,
    );
    assert.equal(denied.error.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal(calls, 1);
  } finally {
    store.close();
  }
});
