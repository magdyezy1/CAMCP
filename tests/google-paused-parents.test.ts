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

test('under a serving ad group and campaign, a new keyword still starts PAUSED', async () => {
  const f = setup({ad_group: 'ENABLED', campaign: 'ENABLED'});
  try {
    const refused = await f.prepare('ENABLED');
    assert.equal(refused.error.code, 'TARGETING_PARENT_SERVING');
    assert.match(refused.error.message, /ad group ENABLED, campaign ENABLED/);
    assert.equal(refused.error.details.field, 'status');
    const paused = await f.prepare('PAUSED');
    assert.equal(paused.success, true, 'a PAUSED keyword is allowed as before');
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
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

test('ad groups and ads follow the same rule: ENABLED under a paused parent, PAUSED under a serving one', async () => {
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
    assert.equal(group.error.code, 'PARENT_SERVING');
    assert.match(group.error.message, /ad group must start PAUSED.*campaign ENABLED/);
    const refused = await serving.newAd('ENABLED');
    assert.equal(refused.error.code, 'PARENT_SERVING');
    assert.match(refused.error.message, /ad group ENABLED, campaign ENABLED/);
    assert.equal((await serving.newAdGroup('PAUSED')).success, true);
    assert.equal((await serving.newAd('PAUSED')).success, true);
    // A new campaign itself still starts PAUSED.
    assert.equal(serving.writes.length, 0);
  } finally {
    serving.store.close();
  }
});
