import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRefused} from './helpers/assert-refused.mjs';
import {harness, step} from './helpers/campaign-step-fixture.mjs';
import {firstPartyContract} from '../dist/src/first-party-contracts.js';

/**
 * Round 2.5, package r25-m0-review, T4 (the owner's General 3): amcp_campaign create required a brief ("Provide a campaign
 * name and brief."), although a plan's steps say what it does and the name says what it is. The brief now defaults to the
 * name. It is additive: a call that sends a brief behaves as it did, and every other gate of create refuses as before.
 */
const plan = (extra = {}) => ({
  action: 'create',
  name: 'Synthetic plan',
  brief: 'Synthetic brief',
  steps: [step()],
  ...extra,
});

test('create takes no brief: it defaults to the name, and a call that sends one behaves as before', async t => {
  const f = harness(t),
    without = await f.call({action: 'create', name: 'Synthetic plan', steps: [step()]});
  assert.equal(without.success, true, JSON.stringify(without.error));
  const stored = await f.call({action: 'get', id: without.data.id, detail: 'full'});
  assert.equal(stored.data.brief, 'Synthetic plan');
  const withBrief = await f.call(plan({name: 'Another plan', brief: 'Why this plan exists.'}));
  assert.equal(withBrief.success, true, JSON.stringify(withBrief.error));
  assert.equal(
    (await f.call({action: 'get', id: withBrief.data.id, detail: 'full'})).data.brief,
    'Why this plan exists.',
  );
  assert.equal(f.requests(), 0);
});

test('a creation key names one exact input: an omitted brief and the name sent as the brief are the same plan', async t => {
  const f = harness(t),
    key = 'synthetic-key-0001',
    first = await f.call({action: 'create', name: 'Synthetic plan', steps: [step()], idempotency_key: key}),
    again = await f.call(plan({brief: 'Synthetic plan', idempotency_key: key}));
  assert.equal(first.success, true, JSON.stringify(first.error));
  assert.equal(again.success, true, JSON.stringify(again.error));
  assert.equal(again.data.id, first.data.id);
  // A different brief under the same key is still a conflict.
  assertRefused(await f.call(plan({brief: 'A different brief', idempotency_key: key})), 'IDEMPOTENCY_CONFLICT');
});

test('the contract no longer lists brief as required, and says what an omitted one becomes', async t => {
  const f = harness(t),
    tool = f.service.firstPartyTools().find(x => x.name === 'amcp_campaign'),
    contract = firstPartyContract(tool, 'create');
  assert.deepEqual(contract.argumentsSchema.required, ['action', 'name']);
  assert.match(contract.argumentsSchema.properties.brief.description, /defaults to (?:the )?name/i);
  // The listed schema is untouched: it never required brief (tools/list stays byte for byte).
  assert.deepEqual(tool.inputSchema.required, ['action']);
});

// The gates create had before, each still refusing what it refused: the one thing that no longer refuses is a missing brief.
test('every other refusal of create still refuses, and each names its code and what to correct', async t => {
  const f = harness(t),
    refusal = async (extra, message) => {
      const result = await f.call(plan(extra));
      assertRefused(result, 'INVALID_ARGUMENT', {message});
    };
  await refusal({name: ''}, /campaign name/);
  await refusal({name: '   '}, /campaign name/);
  await refusal({name: 'x'.repeat(101)}, /campaign name/);
  await refusal({name: 7}, /campaign name/);
  await refusal({brief: 7}, /brief/);
  await refusal({brief: 'x'.repeat(12001)}, /brief/);
  await refusal({steps: []}, /1–50 explicit steps/);
  await refusal({steps: Array.from({length: 51}, (_, i) => step('s' + i))}, /1–50 explicit steps/);
  await refusal({steps: [step('1bad')]}, /id must start with a letter/);
  await refusal({steps: [step('a'), step('a')]}, /id must be unique/);
  await refusal({steps: [step('a', {gateway: undefined})]}, /a write step needs gateway/);
  await refusal({steps: [step('a', {connection_id: undefined})]}, /connection_id is required/);
  await refusal({steps: [step('a', {account_id: undefined})]}, /account_id is required/);
  await refusal({steps: [step('a', {arguments: 'x'})]}, /arguments must be the native tool input object/);
  await refusal({steps: [step('a', {expected_currency: 'usd'})]}, /expected_currency/);
  await refusal({steps: [step('a', {prerequisites: ['nope']})]}, /prerequisites/);
  await refusal(
    {steps: [step('a', {depends_on: ['later']}), step('later')]},
    /Dependencies must refer to earlier steps/,
  );
  // A name or a brief at its limit is accepted: the bounds did not move.
  assert.equal((await f.call(plan({name: 'x'.repeat(100), brief: 'y'.repeat(12000)}))).success, true);
  assert.equal(f.requests(), 0);
});
