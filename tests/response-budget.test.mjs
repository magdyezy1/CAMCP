import test from 'node:test';
import assert from 'node:assert/strict';
import {measureSurface, surfaceFixture} from '../tools/measure-tool-list.mjs';
import {capabilityGraph, capabilityPageLength, capabilitySummaryBytes} from '../dist/src/capability-graph.js';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {assertRefused} from './helpers/assert-refused.mjs';

// The default views must fit an AI client's 10,000-token warning, not merely its 25,000-token cap (owner decision D14).
// Before MCP-01 one Meta connection produced a 301 KB capabilities graph, the dashboard embedded every receipt and six
// tool descriptions ran past the 2,048-character truncation; this gate fails if any of that returns.
const kb = 1024,
  callBudget = 40000;
let measured;
const surface = async () => (measured ??= await measureSurface());

test('tools/list descriptions are routing summaries of at most 2,000 characters in reader and operator modes', async () => {
  const m = await surface();
  for (const mode of ['reader', 'operator']) {
    // 25 tools by default: the parked Amazon Ads, Criteo and WooCommerce gateways are not offered (CON-06, ARC-01, P9).
    assert.ok(m.tools_list[mode].tools >= 25, mode);
    for (const [name, length] of Object.entries(m.tools_list[mode].descriptions))
      assert.ok(length <= 2000, mode + ' ' + name + ' ' + length);
  }
});
test('the capabilities summary and the default dashboard stay within the response budget', async () => {
  const m = await surface();
  assert.ok(m.capabilities.one_connection.summary_largest_page <= 15 * kb, JSON.stringify(m.capabilities));
  // The same 15 KB (owner decision D14) on a page of six providers and 20 accounts: it was 40 KB while a page was bounded by count alone, and the byte
  // bound (capabilitySummaryBytes, src/capability-graph.ts) ends each page where its record would pass the budget, so the cap no longer depends on the fixture.
  assert.ok(m.capabilities.six_providers_20_accounts.summary_largest_page <= 15 * kb, JSON.stringify(m.capabilities));
  // The whole graph is still there, on request.
  assert.ok(m.capabilities.one_connection.graph > m.capabilities.one_connection.summary_first_page * 4);
  assert.ok(m.dashboard.one_connection.summary <= 15 * kb, JSON.stringify(m.dashboard));
  assert.ok(m.dashboard.six_providers_20_accounts.summary <= 25000, JSON.stringify(m.dashboard));
  assert.ok(m.dashboard.six_providers_20_accounts.verified_writes_page <= 25000, JSON.stringify(m.dashboard));
  assert.equal(m.provider_requests, 0);
});
test('help repeats no gateway-level boilerplate on operation help, and every discovery call fits one budget', async () => {
  const m = await surface();
  assert.ok(m.help.operation_boilerplate_share <= 0.2, String(m.help.operation_boilerplate_share));
  assert.ok(m.help.root <= callBudget);
  for (const [gateway, bytes] of Object.entries({...m.help.gateways, ...m.help.operations}))
    assert.ok(bytes <= callBudget, gateway + ' ' + bytes);
  for (const [platform, chars] of Object.entries(m.prompt)) assert.ok(chars <= 25000, platform + ' ' + chars);
});
test('compact descriptions change only descriptions: every listed schema and enum is identical', async () => {
  const store = new Store(':memory:');
  try {
    const listed = flags =>
      new MirrorService(new Registry(), store, undefined, {mode: 'strict', flags}, {allowWrites: true}).listTools();
    const compact = listed({}),
      full = listed({compactDescriptions: false});
    assert.deepEqual(
      compact.map(t => [t.name, t.inputSchema]),
      full.map(t => [t.name, t.inputSchema]),
    );
    assert.ok(
      full.some(t => t.description.length > 2000),
      'the rollback flag lists the whole text',
    );
  } finally {
    store.close();
  }
});
test('view:"graph" is the unchanged graph, and summary pages are bound to the caller and filters', async t => {
  t.mock.timers.enable({apis: ['Date'], now: 1800000000000});
  const f = surfaceFixture();
  try {
    const graph = await f.service.call('amcp_workspace', {action: 'capabilities', view: 'graph'}, f.actor);
    assert.equal(
      JSON.stringify(graph.data),
      JSON.stringify(capabilityGraph(f.store, f.service.registry, f.actor, true, undefined, {})),
    );
    const first = await f.service.call('amcp_workspace', {action: 'capabilities'}, f.actor);
    assert.equal(first.data.record_kind, 'capability_summary');
    // Not 20 any more: a page holds up to limit workflows (20 by default) and ends early where its record would pass the byte budget (D14,
    // capabilitySummaryBytes). With the M4 packs the one-connection fixture's first page would hold 14,811 bytes of 20 workflows against a budget of 14,592,
    // so it ends one workflow early; the next page continues from there.
    assert.ok(first.data.returned <= first.data.limit && first.data.limit === 20, 'returned is at most limit');
    assert.equal(first.data.returned, 19);
    assert.equal(first.data.has_more, true);
    assert.equal(first.data.next_call.arguments.cursor, first.data.next_cursor);
    // A summary never upgrades: every blocker of the graph is carried through.
    const fromGraph = graph.data.workflows.slice(0, first.data.returned);
    first.data.workflows.forEach((w, i) =>
      assert.deepEqual(
        w.accounts.map(a => a.blockers),
        fromGraph[i].accounts.map(a => a.blockers),
      ),
    );
    let page = first,
      seen = first.data.workflows.length;
    while (page.data.next_cursor) {
      page = await f.service.call('amcp_workspace', {action: 'capabilities', cursor: page.data.next_cursor}, f.actor);
      assert.equal(page.success, true, JSON.stringify(page.error));
      seen += page.data.workflows.length;
    }
    assert.equal(seen, graph.data.workflows.length);
    // A cursor from another person, or with other filters, is refused.
    const other = await f.service.call(
      'amcp_workspace',
      {action: 'capabilities', cursor: first.data.next_cursor},
      {...f.actor, userId: 'someone-else'},
    );
    assert.equal(other.error?.code, 'INVALID_CURSOR');
    const filtered = await f.service.call(
      'amcp_workspace',
      {action: 'capabilities', gateway: 'meta_native_action', cursor: first.data.next_cursor},
      f.actor,
    );
    assert.equal(filtered.error?.code, 'INVALID_CURSOR');
    for (const args of [
      {action: 'capabilities', view: 'full'},
      {action: 'capabilities', view: 'graph', limit: 5},
      {action: 'capabilities', limit: 26},
      {action: 'dashboard', view: 'graph'},
      {action: 'dashboard', view: 'full', sections: ['accounts']},
      {action: 'dashboard', sections: ['everything']},
      {action: 'operations', view: 'summary'},
    ]) {
      const refused = await f.service.call('amcp_workspace', args, f.actor);
      assertRefused(refused, 'INVALID_ARGUMENT');
      assert.ok(refused.error.details?.field, JSON.stringify(refused.error));
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.close();
  }
});
// R2.5 M4a, the response budget (owner decision D14): a summary page is bounded by bytes as well as by count. `limit` is the most workflows a page holds,
// and a page ends early where its record would pass capabilitySummaryBytes, with at least one workflow so that paging always progresses.
test('capabilityPageLength: at most limit, within the budget, an oversize entry alone on its page, and a walk returns every entry once, in order', () => {
  const sum = page => page.reduce((n, size) => n + size, 0);
  // The page's record: what surrounds its list, its entries and one comma between two.
  const bytes = (fixed, page) => fixed + sum(page) + Math.max(0, page.length - 1);
  const walk = (sizes, limit, fixed, budget) => {
    const pages = [];
    for (let at = 0; at < sizes.length;) {
      const length = capabilityPageLength(sizes.slice(at), limit, fixed, budget);
      assert.ok(length >= 1, 'a page holds at least one entry while any is left');
      pages.push(sizes.slice(at, at + length));
      at += length;
    }
    return pages;
  };
  // A tiny budget of 100 bytes around 10: two 40-byte entries (91 bytes) fit, a third does not, and the 400-byte entry has a page of its own.
  const sizes = [40, 40, 400, 40, 40, 40, 40],
    pages = walk(sizes, 25, 10, 100);
  assert.deepEqual(pages, [[40, 40], [400], [40, 40], [40, 40]]);
  assert.deepEqual(pages.flat(), sizes, 'every entry once, in order');
  for (const page of pages) if (page.length > 1) assert.ok(bytes(10, page) <= 100, JSON.stringify(page));
  // The budget is a ceiling, not a target: a record of exactly 100 bytes fits, and one byte more does not.
  assert.equal(capabilityPageLength([40, 49, 10], 25, 10, 100), 2);
  assert.equal(capabilityPageLength([40, 50, 10], 25, 10, 100), 1);
  // limit stays the most entries, whatever room is left; no entry left is an empty page.
  assert.equal(capabilityPageLength([1, 1, 1, 1], 3, 0, 1000), 3);
  assert.equal(capabilityPageLength([], 20, 10, 100), 0);
  // An oversize first entry alone, even over a budget its record alone passes.
  assert.equal(capabilityPageLength([400, 1], 25, 10, 100), 1);
  // Any sizes, limits and budgets: every page within the budget unless it is one oversize entry, never more than limit, and the walk is the whole list.
  let seed = 7;
  const next = n => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let round = 0; round < 300; round++) {
    const list = Array.from({length: 1 + next(40)}, () => 1 + next(300)),
      limit = 1 + next(25),
      fixed = next(200),
      budget = 100 + next(1500);
    const walked = walk(list, limit, fixed, budget);
    assert.deepEqual(walked.flat(), list);
    for (const page of walked) {
      assert.ok(page.length <= limit);
      if (page.length > 1) assert.ok(bytes(fixed, page) <= budget, JSON.stringify({page, fixed, budget}));
    }
  }
});
test('summary pages end at the byte budget, never skip or repeat a workflow, and continue from the offset plus what was returned', async t => {
  t.mock.timers.enable({apis: ['Date'], now: 1800000000000});
  for (const large of [false, true]) {
    const f = surfaceFixture({large});
    try {
      const call = args => f.service.call('amcp_workspace', args, f.actor),
        graph = await call({action: 'capabilities', view: 'graph'}),
        ids = graph.data.workflows.map(w => w.id);
      for (const limit of [undefined, 1, 3, 25]) {
        const asked = limit === undefined ? {action: 'capabilities'} : {action: 'capabilities', limit};
        let page = await call(asked);
        const seen = [],
          sizes = [];
        for (;;) {
          assert.equal(page.success, true, JSON.stringify(page.error));
          const d = page.data;
          assert.equal(d.limit, limit ?? 20);
          assert.ok(d.returned >= 1 && d.returned <= d.limit, 'returned ' + d.returned + ' of at most ' + d.limit);
          assert.equal(d.returned, d.workflows.length);
          // The record is within the budget, or is one workflow that is over it by itself.
          assert.ok(
            Buffer.byteLength(JSON.stringify(d)) <= capabilitySummaryBytes || d.returned === 1,
            'page of ' + d.returned,
          );
          sizes.push(d.returned);
          seen.push(...d.workflows.map(w => w.id));
          assert.equal(d.has_more, seen.length < ids.length);
          assert.equal(d.total, ids.length);
          if (!d.has_more) {
            assert.equal(d.next_cursor, null);
            assert.equal(d.next_call, undefined);
            break;
          }
          // The cursor and the next call continue from offset plus returned: the next page starts at the workflow after the last one shown.
          assert.equal(d.next_call.arguments.cursor, d.next_cursor);
          assert.equal(d.next_call.arguments.limit, d.limit);
          page = await call({action: 'capabilities', ...(limit === undefined ? {} : {limit}), cursor: d.next_cursor});
          assert.equal(page.data.workflows[0].id, ids[seen.length], 'the next page starts where the last one ended');
        }
        assert.deepEqual(seen, ids, 'every workflow once, in order (limit ' + limit + ')');
        if (limit === 1 || limit === 3)
          assert.ok(
            sizes.slice(0, -1).every(n => n === limit),
            'a small limit still bounds the count',
          );
      }
    } finally {
      f.close();
    }
  }
});
test('guides are readable through a tool call, a section at a time, within the same budget', async () => {
  const f = surfaceFixture();
  try {
    const help = args => f.service.call('amcp_tool_help', args, f.actor);
    const list = await help({topic: 'guides'}),
      data = list.data ?? list;
    assert.equal(data.guides.length, 13);
    for (const guide of data.guides) {
      const index = await f.service.call(guide.index.tool, guide.index.arguments, f.actor),
        body = index.data ?? index;
      assert.ok(Buffer.byteLength(JSON.stringify(index)) <= 8 * kb, guide.name);
      const section = await help({topic: 'guides/' + guide.name + '/' + body.sections[0].id}),
        text = (section.data ?? section).text;
      assert.ok(text.length > 0 && Buffer.byteLength(JSON.stringify(section)) <= callBudget, guide.name);
    }
    const programs = await help({topic: 'guides/workspace/conditional-programs'});
    assert.match((programs.data ?? programs).text, /program:linkedin_forecast/);
    for (const topic of ['guides/../../.env', 'guides/unknown', 'guides/meta/no-such-section', 'files/meta']) {
      const refused = await help({topic});
      assert.equal(refused.error?.code, 'GUIDE_NOT_FOUND', topic);
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.close();
  }
});
