import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {assertRefused} from './helpers/assert-refused.mjs';
import {editsFixture, gateway, TIKTOK, utcText} from './fixtures/tiktok-smart-plus-edits.mjs';

/**
 * T6 (r25-m4-smartedits): the schedule of an Upgraded Smart+ ad group. TikTok's "Update an Upgraded Smart+ Ad Group" (read 2026-11-20,
 * impl/r25-m4-DOCS-EVIDENCE.md section 4) lets `schedule_type` (SCHEDULE_FROM_NOW or SCHEDULE_START_END) and `schedule_start_time`
 * ("YYYY-MM-DD HH:MM:SS", UTC+0, "up to 12 hours earlier than the current time, but not later than 2028-01-01 00:00:00") be updated and puts
 * no condition on when; it allows SCHEDULE_START_END only with BUDGET_MODE_TOTAL at the campaign or the ad group. AMCP qualifies the part
 * that cannot surprise a budget: the schedule type is only restated (a change of it is refused: a START_END group exists only under a
 * total budget, and AMCP never changes the type), and the start is moved only on an ad group that has not started, to a time that has not
 * come, before the end in effect. That is AMCP's own rule, stricter than TikTok's. Both need spend_change_confirmed, as the end time does.
 *
 * The clock is pinned: the start must be in the future and before 2028-01-01, a window that closes in December 2027.
 */
const now = Date.UTC(2026, 10, 21, 12, 0, 0),
  day = 86400000;
mock.timers.enable({apis: ['Date'], now});
test.after(() => mock.timers.reset());

const fixture = () => editsFixture({now});
const at = days => utcText(now + days * day);
const START_END = 'SCHEDULE_START_END',
  FROM_NOW = 'SCHEDULE_FROM_NOW';
const moveStart = (id, days, extra = {}) => ({
  adgroup_id: id,
  schedule_type: START_END,
  schedule_start_time: at(days),
  ...extra,
});
const refusedStart = async (f, payload, message, field = 'schedule_start_time') => {
  const r = await f.prepareGroup(payload);
  assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP_UPDATE', {writes: () => f.writes.length});
  assert.equal(r.error.details.field, field, JSON.stringify(payload));
  assert.match(r.error.message, message, JSON.stringify(payload));
  return r;
};

test('a new start on an ad group that has not started, with its schedule type unchanged, needs spend_change_confirmed, is sent once and verifies', async () => {
  const f = fixture();
  try {
    // Ad group 320 is SCHEDULE_START_END under a total budget, starts in two days and ends in ninety.
    const p = await f.preparedGroup(moveStart('320', 5));
    assert.deepEqual(p.data.creative_impact.changes.schedule_type, {before: START_END, after: START_END});
    assert.deepEqual(p.data.creative_impact.changes.schedule_start_time, {before: at(2), after: at(5)});
    assert.equal(p.data.creative_impact.may_affect_serving, false, 'the ad group is paused');
    assert.equal(
      (await f.preparedGroup(moveStart('324', 5))).data.creative_impact.may_affect_serving,
      true,
      'an enabled ad group is queued to spend',
    );
    const refused = await f.execute(p.data.review_id);
    assertRefused(refused, 'SPEND_CONFIRMATION_REQUIRED', {writes: () => f.writes.length});
    assert.match(refused.error.message, /schedule/);
    const x = await f.execute(p.data.review_id, {spend_change_confirmed: true});
    assert.equal(x.success, true, JSON.stringify(x));
    assert.deepEqual(f.writes, [
      {advertiser_id: '123', adgroup_id: '320', schedule_type: START_END, schedule_start_time: at(5)},
    ]);
    assert.equal(f.groups[320].schedule_start_time, at(5));
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
    assert.equal((await f.execute(p.data.review_id, {spend_change_confirmed: true})).data.replayed, true);
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('the start alone is accepted, the end time alone behaves as before, and a new start must stay before the new end', async () => {
  const f = fixture();
  try {
    assert.equal(
      (await f.prepareGroup({adgroup_id: '320', schedule_start_time: at(5)})).success,
      true,
      'the start without the type',
    );
    assert.equal(
      (await f.prepareGroup({adgroup_id: '320', schedule_end_time: at(120)})).success,
      true,
      'the end alone, as before',
    );
    // Both at once: the end is judged against the start in effect, the new one, as the start is against the end in effect.
    assert.equal((await f.prepareGroup(moveStart('320', 100, {schedule_end_time: at(120)}))).success, true);
    await refusedStart(f, moveStart('320', 100, {schedule_end_time: at(50)}), /must be before the end time in effect/);
    const late = await f.prepareGroup({adgroup_id: '320', schedule_start_time: at(100), schedule_end_time: at(95)});
    assertRefused(late, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP_UPDATE', {writes: () => f.writes.length});
    // The end time rules are the ones it always had.
    for (const [payload, message] of [
      [{adgroup_id: '322', schedule_end_time: at(120)}, /runs continuously/],
      [{adgroup_id: '320', schedule_end_time: at(-1)}, /in the future/],
    ]) {
      const r = await f.prepareGroup(payload);
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP_UPDATE', {writes: () => f.writes.length});
      assert.match(r.error.message, message);
    }
  } finally {
    f.store.close();
  }
});

test('the schedule type is only restated: a change in either direction is refused, an unchanged one is accepted', async () => {
  const f = fixture();
  try {
    // 320 is START_END under a total budget, 322 runs from now.
    await refusedStart(
      f,
      {adgroup_id: '320', schedule_type: FROM_NOW},
      /A schedule type change is not qualified; ad group 320 is SCHEDULE_START_END/,
      'schedule_type',
    );
    await refusedStart(
      f,
      {adgroup_id: '322', schedule_type: START_END},
      /A schedule type change is not qualified; ad group 322 is SCHEDULE_FROM_NOW/,
      'schedule_type',
    );
    assert.equal((await f.prepareGroup({adgroup_id: '322', schedule_type: FROM_NOW})).success, true);
    assert.equal((await f.prepareGroup({adgroup_id: '320', schedule_type: START_END})).success, true);
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('a start is moved only on a group that has not started, to a time that has not come and is before the end: every other start is refused', async () => {
  const f = fixture();
  try {
    // 321 started three days ago, 322 runs from now (it started when it was made), 323 starts in two days and ends in four.
    await refusedStart(f, moveStart('321', 5), /has already started/);
    await refusedStart(
      f,
      {adgroup_id: '322', schedule_start_time: at(5)},
      /runs continuously.*SCHEDULE_FROM_NOW.*only to SCHEDULE_START_END/,
    );
    // A time that has not come: AMCP's own rule, which TikTok's "up to 12 hours earlier than the current time" does not share.
    await refusedStart(f, moveStart('320', -0.25), /must be in the future/);
    await refusedStart(f, moveStart('320', -3), /must be in the future/);
    await refusedStart(f, moveStart('320', 0), /must be in the future/);
    // Before the end in effect: the end of 323 is in four days.
    await refusedStart(f, moveStart('323', 4), /must be before the end time in effect/);
    await refusedStart(f, moveStart('323', 5), /must be before the end time in effect/);
    assert.equal((await f.prepareGroup(moveStart('323', 3))).success, true);
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('a start that is no time, or is at or after 2028, is refused before any request', async () => {
  const f = fixture();
  try {
    for (const value of [
      '2026/12/01 00:00:00',
      '2026-12-01T00:00:00Z',
      '2026-12-01',
      '',
      ' ',
      20261201,
      null,
      true,
      ['2026-12-01 00:00:00'],
      '2026-13-01 00:00:00',
    ]) {
      const r = await f.prepareGroup({adgroup_id: '320', schedule_start_time: value});
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP_UPDATE', {writes: () => f.writes.length});
      assert.equal(r.error.details.field, 'schedule_start_time', JSON.stringify(value));
    }
    for (const value of ['2028-01-01 00:00:00', '2028-06-01 00:00:00', '2030-01-01 00:00:00']) {
      const r = await f.prepareGroup({adgroup_id: '320', schedule_start_time: value});
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP_UPDATE', {writes: () => f.writes.length});
      assert.match(r.error.message, /before 2028-01-01 00:00:00/, value);
    }
    for (const value of ['SCHEDULE_NOW', 'schedule_start_end', '', null, 1, ['SCHEDULE_START_END']]) {
      const r = await f.prepareGroup({adgroup_id: '320', schedule_type: value});
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP_UPDATE', {writes: () => f.writes.length});
      assert.equal(r.error.details.field, 'schedule_type', JSON.stringify(value));
    }
    assert.equal(f.requests.length, 0, 'every one was refused before any request');
  } finally {
    f.store.close();
  }
});

test('the start is checked again before execution: a group that started since the review is refused, and nothing is sent', async () => {
  const f = fixture();
  try {
    const p = await f.preparedGroup(moveStart('320', 5));
    f.groups[320].schedule_start_time = at(-1);
    const r = await f.execute(p.data.review_id, {spend_change_confirmed: true});
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP_UPDATE', {writes: () => f.writes.length});
    assert.match(r.error.message, /has already started/);
  } finally {
    f.store.close();
  }
});

test('TikTok refusing the schedule applies nothing and is a definitive refusal; a lost answer is uncertain and never sent again', async () => {
  for (const [mode, first, again] of [
    ['error', 'PLATFORM_ERROR', 'WRITE_REJECTED'],
    ['lost', 'WRITE_OUTCOME_UNCERTAIN', 'WRITE_OUTCOME_UNCERTAIN'],
  ]) {
    const f = fixture();
    try {
      const p = await f.preparedGroup(moveStart('320', 5));
      f.behaviour.mode = mode;
      assertRefused(await f.execute(p.data.review_id, {spend_change_confirmed: true}), first);
      f.behaviour.mode = '';
      f.restart();
      assertRefused(await f.execute(p.data.review_id, {spend_change_confirmed: true}), again);
      assert.equal(f.writes.length, 1, mode);
      if (mode === 'error') assert.equal(f.groups[320].schedule_start_time, at(2), 'nothing was applied');
    } finally {
      f.store.close();
    }
  }
});

test('the other edits of an ad group are as they were: a rename needs no confirmation, an end time still does, and inspect reads nothing', async () => {
  const f = fixture();
  try {
    const rename = await f.preparedGroup({adgroup_id: '320', adgroup_name: 'Renamed'});
    assert.equal((await f.execute(rename.data.review_id)).success, true);
    const end = await f.preparedGroup({adgroup_id: '320', schedule_end_time: at(100)});
    assertRefused(await f.execute(end.data.review_id), 'SPEND_CONFIRMATION_REQUIRED', {
      writes: () => f.writes.length - 1,
    });
    const before = f.requests.length;
    const i = await f.call('amcp_write', {
      action: 'inspect',
      gateway,
      connection_id: TIKTOK,
      arguments: f.args(moveStart('320', 5), 'tiktok_smart_plus_adgroup_update'),
    });
    assert.equal(i.data.review_contract_supported, true, JSON.stringify(i).slice(0, 300));
    assert.equal(f.requests.length, before);
  } finally {
    f.store.close();
  }
});
