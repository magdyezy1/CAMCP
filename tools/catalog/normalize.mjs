// Normalizes the captured catalog (.mirror/RAW) into .mirror/CATALOG/*.json, .mirror/TOOLS.json and the evidence list
// .mirror/REPORTS/evidence-hashes.json.
//
//   node tools/catalog/normalize.mjs           rewrite them from the complete capture (owner-only: the public tree
//                                              withholds part of it, .mirror/RAW/WITHHELD.json, and is refused)
//   node tools/catalog/normalize.mjs --check   re-derive them from the capture this tree ships and fail on any
//                                              difference, on a capture file missing from the evidence list, or when
//                                              the frozen catalog no longer has its recorded digest (ARC-03)
//
// The check re-derives everything except what only withheld files hold: the operation schemas of delegated gateways
// (their argumentsSchema in TOOLS.json and the records in CATALOG built from them). Those are covered by the frozen
// digest below and reported as withheld-derived. Neither mode contacts anything; --check writes nothing.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {unwrap, pageInfo, normalizeAction} from './core.mjs';
import {evidenceProvenance, withheldFile} from '../evidence-hashes.mjs';

/**
 * The captured catalog is frozen as the naming-compatibility denominator (owner decision D17): this is the digest of
 * every tracked file normalization writes, .mirror/TOOLS.json, .mirror/CATALOG/*.json and the evidence list. Change it
 * only together with an owner-approved re-capture, from the digest `--check` prints.
 */
export const capturedCatalogDigest = 'sha256:d02437ccb3b5eae97c9b5add9b65edfacfcdc9b4963d197e017ee64b48fef771';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const serialize = data => JSON.stringify(data, null, 2) + '\n';

/** The files normalization writes that the repository tracks, in digest order. */
export function capturedCatalogFiles(root = '.') {
  return [
    '.mirror/TOOLS.json',
    ...fs
      .readdirSync(path.join(root, '.mirror/CATALOG'))
      .filter(f => f.endsWith('.json'))
      .sort()
      .map(f => '.mirror/CATALOG/' + f),
    '.mirror/REPORTS/evidence-hashes.json',
  ];
}
/** SHA-256 over one "<path> <sha256 of its text, CRLF read as LF>\n" line per tracked normalization output. */
export function capturedCatalogFilesDigest(root = '.') {
  const lines = capturedCatalogFiles(root)
    .map(file => {
      const text = fs.readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n');
      return file + ' ' + sha256(Buffer.from(text, 'utf8')) + '\n';
    })
    .join('');
  return 'sha256:' + sha256(Buffer.from(lines, 'utf8'));
}

/**
 * Builds the catalogs, tools and evidence digests from the capture under `root`. `withheld(file)` decides what a
 * missing operation file means: undefined keeps the original behavior (a gap), otherwise it returns the committed
 * operation and catalog record derived from that withheld file, which are reused as given and counted.
 */
export function normalizeCapture(root = '.', {withheld} = {}) {
  const raw = root + '/.mirror/RAW';
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const discovery = unwrap(read(raw + '/help.json').response);
  const tools = [];
  const summaries = [];
  const catalogs = [];
  const hashes = {};
  const withheldDerived = [];
  const key = file => path.relative(root, file).replaceAll('\\', '/');
  function hash(file) {
    hashes[key(file)] = sha256(fs.readFileSync(file));
  }
  hash(raw + '/help.json');
  for (const gateway of discovery.gateways) {
    const dir = raw + '/' + gateway;
    const h = read(dir + '/help.json');
    const help = unwrap(h.response);
    for (const file of fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .sort())
      hash(path.join(dir, file));
    const pages = fs
      .readdirSync(dir)
      .filter(f => /^catalog-\d{4}\.json$/.test(f))
      .sort()
      .map(f => ({file: f, ...read(dir + '/' + f)}));
    const records = [];
    const operations = [];
    const gaps = [];
    let total = null;
    let apiVersion = null;
    if (pages.length) {
      const names = new Set();
      let expectedOffset = 0;
      for (const p of pages) {
        const info = pageInfo(p.response);
        apiVersion = info.data.api_version ?? apiVersion;
        if (total === null) total = info.total;
        if (total !== info.total) throw Error(gateway + ': changing denominator');
        const args = p.request.args;
        const offset = args.cursor ?? args.offset ?? 0;
        if (Number(offset) !== expectedOffset) throw Error(gateway + ': missing or out-of-order page');
        for (const raw of info.actions) {
          const item = normalizeAction(raw);
          if (names.has(item.name)) throw Error(gateway + ': duplicate ' + item.name);
          names.add(item.name);
          records.push(item);
        }
        expectedOffset += info.actions.length;
      }
      const last = pageInfo(pages.at(-1).response).data;
      if (
        records.length !== total ||
        last.has_more === true ||
        (last.next_cursor !== undefined && last.next_cursor !== null && last.next_cursor !== '')
      )
        throw Error(gateway + ': incomplete capture');
    } else if (help.mode === 'delegated') {
      total = help.operation_count;
      for (const operation of help.operations) {
        const file = dir + '/operation-' + operation + '.json';
        if (!fs.existsSync(file)) {
          const kept = withheld?.(key(file), gateway, operation);
          if (kept) {
            withheldDerived.push(key(file));
            operations.push(kept.operation);
            records.push(kept.record);
            continue;
          }
          gaps.push('Missing operation schema: ' + operation);
          continue;
        }
        const op = unwrap(read(file).response);
        if (!op.argumentsSchema) throw Error('No nested schema: ' + file);
        operations.push(op);
        records.push({
          name: operation,
          canonical_name: operation,
          aliases: [],
          method: null,
          path: null,
          read_only: null,
          destructive: null,
          required: op.argumentsSchema.required ?? [],
          path_parameters: [],
          evidence: 'OBSERVED',
          raw: op,
        });
      }
    } else if (help.inputSchema.properties?.action?.enum) {
      const names = help.inputSchema.properties.action.enum;
      const canonical = gateway === 'dv360_native_action' ? names.filter(x => x.startsWith('DV360_')) : names;
      total = canonical.length;
      for (const name of canonical)
        records.push({
          name,
          canonical_name: name,
          aliases: names.includes(name.replace(/^DV360_/, '')) ? [name.replace(/^DV360_/, '')] : [],
          method: null,
          path: null,
          read_only: null,
          destructive: null,
          required: [],
          path_parameters: [],
          evidence: 'OBSERVED',
          raw: {action: name},
        });
      gaps.push('Action enum captured; method/path/required-field catalog not exposed by AMCP help.');
    } else gaps.push('LIST_ACTIONS unsupported; full action denominator unknown.');
    const inputSchema = help.inputSchema ?? {
      type: 'object',
      properties: {
        operation: {type: 'string', enum: help.operations, description: 'Validated internal operation to execute.'},
        arguments: {
          type: 'object',
          additionalProperties: {},
          description:
            'Exact arguments for the selected operation. The original operation schema is validated before execution.',
        },
      },
      required: ['operation'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    };
    catalogs.push({
      gateway,
      mode: help.mode,
      api_version: apiVersion,
      reported_total: total,
      captured: records.length,
      denominator_kind: pages.length
        ? 'LIST_ACTIONS'
        : help.mode === 'delegated'
          ? 'operation_count'
          : total !== null
            ? 'action_enum'
            : 'unknown',
      complete: total !== null && total === records.length,
      actions: records,
      gaps,
    });
    tools.push({
      name: gateway,
      description: help.description,
      inputSchema,
      schema_evidence: help.inputSchema ? 'OBSERVED' : 'INFERRED_OUTER_ENVELOPE',
      mode: help.mode,
      operations,
      help,
    });
    summaries.push({
      gateway,
      mode: help.mode,
      actions: records.length,
      total,
      schemas: operations.length,
      gaps: gaps.length,
    });
  }
  const helpTool = {
    name: 'amcp_tool_help',
    description:
      'Discover compact AMCP MCP gateways and inspect the exact nested schema for an operation. This is read-only metadata and does not call an advertising platform.',
    inputSchema: {
      type: 'object',
      properties: {gateway: {type: 'string', enum: discovery.gateways}, operation: {type: 'string'}},
      additionalProperties: false,
    },
    schema_evidence: 'INFERRED_OUTER_ENVELOPE',
    mode: 'help',
    help: discovery,
  };
  tools.push(helpTool);
  return {
    catalogs,
    toolsFile: {surface: discovery.surface, tools, discovery},
    hashes,
    summaries,
    withheldDerived,
    captureSummary: {
      gateways: summaries,
      known_actions: summaries.reduce((n, g) => n + g.actions, 0),
      unknown_denominators: summaries.filter(g => g.total === null).map(g => g.gateway),
    },
  };
}

/**
 * Everything `--check` finds wrong with the tracked catalog against the shipped capture (an empty list passes).
 * `frozen` is the digest the tracked files must have (the recorded one; tests pass the digest of a synthetic capture).
 */
export function captureProblems(root = '.', {frozen = capturedCatalogDigest} = {}) {
  const problems = [],
    read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')),
    committedTools = read('.mirror/TOOLS.json'),
    evidence = evidenceProvenance(root),
    declared = new Set(
      fs.existsSync(path.join(root, withheldFile)) ? read(withheldFile).groups.flatMap(g => g.files ?? []) : [],
    );
  problems.push(...evidence.problems);
  const derived = normalizeCapture(root, {
    // A missing operation file is reused as committed only when the declaration names it withheld.
    withheld(file, gateway, operation) {
      if (!declared.has(file)) return undefined;
      const catalog = fs.existsSync(path.join(root, '.mirror/CATALOG/' + gateway + '.json'))
        ? read('.mirror/CATALOG/' + gateway + '.json')
        : undefined;
      const record = catalog?.actions.find(a => a.name === operation),
        kept = committedTools.tools.find(t => t.name === gateway)?.operations?.find(o => o.operation === operation);
      if (!record || !kept) {
        problems.push(
          file + ': withheld, and the committed catalog has no operation ' + gateway + '/' + operation + '.',
        );
        return undefined;
      }
      // The two copies of a withheld operation must at least agree with each other and with its documented derivation.
      if (
        JSON.stringify(record.raw) !== JSON.stringify(kept) ||
        JSON.stringify(record.required) !== JSON.stringify(kept.argumentsSchema?.required ?? [])
      )
        problems.push(
          gateway +
            '/' +
            operation +
            ': the catalog record and .mirror/TOOLS.json disagree about a withheld operation.',
        );
      return {operation: kept, record};
    },
  });
  for (const catalog of derived.catalogs) {
    const file = '.mirror/CATALOG/' + catalog.gateway + '.json';
    if (!fs.existsSync(path.join(root, file))) problems.push(file + ' is missing.');
    else if (fs.readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n') !== serialize(catalog))
      problems.push(file + ' differs from the catalog the shipped capture produces.');
  }
  const expectedCatalogs = new Set(derived.catalogs.map(c => c.gateway + '.json'));
  for (const file of fs.readdirSync(path.join(root, '.mirror/CATALOG')).filter(f => f.endsWith('.json')))
    if (!expectedCatalogs.has(file)) problems.push('.mirror/CATALOG/' + file + ' is not a captured gateway.');
  if (
    fs.readFileSync(path.join(root, '.mirror/TOOLS.json'), 'utf8').replaceAll('\r\n', '\n') !==
    serialize(derived.toolsFile)
  )
    problems.push('.mirror/TOOLS.json differs from the tools the shipped capture produces.');
  // Every capture file the tree ships is in the evidence list (the declaration of withheld files is not capture).
  const listed = new Set(Object.keys(read('.mirror/REPORTS/evidence-hashes.json')));
  for (const file of Object.keys(derived.hashes))
    if (!listed.has(file)) problems.push(file + ': a capture file the evidence list does not name.');
  for (const entry of fs.readdirSync(path.join(root, '.mirror/RAW'), {withFileTypes: true}))
    if (entry.isFile() && !['help.json', path.basename(withheldFile)].includes(entry.name))
      problems.push('.mirror/RAW/' + entry.name + ': a file outside the captured gateways.');
  const digest = capturedCatalogFilesDigest(root);
  if (digest !== frozen)
    problems.push(
      'The captured catalog is frozen (owner decision D17) but its files no longer have the recorded digest ' +
        frozen +
        ' (now ' +
        digest +
        '). Restore them, or after an owner-approved re-capture record the new digest in tools/catalog/normalize.mjs.',
    );
  return {problems, withheldDerived: derived.withheldDerived, digest, gateways: derived.catalogs.length};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(a => a !== '--check')) throw Error('Usage: node tools/catalog/normalize.mjs [--check]');
  if (args.includes('--check')) {
    const result = captureProblems('.');
    for (const problem of result.problems) console.error(problem);
    const summary = {
      gateways: result.gateways,
      rederived_from_shipped_capture: true,
      withheld_derived_operations: result.withheldDerived.length,
      digest: result.digest,
      problems: result.problems.length,
    };
    if (result.problems.length) {
      console.error(JSON.stringify(summary));
      process.exitCode = 1;
    } else console.log(JSON.stringify(summary));
  } else {
    // Normalizing a capture with withheld files would drop their operations and evidence digests from the tracked
    // catalog. Only the complete capture may be normalized.
    const evidence = JSON.parse(fs.readFileSync('.mirror/REPORTS/evidence-hashes.json', 'utf8')),
      missing = Object.keys(evidence).filter(file => !fs.existsSync(file));
    if (missing.length)
      throw Error(
        missing.length +
          ' capture files of the evidence list are not present (withheld, ' +
          withheldFile +
          '). Normalizing would drop them from the catalog and the evidence list; run --check instead.',
      );
    const root = '.mirror';
    const write = (file, data) => {
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, serialize(data));
    };
    const result = normalizeCapture('.');
    for (const catalog of result.catalogs) write(root + '/CATALOG/' + catalog.gateway + '.json', catalog);
    write(root + '/TOOLS.json', result.toolsFile);
    write(root + '/REPORTS/capture-summary.json', result.captureSummary);
    write(root + '/REPORTS/evidence-hashes.json', result.hashes);
    console.table(result.summaries);
  }
}
