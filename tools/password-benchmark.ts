import {performance} from 'node:perf_hooks';
import {hashUserPassword, verifyPassword} from '../server/user-accounts.js';
const durations: number[] = [];
for (let i = 0; i < 5; i++) {
  const start = performance.now();
  const hash = await hashUserPassword('Synthetic benchmark passphrase ' + i);
  if (!(await verifyPassword('Synthetic benchmark passphrase ' + i, hash)))
    throw Error('Password verification failed.');
  durations.push(performance.now() - start);
}
process.stdout.write(
  JSON.stringify(
    {
      algorithm: 'scrypt v3',
      N: 32768,
      r: 8,
      p: 3,
      concurrency_limit: 4,
      measurement: 'One hash plus one verification per sample',
      samples_ms: durations.map(n => Math.round(n)),
      average_ms: Math.round(durations.reduce((a, b) => a + b) / durations.length),
      guidance:
        'Run on the production-sized machine. Allow at least 64 MiB per concurrent scrypt operation; do not lower security parameters to hide CPU saturation.',
    },
    null,
    2,
  ) + '\n',
);
