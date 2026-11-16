// Package r25-m0-live, the lead's review of 2026-11-15, S2-1. WEB-03 (tests/fixtures/website-remedy.mjs): a remedy written for an
// MCP client is never shown to a person. A provider's refusal of a report reaches the website in two places, and this file runs
// both with the page's own code:
//  - the Reporting Overview's source card (web/workspace.js renderSourceDiagnostic), which shows the server's `next_action` as it
//    is written, so a provider remedy that reaches it must already be worded for people;
//  - the evidence page's capture_preset feedback (web/evidence-workflows.js, through errorMessage in web/app.js), which replaces a
//    remedy written for an MCP client with the wording of its category: for a report, "Narrow it ... or try again later".
// LinkedIn's remedy for an empty answer named a tool and an action, so the card showed MCP-client text, and the evidence page
// showed "Narrow it" where the remedy says to widen the window. TikTok's remedy for a page-count refusal (r25-hotfix) named
// `details.page_facts.rule` and reached the card the same way. Both are now worded for people, and what they say reaches both pages
// as written, in English and in Arabic. The errors and facts below are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {MirrorError, errorResult, providerDataCodes} from '../dist/src/errors.js';
import {reportSourceError} from '../dist/src/report-errors.js';
import {providerRemedies, remedyNamesCode} from '../dist/src/provider-remedies.js';
import {tiktokPageCountMessage} from '../dist/src/tiktok-report-pagination.js';

const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  app = readFileSync('web/app.js', 'utf8'),
  workspace = readFileSync('web/workspace.js', 'utf8'),
  presentationSource = app.slice(app.indexOf('function requestError('), app.indexOf("const content = $('#content')")),
  diagnosticSource = workspace.slice(
    workspace.indexOf('function renderSourceDiagnostic(error) {'),
    workspace.indexOf('const capabilityFeatureLabels'),
  );
const esc = value =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** The page's own presentation code (web/localization.js, the error layer of web/app.js, the source card) in a VM. */
function page(locale = 'en') {
  const element = () => ({
    innerHTML: '',
    textContent: '',
    dataset: {},
    addEventListener() {},
    querySelector: () => element(),
    querySelectorAll: () => [],
    setAttribute() {},
    getAttribute: () => null,
  });
  const context = createContext({
    catalog,
    Intl,
    Date,
    URL,
    URLSearchParams,
    structuredClone,
    CSS: {escape: String},
    location: {pathname: '/evidence', search: '', hash: ''},
    history: {replaceState() {}, pushState() {}},
    document: {
      activeElement: null,
      addEventListener() {},
      querySelector: () => element(),
      querySelectorAll: () => [],
      getElementById: () => element(),
      createElement: () => element(),
    },
    $: () => element(),
    content: element(),
    esc,
    date: String,
    toast() {},
    session: {authenticated: true, id: 'person-a', workspaceRole: 'owner', csrf: 'csrf'},
    platforms: [],
    navigationGeneration: 1,
    identityGeneration: 1,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    crypto: {randomUUID: () => '11111111-1111-4111-8111-111111111111'},
  });
  const run = source => new Script(source).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  run(presentationSource);
  run(diagnosticSource);
  return {context, run};
}

const tiktokFacts = rule => ({page: 1, page_size: 7, total_number: 7, total_page: 1, list_length: 7, rule});
const cases = {
  linkedin: {
    source: {platform: 'linkedin', account_id: '100', connection_id: 'synthetic'},
    error: () =>
      new MirrorError(
        'REPORT_EMPTY_AMBIGUOUS',
        'LinkedIn returned no rows. No activity and missing reporting access cannot be distinguished; no zero-performance evidence was saved.',
        {},
        502,
      ),
    says: [/Widen the window within LinkedIn’s limit/, /tell no activity from no access/],
  },
  tiktok: {
    source: {platform: 'tiktok', account_id: '100', connection_id: 'synthetic'},
    error: () =>
      new MirrorError('REPORT_INCOMPLETE', tiktokPageCountMessage, {page_facts: tiktokFacts('page_not_echoed')}, 502),
    says: [
      /Retrying the same request returns the same answer/,
      /Report these details to support, or narrow the request/,
    ],
  },
  // Package r12-fix, item 3: Snapchat's remedy for a stats answer whose timestamp AMCP refused, and X's for an entity whose parent
  // is in neither list. Both are deterministic refusals, and both name what failed in words (no snake_case name, which the page's
  // classifier takes for an MCP client's argument).
  snapchat: {
    source: {platform: 'snapchat', account_id: '1', connection_id: 'synthetic'},
    error: () =>
      new MirrorError(
        'REPORT_DATE_MISMATCH',
        'Snapchat returned an invalid native report timestamp.',
        {timestamp_field: 'finalized_data_end_time'},
        400,
      ),
    says: [
      /missing or invalid finalization time for its non-conversion data/,
      /Retrying the same report returns the same answer/,
      /Report these details to support\./,
    ],
  },
  x: {
    source: {platform: 'x', account_id: '1', connection_id: 'synthetic'},
    error: () =>
      new MirrorError(
        'REPORT_ACCOUNT_MISMATCH',
        'X did not list the line item of {count} of this account’s promoted tweets among the account’s own line items, so their ownership could not be proven.',
        {parent_kind: 'line item', entities_affected: 2},
        502,
        false,
        {count: 2},
      ),
    says: [
      /could not be found among the account’s own objects/,
      /This check protects ownership/,
      /Retrying will not help/,
    ],
  },
};

test('a provider remedy for a provider-data code, which the source card shows as written, is worded for people', () => {
  const agentDirected = page().run('agentDirected'),
    reaching = providerRemedies.filter(rule => [...providerDataCodes].some(code => remedyNamesCode(rule.codes, code)));
  // Today these are LinkedIn's rule for an empty answer and TikTok's for a page-count refusal; a provider that adds another is
  // held to the same rule.
  assert.ok(reaching.length >= 2, 'rules that reach the card: ' + reaching.length);
  for (const rule of reaching)
    assert.equal(agentDirected(rule.remedy.action), false, 'Written for an MCP client: ' + rule.remedy.action);
});

for (const locale of ['en', 'ar'])
  for (const [name, c] of Object.entries(cases))
    test(`${locale}: ${name}'s remedy reaches the source card and the evidence page as written, in no MCP client's words`, () => {
      const p = page(locale),
        agentDirected = p.run('agentDirected'),
        server = errorResult(c.error(), 'synthetic-reference-0001', 0),
        remedy = server.error.remedy.action,
        shown = locale === 'ar' ? catalog[remedy] : remedy;
      assert.ok(shown, 'a remedy to show' + (locale === 'ar' ? ' (Arabic missing)' : ''));
      for (const pattern of c.says) assert.match(remedy, pattern);
      // The classifier of the page itself: this text is for a person, so neither page replaces it.
      assert.equal(agentDirected(remedy), false, 'Written for an MCP client: ' + remedy);
      // Path 1: the Reporting Overview's source card, from the diagnostic the server builds for the source.
      const diagnostic = JSON.parse(JSON.stringify(reportSourceError(c.error(), c.source)));
      assert.equal(diagnostic.next_action, remedy, 'the card carries the remedy');
      const card = p.run('renderSourceDiagnostic')(diagnostic);
      assert.ok(card.includes('<p class="source-next-action">' + esc(shown) + '</p>'), card);
      // Path 2: the evidence page's feedback after capture_preset, from the refusal as the website receives it.
      const error = p.context.requestError(server),
        parts = p.context.errorParts(error),
        text = p.context.errorMessage(error);
      assert.equal(parts.remedy, shown, 'the page shows the remedy, not the wording of its category');
      assert.ok(text.includes(shown));
      // Not the report category's fallback ("Narrow it ... or try again later"), whatever the remedy says to do.
      const fallback = p.run('websiteCategoryRemedies').report;
      assert.equal(
        text.includes(locale === 'ar' ? catalog[fallback] : fallback),
        false,
        'the category fallback is shown',
      );
      assert.equal(agentDirected(parts.remedy), false);
      if (name === 'linkedin') {
        // The remedy says to widen the window: no page may tell the person to narrow it, or to retry.
        assert.doesNotMatch(card + ' ' + text, /Narrow|Retry the report|try again later/i);
        assert.equal(/ضيّق|ضيق/.test(card + ' ' + text), false, 'Arabic: no advice to narrow');
      } else {
        // A refusal a retry cannot help never reads "try again later".
        assert.doesNotMatch(card + ' ' + text, /try again later|Retry the report/i);
      }
    });
