import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {planReference} from '../src/workspace-core.js';
import type {Actor, JsonObject} from '../src/types.js';
import {assertRefused} from './helpers/assert-refused.js';

/**
 * Clone on LinkedIn (batch 31): the campaign group, its campaigns and their creatives are read from the ad account
 * and become a draft plan. LinkedIn returns a new ID only in the x-restli-id header (the receipt's created_id) and a
 * child names its parent by URN, so a plan reference may carry a LinkedIn URN prefix: {$ref, prefix}. Every entity
 * is created PAUSED; nothing is sent until the plan is approved and run.
 */
const gateway = 'linkedin_native_action',
  actor: Actor = {tenantId: 'clone-linkedin', userId: 'operator', role: 'operator'},
  admin: Actor = {...actor, role: 'admin'},
  connectionId = '17171717-1717-4171-8171-171717171717',
  account = 'urn:li:sponsoredAccount:123';
const source = {
  group: {
    id: 700,
    account,
    name: 'Autumn leads',
    status: 'ACTIVE',
    runSchedule: {start: 1790000000000},
    test: false,
    backfilled: false,
    servingStatuses: ['RUNNABLE'],
    allowedCampaignTypes: ['SPONSORED_UPDATES', 'TEXT_AD'],
    changeAuditStamps: {created: {time: 1780000000000}, lastModified: {time: 1780000000000}},
    brandNewField: 'kept out',
  },
  campaign: {
    id: 456,
    account,
    campaignGroup: 'urn:li:sponsoredCampaignGroup:700',
    name: 'Autumn leads – EN',
    status: 'ACTIVE',
    type: 'SPONSORED_UPDATES',
    costType: 'CPM',
    dailyBudget: {amount: '50', currencyCode: 'USD'},
    unitCost: {amount: '10', currencyCode: 'USD'},
    locale: {country: 'US', language: 'en'},
    objectiveType: 'WEBSITE_VISIT',
    offsiteDeliveryEnabled: false,
    creativeSelection: 'OPTIMIZED',
    runSchedule: {start: 1790000000000},
    targetingCriteria: {include: {and: [{or: {'urn:li:adTargetingFacet:locations': ['urn:li:geo:103644278']}}]}},
    servingStatuses: ['RUNNABLE'],
    version: {versionTag: '3'},
    test: false,
    storyDeliveryEnabled: false,
  },
  creatives: [
    {
      id: 'urn:li:sponsoredCreative:800',
      account,
      campaign: 'urn:li:sponsoredCampaign:456',
      name: 'Autumn post',
      content: {reference: 'urn:li:share:9001'},
      intendedStatus: 'ACTIVE',
      isServing: true,
      isTest: false,
      review: {status: 'APPROVED'},
      createdAt: 1780000000000,
      createdBy: 'urn:li:person:1',
      lastModifiedAt: 1780000000000,
      lastModifiedBy: 'urn:li:person:1',
      servingHoldReasons: [],
    },
    {
      id: 'urn:li:sponsoredCreative:801',
      account,
      campaign: 'urn:li:sponsoredCampaign:456',
      name: 'No content',
      intendedStatus: 'PAUSED',
    },
  ],
};
function setup() {
  const store = new Store(':memory:', Buffer.alloc(32, 63).toString('base64'));
  store.putConnection(
    admin,
    {
      id: connectionId,
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['r_ads', 'rw_ads'],
    },
    {accessToken: 'synthetic'},
  );
  const groups = new Map<string, JsonObject>([['700', structuredClone(source.group)]]),
    campaigns = new Map<string, JsonObject>([['456', structuredClone(source.campaign)]]),
    creatives = new Map<string, JsonObject>(source.creatives.map(c => [c.id, structuredClone(c)])),
    writes: JsonObject[] = [],
    requests: string[] = [];
  let next = 900;
  const listed = (rows: JsonObject[]) =>
    Response.json({elements: rows, paging: {start: 0, count: 100, total: rows.length, links: []}, metadata: {}});
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (raw, init = {}) => {
        const url = new URL(String(raw)),
          path = url.pathname,
          method = init.method ?? 'GET',
          query = decodeURIComponent(url.search);
        requests.push(method + ' ' + path + url.search);
        assert.equal(url.origin, 'https://api.linkedin.com');
        const base = '/rest/adAccounts/123';
        if (method === 'GET') {
          if (path === base) return Response.json({id: 123, currency: 'USD', status: 'ACTIVE', type: 'BUSINESS'});
          const one = (map: Map<string, JsonObject>, key: string) =>
            map.has(key)
              ? Response.json(structuredClone(map.get(key)!))
              : Response.json({status: 404, message: 'Not found'}, {status: 404});
          let m = /^\/rest\/adAccounts\/123\/adCampaignGroups\/(\d+)$/.exec(path);
          if (m) return one(groups, m[1]!);
          m = /^\/rest\/adAccounts\/123\/adCampaigns\/(\d+)$/.exec(path);
          if (m) return one(campaigns, m[1]!);
          m = /^\/rest\/adAccounts\/123\/creatives\/(.+)$/.exec(path);
          if (m) return one(creatives, decodeURIComponent(m[1]!));
          if (path === base + '/adCampaigns' && url.searchParams.get('q') === 'search')
            return listed([...campaigns.values()].filter(c => query.includes(String(c.campaignGroup))));
          if (path === base + '/creatives' && url.searchParams.get('q') === 'criteria')
            return listed(
              [...creatives.values()].filter(
                c => query.includes(String(c.campaign) + ')') || query.includes(String(c.campaign) + ','),
              ),
            );
          if (path === base + '/adCampaignGroups' || path === base + '/adCampaigns' || path === base + '/creatives')
            return listed([]);
        }
        if (method === 'POST') {
          const body = JSON.parse(String(init.body)),
            id = String(next++);
          writes.push({path, body});
          const created = (key: string) =>
            new Response(null, {status: 201, headers: {'x-restli-id': key, 'x-linkedin-id': key}});
          if (path === base + '/adCampaignGroups') {
            groups.set(id, {...body, id: Number(id)});
            return created(id);
          }
          if (path === base + '/adCampaigns') {
            campaigns.set(id, {...body, id: Number(id)});
            return created(id);
          }
          if (path === base + '/creatives') {
            const urn = 'urn:li:sponsoredCreative:' + id;
            creatives.set(urn, {...body, id: urn, account});
            return created(urn);
          }
        }
        throw new Error('Unexpected LinkedIn request ' + method + ' ' + path + url.search);
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
      connection_id: connectionId,
      account_id: '123',
      source: {campaign_id: '700'},
      name: 'Autumn leads copy',
      ...extra,
    });
  return {store, writes, requests, groups, campaigns, creatives, call, clone};
}
const approveAndRun = async (x: ReturnType<typeof setup>, id: string) => {
  const summary = (await x.call('amcp_campaign', {action: 'approve', id})).data;
  const approved = await x.call('amcp_campaign', {
    ...summary.next_call.arguments,
    ...summary.next_call.add_after_user_approval,
  });
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 800));
  return x.call('amcp_campaign', {action: 'run', id});
};

test('a LinkedIn campaign group is cloned with its campaigns and creatives, children named by URN reference', async () => {
  const x = setup();
  try {
    const r = await x.clone();
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
    assert.deepEqual(
      r.data.steps.map((s: JsonObject) => s.id),
      ['group', 'campaign_1', 'campaign_1_creative_1'],
    );
    assert.deepEqual(r.data.clone.source, {campaign_id: '700', campaigns: 1, creatives: 2});
    const notCopied = JSON.stringify(r.data.clone.not_copied);
    assert.match(notCopied, /brandNewField/);
    assert.match(notCopied, /storyDeliveryEnabled/);
    assert.match(notCopied, /no content to reuse.*urn:li:sponsoredCreative:801/, 'a creative left out is named');
    assert.doesNotMatch(notCopied, /servingStatuses|changeAuditStamps|versionTag|"version"|isServing/);
    const plan = (await x.call('amcp_campaign', {action: 'get', id: r.data.id, detail: 'full'})).data;
    const payload = (id: string) => plan.steps.find((s: JsonObject) => s.id === id).arguments.payload;
    assert.deepEqual(payload('group'), {
      runSchedule: {start: 1790000000000},
      account,
      name: 'Autumn leads copy',
      status: 'PAUSED',
    });
    const campaign = payload('campaign_1');
    assert.deepEqual(campaign.campaignGroup, {$ref: 'group#/created_id', prefix: 'urn:li:sponsoredCampaignGroup:'});
    assert.equal(campaign.status, 'PAUSED');
    assert.equal(campaign.name, 'Autumn leads – EN');
    assert.deepEqual(campaign.dailyBudget, {amount: '50', currencyCode: 'USD'});
    assert.equal(campaign.id, undefined);
    assert.equal(campaign.version, undefined);
    const creative = payload('campaign_1_creative_1');
    assert.deepEqual(creative, {
      content: {reference: 'urn:li:share:9001'},
      name: 'Autumn post',
      campaign: {$ref: 'campaign_1#/created_id', prefix: 'urn:li:sponsoredCampaign:'},
      intendedStatus: 'PAUSED',
    });
    assert.equal(x.writes.length, 0);
  } finally {
    x.store.close();
  }
});

test('the LinkedIn clone runs once approved: each parent’s new ID becomes its child’s URN', async () => {
  const x = setup();
  try {
    const r = await x.clone();
    const ran = await approveAndRun(x, r.data.id);
    assert.equal(ran.success, true, JSON.stringify(ran).slice(0, 1200));
    assert.equal(ran.data.state, 'complete', JSON.stringify(ran.data).slice(0, 1500));
    assert.deepEqual(ran.data.run.executed, ['group', 'campaign_1', 'campaign_1_creative_1']);
    assert.equal(x.writes.length, 3);
    assert.equal(x.groups.get('900')!.status, 'PAUSED');
    assert.equal(x.campaigns.get('901')!.campaignGroup, 'urn:li:sponsoredCampaignGroup:900');
    assert.equal(x.campaigns.get('901')!.status, 'PAUSED');
    const made = x.creatives.get('urn:li:sponsoredCreative:902')!;
    assert.equal(made.campaign, 'urn:li:sponsoredCampaign:901');
    assert.equal(made.intendedStatus, 'PAUSED');
  } finally {
    x.store.close();
  }
});

test('a group LinkedIn does not return for this account is refused, and nothing is created', async () => {
  const x = setup();
  try {
    const missing = await x.clone({source: {campaign_id: '999'}});
    assert.equal(missing.error?.code, 'CLONE_SOURCE_NOT_FOUND', JSON.stringify(missing).slice(0, 600));
    const bad = await x.clone({source: {campaign_id: 'urn:li:sponsoredCampaignGroup:700'}});
    assert.equal(bad.error?.code, 'INVALID_ARGUMENT');
    assert.equal(x.store.documents(actor.tenantId, 'campaign_run').length, 0);
    assert.equal(x.writes.length, 0);
  } finally {
    x.store.close();
  }
});

test('a reference prefix is only a LinkedIn URN prefix, and only a numeric ID becomes a URN', async () => {
  assert.deepEqual(planReference({$ref: 'a#/created_id', prefix: 'urn:li:sponsoredCampaign:'}), {
    ref: 'a#/created_id',
    prefix: 'urn:li:sponsoredCampaign:',
  });
  assert.deepEqual(planReference({$ref: 'a#/data/id'}), {ref: 'a#/data/id'});
  for (const prefix of ['https://evil.test/', 'urn:li:sponsoredCampaign', 'urn:li:a:b:', 'urn:li::', '', 7])
    assert.throws(() => planReference({$ref: 'a#/created_id', prefix}), /LinkedIn URN prefix/);
  assert.throws(() => planReference({$ref: 'a#/created_id', other: 1}), /\$ref/);
  const x = setup();
  try {
    // A plan whose prefix names something else is refused before any review.
    const r = await x.clone();
    const plan = (await x.call('amcp_campaign', {action: 'get', id: r.data.id, detail: 'full'})).data;
    const keys = ['id', 'kind', 'gateway', 'connection_id', 'account_id', 'arguments', 'depends_on'];
    const bare = () =>
      plan.steps.map((s: JsonObject) =>
        Object.fromEntries(keys.filter(k => k in s).map(k => [k, structuredClone(s[k])])),
      );
    const steps = bare();
    steps[1].arguments.payload.campaignGroup = {$ref: 'group#/created_id', prefix: 'javascript:'};
    const made = await x.call('amcp_campaign', {action: 'create', name: 'Bad prefix', brief: 'Test.', steps});
    const checked = made.success ? await x.call('amcp_campaign', {action: 'preflight', id: made.data.id}) : made;
    assert.match(JSON.stringify(checked), /LinkedIn URN prefix/);
    // A referenced value that is not a bare numeric ID (here the creative URN) does not become a URN.
    const nested = bare();
    nested.push({
      id: 'after_creative',
      kind: 'write',
      gateway,
      connection_id: connectionId,
      account_id: '123',
      arguments: {
        action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_post',
        payload: {
          ...nested[1].arguments.payload,
          name: 'After creative',
          campaignGroup: {$ref: 'campaign_1_creative_1#/created_id', prefix: 'urn:li:sponsoredCampaignGroup:'},
        },
      },
      depends_on: ['campaign_1_creative_1'],
    });
    const second = await x.call('amcp_campaign', {action: 'create', name: 'URN ref', brief: 'Test.', steps: nested});
    assert.equal(second.success, true, JSON.stringify(second).slice(0, 800));
    const ran = await approveAndRun(x, second.data.id);
    assert.equal(ran.error?.code, 'INVALID_REFERENCE', JSON.stringify(ran).slice(0, 800));
    assert.match(ran.error.message, /not a numeric ID/);
    const after = (await x.call('amcp_campaign', {action: 'get', id: second.data.id, detail: 'full'})).data;
    assert.deepEqual(
      after.steps.filter((s: JsonObject) => s.status === 'verified').map((s: JsonObject) => s.id),
      ['group', 'campaign_1', 'campaign_1_creative_1'],
    );
    assert.equal(after.steps.find((s: JsonObject) => s.id === 'after_creative').review_id, undefined);
    assert.equal(x.writes.length, 3, 'the step with the bad reference was never sent');
  } finally {
    x.store.close();
  }
});

// Field fix r25-field-gclone (owner 2026-11-19): see tests/campaign-clone.test.ts.
test('a LinkedIn clone refuses source.ad_group_ids and source.languages, which only Google Search takes, instead of ignoring them', async () => {
  const x = setup();
  try {
    for (const extra of [
      {ad_group_ids: ['456']},
      {languages: ['languageConstants/1000']},
      {ad_group_ids: ['456'], languages: ['languageConstants/1000']},
    ]) {
      const r = await x.clone({source: {campaign_id: '700', ...extra}});
      assertRefused(r, 'CLONE_UNSUPPORTED', {writes: x.writes.length});
      assert.equal(r.error.details.field, 'source.' + Object.keys(extra)[0]);
      assert.deepEqual(r.error.details.unsupported, Object.keys(extra));
      assert.deepEqual(r.error.details.supported, ['campaign_id'], 'the keys the platform takes are named');
    }
    assert.equal(x.requests.length, 0, 'refused before the source was read');
    assert.equal(x.store.documents(actor.tenantId, 'campaign_run').length, 0, 'no plan was saved');
    for (const source of [
      {campaign_id: '700'},
      {campaign_id: '700', ad_group_ids: null, languages: null},
      {campaign_id: '700', note: 'unrelated'},
    ]) {
      const r = await x.clone({source});
      assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
      assert.deepEqual(r.data.clone.source, {campaign_id: '700', campaigns: 1, creatives: 2});
      assert.equal(r.data.clone.ad_groups, undefined, 'the map of ad groups is Google Search’s');
    }
  } finally {
    x.store.close();
  }
});
