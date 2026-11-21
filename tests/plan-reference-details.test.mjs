import test from 'node:test';
import assert from 'node:assert/strict';
import {at, googleReconcileFixture} from './helpers/google-reconcile-fixture.mjs';
import {checkOf, step as providerStep, world} from './helpers/plan-reference-world.mjs';
import {campaignPreflight} from '../dist/src/campaign-preflight.js';
import {fingerprint, pointer} from '../dist/src/workspace-core.js';
import {MirrorError} from '../dist/src/errors.js';

/**
 * Package r25-field3-refs, item 5 (the owner's second Google report of 2026-11-21, AMCP-02, F2-2): a refused reference says what to send. Every
 * INVALID_REFERENCE and REFERENCE_UNAVAILABLE the plan's preflight or its runner can raise, at the nine sites the analysis lists, answered with
 * `details: {}`: the refusal named neither the step nor the pointer. Each now carries bounded details, step IDs, pointers, counts and key names only,
 * never a value, a provider ID or a signed link. The property below is the contract: it runs every refusal and asserts what the details hold.
 */
let tenants = 0;
const google = () => googleReconcileFixture({tenant: 'plan-reference-details-' + ++tenants});
const googleStep = (id, args, depends_on = []) => ({
  id,
  kind: 'write',
  gateway: 'google_ads_native_action',
  connection_id: 'g',
  account_id: '123',
  description: id,
  arguments: args,
  depends_on,
});
const assetAction = 'google_ads_v23_asset_mutate_assets',
  linkAction = 'google_ads_v23_campaign_asset_mutate_campaign_assets',
  group = at('assetGroups', '77'),
  campaign = at('campaigns', '10');
const texts = (id, n = 1) =>
  googleStep(id, {
    action: assetAction,
    payload: {
      operations: Array.from({length: n}, (_, i) => ({create: {text_asset: {text: 'Synthetic text ' + (i + 1)}}})),
    },
  });
const linkTo = (id, from, pointer, extra = {}) =>
  googleStep(
    id,
    {
      action: linkAction,
      payload: {
        operations: [{create: {campaign, field_type: 'SITELINK', asset: {$ref: from + '#' + pointer}, ...extra}}],
      },
    },
    [from],
  );

/** What a refusal's details may hold: bounded, and no value of a provider, no ID of one, no link and nothing that looks like a token. */
const forbidden = [
  [/https?:/i, 'a link'],
  [/[?&](?:sig|signature|token|key|access_token|x-amz-[a-z-]+)=/i, 'a signed link'],
  [/\beyJ[A-Za-z0-9_-]{8,}/, 'a bearer token'],
  [/[A-Za-z0-9_-]{32,}/, 'a long opaque string'],
  [/customers\/\d/, 'a Google resource name'],
  [/urn:[a-z]+:[A-Za-z]+:\d/, 'a LinkedIn URN of an entity'],
  [/CANARY/, 'a value of the result'],
  [/\d{6,}/, 'a provider ID'],
];
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(v => strings(v, out));
  else if (value && typeof value === 'object')
    Object.entries(value).forEach(([k, v]) => (out.push(k), strings(v, out)));
  return out;
}
function assertBounded(details, name) {
  assert.ok(
    details && typeof details === 'object' && Object.keys(details).length > 0,
    name + ': the details are not empty',
  );
  assert.ok(
    ['predecessor', 'pointer', 'received_pointer'].some(k => Object.hasOwn(details, k)),
    name + ': the details name the predecessor or the pointer: ' + JSON.stringify(details),
  );
  for (const s of strings(details)) {
    assert.ok(s.length <= 200, name + ': a string of the details is bounded: ' + s.slice(0, 60));
    for (const [pattern, what] of forbidden)
      assert.ok(!pattern.test(s), name + ': the details hold ' + what + ': ' + s);
  }
  for (const v of Object.values(details))
    if (Array.isArray(v)) assert.ok(v.length <= 20, name + ': a list of the details has at most 20 entries');
  assert.ok(JSON.stringify(details).length <= 1500, name + ': the details are small');
}
const refusalOf = (out, id) => {
  const check = checkOf(out, id);
  assert.equal(check?.status, 'blocked', id + ' is blocked: ' + JSON.stringify(check));
  return check.error;
};

// The preflight: Google's sites (the predecessor is missing, is not Google's, has no receipt, the pointer, the association's field type), the
// build's (a pointer's form, an operation the build does not have, the result field of another type) and the generic one (an undeclared predecessor).
const preflightSites = {
  'a Google predecessor that is not in the plan': async f => {
    const out = await campaignPreflight(f.service, f.actor, [linkTo('after', 'ghost', '/data/results/0/resourceName')]);
    return refusalOf(out, 'after');
  },
  'a Google reference to a predecessor of another provider': async f => {
    const other = {
      id: 'tt',
      kind: 'write',
      gateway: 'tiktok_native_action',
      account_id: '123',
      arguments: {action: 'tiktok_adgroup_create', payload: {}},
      depends_on: [],
    };
    const out = await campaignPreflight(f.service, f.actor, [other, linkTo('after', 'tt', '/data/data/adgroup_id')]);
    return refusalOf(out, 'after');
  },
  'a Google predecessor that makes no mutation': async f => {
    const read = googleStep('look', {
      action: 'google_ads_v23_google_ads_search',
      payload: {query: 'SELECT campaign.id FROM campaign'},
    });
    const out = await campaignPreflight(f.service, f.actor, [
      read,
      linkTo('after', 'look', '/data/results/0/resourceName'),
    ]);
    return refusalOf(out, 'after');
  },
  'a service pointer past the results': async f => {
    const out = await campaignPreflight(f.service, f.actor, [
      texts('one', 2),
      linkTo('after', 'one', '/data/results/9/resourceName'),
    ]);
    return refusalOf(out, 'after');
  },
  'a service pointer of another form': async f => {
    const out = await campaignPreflight(f.service, f.actor, [
      texts('one', 2),
      linkTo('after', 'one', '/data/results/0/typo'),
    ]);
    return refusalOf(out, 'after');
  },
  'an association create without its field type': async f => {
    const bare = googleStep('bare', {
      action: linkAction,
      payload: {operations: [{create: {campaign, asset: at('assets', '5')}}]},
    });
    const out = await campaignPreflight(f.service, f.actor, [
      bare,
      googleStep(
        'after',
        {
          action: 'google_ads_v23_campaign_asset_mutate_campaign_assets',
          payload: {operations: [{remove: {$ref: 'bare#/data/results/0/resourceName'}}]},
        },
        ['bare'],
      ),
    ]);
    return refusalOf(out, 'after');
  },
  'a build pointer of the wrong form': async f => {
    const out = await campaignPreflight(f.service, f.actor, [
      buildStep(),
      linkTo('after', 'ar_build', '/data/results/1/resourceName'),
    ]);
    return refusalOf(out, 'after');
  },
  'a build pointer past its operations': async f => {
    const out = await campaignPreflight(f.service, f.actor, [
      buildStep(),
      linkTo('after', 'ar_build', '/data/mutateOperationResponses/99/campaignResult/resourceName'),
    ]);
    return refusalOf(out, 'after');
  },
  'a build pointer of another operation type': async f => {
    const out = await campaignPreflight(f.service, f.actor, [
      buildStep(),
      linkTo('after', 'ar_build', '/data/mutateOperationResponses/0/campaignResult/resourceName'),
    ]);
    return refusalOf(out, 'after');
  },
  'a snake_case build pointer': async f => {
    const out = await campaignPreflight(f.service, f.actor, [
      buildStep(),
      linkTo('after', 'ar_build', '/data/mutate_operation_responses/0/campaign_budget_result/resource_name'),
    ]);
    return refusalOf(out, 'after');
  },
  'a pointer that is not a pointer': async f => {
    const out = await campaignPreflight(f.service, f.actor, [
      buildStep(),
      linkTo('after', 'ar_build', '/data/results/0?token=SECRETSECRETSECRETSECRET123456789/resourceName'),
    ]);
    return refusalOf(out, 'after');
  },
};
function buildStep() {
  return googleStep('ar_build', {
    action: 'google_ads_v23_google_ads_mutate',
    payload: {
      mutate_operations: [
        {
          campaign_budget_operation: {
            create: {
              resource_name: at('campaignBudgets', '-1'),
              name: 'Synthetic budget',
              amount_micros: '40000000',
              delivery_method: 'STANDARD',
            },
          },
        },
      ],
    },
  });
}
for (const [name, run] of Object.entries(preflightSites))
  test(
    'F2-2 (preflight): ' +
      name +
      ' is refused INVALID_REFERENCE with bounded details naming the predecessor or the pointer',
    async () => {
      const f = google();
      try {
        const error = await run(f);
        assert.equal(error.code, 'INVALID_REFERENCE', name);
        assertBounded(error.details, name);
      } finally {
        f.close();
      }
    },
  );

test('F2-2 (preflight): a reference to a step the step does not depend on names the step and what it depends on', async () => {
  const w = world(['tiktok_native_action']);
  try {
    const out = await w.preflight([
      providerStep('tiktok_native_action', 'budget', {
        action: 'tiktok_adgroup_budget_update',
        payload: {budget: [{adgroup_id: {$ref: 'ag1#/data/data/adgroup_id'}, budget: 1200}]},
      }),
    ]);
    const error = refusalOf(out, 'budget');
    assert.equal(error.code, 'INVALID_REFERENCE');
    assertBounded(error.details, 'undeclared predecessor');
    assert.equal(error.details.predecessor, 'ag1');
    assert.deepEqual(error.details.depends_on, []);
  } finally {
    w.close();
  }
});

test('F2-2 (preflight): a predecessor that is no step ID is not repeated, and the refusal still names the field', async () => {
  const w = world(['tiktok_native_action']);
  try {
    const out = await w.preflight([
      providerStep('tiktok_native_action', 'budget', {
        action: 'tiktok_adgroup_budget_update',
        payload: {
          budget: [{adgroup_id: {$ref: 'https://files.example.test/a?sig=SECRETSECRETSECRET#/x'}, budget: 1200}],
        },
      }),
    ]);
    const error = refusalOf(out, 'budget');
    assert.equal(error.code, 'INVALID_REFERENCE');
    assert.equal(error.details.predecessor, null, 'text of another shape is not echoed');
    assertBounded(error.details, 'a link as a predecessor');
  } finally {
    w.close();
  }
});

// What the Google service refusal says: the form, and how many results the predecessor has.
test('F2-2 (preflight): a service pointer past the results names the form to send and the range of results', async () => {
  const f = google();
  try {
    const out = await campaignPreflight(f.service, f.actor, [
      texts('one', 3),
      linkTo('after', 'one', '/data/results/9/resourceName'),
    ]);
    const {details} = refusalOf(out, 'after');
    assert.equal(details.predecessor, 'one');
    assert.equal(details.received_pointer, '/data/results/9/resourceName');
    assert.equal(details.accepted_form, '/data/results/<i>/resourceName');
    assert.equal(details.range, '0..2');
  } finally {
    f.close();
  }
});

// The runner: the same step is prepared with the real results. The stored plan is edited after its preflight, as a plan saved with such a step would be
// (the preflight refuses these before a plan is approved, so only a plan edited or damaged in storage reaches the runner with them); its plan hash is
// sealed again, because the runner refuses a plan that no longer matches it (PLAN_CHANGED).
const structure = steps =>
  steps.map(s =>
    Object.fromEntries(
      [
        'id',
        'kind',
        'gateway',
        'connection_id',
        'account_id',
        'arguments',
        'depends_on',
        'description',
        'expected_currency',
        'prerequisites',
      ]
        .filter(k => s[k] !== undefined)
        .map(k => [k, s[k]]),
    ),
  );
async function planThrough(f, steps, edit) {
  const created = await f.call('amcp_campaign', {action: 'create', name: 'Synthetic plan', brief: 'Synthetic.', steps});
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 600));
  const id = created.data.id,
    call = input => f.call('amcp_campaign', {id, ...input}),
    preflight = await call({action: 'preflight'});
  assert.equal(preflight.success, true, JSON.stringify(preflight).slice(0, 600));
  const run = f.store.document(f.actor.tenantId, 'campaign_run', id);
  assert.equal(run.preflight?.status, 'ready', 'the preflight passed before the plan was edited');
  edit(run);
  run.plan_hash = fingerprint(structure(run.steps));
  f.store.putDocument(f.actor.tenantId, 'campaign_run', id, run, run.revision);
  const preview = await call({action: 'approve'});
  assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 600));
  const approved = await call({...preview.data.next_call.arguments, ...preview.data.next_call.add_after_user_approval});
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 600));
  // The run stops at the step it cannot prepare: the refusal is the call's own, or the step's.
  const ran = await call({action: 'run'});
  if (!ran.success) return ran.error;
  const got = await call({action: 'get', detail: 'full'});
  return got.data.steps.find(s => s.id === 'after').error;
}
const runnerSites = {
  'an undeclared predecessor at prepare': {
    code: 'INVALID_ARGUMENT',
    steps: () => [texts('one'), linkTo('after', 'one', '/data/results/0/resourceName')],
    edit: run => (run.steps.find(s => s.id === 'after').depends_on = []),
  },
  'a value that is no numeric ID under a LinkedIn prefix': {
    code: 'INVALID_REFERENCE',
    steps: () => [
      texts('one'),
      googleStep(
        'after',
        {
          action: assetAction,
          payload: {
            operations: [
              {
                create: {
                  text_asset: {text: {$ref: 'one#/data/results/0/resourceName', prefix: 'urn:li:sponsoredCampaign:'}},
                },
              },
            ],
          },
        },
        ['one'],
      ),
    ],
    edit: () => undefined,
  },
  'a pointer the step result does not hold': {
    code: 'REFERENCE_UNAVAILABLE',
    steps: () => [texts('one'), linkTo('after', 'one', '/data/results/0/resourceName')],
    edit: run => {
      run.steps.find(s => s.id === 'after').arguments.payload.operations[0].create.asset.$ref =
        'one#/data/results/7/resourceName';
    },
  },
};
for (const [name, site] of Object.entries(runnerSites))
  test(
    'F2-2 (runner): ' +
      name +
      ' is refused ' +
      site.code +
      ' with bounded details naming the predecessor or the pointer',
    async () => {
      const f = google();
      try {
        const error = await planThrough(f, site.steps(), site.edit);
        assert.equal(error?.code, site.code, JSON.stringify(error));
        assertBounded(error.details, name);
        if (site.code === 'REFERENCE_UNAVAILABLE') {
          assert.equal(error.details.pointer, '/data/results/7/resourceName');
          assert.equal(error.details.missing_at, '/data/results');
          assert.deepEqual(error.details.available_keys, []);
          assert.equal(error.details.array_length, 1);
        }
      } finally {
        f.close();
      }
    },
  );

// REFERENCE_UNAVAILABLE names the level that lacks the next part and the keys it has, field names only, so that no value or link of a result reaches a log.
test('F2-2: a missing reference names the pointer, the level that lacks the next part and its field names, never a value', () => {
  const result = {
    data: {
      results: [{resourceName: 'customers/999/assets/CANARY1'}],
      token: 'CANARYVALUE0123456789abcdef0123456789',
      'https://files.example.test/f?sig=CANARYKEY': 1,
      'a b': 2,
      123456789012: 3,
      name: 'CANARYNAME',
    },
  };
  const unavailable = run => {
    try {
      run();
    } catch (e) {
      if (e instanceof MirrorError) return e;
      throw e;
    }
    assert.fail('expected a refusal');
  };
  const missing = unavailable(() => pointer(result, '/data/nope/0'));
  assert.equal(missing.code, 'REFERENCE_UNAVAILABLE');
  assert.equal(missing.details.pointer, '/data/nope/0');
  assert.equal(missing.details.missing_at, '/data');
  assert.deepEqual(missing.details.available_keys.sort(), ['name', 'results', 'token']);
  assertBounded(missing.details, 'missing key');
  // At the root: the level is the whole result.
  const root = unavailable(() => pointer(result, '/dat/results'));
  assert.equal(root.details.missing_at, '/');
  assert.deepEqual(root.details.available_keys, ['data']);
  // An array has no keys, only a length; a scalar says what it is.
  const array = unavailable(() => pointer(result, '/data/results/3'));
  assert.deepEqual(array.details.available_keys, []);
  assert.equal(array.details.array_length, 1);
  assertBounded(array.details, 'array');
  const scalar = unavailable(() => pointer(result, '/data/name/deeper'));
  assert.equal(scalar.details.found_type, 'string');
  assertBounded(scalar.details, 'scalar');
  // No more than twenty names, however many the level has.
  const wide = unavailable(() =>
    pointer({data: Object.fromEntries(Array.from({length: 60}, (_, i) => ['field_' + i, i]))}, '/data/absent'),
  );
  assert.equal(wide.details.available_keys.length, 20);
  assert.equal(wide.details.available_keys_total, 60);
  // A pointer of another shape is refused without its text.
  const odd = unavailable(() => pointer(result, '/data/x?sig=SECRETSECRETSECRETSECRET1234/y'));
  assert.equal(odd.details.pointer, null);
});
