import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
const registry = new Registry();
function fixture(mode = 'normal') {
  const store = new Store(':memory:', Buffer.alloc(32, 42).toString('base64')),
    actor = {tenantId: 'audit', userId: 'reader', role: 'reader' as const};
  store.putConnection(
    {...actor, role: 'admin'},
    {
      id: 'c',
      tenantId: 'audit',
      gateway: 'google_ads_native_action',
      accounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const queries: string[] = [];
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport((async (url, init) => {
      assert.equal(new URL(String(url)).pathname, '/v25/customers/123/googleAds:search');
      const q = JSON.parse(String(init!.body)).query;
      queries.push(q);
      let data: unknown;
      if (q.includes('metrics.')) {
        assert.match(q, /campaign.id IN \(111\)/);
        const day = q.match(/BETWEEN '([0-9-]+)'/)![1];
        data =
          mode === 'malformed'
            ? {unexpected: []}
            : {
                results:
                  mode === 'empty'
                    ? []
                    : [
                        {
                          campaign: {id: mode === 'wrong-report' ? '999' : '111'},
                          customer: {currencyCode: 'USD'},
                          segments: {date: day},
                          metrics: {impressions: '1000', clicks: '20', costMicros: '5000000', conversions: '0'},
                        },
                      ],
              };
        if (mode === 'error') return new Response('{"error":{"message":"Synthetic denial"}}', {status: 403});
      } else {
        assert.match(q, /campaign.id = 111/);
        data = {
          results:
            mode === 'missing'
              ? []
              : [
                  {
                    campaign: {id: mode === 'wrong-campaign' ? '999' : '111', name: 'Draft', status: 'PAUSED'},
                    campaignBudget: {amountMicros: '2000000'},
                    customer: {currencyCode: 'USD'},
                  },
                ],
        };
      }
      return new Response(JSON.stringify(data));
    }) as typeof fetch),
  );
  return {store, actor, service, queries};
}
const args = {platform: 'google', account_id: '123', campaign_id: '111'};
test('campaign audit uses scoped native configuration and reporting reads and retains evidence and unknowns', async () => {
  const f = fixture();
  try {
    const result = await f.service.call(
      'amcp_native_action',
      {operation: 'audit_campaign', arguments: {...args, date_range: {since: '2026-08-01', until: '2026-08-02'}}},
      f.actor,
    );
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(f.queries.length, 2);
    const audit = result.data;
    assert.equal(audit.automated_changes, false);
    assert.equal(audit.findings.find((x: any) => x.check === 'budget').status, 'warning');
    assert.ok(audit.findings.find((x: any) => x.check === 'budget').evidence.length);
    assert.equal(audit.coverage.complete, false);
    assert.equal(audit.observed_metrics.spend, 5);
  } finally {
    f.store.close();
  }
});
test('optimization uses deterministic evidence and reports unavailable cross-campaign reallocation', async () => {
  const f = fixture();
  try {
    const call = {operation: 'get_optimization_suggestions', arguments: args},
      one = await f.service.call('amcp_native_action', call, f.actor),
      two = await f.service.call('amcp_native_action', call, f.actor);
    assert.equal(one.success, true, JSON.stringify(one));
    assert.deepEqual(one.data, two.data);
    assert.equal(one.data.ai_generated, false);
    assert.equal(one.data.automated_changes, false);
    assert.equal(one.data.budget_reallocation.available, false);
    assert.ok(one.data.suggestions.some((s: any) => s.id === 'zero_reported_conversions'));
    assert.equal(f.queries.length, 4);
  } finally {
    f.store.close();
  }
});
test('missing, malformed, failed and wrong-campaign responses cannot produce a successful audit', async () => {
  for (const mode of ['missing', 'malformed', 'error', 'wrong-report', 'wrong-campaign']) {
    const f = fixture(mode);
    try {
      const result = await f.service.call(
        'amcp_native_action',
        {operation: 'audit_campaign', arguments: {...args, date_range: {since: '2026-08-01', until: '2026-08-02'}}},
        f.actor,
      );
      assert.equal(result.success, false, mode);
      assert.ok(result.error.code);
      assert.ok(f.queries.length <= 2);
    } finally {
      f.store.close();
    }
  }
});
