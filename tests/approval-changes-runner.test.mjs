import test from 'node:test';
import assert from 'node:assert/strict';
import {rememberAccountMetadata} from '../dist/src/account-metadata.js';
import {approvalSummary} from '../dist/src/plan-approval.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {approve, fixture, tenantId} from './helpers/campaign-run-fixture.mjs';

/**
 * R2.5 package r25-approval-fields (the owner's friction report of 2026-11-25, B2): what the runner shows of a plan is the rows of what each step
 * changes, in the account's currency where the account is known, and the same read whichever call shows it. The stand-in for the local compile is
 * the fixture's effects map, whose entries hold the rows the real compile gives (tests/approval-changes.test.mjs checks those from real steps).
 */
const ids = ['go_a', 'go_b'];
const rows = {
  go_a: [
    {object: 'campaign', id: 'c1', field: 'daily_budget_micro', new: 62500000},
    {object: 'campaign', id: 'c1', field: 'status', new: 'PAUSED'},
  ],
  go_b: [{object: 'campaign', id: 'c2', field: 'end_time', new: '2026-12-06T23:59:00+0300'}],
};
const facts = (id, changes = rows[id]) => ({
  spend: id === 'go_a',
  destructive: false,
  irreversible: false,
  checked: true,
  operation: 'update',
  changes,
});
const effects = (changes = {}) => new Map(ids.map(id => [id, facts(id, changes[id])]));
const entry = (shown, id) => shown.approval.steps.find(s => s.id === id);

test('an approval shows the rows of each step, and approval_summary, approve and the step_id read give the same ones', async () => {
  const f = fixture({effects: effects()});
  try {
    const id = await f.plan(ids);
    await f.alice({action: 'preflight', id});
    const shown = await f.alice({action: 'approval_summary', id});
    assert.deepEqual(shown, await f.alice({action: 'approve', id}));
    const decorated = [{...rows.go_a[0], shown: '62.50 in account currency'}, rows.go_a[1]];
    assert.deepEqual(
      entry(shown, 'go_a').changes,
      decorated,
      'no account is known: the amount is in the account currency, whichever it is',
    );
    assert.deepEqual(entry(shown, 'go_b').changes, rows.go_b);
    assert.equal(shown.approval.accounts, undefined);
    const own = await f.alice({action: 'approval_summary', id, step_id: 'go_a'});
    assert.deepEqual(own.changes, decorated);
    assert.equal(own.changes_total, 2);
    assert.equal(own.summary_hash, shown.summary_hash);
  } finally {
    f.store.close();
  }
});

test('a known account gives the money its currency and the plan its accounts, and none of it is in the summary_hash', async () => {
  const f = fixture({effects: effects()});
  try {
    const id = await f.plan(ids);
    await f.alice({action: 'preflight', id});
    const bare = await f.alice({action: 'approval_summary', id});
    rememberAccountMetadata(f.store, tenantId, 'snap', '123', {
      name: 'Synthetic account',
      currency: 'EUR',
      timezone: 'Europe/Berlin',
    });
    const shown = await f.alice({action: 'approval_summary', id});
    assert.equal(shown.summary_hash, bare.summary_hash, 'what the account store says is not what the approver signs');
    assert.deepEqual(entry(shown, 'go_a').changes, [{...rows.go_a[0], shown: '62.50 EUR'}, {...rows.go_a[1]}]);
    assert.deepEqual(shown.approval.accounts, [
      {
        gateway: 'snapchat_native_action',
        account_id: '123',
        name: 'Synthetic account',
        currency: 'EUR',
        timezone: 'Europe/Berlin',
      },
    ]);
    assert.deepEqual((await f.alice({action: 'approval_summary', id, step_id: 'go_a'})).changes[0], {
      ...rows.go_a[0],
      shown: '62.50 EUR',
    });
    // What was shown is what is approved: the hash of this summary is the one approve checks.
    const {approved} = await approve(f, id);
    assert.equal(approved.approved?.by, 'alice');
  } finally {
    f.store.close();
  }
});

test('a value that changes after the summary was shown changes its summary_hash, and approving what was shown is refused PLAN_CHANGED', async () => {
  const f = fixture({effects: effects()});
  try {
    const id = await f.plan(ids);
    await f.alice({action: 'preflight', id});
    const shown = await f.alice({action: 'approval_summary', id});
    assert.match(shown.summary_hash, /^[0-9a-f]{64}$/);
    // The runner and the pure function agree: the hash is the summary's, whoever asks for it.
    assert.equal(shown.summary_hash, approvalSummary(f.stored(id), effects()).summary_hash);
    f.state.effects = effects({go_b: [{...rows.go_b[0], new: '2026-12-07T23:59:00+0300'}]});
    await assert.rejects(
      () => f.alice({...shown.next_call.arguments, ...shown.next_call.add_after_user_approval}),
      e => assertRefused(e, 'PLAN_CHANGED'),
    );
    const now = await f.alice({action: 'approval_summary', id});
    assert.notEqual(now.summary_hash, shown.summary_hash);
    assert.equal(entry(now, 'go_b').changes[0].new, '2026-12-07T23:59:00+0300');
    assert.equal(f.stored(id).approval?.plan_hash, undefined, 'nothing was recorded');
  } finally {
    f.store.close();
  }
});

// The review of 2026-11-26 (S3-1, the lead's ruling): the compact plan view stays at 11,264 bytes (src/campaign-view.ts planViewBudget), and the approval is
// part of it. Past it, the steps that do not fit take the explicit path (truncated, the step_id list, the website's Save locked until it is opened), the last
// steps first: no row is dropped without saying where it is.
const size = v => Buffer.byteLength(JSON.stringify(v));
const compactView = 11 * 1024;
/** `n` steps of one field each (an end date on its own ad set), every value different. */
const oneField = n => {
  const names = Array.from({length: n}, (_, i) => 'adset_' + String(i + 1).padStart(2, '0'));
  const row = (i, tail = '') => ({
    object: 'ad set',
    id: '1202' + String(100000000000 + i),
    field: 'end_time',
    new: '2026-12-' + String(10 + (i % 20)) + 'T23:59:00+0300' + i + tail,
  });
  return {
    names,
    row,
    effects: tail =>
      new Map(
        names.map((name, i) => [
          name,
          {
            spend: true,
            destructive: false,
            irreversible: false,
            checked: true,
            operation: 'update',
            changes: [row(i, i === n - 1 ? tail : '')],
          },
        ]),
      ),
  };
};
// [steps, a chain of depends_on, whether every step is listed]: independent steps, as the owner's plan of end dates has them, and a chain, which costs 28
// bytes a step more.
for (const [n, chained, whole] of [
  [24, false, true],
  [26, false, true],
  [30, false, true],
  [40, false, false],
  [30, true, false],
  [35, true, false],
]) {
  test(
    'a plan of ' +
      n +
      (chained ? ' chained' : '') +
      ' steps of one field each stays inside the compact view, and what does not fit is cut explicitly, the last steps first',
    async () => {
      const x = oneField(n),
        f = fixture({effects: x.effects('')});
      try {
        const id = chained
          ? await f.plan(x.names)
          : (
              await f.alice({
                action: 'create',
                name: 'End dates',
                brief: 'Synthetic.',
                steps: x.names.map(name => ({
                  id: name,
                  kind: 'write',
                  gateway: 'snapchat_native_action',
                  connection_id: 'snap',
                  account_id: '123',
                  description: name,
                  arguments: {action: 'snapchat_campaign_update', payload: {marker: name}},
                })),
              })
            ).id;
        await f.alice({action: 'preflight', id});
        const shown = await f.alice({action: 'approval_summary', id}),
          steps = shown.approval.steps,
          listed = steps.filter(s => s.changes),
          cut = steps.filter(s => s.truncated);
        assert.ok(size(shown) <= compactView, n + ' steps: the response is ' + size(shown) + ' bytes');
        assert.equal(listed.length + cut.length, n, 'every step lists its row or is cut, never dropped');
        listed.forEach(s => assert.deepEqual(s.changes, [x.row(x.names.indexOf(s.id))], s.id));
        // The cut steps are the last ones, say where their rows are and carry the empty aggregates an older web bundle reads.
        assert.ok(
          steps.slice(listed.length).every(s => s.truncated),
          'the last steps are the ones cut',
        );
        cut.forEach(s => assert.deepEqual(s.aggregates, [], s.id));
        assert.equal(shown.approval.truncated, cut.length ? true : undefined);
        assert.equal(!!shown.approval.step_fields, cut.length > 0);
        assert.equal(typeof shown.approval.changes_digest, cut.length ? 'string' : 'undefined');
        // The owner's plans of 24 and 26 steps, and one of 30, list every step; one of 40, or a chain of 30, cannot, and cuts the last ones.
        if (whole) assert.equal(cut.length, 0, n + ' steps list every step');
        else assert.ok(cut.length > 0 && cut.length < n, n + ' steps: the last are cut, the first are listed');
        // A cut step's own list holds its row whole, and a row that is not listed is bound by the summary_hash.
        for (const s of cut.slice(0, 2)) {
          const own = await f.alice({action: 'approval_summary', id, step_id: s.id});
          assert.deepEqual(own.changes, [x.row(x.names.indexOf(s.id))]);
          assert.equal(own.changes_total, 1);
        }
        if (cut.length) {
          f.state.effects = x.effects('-moved');
          const moved = await f.alice({action: 'approval_summary', id});
          assert.notEqual(moved.summary_hash, shown.summary_hash, 'a changed value in a cut step moves the hash');
        }
      } finally {
        f.store.close();
      }
    },
  );
}

test('a plan whose steps the compile could not read is shown as it was: no rows, no account', async () => {
  const f = fixture({effects: new Map(ids.map(id => [id, false]))});
  try {
    const id = await f.plan(ids);
    await f.alice({action: 'preflight', id});
    const shown = await f.alice({action: 'approval_summary', id});
    for (const s of shown.approval.steps) {
      assert.equal(s.changes, undefined, s.id);
      assert.equal(s.changes_total, undefined, s.id);
    }
    assert.equal(shown.approval.groups, undefined);
    assert.equal(shown.approval.step_fields, undefined);
  } finally {
    f.store.close();
  }
});
