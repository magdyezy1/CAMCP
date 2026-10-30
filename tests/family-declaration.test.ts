import test from 'node:test';
import assert from 'node:assert/strict';
import {defineFamily} from '../src/family-kit.js';
import type {ReviewedFamily} from '../src/reviewed-family.js';

// ARC-04 stage C: defineFamily is typed by the stages (FamilyDeclaration), so a declaration with a member that is no
// hook of any stage does not compile. `npm run build` compiles this file, and an unused @ts-expect-error fails it:
// with the earlier `defineFamily<F extends ReviewedFamily>(family: F)` the misspelt hook below compiled, because a
// generic parameter is not checked for excess members.
const plain = (): ReviewedFamily =>
  defineFamily({
    name: 'x_example_family',
    files: ['src/x-example.ts', ['tests/x-example.test.mjs']],
    // Hooks written in place are typed by their stage: `plan` is a CompiledRequest.
    kind: plan => plan.action === 'x_example_write',
    outcome: (_plan, result) => result.status === 200,
  });
const misspelt = (): ReviewedFamily =>
  defineFamily({
    name: 'x_example_family',
    files: ['src/x-example.ts', ['tests/x-example.test.mjs']],
    kind: () => false,
    // @ts-expect-error `verfication` is no hook of any stage: a misspelt hook would never be called
    verfication: () => [],
  });

test('defineFamily takes the hooks of the stages and returns the declaration unchanged', () => {
  const family = plain();
  assert.equal(family.name, 'x_example_family');
  assert.equal(family.kind({action: 'x_example_write'} as never), true);
});

test('a misspelt hook fails the build here, and the module load wherever a declaration is not type checked', () => {
  assert.throws(misspelt, (e: {code?: string; status?: number; message?: string}) => {
    assert.equal(e.code, 'REVIEWED_FAMILY_INVALID');
    assert.equal(e.status, 500);
    assert.match(String(e.message), /its member verfication is no hook of any stage/);
    return true;
  });
});
