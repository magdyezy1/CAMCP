import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {amend, approve, blockedPreflight, fixture, readyPreflight, writes} from './helpers/campaign-run-fixture.mjs';

/**
 * R2.5 field3, package r25-field3-approvals, M5-b (deferred from M4a): a plan whose preflight blocked a step answered `approve` and `run` as a
 * success. The view said `blocked: true` and offered the step's correction, but it carried no `approvable: false`, no refusal code and, for
 * `run`, no `run` object, so a client that reads `run.stopped` or an approval's own fields found nothing to stop on. These are additive
 * fields: every field of the old view stays, because the website reads `missing_requirements[0].error.message` (web/creative-push.js) and
 * `blocked` (web/campaign-workflows.js). Making the blocked answer an `isError` refusal is a wider design, the lead's and the owner's.
 */
const ids = ['campaign', 'ad_set', 'ad'];
const refusalCode = 'PLAN_PREFLIGHT_BLOCKED';
const firstCall = missing => missing[0].next_call;

test('approve on a blocked plan says it is not approvable, with the refusal and the count of blocked steps, and every old field stays', async () => {
  const f = fixture({preflight: steps => blockedPreflight(steps, ['ad_set', 'ad'])});
  try {
    const id = await f.plan(ids);
    const out = await f.alice({action: 'approve', id});
    assert.equal(out.approvable, false);
    assert.equal(out.approved, false);
    assert.equal(out.refusal.code, refusalCode);
    assert.equal(typeof out.refusal.message, 'string');
    assert.ok(out.refusal.message.length > 20 && !/\{/.test(out.refusal.message), out.refusal.message);
    assert.equal(out.refusal.category, 'state');
    assert.equal(typeof out.refusal.remedy.action, 'string');
    assert.equal(out.refusal.remedy.mutation_retry_safe, false);
    assert.deepEqual(out.refusal.details, {blocked_steps: 2}, 'the count of blocked steps');
    // What was there before is still there: the website reads these.
    assert.equal(out.blocked, true);
    assert.equal(out.approval, undefined, 'a blocked plan shows no approval to give');
    assert.equal(out.summary_hash, undefined);
    assert.equal(out.missing_requirements.length, 2);
    assert.equal(out.missing_requirements[0].error.message, 'The pixel is not owned by this account.');
    assert.equal(out.preflight.status, 'blocked');
    assert.deepEqual(out.preflight.blocked_steps, ['ad_set', 'ad']);
    assert.equal(firstCall(out.missing_requirements).arguments.action, 'recover_step');
    assert.equal(
      out.next_call.arguments.action,
      'recover_step',
      'the first blocked step’s correction is the next call',
    );
    assert.equal(out.next_call.arguments.step_id, 'ad_set');
    // It stores no approval and sends nothing.
    assert.equal(f.stored(id).approval?.plan_hash, undefined);
    assert.deepEqual([f.state.prepares, f.state.attempts], [[], []]);
  } finally {
    f.store.close();
  }
});

test('approve with confirmed on a blocked plan stores no approval: the same fields, whatever hashes it is given', async () => {
  const f = fixture({preflight: steps => blockedPreflight(steps, ['campaign'])});
  try {
    const id = await f.plan(ids);
    const preview = await f.alice({action: 'approve', id});
    for (const given of [
      {plan_hash: preview.plan_hash, summary_hash: 'not-a-summary'},
      {plan_hash: 'not-the-plan', summary_hash: 'not-a-summary'},
      {plan_hash: preview.plan_hash, summary_hash: 'not-a-summary', spend_change_confirmed: true},
      {},
    ]) {
      const out = await f.alice({action: 'approve', id, confirmed: true, ...given});
      assert.equal(out.approvable, false, JSON.stringify(given));
      assert.equal(out.approved, false);
      assert.equal(out.refusal.code, refusalCode);
      assert.deepEqual(out.refusal.details, {blocked_steps: 1});
      assert.equal(out.blocked, true);
      assert.equal(out.approval, undefined);
    }
    assert.equal(f.stored(id).approval?.plan_hash, undefined, 'no approval was recorded');
    assert.deepEqual([f.state.prepares, f.state.attempts], [[], []]);
    // run, which needs the approval, stops on the block before it asks for one.
    const ran = await f.alice({action: 'run', id});
    assert.equal(ran.run.stopped, 'needs_attention');
    assert.deepEqual(writes(f), []);
  } finally {
    f.store.close();
  }
});

test('approve with confirmed and the valid hashes of a summary shown before the block records nothing on the plan the preflight now blocks', async () => {
  // Lead review S4-2: the test above gives wrong hashes, which refuse the call whatever the blocked gate does. Here a person was shown the summary,
  // the preflight was read again and blocked the plan (the plan did not change, so the hashes shown are still the plan's), and the person
  // approves with exactly what they were shown: the one thing that can refuse that call is the block.
  // Twice: a plan that changes no spending, and one whose summary offers spend_change_confirmed, which the person gives with the approval.
  for (const spends of [false, true]) {
    const f = fixture({effects: new Map(ids.map(id => [id, spends]))});
    try {
      const id = await f.plan(ids);
      const shown = await f.alice({action: 'approve', id});
      assert.equal(shown.approvable, undefined, 'the plan was approvable when it was shown');
      const given = {...shown.next_call.arguments, ...shown.next_call.add_after_user_approval};
      assert.equal(given.confirmed, true);
      assert.equal(given.spend_change_confirmed, spends ? true : undefined);
      f.state.preflight = steps => blockedPreflight(steps, ['ad']);
      await f.alice({action: 'preflight', id});
      assert.equal(f.stored(id).plan_hash, given.plan_hash, 'the plan did not change: the hashes are still its own');
      const refused = await f.alice(given);
      assert.equal(refused.approvable, false);
      assert.equal(refused.approved, false);
      assert.equal(refused.refusal.code, refusalCode);
      assert.deepEqual(refused.refusal.details, {blocked_steps: 1});
      assert.equal(f.stored(id).approval?.plan_hash, undefined, 'no approval was recorded');
      assert.deepEqual([f.state.prepares, f.state.attempts, f.state.sent], [[], [], []]);
      const ran = await f.alice({action: 'run', id});
      assert.equal(ran.run.stopped, 'needs_attention');
      assert.deepEqual(writes(f), []);
      // The hashes were good all along: once the preflight passes again, the very same call records the approval.
      f.state.preflight = readyPreflight;
      await f.alice({action: 'preflight', id});
      const approved = await f.alice(given);
      assert.equal(approved.approved.by, 'alice');
      assert.equal(f.stored(id).approval.plan_hash, given.plan_hash);
    } finally {
      f.store.close();
    }
  }
});

test('approval_summary on a plan whose stored preflight blocked a step answers the same blocked view, and runs no preflight', async () => {
  const f = fixture({preflight: steps => blockedPreflight(steps, ['ad'])});
  try {
    const id = await f.plan(ids);
    await f.alice({action: 'preflight', id});
    assert.equal(f.state.preflights, 1);
    const before = f.snapshot();
    const summary = await f.alice({action: 'approval_summary', id});
    assert.equal(f.state.preflights, 1, 'the stored preflight was read, not repeated');
    assert.equal(f.snapshot(), before, 'nothing was saved');
    assert.deepEqual(summary, await f.alice({action: 'approve', id}), 'the answer approve gives');
    assert.equal(summary.approvable, false);
    assert.equal(summary.approved, false);
    assert.equal(summary.refusal.code, refusalCode);
    assert.equal(summary.approval, undefined);
    assert.equal(summary.next_call.arguments.action, 'recover_step');
    assert.deepEqual([f.state.prepares, f.state.attempts], [[], []]);
  } finally {
    f.store.close();
  }
});

test('approval_summary on a blocked plan never takes detail: it answers the compact blocked view, so there is no whole plan for a response budget to hold', async () => {
  // Lead review S3-1: approval_summary is answered whole at any response budget (it is what a person is shown to approve), so the one thing it
  // must never carry is a plan record of any size. `detail` is no argument of its contract row (id and step_id), and a blocked plan's view
  // honoured it: detail full answered the whole stored plan, steps with their arguments and all.
  const f = fixture({preflight: steps => blockedPreflight(steps, ['ad'])});
  try {
    const id = await f.plan(ids);
    await f.alice({action: 'preflight', id});
    const compact = await f.alice({action: 'approval_summary', id});
    assert.equal(compact.steps.length, 3);
    assert.ok(
      compact.steps.every(step => step.arguments === undefined),
      'a compact row has no arguments',
    );
    assert.equal(compact.approvable, false);
    assert.equal(compact.refusal.code, refusalCode);
    for (const extra of [{detail: 'full'}, {detail: 'compact'}, {detail: 'x'}, {step_id: 'ad', detail: 'full'}])
      assert.deepEqual(await f.alice({action: 'approval_summary', id, ...extra}), compact, JSON.stringify(extra));
    // approve keeps what it always answered for detail full, the whole plan beside the new fields: it is no read, so no budget cuts it, and the
    // summary is the read that does not take it.
    const approve = await f.alice({action: 'approve', id, detail: 'full'});
    assert.ok(approve.steps[0].arguments, 'the whole plan, as before');
    assert.deepEqual([f.state.prepares, f.state.attempts], [[], []]);
  } finally {
    f.store.close();
  }
});

test('run on a blocked plan stops as needs_attention with nothing executed and sends nothing, and the old fields stay', async () => {
  const f = fixture({preflight: steps => blockedPreflight(steps, ['campaign'])});
  try {
    const id = await f.plan(ids);
    const out = await f.alice({action: 'run', id});
    assert.deepEqual(out.run, {executed: [], stopped: 'needs_attention', reason: 'preflight_blocked'});
    assert.equal(out.blocked, true);
    assert.equal(out.missing_requirements[0].step, 'campaign');
    assert.equal(out.next_call.arguments.action, 'recover_step');
    assert.deepEqual([f.state.prepares, f.state.attempts, f.state.sent], [[], [], []]);
    // The same again from the stored preflight, which run reads and never repeats once it holds one.
    assert.deepEqual((await f.alice({action: 'run', id})).run, out.run);
    assert.equal(f.state.preflights, 1);
    // No approval was needed to be told so, and none was recorded.
    assert.equal(f.stored(id).approval?.plan_hash, undefined);
  } finally {
    f.store.close();
  }
});

test('detail full carries the same fields beside the whole plan', async () => {
  const f = fixture({preflight: steps => blockedPreflight(steps, ['campaign'])});
  try {
    const id = await f.plan(ids);
    const approval = await f.alice({action: 'approve', id, detail: 'full'}),
      run = await f.alice({action: 'run', id, detail: 'full'});
    assert.equal(approval.approvable, false);
    assert.equal(approval.refusal.code, refusalCode);
    assert.equal(approval.steps.length, 3, 'the whole plan, as before');
    assert.deepEqual(run.run, {executed: [], stopped: 'needs_attention', reason: 'preflight_blocked'});
    assert.equal(run.steps.length, 3);
  } finally {
    f.store.close();
  }
});

test('the other actions that meet a blocked plan answer as they did: no approvable, no refusal and no run object', async () => {
  const f = fixture({preflight: steps => blockedPreflight(steps, ['campaign'])});
  try {
    const id = await f.plan(ids);
    const preflight = await f.alice({action: 'preflight', id});
    for (const [name, out] of [
      ['preflight', preflight],
      ['prepare_next', await f.alice({action: 'prepare_next', id})],
      ['execute_next', await f.alice({action: 'execute_next', id, review_id: 'review-1', confirmed: true})],
      ['run_background', await f.alice({action: 'run_background', id})],
    ]) {
      assert.equal(out.blocked, true, name);
      assert.deepEqual(
        [out.approvable, out.approved, out.refusal, out.run],
        [undefined, undefined, undefined, undefined],
        name,
      );
    }
    assert.deepEqual([f.state.prepares, f.state.attempts], [[], []]);
  } finally {
    f.store.close();
  }
});

test('a plan whose steps are not blocked is approved and run exactly as before: no refusal, no approvable, and no stop', async () => {
  const f = fixture({preflight: steps => blockedPreflight(steps, [])});
  try {
    const id = await f.plan(ids);
    const {preview, approved} = await approve(f, id);
    assert.deepEqual(
      [preview.approvable, preview.refusal, preview.blocked, approved.approved.by],
      [undefined, undefined, undefined, 'alice'],
    );
    assert.equal(preview.approval.steps.length, 3);
    const ran = await f.alice({action: 'run', id});
    assert.equal(ran.run.stopped, 'complete');
    assert.equal(ran.run.reason, undefined);
    assert.deepEqual(writes(f), ids);
  } finally {
    f.store.close();
  }
});

test('after the block is corrected and the preflight passes, the same calls approve and run as before', async () => {
  const f = fixture({preflight: steps => blockedPreflight(steps, ['ad_set'])});
  try {
    const id = await f.plan(ids);
    const blocked = await f.alice({action: 'approve', id});
    assert.equal(blocked.approvable, false);
    // The correction the answer names, then a passing preflight (the plan changed, so its old preflight is gone).
    f.state.preflight = readyPreflight;
    await amend(f, id, 'ad_set', 'corrected');
    const {preview, approved} = await approve(f, id);
    assert.equal(preview.approvable, undefined);
    assert.equal(preview.refusal, undefined);
    assert.equal(approved.approved.by, 'alice');
    const ran = await f.alice({action: 'run', id});
    assert.equal(ran.run.stopped, 'complete');
    assert.deepEqual(writes(f), ids);
  } finally {
    f.store.close();
  }
});

test('an approval already recorded does not keep a plan the preflight now blocks from stopping: run answers the block, and sends nothing', async () => {
  // The preflight is read again (the person asked for it) after the plan was approved: the approval is of the plan, and a block is a block.
  const f = fixture();
  try {
    const id = await f.plan(ids);
    await approve(f, id);
    f.state.preflight = steps => blockedPreflight(steps, ['ad']);
    await f.alice({action: 'preflight', id});
    const ran = await f.alice({action: 'run', id});
    assert.deepEqual(ran.run, {executed: [], stopped: 'needs_attention', reason: 'preflight_blocked'});
    assert.deepEqual(writes(f), []);
    assert.equal(f.stored(id).approval.by, 'alice', 'the approval is untouched: the plan did not change');
  } finally {
    f.store.close();
  }
});

/** The TikTok advertiser the launch tests of the pack use, reduced to what the plan’s preflight reads: no request writes. */
const CONNECTION = '17171717-1717-4171-8171-171717171717',
  tiktokActor = {tenantId: 'blocked-tiktok', userId: 'operator', role: 'operator'},
  tiktokAdmin = {...tiktokActor, role: 'admin'},
  trafficBusiness = {
    name: 'Synthetic TikTok traffic',
    account_id: '7001',
    connection_id: CONNECTION,
    currency: 'USD',
    daily_budget: '25.50',
    location_ids: ['6252001', '102358'],
    tiktok_item_id: '7300000000000000001',
    identity_type: 'TT_USER',
    identity_id: 'tt-identity-1',
    destination_url: 'https://example.com/tiktok-landing',
    call_to_action: 'LEARN_MORE',
    start_time: '2026-11-01T10:00:00+03:00',
  };
function tiktokWorld({identity = {}} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 73).toString('base64'));
  store.putConnection(
    tiktokAdmin,
    {
      id: CONNECTION,
      tenantId: tiktokActor.tenantId,
      gateway: 'tiktok_native_action',
      accounts: ['7001'],
      writeAccounts: ['7001'],
      enabled: true,
      label: 'TikTok login',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const writesSent = [],
    ok = data => Response.json({code: 0, message: 'OK', request_id: 'r', data}),
    page = list => ok({list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}});
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (raw, init = {}) => {
        const url = new URL(String(raw)),
          path = url.pathname.replace('/open_api', ''),
          method = init.method ?? 'GET',
          json = name => {
            const v = url.searchParams.get(name);
            try {
              return v === null ? undefined : JSON.parse(v);
            } catch {
              return v;
            }
          };
        if (method === 'POST') {
          writesSent.push(path);
          throw new Error('No write is expected: ' + path);
        }
        if (path === '/v1.3/advertiser/info/')
          return page([{advertiser_id: '7001', currency: 'USD', timezone: 'Etc/GMT', status: 'STATUS_ENABLE'}]);
        if (['/v1.3/campaign/get/', '/v1.3/adgroup/get/', '/v1.3/ad/get/'].includes(path)) return page([]);
        if (path === '/v1.3/identity/info/')
          return ok({
            identity_info: {
              identity_id: json('identity_id'),
              identity_type: json('identity_type'),
              display_name: 'Synthetic creator',
              available_status: 'AVAILABLE',
              can_pull_video: true,
              is_gpppa: false,
              ...identity,
            },
          });
        if (path === '/v1.3/identity/video/info/')
          return ok({
            video_details: []
              .concat(json('item_ids') ?? [])
              .map(String)
              .filter(item => item === trafficBusiness.tiktok_item_id)
              .map(item_id => ({item_id, item_type: 'VIDEO', status: 'PUBLIC'})),
          });
        throw new Error('Unexpected TikTok request ' + method + ' ' + path);
      },
      undefined,
      undefined,
      undefined,
      10000,
    ),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  return {
    store,
    writes: writesSent,
    call: input => service.call('amcp_campaign', input, tiktokActor),
    close: () => store.close(),
  };
}

test('a TikTok launch whose identity is unavailable is blocked by preflight, and approve and run say so without a refusal-shaped success', async () => {
  const f = tiktokWorld({identity: {available_status: 'NOT_AVAILABLE'}});
  try {
    const created = await f.call({
      action: 'create_from_recipe',
      recipe: 'tiktok_website_traffic',
      business: trafficBusiness,
    });
    assert.equal(created.success, true, JSON.stringify(created).slice(0, 800));
    const id = created.data.id;
    const preview = await f.call({action: 'approve', id});
    assert.equal(
      preview.success,
      true,
      'the envelope is the success it always was (a refusal is the lead’s wider design)',
    );
    assert.equal(preview.data.approvable, false);
    assert.equal(preview.data.approved, false);
    assert.equal(preview.data.refusal.code, refusalCode);
    assert.equal(preview.data.approval, undefined);
    assert.equal(preview.data.next_call.arguments.action, 'recover_step');
    assert.equal(preview.data.missing_requirements[0].error.code, 'CAMPAIGN_PREREQUISITE_REQUIRED');
    assert.equal(
      typeof preview.data.missing_requirements[0].error.message,
      'string',
      'what the website’s upload push reads',
    );
    const approved = await f.call({
      action: 'approve',
      id,
      confirmed: true,
      plan_hash: preview.data.plan_hash,
      summary_hash: 'x',
    });
    assert.equal(approved.data.approvable, false);
    assert.equal(approved.data.approved, false);
    const ran = await f.call({action: 'run', id});
    assert.deepEqual(ran.data.run, {executed: [], stopped: 'needs_attention', reason: 'preflight_blocked'});
    const stored = (await f.call({action: 'get', id, detail: 'full'})).data;
    assert.equal(stored.approval?.plan_hash, undefined, 'no approval stored');
    assert.deepEqual(f.writes, [], 'no request was written');
    const read = await f.call({action: 'approval_summary', id});
    assert.equal(read.data.approvable, false);
    assert.equal(read.data.refusal.code, refusalCode);
  } finally {
    f.close();
  }
});
