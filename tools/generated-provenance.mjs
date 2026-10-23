// Generated-artifact provenance (ARC-03): every generated or derived file the repository tracks, the generator that
// writes it, what it is generated from, where it records its inputs and their digests, and the check that fails when
// it is edited by hand or stale.
//
//   node tools/generated-provenance.mjs           print each artifact with its generator, check and current SHA-256
//   node tools/generated-provenance.mjs --check   fail when an artifact is undeclared, missing or unchecked, when its
//                                                 check is not a gate of `npm run check` and of qualification, or when
//                                                 a provenance check below fails
//
// --check also runs the checks that have no generator of their own to rerun: the capture evidence digests
// (tools/evidence-hashes.mjs), the captured catalog re-derived from the shipped capture (tools/catalog/normalize.mjs),
// the Apple SDK evidence (tools/apple-model-evidence.mjs) and the input digests that artifacts embed. The other
// artifacts are regenerated and compared by their own checks, which this one only requires to be gates. It reads
// committed files only, contacts nothing and writes nothing.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {evidenceProvenance} from './evidence-hashes.mjs';
import {captureProblems} from './catalog/normalize.mjs';
import {appleModelProblems, appleModelsFile} from './apple-model-evidence.mjs';
import {profileStages} from './qualify.mjs';

const textDigest = text => createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex');
/** A freshness gate: its token in the `npm run check` chain, the node arguments it runs, its qualification stage. */
const gate = (chain, argv, qualify) => ({chain, argv, qualify});
export const gates = {
  provenance: gate(
    'npm run provenance:check',
    ['tools/generated-provenance.mjs', '--check'],
    'generated_provenance_check',
  ),
  generate: gate('npm run generate:check', ['codegen/generate.mjs', '--check'], 'generate_check'),
  vendor: gate(
    'npm run generate:vendor:check',
    ['tools/fetch-vendor-specs.mjs', '--generate-only', '--check'],
    'generate_vendor_check',
  ),
  wsdl: gate(
    'npm run generate:wsdl:check',
    ['tools/microsoft-specs.mjs', '--generate-only', '--check'],
    'generate_wsdl_check',
  ),
  feeds: gate('npm run generate:feeds:check', ['tools/google-asset-set-fields.mjs', '--check'], 'generate_feeds_check'),
  cloudflare: gate(
    'npm run generate:cloudflare:check',
    ['tools/cloudflare-ranges.mjs', '--check'],
    'generate_cloudflare_check',
  ),
  bids: gate('npm run generate:bids:check', ['tools/google-bid-fields.mjs', '--check'], 'generate_bids_check'),
  report: gate('npm run report -- --check', ['dist/tools/report.js', '--check'], 'report_check'),
  contracts: gate('npm run contracts:check', ['dist/tools/generate-contracts.js', '--check'], 'contracts_check'),
  actions: gate(
    'npm run contracts:actions:check',
    ['dist/tools/action-contracts.js', '--check'],
    'contracts_actions_check',
  ),
  docs: gate('npm run docs:index:check', ['tools/docs-index.mjs', '--check'], 'docs_index_check'),
  architecture: gate('npm run architecture:check', ['tools/architecture-map.mjs', '--check'], 'architecture_check'),
};
/**
 * The tracked generated and derived artifacts. `outputs` may use `*` within one path segment. `provenance` says where
 * the artifact records its inputs and their digests; `embedded` reads that record when this check verifies it.
 */
export const generatedArtifacts = [
  {
    id: 'captured_catalog',
    outputs: ['.mirror/TOOLS.json', '.mirror/CATALOG/*.json', '.mirror/REPORTS/evidence-hashes.json'],
    generator: 'tools/catalog/normalize.mjs',
    regenerate:
      'Owner-only, from the complete capture (`npm run capture:normalize`); refused while capture files are withheld. The captured catalog is frozen (D17).',
    inputs: ['.mirror/RAW/**'],
    provenance:
      'Per-file capture digests in .mirror/REPORTS/evidence-hashes.json, the withheld set in .mirror/RAW/WITHHELD.json and the frozen digest capturedCatalogDigest in tools/catalog/normalize.mjs. `npm run capture:check` re-derives everything except the withheld operation schemas from the shipped capture.',
    check: gates.provenance,
  },
  {
    id: 'registry',
    outputs: ['generated/registry.json', 'generated/manifest.json'],
    generator: 'codegen/generate.mjs',
    regenerate: 'npm run generate',
    inputs: [
      '.mirror/TOOLS.json',
      '.mirror/CATALOG/*.json',
      '.mirror/RAW/*/describe-*.json',
      '.mirror/VENDOR/dv360-v4.json',
      '.mirror/REPORTS/evidence-hashes.json',
      '.mirror/RAW/WITHHELD.json',
    ],
    provenance:
      'generated/registry.json provenance (format 2): inputs with their digests, the shipped capture files and the withheld set; generated/manifest.json summarizes it.',
    embedded: root => readJson(root, 'generated/registry.json').provenance.inputs,
    check: gates.generate,
  },
  {
    id: 'vendor_routes',
    outputs: ['generated/vendor-routes.json'],
    generator: 'tools/fetch-vendor-specs.mjs',
    regenerate: 'node tools/fetch-vendor-specs.mjs --generate-only',
    inputs: ['.mirror/VENDOR/*.json', 'generated/registry.json'],
    provenance: 'sourceIntegrity: the source URL and document SHA-256 of every pinned vendor document.',
    check: gates.vendor,
  },
  {
    id: 'microsoft_contracts',
    outputs: ['generated/microsoft-contracts.json', 'generated/microsoft-summary.json'],
    generator: 'tools/microsoft-specs.mjs',
    regenerate: 'node tools/microsoft-specs.mjs --generate-only',
    inputs: ['.mirror/VENDOR/microsoft-*-v13.json'],
    provenance: 'services.*: the WSDL source URL, xml_sha256 and document_sha256 of each service.',
    check: gates.wsdl,
  },
  {
    id: 'google_bid_fields',
    outputs: ['generated/google-bid-fields.json'],
    generator: 'tools/google-bid-fields.mjs',
    regenerate: 'npm run generate:bids',
    inputs: ['.mirror/VENDOR/google-ads-v25.json'],
    provenance: 'generated_by, source and source_sha256.',
    check: gates.bids,
  },
  {
    id: 'cloudflare_ranges',
    outputs: ['generated/cloudflare-ranges.json', 'server/cloudflare-ranges.ts'],
    generator: 'tools/cloudflare-ranges.mjs',
    regenerate:
      'node tools/cloudflare-ranges.mjs (the module from the snapshot); the snapshot only with --refresh, an owner-run release step',
    inputs: ["Cloudflare's published edge address lists (the snapshot's sources)"],
    provenance: 'The snapshot names its sources and retrieved_at; the module names the snapshot it was generated from.',
    check: gates.cloudflare,
  },
  {
    id: 'apple_models',
    outputs: [appleModelsFile],
    generator: 'tools/apple-model-evidence.mjs',
    regenerate:
      'node tools/apple-model-evidence.mjs <SDK checkout>/src/model <SDK checkout>/src/api/apple-ads-api.ts, then record its digest',
    inputs: ['Apple Ads Platform API Node SDK at the pinned revision (appleSdkRevision)'],
    provenance:
      'revision, api_source and the canonical SHA-256 of each SDK source; the file digest is pinned as appleModelsDigest. `node tools/apple-model-evidence.mjs --fetch --sdk <dir> --check` re-derives it from the pinned revision.',
    check: gates.provenance,
  },
  {
    id: 'google_asset_set_fields',
    outputs: ['src/google-asset-set-fields.ts'],
    generator: 'tools/google-asset-set-fields.mjs',
    regenerate: 'node tools/google-asset-set-fields.mjs',
    inputs: ['tests/fixtures/google-asset-fields-v23.json'],
    provenance: 'Its header names the generator and its source facts.',
    check: gates.feeds,
  },
  {
    id: 'action_ledger',
    outputs: [
      'docs/implementation/ACTION-CONTRACT-COVERAGE.json',
      'docs/implementation/ACTION-CONTRACT-COVERAGE.csv',
      'docs/implementation/VENDOR-METHOD-COVERAGE.json',
      'generated/route-anchors.json',
      'docs/implementation/ROUTE-ANCHOR-COVERAGE.md',
      'Skills/amcp-campaign-builder/references/workspace.md',
    ],
    generator: 'tools/action-contracts.ts',
    regenerate: 'npm run contracts:actions',
    inputs: [
      'generated/registry.json',
      'generated/vendor-routes.json',
      'generated/apple-platform-v1-models.json',
      'generated/microsoft-summary.json',
      '.mirror/VENDOR/*.json',
      '.mirror/RAW/*/catalog-*.json',
      '.mirror/REPORTS/evidence-hashes.json',
      'tests/fixtures/meta-sdk-changes-v26.json',
      'tools/route-anchor-documents.json',
      'src/ (the built classification modules)',
    ],
    provenance:
      'ACTION-CONTRACT-COVERAGE.json and generated/route-anchors.json record their generator and input digests (provenance, inputs); VENDOR-METHOD-COVERAGE.json summary has the SHA-256 of every pinned vendor document; the guide section sits between its first-party-contracts markers.',
    embedded: root => ({
      ...readJson(root, 'docs/implementation/ACTION-CONTRACT-COVERAGE.json').provenance.inputs,
      ...readJson(root, 'generated/route-anchors.json').inputs,
    }),
    check: gates.actions,
  },
  {
    id: 'provider_contracts',
    outputs: ['docs/CONTRACTS.md', 'src/provider-contract-manifest.json'],
    generator: 'tools/generate-contracts.ts',
    regenerate: 'npm run contracts:generate -- --reviewed-at=YYYY-MM-DD',
    inputs: ['src/provider-contracts.ts and the modules it names'],
    provenance: 'Each provider contract records contract_digest, contract_version and reviewed_at in the manifest.',
    check: gates.contracts,
  },
  {
    id: 'implementation_report',
    outputs: [
      '.mirror/REPORTS/implementation-status.json',
      '.mirror/REPORTS/compatibility-verification.json',
      '.mirror/PARITY.md',
    ],
    generator: 'tools/report.ts',
    regenerate:
      'npm run report, in a public release candidate only: its .mirror/RESULTS/live-read-samples.json is the empty generated fixture, never private account samples.',
    inputs: ['generated/registry.json', 'generated/vendor-routes.json', '.mirror/RAW/*', 'src/ (the built modules)'],
    provenance: 'compatibility_verification counts the replayed capture pages, descriptions and route fixtures.',
    check: gates.report,
  },
  {
    id: 'docs_index',
    outputs: ['docs/README.md', 'docs/review/PACKAGE-STATUS.md'],
    generator: 'tools/docs-index.mjs',
    regenerate: 'npm run docs:index',
    inputs: ['docs/**/*.md', 'docs/review/package-status.json', 'docs/moved.json'],
    provenance: 'Their headers name the generator.',
    check: gates.docs,
  },
  {
    // DOC-03 (owner decision P12): the redirect stub each moved document leaves at its old address.
    id: 'docs_redirect_stubs',
    outputs: [
      'docs/review/DELIVERY-*.md',
      'docs/review/INCIDENT-*.md',
      'docs/review/WORKBOOK-LOOKUP-2026-10-02.json',
      'docs/review/PROGRESS.md',
      'docs/review/SUMMARY.md',
      'docs/review/REVIEW-2026-10-01.md',
      'docs/review/REVIEW-2026-10-01-EVIDENCE.json',
      'docs/review/COMPLETION-2026-10-07.md',
      'docs/review/PLATFORMS.md',
      'docs/review/product/*.md',
      'docs/CAPABILITY-REVIEW-2026-09-08.md',
      'docs/HARDENING-REVIEW.md',
      'docs/RECOMMENDATIONS-IMPLEMENTED.md',
    ],
    generator: 'tools/docs-links.mjs',
    regenerate:
      'npm run docs:index (or node tools/docs-links.mjs --write, which also rewrites links to moved addresses)',
    inputs: ['docs/moved.json', 'the titles of the moved documents'],
    provenance: 'docs/moved.json lists every move and its date; each stub names its document’s new address.',
    check: gates.docs,
  },
  {
    // DOC-03: the documentation freeze's recorded counts, which may only fall.
    id: 'docs_lint_baseline',
    outputs: ['tools/docs-lint-baseline.json'],
    generator: 'tools/docs-lint.mjs',
    regenerate:
      'node tools/docs-lint.mjs --write, which refuses a count above its record unless --allow-increase=<reason> records why',
    inputs: ['README.md and the current pages of docs/ (not records, archive, implementation records or stubs)'],
    provenance: 'Per-page counts and every recorded increase with its reason; npm run docs:index:check counts again.',
    check: gates.docs,
  },
  {
    id: 'provider_access',
    outputs: ['docs/PROVIDER-ACCESS.md'],
    generator: 'tools/acceptance/provider-access.mjs',
    regenerate: 'npm run build, then node tools/acceptance/provider-access.mjs',
    inputs: [
      'src/provider-access.json',
      'src/acceptance-ledger.json',
      'docs/implementation/ACTION-CONTRACT-COVERAGE.json',
    ],
    provenance: 'Its header names the generator and its inputs.',
    // Checked by the suite rather than a freshness gate: it needs the built register module.
    check: {test: 'tests/provider-access.test.mjs', argv: ['tools/acceptance/provider-access.mjs', '--check']},
  },
  {
    // ARC-01 phase A and ARC-04: the architecture ratchet's recorded baseline (owner decision D26).
    id: 'architecture_baseline',
    outputs: ['docs/review/architecture-baseline.json'],
    generator: 'tools/architecture-map.mjs',
    regenerate:
      'npm run build, then npm run architecture:baseline, only after an intended improvement or a regression the owner accepted (the commit says which)',
    inputs: ['dist/src and dist/server (the runtime imports Node evaluates)', 'src/ and server/ (the source text)'],
    provenance:
      'The ratcheted measurements and the runtime import cycles; docs/review/ARCHITECTURE.md shows them in the table between its architecture-map markers, which the check compares with this file.',
    check: gates.architecture,
  },
  // WEB-07, merged beside this inventory in wave 3b: the Arabic catalog chunks the browser loads and the three website
  // ratchets' recorded baselines. check-web (a full-qualification stage, so not a freshness gate here) and the suite
  // regenerate or compare each; the named test fails when one is stale or edited past its limits.
  {
    id: 'arabic_catalog_chunks',
    outputs: ['web/locales/ar/*.json'],
    generator: 'tools/locale-chunks.mjs',
    regenerate:
      'node tools/locale-chunks.mjs --write, after a change to web/locales/ar.json or to the messages a page writes',
    inputs: [
      'web/locales/ar.json (the authored catalog)',
      'web/*.js and web/*.html (the messages each page writes)',
      'src/ and server/ (the messages the services send to the website)',
    ],
    provenance:
      'None embedded: check-web plans the chunks again and refuses a stale, stray or oversized one and a script whose chunks lack a message it requires.',
    check: {test: 'tests/web-locale-chunks.test.mjs', argv: ['tools/locale-chunks.mjs']},
  },
  {
    id: 'web_markup_baseline',
    outputs: ['tools/web-markup-baseline.json'],
    generator: 'tools/check-markup.mjs',
    regenerate: 'node tools/check-markup.mjs --write, which refuses a count above its limit: the counts only go down',
    inputs: ['web/*.js (the shipped first-party scripts)'],
    provenance: 'Per-script counts and their totals; check-web counts the scripts again and compares.',
    check: {test: 'tests/web-markup.test.mjs', argv: ['tools/check-markup.mjs']},
  },
  {
    id: 'web_colour_baseline',
    outputs: ['tools/web-colour-baseline.json'],
    generator: 'tools/check-colours.mjs',
    regenerate: 'node tools/check-colours.mjs --write, which refuses a count above its limit: the counts only go down',
    inputs: [
      'web/*.css (the shipped stylesheets)',
      'web/*.js and web/*.html (the shipped scripts and pages)',
      'tools/web-colour-allowlist.json (reviewed by hand)',
    ],
    provenance:
      'Per-stylesheet counts, their total and the sizes of both reviewed lists; check-web counts again and compares.',
    check: {test: 'tests/web-colours.test.mjs', argv: ['tools/check-colours.mjs']},
  },
  {
    id: 'web_design_token_baseline',
    outputs: ['tools/web-design-token-baseline.json'],
    generator: 'tools/check-design-tokens.mjs',
    regenerate:
      'node tools/check-design-tokens.mjs --write, which refuses a count above its limit: the counts only go down',
    inputs: ['web/*.css (the shipped stylesheets)'],
    provenance:
      'Per-stylesheet counts per scale (radius, shadow, motion and type written by hand, spacing off the 4px grid) and their totals; check-web compares.',
    check: {test: 'tests/web-design-tokens.test.mjs', argv: ['tools/check-design-tokens.mjs']},
  },
  {
    id: 'web_route_bytes_baseline',
    outputs: ['tools/web-route-bytes-baseline.json'],
    generator: 'tools/web-route-bytes.mjs',
    regenerate:
      'node tools/web-route-bytes.mjs --root <tree> --write --label <the tree and why>; its open gaps are written by hand and keep their targets',
    inputs: ['web/ of the tree named in recorded_from'],
    provenance:
      'recorded_from names the measured tree; open names each acceptance gap with its limit and reason. check-web measures the shipped tree and compares.',
    check: {test: 'tests/web-route-bytes.test.mjs', argv: ['tools/web-route-bytes.mjs']},
  },
];

function readJson(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
}
const segment = pattern =>
  new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*') + '$');
/** The files an output pattern names (a pattern without `*` names itself). */
function expand(root, pattern) {
  if (!pattern.includes('*')) return [pattern];
  const dir = path.posix.dirname(pattern),
    expression = segment(path.posix.basename(pattern));
  if (dir.includes('*')) throw Error('Only the last path segment of an output may hold *: ' + pattern);
  if (!fs.existsSync(path.join(root, dir))) return [];
  return fs
    .readdirSync(path.join(root, dir))
    .filter(f => expression.test(f))
    .sort()
    .map(f => dir + '/' + f);
}
/** The node arguments an `npm run <script> [-- args]` token runs, or undefined when the script is not `node …`. */
function argvOf(scripts, chain) {
  const match = /^npm run (\S+)(?: -- (.+))?$/.exec(chain);
  const command = match && scripts[match[1]];
  if (typeof command !== 'string' || !command.startsWith('node ')) return undefined;
  return [...command.slice(5).trim().split(/\s+/), ...(match[2] ? match[2].trim().split(/\s+/) : [])];
}

/** Problems with the declarations themselves and with how their checks are wired (an empty list passes). */
export function inventoryProblems(root = '.', {artifacts = generatedArtifacts, stages} = {}) {
  const problems = [],
    scripts = readJson(root, 'package.json').scripts ?? {},
    chain = String(scripts.check ?? '')
      .split('&&')
      .map(s => s.trim()),
    fast = stages ?? profileStages('fast'),
    declared = new Set();
  for (const artifact of artifacts) {
    if (!fs.existsSync(path.join(root, artifact.generator)))
      problems.push(artifact.id + ': generator ' + artifact.generator + ' does not exist.');
    for (const pattern of artifact.outputs) {
      const files = expand(root, pattern);
      if (!files.length) problems.push(artifact.id + ': no file matches ' + pattern + '.');
      for (const file of files) {
        if (declared.has(file)) problems.push(file + ' is declared by two artifacts.');
        declared.add(file);
        if (!fs.existsSync(path.join(root, file))) problems.push(artifact.id + ': ' + file + ' does not exist.');
      }
    }
    const check = artifact.check;
    if (check?.test) {
      const test = path.join(root, check.test);
      if (!fs.existsSync(test) || !fs.readFileSync(test, 'utf8').includes(check.argv[0]))
        problems.push(artifact.id + ': ' + check.test + ' does not run ' + check.argv.join(' ') + '.');
      continue;
    }
    if (!check?.chain) {
      problems.push(artifact.id + ': no check fails when it is edited by hand or stale.');
      continue;
    }
    if (!chain.includes(check.chain)) problems.push(artifact.id + ': `' + check.chain + '` is not in `npm run check`.');
    const argv = argvOf(scripts, check.chain);
    if (JSON.stringify(argv) !== JSON.stringify(check.argv))
      problems.push(artifact.id + ': `' + check.chain + '` does not run node ' + check.argv.join(' ') + '.');
    const stage = fast.find(s => s.name === check.qualify);
    if (!stage) problems.push(artifact.id + ': qualification has no freshness gate ' + check.qualify + '.');
    else if (JSON.stringify(stage.args) !== JSON.stringify(check.argv))
      problems.push(artifact.id + ': qualification gate ' + check.qualify + ' runs other arguments.');
  }
  // Nothing in generated/ escapes the inventory.
  for (const file of fs.readdirSync(path.join(root, 'generated')).sort())
    if (!declared.has('generated/' + file)) problems.push('generated/' + file + ' has no declared generator or check.');
  return problems;
}
/** Inputs whose current text no longer has the digest an artifact recorded for it (stale without regeneration). */
export function embeddedInputProblems(root = '.', artifacts = generatedArtifacts) {
  const problems = [];
  for (const artifact of artifacts.filter(a => a.embedded)) {
    let inputs;
    try {
      inputs = artifact.embedded(root);
    } catch (error) {
      problems.push(artifact.id + ': its provenance record cannot be read (' + error.message + ').');
      continue;
    }
    for (const [file, digest] of Object.entries(inputs ?? {})) {
      const current = fs.existsSync(path.join(root, file))
        ? textDigest(fs.readFileSync(path.join(root, file), 'utf8'))
        : undefined;
      if (current !== digest)
        problems.push(
          artifact.outputs[0] +
            ' is stale: ' +
            file +
            (current ? ' changed since it was generated' : ' no longer exists') +
            '. Run ' +
            artifact.regenerate +
            '.',
        );
    }
  }
  return problems;
}
/** Every problem `--check` reports. */
export function provenanceProblems(root = '.') {
  const capture = captureProblems(root),
    apple = fs.existsSync(path.join(root, appleModelsFile))
      ? appleModelProblems(fs.readFileSync(path.join(root, appleModelsFile), 'utf8'))
      : [appleModelsFile + ' is missing.'];
  // captureProblems already includes the evidence check's problems.
  return [...inventoryProblems(root), ...capture.problems, ...apple, ...embeddedInputProblems(root)];
}
/** Each artifact with its generator, check and the current SHA-256 of its outputs. */
export function provenanceListing(root = '.') {
  const evidence = evidenceProvenance(root);
  return {
    artifacts: generatedArtifacts.map(a => ({
      id: a.id,
      generator: a.generator,
      regenerate: a.regenerate,
      check: a.check.chain ?? 'node ' + a.check.argv.join(' ') + ' (' + a.check.test + ')',
      inputs: a.inputs,
      provenance: a.provenance,
      outputs: Object.fromEntries(
        a.outputs
          .flatMap(p => expand(root, p))
          .map(file => [
            file,
            fs.existsSync(path.join(root, file))
              ? 'sha256:' + textDigest(fs.readFileSync(path.join(root, file), 'utf8'))
              : null,
          ]),
      ),
    })),
    capture: {
      evidence_entries: evidence.evidence.entries,
      shipped: Object.keys(evidence.shipped).length,
      withheld: evidence.withheld,
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(a => a !== '--check')) throw Error('Usage: node tools/generated-provenance.mjs [--check]');
  if (args.includes('--check')) {
    const problems = provenanceProblems('.');
    for (const problem of problems) console.error(problem);
    if (problems.length) {
      console.error(problems.length + ' generated-artifact provenance problems.');
      process.exitCode = 1;
    } else
      console.log(
        'Generated-artifact provenance is current: ' +
          generatedArtifacts.length +
          ' artifacts declared, each with a gate; capture, Apple SDK evidence and embedded input digests verified.',
      );
  } else console.log(JSON.stringify(provenanceListing('.'), null, 2));
}
