import test from 'node:test';
import assert from 'node:assert/strict';
import {checkOf, step as providerStep, world} from './helpers/plan-reference-world.mjs';
import {providerHooks} from '../dist/src/provider-hooks.js';

/**
 * Package r25-field3-refs, item 6 (the owner's second Google report of 2026-11-21, AMCP-02, F2-3): Microsoft's contracts declare the field each answer
 * holds (`AddAdGroups` answers with `AdGroupIds`), and AMCP's own guided Search recipe names a result as `/data/CampaignIds/0`. A pointer into a Microsoft
 * predecessor was not judged at the preflight, so a wrong one failed at prepare, after the predecessors had executed. The Microsoft hook now checks, where
 * the contract declares `result`, that a pointer into the answer's body is `/data/<result>/<i>` with <i> a record the predecessor sends, and says what to send
 * when it refuses. The other providers keep the prepare-time details of item 5 as their floor. Every ID is invented.
 */
const gateway = 'microsoft_ads_native_action',
  group = {Name: 'Synthetic group', Status: 'Paused'};
const addGroups = (records = 1) =>
  providerStep(gateway, 'adgroup', {
    action: 'AddAdGroups',
    payload: {
      CampaignId: '10',
      AdGroups: Array.from({length: records}, (_, i) => ({...group, Name: 'Synthetic group ' + (i + 1)})),
    },
  });
const keywords = pointer =>
  providerStep(
    gateway,
    'keywords',
    {
      action: 'AddKeywords',
      // The review reads the exact parent ad group through its campaign.
      campaign_id: '10',
      payload: {
        AdGroupId: {$ref: 'adgroup#' + pointer},
        Keywords: [{Text: 'synthetic keyword', MatchType: 'Exact', Status: 'Paused', Bid: {Amount: 0.5}}],
      },
    },
    ['adgroup'],
  );
async function checked(steps) {
  const w = world([gateway]);
  try {
    return await w.preflight(steps);
  } finally {
    w.close();
  }
}

test('R1: a pointer to a record the predecessor sends, /data/<result>/<i>, is accepted, as the guided recipe names its results', async () => {
  const out = await checked([addGroups(2), keywords('/data/AdGroupIds/0')]);
  assert.equal(checkOf(out, 'keywords').status, 'contract_checked', JSON.stringify(checkOf(out, 'keywords').error));
  assert.equal(checkOf(out, 'keywords').references_deferred, 1);
  // The last record the predecessor sends is accepted too.
  const last = await checked([addGroups(2), keywords('/data/AdGroupIds/1')]);
  assert.equal(checkOf(last, 'keywords').status, 'contract_checked', JSON.stringify(checkOf(last, 'keywords').error));
});

test('R2: a position the predecessor does not send is refused INVALID_REFERENCE, naming the form, the records it sends and the range', async () => {
  const out = await checked([addGroups(2), keywords('/data/AdGroupIds/2')]);
  const check = checkOf(out, 'keywords');
  assert.equal(check.status, 'blocked');
  assert.equal(check.error.code, 'INVALID_REFERENCE');
  assert.equal(check.error.details.predecessor, 'adgroup');
  assert.equal(check.error.details.received_pointer, '/data/AdGroupIds/2');
  assert.equal(check.error.details.accepted_form, '/data/AdGroupIds/<i>');
  assert.equal(check.error.details.operations, 2);
  assert.equal(check.error.details.range, '0..1');
});

test('R3: another list than the one the contract declares, or no position, is refused with the form to send', async () => {
  for (const pointer of [
    '/data/CampaignIds/0',
    '/data/AdGroupIds',
    '/data/AdGroupIds/-1',
    '/data/AdGroupIds/01',
    '/data/AdGroupIds/0/x',
    '/data/adgroupids/0',
  ]) {
    const out = await checked([addGroups(1), keywords(pointer)]);
    const check = checkOf(out, 'keywords');
    assert.equal(check.status, 'blocked', pointer);
    assert.equal(check.error.code, 'INVALID_REFERENCE', pointer);
    assert.equal(check.error.details.accepted_form, '/data/AdGroupIds/<i>', pointer);
    assert.equal(check.error.details.received_pointer, pointer);
    assert.equal(check.error.details.operations, undefined, 'no range is named when the form is wrong: ' + pointer);
  }
});

// N1 (nothing that worked is refused): only a pointer into the answer's body is judged. A pointer to anything else of the step result, such as the
// verified resources every verified write step keeps, is left to prepare as before.
test('N1: a pointer outside the answer’s body is not judged at the preflight', async () => {
  const out = await checked([addGroups(1), keywords('/verified_resources/0/id')]);
  assert.equal(checkOf(out, 'keywords').status, 'contract_checked', JSON.stringify(checkOf(out, 'keywords').error));
});

// N2: a predecessor of another provider, or an action the contracts do not name, is not judged by this hook.
test('N2: the hook judges only a Microsoft predecessor whose contract it knows', () => {
  const hook = providerHooks(gateway)?.campaign?.preflight?.reference,
    none = () => assert.fail('no compile');
  assert.equal(typeof hook, 'function');
  assert.equal(
    hook({
      path: '/payload/x',
      ref: 'p#/data/data/id',
      ordinal: 3,
      parent: {gateway: 'tiktok_native_action', arguments: {action: 'AddAdGroups'}},
      compile: none,
    }),
    undefined,
  );
  assert.equal(
    hook({
      path: '/payload/x',
      ref: 'p#/data/nothing/0',
      ordinal: 3,
      parent: {gateway, arguments: {action: 'NotAnAction'}},
      compile: none,
    }),
    undefined,
  );
  assert.equal(
    hook({path: '/payload/x', ref: 'p#/data/AdGroupIds/0', ordinal: 3, parent: undefined, compile: none}),
    undefined,
  );
});

// The details are the bounded ones of item 5: the step and the pointer as sent, no value.
test('the refusal repeats no text of another shape', async () => {
  const out = await checked([addGroups(1), keywords('/data/AdGroupIds/0?token=SECRETSECRETSECRETSECRET1234')]);
  const check = checkOf(out, 'keywords');
  assert.equal(check.error.code, 'INVALID_REFERENCE');
  assert.equal(check.error.details.received_pointer, null);
  assert.doesNotMatch(JSON.stringify(check.error.details), /SECRET/);
});
