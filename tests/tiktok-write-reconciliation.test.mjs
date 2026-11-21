import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {findCreated} from '../dist/src/write-reconciliation.js';
import {standardBodies} from './helpers/tiktok-standard-creates.mjs';
import {gateway, stamp, tiktokReconcileFixture} from './helpers/tiktok-reconcile-fixture.mjs';

/**
 * R2.5 M2 (L1-07, created-lookup part; L5-05): `reconcile` answered `no_read_contract` for every TikTok create. A TikTok
 * campaign, ad group or ad create now has a lookup that reads the advertiser's own list (TikTok's `campaign/get`,
 * `adgroup/get`, `ad/get`) in a creation window around the claim, under the parent the review froze, and looks for the
 * exact name. It finds the one created object, or proves its absence, or says it cannot tell. Reads only.
 *
 * The provider facts are TikTok's documented list reads (the captured DESCRIBE_ACTION of tiktok_campaign_get): filtering by
 * creation_filter_start_time and creation_filter_end_time, "in the format of YYYY-MM-DD HH:MM:SS (UTC time zone)", and
 * `fields` to narrow the answer; the name filter is fuzzy, so the lookup lists the window and compares names itself.
 */
before(() => {
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
});
after(() => {
  delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
  delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
});

const compiler = new Compiler(new Registry()),
  options = {mode: 'strict', flags: {}};
const compile = (action, payload) =>
  applyExecutionRisk(compiler.compile(gateway, {action, account_id: '123', payload, dry_run: true}, options));
const create = (kind, edit = p => p) => {
  const {action, payload} = standardBodies('123')[kind];
  return compile(action, edit(structuredClone(payload)));
};
const claimed = Date.parse('2026-10-10T10:00:00Z');

test('each standard TikTok create has a lookup that lists the advertiser by creation window and parent, with reads only', () => {
  // The claim window (two minutes before to fifteen after) widened by the longest zone offset, 14 hours, on each side.
  const window = {creation_filter_start_time: '2026-10-09 19:58:00', creation_filter_end_time: '2026-10-11 00:15:00'};
  const expected = {
    campaign: {
      path: '/v1.3/campaign/get/',
      // R2.5 M4, r25-m4-smartops fix round (the lead's review, S2-1): the list returns Upgraded Smart+ campaigns too, so the lookup asks for
      // their campaign_automation_type (TikTok returns a field only when `fields` names it) and compares it.
      fields: [
        'campaign_id',
        'campaign_name',
        'objective_type',
        'budget_mode',
        'budget',
        'operation_status',
        'campaign_automation_type',
        'create_time',
      ],
      filtering: window,
    },
    adgroup: {
      path: '/v1.3/adgroup/get/',
      fields: [
        'adgroup_id',
        'adgroup_name',
        'campaign_id',
        'budget_mode',
        'budget',
        'optimization_goal',
        'billing_event',
        'bid_type',
        'operation_status',
        'create_time',
      ],
      filtering: {campaign_ids: ['300'], ...window},
    },
    ad: {
      path: '/v1.3/ad/get/',
      fields: ['ad_id', 'ad_name', 'adgroup_id', 'ad_format', 'operation_status', 'create_time'],
      filtering: {adgroup_ids: ['200'], ...window},
    },
  };
  for (const [kind, want] of Object.entries(expected)) {
    const lookup = findCreated(create(kind), {state: [], claimedAt: claimed});
    assert.ok(lookup, 'a standard ' + kind + ' create has a lookup');
    assert.equal(lookup.reads.length, 1, kind);
    const [read] = lookup.reads;
    assert.deepEqual(
      [read.method, read.path, read.readOnly, read.action],
      ['GET', want.path, true, 'tiktok_' + kind + '_get'],
    );
    assert.deepEqual(read.query, {
      advertiser_id: '123',
      fields: want.fields,
      filtering: want.filtering,
      page_size: 100,
    });
    assert.equal(read.body, undefined, 'a list read carries no body');
  }
});

// R2.5 M4 (r25-m4-smartops): the Upgraded Smart+ creates have a lookup of their own now (tests/tiktok-smart-plus-reconcile.test.mjs), so
// this title no longer lists Smart+ among the writes without a read contract; the assertions are unchanged.
test('a TikTok write that is no create has no lookup: updates and status changes stay without a read contract', () => {
  const status = compile('tiktok_campaign_status_update', {
    advertiser_id: '123',
    campaign_ids: ['300'],
    operation_status: 'DISABLE',
  });
  assert.equal(findCreated(status, {state: [], claimedAt: claimed}), undefined);
  const update = compile('tiktok_campaign_update', {
    advertiser_id: '123',
    campaign_id: '300',
    campaign_name: 'Renamed',
  });
  assert.equal(findCreated(update, {state: [], claimedAt: claimed}), undefined);
  // A create whose name was never frozen cannot be looked up by name.
  const unnamed = create('campaign');
  delete unnamed.body.campaign_name;
  assert.equal(findCreated(unnamed, {state: [], claimedAt: claimed}), undefined);
});

/** TikTok's list answer, with its page counts. */
const listed = (list, page = {}) => [
  {
    status: 200,
    data: {
      code: 0,
      message: 'OK',
      request_id: 'synthetic',
      data: {list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1, ...page}},
    },
  },
];
/** The receipt a lookup gives for the one row it found. */
const receiptOf = (lookup, row) => lookup.receipt(lookup.match(listed([row]), claimed).found);
const campaign = (id, name, create_time) => ({
  campaign_id: id,
  campaign_name: name,
  ...(create_time ? {create_time} : {}),
});

test('the match takes the one object of that name created in the window, and never guesses at an older, a shifted or an undated one', () => {
  const lookup = findCreated(create('campaign'), {state: [], claimedAt: claimed});
  assert.ok(lookup, 'a standard TikTok campaign create has a lookup');
  const name = 'Synthetic campaign';
  const outcome = (list, page) => {
    const m = lookup.match(listed(list, page), claimed);
    return {
      found: m.found.map(f => f.id),
      undated: (m.undated ?? []).map(u => u.id),
      complete: m.complete,
      expected: m.expected,
    };
  };
  // Created five seconds after the claim: the one match, at index 0.
  assert.deepEqual(outcome([campaign('401', name, '2026-10-10 10:00:05')]), {
    found: ['401'],
    undated: [],
    complete: true,
    expected: 1,
  });
  const m = lookup.match(listed([campaign('401', name, '2026-10-10 10:00:05')]), claimed);
  assert.equal(m.found[0].index, 0);
  assert.deepEqual(lookup.receipt(m.found), {code: 0, message: 'OK', data: {campaign_id: '401'}});
  // The same name a week earlier is another campaign: nothing was created, and the list is complete.
  assert.deepEqual(outcome([campaign('399', name, '2026-10-03 10:00:00')]), {
    found: [],
    undated: [],
    complete: true,
    expected: 1,
  });
  // A neighbour of the fuzzy name filter is no match; nor is a campaign created long after the window.
  assert.deepEqual(
    outcome([campaign('402', name + ' 2', '2026-10-10 10:00:06'), campaign('403', name, '2026-10-20 10:00:00')]),
    {
      found: [],
      undated: [],
      complete: true,
      expected: 1,
    },
  );
  // Two of that name in the window: both are shown and neither is picked (ambiguous, so never applied).
  assert.deepEqual(
    outcome([campaign('401', name, '2026-10-10 10:00:05'), campaign('405', name, '2026-10-10 10:07:00')]).found,
    ['401', '405'],
  );
  // A creation time three hours off the window may be TikTok writing the advertiser's own time zone, which the documentation
  // does not rule out for a response: the object cannot be told from an older one, so it is neither found nor absent.
  assert.deepEqual(outcome([campaign('406', name, '2026-10-10 13:00:05')]), {
    found: [],
    undated: ['406'],
    complete: true,
    expected: 1,
  });
  // No usable creation time at all: the same.
  assert.deepEqual(outcome([campaign('407', name)]).undated, ['407']);
  assert.deepEqual(outcome([campaign('408', name, 'yesterday')]).undated, ['408']);
  // More than one page of the window, or page counts missing: the list is not complete, so absence is never claimed.
  assert.equal(
    outcome([campaign('401', name, '2026-10-10 10:00:05')], {total_page: 2, total_number: 130}).complete,
    false,
  );
  // Each count alone is enough: a second page with the total of the first, and a total beyond what the page holds.
  assert.equal(
    outcome([campaign('401', name, '2026-10-10 10:00:05')], {total_page: 2, total_number: 1}).complete,
    false,
  );
  assert.equal(
    outcome([campaign('401', name, '2026-10-10 10:00:05')], {total_page: 1, total_number: 130}).complete,
    false,
  );
  assert.equal(
    outcome([campaign('401', name, '2026-10-10 10:00:05')], {total_page: 1, total_number: 1}).complete,
    true,
  );
  assert.equal(
    lookup.match([{status: 200, data: {code: 0, data: {list: []}}}], claimed).complete,
    false,
    'an answer without page_info settles nothing',
  );
});

test('the parent frozen by the review decides: the same name under another campaign or ad group is not this write’s', () => {
  const group = findCreated(create('adgroup'), {state: [], claimedAt: claimed});
  assert.ok(group, 'a standard TikTok ad group create has a lookup');
  const row = (id, parent) => ({
    adgroup_id: id,
    adgroup_name: 'Synthetic ad group',
    campaign_id: parent,
    create_time: '2026-10-10 10:00:05',
  });
  assert.deepEqual(
    group.match(listed([row('201', '300'), row('202', '999')]), claimed).found.map(f => f.id),
    ['201'],
  );
  assert.deepEqual(group.match(listed([row('202', '999')]), claimed).found, []);
  const ad = findCreated(create('ad'), {state: [], claimedAt: claimed}),
    adRow = (id, parent) => ({
      ad_id: id,
      ad_name: 'Synthetic ad',
      adgroup_id: parent,
      create_time: '2026-10-10 10:00:05',
    });
  assert.deepEqual(
    ad.match(listed([adRow('101', '200'), adRow('102', '888')]), claimed).found.map(f => f.id),
    ['101'],
  );
  assert.deepEqual(receiptOf(ad, adRow('101', '200')), {code: 0, message: 'OK', data: {ad_ids: ['101']}});
  assert.deepEqual(receiptOf(group, row('201', '300')), {code: 0, message: 'OK', data: {adgroup_id: '201'}});
});

// R2.5 M4, r25-m4-smartops fix round (the lead's review, S2-1): TikTok's standard campaign list returns Upgraded Smart+ campaigns as well, with
// campaign_automation_type (MANUAL, SMART_PLUS or UPGRADED_SMART_PLUS: "Get campaigns", DOCS-EVIDENCE row 7; the lead's live read of
// 2026-11-21). A lost classic create is MANUAL: a same-name row of another type is another object, a doubt; a MANUAL row, or one that says
// nothing of its type, is compared as before.
test('a lost classic campaign create is never settled on a same-name Smart+ campaign: a typed Smart+ row is a doubt, a MANUAL one matches', () => {
  const lookup = findCreated(create('campaign'), {state: [], claimedAt: claimed});
  const name = 'Synthetic campaign';
  for (const type of ['UPGRADED_SMART_PLUS', 'SMART_PLUS']) {
    const m = lookup.match(
      listed([{...campaign('555', name, '2026-10-10 10:00:05'), campaign_automation_type: type}]),
      claimed,
    );
    assert.deepEqual([m.found.map(f => f.id), (m.undated ?? []).map(u => u.id), m.complete], [[], ['555'], true], type);
  }
  for (const type of ['MANUAL', undefined]) {
    const row = {...campaign('556', name, '2026-10-10 10:00:05'), ...(type ? {campaign_automation_type: type} : {})};
    assert.deepEqual(
      lookup.match(listed([row]), claimed).found.map(f => f.id),
      ['556'],
      String(type),
    );
  }
});

test('reconcile: a lost classic create that TikTok never applied, beside a same-name Smart+ campaign made in the window, is not offered that campaign', async () => {
  const f = tiktokReconcileFixture();
  try {
    const {id} = await f.lose('campaign', {applied: false});
    // An Upgraded Smart+ campaign of the same name and echoes, made a few seconds after the claim (by a Smart+ pack under the same name).
    f.rows.campaign.push({
      campaign_id: '555',
      advertiser_id: f.world.id,
      campaign_name: 'Synthetic campaign',
      objective_type: 'TRAFFIC',
      budget_mode: 'BUDGET_MODE_INFINITE',
      operation_status: 'DISABLE',
      campaign_automation_type: 'UPGRADED_SMART_PLUS',
      create_time: stamp(Date.now() + 5000),
    });
    const r = await f.call('amcp_write', {action: 'reconcile', review_id: id});
    assert.equal(r.data.classification, 'indeterminate', JSON.stringify(r.data));
    assert.deepEqual(
      r.data.undated.map(u => u.id),
      ['555'],
    );
    assert.equal(r.data.observed_ids, undefined, 'nothing is offered for acceptance');
    // The lookup asked TikTok for the type: without it in `fields`, TikTok's narrowed rows would never carry it.
    assert.ok(f.filters.at(-1).fields.includes('campaign_automation_type'), JSON.stringify(f.filters.at(-1)));
  } finally {
    f.close();
  }
  // The control: the classic campaign it made, which TikTok's row types MANUAL, still settles the lost create.
  const g = tiktokReconcileFixture();
  try {
    const {id} = await g.lose('campaign', {applied: true});
    for (const row of g.rows.campaign) if (row.campaign_id === '400') row.campaign_automation_type = 'MANUAL';
    const r = await g.call('amcp_write', {action: 'reconcile', review_id: id});
    assert.equal(r.data.classification, 'appears_applied', JSON.stringify(r.data));
    assert.deepEqual(r.data.observed_ids, ['400']);
  } finally {
    g.close();
  }
});

for (const kind of ['campaign', 'adgroup', 'ad']) {
  test(
    'a lost ' +
      kind +
      ' create that TikTok applied is found by reconcile, which sends nothing; accepting records its receipt',
    async () => {
      const f = tiktokReconcileFixture();
      try {
        const {id, refused} = await f.lose(kind, {applied: true});
        assert.equal(refused.error.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(refused).slice(0, 300));
        assert.equal(f.claim(id).state, 'uncertain');
        const writes = f.sent.length,
          before = f.requests.length;
        const r = await f.call('amcp_write', {action: 'reconcile', review_id: id});
        assert.equal(r.success, true, JSON.stringify(r).slice(0, 600));
        assert.equal(r.data.contract, 'create', 'no longer no_read_contract');
        assert.equal(r.data.classification, 'appears_applied', JSON.stringify(r.data));
        assert.equal(r.data.reason, 'created_found');
        assert.equal(r.data.mutation_requests, 0);
        assert.deepEqual(r.data.observed_ids, ['400']);
        // Zero POSTs: every request the reconciliation made is a GET, and nothing was written.
        const seen = f.requests.slice(before);
        assert.ok(seen.length > 0 && seen.every(request => request.startsWith('GET ')), seen.join(', '));
        assert.equal(f.sent.length, writes);
        assert.equal(f.claim(id).state, 'uncertain', 'reconcile never settles the outcome itself');
        const accepted = await f.call('amcp_write', {
          action: 'reconcile',
          review_id: id,
          accept_applied: true,
          reconciliation_id: r.data.reconciliation_id,
        });
        assert.equal(accepted.success, true, JSON.stringify(accepted).slice(0, 600));
        assert.equal(f.claim(id).state, 'complete');
        // The receipt has the shape of TikTok's own answer, so a plan step reads {$ref: "step#/data/data/<id>"} from it.
        const replay = await f.execute(id);
        assert.equal(replay.data.replayed, true);
        assert.deepEqual(replay.data.data, {
          code: 0,
          message: 'OK',
          data: kind === 'ad' ? {ad_ids: ['400']} : {[kind + '_id']: '400'},
        });
        assert.equal(f.sent.length, writes, 'execute replays the receipt and sends nothing');
      } finally {
        f.close();
      }
    },
  );

  test(
    'a lost ' + kind + ' create that TikTok never applied appears not applied, whatever else of that name exists',
    async () => {
      const f = tiktokReconcileFixture();
      try {
        // An older object of the same name and parent is not this write's.
        const name = {campaign: 'Synthetic campaign', adgroup: 'Synthetic ad group', ad: 'Synthetic ad'}[kind];
        const parent = {adgroup: {campaign_id: '300'}, ad: {adgroup_id: '200'}}[kind] ?? {};
        f.rows[kind].push({
          [kind + '_id']: '77',
          advertiser_id: f.world.id,
          [kind === 'ad' ? 'ad_name' : kind + '_name']: name,
          ...parent,
          create_time: '2026-09-01 08:00:00',
        });
        const {id, refused} = await f.lose(kind, {applied: false});
        assert.equal(refused.error.code, 'WRITE_OUTCOME_UNCERTAIN');
        const r = await f.call('amcp_write', {action: 'reconcile', review_id: id});
        assert.equal(r.data.classification, 'appears_not_applied', JSON.stringify(r.data));
        assert.equal(r.data.reason, 'not_found');
        assert.equal(r.data.next_call.arguments.supersedes_review_id, id, 'a new review is the person’s call');
        assert.equal(f.sent.length, 1, 'sent once');
      } finally {
        f.close();
      }
    },
  );
}

test('two objects of that name in the window are shown and not guessed at; an undated one of that name settles nothing', async () => {
  const f = tiktokReconcileFixture();
  try {
    const {id} = await f.lose('campaign', {applied: true});
    // Someone else made a campaign of the same name a few minutes later.
    f.rows.campaign.push({
      campaign_id: '500',
      advertiser_id: f.world.id,
      campaign_name: 'Synthetic campaign',
      create_time: stamp(Date.now() + 60000),
    });
    const r = await f.call('amcp_write', {action: 'reconcile', review_id: id});
    assert.equal(r.data.classification, 'indeterminate');
    assert.equal(r.data.reason, 'ambiguous');
    assert.deepEqual(r.data.found.map(row => row.id).sort(), ['400', '500']);
    assert.equal(r.data.observed_ids, undefined, 'nothing is offered for acceptance');

    const g = tiktokReconcileFixture();
    try {
      const lost = await g.lose('campaign', {applied: false});
      // TikTok's window includes it, but its answer shows no creation time.
      g.rows.campaign.push({
        campaign_id: '77',
        advertiser_id: g.world.id,
        campaign_name: 'Synthetic campaign',
        _created: stamp(Date.now()),
      });
      const u = await g.call('amcp_write', {action: 'reconcile', review_id: lost.id});
      assert.equal(u.data.classification, 'indeterminate');
      assert.equal(u.data.reason, 'undated_match');
    } finally {
      g.close();
    }
  } finally {
    f.close();
  }
});

test('the worker’s automatic check finds a lost TikTok create too', async () => {
  const f = tiktokReconcileFixture();
  try {
    const {id} = await f.lose('adgroup', {applied: true});
    f.store.db.prepare("UPDATE jobs SET available_at=0 WHERE kind='write_reconcile' AND state='queued'").run();
    assert.equal(await f.worker.once(), true);
    const s = await f.call('amcp_write', {action: 'status', review_id: id});
    assert.equal(s.data.reconciliation.classification, 'appears_applied', JSON.stringify(s.data.reconciliation));
    assert.equal(s.data.reconciliation.automatic, true);
    assert.deepEqual(s.data.reconciliation.observed_ids, ['400']);
  } finally {
    f.close();
  }
});

// L1-15 (R2.5 M2): TikTok's throttle codes (40100, 40132, 40133) on a write. A rate limit never proves by itself that nothing was
// applied, so the write stays uncertain and is not sent again; what classifies it is the reads that this package adds: the check finds
// that TikTok created nothing, which does not settle the claim (it stays uncertain until the person replaces it or accepts it), offers
// the replacement as a new review (the person's call), and the replacement is sent once.
for (const code of [40100, 40132, 40133])
  test(
    'a TikTok create throttled with code ' + code + ' stays uncertain and its check classifies it as not applied',
    async () => {
      const f = tiktokReconcileFixture();
      try {
        f.state.throttle = code;
        const prepared = await f.prepare('campaign');
        assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 400));
        const id = prepared.data.review_id,
          refused = await f.execute(id);
        f.state.throttle = undefined;
        assert.equal(refused.error?.code, 'PLATFORM_RATE_LIMIT', JSON.stringify(refused).slice(0, 300));
        assert.equal(
          f.claim(id).state,
          'uncertain',
          'a rate limit is no proof of a refusal: never rejected, never retried',
        );
        assert.equal(f.sent.length, 1, 'the throttled request was sent once');
        // The worker's check (the job of this package) reads the campaign list and finds nothing created.
        f.store.db.prepare("UPDATE jobs SET available_at=0 WHERE kind='write_reconcile' AND state='queued'").run();
        assert.equal(await f.worker.once(), true);
        const s = await f.call('amcp_write', {action: 'status', review_id: id});
        assert.equal(
          s.data.reconciliation.classification,
          'appears_not_applied',
          JSON.stringify(s.data.reconciliation),
        );
        assert.equal(s.data.reconciliation.automatic, true);
        assert.equal(s.data.next_call.arguments.supersedes_review_id, id, 'the replacement is offered, not made');
        assert.equal(f.sent.length, 1, 'the check sent nothing');
        // The person takes the offered call; the replacement goes through and is sent once.
        const replacement = await f.call('amcp_write', s.data.next_call.arguments);
        assert.equal(replacement.success, true, JSON.stringify(replacement).slice(0, 500));
        const done = await f.execute(replacement.data.review_id);
        assert.equal(done.success, true, JSON.stringify(done).slice(0, 500));
        assert.equal(f.sent.length, 2, 'the throttled create and its replacement, each sent once');
        assert.equal(
          (await f.execute(id)).error?.code,
          'WRITE_OUTCOME_UNCERTAIN',
          'the throttled review is never sent again',
        );
        assert.equal(f.sent.length, 2);
      } finally {
        f.close();
      }
    },
  );
