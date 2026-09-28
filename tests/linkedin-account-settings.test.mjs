import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * LinkedIn ad account name and notification settings ("Create and Manage Ad Accounts", li-lms-2026-09, checked 2026-09-28).
 */
const registry = new Registry(),
  gateway = 'linkedin_native_action',
  action = 'linkedin_rest_ad_accounts_ad_account_id_post';
const actor = {tenantId: 'linkedin-account-settings', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};
function fixture(o = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 110).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'li',
      tenantId: actor.tenantId,
      gateway,
      enabled: true,
      accounts: ['507', '508'],
      writeAccounts: ['507', '508'],
      scopes: o.scopes ?? ['rw_ads'],
      label: 'Synthetic LinkedIn',
    },
    {accessToken: 'synthetic'},
  );
  const accounts = new Map([
    [
      507,
      {
        name: 'Brand account',
        status: 'ACTIVE',
        type: 'BUSINESS',
        currency: 'USD',
        test: false,
        notifiedOnCampaignOptimization: false,
        notifiedOnCreativeApproval: true,
        notifiedOnCreativeRejection: true,
        notifiedOnEndOfCampaign: false,
        notifiedOnNewFeaturesEnabled: false,
        reference: 'urn:li:organization:5',
      },
    ],
    [508, {name: 'Closing account', status: 'PENDING_DELETION', type: 'BUSINESS', currency: 'USD', test: false}],
  ]);
  let writes = 0;
  const calls = [];
  const fetcher = async (raw, init) => {
    const url = new URL(String(raw)),
      method = init?.method ?? 'GET',
      headers = new Headers(init?.headers);
    calls.push(method + ' ' + url.pathname);
    assert.equal(headers.get('x-restli-protocol-version'), '2.0.0');
    const m = /^\/rest\/adAccounts\/(\d+)$/.exec(url.pathname);
    if (method === 'GET' && m)
      return accounts.has(+m[1])
        ? Response.json({id: +m[1], servingStatuses: ['RUNNABLE'], ...accounts.get(+m[1])})
        : Response.json({status: 404}, {status: 404});
    if (method === 'POST' && m) {
      writes++;
      assert.equal(headers.get('x-restli-method'), 'PARTIAL_UPDATE');
      const b = JSON.parse(String(init.body));
      if (o.mode === 'error')
        return Response.json({status: 403, message: 'Only account managers can update the account'}, {status: 403});
      if (o.mode !== 'ignore') Object.assign(accounts.get(+m[1]), b.patch.$set);
      return new Response(null, {status: 204});
    }
    throw Error('Unexpected ' + method + ' ' + url.pathname);
  };
  const service = new MirrorService(registry, store, new NativeTransport(fetcher), undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = (set, extra = {}, account = '507') =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action,
          account_id: account,
          restli_method: 'PARTIAL_UPDATE',
          payload: {patch: {$set: set}},
          ...extra,
        },
      },
      actor,
    );
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, accounts, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('the account is renamed and its notifications switched without spending confirmation; both verify; a replay sends nothing', async () => {
  const f = fixture();
  try {
    const p = ok(await f.prepare({name: 'Brand account (EMEA)'}));
    assert.equal(p.data.creative_impact.operation, 'update');
    assert.equal(p.data.creative_impact.may_affect_serving, false);
    ok(await f.execute(p));
    assert.equal(f.accounts.get(507).name, 'Brand account (EMEA)');
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    const n = ok(await f.prepare({notifiedOnCampaignOptimization: true, notifiedOnCreativeRejection: false}));
    ok(await f.execute(n));
    assert.equal(ok(await f.verify(n)).data.status, 'verified');
    assert.equal(f.writes(), 2);
  } finally {
    f.store.close();
  }
});

test('status, reference and immutable fields are refused before any request; closing accounts and unchanged values after reading', async () => {
  const cases = [
    ['a deletion status', {status: 'PENDING_DELETION'}],
    ['a cancellation', {status: 'CANCELED'}],
    ['another reference', {reference: 'urn:li:organization:6'}],
    ['a currency', {currency: 'EUR'}],
    ['a test flag', {test: true}],
    ['a padded name', {name: ' Brand'}],
    ['a 256-character name', {name: 'x'.repeat(256)}],
    ['a switch as text', {notifiedOnEndOfCampaign: 'yes'}],
    ['nothing', {}],
  ];
  for (const [label, set] of cases) {
    const f = fixture();
    try {
      const r = await f.prepare(set);
      assert.equal(r.error?.code, 'INVALID_LINKEDIN_ACCOUNT_SETTING', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const g = fixture();
  try {
    assert.equal(
      (await g.prepare({name: 'X'}, {restli_method: 'UPDATE'})).error?.code,
      'INVALID_LINKEDIN_ACCOUNT_SETTING',
      'a full update',
    );
    assert.equal(g.calls.length, 0);
    assert.match(
      (await g.prepare({name: 'Reopened'}, {}, '508')).error?.message ?? '',
      /PENDING_DELETION; its settings no longer change/,
    );
    assert.match((await g.prepare({name: 'Brand account'})).error?.message ?? '', /already has these values/);
    assert.equal(g.writes(), 0);
  } finally {
    g.store.close();
  }
  const h = fixture({scopes: ['r_ads']});
  try {
    assert.equal((await h.prepare({name: 'Read only'})).error?.code, 'INSUFFICIENT_SCOPE');
  } finally {
    h.store.close();
  }
});

test('an error reply is never resubmitted, an ignored update is not verified, and the ledger lists the row', async () => {
  const e = fixture({mode: 'error'});
  try {
    const p = ok(await e.prepare({name: 'Denied'}));
    assert.equal((await e.execute(p)).success, false);
    assert.equal((await e.execute(p)).success, false);
    assert.equal(e.writes(), 1);
  } finally {
    e.store.close();
  }
  const g = fixture({mode: 'ignore'});
  try {
    const p = ok(await g.prepare({name: 'Ignored'}));
    ok(await g.execute(p));
    assert.notEqual(ok(await g.verify(p)).data.status, 'verified');
  } finally {
    g.store.close();
  }
  const row = actionContracts(registry).find(r => r.gateway === gateway && r.action === action);
  assert.equal(row?.status, 'reviewed_write_family');
  assert.equal(row.family, 'linkedin_account_settings');
});
