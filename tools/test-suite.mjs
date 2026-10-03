import {spawnSync} from 'node:child_process';
import {availableParallelism} from 'node:os';

const setting = process.env.AMCP_TEST_CONCURRENCY,
  workers = setting === undefined ? undefined : Number(setting);
if (
  setting !== undefined &&
  (!Number.isInteger(workers) || workers < 1 || workers > 32 || String(workers) !== setting)
) {
  console.error('AMCP_TEST_CONCURRENCY must be an integer from 1 to 32. No tests were started.');
  process.exit(1);
}
console.log(
  JSON.stringify({
    event: 'test_suite_start',
    available_cpus: availableParallelism(),
    file_workers: workers ?? 'node_default',
    test_patterns: ['dist/tests/*.test.js', 'tests/*.test.mjs'],
  }),
);
const result = spawnSync(
  process.execPath,
  [
    '--test',
    ...process.argv.slice(2),
    ...(workers === undefined ? [] : ['--test-concurrency=' + workers]),
    'dist/tests/*.test.js',
    'tests/*.test.mjs',
  ],
  {stdio: 'inherit'},
);
if (result.error) console.error('The Node test runner could not start: ' + result.error.message);
process.exitCode = result.status ?? 1;
