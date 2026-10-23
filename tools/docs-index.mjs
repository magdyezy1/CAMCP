// Writes docs/README.md, the map of AMCP's documentation (F-68, DOC-03), from the documents themselves: each is listed
// with its own title. The map has three tiers, one per reader (owner decision P12: the primary audience is workspace
// owners at agencies and in-house teams): the owner guide, then operating and deploying AMCP, then changing it. The
// owner guide (in its reading order, each English page beside its Arabic translation), the acceptance runbooks, the
// implementation records, the delivery records (docs/records/) and the archive (docs/archive/) are listed from their
// folders. Every other guide or reference must be placed in a section below, so a new one cannot go unlisted. A moved
// document's old address holds a redirect stub (docs/moved.json, tools/docs-links.mjs), which is never listed; this
// writes the stubs, and fails on any broken relative link in the repository's Markdown and on a current page that
// breaks the documentation freeze (tools/docs-lint.mjs).
// Usage: node tools/docs-index.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {linkProblems, markdownLinks, readMoves, writeStubs} from './docs-links.mjs';
import {lintProblems} from './docs-lint.mjs';
import {packageStatusTable, tableFile} from './package-status.mjs';

const docs = fileURLToPath(new URL('../docs/', import.meta.url)),
  target = path.join(docs, 'README.md');
// The guides and references placed by hand, tier by tier: the operators' sections first, then the engineers'.
const sections = [
  ['Status and decisions', ['CURRENT-READINESS.md', 'DECISIONS.md', 'review/PACKAGE-STATUS.md', 'PROVIDER-ACCESS.md']],
  [
    'Operate and deploy',
    [
      'DEPLOY-RAILWAY.md',
      'OPERATIONS.md',
      'USER-ACCOUNTS.md',
      'TEST-ACCOUNTS.md',
      'OAUTH-HARDENING.md',
      'GOOGLE-VERIFICATION.md',
      'SANDBOX-VERIFICATION.md',
      'LOCAL-BROWSER-QA.md',
      'review/MCP-EVALUATION-RECORD-TEMPLATE.md',
    ],
  ],
  [
    'Workflow guides',
    [
      'WRITE-OPERATIONS.md',
      'MEDIA-UPLOADS.md',
      'AD-PREVIEWS.md',
      'REPORTING-OVERVIEW.md',
      'WORKSPACE-OPERATIONS.md',
      'PRODUCT-WORKFLOWS.md',
    ],
  ],
  ['Platform guides', ['MEASUREMENT-AND-APPLE.md', 'MICROSOFT-ADS.md', 'REDDIT.md']],
  [
    'Engineering',
    [
      'review/ARCHITECTURE.md',
      'CONTRACTS.md',
      'ADDING-A-REVIEWED-FAMILY.md',
      'ADDING-A-DOCUMENT-KIND.md',
      'DOCUMENT-KINDS.md',
      'AMCP-IDENTITY.md',
      'review/THREAT-MODEL.md',
      'review/PERSONAL-DATA-POLICY.md',
      'review/MCP-SECURITY-CALIBRATION.md',
      'review/ACCESSIBILITY.md',
    ],
  ],
  [
    'Reviews and plans',
    [
      'review/FINDINGS.md',
      'review/COVERAGE.md',
      'review/ROADMAP.md',
      'review/PRODUCT-BLUEPRINT-2026-10-01.md',
      'review/IMPLEMENTATION-2026-10-01.md',
    ],
  ],
];
// The folders listed as they are: owner guide, runbooks, records and archive. docs/implementation is listed below.
const owner = 'owner',
  arabic = 'owner/ar',
  folders = ['acceptance', 'records', 'archive'];
const platforms = [
  ['GOOGLE', 'Google'],
  ['META', 'Meta'],
  ['TIKTOK', 'TikTok'],
  ['SNAPCHAT', 'Snapchat'],
  ['LINKEDIN', 'LinkedIn'],
  ['X', 'X'],
  ['DV360', 'Display & Video 360'],
  ['CRITEO', 'Criteo'],
];

const read = file => fs.readFileSync(path.join(docs, file), 'utf8');
const title = file => {
  const heading = read(file).match(/^# (.+)$/m);
  if (!heading) throw Error('docs/' + file + ' has no title (a "# " heading).');
  return heading[1].trim();
};
const listing = directory =>
  fs.existsSync(path.join(docs, directory))
    ? fs
        .readdirSync(path.join(docs, directory), {withFileTypes: true})
        .filter(entry => entry.isFile())
        .map(entry => (directory ? directory + '/' : '') + entry.name)
        .sort()
    : [];
const markdown = directory => listing(directory).filter(f => f.endsWith('.md'));
const stubs = new Set(
  [...readMoves(fileURLToPath(new URL('..', import.meta.url))).moves.keys()]
    .filter(file => file.startsWith('docs/'))
    .map(file => file.slice('docs/'.length)),
);
const problems = [];
const placed = sections.flatMap(([, files]) => files);
for (const file of placed) {
  if (stubs.has(file)) problems.push('docs/' + file + ' moved (docs/moved.json); place its new address instead');
  else if (!fs.existsSync(path.join(docs, file))) problems.push('docs/' + file + ' does not exist');
}
if (new Set(placed).size !== placed.length) problems.push('a document is placed twice');

// Every Markdown document under docs/ is listed: placed, in a listed folder, an implementation record, or a stub.
const listedFolders = new Set([owner, arabic, ...folders, 'implementation']);
const walk = directory =>
  fs.readdirSync(path.join(docs, directory), {withFileTypes: true}).flatMap(entry => {
    const file = (directory ? directory + '/' : '') + entry.name;
    return entry.isDirectory() ? walk(file) : file.endsWith('.md') ? [file] : [];
  });
for (const file of walk('')) {
  if (file === 'README.md' || stubs.has(file) || placed.includes(file)) continue;
  if (!listedFolders.has(path.posix.dirname(file)))
    problems.push('place docs/' + file + ' in a section of tools/docs-index.mjs');
}

// The owner guide: the English pages in the order its README links them, each beside its Arabic translation.
const ownerPages = (() => {
  const pages = markdown(owner);
  if (!pages.length) return [];
  const index = owner + '/README.md',
    order = [index];
  for (const link of markdownLinks(read(index))) {
    const page = path.posix.normalize(owner + '/' + link.target.split('#')[0]);
    if (pages.includes(page) && !order.includes(page)) order.push(page);
  }
  for (const page of pages) if (!order.includes(page)) problems.push('docs/' + index + ' does not link docs/' + page);
  for (const page of pages) {
    const translation = arabic + '/' + path.posix.basename(page);
    if (!fs.existsSync(path.join(docs, translation)))
      problems.push('docs/' + page + ' has no Arabic translation docs/' + translation);
  }
  for (const page of markdown(arabic))
    if (!fs.existsSync(path.join(docs, owner, path.posix.basename(page))))
      problems.push('docs/' + page + ' translates no English page of docs/' + owner);
  return order.filter(page => pages.includes(page));
})();

const lines = [
  '# AMCP documentation',
  '',
  'Generated by `npm run docs:index`; `npm run check` fails when it is out of date. Each document is listed with its own',
  'title: the owner guide, runbooks, records, archive and implementation records from their folders, every other guide',
  'from the section `tools/docs-index.mjs` places it in. Start with the [repository README](../README.md) for what AMCP',
  'is.',
  '',
  'The documentation has three tiers, one for each reader (owner decision P12):',
  '',
  '- **Workspace owners** at agencies and in-house teams: the [owner guide](#owner-guide), in English with a complete',
  '  Arabic translation. Plain language, task by task, and what stays the owner’s to do.',
  '- **Operators** who deploy, configure and accept AMCP: [status and decisions](#status-and-decisions),',
  '  [operate and deploy](#operate-and-deploy), [acceptance](#acceptance), the [workflow guides](#workflow-guides) and',
  '  the [platform guides](#platform-guides).',
  '- **Engineers** who change AMCP: [engineering](#engineering), [reviews and plans](#reviews-and-plans) and the',
  '  [implementation records](#implementation-records).',
  '',
  'Dated delivery records and superseded reviews are kept as they were written, under [records](#records) and',
  '[archive](#archive). A document that moved keeps a redirect stub at its old address ([moves](moved.json)).',
  '',
  'Keeping it current: a current page says what is true now, so the history of a delivery belongs in its commit or a',
  'record, never in a guide. `npm run docs:index:check` refuses a broken relative link anywhere in the repository and,',
  'on a current page, a new heading naming a batch, a commit reference or a long line repeated from another current page',
  '(`tools/docs-lint.mjs`). To move or rename a document, add it to [moves](moved.json) and run',
  '`node tools/docs-links.mjs --write`, which rewrites every link to it and writes the stub.',
  '',
];
const row = file => '- [' + title(file) + '](' + file + ')';
if (ownerPages.length) {
  lines.push('## Owner guide', '', '| English | العربية |', '|---|---|');
  for (const page of ownerPages) {
    const translation = arabic + '/' + path.posix.basename(page);
    lines.push(
      '| [' +
        title(page).replace(/\|/g, '\\|') +
        '](' +
        page +
        ') | ' +
        (fs.existsSync(path.join(docs, translation))
          ? '[' + title(translation).replace(/\|/g, '\\|') + '](' + translation + ')'
          : '') +
        ' |',
    );
  }
  lines.push('');
}
const placedSection = name => {
  const [, files] = sections.find(([n]) => n === name);
  lines.push('## ' + name, '');
  for (const file of files) if (fs.existsSync(path.join(docs, file)) && !stubs.has(file)) lines.push(row(file));
  lines.push('');
};
placedSection('Status and decisions');
placedSection('Operate and deploy');
// ACC-01 to ACC-08: the owner-run acceptance runbooks, their index first.
const runbooks = markdown('acceptance');
lines.push('## Acceptance', '');
for (const file of [
  ...runbooks.filter(f => f.endsWith('/README.md')),
  ...runbooks.filter(f => !f.endsWith('/README.md')),
])
  lines.push(row(file));
lines.push('');
placedSection('Workflow guides');
placedSection('Platform guides');
placedSection('Engineering');
placedSection('Reviews and plans');

// Implementation records: a dated account of how one family or change was built and verified. A record's
// NAME-VERIFICATION-DATE.json holds its machine-checked evidence.
const implementation = fs.readdirSync(path.join(docs, 'implementation')).sort();
const evidenceOf = file => file.replace(/-(\d{4}-\d{2}-\d{2})\.md$/, '-VERIFICATION-$1.json');
const records = implementation
  .filter(f => f.endsWith('.md'))
  .map(file => {
    const evidence = evidenceOf(file),
      prefix = file.split('-')[0],
      platform = platforms.find(([p]) => p === prefix);
    return {
      file,
      date: file.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '',
      title: title('implementation/' + file)
        .replace(/\s+[—-]\s+\d{4}-\d{2}-\d{2}$/, '')
        .replace(/\s+\(\d{4}-\d{2}-\d{2}\)$/, ''),
      evidence: evidence !== file && implementation.includes(evidence) ? evidence : undefined,
      group: platform ? platform[1] : 'Across platforms',
    };
  });
const paired = new Set(records.map(r => r.evidence).filter(Boolean));
lines.push(
  '## Implementation records',
  '',
  'How each reviewed family or change was built and verified, newest first within each platform. A record’s',
  'verification file holds its machine-checked evidence.',
  '',
);
for (const group of [...platforms.map(([, name]) => name), 'Across platforms']) {
  const rows = records
    .filter(r => r.group === group)
    .sort((a, b) => b.date.localeCompare(a.date) || a.file.localeCompare(b.file));
  if (!rows.length) continue;
  lines.push('### ' + group, '', '| Date | Record | Evidence |', '|---|---|---|');
  for (const r of rows)
    lines.push(
      '| ' +
        (r.date || '—') +
        ' | [' +
        r.title.replace(/\|/g, '\\|') +
        '](implementation/' +
        r.file +
        ') | ' +
        (r.evidence ? '[verification](implementation/' + r.evidence + ')' : '') +
        ' |',
    );
  lines.push('');
}
const data = implementation.filter(f => !f.endsWith('.md') && !paired.has(f));
lines.push('### Ledgers and data', '');
for (const file of data) lines.push('- [' + file + '](implementation/' + file + ')');
lines.push('');

// Records and the archive: listed by date (from the file name; an undated record first), never edited except for a
// link to the address of a document that moved.
const dated = file => file.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
const folder = (name, heading, intro) => {
  const files = listing(name),
    pages = files.filter(f => f.endsWith('.md')).sort((a, b) => dated(a).localeCompare(dated(b)) || a.localeCompare(b));
  lines.push('## ' + heading, '', intro, '', '| Date | Document |', '|---|---|');
  for (const file of pages)
    lines.push('| ' + (dated(file) || '—') + ' | [' + title(file).replace(/\|/g, '\\|') + '](' + file + ') |');
  const other = files.filter(f => !f.endsWith('.md'));
  if (other.length)
    lines.push('', 'Data: ' + other.map(f => '[' + path.posix.basename(f) + '](' + f + ')').join(', ') + '.');
  lines.push('');
};
folder(
  'records',
  'Records',
  'What was delivered, measured or found on a given day, kept as written: the delivery records of the October 2026\n' +
    'review, the incident record, the September progress log, and the batch history that the write coverage and\n' +
    'implementation pages held until the documentation freeze.',
);
folder(
  'archive',
  'Archive',
  'Reviews, summaries and proposals that later documents superseded, kept for their history: their recommendations\n' +
    'have dispositions in [decisions](DECISIONS.md), and the current state is in the sections above.',
);
const text = lines.join('\n').replace(/\n+$/, '') + '\n';

// The three-axis package status (DOC-02): its data must validate, and its generated table is written and checked here.
const root = fileURLToPath(new URL('..', import.meta.url)),
  status = packageStatusTable(root),
  statusTarget = fileURLToPath(new URL('../' + tableFile, import.meta.url));
for (const problem of status.problems) problems.push('package status: ' + problem);
if (problems.length) {
  console.error('Documentation index: ' + problems.join('; '));
  process.exit(1);
}
const count = (text.match(/\]\((?!\.\.\/|#|moved\.json)[^)]+\)/g) ?? []).length;
const check = process.argv.includes('--check');
if (check) {
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== text) {
    console.error('docs/README.md is out of date. Run npm run docs:index.');
    process.exit(1);
  }
  if (!fs.existsSync(statusTarget) || fs.readFileSync(statusTarget, 'utf8') !== status.table) {
    console.error(tableFile + ' is out of date. Run npm run docs:index.');
    process.exit(1);
  }
} else {
  fs.writeFileSync(target, text);
  fs.writeFileSync(statusTarget, status.table);
  writeStubs(root);
}
// DOC-03: every relative link in the repository's Markdown resolves, and every moved document keeps its stub.
const links = linkProblems(root);
if (links.length) {
  console.error(
    'Documentation links:\n' + links.join('\n') + '\nRun node tools/docs-links.mjs --write for moved addresses.',
  );
  process.exit(1);
}
// DOC-03: current pages collect no new batch headings, commit references or repeated long lines.
const lint = lintProblems(root);
if (lint.length) {
  console.error('Documentation freeze (tools/docs-lint.mjs):\n' + lint.join('\n'));
  process.exit(1);
}
console.log((check ? 'docs/README.md lists ' : 'Wrote docs/README.md: ') + count + ' documents; every link resolves.');
