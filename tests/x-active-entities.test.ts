import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {MirrorError} from '../src/errors.js';
import {xCampaignReport, xGroupSets} from '../src/x-campaign-report.js';
import {xActiveEntities, xRefusedRead} from '../src/x-active-entities.js';
import {NativeCampaignReports} from '../src/report-native.js';
import {assertRefused} from './helpers/assert-refused.js';
import type {Actor, CompiledRequest, JsonObject} from '../src/types.js';

// RPT-03: X analytics are planned from X active entities, not the whole (deleted-inclusive) inventory. All provider
// responses are synthetic.
const day = 86400000,
  start = Date.parse('2026-06-01T00:00:00Z'),
  campaigns = (n: number) =>
    Array.from({length: n}, (_, i) => ({id: 'c' + i, name: 'Campaign ' + i, objective: 'WEBSITE_CLICKS'}));
const iso = (ms: number) => new Date(ms).toISOString();
const activeResponse = (ids: string[], from: number, to: number, placements?: string[]) => ({
  data: ids.map(entity_id => ({
    entity_id,
    activity_start_time: iso(from),
    activity_end_time: iso(to),
    ...(placements ? {placements} : {}),
  })),
});
/** Analytics stub: every requested campaign spends 1 USD and has 2 impressions per hour on ALL_ON_TWITTER. */
const analytics = (calls: JsonObject[]) => async (q: JsonObject) => {
  calls.push(q);
  const hours = (Date.parse(q.end_time) - Date.parse(q.start_time)) / 3600000,
    n = q.placement === 'ALL_ON_TWITTER' ? 1 : 0;
  return {
    data: String(q.entity_ids)
      .split(',')
      .map(id => ({
        id,
        id_data: [
          {
            segment: null,
            metrics: String(q.metric_groups).includes('BILLING')
              ? {impressions: Array(hours).fill(2 * n), billed_charge_local_micro: Array(hours).fill(1000000 * n)}
              : {web: {conversions: Array(hours).fill(n)}},
          },
        ],
      })),
  };
};

test('RPT-03: 1,000 listed campaigns with 15 active use the active-entities read plus ceil(15/20) x weeks x placements', async () => {
  const inventory = campaigns(1000),
    ids = inventory.slice(0, 15).map(c => c.id),
    end = start + 30 * day,
    reads: JsonObject[] = [],
    calls: JsonObject[] = [];
  const active = await xActiveEntities(start, end, async q => {
    reads.push(q);
    return activeResponse(ids, start, end);
  });
  assert.equal(reads.length, 1);
  assert.equal(reads[0]!.entity, 'CAMPAIGN');
  const report = await xCampaignReport(inventory, start, end, [], analytics(calls), {active});
  const weeks = Math.ceil(30 / 7);
  assert.equal(calls.length, Math.ceil(15 / 20) * weeks * 3);
  assert.equal(report.requests, calls.length);
  assert.equal(report.rows.length, 15);
  assert.equal(report.no_activity_count, 985);
  // The inventory path refuses the same account (1,000 campaigns need 750 requests).
  await assert.rejects(
    () => xCampaignReport(inventory, start, end, [], analytics([])),
    (e: MirrorError) => e.code === 'REPORT_RANGE_LIMIT',
  );
});

test('RPT-03: 500 campaigns with 10 active over 90 days need at most 39 requests and keep the active totals', async () => {
  const inventory = campaigns(500),
    activeIds = inventory.slice(100, 110).map(c => c.id),
    end = start + 90 * day,
    reads: JsonObject[] = [],
    calls: JsonObject[] = [],
    legacyCalls: JsonObject[] = [];
  const active = await xActiveEntities(start, end, async q => {
    reads.push(q);
    return activeResponse(activeIds, start, end, ['ALL_ON_TWITTER']);
  });
  const report = await xCampaignReport(inventory, start, end, [], analytics(calls), {active});
  assert.ok(reads.length + calls.length <= 39, 'requests: ' + (reads.length + calls.length));
  // The inventory path over only the active campaigns is the reference for identical totals.
  const legacy = await xCampaignReport(
    inventory.filter(c => activeIds.includes(c.id)),
    start,
    end,
    [],
    analytics(legacyCalls),
  );
  assert.equal(legacyCalls.length, 39);
  const totals = (r: {rows: JsonObject[]}) =>
    Object.fromEntries(r.rows.map(row => [row.id, row.metrics]).sort(([a], [b]) => (a < b ? -1 : 1)));
  assert.deepEqual(totals(report), totals(legacy));
  assert.equal(report.rows[0]!.metrics.spend, 90 * 24);
});

test('RPT-03: campaigns without reported activity never appear as zero rows', async () => {
  const inventory = campaigns(5),
    end = start + 7 * day,
    active = await xActiveEntities(start, end, async () => activeResponse(['c1'], start, end));
  const report = await xCampaignReport(inventory, start, end, [], analytics([]), {active});
  assert.deepEqual(
    report.rows.map(r => r.id),
    ['c1'],
  );
  assert.equal(report.no_activity_count, 4);
  assert.match(report.warnings.join(' '), /4 X campaigns have no reported activity.*never counted as zero/);
  // An empty active set sends no analytics request and returns no rows rather than failing.
  const none = await xActiveEntities(start, end, async () => ({data: []}));
  const calls: JsonObject[] = [];
  const empty = await xCampaignReport(inventory, start, end, [], analytics(calls), {active: none});
  assert.equal(calls.length, 0);
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.complete, true);
});

test('RPT-03: activity windows limit requests to the weeks in which a campaign was active', async () => {
  const end = start + 21 * day,
    active = await xActiveEntities(start, end, async () =>
      activeResponse(['c1'], start + 8 * day, start + 9 * day + 1800000, ['ALL_ON_TWITTER']),
    ),
    calls: JsonObject[] = [];
  assert.equal(active.entities[0]!.start, start + 8 * day);
  assert.equal(active.entities[0]!.end, start + 9 * day + 3600000, 'the window widens to whole hours');
  await xCampaignReport(campaigns(1), start, end, [], analytics(calls), {active});
  assert.deepEqual(
    calls.map(c => c.start_time),
    [iso(start + 7 * day).replace('.000Z', 'Z')],
  );
  // The widening flag keeps the active IDs but requests every week.
  const widened: JsonObject[] = [];
  await xCampaignReport(campaigns(1), start, end, [], analytics(widened), {active, windows: false});
  assert.equal(widened.length, 3);
});

test('RPT-03: resuming an X checkpoint with a different active set or an older definition is refused', async () => {
  const end = start + 14 * day,
    inventory = campaigns(3),
    first = await xActiveEntities(start, end, async () => activeResponse(['c0', 'c1'], start, end)),
    second = await xActiveEntities(start, end, async () => activeResponse(['c0'], start, end));
  let saved: JsonObject | undefined;
  let count = 0;
  await assert.rejects(
    () =>
      xCampaignReport(
        inventory,
        start,
        end,
        [],
        async q => {
          if (++count === 2) throw new MirrorError('STALE_JOB_LEASE', 'interrupted', {}, 409);
          return analytics([])(q);
        },
        {active: first, save: v => (saved = v)},
      ),
    (e: MirrorError) => e.code === 'STALE_JOB_LEASE',
  );
  assert.ok(saved?.definition);
  await assert.rejects(
    () => xCampaignReport(inventory, start, end, [], analytics([]), {active: second, checkpoint: saved}),
    (e: MirrorError) => e.code === 'REPORT_DEFINITION_CHANGED',
  );
  await assert.rejects(
    () =>
      xCampaignReport(inventory, start, end, [], analytics([]), {
        active: first,
        checkpoint: {...saved, definition: 'version-2-definition'},
      }),
    (e: MirrorError) => e.code === 'REPORT_DEFINITION_CHANGED',
  );
  // The same definition resumes after the saved step.
  const calls: JsonObject[] = [];
  const resumed = await xCampaignReport(inventory, start, end, [], analytics(calls), {
    active: first,
    checkpoint: saved,
  });
  assert.equal(calls.length, 6 - 1);
  assert.equal(resumed.rows.length, 2);
});

test('RPT-03: web conversions are requested apart, so a rejected conversion request keeps spend and marks coverage partial', async () => {
  assert.deepEqual(xGroupSets(['VIDEO', 'WEB_CONVERSION', 'MOBILE_CONVERSION']), [
    ['ENGAGEMENT', 'BILLING', 'VIDEO'],
    ['WEB_CONVERSION'],
    ['MOBILE_CONVERSION'],
  ]);
  const end = start + day,
    calls: JsonObject[] = [];
  const report = await xCampaignReport(campaigns(1), start, end, ['WEB_CONVERSION'], async q => {
    if (q.metric_groups === 'WEB_CONVERSION')
      throw new MirrorError('PROVIDER_ERROR', 'Conversion metrics are unavailable.', {}, 400);
    return analytics(calls)(q);
  });
  assert.equal(report.complete, false);
  assert.equal(report.rows[0]!.metrics.spend, 24);
  assert.match(report.warnings.join(' '), /X rejected ALL_ON_TWITTER \/ WEB_CONVERSION/);
  assert.ok(calls.every(c => !String(c.metric_groups).includes('WEB_CONVERSION')));
});

// jobcontrol: the job's own stop is not X's rejection of a request. A report that is cancelled, or whose schedule is edited,
// paused or removed, is JOB_CANCELLED with MirrorError's default status 400 (src/reporting-overview.ts currentReport), which
// the job's bound actor check raises inside any read; a worker that lost its lease is STALE_JOB_LEASE, 409. The status test of
// xRefusedRead took the first for X's HTTP 400: the step was recorded as "X rejected ..." and the report went on to the next.
const jobStops = () => [
  new MirrorError('JOB_CANCELLED', 'Report cancelled.'),
  new MirrorError('JOB_CANCELLED', 'The report schedule was edited, paused or removed.'),
  new MirrorError('STALE_JOB_LEASE', 'This worker no longer owns the report/export job.', {}, 409),
];
const xRefusal = (status: number) =>
  new MirrorError('UPSTREAM_ERROR', 'X refused the request.', {http_status: status}, status);
test('jobcontrol: a job-control error is never X’s refusal of a read, whatever its status; X’s own refusals (HTTP 400, 404 and 422) still are', () => {
  for (const [code, status] of [
    ['JOB_CANCELLED', 400],
    ['JOB_CANCELLED', 404],
    ['JOB_CANCELLED', 422],
    ['STALE_JOB_LEASE', 409],
    ['STALE_JOB_LEASE', 400],
    ['STALE_JOB_LEASE', 404],
    ['STALE_JOB_LEASE', 422],
  ] as const)
    assert.equal(xRefusedRead(new MirrorError(code, 'Synthetic', {}, status)), false, code + ' at ' + status);
  for (const status of [400, 404, 422]) assert.equal(xRefusedRead(xRefusal(status)), true, 'X at ' + status);
});

test('jobcontrol: a cancelled report or a lost lease during an analytics request ends the report, never as X’s rejection of the request', async () => {
  const end = start + day;
  for (const stop of jobStops()) {
    const calls: JsonObject[] = [];
    await assert.rejects(
      () =>
        xCampaignReport(campaigns(1), start, end, ['WEB_CONVERSION'], async q => {
          if (q.metric_groups === 'WEB_CONVERSION') throw stop;
          return analytics(calls)(q);
        }),
      (e: MirrorError) => assertRefused(e, stop.code),
      stop.code + ': ' + stop.message,
    );
  }
  // X's own rejections of a request still keep the spend and mark the coverage partial.
  for (const status of [400, 404, 422]) {
    const report = await xCampaignReport(campaigns(1), start, end, ['WEB_CONVERSION'], async q => {
      if (q.metric_groups === 'WEB_CONVERSION') throw xRefusal(status);
      return analytics([])(q);
    });
    assert.equal(report.complete, false, 'HTTP ' + status);
    assert.equal(report.rows[0]!.metrics.spend, 24, 'HTTP ' + status);
    assert.match(report.warnings.join(' '), /X rejected ALL_ON_TWITTER \/ WEB_CONVERSION/, 'HTTP ' + status);
  }
});

test('RPT-03: malformed or partial active-entities responses fail closed', async () => {
  const end = start + day;
  for (const response of [
    {},
    {data: [{entity_id: 'bad id', activity_start_time: iso(start), activity_end_time: iso(end)}]},
    {data: [{entity_id: 'c1', activity_start_time: 'yesterday', activity_end_time: iso(end)}]},
    {data: [{entity_id: 'c1', activity_start_time: iso(end), activity_end_time: iso(start)}]},
    {data: [{entity_id: 'c1', activity_start_time: iso(start), activity_end_time: iso(end), placements: 'ALL'}]},
    {data: [], next_cursor: 'more'},
  ])
    await assert.rejects(
      () => xActiveEntities(start, end, async () => response as JsonObject),
      (e: MirrorError) => e.code === 'REPORT_SHAPE_CHANGED',
      JSON.stringify(response),
    );
  // Windows longer than 90 days are read in documented chunks.
  const reads: JsonObject[] = [];
  await xActiveEntities(start, start + 200 * day, async q => {
    reads.push(q);
    return {data: []};
  });
  assert.equal(reads.length, 3);
});

const actor: Actor = {tenantId: 'x-active', userId: 'owner', role: 'admin'};
function xService(active: (q: JsonObject) => JsonObject) {
  const store = new Store(':memory:', Buffer.alloc(32, 77).toString('base64'));
  store.putConnection(
    actor,
    {
      id: 'x-conn',
      tenantId: actor.tenantId,
      gateway: 'x_ads_native_action',
      accounts: ['abc'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const requests: CompiledRequest[] = [];
  const service = {
    store,
    runPlan: async (p: CompiledRequest) => {
      requests.push(p);
      if (p.path.endsWith('/campaigns')) return {success: true, data: {data: campaigns(300)}};
      // RPT-07: the Overview also reads line items for campaign objectives (none here, so objectives stay unknown).
      if (p.path.endsWith('/line_items')) return {success: true, data: {data: []}};
      if (p.path.endsWith('/active_entities')) return {success: true, data: active(p.query as JsonObject)};
      if (p.path.startsWith('/12/stats/accounts/'))
        return {success: true, data: await analytics([])(p.query as JsonObject)};
      return {success: true, data: {data: {id: 'abc', currency: 'USD', timezone: 'UTC', name: 'X'}}};
    },
  };
  return {store, requests, native: new NativeCampaignReports(service as never)};
}

test('RPT-03: the X Overview source reads active entities, records them in lineage and reports only active campaigns', async () => {
  const f = xService(q => activeResponse(['c7', 'c9'], Date.parse(q.start_time), Date.parse(q.end_time)));
  try {
    const result = await f.native.collect(
      {platform: 'x', account_id: 'abc', connection_id: 'x-conn'},
      {since: '2026-06-01', until: '2026-06-30'},
      actor,
    );
    assert.deepEqual(result.rows.map((r: JsonObject) => r.campaign_id).sort(), ['c7', 'c9']);
    assert.equal(result.rows[0].campaign_name, 'Campaign ' + result.rows[0].campaign_id.slice(1));
    assert.equal(result.no_activity_count, 298);
    assert.ok(result.lineage.some((l: JsonObject) => l.stage === 'active_entities'));
    assert.equal(
      f.requests.filter(p => p.path.startsWith('/12/stats/accounts/abc') && !p.path.endsWith('_entities')).length,
      15,
    );
  } finally {
    f.store.close();
  }
});

test('RPT-03: a rejected active-entities read keeps the bounded inventory path with a warning', async () => {
  const f = xService(() => {
    throw new MirrorError('PROVIDER_ERROR', 'Unsupported parameter.', {}, 400);
  });
  try {
    await assert.rejects(
      () =>
        f.native.collect(
          {platform: 'x', account_id: 'abc', connection_id: 'x-conn'},
          {since: '2026-06-01', until: '2026-06-30'},
          actor,
        ),
      (e: MirrorError) => e.code === 'REPORT_RANGE_LIMIT',
      'the inventory path still refuses more than 100 requests',
    );
  } finally {
    f.store.close();
  }
  const small = xService(() => {
    throw new MirrorError('PROVIDER_ERROR', 'Unsupported parameter.', {}, 400);
  });
  try {
    const result = await small.native.collect(
      {platform: 'x', account_id: 'abc', connection_id: 'x-conn'},
      {since: '2026-06-01', until: '2026-06-01'},
      actor,
    );
    assert.equal(result.rows.length, 300);
    assert.match(result.warnings.join(' '), /refused the active-entities read/);
  } finally {
    small.store.close();
  }
});

// jobcontrol: the same read at the campaign level of the Overview source. The job's own stop ends the source and sends no
// analytics instead; X's own refusals (HTTP 400, 404 and 422) keep the bounded inventory path with the warning, as before.
test('jobcontrol: a cancelled report or a lost lease during the active-entities read ends the source, never as X’s refusal of it', async () => {
  const day1 = {since: '2026-06-01', until: '2026-06-01'},
    source = {platform: 'x', account_id: 'abc', connection_id: 'x-conn'};
  for (const stop of jobStops()) {
    const f = xService(() => {
      throw stop;
    });
    try {
      await assert.rejects(
        () => f.native.collect(source, day1, actor),
        (e: MirrorError) => assertRefused(e, stop.code),
        stop.code + ': ' + stop.message,
      );
      assert.equal(
        f.requests.some(p => p.path.startsWith('/12/stats/accounts/abc') && !p.path.endsWith('_entities')),
        false,
        'no analytics were requested instead',
      );
    } finally {
      f.store.close();
    }
  }
  for (const status of [400, 404, 422]) {
    const f = xService(() => {
      throw xRefusal(status);
    });
    try {
      const result = await f.native.collect(source, day1, actor);
      assert.equal(result.rows.length, 300, 'HTTP ' + status);
      assert.match(result.warnings.join(' '), /refused the active-entities read/, 'HTTP ' + status);
    } finally {
      f.store.close();
    }
  }
});
