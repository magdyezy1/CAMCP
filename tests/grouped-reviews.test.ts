import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import type {Actor, JsonObject} from '../src/types.js';
import {
  SNAP,
  createPlan,
  fixture,
  gateway as snapchat,
  runAll,
  squadBody,
  campaignStep,
} from './snapchat-plan-fixture.js';

/**
 * The owner's item 4 (2026-09-29): 84 negative keywords took four reviews, because a reviewed Google Ads mutation
 * takes at most 25 operations. A longer list is now one review of parts of 25, approved and executed once; each part
 * keeps its own state check, idempotency key and read-back, and execution stops at the first part that fails.
 */
const google = 'google_ads_native_action',
  actor: Actor = {tenantId: 'groups', userId: 'operator', role: 'operator'},
  admin: Actor = {...actor, role: 'admin'},
  campaign = 'customers/123/campaigns/9';
function setup({failWrite = 0} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 45).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'g',
      tenantId: actor.tenantId,
      gateway: google,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const writes: JsonObject[] = [],
    created = new Map<string, JsonObject>(),
    state = {campaign: 'PAUSED'};
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (url, init) => {
        const body = JSON.parse(String(init?.body)),
          path = new URL(String(url)).pathname;
        if (path.endsWith('googleAds:search')) {
          if (/ FROM customer /.test(body.query + ' '))
            return Response.json({results: [{customer: {id: '123', currencyCode: 'USD', timeZone: 'UTC'}}]});
          if (/ FROM campaign /.test(body.query + ' '))
            return Response.json({
              results: [
                {
                  campaign: {
                    resourceName: campaign,
                    name: 'Search',
                    status: state.campaign,
                    advertisingChannelType: 'SEARCH',
                    campaignBudget: 'customers/123/campaignBudgets/1',
                  },
                },
              ],
            });
          // Read-back returns what each create wrote.
          if (/ FROM campaign_criterion /.test(body.query + ' '))
            return Response.json({
              results: [...String(body.query).matchAll(/'(customers\/[^']+)'/g)]
                .map(m => created.get(m[1]!))
                .filter(Boolean)
                .map(c => ({campaignCriterion: c})),
            });
          return Response.json({results: []});
        }
        writes.push(body);
        if (writes.length === failWrite)
          return Response.json({error: {code: 500, message: 'Synthetic'}}, {status: 500});
        return Response.json({
          results: body.operations.map((o: JsonObject, i: number) => {
            const resourceName = 'customers/123/campaignCriteria/9~' + (writes.length * 100 + i);
            created.set(resourceName, {resourceName, ...o.create, type: 'KEYWORD'});
            return {resourceName};
          }),
        });
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
  const negatives = (n: number, extra: JsonObject = {}) =>
    Array.from({length: n}, (_, i) => ({
      create: {campaign, negative: true, keyword: {text: 'free term ' + i, matchType: 'PHRASE'}, ...extra},
    }));
  const prepare = (operations: JsonObject[]) =>
    call('amcp_write', {
      action: 'prepare',
      gateway: google,
      arguments: {
        action: 'google_ads_v23_campaign_criterion_mutate_campaign_criteria',
        account_id: '123',
        payload: {operations},
      },
    });
  return {store, service, state, writes, call, negatives, prepare};
}
const execute = (x: ReturnType<typeof setup>, review: JsonObject, extra: JsonObject = {}) =>
  x.call('amcp_write', {
    action: 'execute',
    review_id: review.data.review_id,
    confirmed: true,
    spend_change_confirmed: true,
    ...extra,
  });

test('84 negative keywords are one review of four parts, approved and executed once', async () => {
  const x = setup();
  try {
    const review = await x.prepare(x.negatives(84));
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 600));
    assert.equal(review.data.group, true);
    assert.deepEqual(
      review.data.parts.map((p: JsonObject) => p.records),
      [25, 25, 25, 9],
    );
    assert.equal(review.data.records, 84);
    // Negative keywords only narrow delivery, so they need no spend acknowledgement (WRT-07 Stage D, owner decision P5);
    // this expectation encoded the defect.
    assert.equal(review.data.execute_requirements.spend_change_confirmed ?? false, false);
    assert.equal(x.writes.length, 0);
    const done = await execute(x, review);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 600));
    assert.equal(done.data.parts.length, 4);
    assert.deepEqual(
      x.writes.map(w => w.operations.length),
      [25, 25, 25, 9],
    );
    assert.equal(
      new Set(x.writes.flatMap(w => w.operations.map((o: JsonObject) => o.create.keyword.text))).size,
      84,
      'every keyword once',
    );
    const replay = await execute(x, review);
    assert.equal(replay.data.replayed, true);
    assert.equal(x.writes.length, 4, 'a replay sends nothing');
    // The combined read-back covers every part.
    const verification = await x.call('amcp_campaign', {action: 'verify', review_id: review.data.review_id});
    assert.equal(verification.success, true, JSON.stringify(verification).slice(0, 600));
    assert.equal(verification.data.parts.length, 4);
    assert.equal(verification.data.status, 'verified', JSON.stringify(verification.data).slice(0, 600));
    assert.equal(verification.data.checks.length, 84);
  } finally {
    x.store.close();
  }
});

test('a group stops at the first part that fails and never sends it or later parts again', async () => {
  const x = setup({failWrite: 2});
  try {
    const review = await x.prepare(x.negatives(84));
    const stopped = await execute(x, review);
    assert.equal(stopped.success, false);
    assert.equal(stopped.error.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(stopped.error));
    assert.match(stopped.error.message, /Part 2 of 4.*parts 1–1 were applied.*2 later parts were not sent/);
    assert.equal(stopped.error.details.not_sent.length, 2);
    assert.equal(x.writes.length, 2);
    const again = await execute(x, review);
    assert.equal(again.error.code, 'WRITE_OUTCOME_UNCERTAIN');
    assert.equal(x.writes.length, 2, 'nothing is sent again');
  } finally {
    x.store.close();
  }
});

test('a group refused before its first part is sent leaves nothing behind', async () => {
  const x = setup();
  try {
    const review = await x.prepare(x.negatives(30));
    x.state.campaign = 'ENABLED';
    const refused = await execute(x, review);
    assert.equal(refused.error.code, 'STATE_CHANGED', JSON.stringify(refused.error));
    assert.equal(x.writes.length, 0);
    assert.equal(
      x.store.db.prepare('SELECT count(*) AS n FROM idempotency WHERE key=?').get(review.data.review_id)!.n,
      0,
    );
    // An expired group sends nothing either.
    x.state.campaign = 'PAUSED';
    const late = await x.prepare(x.negatives(30));
    x.store.db
      .prepare("UPDATE documents SET data=json_set(data,'$.expires_at',?) WHERE kind='write_review_group' AND id=?")
      .run(Date.now() - 1, late.data.review_id);
    assert.equal((await execute(x, late)).error.code, 'REVIEW_EXPIRED');
    assert.equal(x.writes.length, 0);
  } finally {
    x.store.close();
  }
});

test('lists that cannot be split are refused as before, and the size limit is named', async () => {
  const x = setup();
  try {
    // Temporary IDs link operations inside one request.
    const linked = await x.prepare(x.negatives(26, {campaign: 'customers/123/campaigns/-1'}));
    assert.equal(linked.success, false);
    assert.equal(linked.data?.group, undefined);
    const huge = await x.prepare(x.negatives(1001));
    assert.equal(huge.error.code, 'INVALID_ARGUMENT');
    assert.match(huge.error.message, /at most 1000 records.*1001/);
    const unconfirmed = await x.call('amcp_write', {
      action: 'execute',
      review_id: (await x.prepare(x.negatives(26))).data.review_id,
    });
    assert.equal(unconfirmed.error.code, 'CONFIRMATION_REQUIRED');
    assert.equal(x.writes.length, 0);
  } finally {
    x.store.close();
  }
});

test('30 Snapchat ad squads in one plan step are one review of two parts, verified together', async () => {
  const f = fixture();
  try {
    const squads = Array.from({length: 30}, (_, i) => squadBody(i + 1));
    const id = (
      await createPlan(f, [
        campaignStep(),
        {
          id: 'squads',
          kind: 'write',
          gateway: snapchat,
          connection_id: SNAP,
          account_id: 'acct1',
          depends_on: ['campaign'],
          arguments: {
            action: 'snapchat_adsquad_create',
            path_params: {campaign_id: {$ref: 'campaign#/data/campaigns/0/campaign/id'}},
            payload: {adsquads: squads},
          },
        },
      ])
    ).data.id;
    const responses = await runAll(f, id);
    const last = responses.at(-1)!.result.data;
    assert.equal(last.state, 'complete', JSON.stringify(last).slice(0, 800));
    assert.equal(last.steps.find((s: JsonObject) => s.id === 'squads').status, 'verified');
    assert.equal(last.steps.find((s: JsonObject) => s.id === 'squads').resource_count, 30);
    assert.ok(Buffer.byteLength(JSON.stringify(responses.at(-1)!.result)) <= 12 * 1024);
    assert.equal(f.writes.length, 3, 'one campaign write and two ad squad parts');
    assert.equal(f.squads.size, 30);
    // One approval for the step: two plan calls, not four.
    assert.equal(responses.filter(r => r.action === 'execute_next').length, 2);
    const groupReview = responses.find(r => r.result.data.step_id === 'squads')!.result;
    assert.deepEqual(
      groupReview.data.review.parts.map((p: JsonObject) => p.records),
      [25, 5],
    );
    assert.ok(Buffer.byteLength(JSON.stringify(groupReview)) <= 12 * 1024);
  } finally {
    f.close();
  }
});
