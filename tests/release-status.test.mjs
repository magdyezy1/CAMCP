import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {packagedIdentity} from '../dist/src/release-identity.js';
import {readBuildRecord} from '../dist/src/release-status.js';
import {createReleaseStatus} from '../dist/src/release-status.js';
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-status-'));
const cleanup = root => {
  const absolute = path.resolve(root);
  if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('amcp-status-'))
    throw Error('Unsafe cleanup');
  fs.rmSync(absolute, {recursive: true, force: true});
};
const fixture = root => {
  for (const [file, text] of Object.entries({
    'dist/server/app.js': 'original code',
    'generated/schema.json': '{}',
    '.mirror/VENDOR/native.json': '{}',
    'web/app.js': 'original web',
    'Skills/amcp-campaign-builder/SKILL.md': 'original skill',
    'package.json': '{}',
    'docs/REPORTING-OVERVIEW.md': 'original guide',
  })) {
    fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
    fs.writeFileSync(path.join(root, file), text);
  }
  const record = packagedIdentity(root, 'a'.repeat(40));
  fs.writeFileSync(path.join(root, 'dist', 'release-identity.json'), JSON.stringify(record));
  return {root, record};
};
test('actual packaged bytes are verified independently of the reported build revision and cached with their observation time', async () => {
  const {root, record} = fixture(temporary());
  let now = 0;
  try {
    const status = createReleaseStatus({root, clock: () => now});
    const initial = await status();
    assert.equal(initial.status, 'matches_build');
    assert.equal(initial.build.source_revision, 'a'.repeat(40));
    assert.equal(initial.runtime.source_revision, null);
    assert.equal(initial.observed_at, '1970-01-01T00:00:00.000Z');
    assert.equal(initial.runtime.sha256, record.sha256);
    initial.build.sha256 = 'PRIVATE';
    assert.notEqual((await status()).build.sha256, 'PRIVATE');
    fs.appendFileSync(path.join(root, 'web', 'app.js'), ' changed');
    assert.equal((await status()).status, 'matches_build');
    now = 10000;
    const changed = await status();
    assert.equal(changed.status, 'payload_mismatch');
    assert.equal(changed.build.sha256, record.sha256);
    assert.notEqual(changed.runtime.sha256, record.sha256);
    assert.equal(changed.observed_at, '1970-01-01T00:00:10.000Z');
    now = -1;
    assert.equal((await status()).observed_at, '1969-12-31T23:59:59.999Z');
  } finally {
    cleanup(root);
  }
});
test('malformed, oversized or private build records return only fixed unavailable metadata', async () => {
  const {root, record} = fixture(temporary());
  try {
    const file = path.join(root, 'dist', 'release-identity.json');
    for (const value of [
      'PRIVATE invalid JSON',
      JSON.stringify({...record, secret: 'PRIVATE'}),
      'PRIVATE'.repeat(2000),
      JSON.stringify({...record, source_revision: 'PRIVATE'}),
    ]) {
      fs.writeFileSync(file, value);
      assert.equal(readBuildRecord(root), null);
      const result = await createReleaseStatus({root, clock: () => 0})();
      assert.equal(result.status, 'unavailable');
      assert.equal(result.code, 'RELEASE_IDENTITY_UNAVAILABLE');
      assert.equal(result.build, null);
      assert.equal(result.runtime, null);
      assert.ok(!JSON.stringify(result).includes('PRIVATE'));
      assert.ok(!JSON.stringify(result).includes(root));
    }
    fs.unlinkSync(file);
    assert.equal(readBuildRecord(root), null);
  } finally {
    cleanup(root);
  }
});
test('a valid-looking altered component cannot claim a runtime match from the aggregate hash alone', async () => {
  const {root, record} = fixture(temporary());
  try {
    const altered = structuredClone(record);
    altered.components[0].sha256 = 'f'.repeat(64);
    fs.writeFileSync(path.join(root, 'dist', 'release-identity.json'), JSON.stringify(altered));
    const result = await createReleaseStatus({root, clock: () => 0})();
    assert.equal(result.status, 'payload_mismatch');
    assert.equal(result.build.sha256, result.runtime.sha256);
    assert.notEqual(result.build.components[0].sha256, result.runtime.components[0].sha256);
  } finally {
    cleanup(root);
  }
});
test('a junction replacing the metadata parent refuses without reading the external record', async () => {
  const {root} = fixture(temporary()),
    external = temporary(),
    link = path.join(root, 'dist'),
    original = path.join(root, 'original-dist');
  try {
    fs.writeFileSync(path.join(external, 'release-identity.json'), 'PRIVATE');
    fs.renameSync(link, original);
    fs.symlinkSync(external, link, 'junction');
    assert.equal(readBuildRecord(root), null);
    const result = await createReleaseStatus({root, clock: () => 0})();
    assert.equal(result.status, 'unavailable');
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  } finally {
    if (fs.existsSync(link)) fs.unlinkSync(link);
    cleanup(root);
    cleanup(external);
  }
});
test('invalid observation clock or refresh bounds cannot disclose arbitrary caller text', async () => {
  for (const intervalMs of [0, 999, 300001, 1.5, 'PRIVATE', NaN])
    assert.throws(() => createReleaseStatus({intervalMs}), /INVALID_IDENTITY_INTERVAL/);
  for (const clock of [
    () => NaN,
    () => Infinity,
    () => {
      throw Error('PRIVATE');
    },
  ]) {
    const result = await createReleaseStatus({clock})();
    assert.equal(result.status, 'unavailable');
    assert.equal(result.observed_at, null);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
});

test('valid metadata field order does not change the independently verified identity', async () => {
  const {root, record} = fixture(temporary());
  try {
    const reordered = {
      source_revision: record.source_revision,
      components: record.components.map(component => ({
        sha256: component.sha256,
        bytes: component.bytes,
        files: component.files,
        name: component.name,
      })),
      bytes: record.bytes,
      files: record.files,
      sha256: record.sha256,
      kind: record.kind,
      schema_version: record.schema_version,
    };
    fs.writeFileSync(path.join(root, 'dist/release-identity.json'), JSON.stringify(reordered));
    const result = await createReleaseStatus({root, clock: () => 0})();
    assert.equal(result.status, 'matches_build');
    assert.equal(result.runtime.sha256, record.sha256);
  } finally {
    cleanup(root);
  }
});
