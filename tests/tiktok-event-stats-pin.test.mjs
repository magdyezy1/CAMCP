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
import {removeTestDirectory} from '../dist/tests/temp.js';

// MSR-03 slice D: the owner pins TikTok's SDK specification of the statistics request offline, from a downloaded copy.
const run = (...args) =>
  spawnSync(process.execPath, ['tools/tiktok-event-stats-pin.mjs', ...args], {encoding: 'utf8', timeout: 30000});

test('the TikTok statistics pin is recorded from a local copy, re-checked against it, and accepted by the ledger', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-tiktok-pin-'));
  t.after(() => removeTestDirectory(dir, 'amcp-tiktok-pin-'));
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

// TikTok's SDK yml_files state the path relative to the SDK base (observed: /pixel/event/stats/ at commit f809c396 on
// 2026-10-17), so the full route must come from the same commit's generated API reference.
test('a specification with the SDK-relative path is pinned only with the API reference that states the full route', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-tiktok-pin-relative-'));
  t.after(() => removeTestDirectory(dir, 'amcp-tiktok-pin-'));
  const source = path.join(dir, 'pixel_event_stats.yml'),
    reference = path.join(dir, 'MeasurementApi.md'),
    out = path.join(dir, 'pin.json');
  fs.writeFileSync(
    source,
    syntheticTiktokSpecification.replace('  /open_api/v1.3/pixel/event/stats/:', '  /pixel/event/stats/:') +
      'servers:\n- url: business-api.tiktok.com\n',
  );
  const referenceText = [
    '# MeasurementApi',
    '',
    'All URIs are relative to *https://business-api.tiktok.com*',
    '',
    'Method | HTTP request | Description',
    '------------- | ------------- | -------------',
    '[**pixelEventStats**](MeasurementApi.md#pixelEventStats) | **GET** /open_api/v1.3/pixel/event/stats/ | View statistics',
    '',
  ].join('\n');
  // Without the reference the relative path is refused, and the message names the reference to add.
  const without = run('--source-file', source, '--commit', syntheticTiktokCommit, '--out', out);
  assert.equal(without.status, 1);
  assert.match(
    without.stderr,
    /documents \/pixel\/event\/stats\/; add --route-file java_sdk\/docs\/MeasurementApi\.md/,
  );
  assert.equal(fs.existsSync(out), false);
  // A reference that does not state the GET route, or the base URL, is refused too.
  fs.writeFileSync(reference, referenceText.replace('**GET**', '**POST**'));
  const wrongMethod = run(
    '--source-file',
    source,
    '--route-file',
    reference,
    '--commit',
    syntheticTiktokCommit,
    '--out',
    out,
  );
  assert.equal(wrongMethod.status, 1);
  assert.match(wrongMethod.stderr, /MeasurementApi\.md: GET \/open_api\/v1\.3\/pixel\/event\/stats\//);
  fs.writeFileSync(reference, referenceText.replace('https://business-api.tiktok.com', 'https://example.test'));
  const wrongBase = run(
    '--source-file',
    source,
    '--route-file',
    reference,
    '--commit',
    syntheticTiktokCommit,
    '--out',
    out,
  );
  assert.equal(wrongBase.status, 1);
  assert.match(wrongBase.stderr, /the base URL https:\/\/business-api\.tiktok\.com/);
  assert.equal(fs.existsSync(out), false);
  // With the reference, the pin records both files and the ledger accepts it; --check also compares the reference.
  fs.writeFileSync(reference, referenceText);
  const pinned = run(
    '--source-file',
    source,
    '--route-file',
    reference,
    '--commit',
    syntheticTiktokCommit,
    '--checked-at',
    '2026-10-17',
    '--out',
    out,
  );
  assert.equal(pinned.status, 0, pinned.stderr);
  const pin = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(pin.request.path, '/open_api/v1.3/pixel/event/stats/');
  assert.equal(pin.route_source.path, 'java_sdk/docs/MeasurementApi.md');
  assert.equal(pin.route_source.base, 'https://business-api.tiktok.com');
  assert.match(pin.route_source.sha256, /^[0-9a-f]{64}$/);
  assert.equal(tiktokEventStatsPin(pin).status, 'pinned');
  const check = (...extra) =>
    run(
      '--source-file',
      source,
      '--route-file',
      reference,
      '--commit',
      syntheticTiktokCommit,
      '--out',
      out,
      '--check',
      ...extra,
    );
  assert.equal(check().status, 0);
  fs.writeFileSync(reference, referenceText + '\nChanged.\n');
  assert.equal(check().status, 1, 'a changed reference no longer matches the pin');
});
