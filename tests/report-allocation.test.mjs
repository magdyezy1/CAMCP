import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {DecisionReporting} from '../dist/src/decision-reporting.js';
import {reportAllocation, allocationCandidates} from '../dist/src/report-allocation.js';

const now = Date.UTC(2026, 9, 1, 12);
const report = () => ({
  gateway: 'meta_native_action',
  account_id: '100',
  connection_id: 'meta',
  source: 'provider_read',
  preset: 'meta_campaign',
  grain: 'campaign × day',
  source_hash: 'original-evidence',
  captured_at: now,
  semantics: {
    currency: 'USD',
    timezone: 'UTC',
    date_from: '2026-09-29',
    date_to: '2026-09-30',
    attribution: '7-day click; impression time',
    conversion_definition: 'Pixel purchase',
    complete: true,
  },
  rows: [
    {entity_id: '10', entity_name: 'Efficient', date: '2026-09-29', spend: '40', conversions: '8'},
    {entity_id: '10', entity_name: 'Efficient', date: '2026-09-30', spend: '60', conversions: '12'},
    {entity_id: '20', entity_name: 'Established', date: '2026-09-29', spend: '50', conversions: '5'},
    {entity_id: '20', entity_name: 'Established', date: '2026-09-30', spend: '50', conversions: '5'},
  ],
});
const options = () => ({
  budget: '200',
  efficiency_low: 0.8,
  efficiency_high: 1.2,
  maximum_age_days: 7,
  minimum_conversions: 5,
  allocations: [
    {entity_id: '10', minimum: '25', maximum: '125'},
    {entity_id: '20', minimum: '50', maximum: '175'},
  ],
});
function fixture(value = report()) {
  const store = new Store(':memory:', Buffer.alloc(32, 83).toString('base64'));
  const actor = {tenantId: 'allocation', userId: 'reader', role: 'reader'};
  const connection = {
    id: 'meta',
    tenantId: actor.tenantId,
    gateway: 'meta_native_action',
    accounts: ['100'],
    enabled: true,
    label: 'Synthetic',
    scopes: [],
  };
  store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'synthetic'});
  store.putDocument(actor.tenantId, 'decision_report', 'snapshot', value);
  const service = new DecisionReporting(store, async () => {
    throw Error('No provider calls');
  });
  return {
    store,
    actor,
    connection,
    call: (input = options()) => service.handle({action: 'allocation', id: 'snapshot', options: input}, actor),
  };
}
test('bounded allocation preserves exact total and evidence while honoring floors and caps', async t => {
  t.mock.method(Date, 'now', () => now);
  const f = fixture();
  try {
    const r = await f.call();
    assert.deepEqual(
      r.allocations.map(a => [a.entity_id, a.proposed_budget]),
      [
        ['10', '125'],
        ['20', '75'],
      ],
    );
    assert.equal(r.total_budget, '200');
    assert.equal(r.modeled_conversions_low, 26);
    assert.equal(r.modeled_conversions_high, 39);
    assert.equal(r.period.days, 2);
    assert.equal(r.period.unit, 'total over a comparable period, not a native daily budget');
    assert.equal(r.source_hash, 'original-evidence');
    assert.equal(r.network_requests, 0);
    assert.equal(r.advertising_writes, 0);
    assert.match(r.limitations.join(' '), /not a forecast/);
    assert.equal(f.store.documents(f.actor.tenantId, 'campaign_plan').length, 0);
  } finally {
    f.store.close();
  }
});
test('allocation uses exact six-decimal budgets and stable ID ordering for equal efficiencies', async t => {
  t.mock.method(Date, 'now', () => now);
  const data = report();
  data.rows = data.rows.map(r => ({...r, conversions: String(Number(r.spend) / 10)}));
  const f = fixture(data);
  try {
    const r = await f.call({
      ...options(),
      budget: '0.000003',
      allocations: [
        {entity_id: '20', minimum: '0.000001', maximum: '0.000003'},
        {entity_id: '10', minimum: '0.000001', maximum: '0.000003'},
      ],
    });
    assert.deepEqual(
      r.allocations.map(a => [a.entity_id, a.proposed_budget]),
      [
        ['20', '0.000001'],
        ['10', '0.000002'],
      ],
    );
  } finally {
    f.store.close();
  }
});
test('infeasible and ambiguous allocations are refused before any result is suggested', async t => {
  t.mock.method(Date, 'now', () => now);
  const f = fixture();
  try {
    for (const patch of [
      {budget: '74.999999'},
      {budget: '300.000001'},
      {budget: '1e2'},
      {budget: '0.0000001'},
      {allocations: [options().allocations[0], options().allocations[0]]},
      {allocations: [{entity_id: '10', minimum: '126', maximum: '125'}, options().allocations[1]]},
      {allocations: [{entity_id: 'other', minimum: '0', maximum: '125'}, options().allocations[1]]},
      {minimum_conversions: 0},
      {maximum_age_days: 91},
      {efficiency_low: 0},
      {efficiency_high: 0.2},
    ])
      await assert.rejects(f.call({...options(), ...patch}));
  } finally {
    f.store.close();
  }
});
test('insufficient, stale, incomplete, unknown and mixed-grain evidence never becomes an allocation', async t => {
  t.mock.method(Date, 'now', () => now);
  const patches = [
    r => {
      r.preset = 'meta_ad';
    },
    r => {
      r.source = 'manual';
    },
    r => {
      r.grain = 'ad × day';
    },
    r => {
      r.semantics.complete = false;
    },
    r => {
      r.semantics.attribution = 'unknown';
    },
    r => {
      r.captured_at = now - 8 * 86400000;
    },
    r => {
      r.captured_at = now + 86400000;
    },
    r => {
      r.semantics.date_to = '2026-09-20';
    },
    r => {
      r.semantics.date_to = '2026-10-01';
    },
    r => {
      r.rows[0].conversions = null;
    },
    r => {
      r.rows[0].spend = null;
    },
    r => {
      r.rows[0].date = '2026-09-28';
    },
    r => {
      r.rows.push({...r.rows[0]});
    },
    r => {
      r.rows = r.rows.map(x => ({...x, conversions: '0'}));
    },
  ];
  for (const patch of patches) {
    const value = report();
    patch(value);
    const f = fixture(value);
    try {
      await assert.rejects(f.call());
    } finally {
      f.store.close();
    }
  }
});
test('allocation rechecks the retained report account and current login grants', async t => {
  t.mock.method(Date, 'now', () => now);
  const f = fixture();
  try {
    await f.call();
    f.store.putConnection({...f.actor, role: 'admin'}, {...f.connection, enabled: false}, {accessToken: 'synthetic'});
    await assert.rejects(f.call());
  } finally {
    f.store.close();
  }
});

test('the constrained solution matches exhaustive feasible allocations across varied small cases', t => {
  t.mock.method(Date, 'now', () => now);
  for (let seed = 1; seed <= 60; seed++) {
    const data = report();
    data.rows = [1, 2, 3].map(i => ({
      entity_id: String(i),
      entity_name: 'Campaign ' + i,
      date: '2026-09-30',
      spend: String(1 + ((seed + i) % 7)),
      conversions: String(1 + ((seed * i) % 11)),
    }));
    const limits = [1, 2, 3].map(i => ({
      entity_id: String(i),
      minimum: String((seed + i) % 2),
      maximum: String(3 + ((seed + i) % 3)),
    }));
    const floor = limits.reduce((n, r) => n + Number(r.minimum), 0),
      cap = limits.reduce((n, r) => n + Number(r.maximum), 0);
    const budget = Math.max(1, floor + (seed % (cap - floor + 1)));
    const result = reportAllocation(data, {
      ...options(),
      minimum_conversions: 1,
      allocations: limits,
      budget: String(budget),
      efficiency_low: 1,
      efficiency_high: 1,
    });
    let best = -Infinity;
    for (let a = Number(limits[0].minimum); a <= Number(limits[0].maximum); a++)
      for (let b = Number(limits[1].minimum); b <= Number(limits[1].maximum); b++) {
        const c = budget - a - b;
        if (c < Number(limits[2].minimum) || c > Number(limits[2].maximum)) continue;
        best = Math.max(
          best,
          [a, b, c].reduce((n, v, i) => n + (v * Number(data.rows[i].conversions)) / Number(data.rows[i].spend), 0),
        );
      }
    assert.ok(Math.abs(result.modeled_conversions_low - best) < 1e-9, 'seed ' + seed);
    assert.equal(
      result.allocations.reduce((n, r) => n + Number(r.proposed_budget), 0),
      budget,
    );
    for (const row of result.allocations)
      assert.ok(
        Number(row.proposed_budget) >= Number(row.minimum) && Number(row.proposed_budget) <= Number(row.maximum),
      );
  }
});
test('candidate pagination contains only bounded campaign totals and preserves unknown metrics', () => {
  const data = report();
  data.rows = Array.from({length: 25}, (_, i) => ({
    entity_id: String(i + 1),
    entity_name: 'Campaign ' + i,
    date: '2026-09-30',
    spend: '10',
    conversions: i === 0 ? null : '2',
    private_source: 'withheld',
  }));
  let offset = 0;
  const ids = [];
  do {
    const page = allocationCandidates(data, {offset, limit: 7});
    assert.ok(page.candidates.length <= 7);
    ids.push(...page.candidates.map(r => r.entity_id));
    assert.doesNotMatch(JSON.stringify(page), /private_source|withheld/);
    offset = page.next_offset;
  } while (offset !== null);
  assert.equal(ids.length, 25);
  assert.equal(new Set(ids).size, 25);
  assert.equal(allocationCandidates(data, {limit: 1}).candidates[0].observed_conversions, null);
  assert.throws(() => allocationCandidates(data, {limit: 101}));
});
test('a fresh capture cannot hide old reporting dates and the age boundary uses native timezone', t => {
  t.mock.method(Date, 'now', () => Date.UTC(2026, 9, 1, 1));
  const data = report();
  data.captured_at = Date.now();
  data.semantics.timezone = 'America/Los_Angeles';
  assert.throws(() => reportAllocation(data, options()), /closed reporting period/);
  data.semantics.timezone = undefined;
  assert.throws(() => reportAllocation(data, options()), /known currency/);
});
