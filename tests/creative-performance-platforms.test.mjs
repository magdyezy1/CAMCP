import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {creativePerformanceCases, seedCreativePerformance} from './fixtures/creative-performance-data.mjs';
const actor = {tenantId: 'linked-performance-fixture', userId: 'operator', role: 'operator'};
test('an unsafe numeric retained ad receipt cannot acquire another exact TikTok report identity', async () => {
  const f = fixture(creativePerformanceCases.find(spec => spec.platform === 'tiktok'));
  try {
    const unsafe = Number('9007199254740993');
    assert.equal(String(unsafe), '9007199254740992');
    f.steps[1].verification.verified_resources[0].resource_id = unsafe;
    f.put('campaign_run', f.planId, {user_id: actor.userId, steps: f.steps});
    f.report.rows = [{...f.report.rows[0], entity_id: '9007199254740992'}];
    f.put('decision_report', f.reportId, f.report);
    const detail = await f.call({action: 'asset', asset_id: f.assetId});
    assert.equal(detail.success, true, JSON.stringify(detail));
    assert.equal(detail.data.usage[0].linked_performance_available, false);
    assert.deepEqual(detail.data.usage[0].steps.find(step => step.step_id === 'ad').resource_ids, []);
    const out = await f.call(f.args);
    assert.equal(out.success, false, JSON.stringify(out));
    assert.equal(out.error.code, 'CREATIVE_USAGE_REQUIRED');
    assert.equal(f.requests(), 0);
  } finally {
    f.store.close();
  }
});
test('real HTTP MCP SDK exposes exact linked performance for all three providers and refuses a revoked key', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 84).toString('base64'));
  const datasets = creativePerformanceCases.map(spec => ({spec, ...seedCreativePerformance(store, actor, spec)}));
  let requests = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      requests++;
      throw Error('No provider call allowed');
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const token = store.createKey(actor);
  const listener = await listenForFetch(createHttpApp(service, store));
  const client = new Client({name: 'linked-performance-fixture', version: '1'});
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + listener.address().port + '/mcp'), {
        requestInit: {headers: {Authorization: 'Bearer ' + token}},
      }),
    );
    const advertised = (await client.listTools()).tools.find(tool => tool.name === 'amcp_media');
    assert.ok(advertised.inputSchema.properties.action.enum.includes('asset_performance'));
    const call = async args =>
      JSON.parse(
        (await client.callTool({name: 'amcp_media', arguments: args})).content.find(item => item.type === 'text').text,
      );
    for (const {spec, assetId, planId, reportId, report} of datasets) {
      const choices = await call({action: 'asset_performance', asset_id: assetId});
      assert.equal(choices.success, true, JSON.stringify(choices));
      assert.deepEqual(
        choices.data.reports.map(item => item.id),
        [reportId],
      );
      const out = await call({action: 'asset_performance', asset_id: assetId, plan_id: planId, report_id: reportId});
      assert.equal(out.success, true, JSON.stringify(out));
      assert.deepEqual(out.data.matched_ad_ids, [spec.ad]);
      assert.equal(out.data.grain, spec.grain);
      assert.equal(out.data.source_hash, report.source_hash);
      assert.equal(out.data.rows[0].impressions, '9007199254740993');
      assert.equal(out.data.rows[0].conversions, null);
      assert.equal(out.data.rows[1].conversions, '0');
      assert.equal(out.data.network_requests, 0);
    }
    store.revokeKey(token);
    await assert.rejects(
      client.callTool({
        name: 'amcp_media',
        arguments: {
          action: 'asset_performance',
          asset_id: datasets[0].assetId,
        },
      }),
    );
    assert.equal(requests, 0);
  } finally {
    await client.close();
    await new Promise(done => listener.close(done));
    store.close();
  }
});
function fixture(spec) {
  const store = new Store(':memory:', Buffer.alloc(32, 83).toString('base64'));
  const data = seedCreativePerformance(store, actor, spec);
  let requests = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      requests++;
      throw Error('No provider call allowed');
    }),
  );
  const args = {action: 'asset_performance', asset_id: data.assetId, plan_id: data.planId, report_id: data.reportId};
  return {
    ...data,
    store,
    args,
    requests: () => requests,
    call: (input, as = actor) => service.call('amcp_media', input, as),
  };
}
for (const spec of creativePerformanceCases) {
  test(
    spec.platform + ' linked performance keeps exact verified ad identity, values and source definitions',
    async () => {
      const f = fixture(spec);
      try {
        const detail = await f.call({action: 'asset', asset_id: f.assetId});
        assert.equal(detail.success, true, JSON.stringify(detail));
        assert.equal(detail.data.linked_performance_supported, true);
        assert.equal(detail.data.usage[0].linked_performance_available, true);
        const choices = await f.call({action: 'asset_performance', asset_id: f.assetId});
        assert.equal(choices.success, true, JSON.stringify(choices));
        assert.deepEqual(
          choices.data.reports.map(r => r.id),
          [f.reportId],
        );
        assert.ok(!('rows' in choices.data.reports[0]));
        const out = await f.call(f.args);
        assert.equal(out.success, true, JSON.stringify(out));
        assert.deepEqual(
          out.data.rows.map(r => r.entity_id),
          [spec.ad, spec.ad],
        );
        assert.equal(out.data.rows[0].spend, '12.500001');
        assert.equal(out.data.rows[0].impressions, '9007199254740993');
        assert.equal(out.data.rows[0].conversions, null);
        assert.equal(out.data.rows[1].spend, '0');
        assert.equal(out.data.rows[1].conversions, '0');
        assert.deepEqual(out.data.matched_ad_ids, [spec.ad]);
        assert.deepEqual(out.data.semantics, f.report.semantics);
        assert.equal(out.data.source_hash, f.report.source_hash);
        assert.equal(out.data.grain, spec.grain);
        assert.equal(out.data.network_requests, 0);
        assert.equal(out.data.historical_creative_assignment, 'not_established');
        assert.equal(f.requests(), 0);
      } finally {
        f.store.close();
      }
    },
  );
  test(
    spec.platform + ' refuses foreign source scope, unsupported grain and unverified or unrelated plan references',
    async () => {
      const f = fixture(spec);
      try {
        for (const change of [
          {account_id: '999'},
          {connection_id: 'foreign'},
          {gateway: 'meta_native_action'},
          {preset: spec.platform + '_campaign'},
          {grain: 'campaign × day'},
          {source: 'manual'},
        ]) {
          f.put('decision_report', f.reportId, {...f.report, ...change});
          assert.equal((await f.call(f.args)).success, false, JSON.stringify(change));
        }
        f.put('decision_report', f.reportId, f.report);
        for (const steps of [
          f.steps.map(s => (s.id === 'ad' ? {...s, status: 'uncertain'} : s)),
          f.steps.map(s => (s.id === 'ad' ? {...s, arguments: {action: spec.action}, depends_on: ['upload']} : s)),
          f.steps.map(s => (s.id === 'ad' ? {...s, arguments: {...s.arguments, action: 'unknown_ad_create'}} : s)),
        ]) {
          f.put('campaign_run', f.planId, {user_id: actor.userId, name: 'Changed synthetic plan', steps});
          assert.equal((await f.call(f.args)).success, false);
        }
        assert.equal(f.requests(), 0);
      } finally {
        f.store.close();
      }
    },
  );
  test(spec.platform + ' pages exact daily rows and metadata with current identity and account access', async () => {
    const f = fixture(spec);
    try {
      for (let i = 0; i < 12; i++) f.put('decision_report', 'a-' + String(i).padStart(2, '0'), f.report);
      const scope = {action: 'asset_performance', asset_id: f.assetId, limit: 5};
      const first = await f.call(scope);
      assert.equal(first.success, true, JSON.stringify(first));
      assert.equal(first.data.reports.length, 5);
      const next = await f.call({...scope, cursor: first.data.next_cursor});
      assert.equal(next.success, true, JSON.stringify(next));
      assert.notEqual(next.data.reports[0].id, first.data.reports[0].id);
      assert.equal(
        (await f.call({...scope, cursor: first.data.next_cursor}, {...actor, userId: 'colleague'})).success,
        false,
      );
      const joined = await f.call({...f.args, limit: 1});
      assert.equal(joined.success, true, JSON.stringify(joined));
      assert.equal(joined.data.next_offset, 1);
      assert.equal((await f.call({...f.args, limit: 1, offset: 1})).data.rows[0].spend, '0');
      f.store.putConnection(
        {...actor, role: 'admin'},
        {
          ...f.connection,
          accounts: [spec.platform === 'snapchat' ? '44444444-4444-4444-4444-444444444444' : '900'],
          writeAccounts: [],
        },
        {accessToken: 'synthetic'},
      );
      assert.equal((await f.call({...scope, cursor: first.data.next_cursor})).success, false);
      assert.equal((await f.call(f.args)).success, false);
      assert.equal(f.requests(), 0);
    } finally {
      f.store.close();
    }
  });
}
