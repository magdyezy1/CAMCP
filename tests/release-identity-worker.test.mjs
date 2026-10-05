import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {verifyPackagedRuntime, createReleaseStatus} from '../dist/src/release-status.js';
import {packagedIdentity} from '../dist/src/release-identity.js';
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-worker-'));
const cleanup = root => {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('amcp-worker-'))
    throw Error('Unsafe cleanup');
  fs.rmSync(resolved, {recursive: true, force: true});
};
const fixture = root => {
  for (const [file, value] of Object.entries({
    'dist/server/app.js': 'owned code',
    'generated/schema.json': '{}',
    '.mirror/VENDOR/native.json': '{}',
    'web/app.js': 'owned web',
    'Skills/amcp-campaign-builder/SKILL.md': 'owned skill',
    'package.json': '{}',
    'docs/REPORTING-OVERVIEW.md': 'owned guide',
  })) {
    fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
    fs.writeFileSync(path.join(root, file), value);
  }
  const record = packagedIdentity(root, 'a'.repeat(40));
  fs.writeFileSync(path.join(root, 'dist/release-identity.json'), JSON.stringify(record));
  return record;
};
test('concurrent actual worker refreshes share one selected build record and return independent response copies', async () => {
  const root = temporary();
  try {
    const record = fixture(root),
      status = createReleaseStatus({root, clock: () => 0});
    const first = status();
    fs.writeFileSync(path.join(root, 'dist/release-identity.json'), 'PRIVATE changed after selection');
    const pending = [first, ...Array.from({length: 12}, () => status())];
    const bodies = await Promise.all(pending);
    for (const body of bodies) {
      assert.equal(body.status, 'matches_build');
      assert.equal(body.runtime.sha256, record.sha256);
      assert.ok(!JSON.stringify(body).includes('PRIVATE'));
    }
    bodies[0].runtime.sha256 = 'PRIVATE';
    assert.equal(bodies[1].runtime.sha256, record.sha256);
    assert.equal((await status()).runtime.sha256, record.sha256);
  } finally {
    cleanup(root);
  }
});
test(
  'a real hung worker is terminated by its deadline while the main event loop continues',
  {timeout: 15000},
  async () => {
    const root = temporary();
    let beats = 0;
    const timer = setInterval(() => {
      beats++;
    }, 1);
    try {
      const worker = path.join(root, 'hang.mjs');
      fs.writeFileSync(worker, 'for(;;){}');
      assert.equal(await verifyPackagedRuntime(root, {timeoutMs: 50, workerUrl: pathToFileURL(worker)}), null);
      assert.ok(beats > 0);
    } finally {
      clearInterval(timer);
      cleanup(root);
    }
  },
);
test('private worker failures, invalid summaries, claimed runtime revisions and premature exit return only null', async () => {
  const root = temporary();
  try {
    const record = fixture(root);
    for (const program of [
      'throw Error("PRIVATE_FAILURE");',
      'process.exit(0);',
      'import{parentPort}from"node:worker_threads";parentPort.postMessage({secret:"PRIVATE"});',
      'import{parentPort}from"node:worker_threads";parentPort.postMessage(' + JSON.stringify(record) + ');',
    ]) {
      const worker = path.join(root, 'refused.mjs');
      fs.writeFileSync(worker, program);
      assert.equal(await verifyPackagedRuntime(root, {workerUrl: pathToFileURL(worker)}), null);
    }
  } finally {
    cleanup(root);
  }
});
test('the isolated worker receives no inherited environment or Node preload arguments', async () => {
  const root = temporary();
  try {
    fixture(root);
    const record = packagedIdentity(root),
      worker = path.join(root, 'env.mjs');
    fs.writeFileSync(
      worker,
      'import{parentPort}from"node:worker_threads";if(Object.keys(process.env).length||process.execArgv.length)throw Error("PRIVATE_INHERITED");parentPort.postMessage(' +
        JSON.stringify(record) +
        ');',
    );
    assert.deepEqual(await verifyPackagedRuntime(root, {workerUrl: pathToFileURL(worker)}), record);
  } finally {
    cleanup(root);
  }
});
test('invalid worker deadlines refuse synchronously before a worker can be created', () => {
  for (const timeoutMs of [0, 9, 30001, 1.5, 'PRIVATE', NaN])
    assert.throws(() => verifyPackagedRuntime('unread', {timeoutMs}), /INVALID_IDENTITY_DEADLINE/);
});
