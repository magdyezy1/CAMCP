import test from 'node:test';
import assert from 'node:assert/strict';
import {PlanModel} from './helpers/plan-lifecycle-model.mjs';

/**
 * The judgments are not vacuous: each one is given a state it must refuse, and the state it must accept. (The cases above find nothing when the product is right,
 * so they could not tell a judgment that was never made.)
 */
test('the invariants refuse what they are for, and accept what the product may do', () => {
  const judge = (check, ...snaps) => {
      const model = new PlanModel(1);
      for (const snap of snaps) {
        model.violations.length = 0;
        check(model, snap);
      }
      return model.violations.map(v => v.invariant);
    },
    plan = (state, extra = {}) => ({state, steps: [], ...extra}),
    snapOf = (plans, reviews = {}) => ({
      plans: new Map(Object.entries(plans)),
      reviews: new Map(Object.entries(reviews)),
      claims: new Map(),
    });
  // 1: a lineage has one live plan.
  const lineage = (model, snap) => model.lineage(snap);
  assert.deepEqual(
    judge(
      lineage,
      snapOf({
        a: plan('superseded', {superseded_by: {id: 'b'}}),
        b: plan('draft', {supersedes: {id: 'a'}}),
        c: plan('awaiting_review', {supersedes: {id: 'a'}}),
      }),
    ),
    ['1'],
    'two continuations of one plan are both live',
  );
  assert.deepEqual(
    judge(
      lineage,
      snapOf({
        a: plan('superseded', {superseded_by: {pending: true, to: 'b'}}),
        b: plan('draft'),
        c: plan('draft', {supersedes: {id: 'a'}}),
      }),
    ),
    ['1'],
    'a hold links the plan its key names, and a second person’s plan is linked by its own supersedes',
  );
  assert.deepEqual(
    judge(
      lineage,
      snapOf({
        a: plan('superseded', {superseded_by: {id: 'b'}}),
        b: plan('draft', {supersedes: {id: 'a'}}),
        c: plan('draft'),
      }),
    ),
    [],
    'two plans that are not one lineage may both be live',
  );
  // 5: a mark stays as written; a cancelled plan does not become live again.
  const marks = (model, snap) => model.marksAndStates(snap);
  const mark = (reason, at = 1) => ({retired: {plan_id: 'p', step_id: 's', reason, at}});
  const seen = model => {
    model.marks.set('r', JSON.stringify(['p', 's', 'cancelled', 1]));
    model.lastState.set('p', {state: 'cancelled', held: false});
  };
  const withMark = (then, plans) => {
    const model = new PlanModel(1);
    seen(model);
    marks(model, snapOf(plans, {r: then}));
    return model.violations.map(v => v.invariant);
  };
  assert.deepEqual(withMark(mark('cancelled'), {p: plan('cancelled')}), [], 'a mark that is as it was');
  assert.deepEqual(withMark(mark('continued', 2), {p: plan('cancelled')}), ['5'], 'a cancel’s mark overwritten');
  assert.deepEqual(withMark({}, {p: plan('cancelled')}), ['5'], 'a cancel’s mark removed');
  assert.deepEqual(withMark(mark('cancelled'), {p: plan('draft')}), ['5'], 'a cancelled plan live again');
  assert.deepEqual(
    withMark(mark('cancelled'), {p: plan('superseded', {superseded_by: {id: 'q'}})}),
    [],
    'a cancelled plan that was continued',
  );
  const reopened = new PlanModel(1);
  reopened.marks.set('r', JSON.stringify(['p', 's', 'continued', 1]));
  reopened.lastState.set('p', {state: 'draft', held: false});
  marks(reopened, snapOf({p: plan('draft')}, {r: {}}));
  assert.deepEqual(
    reopened.violations.map(v => v.invariant),
    [],
    'a failed continuation takes back its own mark from a plan that is live again',
  );
  const reopenedCancelled = new PlanModel(1);
  reopenedCancelled.marks.set('r', JSON.stringify(['p', 's', 'continued', 1]));
  reopenedCancelled.lastState.set('p', {state: 'cancelled', held: false});
  marks(reopenedCancelled, snapOf({p: plan('cancelled')}, {r: {}}));
  assert.deepEqual(
    reopenedCancelled.violations.map(v => v.invariant),
    ['5'],
    'and does not take it back from a plan that was cancelled',
  );
  // 4: a review a plan went on from carries its mark.
  const gone = new PlanModel(1);
  gone.gone.set('r', {plan: 'p', step: 's', reason: 'amended'});
  gone.marksAndStates(snapOf({p: plan('draft')}, {r: {}}));
  assert.deepEqual(
    gone.violations.map(v => v.invariant),
    ['4'],
    'a review the step went on from with no mark',
  );
  gone.violations.length = 0;
  gone.marksAndStates(snapOf({p: plan('draft')}, {r: mark('amended')}));
  assert.deepEqual(gone.violations, [], 'and the same review once it is marked');
  // 7: no read names a standalone replacement of the review of a step left executing (an uncertain step is replaced as it always was, R2.5 M2).
  const reads = new PlanModel(1),
    holds = status => snapOf({p: plan('in_progress', {steps: [{id: 's', review_id: 'r', status}]})}),
    replacement = id => ({tool: 'amcp_write', arguments: {action: 'prepare', supersedes_review_id: id}});
  reads.judgeNamed(replacement('r'), 'status', holds('executing'));
  assert.deepEqual(
    reads.violations.map(v => v.invariant),
    ['7c'],
    'a replacement of the review of the step left executing',
  );
  reads.violations.length = 0;
  reads.judgeNamed(replacement('r'), 'status', holds('uncertain'));
  reads.judgeNamed(replacement('other'), 'status', holds('executing'));
  reads.judgeNamed(
    {tool: 'amcp_campaign', arguments: {action: 'get', id: 'p', step_id: 's'}},
    'reconcile',
    holds('executing'),
  );
  assert.deepEqual(
    reads.violations,
    [],
    'the replacement of an uncertain step, of a review no step holds, and the step read',
  );
  // The transitions a plan may make.
  const model = new PlanModel(1);
  const legal = (was, now) => model.legal({state: was[0], held: !!was[1]}, {state: now[0], held: !!now[1]});
  assert.equal(legal(['draft'], ['cancelled']), true);
  assert.equal(legal(['complete'], ['cancelled']), true);
  assert.equal(legal(['cancelled'], ['superseded']), true);
  assert.equal(legal(['superseded', true], ['draft']), true, 'a hold that is released puts the plan back');
  assert.equal(legal(['cancelled'], ['draft']), false);
  assert.equal(legal(['superseded'], ['cancelled']), false);
  assert.equal(legal(['superseded'], ['draft']), false);
  assert.equal(legal(['complete'], ['draft']), false);
});
