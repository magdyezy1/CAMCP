import test from 'node:test';
import assert from 'node:assert/strict';
import type {JsonObject} from '../src/types.js';
import {bytes, campaignStep, createPlan, fixture, runAll, squadStep} from './snapchat-plan-fixture.js';

/**
 * Snapchat S2, from the owner's live test on 2026-09-29: preflight blocked both ad squads with
 * SNAPCHAT_PIXEL_NOT_OWNED and listed the owned pixels, but the response had no next_call, the remedy said "run
 * preflight again" (which can never pass with the same arguments) and the blocked-plan text said corrective writes
 * need a new plan. The agent cancelled and re-created the plan. recover_step could already amend the step; now every
 * blocked step says how, and a patch changes one field.
 */
const placeholder = '<choose one of allowed_values>';
const foreignPlan = () => [
  campaignStep(),
  squadStep(1, {}, {pixel_id: 'pixel-foreign'}),
  squadStep(2, {depends_on: ['campaign', 'squad_1']}),
];

test("the owner's sequence: blocked in preflight, amended through next_call, then complete, with no cancel", async () => {
  const f = fixture({pixels: ['pixel-own', 'pixel-own-2']});
  try {
    const id = (await createPlan(f, foreignPlan())).data.id;
    const blocked = (await f.call('amcp_campaign', {action: 'preflight', id})).data;
    assert.equal(blocked.blocked, true);
    const requirement = blocked.missing_requirements.find((r: JsonObject) => r.step === 'squad_1');
    assert.equal(requirement.error.code, 'SNAPCHAT_PIXEL_NOT_OWNED');
    // The way forward names the field and the values the operator may choose; AMCP never picks one.
    assert.deepEqual(requirement.next_call, {
      tool: 'amcp_campaign',
      arguments: {action: 'recover_step', id, step_id: 'squad_1', confirmed: true},
      // r25-field3-errors (M5-b, changed on purpose): a correction template says so, so that no one mistakes its confirmed for an approval.
      kind: 'correction',
      add_after_user_choice: {patch: [{path: '/payload/adsquads/0/pixel_id', value: placeholder}]},
      choose: [
        {
          path: '/payload/adsquads/0/pixel_id',
          field: 'arguments.payload.adsquads[0].pixel_id',
          current: 'pixel-foreign',
          allowed_values: ['pixel-own', 'pixel-own-2'],
        },
      ],
    });
    assert.deepEqual(blocked.next_call, requirement.next_call);
    assert.doesNotMatch(requirement.error.remedy.action, /run preflight again/);
    assert.match(requirement.error.remedy.action, /recover_step/);
    // prepare_next on the blocked plan returns the same way forward, not a dead end.
    const again = (await f.call('amcp_campaign', {action: 'prepare_next', id})).data;
    assert.deepEqual(again.next_call, requirement.next_call);
    assert.equal(f.writes.length, 0, 'nothing reaches Snapchat before preflight passes');
    // The operator chose the second owned pixel.
    const amended = await f.call('amcp_campaign', {
      ...requirement.next_call.arguments,
      patch: [{path: '/payload/adsquads/0/pixel_id', value: 'pixel-own-2'}],
    });
    assert.equal(amended.success, true, JSON.stringify(amended));
    assert.equal(amended.data.current.step_id, 'squad_1');
    assert.equal(amended.data.current.status, 'pending');
    assert.equal(amended.data.current.previous_attempts, 1);
    assert.equal(amended.data.preflight, undefined);
    assert.deepEqual(amended.data.next_call, {tool: 'amcp_campaign', arguments: {action: 'prepare_next', id}});
    const responses = await runAll(f, id);
    assert.equal(responses.at(-1)!.result.data.state, 'complete');
    assert.equal(f.squads.get('squad1')!.pixel_id, 'pixel-own-2');
    assert.equal(f.writes.length, 3);
    // The step whole (r25-field3-errors, AMCP-11: get with a step_id is the default view; the stored step is detail: full).
    const step = (await f.call('amcp_campaign', {action: 'get', id, step_id: 'squad_1', detail: 'full'})).data.step;
    assert.equal(step.previous_attempts.length, 1);
    assert.equal(step.previous_attempts[0].preflight_error.code, 'SNAPCHAT_PIXEL_NOT_OWNED');
    assert.deepEqual(step.previous_attempts[0].patch, [
      {path: '/payload/adsquads/0/pixel_id', from: 'pixel-foreign', to: 'pixel-own-2'},
    ]);
  } finally {
    f.close();
  }
});

test('a patch changes one existing field of the named step and nothing else', async () => {
  const f = fixture({pixels: ['pixel-own']});
  try {
    const id = (await createPlan(f, foreignPlan())).data.id;
    await f.call('amcp_campaign', {action: 'preflight', id});
    const recover = (extra: JsonObject) =>
      f.call('amcp_campaign', {action: 'recover_step', id, step_id: 'squad_1', confirmed: true, ...extra});
    const refused = async (extra: JsonObject, pattern: RegExp) => {
      const r = await recover(extra);
      assert.equal(r.success, false, JSON.stringify(extra));
      assert.equal(r.error.code, 'INVALID_ARGUMENT', JSON.stringify(r.error));
      assert.match(r.error.message, pattern);
    };
    await refused({patch: [{path: '/payload/adsquads/0/no_such_field', value: 'x'}]}, /no_such_field.*not in step/);
    await refused({patch: [{path: '/payload/adsquads/3/pixel_id', value: 'pixel-own'}]}, /adsquads\/3.*not in step/);
    await refused({patch: [{path: '/depends_on', value: []}]}, /depends_on.*not in step/);
    await refused({patch: [{path: '', value: {}}]}, /patch\[0\]\.path/);
    await refused({patch: [{path: 'payload/name', value: 'x'}]}, /patch\[0\]\.path/);
    await refused({patch: [{path: '/payload/adsquads/0/pixel_id', value: placeholder}]}, /allowed_values/);
    await refused({patch: [{path: '/payload/adsquads/0/pixel_id', op: 'remove'}]}, /patch\[0\]/);
    await refused({patch: [{path: '/payload/adsquads/0/pixel_id', value: {$ref: 'campaign#/data/id'}}]}, /\$ref/);
    await refused({patch: [{path: '/payload/adsquads/0/campaign_id', value: 'camp-elsewhere'}]}, /\$ref/);
    await refused(
      {patch: [{path: '/payload/adsquads/0/pixel_id', value: 'pixel-own'}], arguments: {action: 'x'}},
      /patch or arguments/,
    );
    // Sending the blocked arguments back unchanged would block again.
    const current = (await f.call('amcp_campaign', {action: 'get', id, step_id: 'squad_1', detail: 'full'})).data.step
      .arguments;
    await refused({arguments: current}, /unchanged/);
    await refused({}, /patch or arguments/);
    // The other steps are untouched by a refused or accepted patch.
    const before = (await f.call('amcp_campaign', {action: 'get', id, detail: 'full'})).data.steps;
    assert.equal((await recover({patch: [{path: '/payload/adsquads/0/pixel_id', value: 'pixel-own'}]})).success, true);
    const after = (await f.call('amcp_campaign', {action: 'get', id, detail: 'full'})).data.steps;
    assert.deepEqual(after[0], before[0]);
    assert.deepEqual(after[2].arguments, before[2].arguments);
    assert.equal(after[1].arguments.payload.adsquads[0].pixel_id, 'pixel-own');
    assert.deepEqual(
      after[1].arguments.payload.adsquads[0].campaign_id,
      before[1].arguments.payload.adsquads[0].campaign_id,
    );
    assert.equal(f.writes.length, 0);
  } finally {
    f.close();
  }
});

test('a step that has progressed cannot be patched, and its predecessors cannot once a dependant has', async () => {
  const f = fixture();
  try {
    const id = (await createPlan(f, [campaignStep(), squadStep(1)])).data.id;
    await runAll(f, id);
    for (const step_id of ['squad_1', 'campaign']) {
      const r = await f.call('amcp_campaign', {
        action: 'recover_step',
        id,
        step_id,
        confirmed: true,
        patch: [{path: '/payload', value: {}}],
      });
      assert.equal(r.error.code, 'RECOVERY_NOT_SAFE', step_id);
    }
    assert.equal(f.writes.length, 2);
  } finally {
    f.close();
  }
});

test('dependants of an amended step still wait until it verifies', async () => {
  // Snapchat reports squad1 with another name, so its read-back stays inconclusive.
  const f = fixture({
    pixels: ['pixel-own'],
    readSquad: s => (s.id === 'squad1' ? {...s, name: s.name + ' (edited elsewhere)'} : s),
  });
  try {
    const id = (await createPlan(f, foreignPlan())).data.id;
    await f.call('amcp_campaign', {action: 'preflight', id});
    await f.call('amcp_campaign', {
      action: 'recover_step',
      id,
      step_id: 'squad_1',
      confirmed: true,
      patch: [{path: '/payload/adsquads/0/pixel_id', value: 'pixel-own'}],
    });
    await runAll(f, id);
    const rows = (await f.call('amcp_campaign', {action: 'get', id})).data.steps;
    assert.deepEqual(
      rows.map((s: JsonObject) => [s.id, s.status]),
      [
        ['campaign', 'verified'],
        // The read-back disagrees the same way twice, so the step is a mismatch awaiting the user (S5).
        ['squad_1', 'mismatch'],
        ['squad_2', 'pending'],
      ],
    );
    assert.deepEqual(f.writes, ['POST /v1/adaccounts/acct1/campaigns', 'POST /v1/campaigns/camp1/adsquads']);
  } finally {
    f.close();
  }
});

test('recover_step checks whether a step can be recovered before asking for confirmation, and says which field', async () => {
  const f = fixture({pixels: ['pixel-own']});
  try {
    const id = (await createPlan(f, foreignPlan())).data.id;
    await f.call('amcp_campaign', {action: 'preflight', id});
    // Not recoverable: the refusal says so, without first asking for a confirmation that could not help.
    const campaign = await f.call('amcp_campaign', {action: 'recover_step', id, step_id: 'campaign'});
    assert.equal(campaign.error.code, 'RECOVERY_NOT_SAFE');
    const unknown = await f.call('amcp_campaign', {action: 'recover_step', id, step_id: 'nope'});
    assert.match(unknown.error.message, /nope.*campaign, squad_1, squad_2/);
    // Recoverable: the refusal names the missing field.
    const unconfirmed = await f.call('amcp_campaign', {
      action: 'recover_step',
      id,
      step_id: 'squad_1',
      patch: [{path: '/payload/adsquads/0/pixel_id', value: 'pixel-own'}],
    });
    assert.equal(unconfirmed.error.code, 'INVALID_ARGUMENT');
    assert.match(unconfirmed.error.message, /confirmed: true/);
    const cancel = await f.call('amcp_campaign', {action: 'cancel', id});
    assert.match(cancel.error.message, /confirmed: true/);
  } finally {
    f.close();
  }
});

test('a plan with 49 blocked ad squads still answers within 12 KB and names the first amendment', async () => {
  const f = fixture({pixels: ['pixel-own']});
  try {
    const steps = [
        campaignStep(),
        ...Array.from({length: 49}, (_, i) => squadStep(i + 1, {}, {pixel_id: 'pixel-foreign'})),
      ],
      id = (await createPlan(f, steps)).data.id;
    for (const action of ['preflight', 'prepare_next', 'get']) {
      const r = await f.call('amcp_campaign', {action, id});
      assert.ok(bytes(r) <= 12 * 1024, action + ' ' + bytes(r));
      if (action !== 'get') {
        assert.equal(r.data.next_call.arguments.step_id, 'squad_1', action);
        // Identical refusals are stated once, with every step they block.
        const all = r.data.missing_requirements.flatMap((m: JsonObject) => m.steps ?? [m.step]);
        assert.equal(all.length, 49, action);
      }
    }
    assert.equal(f.writes.length, 0);
  } finally {
    f.close();
  }
});
