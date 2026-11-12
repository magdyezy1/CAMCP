// Package meta-results (the lead's ruling 7): the DEC-02 allocation outcome review repeats the proposal evidence's guided capture
// after the outcome window closes and compares realized conversions with the proposal's modeled ones. Since ruling 5 a Meta guided
// capture counts the attribution windows it asked for (each requested window's key, not the ad set's own `value`) and a retained
// capture says so (`action_count_basis`, src/decision-reporting.ts). Evidence read before that has no such field and its counts are
// the ad set's own `value`, so the review freezes the evidence's basis with its other settings and never compares an outcome read
// on another one: `unavailable`, `measurement_definition_changed`, the field named in `changed_fields` (src/allocation-outcome.ts).
// Evidence without the field on both sides (Google's, whose outcome tests are tests/allocation-outcome.test.mjs) is compared as before.
// Synthetic Meta answers behind the real service and transport; nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {setMetaCurrencyOffsetsForTest} from '../dist/src/budget-units.js';
import {allocationOutcomeKind} from '../dist/src/allocation-outcome.js';
import {assertRefused} from './helpers/assert-refused.mjs';

const day = 86400000;
const connectionId = '14200000-0000-4000-8000-000000000001';
const purchase = 'offsite_conversion.fb_pixel_purchase';
const windows = ['7d_click', '1d_view'];
const dateText = ms => new Date(ms).toISOString().slice(0, 10);
const good = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};
/** Runs fn with the clock moved by offset milliseconds (the clock keeps moving). */
async function later(offset, fn) {
  const real = Date.now;
  Date.now = () => real() + offset;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}
/** Milliseconds after which the outcome window of `doc` has closed (plus an hour). */
const afterWindow = doc => doc.due_at - Date.now() + 3600000;

/**
 * Per campaign and day: [spend, 7d_click count, 1d_view count]. Each answer's own `value` is 99, the ad set's attribution setting,
 * which no read of the requested windows may use. Evidence: 20 and 10 conversions over 100 spend each (a proposal of 125 and 75).
 * Outcome: 21 and 9.
 */
const evidenceDays = {
  10: [
    ['40', '5', '3'],
    ['60', '7', '5'],
  ],
  20: [
    ['50', '4', '1'],
    ['50', '4', '1'],
  ],
};
const outcomeDays = {
  10: [
    ['60', '6', '2'],
    ['62', '9', '4'],
  ],
  20: [
    ['35', '4', '1'],
    ['35', '3', '1'],
  ],
};
const names = {10: 'Efficient', 20: 'Established'};

function fixture(t) {
  setMetaCurrencyOffsetsForTest({USD: 100, JPY: 1});
  t.after(() => setMetaCurrencyOffsetsForTest(undefined));
  const store = new Store(':memory:', Buffer.alloc(32, 142).toString('base64')),
    owner = {tenantId: 'meta-outcome', userId: 'owner', role: 'admin'},
    key = store.createKey(owner),
    actor = store.authenticate(key);
  t.after(() => store.close());
  store.putConnection(
    owner,
    {
      id: connectionId,
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['100'],
      writeAccounts: ['100'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['ads_read', 'ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  // Two closed days before today are the proposal's evidence period.
  const today = Date.parse(dateText(Date.now())),
    first = dateText(today - 2 * day),
    last = dateText(today - day);
  // Campaign 10 owns a 100 USD daily budget (10000 cents); campaign 20 keeps 50 USD on its one ad set 201.
  const account = {id: 'act_100', account_id: '100', currency: 'USD', timezone_name: 'UTC', account_status: 1};
  const campaigns = {
    10: {
      id: '10',
      account_id: '100',
      name: 'Efficient',
      status: 'ACTIVE',
      buying_type: 'AUCTION',
      daily_budget: '10000',
    },
    20: {
      id: '20',
      account_id: '100',
      name: 'Established',
      status: 'PAUSED',
      buying_type: 'AUCTION',
      is_adset_budget_sharing_enabled: false,
    },
  };
  const adsets = {
    10: [{id: '101', account_id: '100', campaign_id: '10', status: 'ACTIVE'}],
    20: [{id: '201', account_id: '100', campaign_id: '20', status: 'PAUSED', daily_budget: '5000'}],
  };
  let allowWrite = false;
  const requests = [],
    insights = [];
  const row = (campaign, date, [spend, click, view]) => ({
    account_id: '100',
    account_currency: 'USD',
    campaign_id: campaign,
    campaign_name: names[campaign],
    date_start: date,
    date_stop: date,
    spend,
    impressions: '1000',
    clicks: '50',
    reach: '800',
    frequency: '1.25',
    // Under the explicit windows the guided capture asks for, Meta returns each window's count under its name beside `value`.
    actions: [{action_type: purchase, value: '99', '7d_click': click, '1d_view': view}],
    action_values: [],
  });
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (raw, init) => {
      const url = new URL(raw),
        path = url.pathname.replace(/^\/v\d+\.0\//, '/');
      requests.push({path, method: init.method});
      if (init.method !== 'GET') {
        assert.equal(allowWrite, true, 'no write before explicit execution');
        const body = Object.fromEntries(new URLSearchParams(String(init.body ?? ''))),
          id = path.slice(1),
          target =
            campaigns[id] ??
            Object.values(adsets)
              .flat()
              .find(a => a.id === id);
        assert.ok(target, 'write to a known entity');
        Object.assign(target, body);
        return Response.json({success: true});
      }
      if (path === '/act_100') return Response.json(account);
      if (path === '/act_100/insights') {
        const range = JSON.parse(url.searchParams.get('time_range')),
          table = range.since === first ? evidenceDays : outcomeDays,
          dates = [];
        for (let at = Date.parse(range.since); at <= Date.parse(range.until); at += day) dates.push(dateText(at));
        insights.push({...range, windows: JSON.parse(url.searchParams.get('action_attribution_windows'))});
        return Response.json({
          data: Object.keys(table).flatMap(id => dates.map((date, i) => row(id, date, table[id][i]))),
        });
      }
      // The account's own collections establish ownership of the objects later read and changed by ID.
      if (path === '/act_100/campaigns')
        return Response.json({data: Object.values(campaigns).map(c => ({id: c.id, account_id: c.account_id}))});
      if (path === '/act_100/adsets')
        return Response.json({
          data: Object.values(adsets)
            .flat()
            .map(a => ({id: a.id, account_id: a.account_id, campaign_id: a.campaign_id})),
        });
      const campaign = /^\/(\d+)$/.exec(path)?.[1];
      if (campaign && campaigns[campaign]) return Response.json(campaigns[campaign]);
      const listing = /^\/(\d+)\/adsets$/.exec(path)?.[1];
      if (listing) return Response.json({data: adsets[listing] ?? []});
      const adset = Object.values(adsets)
        .flat()
        .find(a => path === '/' + a.id);
      if (adset) return Response.json(adset);
      throw Error('Unexpected synthetic request ' + init.method + ' ' + path);
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const reporting = args => service.call('amcp_reporting', args, actor),
    campaign = args => service.call('amcp_campaign', args, actor),
    options = {
      budget: '200',
      allocations: [
        {entity_id: '10', minimum: '50', maximum: '125'},
        {entity_id: '20', minimum: '50', maximum: '150'},
      ],
      efficiency_low: 0.8,
      efficiency_high: 1.2,
      minimum_conversions: 10,
      maximum_age_days: 7,
    };
  /**
   * The proposal's evidence is a real guided capture of the two days (so it carries what the code retains, the stamp included);
   * `unstamped` makes it the evidence of a build that did not count the windows: the same capture without the stamp.
   */
  const evidence = async ({unstamped = false} = {}) => {
    const captured = good(
      await reporting({
        action: 'capture_preset',
        preset: 'meta_campaign',
        account_id: '100',
        connection_id: connectionId,
        result_action_type: purchase,
        attribution_windows: windows,
        semantics: {
          currency: 'USD',
          timezone: 'UTC',
          date_from: first,
          date_to: last,
          source_name: 'Synthetic Meta evidence',
          complete: true,
        },
      }),
    );
    const retained = store.document(actor.tenantId, 'decision_report', captured.id);
    assert.equal(retained.action_count_basis, 'requested_attribution', 'a capture today carries the stamp');
    if (unstamped) {
      const {id: _id, revision: _revision, action_count_basis: _basis, ...older} = retained;
      store.putDocument(actor.tenantId, 'decision_report', captured.id, older);
    }
    return captured.id;
  };
  // Previews, drafts, approves step by step and verifies both budget steps: a verified allocation execution.
  const executed = async evidenceId => {
    const p = good(
      await reporting({action: 'preview_allocation_plan', id: evidenceId, conversion: 'equal_daily', options}),
    );
    const created = good(
      await reporting({
        action: 'create_allocation_plan',
        id: evidenceId,
        preview_id: p.preview_id,
        preview_hash: p.preview_hash,
        confirmed: true,
      }),
    );
    allowWrite = true;
    for (let i = 0; i < 2; i++) {
      const prepared = good(await campaign({action: 'prepare_next', id: created.id}));
      const result = good(
        await campaign({
          action: 'execute_next',
          id: created.id,
          review_id: prepared.review.review_id,
          idempotency_key: prepared.review.review_id,
          confirmed: true,
          spend_change_confirmed: true,
        }),
      );
      assert.equal(result.current.status, 'verified', JSON.stringify(result));
    }
    allowWrite = false;
    return created.id;
  };
  return {
    store,
    actor,
    requests,
    insights,
    first,
    last,
    evidence,
    executed,
    outcomeDoc: id => store.document(actor.tenantId, allocationOutcomeKind, id),
    view: id => reporting({action: 'allocation_outcome', id}),
    capture: id => reporting({action: 'capture_allocation_outcome', id}),
  };
}

test('Meta evidence read under the requested windows is compared with an outcome read the same way, and the review says which basis it froze', async t => {
  const f = fixture(t),
    id = await f.executed(await f.evidence()),
    doc = f.outcomeDoc(id);
  assert.equal(doc.state, 'scheduled');
  assert.equal(doc.preset, 'meta_campaign');
  // The settings the review freezes include how the evidence counted its actions, beside the ones it always had.
  assert.deepEqual(Object.keys(doc.capture).sort(), [
    'account_id',
    'action_count_basis',
    'attribution_windows',
    'connection_id',
    'gateway',
    'preset',
    'result_action_type',
    'semantics',
  ]);
  assert.equal(doc.capture.action_count_basis, 'requested_attribution');
  assert.deepEqual(doc.capture.attribution_windows, windows);
  assert.deepEqual(
    doc.modeled.entities.map(e => [e.entity_id, e.proposed_budget, e.observed_spend, e.observed_conversions]),
    [
      ['10', '125', '100', '20'],
      ['20', '75', '100', '10'],
    ],
    'the proposal was modeled from the windows’ keys (8 + 12 and 5 + 5), not from the ad set’s own 99',
  );
  // (The basis is compared, never sent: capture_preset refuses an argument it does not know, so this capture only runs if the
  // review keeps the basis out of its request.)
  const before = f.insights.length,
    out = good(await later(afterWindow(doc), () => f.capture(id)));
  assert.equal(out.state, 'complete', JSON.stringify(out));
  assert.equal(out.changed_fields, undefined);
  // The outcome capture asked Meta for exactly the same windows, over exactly the outcome window.
  assert.deepEqual(f.insights.slice(before), [{since: doc.window.since, until: doc.window.until, windows}]);
  // Realized conversions are the windows' keys (6 + 2 and 9 + 4, 4 + 1 and 3 + 1), never the ad set's own 99 a day.
  assert.deepEqual(
    out.entities.map(e => [e.entity_id, e.days_with_rows, e.realized_spend, e.realized_conversions]),
    [
      ['10', 2, '122', '21'],
      ['20', 2, '70', '9'],
    ],
  );
  assert.equal(out.totals.realized_conversions, '30');
  assert.equal(out.totals.realized_spend, '192');
  // The outcome capture is retained evidence that says how it counted, like the proposal's.
  const retained = f.store.document(f.actor.tenantId, 'decision_report', out.outcome_report_id);
  assert.equal(retained.action_count_basis, 'requested_attribution');
  assert.deepEqual(
    retained.rows.map(r => [r.entity_id, r.date, r.conversions]),
    [
      ['10', doc.window.since, '8'],
      ['20', doc.window.since, '5'],
      ['10', doc.window.until, '13'],
      ['20', doc.window.until, '4'],
    ].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])),
  );
});

test('Meta evidence read before captures counted the requested windows (it has no basis) is never compared with an outcome that did', async t => {
  const f = fixture(t),
    id = await f.executed(await f.evidence({unstamped: true})),
    doc = f.outcomeDoc(id);
  assert.equal(doc.state, 'scheduled');
  // The frozen settings are exactly what they were: the evidence has no basis, so none is added.
  assert.deepEqual(Object.keys(doc.capture).sort(), [
    'account_id',
    'attribution_windows',
    'connection_id',
    'gateway',
    'preset',
    'result_action_type',
    'semantics',
  ]);
  const out = good(await later(afterWindow(doc), () => f.capture(id)));
  // The outcome counted the requested windows (it carries the basis); the proposal's evidence counted the ad set's own value.
  assert.equal(out.state, 'unavailable', 'two bases are not compared');
  assert.equal(out.reason, 'measurement_definition_changed');
  assert.deepEqual(out.changed_fields, ['action_count_basis']);
  assert.equal(out.entities, undefined, 'no comparison is shown');
  assert.equal(out.totals, undefined);
  assert.equal(out.calibration_evidence, undefined);
  // The outcome capture itself was read and is retained as ordinary evidence.
  assert.equal(
    f.store.document(f.actor.tenantId, 'decision_report', out.outcome_report_id).action_count_basis,
    'requested_attribution',
  );
  // The record says so when opened again, and a later capture is refused without reading anything.
  const shown = good(await f.view(id));
  assert.equal(shown.state, 'unavailable');
  assert.equal(shown.reason, 'measurement_definition_changed');
  assert.deepEqual(shown.changed_fields, ['action_count_basis']);
  const reads = f.requests.length;
  assertRefused(await f.capture(id), 'ALLOCATION_OUTCOME_UNAVAILABLE');
  assert.equal(f.requests.length, reads, 'nothing is read for an outcome that cannot be compared');
});
