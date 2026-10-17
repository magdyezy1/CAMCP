import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebsite} from '../dist/server/website.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {wooInventoryBrowserFixture, wooInventoryInput} from './fixtures/woocommerce-inventory-data.mjs';
import {offerParkedProviders} from './helpers/parked-providers.mjs';

// WooCommerce is parked (ARC-01, P9): this suite exercises it, so it offers it like a
// deployment whose AMCP_PROVIDERS names it.
offerParkedProviders('woocommerce');

async function fixture(t) {
  const f = wooInventoryBrowserFixture(),
    origin = 'https://synthetic.amcp.invalid',
    options = {
      origin,
      masterKey: Buffer.alloc(32, 41).toString('base64'),
      tenantId: f.actor.tenantId,
      authEnv: {},
      fetcher: async () => {
        throw Error('Unexpected website egress');
      },
    },
    {web, accounts} = createWebsite(f.store, options, false, f.service),
    user = accounts.newUser('Synthetic inventory viewer', null, null, true);
  f.store.db
    .prepare("INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,'viewer',?)")
    .run(f.actor.tenantId, user.id, Date.now());
  const session = accounts.session(user, f.actor.tenantId),
    listener = await listenForFetch(createHttpApp(f.service, f.store, {website: options}));
  t.after(async () => {
    await new Promise((resolve, reject) => listener.close(error => (error ? reject(error) : resolve())));
    f.close();
  });
  const request = async (input = wooInventoryInput(), csrf = session.csrf) => {
    const response = await fetch('http://127.0.0.1:' + listener.address().port + '/api/workspace/workspace', {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        Cookie: web.cookieName + '=' + session.id,
        'X-AMCP-CSRF': csrf,
      },
      body: JSON.stringify(input),
    });
    return {response, body: await response.json()};
  };
  return {...f, web, session, request};
}
test('website viewer inventory keeps CSRF and no-store boundaries and makes only fixed native GET reads', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(wooInventoryInput(), 'invalid')).response.status, 403);
  assert.equal(f.calls.length, 0);
  const out = await f.request();
  assert.equal(out.response.status, 200);
  assert.equal(out.response.headers.get('cache-control'), 'no-store');
  assert.equal(out.body.success, true, JSON.stringify(out.body));
  assert.equal(out.body.data.item_count, 124);
  assert.equal(out.body.data.native_requests, 9);
  assert.equal(out.body.data.provider_mutations, 0);
  assert.equal(out.body.data.saved_drafts, 0);
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
  assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
  assert.doesNotMatch(JSON.stringify(out.body), /UNUSED-PRIVATE|consumerSecret|synthetickey|syntheticsecret/);
  assert.equal(
    (
      await f.request(
        wooInventoryInput({
          requirements: {source_kind: 'inventory', price_field: 'price', absent_source_policy: 'delete'},
        }),
      )
    ).body.success,
    false,
  );
  assert.equal(f.calls.length, 9);
});
test('withdrawn website session stops inventory at the current response and releases its body without exposing collected rows', async t => {
  const f = await fixture(t);
  let cancelled = 0;
  f.inventoryRespond((url, _options, n, native) => {
    if (n !== 6) return native(url);
    f.web.signOut(f.session.id);
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
      {headers: {'content-type': 'application/json'}},
    );
  });
  const out = await f.request();
  assert.equal(out.response.status, 401);
  assert.equal(out.body.data, undefined);
  assert.equal(f.calls.length, 6);
  assert.equal(cancelled, 1);
  assert.doesNotMatch(JSON.stringify(out.body), /UNUSED-PRIVATE|native_currency|items|scans/);
});
