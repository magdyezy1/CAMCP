import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {packFixture} from './fixtures/report-pack-data.mjs';

const style = {brand_name: 'Approved brand', accent_color: '#254B76', footer: 'Client copy', template: 'compact'};
function fixture() {
  const actor = {tenantId: 'profile-branding', userId: 'operator', role: 'operator'};
  const store = new Store(':memory:', Buffer.alloc(32, 75).toString('base64'));
  const connection = {
    id: 'meta',
    tenantId: actor.tenantId,
    gateway: 'meta_native_action',
    accounts: ['00100', '200'],
    enabled: true,
    label: 'Synthetic',
    scopes: [],
  };
  store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'synthetic'});
  store.putDocument(actor.tenantId, 'overview_report', 'synthetic-pack', packFixture());
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw Error('No provider calls');
    }),
  );
  const profile = {
    name: 'Approved client',
    bindings: [{gateway: 'meta_native_action', connection_id: 'meta', account_id: 'act_00100'}],
    report_presentation: style,
  };
  return {
    actor,
    store,
    connection,
    profile,
    workspace: (input, as = actor) => service.call('amcp_workspace', input, as),
    call: (input, as = actor) => service.call('amcp_reporting_overview', input, as),
    put: (kind, id, value) => store.putDocument(actor.tenantId, kind, id, value),
  };
}
async function approved(f, profile = f.profile) {
  const result = await f.workspace({action: 'save_profile', profile, confirmed: true});
  assert.equal(result.success, true, JSON.stringify(result));
  return result.data;
}
const apply = p => ({
  action: 'apply_profile_presentation',
  id: 'synthetic-pack',
  profile_id: p.id,
  profile_revision: p.revision,
  presentation_revision: 0,
  confirmed: true,
});
test('approved client branding is discoverable, explicit, revision-bound and copied into the snapshot', async () => {
  const f = fixture();
  try {
    const p = await approved(f);
    const preview = await f.workspace({action: 'preview_profile', id: p.id});
    assert.deepEqual(preview.data.report_presentation, style);
    const choices = await f.call({action: 'presentation_profiles', id: 'synthetic-pack'});
    assert.equal(choices.success, true, JSON.stringify(choices));
    assert.equal(choices.data.profiles[0].id, p.id);
    for (const args of [
      {...apply(p), confirmed: false},
      {...apply(p), profile_revision: 99},
    ])
      assert.equal((await f.call(args)).success, false);
    assert.equal((await f.call(apply(p), {...f.actor, role: 'reader'})).success, false);
    const result = await f.call(apply(p));
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(result.data.presentation, style);
    assert.equal(result.data.presentation_source.profile_id, p.id);
    assert.equal(result.data.presentation_source.profile_revision, p.revision);
    assert.equal(result.data.presentation_revision, 1);
    assert.equal((await f.call(apply(p))).error.code, 'REVISION_CONFLICT');
  } finally {
    f.store.close();
  }
});
test('template edits and deletion do not rewrite earlier snapshots, and manual changes clear copied provenance', async () => {
  const f = fixture();
  try {
    const p = await approved(f);
    assert.equal((await f.call(apply(p))).success, true);
    const edit = await f.workspace({
      action: 'save_profile',
      id: p.id,
      revision: p.revision,
      confirmed: true,
      profile: {...f.profile, report_presentation: {...style, brand_name: 'New brand'}},
    });
    assert.equal(edit.success, true);
    assert.equal((await f.call({...apply(p), presentation_revision: 1})).error.code, 'REVISION_CONFLICT');
    await f.workspace({action: 'delete_profile', id: p.id, revision: edit.data.revision, confirmed: true});
    let pack = await f.call({action: 'report_pack', id: 'synthetic-pack'});
    assert.equal(pack.data.presentation.brand_name, style.brand_name);
    assert.equal(pack.data.presentation_source.profile_revision, p.revision);
    pack = await f.call({
      action: 'save_presentation',
      id: 'synthetic-pack',
      presentation_revision: 1,
      presentation: {brand_name: 'Manual'},
      confirmed: true,
    });
    assert.equal(pack.success, true);
    assert.equal(pack.data.presentation_source, null);
  } finally {
    f.store.close();
  }
});
test('profile bindings cover every snapshot source and account access is checked again when applying', async () => {
  const f = fixture();
  try {
    const p = await approved(f);
    for (const bindings of [
      [{gateway: 'meta_native_action', connection_id: 'meta', account_id: '200'}],
      [{gateway: 'meta_native_action', connection_id: 'other', account_id: '00100'}],
    ]) {
      f.put('client_profile', p.id, {...p, bindings});
      assert.equal((await f.call({action: 'presentation_profiles', id: 'synthetic-pack'})).data.profiles.length, 0);
      assert.equal(
        (
          await f.call({
            ...apply(p),
            profile_revision: f.store.document(f.actor.tenantId, 'client_profile', p.id).revision,
          })
        ).error.code,
        'PROFILE_ACCOUNT_MISMATCH',
      );
    }
    f.put('client_profile', p.id, p);
    const current = f.store.document(f.actor.tenantId, 'client_profile', p.id);
    const report = packFixture();
    report.config.sources.push({platform: 'meta', connection_id: 'meta', account_id: '200'});
    f.put('overview_report', report.id, report);
    assert.equal((await f.call({...apply(current)})).error.code, 'PROFILE_ACCOUNT_MISMATCH');
    f.put('overview_report', report.id, packFixture());
    f.store.putConnection({...f.actor, role: 'admin'}, {...f.connection, enabled: false}, {accessToken: 'synthetic'});
    assert.equal((await f.call(apply(current))).success, false);
    assert.equal(f.store.documents(f.actor.tenantId, 'report_presentation').length, 0);
  } finally {
    f.store.close();
  }
});
test('profile choices paginate bounded metadata, omit unavailable styles and never expose native templates', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 7; i++)
      f.put('client_profile', 'profile-' + i, {
        ...f.profile,
        approved_by: 'operator',
        approved_at: Date.now(),
        templates: {private: [{payload: 'withheld'}]},
      });
    f.put('client_profile', 'profile-7', {
      ...f.profile,
      approved_by: 'operator',
      approved_at: Date.now(),
      bindings: [],
    });
    f.put('client_profile', 'profile-8', {...f.profile, approved_by: null});
    let offset = 0,
      ids = [];
    do {
      const r = await f.call({action: 'presentation_profiles', id: 'synthetic-pack', offset, limit: 3});
      assert.equal(r.success, true, JSON.stringify(r));
      assert.ok(r.data.profiles.length <= 3);
      ids.push(...r.data.profiles.map(p => p.id));
      assert.ok(r.data.profiles.every(p => !('templates' in p) && !('bindings' in p)));
      offset = r.data.next_offset;
    } while (offset !== null);
    assert.equal(ids.length, 8);
    assert.equal(new Set(ids).size, 8);
    assert.equal((await f.call({action: 'presentation_profiles', id: 'synthetic-pack', limit: 101})).success, false);
  } finally {
    f.store.close();
  }
});
test('client branding refuses unsupported content and only a currently approved profile can be applied', async () => {
  const f = fixture();
  try {
    for (const report_presentation of [
      null,
      [],
      {logo_url: 'https://example.com/logo.png'},
      {accent_color: 'red'},
      {footer: 'x'.repeat(201)},
      {template: 'script'},
    ]) {
      assert.equal(
        (await f.workspace({action: 'save_profile', profile: {...f.profile, report_presentation}, confirmed: true}))
          .success,
        false,
      );
    }
    f.put('client_profile', 'draft', f.profile);
    assert.equal((await f.call(apply({id: 'draft', revision: 1}))).error.code, 'PROFILE_NOT_APPROVED');
  } finally {
    f.store.close();
  }
});
