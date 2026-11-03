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
