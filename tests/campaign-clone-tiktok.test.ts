import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import type {Actor, JsonObject} from '../src/types.js';

/**
 * Clone on TikTok (batch 31): the campaign, its ad groups and their ads are read by campaign ID from the advertiser's
 * own lists and become a draft plan; only fields in TikTok's official create models are copied, the campaign starts
 * DISABLE and its children keep their status under it. Nothing is sent until the plan is approved and run.
 */
const gateway = 'tiktok_native_action',
  actor: Actor = {tenantId: 'clone-tiktok', userId: 'operator', role: 'operator'},
  admin: Actor = {...actor, role: 'admin'};
const source = {
  campaign: {
    campaign_id: '300',
    advertiser_id: '123',
    campaign_name: 'Spring traffic',
    objective_type: 'TRAFFIC',
    budget_mode: 'BUDGET_MODE_DAY',
    budget: 50,
    operation_status: 'ENABLE',
    secondary_status: 'CAMPAIGN_STATUS_ENABLE',
    create_time: '2026-09-01 10:00:00',
    is_smart_performance_campaign: false,
    po_number: '',
  },
  adgroup: {
    adgroup_id: '400',
    campaign_id: '300',
    advertiser_id: '123',
    adgroup_name: 'Saudi Arabia 25+',
    promotion_type: 'WEBSITE',
    placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
    location_ids: ['6252001'],
    budget_mode: 'BUDGET_MODE_DAY',
    budget: 20,
    schedule_type: 'SCHEDULE_FROM_NOW',
    schedule_start_time: '2026-10-01 00:00:00',
    optimization_goal: 'CLICK',
    billing_event: 'CPC',
    bid_type: 'BID_TYPE_NO_BID',
    operation_status: 'ENABLE',
    secondary_status: 'ADGROUP_STATUS_DELIVERY_OK',
    statistic_type: null,
  },
  ad: {
    ad_id: '500',
    adgroup_id: '400',
    campaign_id: '300',
    advertiser_id: '123',
    ad_name: 'Spring image',
    ad_format: 'SINGLE_IMAGE',
    image_ids: ['img-1'],
    ad_text: 'Spring offers',
    call_to_action: 'LEARN_MORE',
    landing_page_url: 'https://example.test/',
    identity_type: 'TT_USER',
    identity_id: '7777',
    operation_status: 'ENABLE',
    is_aco: false,
  },
};
function setup(identity = 'TT_USER') {
  const store = new Store(':memory:', Buffer.alloc(32, 61).toString('base64'));
  store.putConnection(
    admin,
    {
      id: '16161616-1616-4161-8161-161616161616',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const campaigns = new Map<string, JsonObject>([['300', source.campaign]]),
    adgroups = new Map<string, JsonObject>([['400', source.adgroup]]),
    ads = new Map<string, JsonObject>([['500', {...source.ad, identity_type: identity}]]),
    writes: JsonObject[] = [];
  let next = 900;
  const ok = (data: JsonObject) => Response.json({code: 0, message: 'OK', request_id: 'r', data});
  const page = (list: JsonObject[]) =>
    ok({list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}});
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (raw, init = {}) => {
        const url = new URL(String(raw)),
          path = url.pathname.replace('/open_api', ''),
          method = init.method ?? 'GET',
          filtering = JSON.parse(url.searchParams.get('filtering') ?? '{}');
        const match = (row: JsonObject) =>
          Object.entries(filtering).every(([k, v]) =>
            (v as string[]).map(String).includes(String(row[k.replace(/s$/, '')])),
          );
        if (method === 'GET' && path === '/v1.3/advertiser/info/')
          return page([{advertiser_id: '123', currency: 'USD', timezone: 'Etc/GMT', status: 'STATUS_ENABLE'}]);
        if (method === 'GET' && path === '/v1.3/campaign/get/') return page([...campaigns.values()].filter(match));
        if (method === 'GET' && path === '/v1.3/adgroup/get/') return page([...adgroups.values()].filter(match));
        if (method === 'GET' && path === '/v1.3/ad/get/') return page([...ads.values()].filter(match));
        if (method === 'POST') {
          const body = JSON.parse(String(init.body)),
            id = String(next++);
          writes.push({path, body});
          if (path === '/v1.3/campaign/create/') {
            campaigns.set(id, {...body, campaign_id: id});
            return ok({campaign_id: id});
          }
          if (path === '/v1.3/adgroup/create/') {
            adgroups.set(id, {...body, adgroup_id: id});
            return ok({adgroup_id: id});
          }
          if (path === '/v1.3/ad/create/') {
            const group = adgroups.get(String(body.adgroup_id))!;
            ads.set(id, {
              ...body.creatives[0],
              ad_id: id,
              adgroup_id: body.adgroup_id,
              campaign_id: group.campaign_id,
              advertiser_id: '123',
            });
            return ok({ad_ids: [id]});
          }
        }
        throw new Error('Unexpected TikTok request ' + method + ' ' + path);
      },
      undefined,
      undefined,
      undefined,
      10000,
    ),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const call = (tool: string, input: JsonObject) => service.call(tool, input, actor) as Promise<JsonObject>;
  const clone = (extra: JsonObject = {}) =>
    call('amcp_campaign', {
      action: 'clone',
      gateway,
      account_id: '123',
      source: {campaign_id: '300'},
      name: 'Spring traffic copy',
      ...extra,
    });
  return {store, writes, campaigns, adgroups, ads, call, clone};
}

test('a TikTok campaign is cloned from the advertiser’s lists, with only documented create fields', async () => {
  const x = setup();
  try {
    const r = await x.clone();
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
    assert.deepEqual(
      r.data.steps.map((s: JsonObject) => s.id),
      ['campaign', 'adgroup_1', 'adgroup_1_ad_1'],
    );
    assert.deepEqual(r.data.clone.source, {campaign_id: '300', ad_groups: 1, ads: 1});
    const notCopied = JSON.stringify(r.data.clone.not_copied);
    assert.match(notCopied, /is_smart_performance_campaign/);
    assert.match(notCopied, /is_aco/);
    assert.doesNotMatch(notCopied, /secondary_status|create_time|po_number/, 'system and empty fields are not listed');
    const plan = (await x.call('amcp_campaign', {action: 'get', id: r.data.id, detail: 'full'})).data;
    const payload = (id: string) => plan.steps.find((s: JsonObject) => s.id === id).arguments.payload;
    assert.deepEqual(payload('campaign'), {
      objective_type: 'TRAFFIC',
      budget_mode: 'BUDGET_MODE_DAY',
      budget: 50,
      advertiser_id: '123',
      campaign_name: 'Spring traffic copy',
      operation_status: 'DISABLE',
    });
    const group = payload('adgroup_1');
    assert.deepEqual(group.campaign_id, {$ref: 'campaign#/data/data/campaign_id'});
    assert.equal(group.operation_status, 'ENABLE', 'the child keeps its status under the disabled campaign');
    assert.deepEqual(group.location_ids, ['6252001']);
    assert.equal(group.adgroup_id, undefined);
    const ad = payload('adgroup_1_ad_1');
    assert.deepEqual(ad.adgroup_id, {$ref: 'adgroup_1#/data/data/adgroup_id'});
    assert.equal(ad.creatives.length, 1);
    assert.equal(ad.creatives[0].identity_id, '7777');
    assert.equal(ad.creatives[0].ad_id, undefined);
    assert.equal(x.writes.length, 0);
  } finally {
    x.store.close();
  }
});

test('the TikTok clone is approved once and runs, every entity verified', async () => {
  const x = setup();
  try {
    const r = await x.clone();
    const summary = (await x.call('amcp_campaign', r.data.next_call.arguments)).data;
    const approved = await x.call('amcp_campaign', {
      ...summary.next_call.arguments,
      ...summary.next_call.add_after_user_approval,
    });
    assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 800));
    const ran = await x.call('amcp_campaign', {action: 'run', id: r.data.id});
    assert.equal(ran.success, true, JSON.stringify(ran).slice(0, 1200));
    assert.equal(ran.data.state, 'complete', JSON.stringify(ran.data).slice(0, 1500));
    assert.deepEqual(ran.data.run.executed, ['campaign', 'adgroup_1', 'adgroup_1_ad_1']);
    assert.equal(x.writes.length, 3);
    assert.equal(x.campaigns.get('900')!.operation_status, 'DISABLE');
    assert.equal(x.adgroups.get('901')!.campaign_id, '900');
    assert.equal(x.ads.get('902')!.adgroup_id, '901');
  } finally {
    x.store.close();
  }
});

test('an ID TikTok does not list for this advertiser is refused, and nothing is created', async () => {
  const x = setup();
  try {
    const missing = await x.clone({source: {campaign_id: '999'}});
    assert.equal(missing.error?.code, 'CLONE_SOURCE_NOT_FOUND');
    const bad = await x.clone({source: {campaign_id: 'abc'}});
    assert.equal(bad.error?.code, 'INVALID_ARGUMENT');
    assert.equal(x.store.documents(actor.tenantId, 'campaign_run').length, 0);
    assert.equal(x.writes.length, 0);
  } finally {
    x.store.close();
  }
});

test('a cloned ad still meets today’s rules: a non-Spark identity on TikTok placement stops at its review', async () => {
  const x = setup('CUSTOMIZED_USER');
  try {
    const r = await x.clone();
    const summary = (await x.call('amcp_campaign', r.data.next_call.arguments)).data;
    await x.call('amcp_campaign', {...summary.next_call.arguments, ...summary.next_call.add_after_user_approval});
    const ran = await x.call('amcp_campaign', {action: 'run', id: r.data.id});
    assert.equal(ran.data.run.stopped, 'needs_attention', JSON.stringify(ran.data).slice(0, 900));
    const ad = ran.data.steps.find((s: JsonObject) => s.id === 'adgroup_1_ad_1');
    assert.equal(ad.error, 'TIKTOK_CUSTOM_IDENTITY_PLACEMENT');
    assert.equal(x.writes.length, 2, 'the ad was never sent');
  } finally {
    x.store.close();
  }
});
