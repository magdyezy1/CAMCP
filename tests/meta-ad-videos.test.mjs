import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Removing videos from a Meta ad account's video library (Marketing API "Ad Account Advideos" reference, Deleting, read
 * 2026-09-29): DELETE act_{ad_account_id}/advideos with the required `video_id` dissociates the video from the account
 * and answers {success}. Meta does not say what happens to creatives using it, so AMCP reads every creative first.
 */
const gateway = 'meta_native_action',
  registry = new Registry(),
  action = 'meta_ad_account_id_advideos_delete';
const actor = {tenantId: 'meta-ad-videos', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
function fixture(mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 86).toString('base64')),
    calls = [];
  let writes = 0;
  store.putConnection(
    owner,
    {
      id: 'm',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: ['ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  const videos = new Map(
    ['7001', '7002', '7003', '7004', '7005'].map((id, i) => [
      id,
      {id, title: 'clip ' + i, created_time: '2026-09-0' + (i + 1)},
    ]),
  );
  // 7002 is in a Page story creative, 7003 in an asset feed, 7004 only in a deleted creative, 7005 in a creative field.
  const creatives = [
    {id: '801', name: 'story', status: 'ACTIVE', object_story_spec: {page_id: '500', video_data: {video_id: '7002'}}},
    {id: '802', name: 'feed', status: 'WITH_ISSUES', asset_feed_spec: {videos: [{video_id: 7003}]}},
    {id: '803', name: 'old', status: 'DELETED', object_story_spec: {page_id: '500', video_data: {video_id: '7004'}}},
    {id: '804', name: 'direct', status: 'IN_PROCESS', video_id: '7005'},
    {
      id: '805',
      name: 'image',
      status: 'ACTIVE',
      object_story_spec: {page_id: '500', link_data: {link: 'https://e.com'}},
    },
  ];
  const page = (rows, u) => {
    const at = Number(u.searchParams.get('after') ?? 0),
      next = mode === 'endless' ? at + 1 : at + 2 < rows.length ? at + 2 : undefined;
    return Response.json({
      data: rows.slice(at, at + 2),
      ...(next !== undefined
        ? {paging: {cursors: {after: String(next)}, next: 'https://graph.facebook.com/next'}}
        : {}),
    });
  };
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init.method;
      calls.push({path, method, query: Object.fromEntries(u.searchParams)});
      if (method === 'GET' && path === '/v26.0/act_123/advideos') return page([...videos.values()], u);
      if (method === 'GET' && path === '/v26.0/act_123/adcreatives') return page(creatives, u);
      if (method !== 'DELETE' || path !== '/v26.0/act_123/advideos')
        throw new Error('Unexpected ' + method + ' ' + path);
      writes++;
      const id =
        u.searchParams.get('video_id') ?? Object.fromEntries(new URLSearchParams(String(init.body ?? ''))).video_id;
      if (!videos.has(id)) return Response.json({error: {message: 'Invalid parameter', code: 100}}, {status: 400});
      if (mode !== 'ignore') videos.delete(id);
      return Response.json({success: true});
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    100,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = (video_id, extra = {}, request = {}) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action, account_id: '123', params: {video_id, ...extra}, ...request}},
      actor,
    );
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, videos, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('an unused library video is removed after every page of videos and creatives is read, and verifies as gone', async () => {
  const f = fixture();
  try {
    const p = ok(await f.prepare('7001'));
    assert.equal(p.data.request.destructive, true);
    assert.equal(p.data.creative_impact.scope, 'ad_video');
    assert.equal(p.data.creative_impact.video.title, 'clip 0');
    assert.equal(p.data.creative_impact.creatives_read, 5);
    // Both lists were read to the end, two rows a page.
    assert.equal(f.calls.filter(c => c.path.endsWith('/advideos') && c.method === 'GET').length, 3);
    assert.equal(f.calls.filter(c => c.path.endsWith('/adcreatives')).length, 3);
    ok(await f.execute(p));
    assert.equal(f.videos.has('7001'), false);
    const v = ok(await f.verify(p));
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 900));
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
  const o = fixture();
  try {
    saveSpendPolicy(o.store, owner, {gateway, account_id: '123', confirmed: true, policy: {allow_deletion: false}});
    assert.equal((await o.prepare('7001')).error?.code, 'POLICY_DELETION_FORBIDDEN');
  } finally {
    o.store.close();
  }
});

test('a video a creative of the account uses is refused, naming the creatives; a deleted creative does not count', async () => {
  const f = fixture();
  try {
    for (const [video, creative] of [
      ['7002', '801'],
      ['7003', '802'],
      ['7005', '804'],
    ]) {
      const r = await f.prepare(video);
      assert.equal(r.error?.code, 'MEDIA_IN_USE', video + ': ' + JSON.stringify(r).slice(0, 400));
      assert.deepEqual(r.error.details.creative_ids, [creative]);
    }
    ok(await f.prepare('7004'));
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('malformed requests are refused before any request; unknown videos and unbounded lists after reading', async () => {
  for (const [label, id, extra, request] of [
    ['non-numeric id', 'abc', {}, {}],
    ['missing id', undefined, {}, {}],
    ['extra parameter', '7001', {fields: 'id'}, {}],
    ['body', '7001', {}, {payload: {video_id: '7001'}}],
  ]) {
    const f = fixture();
    try {
      const r = await f.prepare(id, extra, request);
      assert.equal(r.success, false, label);
      assert.equal(f.calls.length, 0, label + ': ' + JSON.stringify(r).slice(0, 300));
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    assert.equal((await f.prepare('7999')).error?.code, 'STATE_NOT_FOUND');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
  const g = fixture('endless');
  try {
    assert.equal((await g.prepare('7001')).error?.code, 'INCOMPLETE_STATE');
    assert.equal(g.writes(), 0);
  } finally {
    g.store.close();
  }
});

test('an ignored removal is not verified, and the ledger lists the write under its family', async () => {
  const g = fixture('ignore');
  try {
    const p = ok(await g.prepare('7001'));
    ok(await g.execute(p));
    assert.notEqual(ok(await g.verify(p)).data.status, 'verified');
  } finally {
    g.store.close();
  }
  const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'reviewed_write_family');
  assert.equal(rows[0].family, 'meta_ad_videos');
});
