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
 * DV360 line item bulk update, Display & Video 360 API v4 (pinned Discovery document: advertisers.lineItems.bulkUpdate,
 * checked 2026-09-27): entityStatus and containsEuPoliticalAds of many line items.
 */
const gateway = 'dv360_native_action',
  registry = new Registry(),
  action = 'DV360_ADVERTISERS_LINE_ITEMS_BULK_UPDATE';
const actor = {tenantId: 'dv360-bulk', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
function fixture(mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 90).toString('base64')),
    calls = [];
  let writes = 0;
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
      entityStatus: 'ENTITY_STATUS_PAUSED',
      containsEuPoliticalAds: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
    },
    457: {
      insertionOrderId: '20',
      lineItemType: 'LINE_ITEM_TYPE_VIDEO_DEFAULT',
      entityStatus: 'ENTITY_STATUS_DRAFT',
      containsEuPoliticalAds: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
    },
    458: {
      insertionOrderId: '21',
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
  };
  const orders = {20: {entityStatus: 'ENTITY_STATUS_ACTIVE'}, 21: {entityStatus: 'ENTITY_STATUS_PAUSED'}};
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
            ...orders[m[1]],
          });
        return Response.json({error: {code: 404, message: 'Not found', status: 'NOT_FOUND'}}, {status: 404});
      }
      if (path === '/v4/advertisers/123/lineItems:bulkUpdate') {
        writes++;
        const fields = body.updateMask.split(','),
          updated = [],
          skipped = [],
          failed = [];
        for (const id of body.lineItemIds) {
          if (mode === 'partial' && id === body.lineItemIds.at(-1)) {
            failed.push(id);
            continue;
          }
          if (fields.every(f => lines[id][f] === body.targetLineItem[f])) {
            skipped.push(id);
            continue;
          }
          if (mode !== 'ignore') for (const f of fields) lines[id][f] = body.targetLineItem[f];
          updated.push(id);
        }
        return Response.json({
          ...(updated.length ? {updatedLineItemIds: updated} : {}),
          ...(skipped.length ? {skippedLineItemIds: skipped} : {}),
          ...(failed.length ? {failedLineItemIds: failed, errors: [{code: 3, message: 'Invalid'}]} : {}),
        });
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
  const prepare = body =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action, params: {advertiserId: '123'}, body}},
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
  return {store, calls, lines, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};
const pause = ids => ({
  lineItemIds: ids,
  targetLineItem: {entityStatus: 'ENTITY_STATUS_PAUSED'},
  updateMask: 'entityStatus',
});

test('pausing line items reads each line item and insertion order, updates once and verifies; already paused ones are skipped', async () => {
  const f = fixture();
  try {
    const p = ok(await f.prepare(pause(['456', '458']))),
      impact = p.data.creative_impact;
    assert.equal(impact.scope, 'line_item_bulk_update');
    assert.deepEqual(
      impact.line_items.map(l => [l.line_item_id, l.unchanged]),
      [
        ['456', true],
        ['458', false],
      ],
    );
    assert.match(impact.effect, /stop serving/);
    ok(await f.execute(p));
    assert.equal(f.writes(), 1);
    assert.equal(f.lines[458].entityStatus, 'ENTITY_STATUS_PAUSED');
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('activation needs spending confirmation and is an activation under owner policy; the EU declaration alone is not', async () => {
  const f = fixture();
  try {
    const on = ok(
      await f.prepare({
        lineItemIds: ['456', '457'],
        targetLineItem: {entityStatus: 'ENTITY_STATUS_ACTIVE'},
        updateMask: 'entityStatus',
      }),
    );
    assert.match(on.data.creative_impact.effect, /spend/);
    assert.equal((await f.execute(on)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal(f.writes(), 0);
    ok(await f.execute(on, {spend_change_confirmed: true}));
    assert.equal(ok(await f.verify(on)).data.status, 'verified');
    const eu = ok(
      await f.prepare({
        lineItemIds: ['456'],
        targetLineItem: {containsEuPoliticalAds: 'CONTAINS_EU_POLITICAL_ADVERTISING'},
        updateMask: 'containsEuPoliticalAds',
      }),
    );
    ok(await f.execute(eu));
    assert.equal(ok(await f.verify(eu)).data.status, 'verified');
    saveSpendPolicy(f.store, owner, {gateway, account_id: '123', confirmed: true, policy: {allow_activation: false}});
    f.lines[456].entityStatus = 'ENTITY_STATUS_PAUSED';
    assert.equal(
      (
        await f.prepare({
          lineItemIds: ['456'],
          targetLineItem: {entityStatus: 'ENTITY_STATUS_ACTIVE'},
          updateMask: 'entityStatus',
        })
      ).error?.code,
      'POLICY_ACTIVATION_FORBIDDEN',
    );
  } finally {
    f.store.close();
  }
});

test('malformed bulk updates are refused before any request', async () => {
  const cases = [
    [
      'no line items',
      {lineItemIds: [], targetLineItem: {entityStatus: 'ENTITY_STATUS_PAUSED'}, updateMask: 'entityStatus'},
    ],
    ['101 line items', pause(Array.from({length: 101}, (_, i) => String(1000 + i)))],
    ['numeric ID', {...pause(['456']), lineItemIds: [456]}],
    ['repeated line item', pause(['456', '456'])],
    ['unsupported mask field', {lineItemIds: ['456'], targetLineItem: {displayName: 'x'}, updateMask: 'displayName'}],
    [
      'field outside the mask',
      {
        lineItemIds: ['456'],
        targetLineItem: {
          entityStatus: 'ENTITY_STATUS_PAUSED',
          containsEuPoliticalAds: 'CONTAINS_EU_POLITICAL_ADVERTISING',
        },
        updateMask: 'entityStatus',
      },
    ],
    [
      'back to draft',
      {lineItemIds: ['456'], targetLineItem: {entityStatus: 'ENTITY_STATUS_DRAFT'}, updateMask: 'entityStatus'},
    ],
    [
      'unknown EU value',
      {
        lineItemIds: ['456'],
        targetLineItem: {containsEuPoliticalAds: 'EU_POLITICAL_ADVERTISING_STATUS_UNKNOWN'},
        updateMask: 'containsEuPoliticalAds',
      },
    ],
    ['unqualified field', {...pause(['456']), validateOnly: true}],
  ];
  for (const [label, body] of cases) {
    const f = fixture();
    try {
      const r = await f.prepare(body);
      assert.equal(r.error?.code, 'INVALID_DV360_LINE_ITEM_BULK', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
});

test('YouTube & Partners, archived, foreign and unchanged line items are refused after reading, without writes', async () => {
  const f = fixture();
  try {
    assert.match((await f.prepare(pause(['456', '459']))).error?.message ?? '', /YouTube & Partners/);
    assert.match(
      (
        await f.prepare({
          lineItemIds: ['460'],
          targetLineItem: {entityStatus: 'ENTITY_STATUS_PAUSED'},
          updateMask: 'entityStatus',
        })
      ).error?.message ?? '',
      /archived/,
    );
    assert.equal((await f.prepare(pause(['999']))).success, false);
    assert.match((await f.prepare(pause(['456']))).error?.message ?? '', /already has these values/);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('a partial result is a failure that is never resubmitted, and an ignored update is not verified', async () => {
  const partial = fixture('partial');
  try {
    const p = ok(await partial.prepare(pause(['458', '457'])));
    assert.equal((await partial.execute(p)).success, false);
    assert.equal((await partial.execute(p)).success, false);
    assert.equal(partial.writes(), 1);
  } finally {
    partial.store.close();
  }
  const ignored = fixture('ignore');
  try {
    const p = ok(await ignored.prepare(pause(['458'])));
    ok(await ignored.execute(p));
    assert.notEqual(ok(await ignored.verify(p)).data.status, 'verified');
  } finally {
    ignored.store.close();
  }
});

test('the method matches the pinned Discovery document, and the ledger lists it in the family', () => {
  const d = JSON.parse(readFileSync('.mirror/VENDOR/dv360-v4.json', 'utf8')).document,
    m = d.resources.advertisers.resources.lineItems.methods.bulkUpdate,
    S = d.schemas;
  assert.equal(m.httpMethod, 'POST');
  assert.equal(m.path, 'v4/advertisers/{+advertiserId}/lineItems:bulkUpdate');
  assert.match(
    S.BulkUpdateLineItemsRequest.properties.updateMask.description,
    /entityStatus \* containsEuPoliticalAds/,
  );
  assert.deepEqual(Object.keys(S.BulkUpdateLineItemsResponse.properties).sort(), [
    'errors',
    'failedLineItemIds',
    'skippedLineItemIds',
    'updatedLineItemIds',
  ]);
  assert.match(S.LineItem.properties.entityStatus.description, /cannot be changed back to `ENTITY_STATUS_DRAFT`/);
  const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'reviewed_write_family');
  assert.equal(rows[0].family, 'dv360_line_item_bulk_update');
});
