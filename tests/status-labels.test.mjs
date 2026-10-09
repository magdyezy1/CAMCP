// WEB-05: Arabic pages showed AMCP's own state words ("implemented unverified", "unknown", "incomplete") and the Home
// capability block in English, and AMCP-authored error guidance rendered untranslated. These tests guard that every
// first-party state value has a label with an Arabic entry, that the Home and reporting vocabulary stays in step with
// the server, and that provider messages are never translated.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';
import {workspaceCapabilities} from '../dist/src/capabilities.js';
import {reportPlatforms} from '../dist/src/report-metrics.js';

const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));

/** localization.js and workspace.js (and optionally capability-center.js) in a page with the given language. */
function page(locale, {capabilityCenter = false} = {}) {
  const content = {innerHTML: ''},
    calls = [];
  const context = createContext({
    URL,
    Map,
    Set,
    Intl,
    content,
    document: {addEventListener() {}, querySelector: () => null, querySelectorAll: () => []},
    esc: value =>
      String(value ?? '').replace(
        /[&<>"']/g,
        c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c],
      ),
    date: value => String(value),
    workHome: () => '',
    workspaceBind() {},
    navigationGeneration: 1,
    identityGeneration: 1,
    calls,
  });
  const run = source => new Script(source).runInContext(context);
  run(fs.readFileSync('web/localization.js', 'utf8'));
  run(fs.readFileSync('web/workspace.js', 'utf8'));
  if (capabilityCenter) run(fs.readFileSync('web/capability-center.js', 'utf8'));
  context.catalog = catalog;
  if (locale === 'ar') run("uiLocale='ar'; uiMessages=new Map(Object.entries(catalog))");
  return {run, context, content};
}
const literals = text => [...text.matchAll(/'([a-z][a-z_]*)'/g)].map(m => m[1]);

/** First-party state values, read from the server sources that assign them and from the website's own badges. */
function firstPartyStates() {
  const values = new Set();
  // The workflow outcome classifier lists every state AMCP's first-party tools report.
  const outcomes = fs.readFileSync('src/workflow-outcomes.ts', 'utf8');
  for (const m of outcomes.matchAll(/\[((?:'[a-z_]+',?\s*)+)\]\.includes\(raw\)/g))
    for (const v of literals(m[1])) values.add(v);
  // Capability implementation states and scenario evidence states.
  for (const v of literals(/implementation: ('[a-z_]+')/.exec(fs.readFileSync('src/capabilities.ts', 'utf8'))[1]))
    values.add(v);
  const scenarios = /evidence_status:([\s\S]*?),\n/.exec(fs.readFileSync('src/report-scenarios.ts', 'utf8'))[1];
  for (const v of literals(scenarios)) values.add(v);
  // Literal states passed to badge() in the website (the second argument, an explicit label, is excluded).
  for (const file of fs.readdirSync('web').filter(name => name.endsWith('.js'))) {
    const source = fs.readFileSync('web/' + file, 'utf8');
    for (const m of source.matchAll(/\bbadge\(([^(),]*(?:\([^()]*\)[^(),]*)*)[,)]/g))
      for (const v of literals(m[1])) values.add(v);
  }
  return values;
}

test('every first-party state value has a label and an Arabic entry, and badges show it in both languages', () => {
  const states = firstPartyStates();
  for (const expected of ['implemented_unverified', 'unknown', 'incomplete', 'ready', 'blocked', 'review_ready'])
    assert.ok(states.has(expected), 'The state inventory reads ' + expected);
  assert.ok(states.size >= 30, 'The inventory covers the outcome classifier: ' + states.size);
  const english = page('en'),
    arabic = page('ar'),
    labels = english.run('statusLabels'),
    missing = [];
  for (const state of [...states].sort()) {
    if (!Object.hasOwn(labels, state)) {
      missing.push(state + ': no label in statusLabels');
      continue;
    }
    const label = labels[state];
    assert.match(label, /^[A-Z]/, state + ' has a sentence-case label');
    if (!Object.hasOwn(catalog, label)) missing.push(state + ': no Arabic entry for "' + label + '"');
    english.context.value = state;
    arabic.context.value = state;
    assert.ok(english.run('badge(value)').includes('>' + label + '</span>'), state);
    const shown = arabic.run('badge(value)').replace(/<[^>]+>/g, '');
    assert.doesNotMatch(shown, /[A-Za-z]/, state + ' badge is Arabic: ' + shown);
  }
  assert.deepEqual(missing, []);
  // A value without a label keeps its earlier spaced form instead of an empty badge.
  assert.match(english.run("badge('custom_state')"), />custom state<\/span>/);
});

test('every reviewed contract status has a capability label with an Arabic entry; required inputs use the locale list', () => {
  const union = /export type ContractStatus =([\s\S]*?);/.exec(fs.readFileSync('src/action-contracts.ts', 'utf8'))[1],
    statuses = literals(union),
    arabic = page('ar', {capabilityCenter: true}),
    labels = arabic.run('capabilityLabels');
  assert.ok(statuses.length >= 9);
  for (const status of statuses) {
    assert.ok(Object.hasOwn(labels, status), status);
    assert.ok(Object.hasOwn(catalog, labels[status]), labels[status]);
  }
  // Workflow states that are not capability vocabulary fall back to the shared status labels.
  assert.equal(arabic.run("capabilityLabel('implemented_unverified')"), catalog['Implemented, not live-verified']);
  assert.equal(arabic.run("capabilityLabel('constructor')"), 'constructor', 'Prototype names are not labels');
  assert.equal(arabic.run("uiList(['أ', 'ب', 'ج'])"), 'أ وب وج');
  assert.equal(page('en').run("uiList(['A', 'B', 'C'])"), 'A, B, and C');
});

test('the Home capability vocabulary and reporting workflow names match the server and have Arabic entries', () => {
  const server = workspaceCapabilities({documents: () => [], listConnections: () => []}, {tenantId: 'tenant-a'}),
    english = page('en', {capabilityCenter: true}),
    features = JSON.parse(english.run('JSON.stringify(capabilityFeatureLabels)')),
    capabilityLabels = JSON.parse(english.run('JSON.stringify(capabilityLabels)'));
  assert.deepEqual(
    Object.fromEntries(Object.entries(features).filter(([id]) => id !== 'meaning')),
    Object.fromEntries(server.features.map(f => [f.id, [f.name, f.coverage]])),
    'web/workspace.js capabilityFeatureLabels follows src/capabilities.ts',
  );
  assert.deepEqual(features.meaning, [server.meaning]);
  for (const text of [...Object.values(features).flat()]) assert.ok(Object.hasOwn(catalog, text), text);
  for (const [platform, provider] of Object.entries(reportPlatforms)) {
    assert.equal(capabilityLabels['report:' + platform], provider.name + ' reporting', platform);
    assert.equal(
      capabilityLabels['report-kind:' + provider.kind],
      provider.kind + ' context with native metric definitions and source evidence.',
      provider.kind,
    );
    assert.ok(Object.hasOwn(catalog, provider.name + ' reporting'), platform);
  }
});

test('Arabic Home renders the capability block in Arabic; English Home is unchanged', async () => {
  const server = workspaceCapabilities({documents: () => [], listConnections: () => []}, {tenantId: 'tenant-a'}),
    dashboard = {connections: [], campaigns: [], capabilities: server};
  for (const locale of ['ar', 'en']) {
    const view = page(locale);
    view.context.workspaceCall = async () => dashboard;
    await view.run('renderOverview()');
    const html = view.content.innerHTML,
      start = html.indexOf(
        '<h2>' + (locale === 'ar' ? catalog['Capabilities and evidence'] : 'Capabilities and evidence'),
      ),
      block = html.slice(start, html.indexOf('</section>', start));
    assert.ok(start > 0, locale);
    if (locale === 'en') {
      assert.ok(block.includes(server.meaning));
      for (const f of server.features) assert.ok(block.includes('<strong>' + f.name + '</strong><small>' + f.coverage));
      assert.ok(block.includes('>Implemented, not live-verified</span>'));
      continue;
    }
    // Tool names in <code>, the evidence JSON and product names stay literal; nothing else is Latin.
    const visible = block
      .replace(/<code>[\s\S]*?<\/code>/g, '')
      .replace(/<details[\s\S]*?<\/details>/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\b(?:Drive|UTMs?)\b/g, '');
    assert.doesNotMatch(visible, /[A-Za-z]{2,}/, visible);
  }
});

test('AMCP error guidance is translated while a provider message stays exactly as the provider wrote it', () => {
  const arabic = page('ar');
  arabic.context.owned = {
    code: 'REPORT_PERIODS_FAILED',
    message: 'Every calendar period failed for this source.',
    next_action: 'Review this source’s error, correct its connection or report settings, then retry.',
  };
  assert.deepEqual(JSON.parse(arabic.run('JSON.stringify(uiOwnedError(owned))')), {
    message: catalog['Every calendar period failed for this source.'],
    nextAction: catalog['Review this source’s error, correct its connection or report settings, then retry.'],
  });
  // The provider's own message is shown literally, even when it happens to equal an AMCP catalog key.
  arabic.context.provider = {
    code: 'PROVIDER_REPORT_FAILED',
    message: 'Every calendar period failed for this source.',
    provider: {code: '40002', message: 'Every calendar period failed for this source.'},
    next_action: 'Reconnect the affected provider account.',
  };
  assert.deepEqual(JSON.parse(arabic.run('JSON.stringify(uiOwnedError(provider))')), {
    message: 'Every calendar period failed for this source.',
    nextAction: catalog['Reconnect the affected provider account.'],
  });
  arabic.context.providerOnly = {code: 'X', message: 'AMCP wrapper text', provider: {code: '1'}};
  assert.equal(arabic.run('uiOwnedError(providerOnly).message'), 'AMCP wrapper text', 'No provider message: literal');
  assert.deepEqual(JSON.parse(arabic.run('JSON.stringify(uiOwnedError(null))')), {message: '', nextAction: ''});
});
