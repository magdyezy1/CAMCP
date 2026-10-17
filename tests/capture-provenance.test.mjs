// ARC-03 Stage A: honest provenance for the captured catalog. Before it, generated/registry.json embedded all 197
// evidence digests as `provenance.source_hashes` although 121 named files the repository does not ship, the 19
// .mirror/CATALOG files the registry is generated from were not hashed at all, nothing proved CATALOG and TOOLS match
// the shipped capture, and `npm run capture:normalize` on the public tree would have rewritten them without the
// withheld operations. These tests pin each of those and the refusals that now guard them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {
  declaredWithheld,
  evidenceFile,
  evidenceProvenance,
  withheldDigest,
  withheldFile,
  withheldLabel,
} from '../tools/evidence-hashes.mjs';
import {
  captureProblems,
  capturedCatalogDigest,
  capturedCatalogFiles,
  capturedCatalogFilesDigest,
  normalizeCapture,
} from '../tools/catalog/normalize.mjs';
import {removeTestDirectory} from '../dist/tests/temp.js';

const sha256 = text => createHash('sha256').update(text).digest('hex');
const generator = path.resolve('codegen/generate.mjs'),
  normalizer = path.resolve('tools/catalog/normalize.mjs');
const envelope = data => ({content: [{type: 'text', text: JSON.stringify(data)}]});
const write = (root, file, data) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
  fs.writeFileSync(path.join(root, file), typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
};

/**
 * A synthetic capture of one LIST_ACTIONS gateway, normalized the way the owner normalizes the complete capture, plus
 * one evidence entry for a preview file the tree withholds and its declaration.
 */
function syntheticCapture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-capture-provenance-'));
  t.after(() => removeTestDirectory(root, 'amcp-capture-provenance-'));
  const gateway = 'demo_native_action';
  write(root, '.mirror/RAW/help.json', {response: envelope({surface: 'demo', gateways: [gateway]})});
  write(root, '.mirror/RAW/' + gateway + '/help.json', {
    response: envelope({mode: 'direct', description: 'Demo gateway', inputSchema: {type: 'object', properties: {}}}),
  });
  write(root, '.mirror/RAW/' + gateway + '/catalog-0000.json', {
    request: {args: {action: 'LIST_ACTIONS', offset: 0, limit: 100}},
    response: envelope({
      success: true,
      data: {
        total_actions: 2,
        has_more: false,
        api_version: 'v1',
        actions: [
          {name: 'demo_things_get', method: 'GET', path: '/v1/things', read_only: true},
          {name: 'demo_things_create', method: 'POST', path: '/v1/things', read_only: false},
        ],
      },
    }),
  });
  write(root, '.mirror/RAW/' + gateway + '/describe-demo_things_get.json', {
    request: {args: {action: 'DESCRIBE_ACTION', target_action: 'demo_things_get'}},
    response: envelope({success: true, data: {action: 'demo_things_get', method: 'GET'}}),
  });
  const normalized = normalizeCapture(root);
  for (const catalog of normalized.catalogs) write(root, '.mirror/CATALOG/' + catalog.gateway + '.json', catalog);
  write(root, '.mirror/TOOLS.json', normalized.toolsFile);
  const withheld = '.mirror/RAW/' + gateway + '/preview-empty-payload.json';
  write(root, evidenceFile, {...normalized.hashes, [withheld]: sha256('a withheld preview')});
  write(root, withheldFile, {
    format_version: 1,
    label: withheldLabel,
    evidence: evidenceFile,
    count: 0,
    digest: '',
    groups: [
      {
        pattern: '.mirror/RAW/*/preview-empty-payload.json',
        reason: 'Preview responses that name provider account identifiers.',
        count: 0,
        files: [],
      },
    ],
  });
  write(root, withheldFile, declaredWithheld(root));
  return {root, gateway, withheld, page: '.mirror/RAW/' + gateway + '/catalog-0000.json'};
}
const generate = (root, args = []) =>
  spawnSync(process.execPath, [generator, ...args], {cwd: root, encoding: 'utf8', windowsHide: true});

test('every evidence entry of the repository is shipped and verified or declared withheld: none is unexplained', () => {
  const result = evidenceProvenance('.'),
    declaration = JSON.parse(fs.readFileSync(withheldFile, 'utf8')),
    evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
  assert.deepEqual(result.problems, []);
  assert.equal(Object.keys(result.shipped).length + result.withheld.count, Object.keys(evidence).length);
  assert.equal(result.withheld.label, 'historical_capture_not_shipped');
  assert.equal(result.withheld.count, declaration.count);
  assert.equal(result.withheld.digest, declaration.digest);
  // Every shipped entry is a file whose bytes hash to its captured digest; every withheld one is absent.
  for (const [file, digest] of Object.entries(result.shipped))
    assert.equal(sha256(fs.readFileSync(file)), digest, file);
  for (const file of declaration.groups.flatMap(g => g.files)) assert.equal(fs.existsSync(file), false, file);
  // The derived content of each withheld operation answer is what the repository keeps instead.
  const operations = JSON.parse(fs.readFileSync('.mirror/TOOLS.json', 'utf8')).tools.flatMap(tool =>
    (tool.operations ?? []).map(op => '.mirror/RAW/' + tool.name + '/operation-' + op.operation + '.json'),
  );
  assert.deepEqual(
    declaration.groups.find(g => g.pattern === '.mirror/RAW/*/operation-*.json').files,
    [...operations].sort(),
  );
});

test('the registry records provenance format 2: hashed catalog inputs, verified shipped files, a labelled withheld set', () => {
  // Before ARC-03: {source_hashes: <all 197 digests>, generator_version: 1}, with no CATALOG or TOOLS digest.
  const registry = JSON.parse(fs.readFileSync('generated/registry.json', 'utf8')),
    provenance = registry.provenance,
    declaration = JSON.parse(fs.readFileSync(withheldFile, 'utf8')),
    manifest = JSON.parse(fs.readFileSync('generated/manifest.json', 'utf8'));
  assert.equal(provenance.format_version, 2);
  assert.equal(provenance.generator, 'codegen/generate.mjs');
  assert.equal(provenance.source_hashes, undefined, 'unverifiable digests are no longer presented as source hashes');
  for (const file of ['.mirror/TOOLS.json', ...capturedCatalogFiles('.').filter(f => f.includes('/CATALOG/'))])
    assert.equal(
      provenance.inputs[file],
      sha256(fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n')),
      file + ' is hashed into the registry provenance',
    );
  assert.equal(Object.keys(provenance.inputs).filter(f => f.startsWith('.mirror/CATALOG/')).length, 19);
  for (const [file, digest] of Object.entries(provenance.capture.shipped))
    assert.equal(sha256(fs.readFileSync(file)), digest, file);
  assert.deepEqual(provenance.capture.withheld, {
    label: 'historical_capture_not_shipped',
    count: declaration.count,
    digest: declaration.digest,
    declaration: withheldFile,
  });
  assert.equal(manifest.generator_version, 2);
  assert.equal(manifest.capture_withheld, declaration.count);
  assert.equal(manifest.registry_sha256, sha256(fs.readFileSync('generated/registry.json', 'utf8')));
});

test('a synthetic capture generates provenance 2 and the withheld digest is over the sorted path and digest lines', t => {
  const f = syntheticCapture(t),
    run = generate(f.root);
  assert.equal(run.status, 0, run.stderr);
  const provenance = JSON.parse(fs.readFileSync(path.join(f.root, 'generated/registry.json'), 'utf8')).provenance,
    evidence = JSON.parse(fs.readFileSync(path.join(f.root, evidenceFile), 'utf8'));
  assert.equal(provenance.capture.withheld.count, 1);
  assert.equal(provenance.capture.withheld.digest, withheldDigest([[f.withheld, evidence[f.withheld]]]));
  assert.equal(provenance.capture.withheld.digest, 'sha256:' + sha256(f.withheld + ' ' + evidence[f.withheld] + '\n'));
  assert.ok(provenance.capture.shipped[f.page]);
  assert.ok(provenance.inputs['.mirror/CATALOG/' + f.gateway + '.json']);
  assert.match(generate(f.root, ['--check']).stdout, /Generated outputs are current/);
});

test('an absent capture file nobody declared withheld is refused, and the registry is not generated', t => {
  const f = syntheticCapture(t),
    declaration = JSON.parse(fs.readFileSync(path.join(f.root, withheldFile), 'utf8'));
  declaration.groups[0].files = [];
  declaration.groups[0].count = 0;
  write(f.root, withheldFile, declaration);
  const run = generate(f.root);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /preview-empty-payload\.json: absent from the tree and not declared withheld/);
  assert.equal(fs.existsSync(path.join(f.root, 'generated/registry.json')), false);
});

test('a shipped capture file that no longer matches its digest is refused by the evidence and capture checks', t => {
  const f = syntheticCapture(t),
    page = path.join(f.root, f.page);
  fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replace('demo_things_get', 'demo_things_list'));
  assert.ok(
    evidenceProvenance(f.root).problems.some(
      p => p === f.page + ': the shipped bytes do not match the captured digest.',
    ),
  );
  assert.equal(generate(f.root).status, 1);
  const capture = captureProblems(f.root, {frozen: capturedCatalogFilesDigest(f.root)});
  assert.ok(capture.problems.some(p => p.includes('differs from the catalog the shipped capture produces')));
});

test('a CRLF checkout of a shipped capture file still matches its captured digest', t => {
  const f = syntheticCapture(t),
    page = path.join(f.root, f.page);
  fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replaceAll('\n', '\r\n'));
  assert.deepEqual(evidenceProvenance(f.root).problems, []);
});

test('an edited withheld digest, a shipped file declared withheld and an unmatched group are each refused', t => {
  const f = syntheticCapture(t),
    evidence = JSON.parse(fs.readFileSync(path.join(f.root, evidenceFile), 'utf8'));
  write(f.root, evidenceFile, {...evidence, [f.withheld]: sha256('another preview')});
  assert.ok(
    evidenceProvenance(f.root).problems.includes(
      withheldFile + ': digest no longer matches the withheld entries of ' + evidenceFile + '.',
    ),
  );
  write(f.root, evidenceFile, evidence);
  write(f.root, f.withheld, 'a withheld preview');
  assert.ok(
    evidenceProvenance(f.root).problems.includes(
      f.withheld + ': declared withheld but shipped; remove it from ' + withheldFile + '.',
    ),
  );
  fs.unlinkSync(path.join(f.root, f.withheld));
  write(f.root, evidenceFile, {...evidence, '.mirror/RAW/demo_native_action/operation-x.json': sha256('x')});
  assert.throws(() => declaredWithheld(f.root), /operation-x\.json is withheld but no group .* matches it/);
});

test('the captured catalog re-derives from the shipped capture and its frozen digest catches a consistent edit', t => {
  // The repository: every CATALOG and TOOLS byte except the withheld operation schemas comes from shipped files.
  const real = captureProblems('.');
  assert.deepEqual(real.problems, []);
  assert.equal(real.digest, capturedCatalogDigest);
  assert.equal(
    real.withheldDerived.length,
    JSON.parse(fs.readFileSync('.mirror/TOOLS.json', 'utf8')).tools.reduce(
      (n, x) => n + (x.operations?.length ?? 0),
      0,
    ),
  );
  // A synthetic capture: an edited CATALOG record no longer re-derives, and the frozen digest no longer matches.
  const f = syntheticCapture(t),
    frozen = capturedCatalogFilesDigest(f.root);
  assert.deepEqual(captureProblems(f.root, {frozen}).problems, []);
  const file = path.join(f.root, '.mirror/CATALOG/' + f.gateway + '.json'),
    catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  catalog.actions[0].read_only = false;
  write(f.root, '.mirror/CATALOG/' + f.gateway + '.json', catalog);
  const problems = captureProblems(f.root, {frozen}).problems;
  assert.ok(
    problems.includes('.mirror/CATALOG/' + f.gateway + '.json differs from the catalog the shipped capture produces.'),
  );
  assert.ok(problems.some(p => p.startsWith('The captured catalog is frozen (owner decision D17)')));
});

test('a file in the capture that the evidence list does not name is refused', t => {
  const f = syntheticCapture(t);
  write(f.root, '.mirror/RAW/' + f.gateway + '/describe-unlisted.json', {
    request: {args: {target_action: 'unlisted'}},
    response: envelope({success: false}),
  });
  const problems = captureProblems(f.root, {frozen: capturedCatalogFilesDigest(f.root)}).problems;
  assert.ok(
    problems.includes(
      '.mirror/RAW/' + f.gateway + '/describe-unlisted.json: a capture file the evidence list does not name.',
    ),
  );
});

test('normalizing a capture with withheld files is refused and rewrites nothing', t => {
  const f = syntheticCapture(t),
    before = fs.readFileSync(path.join(f.root, '.mirror/CATALOG/' + f.gateway + '.json'), 'utf8'),
    evidence = fs.readFileSync(path.join(f.root, evidenceFile), 'utf8');
  const run = spawnSync(process.execPath, [normalizer], {cwd: f.root, encoding: 'utf8', windowsHide: true});
  assert.equal(run.status, 1);
  assert.match(run.stderr, /1 capture files of the evidence list are not present \(withheld/);
  assert.equal(fs.readFileSync(path.join(f.root, '.mirror/CATALOG/' + f.gateway + '.json'), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(f.root, evidenceFile), 'utf8'), evidence);
  const check = spawnSync(process.execPath, [normalizer, '--check'], {
    cwd: f.root,
    encoding: 'utf8',
    windowsHide: true,
  });
  // The synthetic capture is not the recorded frozen catalog, so only the frozen digest fails.
  assert.equal(check.status, 1);
  assert.deepEqual(
    check.stderr.split('\n').filter(line => line && !line.startsWith('{')),
    [check.stderr.split('\n').find(line => line.startsWith('The captured catalog is frozen'))],
  );
});
