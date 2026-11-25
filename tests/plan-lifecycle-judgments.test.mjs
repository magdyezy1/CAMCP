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
  // 5b: a plan that can still run does not hold a retired review as the review of a step that waits for it.
  const waiting = (state, status, retired = true) => {
    const model = new PlanModel(1);
    model.liveHoldsRetired(
      snapOf({p: plan(state, {steps: [{id: 's', review_id: 'r', status}]})}, {r: retired ? mark('cancelled') : {}}),
    );
    return model.violations.map(v => v.invariant);
  };
  assert.deepEqual(
    waiting('awaiting_review', 'review_ready'),
    ['5b'],
    'a cancel that retired the review and did not save',
  );
  assert.deepEqual(waiting('in_progress', 'executing'), ['5b'], 'and the step it left executing');
  assert.deepEqual(waiting('cancelled', 'review_ready'), [], 'a cancelled plan holds what it retired');
  assert.deepEqual(
    waiting('attention', 'failed'),
    [],
    'a step that is amended in two saves holds the review it went on from',
  );
  assert.deepEqual(waiting('awaiting_review', 'review_ready', false), [], 'and a review nothing retired');
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
  // 10b: a plan that continues a bound plan carries what bound it.
  const bound = (key, carried) =>
    judge(
      lineage,
      snapOf({
        a: plan('superseded', {superseded_by: {id: 'b'}, [key]: {id: 'x'}}),
        b: plan('draft', {supersedes: {id: 'a'}, ...(carried ? {[key]: {id: 'x'}} : {})}),
      }),
    );
  for (const key of ['activation_of', 'catalog_retirement']) {
    assert.deepEqual(bound(key, false), ['10b'], 'a continuation without its ' + key);
    assert.deepEqual(bound(key, true), [], 'and with it');
  }
  // 10a and 8: no claim in the lineage of an activation plan whose gates refuse, and a plan that activates a launch is governed whatever its steps set.
  const claimed = (kind, policyOn, activates) => {
    const model = new PlanModel(1),
      steps = [
        {
          id: 's',
          review_id: 'r',
          status: 'review_ready',
          arguments: {action: 'google_ads_v23_campaign_mutate_campaigns'},
        },
      ],
      plans = activates
        ? {
            a: plan('superseded', {superseded_by: {id: 'p'}, activation_of: {id: 'x'}}),
            p: plan('in_progress', {steps, supersedes: {id: 'a'}}),
          }
        : {p: plan('in_progress', {steps})};
    Object.assign(model, {kind, policyOn});
    model.onFreshClaim('r', {kind: 'execute', approvedAtStart: false}, snapOf(plans, {r: {}}));
    return model.claimChecks.flatMap(c => c.issues.map(i => i[0]));
  };
  assert.deepEqual(claimed('activation_closed', false, true), ['10a'], 'a claim where the gates refuse');
  assert.deepEqual(
    claimed('activation_open', false, true),
    [],
    'where the gates passed, and no policy asks for another person',
  );
  assert.deepEqual(
    claimed('activation_open', true, true),
    ['8'],
    'an activation continued with no approval by another person',
  );
  assert.deepEqual(
    claimed('plain', true, false),
    [],
    'a plan that activates nothing and sets no money field is not governed',
  );
  // 11 and 14, and 12: what a step and a plan keep, and what a read names while a call is executing the step (the review of 451169fd).
  const keeps = (plans, {quiet = false, reviews = {}, claims = [], seen = [], approved = []} = {}) => {
    const model = new PlanModel(1),
      snap = snapOf(plans, reviews);
    for (const key of seen) model.settledSeen.set(key, true);
    for (const [id, hash] of approved) model.approvalSeen.set(id, hash);
    snap.claims = new Map(claims);
    model.stepsKeep(snap, quiet);
    return model.violations.map(v => v.invariant);
  };
  const step = (status, more = {}) => ({id: 's', kind: 'write', review_id: 'r', status, review: {}, ...more});
  assert.deepEqual(
    keeps({p: plan('in_progress', {steps: [step('review_ready')]})}, {seen: ['p/s']}),
    ['11a'],
    'a settled step ready again',
  );
  assert.deepEqual(
    keeps({p: plan('in_progress', {steps: [step('verifying')]})}, {seen: ['p/s']}),
    ['11a'],
    'a settled step verifying again',
  );
  assert.deepEqual(
    keeps({p: plan('in_progress', {steps: [step('verified'), step('failed', {id: 't'})]})}, {seen: ['p/s']}),
    [],
    'a settled step that stays, and one that was never settled',
  );
  const verified = (error, claims) =>
    keeps(
      {
        p: plan('in_progress', {
          steps: [
            step('verified', error ? {error: {code: 'WRITE_OUTCOME_UNCERTAIN'}} : {}),
            step('pending', {id: 't'}),
          ],
        }),
      },
      {quiet: true, reviews: {r: {}}, claims},
    );
  assert.deepEqual(verified(true, [['r', 'complete']]), ['11b'], 'a verified step with a refusal left on it');
  assert.deepEqual(verified(false, []), ['11b'], 'a verified step whose claim is not complete');
  assert.deepEqual(verified(false, [['r', 'complete']]), [], 'a verified step that is as it should be');
  assert.deepEqual(
    keeps(
      {p: plan('in_progress', {steps: [step('verified', {error: {code: 'X'}})]})},
      {quiet: false, reviews: {r: {}}, claims: [['r', 'complete']]},
    ).filter(i => i === '11b'),
    [],
    'nothing is judged while a call is in flight',
  );
  const done = (state, steps = [step('verified')]) =>
    keeps({p: plan(state, {steps})}, {quiet: true, reviews: {r: {}}, claims: [['r', 'complete']]});
  assert.deepEqual(done('in_progress'), ['11c'], 'every step settled and the plan live');
  assert.deepEqual(done('attention'), ['11c']);
  assert.deepEqual(done('complete'), [], 'and complete');
  assert.deepEqual(
    done('in_progress', [step('verified'), step('pending', {id: 't'})]),
    [],
    'a plan with a step left to run',
  );
  assert.deepEqual(
    keeps({p: plan('in_progress', {plan_hash: 'h'})}, {approved: [['p', 'h']]}),
    ['11e'],
    'an approval of the current hash taken away',
  );
  assert.deepEqual(
    keeps({p: plan('in_progress', {plan_hash: 'g'})}, {approved: [['p', 'h']]}),
    [],
    'an approval of a hash the plan has left',
  );
  assert.deepEqual(
    keeps({p: plan('in_progress', {plan_hash: 'h', approval: {plan_hash: 'h'}})}, {approved: [['p', 'h']]}),
    [],
    'an approval that stands',
  );
  assert.deepEqual(
    keeps({p: plan('awaiting_review', {steps: [step('review_ready', {review: undefined})]})}),
    ['14'],
    'a step ready that holds no review',
  );
  assert.deepEqual(
    keeps({p: plan('in_progress', {steps: [step('executing', {review_id: undefined})]})}),
    ['14'],
    'a step executing that holds no review',
  );
  assert.deepEqual(
    keeps({p: plan('awaiting_review', {steps: [step('review_ready')]})}),
    [],
    'a step ready that holds its review',
  );
  assert.deepEqual(
    keeps({p: plan('cancelled', {steps: [step('review_ready', {review: undefined})]})}),
    [],
    'a plan that was cancelled holds what it held',
  );
  const names = (status, skew = 0) => {
    const model = new PlanModel(1),
      named = {tool: 'amcp_campaign', arguments: {action: 'execute_next', id: 'p', review_id: 'r'}};
    model.skew = skew;
    model.judgeNamed(named, 'get', snapOf({p: plan('in_progress', {steps: [step(status)]})}));
    return model.violations.map(v => v.invariant);
  };
  assert.deepEqual(names('executing'), ['12'], 'a read names an execute of the step that is executing');
  assert.deepEqual(names('review_ready'), [], 'of a step that is ready, which is what execute_next is for');
  assert.deepEqual(names('executing', 3 * 60000), [], 'once the crashed calls’ time has run out');
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
