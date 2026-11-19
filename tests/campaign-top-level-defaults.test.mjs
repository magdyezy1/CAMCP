import test from 'node:test';
import assert from 'node:assert/strict';
import {approvalSummary} from '../dist/src/plan-approval.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {CONNECTION, admin, harness, operator} from './helpers/campaign-step-fixture.mjs';

/**
 * Round 2.5 field fix, package r25-field-callshape (2026-11-19), item 3: amcp_campaign create takes the gateway, the connection and
 * the account in each step, and an agent that wrote them once at the top level, as amcp_write takes its gateway, was refused (R2.5
 * T4). The lead reverses T4 for the unambiguous case only: a top-level gateway, connection_id or account_id fills each write step
 * that leaves it out, when no step names another value. Each step then records the value, so the plan hash and the approval summary
 * show every step's account, as for a plan written in full. A plan that mixes values is still refused, with T4's hint. Every value
 * here is synthetic, and nothing is sent to any provider.
 */
const META = 'meta_native_action',
  TIKTOK = 'tiktok_native_action',
  SECOND = '44444444-4444-4444-8444-444444444444',
  /** A synthetic 40-digit hex token: the shape of an API key, which an agent can paste into the wrong field. */
  token = 'a3f5c9d1e7b2480f6a1c3e5d7f9b1a3c5e7d9f1b';
const defaults = {gateway: META, connection_id: CONNECTION, account_id: '123'};
const stored = (f, id) => f.store.document(operator.tenantId, 'campaign_run', id);
const plans = f => f.store.documents(operator.tenantId, 'campaign_run').length;
/** The harness's one login and account, and a second login with an account of its own, for a plan that names two. */
function twoLogins(t) {
  const f = harness(t);
  f.store.putConnection(
    admin,
    {
      id: SECOND,
      tenantId: operator.tenantId,
      gateway: META,
      accounts: ['456'],
      writeAccounts: ['456'],
      enabled: true,
      label: 'Second synthetic login',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  return f;
}
/** Two native steps that name none of the three fields: a campaign, then an ad set that waits for it. */
const nativeSteps = () => [
  {
    id: 'campaign',
    kind: 'write',
    arguments: {action: 'meta_campaign_create', payload: {name: 'Synthetic campaign', status: 'PAUSED'}},
  },
  {
    id: 'adset',
    kind: 'write',
    depends_on: ['campaign'],
    arguments: {
      action: 'meta_adset_create',
      payload: {campaign_id: {$ref: 'campaign#/data/id'}, name: 'Synthetic ad set'},
    },
  },
];
const create = (f, input) => f.call({action: 'create', name: 'Synthetic plan', ...input});

test('a gateway, connection and account written once at the top level fill every write step that leaves them out', async t => {
  const f = harness(t),
    created = await create(f, {...defaults, steps: nativeSteps()});
  assert.equal(created.success, true, JSON.stringify(created.error));
  assert.equal(created.meta.argument_warnings, undefined, 'an accepted shape draws no warning');
  const plan = stored(f, created.data.id);
  // Each step records the three values: the plan is saved as if each step had named them.
  assert.deepEqual(
    plan.steps.map(s => [s.id, s.gateway, s.connection_id, s.account_id]),
    [
      ['campaign', META, CONNECTION, '123'],
      ['adset', META, CONNECTION, '123'],
    ],
  );
  // So it is the very plan that writing them in each step makes: the same plan hash, and the same creation key behaviour.
  const explicit = await create(f, {
    name: 'Synthetic plan in full',
    steps: nativeSteps().map(s => ({...s, ...defaults})),
  });
  assert.equal(explicit.success, true, JSON.stringify(explicit.error));
  assert.equal(stored(f, explicit.data.id).plan_hash, plan.plan_hash);
  // What the person approves shows every step's gateway and account, as for a plan written in full.
  const summary = approvalSummary(plan);
  assert.equal(summary.plan_hash, plan.plan_hash);
  assert.deepEqual(
    summary.steps.map(s => [s.id, s.gateway, s.account_id]),
    [
      ['campaign', META, '123'],
      ['adset', META, '123'],
    ],
  );
  assert.equal(f.requests(), 0, 'create sends nothing');
});

test('each of the three fields fills the steps on its own, beside steps that name the others', async t => {
  const f = harness(t);
  for (const field of Object.keys(defaults)) {
    const steps = nativeSteps().map(s => ({
        ...s,
        ...Object.fromEntries(Object.entries(defaults).filter(([name]) => name !== field)),
      })),
      created = await create(f, {[field]: defaults[field], steps});
    assert.equal(created.success, true, field + ' ' + JSON.stringify(created.error));
    for (const s of stored(f, created.data.id).steps) assert.equal(s[field], defaults[field], field);
  }
});

test('a step that names a value for itself keeps it, and one that names the top-level value is no mix', async t => {
  const f = twoLogins(t),
    created = await create(f, {
      ...defaults,
      steps: [
        // Leaves every field out.
        nativeSteps()[0],
        // Names the same account in the form its provider also writes it (the account is compared as the provider binds it).
        {...nativeSteps()[1], account_id: 'act_123'},
      ],
    });
  assert.equal(created.success, true, JSON.stringify(created.error));
  assert.deepEqual(
    stored(f, created.data.id).steps.map(s => [s.gateway, s.connection_id, s.account_id]),
    [
      [META, CONNECTION, '123'],
      [META, CONNECTION, 'act_123'],
    ],
  );
});

test('a step that names another value leaves the top level unused for that field: the steps that omit it are refused with the T4 hint', async t => {
  const f = twoLogins(t);
  for (const [field, other] of [
    ['account_id', '456'],
    ['connection_id', SECOND],
    ['gateway', TIKTOK],
  ]) {
    const refused = await create(f, {
      ...defaults,
      steps: [nativeSteps()[0], {...nativeSteps()[1], [field]: other}],
    });
    assertRefused(refused, 'INVALID_ARGUMENT', {
      message: new RegExp(field === 'gateway' ? 'a write step needs gateway' : field + ' is required'),
    });
    // Only the field that is mixed is named: the other two were used, so they are no mistake.
    assert.deepEqual(refused.error.details.move, [{from: field, to: 'steps[].' + field}], field);
    assert.match(
      refused.error.details.hint,
      new RegExp('^Move ' + field + ' into each step \\(steps\\[\\]\\.' + field),
    );
    assert.match(refused.error.details.hint, /top level/);
    // The corrected step keeps the caller's own values, the top-level one among them, as T4 shows it.
    for (const [name, value] of Object.entries(defaults)) assert.equal(refused.error.details.example[name], value);
    assert.deepEqual(refused.error.details.help_call, {
      tool: 'amcp_campaign',
      arguments: {action: 'help', topic: 'create'},
    });
  }
  assert.equal(plans(f), 0, 'a refused plan is not saved');
  assert.equal(f.requests(), 0);
});

test('every step that names its own value needs nothing from the top level, which is then not used', async t => {
  const f = twoLogins(t),
    steps = [
      {...nativeSteps()[0], gateway: META, connection_id: CONNECTION, account_id: '123'},
      {...nativeSteps()[1], gateway: META, connection_id: SECOND, account_id: '456'},
    ],
    created = await create(f, {...defaults, steps});
  assert.equal(created.success, true, JSON.stringify(created.error));
  assert.deepEqual(
    stored(f, created.data.id).steps.map(s => [s.connection_id, s.account_id]),
    [
      [CONNECTION, '123'],
      [SECOND, '456'],
    ],
  );
});

test('a top-level value that does not have the shape of its field is no default, and is never repeated', async t => {
  const f = harness(t);
  // Every step is whole but for the one field: a value that were used would reach the lookup of the connection, which names the
  // account it could not find. It is refused first, by the step's own check, and no value comes back.
  const whole = {gateway: META, connection_id: CONNECTION, account_id: '123'};
  for (const [field, bad] of [
    ['account_id', token],
    ['connection_id', token],
    ['gateway', 'tok_synthetic_value_1234567890'],
  ]) {
    const steps = nativeSteps().map(s => ({
        ...s,
        ...Object.fromEntries(Object.entries(whole).filter(([k]) => k !== field)),
      })),
      refused = await create(f, {[field]: bad, steps});
    assertRefused(refused, 'INVALID_ARGUMENT', {writes: 0});
    assert.deepEqual(refused.error.details.move, [{from: field, to: 'steps[].' + field}], field);
    assert.ok(!JSON.stringify(refused).includes(bad), field + ' is not repeated');
    assert.equal(refused.error.details.example[field], '<' + field + '>');
  }
  assert.equal(plans(f), 0);
});

test('a media step is never filled: it names its own connection and account, and its correction shows the top-level ones', async t => {
  const f = harness(t),
    media = {id: 'logo', kind: 'media', arguments: {platform: 'meta', source_url: 'https://example.com/synthetic.png'}},
    refused = await create(f, {...defaults, steps: [nativeSteps()[0], media]});
  assertRefused(refused, 'INVALID_ARGUMENT', {
    message: /^Step "logo": connection_id is required; account_id is required/,
  });
  assert.equal(refused.error.details.example.kind, 'media');
  assert.equal(refused.error.details.example.connection_id, CONNECTION);
  assert.equal(refused.error.details.example.account_id, '123');
  // Named in the step, it is accepted beside the write step that was filled.
  const created = await create(f, {
    ...defaults,
    steps: [nativeSteps()[0], {...media, connection_id: CONNECTION, account_id: '123'}],
  });
  assert.equal(created.success, true, JSON.stringify(created.error));
  assert.deepEqual(
    stored(f, created.data.id).steps.map(s => [s.kind, s.gateway, s.connection_id, s.account_id]),
    [
      ['write', META, CONNECTION, '123'],
      ['media', undefined, CONNECTION, '123'],
    ],
  );
});

test('a refusal about something else carries no hint when the top-level values fit, and keeps it when one cannot be used', async t => {
  const f = harness(t);
  for (const [label, input] of [
    ['a name that cannot be used', {name: ' ', steps: nativeSteps()}],
    ['a brief that cannot be used', {brief: 7, steps: nativeSteps()}],
    ['no steps', {steps: []}],
  ]) {
    const fits = await create(f, {...defaults, ...input});
    assertRefused(fits, 'INVALID_ARGUMENT');
    assert.equal(fits.error.details?.hint, undefined, label + ': the top-level values are no mistake');
    assert.equal(fits.error.details?.move, undefined, label);
    const cannot = await create(f, {...defaults, account_id: token, ...input});
    assertRefused(cannot, 'INVALID_ARGUMENT');
    assert.deepEqual(cannot.error.details.move, [{from: 'account_id', to: 'steps[].account_id'}], label);
    assert.match(cannot.error.details.hint, /^Move account_id into each step/);
    assert.equal(cannot.error.message, fits.error.message, label + ': the message is the same sentence');
    assert.ok(!JSON.stringify(cannot).includes(token));
  }
});

test('a creation key names the same plan whichever way its values are written', async t => {
  const f = harness(t),
    key = 'synthetic-creation-key-1',
    first = await create(f, {...defaults, idempotency_key: key, steps: nativeSteps()}),
    again = await create(f, {...defaults, idempotency_key: key, steps: nativeSteps()}),
    inFull = await create(f, {idempotency_key: key, steps: nativeSteps().map(s => ({...s, ...defaults}))});
  for (const answer of [first, again, inFull]) assert.equal(answer.success, true, JSON.stringify(answer.error));
  assert.equal(again.data.id, first.data.id);
  // The plan is one: its steps hold the values, so the key finds the same creation.
  assert.equal(inFull.data.id, first.data.id);
  assert.equal(plans(f), 1);
});

test('the three are arguments of create: no warning is drawn and, under enforcement of action arguments, none is refused', async t => {
  // MIRROR_FLAGS {"actionArguments":"enforce"} refuses an argument the action does not read, before it runs. create reads these
  // three now (src/first-party-contracts.ts), so they are neither a meta.argument_warnings entry nor a refusal there.
  const f = harness(t, {mode: 'strict', flags: {actionArguments: 'enforce'}}),
    created = await create(f, {...defaults, steps: nativeSteps()});
  assert.equal(created.success, true, JSON.stringify(created.error));
  assert.equal(created.meta.argument_warnings, undefined);
  // The same service does refuse a key create does not read, so the check ran.
  const foreign = await create(f, {...defaults, payload: {}, steps: nativeSteps()});
  assertRefused(foreign, 'INVALID_ARGUMENT', {message: /^payload is not an argument of amcp_campaign create/});
  // And help lists them among what create takes, each with what it means there.
  const help = await f.call({action: 'help', topic: 'create'});
  assert.equal(help.success, true, JSON.stringify(help.error));
  for (const name of Object.keys(defaults)) assert.match(help.data.arguments[name].description, /^create: the /, name);
});

// ---- the gates a default meets are the gates a step's own value meets ----

test('a default is checked as a step’s own value is: an account its connection does not hold, or one outside the playbook, is refused', async t => {
  const f = harness(t),
    bound = '55555555-5555-4555-8555-555555555555';
  // The connection holds account 123 only: a default of 456 is refused by the lookup of the connection, as a step's own 456 is.
  const elsewhere = await create(f, {...defaults, account_id: '456', steps: nativeSteps()});
  assertRefused(elsewhere, 'CONNECTION_REQUIRED', {writes: 0});
  const own = await create(f, {steps: nativeSteps().map(s => ({...s, ...defaults, account_id: '456'}))});
  assertRefused(own, 'CONNECTION_REQUIRED', {writes: 0});
  assert.equal(plans(f), 0);
  // An approved client playbook binds a connection and an account: a default outside it is refused like a step's own value.
  f.store.putConnection(
    admin,
    {
      id: bound,
      tenantId: operator.tenantId,
      gateway: META,
      accounts: ['789'],
      writeAccounts: ['789'],
      enabled: true,
      label: 'Bound synthetic login',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  f.store.putDocument(operator.tenantId, 'client_profile', 'synthetic-profile', {
    name: 'Synthetic client',
    approved_by: operator.userId,
    bindings: [{gateway: META, connection_id: bound, account_id: '789'}],
  });
  const outside = await create(f, {...defaults, profile_id: 'synthetic-profile', steps: nativeSteps()});
  assertRefused(outside, 'PROFILE_ACCOUNT_MISMATCH', {writes: 0});
  const within = await create(f, {
    ...defaults,
    connection_id: bound,
    account_id: '789',
    profile_id: 'synthetic-profile',
    steps: nativeSteps(),
  });
  assert.equal(within.success, true, JSON.stringify(within.error));
  assert.equal(plans(f), 1);
});
