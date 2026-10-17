import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {unwrap} from '../tools/catalog/core.mjs';
import {evidenceProvenance, withheldFile} from '../tools/evidence-hashes.mjs';
// Every file this generator reads, with the SHA-256 of its text (CRLF read as LF), for provenance format 2 (ARC-03).
const inputs = {};
const read = file => {
  const text = fs.readFileSync(file, 'utf8');
  inputs[file] = createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex');
  return JSON.parse(text);
};
const toolData = read('.mirror/TOOLS.json');
const catalogs = fs
  .readdirSync('.mirror/CATALOG')
  .filter(x => x.endsWith('.json'))
  .sort()
  .map(f => read('.mirror/CATALOG/' + f));
const descriptions = {};
for (const c of catalogs) {
  const dir = '.mirror/RAW/' + c.gateway;
  for (const file of fs
    .readdirSync(dir)
    .filter(f => f.startsWith('describe-'))
    .sort()) {
    const evidence = read(dir + '/' + file),
      raw = unwrap(evidence.response),
      d = raw.data ?? raw;
    if (raw.success === false) continue;
    const name = evidence.request?.args?.target_action ?? evidence.request?.args?.operation;
    if (name && name !== 'LIST_ACTIONS') descriptions[c.gateway + '/' + name] = d;
  }
}
const supplemental = [];
const vendorFile = '.mirror/VENDOR/dv360-v4.json';
if (fs.existsSync(vendorFile)) {
  const vendor = read(vendorFile);
  const doc = vendor.document;
  const snake = s => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
  const allowed = new Set(catalogs.find(c => c.gateway === 'dv360_native_action')?.actions.map(a => a.name));
  function visit(node, parts = []) {
    for (const [name, m] of Object.entries(node.methods ?? {})) {
      const action = 'DV360_' + [...parts, name].map(snake).join('_');
      if (!allowed.has(action)) continue;
      const raw = {
        action,
        method: m.httpMethod,
        path: '/' + m.path,
        resource: parts.join('.'),
        rpc: name,
        parameters: m.parameters ?? {},
        request: m.request ?? null,
        response: m.response ?? null,
        scopes: m.scopes ?? [],
        mediaUpload: m.mediaUpload ?? null,
        source: vendor.source,
      };
      supplemental.push({
        gateway: 'dv360_native_action',
        name: action,
        canonical_name: action,
        aliases: [action.replace(/^DV360_/, '')],
        method: m.httpMethod,
        path: '/' + m.path,
        read_only: ['GET', 'HEAD'].includes(m.httpMethod),
        destructive: m.httpMethod === 'DELETE',
        required: Object.entries(m.parameters ?? {})
          .filter(([, v]) => v.required)
          .map(([k]) => k),
        path_parameters: Object.entries(m.parameters ?? {})
          .filter(([, v]) => v.location === 'path')
          .map(([k]) => k),
        evidence: 'VENDOR_DOCUMENTED_NOT_AMCP_VERIFIED',
        raw,
      });
    }
    for (const [name, res] of Object.entries(node.resources ?? {})) visit(res, [...parts, name]);
  }
  visit(doc);
}
// Provenance format 2 (ARC-03): the evidence list splits into the capture files this tree ships, each verified against
// its digest, and the files it withholds, declared with a label, a count and the digest of the set. The registry is not
// generated while that check fails (`node tools/evidence-hashes.mjs --check` lists the problems).
const capture = evidenceProvenance('.');
if (capture.problems.length) {
  for (const problem of capture.problems) console.error(problem);
  throw Error('The capture evidence check failed; run node tools/evidence-hashes.mjs --check.');
}
for (const file of [capture.evidence.file, withheldFile]) read(file);
const sortedInputs = Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const data = {
  surface: toolData.surface,
  discovery: toolData.discovery,
  tools: toolData.tools,
  catalogs,
  descriptions,
  supplemental,
  provenance: {
    format_version: 2,
    generator: 'codegen/generate.mjs',
    generator_version: 2,
    check: 'npm run generate:check',
    meaning:
      'The tool names, input schemas, actions and routes of the captured catalog, frozen as the naming-compatibility denominator (owner decision D17), and the files they were generated from. capture.shipped lists the capture files this tree ships, each verified against its captured digest; capture.withheld counts the ones it does not ship, whose digests cannot be checked here.',
    normalization: 'Each input digest is the SHA-256 of the file text with CRLF line ends read as LF.',
    inputs: sortedInputs,
    capture: {
      evidence: {file: capture.evidence.file, entries: capture.evidence.entries},
      shipped: capture.shipped,
      withheld: {
        label: capture.withheld.label,
        count: capture.withheld.count,
        digest: capture.withheld.digest,
        declaration: withheldFile,
      },
    },
  },
};
const outputs = new Map();
outputs.set('generated/registry.json', JSON.stringify(data, null, 2) + '\n');
// generated/types.ts (TypeScript types of the captured schemas) was imported nowhere and is no longer generated
// (MCP-07); the AMCP tools' per-action contracts are src/first-party-contracts.ts.
const inputLines = Object.entries(sortedInputs)
  .map(([file, digest]) => file + ' ' + digest + '\n')
  .join('');
outputs.set(
  'generated/manifest.json',
  JSON.stringify(
    {
      generator: 'codegen/generate.mjs',
      generator_version: 2,
      gateways: catalogs.length,
      tools: toolData.tools.length,
      catalog_actions: catalogs.reduce((n, c) => n + c.actions.length, 0),
      supplemental_routes: supplemental.length,
      // The same "<path> <sha256>\n" digest over the registry's provenance.inputs, sorted by path.
      inputs: Object.keys(sortedInputs).length,
      inputs_digest: 'sha256:' + createHash('sha256').update(inputLines).digest('hex'),
      capture_shipped: Object.keys(capture.shipped).length,
      capture_withheld: capture.withheld.count,
      capture_withheld_digest: capture.withheld.digest,
      registry_sha256: createHash('sha256').update(outputs.get('generated/registry.json')).digest('hex'),
    },
    null,
    2,
  ) + '\n',
);
const check = process.argv.includes('--check');
let changed = false;
for (const [file, content] of outputs) {
  if (check) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) {
      console.error('Generated output is stale: ' + file + '. Run npm run generate and commit it.');
      changed = true;
    }
  } else {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, content);
  }
}
if (changed) process.exitCode = 1;
else
  console.log(
    (check ? 'Generated outputs are current: ' : 'Generated ') +
      catalogs.length +
      ' gateways, ' +
      toolData.tools.length +
      ' tools, ' +
      catalogs.reduce((n, c) => n + c.actions.length, 0) +
      ' catalog entries and ' +
      supplemental.length +
      ' vendor-backed DV360 routes; ' +
      Object.keys(capture.shipped).length +
      ' capture files shipped and verified, ' +
      capture.withheld.count +
      ' withheld (' +
      capture.withheld.label +
      ').',
  );
