// V2-MCP-02 (decision 3): `get` narrows its rows by platform, level, entity and a row query; `list` narrows the report
// snapshots by client, platform and state. A filter runs after the access checks and only hides; a continuation of a
// filtered read is a cursor bound to the caller and to every argument of the read (target probe 18). Without a filter
// the responses are the ones the website already reads. The reports are real: definition, queue, worker, row assembly and
// `get` run for real over a fake collector (tests/helpers/report-engine.mjs); only the provider is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {saveAccessSet} from '../dist/src/access-sets.js';
import {reportPlatforms} from '../dist/src/report-metrics.js';
import {reportEngine} from './helpers/report-engine.mjs';
import {row} from './helpers/report-packets.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

const tool = 'amcp_reporting_overview';
const above = (campaign, name, adset) => ({
  parent_ids: {
    campaign_id: campaign,
    campaign_name: name,
    ...(adset ? {adset_id: adset, adset_name: 'Ad set ' + adset} : {}),
  },
});
// Three levels of two platforms; one campaign each, with an ad set and an ad under it.
const data = {
  meta: {
    campaign: [row('campaign', 'c1', {spend: '30'}, {campaign_name: 'Spring sale'})],
    adset: [row('adset', 's1', {spend: '20'}, {...above('c1', 'Spring sale'), entity_name: 'Prospecting'})],
    ad: [row('ad', 'a1', {spend: '10'}, {...above('c1', 'Spring sale', 's1'), entity_name: 'Hero video'})],
  },
  tiktok: {
    campaign: [row('campaign', 't1', {spend: '3'}, {campaign_name: 'Autumn push'})],
    adset: [row('adset', 'g1', {spend: '2'}, {...above('t1', 'Autumn push'), entity_name: 'Prospecting'})],
    ad: [row('ad', 'd1', {spend: '1'}, {...above('t1', 'Autumn push', 'g1'), entity_name: 'Short clip'})],
  },
};
function fixture(t) {
  const e = reportEngine(t, {rowsFor: (level, source) => data[source.platform][level]});
  e.store.putConnection(
    e.actor,
    {
      id: 'login-tiktok',
      tenantId: e.actor.tenantId,
      gateway: reportPlatforms.tiktok.gateway,
      accounts: ['200'],
      enabled: true,
      scopes: [],
      label: 'Synthetic TikTok',
    },
    {accessToken: 'synthetic'},
  );
  const call = (args, actor = e.actor) => e.service.call(tool, args, actor),
    sourceOf = platform => ({
      platform,
      account_id: platform === 'meta' ? '100' : '200',
      connection_id: platform === 'meta' ? 'login' : 'login-tiktok',
      levels: ['campaign', 'adset', 'ad'],
      report_options: {complete_window: true},
    }),
    /** Queues a report of these platforms and, when `finish` is true, runs it to the end. */
    report = async (platforms, name = 'Synthetic filters', finish = true) => {
      const queued = await e.overview.handle(
        {
          action: 'run',
          confirmed: true,
          config: e.definition(['campaign', 'adset', 'ad'], {name, sources: platforms.map(sourceOf)}),
        },
        e.actor,
      );
      if (finish) await e.worker.once();
      return queued;
    };
  return {...e, call, report, sourceOf};
}
/** The levels and IDs of the rows of a get result, in the order they come. */
const rowsOf = result => {
  assert.equal(result.success, true, JSON.stringify(result.error));
  return result.data.rows.map(r => r.level + ':' + r.entity_id);
};
/** Every page of a narrowed read, followed through the next_call each page names. */
async function followed(f, args, actor) {
  const pages = [];
  let next = {...args};
  for (let i = 0; i < 20 && next; i++) {
    const page = await f.call(next, actor);
    assert.equal(page.success, true, JSON.stringify(page.error));
    pages.push(page.data);
    next = page.data.next_call?.arguments;
    if (next) assert.equal(page.data.next_call.tool, tool);
  }
  return pages;
}

test('without a filter, get and list answer exactly as before: no new field and the offset paging', async t => {
  const f = fixture(t),
    {id} = await f.report(['meta', 'tiktok']),
    all = await f.call({action: 'get', id, limit: 4});
  assert.equal(all.success, true, JSON.stringify(all.error));
  assert.equal(all.data.state, 'complete');
  for (const key of ['matched_row_count', 'filter', 'next_cursor', 'next_call'])
    assert.equal(Object.hasOwn(all.data, key), false, key);
  assert.equal(all.data.row_count, 6);
  assert.equal(all.data.total, 6);
  assert.equal(all.data.has_more, true);
  assert.equal(all.data.next_offset, 4);
  const second = await f.call({action: 'get', id, limit: 4, offset: 4});
  assert.equal(second.data.offset, 4);
  assert.equal(second.data.has_more, false);
  assert.equal(second.data.next_offset, null);
  const list = await f.call({action: 'list', limit: 5});
  assert.equal(list.success, true, JSON.stringify(list.error));
  assert.deepEqual(Object.keys(list.data).sort(), ['has_more', 'next_offset', 'offset', 'reports']);
});

test('get narrows its rows by platform, level, entity and query, all together, and says what it did', async t => {
  const f = fixture(t),
    {id} = await f.report(['meta', 'tiktok']),
    get = extra => f.call({action: 'get', id, limit: 500, ...extra});
  const everything = rowsOf(await get({}));
  assert.equal(everything.length, 6);
  const meta = await get({platform: 'meta'});
  assert.deepEqual(rowsOf(meta), ['campaign:c1', 'adset:s1', 'ad:a1']);
  assert.equal(meta.data.matched_row_count, 3);
  assert.equal(meta.data.row_count, 6, 'row_count stays the whole snapshot');
  assert.equal(meta.data.total, 3);
  assert.equal(meta.data.has_more, false);
  assert.equal(meta.data.next_cursor, null);
  assert.equal(Object.hasOwn(meta.data, 'next_call'), false);
  assert.deepEqual(meta.data.filter, {platform: 'meta'});
  assert.deepEqual(rowsOf(await get({level: 'ad'})), ['ad:a1', 'ad:d1']);
  // The entity is a native ID as the rows show it: the row itself and the rows under it.
  assert.deepEqual(rowsOf(await get({entity: 'c1'})), ['campaign:c1', 'adset:s1', 'ad:a1']);
  assert.deepEqual(rowsOf(await get({entity: 's1'})), ['adset:s1', 'ad:a1']);
  assert.deepEqual(rowsOf(await get({entity: 'a1'})), ['ad:a1']);
  assert.deepEqual(rowsOf(await get({entity: 'c1', level: 'ad'})), ['ad:a1']);
  assert.deepEqual(rowsOf(await get({entity: 'no-such-entity'})), []);
  // The query is a case-insensitive text search over IDs and names, as amcp_reporting’s row_query is.
  assert.deepEqual(
    rowsOf(await get({query: 'prospecting'})),
    everything.filter(r => ['adset:s1', 'adset:g1'].includes(r)),
  );
  // The names above a row count too: the ad under ad set s1 is found by that ad set’s name.
  assert.deepEqual(rowsOf(await get({query: 'AD SET S1'})), ['ad:a1']);
  assert.deepEqual(rowsOf(await get({query: 'SPRING SALE'})), ['campaign:c1', 'adset:s1', 'ad:a1']);
  assert.deepEqual(rowsOf(await get({query: 'clip', platform: 'tiktok', level: 'ad'})), ['ad:d1']);
  assert.deepEqual((await get({query: ' CLIP ', level: 'ad'})).data.filter, {level: 'ad', query: 'CLIP'});
  assert.deepEqual(rowsOf(await get({query: '   '})), everything, 'a blank query narrows nothing');
  assert.equal(Object.hasOwn((await get({query: '   '})).data, 'filter'), false);
  // A filter only hides rows: what it returns is a subset, row for row, of what the unfiltered read returns.
  const full = (await get({})).data.rows;
  for (const extra of [
    {platform: 'tiktok'},
    {level: 'campaign'},
    {level: 'adset', platform: 'meta'},
    {query: 'c1'},
    {entity: 't1'},
  ])
    for (const found of (await get(extra)).data.rows)
      assert.deepEqual(
        found,
        full.find(original => original.row_key === found.row_key),
      );
  assert.deepEqual(rowsOf(await get({platform: 'meta', level: 'campaign', entity: 't1'})), []);
});

test('a filter value the tables do not have, or of the wrong kind, is refused with the values that are accepted', async t => {
  const f = fixture(t),
    {id} = await f.report(['meta']),
    get = extra => f.call({action: 'get', id, ...extra}),
    list = extra => f.call({action: 'list', ...extra});
  for (const [call, extra, field] of [
    [get, {platform: 'google_ads'}, 'platform'],
    [get, {platform: 7}, 'platform'],
    [get, {level: 'adgroup'}, 'level'],
    [get, {level: ''}, 'level'],
    [get, {entity: ''}, 'entity'],
    [get, {entity: 'x'.repeat(201)}, 'entity'],
    [get, {query: 'x'.repeat(151)}, 'query'],
    [get, {query: 5}, 'query'],
    [list, {platform: 'google_ads'}, 'platform'],
    [list, {state: 'done'}, 'state'],
    [list, {state: 3}, 'state'],
    [list, {client: ''}, 'client'],
  ]) {
    const refused = await call(extra);
    assertRefused(refused, 'INVALID_ARGUMENT');
    assert.equal(refused.error.details.field, field, JSON.stringify(extra));
  }
  const refused = await get({platform: 'google_ads'});
  assert.ok(refused.error.details.allowed.includes('google') && !refused.error.details.allowed.includes('google_ads'));
  assert.deepEqual((await list({state: 'done'})).error.details.allowed, [
    'queued',
    'running',
    'complete',
    'partial',
    'failed',
    'cancelled',
  ]);
  assert.equal((await get({query: 'x'.repeat(151)})).error.details.max_length, 150);
  assertRefused(await list({client: 'no-such-profile'}), 'PROFILE_NOT_FOUND');
});

test('a narrowed get continues only by its cursor, and a continuation with changed arguments is refused (probe 18)', async t => {
  const f = fixture(t),
    {id} = await f.report(['meta', 'tiktok']),
    other = (await f.report(['meta'], 'Another report')).id,
    wide = await f.call({action: 'get', id, limit: 500, level: 'adset'}),
    pages = await followed(f, {action: 'get', id, limit: 1, level: 'adset'});
  assert.equal(pages.length, wide.data.rows.length);
  assert.deepEqual(
    pages.flatMap(page => page.rows.map(r => r.row_key)),
    wide.data.rows.map(r => r.row_key),
    'the pages together are the rows, once each, in order',
  );
  const first = await f.call({action: 'get', id, limit: 1, level: 'adset'});
  assert.equal(first.data.has_more, true);
  assert.equal(first.data.next_offset, null, 'a narrowed read has no offset to misapply');
  assert.equal(typeof first.data.next_cursor, 'string');
  const next = first.data.next_call.arguments;
  assert.deepEqual(next, {action: 'get', id, limit: 1, level: 'adset', cursor: first.data.next_cursor});
  assert.equal((await f.call(next)).success, true);
  // Each argument of the read is bound: change one and the same cursor is refused, not applied to other rows.
  for (const change of [
    {level: 'ad'},
    {level: undefined},
    {limit: 2},
    {platform: 'meta'},
    {entity: 'c1'},
    {query: 'x'},
    {id: other},
    {include: {native: true}},
    {offset: 1},
  ])
    assertRefused(await f.call({...next, ...change}), 'INVALID_CURSOR');
  // A cursor continues nothing without filters, and a tampered one continues nothing.
  assertRefused(await f.call({action: 'get', id, limit: 1, cursor: first.data.next_cursor}), 'INVALID_CURSOR');
  assertRefused(await f.call({...next, cursor: first.data.next_cursor.slice(0, -2) + 'AA'}), 'INVALID_CURSOR');
  assertRefused(await f.call({...next, cursor: 'x'.repeat(2000)}), 'INVALID_CURSOR');
  // An offset belongs to an unfiltered read: with a filter the continuation is the cursor.
  assertRefused(await f.call({action: 'get', id, limit: 1, level: 'adset', offset: 1}), 'INVALID_PAGE');
  assert.equal((await f.call({action: 'get', id, limit: 1, level: 'adset', offset: 0})).success, true);
});

test('a cursor is the caller’s: another person, another credential, another role or another workspace cannot use it', async t => {
  const f = fixture(t),
    {id} = await f.report(['meta', 'tiktok']),
    first = await f.call({action: 'get', id, limit: 1, level: 'adset'}),
    next = first.data.next_call.arguments,
    key = () =>
      f.store.authenticate(
        f.store.createKey({tenantId: f.actor.tenantId, userId: 'second-operator', role: 'operator'}),
      );
  // The same person with another credential is another caller; so is another person.
  assertRefused(await f.call(next, key()), 'INVALID_CURSOR');
  assertRefused(await f.call(next, {...f.actor, userId: 'someone-else'}), 'INVALID_CURSOR');
  assertRefused(await f.call(next, {...f.actor, role: 'reader'}), 'INVALID_CURSOR');
  assert.equal((await f.call(next)).success, true, 'the caller itself continues');
  // A cursor made for one credential continues for that credential, and for no other.
  const mine = key(),
    sealed = (await f.call({action: 'get', id, limit: 1, level: 'adset'}, mine)).data.next_call.arguments;
  assert.equal((await f.call(sealed, mine)).success, true);
  assertRefused(await f.call(sealed, key()), 'INVALID_CURSOR');
  // Another workspace never reaches the snapshot at all.
  f.store.ensureTenant('other-workspace');
  assertRefused(await f.call(next, {tenantId: 'other-workspace', userId: 'fixture', role: 'admin'}), 'NOT_FOUND');
});

test('a filter cannot widen what the caller may read: a client set sees the same snapshots, or fewer', async t => {
  const f = fixture(t),
    both = (await f.report(['meta', 'tiktok'], 'Both platforms')).id,
    onlyMeta = (await f.report(['meta'], 'Only Meta')).id,
    set = saveAccessSet(f.store, f.actor, {
      name: 'Meta only',
      bindings: [{gateway: reportPlatforms.meta.gateway, connection_id: 'login', account_id: '100'}],
    }),
    scoped = f.store.authenticate(
      f.store.createKey({
        tenantId: f.actor.tenantId,
        userId: 'connector/meta-client',
        role: 'operator',
        accessSetId: String(set.id),
      }),
    );
  const ids = result => {
    assert.equal(result.success, true, JSON.stringify(result.error));
    return result.data.reports.map(report => report.id).sort();
  };
  assert.deepEqual(ids(await f.call({action: 'list', limit: 100})), [both, onlyMeta].sort());
  assert.deepEqual(ids(await f.call({action: 'list', limit: 100}, scoped)), [onlyMeta]);
  for (const filter of [{}, {platform: 'meta'}, {platform: 'tiktok'}, {state: 'complete'}, {state: 'queued'}]) {
    const wide = ids(await f.call({action: 'list', limit: 100, ...filter})),
      narrow = ids(await f.call({action: 'list', limit: 100, ...filter}, scoped));
    assert.ok(
      narrow.every(reportId => wide.includes(reportId) && reportId === onlyMeta),
      'filter ' + JSON.stringify(filter) + ' shows only what the set reaches',
    );
  }
  assert.deepEqual(ids(await f.call({action: 'list', limit: 100, platform: 'tiktok'}, scoped)), []);
  // A snapshot the set does not reach is refused whole, whatever the filter says.
  assertRefused(await f.call({action: 'get', id: both, platform: 'meta'}, scoped), 'ACCOUNT_SCOPE_RESTRICTED');
  assert.equal((await f.call({action: 'get', id: onlyMeta, platform: 'meta'}, scoped)).success, true);
});

test('list narrows snapshots by state, platform and client, and continues only by its cursor', async t => {
  const f = fixture(t),
    both = (await f.report(['meta', 'tiktok'], 'Both platforms')).id,
    onlyMeta = (await f.report(['meta'], 'Only Meta')).id,
    queued = (await f.report(['tiktok'], 'Waiting', false)).id,
    stopped = await f.report(['meta'], 'Stopped', false);
  assert.equal((await f.call({action: 'cancel', confirmed: true, id: stopped.job_id})).success, true);
  const ids = result => {
      assert.equal(result.success, true, JSON.stringify(result.error));
      return result.data.reports.map(report => report.id).sort();
    },
    list = extra => f.call({action: 'list', limit: 100, ...extra});
  const states = Object.fromEntries((await list({})).data.reports.map(report => [report.id, report.state]));
  assert.deepEqual(states, {[both]: 'complete', [onlyMeta]: 'complete', [queued]: 'queued', [stopped.id]: 'cancelled'});
  assert.deepEqual(ids(await list({state: 'complete'})), [both, onlyMeta].sort());
  assert.deepEqual(ids(await list({state: 'queued'})), [queued]);
  assert.deepEqual(ids(await list({state: 'cancelled'})), [stopped.id]);
  assert.deepEqual(ids(await list({state: 'failed'})), []);
  assert.deepEqual(ids(await list({platform: 'tiktok'})), [both, queued].sort());
  assert.deepEqual(ids(await list({platform: 'meta', state: 'complete'})), [both, onlyMeta].sort());
  assert.deepEqual(ids(await list({platform: 'meta', state: 'queued'})), []);
  // A client: the snapshots whose every source is one the client’s profile binds.
  f.store.putDocument(f.actor.tenantId, 'client_profile', 'profile-meta', {
    name: 'Meta client',
    bindings: [{gateway: reportPlatforms.meta.gateway, connection_id: 'login', account_id: '100'}],
  });
  assert.deepEqual(ids(await list({client: 'profile-meta'})), [onlyMeta, stopped.id].sort());
  assert.deepEqual(ids(await list({client: 'profile-meta', state: 'cancelled'})), [stopped.id]);
  // Pages: the cursor continues the same filter; any change to it is refused.
  const one = await f.call({action: 'list', limit: 1, state: 'complete'});
  assert.equal(one.data.reports.length, 1);
  assert.equal(one.data.has_more, true);
  assert.equal(one.data.next_offset, null);
  const pages = await followed(f, {action: 'list', limit: 1, state: 'complete'});
  assert.deepEqual(
    pages.flatMap(page => page.reports.map(report => report.id)).sort(),
    [both, onlyMeta].sort(),
    'each snapshot once',
  );
  const next = one.data.next_call.arguments;
  assert.deepEqual(next, {action: 'list', limit: 1, state: 'complete', cursor: one.data.next_cursor});
  for (const change of [
    {state: 'queued'},
    {state: undefined},
    {platform: 'meta'},
    {limit: 2},
    {client: 'profile-meta'},
    {offset: 1},
  ])
    assertRefused(await f.call({...next, ...change}), 'INVALID_CURSOR');
  assertRefused(await f.call({action: 'list', limit: 1, state: 'complete', offset: 1}), 'INVALID_PAGE');
  assertRefused(await f.call({action: 'list', limit: 1, cursor: one.data.next_cursor}), 'INVALID_CURSOR');
});

test('include accepts charts as a flag that adds the charts of the snapshot and nothing else, and still refuses any other key or a non-boolean', async t => {
  const f = fixture(t),
    {id} = await f.report(['meta']),
    plain = await f.call({action: 'get', id, limit: 5}),
    withCharts = await f.call({action: 'get', id, limit: 5, include: {charts: true}});
  assert.equal(withCharts.success, true, JSON.stringify(withCharts.error));
  // Merge C: this package accepted the flag and answered the plain read until package charts (V2-EXP-01) returned the
  // charts of a v4 snapshot there. The answer is now the plain one and its charts, field for field and nothing more.
  const {charts, ...rest} = withCharts.data;
  assert.ok(Array.isArray(charts) && charts.length > 0, 'the charts of the snapshot come back');
  assert.equal(Object.hasOwn(plain.data, 'charts'), false, 'a plain read carries none');
  assert.deepEqual(rest, plain.data);
  assertRefused(await f.call({action: 'get', id, include: {charts: 'yes'}}), 'INVALID_REPORT');
  assertRefused(await f.call({action: 'get', id, include: {raw: true}}), 'INVALID_REPORT');
  const listed = f.service.listTools().find(item => item.name === tool);
  assert.deepEqual(Object.keys(listed.inputSchema.properties.include.properties), ['native', 'lineage', 'charts']);
});

test('the help of get and list names the filters and the cursor with their rules, and the description points to them', async t => {
  const f = fixture(t),
    help = async topic => (await f.call({action: 'help', topic})).data.arguments;
  const get = await help('get'),
    list = await help('list');
  for (const name of ['platform', 'level', 'entity', 'query', 'cursor', 'include']) assert.ok(get[name], 'get ' + name);
  for (const name of ['client', 'platform', 'state', 'cursor']) assert.ok(list[name], 'list ' + name);
  for (const name of ['client', 'state', 'entity', 'query']) assert.equal(name in get && name in list, false, name);
  assert.match(get.cursor.description, /INVALID_CURSOR/);
  assert.match(get.include.description, /charts:true adds the charts a v4 snapshot stores with it/);
  assert.match(get.entity.description, /the rows under it/);
  assert.match(list.state.description, /queued, running, complete, partial, failed or cancelled/);
  assert.match(list.client.description, /all of whose sources are accounts of this client profile/);
  const description = f.service.listTools().find(item => item.name === tool).description;
  const full = f.service.firstPartyTools().find(item => item.name === tool).description;
  assert.match(
    full,
    /get narrows its rows by platform, level, entity or query, list narrows the snapshots by client, platform or state/,
  );
  assert.doesNotMatch(
    full,
    /include \{native:true\}/,
    'what the include flags do is an argument note, not the description',
  );
  assert.equal(typeof description, 'string');
});
