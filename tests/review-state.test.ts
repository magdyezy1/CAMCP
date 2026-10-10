import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeReviewState, reviewStateHash, changedStateFields} from '../src/review-state.js';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import type {Actor, JsonObject} from '../src/types.js';
const registry = new Registry(),
  actor: Actor = {tenantId: 't', userId: 'writer', role: 'operator'},
  admin: Actor = {...actor, role: 'admin'},
  policy = {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true};
const key = Buffer.alloc(32, 21).toString('base64');

test('state projection normalizes scalar sets across providers, preserves configuration and ordered object arrays', () => {
  const a = {
    nested: {country_codes: ['US', 'GB'], status: 'PAUSED'},
    delivery_status: ['A', 'B'],
    updatedAt: 'yesterday',
    metrics: {spend: 2},
    pacing: {pacingType: 'EVEN', dailyMaxMicros: '200'},
  };
  const b = {
    pacing: {dailyMaxMicros: '200', pacingType: 'EVEN'},
    metrics: {spend: 3},
    updatedAt: 'today',
    delivery_status: ['B', 'A', 'C'],
    nested: {status: 'PAUSED', country_codes: ['GB', 'US']},
  };
  assert.equal(reviewStateHash(a), reviewStateHash(b));
  for (const field of ['name', 'status', 'daily_budget_micro', 'schedule', 'targeting', 'bid', 'pacing']) {
    const x = {...a, [field]: 'old'},
      y = {...a, [field]: 'new'};
    assert.notEqual(reviewStateHash(x), reviewStateHash(y), field);
    assert.ok(changedStateFields(x, y).some(p => p.includes(field)));
  }
  assert.notEqual(reviewStateHash(['a', 'a', 'b']), reviewStateHash(['a', 'b']));
  assert.notEqual(reviewStateHash([1]), reviewStateHash(['1']));
  assert.notEqual(reviewStateHash([{id: '1'}, {id: '2'}]), reviewStateHash([{id: '2'}, {id: '1'}]));
  assert.deepEqual(normalizeReviewState({requestId: 'a', sub_request_status: 'SUCCESS', config: {status: 'PAUSED'}}), {
    config: {status: 'PAUSED'},
  });
});

for (const change of ['telemetry', 'budget', 'failure'])
  test('Snapchat child create: ' + change + ' with identical frozen read paths', async () => {
    const store = new Store(':memory:', key),
      gateway = 'snapchat_native_action',
      c = {
        id: 'c',
        tenantId: 't',
        gateway,
        accounts: ['123'],
        writeAccounts: ['123'],
        enabled: true,
        label: 'test',
        scopes: [],
      };
    store.putConnection(admin, c, {accessToken: 'synthetic'});
    store.rememberResource(c, '123', 'campaigns/111');
    let reads = 0,
      writes = 0;
    const paths: string[] = [];
    const service = new MirrorService(
      registry,
      store,
      new NativeTransport((async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (init?.method === 'GET') {
          paths.push(path);
          reads++;
          return Response.json({
            request_id: String(reads),
            request_status: change === 'failure' && reads > 1 ? 'ERROR' : 'SUCCESS',
            campaigns: [
              {
                sub_request_status: 'SUCCESS',
                campaign: {
                  id: '111',
                  name: 'Draft',
                  status: 'PAUSED',
                  daily_budget_micro: change === 'budget' && reads > 1 ? '200' : '100',
                  delivery_status: reads === 1 ? ['A', 'B', 'C'] : ['C', 'A', 'B'],
                  updated_at: String(reads),
                  stats: {spend: reads},
                  targeting: {countries: reads === 1 ? ['US', 'GB'] : ['GB', 'US']},
                },
              },
            ],
          });
        }
        writes++;
        return Response.json({
          request_status: 'SUCCESS',
          adsquads: [{sub_request_status: 'SUCCESS', adsquad: {id: '222', campaign_id: '111', ad_account_id: '123'}}],
        });
      }) as typeof fetch),
      undefined,
      policy,
    );
    try {
      const prepared = await service.call(
        'amcp_write',
        {
          action: 'prepare',
          gateway,
          arguments: {
            action: 'snapchat_campaigns_campaign_id_adsquads_create',
            account_id: '123',
            path_params: {campaign_id: '111'},
            payload: {adsquads: [{name: 'Draft', status: 'PAUSED', campaign_id: '111'}]},
          },
        },
        actor,
      );
      assert.equal(prepared.success, true, JSON.stringify(prepared));
      const r = prepared.data;
      assert.match(r.state_hash, /^[a-f0-9]{64}$/);
      const out = await service.call(
        'amcp_write',
        {action: 'execute', review_id: r.review_id, idempotency_key: r.idempotency_key, confirmed: true},
        actor,
      );
      assert.deepEqual(paths, ['/v1/campaigns/111', '/v1/campaigns/111']);
      if (change === 'telemetry') {
        assert.equal(out.success, true, JSON.stringify(out));
        assert.equal(writes, 1);
        assert.ok(store.ownsResource(c, '123', 'adsquads/222'));
      } else {
        assert.equal(out.success, false);
        assert.equal(writes, 0);
        if (change === 'budget') {
          assert.equal(out.error.code, 'STATE_CHANGED');
          assert.equal(out.error.details.expected_state_hash, r.state_hash);
          assert.notEqual(out.error.details.actual_state_hash, r.state_hash);
          assert.deepEqual(out.error.details.changed_fields, [
            '$[0]["campaigns"][0]["campaign"]["daily_budget_micro"]',
          ]);
        }
      }
    } finally {
      store.close();
    }
  });

for (const platform of ['meta', 'snapchat'])
  test(
    platform + ' successful campaign create immediately authorizes child prepare, only for its owning connection',
    async () => {
      const store = new Store(':memory:', key),
        gateway = platform + '_native_action',
        c = {
          id: 'c',
          tenantId: 't',
          gateway,
          accounts: ['123'],
          writeAccounts: ['123'],
          enabled: true,
          label: 'test',
          scopes: [],
        };
      store.putConnection(admin, c, {accessToken: 'synthetic'});
      const service = new MirrorService(
        registry,
        store,
        new NativeTransport((async (input, init) => {
          const p = new URL(String(input)).pathname;
          if (platform === 'meta')
            return Response.json(
              init?.method === 'GET'
                ? p.endsWith('/111')
                  ? {id: '111', name: 'Draft', status: 'PAUSED'}
                  : {id: 'act_123', currency: 'USD', account_status: 1}
                : {id: '111'},
            );
          const kind = init?.method === 'GET' ? p.split('/').at(-2)! : 'campaigns',
            id = init?.method === 'GET' ? p.split('/').at(-1)! : '111';
          return Response.json({
            request_status: 'SUCCESS',
            [kind]: [{sub_request_status: 'SUCCESS', [kind.slice(0, -1)]: {id, name: 'Draft', status: 'PAUSED'}}],
          });
        }) as typeof fetch),
        undefined,
        policy,
      );
      try {
        const payload =
          platform === 'meta'
            ? // From Graph API v24.0 a campaign without its own budget states the budget-sharing choice (CMP-01).
              {name: 'Draft', status: 'PAUSED', is_adset_budget_sharing_enabled: false}
            : {campaigns: [{name: 'Draft', status: 'PAUSED', ad_account_id: '123'}]};
        const first = await service.call(
          'amcp_write',
          {action: 'prepare', gateway, arguments: {action: platform + '_campaign_create', account_id: '123', payload}},
          actor,
        );
        assert.equal(first.success, true, JSON.stringify(first));
        const r = first.data,
          out = await service.call(
            'amcp_write',
            {action: 'execute', review_id: r.review_id, idempotency_key: r.idempotency_key, confirmed: true},
            actor,
          );
        assert.equal(out.success, true, JSON.stringify(out));
        const resource = platform === 'meta' ? '111' : 'campaigns/111';
        assert.ok(store.ownsResource(c, '123', resource));
        assert.equal(store.ownsResource({...c, id: 'different'}, '123', resource), false);
        assert.equal(store.ownsResource(c, '999', resource), false);
        const args: JsonObject =
          platform === 'meta'
            ? {
                action: 'meta_adset_create',
                account_id: '123',
                payload: {name: 'Child', status: 'PAUSED', campaign_id: '111'},
              }
            : {
                action: 'snapchat_campaigns_campaign_id_adsquads_create',
                account_id: '123',
                path_params: {campaign_id: '111'},
                payload: {adsquads: [{name: 'Child', status: 'PAUSED', campaign_id: '111'}]},
              };
        const child = await service.call('amcp_write', {action: 'prepare', gateway, arguments: args}, actor);
        assert.equal(child.success, true, JSON.stringify(child));
      } finally {
        store.close();
      }
    },
  );
