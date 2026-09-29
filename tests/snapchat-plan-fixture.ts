import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import type {Actor, JsonObject} from '../src/types.js';

/**
 * A synthetic Snapchat ad account shaped like the one in the owner's live tests (2026-09-25 and 09-29): the account
 * record carries billing and funding fields, records come wrapped as {adsquads:[{sub_request_status,adsquad}]}, GET
 * never returns placement_v2, and an ad squad body with its targeting is about 1 KB. Only IDs are invented.
 */
export const SNAP = '11111111-1111-4111-8111-111111111111';
export const gateway = 'snapchat_native_action';
export const actor: Actor = {tenantId: 'snap-plan', userId: 'operator', role: 'operator'};
export const admin: Actor = {...actor, role: 'admin'};
/** What an MCP client receives for one call: server/mcp.ts sends JSON.stringify of the whole result. */
export const bytes = (result: unknown) => Buffer.byteLength(JSON.stringify(result));
export const account = {
  id: 'acct1',
  updated_at: '2026-09-20T08:00:00.000Z',
  created_at: '2024-01-10T08:00:00.000Z',
  name: 'Synthetic Company',
  type: 'PARTNER',
  status: 'ACTIVE',
  organization_id: 'org1',
  funding_source_ids: ['funding-1', 'funding-2', 'funding-3'],
  currency: 'USD',
  timezone: 'Asia/Riyadh',
  advertiser_organization_id: 'org1',
  billing_center_id: 'billing-center-1',
  billing_type: 'IO',
  agency_representing_client: false,
  client_paying_invoices: false,
  cell_ids: ['cell-1', 'cell-2', 'cell-3'],
  regulations: {restricted_delivery_signals: false},
};
export interface Fixture {
  store: Store;
  service: MirrorService;
  writes: string[];
  call: (tool: string, input: JsonObject) => Promise<JsonObject>;
  squads: Map<string, JsonObject>;
  close: () => void;
}
export function fixture({
  pixels = ['pixel-own'],
  reject = (_body: JsonObject): JsonObject | undefined => undefined,
  readSquad = (squad: JsonObject): JsonObject => squad,
}: {
  pixels?: string[];
  /** A Snapchat error body for an ad squad the synthetic API refuses. */
  reject?: (body: JsonObject) => JsonObject | undefined;
  /** How a read returns a stored ad squad, after Snapchat drops placement_v2. */
  readSquad?: (squad: JsonObject) => JsonObject;
} = {}): Fixture {
  const store = new Store(':memory:', Buffer.alloc(32, 91).toString('base64'));
  store.putConnection(
    admin,
    {
      id: SNAP,
      tenantId: actor.tenantId,
      gateway,
      accounts: ['acct1'],
      writeAccounts: ['acct1'],
      enabled: true,
      label: 'Snapchat login',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const campaigns = new Map<string, JsonObject>(),
    squads = new Map<string, JsonObject>(),
    writes: string[] = [];
  let requestId = 0;
  const ok = (kind: string, rows: JsonObject[]) =>
    Response.json({
      request_status: 'SUCCESS',
      request_id: 'r' + ++requestId,
      paging: {},
      [kind]: rows.map(r => ({sub_request_status: 'SUCCESS', [kind.slice(0, -1)]: r})),
    });
  const missing = () => Response.json({request_status: 'ERROR', debug_message: 'Not found'}, {status: 404});
  const transport = new NativeTransport(
    async (raw, init = {}) => {
      const path = new URL(String(raw)).pathname,
        method = init.method ?? 'GET';
      let m: RegExpExecArray | null;
      if (method === 'GET' && path === '/v1/adaccounts/acct1') return ok('adaccounts', [account]);
      if (method === 'GET' && path === '/v1/adaccounts/acct1/pixels')
        return ok(
          'pixels',
          pixels.map(id => ({id, name: 'Pixel', status: 'ACTIVE'})),
        );
      if (method === 'POST' && path === '/v1/adaccounts/acct1/campaigns') {
        writes.push(method + ' ' + path);
        return ok(
          'campaigns',
          JSON.parse(String(init.body)).campaigns.map((c: JsonObject) => {
            const row = {
              ...c,
              id: 'camp' + (campaigns.size + 1),
              ad_account_id: 'acct1',
              created_at: '2026-09-29T10:00:00.000Z',
              updated_at: '2026-09-29T10:00:00.000Z',
              delivery_status: ['INVALID_NOT_ACTIVE'],
              creation_state: 'PUBLISHED',
            };
            campaigns.set(row.id, row);
            return row;
          }),
        );
      }
      if (method === 'GET' && (m = /^\/v1\/campaigns\/([^/]+)$/.exec(path))) {
        const c = campaigns.get(m[1]!);
        return c ? ok('campaigns', [c]) : missing();
      }
      if (method === 'POST' && (m = /^\/v1\/campaigns\/([^/]+)\/adsquads$/.exec(path))) {
        writes.push(method + ' ' + path);
        const body = JSON.parse(String(init.body)),
          refusal = reject(body.adsquads[0]);
        if (refusal) return Response.json(refusal, {status: 400});
        return ok(
          'adsquads',
          body.adsquads.map((a: JsonObject) => {
            const row = {
              ...a,
              id: 'squad' + (squads.size + 1),
              campaign_id: m![1],
              created_at: '2026-09-29T10:00:00.000Z',
              updated_at: '2026-09-29T10:00:00.000Z',
              delivery_status: ['INVALID_NOT_ACTIVE'],
              creation_state: 'PUBLISHED',
            };
            squads.set(row.id, row);
            return row;
          }),
        );
      }
      if (method === 'GET' && (m = /^\/v1\/adsquads\/([^/]+)$/.exec(path))) {
        const s = squads.get(m[1]!);
        if (!s) return missing();
        const {placement_v2: _, ...read} = s;
        return ok('adsquads', [readSquad({...read, placement: 'UNSUPPORTED'})]);
      }
      throw new Error('Unexpected Snapchat request ' + method + ' ' + path);
      // A burst large enough for a 50-step plan: these tests measure responses, not the per-tenant rate shaping.
    },
    undefined,
    undefined,
    undefined,
    10000,
  );
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  return {
    store,
    service,
    writes,
    squads,
    call: (tool, input) => service.call(tool, input, actor) as Promise<JsonObject>,
    close: () => store.close(),
  };
}
export const campaignStep = (id = 'campaign', extra: JsonObject = {}): JsonObject => ({
  id,
  kind: 'write',
  gateway,
  connection_id: SNAP,
  account_id: 'acct1',
  expected_currency: 'USD',
  arguments: {
    action: 'snapchat_campaign_create',
    payload: {
      campaigns: [
        {
          name: 'AMCP view test | campaign',
          ad_account_id: 'acct1',
          status: 'PAUSED',
          start_time: '2026-10-01T00:00:00.000Z',
          buy_model: 'AUCTION',
          objective_v2_properties: {objective_v2_type: 'LEADS'},
        },
      ],
    },
  },
  ...extra,
});
export const campaignRef = {$ref: 'campaign#/data/campaigns/0/campaign/id'};
/** An ad squad of about 1 KB, like the EN and AR squads of the live tests (daily budgets in micro-units). */
export const squadBody = (i: number, extra: JsonObject = {}): JsonObject => ({
  campaign_id: campaignRef,
  name: 'AMCP view test | squad ' + i + ' | EN | KSA 30+',
  type: 'SNAP_ADS',
  status: 'PAUSED',
  targeting: {
    regulated_content: false,
    geos: [{country_code: 'sa', operation: 'INCLUDE'}],
    demographics: [{min_age: '30', languages: ['en', 'ar']}],
    devices: [
      {device_type: 'MOBILE', os_type: 'iOS'},
      {device_type: 'MOBILE', os_type: 'ANDROID'},
    ],
    enable_targeting_expansion: true,
  },
  placement_v2: {config: 'AUTOMATIC'},
  billing_event: 'IMPRESSION',
  bid_strategy: 'AUTO_BID',
  daily_budget_micro: 179260000,
  optimization_goal: 'PIXEL_SIGNUP',
  pixel_id: 'pixel-own',
  start_time: '2026-10-01T00:00:00.000Z',
  delivery_constraint: 'DAILY_BUDGET',
  pacing_type: 'STANDARD',
  child_ad_type: 'REMOTE_WEBPAGE',
  ...extra,
});
export const squadStep = (i: number, extra: JsonObject = {}, body: JsonObject = {}): JsonObject => ({
  id: 'squad_' + i,
  kind: 'write',
  gateway,
  connection_id: SNAP,
  account_id: 'acct1',
  expected_currency: 'USD',
  depends_on: ['campaign'],
  arguments: {
    action: 'snapchat_adsquad_create',
    path_params: {campaign_id: campaignRef},
    payload: {adsquads: [squadBody(i, body)]},
  },
  ...extra,
});
/** One campaign and `count - 1` ad squads under it. */
export const squadPlan = (count: number) => [
  campaignStep(),
  ...Array.from({length: count - 1}, (_, i) => squadStep(i + 1)),
];
export const createPlan = (f: Fixture, steps: JsonObject[], extra: JsonObject = {}) =>
  f.call('amcp_campaign', {action: 'create', name: 'Snapchat plan', brief: 'Synthetic plan', steps, ...extra});
/** Runs the plan the way an agent does, approving every review; returns every response. */
export async function runAll(f: Fixture, id: string, limit = 200) {
  const responses: {action: string; result: JsonObject}[] = [];
  for (let i = 0; i < limit; i++) {
    const prepared = await f.call('amcp_campaign', {action: 'prepare_next', id});
    responses.push({action: 'prepare_next', result: prepared});
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 2000));
    if (!prepared.data.review) return responses;
    // The synthetic user approves each reviewed step, including any spending acknowledgement the review asks for.
    const executed = await f.call('amcp_campaign', {
      ...prepared.data.next_call.arguments,
      ...prepared.data.next_call.add_after_user_approval,
    });
    responses.push({action: 'execute_next', result: executed});
    assert.equal(executed.success, true, JSON.stringify(executed).slice(0, 2000));
    if (executed.data.state === 'complete') return responses;
  }
  throw new Error('Plan did not settle');
}
