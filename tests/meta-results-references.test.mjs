// Package meta-results (the lead's rulings 9 and 11): retained captures are compared or added by their definitions in three places besides
// the allocation outcome review: an analyze baseline must be "another window of the same report definition" (assertCompatibleBaseline), a
// retained reconciliation compares two reads of one period (compareReportContext), both in src/report-references.ts, and `combine` sums the
// counts of same-window reports of different accounts (src/decision-reporting.ts). Since ruling 5 a Meta preset capture counts the
// attribution windows it asked for and says so (`action_count_basis`, src/decision-reporting.ts); a capture retained before has no such
// field and counted the entry's own `value`. Two reads of one definition counted two ways are not another window of one report, not a
// reconciliation and not to be added: they are refused with REPORT_SEMANTICS_MISMATCH naming the field. Captures with no basis on either
// side (everything retained before, and Google's) compare and combine as they always did. The names of the fields are shown as they are
// (they are built into an English sentence and `details.fields`; no label map and no Arabic exist for any of them). Each refusal is asserted
// by its code, its `details.fields` and the sentence of the place that refuses (`sentences` below): the code and the fields are the same in
// all three places, so the sentence is what shows which place refused. analyze's own call of `compatibility` (src/decision-reporting.ts,
// which combine calls with `adds`) must not be the one that refuses a baseline: it would say combine's sentence, and nothing else would notice.
// Synthetic Meta answers behind the real service and transport; nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {reportPresets} from '../dist/src/report-presets.js';
import {assertCompatibleBaseline, compareReportContext} from '../dist/src/report-references.js';
import {assertRefused} from './helpers/assert-refused.mjs';

const stamp = 'requested_attribution';
const preset = reportPresets.find(p => p.id === 'meta_campaign' && p.gateway === 'meta_native_action');
const mapping = {
  entity_id: '/campaign_id',
  entity_name: '/campaign_name',
  date: '/date_start',
  spend: '/spend',
  conversions: {path: '/actions', action_type: 'offsite_conversion.fb_pixel_purchase'},
};
/** A retained Meta preset capture as far as the two comparisons read it. */
const read = (id, more = {}) => ({
  id,
  source: 'provider_read',
  gateway: 'meta_native_action',
  account_id: '100',
  preset: preset.id,
  grain: preset.grain,
  mapping,
  source_request: {action: 'meta_ad_account_id_insights_get'},
  semantics: {
    currency: 'USD',
    timezone: 'UTC',
    date_from: '2026-09-02',
    date_to: '2026-09-02',
    attribution: 'Meta 7d_click + 1d_view; impression time',
    conversion_definition: 'offsite_conversion.fb_pixel_purchase',
    complete: true,
  },
  ...more,
});
// What each place says when it refuses: the fields it names are joined into its own sentence.
const sentences = {
  'analyze baseline': /^The baseline is not another window of the same report: (.+)\.$/,
  reconcile: /^Retained reports cannot be reconciled: (.+)\.$/,
  combine: /^Report semantics cannot be combined: (.+)$/,
};
/** The fields a refusal lists, after the sentence of `place` is proved to name exactly them. */
const named = ({message, details}, place) => {
  assert.ok(Array.isArray(details?.fields), place + ': the refusal lists the fields it names');
  assert.equal(
    sentences[place].exec(message)[1],
    details.fields.join(', '),
    place + ': the sentence names the fields the refusal lists',
  );
  return details.fields;
};
/** The fields a refusal names, after it is proved to be a REPORT_SEMANTICS_MISMATCH in the sentence of `place`. */
const refusedFields = (run, place) => {
  let fields;
  assert.throws(run, error => {
    assertRefused(error, 'REPORT_SEMANTICS_MISMATCH', {message: sentences[place]});
    fields = named(error, place);
    return true;
  });
  return fields;
};
const both = (a, b) => [
  ['analyze baseline', () => assertCompatibleBaseline(a, b)],
  ['reconcile', () => compareReportContext(a, b)],
];

test('a capture that counted the requested windows is not another window of one that did not, nor reconciled with it', () => {
  const counted = id => read(id, {action_count_basis: stamp}),
    older = id => read(id);
  for (const [what, run] of [
    ...both(counted('a'), older('b')),
    // The other way round, and a basis that is simply another one, are the same refusal.
    ...both(older('a'), counted('b')),
    ...both(counted('a'), read('b', {action_count_basis: 'the_entrys_own_value'})),
  ])
    assert.deepEqual(refusedFields(run, what), ['action_count_basis'], what);
  // It is one more field beside the ones that were always checked, never instead of them.
  const other = read('b', {mapping: {...mapping, spend: '/inline_spend'}});
  for (const [what, run] of [
    ['analyze baseline', () => assertCompatibleBaseline(counted('a'), other)],
    ['reconcile', () => compareReportContext(counted('a'), other)],
  ])
    assert.deepEqual(refusedFields(run, what), ['native field mapping', 'action_count_basis'], what);
});

test('captures with the same basis, or with none on either side, compare as they always did', () => {
  for (const [what, a, b] of [
    [
      'both counted the requested windows',
      read('a', {action_count_basis: stamp}),
      read('b', {action_count_basis: stamp}),
    ],
    ['neither says how it counted (retained before)', read('a'), read('b')],
  ]) {
    assert.doesNotThrow(() => assertCompatibleBaseline(a, b), 'analyze baseline: ' + what);
    assert.equal(compareReportContext(a, b).account_id, '100', 'reconcile: ' + what);
  }
  // Another platform's capture, which never carries a basis: unchanged by it (its own tests are tests/report-adapter-correctness.test.ts).
  const google = id =>
    read(id, {
      gateway: 'google_ads_native_action',
      account_id: '1234567890',
      preset: 'google_campaign',
      grain: reportPresets.find(p => p.id === 'google_campaign').grain,
    });
  assert.doesNotThrow(() => assertCompatibleBaseline(google('a'), google('b')));
  assert.equal(compareReportContext(google('a'), google('b')).account_id, '1234567890');
});

// The real flow: two retained captures of one preset through the service, one of them as a build that did not count the windows stored it.
const actor = {tenantId: 'meta-references', userId: 'owner', role: 'admin'};
const connectionId = 'cccccccc-1111-4111-8111-111111111111';
const purchase = 'offsite_conversion.fb_pixel_purchase';
const day = 86400000;
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 144).toString('base64'));
  store.putConnection(
    actor,
    {
      id: connectionId,
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['100', '200', '300'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['ads_read'],
    },
    {accessToken: 'synthetic'},
  );
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async raw => {
      const url = new URL(raw),
        account = /\/act_(\d+)/.exec(url.pathname)[1];
      if (!url.pathname.endsWith('/insights'))
        return Response.json({id: 'act_' + account, account_id: account, currency: 'USD', timezone_name: 'UTC'});
      const range = JSON.parse(url.searchParams.get('time_range')),
        dates = [];
      for (let at = Date.parse(range.since); at <= Date.parse(range.until); at += day)
        dates.push(new Date(at).toISOString().slice(0, 10));
      return Response.json({
        data: dates.map(date => ({
          account_id: account,
          account_currency: 'USD',
          campaign_id: '10',
          campaign_name: 'Campaign 10',
          date_start: date,
          date_stop: date,
          spend: '10',
          impressions: '1000',
          clicks: '50',
          reach: '800',
          frequency: '1.25',
          // Under the explicit windows the preset asks for, each window's count is under its name beside the ad set's own `value`.
          actions: [{action_type: purchase, value: '99', '7d_click': '4', '1d_view': '1'}],
          action_values: [],
        })),
      });
    }),
  );
  const call = args => service.call('amcp_reporting', args, actor);
  return {
    store,
    call,
    capture: async (from, to, account = '100', action = purchase) => {
      const out = await call({
        action: 'capture_preset',
        preset: 'meta_campaign',
        account_id: account,
        connection_id: connectionId,
        result_action_type: action,
        attribution_windows: ['7d_click', '1d_view'],
        semantics: {
          currency: 'USD',
          timezone: 'UTC',
          date_from: from,
          date_to: to,
          source_name: 'Synthetic Meta evidence',
          complete: true,
        },
      });
      assert.equal(out.success, true, JSON.stringify(out));
      assert.equal(
        store.document(actor.tenantId, 'decision_report', out.data.id).action_count_basis,
        stamp,
        'a capture today carries the basis',
      );
      return out.data.id;
    },
    /** The capture as a build that did not count the windows stored it: the same document without the basis. */
    unstamp: id => {
      const {
        id: _id,
        revision: _revision,
        action_count_basis: _basis,
        ...older
      } = store.document(actor.tenantId, 'decision_report', id);
      store.putDocument(actor.tenantId, 'decision_report', id, older);
    },
  };
}
/** The fields a refused call names, after it is proved to be a REPORT_SEMANTICS_MISMATCH in the sentence of `place`. */
const refusedBy = async (call, args, place) => {
  const out = await call(args);
  assertRefused(out, 'REPORT_SEMANTICS_MISMATCH', {message: sentences[place]});
  return named(out.error, place);
};

test('analyze refuses a baseline counted the other way and accepts one counted the same way, through the service', async () => {
  const f = fixture();
  try {
    const report = await f.capture('2026-09-02', '2026-09-02'),
      baseline = await f.capture('2026-09-01', '2026-09-01'),
      analyze = (id, baseline_id) => f.call({action: 'analyze', id, baseline_id});
    // Both counted the requested windows: the baseline is another window of the same report.
    const compared = await analyze(report, baseline);
    assert.equal(compared.success, true, JSON.stringify(compared));
    assert.equal(compared.data.baseline_id, baseline);
    // The baseline was retained before the windows were counted: refused, with the field named.
    f.unstamp(baseline);
    assert.deepEqual(
      await refusedBy(f.call, {action: 'analyze', id: report, baseline_id: baseline}, 'analyze baseline'),
      ['action_count_basis'],
    );
    // And the other way round: an older report against a baseline that counted the windows.
    const newer = await f.capture('2026-09-01', '2026-09-01');
    f.unstamp(report);
    assert.deepEqual(await refusedBy(f.call, {action: 'analyze', id: report, baseline_id: newer}, 'analyze baseline'), [
      'action_count_basis',
    ]);
    // Two older captures (neither says how it counted) are compared as before.
    f.unstamp(newer);
    assert.equal((await analyze(report, newer)).success, true);
  } finally {
    f.store.close();
  }
});

test('reconcile_report refuses two reads of one period counted two ways and compares two counted the same way, through the service', async () => {
  const f = fixture();
  try {
    const first = await f.capture('2026-09-02', '2026-09-03'),
      second = await f.capture('2026-09-02', '2026-09-03'),
      reconcile = (id, reference_id) => f.call({action: 'reconcile_report', id, reference_id});
    const compared = await reconcile(first, second);
    assert.equal(compared.success, true, JSON.stringify(compared));
    // One of them was retained before the windows were counted.
    f.unstamp(second);
    assert.deepEqual(
      await refusedBy(f.call, {action: 'reconcile_report', id: first, reference_id: second}, 'reconcile'),
      ['action_count_basis'],
    );
    assert.deepEqual(
      await refusedBy(f.call, {action: 'reconcile_report', id: second, reference_id: first}, 'reconcile'),
      ['action_count_basis'],
    );
    // Neither says how it counted: compared as before.
    f.unstamp(first);
    assert.equal((await reconcile(first, second)).success, true);
  } finally {
    f.store.close();
  }
});

test('combine adds the reports’ counts, so it refuses captures counted two ways and combines captures counted the same way, through the service', async () => {
  const f = fixture();
  try {
    // One window, three accounts: each capture is one day of 10 spend and 5 conversions (4 + 1: the requested windows' counts).
    const window = ['2026-09-02', '2026-09-02'],
      a = await f.capture(...window, '100'),
      b = await f.capture(...window, '200'),
      c = await f.capture(...window, '300'),
      combine = (id, ids) => f.call({action: 'combine', id, ids});
    const added = await combine(a, [b, c]);
    assert.equal(added.success, true, JSON.stringify(added));
    // combine adds: `totals(all.flatMap(report => report.rows))` in src/decision-reporting.ts.
    assert.deepEqual([added.data.totals.spend, added.data.totals.conversions], ['30', '15']);
    // One of them was retained before the windows were counted: the sum would add two bases, whichever place it has in the call.
    f.unstamp(c);
    for (const [id, ids] of [
      [a, [b, c]],
      [c, [a, b]],
      [b, [c]],
    ])
      assert.deepEqual(await refusedBy(f.call, {action: 'combine', id, ids}, 'combine'), ['action_count_basis']);
    // Two that carry the same basis still combine.
    assert.deepEqual((await combine(a, [b])).data.totals.conversions, '10');
    // It is one more field beside the ones that were always checked, never instead of them: another result definition too.
    const other = await f.capture(...window, '200', 'lead');
    assert.deepEqual(await refusedBy(f.call, {action: 'combine', id: a, ids: [other]}, 'combine'), [
      'conversion_definition',
    ]);
    f.unstamp(other);
    assert.deepEqual(await refusedBy(f.call, {action: 'combine', id: a, ids: [other]}, 'combine'), [
      'conversion_definition',
      'action_count_basis',
    ]);
    // None says how it counted (all retained before): combined as before, with the same sum.
    f.unstamp(a);
    f.unstamp(b);
    const older = await combine(a, [b, c]);
    assert.equal(older.success, true, JSON.stringify(older));
    assert.deepEqual([older.data.totals.spend, older.data.totals.conversions], ['30', '15']);
  } finally {
    f.store.close();
  }
});
