import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

const actor = {tenantId: 'creative', userId: 'operator', role: 'operator'};
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 63).toString('base64'));
  const connection = {
    id: 'meta',
    tenantId: actor.tenantId,
    gateway: 'meta_native_action',
    accounts: ['100'],
    writeAccounts: ['100'],
    enabled: true,
    label: 'Synthetic',
    scopes: [],
  };
  store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'synthetic'});
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw Error('No network in library metadata');
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const scope = {platform: 'meta', account_id: '100', connection_id: 'meta'};
  const put = (kind, id, data, tenant = actor.tenantId) => store.putDocument(tenant, kind, id, data);
  const asset = (id, extra = {}) => {
    put('workspace_asset', id, {
      ...scope,
      review_id: id,
      name: 'Launch image',
      sha256: 'a'.repeat(64),
      media_id: 'provider-image',
      ready: true,
      status_source: 'provider',
      provider_availability_checked_at: 10,
      source: 'amcp_upload',
      ...extra,
    });
    put('media_review', id, {
      user_id: actor.userId,
      created_at: 100,
      plan: {
        ...scope,
        origin: {kind: 'upload', source_id: 'src-synthetic'},
        source_drive: {url: 'PRIVATE_CANARY'},
        read: {headers: {Authorization: 'PRIVATE_CANARY'}},
        transform: {from: {width: 2000, height: 1000}, to: {width: 1920, height: 960}, steps: ['scale']},
      },
    });
  };
  const call = (args, as = actor) => service.call('amcp_media', args, as);
  return {store, connection, scope, put, asset, call};
}
test('creative library uses bounded metadata, exact current account access and filter-bound continuation', async () => {
  const f = fixture();
  try {
    f.asset('a');
    f.asset('b');
    f.asset('c', {account_id: '200'});
    f.put('workspace_asset', 'foreign', {...f.scope, name: 'PRIVATE_CANARY'}, 'foreign');
    f.store.documents = () => {
      throw Error('Unbounded full documents');
    };
    f.store.document = () => {
      throw Error('Full receipt loaded');
    };
    const first = await f.call({action: 'library', search: 'launch', limit: 1});
    assert.equal(first.success, true, JSON.stringify(first));
    assert.deepEqual(
      first.data.assets.map(a => a.asset_id),
      ['a'],
    );
    assert.ok(first.data.next_cursor);
    assert.doesNotMatch(JSON.stringify(first), /PRIVATE_CANARY|source_drive|Authorization/);
    assert.equal(first.data.assets[0].availability, 'requires_fresh_check');
    assert.equal(first.data.network_requests, 0);
    assert.equal(
      (await f.call({action: 'library', cursor: first.data.next_cursor, search: 'different'})).error.code,
      'INVALID_CURSOR',
    );
    const second = await f.call({action: 'library', cursor: first.data.next_cursor, search: 'launch', limit: 1});
    assert.deepEqual(
      second.data.assets.map(a => a.asset_id),
      ['b'],
    );
    assert.equal(second.data.has_more, false);
    f.store.putConnection({...actor, role: 'admin'}, {...f.connection, enabled: false}, {accessToken: 'synthetic'});
    assert.equal((await f.call({action: 'library'})).data.assets.length, 0);
    assert.equal((await f.call({action: 'asset', asset_id: 'a'})).success, false);
  } finally {
    f.store.close();
  }
});
test('creative metadata is confirmed, revision protected and separate from provider names and receipts', async () => {
  const f = fixture();
  try {
    f.asset('a');
    const input = {
      action: 'save_asset_metadata',
      asset_id: 'a',
      metadata: {name: 'Ramadan | رمضان', tags: ['Awareness', 'Arabic']},
      revision: 0,
    };
    assert.equal((await f.call(input)).success, false);
    assert.equal((await f.call({...input, confirmed: true}, {...actor, role: 'reader'})).success, false);
    const saved = await f.call({...input, confirmed: true});
    assert.equal(saved.success, true, JSON.stringify(saved));
    assert.equal(saved.data.metadata_revision, 1);
    assert.deepEqual(saved.data.tags, ['awareness', 'arabic']);
    assert.equal(f.store.document(actor.tenantId, 'workspace_asset', 'a').name, 'Launch image');
    assert.equal((await f.call({...input, confirmed: true})).error.code, 'REVISION_CONFLICT');
    assert.equal((await f.call({action: 'library', tag: 'ARABIC'})).data.assets[0].name, 'Ramadan | رمضان');
    assert.equal(
      (
        await f.call({
          ...input,
          confirmed: true,
          revision: 1,
          metadata: {name: 'x', source_url: 'https://private.invalid'},
        })
      ).success,
      false,
    );
  } finally {
    f.store.close();
  }
});
test('creative usage follows verified result references with provider IDs, excluding mere dependencies and inaccessible plans', async () => {
  const f = fixture();
  try {
    f.asset('a');
    const step = (id, extra = {}) => ({
      id,
      kind: 'write',
      gateway: 'meta_native_action',
      ...f.scope,
      status: 'verified',
      arguments: {},
      result: {created_id: id + '-native'},
      ...extra,
    });
    const steps = [
      step('image', {
        kind: 'media',
        review_id: 'a',
        arguments: {platform: 'meta'},
        result: {media_id: 'provider-image'},
      }),
      step('creative', {arguments: {payload: {image_hash: {$ref: 'image#/image_hash'}}}}),
      step('ad', {arguments: {payload: {creative: {$ref: 'creative#/created_id'}}}}),
      step('unrelated', {depends_on: ['image']}),
      step('failed', {status: 'uncertain', arguments: {payload: {image_hash: {$ref: 'image#/image_hash'}}}}),
    ];
    f.put('campaign_run', 'plan', {user_id: actor.userId, name: 'Launch', steps});
    f.put('campaign_run', 'private', {user_id: 'other', name: 'PRIVATE_CANARY', steps});
    f.put('campaign_run', 'revoked', {
      user_id: actor.userId,
      name: 'PRIVATE_CANARY',
      steps: [...steps, step('revoked', {account_id: '200'})],
    });
    const detail = await f.call({action: 'asset', asset_id: 'a'});
    assert.equal(detail.success, true, JSON.stringify(detail));
    assert.equal(detail.data.usage.length, 1);
    assert.deepEqual(
      detail.data.usage[0].steps.map(s => s.step_id),
      ['image', 'creative', 'ad'],
    );
    assert.deepEqual(detail.data.usage[0].steps[2].resource_ids, ['ad-native']);
    assert.doesNotMatch(JSON.stringify(detail.data.usage), /PRIVATE_CANARY|arguments|payload|source_drive/);
    assert.equal(detail.data.external_usage, 'unknown');
    assert.equal(detail.data.performance, 'not_joined');
  } finally {
    f.store.close();
  }
});
test('creative library does not restore expired sources or expose another member source identifiers', async () => {
  const f = fixture();
  try {
    f.asset('a');
    const source = {user_id: actor.userId, state: 'complete', expires_at: Date.now() + 10000, sha256: 'b'.repeat(64)};
    f.put('media_source', 'src-synthetic', source);
    let r = await f.call({action: 'asset', asset_id: 'a'});
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.source.source_id, 'src-synthetic');
    assert.equal(r.data.source.original_sha256, 'b'.repeat(64));
    f.put('media_source', 'src-synthetic', {...source, expires_at: 1});
    r = await f.call({action: 'asset', asset_id: 'a'});
    assert.equal(r.data.source.available, false);
    assert.equal(r.data.source.source_id, undefined);
    f.put('media_source', 'src-synthetic', {...source, user_id: 'other'});
    r = await f.call({action: 'asset', asset_id: 'a'});
    assert.equal(r.data.source.source_id, undefined);
    assert.equal(r.data.source.original_sha256, undefined);
  } finally {
    f.store.close();
  }
});
test('creative library continues past an inaccessible scan window and never binds a cursor to another actor', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 505; i++) f.asset('a-' + String(i).padStart(3, '0'), {account_id: '200'});
    f.asset('z-visible');
    const first = await f.call({action: 'library'});
    assert.equal(first.success, true, JSON.stringify(first));
    assert.deepEqual(first.data.assets, []);
    assert.ok(first.data.next_cursor);
    const next = await f.call({action: 'library', cursor: first.data.next_cursor});
    assert.deepEqual(
      next.data.assets.map(a => a.asset_id),
      ['z-visible'],
    );
    assert.equal(
      (await f.call({action: 'library', cursor: first.data.next_cursor}, {...actor, userId: 'other'})).error.code,
      'INVALID_CURSOR',
    );
    for (let i = 0; i < 23; i++)
      f.put('campaign_run', 'plan-' + String(i).padStart(2, '0'), {
        name: 'Plan',
        user_id: actor.userId,
        steps: [
          {
            id: 'media',
            kind: 'media',
            ...f.scope,
            arguments: {platform: 'meta'},
            status: 'verified',
            review_id: 'z-visible',
            verification: {checks: [{resource_id: 'checked-native-id'}]},
          },
        ],
      });
    const detail = await f.call({action: 'asset', asset_id: 'z-visible'});
    assert.equal(detail.data.usage.length, 20);
    assert.deepEqual(detail.data.usage[0].steps[0].resource_ids, ['checked-native-id']);
    const rest = await f.call({action: 'asset', asset_id: 'z-visible', cursor: detail.data.next_cursor});
    assert.equal(rest.data.usage.length, 3);
    assert.equal(rest.data.usage_has_more, false);
  } finally {
    f.store.close();
  }
});
