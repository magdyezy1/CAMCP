// P2B-05 (differential review, wave 5 round 2 part 2b): the `redacted` field that an inspect or prepare answer carries (the path of
// each value its request or before_state hides, since P2A-02) was described nowhere, so a client could not tell it from noise. It is
// described in the help of amcp_write, in the topic of each of the two actions, and never in the tools/list listing: the listing's
// size is pinned by the gates (tools/measure-tool-list.mjs) and by tests/tool-surface-golden.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {NativeTransport} from '../dist/src/transport.js';
import {MirrorService} from '../dist/src/service.js';

const actor = {tenantId: 'write-help', userId: 'operator', role: 'operator'};
function fixture(t, allowWrites = true) {
  const store = new Store(':memory:', Buffer.alloc(32, 41).toString('base64'));
  t.after(() => store.close());
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => Response.json({})),
    undefined,
    {
      allowWrites,
      maxBudgetChange: 0,
      requireBeforeState: true,
    },
  );
  return {
    service,
    help: topic => service.call('amcp_write', {action: 'help', topic}, actor),
    discovery: operation => service.call('amcp_tool_help', {gateway: 'amcp_write', operation}, actor),
  };
}
/** Where a help topic of an action keeps its argument note: in `arguments`, and again in the contract's own schema. */
const notesOf = (data, argument) => [
  data.arguments[argument].description,
  data.contract.arguments_schema.properties[argument].description,
];
/** What the help must tell a client about the field, in any wording that says all of it. */
function assertDescribesRedacted(description, label) {
  assert.equal(typeof description, 'string', label + ' has no note');
  assert.match(description, /\bredacted\b/, label + ' names the field');
  assert.match(description, /path of each value hidden/i, label + ' says what an entry is');
  assert.match(description, /never the value/i, label + ' says that a value is never in it');
  assert.match(description, /credential-shaped/i, label + ' says which values are hidden');
  assert.match(description, /absent when nothing/i, label + ' says when the field is missing');
  assert.match(description, /frozen request keeps every value whole/i, label + ' says that only the answer hides them');
}

test('the help of inspect and prepare describes `redacted`: what it lists, that it never holds a value, and when it is absent (P2B-05)', async t => {
  const f = fixture(t);
  for (const topic of ['inspect', 'prepare']) {
    const help = await f.help(topic);
    assert.equal(help.success, true, topic + ': ' + JSON.stringify(help.error));
    for (const note of notesOf(help.data, 'arguments')) assertDescribesRedacted(note, topic);
  }
});

test('the help of prepare names the root of a before_state path, and the same help is served through amcp_tool_help (P2B-05)', async t => {
  const f = fixture(t),
    root = '$["before_state"]';
  for (const [label, help] of [
    ['help topic', await f.help('prepare')],
    ['amcp_tool_help', await f.discovery('prepare')],
  ]) {
    assert.equal(help.success, true, label + ': ' + JSON.stringify(help.error));
    for (const note of notesOf(help.data, 'arguments')) {
      assertDescribesRedacted(note, label);
      assert.ok(note.includes(root), label + ' names the before_state root of a path');
    }
  }
  const inspect = await f.discovery('inspect');
  for (const note of notesOf(inspect.data, 'arguments')) assertDescribesRedacted(note, 'amcp_tool_help inspect');
});

test('a read-only deployment, which lists inspect only, describes `redacted` in the help of inspect too (P2B-05)', async t => {
  const f = fixture(t, false),
    help = await f.help('inspect');
  assert.equal(help.success, true, JSON.stringify(help.error));
  for (const note of notesOf(help.data, 'arguments')) assertDescribesRedacted(note, 'read-only inspect');
});

test('the tools/list listing of amcp_write does not describe `redacted`: the help does, the listing does not grow (P2B-05)', t => {
  for (const allowWrites of [true, false]) {
    const f = fixture(t, allowWrites),
      listed = f.service.listTools().find(tool => tool.name === 'amcp_write');
    assert.ok(listed, 'amcp_write is listed');
    assert.doesNotMatch(JSON.stringify(listed), /redacted/i, 'allowWrites ' + allowWrites);
  }
});
