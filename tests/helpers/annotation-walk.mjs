// The walk behind every read-only MCP hint (MCP-06): a workspace with one synthetic connection per gateway, a transport
// that records every provider request and answers {}, a media fetcher that refuses and records, and a digest of the
// AMCP state a read-only call must leave unchanged. tests/mcp-tool-annotations.test.mjs walks the tools marked
// read-only in tools/list; tests/mcp-operation-annotations.test.mjs walks every action help presents as read-only.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Store} from '../../dist/src/store.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {independentlyReadOnly} from '../../dist/src/execution-risk.js';
import {providerJob} from '../../dist/src/effect-class.js';

const writes = {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  key = Buffer.alloc(32, 61).toString('base64');
/** Gateways that need no connection of their own: help, the workspace context and AMCP's own workflow operations. */
const unconnected = ['amcp_tool_help', 'amcp_platform_workspace', 'amcp_native_action'];

export function world(registry, allowWrites) {
  const store = new Store(':memory:', key),
    actor = {tenantId: 'annotations', userId: 'owner', role: 'admin'},
    fetches = [],
    plans = [],
    media = [];
  store.ensureTenant(actor.tenantId);
  const connections = new Map();
  let n = 0;
  for (const gateway of registry.tools.keys()) {
    if (unconnected.includes(gateway)) continue;
    const id = '00000000-0000-4000-8000-' + String(++n).padStart(12, '0');
    store.putConnection(
      actor,
      {
        id,
        tenantId: actor.tenantId,
        gateway,
        accounts: ['1001'],
        writeAccounts: ['1001'],
        enabled: true,
        label: 'Synthetic ' + gateway,
        scopes: [],
        userAgent: 'synthetic-annotation-evaluator/1.0',
      },
      {accessToken: 'synthetic-' + n},
    );
    connections.set(gateway, id);
  }
  // Every provider request is recorded and answered with an empty JSON object; nothing leaves the process.
  const transport = new NativeTransport(
    async (url, init = {}) => {
      fetches.push({method: String(init.method ?? 'GET').toUpperCase(), url: String(url)});
      return Response.json({});
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    1e9,
    1,
    1e9,
  );
  const request = transport.request.bind(transport);
  transport.request = (plan, ...rest) => {
    plans.push(plan);
    return request(plan, ...rest);
  };
  const service = new MirrorService(
    registry,
    store,
    transport,
    undefined,
    allowWrites ? writes : undefined,
    async url => {
      media.push(String(url));
      throw Error('Synthetic media fetches are refused.');
    },
  );
  return {store, actor, service, connections, fetches, plans, media, close: () => store.close()};
}
// AMCP state a read-only tool must leave unchanged. The audit trail, ownership observations of what a read returned,
// provider cooldowns, service locks and timing counters keep AMCP's own controls working and change nothing the user owns.
export const stateTables = [
  'tenants',
  'workspace_memberships',
  'credential_owners',
  'api_keys',
  'connections',
  'idempotency',
  'documents',
  'jobs',
  'media_admissions',
  'media_chunks',
  'media_staging',
  'retained_media',
  'retained_media_chunks',
];
// Service timing counters are observability, kept as one document per category.
const observability = table => (table === 'documents' ? " WHERE kind<>'service_timings'" : '');
export const snapshot = store =>
  stateTables
    .map(
      t =>
        t +
        ':' +
        createHash('sha256')
          .update(JSON.stringify(store.db.prepare('SELECT * FROM ' + t + observability(t) + ' ORDER BY rowid').all()))
          .digest('hex')
          .slice(0, 12),
    )
    .join(' ');
/** The bag's keys the schema admits, plus a synthetic value for each required property it lacks. */
export function fill(bag, schema = {}) {
  const properties = schema.properties ?? {},
    out = Object.fromEntries(Object.entries(bag).filter(([k]) => Object.hasOwn(properties, k)));
  for (const key of schema.required ?? []) {
    if (out[key] !== undefined) continue;
    const s = properties[key] ?? {};
    out[key] =
      s.const ?? s.enum?.[0] ?? {number: 1, integer: 1, boolean: false, object: {}, array: []}[s.type] ?? '1001';
  }
  return out;
}
/** The read-shaped and write-shaped argument bags: once without a payload, once with confirmation and a payload. */
export function bags(w, gateway) {
  const connection = w.connections.get(gateway),
    read = {
      account_id: '1001',
      ad_account_id: '1001',
      advertiser_id: '1001',
      profile_id: '1001',
      org_id: '1001',
      ...(connection ? {connection_id: connection} : {}),
    };
  return {
    read,
    write: {
      ...read,
      dry_run: false,
      confirmed: true,
      idempotency_key: '00000000-0000-4000-8000-0000000000aa',
      payload: {name: 'Synthetic', url: 'https://media.example.test/synthetic.png'},
    },
  };
}
/**
 * Runs one call that is presented as read-only and asserts it changed no AMCP state, sent only independently read-only
 * requests and no provider job, and fetched no media. A call also presented as closed-world (openWorldHint false) must
 * send no request at all (wave 4b review: nothing held that hint). Returns whether it succeeded and how many requests
 * it sent.
 */
export async function readOnlyCall(w, tool, input, label = tool, {closedWorld = false} = {}) {
  const before = snapshot(w.store),
    plans = w.plans.length,
    fetches = w.fetches.length,
    media = w.media.length;
  const result = await w.service.call(tool, structuredClone(input), w.actor);
  const where = label + ' ' + JSON.stringify(input).slice(0, 240);
  assert.equal(snapshot(w.store), before, 'saved state: ' + where);
  const sent = w.plans.slice(plans);
  for (const plan of sent) {
    assert.ok(independentlyReadOnly(plan), 'non-read plan: ' + where);
    assert.ok(!providerJob(plan), 'provider job: ' + where);
  }
  for (const fetch of w.fetches.slice(fetches))
    assert.ok(['GET', 'HEAD'].includes(fetch.method) || sent.length > 0, 'unplanned ' + fetch.method + ': ' + where);
  assert.equal(w.media.length, media, 'fetched media: ' + where);
  if (closedWorld) {
    assert.equal(sent.length, 0, 'a closed-world call sent a provider plan: ' + where);
    assert.equal(w.fetches.length, fetches, 'a closed-world call reached the network: ' + where);
  }
  return {success: result.success === true, reads: sent.length};
}
