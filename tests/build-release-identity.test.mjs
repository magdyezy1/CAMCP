import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildReleaseIdentity} from '../tools/build-release-identity.mjs';
import {packagedIdentity, identityRecord} from '../dist/src/release-identity.js';
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-build-identity-'));
const cleanup = root => {
  const resolved = path.resolve(root);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith('amcp-build-identity-')
  )
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
};
test('actual build writer regenerates deterministic bounded metadata after artifact changes without hashing its own record', () => {
  const root = temporary();
  try {
    fixture(root);
    const first = buildReleaseIdentity(root, 'A'.repeat(40)),
      file = path.join(root, 'dist/release-identity.json'),
      original = fs.readFileSync(file);
    assert.equal(first.source_revision, 'a'.repeat(40));
    assert.deepEqual(identityRecord(JSON.parse(original.toString('utf8'))), first);
    assert.deepEqual(packagedIdentity(root, 'a'.repeat(40)), first);
    assert.deepEqual(buildReleaseIdentity(root, 'a'.repeat(40)), first);
    assert.deepEqual(fs.readFileSync(file), original);
    fs.appendFileSync(path.join(root, 'web/app.js'), ' changed');
    const changed = buildReleaseIdentity(root);
    assert.notEqual(changed.sha256, first.sha256);
    assert.equal(changed.source_revision, null);
    assert.deepEqual(packagedIdentity(root), changed);
    assert.deepEqual(fs.readdirSync(path.join(root, 'dist')).sort(), ['release-identity.json', 'server']);
  } finally {
    cleanup(root);
  }
});
test('actual build CLI publishes only validated public summary fields and never arbitrary build variable text', () => {
  const root = temporary();
  try {
    fixture(root);
    const entry = fileURLToPath(new URL('../tools/build-release-identity.mjs', import.meta.url));
    for (const revision of ['b'.repeat(40), 'PRIVATE invalid claim']) {
      const result = spawnSync(process.execPath, [entry], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        env: {
          SystemRoot: process.env.SystemRoot,
          PATH: process.env.PATH,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          RAILWAY_GIT_COMMIT_SHA: revision,
        },
      });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      const summary = JSON.parse(result.stdout);
      assert.deepEqual(Object.keys(summary).sort(), [
        'bytes',
        'event',
        'files',
        'schema_version',
        'sha256',
        'source_revision',
      ]);
      assert.equal(summary.source_revision, revision === 'b'.repeat(40) ? revision : null);
      assert.equal(summary.files, 7);
      assert.ok(!result.stdout.includes('PRIVATE'));
      assert.ok(!result.stdout.includes(root));
    }
  } finally {
    cleanup(root);
  }
});
test('actual writer refuses live and broken metadata links without modifying their external target', () => {
  const root = temporary(),
    external = temporary();
  try {
    fixture(root);
    const target = path.join(root, 'dist/release-identity.json'),
      outside = path.join(external, 'private-record.json');
    fs.writeFileSync(outside, 'PRIVATE external original');
    for (const linkTarget of [outside, path.join(external, 'absent.json')]) {
      fs.symlinkSync(linkTarget, target, 'file');
      assert.throws(() => buildReleaseIdentity(root), /^Error: RELEASE_IDENTITY_BUILD_FAILED$/);
      assert.equal(fs.readFileSync(outside, 'utf8'), 'PRIVATE external original');
      assert.ok(!fs.existsSync(path.join(external, 'absent.json')));
      fs.unlinkSync(target);
    }
    assert.deepEqual(fs.readdirSync(path.join(root, 'dist')).sort(), ['server']);
  } finally {
    cleanup(root);
    cleanup(external);
  }
});
test('incomplete packaged scope fails with fixed text and preserves the preceding record without temporary files', () => {
  const root = temporary();
  try {
    fixture(root);
    buildReleaseIdentity(root);
    const target = path.join(root, 'dist/release-identity.json'),
      original = fs.readFileSync(target);
    fs.renameSync(path.join(root, 'generated'), path.join(root, 'unpackaged'));
    assert.throws(() => buildReleaseIdentity(root), /^Error: RELEASE_IDENTITY_BUILD_FAILED$/);
    assert.deepEqual(fs.readFileSync(target), original);
    assert.deepEqual(fs.readdirSync(path.join(root, 'dist')).sort(), ['release-identity.json', 'server']);
    const entry = fileURLToPath(new URL('../tools/build-release-identity.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [entry], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: {SystemRoot: process.env.SystemRoot, PATH: process.env.PATH},
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'RELEASE_IDENTITY_BUILD_FAILED');
    assert.ok(!result.stderr.includes(root));
  } finally {
    cleanup(root);
  }
});
test('the maintained build stamps compiled files and the Railway revision ARG is scoped before the Docker build check', () => {
  const project = fileURLToPath(new URL('../', import.meta.url)),
    config = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')),
    docker = fs.readFileSync(path.join(project, 'Dockerfile'), 'utf8'),
    railway = JSON.parse(fs.readFileSync(path.join(project, 'railway.json'), 'utf8'));
  assert.equal(config.scripts.build, 'tsc -p tsconfig.json && node tools/build-release-identity.mjs');
  const buildStage = docker.split(/\r?\nFROM /)[0];
  assert.match(buildStage, /\nARG RAILWAY_GIT_COMMIT_SHA\r?\n/);
  assert.ok(
    buildStage.indexOf('ARG RAILWAY_GIT_COMMIT_SHA') <
      buildStage.indexOf('RUN AMCP_REQUIRE_FFMPEG=true AMCP_TEST_CONCURRENCY=2 npm run check'),
  );
  assert.match(docker, /COPY --from=build \/app\/dist \.\/dist/);
  assert.equal(railway.deploy.healthcheckPath, '/healthz');
});
