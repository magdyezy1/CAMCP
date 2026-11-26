// always-run: scans every test, tool, server and src module for a bare administrator CLI spawn
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {adminArgs, runAdmin} from '../dist/tests/admin-cli.js';
import {removeTestDirectory} from '../dist/tests/temp.js';
import {dynamicSuites} from '../tools/related-tests.mjs';

// QA follow-up from the Railway deploy (cb338f68): the Docker build runs `npm run check` as root, and in production the
// admin CLI refuses root unless --allow-root is given (OPS-03), so a test that spawned the CLI bare reached only that
// refusal there. Every test now spawns it through tests/admin-cli.ts, which passes --allow-root. This guard finds every
// entry point that refuses root, fails when a test names one outside its helper, and proves under a simulated root
// that the helper's arguments pass the check the bare CLI fails.
const sources = directory =>
  fs
    .readdirSync(directory, {recursive: true, withFileTypes: true})
    .filter(entry => entry.isFile() && /\.(?:ts|mjs|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts'))
    .map(entry => path.join(entry.parentPath, entry.name).replaceAll('\\', '/'));
/** Entry points that read the process's user ID to refuse root, each with the helper tests must spawn it through. */
const rootHandling = {
  'tools/admin.ts': {helper: 'tests/admin-cli.ts', reference: /\badmin\.js\b|['"]run['"]\s*,\s*['"]admin['"]/},
};
/** How an entry point reads its user ID: process.getuid() or geteuid(), or os.userInfo().uid. */
const readsUserId = /\bprocess\s*\.\s*gete?uid\b|\buserInfo\s*\([^)]*\)\s*\.\s*uid\b/;
/**
 * Where such a check could live: the CLIs and the server, the shared modules they import (a check in src/ reaches every
 * entry point that imports it) and the deploy scripts. Only tools/ and server/ were scanned before (wave 4b review).
 */
const entryRoots = ['tools', 'server', 'src', 'deploy'];
const self = 'tests/root-independent-cli.test.mjs';

test('every entry point that refuses root has a helper that handles root for the tests', () => {
  const refusing = entryRoots.flatMap(sources).filter(file => readsUserId.test(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(
    refusing,
    Object.keys(rootHandling),
    'a new entry point that checks for root needs a helper here that its tests spawn it through',
  );
  for (const {helper} of Object.values(rootHandling)) assert.ok(fs.existsSync(helper), helper);
  for (const form of ['uid: process.getuid?.(),', 'process.geteuid() === 0', 'os.userInfo().uid === 0'])
    assert.match(form, readsUserId, form);
  // test:related selects this suite for a change in any folder it scans, and for any test file.
  const suite = dynamicSuites.find(s => s.test === self);
  for (const file of [...entryRoots.map(root => root + '/synthetic-entry.mjs'), 'tests/synthetic.test.mjs'])
    assert.equal(suite.inputs(file, '.'), true, file);
  assert.equal(suite.inputs('docs/OPERATIONS.md', '.'), false);
});

test('no test spawns a root-refusing entry point except through its helper', () => {
  const offenders = [];
  for (const file of sources('tests')) {
    if (file === self) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const [entry, {helper, reference}] of Object.entries(rootHandling))
      if (file !== helper && reference.test(text))
        offenders.push(file + ' names ' + entry + ' instead of using ' + helper);
  }
  assert.deepEqual(offenders, []);
  // The guard sees a bare spawn: the pattern matches the forms the eight earlier tests used.
  const {reference} = rootHandling['tools/admin.ts'];
  for (const bare of [
    "spawnSync(process.execPath, [path.resolve('dist/tools/admin.js'), 'init'])",
    "const cli = fileURLToPath(new URL('../tools/admin.js', import.meta.url));",
    "spawnSync('npm', ['run', 'admin', '--', 'status', 'local'])",
  ])
    assert.match(bare, reference, bare);
  // A response body read as JSON is not the CLI.
  assert.doesNotMatch('const adminPage = await admin.json();', reference);
});

/** Hooks run before the CLI: one makes process.getuid() report root on any platform (Windows has no getuid at all), the
 * other removes --allow-root from the CLI's arguments, as a test that spawned the CLI bare would run it. */
const hook = code => ['--import', 'data:text/javascript,' + encodeURIComponent(code)],
  asRoot = hook('process.getuid = () => 0;'),
  withoutAllowRoot = hook("process.argv = process.argv.filter(argument => argument !== '--allow-root');");

test('under a simulated root in production the bare CLI is refused, and the helper’s arguments reach the command', t => {
  const prefix = 'amcp-root-cli-',
    dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => removeTestDirectory(dir, prefix));
  const env = {...process.env, NODE_ENV: 'production', MIRROR_DB: path.join(dir, 'root.sqlite'), MIRROR_MASTER_KEY: ''};
  const helped = runAdmin(['init', 'root-guard'], {env, timeout: 30000}, asRoot);
  assert.equal(helped.status, 0, 'the helper passes --allow-root: ' + helped.stderr);
  assert.ok(fs.existsSync(env.MIRROR_DB), 'the command ran');
  // The helper runs the built CLI with --allow-root before the command; node options go before the script.
  const args = adminArgs(['init', 'x'], ['--import', 'hook']);
  assert.deepEqual(args.slice(0, 2), ['--import', 'hook']);
  assert.match(args[2].replaceAll('\\', '/'), /\/dist\/tools\/admin\.js$/);
  assert.ok(fs.existsSync(args[2]), 'the built CLI');
  assert.deepEqual(args.slice(3), ['--allow-root', 'init', 'x']);
  // Without the flag the same simulated root is refused before the database is opened.
  const refusedDb = path.join(dir, 'refused.sqlite'),
    refused = runAdmin(['init', 'root-guard'], {env: {...env, MIRROR_DB: refusedDb}, timeout: 30000}, [
      ...asRoot,
      ...withoutAllowRoot,
    ]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /ADMIN_ROOT_REFUSED/);
  assert.equal(fs.existsSync(refusedDb), false, 'a refused command opens no database');
});
