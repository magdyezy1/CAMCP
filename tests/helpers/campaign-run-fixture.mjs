// A campaign runner over a synthetic Snapchat connection and a stand-in for the tool calls its steps make, for the tests of the
// approval summary, the blocked plan and the progress of a run (R2.5 field3, package r25-field3-approvals). The stand-in is the
// one of tests/campaign-plan-spend.test.mjs: `needs` says, by step, what that step's review asks execute for, and a review whose
// acknowledgement execute was not given is refused as execute refuses it, so an attempt without a flag is visible even though
// nothing was sent. Every number it counts is the test's to read: preflights run, prepares, executes attempted, writes sent.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../../dist/src/store.js';
import {CampaignRunner} from '../../dist/src/campaign-runner.js';

export const tenantId = 'plan-approvals-' + randomUUID();
export const alice = {tenantId, userId: 'alice', role: 'operator'},
  bob = {tenantId, userId: 'bob', role: 'operator'},
  carol = {tenantId, userId: 'carol', role: 'operator'},
  admin = {tenantId, userId: 'owner-admin', role: 'admin'};
const flags = ['spend_change_confirmed', 'cap_override_confirmed', 'creative_edit_confirmed', 'destructive_confirmed'];

/** A preflight that checked every step and blocked none. */
export const readyPreflight = steps => ({
  status: 'ready',
  checked_at: Date.now(),
  provider_mutations: 0,
  checks: steps.map(s => ({step: s.id, status: 'ready'})),
});
/** A preflight that blocked the named steps, as the pixel check of Snapchat blocks an ad squad whose pixel the account does not own. */
export const blockedPreflight = (steps, blocked = []) => ({
  status: blocked.length ? 'blocked' : 'ready',
  checked_at: Date.now(),
  provider_mutations: 0,
  checks: steps.map(s =>
    blocked.includes(s.id)
      ? {
          step: s.id,
          status: 'blocked',
          error: {
            code: 'SNAPCHAT_PIXEL_NOT_OWNED',
            message: 'The pixel is not owned by this account.',
            details: {pixel_ids: ['pixel-x'], owned_pixel_ids: ['pixel-own']},
          },
        }
      : {step: s.id, status: 'ready'},
  ),
});

/**
 * `needs`: by step, the keys of execute_requirements its review sets. `effects`: what the local compile says of each step's spend
 * effect. `preflight`: how the prerequisite check answers (`(steps) => result`). `before`: `{prepare, execute, verify}` hooks run with
 * the step's marker where the stand-in does that work, for a test that makes a step take time.
 */
export function fixture({needs = {}, effects = new Map(), preflight = readyPreflight, hooks = {}} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 63).toString('base64'));
  for (const user of ['alice', 'bob', 'carol'])
    store.db
      .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
      .run(tenantId, user, 'operator', Date.now());
  store.putConnection(
    admin,
    {
      id: 'snap',
      tenantId,
      gateway: 'snapchat_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Snapchat',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const state = {
    needs,
    effects,
    preflight,
    reviews: new Map(),
    preflights: 0,
    prepares: [],
    attempts: [],
    sent: [],
    verified: [],
    count: 0,
  };
  const call = async (name, input) => {
    assert.equal(name, 'amcp_write');
    if (input.action === 'prepare') {
      const marker = input.arguments.payload.marker,
        id = 'review-' + ++state.count;
      state.reviews.set(id, marker);
      state.prepares.push(marker);
      await hooks.prepare?.(marker);
      return {
        success: true,
        data: {
          review_id: id,
          idempotency_key: id,
          expires_at: new Date(Date.now() + 300000).toISOString(),
          request: input.arguments,
          execute_requirements: {
            confirmed: true,
            idempotency_key: id,
            ...Object.fromEntries(flags.map(flag => [flag, state.needs[marker]?.[flag] === true])),
            reasons: [],
          },
        },
      };
    }
    assert.equal(input.action, 'execute');
    const marker = state.reviews.get(input.review_id),
      attempt = {marker, ...Object.fromEntries(flags.map(flag => [flag, input[flag]]))};
    state.attempts.push(attempt);
    const missing = flags.find(flag => state.needs[marker]?.[flag] === true && input[flag] !== true);
    if (missing)
      return {
        success: false,
        error: {code: 'SPEND_CONFIRMATION_REQUIRED', message: 'This review needs ' + missing + '.', details: {}},
      };
    // The claim is the idempotency record every executed write leaves; a stop must never leave one pending.
    store.claim(tenantId, input.review_id, 'request');
    await hooks.execute?.(marker);
    state.sent.push(attempt);
    const result = {data: {marker}};
    store.complete(tenantId, input.review_id, result);
    return {success: true, data: result};
  };
  const runner = new CampaignRunner(
    store,
    call,
    async (_actor, reviewId) => {
      const marker = state.reviews.get(reviewId);
      state.verified.push(marker);
      await hooks.verify?.(marker);
      return {status: 'verified'};
    },
    async () => ({}),
    async (_actor, steps) => {
      state.preflights++;
      return state.preflight(steps);
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => state.effects,
  );
  const as = who => input => runner.handle(input, who);
  /** The plan with these step IDs, one write step each, saved by `who`; `money` gives each a budget field, so the plan changes spending. */
  const plan = async (ids, who = alice, name = 'Go live', {money = false} = {}) =>
    (
      await as(who)({
        action: 'create',
        name,
        brief: 'Synthetic.',
        steps: ids.map((id, i) => ({
          id,
          kind: 'write',
          gateway: 'snapchat_native_action',
          connection_id: 'snap',
          account_id: '123',
          description: id,
          ...(i ? {depends_on: [ids[i - 1]]} : {}),
          arguments: {
            action: money ? 'snapchat_adsquad_update' : 'snapchat_campaign_update',
            payload: {marker: id, ...(money ? {daily_budget_micro: 1000000} : {})},
          },
        })),
      })
    ).id;
  /** What a stored plan holds now. */
  const stored = id => store.document(tenantId, 'campaign_run', id);
  /** Everything a call that only reads must leave as it found it: the plans, the audit trail and the idempotency claims. */
  const snapshot = () =>
    JSON.stringify({
      documents: store.db.prepare('SELECT * FROM documents ORDER BY rowid').all(),
      audit: store.db.prepare('SELECT COUNT(*) AS n FROM audit').get(),
      idempotency: store.db.prepare('SELECT * FROM idempotency ORDER BY rowid').all(),
    });
  return {store, state, runner, alice: as(alice), bob: as(bob), carol: as(carol), as, plan, stored, snapshot};
}
/** Approves a plan the way an agent does: the summary, then its next call with, or without, the flag the call adds. */
export async function approve(f, id, {flag = true, who = f.alice} = {}) {
  const preview = await who({action: 'approve', id});
  const approved = await who({
    ...preview.next_call.arguments,
    ...(flag ? preview.next_call.add_after_user_approval : {}),
  });
  return {preview, approved};
}
export const writes = f => f.state.sent.map(s => s.marker);
/**
 * Amends a step in place, the one way a plan allows it: the preflight blocks the step, then recover_step sends its corrected arguments
 * (a step that was never blocked or refused cannot be amended). That changes the plan's hash, so any summary or approval of it is stale.
 * The preflight answers ready again afterwards.
 */
export async function amend(f, id, stepId, note) {
  f.state.preflight = steps => blockedPreflight(steps, [stepId]);
  await f.alice({action: 'preflight', id});
  f.state.preflight = readyPreflight;
  const step = f.stored(id).steps.find(s => s.id === stepId);
  return f.alice({
    action: 'recover_step',
    id,
    step_id: stepId,
    confirmed: true,
    arguments: {...step.arguments, payload: {...step.arguments.payload, note}},
  });
}
