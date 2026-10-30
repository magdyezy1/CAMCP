// Writes docs/README.md, the map of AMCP's documentation (F-68, DOC-03), from the documents themselves: each is listed
// with its own title, in the place its front matter gives it (tools/docs-front-matter.mjs), so there is no hand list to
// keep. The map has three tiers, one per reader (owner decision P12: the primary audience is workspace owners at
// agencies and in-house teams): the owner guide (in its reading order, each English page beside its Arabic
// translation), then operating AMCP (its current pages, then the references operators consult), then changing it (the
// engineering references, proposals and implementation records). Dated records and the archive follow, by date. Within
// a section a page is grouped by its folder and ordered by title. A moved document's old address holds a redirect stub
// (docs/moved.json, tools/docs-links.mjs), which is never listed; this writes the stubs, and fails on a page without
// valid front matter, on any broken relative link in the repository's Markdown and on a maintained page that breaks
// the documentation freeze or a page set above its size target (tools/docs-lint.mjs). It also writes, or with --check
// compares, the generated pages: the package status, the status page, the findings register, the current pages' facts
// generated from the code (tools/doc-facts.mjs, DOC-01) and the Help page's fragments, so it needs `npm run build` first.
// Usage: node tools/docs-index.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {linkProblems, markdownLinks, readMoves, writeStubs} from './docs-links.mjs';
import {budgetProblems, lintProblems} from './docs-lint.mjs';
import {packageStatusTable, tableFile} from './package-status.mjs';
import {docFacts} from './doc-facts.mjs';
import {helpGuideProblems} from './help-pages.mjs';
import {documentationPages, documentationProblems, frontMatterBlock, pageMeta} from './docs-front-matter.mjs';
import {statusProblems} from './docs-status.mjs';
import {findingsProblems} from './findings-register.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)),
  docs = path.join(root, 'docs'),
  target = path.join(docs, 'README.md'),
  check = process.argv.includes('--check');
/** The group a page's folder gives it within its section (folders, not documents: a new page needs no entry here). */
const folderGroups = {
  docs: 'Guides',
  'docs/operations': 'Operating tasks',
  'docs/workflows': 'Workflow guides',
  'docs/acceptance': 'Acceptance runbooks',
  'docs/review': 'Status, reviews and policies',
  'docs/implementation': 'Generated reports',
};
const owner = 'owner',
  arabic = 'owner/ar';
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
const cell = text => text.replace(/\|/g, '\\|');
const {moves} = readMoves(root),
  stubs = new Set([...moves.keys()].filter(file => file.startsWith('docs/')));
const problems = [];
// The three-axis package status (DOC-02): its data must validate, and its generated table is written and checked here.
const status = packageStatusTable(root),
  statusTarget = path.join(root, tableFile);
for (const problem of status.problems) problems.push('package status: ' + problem);
// DOC-01: the current pages' generated facts (tools/doc-facts.mjs), checked or written with the index. It needs dist/.
const facts = docFacts(root, {write: !check});
for (const problem of facts.problems) problems.push('documentation facts: ' + problem);
// DOC-03: the status page, generated from the package status, those facts, provider access and the latest record.
problems.push(...statusProblems(root, facts.facts, {write: !check}));
// DOC-03: the members-only Help page's fragments (tools/help-pages.mjs) are the owner guide as it is now.
problems.push(...helpGuideProblems(root, {write: !check}));
// DOC-03: the findings register's open and closed views (tools/findings-register.mjs).
problems.push(...findingsProblems(root, {write: !check}));
// The generated pages and the redirect stubs are written first, so the index below lists and checks them as they are.
if (!check) writeStubs(root);
problems.push(...documentationProblems(root, stubs));

// Every page under docs/ but the index and the stubs, with its meta data (docs-relative paths).
const pages = documentationPages(root)
  .filter(file => file.startsWith('docs/') && file !== 'docs/README.md' && !stubs.has(file))
  .map(file => ({file: file.slice('docs/'.length), meta: pageMeta(root, file) ?? {}}))
  .filter(page => page.meta.status);

// The owner guide: the English pages in the order its README links them, each beside its Arabic translation.
const markdown = directory =>
  fs.existsSync(path.join(docs, directory))
    ? fs
        .readdirSync(path.join(docs, directory), {withFileTypes: true})
        .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
        .map(entry => directory + '/' + entry.name)
        .sort()
    : [];
const ownerPages = (() => {
  const english = markdown(owner);
  if (!english.length) return [];
  const index = owner + '/README.md',
    order = [index];
  for (const link of markdownLinks(read(index))) {
    const page = path.posix.normalize(owner + '/' + link.target.split('#')[0]);
    if (english.includes(page) && !order.includes(page)) order.push(page);
  }
  for (const page of english) if (!order.includes(page)) problems.push('docs/' + index + ' does not link docs/' + page);
  for (const page of english) {
    const translation = arabic + '/' + path.posix.basename(page);
    if (!fs.existsSync(path.join(docs, translation)))
      problems.push('docs/' + page + ' has no Arabic translation docs/' + translation);
  }
  for (const page of markdown(arabic))
    if (!fs.existsSync(path.join(docs, owner, path.posix.basename(page))))
      problems.push('docs/' + page + ' translates no English page of docs/' + owner);
  return order.filter(page => english.includes(page));
})();

const lines = [
  frontMatterBlock({status: 'current', tier: 'operator', generated: 'tools/docs-index.mjs'}).trimEnd(),
  '',
  '# AMCP documentation',
  '',
  'Generated by `npm run docs:index` from each page’s front matter; `npm run check` fails when it is out of date. Each',
  'document is listed with its own title, where its status and tier place it. Start with the',
  '[repository README](../README.md) for what AMCP is and the [status page](STATUS.md) for where it stands.',
  '',
  'The documentation has three tiers, one for each reader (owner decision P12):',
  '',
  '- **Workspace owners** at agencies and in-house teams: the [owner guide](#owner-guide), in English with a complete',
  '  Arabic translation, which members also read on the website under **Help**. Plain language, task by task, and',
  '  what stays the owner’s to do.',
  '- **Operators** who deploy, configure and accept AMCP: [operate AMCP](#operate-amcp), the current pages, and the',
  '  [operator reference](#operator-reference) they consult on demand.',
  '- **Engineers** who change AMCP: the [engineering reference](#engineering-reference),',
  '  [plans and proposals](#plans-and-proposals) and the [implementation records](#implementation-records).',
  '',
  'Each page opens with its front matter: its **status** (*current*: what is true now, kept short; *reference*: detail',
  'consulted on demand; *record*: dated and kept as written; *proposal*; *archived*) and its **tier** (owner, operator',
  'or engineering). Dated delivery records and superseded reviews are under [records](#records) and [archive](#archive).',
  'A document that moved keeps a redirect stub at its old address ([moves](moved.json)).',
  '',
  'Keeping it current: a current page says what is true now, so the history of a delivery belongs in its commit or a',
  'record, never in a guide. `npm run docs:index:check` refuses a page without valid front matter, a broken relative',
  'link anywhere in the repository and, on a current or reference page, a new heading naming a batch, a commit',
  'reference, a typed package count (link the [package status](review/PACKAGE-STATUS.md) instead) or a long line',
  'repeated from another such page (`tools/docs-lint.mjs`). The owner and operator tiers’ current pages keep within a',
  'budget of 25,000 words, and the reference pages’ total may only fall unless an increase is recorded with its reason',
  '([decisions](DECISIONS.md), 2026-10-24). To move or rename a document, add it to [moves](moved.json) and run',
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
        cell(title(page)) +
        '](' +
        page +
        ') | ' +
        (fs.existsSync(path.join(docs, translation)) ? '[' + cell(title(translation)) + '](' + translation + ')' : '') +
        ' |',
    );
  }
  lines.push('');
}
/**
 * The anchors of the index's sections before 2026-10-24 (DOC-03), each kept at the section that lists most of its
 * pages now, so a link to one from outside the repository still opens the right part of the index. The other sections
 * kept their names (the owner guide, the workflow guides, the implementation records, records and archive).
 */
const formerAnchors = Object.freeze({
  'Operate AMCP': ['status-and-decisions', 'operate-and-deploy', 'acceptance'],
  'Operator reference': ['platform-guides'],
  'Engineering reference': ['engineering'],
  'Plans and proposals': ['reviews-and-plans'],
});
/** A section of pages, grouped by folder (the folders in folderGroups' order, then any other) and ordered by title. */
const section = (heading, intro, selected) => {
  const anchors = (formerAnchors[heading] ?? []).map(anchor => '<a id="' + anchor + '"></a>').join('');
  lines.push('## ' + heading, '', anchors + intro, '');
  const groupOf = page => {
      const folder = path.posix.dirname('docs/' + page.file);
      return folderGroups[folder] ?? folder;
    },
    order = [...Object.values(folderGroups)],
    groups = [...new Set(selected.map(groupOf))].sort(
      (a, b) =>
        (order.indexOf(a) + 1 || order.length + 1) - (order.indexOf(b) + 1 || order.length + 1) || a.localeCompare(b),
    );
  for (const group of groups) {
    const members = selected
      .filter(page => groupOf(page) === group)
      .sort((a, b) => title(a.file).localeCompare(title(b.file), 'en') || a.file.localeCompare(b.file));
    lines.push('### ' + group, '', ...members.map(page => row(page.file)), '');
  }
};
const is = (page, status, tiers) => page.meta.status === status && tiers.includes(page.meta.tier);
section(
  'Operate AMCP',
  'The current pages for whoever deploys, configures, accepts and runs AMCP: what is true now.',
  pages.filter(page => is(page, 'current', ['operator'])),
);
section(
  'Operator reference',
  'Detail operators consult on demand: the workflow and platform guides, the acceptance runbooks and the decisions.',
  pages.filter(page => is(page, 'reference', ['operator'])),
);
section(
  'Engineering reference',
  'How AMCP is built and checked, for whoever changes it.',
  pages.filter(page => ['current', 'reference'].includes(page.meta.status) && page.meta.tier === 'engineering'),
);
section(
  'Plans and proposals',
  'Plans and proposals that are not the product; [decisions](DECISIONS.md) records what became of them.',
  pages.filter(page => page.meta.status === 'proposal'),
);

// Implementation records: a dated account of how one family or change was built and verified. A record's
// NAME-VERIFICATION-DATE.json holds its machine-checked evidence.
const implementation = fs.readdirSync(path.join(docs, 'implementation')).sort(),
  implementationRecords = new Set(
    pages.filter(p => p.file.startsWith('implementation/') && p.meta.status === 'record').map(p => p.file),
  );
const evidenceOf = file => file.replace(/-(\d{4}-\d{2}-\d{2})\.md$/, '-VERIFICATION-$1.json');
const records = implementation
  .filter(f => implementationRecords.has('implementation/' + f))
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
        cell(r.title) +
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
const byDate = (heading, intro, selected, dataFolder) => {
  const sorted = selected.map(page => page.file).sort((a, b) => dated(a).localeCompare(dated(b)) || a.localeCompare(b));
  lines.push('## ' + heading, '', intro, '', '| Date | Document |', '|---|---|');
  for (const file of sorted) lines.push('| ' + (dated(file) || '—') + ' | [' + cell(title(file)) + '](' + file + ') |');
  const other = fs.existsSync(path.join(docs, dataFolder))
    ? fs
        .readdirSync(path.join(docs, dataFolder), {recursive: true})
        .map(f => dataFolder + '/' + String(f).replaceAll('\\', '/'))
        .filter(f => !f.endsWith('.md') && fs.statSync(path.join(docs, f)).isFile())
        .sort()
    : [];
  if (other.length)
    lines.push('', 'Data: ' + other.map(f => '[' + path.posix.basename(f) + '](' + f + ')').join(', ') + '.');
  lines.push('');
};
byDate(
  'Records',
  'What was delivered, measured or found on a given day, kept as written: the delivery records of the October 2026\n' +
    'review, the incident record, the design review, each deployment and qualification with the revisions it covered,\n' +
    'the September progress log, and the delivery history the current guides held until the documentation freeze and\n' +
    'its consolidation moved it here.',
  pages.filter(page => page.meta.status === 'record' && !page.file.startsWith('implementation/')),
  'records',
);
byDate(
  'Archive',
  'Reviews, summaries and proposals that later documents superseded, kept for their history: their recommendations\n' +
    'have dispositions in [decisions](DECISIONS.md), and the current state is in the sections above.',
  pages.filter(page => page.meta.status === 'archived'),
  'archive',
);
const text = lines.join('\n').replace(/\n+$/, '') + '\n';
// Every page is listed once: a page the sections above leave out has a status or tier no section takes.
const listed = new Set([...text.matchAll(/\]\(((?!\.\.\/|#|https?:)[^)#]+)\)/g)].map(m => m[1]));
for (const page of pages)
  if (!listed.has(page.file) && !page.file.startsWith(owner + '/'))
    problems.push(
      'docs/' + page.file + ' (' + page.meta.status + ', ' + page.meta.tier + ') has no place in the index',
    );

if (problems.length) {
  console.error('Documentation index: ' + problems.join('; '));
  process.exit(1);
}
const count = (text.match(/\]\((?!\.\.\/|#|moved\.json)[^)]+\)/g) ?? []).length;
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
// DOC-03: maintained pages collect no new batch headings, commit references or repeated long lines, and the page sets
// keep to their size targets.
const lint = [...lintProblems(root), ...budgetProblems(root)];
if (lint.length) {
  console.error('Documentation freeze (tools/docs-lint.mjs):\n' + lint.join('\n'));
  process.exit(1);
}
console.log((check ? 'docs/README.md lists ' : 'Wrote docs/README.md: ') + count + ' documents; every link resolves.');
