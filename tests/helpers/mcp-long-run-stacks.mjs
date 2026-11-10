// The long runs of the MCP tools (an export of amcp_reporting_overview, and amcp_campaign run_background) served over the
// real HTTP stack, for the tests of their progress and of their tasks (V2-MCP-02). Synthetic stores and fake providers
// only; the jobs are driven through the store, or by the real worker.
import assert from 'node:assert/strict';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {ReportingOverview} from '../../dist/src/reporting-overview.js';
import {ReportWorker} from '../../dist/src/worker.js';
import {SOURCE_CHUNK_BYTES} from '../../dist/src/media-sources.js';
import {createHttpApp} from '../../dist/server/http-app.js';
import {listenForFetch} from '../../dist/tests/http-listener.js';
import {reportEngine} from './report-engine.mjs';
import {row} from './report-packets.mjs';

export const overviewTool = 'amcp_reporting_overview',
  campaignTool = 'amcp_campaign';
export const rows = {campaign: [row('campaign', 'c1', {spend: '30'}, {campaign_name: 'Spring sale'})]};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Polls until `check` returns something truthy, or fails after `ms`. */
export async function until(check, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await wait(10);
  }
  assert.fail('Timed out waiting for ' + what);
}
/** A real SDK v2 client of one protocol era, connected to the real HTTP endpoint and closed with the test. */
export async function connectClient(t, era, url, key) {
  const client = new Client(
    {name: 'Synthetic long-run client', version: '1'},
    era === 'modern' ? {versionNegotiation: {mode: {pin: '2026-07-28'}}} : {},
  );
  await client.connect(
    new StreamableHTTPClientTransport(url, {requestInit: {headers: {Authorization: 'Bearer ' + key}}}),
  );
  t.after(() => client.close());
  return client;
}

/** A finished report with a file destination, served over the real HTTP stack; its export job is driven through the store. */
export async function exportStack(t) {
  const e = reportEngine(t, {rowsFor: level => rows[level] ?? []});
  const queued = await e.overview.handle({action: 'run', confirmed: true, config: e.definition(['campaign'])}, e.actor);
  await e.worker.once();
  const destination = await e.overview.handle(
    {
      action: 'bind_file_destination',
      idempotency_key: 'long-run-files',
      confirmed: true,
      file_destination: {name: 'Long-run files', formats: ['pdf']},
    },
    e.actor,
  );
  const key = e.store.createKey(e.actor),
    listener = await listenForFetch(createHttpApp(e.service, e.store, {mcpModernProtocol: 'on'}));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const url = new URL('http://127.0.0.1:' + listener.address().port + '/mcp'),
    jobs = "tenant_id=? AND kind='report_file_export'";
  return {
    ...e,
    key,
    url,
    reportId: queued.id,
    exportArgs: {action: 'export', report_id: queued.id, destination_id: destination.id, confirmed: true},
    setJob: (state, error = null) =>
      e.store
        .sql()
        .prepare('UPDATE jobs SET state=?, error=? WHERE ' + jobs)
        .run(state, error && JSON.stringify(error), e.actor.tenantId),
    jobState: () =>
      e.store
        .sql()
        .prepare('SELECT state FROM jobs WHERE ' + jobs)
        .get(e.actor.tenantId)?.state,
    jobId: () =>
      e.store
        .sql()
        .prepare('SELECT id FROM jobs WHERE ' + jobs)
        .get(e.actor.tenantId)?.id,
    connect: era => connectClient(t, era, url, key),
  };
}

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
/** An approved plan of two media uploads, run by the real worker against a fake Meta, served over the real HTTP stack. */
export async function campaignStack(t) {
  const operator = {tenantId: 't', userId: 'u', role: 'operator'},
    admin = {...operator, role: 'admin'},
    accounts = ['101', '102'],
    store = new Store(':memory:', Buffer.alloc(32, 59).toString('base64'));
  t.after(() => store.close());
  store.putConnection(
    admin,
    {
      id: 'meta',
      tenantId: 't',
      gateway: 'meta_native_action',
      accounts,
      writeAccounts: accounts,
      label: 'Synthetic',
      enabled: true,
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  let uploads = 0;
  const requests = [],
    transport = new NativeTransport(async (input, init) => {
      const url = new URL(String(input)),
        method = init?.method ?? 'GET';
      requests.push(method + ' ' + url.pathname);
      if (method === 'GET' && /\/act_\d+$/.test(url.pathname))
        return Response.json({id: url.pathname.split('/').pop(), account_status: 1, currency: 'USD'});
      if (method === 'POST' && url.pathname.endsWith('/adimages'))
        return Response.json({images: {one: {hash: 'synthetic_hash_' + ++uploads}}});
      if (method === 'GET' && url.pathname.endsWith('/adimages'))
        return Response.json({
          data: Array.from({length: uploads}, (_, i) => 'synthetic_hash_' + (i + 1))
            .filter(hash => String(url.searchParams.get('hashes') ?? '').includes(hash))
            .map(hash => ({hash})),
        });
      throw Error('Unexpected provider request ' + method + ' ' + url.pathname);
    });
  const service = new MirrorService(new Registry(), store, transport, undefined, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    }),
    overview = new ReportingOverview(service),
    worker = new ReportWorker(
      store,
      async () => ({}),
      (tenant, kind, input) => overview.work(tenant, kind, input),
    );
  const campaign = input => service.call(campaignTool, input, operator),
    sources = service.mediaSources(),
    upload = async filename => {
      const started = sources.begin(operator, {filename, size: png.length, type: ''});
      for (let index = 0; index < started.chunks; index++)
        sources.put(
          operator,
          started.source_id,
          index,
          png.subarray(index * SOURCE_CHUNK_BYTES, (index + 1) * SOURCE_CHUNK_BYTES),
        );
      return sources.complete(operator, started.source_id);
    };
  const steps = [];
  for (const [i, account] of accounts.entries()) {
    const source = await upload('file-' + (i + 1) + '.png');
    steps.push({
      id: 'upload-' + (i + 1),
      kind: 'media',
      description: source.filename + ' → Meta · ' + account,
      connection_id: 'meta',
      account_id: account,
      arguments: {
        platform: 'meta',
        account_id: account,
        connection_id: 'meta',
        source_id: source.source_id,
        name: 'Push',
        fit_to_platform: false,
        expected_sha256: source.sha256,
      },
      depends_on: [],
    });
  }
  const saved = await campaign({
    action: 'create',
    name: 'Long-run push',
    brief: 'Upload only the previewed files to the selected accounts.',
    acknowledge_temporary_sources: true,
    steps,
  });
  assert.equal(saved.success, true, JSON.stringify(saved));
  const id = saved.data.id,
    review = await campaign({action: 'approve', id});
  assert.equal(review.success, true, JSON.stringify(review));
  const approved = await campaign({
    action: 'approve',
    id,
    plan_hash: review.data.approval.plan_hash,
    summary_hash: review.data.approval.summary_hash,
    confirmed: true,
  });
  assert.equal(approved.success, true, JSON.stringify(approved));
  const key = store.createKey(operator),
    listener = await listenForFetch(createHttpApp(service, store, {mcpModernProtocol: 'on'}));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const url = new URL('http://127.0.0.1:' + listener.address().port + '/mcp'),
    jobs = "tenant_id=? AND kind='campaign_run'";
  return {
    store,
    service,
    worker,
    operator,
    id,
    key,
    url,
    requests,
    uploads: () => uploads,
    jobId: () =>
      store
        .sql()
        .prepare('SELECT id FROM jobs WHERE ' + jobs)
        .get('t')?.id,
    jobState: () =>
      store
        .sql()
        .prepare('SELECT state FROM jobs WHERE ' + jobs)
        .get('t')?.state,
    connect: era => connectClient(t, era, url, key),
  };
}
