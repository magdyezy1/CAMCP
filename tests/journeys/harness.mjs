// Journey and MCP evaluation harness (QA-04). A real MCP SDK client talks to AMCP's MCP server over an in-memory
// transport; every provider is a synthetic in-process fake, so a run has zero egress. Each call is recorded as a
// transcript entry that keeps the tool, the action, the argument *shape* (keys and types, never values), the result
// code, the outcome state, the response size, the provider requests it caused and the next step it offered. Metrics are
// computed from transcripts alone, so tests/mcp-eval.test.mjs can check the arithmetic on hand-written transcripts.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../../dist/server/mcp.js';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';

export const metaConnection = 'aaaaaaaa-5555-4555-8555-00000000000a';
export const otherConnection = 'aaaaaaaa-5555-4555-8555-00000000000b';
const digest = value => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 16);

/** Keys and types of a value, never its contents: {a: 'string', b: ['number'], c: {d: 'boolean'}}. */
export function argumentShape(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return depth > 4 ? 'array' : value.length ? [argumentShape(value[0], depth + 1)] : [];
  if (typeof value === 'object') {
    if (depth > 4) return 'object';
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, argumentShape(value[key], depth + 1)]),
    );
  }
  return typeof value;
}

/** The next step a response offers, wherever the tool put it. */
export function offeredNextCall(response) {
  const call =
    response?.data?.next_call ??
    response?.error?.details?.next_call ??
    response?.meta?.workflow?.next_call ??
    response?.data?.current?.verification?.next_call;
  return call && typeof call.tool === 'string' && call.arguments && typeof call.arguments === 'object'
    ? call
    : undefined;
}
/** Whether a refusal or an attention state tells the person what to do next. */
export function offersNextStep(response) {
  const error = response?.error;
  return !!(
    offeredNextCall(response) ||
    (error && (error.next_action || error.remedy?.action || error.details?.next_action || error.details?.list_call))
  );
}
/** AMCP's outcome state of a response: its workflow state, else the record's own state, else ok or refused. */
export function outcomeState(response) {
  return (
    response?.meta?.workflow?.state ??
    response?.data?.state ??
    response?.data?.status ??
    (response?.success === false ? 'refused' : 'ok')
  );
}

/** Response faults for regression checks: each removes a seam the journeys rely on, as a code regression would. */
export const responseFaults = {
  // A server that stops offering next steps: clients have to guess the next call.
  'strip-next-call': response => {
    delete response?.data?.next_call;
    delete response?.error?.details?.next_call;
    delete response?.meta?.workflow?.next_call;
    if (response?.data?.current?.verification) delete response.data.current.verification.next_call;
    return response;
  },
  // A Home/Operations feed that misses attention states (the OPS-06 class of regression).
  'hide-attention': response => {
    if (Array.isArray(response?.data?.operations))
      response.data.operations = response.data.operations.filter(item => !item.attention_state);
    return response;
  },
};

/**
 * Synthetic providers. Meta Graph: account 123 is readable and writable; 456 is selected but the provider refuses it
 * (a permissions error); 789 belongs to a second client's connection. Campaign creates are accepted, lost (the
 * response never arrives) or meet a changed account, as each scenario sets. Tag Manager: account 44 has one container,
 * 45 is refused. Sheets: one owned tab that remembers which report it holds; a scenario can refuse the next batch.
 */
export function syntheticProviders() {
  const state = {
    requests: [],
    mutations: 0,
    lost: false,
    accountStatus: 1,
    insightsPaging: false,
    sheetsRefusal: false,
    records: new Map(),
    next: 120000000000001n,
    tab: {markers: [{metadataKey: 'amcp_destination', metadataValue: 'evaluation-dest', metadataId: 1}], report: null},
    metadataId: 10,
  };
  const tagManager = (url, method) => {
    if (method !== 'GET') throw Error('The evaluation fixture accepts no Tag Manager mutation');
    const parts = url.pathname.replace('/tagmanager/v2/', '').split('/');
    if (parts[1] === '45')
      return Response.json(
        {error: {code: 403, status: 'PERMISSION_DENIED', message: 'Synthetic tag account denial'}},
        {status: 403},
      );
    if (parts.length === 2) return Response.json({path: 'accounts/44', accountId: '44', name: 'Synthetic tag account'});
    if (parts.length === 3 && parts[2] === 'containers')
      return Response.json({
        container: [{path: 'accounts/44/containers/55', accountId: '44', containerId: '55', name: 'Synthetic container'}],
      });
    throw Error('The evaluation fixture has no Tag Manager resource ' + url.pathname);
  };
  const sheets = (url, method, init) => {
    if (method === 'GET')
      return Response.json({
        spreadsheetId: 'evaluationSheet',
        properties: {title: 'Synthetic evaluation spreadsheet'},
        sheets: [
          {
            properties: {sheetId: 7, title: 'Client report', gridProperties: {rowCount: 100, columnCount: 40}},
            developerMetadata: state.tab.markers.map(m => ({...m})),
          },
        ],
      });
    state.mutations++;
    if (state.sheetsRefusal)
      return Response.json({error: {code: 403, status: 'PERMISSION_DENIED', message: 'Synthetic'}}, {status: 403});
    const body = JSON.parse(String(init.body));
    for (const r of body.requests) {
      if (r.createDeveloperMetadata)
        state.tab.markers.push({...r.createDeveloperMetadata.developerMetadata, metadataId: state.metadataId++});
      if (r.updateDeveloperMetadata) {
        const id = r.updateDeveloperMetadata.dataFilters[0].developerMetadataLookup.metadataId,
          marker = state.tab.markers.find(m => m.metadataId === id);
        if (marker) marker.metadataValue = r.updateDeveloperMetadata.developerMetadata.metadataValue;
      }
      if (r.deleteDeveloperMetadata) {
        const key = r.deleteDeveloperMetadata.dataFilter.developerMetadataLookup.metadataKey;
        state.tab.markers = state.tab.markers.filter(m => m.metadataKey !== key);
      }
      if (r.updateCells?.rows?.length > 1) {
        const header = r.updateCells.rows[0].values.map(v => v.userEnteredValue?.stringValue);
        state.tab.report =
          r.updateCells.rows[1].values[header.indexOf('Report ID')]?.userEnteredValue?.stringValue ?? null;
      }
    }
    return Response.json({spreadsheetId: 'evaluationSheet', replies: body.requests.map(() => ({}))});
  };
  const formValue = value => {
    try {
      return /^[[{]|^(?:true|false)$/.test(value) ? JSON.parse(value) : value;
    } catch {
      return value;
    }
  };
  const fetcher = async (raw, init = {}) => {
    const url = new URL(String(raw)),
      method = String(init.method ?? 'GET').toUpperCase();
    state.requests.push({method, host: url.hostname, path: url.pathname});
    if (url.hostname === 'tagmanager.googleapis.com') return tagManager(url, method);
    if (url.hostname === 'sheets.googleapis.com') return sheets(url, method, init);
    if (url.hostname !== 'graph.facebook.com') throw Error('The evaluation fixture refuses egress: ' + url.hostname);
    const id = url.pathname.split('/').filter(Boolean)[1];
    if (id === 'act_456')
      return Response.json(
        {error: {message: '(#200) Synthetic permissions error', type: 'OAuthException', code: 200, fbtrace_id: 'SYN'}},
        {status: 403},
      );
    if (url.pathname.endsWith('/insights'))
      return Response.json({
        data: [
          {campaign_id: '111', campaign_name: 'Synthetic campaign', spend: '12.01', impressions: '2000', clicks: '50'},
        ],
        ...(state.insightsPaging ? {paging: {next: 'https://graph.facebook.com/v26.0/next-page'}} : {}),
      });
    if (method === 'GET') {
      if (/^act_\d+$/.test(id))
        return Response.json({
          id,
          name: 'Synthetic ' + id,
          account_status: state.accountStatus,
          currency: 'USD',
          timezone_name: 'UTC',
        });
      return Response.json(state.records.get(id) ?? {id, name: 'Synthetic', status: 'PAUSED'});
    }
    state.mutations++;
    if (state.lost) throw new TypeError('fetch failed');
    const body = Object.fromEntries([...new URLSearchParams(String(init.body ?? ''))].map(([k, v]) => [k, formValue(v)])),
      created = String(state.next++);
    state.records.set(created, {id: created, ...body});
    return Response.json({id: created});
  };
  return {state, fetcher};
}

/** An MCP server over a store with two clients' Meta connections, and a recording SDK client. */
export async function evaluationFixture({fault, role = 'operator'} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 111).toString('base64')),
    identity = {tenantId: 'journey-evaluation', userId: 'evaluator', role},
    admin = {...identity, role: 'admin'},
    key = store.createKey(identity),
    actor = store.authenticate(key),
    meta = syntheticMeta();
  for (const [id, label, accounts, writeAccounts] of [
    [metaConnection, 'Client A Meta', ['123', '456'], ['123']],
    [otherConnection, 'Client B Meta', ['789', '123'], ['789']],
  ])
    store.putConnection(
      admin,
      {
        id,
        tenantId: identity.tenantId,
        gateway: 'meta_native_action',
        accounts,
        writeAccounts,
        enabled: true,
        label,
        scopes: ['ads_management', 'ads_read'],
      },
      {accessToken: 'synthetic-' + id.slice(-1)},
    );
  const service = new MirrorService(new Registry(), store, new NativeTransport(meta.fetcher), undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const server = createMcpServer(service, actor),
    client = new Client({name: 'AMCP synthetic journey evaluator', version: '1.0.0'});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  const discovery = {
    tools: listed.tools.length,
    tools_list_bytes: Buffer.byteLength(JSON.stringify(listed.tools)),
    instructions_bytes: Buffer.byteLength(client.getInstructions() ?? ''),
  };
  const transcript = [],
    alter = fault ? responseFaults[fault] : undefined;
  assert.ok(!fault || alter, 'Unknown response fault ' + fault);
  /** Calls a tool and records it. `context` marks a followed next_call or a synthetic user approval. */
  const call = async (tool, args, context = {}) => {
    const before = meta.state.requests.length,
      response = await client.callTool({name: tool, arguments: args}),
      text = JSON.stringify(response.structuredContent);
    assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent, 'text equals structuredContent');
    const result = alter ? alter(structuredClone(response.structuredContent)) : response.structuredContent,
      next = offeredNextCall(result);
    transcript.push({
      tool,
      action: typeof args.action === 'string' ? args.action : (args.gateway ?? null),
      operation: typeof args.operation === 'string' ? args.operation : undefined,
      shape: argumentShape(args),
      args_digest: digest({tool, args}),
      success: result.success === true,
      code: result.success === false ? (result.error?.code ?? 'UNKNOWN') : null,
      state: outcomeState(result),
      bytes: Buffer.byteLength(text),
      provider_requests: meta.state.requests.length - before,
      next_call: next ? {tool: next.tool, action: next.arguments.action ?? null} : null,
      next_step: offersNextStep(result),
      website_path: result.meta?.workflow?.website_path ?? null,
      gateway_help: tool === 'amcp_tool_help' && !!args.operation && result.success === true && !result.data?.operation,
      followed_next_call: context.followed === true,
      user_approval: context.approval === true,
    });
    return result;
  };
  return {
    store,
    actor,
    service,
    meta,
    discovery,
    transcript,
    call,
    close: async () => {
      await client.close();
      await server.close();
      store.close();
    },
  };
}

/** The end of a scripted branch (M2): success, a handled failure with a next step, or a dead end without one. */
export function endState(transcript, goalReached) {
  if (goalReached) return 'success';
  const last = transcript.at(-1);
  return last?.next_step ? 'handled_failure' : 'dead_end';
}

/** Per-run measures (M2, M4) from a transcript: calls, sizes, provider requests, refusals and next-step use. */
export function transcriptMetrics(transcript, {reference = [], goalReached = false} = {}) {
  const refused = new Set();
  let repeated = 0;
  for (const entry of transcript)
    if (!entry.success) {
      if (refused.has(entry.args_digest)) repeated++;
      refused.add(entry.args_digest);
    }
  const productive = transcript.filter(entry => entry.tool !== 'amcp_tool_help'),
    first = productive[0],
    expected = reference[0];
  return {
    tool_calls: transcript.length,
    help_calls: transcript.length - productive.length,
    response_bytes: transcript.reduce((sum, entry) => sum + entry.bytes, 0),
    provider_requests: transcript.reduce((sum, entry) => sum + entry.provider_requests, 0),
    refused_calls: transcript.filter(entry => !entry.success).length,
    repeated_refused_calls: repeated,
    unnecessary_calls: Math.max(0, transcript.length - reference.length),
    correct_tool_choice: expected ? !!first && first.tool === expected.tool && first.action === expected.action : null,
    gateway_help_for_operation: transcript.filter(entry => entry.gateway_help).length,
    followed_next_calls: transcript.filter(entry => entry.followed_next_call).length,
    wrong_next_calls: transcript.filter(
      entry =>
        entry.followed_next_call &&
        !entry.success &&
        ['INVALID_ARGUMENT', 'UNKNOWN_OPERATION', 'NOT_FOUND', 'RESOURCE_NOT_FOUND', 'VALIDATION_FAILED'].includes(
          entry.code,
        ),
    ).length,
    next_call_absent_at_stop: !goalReached && !transcript.at(-1)?.next_call,
    user_approvals: transcript.filter(entry => entry.user_approval).length,
    handoff_success: goalReached,
    end_state: endState(transcript, goalReached),
  };
}

/**
 * Compares a run with the committed baseline. Calls, refusals and provider requests may not rise, the end state may not
 * change, and response bytes may grow at most `bytesTolerance` (fixed-width IDs and times vary slightly).
 */
export function compareWithBaseline(current, baseline, {bytesTolerance = 0.1, bytesSlack = 512} = {}) {
  const regressions = [],
    improvements = [];
  for (const [suite, runs] of Object.entries(baseline.runs ?? {}))
    for (const [id, expected] of Object.entries(runs)) {
      const actual = current.runs?.[suite]?.[id];
      if (!actual) {
        regressions.push({suite, id, field: 'missing', expected: 'present', actual: null});
        continue;
      }
      for (const field of [
        'tool_calls',
        'refused_calls',
        'repeated_refused_calls',
        'unnecessary_calls',
        'provider_requests',
        'user_approvals',
        'wrong_next_calls',
      ])
        if (actual[field] > expected[field])
          regressions.push({suite, id, field, expected: expected[field], actual: actual[field]});
        else if (actual[field] < expected[field])
          improvements.push({suite, id, field, expected: expected[field], actual: actual[field]});
      for (const field of ['end_state', 'handoff_success', 'correct_tool_choice'])
        if (actual[field] !== expected[field])
          regressions.push({suite, id, field, expected: expected[field], actual: actual[field]});
      const limit = Math.ceil(expected.response_bytes * (1 + bytesTolerance)) + bytesSlack;
      if (actual.response_bytes > limit)
        regressions.push({suite, id, field: 'response_bytes', expected: expected.response_bytes, actual: actual.response_bytes, limit});
    }
  for (const [suite, runs] of Object.entries(current.runs ?? {}))
    for (const id of Object.keys(runs))
      if (!baseline.runs?.[suite]?.[id]) improvements.push({suite, id, field: 'new_run', expected: null, actual: 'present'});
  return {passed: regressions.length === 0, regressions, improvements};
}
