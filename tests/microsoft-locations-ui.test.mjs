// CMP-03: the Microsoft Search brief's location field and lookup in the website's recipe composer, in English and
// Arabic. Before, the form labelled location_ids "TikTok location IDs" (CMP-03 and CMP-07 each added the key to one
// label map and the later one won), and the brief had no way to find a Microsoft location ID by name. Synthetic
// browser context; nothing reaches a server or provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {campaignRecipes} from '../dist/src/campaign-recipes.js';
import {recipeComposerFixture} from './fixtures/recipe-composer-ui.mjs';

const business = JSON.parse(
    readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'),
  ).recipe_business,
  definition = () => JSON.parse(JSON.stringify(campaignRecipes.find(r => r.id === 'microsoft_search'))),
  available = {location_lookup: {available: true}};
const location = (id, name, type, status, extra = {}) => ({
  location_id: id,
  display_name: name,
  location_type: type,
  status,
  selectable: status === 'Active',
  ...(status === 'Pending Deprecation' ? {reason: 'pending_deprecation'} : {}),
  ...(status === 'Deprecated' ? {reason: 'deprecated'} : {}),
  ...extra,
});
const search = (results, extra = {}) => ({
  kind: 'microsoft_location',
  mode: 'search',
  query: 'cairo',
  match_count: results.length,
  results,
  provider_mutations: 0,
  provider_requests: 1,
  ...extra,
});
const cairo = [
  location('151261', 'Cairo, Cairo, Egypt', 'City', 'Active'),
  location('151263', 'Cairo, Illinois, United States', 'City', 'Pending Deprecation'),
  location('151264', 'New Cairo <b>, Cairo, Egypt', 'City', 'Active'),
];
/** The composer with the lookup answering `answer`; the result list's Add buttons are collected to be clicked. */
async function composer(locale, answer, context = available) {
  const f = recipeComposerFixture(locale, definition(), business, {}, {context, reply: answer});
  await f.mount();
  const results = f.node('#recipe-ms-location-results');
  results.buttons = [];
  results.querySelectorAll = () => {
    results.buttons = [...results.innerHTML.matchAll(/data-ms-location="([^"]+)"/g)].map(m => ({
      dataset: {msLocation: m[1]},
      handlers: new Map(),
      addEventListener(event, fn) {
        this.handlers.set(event, fn);
      },
    }));
    return results.buttons;
  };
  return {
    ...f,
    results,
    search: async query => {
      f.node('#recipe-ms-location-query').value = query;
      await f.node('#recipe-ms-location-search').events.get('click')();
    },
    check: () => f.node('#recipe-ms-location-check').events.get('click')(),
    lookups: () => f.calls.filter(c => c.action === 'recipe_lookup'),
  };
}

for (const locale of ['en', 'ar']) {
  test('the Microsoft Search brief labels its location IDs as Microsoft’s in ' + locale, async () => {
    const f = await composer(locale, () => assert.fail('nothing is looked up'));
    const fields = f.node('#recipe-fields').innerHTML;
    // Regression: the label map named TikTok here.
    assert.match(
      fields,
      locale === 'ar' ? /معرّفات مواقع Microsoft — معرّف واحد في كل سطر/ : /Microsoft location IDs — one per line/,
    );
    assert.doesNotMatch(fields, /TikTok location IDs|معرّفات مواقع تيك توك/);
    assert.match(fields, /<textarea name="location_ids" required/);
    // A field shared by every workflow that takes it (a playbook's shared default) names no platform.
    assert.equal(f.run("recipeFieldLabel('location_ids')"), 'Location IDs of the workflow’s platform — one per line');
    assert.equal(
      f.run("recipeFieldLabel('location_ids', 'tiktok_website_traffic')"),
      'TikTok location IDs — one per line',
    );
    assert.equal(
      f.run("recipeFieldLabel('location_ids', 'other')"),
      'Location IDs of the workflow’s platform — one per line',
    );
  });

  test(
    'a search in ' + locale + ' shows literal locations, offers Add only for Active ones and explains the rest',
    async () => {
      const f = await composer(locale, () => search(cairo, {match_count: 7}));
      assert.match(f.node('#recipe-fields').innerHTML, /id="recipe-ms-locations"/);
      await f.search(' Cairo ');
      assert.deepEqual(f.lookups(), [
        {
          action: 'recipe_lookup',
          lookup_kind: 'microsoft_location',
          connection_id: 'synthetic-login',
          account_id: '123',
          query: 'Cairo',
        },
      ]);
      const html = f.results.innerHTML;
      // Native names, types and statuses stay literal (and escaped); AMCP's explanations are translated.
      assert.match(
        html,
        /<bdi dir="auto">Cairo, Cairo, Egypt<\/bdi> · <code dir="ltr">151261<\/code> · <bdi dir="auto">City<\/bdi> · <bdi dir="auto">Active<\/bdi>/,
      );
      assert.match(html, /New Cairo &lt;b&gt;, Cairo, Egypt/);
      assert.doesNotMatch(html, /<b>/);
      assert.deepEqual(
        f.results.buttons.map(b => b.dataset.msLocation),
        ['151261', '151264'],
      );
      assert.match(
        html,
        locale === 'ar'
          ? /تَسِم Microsoft هذا الموقع بأنه قيد الإهمال/
          : /Microsoft marks this location as pending deprecation, and its pages disagree/,
      );
      assert.match(html, locale === 'ar' ? /معروض ٣ من ٧\.|معروض 3 من 7\./ : /3 of 7 shown\./);
      assert.match(
        html,
        locale === 'ar'
          ? /aria-label="أضف Cairo, Cairo, Egypt \(151261\)"/
          : /aria-label="Add Cairo, Cairo, Egypt \(151261\)"/,
      );
      assert.equal(f.node('#recipe-error').textContent, '');
      // Add puts the ID in the brief once and keeps the other results for the next one.
      f.form.values.location_ids = '190';
      f.results.buttons[0].handlers.get('click')();
      f.results.buttons[0].handlers.get('click')();
      f.results.buttons[1].handlers.get('click')();
      assert.equal(f.form.values.location_ids, '190\n151261\n151264');
      assert.match(f.results.innerHTML, /151264/);
    },
  );
}

test('without the pinned request the brief offers no search, and its location note still says where IDs come from', async () => {
  for (const context of [{location_lookup: {available: false, code: 'MICROSOFT_LOCATIONS_UNPINNED'}}, {}]) {
    const f = await composer('en', () => assert.fail('nothing is looked up'), context);
    const fields = f.node('#recipe-fields').innerHTML;
    assert.doesNotMatch(fields, /recipe-ms-locations|Find Microsoft location IDs/);
    assert.match(fields, /id="recipe-location-note"/);
    assert.equal(f.node('#recipe-ms-location-search').events.size, 0, 'no lookup is bound');
  }
});

test('a check of the entered IDs lists each one found or missing, with no Add, and refuses non-numeric IDs unsent', async () => {
  const f = await composer('en', args => ({
    kind: 'microsoft_location',
    mode: 'resolve',
    location_ids: args.query.split(','),
    results: [
      location('190', 'United States', 'Country', 'Active'),
      location('151263', 'Cairo, Illinois, United States', 'City', 'Pending Deprecation'),
    ],
    missing_ids: ['999999'],
    provider_mutations: 0,
  }));
  f.form.values.location_ids = '190\n151263, 999999\n190\n';
  await f.check();
  assert.equal(f.lookups().at(-1).query, '190,151263,999999', 'the entered IDs, each once');
  const html = f.results.innerHTML;
  assert.match(html, /2 of 3 location IDs are in Microsoft’s file\./);
  assert.match(html, /Not in Microsoft’s geographical locations file: <code dir="ltr">999999<\/code>/);
  assert.match(html, /Microsoft marks this location as pending deprecation/);
  assert.deepEqual(f.results.buttons, [], 'a check adds nothing');
  f.form.values.location_ids = '190\nUS';
  await f.check();
  assert.equal(f.lookups().length, 1, 'nothing was sent');
  assert.equal(f.node('#recipe-error').textContent, 'Microsoft location IDs are numbers, one per line.');
  f.form.values.location_ids = '';
  await f.check();
  assert.equal(f.node('#recipe-error').textContent, 'Enter the location IDs to check first.');
  assert.equal(f.lookups().length, 1);
});

test('an incomplete, changing or foreign answer is refused and never shown', async () => {
  for (const [name, answer] of [
    ['a resolve answer to a search', () => ({...search(cairo), mode: 'resolve', missing_ids: []})],
    ['a change was made', () => search(cairo, {provider_mutations: 1})],
    ['more than 20 results', () => search(Array(21).fill(cairo[0]), {match_count: 21})],
    ['a count below the results', () => search(cairo, {match_count: 2})],
    ['an inexact ID', () => search([{...cairo[0], location_id: '0151261'}])],
    ['an unknown reason', () => search([{...cairo[0], selectable: false, reason: 'invented'}])],
  ]) {
    const f = await composer('en', answer);
    await f.search('Cairo');
    assert.equal(f.results.innerHTML, '', name);
    assert.equal(f.node('#recipe-error').textContent, 'The location lookup answer is incomplete. Search again.', name);
  }
  // A check must answer for exactly the IDs entered.
  const f = await composer('en', () => ({
    kind: 'microsoft_location',
    mode: 'resolve',
    results: [location('190', 'United States', 'Country', 'Active')],
    missing_ids: [],
    provider_mutations: 0,
  }));
  f.form.values.location_ids = '190\n68';
  await f.check();
  assert.equal(f.results.innerHTML, '');
  assert.equal(f.node('#recipe-error').textContent, 'The location lookup answer is incomplete. Search again.');
});

test('an answer for another account or an edited query is discarded, and Add follows the account it was read for', async () => {
  let release;
  const f = await composer('en', () => new Promise(resolve => (release = () => resolve(search(cairo)))));
  const pending = f.search('Cairo');
  f.form.values.target = JSON.stringify({connection_id: 'another-login', account_id: '999'});
  release();
  await pending;
  assert.equal(f.results.innerHTML, '', 'another account was selected');
  f.form.values.target = JSON.stringify({connection_id: 'synthetic-login', account_id: '123'});
  const edited = f.search('Cairo');
  f.node('#recipe-ms-location-query').value = 'Giza';
  release();
  await edited;
  assert.equal(f.results.innerHTML, '', 'the query was edited');
  const answered = f.search('Cairo');
  release();
  await answered;
  assert.match(f.results.innerHTML, /151261/);
  f.form.values.location_ids = '';
  f.form.values.target = JSON.stringify({connection_id: 'another-login', account_id: '999'});
  f.results.buttons[0].handlers.get('click')();
  assert.equal(f.form.values.location_ids, '', 'a result read for another account is not added');
});

test('Enter in the location name searches instead of submitting the brief', async () => {
  const f = await composer('en', () => search(cairo));
  f.node('#recipe-ms-location-query').value = 'Cairo';
  let prevented = false;
  f.node('#recipe-ms-location-query').events.get('keydown')({key: 'Enter', preventDefault: () => (prevented = true)});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.equal(f.lookups().length, 1);
  f.node('#recipe-ms-location-query').events.get('keydown')({key: 'a', preventDefault: () => assert.fail('typing')});
  assert.equal(f.lookups().length, 1);
  assert.ok(!f.calls.some(c => c.action === 'create_from_recipe'));
});
