import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inspectAccountExplanations} from '../tools/check-locales.mjs';
import {metaAssetUsageFixture, usageImageHash, usageVideoId} from './fixtures/meta-asset-usage-data.mjs';
const ok = out => {
  assert.equal(out.success, true, JSON.stringify(out));
  return out.data;
};

test('Meta native usage matches exact current scalar image references and pages without exposing original provider content', async t => {
  const f = metaAssetUsageFixture(t),
    first = ok(await f.call());
  assert.deepEqual(
    first.rows.map(r => r.ad_id),
    ['501'],
  );
  assert.equal(first.rows[0].creative_id, '601501');
  assert.equal(first.rows[0].match_field, 'image_hash');
  assert.equal(first.rows[0].media_id, usageImageHash);
  assert.equal(first.rows[0].configured_status, 'PAUSED');
  assert.equal(first.rows[0].effective_status, 'CAMPAIGN_PAUSED');
  assert.equal(first.examined_ads, 3);
  assert.equal(first.unresolved_ads, 1);
  assert.equal(first.source_references.length, 3);
  assert.equal(first.has_more, true);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE-|accessToken|privatePerson|body|access_token|next-opaque/);
  assert.doesNotMatch(
    Buffer.from(first.next_cursor, 'base64url').toString('utf8'),
    /next-opaque|PRIVATE-|previous_ids/,
  );
  const second = ok(await f.call({cursor: first.next_cursor}));
  assert.equal(second.rows[0].ad_id, '9007199254740995');
  assert.equal(second.has_more, false);
  assert.equal(f.requests.length, 6);
  assert.equal(f.requests[4].url.searchParams.get('after'), 'next-opaque');
  assert.ok(f.requests.every(r => r.method === 'GET'));
});

test('Meta native usage preserves exact video IDs and does not match a thumbnail as video usage', async t => {
  const f = metaAssetUsageFixture(t, {video: true});
  f.setHook((body, url) => {
    if (url.pathname.endsWith('/ads')) delete body.data[1].creative.video_id;
    return body;
  });
  const result = ok(await f.call());
  assert.deepEqual(
    result.rows.map(r => r.ad_id),
    ['501'],
  );
  assert.equal(result.rows[0].match_field, 'video_id');
  assert.equal(result.rows[0].media_id, usageVideoId);
  assert.equal(result.unresolved_ads, 2);
});

test('unknown assets, providers, source identity, scopes and altered request scope refuse before native egress', async t => {
  for (const variation of [
    'foreign_asset',
    'foreign_tenant',
    'platform',
    'native_id',
    'sha256',
    'scope',
    'extra_scope',
    'limit',
  ]) {
    const f = metaAssetUsageFixture(t);
    let input = {};
    if (variation === 'foreign_asset') input.asset_id = 'unknown';
    if (variation === 'foreign_tenant')
      f.store.db.prepare("DELETE FROM documents WHERE tenant_id=? AND kind='workspace_asset'").run(f.actor.tenantId);
    if (variation === 'platform')
      f.store.putDocument(f.actor.tenantId, 'workspace_asset', 'asset-131', {...f.asset, platform: 'snapchat'});
    if (variation === 'native_id')
      f.store.putDocument(f.actor.tenantId, 'workspace_asset', 'asset-131', {...f.asset, media_id: ''});
    if (variation === 'sha256')
      f.store.putDocument(f.actor.tenantId, 'workspace_asset', 'asset-131', {...f.asset, sha256: 'bad'});
    if (variation === 'scope')
      f.store.putConnection(f.admin, {...f.connection, scopes: []}, {accessToken: 'synthetic'});
    if (variation === 'extra_scope') input.account_id = '200';
    if (variation === 'limit') input.limit = 101;
    assert.equal((await f.call(input)).success, false, variation);
    assert.equal(f.requests.length, 0, variation);
  }
});

test('tampered, expired, changed-identity/asset/filter and rotated native usage cursors fail before egress', async t => {
  const f = metaAssetUsageFixture(t),
    first = ok(await f.call()),
    n = f.requests.length;
  for (const input of [{cursor: first.next_cursor + 'x'}, {cursor: first.next_cursor, limit: 2}])
    assert.equal((await f.call(input)).success, false);
  assert.equal((await f.call({cursor: first.next_cursor}, {...f.actor, userId: 'other'})).success, false);
  assert.equal(f.requests.length, n);
  f.store.putDocument(f.actor.tenantId, 'workspace_asset', 'asset-131', {...f.asset, media_id: 'd'.repeat(32)});
  assert.equal((await f.call({cursor: first.next_cursor})).success, false);
  assert.equal(f.requests.length, n);
  f.store.putDocument(f.actor.tenantId, 'workspace_asset', 'asset-131', f.asset);
  const clock = Date.now;
  Date.now = () => clock() + 300001;
  try {
    const expired = await f.call({cursor: first.next_cursor});
    assert.equal(expired.success, false);
    assert.equal(expired.error.code, 'INVALID_CURSOR');
    assert.equal(f.requests.length, n);
  } finally {
    Date.now = clock;
  }
  f.store.putConnection(f.admin, f.connection, {accessToken: 'replacement'});
  assert.equal((await f.call({cursor: first.next_cursor})).success, false);
  assert.equal(f.requests.length, n);
});

test('current native identity and malformed references refuse the entire page instead of inventing usage', async t => {
  for (const variation of [
    'account',
    'ad_owner',
    'creative_owner',
    'unsafe_id',
    'duplicate',
    'hash',
    'video',
    'creative_shape',
    'paging',
    'oversize',
  ]) {
    const f = metaAssetUsageFixture(t);
    f.setHook((body, url) => {
      if (variation === 'account' && !url.pathname.endsWith('/ads')) body.id = 'act_200';
      if (url.pathname.endsWith('/ads')) {
        if (variation === 'ad_owner') body.data[0].account_id = '200';
        if (variation === 'creative_owner') body.data[0].creative.account_id = '200';
        if (variation === 'unsafe_id') body.data[0].id = 9007199254740992;
        if (variation === 'duplicate') body.data[1].id = body.data[0].id;
        if (variation === 'hash') body.data[0].creative.image_hash = {unexpected: true};
        if (variation === 'video') body.data[0].creative.video_id = 9007199254740992;
        if (variation === 'creative_shape') body.data[0].creative = [];
        if (variation === 'paging') body.paging.cursors.after = '';
        if (variation === 'oversize') body.data[0].unrequestedPrivate = 'x'.repeat(300000);
      }
      return body;
    });
    assert.equal((await f.call()).success, false, variation);
  }
});

test('revocation and changed original asset state during a native read stop follow-up requests and disclosure', async t => {
  for (const variation of ['key', 'scope', 'credential', 'asset']) {
    const f = metaAssetUsageFixture(t);
    f.setHook((body, _url, n) => {
      if (n === 2) {
        if (variation === 'key') f.store.revokeKey(f.key);
        if (variation === 'scope')
          f.store.putConnection(f.admin, {...f.connection, scopes: []}, {accessToken: 'synthetic'});
        if (variation === 'credential') f.store.putConnection(f.admin, f.connection, {accessToken: 'rotated'});
        if (variation === 'asset')
          f.store.putDocument(f.actor.tenantId, 'workspace_asset', 'asset-131', {...f.asset, media_id: 'd'.repeat(32)});
      }
      return body;
    });
    const out = await f.call();
    assert.equal(out.success, false, variation);
    assert.equal(f.requests.length, 2, variation);
    assert.doesNotMatch(JSON.stringify(out), /PRIVATE-|Original|Native <ad>/);
  }
});

test('a native retry is counted and retained references prove only the observed page', async t => {
  const f = metaAssetUsageFixture(t);
  f.setHook((body, url, n) =>
    url.pathname.endsWith('/ads') && n === 2 ? new Response('temporary', {status: 503}) : body,
  );
  const out = ok(await f.call());
  assert.equal(f.requests.length, 4);
  assert.equal(out.collection.requests, 4);
  assert.match(out.meaning, /historical|point-in-time/);
  assert.equal(out.rows.length, 1);
});

test('empty matching pages remain continuable and repeated native cursor or adjacent IDs refuse disclosure', async t => {
  for (const variation of ['empty', 'cursor_loop', 'duplicate']) {
    const f = metaAssetUsageFixture(t);
    f.setHook((body, url) => {
      if (url.pathname.endsWith('/ads') && !url.searchParams.has('after') && variation === 'empty')
        for (const row of body.data) if (row.creative?.image_hash) row.creative.image_hash = 'other-opaque-hash';
      if (url.searchParams.has('after') && variation === 'cursor_loop')
        body.paging = {cursors: {after: 'next-opaque'}, next: 'https://graph.facebook.com/ignored'};
      if (url.searchParams.has('after') && variation === 'duplicate') body.data[0].id = '502';
      return body;
    });
    const first = ok(await f.call());
    if (variation === 'empty') {
      assert.equal(first.rows.length, 0);
      assert.equal(first.has_more, true);
      assert.equal(ok(await f.call({cursor: first.next_cursor})).rows.length, 1);
    } else assert.equal((await f.call({cursor: first.next_cursor})).success, false, variation);
  }
});

test('original-file expiry does not block metadata references and missing creative ownership remains unknown', async t => {
  const f = metaAssetUsageFixture(t);
  f.store.putDocument(f.actor.tenantId, 'media_source', 'src-expired', {
    user_id: f.actor.userId,
    expires_at: 0,
    state: 'complete',
    sha256: 'b'.repeat(64),
  });
  f.store.putDocument(f.actor.tenantId, 'media_review', 'asset-131', {plan: {origin: {source_id: 'src-expired'}}});
  f.setHook((body, url) => {
    if (url.pathname.endsWith('/ads')) delete body.data[0].creative.account_id;
    return body;
  });
  const result = ok(await f.call());
  assert.equal(result.rows.length, 0);
  assert.equal(result.unresolved_ads, 2);
  assert.equal(result.has_more, true);
  assert.equal(f.requests.length, 3);
});

test('compiled Meta version and current configuration must both remain qualified around native reads', async t => {
  const saved = process.env.AMCP_META_API_VERSION;
  try {
    for (const midRead of [false, true]) {
      const f = metaAssetUsageFixture(t);
      if (midRead)
        f.setHook((body, _url, n) => {
          if (n === 2) process.env.AMCP_META_API_VERSION = 'v25.0';
          return body;
        });
      else process.env.AMCP_META_API_VERSION = 'v25.0';
      const out = await f.call();
      assert.equal(out.success, false);
      assert.equal(f.requests.length, midRead ? 2 : 0);
      if (saved === undefined) delete process.env.AMCP_META_API_VERSION;
      else process.env.AMCP_META_API_VERSION = saved;
    }
  } finally {
    if (saved === undefined) delete process.env.AMCP_META_API_VERSION;
    else process.env.AMCP_META_API_VERSION = saved;
  }
});

test('native reference query fields come from the checked Meta SDK matrix and authored diagnostics exclude dynamic provider text', async t => {
  const reference = JSON.parse(readFileSync('tests/fixtures/meta-asset-usage-sdk-v26.json', 'utf8')),
    f = metaAssetUsageFixture(t);
  ok(await f.call());
  const url = f.requests[1].url,
    selected = url.searchParams.get('fields');
  assert.equal(reference.ad_account_ads.method, 'GET');
  assert.equal(url.pathname, '/' + reference.api_version + '/act_100' + reference.ad_account_ads.edge);
  assert.equal(
    selected,
    reference.selected_ad_fields
      .map(field => (field === 'creative' ? 'creative{' + reference.selected_creative_fields.join(',') + '}' : field))
      .join(','),
  );
  const sample =
    "bad('Known authored refusal','MACHINE_CODE');invalid('Known bound');bad(native.message??'Native fallback',native.code);const data={meaning:'Known meaning',body:'Native text'};";
  assert.deepEqual([...inspectAccountExplanations(sample, 'src/meta-asset-usage.ts')].sort(), [
    'Known authored refusal',
    'Known bound',
    'Known meaning',
  ]);
  assert.deepEqual([...inspectAccountExplanations(sample, 'src/unrelated.ts')], ['Known meaning']);
});
