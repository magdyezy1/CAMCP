import test from 'node:test';
import assert from 'node:assert/strict';
import {runBounded} from './helpers/bounded-run.mjs';

// F-L9-01: a custom metric set that validation accepts must not stop the worker, and with it the website and the MCP
// endpoint, for every tenant. Each scenario runs in a worker thread that the test terminates if it does not finish, so
// a calculation that never ends fails here instead of stopping the run.
const limit = 20000;

test('a 30-metric chain over a non-additive metric (reach) is calculated in linear time', async () => {
  const result = await runBounded('summary-chain', {length: 30, leaf: 'reach'}, limit);
  assert.equal(result.finished, true, 'the summary of a 30-metric chain did not finish');
  assert.ok(result.ms < 1000, 'summary took ' + result.ms + ' ms');
  assert.ok(
    Object.entries(result.reasons)
      .filter(([key]) => /^m\d+$/.test(key))
      .every(([, reason]) => reason === 'non_additive_inputs'),
    'every metric of the chain says why several rows cannot give it a value',
  );
});

test('a 30-metric chain used as a KPI target is walked once per metric for advice', async () => {
  const result = await runBounded('advice-chain', {length: 30}, limit);
  assert.equal(result.finished, true, 'the advice for a 30-metric chain did not finish');
  assert.ok(result.ms < 1000, 'advice took ' + result.ms + ' ms');
  assert.equal(typeof result.decision, 'string');
});

for (const mode of ['A', 'B']) {
  test(`form ${mode} (a 30-metric chain${mode === 'B' ? ' and a custom KPI target' : ''}) through the real worker leaves the event loop free`, async () => {
    const result = await runBounded('pipeline', {mode, length: 30, rows: 3}, limit);
    assert.equal(result.finished, true, 'the report did not finish');
    assert.equal(result.state, 'complete', JSON.stringify(result.error));
    assert.equal(result.row_count, 3);
    assert.ok(result.longest_stall_ms < 1000, 'the event loop was stopped for ' + result.longest_stall_ms + ' ms');
    assert.ok(result.worker_ms < 5000, 'the job took ' + result.worker_ms + ' ms');
  });
}
