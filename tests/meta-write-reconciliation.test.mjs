import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {findCreated} from '../dist/src/write-reconciliation.js';
import {
  account,
  business,
  catalog,
  creates,
  gateway,
  metaReconcileFixture,
  metaTime,
} from './helpers/meta-reconcile-fixture.mjs';

/**
 * R2.5 M2 (L1-07 lookup part, L5-05): `reconcile` answered no_read_contract for a Meta catalog, product set, feed, creative
 * and audience create (only a campaign, ad set and ad create had a lookup), so a lost response left the person with nothing to
 * decide by. Each now has a created lookup, by the provider's list reads only:
 *  - a product set and a feed are looked up in their catalog by the frozen name, and counted only when the review did not see
 *    them (the review froze the catalog's sets and feeds, and Meta stamps neither with a creation time);
 *  - an audience carries a creation time (`time_created`), so it is looked up by name and the window around the claim;
 *  - a catalog and a creative carry no creation time and the review froze no list of them: one of that name is shown and never
 *    called created, and none of that name, in a whole list, proves the create absent.
 * A match must be unique: two are shown and never chosen between. The lists are read page by page.
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
const compile = (kind, edit = payload => payload) => {
  const [action, params, payload] = creates[kind];
  return applyExecutionRisk(
    compiler.compile(
      gateway,
      {
        action,
        account_id: account,
        ...(params ? {params} : {}),
        payload: edit(structuredClone(payload)),
        dry_run: true,
      },
      options,
    ),
  );
};
const claimed = Date.parse('2026-10-10T10:00:00Z'),
  context = (state = []) => ({state, claimedAt: claimed});
const lookupOf = (kind, state) => {
  const lookup = findCreated(compile(kind), context(state));
  assert.ok(lookup, 'a ' + kind + ' create has a lookup');
  return lookup;
};
const list = (rows, cursor) => ({
  status: 200,
  headers: {},
  data: {data: rows, ...(cursor ? {paging: {cursors: {after: cursor}, next: 'https://graph.facebook.com/next'}} : {})},
});
const ids = found => found.map(f => f.id);

// ----- the lists a lookup reads -----
const setFields = 'id,name,filter,retailer_id,product_catalog{id}';
const feedFields =
  'id,name,schedule,update_schedule,deletion_enabled,default_currency,country,delimiter,encoding,quoted_fields_mode,feed_type,ingestion_source_type,product_count';
const reads = {
  set: ['/v26.0/' + catalog + '/product_sets', {fields: setFields, limit: 100}],
  feed: ['/v26.0/' + catalog + '/product_feeds', {fields: feedFields, limit: 100}],
  catalog: ['/v26.0/' + business + '/owned_product_catalogs', {fields: 'id,name', limit: 100}],
  audience: [
    '/v26.0/act_' + account + '/customaudiences',
    {fields: 'id,account_id,name,time_created,subtype', limit: 100},
  ],
  creative: ['/v26.0/act_' + account + '/adcreatives', {fields: 'id,name,status', limit: 100}],
};
for (const [kind, [path, query]] of Object.entries(reads))
  test('the ' + kind + ' create is looked up by one list read of its provider: a GET of ' + path, () => {
    const lookup = lookupOf(kind, [{sets: [], feeds: []}]);
    assert.ok(lookup, 'a ' + kind + ' create has a lookup');
    assert.equal(lookup.reads.length, 1);
    const [read] = lookup.reads;
    assert.deepEqual(
      [read.method, read.path, read.readOnly, read.body, read.query],
      ['GET', path, true, undefined, query],
    );
  });

test('every read of every lookup is a bodiless GET of a read-only request, whatever the create', () => {
  for (const kind of ['set', 'feed', 'catalog', 'audience', 'creative', 'campaign']) {
    const lookup = lookupOf(kind, [{sets: [], feeds: []}]);
    assert.ok(lookup, kind + ' has a lookup');
    for (const read of lookup.reads)
      assert.deepEqual(
        [read.method, read.readOnly, read.destructive, read.body],
        ['GET', true, false, undefined],
        kind,
      );
  }
});

test('a create with no name has no lookup: there is nothing exact to look for', () => {
  for (const kind of ['set', 'feed', 'catalog', 'audience', 'creative'])
    assert.equal(
      findCreated(
        compile(kind, p => {
          delete p.name;
          return p;
        }),
        context(),
      ),
      undefined,
      kind,
    );
});

test('a list is followed page by page by the cursor Meta gives, and no further than it says', () => {
  const lookup = lookupOf('set', [{sets: []}]),
    [first] = lookup.reads;
  assert.equal(typeof lookup.more, 'function', 'a lookup that lists asks for the pages after the first');
  const next = lookup.more([list([], 'c1')]);
  assert.equal(next.length, 1);
  assert.deepEqual(
    [next[0].method, next[0].path, next[0].readOnly, next[0].query],
    ['GET', first.path, true, {...first.query, after: 'c1'}],
  );
  assert.deepEqual(lookup.more([list([], 'c1'), list([], 'c2')])[0].query.after, 'c2', 'after the last page read');
  assert.deepEqual(lookup.more([list([], 'c1'), list([])]), [], 'the last page says nothing follows');
  assert.deepEqual(lookup.more([{status: 200, headers: {}, data: {data: [], paging: {next: 'x'}}}]), [], 'no cursor');
});

// ----- product sets and feeds: new since the review froze the catalog's -----
const set = (id, name = 'Synthetic set', catalogId = catalog) => ({id, name, product_catalog: {id: catalogId}});
const frozenSets = {
  sets: [
    {id: '7001', name: 'Shoes'},
    {id: '7003', name: 'Synthetic set'},
  ],
};
test('a product set is created when it is of that name in that catalog and the review did not see it', () => {
  const lookup = lookupOf('set', [frozenSets]);
  const match = (...pages) =>
    lookup.match(
      pages.map(rows => list(rows)),
      claimed,
    );
  let m = match([set('7001', 'Shoes'), set('7100')]);
  assert.deepEqual(
    m.found.map(f => [f.index, f.id]),
    [[0, '7100']],
  );
  assert.equal(m.expected, 1);
  assert.equal(m.complete, true);
  assert.deepEqual(m.undated ?? [], []);
  assert.deepEqual(lookup.receipt(m.found), {id: '7100'}, 'the receipt Meta answers a create with');
  // The family refuses the name used with any case or spacing, so that is the name looked for.
  assert.deepEqual(ids(match([set('7100', '  SYNTHETIC Set ')]).found), ['7100']);
  // A set of that name the review already saw (7003) is not this write's; the new one is.
  assert.deepEqual(ids(match([set('7003'), set('7100')]).found), ['7100']);
  // Only a set the review saw: nothing was created, and the list was whole.
  m = match([set('7003')]);
  assert.deepEqual([m.found.length, m.complete, (m.undated ?? []).length], [0, true, 0]);
  // Two new sets of that name are both shown, never chosen between.
  m = match([set('7100'), set('7101')]);
  assert.deepEqual(ids(m.found).sort(), ['7100', '7101']);
  assert.equal(m.expected, 1);
  // A set of another catalog is not this write's.
  m = match([set('7100', 'Synthetic set', '556')]);
  assert.deepEqual([m.found.length, m.complete, (m.undated ?? []).length], [0, true, 0]);
  // Pages are read as one list.
  assert.deepEqual(ids(match([set('7001', 'Shoes')], [set('7100')]).found), ['7100']);
});

test('a set of that name that cannot be told from an older one is undated when the review kept no list, never created', () => {
  for (const state of [[], [{}], [{sets: 'none'}], [null]]) {
    const lookup = lookupOf('set', state),
      m = lookup.match([list([set('7100')])], claimed);
    assert.equal(m.found.length, 0, JSON.stringify(state));
    assert.deepEqual(ids(m.undated ?? []), ['7100'], JSON.stringify(state));
  }
});

test('a list Meta did not give whole, or did not give at all, proves nothing absent', () => {
  const lookup = lookupOf('set', [frozenSets]);
  assert.equal(lookup.match([list([set('7100')], 'c1')], claimed).complete, false, 'a page says more follows');
  assert.equal(lookup.match([list([], 'c1')], claimed).complete, false);
  const error = {status: 200, headers: {}, data: {error: {message: 'not a list'}}};
  assert.deepEqual([lookup.match([error], claimed).found.length, lookup.match([error], claimed).complete], [0, false]);
  assert.equal(lookup.match([list([]), error], claimed).complete, false, 'a bad page after a good one');
});

test('a product feed is created when it is of that name in that catalog and the review did not see it', () => {
  const frozen = {
      feeds: [
        {id: '6001', name: 'Existing feed'},
        {id: '6002', name: 'Synthetic feed'},
      ],
    },
    lookup = lookupOf('feed', [frozen]),
    feed = (id, name = 'Synthetic feed') => ({id, name});
  const match = (...pages) =>
    lookup.match(
      pages.map(rows => list(rows)),
      claimed,
    );
  assert.deepEqual(ids(match([feed('6001', 'Existing feed'), feed('6002'), feed('6100')]).found), ['6100']);
  assert.deepEqual(lookup.receipt(match([feed('6100')]).found), {id: '6100'});
  assert.deepEqual(match([feed('6002')]).found, []);
  assert.deepEqual(ids(match([feed('6100'), feed('6101')]).found).sort(), ['6100', '6101']);
  // Without the review's list, a feed of that name is undated.
  const bare = lookupOf('feed', [{}]);
  assert.deepEqual(ids(bare.match([list([feed('6100')])], claimed).undated), ['6100']);
  assert.equal(bare.match([list([feed('6100')])], claimed).found.length, 0);
});

// ----- audiences: dated by time_created -----
const audience = (id, seconds, extra = {}) => ({
  id,
  account_id: account,
  name: 'Synthetic audience',
  ...(seconds === undefined ? {} : {time_created: seconds}),
  ...extra,
});
test('an audience is created when it is of that name and was made in the window around the claim', () => {
  const lookup = lookupOf('audience'),
    at = ms => Math.floor((claimed + ms) / 1000),
    match = rows => lookup.match([list(rows)], claimed);
  let m = match([audience('4100', at(5000))]);
  assert.deepEqual(
    m.found.map(f => [f.index, f.id]),
    [[0, '4100']],
  );
  assert.deepEqual(lookup.receipt(m.found), {id: '4100'});
  assert.equal(m.complete, true);
  // A little before the claim (clock skew) and up to a quarter of an hour after it are in the window; beyond either is not.
  assert.deepEqual(ids(match([audience('1', at(-60000))]).found), ['1']);
  assert.deepEqual(ids(match([audience('2', at(14 * 60000))]).found), ['2']);
  assert.deepEqual(match([audience('3', at(-10 * 60000))]).found, [], 'ten minutes before the claim');
  assert.deepEqual(match([audience('4', at(30 * 60000))]).found, [], 'half an hour after it');
  assert.deepEqual(
    [match([audience('3', at(-10 * 60000))]).complete, (match([audience('4', at(30 * 60000))]).undated ?? []).length],
    [true, 0],
  );
  // Two in the window are shown, never chosen between.
  m = match([audience('4100', at(1000)), audience('4101', at(2000))]);
  assert.deepEqual(ids(m.found).sort(), ['4100', '4101']);
  // A time Meta does not give, or gives in a form that cannot be read, cannot be placed against the claim: undated.
  for (const time of [undefined, null, 'soon', ''])
    assert.deepEqual(ids(match([{...audience('4200'), time_created: time}]).undated), ['4200'], String(time));
  assert.equal(match([audience('4200')]).found.length, 0);
  // Meta writes the time as seconds since 1970 (a number, or its digits).
  assert.deepEqual(ids(match([audience('5', String(at(3000)))]).found), ['5']);
  // A name of another case is another name; an audience shared in from another account is not this account's creation.
  assert.deepEqual(match([audience('6', at(3000), {name: 'SYNTHETIC AUDIENCE'})]).found, []);
  assert.deepEqual(match([audience('7', at(3000), {account_id: '999'})]).found, []);
});

// ----- catalogs and creatives: no creation time, no list the review froze -----
test('a catalog or a creative of that name is shown and never called created: nothing dates it', () => {
  for (const [kind, rows] of [
    [
      'catalog',
      [
        {id: '555', name: 'Existing catalog'},
        {id: '5100', name: 'Synthetic catalog'},
      ],
    ],
    [
      'creative',
      [
        {id: '3001', name: 'Existing creative', status: 'ACTIVE'},
        {id: '3100', name: 'Synthetic creative', status: 'ACTIVE'},
      ],
    ],
  ]) {
    const lookup = lookupOf(kind),
      m = lookup.match([list(rows)], claimed);
    assert.equal(m.found.length, 0, kind + ' is never found');
    assert.equal(m.complete, true);
    assert.equal(m.undated.length, 1, kind);
    assert.deepEqual(ids(m.undated), [rows[1].id]);
    // None of that name in the whole list: nothing was created.
    const none = lookup.match([list([rows[0]])], claimed);
    assert.deepEqual([none.found.length, (none.undated ?? []).length, none.complete], [0, 0, true], kind);
    // Two of that name are both shown.
    assert.equal(lookup.match([list([rows[1], {...rows[1], id: '9'}])], claimed).undated.length, 2);
    // An incomplete list proves no absence.
    assert.equal(lookup.match([list([rows[0]], 'c1')], claimed).complete, false);
  }
  // A deleted creative is no creative.
  const deleted = lookupOf('creative').match(
    [list([{id: '3200', name: 'Synthetic creative', status: 'DELETED'}])],
    claimed,
  );
  assert.deepEqual([deleted.found.length, (deleted.undated ?? []).length], [0, 0]);
});

// ----- campaigns, ad sets and ads: the lookup that existed, with its window closed and an unreadable time not ignored -----
test('a campaign of that name made long after the claim is not this write’s, and one with no readable time is undated', () => {
  const lookup = lookupOf('campaign'),
    row = (id, created) => ({
      id,
      name: 'Synthetic campaign',
      ...(created === undefined ? {} : {created_time: created}),
    }),
    match = rows => lookup.match([{status: 200, headers: {}, data: {data: rows}}], claimed);
  assert.deepEqual(ids(match([row('1', metaTime(claimed + 5000))]).found), ['1']);
  assert.deepEqual(match([row('2', metaTime(claimed + 3 * 3600000))]).found, [], 'three hours after the claim');
  assert.equal(match([row('2', metaTime(claimed + 3 * 3600000))]).complete, true);
  assert.deepEqual(ids(match([row('3')]).undated), ['3'], 'Meta gave no creation time');
  assert.deepEqual(ids(match([row('4', 'yesterday')]).undated), ['4']);
  // Only the frozen name is looked for; another name made at the same moment is another campaign.
  assert.deepEqual(
    match([{...row('5', metaTime(claimed + 1000)), name: 'Another campaign'}]).found,
    [],
    'a different name',
  );
  // Two in the window are shown, never chosen between; a second page that Meta names is not called whole.
  assert.deepEqual(ids(match([row('6', metaTime(claimed + 1000)), row('7', metaTime(claimed + 2000))]).found).sort(), [
    '6',
    '7',
  ]);
  const cut = lookup.match(
    [{status: 200, headers: {}, data: {data: [], paging: {next: 'https://graph.facebook.com/next'}}}],
    claimed,
  );
  assert.equal(cut.complete, false, 'Meta says more follows');
  // An answer that is no list at all (an account, an error object) proves nothing absent: not found is not told from it.
  for (const data of [{id: 'act_1', name: 'Synthetic account'}, {error: {message: 'not a list'}}, null]) {
    const answer = lookup.match([{status: 200, headers: {}, data}], claimed);
    assert.deepEqual([answer.found.length, answer.complete], [0, false], JSON.stringify(data));
  }
});

// ----- the lifecycle: a lost response, reconciled by reads -----
for (const kind of ['set', 'feed', 'audience', 'campaign']) {
  test(
    'a lost ' +
      kind +
      ' create that Meta applied is found by reconcile, which sends nothing; accepting records its receipt',
    async () => {
      const f = metaReconcileFixture();
      try {
        const {id, refused} = await f.lose(kind, {applied: true});
        assert.equal(refused.error.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(refused).slice(0, 400));
        assert.equal(f.claim(id).state, 'uncertain');
        const writes = f.sent.length,
          before = f.requests.length;
        const r = await f.call('amcp_write', {action: 'reconcile', review_id: id});
        assert.equal(r.success, true, JSON.stringify(r).slice(0, 600));
        assert.equal(r.data.contract, 'create', 'no longer no_read_contract');
        assert.equal(r.data.classification, 'appears_applied', JSON.stringify(r.data));
        assert.equal(r.data.reason, 'created_found');
        assert.equal(r.data.mutation_requests, 0);
        assert.deepEqual(r.data.observed_ids, ['9000']);
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
        const replay = await f.execute(id);
        assert.equal(replay.data.replayed, true);
        assert.deepEqual(replay.data.data, {id: '9000'}, 'the receipt Meta answers a create with');
        assert.equal(f.sent.length, writes, 'execute replays the receipt and sends nothing');
      } finally {
        f.close();
      }
    },
  );
}

for (const kind of ['set', 'feed', 'catalog', 'audience', 'creative', 'campaign']) {
  test('a lost ' + kind + ' create that Meta never applied appears not applied, whatever else is there', async () => {
    const f = metaReconcileFixture();
    try {
      // An older object of the same name, where the creation time dates it (a set or feed of that name is refused at prepare,
      // and a catalog or creative of that name cannot be dated, so it would settle nothing).
      const [, , payload] = creates[kind];
      if (kind === 'audience')
        f.rows.audience.push({id: '4002', account_id: account, name: payload.name, time_created: 1700000000});
      if (kind === 'campaign')
        f.rows.campaign.push({id: '2002', name: payload.name, created_time: '2026-01-02T00:00:00+0000'});
      const prepared = await f.prepare(kind);
      assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 500));
      f.state.applied = false;
      f.state.lose = true;
      const refused = await f.execute(prepared.data.review_id);
      f.state.lose = false;
      assert.equal(refused.error.code, 'WRITE_OUTCOME_UNCERTAIN');
      const r = await f.call('amcp_write', {action: 'reconcile', review_id: prepared.data.review_id});
      assert.equal(r.data.classification, 'appears_not_applied', JSON.stringify(r.data));
      assert.equal(r.data.reason, 'not_found');
      assert.equal(
        r.data.next_call.arguments.supersedes_review_id,
        prepared.data.review_id,
        'a new review is the person’s call',
      );
      assert.equal(f.sent.length, 1, 'sent once');
    } finally {
      f.close();
    }
  });
}

for (const kind of ['catalog', 'creative']) {
  test('a lost ' + kind + ' create that Meta applied is shown, not called applied: nothing dates it', async () => {
    const f = metaReconcileFixture();
    try {
      const {id} = await f.lose(kind, {applied: true});
      const r = await f.call('amcp_write', {action: 'reconcile', review_id: id});
      assert.equal(r.data.classification, 'indeterminate', JSON.stringify(r.data));
      assert.equal(r.data.reason, 'undated_match');
      assert.deepEqual(r.data.undated, [{id: '9000'}]);
      assert.equal(r.data.observed_ids, undefined, 'nothing is offered for acceptance');
      assert.equal(f.sent.length, 1);
    } finally {
      f.close();
    }
  });
}

test('a product set created after the review froze the catalog is found on the third page of its list', async () => {
  const f = metaReconcileFixture();
  try {
    // The catalog already holds sets that fill two pages of two, and Meta lists the new one last.
    for (const n of [1, 2, 3])
      f.rows.set.push({id: '710' + n, name: 'Other ' + n, filter: '{}', product_catalog: {id: catalog}});
    const {id} = await f.lose('set', {applied: true});
    f.state.limit = 2;
    const before = f.requests.length;
    const r = await f.call('amcp_write', {action: 'reconcile', review_id: id});
    assert.equal(r.data.classification, 'appears_applied', JSON.stringify(r.data));
    assert.deepEqual(r.data.observed_ids, ['9000']);
    const pages = f.requests.slice(before).filter(request => request === 'GET /v26.0/' + catalog + '/product_sets');
    assert.equal(pages.length, 6, 'three pages, in each of the two rounds');
  } finally {
    f.close();
  }
});

test('a list longer than the pages a lookup follows is not called whole: nothing is proved absent', async () => {
  const f = metaReconcileFixture();
  try {
    for (let n = 0; n < 30; n++)
      f.rows.set.push({
        id: '72' + String(n).padStart(2, '0'),
        name: 'Other ' + n,
        filter: '{}',
        product_catalog: {id: catalog},
      });
    const prepared = await f.prepare('set');
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 500));
    f.state.applied = false;
    f.state.lose = true;
    await f.execute(prepared.data.review_id);
    f.state.lose = false;
    // Meta now lists two sets to a page: ten pages (the most a lookup follows) hold twenty of the thirty-two.
    f.state.limit = 2;
    const r = await f.call('amcp_write', {action: 'reconcile', review_id: prepared.data.review_id});
    assert.equal(r.data.classification, 'indeterminate', JSON.stringify(r.data));
    assert.equal(r.data.reason, 'lookup_incomplete');
  } finally {
    f.close();
  }
});

test('the worker’s automatic check finds a lost Meta create too', async () => {
  const f = metaReconcileFixture();
  try {
    const {id} = await f.lose('set', {applied: true});
    f.store.db.prepare("UPDATE jobs SET available_at=0 WHERE kind='write_reconcile' AND state='queued'").run();
    assert.equal(await f.worker.once(), true);
    const s = await f.call('amcp_write', {action: 'status', review_id: id});
    assert.equal(s.data.reconciliation.classification, 'appears_applied', JSON.stringify(s.data.reconciliation));
    assert.equal(s.data.reconciliation.automatic, true);
    assert.deepEqual(s.data.reconciliation.observed_ids, ['9000']);
    assert.equal(f.sent.length, 1, 'the job made no write');
  } finally {
    f.close();
  }
});
