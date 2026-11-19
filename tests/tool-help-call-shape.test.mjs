import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRefused} from './helpers/assert-refused.mjs';
import {harness, operator} from './helpers/campaign-step-fixture.mjs';

/**
 * Round 2.5 field fix, package r25-field-callshape (2026-11-19), item 5: amcp_write takes its gateway and connection beside its
 * arguments and the account inside them, while a plan step of amcp_campaign takes all three beside its arguments. The help of each
 * tool states the other's shape in one line, so that an agent that reads one help meets the shape it may have mixed up. It is help
 * data (`other_tool_shape`), never tools/list: tests/tool-surface-golden.test.mjs is unchanged.
 */
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const viaToolHelp = (f, input) => f.service.call('amcp_tool_help', input, operator);
const writeHelp = (f, topic) => f.service.call('amcp_write', {action: 'help', ...(topic ? {topic} : {})}, operator);
const campaignHelp = (f, topic) => f.call({action: 'help', ...(topic ? {topic} : {})});
const oneLine = text => typeof text === 'string' && text.length > 40 && text.length <= 420 && !/[\r\n]/.test(text);

test('amcp_write help prepare states amcp_campaign create’s shape in one line', async t => {
  const f = harness(t),
    help = await writeHelp(f, 'prepare');
  assert.equal(help.success, true, JSON.stringify(help.error));
  const line = help.data.other_tool_shape;
  assert.ok(oneLine(line), String(line));
  // The shape of a plan: the three in each step beside arguments, or once at the top level of create; amcp_write's own is the contrast.
  assert.match(line, /^amcp_campaign create takes /);
  for (const part of [
    'gateway',
    'connection_id',
    'account_id',
    'each step',
    'beside arguments',
    'top level of create',
    // Round 2: which steps the top level fills, and when (S3-2; a media step takes the connection and the account too).
    'for the steps that leave them out, when no step names another value',
  ])
    assert.ok(line.includes(part), 'the line names ' + part + ': ' + line);
  assert.match(line, /amcp_write takes gateway and connection_id at its top level and the account inside arguments/);
  assert.ok(bytes(help) <= 40000, 'help bytes: ' + bytes(help));
});

test('amcp_campaign help create states amcp_write prepare’s shape in one line', async t => {
  const f = harness(t),
    help = await campaignHelp(f, 'create');
  assert.equal(help.success, true, JSON.stringify(help.error));
  const line = help.data.other_tool_shape;
  assert.ok(oneLine(line), String(line));
  assert.match(line, /^amcp_write prepare takes /);
  for (const part of ['gateway', 'connection_id', 'top level', 'beside arguments'])
    assert.ok(line.includes(part), 'the line names ' + part + ': ' + line);
  // Round 2, S3-2: the account is not shown as one key for every gateway. The field is the one its gateway takes, with where to see it.
  assert.match(line, /the account inside arguments, in the field its gateway takes/);
  assert.match(line, /\{action, account_id, payload\} where it takes account_id/);
  assert.match(line, /amcp_tool_help with the gateway/);
  assert.doesNotMatch(
    line,
    /\(\{action, account_id, payload\}\)/,
    'the object with account_id is not offered for every gateway',
  );
  // The worked example of the same help is untouched.
  assert.equal(help.data.worked_example.tool, 'amcp_campaign');
  assert.ok(bytes(help) <= 40000, 'help bytes: ' + bytes(help));
});

test('amcp_tool_help answers the same line for each, as it answers the same worked example', async t => {
  const f = harness(t);
  for (const [gateway, own] of [
    ['amcp_write', await writeHelp(f, 'prepare')],
    ['amcp_campaign', await campaignHelp(f, 'create')],
  ]) {
    const through = await viaToolHelp(f, {gateway, operation: gateway === 'amcp_write' ? 'prepare' : 'create'});
    assert.equal(through.success, true, gateway + ' ' + JSON.stringify(through.error));
    assert.equal(through.data.other_tool_shape, own.data.other_tool_shape, gateway);
    assert.ok(oneLine(through.data.other_tool_shape), gateway);
  }
});

test('no other help carries a line about the other tool’s shape', async t => {
  const f = harness(t);
  for (const topic of [undefined, 'inspect', 'execute', 'status', 'reconcile']) {
    const own = await writeHelp(f, topic);
    assert.equal(own.success, true, 'amcp_write ' + topic + ' ' + JSON.stringify(own.error));
    assert.equal(own.data.other_tool_shape, undefined, 'amcp_write help ' + topic);
    const through = await viaToolHelp(f, {gateway: 'amcp_write', ...(topic ? {operation: topic} : {})});
    assert.equal(through.success, true, JSON.stringify(through.error));
    assert.equal(through.data.other_tool_shape, undefined, 'amcp_tool_help amcp_write ' + topic);
  }
  for (const topic of [undefined, 'get', 'approve', 'recover_step', 'validate_provider', 'clone', 'list']) {
    const own = await campaignHelp(f, topic);
    assert.equal(own.success, true, 'amcp_campaign ' + topic + ' ' + JSON.stringify(own.error));
    assert.equal(own.data.other_tool_shape, undefined, 'amcp_campaign help ' + topic);
    const through = await viaToolHelp(f, {gateway: 'amcp_campaign', ...(topic ? {operation: topic} : {})});
    assert.equal(through.success, true, JSON.stringify(through.error));
    assert.equal(through.data.other_tool_shape, undefined, 'amcp_tool_help amcp_campaign ' + topic);
  }
  // A first-party tool that has additions of its own keeps them and gains nothing.
  const reporting = await viaToolHelp(f, {gateway: 'amcp_reporting', operation: 'capture_preset'});
  assert.equal(reporting.success, true, JSON.stringify(reporting.error));
  assert.equal(reporting.data.other_tool_shape, undefined);
  assert.ok(Array.isArray(reporting.data.worked_examples));
});

test('each line is a copy no caller can change, and tools/list lists neither', async t => {
  const f = harness(t),
    first = await writeHelp(f, 'prepare'),
    sentence = first.data.other_tool_shape;
  first.data.other_tool_shape = 'Changed by a caller';
  assert.equal((await writeHelp(f, 'prepare')).data.other_tool_shape, sentence);
  // tools/list keeps its schemas and descriptions: neither line is in any listed tool.
  const listed = JSON.stringify(f.service.listTools());
  assert.ok(!listed.includes('other_tool_shape'));
  assert.ok(!listed.includes(sentence));
  assert.ok(!listed.includes((await campaignHelp(f, 'create')).data.other_tool_shape));
});

// ---- round 2, S3-2: the field the line sends an agent to, for one gateway of each kind ----

/** [kind, gateway, the operation of a delegated gateway, whether its call takes account_id, the field amcp_tool_help shows for the account]. */
const accountKinds = [
  ['takes account_id', 'meta_native_action', undefined, true, 'account_id'],
  ['names it customer_id', 'google_ads_native_action', undefined, true, 'customer_id'],
  ['names it advertiser_id', 'tiktok_native_action', undefined, true, 'advertiser_id'],
  ['names it ad_account_id', 'snapchat_native_action', undefined, true, 'ad_account_id'],
  ['refuses account_id (a path parameter)', 'dv360_native_action', undefined, false, 'advertiserId'],
  ['refuses account_id (a delegated operation)', 'ga4_native_action', 'ga4_run_report', false, 'property'],
];

test('the account field the line sends an agent to is the one amcp_tool_help shows, for one gateway of each kind', async t => {
  const f = harness(t);
  for (const [kind, gateway, operation, takes, field] of accountKinds) {
    // "where it takes account_id": the runner's own rule for the gateways and operations that take it.
    assert.equal(f.service.registry.acceptsArgument(gateway, 'account_id', operation), takes, kind);
    // "amcp_tool_help with the gateway shows the field" (and with the operation, for a delegated gateway).
    const help = await viaToolHelp(f, {gateway, ...(operation ? {operation} : {})});
    assert.equal(help.success, true, kind + ' ' + JSON.stringify(help.error));
    assert.ok(JSON.stringify(help).includes(field), kind + ': amcp_tool_help shows ' + field);
  }
  // A gateway that does not take account_id refuses it inside amcp_write's arguments, and names it: the object with account_id is
  // not universal, which is why the line says where the field of the caller's own gateway is shown.
  const refusing = {
    dv360_native_action: {action: 'DV360_ADVERTISERS_AD_ASSETS_CREATE', account_id: '123', payload: {}},
    ga4_native_action: {operation: 'ga4_run_report', account_id: '123', arguments: {}},
  };
  for (const [gateway, args] of Object.entries(refusing)) {
    const refused = await f.service.call('amcp_write', {action: 'inspect', gateway, arguments: args}, operator);
    assertRefused(refused, 'INVALID_ARGUMENT', {message: /account_id/});
    assert.equal(refused.error.details.field, 'account_id', gateway);
  }
  assert.equal(f.requests(), 0);
});
