// DOC-03 (owner decision P12): the primary audience is workspace owners at agencies and in-house teams, and owner
// documentation is bilingual, English first with an Arabic translation. Before it, a new owner met release-engineering
// status pages; there was no owner guide in either language. These checks hold the guide to its job: every English page
// has a complete Arabic translation with the same structure and links, it stays in plain language and short (the
// ticket's target is about 1,500 English words; the first guide held about 5,000), the names it gives the website's
// pages and controls are the website's own in both languages, and its links stay inside the guide or the website, so
// the members-only Help page (tools/help-pages.mjs) can show it as it is.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {markdownAnchors, markdownLinks, parseTarget, resolveLink} from '../tools/docs-links.mjs';
import {frontMatter, stripFrontMatter} from '../tools/docs-front-matter.mjs';

const english = 'docs/owner',
  arabic = 'docs/owner/ar',
  pages = fs
    .readdirSync(english)
    .filter(file => file.endsWith('.md'))
    .sort(),
  // The guide's text, without the front matter every documentation page opens with.
  read = file => stripFrontMatter(fs.readFileSync(file, 'utf8'));
// What the owner guide must cover (DOC-03): connecting accounts, readiness, paused launches through review, reports and
// exports, the measurement hub, recovery, team and clients, privacy and retention, and what stays owner-run.
const topics = [
  'README.md',
  'connect.md',
  'readiness.md',
  'campaigns.md',
  'results.md',
  'measurement.md',
  'recovery.md',
  'team.md',
  'privacy.md',
  'owner-run.md',
];
// The website's names the guide uses, as web/locales/ar.json pairs them with their Arabic. The last test holds this
// list complete: every bold or italic name of the English guide that the catalog knows is here.
const labels = [
  'Help',
  'Workspace settings',
  'Pause all writes',
  'Connections',
  'Connect',
  'Connection result',
  'Manage',
  'Save selection',
  'Save and check access',
  'Resource write access',
  'Save write access',
  'Administrator setup required',
  '+ Connect another',
  'Make default',
  'Reauthorize',
  'Reauthorization required',
  'Declined permissions',
  'Disconnect',
  'AI connectors',
  'Home',
  'Account readiness',
  'Accounts and their readiness',
  'Check account',
  'Prerequisites',
  'Capabilities',
  'Capabilities and evidence',
  'Technical details',
  'Implemented, not live-verified',
  'Campaigns',
  'Create paused campaign plan',
  'Check prerequisites again',
  'Approve this complete plan',
  'Save plan approval',
  'Run the approved plan',
  'Prepare again',
  'Read-back evidence',
  'Account spending policy',
  'Allow activation after review',
  'Allow deletion after review',
  'Report builder',
  'Pull report',
  'Recommendations',
  'Save report',
  'Download CSV',
  'Export now to Google Sheets',
  'Deliver complete reports only',
  'Allow clearly marked partial reports',
  'Reporting',
  'Schedules',
  'Evidence & analysis',
  'Unconfirmed Google Sheets delivery',
  'Report file downloads',
  'Measurement',
  'Measurement evidence ledger',
  'Observed',
  'Unknown',
  'Unavailable',
  'Not applicable',
  'Inspect a sanitized event trace',
  'Operations',
  'Monitoring inbox',
  'Audit activity',
  'Check the provider (read-only)',
  'Accept as applied',
  'Prepare support bundle',
  'Your account',
  'Workspace members',
  'Workspace security',
  'Confirm it’s you',
  'Clients & templates',
  'Working client',
  'Client access sets',
  'Retention',
  'Delete your account',
  'Privacy',
];

/** A page's shape: its heading levels in order, its list items, its table rows and the documents it links. */
function shape(file) {
  const text = read(file).replace(/```[\s\S]*?```/g, ''),
    lines = text.split('\n');
  const links = markdownLinks(text)
    .map(link => ({link, target: parseTarget(link.target)}))
    .filter(({target}) => target.kind === 'file')
    .map(({link, target}) => {
      const resolved = resolveLink(file, target.file);
      // An Arabic page and its English page are one document in two languages.
      return resolved.startsWith(arabic + '/') ? english + '/' + path.posix.basename(resolved) : resolved;
    })
    .filter(resolved => resolved !== english + '/' + path.posix.basename(file));
  return {
    headings: lines.filter(line => /^#{1,6} /.test(line)).map(line => line.match(/^#+/)[0].length),
    items: lines.filter(line => /^\s*(?:[-*]|\d+\.) /.test(line)).length,
    rows: lines.filter(line => /^\|/.test(line)).length,
    links: links.sort(),
    external: markdownLinks(text).filter(link => parseTarget(link.target).kind === 'external').length,
  };
}
/** The prose blocks of a page (paragraphs, list items, table cells), without link targets and code. */
const blocks = file =>
  read(file)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/`[^`\n]*`/g, '')
    .split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.) )|\|/)
    .map(block => block.trim())
    .filter(Boolean);
/** A line of a former section's anchors (`<a id="..."></a>`), which keeps an old address: markup, not prose. */
const anchorLine = /^(?:<a id="[^"]+"><\/a>)+$/gm;
/** The words of a page's prose: Markdown markers (list numbers, table pipes, heading marks) are not words. */
const words = file =>
  read(file)
    .replace(anchorLine, '')
    .split(/\s+/)
    .filter(word => word && !/^(?:\||[-*]|\d+\.|#+|\|?(?:---\|)+)$/.test(word)).length;

test('the owner guide covers each owner task, and every page has an Arabic translation and no other', () => {
  assert.deepEqual(pages, [...topics].sort());
  assert.deepEqual(
    fs
      .readdirSync(arabic)
      .filter(file => file.endsWith('.md'))
      .sort(),
    pages,
  );
  // Privacy is designed to the GDPR and the KSA PDPL (owner decision P3), said in both languages, as not legal advice.
  for (const file of [english + '/privacy.md', arabic + '/privacy.md']) {
    assert.match(read(file), /GDPR/);
    assert.match(read(file), /PDPL/);
  }
  assert.match(read(english + '/privacy.md'), /not legal advice/);
  assert.match(read(arabic + '/privacy.md'), /ليست استشارة قانونية/);
  // The entry points lead to it: the repository README and the documentation map, in both languages.
  for (const target of ['docs/owner/README.md', 'docs/owner/ar/README.md']) {
    assert.ok(
      markdownLinks(read('README.md')).some(link => resolveLink('README.md', link.target.split('#')[0]) === target),
      'README.md links ' + target,
    );
    assert.ok(
      markdownLinks(read('docs/README.md')).some(
        link => resolveLink('docs/README.md', link.target.split('#')[0]) === target,
      ),
      'docs/README.md links ' + target,
    );
  }
  // Every page says what it is: a current page for workspace owners (tools/docs-front-matter.mjs).
  for (const file of pages.flatMap(page => [english + '/' + page, arabic + '/' + page]))
    assert.deepEqual(frontMatter(fs.readFileSync(file, 'utf8')).data, {status: 'current', tier: 'owner'}, file);
});

// The first guide held about 5,000 English words, a long read for the owner it addresses; the ticket's target is about
// 1,500. The detail it dropped moved to the operator tier (docs/operations/OWNER-TASKS.md) and to the guides it named.
test('the English guide stays at about 1,500 words, and the Arabic guide translates all of it', () => {
  const total = pages.reduce((sum, page) => sum + words(english + '/' + page), 0),
    translated = pages.reduce((sum, page) => sum + words(arabic + '/' + page), 0);
  assert.ok(total <= 1650, 'the English guide has ' + total + ' words; its target is about 1,500');
  assert.ok(total >= 1200, 'the English guide has ' + total + ' words: is a task missing?');
  // Arabic packs prepositions and pronouns into its words, so a complete translation has fewer of them, not a third.
  assert.ok(translated > total * 0.7 && translated < total * 1.2, 'Arabic ' + translated + ' against English ' + total);
  assert.ok(fs.existsSync('docs/operations/OWNER-TASKS.md'), 'the owner tasks keep their operator steps');
});

test('each Arabic page has its English page’s headings, lists, tables and links, and no untranslated passage', () => {
  for (const page of pages) {
    const en = shape(english + '/' + page),
      ar = shape(arabic + '/' + page);
    assert.deepEqual(ar, en, page);
    for (const block of blocks(arabic + '/' + page)) {
      const latin = (block.match(/[A-Za-z]/g) ?? []).length,
        letters = (block.match(/[؀-ۿ]/g) ?? []).length;
      // Product and platform names stay in Latin script; a passage of English with no Arabic is untranslated.
      assert.ok(letters > 0 || latin < 25, page + ': untranslated passage: ' + block.slice(0, 80));
    }
    assert.match(read(arabic + '/' + page), /^# [^\n]*[؀-ۿ]/, page + ' has an Arabic title');
    // Owner decision D27: Latin digits, as the website shows them, so a number reads the same in both languages.
    assert.doesNotMatch(read(arabic + '/' + page), /[٠-٩۰-۹]/, page + ' uses Arabic-Indic digits');
  }
});

test('the guide names the website’s pages and controls by their own English and Arabic names', () => {
  const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
    en = pages.map(page => read(english + '/' + page)).join('\n'),
    ar = pages.map(page => read(arabic + '/' + page)).join('\n');
  for (const label of labels) {
    assert.ok(
      Object.hasOwn(catalog, label),
      'The website no longer has "' + label + '": update docs/owner/ and docs/owner/ar/ to the name it uses now.',
    );
    assert.ok(en.includes(label), 'the English guide uses "' + label + '"');
    assert.ok(ar.includes(catalog[label]), 'the Arabic guide uses "' + catalog[label] + '" for "' + label + '"');
  }
  // The list is complete: a bold or italic website name in the English guide is checked in Arabic too. A bold lead-in
  // that ends its own sentence ("**Plan.**", "**One switch stops everything:**") is the guide's wording, not a name.
  const named = new Set(
    [...en.matchAll(/\*\*([^*]+?)\*\*|(?<!\*)\*([^*\s][^*]*?)\*(?!\*)/g)]
      .map(m => (m[1] ?? m[2]).trim())
      .filter(span => !/[.:]$/.test(span))
      .flatMap(span => span.split(' → '))
      .filter(name => Object.hasOwn(catalog, name)),
  );
  assert.deepEqual([...named].filter(name => !labels.includes(name)).sort(), []);
});

test('the guide stays in plain language: no tool names, codes, environment names, register IDs or batch notes', () => {
  for (const file of pages.flatMap(page => [english + '/' + page, arabic + '/' + page])) {
    const text = read(file).replace(/\]\([^)]*\)/g, ']');
    for (const [pattern, what] of [
      [/\bamcp_[a-z_]+/, 'an MCP tool name'],
      [/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/, 'an error code or environment variable'],
      [/\b(?:[A-Z]{2,4}-\d{2}|B\d{2}|[DPRQ]\d{1,2})\b/, 'a review register, package or decision ID'],
      [/\bbatch \d+/i, 'a batch note'],
      [/\b[0-9a-f]{7,40}\b/, 'a commit hash'],
    ])
      assert.doesNotMatch(text, pattern, file + ' contains ' + what);
  }
});

// The review of wave 4c: condensing the guide dropped most of its section headings (connect.md#several-logins, ...),
// which wave 4b had published, so a link to one from outside the repository opened its page at the top. Each page keeps
// every anchor it had, as a heading or as a former section's anchor before the text that holds that section now.
test('every section anchor the guide had before it was condensed still opens its page, in both languages', () => {
  const former = JSON.parse(fs.readFileSync('tests/fixtures/owner-guide-anchors.json', 'utf8')).pages;
  assert.deepEqual(
    Object.keys(former).sort(),
    pages.flatMap(page => [english + '/' + page, arabic + '/' + page]).sort(),
  );
  for (const [file, anchors] of Object.entries(former)) {
    const text = fs.readFileSync(file, 'utf8'),
      now = markdownAnchors(text);
    for (const anchor of anchors) assert.ok(now.has(anchor), file + '#' + anchor + ' resolves');
    // A former section's anchors are the ones the page had: the line keeps old addresses and invents none.
    const kept = [...read(file).matchAll(anchorLine)].flatMap(m => [...m[0].matchAll(/id="([^"]+)"/g)].map(a => a[1]));
    for (const anchor of kept) assert.ok(anchors.includes(anchor), file + ': ' + anchor + ' is no former anchor');
  }
});

// The members-only Help page shows the guide on the website (DOC-03), where a link can only open another part of the
// guide or a page of the website: a link to another page of the guide, or to a page of amcp.shop.
test('the guide links only to its own pages and to pages of the website', () => {
  for (const file of pages.flatMap(page => [english + '/' + page, arabic + '/' + page]))
    for (const link of markdownLinks(read(file))) {
      const target = parseTarget(link.target);
      if (target.kind === 'external') {
        assert.match(link.target, /^https:\/\/amcp\.shop\/[a-z-]+(?:\?lang=ar)?$/, file + ' links ' + link.target);
        continue;
      }
      const resolved = target.kind === 'section' ? file : resolveLink(file, target.file);
      assert.ok(
        path.posix.dirname(resolved) === path.posix.dirname(file) && pages.includes(path.posix.basename(resolved)),
        file + ' links ' + link.target + ', outside the guide',
      );
    }
});
