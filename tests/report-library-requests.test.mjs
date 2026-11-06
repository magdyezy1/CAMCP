import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRefused} from './helpers/assert-refused.mjs';
import {rollbackFixture, rollingWindow} from './helpers/rollback-fixture.mjs';
import {MirrorError} from '../dist/src/errors.js';
import {overviewConfigV4, upgradeOverviewV3Config} from '../dist/src/overview-v4.js';
import {reportSource} from '../dist/src/report-sources.js';

const capabilities = platform => reportSource(platform)?.overview;
const window = {since: '2026-09-01', until: '2026-09-02'};

// ---- F-L6-06: the upgrade runs on a client's body before validation, so it must refuse as Work-here's validation did ----
// Work-here's `config()` gave these codes for these bodies; the service must not turn them into INTERNAL_ERROR.
const malformed = {
  'sources is a string': [{name: 'x', sources: 'meta', date_range: window}, 'REPORT_SOURCES_REQUIRED'],
  'sources is an object': [{name: 'x', sources: {platform: 'meta'}, date_range: window}, 'REPORT_SOURCES_REQUIRED'],
  'sources contains null': [{name: 'x', sources: [null], date_range: window}, 'INVALID_REPORT_SOURCE'],
  'config is a string': ['not-an-object', 'INVALID_REPORT'],
  'config is null': [null, 'INVALID_REPORT'],
};

test('a malformed body on an edit of a saved report is refused with the code Work-here gave, through the service too', async t => {
  const f = rollbackFixture(t, {platforms: ['meta']}),
    good = await f.handle({
      action: 'save',
      confirmed: true,
      config: f.body([f.source('meta')], {date_range: rollingWindow}),
    }),
    before = JSON.stringify(f.document('overview_view', good.id));
  for (const [label, [config, code]] of Object.entries(malformed)) {
    const request = {action: 'save', id: good.id, expected_revision: good.revision, config, confirmed: true};
    await assert.rejects(f.handle(request), error => assertRefused(error, code));
    assertRefused(await f.service.call('amcp_reporting_overview', request, f.actor), code);
    assert.equal(JSON.stringify(f.document('overview_view', good.id)), before, label + ': nothing was written');
  }
});

test('a malformed body on a schedule of a saved report, or on an edit of its schedule, is refused the same way', async t => {
  const f = rollbackFixture(t, {platforms: ['meta']}),
    destination = await f.handle({
      action: 'bind_file_destination',
      confirmed: true,
      idempotency_key: 'malformed-files-0001',
      file_destination: {name: 'Malformed files', formats: ['xlsx']},
    }),
    view = await f.handle({
      action: 'save',
      confirmed: true,
      config: f.body([f.source('meta')], {date_range: rollingWindow}),
    }),
    schedule = {schedule_kind: 'daily', timezone: 'UTC', schedule_config: {hour: 8}, destination_id: destination.id},
    created = await f.handle({
      action: 'schedule',
      id: view.id,
      idempotency_key: 'malformed-sched-0001',
      schedule,
      confirmed: true,
    }),
    before = JSON.stringify(f.document('overview_schedule', created.id));
  let attempt = 0;
  // A schedule request without a config, or with null, uses the saved definition: that is not a malformed body here.
  for (const [label, [config, code]] of Object.entries(malformed).filter(([label]) => label !== 'config is null')) {
    // A new schedule for the saved report, and an update of the existing schedule, each carrying the bad body.
    const creation = {
      action: 'schedule',
      id: view.id,
      idempotency_key: 'malformed-sched-' + ++attempt + '-key',
      schedule,
      config,
    };
    const update = {action: 'update_schedule', id: created.id, expected_revision: created.revision, schedule, config};
    for (const request of [creation, update].map(input => ({...input, confirmed: true}))) {
      await assert.rejects(f.handle(request), error => assertRefused(error, code));
      assertRefused(await f.service.call('amcp_reporting_overview', request, f.actor), code);
    }
    assert.equal(JSON.stringify(f.document('overview_schedule', created.id)), before, label + ': nothing was written');
  }
});

test('the upgrade of a stored definition either returns or refuses, and never throws a crash', () => {
  const valid = {platform: 'meta', account_id: '100', connection_id: 'login-meta'},
    base = (extra = {}) => ({name: 'N', sources: [valid], date_range: window, ...extra}),
    odd = [
      null,
      [],
      'x',
      {},
      {name: 'x'},
      {name: 'x', sources: null},
      {name: 'x', sources: 'meta'},
      {name: 'x', sources: {platform: 'meta'}},
      base({sources: [null]}),
      base({sources: [undefined]}),
      base({sources: [1]}),
      base({sources: ['meta']}),
      base({sources: [[]]}),
      base({sources: [{platform: 'nope', account_id: '1', connection_id: 'c'}]}),
      base({sources: [{account_id: '1', connection_id: 'c'}]}),
      base({sources: [{...valid, level: 3}]}),
      base({sources: [{...valid, level: null}]}),
      base({sources: [{...valid, report_options: null}]}),
      base({sources: [{...valid, report_options: 'x'}]}),
      base({sources: [{...valid, report_options: [1]}]}),
      base({source_defaults: 'x'}),
      base({source_defaults: []}),
      base({source_defaults: {nope: {}}}),
      base({source_defaults: {meta: null}}),
      base({source_defaults: {meta: 'x'}}),
      {contract_version: overviewConfigV4},
      {contract_version: overviewConfigV4, sources: null},
      base({sources: [{...valid, levels: null}]}),
      base({sources: [{...valid, levels: []}]}),
      base({sources: [{...valid, levels: 'campaign'}]}),
    ];
  for (const input of odd) {
    const before = JSON.stringify(input ?? null);
    try {
      upgradeOverviewV3Config(input, capabilities);
    } catch (error) {
      assert.ok(error instanceof MirrorError, JSON.stringify(input) + ' -> ' + error);
    }
    assert.equal(JSON.stringify(input ?? null), before, 'the input is never changed');
  }
});

// ---- F-L6-12: the creation key exists so that a retry returns the schedule the first call made ----
const retryBodies = (f, platform) => ({
  'v3 body (a legacy client)': f.body([f.source(platform)], {date_range: rollingWindow}),
  'v4 body, delivered_only false': f.body([f.source(platform, {levels: ['campaign'], delivered_only: false})], {
    contract_version: overviewConfigV4,
    date_range: rollingWindow,
  }),
  'v4 body, the website default': f.body([f.source(platform, {levels: ['campaign']})], {
    contract_version: overviewConfigV4,
    date_range: rollingWindow,
  }),
  'v4 body, minimal TikTok campaign': f.body([f.source('tiktok', {levels: ['campaign']})], {
    contract_version: overviewConfigV4,
    date_range: rollingWindow,
  }),
  'v4 body, several levels': f.body(
    [
      f.source(platform, {
        levels: ['campaign', 'ad'],
        delivered_only: false,
        report_options: {complete_window: true, result_action_type: 'purchase', attribution_windows: ['7d_click']},
      }),
    ],
    {contract_version: overviewConfigV4, date_range: rollingWindow},
  ),
});

test('retrying a schedule creation with the same key returns the schedule it created, for every shape of body', async t => {
  const probe = rollbackFixture(t, {platforms: ['meta', 'tiktok']});
  for (const label of Object.keys(retryBodies(probe, 'meta'))) {
    const f = rollbackFixture(t, {platforms: ['meta', 'tiktok']}),
      destination = await f.handle({
        action: 'bind_file_destination',
        confirmed: true,
        idempotency_key: 'retry-files-0001',
        file_destination: {name: 'Retry files', formats: ['xlsx']},
      }),
      request = () => ({
        action: 'schedule',
        confirmed: true,
        config: retryBodies(f, 'meta')[label],
        idempotency_key: 'retry-sched-0001',
        schedule: {schedule_kind: 'daily', timezone: 'UTC', schedule_config: {hour: 3}, destination_id: destination.id},
      }),
      first = await f.handle(request());
    // The retry before the first tick, then after a tick has run the schedule.
    const early = await f.handle(request());
    assert.equal(early.id, first.id, label + ': retry before the first tick');
    assert.equal(early.revision, first.revision, label + ': the retry wrote nothing');
    const {id: _id, revision: _revision, ...schedule} = f.document('overview_schedule', first.id);
    f.store.putDocument(f.actor.tenantId, 'overview_schedule', first.id, {...schedule, next_run_at: Date.now() - 1000});
    f.overview.tick();
    const afterTick = f.document('overview_schedule', first.id);
    const late = await f.handle(request());
    assert.equal(late.id, first.id, label + ': retry after the first tick');
    assert.equal(late.revision, afterTick.revision, label + ': the retry wrote nothing after the tick');
    // The same key with another body is still a conflict, never a silent second schedule.
    await assert.rejects(
      f.handle({...request(), schedule: {...request().schedule, schedule_config: {hour: 9}}}),
      error => assertRefused(error, 'IDEMPOTENCY_CONFLICT'),
    );
  }
});
