import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Registry} from '../src/catalog.js';
import {actionContracts, actionContractSummary, type ActionContract} from '../src/action-contracts.js';
import {acceptanceLayers} from '../src/acceptance-ledger.js';
import {vendorContractInventory} from './vendor-contract-inventory.js';
import {routeAnchors, routeAnchorDocumentsFile, routeAnchorReportFile, serializeRouteAnchors} from './route-anchors.js';
import {routeAnchorKey, routeAnchorMeaning, routeAnchorsFile} from '../src/route-anchors.js';
import {withContractsGuide} from '../src/first-party-contracts.js';
import {workspaceTool} from '../src/workspace.js';
import {campaignTool} from '../src/campaign-runner.js';
import {decisionTool} from '../src/decision-reporting.js';
import {overviewTool} from '../src/reporting-overview.js';
import {mediaTool} from '../src/media-upload.js';
import {writeTool} from '../src/write-review.js';
import {previewTool} from '../src/ad-previews.js';
// The ledger reads the anchors last recorded in the checkout this tool was built in (src/route-anchors.ts, a required
// read), and every row below takes the anchor computed now instead. A first generation therefore starts from an empty
// file; the check never writes and reports a missing one as stale.
const recordedAnchors = fileURLToPath(new URL('../../' + routeAnchorsFile, import.meta.url));
if (!fs.existsSync(recordedAnchors)) {
  if (process.argv.includes('--check'))
    throw Error('Action contract ledger is stale: ' + routeAnchorsFile + ' is missing');
  fs.writeFileSync(recordedAnchors, JSON.stringify({format_version: 1, sources: {}, routes: {}}) + '\n');
}
const registry = new Registry(),
  classified = actionContracts(registry),
  summary = actionContractSummary(registry),
  vendor = vendorContractInventory(classified),
  anchors = routeAnchors(registry, classified, vendor);
// Every row carries the anchor computed now (ARC-03), not the one generated/route-anchors.json last recorded.
const rows: ActionContract[] = classified.map(row => {
  const {anchor_status: _status, anchor: _anchor, ...rest} = row,
    fresh = anchors.artifact.routes[routeAnchorKey(row)];
  return fresh
    ? {...rest, anchor_status: fresh.anchor_status, ...(fresh.anchor ? {anchor: fresh.anchor} : {})}
    : {...rest, anchor_status: row.method && row.path ? 'not_recorded' : 'no_route'};
});
// The data inputs this ledger is generated from, with their digests; the classification code itself is rerun by the
// check (`npm run contracts:actions:check`). Read from the checkout this tool was built in.
const textDigest = (file: string) =>
  createHash('sha256')
    .update(fs.readFileSync(fileURLToPath(new URL('../../' + file, import.meta.url)), 'utf8').replaceAll('\r\n', '\n'))
    .digest('hex');
const provenance = {
  generator: 'tools/action-contracts.ts',
  regenerate: 'npm run contracts:actions',
  check: 'npm run contracts:actions:check',
  inputs: Object.fromEntries(
    [
      'generated/apple-platform-v1-models.json',
      'generated/microsoft-summary.json',
      'generated/registry.json',
      'generated/vendor-routes.json',
      'src/acceptance-ledger.json',
      'src/google-legacy-mapping.json',
      routeAnchorDocumentsFile,
    ].map(file => [file, textDigest(file)]),
  ),
  vendor_documents: 'The SHA-256 of every pinned vendor document is in VENDOR-METHOD-COVERAGE.json summary.',
  code: 'The built classification modules under dist/src; the check reruns them, so a code change also makes it stale.',
};
const artifact = {
  format_version: 1,
  scope:
    'All local catalog actions, supplemental mappings, independent extensions and delegated action enums. No claim of complete provider APIs or live execution.',
  classification: 'Shared with the execution route gate; exact-payload validation remains mandatory.',
  provenance,
  summary,
  // Counts per evidence layer, from the provider acceptance ledger for the accepted layers (ACC-05).
  acceptance_layers: acceptanceLayers(rows),
  // What anchor_status and anchor mean (ARC-03); the per-gateway coverage is in ROUTE-ANCHOR-COVERAGE.md.
  anchor_meaning: routeAnchorMeaning,
  actions: rows,
};
const json = JSON.stringify(artifact, null, 2) + '\n';
const columns = [
  'gateway',
  'operation',
  'action',
  'aliases',
  'method',
  'origin',
  'path',
  'status',
  'family',
  // The family that alone claims the deleting bodies of a route another family owns (the three Smart+ status routes).
  'deletion_family',
  'implementation',
  'reason',
  'source',
  'tests',
  'live_qualification',
  // The provider acceptance ledger's status for the current contract (ACC-05): unverified, read_accepted,
  // write_accepted, refused or stale.
  'acceptance',
  // What the method and path rest on (ARC-03) and the document, SDK request, page or capture file that says so.
  'anchor_status',
  'anchor',
];
const anchorCell = (anchor: ActionContract['anchor']) =>
  !anchor
    ? ''
    : anchor.source
      ? [anchor.source, anchor.method, anchor.checked_at].filter(Boolean).join(' ')
      : [anchor.capture, anchor.reason].filter(Boolean).join(' ');
const cell = (r: any, k: string) =>
  k === 'acceptance'
    ? (r.acceptance?.status ?? 'unverified')
    : k === 'anchor'
      ? anchorCell(r.anchor)
      : Array.isArray(r[k])
        ? r[k].join(';')
        : (r[k] ?? '');
// Match .gitattributes so a clean checkout passes the same exact-content check on every OS.
const csv =
  [
    columns.join(','),
    ...rows.map(r => columns.map(k => '"' + String(cell(r, k)).replaceAll('"', '""') + '"').join(',')),
  ].join('\n') + '\n';
// The AMCP tools' action reference in the workspace guide, generated from their per-action contracts (MCP-07).
const guide = 'Skills/amcp-campaign-builder/references/workspace.md';
const outputs = {
  'docs/implementation/ACTION-CONTRACT-COVERAGE.json': json,
  'docs/implementation/ACTION-CONTRACT-COVERAGE.csv': csv,
  'docs/implementation/VENDOR-METHOD-COVERAGE.json': JSON.stringify(vendor, null, 2) + '\n',
  [routeAnchorsFile]: serializeRouteAnchors(anchors.artifact),
  [routeAnchorReportFile]: anchors.report,
  [guide]: withContractsGuide(fs.readFileSync(guide, 'utf8'), [
    workspaceTool,
    campaignTool,
    decisionTool,
    overviewTool,
    mediaTool,
    writeTool,
    previewTool,
  ]),
};
for (const [path, content] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(path) || fs.readFileSync(path, 'utf8') !== content)
      throw Error('Action contract ledger is stale: ' + path);
  } else {
    fs.mkdirSync(path.split('/').slice(0, -1).join('/'), {recursive: true});
    fs.writeFileSync(path, content);
  }
}
console.log(
  JSON.stringify({
    actions: rows.length,
    pinned_vendor_methods: vendor.methods.length,
    anchored_executable: anchors.artifact.summary.reduce((n, s) => n + s.anchored_executable, 0),
    executable: anchors.artifact.summary.reduce((n, s) => n + s.executable, 0),
    summary,
  }),
);
