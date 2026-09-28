import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * DV360 line item duplication, Display & Video 360 API v4 (pinned Discovery document: advertisers.lineItems.duplicate and
 * DuplicateLineItemRequest; "Activate Line Item" guide; checked 2026-09-27).
 */
const gateway = 'dv360_native_action',
  registry = new Registry(),
  action = 'DV360_ADVERTISERS_LINE_ITEMS_DUPLICATE';
const actor = {tenantId: 'dv360-duplicate', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
function fixture(mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 94).toString('base64')),
    calls = [];
  let writes = 0,
    next = 900;
  store.putConnection(
    owner,
    {
      id: 'dv360',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic DV360',
      scopes: ['https://www.googleapis.com/auth/display-video'],
    },
    {accessToken: 'synthetic'},
  );
  const lines = {
    456: {
      insertionOrderId: '20',
      lineItemType: 'LINE_ITEM_TYPE_DISPLAY_DEFAULT',
      entityStatus: 'ENTITY_STATUS_ACTIVE',
      containsEuPoliticalAds: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
    },
    459: {
      insertionOrderId: '20',
      lineItemType: 'LINE_ITEM_TYPE_YOUTUBE_AND_PARTNERS_ACTION',
      entityStatus: 'ENTITY_STATUS_PAUSED',
    },
    460: {
      insertionOrderId: '20',
      lineItemType: 'LINE_ITEM_TYPE_DISPLAY_DEFAULT',
      entityStatus: 'ENTITY_STATUS_ARCHIVED',
    },
    461: {insertionOrderId: '22', lineItemType: 'LINE_ITEM_TYPE_DISPLAY_DEFAULT', entityStatus: 'ENTITY_STATUS_PAUSED'},
  };
  const orders = {20: {entityStatus: 'ENTITY_STATUS_ACTIVE'}, 22: {entityStatus: 'ENTITY_STATUS_ARCHIVED'}};
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init.method,
        body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({path, method, body});
      if (method === 'GET') {
        if (path === '/v4/advertisers/123')
          return Response.json({
            name: 'advertisers/123',
            advertiserId: '123',
            displayName: 'Advertiser',
            entityStatus: 'ENTITY_STATUS_ACTIVE',
          });
        let m = /^\/v4\/advertisers\/123\/lineItems\/(\d+)$/.exec(path);
        if (m && lines[m[1]])
          return Response.json({
            name: 'advertisers/123/lineItems/' + m[1],
            advertiserId: '123',
            campaignId: '10',
            lineItemId: m[1],
            displayName: 'Line ' + m[1],
            ...lines[m[1]],
          });
        m = /^\/v4\/advertisers\/123\/insertionOrders\/(\d+)$/.exec(path);
        if (m && orders[m[1]])
          return Response.json({
            name: 'advertisers/123/insertionOrders/' + m[1],
            advertiserId: '123',
            insertionOrderId: m[1],
            displayName: 'Order ' + m[1],
            ...orders[m[1]],
          });
        return Response.json({error: {code: 404, message: 'Not found', status: 'NOT_FOUND'}}, {status: 404});
      }
      const m = /^\/v4\/advertisers\/123\/lineItems\/(\d+):duplicate$/.exec(path);
      if (method === 'POST' && m) {
        writes++;
        const id = String(next++),
          src = lines[m[1]];
        if (mode !== 'ignore')
          lines[id] = {
            ...src,
            displayName: body.targetDisplayName,
            containsEuPoliticalAds: body.containsEuPoliticalAds,
            entityStatus: mode === 'active' ? 'ENTITY_STATUS_ACTIVE' : 'ENTITY_STATUS_DRAFT',
          };
        return Response.json(mode === 'same' ? {duplicateLineItemId: m[1]} : {duplicateLineItemId: id});
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
  const prepare = (lineItemId, body) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action, params: {advertiserId: '123', lineItemId}, body}},
      actor,
    );
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, lines, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};
const copy = (extra = {}) => ({
  targetDisplayName: 'Line 456 copy',
  containsEuPoliticalAds: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
  ...extra,
});

test('an active line item is duplicated once into a draft copy in its insertion order, without spending confirmation, and verifies', async () => {
  const f = fixture();
  try {
    const p = ok(await f.prepare('456', copy())),
      impact = p.data.creative_impact;
    assert.equal(impact.scope, 'line_item_duplicate');
    assert.equal(impact.source.entityStatus, 'ENTITY_STATUS_ACTIVE');
    assert.equal(impact.insertion_order.insertionOrderId, '20');
    assert.equal(impact.copy.entityStatus, 'ENTITY_STATUS_DRAFT');
    assert.equal(impact.may_affect_serving, false);
    ok(await f.execute(p));
    assert.equal(f.writes(), 1);
    assert.equal(f.lines[900].displayName, 'Line 456 copy');
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('malformed duplications are refused before any request', async () => {
  const cases = [
    [
      'no name',
      (() => {
        const {targetDisplayName, ...b} = copy();
        return b;
      })(),
    ],
    ['blank name', copy({targetDisplayName: '  '})],
    ['padded name', copy({targetDisplayName: ' Copy'})],
    ['name over 240 bytes', copy({targetDisplayName: 'é'.repeat(121)})],
    ['control character', copy({targetDisplayName: 'Copy\n2'})],
    [
      'no EU declaration',
      (() => {
        const {containsEuPoliticalAds, ...b} = copy();
        return b;
      })(),
    ],
    ['unknown EU value', copy({containsEuPoliticalAds: 'EU_POLITICAL_ADVERTISING_STATUS_UNKNOWN'})],
    ['unknown field', copy({entityStatus: 'ENTITY_STATUS_ACTIVE'})],
  ];
  for (const [label, body] of cases) {
    const f = fixture();
    try {
      const r = await f.prepare('456', body);
      assert.equal(r.error?.code, 'INVALID_DV360_LINE_ITEM_DUPLICATE', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    ok(await f.prepare('456', copy({targetDisplayName: 'é'.repeat(120)})));
  } finally {
    f.store.close();
  }
});

test('YouTube & Partners, archived line items, archived insertion orders and unknown line items are refused after reading, without writes', async () => {
  const f = fixture();
  try {
    assert.match((await f.prepare('459', copy())).error?.message ?? '', /YouTube & Partners/);
    assert.match((await f.prepare('460', copy())).error?.message ?? '', /archived/);
    assert.match((await f.prepare('461', copy())).error?.message ?? '', /Insertion order 22 is archived/);
    assert.equal((await f.prepare('999', copy())).success, false);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('a receipt naming the source is a failure that is never resubmitted; a copy that is not draft, or missing, is not verified', async () => {
  const same = fixture('same');
  try {
    const p = ok(await same.prepare('456', copy()));
    assert.equal((await same.execute(p)).success, false);
    assert.equal((await same.execute(p)).success, false);
    assert.equal(same.writes(), 1);
  } finally {
    same.store.close();
  }
  for (const mode of ['active', 'ignore']) {
    const f = fixture(mode);
    try {
      const p = ok(await f.prepare('456', copy()));
      ok(await f.execute(p));
      assert.notEqual(ok(await f.verify(p)).data.status, 'verified', mode);
    } finally {
      f.store.close();
    }
  }
});

test('the method matches the pinned Discovery document, and the ledger lists it in the family', () => {
  const d = JSON.parse(readFileSync('.mirror/VENDOR/dv360-v4.json', 'utf8')).document,
    m = d.resources.advertisers.resources.lineItems.methods.duplicate,
    S = d.schemas;
  assert.equal(m.httpMethod, 'POST');
  assert.equal(m.path, 'v4/advertisers/{+advertiserId}/lineItems/{+lineItemId}:duplicate');
  assert.deepEqual(m.scopes, ['https://www.googleapis.com/auth/display-video']);
  assert.deepEqual(Object.keys(S.DuplicateLineItemRequest.properties).sort(), [
    'containsEuPoliticalAds',
    'targetDisplayName',
  ]);
  assert.deepEqual(Object.keys(S.DuplicateLineItemResponse.properties), ['duplicateLineItemId']);
  assert.match(S.DuplicateLineItemRequest.properties.targetDisplayName.description, /maximum size of 240 bytes/);
  assert.match(m.description, /YouTube & Partners line items cannot be created/);
  const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'reviewed_write_family');
  assert.equal(rows[0].family, 'dv360_line_item_duplicate');
});
