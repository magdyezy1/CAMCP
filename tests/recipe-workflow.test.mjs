import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
const base = JSON.parse(
    fs.readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'),
  ).recipe_business,
  actor = {tenantId: 'recipe-test', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 91).toString('base64');
function fixture(currency = 'USD') {
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
        return Response.json({results: [{geoTargetConstant: {id: '2840', name: 'United States', countryCode: 'US'}}]});
      if (q.includes('language_constant'))
        return Response.json({results: [{languageConstant: {id: '1000', name: 'English', code: 'en'}}]});
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
    assert.equal(run.steps[0].expected_currency, 'USD');
    assert.equal(f.requests.length, 0);
    const reread = await f.call({action: 'get', id: run.id});
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
