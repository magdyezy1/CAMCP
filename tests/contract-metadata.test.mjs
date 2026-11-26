// ACC-05 (R07 contract-metadata-not-content-derived): reviewed_at was a cascading ternary whose first matching list won,
// so later branches were dead and Google v25, Meta v26.0, Criteo 2026-07 and LinkedIn 202609 were all adopted after the
// emitted review date; contract_version was a hand-kept map. The record now comes from one manifest entry per provider,
// contract_digest identifies the content, and contracts:generate moves the record whenever the content changes.
// always-run: runs the generated contracts check against the whole catalogue
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  contractDigest,
  effectiveProviderContract,
  providerContractRecords,
  providerContracts,
} from '../dist/src/provider-contracts.js';
import {providerContractReference, providerContractView} from '../dist/src/contract-evidence.js';
import {providerSunsets, sentVersion} from '../dist/src/provider-sunsets.js';
import {removeTestDirectory} from '../dist/tests/temp.js';

const manifest = JSON.parse(fs.readFileSync('src/provider-contract-manifest.json', 'utf8'));

test('the digest changes with write_scope or api_version and ignores record metadata and test lists', () => {
  const base = effectiveProviderContract('google'),
    digest = contractDigest(base);
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(base.contract_digest, digest);
  assert.notEqual(contractDigest({...base, write_scope: base.write_scope + '; one more family'}), digest);
  assert.notEqual(contractDigest({...base, api_version: 'v26'}), digest);
  assert.notEqual(contractDigest({...base, reviewed_writes: 'unsupported'}), digest);
  // Record metadata and evidence lists describe the contract; they are not its content.
  for (const patch of [
    {reviewed_at: '2030-01-01'},
    {contract_version: 999},
    {tests: ['tests/another.test.mjs']},
    {diagnostic_tests: []},
    {live_qualification: 'read_accepted'},
    {contract_digest: 'sha256:other'},
  ])
    assert.equal(contractDigest({...base, ...patch}), digest, JSON.stringify(patch));
  // Another LinkedIn version is another contract.
  assert.notEqual(
    effectiveProviderContract('linkedin', '202608').contract_digest,
    effectiveProviderContract('linkedin').contract_digest,
  );
});

test('every provider has exactly one record and its recorded digest is current (no cascade, no dead branch)', () => {
  const ids = providerContracts.map(c => String(c.id)).sort();
  assert.deepEqual(Object.keys(manifest.providers).sort(), ids);
  assert.deepEqual(Object.keys(providerContractRecords).sort(), ids);
  for (const c of providerContracts) {
    const id = String(c.id),
      record = manifest.providers[id];
    assert.equal(c.reviewed_at, providerContractRecords[id].reviewed_at, id);
    assert.equal(c.contract_version, providerContractRecords[id].contract_version, id);
    assert.match(record.reviewed_at, /^\d{4}-\d{2}-\d{2}$/, id);
    assert.ok(Number.isSafeInteger(record.contract_version) && record.contract_version >= 1, id);
    // A stale digest means the content changed without its record: npm run contracts:generate moves both.
    assert.equal(record.contract_digest, effectiveProviderContract(id).contract_digest, id + ' record is stale');
  }
  const source = fs.readFileSync('src/provider-contracts.ts', 'utf8');
  assert.doesNotMatch(source, /reviewed_at:\s*\[/, 'reviewed_at is a record lookup, not a list cascade');
});

test('reviewed_at is never earlier than the adoption of the version AMCP sends', () => {
  const adopted = providerSunsets.filter(s => s.adopted);
  // The four adoptions the 2026-10-08 review found after the emitted review date are recorded.
  assert.deepEqual(adopted.map(s => s.provider + ' ' + s.version).sort(), [
    'criteo 2026-07',
    'google v25',
    'linkedin 202609',
    'meta v26.0',
  ]);
  for (const s of adopted) {
    if (sentVersion(s.provider) !== s.version) continue;
    const record = manifest.providers[s.provider];
    assert.ok(record.reviewed_at >= s.adopted, s.provider + ' reviewed ' + record.reviewed_at + ' < ' + s.adopted);
  }
});

test('the compact reference and the full view carry the same digest', () => {
  for (const c of providerContracts) {
    const view = providerContractView(String(c.gateway)),
      reference = providerContractReference(String(c.gateway));
    assert.match(String(view.contract_digest), /^sha256:[0-9a-f]{64}$/, String(c.id));
    assert.equal(reference.contract_digest, view.contract_digest, String(c.id));
  }
});

test('contracts:generate never invents a review date: changed content needs --reviewed-at (regression: the run day)', () => {
  // A scratch checkout: the generator reads and writes src/provider-contract-manifest.json and docs/CONTRACTS.md in
  // its working directory, so the committed files are never touched.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-contracts-')),
    generator = path.resolve('dist/tools/generate-contracts.js'),
    stale = structuredClone(manifest);
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'docs'));
    // Google's content "changed" since its record: its recorded digest no longer matches.
    stale.providers.google = {...stale.providers.google, contract_digest: 'sha256:' + '0'.repeat(64)};
    const write = () =>
        fs.writeFileSync(path.join(dir, 'src/provider-contract-manifest.json'), JSON.stringify(stale, null, 2)),
      read = () => JSON.parse(fs.readFileSync(path.join(dir, 'src/provider-contract-manifest.json'), 'utf8')),
      run = (...args) => spawnSync(process.execPath, [generator, ...args], {cwd: dir, encoding: 'utf8'});
    write();
    const undated = run();
    assert.notEqual(undated.status, 0);
    assert.match(undated.stderr, /content changed for google: review the change, then run .*--reviewed-at=YYYY-MM-DD/);
    assert.deepEqual(read(), stale, 'nothing was written');
    assert.equal(fs.existsSync(path.join(dir, 'docs/CONTRACTS.md')), false);
    // A date that is not a date, a later day, or one before the recorded review is refused, writing nothing.
    const recorded = manifest.providers.google;
    for (const date of ['2026-13-01', '9999-01-01', '2020-01-01']) {
      const refused = run('--reviewed-at=' + date);
      assert.notEqual(refused.status, 0, date);
      assert.match(refused.stderr, /--reviewed-at/, date);
      assert.deepEqual(read(), stale, date);
    }
    // With the reviewer's date the record moves: the version is bumped, that date recorded, the digest current.
    const today = new Date().toISOString().slice(0, 10),
      dated = run('--reviewed-at=' + today);
    assert.equal(dated.status, 0, dated.stderr);
    assert.deepEqual(read().providers.google, {
      contract_version: recorded.contract_version + 1,
      reviewed_at: today,
      contract_digest: recorded.contract_digest,
    });
    assert.deepEqual(read().providers.meta, manifest.providers.meta, 'an unchanged contract keeps its record');
  } finally {
    removeTestDirectory(dir, 'amcp-contracts-');
  }
});

test('contracts:check passes on the committed records and refuses a version override while recording', () => {
  const ok = spawnSync(process.execPath, ['dist/tools/generate-contracts.js', '--check'], {encoding: 'utf8'});
  assert.equal(ok.status, 0, ok.stderr);
  const overridden = spawnSync(process.execPath, ['dist/tools/generate-contracts.js', '--check'], {
    encoding: 'utf8',
    env: {...process.env, AMCP_META_API_VERSION: 'v25.0'},
  });
  assert.notEqual(overridden.status, 0);
  assert.match(overridden.stderr, /Unset AMCP_META_API_VERSION/);
});
