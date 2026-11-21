import test from 'node:test';
import assert from 'node:assert/strict';
import {at, googleReconcileFixture} from './helpers/google-reconcile-fixture.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';
import {approvalSummary} from '../dist/src/plan-approval.js';

/**
 * Package r25-field3-refs, item 1 (AMCP-01), end to end: the owner’s case, one approved plan that creates text assets and links them, and the gates
 * that must stay where they were while a preflight no longer reads every reference as one asset. At the preflight the references are checked by the
 * result they name; when each link step is prepared, the real IDs replace them and the whole request is checked again (the duplicates among the real
 * names, the live links, the owner’s approval and spend confirmation, the guard against creating twice). A synthetic Google account answers the reads
 * and applies the writes; every value is invented and nothing leaves the process.
 */
const group = at('assetGroups', '77'),
  campaign = at('campaigns', '10'),
  assetAction = 'google_ads_v23_asset_mutate_assets',
  linkAction = 'google_ads_v23_asset_group_asset_mutate_asset_group_assets';
let tenants = 0;

/** An account with a paused campaign and a paused asset group under it; a text asset it creates reads back as TEXT. */
function account() {
  const f = googleReconcileFixture({tenant: 'plan-reference-lifecycle-' + ++tenants});
  f.row('campaign', {resource_name: campaign, name: 'Existing campaign', status: 'PAUSED'});
  f.row('asset_group', {resource_name: group, name: 'Existing group', status: 'PAUSED', campaign});
  const push = f.db.asset.push;
  f.db.asset.push = function (row) {
    if (row.text_asset) Object.assign(row, {type: 'TEXT', source: 'ADVERTISER'});
    return push.call(this, row);
  };
  return f;
}
const step = (id, args, depends_on = []) => ({
  id,
  kind: 'write',
  gateway: 'google_ads_native_action',
  connection_id: 'g',
  account_id: '123',
  description: id,
  arguments: args,
  depends_on,
});
const textStep = (id, ...texts) =>
  step(id, {action: assetAction, payload: {operations: texts.map(text => ({create: {text_asset: {text}}}))}});
const ref = (id, i = 0) => ({$ref: id + '#/data/results/' + i + '/resourceName'});
const linkStep = (id, refs, depends_on) =>
  step(
    id,
    {
      action: linkAction,
      payload: {operations: refs.map(asset => ({create: {asset_group: group, field_type: 'HEADLINE', asset}}))},
    },
    depends_on,
  );
/** A plan, and the calls an agent makes to run it. */
async function plan(f, steps) {
  const created = await f.call('amcp_campaign', {action: 'create', name: 'Synthetic plan', brief: 'Synthetic.', steps});
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 800));
  const id = created.data.id,
    call = input => f.call('amcp_campaign', {id, ...input});
  return {
    id,
    call,
    async preview() {
      const out = await call({action: 'approve'});
      assert.equal(out.success, true, JSON.stringify(out).slice(0, 800));
      return out.data;
    },
    async approve({flag = true} = {}) {
      const preview = await this.preview(),
        out = await call({...preview.next_call.arguments, ...(flag ? preview.next_call.add_after_user_approval : {})});
      assert.equal(out.success, true, JSON.stringify(out).slice(0, 800));
      return out.data;
    },
    async run() {
      let last;
      for (let i = 0; i < 6; i++) {
        last = await call({action: 'run'});
        if (!last.success || last.data.run.stopped !== 'time') return last;
      }
      return last;
    },
    async step(stepId) {
      const out = await call({action: 'get', detail: 'full'});
      return out.data.steps.find(s => s.id === stepId);
    },
  };
}

test('R7: one approved plan creates three text assets and links them to an asset group, each link to the asset it names', async () => {
  const f = account();
  try {
    const p = await plan(f, [
      textStep('en_texts', 'Synthetic headline A', 'Synthetic headline B', 'Synthetic headline C'),
      linkStep('en_text_links', [ref('en_texts', 0), ref('en_texts', 1), ref('en_texts', 2)], ['en_texts']),
    ]);
    const preview = await p.preview();
    assert.deepEqual(
      preview.approval.steps.map(s => [s.id, s.spend_effect]),
      [
        ['en_texts', false],
        ['en_text_links', true],
      ],
    );
    await p.approve();
    const ran = await p.run();
    assert.equal(ran.success, true, JSON.stringify(ran).slice(0, 800));
    assert.equal(ran.data.run.stopped, 'complete');
    assert.equal(f.writes.length, 2, 'one write for each step');
    // Each link names the asset its reference named, in order; none names a stand-in.
    const sent = f.writes[1].body.operations.map(op => op.create.asset);
    assert.deepEqual(sent, [at('assets', '500'), at('assets', '501'), at('assets', '502')]);
    assert.deepEqual(
      f.db.asset_group_asset.map(r => r.resource_name),
      [500, 501, 502].map(n => at('assetGroupAssets', '77~' + n + '~HEADLINE')),
    );
    assert.equal((await p.step('en_text_links')).status, 'verified');
  } finally {
    f.close();
  }
});

// N3 (the check on the real IDs stays): two references to two different steps that give back the SAME real asset are two references at the preflight,
// and one asset at prepare, where the whole request is checked again. Nothing is sent for the link step.
test('N3: two predecessors that answer one real asset are refused INVALID_ASSET_LINK when the link step is prepared, and nothing is sent', async () => {
  const f = account();
  try {
    // Google answers every create with the same asset (the synthetic account hands out one ID).
    Object.defineProperty(f.state, 'next', {get: () => 500, set: () => undefined, configurable: true});
    const p = await plan(f, [
      textStep('first_text', 'Synthetic headline A'),
      textStep('second_text', 'Synthetic headline B'),
      linkStep('links', [ref('first_text'), ref('second_text')], ['first_text', 'second_text']),
    ]);
    const preflight = await p.call({action: 'preflight'});
    assert.equal(preflight.success, true, JSON.stringify(preflight).slice(0, 800));
    assert.equal(preflight.data.blocked ?? false, false, 'the preflight passes: they are two different results');
    await p.approve();
    const ran = await p.run();
    assert.equal(ran.success, true, JSON.stringify(ran).slice(0, 800));
    const failed = await p.step('links');
    assert.equal(failed.status, 'failed');
    assertRefused({code: failed.error.code}, 'INVALID_ASSET_LINK');
    assert.equal(f.writes.length, 2, 'only the two asset creates were sent; the link step sent nothing');
    assert.deepEqual(f.db.asset_group_asset, []);
  } finally {
    f.close();
  }
});

// N4 (the check on the live state stays): a link the group already holds is still ASSET_LINK_EXISTS at prepare.
test('N4: a link the asset group already holds is still refused ASSET_LINK_EXISTS when the link step is prepared', async () => {
  const f = account();
  try {
    f.row('asset_group_asset', {
      resource_name: at('assetGroupAssets', '77~500~HEADLINE'),
      asset_group: group,
      asset: at('assets', '500'),
      field_type: 'HEADLINE',
      status: 'ENABLED',
      source: 'ADVERTISER',
    });
    const p = await plan(f, [
      textStep('en_texts', 'Synthetic headline A'),
      linkStep('en_text_links', [ref('en_texts')], ['en_texts']),
    ]);
    await p.approve();
    const ran = await p.run();
    assert.equal(ran.success, true, JSON.stringify(ran).slice(0, 800));
    const failed = await p.step('en_text_links');
    assert.equal(failed.status, 'failed');
    assertRefused({code: failed.error.code}, 'ASSET_LINK_EXISTS');
    assert.equal(f.writes.length, 1, 'only the asset create was sent');
  } finally {
    f.close();
  }
});

// N5 (spend confirmation stays): the approval names the link step as spending and offers the flag; given without it, the run stops at that step
// and sends nothing for it; a step-by-step execute without it is refused.
test('N5: the plan approval lists spend_change_confirmed for the link step, and without it the step is neither run nor executed', async () => {
  const f = account();
  try {
    const p = await plan(f, [
      textStep('en_texts', 'Synthetic headline A'),
      linkStep('en_text_links', [ref('en_texts')], ['en_texts']),
    ]);
    const preview = await p.preview();
    assert.deepEqual(preview.next_call.add_after_user_approval, {spend_change_confirmed: true});
    assert.deepEqual(preview.approval.spend_steps, ['en_text_links']);
    await p.approve({flag: false});
    const stopped = await p.run();
    assert.equal(stopped.success, true, JSON.stringify(stopped).slice(0, 800));
    assert.equal(stopped.data.run.stopped, 'needs_spend_change_confirmed');
    assert.equal(f.writes.length, 1, 'the asset create ran; the link step was not sent');
    // The step’s own execute without the flag is refused too: the plan answers with the step’s stop, and nothing is sent.
    const prepared = await p.call({action: 'prepare_next'});
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 800));
    const execute = await f.call('amcp_campaign', prepared.data.next_call.arguments);
    assert.equal(execute.success, true, JSON.stringify(execute).slice(0, 800));
    assertRefused({code: execute.data.current.error.code}, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal(execute.data.current.status, 'review_ready', 'the review is still there, unspent');
    assert.equal(f.writes.length, 1);
  } finally {
    f.close();
  }
});

// N6 (approval stays): a plan is not run before it is approved.
test('N6: run before approve is still APPROVAL_REQUIRED, and nothing is sent', async () => {
  const f = account();
  try {
    const p = await plan(f, [
      textStep('en_texts', 'Synthetic headline A'),
      linkStep('en_text_links', [ref('en_texts')], ['en_texts']),
    ]);
    assertRefused(await p.call({action: 'run'}), 'APPROVAL_REQUIRED', {writes: f.writes.length});
  } finally {
    f.close();
  }
});

// N8 (UNVERIFIED 2, the lead's review of the first round, S4-5): the test in tests/plan-reference-approvals.test.mjs shows that an approve with the old
// summary_hash is PLAN_CHANGED. `run` does not read the summary: it compares the plan hash (assertApproval), so a stored approval whose summary is no
// longer the plan's current one still runs the plan. What keeps it from running more than it was shown is the list the person saw: the approval's
// spend_change_confirmed reaches the steps it names (`spend_steps`) and no other. Here the stored approval showed only link_a as spending and was given the
// flag; the current summary shows both links as spending. The run executes link_a with the flag, and stops at link_b, whose review needs it, unsent.
test('N8: a stored approval whose summary changed still runs, and its spend confirmation reaches only the steps it showed', async () => {
  const f = account();
  try {
    const p = await plan(f, [
      textStep('en_texts', 'Synthetic headline A', 'Synthetic headline B'),
      linkStep('link_a', [ref('en_texts', 0)], ['en_texts']),
      linkStep('link_b', [ref('en_texts', 1)], ['en_texts']),
    ]);
    const preview = await p.preview();
    assert.deepEqual(preview.approval.spend_steps, ['link_a', 'link_b']);
    // The approval recorded before the summary changed: it showed link_a as spending alone, and the person gave the flag.
    const run = f.store.document(f.actor.tenantId, 'campaign_run', p.id),
      old = approvalSummary(
        run,
        new Map([
          ['en_texts', false],
          ['link_a', true],
          ['link_b', false],
        ]),
      );
    assert.notEqual(old.summary_hash, preview.summary_hash, 'the stored summary is not the current one');
    run.approval = {
      plan_hash: run.plan_hash,
      summary_hash: old.summary_hash,
      by: f.actor.userId,
      at: Date.now(),
      spend_change_confirmed: true,
      spend_steps: ['link_a'],
      spend_effect_steps: ['link_a'],
    };
    f.store.putDocument(f.actor.tenantId, 'campaign_run', p.id, run, run.revision);
    const ran = await p.run();
    assert.equal(ran.success, true, 'the stored approval still stands for run: ' + JSON.stringify(ran).slice(0, 800));
    assert.equal(ran.data.run.stopped, 'needs_spend_change_confirmed');
    assert.match(ran.data.run.reason, /link_b/);
    assert.match(ran.data.run.reason, /did not show this step as spending/);
    assert.equal(f.writes.length, 2, 'the texts and link_a were sent; link_b was not');
    assert.equal((await p.step('link_a')).status, 'verified', 'the flag reached the step the approval showed');
    assert.equal((await p.step('link_b')).status, 'review_ready', 'and not the one it did not');
    assert.deepEqual(
      f.db.asset_group_asset.map(r => r.resource_name),
      [at('assetGroupAssets', '77~500~HEADLINE')],
    );
  } finally {
    f.close();
  }
});

// N7 (the guard against creating twice stays): the link step as the references resolve is the request of a review whose outcome is uncertain, so it
// is refused DUPLICATE_OF_UNCERTAIN_WRITE when it is prepared, and nothing is sent for it.
test('N7: a link step that resolves to the request of an uncertain review is still refused DUPLICATE_OF_UNCERTAIN_WRITE', async () => {
  const f = account();
  try {
    // The three text assets exist, and a review linking them to the group went out and its answer was lost (applied or not, nobody knows).
    for (const n of [500, 501, 502])
      f.row('asset', {
        resource_name: at('assets', String(n)),
        type: 'TEXT',
        source: 'ADVERTISER',
        text_asset: {text: 'Synthetic ' + n},
      });
    const lost = await f.lose(
      linkAction,
      {
        operations: [500, 501, 502].map(n => ({
          create: {asset_group: group, field_type: 'HEADLINE', asset: at('assets', String(n))},
        })),
      },
      {applied: false},
    );
    assert.equal(f.claim(lost.id).state, 'uncertain');
    const sent = f.writes.length;
    // The plan creates texts that Google answers with the same three assets and links them: the same request, by references.
    f.state.next = 500;
    const p = await plan(f, [
      textStep('en_texts', 'Synthetic headline A', 'Synthetic headline B', 'Synthetic headline C'),
      linkStep('en_text_links', [ref('en_texts', 0), ref('en_texts', 1), ref('en_texts', 2)], ['en_texts']),
    ]);
    await p.approve();
    const ran = await p.run();
    assert.equal(ran.success, true, JSON.stringify(ran).slice(0, 800));
    const refused = await p.step('en_text_links');
    assert.notEqual(refused.status, 'verified');
    assertRefused({code: refused.error.code}, 'DUPLICATE_OF_UNCERTAIN_WRITE');
    assert.equal(f.writes.length, sent + 1, 'the plan’s asset create was sent; the link step sent nothing');
  } finally {
    f.close();
  }
});
