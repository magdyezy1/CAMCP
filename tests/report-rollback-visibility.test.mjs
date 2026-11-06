import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {workHereLevels, workHereValidates} from './fixtures/work-here-v3-validator.mjs';
import {rollbackFixture, rollingWindow} from './helpers/rollback-fixture.mjs';
import {saveAccessSet} from '../dist/src/access-sets.js';
import {overviewConfigV4, overviewDefinitionForms, publicOverviewDefinition} from '../dist/src/overview-v4.js';
import {reportSource} from '../dist/src/report-sources.js';

// F-L10-11: on a rollback a report that only this build can express refuses on Work-here, and its schedule pauses. The
// owner must be able to see which, before rolling back: every record says `rollback_safe`, and bootstrap counts them.
const capabilities = platform => reportSource(platform).overview;
const uuid = '11111111-2222-3333-4444-555555555555';

// ---- the flag is exactly what Work-here can run, over a generated space of definitions ----
let seed = 20261106;
const random = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296,
  pick = list => list[Math.floor(random() * list.length)];

/** The v4-only features the owner named. A definition holding none must be runnable on Work-here, and one holding any must not. */
function v4Only(platform, source, template) {
  const [level] = source.levels,
    options = source.report_options ?? {},
    detail = level !== 'campaign',
    scoped = ['campaign_ids', 'adset_ids', 'ad_ids'].some(field => source[field]?.length),
    // The scalar parent filter Snapchat's ad squads have is the one ID scope Work-here can hold.
    parentAlias =
      !template &&
      platform === 'snapchat' &&
      level === 'adset' &&
      source.campaign_ids?.length === 1 &&
      !source.adset_ids?.length &&
      !source.ad_ids?.length;
  return (
    source.levels.length > 1 ||
    // A level only this build has (LinkedIn's middle level, X's detail levels): Work-here cannot collect it.
    !workHereLevels(platform).includes(level) ||
    (scoped && !parentAlias) ||
    (source.statuses && !(source.statuses.length === 1 && source.statuses[0] === 'all')) ||
    (!detail && options.complete_window === false) ||
    (detail &&
      (typeof options.complete_window !== 'boolean' ||
        (['tiktok', 'snapchat'].includes(platform) && options.complete_window !== true) ||
        (platform === 'meta' && !options.result_action_type) ||
        source.native_metrics?.length)) ||
    (!template && platform === 'snapchat' && level === 'adset' && !parentAlias)
  );
}
const detailOptions = {
  meta: {result_action_type: 'purchase', attribution_windows: ['7d_click']},
  snapchat: {swipe_up_attribution_window: '28_DAY', view_attribution_window: '1_DAY'},
};

test('rollback_safe is exactly whether Work-here can run the definition, for sources and for template defaults', async t => {
  const f = rollbackFixture(t),
    boot = await f.handle({action: 'bootstrap'}),
    platforms = boot.platforms.filter(p => !['ga4', 'gsc'].includes(p.id));
  let checked = 0,
    safe = 0,
    refused = 0;
  const disagreements = [];
  for (let i = 0; i < 4000; i++) {
    const declaration = pick(platforms),
      platform = declaration.id,
      ids = declaration.reporting_v4.levels.map(level => level.id),
      levels = pick([...ids.map(level => [level]), ids.slice(0, 2), ids.slice(-2), ids]),
      detail = levels.some(level => level !== 'campaign'),
      source = {
        platform,
        account_id: '100',
        connection_id: 'login-' + platform,
        levels,
        delivered_only: pick([undefined, true, false]),
        ...pick([{}, {}, {statuses: ['all']}, {statuses: ['active']}]),
        ...pick([{}, {}, {}, {campaign_ids: [platform === 'snapchat' ? uuid : '111']}, {ad_ids: ['222']}]),
        ...pick([{}, {}, {native_metrics: ['impressions']}]),
        ...(pick([true, false])
          ? {
              report_options: {
                ...pick([{}, {complete_window: true}, {complete_window: false}, {complete_window: null}]),
                ...(detail || pick([false, true]) ? (detailOptions[platform] ?? {attribution: 'declared'}) : {}),
              },
            }
          : {}),
      };
    if (levels.length === 1 && levels[0] === 'adset' && platform === 'snapchat') source.campaign_id = uuid;
    for (const template of [false, true]) {
      let config;
      try {
        config = f.overview.config(
          f.body(template ? [] : [source], {
            contract_version: overviewConfigV4,
            date_range: rollingWindow,
            ...(template
              ? {source_defaults: {[platform]: (({platform: _p, account_id, connection_id, ...rest}) => rest)(source)}}
              : {}),
          }),
          f.actor,
          template,
        );
      } catch (error) {
        refused++;
        continue; // V2 itself refuses this combination: there is nothing stored to roll back
      }
      const forms = overviewDefinitionForms(config, capabilities),
        record = {id: 'generated', revision: 1, ...forms},
        shown = publicOverviewDefinition(record),
        verdict = workHereValidates(forms.config, {template}),
        stored = template ? config.source_defaults[platform] : config.sources[0],
        expectedUnsafe = !!v4Only(platform, stored, template);
      checked++;
      if (shown.rollback_safe) safe++;
      if (shown.rollback_safe && !verdict.ok)
        disagreements.push(['claims safe, Work-here refuses ' + verdict.code, JSON.stringify(stored)]);
      if (shown.rollback_safe === expectedUnsafe)
        disagreements.push([
          expectedUnsafe ? 'has a v4-only feature, claims safe' : 'has none, claims unsafe',
          JSON.stringify(stored),
        ]);
      assert.equal(shown.config, record.config_v4, 'the public form is the current one');
    }
  }
  assert.deepEqual(disagreements.slice(0, 5), []);
  assert.ok(
    checked > 2000 && safe > 300 && checked - safe > 300,
    `checked ${checked}, safe ${safe}, V2 refused ${refused}`,
  );
});

// ---- bootstrap: the count, and what each record says ----
test('bootstrap counts the stored definitions that stop on Work-here, and each record says whether it does', async t => {
  const f = rollbackFixture(t, {platforms: ['meta', 'tiktok']}),
    destination = await f.handle({
      action: 'bind_file_destination',
      confirmed: true,
      idempotency_key: 'visibility-files-0001',
      file_destination: {name: 'Visibility files', formats: ['xlsx']},
    }),
    mcp = (source, extra = {}) =>
      f.body([source], {contract_version: overviewConfigV4, date_range: rollingWindow, ...extra}),
    save = async (config, action = 'save') => f.handle({action, config, confirmed: true});
  const safeView = await save(mcp(f.source('meta', {levels: ['campaign']}))),
    levelsView = await save(
      mcp(
        f.source('meta', {
          levels: ['campaign', 'ad'],
          delivered_only: false,
          report_options: {complete_window: true, result_action_type: 'purchase', attribution_windows: ['7d_click']},
        }),
      ),
    ),
    scopeView = await save(mcp(f.source('tiktok', {levels: ['campaign'], campaign_ids: ['111']}))),
    statusView = await save(mcp(f.source('tiktok', {levels: ['campaign'], statuses: ['active']}))),
    legacy = f.body([f.source('meta')], {date_range: rollingWindow}),
    safeTemplate = await save(mcp(f.source('meta', {levels: ['campaign']})), 'save_template'),
    unsafeTemplate = await save(
      mcp(
        f.source('meta', {
          levels: ['campaign', 'ad'],
          delivered_only: false,
          report_options: {complete_window: true, result_action_type: 'purchase', attribution_windows: ['7d_click']},
        }),
      ),
      'save_template',
    );
  f.store.putDocument(f.actor.tenantId, 'overview_view', 'stored-v3', {config: legacy, created_at: 1});
  const schedule = await f.handle({
    action: 'schedule',
    id: levelsView.id,
    idempotency_key: 'visibility-sched-0001',
    schedule: {schedule_kind: 'daily', timezone: 'UTC', schedule_config: {hour: 8}, destination_id: destination.id},
    confirmed: true,
  });
  const boot = await f.handle({action: 'bootstrap'}),
    flag = (list, id) => list.find(record => record.id === id).rollback_safe;
  assert.equal(flag(boot.views, safeView.id), true);
  assert.equal(flag(boot.views, 'stored-v3'), true, 'a stored v3 report is its own earlier form');
  for (const view of [levelsView, scopeView, statusView]) assert.equal(flag(boot.views, view.id), false, view.id);
  assert.equal(flag(boot.templates, safeTemplate.id), true);
  assert.equal(flag(boot.templates, unsafeTemplate.id), false);
  assert.equal(
    flag(boot.schedules, schedule.id),
    false,
    'the schedule of an unsafe report pauses on the earlier build',
  );
  // views 3, template 1, schedule 1: every stored record Work-here would read and refuse.
  assert.equal(boot.rollback.unsafe_definitions, 5);
  assert.equal(
    boot.views.concat(boot.templates, boot.schedules).filter(record => record.rollback_safe === false).length,
    5,
  );
  assert.equal(boot.views.find(record => record.id === safeView.id).config_v4, undefined);
});

test('bootstrap counts only the definitions a client-limited key may see', async t => {
  const A = '7100000001',
    B = '7200000002',
    f = rollbackFixture(t, {platforms: []});
  f.store.putConnection(
    f.actor,
    {
      id: 'meta-login',
      tenantId: f.actor.tenantId,
      gateway: 'meta_native_action',
      accounts: [A, B],
      writeAccounts: [A, B],
      enabled: true,
      label: 'Meta',
      scopes: ['ads_read'],
    },
    {accessToken: 'synthetic'},
  );
  const set = saveAccessSet(f.store, f.actor, {
      name: 'Client A',
      bindings: [{gateway: 'meta_native_action', connection_id: 'meta-login', account_id: A}],
    }),
    scoped = f.store.authenticate(
      f.store.createKey({
        tenantId: f.actor.tenantId,
        userId: 'connector/client-a',
        role: 'operator',
        accessSetId: String(set.id),
      }),
    );
  for (const account of [A, B, B])
    await f.handle({
      action: 'save',
      confirmed: true,
      config: f.body(
        [
          {
            platform: 'meta',
            account_id: account,
            connection_id: 'meta-login',
            levels: ['campaign'],
            statuses: ['active'],
          },
        ],
        {
          name: 'Unsafe ' + account,
          contract_version: overviewConfigV4,
          date_range: rollingWindow,
        },
      ),
    });
  assert.equal((await f.overview.handle({action: 'bootstrap'}, f.actor)).rollback.unsafe_definitions, 3);
  assert.equal((await f.overview.handle({action: 'bootstrap'}, scoped)).rollback.unsafe_definitions, 1);
});

// ---- the runbook says what the code does ----
test('the operations runbook names the reports that stop on a rollback, the error, and where to look', () => {
  const text = fs.readFileSync('docs/OPERATIONS.md', 'utf8'),
    start = text.indexOf('## Before a rollback'),
    section = text.slice(start, text.indexOf('\n## ', start + 1));
  assert.ok(start > 0, 'the section exists');
  for (const claim of [
    'several reporting levels',
    'ID scopes',
    'a status filter',
    'a declared-incomplete campaign window',
    'an undeclared detail window',
    'a level only this build has',
    '`INVALID_REPORT_LEVEL`',
    'before any provider request',
    'its schedule pauses',
    '`rollback.unsafe_definitions`',
    '`rollback_safe: false`',
    'operations/MIGRATIONS.md#schema-migrations-and-rollback',
  ])
    assert.ok(section.includes(claim), claim);
  assert.ok(fs.readFileSync('docs/operations/MIGRATIONS.md', 'utf8').includes('# Schema migrations and rollback'));
});
