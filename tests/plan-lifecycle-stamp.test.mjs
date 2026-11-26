import test from 'node:test';
import assert from 'node:assert/strict';
import {
  budgets,
  door,
  executeNext,
  gateTransport,
  holdTargetLock,
  planned,
  show,
  stored,
  withEnv,
} from './helpers/plan-lifecycle-kit.mjs';
import {xCatalogRemovalFixture as removalPlan} from './fixtures/x-catalog-removal.mjs';

/**
 * r25-planmodel, the third round (the second review of b96fdc7d): the execution stamp pinned (pn2-late, whose two mutants lived: the stamp not compared, and the whole `unsent`
 * condition removed), N2, the refusals of a second call of a step a call is executing (a flag of its own, writes disabled for it) saved whatever their code, and N3, the removal
 * path that left a resumed step executing.
 */
test('the stamp (pn2-late): a call cut off by its deadline whose step another call executes under a newer stamp leaves the step as that call has it', async () => {
  await withEnv('AMCP_WRITE_TARGET_WAIT_MS', '60000', async () => {
    const {x, id, review} = await planned(budgets(2)),
      lock = holdTargetLock(x, {only: true}),
      reply = door(),
      realNow = Date.now;
    let a, b;
    try {
      // A waits for its target, which stays busy for it; the clock then passes its deadline and the two minutes the step stays executing for.
      a = executeNext(x, id, review);
      await lock.waiting();
      const first = stored(x, id).steps[0].executing_at;
      Date.now = () => realNow() + 130000;
      // B resumes the same review under a newer stamp, and its write goes out; the provider's answer is held where B has sent it.
      const gate = gateTransport(x);
      gate.rules = [{kind: 'write', nth: 1, hold: reply.p, when: 'after'}];
      b = executeNext(x, id, review);
      await gate.arrived();
      const second = stored(x, id).steps[0].executing_at;
      assert.equal(stored(x, id).steps[0].status, 'executing');
      assert.ok(second > first, 'B stamped the step later than A did');
      // A ends at its next try for the target: busy, and nothing sent. Its outcome is not the step's now: the step is B's, which is sending it.
      const ended = await a;
      assert.equal(ended.success, true, JSON.stringify(ended.error ?? ended).slice(0, 300));
      assert.equal(show(x, id), 'in_progress [step1=executing]', 'the step is still being executed by B');
      assert.equal(stored(x, id).steps[0].executing_at, second, 'under B’s stamp');
      reply.open();
      const done = await b;
      assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
      assert.equal(show(x, id), 'complete [step1=verified]');
      assert.equal(x.writes(), 1, 'sent once');
    } finally {
      reply.open();
      lock.release();
      await Promise.allSettled([a, b]);
      Date.now = realNow;
      x.store.close();
    }
  });
});

/** A second call of a step the first call is executing, refused for something of its own: nothing of it is the step's (N2). */
const secondCall = {
  'a flag the review does not take (creative_edit_confirmed)': (x, id, review) =>
    executeNext(x, id, review, {creative_edit_confirmed: true}),
  'writes disabled for the call': async (x, id, review) => {
    x.service.policy.allowWrites = false;
    try {
      return await executeNext(x, id, review);
    } finally {
      x.service.policy.allowWrites = true;
    }
  },
};
for (const [mistake, call] of Object.entries(secondCall)) {
  test(
    'N2: while the first call has claimed nothing (it waits for its target), a second call refused for ' +
      mistake +
      ' saves nothing: the step is still the first call’s, and it finishes it',
    async () => {
      const {x, id, review} = await planned(budgets(2)),
        lock = holdTargetLock(x, {only: true});
      let a;
      try {
        a = executeNext(x, id, review);
        await lock.waiting();
        const b = await call(x, id, review);
        assert.equal(show(x, id), 'in_progress [step1=executing]', 'the step is not failed by the second call');
        assert.equal(stored(x, id).steps[0].error, undefined);
        assert.equal(b.success, true, JSON.stringify(b.error ?? b).slice(0, 300));
        assert.match(
          String(b.data.notice),
          /is being executed by another call/,
          'B is told the step is being executed',
        );
        lock.release();
        const done = await a;
        assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
        assert.equal(show(x, id), 'complete [step1=verified]');
        assert.equal(x.writes(), 1, 'sent once, by the first call');
      } finally {
        lock.release();
        await a?.catch(() => {});
        x.store.close();
      }
    },
  );

  test(
    'N2: while the first call is sending (its request is out), a second call refused for ' +
      mistake +
      ' saves nothing: the step does not read failed until the first call ends',
    async () => {
      const {x, id, review} = await planned(budgets(2)),
        gate = gateTransport(x),
        reply = door();
      let a;
      try {
        gate.rules = [{kind: 'write', nth: 1, hold: reply.p, when: 'after'}];
        a = executeNext(x, id, review);
        await gate.arrived();
        const b = await call(x, id, review);
        assert.equal(stored(x, id).steps[0].status, 'executing', 'the step is still executing: ' + show(x, id));
        assert.equal(stored(x, id).steps[0].error, undefined);
        assert.equal(b.success, true, JSON.stringify(b.error ?? b).slice(0, 300));
        assert.match(String(b.data.notice), /is being executed by another call/);
        reply.open();
        const done = await a;
        assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
        assert.equal(stored(x, id).steps[0].status, 'verified');
        assert.equal(x.writes(), 1);
      } finally {
        reply.open();
        await a?.catch(() => {});
        x.store.close();
      }
    },
  );
}

test('N3: a step a crash left executing, resumed by an execute whose removal preview has changed, is not left executing: its review is refused as changed and it goes back to pending', async t => {
  const f = removalPlan(t),
    tenant = f.actor.tenantId,
    preview = await f.preview(),
    saved = await f.save(preview.data),
    prepared = await f.campaign({action: 'prepare_next', id: saved.data.id});
  assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 300));
  // A crash left the first step executing, longer ago than the two minutes it stays one call's.
  const {id: _id, revision, ...data} = f.store.document(tenant, 'campaign_run', saved.data.id);
  data.steps[0].status = 'executing';
  data.steps[0].executing_at = Date.now() - 180000;
  data.state = 'in_progress';
  f.store.putDocument(tenant, 'campaign_run', saved.data.id, data, revision);
  f.items[9001][0].title = 'Different current selected product';
  // The removal's own check is not asked of an executing step (assertCatalogRemovalStep: its request may have been sent), so the removal block of executeNext never holds a
  // step that was executing: the review's state check refuses the resume, and the step goes back to pending for a new review, as a step the check refused always does.
  const result = await f.campaign({...prepared.data.next_call.arguments, spend_change_confirmed: true});
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 300));
  const step = f.store.document(tenant, 'campaign_run', saved.data.id).steps[0];
  assert.equal(step.status, 'pending', 'not left executing: ' + step.status);
  assert.equal(step.error.code, 'STATE_CHANGED');
  assert.equal(step.executing_at, undefined);
  assert.equal(f.writes(), 0);
});
