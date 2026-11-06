// V2-MCP-01: authored routing summaries expose every required confirmation and its least role.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {firstPartyContract, toolActions, authoredArguments} from '../dist/src/first-party-contracts.js';
import {routingSummaries, routingSummary, descriptionBudget} from '../dist/src/tool-summaries.js';

function tools(t, allowWrites = true) {
  const store = new Store(':memory:', Buffer.alloc(32, 70).toString('base64'));
  t.after(() => store.close());
  return new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw Error('No provider reads');
    }),
    undefined,
    {allowWrites, requireBeforeState: true, maxBudgetChange: 0},
  ).firstPartyTools();
}
test('each routing summary names every confirmed action with its least role in the same sentence', t => {
  for (const [readOnly, listed] of [
    [false, tools(t)],
    [true, tools(t, false)],
  ])
    for (const tool of listed) {
      const summary = routingSummary(tool.name, readOnly) ?? tool.description,
        sentences = summary.split(/(?<=[.!?])\s+/);
      for (const action of toolActions(tool)) {
        const row = firstPartyContract(tool, action);
        if (!row.argumentsSchema.required.includes('confirmed')) continue;
        assert.ok(authoredArguments(tool.name, action).includes('confirmed'));
        assert.ok(
          sentences.some(
            sentence =>
              new RegExp('\\b' + action + '\\b').test(sentence) &&
              sentence.includes('confirmed:true') &&
              new RegExp('\\b' + row.requires_role + '\\b').test(sentence),
          ),
          tool.name + ' ' + action + ' needs confirmed:true and ' + row.requires_role,
        );
      }
    }
  for (const [tool, summary] of Object.entries(routingSummaries))
    assert.ok(summary.length <= descriptionBudget, tool + ' ' + summary.length);
});
/**
 * The "Confirmation: confirmed:true for a, b (role); c (role)." clause of a summary, as action -> role. The sentence test
 * above passes for any action whose own sentence names its role somewhere, so it cannot see an action filed under
 * another action's role group; this reads the groups themselves (F-L3-07).
 */
function confirmationGroups(label, summary) {
  const clause = /Confirmation: confirmed:true for ([^.]*)\./.exec(summary),
    claimed = new Map();
  if (!clause) return claimed;
  for (const group of clause[1].split(/;\s*/)) {
    const parsed = /^(.*)\s\((\w+)\)$/.exec(group);
    assert.ok(parsed, label + ': a confirmation group ends with its role in brackets: ' + group);
    for (const action of parsed[1].split(/,\s*/)) {
      assert.ok(!claimed.has(action), label + ' names ' + action + ' in two groups');
      claimed.set(action, parsed[2]);
    }
  }
  return claimed;
}
/** Every way a summary's confirmation groups differ from the contract rows of the tool's actions. */
function confirmationFindings(tool, summary) {
  const claimed = confirmationGroups(tool.name, summary),
    truth = new Map(),
    findings = [];
  for (const action of toolActions(tool).filter(a => a !== null)) {
    const row = firstPartyContract(tool, action);
    if (row.argumentsSchema.required.includes('confirmed')) truth.set(action, row.requires_role);
  }
  for (const [action, role] of truth) {
    if (!claimed.has(action)) findings.push(action + ' needs confirmed:true (' + role + ') and is not named');
    else if (claimed.get(action) !== role)
      findings.push(action + ' is listed under ' + claimed.get(action) + ' but its contract requires ' + role);
  }
  for (const action of claimed.keys())
    if (!truth.has(action)) findings.push(action + ' is listed but its contract does not require confirmed');
  return findings;
}
test('each routing summary lists its confirmed actions under the least role their contracts require', t => {
  for (const [readOnly, listed] of [
    [false, tools(t)],
    [true, tools(t, false)],
  ])
    for (const tool of listed)
      assert.deepEqual(
        confirmationFindings(tool, routingSummary(tool.name, readOnly) ?? tool.description),
        [],
        tool.name + (readOnly ? ' (read-only)' : ''),
      );
});
test('a confirmed action filed under another role group, left out, or invented is found', t => {
  const workspace = tools(t).find(tool => tool.name === 'amcp_workspace'),
    summary = routingSummary('amcp_workspace');
  assert.deepEqual(confirmationFindings(workspace, summary), []);
  const misfiled = summary
    .replace('resume_report_run, ', '')
    .replace('save_spend_policy, ', 'resume_report_run, save_spend_policy, ');
  assert.notEqual(misfiled, summary);
  assert.deepEqual(confirmationFindings(workspace, misfiled), [
    'resume_report_run is listed under owner but its contract requires operator',
  ]);
  assert.deepEqual(confirmationFindings(workspace, summary.replace('resume_report_run, ', '')), [
    'resume_report_run needs confirmed:true (operator) and is not named',
  ]);
  assert.deepEqual(confirmationFindings(workspace, summary.replace(' (owner)', ', invented_action (owner)')), [
    'invented_action is listed but its contract does not require confirmed',
  ]);
});
test('the overview summary names every action of the tool, and its reads are exactly the actions that need no confirmation', t => {
  const overview = tools(t).find(tool => tool.name === 'amcp_reporting_overview'),
    summary = routingSummary(overview.name),
    named = action => new RegExp('(^|[^A-Za-z0-9_])' + action + '($|[^A-Za-z0-9_])').test(summary);
  for (const action of toolActions(overview).filter(a => a !== null && a !== 'help')) assert.ok(named(action), action);
  const reads = /Reads: ([^.]*)\./.exec(summary)?.[1].split(/,\s*/) ?? [],
    unconfirmed = toolActions(overview).filter(
      a =>
        a !== null && a !== 'help' && !firstPartyContract(overview, a).argumentsSchema.required.includes('confirmed'),
    );
  assert.deepEqual([...reads].sort(), [...unconfirmed].sort());
});
test('the previews summary names media in its first two sentences and declares the selection inputs', t => {
  const summary = routingSummaries.amcp_ad_previews;
  assert.equal(typeof summary, 'string');
  assert.match(
    summary
      .split(/(?<=[.!?])\s+/)
      .slice(0, 2)
      .join(' '),
    /amcp_media/,
  );
  const preview = tools(t).find(tool => tool.name === 'amcp_ad_previews');
  for (const argument of [
    'platform',
    'account_id',
    'ad_ids',
    'statuses',
    'campaign_ids',
    'adset_ids',
    'limit',
    'cursor',
  ]) {
    assert.ok(summary.includes(argument), argument);
    assert.ok(Object.hasOwn(preview.inputSchema.properties, argument), argument);
  }
  assert.match(summary, /default 5/);
  assert.match(summary, /10/);
  // Task21 introduces the optional action enum; its own-help suite validates the pointer once it is listed.
  if (preview.inputSchema.properties.action?.enum?.includes('help')) assert.match(summary, /action:\s*"help"/);
});
test('the create_spreadsheet and capture_preset contracts match the required handler inputs', t => {
  const listed = tools(t),
    sheet = firstPartyContract(
      listed.find(tool => tool.name === 'amcp_reporting_overview'),
      'create_spreadsheet',
    );
  assert.equal(sheet.requires_role, 'admin');
  for (const name of ['name', 'idempotency_key', 'confirmed'])
    assert.ok(sheet.argumentsSchema.required.includes(name), name);
  const capture = firstPartyContract(
    listed.find(tool => tool.name === 'amcp_reporting'),
    'capture_preset',
  );
  assert.ok(capture.argumentsSchema.required.includes('semantics'));
});
