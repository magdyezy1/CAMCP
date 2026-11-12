// V2-MCP-02 (decision 1): the `config` argument of amcp_reporting_overview is typed from the server tables. These tests
// read the listing as an MCP client does, compile its input schema with a JSON Schema validator, and compare it with the
// tables validation and the bootstrap read (each platform's report source, the level and scope tables, the grains). They
// also hold the rule that matters most to a client already in use: the schema never refuses a call the handler accepts.
import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {reportPlatforms} from '../dist/src/report-metrics.js';
import {reportSource} from '../dist/src/report-sources.js';
import {reportGrains} from '../dist/src/report-periods.js';
import * as overviewV4 from '../dist/src/overview-v4.js';
// The generator is new: the schema is read through the listing first, so the test shows what a client sees without it.
const generator = await import('../dist/src/report-tool-schema.js').catch(() => ({}));
import {overviewGranularityFixture, granularConfig, granularSource} from './fixtures/overview-granularity-data.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

const tool = 'amcp_reporting_overview';
const platforms = Object.keys(reportPlatforms);
const tables = platforms.map(platform => ({platform, overview: reportSource(platform).overview}));
const union = lists => [...new Set(lists.flat())];
function fixture(t) {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  const listed = f.service.listTools().find(item => item.name === tool);
  return {
    ...f,
    listed,
    call: args => f.service.call(tool, args, f.actor),
    // What an SDK client does with the listing: compile the tool's input schema and check the arguments before sending.
    validate: new Ajv({strict: false}).compile(listed.inputSchema),
  };
}
const sourceProperties = listed => listed.inputSchema.properties.config.properties.sources.items.properties;

test('the config schema is generated from the tables: its enums are their union, and each platform’s table validates against it', t => {
  const f = fixture(t),
    source = sourceProperties(f.listed),
    facts = generator.overviewTableFacts();
  assert.deepEqual(source.platform.enum, platforms);
  assert.deepEqual(source.levels.items.enum, union(tables.map(({overview}) => overview.levels.map(level => level.id))));
  assert.deepEqual(source.level.enum, source.levels.items.enum);
  assert.equal(source.levels.maxItems, Math.max(...tables.map(({overview}) => overview.levels.length)));
  assert.deepEqual(source.statuses.items.enum, union(tables.map(({overview}) => overview.supported_statuses)));
  assert.deepEqual(
    Object.keys(source).filter(name => name.endsWith('_ids')),
    overviewV4.overviewV4ScopeFields.map(([field]) => field),
  );
  for (const [field] of overviewV4.overviewV4ScopeFields) {
    assert.equal(source[field].maxItems, overviewV4.overviewV4ScopeIdLimit, field);
    assert.deepEqual(source[field].items, {type: 'string'}, field);
  }
  assert.deepEqual(f.listed.inputSchema.properties.config.properties.grain.enum, reportGrains);
  // The generator and the facts it reads agree (no second copy of a table).
  assert.deepEqual(facts.platforms, platforms);
  assert.deepEqual(facts.levels, source.levels.items.enum);
  assert.deepEqual(facts.statuses, source.statuses.items.enum);
  assert.deepEqual(generator.overviewConfigSchema(), f.listed.inputSchema.properties.config);

  for (const {platform, overview} of tables) {
    const base = {platform, account_id: '100', connection_id: 'login'},
      sourceOf = extra => ({
        action: 'run',
        config: {name: 'Synthetic', sources: [{...base, ...extra}]},
        confirmed: true,
      });
    // Everything a platform's table declares is accepted by the schema and by the table-driven normalisation alike.
    for (const level of overview.levels.map(item => item.id)) {
      assert.ok(
        f.validate(sourceOf({levels: [level], level})),
        platform + ' level ' + level + ': ' + JSON.stringify(f.validate.errors),
      );
      assert.doesNotThrow(
        () => overviewV4.normalizeOverviewV4Source({...base, levels: [level]}, overview),
        platform + ' ' + level,
      );
    }
    const all = overview.levels.map(item => item.id);
    assert.ok(f.validate(sourceOf({levels: all})), platform + ' every level: ' + JSON.stringify(f.validate.errors));
    for (const status of overview.supported_statuses)
      assert.ok(f.validate(sourceOf({statuses: [status]})), platform + ' status ' + status);
    const defaults = {report_options: overview.defaults, delivered_only: true};
    assert.ok(f.validate(sourceOf(defaults)), platform + ' defaults');
    assert.doesNotThrow(
      () => overviewV4.normalizeOverviewV4Source({...base, ...defaults}, overview),
      platform + ' defaults',
    );
    for (const [field, level] of overviewV4.overviewV4ScopeFields)
      if (overview.levels.some(item => item.id === level)) {
        const id = overview.scope_id_pattern ? '00000000-0000-4000-8000-000000000001' : '1234';
        assert.ok(f.validate(sourceOf({[field]: [id]})), platform + ' ' + field);
      }
  }
});

test('a client that validates against the input schema can send an old level string, and the server runs it', async t => {
  const f = fixture(t);
  for (const platform of ['google', 'meta', 'tiktok', 'linkedin', 'x', 'snapchat'])
    for (const level of ['campaign', 'adset', 'ad']) {
      // The v3 shape: one `level`, an `objective`, the platform’s detail options. Nothing in it is a v4 field.
      const old = granularSource(platform, level);
      // A campaign-level v3 source has no detail options (the platform’s own attribution profile is optional).
      if (level === 'campaign') delete old.report_options;
      const args = {action: 'run', config: granularConfig(old), confirmed: true};
      assert.equal(old.levels, undefined);
      assert.ok(f.validate(args), platform + ' ' + level + ': ' + JSON.stringify(f.validate.errors));
      const run = await f.call(args);
      assert.equal(run.success, true, platform + ' ' + level + ': ' + JSON.stringify(run.error));
    }
  // The v4 spelling of the same sources, and both together as the SDK 1.x clients of the recorded exchange send them.
  const v4 = {...granularSource('meta', 'adset'), levels: ['campaign', 'adset'], statuses: ['active', 'paused']};
  assert.ok(f.validate({action: 'run', config: granularConfig(v4), confirmed: true}));
  // The schema is no longer opaque: a level no platform has, a wrong type and an unknown platform are refused by it.
  const refused = source => f.validate({action: 'run', config: granularConfig(source), confirmed: true});
  assert.equal(refused({...v4, levels: ['adgroup']}), false);
  assert.equal(refused({...v4, level: 'adgroup'}), false);
  assert.equal(refused({...v4, levels: 'campaign'}), false);
  assert.equal(refused({...v4, delivered_only: 'yes'}), false);
  assert.equal(refused({...v4, platform: 'google_ads'}), false);
  assert.equal(refused({...v4, campaign_ids: '123'}), false);
  assert.equal(f.validate({action: 'run', config: {...granularConfig(v4), grain: 'hourly'}, confirmed: true}), false);
  // The server still answers each of those with its own code when a client does not validate first.
  assertRefused(
    await f.call({action: 'run', config: granularConfig({...v4, levels: ['adgroup']}), confirmed: true}),
    'INVALID_REPORT_LEVEL',
  );
});

test('the help of every action that takes a config serves the same typed config, with the rule for finding a platform’s values', async t => {
  const f = fixture(t);
  for (const action of ['run', 'save', 'save_template', 'preview_schedule']) {
    const help = await f.call({action: 'help', topic: action}),
      config = help.data.arguments.config;
    assert.equal(help.success, true, action + ': ' + JSON.stringify(help.error));
    assert.deepEqual(config.properties, f.listed.inputSchema.properties.config.properties, action);
    assert.match(config.description, /bootstrap platforms\[\]\.reporting_v4/, action);
  }
});

test('the config schema requires nothing a use of config leaves out, closes no object and carries no root combinator', t => {
  const f = fixture(t),
    walk = (node, path = '') => {
      if (!node || typeof node !== 'object') return;
      assert.notEqual(node.additionalProperties, false, 'closed object at config' + path);
      for (const keyword of ['anyOf', 'oneOf', 'allOf', 'not']) assert.equal(node[keyword], undefined, keyword + path);
      for (const [key, child] of Object.entries(node)) walk(child, path + '.' + key);
    };
  walk(f.listed.inputSchema.properties.config);
  // A template is saved without accounts or even sources; a source of a template carries no account or login.
  const template = {
    name: 'Synthetic template',
    sources: [{platform: 'meta', levels: ['campaign', 'adset'], delivered_only: false, report_options: {}}],
  };
  assert.ok(f.validate({action: 'save_template', config: template, confirmed: true}));
  assert.ok(f.validate({action: 'save_template', config: {name: 'Synthetic template'}, confirmed: true}));
  assert.equal(f.listed.inputSchema.properties.config.required, undefined);
  assert.equal(sourceProperties(f.listed).platform.type, 'string');
  assert.equal(f.listed.inputSchema.properties.config.properties.sources.items.required, undefined);
  // No root combinator in the listing’s schema either (package mcp’s rule).
  for (const keyword of ['anyOf', 'oneOf', 'allOf', 'not']) assert.equal(f.listed.inputSchema[keyword], undefined);
  // A field an earlier build or a platform reads (report options, a parent filter, v3 names) stays open.
  assert.ok(
    f.validate({
      action: 'run',
      config: {
        name: 'Synthetic',
        legacy_field: 1,
        sources: [
          {platform: 'snapchat', campaign_id: 'parent', objective: 'sales', native_metrics: ['video_views'], extra: {}},
        ],
      },
      confirmed: true,
    }),
  );
});
