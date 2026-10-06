import test from 'node:test';
import assert from 'node:assert/strict';
import {sha256} from '../dist/src/security.js';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {wooConnectionInput} from './fixtures/woocommerce-connection-data.mjs';

const receipt = (input = wooConnectionInput(), extra = {}) => ({
  record_kind: 'woocommerce_connection',
  connection_id: input.connection_id,
  account_id: 'wc_' + sha256(new URL(input.store_origin).origin),
  account_id_kind: 'amcp_origin_binding',
  label: input.label,
  store_origin: new URL(input.store_origin).origin,
  key_permission: 'read',
  key_permission_evidence: 'operator_recorded',
  read_access_verified: true,
  verified_at: '2026-10-06T10:00:00.000Z',
  native_currency: 'SAR',
  reported_published_products: 0,
  full_inventory: false,
  writes_enabled: false,
  credentials_disclosed: false,
  provider_mutations: 0,
  network_requests: 3,
  collected_bytes: 101,
  replayed: false,
  ...extra,
});
function owner(locale = 'en', sources = []) {
  const f = accountWorkflowFixture(locale);
  f.run("session.workspaceRole='owner';");
  f.context.commerceSources = structuredClone(sources);
  f.run('renderCommerce()');
  const form = f.node('#woo-connect'),
    input = wooConnectionInput();
  for (const field of ['label', 'store_origin', 'consumer_key', 'consumer_secret'])
    form.elements[field].value = input[field];
  form.elements.confirmed.checked = true;
  return {...f, form, input, submit: () => f.bindings.get('#woo-connect')(form)};
}
for (const locale of ['en', 'ar'])
  test(
    'owner setup ' + locale + ' uses hidden credential controls, unchanged native values and safe receipt fields',
    async () => {
      const f = owner(locale);
      assert.match(f.node('content').innerHTML, /name="consumer_key" type="password"/);
      assert.match(f.node('content').innerHTML, /name="consumer_secret" type="password"/);
      assert.match(f.node('content').innerHTML, /autocomplete="off"/);
      if (locale === 'ar') assert.match(f.node('content').innerHTML, /[\u0600-\u06ff]/u);
      let release;
      const gate = new Promise(r => {
        release = r;
      });
      f.apiRespond(async call => {
        await gate;
        return receipt(call.body, {consumer_secret: 'DO-NOT-RENDER', private_note: 'DO-NOT-RENDER'});
      });
      const pending = f.submit();
      assert.equal(f.form.elements.consumer_key.value, '');
      assert.equal(f.form.elements.consumer_secret.value, '');
      assert.equal(f.form.elements.consumer_key.disabled, true);
      assert.equal(f.form.elements.confirmed.disabled, true);
      release();
      await pending;
      assert.deepEqual(f.httpCalls[0], {url: '/api/commerce/stores', method: 'POST', body: f.input});
      assert.equal(f.calls.length, 0);
      assert.equal(f.visits.length, 0);
      const markup = f.node('#woo-connect-result').innerHTML;
      assert.match(markup, /Synthetic &lt;store&gt;/);
      assert.match(markup, /SAR/);
      assert.match(markup, /dir="ltr"/);
      assert.doesNotMatch(markup, /DO-NOT-RENDER|setupSynthetic|consumer_secret|full_inventory/);
      assert.equal(f.node('#woo-connect-heading').focused, true);
      assert.equal(f.form.elements.consumer_key.disabled, false);
    },
  );
for (const patch of [
  {authenticated: false},
  {workspaceRole: 'viewer'},
  {workspaceRole: 'operator'},
  {workspaceRole: 'owner', testAccount: true},
])
  test('setup presentation and binding are withheld for ' + JSON.stringify(patch), () => {
    const f = accountWorkflowFixture();
    Object.assign(f.context.session, patch);
    f.run('renderCommerce()');
    assert.doesNotMatch(f.node('content').innerHTML, /id="woo-connections"/);
    assert.equal(f.bindings.has('#woo-connect'), false);
    assert.equal(f.httpCalls.length, 0);
  });
test('in-flight duplicate submit is suppressed and explicit retry retains the original connection ID without cached credentials', async () => {
  const f = owner();
  let release;
  f.apiRespond(
    () =>
      new Promise((resolve, reject) => {
        release = () =>
          reject(
            Object.assign(Error('Safe synthetic failure'), {
              code: 'WOOCOMMERCE_CONNECTION_UNAVAILABLE',
              request_id: 'safe-reference',
            }),
          );
      }),
  );
  const first = f.submit();
  await f.submit();
  assert.equal(f.httpCalls.length, 1);
  release();
  await assert.rejects(first, /Safe synthetic failure/);
  for (const field of ['consumer_key', 'consumer_secret']) f.form.elements[field].value = f.input[field];
  f.apiRespond(call => receipt(call.body, {replayed: true, network_requests: 0, collected_bytes: 0}));
  await f.submit();
  assert.equal(f.httpCalls.length, 2);
  assert.equal(f.httpCalls[1].body.connection_id, f.httpCalls[0].body.connection_id);
  assert.match(f.node('#woo-connect-result').innerHTML, /No new store reads/);
  await f.submit();
  assert.equal(f.httpCalls.length, 2);
});
for (const mode of ['navigation', 'identity', 'identity-in-place', 'role', 'form', 'input'])
  test('late setup success cannot publish into changed ' + mode + ' context', async () => {
    const f = owner();
    let release;
    f.apiRespond(
      call =>
        new Promise(r => {
          release = () => r(receipt(call.body));
        }),
    );
    const pending = f.submit();
    if (mode === 'navigation') f.context.navigationGeneration++;
    if (mode === 'identity') f.context.session = {...f.context.session, workspaceId: 'other'};
    if (mode === 'identity-in-place') f.context.session.workspaceId = 'other';
    if (mode === 'role') f.context.session.workspaceRole = 'viewer';
    if (mode === 'form') f.form.isConnected = false;
    if (mode === 'input') f.form.events.get('input')();
    release();
    await pending;
    assert.equal(f.node('#woo-connect-result').innerHTML, '');
    assert.equal(f.visits.length, 0);
    assert.equal(f.node('#woo-connect-heading').focused, undefined);
    assert.equal(f.form.elements.consumer_key.value, '');
    assert.equal(f.form.elements.consumer_secret.value, '');
  });
for (const patch of [
  {connection_id: 'other'},
  {store_origin: 'https://other.example.test'},
  {key_permission_evidence: 'native_verified'},
  {writes_enabled: true},
  {full_inventory: true},
  {provider_mutations: 1},
  {network_requests: 4},
  {collected_bytes: 262145},
  {reported_published_products: -1},
  {native_currency: 'bad'},
  {verified_at: 'not-a-date'},
])
  test('owner UI refuses misleading or mismatched setup evidence ' + Object.keys(patch).join(), async () => {
    const f = owner();
    f.apiRespond(call => receipt(call.body, patch));
    await assert.rejects(f.submit(), /setup result does not match/);
    assert.equal(f.node('#woo-connect-result').innerHTML, '');
  });
test('refresh requires explicit page-reset confirmation and current identity before using returned store metadata', async () => {
  const f = owner();
  f.apiRespond(call =>
    call.method === 'POST'
      ? receipt(call.body)
      : {
          commerce_sources: [
            {
              connection_id: f.input.connection_id,
              account_id: 'wc_' + sha256(f.input.store_origin),
              label: f.input.label,
              store_origin: f.input.store_origin,
            },
          ],
        },
  );
  await f.submit();
  f.confirmRespond(() => false);
  await f.bindings.get('#woo-connect-refresh')();
  assert.equal(f.httpCalls.length, 1);
  assert.equal(f.visits.length, 0);
  f.confirmRespond(() => true);
  await f.bindings.get('#woo-connect-refresh')();
  assert.equal(f.httpCalls.length, 2);
  assert.equal(f.httpCalls[1].url, '/api/platforms');
  assert.deepEqual(f.visits, ['/commerce']);
  assert.equal(f.context.commerceSources.length, 1);
});
test('late refresh confirmation cannot authorize a fetch after role or workspace change', async () => {
  const f = owner();
  f.apiRespond(call => receipt(call.body));
  await f.submit();
  let release;
  f.confirmRespond(
    () =>
      new Promise(r => {
        release = r;
      }),
  );
  const pending = f.bindings.get('#woo-connect-refresh')();
  f.context.session.workspaceId = 'other';
  release(true);
  await pending;
  assert.equal(f.httpCalls.length, 1);
  assert.equal(f.visits.length, 0);
});
for (const locale of ['en', 'ar'])
  test(
    'local connection removal ' +
      locale +
      ' keeps exact target and explicit consequences without changing the provider',
    async () => {
      const source = {
          connection_id: 'original-store',
          account_id: 'original-origin-binding',
          label: 'Native <store>',
          store_origin: 'https://shop.example.test',
        },
        f = owner(locale, [source]),
        remove = f.node('#woo-remove');
      remove.elements.confirmed.checked = true;
      f.apiRespond(call => ({
        success: true,
        disconnected: true,
        connection_id: source.connection_id,
        gateway: 'commerce_native_action',
        network_requests: 0,
        provider_changes: 0,
        private: 'DO-NOT-RENDER',
      }));
      await f.bindings.get('#woo-remove')(remove);
      assert.deepEqual(f.httpCalls, [
        {url: '/api/commerce/stores/original-store', method: 'DELETE', body: {confirmed: true}},
      ]);
      assert.equal(f.confirmations.length, 1);
      const markup = f.node('#woo-remove-result').innerHTML;
      assert.doesNotMatch(markup, /DO-NOT-RENDER/);
      assert.equal(f.visits.length, 0);
      if (locale === 'ar') assert.match(markup, /[\u0600-\u06ff]/u);
    },
  );
test('unconfirmed or changed removal selection cannot remove a local connection', async () => {
  const f = owner('en', [{connection_id: 'one', label: 'One', store_origin: 'https://shop.example.test'}]),
    form = f.node('#woo-remove');
  form.elements.confirmed.checked = false;
  await assert.rejects(f.bindings.get('#woo-remove')(form), /explicitly confirm/);
  assert.equal(f.httpCalls.length, 0);
  form.elements.confirmed.checked = true;
  let release;
  f.confirmRespond(
    () =>
      new Promise(r => {
        release = r;
      }),
  );
  const pending = f.bindings.get('#woo-remove')(form);
  form.events.get('change')();
  release(true);
  await pending;
  assert.equal(f.httpCalls.length, 0);
});
