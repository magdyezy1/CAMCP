import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {assertRefused} from './helpers/assert-refused.mjs';
const base = JSON.parse(
    fs.readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'),
  ).recipe_business,
  actor = {tenantId: 'recipe-test', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 91).toString('base64');
// `lookup` answers the targeting-constant reads in place of the default rows: {geo, language}, each a function returning a Response.
function fixture(currency = 'USD', lookup = {}) {
  const store = new Store(':memory:', key),
    requests = [];
  for (const id of ['synthetic-login', 'other-login'])
    store.putConnection(
      admin,
      {
        id,
        tenantId: actor.tenantId,
        gateway: 'google_ads_native_action',
        accounts: ['123'],
        writeAccounts: ['123'],
        enabled: true,
        label: id,
        scopes: [],
      },
      {accessToken: 'synthetic', developerToken: 'synthetic'},
    );
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      requests.push({url: String(url), body: JSON.parse(init.body)});
      const q = JSON.parse(init.body).query;
      if (q.includes('geo_target_constant'))
        return (
          lookup.geo?.() ??
          Response.json({results: [{geoTargetConstant: {id: '2840', name: 'United States', countryCode: 'US'}}]})
        );
      if (q.includes('language_constant'))
        return (
          lookup.language?.() ??
          Response.json({results: [{languageConstant: {id: '1000', name: 'English', code: 'en'}}]})
        );
      return Response.json({results: [{customer: {id: '123', currencyCode: currency, timeZone: 'UTC'}}]});
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const call = input => service.call('amcp_campaign', input, actor);
  return {store, service, requests, call};
}
test('recipe context resolves exact login, profile defaults and missing questions; saved plans retain provenance', async () => {
  const f = fixture();
  try {
    f.store.putDocument(actor.tenantId, 'client_profile', 'profile', {
      name: 'Client',
      approved_by: 'admin',
      defaults: {recipes: {google_search: {currency: 'USD', keywords: ['approved keyword']}}},
    });
    const context = await f.call({action: 'recipe_context', recipe: 'google_search', profile_id: 'profile'});
    assert.equal(context.data.targets.length, 2);
    assert.notEqual(context.data.targets[0].label, context.data.targets[1].label);
    assert.equal(f.requests.length, 0);
    const missing = await f.call({
      action: 'preview_recipe',
      recipe: 'google_search',
      profile_id: 'profile',
      business: {name: 'New campaign'},
    });
    assert.equal(missing.data.ready, false);
    assert.ok(missing.data.missing_fields.includes('daily_budget'));
    assert.ok(!missing.data.missing_fields.includes('currency'));
    assert.equal(f.store.documents(actor.tenantId, 'campaign_run').length, 0);
    const {currency, keywords, ...business} = base,
      created = await f.call({action: 'create_from_recipe', recipe: 'google_search', profile_id: 'profile', business});
    assert.equal(created.success, true, JSON.stringify(created));
    const run = created.data;
    assert.equal(run.recipe.provenance.fields.currency.source, 'approved_profile');
    assert.equal(run.recipe.provenance.fields.daily_budget.source, 'user');
    const reread = await f.call({action: 'get', id: run.id, detail: 'full'});
    assert.equal(reread.data.steps[0].expected_currency, 'USD');
    assert.equal(f.requests.length, 0);
    assert.deepEqual(reread.data.recipe, run.recipe);
    const privateProfile = await f.service.call(
      'amcp_campaign',
      {action: 'recipe_context', recipe: 'google_search', profile_id: 'profile'},
      {...actor, tenantId: 'other'},
    );
    assert.equal(privateProfile.success, false);
  } finally {
    f.store.close();
  }
});
test('recipe preflight rejects wrong currency before any provider mutation', async () => {
  const f = fixture('JPY');
  try {
    const created = await f.call({action: 'create_from_recipe', recipe: 'google_search', business: base});
    assert.equal(created.success, true, JSON.stringify(created));
    const checked = await f.call({action: 'preflight', id: created.data.id});
    assert.equal(checked.data.blocked, true);
    assert.ok(checked.data.missing_requirements.some(r => r.error.code === 'RECIPE_CURRENCY_MISMATCH'));
    assert.ok(f.requests.every(r => r.url.endsWith('/googleAds:search')));
  } finally {
    f.store.close();
  }
});
test('targeting lookup uses the selected login/account and rejects query injection', async () => {
  const f = fixture();
  try {
    for (const [kind, query, id] of [
      ['country', 'US', '2840'],
      ['language', 'English', '1000'],
    ]) {
      const out = await f.call({
        action: 'recipe_lookup',
        lookup_kind: kind,
        query,
        account_id: '123',
        connection_id: 'other-login',
      });
      assert.equal(out.success, true, JSON.stringify(out));
      assert.equal(out.data.results[0].id, id);
    }
    const count = f.requests.length;
    const bad = await f.call({
      action: 'recipe_lookup',
      lookup_kind: 'country',
      query: "US' OR 1=1",
      account_id: '123',
      connection_id: 'other-login',
    });
    assert.equal(bad.success, false);
    assert.equal(f.requests.length, count);
    const revoked = f.store.listConnections(actor.tenantId).find(c => c.id === 'other-login');
    f.store.putConnection(admin, {...revoked, enabled: false}, f.store.credentials(actor.tenantId, revoked.id));
    assert.equal(
      (
        await f.call({
          action: 'recipe_lookup',
          lookup_kind: 'country',
          query: 'US',
          account_id: '123',
          connection_id: 'other-login',
        })
      ).success,
      false,
    );
  } finally {
    f.store.close();
  }
});

// Package r25-field2-google, G4 (the field report of 2026-11-21): Google's REST API omits `results` when a search has no rows, and a
// lookup that matches nothing is an empty answer, not an invalid one. Only a body that is not an object, or a `results` that is not a
// list, is still refused.
test('a targeting lookup with no match returns an empty list, whether Google omits results or sends an empty one', async () => {
  const zero = {fieldMask: 'geoTargetConstant.id,geoTargetConstant.name', queryResourceConsumption: '3'};
  for (const [kind, query, answer] of [
    ['country', 'Atlantis', {geo: () => Response.json(zero)}],
    ['country', 'ZZ', {geo: () => Response.json(zero)}],
    ['country', 'Atlantis', {geo: () => Response.json({...zero, results: []})}],
    [
      'language',
      'Klingon',
      {language: () => Response.json({fieldMask: 'languageConstant.id', queryResourceConsumption: '1'})},
    ],
    ['language', 'Klingon', {language: () => Response.json({results: []})}],
  ]) {
    const f = fixture('USD', answer);
    try {
      const out = await f.call({
        action: 'recipe_lookup',
        lookup_kind: kind,
        query,
        account_id: '123',
        connection_id: 'other-login',
      });
      assert.equal(out.success, true, kind + ' ' + query + ' ' + JSON.stringify(out.error));
      assert.equal(out.data.kind, kind);
      assert.deepEqual(out.data.results, []);
      assert.equal(out.data.provider_mutations, 0);
    } finally {
      f.store.close();
    }
  }
});
test('a targeting lookup whose answer is malformed is still refused as an invalid upstream response', async () => {
  // The body of text or null is refused by the transport before the lookup sees it, in its own words; the others by the lookup.
  const lookupRefusal = /Google did not return targeting constants/,
    transportRefusal = /JSON response must contain an object or array/;
  for (const [name, answer, message] of [
    ['results is an object', () => Response.json({results: {}}), lookupRefusal],
    ['results is a string', () => Response.json({results: 'none'}), lookupRefusal],
    ['results is null', () => Response.json({results: null}), lookupRefusal],
    ['the body is a list', () => Response.json([]), lookupRefusal],
    ['the body is text', () => Response.json('no rows'), transportRefusal],
    ['the body is null', () => Response.json(null), transportRefusal],
  ]) {
    const f = fixture('USD', {geo: answer});
    try {
      const out = await f.call({
        action: 'recipe_lookup',
        lookup_kind: 'country',
        query: 'Atlantis',
        account_id: '123',
        connection_id: 'other-login',
      });
      assertRefused(out, 'UPSTREAM_RESPONSE_INVALID', {message});
    } catch (e) {
      e.message = name + ': ' + e.message;
      throw e;
    } finally {
      f.store.close();
    }
  }
});

// CMP-02 (b) regression: create_from_recipe dropped idempotency_key, so a retried or double-submitted recipe created a
// second draft plan (each one counting toward the 500-plan cap, and a second paused campaign if both ran).
test('a keyed create_from_recipe returns its original plan; the key with other input conflicts', async () => {
  const f = fixture();
  try {
    const create = (extra = {}) =>
      f.call({
        action: 'create_from_recipe',
        recipe: 'google_search',
        business: base,
        idempotency_key: 'recipe-draft-0001',
        ...extra,
      });
    const first = await create();
    assert.equal(first.success, true, JSON.stringify(first));
    const saved = await f.call({action: 'get', id: first.data.id, detail: 'full'});
    const again = await create();
    assert.equal(again.success, true, JSON.stringify(again));
    assert.equal(again.data.id, first.data.id);
    assert.deepEqual(again.data.recipe, first.data.recipe);
    assert.equal(f.store.documents(actor.tenantId, 'campaign_run').length, 1);
    // The replay saved nothing: the plan keeps its revision and its one provenance record.
    assert.equal((await f.call({action: 'get', id: first.data.id, detail: 'full'})).data.revision, saved.data.revision);
    const changed = await create({business: {...base, daily_budget: '30.00'}});
    assert.equal(changed.error.code, 'IDEMPOTENCY_CONFLICT', JSON.stringify(changed));
    // An explicit create of the same compiled plan under that key is a different request.
    const explicit = await f.call({
      action: 'create',
      name: saved.data.name,
      brief: saved.data.brief,
      steps: saved.data.steps.map(({status: _status, ...s}) => s),
      idempotency_key: 'recipe-draft-0001',
    });
    assert.equal(explicit.error.code, 'IDEMPOTENCY_CONFLICT', JSON.stringify(explicit));
    assert.equal((await create({idempotency_key: 'short'})).error.code, 'INVALID_ARGUMENT');
    assert.equal(f.store.documents(actor.tenantId, 'campaign_run').length, 1);
    // Without a key every call is a new draft, as before.
    await f.call({action: 'create_from_recipe', recipe: 'google_search', business: base});
    await f.call({action: 'create_from_recipe', recipe: 'google_search', business: base});
    assert.equal(f.store.documents(actor.tenantId, 'campaign_run').length, 3);
    // A double submit (both requests in flight at once) under one key saves one plan.
    const both = await Promise.all([
      create({idempotency_key: 'recipe-draft-0002'}),
      create({idempotency_key: 'recipe-draft-0002'}),
    ]);
    assert.ok(
      both.every(r => r.success),
      JSON.stringify(both.map(r => r.error)),
    );
    assert.equal(both[0].data.id, both[1].data.id);
    assert.equal(f.store.documents(actor.tenantId, 'campaign_run').length, 4);
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

// CMP-02 (d) regression: create expanded {{...}} over every step, so a recipe headline that preview accepted was
// refused at plan creation, or silently rewritten when an approved profile had a variable of that name.
test('recipe ad text keeps literal braces byte for byte, with or without a matching profile variable', async () => {
  const f = fixture();
  try {
    f.store.putDocument(actor.tenantId, 'client_profile', 'profile', {
      name: 'Client',
      approved_by: 'admin',
      variables: {SAVE10: 'TEN PERCENT', market: 'US'},
    });
    const headlines = ['Use code {{SAVE10}}', 'Find {{market}} pairs', 'Built for every day'],
      business = {...base, headlines};
    const preview = await f.call({action: 'preview_recipe', recipe: 'google_search', business});
    assert.equal(preview.data.ready, true, JSON.stringify(preview));
    for (const profile of [{}, {profile_id: 'profile'}]) {
      const created = await f.call({action: 'create_from_recipe', recipe: 'google_search', business, ...profile});
      assert.equal(created.success, true, JSON.stringify(created));
      const saved = (await f.call({action: 'get', id: created.data.id, detail: 'full'})).data,
        text = JSON.stringify(saved.steps);
      for (const headline of headlines) assert.ok(text.includes(JSON.stringify(headline)), headline);
      assert.doesNotMatch(text, /TEN PERCENT/);
      // The saved steps are exactly what the preview compiled.
      assert.deepEqual(
        saved.steps.map(s => s.arguments),
        preview.data.plan.steps.map(s => s.arguments),
      );
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});
