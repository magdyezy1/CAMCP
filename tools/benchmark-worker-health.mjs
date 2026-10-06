import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
const fixture = fileURLToPath(new URL('../tests/fixtures/worker-health-benchmark.mjs', import.meta.url)),
  rows = [];
const run = (mode, count, bytes) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, mode, String(count), String(bytes)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(Error('Owned worker-health benchmark exceeded its 30-second process deadline'));
    }, 30000);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 8192) child.kill();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.length > 8192) child.kill();
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(Error('Owned worker-health benchmark failed: ' + stderr.slice(0, 2000)));
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
for (const [count, bytes] of [
  [4, 0],
  [1000, 0],
  [1000, 4096],
])
  for (const mode of ['legacy', 'bounded']) rows.push(await run(mode, count, bytes));
console.log(
  JSON.stringify(
    {
      record_kind: 'isolated_synthetic_worker_health_projection_benchmark',
      source_sha256: (await import('node:crypto'))
        .createHash('sha256')
        .update(fs.readFileSync(fileURLToPath(new URL('../src/operations-worker-health.ts', import.meta.url))))
        .digest('hex'),
      rows,
      meaning:
        'Each reading mode runs in a separate owned process with an in-memory synthetic database. Result bytes, latency and process memory are observations, not a production capacity or faster-latency guarantee. Oversized heartbeats are deliberately unavailable in the bounded projection. No real tenant data or provider access is used.',
    },
    null,
    2,
  ),
);
