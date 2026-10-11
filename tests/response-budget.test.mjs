import test from 'node:test';
import assert from 'node:assert/strict';
import {measureSurface, surfaceFixture} from '../tools/measure-tool-list.mjs';
import {capabilityGraph} from '../dist/src/capability-graph.js';
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
    assert.ok(m.tools_list[mode].tools >= 27, mode);
    for (const [name, length] of Object.entries(m.tools_list[mode].descriptions))
      assert.ok(length <= 2000, mode + ' ' + name + ' ' + length);
  }
});
test('the capabilities summary and the default dashboard stay within the response budget', async () => {
  const m = await surface();
  assert.ok(m.capabilities.one_connection.summary_largest_page <= 15 * kb, JSON.stringify(m.capabilities));
  assert.ok(m.capabilities.six_providers_20_accounts.summary_largest_page <= 40 * kb, JSON.stringify(m.capabilities));
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
    assert.equal(first.data.returned, 20);
    assert.equal(first.data.has_more, true);
    // A summary never upgrades: every blocker of the graph is carried through.
    const fromGraph = graph.data.workflows.slice(0, 20);
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
test('guides are readable through a tool call, a section at a time, within the same budget', async () => {
  const f = surfaceFixture();
  try {
    const help = args => f.service.call('amcp_tool_help', args, f.actor);
    const list = await help({topic: 'guides'}),
      data = list.data ?? list;
    assert.equal(data.guides.length, 13);
    for (const guide of data.guides) {
      const index = await help(guide.index.arguments),
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
