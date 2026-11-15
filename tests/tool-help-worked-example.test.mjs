import test from 'node:test';
import assert from 'node:assert/strict';
import {planExample} from '../dist/src/campaign-step-help.js';
import {harness, operator} from './helpers/campaign-step-fixture.mjs';

/**
 * Round 2.5 M0, merge task 2 (r25-m0-review's review, S4-6): the worked example of a plan was reachable only from
 * `amcp_campaign help topic:"create"`, while the placeholder notes inside it send an agent to `amcp_tool_help`, and
 * `amcp_tool_help {gateway:"amcp_campaign", operation:"create"}` did not carry it. Both routes now answer from one table
 * (src/tool-help.ts), with the additions r25-m0-live made for capture_preset and the preview links. Every value is synthetic.
 */
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const viaToolHelp = (f, input) => f.service.call('amcp_tool_help', input, operator);
const viaOwnHelp = (f, topic) => f.call({action: 'help', ...(topic ? {topic} : {})});

test('amcp_tool_help for create answers the very worked example that amcp_campaign help create answers', async t => {
  const f = harness(t),
    own = await viaOwnHelp(f, 'create'),
    through = await viaToolHelp(f, {gateway: 'amcp_campaign', operation: 'create'});
  assert.equal(own.success, true, JSON.stringify(own.error));
  assert.equal(through.success, true, JSON.stringify(through.error));
  // The same example, and the module's own: neither route keeps a copy of its own that could drift.
  assert.ok(through.data.worked_example, 'the tool-help answer carries a worked_example');
  assert.deepEqual(through.data.worked_example, own.data.worked_example);
  assert.deepEqual(through.data.worked_example, planExample);
  // It is the plan, not a stub: a create call whose steps depend on one another and name their placeholders.
  const example = through.data.worked_example;
  assert.equal(example.tool, 'amcp_campaign');
  assert.equal(example.arguments.action, 'create');
  assert.ok(example.arguments.steps.length >= 2);
  assert.deepEqual(example.arguments.steps[1].depends_on, [example.arguments.steps[0].id]);
  assert.ok(Object.keys(example.placeholders).length >= 5);
  assert.equal(f.requests(), 0);
});

test('each route answers with a copy no caller can change', async t => {
  const f = harness(t);
  const first = await viaToolHelp(f, {gateway: 'amcp_campaign', operation: 'create'});
  first.data.worked_example.arguments.name = 'Changed by a caller';
  first.data.worked_example.arguments.steps.length = 0;
  for (const answer of [
    await viaToolHelp(f, {gateway: 'amcp_campaign', operation: 'create'}),
    await viaOwnHelp(f, 'create'),
  ]) {
    assert.equal(answer.data.worked_example.arguments.name, 'Autumn launch');
    assert.equal(answer.data.worked_example.arguments.steps.length, 2);
  }
  assert.equal(planExample.arguments.name, 'Autumn launch', 'the module’s example is untouched');
});

test('no other help gets the plan’s worked example, by either route', async t => {
  const f = harness(t);
  // Another action of the same tool, the tool’s own root, and a first-party tool that has additions of its own.
  for (const operation of [undefined, 'get', 'approve', 'recover_step', 'validate_provider']) {
    const through = await viaToolHelp(f, {gateway: 'amcp_campaign', ...(operation ? {operation} : {})});
    assert.equal(through.success, true, operation + ' ' + JSON.stringify(through.error));
    assert.equal(through.data.worked_example, undefined, 'amcp_tool_help ' + operation);
    const own = await viaOwnHelp(f, operation);
    assert.equal(own.success, true, operation + ' ' + JSON.stringify(own.error));
    assert.equal(own.data.worked_example, undefined, 'amcp_campaign help ' + operation);
  }
  const reporting = await viaToolHelp(f, {gateway: 'amcp_reporting', operation: 'capture_preset'});
  assert.equal(reporting.success, true, JSON.stringify(reporting.error));
  assert.equal(reporting.data.worked_example, undefined);
  assert.ok(Array.isArray(reporting.data.worked_examples), 'capture_preset keeps its own worked calls');
  const previews = await viaToolHelp(f, {gateway: 'amcp_ad_previews'});
  assert.equal(previews.success, true, JSON.stringify(previews.error));
  assert.equal(previews.data.worked_example, undefined);
  assert.ok(previews.data.link_access, 'the preview help keeps its link_access note');
});

test('the tool-help answer for create stays within the 40 KB help budget', async t => {
  const f = harness(t),
    through = await viaToolHelp(f, {gateway: 'amcp_campaign', operation: 'create'});
  assert.ok(bytes(through) <= 40000, 'amcp_tool_help create bytes: ' + bytes(through));
});
