import test from 'node:test';
import assert from 'node:assert/strict';
import {isReadLagMiss, prepareAfterReadLag, verifiedWriteValues} from '../dist/src/campaign-runner.js';
import {MirrorError} from '../dist/src/errors.js';
import {validateState} from '../dist/src/write-state.js';

/**
 * R2.5 field3, package r25-field3-livefix, item 6 and its fix round (the lead's review, S2-1). The plan engine prepares a step again, after a short wait, only when the
 * refusal says that a read did not find an object that a verified earlier step of the same plan created: a read miss (STATE_TARGET_MISMATCH or STATE_NOT_FOUND) that
 * names, in its details, a value one of the step's references to such a step resolved to. Nothing else is read again, and nothing is relabeled: a refusal that names what
 * blocked the step (details.blocked_by), one with a call of its own (details.next_call), one that names another object (a post that is gone, a target the plan did not
 * create) keeps what it says. The generic exact-target refusal of the state stage names the IDs its read asked for, so that it can be judged. These are the decisions and
 * the loop, with a fake prepare; the engine's own runs are in tests/tiktok-launch-recipes.test.mjs and tests/tiktok-smart-plus-recipe.test.mjs.
 */
const miss = (details, code = 'STATE_TARGET_MISMATCH') => ({
  success: false,
  error: {
    code,
    message: 'State read did not return every exact requested target.',
    details,
    remedy: {action: 'the remedy of its own code'},
    next_action: 'the next action of its own code',
  },
});
const referenced = new Set(['900']);
const sequence = (...answers) => {
  const calls = [];
  return {
    calls,
    prepare: async () => {
      calls.push('prepare');
      return answers[Math.min(calls.length, answers.length) - 1];
    },
  };
};
const sleeps = () => {
  const waited = [];
  return {waited, sleep: async ms => void waited.push(ms)};
};

test('the exact-target refusal of the state stage names the IDs its read asked for, bounded, and keeps its code and message', () => {
  const ids = Array.from({length: 25}, (_, i) => String(1000 + i));
  const read = {
    gateway: 'tiktok_native_action',
    action: 'native',
    method: 'GET',
    path: '/v1.3/campaign/get/',
    query: {advertiser_id: '123', filtering: {campaign_ids: ['111', '112']}},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: true,
    accountId: '123',
    evidence: 'TEST',
    warnings: [],
  };
  const answer = list => ({
    status: 200,
    headers: {},
    data: {
      code: 0,
      data: {list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}},
    },
  });
  const refused = (r, result) => {
    try {
      validateState(r, result);
    } catch (error) {
      return error;
    }
    assert.fail('expected the exact-target refusal');
  };
  const one = refused(read, answer([{campaign_id: '111'}]));
  assert.ok(one instanceof MirrorError);
  assert.equal(one.code, 'STATE_TARGET_MISMATCH');
  assert.equal(one.message, 'State read did not return every exact requested target.');
  assert.deepEqual(one.details, {requested_ids: ['111', '112']});
  // A read that returns exactly what it asked for is accepted, as before.
  assert.doesNotThrow(() => validateState(read, answer([{campaign_id: '112'}, {campaign_id: '111'}])));
  // Bounded: a read of many IDs names the first twenty, in order.
  const many = refused(
    {...read, query: {advertiser_id: '123', filtering: {campaign_ids: ids}}},
    answer([{campaign_id: '1000'}]),
  );
  assert.deepEqual(many.details.requested_ids, ids.slice(0, 20));
});

test('a read miss that names a value the step referenced is a read lag; a miss of another object, or one with a blocker or a call of its own, is not', () => {
  // The live shape (LV-19 LPV): the ad group the plan just created is not returned.
  assert.equal(isReadLagMiss(miss({requested_ids: ['900']}).error, referenced), true);
  assert.equal(isReadLagMiss(miss({adgroup_id: '900'}, 'STATE_NOT_FOUND').error, referenced), true);
  assert.equal(isReadLagMiss(miss({ids: ['5', 900]}).error, referenced), true, 'a number, and a value among several');
  // A miss of another object: a post the plan did not create, or an ID nothing in the step references.
  assert.equal(isReadLagMiss(miss({requested_ids: ['7300000000000000001']}).error, referenced), false);
  assert.equal(
    isReadLagMiss(miss({requested_ids: ['900001']}).error, referenced),
    false,
    'a prefix of the value is not the value',
  );
  assert.equal(isReadLagMiss(miss(undefined).error, referenced), false, 'a refusal that names nothing');
  assert.equal(isReadLagMiss(miss({}).error, referenced), false);
  // A refusal that names what blocked the step, or carries a call of its own.
  assert.equal(isReadLagMiss(miss({campaign_id: '900', blocked_by: 'deleted_target'}).error, referenced), false);
  assert.equal(isReadLagMiss(miss({campaign_id: '900', next_call: {tool: 'amcp_write'}}).error, referenced), false);
  // Only what the details name at their first level: a call that echoes the value inside its arguments names no object.
  assert.equal(isReadLagMiss(miss({fix: {arguments: {adgroup_id: '900'}}}).error, referenced), false);
  // A provider's 404 names no object, so it is no read lag either.
  assert.equal(isReadLagMiss({code: 'PLATFORM_NOT_FOUND', details: {http_status: 404}}, referenced), false);
  assert.equal(isReadLagMiss(undefined, referenced), false);
  assert.equal(
    isReadLagMiss(miss({requested_ids: ['900']}).error, new Set()),
    false,
    'a step that references no verified create',
  );
});

test('the loop prepares again for a read lag, at most three times, then says it may be a read delay; a refusal that is no read lag is prepared once and returned as it was', async () => {
  const waits = [5, 7];
  // A lag that clears: the second prepare succeeds, after the first wait.
  {
    const ok = {success: true, data: {review_id: 'r'}},
      s = sequence(miss({requested_ids: ['900']}), ok),
      w = sleeps();
    assert.equal(await prepareAfterReadLag(s.prepare, referenced, waits, w.sleep), ok);
    assert.deepEqual([s.calls.length, w.waited], [2, [5]]);
  }
  // A lag that outlasts the bound: three prepares, and the refusal is then said to be a read delay (details, remedy and next action).
  {
    const s = sequence(miss({requested_ids: ['900']})),
      w = sleeps(),
      out = await prepareAfterReadLag(s.prepare, referenced, waits, w.sleep);
    assert.deepEqual([s.calls.length, w.waited], [3, [5, 7]]);
    assert.equal(out.success, false);
    assert.equal(out.error.code, 'STATE_TARGET_MISMATCH');
    assert.deepEqual(out.error.details.read_delay, {attempts: 3, waited_ms: 12, nothing_sent: true});
    assert.deepEqual(out.error.details.requested_ids, ['900'], 'what the refusal named stays');
    assert.match(out.error.next_action, /read delay/);
    assert.equal(out.error.remedy.action, out.error.next_action);
  }
  // Prepared once, and returned as it is (the same object: no remedy, next action or details of it is replaced), in every case that is no read lag.
  for (const [name, refusal] of [
    [
      'a miss of a post the plan did not create (the case of the lead’s review)',
      miss({requested_ids: ['7300000000000000001']}),
    ],
    ['a refusal that names nothing', miss(undefined)],
    ['a refusal that names what blocked the step', miss({campaign_id: '900', blocked_by: 'deleted_campaign'})],
    [
      'a refusal with a call of its own',
      miss({adgroup_id: '900', next_call: {tool: 'amcp_campaign'}}, 'STATE_NOT_FOUND'),
    ],
    ['a provider 404', {success: false, error: {code: 'PLATFORM_NOT_FOUND', details: {http_status: 404}}}],
  ]) {
    const s = sequence(refusal),
      w = sleeps();
    assert.equal(await prepareAfterReadLag(s.prepare, referenced, waits, w.sleep), refusal, name);
    assert.deepEqual([s.calls.length, w.waited], [1, []], name);
  }
  // A step that references no verified create is never prepared again, and a success is returned at once.
  {
    const s = sequence(miss({requested_ids: ['900']}));
    await prepareAfterReadLag(s.prepare, new Set(), waits, sleeps().sleep);
    assert.equal(s.calls.length, 1);
    const ok = {success: true},
      t = sequence(ok);
    assert.equal(await prepareAfterReadLag(t.prepare, referenced, waits, sleeps().sleep), ok);
    assert.equal(t.calls.length, 1);
  }
});

test('the values a step references are those of verified write steps of its plan, with a URN prefix too, and nothing the step does not reference', () => {
  const run = {
      steps: [
        {id: 'campaign', kind: 'write', status: 'verified'},
        {id: 'adgroup', kind: 'write', status: 'verified_with_acceptance'},
        {id: 'ad', kind: 'write', status: 'pending'},
        {id: 'lookup', kind: 'read', status: 'verified'},
        {id: 'failed', kind: 'write', status: 'failed'},
      ],
    },
    results = new Map([
      ['campaign', {data: {data: {campaign_id: '800', name: 'Synthetic'}}}],
      ['adgroup', {data: {data: {adgroup_id: 900}}}],
      ['lookup', {data: {data: {id: '555'}}}],
      ['failed', {data: {data: {id: '777'}}}],
    ]),
    step = {
      arguments: {
        action: 'x',
        payload: {
          campaign_ids: [{$ref: 'campaign#/data/data/campaign_id'}],
          adgroup_id: {$ref: 'adgroup#/data/data/adgroup_id'},
          campaign: {$ref: 'campaign#/data/data/campaign_id', prefix: 'urn:li:sponsoredCampaign:'},
          from_read: {$ref: 'lookup#/data/data/id'},
          from_failed: {$ref: 'failed#/data/data/id'},
          not_yet: {$ref: 'ad#/data/data/id'},
          gone: {$ref: 'campaign#/data/data/nothing'},
          literal: '1',
        },
      },
    };
  assert.deepEqual([...verifiedWriteValues(run, step, results)].sort(), ['800', '900', 'urn:li:sponsoredCampaign:800']);
  assert.deepEqual([...verifiedWriteValues(run, {arguments: {payload: {id: '1'}}}, results)], []);
});

// The lead's review of this package (S3-1): the two halves of the gate that no test exercised, found by two mutations that survived (every refusal counted as a read
// miss; the loop kept preparing after a refusal that was none). A refusal of another code is never a read lag, even one that names the value a step referenced, and a
// read miss that is followed by another refusal ends at that refusal.
test('no refusal of another code is a read lag, even one that names the value a step referenced: it is prepared once and returned as it was', async () => {
  for (const code of [
    'CAMPAIGN_PREREQUISITE_REQUIRED',
    'DUPLICATE_OF_UNCERTAIN_WRITE',
    'INVALID_ARGUMENT',
    'PROVIDER_ACCESS_DENIED',
    'RESOURCE_SCOPE_REQUIRED',
    'STATE_CHANGED',
  ]) {
    const refusal = {
      success: false,
      error: {
        code,
        message: 'refused',
        details: {adgroup_id: '900', requested_ids: ['900']},
        remedy: {action: 'its own'},
      },
    };
    assert.equal(isReadLagMiss(refusal.error, referenced), false, code);
    const s = sequence(refusal),
      w = sleeps();
    assert.equal(await prepareAfterReadLag(s.prepare, referenced, [5, 7], w.sleep), refusal, code);
    assert.deepEqual([s.calls.length, w.waited], [1, []], code);
  }
});

test('a read miss followed by another refusal ends at that refusal: two prepares, that refusal as it is, no note of a read delay, and no third prepare', async () => {
  for (const [name, second] of [
    [
      'another code',
      {
        success: false,
        error: {
          code: 'PROVIDER_ACCESS_DENIED',
          message: 'refused',
          details: {layer: 'role_or_asset_access'},
          remedy: {action: 'its own'},
        },
      },
    ],
    ['a miss of another object', miss({requested_ids: ['7300000000000000001']})],
    ['a refusal that names what blocked the step', miss({campaign_id: '900', blocked_by: 'deleted_campaign'})],
  ]) {
    const s = sequence(miss({requested_ids: ['900']}), second),
      w = sleeps(),
      out = await prepareAfterReadLag(s.prepare, referenced, [5, 7], w.sleep);
    assert.equal(out, second, name);
    assert.deepEqual([s.calls.length, w.waited], [2, [5]], name);
    assert.equal(out.error.details.read_delay, undefined, name);
  }
});
