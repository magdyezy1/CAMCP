import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

/**
 * r12-gpreview item 2 (found live 2026-11-16): the review of a Google shareable-preview generation read "Change 1  in
 * account …", with no entity. The server's summary now says the request generates previews (operation "generate"). The
 * two pages that show a summary, the review of a campaign step and the record of a write, each map its operation to a word,
 * and an operation they do not map reads "Change", which is what the live review said. Each now says "Generate", in English
 * and in Arabic. These run the real page scripts in a VM with a synthetic summary; nothing reaches a server or a provider.
 */
const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
const esc = value =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const summary = {
  text: 'Generate 2 shareable previews in account 123.',
  operation: 'generate',
  entity: 'shareable preview',
  count: 2,
  account: {id: '123'},
};

function context(locale, scripts) {
  const node = () => ({
    innerHTML: '',
    textContent: '',
    isConnected: true,
    elements: {},
    setAttribute() {},
    focus() {},
    addEventListener() {},
    querySelector: node,
    querySelectorAll: () => [],
  });
  const c = createContext({
    document: {addEventListener() {}, querySelector: node, querySelectorAll: () => []},
    $: node,
    root: node(),
    esc,
    pretty: value => String(value ?? '').replaceAll('_', ' '),
    date: String,
    badge: esc,
    recordDetails: value => '<pre>' + esc(JSON.stringify(value)) + '</pre>',
    errorMessage: e => e.message,
    Intl,
    Date,
    URLSearchParams,
    Object,
    JSON,
    String,
    Number,
    Math,
    navigationGeneration: 1,
    identityGeneration: 1,
    session: {workspaceRole: 'operator'},
    toast() {},
    catalog,
    workspaceBind() {},
    confirmAction: async () => false,
  });
  const run = source => new Script(source).runInContext(c);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  for (const file of scripts) run(readFileSync('web/' + file, 'utf8'));
  return run;
}
const pages = [
  ['the review of a campaign step', 'campaign-workflows.js', 'reviewSummaryLine(summary)'],
  ['the record of a write', 'operations-center.js', 'writeSummary(summary)'],
];

for (const [label, file, render] of pages)
  test(label + ' says Generate for a generation, and Change only for an operation it does not know', () => {
    const english = context('en', [file]);
    english('summary = ' + JSON.stringify(summary));
    const html = english(render);
    assert.match(html, /<strong>Generate<\/strong> <bdi dir="ltr">2 × shareable preview<\/bdi>/);
    assert.doesNotMatch(html, /Change/);
    // Every other operation reads as it did.
    for (const [operation, word] of [
      ['create', 'Create'],
      ['update', 'Update'],
      ['delete', 'Delete'],
      ['remove', 'Remove'],
      ['publish', 'Publish'],
      ['change', 'Change'],
      ['reconfigure', 'Change'],
    ]) {
      english('summary = ' + JSON.stringify({...summary, operation}));
      assert.match(english(render), new RegExp('<strong>' + word + '</strong>'), operation);
    }
  });

test('Generate has its own Arabic word, which is not the one for Create', () => {
  assert.match(catalog.Generate ?? '', /[؀-ۿ]/, 'Arabic for Generate');
  assert.notEqual(catalog.Generate, 'Generate');
  assert.notEqual(catalog.Generate, catalog.Create);
  for (const [, file, render] of pages) {
    const arabic = context('ar', [file]);
    arabic('summary = ' + JSON.stringify(summary));
    const html = arabic(render);
    assert.ok(html.includes('<strong>' + catalog.Generate + '</strong>'), file);
    assert.ok(!html.includes('<strong>' + catalog.Change + '</strong>'), file);
    assert.ok(!html.includes('<strong>Generate</strong>'), file);
  }
});
