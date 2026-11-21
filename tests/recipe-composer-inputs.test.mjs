// R2.5 field3, package r25-field3-recipes, AMCP-08 F8-4: the website's recipe form reads the values of each select from the recipe's own `inputs`,
// so a value the server accepts is a value the form offers, and a value it no longer accepts is gone from the form. Before, web/campaign-recipes.js
// kept its own copy of every list. Synthetic briefs only; nothing reaches a server.
import test from 'node:test';
import assert from 'node:assert/strict';
import {campaignRecipes} from '../dist/src/campaign-recipes.js';
import {recipeComposerFixture as fixture} from './fixtures/recipe-composer-ui.mjs';
import {recipeBriefs} from './fixtures/recipe-briefs.mjs';

const definitionOf = id => JSON.parse(JSON.stringify(campaignRecipes.find(r => r.id === id)));
// Every select of the form that offers the values of a fixed set: the recipe, and the input it is made from.
const selects = [
  ['google_search', 'contains_eu_political_advertising'],
  ['google_search_conversions', 'conversion_goal_policy'],
  ['google_search_conversion_value', 'conversion_value_policy'],
  ['google_performance_max', 'conversion_goal_policy'],
  ['google_performance_max', 'contains_eu_political_advertising'],
  ['snapchat_lead_generation', 'optimization_goal'],
  ['tiktok_website_traffic', 'identity_type'],
  ['tiktok_website_traffic', 'call_to_action'],
  ['tiktok_website_conversions', 'optimization_event'],
  ['linkedin_lead_generation', 'call_to_action'],
  ['linkedin_lead_generation', 'political_intent'],
  ['meta_website_sales', 'click_attribution_days'],
  ['meta_website_sales', 'view_attribution_days'],
];
/** The values a form's select offers, in order, without its "Choose explicitly" placeholder. */
async function offered(definition, field) {
  const f = fixture('en', definition, recipeBriefs[definition.id]);
  await f.mount();
  const html = f.node('#recipe-fields').innerHTML,
    select = new RegExp('<select name="' + field + '"[^>]*>(.*?)</select>', 's').exec(html);
  assert.ok(select, definition.id + ' offers a select for ' + field);
  return [...select[1].matchAll(/<option value="([^"]*)"/g)].map(m => m[1]).filter(v => v !== '');
}

test('every select of a fixed set offers exactly the values the recipe declares, in the order it declares them', async () => {
  for (const [id, field] of selects) {
    const definition = definitionOf(id);
    assert.deepEqual(await offered(definition, field), definition.inputs[field].values.map(String), id + ' ' + field);
  }
});

test('a value the server adds to a declaration is offered, and one it takes away is gone, with no change to the page', async () => {
  for (const [id, field] of selects) {
    const added = definitionOf(id),
      spec = added.inputs[field],
      extra = spec.type === 'integer' ? 28 : 'A_VALUE_THE_SERVER_ADDED';
    spec.values.push(extra);
    assert.deepEqual(await offered(added, field), spec.values.map(String), id + ' ' + field + ' with ' + extra);
    if (spec.values.length > 2) {
      const fewer = definitionOf(id);
      const [, ...rest] = fewer.inputs[field].values;
      fewer.inputs[field].values = rest;
      assert.deepEqual(await offered(fewer, field), rest.map(String), id + ' ' + field + ' without its first value');
    }
  }
});

test('a yes/no declaration keeps both answers on the form: Snapchat’s regulated_content lists false for the recipe, and true stays a choice that leads to a tailored plan', async () => {
  for (const id of ['snapchat_website_traffic', 'snapchat_lead_generation']) {
    const definition = definitionOf(id);
    assert.equal(definition.inputs.regulated_content?.type, 'boolean', id + ' declares it');
    assert.deepEqual(await offered(definition, 'regulated_content'), ['false', 'true'], id);
  }
});

test('the words that explain a known value stay the page’s own, translated, and a value without words shows as it is', async () => {
  const f = fixture('ar', definitionOf('google_performance_max'), recipeBriefs.google_performance_max);
  await f.mount();
  const html = f.node('#recipe-fields').innerHTML;
  assert.match(html, /<option value="ACCOUNT_DEFAULT"[^>]*>استخدام أهداف التحويل الافتراضية للحساب<\/option>/);
  assert.match(
    html,
    /<option value="DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING"[^>]*>لا يتضمن إعلانات سياسية في الاتحاد الأوروبي<\/option>/,
  );
  const added = definitionOf('google_performance_max');
  added.inputs.conversion_goal_policy.values.push('A_VALUE_THE_SERVER_ADDED');
  const g = fixture('en', added, recipeBriefs.google_performance_max);
  await g.mount();
  assert.match(
    g.node('#recipe-fields').innerHTML,
    /<option value="A_VALUE_THE_SERVER_ADDED"[^>]*>A_VALUE_THE_SERVER_ADDED<\/option>/,
  );
});
