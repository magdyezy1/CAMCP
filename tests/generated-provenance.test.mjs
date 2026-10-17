// ARC-03: every tracked generated artifact names its generator, its inputs and the check that fails when it is edited
// by hand or stale, and that check is a gate of both `npm run check` and qualification. Before it, nothing listed the
// generated artifacts, generated/apple-platform-v1-models.json had no check, and the Google bid-field and Cloudflare
// range checks ran in `npm run check` but never in qualification (tools/qualify.mjs), so a qualified tree could carry
// them stale.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {
  embeddedInputProblems,
  gates,
  generatedArtifacts,
  inventoryProblems,
  provenanceListing,
  provenanceProblems,
} from '../tools/generated-provenance.mjs';
import {profileStages} from '../tools/qualify.mjs';
import {freshnessChecks} from '../tools/related-tests.mjs';
import {removeTestDirectory} from '../dist/tests/temp.js';

const temporary = t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-generated-provenance-'));
  t.after(() => removeTestDirectory(directory, 'amcp-generated-provenance-'));
  return directory;
};
const write = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
  fs.writeFileSync(path.join(root, file), text);
};

test('the repository passes the generated-artifact provenance check', () => {
  assert.deepEqual(provenanceProblems('.'), []);
});

test('every file in generated/ and the ledger, report and guide outputs are declared with a generator and a gate', () => {
  const declared = generatedArtifacts.flatMap(a => a.outputs);
  for (const file of fs.readdirSync('generated')) assert.ok(declared.includes('generated/' + file), file);
  for (const file of [
    '.mirror/REPORTS/evidence-hashes.json',
    '.mirror/REPORTS/implementation-status.json',
    '.mirror/REPORTS/compatibility-verification.json',
    'docs/implementation/ACTION-CONTRACT-COVERAGE.json',
    'Skills/amcp-campaign-builder/references/workspace.md',
    // The architecture ratchet's baseline (ARC-01, ARC-04), merged beside this inventory in wave 3b.
    'docs/review/architecture-baseline.json',
  ])
    assert.ok(declared.includes(file), file);
  for (const artifact of generatedArtifacts) {
    assert.ok(fs.existsSync(artifact.generator), artifact.generator);
    assert.ok(artifact.inputs.length && artifact.provenance && artifact.regenerate, artifact.id);
  }
  const listing = provenanceListing('.');
  assert.match(
    listing.artifacts.find(a => a.id === 'registry').outputs['generated/registry.json'],
    /^sha256:[a-f0-9]{64}$/,
  );
  assert.equal(listing.capture.withheld.label, 'historical_capture_not_shipped');
});

test('qualification runs every generated-artifact check, including the bid-field and Cloudflare checks it skipped', () => {
  const fast = profileStages('fast'),
    scripts = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts;
  for (const name of ['generate_bids_check', 'generate_cloudflare_check', 'generated_provenance_check']) {
    const stage = fast.find(s => s.name === name);
    assert.ok(stage?.freshness, name + ' is a freshness gate');
  }
  for (const gate of Object.values(gates)) {
    assert.ok(
      scripts.check
        .split('&&')
        .map(s => s.trim())
        .includes(gate.chain),
      gate.chain,
    );
    assert.deepEqual(fast.find(s => s.name === gate.qualify)?.args, gate.argv, gate.qualify);
  }
  assert.ok(
    freshnessChecks.some(c => c.name === 'generated_provenance_check'),
    'test:related runs it too',
  );
});

test('an undeclared generated file, an unchained check and a mismatched qualification gate are each refused', t => {
  const root = temporary(t);
  write(root, 'tools/gen.mjs', '// generator\n');
  write(root, 'generated/declared.json', '{}\n');
  write(root, 'generated/stray.json', '{}\n');
  write(root, 'tests/demo.test.mjs', "spawnSync(process.execPath, ['tools/other.mjs', '--check']);\n");
  write(
    root,
    'package.json',
    JSON.stringify({scripts: {'demo:check': 'node tools/gen.mjs --check', check: 'npm run format:check'}}),
  );
  const artifacts = [
    {
      id: 'demo',
      outputs: ['generated/declared.json'],
      generator: 'tools/gen.mjs',
      check: {chain: 'npm run demo:check', argv: ['tools/gen.mjs', '--check'], qualify: 'demo_check'},
    },
    {id: 'missing', outputs: ['generated/absent.json'], generator: 'tools/none.mjs', check: undefined},
    {
      id: 'suite',
      outputs: [],
      generator: 'tools/gen.mjs',
      check: {test: 'tests/demo.test.mjs', argv: ['tools/gen.mjs', '--check']},
    },
  ];
  const problems = inventoryProblems(root, {
    artifacts,
    stages: [{name: 'demo_check', args: ['tools/gen.mjs', '--other']}],
  });
  assert.deepEqual(
    problems.sort(),
    [
      'demo: `npm run demo:check` is not in `npm run check`.',
      'demo: qualification gate demo_check runs other arguments.',
      'generated/stray.json has no declared generator or check.',
      'missing: generated/absent.json does not exist.',
      'missing: generator tools/none.mjs does not exist.',
      'missing: no check fails when it is edited by hand or stale.',
      'suite: tests/demo.test.mjs does not run tools/gen.mjs --check.',
    ].sort(),
  );
});

test('an artifact whose recorded input digest no longer matches the input is reported stale', t => {
  const root = temporary(t),
    digest = text => createHash('sha256').update(text).digest('hex');
  write(root, 'inputs/a.json', '{"a":1}\n');
  write(root, 'inputs/b.json', '{"b":1}\n');
  const artifact = {
    id: 'demo',
    outputs: ['generated/demo.json'],
    regenerate: 'npm run demo',
    embedded: () => ({'inputs/a.json': digest('{"a":1}\n'), 'inputs/b.json': digest('{"b":1}\n')}),
  };
  assert.deepEqual(embeddedInputProblems(root, [artifact]), []);
  write(root, 'inputs/b.json', '{"b":2}\n');
  fs.unlinkSync(path.join(root, 'inputs/a.json'));
  assert.deepEqual(embeddedInputProblems(root, [artifact]), [
    'generated/demo.json is stale: inputs/a.json no longer exists. Run npm run demo.',
    'generated/demo.json is stale: inputs/b.json changed since it was generated. Run npm run demo.',
  ]);
});
