import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Business Profile lodging facts (Lodging API v1, pinned Discovery document, checked 2026-09-28).
 */
const gateway = 'google_business_native_action',
  operation = 'gmb_lodging_ops',
  registry = new Registry();
const actor = {tenantId: 'business-lodging', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const lodgingOrigin = 'https://mybusinesslodging.googleapis.com',
  infoOrigin = 'https://mybusinessbusinessinformation.googleapis.com';
const copy = x => structuredClone(x);
function fixture(o = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 114).toString('base64')),
    calls = [];
  const ids = ['locations/456', 'locations/457', 'locations/458', 'locations/459'];
  store.putConnection(
    owner,
    {
      id: 'b1a2c3d4-0000-4000-8000-000000000114',
      tenantId: actor.tenantId,
      gateway,
      label: 'Synthetic',
      enabled: true,
      accounts: ids,
      writeAccounts: ids,
      scopes: o.scopes ?? ['https://www.googleapis.com/auth/business.manage'],
    },
    {accessToken: 'synthetic'},
  );
  const locations = new Map([
    [
      'locations/456',
      {name: 'locations/456', title: 'Harbour Hotel', openInfo: {status: 'OPEN'}, metadata: {hasVoiceOfMerchant: true}},
    ],
    [
      'locations/457',
      {name: 'locations/457', title: 'New Inn', openInfo: {status: 'OPEN'}, metadata: {hasVoiceOfMerchant: true}},
    ],
    [
      'locations/458',
      {
        name: 'locations/458',
        title: 'Unverified Inn',
        openInfo: {status: 'OPEN'},
        metadata: {hasVoiceOfMerchant: false},
      },
    ],
    [
      'locations/459',
      {
        name: 'locations/459',
        title: 'Old Lodge',
        openInfo: {status: 'CLOSED_PERMANENTLY'},
        metadata: {hasVoiceOfMerchant: true},
      },
    ],
  ]);
  const lodgings = new Map([
    [
      'locations/456/lodging',
      {
        name: 'locations/456/lodging',
        metadata: {updateTime: '2026-09-01T00:00:00Z'},
        connectivity: {freeWifi: false, wifiAvailable: true},
        policies: {checkinTime: {hours: 15}, checkoutTimeException: 'DEPENDENT_ON_SEASON'},
        property: {roomsCount: 120, builtYear: 1998},
        services: {languagesSpoken: [{languageCode: 'en', spoken: true}]},
        allUnits: {maxOccupantsCount: 2},
        someUnits: {maxOccupantsCount: 6},
      },
    ],
    [
      'locations/458/lodging',
      {name: 'locations/458/lodging', metadata: {updateTime: '2026-09-01T00:00:00Z'}, pets: {petsAllowed: false}},
    ],
    [
      'locations/459/lodging',
      {name: 'locations/459/lodging', metadata: {updateTime: '2026-09-01T00:00:00Z'}, pets: {petsAllowed: false}},
    ],
  ]);
  let writes = 0;
  const set = (root, path, value) => {
    const parts = path.split('.'),
      leaf = parts.pop();
    let v = root;
    for (const k of parts) {
      v[k] ??= {};
      v = v[k];
    }
    if (value === null || value === undefined) delete v[leaf];
    else {
      v[leaf] = copy(value);
      const partner = leaf.endsWith('Exception') ? leaf.slice(0, -9) : leaf + 'Exception';
      delete v[partner];
    }
  };
  const get = (root, path) => path.split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), root);
  const transport = new NativeTransport(async (url, init) => {
    const u = new URL(String(url)),
      path = u.pathname,
      method = init?.method ?? 'GET',
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({origin: u.origin, path, method, query: Object.fromEntries(u.searchParams)});
    const missing = () =>
      Response.json(
        {error: {code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND'}},
        {status: 404},
      );
    if (u.origin === infoOrigin && method === 'GET') {
      assert.equal(u.searchParams.get('readMask'), 'name,title,openInfo,metadata');
      const l = locations.get(path.slice(4));
      return l ? Response.json(l) : missing();
    }
    assert.equal(u.origin, lodgingOrigin);
    const name = path.slice(4);
    if (method === 'GET') {
      assert.equal(u.searchParams.get('readMask'), '*');
      const l = lodgings.get(name);
      return l ? Response.json(l) : missing();
    }
    if (method === 'PATCH') {
      writes++;
      if (o.mode === 'error')
        return Response.json(
          {error: {code: 400, message: 'Invalid lodging', status: 'INVALID_ARGUMENT'}},
          {status: 400},
        );
      assert.match(body.metadata.updateTime, /Z$/, 'the asserted time is sent');
      const current = lodgings.get(name) ?? {name};
      if (o.mode !== 'ignore') {
        for (const m of u.searchParams.get('updateMask').split(',')) set(current, m, get(body, m));
        lodgings.set(name, current);
      }
      return Response.json(o.mode === 'other' ? {...current, name: 'locations/999/lodging'} : current);
    }
    throw Error('Unexpected ' + method + ' ' + path);
  });
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const prepare = (payload, mask, location = '456', extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          operation,
          arguments: {
            action: 'UPDATE_LODGING',
            location_id: location,
            payload: {
              name: 'locations/' + location + '/lodging',
              metadata: {updateTime: '2026-09-28T08:00:00Z'},
              ...payload,
            },
            query: {updateMask: mask},
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
  return {store, calls, lodgings, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('lodging facts are set, a union switched, a list replaced and a fact cleared; each verifies; a replay sends nothing', async () => {
  const f = fixture();
  try {
    const p = ok(
      await f.prepare(
        {
          connectivity: {freeWifi: true},
          policies: {checkinTime: {hours: 14, minutes: 30}},
          property: {roomsCount: 124},
        },
        'connectivity.freeWifi,policies.checkinTime,property.roomsCount,metadata.updateTime',
      ),
    );
    assert.equal(p.data.creative_impact.scope, 'lodging');
    assert.equal(p.data.creative_impact.may_affect_serving, false);
    assert.deepEqual(p.data.creative_impact.clearing, []);
    assert.equal(f.calls.filter(c => c.method === 'GET').length, 2, 'the location and the lodging are read');
    ok(await f.execute(p));
    assert.equal(f.lodgings.get('locations/456/lodging').property.roomsCount, 124);
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    const u = ok(await f.prepare({policies: {checkoutTime: {hours: 11}}}, 'policies.checkoutTime'));
    ok(await f.execute(u));
    assert.equal(
      f.lodgings.get('locations/456/lodging').policies.checkoutTimeException,
      undefined,
      'setting a fact clears its exception',
    );
    assert.equal(ok(await f.verify(u)).data.status, 'verified');
    const l = ok(
      await f.prepare(
        {
          services: {
            languagesSpoken: [
              {languageCode: 'ar', spoken: true},
              {languageCode: 'en', spoken: true},
            ],
          },
        },
        'services.languagesSpoken',
      ),
    );
    ok(await f.execute(l));
    assert.equal(ok(await f.verify(l)).data.status, 'verified', 'a list compares as a set');
    const c = ok(await f.prepare({property: {builtYear: null}}, 'property.builtYear'));
    assert.deepEqual(c.data.creative_impact.clearing, ['property.builtYear']);
    ok(await f.execute(c));
    assert.equal(f.lodgings.get('locations/456/lodging').property.builtYear, undefined);
    assert.equal(ok(await f.verify(c)).data.status, 'verified');
    const b = ok(await f.prepare({commonLivingArea: {features: {bidet: true}}}, 'commonLivingArea.features.bidet'));
    ok(await f.execute(b));
    assert.equal(ok(await f.verify(b)).data.status, 'verified', 'a bidet is not a bid: no spending confirmation');
    const n = ok(await f.prepare({pets: {petsAllowed: true}}, 'pets.petsAllowed', '457'));
    assert.equal(n.data.creative_impact.lodging_present, false);
    ok(await f.execute(n));
    assert.equal(ok(await f.verify(n)).data.status, 'verified', 'a location without lodging facts gets them');
    assert.equal(f.writes(), 6);
  } finally {
    f.store.close();
  }
});

test('malformed edits are refused before any request; unverified or closed listings and unchanged facts after reading', async () => {
  const future = new Date(Date.now() + 86400000).toISOString().slice(0, 19) + 'Z';
  const cases = [
    ['an update of every field', {connectivity: {freeWifi: true}}, '*'],
    ['an unknown field', {connectivity: {freeCoffee: true}}, 'connectivity.freeCoffee'],
    [
      'an output-only field',
      {sustainability: {energyEfficiency: {greenBuildingDesign: true}}},
      'sustainability.energyEfficiency.greenBuildingDesign',
    ],
    ['an output-only message', {allUnits: {maxOccupantsCount: 2}}, 'allUnits.maxOccupantsCount'],
    ['a repeated item path', {guestUnits: []}, 'guestUnits.label'],
    ['a parent and its child', {policies: {checkinTime: {hours: 14}}}, 'policies,policies.checkinTime'],
    ['the name', {}, 'name'],
    ['other metadata', {}, 'metadata'],
    [
      'a value outside the mask',
      {connectivity: {freeWifi: true}, policies: {checkinTime: {hours: 14}}},
      'policies.checkinTime',
    ],
    ['a masked field without value', {}, 'connectivity.freeWifi'],
    ['a string for a boolean', {connectivity: {freeWifi: 'yes'}}, 'connectivity.freeWifi'],
    ['an unknown exception', {policies: {checkoutTimeException: 'SOMETIMES'}}, 'policies.checkoutTimeException'],
    ['hour 25', {policies: {checkinTime: {hours: 25}}}, 'policies.checkinTime'],
    ['a negative count', {property: {roomsCount: -1}}, 'property.roomsCount'],
    ['both union members', {connectivity: {freeWifi: true, freeWifiException: 'UNDER_CONSTRUCTION'}}, 'connectivity'],
    ['a unit without label', {guestUnits: [{codes: ['DLX']}]}, 'guestUnits'],
    [
      'a repeated unit code',
      {
        guestUnits: [
          {codes: ['DLX'], label: 'Deluxe'},
          {codes: ['DLX'], label: 'Deluxe twin'},
        ],
      },
      'guestUnits',
    ],
    [
      'an unaccepted language',
      {services: {languagesSpoken: [{languageCode: 'xx', spoken: true}]}},
      'services.languagesSpoken',
    ],
  ];
  for (const [label, payload, mask] of cases) {
    const f = fixture();
    try {
      const r = await f.prepare(payload, mask);
      assert.equal(r.error?.code, 'INVALID_BUSINESS_LODGING_EDIT', label + ': ' + JSON.stringify(r).slice(0, 400));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const g = fixture();
  try {
    const w = metadata => g.prepare({metadata, connectivity: {freeWifi: true}}, 'connectivity.freeWifi');
    for (const [label, metadata] of [
      ['no asserted time', undefined],
      ['an offset time', {updateTime: '2026-09-28T08:00:00+02:00'}],
      ['a future time', {updateTime: future}],
      ['extra metadata', {updateTime: '2026-09-28T08:00:00Z', source: 'x'}],
    ])
      assert.equal((await w(metadata)).error?.code, 'INVALID_BUSINESS_LODGING_EDIT', label);
    assert.equal(
      (
        await g.prepare({connectivity: {freeWifi: true}}, 'connectivity.freeWifi', '456', {
          query: {updateMask: 'connectivity.freeWifi', validateOnly: true},
        })
      ).error?.code,
      'UNKNOWN_VENDOR_PARAMETER',
      'the compiler refuses a query parameter the route does not document',
    );
    assert.equal(g.calls.length, 0);
    assert.match(
      (await g.prepare({pets: {petsAllowed: true}}, 'pets.petsAllowed', '458')).error?.message ?? '',
      /Voice of Merchant/,
    );
    assert.match(
      (await g.prepare({pets: {petsAllowed: true}}, 'pets.petsAllowed', '459')).error?.message ?? '',
      /closed permanently/,
    );
    assert.match(
      (
        await g.prepare(
          {connectivity: {freeWifi: false}, property: {roomsCount: 120}},
          'connectivity.freeWifi,property.roomsCount',
        )
      ).error?.message ?? '',
      /already has these values/,
    );
    assert.equal(g.writes(), 0);
  } finally {
    g.store.close();
  }
  const h = fixture({scopes: []});
  try {
    assert.equal((await h.prepare({pets: {petsAllowed: true}}, 'pets.petsAllowed')).error?.code, 'INSUFFICIENT_SCOPE');
    assert.equal(h.writes(), 0);
  } finally {
    h.store.close();
  }
});

test('an error or foreign reply is never resubmitted, an ignored edit is not verified, the ledger lists the row and the table matches the pinned document', async () => {
  for (const mode of ['error', 'other']) {
    const e = fixture({mode});
    try {
      const p = ok(await e.prepare({pets: {petsAllowed: true}}, 'pets.petsAllowed'));
      assert.equal((await e.execute(p)).success, false, mode);
      assert.equal((await e.execute(p)).success, false, mode);
      assert.equal(e.writes(), 1, mode);
    } finally {
      e.store.close();
    }
  }
  const g = fixture({mode: 'ignore'});
  try {
    const p = ok(await g.prepare({pets: {petsAllowed: true}}, 'pets.petsAllowed'));
    ok(await g.execute(p));
    assert.notEqual(ok(await g.verify(p)).data.status, 'verified');
  } finally {
    g.store.close();
  }
  const row = actionContracts(registry).find(r => r.gateway === gateway && r.action === 'UPDATE_LODGING');
  assert.equal(row?.status, 'reviewed_write_family');
  assert.equal(row.family, 'google_business_lodging');
  // The table is derived from the pinned document; check it wherever the document is present (it is not part of release candidates).
  const pinned = '.mirror/VENDOR/business-lodging-v1.json',
    {lodgingSchemaTable, lodgingEnums} = await import('../dist/src/google-business-lodging.js');
  if (existsSync(pinned)) {
    const schemas = JSON.parse(readFileSync(pinned, 'utf8')).document.schemas;
    for (const [name, line] of Object.entries(lodgingSchemaTable)) {
      const fields = new Set();
      for (const token of line.split(' ')) {
        const [raw, type] = token.split(':'),
          key = raw.replace(/^!/, '');
        fields.add(key);
        if (type === 'x') fields.add(key + 'Exception');
      }
      assert.deepEqual([...fields].sort(), Object.keys(schemas[name].properties).sort(), name);
    }
    for (const [key, values] of Object.entries(lodgingEnums))
      assert.ok(
        Object.values(schemas).some(s =>
          Object.values(s.properties ?? {}).some(p => JSON.stringify(p.enum) === JSON.stringify(values)),
        ),
        key,
      );
  }
});
