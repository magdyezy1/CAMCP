import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSeeds, runModelCase} from './helpers/plan-lifecycle-model.mjs';

/**
 * r25-planmodel: one seeded, randomized test of the campaign-plan lifecycle (tests/helpers/plan-lifecycle-model.mjs says what a case is and which invariants it
 * judges). The errors package needed seven review rounds to find what a model like this finds in one run: two people continuing one plan made two live plans, a
 * retired review could still execute, a failed continuation reopened a cancelled plan's review, a cancel that landed at the wrong moment was undone. A case is a
 * seed, so a failure names the seed and prints the actions it took; the same seed gives the same case. The seeds below are fixed, so the run is the same on every
 * machine; AMCP_MODEL_SEEDS runs others (a count, 1..N; a range, 300-900; or a list, 7,41,154), which is how a longer local run goes looking for more.
 * A case is a plain plan, an activation plan whose read-only gates pass or refuse, or a plan that retires catalog products (`flavors`, drawn from the seed): the plans an
 * activation or a retirement binds are the ones a continuation once made without their gates, their second approver and their check of the catalog.
 */
const seeds = parseSeeds(process.env.AMCP_MODEL_SEEDS, parseSeeds('200'));

test('the campaign-plan lifecycle keeps its invariants over ' + seeds.length + ' seeded cases', async t => {
  const failures = [],
    started = Date.now();
  for (const seed of seeds) {
    const result = await runModelCase({seed, flavors: true});
    if (!result.ok) failures.push(result);
  }
  t.diagnostic(seeds.length + ' seeds in ' + Math.round((Date.now() - started) / 100) / 10 + ' s');
  if (!failures.length) return;
  const detail = failures
    .slice(0, 3)
    .map(
      f =>
        'seed ' +
        f.seed +
        ': ' +
        String(f.error.stack && !f.error.invariant ? f.error.stack : f.error.message) +
        (f.error.after ? ' (' + f.error.after + ')' : '') +
        '\n  replay: AMCP_MODEL_SEEDS=' +
        f.seed +
        ' node --test tests/plan-lifecycle-model.test.mjs\n  actions: ' +
        JSON.stringify(f.actions) +
        '\n' +
        f.trace.map(line => '    ' + line).join('\n'),
    )
    .join('\n\n');
  assert.fail(
    failures.length +
      ' of ' +
      seeds.length +
      ' seeds violated an invariant:\n' +
      failures.map(f => '  seed ' + f.seed + ': ' + String(f.error.message).split('\n')[0]).join('\n') +
      '\n\n' +
      detail,
  );
});
