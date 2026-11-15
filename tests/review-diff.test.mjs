import test from 'node:test';
import assert from 'node:assert/strict';
import {readRoleOf, materialFields, surfacedMaterial, materialLimit} from '../dist/src/review-diff.js';

/**
 * Round 2.5, package r25-m1-diff (L5-04): which of the changed fields of a STATE_CHANGED matter. A review reads several
 * things before a write: the account or parent the write sits in, the objects it changes (the target), and the pixels,
 * identities or catalogs it names (references). Only the target and reference reads are compared whole; an account or
 * parent read matters through its identity fields (what the account is called, whether it is enabled, its currency and
 * time zone). `material` lists first what the target role protects, then the identity changes of the account and parent
 * reads. It only orders and names: the refusal itself, and `changed_fields`, are never narrowed by it. A read whose role
 * is not known is a target, so nothing is ever left out for want of a label.
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

test('a target is listed first, then the identity changes of the account, and an account field that is no identity is left out', () => {
  const reads = [{role: 'account'}, {role: 'target'}],
    changed = [row(0, 'currency'), row(0, 'balance'), row(1, 'budget'), row(0, 'license_url'), row(0, 'status')];
  assert.deepEqual(materialFields(changed, reads), [row(1, 'budget'), row(0, 'currency'), row(0, 'status')]);
});

test('a reference is material like a target, after the targets and before the account', () => {
  const reads = [{role: 'account'}, {role: 'reference'}, {role: 'target'}],
    changed = [row(0, 'name'), row(1, 'pixel_code'), row(2, 'budget')];
  assert.deepEqual(materialFields(changed, reads), [row(2, 'budget'), row(1, 'pixel_code'), row(0, 'name')]);
});

test('the role names are the three of the review check, in any letter case and either name of the pair', () => {
  const changed = [row(0, 'balance')];
  for (const role of ['account', 'parent', 'ACCOUNT/PARENT', 'Account_Parent', 'account_or_parent'])
    assert.deepEqual(materialFields(changed, [{role}]), [], role + ' is an account or parent read');
  for (const role of ['target', 'TARGET', 'reference', 'REFERENCE'])
    assert.deepEqual(materialFields(changed, [{role}]), changed, role + ' is compared whole');
  // A label this code does not know is no label: the read is a target.
  for (const role of ['banana', '', 7, null, {}])
    assert.deepEqual(materialFields(changed, [{role}]), changed, String(role));
});

test('an identity field is recognised by name in every spelling a provider uses, and a row that came or went is an identity change', () => {
  const identities = [
      'id',
      'advertiser_id',
      'adAccountId',
      'name',
      'descriptiveName',
      'resourceName',
      'display_name',
      'status',
      'account_status',
      'approval_status',
      'role',
      'currency',
      'currencyCode',
      'timezone',
      'timeZone',
      'time_zone',
      'timezone_name',
      'country',
      'organization_id',
      'organization',
      'type',
    ],
    noise = [
      'balance',
      'license_url',
      'create_time',
      'email',
      'phone_number',
      'amount_spent',
      'spend_cap',
      'some_future_field',
    ];
  const reads = [{role: 'account'}];
  assert.deepEqual(
    materialFields(
      identities.map(k => row(0, k)),
      reads,
    ),
    identities.map(k => row(0, k)),
  );
  assert.deepEqual(
    materialFields(
      noise.map(k => row(0, k)),
      reads,
    ),
    [],
  );
  // A whole row appearing or disappearing, and a value nested under an identity key.
  const rows = [
    at(0, 'data', 'list', 1),
    at(0, 'data', 'list', 0, 'status', 'code'),
    at(0, 'data', 'list', 0, 'billing', 'balance'),
  ];
  assert.deepEqual(materialFields(rows, reads), rows.slice(0, 2));
});

test('the account read of a create is found through its provider’s own account path, and the account written itself is a target', () => {
  const account = {gateway: 'snapchat_native_action', path: '/v1/adaccounts/abc', method: 'GET'},
    squads = {gateway: 'snapchat_native_action', path: '/v1/adaccounts/abc/adsquads', method: 'GET'},
    create = {gateway: 'snapchat_native_action', path: '/v1/adaccounts/abc/campaigns', method: 'POST'},
    renameAccount = {gateway: 'snapchat_native_action', path: '/v1/adaccounts/abc', method: 'PUT'},
    changed = [row(0, 'currency'), row(0, 'balance'), row(1, 'name')];
  assert.equal(readRoleOf(account, create), 'account_parent');
  assert.equal(readRoleOf(squads, create), 'target', 'a list under the account is not the account');
  assert.equal(readRoleOf(account, renameAccount), 'target', 'the account a write changes is its target');
  assert.equal(readRoleOf(account, undefined), 'account_parent');
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
  assert.equal(readRoleOf({...account, role: 'parent'}, create), 'account_parent');
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
  assert.deepEqual(materialFields([odd, named], reads), []);
  // The role is the first subscript only: a number deeper in the path is not a read.
  assert.deepEqual(materialFields(['$[1]["a"][0]["balance"]'], [{role: 'account'}, {role: 'target'}]), [
    '$[1]["a"][0]["balance"]',
  ]);
});
