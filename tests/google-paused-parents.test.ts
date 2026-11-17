import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import type {Actor, JsonObject} from '../src/types.js';

/**
 * The owner's item 6 (2026-09-29): keywords inside a paused campaign cannot serve, yet every new positive keyword had
 * to start PAUSED and be enabled in a second reviewed pass, five extra steps that protected nothing. A new positive
 * ad-group criterion may now start ENABLED when the review reads its ad group or campaign as PAUSED; under a serving
 * parent the gate stays. Enabling the parent later is its own reviewed activation.
 */
const gateway = 'google_ads_native_action',
  actor: Actor = {tenantId: 'paused-parents', userId: 'operator', role: 'operator'},
  admin: Actor = {...actor, role: 'admin'},
  adGroup = 'customers/123/adGroups/100';
function setup(parents: {ad_group: string; campaign: string}) {
  const store = new Store(':memory:', Buffer.alloc(32, 44).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'g',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const writes: JsonObject[] = [],
    queries: string[] = [];
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      const body = JSON.parse(String(init?.body)),
        path = new URL(String(url)).pathname;
      if (path.endsWith('googleAds:search')) {
        queries.push(body.query);
        if (/ FROM customer /.test(body.query + ' '))
          return Response.json({results: [{customer: {id: '123', currencyCode: 'USD', timeZone: 'UTC'}}]});
        if (/ FROM campaign /.test(body.query + ' '))
          return Response.json({
            results: [
              {
                campaign: {
                  resourceName: 'customers/123/campaigns/9',
                  status: parents.campaign,
                  campaignBudget: 'customers/123/campaignBudgets/1',
                },
              },
            ],
          });
        if (/ FROM ad_group /.test(body.query + ' '))
          return Response.json({
            results: [
              {
                adGroup: {
                  resourceName: adGroup,
                  name: 'Existing',
                  status: parents.ad_group,
                  campaign: 'customers/123/campaigns/9',
                },
                campaign: {status: parents.campaign},
              },
            ],
          });
        return Response.json({results: []});
      }
      writes.push(body);
      return Response.json({
        results: body.operations.map((_: JsonObject, i: number) => ({
          resourceName: adGroup.replace('adGroups', 'adGroupCriteria') + '~' + (200 + i),
        })),
      });
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const prepare = (status: string) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action: 'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria',
          account_id: '123',
          payload: {operations: [{create: {adGroup, status, keyword: {text: 'running shoes', matchType: 'PHRASE'}}}]},
        },
      },
      actor,
    ) as Promise<JsonObject>;
  const execute = (review: JsonObject, extra: JsonObject = {}) =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: review.data.review_id, confirmed: true, spend_change_confirmed: true, ...extra},
      actor,
    ) as Promise<JsonObject>;
  const create = (action: string, record: JsonObject) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action, account_id: '123', payload: {operations: [{create: record}]}}},
      actor,
    ) as Promise<JsonObject>;
  const newAdGroup = (status: string) =>
    create('google_ads_v23_ad_group_mutate_ad_groups', {
      name: 'Shoes',
      campaign: 'customers/123/campaigns/9',
      status,
      type: 'SEARCH_STANDARD',
      cpcBidMicros: '1000000',
    });
  const newAd = (status: string) =>
    create('google_ads_v23_ad_group_ad_mutate_ad_group_ads', {
      adGroup: 'customers/123/adGroups/100',
      status,
      ad: {
        finalUrls: ['https://example.test/'],
        responsiveSearchAd: {
          headlines: [{text: 'Running shoes'}, {text: 'Free returns'}, {text: 'New season'}],
          descriptions: [{text: 'Shoes for every run.'}, {text: 'Order today.'}],
        },
      },
    });
  return {store, parents, writes, queries, prepare, execute, newAdGroup, newAd};
}

test('a keyword may start ENABLED inside a paused campaign, in one reviewed step', async () => {
  const f = setup({ad_group: 'ENABLED', campaign: 'PAUSED'});
  try {
    const review = await f.prepare('ENABLED');
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 800));
    assert.ok(f.queries.some(q => / FROM ad_group /.test(q) && q.includes('campaign.status')));
    const done = await f.execute(review);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 800));
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0]!.operations[0].create.status, 'ENABLED');
  } finally {
    f.store.close();
  }
});

test('a paused ad group covers its keywords too', async () => {
  const f = setup({ad_group: 'PAUSED', campaign: 'ENABLED'});
  try {
    assert.equal((await f.prepare('ENABLED')).success, true);
  } finally {
    f.store.close();
  }
});

// Package r25-m3-targeting (R2.5 M3, G8, Q1, owner 2026-11-15) changed the test that was here, 'under a serving ad group and campaign, a new
// keyword still starts PAUSED': a keyword may now start ENABLED under a serving ad group and campaign, with the spend acknowledgement every
// positive criterion asks for, and only a parent whose status the review could not read still refuses. Its other half (the PAUSED keyword
// is allowed) is kept.
test('under a serving ad group and campaign, a new keyword may start ENABLED; under a parent that cannot be read it still starts PAUSED', async () => {
  const f = setup({ad_group: 'ENABLED', campaign: 'ENABLED'});
  try {
    const review = await f.prepare('ENABLED');
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 600));
    assert.equal(review.data.execute_requirements.spend_change_confirmed, true);
    assert.equal(f.writes.length, 0, 'nothing is sent while preparing');
    const done = await f.execute(review);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 600));
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0]!.operations[0].create.status, 'ENABLED');
    const paused = await f.prepare('PAUSED');
    assert.equal(paused.success, true, 'a PAUSED keyword is allowed as before');
  } finally {
    f.store.close();
  }
  // A status Google does not name reads as no status: the parent could not be read, so the keyword must start PAUSED.
  for (const parents of [
    {ad_group: 'UNSPECIFIED', campaign: 'ENABLED'},
    {ad_group: 'ENABLED', campaign: 'UNKNOWN'},
  ]) {
    const unread = setup(parents);
    try {
      const refused = await unread.prepare('ENABLED');
      assert.equal(refused.error.code, 'TARGETING_PARENT_SERVING');
      assert.match(refused.error.message, /cannot be read \(ad group \w+, campaign \w+\)/);
      assert.equal(refused.error.details.field, 'status');
      assert.equal(refused.error.details.parent_unread, true);
      assert.equal(refused.error.details.operation, 0);
      assert.equal((await unread.prepare('PAUSED')).success, true, 'a PAUSED keyword is allowed as before');
      assert.equal(unread.writes.length, 0);
    } finally {
      unread.store.close();
    }
  }
});

test('a campaign enabled between review and execution stops the ENABLED keyword', async () => {
  const f = setup({ad_group: 'ENABLED', campaign: 'PAUSED'});
  try {
    const review = await f.prepare('ENABLED');
    assert.equal(review.success, true);
    f.parents.campaign = 'ENABLED';
    const refused = await f.execute(review);
    assert.equal(refused.success, false);
    assert.ok(['TARGETING_PARENT_SERVING', 'STATE_CHANGED'].includes(refused.error.code), refused.error.code);
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

// Package r25-m3-targeting (R2.5 M3, G8, Q1) changed the serving half of this test, which was 'ad groups and ads follow the same rule: ENABLED
// under a paused parent, PAUSED under a serving one': under a serving parent they may start ENABLED too (the spend flag and the owner's
// allow_activation switch are what hold them), and only a parent the review could not read still refuses.
test('ad groups and ads follow the same rule: ENABLED under a paused or a serving parent, PAUSED under one that cannot be read', async () => {
  const paused = setup({ad_group: 'ENABLED', campaign: 'PAUSED'});
  try {
    const group = await paused.newAdGroup('ENABLED');
    assert.equal(group.success, true, JSON.stringify(group).slice(0, 600));
    const created = await paused.newAd('ENABLED');
    assert.equal(created.success, true, JSON.stringify(created).slice(0, 600));
    assert.ok(paused.queries.some(q => / FROM ad_group /.test(q) && q.includes('campaign.status')));
  } finally {
    paused.store.close();
  }
  const serving = setup({ad_group: 'ENABLED', campaign: 'ENABLED'});
  try {
    const group = await serving.newAdGroup('ENABLED');
    assert.equal(group.success, true, JSON.stringify(group).slice(0, 600));
    assert.equal(group.data.execute_requirements.spend_change_confirmed, true);
    const created = await serving.newAd('ENABLED');
    assert.equal(created.success, true, JSON.stringify(created).slice(0, 600));
    assert.equal(created.data.execute_requirements.spend_change_confirmed, true);
    assert.equal((await serving.newAdGroup('PAUSED')).success, true);
    assert.equal((await serving.newAd('PAUSED')).success, true);
    // Nothing was sent while preparing; the ENABLED ad goes out only with the spend acknowledgement (its execution is in
    // tests/google-child-activation.test.ts).
    assert.equal(serving.writes.length, 0);
    const refused = await serving.execute(created, {spend_change_confirmed: false});
    assert.equal(refused.error.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal(serving.writes.length, 0);
  } finally {
    serving.store.close();
  }
  // A parent the review could not read still refuses, naming it; a new campaign itself still starts PAUSED (the write shape).
  const unreadCampaign = setup({ad_group: 'ENABLED', campaign: 'UNSPECIFIED'});
  try {
    const group = await unreadCampaign.newAdGroup('ENABLED');
    assert.equal(group.error.code, 'PARENT_SERVING');
    assert.match(
      group.error.message,
      /ad group must start PAUSED while the status of its parent cannot be read.*campaign UNSPECIFIED/,
    );
    assert.equal(group.error.details.parent_unread, true);
    assert.equal((await unreadCampaign.newAdGroup('PAUSED')).success, true);
    assert.equal(unreadCampaign.writes.length, 0);
  } finally {
    unreadCampaign.store.close();
  }
  const unreadGroup = setup({ad_group: 'UNKNOWN', campaign: 'ENABLED'});
  try {
    const refused = await unreadGroup.newAd('ENABLED');
    assert.equal(refused.error.code, 'PARENT_SERVING');
    assert.match(refused.error.message, /ad group UNKNOWN, campaign ENABLED/);
    assert.equal(refused.error.details.parent_unread, true);
    assert.equal((await unreadGroup.newAd('PAUSED')).success, true);
    assert.equal(unreadGroup.writes.length, 0);
  } finally {
    unreadGroup.store.close();
  }
});
