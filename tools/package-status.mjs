// Package status on three axes (DOC-02, owner decision D25 in docs/DECISIONS.md): source acceptance against the
// package's blueprint property, native/live acceptance and manual/deployed acceptance. Each axis is counted on its own
// and never collapsed into one "done" figure; a documented blocker never completes an axis.
// docs/review/package-status.json is the data. `npm run docs:index` (tools/docs-index.mjs) writes the generated table
// docs/review/PACKAGE-STATUS.md from it, and `npm run docs:index:check` fails when the data is invalid or the table is
// stale. Usage on its own: node tools/package-status.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const statusFile = 'docs/review/package-status.json',
  tableFile = 'docs/review/PACKAGE-STATUS.md';
export const nativeStates = ['none', 'read_verified', 'write_verified'];
export const manualStates = ['not_recorded', 'pending_owner', 'accepted', 'amended'];
export const dispositions = [
  'register_item',
  'finite_package',
  'conditional_stretch',
  'optional_stretch',
  'declared_limit',
  'owner_action',
  'native_acceptance',
  'parked',
];
/** Register items (MCP-01), packages (B01), owner decisions (D1), resources (R1) and product decisions (P1). */
const reference = /^(?:[A-Z]{2,4}-\d{2}|B\d{2}|D\d{1,2}|R\d|P\d{1,2})$/;
const blueprintIds = Array.from({length: 28}, (_, i) => 'B' + String(i + 1).padStart(2, '0'));
const text = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 600 && !/[\r\n|]/.test(v);

/** Every problem with the status data; an empty list means it is valid. Test files are checked under `root`. */
export function validatePackageStatus(data, root = process.cwd()) {
  const problems = [],
    at = (id, message) => problems.push(id + ': ' + message);
  if (!data || typeof data !== 'object' || data.schema_version !== 1) return ['schema_version must be 1'];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data.as_of))) problems.push('as_of must be a YYYY-MM-DD date');
  const packages = Array.isArray(data.packages) ? data.packages : [],
    finite = Array.isArray(data.finite_packages) ? data.finite_packages : [];
  const ids = packages.map(p => p?.id);
  if (JSON.stringify(ids) !== JSON.stringify(blueprintIds))
    problems.push('packages must list B01 to B28 once each, in order');
  const finiteIds = new Set();
  for (const f of finite) {
    if (!/^B(?:29|[3-9]\d)$/.test(String(f?.id)) || finiteIds.has(f.id))
      at(String(f?.id), 'a finite package is B29 or later, once');
    finiteIds.add(f?.id);
    for (const key of ['title', 'acceptance']) if (!text(f?.[key])) at(String(f?.id), key + ' is required');
    if (!blueprintIds.includes(f?.origin))
      at(String(f?.id), 'origin names the blueprint package it was extracted from');
    if (!reference.test(String(f?.ref))) at(String(f?.id), 'ref names a register item or decision');
  }
  const referencedFinite = new Set();
  for (const p of packages) {
    const id = String(p?.id);
    for (const key of ['title', 'blueprint_acceptance']) if (!text(p?.[key])) at(id, key + ' is required');
    const source = p?.source ?? {};
    if (typeof source.met !== 'boolean') at(id, 'source.met is true or false');
    const tests = Array.isArray(source.tests) ? source.tests : [];
    if (source.met === true) {
      if (!tests.length) at(id, 'source-met cites at least one test file');
      if (!/^[0-9a-f]{7,40}$/.test(String(source.commit))) at(id, 'source-met cites the commit it was assessed at');
    }
    if (source.met === false && !text(source.gap)) at(id, 'source not met names the gap');
    for (const file of tests)
      if (!/^tests\/[\w.-]+\.test\.(?:ts|mjs)$/.test(String(file)) || !fs.existsSync(path.join(root, String(file))))
        at(id, 'test file ' + file + ' does not exist');
    if (new Set(tests).size !== tests.length) at(id, 'a test file is cited twice');
    for (const [axis, states] of [
      ['native', nativeStates],
      ['manual', manualStates],
    ]) {
      const value = p?.[axis] ?? {},
        evidence = Array.isArray(value.evidence) ? value.evidence : null;
      if (!states.includes(value.state)) at(id, axis + '.state is one of ' + states.join(', '));
      if (!evidence || evidence.some(e => !text(e))) at(id, axis + '.evidence is a list of references');
      else if (!['none', 'not_recorded', 'pending_owner'].includes(value.state) && !evidence.length)
        at(id, axis + ' ' + value.state + ' cites its evidence');
    }
    const remainders = Array.isArray(p?.remainders) ? p.remainders : [];
    if (source.met === false && !remainders.length) at(id, 'an unmet package names its finite remainders');
    for (const r of remainders) {
      if (!text(r?.text)) at(id, 'a remainder has text');
      if (!dispositions.includes(r?.disposition))
        at(id, 'a remainder disposition is one of ' + dispositions.join(', '));
      if (!reference.test(String(r?.ref)))
        at(id, 'remainder reference ' + r?.ref + ' is not a register item or decision');
      if (['finite_package', 'conditional_stretch'].includes(r?.disposition)) {
        if (!finiteIds.has(r.ref)) at(id, r.ref + ' is not a listed finite package');
        referencedFinite.add(r.ref);
      }
    }
    for (const l of Array.isArray(p?.declared_limits) ? p.declared_limits : [])
      if (!text(l?.text) || !reference.test(String(l?.ref))) at(id, 'a declared limit has text and a reference');
  }
  for (const f of finiteIds) if (!referencedFinite.has(f)) at(f, 'no package remainder points to this finite package');
  return problems;
}

const count = (packages, pick, values) =>
  values.map(v => v + ' ' + packages.filter(p => pick(p) === v).length).join(' · ');
const cell = v => String(v).replace(/\|/g, '\\|');

/** The generated table: byte-identical for the same data. */
export function renderPackageStatus(data) {
  const packages = data.packages;
  const lines = [
    // DOC-03: a generated current page for operators (tools/docs-front-matter.mjs).
    '---',
    'status: current',
    'tier: operator',
    'generated: tools/package-status.mjs',
    '---',
    '',
    '# Package status on three axes',
    '',
    'Generated by `npm run docs:index` from [package-status.json](package-status.json); do not edit by hand.',
    'Owner decision D25 ([decisions](../DECISIONS.md)): each package reports source acceptance against its',
    'blueprint property, native/live acceptance and manual/deployed acceptance, counted separately. A documented',
    'blocker never completes an axis, and the axes are never added into one "done" figure.',
    '',
    'Status as of ' + data.as_of + '. ' + data.basis,
    '',
    '## Counts per axis',
    '',
    '| Axis | Count |',
    '|---|---|',
    '| Source acceptance (of ' +
      packages.length +
      ') | ' +
      count(packages, p => (p.source.met ? 'met' : 'not met'), ['met', 'not met']) +
      ' |',
    '| Native/live acceptance | ' + count(packages, p => p.native.state, nativeStates) + ' |',
    '| Manual/deployed acceptance | ' + count(packages, p => p.manual.state, manualStates) + ' |',
    '',
    '## Packages',
    '',
    '| ID | Deliverable | Source | Native | Manual | Finite remainders |',
    '|---|---|---|---|---|---|',
  ];
  for (const p of packages)
    lines.push(
      '| ' +
        [
          p.id,
          cell(p.title),
          p.source.met
            ? 'met (' + p.source.tests.length + ' test files, ' + p.source.commit + ')'
            : 'not met: ' + cell(p.source.gap),
          p.native.state + (p.native.evidence.length ? ' (' + p.native.evidence.map(cell).join('; ') + ')' : ''),
          p.manual.state + (p.manual.evidence.length ? ' (' + p.manual.evidence.map(cell).join('; ') + ')' : ''),
          p.remainders.map(r => cell(r.text) + ' → ' + r.disposition + ' ' + r.ref).join('<br>') || 'none',
        ].join(' | ') +
        ' |',
    );
  lines.push(
    '',
    '## New finite packages',
    '',
    '| ID | Title | From | Reference | Acceptance |',
    '|---|---|---|---|---|',
  );
  for (const f of data.finite_packages)
    lines.push('| ' + [f.id, cell(f.title), f.origin, f.ref, cell(f.acceptance)].join(' | ') + ' |');
  const limits = packages.flatMap(p => (p.declared_limits ?? []).map(l => ({...l, id: p.id})));
  lines.push('', '## Declared provider limits', '');
  if (limits.length) {
    lines.push('| Package | Limit | Reference |', '|---|---|---|');
    for (const l of limits) lines.push('| ' + [l.id, cell(l.text), l.ref].join(' | ') + ' |');
  } else lines.push('None recorded.');
  // The open-remainder view, keyed by canonical ID: every remainder that still points at work.
  const open = new Map();
  for (const p of packages)
    for (const r of p.remainders) open.set(r.ref, [...(open.get(r.ref) ?? []), p.id + ' (' + r.disposition + ')']);
  lines.push('', '## Open remainders by canonical ID', '', '| ID | Packages |', '|---|---|');
  for (const ref of [...open.keys()].sort()) lines.push('| ' + ref + ' | ' + open.get(ref).join(', ') + ' |');
  lines.push('', 'Per-package test files:', '');
  for (const p of packages)
    lines.push('- ' + p.id + ': ' + (p.source.tests.map(t => '`' + t + '`').join(', ') || 'none cited'));
  return lines.join('\n') + '\n';
}

/** Validates the committed data and returns the table it generates. */
export function packageStatusTable(root) {
  const data = JSON.parse(fs.readFileSync(path.join(root, statusFile), 'utf8')),
    problems = validatePackageStatus(data, root);
  return {problems, table: problems.length ? undefined : renderPackageStatus(data)};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL('..', import.meta.url)),
    {problems, table} = packageStatusTable(root),
    target = path.join(root, tableFile);
  if (problems.length) {
    console.error('Package status: ' + problems.join('; '));
    process.exit(1);
  }
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== table) {
      console.error(tableFile + ' is out of date. Run npm run docs:index.');
      process.exit(1);
    }
  } else fs.writeFileSync(target, table);
  console.log('Package status: 28 packages on three axes.');
}
