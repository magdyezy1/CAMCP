import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {firstPartyContract, toolActions} from '../dist/src/first-party-contracts.js';
import {allocationCandidates} from '../dist/src/report-allocation.js';
import {searchExclusionCandidates} from '../dist/src/search-exclusion-plan.js';
import {allocationReport} from './fixtures/allocation-data.mjs';
import {creativePerformanceCases, seedCreativePerformance} from './fixtures/creative-performance-data.mjs';

// MCP-07 (wave 4b MCP quality pass; mcp-builder guidance: return has_more, next_offset or next_cursor, and the total
// when known). AMCP's own lists paged three ways: some returned only next_offset (report_queries, report_bindings,
// presentation_profiles, allocation and search-exclusion candidates, an asset's joined performance rows), others only
// has_more (contracts, a captured report's rows, a snapshot's rows, the media list and its recovery reviews), so a
// client had to guess how to continue or whether anything followed. Every paged list now carries has_more and, while it
// is true, the next_offset or next_cursor that continues it, and the total where it is known.
const key = Buffer.alloc(32, 83).toString('base64'),
  actor = {tenantId: 'pagination', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'},
  meta = 'aaaaaaaa-5555-4555-8555-0000000000a1',
  google = 'aaaaaaaa-5555-4555-8555-0000000000a2';

/** has_more, then exactly the continuation it promises: next_offset or next_cursor while true, neither once false. */
function assertPage(data, label, style, prefix = '') {
  const more = data[prefix + 'has_more'],
    offset = data[prefix + 'next_offset'],
    cursor = prefix ? undefined : data.next_cursor;
  assert.equal(typeof more, 'boolean', label + ': ' + prefix + 'has_more');
  if (more) {
    if (style === 'offset')
      assert.ok(Number.isSafeInteger(offset) && offset > 0, label + ': ' + prefix + 'next_offset');
    if (style === 'cursor') assert.ok(typeof cursor === 'string' && cursor.length > 0, label + ': next_cursor');
  } else {
    assert.ok(offset === null || offset === undefined, label + ': no next_offset after the last page');
    assert.ok(cursor === null || cursor === undefined, label + ': no next_cursor after the last page');
  }
  const total = data[prefix + 'total'];
  if (total !== undefined) assert.ok(Number.isSafeInteger(total) && total >= 0, label + ': total');
  return more;
}
function fixture(t) {
  const store = new Store(':memory:', key);
  t.after(() => store.close());
  store.ensureTenant(actor.tenantId);
  for (const [id, gateway, account] of [
    [meta, 'meta_native_action', '123'],
    [google, 'google_ads_native_action', '100'],
  ])
    store.putConnection(
      admin,
      {
        id,
        tenantId: actor.tenantId,
        gateway,
        accounts: [account],
        writeAccounts: [account],
        enabled: true,
        label: 'Synthetic ' + gateway,
        scopes: [],
      },
      {accessToken: 'synthetic-' + account},
    );
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw Error('These pages make no provider request');
    }),
    undefined,
    {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  );
  const call = async (tool, args, who = actor) => {
    const out = await service.call(tool, args, who);
    assert.equal(out.success, true, tool + ' ' + args.action + ': ' + JSON.stringify(out.error));
    return out.data;
  };
  return {store, service, call, put: (kind, id, doc) => store.putDocument(actor.tenantId, kind, id, doc)};
}
/**
 * A completed overview snapshot of the Meta account with `rows` campaign rows over `range` (the journeys harness seeds
 * the same shape). Two snapshots over equal windows, the second after the first, can be compared.
 */
function snapshot(f, id, capturedAt, rows = 3, range = {since: '2026-09-01', until: '2026-09-02'}) {
  const report = {
    state: 'complete',
    captured_at: capturedAt,
    created_at: capturedAt,
    completed_at: capturedAt + 5,
    config: {
      name: 'Pagination report ' + id,
      client_name: 'Pagination client',
      date_range: range,
      metrics: ['spend'],
      custom_metrics: [],
      targets: {},
      objectives: [],
      partial_delivery: 'allow_marked',
      sources: [{platform: 'meta', account_id: '123', connection_id: meta}],
    },
    sources: [],
    actor_binding: f.store.bindJobActor(actor, id),
    row_count: rows,
    rows: Array.from({length: rows}, (_, i) => ({
      campaign_key: 'meta:123:' + (10 + i),
      platform: 'meta',
      account_id: '123',
      campaign_id: String(10 + i),
      campaign_name: 'Campaign ' + (i + 1),
      currency: 'USD',
      timezone: 'UTC',
      date_from: range.since,
      date_to: range.until,
      metrics: {spend: 10 + i},
      complete: true,
      captured_at: capturedAt,
    })),
  };
  report.job_id = f.store.enqueue(actor.tenantId, 'report_overview', {report_id: id});
  f.store.db.prepare("UPDATE jobs SET state='complete' WHERE id=?").run(report.job_id);
  f.put('overview_report', id, report);
  return id;
}
const capture = rows => ({
  gateway: 'google_ads_native_action',
  account_id: '100',
  connection_id: google,
  source: 'provider_read',
  captured_at: Date.now(),
  source_hash: 'a'.repeat(64),
  semantics: {currency: 'USD', timezone: 'UTC', date_from: '2026-09-01', date_to: '2026-09-02', complete: true},
  mapping: {spend: '/metrics/costMicros', entity_name: '/campaign/name'},
  totals: {spend: '10', clicks: null, conversions: null, impressions: null, conversion_value: null},
  rows: Array.from({length: rows}, (_, i) => ({
    entity_id: String(i + 1),
    entity_name: 'Campaign ' + (i + 1),
    date: '2026-09-01',
    spend: String(i + 1),
  })),
});
const planStep = {
  id: 'campaign',
  kind: 'write',
  gateway: 'meta_native_action',
  connection_id: meta,
  account_id: '123',
  description: 'Create the paused traffic campaign',
  arguments: {
    action: 'meta_campaign_create',
    payload: {name: 'Paged', objective: 'OUTCOME_TRAFFIC', status: 'PAUSED', special_ad_categories: []},
  },
};

test('the offset lists that returned only next_offset now say has_more, and the ones with has_more name next_offset', async t => {
  const f = fixture(t);
  // contracts: has_more without next_offset before.
  const contracts = await f.call('amcp_workspace', {action: 'contracts', gateway: 'meta_native_action', limit: 1});
  assert.equal(assertPage(contracts, 'contracts', 'offset'), true);
  assert.equal(contracts.next_offset, 1);
  const second = await f.call('amcp_workspace', {
    action: 'contracts',
    gateway: 'meta_native_action',
    limit: 1,
    offset: contracts.next_offset,
  });
  assert.notEqual(second.actions[0].action, contracts.actions[0].action, 'the next page starts after the first');
  // report_queries and report_bindings: next_offset without has_more before.
  for (const action of ['report_queries', 'report_bindings'])
    assertPage(await f.call('amcp_workspace', {action, limit: 1}), action, 'offset');
  for (const action of ['monitors', 'incidents'])
    assertPage(await f.call('amcp_workspace', {action, limit: 1}), action, 'offset');
  // A captured report's rows: has_more without next_offset before.
  f.put('decision_report', 'rows-3', capture(3));
  f.put('decision_report', 'rows-1', capture(1));
  const rows = await f.call('amcp_reporting', {action: 'get', id: 'rows-3', limit: 1});
  assert.equal(assertPage(rows, 'amcp_reporting get', 'offset'), true);
  assert.deepEqual([rows.total, rows.next_offset, rows.rows[0].entity_id], [3, 1, '1']);
  const rest = await f.call('amcp_reporting', {action: 'get', id: 'rows-3', limit: 2, offset: rows.next_offset});
  assert.deepEqual(
    rest.rows.map(r => r.entity_id),
    ['2', '3'],
  );
  assert.equal(assertPage(rest, 'amcp_reporting get, last page', 'offset'), false);
  const reports = await f.call('amcp_reporting', {action: 'list', limit: 1});
  assert.equal(assertPage(reports, 'amcp_reporting list', 'cursor'), true);
  // A snapshot's rows, the snapshot list and its presentation profiles; snapshot-b covers the two days after
  // snapshot-a, so the two can be compared.
  snapshot(f, 'snapshot-a', Date.parse('2026-09-03T00:00:00Z'));
  snapshot(f, 'snapshot-b', Date.parse('2026-09-05T00:00:00Z'), 3, {since: '2026-09-03', until: '2026-09-04'});
  const got = await f.call('amcp_reporting_overview', {action: 'get', id: 'snapshot-a', limit: 2});
  assert.equal(assertPage(got, 'amcp_reporting_overview get', 'offset'), true);
  assert.deepEqual([got.total, got.next_offset], [3, 2]);
  const tail = await f.call('amcp_reporting_overview', {action: 'get', id: 'snapshot-a', limit: 2, offset: 2});
  assert.deepEqual(
    tail.rows.map(r => r.campaign_id),
    ['12'],
  );
  assert.equal(assertPage(tail, 'amcp_reporting_overview get, last page', 'offset'), false);
  const listed = await f.call('amcp_reporting_overview', {action: 'list', limit: 1});
  assert.equal(assertPage(listed, 'amcp_reporting_overview list', 'offset'), true);
  const next = await f.call('amcp_reporting_overview', {action: 'list', limit: 1, offset: listed.next_offset});
  assert.notEqual(next.reports[0].id, listed.reports[0].id);
  assertPage(
    await f.call('amcp_reporting_overview', {action: 'presentation_profiles', id: 'snapshot-a', limit: 1}),
    'presentation_profiles',
    'offset',
  );
  assertPage(
    await f.call('amcp_reporting_overview', {action: 'compare_candidates', id: 'snapshot-b', limit: 1}),
    'compare_candidates',
    'offset',
  );
  // compare: has_more without next_offset or total before (wave 4b review). Three matched campaigns, two per page.
  const compare = {action: 'compare', id: 'snapshot-b', baseline_id: 'snapshot-a', limit: 2},
    compared = await f.call('amcp_reporting_overview', compare);
  assert.equal(assertPage(compared, 'amcp_reporting_overview compare', 'offset'), true);
  assert.deepEqual([compared.total, compared.row_count, compared.next_offset, compared.rows.length], [3, 3, 2, 2]);
  const comparedTail = await f.call('amcp_reporting_overview', {...compare, offset: compared.next_offset});
  assert.deepEqual(
    comparedTail.rows.map(r => r.entity_id),
    ['12'],
  );
  assert.equal(assertPage(comparedTail, 'amcp_reporting_overview compare, last page', 'offset'), false);
});

test('the media list pages its receipts and its recovery reviews each by its own offset', async t => {
  const f = fixture(t);
  for (const n of [1, 2, 3])
    f.put('workspace_asset', 'asset-' + n, {
      platform: 'meta',
      account_id: '123',
      connection_id: meta,
      media_id: 'hash-' + n,
      name: 'Paged image ' + n,
      sha256: String(n).repeat(64),
    });
  const first = await f.call('amcp_media', {action: 'list', limit: 2});
  assert.equal(assertPage(first, 'amcp_media list', 'offset'), true);
  assert.deepEqual([first.total, first.next_offset, first.assets.length], [3, 2, 2]);
  const second = await f.call('amcp_media', {action: 'list', limit: 2, offset: first.next_offset});
  assert.equal(second.assets.length, 1);
  assert.ok(!first.assets.some(a => a.media_id === second.assets[0].media_id), 'no receipt is listed twice');
  assert.equal(assertPage(second, 'amcp_media list, last page', 'offset'), false);
  assert.equal(assertPage(first, 'amcp_media recovery reviews', 'offset', 'recovery_'), false);
  assert.equal(first.recovery_next_offset, null);
  assertPage(await f.call('amcp_media', {action: 'library', limit: 1}), 'amcp_media library', 'cursor');
});

test('an asset’s usage and its joined performance rows say has_more beside their continuation', async t => {
  const f = fixture(t),
    seeded = seedCreativePerformance(f.store, actor, creativePerformanceCases[0]);
  const asset = await f.call('amcp_media', {action: 'asset', asset_id: seeded.assetId});
  assertPage(asset, 'amcp_media asset (usage)', 'cursor');
  assert.equal(asset.has_more, asset.usage_has_more, 'the usage page keeps its earlier name too');
  const choices = await f.call('amcp_media', {action: 'asset_performance', asset_id: seeded.assetId, limit: 1});
  assertPage(choices, 'asset_performance choices', 'cursor');
  const joined = await f.call('amcp_media', {
    action: 'asset_performance',
    asset_id: seeded.assetId,
    plan_id: seeded.planId,
    report_id: seeded.reportId,
    limit: 1,
  });
  assert.equal(assertPage(joined, 'asset_performance rows', 'offset'), true);
  assert.deepEqual([joined.total, joined.next_offset], [2, 1]);
  const last = await f.call('amcp_media', {
    action: 'asset_performance',
    asset_id: seeded.assetId,
    plan_id: seeded.planId,
    report_id: seeded.reportId,
    limit: 1,
    offset: joined.next_offset,
  });
  assert.equal(assertPage(last, 'asset_performance rows, last page', 'offset'), false);
});

test('allocation and search-exclusion candidates say has_more and their total beside next_offset', () => {
  const allocation = allocationCandidates({...allocationReport(), id: 'allocation'}, {limit: 1});
  assert.equal(assertPage(allocation, 'allocation_candidates', 'offset'), true);
  assert.deepEqual([allocation.total, allocation.next_offset, allocation.candidates[0].entity_id], [2, 1, '10']);
  const rest = allocationCandidates({...allocationReport(), id: 'allocation'}, {limit: 1, offset: 1});
  assert.equal(assertPage(rest, 'allocation_candidates, last page', 'offset'), false);
  assert.equal(rest.candidates[0].entity_id, '20');
  const day = 86400000,
    closed = new Date(Date.now() - day).toISOString().slice(0, 10),
    term = text => ({
      search_term: text,
      entity_id: 'customers/123/searchTermViews/1~2~' + Buffer.from(text, 'utf8').toString('base64url'),
      clicks: '40',
      conversions: '0',
      spend: '10',
    }),
    report = {
      id: 'search-terms',
      gateway: 'google_ads_native_action',
      preset: 'google_search_terms',
      source: 'provider_read',
      source_collection: 'google_search_pages',
      grain: 'campaign × ad group × search term',
      account_id: '123',
      source_hash: 'c'.repeat(64),
      captured_at: Date.now() - 1000,
      semantics: {
        complete: true,
        conversion_definition: 'metrics.conversions',
        attribution: 'Synthetic declared attribution',
        currency: 'USD',
        timezone: 'UTC',
        date_from: closed,
        date_to: closed,
      },
      rows: [term('free books'), term('cheap jobs')],
    };
  const exclusions = searchExclusionCandidates(report, {limit: 1});
  assert.equal(assertPage(exclusions, 'search_exclusion_candidates', 'offset'), true);
  assert.deepEqual([exclusions.total, exclusions.candidate_count, exclusions.next_offset], [2, 2, 1]);
  assert.equal(
    assertPage(searchExclusionCandidates(report, {limit: 1, offset: 1}), 'search exclusions, last page', 'offset'),
    false,
  );
});

test('the cursor lists keep has_more and next_cursor, and a followed cursor never repeats a row', async t => {
  const f = fixture(t);
  for (const name of ['First paged plan', 'Second paged plan'])
    await f.call('amcp_campaign', {action: 'create', name, brief: 'A paged plan.', steps: [planStep]});
  const plans = await f.call('amcp_campaign', {action: 'list', limit: 1});
  assert.equal(assertPage(plans, 'amcp_campaign list', 'cursor'), true);
  assert.equal(plans.total, 2);
  const after = await f.call('amcp_campaign', {action: 'list', limit: 1, cursor: plans.next_cursor});
  assert.notEqual(after.campaigns[0].id, plans.campaigns[0].id);
  assert.equal(assertPage(after, 'amcp_campaign list, last page', 'cursor'), false);
  for (const action of ['operations', 'history'])
    assertPage(await f.call('amcp_workspace', {action, limit: 1}), action, 'cursor');
  const capabilities = await f.call('amcp_workspace', {action: 'capabilities', limit: 1});
  assert.equal(assertPage(capabilities, 'capabilities', 'cursor'), true);
  const sections = await f.call('amcp_workspace', {action: 'dashboard', sections: ['accounts'], limit: 1});
  assertPage(sections.sections.accounts, 'dashboard accounts section', 'cursor');
});

// Paged actions held to the same fields by their own suites, since their pages need provider reads (portfolio:
// tests/portfolio-adapter-contract.test.mjs; asset_usage: tests/mcp-meta-asset-usage.test.mjs and the Google and
// Snapchat suites). compare was listed here with a suite that never checked its paging fields; it is covered above.
const pagedElsewhere = {
  amcp_workspace: ['portfolio'],
  amcp_media: ['asset_usage'],
};
test('every paged AMCP action is held to the convention here, or named with the suite that pages it', t => {
  const f = fixture(t);
  const covered = {
    amcp_workspace: [
      'contracts',
      'report_queries',
      'report_bindings',
      'monitors',
      'incidents',
      'operations',
      'history',
      'capabilities',
      'dashboard',
    ],
    amcp_campaign: ['list'],
    amcp_reporting: ['get', 'list', 'allocation_candidates', 'search_exclusion_candidates'],
    amcp_reporting_overview: ['get', 'list', 'presentation_profiles', 'compare_candidates', 'compare'],
    amcp_media: ['list', 'library', 'asset', 'asset_performance'],
  };
  const paged = [];
  for (const tool of f.service.firstPartyTools())
    for (const action of toolActions(tool)) {
      const names = Object.keys(firstPartyContract(tool, action).argumentsSchema.properties);
      if (names.includes('limit') && names.some(n => ['cursor', 'offset'].includes(n))) paged.push([tool.name, action]);
    }
  assert.ok(paged.length >= 25, String(paged.length));
  for (const [tool, action] of paged)
    assert.ok(
      covered[tool]?.includes(action) || pagedElsewhere[tool]?.includes(action),
      tool + ' ' + action + ' pages without a check of its paging fields',
    );
  // Every name above is a paged action, so the lists cannot drift from the tools.
  for (const [tool, actions] of Object.entries({...covered}).concat(Object.entries(pagedElsewhere)))
    for (const action of actions)
      assert.ok(
        paged.some(([t, a]) => t === tool && a === action),
        tool + ' ' + action + ' is no paged action',
      );
});
