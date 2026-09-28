import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';

/**
 * DV360 Demand Gen targeting, Display & Video 360 API v4 (pinned Discovery document and "Assign targeting" of the Demand Gen
 * guide, checked 2026-09-27): ad group bulk edit, create and delete, and the documented types of Demand Gen line items.
 */
const gateway = 'dv360_native_action',
  registry = new Registry();
const actor = {tenantId: 'dv360-dg-targeting', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const G = 'DV360_ADVERTISERS_AD_GROUPS_',
  L = 'DV360_ADVERTISERS_LINE_ITEMS_TARGETING_TYPES_ASSIGNED_TARGETING_OPTIONS_';
const detailsField = type =>
  type
    .slice(15)
    .toLowerCase()
    .replace(/_([a-z])/g, (_m, c) => c.toUpperCase()) + 'Details';
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 79).toString('base64')),
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
  // Line item 555 puts location and language on its ad groups; 556 keeps them on the line item.
  const lineItems = {
    555: {
      lineItemType: 'LINE_ITEM_TYPE_DEMAND_GEN',
      entityStatus: 'ENTITY_STATUS_PAUSED',
      displayName: 'DG groups geo',
      demandGenSettings: {geoLanguageTargetingEnabled: false},
      bidStrategy: {demandGenBid: {type: 'DEMAND_GEN_BIDDING_STRATEGY_TYPE_TARGET_CPA', value: '10000000'}},
    },
    556: {
      lineItemType: 'LINE_ITEM_TYPE_DEMAND_GEN',
      entityStatus: 'ENTITY_STATUS_ACTIVE',
      displayName: 'DG line geo',
      demandGenSettings: {geoLanguageTargetingEnabled: true},
      bidStrategy: {demandGenBid: {type: 'DEMAND_GEN_BIDDING_STRATEGY_TYPE_MAXIMIZE_CLICKS'}},
    },
  };
  const adGroups = {
    901: {
      lineItemId: '555',
      displayName: 'Paused group',
      adGroupFormat: 'AD_GROUP_FORMAT_DEMAND_GEN',
      entityStatus: 'ENTITY_STATUS_PAUSED',
      adGroupInventoryControl: {adGroupInventoryStrategy: 'AD_GROUP_INVENTORY_STRATEGY_ALL_GOOGLE_INVENTORY'},
    },
    903: {
      lineItemId: '556',
      displayName: 'Active group',
      adGroupFormat: 'AD_GROUP_FORMAT_DEMAND_GEN',
      entityStatus: 'ENTITY_STATUS_ACTIVE',
      adGroupInventoryControl: {adGroupInventoryStrategy: 'AD_GROUP_INVENTORY_STRATEGY_ALL_GOOGLE_INVENTORY'},
    },
    902: {
      lineItemId: '555',
      displayName: 'In-stream',
      adGroupFormat: 'AD_GROUP_FORMAT_IN_STREAM',
      entityStatus: 'ENTITY_STATUS_PAUSED',
    },
    904: {
      lineItemId: '555',
      displayName: 'Archived group',
      adGroupFormat: 'AD_GROUP_FORMAT_DEMAND_GEN',
      entityStatus: 'ENTITY_STATUS_ARCHIVED',
      adGroupInventoryControl: {adGroupInventoryStrategy: 'AD_GROUP_INVENTORY_STRATEGY_ALL_GOOGLE_INVENTORY'},
    },
  };
  const targeting = new Map();
  let next = 7000,
    writes = 0,
    mode = '';
  const option = (level, ownerId, type, details) => {
    const id = String(next++);
    return {
      name: 'advertisers/123/' + level + '/' + ownerId + '/targetingTypes/' + type + '/assignedTargetingOptions/' + id,
      assignedTargetingOptionId: id,
      targetingType: type,
      inheritance: 'NOT_INHERITED',
      [detailsField(type)]: details,
    };
  };
  const add = (key, o) => targeting.set(key, [...(targeting.get(key) ?? []), o]);
  add(
    'adGroups/901',
    option('adGroups', '901', 'TARGETING_TYPE_AUDIENCE_GROUP', {
      includedFirstPartyAndPartnerAudienceGroups: [
        {settings: [{firstPartyAndPartnerAudienceId: '42', recency: 'RECENCY_NO_LIMIT'}]},
      ],
    }),
  );
  const types = u => [...String(u.searchParams.get('filter')).matchAll(/targetingType="([A-Z_]+)"/g)].map(m => m[1]);
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init.method,
        body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({path, method});
      if (method === 'GET') {
        if (path === '/v4/firstPartyAndPartnerAudiences/42' && u.searchParams.get('advertiserId') === '123')
          return Response.json({
            name: 'firstPartyAndPartnerAudiences/42',
            firstPartyAndPartnerAudienceId: '42',
            displayName: 'Site visitors',
            firstPartyAndPartnerAudienceType: 'TYPE_FIRST_PARTY',
            audienceType: 'ACTIVITY_BASED',
            audienceSource: 'DISPLAY_VIDEO_360',
            activeDisplayAudienceSize: '1200',
          });
        if (path === '/v4/advertisers/123')
          return Response.json({
            name: 'advertisers/123',
            advertiserId: '123',
            displayName: 'Advertiser',
            entityStatus: 'ENTITY_STATUS_ACTIVE',
            generalConfig: {currencyCode: 'USD'},
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
        if (m && adGroups[m[1]])
          return Response.json({
            name: 'advertisers/123/adGroups/' + m[1],
            advertiserId: '123',
            adGroupId: m[1],
            ...adGroups[m[1]],
          });
        if (path === '/v4/advertisers/123/adGroups:bulkListAssignedTargetingOptions') {
          const ts = types(u);
          return Response.json({
            adGroupAssignedTargetingOptions: u.searchParams
              .getAll('adGroupIds')
              .flatMap(g =>
                (targeting.get('adGroups/' + g) ?? [])
                  .filter(o => ts.includes(o.targetingType))
                  .map(o => ({adGroupId: g, assignedTargetingOption: o})),
              ),
          });
        }
        if (path === '/v4/advertisers/123/lineItems:bulkListAssignedTargetingOptions') {
          const ts = types(u);
          return Response.json({
            lineItemAssignedTargetingOptions: u.searchParams
              .getAll('lineItemIds')
              .flatMap(l =>
                (targeting.get('lineItems/' + l) ?? [])
                  .filter(o => ts.includes(o.targetingType))
                  .map(o => ({lineItemId: l, assignedTargetingOption: o})),
              ),
          });
        }
        return Response.json({error: {code: 404, message: 'Not found', status: 'NOT_FOUND'}}, {status: 404});
      }
      writes++;
      if (path === '/v4/advertisers/123/adGroups:bulkEditAssignedTargetingOptions') {
        const failed = mode === 'fail' ? body.adGroupIds.slice(1) : [];
        for (const g of body.adGroupIds) {
          if (failed.includes(g)) continue;
          const key = 'adGroups/' + g;
          for (const d of body.deleteRequests ?? [])
            targeting.set(
              key,
              (targeting.get(key) ?? []).filter(
                o =>
                  !(
                    o.targetingType === d.targetingType &&
                    d.assignedTargetingOptionIds.includes(o.assignedTargetingOptionId)
                  ),
              ),
            );
          for (const c of body.createRequests ?? [])
            for (const o of c.assignedTargetingOptions)
              add(key, option('adGroups', g, c.targetingType, o[detailsField(c.targetingType)]));
        }
        return Response.json({
          updatedAdGroupIds: body.adGroupIds.filter(g => !failed.includes(g)),
          ...(failed.length ? {failedAdGroupIds: failed, errors: [{code: 3, message: 'Invalid'}]} : {}),
        });
      }
      const one =
        /^\/v4\/advertisers\/123\/(adGroups|lineItems)\/(\d+)\/targetingTypes\/([A-Z_]+)\/assignedTargetingOptions(?:\/(\d+))?$/.exec(
          path,
        );
      if (one && method === 'POST') {
        const o = option(one[1], one[2], one[3], body[detailsField(one[3])]);
        if (mode !== 'ignore') add(one[1] + '/' + one[2], o);
        return Response.json(o);
      }
      if (one && method === 'DELETE') {
        if (mode !== 'ignore')
          targeting.set(
            one[1] + '/' + one[2],
            (targeting.get(one[1] + '/' + one[2]) ?? []).filter(o => o.assignedTargetingOptionId !== one[4]),
          );
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
  const bulk = b =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {action: G + 'BULK_EDIT_ASSIGNED_TARGETING_OPTIONS', params: {advertiserId: '123'}, body: b},
      },
      actor,
    );
  const create = (adGroupId, type, b) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action: G + 'TARGETING_TYPES_ASSIGNED_TARGETING_OPTIONS_CREATE',
          params: {advertiserId: '123', adGroupId, targetingType: type},
          body: b,
        },
      },
      actor,
    );
  const remove = (adGroupId, type, id) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action: G + 'TARGETING_TYPES_ASSIGNED_TARGETING_OPTIONS_DELETE',
          params: {advertiserId: '123', adGroupId, targetingType: type, assignedTargetingOptionId: id},
        },
      },
      actor,
    );
  const lineCreate = (lineItemId, type, b) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {action: L + 'CREATE', params: {advertiserId: '123', lineItemId, targetingType: type}, body: b},
      },
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
        spend_change_confirmed: true,
        ...extra,
      },
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {
    store,
    calls,
    targeting,
    adGroups,
    bulk,
    create,
    remove,
    lineCreate,
    execute,
    verify,
    writes: () => writes,
    mode: m => {
      mode = m;
    },
  };
}
const age = {ageRangeDetails: {ageRange: 'AGE_RANGE_25_34'}},
  channel = {youtubeChannelDetails: {channelId: 'UCsynthetic0000000000000', negative: true}};
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('a bulk edit of two Demand Gen ad groups creates an age range and a YouTube channel exclusion and verifies', async () => {
  const f = fixture();
  try {
    const p = ok(
        await f.bulk({
          adGroupIds: ['901', '903'],
          createRequests: [
            {targetingType: 'TARGETING_TYPE_AGE_RANGE', assignedTargetingOptions: [age]},
            {targetingType: 'TARGETING_TYPE_YOUTUBE_CHANNEL', assignedTargetingOptions: [channel]},
          ],
        }),
      ),
      impact = p.data.creative_impact;
    assert.equal(impact.scope, 'ad_group_targeting');
    assert.deepEqual(
      impact.ad_groups.map(g => [g.ad_group_id, g.serving]),
      [
        ['901', false],
        ['903', true],
      ],
    );
    assert.equal(impact.may_affect_serving, true);
    ok(await f.execute(p));
    assert.equal(f.writes(), 1);
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.deepEqual(
      f.targeting
        .get('adGroups/903')
        .map(o => o.targetingType)
        .sort(),
      ['TARGETING_TYPE_AGE_RANGE', 'TARGETING_TYPE_YOUTUBE_CHANNEL'],
    );
  } finally {
    f.store.close();
  }
});

test('single creates and deletes on an ad group verify, including a removed and reassigned audience group', async () => {
  const f = fixture();
  try {
    const c = ok(await f.create('901', 'TARGETING_TYPE_GENDER', {genderDetails: {gender: 'GENDER_FEMALE'}}));
    ok(await f.execute(c));
    assert.equal(ok(await f.verify(c)).data.status, 'verified');
    const audience = f.targeting.get('adGroups/901').find(o => o.targetingType === 'TARGETING_TYPE_AUDIENCE_GROUP');
    const d = ok(await f.remove('901', 'TARGETING_TYPE_AUDIENCE_GROUP', audience.assignedTargetingOptionId));
    ok(await f.execute(d));
    assert.equal(ok(await f.verify(d)).data.status, 'verified');
    const a = ok(
      await f.create('901', 'TARGETING_TYPE_AUDIENCE_GROUP', {
        audienceGroupDetails: {
          includedFirstPartyAndPartnerAudienceGroups: [
            {settings: [{firstPartyAndPartnerAudienceId: '42', recency: 'RECENCY_NO_LIMIT'}]},
          ],
        },
      }),
    );
    ok(await f.execute(a));
    assert.equal(ok(await f.verify(a)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('location and language targeting follows the line item setting', async () => {
  const f = fixture();
  try {
    const geo = {geoRegionDetails: {targetingOptionId: '2840'}};
    ok(await f.create('901', 'TARGETING_TYPE_GEO_REGION', geo));
    assert.match(
      (await f.create('903', 'TARGETING_TYPE_GEO_REGION', geo)).error?.message ?? '',
      /belongs to the line item/,
    );
    ok(await f.lineCreate('556', 'TARGETING_TYPE_GEO_REGION', geo));
    assert.match(
      (await f.lineCreate('555', 'TARGETING_TYPE_GEO_REGION', geo)).error?.message ?? '',
      /belongs to its ad groups/,
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('the YouTube and partners bid multiplier, writable since DV360 v4 revision 20260928, needs a spend confirmation', async () => {
  const f = fixture();
  try {
    const prepared = await f.lineCreate('556', 'TARGETING_TYPE_DEVICE_TYPE', {
      deviceTypeDetails: {deviceType: 'DEVICE_TYPE_COMPUTER', youtubeAndPartnersBidMultiplier: 1.5},
    });
    assert.equal(prepared.success, true, JSON.stringify(prepared));
    assert.equal(prepared.data.execute_requirements.spend_change_confirmed, true);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('Demand Gen line items and ad groups take only their documented targeting types', async () => {
  const f = fixture();
  try {
    const device = await f.create('901', 'TARGETING_TYPE_DEVICE_TYPE', {
      deviceTypeDetails: {deviceType: 'DEVICE_TYPE_COMPUTER'},
    });
    assert.equal(device.error?.code, 'INVALID_DV360_TARGETING');
    assert.equal(f.calls.length, 0);
    ok(
      await f.lineCreate('556', 'TARGETING_TYPE_DEVICE_TYPE', {
        deviceTypeDetails: {deviceType: 'DEVICE_TYPE_COMPUTER'},
      }),
    );
    assert.match(
      (await f.lineCreate('556', 'TARGETING_TYPE_AGE_RANGE', age)).error?.message ?? '',
      /not among its targeting types/,
    );
    // Demand Gen only excludes keywords, categories and placements.
    assert.match(
      (
        await f.create('901', 'TARGETING_TYPE_YOUTUBE_CHANNEL', {
          youtubeChannelDetails: {channelId: 'UCsynthetic0000000000000'},
        })
      ).error?.message ?? '',
      /only excludes/,
    );
    assert.match(
      (await f.lineCreate('556', 'TARGETING_TYPE_KEYWORD', {keywordDetails: {keyword: 'ice cream'}})).error?.message ??
        '',
      /only excludes/,
    );
    ok(await f.lineCreate('556', 'TARGETING_TYPE_KEYWORD', {keywordDetails: {keyword: 'ice cream', negative: true}}));
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('other formats, archived ad groups and oversized bulk edits are refused', async () => {
  const f = fixture();
  try {
    assert.match(
      (await f.create('902', 'TARGETING_TYPE_GENDER', {genderDetails: {gender: 'GENDER_MALE'}})).error?.message ?? '',
      /only Demand Gen/,
    );
    assert.match(
      (await f.create('904', 'TARGETING_TYPE_GENDER', {genderDetails: {gender: 'GENDER_MALE'}})).error?.message ?? '',
      /archived/,
    );
    const many = Array.from({length: 26}, (_, i) => String(1000 + i));
    const r = await f.bulk({
      adGroupIds: many,
      createRequests: [{targetingType: 'TARGETING_TYPE_AGE_RANGE', assignedTargetingOptions: [age]}],
    });
    assert.equal(r.error?.code, 'INVALID_DV360_TARGETING');
    assert.match(r.error.message, /1 to 25/);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('owner policies: targeting an active ad group counts as serving, and deletions are deletions', async () => {
  const f = fixture();
  try {
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: '123',
      confirmed: true,
      policy: {allow_deletion: false, allow_activation: false},
    });
    assert.equal(
      (await f.create('903', 'TARGETING_TYPE_GENDER', {genderDetails: {gender: 'GENDER_MALE'}})).error?.code,
      'POLICY_ACTIVATION_FORBIDDEN',
    );
    ok(await f.create('901', 'TARGETING_TYPE_GENDER', {genderDetails: {gender: 'GENDER_MALE'}}));
    const audience = f.targeting.get('adGroups/901')[0];
    assert.equal(
      (await f.remove('901', 'TARGETING_TYPE_AUDIENCE_GROUP', audience.assignedTargetingOptionId)).error?.code,
      'POLICY_DELETION_FORBIDDEN',
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('a failed ad group in a bulk response is not success, changed targeting stops execution, and ignored writes are inconclusive', async () => {
  {
    const f = fixture();
    try {
      const p = ok(
        await f.bulk({
          adGroupIds: ['901', '903'],
          createRequests: [{targetingType: 'TARGETING_TYPE_AGE_RANGE', assignedTargetingOptions: [age]}],
        }),
      );
      f.mode('fail');
      assert.equal((await f.execute(p)).success, false);
      assert.equal((await f.execute(p)).data.replayed, true);
      assert.equal(f.writes(), 1);
      assert.equal((await f.verify(p)).error?.code, 'WRITE_PARTIAL_OR_FAILED');
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    const p = ok(await f.create('901', 'TARGETING_TYPE_GENDER', {genderDetails: {gender: 'GENDER_FEMALE'}}));
    f.targeting.set('adGroups/901', [
      ...f.targeting.get('adGroups/901'),
      {
        name: 'advertisers/123/adGroups/901/targetingTypes/TARGETING_TYPE_GENDER/assignedTargetingOptions/6999',
        assignedTargetingOptionId: '6999',
        targetingType: 'TARGETING_TYPE_GENDER',
        inheritance: 'NOT_INHERITED',
        genderDetails: {gender: 'GENDER_MALE'},
      },
    ]);
    assert.equal((await f.execute(p)).error?.code, 'STATE_CHANGED');
    assert.equal(f.writes(), 0);
    f.mode('ignore');
    const q = ok(
      await f.create('901', 'TARGETING_TYPE_PARENTAL_STATUS', {
        parentalStatusDetails: {parentalStatus: 'PARENTAL_STATUS_PARENT'},
      }),
    );
    ok(await f.execute(q));
    assert.equal(ok(await f.verify(q)).data.status, 'inconclusive');
  } finally {
    f.store.close();
  }
});

test('the ad group targeting routes and models match the pinned Discovery document', () => {
  const doc = JSON.parse(readFileSync('.mirror/VENDOR/dv360-v4.json', 'utf8')).document,
    S = doc.schemas,
    g = doc.resources.advertisers.resources.adGroups;
  assert.deepEqual(
    [g.methods.bulkEditAssignedTargetingOptions.httpMethod, g.methods.bulkEditAssignedTargetingOptions.path],
    ['POST', 'v4/advertisers/{+advertiserId}/adGroups:bulkEditAssignedTargetingOptions'],
  );
  assert.equal(
    g.methods.bulkListAssignedTargetingOptions.path,
    'v4/advertisers/{+advertiserId}/adGroups:bulkListAssignedTargetingOptions',
  );
  const one = g.resources.targetingTypes.resources.assignedTargetingOptions.methods;
  assert.deepEqual([one.create.httpMethod, one.delete.httpMethod], ['POST', 'DELETE']);
  assert.deepEqual(Object.keys(S.BulkEditAdGroupAssignedTargetingOptionsRequest.properties).sort(), [
    'adGroupIds',
    'createRequests',
    'deleteRequests',
  ]);
  assert.match(S.BulkEditAdGroupAssignedTargetingOptionsRequest.properties.adGroupIds.description, /maximum of 25/);
  assert.deepEqual(Object.keys(S.BulkEditAdGroupAssignedTargetingOptionsResponse.properties).sort(), [
    'errors',
    'failedAdGroupIds',
    'updatedAdGroupIds',
  ]);
  assert.deepEqual(Object.keys(S.AdGroupAssignedTargetingOption.properties).sort(), [
    'adGroupId',
    'assignedTargetingOption',
  ]);
  for (const t of [
    'youtubeChannelDetails',
    'youtubeVideoDetails',
    'ageRangeDetails',
    'genderDetails',
    'parentalStatusDetails',
  ])
    assert.ok(S.AssignedTargetingOption.properties[t], t);
});
