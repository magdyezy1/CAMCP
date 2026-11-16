import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {reviewFriction} from '../dist/src/review-friction.js';
import {ownerOperations} from '../dist/src/owner-operations.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {advertiserWorld, advertiserAnswer, answer} from './helpers/tiktok-advertiser-noise.mjs';

/**
 * Round 2.5, package r25-m1-diff (L6-11): the owner's review-friction view counted only amcp_write. A media review logs
 * `media_prepared` and `media_uploaded`, not `write_prepared`, and its refusals are the amcp_media tool's, so a STATE_CHANGED
 * of an upload (the TikTok advertiser row, T1, reached the upload too) never reached the owner's health view, nor did an
 * expired media review. The view now counts media reviews apart, as it counts writes: the reviews prepared, the uploads
 * sent, and the refusals for an expired review and a changed state with the paths that changed, per 100 prepares. A media
 * review executed through amcp_write (a campaign plan does) is a media review in the count and not a write.
 */
const key = Buffer.alloc(32, 29).toString('base64'),
  now = Date.UTC(2026, 10, 16, 12),
  day = 86400000;

const insert = (store, tenant, request, event, at) =>
  store.db
    .prepare('INSERT INTO audit(tenant_id,request_id,event,previous_hash,hash,created_at) VALUES(?,?,?,?,?,?)')
    .run(tenant, request, JSON.stringify(event), 'synthetic', 'synthetic-' + Math.random(), at);
const failure = (tool, review, code, changed) => ({
  tool,
  input: {action: 'execute', review_id: review},
  outcome: {
    success: false,
    error: {code, message: 'Synthetic', details: changed ? {changed_fields: changed, expected: 'secret-value'} : {}},
  },
});

test('the friction report counts media reviews apart: prepares, uploads sent, expired and changed state with their paths', () => {
  const store = new Store(':memory:', key),
    t0 = now - 3600000;
  try {
    // Five media reviews prepared (one from the library); three uploads reached the provider, one of them incomplete.
    ['m1', 'm2', 'm3', 'm4'].forEach((id, i) => insert(store, 't', id, {event: 'media_prepared'}, t0 + i * 1000));
    insert(store, 't', 'm5', {event: 'media_library_prepared', source_review_id: 'm1'}, t0 + 5000);
    insert(store, 't', 'm1', {event: 'media_uploaded', receipt: {media_id: 'x'}}, t0 + 10000);
    insert(store, 't', 'm2', {event: 'media_uploaded', receipt: {media_id: 'y'}}, t0 + 11000);
    insert(store, 't', 'm3', {event: 'media_upload_incomplete', code: 'PLATFORM_ERROR'}, t0 + 12000);
    // Refusals of media reviews: by the amcp_media tool, and by amcp_write for a media review (a plan's step).
    insert(store, 't', 'a1', failure('amcp_media', 'm4', 'STATE_CHANGED', ['/m/a', '/m/b']), t0 + 20000);
    insert(store, 't', 'a2', failure('amcp_write', 'm5', 'STATE_CHANGED', ['/m/a']), t0 + 21000);
    insert(store, 't', 'a3', failure('amcp_media', 'm4', 'REVIEW_EXPIRED'), t0 + 22000);
    // Not counted anywhere: other refusals of a media review.
    insert(store, 't', 'a4', failure('amcp_media', 'm4', 'INVALID_ARGUMENT'), t0 + 23000);
    insert(store, 't', 'a5', failure('amcp_media', 'm4', 'MEDIA_MEMORY_BUSY'), t0 + 24000);
    // Two writes, one of them refused for a changed state: the write counters are the writes' alone.
    insert(store, 't', 'w1', {event: 'write_prepared'}, t0 + 30000);
    insert(store, 't', 'w2', {event: 'write_prepared'}, t0 + 31000);
    insert(store, 't', 'b1', failure('amcp_write', 'w1', 'STATE_CHANGED', ['/w/a']), t0 + 32000);
    // Another workspace and an older window are not counted.
    insert(store, 'other', 'o1', {event: 'media_prepared'}, t0);
    insert(store, 'other', 'o2', failure('amcp_media', 'o1', 'STATE_CHANGED', ['/m/a']), t0 + 1);
    insert(store, 't', 'old', {event: 'media_prepared'}, now - 31 * day);
    const r = reviewFriction(store, 't', 30, now);
    assert.deepEqual(r.media, {
      prepares: 5,
      executes: 3,
      counts: {REVIEW_EXPIRED: 1, STATE_CHANGED: 2},
      per_100_prepares: {review_expired: 20, state_changed: 40},
      state_changed_paths: [
        {path: '/m/a', count: 2},
        {path: '/m/b', count: 1},
      ],
    });
    // The writes keep their own counts, and the media refusals are not in them.
    assert.equal(r.prepares, 2);
    assert.equal(r.counts.STATE_CHANGED, 1);
    assert.equal(r.counts.REVIEW_EXPIRED, 0);
    assert.deepEqual(r.state_changed_paths, [{path: '/w/a', count: 1}]);
    assert.deepEqual(r.per_100_prepares.state_changed, 50);
    assert.ok(!JSON.stringify(r).includes('secret-value'), 'values never leave the audit');
  } finally {
    store.close();
  }
});

test('a workspace with no media review has unknown media rates, never zero, and the report says what it counts', () => {
  const store = new Store(':memory:', key);
  try {
    insert(store, 't', 'w1', {event: 'write_prepared'}, now - 1000);
    const r = reviewFriction(store, 't', 30, now);
    assert.deepEqual(r.media, {
      prepares: 0,
      executes: 0,
      counts: {REVIEW_EXPIRED: 0, STATE_CHANGED: 0},
      per_100_prepares: {review_expired: null, state_changed: null},
      state_changed_paths: [],
    });
    assert.match(r.meaning, /media/i);
    // Lead review S4-4: a media review refused through amcp_write with any other code (an acknowledgement, an uncertain
    // outcome) is counted in neither the writes' nor the media counters, and the report says so.
    assert.match(r.meaning, /any other refusal of a media review[^.]*counted in neither/);
  } finally {
    store.close();
  }
});

// The same count over what the real service writes for a TikTok image upload, so that the events it counts are the ones
// a review leaves behind and not only the rows above.
const owner = {tenantId: 't', userId: 'owner', role: 'admin'},
  operator = {...owner, userId: 'operator', role: 'operator'},
  png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  ),
  link = 'https://drive.google.com/file/d/abcdefghijklmno/view?usp=sharing';

function upload() {
  const world = advertiserWorld(),
    store = new Store(':memory:', key);
  store.putConnection(
    owner,
    {
      id: 'c',
      tenantId: 't',
      gateway: 'tiktok_native_action',
      accounts: [world.id],
      writeAccounts: [world.id],
      label: 'Synthetic',
      enabled: true,
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const uploads = [],
    transport = new NativeTransport(async (input, init) => {
      const url = new URL(String(input)),
        path = url.pathname.replace('/open_api', ''),
        method = init?.method ?? 'GET';
      if (method === 'GET' && path === '/v1.3/advertiser/info/')
        return Response.json(answer({list: [advertiserAnswer(world, url)]}));
      if (method === 'GET' && path.includes('/file/'))
        return Response.json(answer({list: [{image_id: 'ad-site/456'}]}));
      if (init?.body instanceof FormData) {
        uploads.push(path);
        return Response.json(answer({image_id: 'ad-site/456'}));
      }
      throw new Error('Unexpected TikTok request ' + method + ' ' + path);
    }),
    source = async () => new Response(new Uint8Array(png), {headers: {'Content-Type': 'application/octet-stream'}}),
    service = new MirrorService(
      new Registry(),
      store,
      transport,
      undefined,
      {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
      source,
    ),
    media = input => service.call('amcp_media', input, operator);
  return {
    world,
    store,
    uploads,
    prepare: () =>
      media({action: 'prepare', platform: 'tiktok', account_id: world.id, drive_url: link, name: 'Synthetic'}),
    execute: review =>
      media({action: 'execute', review_id: review.review_id, idempotency_key: review.idempotency_key, confirmed: true}),
    // A media review executed through amcp_write, as a campaign plan's step is.
    executeAsWrite: review =>
      service.call('amcp_write', {action: 'execute', review_id: review.review_id, confirmed: true}, operator),
    friction: () => reviewFriction(store, 't'),
    close: () => store.close(),
  };
}

test('what a real upload leaves behind is counted: a refused execute, the review prepared again, and the upload that was sent', async () => {
  const f = upload();
  try {
    const first = await f.prepare();
    assert.equal(first.success, true, JSON.stringify(first.error));
    f.world.currency = 'EUR';
    const refused = await f.execute(first.data);
    assertRefused(refused, 'STATE_CHANGED');
    const path = '$["data"]["list"][0]["currency"]';
    assert.deepEqual(f.friction().media, {
      prepares: 1,
      executes: 0,
      counts: {REVIEW_EXPIRED: 0, STATE_CHANGED: 1},
      per_100_prepares: {review_expired: 0, state_changed: 100},
      state_changed_paths: [{path, count: 1}],
    });
    // The review is prepared again over the state as it is, executed, and counted as one upload sent.
    const second = await f.prepare();
    assert.equal(second.success, true, JSON.stringify(second.error));
    const done = await f.execute(second.data);
    assert.equal(done.success, true, JSON.stringify(done.error));
    assert.equal(f.uploads.length, 1);
    const media = f.friction().media;
    assert.equal(media.prepares, 2);
    assert.equal(media.executes, 1);
    assert.equal(media.counts.STATE_CHANGED, 1);
    assert.deepEqual(media.per_100_prepares, {review_expired: 0, state_changed: 50});
    // None of it is a write: the write counters stay at zero, and the owner's health view carries both.
    const r = f.friction();
    assert.equal(r.prepares, 0);
    assert.equal(r.counts.STATE_CHANGED, 0);
    assert.deepEqual(r.state_changed_paths, []);
    const health = ownerOperations(f.store, {action: 'health'}, owner).review_friction;
    assert.equal(health.media.prepares, 2);
    assert.equal(health.media.counts.STATE_CHANGED, 1);
  } finally {
    f.close();
  }
});

test('a media review refused through amcp_write is a media refusal in the count, not a write one', async () => {
  const f = upload();
  try {
    const prepared = await f.prepare();
    assert.equal(prepared.success, true, JSON.stringify(prepared.error));
    f.world.currency = 'EUR';
    const refused = await f.executeAsWrite(prepared.data);
    assertRefused(refused, 'STATE_CHANGED');
    const r = f.friction();
    assert.equal(r.media.counts.STATE_CHANGED, 1);
    assert.equal(r.counts.STATE_CHANGED, 0, 'not counted as a write refusal');
    assert.deepEqual(r.state_changed_paths, []);
    assert.equal(f.uploads.length, 0);
  } finally {
    f.close();
  }
});

test('the refusal of a media review says which provider, what matters and what recurs, and keeps the check', async () => {
  const f = upload();
  try {
    const path = '$["data"]["list"][0]["currency"]',
      refuse = async currency => {
        const prepared = await f.prepare();
        assert.equal(prepared.success, true, JSON.stringify(prepared.error));
        f.world.currency = currency;
        const refused = await f.execute(prepared.data);
        assertRefused(refused, 'STATE_CHANGED');
        return refused.error.details;
      };
    const first = await refuse('EUR');
    assert.equal(first.gateway, 'tiktok_native_action');
    assert.deepEqual(first.changed_fields, [path]);
    assert.deepEqual(first.material, [path]);
    assert.deepEqual(first.recurring_paths, []);
    // A media review keeps no prepare input, and its source may be a signed link: the refusal names no call.
    assert.equal(first.next_call, undefined);
    const second = await refuse('GBP');
    assert.deepEqual(second.recurring_paths, [path]);
    assert.deepEqual(f.uploads, [], 'nothing was uploaded');
  } finally {
    f.close();
  }
});
