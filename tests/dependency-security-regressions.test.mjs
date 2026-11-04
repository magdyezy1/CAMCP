import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import http from 'node:http';
import {deflateSync, gzipSync} from 'node:zlib';
import {once} from 'node:events';
import proxyaddr from 'proxy-addr';
import {z} from 'zod';

function message(child, event) {
  return new Promise((resolve, reject) => {
    const receive = value => {
      if (value.event === event) {
        cleanup();
        resolve(value);
      }
    };
    const exited = code => {
      cleanup();
      reject(Error('The Express fixture exited before ' + event + ': ' + code));
    };
    const cleanup = () => {
      child.off('message', receive);
      child.off('exit', exited);
    };
    child.on('message', receive);
    child.once('exit', exited);
  });
}

test(
  'a completed compressed JSON frame with a late trailer cannot crash the Express process',
  {timeout: 15000},
  async t => {
    const env = {...process.env};
    delete env.NODE_TEST_CONTEXT;
    const child = fork('tests/fixtures/compressed-body-server.mjs', {
      execArgv: [],
      env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let errors = '',
      request;
    child.stderr.on('data', chunk => (errors += chunk));
    t.after(() => {
      request?.destroy();
      if (child.exitCode === null && !child.killed) child.kill();
    });
    try {
      const {port} = await message(child, 'ready');
      // An extra byte exposes the completed frame before HTTP EOF; deliver the remaining trailer afterward.
      const frame = Buffer.concat([
          deflateSync(Buffer.from(JSON.stringify({message: 'late-trailer-regression'}))),
          Buffer.from([0]),
        ]),
        trailer = Buffer.from('trailing-invalid-compressed-bytes'),
        parsed = message(child, 'parsed');
      const response = new Promise((resolve, reject) => {
        request = http.request(
          {
            host: '127.0.0.1',
            port,
            path: '/probe',
            method: 'POST',
            agent: false,
            headers: {
              'content-type': 'application/json',
              'content-encoding': 'deflate',
              'content-length': frame.length + trailer.length,
            },
          },
          res => {
            let body = '';
            res.on('data', chunk => (body += chunk));
            res.on('end', () => resolve({status: res.statusCode, body}));
            res.on('error', reject);
          },
        );
        request.on('error', reject);
        request.setTimeout(3000, () => request.destroy(Error('The compressed-body fixture did not settle')));
      });
      request.write(frame);
      const [, answer] = await Promise.all([
        parsed.then(value => {
          assert.equal(value.body.message, 'late-trailer-regression');
          request.end(trailer);
        }),
        response,
      ]);
      assert.equal(answer.status, 200, errors);
      assert.deepEqual(JSON.parse(answer.body), {received: 'late-trailer-regression'});
      const health = await fetch('http://127.0.0.1:' + port + '/health');
      assert.equal(health.status, 200, errors);
      assert.deepEqual(await health.json(), {alive: true});
      assert.equal(child.exitCode, null, errors);
      assert.equal(errors, '');
    } finally {
      request?.destroy();
      if (child.exitCode === null && !child.killed) {
        const stopped = once(child, 'exit');
        const guard = setTimeout(() => child.kill('SIGKILL'), 1000);
        if (child.connected)
          child.send('stop', error => {
            if (error) child.kill();
          });
        else child.kill();
        await stopped;
        clearTimeout(guard);
      }
    }
  },
);

test(
  'a large corrupt gzip trailer cannot terminate Express after it answers the valid frame',
  {timeout: 15000},
  async t => {
    const env = {...process.env};
    delete env.NODE_TEST_CONTEXT;
    const child = fork('tests/fixtures/compressed-body-server.mjs', {
      execArgv: [],
      env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let request;
    t.after(async () => {
      request?.destroy();
      if (child.exitCode !== null || child.signalCode !== null) return;
      const stopped = once(child, 'exit'),
        guard = setTimeout(() => child.kill('SIGKILL'), 1000);
      if (child.connected)
        child.send('stop', error => {
          if (error) child.kill();
        });
      else child.kill();
      await stopped;
      clearTimeout(guard);
    });
    let errors = '';
    child.stderr.on('data', chunk => (errors += chunk));
    const {port} = await message(child, 'ready');
    const body = Buffer.concat([
      gzipSync(Buffer.from(JSON.stringify({message: 'gzip-trailer-regression'}))),
      Buffer.from([0]),
      Buffer.alloc(100 * 1024, 0x58),
    ]);
    const response = await new Promise((resolve, reject) => {
      request = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/immediate',
          method: 'POST',
          agent: false,
          headers: {'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': body.length},
        },
        res => {
          let value = '';
          res.on('data', chunk => (value += chunk));
          res.on('end', () => resolve({status: res.statusCode, body: value}));
          res.on('error', reject);
        },
      );
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(Error('The gzip fixture did not settle')));
      request.end(body);
    });
    assert.equal(response.status, 200, errors);
    assert.deepEqual(JSON.parse(response.body), {received: 'gzip-trailer-regression'});
    // Decoder errors arrive after the successful response; allow that asynchronous failure to surface in the child.
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(child.exitCode, null, errors);
    const health = await fetch('http://127.0.0.1:' + port + '/health');
    assert.equal(health.status, 200, errors);
    assert.equal(errors, '');
  },
);

test('mapped IPv6 trust subnets cannot silently trust unrelated IPv4 clients', () => {
  const invalid = proxyaddr.compile(['::ffff:10.0.0.0/8']),
    valid = proxyaddr.compile(['::ffff:10.0.0.0/104']);
  assert.equal(invalid('203.0.113.8', 0), false);
  assert.equal(invalid('::ffff:203.0.113.8', 0), false);
  assert.equal(valid('10.2.3.4', 0), true);
  assert.equal(valid('203.0.113.8', 0), false);
});

test('an oversized constrained collection is refused before parsing its elements', () => {
  let parsed = 0;
  const schema = z
      .array(
        z.preprocess(value => {
          parsed++;
          return value;
        }, z.string()),
      )
      .max(4),
    result = schema.safeParse(Array(10000).fill(0));
  assert.equal(result.success, false);
  assert.equal(parsed, 0, 'An oversized collection must not allocate a validation error for every element');
  assert.equal(result.error.issues.length, 1);
  assert.equal(result.error.issues[0].code, 'too_big');
});
