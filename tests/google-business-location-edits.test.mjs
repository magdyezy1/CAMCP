import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Business Profile location hours and contact details (Business Information API v1, pinned Discovery document, checked
 * 2026-09-28).
 */
const gateway = 'google_business_native_action',
  operation = 'gmb_location_ops',
  registry = new Registry();
const actor = {tenantId: 'business-location-edits', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const weekdays = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'].map(d => ({
  openDay: d,
  openTime: {hours: 9},
  closeDay: d,
  closeTime: {hours: 17},
}));
function fixture(o = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 111).toString('base64')),
    calls = [];
  store.putConnection(
    owner,
    {
      id: 'b1a2c3d4-0000-4000-8000-000000000111',
      tenantId: actor.tenantId,
      gateway,
      label: 'Synthetic',
      enabled: true,
      accounts: ['locations/456', 'locations/458', 'locations/459'],
      writeAccounts: ['locations/456', 'locations/458', 'locations/459'],
      scopes: o.scopes ?? ['https://www.googleapis.com/auth/business.manage'],
    },
    {accessToken: 'synthetic'},
  );
  const locations = new Map([
    [
      'locations/456',
      {
        name: 'locations/456',
        title: 'Synthetic Bakery',
        regularHours: {periods: structuredClone(weekdays)},
        phoneNumbers: {primaryPhone: '+1 555 0100', additionalPhones: []},
        websiteUri: 'https://example.com/',
        labels: ['bakery'],
        openInfo: {status: 'OPEN'},
        metadata: {hasVoiceOfMerchant: true, hasPendingEdits: false, mapsUri: 'https://maps.example/456'},
      },
    ],
    [
      'locations/458',
      {
        name: 'locations/458',
        title: 'Unclaimed Cafe',
        openInfo: {status: 'OPEN'},
        metadata: {hasVoiceOfMerchant: false},
      },
    ],
    [
      'locations/459',
      {
        name: 'locations/459',
        title: 'Closed Shop',
        regularHours: {periods: structuredClone(weekdays)},
        openInfo: {status: 'CLOSED_PERMANENTLY'},
        metadata: {hasVoiceOfMerchant: true},
      },
    ],
  ]);
  let writes = 0;
  const transport = new NativeTransport(async (url, init) => {
    const u = new URL(String(url)),
      path = u.pathname,
      method = init?.method ?? 'GET',
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({path, method, query: Object.fromEntries(u.searchParams)});
    assert.equal(u.origin, 'https://mybusinessbusinessinformation.googleapis.com');
    const l = locations.get(path.slice(4));
    if (method === 'GET') {
      assert.equal(
        u.searchParams.get('readMask'),
        'name,title,regularHours,specialHours,phoneNumbers,websiteUri,labels,adWordsLocationExtensions,openInfo,metadata',
      );
      return l
        ? Response.json({...l, metadata: {...l.metadata, hasPendingEdits: calls.length % 2 === 0}})
        : Response.json({error: {code: 404, message: 'Not found'}}, {status: 404});
    }
    if (method === 'PATCH' && l) {
      writes++;
      if (o.mode === 'error')
        return Response.json({error: {code: 400, message: 'Invalid phone number'}}, {status: 400});
      const next = structuredClone(l);
      for (const f of u.searchParams.get('updateMask').split(',')) next[f] = body[f];
      if (o.mode === 'ignore') return Response.json(l);
      locations.set(l.name, next);
      return Response.json(next);
    }
    throw Error('Unexpected ' + method + ' ' + path);
  });
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const prepare = (payload, mask = Object.keys(payload).join(','), location = '456', extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          operation,
          arguments: {action: 'PATCH_LOCATION', location_id: location, payload, query: {updateMask: mask}, ...extra},
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
  return {store, calls, locations, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('hours, holiday hours, phones, website, labels and the Ads phone are edited and verify; a replay sends nothing', async () => {
  const f = fixture();
  try {
    const saturday = [
      ...weekdays,
      {
        openDay: 'SATURDAY',
        openTime: {hours: 10, minutes: 0},
        closeDay: 'SATURDAY',
        closeTime: {hours: 14, minutes: 30},
      },
    ];
    const h = ok(
      await f.prepare({
        regularHours: {periods: saturday},
        specialHours: {
          specialHourPeriods: [
            {startDate: {year: 2026, month: 12, day: 25}, closed: true},
            {startDate: {year: 2026, month: 12, day: 31}, openTime: {hours: 9}, closeTime: {hours: 13}},
          ],
        },
      }),
    );
    assert.equal(h.data.creative_impact.operation, 'update');
    assert.equal(h.data.creative_impact.may_affect_serving, false);
    assert.match(h.data.creative_impact.effect, /public listing/);
    ok(await f.execute(h));
    assert.equal(f.locations.get('locations/456').regularHours.periods.length, 6);
    assert.equal(ok(await f.verify(h)).data.status, 'verified', 'omitted zero minutes read as 00');
    assert.equal((await f.execute(h)).data.replayed, true);
    const c = ok(
      await f.prepare({
        phoneNumbers: {primaryPhone: '+1 555 0199', additionalPhones: ['+1 555 0198']},
        websiteUri: 'https://example.com/bakery',
        labels: ['bakery', 'downtown'],
        adWordsLocationExtensions: {adPhone: '+1 555 0177'},
      }),
    );
    assert.equal(c.data.creative_impact.may_affect_serving, true);
    assert.match(c.data.creative_impact.effect, /location asset filters/);
    ok(await f.execute(c));
    assert.equal(ok(await f.verify(c)).data.status, 'verified');
    assert.equal(f.writes(), 2);
  } finally {
    f.store.close();
  }
});

test('malformed edits are refused before any request; unclaimed, closed and unchanged locations after reading', async () => {
  const cases = [
    ['a title', {title: 'New name'}],
    ['an open status', {openInfo: {status: 'CLOSED_TEMPORARILY'}}],
    ['a store code', {storeCode: 'b-1'}],
    [
      'a period that closes when it opens',
      {regularHours: {periods: [{openDay: 'MONDAY', openTime: {hours: 9}, closeDay: 'MONDAY', closeTime: {hours: 9}}]}},
    ],
    [
      'an unspecified day',
      {
        regularHours: {
          periods: [
            {openDay: 'DAY_OF_WEEK_UNSPECIFIED', openTime: {hours: 9}, closeDay: 'MONDAY', closeTime: {hours: 17}},
          ],
        },
      },
    ],
    [
      '24:30',
      {
        regularHours: {
          periods: [{openDay: 'MONDAY', openTime: {hours: 9}, closeDay: 'MONDAY', closeTime: {hours: 24, minutes: 30}}],
        },
      },
    ],
    [
      'a 25-hour special period',
      {
        specialHours: {
          specialHourPeriods: [
            {
              startDate: {year: 2026, month: 12, day: 24},
              endDate: {year: 2026, month: 12, day: 25},
              openTime: {hours: 8},
              closeTime: {hours: 9},
            },
          ],
        },
      },
    ],
    ['February 30', {specialHours: {specialHourPeriods: [{startDate: {year: 2026, month: 2, day: 30}, closed: true}]}}],
    ['only the primary phone', {phoneNumbers: {primaryPhone: '+1 555 0100'}}],
    [
      'three additional phones',
      {phoneNumbers: {primaryPhone: '+1 555 0100', additionalPhones: ['+1 555 0101', '+1 555 0102', '+1 555 0103']}},
    ],
    ['an ftp website', {websiteUri: 'ftp://example.com/'}],
    ['a 256-character label', {labels: ['x'.repeat(256)]}],
  ];
  for (const [label, payload] of cases) {
    const f = fixture();
    try {
      const r = await f.prepare(payload);
      assert.equal(r.error?.code, 'INVALID_BUSINESS_LOCATION_EDIT', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const g = fixture();
  try {
    assert.equal(
      (await g.prepare({websiteUri: 'https://example.com/x'}, 'websiteUri,labels')).error?.code,
      'INVALID_BUSINESS_LOCATION_EDIT',
      'a mask field missing from the body',
    );
    assert.equal(
      (
        await g.prepare({websiteUri: 'https://example.com/x'}, 'websiteUri', '456', {
          query: {updateMask: 'websiteUri', validateOnly: true},
        })
      ).error?.code,
      'INVALID_BUSINESS_LOCATION_EDIT',
      'validateOnly',
    );
    assert.equal(g.calls.length, 0);
    assert.match(
      (await g.prepare({websiteUri: 'https://example.com/cafe'}, 'websiteUri', '458')).error?.message ?? '',
      /no Voice of Merchant/,
    );
    assert.match(
      (await g.prepare({websiteUri: 'https://example.com/shop'}, 'websiteUri', '459')).error?.message ?? '',
      /closed permanently/,
    );
    assert.match(
      (await g.prepare({websiteUri: 'https://example.com/'})).error?.message ?? '',
      /already has these values/,
    );
    assert.match(
      (
        await g.prepare(
          {specialHours: {specialHourPeriods: [{startDate: {year: 2026, month: 12, day: 25}, closed: true}]}},
          'specialHours',
          '458',
        )
      ).error?.message ?? '',
      /Voice of Merchant/,
    );
    assert.equal(g.writes(), 0);
  } finally {
    g.store.close();
  }
  const h = fixture({scopes: []});
  try {
    assert.equal((await h.prepare({websiteUri: 'https://example.com/x'})).success, false);
    assert.equal(h.writes(), 0);
  } finally {
    h.store.close();
  }
});

test('an error reply is never resubmitted, an ignored edit is not verified, and the ledger lists the row', async () => {
  const e = fixture({mode: 'error'});
  try {
    const p = ok(await e.prepare({websiteUri: 'https://example.com/new'}));
    assert.equal((await e.execute(p)).success, false);
    assert.equal((await e.execute(p)).success, false);
    assert.equal(e.writes(), 1);
  } finally {
    e.store.close();
  }
  const g = fixture({mode: 'ignore'});
  try {
    const p = ok(await g.prepare({websiteUri: 'https://example.com/new'}));
    ok(await g.execute(p));
    assert.notEqual(ok(await g.verify(p)).data.status, 'verified');
  } finally {
    g.store.close();
  }
  const row = actionContracts(registry).find(r => r.gateway === gateway && r.action === 'PATCH_LOCATION');
  assert.equal(row?.status, 'reviewed_write_family');
  assert.equal(row.family, 'google_business_location_edits');
});
