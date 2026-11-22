// R2.5 field3, package r25-field3-recipes, AMCP-08 F8-2: the one reader every recipe uses for an input that takes one of a fixed set of values.
// Absent is required; a wrong type or a value outside the set is invalid and says the input, the type received and the values accepted; a match
// after folding the letters of the exact value gives the canonical value, and nothing else is folded.
import test from 'node:test';
import assert from 'node:assert/strict';
import {recipeChoices, recipeEnum} from '../dist/src/recipe-values.js';
import {assertRefused} from './helpers/assert-refused.mjs';

const folded = {type: 'enum', values: ['ALPHA', 'BETA_ONE'], case_insensitive: true},
  exact = {type: 'enum', values: ['ALPHA', 'BETA_ONE']},
  declaration = {
    type: 'enum',
    values: ['CONTAINS_IT', 'DOES_NOT_CONTAIN_IT'],
    case_insensitive: true,
    accepts_boolean: {true: 'CONTAINS_IT', false: 'DOES_NOT_CONTAIN_IT'},
  },
  days = {type: 'integer', values: [1, 7]};
const invalid = (fn, field, type, allowed) =>
  assert.throws(
    fn,
    e =>
      assertRefused(e, 'RECIPE_INPUT_INVALID') &&
      JSON.stringify(Object.keys(e.details).sort()) === JSON.stringify(['allowed', 'field', 'received_type']) &&
      e.details.field === field &&
      e.details.received_type === type &&
      JSON.stringify(e.details.allowed) === JSON.stringify(allowed),
  );

test('a listed value is accepted as it is, and a folded one gives the canonical value only where the input folds', () => {
  assert.equal(recipeEnum({k: 'ALPHA'}, 'k', folded), 'ALPHA');
  assert.equal(recipeEnum({k: 'alpha'}, 'k', folded), 'ALPHA');
  assert.equal(recipeEnum({k: 'Beta_One'}, 'k', folded), 'BETA_ONE');
  assert.equal(recipeEnum({k: 'ALPHA'}, 'k', exact), 'ALPHA');
  invalid(() => recipeEnum({k: 'alpha'}, 'k', exact), 'k', 'string', ['ALPHA', 'BETA_ONE']);
});

test('left out or blank is required, names the input and lists the values it takes; an optional input left out or blank is no input', () => {
  for (const b of [{}, {k: undefined}, {k: ''}])
    assert.throws(
      () => recipeEnum(b, 'k', folded),
      e =>
        assertRefused(e, 'RECIPE_INPUT_REQUIRED') &&
        JSON.stringify(e.details) === JSON.stringify({missing_fields: ['k'], allowed: ['ALPHA', 'BETA_ONE']}),
    );
  for (const b of [{}, {k: undefined}, {k: ''}]) assert.equal(recipeEnum(b, 'k', folded, true), undefined);
  // An optional input that is given is judged like a required one.
  invalid(() => recipeEnum({k: 'gamma'}, 'k', folded, true), 'k', 'string', ['ALPHA', 'BETA_ONE']);
});

test('a wrong type is invalid and not missing: false, null, a number, a list and an object all say what they were', () => {
  for (const [value, type] of [
    [false, 'boolean'],
    [true, 'boolean'],
    [null, 'null'],
    [0, 'number'],
    [1.5, 'number'],
    [['ALPHA'], 'array'],
    [[], 'array'],
    [{}, 'object'],
  ])
    invalid(() => recipeEnum({k: value}, 'k', folded), 'k', type, ['ALPHA', 'BETA_ONE']);
});

test('nothing but the letters of the exact value is folded: no trimming, no synonyms, no lookalike letters', () => {
  for (const value of [
    ' ALPHA',
    'ALPHA ',
    '\tALPHA',
    'ALPHA\n',
    'ALPH',
    'ALPHAS',
    'Alpha-',
    'A L P H A',
    'beta one',
    'BETA-ONE',
  ])
    invalid(() => recipeEnum({k: value}, 'k', folded), 'k', 'string', ['ALPHA', 'BETA_ONE']);
  // The Kelvin sign and the dotless i fold to k and i in a full Unicode fold, which would make them synonyms of K and I.
  invalid(() => recipeEnum({k: 'KEEP'}, 'k', {type: 'enum', values: ['KEEP'], case_insensitive: true}), 'k', 'string', [
    'KEEP',
  ]);
  invalid(() => recipeEnum({k: 'ıNFO'}, 'k', {type: 'enum', values: ['INFO'], case_insensitive: true}), 'k', 'string', [
    'INFO',
  ]);
});

test('only a yes/no declaration takes a boolean, and each boolean is the one exact value it means; it is never a default', () => {
  assert.equal(recipeEnum({k: true}, 'k', declaration), 'CONTAINS_IT');
  assert.equal(recipeEnum({k: false}, 'k', declaration), 'DOES_NOT_CONTAIN_IT');
  assert.equal(recipeEnum({k: 'does_not_contain_it'}, 'k', declaration), 'DOES_NOT_CONTAIN_IT');
  invalid(() => recipeEnum({k: 'no'}, 'k', declaration), 'k', 'string', ['CONTAINS_IT', 'DOES_NOT_CONTAIN_IT']);
  invalid(() => recipeEnum({k: 0}, 'k', declaration), 'k', 'number', ['CONTAINS_IT', 'DOES_NOT_CONTAIN_IT']);
  invalid(() => recipeEnum({k: null}, 'k', declaration), 'k', 'null', ['CONTAINS_IT', 'DOES_NOT_CONTAIN_IT']);
  // Left out, the declaration is required: neither value is chosen for the person.
  assert.throws(
    () => recipeEnum({}, 'k', declaration),
    e => assertRefused(e, 'RECIPE_INPUT_REQUIRED'),
  );
  // An input that does not declare a boolean form refuses a boolean.
  invalid(() => recipeEnum({k: true}, 'k', folded), 'k', 'boolean', ['ALPHA', 'BETA_ONE']);
});

test('a whole-number set takes the number or its decimal text, and gives the number', () => {
  assert.equal(recipeEnum({k: 1}, 'k', days), 1);
  assert.equal(recipeEnum({k: '1'}, 'k', days), 1);
  assert.equal(recipeEnum({k: 7}, 'k', days), 7);
  assert.equal(recipeEnum({k: '7'}, 'k', days), 7);
  for (const [value, type] of [
    [2, 'number'],
    ['07', 'string'],
    ['1.0', 'string'],
    [1.5, 'number'],
    ['x', 'string'],
    [true, 'boolean'],
    [null, 'null'],
    [[1], 'array'],
  ])
    invalid(() => recipeEnum({k: value}, 'k', days), 'k', type, [1, 7]);
});

test('the refusal lists a copy of the values, so a caller cannot change what the recipe declares', () => {
  const declared = {type: 'enum', values: ['ALPHA']};
  assert.throws(
    () => recipeEnum({k: 'nope'}, 'k', declared),
    e => {
      e.details.allowed.push('INJECTED');
      return true;
    },
  );
  assert.deepEqual(declared.values, ['ALPHA']);
});

test('S4-4: two values of one set that differ only in the case of their letters are refused when the set is declared', () => {
  // The reader returns the first folded match, so a set with two such values would make a folded value mean whichever came first.
  for (const values of [
    ['TT_USER', 'tt_user'],
    ['A', 'B', 'a'],
    ['Open', 'OPEN'],
    ['x', 'X', 'y'],
  ])
    assert.throws(() => recipeChoices(values), /differ only in the case of their letters/, values.join(','));
  // Values that differ in anything but the case of an ASCII letter are distinct: another character, or a lookalike letter that is not folded.
  assert.deepEqual([...recipeChoices(['A_1', 'A-1', 'A1']).values], ['A_1', 'A-1', 'A1']);
  assert.deepEqual([...recipeChoices(['K', '\u212A']).values], ['K', '\u212A']);
  assert.deepEqual([...recipeChoices(['I', '\u0131']).values], ['I', '\u0131']);
  assert.equal(recipeEnum({k: '\u212A'}, 'k', recipeChoices(['K', '\u212A'])), '\u212A');
});
