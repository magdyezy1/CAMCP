import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {validateObjectiveFields, objectiveFallbackGroups} from '../dist/src/report-objectives.js';
import {normalizeNativeRow, normalizeNativeRowV4} from '../dist/src/report-native.js';
import {objectiveReportFixture} from './helpers/objective-report.mjs';
import {savedObjectiveViews} from './fixtures/saved-objective-views.mjs';

const refused = error => error.code === 'INVALID_REPORT';
test('objective_fallback accepts a supported group and refuses unknown, mixed and other values with the choices', () => {
  for (const group of objectiveFallbackGroups)
    assert.doesNotThrow(() => validateObjectiveFields({objective_fallback: group}));
  for (const value of ['unknown', 'mixed', 'web', '', null, 1, []])
    assert.throws(
      () => validateObjectiveFields({objective_fallback: value}),
      error =>
        error.code === 'INVALID_REPORT' &&
        /awareness, traffic, engagement, video_views, leads, sales, app_installs/.test(error.message),
    );
});

test('objective_overrides accepts up to 500 exact campaign IDs and normalizes LinkedIn URNs', () => {
  const source = {
    objective_overrides: Object.fromEntries(Array.from({length: 500}, (_, n) => [String(n + 1), 'leads'])),
  };
  assert.doesNotThrow(() => validateObjectiveFields(source));
  const urn = {objective_overrides: {'urn:li:sponsoredCampaignGroup:42': 'sales'}};
  validateObjectiveFields(urn);
  assert.deepEqual(urn.objective_overrides, {'42': 'sales'});
  for (const overrides of [
    Object.fromEntries(Array.from({length: 501}, (_, n) => [String(n + 1), 'leads'])),
    {'1': 'unknown'},
    {'1': 'mixed'},
    {'bad id': 'sales'},
    {['a'.repeat(201)]: 'sales'},
  ])
    assert.throws(() => validateObjectiveFields({objective_overrides: overrides}), refused);
});

test('overrides must be a plain object, and conflicting aliases cannot silently replace a campaign choice', () => {
  for (const value of [
    null,
    [],
    'sales',
    new Map([['1', 'sales']]),
    new (class Overrides {
      one = 'sales';
    })(),
  ])
    assert.throws(() => validateObjectiveFields({objective_overrides: value}), refused);
  assert.throws(
    () => validateObjectiveFields({objective_overrides: {'42': 'sales', 'urn:li:sponsoredCampaignGroup:42': 'leads'}}),
    error => error.code === 'INVALID_REPORT' && /must agree/.test(error.message),
  );
  const same = {objective_overrides: {'42': 'sales', 'urn:li:sponsoredCampaignGroup:42': 'sales'}};
  validateObjectiveFields(same);
  assert.deepEqual(same.objective_overrides, {'42': 'sales'});
});

test('source and template defaults validate the new fields, while templates remain account-free', t => {
  const f = objectiveReportFixture(t);
  assert.throws(
    () => f.overview.config({...f.config, sources: [{...f.config.sources[0], objective_fallback: 'mixed'}]}, f.actor),
    refused,
  );
  assert.throws(
    () =>
      f.overview.config(
        {...f.config, sources: [], source_defaults: {meta: {objective_fallback: 'unknown'}}},
        f.actor,
        true,
      ),
    refused,
  );
  const result = f.overview.config(
    {...f.config, sources: [], source_defaults: {meta: {objective_fallback: 'sales'}}},
    f.actor,
    true,
  );
  assert.equal(result.source_defaults.meta.objective_fallback, 'sales');
  assert.throws(
    () =>
      f.overview.config(
        {...f.config, sources: [], source_defaults: {meta: {objective_overrides: {'1': 'sales'}}}},
        f.actor,
        true,
      ),
    error => error.code === 'INVALID_REPORT_SOURCE',
  );
});

test('an unmatched override is retained in the definition and disclosed on the source, even beyond the first ten', async t => {
  const rows = [normalizeNativeRow('meta', {campaign_id: '1', objective: 'OUTCOME_TRAFFIC'})];
  const f = objectiveReportFixture(t, {rows});
  const overrides = {
    '1': 'leads',
    ...Object.fromEntries(Array.from({length: 12}, (_, n) => ['unused-' + String(n).padStart(2, '0'), 'sales'])),
  };
  const view = await f.overview.handle(
    {
      action: 'save',
      confirmed: true,
      config: {...f.config, sources: [{...f.config.sources[0], objective_overrides: overrides}]},
    },
    f.actor,
  );
  const before = JSON.stringify(f.store.document(f.actor.tenantId, 'overview_view', view.id).config);
  const result = await f.finish(await f.overview.handle({action: 'run', confirmed: true, id: view.id}, f.actor));
  assert.equal(result.rows[0].objective.group, 'leads');
  assert.equal(result.rows[0].objective.source, 'user_override');
  assert.ok(
    result.sources[0].warnings.includes(
      'Objective overrides matched no campaign in this snapshot: unused-00, unused-01, unused-02, unused-03, unused-04, unused-05, unused-06, unused-07, unused-08, unused-09 and 2 more.',
    ),
  );
  assert.equal(JSON.stringify(f.store.document(f.actor.tenantId, 'overview_view', view.id).config), before);
});

test('campaigns excluded by the display filter still count as matched overrides', async t => {
  const rows = [normalizeNativeRow('meta', {campaign_id: '1', objective: 'OUTCOME_TRAFFIC'})];
  const f = objectiveReportFixture(t, {rows});
  const result = await f.run({
    sources: [{...f.config.sources[0], objective_overrides: {'1': 'sales'}}],
    objectives: ['leads'],
  });
  assert.equal(result.rows.length, 0);
  assert.equal(
    result.sources[0].warnings.some(message => message.startsWith('Objective overrides matched no campaign')),
    false,
  );
});

// A v4 source can report several levels; its overrides belong to the source, so a campaign matched at any level counts.
const unmatchedWarning = /^Objective overrides matched no campaign/;
const tiktokCampaign = id =>
  normalizeNativeRowV4('tiktok', {
    dimensions: {campaign_id: id},
    metrics: {campaign_name: 'Campaign ' + id, spend: '10', impressions: '100', clicks: '5', conversion: '1'},
    objective_type: 'TRAFFIC',
  });
// A detailed ad row names its parent campaign, which is what an override is matched against.
const tiktokAd = (campaign, ad) => ({
  ...tiktokCampaign(campaign),
  entity_level: 'ad',
  entity_id: ad,
  entity_name: 'Ad ' + ad,
  native_entity_type: 'ad',
  parent_ids: {campaign_id: campaign},
});
const tiktokSource = (account, overrides) => ({
  platform: 'tiktok',
  account_id: account,
  connection_id: 'login',
  levels: ['campaign', 'ad'],
  delivered_only: false,
  report_options: {complete_window: true, attribution: 'unknown'},
  ...(overrides ? {objective_overrides: overrides} : {}),
});
const v4 = sources => ({contract_version: 'overview-config-v4', sources});
const unmatchedIn = source => source.warnings.filter(message => unmatchedWarning.test(message));
const perLevel = source =>
  source.level_results.flatMap(packet => (packet.warnings ?? []).filter(message => unmatchedWarning.test(message)));

test('an override matched at only one level of a multi-level source is not reported unmatched', async t => {
  const f = objectiveReportFixture(t, {
    platform: 'tiktok',
    rowsFor: source => (source.level === 'campaign' ? [tiktokCampaign('555')] : [tiktokAd('666', '9001')]),
  });
  // Campaign 555 has no ad in the snapshot, and campaign 666 has no campaign row: each is matched at one level.
  const result = await f.run(v4([tiktokSource('100', {'555': 'sales', '666': 'leads'})]));
  assert.equal(result.state, 'complete', JSON.stringify(result.sources));
  assert.deepEqual(
    result.rows.map(row => [row.level, row.entity_id, row.objective.group, row.objective.source]),
    [
      ['campaign', '555', 'sales', 'user_override'],
      ['ad', '9001', 'leads', 'user_override'],
    ],
  );
  assert.deepEqual(unmatchedIn(result.sources[0]), []);
  assert.deepEqual(perLevel(result.sources[0]), []);
});

test('an override matched at no level is reported once for its source, not once per level', async t => {
  const f = objectiveReportFixture(t, {
    platform: 'tiktok',
    rowsFor: source => (source.level === 'campaign' ? [tiktokCampaign('555')] : [tiktokAd('666', '9001')]),
  });
  const result = await f.run(v4([tiktokSource('100', {'555': 'sales', '777': 'leads'})]));
  const message = 'Objective overrides matched no campaign in this snapshot: 777.';
  assert.deepEqual(unmatchedIn(result.sources[0]), [message]);
  assert.deepEqual(perLevel(result.sources[0]), [message]);
});

test('a campaign matched in another account does not satisfy a source’s override', async t => {
  const f = objectiveReportFixture(t, {
    platform: 'tiktok',
    accounts: ['100', '200'],
    rowsFor: source => [tiktokCampaign(source.account_id === '200' ? '555' : '111')],
  });
  const sources = [tiktokSource('100', {'555': 'sales'}), tiktokSource('200', {'111': 'leads'})];
  const result = await f.run(v4(sources.map(source => ({...source, levels: ['campaign']}))));
  assert.equal(result.state, 'complete', JSON.stringify(result.sources));
  assert.deepEqual(result.sources.map(unmatchedIn), [
    ['Objective overrides matched no campaign in this snapshot: 555.'],
    ['Objective overrides matched no campaign in this snapshot: 111.'],
  ]);
  assert.deepEqual(
    result.rows.map(row => [row.entity_id, row.objective.source]),
    [
      ['111', 'provider'],
      ['555', 'provider'],
    ],
  );
});

test('normalized LinkedIn override keys match a URN campaign ID without changing row identity', async t => {
  const f = objectiveReportFixture(t, {
    platform: 'linkedin',
    rows: [{campaign_id: 'urn:li:sponsoredCampaignGroup:42', objective: 'BRAND_AWARENESS', metrics: {}}],
  });
  const result = await f.run({
    sources: [{...f.config.sources[0], objective_overrides: {'urn:li:sponsoredCampaignGroup:42': 'sales'}}],
  });
  assert.equal(result.rows[0].campaign_id, 'urn:li:sponsoredCampaignGroup:42');
  assert.equal(result.rows[0].objective_group, 'sales');
  assert.equal(result.sources[0].warnings.length, 0);
});

for (const fixture of savedObjectiveViews)
  test('saved objective compatibility: ' + fixture.id, async t => {
    const rows = [normalizeNativeRow('meta', {campaign_id: '1', objective: 'OUTCOME_TRAFFIC'})];
    const f = objectiveReportFixture(t, {rows});
    f.store.putDocument(f.actor.tenantId, 'overview_view', fixture.id, structuredClone(fixture));
    const before = JSON.stringify(f.store.document(f.actor.tenantId, 'overview_view', fixture.id).config);
    const result = await f.finish(await f.overview.handle({action: 'run', confirmed: true, id: fixture.id}, f.actor));
    assert.equal(result.rows[0].objective.group, 'traffic');
    assert.equal(result.rows[0].objective.source, 'provider');
    const stored = f.store.document(f.actor.tenantId, 'overview_view', fixture.id);
    assert.equal(JSON.stringify(stored.config), before);
    assert.equal(stored.config_v4.contract_version, 'overview-config-v4');
    assert.equal(
      stored.config_v4.sources[0].objective_fallback,
      fixture.config.sources[0].objective === 'unknown' ? undefined : 'leads',
    );
  });

test('editing a legacy definition converts its choice to a fallback and retains campaign overrides', async t => {
  const f = objectiveReportFixture(t);
  let view = await f.overview.handle(
    {
      action: 'save',
      confirmed: true,
      config: {
        ...f.config,
        sources: [{...f.config.sources[0], objective: 'leads', objective_overrides: {'1': 'traffic'}}],
      },
    },
    f.actor,
  );
  view = await f.overview.handle(
    {
      action: 'save',
      confirmed: true,
      id: view.id,
      expected_revision: view.revision,
      config: {...view.config, sources: [{...view.config.sources[0], objective_fallback: 'sales'}]},
    },
    f.actor,
  );
  assert.equal(view.config.sources[0].objective, undefined);
  assert.equal(view.config.sources[0].objective_fallback, 'sales');
  assert.deepEqual(view.config.sources[0].objective_overrides, {'1': 'traffic'});
  const {objective, ...replacement} = view.config.sources[0];
  view = await f.overview.handle(
    {
      action: 'save',
      confirmed: true,
      id: view.id,
      expected_revision: view.revision,
      config: {...view.config, sources: [replacement]},
    },
    f.actor,
  );
  assert.equal(Object.hasOwn(view.config.sources[0], 'objective'), false);
  const template = await f.overview.handle({action: 'save_template', confirmed: true, config: view.config}, f.actor);
  assert.equal(template.config.source_defaults.meta.objective_fallback, 'sales');
  assert.equal(Object.hasOwn(template.config.source_defaults.meta, 'objective_overrides'), false);
});

test('bootstrap exposes the server-owned fallback choices', async t => {
  const f = objectiveReportFixture(t);
  const bootstrap = await f.overview.handle({action: 'bootstrap'}, f.actor);
  assert.deepEqual(bootstrap.objective_fallback_groups, objectiveFallbackGroups);
});

test('Arabic unused-override warnings retain exact IDs and Latin counts', () => {
  const context = createContext({document: {addEventListener() {}}});
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  new Script(readFileSync('web/report-quality.js', 'utf8')).runInContext(context);
  context.catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
  new Script('uiLocale = "ar"; uiMessages = new Map(Object.entries(catalog));').runInContext(context);
  for (const suffix of ['.', ' and 12 more.']) {
    context.warning = 'Objective overrides matched no campaign in this snapshot: 9007199254740993' + suffix;
    const rendered = new Script('uiSourceWarning(warning)').runInContext(context);
    assert.match(rendered, /[\u0600-\u06ff]/);
    assert.match(rendered, /9007199254740993/);
    assert.doesNotMatch(rendered, /Objective overrides|and|more/);
    if (suffix.includes('12')) assert.match(rendered, /12/);
  }
});
