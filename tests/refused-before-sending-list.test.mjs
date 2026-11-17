import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {googleBudgetFixture} from './fixtures/google-budget-writes.mjs';
import {MirrorError, refusedBeforeSending} from '../dist/src/errors.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * R2.5 M2 merge (lead re-review of r25-m2-reconcile, "Merge joins" 3): the refusals the transport raises before it sends a request (a
 * provider cooldown, the tenant's request budget, an open circuit, the coordination limit) were listed twice. The refusal package kept
 * the four codes in src/write-review.ts, where an execute-time state read refused with one of them says `submission: "not_sent"` so a
 * plan step waits; the reconcile package recognised the same codes, plus the provider-quota family, in src/write-reconciliation.ts, so
 * a turn of the automatic check that read nothing is no attempt; and the plan engine (src/campaign-runner.ts) waits on the same four
 * when a refusal says it was not sent. They are one list now, in the shared error module, and the reconciliation job adds the quota
 * prefix itself.
 */
const four = ['CIRCUIT_OPEN', 'PLATFORM_RATE_LIMIT', 'PROVIDER_COORDINATION_BUSY', 'TENANT_RATE_LIMIT'];
const withoutComments = file =>
  fs
    .readFileSync(new URL('../src/' + file, import.meta.url), 'utf8')
    .split('\n')
    .filter(line => !/^\s*(?:\/\/|\/?\*)/.test(line))
    .join('\n');

test('the codes a request is refused with before it is sent are one frozen list, in the shared error module', () => {
  assert.deepEqual([...refusedBeforeSending].sort(), four);
  assert.ok(Object.isFrozen(refusedBeforeSending), 'a consumer cannot change what the others read');
});

test('the review, the reconciliation and the plan engine read that list, and none repeats it', () => {
  for (const file of ['write-review.ts', 'write-reconciliation.ts', 'campaign-runner.ts']) {
    const code = withoutComments(file);
    assert.match(code, /\brefusedBeforeSending\b/, file + ' reads the list');
    assert.match(
      code,
      /import\s*\{[^}]*\brefusedBeforeSending\b[^}]*\}\s*from\s*'\.\/errors\.js'/s,
      file + ' takes it from the shared error module',
    );
    // The least ambiguous of the four: no other module of the three says it, so a second copy of the list would.
    assert.equal(code.includes('PROVIDER_COORDINATION_BUSY'), false, file + ' repeats the list');
  }
});

test('the state read of an execute refused with one of the four is marked unsent; a provider quota refusal is not (not widened without a decision)', async () => {
  // The re-review's rule: PROVIDER_QUOTA_* is the reconciliation job's alone. Adding it to execute's mark or to the plan's wait list
  // would change what a refused state read says (and whether a plan step waits), so it stays a decision for the lead.
  const f = googleBudgetFixture();
  try {
    const id = (await f.creates(1, 50000000)).data.review_id,
      request = f.transport.request.bind(f.transport);
    let refuse;
    f.transport.request = async (plan, ...rest) => {
      if (refuse && plan.readOnly)
        throw new MirrorError(refuse, 'Synthetic refusal.', {retry_after_ms: 60000}, 429, true);
      return request(plan, ...rest);
    };
    for (const code of four) {
      refuse = code;
      const refused = await f.execute(id);
      assertRefused(refused, code, {writes: () => f.writes.length});
      assert.equal(refused.error.details.submission, 'not_sent', code);
      assert.equal(f.claim(id), undefined, code + ': nothing was claimed');
    }
    refuse = 'PROVIDER_QUOTA_SHARE_EXHAUSTED';
    const quota = await f.execute(id);
    assertRefused(quota, 'PROVIDER_QUOTA_SHARE_EXHAUSTED', {writes: () => f.writes.length});
    assert.notEqual(quota.error.details.submission, 'not_sent');
    assert.equal(f.claim(id), undefined, 'nothing was claimed either');
    // Not refused any more: the same review executes.
    refuse = undefined;
    assert.equal((await f.execute(id)).success, true);
    assert.equal(f.writes.length, 1);
  } finally {
    f.close();
  }
});
