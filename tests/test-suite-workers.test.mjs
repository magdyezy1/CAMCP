import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root = process.cwd(),
  runtime = path.join(root, '.runtime'),
  command = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    .scripts.test.split('&&')
    .at(-1)
    .trim();
assert.ok(command.startsWith('node '), 'The full suite uses the Node test runner');
const args = command
  .slice(5)
  .split(/\s+/)
  .map(arg => (arg === 'tools/test-suite.mjs' ? path.join(root, arg) : arg));

function fixture(t, failing = false) {
  fs.mkdirSync(runtime, {recursive: true});
  const directory = fs.mkdtempSync(path.join(runtime, 'test-suite-workers-'));
  t.after(() => {
    assert.equal(path.dirname(directory), runtime);
    assert.ok(path.basename(directory).startsWith('test-suite-workers-'));
    fs.rmSync(directory, {recursive: true, force: true});
  });
  fs.mkdirSync(path.join(directory, 'dist/tests'), {recursive: true});
  fs.mkdirSync(path.join(directory, 'tests/deep'), {recursive: true});
  fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}\n');
  for (const [file, id] of [
    ['dist/tests/compiled.test.js', 'compiled'],
    ['tests/source.test.mjs', 'source'],
  ])
    fs.writeFileSync(
      path.join(directory, file),
      `
import test from 'node:test';
import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
const record = phase => fs.appendFileSync('events.jsonl', JSON.stringify({id:${JSON.stringify(id)},phase,pid:process.pid})+'\\n');
test(${JSON.stringify(id)}, async () => {
  record('start'); await delay(300); record('end');
  ${failing && id === 'source' ? "throw Error('Intentional fixture failure');" : ''}
});
`,
    );
  for (const file of ['dist/tests/helper.js', 'tests/helper.mjs', 'tests/deep/ignored.test.mjs'])
    fs.writeFileSync(path.join(directory, file), "throw Error('Unexpected test selection');\n");
  return {
    directory,
    run: (workers, extra = []) => {
      const env = {...process.env, AMCP_TEST_CONCURRENCY: workers};
      // This is a separate CLI fixture, not another invocation inside the parent's test context.
      delete env.NODE_TEST_CONTEXT;
      return spawnSync(process.execPath, [...args, ...extra], {
        cwd: directory,
        env,
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
    },
    events: () =>
      fs.existsSync(path.join(directory, 'events.jsonl'))
        ? fs
            .readFileSync(path.join(directory, 'events.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map(line => JSON.parse(line))
        : [],
  };
}

test('the full-suite command honors an explicit serial worker and keeps both isolated test directories', t => {
  const f = fixture(t),
    out = f.run('1', ['--test-concurrency=2']),
    events = f.events();
  assert.equal(out.status, 0, out.stderr + out.stdout);
  assert.deepEqual(
    events.map(row => row.phase),
    ['start', 'end', 'start', 'end'],
  );
  assert.equal(new Set(events.map(row => row.pid)).size, 2);
  assert.deepEqual(new Set(events.map(row => row.id)), new Set(['compiled', 'source']));
  assert.match(out.stdout, /tests 2\b/);
});

test('two full-suite workers overlap isolated files and preserve a failing test exit', t => {
  const f = fixture(t, true),
    out = f.run('2'),
    events = f.events();
  assert.equal(out.status, 1, out.stderr + out.stdout);
  assert.deepEqual(
    events.map(row => row.phase),
    ['start', 'start', 'end', 'end'],
  );
  assert.equal(new Set(events.map(row => row.pid)).size, 2);
  assert.deepEqual(new Set(events.map(row => row.id)), new Set(['compiled', 'source']));
  assert.match(out.stdout, /Intentional fixture failure/);
  assert.match(out.stdout, /tests 2\b/);
});

test('invalid full-suite worker settings fail before any fixture executes', t => {
  const f = fixture(t);
  for (const workers of ['2\n', '', '01', '2e0', '0', '33', '2.5', ' 2 ', '--test-skip-pattern=.*']) {
    const out = f.run(workers);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /AMCP_TEST_CONCURRENCY/);
    assert.deepEqual(f.events(), []);
  }
});
