import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Meta ad account name, EU Digital Services Act defaults and notifications (Marketing API v25.0 "Ad Account",
 * checked 2026-09-27).
 */
const gateway = 'meta_native_action',
  registry = new Registry(),
  action = 'meta_ad_account_id_create';
const actor = {tenantId: 'meta-account-settings', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
function fixture(mode = '', scopes = ['ads_management']) {
  const store = new Store(':memory:', Buffer.alloc(32, 102).toString('base64')),
    calls = [];
  let writes = 0;
  store.putConnection(
    owner,
    {
      id: 'm',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Meta',
      scopes,
    },
    {accessToken: 'synthetic'},
  );
  const acct = {
    name: 'Brand EU',
    default_dsa_payor: 'Brand GmbH',
    default_dsa_beneficiary: 'Brand GmbH',
    is_notifications_enabled: true,
    account_status: 1,
    spend_cap: '500000',
    amount_spent: '120000',
  };
  const pick = (o, f) =>
    Object.fromEntries(
      f
        .split(',')
        .filter(k => o[k] !== undefined)
        .map(k => [k, o[k]]),
    );
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init.method;
      calls.push({path, method});
      if (method === 'GET' && path === '/v25.0/act_123')
        return Response.json({id: 'act_123', ...pick(acct, u.searchParams.get('fields') ?? 'name')});
      if (method === 'POST' && path === '/v25.0/act_123') {
        writes++;
        const body = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
        if (mode === 'error') return Response.json({error: {message: 'Invalid parameter', code: 100}}, {status: 400});
        if (mode !== 'ignore')
          for (const [k, v] of Object.entries(body)) acct[k] = k === 'is_notifications_enabled' ? v === 'true' : v;
        return Response.json({success: true});
      }
      throw new Error('Unexpected ' + method + ' ' + path);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    100,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = payload =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action, account_id: '123', params: {ad_account_id: 'act_123'}, payload}},
      actor,
    );
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, acct, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('the account is renamed, its EU payor and beneficiary set and then unset, and notifications turned off; each verifies and a replay sends nothing', async () => {
  const f = fixture();
  try {
    const r = ok(await f.prepare({name: 'Brand EU (2027)'}));
    assert.equal(r.data.creative_impact.before.name, 'Brand EU');
    assert.equal(r.data.creative_impact.may_affect_serving, false);
    ok(await f.execute(r));
    assert.equal(ok(await f.verify(r)).data.status, 'verified');
    assert.equal((await f.execute(r)).data.replayed, true);
    const d = ok(await f.prepare({default_dsa_payor: 'Brand Holding BV', default_dsa_beneficiary: 'Brand GmbH'}));
    ok(await f.execute(d));
    assert.equal(f.acct.default_dsa_payor, 'Brand Holding BV');
    assert.equal(ok(await f.verify(d)).data.status, 'verified');
    const u = ok(await f.prepare({default_dsa_payor: '', default_dsa_beneficiary: ''}));
    assert.match(u.data.creative_impact.effect, /Removes the default payor/);
    ok(await f.execute(u));
    assert.equal(ok(await f.verify(u)).data.status, 'verified');
    const n = ok(await f.prepare({is_notifications_enabled: false}));
    ok(await f.execute(n));
    assert.equal(f.acct.is_notifications_enabled, false);
    assert.equal(ok(await f.verify(n)).data.status, 'verified');
    assert.equal(f.writes(), 4);
  } finally {
    f.store.close();
  }
});

test('spending caps, permanent fields and malformed values are refused before any request; unchanged values after reading', async () => {
  const cases = [
    ['a spend cap', {spend_cap: 250}],
    ['a spend cap reset', {spend_cap_action: 'reset'}],
    ['an end advertiser', {end_advertiser: '1234'}],
    ['a media agency', {media_agency: '1234'}],
    ['a payor alone', {default_dsa_payor: 'Brand GmbH'}],
    ['one empty value', {default_dsa_payor: '', default_dsa_beneficiary: 'Brand GmbH'}],
    ['a 101-character name', {name: 'x'.repeat(101)}],
    ['notifications as text', {is_notifications_enabled: 'false'}],
    ['nothing', {}],
  ];
  for (const [label, payload] of cases) {
    const f = fixture();
    try {
      const r = await f.prepare(payload);
      assert.equal(r.error?.code, 'INVALID_META_ACCOUNT_SETTING', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    assert.equal(
      (await f.prepare({name: 'Brand EU', is_notifications_enabled: true})).error?.code,
      'INVALID_META_ACCOUNT_SETTING',
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
  const g = fixture('', ['ads_read']);
  try {
    assert.equal((await g.prepare({name: 'Renamed'})).error?.code, 'INSUFFICIENT_SCOPE');
  } finally {
    g.store.close();
  }
});

test('an error reply is never resubmitted, an ignored change is not verified, and the ledger lists the row', async () => {
  const e = fixture('error');
  try {
    const p = ok(await e.prepare({name: 'Renamed'}));
    assert.equal((await e.execute(p)).success, false);
    assert.equal((await e.execute(p)).success, false);
    assert.equal(e.writes(), 1);
  } finally {
    e.store.close();
  }
  const g = fixture('ignore');
  try {
    const p = ok(await g.prepare({name: 'Renamed'}));
    ok(await g.execute(p));
    assert.notEqual(ok(await g.verify(p)).data.status, 'verified');
  } finally {
    g.store.close();
  }
  const row = actionContracts(registry).find(r => r.gateway === gateway && r.action === action);
  assert.equal(row?.status, 'reviewed_write_family');
  assert.equal(row.family, 'meta_account_settings');
});
