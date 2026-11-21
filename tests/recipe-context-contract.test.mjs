// R2.5 field3, package r25-field3-recipes, AMCP-06: the contract row of recipe_context says which arguments it reads. Before, the row listed only
// `recipe` and `profile_id`, so a call that named an account got a warning that the argument was unused. The row and the generated action reference
// in the workspace guide change together; the behaviour of the arguments is tested in tests/recipe-context-scope.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {authoredArguments} from '../dist/src/first-party-contracts.js';
import {recipeScopeWorld, platforms} from './fixtures/recipe-context-world.mjs';

const warned = (r, field) =>
  (r.meta?.argument_warnings ?? []).some(w => w.code === 'ARGUMENT_NOT_USED_BY_ACTION' && w.field === field);

test('the row lists the arguments recipe_context reads: the recipe and profile as before, and the account, login, gateway and detail', () => {
  assert.deepEqual(authoredArguments('amcp_campaign', 'recipe_context'), [
    'recipe',
    'profile_id',
    'account_id',
    'connection_id',
    'gateway',
    'detail',
  ]);
});

test('a call that names an account, a login, a gateway or a detail level draws no unused-argument warning; one that names something else still does', async t => {
  const w = recipeScopeWorld();
  t.after(() => w.store.close());
  const call = extra => w.call({action: 'recipe_context', recipe: platforms.google.recipe, ...extra});
  for (const extra of [
    {account_id: '123'},
    {connection_id: 'c1'},
    {gateway: platforms.google.gateway},
    {detail: 'full'},
    {detail: 'compact'},
  ]) {
    const r = await call(extra);
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 500));
    for (const field of Object.keys(extra)) assert.equal(warned(r, field), false, field + ' is read');
  }
  // The check is still there: `topic` is an argument of another action of the tool, and recipe_context does not read it.
  assert.equal(warned(await call({topic: 'x'}), 'topic'), true);
});

test('the workspace guide’s generated action reference lists the four arguments on the recipe_context row', () => {
  const guide = readFileSync('Skills/amcp-campaign-builder/references/workspace.md', 'utf8'),
    line = guide.split('\n').find(l => l.startsWith('| `recipe_context` |'));
  assert.ok(line, 'the row is in the generated reference');
  for (const argument of ['`profile_id`', '`account_id`', '`connection_id`', '`gateway`', '`detail`'])
    assert.ok(line.includes(argument), argument);
  assert.ok(line.includes('**`recipe`**'), 'the recipe stays required');
});
