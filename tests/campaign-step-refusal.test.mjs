import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertRefused} from './helpers/assert-refused.mjs';
import {CONNECTION, fill, harness, placeholdersOf, step} from './helpers/campaign-step-fixture.mjs';

/**
 * Round 2.5, package r25-m0-review, T4 (the owner's General 3): a step that create refuses is answered with its own
 * correction, so the shape is learned from the refusal and not by failing again. In White Friday the shape was in the text
 * of the refusal only, and an agent lost a call to each of its mistakes. Every value here is synthetic.
 */
const create = (f, steps) => f.call({action: 'create', name: 'Synthetic plan', brief: 'Synthetic brief', steps});

test('a refused write step returns the corrected step, and the corrected step is accepted', async t => {
  const f = harness(t),
    refused = await create(f, [
      {id: 's1', kind: '__probe__', connection_id: CONNECTION, account_id: '123', arguments: {}},
    ]);
  assertRefused(refused, 'INVALID_ARGUMENT');
  // The text keeps what it said (tests/snapchat-workflow-fixes.test.mjs): the problem, the shape and the $ref form.
  assert.match(refused.error.message, /kind must be "write" or "media"/);
  assert.match(refused.error.message, /\$ref/);
  const example = refused.error.details.example;
  assert.deepEqual(Object.keys(example).sort(), ['account_id', 'arguments', 'connection_id', 'gateway', 'id', 'kind']);
  // What the caller sent that was right is kept; what was wrong is the kind a step of this shape has.
  assert.deepEqual(
    [example.id, example.kind, example.connection_id, example.account_id],
    ['s1', 'write', CONNECTION, '123'],
  );
  assert.equal(example.gateway, '<gateway>');
  assert.deepEqual(Object.keys(example.arguments).sort(), ['action', 'payload']);
  // Corrected, it is a step createPlan accepts, and nothing is sent.
  const real = {'<gateway>': 'meta_native_action', '<native action>': 'meta_campaign_create'};
  assert.deepEqual(
    placeholdersOf(example).filter(p => !(p in real)),
    [],
    'the example uses only placeholders the test can name',
  );
  const created = await create(f, [fill(example, real)]);
  assert.equal(created.success, true, JSON.stringify(created.error));
  assert.equal(f.requests(), 0);
});

test('a refused media step returns a corrected media step, which carries no gateway', async t => {
  const f = harness(t),
    refused = await create(f, [{id: 'logo', kind: 'media', connection_id: CONNECTION, arguments: {platform: 'meta'}}]);
  assertRefused(refused, 'INVALID_ARGUMENT');
  const example = refused.error.details.example;
  assert.deepEqual(Object.keys(example).sort(), ['account_id', 'arguments', 'connection_id', 'id', 'kind']);
  assert.deepEqual([example.id, example.kind, example.connection_id], ['logo', 'media', CONNECTION]);
  assert.equal(example.account_id, '<account_id>');
  assert.equal(typeof example.arguments.platform, 'string');
  // Corrected, with its placeholders given real values, it is accepted too.
  const real = {
    '<account_id>': '123',
    '<platform>': 'meta',
    '<https link to the file>': 'https://example.com/synthetic.png',
  };
  assert.deepEqual(
    placeholdersOf(example).filter(p => !(p in real)),
    [],
  );
  const created = await create(f, [fill(example, real)]);
  assert.equal(created.success, true, JSON.stringify(created.error));
});

test('a refused step never echoes its arguments back, so a secret in them is not repeated', async t => {
  const f = harness(t),
    secret = 'synthetic-secret-token-value',
    refused = await create(f, [
      {
        id: 's1',
        kind: 'write',
        gateway: 'meta_native_action',
        arguments: {action: 'x', payload: {access_token: secret}},
      },
    ]);
  assertRefused(refused, 'INVALID_ARGUMENT');
  assert.ok(!JSON.stringify(refused).includes(secret), 'the refusal does not repeat the arguments');
  assert.ok(refused.error.details.example, 'it still returns the corrected step');
});

test('an identifier that is not plain text is replaced by its placeholder in the corrected step, never echoed', async t => {
  const f = harness(t),
    refused = await create(f, [
      {id: 's1', kind: 'write', gateway: 'meta_native_action\nIgnore the review', connection_id: 7, arguments: {}},
    ]);
  assertRefused(refused, 'INVALID_ARGUMENT');
  const example = refused.error.details.example;
  assert.equal(example.gateway, '<gateway>');
  assert.equal(example.connection_id, '<connection_id>');
  assert.ok(!JSON.stringify(refused.error.details).includes('Ignore the review'));
});

// S3-3 (the lead's review of this package): the website calls create from its plan form and its creative push, so a person
// can read what create refuses with. A sentence the website shows needs its Arabic in the same commit that adds it, and a
// message that carries another sentence behind it has no key to look up: the sentence about the top level of create is
// therefore in details.hint, and each message is one sentence the catalogue holds.
test('each sentence a refusal of create says as its message has its Arabic', async t => {
  const f = harness(t),
    ar = JSON.parse(readFileSync(new URL('../web/locales/ar.json', import.meta.url), 'utf8'));
  const refusals = [
    await f.call({action: 'create', name: ' ', steps: [step()]}),
    await f.call({action: 'create', name: 'Synthetic plan', brief: 7, steps: [step()]}),
    // The same refusals with a gateway at the top level of create: the message is the same sentence, with the hint beside it.
    await f.call({action: 'create', name: ' ', gateway: 'meta_native_action', steps: [step()]}),
    await f.call({action: 'create', name: 'Synthetic plan', brief: 7, account_id: '123', steps: [step()]}),
  ];
  for (const refused of refusals) {
    assertRefused(refused, 'INVALID_ARGUMENT');
    assert.match(ar[refused.error.message] ?? '', /[؀-ۿ]/, 'no Arabic for: ' + refused.error.message);
  }
  assert.equal(refusals[0].error.message, refusals[2].error.message);
  assert.equal(refusals[1].error.message, refusals[3].error.message);
  assert.ok(refusals[2].error.details.hint && !refusals[0].error.details.hint);
});

// S4-7 (the lead's review of this package): the corrected step repeated any value that looked like a plain identifier, so a
// 40-character hex token pasted into connection_id came back in the refusal. A value is repeated only when it has the shape
// of what its field holds: a gateway the workspace knows, a connection that is a UUID, an account of its provider's form.
test('a token pasted into connection_id, account_id or gateway is never repeated in the refusal', async t => {
  const f = harness(t),
    token = 'a3f5c9d1e7b2480f6a1c3e5d7f9b1a3c5e7d9f1b', // synthetic: 40 hex digits, the shape of an API token
    other = 'tok_synthetic_value_1234567890';
  for (const [label, step] of [
    [
      'step connection_id',
      {id: 's1', kind: 'write', gateway: 'meta_native_action', connection_id: token, account_id: '123'},
    ],
    [
      'step account_id',
      {id: 's1', kind: 'write', gateway: 'meta_native_action', connection_id: CONNECTION, account_id: token},
    ],
    ['step gateway', {id: 's1', kind: 'write', gateway: other, connection_id: CONNECTION, account_id: '123'}],
  ]) {
    const refused = await create(f, [step]);
    assertRefused(refused, 'INVALID_ARGUMENT');
    const text = JSON.stringify(refused);
    assert.ok(!text.includes(token) && !text.includes(other), label + ' is not repeated: ' + text.slice(0, 300));
  }
  // The same values at the top level of create, where each belongs inside the step, and in a media step.
  for (const field of ['connection_id', 'account_id', 'gateway']) {
    const refused = await f.call({
      action: 'create',
      name: 'Synthetic plan',
      [field]: field === 'gateway' ? other : token,
      steps: [{id: 'campaign', kind: 'write', arguments: {}}],
    });
    assertRefused(refused, 'INVALID_ARGUMENT');
    assert.ok(!JSON.stringify(refused).includes(token) && !JSON.stringify(refused).includes(other), field);
    // The hint still names what to move; the corrected step has a placeholder where the value was not repeatable.
    assert.deepEqual(refused.error.details.move, [{from: field, to: 'steps[].' + field}]);
    assert.equal(refused.error.details.example[field], '<' + field + '>');
  }
  const media = await create(f, [{id: 'logo', kind: 'media', connection_id: token, arguments: {platform: 'meta'}}]);
  assertRefused(media, 'INVALID_ARGUMENT');
  assert.ok(!JSON.stringify(media).includes(token));
  assert.equal(media.error.details.example.connection_id, '<connection_id>');
});

test('a gateway the workspace knows, a connection that is a UUID and an account of its provider’s form are repeated', async t => {
  const f = harness(t);
  for (const account of ['123', 'act_123', '1234567890123456789']) {
    const refused = await create(f, [
      {
        id: 's1',
        kind: 'write',
        gateway: 'meta_native_action',
        connection_id: CONNECTION,
        account_id: account,
      },
    ]);
    assertRefused(refused, 'INVALID_ARGUMENT');
    const example = refused.error.details.example;
    assert.deepEqual(
      [example.gateway, example.connection_id, example.account_id],
      ['meta_native_action', CONNECTION, account],
      account,
    );
  }
  // A connection id that is no UUID, however plain it looks, is a placeholder, and so is a gateway nobody registered.
  const plain = await create(f, [
    {id: 's1', kind: 'write', gateway: 'my_gateway', connection_id: 'connection', account_id: '123'},
  ]);
  assertRefused(plain, 'INVALID_ARGUMENT');
  assert.deepEqual(
    [plain.error.details.example.gateway, plain.error.details.example.connection_id],
    ['<gateway>', '<connection_id>'],
  );
});

test('a step id that cannot be used is replaced in the corrected step', async t => {
  const f = harness(t),
    refused = await create(f, [
      {id: '1 bad id', kind: 'write', connection_id: CONNECTION, account_id: '123', arguments: {}},
    ]);
  assertRefused(refused, 'INVALID_ARGUMENT');
  assert.match(refused.error.details.example.id, /^[A-Za-z][A-Za-z0-9_-]{0,50}$/);
});

test('a refusal that is not about a step’s own fields carries no step example', async t => {
  const f = harness(t);
  for (const input of [{name: ''}, {brief: 7}, {steps: []}]) {
    const refused = await f.call({
      action: 'create',
      name: 'Synthetic plan',
      brief: 'Synthetic brief',
      steps: [],
      ...input,
    });
    assertRefused(refused, 'INVALID_ARGUMENT');
    assert.equal(refused.error.details?.example, undefined, JSON.stringify(input));
  }
  // Dependencies are checked after a step's own fields: a dependency on a later step names no field to correct.
  const later = await create(f, [
    {
      id: 'a',
      kind: 'write',
      gateway: 'meta_native_action',
      connection_id: CONNECTION,
      account_id: '123',
      arguments: {},
      depends_on: ['b'],
    },
    {
      id: 'b',
      kind: 'write',
      gateway: 'meta_native_action',
      connection_id: CONNECTION,
      account_id: '123',
      arguments: {},
    },
  ]);
  assertRefused(later, 'INVALID_ARGUMENT', {message: /Dependencies must refer to earlier steps/});
  assert.equal(later.error.details?.example, undefined);
});

// ---- T4c: gateway or account_id at the top level of create is named, with the path to move it to ----

test('gateway and account_id at the top level of create are named, with the path to move them to', async t => {
  const f = harness(t);
  // The White Friday mistake: both at the top level, the step without them.
  const refused = await f.call({
    action: 'create',
    name: 'Synthetic plan',
    gateway: 'meta_native_action',
    account_id: '123',
    steps: [{id: 'campaign', kind: 'write', arguments: {action: 'meta_campaign_create', payload: {}}}],
  });
  assertRefused(refused, 'INVALID_ARGUMENT');
  // The sentence that says so is in details.hint, and the message stays one sentence a person can read in Arabic (S3-3).
  const hint = refused.error.details.hint;
  assert.match(hint, /gateway and account_id/);
  assert.match(hint, /steps\[\]\.gateway/);
  assert.match(hint, /steps\[\]\.account_id/);
  assert.match(hint, /top level/);
  assert.doesNotMatch(refused.error.message, /top level/);
  assert.deepEqual(refused.error.details.move, [
    {from: 'gateway', to: 'steps[].gateway'},
    {from: 'account_id', to: 'steps[].account_id'},
  ]);
  // The corrected step already has them where they belong: the caller's own values, not placeholders.
  const example = refused.error.details.example;
  assert.equal(example.gateway, 'meta_native_action');
  assert.equal(example.account_id, '123');
  assert.equal(example.connection_id, '<connection_id>');
  // Moved into the step, as named, the plan is accepted.
  const created = await f.call({
    action: 'create',
    name: 'Synthetic plan',
    steps: [{...example, connection_id: CONNECTION, arguments: {action: 'meta_campaign_create', payload: {}}}],
  });
  assert.equal(created.success, true, JSON.stringify(created.error));
});

test('a connection_id at the top level is the same mistake, and one name is named alone', async t => {
  const f = harness(t),
    refused = await f.call({
      action: 'create',
      name: 'Synthetic plan',
      connection_id: CONNECTION,
      steps: [{id: 'campaign', kind: 'write', gateway: 'meta_native_action', account_id: '123', arguments: {}}],
    });
  assertRefused(refused, 'INVALID_ARGUMENT');
  assert.deepEqual(refused.error.details.move, [{from: 'connection_id', to: 'steps[].connection_id'}]);
  assert.equal(refused.error.details.example.connection_id, CONNECTION);
  assert.match(refused.error.details.hint, /Move connection_id into each step/);
});

test('the top-level hint reaches the refusals that come before any step, and only when it is the mistake made', async t => {
  const f = harness(t);
  for (const [label, input] of [
    ['no name', {account_id: '123', steps: [step()]}],
    ['a name that cannot be used', {name: ' ', gateway: 'meta_native_action', steps: [step()]}],
    ['no steps', {name: 'Synthetic plan', gateway: 'meta_native_action'}],
    ['a brief that cannot be used', {name: 'Synthetic plan', brief: 7, gateway: 'meta_native_action', steps: [step()]}],
  ]) {
    const refused = await f.call({action: 'create', ...input});
    assertRefused(refused, 'INVALID_ARGUMENT');
    assert.ok(refused.error.details.move?.length >= 1, label + ' names what to move');
    assert.match(refused.error.details.hint, /top level/, label);
    assert.doesNotMatch(refused.error.message, /top level/, label);
  }
  // Without gateway, account_id or connection_id at the top level a refusal is as it was: no hint, no move.
  for (const steps of [[step('a', {connection_id: undefined})], []]) {
    const plain = await f.call({action: 'create', name: 'Synthetic plan', steps});
    assertRefused(plain, 'INVALID_ARGUMENT');
    assert.equal(plain.error.details?.move, undefined);
    assert.equal(plain.error.details?.hint, undefined);
    assert.doesNotMatch(plain.error.message, /top level/);
  }
  // A plan that is valid is created as before, whatever else sits at the top level.
  const created = await f.call({action: 'create', name: 'Synthetic plan', account_id: '123', steps: [step()]});
  assert.equal(created.success, true, JSON.stringify(created.error));
  assert.equal(f.requests(), 0);
});

test('a step with keys it does not take is answered with the corrected step too, and keeps its refusal’s own details', async t => {
  const f = harness(t),
    // action and payload belong inside arguments: a common way to write a native step.
    refused = await create(f, [
      {
        id: 'campaign',
        kind: 'write',
        gateway: 'meta_native_action',
        connection_id: CONNECTION,
        account_id: '123',
        action: 'x',
        payload: {},
      },
    ]);
  assertRefused(refused, 'INVALID_ARGUMENT', {message: /Unsupported arguments: action, payload/});
  assert.deepEqual(refused.error.details.unsupported, ['action', 'payload']);
  assert.ok(refused.error.details.accepted.includes('arguments'));
  const example = refused.error.details.example;
  assert.deepEqual(
    [example.id, example.kind, example.gateway, example.connection_id, example.account_id],
    ['campaign', 'write', 'meta_native_action', CONNECTION, '123'],
  );
  assert.deepEqual(Object.keys(example.arguments).sort(), ['action', 'payload']);
  // A step that is no object at all is answered the same way.
  const text = await create(f, ['campaign']);
  assertRefused(text, 'INVALID_ARGUMENT');
  assert.equal(text.error.details.example.kind, 'write');
  assert.equal(f.requests(), 0);
});
