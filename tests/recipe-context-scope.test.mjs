// R2.5 field3, package r25-field3-recipes, AMCP-06: recipe_context takes the account the agent works on, and stops listing every account of every
// login with its name, currency and time zone. The owner's session gave it an account_id and got a warning that the argument was unused and the
// accounts of every other client. Synthetic logins `c1` (customers 123 and 456) and `c2` (customer 789), and one login pair on each platform.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {recipeContext} from '../dist/src/recipe-context.js';
import {withContractProfile} from '../dist/src/contract-profile.js';
import {saveAccessSet} from '../dist/src/access-sets.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {accountName, admin, operator, platforms, recipeScopeWorld} from './fixtures/recipe-context-world.mjs';

// What recipe_context answered before this package, on this world: the legacy default, recorded on the tree before the change (its definitions
// had no `inputs`, which are taken out of the answers below before they are compared).
const before = JSON.parse(readFileSync('tests/fixtures/recipe-context-legacy-default.json', 'utf8'));
const google = platforms.google;
const ids = targets => targets.map(t => t.connection_id + '/' + t.account_id);
const data = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 700));
  return r.data;
};
const withoutInputs = answer => {
  const {recipe, targets_notice: _notice, ...rest} = answer,
    {inputs: _inputs, ...definition} = recipe;
  return {...rest, recipe: definition};
};
const world = t => {
  const w = recipeScopeWorld();
  t.after(() => w.store.close());
  return w;
};
const ctx = (w, input, who) => w.call({action: 'recipe_context', recipe: google.recipe, ...input}, who);

test('account_id narrows the targets to that account, in the account form of its platform, and a login or both narrow likewise', async t => {
  const w = world(t);
  for (const [filter, expected] of [
    [{account_id: '123'}, ['c1/123']],
    [{account_id: '1-23'}, ['c1/123']],
    [{account_id: '456'}, ['c1/456']],
    [{account_id: '789'}, ['c2/789']],
    [{connection_id: 'c2'}, ['c2/789']],
    [{connection_id: 'c1'}, ['c1/123', 'c1/456']],
    [{connection_id: 'c1', account_id: '456'}, ['c1/456']],
    [{gateway: google.gateway, account_id: '789', connection_id: 'c2'}, ['c2/789']],
  ]) {
    assert.deepEqual(ids(data(await ctx(w, filter)).targets), expected, JSON.stringify(filter));
  }
  // A narrowed answer names only the accounts it holds: no other client's name, currency or time zone.
  const one = JSON.stringify(data(await ctx(w, {account_id: '123'})));
  assert.ok(one.includes(accountName('c1', '123')));
  for (const other of [accountName('c1', '456'), accountName('c2', '789')])
    assert.ok(!one.includes(other), other + ' is not disclosed');
});

test('an unknown account, an unknown login and a pair that disagree are one refusal, ACCOUNT_SCOPE_MISMATCH, naming nothing', async t => {
  const w = world(t);
  const refusals = [];
  for (const filter of [
    {account_id: '999'},
    {connection_id: 'nobody'},
    {connection_id: 'c1', account_id: '789'},
    {connection_id: 'c2', account_id: '123'},
    {account_id: '1'.repeat(40)},
  ]) {
    const r = await ctx(w, filter);
    assertRefused(r, 'ACCOUNT_SCOPE_MISMATCH');
    refusals.push(JSON.stringify([r.error.code, r.error.message, r.error.details]));
  }
  assert.equal(new Set(refusals).size, 1, 'one refusal for every cause: ' + refusals.join(' | '));
  assert.ok(
    !refusals[0].includes('999') && !refusals[0].includes('nobody'),
    'the refusal does not repeat what was asked',
  );
});

test('an account outside the access set is indistinguishable from an unknown one, and the set is never widened by a filter', async t => {
  const w = world(t);
  const set = saveAccessSet(w.store, admin, {
    name: 'Client one',
    bindings: [{gateway: google.gateway, connection_id: 'c1', account_id: '123'}],
  });
  const scoped = {...operator, accessSetId: String(set.id)};
  // Customer 789 exists in the workspace, outside the set; 999 does not exist: the same refusal, to the byte.
  const outside = await ctx(w, {account_id: '789'}, scoped),
    unknown = await ctx(w, {account_id: '999'}, scoped),
    otherLogin = await ctx(w, {connection_id: 'c2'}, scoped),
    sameSet = await ctx(w, {account_id: '456'}, scoped);
  for (const r of [outside, unknown, otherLogin, sameSet]) assertRefused(r, 'ACCOUNT_SCOPE_MISMATCH');
  const shape = r => JSON.stringify([r.error.code, r.error.message, r.error.details]);
  assert.equal(shape(outside), shape(unknown));
  assert.equal(shape(otherLogin), shape(unknown));
  assert.equal(shape(sameSet), shape(unknown), 'another account of the same login, outside the set');
  // Inside the set the filter answers, and the unfiltered answer holds nothing else.
  assert.deepEqual(ids(data(await ctx(w, {account_id: '123'}, scoped)).targets), ['c1/123']);
  assert.deepEqual(ids(data(await ctx(w, {}, scoped)).targets), ['c1/123']);
});

test('a filter intersects a playbook’s bindings and never widens them; the count it leaves out is the playbook’s alone', async t => {
  const w = recipeScopeWorld({
    profile: [
      ['c1', '123'],
      ['c1', '456'],
    ],
  });
  t.after(() => w.store.close());
  const withProfile = input => ctx(w, {profile_id: 'playbook', ...input});
  assert.deepEqual(ids(data(await withProfile({})).targets), ['c1/123', 'c1/456']);
  assert.equal(data(await withProfile({})).excluded_by_playbook, 1);
  const narrowed = data(await withProfile({account_id: '123'}));
  assert.deepEqual(ids(narrowed.targets), ['c1/123']);
  assert.equal(narrowed.excluded_by_playbook, 1, 'the account the filter left out is not one the playbook left out');
  assert.deepEqual(ids(data(await withProfile({connection_id: 'c1'})).targets), ['c1/123', 'c1/456']);
  // 789 is in reach but not in the playbook: it is not an answer, and it is the same refusal as an account that does not exist.
  const outside = await withProfile({account_id: '789'}),
    unknown = await withProfile({account_id: '999'});
  assertRefused(outside, 'ACCOUNT_SCOPE_MISMATCH');
  assertRefused(unknown, 'ACCOUNT_SCOPE_MISMATCH');
  assert.equal(JSON.stringify(outside.error.details), JSON.stringify(unknown.error.details));
  assertRefused(await withProfile({connection_id: 'c2'}), 'ACCOUNT_SCOPE_MISMATCH');
});

test('pages follow the matched login, and a Drive login gives its file count under a filter, never its file IDs', async t => {
  const w = world(t);
  const meta = platforms.meta,
    all = data(await w.call({action: 'recipe_context', recipe: meta.recipe}));
  assert.deepEqual(
    all.pages.map(p => p.id),
    ['page-of-m1', 'page-of-m2'],
  );
  assert.deepEqual(
    all.drive_connections.map(d => d.files),
    [['drive-file-one', 'drive-file-two'], ['drive-file-three']],
  );
  const m1 = data(await w.call({action: 'recipe_context', recipe: meta.recipe, connection_id: 'm1'}));
  assert.deepEqual(
    m1.pages.map(p => p.id),
    ['page-of-m1'],
  );
  const byAccount = data(await w.call({action: 'recipe_context', recipe: meta.recipe, account_id: 'act_3330'}));
  assert.deepEqual(ids(byAccount.targets), ['m2/3330'], 'a Meta account is matched with or without its act_ prefix');
  assert.deepEqual(
    byAccount.pages.map(p => p.id),
    ['page-of-m2'],
  );
  assert.deepEqual(byAccount.drive_connections, [
    {id: 'd1', label: 'd1 login', files_count: 2},
    {id: 'd2', label: 'd2 login', files_count: 1},
  ]);
  assert.ok(!JSON.stringify(m1).includes('drive-file'), 'no file ID of any Drive login under a filter');
});

test('gateway is checked against the recipe’s, and a filter that is not an exact short text is refused', async t => {
  const w = world(t);
  const wrong = await ctx(w, {gateway: platforms.meta.gateway});
  assertRefused(wrong, 'CONFLICTING_PARAMETER');
  assert.equal(wrong.error.details.recipe_gateway, google.gateway);
  assert.equal(
    data(await ctx(w, {gateway: google.gateway})).targets.length,
    3,
    'the recipe’s own gateway narrows nothing',
  );
  for (const key of ['account_id', 'connection_id', 'gateway'])
    for (const value of ['', 'x'.repeat(201)]) assertRefused(await ctx(w, {[key]: value}), 'INVALID_ARGUMENT');
});

test('the legacy default is what it was, deep-equal to the answer recorded before the change, and says when it spans more than one login', async t => {
  const w = world(t);
  for (const [name, {recipe}] of Object.entries(platforms)) {
    const answer = data(await w.call({action: 'recipe_context', recipe}));
    assert.deepEqual(withoutInputs(answer), before[name], name + ' default answer');
    // Both logins of the platform are in the list, so the answer names the way to narrow it.
    assert.match(String(answer.targets_notice), /account_id|connection_id/, name + ' notice');
  }
  // One login: nothing to say, and the whole answer is the recorded one.
  const one = recipeScopeWorld({profile: true});
  t.after(() => one.store.close());
  const answer = data(await one.call({action: 'recipe_context', recipe: google.recipe, profile_id: 'playbook'}));
  assert.equal(answer.targets_notice, undefined);
  assert.deepEqual(withoutInputs(answer), before.google_with_profile);
  // What the website sends is a call with no filter, and the legacy contract profile answers it as before, whatever `detail` says.
  const compact = data(await w.call({action: 'recipe_context', recipe: google.recipe, detail: 'compact'}));
  assert.deepEqual(withoutInputs(compact), before.google);
});

test('the internal callers keep the unfiltered context: recipeContext without a scope is what it was, with no notice', async t => {
  const w = world(t);
  const context = recipeContext(w.store, operator, google.recipe);
  assert.deepEqual(withoutInputs(context), before.google);
  assert.equal(context.targets_notice, undefined);
  // A scope narrows the same function, as recipe_context asks it to.
  assert.deepEqual(ids(recipeContext(w.store, operator, google.recipe, undefined, {account_id: '456'}).targets), [
    'c1/456',
  ]);
});

test('a v2 client’s default is ID-only rows and the call that returns the rest; a filter or detail:"full" returns the names', async t => {
  const w = world(t);
  const v2 = (input, own = input) =>
    withContractProfile('v2', () => w.service.call('amcp_campaign', input, operator), own);
  const input = {action: 'recipe_context', recipe: google.recipe},
    compact = data(await v2(input));
  assert.deepEqual(
    compact.targets.map(r => Object.keys(r).sort()),
    Array(3).fill(['account_id', 'connection_id', 'write_granted']),
  );
  assert.deepEqual(ids(compact.targets), ['c1/123', 'c1/456', 'c2/789']);
  assert.deepEqual(compact.full_targets_call, {
    tool: 'amcp_campaign',
    arguments: {action: 'recipe_context', recipe: google.recipe, detail: 'full'},
  });
  const text = JSON.stringify(compact);
  for (const a of [accountName('c1', '123'), accountName('c1', '456'), accountName('c2', '789'), 'Africa/Cairo'])
    assert.ok(!text.includes(a), a);
  assert.deepEqual(
    compact.drive_connections.map(d => [d.id, d.files_count, d.files]),
    [
      ['d1', 2, undefined],
      ['d2', 1, undefined],
    ],
  );
  // The call it names returns the whole answer, which is the legacy one.
  const full = data(await v2({...compact.full_targets_call.arguments}));
  assert.deepEqual(withoutInputs(full), before.google);
  assert.equal(full.full_targets_call, undefined);
  // A filter returns the matched account in full.
  const one = data(await v2({...input, account_id: '789'}));
  assert.equal(one.targets.length, 1);
  assert.equal(one.targets[0].name, accountName('c2', '789'));
  assert.equal(one.full_targets_call, undefined);
  // A call that a workflow made while serving the client's call, and not the client's own, is answered as the legacy profile answers it.
  const nested = data(await v2(input, {}));
  assert.equal(nested.targets[0].name, accountName('c1', '123'));
});

test('every platform’s recipe takes the same filters: one account, one login, a pair, and an account that is not there', async t => {
  const w = world(t);
  for (const [name, {recipe, logins}] of Object.entries(platforms)) {
    const [[first, [a1, a2]], [second, [b1]]] = logins;
    const ask = filter => w.call({action: 'recipe_context', recipe, ...filter});
    assert.deepEqual(ids(data(await ask({account_id: a1})).targets), [first + '/' + a1], name + ' by account');
    assert.deepEqual(ids(data(await ask({connection_id: second})).targets), [second + '/' + b1], name + ' by login');
    assert.deepEqual(
      ids(data(await ask({connection_id: first, account_id: a2})).targets),
      [first + '/' + a2],
      name + ' by both',
    );
    assert.deepEqual(
      ids(data(await ask({connection_id: first})).targets),
      [first + '/' + a1, first + '/' + a2],
      name + ' login accounts',
    );
    assertRefused(await ask({account_id: 'not-an-account'}), 'ACCOUNT_SCOPE_MISMATCH');
    assertRefused(await ask({connection_id: first, account_id: b1}), 'ACCOUNT_SCOPE_MISMATCH');
    const text = JSON.stringify(data(await ask({account_id: a1})));
    assert.ok(!text.includes(accountName(second, b1)), name + ' discloses no other login’s account name');
  }
});
