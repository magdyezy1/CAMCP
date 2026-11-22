// Test hygiene (r25-testhyg). Another program on a developer machine (antivirus, search indexer, backup tool) can hold a
// handle on a file or folder a test made, or add a file of its own to a folder the test owns. The release gate's container
// step failed on both: an EPERM removing a temporary junction (tests/release-status.test.mjs) and a foreign
// MIRROR.SQLITE-SHM.tmp found in a data folder (tests/startup-preconditions.test.mjs). tests/temp.ts is the one helper:
// cleanup after the assertions is retried and never fails the test (a folder it cannot remove is logged); a removal that
// is a step of the scenario is retried and fails the test if it stays; a listing is cut down to AMCP's own names before
// an exact assertion about them. This file proves each with the thing that broke it: a held handle, or a planted file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import * as temp from '../dist/tests/temp.js';

const windows = process.platform === 'win32',
  prefix = 'amcp-hygiene-';
const made = t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => temp.removeTestDirectory(directory, prefix));
  return directory;
};
const transient = (code = 'EPERM') => Object.assign(Error(code + ': held by another program'), {code});

// Another program's hold on `target`, released after `milliseconds`: a handle opened without sharing for deletion, as an
// antivirus scan does (libuv's UV_FS_O_EXLOCK, 0x10000000, on Windows; Node's own opens always share deletion). Only
// Windows lets a held handle block a removal, so elsewhere nothing is held and the hazard the tests below show is absent.
const holder = `
const fs = require('node:fs');
const fd = fs.openSync(process.argv[1], fs.constants.O_RDONLY | 0x10000000);
process.stdout.write('held\\n');
setTimeout(() => fs.closeSync(fd), Number(process.argv[2]));
`;
async function hold(target, milliseconds) {
  if (!windows) return {released: Promise.resolve()};
  const child = spawn(process.execPath, ['-e', holder, target, String(milliseconds)], {
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'close').then(() => {
      throw Error('The holder did not start.');
    }),
  ]);
  return {released: once(child, 'close')};
}
const codes = error => ['EPERM', 'EBUSY'].includes(error.code);

test('a folder another program holds is removed once it lets go; the bare removal fails at once', async t => {
  const directory = made(t),
    file = path.join(directory, 'record.json'),
    warnings = [];
  fs.writeFileSync(file, '{}');
  const held = await hold(file, 300);
  // The form every test used: no retry. (Node 24.19 ignores fs.rmSync's maxRetries in the synchronous call on Windows.)
  if (windows) assert.throws(() => fs.rmSync(directory, {recursive: true, force: true}), codes);
  temp.removeTestDirectory(directory, prefix, {warn: message => warnings.push(message)});
  assert.equal(fs.existsSync(directory), false, 'removed after the handle was released');
  assert.deepEqual(warnings, [], 'nothing left, so nothing logged');
  await held.released;
});

test('a folder that stays held is logged, never thrown: the assertions that passed keep their result', async t => {
  const directory = made(t),
    file = path.join(directory, 'record.json'),
    warnings = [];
  fs.writeFileSync(file, '{}');
  const held = await hold(file, windows ? 1500 : 0);
  temp.removeTestDirectory(directory, prefix, {maxRetries: 2, retryDelay: 20, warn: message => warnings.push(message)});
  if (windows) {
    assert.equal(fs.existsSync(directory), true, 'still held');
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].startsWith('Left temporary test directory ' + fs.realpathSync(directory) + ' in place: '));
  } else assert.deepEqual(warnings, []);
  await held.released;
  temp.removeTestDirectory(directory, prefix);
  assert.equal(fs.existsSync(directory), false, 'and removed once the holder is gone');
});

test('the asynchronous removal waits out a held folder without blocking the event loop', async t => {
  const directory = made(t),
    file = path.join(directory, 'record.json');
  fs.writeFileSync(file, '{}');
  // Held by this process, released from a timer: the timer can only fire if the removal's waits leave the loop free.
  const fd = windows ? fs.openSync(file, fs.constants.O_RDONLY | 0x10000000) : -1;
  if (windows) {
    setTimeout(() => fs.closeSync(fd), 300);
    await assert.rejects(fs.promises.rm(directory, {recursive: true, force: true}), codes);
  }
  await temp.removeTestDirectoryAsync(directory, prefix);
  assert.equal(fs.existsSync(directory), false);
});

test('a removal that is a step of the scenario is retried, and fails the test when it stays', async t => {
  const directory = made(t),
    file = path.join(directory, 'withheld.json');
  fs.writeFileSync(file, '{}');
  const held = await hold(file, 300);
  if (windows) assert.throws(() => fs.unlinkSync(file), codes);
  temp.removeFixture(file);
  assert.equal(fs.existsSync(file), false);
  await held.released;
  // A missing file is the test's mistake, as it is for fs.unlinkSync: no retry, no silence.
  assert.throws(() => temp.removeFixture(file), {code: 'ENOENT'});
  // Held for longer than the patience, it throws the operating system's error.
  fs.writeFileSync(file, '{}');
  const stuck = await hold(file, windows ? 1500 : 0);
  if (windows) assert.throws(() => temp.removeFixture(file, {maxRetries: 2, retryDelay: 20}), codes);
  await stuck.released;
  temp.removeFixture(file);
});

test('the retry policy: transient errors wait a little longer each time, anything else is not retried', () => {
  assert.deepEqual({...temp.patience}, {maxRetries: 10, retryDelay: 100});
  const waits = [];
  let attempts = 0;
  temp.retried(
    () => {
      if (++attempts < 4) throw transient(attempts % 2 ? 'EPERM' : 'EBUSY');
    },
    {sleep: ms => waits.push(ms)},
  );
  assert.equal(attempts, 4);
  assert.deepEqual(waits, [100, 200, 300], 'linear backoff, as fs.rm does');
  for (const code of ['EPERM', 'EBUSY', 'ENOTEMPTY', 'EMFILE', 'ENFILE']) {
    attempts = 0;
    assert.throws(
      () =>
        temp.retried(
          () => {
            attempts++;
            throw transient(code);
          },
          {maxRetries: 3, sleep: () => {}},
        ),
      {code},
    );
    assert.equal(attempts, 4, code + ': the first try and three retries');
  }
  for (const code of ['ENOENT', 'EACCES', 'EISDIR', undefined]) {
    attempts = 0;
    assert.throws(
      () =>
        temp.retried(
          () => {
            attempts++;
            throw Object.assign(Error('not transient'), {code});
          },
          {sleep: () => assert.fail('no wait')},
        ),
      {message: 'not transient', code},
    );
    assert.equal(attempts, 1, String(code));
  }
});

test('cleanup reports what it left, and only what it left', t => {
  const directory = made(t),
    real = fs.realpathSync(directory),
    warnings = [],
    warn = message => warnings.push(message);
  // A removal that keeps failing while the folder stays: logged with the folder and the reason, never thrown.
  temp.removeTestDirectory(directory, prefix, {
    remove: () => {
      throw transient();
    },
    sleep: () => {},
    warn,
  });
  assert.deepEqual(warnings, ['Left temporary test directory ' + real + ' in place: EPERM: held by another program']);
  // A failure after which the folder is gone (another process finished the job) is not a leftover.
  warnings.length = 0;
  temp.removeTestDirectory(directory, prefix, {
    remove: entry => {
      fs.rmSync(entry, {recursive: true, force: true});
      throw transient();
    },
    sleep: () => {},
    warn,
  });
  assert.deepEqual(warnings, []);
  // A folder that is already gone is nothing to clean.
  temp.removeTestDirectory(directory, prefix, {warn});
  assert.deepEqual(warnings, []);
});

test('cleanup refuses a path that is not the named temporary folder, so a wrong variable never reaches the repository', t => {
  const directory = made(t);
  assert.throws(() => temp.removeTestDirectory(directory, 'amcp-other-'), /Refusing to remove/);
  assert.throws(() => temp.removeTestDirectory(directory, 'tmp-'), /Refusing to remove/);
  assert.throws(() => temp.removeTestDirectory(process.cwd(), 'amcp-'), /Refusing to remove/);
  assert.throws(() => temp.removeTestDirectory(os.tmpdir(), ''), /Refusing to remove/);
  const nested = path.join(directory, 'nested');
  fs.mkdirSync(nested);
  assert.throws(() => temp.removeTestDirectory(nested, prefix), /Refusing to remove/);
  assert.equal(fs.existsSync(nested), true);
  assert.throws(() => temp.removeTestPath(process.cwd()), /Refusing to remove/);
  assert.throws(() => temp.removeTestPath(os.tmpdir()), /Refusing to remove/);
  assert.throws(() => temp.removeTestPath(path.join(directory, '..', '..')), /Refusing to remove/);
  assert.throws(() => temp.removeTestPath(directory, {inside: process.cwd()}), /Refusing to remove/);
  assert.equal(fs.existsSync(directory), true);
});

test('a path inside a folder the test made is removed with its contents; a link goes, and what it points to stays', t => {
  const directory = made(t),
    target = path.join(directory, 'external'),
    root = path.join(directory, 'root'),
    link = path.join(root, 'dist');
  fs.mkdirSync(target);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(target, 'private.json'), 'PRIVATE');
  fs.symlinkSync(target, link, 'junction');
  // Never through the link: removing the link leaves its target as it was.
  temp.removeTestPath(link, {inside: directory});
  assert.equal(fs.lstatSync(link, {throwIfNoEntry: false}), undefined);
  assert.equal(fs.readFileSync(path.join(target, 'private.json'), 'utf8'), 'PRIVATE');
  fs.mkdirSync(path.join(root, 'deep/er'), {recursive: true});
  fs.writeFileSync(path.join(root, 'deep/er/a.txt'), 'a');
  temp.removeTestPath(root, {inside: directory});
  assert.equal(fs.existsSync(root), false);
  assert.equal(fs.existsSync(target), true);
  // Nothing to remove is not an error, and a folder whose parent is gone is nothing either.
  temp.removeTestPath(root, {inside: directory});
  temp.removeTestPath(path.join(directory, 'gone', 'x'), {inside: directory});
});

test('a foreign file in a folder is not AMCP’s to answer for: the listing keeps AMCP’s own names, exactly', t => {
  const directory = made(t),
    own = '.amcp-volume-id.4c1d1f0e-0000-4000-8000-000000000001.tmp';
  fs.writeFileSync(path.join(directory, '.amcp-volume-id'), 'id\n');
  fs.writeFileSync(path.join(directory, 'mirror.sqlite'), '');
  // What the release gate found beside a data folder's database: a file of another program that AMCP never creates.
  fs.writeFileSync(path.join(directory, 'MIRROR.SQLITE-SHM.tmp'), '');
  const isLeftover = name => name.startsWith('.amcp-volume-id') && name.endsWith('.tmp');
  // The old form counted every *.tmp, so the foreign file alone failed 'no temporary marker remains'.
  assert.deepEqual(
    fs.readdirSync(directory).filter(name => name.endsWith('.tmp')),
    ['MIRROR.SQLITE-SHM.tmp'],
  );
  assert.deepEqual(temp.ownEntries(directory, isLeftover), [], 'a foreign file is not a leftover');
  assert.deepEqual(
    temp.ownEntries(directory, name => name.startsWith('.amcp-volume-id') || name === 'mirror.sqlite'),
    ['.amcp-volume-id', 'mirror.sqlite'],
    'an exact assertion about AMCP’s names still sees all of them',
  );
  // AMCP's own leftover is still found, beside the foreign file: the assertion is as strict as it was about AMCP.
  fs.writeFileSync(path.join(directory, own), '');
  assert.deepEqual(temp.ownEntries(directory, isLeftover), [own]);
  assert.deepEqual(temp.ownEntries(directory, /^\.amcp-volume-id\..*\.tmp$/), [own], 'a pattern works too');
});
