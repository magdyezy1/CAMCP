// Package meta-results (the lead's ruling 5): Meta's guided captures (the amcp_reporting capture presets, the dimension packs and the
// allocation evidence) always ask Meta for explicit attribution windows. Under them an action's `value` is the ad set's own setting
// and each requested window's count is under the window's name (docs/records/META-RESULTS-PIN-2026-11-07.md, R14), so a capture counts
// the requested windows' keys like a v4 report does; a number that does not add across windows (a ratio, a cost, people) has none for
// several windows and is unknown with a reason, never the omitted zero. A v3 Overview report keeps reading `value`.
// Synthetic Meta answers behind the real service and transport; nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {DecisionReporting} from '../dist/src/decision-reporting.js';
import {reportPreset} from '../dist/src/report-presets.js';
import {reportAllocation} from '../dist/src/report-allocation.js';

const actor = {tenantId: 'meta-guided', userId: 'owner', role: 'admin'};
const connectionId = 'aaaaaaaa-1111-4111-8111-111111111111';
const purchase = 'offsite_conversion.fb_pixel_purchase';
const input = (more = {}) => ({
  action: 'capture_preset',
  preset: 'meta_ad',
  account_id: '100',
  connection_id: connectionId,
  result_action_type: purchase,
  attribution_windows: ['7d_click', '1d_view'],
  semantics: {
    currency: 'USD',
    timezone: 'UTC',
    date_from: '2026-09-01',
    date_to: '2026-09-02',
    source_name: 'Synthetic Meta evidence',
    complete: true,
  },
  ...more,
});
/**
 * One native row of an ad set whose own attribution setting is 1d_click: `value` is that setting (9 and 90), and each requested
 * window's own count is under its name, as Meta returns them under explicit windows.
 */
const nativeRow = (extra = {}) => ({
  account_id: '100',
  account_currency: 'USD',
  campaign_id: '10',
  adset_id: '20',
  ad_id: '30',
  ad_name: 'Ad A',
  date_start: '2026-09-01',
  date_stop: '2026-09-01',
  spend: '10',
  impressions: '100',
  clicks: '12',
  reach: '80',
  frequency: '1.25',
  actions: [
    {action_type: purchase, value: '9', '1d_click': '9', '7d_click': '4', '1d_view': '1'},
    {action_type: 'purchase', value: '999', '7d_click': '999'},
  ],
  action_values: [{action_type: purchase, value: '90', '1d_click': '90', '7d_click': '40.5', '1d_view': '5'}],
  ...extra,
});
function fixture(rows = [nativeRow()]) {
  const store = new Store(':memory:', Buffer.alloc(32, 91).toString('base64')),
    requests = [];
  store.putConnection(
    actor,
    {
      id: connectionId,
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['100'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['ads_read'],
    },
    {accessToken: 'synthetic'},
  );
  let response = {data: rows};
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      requests.push({url: String(url), method: init.method});
      const u = new URL(url);
      return Response.json(
        u.pathname.endsWith('/insights')
          ? structuredClone(response)
          : {id: 'act_100', account_id: '100', currency: 'USD', timezone_name: 'UTC'},
      );
    }),
  );
  return {
    store,
    requests,
    service,
    reporting: new DecisionReporting(store, (gateway, args, who) => service.call(gateway, args, who)),
    call: (args = input()) => service.call('amcp_reporting', args, actor),
    respond: value => {
      response = value;
    },
    insights: () =>
      new URL(requests.find(request => new URL(request.url).pathname.endsWith('/insights')).url).searchParams,
  };
}
const captured = out => {
  assert.equal(out.success, true, JSON.stringify(out));
  return out.data;
};

test('a capture under 7d_click + 1d_view counts those windows’ keys, not the ad set’s own 1d_click setting', async () => {
  const f = fixture();
  try {
    const data = captured(await f.call());
    // 4 + 1 purchases and 40.5 + 5 of value: the requested windows, added exactly; not the ad set's own 9 and 90.
    assert.equal(data.rows[0].conversions, '5');
    assert.equal(data.rows[0].conversion_value, '45.5');
    assert.equal(data.totals.conversions, '5');
    assert.equal(data.rows[0].omitted_as_zero, undefined);
    // The read asked Meta for exactly those windows.
    assert.deepEqual(JSON.parse(f.insights().get('action_attribution_windows')), ['7d_click', '1d_view']);
    for (const [windows, conversions, value] of [
      [['1d_view'], '1', '5'],
      [['7d_click'], '4', '40.5'],
      [['1d_click'], '9', '90'],
      [['1d_click', '1d_view'], '10', '95'],
    ]) {
      const out = captured(await f.call(input({attribution_windows: windows})));
      assert.equal(out.rows[0].conversions, conversions, windows.join(' + '));
      assert.equal(out.rows[0].conversion_value, value, windows.join(' + '));
    }
  } finally {
    f.store.close();
  }
});

test('an action with none of the requested windows’ keys is the omitted zero on a delivered row, and unknown on one with no delivery', async () => {
  const none = {
    actions: [{action_type: purchase, value: '9', '28d_click': '9'}],
    action_values: [{action_type: purchase, value: '90', '28d_click': '90'}],
  };
  const f = fixture([nativeRow(none), nativeRow({...none, ad_id: '31', impressions: '0'})]);
  try {
    const data = captured(await f.call());
    assert.equal(data.rows[0].conversions, '0');
    assert.deepEqual(data.rows[0].omitted_as_zero, ['conversions', 'conversion_value']);
    assert.equal(data.rows[1].conversions, null);
    assert.equal(data.rows[1].omitted_as_zero, undefined);
    assert.deepEqual(data.omitted_as_zero, {conversions: 1, conversion_value: 1});
    assert.equal(data.coverage.conversions, 'partial');
  } finally {
    f.store.close();
  }
});

test('a breakdown pack counts the requested windows too, per age and gender', async () => {
  const campaignRow = (age, gender, windows) =>
    nativeRow({
      age,
      gender,
      actions: [{action_type: purchase, value: '99', ...windows}],
      action_values: [{action_type: purchase, value: '990', ...windows}],
    });
  const f = fixture([
    campaignRow('25-34', 'female', {'7d_click': '3', '1d_view': '1'}),
    campaignRow('25-34', 'male', {'7d_click': '2'}),
  ]);
  try {
    const data = captured(await f.call(input({preset: 'meta_campaign_age_gender'})));
    assert.deepEqual(
      data.rows.map(row => [row.native_age, row.native_gender, row.conversions]),
      [
        ['25-34', 'female', '4'],
        ['25-34', 'male', '2'],
      ],
    );
  } finally {
    f.store.close();
  }
});

test('the allocation evidence counts the requested windows, and so does the proposal modeled from it', async () => {
  // Two closed days before today (an allocation proposal asks for recent, closed evidence).
  const today = Date.parse(new Date().toISOString().slice(0, 10)),
    first = new Date(today - 2 * 86400000).toISOString().slice(0, 10),
    last = new Date(today - 86400000).toISOString().slice(0, 10);
  const day = (id, date, spend, windows) =>
    nativeRow({
      campaign_id: id,
      adset_id: undefined,
      ad_id: undefined,
      date_start: date,
      date_stop: date,
      spend,
      actions: [{action_type: purchase, value: '99', ...windows}],
      action_values: [],
    });
  const f = fixture([
    day('10', first, '40', {'7d_click': '5', '1d_view': '3'}),
    day('10', last, '60', {'7d_click': '7', '1d_view': '5'}),
    day('20', first, '50', {'7d_click': '4', '1d_view': '1'}),
    day('20', last, '50', {'7d_click': '4', '1d_view': '1'}),
  ]);
  try {
    const evidence = captured(
      await f.call(
        input({preset: 'meta_campaign', semantics: {...input().semantics, date_from: first, date_to: last}}),
      ),
    );
    assert.deepEqual(
      evidence.rows.map(row => [row.entity_id, row.date, row.conversions]),
      [
        ['10', first, '8'],
        ['10', last, '12'],
        ['20', first, '5'],
        ['20', last, '5'],
      ],
    );
    // The retained evidence is what an allocation proposal reads (preview_allocation_plan).
    const retained = f.store.document(actor.tenantId, 'decision_report', evidence.id);
    const proposal = reportAllocation(retained, {
      budget: '200',
      efficiency_low: 0.8,
      efficiency_high: 1.2,
      minimum_conversions: 5,
      maximum_age_days: 90,
      allocations: [
        {entity_id: '10', minimum: '25', maximum: '125'},
        {entity_id: '20', minimum: '50', maximum: '175'},
      ],
    });
    assert.deepEqual(
      proposal.allocations.map(entity => [entity.entity_id, entity.observed_spend, entity.observed_conversions]),
      [
        ['10', '100', '20'],
        ['20', '100', '10'],
      ],
    );
  } finally {
    f.store.close();
  }
});

// A mapping a hand-made capture can ask for: a ratio under the requested windows. (The presets map only `actions` and
// `action_values`; the mapping is the shared capture's, so any list of action stats reaches the platform's hook.)
const roasRow = (more = {}) =>
  nativeRow({
    purchase_roas: [{action_type: 'omni_purchase', value: '3', '1d_click': '3', '7d_click': '2', '1d_view': '0.5'}],
    ...more,
  });
const roasCapture = async (f, windows, transient = false, overviewV4 = false) => {
  const request = reportPreset(input({preset: 'meta_ad', attribution_windows: windows})),
    mapping = {...request.mapping, conversion_value: {path: '/purchase_roas', action_type: 'omni_purchase'}};
  return f.reporting.handle(
    {action: 'capture', ...request, mapping},
    actor,
    'meta_ad',
    transient,
    false,
    undefined,
    overviewV4,
  );
};

test('a ratio under several windows has no number: unknown with a reason, never the omitted zero', async () => {
  const f = fixture([roasRow(), roasRow({ad_id: '31', impressions: '0'})]);
  try {
    const data = await roasCapture(f, ['7d_click', '1d_view']);
    // Two windows: a ratio is not the sum of its windows' ratios, and Meta sends none for the pair.
    for (const row of data.rows) assert.equal(row.conversion_value, null, row.entity_id);
    assert.equal(data.rows[0].omitted_as_zero, undefined, 'a delivered row does not count it as 0');
    assert.deepEqual(data.rows[0].unknown_reasons, {conversion_value: 'attribution_windows_do_not_add'});
    assert.deepEqual(data.rows[1].unknown_reasons, {conversion_value: 'attribution_windows_do_not_add'});
    assert.deepEqual(data.unknown_reasons, {conversion_value: {attribution_windows_do_not_add: 2}});
    assert.equal(data.omitted_as_zero?.conversion_value, undefined);
    assert.equal(data.coverage.conversion_value, 'partial');
    assert.equal(data.totals.conversion_value, null);
    // One window: that window's own ratio.
    const one = await roasCapture(f, ['7d_click']);
    assert.equal(one.rows[0].conversion_value, '2');
    assert.equal(one.rows[0].unknown_reasons, undefined);
    // A window the entry has no key for: no number for it, and that is not a zero either.
    const gone = await roasCapture(f, ['28d_click']);
    assert.equal(gone.rows[0].conversion_value, null);
    // (The count of the same row, which has no 28d_click key either, is the omitted zero: only the ratio is unknown.)
    assert.deepEqual(gone.rows[0].omitted_as_zero, ['conversions']);
    assert.deepEqual(gone.rows[0].unknown_reasons, {conversion_value: 'no_number_for_attribution_window'});
  } finally {
    f.store.close();
  }
});

test('a capture whose read asks for no windows reads the entry’s value, as it always did', async () => {
  const f = fixture();
  try {
    const request = reportPreset(input({preset: 'meta_ad'}));
    // The ad set's own attribution setting: no explicit windows on the read.
    const {action_attribution_windows: _windows, ...query} = request.arguments.query;
    const own = {
      ...request,
      arguments: {...request.arguments, query: {...query, use_unified_attribution_setting: true}},
    };
    const data = await f.reporting.handle({action: 'capture', ...own}, actor, 'meta_ad');
    assert.equal(data.rows[0].conversions, '9');
    assert.equal(data.rows[0].conversion_value, '90');
    assert.equal(data.unknown_reasons, undefined);
  } finally {
    f.store.close();
  }
});

test('the Overview collector keeps reading value for a v3 report, and counts the requested windows for a v4 report', async () => {
  const f = fixture();
  try {
    const request = reportPreset(input({preset: 'meta_ad'}));
    // transient: the Overview collector's own capture (src/overview-granularity.ts).
    const v3 = await f.reporting.handle(
      {action: 'capture', ...request},
      actor,
      'meta_ad',
      true,
      false,
      undefined,
      false,
    );
    assert.equal(v3.rows[0].conversions, '9', 'a v3 Overview report is untouched');
    assert.equal(v3.rows[0].conversion_value, '90');
    const v4 = await f.reporting.handle(
      {action: 'capture', ...reportPreset(input({preset: 'meta_ad'}), {overviewV4: true})},
      actor,
      'meta_ad',
      true,
      false,
      undefined,
      true,
    );
    assert.equal(v4.rows[0].conversions, '5');
    assert.equal(v4.rows[0].conversion_value, '45.5');
    const asked = await f.reporting.handle({action: 'capture', ...request}, actor, 'meta_ad', false);
    assert.equal(asked.rows[0].conversions, '5', 'a capture a person asks for');
  } finally {
    f.store.close();
  }
});
