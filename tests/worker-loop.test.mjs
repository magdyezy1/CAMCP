import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {runWorkerLoop} from '../dist/src/worker-loop.js';
import {Store} from '../dist/src/store.js';
import {ReportWorker} from '../dist/src/worker.js';
import {removeTestDirectory} from '../dist/tests/temp.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return {promise, resolve};
}
function fixture() {
  const events = [],
    failures = [],
    pauses = [];
  let stopping = false;
  return {
    events,
    failures,
    pauses,
    stop() {
      stopping = true;
    },
    options: {
      schedule: () => events.push('schedule'),
      deliverEmails: async () => events.push('email_delivery'),
      work: async () => {
        events.push('job');
        return false;
      },
      shouldStop: () => stopping,
      onFailure: failure => failures.push(failure),
      pause: async ms => {
        pauses.push(ms);
        stopping = true;
      },
    },
  };
}

test('the shared worker drains successful work immediately and paces its next idle cycle', async () => {
  const f = fixture();
  let jobs = 0;
  f.options.work = async () => {
    f.events.push('job');
    return ++jobs < 3;
  };
  await runWorkerLoop(f.options);
  assert.deepEqual(f.events, [
    'schedule',
    'email_delivery',
    'job',
    'schedule',
    'email_delivery',
    'job',
    'schedule',
    'email_delivery',
    'job',
  ]);
  assert.deepEqual(f.pauses, [1000]);
  assert.deepEqual(f.failures, []);
});

for (const stage of ['schedule', 'email_delivery', 'job'])
  test(`continuous recovery paces an original ${stage} failure before the next complete cycle`, async () => {
    const f = fixture(),
      error = Object.assign(Error('synthetic confidential native argument'), {code: 'SYNTHETIC_STAGE_REFUSED'});
    let failed = false;
    const failOnce = () => {
      if (!failed) {
        failed = true;
        throw error;
      }
    };
    f.options.schedule = () => {
      f.events.push('schedule');
      if (stage === 'schedule') failOnce();
    };
    f.options.deliverEmails = async () => {
      f.events.push('email_delivery');
      if (stage === 'email_delivery') failOnce();
    };
    f.options.work = async () => {
      f.events.push('job');
      if (stage === 'job') failOnce();
      f.stop();
      return true;
    };
    f.options.pause = async ms => {
      f.pauses.push(ms);
      f.events.push('pause');
    };
    await runWorkerLoop(f.options);
    const first = ['schedule', 'email_delivery', 'job'].slice(
      0,
      ['schedule', 'email_delivery', 'job'].indexOf(stage) + 1,
    );
    assert.deepEqual(f.events, [...first, 'pause', 'schedule', 'email_delivery', 'job']);
    assert.deepEqual(f.pauses, [1000]);
    assert.equal(f.failures.length, 1);
    assert.equal(f.failures[0].stage, stage);
    assert.equal(f.failures[0].event, 'worker_stage_failed');
    assert.equal(f.failures[0].code, 'SYNTHETIC_STAGE_REFUSED');
    assert.equal(f.failures[0].consecutive_failures, 1);
    assert.doesNotMatch(JSON.stringify(f.failures), /confidential|native argument|stack/);
  });

test('consecutive failure counts reset after a successful cycle and failures never spin without pacing', async () => {
  const f = fixture(),
    actions = ['fail', 'fail', 'worked', 'fail', 'stop'];
  f.options.work = async () => {
    f.events.push('job');
    const action = actions.shift();
    assert.ok(action);
    if (action === 'fail') throw Object.assign(Error('synthetic'), {code: 'SYNTHETIC_FAILURE'});
    if (action === 'stop') f.stop();
    return action === 'worked';
  };
  f.options.pause = async ms => f.pauses.push(ms);
  await runWorkerLoop(f.options);
  assert.deepEqual(f.pauses, [1000, 1000, 1000]);
  assert.deepEqual(
    f.failures.map(failure => failure.consecutive_failures),
    [1, 2, 1],
  );
  assert.equal(f.events.filter(event => event === 'job').length, 5);
  assert.equal(actions.length, 0);
});

test('stage diagnostics retain only the existing bounded native code and metadata', async () => {
  const f = fixture(),
    codes = [undefined, null, 123, 'lowercase', 'SECRET/token', 'X'.repeat(81), 'NATIVE_FAILURE_5'];
  let index = 0;
  f.options.schedule = () => {
    throw Object.assign(Error('DO_NOT_LOG_SYNTHETIC_SECRET'), {
      code: codes[index++],
      access_token: 'DO_NOT_LOG_SYNTHETIC_SECRET',
    });
  };
  f.options.pause = async ms => {
    f.pauses.push(ms);
    if (index === codes.length) f.stop();
  };
  await runWorkerLoop(f.options);
  assert.equal(f.failures.length, codes.length);
  assert.equal(f.pauses.length, codes.length);
  assert.ok(f.pauses.every(ms => ms === 1000));
  for (const [i, failure] of f.failures.entries()) {
    assert.deepEqual(Object.keys(failure).sort(), ['at', 'code', 'consecutive_failures', 'event', 'stage']);
    assert.equal(failure.code, i === codes.length - 1 ? 'NATIVE_FAILURE_5' : 'WORKER_STAGE_FAILED');
    assert.equal(failure.consecutive_failures, i + 1);
    assert.equal(new Date(failure.at).toISOString(), failure.at);
  }
  assert.doesNotMatch(JSON.stringify(f.failures), /DO_NOT_LOG|access_token|SECRET\/token|stack|message/);
});

test('explicit once mode runs one successful or idle cycle without an extra delay or claim', async () => {
  for (const worked of [true, false]) {
    const f = fixture();
    f.options.onceOnly = true;
    f.options.work = async () => {
      f.events.push('job');
      return worked;
    };
    await runWorkerLoop(f.options);
    assert.deepEqual(f.events, ['schedule', 'email_delivery', 'job']);
    assert.deepEqual(f.pauses, []);
    assert.deepEqual(f.failures, []);
  }
});

test('explicit once mode preserves and propagates each original stage error after recording safe metadata', async () => {
  for (const stage of ['schedule', 'email_delivery', 'job']) {
    const f = fixture(),
      error = Object.assign(Error('synthetic one-shot failure'), {code: 'SYNTHETIC_ONCE_FAILED'});
    f.options.onceOnly = true;
    const fail = () => {
      throw error;
    };
    if (stage === 'schedule') f.options.schedule = fail;
    if (stage === 'email_delivery') f.options.deliverEmails = async () => fail();
    if (stage === 'job') f.options.work = async () => fail();
    await assert.rejects(runWorkerLoop(f.options), actual => actual === error);
    assert.deepEqual(f.pauses, []);
    assert.equal(f.failures.length, 1);
    assert.equal(f.failures[0].stage, stage);
    assert.equal(f.failures[0].code, 'SYNTHETIC_ONCE_FAILED');
  }
});

test('a stop observed before a cycle or after schedule prevents starting a new mail or job stage', async () => {
  const before = fixture();
  before.stop();
  await runWorkerLoop(before.options);
  assert.deepEqual(before.events, []);
  const scheduled = fixture();
  scheduled.options.schedule = () => {
    scheduled.events.push('schedule');
    scheduled.stop();
  };
  await runWorkerLoop(scheduled.options);
  assert.deepEqual(scheduled.events, ['schedule']);
  assert.deepEqual(scheduled.pauses, []);
});

test('shutdown waits for an in-flight email delivery without starting a job afterward', async () => {
  const f = fixture(),
    entered = deferred(),
    release = deferred();
  f.options.deliverEmails = async () => {
    f.events.push('email_delivery');
    entered.resolve();
    await release.promise;
    f.events.push('email_settled');
  };
  let settled = false;
  const done = runWorkerLoop(f.options).then(() => {
    settled = true;
  });
  await entered.promise;
  f.stop();
  await Promise.resolve();
  assert.equal(settled, false);
  release.resolve();
  await done;
  assert.deepEqual(f.events, ['schedule', 'email_delivery', 'email_settled']);
  assert.deepEqual(f.pauses, []);
});

test('shutdown lets the already awaited job settle and starts no extra claim or idle wait', async () => {
  const f = fixture(),
    entered = deferred(),
    release = deferred();
  f.options.work = async () => {
    f.events.push('job');
    entered.resolve();
    await release.promise;
    f.events.push('job_settled');
    return true;
  };
  let settled = false;
  const done = runWorkerLoop(f.options).then(() => {
    settled = true;
  });
  await entered.promise;
  f.stop();
  await Promise.resolve();
  assert.equal(settled, false);
  release.resolve();
  await done;
  assert.deepEqual(f.events, ['schedule', 'email_delivery', 'job', 'job_settled']);
  assert.deepEqual(f.pauses, []);
});

test('a stage failure during shutdown is recorded without another delay or cycle', async () => {
  const f = fixture();
  f.options.work = async () => {
    f.stop();
    throw Object.assign(Error('synthetic stop'), {code: 'SYNTHETIC_STOP'});
  };
  await runWorkerLoop(f.options);
  assert.equal(f.failures.length, 1);
  assert.equal(f.failures[0].stage, 'job');
  assert.deepEqual(f.events, ['schedule', 'email_delivery']);
  assert.deepEqual(f.pauses, []);
});

test('a diagnostic sink or delay failure remains visible rather than entering an unpaced retry loop', async () => {
  for (const target of ['onFailure', 'pause']) {
    const f = fixture(),
      error = Error('synthetic infrastructure failure');
    f.options.schedule = () => {
      throw Error('synthetic stage failure');
    };
    f.options[target] = () => {
      throw error;
    };
    await assert.rejects(runWorkerLoop(f.options), actual => actual === error);
    assert.equal(f.events.length, 0);
    assert.ok(f.failures.length <= 1);
  }
});

test('a real blocked SQLite lease is refused, paced and recovered into exactly one original result', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-worker-loop-')),
    database = path.join(directory, 'fixture.sqlite'),
    store = new Store(database, Buffer.alloc(32, 84).toString('base64')),
    blocker = new Store(database, Buffer.alloc(32, 84).toString('base64'));
  try {
    store.db.exec('PRAGMA busy_timeout=1;');
    const originalInput = {native_id: '9007199254740993', decimal: '123.4500', unknown: null},
      id = store.enqueue('tenant', 'synthetic', originalInput),
      failures = [],
      pauses = [];
    let executions = 0,
      stopping = false,
      claims = 0;
    const worker = new ReportWorker(
      store,
      async () => {
        throw Error('Unexpected report executor');
      },
      async (_tenant, kind, input) => {
        executions++;
        assert.equal(kind, 'synthetic');
        for (const [key, value] of Object.entries(originalInput)) assert.equal(input[key], value);
        stopping = true;
        return {original_native_id: input.native_id, retained_decimal: input.decimal, unknown: input.unknown};
      },
    );
    blocker.db.exec('BEGIN IMMEDIATE');
    await runWorkerLoop({
      schedule: () => {},
      deliverEmails: async () => {},
      work: async () => {
        claims++;
        assert.ok(claims <= 2);
        return worker.once();
      },
      shouldStop: () => stopping,
      onFailure: failure => failures.push(failure),
      pause: async ms => {
        pauses.push(ms);
        assert.equal(ms, 1000);
        assert.equal(claims, 1);
        assert.equal(executions, 0);
        const job = store.job('tenant', id);
        assert.equal(job.state, 'queued');
        assert.equal(job.attempts, 0);
        assert.equal(job.result, null);
        assert.equal(store.db.isTransaction, false);
        blocker.db.exec('ROLLBACK');
      },
    });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].stage, 'job');
    assert.equal(failures[0].code, 'ERR_SQLITE_ERROR');
    assert.equal(failures[0].database.primary_code, 5);
    assert.equal(failures[0].database.name, 'SQLITE_BUSY');
    assert.deepEqual(pauses, [1000]);
    assert.equal(claims, 2);
    assert.equal(executions, 1);
    const job = store.job('tenant', id);
    assert.equal(job.state, 'complete');
    assert.equal(job.attempts, 1);
    assert.deepEqual(job.input, originalInput);
    assert.deepEqual(job.result, {
      original_native_id: originalInput.native_id,
      retained_decimal: originalInput.decimal,
      unknown: null,
    });
    assert.equal(await worker.once(), false);
    assert.equal(executions, 1);
  } finally {
    if (blocker.db.isTransaction) blocker.db.exec('ROLLBACK');
    blocker.close();
    store.close();
    removeTestDirectory(directory, 'amcp-worker-loop-');
  }
});

test(
  'the actual standalone --once entry point exits successfully with an owned empty runtime',
  {timeout: 20000},
  async () => {
    const entry = fileURLToPath(new URL('../dist/server/worker.js', import.meta.url)),
      child = spawn(process.execPath, [entry, '--once'], {
        windowsHide: true,
        env: {
          SystemRoot: process.env.SystemRoot,
          PATH: process.env.PATH,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          NODE_ENV: 'production',
          MIRROR_DB: ':memory:',
          MIRROR_MASTER_KEY: Buffer.alloc(32, 85).toString('base64'),
          MIRROR_ALLOW_WRITES: 'false',
          // The owned in-memory runtime has no persistent volume; production refuses that without the override (OPS-03).
          AMCP_ALLOW_EPHEMERAL_DB: 'true',
          AMCP_PUBLIC_ORIGIN: 'https://worker-loop.example.test',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    let stdout = '',
      stderr = '',
      timer;
    child.stdout.on('data', value => {
      stdout = (stdout + value).slice(-16384);
    });
    child.stderr.on('data', value => {
      stderr = (stderr + value).slice(-16384);
    });
    const closed = once(child, 'close');
    try {
      const result = await Promise.race([
        closed,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('Owned standalone worker timed out')), 15000);
        }),
      ]);
      assert.deepEqual(result, [0, null], stderr);
      assert.equal(stdout, '');
      assert.doesNotMatch(stderr, /worker_stage_failed|uncaught|UNAUTHORIZED|REPORT_FAILED/i);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
  },
);
