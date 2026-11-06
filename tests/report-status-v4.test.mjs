import test from 'node:test';
import assert from 'node:assert/strict';
import {reportSource} from '../dist/src/report-sources.js';
import {normalizeNativeRow, normalizeNativeRowV4} from '../dist/src/report-native.js';
import {estimateCollectionRequests} from '../dist/src/report-request-estimate.js';
import {detailParents} from '../dist/src/overview-parents.js';
import {overviewGranularityFixture, granularConfig, granularSource} from './fixtures/overview-granularity-data.mjs';

test('provider status hooks map configured states and keep effective delivery separate', () => {
  for (const [platform, raw, context, status, configured] of [
    ['google', {campaign: {status: 'ENABLED'}}, {level: 'campaign'}, 'active', 'ENABLED'],
    ['google', {adGroup: {status: 'PAUSED'}, campaign: {status: 'ENABLED'}}, {level: 'adset'}, 'paused', 'PAUSED'],
    ['google', {adGroupAd: {status: 'REMOVED'}, adGroup: {status: 'ENABLED'}}, {level: 'ad'}, 'archived', 'REMOVED'],
    ['google', {campaign: {status: 'FUTURE_ENUM'}}, {level: 'campaign'}, 'unknown', 'FUTURE_ENUM'],
    [
      'tiktok',
      {entity_metadata: {operation_status: 'ENABLE', secondary_status: 'AD_STATUS_CAMPAIGN_DISABLE'}},
      {level: 'ad'},
      'active',
      'ENABLE',
    ],
    ['tiktok', {}, {level: 'adset', metadata: {operation_status: 'DISABLE'}}, 'paused', 'DISABLE'],
    [
      'tiktok',
      {entity_metadata: {operation_status: 'ENABLE', secondary_status: 'CAMPAIGN_STATUS_DELETE'}},
      {level: 'campaign'},
      'archived',
      'ENABLE',
    ],
    [
      'tiktok',
      {entity_metadata: {operation_status: 'ENABLE', secondary_status: 'AD_STATUS_ADGROUP_DELETE'}},
      {level: 'ad'},
      'active',
      'ENABLE',
    ],
    ['tiktok', {operation_status: 'ENABLE'}, {level: 'campaign'}, 'unknown', null],
    [
      'meta',
      {entity_metadata: {configured_status: 'ACTIVE', effective_status: 'PENDING_REVIEW'}},
      {level: 'ad'},
      'active',
      'ACTIVE',
    ],
    ['meta', {}, {level: 'adset', metadata: {status: 'PAUSED'}}, 'paused', 'PAUSED'],
    [
      'reddit',
      {entity_metadata: {configured_status: 'ARCHIVED', effective_status: 'DELETED'}},
      {level: 'campaign'},
      'archived',
      'ARCHIVED',
    ],
    ['reddit', {entity_metadata: {effective_status: 'ACTIVE'}}, {level: 'ad'}, 'unknown', null],
    ['linkedin', {entity_metadata: {status: 'ACTIVE'}}, {level: 'campaign'}, 'active', 'ACTIVE'],
    ['linkedin', {}, {level: 'ad', metadata: {status: 'PAUSED'}}, 'paused', 'PAUSED'],
    ['linkedin', {}, {level: 'adset', metadata: {status: 'DRAFT'}}, 'unknown', 'DRAFT'],
    [
      'snapchat',
      {entity_metadata: {status: 'PAUSED', delivery_status: ['INVALID_NOT_ACTIVE']}},
      {level: 'adset'},
      'paused',
      'PAUSED',
    ],
    [
      'microsoft',
      {CampaignStatus: 'Active', AdGroupStatus: 'Paused', AdStatus: 'Deleted'},
      {level: 'adset'},
      'paused',
      'Paused',
    ],
    ['microsoft', {CampaignStatus: 'Active', AdStatus: 'Deleted'}, {level: 'ad'}, 'archived', 'Deleted'],
    ['microsoft', {CampaignStatus: 'BudgetPaused'}, {level: 'campaign'}, 'unknown', 'BudgetPaused'],
    [
      'apple',
      {entity_metadata: {status: 'ENABLED', systemStatus: 'NOT_RUNNING'}},
      {level: 'campaign'},
      'active',
      'ENABLED',
    ],
    [
      'apple',
      {},
      {level: 'ad', metadata: {status: 'PAUSED', displayStatus: 'DELETED', deleted: true}},
      'archived',
      'PAUSED',
    ],
    ['apple', {metadata: {status: 'RUNNING'}}, {level: 'campaign'}, 'unknown', null],
    [
      'x',
      {entity_metadata: {entity_status: 'PAUSED', effective_status: 'ACTIVE'}},
      {level: 'campaign'},
      'paused',
      'PAUSED',
    ],
    ['x', {entity_metadata: {entity_status: 'ACTIVE', deleted: true}}, {level: 'campaign'}, 'archived', 'ACTIVE'],
    ['x', {entity_metadata: {entity_status: 'DRAFT'}}, {level: 'campaign'}, 'unknown', 'DRAFT'],
  ]) {
    const read = reportSource(platform).readStatus;
    assert.equal(typeof read, 'function', platform);
    const evidence = read(raw, context);
    assert.equal(evidence.status, status, JSON.stringify({platform, raw, context}));
    assert.equal(evidence.native_status, configured);
  }
  const read = reportSource('tiktok').readStatus;
  assert.equal(
    read({entity_metadata: {operation_status: 'ENABLE', secondary_status: 'AD_STATUS_CAMPAIGN_DISABLE'}}, {level: 'ad'})
      .effective_status,
    'AD_STATUS_CAMPAIGN_DISABLE',
  );
});

async function run(f, source, include = {}, changes = {}) {
  const queued = await f.overview.handle(
    {
      action: 'run',
      confirmed: true,
      config: {...granularConfig(source), ...changes, contract_version: 'overview-config-v4'},
    },
    f.actor,
  );
  await f.worker.once();
  return f.overview.handle({action: 'get', id: queued.id, include}, f.actor);
}

test('Meta status is read from bounded account-owned metadata for campaign, ad set and ad rows', async t => {
  for (const level of ['campaign', 'adset', 'ad']) {
    const f = overviewGranularityFixture();
    t.after(() => f.close());
    f.parents((platform, _url, body) =>
      platform === 'meta'
        ? {
            ...body,
            data: body.data.map(row => ({...row, configured_status: 'PAUSED', effective_status: 'PENDING_REVIEW'})),
          }
        : body,
    );
    const snapshot = await run(
      f,
      {...granularSource('meta', level), levels: [level], statuses: ['paused']},
      {native: true},
      {date_range: {since: '2026-09-01', until: '2026-09-01'}},
    );
    assert.equal(snapshot.state, 'complete', JSON.stringify(snapshot.sources));
    assert.equal(snapshot.rows.length, 1);
    assert.equal(snapshot.rows[0].status, 'paused');
    assert.equal(snapshot.rows[0].native.status_evidence.effective_status, 'PENDING_REVIEW');
    assert.equal(snapshot.sources[0].scope.excluded_unknown_rows, 0);
    assert.ok(f.requests.some(request => /\/act_100\/(campaigns|adsets|ads)$/.test(request.url.pathname)));
    assert.ok(estimateCollectionRequests(snapshot.config).estimated_requests >= f.requests.length);
  }
});

test('Meta metadata follows a bounded cursor without fetching provider-supplied URLs', async t => {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  f.parents((platform, url, body) => {
    if (platform !== 'meta') return body;
    if (url.searchParams.has('after')) {
      assert.equal(url.searchParams.get('after'), 'synthetic-cursor');
      return body;
    }
    return {
      data: Array.from({length: 500}, (_, index) => ({
        id: String(10000 + index),
        account_id: '100',
        configured_status: 'ACTIVE',
      })),
      paging: {cursors: {after: 'synthetic-cursor'}, next: 'https://untrusted.invalid/never-followed'},
    };
  });
  const snapshot = await run(f, {...granularSource('meta'), levels: ['ad'], statuses: ['active']});
  assert.equal(snapshot.state, 'complete', JSON.stringify(snapshot.sources));
  assert.equal(snapshot.rows.length, 1);
  const metadata = f.requests.filter(request => request.url.pathname.endsWith('/act_100/ads'));
  assert.equal(metadata.length, 2);
  assert.ok(metadata.every(request => request.url.hostname === 'graph.facebook.com'));
});

test('optional metadata refusal preserves unknown scope while auth, server and foreign-account failures refuse the source', async t => {
  for (const scenario of ['refused', 'unauthorized', 'reauthorize', 'server', 'foreign']) {
    const f = overviewGranularityFixture();
    t.after(() => f.close());
    f.parents((platform, _url, body) => {
      if (platform !== 'meta') return body;
      if (scenario === 'foreign') return {...body, data: body.data.map(row => ({...row, account_id: '999'}))};
      return Response.json(
        {
          error: {
            message: 'Synthetic metadata refusal',
            code: ['unauthorized', 'reauthorize'].includes(scenario) ? 190 : 100,
          },
        },
        {
          status: {refused: 400, unauthorized: 401, reauthorize: 400, server: 500}[scenario],
        },
      );
    });
    const snapshot = await run(f, {...granularSource('meta'), levels: ['ad'], statuses: ['active']});
    assert.equal(
      snapshot.state,
      scenario === 'refused' ? 'partial' : scenario === 'server' ? 'running' : 'failed',
      JSON.stringify({scenario, sources: snapshot.sources}),
    );
    if (scenario === 'refused') {
      assert.equal(snapshot.source_row_count, 1);
      assert.equal(snapshot.row_count, 0);
      assert.equal(snapshot.empty_reason, 'scope_filter');
      assert.equal(snapshot.sources[0].scope.excluded_unknown_rows, 1);
    } else {
      assert.ok(snapshot.sources[0].error);
      if (scenario === 'server') {
        assert.equal(snapshot.sources[0].error.retryable, true);
        assert.equal(snapshot.job.state, 'queued');
      }
    }
  }
});

test('a refused optional metadata read rechecks the login before retaining unknown status', async t => {
  const f = overviewGranularityFixture(),
    source = {...granularSource('meta', 'ad'), reporting_contract: 'overview-config-v4'},
    connection = f.store.resolveConnection(f.actor, 'meta_native_action', source.account_id, source.connection_id);
  t.after(() => f.close());
  f.parents((platform, _url, body) => {
    if (platform !== 'meta') return body;
    f.store.putConnection(f.actor, connection, {accessToken: 'synthetic-replacement'});
    return Response.json({error: {message: 'Synthetic metadata refusal', code: 100}}, {status: 400});
  });
  await assert.rejects(detailParents(f.service, source, 'ad', ['9007199254740993'], f.actor), {
    code: 'CONNECTION_AUTHORITY_CHANGED',
  });
});

test('Snapchat ad squad and ad statuses come from the child record, with owned parents retained', async t => {
  for (const level of ['adset', 'ad']) {
    const f = overviewGranularityFixture();
    t.after(() => f.close());
    f.parents((platform, _url, body) => {
      if (platform !== 'snapchat' || !(body.ads || body.adsquads || body.campaigns)) return body;
      const key = body.ads ? 'ads' : body.adsquads ? 'adsquads' : 'campaigns',
        singular = {ads: 'ad', adsquads: 'adsquad', campaigns: 'campaign'}[key];
      return {...body, [key]: body[key].map(entry => ({...entry, [singular]: {...entry[singular], status: 'PAUSED'}}))};
    });
    const snapshot = await run(f, {...granularSource('snapchat', level), levels: [level], statuses: ['paused']});
    assert.equal(snapshot.state, 'complete', JSON.stringify(snapshot.sources));
    assert.equal(snapshot.rows.length, 1);
    assert.equal(snapshot.rows[0].status, 'paused');
    assert.ok(snapshot.rows[0].parents.campaign.id);
    assert.ok(
      estimateCollectionRequests(snapshot.config).estimated_requests >= f.requests.length,
      JSON.stringify({
        level,
        estimate: estimateCollectionRequests(snapshot.config),
        requests: f.requests.map(request => [request.method, request.url.pathname]),
      }),
    );
  }
});

test('LinkedIn current statuses survive group, campaign and creative metadata projection', async t => {
  for (const level of ['campaign', 'adset', 'ad']) {
    const f = overviewGranularityFixture();
    t.after(() => f.close());
    f.parents((platform, _url, body) =>
      platform === 'linkedin' && body.elements
        ? {...body, elements: body.elements.map(row => ({...row, status: 'PAUSED'}))}
        : body,
    );
    const snapshot = await run(f, {...granularSource('linkedin', level), levels: [level], statuses: ['paused']});
    assert.equal(snapshot.state, 'complete', JSON.stringify(snapshot.sources));
    assert.equal(snapshot.rows.length, 1);
    assert.equal(snapshot.rows[0].status, 'paused');
    assert.equal(snapshot.sources[0].scope.excluded_unknown_rows, 0);
    assert.ok(estimateCollectionRequests(snapshot.config).estimated_requests >= f.requests.length);
  }
});

test('LinkedIn estimates count every native metric fragment and its account-owned metadata', async t => {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  const snapshot = await run(f, {
    ...granularSource('linkedin', 'campaign'),
    levels: ['campaign'],
    native_metrics: ['videoCompletions', 'videoStarts', 'companyPageClicks', 'follows', 'likes', 'shares', 'comments'],
  });
  assert.equal(snapshot.state, 'complete', JSON.stringify(snapshot.sources));
  assert.equal(f.requests.filter(request => request.url.pathname === '/rest/adAnalytics').length, 4);
  assert.ok(estimateCollectionRequests(snapshot.config).estimated_requests >= f.requests.length);
});

test('proven TikTok optional body refusal stays unknown; every other body failure is not suppressed', async t => {
  // TikTok's return-code table (read 2026-11-06) maps 40001 to a role or asset access denial, the one body refusal of
  // this optional read that was proven. A code it does not map fails the source as before; a credential or access code
  // that is not the proven one fails it with its class; a transient code is retried as a read, never read as a refusal.
  // A consent refusal (40125) carries status 403, so it is a provider refusal of an optional read like any HTTP 403.
  for (const [code, state, errorCode] of [
    [40001, 'partial'],
    [40125, 'partial'],
    [40002, 'failed', 'PLATFORM_ERROR'],
    [999999, 'failed', 'PLATFORM_ERROR'],
    [40105, 'failed', 'AUTH_EXPIRED'],
    [40119, 'failed', 'PROVIDER_ACCESS_DENIED'],
    [40118, 'failed', 'PROVIDER_ACCESS_DENIED'],
    [40100, 'running', 'PLATFORM_RATE_LIMIT'],
    [50000, 'running', 'PLATFORM_ERROR'],
  ]) {
    const f = overviewGranularityFixture();
    t.after(() => f.close());
    f.parents((platform, url, body) =>
      platform === 'tiktok' && url.pathname.endsWith('/ad/get/') ? {code, message: 'Synthetic metadata refusal'} : body,
    );
    const snapshot = await run(f, {...granularSource('tiktok'), levels: ['ad'], statuses: ['active']});
    assert.equal(snapshot.state, state, code + ' ' + JSON.stringify(snapshot.sources));
    if (state === 'partial') assert.equal(snapshot.sources[0].scope.excluded_unknown_rows, 1);
    else {
      assert.equal(snapshot.sources[0].error.code, errorCode, String(code));
      assert.equal(snapshot.sources[0].error.provider.code, String(code));
    }
  }
});

test('campaign status comes from native metadata only in the v4 normalized form', () => {
  const raw = {
    campaign: {id: '42', status: 'PAUSED'},
    metrics: {costMicros: '1', impressions: '1'},
    entity_metadata: {daily_budget: '10'},
  };
  assert.equal(normalizeNativeRow('google', raw).status, undefined);
  const current = normalizeNativeRowV4('google', raw);
  assert.equal(current.status, 'paused');
  assert.equal(current.native.status_evidence.native_status, 'PAUSED');
  assert.equal(
    current.metrics.native_google_entity_metadata_daily_budget,
    undefined,
    'metadata is never invented as a performance metric',
  );
});

test('real Google detail requests retain their own status rather than inheriting the campaign state', async t => {
  for (const level of ['adset', 'ad']) {
    const f = overviewGranularityFixture();
    t.after(() => f.close());
    f.mutate((rows, platform) =>
      platform === 'google'
        ? rows.map(row => ({
            ...row,
            campaign: {...row.campaign, status: 'ENABLED'},
            adGroup: {...row.adGroup, status: 'PAUSED'},
            adGroupAd: {...row.adGroupAd, status: 'REMOVED'},
          }))
        : rows,
    );
    const source = {
        ...granularSource('google', level),
        levels: [level],
        statuses: [level === 'ad' ? 'archived' : 'paused'],
      },
      queued = await f.overview.handle(
        {action: 'run', confirmed: true, config: {...granularConfig(source), contract_version: 'overview-config-v4'}},
        f.actor,
      );
    await f.worker.once();
    const snapshot = await f.overview.handle({action: 'get', id: queued.id, include: {native: true}}, f.actor);
    assert.equal(snapshot.state, 'complete', JSON.stringify(snapshot.sources));
    assert.equal(snapshot.rows.length, 1);
    assert.equal(snapshot.rows[0].status, level === 'ad' ? 'archived' : 'paused');
    assert.equal(snapshot.sources[0].scope.excluded_unknown_rows, 0);
    assert.equal(snapshot.sources[0].scope.status_basis, 'current_configuration');
    assert.equal(snapshot.rows[0].parent_ids.entity_metadata, undefined);
    assert.ok(
      f.requests.some(request =>
        request.body?.query?.includes(level === 'ad' ? 'ad_group_ad.status' : 'ad_group.status'),
      ),
      'the native GAQL request selects the status of the requested entity level',
    );
  }
});

test('native collection retains positive delivery below the retained metric precision at every level', async t => {
  for (const level of ['campaign', 'adset', 'ad']) {
    const f = overviewGranularityFixture();
    t.after(() => f.close());
    f.mutate((rows, platform) =>
      platform === 'meta' ? rows.map(row => ({...row, spend: '0.0000000001', impressions: '0', clicks: '0'})) : rows,
    );
    const snapshot = await run(
      f,
      {...granularSource('meta', level), levels: [level]},
      {native: true},
      {date_range: {since: '2026-09-01', until: '2026-09-01'}},
    );
    assert.equal(snapshot.state, 'complete', JSON.stringify(snapshot.sources));
    assert.equal(snapshot.rows.length, 1, level);
    assert.equal(snapshot.rows[0].metrics.spend, '0', 'retained metrics keep the nine-place precision contract');
    assert.equal(snapshot.rows[0].native.delivery_activity, true, level);
    assert.equal(snapshot.sources[0].scope.excluded_unknown_rows, 0);
  }
});
