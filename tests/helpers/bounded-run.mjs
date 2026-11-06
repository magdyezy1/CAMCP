import {Worker} from 'node:worker_threads';

/**
 * Runs `scenario` of tests/helpers/calculation-scenarios.mjs in a worker thread and reports how it ended and how long
 * the thread's event loop was unable to run anything (a 5 ms timer in the worker records the longest gap). A scenario
 * that has not finished after `limitMs` is terminated, so a calculation that never ends fails its test instead of
 * stopping the test run.
 */
export function runBounded(scenario, args = {}, limitMs = 20000) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./calculation-scenarios.mjs', import.meta.url), {
      workerData: {scenario, args},
    });
    const started = performance.now();
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({...result, wall_ms: performance.now() - started});
    };
    const timer = setTimeout(() => {
      worker.terminate();
      finish({finished: false});
    }, limitMs);
    worker.once('message', message => {
      finish({finished: true, ...message});
      worker.terminate();
    });
    worker.once('error', error => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}
