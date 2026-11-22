import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {removeFixture, removeTestDirectory} from './temp.js';

const generator = path.resolve('dist/tools/action-contracts.js');
const artifactNames = ['ACTION-CONTRACT-COVERAGE.json', 'ACTION-CONTRACT-COVERAGE.csv', 'VENDOR-METHOD-COVERAGE.json'];
const workspaceGuide = 'Skills/amcp-campaign-builder/references/workspace.md';

function withArtifacts(check: (directory: string) => void) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-contract-artifacts-'));
  try {
    fs.mkdirSync(path.join(directory, 'docs/implementation'), {recursive: true});
    const vendor = path.join(directory, '.mirror/VENDOR');
    fs.mkdirSync(vendor, {recursive: true});
    // The generator reads public pinned specifications only; never copy live samples or credentials.
    for (const file of fs.readdirSync('.mirror/VENDOR').filter(file => file.endsWith('.json'))) {
      fs.copyFileSync(path.join('.mirror/VENDOR', file), path.join(vendor, file));
    }
    // The generator also writes the AMCP tools' action reference into the workspace guide (MCP-07), so it reads it.
    fs.mkdirSync(path.join(directory, path.dirname(workspaceGuide)), {recursive: true});
    fs.copyFileSync(workspaceGuide, path.join(directory, workspaceGuide));
    const generated = run(directory, []);
    assert.equal(generated.status, 0, generated.stderr);
    check(directory);
  } finally {
    removeTestDirectory(directory, 'amcp-contract-artifacts-');
  }
}

function run(directory: string, args: string[]) {
  const result = spawnSync(process.execPath, [generator, ...args], {
    cwd: directory,
    encoding: 'utf8',
    // Full Docker qualification contends with the parallel native suites. CI172 exceeded 30 seconds;
    // keep the child bounded while allowing that observed contention, with all byte/status checks intact.
    timeout: 90000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  return result;
}

test('generated action ledgers pass exact checks after Git LF normalization', () => {
  withArtifacts(directory => {
    const expected = new Map<string, string>();
    for (const name of artifactNames) {
      const file = path.join(directory, 'docs/implementation', name);
      // Reproduce the repository's text=auto eol=lf checkout policy on every host.
      const committed = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
      fs.writeFileSync(file, committed);
      expected.set(file, committed);
    }
    const checked = run(directory, ['--check']);
    assert.equal(checked.status, 0, checked.stderr);
    const regenerated = run(directory, []);
    assert.equal(regenerated.status, 0, regenerated.stderr);
    for (const [file, committed] of expected)
      assert.equal(fs.readFileSync(file, 'utf8'), committed, path.basename(file));
  });
});

test('action ledger checks reject changed CSV content and missing artifacts without rewriting them', () => {
  withArtifacts(directory => {
    const file = path.join(directory, 'docs/implementation/ACTION-CONTRACT-COVERAGE.csv');
    const original = fs.readFileSync(file, 'utf8');
    const changed = original.replace('"CREATE_CAMPAIGN_ASSET"', '"REMOVED_CAMPAIGN_ASSET"');
    assert.notEqual(changed, original, 'The fixture must alter a real action.');
    fs.writeFileSync(file, changed);
    const stale = run(directory, ['--check']);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /Action contract ledger is stale: docs\/implementation\/ACTION-CONTRACT-COVERAGE\.csv/);
    assert.equal(fs.readFileSync(file, 'utf8'), changed);
    removeFixture(file);
    const missing = run(directory, ['--check']);
    assert.equal(missing.status, 1);
    assert.match(
      missing.stderr,
      /Action contract ledger is stale: docs\/implementation\/ACTION-CONTRACT-COVERAGE\.csv/,
    );
    assert.equal(fs.existsSync(file), false);
  });
});
