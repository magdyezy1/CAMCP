import test from 'node:test';
import assert from 'node:assert/strict';
import {inlineVerification, verificationSummary} from '../dist/src/write-inline-check.js';
import {checkedView, checkHashes} from '../dist/src/verification-core.js';
import {knownBehaviours} from '../dist/src/known-behaviours.js';
import {verificationView} from '../dist/src/campaign-view.js';

/**
 * R2.5 r25-fr-verify (the owner's friction B1 and B5): the block an execute answers with once its own read-back has run for a few
 * seconds, built from the receipt the verifier gives, or from the checks it had finished when the wait ended. Nothing here reaches a
 * provider: the verifier is a function the test hands in.
 */
const code = 'GOOGLE_ASSET_LINK_PAUSED_SWITCHED_ON';
const queued = {
  status: 'queued',
  job_id: 'job-1',
  next_call: {tool: 'amcp_campaign', arguments: {action: 'verify', review_id: 'review-1'}},
};
const clean = id => ({resource_id: id, status: 'verified', changed_fields: []});
const flipped = id => ({
  resource_id: id,
  status: 'mismatch',
  changed_fields: ['/status'],
  diff: [{field: '/status', expected: 'PAUSED', actual: 'ENABLED'}],
  known: code,
});
const receipt = (status, checks, more = {}) => ({status, checked_at: Date.UTC(2026, 10, 27, 12), checks, ...more});

test('a verified receipt is a verified block that keeps the job and leaves no call to make', async () => {
  const block = await inlineVerification(
    async sink => {
      sink.total = 2;
      return receipt('verified', [clean('a'), clean('b')]);
    },
    1000,
    queued,
  );
  const {waited_ms, ...rest} = block;
  assert.ok(Number.isInteger(waited_ms) && waited_ms >= 0 && waited_ms < 1000);
  assert.deepEqual(rest, {
    status: 'verified',
    inline: true,
    checked: 2,
    total: 2,
    checked_at: '2026-11-27T12:00:00.000Z',
    job_id: 'job-1',
  });
});

test('a mismatch groups what differs, names the known behaviour with its sentence, and keeps the call that reads again', async () => {
  const other = {
    resource_id: 'd',
    status: 'mismatch',
    changed_fields: ['/name'],
    diff: [{field: '/name', expected: 'A', actual: 'B'}],
  };
  const block = await inlineVerification(
    async sink => {
      sink.total = 4;
      return receipt('mismatch', [flipped('a'), flipped('b'), flipped('c'), other]);
    },
    1000,
    queued,
  );
  assert.equal(block.status, 'mismatch');
  assert.deepEqual(block.differences, [
    {field: '/status', expected: 'PAUSED', actual: 'ENABLED', count: 3, example: 'a'},
    {field: '/name', expected: 'A', actual: 'B', count: 1, example: 'd'},
  ]);
  assert.deepEqual(block.known, [{code, count: 3, note: knownBehaviours[code].note}]);
  assert.deepEqual(block.next_call, queued.next_call);
  assert.equal(block.complete, undefined);
});

test('a read still settling, a failed read and a receipt that could not be made are checking, with the job and when to read again', async () => {
  for (const status of ['inconclusive', 'pending', 'unverified']) {
    const block = await inlineVerification(
      async sink => {
        sink.total = 1;
        return receipt(
          status,
          [{resource_id: 'a', status: 'inconclusive', changed_fields: ['/asset'], stable_reads: true}],
          {retry_read_after_ms: 5000},
        );
      },
      1000,
      queued,
    );
    assert.equal(block.status, 'checking', status);
    assert.deepEqual(block.differing_fields, ['/asset']);
    assert.equal(block.differences, undefined);
    assert.equal(block.retry_read_after_ms, 5000);
    assert.deepEqual([block.job_id, block.next_call], ['job-1', queued.next_call]);
  }
});

test('a write nothing can read back is unsupported and a failed job is failed; only the second names a call', async () => {
  const unsupported = await inlineVerification(async () => receipt('unsupported', []), 1000, queued);
  assert.equal(unsupported.status, 'unsupported');
  assert.equal(unsupported.next_call, undefined);
  assert.equal(unsupported.job_id, 'job-1');
  const failed = await inlineVerification(async () => receipt('failed', [{status: 'failed'}]), 1000, queued);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.next_call, queued.next_call);
});

test('a read-back not done in time reports what it read: a settled mismatch is a mismatch, a part list is never verified', async () => {
  const began = Date.now();
  const block = await inlineVerification(
    sink =>
      new Promise(() => {
        sink.total = 5;
        sink.checks.push(clean('a'), flipped('b'));
      }),
    30,
    queued,
  );
  assert.ok(Date.now() - began < 1000, 'it answered at the wait, not when the read-back ends');
  assert.deepEqual([block.status, block.complete, block.checked, block.total], ['mismatch', false, 2, 5]);
  assert.deepEqual(block.next_call, queued.next_call);
  const quiet = await inlineVerification(
    sink =>
      new Promise(() => {
        sink.total = 5;
        sink.checks.push(clean('a'));
      }),
    30,
    queued,
  );
  assert.deepEqual([quiet.status, quiet.checked, quiet.total], ['checking', 1, 5]);
  const nothing = await inlineVerification(() => new Promise(() => {}), 30, queued);
  assert.deepEqual([nothing.status, nothing.checked, nothing.total], ['checking', 0, 0]);
  // A write group's later parts are read after the earlier ones, so the verifier knows only the first part's resources: the change's own count is the total.
  const group = await inlineVerification(
    sink =>
      new Promise(() => {
        sink.total = 25;
        sink.checks.push(flipped('a'));
      }),
    30,
    queued,
    48,
  );
  assert.deepEqual([group.status, group.checked, group.total], ['mismatch', 1, 48]);
});

// R2.5 r25-fr-verify, fix round (the Opus review, S3, read load): when the wait ends before the read-back, the read-back is told to stop asking the provider, and the
// `checking` answer says when to read again, so a client does not poll at once. A read-back that finished is never told to stop.
test('a wait that ends first tells the read-back to stop and hints when to read again; a read-back that finished is left alone', async () => {
  let sink;
  const late = await inlineVerification(
    s => {
      sink = s;
      return new Promise(() => {});
    },
    30,
    queued,
  );
  assert.equal(sink.stopped, true);
  assert.equal(late.status, 'checking');
  assert.ok(
    Number.isInteger(late.retry_read_after_ms) && late.retry_read_after_ms >= 1000,
    String(late.retry_read_after_ms),
  );
  let own;
  const quick = await inlineVerification(
    async s => {
      own = s;
      return receipt('verified', [clean('a')]);
    },
    1000,
    queued,
  );
  assert.notEqual(own.stopped, true);
  assert.equal(quick.status, 'verified');
  assert.equal(quick.retry_read_after_ms, undefined);
  // A hint the receipt carries is kept as it is.
  const hinted = await inlineVerification(
    async () =>
      receipt('inconclusive', [{resource_id: 'a', status: 'inconclusive', changed_fields: ['/x']}], {
        retry_read_after_ms: 1234,
      }),
    1000,
    queued,
  );
  assert.equal(hinted.retry_read_after_ms, 1234);
});

// The compact view of a receipt (`amcp_campaign verify`): it says what was checked (once, when every check read the same fields, as a write of one kind does:
// thirty resources must not repeat the list thirty times in a view with a size budget) and, per check, for a Performance Max asset group how Google sees it
// (primary status and ad strength), and the behaviour that explains a difference; the two hashes only for a check that differs, since equal ones say nothing (B5).
test('the compact view says once what every check read and, per check, the provider status, the behaviour and the hashes of a difference', () => {
  const same = verificationView({
    status: 'verified',
    checks: ['a', 'b', 'c'].map(id => ({
      resource_id: id,
      status: 'verified',
      changed_fields: [],
      checked_fields: ['name', 'status'],
      expected_hash: 'same',
      actual_hash: 'same',
    })),
  });
  assert.deepEqual(same.checked_fields, ['name', 'status']);
  assert.ok(same.checks.every(c => c.checked_fields === undefined && c.expected_hash === undefined));
  // A check that read other fields keeps its own list, and so do all the others.
  const differs = verificationView({
    status: 'verified',
    checks: [
      {resource_id: 'a', status: 'verified', checked_fields: ['name']},
      {resource_id: 'b', status: 'verified', checked_fields: ['name', 'status']},
      {resource_id: 'c', status: 'unverified', code: 'READ_FAILED'},
    ],
  });
  assert.equal(differs.checked_fields, undefined);
  assert.deepEqual(
    differs.checks.map(c => c.checked_fields),
    [['name'], ['name', 'status'], undefined],
  );
  const view = verificationView({
    status: 'mismatch',
    checks: [
      {
        resource_id: 'g',
        status: 'verified',
        changed_fields: [],
        checked_fields: ['name', 'status'],
        provider_status: {primary_status: 'PENDING', ad_strength: 'GOOD'},
        expected_hash: 'same',
        actual_hash: 'same',
      },
      {
        resource_id: 'l',
        status: 'mismatch',
        changed_fields: ['/status'],
        checked_fields: ['status'],
        known: code,
        expected_hash: 'one',
        actual_hash: 'two',
      },
    ],
  });
  assert.deepEqual(view.checks[0], {
    resource_id: 'g',
    status: 'verified',
    changed_fields: [],
    checked_fields: ['name', 'status'],
    provider_status: {primary_status: 'PENDING', ad_strength: 'GOOD'},
  });
  assert.deepEqual(view.checks[1], {
    resource_id: 'l',
    status: 'mismatch',
    changed_fields: ['/status'],
    checked_fields: ['status'],
    known: code,
    expected_hash: 'one',
    actual_hash: 'two',
  });
});

test('whatever the read-back does, even late, the block comes back and nothing is left unhandled', async () => {
  let unhandled = 0;
  const count = () => unhandled++;
  process.on('unhandledRejection', count);
  try {
    const refused = await inlineVerification(async () => Promise.reject(new Error('refused')), 1000, queued);
    assert.deepEqual([refused.status, refused.checked], ['checking', 0]);
    const thrown = await inlineVerification(
      () => {
        throw new Error('thrown');
      },
      1000,
      queued,
    );
    assert.equal(thrown.status, 'checking');
    const late = await inlineVerification(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 60)),
      20,
      queued,
    );
    assert.equal(late.status, 'checking');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(unhandled, 0);
  } finally {
    process.off('unhandledRejection', count);
  }
});

test('the block stays under 2 KiB however many resources differ, and says how many groups it left out', async () => {
  const wide = i => ({
    resource_id: 'customers/123/adGroupAssets/101~' + (500 + i) + '~AD_IMAGE',
    status: 'mismatch',
    changed_fields: ['/f' + (i % 12)],
    diff: [{field: '/f' + (i % 12), expected: 'x'.repeat(300 + i), actual: 'y'.repeat(300)}],
  });
  const checks = Array.from({length: 48}, (_, i) => wide(i)).concat([flipped('z')]);
  const block = await inlineVerification(
    async sink => {
      sink.total = checks.length;
      return receipt('mismatch', checks);
    },
    1000,
    queued,
  );
  assert.equal(block.differences.length, 5);
  assert.ok(block.differences_omitted > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(block)) < 2048, String(Buffer.byteLength(JSON.stringify(block))));
});

test('a stored receipt summarizes the same way without a wait: counts, differences, the behaviour, and nothing for a clean one', () => {
  assert.deepEqual(verificationSummary([clean('a'), clean('b')]), {checked: 2, total: 2});
  assert.deepEqual(verificationSummary([flipped('a')]), {
    checked: 1,
    total: 1,
    differences: [{field: '/status', expected: 'PAUSED', actual: 'ENABLED', count: 1, example: 'a'}],
    known: [{code, count: 1, note: knownBehaviours[code].note}],
  });
  // A check that is no resource (a read that failed has no resource_id) is not counted as one read back.
  assert.deepEqual(verificationSummary([{status: 'unverified', code: 'READ_FAILED'}]), {checked: 0, total: 0});
});

test('checkedView is what a read holds at the fields that were sent: objects by key, lists whole, nothing else', () => {
  const sent = {status: 'PAUSED', nested: {a: 1}, list: [1, 2]};
  const read = {resource_name: 'r', status: 'ENABLED', nested: {a: 2, b: 3}, list: [1, 2, 3], extra: true};
  assert.deepEqual(checkedView(sent, read), {status: 'ENABLED', nested: {a: 2}, list: [1, 2, 3]});
  assert.deepEqual(checkedView(sent, {...sent, resource_name: 'r', future: 1}), sent);
  assert.deepEqual(checkedView(sent, undefined), {status: null, nested: {a: null}, list: null});
  assert.deepEqual(checkedView(sent, 'text'), {status: null, nested: {a: null}, list: null});
});

test('checkHashes gives a check that nothing differs in one hash, and keeps the hash of what was read for one that differs', () => {
  const sent = {a: 1, nested: {b: 2}},
    wider = {...sent, resource_name: 'r', update_time: '2026-11-27T10:00:00Z'};
  const same = checkHashes([], sent, wider);
  assert.match(same.expected_hash, /^[0-9a-f]{64}$/);
  assert.equal(
    same.actual_hash,
    same.expected_hash,
    'a field the comparison leaves out does not make the hashes differ',
  );
  const differs = checkHashes(['/a'], sent, {...wider, a: 2});
  assert.equal(differs.expected_hash, same.expected_hash);
  assert.notEqual(differs.actual_hash, differs.expected_hash);
  assert.equal(
    differs.actual_hash,
    checkHashes(['/a'], sent, {...wider, a: 2}).actual_hash,
    'the hash of what was read is stable',
  );
  assert.notEqual(differs.actual_hash, checkHashes(['/a'], sent, {...wider, a: 3}).actual_hash);
});

test('the known behaviour is worded as seen, not as documented, and names no internal round to a person reading it', () => {
  const known = knownBehaviours[code];
  assert.deepEqual([known.field, known.sent, known.reads], ['/status', 'PAUSED', 'ENABLED']);
  for (const sentence of [known.note, known.refusal]) {
    assert.match(sentence, /Google has been seen to switch on a new asset link that was sent PAUSED, so /);
    assert.doesNotMatch(sentence, /document|round/i);
  }
  assert.match(known.refusal, /^The owner policy forbids activation/);
  assert.match(known.refusal, /Nothing was sent\./);
});
