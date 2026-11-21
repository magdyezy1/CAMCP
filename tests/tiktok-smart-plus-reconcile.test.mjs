import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {findCreated} from '../dist/src/write-reconciliation.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {
  gateway,
  parentAdgroup,
  parentCampaign,
  smartPlusBodies,
  smartPlusReconcileFixture,
  stamp,
} from './helpers/tiktok-smart-plus-reconcile-fixture.mjs';

/**
 * R2.5 M4, package r25-m4-smartops, item 1: a lost Upgraded Smart+ create is settled as a standard one is (M2, L1-07). The standard
 * campaign, ad group and ad creates had a lookup; the Smart+ creates had none, so `reconcile` answered `no_read_contract`, and the guard
 * against creating twice held an identical create back with no way on but TikTok's UI. After 2027-01-01 every new TikTok website build
 * runs on Smart+ (r25-m4-smartweb), so a lost answer there held a plan step for good.
 *
 * Each Smart+ create now reads the advertiser's own Smart+ list (TikTok's "Get Upgraded Smart+ Campaigns", "... Ad Groups", "... Ads"),
 * under the parent the review froze, and compares the exact name, the creation time and the fields TikTok echoes, by every rule of the
 * standard lookup. The provider facts are the captured DESCRIBE_ACTION of those reads (.mirror/CATALOG/tiktok_native_action.json): the
 * campaign and ad lists take `creation_filter_start_time` and `creation_filter_end_time`, the ad group list takes no creation filter at
 * all, so it lists the campaign's ad groups and its match dates each row by `create_time` alone. Whether a Smart+ row carries
 * `create_time`, and the zone and format of the Smart+ filters, are unverified until the live check M4 LV-25: a row without a time is
 * `undated` (never found, never proof of absence), and the 14-hour widening keeps a filter applied in another zone safe. Reads only.
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
  const {action, payload} = smartPlusBodies('123')[kind];
  return compile(action, edit(structuredClone(payload)));
};
const claimed = Date.parse('2026-10-10T10:00:00Z');
const kinds = ['campaign', 'adgroup', 'ad'];
const idOf = {campaign: 'campaign_id', adgroup: 'adgroup_id', ad: 'smart_plus_ad_id'};
const nameOf = {campaign: 'campaign_name', adgroup: 'adgroup_name', ad: 'ad_name'};
const nameFor = {
  campaign: 'Synthetic Smart+ campaign',
  adgroup: 'Synthetic Smart+ ad group',
  ad: 'Synthetic Smart+ ad',
};
const parentOf = {campaign: {}, adgroup: {campaign_id: parentCampaign}, ad: {adgroup_id: parentAdgroup}};

test('each Smart+ create has a lookup of its own Smart+ list, under its frozen parent, with reads only', () => {
  // The claim window (two minutes before to fifteen after) widened by the longest zone offset, 14 hours, on each side.
  const window = {creation_filter_start_time: '2026-10-09 19:58:00', creation_filter_end_time: '2026-10-11 00:15:00'};
  const expected = {
    campaign: {path: '/v1.3/smart_plus/campaign/get/', filtering: window},
    // The Smart+ ad group list takes no creation filter: the campaign's ad groups are listed, and the match dates each one.
    adgroup: {path: '/v1.3/smart_plus/adgroup/get/', filtering: {campaign_ids: [parentCampaign]}},
    ad: {path: '/v1.3/smart_plus/ad/get/', filtering: {adgroup_ids: [parentAdgroup], ...window}},
  };
  for (const [kind, want] of Object.entries(expected)) {
    const lookup = findCreated(create(kind), {state: [], claimedAt: claimed});
    assert.ok(lookup, 'a Smart+ ' + kind + ' create has a lookup');
    assert.equal(lookup.reads.length, 1, kind);
    const [read] = lookup.reads;
    assert.deepEqual(
      [read.method, read.path, read.readOnly, read.action],
      ['GET', want.path, true, 'tiktok_smart_plus_' + kind + '_get'],
    );
    // No `fields`: the names a Smart+ list takes there are not captured (LV-25), and a name it refused would fail every lookup.
    assert.deepEqual(read.query, {advertiser_id: '123', filtering: want.filtering, page_size: 100}, kind);
    assert.equal(read.body, undefined, 'a list read carries no body');
    assert.equal(lookup.keys.length, 1, kind);
  }
});

test('a Smart+ write that is no create has no lookup; a create whose name or parent was not frozen has none either', () => {
  const status = compile('tiktok_smart_plus_campaign_status_update', {
    advertiser_id: '123',
    campaign_ids: [parentCampaign],
    operation_status: 'DISABLE',
  });
  assert.equal(findCreated(status, {state: [], claimedAt: claimed}), undefined);
  for (const kind of kinds) {
    const unnamed = create(kind);
    delete unnamed.body[nameOf[kind]];
    assert.equal(findCreated(unnamed, {state: [], claimedAt: claimed}), undefined, kind + ' without a name');
  }
  const orphan = create('adgroup');
  orphan.body.campaign_id = 'not-a-number';
  assert.equal(findCreated(orphan, {state: [], claimedAt: claimed}), undefined, 'an ad group without a numeric parent');
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
const row = (kind, id, create_time, extra = {}) => ({
  [idOf[kind]]: id,
  [nameOf[kind]]: nameFor[kind],
  ...parentOf[kind],
  ...(create_time ? {create_time} : {}),
  ...extra,
});

for (const kind of kinds)
  test(
    'the ' + kind + ' match takes the one object of that name and parent made in the window, and never guesses',
    () => {
      const lookup = findCreated(create(kind), {state: [], claimedAt: claimed});
      const outcome = (list, page) => {
        const m = lookup.match(listed(list, page), claimed);
        return {found: m.found.map(f => f.id), undated: (m.undated ?? []).map(u => u.id), complete: m.complete};
      };
      // Created five seconds after the claim: the one match, and the receipt in the shape of TikTok's own answer.
      assert.deepEqual(outcome([row(kind, '401', '2026-10-10 10:00:05')]), {
        found: ['401'],
        undated: [],
        complete: true,
      });
      const m = lookup.match(listed([row(kind, '401', '2026-10-10 10:00:05')]), claimed);
      assert.deepEqual(lookup.receipt(m.found), {code: 0, message: 'OK', data: {[idOf[kind]]: '401'}});
      // The same name a week earlier is another object: nothing was created, and the list is complete.
      assert.deepEqual(outcome([row(kind, '399', '2026-10-03 10:00:00')]), {found: [], undated: [], complete: true});
      // A neighbour's name is no match.
      assert.deepEqual(
        outcome([row(kind, '402', '2026-10-10 10:00:06', {[nameOf[kind]]: nameFor[kind] + ' 2'})]).found,
        [],
      );
      // Two of that name in the window: both shown, neither picked.
      assert.deepEqual(
        outcome([row(kind, '401', '2026-10-10 10:00:05'), row(kind, '405', '2026-10-10 10:07:00')]).found,
        ['401', '405'],
      );
      // A time three hours off the window may be another zone's; no time at all, or an unreadable one: undated, never found.
      assert.deepEqual(outcome([row(kind, '406', '2026-10-10 13:00:05')]), {
        found: [],
        undated: ['406'],
        complete: true,
      });
      assert.deepEqual(outcome([row(kind, '407')]).undated, ['407']);
      assert.deepEqual(outcome([row(kind, '408', 'yesterday')]).undated, ['408']);
      // The same name under another parent is not this write's (the campaign has none).
      if (kind !== 'campaign') {
        const other = kind === 'adgroup' ? {campaign_id: '81'} : {adgroup_id: '301'};
        assert.deepEqual(outcome([row(kind, '409', '2026-10-10 10:00:05', other)]).found, []);
      }
      // The same name and parent that differs in a field TikTok echoes is another object: a doubt.
      const echoed = {
        campaign: {objective_type: 'LEAD_GENERATION'},
        adgroup: {optimization_goal: 'CONVERT'},
        ad: {operation_status: 'ENABLE'},
      }[kind];
      assert.deepEqual(outcome([row(kind, '410', '2026-10-10 10:00:05', echoed)]), {
        found: [],
        undated: ['410'],
        complete: true,
      });
      // A list cut at its page cap, or one that says nothing of its pages, proves nothing absent.
      assert.equal(
        outcome([row(kind, '401', '2026-10-10 10:00:05')], {total_page: 2, total_number: 130}).complete,
        false,
      );
      assert.equal(lookup.match([{status: 200, data: {code: 0, data: {list: []}}}], claimed).complete, false);
    },
  );

test('the echoes of each Smart+ kind are the ones TikTok returns of its create', () => {
  // A row that echoes every field the review froze, with the values it froze, is this write's.
  const echoes = {
    campaign: {
      objective_type: 'WEB_CONVERSIONS',
      budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
      operation_status: 'DISABLE',
    },
    adgroup: {
      optimization_goal: 'CLICK',
      billing_event: 'CPC',
      bid_type: 'BID_TYPE_NO_BID',
      operation_status: 'DISABLE',
    },
    ad: {operation_status: 'DISABLE'},
  };
  for (const kind of kinds) {
    const lookup = findCreated(create(kind), {state: [], claimedAt: claimed});
    const agreeing = lookup.match(listed([row(kind, '401', '2026-10-10 10:00:05', echoes[kind])]), claimed);
    assert.deepEqual(
      agreeing.found.map(f => f.id),
      ['401'],
      kind,
    );
    for (const [field, value] of Object.entries(echoes[kind])) {
      const differing = lookup.match(
        listed([row(kind, '402', '2026-10-10 10:00:05', {...echoes[kind], [field]: value + '_OTHER'})]),
        claimed,
      );
      assert.deepEqual(
        [differing.found.length, (differing.undated ?? []).map(u => u.id)],
        [0, ['402']],
        kind + ' ' + field,
      );
    }
  }
  // A Smart+ campaign row that says it is another kind of campaign (a manual one) is not this write's, however alike.
  const campaign = findCreated(create('campaign'), {state: [], claimedAt: claimed});
  for (const type of ['MANUAL', 'SMART_PLUS']) {
    const m = campaign.match(
      listed([row('campaign', '403', '2026-10-10 10:00:05', {...echoes.campaign, campaign_automation_type: type})]),
      claimed,
    );
    assert.deepEqual([m.found.length, (m.undated ?? []).map(u => u.id)], [0, ['403']], type);
  }
  const upgraded = campaign.match(
    listed([
      row('campaign', '404', '2026-10-10 10:00:05', {
        ...echoes.campaign,
        campaign_automation_type: 'UPGRADED_SMART_PLUS',
      }),
    ]),
    claimed,
  );
  assert.deepEqual(
    upgraded.found.map(f => f.id),
    ['404'],
  );
});

for (const kind of kinds) {
  test(
    'a lost Smart+ ' +
      kind +
      ' create that TikTok applied is found by reconcile, which sends nothing; accepting records its receipt',
    async () => {
      const f = smartPlusReconcileFixture();
      try {
        const {id, refused} = await f.lose(kind, {applied: true});
        assertRefused(refused, 'WRITE_OUTCOME_UNCERTAIN');
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
        // Zero POSTs: every request the reconciliation made is a GET of the kind's own Smart+ list, and nothing was written.
        const seen = f.requests.slice(before);
        assert.deepEqual([...new Set(seen)], ['GET /v1.3/smart_plus/' + kind + '/get/'], seen.join(', '));
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
        assert.deepEqual(replay.data.data, {code: 0, message: 'OK', data: {[idOf[kind]]: '400'}});
        assert.equal(f.sent.length, writes, 'execute replays the receipt and sends nothing');
      } finally {
        f.close();
      }
    },
  );

  test(
    'a lost Smart+ ' +
      kind +
      ' create that TikTok never applied appears not applied, whatever older object of that name exists',
    async () => {
      const f = smartPlusReconcileFixture();
      try {
        f.rows[kind].push({...row(kind, '77', '2026-09-01 08:00:00'), operation_status: 'DISABLE'});
        const {id, refused} = await f.lose(kind, {applied: false});
        assertRefused(refused, 'WRITE_OUTCOME_UNCERTAIN');
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

test('two Smart+ objects of that name are shown and not guessed at; one that differs in an echoed field is a doubt', async () => {
  const f = smartPlusReconcileFixture();
  try {
    const {id} = await f.lose('adgroup', {applied: true});
    // Someone else made an ad group of the same name in the same campaign a minute later.
    f.rows.adgroup.push({...row('adgroup', '500', stamp(Date.now() + 60000)), optimization_goal: 'CLICK'});
    const r = await f.call('amcp_write', {action: 'reconcile', review_id: id});
    assert.equal(r.data.classification, 'indeterminate');
    assert.equal(r.data.reason, 'ambiguous');
    assert.deepEqual(r.data.found.map(found => found.id).sort(), ['400', '500']);
    assert.equal(r.data.observed_ids, undefined, 'nothing is offered for acceptance');
  } finally {
    f.close();
  }
  const g = smartPlusReconcileFixture();
  try {
    const {id} = await g.lose('campaign', {applied: false});
    // The same name in the window, but another objective: another campaign, shown as a doubt, never this write's or its absence.
    g.rows.campaign.push({
      ...row('campaign', '501', stamp(Date.now())),
      objective_type: 'LEAD_GENERATION',
      operation_status: 'DISABLE',
    });
    const r = await g.call('amcp_write', {action: 'reconcile', review_id: id});
    assert.equal(r.data.classification, 'indeterminate', JSON.stringify(r.data));
    assert.deepEqual(
      r.data.undated.map(u => u.id),
      ['501'],
    );
  } finally {
    g.close();
  }
});

test('a Smart+ ad group row with no create_time is undated: it settles nothing, applied or not', async () => {
  for (const applied of [true, false]) {
    const f = smartPlusReconcileFixture();
    try {
      // TikTok made the ad group (or another of the same name) but its row shows no creation time: it cannot be told from an older one.
      f.state.undated = true;
      const {id} = await f.lose('adgroup', {applied: true});
      if (!applied) f.rows.adgroup.find(r => r.adgroup_id === '400').adgroup_id = '77';
      const r = await f.call('amcp_write', {action: 'reconcile', review_id: id});
      assert.equal(r.data.classification, 'indeterminate', JSON.stringify(r.data));
      assert.equal(r.data.reason, 'undated_match');
      assert.equal(r.data.observed_ids, undefined);
      assert.equal(f.sent.length, 1);
    } finally {
      f.close();
    }
  }
});

test('a Smart+ list longer than the pages a check reads is not whole, so nothing is proven absent', async () => {
  const f = smartPlusReconcileFixture();
  try {
    // The campaign holds many older ad groups, and TikTok pages one row at a time: each of the check's two rounds reads its ten batches
    // and stops.
    for (let i = 0; i < 12; i++)
      f.rows.adgroup.push({...row('adgroup', String(600 + i), '2026-02-01 00:00:00'), adgroup_name: 'Older ' + i});
    f.state.pageSize = 1;
    const {id} = await f.lose('adgroup', {applied: false});
    const before = f.requests.length;
    const r = await f.call('amcp_write', {action: 'reconcile', review_id: id});
    assert.equal(r.data.classification, 'indeterminate', JSON.stringify(r.data));
    assert.equal(r.data.reason, 'lookup_incomplete');
    const pages = f.requests.slice(before);
    assert.equal(pages.length, 20, pages.join(', '));
    assert.ok(pages.every(p => p === 'GET /v1.3/smart_plus/adgroup/get/'));
    // Followed page by page: each round asked for pages 1 to 10, under the frozen campaign, with no creation filter.
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.deepEqual(
      f.filters.slice(-20).map(read => read.page),
      [...ten, ...ten],
    );
    assert.ok(f.filters.slice(-20).every(read => JSON.stringify(read.filtering) === '{"campaign_ids":["80"]}'));
  } finally {
    f.close();
  }
});

test('a Smart+ creation filter TikTok applies in another zone still finds the object, in the widened window', async () => {
  for (const kind of ['campaign', 'ad']) {
    const f = smartPlusReconcileFixture();
    try {
      // TikTok applies the filter in UTC+3 (the advertiser's), and writes create_time in UTC.
      f.state.filterZoneMs = 3 * 3600000;
      const {id} = await f.lose(kind, {applied: true});
      const r = await f.call('amcp_write', {action: 'reconcile', review_id: id});
      assert.equal(r.data.classification, 'appears_applied', kind + ': ' + JSON.stringify(r.data));
    } finally {
      f.close();
    }
  }
});

test('the guard against creating twice still holds an identical Smart+ create back while the first is uncertain, and now names reconcile', async () => {
  const f = smartPlusReconcileFixture();
  try {
    const {id} = await f.lose('campaign', {applied: true}),
      sentBefore = f.sent.length;
    // The same request, and the same request with another request_id (the key that differs between two prepares).
    for (const edit of [p => p, p => ({...p, request_id: '810200300599'})]) {
      const again = await f.prepare('campaign', edit);
      assertRefused(again, 'DUPLICATE_OF_UNCERTAIN_WRITE', {writes: () => f.sent.length - sentBefore});
      assert.equal(again.error.details.earlier_review_id, id);
      // Reconcile can settle it now: the refusal sends the agent there, not to TikTok's UI.
      assert.equal(again.error.details.earlier_checkable, true);
      assert.match(again.error.message, /reconcile it with read-only lookups/);
    }
    // A Smart+ ad group of the same name under the same campaign is the same object to its lookup, whatever else differs.
    const group = await f.lose('adgroup', {applied: true});
    const twin = await f.prepare('adgroup', p => ({...p, bid_type: 'BID_TYPE_CUSTOM', bid_price: 0.5}));
    assertRefused(twin, 'DUPLICATE_OF_UNCERTAIN_WRITE');
    assert.equal(twin.error.details.earlier_review_id, group.id);
    assert.equal(twin.error.details.earlier_match, 'same_object');
    // Settled as applied, the first create holds nothing back: an identical create prepares, with the warning of a completed twin.
    const found = await f.call('amcp_write', {action: 'reconcile', review_id: id});
    assert.equal(found.data.classification, 'appears_applied', JSON.stringify(found.data));
    const accepted = await f.call('amcp_write', {
      action: 'reconcile',
      review_id: id,
      accept_applied: true,
      reconciliation_id: found.data.reconciliation_id,
    });
    assert.equal(accepted.success, true, JSON.stringify(accepted).slice(0, 500));
    const after = await f.prepare('campaign');
    assert.equal(after.success, true, JSON.stringify(after).slice(0, 500));
    assert.equal(after.data.duplicate_warning?.earlier_review_id, id, JSON.stringify(after.data).slice(0, 500));
  } finally {
    f.close();
  }
});

test('a plan step whose Smart+ ad group create lost its answer goes on once the person accepts what reconcile found', async () => {
  const f = smartPlusReconcileFixture();
  const plan = input => f.call('amcp_campaign', input),
    step = (result, id) => result.data.steps.find(s => s.id === id);
  try {
    const bodies = smartPlusBodies(f.world.id),
      write = (id, description, body) => ({
        id,
        kind: 'write',
        gateway,
        connection_id: f.connection.id,
        account_id: f.world.id,
        description,
        arguments: body,
      });
    const created = await plan({
      action: 'create',
      name: 'Synthetic Smart+ build',
      brief: 'A paused Smart+ ad group and its ad.',
      steps: [
        write('group', 'Create the paused Smart+ ad group', bodies.adgroup),
        {
          ...write('ad', 'Create the paused Smart+ ad in it', {
            action: bodies.ad.action,
            payload: {...bodies.ad.payload, adgroup_id: {$ref: 'group#/data/data/adgroup_id'}},
          }),
          depends_on: ['group'],
        },
      ],
    });
    assert.equal(created.success, true, JSON.stringify(created).slice(0, 1200));
    const id = created.data.id,
      preview = await plan({action: 'approve', id}),
      approved = await plan({
        action: 'approve',
        id,
        confirmed: true,
        plan_hash: preview.data.plan_hash,
        summary_hash: preview.data.summary_hash,
      });
    assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 1200));
    assert.equal((await plan({action: 'preflight', id})).success, true);
    // TikTok makes the ad group, and its answer is lost: the step is uncertain and the plan stops; the ad is not sent.
    f.state.applied = true;
    f.state.lose = true;
    const lost = await plan({action: 'run', id});
    f.state.lose = false;
    f.state.applied = undefined;
    assert.equal(step(lost, 'group').status, 'uncertain', JSON.stringify(lost.data).slice(0, 1200));
    assert.equal(step(lost, 'ad').status, 'pending');
    assert.equal(f.sent.length, 1);
    // Reconcile finds it (reads only), the person accepts it, and reconcile_step reads it back from the receipt.
    assert.equal(lost.data.current.step_id, 'group');
    const review = lost.data.current.review_id,
      found = await f.call('amcp_write', {action: 'reconcile', review_id: review});
    assert.equal(found.data?.classification, 'appears_applied', JSON.stringify(found).slice(0, 1500));
    const accepted = await f.call('amcp_write', {
      action: 'reconcile',
      review_id: review,
      accept_applied: true,
      reconciliation_id: found.data.reconciliation_id,
    });
    assert.equal(accepted.success, true, JSON.stringify(accepted).slice(0, 600));
    const settled = await plan({action: 'reconcile_step', id, step_id: 'group'});
    assert.equal(settled.success, true, JSON.stringify(settled).slice(0, 1200));
    assert.equal(step(settled, 'group').status, 'verified', JSON.stringify(step(settled, 'group')).slice(0, 800));
    assert.equal(f.sent.length, 1, 'settling sent nothing');
    // The plan goes on: the ad is created once, in the ad group reconcile found.
    const done = await plan({action: 'run', id});
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 1200));
    assert.equal(step(done, 'ad').status, 'verified', JSON.stringify(step(done, 'ad')).slice(0, 800));
    assert.deepEqual(
      f.sent.map(s => s.path),
      ['/v1.3/smart_plus/adgroup/create/', '/v1.3/smart_plus/ad/create/'],
    );
    assert.equal(f.sent[1].body.adgroup_id, '400');
  } finally {
    f.close();
  }
});

test('the worker’s automatic check finds a lost Smart+ create too, and sends nothing', async () => {
  const f = smartPlusReconcileFixture();
  try {
    const {id} = await f.lose('ad', {applied: true});
    f.store.db.prepare("UPDATE jobs SET available_at=0 WHERE kind='write_reconcile' AND state='queued'").run();
    assert.equal(await f.worker.once(), true);
    const s = await f.call('amcp_write', {action: 'status', review_id: id});
    assert.equal(s.data.reconciliation.classification, 'appears_applied', JSON.stringify(s.data.reconciliation));
    assert.equal(s.data.reconciliation.automatic, true);
    assert.deepEqual(s.data.reconciliation.observed_ids, ['400']);
    assert.equal(f.sent.length, 1, 'the check sent nothing');
  } finally {
    f.close();
  }
});
