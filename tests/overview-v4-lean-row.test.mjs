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
import {overviewConfigV4, projectOverviewV4Rows, projectOverviewV4Sources} from '../dist/src/overview-v4.js';
import {saveAccessSet} from '../dist/src/access-sets.js';
import {reportPlatforms} from '../dist/src/report-metrics.js';
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

// ---- P2B-06 (differential review, wave 5 round 2 part 2b): the marker a source retains, read together with the row it describes ----
// Each v4 source retains `projection`, which says how its rows are shown. Its `advice_evidence` said `include_native`: the evidence
// of a recommendation is returned with include.native only. That was the compact row until ruling 14 and is the opposite of what the
// row holds since, so a client (or a document) that trusts a retained snapshot's own description skips the evidence the row carries.
// The marker is read here with the row: in a real report, for a key limited to a client access set, and in a snapshot that was
// retained before the marker was corrected (the compact row is made at every read, so an old snapshot's row holds the evidence too).
/** What a client does with the marker: `include_native` sends it to include.native for the evidence; any other word does not. */
const sendsToNative = marker => marker === 'include_native';
const holdsEvidence = rows => rows.some(r => r.recommendation?.evidence !== undefined);

test('the projection a v4 source retains says where a recommendation’s evidence is, and the compact row it describes holds it there', async t => {
  const f = await targeted(t),
    compact = await f.compact(),
    full = await f.full(),
    shown = compact.sources[0].projection.advice_evidence;
  // The case is real: every row rests on the target, so every recommendation has evidence, in the compact answer and the full one.
  assert.ok(compact.rows.every(r => r.recommendation.evidence?.target === 5));
  assert.ok(full.rows.every(r => r.recommendation.evidence?.target === 5));
  // Read together: a marker that sends the client to include.native for the evidence contradicts a compact row that holds it.
  assert.equal(
    sendsToNative(shown),
    !holdsEvidence(compact.rows),
    'the marker says ' + shown + ' while the compact row holds the evidence',
  );
  // It says where the evidence is, and the same word is retained with the snapshot and returned by every read of it.
  assert.equal(shown, 'row');
  assert.equal(full.sources[0].projection.advice_evidence, shown);
  assert.equal(f.stored(f.id).sources[0].projection.advice_evidence, shown, 'retained with the snapshot');
});

test('a snapshot retained with the old marker is read with what its row holds, and what is retained is not rewritten', () => {
  const evidence = {kpi: 'cpa', actual: '1.5', target: 2, currency: 'USD', results: 12},
    recommendation = {decision: 'scale', reason: 'Performance is comfortably above target.', evidence},
    old = {quality: 'source_level_period', metric_coverage: 'partial_rows_only', advice_evidence: 'include_native'},
    snapshot = {
      config: {contract_version: overviewConfigV4, metrics: ['spend']},
      sources: [
        {source_ref: 0, projection: old},
        {source_ref: 1, projection: {quality: 'source_level_period'}},
      ],
    },
    before = JSON.stringify(snapshot),
    [source, other] = projectOverviewV4Sources(snapshot),
    [row] = projectOverviewV4Rows(snapshot, [
      {entity_id: '1', source_ref: 0, objective: 'X', metrics: {spend: '1'}, recommendation},
    ]);
  // Read together: the compact row of this old snapshot holds the evidence, so the source that describes it says so.
  assert.deepEqual(row.recommendation.evidence, evidence);
  assert.equal(sendsToNative(source.projection.advice_evidence), false);
  assert.equal(source.projection.advice_evidence, 'row');
  // Only that word changes: the other words of the projection stay, and a projection without it is left as it is.
  const {advice_evidence: _read, ...kept} = source.projection,
    {advice_evidence: _recorded, ...recorded} = old;
  assert.deepEqual(kept, recorded);
  assert.deepEqual(other.projection, {quality: 'source_level_period'});
  assert.equal(JSON.stringify(snapshot), before, 'the retained snapshot is never rewritten');
  assert.equal(snapshot.sources[0].projection.advice_evidence, 'include_native');
});

test('a key limited to a client access set reads the compact row and the marker an unlimited reader reads, with the evidence of its own full read', async t => {
  const f = await targeted(t),
    set = saveAccessSet(f.store, f.actor, {
      name: 'One account',
      bindings: [{gateway: reportPlatforms.meta.gateway, connection_id: 'login', account_id: '100'}],
    }),
    limited = f.store.authenticate(
      f.store.createKey({
        tenantId: f.actor.tenantId,
        userId: 'connector/limited',
        role: 'operator',
        accessSetId: String(set.id),
      }),
    ),
    read = include => f.overview.handle({action: 'get', id: f.id, limit: 500, include}, limited),
    compact = await read(undefined),
    full = await read({native: true}),
    unlimited = await f.compact();
  assert.equal(compact.state, 'complete', 'the report is inside the set and reads');
  assert.ok(
    compact.rows.every(r => r.recommendation.evidence?.target === 5),
    'the lean row holds the evidence for a limited key',
  );
  assert.deepEqual(
    compact.rows.map(r => r.recommendation),
    full.rows.map(r => r.recommendation),
    'the lean row holds what the key’s own include.native row holds',
  );
  assert.deepEqual(
    compact.rows.map(r => r.recommendation),
    unlimited.rows.map(r => r.recommendation),
    'and what an unlimited reader sees',
  );
  assert.equal(sendsToNative(compact.sources[0].projection.advice_evidence), !holdsEvidence(compact.rows));
  assert.equal(compact.sources[0].projection.advice_evidence, 'row');
  assert.deepEqual(compact.sources[0].projection, unlimited.sources[0].projection);
});
