// V2-MCP-02 (decision 2): bootstrap returns the option rules and the defaults of each platform and level, in the one
// shape platforms[].reporting_v4 already has (the website reads it). Every value below is checked against the code that
// applies it, so a rule bootstrap states is a rule the server enforces.
import test from 'node:test';
import assert from 'node:assert/strict';
import {reportPlatforms} from '../dist/src/report-metrics.js';
import {reportSource} from '../dist/src/report-sources.js';
import * as overviewV4 from '../dist/src/overview-v4.js';
import {overviewConfigLimits} from '../dist/src/report-tool-schema.js';
import {overviewGranularityFixture, granularConfig, granularSource} from './fixtures/overview-granularity-data.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

const tool = 'amcp_reporting_overview';
function fixture(t) {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  return {...f, call: args => f.service.call(tool, args, f.actor)};
}
const platformsOf = async f => {
  const boot = await f.call({action: 'bootstrap'});
  assert.equal(boot.success, true, JSON.stringify(boot.error));
  return {boot: boot.data, byId: new Map(boot.data.platforms.map(platform => [platform.id, platform.reporting_v4]))};
};

test('each level of each platform names the list its native IDs go in, from the table', async t => {
  const {byId} = await platformsOf(fixture(t));
  assert.deepEqual([...byId.keys()], Object.keys(reportPlatforms));
  for (const [id, rules] of byId) {
    const table = reportSource(id).overview;
    assert.deepEqual(
      rules.levels.map(level => level.id),
      table.levels.map(level => level.id),
      id,
    );
    for (const level of rules.levels) {
      const [field] = overviewV4.overviewV4ScopeFields.find(([, name]) => name === level.id);
      assert.equal(level.scope_field, field, id + ' ' + level.id);
      assert.equal(level.scope_id_prefix, table.scope_id_prefixes?.[level.id], id + ' ' + level.id);
    }
    // The fields bootstrap already had are the table’s, unchanged.
    assert.deepEqual(rules.defaults, table.defaults, id);
    assert.deepEqual(rules.option_names, table.option_names, id);
    assert.deepEqual(rules.supported_statuses, table.supported_statuses, id);
    assert.equal(rules.status_basis, table.status_basis, id);
  }
  // LinkedIn is the platform whose reports and parent reads spell an ID with a prefix; the others declare none.
  assert.equal(
    byId.get('linkedin').levels.find(level => level.id === 'adset').scope_id_prefix,
    'urn:li:sponsoredCampaign:',
  );
  assert.equal(byId.get('meta').levels[0].scope_id_prefix, undefined);
});

test('a source that leaves out levels, statuses, delivered_only and report_options gets what bootstrap says it gets', async t => {
  const f = fixture(t),
    {boot, byId} = await platformsOf(f);
  for (const [id, rules] of byId) {
    assert.deepEqual(rules.source_defaults, {levels: ['campaign'], statuses: ['all'], delivered_only: true}, id);
    const normalized = overviewV4.normalizeOverviewV4Source(
      {platform: id, account_id: '1', connection_id: 'login'},
      reportSource(id).overview,
    );
    assert.deepEqual(
      {levels: normalized.levels, statuses: normalized.statuses, delivered_only: normalized.delivered_only},
      rules.source_defaults,
      id,
    );
    assert.deepEqual(normalized.report_options, rules.defaults, id);
  }
  // The same through the server: a saved definition keeps exactly those values for the source that left them out.
  const saved = await f.call({
    action: 'save',
    confirmed: true,
    config: {
      name: 'Synthetic defaults',
      contract_version: 'overview-config-v4',
      sources: [{platform: 'google', account_id: '123', connection_id: granularSource('google').connection_id}],
      date_range: {since: '2026-09-01', until: '2026-09-02'},
    },
  });
  assert.equal(saved.success, true, JSON.stringify(saved.error));
  const source = saved.data.config.sources[0];
  assert.deepEqual(
    {levels: source.levels, statuses: source.statuses, delivered_only: source.delivered_only},
    byId.get('google').source_defaults,
  );
  assert.deepEqual(boot.config_limits, {
    sources: overviewConfigLimits.sources,
    ids_per_scope: overviewV4.overviewV4ScopeIdLimit,
  });
});

test('the options a platform’s provider configures may be left null only where bootstrap says', async t => {
  const f = fixture(t),
    {byId} = await platformsOf(f);
  for (const [id, rules] of byId) {
    const table = reportSource(id).overview,
      nullable = table.legacy?.provider_configured_options ?? [];
    assert.deepEqual(rules.provider_configured_options, nullable, id);
    if (!nullable.length) {
      assert.equal(rules.provider_configured_levels, undefined, id);
      continue;
    }
    assert.deepEqual(rules.provider_configured_levels, ['campaign'], id);
    const unset = Object.fromEntries(nullable.map(name => [name, null]));
    const source = levels => ({platform: id, account_id: '1', connection_id: 'login', levels, report_options: unset});
    // Null is accepted when every requested level is one bootstrap names, and refused when another is requested.
    assert.doesNotThrow(
      () => overviewV4.normalizeOverviewV4Source(source(rules.provider_configured_levels), table),
      id,
    );
    const detail = table.levels.map(level => level.id).find(level => !rules.provider_configured_levels.includes(level));
    assert.throws(
      () => overviewV4.normalizeOverviewV4Source(source([...rules.provider_configured_levels, detail]), table),
      error => error.code === 'INVALID_REPORT_SOURCE',
      id,
    );
  }
  assertRefused(
    await f.call({
      action: 'run',
      confirmed: true,
      config: granularConfig({
        platform: 'meta',
        account_id: '100',
        connection_id: granularSource('meta').connection_id,
        levels: ['campaign', 'adset'],
        report_options: {attribution_windows: null},
      }),
    }),
    'INVALID_REPORT_SOURCE',
  );
});
