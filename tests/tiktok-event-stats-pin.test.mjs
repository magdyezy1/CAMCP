import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {tiktokEventStatsPin} from '../dist/src/measurement-ledger-tiktok.js';
import {
  syntheticTiktokCommit,
  syntheticTiktokEventStatsPin,
  syntheticTiktokSpecification,
} from './fixtures/tiktok-event-stats-pin-data.mjs';

// MSR-03 slice D: the owner pins TikTok's SDK specification of the statistics request offline, from a downloaded copy.
const run = (...args) =>
  spawnSync(process.execPath, ['tools/tiktok-event-stats-pin.mjs', ...args], {encoding: 'utf8', timeout: 30000});

test('the TikTok statistics pin is recorded from a local copy, re-checked against it, and accepted by the ledger', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-tiktok-pin-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const source = path.join(dir, 'pixel_event_stats.yml'),
    out = path.join(dir, 'pin.json');
  fs.writeFileSync(source, syntheticTiktokSpecification);
  const pinned = run(
    '--source-file',
    source,
    '--commit',
    syntheticTiktokCommit,
    '--checked-at',
    '2026-10-17',
    '--out',
    out,
  );
  assert.equal(pinned.status, 0, pinned.stderr);
  const pin = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(pin, syntheticTiktokEventStatsPin);
  assert.equal(
    pin.source.url,
    'https://raw.githubusercontent.com/tiktok/tiktok-business-api-sdk/' +
      syntheticTiktokCommit +
      '/yml_files/pixel_event_stats.yml',
  );
  assert.equal(tiktokEventStatsPin(pin).status, 'pinned');
  // --check holds for the same copy at the same commit on another day, and fails for a changed copy or commit.
  assert.equal(run('--source-file', source, '--commit', syntheticTiktokCommit, '--out', out, '--check').status, 0);
  assert.equal(
    run('--source-file', source, '--commit', 'f'.repeat(40), '--out', out, '--check').status,
    1,
    'another commit',
  );
  fs.writeFileSync(source, syntheticTiktokSpecification + '# changed\n');
  const changed = run('--source-file', source, '--commit', syntheticTiktokCommit, '--out', out, '--check');
  assert.equal(changed.status, 1, 'a changed copy');
  assert.match(changed.stderr, /does not pin this file at this commit/);
  // Without a full commit, or for a file that documents another request, nothing is written.
  const missing = path.join(dir, 'missing.json');
  assert.equal(run('--source-file', source, '--out', missing).status, 1);
  fs.writeFileSync(source, syntheticTiktokSpecification.replace('- name: date_range', '- name: dates'));
  const refused = run('--source-file', source, '--commit', syntheticTiktokCommit, '--out', missing);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /does not document: date_range/);
  assert.equal(fs.existsSync(missing), false);
});
