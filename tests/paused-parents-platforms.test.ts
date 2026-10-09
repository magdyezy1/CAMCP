import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import type {Actor, JsonObject} from '../src/types.js';

/**
 * The owner's decision 2 (2026-09-29): Google's rule that a paused parent covers its new children (item 6) now holds
 * on Snapchat, Meta and TikTok, whose child creates already read the parent in the review. An ad squad, ad set or ad
 * group may start active under a campaign the review reads as paused, and an ad under a paused ad squad, ad set or
 * ad group. Under a serving parent it still starts paused (PARENT_SERVING). Campaigns always start paused.
 */
const actor: Actor = {tenantId: 'paused-parents', userId: 'operator', role: 'operator'},
  admin: Actor = {...actor, role: 'admin'};
type Platform = 'snapchat' | 'meta' | 'tiktok';
function fixture(platform: Platform) {
  const store = new Store(':memory:', Buffer.alloc(32, 57).toString('base64')),
    gateway = platform + '_native_action',
    connection = {
      id: 'login',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: platform === 'meta' ? ['ads_management'] : [],
    };
  store.putConnection(admin, connection, {accessToken: 'synthetic'});
  // Parents observed in the account before, as an agent's earlier reads would have recorded them.
  for (const r of ['300', '200', 'campaigns/300', 'adsquads/200', 'creatives/creative-1'])
    store.rememberResource(connection, '123', r);
  const off = platform === 'tiktok' ? 'DISABLE' : 'PAUSED',
    parents = {campaign: off, child: off},
    writes: JsonObject[] = [];
  const snap = (kind: string, row: JsonObject) =>
    Response.json({
      request_status: 'SUCCESS',
      [kind]: [{sub_request_status: 'SUCCESS', [kind === 'adsquads' ? 'adsquad' : kind.slice(0, -1)]: row}],
    });
  const tiktok = (data: JsonObject) => Response.json({code: 0, message: 'OK', request_id: 'r', data});
  const transport = new NativeTransport(
    async (raw, init = {}) => {
      const url = new URL(String(raw)),
        path = url.pathname.replace('/open_api', ''),
        method = init.method ?? 'GET',
        body = init.body ? JSON.parse(String(init.body)) : undefined;
      if (method !== 'GET') writes.push({path, body});
      if (platform === 'snapchat') {
        if (method === 'GET' && path === '/v1/creatives/creative-1')
          return snap('creatives', {
            id: 'creative-1',
            ad_account_id: '123',
            type: 'SNAP_AD',
            name: 'Previously observed creative',
          });
        if (method === 'GET' && path === '/v1/campaigns/300')
          return snap('campaigns', {id: '300', ad_account_id: '123', name: 'Parent', status: parents.campaign});
        if (method === 'GET' && path === '/v1/adsquads/200')
          return snap('adsquads', {id: '200', campaign_id: '300', name: 'Squad', status: parents.child});
        if (method === 'POST' && path === '/v1/campaigns/300/adsquads')
          return snap('adsquads', {...body.adsquads[0], id: '201', campaign_id: '300'});
        if (method === 'POST' && path === '/v1/adsquads/200/ads')
          return snap('ads', {...body.ads[0], id: '101', ad_squad_id: '200'});
      }
      if (platform === 'meta') {
        if (method === 'GET' && path === '/v26.0/act_123')
          return Response.json({id: 'act_123', account_status: 1, currency: 'USD'});
        if (method === 'GET' && path === '/v26.0/300')
          return Response.json({id: '300', name: 'Parent', status: parents.campaign});
        if (method === 'GET' && path === '/v26.0/200')
          return Response.json({id: '200', name: 'Ad set', status: parents.child, campaign_id: '300'});
        if (method === 'POST') return Response.json({id: '901'});
      }
      if (platform === 'tiktok') {
        if (method === 'GET' && path === '/v1.3/advertiser/info/')
          return tiktok({
            list: [{advertiser_id: '123', currency: 'USD', timezone: 'Etc/GMT', status: 'STATUS_ENABLE'}],
          });
        if (method === 'GET' && path === '/v1.3/campaign/get/')
          return tiktok({
            list: [{campaign_id: '300', advertiser_id: '123', operation_status: parents.campaign}],
            page_info: {page: 1, page_size: 100, total_number: 1, total_page: 1},
          });
        if (method === 'GET' && path === '/v1.3/adgroup/get/')
          return tiktok({
            list: [{adgroup_id: '200', campaign_id: '300', advertiser_id: '123', operation_status: parents.child}],
            page_info: {page: 1, page_size: 100, total_number: 1, total_page: 1},
          });
        if (method === 'POST') return tiktok({adgroup_id: '901', ad_ids: ['902']});
      }
      throw new Error('Unexpected ' + platform + ' request ' + method + ' ' + path);
    },
    undefined,
    undefined,
    undefined,
    10000,
  );
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const call = (tool: string, input: JsonObject) => service.call(tool, input, actor) as Promise<JsonObject>;
  const prepare = (action: string, payload: JsonObject, path_params?: JsonObject) =>
    call('amcp_write', {
      action: 'prepare',
      gateway,
      connection_id: 'login',
      arguments: {action, account_id: '123', payload, ...(path_params ? {path_params} : {})},
    });
  const execute = (review: JsonObject) =>
    call('amcp_write', {
      action: 'execute',
      review_id: review.data.review_id,
      confirmed: true,
      spend_change_confirmed: true,
    });
  return {store, parents, writes, prepare, execute};
}
// One child create per level and platform, with its status field set by `on`.
const children: Record<
  Platform,
  {
    level: string;
    parent: 'campaign' | 'child';
    on: string;
    off: string;
    request: (s: string) => [string, JsonObject, JsonObject?];
  }[]
> = {
  snapchat: [
    {
      level: 'ad squad',
      parent: 'campaign',
      on: 'ACTIVE',
      off: 'PAUSED',
      request: status => [
        'snapchat_adsquad_create',
        {
          adsquads: [
            {
              campaign_id: '300',
              name: 'Squad',
              type: 'SNAP_ADS',
              status,
              targeting: {geos: [{country_code: 'sa'}]},
              billing_event: 'IMPRESSION',
              bid_strategy: 'AUTO_BID',
              daily_budget_micro: 20000000,
              optimization_goal: 'SWIPES',
            },
          ],
        },
        {campaign_id: '300'},
      ],
    },
    {
      level: 'ad',
      parent: 'child',
      on: 'ACTIVE',
      off: 'PAUSED',
      request: status => [
        'snapchat_ad_create',
        {ads: [{ad_squad_id: '200', name: 'Ad', type: 'SNAP_AD', creative_id: 'creative-1', status}]},
        {ad_squad_id: '200'},
      ],
    },
  ],
  meta: [
    {
      level: 'ad set',
      parent: 'campaign',
      on: 'ACTIVE',
      off: 'PAUSED',
      request: status => [
        'meta_adset_create',
        {
          name: 'Ad set',
          campaign_id: '300',
          status,
          daily_budget: 2000,
          billing_event: 'IMPRESSIONS',
          optimization_goal: 'LINK_CLICKS',
          bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
          targeting: {geo_locations: {countries: ['SA']}},
        },
      ],
    },
    {
      level: 'ad',
      parent: 'child',
      on: 'ACTIVE',
      off: 'PAUSED',
      request: status => ['meta_ad_create', {name: 'Ad', adset_id: '200', creative: {creative_id: '555'}, status}],
    },
  ],
  tiktok: [
    {
      level: 'ad group',
      parent: 'campaign',
      on: 'ENABLE',
      off: 'DISABLE',
      request: status => [
        'tiktok_adgroup_create',
        {
          advertiser_id: '123',
          campaign_id: '300',
          adgroup_name: 'Ad group',
          promotion_type: 'WEBSITE',
          placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
          location_ids: ['6252001'],
          budget_mode: 'BUDGET_MODE_DAY',
          budget: 50,
          schedule_type: 'SCHEDULE_FROM_NOW',
          schedule_start_time: '2026-10-01 00:00:00',
          optimization_goal: 'CLICK',
          billing_event: 'CPC',
          bid_type: 'BID_TYPE_NO_BID',
          operation_status: status,
        },
      ],
    },
    {
      level: 'ad',
      parent: 'child',
      on: 'ENABLE',
      off: 'DISABLE',
      request: status => [
        'tiktok_ad_create',
        {
          advertiser_id: '123',
          adgroup_id: '200',
          creatives: [
            {
              ad_name: 'Ad',
              ad_format: 'SINGLE_IMAGE',
              image_ids: ['img-1'],
              ad_text: 'Synthetic',
              call_to_action: 'LEARN_MORE',
              landing_page_url: 'https://example.test/',
              identity_type: 'CUSTOMIZED_USER',
              identity_id: '7777',
              operation_status: status,
            },
          ],
        },
      ],
    },
  ],
};
const paused: Record<Platform, string> = {snapchat: 'PAUSED', meta: 'PAUSED', tiktok: 'DISABLE'},
  serving: Record<Platform, string> = {snapchat: 'ACTIVE', meta: 'ACTIVE', tiktok: 'ENABLE'};

for (const platform of ['snapchat', 'meta', 'tiktok'] as const)
  for (const c of children[platform])
    test(`${platform}: a new ${c.level} may start ${c.on} under a paused parent, and not under a serving one`, async () => {
      const f = fixture(platform);
      try {
        f.parents[c.parent] = paused[platform];
        const covered = await f.prepare(...c.request(c.on));
        assert.equal(covered.success, true, JSON.stringify(covered).slice(0, 900));
        assert.equal(f.writes.length, 0);
        f.parents.campaign = f.parents.child = serving[platform];
        const refused = await f.prepare(...c.request(c.on));
        assert.equal(refused.error?.code, 'PARENT_SERVING', JSON.stringify(refused).slice(0, 900));
        assert.equal(refused.error.details.field, platform === 'tiktok' ? 'operation_status' : 'status');
        assert.equal(refused.error.details.parent_status, serving[platform]);
        // Starting paused is always accepted.
        const off = await f.prepare(...c.request(c.off));
        assert.equal(off.success, true, JSON.stringify(off).slice(0, 900));
        assert.equal(f.writes.length, 0);
      } finally {
        f.store.close();
      }
    });

test('snapchat: an ad squad reviewed under a paused campaign is not sent once the campaign serves', async () => {
  const f = fixture('snapchat');
  try {
    const review = await f.prepare(...children.snapchat[0]!.request('ACTIVE'));
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 900));
    f.parents.campaign = 'ACTIVE';
    const stopped = await f.execute(review);
    assert.equal(stopped.success, false);
    assert.match(stopped.error.code, /STATE_CHANGED|PARENT_SERVING/);
    assert.equal(f.writes.length, 0);
    f.parents.campaign = 'PAUSED';
    const fresh = await f.prepare(...children.snapchat[0]!.request('ACTIVE'));
    const done = await f.execute(fresh);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 900));
    assert.equal(f.writes.length, 1);
    assert.equal((f.writes[0]!.body as JsonObject).adsquads[0].status, 'ACTIVE');
  } finally {
    f.store.close();
  }
});

test('campaigns still start paused on every platform', async () => {
  for (const [platform, action, payload] of [
    ['snapchat', 'snapchat_campaign_create', {campaigns: [{name: 'C', ad_account_id: '123', status: 'ACTIVE'}]}],
    [
      'meta',
      'meta_campaign_create',
      {
        name: 'C',
        objective: 'OUTCOME_TRAFFIC',
        status: 'ACTIVE',
        special_ad_categories: [],
        is_adset_budget_sharing_enabled: false,
      },
    ],
    [
      'tiktok',
      'tiktok_campaign_create',
      {
        advertiser_id: '123',
        campaign_name: 'C',
        objective_type: 'TRAFFIC',
        budget_mode: 'BUDGET_MODE_INFINITE',
        operation_status: 'ENABLE',
      },
    ],
  ] as const) {
    const f = fixture(platform);
    try {
      const r = await f.prepare(action, payload as JsonObject);
      assert.equal(r.error?.code, 'PAUSED_CREATION_REQUIRED', platform + ' ' + JSON.stringify(r).slice(0, 600));
    } finally {
      f.store.close();
    }
  }
});

for (const platform of ['snapchat', 'meta', 'tiktok'] as const)
  test(`${platform}: an active ad under a serving parent is covered by a paused campaign, which the review reads`, async () => {
    const f = fixture(platform),
      ad = children[platform].find(c => c.level === 'ad')!;
    try {
      f.parents.child = serving[platform];
      f.parents.campaign = paused[platform];
      const covered = await f.prepare(...ad.request(ad.on));
      assert.equal(covered.success, true, JSON.stringify(covered).slice(0, 900));
      const reads = covered.data.state_reads.map((r: JsonObject) => r.path);
      assert.ok(
        reads.some((p: string) => /\/(campaigns\/300|v26\.0\/300|campaign\/get\/)$/.test(p)),
        JSON.stringify(reads),
      );
      // A paused ad reads no campaign.
      const plain = await f.prepare(...ad.request(ad.off));
      assert.equal(
        plain.data.state_reads.some((r: JsonObject) => /\/(campaigns\/300|v26\.0\/300|campaign\/get\/)$/.test(r.path)),
        false,
      );
      f.parents.campaign = serving[platform];
      const refused = await f.prepare(...ad.request(ad.on));
      assert.equal(refused.error?.code, 'PARENT_SERVING', JSON.stringify(refused).slice(0, 900));
      assert.equal(refused.error.details.campaign_status, serving[platform]);
      assert.equal(f.writes.length, 0);
    } finally {
      f.store.close();
    }
  });
