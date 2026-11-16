import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {reportPreset} from '../dist/src/report-presets.js';
import {providerDataAction} from '../dist/src/errors.js';
import {providerRemedy} from '../dist/src/provider-remedies.js';
import {
  snapchatEvidenceInput as input,
  snapchatEvidenceResponse,
  snapchatEvidenceEntity as entity,
  snapchatEvidenceId as id,
  snapchatEvidenceDates as dates,
  snapchatEvidenceCampaign as campaign,
} from './fixtures/snapchat-evidence-data.mjs';
function fixture(t, rows, sem = input.semantics) {
  const actor = {tenantId: 'snapchat-evidence', userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 116).toString('base64')),
    connection = {
      id: input.connection_id,
      tenantId: actor.tenantId,
      gateway: 'snapchat_native_action',
      accounts: [input.account_id],
      enabled: true,
      label: 'Synthetic Snapchat',
      scopes: ['snapchat-marketing-api'],
    },
    credentials = {accessToken: 'synthetic'},
    requests = [];
  t.after(() => store.close());
  store.putConnection(actor, connection, credentials);
  let edit = (_u, d) => d;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (raw, init) => {
        const url = new URL(raw);
        requests.push({url, method: init.method});
        assert.equal(init.method, 'GET');
        return Response.json(edit(url, snapchatEvidenceResponse(raw, rows, sem), requests.length));
      },
      async () => {},
    ),
  );
  return {
    actor,
    store,
    connection,
    credentials,
    requests,
    edit: fn => {
      edit = fn;
    },
    call: (args = input) => service.call('amcp_reporting', args, actor),
  };
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};
const unsaved = f => assert.equal(f.store.documents(f.actor.tenantId, 'decision_report').length, 0);
const native = d => d.timeseries_stats[0].timeseries_stat;

test('Snapchat ad-squad evidence uses campaign stats under fresh exact parent evidence', async t => {
  const f = fixture(t),
    args = {...input, preset: 'snapchat_adsquad', campaign_id: campaign};
  const presets = ok(await f.call({action: 'capture_presets'})).presets;
  assert.ok(presets.some(p => p.id === args.preset));
  const r = ok(await f.call(args));
  assert.equal(r.row_count, 2);
  assert.equal(r.totals.spend, '20.246912');
  assert.equal(r.grain, 'ad squad × day');
  assert.equal(r.source_request.action, 'snapchat_campaign_stats_get');
  assert.equal(r.source_request.path_params.campaign_id, campaign);
  assert.equal(r.native_account_evidence.parent_campaign.id, campaign);
  assert.equal(r.native_account_evidence.parent_campaign.account_id, input.account_id);
  assert.equal(r.native_account_evidence.parent_campaign.checks.length, 3);
  assert.equal(f.requests.filter(r => r.url.pathname.endsWith('/stats')).length, 1);
  assert.ok(f.requests.every(r => r.method === 'GET'));
  const comparable = ok(await f.call(args));
  assert.equal(ok(await f.call({action: 'reconcile_report', id: r.id, reference_id: comparable.id})).matched, true);
  const saved = f.store.document(f.actor.tenantId, 'decision_report', comparable.id);
  f.store.putDocument(f.actor.tenantId, 'decision_report', comparable.id, {
    ...saved,
    source_request: {...saved.source_request, path_params: {campaign_id: id(401)}},
  });
  const mismatch = await f.call({action: 'reconcile_report', id: r.id, reference_id: comparable.id});
  assert.equal(mismatch.success, false);
  assert.equal(mismatch.error.code, 'REPORT_SEMANTICS_MISMATCH');
});

test('Snapchat ad-squad reports require an explicit campaign and refuse unrelated preset filters', () => {
  for (const campaign_id of [undefined, ['bad'], 400, id(400) + '/stats'])
    assert.throws(() => reportPreset({...input, preset: 'snapchat_adsquad', campaign_id}));
  assert.throws(() => reportPreset({...input, campaign_id: campaign}));
});

test('Snapchat ad-squad evidence refuses foreign, coerced and changed parents before retention', async t => {
  for (const kind of [
    'foreign_collection',
    'failed_collection',
    'coerced_parent',
    'changed_parent',
    'foreign_stat',
    'wrong_entity',
    'foreign_cursor',
  ]) {
    const f = fixture(t);
    let parentReads = 0;
    f.edit((u, d) => {
      if (u.pathname.endsWith('/campaigns')) {
        if (kind === 'foreign_collection') d.campaigns[0].campaign.ad_account_id = id(999);
        if (kind === 'failed_collection') d.campaigns[0].sub_request_status = 'ERROR';
      }
      if (u.pathname === '/v1/campaigns/' + campaign) {
        parentReads++;
        if (kind === 'coerced_parent') d.campaigns[0].campaign.id = [campaign];
        if (kind === 'changed_parent' && parentReads === 2) d.campaigns[0].campaign.ad_account_id = id(999);
      }
      if (u.pathname.endsWith('/stats')) {
        if (kind === 'foreign_stat') native(d).id = id(401);
        if (kind === 'wrong_entity') native(d).breakdown_stats.adsquad[0].type = 'AD';
        if (kind === 'foreign_cursor')
          d.paging.next_link = 'https://adsapi.snapchat.com/v1/campaigns/' + id(401) + '/stats?cursor=next';
      }
      return d;
    });
    const r = await f.call({...input, preset: 'snapchat_adsquad', campaign_id: campaign});
    assert.equal(r.success, false, kind);
    unsaved(f);
    if (['foreign_collection', 'failed_collection', 'coerced_parent'].includes(kind))
      assert.equal(
        f.requests.some(r => r.url.pathname.endsWith('/stats')),
        false,
        kind,
      );
  }
});

test('Snapchat ad-squad captures retain every native page and finalization under the original campaign', async t => {
  const rows = Array.from({length: 201}, (_, i) => entity('adsquad', id(i + 1))),
    f = fixture(t, rows);
  const r = ok(await f.call({...input, preset: 'snapchat_adsquad', campaign_id: campaign}));
  assert.equal(r.row_count, 402);
  assert.equal(r.source_pages.length, 2);
  assert.ok(r.source_pages.every(p => p.source_request.path_params.campaign_id === campaign));
  assert.equal(r.native_account_evidence.parent_campaign.checks.length, 3);
  assert.equal(r.collection_usage.requests, 7);
});

test('Snapchat parent discovery follows only bounded account cursors and rechecks authority before global stats', async t => {
  const f = fixture(t);
  f.edit((u, d) => {
    if (u.pathname.endsWith('/campaigns') && !u.searchParams.has('cursor')) {
      d.campaigns[0].campaign.id = id(401);
      const next = new URL(u);
      next.searchParams.set('cursor', 'parent-next');
      d.paging.next_link = next.href;
    }
    return d;
  });
  const r = ok(await f.call({...input, preset: 'snapchat_adsquad', campaign_id: campaign}));
  assert.equal(r.native_account_evidence.parent_campaign.checks.length, 4);
  assert.equal(r.collection_usage.requests, 7);
  for (const kind of ['foreign_cursor', 'repeated_cursor', 'credentials', 'scopes', 'accounts']) {
    const rejected = fixture(t);
    rejected.edit((u, d, n) => {
      if (u.pathname.endsWith('/campaigns')) {
        if (['foreign_cursor', 'repeated_cursor'].includes(kind)) {
          d.campaigns[0].campaign.id = id(401);
          const next = new URL(u);
          next.searchParams.set('cursor', 'repeated');
          if (kind === 'foreign_cursor') next.pathname = '/v1/adaccounts/' + id(999) + '/campaigns';
          d.paging.next_link = next.href;
        }
        if (['credentials', 'scopes', 'accounts'].includes(kind))
          rejected.store.putConnection(
            rejected.actor,
            {
              ...rejected.connection,
              ...(kind === 'scopes' ? {scopes: []} : {}),
              ...(kind === 'accounts' ? {accounts: []} : {}),
            },
            kind === 'credentials' ? {accessToken: 'rotated'} : rejected.credentials,
          );
      }
      return d;
    });
    assert.equal(
      (await rejected.call({...input, preset: 'snapchat_adsquad', campaign_id: campaign})).success,
      false,
      kind,
    );
    assert.equal(
      rejected.requests.some(r => r.url.pathname.endsWith('/stats')),
      false,
      kind,
    );
    unsaved(rejected);
  }
});

test('Snapchat guided campaign and ad evidence uses exact units, requested settings and bracketed source lineage', async t => {
  for (const level of ['campaign', 'ad']) {
    const f = fixture(t),
      presets = ok(await f.call({action: 'capture_presets'})).presets;
    assert.ok(presets.some(p => p.id === 'snapchat_' + level));
    const r = ok(await f.call({...input, preset: 'snapchat_' + level}));
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows[0].entity_id, id(1));
    assert.equal(r.rows[0].entity_name, null);
    assert.equal(r.rows[0].date, '2026-09-01');
    assert.equal(r.totals.spend, '20.246912');
    assert.equal(r.totals.clicks, '60');
    assert.equal(r.totals.conversions, '4');
    assert.equal(r.totals.conversion_value, null);
    assert.equal(r.semantics.attribution, 'Snapchat 7_DAY swipe / 1_DAY view; conversion time; total sources');
    assert.equal(r.semantics.conversion_definition, 'conversion_purchases (total sources)');
    assert.equal(r.native_account_evidence.checks.length, 2);
    assert.equal(r.source_pages.length, 1);
    assert.equal(r.source_pages[0].row_count, 2);
    assert.equal(r.source_pages[0].entity_count, 1);
    assert.equal(r.source_pages[0].conversion_data_processed_end_time, dates().at(-1).time);
    assert.equal(r.collection_usage.requests, 3);
    assert.equal(r.source_collection, 'snapchat_daily_pages');
    assert.equal(f.requests.length, 3);
    const query = f.requests[1].url.searchParams;
    assert.equal(query.get('granularity'), 'DAY');
    assert.equal(query.get('breakdown'), level);
    assert.equal(query.get('action_report_time'), 'conversion');
    assert.equal(query.get('conversion_source_types'), 'total');
    assert.equal(query.get('omit_empty'), 'false');
    assert.equal(query.get('start_time'), '2026-08-31T21:00:00.000Z');
    assert.equal(query.get('end_time'), '2026-09-02T21:00:00.000Z');
    assert.deepEqual(query.get('fields').split(','), ['spend', 'impressions', 'swipes', 'conversion_purchases']);
  }
});
test('Snapchat complete native paging retains every day and supports retained paging and compatible reconciliation', async t => {
  const rows = Array.from({length: 201}, (_, i) => entity('campaign', id(i + 1))),
    f = fixture(t, rows);
  const a = ok(await f.call());
  assert.equal(a.row_count, 402);
  assert.equal(a.rows.length, 50);
  assert.deepEqual(
    a.source_pages.map(p => [p.entity_count, p.row_count]),
    [
      [200, 400],
      [1, 2],
    ],
  );
  assert.equal(a.totals.spend, '4069.629312');
  assert.equal(f.requests.length, 4);
  const tail = ok(await f.call({action: 'get', id: a.id, offset: 400}));
  assert.equal(tail.rows[0].entity_id, id(201));
  assert.equal(f.requests.length, 4);
  const b = ok(await f.call()),
    c = ok(await f.call({action: 'reconcile_report', id: a.id, reference_id: b.id}));
  assert.equal(c.context_compatible, true);
  assert.equal(c.matched, true);
  const changed = ok(await f.call({...input, swipe_up_attribution_window: '28_DAY'}));
  const mismatch = await f.call({action: 'reconcile_report', id: a.id, reference_id: changed.id});
  assert.equal(mismatch.success, false);
  assert.equal(mismatch.error.code, 'REPORT_SEMANTICS_MISMATCH');
});
test('Snapchat empty complete breakdown is qualified but absent metric values remain unknown', async t => {
  const empty = fixture(t, []),
    zero = ok(await empty.call());
  assert.equal(zero.row_count, 0);
  assert.equal(zero.totals.spend, '0');
  const row = entity();
  delete row.timeseries[0].stats.conversion_purchases;
  row.timeseries[1].stats.spend = '9007199254740993';
  const f = fixture(t, [row]),
    r = ok(await f.call());
  assert.equal(r.rows[0].conversions, null);
  assert.equal(r.totals.conversions, null);
  assert.equal(r.rows[1].spend, '9007199254.740993');
  assert.equal(r.totals.spend, '9007199264.864449');
});
// r12-fix item 1 (O-4 of the live checks of 2026-11-16). For a campaign (or an account) with no rows in the window Snapchat
// answers without finalized_data_end_time and conversion_data_processed_end_time, and the capture refused it as an invalid
// timestamp. The guided capture and the Overview's all-campaign read share one collector, so it is the same fix: an answer
// with no rows may omit the two times and is a capture with no rows; an answer with rows, or a time that is present but
// not valid, is refused as before (the test above, and the ones below).
const leaveOutFinalization = f =>
  f.edit((u, d) => {
    if (u.pathname.endsWith('/stats')) {
      delete native(d).finalized_data_end_time;
      delete native(d).conversion_data_processed_end_time;
    }
    return d;
  });
for (const level of ['adsquad', 'campaign', 'ad'])
  test(
    'Snapchat guided ' +
      level +
      ' evidence of a window with no rows completes when the answer leaves out the finalization times',
    async t => {
      const f = fixture(t, []);
      leaveOutFinalization(f);
      const r = ok(
        await f.call({...input, preset: 'snapchat_' + level, ...(level === 'adsquad' ? {campaign_id: campaign} : {})}),
      );
      assert.equal(r.row_count, 0);
      assert.deepEqual(r.rows, []);
      assert.equal(r.source_pages.length, 1);
      assert.equal(r.source_pages[0].entity_count, 0);
      assert.equal(r.source_pages[0].row_count, 0);
      // The saved page does not claim a finalization time that Snapchat did not give.
      assert.equal(r.source_pages[0].finalized_data_end_time, undefined);
      assert.equal(r.source_pages[0].conversion_data_processed_end_time, undefined);
      // The account (and for an ad squad the parent campaign) was still verified before and after the read.
      assert.equal(r.native_account_evidence.checks.length, 2);
      if (level === 'adsquad') assert.equal(r.native_account_evidence.parent_campaign.checks.length, 3);
      assert.equal(f.store.documents(f.actor.tenantId, 'decision_report').length, 1);
    },
  );
for (const [label, mutate, code] of [
  [
    'a finalized_data_end_time without an offset',
    d => (native(d).finalized_data_end_time = '2026-09-02T21:00:00'),
    'REPORT_DATE_MISMATCH',
  ],
  ['a finalized_data_end_time that is null', d => (native(d).finalized_data_end_time = null), 'REPORT_DATE_MISMATCH'],
  [
    'a finalized_data_end_time before the end of the window',
    d => (native(d).finalized_data_end_time = dates()[1].time),
    'REPORT_INCOMPLETE',
  ],
  [
    'a conversion_data_processed_end_time before the end of the window',
    d => (native(d).conversion_data_processed_end_time = dates()[1].time),
    'REPORT_INCOMPLETE',
  ],
])
  test('Snapchat guided evidence with no rows is still refused when its answer carries ' + label, async t => {
    const f = fixture(t, []);
    f.edit((u, d) => {
      if (u.pathname.endsWith('/stats')) {
        delete native(d).finalized_data_end_time;
        delete native(d).conversion_data_processed_end_time;
        mutate(d);
      }
      return d;
    });
    const r = await f.call({...input, preset: 'snapchat_adsquad', campaign_id: campaign});
    assert.equal(r.success, false);
    assert.equal(r.error.code, code);
    unsaved(f);
  });
// r12-fix item 3 (V2-RPT-05; error 1 of the live checks of 2026-11-16). A refused timestamp names which one failed (a closed set,
// details.timestamp_field), so its remedy can say so and that a retry returns the same answer. Another refusal of the same code,
// a valid timestamp of another window, names none and keeps the shared advice.
for (const [label, mutate, field] of [
  ['finalized_data_end_time is missing', d => delete native(d).finalized_data_end_time, 'finalized_data_end_time'],
  [
    'conversion_data_processed_end_time is missing',
    d => delete native(d).conversion_data_processed_end_time,
    'conversion_data_processed_end_time',
  ],
  ['the answer’s start_time has no offset', d => (native(d).start_time = '2026-09-01T00:00:00'), 'start_time'],
  ['the answer’s end_time has no offset', d => (native(d).end_time = '2026-09-03T00:00:00'), 'end_time'],
  [
    'an entity’s start_time has no offset',
    d => (native(d).breakdown_stats.campaign[0].start_time = '2026-09-01T00:00:00'),
    'start_time',
  ],
  [
    'an entity’s end_time has no offset',
    d => (native(d).breakdown_stats.campaign[0].end_time = '2026-09-03T00:00:00'),
    'end_time',
  ],
  [
    'a day’s start_time has no offset',
    d => (native(d).breakdown_stats.campaign[0].timeseries[0].start_time = '2026-09-01T00:00:00'),
    'start_time',
  ],
  [
    'a day’s end_time has no offset',
    d => (native(d).breakdown_stats.campaign[0].timeseries[0].end_time = '2026-09-02T00:00:00'),
    'end_time',
  ],
])
  test('Snapchat guided evidence names the timestamp that failed when ' + label, async t => {
    const f = fixture(t);
    f.edit((u, d) => {
      if (u.pathname.endsWith('/stats')) mutate(d);
      return d;
    });
    const r = await f.call();
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'REPORT_DATE_MISMATCH');
    assert.equal(r.error.details.timestamp_field, field);
    const remedy = providerRemedy('REPORT_DATE_MISMATCH', {timestamp_field: field});
    assert.ok(remedy, 'a remedy for ' + field);
    assert.equal(r.error.remedy.action, remedy.action);
    assert.equal(r.error.next_action, remedy.action);
    assert.equal(r.error.category, 'report');
    assert.notEqual(r.error.remedy.action, providerDataAction);
    unsaved(f);
  });
test('Snapchat guided evidence of another window is refused as a different window, which names no timestamp and keeps the shared advice', async t => {
  const f = fixture(t);
  f.edit((u, d) => {
    if (u.pathname.endsWith('/stats')) native(d).start_time = dates()[1].time;
    return d;
  });
  const r = await f.call();
  assert.equal(r.success, false);
  assert.equal(r.error.code, 'REPORT_DATE_MISMATCH');
  assert.match(r.error.message, /different reporting window or grain/);
  assert.equal(r.error.details?.timestamp_field, undefined);
  assert.equal(r.error.remedy.action, providerDataAction);
  unsaved(f);
});
test('Snapchat daily capture refuses missing finalization, failed envelopes and unrequested reporting dimensions', async t => {
  const mutations = [
    d => {
      delete native(d).finalized_data_end_time;
    },
    d => {
      native(d).conversion_data_processed_end_time = dates()[1].time;
    },
    d => {
      native(d).finalized_data_end_time = '2026-02-30T00:00:00Z';
    },
    d => {
      d.timeseries_stats[0].sub_request_status = 'ERROR';
    },
    d => {
      native(d).granularity = 'TOTAL';
    },
    d => {
      native(d).id = id(99);
    },
    d => {
      native(d).view_attribution_window = '7_DAY';
    },
    d => {
      native(d).split_results = [{stats: {spend: 10}}];
    },
    d => {
      native(d).breakdown_stats.ad = [];
    },
    d => {
      d.next_cursor = 'unrecognized';
    },
  ];
  for (const mutate of mutations) {
    const f = fixture(t);
    f.edit((u, d) => {
      if (u.pathname.endsWith('/stats')) mutate(d);
      return d;
    });
    assert.equal((await f.call()).success, false, mutate.toString());
    unsaved(f);
  }
});
test('Snapchat rejects incorrect entity/day identity, duplicate grain, missing days and unsafe native numbers', async t => {
  for (const mutate of [
    r => {
      r.id = [id(1)];
    },
    r => {
      r.type = 'AD';
    },
    r => {
      r.granularity = 'HOUR';
    },
    r => {
      r.timeseries.pop();
    },
    r => {
      r.timeseries[1] = r.timeseries[0];
    },
    r => {
      r.timeseries[0].end_time = r.end_time;
    },
    r => {
      r.timeseries[0].stats.spend = 9007199254740992;
    },
    r => {
      r.timeseries[0].stats.spend = '1.5';
    },
    r => {
      r.timeseries[0].dimension_stats = [{stats: {spend: 1}}];
    },
  ]) {
    const row = entity();
    mutate(row);
    const f = fixture(t, [row]);
    assert.equal((await f.call()).success, false, mutate.toString());
    unsaved(f);
  }
});
test('Snapchat continuation is restricted to the original account and query and rejects loops or overlapping entities', async t => {
  const rows = Array.from({length: 201}, (_, i) => entity('campaign', id(i + 1)));
  for (const change of [
    u => {
      u.host = 'foreign.example';
    },
    u => {
      u.pathname = '/v1/adaccounts/' + id(9) + '/stats';
    },
    u => {
      u.searchParams.set('action_report_time', 'impression');
    },
    u => {
      u.searchParams.set('access_token', 'secret');
    },
    u => {
      u.searchParams.append('cursor', '400');
    },
    u => {
      u.searchParams.set('cursor', '');
    },
    u => {
      u.username = 'someone';
    },
  ]) {
    const f = fixture(t, rows);
    f.edit((u, d) => {
      if (d.paging?.next_link) {
        const next = new URL(d.paging.next_link);
        change(next);
        d.paging.next_link = next.href;
      }
      return d;
    });
    assert.equal((await f.call()).success, false);
    assert.equal(f.requests.length, 2);
    unsaved(f);
  }
  for (const kind of ['loop', 'overlap']) {
    const f = fixture(t, rows);
    f.edit((u, d) => {
      if (u.searchParams.has('cursor')) {
        if (kind === 'loop') d.paging.next_link = u.href;
        else native(d).breakdown_stats.campaign[0] = rows[0];
      }
      return d;
    });
    assert.equal((await f.call()).success, false);
    assert.equal(f.requests.length, 3);
    unsaved(f);
  }
});
test('Snapchat rechecks metadata, credentials, scopes and current account access before retaining evidence', async t => {
  for (const kind of ['currency', 'timezone', 'identity', 'credentials', 'scopes', 'accounts']) {
    const f = fixture(t);
    f.edit((u, d, n) => {
      if (n === 2 && ['credentials', 'scopes', 'accounts'].includes(kind))
        f.store.putConnection(
          f.actor,
          {...f.connection, ...(kind === 'scopes' ? {scopes: []} : {}), ...(kind === 'accounts' ? {accounts: []} : {})},
          kind === 'credentials' ? {accessToken: 'rotated'} : f.credentials,
        );
      if (n === 3) {
        if (kind === 'currency') d.adaccounts[0].adaccount.currency = 'EUR';
        if (kind === 'timezone') d.adaccounts[0].adaccount.timezone = 'UTC';
        if (kind === 'identity') d.adaccounts[0].adaccount.id = [input.account_id];
      }
      return d;
    });
    assert.equal((await f.call()).success, false, kind);
    assert.equal(f.requests.length, ['credentials', 'scopes', 'accounts'].includes(kind) ? 2 : 3);
    unsaved(f);
  }
});
test('Snapchat presets require explicit supported attribution and closed local days, including DST boundaries', async t => {
  for (const changes of [
    {swipe_up_attribution_window: undefined},
    {view_attribution_window: undefined},
    {swipe_up_attribution_window: '1_DAY', view_attribution_window: '7_DAY'},
    {view_attribution_window: '28_DAY'},
    {semantics: {...input.semantics, complete: false}},
    {semantics: {...input.semantics, date_to: '2026-10-03', date_from: '2026-09-01'}},
    {semantics: {...input.semantics, timezone: 'Asia/Kolkata'}},
  ])
    assert.throws(() => reportPreset({...input, ...changes}));
  const sem = {...input.semantics, date_from: '2025-11-02', date_to: '2025-11-02', timezone: 'America/New_York'},
    f = fixture(t, undefined, sem),
    r = ok(await f.call({...input, semantics: sem}));
  assert.equal(r.rows[0].date, '2025-11-02');
  const q = f.requests[1].url.searchParams;
  assert.equal(Date.parse(q.get('end_time')) - Date.parse(q.get('start_time')), 25 * 3600000);
});

test('Snapchat refuses oversized complete collections before retention and keeps the previous source unchanged', async t => {
  const sem = {...input.semantics, date_from: '2026-08-01', date_to: '2026-08-31'},
    rows = Array.from({length: 324}, (_, i) => entity('campaign', id(i + 1), sem)),
    f = fixture(t, rows, sem);
  const result = await f.call({...input, semantics: sem});
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'REPORT_COLLECTION_LIMIT');
  assert.equal(f.requests.length, 3);
  unsaved(f);
  const preserved = fixture(t),
    original = ok(await preserved.call());
  preserved.edit((u, d) => {
    if (u.pathname.endsWith('/stats')) native(d).finalized_data_end_time = dates()[1].time;
    return d;
  });
  assert.equal((await preserved.call()).success, false);
  assert.equal(preserved.store.documents(preserved.actor.tenantId, 'decision_report').length, 1);
  const retained = ok(await preserved.call({action: 'get', id: original.id}));
  assert.equal(retained.source_hash, original.source_hash);
  assert.deepEqual(retained.totals, original.totals);
});
