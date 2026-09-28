import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';

/**
 * DV360 Demand Gen ad groups, Display & Video 360 API v4 (pinned Discovery document and the "Serve a Demand Gen ad"
 * guide, checked 2026-09-27): create, patch with an update mask, and delete.
 */
const gateway = 'dv360_native_action',
  registry = new Registry();
const actor = {tenantId: 'dv360-ad-groups', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const A = 'DV360_ADVERTISERS_AD_GROUPS_';
const inventories = [
  'allowGoogleDisplayNetwork',
  'allowYoutubeShorts',
  'allowYoutubeStream',
  'allowYoutubeFeed',
  'allowGmail',
  'allowDiscover',
];
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 73).toString('base64')),
    calls = [];
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
  const lineItems = {
    555: {
      lineItemType: 'LINE_ITEM_TYPE_DEMAND_GEN',
      entityStatus: 'ENTITY_STATUS_DRAFT',
      displayName: 'DG prospecting',
      bidStrategy: {demandGenBid: {type: 'DEMAND_GEN_BIDDING_STRATEGY_TYPE_TARGET_CPA', value: '10000000'}},
    },
    556: {
      lineItemType: 'LINE_ITEM_TYPE_DEMAND_GEN',
      entityStatus: 'ENTITY_STATUS_ACTIVE',
      displayName: 'DG conversions',
      bidStrategy: {demandGenBid: {type: 'DEMAND_GEN_BIDDING_STRATEGY_TYPE_MAXIMIZE_CONVERSIONS', value: '0'}},
    },
    557: {lineItemType: 'LINE_ITEM_TYPE_DISPLAY_DEFAULT', entityStatus: 'ENTITY_STATUS_PAUSED', displayName: 'Display'},
    558: {
      lineItemType: 'LINE_ITEM_TYPE_DEMAND_GEN',
      entityStatus: 'ENTITY_STATUS_ARCHIVED',
      displayName: 'Old DG',
      bidStrategy: {demandGenBid: {type: 'DEMAND_GEN_BIDDING_STRATEGY_TYPE_TARGET_CPA', value: '5000000'}},
    },
  };
  const adGroups = new Map([
    [
      '901',
      {
        lineItemId: '555',
        displayName: 'Existing group',
        adGroupFormat: 'AD_GROUP_FORMAT_DEMAND_GEN',
        entityStatus: 'ENTITY_STATUS_PAUSED',
        adGroupInventoryControl: {adGroupInventoryStrategy: 'AD_GROUP_INVENTORY_STRATEGY_ALL_GOOGLE_INVENTORY'},
      },
    ],
    [
      '902',
      {
        lineItemId: '555',
        displayName: 'In-stream group',
        adGroupFormat: 'AD_GROUP_FORMAT_IN_STREAM',
        entityStatus: 'ENTITY_STATUS_PAUSED',
      },
    ],
  ]);
  let writes = 0,
    next = 910,
    mode = '';
  // DV360 returns output-only fields and every inventory flag.
  const shown = (id, g) => {
    const bid = g.bidStrategy?.demandGenBid;
    return {
      name: 'advertisers/123/adGroups/' + id,
      advertiserId: '123',
      adGroupId: id,
      ...structuredClone(g),
      ...(g.adGroupInventoryControl?.selectedInventories
        ? {
            adGroupInventoryControl: {
              selectedInventories: Object.fromEntries(
                inventories.map(k => [k, g.adGroupInventoryControl.selectedInventories[k] === true]),
              ),
            },
          }
        : {}),
      ...(g.adGroupFormat === 'AD_GROUP_FORMAT_DEMAND_GEN'
        ? {
            bidStrategy: {
              demandGenBid: {
                ...(bid?.value ? {value: bid.value} : {}),
                effectiveBiddingValue: bid?.value ?? lineItems[g.lineItemId].bidStrategy.demandGenBid.value,
                effectiveBiddingValueSource: bid?.value ? 'BIDDING_SOURCE_AD_GROUP' : 'BIDDING_SOURCE_LINE_ITEM',
              },
            },
          }
        : {}),
    };
  };
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init.method,
        body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({path, method, query: u.search});
      if (method === 'GET') {
        if (path === '/v4/advertisers/123')
          return Response.json({
            name: 'advertisers/123',
            advertiserId: '123',
            partnerId: '1',
            displayName: 'Advertiser',
            entityStatus: 'ENTITY_STATUS_ACTIVE',
            generalConfig: {currencyCode: 'USD', domainUrl: 'https://example.com'},
          });
        let m = /^\/v4\/advertisers\/123\/lineItems\/(\d+)$/.exec(path);
        if (m && lineItems[m[1]])
          return Response.json({
            name: 'advertisers/123/lineItems/' + m[1],
            advertiserId: '123',
            campaignId: '10',
            insertionOrderId: '20',
            lineItemId: m[1],
            ...lineItems[m[1]],
          });
        m = /^\/v4\/advertisers\/123\/adGroups\/(\d+)$/.exec(path);
        if (m && adGroups.has(m[1])) return Response.json(shown(m[1], adGroups.get(m[1])));
        return Response.json({error: {code: 404, message: 'Not found', status: 'NOT_FOUND'}}, {status: 404});
      }
      writes++;
      if (method === 'POST' && path === '/v4/advertisers/123/adGroups') {
        const id = String(next++);
        adGroups.set(id, structuredClone(body));
        return Response.json(shown(id, body));
      }
      const m = /^\/v4\/advertisers\/123\/adGroups\/(\d+)$/.exec(path);
      if (m && method === 'PATCH') {
        const g = adGroups.get(m[1]);
        if (mode !== 'ignore')
          for (const f of u.searchParams.get('updateMask').split(',')) g[f] = structuredClone(body[f]);
        return Response.json(shown(m[1], g));
      }
      if (m && method === 'DELETE') {
        if (mode !== 'ignore') adGroups.delete(m[1]);
        return Response.json({});
      }
      throw new Error('Unexpected write ' + method + ' ' + path);
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
  const create = adGroup =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action: A + 'CREATE', params: {advertiserId: '123'}, body: adGroup}},
      actor,
    );
  const patch = (id, updateMask, adGroup) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {action: A + 'PATCH', params: {advertiserId: '123', adGroupId: id, updateMask}, body: adGroup},
      },
      actor,
    );
  const remove = id =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action: A + 'DELETE', params: {advertiserId: '123', adGroupId: id}}},
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
  return {
    store,
    calls,
    adGroups,
    lineItems,
    create,
    patch,
    remove,
    execute,
    verify,
    writes: () => writes,
    mode: m => {
      mode = m;
    },
  };
}
const group = (extra = {}) => ({
  lineItemId: '555',
  displayName: 'Shorts and in-stream',
  adGroupFormat: 'AD_GROUP_FORMAT_DEMAND_GEN',
  entityStatus: 'ENTITY_STATUS_PAUSED',
  bidStrategy: {demandGenBid: {value: '12000000'}},
  adGroupInventoryControl: {selectedInventories: {allowYoutubeStream: true, allowYoutubeShorts: true}},
  ...extra,
});
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('a paused Demand Gen ad group is created once and verifies; a bid value and activation need confirmation', async () => {
  const f = fixture();
  try {
    const p = ok(await f.create(group())),
      impact = p.data.creative_impact;
    assert.equal(impact.scope, 'demand_gen_ad_group');
    assert.equal(impact.currency, 'USD');
    assert.equal(impact.line_item.bidStrategyType, 'DEMAND_GEN_BIDDING_STRATEGY_TYPE_TARGET_CPA');
    assert.equal(impact.after.bidValue, '12000000');
    assert.match(impact.effect, /stays paused/);
    assert.equal((await f.execute(p)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal(f.writes(), 0);
    ok(await f.execute(p, {spend_change_confirmed: true}));
    assert.equal(f.writes(), 1);
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p, {spend_change_confirmed: true})).data.replayed, true);
    assert.equal(f.writes(), 1);
    const on = ok(await f.patch('910', 'entityStatus', {entityStatus: 'ENTITY_STATUS_ACTIVE'}));
    assert.equal(on.data.creative_impact.may_affect_serving, true);
    assert.equal((await f.execute(on)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    ok(await f.execute(on, {spend_change_confirmed: true}));
    assert.equal(ok(await f.verify(on)).data.status, 'verified');
    // Paused, without a bid value: no spending confirmation.
    const plain = ok(
      await f.create({
        lineItemId: '556',
        displayName: 'All Google inventory',
        adGroupFormat: 'AD_GROUP_FORMAT_DEMAND_GEN',
        entityStatus: 'ENTITY_STATUS_PAUSED',
        adGroupInventoryControl: {adGroupInventoryStrategy: 'AD_GROUP_INVENTORY_STRATEGY_ALL_GOOGLE_INVENTORY'},
      }),
    );
    ok(await f.execute(plain));
    assert.equal(ok(await f.verify(plain)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('patches carry exactly the masked fields and verify, and a deletion verifies that the ad group is gone', async () => {
  const f = fixture();
  try {
    const p = ok(
      await f.patch('901', 'displayName,targetingExpansion,productFeedData', {
        displayName: 'Renamed group',
        targetingExpansion: {enableOptimizedTargeting: true, excludeDemographicExpansion: true},
        productFeedData: {
          productMatchType: 'PRODUCT_MATCH_TYPE_CUSTOM_LABEL',
          productMatchDimensions: [{customLabel: {key: 'CUSTOM_LABEL_KEY_0', value: 'summer'}}],
        },
      }),
    );
    assert.equal(p.data.creative_impact.before.displayName, 'Existing group');
    assert.equal(p.data.creative_impact.after.displayName, 'Renamed group');
    ok(await f.execute(p));
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    const d = ok(await f.remove('901'));
    assert.match(d.data.creative_impact.effect, /Deletes/);
    ok(await f.execute(d));
    assert.equal(ok(await f.verify(d)).data.status, 'verified');
    assert.equal(f.adGroups.has('901'), false);
  } finally {
    f.store.close();
  }
});

test('malformed ad group requests fail before any request', async () => {
  for (const [label, kind, args] of [
    ['another format', 'create', group({adGroupFormat: 'AD_GROUP_FORMAT_IN_STREAM'})],
    ['no inventory control', 'create', (({adGroupInventoryControl, ...rest}) => rest)(group())],
    [
      'strategy and selected inventories',
      'create',
      group({
        adGroupInventoryControl: {
          adGroupInventoryStrategy: 'AD_GROUP_INVENTORY_STRATEGY_ALL_GOOGLE_INVENTORY',
          selectedInventories: {allowGmail: true},
        },
      }),
    ],
    ['no inventory selected', 'create', group({adGroupInventoryControl: {selectedInventories: {allowGmail: false}}})],
    [
      'bid type on an ad group',
      'create',
      group({bidStrategy: {demandGenBid: {type: 'DEMAND_GEN_BIDDING_STRATEGY_TYPE_TARGET_CPA', value: '1000000'}}}),
    ],
    ['zero bid value', 'create', group({bidStrategy: {demandGenBid: {value: '0'}}})],
    ['another bid strategy', 'create', group({bidStrategy: {fixedBid: {bidAmountMicros: '1000000'}}})],
    ['output-only ID', 'create', group({adGroupId: '5'})],
    ['long display name', 'create', group({displayName: 'x'.repeat(256)})],
    ['draft status', 'create', group({entityStatus: 'ENTITY_STATUS_DRAFT'})],
    [
      'specific products without offers',
      'create',
      group({productFeedData: {productMatchType: 'PRODUCT_MATCH_TYPE_SPECIFIC_PRODUCTS'}}),
    ],
    ['masked field missing', 'patch', ['901', 'displayName,entityStatus', {displayName: 'x'}]],
    [
      'field outside the mask',
      'patch',
      ['901', 'displayName', {displayName: 'x', entityStatus: 'ENTITY_STATUS_PAUSED'}],
    ],
    ['immutable line item', 'patch', ['901', 'lineItemId', {lineItemId: '556'}]],
    ['empty mask', 'patch', ['901', '', {displayName: 'x'}]],
  ]) {
    const f = fixture();
    try {
      const r = kind === 'create' ? await f.create(args) : await f.patch(...args);
      assert.equal(r.error?.code, 'INVALID_DV360_AD_GROUP', label + ': ' + JSON.stringify(r).slice(0, 400));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    assert.match(
      (await f.create(group({adGroupFormat: 'AD_GROUP_FORMAT_IN_STREAM'}))).error?.message ?? '',
      /Demand Gen/,
    );
  } finally {
    f.store.close();
  }
});

test('the review refuses other line item types, archived line items, unusable bid values, non-Demand Gen ad groups and unchanged patches', async () => {
  const f = fixture();
  try {
    assert.match((await f.create(group({lineItemId: '557'}))).error?.message ?? '', /LINE_ITEM_TYPE_DEMAND_GEN/);
    assert.match((await f.create(group({lineItemId: '558'}))).error?.message ?? '', /archived/);
    assert.match((await f.create(group({lineItemId: '556'}))).error?.message ?? '', /target CPA, CPC or ROAS/);
    assert.match((await f.patch('902', 'displayName', {displayName: 'x'})).error?.message ?? '', /only Demand Gen/);
    assert.match(
      (await f.patch('901', 'displayName', {displayName: 'Existing group'})).error?.message ?? '',
      /already matches/,
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('owner policies: an active ad group is an activation and a deletion is a deletion', async () => {
  const f = fixture();
  try {
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: '123',
      confirmed: true,
      policy: {allow_deletion: false, allow_activation: false},
    });
    assert.equal(
      (await f.create(group({entityStatus: 'ENTITY_STATUS_ACTIVE'}))).error?.code,
      'POLICY_ACTIVATION_FORBIDDEN',
    );
    assert.equal(
      (await f.patch('901', 'entityStatus', {entityStatus: 'ENTITY_STATUS_ACTIVE'})).error?.code,
      'POLICY_ACTIVATION_FORBIDDEN',
    );
    ok(await f.create(group()));
    ok(await f.patch('901', 'displayName', {displayName: 'Renamed'}));
    assert.equal((await f.remove('901')).error?.code, 'POLICY_DELETION_FORBIDDEN');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('an ad group changed after review stops execution, and ignored changes are inconclusive', async () => {
  const f = fixture();
  try {
    const p = ok(await f.patch('901', 'displayName', {displayName: 'Renamed'}));
    f.adGroups.get('901').displayName = 'Changed elsewhere';
    assert.equal((await f.execute(p)).error?.code, 'STATE_CHANGED');
    assert.equal(f.writes(), 0);
    f.mode('ignore');
    const q = ok(await f.patch('901', 'displayName', {displayName: 'Renamed'}));
    ok(await f.execute(q));
    const v = ok(await f.verify(q));
    assert.equal(v.data.status, 'inconclusive');
    assert.deepEqual(v.data.checks[0].changed_fields, ['/ad_group/display_name']);
    const d = ok(await f.remove('901'));
    ok(await f.execute(d));
    const w = ok(await f.verify(d));
    assert.equal(w.data.status, 'inconclusive');
  } finally {
    f.store.close();
  }
});

test('the ad group model and methods match the pinned Discovery document', () => {
  const doc = JSON.parse(readFileSync('.mirror/VENDOR/dv360-v4.json', 'utf8')).document,
    S = doc.schemas;
  assert.deepEqual(Object.keys(S.AdGroup.properties).sort(), [
    'adGroupFormat',
    'adGroupId',
    'adGroupInventoryControl',
    'advertiserId',
    'bidStrategy',
    'displayName',
    'entityStatus',
    'lineItemId',
    'name',
    'productFeedData',
    'targetingExpansion',
  ]);
  assert.ok(S.AdGroup.properties.adGroupFormat.enum.includes('AD_GROUP_FORMAT_DEMAND_GEN'));
  assert.deepEqual(Object.keys(S.SelectedInventories.properties).sort(), [...inventories].sort());
  assert.deepEqual(Object.keys(S.DemandGenBiddingStrategy.properties).sort(), [
    'effectiveBiddingValue',
    'effectiveBiddingValueSource',
    'type',
    'value',
  ]);
  const m = doc.resources.advertisers.resources.adGroups.methods;
  assert.deepEqual([m.create.httpMethod, m.create.path], ['POST', 'v4/advertisers/{+advertiserId}/adGroups']);
  assert.deepEqual(
    [m.patch.httpMethod, m.patch.path, m.patch.parameters.updateMask.location],
    ['PATCH', 'v4/advertisers/{+advertiserId}/adGroups/{+adGroupId}', 'query'],
  );
  assert.deepEqual(
    [m.delete.httpMethod, m.delete.path],
    ['DELETE', 'v4/advertisers/{+advertiserId}/adGroups/{+adGroupId}'],
  );
  for (const n of ['create', 'patch', 'delete'])
    assert.deepEqual(m[n].scopes, ['https://www.googleapis.com/auth/display-video']);
});
