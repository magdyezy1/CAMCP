import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRefused} from './helpers/assert-refused.mjs';
import {CONNECTION, harness, operator} from './helpers/campaign-step-fixture.mjs';

/**
 * Round 2.5 field fix, package r25-field-callshape (2026-11-19), item 4: a plan step takes its gateway beside its arguments, and an
 * agent that knew amcp_write's shape wrote the gateway inside them: the step was refused with a sentence whose example showed a
 * placeholder where the caller's own gateway had been. A step's `arguments.gateway` is lifted into the step under the rule of
 * amcp_write's (item 1): only when the step names no gateway of its own and the name is a registered gateway; the plan then holds
 * the canonical step, and the response carries a deprecation warning. Every value here is synthetic.
 */
const META = 'meta_native_action',
  TIKTOK = 'tiktok_native_action',
  /** A synthetic 40-digit hex token: the shape of an API key. */
  token = 'a3f5c9d1e7b2480f6a1c3e5d7f9b1a3c5e7d9f1b';
const stored = (f, id) => f.store.document(operator.tenantId, 'campaign_run', id);
const warningsOf = result => result.meta?.argument_warnings ?? [];
const lifted = result => warningsOf(result).filter(w => w.code === 'GATEWAY_PLACEMENT_DEPRECATED');
const campaign = (extra = {}, args = {}) => ({
  id: 'campaign',
  kind: 'write',
  connection_id: CONNECTION,
  account_id: '123',
  arguments: {action: 'meta_campaign_create', payload: {name: 'Synthetic campaign', status: 'PAUSED'}, ...args},
  ...extra,
});
const adset = (extra = {}, args = {}) => ({
  id: 'adset',
  kind: 'write',
  connection_id: CONNECTION,
  account_id: '123',
  depends_on: ['campaign'],
  arguments: {
    action: 'meta_adset_create',
    payload: {campaign_id: {$ref: 'campaign#/data/id'}, name: 'Synthetic ad set'},
    ...args,
  },
  ...extra,
});
const create = (f, input) => f.call({action: 'create', name: 'Synthetic plan', ...input});

test('a step that names its gateway inside arguments is lifted into the step, with a warning for each, and is the canonical plan', async t => {
  const f = harness(t),
    inner = await create(f, {steps: [campaign({}, {gateway: META}), adset({}, {gateway: META})]});
  assert.equal(inner.success, true, JSON.stringify(inner.error));
  const plan = stored(f, inner.data.id);
  assert.deepEqual(
    plan.steps.map(s => [s.id, s.gateway, Object.hasOwn(s.arguments, 'gateway')]),
    [
      ['campaign', META, false],
      ['adset', META, false],
    ],
  );
  // One warning for each step, naming where the caller wrote it and where it was read.
  assert.deepEqual(
    lifted(inner).map(w => [w.field, w.moved_to]),
    [
      ['steps[0].arguments.gateway', 'steps[0].gateway'],
      ['steps[1].arguments.gateway', 'steps[1].gateway'],
    ],
  );
  assert.match(lifted(inner)[0].message, /plan step takes beside its arguments/);
  // It is the plan the canonical shape makes, whose steps name the gateway themselves, and that plan draws no warning.
  const canonical = await create(f, {
    name: 'Synthetic plan, canonical',
    steps: [campaign({gateway: META}), adset({gateway: META})],
  });
  assert.equal(canonical.success, true, JSON.stringify(canonical.error));
  assert.deepEqual(lifted(canonical), []);
  assert.equal(stored(f, canonical.data.id).plan_hash, plan.plan_hash);
  assert.equal(f.requests(), 0);
});

test('a refused step shows the caller’s own gateway in its corrected step, not a placeholder, and the warning stays with the refusal', async t => {
  const f = harness(t),
    // The step is refused for what it lacks (the connection), after its gateway was read.
    refused = await create(f, {steps: [campaign({connection_id: undefined}, {gateway: META})]});
  assertRefused(refused, 'INVALID_ARGUMENT', {message: /^Step "campaign": connection_id is required/});
  assert.equal(refused.error.details.example.gateway, META);
  assert.deepEqual(
    lifted(refused).map(w => w.field),
    ['steps[0].arguments.gateway'],
  );
  // A step that is refused before its gateway could be lifted (a key it does not take) shows the same one: the corrected step
  // reads arguments.gateway itself. The step names a gateway of its own that is no gateway, so nothing is moved.
  const unsupported = await create(f, {
    steps: [{...campaign({}, {gateway: META}), gateway: 7, payload: {}}],
  });
  assertRefused(unsupported, 'INVALID_ARGUMENT', {message: /^Unsupported argument: payload/});
  assert.equal(unsupported.error.details.example.gateway, META);
  assert.deepEqual(lifted(unsupported), []);
  assert.equal(f.store.documents(operator.tenantId, 'campaign_run').length, 0, 'a refused plan is not saved');
});

test('a step that names a gateway of its own is never moved: a different one inside arguments stays where it is', async t => {
  const f = harness(t),
    created = await create(f, {steps: [campaign({gateway: META}, {gateway: TIKTOK})]});
  assert.equal(created.success, true, JSON.stringify(created.error));
  const [step] = stored(f, created.data.id).steps;
  assert.equal(step.gateway, META);
  assert.equal(step.arguments.gateway, TIKTOK);
  assert.deepEqual(lifted(created), []);
});

test('a gateway inside arguments that is not a registered gateway is not moved, and never comes back in the refusal', async t => {
  const f = harness(t);
  for (const inner of ['not_a_gateway', token, 7, null, {name: META}]) {
    const refused = await create(f, {steps: [campaign({}, {gateway: inner})]});
    assertRefused(refused, 'INVALID_ARGUMENT', {message: /^Step "campaign": a write step needs gateway/});
    assert.equal(refused.error.details.example.gateway, '<gateway>');
    assert.deepEqual(lifted(refused), []);
    assert.ok(!JSON.stringify(refused).includes(token));
  }
  assert.equal(f.store.documents(operator.tenantId, 'campaign_run').length, 0);
});

test('a media step has no gateway to lift: its arguments are left as the caller sent them', async t => {
  const f = harness(t),
    media = {
      id: 'logo',
      kind: 'media',
      connection_id: CONNECTION,
      account_id: '123',
      arguments: {platform: 'meta', source_url: 'https://example.com/synthetic.png', gateway: META},
    },
    created = await create(f, {steps: [media]});
  assert.equal(created.success, true, JSON.stringify(created.error));
  const [step] = stored(f, created.data.id).steps;
  assert.equal(step.gateway, undefined);
  assert.equal(step.arguments.gateway, META);
  assert.deepEqual(lifted(created), []);
});

test('a gateway lifted out of a step is the step’s own: beside a top-level default it is a mix only when it differs', async t => {
  const f = harness(t),
    // The same gateway as the top level: no mix, so the step that leaves it out is filled.
    same = await create(f, {
      gateway: META,
      steps: [campaign({connection_id: CONNECTION}), adset({}, {gateway: META})],
    });
  assert.equal(same.success, true, JSON.stringify(same.error));
  assert.deepEqual(
    stored(f, same.data.id).steps.map(s => s.gateway),
    [META, META],
  );
  assert.deepEqual(
    lifted(same).map(w => w.field),
    ['steps[1].arguments.gateway'],
  );
  // Another gateway: the plan names two, which the top level cannot decide between, so T4's refusal stays for the step without one.
  const mixed = await create(f, {gateway: META, steps: [campaign(), adset({}, {gateway: TIKTOK})]});
  assertRefused(mixed, 'INVALID_ARGUMENT', {message: /^Step "campaign": a write step needs gateway/});
  assert.deepEqual(mixed.error.details.move, [{from: 'gateway', to: 'steps[].gateway'}]);
  assert.equal(mixed.error.details.example.gateway, META);
});
