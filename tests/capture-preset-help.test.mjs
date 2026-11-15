// Package r25-m0-live (Round 2.5, item 6: observation 7 of the live checks of 2026-11-15). It took six failed calls to learn
// the keys of capture_preset's `semantics` (dates, timezone, currency, complete, attribution, source_name), because the help
// did not list them. The help of amcp_reporting capture_preset now lists every key with its rule (in the argument's own
// description), and carries one worked call for each platform whose guided presets it serves, with the rules of that
// platform that the call keeps. Each platform declares its own (`GuidedReporting.help`, src/<platform>-guided-reports.ts);
// the shared help only assembles them. These tests run every worked call through the real checks of the capture (the
// argument contract, the preset's own request checks, and the capture's semantics and mapping checks up to the connection),
// so an example that drifts from the code fails here. No provider is reached. The help is for MCP clients and has no Arabic
// (tools/list is unchanged: tests/tool-surface-golden.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionArgumentFindings} from '../dist/src/first-party-contracts.js';
import * as presets from '../dist/src/report-presets.js';
import {assertRefused} from './helpers/assert-refused.mjs';

const actor = {tenantId: 'synthetic-preset-help', userId: 'reader', role: 'admin'};
const bytes = value => Buffer.byteLength(JSON.stringify(value));
function fixture(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 79).toString('base64'));
  t.after(() => store.close());
  let requests = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      requests++;
      throw new Error('help and refused captures reach no provider');
    }),
  );
  return {
    requests: () => requests,
    tool: () => service.firstPartyTools().find(tool => tool.name === 'amcp_reporting'),
    call: input => service.call('amcp_reporting', input, actor),
    help: topic => service.call('amcp_reporting', {action: 'help', topic}, actor),
  };
}
const platforms = ['google', 'meta', 'tiktok', 'snapchat', 'linkedin'];

test('capture_preset help carries one worked call for each platform that has guided presets, built from the day it is asked', async t => {
  // The help is built from the clock at the moment it is asked. The instants around the ask say which day that was, so a run
  // across midnight UTC compares with the day the help used, not with a clock read later (S4-5 of the lead's review).
  const f = fixture(t),
    before = new Date(),
    help = await f.help('capture_preset'),
    after = new Date();
  assert.equal(help.success, true, JSON.stringify(help.error));
  const examples = help.data.worked_examples;
  const moment = [before, after].find(instant =>
    isDeepStrictEqual(presets.capturePresetHelp(instant).worked_examples, examples),
  );
  assert.ok(moment, 'the help is the one of the moment it was asked');
  assert.deepEqual(examples.map(example => example.platform).sort(), [...platforms].sort());
  const day = offset => new Date(moment.getTime() - offset * 86400000).toISOString().slice(0, 10);
  for (const example of examples) {
    assert.equal(example.call.tool, 'amcp_reporting', example.platform);
    const args = example.call.arguments;
    assert.equal(args.action, 'capture_preset');
    assert.ok(args.preset.startsWith(example.platform + '_'), example.platform + ' ' + args.preset);
    // Closed days in the past, whatever day the help is read.
    assert.equal(args.semantics.date_to, day(2), example.platform);
    assert.equal(args.semantics.date_from, day(8), example.platform);
    assert.ok(
      Array.isArray(example.rules) && example.rules.length > 0 && example.rules.every(rule => typeof rule === 'string'),
    );
  }
  assert.equal(f.requests(), 0);
});

test('every worked call passes the real checks of the capture: the contract, the preset, and the semantics up to the connection', async t => {
  const f = fixture(t),
    examples = (await f.help('capture_preset')).data.worked_examples;
  for (const example of examples) {
    const input = example.call.arguments,
      label = example.platform + ' ' + input.preset;
    // 1. The argument contract of the action: nothing it does not read, no value its schema refuses.
    assert.deepEqual(actionArgumentFindings(f.tool(), input), [], label);
    // 2. The preset's own request checks (the shared ones, then the platform's), which the capture makes first.
    assert.doesNotThrow(() => presets.reportPreset(input), label);
    // 3. The whole capture, which checks the semantics and the mapping before it looks for the connection: no connection is
    // saved here, so the call must end exactly there, and nowhere an argument could have been refused.
    assertRefused(await f.call(input), 'CONNECTION_REQUIRED');
  }
  assert.equal(f.requests(), 0);
});

test('an example that drifts from the code is caught: the calls fail the same checks once a rule they keep is broken', async t => {
  const f = fixture(t),
    examples = (await f.help('capture_preset')).data.worked_examples,
    by = platform => examples.find(example => example.platform === platform).call.arguments;
  const broken = (platform, change) => ({...by(platform), semantics: {...by(platform).semantics, ...change}});
  // TikTok and Snapchat take a window only when it is declared complete.
  assertRefused(await f.call(broken('tiktok', {complete: undefined})), 'INVALID_DATE_RANGE');
  assertRefused(await f.call(broken('snapchat', {complete: false})), 'INVALID_ARGUMENT');
  // LinkedIn's dates are UTC.
  assertRefused(await f.call(broken('linkedin', {timezone: 'Asia/Riyadh'})), 'INVALID_ARGUMENT');
  // A date that is not a date.
  assertRefused(await f.call(broken('meta', {date_from: 'last week'})), 'INVALID_DATE_RANGE');
  assert.equal(f.requests(), 0);
});

test('the help of the semantics argument names every key the capture accepts, and no key it refuses', async t => {
  const f = fixture(t),
    help = await f.help('capture_preset'),
    note = help.data.arguments.semantics.description;
  assert.equal(note, help.data.contract.arguments_schema.properties.semantics.description);
  // The keys the code accepts, from its own refusal of one it does not.
  const example = (await f.help('capture_preset')).data.worked_examples.find(item => item.platform === 'tiktok'),
    refused = await f.call({
      ...example.call.arguments,
      semantics: {...example.call.arguments.semantics, not_a_key: 'x'},
    });
  assertRefused(refused, 'INVALID_ARGUMENT', {message: /^Unsupported semantics field: not_a_key\./});
  const accepted = refused.error.details.accepted;
  assert.ok(accepted.includes('date_from') && accepted.includes('complete'), JSON.stringify(accepted));
  for (const key of accepted) assert.ok(new RegExp('\\b' + key + '\\b').test(note), key + ' is named by the help');
  // The one the preset sets itself is said to be left out, not offered as a key to send.
  assert.match(note, /conversion_definition[^.]*\bleave it out\b/);
  // Each key comes with its rule.
  for (const rule of [/YYYY-MM-DD/, /IANA/, /3-letter ISO/, /unknown/, /1 to 200 characters/, /true/])
    assert.match(note, rule);
});

// S3-1 of the lead's review: the note rides in the contract of every action that reads `semantics`, which are capture and
// capture_preset. Only the guided collectors compare a declared timezone and currency with the account (TikTok, Meta, Google
// Ads and Snapchat, after they read it); a generic capture sends the caller's own native read, reads no account, and checks the
// form of each value (src/decision-reporting.ts semantic()). The note must not say of capture what only capture_preset does.
test('the semantics note says which action checks timezone and currency against the account: capture_preset does, capture keeps them as declared', async t => {
  const f = fixture(t);
  const notes = new Map();
  for (const action of ['capture', 'capture_preset']) {
    const help = await f.help(action);
    assert.equal(help.success, true, action + ' ' + JSON.stringify(help.error));
    notes.set(action, help.data.arguments.semantics.description);
  }
  // The note is one text for both actions, so what it says of the check is true of each.
  assert.equal(notes.get('capture'), notes.get('capture_preset'));
  for (const [action, note] of notes) {
    assert.match(
      note,
      /timezone: the IANA name of the platform account’s own timezone \(UTC for LinkedIn\); capture_preset checks it against the account, capture keeps it as declared\./,
      action,
    );
    assert.match(
      note,
      /currency: the account’s 3-letter ISO currency code in capitals; capture_preset checks it against the account, capture keeps it as declared\./,
      action,
    );
    // Nothing is said to be checked against the account without naming the action that checks it.
    assert.doesNotMatch(note, /checked against the account/, action);
  }
  assert.equal(f.requests(), 0);
});

test('the help stays within its response budget and leaves tools/list alone', async t => {
  const f = fixture(t),
    help = await f.help('capture_preset');
  assert.ok(bytes(help) <= 40000, 'capture_preset help bytes: ' + bytes(help));
  // The same help through the tool-help call, which serves every first-party tool's actions.
  const viaToolHelp = await new MirrorService(
    new Registry(),
    new Store(':memory:', Buffer.alloc(32, 80).toString('base64')),
    new NativeTransport(async () => {
      throw new Error('no provider request');
    }),
  ).call('amcp_tool_help', {gateway: 'amcp_reporting', operation: 'capture_preset'}, actor);
  assert.equal(viaToolHelp.success, true, JSON.stringify(viaToolHelp.error));
  assert.deepEqual(viaToolHelp.data.worked_examples.map(example => example.platform).sort(), [...platforms].sort());
  assert.ok(bytes(viaToolHelp) <= 40000, 'tool-help bytes: ' + bytes(viaToolHelp));
});

test('the worked calls are built from the platforms’ own declarations, so a fixed day yields fixed text', () => {
  const at = presets.capturePresetHelp(new Date('2026-11-15T12:00:00Z')),
    again = presets.capturePresetHelp(new Date('2026-11-15T23:59:59Z'));
  assert.deepEqual(at, again, 'the same day, the same help');
  const tiktok = at.worked_examples.find(example => example.platform === 'tiktok');
  assert.equal(tiktok.call.arguments.semantics.date_to, '2026-11-13');
  assert.equal(tiktok.call.arguments.semantics.date_from, '2026-11-07');
  assert.notDeepEqual(presets.capturePresetHelp(new Date('2026-12-15T12:00:00Z')), at);
});
