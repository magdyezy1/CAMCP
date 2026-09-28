import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Business Profile location attributes (Business Information API v1, pinned Discovery document, checked 2026-09-28).
 */
const gateway = 'google_business_native_action',
  operation = 'gmb_location_ops',
  registry = new Registry();
const actor = {tenantId: 'business-location-attributes', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const metadata = [
  {parent: 'attributes/has_wifi_free', valueType: 'BOOL', displayName: 'Free Wi-Fi'},
  {
    parent: 'attributes/wi_fi',
    valueType: 'ENUM',
    displayName: 'Wi-Fi',
    valueMetadata: [
      {value: 'free_wi_fi', displayName: 'Free'},
      {value: 'paid_wi_fi', displayName: 'Paid'},
    ],
  },
  {parent: 'attributes/url_menu', valueType: 'URL', repeatable: false, displayName: 'Menu link'},
  {
    parent: 'attributes/pay_credit_card_types_accepted',
    valueType: 'REPEATED_ENUM',
    displayName: 'Credit cards',
    valueMetadata: [{value: 'visa'}, {value: 'mastercard'}, {value: 'american_express'}],
  },
  {parent: 'attributes/has_delivery', valueType: 'BOOL', deprecated: true, displayName: 'Delivery'},
];
function fixture(o = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 112).toString('base64')),
    calls = [];
  store.putConnection(
    owner,
    {
      id: 'b1a2c3d4-0000-4000-8000-000000000112',
      tenantId: actor.tenantId,
      gateway,
      label: 'Synthetic',
      enabled: true,
      accounts: ['locations/456', 'locations/458'],
      writeAccounts: ['locations/456', 'locations/458'],
      scopes: o.scopes ?? ['https://www.googleapis.com/auth/business.manage'],
    },
    {accessToken: 'synthetic'},
  );
  const locations = new Map([
    [
      'locations/456',
      {name: 'locations/456', openInfo: {status: 'OPEN'}, metadata: {hasVoiceOfMerchant: true, hasPendingEdits: false}},
    ],
    ['locations/458', {name: 'locations/458', openInfo: {status: 'OPEN'}, metadata: {hasVoiceOfMerchant: false}}],
  ]);
  const attributes = new Map([
    [
      'locations/456',
      new Map([
        ['attributes/has_wifi_free', {name: 'attributes/has_wifi_free', valueType: 'BOOL', values: [false]}],
        [
          'attributes/url_menu',
          {name: 'attributes/url_menu', valueType: 'URL', uriValues: [{uri: 'https://example.com/menu'}]},
        ],
      ]),
    ],
    ['locations/458', new Map()],
  ]);
  let writes = 0;
  const shown = l => ({name: l + '/attributes', attributes: [...attributes.get(l).values()]});
  const transport = new NativeTransport(async (url, init) => {
    const u = new URL(String(url)),
      path = u.pathname,
      method = init?.method ?? 'GET',
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({path, method, query: Object.fromEntries(u.searchParams)});
    assert.equal(u.origin, 'https://mybusinessbusinessinformation.googleapis.com');
    if (method === 'GET' && path === '/v1/attributes') {
      assert.equal(
        u.searchParams.get('parent'),
        'locations/456'.replace('456', u.searchParams.get('parent').split('/')[1]),
      );
      assert.equal(u.searchParams.get('pageSize'), '200');
      return Response.json({attributeMetadata: metadata});
    }
    let m = /^\/v1\/(locations\/\d+)\/attributes$/.exec(path);
    if (m && method === 'GET') return Response.json(shown(m[1]));
    if (m && method === 'PATCH') {
      writes++;
      if (o.mode === 'error')
        return Response.json({error: {code: 400, message: 'Invalid attribute value'}}, {status: 400});
      const sent = new Map((body.attributes ?? []).map(a => [a.name, a]));
      if (o.mode !== 'ignore')
        for (const name of u.searchParams.get('attributeMask').split(',')) {
          const a = sent.get(name);
          if (a) {
            const meta = metadata.find(x => x.parent === name);
            attributes.get(m[1]).set(name, {...a, valueType: meta.valueType});
          } else attributes.get(m[1]).delete(name);
        }
      return Response.json(shown(m[1]));
    }
    m = /^\/v1\/(locations\/\d+)$/.exec(path);
    if (m && method === 'GET') {
      assert.equal(u.searchParams.get('readMask'), 'name,openInfo,metadata');
      const l = locations.get(m[1]);
      return Response.json({...l, metadata: {...l.metadata, hasPendingEdits: calls.length % 2 === 0}});
    }
    throw Error('Unexpected ' + method + ' ' + path);
  });
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const prepare = (list, mask = list.map(a => a.name).join(','), location = '456', extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          operation,
          arguments: {
            action: 'UPDATE_LOCATION_ATTRIBUTES',
            location_id: location,
            payload: {name: 'locations/' + location + '/attributes', attributes: list},
            query: {attributeMask: mask},
            ...extra,
          },
        },
      },
      actor,
    );
  const execute = r =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: r.data.review_id, idempotency_key: r.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = r => service.call('amcp_campaign', {action: 'verify', review_id: r.data.review_id}, actor);
  return {store, calls, attributes, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};
const wifi = {name: 'attributes/wi_fi', values: ['free_wi_fi']},
  cards = {
    name: 'attributes/pay_credit_card_types_accepted',
    repeatedEnumValue: {setValues: ['visa', 'mastercard'], unsetValues: ['american_express']},
  };

test('bool, enum and repeated enum attributes are set and a URL attribute cleared; each verifies; a replay sends nothing', async () => {
  const f = fixture();
  try {
    const p = ok(await f.prepare([{name: 'attributes/has_wifi_free', values: [true]}, wifi, cards]));
    assert.equal(p.data.creative_impact.scope, 'location_attributes');
    assert.deepEqual(p.data.creative_impact.clearing, []);
    ok(await f.execute(p));
    assert.deepEqual(f.attributes.get('locations/456').get('attributes/has_wifi_free').values, [true]);
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    const c = ok(await f.prepare([], 'attributes/url_menu'));
    assert.deepEqual(c.data.creative_impact.clearing, ['attributes/url_menu']);
    assert.match(c.data.creative_impact.effect, /clears attributes\/url_menu/);
    ok(await f.execute(c));
    assert.equal(f.attributes.get('locations/456').has('attributes/url_menu'), false);
    assert.equal(ok(await f.verify(c)).data.status, 'verified');
    const u = ok(await f.prepare([{name: 'attributes/url_menu', uriValues: [{uri: 'https://example.com/new-menu'}]}]));
    ok(await f.execute(u));
    assert.equal(ok(await f.verify(u)).data.status, 'verified');
    assert.equal(f.writes(), 3);
  } finally {
    f.store.close();
  }
});

test('malformed attribute edits are refused before any request; unavailable, deprecated, mistyped, unchanged and unclaimed after reading', async () => {
  const cases = [
    ['a name without attributes/', [{name: 'wi_fi', values: ['free_wi_fi']}], 'wi_fi'],
    ['an attribute outside the mask', [wifi], 'attributes/has_wifi_free'],
    [
      'two value fields',
      [{name: 'attributes/wi_fi', values: ['free_wi_fi'], uriValues: [{uri: 'https://example.com'}]}],
      undefined,
    ],
    ['a read-only value type', [{...wifi, valueType: 'ENUM'}], undefined],
    ['two values', [{name: 'attributes/wi_fi', values: ['free_wi_fi', 'paid_wi_fi']}], undefined],
    ['an ftp URL', [{name: 'attributes/url_menu', uriValues: [{uri: 'ftp://example.com/menu'}]}], undefined],
    [
      'a value set and unset',
      [
        {
          name: 'attributes/pay_credit_card_types_accepted',
          repeatedEnumValue: {setValues: ['visa'], unsetValues: ['visa']},
        },
      ],
      undefined,
    ],
    ['a repeated attribute', [wifi, wifi], 'attributes/wi_fi'],
  ];
  for (const [label, list, mask] of cases) {
    const f = fixture();
    try {
      const r = await f.prepare(list, mask);
      assert.equal(
        r.error?.code,
        'INVALID_BUSINESS_LOCATION_ATTRIBUTE',
        label + ': ' + JSON.stringify(r).slice(0, 300),
      );
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const g = fixture();
  try {
    assert.match(
      (await g.prepare([{name: 'attributes/has_pool', values: [true]}])).error?.message ?? '',
      /not available for this location/,
    );
    assert.match(
      (await g.prepare([{name: 'attributes/has_delivery', values: [true]}])).error?.message ?? '',
      /deprecated/,
    );
    assert.match(
      (await g.prepare([{name: 'attributes/wi_fi', values: ['wifi_6']}])).error?.message ?? '',
      /ENUM attribute/,
    );
    assert.match(
      (await g.prepare([{name: 'attributes/has_wifi_free', values: ['yes']}])).error?.message ?? '',
      /BOOL attribute/,
    );
    assert.match(
      (
        await g.prepare([
          {name: 'attributes/url_menu', uriValues: [{uri: 'https://example.com/a'}, {uri: 'https://example.com/b'}]},
        ])
      ).error?.message ?? '',
      /one URL/,
    );
    assert.match(
      (
        await g.prepare([
          {name: 'attributes/pay_credit_card_types_accepted', repeatedEnumValue: {setValues: ['bitcoin']}},
        ])
      ).error?.message ?? '',
      /REPEATED_ENUM attribute/,
    );
    assert.match(
      (await g.prepare([{name: 'attributes/has_wifi_free', values: [false]}])).error?.message ?? '',
      /already has these attribute values/,
    );
    assert.match((await g.prepare([wifi], 'attributes/wi_fi', '458')).error?.message ?? '', /Voice of Merchant/);
    assert.equal(g.writes(), 0);
  } finally {
    g.store.close();
  }
  const h = fixture({scopes: []});
  try {
    assert.equal((await h.prepare([wifi])).success, false);
    assert.equal(h.writes(), 0);
  } finally {
    h.store.close();
  }
});

test('an error reply is never resubmitted, an ignored edit is not verified, and the ledger lists the row', async () => {
  const e = fixture({mode: 'error'});
  try {
    const p = ok(await e.prepare([wifi]));
    assert.equal((await e.execute(p)).success, false);
    assert.equal((await e.execute(p)).success, false);
    assert.equal(e.writes(), 1);
  } finally {
    e.store.close();
  }
  const g = fixture({mode: 'ignore'});
  try {
    const p = ok(await g.prepare([wifi]));
    ok(await g.execute(p));
    assert.notEqual(ok(await g.verify(p)).data.status, 'verified');
  } finally {
    g.store.close();
  }
  const row = actionContracts(registry).find(r => r.gateway === gateway && r.action === 'UPDATE_LOCATION_ATTRIBUTES');
  assert.equal(row?.status, 'reviewed_write_family');
  assert.equal(row.family, 'google_business_location_attributes');
});
