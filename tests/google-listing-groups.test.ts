import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {reviewedWriteFamily} from '../src/reviewed-routes.js';
import {googleAdsHooks} from '../src/google-ads-adapter.js';
import type {CompileDraft} from '../src/provider-adapter.js';
import type {CompiledRequest, JsonObject} from '../src/types.js';
import {assertRefused} from './helpers/assert-refused.js';

/**
 * Performance Max retail listing group trees (Google Ads API v23 AssetGroupListingGroupFilterService and "Listing Groups
 * for Retail", checked 2026-09-26): a valid tree has one root and subdivisions completely partitioned with an "Other" node.
 */
const gateway = 'google_ads_native_action',
  registry = new Registry(),
  actor = {tenantId: 'listing-groups', userId: 'operator', role: 'operator' as const},
  owner = {...actor, role: 'admin' as const};
const native = 'google_ads_v23_asset_group_listing_group_filter_mutate_asset_group_listing_group_filters';
const group = 'customers/123/assetGroups/500',
  node = (id: number | string, g = 500) => 'customers/123/assetGroupListingGroupFilters/' + g + '~' + id;
const create = (
  id: number | undefined,
  type: string,
  parent?: number | string,
  caseValue?: JsonObject,
  extra: JsonObject = {},
) => ({
  create: {
    ...(id === undefined ? {} : {resourceName: node(id)}),
    assetGroup: group,
    type,
    listingSource: 'SHOPPING',
    ...(parent === undefined ? {} : {parentListingGroupFilter: node(parent)}),
    ...(caseValue ? {caseValue} : {}),
    ...extra,
  },
});
const condition = (c?: string) => ({productCondition: c ? {condition: c} : {}}),
  brand = (b?: string) => ({productBrand: b ? {value: b} : {}});
/** Replaces an "all products" root with the guide's example: new, used, and other conditions split by brand. */
const replacement = () => [
  {remove: node(10)},
  create(-1, 'SUBDIVISION'),
  create(-2, 'UNIT_INCLUDED', -1, condition('NEW')),
  create(-3, 'UNIT_INCLUDED', -1, condition('USED')),
  create(-4, 'SUBDIVISION', -1, condition()),
  create(-5, 'UNIT_INCLUDED', -4, brand('CoolBrand')),
  create(-6, 'UNIT_EXCLUDED', -4, brand('CheapBrand')),
  create(-7, 'UNIT_INCLUDED', -4, brand()),
];
function fixture(tree: JsonObject[] = [{resourceName: node(10), type: 'UNIT_INCLUDED', listingSource: 'SHOPPING'}]) {
  const store = new Store(':memory:', Buffer.alloc(32, 84).toString('base64')),
    calls: JsonObject[] = [];
  const connection = {
      id: 'g',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Google Ads',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    credentials = {accessToken: 'synthetic', developerToken: 'synthetic'};
  store.putConnection(owner, connection, credentials);
  const groups: Record<string, JsonObject> = {
    [group]: {status: 'PAUSED', campaign: 'customers/123/campaigns/40'},
    'customers/123/assetGroups/501': {status: 'PAUSED', campaign: 'customers/123/campaigns/41'},
  };
  const campaigns: Record<string, JsonObject> = {
    'customers/123/campaigns/40': {
      status: 'PAUSED',
      advertisingChannelType: 'PERFORMANCE_MAX',
      shoppingSetting: {merchantId: '999'},
    },
    'customers/123/campaigns/41': {status: 'PAUSED', advertisingChannelType: 'PERFORMANCE_MAX'},
  };
  let nodes = new Map<string, JsonObject>(tree.map(n => [String(n.resourceName), {assetGroup: group, ...n}]));
  let next = 100,
    writes = 0,
    mode = '';
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(async (url, init) => {
      const path = new URL(String(url)).pathname,
        b = JSON.parse(String(init?.body));
      calls.push({path, body: b});
      if (path === '/v25/customers/123/googleAds:search') {
        const entity = b.query.match(/ FROM ([a-z_]+)/)[1],
          target = b.query.match(/'(customers\/[^']+)'/)[1];
        if (entity === 'asset_group') {
          const g = groups[target];
          return Response.json({
            ...(g
              ? {
                  results: [
                    {
                      assetGroup: {resourceName: target, ...g},
                      campaign: {resourceName: g.campaign, ...campaigns[g.campaign]},
                    },
                  ],
                }
              : {}),
            fieldMask: 'asset_group.resource_name',
          });
        }
        assert.equal(entity, 'asset_group_listing_group_filter');
        const rows: JsonObject[] = [...nodes.values()]
          .filter(n => n.assetGroup === target)
          .map(n => ({
            assetGroupListingGroupFilter: {...structuredClone(n), id: String(n.resourceName).split('~')[1]},
          }));
        if (mode === 'foreign')
          rows.push({
            assetGroupListingGroupFilter: {
              resourceName: node(77, 501),
              assetGroup: 'customers/123/assetGroups/501',
              type: 'UNIT_INCLUDED',
              listingSource: 'SHOPPING',
              id: '77',
            },
          });
        return Response.json({
          ...(rows.length ? {results: rows} : {}),
          fieldMask: 'asset_group_listing_group_filter.resource_name',
          ...(mode === 'page' ? {nextPageToken: 'more'} : {}),
        });
      }
      assert.equal(path, '/v25/customers/123/assetGroupListingGroupFilters:mutate');
      writes++;
      const temp = new Map<string, string>(),
        results: JsonObject[] = [];
      for (const op of b.operations) {
        if (op.remove) {
          assert.ok(
            ![...nodes.values()].some(n => n.parentListingGroupFilter === op.remove),
            'Google refuses removing a parent before its children',
          );
          nodes.delete(op.remove);
          results.push({resourceName: op.remove});
          continue;
        }
        const c = op.create,
          name = node(next++),
          parent = c.parentListingGroupFilter
            ? (temp.get(c.parentListingGroupFilter) ?? c.parentListingGroupFilter)
            : undefined;
        if (c.resourceName) temp.set(c.resourceName, name);
        nodes.set(name, {
          resourceName: name,
          assetGroup: c.assetGroup,
          type: c.type,
          listingSource: c.listingSource,
          ...(parent ? {parentListingGroupFilter: parent} : {}),
          ...(c.caseValue ? {caseValue: c.caseValue} : {}),
        });
        results.push({resourceName: name});
      }
      return Response.json({results: mode === 'short' ? results.slice(1) : results});
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const prepare = (operations: JsonObject[], extra: JsonObject = {}) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action: native, account_id: '123', payload: {operations, ...extra}}},
      actor,
    );
  const legacy = (action: string, payload: JsonObject) =>
    service.call('amcp_write', {action: 'prepare', gateway, arguments: {action, account_id: '123', payload}}, actor);
  const execute = (p: JsonObject, extra: JsonObject = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        spend_change_confirmed: true,
        ...extra,
      },
      actor,
    );
  const verify = (p: JsonObject) =>
    service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {
    store,
    calls,
    groups,
    campaigns,
    nodes: () => nodes,
    prepare,
    legacy,
    execute,
    verify,
    writes: () => writes,
    mode: (m: string) => {
      mode = m;
    },
    set: (n: JsonObject) => {
      nodes.set(String(n.resourceName), {assetGroup: group, ...n});
    },
  };
}
const split = () => [
  {resourceName: node(20), type: 'SUBDIVISION', listingSource: 'SHOPPING'},
  {
    resourceName: node(21),
    type: 'UNIT_INCLUDED',
    listingSource: 'SHOPPING',
    parentListingGroupFilter: node(20),
    caseValue: condition('NEW'),
  },
  {
    resourceName: node(22),
    type: 'UNIT_EXCLUDED',
    listingSource: 'SHOPPING',
    parentListingGroupFilter: node(20),
    caseValue: condition(),
  },
];

test('a whole tree is replaced in one review: leaves-first removal, temporary IDs, one write, verified by shape', async () => {
  const f = fixture();
  try {
    const p = await f.prepare(replacement());
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 900));
    const impact = p.data.creative_impact;
    assert.equal(impact.scope, 'pmax_listing_groups');
    assert.equal(impact.may_affect_serving, false);
    assert.deepEqual(impact.final_tree, [
      'root > productCondition=* > productBrand=* [UNIT_INCLUDED]',
      'root > productCondition=* > productBrand=cheapbrand [UNIT_EXCLUDED]',
      'root > productCondition=* > productBrand=coolbrand [UNIT_INCLUDED]',
      'root > productCondition=* [SUBDIVISION]',
      'root > productCondition=new [UNIT_INCLUDED]',
      'root > productCondition=used [UNIT_INCLUDED]',
      'root [SUBDIVISION]',
    ]);
    assert.equal((await f.execute(p, {spend_change_confirmed: false})).error.code, 'SPEND_CONFIRMATION_REQUIRED');
    const e = await f.execute(p);
    assert.equal(e.success, true, JSON.stringify(e).slice(0, 900));
    assert.equal(f.writes(), 1);
    assert.equal(f.nodes().size, 7);
    const v = await f.verify(p);
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 900));
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('the legacy create and remove aliases add and remove one product group under an existing subdivision', async () => {
  const f = fixture(split());
  try {
    const add = await f.legacy('CREATE_ASSET_GROUP_LISTING_GROUP_FILTER', {
      resource: {
        asset_group: group,
        type: 'UNIT_INCLUDED',
        listing_source: 'SHOPPING',
        parent_listing_group_filter: node(20),
        case_value: {product_condition: {condition: 'USED'}},
      },
    });
    assert.equal(add.success, true, JSON.stringify(add).slice(0, 1500));
    assert.equal((await f.execute(add)).success, true);
    assert.equal((await f.verify(add)).data.status, 'verified');
    const remove = await f.legacy('REMOVE_ASSET_GROUP_LISTING_GROUP_FILTER', {resource_name: node(21)});
    assert.equal(remove.success, true, JSON.stringify(remove).slice(0, 900));
    assert.equal((await f.execute(remove)).success, true);
    assert.equal((await f.verify(remove)).data.status, 'verified');
    assert.equal(f.writes(), 2);
    assert.ok(!f.nodes().has(node(21)));
  } finally {
    f.store.close();
  }
});

test('trees that would be invalid, and campaigns without a Merchant Center link, are refused before any write', async () => {
  const f = fixture(split());
  try {
    const cases: [string, JsonObject[], string, RegExp][] = [
      [
        'parent removed before children',
        [{remove: node(20)}, {remove: node(21)}, {remove: node(22)}],
        'INVALID_LISTING_GROUP',
        /leaves first/,
      ],
      [
        'empty final tree',
        [{remove: node(21)}, {remove: node(22)}, {remove: node(20)}],
        'INVALID_LISTING_GROUP',
        /stop serving/,
      ],
      [
        'subdivision left without a product group',
        [{remove: node(21)}],
        'INVALID_LISTING_GROUP',
        /at least one product group/,
      ],
      [
        'second "Other" node',
        [create(undefined, 'UNIT_INCLUDED', 20, condition())],
        'INVALID_LISTING_GROUP',
        /exactly one "Other"/,
      ],
      [
        'mixed dimensions',
        [create(undefined, 'UNIT_INCLUDED', 20, brand('CoolBrand'))],
        'INVALID_LISTING_GROUP',
        /same dimension/,
      ],
      [
        'repeated value, other case',
        [create(undefined, 'UNIT_INCLUDED', 20, {productCondition: {condition: 'NEW'}})],
        'INVALID_LISTING_GROUP',
        /repeats a product group/,
      ],
      ['second root', [create(-1, 'UNIT_INCLUDED')], 'INVALID_LISTING_GROUP', /already has a root/],
      [
        'child of a unit',
        [create(undefined, 'UNIT_INCLUDED', 21, brand('CoolBrand'))],
        'INVALID_LISTING_GROUP',
        /is a unit/,
      ],
      [
        'child before its parent',
        [create(undefined, 'UNIT_INCLUDED', -9, brand('CoolBrand')), create(-9, 'SUBDIVISION', 22, condition('USED'))],
        'INVALID_LISTING_GROUP',
        /create parents before their children/,
      ],
      ['absent node', [{remove: node(99)}], 'STATE_NOT_FOUND', /does not exist/],
    ];
    for (const [label, ops, code, message] of cases) {
      const r = await f.prepare(ops);
      assert.equal(r.error?.code, code, label + ': ' + JSON.stringify(r).slice(0, 400));
      assert.match(r.error.message, message, label);
    }
    f.groups[group]!.campaign = 'customers/123/campaigns/41';
    const r = await f.prepare([create(undefined, 'UNIT_INCLUDED', 20, condition('USED'))]);
    assert.equal(r.error?.code, 'INVALID_LISTING_GROUP');
    assert.match(r.error.message, /Merchant Center/);
    f.groups[group]!.campaign = 'customers/123/campaigns/40';
    f.set({
      resourceName: node(30),
      type: 'UNIT_INCLUDED',
      listingSource: 'WEBPAGE',
      parentListingGroupFilter: node(20),
      caseValue: {webpage: {}},
    });
    const web = await f.prepare([create(undefined, 'UNIT_INCLUDED', 20, condition('USED'))]);
    assert.equal(web.error?.code, 'INVALID_LISTING_GROUP');
    assert.match(web.error.message, /webpage listing groups/);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('malformed operations fail locally without network requests', async () => {
  const cases: [string, JsonObject[], JsonObject][] = [
    ['webpage source', [create(-1, 'UNIT_INCLUDED', undefined, undefined, {listingSource: 'WEBPAGE'})], {}],
    ['update', [{update: {resourceName: node(10), type: 'UNIT_EXCLUDED'}, updateMask: 'type'}], {}],
    ['validate only', [{remove: node(10)}], {validateOnly: true}],
    ['two asset groups', [{remove: node(10)}, {remove: node(11, 501)}], {}],
    ['subdivision without a temporary name', [{remove: node(10)}, create(undefined, 'SUBDIVISION')], {}],
    ['positive temporary name', [create(15, 'UNIT_INCLUDED', 20, condition('USED'))], {}],
    ['root with a case value', [create(-1, 'UNIT_INCLUDED', undefined, condition('NEW'))], {}],
    ['child without a case value', [create(undefined, 'UNIT_INCLUDED', 20)], {}],
    ['unknown dimension', [create(undefined, 'UNIT_INCLUDED', 20, {webpage: {}})], {}],
    [
      'other customer',
      [{create: {assetGroup: 'customers/999/assetGroups/500', type: 'UNIT_INCLUDED', listingSource: 'SHOPPING'}}],
      {},
    ],
    ['output-only id', [create(-1, 'UNIT_INCLUDED', undefined, undefined, {id: '5'})], {}],
    [
      'too many operations',
      Array.from({length: 501}, (_, i) => create(undefined, 'UNIT_INCLUDED', 20, brand('b' + i))),
      {},
    ],
  ];
  for (const [label, ops, extra] of cases) {
    const f = fixture();
    try {
      const r = await f.prepare(ops, extra);
      assert.ok(
        ['INVALID_LISTING_GROUP', 'INVALID_VENDOR_BODY'].includes(r.error?.code),
        label + ': ' + JSON.stringify(r).slice(0, 300),
      );
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
});

test('owner policies: removals are deletions, and an enabled asset group of an enabled campaign counts as serving', async () => {
  const f = fixture(split());
  try {
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: '123',
      confirmed: true,
      policy: {allow_deletion: false, allow_activation: true},
    });
    assert.equal(
      (await f.prepare([create(undefined, 'UNIT_INCLUDED', 20, condition('USED')), {remove: node(21)}])).error?.code,
      'POLICY_DELETION_FORBIDDEN',
    );
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: '123',
      confirmed: true,
      policy: {allow_deletion: true, allow_activation: false},
    });
    const paused = await f.prepare([create(undefined, 'UNIT_INCLUDED', 20, condition('USED'))]);
    assert.equal(paused.success, true, JSON.stringify(paused).slice(0, 300));
    assert.equal(paused.data.creative_impact.may_affect_serving, false);
    f.groups[group]!.status = 'ENABLED';
    f.campaigns['customers/123/campaigns/40']!.status = 'ENABLED';
    assert.equal(
      (await f.prepare([create(undefined, 'UNIT_INCLUDED', 20, condition('USED'))])).error?.code,
      'POLICY_ACTIVATION_FORBIDDEN',
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('a receipt missing a result is kept as a failure, never resubmitted and never verified as success', async () => {
  const f = fixture();
  try {
    const p = await f.prepare(replacement());
    assert.equal(p.success, true);
    f.mode('short');
    const first = await f.execute(p);
    assert.equal(first.success, false, JSON.stringify(first).slice(0, 600));
    const again = await f.execute(p);
    assert.equal(again.data?.replayed, true, JSON.stringify(again).slice(0, 900));
    assert.equal(f.writes(), 1);
    assert.equal((await f.verify(p)).error?.code, 'WRITE_PARTIAL_OR_FAILED');
  } finally {
    f.store.close();
  }
});

test('paged or foreign tree reads never become a complete tree, and a tree changed after review stops execution', async () => {
  for (const mode of ['page', 'foreign']) {
    const f = fixture();
    try {
      f.mode(mode);
      const r = await f.prepare(replacement());
      assert.equal(r.success, false, mode);
      assert.match(String(r.error?.code), mode === 'page' ? /INCOMPLETE_STATE/ : /STATE_TARGET_MISMATCH/);
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
  const f = fixture(split());
  try {
    const p = await f.prepare([create(undefined, 'UNIT_INCLUDED', 20, condition('USED'))]);
    assert.equal(p.success, true);
    f.set({
      resourceName: node(23),
      type: 'UNIT_INCLUDED',
      listingSource: 'SHOPPING',
      parentListingGroupFilter: node(20),
      caseValue: condition('REFURBISHED'),
    });
    assert.equal((await f.execute(p)).error?.code, 'STATE_CHANGED');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

/** The create of `ops[i]` as the caller wrote it, with its listing source taken out (the caller omits the field). */
const withoutSource = (ops: JsonObject[]): JsonObject[] =>
  ops.map(op => {
    if (!op.create) return op;
    const {listingSource: _omitted, ...rest} = op.create as JsonObject;
    return {create: rest};
  });

test('an omitted listingSource defaults to SHOPPING in the compiled request: the review shows it, the fingerprint covers it, Google receives it (R2.5 M3, G4a)', async () => {
  const f = fixture(split());
  try {
    const written = withoutSource([create(undefined, 'UNIT_INCLUDED', 20, condition('USED'))]);
    const before = JSON.stringify(written);
    const p = await f.prepare(written);
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 600));
    assert.equal(JSON.stringify(written), before, 'the caller’s own operations are not changed');
    assert.equal(p.data.request.body.operations[0].create.listingSource, 'SHOPPING', 'the review shows what is sent');
    // The default is part of the compiled request, so the request that says SHOPPING itself is the same request.
    const explicit = await f.prepare([create(undefined, 'UNIT_INCLUDED', 20, condition('USED'))]);
    assert.equal(explicit.success, true);
    assert.equal(p.data.fingerprint, explicit.data.fingerprint, 'the fingerprint covers the default');
    const e = await f.execute(p);
    assert.equal(e.success, true, JSON.stringify(e).slice(0, 600));
    const sent = f.calls.filter(c => String(c.path).endsWith(':mutate'));
    assert.equal(sent.length, 1);
    assert.equal(
      (sent[0]!.body as any).operations[0].create.listingSource,
      'SHOPPING',
      'Google receives what was reviewed',
    );
    assert.equal((await f.verify(p)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('a listingSource other than SHOPPING is still refused, and the legacy alias defaults the omitted field too (R2.5 M3, G4a)', async () => {
  const f = fixture(split());
  try {
    const web = await f.prepare([
      create(undefined, 'UNIT_INCLUDED', 20, condition('USED'), {listingSource: 'WEBPAGE'}),
    ]);
    assertRefused(web, 'INVALID_LISTING_GROUP', {writes: f.writes(), message: /listingSource must be SHOPPING/});
    const add = await f.legacy('CREATE_ASSET_GROUP_LISTING_GROUP_FILTER', {
      resource: {
        asset_group: group,
        type: 'UNIT_INCLUDED',
        parent_listing_group_filter: node(20),
        case_value: {product_condition: {condition: 'USED'}},
      },
    });
    assert.equal(add.success, true, JSON.stringify(add).slice(0, 900));
    const created = add.data.request.body.operations[0].create;
    assert.equal(created.listingSource ?? created.listing_source, 'SHOPPING');
    assert.equal((await f.execute(add)).success, true);
    assert.equal((await f.verify(add)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('a 120-operation tree named with ~-N stays one review and one mutate request: the chain is never cut into parts of 25 (R2.5 M3, G4c)', async () => {
  const f = fixture();
  try {
    const operations = [
      {remove: node(10)},
      create(-1, 'SUBDIVISION'),
      ...Array.from({length: 117}, (_, i) => create(-(i + 2), 'UNIT_INCLUDED', -1, brand('brand' + i))),
      create(-119, 'UNIT_INCLUDED', -1, brand()),
    ];
    assert.equal(operations.length, 120);
    const p = await f.prepare(operations);
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 600));
    assert.equal(p.data.group, undefined, 'one review, not a group of parts');
    assert.equal(p.data.parts, undefined);
    assert.equal(f.writes(), 0);
    const e = await f.execute(p);
    assert.equal(e.success, true, JSON.stringify(e).slice(0, 600));
    const sent = f.calls.filter(c => String(c.path).endsWith(':mutate'));
    assert.equal(sent.length, 1, 'one mutate request');
    assert.equal((sent[0]!.body as any).operations.length, 120);
    assert.equal(f.nodes().size, 119);
    assert.equal((await f.verify(p)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('the compile default reaches a tree operation of a build too, and leaves every other request and the caller’s own input alone (R2.5 M3, G4a)', () => {
  const request = googleAdsHooks.compile!.request!;
  const draft = (route: string, body: unknown) =>
    ({
      gateway,
      action: {name: 'x'},
      route,
      method: 'POST',
      query: {},
      body,
      headers: {},
      readOnly: false,
      accountId: '123',
    }) as unknown as CompileDraft;
  const buildRoute = '/v25/customers/{customer_id=*}/googleAds:mutate',
    filterRoute = '/v25/customers/{customer_id=*}/assetGroupListingGroupFilters:mutate';
  const treeOp = (extra: JsonObject = {}, key = 'asset_group_listing_group_filter_operation') => ({
    [key]: {
      create: {
        resource_name: 'customers/123/assetGroupListingGroupFilters/-7~-8',
        asset_group: 'customers/123/assetGroups/-7',
        type: 'SUBDIVISION',
        ...extra,
      },
    },
  });
  const body = {
    mutate_operations: [
      treeOp(),
      treeOp({listing_source: 'SHOPPING'}),
      {
        assetGroupListingGroupFilterOperation: {
          create: {
            resourceName: 'customers/123/assetGroupListingGroupFilters/-7~-9',
            assetGroup: 'customers/123/assetGroups/-7',
            type: 'SUBDIVISION',
          },
        },
      },
      {campaign_operation: {create: {name: 'c'}}},
    ],
  };
  const before = JSON.stringify(body);
  const d = draft(buildRoute, body);
  request(d, {}, registry);
  const ops = (d.body as any).mutate_operations;
  assert.equal(ops[0].asset_group_listing_group_filter_operation.create.listing_source, 'SHOPPING');
  assert.equal(ops[1].asset_group_listing_group_filter_operation.create.listing_source, 'SHOPPING');
  assert.equal(
    ops[2].assetGroupListingGroupFilterOperation.create.listingSource,
    'SHOPPING',
    'the spelling of the create’s own keys',
  );
  assert.deepEqual(ops[3], {campaign_operation: {create: {name: 'c'}}}, 'another operation is untouched');
  assert.equal(JSON.stringify(body), before, 'the caller’s own body is not changed');
  // A value other than SHOPPING stays for the family to refuse; a removal and another route are left as they are.
  const web = draft(filterRoute, {
    operations: [{create: {assetGroup: group, type: 'UNIT_INCLUDED', listingSource: 'WEBPAGE'}}, {remove: node(10)}],
  });
  request(web, {}, registry);
  assert.deepEqual((web.body as any).operations, [
    {create: {assetGroup: group, type: 'UNIT_INCLUDED', listingSource: 'WEBPAGE'}},
    {remove: node(10)},
  ]);
  const other = draft('/v25/customers/{customer_id=*}/campaigns:mutate', {operations: [{create: {name: 'c'}}]});
  request(other, {}, registry);
  assert.deepEqual(other.body, {operations: [{create: {name: 'c'}}]});
});

test('reads use only fields pinned from the v23 reference, and all three catalog actions are one reviewed family', async () => {
  const {googleListingGroupFields, googleListingGroupParentFields} = await import('../src/google-listing-groups.js');
  const pinned = JSON.parse(fs.readFileSync('tests/fixtures/google-listing-group-fields-v23.json', 'utf8')).resources;
  for (const f of googleListingGroupFields)
    assert.equal(pinned.asset_group_listing_group_filter.fields[f]?.selectable, true, f);
  for (const f of googleListingGroupParentFields) {
    const [resource, ...rest] = f.split('.');
    assert.equal(pinned[resource!].fields[rest.join('.')]?.selectable, true, f);
  }
  assert.ok(pinned.asset_group.attributed_resources.includes('campaign'));
  const plan = {
    gateway,
    accountId: '123',
    action: native,
    method: 'POST',
    path: '/v25/customers/123/assetGroupListingGroupFilters:mutate',
    query: {},
    headers: {},
    body: {operations: []},
    readOnly: false,
    destructive: false,
    requiresConfirmation: true,
    evidence: '',
    warnings: [],
  } as CompiledRequest;
  assert.equal(reviewedWriteFamily(plan), 'google_listing_groups');
  const rows = fs
    .readFileSync('docs/implementation/ACTION-CONTRACT-COVERAGE.csv', 'utf8')
    .split('\n')
    .filter(l => l.includes('assetGroupListingGroupFilters:mutate'));
  assert.equal(rows.length, 3);
  for (const row of rows) assert.match(row, /"reviewed_write_family","google_listing_groups"/);
});
