// QA-01: browser qualification records bind the compiled backend (its packaged release identity) and a computed map of
// every non-dist module the runner loads, replacing 27 hand-listed helper hashes that missed fixture data files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {inputMapDigest, moduleClosure, releaseIdentityBinding} from '../tools/qualification-inputs.mjs';
import {packagedIdentity} from '../dist/src/release-identity.js';

const temporary = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const write = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
  fs.writeFileSync(path.join(root, file), text);
};

test('the browser runner input map covers every loaded non-dist module, including fixture data files', () => {
  const map = moduleClosure(['tools/browser-workflow-qa.mjs'], process.cwd());
  // The files the runner previously hashed by hand, and the fixture data files it loaded without hashing.
  for (const file of [
    'tools/browser-workflow-qa.mjs',
    'tests/fixtures/browser-workflow-sites.mjs',
    'tests/fixtures/conditional-program-browser.mjs',
    'tests/fixtures/conditional-program-data.mjs',
    'tests/fixtures/overview-granularity-data.mjs',
    'tests/fixtures/portfolio-refusal-data.mjs',
    'tests/fixtures/google-hour-evidence-data.mjs',
    'tools/browser-accessibility.mjs',
    'tools/browser-table-qa.mjs',
    'tools/browser-wcag.mjs',
    'tools/qualification-inputs.mjs',
  ])
    assert.match(map[file] ?? '', /^[0-9a-f]{64}$/, file);
  assert.ok(Object.keys(map).every(file => !file.startsWith('dist/') && !file.includes('node_modules')));
  assert.ok(Object.keys(map).length > 27, 'more inputs than the old hand-listed set');
});

test('changing a fixture data file changes the input map; an unreferenced file does not', t => {
  const root = temporary('amcp-inputs-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  write(root, 'tools/runner.mjs', "import {cases} from '../tests/fixtures/site.mjs';\nimport '../dist/src/x.js';\n");
  write(root, 'tests/fixtures/site.mjs', "export {cases} from './site-data.mjs';\n");
  write(root, 'tests/fixtures/site-data.mjs', 'export const cases = [1];\n');
  write(root, 'tests/fixtures/unrelated.mjs', 'export const other = 1;\n');
  const before = moduleClosure(['tools/runner.mjs'], root);
  assert.deepEqual(Object.keys(before), [
    'tests/fixtures/site-data.mjs',
    'tests/fixtures/site.mjs',
    'tools/runner.mjs',
  ]);
  write(root, 'tests/fixtures/unrelated.mjs', 'export const other = 2;\n');
  assert.equal(inputMapDigest(moduleClosure(['tools/runner.mjs'], root)), inputMapDigest(before));
  write(root, 'tests/fixtures/site-data.mjs', 'export const cases = [1, 2];\n');
  const after = moduleClosure(['tools/runner.mjs'], root);
  assert.notEqual(after['tests/fixtures/site-data.mjs'], before['tests/fixtures/site-data.mjs']);
  assert.notEqual(inputMapDigest(after), inputMapDigest(before));
});

test('a missing or stale compiled backend refuses to run; a fresh one is bound by its identity record', async t => {
  const root = temporary('amcp-binding-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const [file, text] of Object.entries({
    'dist/src/app.js': 'compiled',
    'generated/schema.json': '{}',
    '.mirror/VENDOR/native.json': '{}',
    'web/app.js': 'web',
    'Skills/amcp-campaign-builder/SKILL.md': 'skill',
    'package.json': '{}',
    'package-lock.json': '{"lockfileVersion":3}',
    'docs/REPORTING-OVERVIEW.md': 'guide',
    'src/app.ts': 'export {};',
  }))
    write(root, file, text);
  await assert.rejects(releaseIdentityBinding(root), {message: 'RELEASE_IDENTITY_MISSING'});
  const record = packagedIdentity(root);
  write(root, 'dist/release-identity.json', JSON.stringify(record));
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(root, 'src/app.ts'), old, old);
  const binding = await releaseIdentityBinding(root);
  assert.equal(binding.sha256, record.sha256);
  assert.equal(binding.schema_version, 2);
  assert.match(binding.record_sha256, /^[0-9a-f]{64}$/);
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(path.join(root, 'src/app.ts'), later, later);
  await assert.rejects(releaseIdentityBinding(root), {message: 'RELEASE_IDENTITY_STALE'});
  write(root, 'dist/release-identity.json', '{"schema_version":2,"kind":"PRIVATE"}');
  await assert.rejects(releaseIdentityBinding(root), {message: 'RELEASE_IDENTITY_MISSING'});
});
