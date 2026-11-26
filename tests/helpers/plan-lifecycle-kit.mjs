import assert from 'node:assert/strict';
import {campaign, googleWorld} from '../../dist/tests/helpers/google-write-fake.js';
import {createPlan, on} from './google-policy-failure.mjs';
import {keywordWorld} from './google-keyword-group.mjs';

/**
 * What the tests of the second round of r25-planmodel (the independent review of 451169fd: M1 to M9) share: a synthetic Google customer 123, a plan of budget steps, and the
 * means to hold an execute where the review put it (a lock held, a provider reply held after the write, a read-back held) while another call acts on the plan.
 */
export const T = 'google-world',
  budgetAction = 'campaign_budget_mutate_campaign_budgets',
  statusAction = 'campaign_mutate_campaigns',
  budgets = (n, label = 'Synthetic budget ') =>
    Array.from({length: n}, (_, i) => ({
      create: {name: label + i, amount_micros: '50000000', delivery_method: 'STANDARD'},
    })),
  // The step that turns a campaign on: its target is read back, so a reconcile can tell that nothing was applied.
  statusUpdate = [{update: {resource_name: campaign(9), status: 'ENABLED'}, update_mask: 'status'}],
  step = (operations, id = 'step1', action = budgetAction) => ({
    id,
    kind: 'write',
    gateway: 'google_ads_native_action',
    connection_id: 'g',
    account_id: '123',
    description: id,
    arguments: {action: 'google_ads_v23_' + action, payload: {operations}},
  }),
  owner = {tenantId: T, userId: 'owner', role: 'admin'},
  approver = {tenantId: T, userId: 'approver', role: 'admin'},
  executeNext = (x, id, review_id, extra = {}) =>
    x.call('amcp_campaign', {
      action: 'execute_next',
      id,
      review_id,
      idempotency_key: review_id,
      confirmed: true,
      spend_change_confirmed: true,
      ...extra,
    }),
  stored = (x, id) => x.store.document(T, 'campaign_run', id),
  tick = ms => new Promise(resolve => setTimeout(resolve, ms)),
  writesHolding = (x, text) => x.log.filter(r => r.kind === 'write' && JSON.stringify(r.body).includes(text)).length,
  claimState = (x, key) => x.store.db.prepare('SELECT state FROM idempotency WHERE key=?').get(key)?.state ?? 'none',
  // The plan and each step as one line, to say what a failing assertion saw.
  show = (x, id) => {
    const p = stored(x, id);
    return (
      p.state +
      ' [' +
      p.steps.map(s => s.id + '=' + s.status + (s.error ? '(' + (s.error.code ?? s.error) + ')' : '')).join(' ') +
      ']'
    );
  },
  // A change to the amount of the first budget: the amendment recover_step makes.
  amendment = [{path: '/payload/operations/0/create/amount_micros', value: '60000000'}];
/** A plan with one prepared step, waiting for its execute. */
export async function planned(operations, {action = budgetAction, world} = {}) {
  const x = googleWorld({
      policy: on,
      world:
        world ??
        (action === statusAction
          ? {...keywordWorld(), campaignBudgets: {'customers/123/campaignBudgets/1': {}}}
          : keywordWorld()),
    }),
    id = await createPlan(x, [step(operations, 'step1', action)]);
  assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
  return {x, id, review: stored(x, id).steps[0].review_id};
}
/** A plan of several budget steps, the first prepared. `depends` makes each step wait for the one before it. */
export async function plannedSteps(count, {depends = false} = {}) {
  const x = googleWorld({policy: on, world: keywordWorld()}),
    id = await createPlan(
      x,
      Array.from({length: count}, (_, i) => ({
        ...step(budgets(1, 'Step ' + (i + 1) + ' budget '), 's' + (i + 1)),
        ...(depends && i ? {depends_on: ['s' + i]} : {}),
      })),
    );
  assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
  return {x, id, review: stored(x, id).steps[0].review_id};
}
/** Another person approves the plan as it is now. */
export async function approveAs(x, id) {
  const preview = await x.service.call('amcp_campaign', {action: 'approve', id}, approver);
  assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 300));
  const approved = await x.service.call(
    'amcp_campaign',
    {...preview.data.next_call.arguments, ...preview.data.next_call.add_after_user_approval},
    approver,
  );
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 300));
}
/** The call a read names, as the person who approves it makes it. */
export const follow = (x, next) => x.call(next.tool, {...next.arguments, ...(next.add_after_user_approval ?? {})});
/** A door: `p` waits until `open()`. */
export function door() {
  let open;
  const p = new Promise(resolve => (open = resolve));
  return {p, open};
}
/**
 * Every attempt to take the target lock is refused until `release`: an execute that has saved its step as executing waits there, before anything is claimed or sent.
 * `only` limits it to the first execute that comes to the lock (the others take their locks as they would).
 */
export function holdTargetLock(x, {only = false} = {}) {
  const take = x.store.acquireLocks.bind(x.store),
    lock = {held: true, attempts: 0};
  let first;
  x.store.acquireLocks = (keys, owner, ttl) => {
    if (!lock.held || !keys.length || (only && first !== undefined && first !== owner)) return take(keys, owner, ttl);
    first ??= owner;
    lock.attempts++;
    return false;
  };
  return {
    release: () => {
      lock.held = false;
    },
    waiting: async () => {
      for (let i = 0; i < 1000 && lock.attempts === 0; i++) await tick(10);
      assert.ok(lock.attempts > 0, 'the execute came to wait for its target');
    },
  };
}
/**
 * A gate on the transport: `rules` hold the nth request of a kind (`read`, `write`, `validation`) until a door opens, before it is sent (`when` omitted) or after the provider
 * answered it (`when: 'after'`). `arrived()` waits until a request is at a gate.
 */
export function gateTransport(x) {
  const transport = x.service.transport,
    real = transport.fetcher,
    gate = {seen: {read: 0, write: 0, validation: 0}, rules: [], waiting: 0};
  transport.fetcher = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')),
      kind = String(url).endsWith('googleAds:search')
        ? 'read'
        : body.validateOnly === true || body.validate_only === true
          ? 'validation'
          : 'write',
      n = ++gate.seen[kind],
      before = gate.rules.find(r => r.kind === kind && r.nth === n && r.when !== 'after');
    if (before?.hold) {
      gate.waiting++;
      await before.hold;
    }
    const out = await real(url, init),
      after = gate.rules.find(r => r.kind === kind && r.nth === n && r.when === 'after');
    if (after?.hold) {
      gate.waiting++;
      await after.hold;
    }
    return out;
  };
  gate.arrived = async () => {
    for (let i = 0; i < 1000 && gate.waiting === 0; i++) await tick(10);
    assert.ok(gate.waiting > 0, 'a request came to the gate');
  };
  return gate;
}
/** Sets an environment variable for the span of `body`, and puts it back. */
export async function withEnv(name, value, body) {
  const before = process.env[name];
  process.env[name] = value;
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
}
