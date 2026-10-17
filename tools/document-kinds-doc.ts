// Writes docs/DOCUMENT-KINDS.md, the reference of every stored document kind and its retention, from the document-kind
// registry (src/document-kinds.ts, ARC-02; owner decisions P3 and P11 of 2026-10-11). tests/document-registry.test.mjs
// fails when the committed file differs from what the registry generates.
// Usage: npm run build && node dist/tools/document-kinds-doc.js [--check]
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  documentKinds,
  maintenanceSweeps,
  reportRetentionDocumentKinds,
  reportRetentionJobKinds,
  servicePartitions,
  type DocumentKind,
  type Retention,
} from '../src/document-kinds.js';

export const documentKindsFile = 'docs/DOCUMENT-KINDS.md';
const code = (value: string) => '`' + value + '`';
const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll('\n', ' ');
const ruleNames: Record<Retention['rule'], string> = {
  report: 'Report retention',
  with_parent: 'With its parent',
  expires: 'Expires',
  period: 'Fixed period',
  owner_opt_in: 'Owner opt-in',
  replaced: 'Rewritten in place',
  workspace: 'While the workspace exists',
  deployment: 'With the deployment',
};
const ruleMeaning: Record<Retention['rule'], string> = {
  report:
    "Deleted hourly once older than the workspace owner's report retention period (Settings, 7–365 days) or, without one, `AMCP_REPORT_RETENTION_DAYS` (365 days; `off` keeps them).",
  with_parent: 'Deleted with the document it belongs to.',
  expires: 'Ignored past its deadline and deleted by the sweep or module named.',
  period: 'Deleted a fixed number of days after its clock field.',
  owner_opt_in: 'Deleted only after a period the workspace owner opts in to; kept otherwise.',
  replaced: 'One small document per key, rewritten in place: it does not grow.',
  workspace: 'Kept while the workspace exists; deleted when its account and workspace are erased.',
  deployment: 'Kept with the deployment: needed to re-apply erasures to a restored copy or to recognise the volume.',
};
const byWhom: Record<string, string> = {
  maintenance: 'the maintenance timer, once a minute',
  media_cleanup: 'the media cleanup timer',
  owner_module: 'its owner module when it saves the next one',
  read: 'nothing: it is ignored once expired',
  report_cleanup: 'the hourly report cleanup',
  schema_trigger: 'a schema trigger, in the same statement',
  parent_delete: 'its parent’s deletion',
};
function retentionDetail(kind: DocumentKind): string {
  const r = kind.retention;
  switch (r.rule) {
    case 'report':
      return 'from ' + r.from.map(f => code(f.replace(/^\$\./, ''))).join(' or ') + ', order ' + r.order;
    case 'with_parent':
      return 'parent ' + code(r.parent) + ', by ' + byWhom[r.by];
    case 'expires':
      return (
        code(r.field) +
        (r.strict ? ' passed' : ' reached') +
        (r.missing === 'expired' ? ' (none counts as expired)' : '') +
        (r.unless ? ', unless ' + code(r.unless) + ' is set' : '') +
        ', by ' +
        byWhom[r.by]
      );
    case 'period':
      return (
        r.days +
        (r.days === 1 ? ' day' : ' days') +
        ' after ' +
        code(r.from.replace(/^\$\./, '')) +
        ', by ' +
        byWhom[r.by]
      );
    case 'owner_opt_in':
      return 'setting ' + code(r.setting);
    default:
      return '';
  }
}
function bindings(kind: DocumentKind): string {
  const out: string[] = [];
  const fields = Object.entries(kind.fields).map(
    ([f, t]) => code(f.replace(/\?$/, '')) + ' ' + t + (f.endsWith('?') ? '?' : ''),
  );
  if (fields.length) out.push('Store contract: ' + fields.join(', '));
  if (kind.person)
    out.push(
      'Erased with the person (' +
        (kind.person.match === 'id' ? 'document id' : code(kind.person.field!.replace(/^\$\./, ''))) +
        ')',
    );
  if (kind.connection)
    out.push(
      'Deleted with its login (' +
        (kind.connection.match === 'id'
          ? 'document id'
          : kind.connection.match === 'sources'
            ? 'rows or sources'
            : code(kind.connection.field!)) +
        ')',
    );
  if (kind.backup) out.push(kind.backup === 'excluded' ? 'Left out of backups' : 'Website uploads left out of backups');
  if (kind.indexes?.length) out.push('Indexes: ' + kind.indexes.map(code).join(', '));
  return out.join('; ');
}
/** The retention column: the rule, its detail, and the kind's own summary unless it only repeats the rule. */
const retentionCell = (k: DocumentKind) =>
  '**' +
  ruleNames[k.retention.rule] +
  '**' +
  (retentionDetail(k) ? ' (' + cell(retentionDetail(k)) + ')' : '') +
  (k.retention.summary === 'Kept while the workspace exists.' ? '.' : '. ' + cell(k.retention.summary));
/** The generated reference. */
export function documentKindsMarkdown(): string {
  const kinds = documentKinds(),
    tenant = kinds.filter(k => k.scope === 'tenant'),
    service = kinds.filter(k => k.scope === 'service');
  const lines: string[] = [
    '# Document kinds and retention',
    '',
    'Generated from the document-kind registry, `src/document-kinds.ts` (ARC-02), by',
    '`npm run build && node dist/tools/document-kinds-doc.js`. Do not edit it by hand: change the registry and generate',
    'it again; `tests/document-registry.test.mjs` fails when the two differ. How to add or change a kind:',
    '[Adding a document kind](ADDING-A-DOCUMENT-KIND.md).',
    '',
    'AMCP keeps most of its records as JSON documents in one SQLite table, `documents`, keyed by workspace, kind and id.',
    'The registry declares every kind once: the module that owns its shape, whether it belongs to a workspace or to the',
    'service, the payload version this release writes, the fields the store layer reads (its store contract) and how',
    'long its documents are kept. Code reads and writes a kind through a repository bound to one workspace',
    '(`store.repo(kind, workspace)`) or, for a service record, to its reserved partition (`store.serviceRepo(kind)`), so',
    'one workspace can never read, change or delete another workspace’s documents through it.',
    '',
    `${kinds.length} kinds are declared: ${tenant.length} belong to a workspace and ${service.length} to the service.`,
    '',
    '## Retention',
    '',
    'Retention is designed to the GDPR and the KSA PDPL (owner decision P3, 2026-10-11) and set per document kind',
    '(owner decision P11). Whatever its kind, every document of a workspace is deleted when the account and its workspace',
    'are erased: by the person (Account → Delete your account), by the operator (`admin erase-account`) or by the',
    'retention sweep (sign-ups never approved after 30 days, accounts revoked 90 days after revocation). Copies that',
    'application retention cannot reach (the write-ahead log until its next checkpoint, volume snapshots and older',
    'encrypted backups) expire on their own schedule; see docs/OPERATIONS.md, "Account erasure and retention".',
    '',
    '| Rule | Kinds | Meaning |',
    '|---|---:|---|',
    ...(Object.keys(ruleNames) as Retention['rule'][]).map(
      rule =>
        `| ${ruleNames[rule]} | ${kinds.filter(k => k.retention.rule === rule).length} | ${cell(ruleMeaning[rule])} |`,
    ),
    '',
    '### The hourly report cleanup',
    '',
    'Per workspace, in this order, so that a snapshot deleted in a pass takes its presentation and files along:',
    '',
    ...reportRetentionDocumentKinds().map((name, i) => {
      const kind = kinds.find(k => k.name === name)!;
      return `${i + 1}. ${code(name)}: ${cell(kind.retention.summary)}`;
    }),
    `${reportRetentionDocumentKinds().length + 1}. Finished jobs of kinds ${reportRetentionJobKinds.map(code).join(', ')}, from their last update, unless a Google Sheets delivery of their snapshot is unconfirmed.`,
    '',
    'The same pass deletes provider job receipts after 90 days, spend reservations older than two days and, when the owner',
    'opted in, archived campaign plans. Each pass that deleted something appends `report_retention_applied` to the',
    "workspace's audit, with counts per kind.",
    '',
    '### The maintenance timer',
    '',
    ...maintenanceSweeps().map(
      s => '- ' + s.kinds.map(code).join(', ') + ': ' + cell(kinds.find(k => k.name === s.kinds[0])!.retention.summary),
    ),
    '',
    '### What follows a person, a login or a backup',
    '',
    '- **Account erasure** also deletes, in other workspaces, the documents that belong to the erased person: ' +
      kinds
        .filter(k => k.person)
        .map(k => code(k.name))
        .join(', ') +
      '.',
    '- **A local disconnect** deletes the documents read through the login: ' +
      kinds
        .filter(k => k.connection)
        .map(k => code(k.name))
        .join(', ') +
      '.',
    '- **Encrypted backups** leave out: ' +
      kinds
        .filter(k => k.backup)
        .map(k => code(k.name) + (k.backup === 'excluded_upload_origin' ? ' (website uploads)' : ''))
        .join(', ') +
      '.',
    '',
    '## Workspace kinds',
    '',
    '| Kind | What it holds | Retention | Owner module | Version | Store contract and bindings |',
    '|---|---|---|---|---:|---|',
    ...tenant.map(
      k =>
        `| ${code(k.name)} | ${cell(k.summary)} | ${retentionCell(k)} | ${code(k.owner)} | ${k.version} | ${cell(bindings(k))} |`,
    ),
    '',
    '## Service kinds',
    '',
    'Service records are stored under a reserved workspace id that is never a real workspace (the store refuses it as',
    'one): ' +
      Object.entries(servicePartitions)
        .map(([name, id]) => code(name) + ' is ' + code(id))
        .join(', ') +
      '.',
    '',
    '| Kind | Partition | What it holds | Retention | Owner module | Version | Store contract |',
    '|---|---|---|---|---|---:|---|',
    ...service.map(
      k =>
        `| ${code(k.name)} | ${code(k.partition!)} | ${cell(k.summary)} | ${retentionCell(k)} | ${code(k.owner)} | ${k.version} | ${cell(bindings(k))} |`,
    ),
    '',
  ];
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const content = documentKindsMarkdown();
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(documentKindsFile) || fs.readFileSync(documentKindsFile, 'utf8') !== content)
      throw Error(documentKindsFile + ' is stale: run npm run build && node dist/tools/document-kinds-doc.js');
  } else fs.writeFileSync(documentKindsFile, content);
  console.log(JSON.stringify({document_kinds: documentKinds().length, file: documentKindsFile}));
}
