// V2-MCP-02 (decision 4): amcp_reporting_overview and amcp_reporting declare a typed result. The 2026-07-28 revision
// requires structured content to conform to the schema a tool declares, and the SDK's clients check it, so a type that one
// action's real answer breaks would refuse that answer to every such client. These tests call every action of both tools
// through a real SDK client (which validates each answer against the listed outputSchema and throws on a mismatch) and
// validate the same answers once more with a JSON Schema validator: every action's answer to a bare call, the refusals
// every action can give, and the success of every action a synthetic workspace can run without a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client, InMemoryTransport} from '@modelcontextprotocol/client';
import {createMcpServer} from '../dist/server/mcp.js';
import {outcomeSchema} from '../dist/src/workflow-outcomes.js';
import {reportEngine} from './helpers/report-engine.mjs';
import {row} from './helpers/report-packets.mjs';
import {offerParkedProviders} from './helpers/parked-providers.mjs';

offerParkedProviders('criteo', 'woocommerce');
const typed = await import('../dist/src/report-tool-output.js').catch(() => ({typedToolData: {}}));
const overviewTool = 'amcp_reporting_overview',
  reportingTool = 'amcp_reporting';
const rows = {
  campaign: [row('campaign', 'c1', {spend: '30'}, {campaign_name: 'Spring sale'})],
  adset: [row('adset', 's1', {spend: '20'}, {entity_name: 'Prospecting'})],
  ad: [row('ad', 'a1', {spend: '10'}, {entity_name: 'Hero video'})],
};

async function connected(t) {
  const e = reportEngine(t, {rowsFor: level => rows[level]}),
    server = createMcpServer(e.service, e.actor),
    client = new Client({name: 'Synthetic typed-output client', version: '1'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const tools = (await client.listTools()).tools,
    ajv = new Ajv({strict: false}),
    validators = new Map(tools.map(tool => [tool.name, ajv.compile(tool.outputSchema)])),
    seen = {success: new Set(), refused: new Set()};
  /** One call: the SDK client validates the answer on the way, and the validator again below. */
  const call = async (name, args) => {
    const result = await client.callTool({name, arguments: args}),
      content = JSON.parse(JSON.stringify(result.structuredContent)),
      validate = validators.get(name);
    assert.ok(
      validate(content),
      name + ' ' + JSON.stringify(args).slice(0, 120) + ': ' + JSON.stringify(validate.errors),
    );
    assert.equal(result.isError === true, content.success === false);
    (content.success ? seen.success : seen.refused).add(name + ' ' + args.action);
    return content;
  };
  // A finished report of three levels, run for real over the fake collector.
  const queued = await e.overview.handle(
    {action: 'run', confirmed: true, config: e.definition(['campaign', 'adset', 'ad'])},
    e.actor,
  );
  await e.worker.once();
  return {...e, tools, call, seen, validators, reportId: queued.id};
}

test('the two tools type the fields their actions share, and the schema is an object with no root combinator', async t => {
  const f = await connected(t);
  for (const name of [overviewTool, reportingTool]) {
    const listed = f.tools.find(tool => tool.name === name).outputSchema;
    assert.equal(listed.type, 'object', name);
    for (const keyword of ['anyOf', 'oneOf', 'allOf', 'not'])
      assert.equal(listed[keyword], undefined, name + ' ' + keyword);
    assert.deepEqual(listed.required, ['success'], name);
    assert.deepEqual(listed.properties.meta.properties.workflow, outcomeSchema, name);
    assert.deepEqual(listed.properties.data, typed.typedToolData[name], name);
    assert.equal(listed.properties.data.type, 'object', name);
    assert.notEqual(
      listed.properties.data.additionalProperties,
      false,
      name + ' leaves its results open to later fields',
    );
  }
  assert.deepEqual(
    Object.keys(f.tools.find(tool => tool.name === overviewTool).outputSchema.properties.data.properties),
    ['id', 'state', 'job_id', 'next_call', 'poll_after_ms', 'has_more', 'next_offset', 'next_cursor'],
  );
  // The tools that do not type their result are unchanged: `data` is open.
  for (const tool of f.tools.filter(item => ![overviewTool, reportingTool].includes(item.name)))
    assert.deepEqual(tool.outputSchema.properties.data, {}, tool.name);
  // The types are not vacuous: an answer that breaks them is refused.
  const validate = f.validators.get(overviewTool);
  assert.equal(validate({success: true, data: {id: 'a', state: 'queued', has_more: false, next_offset: null}}), true);
  for (const wrong of [
    {id: 7},
    {state: 1},
    {job_id: {}},
    {next_call: 'get'},
    {poll_after_ms: '5000'},
    {has_more: 'no'},
    {next_offset: '4'},
    {next_cursor: 4},
  ])
    assert.equal(validate({success: true, data: wrong}), false, JSON.stringify(wrong));
  assert.equal(validate({success: true, data: {id: 'a', anything_else: [1, 2], rows: 3}}), true);
  // The outcome schema repeats in six tools; the property that constrained nothing is not spent on, and a workflow
  // outcome with any source_state, or none, still conforms.
  const outcome = new Ajv({strict: false}).compile(outcomeSchema),
    base = {version: 1, state: 'inspect', automatic_retry_of_mutation: false};
  for (const source_state of [undefined, null, 'queued', {a: 1}]) assert.equal(outcome({...base, source_state}), true);
  assert.equal(outcome({...base, automatic_retry_of_mutation: true}), false);
});

test('every action of amcp_reporting_overview answers a conforming envelope, and the actions a workspace can run without a provider answer conforming successes', async t => {
  const f = await connected(t),
    overview = f.tools.find(tool => tool.name === overviewTool),
    reportId = f.reportId,
    call = args => f.call(overviewTool, args);
  // Every action called with only what it cannot do without: whatever it answers, a refusal for want of its inputs or a
  // success, conforms.
  for (const action of overview.inputSchema.properties.action.enum) await call({action, confirmed: true});
  // And the refusals every action can give: an unknown snapshot, an unknown action and values the tables do not have.
  for (const args of [
    {action: 'get', id: 'no-such-snapshot'},
    {action: 'no_such_action'},
    {action: 'get', id: reportId, platform: 'google_ads'},
    {action: 'list', limit: 1000},
  ])
    assert.equal((await call(args)).success, false, JSON.stringify(args));
  const config = {
    name: 'Synthetic typed output',
    sources: [{platform: 'meta', account_id: '100', connection_id: 'login', levels: ['campaign']}],
    date_range: {since: '2026-09-01', until: '2026-09-02'},
    metrics: ['spend', 'impressions', 'clicks'],
  };
  const ok = async args => {
    const out = await call(args);
    assert.equal(out.success, true, JSON.stringify(args) + ' ' + JSON.stringify(out.error));
    return out.data;
  };
  await ok({action: 'help'});
  await ok({action: 'help', topic: 'get'});
  await ok({action: 'bootstrap'});
  await ok({action: 'list', limit: 5});
  await ok({action: 'list', limit: 1, platform: 'meta'});
  const got = await ok({action: 'get', id: reportId, limit: 1});
  assert.equal(got.state, 'complete');
  assert.equal(got.has_more, true);
  assert.equal(got.next_offset, 1);
  const narrowed = await ok({action: 'get', id: reportId, limit: 1, platform: 'meta'});
  assert.equal(narrowed.has_more, true);
  assert.equal(narrowed.next_offset, null);
  assert.equal(typeof narrowed.next_cursor, 'string');
  assert.equal((await ok(narrowed.next_call.arguments)).offset, 1);
  await ok({action: 'report_pack', id: reportId});
  await ok({action: 'presentation_profiles', id: reportId});
  await ok({action: 'compare_candidates', id: reportId});
  const saved = await ok({action: 'save', config, confirmed: true});
  await ok({action: 'save_template', config, confirmed: true});
  const run = await ok({action: 'run', config, confirmed: true});
  assert.equal(run.state, 'queued');
  assert.equal(typeof run.next_call, 'object');
  assert.equal(run.poll_after_ms, 5000);
  const stopped = await ok({action: 'cancel', id: run.job_id, confirmed: true});
  assert.equal(stopped.state, 'cancelled');
  const retried = await ok({action: 'retry', id: run.job_id, confirmed: true});
  assert.equal(retried.state, 'queued');
  assert.equal(typeof retried.poll_after_ms, 'number');
  const destination = await ok({
    action: 'bind_file_destination',
    idempotency_key: 'typed-output-files',
    confirmed: true,
    file_destination: {name: 'Typed output files', formats: ['pdf']},
  });
  const exported = await ok({action: 'export', report_id: reportId, destination_id: destination.id, confirmed: true});
  assert.equal(exported.state, 'queued');
  assert.equal(typeof exported.job_id, 'string');
  const status = await ok({action: 'export_status', id: exported.id});
  assert.equal(status.state, 'queued');
  assert.equal(typeof status.poll_after_ms, 'number');
  await ok({action: 'delete_view', id: saved.id, expected_revision: saved.revision, confirmed: true});
  // Every action was answered at least once, and these were not answered with a success: they read or write a provider,
  // or a workbook, or need an earlier schedule; their results are the shapes the code returns (ids and states are text,
  // counts and flags as typed), which the tests of those flows pin.
  const answered = action =>
    f.seen.success.has(overviewTool + ' ' + action) || f.seen.refused.has(overviewTool + ' ' + action);
  assert.deepEqual(
    overview.inputSchema.properties.action.enum.filter(action => !answered(action)),
    [],
    'every action was answered',
  );
  const refusedOnly = overview.inputSchema.properties.action.enum.filter(
    action => !f.seen.success.has(overviewTool + ' ' + action),
  );
  assert.deepEqual(refusedOnly.sort(), [
    'apply_profile_presentation',
    'bind_destination',
    'compare',
    'create_spreadsheet',
    'delete_report',
    'delete_schedule',
    'delete_template',
    'move_workbook_schedule',
    'pause_schedule',
    'preview_schedule',
    'preview_workbook_move',
    'remove_schedule',
    'resolve_delivery',
    'resume_schedule',
    'save_presentation',
    'schedule',
    'undo_workbook_move',
    'update_schedule',
  ]);
});

test('every action of amcp_reporting answers a conforming envelope, and the actions that read nothing answer conforming successes', async t => {
  const f = await connected(t),
    reporting = f.tools.find(tool => tool.name === reportingTool);
  for (const action of reporting.inputSchema.properties.action.enum)
    await f.call(reportingTool, {action, confirmed: true});
  for (const args of [
    {action: 'help'},
    {action: 'help', topic: 'get'},
    {action: 'capture_presets'},
    {action: 'list'},
  ]) {
    const out = await f.call(reportingTool, args);
    assert.equal(out.success, true, JSON.stringify(args) + ' ' + JSON.stringify(out.error));
  }
  const listed = await f.call(reportingTool, {action: 'list'});
  assert.equal(listed.data.has_more, false);
  for (const args of [{action: 'get', id: 'no-such-report'}, {action: 'no_such_action'}])
    assert.equal((await f.call(reportingTool, args)).success, false, JSON.stringify(args));
});
