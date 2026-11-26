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
const scripted =
  (seed, actions, options = {}) =>
  async () => {
    const result = await runModelCase({seed, actions, moves: true, ...options});
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

// M8: a bound plan an earlier release held for a continuation it never made. Seed 8 is an activation plan whose gates refuse, seed 27 a plan that retires catalog products.
// The reads and the refusals of a person (the owner, and the editor who is not the one who held it) name the read, then, once the hold is stale (the recovery moves the clock),
// the cancel that releases it, and never continue_as_new (7e; on b96fdc7d it is named, and its refusal names the read again).
for (const seed of [8, 27])
  test(
    'M8 (the model, seed ' +
      seed +
      '; red by 7e on b96fdc7d): a bound plan held by an earlier release is read, then cancelled, and never offered the continuation',
    scripted(
      seed,
      [a('hold'), a('get'), a('get', {who: 'E', full: true}), a('continue', {who: 'E'}), a('continue'), a('prepare')],
      {
        flavors: true,
        holds: true,
      },
    ),
  );

// The actions of the third round (the second review of b96fdc7d: the model had no `run`, no assign or unassign, no write pause and no clock step). Each case is a script of the model's own
// actions through all its invariants; the random draw of them is `extras`, which the model test runs as its third variant.
const extras = {extras: true};
test('run (the model): the plan runs under its approval', scripted(9, [a('approve'), a('run')], extras));
test(
  'run (the model): a run whose process stops where its first request has been answered leaves the step to the reads, and none sends it twice',
  scripted(9, [a('approve'), a('run', {spec: {park: {at: 'written', nth: 1, mode: 'crash'}}})], extras),
);
test(
  'unassign (the model, M5): a person whose write is in flight loses the plan, and its outcome is saved all the same',
  scripted(
    9,
    [
      a('prepare', {who: 'E'}),
      a('execute', {who: 'E', spec: {park: {at: 'written', nth: 1, mode: 'hold'}}}),
      a('unassign'),
      a('release'),
      a('assign'),
    ],
    extras,
  ),
);
test(
  'pause (the model): a call a write pause refuses leaves its step ready, and the owner’s resume lets it go on',
  scripted(9, [a('prepare'), a('pause'), a('execute'), a('resume'), a('execute')], extras),
);
test(
  'clock (the model): six minutes pass over a ready step, whose review has expired: it is prepared again, and sent once',
  scripted(9, [a('prepare'), a('clock'), a('execute'), a('prepare'), a('execute')], extras),
);

// The random draw with `holds`: on b96fdc7d 57 of 400 seeds are red by 7e (the three below are among them), green here.
for (const seed of [6, 9, 10])
  test('the model, seed ' + seed + ' (red by 7e on b96fdc7d): moves, flavors and holds', async () => {
    const result = await runModelCase({seed, flavors: true, moves: true, holds: true});
    assert.equal(
      result.ok,
      true,
      'seed ' + seed + ': ' + String(result.error?.message) + '\n' + result.trace.join('\n'),
    );
  });

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
