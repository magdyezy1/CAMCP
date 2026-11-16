import test from 'node:test';
import assert from 'node:assert/strict';
import {readRoleOf, declaredRole, materialFields, surfacedMaterial, materialLimit} from '../dist/src/review-diff.js';

/**
 * Round 2.5, package r25-m1-diff (L5-04; lead review S1-1): which of the changed fields of a STATE_CHANGED matter, and
 * never fewer than do. A review reads several things before a write, and a read has one of four roles: the ACCOUNT the write
 * sits in, a PARENT it goes into (a campaign, an ad group), the TARGET it changes, or a REFERENCE it names (a pixel, an
 * identity, a catalog). `material` lists the target first, then the parent, then the references, then the account. Every
 * changed field of a target, a parent or a reference matters. Only the account container is thinned, and by name of the
 * noise (a balance, a contact record, a signed link, a timestamp), so a field nobody listed is material, never hidden. It
 * only orders and names: the refusal itself, and `changed_fields`, are never narrowed by it. A read whose role is not known
 * is a target, so nothing is ever left out for want of a label.
 */
const at = (read, ...keys) =>
  '$[' + read + ']' + keys.map(k => (typeof k === 'number' ? '[' + k + ']' : '["' + k + '"]')).join('');
const row = (read, key) => at(read, 'data', 'list', 0, key);

test('a change in a read of unknown role is material, in the order the diff found it', () => {
  const changed = [row(0, 'budget'), row(1, 'balance'), row(1, 'currency')];
  assert.deepEqual(materialFields(changed, [{}, {}]), changed);
  assert.deepEqual(materialFields(changed, []), changed);
  assert.deepEqual(materialFields(changed, undefined), changed);
  assert.deepEqual(materialFields([], [{}]), []);
});

test('a target is listed first, then the changes of the account, and only known noise of the account is left out', () => {
  const reads = [{role: 'account'}, {role: 'target'}],
    changed = [row(0, 'currency'), row(0, 'balance'), row(1, 'budget'), row(0, 'license_url'), row(0, 'status')];
  assert.deepEqual(materialFields(changed, reads), [row(1, 'budget'), row(0, 'currency'), row(0, 'status')]);
});

test('a parent, a target and a reference are compared whole, in that order, before the account', () => {
  const reads = [{role: 'account'}, {role: 'reference'}, {role: 'target'}, {role: 'parent'}],
    changed = [row(0, 'name'), row(1, 'pixel_code'), row(2, 'budget'), row(3, 'placements'), row(3, 'balance')];
  assert.deepEqual(materialFields(changed, reads), [
    row(2, 'budget'),
    row(3, 'placements'),
    row(3, 'balance'),
    row(1, 'pixel_code'),
    row(0, 'name'),
  ]);
});

test('the four roles, in any letter case, and the pair label (which is the stricter of the two, a parent)', () => {
  const changed = [row(0, 'balance')];
  assert.deepEqual(materialFields(changed, [{role: 'account'}]), [], 'account container: a balance is noise');
  assert.deepEqual(materialFields(changed, [{role: 'ACCOUNT'}]), []);
  for (const role of [
    'parent',
    'PARENT',
    'ACCOUNT/PARENT',
    'Account_Parent',
    'account_or_parent',
    'target',
    'reference',
  ])
    assert.deepEqual(materialFields(changed, [{role}]), changed, role + ' is compared whole');
  // A label this code does not know is no label: the read is a target.
  for (const role of ['banana', '', 7, null, {}])
    assert.deepEqual(materialFields(changed, [{role}]), changed, String(role));
});

test('the role comes from one place, the read’s own tag: stateRole (the hash package’s name) or role, stateRole first', () => {
  assert.equal(declaredRole({stateRole: 'account'}), 'account');
  assert.equal(declaredRole({stateRole: 'parent'}), 'parent');
  assert.equal(declaredRole({role: 'target'}), 'target');
  assert.equal(declaredRole({stateRole: 'parent', role: 'account'}), 'parent', 'stateRole wins');
  assert.equal(
    declaredRole({stateRole: 'banana', role: 'reference'}),
    'reference',
    'an unknown stateRole falls through',
  );
  for (const read of [undefined, null, {}, {stateRole: 3}, {role: 'banana'}, 'account', 7])
    assert.equal(declaredRole(read), undefined, JSON.stringify(read));
  const changed = [row(0, 'balance'), row(1, 'placements')];
  assert.deepEqual(materialFields(changed, [{stateRole: 'account'}, {stateRole: 'parent'}]), [row(1, 'placements')]);
  assert.equal(readRoleOf({stateRole: 'parent'}, undefined), 'parent');
});

test('a TikTok parent ad group’s placements and an X account’s deleted flag are material when they change', () => {
  // The parent keeps the fields its provider's write gate depends on (placements); the account container is thinned only by
  // known noise, so a flag no list names (deleted) is material.
  const reads = [
    {gateway: 'tiktok_native_action', path: '/open_api/v1.3/advertiser/info/', stateRole: 'account'},
    {gateway: 'tiktok_native_action', path: '/open_api/v1.3/adgroup/get/', stateRole: 'parent'},
  ];
  assert.deepEqual(materialFields([row(1, 'placements'), row(0, 'balance')], reads), [row(1, 'placements')]);
  const x = [{gateway: 'x_ads_native_action', path: '/12/accounts/abc'}],
    create = {gateway: 'x_ads_native_action', path: '/12/accounts/abc/line_items', method: 'POST'};
  assert.equal(readRoleOf(x[0], create), 'account');
  assert.deepEqual(materialFields([row(0, 'deleted'), row(0, 'name')], x, create), [row(0, 'deleted'), row(0, 'name')]);
  for (const field of ['deleted', 'test', 'reference', 'objective', 'placements', 'spend_cap', 'some_future_field'])
    assert.deepEqual(materialFields([row(0, field)], x, create), [row(0, field)], field);
});

test('an account container is thinned by name of the noise, in every spelling a provider uses', () => {
  const noise = [
      'balance',
      'account_balance',
      'amount_spent',
      'total_spent',
      'license_url',
      'logo_uri',
      'signedLink',
      'create_time',
      'createdAt',
      'updated_at',
      'last_modified',
      'email',
      'contact_email',
      'phone_number',
      'telephone_number',
      'contacter',
    ],
    material = [
      'id',
      'advertiser_id',
      'adAccountId',
      'name',
      'descriptiveName',
      'status',
      'account_status',
      'role',
      'currency',
      'currencyCode',
      'timezone',
      'timeZone',
      'country',
      'organization_id',
      'type',
      'deleted',
      'disabled',
      'test',
      'reference',
      'spend_cap',
      'objective',
      'some_future_field',
    ],
    reads = [{role: 'account'}];
  assert.deepEqual(
    materialFields(
      noise.map(k => row(0, k)),
      reads,
    ),
    [],
  );
  assert.deepEqual(
    materialFields(
      material.map(k => row(0, k)),
      reads,
    ),
    material.map(k => row(0, k)),
  );
  // A whole row appearing or disappearing is material, a value nested under a noise key is noise, and under another key not.
  const rows = [
    at(0, 'data', 'list', 1),
    at(0, 'data', 'list', 0, 'status', 'code'),
    at(0, 'data', 'list', 0, 'billing', 'balance'),
    at(0, 'data', 'list', 0, 'billing', 'plan'),
  ];
  assert.deepEqual(materialFields(rows, reads), [rows[0], rows[1], rows[3]]);
});

test('the account read of a create is found through its provider’s own account path, and the account written itself is a target', () => {
  const account = {gateway: 'snapchat_native_action', path: '/v1/adaccounts/abc', method: 'GET'},
    squads = {gateway: 'snapchat_native_action', path: '/v1/adaccounts/abc/adsquads', method: 'GET'},
    create = {gateway: 'snapchat_native_action', path: '/v1/adaccounts/abc/campaigns', method: 'POST'},
    renameAccount = {gateway: 'snapchat_native_action', path: '/v1/adaccounts/abc', method: 'PUT'},
    changed = [row(0, 'currency'), row(0, 'balance'), row(1, 'name')];
  assert.equal(readRoleOf(account, create), 'account');
  assert.equal(readRoleOf(squads, create), 'target', 'a list under the account is not the account');
  assert.equal(readRoleOf(account, renameAccount), 'target', 'the account a write changes is its target');
  assert.equal(readRoleOf(account, undefined), 'account');
  assert.deepEqual(materialFields(changed, [account, squads], create), [row(1, 'name'), row(0, 'currency')]);
  assert.deepEqual(materialFields(changed, [account, squads], renameAccount), changed);
  // A gateway that declares no account path, and a path that only starts like one, are targets.
  assert.equal(readRoleOf({gateway: 'amcp_synthetic', path: '/v1/adaccounts/abc'}, undefined), 'target');
  assert.equal(readRoleOf({gateway: 'snapchat_native_action', path: '/v1/adaccounts/abc/x'}, create), 'target');
  assert.equal(readRoleOf(undefined, create), 'target');
});

test('a tag on the read wins over the account path', () => {
  const account = {gateway: 'snapchat_native_action', path: '/v1/adaccounts/abc'},
    create = {gateway: 'snapchat_native_action', path: '/v1/adaccounts/abc/campaigns', method: 'POST'};
  assert.equal(readRoleOf({...account, role: 'target'}, create), 'target');
  assert.equal(readRoleOf({...account, role: 'reference'}, create), 'reference');
  assert.equal(readRoleOf({...account, role: 'parent'}, create), 'parent');
  assert.equal(readRoleOf({...account, stateRole: 'parent'}, create), 'parent');
});

test('a path that names no read, or one outside the list of reads, is material', () => {
  const reads = [{role: 'account'}],
    changed = ['$["x"]', '$', '$[5]["a"]', row(0, 'balance'), 'not a path'];
  assert.deepEqual(materialFields(changed, reads), ['$["x"]', '$', '$[5]["a"]', 'not a path']);
});

test('what the refusal shows of the material fields is cut at a bound, with the full count when it was cut', () => {
  const few = Array.from({length: materialLimit}, (_, i) => row(0, 'f' + i));
  assert.deepEqual(surfacedMaterial(few), {material: few});
  assert.deepEqual(surfacedMaterial([]), {material: []});
  const many = [...few, row(0, 'extra_1'), row(0, 'extra_2')];
  assert.deepEqual(surfacedMaterial(many), {material: few, material_total: many.length});
  assert.ok(materialLimit >= 10 && materialLimit <= 50, 'a handful, not the whole diff');
});

test('a path is read as changedStateFields writes it: values never appear in it, and a key with a quote or bracket stays one key', () => {
  const reads = [{role: 'account'}],
    odd = '$[0]["data"]["list"][0]["a\\"]b"]',
    named = '$[0]["data"]["list"][0]["currency\\"]"]';
  assert.deepEqual(materialFields([odd, named], reads), [odd, named]);
  const noisy = '$[0]["data"]["list"][0]["bal\\"]ance"]';
  assert.deepEqual(materialFields([noisy], reads), [noisy], 'a key that only looks like noise is not noise');
  // The role is the first subscript only: a number deeper in the path is not a read.
  assert.deepEqual(materialFields(['$[1]["a"][0]["balance"]'], [{role: 'account'}, {role: 'target'}]), [
    '$[1]["a"][0]["balance"]',
  ]);
});
