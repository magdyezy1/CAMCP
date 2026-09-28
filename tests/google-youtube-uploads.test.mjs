import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * YouTube video uploads made through the Google Ads API, v23 (pinned Discovery document: YouTubeVideoUploadService
 * UpdateYouTubeVideoUpload and RemoveYouTubeVideoUpload; checked 2026-09-27): privacy of brand channel videos, and removal.
 */
const gateway = 'google_ads_native_action',
  registry = new Registry(),
  C = 'customers/123/';
const actions = {
  update: 'google_ads_v23_you_tube_video_upload_update_you_tube_video_upload',
  remove: 'google_ads_v23_you_tube_video_upload_remove_you_tube_video_upload',
  updateLegacy: 'UPDATE_YOUTUBE_VIDEO_UPLOAD',
  removeLegacy: 'REMOVE_YOUTUBE_VIDEO_UPLOAD',
};
const actor = {tenantId: 'google-youtube-uploads', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const upload = id => C + 'youTubeVideoUploads/' + id;
function fixture(mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 94).toString('base64')),
    calls = [];
  let writes = 0;
  store.putConnection(
    owner,
    {
      id: 'g',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Google Ads',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const uploads = new Map([
    ['1', {videoId: 'aaaaaaaaaa1', channelId: 'UCbrand', state: 'PROCESSED', videoPrivacy: 'UNLISTED'}],
    ['2', {videoId: 'bbbbbbbbbb2', channelId: '', state: 'PROCESSED', videoPrivacy: 'UNLISTED'}],
    ['3', {videoId: 'cccccccccc3', channelId: 'UCbrand', state: 'FAILED', videoPrivacy: 'UNLISTED'}],
  ]);
  const inList = (query, field) =>
    [...(new RegExp(field + ' IN \\(([^)]*)\\)').exec(query)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(m => m[1]);
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = decodeURIComponent(u.pathname),
        body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({path, body});
      if (path === '/v25/customers/123/googleAds:search') {
        const q = body.query + ' ';
        if (/FROM customer /.test(q))
          return Response.json({results: [{customer: {resourceName: 'customers/123', id: '123'}}]});
        if (/FROM you_tube_video_upload /.test(q)) {
          const names = inList(q, 'you_tube_video_upload.resource_name');
          return Response.json({
            results: [...uploads]
              .filter(([k]) => names.includes(upload(k)))
              .map(([k, v]) => ({youTubeVideoUpload: {resourceName: upload(k), videoUploadId: k, ...v}})),
          });
        }
        if (/FROM asset /.test(q)) {
          const ids = inList(q, 'asset.youtube_video_asset.youtube_video_id');
          return Response.json({
            results: ids.includes('aaaaaaaaaa1')
              ? [{asset: {resourceName: C + 'assets/900', youtubeVideoAsset: {youtubeVideoId: 'aaaaaaaaaa1'}}}]
              : [],
          });
        }
        throw new Error('Unexpected query ' + q);
      }
      writes++;
      if (path === '/v25/customers/123/youTubeVideoUploads:update') {
        const x = body.youTubeVideoUpload,
          id = x.resourceName.split('/').at(-1);
        if (mode !== 'ignore') uploads.get(id).videoPrivacy = x.videoPrivacy;
        return Response.json({resourceName: x.resourceName});
      }
      if (path === '/v25/customers/123/youTubeVideoUploads:remove') {
        if (mode !== 'ignore') for (const n of body.resourceNames) uploads.delete(n.split('/').at(-1));
        return Response.json({resourceNames: mode === 'other' ? [upload(99)] : body.resourceNames});
      }
      throw new Error('Unexpected ' + path);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    10000,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const privacy = (id, videoPrivacy, action = actions.update) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action,
          account_id: '123',
          payload: {youTubeVideoUpload: {resourceName: upload(id), videoPrivacy}, updateMask: 'videoPrivacy'},
        },
      },
      actor,
    );
  const remove = (ids, action = actions.remove) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action, account_id: '123', payload: {resourceNames: ids.map(upload)}}},
      actor,
    );
  const execute = (p, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        ...extra,
      },
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  const raw = payload =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action: actions.update, account_id: '123', payload}},
      actor,
    );
  return {store, calls, uploads, privacy, remove, raw, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('a brand channel video becomes public and verifies; removal names the video assets that use it, counts as a deletion and verifies gone', async () => {
  const f = fixture();
  try {
    const p = ok(await f.privacy('1', 'PUBLIC'));
    assert.match(p.data.creative_impact.effect, /appear in search/);
    ok(await f.execute(p));
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal(f.uploads.get('1').videoPrivacy, 'PUBLIC');
    const r = ok(await f.remove(['1'], actions.removeLegacy));
    assert.deepEqual(r.data.creative_impact.uploads[0].video_assets, [C + 'assets/900']);
    assert.equal(r.data.creative_impact.may_affect_serving, true);
    ok(await f.execute(r));
    assert.equal(ok(await f.verify(r)).data.status, 'verified');
    assert.equal(f.uploads.has('1'), false);
    saveSpendPolicy(f.store, owner, {gateway, account_id: '123', confirmed: true, policy: {allow_deletion: false}});
    assert.equal((await f.remove(['2'])).error?.code, 'POLICY_DELETION_FORBIDDEN');
  } finally {
    f.store.close();
  }
});

test('malformed requests are refused before any request; Google-managed channel videos, failed uploads, unchanged privacy and unknown uploads are refused after reading', async () => {
  const cases = [
    ['private', f => f.privacy('1', 'PRIVATE')],
    [
      'title change',
      f => f.raw({youTubeVideoUpload: {resourceName: upload(1), videoTitle: 'New'}, updateMask: 'videoTitle'}),
    ],
    [
      'privacy with another field',
      f =>
        f.raw({
          youTubeVideoUpload: {resourceName: upload(1), videoPrivacy: 'PUBLIC', channelId: 'UCother'},
          updateMask: 'videoPrivacy',
        }),
    ],
    ['foreign upload', f => f.remove(['x'])],
    ['empty removal', f => f.remove([])],
  ];
  for (const [label, run] of cases) {
    const f = fixture();
    try {
      const r = await run(f);
      assert.equal(r.success, false, label);
      assert.equal(f.calls.length, 0, label + ': ' + JSON.stringify(r).slice(0, 200));
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    assert.equal((await f.privacy('2', 'PUBLIC')).error?.code, 'INVALID_GOOGLE_YOUTUBE_UPLOAD');
    assert.equal((await f.privacy('3', 'PUBLIC')).error?.code, 'INVALID_GOOGLE_YOUTUBE_UPLOAD');
    assert.equal((await f.privacy('1', 'UNLISTED', actions.updateLegacy)).error?.code, 'INVALID_GOOGLE_YOUTUBE_UPLOAD');
    assert.equal((await f.remove(['4'])).error?.code, 'STATE_TARGET_MISMATCH');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('a removal receipt naming other uploads is a failure never resubmitted, an ignored update is not verified, and the ledger lists the four writes', async () => {
  const other = fixture('other');
  try {
    const p = ok(await other.remove(['2']));
    assert.equal((await other.execute(p)).success, false);
    assert.equal((await other.execute(p)).success, false);
    assert.equal(other.writes(), 1);
  } finally {
    other.store.close();
  }
  const ignored = fixture('ignore');
  try {
    const p = ok(await ignored.privacy('1', 'PUBLIC'));
    ok(await ignored.execute(p));
    assert.notEqual(ok(await ignored.verify(p)).data.status, 'verified');
  } finally {
    ignored.store.close();
  }
  for (const action of Object.values(actions)) {
    const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
    assert.equal(rows.length, 1, action);
    assert.equal(rows[0].status, 'reviewed_write_family', action);
    assert.equal(rows[0].family, 'google_youtube_uploads', action);
  }
});
