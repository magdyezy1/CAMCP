// DOC-03 (owner decision P12): the primary audience is workspace owners at agencies and in-house teams, and owner
// documentation is bilingual, English first with an Arabic translation. Before it, a new owner met release-engineering
// status pages; there was no owner guide in either language. These checks hold the guide to its job: every English page
// has a complete Arabic translation with the same structure and links, it stays in plain language, and the names it
// gives the website's pages and controls are the website's own, in both languages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {markdownLinks, parseTarget, resolveLink} from '../tools/docs-links.mjs';

const english = 'docs/owner',
  arabic = 'docs/owner/ar',
  pages = fs
    .readdirSync(english)
    .filter(file => file.endsWith('.md'))
    .sort(),
  read = file => fs.readFileSync(file, 'utf8');
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
// The website's names the guide uses, as web/locales/ar.json pairs them with their Arabic.
const labels = [
  'Home',
  'Campaigns',
  'Capabilities',
  'Connections',
  'Measurement',
  'Operations',
  'Monitoring inbox',
  'Audit activity',
  'Report builder',
  'Reporting',
  'Schedules',
  'Evidence & analysis',
  'Clients & templates',
  'Workspace settings',
  'Your account',
  'AI connectors',
  'Account readiness',
  'Accounts and their readiness',
  'Check account',
  'Technical details',
  'Capabilities and evidence',
  'Implemented, not live-verified',
  'Connect',
  'Connection result',
  'Administrator setup required',
  'Manage',
  'Save selection',
  'Save and check access',
  'Resource write access',
  'Save write access',
  'Enable read + reviewed write access for all selected resources',
  '+ Connect another',
  'Make default',
  'Reauthorize',
  'Reauthorization required',
  'Declined permissions',
  'Disconnect',
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
  'Pull report',
  'Save report',
  'Download CSV',
  'Deliver complete reports only',
  'Allow clearly marked partial reports',
  'Unconfirmed Google Sheets delivery',
  'Measurement evidence ledger',
  'Google Ads conversion goals',
  'GA4 property configuration',
  'Recent GA4 events',
  'Google Tag Manager configuration audit',
  'LinkedIn conversion settings',
  'Inspect a sanitized event trace',
  'Check the provider (read-only)',
  'Accept as applied',
  'Prepare support bundle',
  'Pause all writes',
  'Working client',
  'Client access sets',
  'Confirm it’s you',
  'Delete your account',
  'Workspace members',
  'Workspace security',
  'Report file downloads',
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
  const catalog = JSON.parse(read('web/locales/ar.json')),
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
