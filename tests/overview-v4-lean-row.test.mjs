// Ruling 14 (package website-get): the compact v4 row `get` returns without include.native keeps the two values of AMCP's own
// that the website prints in its rows table and cannot rebuild from anything else: the evidence of a row's recommendation
// (the "based on the whole window" note and the "target and actual" line) and a LinkedIn campaign group's results by
// objective. Both are AMCP's own words and numbers, not provider data, and the full row under include.native is unchanged.
// The reports here are real: definition, queue, worker, row assembly and the `get` projection over a fake collector.
import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client, InMemoryTransport} from '@modelcontextprotocol/client';
import {createMcpServer} from '../dist/server/mcp.js';
import {overviewConfigV4, projectOverviewV4Rows} from '../dist/src/overview-v4.js';
import {reportEngine} from './helpers/report-engine.mjs';
import {row} from './helpers/report-packets.mjs';
import {offerParkedProviders} from './helpers/parked-providers.mjs';

offerParkedProviders('criteo', 'woocommerce');

const target = {kpi: 'cpm', target: 5, currency: 'USD', minimum_results: 1, conversion_lag_days: 0, context: {}};
/** A paid campaign report with a cost target, so that its recommendations rest on evidence. */
async function targeted(t, extra = {}) {
  const e = reportEngine(t, {
      packet: {source_kind: 'paid'},
      rowsFor: () => [row('campaign', 'c1', {spend: '30'}), row('campaign', 'c2', {spend: '10'})],
      ...extra,
    }),
    queued = await e.queue(['campaign'], {targets: {leads: target}});
  await e.worker.once();
  const get = include => e.overview.handle({action: 'get', id: queued.id, limit: 500, include}, e.actor);
  return {...e, id: queued.id, compact: () => get(undefined), full: () => get({native: true})};
}
const mixedResults = [
  {objective: 'LEAD_GENERATION', group: 'leads', result_definition: 'LinkedIn leads (one-click)', value: '3.3'},
  {objective: 'VIDEO_VIEW', group: 'video_views', result_definition: 'LinkedIn video views', value: '7'},
];

test('the compact row carries a recommendation whole, with its evidence, and a campaign group’s results by objective, when the stored row has them', () => {
  const evidence = {kpi: 'cpa', actual: '1.5', target: 2, currency: 'USD', results: 12},
    recommendation = {
      decision: 'scale',
      reason: 'Performance is comfortably above target.',
      evidence,
      confidence: 'moderate',
      limitations: ['Observational evidence does not establish causality or adjust for seasonality.'],
      objective: 'sales',
      as_of: 1,
      valid_until: 2,
    },
    snapshot = {config: {contract_version: overviewConfigV4, metrics: ['spend']}, sources: [{}]},
    stored = (more = {}) => ({
      entity_id: '1',
      source_ref: 0,
      objective: 'MIXED',
      objective_group: 'mixed',
      objective_source: 'provider',
      metrics: {spend: '1'},
      recommendation,
      results_by_objective: mixedResults,
      ...more,
    });
  const [compact] = projectOverviewV4Rows(snapshot, [stored()]);
  assert.deepEqual(compact.recommendation, recommendation, 'the recommendation is the stored one, evidence included');
  assert.deepEqual(compact.recommendation.evidence, evidence);
  assert.deepEqual(compact.results_by_objective, mixedResults);
  // The full row under include.native is what it was: the same two values, and the native evidence beside them.
  const [full] = projectOverviewV4Rows(snapshot, [stored({native: {daily_rows: []}})], {native: true});
  assert.deepEqual(full.recommendation, recommendation);
  assert.deepEqual(full.results_by_objective, mixedResults);
  assert.deepEqual(full.native, {daily_rows: []});
});

test('the compact row omits them when the stored row has none, and the stored row is never rewritten', () => {
  const snapshot = {config: {contract_version: overviewConfigV4, metrics: ['spend']}, sources: [{}]},
    plain = {decision: 'observe', reason: 'Measurement and organic reports provide context.'},
    stored = [
      {entity_id: '1', source_ref: 0, objective: 'X', metrics: {spend: '1'}, recommendation: plain},
      {entity_id: '2', source_ref: 0, objective: 'X', metrics: {spend: '1'}},
    ],
    before = JSON.stringify(stored),
    [withRecommendation, withoutRecommendation] = projectOverviewV4Rows(snapshot, stored);
  assert.equal(Object.hasOwn(withRecommendation.recommendation, 'evidence'), false, 'no evidence key is invented');
  assert.deepEqual(withRecommendation.recommendation, plain);
  assert.equal(Object.hasOwn(withRecommendation, 'results_by_objective'), false);
  assert.equal(withoutRecommendation.recommendation, undefined, 'a row with no recommendation still has none');
  assert.equal(Object.hasOwn(withoutRecommendation, 'results_by_objective'), false);
  assert.equal(JSON.stringify(stored), before, 'projection never rewrites retained rows');
});

test('a real report’s compact rows carry each recommendation exactly as the full rows do, and nothing else of the full row', async t => {
  const f = await targeted(t),
    compact = await f.compact(),
    full = await f.full();
  assert.equal(compact.rows.length, 2);
  assert.deepEqual(
    compact.rows.map(r => r.recommendation),
    full.rows.map(r => r.recommendation),
  );
  assert.ok(
    compact.rows.every(r => r.recommendation.evidence.target === 5),
    'the case is real: each recommendation rests on the target',
  );
  // The compact row keeps its compact shape (V2-RPT-06): these are all its fields, the two values above being the only
  // ones ruling 14 added. A field that grows the row is a change to the lean answer, and says so here.
  assert.deepEqual(Object.keys(compact.rows[0]).sort(), [
    'complete',
    'currency',
    'date_from',
    'date_to',
    'entity_id',
    'entity_name',
    'level',
    'metrics',
    'native_entity_type',
    'objective',
    'parents',
    'recommendation',
    'result',
    'result_context',
    'row_key',
    'source_ref',
    'status',
  ]);
  // A narrowed read serves the same compact row: its filters only hide rows.
  const narrowed = await f.overview.handle(
    {action: 'get', id: f.id, limit: 500, platform: 'meta', level: 'campaign'},
    f.actor,
  );
  assert.deepEqual(
    narrowed.rows.map(r => r.recommendation),
    full.rows.map(r => r.recommendation),
  );
  assert.equal(
    compact.rows.some(r => Object.hasOwn(r, 'native')),
    false,
    'no native evidence in a compact row',
  );
  assert.equal(
    full.rows.every(r => Object.hasOwn(r, 'native')),
    true,
    'and the full row still has it',
  );
});

test('a LinkedIn campaign group with different objectives reaches the compact row with its results by objective', async t => {
  const mixed = row(
      'campaign',
      '20',
      {spend: '5.5'},
      {
        objective: 'MIXED',
        objective_group: 'mixed',
        objective_source: 'provider',
        objective_reason: 'This campaign group’s campaigns have different objectives: LEAD_GENERATION, VIDEO_VIEW.',
        result_definition: 'Mixed',
        results_by_objective: mixedResults,
      },
    ),
    e = reportEngine(t, {platform: 'linkedin', rowsFor: () => [mixed, row('campaign', '21', {spend: '1'})]}),
    queued = await e.queue(['campaign']);
  await e.worker.once();
  const compact = await e.overview.handle({action: 'get', id: queued.id, limit: 500}, e.actor),
    full = await e.overview.handle({action: 'get', id: queued.id, limit: 500, include: {native: true}}, e.actor);
  assert.equal(compact.state, 'complete');
  assert.deepEqual(compact.rows[0].results_by_objective, mixedResults);
  assert.deepEqual(compact.rows[0].results_by_objective, full.rows[0].results_by_objective);
  assert.equal(compact.rows[0].objective.group, 'mixed');
  assert.equal(
    Object.hasOwn(compact.rows[1], 'results_by_objective'),
    false,
    'a row of one objective has none, in either answer',
  );
  assert.equal(Object.hasOwn(full.rows[1], 'results_by_objective'), false);
});

test('an MCP client reads the compact row with its evidence: the typed output accepts it and the listing is the one it was', async t => {
  const f = await targeted(t),
    server = createMcpServer(f.service, f.actor),
    client = new Client({name: 'Synthetic lean-row client', version: '1'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const tool = (await client.listTools()).tools.find(item => item.name === 'amcp_reporting_overview'),
    validate = new Ajv({strict: false}).compile(tool.outputSchema);
  // The SDK client validates the answer against the listed outputSchema and throws on a mismatch; the validator again below.
  const result = await client.callTool({
      name: 'amcp_reporting_overview',
      arguments: {action: 'get', id: f.id, limit: 500},
    }),
    content = JSON.parse(JSON.stringify(result.structuredContent));
  assert.equal(validate(content), true, JSON.stringify(validate.errors));
  assert.equal(content.success, true);
  assert.equal(content.data.rows[0].recommendation.evidence.target, 5);
  // Nothing about the listing changed: `rows` is open in the typed output, which still names the same fields.
  assert.deepEqual(Object.keys(tool.outputSchema.properties.data.properties), [
    'id',
    'state',
    'job_id',
    'next_call',
    'poll_after_ms',
    'has_more',
    'next_offset',
    'next_cursor',
  ]);
});
