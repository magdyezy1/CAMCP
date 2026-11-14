import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {NativeTransport} from '../dist/src/transport.js';
import {MirrorService} from '../dist/src/service.js';

/**
 * Ruling 16 (8), found by the sec-followup-2 report: the compact view of a campaign step (`reviewView`, what `prepare_next` returns
 * without detail "full") picked `request` from the review but not `redacted`, the list that P2A-02 added beside it. An approver reading
 * a step's default view saw `[REDACTED]` in the request with nothing to say that a value was hidden or where. The view keeps the list
 * beside the request, and only when the review has one. Synthetic values only.
 */
const registry = new Registry(),
  key = Buffer.alloc(32, 33).toString('base64'),
  actor = {tenantId: 'step-redacted', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'},
  policy = {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  connection = 'bbbbbbbb-3333-4333-8333-333333333333';
function setup(current = 'Draft') {
  const store = new Store(':memory:', key);
  store.putConnection(
    admin,
    {
      id: connection,
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  store.rememberResource({id: connection, tenantId: actor.tenantId, gateway: 'meta_native_action'}, '123', '111');
  const transport = new NativeTransport(async (url, init) => {
    const id = new URL(String(url)).pathname.split('/').at(-1);
    if (init.method === 'GET')
      return Response.json(
        id === 'act_123'
          ? {id: 'act_123', currency: 'USD', account_status: 1}
          : {id, name: current, status: 'PAUSED', objective: 'OUTCOME_TRAFFIC'},
      );
    return Response.json({id: '111'});
  });
  return {store, service: new MirrorService(registry, store, transport, undefined, policy)};
}
const create = name => ({
  id: 'campaign',
  kind: 'write',
  gateway: 'meta_native_action',
  connection_id: connection,
  account_id: '123',
  arguments: {
    action: 'meta_campaign_create',
    payload: {
      name,
      status: 'PAUSED',
      objective: 'OUTCOME_TRAFFIC',
      special_ad_categories: [],
      is_adset_budget_sharing_enabled: false,
    },
  },
  depends_on: [],
});
const update = name => ({
  id: 'rename',
  kind: 'write',
  gateway: 'meta_native_action',
  connection_id: connection,
  account_id: '123',
  arguments: {action: 'meta_campaign_update', path_params: {campaign_id: '111'}, payload: {name}},
  depends_on: [],
});
async function prepareStep(x, step, detail) {
  const created = await x.service.call(
    'amcp_campaign',
    {action: 'create', name: 'Synthetic plan', brief: 'Synthetic.', steps: [step]},
    actor,
  );
  assert.equal(created.success, true, JSON.stringify(created));
  const id = created.data.id,
    prepared = await x.service.call('amcp_campaign', {action: 'prepare_next', id, ...(detail ? {detail} : {})}, actor);
  assert.equal(prepared.success, true, JSON.stringify(prepared));
  return {id, prepared: prepared.data, stored: x.store.document(actor.tenantId, 'campaign_run', id).steps[0].review};
}
const namePath = '$["body"]["name"]';

test('the default view of a step whose request holds a credential-shaped value lists the path of what it hides, beside the request (Ruling 16)', async () => {
  const x = setup();
  try {
    const {prepared, stored} = await prepareStep(x, create('Win now &password=hunter2 b c'));
    assert.equal(prepared.view, 'compact', 'the default view');
    assert.ok(prepared.review.request.body.name.includes('[REDACTED]'), 'the request hides the value');
    assert.ok(!JSON.stringify(prepared).includes('hunter2'), 'nothing of the value is in the view');
    assert.deepEqual(prepared.review.redacted, [{path: namePath}], 'the list names the path and nothing else');
    // It is the review's own list, not a second one: the stored review and the full view carry the same.
    assert.deepEqual(prepared.review.redacted, stored.redacted);
    // The compact view is still compact: no raw before-state and no other field of the review.
    assert.equal(prepared.review.before_state, undefined);
  } finally {
    x.store.close();
  }
});

test('the default view of a step with nothing credential-shaped carries no list, and shows ordinary text whole (Ruling 16)', async () => {
  const x = setup();
  try {
    const text = 'Cookie: visit https://evil.example/landing now',
      {prepared, stored} = await prepareStep(x, create(text));
    assert.equal(prepared.review.request.body.name, text);
    assert.equal(Object.hasOwn(prepared.review, 'redacted'), false, 'no list when nothing was hidden');
    assert.equal(stored.redacted, undefined);
  } finally {
    x.store.close();
  }
});

test('the list in the default view is the stored review’s own, as the step read and the full view return it (Ruling 16)', async () => {
  const x = setup();
  try {
    const {id, prepared, stored} = await prepareStep(x, create('Win now &token=abc123 b c')),
      step = await x.service.call('amcp_campaign', {action: 'get', id, step_id: 'campaign'}, actor);
    assert.deepEqual(step.data.step.review.redacted, [{path: namePath}]);
    assert.deepEqual(prepared.review.redacted, step.data.step.review.redacted);
    assert.deepEqual(prepared.review.redacted, stored.redacted);
    // A step prepared with detail "full" returns the whole review, the list and the before-state included.
    const fresh = await prepareStep(x, create('Win now &token=abc123 b c'), 'full');
    assert.deepEqual(fresh.prepared.review.redacted, prepared.review.redacted);
    assert.ok(Object.hasOwn(fresh.prepared.review, 'before_state'), 'the full view has the before-state');
  } finally {
    x.store.close();
  }
});
test('the list of an edit step names the hidden value of the before-state under its own root, as the review lists it (Ruling 16)', async () => {
  const x = setup('Win now &password=hunter2 b c');
  try {
    const {prepared, stored} = await prepareStep(x, update('Plain new name'));
    assert.ok(!JSON.stringify(prepared).includes('hunter2'), 'nothing of the value is in the view');
    assert.ok(stored.redacted.length > 0, 'the review lists the hidden before-state');
    assert.ok(
      stored.redacted.every(entry => entry.path.startsWith('$["before_state"]')),
      JSON.stringify(stored.redacted),
    );
    assert.deepEqual(prepared.review.redacted, stored.redacted);
  } finally {
    x.store.close();
  }
});
