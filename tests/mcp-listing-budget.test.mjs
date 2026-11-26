// V2-MCP-02: the listing (tools/list) was built to fit 97,280 bytes (95 KiB; the owner raised the limit to 256 KiB on
// 2026-11-23 and the listing is unchanged) and every typed field spends some of them. What the listing can do without
// is served by the action help instead: this file pins that the help still carries it, and what the listing keeps
// instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {routingSummaries} from '../dist/src/tool-summaries.js';

const actor = {tenantId: 'listing-budget', userId: 'owner', role: 'admin'};
function fixture(t, allowWrites = true) {
  const store = new Store(':memory:', Buffer.alloc(32, 71).toString('base64'));
  t.after(() => store.close());
  store.ensureTenant(actor.tenantId);
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw Error('No provider request is expected');
    }),
    undefined,
    {allowWrites, requireBeforeState: true, maxBudgetChange: 0},
  );
  return {
    service,
    listed: name => service.listTools().find(tool => tool.name === name),
    call: (tool, args) => service.call(tool, args, actor),
    help: (tool, topic) => service.call(tool, topic === undefined ? {action: 'help'} : {action: 'help', topic}, actor),
  };
}

test('the argument notes the listing no longer carries are served by the help of the action that reads them', async t => {
  const f = fixture(t),
    previews = f.listed('amcp_ad_previews'),
    workspace = f.listed('amcp_workspace');
  for (const name of ['ad_ids', 'campaign_ids', 'adset_ids', 'ad_format'])
    assert.equal(
      previews.inputSchema.properties[name].description,
      undefined,
      'amcp_ad_previews ' + name + ' in the listing',
    );
  assert.equal(workspace.inputSchema.properties.account_ids.description, undefined, 'account_ids in the listing');
  const previewHelp = await f.help('amcp_ad_previews'),
    notes = previewHelp.data.contract.arguments_schema.properties;
  assert.equal(previewHelp.success, true, JSON.stringify(previewHelp.error));
  assert.match(notes.ad_ids.description, /Snapchat and LinkedIn: creative IDs; Google Ads: asset group IDs/);
  assert.match(notes.ad_ids.description, /Named IDs ignore statuses/);
  assert.match(notes.campaign_ids.description, /LinkedIn campaign group IDs/);
  assert.match(notes.adset_ids.description, /Snapchat ad squad IDs; LinkedIn native campaign IDs/);
  assert.match(notes.ad_format.description, /Meta only: the placement to preview/);
  const check = await f.help('amcp_workspace', 'check');
  assert.equal(check.success, true, JSON.stringify(check.error));
  assert.match(check.data.arguments.account_ids.description, /up to 20 accounts of one connection_id/);
  assert.match(check.data.arguments.account_ids.description, /checked four at a time/);
});

test('every routing summary ends with one help pointer that is a call of the tool itself', () => {
  const pointer = 'Help: {action:"help"}; one action: {action:"help",topic:"<action>"}.';
  for (const [name, summary] of Object.entries(routingSummaries)) {
    assert.doesNotMatch(summary, /Full text:|action rules:/, name);
    if (name === 'amcp_ad_previews') assert.match(summary, /Help: \{action:"help"\}\.$/, name);
    else assert.ok(summary.includes(pointer), name + ' carries the pointer');
    // The pointer is a call of the tool the summary describes: it names no tool, so no tool is named twice for it.
    assert.equal(summary.includes(pointer.replace('Help:', 'Help: ' + name)), false, name);
  }
  assert.ok(routingSummaries.amcp_workspace.endsWith(pointer + ' Guides: {action:"help",topic:"guides"}.'));
});

test('the details the campaign, reporting and media summaries dropped are in the help of the action they belong to', async t => {
  const f = fixture(t);
  for (const [name, dropped] of [
    ['amcp_campaign', /live:true adds read-only account prerequisites/],
    ['amcp_campaign', /Get with step_id or detail:"full" returns more/],
    ['amcp_reporting', /a verified plan’s next closed period/],
    ['amcp_media', /request\.transform says what changed/],
  ])
    assert.doesNotMatch(routingSummaries[name], dropped, name);
  const eligibility = await f.help('amcp_campaign', 'recipe_eligibility');
  assert.match(eligibility.data.summary, /live:true adds read-only account prerequisites/);
  const get = await f.help('amcp_campaign', 'get');
  assert.match(get.data.arguments.detail.description, /full: the whole stored plan/);
  assert.ok(get.data.arguments.step_id);
  const outcome = await f.help('amcp_reporting', 'allocation_outcome');
  assert.match(outcome.data.detail ?? '', /next comparable closed period/);
  const prepare = await f.help('amcp_media', 'prepare');
  assert.match(prepare.data.arguments.fit_to_platform.description, /Fit the media to the platform before review/);
});
