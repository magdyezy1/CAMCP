import fs from 'node:fs';
import {Registry} from '../src/catalog.js';
import {actionContracts, actionContractSummary} from '../src/action-contracts.js';
import {vendorContractInventory} from './vendor-contract-inventory.js';
import {withContractsGuide} from '../src/first-party-contracts.js';
import {workspaceTool} from '../src/workspace.js';
import {campaignTool} from '../src/campaign-runner.js';
import {decisionTool} from '../src/decision-reporting.js';
import {overviewTool} from '../src/reporting-overview.js';
import {mediaTool} from '../src/media-upload.js';
import {writeTool} from '../src/write-review.js';
import {previewTool} from '../src/ad-previews.js';
const registry = new Registry(),
  rows = actionContracts(registry),
  summary = actionContractSummary(registry);
const artifact = {
  format_version: 1,
  scope:
    'All local catalog actions, supplemental mappings, independent extensions and delegated action enums. No claim of complete provider APIs or live execution.',
  classification: 'Shared with the execution route gate; exact-payload validation remains mandatory.',
  summary,
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
  'implementation',
  'reason',
  'source',
  'tests',
  'live_qualification',
];
// Match .gitattributes so a clean checkout passes the same exact-content check on every OS.
const csv =
  [
    columns.join(','),
    ...rows.map(r =>
      columns
        .map(
          k =>
            '"' +
            String(Array.isArray((r as any)[k]) ? (r as any)[k].join(';') : ((r as any)[k] ?? '')).replaceAll(
              '"',
              '""',
            ) +
            '"',
        )
        .join(','),
    ),
  ].join('\n') + '\n';
const vendor = vendorContractInventory(rows);
// The AMCP tools' action reference in the workspace guide, generated from their per-action contracts (MCP-07).
const guide = 'Skills/amcp-campaign-builder/references/workspace.md';
const outputs = {
  'docs/implementation/ACTION-CONTRACT-COVERAGE.json': json,
  'docs/implementation/ACTION-CONTRACT-COVERAGE.csv': csv,
  'docs/implementation/VENDOR-METHOD-COVERAGE.json': JSON.stringify(vendor, null, 2) + '\n',
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
  } else fs.writeFileSync(path, content);
}
console.log(JSON.stringify({actions: rows.length, pinned_vendor_methods: vendor.methods.length, summary}));
