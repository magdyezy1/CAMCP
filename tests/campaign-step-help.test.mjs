import test from 'node:test';
import assert from 'node:assert/strict';
import {planReference} from '../dist/src/workspace-core.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {CONNECTION, fill, harness, placeholdersOf, step} from './helpers/campaign-step-fixture.mjs';

/**
 * Round 2.5, package r25-m0-review, T4 (the owner's General 3): the shape of the steps of amcp_campaign create was
 * learned only by failing. help create now carries a worked example, and the refusals of create point at it. tools/list
 * keeps its one untyped steps array: the example and the shape live in help. Every value here is synthetic.
 */
const bytes = value => Buffer.byteLength(JSON.stringify(value));
// The real values the example's placeholders stand for, in a workspace that has one Meta login.
const real = {
  '<gateway>': 'meta_native_action',
  '<connection_id>': CONNECTION,
  '<account_id>': '123',
  '<campaign create action>': 'meta_campaign_create',
  '<ad group create action>': 'meta_adset_create',
  '<campaign name>': 'Synthetic campaign',
  '<ad group name>': 'Synthetic ad group',
};

test('help for create carries a worked example of a plan whose steps createPlan accepts as written', async t => {
  const f = harness(t),
    help = await f.call({action: 'help', topic: 'create'});
  assert.equal(help.success, true, JSON.stringify(help.error));
  const example = help.data.worked_example;
  assert.ok(example, 'help topic create has a worked_example');
  assert.equal(example.tool, 'amcp_campaign');
  assert.equal(example.arguments.action, 'create');
  assert.ok(example.arguments.steps.length >= 2, 'a plan of steps, the later one depending on the earlier');
  assert.deepEqual(example.arguments.steps[1].depends_on, [example.arguments.steps[0].id]);
  // Its one result reference is in the shape the plan resolves, and names the step it waits for.
  const reference = example.arguments.steps[1].arguments.payload.campaign_id;
  assert.deepEqual(Object.keys(reference), ['$ref']);
  assert.equal(planReference(reference).ref.split('#')[0], example.arguments.steps[0].id);
  // What the caller must replace is declared, whole: every angle-bracket value and nothing else.
  const declared = Object.keys(example.placeholders).sort(),
    used = [...new Set(placeholdersOf(example.arguments))].sort();
  assert.deepEqual(used, declared);
  assert.deepEqual(declared, Object.keys(real).sort(), 'the test gives a real value to every placeholder it declares');
  assert.ok(Object.values(example.placeholders).every(meaning => typeof meaning === 'string' && meaning.length > 10));
  assert.ok(example.notes.length >= 3 && example.notes.every(note => typeof note === 'string'));
  // With each placeholder given its real value it is a plan create accepts, with no warning, and nothing is sent.
  const created = await f.call(fill(example.arguments, real));
  assert.equal(created.success, true, JSON.stringify(created.error));
  assert.equal(created.meta.argument_warnings, undefined);
  assert.equal(f.requests(), 0);
  const plan = await f.call({action: 'get', id: created.data.id, detail: 'full'});
  assert.deepEqual(
    plan.data.steps.map(s => [s.id, s.kind, s.depends_on]),
    example.arguments.steps.map(s => [s.id, s.kind, s.depends_on ?? []]),
  );
  // Left as written, its placeholders are refused by the checks a plan always has (no such connection), not accepted.
  assertRefused(await f.call(structuredClone(example.arguments)), 'CONNECTION_REQUIRED');
});

test('the worked example is the answer of create’s help alone, and a copy no caller can change', async t => {
  const f = harness(t),
    first = await f.call({action: 'help', topic: 'create'});
  first.data.worked_example.arguments.name = 'Changed by a caller';
  first.data.worked_example.arguments.steps.length = 0;
  const second = await f.call({action: 'help', topic: 'create'});
  assert.equal(second.data.worked_example.arguments.name, 'Autumn launch');
  assert.equal(second.data.worked_example.arguments.steps.length, 2);
  for (const topic of [undefined, 'get', 'recover_step', 'approve']) {
    const other = await f.call({action: 'help', ...(topic ? {topic} : {})});
    assert.equal(other.success, true, JSON.stringify(other.error));
    assert.equal(other.data.worked_example, undefined, String(topic));
  }
});

test('help for create names the step shape in the steps argument', async t => {
  const f = harness(t),
    help = await f.call({action: 'help', topic: 'create'});
  assert.equal(help.success, true, JSON.stringify(help.error));
  const steps = help.data.arguments.steps.description;
  for (const part of [
    '"id"',
    '"kind"',
    '"gateway"',
    '"connection_id"',
    '"account_id"',
    '"arguments"',
    '"depends_on"',
    '$ref',
  ])
    assert.ok(steps.includes(part), 'the steps note names ' + part + ': ' + steps);
  assert.match(steps, /worked example/);
  // The contract's schema carries the same note, and its flat shape is as it was.
  assert.equal(help.data.contract.arguments_schema.properties.steps.description, steps);
  assert.deepEqual((({description, ...schema}) => schema)(help.data.arguments.steps), {
    type: 'array',
    items: {type: 'object'},
    minItems: 1,
    maxItems: 50,
  });
});

test('the help of amcp_campaign stays within the help budget and tools/list does not grow', async t => {
  const f = harness(t);
  for (const topic of [undefined, 'create']) {
    const help = await f.call({action: 'help', ...(topic ? {topic} : {})});
    assert.equal(help.success, true, JSON.stringify(help.error));
    assert.ok(bytes(help) <= 40000, String(topic) + ' help bytes: ' + bytes(help));
  }
  // The listed schema keeps its one untyped steps array: the shape lives in help and in the refusal, never in tools/list.
  const listed = f.service.firstPartyTools().find(tool => tool.name === 'amcp_campaign');
  assert.deepEqual(listed.inputSchema.properties.steps, {
    type: 'array',
    items: {type: 'object'},
    minItems: 1,
    maxItems: 50,
  });
});

test('every refusal of create a caller can correct points at the help that has the worked example', async t => {
  const f = harness(t),
    help = {tool: 'amcp_campaign', arguments: {action: 'help', topic: 'create'}};
  for (const [label, input] of [
    ['name', {name: '', steps: [step()]}],
    ['brief', {name: 'Synthetic plan', brief: 7, steps: [step()]}],
    ['steps', {name: 'Synthetic plan', steps: []}],
    ['a step', {name: 'Synthetic plan', steps: [step('a', {connection_id: undefined})]}],
    ['a step’s keys', {name: 'Synthetic plan', steps: [{...step(), payload: {}}]}],
  ]) {
    const refused = await f.call({action: 'create', ...input});
    assertRefused(refused, 'INVALID_ARGUMENT');
    assert.deepEqual(refused.error.details.help_call, help, label);
  }
  // A refusal that has nothing to do with the shape of a plan does not point there.
  const dependency = await f.call({
    action: 'create',
    name: 'Synthetic plan',
    steps: [step('a', {depends_on: ['b']}), step('b')],
  });
  assertRefused(dependency, 'INVALID_ARGUMENT', {message: /Dependencies must refer to earlier steps/});
  assert.equal(dependency.error.details?.help_call, undefined);
});

test('the topics that take a step’s own arguments teach the same shape and point at the worked example', async t => {
  const f = harness(t);
  for (const topic of ['recover_step', 'validate_provider']) {
    const help = await f.call({action: 'help', topic});
    assert.equal(help.success, true, topic + ' ' + JSON.stringify(help.error));
    const note = help.data.arguments.arguments.description;
    assert.match(note, /"action"/, topic);
    assert.match(note, /"payload"/, topic);
    assert.match(note, /help create/, topic);
    assert.deepEqual(help.data.contract.arguments_schema.properties.arguments.description, note, topic);
  }
  // recover_step says what its arguments replace; validate_provider what its arguments are checked as.
  const recover = (await f.call({action: 'help', topic: 'recover_step'})).data.arguments.arguments.description;
  assert.match(recover, /recover_step: .*step/);
});
