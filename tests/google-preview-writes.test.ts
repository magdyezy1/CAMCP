import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {googleJson} from '../src/google-contracts.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {Compiler} from '../src/compiler.js';
import {ScopeGuard} from '../src/scope.js';
import {applyExecutionRisk} from '../src/execution-risk.js';
import {actionContracts} from '../src/action-contracts.js';
import {googlePreviewSnapshots, readGooglePreviewState} from '../src/google-preview-writes.js';
import type {Connection, JsonObject} from '../src/types.js';
import {removeTestDirectory} from './temp.js';

const gateway = 'google_ads_native_action',
  rpc = 'google_ads_v23_shareable_preview_generate_shareable_previews';
const actor = {tenantId: 'preview-test', userId: 'operator', role: 'operator' as const},
  owner = {...actor, userId: 'owner', role: 'admin' as const};
const key = Buffer.alloc(32, 76).toString('base64'),
  rn = (kind: string, id: string) => 'customers/123/' + kind + '/' + id;
const ui = {assetGroup: rn('assetGroups', '7'), previewType: 'UI_PREVIEW'},
  second = {assetGroup: rn('assetGroups', '8'), previewType: 'UI_PREVIEW'},
  video = {adGroupAd: rn('adGroupAds', '5~9'), previewType: 'YOUTUBE_LIVE_PREVIEW'};
function fixture(path = ':memory:') {
  const store = new Store(path, key),
    calls: JsonObject[] = [],
    c: Connection = {
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      scopes: ['https://www.googleapis.com/auth/adwords'],
      enabled: true,
      label: 'Synthetic Ads login',
    };
  if (!store.listConnections(actor.tenantId).length)
    store.putConnection(owner, c, {accessToken: 'synthetic', developerToken: 'synthetic'});
  const groups = [
    {
      resourceName: rn('assetGroups', '7'),
      id: '7',
      name: 'Asset group',
      status: 'PAUSED',
      campaign: rn('campaigns', '3'),
      finalUrls: ['https://example.com/homes'],
    },
    {
      resourceName: rn('assetGroups', '8'),
      id: '8',
      name: 'Second group',
      status: 'PAUSED',
      campaign: rn('campaigns', '3'),
      finalUrls: ['https://example.com/other'],
    },
  ];
  const ads = [
    {
      resourceName: rn('adGroupAds', '5~9'),
      status: 'PAUSED',
      adGroup: rn('adGroups', '5'),
      ad: {
        resourceName: rn('ads', '9'),
        id: '9',
        type: 'VIDEO_AD',
        name: 'Video',
        finalUrls: ['https://example.com/video'],
      },
    },
  ];
  const campaigns = [
    {
      resourceName: rn('campaigns', '3'),
      id: '3',
      name: 'PMax',
      status: 'PAUSED',
      advertisingChannelType: 'PERFORMANCE_MAX',
    },
    {
      resourceName: rn('campaigns', '4'),
      id: '4',
      name: 'Video campaign',
      status: 'ENABLED',
      advertisingChannelType: 'VIDEO',
    },
  ];
  let mode = '',
    hook: ((kind: string) => void) | undefined,
    count = 0;
  const transport = new NativeTransport(
    async (url, init) => {
      const urlPath = new URL(String(url)).pathname,
        b = googleJson(JSON.parse(String(init?.body)));
      calls.push({path: urlPath, body: b});
      if (urlPath.endsWith('/googleAds:search')) {
        const kind = / FROM ([a-z_]+)/.exec(b.query)![1]!;
        hook?.(kind);
        count++;
        if (mode === 'read_error') return Response.json({error: {code: 403, message: 'Denied'}}, {status: 403});
        let rows: JsonObject[] =
          kind === 'customer'
            ? [{customer: {id: '123', currencyCode: 'EGP', timeZone: 'Africa/Cairo', manager: false}}]
            : kind === 'asset_group'
              ? groups.map(assetGroup => ({assetGroup, campaign: campaigns[0]}))
              : ads.map(adGroupAd => ({
                  adGroupAd,
                  adGroup: {
                    resourceName: rn('adGroups', '5'),
                    id: '5',
                    campaign: rn('campaigns', '4'),
                    status: 'ENABLED',
                  },
                  campaign: campaigns[1],
                }));
        const names = [...b.query.matchAll(/'(customers\/[^']+)'/g)].map((m: RegExpMatchArray) => m[1]);
        if (names.length) rows = rows.filter(row => names.includes((row.assetGroup ?? row.adGroupAd).resourceName));
        if (mode === 'missing' && kind !== 'customer') rows = [];
        if (mode === 'foreign' && kind !== 'customer')
          rows = rows.map(row => ({
            ...row,
            campaign: {...row.campaign, resourceName: rn('campaigns', '999').replace('/123/', '/999/')},
          }));
        if (mode === 'duplicate' && kind !== 'customer') rows = [...rows, ...rows];
        if (count % 2) rows.reverse();
        let token: string | undefined;
        if (mode === 'pages' && kind === 'asset_group') {
          rows.sort((a, b) => a.assetGroup.id.localeCompare(b.assetGroup.id));
          token = b.pageToken ? undefined : 'p2';
          rows = rows.slice(b.pageToken ? 1 : 0, b.pageToken ? 2 : 1);
        }
        return Response.json({
          ...(rows.length ? {results: rows} : {}),
          queryResourceConsumption: String(count),
          requestId: 'trace-' + count,
          ...(token ? {nextPageToken: token} : {}),
          ...(mode === 'loop' ? {nextPageToken: 'same'} : {}),
          ...(mode === 'bad_count' ? {totalResultsCount: '100'} : {}),
          ...(mode === 'partial_read' ? {partialFailureError: {code: 3}} : {}),
        });
      }
      assert.equal(urlPath, '/v25/customers/123:generateShareablePreviews');
      hook?.('submission');
      if (mode === 'lost') throw Error('Lost response after acceptance');
      if (mode === '503') return Response.json({error: {code: 503, message: 'Unavailable'}}, {status: 503});
      if (mode === 'rejected')
        return Response.json(
          {error: {code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT'}},
          {status: 400},
        );
      const expiry = (i: number) =>
        new Date(
          Date.now() + (mode === 'expired' || (mode === 'one_expired' && i === 0) ? -1000 : 3600000),
        ).toISOString();
      // The v25 result: one row per preview, naming its target and holding the result of its type.
      const previews = b.operation.shareablePreviews.map((p: JsonObject, i: number) => ({
        ...(p.assetGroup ? {assetGroup: p.assetGroup} : {adGroupAd: p.adGroupAd}),
        expirationDateTime: expiry(i),
        ...(p.adGroupAd
          ? {
              youtubeLivePreviewResult: {
                youtubePreviewUrl: 'https://www.youtube.com/watch?v=synthetic&preview=private-preview-' + i,
                youtubeTvPreviewUrl: 'https://tv.youtube.com/preview/private-tv-' + i,
              },
            }
          : {
              uiPreviewResult: {
                shareablePreviewUrl: 'https://ads.google.com/aw_cm/ExternalPreview?preview=private-preview-' + i,
              },
            }),
      }));
      if (mode === 'foreign_receipt') previews[0].assetGroup = rn('assetGroups', '999');
      if (mode === 'both_results')
        previews[0].youtubeLivePreviewResult = {youtubePreviewUrl: 'https://www.youtube.com/watch?v=other'};
      if (mode === 'unsafe_url') previews[0].uiPreviewResult.shareablePreviewUrl = 'https://127.0.0.1/private';
      if (mode === 'v23_receipt')
        return Response.json({
          responses: previews.map(({uiPreviewResult, ...row}: JsonObject) => ({
            shareablePreviewResult: uiPreviewResult ?? {},
            ...row,
          })),
        });
      return Response.json(
        mode === 'empty'
          ? {}
          : {result: {previews: mode === 'duplicate_receipt' ? [previews[0], previews[0]] : previews.reverse()}},
      );
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    10000,
  );
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const args = (previews: JsonObject[] = [ui], action = rpc) => ({
    action,
    account_id: '123',
    connection_id: c.id,
    payload: {operation: {shareablePreviews: previews}},
  });
  const prepare = (previews: JsonObject[] = [ui], action = rpc) =>
    service.call('amcp_write', {action: 'prepare', gateway, arguments: args(previews, action)}, actor);
  const execute = (r: JsonObject, extra: JsonObject = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: r.data.review_id,
        idempotency_key: r.data.idempotency_key,
        confirmed: true,
        ...extra,
      },
      actor,
    );
  const verify = (r: JsonObject) =>
    service.call('amcp_campaign', {action: 'verify', review_id: r.data.review_id}, actor);
  return {
    store,
    c,
    calls,
    groups,
    ads,
    campaigns,
    service,
    args,
    prepare,
    execute,
    verify,
    writes: () => calls.filter(c => !c.path.endsWith('/googleAds:search')).length,
    mode: (s: string) => {
      mode = s;
    },
    hook: (fn: (kind: string) => void) => {
      hook = fn;
    },
  };
}
for (const action of [rpc, 'GENERATE_SHAREABLE_PREVIEWS'])
  test(
    action + ' reviews both native preview modes and verifies original URLs without another generation',
    async () => {
      const f = fixture();
      try {
        const r = await f.prepare([ui, video], action);
        assert.equal(r.success, true, JSON.stringify(r));
        assert.equal(f.writes(), 0);
        const e = await f.execute(r);
        assert.equal(e.success, true, JSON.stringify(e));
        assert.equal(f.writes(), 1);
        assert.match(JSON.stringify(e.data), /private-preview/);
        const v = await f.verify(r);
        assert.equal(v.success, true, JSON.stringify(v));
        assert.equal(v.data.status, 'verified');
        assert.equal(f.writes(), 1);
        const replay = await f.execute(r);
        assert.equal(replay.success, true, JSON.stringify(replay));
        assert.equal(replay.data.replayed, true);
        assert.match(JSON.stringify(replay.data), /private-preview/);
        assert.equal(f.writes(), 1);
      } finally {
        f.store.close();
      }
    },
  );

test('inspection and local native preview require no credentials; native execution cannot bypass review', async () => {
  const f = fixture();
  try {
    const inspected = await f.service.call('amcp_write', {action: 'inspect', gateway, arguments: f.args()}, actor);
    assert.equal(inspected.data.review_contract_supported, true, JSON.stringify(inspected));
    assert.equal(f.calls.length, 0);
    const dry = await f.service.call(gateway, {...f.args(), dry_run: true}, actor);
    assert.equal(dry.success, true);
    assert.equal(dry.data.executed, false);
    const direct = await f.service.call(gateway, {...f.args(), dry_run: false}, actor);
    assert.equal(direct.success, false);
    // Refused first with the review call (MCP-09), not with a confirmation for a review that does not exist.
    assert.equal(direct.error.code, 'WRITE_REVIEW_REQUIRED');
    assert.equal(f.calls.length, 0);
    const forged = await f.service.call(
      gateway,
      {...f.args(), dry_run: false, confirmed: true, idempotency_key: 'caller-key', before_state: {}},
      actor,
    );
    assert.equal(forged.success, false);
    assert.equal(forged.error.code, 'INVALID_ARGUMENT');
    assert.equal(f.calls.length, 0);
    for (const action of [rpc, 'GENERATE_SHAREABLE_PREVIEWS'])
      assert.equal(
        actionContracts(new Registry()).find(r => r.gateway === gateway && r.action === action)?.family,
        'google_shareable_previews',
      );
  } finally {
    f.store.close();
  }
});
test('preview inputs enforce native oneofs, exact customer IDs, no invented flags and bounded distinct targets', async () => {
  const f = fixture();
  try {
    for (const previews of [
      [],
      [{}],
      [{assetGroup: rn('assetGroups', '0'), previewType: 'UI_PREVIEW'}],
      [{assetGroup: 'customers/999/assetGroups/7', previewType: 'UI_PREVIEW'}],
      [{...ui, customerId: '123'}],
      [{assetGroup: ui.assetGroup}],
      [{...ui, adGroupAd: video.adGroupAd}],
      [{...ui, previewType: 'YOUTUBE_LIVE_PREVIEW'}],
      [{...video, previewType: 'UI_PREVIEW'}],
      [{...video, adGroupAd: video.adGroupAd.replace('/123/', '/999/')}],
      [{...video, adGroupAd: rn('adGroupAds', '5~9 OR 1=1')}],
      [ui, ui],
      Array.from({length: 26}, (_, i) => ({assetGroup: rn('assetGroups', String(i + 1)), previewType: 'UI_PREVIEW'})),
      [{...ui, publish: true}],
    ]) {
      const r = await f.prepare(previews);
      assert.equal(r.success, false, JSON.stringify(previews));
    }
    const payload = (p: JsonObject) =>
      f.service.call('amcp_write', {action: 'prepare', gateway, arguments: {...f.args(), payload: p}}, actor);
    for (const p of [
      {operation: {shareablePreviews: [ui]}, partialFailure: true},
      {operation: {shareablePreviews: [ui]}, validateOnly: true},
      {operation: {shareablePreviews: [ui], validateOnly: true}},
      {operation: {shareablePreviews: [ui]}, shareablePreviews: [ui]},
    ])
      assert.equal((await payload(p)).success, false, JSON.stringify(p));
    // A request in the v23 shape is refused with the v25 shape to send, by the native name and the legacy alias.
    for (const action of [rpc, 'GENERATE_SHAREABLE_PREVIEWS'])
      for (const p of [
        {shareablePreviews: [{assetGroupIdentifier: {assetGroupId: '7'}}]},
        {operation: {shareablePreviews: [{assetGroupIdentifier: {assetGroupId: '7'}, previewType: 'UI_PREVIEW'}]}},
      ]) {
        const old = await f.service.call(
          'amcp_write',
          {action: 'prepare', gateway, arguments: {...f.args([], action), payload: p}},
          actor,
        );
        assert.equal(old.success, false, action);
        assert.match(
          old.error.details.version_change,
          /"operation".*"assetGroup": "customers\/\{customer_id\}\/assetGroups/,
          action,
        );
      }
    assert.equal(f.calls.length, 0);
    const native = await payload({
      operation: {shareable_previews: [{asset_group: rn('assetGroups', '7'), preview_type: 'UI_PREVIEW'}]},
    });
    assert.equal(native.success, true, JSON.stringify(native));
  } finally {
    f.store.close();
  }
});
test('root-customer RPC guard distinguishes the method delimiter from the customer and rejects foreign scopes', () => {
  const f = fixture();
  try {
    const registry = new Registry(),
      scope = new ScopeGuard(registry, f.store),
      p = applyExecutionRisk(new Compiler(registry).compile(gateway, f.args(), {mode: 'strict', flags: {}}));
    assert.equal(scope.authorize(p, f.c), '123');
    for (const path of [
      '/v25/customers/999:generateShareablePreviews',
      '/v25/customers/1230:generateShareablePreviews',
      '/v25/customers/123%3Aevil/../customers/999:generateShareablePreviews',
    ])
      assert.throws(() => scope.authorize({...p, path}, f.c), {code: 'ACCOUNT_SCOPE_MISMATCH'});
    assert.throws(
      () =>
        scope.authorize(
          {
            ...p,
            body: {operation: {shareablePreviews: [{...video, adGroupAd: video.adGroupAd.replace('/123/', '/999/')}]}},
          },
          f.c,
        ),
      {code: 'ACCOUNT_SCOPE_MISMATCH'},
    );
  } finally {
    f.store.close();
  }
});
test('telemetry and source row order do not conflict, while real source changes do', async () => {
  for (const change of ['none', 'name', 'url', 'status', 'parent'] as const) {
    const f = fixture();
    try {
      const r = await f.prepare([ui, second]);
      assert.equal(r.success, true, JSON.stringify(r));
      if (change === 'name') f.groups[0]!.name = 'Changed';
      if (change === 'url') f.groups[0]!.finalUrls = ['https://example.com/changed'];
      if (change === 'status') f.groups[0]!.status = 'ENABLED';
      if (change === 'parent') f.campaigns[0]!.name = 'Changed parent';
      const e = await f.execute(r);
      assert.equal(e.success, change === 'none', JSON.stringify(e));
      if (change !== 'none') {
        assert.equal(e.error.code, 'STATE_CHANGED');
        assert.ok(
          e.error.details.changed_fields.some((s: string) =>
            s.includes(change === 'url' ? 'finalUrls' : change === 'status' ? 'status' : 'name'),
          ),
        );
        assert.equal(f.writes(), 0);
      } else assert.equal(f.writes(), 1);
    } finally {
      f.store.close();
    }
  }
});
test('bounded source pagination succeeds; incomplete, foreign, duplicate or failed sources never authorize generation', async () => {
  const f = fixture();
  try {
    f.mode('pages');
    const r = await f.prepare([ui, second]);
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal((await f.execute(r)).success, true);
  } finally {
    f.store.close();
  }
  for (const mode of ['missing', 'foreign', 'duplicate', 'loop', 'bad_count', 'partial_read', 'read_error']) {
    const f = fixture();
    try {
      f.mode(mode);
      const r = await f.prepare();
      assert.equal(r.success, false, mode);
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});
test('unsupported Search/Display formats and removed or mismatched parents are rejected before preview submission', async () => {
  for (const change of [
    'search',
    'display',
    'removed',
    'wrong_asset_parent',
    'wrong_ad_id',
    'wrong_ad_group',
  ] as const) {
    const f = fixture();
    try {
      if (change === 'search') f.ads[0]!.ad.type = 'RESPONSIVE_SEARCH_AD';
      if (change === 'display') f.ads[0]!.ad.type = 'RESPONSIVE_DISPLAY_AD';
      if (change === 'removed') f.ads[0]!.status = 'REMOVED';
      if (change === 'wrong_asset_parent') f.groups[0]!.campaign = rn('campaigns', '999');
      if (change === 'wrong_ad_id') f.ads[0]!.ad.id = '999';
      if (change === 'wrong_ad_group') f.ads[0]!.adGroup = rn('adGroups', '999');
      assert.equal((await f.prepare([ui, video])).success, false, change);
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});
test('review binding, role, scopes, per-account grants, current login and confirmation are mandatory', async () => {
  for (const mode of ['reader', 'scope', 'grant', 'disabled', 'tenant', 'unconfirmed', 'changed_login'] as const) {
    const f = fixture();
    try {
      const r = await f.prepare();
      assert.equal(r.success, true, JSON.stringify(r));
      if (mode === 'scope') f.store.putConnection(owner, {...f.c, scopes: ['openid']}, {accessToken: 'synthetic'});
      if (mode === 'grant') f.store.putConnection(owner, {...f.c, writeAccounts: []}, {accessToken: 'synthetic'});
      if (mode === 'disabled') f.store.putConnection(owner, {...f.c, enabled: false}, {accessToken: 'synthetic'});
      if (mode === 'changed_login') f.hook(() => f.store.putConnection(owner, f.c, {accessToken: 'changed'}));
      const e = await f.service.call(
        'amcp_write',
        {
          action: 'execute',
          review_id: r.data.review_id,
          idempotency_key: r.data.idempotency_key,
          confirmed: mode !== 'unconfirmed',
        },
        mode === 'reader' ? {...actor, role: 'reader'} : mode === 'tenant' ? {...actor, tenantId: 'other'} : actor,
      );
      assert.equal(e.success, false, mode);
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});
test('duplicate customer IDs require a chosen connection; expired review and tampered frozen input cannot submit', async () => {
  const f = fixture();
  try {
    f.store.putConnection(owner, {...f.c, id: '22222222-2222-4222-8222-222222222222'}, {accessToken: 'other'});
    const args = f.args();
    delete (args as JsonObject).connection_id;
    assert.equal(
      (await f.service.call('amcp_write', {action: 'prepare', gateway, arguments: args}, actor)).error?.code,
      'AMBIGUOUS_CONNECTION',
    );
    const r = await f.prepare();
    assert.equal(r.success, true, JSON.stringify(r));
    const saved = f.store.document(actor.tenantId, 'write_review', r.data.review_id);
    f.store.putDocument(actor.tenantId, 'write_review', r.data.review_id, {...saved, expires_at: Date.now() - 1});
    assert.equal((await f.execute(r)).error?.code, 'REVIEW_EXPIRED');
    f.store.putDocument(actor.tenantId, 'write_review', r.data.review_id, {
      ...saved,
      plan: {...saved.plan, body: {operation: {shareablePreviews: [video]}}},
    });
    assert.equal((await f.execute(r)).error?.code, 'REVIEW_CHANGED');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});
test('rejected requests and malformed or expired receipts keep the original claim and deliver only validated links', async () => {
  for (const mode of [
    'one_expired',
    'rejected',
    'empty',
    'v23_receipt',
    'foreign_receipt',
    'duplicate_receipt',
    'both_results',
    'unsafe_url',
    'expired',
  ]) {
    const f = fixture();
    try {
      const r = await f.prepare([ui, video]);
      assert.equal(r.success, true, JSON.stringify(r));
      f.mode(mode);
      const e = await f.execute(r);
      assert.equal(e.success, false, mode + JSON.stringify(e));
      assert.equal(f.writes(), 1);
      if (mode !== 'rejected') {
        assert.equal(e.data.retry_safe, false);
        if (mode === 'one_expired') {
          assert.equal(e.data.previews.status, 'partial');
          assert.equal(e.data.previews.results.filter((r: JsonObject) => r.status === 'generated').length, 1);
          assert.match(JSON.stringify(e.data.previews), /private-preview/);
        } else
          assert.equal(e.data.previews.results.filter((r: JsonObject) => r.status === 'generated').length, 0, mode);
        assert.ok(!JSON.stringify(e.data.previews).includes('127.0.0.1'));
      }
      const again = await f.execute(r);
      assert.ok(
        again.data?.replayed === true || again.error?.code === 'WRITE_OUTCOME_UNCERTAIN' || again.success === false,
        mode,
      );
      assert.equal(f.writes(), 1);
    } finally {
      f.store.close();
    }
  }
});
test('concurrent executes submit once; a lost provider response and 503 never retry or release their claim', async () => {
  const f = fixture();
  try {
    const r = await f.prepare();
    assert.equal(r.success, true, JSON.stringify(r));
    const results = await Promise.all([f.execute(r), f.execute(r)]);
    assert.ok(results.some(r => r.success));
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
  for (const mode of ['lost', '503']) {
    const f = fixture();
    try {
      const r = await f.prepare();
      assert.equal(r.success, true, JSON.stringify(r));
      f.mode(mode);
      assert.equal((await f.execute(r)).success, false);
      assert.equal((await f.execute(r)).error?.code, 'WRITE_OUTCOME_UNCERTAIN');
      assert.equal(f.writes(), 1);
    } finally {
      f.store.close();
    }
  }
});
test('completed URLs survive restart encrypted, never leak into normal SQL/audit, and expire without resubmission', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amcp-previews-')),
    path = join(directory, 'db.sqlite');
  let f = fixture(path);
  const r = await f.prepare();
  assert.equal(r.success, true, JSON.stringify(r));
  const e = await f.execute(r);
  assert.equal(e.success, true, JSON.stringify(e));
  for (const table of ['documents', 'idempotency', 'audit'])
    assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM ' + table).all()).includes('private-preview'), table);
  assert.ok(f.store.document(actor.tenantId, 'preview_receipt', r.data.review_id).secret);
  f.store.close();
  f = fixture(path);
  try {
    const replay = await f.execute(r);
    assert.equal(replay.success, true, JSON.stringify(replay));
    assert.match(JSON.stringify(replay.data.previews), /private-preview/);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.verify(r)).data.status, 'verified');
    const saved = f.store.document(actor.tenantId, 'preview_receipt', r.data.review_id);
    f.store.putDocument(actor.tenantId, 'preview_receipt', r.data.review_id, {...saved, expires_at: Date.now() - 1});
    const expired = await f.execute(r);
    assert.equal(expired.data.previews.status, 'unavailable');
    assert.ok(!JSON.stringify(expired).includes('private-preview'));
    assert.equal((await f.verify(r)).data.status, 'inconclusive');
    f.store.cleanupTransient();
    assert.throws(() => f.store.document(actor.tenantId, 'preview_receipt', r.data.review_id), {code: 'NOT_FOUND'});
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
    removeTestDirectory(directory, 'amcp-previews-');
  }
});
test('revocation during generation withholds URLs but preserves the completed outcome for authorized recovery', async () => {
  const f = fixture();
  try {
    const r = await f.prepare();
    assert.equal(r.success, true, JSON.stringify(r));
    f.hook(kind => {
      if (kind === 'submission') f.store.putConnection(owner, {...f.c, writeAccounts: []}, {accessToken: 'synthetic'});
    });
    const e = await f.execute(r);
    assert.equal(e.success, false);
    assert.ok(!JSON.stringify(e).includes('private-preview'));
    assert.equal(f.writes(), 1);
    assert.equal(
      f.store.db.prepare('SELECT state FROM idempotency WHERE key=?').get(r.data.review_id)!.state,
      'complete',
    );
    f.store.putConnection(owner, f.c, {accessToken: 'synthetic'});
    const recovered = await f.execute(r);
    assert.equal(recovered.data.replayed, true);
    assert.match(JSON.stringify(recovered.data.previews), /private-preview/);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});
test('preview links do not activate ads or spend budgets under zero-limit owner policy', async () => {
  const f = fixture();
  try {
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: '123',
      confirmed: true,
      policy: {allow_activation: false, allow_deletion: false, max_budget_native: 0, max_daily_increase_native: 0},
    });
    const r = await f.prepare([video]);
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.spend_policy.requested_increase_native, 0);
    const e = await f.execute(r);
    assert.equal(e.success, true, JSON.stringify(e));
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});
test('native protocol evidence matches pinned Discovery fields, route and scope', () => {
  const evidence = JSON.parse(readFileSync('tests/fixtures/google-preview-v25.json', 'utf8')),
    vendor = JSON.parse(readFileSync('generated/vendor-routes.json', 'utf8')),
    schemas = vendor.schemaComponents['google-ads-v25'].schemas;
  assert.equal(evidence.version, 'v25');
  assert.equal(evidence.route, '/v25/customers/{customer_id=*}:generateShareablePreviews');
  assert.equal(evidence.scope, 'https://www.googleapis.com/auth/adwords');
  for (const source of Object.values(evidence.sources) as JsonObject[]) assert.match(source.sha256, /^[a-f0-9]{64}$/);
  for (const [name, fields] of Object.entries(evidence.fields) as [string, string[]][]) {
    const expected = fields
      .filter(k => k !== 'customer_id')
      .map(k => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()))
      .sort();
    const schema =
      schemas['GoogleAdsGoogleadsV25Services__' + name] ?? schemas['GoogleAdsGoogleadsV25Actions__' + name];
    assert.deepEqual(Object.keys(schema.properties).sort(), expected, name);
  }
  // One target and one result per preview; Google has no per-preview error in v25.
  assert.deepEqual(evidence.oneofs.ShareablePreview, ['identifier']);
  assert.deepEqual(evidence.oneofs.ShareablePreviewResult, ['identifier', 'result']);
  const f = fixture();
  try {
    const p = new Compiler(new Registry()).compile(gateway, f.args([ui, video]), {mode: 'strict', flags: {}});
    for (const read of googlePreviewSnapshots(p)) {
      assert.equal(read.method, 'POST');
      assert.equal(read.readOnly, true);
      assert.ok(!(read.body as JsonObject).query.includes('ORDER BY'));
    }
  } finally {
    f.store.close();
  }
});
test('source secrets are hashed and redacted without suppressing real destination conflicts', async () => {
  const f = fixture();
  try {
    f.groups[0]!.finalUrls = ['https://example.com/?signature=source-private-one'];
    const r = await f.prepare();
    assert.equal(r.success, true, JSON.stringify(r));
    assert.ok(!JSON.stringify(r).includes('source-private-one'));
    assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM documents').all()).includes('source-private-one'));
    f.groups[0]!.finalUrls = ['https://example.com/?signature=source-private-two'];
    const e = await f.execute(r);
    assert.equal(e.error?.code, 'STATE_CHANGED');
    assert.ok(e.error.details.changed_fields.some((f: string) => f.endsWith('["sha256"]')));
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});
test('source byte bounds and reauthorization between consistency reads stop preparation', async () => {
  const f = fixture();
  try {
    const p = new Compiler(new Registry()).compile(gateway, f.args(), {mode: 'strict', flags: {}});
    let reads = 0;
    await assert.rejects(
      readGooglePreviewState(p, async () => {
        reads++;
        return {
          status: 200,
          headers: {},
          data: {
            results: [{customer: {id: '123', currencyCode: 'EGP', timeZone: 'Africa/Cairo'}}],
            requestId: 'x'.repeat(8 * 1024 * 1024),
          },
        };
      }),
      {code: 'PREVIEW_STATE_UNVERIFIED'},
    );
    assert.equal(reads, 1);
    let calls = 0;
    f.hook(kind => {
      if (kind === 'customer' && ++calls === 2)
        f.store.replaceCredentials(actor.tenantId, f.c.id, {accessToken: 'different-login'});
    });
    assert.equal((await f.prepare()).error?.code, 'REAUTHORIZATION_REQUIRED');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});
