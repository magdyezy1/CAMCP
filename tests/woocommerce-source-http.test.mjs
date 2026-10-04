import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebsite} from '../dist/server/website.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {wooSourceFixture, wooSourceInput} from './fixtures/woocommerce-source-data.mjs';

async function fixture(t) {
  const f = wooSourceFixture(),
    origin = 'https://synthetic.amcp.invalid',
    options = {
      origin,
      masterKey: Buffer.alloc(32, 146).toString('base64'),
      tenantId: f.actor.tenantId,
      authEnv: {},
      fetcher: async () => {
        throw Error('Unexpected website egress');
      },
    };
  const {web, accounts} = createWebsite(f.store, options, false, f.service),
    user = accounts.newUser('Synthetic viewer', null, null, true);
  f.store.db
    .prepare("INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,'viewer',?)")
    .run(f.actor.tenantId, user.id, Date.now());
  const session = accounts.session(user, f.actor.tenantId),
    listener = await listenForFetch(createHttpApp(f.service, f.store, {website: options}));
  t.after(async () => {
    await new Promise((resolve, reject) => listener.close(error => (error ? reject(error) : resolve())));
    f.close();
  });
  const request = async (input = wooSourceInput(), csrf = session.csrf) => {
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
  return {...f, web, session, listener, request};
}
test('website viewer reads selected WooCommerce products with CSRF/no-store gates and local metadata without credentials', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(wooSourceInput(), 'invalid')).response.status, 403);
  assert.equal(f.calls.length, 0);
  const response = await fetch('http://127.0.0.1:' + f.listener.address().port + '/api/platforms', {
      headers: {Cookie: f.web.cookieName + '=' + f.session.id},
    }),
    metadata = await response.json();
  assert.equal(response.status, 200, JSON.stringify({error: metadata.error}));
  assert.equal(metadata.commerce_sources?.[0]?.account_id, 'store-1', JSON.stringify(metadata.commerce_sources));
  assert.equal(f.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(metadata.commerce_sources), /consumer|synthetickey|syntheticsecret/);
  const out = await f.request();
  assert.equal(out.response.status, 200);
  assert.equal(out.response.headers.get('cache-control'), 'no-store');
  assert.equal(out.body.success, true, JSON.stringify(out.body));
  assert.equal(out.body.data.items[0].sku, 'SKU-001');
  assert.equal(out.body.data.provider_mutations, 0);
  assert.equal(f.calls.length, 4);
  assert.doesNotMatch(JSON.stringify(out.body), /UNUSED-PRIVATE-WOO|consumerSecret/);
});
test('website session withdrawal during source collection withholds original store products and stops subsequent reads', async t => {
  const f = await fixture(t);
  f.respond((url, _options, n) => {
    if (n === 2) f.web.signOut(f.session.id);
    return new Response(
      JSON.stringify(
        url.pathname.includes('/settings/')
          ? {id: 'woocommerce_currency', value: 'SAR'}
          : [{id: 101, name: 'PRIVATE-NATIVE-WOO'}],
      ),
      {headers: {'content-type': 'application/json', 'x-wp-total': '1', 'x-wp-totalpages': '1'}},
    );
  });
  const out = await f.request();
  assert.equal(out.response.status, 401);
  assert.equal(out.body.data, undefined);
  assert.equal(f.calls.length, 2);
  assert.doesNotMatch(JSON.stringify(out.body), /PRIVATE-NATIVE-WOO|items|native_currency/);
});
