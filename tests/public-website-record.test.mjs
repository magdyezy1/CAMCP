// QA-01: `check-public-website --expect-record` compares the deployed /versionz and landing-page asset version with a
// local qualification record (GET-only, credential-free, no redirects) and appends the observation to the record.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {appendDeployedObservation, compareDeployedRecord} from '../tools/check-public-website.mjs';

const hex = c => c.repeat(64);
const components = [
  {name: 'dist', files: 3, bytes: 30, sha256: hex('1')},
  {name: 'package-lock.json', files: 1, bytes: 10, sha256: hex('2')},
];
const record = {
  source: {source_tree_hash: hex('a'), revision: 'b'.repeat(40)},
  package: {sha256: hex('c'), components},
  public_asset_version: hex('d'),
};
const versionz = (overrides = {}) => ({
  schema_version: 1,
  status: 'matches_build',
  build: {sha256: hex('c'), components, source_revision: 'b'.repeat(40)},
  runtime: {sha256: hex('c'), components, source_revision: null},
  toolchain: {
    node: 'v24.19.0',
    ffmpeg: 'ffmpeg version 5.1.6-0+deb12u1 Copyright (c) 2000-2024 the FFmpeg developers',
    os: {id: 'debian', version_id: '12'},
  },
  public_asset_version: hex('d'),
  ...overrides,
});
function fetcher(body, landing = '<link href="/assets/v/' + hex('d') + '/app.css">') {
  const calls = [];
  return {
    calls,
    fetch: async (url, options) => {
      calls.push({url, options});
      if (url.endsWith('/versionz'))
        return new Response(JSON.stringify(body), {status: body.status === 'matches_build' ? 200 : 503});
      return new Response(landing, {status: 200, headers: {'Content-Type': 'text/html'}});
    },
  };
}

test('an equal deployment passes with every comparison recorded, using GET without credentials or redirects', async () => {
  const fake = fetcher(versionz());
  const observation = await compareDeployedRecord({origin: 'https://amcp.example', record, fetcher: fake.fetch});
  assert.equal(observation.passed, true);
  assert.deepEqual(observation.checks, {
    versionz_status: 200,
    package_sha256_equal: true,
    runtime_matches_build: true,
    components_equal: true,
    lockfile_component_equal: true,
    source_revision_equal: true,
    public_asset_version_equal: true,
    landing_asset_version_equal: true,
    node_major_24: true,
    ffmpeg_reported: true,
  });
  assert.equal(observation.record_source_tree_hash, hex('a'));
  assert.deepEqual(
    fake.calls.map(call => [call.url, call.options.method, call.options.redirect, call.options.credentials]),
    [
      ['https://amcp.example/versionz', 'GET', 'manual', 'omit'],
      ['https://amcp.example/', 'GET', 'manual', 'omit'],
    ],
  );
});

test('a different package, lockfile, revision or asset version fails the comparison', async () => {
  const otherLock = components.map(c => (c.name === 'package-lock.json' ? {...c, sha256: hex('9')} : c));
  for (const [label, body, landing] of [
    ['package', versionz({build: {...versionz().build, sha256: hex('e')}}), undefined],
    ['lockfile', versionz({runtime: {...versionz().runtime, components: otherLock}}), undefined],
    ['revision', versionz({build: {...versionz().build, source_revision: 'f'.repeat(40)}}), undefined],
    ['asset', versionz({public_asset_version: hex('e')}), undefined],
    ['landing', versionz(), '<script src="/assets/v/' + hex('e') + '/app.js"></script>'],
    ['mismatch', versionz({status: 'payload_mismatch'}), undefined],
  ]) {
    const observation = await compareDeployedRecord({
      origin: 'https://amcp.example',
      record,
      fetcher: fetcher(body, landing).fetch,
    });
    assert.equal(observation.passed, false, label);
  }
  const failed = await compareDeployedRecord({
    origin: 'https://amcp.example',
    record,
    fetcher: async () => {
      throw new TypeError('network');
    },
  });
  assert.equal(failed.passed, false);
  assert.equal(failed.error_code, 'PUBLIC_READ_FAILED');
  await assert.rejects(compareDeployedRecord({origin: 'https://amcp.example', record: {}}), {
    message: 'QUALIFICATION_RECORD_INVALID',
  });
  await assert.rejects(compareDeployedRecord({origin: 'http://amcp.example', record}), {
    message: 'INVALID_PUBLIC_ORIGIN',
  });
});

test('the deployed observation is appended to the local record file atomically', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-record-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const file = path.join(directory, hex('a') + '.json');
  fs.writeFileSync(file, JSON.stringify({...record, deployed_observations: []}));
  const observation = await compareDeployedRecord({
    origin: 'https://amcp.example',
    record,
    fetcher: fetcher(versionz()).fetch,
  });
  await appendDeployedObservation(file, observation);
  await appendDeployedObservation(file, observation);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.deployed_observations.length, 2);
  assert.equal(saved.deployed_observations[0].passed, true);
  assert.deepEqual(fs.readdirSync(directory), [hex('a') + '.json']);
});
