import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import type {JsonObject} from '../src/types.js';

/**
 * DV360 line item targeting (Display & Video 360 API v4, checked 2026-09-26): bulk edit, create and delete of assigned
 * targeting options, with complete reads of the edited types, inherited targeting, limits and advertiser-owned lists.
 */
const gateway = 'dv360_native_action',
  registry = new Registry(),
  actor = {tenantId: 'dv360-targeting', userId: 'operator', role: 'operator' as const},
  owner = {...actor, role: 'admin' as const};
const bulkAction = 'DV360_ADVERTISERS_LINE_ITEMS_BULK_EDIT_ASSIGNED_TARGETING_OPTIONS',
  oneAction = 'DV360_ADVERTISERS_LINE_ITEMS_TARGETING_TYPES_ASSIGNED_TARGETING_OPTIONS_';
/** TARGETING_TYPE_GEO_REGION → geoRegionDetails, as the provider names the union member. */
const detailsField = (type: string) =>
  type
    .slice(15)
    .toLowerCase()
    .replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()) + 'Details';
const geo = (id: string, negative?: boolean) => ({
  geoRegionDetails: {targetingOptionId: id, ...(negative === undefined ? {} : {negative})},
});
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 82).toString('base64')),
    calls: JsonObject[] = [];
  const connection = {
      id: 'dv360',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic DV360',
      scopes: ['https://www.googleapis.com/auth/display-video'],
    },
    credentials = {accessToken: 'synthetic'};
  store.putConnection(owner, connection, credentials);
  const lineItems: Record<string, JsonObject> = {
    456: {
      lineItemType: 'LINE_ITEM_TYPE_DISPLAY_DEFAULT',
      entityStatus: 'ENTITY_STATUS_PAUSED',
      displayName: 'Prospecting',
    },
    457: {
      lineItemType: 'LINE_ITEM_TYPE_VIDEO_DEFAULT',
      entityStatus: 'ENTITY_STATUS_ACTIVE',
      displayName: 'Retargeting video',
    },
    458: {
      lineItemType: 'LINE_ITEM_TYPE_YOUTUBE_AND_PARTNERS_SIMPLE',
      entityStatus: 'ENTITY_STATUS_PAUSED',
      displayName: 'YouTube',
    },
    459: {lineItemType: 'LINE_ITEM_TYPE_DISPLAY_DEFAULT', entityStatus: 'ENTITY_STATUS_ARCHIVED', displayName: 'Old'},
  };
  const owned: Record<string, JsonObject> = {
    'channels/700': {channelId: '700', advertiserId: '123', displayName: 'Blocked sites'},
    'negativeKeywordLists/800': {negativeKeywordListId: '800', advertiserId: '123', displayName: 'Brand safety'},
    'locationLists/900': {locationListId: '900', advertiserId: '123', locationType: 'TARGETING_LOCATION_TYPE_REGIONAL'},
    'locationLists/901': {
      locationListId: '901',
      advertiserId: '123',
      locationType: 'TARGETING_LOCATION_TYPE_PROXIMITY',
    },
  };
  const targeting = new Map<string, JsonObject[]>();
  let next = 5000,
    writes = 0,
    perPage = 2,
    failLineItem = '',
    foreign = false,
    cycle = false;
  const option = (lineItem: string, type: string, details: JsonObject, extra: JsonObject = {}): JsonObject => {
    const id = String(
      extra.assignedTargetingOptionId ??
        (typeof details.targetingOptionId === 'string' ? details.targetingOptionId : next++),
    );
    const shown =
      type === 'TARGETING_TYPE_GEO_REGION'
        ? {...details, displayName: 'Region ' + details.targetingOptionId, geoRegionType: 'GEO_REGION_TYPE_COUNTRY'}
        : details;
    return {
      name: 'advertisers/123/lineItems/' + lineItem + '/targetingTypes/' + type + '/assignedTargetingOptions/' + id,
      assignedTargetingOptionId: id,
      targetingType: type,
      inheritance: 'NOT_INHERITED',
      [detailsField(type)]: shown,
      ...extra,
    };
  };
  const add = (lineItem: string, o: JsonObject) => targeting.set(lineItem, [...(targeting.get(lineItem) ?? []), o]);
  for (const l of ['456', '457']) {
    add(l, option(l, 'TARGETING_TYPE_GEO_REGION', {targetingOptionId: '2840'}));
    add(
      l,
      option(
        l,
        'TARGETING_TYPE_SENSITIVE_CATEGORY_EXCLUSION',
        {excludedSensitiveCategory: 'SENSITIVE_CATEGORY_EMBEDDED_VIDEO'},
        {assignedTargetingOptionId: '1', inheritance: 'INHERITED_FROM_PARTNER'},
      ),
    );
    add(
      l,
      option(
        l,
        'TARGETING_TYPE_ENVIRONMENT',
        {environment: 'ENVIRONMENT_WEB_NOT_OPTIMIZED'},
        {assignedTargetingOptionId: '31', assignedTargetingOptionIdAlias: 'ENVIRONMENT_WEB_NOT_OPTIMIZED'},
      ),
    );
  }
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init!.method!,
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({path, method, query: u.search, body});
      const one =
        /^\/v4\/advertisers\/123\/lineItems\/(\d+)\/targetingTypes\/([A-Z_]+)\/assignedTargetingOptions(?:\/([^/]+))?$/.exec(
          path,
        );
      if (method === 'GET') {
        const li = /^\/v4\/advertisers\/123\/lineItems\/(\d+)$/.exec(path)?.[1];
        if (li && lineItems[li])
          return Response.json({
            name: 'advertisers/123/lineItems/' + li,
            advertiserId: '123',
            campaignId: '10',
            insertionOrderId: '20',
            lineItemId: li,
            ...lineItems[li],
            updateTime: new Date().toISOString(),
          });
        if (path === '/v4/advertisers/123/lineItems:bulkListAssignedTargetingOptions') {
          const ids = u.searchParams.getAll('lineItemIds'),
            types = [...String(u.searchParams.get('filter')).matchAll(/targetingType="([A-Z_]+)"/g)].map(m => m[1]!);
          assert.ok(String(u.searchParams.get('filter')).length <= 500);
          const rows = ids.flatMap(l =>
            (targeting.get(l) ?? [])
              .filter(o => types.includes(o.targetingType))
              .map(o => ({
                lineItemId: l,
                assignedTargetingOption: foreign
                  ? {...o, name: String(o.name).replace('advertisers/123/', 'advertisers/999/')}
                  : o,
              })),
          );
          const offset = Number(u.searchParams.get('pageToken') ?? 0),
            page = rows.slice(offset, offset + perPage);
          return Response.json({
            ...(page.length ? {lineItemAssignedTargetingOptions: page} : {}),
            ...(cycle || offset + perPage < rows.length ? {nextPageToken: cycle ? '0' : String(offset + perPage)} : {}),
          });
        }
        const ref = /^\/v4\/advertisers\/123\/((?:channels|negativeKeywordLists|locationLists)\/\d+)$/.exec(path)?.[1];
        if (ref && owned[ref]) return Response.json({name: 'advertisers/123/' + ref, ...owned[ref]});
        return Response.json({error: {code: 404, message: 'Not found'}}, {status: 404});
      }
      writes++;
      if (one && method === 'POST') {
        const o = option(one[1]!, one[2]!, body[detailsField(one[2]!)]);
        add(one[1]!, o);
        return Response.json(o);
      }
      if (one && method === 'DELETE') {
        const id = decodeURIComponent(one[3]!);
        targeting.set(
          one[1]!,
          (targeting.get(one[1]!) ?? []).filter(
            o =>
              !(
                o.targetingType === one[2] &&
                (o.assignedTargetingOptionId === id || o.assignedTargetingOptionIdAlias === id)
              ),
          ),
        );
        return Response.json({});
      }
      assert.equal(path, '/v4/advertisers/123/lineItems:bulkEditAssignedTargetingOptions');
      const updated: string[] = [],
        failed: string[] = [];
      for (const l of body.lineItemIds) {
        if (l === failLineItem) {
          failed.push(l);
          continue;
        }
        let rows = targeting.get(l) ?? [];
        for (const d of body.deleteRequests ?? [])
          rows = rows.filter(
            o =>
              !(
                o.targetingType === d.targetingType &&
                d.assignedTargetingOptionIds.some(
                  (id: string) => o.assignedTargetingOptionId === id || o.assignedTargetingOptionIdAlias === id,
                )
              ),
          );
        for (const c of body.createRequests ?? [])
          for (const a of c.assignedTargetingOptions)
            rows = [...rows, option(l, c.targetingType, a[detailsField(c.targetingType)])];
        targeting.set(l, rows);
        updated.push(l);
      }
      return Response.json({
        ...(updated.length ? {updatedLineItemIds: updated} : {}),
        ...(failed.length
          ? {failedLineItemIds: failed, errors: failed.map(() => ({code: 3, message: 'Synthetic line item failure'}))}
          : {}),
      });
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const bulk = (payload: JsonObject, advertiser = '123') =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action: bulkAction, params: {advertiserId: advertiser}, body: payload}},
      actor,
    );
  const create = (lineItem: string, type: string, payload: JsonObject) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action: oneAction + 'CREATE',
          params: {advertiserId: '123', lineItemId: lineItem, targetingType: type},
          body: payload,
        },
      },
      actor,
    );
  const remove = (lineItem: string, type: string, id: string) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action: oneAction + 'DELETE',
          params: {advertiserId: '123', lineItemId: lineItem, targetingType: type, assignedTargetingOptionId: id},
        },
      },
      actor,
    );
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
  const types = (l: string) =>
    (targeting.get(l) ?? []).map(o => o.targetingType + ':' + o.assignedTargetingOptionId).sort();
  return {
    store,
    calls,
    targeting,
    lineItems,
    bulk,
    create,
    remove,
    execute,
    verify,
    types,
    writes: () => writes,
    perPage: (n: number) => {
      perPage = n;
    },
    failLineItem: (l: string) => {
      failLineItem = l;
    },
    foreign: () => {
      foreign = true;
    },
    cycle: () => {
      cycle = true;
    },
    add,
    option,
  };
}
const edit = (extra: JsonObject = {}) => ({
  lineItemIds: ['456', '457'],
  deleteRequests: [
    {targetingType: 'TARGETING_TYPE_GEO_REGION', assignedTargetingOptionIds: ['2840']},
    {targetingType: 'TARGETING_TYPE_ENVIRONMENT', assignedTargetingOptionIds: ['ENVIRONMENT_WEB_NOT_OPTIMIZED']},
  ],
  createRequests: [
    {targetingType: 'TARGETING_TYPE_GEO_REGION', assignedTargetingOptions: [geo('2826'), geo('2276')]},
    {
      targetingType: 'TARGETING_TYPE_ENVIRONMENT',
      assignedTargetingOptions: [{environmentDetails: {environment: 'ENVIRONMENT_WEB_OPTIMIZED'}}],
    },
    {
      targetingType: 'TARGETING_TYPE_CHANNEL',
      assignedTargetingOptions: [{channelDetails: {channelId: '700', negative: true}}],
    },
    {
      targetingType: 'TARGETING_TYPE_NEGATIVE_KEYWORD_LIST',
      assignedTargetingOptions: [{negativeKeywordListDetails: {negativeKeywordListId: '800'}}],
    },
    {
      targetingType: 'TARGETING_TYPE_KEYWORD',
      assignedTargetingOptions: [{keywordDetails: {keyword: 'free download', negative: true}}],
    },
  ],
  ...extra,
});

test('a bulk edit reads every page of the edited types and the assigned lists, then updates both line items once and verifies', async () => {
  const f = fixture();
  try {
    const p = await f.bulk(edit());
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 800));
    const reads = f.calls.map(c => c.method + ' ' + c.path);
    assert.ok(
      reads.includes('GET /v4/advertisers/123/lineItems/456') &&
        reads.includes('GET /v4/advertisers/123/lineItems/457'),
    );
    assert.equal(
      f.calls.filter(c => String(c.path).endsWith(':bulkListAssignedTargetingOptions')).length,
      2,
      'both pages of two rows are read',
    );
    assert.ok(
      reads.includes('GET /v4/advertisers/123/channels/700') &&
        reads.includes('GET /v4/advertisers/123/negativeKeywordLists/800'),
    );
    const impact = p.data.creative_impact;
    assert.equal(impact.scope, 'line_item_targeting');
    assert.equal(impact.may_affect_serving, true);
    assert.deepEqual(
      impact.line_items.map((l: JsonObject) => [l.line_item_id, l.serving]),
      [
        ['456', false],
        ['457', true],
      ],
    );
    assert.equal((await f.execute(p, {spend_change_confirmed: false})).error.code, 'SPEND_CONFIRMATION_REQUIRED');
    const e = await f.execute(p);
    assert.equal(e.success, true, JSON.stringify(e).slice(0, 800));
    assert.equal(f.writes(), 1);
    for (const l of ['456', '457'])
      assert.deepEqual(
        f.types(l).filter(t => t.startsWith('TARGETING_TYPE_GEO_REGION')),
        ['TARGETING_TYPE_GEO_REGION:2276', 'TARGETING_TYPE_GEO_REGION:2826'],
      );
    const v = await f.verify(p);
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 800));
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('single create and delete routes review one line item and verify its complete targeting of that type', async () => {
  const f = fixture();
  try {
    const c = await f.create('456', 'TARGETING_TYPE_LANGUAGE', {languageDetails: {targetingOptionId: '1000'}});
    assert.equal(c.success, true, JSON.stringify(c).slice(0, 600));
    assert.equal((await f.execute(c)).success, true);
    assert.equal((await f.verify(c)).data.status, 'verified');
    const d = await f.remove('456', 'TARGETING_TYPE_LANGUAGE', '1000');
    assert.equal(d.success, true, JSON.stringify(d).slice(0, 600));
    assert.equal((await f.execute(d)).success, true);
    assert.equal((await f.verify(d)).data.status, 'verified');
    assert.ok(!f.types('456').some(t => t.startsWith('TARGETING_TYPE_LANGUAGE')));
    assert.equal(f.writes(), 2);
  } finally {
    f.store.close();
  }
});

test('line item type and status, inherited and absent assignments, duplicates and foreign lists are refused before any write', async () => {
  const f = fixture();
  try {
    const cases: [string, Promise<JsonObject>, string, RegExp][] = [
      ['YouTube line item', f.bulk(edit({lineItemIds: ['458']})), 'INVALID_DV360_TARGETING', /YouTube & Partners/],
      [
        'archived line item',
        f.create('459', 'TARGETING_TYPE_LANGUAGE', {languageDetails: {targetingOptionId: '1000'}}),
        'INVALID_DV360_TARGETING',
        /ARCHIVED/,
      ],
      [
        'inherited exclusion',
        f.remove('456', 'TARGETING_TYPE_SENSITIVE_CATEGORY_EXCLUSION', '1'),
        'INVALID_DV360_TARGETING',
        /INHERITED_FROM_PARTNER/,
      ],
      [
        'absent assignment',
        f.remove('456', 'TARGETING_TYPE_GEO_REGION', '2826'),
        'STATE_NOT_FOUND',
        /no TARGETING_TYPE_GEO_REGION assignment 2826/,
      ],
      [
        'duplicate region',
        f.create('456', 'TARGETING_TYPE_GEO_REGION', geo('2840')),
        'CONFIGURATION_EXISTS',
        /already has/,
      ],
      [
        'partner channel',
        f.create('456', 'TARGETING_TYPE_CHANNEL', {channelDetails: {channelId: '701', negative: true}}),
        'STATE_TARGET_MISMATCH',
        /not owned by the selected advertiser/,
      ],
      [
        'proximity list as regional',
        f.create('456', 'TARGETING_TYPE_REGIONAL_LOCATION_LIST', {
          regionalLocationListDetails: {regionalLocationListId: '901'},
        }),
        'INVALID_DV360_TARGETING',
        /TARGETING_LOCATION_TYPE_PROXIMITY/,
      ],
      [
        'mixed browser exclusion',
        f.bulk({
          lineItemIds: ['456'],
          createRequests: [
            {
              targetingType: 'TARGETING_TYPE_BROWSER',
              assignedTargetingOptions: [
                {browserDetails: {targetingOptionId: '500072'}},
                {browserDetails: {targetingOptionId: '500073', negative: true}},
              ],
            },
          ],
        }),
        'INVALID_DV360_TARGETING',
        /either targeted or excluded/,
      ],
      [
        'two viewability options',
        f.bulk({
          lineItemIds: ['456'],
          createRequests: [
            {
              targetingType: 'TARGETING_TYPE_VIEWABILITY',
              assignedTargetingOptions: [
                {viewabilityDetails: {viewability: 'VIEWABILITY_40_PERCENT_OR_MORE'}},
                {viewabilityDetails: {viewability: 'VIEWABILITY_50_PERCENT_OR_MORE'}},
              ],
            },
          ],
        }),
        'INVALID_DV360_TARGETING',
        /only one/,
      ],
    ];
    for (const [label, pending, code, message] of cases) {
      const r = await pending;
      assert.equal(r.error?.code, code, label + ': ' + JSON.stringify(r.error).slice(0, 300));
      assert.match(r.error.message, message, label);
    }
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('malformed options, unread references and other advertisers fail locally without network requests', async () => {
  for (const [label, payload, code] of [
    [
      'inventory source',
      {
        lineItemIds: ['456'],
        createRequests: [
          {
            targetingType: 'TARGETING_TYPE_INVENTORY_SOURCE',
            assignedTargetingOptions: [{inventorySourceDetails: {inventorySourceId: '1'}}],
          },
        ],
      },
      'INVALID_DV360_TARGETING',
    ],
    [
      'empty audience group',
      {
        lineItemIds: ['456'],
        createRequests: [
          {
            targetingType: 'TARGETING_TYPE_AUDIENCE_GROUP',
            assignedTargetingOptions: [{audienceGroupDetails: {includedGoogleAudienceGroup: {settings: []}}}],
          },
        ],
      },
      'INVALID_DV360_TARGETING',
    ],
    [
      'details of another type',
      {
        lineItemIds: ['456'],
        createRequests: [{targetingType: 'TARGETING_TYPE_LANGUAGE', assignedTargetingOptions: [geo('2840')]}],
      },
      'INVALID_DV360_TARGETING',
    ],
    [
      'output-only display name',
      {
        lineItemIds: ['456'],
        createRequests: [
          {
            targetingType: 'TARGETING_TYPE_GEO_REGION',
            assignedTargetingOptions: [{geoRegionDetails: {targetingOptionId: '2826', displayName: 'United Kingdom'}}],
          },
        ],
      },
      'INVALID_VENDOR_BODY',
    ],
    [
      'keyword policy exemption',
      {
        lineItemIds: ['456'],
        createRequests: [
          {
            targetingType: 'TARGETING_TYPE_KEYWORD',
            assignedTargetingOptions: [{keywordDetails: {keyword: 'insurance', exemptedPolicyNames: ['x']}}],
          },
        ],
      },
      'INVALID_DV360_TARGETING',
    ],
    [
      'eleven-word keyword',
      {
        lineItemIds: ['456'],
        createRequests: [
          {
            targetingType: 'TARGETING_TYPE_KEYWORD',
            assignedTargetingOptions: [{keywordDetails: {keyword: 'a b c d e f g h i j k'}}],
          },
        ],
      },
      'INVALID_DV360_TARGETING',
    ],
    [
      'app without platform',
      {
        lineItemIds: ['456'],
        createRequests: [
          {targetingType: 'TARGETING_TYPE_APP', assignedTargetingOptions: [{appDetails: {appId: 'com.example.app'}}]},
        ],
      },
      'INVALID_DV360_TARGETING',
    ],
    [
      'reversed hours',
      {
        lineItemIds: ['456'],
        createRequests: [
          {
            targetingType: 'TARGETING_TYPE_DAY_AND_TIME',
            assignedTargetingOptions: [
              {
                dayAndTimeDetails: {
                  dayOfWeek: 'MONDAY',
                  startHour: 18,
                  endHour: 9,
                  timeZoneResolution: 'TIME_ZONE_RESOLUTION_ADVERTISER',
                },
              },
            ],
          },
        ],
      },
      'INVALID_DV360_TARGETING',
    ],
    [
      'radius beyond 500 miles',
      {
        lineItemIds: ['456'],
        createRequests: [
          {
            targetingType: 'TARGETING_TYPE_POI',
            assignedTargetingOptions: [
              {
                poiDetails: {
                  targetingOptionId: '40741469;-74003387',
                  proximityRadiusAmount: 501,
                  proximityRadiusUnit: 'DISTANCE_UNIT_MILES',
                },
              },
            ],
          },
        ],
      },
      'INVALID_DV360_TARGETING',
    ],
    [
      'unspecified enum',
      {
        lineItemIds: ['456'],
        createRequests: [
          {
            targetingType: 'TARGETING_TYPE_GENDER',
            assignedTargetingOptions: [{genderDetails: {gender: 'GENDER_UNSPECIFIED'}}],
          },
        ],
      },
      'INVALID_DV360_TARGETING',
    ],
    [
      'YouTube-only type',
      {
        lineItemIds: ['456'],
        deleteRequests: [{targetingType: 'TARGETING_TYPE_YOUTUBE_VIDEO', assignedTargetingOptionIds: ['1']}],
      },
      'INVALID_DV360_TARGETING',
    ],
    [
      'eleven line items',
      {
        lineItemIds: Array.from({length: 11}, (_, i) => String(460 + i)),
        createRequests: [{targetingType: 'TARGETING_TYPE_GEO_REGION', assignedTargetingOptions: [geo('2826')]}],
      },
      'INVALID_DV360_TARGETING',
    ],
    [
      'numeric line item ID',
      {
        lineItemIds: [456],
        createRequests: [{targetingType: 'TARGETING_TYPE_GEO_REGION', assignedTargetingOptions: [geo('2826')]}],
      },
      'INVALID_DV360_TARGETING',
    ],
    ['empty edit', {lineItemIds: ['456']}, 'INVALID_DV360_TARGETING'],
  ] as [string, JsonObject, string][]) {
    const f = fixture();
    try {
      const r = await f.bulk(payload);
      assert.equal(r.error?.code, code, label + ': ' + JSON.stringify(r.error).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    const r = await f.bulk(edit(), '999');
    assert.equal(r.success, false, JSON.stringify(r).slice(0, 300));
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});

test('a partial bulk receipt is kept as a failure naming the failed line item, is not resubmitted and is never verified as success', async () => {
  const f = fixture();
  try {
    const p = await f.bulk(edit());
    assert.equal(p.success, true);
    f.failLineItem('457');
    const e = await f.execute(p);
    assert.equal(e.success, false, JSON.stringify(e).slice(0, 600));
    assert.match(JSON.stringify(e), /failedLineItemIds[^\]]*457/);
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
    assert.ok(f.types('456').includes('TARGETING_TYPE_GEO_REGION:2826'));
    assert.ok(f.types('457').includes('TARGETING_TYPE_GEO_REGION:2840'));
    assert.equal((await f.verify(p)).error?.code, 'WRITE_PARTIAL_OR_FAILED');
  } finally {
    f.store.close();
  }
});

test('owner policies: removals are deletions, and targeting of an active line item is refused when activation is forbidden', async () => {
  const f = fixture();
  try {
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: '123',
      confirmed: true,
      policy: {allow_deletion: false, allow_activation: true},
    });
    assert.equal((await f.remove('456', 'TARGETING_TYPE_GEO_REGION', '2840')).error?.code, 'POLICY_DELETION_FORBIDDEN');
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: '123',
      confirmed: true,
      policy: {allow_deletion: true, allow_activation: false},
    });
    assert.equal(
      (await f.create('457', 'TARGETING_TYPE_LANGUAGE', {languageDetails: {targetingOptionId: '1000'}})).error?.code,
      'POLICY_ACTIVATION_FORBIDDEN',
    );
    const paused = await f.create('456', 'TARGETING_TYPE_LANGUAGE', {languageDetails: {targetingOptionId: '1000'}});
    assert.equal(paused.success, true, JSON.stringify(paused).slice(0, 400));
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('foreign rows and repeated page tokens never become complete targeting state, and later changes stop execution', async () => {
  for (const mode of ['foreign', 'cycle']) {
    const f = fixture();
    try {
      if (mode === 'foreign') f.foreign();
      else f.cycle();
      const r = await f.bulk(edit());
      assert.equal(r.success, false, mode);
      assert.match(String(r.error?.code), mode === 'foreign' ? /STATE_TARGET_MISMATCH/ : /INCOMPLETE_STATE/);
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    const p = await f.bulk(edit());
    assert.equal(p.success, true);
    f.add('456', f.option('456', 'TARGETING_TYPE_GEO_REGION', {targetingOptionId: '2250'}));
    assert.equal((await f.execute(p)).error?.code, 'STATE_CHANGED');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('the pinned v4 Discovery document has every qualified method and a details member for every targeting type', async () => {
  const {dv360DetailsField, dv360TargetingTypes, assertDV360Targeting} =
    await import('../src/dv360-line-item-targeting.js');
  const plan = (extra: JsonObject) => ({
    gateway,
    accountId: '123',
    action: bulkAction,
    method: 'POST',
    path: '/v4/advertisers/123/lineItems:bulkEditAssignedTargetingOptions',
    query: {},
    headers: {},
    body: edit(),
    readOnly: false,
    destructive: false,
    requiresConfirmation: true,
    evidence: '',
    warnings: [],
    ...extra,
  });
  assert.doesNotThrow(() => assertDV360Targeting(plan({})));
  for (const extra of [{headers: {'X-HTTP-Method-Override': 'DELETE'}}, {query: {updateMask: 'x'}}])
    assert.throws(
      () => assertDV360Targeting(plan(extra)),
      (e: any) => e.code === 'INVALID_DV360_TARGETING',
    );
  assert.throws(
    () => assertDV360Targeting(plan({accountId: '999'})),
    (e: any) => e.code === 'ACCOUNT_SCOPE_MISMATCH',
  );
  const spec = JSON.parse(fs.readFileSync('.mirror/VENDOR/dv360-v4.json', 'utf8')).document,
    li = spec.resources.advertisers.resources.lineItems;
  assert.equal(li.methods.bulkEditAssignedTargetingOptions.httpMethod, 'POST');
  assert.equal(li.methods.bulkListAssignedTargetingOptions.httpMethod, 'GET');
  const ato = li.resources.targetingTypes.resources.assignedTargetingOptions.methods;
  assert.equal(ato.create.httpMethod, 'POST');
  assert.equal(ato.delete.httpMethod, 'DELETE');
  assert.equal(dv360TargetingTypes.length, 45);
  for (const type of dv360TargetingTypes)
    assert.ok(spec.schemas.AssignedTargetingOption.properties[dv360DetailsField(type)], type);
  const listed = String(spec.schemas.BulkEditAssignedTargetingOptionsRequest.properties.createRequests.description);
  for (const type of dv360TargetingTypes) assert.ok(listed.includes('`' + type + '`'), type);
});
