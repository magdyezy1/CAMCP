// QA-02 liveness pairs. Every refusal that leaves a review, export or schedule blocked, paused, busy, expired or
// uncertain has a sibling test proving its documented way out (tests/fixtures/refusal-exits.json, checked by
// tools/refusal-exits.mjs). The safe half stays as it was: no exit resends a request whose outcome is unknown.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {budgetName, googleBudgetFixture} from './fixtures/google-budget-writes.mjs';
import {blockingCodes, blockingState, checkExits, pathModules, paths, registryFile} from '../tools/refusal-exits.mjs';
import {writePathModules} from '../dist/tools/guidance-coverage.js';
import {assertRefused} from './helpers/assert-refused.mjs';

test('an uncertain write is never resent, and a new review from the current read executes once', async () => {
  const f = googleBudgetFixture();
  try {
    f.spendPolicy({max_daily_increase_native: 500000000});
    const id = (await f.update(100000000)).data.review_id;
    f.hooks.respond = () => {
      throw new TypeError('synthetic lost response');
    };
    assertRefused(await f.execute(id), 'WRITE_OUTCOME_UNCERTAIN');
    f.hooks.respond = undefined;
    // The safe half: neither execute nor verification sends the uncertain request again.
    assertRefused(await f.execute(id), 'WRITE_OUTCOME_UNCERTAIN');
    assertRefused(await f.call('amcp_campaign', {action: 'verify', review_id: id}), 'WRITE_OUTCOME_UNCERTAIN');
    assert.equal(f.writes.length, 1);
    // The exit: the operator inspects the account (here the lost request did not apply) and prepares a new review
    // from the current read; it executes once.
    assert.equal(f.budgets.get(budgetName(1)), '90000000');
    const next = await f.update(100000000);
    assert.equal(next.success, true, JSON.stringify(next));
    assert.notEqual(next.data.review_id, id);
    const done = await f.execute(next.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 800));
    assert.equal(f.writes.length, 2);
    assert.equal(f.budgets.get(budgetName(1)), '100000000');
  } finally {
    f.close();
  }
});

test('an expired review is prepared again from its next_call and executes once', async () => {
  const f = googleBudgetFixture(),
    now = Date.now;
  try {
    f.spendPolicy({max_daily_increase_native: 500000000});
    const id = (await f.update(100000000)).data.review_id;
    const later = now() + 301000;
    Date.now = () => later;
    const expired = await f.execute(id);
    assertRefused(expired, 'REVIEW_EXPIRED', {writes: f.writes.length});
    const {tool, arguments: args} = expired.error.details.next_call;
    const again = await f.call(tool, args);
    assert.equal(again.success, true, JSON.stringify(again));
    const done = await f.execute(again.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 800));
    assert.equal(f.writes.length, 1);
    assert.equal(f.budgets.get(budgetName(1)), '100000000');
  } finally {
    Date.now = now;
    f.close();
  }
});

test('every blocking refusal on the write, export and schedule paths names its exit test or why it is terminal', () => {
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8')),
    result = checkExits(registry);
  assert.deepEqual(result.problems, []);
  assert.ok(result.codes >= 30, 'the listing found the blocking refusals: ' + result.codes);
  assert.ok(result.with_exit_test > result.terminal);
});

test('the listing derives the write path like the guidance coverage and finds new, missing and stale entries', () => {
  assert.deepEqual(pathModules(paths.write), writePathModules('src'));
  for (const code of ['WRITES_PAUSED', 'SHEETS_OUTCOME_UNKNOWN', 'STATE_BUSY', 'STALE_JOB_LEASE', 'REVIEW_EXPIRED'])
    assert.ok(blockingState.test(code), code);
  for (const code of ['INVALID_ARGUMENT', 'FORBIDDEN', 'STATE_CHANGED']) assert.ok(!blockingState.test(code), code);
  const codes = new Map([
    ['WRITES_PAUSED', ['write:owner-operations.ts']],
    ['EXPORT_BUSY', ['export:google-sheets.ts']],
  ]);
  const problems = checkExits(
    {
      exits: {
        WRITES_PAUSED: {exit: 'resume', test: 'tests/write-pause.test.mjs', title: 'no such test title'},
        OLD_BUSY: {exit: 'x', test: 'tests/write-pause.test.mjs', title: 'a pause'},
      },
      terminal: {},
    },
    codes,
  ).problems.map(p => p.code + ' ' + p.problem.split(':')[0]);
  assert.deepEqual(problems.sort(), [
    'EXPORT_BUSY unlisted',
    'OLD_BUSY stale',
    'OLD_BUSY tests/write-pause.test.mjs never names the code it is the exit for',
    'WRITES_PAUSED exit test title not found in tests/write-pause.test.mjs',
  ]);
  assert.ok(blockingCodes().has('SHEETS_DELIVERY_UNRESOLVED'));
});
