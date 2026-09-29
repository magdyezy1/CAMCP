import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Criteo Retail Media audience segments, API 2026-07 (pinned OpenAPI document: bulk create, update and delete, and
 * search; checked 2026-09-27): Events segments and empty contact list segments.
 */
const gateway = 'criteo_native_action',
  prefix = '/2026-07/retail-media',
  registry = new Registry(),
  operation = 'criteo_audience_ops';
const actions = {
  create: 'BULK_CREATE_AUDIENCE_SEGMENTS',
  update: 'BULK_UPDATE_AUDIENCE_SEGMENTS',
  remove: 'BULK_DELETE_AUDIENCE_SEGMENTS',
};
const actor = {tenantId: 'criteo-segments', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const scopes = [
  'RetailMedia_Accounts_Read',
  'RetailMedia_Campaign_Read',
  'RetailMedia_Audience_Read',
  'RetailMedia_Audience_Manage',
];
function fixture(mode = '', granted = scopes) {
  const store = new Store(':memory:', Buffer.alloc(32, 103).toString('base64')),
    calls = [];
  let writes = 0,
    next = 900;
  store.putConnection(
    owner,
    {
      id: 'criteo',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Criteo',
      scopes: granted,
    },
    {accessToken: 'synthetic'},
  );
  const segments = new Map([
    [
      '701',
      {
        accountId: '123',
        name: 'Coffee buyers',
        description: 'Bought coffee',
        retailerId: '77',
        type: 'Events',
        events: {
          shopperActivity: 'Buy',
          lookbackDays: 'Last30Days',
          categoryIds: ['11'],
          brandIds: [],
          minPrice: null,
          maxPrice: null,
        },
      },
    ],
    [
      '702',
      {
        accountId: '123',
        name: 'CRM list',
        retailerId: '77',
        type: 'ContactList',
        contactList: {identifierType: 'Email', isReadOnly: false, sharingStatus: 'NotShared'},
      },
    ],
    [
      '799',
      {
        accountId: '999',
        name: 'Foreign',
        retailerId: '77',
        type: 'Events',
        events: {shopperActivity: 'View', lookbackDays: 'Last7Days'},
      },
    ],
  ]);
  const envelope = data => ({data, errors: [], warnings: []});
  const shown = (id, s) => ({id, type: 'RmAudienceSegment', attributes: structuredClone(s)});
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        method = init.method,
        path = u.pathname,
        body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({path, method});
      if (method === 'GET' && path === prefix + '/accounts')
        return Response.json({
          ...envelope([{id: '123', type: 'RetailMediaAccount', attributes: {name: 'Account', currency: 'USD'}}]),
          metadata: {
            currentPageIndex: 0,
            currentPageSize: 2,
            totalItemsAcrossAllPages: 1,
            totalPages: 1,
            nextPage: null,
          },
        });
      if (method === 'POST' && path === prefix + '/accounts/123/retailers/search') {
        const ids = body.data.attributes.retailerIdFilter;
        return Response.json({
          ...envelope(ids.filter(id => id === '77').map(id => ({id, type: 'Retailer', attributes: {name: 'Grocer'}}))),
          metadata: {totalItemsAcrossAllPages: 1},
        });
      }
      if (method === 'POST' && path === prefix + '/accounts/123/audience-segments/search') {
        const ids = body.data.attributes.audienceSegmentIds;
        return Response.json({
          ...envelope([...segments].filter(([id]) => ids.includes(id)).map(([id, s]) => shown(id, s))),
          meta: {limit: 500, offset: 0, totalItems: ids.length},
        });
      }
      writes++;
      if (method === 'POST' && path === prefix + '/accounts/123/audience-segments/create') {
        const rows = body.data.map(x => {
          const id = String(next++),
            a = x.attributes,
            s = {
              accountId: '123',
              name: a.name,
              description: a.description,
              retailerId: a.retailerId,
              type: a.events ? 'Events' : 'ContactList',
              ...(a.events
                ? {events: {categoryIds: [], brandIds: [], minPrice: null, maxPrice: null, ...a.events}}
                : {contactList: {...a.contactList, isReadOnly: false, sharingStatus: 'NotShared'}}),
            };
          if (mode !== 'ignore') segments.set(id, s);
          return shown(id, s);
        });
        return Response.json(
          mode === 'warn' ? {data: rows, errors: [], warnings: [{code: 'x', detail: 'Partial'}]} : envelope(rows),
        );
      }
      if (method === 'PATCH' && path === prefix + '/accounts/123/audience-segments') {
        const rows = body.data.map(x => {
          const s = segments.get(x.id),
            a = x.attributes;
          if (mode !== 'ignore') {
            if (a.name !== undefined) s.name = a.name;
            if (a.description !== undefined) s.description = a.description.value;
            if (a.events)
              for (const [k, v] of Object.entries(a.events))
                s.events[k] = v && typeof v === 'object' && !Array.isArray(v) ? v.value : v;
          }
          return shown(x.id, s);
        });
        return Response.json(envelope(rows));
      }
      if (method === 'POST' && path === prefix + '/accounts/123/audience-segments/delete') {
        if (mode !== 'ignore') for (const x of body.data) segments.delete(x.id);
        return Response.json(envelope(body.data.map(x => ({id: x.id, type: 'RmAudienceSegmentId'}))));
      }
      throw new Error('Unexpected ' + method + ' ' + path);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    10000,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const call = (action, data) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {operation, arguments: {action, account_id: '123', payload: {data}}}},
      actor,
    );
  const execute = (p, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        ...extra,
      },
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, segments, call, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};
const events = (extra = {}) => ({
  type: 'RmAudienceSegment',
  attributes: {
    name: 'Snack viewers',
    retailerId: '77',
    events: {shopperActivity: 'View', lookbackDays: 'Last14Days', categoryIds: ['21', '22'], minPrice: 1, maxPrice: 20},
    ...extra,
  },
});

test('an Events segment and an empty contact list segment are created and verify; creation serves nothing and needs no confirmation', async () => {
  const f = fixture();
  try {
    const p = ok(
      await f.call(actions.create, [
        events(),
        {
          type: 'RmAudienceSegment',
          attributes: {
            name: 'Loyalty emails',
            description: 'Uploaded later',
            retailerId: '77',
            contactList: {identifierType: 'Email'},
          },
        },
      ]),
    );
    assert.equal(p.data.creative_impact.may_affect_serving, false);
    assert.match(p.data.creative_impact.effect, /stays empty/);
    ok(await f.execute(p));
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('event rules change with spending confirmation and count as activation; a rename needs neither; deletion counts as a deletion and verifies gone', async () => {
  const f = fixture();
  try {
    const rules = ok(
      await f.call(actions.update, [
        {id: '701', attributes: {events: {lookbackDays: 'Last90Days', brandIds: ['5'], maxPrice: {value: 50}}}},
      ]),
    );
    assert.equal(rules.data.creative_impact.may_affect_serving, true);
    assert.equal((await f.execute(rules)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    ok(await f.execute(rules, {spend_change_confirmed: true}));
    assert.equal(ok(await f.verify(rules)).data.status, 'verified');
    const renamed = ok(
      await f.call(actions.update, [{id: '702', attributes: {name: 'CRM list EU', description: {value: null}}}]),
    );
    ok(await f.execute(renamed));
    assert.equal(ok(await f.verify(renamed)).data.status, 'verified');
    const removed = ok(await f.call(actions.remove, [{id: '702', type: 'RmAudienceSegment'}]));
    ok(await f.execute(removed));
    assert.equal(ok(await f.verify(removed)).data.status, 'verified');
    assert.equal(f.segments.has('702'), false);
    saveSpendPolicy(f.store, owner, {gateway, account_id: '123', confirmed: true, policy: {allow_deletion: false}});
    assert.equal((await f.call(actions.remove, [{id: '701'}])).error?.code, 'POLICY_DELETION_FORBIDDEN');
    saveSpendPolicy(f.store, owner, {gateway, account_id: '123', confirmed: true, policy: {allow_activation: false}});
    assert.equal(
      (await f.call(actions.update, [{id: '701', attributes: {events: {shopperActivity: 'View'}}}])).error?.code,
      'POLICY_ACTIVATION_FORBIDDEN',
    );
  } finally {
    f.store.close();
  }
});

test('malformed segment requests are refused before any request', async () => {
  const cases = [
    ['empty list', actions.create, []],
    ['both kinds', actions.create, [events({contactList: {identifierType: 'Email'}})]],
    ['neither kind', actions.create, [{attributes: {name: 'X', retailerId: '77'}}]],
    ['unknown activity', actions.create, [events({events: {shopperActivity: 'Click', lookbackDays: 'Last7Days'}})]],
    [
      'min above max',
      actions.create,
      [events({events: {shopperActivity: 'Buy', lookbackDays: 'Last7Days', minPrice: 30, maxPrice: 10}})],
    ],
    ['retailer name', actions.create, [events({retailerId: 'Grocer'})]],
    [
      'contacts in a create',
      actions.create,
      [
        {
          attributes: {
            name: 'X',
            retailerId: '77',
            contactList: {identifierType: 'Email', identifiers: ['a@example.com']},
          },
        },
      ],
    ],
    ['id in a create', actions.create, [{id: '5', ...events()}]],
    ['retailer change', actions.update, [{id: '701', attributes: {retailerId: '78'}}]],
    ['empty update', actions.update, [{id: '701', attributes: {}}]],
    ['plain price in an update', actions.update, [{id: '701', attributes: {events: {maxPrice: 5}}}]],
    ['duplicate delete', actions.remove, [{id: '701'}, {id: '701'}]],
  ];
  for (const [label, action, data] of cases) {
    const f = fixture();
    try {
      const r = await f.call(action, data);
      assert.equal(r.success, false, label);
      assert.equal(f.calls.length, 0, label + ': ' + JSON.stringify(r).slice(0, 300));
    } finally {
      f.store.close();
    }
  }
});

test('unknown retailers and segments, foreign segments, rules on contact lists and unchanged values are refused without writes; a response with warnings is never resubmitted; scopes, the model and the ledger match', async () => {
  const f = fixture();
  try {
    assert.equal((await f.call(actions.create, [events({retailerId: '78'})])).error?.code, 'STATE_NOT_FOUND');
    assert.equal((await f.call(actions.update, [{id: '705', attributes: {name: 'X'}}])).error?.code, 'STATE_NOT_FOUND');
    assert.equal((await f.call(actions.remove, [{id: '799'}])).error?.code, 'STATE_TARGET_MISMATCH');
    assert.equal(
      (await f.call(actions.update, [{id: '702', attributes: {events: {shopperActivity: 'Buy'}}}])).error?.code,
      'INVALID_CRITEO_AUDIENCE_SEGMENT',
    );
    assert.equal(
      (await f.call(actions.update, [{id: '701', attributes: {name: 'Coffee buyers'}}])).error?.code,
      'INVALID_CRITEO_AUDIENCE_SEGMENT',
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
  const warn = fixture('warn');
  try {
    const p = ok(await warn.call(actions.create, [events()]));
    assert.equal((await warn.execute(p)).success, false);
    assert.equal((await warn.execute(p)).success, false);
    assert.equal(warn.writes(), 1);
  } finally {
    warn.store.close();
  }
  const ignored = fixture('ignore');
  try {
    const p = ok(await ignored.call(actions.update, [{id: '701', attributes: {name: 'Renamed'}}]));
    ok(await ignored.execute(p));
    assert.notEqual(ok(await ignored.verify(p)).data.status, 'verified');
  } finally {
    ignored.store.close();
  }
  const narrow = fixture(
    '',
    scopes.filter(s => s !== 'RetailMedia_Audience_Manage'),
  );
  try {
    assert.equal((await narrow.call(actions.create, [events()])).error?.code, 'INSUFFICIENT_SCOPE');
  } finally {
    narrow.store.close();
  }
  const d = JSON.parse(readFileSync('.mirror/VENDOR/criteo-retail-2026-07.json', 'utf8')),
    S = (d.document ?? d).components.schemas;
  assert.deepEqual([...S.RmEventsCreateV1.required].sort(), ['lookbackDays', 'shopperActivity']);
  assert.deepEqual([...S.RmAudienceSegmentCreateEntityV1.required].sort(), ['name', 'retailerId']);
  for (const action of Object.values(actions)) {
    const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
    assert.equal(rows.length, 1, action);
    assert.equal(rows[0].status, 'reviewed_write_family', action);
    assert.equal(rows[0].family, 'criteo_audience_segments', action);
  }
});
