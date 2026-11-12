// V2-MCP-02, target probes 14, 18 and 19, asked the way a client asks them: a real SDK v2 client over the real HTTP stack,
// in both protocol eras (the earlier revisions and 2026-07-28). The same rules are pinned at the service by
// tests/mcp-typed-config.test.mjs (19) and tests/mcp-typed-filters.test.mjs (18, 14), and the handle of a task over raw
// JSON-RPC by tests/mcp-tasks.test.mjs (14); this file reads the listing off the wire, compiles its schemas as a client
// does, sends what a client sends, and reads the answers a client reads. The SDK client also checks every successful
// answer against the output schema its tool listed, so a green call here is a conforming answer too.
//
//  - Probe 19: a client that validates its arguments against the input schema it was listed sends the old `level`
//    string. Expected: valid, and the server runs it.
//  - Probe 18: a paged (truncated) result continued with changed arguments. Expected: refused, never misapplied.
//  - Probe 14: a continuation used by another credential, another person of the workspace, another AI client of the same
//    person, or another workspace. Expected: refused.
// The HTTP tests send tens of calls per key, so the per-key request rate of /mcp (SEC-02, pinned by
// tests/mcp-request-limits.test.mjs) is switched off for them with the app's own option. An AI client is the actor
// `oauth/<client>` of a person; /mcp accepts one only with a live OAuth grant (validateMcpToken), which the test app has
// no website to give, so the AI-client cases run at the service, with the actors the store authenticates for exactly
// the keys the OAuth token endpoint makes (server/mcp-oauth.ts, issue). The token exchange itself is not under test here.
import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {WebStore} from '../dist/server/web-store.js';
import {UserAccounts} from '../dist/server/user-accounts.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {reportEngine} from './helpers/report-engine.mjs';
import {row} from './helpers/report-packets.mjs';
import {overviewGranularityFixture, granularConfig, granularSource} from './fixtures/overview-granularity-data.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';
import {connectClient, overviewTool} from './helpers/mcp-long-run-stacks.mjs';

const eras = ['legacy', 'modern'];

/** The service over the real HTTP stack: the URL of its MCP endpoint. */
async function serve(t, service, store) {
  const listener = await listenForFetch(
    createHttpApp(service, store, {mcpModernProtocol: 'on', mcpLimits: {perMinute: 0}}),
  );
  t.after(() => new Promise(resolve => listener.close(resolve)));
  return new URL('http://127.0.0.1:' + listener.address().port + '/mcp');
}
/**
 * What a client reads of an answer to one call: the envelope every tool answers, whether it succeeded or refused, as
 * structured content and as the text beside it.
 */
async function ask(client, args) {
  const result = await client.callTool({name: overviewTool, arguments: args});
  const refused = result.isError === true;
  assert.equal(result.structuredContent.success, !refused, 'isError mirrors the envelope');
  if (refused) assert.equal(typeof result.structuredContent.error.code, 'string', 'a refusal carries its code');
  assert.equal(result.content[0].text, JSON.stringify(result.structuredContent), 'the text is the same envelope');
  return result.structuredContent;
}

for (const era of eras)
  test(`${era} HTTP: a client that validates against the listed input schema sends an old level string, and it is valid and runs (probe 19)`, async t => {
    const f = overviewGranularityFixture();
    t.after(() => f.close());
    const url = await serve(t, f.service, f.store),
      client = await connectClient(t, era, url, f.store.createKey(f.actor));
    // The listing as it arrived over the wire (listTools also hands the SDK client the output schemas it checks results by).
    const listed = (await client.listTools()).tools.find(tool => tool.name === overviewTool),
      validate = new Ajv({strict: false}).compile(listed.inputSchema);
    let ran = 0;
    for (const platform of ['google', 'meta', 'tiktok', 'linkedin', 'x', 'snapchat'])
      for (const level of ['campaign', 'adset', 'ad']) {
        // The v3 shape: one `level`, an `objective`, the platform's detail options; nothing in it is a v4 field.
        const old = granularSource(platform, level);
        if (level === 'campaign') delete old.report_options;
        const args = {action: 'run', config: granularConfig(old), confirmed: true};
        assert.equal(old.levels, undefined);
        assert.equal(typeof old.level, 'string');
        assert.ok(validate(args), platform + ' ' + level + ': ' + JSON.stringify(validate.errors));
        const run = await ask(client, args);
        assert.equal(run.success, true, platform + ' ' + level + ': ' + JSON.stringify(run.error));
        assert.equal(typeof run.data.id, 'string');
        ran++;
      }
    assert.equal(ran, 18);
    // The check is not vacuous: what no platform has is refused by the schema, and by the server when a client sends it anyway.
    const wrong = granularConfig({...granularSource('meta', 'adset'), level: 'adgroup'});
    assert.equal(validate({action: 'run', config: wrong, confirmed: true}), false);
    assertRefused(await ask(client, {action: 'run', config: wrong, confirmed: true}), 'INVALID_REPORT_LEVEL');
  });

// The rows of one report: a campaign, an ad set under it and an ad under that, so a read of one entity pages in three.
const above = (adset, extra = {}) => ({
  parent_ids: {
    campaign_id: 'c1',
    campaign_name: 'Spring sale',
    ...(adset ? {adset_id: adset, adset_name: 'Ad set ' + adset} : {}),
    ...extra,
  },
});
const data = {
  campaign: [row('campaign', 'c1', {spend: '30'}, {campaign_name: 'Spring sale'})],
  adset: [row('adset', 's1', {spend: '20'}, {...above(), entity_name: 'Prospecting'})],
  ad: [row('ad', 'a1', {spend: '10'}, {...above('s1'), entity_name: 'Hero video'})],
};
const rowsOf = page => page.rows.map(r => r.level + ':' + r.entity_id);
const narrowed = id => ({action: 'get', id, limit: 1, entity: 'c1'}),
  listed = {action: 'list', limit: 1, state: 'complete'};

/** Two finished reports of one workspace, as the report engine queues and the worker runs them. */
async function reports(t) {
  const e = reportEngine(t, {rowsFor: level => data[level]}),
    ids = [];
  for (const name of ['Probe report one', 'Probe report two']) {
    const queued = await e.overview.handle(
      {action: 'run', confirmed: true, config: e.definition(['campaign', 'adset', 'ad'], {name})},
      e.actor,
    );
    await e.worker.once();
    ids.push(queued.id);
  }
  return {...e, ids};
}
/**
 * The two reports served over the real HTTP stack, and a key for every kind of caller a continuation can meet: the owner
 * (an administrator), another credential of the owner, another person of the workspace, and an administrator of another
 * workspace.
 */
async function readStack(t) {
  const e = await reports(t);
  e.store.ensureTenant('probe-other-workspace');
  const keys = {
    owner: e.store.createKey(e.actor),
    'another credential of the same person': e.store.createKey(e.actor),
    'another person of the workspace': e.store.createKey({
      tenantId: e.actor.tenantId,
      userId: 'colleague',
      role: 'operator',
    }),
    'an administrator of another workspace': e.store.createKey({
      tenantId: 'probe-other-workspace',
      userId: 'owner',
      role: 'admin',
    }),
  };
  const url = await serve(t, e.service, e.store);
  return {...e, keys, url, connect: (era, key) => connectClient(t, era, url, key)};
}

for (const era of eras)
  test(`${era} HTTP: a narrowed get and list continue only by the cursor they returned, and a continuation with changed arguments is refused (probe 18)`, async t => {
    const s = await readStack(t),
      client = await s.connect(era, s.keys.owner),
      [id, other] = s.ids,
      read = narrowed(id);
    // Followed the way a client follows it, by the next_call each page names, the pages are the rows, once each, in order.
    const pages = [];
    for (let next = read; next && pages.length < 10;) {
      const page = await ask(client, next);
      assert.equal(page.success, true, JSON.stringify(page.error));
      pages.push(page.data);
      next = page.data.next_call?.arguments;
      if (next) assert.equal(page.data.next_call.tool, overviewTool);
    }
    assert.deepEqual(pages.flatMap(rowsOf), ['campaign:c1', 'adset:s1', 'ad:a1']);
    assert.equal(pages.length, 3);
    assert.equal(pages.at(-1).has_more, false);
    assert.equal(pages.at(-1).next_cursor, null);
    // The first page's continuation continues; the same continuation with any argument changed is refused.
    const next = pages[0].next_call.arguments;
    assert.deepEqual(next, {...read, cursor: pages[0].next_cursor});
    assert.equal((await ask(client, next)).success, true, 'the unchanged continuation continues');
    for (const change of [
      {entity: 's1'},
      {entity: undefined},
      {limit: 2},
      {level: 'ad'},
      {platform: 'meta'},
      {query: 'hero'},
      {id: other},
      {include: {native: true}},
      {offset: 1},
    ])
      assertRefused(await ask(client, {...next, ...change}), 'INVALID_CURSOR');
    // A cursor continues nothing that was not narrowed, a made-up or altered one continues nothing, and a narrowed read
    // has no offset to apply.
    assertRefused(await ask(client, {action: 'get', id, limit: 1, cursor: pages[0].next_cursor}), 'INVALID_CURSOR');
    assertRefused(await ask(client, {...next, cursor: pages[0].next_cursor.slice(0, -2) + 'AA'}), 'INVALID_CURSOR');
    assertRefused(await ask(client, {...next, cursor: 'x'.repeat(1024)}), 'INVALID_CURSOR');
    assertRefused(await ask(client, {...read, offset: 1}), 'INVALID_PAGE');

    // The list of snapshots: two complete ones, paged by one, continued only by the cursor and the arguments it was made for.
    const first = await ask(client, listed);
    assert.equal(first.success, true, JSON.stringify(first.error));
    assert.equal(first.data.has_more, true);
    const more = first.data.next_call.arguments,
      second = await ask(client, more);
    assert.deepEqual(
      [first, second].flatMap(page => page.data.reports.map(report => report.id)).sort(),
      [id, other].sort(),
      'each snapshot once',
    );
    assert.equal(second.data.has_more, false);
    for (const change of [{state: 'queued'}, {state: undefined}, {platform: 'meta'}, {limit: 2}, {offset: 1}])
      assertRefused(await ask(client, {...more, ...change}), 'INVALID_CURSOR');
    assertRefused(await ask(client, {...listed, offset: 1}), 'INVALID_PAGE');
  });

for (const era of eras)
  test(`${era} HTTP: a continuation belongs to the caller that made it: another credential, person or workspace is refused (probe 14)`, async t => {
    const s = await readStack(t),
      stranger = 'an administrator of another workspace',
      clients = new Map();
    for (const [who, key] of Object.entries(s.keys)) clients.set(who, await s.connect(era, key));
    assert.equal(clients.size, 4);
    // Each caller that can read the report starts a read of its own, and only that caller continues it.
    const made = new Map();
    for (const [who, client] of clients)
      if (who !== stranger) {
        const page = await ask(client, narrowed(s.ids[0]));
        assert.equal(page.success, true, who + ': ' + JSON.stringify(page.error));
        made.set(who, {get: page.data.next_call.arguments, list: (await ask(client, listed)).data.next_call.arguments});
      }
    assert.equal(made.size, 3);
    for (const [who, client] of clients)
      for (const [maker, {get, list}] of made) {
        if (who === maker) {
          assert.equal((await ask(client, get)).success, true, who + ' continues its own get');
          assert.equal((await ask(client, list)).success, true, who + ' continues its own list');
        } else if (who === stranger) {
          // Another workspace never reaches the snapshot at all; its list cursor is not its own either.
          assertRefused(await ask(client, get), 'NOT_FOUND');
          assertRefused(await ask(client, list), 'INVALID_CURSOR');
        } else {
          assertRefused(await ask(client, get), 'INVALID_CURSOR');
          assertRefused(await ask(client, list), 'INVALID_CURSOR');
        }
      }
  });

test('a continuation belongs to one AI client of a person: the person, another AI client and a fresh token of the same client are refused (probe 14)', async t => {
  const s = await reports(t),
    tenant = s.actor.tenantId,
    accounts = new UserAccounts(
      new WebStore(s.store, {
        origin: 'https://probe.example.test',
        masterKey: Buffer.alloc(32, 121).toString('base64'),
        authEnv: {},
      }),
    ),
    person = accounts.newUser('Probe member', 'probe-member@example.test', null, true);
  s.store.db
    .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
    .run(tenant, person.id, 'operator', Date.now());
  // What the OAuth token endpoint makes for an AI client, and what authenticating it gives back.
  const actorOf = (userId, ownerUserId = person.id) =>
      s.store.authenticate(s.store.createKey({tenantId: tenant, userId, ownerUserId, role: 'operator'})),
    call = (args, actor) => s.service.call(overviewTool, args, actor);
  const one = actorOf('oauth/client-one'),
    callers = {
      'the first AI client again': one,
      'the second AI client of the same person': actorOf('oauth/client-two'),
      'a fresh token of the first AI client (a refresh)': actorOf('oauth/client-one'),
      'the person signed in to the website': actorOf(person.id),
    };
  assert.equal(one.ownerUserId, person.id);
  assert.equal(one.userId, 'oauth/client-one');
  for (const [name, args] of [
    ['get', narrowed(s.ids[0])],
    ['list', listed],
  ]) {
    const first = await call(args, one);
    assert.equal(first.success, true, name + ': ' + JSON.stringify(first.error));
    const next = first.data.next_call.arguments;
    for (const [who, actor] of Object.entries(callers))
      if (actor === one) assert.equal((await call(next, actor)).success, true, name + ' ' + who);
      else assertRefused(await call(next, actor), 'INVALID_CURSOR');
    // And each of them continues a read of its own, which the first AI client cannot continue.
    for (const [who, actor] of Object.entries(callers).filter(([, actor]) => actor !== one)) {
      const own = await call(args, actor);
      assert.equal(own.success, true, name + ' ' + who + ': ' + JSON.stringify(own.error));
      assert.equal((await call(own.data.next_call.arguments, actor)).success, true, name + ' ' + who);
      assertRefused(await call(own.data.next_call.arguments, one), 'INVALID_CURSOR');
    }
  }
});
