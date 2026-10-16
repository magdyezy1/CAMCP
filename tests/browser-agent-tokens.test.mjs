import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createContext, Script} from 'node:vm';
import {agentTokenSource, messageSurfaces, technicalDisclosures} from '../tools/browser-agent-tokens.mjs';

/**
 * WEB-03 (browser QA): the rendered runner reads every message a person is shown (alerts, status regions, notices,
 * errors, toasts) and fails a case whose message names MCP-client vocabulary. Before, the run outcome printed
 * "execute_next with it continues the step" and a refusal "details.next_call", and only VM tests looked at strings.
 * This checks the vocabulary the probe refuses, that the website's own wording passes it, and that the runner applies
 * it at the initial, every intermediate and the final state of every case.
 */
const pattern = new RegExp(agentTokenSource);

test('the probe refuses MCP-client vocabulary and passes the website wording of every run stop and remedy', () => {
  for (const agent of [
    'Show the user this review; execute_next with it continues the step, then run continues the plan.',
    'Nothing was submitted. Prepare the same request again (details.next_call when present).',
    'Amend it with recover_step (next_call).',
    'Set confirmed: true to continue steps a, b in a new linked plan.',
    'Read it back with reconcile_step.',
  ])
    assert.match(agent, pattern, agent);
  // The page's own wording, as WEB-03 wrote it, run in the page's own presentation layer.
  const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
    app = fs.readFileSync('web/app.js', 'utf8'),
    context = createContext({Intl, Date, catalog, document: {addEventListener() {}}});
  const run = code => new Script(code).runInContext(context);
  run(fs.readFileSync('web/localization.js', 'utf8'));
  run('uiLocale = "en"; uiMessages = new Map();');
  run(app.slice(app.indexOf('function requestError('), app.indexOf("const content = $('#content')")));
  run(fs.readFileSync('web/campaign-workflows.js', 'utf8').replace(/^(?:[\s\S]*?)(?=const runStopLabels)/, ''));
  const wording = [
    ...run('websiteRemedies').map(([, text]) => text),
    ...Object.values(run('websiteCategoryRemedies')),
    ...Object.values(run('providerLayerRemedies')),
    ...Object.values(run('runStopLabels')),
    ...Object.values(run('runRecoveryLabels')),
    ...run('websiteSafetyFacts').map(([, text]) => text),
  ];
  assert.ok(wording.length > 60, String(wording.length));
  for (const text of wording) {
    assert.doesNotMatch(text, pattern, text);
    assert.doesNotMatch(catalog[text], pattern, 'Arabic of: ' + text);
  }
});

test('the rendered runner probes the initial, every intermediate and the final state, and leaves technical text out', () => {
  const source = fs.readFileSync('tools/browser-workflow-qa.mjs', 'utf8');
  assert.match(source, /import \{agentTokenProbe\} from '\.\/browser-agent-tokens\.mjs';/);
  assert.match(source, /result\.agent_token_messages = await agentTokenProbe\(page\);/);
  assert.match(source, /entry\.agent_token_messages = await agentTokenProbe\(page\);/);
  assert.match(source, /result\.agent_token_messages_final = await agentTokenProbe\(page\);/);
  // Every probe result must be empty, not merely recorded.
  assert.equal(
    source.match(/assert\.deepEqual\(\s*(?:result|entry)\.agent_token_messages(?:_final)?,\s*\[\]/g)?.length,
    3,
  );
  // The surfaces are where messages are shown; the server's exact text under Technical details and record details is
  // excluded, as the presentation layer keeps it there on purpose.
  for (const surface of ['[role=alert]', '[role=status]', '.notice', '.error', '#toast', '.run-outcome'])
    assert.ok(messageSurfaces.includes(surface), surface);
  assert.equal(technicalDisclosures, 'details.error-technical, details.workspace-details');
});
