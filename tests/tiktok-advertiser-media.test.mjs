import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {sha256, stable} from '../dist/src/security.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {
  advertiserWorld,
  advertiserAnswer,
  fullAdvertiserRow,
  identityFields,
  answer,
  assertNoAdvertiserDetail,
} from './helpers/tiktok-advertiser-noise.mjs';

/**
 * T1, Round 2.5 (package r25-m0-t1), the tenth consumer: the amcp_media TikTok upload reads the advertiser at prepare,
 * keeps the answer as the review's state, shows it as before_state and reads it again at execute (L1-01, L6-02, L6-12).
 * The upload fails with STATE_CHANGED whenever the licence ticket rotates or the balance moves, and the review shows the
 * model the advertiser's contact record. Real compiled modules against a synthetic TikTok whose advertiser row rotates
 * (tests/helpers/tiktok-advertiser-noise.mjs).
 */
const key = Buffer.alloc(32, 19).toString('base64'),
  actor = {tenantId: 't', userId: 'u', role: 'operator'},
  admin = {...actor, role: 'admin'};
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
const link = 'https://drive.google.com/file/d/abcdefghijklmno/view?usp=sharing';
const spec = a => JSON.stringify([...a].sort());

function fixture(changes = {}) {
  const world = advertiserWorld(changes),
    store = new Store(':memory:', key),
    connection = {
      id: 'c',
      tenantId: 't',
      gateway: 'tiktok_native_action',
      accounts: [world.id],
      writeAccounts: [world.id],
      label: 'Synthetic',
      enabled: true,
      scopes: [],
    };
  store.putConnection(admin, connection, {accessToken: 'synthetic'});
  const uploads = [];
  const transport = new NativeTransport(async (input, init) => {
    const url = new URL(String(input)),
      path = url.pathname.replace('/open_api', ''),
      method = init?.method ?? 'GET';
    if (method === 'GET' && path === '/v1.3/advertiser/info/')
      return Response.json(answer({list: [advertiserAnswer(world, url)]}));
    if (method === 'GET' && path.includes('/file/')) return Response.json(answer({list: [{image_id: 'ad-site/456'}]}));
    if (init?.body instanceof FormData) {
      uploads.push(path);
      return Response.json(answer({image_id: 'ad-site/456'}));
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  });
  const source = async () => new Response(new Uint8Array(png), {headers: {'Content-Type': 'application/octet-stream'}}),
    service = new MirrorService(
      new Registry(),
      store,
      transport,
      undefined,
      {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
      source,
    );
  const call = input => service.call('amcp_media', input, actor);
  return {
    world,
    store,
    uploads,
    prepare: () =>
      call({action: 'prepare', platform: 'tiktok', account_id: world.id, drive_url: link, name: 'Synthetic'}),
    execute: review =>
      call({action: 'execute', review_id: review.review_id, idempotency_key: review.idempotency_key, confirmed: true}),
    close: () => store.close(),
  };
}
async function withUpload(changes, body) {
  const f = fixture(changes);
  try {
    const p = await f.prepare();
    assert.equal(p.success, true, 'prepare: ' + JSON.stringify(p.error ?? p).slice(0, 700));
    return await body(f, p.data);
  } finally {
    f.close();
  }
}

test('a TikTok upload prepares and executes with a quiet advertiser (control)', async () => {
  await withUpload({rotating: false, honourFields: false}, async (f, review) => {
    const done = await f.execute(review);
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 700));
    assert.deepEqual(f.uploads, ['/v1.3/file/image/ad/upload/']);
  });
});

for (const honourFields of [true, false])
  test(
    'a TikTok upload executes while the licence ticket rotates and the balance falls (TikTok ' +
      (honourFields ? 'narrows its answer to fields' : 'ignores fields') +
      ')',
    async () => {
      await withUpload({honourFields}, async (f, review) => {
        const done = await f.execute(review);
        assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 700));
        assert.equal(f.uploads.length, 1);
        assert.ok(f.world.reads >= 2, 'the advertiser is read again at execute');
        // What the review shows the model of the advertiser: its identity fields, no licence link or contact record.
        assertNoAdvertiserDetail(review, 'the media review');
        assert.deepEqual(review.before_state, {
          data: {
            list: [
              {
                advertiser_id: '9000000000000000001',
                name: 'Synthetic Advertiser | Test Market',
                status: 'STATUS_ENABLE',
                role: 'ROLE_ADVERTISER',
                currency: 'USD',
                timezone: 'Asia/Riyadh',
                country: 'SA',
              },
            ],
          },
        });
      });
    },
  );

test('a TikTok upload asks TikTok for the identity fields of the advertiser only', async () => {
  await withUpload({}, async f => {
    assert.ok(f.world.seen.length >= 1, 'the advertiser is read');
    for (const url of f.world.seen) {
      assert.equal(url.searchParams.get('advertiser_ids'), JSON.stringify([f.world.id]));
      assert.equal(spec(JSON.parse(url.searchParams.get('fields') ?? 'null') ?? []), spec(identityFields), url.search);
    }
  });
});

// The protection: what decides the upload is still compared. With a quiet advertiser this holds before and after the
// change (the control); while the ticket rotates, the refusal names the changed field alone.
for (const rotating of [false, true])
  for (const [field, changed] of [
    ['currency', 'EUR'],
    ['status', 'STATUS_LIMIT'],
    ['name', 'Renamed Advertiser'],
  ])
    test(
      'a TikTok upload stops when the advertiser ' +
        field +
        ' changes between prepare and execute' +
        (rotating ? ' while the licence ticket rotates' : ' (control)'),
      async () => {
        await withUpload({rotating}, async (f, review) => {
          f.world[field] = changed;
          const refused = await f.execute(review);
          assertRefused(refused, 'STATE_CHANGED');
          assert.deepEqual(refused.error.details.changed_fields, ['$["data"]["list"][0]["' + field + '"]']);
          assert.deepEqual(f.uploads, [], 'nothing was uploaded');
        });
      },
    );

/** A review prepared before this change: the whole row, and the read that fetched it, without `fields`. */
const savedBefore = (f, review, whole) => {
  const saved = f.store.document('t', 'media_review', review.review_id),
    plan = whole ? {...saved.plan, read: {...saved.plan.read, query: {advertiser_ids: [f.world.id]}}} : saved.plan;
  f.store.putDocument('t', 'media_review', review.review_id, {
    ...saved,
    plan,
    state: {data: {list: [fullAdvertiserRow(f.world, f.world.reads)]}},
    // The integrity fingerprint is over the plan, which an earlier version froze with its own read.
    fingerprint: sha256(stable({tenant: actor.tenantId, user: actor.userId, plan})),
  });
};
for (const whole of [true, false])
  test(
    'a TikTok upload prepared before this change, with its whole row' +
      (whole ? ' and its whole read' : '') +
      ', still executes',
    async () => {
      await withUpload({}, async (f, review) => {
        savedBefore(f, review, whole);
        const done = await f.execute(review);
        assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 700));
        assert.equal(f.uploads.length, 1);
      });
    },
  );
test('a TikTok upload prepared before this change still stops when the advertiser currency changes', async () => {
  await withUpload({}, async (f, review) => {
    savedBefore(f, review, true);
    f.world.currency = 'EUR';
    const refused = await f.execute(review);
    assertRefused(refused, 'STATE_CHANGED');
    assert.deepEqual(refused.error.details.changed_fields, ['$["data"]["list"][0]["currency"]']);
    assert.deepEqual(f.uploads, []);
  });
});
