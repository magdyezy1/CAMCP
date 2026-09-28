import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Creating custom conversions in a Meta ad account (Marketing API v25.0 "Ad Account Customconversions" reference,
 * checked 2026-09-27).
 */
const gateway = 'meta_native_action',
  registry = new Registry(),
  action = 'meta_ad_account_id_customconversions_create';
const actor = {tenantId: 'meta-custom-conversions', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
function fixture(mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 84).toString('base64')),
    calls = [];
  let writes = 0,
    next = 7001;
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
      scopes: ['ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  const pixels = [
    {id: '4001', name: 'Site pixel'},
    {id: '4002', name: 'Shop pixel'},
  ];
  const conversions = new Map([
    [
      '6001',
      {
        name: 'Thank you page',
        custom_event_type: 'PURCHASE',
        rule: '{"url":{"i_contains":"thank-you"}}',
        default_conversion_value: 0,
        pixel: {id: '4001'},
        is_archived: false,
      },
    ],
    [
      '6002',
      {
        name: 'Old lead',
        custom_event_type: 'LEAD',
        rule: '{"url":{"i_contains":"lead"}}',
        pixel: {id: '4001'},
        is_archived: true,
      },
    ],
  ]);
  // Two conversions per page exercises the cursors.
  const page = (rows, u) => {
    const start = Number(u.searchParams.get('after') ?? 0),
      slice = rows.slice(start, start + 2),
      more = start + 2 < rows.length;
    return Response.json({
      data: slice,
      paging: {
        cursors: {before: String(start), after: String(start + 2)},
        ...(more ? {next: 'https://graph.facebook.com/next'} : {}),
      },
    });
  };
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init.method;
      calls.push({path, method});
      if (method === 'GET' && path === '/v25.0/act_123/adspixels') return page(pixels, u);
      if (method === 'GET' && path === '/v25.0/act_123/customconversions')
        return page(
          [...conversions].map(([id, c]) => ({
            id,
            ...c,
            rule: typeof c.rule === 'string' ? c.rule.replace(/"/g, '"') : c.rule,
          })),
          u,
        );
      if (method === 'POST' && path === '/v25.0/act_123/customconversions') {
        writes++;
        const b = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
        const id = String(next++);
        // Meta stores the rule with its own key order and spacing.
        const stored = {
          name: b.name,
          custom_event_type: b.custom_event_type,
          rule: JSON.stringify(JSON.parse(b.rule)),
          default_conversion_value: b.default_conversion_value === undefined ? 0 : Number(b.default_conversion_value),
          description: b.description,
          pixel: {id: b.event_source_id},
          is_archived: false,
        };
        if (mode !== 'ignore') conversions.set(id, mode === 'other' ? {...stored, pixel: {id: '4002'}} : stored);
        return Response.json({id, is_custom_event_type_predicted: 0});
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
    service.call('amcp_write', {action: 'prepare', gateway, arguments: {action, account_id: '123', payload}}, actor);
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, conversions, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};
const conversion = (extra = {}) => ({
  name: 'Checkout complete',
  event_source_id: '4001',
  custom_event_type: 'PURCHASE',
  rule: '{"and":[{"event":{"eq":"Purchase"}},{"url":{"i_contains":"order-confirmed"}}]}',
  default_conversion_value: 25,
  description: 'Orders confirmed on the site',
  ...extra,
});

test('a custom conversion is created on a pixel of the account without spending confirmation and verifies; a replay sends nothing', async () => {
  const f = fixture();
  try {
    const p = ok(await f.prepare(conversion()));
    assert.equal(p.data.creative_impact.scope, 'custom_conversion');
    assert.equal(p.data.creative_impact.existing, 2);
    assert.deepEqual(p.data.creative_impact.creating.rule, {
      and: [{event: {eq: 'Purchase'}}, {url: {i_contains: 'order-confirmed'}}],
    });
    ok(await f.execute(p));
    assert.equal(f.writes(), 1);
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
    const q = ok(
      await f.prepare(
        conversion({
          name: 'Old lead',
          event_source_id: '4002',
          custom_event_type: undefined,
          default_conversion_value: undefined,
          description: undefined,
        }),
      ),
    );
    ok(await f.execute(q));
    assert.equal(ok(await f.verify(q)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('malformed conversions are refused before any request; unknown pixels and taken names after reading', async () => {
  const cases = [
    ['missing name', conversion({name: undefined})],
    ['long name', conversion({name: 'n'.repeat(101)})],
    ['no pixel', conversion({event_source_id: undefined})],
    ['no rule', conversion({rule: undefined})],
    ['rule not JSON', conversion({rule: 'url contains thank-you'})],
    ['rule array', conversion({rule: '[1,2]'})],
    ['unknown event type', conversion({custom_event_type: 'SIGNUP'})],
    ['negative value', conversion({default_conversion_value: -1})],
    ['advanced rule', conversion({advanced_rule: '{}'})],
    ['unknown source', conversion({action_source_type: 'fax'})],
  ];
  for (const [label, payload] of cases) {
    const f = fixture();
    try {
      const r = await f.prepare(payload);
      assert.equal(r.error?.code, 'INVALID_META_CUSTOM_CONVERSION', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    assert.equal((await f.prepare(conversion({event_source_id: '4999'}))).error?.code, 'STATE_NOT_FOUND');
    assert.equal((await f.prepare(conversion({name: 'thank YOU page'}))).error?.code, 'CONFIGURATION_EXISTS');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('a conversion stored on another pixel or never stored is not verified, and the ledger lists the write', async () => {
  const f = fixture('other');
  try {
    const p = ok(await f.prepare(conversion()));
    ok(await f.execute(p));
    assert.notEqual(ok(await f.verify(p)).data.status, 'verified');
  } finally {
    f.store.close();
  }
  const g = fixture('ignore');
  try {
    const p = ok(await g.prepare(conversion()));
    ok(await g.execute(p));
    assert.notEqual(ok(await g.verify(p)).data.status, 'verified');
  } finally {
    g.store.close();
  }
  const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'reviewed_write_family');
  assert.equal(rows[0].family, 'meta_custom_conversions');
});
