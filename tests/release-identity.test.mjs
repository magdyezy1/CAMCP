import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {packagedIdentity, identityRecord, sourceRevision} from '../dist/src/release-identity.js';
import {removeTestDirectory, removeTestPath} from '../dist/tests/temp.js';
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-identity-'));
const cleanup = root => {
  removeTestDirectory(root, 'amcp-identity-');
};
const fixture = root => {
  for (const [file, text] of Object.entries({
    'dist/server/app.js': 'export const code=1;',
    'generated/schema.json': '{"provider":"original"}',
    '.mirror/VENDOR/native.json': '{"version":"original"}',
    'web/app.js': 'const name="Original";',
    'Skills/amcp-campaign-builder/SKILL.md': 'Original static skill.',
    'package.json': '{"name":"amcp"}',
    'package-lock.json': '{"lockfileVersion":3}',
    'docs/REPORTING-OVERVIEW.md': 'Original public reporting guide.',
  })) {
    fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
};
test('packaged artifact identity is deterministic across source roots and source revision claims', () => {
  const a = fixture(temporary()),
    b = fixture(temporary());
  try {
    const first = packagedIdentity(a),
      second = packagedIdentity(b, 'A'.repeat(40));
    assert.equal(first.sha256, second.sha256);
    // Identity v2 (QA-01) counts the lockfile, which v1 left out of the packaged identity.
    assert.equal(first.files, 8);
    assert.equal(first.bytes, second.bytes);
    assert.deepEqual(first.components, second.components);
    assert.equal(first.source_revision, null);
    assert.equal(second.source_revision, 'a'.repeat(40));
    assert.deepEqual(identityRecord(first), first);
  } finally {
    cleanup(a);
    cleanup(b);
  }
});
test('each selected packaged application component changes the payload fingerprint when its artifact bytes change', () => {
  const root = fixture(temporary());
  try {
    const before = packagedIdentity(root);
    for (const file of [
      'dist/server/app.js',
      'generated/schema.json',
      '.mirror/VENDOR/native.json',
      'web/app.js',
      'Skills/amcp-campaign-builder/SKILL.md',
      'package.json',
      // QA-01 regression: changing only the lockfile must change the identity (v1 ignored it).
      'package-lock.json',
      'docs/REPORTING-OVERVIEW.md',
    ]) {
      const original = fs.readFileSync(path.join(root, file));
      fs.appendFileSync(path.join(root, file), 'changed');
      const after = packagedIdentity(root);
      assert.notEqual(after.sha256, before.sha256, file);
      assert.equal(after.files, before.files);
      fs.writeFileSync(path.join(root, file), original);
    }
    assert.equal(packagedIdentity(root).sha256, before.sha256);
  } finally {
    cleanup(root);
  }
});
test('compiled tests are their own component: a test-only change leaves the runtime dist component equal (QA-01)', () => {
  const root = fixture(temporary());
  try {
    const component = (identity, name) => identity.components.find(c => c.name === name);
    const before = packagedIdentity(root);
    assert.deepEqual(
      before.components.map(c => c.name),
      [
        'dist',
        'dist/tests',
        'generated',
        '.mirror/VENDOR',
        'web',
        'Skills/amcp-campaign-builder',
        'package.json',
        'package-lock.json',
        'docs/REPORTING-OVERVIEW.md',
      ],
    );
    assert.equal(
      component(before, 'dist/tests').files,
      0,
      'a package without compiled tests still names the component',
    );
    assert.deepEqual(identityRecord(before), before);
    fs.mkdirSync(path.join(root, 'dist/tests'), {recursive: true});
    fs.writeFileSync(path.join(root, 'dist/tests/sample.test.js'), 'test one');
    const withTests = packagedIdentity(root);
    fs.writeFileSync(path.join(root, 'dist/tests/sample.test.js'), 'test two');
    const changed = packagedIdentity(root);
    assert.deepEqual(component(changed, 'dist'), component(before, 'dist'));
    assert.deepEqual(component(withTests, 'dist'), component(before, 'dist'));
    assert.notEqual(component(changed, 'dist/tests').sha256, component(withTests, 'dist/tests').sha256);
    assert.notEqual(changed.sha256, withTests.sha256, 'the package digest still covers the compiled tests');
    // A v1 record (seven components, no lockfile) stays readable during the transition.
    const v1 = {
      ...before,
      schema_version: 1,
      components: before.components.filter(c => c.name !== 'dist/tests' && c.name !== 'package-lock.json'),
    };
    v1.files = v1.components.reduce((n, c) => n + c.files, 0);
    v1.bytes = v1.components.reduce((n, c) => n + c.bytes, 0);
    assert.deepEqual(identityRecord(v1), v1);
  } finally {
    cleanup(root);
  }
});
test('private state and the generated record stay outside artifact identity and cannot leak through its summary', () => {
  const root = fixture(temporary());
  try {
    const first = packagedIdentity(root);
    for (const file of [
      '.env',
      '.mirror/PRIVATE/token.json',
      '.mirror/RESULTS/live-read-samples.json',
      '.runtime/private.json',
      'dist/release-identity.json',
    ]) {
      fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
      fs.writeFileSync(path.join(root, file), 'PRIVATE malformed secret text');
    }
    const second = packagedIdentity(root);
    assert.deepEqual(second, first);
    assert.ok(!JSON.stringify(second).includes('PRIVATE'));
  } finally {
    cleanup(root);
  }
});
test('the record parser refuses unexpected/private fields and invalid counts, hashes or component membership', () => {
  const root = fixture(temporary());
  try {
    const original = packagedIdentity(root);
    for (const value of [
      null,
      [],
      {},
      {...original, secret: 'PRIVATE'},
      {...original, sha256: 'PRIVATE'},
      {...original, files: original.files + 1},
      {...original, bytes: original.bytes + 1},
      {...original, source_revision: 'PRIVATE'},
      {...original, schema_version: 1},
      {...original, schema_version: 3},
      {...original, components: original.components.slice(1)},
      {...original, components: [{...original.components[0], name: 'PRIVATE'}, ...original.components.slice(1)]},
      {...original, components: [{...original.components[0], secret: 'PRIVATE'}, ...original.components.slice(1)]},
    ])
      assert.equal(identityRecord(value), null);
    const clone = identityRecord(original);
    clone.components[0].sha256 = '0'.repeat(64);
    assert.notEqual(original.components[0].sha256, clone.components[0].sha256);
  } finally {
    cleanup(root);
  }
});
test('source revision is an explicitly bounded nullable build claim, never arbitrary environment text', () => {
  for (const value of [
    undefined,
    null,
    {},
    false,
    0,
    'PRIVATE',
    'a'.repeat(39),
    'a'.repeat(41),
    ' ' + 'a'.repeat(40),
    'a'.repeat(40) + '\n',
    'https://example.test/' + 'a'.repeat(40),
  ])
    assert.equal(sourceRevision(value), null);
  assert.equal(sourceRevision('A'.repeat(40)), 'a'.repeat(40));
});
test('an actual directory junction/symbolic link is refused before reading external data', () => {
  const root = fixture(temporary()),
    external = temporary(),
    link = path.join(root, 'web', 'external');
  try {
    fs.writeFileSync(path.join(external, 'private.json'), 'PRIVATE');
    fs.symlinkSync(external, link, 'junction');
    assert.throws(() => packagedIdentity(root), /RELEASE_IDENTITY_UNAVAILABLE/);
    assert.equal(fs.readFileSync(path.join(external, 'private.json'), 'utf8'), 'PRIVATE');
  } finally {
    removeTestPath(link, {inside: root});
    cleanup(root);
    cleanup(external);
  }
});
test('a sparse artifact over the per-file byte bound refuses before its payload is read', () => {
  const root = fixture(temporary());
  try {
    const file = path.join(root, 'web', 'oversized.bin');
    fs.writeFileSync(file, '');
    fs.truncateSync(file, 256 * 1024 * 1024 + 1);
    assert.throws(() => packagedIdentity(root), /RELEASE_IDENTITY_UNAVAILABLE/);
  } finally {
    cleanup(root);
  }
});

test('an ancestor directory junction is refused before a copied subdirectory can escape the artifact root', () => {
  const root = fixture(temporary()),
    external = temporary(),
    link = path.join(root, '.mirror'),
    original = path.join(root, '.mirror-original');
  try {
    fs.mkdirSync(path.join(external, 'VENDOR'));
    fs.writeFileSync(path.join(external, 'VENDOR', 'private.json'), 'PRIVATE');
    fs.renameSync(link, original);
    fs.symlinkSync(external, link, 'junction');
    assert.throws(() => packagedIdentity(root), /RELEASE_IDENTITY_UNAVAILABLE/);
    assert.equal(fs.readFileSync(path.join(external, 'VENDOR', 'private.json'), 'utf8'), 'PRIVATE');
  } finally {
    removeTestPath(link, {inside: root});
    cleanup(root);
    cleanup(external);
  }
});
