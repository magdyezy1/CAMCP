import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {googleWorld} from '../dist/tests/helpers/google-write-fake.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * R2.5 M3, L5-10 (the generic locator): a refusal of a request that lists many records and names none of them cost the White Friday
 * agent a guess among 19 operations ("fieldType" was wrong in one). At inspect and prepare, when the shape check refuses a record list
 * without naming an operation, AMCP runs the same check on each record alone, in order, and adds `details.operation`: the index of the
 * first record refused with the same code. The code, the message, the status and every other detail are as they were. A refusal that
 * only the whole list makes names none; a request linked by temporary names, and a build, have no record list and are not sliced; and
 * execute never slices. Synthetic customer 123 and Snapchat account acct1.
 */
const action = 'campaign_mutate_campaigns',
  campaigns = (n, bad = []) =>
    Array.from({length: n}, (_, i) => ({
      create: {
        name: 'DNU campaign ' + i,
        status: bad.includes(i) ? 'ENABLED' : 'PAUSED',
        advertisingChannelType: 'SEARCH',
      },
    }));
const inspectOf = async (x, operations) => (await x.inspect(action, operations)).data;

test('a 19-operation Google request with one bad record names it, at inspect and at prepare, and changes nothing else of the refusal', async () => {
  const x = googleWorld();
  try {
    // What the same refusal looks like for the record alone: the code, the message and the details the locator must leave as they are.
    const alone = await x.prepare(action, campaigns(1, [0]));
    assertRefused(alone, 'PAUSED_CREATION_REQUIRED');
    assert.equal(alone.error.details.operation, undefined, 'a request of one record has no list to locate in');
    const listed = campaigns(19, [11]);
    const inspected = (await inspectOf(x, listed)).error;
    assert.equal(inspected.code, 'PAUSED_CREATION_REQUIRED');
    assert.equal(inspected.details.operation, 11);
    assert.equal(inspected.message, alone.error.message, 'the message is as it was');
    const {operation: _operation, ...rest} = inspected.details;
    assert.deepEqual(rest, alone.error.details, 'every other detail is as it was');
    const refused = await x.prepare(action, listed);
    assertRefused(refused, 'PAUSED_CREATION_REQUIRED', {writes: x.writes});
    assert.equal(refused.error.details.operation, 11);
    assert.equal(refused.error.message, alone.error.message);
    assert.equal(refused.error.category, alone.error.category);
    assert.equal(refused.error.retryable, alone.error.retryable);
    assert.deepEqual(
      Object.keys(refused.error.details).sort(),
      [...Object.keys(alone.error.details), 'operation'].sort(),
    );
    // The first of two bad records is the one named; an operation in the list that is fine is never blamed.
    const twice = (await inspectOf(x, campaigns(19, [4, 11]))).error;
    assert.equal(twice.details.operation, 4);
    // No provider was asked anything: the refusal is local.
    assert.equal(x.reads() + x.writes() + x.validations(), 0);
  } finally {
    x.store.close();
  }
});

test('a refusal that only the whole list makes names no operation', async () => {
  const x = googleWorld();
  try {
    // partial_failure is a field of the request, not of a record: every one-record slice would be refused for it too.
    const answer = await x.call('amcp_write', {
      action: 'inspect',
      gateway: 'google_ads_native_action',
      arguments: {
        action: 'google_ads_v23_' + action,
        account_id: '123',
        payload: {operations: campaigns(19), partial_failure: true},
      },
    });
    assert.equal(answer.data.error.code, 'WRITE_CONTRACT_UNAVAILABLE', JSON.stringify(answer.data.error).slice(0, 300));
    assert.equal(
      answer.data.error.details.operation,
      undefined,
      'it is the request that is refused, not a record of it',
    );
    // Neither does the limit of 25: it is the length of the list.
    const long = (await x.inspect(action, campaigns(30))).data;
    assert.equal(long.error.code, 'WRITE_CONTRACT_UNAVAILABLE');
    assert.equal(long.error.details.operation, undefined);
    // A valid list is accepted, as it was.
    assert.equal((await x.inspect(action, campaigns(19))).data.review_contract_supported, true);
  } finally {
    x.store.close();
  }
});

test('a refusal that already names its operation is left as it is', async () => {
  const x = googleWorld();
  try {
    const criteria = Array.from({length: 19}, (_, i) => ({
      create: {
        adGroup: 'customers/123/adGroups/100',
        negative: true,
        keyword: i === 7 ? {matchType: 'BROAD'} : {text: 'free ' + i, matchType: 'BROAD'},
      },
    }));
    const answer = (await x.inspect('ad_group_criterion_mutate_ad_group_criteria', criteria)).data;
    assert.equal(answer.error.code, 'INVALID_TARGETING_MUTATION');
    assert.equal(answer.error.details.operation, 7, 'the module names it; the locator did not run');
    assert.equal(answer.error.details.field, 'operations[7].create.keyword.text');
  } finally {
    x.store.close();
  }
});

test('a request linked by temporary names is not sliced', async () => {
  const x = googleWorld();
  try {
    // Operation 0 creates a campaign under a temporary name that later operations could name: googleBatch refuses to split it.
    const linked = campaigns(19, [5]);
    linked[0].create.resourceName = 'customers/123/campaigns/-1';
    const answer = (await inspectOf(x, linked)).error;
    assert.equal(answer.code, 'PAUSED_CREATION_REQUIRED', JSON.stringify(answer).slice(0, 300));
    assert.equal(answer.details.operation, undefined, 'a record of a linked request cannot be checked alone');
  } finally {
    x.store.close();
  }
});

test('execute never slices: a refusal at execute is the one the stored request gives, with no operation added', async () => {
  const x = googleWorld();
  try {
    const review = await x.prepare(action, campaigns(19));
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 400));
    // The stored request is tampered with, as nothing but a corrupted store could: execute refuses its shape again, unsliced.
    const stored = x.store.document('google-world', 'write_review', review.data.review_id);
    stored.plan.body.operations[11].create.status = 'ENABLED';
    x.store.putDocument('google-world', 'write_review', review.data.review_id, stored);
    const refused = await x.execute(review);
    assertRefused(refused, 'PAUSED_CREATION_REQUIRED', {writes: x.writes});
    assert.equal(refused.error.details.operation, undefined);
  } finally {
    x.store.close();
  }
});

test('a request of 30 records is two parts, and a bad record of the second part is named by its place in the whole list', async () => {
  const x = googleWorld();
  try {
    const refused = await x.prepare(action, campaigns(30, [27]));
    assertRefused(refused, 'PAUSED_CREATION_REQUIRED', {writes: x.writes});
    assert.equal(refused.error.details.operation, 27, 'the 28th record, not the third of its part');
    // One of the first part keeps its own index.
    assert.equal((await x.prepare(action, campaigns(30, [3]))).error.details.operation, 3);
  } finally {
    x.store.close();
  }
});

test('Snapchat record lists are located too', async () => {
  const owner = {tenantId: 'locator-snapchat', userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 87).toString('base64'));
  store.putConnection(
    owner,
    {
      id: 's',
      tenantId: owner.tenantId,
      gateway: 'snapchat_native_action',
      accounts: ['acct1'],
      writeAccounts: ['acct1'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw new Error('inspect reaches no provider');
    }),
    undefined,
    {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  );
  try {
    const inspect = records =>
      service.call(
        'amcp_write',
        {
          action: 'inspect',
          gateway: 'snapchat_native_action',
          connection_id: 's',
          arguments: {action: 'snapchat_campaign_create', account_id: 'acct1', payload: {campaigns: records}},
        },
        owner,
      );
    const record = (name, status) => ({name, status, start_time: '2026-12-01T00:00:00.000Z'});
    const answer = (await inspect([record('DNU A', 'PAUSED'), record('DNU B', 'ACTIVE'), record('DNU C', 'PAUSED')]))
      .data;
    assert.equal(answer.error.code, 'PAUSED_CREATION_REQUIRED', JSON.stringify(answer.error).slice(0, 400));
    assert.equal(answer.error.details.operation, 1);
    // One record has no list to locate in.
    const one = (await inspect([record('DNU B', 'ACTIVE')])).data;
    assert.equal(one.error.code, 'PAUSED_CREATION_REQUIRED');
    assert.equal(one.error.details.operation, undefined);
  } finally {
    store.close();
  }
});
