import test from 'node:test';
import assert from 'node:assert/strict';
import {runModelCase} from './helpers/plan-lifecycle-model.mjs';

/**
 * r25-planmodel, the second round: what the model of the campaign-plan lifecycle finds with the moves and the checks it was given after the review of 451169fd (M1 to M4: it had
 * found none of them, in 2,000 seeds, because it never read a plan while a call was executing it, never settled one step beside another that ran, and never judged what a step
 * keeps). Each case is a script of the model's own actions, run through all its invariants, and says which invariant it is red by on 451169fd; the seeds beside them are cases the
 * random draw found there (`moves`), which are green on this code.
 * Seed 9 is a plan of two budget creates and no policy of a second approver.
 */
const a = (k, more = {}) => ({k, who: 'O', plan: 'root', pick: 0, spec: {}, ...more});
const scripted = (seed, actions) => async () => {
  const result = await runModelCase({seed, actions, moves: true});
  assert.equal(result.ok, true, String(result.error?.message) + '\n' + result.trace.join('\n'));
};

test(
  'M1 (S1, the model; red by 14 on 451169fd): an execute that ends busy while the step was failed and amended leaves the amended step as it is',
  scripted(9, [
    a('prepare'),
    // The first execute waits for its target, which stays busy; the second sends the write, which the provider refuses, so the step is failed; the person amends it.
    a('execute', {spec: {park: {at: 'lock', mode: 'hold', busy: true}}}),
    a('execute', {spec: {writeFault: {kind: 'refuse', nth: 1}}}),
    a('recover', {step: 0}),
    a('release'),
  ]),
);

test(
  'M1 (S2, the model; red by 11a on 451169fd): an execute that ends busy while another call sent and verified the step does not take it back to ready',
  scripted(9, [
    a('prepare'),
    a('execute', {spec: {park: {at: 'lock', mode: 'hold', busy: true}}}),
    a('execute'),
    a('release'),
  ]),
);

test(
  'M2 (the model; red by 12 and 12b on 451169fd): while a call has sent the request, the reads name no execute, and following them leaves the step as it is',
  scripted(9, [
    a('prepare'),
    a('execute', {spec: {park: {at: 'written', nth: 1, mode: 'hold'}}}),
    a('follow'),
    a('follow', {pick: 3}),
  ]),
);

test(
  'M2 (the model; red by 11b on 451169fd): a second execute of a step whose request is going out leaves no refusal on the step the first one then verifies',
  scripted(9, [
    a('prepare'),
    a('execute', {spec: {park: {at: 'written', nth: 1, mode: 'hold'}}}),
    a('execute'),
    a('release'),
  ]),
);

test(
  'M4 (the model; red by 11c on 451169fd): two steps settled together leave the plan complete, not live',
  scripted(9, [
    a('prepare'),
    a('execute'),
    // The read-back of the first step disagrees now; the plan prepares and runs the second beside it, and a person settles the first while the second executes.
    a('inject', {step: 0}),
    a('prepare'),
    a('other', {spec: {park: {at: 'written', nth: 1, mode: 'hold'}}}),
    a('reconcile', {step: 0}),
    a('release'),
  ]),
);

// Cases the random draw found on 451169fd (1,200 seeds of the plan kinds with the moves: 105 red), each red there by the invariant named, and green here: 11c, two steps settled
// together leave the plan live (M4); 11a, a settled step taken back to ready (M1); 11b, a verified step with a refusal left on it, and 12, a read that names an execute of the step a
// call is executing (M2).
for (const [invariant, seeds] of [
  ['11c', [21, 151, 389]],
  ['11a', [1088]],
  ['11b', [583, 661, 1016]],
  ['12', [54, 69, 198]],
])
  for (const seed of seeds)
    test('the model, seed ' + seed + ' (red by ' + invariant + ' on 451169fd): moves and flavors', async () => {
      const result = await runModelCase({seed, flavors: true, moves: true});
      assert.equal(
        result.ok,
        true,
        'seed ' + seed + ': ' + String(result.error?.message) + '\n' + result.trace.join('\n'),
      );
    });
