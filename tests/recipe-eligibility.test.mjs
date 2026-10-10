import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

const base = JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8')).recipe_business;
const actor = {tenantId: 'recipe-eligibility', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
function fixture(options = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 92).toString('base64')),
    requests = [];
  const connection = {
    id: 'synthetic-login',
    tenantId: actor.tenantId,
    gateway: 'google_ads_native_action',
    accounts: ['123'],
    writeAccounts: ['123'],
    enabled: true,
    label: 'Synthetic',
    // A Google Ads login records the adwords scope its writes require (src/google-contracts.ts); the grant registry
    // now reports its absence as a blocker (CON-03), so the fixture records it like a real login.
    scopes: ['https://www.googleapis.com/auth/adwords'],
  };
  store.putConnection(owner, connection, {accessToken: 'synthetic', developerToken: 'synthetic'});
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      const q = JSON.parse(init.body).query;
      requests.push({url: String(url), query: q});
      options.duringRead?.(store, requests.length);
      return Response.json(
        options.response ?? {
          results: [{customer: {id: '123', currencyCode: options.currency ?? 'USD', timeZone: 'UTC'}}],
        },
      );
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  return {
    store,
    service,
    requests,
    connection,
    call: (input, who = actor) => service.call('amcp_campaign', input, who),
  };
}
const input = (business = base, live = false) => ({
  action: 'recipe_eligibility',
  recipe: 'google_search',
  business,
  live,
});
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};

test('recipe eligibility asks for missing business inputs without provider reads or saved plans', async () => {
  const f = fixture();
  try {
    const r = ok(await f.call(input({name: 'Synthetic'})));
    assert.equal(r.status, 'needs_user_input');
    assert.ok(r.missing_fields.includes('daily_budget'));
    assert.equal(r.provider_mutations, 0);
    assert.equal(f.requests.length, 0);
    assert.equal(f.store.documents(actor.tenantId, 'campaign_run').length, 0);
  } finally {
    f.store.close();
  }
});
test('local eligibility resolves contracts and selected account but preserves unobserved objective and entity evidence', async () => {
  const f = fixture();
  try {
    const response = await f.call(input());
    const r = ok(response);
    assert.equal(r.record_kind, 'recipe_eligibility');
    assert.equal(r.status, 'unknown');
    assert.equal(r.scope.account_id, '123');
    assert.equal(r.local_compilation, 'passed');
    assert.ok(r.dependencies.some(d => d.id === 'account_currency' && d.status === 'unknown'));
    assert.ok(r.dependencies.some(d => d.id === 'provider_objective_acceptance' && d.status === 'unknown'));
    assert.ok(r.contracts.every(c => c.local_supported));
    assert.equal(f.requests.length, 0);
    assert.equal(f.store.documents(actor.tenantId, 'campaign_run').length, 0);
    assert.equal(r.next_call.arguments.action, 'recipe_eligibility');
    assert.equal(r.next_call.arguments.live, true);
    assert.equal(response.meta.workflow.website_path, '/campaigns#campaign-create');
    const clicks = ok(
      await f.call({
        ...input({...base, cpc_bid: undefined, cpc_bid_ceiling: '1.250001'}),
        recipe: 'google_search_clicks',
      }),
    );
    assert.equal(clicks.dependencies.find(d => d.id === 'campaign_cpc_ceiling').status, 'ready');
    assert.equal(
      clicks.dependencies.find(d => d.id === 'campaign_cpc_ceiling').evidence.kind,
      'compiled_explicit_setting',
    );
    assert.equal(clicks.dependencies.find(d => d.id === 'provider_objective_acceptance').status, 'unknown');
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});
test('live eligibility reuses native preflight, retains exact account lineage and unresolved predecessor requirements', async () => {
  const f = fixture();
  try {
    // CMP-04: per-resource steps (atomic: false) leave the steps that wait for a predecessor's ID deferred.
    const r = ok(await f.call(input({...base, atomic: false}, true)));
    assert.equal(r.status, 'unknown');
    assert.equal(r.preflight.status, 'ready');
    const currency = r.dependencies.find(d => d.id === 'account_currency');
    assert.equal(currency.status, 'ready');
    assert.equal(currency.evidence.currency, 'USD');
    assert.equal(currency.evidence.account_id, '123');
    assert.match(currency.evidence.source_reference.response_hash, /^[a-f0-9]{64}$/);
    assert.equal(r.accounts.length, 1);
    assert.ok(r.deferred.length > 0);
    assert.equal(f.requests.length, 1);
    assert.ok(f.requests.every(r => r.url.endsWith('/googleAds:search')));
    assert.equal(f.store.documents(actor.tenantId, 'campaign_run').length, 0);
    assert.equal(r.provider_mutations, 0);
  } finally {
    f.store.close();
  }
});
test('CMP-04: live eligibility of the default all-or-nothing build checks the whole build with nothing deferred', async () => {
  const f = fixture();
  try {
    const r = ok(await f.call(input(base, true)));
    assert.equal(r.preflight.status, 'ready', JSON.stringify(r.preflight));
    assert.deepEqual(r.deferred, []);
    assert.ok(f.requests.every(r => r.url.endsWith('/googleAds:search')));
    assert.equal(f.store.documents(actor.tenantId, 'campaign_run').length, 0);
    assert.equal(r.provider_mutations, 0);
  } finally {
    f.store.close();
  }
});
test('currency mismatches and paused or read-only authority are explained before any mutation', async () => {
  const f = fixture({currency: 'JPY'});
  try {
    const r = ok(await f.call(input(base, true)));
    assert.equal(r.status, 'blocked');
    assert.ok(r.blockers.some(x => x.code === 'RECIPE_CURRENCY_MISMATCH'));
    const prior = f.requests.length;
    const reader = ok(await f.call(input(base, true), {...actor, role: 'reader'}));
    assert.equal(reader.status, 'blocked');
    assert.equal(f.requests.length, prior);
    await f.service.call('amcp_workspace', {action: 'pause_writes', confirmed: true, reason: 'Synthetic'}, owner);
    const paused = ok(await f.call(input(base, true)));
    assert.equal(paused.status, 'blocked');
    assert.ok(paused.blockers.some(x => x.code === 'workspace_writes_paused'));
    assert.equal(f.requests.length, prior);
  } finally {
    f.store.close();
  }
});
for (const response of [
  {results: [{customer: {id: '999', currencyCode: 'USD', timeZone: 'UTC'}}]},
  {results: [{customer: {id: ['123'], currencyCode: 'USD', timeZone: 'UTC'}}]},
  {results: [{customer: {id: '123', currencyCode: 'USD', timeZone: 'UTC'}}], nextPageToken: 'unfinished'},
])
  test('existing campaign preflight refuses unqualified account evidence: ' + JSON.stringify(response), async () => {
    const f = fixture({response});
    try {
      const saved = ok(await f.call({action: 'create_from_recipe', recipe: 'google_search', business: base}));
      const r = ok(await f.call({action: 'preflight', id: saved.id}));
      assert.equal(r.blocked, true, JSON.stringify(r));
      assert.ok(f.requests.every(r => r.url.endsWith('/googleAds:search')));
    } finally {
      f.store.close();
    }
  });
test('eligibility discards provider evidence if connection credentials change during collection', async () => {
  const f = fixture({
    duringRead: store =>
      store.replaceCredentials(actor.tenantId, 'synthetic-login', {
        accessToken: 'changed',
        developerToken: 'synthetic',
      }),
  });
  try {
    const r = await f.call(input(base, true));
    assert.equal(r.success, false, JSON.stringify(r));
    assert.equal(f.store.documents(actor.tenantId, 'campaign_run').length, 0);
  } finally {
    f.store.close();
  }
});
test('eligibility binds approved defaults to the original profile revision', async () => {
  const f = fixture({
    duringRead: store =>
      store.putDocument(actor.tenantId, 'client_profile', 'client', {
        name: 'Client',
        defaults: {recipes: {google_search: {currency: 'JPY'}}},
      }),
  });
  try {
    f.store.putDocument(actor.tenantId, 'client_profile', 'client', {
      name: 'Client',
      defaults: {recipes: {google_search: {currency: 'USD'}}},
    });
    const {currency, ...business} = base;
    const r = await f.call({...input(business, true), profile_id: 'client'});
    assert.equal(r.success, false, JSON.stringify(r));
    assert.equal(f.store.documents(actor.tenantId, 'campaign_run').length, 0);
  } finally {
    f.store.close();
  }
});
