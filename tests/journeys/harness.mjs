// Journey and MCP evaluation harness (QA-04). A real MCP SDK client talks to AMCP's MCP server over an in-memory
// transport, and the website's own HTTP API runs on a loopback listener over the same store, so a journey can cross
// from the MCP client to the website as a person would. Every provider is a synthetic in-process fake and every other
// host is refused, so a run has zero egress.
//
// Each call is recorded as a transcript entry that keeps the surface (mcp or web), the tool and action, the argument
// *shape* (keys and types, never values), the result code, the outcome state, the response size, the provider requests
// it caused and the next step it offered. No provider text and no argument value is kept. Metrics are computed from
// transcripts alone, so tests/mcp-eval.test.mjs checks the arithmetic on hand-written transcripts, and an external
// client's sanitized transcript (tools/mcp-eval.mjs --transcript) is measured by the same code.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../../dist/server/mcp.js';
import {createWebsite} from '../../dist/server/website.js';
import {createHttpApp} from '../../dist/server/http-app.js';
import {listenForFetch} from '../../dist/tests/http-listener.js';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {ReportingOverview} from '../../dist/src/reporting-overview.js';
import {ReportWorker} from '../../dist/src/worker.js';
import {sheetsGateway} from '../../dist/src/google-sheets.js';

export const metaConnection = 'aaaaaaaa-5555-4555-8555-00000000000a';
export const otherConnection = 'aaaaaaaa-5555-4555-8555-00000000000b';
export const sheetsConnection = 'aaaaaaaa-5555-4555-8555-00000000000c';
export const evaluationSheet = 'evaluationSheet';
export const evaluationDestination = 'evaluation-dest';
export const gtmConnection = 'aaaaaaaa-5555-4555-8555-00000000000d';
export const gtmWorkspacePath = 'accounts/44/containers/55/workspaces/66';
const tenantId = 'journey-evaluation';
const digest = value =>
  createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex')
    .slice(0, 16);

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

/** The next call a response offers, wherever the tool put it. */
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
/**
 * Whether a response tells the person what to do next: an offered call, a refusal's next action or remedy (also on a
 * plan's current or inspected step), a list call to find the right identifier, a blocked check's next step, an
 * execution journal's next safe action, or a data-quality recommendation that names what to refresh.
 */
export function offersNextStep(response) {
  const data = response?.data,
    errors = [response?.error, data?.current?.error, data?.step?.error];
  return !!(
    offeredNextCall(response) ||
    errors.some(
      error =>
        error &&
        typeof error === 'object' &&
        (error.next_action || error.remedy?.action || error.details?.next_action || error.details?.list_call),
    ) ||
    (Array.isArray(data?.checks) && data.checks.some(check => check?.next_step)) ||
    (Array.isArray(data?.execution_journal) && data.execution_journal.some(entry => entry?.next_safe_action)) ||
    (Array.isArray(data?.recommendations) &&
      data.recommendations.some(item => item?.type === 'data_quality' && typeof item.proposal === 'string'))
  );
}
/** AMCP's outcome state of a response: its workflow state, else the record's own state, else ok or refused. */
export function outcomeState(response) {
  const state =
    response?.meta?.workflow?.state ??
    response?.data?.state ??
    response?.data?.status ??
    (response?.success === false ? 'refused' : 'ok');
  return typeof state === 'string' ? state : 'ok';
}

/**
 * One transcript entry: the surface, the tool and action, the argument shape (never values), a short digest that only
 * tells an identical repeat apart, the result code and outcome state, the response size, the provider requests the call
 * caused (null when unknown, as for an external client), the next call offered (tool and action only), whether a next
 * step was offered, the website path handed off, and whether the call followed an offered next call or carried the
 * person's approval.
 */
export function transcriptEntry({
  surface = 'mcp',
  tool,
  args,
  result,
  bytes,
  httpStatus,
  providerRequests = null,
  followed = false,
  approval = false,
}) {
  const next = offeredNextCall(result);
  return {
    surface,
    tool,
    action: typeof args?.action === 'string' ? args.action : null,
    operation: typeof args?.operation === 'string' ? args.operation : undefined,
    shape: argumentShape(args ?? {}),
    args_digest: digest({tool, args}),
    success: result?.success === true,
    code: result?.success === true ? null : (result?.error?.code ?? 'HTTP_' + (httpStatus ?? 'UNKNOWN')),
    state: outcomeState(result),
    bytes: Number.isInteger(bytes) ? bytes : Buffer.byteLength(JSON.stringify(result ?? null)),
    provider_requests: providerRequests,
    next_call: next ? {tool: next.tool, action: next.arguments.action ?? null} : null,
    next_step: offersNextStep(result),
    website_path: typeof result?.meta?.workflow?.website_path === 'string' ? result.meta.workflow.website_path : null,
    followed_next_call: followed === true,
    user_approval: approval === true,
  };
}

/** Keys a sanitized transcript entry may carry; anything else (arguments, results, text) is refused. */
export const transcriptKeys = Object.freeze([
  'surface',
  'tool',
  'action',
  'operation',
  'shape',
  'args_digest',
  'success',
  'code',
  'state',
  'bytes',
  'provider_requests',
  'next_call',
  'next_step',
  'website_path',
  'followed_next_call',
  'user_approval',
]);
const shapeLeaves = new Set(['string', 'number', 'boolean', 'null', 'undefined', 'bigint', 'object', 'array']);
const isShape = (value, depth = 0) =>
  depth <= 6 &&
  (typeof value === 'string'
    ? shapeLeaves.has(value)
    : Array.isArray(value)
      ? value.length <= 1 && value.every(item => isShape(item, depth + 1))
      : !!value && typeof value === 'object' && Object.values(value).every(item => isShape(item, depth + 1)));

/**
 * The transcript as it may leave the run: website paths lose their query (identifiers), and an entry with any key
 * outside `transcriptKeys`, a non-shape `shape`, or an `args_digest` that is not 16 hex characters is refused, so a
 * transcript can never carry argument values, provider text or response bodies.
 */
export function sanitizeTranscript(entries) {
  if (!Array.isArray(entries)) throw Error('MCP_EVAL_TRANSCRIPT_INVALID');
  return entries.map((entry, index) => {
    const extra = Object.keys(entry ?? {}).filter(key => !transcriptKeys.includes(key));
    if (!entry || typeof entry !== 'object' || extra.length)
      throw Error('MCP_EVAL_TRANSCRIPT_NOT_SANITIZED at ' + index + ': ' + extra.join(', '));
    if (
      typeof entry.tool !== 'string' ||
      !/^[A-Za-z0-9_:. /-]{1,120}$/.test(entry.tool) ||
      typeof entry.success !== 'boolean'
    )
      throw Error('MCP_EVAL_TRANSCRIPT_INVALID at ' + index);
    if (entry.shape !== undefined && !isShape(entry.shape))
      throw Error('MCP_EVAL_TRANSCRIPT_NOT_SANITIZED at ' + index + ': shape');
    if (entry.args_digest !== undefined && !/^[0-9a-f]{16}$/.test(String(entry.args_digest)))
      throw Error('MCP_EVAL_TRANSCRIPT_NOT_SANITIZED at ' + index + ': args_digest');
    const token = value => value == null || /^[A-Za-z0-9_:. -]{1,80}$/.test(String(value));
    for (const key of ['code', 'state', 'action', 'operation'])
      if (!token(entry[key])) throw Error('MCP_EVAL_TRANSCRIPT_NOT_SANITIZED at ' + index + ': ' + key);
    const next = entry.next_call;
    if (
      next != null &&
      (typeof next !== 'object' ||
        Object.keys(next).some(key => key !== 'tool' && key !== 'action') ||
        !token(next.tool) ||
        !token(next.action))
    )
      throw Error('MCP_EVAL_TRANSCRIPT_NOT_SANITIZED at ' + index + ': next_call');
    const path = typeof entry.website_path === 'string' ? entry.website_path.split(/[?#]/)[0] : null;
    return {...entry, website_path: path};
  });
}

/**
 * Turns an external client's raw call log ([{tool, arguments, result, followed?, approval?, surface?}]) into a
 * sanitized transcript, locally, so only shapes, codes, states and sizes are kept.
 */
export function sanitizeRawCalls(calls) {
  if (!Array.isArray(calls)) throw Error('MCP_EVAL_TRANSCRIPT_INVALID');
  return sanitizeTranscript(
    calls.map(call =>
      transcriptEntry({
        surface: call?.surface === 'web' ? 'web' : 'mcp',
        tool: String(call?.tool ?? ''),
        args: call?.arguments ?? {},
        result: call?.result,
        followed: call?.followed === true,
        approval: call?.approval === true,
      }),
    ),
  );
}

/**
 * Response faults for the deliberate-regression check: each removes a seam the journeys rely on, as a code regression
 * would, so the budget comparison must fail when one is applied.
 */
export const responseFaults = {
  // A server that stops offering next calls: clients have to guess the next call.
  'strip-next-call': response => {
    if (response?.data && typeof response.data === 'object') delete response.data.next_call;
    if (response?.error?.details) delete response.error.details.next_call;
    if (response?.meta?.workflow) delete response.meta.workflow.next_call;
    if (response?.data?.current?.verification) delete response.data.current.verification.next_call;
    for (const item of response?.data?.operations ?? []) delete item.next_call;
    return response;
  },
  // A Home/Operations feed that misses attention states (the class of regression OPS-06 fixed on Home).
  'hide-attention': response => {
    if (Array.isArray(response?.data?.operations))
      response.data.operations = response.data.operations.filter(item => item.category !== 'attention');
    return response;
  },
};

const formValue = value => {
  try {
    return /^[[{]|^(?:true|false)$/.test(value) ? JSON.parse(value) : value;
  } catch {
    return value;
  }
};

/**
 * Synthetic providers. Meta Graph: account 123 is readable and writable; 456 is selected but the provider refuses it
 * (a permissions error); 789 belongs to a second client's connection. Campaign creates are accepted, lost (the provider
 * applies the create and the response never arrives) or meet a changed account, as each scenario sets; `outage` makes
 * every Meta read fail with a provider 500. Sheets: one owned tab that remembers which report it holds; a scenario can
 * refuse the next batch. Any other host is refused and counted as egress.
 */
export function syntheticProviders() {
  const state = {
    requests: [],
    mutations: 0,
    egress_refused: 0,
    lost: false,
    outage: false,
    accountStatus: 1,
    insightsPaging: false,
    sheetsRefusal: false,
    records: new Map(),
    next: 120000000000001n,
    tab: {
      markers: [{metadataKey: 'amcp_destination', metadataValue: evaluationDestination, metadataId: 1}],
      report: null,
    },
    metadataId: 10,
    // Tag Manager account 44, container 55, workspace 66: tag 001 has no consent setting, 002 needs analytics_storage.
    gtm: {
      workspace: {
        path: gtmWorkspacePath,
        accountId: '44',
        containerId: '55',
        workspaceId: '66',
        name: 'Evaluation workspace',
        fingerprint: 'workspace-1',
      },
      tags: new Map(
        ['001', '002'].map(id => [
          id,
          {
            path: gtmWorkspacePath + '/tags/' + id,
            accountId: '44',
            containerId: '55',
            workspaceId: '66',
            tagId: id,
            name: 'Evaluation tag ' + id,
            type: 'html',
            fingerprint: 'tag-' + id,
            paused: true,
            firingTriggerId: ['7'],
            parameter: [{type: 'template', key: 'html', value: 'SYNTHETIC-SCRIPT'}],
            ...(id === '002'
              ? {
                  consentSettings: {
                    consentStatus: 'needed',
                    consentType: {type: 'list', list: [{type: 'template', value: 'analytics_storage'}]},
                  },
                }
              : {}),
          },
        ]),
      ),
    },
  };
  const sheets = (url, method, init) => {
    if (method === 'GET')
      return Response.json({
        spreadsheetId: evaluationSheet,
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
      return Response.json(
        {error: {code: 403, status: 'PERMISSION_DENIED', message: 'Synthetic sheet denial'}},
        {status: 403},
      );
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
    return Response.json({spreadsheetId: evaluationSheet, replies: body.requests.map(() => ({}))});
  };
  const meta = (url, method, init) => {
    const id = url.pathname.split('/').filter(Boolean)[1];
    if (state.outage)
      return Response.json(
        {error: {message: 'Synthetic service error', type: 'OAuthException', code: 2, is_transient: true}},
        {status: 500},
      );
    if (id === 'act_456')
      return Response.json(
        {error: {message: '(#200) Synthetic permissions error', type: 'OAuthException', code: 200, fbtrace_id: 'SYN'}},
        {status: 403},
      );
    if (url.pathname.endsWith('/insights'))
      return Response.json({
        data: [
          {
            account_id: id.replace('act_', ''),
            account_currency: 'USD',
            campaign_id: '10',
            campaign_name: 'Synthetic campaign',
            adset_id: '20',
            ad_id: '30',
            ad_name: 'Synthetic ad',
            date_start: '2026-09-01',
            date_stop: '2026-09-01',
            spend: '12.5',
            clicks: '10',
            impressions: '100',
            actions: [{action_type: 'offsite_conversion.fb_pixel_purchase', value: '2'}],
          },
        ],
        ...(state.insightsPaging
          ? {paging: {next: 'https://graph.facebook.com/v26.0/' + id + '/insights?after=2'}}
          : {}),
      });
    if (method === 'GET') {
      if (/^act_\d+$/.test(id))
        return Response.json({
          id,
          account_id: id.replace('act_', ''),
          name: 'Synthetic ' + id,
          account_status: state.accountStatus,
          currency: 'USD',
          timezone_name: 'UTC',
        });
      return Response.json(state.records.get(id) ?? {id, name: 'Synthetic', status: 'PAUSED'});
    }
    state.mutations++;
    const body = Object.fromEntries(
        [...new URLSearchParams(String(init.body ?? ''))].map(([k, v]) => [k, formValue(v)]),
      ),
      created = String(state.next++);
    state.records.set(created, {id: created, ...body});
    // The provider applied the create; the lost response leaves its outcome unknown to AMCP.
    if (state.lost) throw new TypeError('fetch failed');
    return Response.json({id: created});
  };
  const tagManager = (url, method) => {
    if (method !== 'GET') throw Error('The evaluation fixture accepts no Tag Manager mutation');
    const resource = url.pathname.replace('/tagmanager/v2/', '');
    if (resource.startsWith('accounts/45/'))
      return Response.json(
        {error: {code: 403, status: 'PERMISSION_DENIED', message: 'Synthetic tag account denial'}},
        {status: 403},
      );
    if (resource === gtmWorkspacePath) return Response.json(state.gtm.workspace);
    const tag = state.gtm.tags.get(resource.split('/').at(-1));
    if (tag && resource === tag.path) return Response.json(tag);
    return Response.json(
      {error: {code: 404, status: 'NOT_FOUND', message: 'Synthetic missing resource'}},
      {status: 404},
    );
  };
  const fetcher = async (raw, init = {}) => {
    const url = new URL(String(raw)),
      method = String(init.method ?? 'GET').toUpperCase();
    if (url.hostname === 'tagmanager.googleapis.com') {
      state.requests.push({method, host: url.hostname});
      return tagManager(url, method);
    }
    if (url.hostname === 'sheets.googleapis.com') {
      state.requests.push({method, host: url.hostname});
      return sheets(url, method, init);
    }
    if (url.hostname === 'graph.facebook.com') {
      state.requests.push({method, host: url.hostname});
      return meta(url, method, init);
    }
    state.egress_refused++;
    throw Error('The evaluation fixture refuses egress');
  };
  return {state, fetcher};
}

/** A completed overview snapshot of Client A's Meta account, bound to `actor`, for the export journeys. */
function seedSnapshot(store, actor, id, capturedAt) {
  const report = {
    state: 'complete',
    captured_at: capturedAt,
    created_at: capturedAt,
    completed_at: capturedAt + 5,
    config: {
      name: 'Evaluation client report',
      client_name: 'Evaluation client',
      date_range: {since: '2026-09-01', until: '2026-09-02'},
      metrics: ['spend'],
      custom_metrics: [],
      targets: {},
      objectives: [],
      partial_delivery: 'allow_marked',
      sources: [{platform: 'meta', account_id: '123', connection_id: metaConnection}],
    },
    sources: [],
    actor_binding: store.bindJobActor(actor, id),
    row_count: 1,
    rows: [
      {
        platform: 'meta',
        account_id: '123',
        campaign_id: '10',
        campaign_name: 'Synthetic campaign',
        currency: 'USD',
        timezone: 'UTC',
        date_from: '2026-09-01',
        date_to: '2026-09-02',
        metrics: {spend: 12.5},
        recommendation: {decision: 'observe', reason: 'Synthetic'},
        complete: true,
        captured_at: capturedAt,
      },
    ],
  };
  report.job_id = store.enqueue(actor.tenantId, 'report_overview', {report_id: id});
  store.db.prepare("UPDATE jobs SET state='complete' WHERE id=?").run(report.job_id);
  store.putDocument(actor.tenantId, 'overview_report', id, report);
  return id;
}

/**
 * The loopback website over the same store and service, signed in as a workspace member of the same tenant. A response
 * fault applies here too, since Home and the other pages read the same seams.
 */
async function websiteSurface(store, service, record, requestCount, alter) {
  let app;
  const listener = await listenForFetch((req, res) => {
    if (app) app(req, res);
    else res.writeHead(503).end();
  });
  const origin = 'http://127.0.0.1:' + listener.address().port,
    options = {
      origin,
      masterKey: Buffer.alloc(32, 111).toString('base64'),
      tenantId,
      authEnv: {},
      fetcher: async () => {
        throw Error('The evaluation website makes no outbound request');
      },
    },
    {web, accounts} = createWebsite(store, options, false, service),
    user = accounts.newUser('Evaluation member', null, null, true);
  store.db
    .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
    .run(tenantId, user.id, 'owner', Date.now());
  const session = accounts.session(user, tenantId);
  app = createHttpApp(service, store, {website: options});
  const headers = {
    origin,
    'x-amcp-csrf': session.csrf,
    cookie: web.cookieName + '=' + session.id,
  };
  /** One website request, recorded like a tool call. GET for pages' data, POST for workspace actions. */
  const request = async (path, body) => {
    const response = await fetch(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? headers : {...headers, 'content-type': 'application/json'},
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      text = await response.text();
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      value = {success: false, error: {code: 'NOT_JSON'}};
    }
    return {status: response.status, value: alter ? alter(value) : value, bytes: Buffer.byteLength(text)};
  };
  return {
    origin,
    actor: session.actor,
    /** A website workspace action: POST /api/workspace/<tool> as the page's own controller sends it. */
    async call(tool, args) {
      const before = requestCount(),
        {status, value, bytes} = await request('/api/workspace/' + tool, args);
      return record({surface: 'web', tool: 'web:' + tool, args, result: value, bytes, httpStatus: status, before});
    },
    /** A website page read (GET /api/...). */
    async get(path) {
      const before = requestCount(),
        {status, value, bytes} = await request(path);
      return record({
        before,
        surface: 'web',
        tool: 'web:GET ' + path.split('?')[0],
        args: {},
        result: value?.success === false || status >= 400 ? {success: false, ...value} : {success: true, data: value},
        bytes,
        httpStatus: status,
      });
    },
    close: () => new Promise(resolve => listener.close(() => resolve())),
  };
}

/**
 * A fresh evaluation workspace: two clients' Meta connections (Client A: 123 writable, 456 refused by the provider;
 * Client B: 789 writable, 123 read-only), a Sheets login with one owned destination, an MCP server and recording SDK
 * client, the loopback website, and the report worker. Every run starts from a new in-memory store, so runs never
 * depend on each other.
 */
export async function evaluationFixture({fault, role = 'operator'} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 111).toString('base64')),
    identity = {tenantId, userId: 'evaluator', role},
    admin = {...identity, role: 'admin'},
    key = store.createKey(identity),
    actor = store.authenticate(key),
    providers = syntheticProviders();
  for (const [id, label, accounts, writeAccounts] of [
    [metaConnection, 'Client A Meta', ['123', '456'], ['123']],
    [otherConnection, 'Client B Meta', ['789', '123'], ['789']],
  ])
    store.putConnection(
      admin,
      {
        id,
        tenantId,
        gateway: 'meta_native_action',
        accounts,
        writeAccounts,
        enabled: true,
        label,
        scopes: ['ads_management', 'ads_read'],
      },
      {accessToken: 'synthetic-' + id.slice(-1)},
    );
  store.putConnection(
    admin,
    {
      id: sheetsConnection,
      tenantId,
      gateway: sheetsGateway,
      enabled: true,
      accounts: [evaluationSheet],
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      label: 'Evaluation Sheets login',
    },
    {accessToken: 'synthetic-sheets'},
  );
  store.putConnection(
    admin,
    {
      id: gtmConnection,
      tenantId,
      gateway: 'gtm_native_action',
      enabled: true,
      accounts: ['44', '45'],
      writeAccounts: ['44'],
      scopes: [
        'https://www.googleapis.com/auth/tagmanager.readonly',
        'https://www.googleapis.com/auth/tagmanager.edit.containers',
      ],
      label: 'Evaluation Tag Manager',
    },
    {accessToken: 'synthetic-gtm'},
  );
  store.putDocument(tenantId, 'sheets_destination', evaluationDestination, {
    connection_id: sheetsConnection,
    spreadsheet_id: evaluationSheet,
    sheet_id: 7,
    tab_name: 'Client report',
    name: 'Evaluation client sheet',
  });
  const service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(providers.fetcher, async () => {}),
      undefined,
      {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
      providers.fetcher,
    ),
    overview = new ReportingOverview(service, providers.fetcher),
    worker = new ReportWorker(
      store,
      async () => ({}),
      (tenant, kind, input) => overview.work(tenant, kind, input),
    );
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
  let userActions = 0,
    pendingApproval = false;
  const record = ({surface, tool, args, result, bytes, httpStatus, before, context = {}}) => {
    transcript.push(
      transcriptEntry({
        surface,
        tool,
        args,
        result,
        bytes,
        httpStatus,
        providerRequests: providers.state.requests.length - before,
        followed: context.followed === true,
        approval: context.approval === true || pendingApproval,
      }),
    );
    pendingApproval = false;
    return result;
  };
  /** Calls a tool and records it. `context.followed` marks a call taken from the previous response's next_call. */
  const call = async (tool, args, context = {}) => {
    const before = providers.state.requests.length,
      response = await client.callTool({name: tool, arguments: args}),
      // The in-memory transport hands over objects unserialized; a client on a real transport sees the JSON text.
      text = JSON.stringify(response.structuredContent),
      wire = JSON.parse(text);
    assert.deepEqual(JSON.parse(response.content[0].text), wire, 'text equals structuredContent');
    const result = alter ? alter(wire) : wire;
    return record({surface: 'mcp', tool, args, result, bytes: Buffer.byteLength(text), before, context});
  };
  const website = await websiteSurface(store, service, record, () => providers.state.requests.length, alter);
  let snapshotSequence = 0;
  return {
    store,
    actor,
    admin,
    service,
    providers,
    discovery,
    transcript,
    call,
    web: website,
    /** A person's action on the website that is not itself a request (sign in, choose, approve). */
    userAction() {
      userActions++;
    },
    /** The person approves the review shown to them; the next recorded call carries the approval. */
    approve() {
      userActions++;
      pendingApproval = true;
    },
    userActions: () => userActions,
    /** A completed snapshot of Client A's account; each later one is newer. */
    snapshot(name = 'evaluation-snapshot') {
      return seedSnapshot(
        store,
        actor,
        name + '-' + ++snapshotSequence,
        Date.parse('2026-09-03T00:00:00Z') + snapshotSequence * 100000,
      );
    },
    /** Runs queued report and delivery jobs, as the worker process would. */
    async work() {
      store.db.prepare('UPDATE jobs SET available_at=0').run();
      let ran = 0;
      while (ran < 10 && (await worker.once())) ran++;
      return ran;
    },
    close: async () => {
      await client.close();
      await server.close();
      await website.close();
      store.close();
    },
  };
}

/** The end of a scripted branch: success, a handled failure with a next step, or a dead end without one. */
export function endState(transcript, goalReached) {
  if (goalReached) return 'success';
  const last = transcript.at(-1);
  return last?.next_step ? 'handled_failure' : 'dead_end';
}

const sumOf = (entries, field) => entries.reduce((sum, entry) => sum + (Number(entry[field]) || 0), 0);

/**
 * Per-run measures from a transcript. B15's four: correct tool choice (the first productive MCP call matches the
 * reference's first), unnecessary calls (calls beyond the reference's count), repeated refused calls (a refused call
 * sent again unchanged) and handoff success (the goal reached, with the website handoff verified when the task needs
 * it). Journeys add user actions, website actions, provider requests and response bytes.
 */
export function transcriptMetrics(
  transcript,
  {reference = [], goalReached = false, handoff = null, userActions = 0} = {},
) {
  const refused = new Set(),
    mcp = transcript.filter(entry => entry.surface !== 'web'),
    web = transcript.filter(entry => entry.surface === 'web');
  let repeated = 0;
  for (const entry of transcript)
    if (!entry.success) {
      if (refused.has(entry.args_digest)) repeated++;
      refused.add(entry.args_digest);
    }
  const productive = mcp.filter(entry => entry.tool !== 'amcp_tool_help'),
    first = productive[0],
    expected = reference.find(step => step.surface !== 'web');
  return {
    tool_calls: mcp.length,
    website_actions: web.length,
    user_actions: userActions,
    help_calls: mcp.length - productive.length,
    response_bytes: sumOf(transcript, 'bytes'),
    provider_requests: sumOf(transcript, 'provider_requests'),
    refused_calls: transcript.filter(entry => !entry.success).length,
    repeated_refused_calls: repeated,
    unnecessary_calls: reference.length ? Math.max(0, transcript.length - reference.length) : 0,
    correct_tool_choice: expected
      ? !!first && first.tool === expected.tool && first.action === (expected.action ?? null)
      : null,
    followed_next_calls: transcript.filter(entry => entry.followed_next_call).length,
    offered_next_calls: transcript.filter(entry => entry.next_call).length,
    wrong_next_calls: transcript.filter(
      entry =>
        entry.followed_next_call &&
        !entry.success &&
        ['INVALID_ARGUMENT', 'UNKNOWN_OPERATION', 'NOT_FOUND', 'RESOURCE_NOT_FOUND', 'VALIDATION_FAILED'].includes(
          entry.code,
        ),
    ).length,
    next_step_at_stop: !goalReached ? !!transcript.at(-1)?.next_step : null,
    user_approvals: transcript.filter(entry => entry.user_approval).length,
    handoff_success: handoff === null ? goalReached : goalReached && handoff === true,
    end_state: endState(transcript, goalReached),
  };
}

/** Fields whose rise is a regression; the end state, handoff and tool choice must stay equal. */
export const budgetFields = Object.freeze([
  'tool_calls',
  'website_actions',
  'user_actions',
  'refused_calls',
  'repeated_refused_calls',
  'unnecessary_calls',
  'provider_requests',
  'user_approvals',
  'wrong_next_calls',
]);
export const exactFields = Object.freeze(['end_state', 'handoff_success', 'correct_tool_choice']);
const endRank = {dead_end: 0, handled_failure: 1, success: 2};

/**
 * Whether a changed end state, handoff or tool choice is an improvement. Gaining a next step at a stop (dead end →
 * handled failure) always is. Reaching the goal is an improvement only for a guided task run, where the goal is the
 * job the client was asked to do; a journey's failure branch that newly "succeeds" means a safeguard stopped holding.
 */
function exactChange(id, field, expected, actual) {
  const guided = id.endsWith('/guided');
  if (field === 'end_state')
    return (expected === 'dead_end' && actual === 'handled_failure') ||
      (guided && (endRank[actual] ?? -1) > (endRank[expected] ?? -1))
      ? 'improvement'
      : 'regression';
  return guided && expected === false && actual === true ? 'improvement' : 'regression';
}

/**
 * Compares a run with the committed baseline. Counts may not rise; the end state, handoff and tool choice may not get
 * worse (see exactChange); response bytes, and the MCP surface's tool-list and instruction bytes, may grow at most
 * `bytesTolerance` plus `bytesSlack` (identifiers, ports and times differ in length slightly between runs); a changed
 * tool count needs a deliberate new baseline. A fall is reported as an improvement; the baseline is never updated by a
 * check, only by `tools/mcp-eval.mjs --write-baseline`.
 */
export function compareWithBaseline(current, baseline, {bytesTolerance = 0.1, bytesSlack = 512} = {}) {
  const regressions = [],
    improvements = [],
    limitOf = expected => Math.ceil(expected * (1 + bytesTolerance)) + bytesSlack;
  for (const [suite, runs] of Object.entries(baseline.runs ?? {}))
    for (const [id, expected] of Object.entries(runs)) {
      const actual = current.runs?.[suite]?.[id];
      if (!actual) {
        regressions.push({suite, id, field: 'missing', expected: 'present', actual: null});
        continue;
      }
      for (const field of budgetFields)
        if ((actual[field] ?? 0) > (expected[field] ?? 0))
          regressions.push({suite, id, field, expected: expected[field], actual: actual[field]});
        else if ((actual[field] ?? 0) < (expected[field] ?? 0))
          improvements.push({suite, id, field, expected: expected[field], actual: actual[field]});
      for (const field of exactFields)
        if (actual[field] !== expected[field])
          (exactChange(id, field, expected[field], actual[field]) === 'improvement' ? improvements : regressions).push({
            suite,
            id,
            field,
            expected: expected[field],
            actual: actual[field],
          });
      const limit = limitOf(expected.response_bytes);
      if (actual.response_bytes > limit)
        regressions.push({
          suite,
          id,
          field: 'response_bytes',
          expected: expected.response_bytes,
          actual: actual.response_bytes,
          limit,
        });
    }
  for (const [suite, runs] of Object.entries(current.runs ?? {}))
    for (const id of Object.keys(runs))
      if (!baseline.runs?.[suite]?.[id])
        improvements.push({suite, id, field: 'new_run', expected: null, actual: 'present'});
  const surface = baseline.mcp_surface,
    now = current.mcp_surface;
  if (surface && now) {
    if (now.tools !== surface.tools)
      regressions.push({
        suite: 'mcp_surface',
        id: 'tools/list',
        field: 'tools',
        expected: surface.tools,
        actual: now.tools,
      });
    for (const field of ['tools_list_bytes', 'instructions_bytes'])
      if (now[field] > limitOf(surface[field]))
        regressions.push({
          suite: 'mcp_surface',
          id: 'tools/list',
          field,
          expected: surface[field],
          actual: now[field],
          limit: limitOf(surface[field]),
        });
      else if (now[field] < surface[field])
        improvements.push({
          suite: 'mcp_surface',
          id: 'tools/list',
          field,
          expected: surface[field],
          actual: now[field],
        });
  }
  return {passed: regressions.length === 0, regressions, improvements};
}

/**
 * Ranges per client and task over repeated external runs (model behavior is nondeterministic, so never one number):
 * the minimum, median and maximum of each count, and how many runs reached the goal and the handoff.
 */
export function externalRanges(runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = run.client + '\u0000' + run.task;
    if (!groups.has(key)) groups.set(key, {client: run.client, task: run.task, metrics: []});
    groups.get(key).metrics.push(run.metrics);
  }
  const range = values => {
    const sorted = [...values].sort((a, b) => a - b),
      middle = Math.floor(sorted.length / 2);
    return {
      min: sorted[0],
      median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
      max: sorted.at(-1),
    };
  };
  return [...groups.values()].map(({client, task, metrics}) => ({
    client,
    task,
    runs: metrics.length,
    goal_reached: metrics.filter(m => m.end_state === 'success').length,
    handoff_success: metrics.filter(m => m.handoff_success === true).length,
    correct_tool_choice: metrics.filter(m => m.correct_tool_choice === true).length,
    ...Object.fromEntries(
      ['tool_calls', 'unnecessary_calls', 'repeated_refused_calls', 'refused_calls', 'response_bytes'].map(field => [
        field,
        range(metrics.map(m => m[field] ?? 0)),
      ]),
    ),
  }));
}
