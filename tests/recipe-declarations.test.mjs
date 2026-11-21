// R2.5 field3 fix round, package r25-field3-recipes (the lead's review of 2026-11-22): the declarations of the recipes. A declaration is the person's own
// statement of a fact (the EU political advertising declaration, LinkedIn's political intent, Snapchat's regulated content, Meta's special ad
// categories, the goal and value policies): it is never defaulted, never taken from a playbook, and never answered with the one value a recipe
// takes. Synthetic briefs only; nothing reaches a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {assertRefused} from './helpers/assert-refused.mjs';

const examples = JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'));
const definition = id => campaignRecipes.find(r => r.id === id);
const snapchat = {
  snapchat_website_traffic: examples.snapchat_traffic_business,
  snapchat_lead_generation: examples.snapchat_lead_business,
};

test('S4-5: both Snapchat recipes declare regulated_content as a yes/no declaration of which only false is taken', () => {
  for (const id of Object.keys(snapchat)) {
    const spec = definition(id).inputs.regulated_content;
    assert.deepEqual({...spec}, {type: 'boolean', values: [false]}, id);
    assert.ok(Object.isFrozen(spec) && Object.isFrozen(spec.values), id + ' cannot be changed by a caller');
    assert.ok(definition(id).required.includes('regulated_content'), id);
  }
  assert.deepEqual(Object.keys(definition('snapchat_lead_generation').inputs).sort(), [
    'optimization_goal',
    'regulated_content',
  ]);
});

test('S4-5: regulated_content false compiles; true is a prerequisite that names no value to swap it for; another type is invalid and names its type', () => {
  for (const [id, brief] of Object.entries(snapchat)) {
    assert.ok(campaignRecipe(id, {...brief, regulated_content: false}).steps.length, id);
    assert.throws(
      () => campaignRecipe(id, {...brief, regulated_content: true}),
      e => assertRefused(e, 'RECIPE_PREREQUISITES_REQUIRED') && e.details?.allowed === undefined,
      id,
    );
    for (const [wrong, type] of [
      ['false', 'string'],
      ['true', 'string'],
      ['no', 'string'],
      [0, 'number'],
      [1, 'number'],
      [null, 'null'],
      [[], 'array'],
      [{}, 'object'],
    ])
      assert.throws(
        () => campaignRecipe(id, {...brief, regulated_content: wrong}),
        e =>
          assertRefused(e, 'RECIPE_INPUT_INVALID') &&
          e.details.field === 'regulated_content' &&
          e.details.received_type === type &&
          e.details.allowed === undefined,
        id + ' ' + JSON.stringify(wrong),
      );
    // Left out, it is still required, as every declaration is: nothing defaults it to false.
    const {regulated_content: _left, ...without} = brief;
    assert.throws(
      () => campaignRecipe(id, without),
      e => assertRefused(e, 'RECIPE_INPUT_REQUIRED') && e.details.missing_fields.includes('regulated_content'),
      id,
    );
  }
});
