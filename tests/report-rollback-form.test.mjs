import test from 'node:test';
import assert from 'node:assert/strict';
import {workHereConfig, workHereValidates} from './fixtures/work-here-v3-validator.mjs';
import {allReportPlatforms, rollbackFixture, rollingWindow} from './helpers/rollback-fixture.mjs';
import {editorDefaultConfig, editorResaveConfig} from './helpers/editor-default-config.mjs';
import {overviewConfigV4, upgradeOverviewV3Config} from '../dist/src/overview-v4.js';
import {reportSource} from '../dist/src/report-sources.js';

// D21: "saved reports keep a way back". What V2 stores beside its own form must be what the build production runs
// (Work-here, 4035ad7c) accepts. The judge is the vendored copy of that build's validator, never V2's own projection.
const capabilities = platform => reportSource(platform)?.overview;
const uuid = '11111111-2222-3333-4444-555555555555';
const refusal = verdict => (verdict.ok ? 'accepted' : verdict.code);
/** What Work-here would decide for a record V2 stored. */
const rollbackVerdict = (f, kind, id) =>
  workHereValidates(f.document(kind, id).config, {template: kind === 'overview_template'});
/** The saved report as the website receives it from bootstrap, which is the form its editor opens. */
const opened = async (f, id) => (await f.handle({action: 'bootstrap'})).views.find(view => view.id === id);

test('the vendored validator refuses what Work-here refuses, so a passing rollback test means something', () => {
  const cfg = (source, extra = {}) => ({
    name: 'x',
    sources: [source],
    date_range: {since: '2026-09-01', until: '2026-09-02'},
    ...extra,
  });
  const base = {platform: 'meta', account_id: '100', connection_id: 'login-meta'};
  assert.equal(refusal(workHereValidates(cfg(base))), 'accepted');
  assert.equal(refusal(workHereValidates(cfg({...base, level: 'v4_required'}))), 'INVALID_REPORT_LEVEL');
  assert.equal(
    refusal(workHereValidates(cfg({...base, level: 'campaign', campaign_id: uuid}))),
    'INVALID_REPORT_LEVEL',
  );
  assert.equal(
    refusal(workHereValidates(cfg({...base, level: 'ad', report_options: {complete_window: null}}))),
    'INVALID_REPORT_LEVEL',
  );
  assert.equal(refusal(workHereValidates(cfg(base, {metrics: ['spend', 'primary_result']}))), 'INVALID_METRICS');
  assert.equal(
    refusal(
      workHereValidates(
        cfg(base, {custom_metrics: [{id: 'p', label: 'P', formula: 'primary_result * 2'}], metrics: ['spend', 'p']}),
      ),
    ),
    'UNKNOWN_METRIC',
  );
  // A template's defaults accept only these keys; an objective fallback is V2's, not Work-here's.
  const template = defaults => cfg(base, {sources: [], source_defaults: {meta: defaults}});
  assert.equal(refusal(workHereValidates(template({objective: 'leads'}), {template: true})), 'accepted');
  assert.equal(
    refusal(workHereValidates(template({objective_fallback: 'leads'}), {template: true})),
    'INVALID_REPORT_SOURCE',
  );
  assert.equal(
    refusal(workHereValidates(template({objective_overrides: {1: 'sales'}}), {template: true})),
    'INVALID_REPORT_SOURCE',
  );
});

// ---- the 59-definition corpus: what Work-here itself accepts, on every platform, level and attribution profile ----
// The corpus of the audit's probe 12c. X has no detail level in Work-here and is covered by the default-body test.
function corpus(f) {
  const entries = [],
    add = (label, config) => entries.push({label, config});
  for (const platform of allReportPlatforms.filter(id => id !== 'x')) {
    const one = (label, extra) => add(platform + ' ' + label, f.body([f.source(platform, extra)]));
    one('campaign', {});
    one('campaign +objective leads', {objective: 'leads'});
    one('campaign +native_metrics', {native_metrics: ['impressions']});
    if (platform === 'meta') {
      one('campaign +profile 7d_click', {report_options: {attribution_windows: ['7d_click']}});
      one('campaign +profile 7d_click,1d_view', {report_options: {attribution_windows: ['7d_click', '1d_view']}});
      for (const level of ['adset', 'ad']) {
        const options = {result_action_type: 'purchase', attribution_windows: ['7d_click']};
        one(level + ' complete', {level, report_options: {complete_window: true, ...options}});
        one(level + ' declared-incomplete', {level, report_options: {complete_window: false, ...options}});
      }
    } else if (platform === 'snapchat') {
      const windows = {swipe_up_attribution_window: '28_DAY', view_attribution_window: '1_DAY'};
      one('campaign +profile', {report_options: windows});
      one('adset (parent campaign)', {
        level: 'adset',
        campaign_id: uuid,
        report_options: {complete_window: true, ...windows},
      });
      one('ad', {level: 'ad', report_options: {complete_window: true, ...windows}});
    } else if (!['ga4', 'gsc'].includes(platform)) {
      for (const level of platform === 'linkedin' ? ['ad'] : ['adset', 'ad']) {
        const options = {attribution: 'declared'};
        one(level + ' complete', {level, report_options: {complete_window: true, ...options}});
        if (platform !== 'tiktok')
          one(level + ' declared-incomplete', {level, report_options: {complete_window: false, ...options}});
      }
    }
  }
  return entries;
}

test('the corpus is made of definitions Work-here accepts, 59 of them', t => {
  const f = rollbackFixture(t);
  const entries = corpus(f),
    refused = entries.filter(entry => !workHereValidates(entry.config).ok);
  assert.deepEqual(
    refused.map(entry => entry.label + ': ' + refusal(workHereValidates(entry.config))),
    [],
  );
  assert.equal(entries.length, 59);
});

test('a stored Work-here definition keeps a way back after V2 runs it, saves it in the editor, or a legacy client saves it', async t => {
  const f = rollbackFixture(t),
    boot = await f.handle({action: 'bootstrap'}),
    failures = [],
    runs = [];
  let index = 0;
  for (const {label, config} of corpus(f)) {
    // The stored form is exactly what Work-here wrote.
    const stored = workHereConfig(config, false, true),
      id = 'work-here-' + index++;
    f.store.putDocument(f.actor.tenantId, 'overview_view', id, {config: structuredClone(stored), created_at: 1});
    const before = JSON.stringify(f.document('overview_view', id).config);
    // (1) V2 runs the definition: Work-here's form is not touched.
    const run = await f.handle({action: 'run', id, confirmed: true});
    runs.push(run.id);
    if (JSON.stringify(f.document('overview_view', id).config) !== before)
      failures.push(label + ': run changed config');
    // (2) The website editor opens it and saves it again, unchanged.
    const record = await opened(f, id),
      editorBody = editorResaveConfig(boot.platforms, record);
    await f.handle({action: 'save', id, expected_revision: record.revision, config: editorBody, confirmed: true});
    let verdict = rollbackVerdict(f, 'overview_view', id);
    if (!verdict.ok) failures.push(label + ': editor re-save -> ' + verdict.code);
    // (3) A legacy client saves its own v3 body again.
    const again = id + '-legacy';
    f.store.putDocument(f.actor.tenantId, 'overview_view', again, {config: structuredClone(stored), created_at: 1});
    await f.handle({
      action: 'save',
      id: again,
      expected_revision: f.document('overview_view', again).revision,
      config: structuredClone(stored),
      confirmed: true,
    });
    verdict = rollbackVerdict(f, 'overview_view', again);
    if (!verdict.ok) failures.push(label + ': legacy re-save -> ' + verdict.code);
  }
  assert.equal(runs.length, 59);
  assert.deepEqual(failures, []);
});

test('a report made with the editor defaults, or by an MCP client that sends only levels, runs on Work-here, on every platform', async t => {
  const f = rollbackFixture(t),
    boot = await f.handle({action: 'bootstrap'}),
    failures = [];
  for (const platform of boot.platforms.map(p => p.id)) {
    const account = {platform, connection_id: 'login-' + platform, account_id: '100'},
      bodies = {
        'editor default': editorDefaultConfig(boot.platforms, [account]),
        'MCP minimal v4': f.body([f.source(platform, {levels: ['campaign']})], {contract_version: overviewConfigV4}),
      };
    for (const [label, config] of Object.entries(bodies)) {
      const saved = await f.handle({action: 'save', config, confirmed: true});
      const verdict = rollbackVerdict(f, 'overview_view', saved.id);
      if (!verdict.ok) failures.push(platform + ' ' + label + ': ' + verdict.code + ' ' + verdict.message);
      // The V2 form keeps what Work-here cannot hold.
      assert.equal(f.document('overview_view', saved.id).config_v4.sources[0].delivered_only, true, platform + label);
    }
  }
  assert.deepEqual(failures, []);
});

test('the schedule of a default report is accepted by Work-here, both stored documents', async t => {
  const f = rollbackFixture(t),
    boot = await f.handle({action: 'bootstrap'}),
    failures = [];
  for (const platform of ['meta', 'tiktok', 'snapchat', 'linkedin']) {
    // One report tab per schedule: a tab belongs to one active schedule.
    const destination = await f.handle({
        action: 'bind_file_destination',
        confirmed: true,
        idempotency_key: 'rollback-files-' + platform,
        file_destination: {name: 'Rollback files ' + platform, formats: ['xlsx']},
      }),
      config = {
        ...editorDefaultConfig(boot.platforms, [{platform, connection_id: 'login-' + platform, account_id: '100'}]),
        date_range: rollingWindow,
      },
      view = await f.handle({action: 'save', config, confirmed: true}),
      schedule = await f.handle({
        action: 'schedule',
        id: view.id,
        idempotency_key: 'rollback-sched-' + platform,
        schedule: {schedule_kind: 'daily', timezone: 'UTC', schedule_config: {hour: 8}, destination_id: destination.id},
        confirmed: true,
      });
    for (const [kind, id] of [
      ['overview_view', view.id],
      ['overview_schedule', schedule.id],
    ]) {
      const verdict = rollbackVerdict(f, kind, id);
      if (!verdict.ok) failures.push(platform + ' ' + kind + ': ' + verdict.code);
    }
  }
  assert.deepEqual(failures, []);
});

test('v4 templates keep a form Work-here accepts, whatever objective and level defaults they carry', async t => {
  const f = rollbackFixture(t),
    failures = [],
    shapes = {
      'objective_fallback and levels': {objective_fallback: 'leads', levels: ['campaign'], delivered_only: false},
      'levels only': {levels: ['campaign'], delivered_only: false},
      'default delivered_only': {levels: ['campaign']},
      'tiktok defaults': {levels: ['campaign']},
    };
  for (const [label, defaults] of Object.entries(shapes)) {
    const platform = label.startsWith('tiktok') ? 'tiktok' : 'meta',
      saved = await f.handle({
        action: 'save_template',
        confirmed: true,
        config: f.body([f.source(platform, {levels: ['campaign'], delivered_only: false})], {
          contract_version: overviewConfigV4,
          date_range: rollingWindow,
          source_defaults: {[platform]: defaults},
        }),
      }),
      verdict = rollbackVerdict(f, 'overview_template', saved.id);
    if (!verdict.ok) failures.push(label + ': ' + verdict.code);
  }
  assert.deepEqual(failures, []);
});

test('only what Work-here cannot express fails closed: several levels, ID scopes, statuses, undeclared detail windows, v4 metrics', async t => {
  const f = rollbackFixture(t),
    mcp = (source, extra) =>
      f.body([source], {contract_version: overviewConfigV4, date_range: rollingWindow, ...extra}),
    detail = {complete_window: true, result_action_type: 'purchase', attribution_windows: ['7d_click']},
    cases = {
      'several levels': [
        mcp(f.source('meta', {levels: ['campaign', 'ad'], delivered_only: false, report_options: detail})),
        'INVALID_REPORT_LEVEL',
      ],
      'campaign ID scope': [
        mcp(f.source('meta', {levels: ['campaign'], campaign_ids: ['111']})),
        'INVALID_REPORT_LEVEL',
      ],
      'status filter': [mcp(f.source('meta', {levels: ['campaign'], statuses: ['active']})), 'INVALID_REPORT_LEVEL'],
      'undeclared detail window': [
        mcp(f.source('tiktok', {levels: ['ad'], delivered_only: false})),
        'INVALID_REPORT_LEVEL',
      ],
      'declared-incomplete campaign window': [
        mcp(f.source('snapchat', {levels: ['campaign'], report_options: {complete_window: false}})),
        'INVALID_REPORT_LEVEL',
      ],
      'v4-only metric names': [
        mcp(f.source('meta', {levels: ['campaign']}), {metrics: ['spend', 'primary_result']}),
        'INVALID_METRICS',
      ],
    };
  for (const [label, [config, code]] of Object.entries(cases)) {
    const saved = await f.handle({action: 'save', config, confirmed: true}),
      verdict = rollbackVerdict(f, 'overview_view', saved.id);
    assert.equal(refusal(verdict), code, label);
    // V2 itself reads and runs every one of them from its own form.
    assert.equal(f.document('overview_view', saved.id).config_v4.contract_version, overviewConfigV4, label);
    const run = await f.handle({action: 'run', id: saved.id, confirmed: true});
    assert.equal(run.state, 'queued', label);
  }
});

test('a delivered-only report keeps its flag in the V2 form while Work-here sees an ordinary campaign report', async t => {
  const f = rollbackFixture(t),
    saved = await f.handle({
      action: 'save',
      confirmed: true,
      config: f.body([f.source('meta', {levels: ['campaign'], delivered_only: true})], {
        contract_version: overviewConfigV4,
      }),
    }),
    record = f.document('overview_view', saved.id);
  assert.equal(record.config.sources[0].level, 'campaign');
  assert.equal(record.config.sources[0].delivered_only, undefined);
  assert.equal(record.config_v4.sources[0].delivered_only, true);
  assert.equal(saved.config.sources[0].delivered_only, true);
});

test('a Snapchat ad-squad report with one parent campaign keeps its scalar parent after an edit (F-L7-11)', async t => {
  const f = rollbackFixture(t),
    parent = uuid,
    windows = {complete_window: true, swipe_up_attribution_window: '28_DAY', view_attribution_window: '1_DAY'},
    v3 = f.body([f.source('snapchat', {level: 'adset', campaign_id: parent, report_options: windows})]);
  f.store.putDocument(f.actor.tenantId, 'overview_view', 'squad', {
    config: workHereConfig(v3, false, true),
    created_at: 1,
  });
  const record = f.document('overview_view', 'squad');
  await f.handle({
    action: 'save',
    id: 'squad',
    expected_revision: record.revision,
    config: {...structuredClone(record.config), name: 'Edited ad squads'},
    confirmed: true,
  });
  const edited = f.document('overview_view', 'squad');
  assert.equal(edited.config.name, 'Edited ad squads');
  assert.equal(edited.config.sources[0].level, 'adset');
  assert.equal(edited.config.sources[0].campaign_id, parent);
  assert.equal(edited.config.sources[0].campaign_ids, undefined);
  assert.deepEqual(edited.config_v4.sources[0].campaign_ids, [parent]);
  assert.equal(refusal(rollbackVerdict(f, 'overview_view', 'squad')), 'accepted');
  // Two parent campaigns are a V2 scope that Work-here has no field for; the same report with none is not v3 either.
  for (const campaign_ids of [[parent, '22222222-2222-3333-4444-555555555555'], []]) {
    const body = upgradeOverviewV3Config(v3, capabilities);
    body.sources[0] = {...body.sources[0], campaign_ids};
    delete body.sources[0].campaign_id;
    const saved = await f.handle({
      action: 'save',
      config: {...body, contract_version: overviewConfigV4},
      confirmed: true,
    });
    assert.equal(
      f.document('overview_view', saved.id).config.sources[0].level,
      'v4_required',
      JSON.stringify(campaign_ids),
    );
  }
});

test('an edited Meta or Snapchat campaign report stays runnable on Work-here, including after a second edit', async t => {
  const f = rollbackFixture(t),
    boot = await f.handle({action: 'bootstrap'});
  for (const platform of ['meta', 'snapchat', 'tiktok', 'google']) {
    const stored = workHereConfig(f.body([f.source(platform, {objective: 'sales'})]), false, true);
    f.store.putDocument(f.actor.tenantId, 'overview_view', platform, {config: stored, created_at: 1});
    for (let edit = 0; edit < 2; edit++) {
      const record = await opened(f, platform);
      await f.handle({
        action: 'save',
        id: platform,
        expected_revision: record.revision,
        config: {...editorResaveConfig(boot.platforms, record), name: 'Edit ' + edit},
        confirmed: true,
      });
      assert.equal(refusal(rollbackVerdict(f, 'overview_view', platform)), 'accepted', platform + ' edit ' + edit);
    }
    const final = f.document('overview_view', platform);
    assert.equal(final.config.sources[0].objective, 'sales', platform + ': Work-here sees the saved choice');
  }
});
