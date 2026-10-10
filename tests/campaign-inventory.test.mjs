// CMP-05: plan inventory and team handoff. The 500-plan bound counts plans that are not archived (it used to count
// every plan of every state, a dead end once reached); archived plans stay readable; lists are newest first with a
// cursor and filters; retention of archived plans is opt-in and keeps audit and receipts; collaborators act by role
// within their account access; an owner policy can require a different approver for spending plans.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Store} from '../dist/src/store.js';
import {CampaignRunner} from '../dist/src/campaign-runner.js';
import {campaignRecipe} from '../dist/src/campaign-recipes.js';
import {cleanupReports, ownerOperations} from '../dist/src/owner-operations.js';
import {dashboard} from '../dist/src/dashboard.js';
import {MirrorError, errorRemedy} from '../dist/src/errors.js';

const examples = JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'));
const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const created = {
  snapchat_campaign_create: {campaigns: [{campaign: {id: uuid(1)}}]},
  snapchat_adsquad_create: {adsquads: [{adsquad: {id: uuid(2)}}]},
  snapchat_ad_create: {ads: [{ad: {id: uuid(3)}}]},
};

/** A workspace with an owner (alice), colleagues (bob, carol), a workspace viewer (vera) and an administrator. */
function team(seed = 41) {
  const tenantId = 'team-' + randomUUID(),
    store = new Store(':memory:', Buffer.alloc(32, seed).toString('base64')),
    actor = (userId, role = 'operator') => ({tenantId, userId, role});
  const people = {
    alice: actor('alice'),
    bob: actor('bob'),
    carol: actor('carol'),
    vera: actor('vera', 'reader'),
    admin: actor('owner-admin', 'admin'),
  };
  for (const [user, role] of [
    ['alice', 'operator'],
    ['bob', 'operator'],
    ['carol', 'operator'],
    ['vera', 'viewer'],
  ])
    store.db
      .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
      .run(tenantId, user, role, Date.now());
  store.putConnection(
    people.admin,
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
  const state = {prepares: [], executes: 0, count: 0};
  const runner = new CampaignRunner(
    store,
    async (name, input, who) => {
      if (input.action === 'prepare') {
        state.prepares.push({by: who.userId, args: input.arguments});
        const id = 'review-' + ++state.count;
        return {
          success: true,
          data: {
            review_id: id,
            idempotency_key: id,
            expires_at: new Date(Date.now() + 300000).toISOString(),
            request: input.arguments,
          },
        };
      }
      state.executes++;
      store.claim(tenantId, input.review_id, 'request');
      const result = {data: created[state.prepares.at(-1).args.action] ?? {}};
      store.complete(tenantId, input.review_id, result);
      return {success: true, data: result};
    },
    async () => ({status: 'verified'}),
    async () => ({}),
    async () => ({status: 'ready', checks: []}),
  );
  const as = who => input => runner.handle(input, who);
  return {tenantId, store, people, state, as};
}
const launch = (call, name = 'Snapchat launch') =>
  call({
    action: 'create',
    name,
    brief: 'Synthetic.',
    steps: campaignRecipe('snapchat_website_traffic', {...examples.snapchat_traffic_business, connection_id: 'snap'})
      .steps,
  });
/** A synthetic plan document saved directly, for inventory counts and order. */
function putPlan(store, tenantId, owner, data = {}) {
  const id = data.id ?? randomUUID();
  store.putDocument(tenantId, 'campaign_run', id, {
    name: 'Plan ' + id.slice(0, 8),
    user_id: owner,
    principal: owner,
    state: 'draft',
    steps: [
      {id: 'campaign', kind: 'write', gateway: 'snapchat_native_action', connection_id: 'snap', account_id: '123'},
    ],
    created_at: 1,
    updated_at: 1,
    plan_hash: 'synthetic',
    ...data,
  });
  return id;
}
const events = (store, tenantId) =>
  store.db
    .prepare('SELECT event FROM audit WHERE tenant_id=?')
    .all(tenantId)
    .map(r => JSON.parse(r.event));

test('archiving one of 500 plans lets a new plan be created; an archived plan stays readable (was a permanent dead end)', async () => {
  const f = team(),
    alice = f.as(f.people.alice);
  try {
    const kept = await launch(alice, 'Finished launch');
    for (let i = 0; i < 499; i++) putPlan(f.store, f.tenantId, 'alice');
    // 500 plans that are not archived: the bound refuses, and names the remedy.
    await assert.rejects(
      () => launch(alice),
      e => {
        assert.equal(e.code, 'PLAN_LIMIT_REACHED');
        assert.equal(e.details.limit, 500);
        assert.match(errorRemedy(e).action, /archive/);
        return true;
      },
    );
    // Only a plan nothing remains to run in is archived, and only with confirmation.
    await assert.rejects(() => alice({action: 'archive', id: kept.id, confirmed: true}), {code: 'PLAN_NOT_ARCHIVABLE'});
    await alice({action: 'cancel', id: kept.id, confirmed: true});
    await assert.rejects(() => alice({action: 'archive', id: kept.id}), {code: 'INVALID_ARGUMENT'});
    const archived = await alice({action: 'archive', id: kept.id, confirmed: true});
    assert.equal(typeof archived.archived_at, 'number');
    // One archived, 499 active: a new plan fits.
    const next = await launch(alice, 'Next launch');
    assert.equal(next.state, 'draft');
    // get still returns the archived plan; the default list leaves it out, archived: true lists it.
    assert.equal((await alice({action: 'get', id: kept.id, detail: 'full'})).archived.by, 'alice');
    const listed = await alice({action: 'list', search: 'finished launch'});
    assert.deepEqual(listed.campaigns, []);
    const only = await alice({action: 'list', archived: true});
    assert.deepEqual(
      only.campaigns.map(c => [c.id, c.archived]),
      [[kept.id, true]],
    );
    // Archived plans refuse work until unarchived, and unarchiving needs room again under the bound.
    await assert.rejects(() => alice({action: 'prepare_next', id: kept.id}), {code: 'PLAN_ARCHIVED'});
    await assert.rejects(() => alice({action: 'unarchive', id: kept.id}), {code: 'PLAN_LIMIT_REACHED'});
    await alice({action: 'archive', id: next.id, confirmed: true}).catch(e =>
      assert.equal(e.code, 'PLAN_NOT_ARCHIVABLE'),
    );
    f.store.deleteDocument(f.tenantId, 'campaign_run', next.id);
    const restored = await alice({action: 'unarchive', id: kept.id});
    assert.equal(restored.archived_at, undefined);
    assert.deepEqual(
      events(f.store, f.tenantId)
        .filter(e => /^campaign_plan_(un)?archived$/.test(e.event))
        .map(e => [e.event, e.actor]),
      [
        ['campaign_plan_archived', 'alice'],
        ['campaign_plan_unarchived', 'alice'],
      ],
    );
  } finally {
    f.store.close();
  }
});

test('list is newest first with a cursor bound to its filters, and filters by state, account and search', async () => {
  const f = team(42),
    alice = f.as(f.people.alice);
  try {
    const ids = [];
    for (let i = 1; i <= 5; i++)
      ids.push(
        putPlan(f.store, f.tenantId, 'alice', {
          name: 'Client ' + (i % 2 ? 'Acme' : 'Zen') + ' ' + i,
          state: i === 5 ? 'complete' : 'draft',
          updated_at: 1000 + i,
        }),
      );
    putPlan(f.store, f.tenantId, 'bob', {name: 'Not mine', updated_at: 5000});
    const first = await alice({action: 'list', limit: 2});
    assert.deepEqual(
      first.campaigns.map(c => c.id),
      [ids[4], ids[3]],
    );
    assert.equal(first.total, 5);
    assert.equal(first.has_more, true);
    assert.deepEqual(first.campaigns[0].platforms, ['snapchat']);
    assert.deepEqual(first.campaigns[0].accounts, [{gateway: 'snapchat_native_action', account_id: '123'}]);
    assert.equal(first.campaigns[0].access, 'owner');
    assert.equal(first.campaigns[0].steps, undefined, 'rows carry a summary, not the plan');
    const second = await alice({action: 'list', limit: 2, cursor: first.next_cursor});
    assert.deepEqual(
      second.campaigns.map(c => c.id),
      [ids[2], ids[1]],
    );
    const third = await alice({action: 'list', limit: 2, cursor: second.next_cursor});
    assert.deepEqual(
      third.campaigns.map(c => c.id),
      [ids[0]],
    );
    assert.equal(third.has_more, false);
    assert.equal(third.next_cursor, null);
    // A cursor continues only the filters and page size it was issued for.
    await assert.rejects(() => alice({action: 'list', limit: 2, state: 'draft', cursor: first.next_cursor}), {
      code: 'INVALID_CURSOR',
    });
    await assert.rejects(() => f.as(f.people.bob)({action: 'list', limit: 2, cursor: first.next_cursor}), {
      code: 'INVALID_CURSOR',
    });
    assert.deepEqual(
      (await alice({action: 'list', state: 'complete'})).campaigns.map(c => c.id),
      [ids[4]],
    );
    assert.deepEqual(
      (await alice({action: 'list', search: 'acme'})).campaigns.map(c => c.id),
      [ids[4], ids[2], ids[0]],
    );
    assert.equal((await alice({action: 'list', account_id: '123', gateway: 'snapchat_native_action'})).total, 5);
    assert.equal((await alice({action: 'list', account_id: '999'})).total, 0);
    // The offset continuation still works for existing callers.
    assert.deepEqual(
      (await alice({action: 'list', limit: 2, offset: 2})).campaigns.map(c => c.id),
      [ids[2], ids[1]],
    );
    // An administrator sees every plan; a colleague sees none of alice's.
    assert.equal((await f.as(f.people.admin)({action: 'list'})).total, 6);
    assert.equal((await f.as(f.people.bob)({action: 'list'})).total, 1);
  } finally {
    f.store.close();
  }
});

test('archived-plan retention is opt-in and keeps audit records and write receipts', async () => {
  const f = team(43);
  try {
    const old = putPlan(f.store, f.tenantId, 'alice', {state: 'complete', archived: {at: Date.now() - 40 * 86400000}}),
      recent = putPlan(f.store, f.tenantId, 'alice', {state: 'complete', archived: {at: Date.now() - 86400000}}),
      active = putPlan(f.store, f.tenantId, 'alice', {state: 'draft', updated_at: 1});
    f.store.putDocument(f.tenantId, 'write_verification', 'receipt-1', {status: 'verified', run_id: old});
    f.store.appendAudit(f.tenantId, 'plan-audit', {event: 'campaign_plan_created', id: old});
    // Without the owner's setting nothing is purged.
    cleanupReports(f.store);
    assert.equal(f.store.documents(f.tenantId, 'campaign_run').length, 3);
    const owner = f.people.admin;
    assert.throws(() => ownerOperations(f.store, {action: 'save_retention', archived_campaign_plans_days: 3}, owner), {
      code: 'INVALID_RETENTION',
    });
    const saved = ownerOperations(
      f.store,
      {action: 'save_retention', archived_campaign_plans_days: 30, confirmed: true},
      owner,
    );
    assert.equal(saved.archived_campaign_plans_days, 30);
    assert.equal(saved.days, null, 'the report retention stays unset');
    assert.throws(
      () =>
        ownerOperations(
          f.store,
          {action: 'save_retention', archived_campaign_plans_days: 30, confirmed: true},
          f.people.alice,
        ),
      {code: 'OWNER_REQUIRED'},
    );
    cleanupReports(f.store);
    assert.deepEqual(
      f.store
        .documents(f.tenantId, 'campaign_run')
        .map(r => r.id)
        .sort(),
      [recent, active].sort(),
    );
    assert.equal(f.store.documents(f.tenantId, 'write_verification').length, 1, 'receipts are kept');
    const audit = events(f.store, f.tenantId);
    assert.ok(
      audit.some(e => e.event === 'campaign_plan_created' && e.id === old),
      'audit is kept',
    );
    assert.ok(audit.some(e => e.event === 'campaign_plans_purged' && e.count === 1 && e.ids[0] === old));
    // Report retention is still saved on its own, and 0 turns plan retention off again.
    ownerOperations(f.store, {action: 'save_retention', days: 30, confirmed: true}, owner);
    assert.equal(ownerOperations(f.store, {action: 'health'}, owner).retention.archived_campaign_plans_days, 30);
    ownerOperations(f.store, {action: 'save_retention', archived_campaign_plans_days: 0, confirmed: true}, owner);
    const retention = ownerOperations(f.store, {action: 'health'}, owner).retention;
    assert.equal(retention.days, 30);
    assert.equal(retention.archived_campaign_plans_days, undefined);
  } finally {
    f.store.close();
  }
});

test('collaborators act by role: a viewer reads, an editor prepares, an approver approves and runs', async () => {
  const f = team(44),
    alice = f.as(f.people.alice),
    bob = f.as(f.people.bob),
    carol = f.as(f.people.carol);
  try {
    const plan = await launch(alice);
    // Before sharing, a colleague cannot read it.
    await assert.rejects(() => bob({action: 'get', id: plan.id}), {code: 'FORBIDDEN'});
    // Only the owner (or an administrator) names collaborators; assign without user_id lists the members.
    const members = await alice({action: 'assign', id: plan.id});
    assert.deepEqual(
      members.members.map(m => m.user_id),
      ['bob', 'carol', 'vera'],
    );
    await assert.rejects(() => bob({action: 'assign', id: plan.id, user_id: 'bob', role: 'editor'}), {
      code: 'FORBIDDEN',
    });
    await assert.rejects(() => alice({action: 'assign', id: plan.id, user_id: 'mallory', role: 'viewer'}), {
      code: 'INVALID_ARGUMENT',
    });
    await assert.rejects(() => alice({action: 'assign', id: plan.id, user_id: 'vera', role: 'editor'}), {
      code: 'INVALID_ARGUMENT',
    });
    await alice({action: 'assign', id: plan.id, user_id: 'bob', role: 'viewer'});
    assert.equal((await bob({action: 'get', id: plan.id})).id, plan.id);
    assert.equal((await bob({action: 'list'})).campaigns[0].access, 'viewer');
    // A viewer cannot prepare or approve.
    await assert.rejects(() => bob({action: 'prepare_next', id: plan.id}), {code: 'FORBIDDEN'});
    await assert.rejects(() => bob({action: 'approve', id: plan.id}), {code: 'FORBIDDEN'});
    // An editor prepares under their own identity, but cannot approve.
    await alice({action: 'assign', id: plan.id, user_id: 'bob', role: 'editor'});
    const prepared = await bob({action: 'prepare_next', id: plan.id});
    assert.equal(prepared.step_id, 'campaign');
    assert.equal(f.state.prepares.at(-1).by, 'bob');
    await assert.rejects(() => bob({action: 'approve', id: plan.id}), {code: 'FORBIDDEN'});
    // An approver approves and runs, but cannot prepare a step by itself.
    await alice({action: 'assign', id: plan.id, user_id: 'carol', role: 'approver'});
    assert.deepEqual(
      (await carol({action: 'list', awaiting_approval: true})).campaigns.map(c => c.id),
      [plan.id],
    );
    await assert.rejects(() => carol({action: 'prepare_next', id: plan.id}), {code: 'FORBIDDEN'});
    const summary = await carol({action: 'approve', id: plan.id});
    const approved = await carol({
      action: 'approve',
      id: plan.id,
      plan_hash: summary.next_call.arguments.plan_hash,
      summary_hash: summary.next_call.arguments.summary_hash,
      confirmed: true,
      spend_change_confirmed: true,
    });
    assert.equal(approved.approved.by, 'carol');
    assert.deepEqual((await carol({action: 'list', awaiting_approval: true})).campaigns, []);
    // The approval binds the approver: the plan's owner cannot run carol's approval.
    await assert.rejects(() => alice({action: 'run', id: plan.id}), {code: 'APPROVAL_REQUIRED'});
    // Without an account write grant the approver cannot run it (every step checks the acting person's grant).
    const connection = f.store.listConnections(f.tenantId).find(c => c.id === 'snap');
    f.store.putConnection(f.people.admin, {...connection, writeAccounts: []}, {accessToken: 'synthetic'});
    await assert.rejects(() => carol({action: 'run', id: plan.id}), {code: 'WRITE_ACCOUNT_FORBIDDEN'});
    f.store.putConnection(f.people.admin, {...connection, writeAccounts: ['123']}, {accessToken: 'synthetic'});
    const before = f.state.prepares.length,
      ran = await carol({action: 'run', id: plan.id});
    assert.equal(ran.run.stopped, 'complete');
    // The steps run prepares are prepared under the approver's own identity.
    assert.deepEqual(
      f.state.prepares.slice(before).map(p => p.by),
      ['carol', 'carol'],
    );
    // Every assignment and the approval are audited with their actors.
    const audit = events(f.store, f.tenantId);
    assert.deepEqual(
      audit.filter(e => e.event === 'campaign_plan_collaborator_assigned').map(e => [e.actor, e.user_id, e.role]),
      [
        ['alice', 'bob', 'viewer'],
        ['alice', 'bob', 'editor'],
        ['alice', 'carol', 'approver'],
      ],
    );
    const approval = audit.find(e => e.event === 'campaign_plan_approved');
    assert.deepEqual([approval.actor, approval.approver, approval.plan_owner], ['carol', 'carol', 'alice']);
    // Unassigned, bob no longer sees the plan.
    await alice({action: 'unassign', id: plan.id, user_id: 'bob'});
    await assert.rejects(() => bob({action: 'get', id: plan.id}), {code: 'FORBIDDEN'});
    assert.ok(audit.length < events(f.store, f.tenantId).length);
  } finally {
    f.store.close();
  }
});

test('a collaborator sees a plan only within current account access', async () => {
  const f = team(45),
    alice = f.as(f.people.alice),
    bob = f.as(f.people.bob);
  try {
    const plan = await launch(alice);
    await alice({action: 'assign', id: plan.id, user_id: 'bob', role: 'editor'});
    assert.equal((await bob({action: 'list'})).campaigns.length, 1);
    // The plan's account leaves the workspace's connection: the colleague loses sight of it; the owner keeps it.
    const connection = f.store.listConnections(f.tenantId).find(c => c.id === 'snap');
    f.store.putConnection(
      f.people.admin,
      {...connection, accounts: ['456'], writeAccounts: ['456']},
      {accessToken: 'synthetic'},
    );
    await assert.rejects(() => bob({action: 'get', id: plan.id}), {code: 'FORBIDDEN'});
    const hidden = await bob({action: 'list'});
    assert.deepEqual(hidden.campaigns, []);
    assert.equal(hidden.withheld, 1);
    assert.equal((await alice({action: 'get', id: plan.id})).id, plan.id);
  } finally {
    f.store.close();
  }
});

test('the distinct-approver policy refuses self-approval of a spending plan and is off by default', async () => {
  const f = team(46),
    alice = f.as(f.people.alice),
    carol = f.as(f.people.carol);
  try {
    const plan = await launch(alice);
    const approve = async (call, extra = {}) => {
      const summary = await call({action: 'approve', id: plan.id});
      return {
        summary,
        out: await call({
          action: 'approve',
          id: plan.id,
          plan_hash: plan.plan_hash,
          summary_hash: summary.summary_hash,
          confirmed: true,
          spend_change_confirmed: true,
          ...extra,
        }),
      };
    };
    // Off by default: the owner approves their own spending plan.
    assert.equal((await approve(alice)).out.approved.by, 'alice');
    // Only the workspace owner turns it on.
    assert.throws(
      () =>
        ownerOperations(
          f.store,
          {action: 'save_plan_policy', require_distinct_approver: true, confirmed: true},
          f.people.alice,
        ),
      {code: 'OWNER_REQUIRED'},
    );
    const policy = ownerOperations(
      f.store,
      {action: 'save_plan_policy', require_distinct_approver: true, confirmed: true},
      f.people.admin,
    );
    assert.equal(policy.require_distinct_approver, true);
    assert.equal(
      ownerOperations(f.store, {action: 'health'}, f.people.admin).plan_policy.require_distinct_approver,
      true,
    );
    const summary = await alice({action: 'approve', id: plan.id});
    assert.equal(summary.approver_required, true);
    assert.deepEqual(summary.next_call.arguments, {action: 'assign', id: plan.id});
    await assert.rejects(
      () =>
        alice({
          action: 'approve',
          id: plan.id,
          plan_hash: plan.plan_hash,
          summary_hash: summary.summary_hash,
          confirmed: true,
          spend_change_confirmed: true,
        }),
      e => {
        assert.equal(e.code, 'DISTINCT_APPROVER_REQUIRED');
        assert.match(errorRemedy(e).action, /approver/);
        return true;
      },
    );
    // A different person approves it.
    await alice({action: 'assign', id: plan.id, user_id: 'carol', role: 'approver'});
    assert.equal((await approve(carol)).out.approved.by, 'carol');
    assert.ok(events(f.store, f.tenantId).some(e => e.event === 'plan_policy_saved' && e.require_distinct_approver));
  } finally {
    f.store.close();
  }
});

test('Home and Campaigns payloads stay bounded at 10, 100 and 1,000 plans', async t => {
  const f = team(47),
    owner = f.people.alice;
  try {
    const steps = n =>
      Array.from({length: 3}, (_, i) => ({
        id: 'step' + i,
        kind: 'write',
        gateway: 'snapchat_native_action',
        connection_id: 'snap',
        account_id: '123',
        status: i ? 'pending' : 'verified',
        arguments: {action: 'snapchat_campaign_create', payload: {name: 'Plan ' + n, padding: 'x'.repeat(400)}},
      }));
    const measured = [];
    let count = 0;
    for (const size of [10, 100, 1000]) {
      for (; count < size; count++)
        putPlan(f.store, f.tenantId, 'alice', {
          state: count % 7 === 0 ? 'attention' : 'draft',
          updated_at: 10000 + count,
          steps: steps(count),
        });
      // Before (CMP-05): Home returned every plan with its steps, and list read every plan document.
      const before = JSON.stringify(
        f.store
          .documents(f.tenantId, 'campaign_run')
          .map(r => ({id: r.id, name: r.name, state: r.state, updated_at: r.updated_at, steps: r.steps})),
      ).length;
      let started = performance.now();
      const home = dashboard(f.store, owner, true, {view: 'full'});
      const homeMs = performance.now() - started;
      started = performance.now();
      const page = await f.as(owner)({action: 'list', limit: 50});
      const listMs = performance.now() - started;
      const after = {home: JSON.stringify(home.campaigns).length, list: JSON.stringify(page).length};
      measured.push({size, before, after, home_ms: Math.round(homeMs), list_ms: Math.round(listMs)});
      assert.equal(home.campaign_counts.total, size);
      assert.ok(home.campaigns.length <= 13, 'at most 5 attention and 8 recent plans');
      // The newest plans come first, and the newest attention plans are included.
      assert.equal(
        home.campaigns.some(c => c.state === 'attention'),
        true,
      );
      assert.equal(page.campaigns.length, Math.min(50, size));
      assert.equal(page.total, size);
    }
    const [small, , large] = measured;
    // The bounded payloads do not grow with the number of plans; the unbounded one grew a hundredfold.
    assert.ok(large.after.home < small.after.home * 2, JSON.stringify(measured));
    assert.ok(large.after.list < small.after.list * 6, JSON.stringify(measured));
    assert.ok(large.before > small.before * 50, JSON.stringify(measured));
    t.diagnostic('CMP-05 payload bytes and handler ms: ' + JSON.stringify(measured));
  } finally {
    f.store.close();
  }
});
