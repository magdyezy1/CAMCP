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
import {
  googlePreviewDelivery,
  googlePreviewOutcome,
  googlePreviewSafeOutcome,
  googlePreviewSnapshots,
  readGooglePreviewState,
} from '../src/google-preview-writes.js';
import type {Connection, JsonObject} from '../src/types.js';
import {mismatchedAnswerDetails} from '../src/errors.js';
import {removeTestDirectory} from './temp.js';
import {assertRefused} from './helpers/assert-refused.js';

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
    // r12-gpreview: the exact body Google answers the generation with, for a test that builds its own.
    reply: ((body: JsonObject) => unknown) | undefined,
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
      if (reply) return Response.json(reply(b));
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
    reply: (fn: (body: JsonObject) => unknown) => {
      reply = fn;
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
      assertRefused(r, ['INVALID_PREVIEW_REQUEST', 'INVALID_VENDOR_BODY']);
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
        assertRefused(old, ['MISSING_PARAMETER', 'INVALID_VENDOR_BODY', 'UNKNOWN_GOOGLE_FIELD']);
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
      assertRefused(r, ['PREVIEW_STATE_UNVERIFIED', 'INVALID_PREVIEW_REQUEST', 'PROVIDER_ACCESS_DENIED']);
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
      assertRefused(await f.prepare([ui, video]), 'PREVIEW_STATE_UNVERIFIED');
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
      assertRefused(e, [
        'CONNECTOR_READ_ONLY',
        'INSUFFICIENT_SCOPE',
        'WRITE_ACCOUNT_FORBIDDEN',
        'CONNECTION_REQUIRED',
        'NOT_FOUND',
        'CONFIRMATION_REQUIRED',
        'CONNECTION_AUTHORITY_CHANGED',
      ]);
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
      assertRefused(e, ['WRITE_PARTIAL_OR_FAILED', 'UPSTREAM_ERROR']);
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
        // The next step follows the answer (r12-gpreview): one AMCP did not accept shows no link and says so; one it did accept
        // with some previews expired keeps the step it had; one it did accept whose previews have all expired says the links
        // expired and that a new generation needs a new review (found-not-fixed 2 of the first review, kept by the lead).
        assert.match(
          e.data.previews.next_action,
          mode === 'one_expired'
            ? /^Open a generated link/
            : mode === 'expired'
              ? /^The links of this generation have expired and none is shown\. A new generation needs a new review\./
              : /^No link is shown/,
          mode,
        );
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
    // The links are gone with their receipt, and that is what is said: not that an answer was refused.
    assert.match(expired.data.previews.next_action, /^Private preview links expired locally or are unavailable\./);
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
    assertRefused(e, 'WRITE_ACCOUNT_FORBIDDEN');
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
    assert.equal((await f.prepare()).error?.code, 'CONNECTION_AUTHORITY_CHANGED');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

// r12-gpreview. Found live 2026-11-16: Google answered a generation with HTTP 200 and AMCP refused the answer, naming nothing
// but "does not match". The pinned Discovery document (.mirror/VENDOR/google-ads-v25.json, revision 20260923, which
// generated/vendor-routes.json holds) says what the answer is: {result: {previews: [ShareablePreviewResult]}}, one result per
// preview and no per-preview error. The fixtures below are built from that document, so the names and the nesting are
// Google's and not this test's: a re-pinned document that moves them fails here first.
const pinned: Record<string, any> = JSON.parse(readFileSync('generated/vendor-routes.json', 'utf8')).schemaComponents[
  'google-ads-v25'
].schemas;
const responseRef = 'GoogleAdsGoogleadsV25Services__GenerateShareablePreviewsResponse';
type Wanted = {kind: 'asset_group' | 'ad_group_ad'; name: string};
const wantedUi: Wanted = {kind: 'asset_group', name: ui.assetGroup},
  wantedSecond: Wanted = {kind: 'asset_group', name: second.assetGroup},
  wantedVideo: Wanted = {kind: 'ad_group_ad', name: video.adGroupAd};
const targetOf = (w: Wanted): JsonObject =>
  w.kind === 'asset_group'
    ? {assetGroup: w.name, previewType: 'UI_PREVIEW'}
    : {adGroupAd: w.name, previewType: 'YOUTUBE_LIVE_PREVIEW'};
const compiled = (previews: JsonObject[]) =>
  new Compiler(new Registry()).compile(
    gateway,
    {action: rpc, account_id: '123', payload: {operation: {shareablePreviews: previews}}},
    {mode: 'strict', flags: {}},
  );
/**
 * The answer to the generation of `wanted`, one preview each, built property by property from the pinned document. The
 * document does not say which of two oneofs a preview takes (the asset group or the ad, the UI or the YouTube result), so
 * the target's kind does. `filled` collects the properties used, by message.
 */
function documentedResponse(wanted: Wanted[], filled: Map<string, Set<string>> = new Map()): JsonObject {
  const taken = (target: Wanted | undefined, name: string) =>
    !target ||
    !(
      (name === 'assetGroup' && target.kind !== 'asset_group') ||
      (name === 'adGroupAd' && target.kind !== 'ad_group_ad') ||
      (name === 'uiPreviewResult' && target.kind !== 'asset_group') ||
      (name === 'youtubeLivePreviewResult' && target.kind !== 'ad_group_ad')
    );
  const text = (name: string, target: Wanted | undefined, i: number | undefined): string => {
    if (name === 'assetGroup' || name === 'adGroupAd') return target!.name;
    if (name === 'shareablePreviewUrl') return 'https://ads.google.com/documented/preview-' + i;
    if (name === 'youtubePreviewUrl') return 'https://www.youtube.com/documented/preview-' + i;
    if (name === 'youtubeTvPreviewUrl') return 'https://tv.youtube.com/documented/preview-' + i;
    if (name === 'expirationDateTime') return new Date(Date.now() + 3600000).toISOString();
    return assert.fail('The pinned document has a text field this test does not know: ' + name);
  };
  const build = (ref: string, i?: number): JsonObject => {
    const schema = pinned[ref];
    assert.ok(schema, 'The pinned document has no ' + ref);
    const out: JsonObject = {};
    for (const [name, property] of Object.entries<any>(schema.properties ?? {})) {
      const target = i === undefined ? undefined : wanted[i];
      if (!taken(target, name)) continue;
      if (!filled.has(ref)) filled.set(ref, new Set());
      filled.get(ref)!.add(name);
      if (property.$ref) out[name] = build(property.$ref, i);
      else if (property.type === 'array') out[name] = wanted.map((_, n) => build(property.items.$ref, n));
      else if (property.type === 'string') out[name] = text(name, target, i);
      else assert.fail('The pinned document has a field this test does not know: ' + ref + '.' + name);
    }
    return out;
  };
  return build(responseRef);
}
const previewsOf = (r: any): any[] => r.result.previews;
const clearText = (f: ReturnType<typeof fixture>) =>
  ['documents', 'idempotency', 'audit'].map(table =>
    JSON.stringify(f.store.db.prepare('SELECT * FROM ' + table).all()),
  );

test('an answer built from the pinned v25 schema verifies, and returns each preview with its link and expiry', async () => {
  const filled = new Map<string, Set<string>>();
  documentedResponse([wantedUi, wantedVideo], filled);
  // The fixture used every documented property of every message of the answer, and no other message.
  assert.deepEqual([...filled.keys()].sort(), [
    'GoogleAdsGoogleadsV25Actions__GenerateShareablePreviewsResult',
    'GoogleAdsGoogleadsV25Actions__ShareablePreviewResult',
    'GoogleAdsGoogleadsV25Actions__UiPreviewResult',
    'GoogleAdsGoogleadsV25Actions__YouTubeLivePreviewResult',
    responseRef,
  ]);
  for (const [ref, names] of filled)
    assert.deepEqual([...names].sort(), Object.keys(pinned[ref].properties).sort(), ref);
  const f = fixture();
  try {
    const r = await f.prepare([ui, video]);
    assert.equal(r.success, true, JSON.stringify(r));
    // Google's order is not the review's: the previews come back in the order the review froze.
    f.reply(() => {
      const answer = documentedResponse([wantedUi, wantedVideo]);
      previewsOf(answer).reverse();
      return answer;
    });
    const e = await f.execute(r);
    assert.equal(e.success, true, JSON.stringify(e));
    assert.equal(e.data.previews.status, 'generated');
    // An answer that matches keeps its next step: the links are opened, and a generation is never repeated.
    assert.equal(
      e.data.previews.next_action,
      'Open a generated link in a separate browser tab. Never repeat a successful or uncertain generation automatically.',
    );
    const [first, other] = e.data.previews.results;
    assert.deepEqual(
      [first, other].map(x => [x.target, x.preview_type, x.status, x.expiration_known]),
      [
        [ui.assetGroup, 'UI_PREVIEW', 'generated', true],
        [video.adGroupAd, 'YOUTUBE_LIVE_PREVIEW', 'generated', true],
      ],
    );
    assert.equal(first.shareablePreviewUrl, 'https://ads.google.com/documented/preview-0');
    assert.equal(other.youtubePreviewUrl, 'https://www.youtube.com/documented/preview-1');
    assert.equal(other.youtubeTvPreviewUrl, 'https://tv.youtube.com/documented/preview-1');
    for (const x of [first, other]) assert.ok(Date.parse(x.expiration_date_time) > Date.now(), x.target);
    // The links are delivered once, from the encrypted receipt: never in the outcome, the audit or any ordinary record.
    assert.ok(!JSON.stringify(e.data.data).includes('documented/preview-'));
    for (const table of clearText(f)) assert.ok(!table.includes('documented/preview-'));
    assert.equal((await f.verify(r)).data.status, 'verified');
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

type Refusal = [label: string, wanted: Wanted[], change: (answer: any) => unknown, mismatch: JsonObject];
const refusals: Refusal[] = [
  [
    'a field the pinned schema does not list, beside the result',
    [wantedUi],
    a => ({...a, requestId: 'trace-1'}),
    {check: 'body', reason: 'unexpected_fields', unexpected: ['requestId']},
  ],
  [
    'the v23 list of per-preview answers',
    [wantedUi],
    a => ({responses: previewsOf(a).map(p => ({shareablePreviewResult: p.uiPreviewResult, assetGroup: p.assetGroup}))}),
    {check: 'body', reason: 'unexpected_fields', unexpected: ['responses']},
  ],
  ['an empty answer', [wantedUi], () => ({}), {check: 'result', reason: 'missing'}],
  ['a result that is a list', [wantedUi], () => ({result: []}), {check: 'result', reason: 'not_an_object'}],
  [
    'a field the pinned schema does not list, in the result',
    [wantedUi],
    a => ({result: {...a.result, nextPageToken: 'x'}}),
    {check: 'result', reason: 'unexpected_fields', unexpected: ['nextPageToken']},
  ],
  ['a result with no previews', [wantedUi], () => ({result: {}}), {check: 'previews', reason: 'missing'}],
  [
    'previews that are not a list',
    [wantedUi],
    a => ({result: {...a.result, previews: {}}}),
    {check: 'previews', reason: 'not_a_list'},
  ],
  [
    'one preview too many: a target the review did not ask for',
    [wantedUi],
    a => {
      previewsOf(a).push({...previewsOf(a)[0], assetGroup: second.assetGroup});
      return a;
    },
    {check: 'count', reason: 'differs', entries: 2, targets: 1},
  ],
  [
    'one preview too few: a target with no answer',
    [wantedUi, wantedVideo],
    a => {
      previewsOf(a).pop();
      return a;
    },
    {check: 'count', reason: 'differs', entries: 1, targets: 2},
  ],
  [
    'an entry that is not an object',
    [wantedUi],
    a => ({result: {...a.result, previews: ['x']}}),
    {check: 'entry', reason: 'not_an_object', entry: 0},
  ],
  [
    'a field the pinned schema does not list, in an entry',
    [wantedUi],
    a => {
      previewsOf(a)[0].previewType = 'UI_PREVIEW';
      return a;
    },
    {check: 'entry', reason: 'unexpected_fields', entry: 0, unexpected: ['previewType']},
  ],
  [
    'an entry that carries a partial-failure error and no result',
    [wantedUi],
    a => ({
      result: {previews: [{assetGroup: previewsOf(a)[0].assetGroup, partialFailureError: {code: 3, message: 'x'}}]},
    }),
    {check: 'entry', reason: 'unexpected_fields', entry: 0, unexpected: ['partialFailureError']},
  ],
  [
    'an entry that names no target',
    [wantedUi],
    a => {
      delete previewsOf(a)[0].assetGroup;
      return a;
    },
    {check: 'identifier', reason: 'none', entry: 0},
  ],
  [
    'an entry that names two targets',
    [wantedUi],
    a => {
      previewsOf(a)[0].adGroupAd = video.adGroupAd;
      return a;
    },
    {check: 'identifier', reason: 'both', entry: 0},
  ],
  [
    'an entry for a target the review did not freeze',
    [wantedUi],
    a => {
      previewsOf(a)[0].assetGroup = rn('assetGroups', '999');
      return a;
    },
    {check: 'identifier', reason: 'not_reviewed', entry: 0},
  ],
  [
    'the same target answered twice',
    [wantedUi, wantedSecond],
    a => {
      previewsOf(a)[1].assetGroup = ui.assetGroup;
      return a;
    },
    {check: 'identifier', reason: 'repeated', entry: 1},
  ],
  [
    'the ad kind of result for an asset group',
    [wantedUi],
    a => {
      previewsOf(a)[0].youtubeLivePreviewResult = {youtubePreviewUrl: 'https://www.youtube.com/x'};
      return a;
    },
    {check: 'preview_result', reason: 'wrong_type', entry: 0, field: 'youtubeLivePreviewResult'},
  ],
  [
    'no result for an asset group',
    [wantedUi],
    a => {
      delete previewsOf(a)[0].uiPreviewResult;
      return a;
    },
    {check: 'preview_result', reason: 'missing', entry: 0, field: 'uiPreviewResult'},
  ],
  [
    'a result for an asset group that is not an object',
    [wantedUi],
    a => {
      previewsOf(a)[0].uiPreviewResult = 'x';
      return a;
    },
    {check: 'preview_result', reason: 'not_an_object', entry: 0, field: 'uiPreviewResult'},
  ],
  [
    'a field the pinned schema does not list, in the result of an asset group',
    [wantedUi],
    a => {
      previewsOf(a)[0].uiPreviewResult.previewId = 'p';
      return a;
    },
    {
      check: 'preview_result',
      reason: 'unexpected_fields',
      entry: 0,
      field: 'uiPreviewResult',
      unexpected: ['previewId'],
    },
  ],
  [
    'the asset group kind of result for an ad',
    [wantedVideo],
    a => {
      previewsOf(a)[0].uiPreviewResult = {shareablePreviewUrl: 'https://ads.google.com/x'};
      return a;
    },
    {check: 'preview_result', reason: 'wrong_type', entry: 0, field: 'uiPreviewResult'},
  ],
  [
    'no result for an ad',
    [wantedVideo],
    a => {
      delete previewsOf(a)[0].youtubeLivePreviewResult;
      return a;
    },
    {check: 'preview_result', reason: 'missing', entry: 0, field: 'youtubeLivePreviewResult'},
  ],
  [
    'a result for an ad that is not an object',
    [wantedVideo],
    a => {
      previewsOf(a)[0].youtubeLivePreviewResult = [];
      return a;
    },
    {check: 'preview_result', reason: 'not_an_object', entry: 0, field: 'youtubeLivePreviewResult'},
  ],
  [
    'a result for an ad with no link',
    [wantedVideo],
    a => {
      previewsOf(a)[0].youtubeLivePreviewResult = {};
      return a;
    },
    {check: 'preview_result', reason: 'empty', entry: 0, field: 'youtubeLivePreviewResult'},
  ],
  [
    'a field the pinned schema does not list, in the result of an ad',
    [wantedVideo],
    a => {
      previewsOf(a)[0].youtubeLivePreviewResult.sizes = [];
      return a;
    },
    {
      check: 'preview_result',
      reason: 'unexpected_fields',
      entry: 0,
      field: 'youtubeLivePreviewResult',
      unexpected: ['sizes'],
    },
  ],
  // Lead review S3-3: the leaf checks of one entry (each link and the expiry) are independent. The first failure is named as it
  // always was and the others beside it (`also`), so one replay of the live review names every guard the answer fails, and not
  // one more deploy for each. The acceptance is unchanged: each of these refuses.
  [
    'a link on a host that is not accepted and an expiry that is not a date: the link is named, the expiry beside it',
    [wantedUi],
    a => {
      previewsOf(a)[0].uiPreviewResult.shareablePreviewUrl = 'https://127.0.0.1/preview';
      previewsOf(a)[0].expirationDateTime = 'tomorrow';
      return a;
    },
    {
      check: 'link',
      reason: 'host_not_accepted',
      entry: 0,
      field: 'shareablePreviewUrl',
      // The expiry named beside the link carries its shape too (r25-m3-gpreview, item 4): a second failing guard needs no more
      // deploys to be read.
      also: [{check: 'expiration', reason: 'format', entry: 0, shape: '????????'}],
    },
  ],
  [
    'both links of an ad and its expiry fail: the first link is named, the TV link and the expiry beside it',
    [wantedVideo],
    a => {
      previewsOf(a)[0].youtubeLivePreviewResult.youtubePreviewUrl = 'http://www.youtube.com/watch?v=synthetic';
      previewsOf(a)[0].youtubeLivePreviewResult.youtubeTvPreviewUrl = 'https://example.org/tv';
      previewsOf(a)[0].expirationDateTime = 1234;
      return a;
    },
    {
      check: 'link',
      reason: 'not_https',
      entry: 0,
      field: 'youtubePreviewUrl',
      also: [
        {check: 'link', reason: 'host_not_accepted', entry: 0, field: 'youtubeTvPreviewUrl'},
        {check: 'expiration', reason: 'not_text', entry: 0},
      ],
    },
  ],
  [
    'only the second link of an ad fails: it is named alone, with nothing beside it',
    [wantedVideo],
    a => {
      previewsOf(a)[0].youtubeLivePreviewResult.youtubeTvPreviewUrl = 'https://example.org/tv';
      return a;
    },
    {check: 'link', reason: 'host_not_accepted', entry: 0, field: 'youtubeTvPreviewUrl'},
  ],
];
const withLink = (field: string, value: unknown) => (answer: any) => {
  const row = previewsOf(answer)[0];
  (row.uiPreviewResult ?? row.youtubeLivePreviewResult)[field] = value;
  return answer;
};
const linkRefusals: [string, Wanted, string, unknown, string][] = [
  ['not text', wantedUi, 'shareablePreviewUrl', 5, 'not_text'],
  ['empty', wantedUi, 'shareablePreviewUrl', '', 'empty'],
  ['too long', wantedUi, 'shareablePreviewUrl', 'https://ads.google.com/' + 'x'.repeat(8200), 'too_long'],
  ['with a space', wantedUi, 'shareablePreviewUrl', 'https://ads.google.com/a b', 'whitespace_or_control'],
  ['not a URL', wantedUi, 'shareablePreviewUrl', 'ads.google.com/preview', 'not_a_url'],
  ['not https', wantedUi, 'shareablePreviewUrl', 'http://ads.google.com/preview', 'not_https'],
  ['with credentials', wantedUi, 'shareablePreviewUrl', 'https://user:secret@ads.google.com/p', 'credentials'],
  ['with a port', wantedUi, 'shareablePreviewUrl', 'https://ads.google.com:8443/preview', 'port'],
  ['to a host that is not accepted', wantedUi, 'shareablePreviewUrl', 'https://127.0.0.1/preview', 'host_not_accepted'],
  ['to another Google host', wantedUi, 'shareablePreviewUrl', 'https://pmax.ads.google.com/p', 'host_not_accepted'],
  [
    'with a credential parameter',
    wantedUi,
    'shareablePreviewUrl',
    'https://ads.google.com/preview?access_token=abc',
    'credential_parameter',
  ],
  [
    'of an ad, to a host that is not accepted',
    wantedVideo,
    'youtubePreviewUrl',
    'https://example.org/v',
    'host_not_accepted',
  ],
  ['of an ad for TV, not https', wantedVideo, 'youtubeTvPreviewUrl', 'http://tv.youtube.com/v', 'not_https'],
];
// r25-m3-gpreview (the lead's decision for `expiration` / `format`, item 4): a refused expiry that is text names its `shape`: the
// value with each digit as 9, each of T Z + - : . and the space kept, every other character as ?, and cut at 40 characters with
// an ellipsis. A closed alphabet, so the shape is the form and no provider text. A value that is not text has no shape.
// The shapes are written out by hand here, not computed.
const expirationRefusals: [label: string, value: unknown, reason: string, shape?: string][] = [
  ['not text', 1234, 'not_text'],
  ['a word', 'tomorrow', 'format', '????????'],
  ['a date that is not one', '2026-13-45T25:61:61Z', 'not_a_date', '9999-99-99T99:99:99Z'],
  // The calendar (decision item 3): a date or a time that does not exist is not a date. The engine's own parser reads some of
  // them as another instant (February 30 as March 2, hour 24 as the next midnight), so the guard checks the parts itself.
  ['February 30', '2026-02-30T10:15:30Z', 'not_a_date', '9999-99-99T99:99:99Z'],
  ['April 31', '2026-04-31T10:15:30Z', 'not_a_date', '9999-99-99T99:99:99Z'],
  ['June 31', '2026-06-31T10:15:30Z', 'not_a_date', '9999-99-99T99:99:99Z'],
  ['September 31', '2026-09-31T10:15:30Z', 'not_a_date', '9999-99-99T99:99:99Z'],
  ['November 31', '2026-11-31T10:15:30Z', 'not_a_date', '9999-99-99T99:99:99Z'],
  ['February 29 of a year that is not a leap year', '2027-02-29T10:15:30Z', 'not_a_date', '9999-99-99T99:99:99Z'],
  ['February 29 of a century that is not a leap year', '1900-02-29T10:15:30Z', 'not_a_date', '9999-99-99T99:99:99Z'],
  ['month 13', '2026-13-01T10:15:30Z', 'not_a_date', '9999-99-99T99:99:99Z'],
  ['month 0', '2026-00-10T10:15:30Z', 'not_a_date', '9999-99-99T99:99:99Z'],
  ['day 0', '2026-12-00T10:15:30Z', 'not_a_date', '9999-99-99T99:99:99Z'],
  ['hour 24', '2026-12-01T24:00:00Z', 'not_a_date', '9999-99-99T99:99:99Z'],
  ['hour 25', '2026-12-01T25:00:00Z', 'not_a_date', '9999-99-99T99:99:99Z'],
  ['minute 60', '2026-12-01T10:60:00Z', 'not_a_date', '9999-99-99T99:99:99Z'],
  ['second 60, a leap second', '2026-12-01T10:15:60Z', 'not_a_date', '9999-99-99T99:99:99Z'],
  ['an offset of 24 hours', '2026-12-01T10:15:30+24:00', 'not_a_date', '9999-99-99T99:99:99+99:99'],
  ['an offset of 60 minutes', '2026-12-01T10:15:30+02:60', 'not_a_date', '9999-99-99T99:99:99+99:99'],
  // The same, in the forms that are accepted since decision item 1: a space for the T, and an offset without a colon or of hours.
  ['an offset of 24 hours, without a colon', '2026-12-01T10:15:30+2400', 'not_a_date', '9999-99-99T99:99:99+9999'],
  ['an offset of 24 hours, of hours only', '2026-12-01T10:15:30+24', 'not_a_date', '9999-99-99T99:99:99+99'],
  ['an offset of 60 minutes, without a colon', '2026-12-01T10:15:30+0260', 'not_a_date', '9999-99-99T99:99:99+9999'],
  ['February 30, with a space and an offset', '2026-02-30 10:15:30+02:00', 'not_a_date', '9999-99-99 99:99:99+99:99'],
  ['hour 24, with a space', '2026-12-01 24:00:00Z', 'not_a_date', '9999-99-99 99:99:99Z'],
  // RFC 3339 writes the year with four digits: a time whose UTC instant is in the year 10000 or before the year 0 cannot be
  // written, and is not made up.
  [
    'a time that falls in the year 10000 in UTC',
    '9999-12-31T23:59:59-01:00',
    'not_a_date',
    '9999-99-99T99:99:99-99:99',
  ],
  [
    'a time that falls before the year 0 in UTC',
    '0000-01-01T00:00:00+01:00',
    'not_a_date',
    '9999-99-99T99:99:99+99:99',
  ],
  // What stays refused, by form: a zone is Z, +HH:MM, +HHMM or +HH, directly after the time, and nothing is after it.
  ['an offset of one digit of hours', '2026-12-01T10:15:30+2:00', 'format', '9999-99-99T99:99:99+9:99'],
  ['an offset of one digit of minutes', '2026-12-01T10:15:30+02:0', 'format', '9999-99-99T99:99:99+99:9'],
  ['an offset of three digits', '2026-12-01T10:15:30+020', 'format', '9999-99-99T99:99:99+999'],
  ['an offset with seconds', '2026-12-01T10:15:30+02:00:00', 'format', '9999-99-99T99:99:99+99:99:99'],
  ['a space before the zone', '2026-12-01T10:15:30 Z', 'format', '9999-99-99T99:99:99 Z'],
  ['a space before the offset', '2026-12-01T10:15:30 +02:00', 'format', '9999-99-99T99:99:99 +99:99'],
  ['a space after the offset', '2026-12-01T10:15:30+02:00 ', 'format', '9999-99-99T99:99:99+99:99 '],
  ['a space before the date', ' 2026-12-01T10:15:30Z', 'format', ' 9999-99-99T99:99:99Z'],
  ['a line feed after the zone', '2026-12-01T10:15:30Z\n', 'format', '9999-99-99T99:99:99Z?'],
  ['a Z and an offset', '2026-12-01T10:15:30Z+02:00', 'format', '9999-99-99T99:99:99Z+99:99'],
  ['a zone name', '2026-12-01T10:15:30 UTC', 'format', '9999-99-99T99:99:99 ?T?'],
  [
    'a zone name in brackets after the offset',
    '2026-12-01T10:15:30+02:00[Africa/Cairo]',
    'format',
    '9999-99-99T99:99:99+99:99??????????????',
  ],
  // A time with no zone is accepted since decision item 2 (it names no instant), in the same profile, so the calendar and the form
  // apply to it as to the others.
  ['February 30, with no zone', '2026-02-30 10:15:30', 'not_a_date', '9999-99-99 99:99:99'],
  ['hour 24, with no zone', '2026-12-01T24:00:00', 'not_a_date', '9999-99-99T99:99:99'],
  ['second 60, with no zone', '2026-12-01T10:15:60.5', 'not_a_date', '9999-99-99T99:99:99.9'],
  ['a time with no zone and a space after it', '2026-12-01 10:15:30 ', 'format', '9999-99-99 99:99:99 '],
  ['a time with no zone and a point after it', '2026-12-01 10:15:30.', 'format', '9999-99-99 99:99:99.'],
  [
    'a time with no zone and ten fraction digits',
    '2026-12-01 10:15:30.1234567890',
    'format',
    '9999-99-99 99:99:99.9999999999',
  ],
  ['a time with no zone and no seconds', '2026-12-01 10:15', 'format', '9999-99-99 99:99'],
  ['a date with no time', '2026-12-01', 'format', '9999-99-99'],
  ['a time with no seconds', '2026-12-01T10:15Z', 'format', '9999-99-99T99:99Z'],
  ['written with slashes', '2026/12/01 10:15:30Z', 'format', '9999?99?99 99:99:99Z'],
  ['an epoch, as text', '1789999999', 'format', '9999999999'],
  [
    'one with more than nine fraction digits',
    '2026-12-01T10:15:30.1234567890Z',
    'format',
    '9999-99-99T99:99:99.9999999999Z',
  ],
  ['two spaces between the date and the time', '2026-12-01  10:15:30Z', 'format', '9999-99-99  99:99:99Z'],
  // The T of "UTC" is one of the characters kept; the U and the C are not.
  ['a date and time with text after them', '2026-12-01T10:15:30Z UTC', 'format', '9999-99-99T99:99:99Z ?T?'],
  ['written in lower case', '2026-12-01t10:15:30z', 'format', '9999-99-99?99:99:99?'],
  ['a comma for the fraction', '2026-12-01T10:15:30,5Z', 'format', '9999-99-99T99:99:99?9Z'],
  ['the basic form with no separators', '20261201T101530Z', 'format', '99999999T999999Z'],
  ['an empty text', '', 'format', ''],
  ['digits of another script', '٢٠٢٦-١٢-٠١', 'format', '????-??-??'],
  ['a character outside the basic plane', '2026-12-01\u{1F600}10:15:30Z', 'format', '9999-99-99?99:99:99Z'],
  // The value is a link: the letters and the other characters of it are masked, and only digits, T, Z, : and . are kept.
  ['a link', 'https://example.org/p?token=abc', 'format', '?????:?????????.???????????????'],
  // Cut at 40 characters, with an ellipsis after them: at most 41 characters of the shape.
  ['forty digits', '1'.repeat(40), 'format', '9'.repeat(40)],
  ['forty-one digits', '1'.repeat(41), 'format', '9'.repeat(40) + '…'],
  ['sixty letters', 'x'.repeat(60), 'format', '?'.repeat(40) + '…'],
];
const expirationMismatch = (reason: string, shape?: string): JsonObject => ({
  check: 'expiration',
  reason,
  entry: 0,
  ...(shape === undefined ? {} : {shape}),
});
const answerOf = (wanted: Wanted[], change: (answer: any) => unknown) => change(documentedResponse(wanted));

test('every answer that is not the pinned v25 shape still refuses, and names the check it failed and where', () => {
  const cases: Refusal[] = [
    ...refusals,
    ...linkRefusals.map(([label, wanted, field, value, reason]): Refusal => [
      'a link ' + label,
      [wanted],
      withLink(field, value),
      {check: 'link', reason, entry: 0, field},
    ]),
    ...expirationRefusals.map(([label, value, reason, shape]): Refusal => [
      'an expiry that is ' + label,
      [wantedUi],
      a => {
        previewsOf(a)[0].expirationDateTime = value;
        return a;
      },
      expirationMismatch(reason, shape),
    ]),
  ];
  const wrong: string[] = [];
  for (const [label, wanted, change, mismatch] of cases) {
    const p = compiled(wanted.map(targetOf)),
      data = answerOf(wanted, change);
    // The acceptance is what it was: every one of them is refused.
    if (googlePreviewOutcome(p, {status: 200, headers: {}, data}) !== false) wrong.push(label + ': accepted');
    const safe = googlePreviewSafeOutcome(p, {status: 200, data}).data;
    if (safe.native_response_valid !== false || safe.preview_results !== undefined) wrong.push(label + ': not refused');
    if (!/^[a-f0-9]{64}$/.test(String(safe.response_hash))) wrong.push(label + ': no response hash');
    try {
      assert.deepEqual(safe.response_mismatch, mismatch);
    } catch {
      wrong.push(label + ': says ' + JSON.stringify(safe.response_mismatch) + ', not ' + JSON.stringify(mismatch));
    }
    // The refusal that says the answer was not accepted (src/service.ts failedWrite) answers only for an outcome whose facts keep
    // to a closed vocabulary (src/errors.ts mismatchedAnswerDetails, lead review S4-1): every mismatch this family can name
    // must be within it, or the refusal would silently fall back to the advice to check access, scopes and tier.
    if (!mismatchedAnswerDetails(safe)) wrong.push(label + ': outside the vocabulary of the refusal');
  }
  assert.deepEqual(wrong, []);
  assert.ok(cases.length >= 40, String(cases.length));
});

// The other side of the calendar check (decision item 3): the dates that exist are accepted, at the ends of the day, the month and
// the year, on the leap days of the Gregorian calendar and with the largest offsets, so a calendar check that is too tight fails here.
test('the calendar: February 29 of a leap year, the ends of the day and the largest offsets are dates', () => {
  const p = compiled([ui]);
  for (const value of [
    '2028-02-29T10:15:30Z',
    '2000-02-29T10:15:30Z',
    '2026-04-30T10:15:30Z',
    '2026-06-30T10:15:30Z',
    '2026-09-30T10:15:30Z',
    '2026-11-30T10:15:30Z',
    // The 31st of each month that has one.
    ...[1, 3, 5, 7, 8, 10, 12].map(month => '2026-' + String(month).padStart(2, '0') + '-31T10:15:30Z'),
    '2026-12-31T23:59:59Z',
    '2026-01-01T00:00:00Z',
    '2026-12-01T10:15:30+23:59',
    '2026-12-01T10:15:30-12:00',
  ]) {
    const data = answerOf([wantedUi], a => {
      previewsOf(a)[0].expirationDateTime = value;
      return a;
    });
    const safe = googlePreviewSafeOutcome(p, {status: 200, data}).data;
    assert.equal(safe.native_response_valid, undefined, value);
    assert.equal(safe.response_mismatch, undefined, value);
    assert.equal(safe.preview_results.length, 1, value);
  }
});

test('an answer with another status, or that is no object, names that', () => {
  const p = compiled([ui]),
    good = documentedResponse([wantedUi]);
  assert.deepEqual(googlePreviewSafeOutcome(p, {status: 202, data: good}).data.response_mismatch, {
    check: 'status',
    reason: 'not_200',
    http_status: 202,
  });
  for (const data of [null, 'x', 5, [good]]) {
    assert.equal(googlePreviewOutcome(p, {status: 200, headers: {}, data: data as any}), false);
    assert.deepEqual(googlePreviewSafeOutcome(p, {status: 200, data}).data.response_mismatch, {
      check: 'body',
      reason: 'not_an_object',
    });
  }
  // Both are within the vocabulary of the refusal that says the answer was not accepted (see the table above).
  assert.ok(mismatchedAnswerDetails(googlePreviewSafeOutcome(p, {status: 202, data: good}).data), 'status');
  assert.ok(mismatchedAnswerDetails(googlePreviewSafeOutcome(p, {status: 200, data: null}).data), 'body');
  // The answer that matches is not described as a mismatch.
  assert.equal(googlePreviewOutcome(p, {status: 200, headers: {}, data: good}), true);
  const safe = googlePreviewSafeOutcome(p, {status: 200, data: good}).data;
  assert.equal(safe.response_mismatch, undefined);
  assert.equal(safe.native_response_valid, undefined);
  assert.equal(mismatchedAnswerDetails(safe), undefined);
});

test('the fields an answer adds are named only as plain identifiers, and at most eight', () => {
  const p = compiled([ui]),
    answer = documentedResponse([wantedUi]);
  const named = (extra: JsonObject) =>
    googlePreviewSafeOutcome(p, {status: 200, data: {...answer, ...extra}}).data.response_mismatch;
  // A name that is not an identifier (a link, a long text) is never repeated: it is counted as one other name.
  assert.deepEqual(
    named({requestId: 'x', 'a-b': 1, ['x'.repeat(50)]: 2, 'https://example.org/p?token=1': 3}).unexpected,
    ['requestId', '(other name)'],
  );
  const many = named(
    Object.fromEntries(Array.from({length: 12}, (_, i): [string, number] => ['extra' + i, i])),
  ).unexpected;
  assert.deepEqual(
    many,
    Array.from({length: 8}, (_, i) => 'extra' + i),
  );
});

test('a refused answer keeps its links out of the outcome, the audit and the refusal, and the replay names the same mismatch', async () => {
  const f = fixture();
  try {
    const r = await f.prepare([ui]);
    assert.equal(r.success, true, JSON.stringify(r));
    f.reply(() => answerOf([wantedUi], withLink('shareablePreviewUrl', 'https://127.0.0.1/leak-marker-one')));
    const e = await f.execute(r);
    assertRefused(e, 'WRITE_PARTIAL_OR_FAILED');
    const mismatch = {check: 'link', reason: 'host_not_accepted', entry: 0, field: 'shareablePreviewUrl'};
    assert.equal(e.data.data.native_response_valid, false);
    assert.deepEqual(e.data.data.response_mismatch, mismatch);
    // Nothing was generated for the caller: the answer is kept encrypted for recovery, never shown.
    assert.equal(e.data.previews.status, 'unavailable');
    assert.deepEqual(e.data.previews.results, []);
    assert.equal(e.data.previews.links_retained, true);
    assert.ok(!JSON.stringify(e).includes('leak-marker-one'));
    for (const table of clearText(f)) assert.ok(!table.includes('leak-marker-one'));
    assert.ok(f.store.document(actor.tenantId, 'preview_receipt', r.data.review_id).secret);
    // The one claim stays: the replay sends nothing and says the same. Every request counts, the reads of the sources too:
    // `writes()` would not show a replay that read them again (r12-gpreview, lead review S3-1).
    const sent = f.calls.length;
    const again = await f.execute(r);
    assert.equal(again.data.replayed, true);
    assert.deepEqual(again.data.data.response_mismatch, mismatch);
    assert.ok(!JSON.stringify(again).includes('leak-marker-one'));
    assert.equal(f.calls.length, sent);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

// r12-gpreview item 3. Found live 2026-11-16: the refusal of an answer that did not match told the caller to check access, scopes and
// tier, though nothing in the request was theirs to change. It says the answer was not accepted, carries the facts, and its
// remedy says a new request will not help and to report it. A failure the provider reports itself keeps what it said.
const mismatchMessage =
  'The provider answered, but its answer does not match what AMCP reviewed for this request, so AMCP did not accept it.';
test('the refusal of an answer that does not match says so, carries the facts and no link, and says to report it', async () => {
  const f = fixture();
  try {
    const r = await f.prepare([ui]);
    assert.equal(r.success, true, JSON.stringify(r));
    // An answer that is not the pinned shape: it adds a field, and carries a link that must never leave the encrypted receipt.
    f.reply(() => ({...documentedResponse([wantedUi]), requestId: 'trace-1'}));
    const e = await f.execute(r);
    assertRefused(e, 'WRITE_PARTIAL_OR_FAILED');
    assert.equal(e.error.message, mismatchMessage);
    assert.deepEqual(e.error.details, {
      native_response_valid: false,
      response_hash: e.data.data.response_hash,
      response_mismatch: {check: 'body', reason: 'unexpected_fields'},
    });
    // The provider's own field name stays in the outcome, under data (which the response marks as untrusted), never in the error.
    assert.deepEqual(e.data.data.response_mismatch.unexpected, ['requestId']);
    assert.ok(e.meta.untrusted_paths.includes('data'));
    assert.ok(!JSON.stringify(e.error).includes('requestId'));
    // The error's own copy of the facts is marked untrusted too, like the provider's rows of tokens (lead review S4-1).
    assert.deepEqual(e.meta.untrusted_paths, ['data', 'error.details.response_mismatch']);
    assert.ok(!JSON.stringify(e).includes('documented/preview-0'));
    // The remedy: what happened, that a new request will not help, and to report it; never to check access, scopes or tier.
    assert.match(e.error.remedy.action, /response did not match AMCP’s contract for this route/);
    assert.match(e.error.remedy.action, /A new request will not help\. Report these details to support\./);
    assert.doesNotMatch(e.error.remedy.action, /account access|granted scopes|access tier|payload/i);
    assert.equal(e.error.next_action, e.error.remedy.action);
    assert.deepEqual(
      [e.error.category, e.error.remedy.owner, e.error.remedy.mutation_retry_safe],
      ['provider', 'amcp', false],
    );
    // The family's own next step agrees with the refusal: no link is shown, so none is to be opened, and the mismatch is reported.
    assert.match(e.data.previews.next_action, /^No link is shown, because the provider’s answer did not match/);
    assert.match(e.data.previews.next_action, /report the mismatch in data\.response_mismatch to support/);
    assert.match(e.data.previews.next_action, /Never repeat a successful or uncertain generation automatically\.$/);
    assert.doesNotMatch(e.data.previews.next_action, /Open a generated link/);
    // The replay is the same refusal, and sends nothing: not a generation, and not a read either (S3-1).
    const sent = f.calls.length;
    const again = await f.execute(r);
    assert.deepEqual(again.error, e.error);
    assert.equal(again.data.previews.next_action, e.data.previews.next_action);
    assert.equal(f.calls.length, sent);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

// r12-gpreview, lead review S3-1: the exact path the lead will run on production. The live outcome was stored by the release
// before this one, so its stored row names no mismatch; replayed through the service, the refusal names it from the retained
// encrypted answer, and the replay sends no request at all. Once the receipt has gone (it lives 24 hours) the refusal holds only
// what the stored outcome holds.
test('the live path: an outcome stored without its mismatch is explained on replay from the retained answer, sends no request, and after the receipt expires names only what it holds', async () => {
  const f = fixture();
  try {
    const r = await f.prepare([ui]);
    assert.equal(r.success, true, JSON.stringify(r));
    // An answer whose only fault is an expiry outside the forms accepted (a time with no seconds: it was a time with no zone before
    // r25-m3-gpreview accepted that, as the lead's decision of 2026-11-18 asked).
    f.reply(() =>
      answerOf([wantedUi], a => {
        previewsOf(a)[0].expirationDateTime = '2026-12-01T10:15';
        return a;
      }),
    );
    const e = await f.execute(r);
    assertRefused(e, 'WRITE_PARTIAL_OR_FAILED');
    const named = {check: 'expiration', reason: 'format', entry: 0, shape: '9999-99-99T99:99'};
    assert.deepEqual(e.data.data.response_mismatch, named);
    // As production stored the live outcome: the stored row has no response_mismatch.
    const row = f.store.db
      .prepare('SELECT key,result FROM idempotency WHERE tenant_id=?')
      .get(actor.tenantId) as JsonObject;
    const stored = JSON.parse(row.result);
    assert.deepEqual(stored.data.response_mismatch, named, 'this release stores it');
    delete stored.data.response_mismatch;
    f.store.db
      .prepare('UPDATE idempotency SET result=? WHERE tenant_id=? AND key=?')
      .run(JSON.stringify(stored), actor.tenantId, row.key);
    // The replay names the mismatch from the retained answer, says the same, and sends nothing at all.
    const sent = f.calls.length;
    const again = await f.execute(r);
    assert.equal(again.data.replayed, true);
    assert.deepEqual(again.data.data.response_mismatch, named);
    assert.deepEqual(again.error.details.response_mismatch, named);
    assert.equal(again.error.message, e.error.message);
    assert.equal(f.calls.length, sent);
    // The receipt expires (the 24-hour retention): nothing left to name it from.
    const saved = f.store.document(actor.tenantId, 'preview_receipt', r.data.review_id);
    f.store.putDocument(actor.tenantId, 'preview_receipt', r.data.review_id, {...saved, expires_at: Date.now() - 1});
    const late = await f.execute(r);
    assert.equal(late.data.replayed, true);
    assert.equal(late.error.message, e.error.message);
    assert.deepEqual(late.error.details, {native_response_valid: false, response_hash: e.data.data.response_hash});
    assert.equal(late.data.data.response_mismatch, undefined);
    assert.equal(f.calls.length, sent);
    // The link is in none of the answers.
    for (const x of [e, again, late]) assert.ok(!JSON.stringify(x).includes('documented/preview-'));
  } finally {
    f.store.close();
  }
});

test('an entry that fails two of its checks still gets the refusal of an answer that does not match, with its list in the outcome only', async () => {
  const f = fixture();
  try {
    const r = await f.prepare([ui]);
    assert.equal(r.success, true, JSON.stringify(r));
    f.reply(() =>
      answerOf([wantedUi], a => {
        previewsOf(a)[0].uiPreviewResult.shareablePreviewUrl = 'https://127.0.0.1/preview';
        previewsOf(a)[0].expirationDateTime = 'tomorrow';
        return a;
      }),
    );
    const e = await f.execute(r);
    assertRefused(e, 'WRITE_PARTIAL_OR_FAILED');
    // The outcome names both; the list is part of the family's own vocabulary, so it does not stop the refusal from saying
    // the answer was not accepted (lead review S4-1), but only the first failure's own facts are in the error.
    assert.deepEqual(e.data.data.response_mismatch, {
      check: 'link',
      reason: 'host_not_accepted',
      entry: 0,
      field: 'shareablePreviewUrl',
      also: [{check: 'expiration', reason: 'format', entry: 0, shape: '????????'}],
    });
    assert.equal(e.error.message, mismatchMessage);
    assert.deepEqual(e.error.details, {
      native_response_valid: false,
      response_hash: e.data.data.response_hash,
      response_mismatch: {check: 'link', reason: 'host_not_accepted', entry: 0, field: 'shareablePreviewUrl'},
    });
    assert.match(e.error.remedy.action, /response did not match AMCP’s contract for this route/);
    assert.ok(!JSON.stringify(e).includes('documented/preview-'));
  } finally {
    f.store.close();
  }
});

// r25-m3-gpreview, decision item 4. The expiry the lead saw refused live was never observed exactly: the refusal named the check
// and the reason, not the value. It now names the shape of the value too, in the outcome and in the refusal, so that no further
// move of the guard needs a guess. The shape is a closed alphabet, so no text of the provider's reaches the outcome, an audit row
// or an error: a value that is a link or holds words shows as `?`.
test('the refusal of an expiry names its shape, in the outcome and in the error, and none of its text', async () => {
  for (const [value, shape] of [
    ['2026/12/01 10:15:30Z', '9999?99?99 99:99:99Z'],
    // A link of 48 characters: the first 40 of its shape, and the ellipsis.
    ['https://example.org/leak-marker-expiry?token=abc', '?????:?????????.????????-??????-????????…'],
    // Words with hyphens, longer than 40 characters: the hyphens are kept, the letters are not.
    ['not-an-expiry-leak-marker-expiry-with-more-than-forty-characters', '???-??-??????-????-??????-??????-????-??…'],
  ] as const) {
    const f = fixture();
    try {
      const r = await f.prepare([ui]);
      assert.equal(r.success, true, JSON.stringify(r));
      f.reply(() =>
        answerOf([wantedUi], a => {
          previewsOf(a)[0].expirationDateTime = value;
          return a;
        }),
      );
      const e = await f.execute(r);
      assertRefused(e, 'WRITE_PARTIAL_OR_FAILED');
      const named = {check: 'expiration', reason: 'format', entry: 0, shape};
      assert.deepEqual(e.data.data.response_mismatch, named, value);
      // The refusal carries the same facts: the shape is within the vocabulary it answers for.
      assert.equal(e.error.message, mismatchMessage);
      assert.deepEqual(e.error.details.response_mismatch, named, value);
      assert.match(shape, /^[9TZ+\-:. ?]{0,40}…?$/);
      // Nothing of the value is in the answer, the stored outcome, the audit or the error.
      assert.ok(!JSON.stringify(e).includes('leak-marker-expiry'));
      assert.ok(!JSON.stringify(e).includes('example.org'));
      for (const table of clearText(f)) assert.ok(!table.includes('leak-marker-expiry'));
      // The replay and `amcp_campaign verify` (lead review S4-4) say the same, from the same stored outcome, with no request.
      const sent = f.calls.length,
        again = await f.execute(r),
        v = await f.verify(r);
      assert.deepEqual(again.error.details.response_mismatch, named, value);
      assert.deepEqual(v.error.details.response_mismatch, named, value);
      assert.equal(f.calls.length, sent);
      assert.ok(!JSON.stringify([again, v]).includes('leak-marker-expiry'));
    } finally {
      f.store.close();
    }
  }
});

// r12-gpreview round 2, lead review S4-4. `amcp_campaign verify` on a failed outcome refuses before it reads anything ("Inspect
// the retained partial failure before recovery."); for an answer AMCP did not accept it had no details, so it still got the
// advice to check access, scopes and tier that the refusal of the execute no longer gives.
test('amcp_campaign verify on a refused answer gets the refusal of an answer that does not match, and on any other failure keeps its own', async () => {
  const f = fixture();
  try {
    const r = await f.prepare([ui]);
    assert.equal(r.success, true, JSON.stringify(r));
    f.reply(() => answerOf([wantedUi], withLink('shareablePreviewUrl', 'https://127.0.0.1/preview-verify-marker')));
    const e = await f.execute(r);
    assertRefused(e, 'WRITE_PARTIAL_OR_FAILED');
    const sent = f.calls.length;
    const v = await f.verify(r);
    assertRefused(v, 'WRITE_PARTIAL_OR_FAILED');
    // Its own message, and the facts the execute's refusal carried, so its remedy is the same one.
    assert.equal(v.error.message, 'Inspect the retained partial failure before recovery.');
    assert.deepEqual(v.error.details, e.error.details);
    assert.equal(v.error.details.response_mismatch.reason, 'host_not_accepted');
    assert.equal(v.error.remedy.action, e.error.remedy.action);
    assert.match(v.error.next_action, /response did not match AMCP’s contract for this route/);
    assert.doesNotMatch(v.error.next_action, /account access|granted scopes|access tier|payload/i);
    assert.deepEqual([v.error.category, v.error.remedy.owner], ['provider', 'amcp']);
    // Marked untrusted like the execute's, nothing is read or sent, and no link is in the answer.
    assert.deepEqual(v.meta.untrusted_paths, ['error.details.response_mismatch']);
    assert.equal(f.calls.length, sent);
    assert.ok(!JSON.stringify(v).includes('preview-verify-marker'));
  } finally {
    f.store.close();
  }
  // Any other failed outcome keeps the refusal it had: a partial answer the provider reported itself (a preview had expired).
  const g = fixture();
  try {
    const r = await g.prepare([ui, video]);
    g.mode('one_expired');
    assertRefused(await g.execute(r), 'WRITE_PARTIAL_OR_FAILED');
    const v = await g.verify(r);
    assertRefused(v, 'WRITE_PARTIAL_OR_FAILED');
    assert.equal(v.error.message, 'Inspect the retained partial failure before recovery.');
    assert.equal(v.error.details, undefined);
    assert.match(v.error.next_action, /Check account access, granted scopes, app access tier and payload/);
  } finally {
    g.store.close();
  }
});

test('a failure the provider reports itself, a partial answer, keeps its message and its remedy', async () => {
  const f = fixture();
  try {
    const r = await f.prepare([ui, video]);
    assert.equal(r.success, true, JSON.stringify(r));
    f.mode('one_expired');
    const e = await f.execute(r);
    assertRefused(e, 'WRITE_PARTIAL_OR_FAILED');
    // The answer matched what was reviewed (one preview of two had expired): nothing says it did not.
    assert.equal(e.data.data.native_response_valid, undefined);
    assert.equal(
      e.error.message,
      'Provider reported an incomplete or failed mutation; inspect the retained outcome before further action.',
    );
    assert.equal(e.error.details, undefined);
    assert.match(
      e.error.next_action,
      /Check account access, granted scopes, app access tier and payload against the named endpoint/,
    );
  } finally {
    f.store.close();
  }
});

// r12-gpreview item 2. Found live 2026-11-16: the review of a generation read "Change 1  in account …", an entity that was
// blank between two spaces. Google's summarizer knew only its :mutate operations, and this route lists none.
test('the review summary says what a generation does: it generates the previews it lists, and names them', async () => {
  const f = fixture();
  try {
    for (const [previews, count, text] of [
      [[ui], 1, 'Generate 1 shareable preview in account 123.'],
      [[ui, second], 2, 'Generate 2 shareable previews in account 123.'],
      [[ui, video], 2, 'Generate 2 shareable previews in account 123.'],
    ] as const) {
      for (const action of [rpc, 'GENERATE_SHAREABLE_PREVIEWS']) {
        const r = await f.prepare([...previews], action);
        assert.equal(r.success, true, JSON.stringify(r));
        const s = r.data.summary;
        assert.deepEqual([s.operation, s.entity, s.count], ['generate', 'shareable preview', count], action);
        assert.equal(s.text, text, action);
        assert.doesNotMatch(s.text, /\s\s/);
        // The summary stays a summary of what the exact request below sends: no money and no status are made up for it.
        assert.equal(s.money, undefined);
        assert.equal(s.status, undefined);
      }
    }
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('an outcome stored before the mismatch was named is explained from the retained answer when it is delivered again', () => {
  const p = compiled([ui]),
    raw = answerOf([wantedUi], withLink('shareablePreviewUrl', 'https://127.0.0.1/leak-marker-two')) as JsonObject,
    stored: JsonObject = {
      success: false,
      executed: true,
      outcome: 'partial_or_failed',
      status: 200,
      data: {native_response_valid: false, response_hash: 'a'.repeat(64)},
      failures: [{path: '$', message: 'The response does not match the reviewed previews.'}],
    };
  const delivered = googlePreviewDelivery(p, stored, raw);
  assert.deepEqual(delivered.data.response_mismatch, {
    check: 'link',
    reason: 'host_not_accepted',
    entry: 0,
    field: 'shareablePreviewUrl',
  });
  assert.equal(delivered.data.native_response_valid, false);
  assert.equal(delivered.previews.status, 'unavailable');
  assert.deepEqual(delivered.previews.results, []);
  assert.ok(!JSON.stringify(delivered).includes('leak-marker-two'));
  // With the retained answer gone there is nothing to explain from, and nothing is invented.
  assert.equal(googlePreviewDelivery(p, stored, undefined).data.response_mismatch, undefined);
  // An answer that does match adds no mismatch to an outcome.
  const good = documentedResponse([wantedUi]);
  assert.equal(
    googlePreviewDelivery(p, {...stored, success: true, data: {preview_results: []}}, good).data.response_mismatch,
    undefined,
  );
});

// r12-gpreview round 2, lead review S4-2. What a delivery shows, and says to do, follows one condition: whether the stored outcome
// says it was refused (`native_response_valid: false`). A stored refusal stays a refusal when a later release's guard accepts the
// answer it kept: the replay never delivers its links, says that the guard accepts it now, and that a fresh generation (a new
// review) is what delivers links.
const refusedOutcome = (): JsonObject => ({
  success: false,
  executed: true,
  outcome: 'partial_or_failed',
  status: 200,
  data: {native_response_valid: false, response_hash: 'a'.repeat(64)},
  failures: [{path: '$', message: 'The response does not match the reviewed previews.'}],
});
const acceptedOutcome = (): JsonObject => ({
  success: true,
  executed: true,
  outcome: 'succeeded',
  status: 200,
  data: {preview_results: []},
});
const acceptedNow = {check: 'none', reason: 'accepted_now'};

test('a stored refusal stays a refusal: when a later guard accepts the answer it kept, no link is delivered and a fresh generation is needed', async () => {
  const f = fixture();
  try {
    const r = await f.prepare([ui]);
    assert.equal(r.success, true, JSON.stringify(r));
    f.reply(() => answerOf([wantedUi], withLink('shareablePreviewUrl', 'https://127.0.0.1/preview-before')));
    const e = await f.execute(r);
    assertRefused(e, 'WRITE_PARTIAL_OR_FAILED');
    assert.equal(e.data.data.response_mismatch.reason, 'host_not_accepted');
    // A later release accepts that answer. The guard is code, so the test reaches the same state by keeping an answer the guard
    // accepts under the outcome that was stored as refused.
    f.store.savePreviewReceipt(actor.tenantId, r.data.review_id, documentedResponse([wantedUi]));
    const sent = f.calls.length;
    const again = await f.execute(r);
    assert.equal(again.data.replayed, true);
    assertRefused(again, 'WRITE_PARTIAL_OR_FAILED');
    // The links the answer now holds are delivered to no one, and the delivery says why.
    assert.ok(!JSON.stringify(again).includes('documented/preview-'));
    assert.equal(again.data.previews.status, 'unavailable');
    assert.deepEqual(again.data.previews.results, []);
    assert.equal(again.data.previews.links_retained, true);
    assert.deepEqual(again.data.data.response_mismatch, acceptedNow);
    assert.deepEqual(again.error.details.response_mismatch, acceptedNow);
    assert.match(again.data.previews.next_action, /^No link is shown\. This answer was not accepted when it arrived/);
    assert.match(again.data.previews.next_action, /A fresh generation needs a new review\./);
    assert.match(again.data.previews.next_action, /Never repeat a successful or uncertain generation automatically\.$/);
    assert.doesNotMatch(again.data.previews.next_action, /Open a generated link|report the mismatch/);
    assert.equal(f.calls.length, sent);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('the delivery of a stored refusal, and of a stored acceptance, follow one condition: what the stored outcome says', () => {
  const p = compiled([ui]),
    good = documentedResponse([wantedUi]) as JsonObject,
    refusedRaw = answerOf(
      [wantedUi],
      withLink('shareablePreviewUrl', 'https://127.0.0.1/leak-marker-three'),
    ) as JsonObject;
  // Refused, and the answer is still refused: the mismatch and the step that reports it, no link.
  const still = googlePreviewDelivery(p, refusedOutcome(), refusedRaw);
  assert.deepEqual(still.data.response_mismatch, {
    check: 'link',
    reason: 'host_not_accepted',
    entry: 0,
    field: 'shareablePreviewUrl',
  });
  assert.match(still.previews.next_action, /^No link is shown, because the provider’s answer did not match/);
  assert.match(still.previews.next_action, /report the mismatch in data\.response_mismatch/);
  // Refused, and the guard accepts the answer now: said so, no link, and a fresh generation.
  const now = googlePreviewDelivery(p, refusedOutcome(), good);
  assert.deepEqual(now.data.response_mismatch, acceptedNow);
  assert.equal(now.data.native_response_valid, false);
  assert.equal(now.previews.status, 'unavailable');
  assert.deepEqual(now.previews.results, []);
  assert.match(now.previews.next_action, /A fresh generation needs a new review\./);
  assert.ok(!JSON.stringify(now).includes('documented/preview-'));
  // Not refused, and the answer is accepted: the links, with the step to open them, and no mismatch.
  const open = googlePreviewDelivery(p, acceptedOutcome(), good);
  assert.equal(open.data.response_mismatch, undefined);
  assert.equal(open.previews.status, 'generated');
  assert.equal(open.previews.results.length, 1);
  assert.match(open.previews.next_action, /^Open a generated link/);
  // Not refused, and every preview of the accepted answer has expired: no link is shown, and the step says why (found-not-fixed
  // 2 of the first review), where "Open a generated link" named one that is not there.
  const lapsed = documentedResponse([wantedUi]) as JsonObject;
  previewsOf(lapsed)[0].expirationDateTime = new Date(Date.now() - 60000).toISOString();
  const expired = googlePreviewDelivery(p, acceptedOutcome(), lapsed);
  assert.equal(expired.previews.status, 'unavailable');
  assert.deepEqual(
    expired.previews.results.map((x: JsonObject) => x.status),
    ['expired'],
  );
  assert.match(
    expired.previews.next_action,
    /^The links of this generation have expired and none is shown\. A new generation needs a new review\. Never repeat a successful or uncertain generation automatically\.$/,
  );
  assert.doesNotMatch(expired.previews.next_action, /Open a generated link/);
  assert.ok(!JSON.stringify(expired).includes('documented/preview-'));
  // Some previews still live: the step it had.
  const half = documentedResponse([wantedUi, wantedSecond]) as JsonObject;
  previewsOf(half)[1].expirationDateTime = new Date(Date.now() - 60000).toISOString();
  const some = googlePreviewDelivery(compiled([ui, second]), acceptedOutcome(), half);
  assert.equal(some.previews.status, 'partial');
  assert.match(some.previews.next_action, /^Open a generated link/);
  // Not refused, and the answer is not accepted now (a later release tightened the guard): no link, no mismatch named in the
  // outcome, and a step that does not point to one.
  const tightened = googlePreviewDelivery(p, acceptedOutcome(), refusedRaw);
  assert.equal(tightened.data.response_mismatch, undefined);
  assert.equal(tightened.previews.status, 'unavailable');
  assert.deepEqual(tightened.previews.results, []);
  assert.match(
    tightened.previews.next_action,
    /^No link is shown, because this release of AMCP does not accept the answer kept for this generation\. A new generation needs a new review\./,
  );
  assert.doesNotMatch(tightened.previews.next_action, /response_mismatch/);
  assert.ok(!JSON.stringify(tightened).includes('leak-marker-three'));
  // No receipt: nothing to show or to name, whatever the outcome says.
  for (const outcome of [refusedOutcome(), acceptedOutcome()]) {
    const gone = googlePreviewDelivery(p, outcome, undefined);
    assert.equal(gone.data.response_mismatch, undefined);
    assert.deepEqual(gone.previews.results, []);
    assert.match(gone.previews.next_action, /^Private preview links expired locally/);
  }
});

// r25-m3-gpreview, the lead's decision of 2026-11-18 for `expiration` / `format`, item 1. Google's document says only "ISO-8601"
// for `expirationDateTime`, and the form it sends was never observed: the live refusal named the check and the reason, not the
// value. So the guard accepts, as an instant, the plausible forms of ISO-8601: YYYY-MM-DD, then T or one space, then HH:MM:SS,
// an optional fraction of 1 to 9 digits, then a zone, Z or +HH:MM or +HHMM or +HH. The instant is read by the guard itself and
// delivered as RFC 3339 UTC (`expiration_date_time`), `expired` is computed from it as it always was, and the links are delivered.
const instants: [label: string, value: string, utc: string][] = [
  ['the form accepted before, with Z', '2099-12-01T10:15:30Z', '2099-12-01T10:15:30Z'],
  ['a fraction of one digit', '2099-12-01T10:15:30.5Z', '2099-12-01T10:15:30.5Z'],
  ['a fraction of nine digits', '2099-12-01T10:15:30.123456789Z', '2099-12-01T10:15:30.123456789Z'],
  ['an offset with a colon', '2099-12-01T10:15:30+02:00', '2099-12-01T08:15:30Z'],
  ['a negative offset with a colon', '2099-12-01T10:15:30-05:30', '2099-12-01T15:45:30Z'],
  ['an offset of hours and minutes', '2099-12-01T10:15:30+0200', '2099-12-01T08:15:30Z'],
  ['a negative offset of hours and minutes', '2099-12-01T10:15:30-0530', '2099-12-01T15:45:30Z'],
  ['an offset of hours', '2099-12-01T10:15:30+02', '2099-12-01T08:15:30Z'],
  ['a negative offset of hours', '2099-12-01T10:15:30-05', '2099-12-01T15:15:30Z'],
  ['a space for the T, with Z', '2099-12-01 10:15:30Z', '2099-12-01T10:15:30Z'],
  ['a space for the T, with an offset with a colon', '2099-12-01 10:15:30+02:00', '2099-12-01T08:15:30Z'],
  ['a space, a fraction and an offset of hours and minutes', '2099-12-01 10:15:30.25-0530', '2099-12-01T15:45:30.25Z'],
  ['a fraction and an offset with a colon', '2099-12-01T10:15:30.987654321+02:00', '2099-12-01T08:15:30.987654321Z'],
  ['an offset that moves the date back', '2099-12-01T01:00:00+02:00', '2099-11-30T23:00:00Z'],
  ['an offset that moves the date on, over the end of the year', '2099-12-31T23:30:00-01:00', '2100-01-01T00:30:00Z'],
  ['an offset that moves a leap day on', '2096-02-29T23:30:00-01:00', '2096-03-01T00:30:00Z'],
  ['an offset of zero', '2099-12-01T10:15:30+00:00', '2099-12-01T10:15:30Z'],
  ['an offset of minus zero', '2099-12-01T10:15:30-00:00', '2099-12-01T10:15:30Z'],
  ['the largest offset', '2099-12-01T10:15:30+23:59', '2099-11-30T10:16:30Z'],
  ['the last second that RFC 3339 can write', '9999-12-31T23:59:59Z', '9999-12-31T23:59:59Z'],
];
const answerWith = (value: unknown) =>
  answerOf([wantedUi], a => {
    previewsOf(a)[0].expirationDateTime = value;
    return a;
  });

test('every plausible form of an instant is accepted, delivered as RFC 3339 UTC, with the instant known and the links delivered', async () => {
  const p = compiled([ui]);
  for (const [label, value, utc] of instants) {
    const safe = googlePreviewSafeOutcome(p, {status: 200, data: answerWith(value)}).data;
    assert.equal(safe.native_response_valid, undefined, label + ': ' + JSON.stringify(safe.response_mismatch));
    assert.deepEqual(
      safe.preview_results.map((x: JsonObject) => [x.status, x.expiration_known, x.expiration_date_time]),
      [['generated', true, utc]],
      label,
    );
    assert.equal(googlePreviewOutcome(p, {status: 200, headers: {}, data: answerWith(value)}), true, label);
    // The instant carries no text and no zone note: those are only for a time that names no instant.
    assert.equal(safe.preview_results[0].expiration_text, undefined, label);
    assert.equal(safe.preview_results[0].expiration_zone, undefined, label);
  }
  // A fresh generation delivers the links, with the instant, for each form (the service, the receipt and the delivery included).
  for (const [label, value, utc] of instants) {
    const f = fixture();
    try {
      const r = await f.prepare([ui]);
      assert.equal(r.success, true, JSON.stringify(r));
      f.reply(() => answerWith(value));
      const e = await f.execute(r);
      assert.equal(e.success, true, label + ': ' + JSON.stringify(e.error));
      assert.equal(e.data.data.native_response_valid, undefined, label);
      assert.equal(e.data.previews.status, 'generated', label);
      const [row] = e.data.previews.results;
      assert.equal(row.shareablePreviewUrl, 'https://ads.google.com/documented/preview-0', label);
      assert.deepEqual([row.status, row.expiration_known, row.expiration_date_time], ['generated', true, utc], label);
      assert.match(e.data.previews.next_action, /^Open a generated link/, label);
      assert.equal((await f.verify(r)).data.status, 'verified', label);
      assert.equal(f.writes(), 1, label);
    } finally {
      f.store.close();
    }
  }
});

/** The text of the instant `ms` as a time east of UTC by `offsetMinutes` (west when negative), written in the given form. */
const written = (
  ms: number,
  separator: 'T' | ' ',
  zone: 'Z' | 'colon' | 'compact' | 'hours',
  offsetMinutes = 0,
): string => {
  const local = new Date(ms + offsetMinutes * 60000).toISOString().slice(0, 19).replace('T', separator),
    sign = offsetMinutes < 0 ? '-' : '+',
    abs = Math.abs(offsetMinutes),
    hh = String(Math.floor(abs / 60)).padStart(2, '0'),
    mm = String(abs % 60).padStart(2, '0');
  return (
    local +
    (zone === 'Z' ? 'Z' : zone === 'colon' ? sign + hh + ':' + mm : zone === 'compact' ? sign + hh + mm : sign + hh)
  );
};
const zones: ['T' | ' ', 'Z' | 'colon' | 'compact' | 'hours', number][] = [
  ['T', 'Z', 0],
  [' ', 'Z', 0],
  ['T', 'colon', 120],
  [' ', 'colon', -330],
  [' ', 'compact', 330],
  ['T', 'compact', -480],
  ['T', 'hours', -300],
  [' ', 'hours', 120],
];

test('an instant in any form is expired from its own offset: a minute ago is expired, an hour from now is not', () => {
  const p = compiled([ui]),
    now = Date.now();
  for (const [separator, zone, offset] of zones) {
    const past = written(now - 60000, separator, zone, offset),
      future = written(now + 3600000, separator, zone, offset);
    const [late] = googlePreviewSafeOutcome(p, {status: 200, data: answerWith(past)}).data.preview_results,
      [soon] = googlePreviewSafeOutcome(p, {status: 200, data: answerWith(future)}).data.preview_results;
    assert.deepEqual([late?.status, late?.expiration_known], ['expired', true], past);
    assert.deepEqual([soon?.status, soon?.expiration_known], ['generated', true], future);
    // The instant is the same one, whatever way it is written.
    assert.equal(Date.parse(late.expiration_date_time), Math.floor((now - 60000) / 1000) * 1000, past);
    assert.equal(Date.parse(soon.expiration_date_time), Math.floor((now + 3600000) / 1000) * 1000, future);
  }
  // An expired preview shows no link, and the delivery says that the links expired (an expiry given with an offset, as any other).
  const lapsed = answerWith(written(now - 60000, ' ', 'colon', 120)),
    delivered = googlePreviewDelivery(
      p,
      {success: true, executed: true, outcome: 'succeeded', status: 200, data: {preview_results: []}},
      lapsed as JsonObject,
    );
  assert.deepEqual(
    delivered.previews.results.map((x: JsonObject) => x.status),
    ['expired'],
  );
  assert.equal(delivered.previews.status, 'unavailable');
  assert.ok(!JSON.stringify(delivered).includes('documented/preview-'));
  assert.match(delivered.previews.next_action, /^The links of this generation have expired and none is shown\./);
});

// r25-m3-gpreview, decision item 2. The same forms with no zone name no instant: the guard never guesses one, not the server's zone
// and not the account's. The preview is delivered with its links, `expiration_known: false`, no instant, the text as Google wrote it
// (which, by passing the form, holds only digits and - : . T and the space) and `expiration_zone: 'not_given'`. It is never `expired`.
const zoneless: [label: string, value: string][] = [
  ['a T and no zone', '2099-12-01T10:15:30'],
  ['a space and no zone', '2099-12-01 10:15:30'],
  ['a fraction of one digit', '2099-12-01 10:15:30.5'],
  ['a fraction of nine digits', '2099-12-01T10:15:30.123456789'],
  // Long ago: the text alone cannot say that it has passed, whatever the zone would be.
  ['a time long ago', '2001-01-01 00:00:00'],
  ['the leap day', '2096-02-29T12:00:00'],
];
const notGiven = (value: string) => ({
  status: 'generated',
  expiration_known: false,
  expiration_date_time: null,
  expiration_text: value,
  expiration_zone: 'not_given',
});

test('a time with no zone is accepted with no instant: its text and "not given", never expired, links delivered', async () => {
  const p = compiled([ui]);
  for (const [label, value] of zoneless) {
    const safe = googlePreviewSafeOutcome(p, {status: 200, data: answerWith(value)}).data;
    assert.equal(safe.native_response_valid, undefined, label + ': ' + JSON.stringify(safe.response_mismatch));
    const [row] = safe.preview_results;
    // The row says exactly this about the expiry, and nothing else of it.
    assert.deepEqual(
      Object.fromEntries(Object.entries(row).filter(([k]) => k.startsWith('expiration_') || k === 'status')),
      notGiven(value),
      label,
    );
    assert.equal(googlePreviewOutcome(p, {status: 200, headers: {}, data: answerWith(value)}), true, label);
  }
  // A fresh generation delivers the links, the text and the note, for each of them (and the verification accepts it).
  for (const [label, value] of zoneless) {
    const f = fixture();
    try {
      const r = await f.prepare([ui]);
      assert.equal(r.success, true, JSON.stringify(r));
      f.reply(() => answerWith(value));
      const e = await f.execute(r);
      assert.equal(e.success, true, label + ': ' + JSON.stringify(e.error));
      assert.equal(e.data.data.native_response_valid, undefined, label);
      assert.equal(e.data.previews.status, 'generated', label);
      const [row] = e.data.previews.results;
      assert.equal(row.shareablePreviewUrl, 'https://ads.google.com/documented/preview-0', label);
      assert.deepEqual(
        Object.fromEntries(Object.entries(row).filter(([k]) => k.startsWith('expiration_') || k === 'status')),
        notGiven(value),
        label,
      );
      assert.match(e.data.previews.next_action, /^Open a generated link/, label);
      // The text is in the stored outcome too (it holds no link and nothing of the provider's but digits and punctuation).
      assert.equal(e.data.data.preview_results[0].expiration_text, value, label);
      assert.equal((await f.verify(r)).data.status, 'verified', label);
      assert.equal(f.writes(), 1, label);
    } finally {
      f.store.close();
    }
  }
});

test('a time with no zone is read the same under every time zone of the process, and is never expired by one', () => {
  const p = compiled([ui]),
    now = Date.now(),
    // The text of a minute ago and of an hour from now, as UTC would write them but with no zone: any zone the guard could guess
    // (the server's, the account's) would put one of them on the other side of now.
    ago = new Date(now - 60000).toISOString().slice(0, 19).replace('T', ' '),
    soon = new Date(now + 3600000).toISOString().slice(0, 19),
    values = [...zoneless.map(([, value]) => value), ago, soon],
    rowsOf = (value: string) =>
      googlePreviewSafeOutcome(p, {status: 200, data: answerWith(value)}).data.preview_results[0];
  const was = process.env.TZ;
  try {
    const engine: number[] = [],
      readings: string[] = [];
    for (const zone of ['UTC', 'Pacific/Auckland', 'America/Los_Angeles', 'Africa/Cairo']) {
      process.env.TZ = zone;
      // The engine itself reads a time with no zone in the zone of the process: that is what the guard must not rely on.
      engine.push(Date.parse(soon));
      readings.push(JSON.stringify(values.map(rowsOf)));
      for (const value of values) {
        const row = rowsOf(value);
        assert.deepEqual(
          [row.status, row.expiration_known, row.expiration_date_time, row.expiration_zone],
          ['generated', false, null, 'not_given'],
          zone + ' ' + value,
        );
      }
    }
    assert.equal(new Set(engine).size, 4, 'the time zone of the process was not changed: ' + engine.join(','));
    assert.equal(new Set(readings).size, 1, 'the rows differ with the time zone of the process');
    // An instant with a zone is the same under each of them too.
    const instantRows = new Set<string>();
    for (const zone of ['UTC', 'Pacific/Auckland', 'America/Los_Angeles']) {
      process.env.TZ = zone;
      instantRows.add(JSON.stringify(instants.map(([, value]) => rowsOf(value))));
    }
    assert.equal(instantRows.size, 1);
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
});

test('the live review, refused when its expiry was in a form the guard did not accept, replays as a refusal that is accepted now, and a fresh generation delivers the links', async () => {
  const f = fixture();
  try {
    const r = await f.prepare([ui]);
    assert.equal(r.success, true, JSON.stringify(r));
    // The live answer, as the release before this one saw it: refused for its expiry. (Its form was never observed; a time with no
    // seconds stands for one that is still refused.)
    f.reply(() => answerWith('2099-12-01T10:15'));
    const e = await f.execute(r);
    assertRefused(e, 'WRITE_PARTIAL_OR_FAILED');
    assert.equal(e.data.data.response_mismatch.check, 'expiration');
    // What the retained answer holds is a form this release accepts (a space, no zone): a replay is still the refusal that was
    // stored, with no link, and says that the guard accepts the answer now.
    f.store.savePreviewReceipt(actor.tenantId, r.data.review_id, answerWith('2099-12-01 10:15:30') as JsonObject);
    const sent = f.calls.length;
    const again = await f.execute(r);
    assert.equal(again.data.replayed, true);
    assertRefused(again, 'WRITE_PARTIAL_OR_FAILED');
    assert.deepEqual(again.data.data.response_mismatch, acceptedNow);
    assert.deepEqual(again.error.details.response_mismatch, acceptedNow);
    assert.equal(again.data.previews.status, 'unavailable');
    assert.deepEqual(again.data.previews.results, []);
    assert.match(again.data.previews.next_action, /A fresh generation needs a new review\./);
    assert.ok(!JSON.stringify(again).includes('documented/preview-'));
    assert.equal(f.calls.length, sent);
    // A fresh generation, on a new review, with that form: the links are delivered.
    const fresh = await f.prepare([ui]);
    assert.equal(fresh.success, true, JSON.stringify(fresh));
    f.reply(() => answerWith('2099-12-01 10:15:30'));
    const delivered = await f.execute(fresh);
    assert.equal(delivered.success, true, JSON.stringify(delivered.error));
    assert.equal(delivered.data.previews.status, 'generated');
    assert.equal(delivered.data.previews.results[0].shareablePreviewUrl, 'https://ads.google.com/documented/preview-0');
    assert.equal(delivered.data.data.response_mismatch, undefined);
  } finally {
    f.store.close();
  }
});

test('an expiry in a year below 100 is an instant of the past, read from its text and not by the engine’s constructors', () => {
  // The engine's Date.UTC and its constructors read the year 26 as 1926; the text of an ISO date is read as it is written.
  const p = compiled([ui]);
  const [row] = googlePreviewSafeOutcome(p, {status: 200, data: answerWith('0026-12-01 10:15:30+02:00')}).data
    .preview_results;
  assert.deepEqual(
    [row.status, row.expiration_known, row.expiration_date_time],
    ['expired', true, '0026-12-01T08:15:30Z'],
  );
});
