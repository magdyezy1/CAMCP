// Synthetic-writes fixtures for the rendered browser qualification (QA-03, owner decision D26: the browser fixture may
// accept its own synthetic mutations). Each fake provider accepts only the mutation routes it declares, records them in
// a separate synthetic-writes counter and forwards nothing: it runs inside the fixture process and answers itself. Any
// other mutation increments the provider-write counter and is refused, so the runner's "zero provider writes" invariant
// is unchanged. No external account is used or mutated.
import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {ReportingOverview} from '../../dist/src/reporting-overview.js';
import {ReportWorker} from '../../dist/src/worker.js';
import {sheetsGateway} from '../../dist/src/google-sheets.js';

/**
 * The owned-route guard: a mutation is synthetic only when its method, origin and path match a route the fixture
 * declared. Everything else is a provider write.
 */
export function syntheticMutationGuard(routes) {
  for (const route of routes) {
    assert.ok(['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method), 'A synthetic route names a mutation method');
    assert.match(route.origin, /^https:\/\/[a-z0-9.-]+$/, 'A synthetic route names one exact provider origin');
    assert.ok(route.path instanceof RegExp && route.path.source.startsWith('^') && route.path.source.endsWith('$'));
  }
  return (url, method) =>
    routes.some(route => route.method === method && route.origin === url.origin && route.path.test(url.pathname));
}

/** A recording transport around `answer`; reads and synthetic writes are counted, other mutations are refused. */
function syntheticTransport(routes, answer) {
  const accept = syntheticMutationGuard(routes),
    reads = [],
    synthetic = [];
  let providerWrites = 0;
  const transport = async (raw, init = {}) => {
    const url = new URL(String(raw)),
      method = String(init.method ?? 'GET').toUpperCase();
    if (method === 'GET') {
      reads.push({method, path: url.pathname});
      return answer({url, method, init, synthetic: false});
    }
    if (!accept(url, method)) {
      providerWrites++;
      throw Error('Synthetic writes fixture refuses a provider mutation outside its owned synthetic routes');
    }
    synthetic.push({method, origin: url.origin, path: url.pathname});
    return answer({url, method, init, synthetic: true});
  };
  return {
    transport,
    reads,
    synthetic,
    counts: () => ({reads: reads.length, synthetic_writes: synthetic.length, provider_writes: providerWrites}),
  };
}

const formValue = value => {
  try {
    return /^[[{]|^(?:true|false)$/.test(value) ? JSON.parse(value) : value;
  } catch {
    return value;
  }
};

export const writeJourneyConnection = 'aaaaaaaa-7777-4777-8777-000000000001';
export const writeJourneyRoutes = Object.freeze([
  {method: 'POST', origin: 'https://graph.facebook.com', path: /^\/v\d+\.\d+\/act_123\/campaigns$/},
]);

/**
 * A Meta account whose paused campaign create is reviewed, consented and executed on the website. The outcome of the
 * next synthetic create is chosen per journey: `accepted` (the fake applies it and read-back verifies), `uncertain`
 * (the fake receives it and the response is lost) or `refused` (the account changes after the review, so execute is
 * refused with STATE_CHANGED before anything is sent).
 */
export function syntheticWriteJourneyFixture() {
  const keyByte = 171,
    actor = {tenantId: 'synthetic-write-journey', userId: 'fixture', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, keyByte).toString('base64')),
    created = new Map();
  let outcome = 'accepted',
    account = {
      id: 'act_123',
      name: 'Synthetic write account',
      account_status: 1,
      currency: 'USD',
      timezone_name: 'UTC',
    },
    next = 238000000000001n;
  store.putConnection(
    actor,
    {
      id: writeJourneyConnection,
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Meta writer',
      scopes: ['ads_management'],
    },
    {accessToken: 'synthetic-write-journey'},
  );
  const recorded = syntheticTransport(writeJourneyRoutes, ({url, init, synthetic}) => {
    if (!synthetic) {
      const id = url.pathname.split('/').at(-1);
      return Response.json(created.get(id) ?? account);
    }
    // The fake received the create. A lost response leaves the outcome unknown to AMCP.
    if (outcome === 'uncertain') throw new TypeError('fetch failed');
    const body = Object.fromEntries([...new URLSearchParams(String(init.body))].map(([k, v]) => [k, formValue(v)])),
      id = String(next++);
    created.set(id, {id, ...body});
    return Response.json({id});
  });
  const service = new MirrorService(new Registry(), store, new NativeTransport(recorded.transport), undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  return {
    keyByte,
    actor,
    store,
    service,
    requests: recorded.reads,
    syntheticWrites: () => recorded.synthetic.length,
    writes: () => recorded.counts().provider_writes,
    transport: recorded.transport,
    /** Saves a one-step plan for the web user and selects the outcome its execution meets. */
    async seed(webActor, nextOutcome) {
      assert.ok(['accepted', 'uncertain', 'refused'].includes(nextOutcome));
      outcome = nextOutcome;
      account = {...account, account_status: 1};
      const plan = await service.call(
        'amcp_campaign',
        {
          action: 'create',
          name: 'Synthetic ' + nextOutcome + ' journey',
          brief: 'A paused traffic campaign for the synthetic write journey.',
          steps: [
            {
              id: 'campaign',
              kind: 'write',
              gateway: 'meta_native_action',
              connection_id: writeJourneyConnection,
              account_id: '123',
              description: 'Create the paused campaign',
              arguments: {
                action: 'meta_campaign_create',
                payload: {
                  // One campaign per outcome: an identical create is refused at prepare while an earlier one is uncertain
                  // (R2.5 M2, L5-06), and the three journeys of a site run one after another.
                  name: 'Synthetic ' + nextOutcome + ' campaign',
                  objective: 'OUTCOME_TRAFFIC',
                  status: 'PAUSED',
                  special_ad_categories: [],
                  is_adset_budget_sharing_enabled: false,
                },
              },
            },
          ],
        },
        webActor,
      );
      assert.equal(plan.success, true, JSON.stringify(plan.error));
      return plan.data.id;
    },
    /** The provider-side change between review and execute that makes a `refused` journey refuse. */
    changeAccountState() {
      account = {...account, account_status: 2};
    },
    plan: (webActor, id) => service.call('amcp_campaign', {action: 'get', id}, webActor),
    close: () => store.close(),
  };
}

export const spendPolicyConnection = 'aaaaaaaa-7777-4777-8777-000000000002';
export const spendPolicySeed = Object.freeze({
  enforcement: 'block',
  max_budget_increase_percent: 20,
  max_budget_native: 10000,
  max_daily_increase_native: 5000,
  max_bid_native: 500,
  allow_activation: false,
  allow_deletion: false,
});

/** An owner workspace with one Meta account whose stored spending policy is edited on Settings. No provider call. */
export function spendPolicyEditFixture() {
  const keyByte = 172,
    actor = {tenantId: 'synthetic-spend-policy', userId: 'fixture', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, keyByte).toString('base64'));
  store.putConnection(
    actor,
    {
      id: spendPolicyConnection,
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Meta policy account',
      scopes: ['ads_management'],
    },
    {accessToken: 'synthetic-spend-policy'},
  );
  const recorded = syntheticTransport([], () => {
    throw Error('The spending-policy fixture reads no provider');
  });
  const service = new MirrorService(new Registry(), store, new NativeTransport(recorded.transport), undefined, {
    allowWrites: true,
    requireBeforeState: true,
  });
  const stored = async webActor => {
    const health = await service.call('amcp_workspace', {action: 'health'}, webActor);
    assert.equal(health.success, true, JSON.stringify(health.error));
    const binding = health.data.spend_policy_bindings.find(
      b => b.gateway === 'meta_native_action' && b.account_id === '123',
    );
    return binding ? health.data.policies.find(p => p.id === binding.policy_id) : undefined;
  };
  return {
    keyByte,
    actor,
    store,
    service,
    requests: recorded.reads,
    syntheticWrites: () => 0,
    writes: () => recorded.counts().provider_writes,
    stored,
    /** Puts the seeded account policy back, at the next revision, before each journey. */
    async reset(webActor) {
      const current = await stored(webActor);
      const saved = await service.call(
        'amcp_workspace',
        {
          action: 'save_spend_policy',
          gateway: 'meta_native_action',
          connection_id: spendPolicyConnection,
          account_id: '123',
          policy: {...spendPolicySeed},
          expected_revision: current?.revision ?? 0,
          confirmed: true,
        },
        webActor,
      );
      assert.equal(saved.success, true, JSON.stringify(saved.error));
      return stored(webActor);
    },
    close: () => store.close(),
  };
}

export const exportSpreadsheet = 'syntheticExportSheet';
export const exportRoutes = Object.freeze([
  {
    method: 'POST',
    origin: 'https://sheets.googleapis.com',
    path: /^\/v4\/spreadsheets\/syntheticExportSheet:batchUpdate$/,
  },
]);

/**
 * Two retained snapshots of one Meta account and one owned synthetic Sheets tab. Exporting the newer snapshot writes
 * the tab (complete); exporting the older one afterwards writes nothing (superseded, EXP-03).
 */
export function exportOutcomesFixture() {
  const keyByte = 173,
    actor = {tenantId: 'synthetic-export-outcomes', userId: 'fixture', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, keyByte).toString('base64')),
    tab = {markers: [{metadataKey: 'amcp_destination', metadataValue: 'synthetic-dest', metadataId: 1}], report: null};
  let metadataId = 10,
    sequence = 0;
  const recorded = syntheticTransport(exportRoutes, ({url, init, synthetic}) => {
    if (url.origin !== 'https://sheets.googleapis.com') throw Error('The export fixture reads no advertising provider');
    if (!synthetic)
      return Response.json({
        spreadsheetId: exportSpreadsheet,
        properties: {title: 'Synthetic export spreadsheet'},
        sheets: [
          {
            properties: {sheetId: 7, title: 'Client report', gridProperties: {rowCount: 100, columnCount: 40}},
            developerMetadata: tab.markers.map(m => ({...m})),
          },
        ],
      });
    const body = JSON.parse(String(init.body));
    for (const r of body.requests) {
      if (r.createDeveloperMetadata)
        tab.markers.push({...r.createDeveloperMetadata.developerMetadata, metadataId: metadataId++});
      if (r.updateDeveloperMetadata) {
        const id = r.updateDeveloperMetadata.dataFilters[0].developerMetadataLookup.metadataId,
          marker = tab.markers.find(m => m.metadataId === id);
        if (marker) marker.metadataValue = r.updateDeveloperMetadata.developerMetadata.metadataValue;
      }
      if (r.deleteDeveloperMetadata) {
        const key = r.deleteDeveloperMetadata.dataFilter.developerMetadataLookup.metadataKey;
        tab.markers = tab.markers.filter(m => m.metadataKey !== key);
      }
      if (r.updateCells?.rows?.length > 1) {
        const header = r.updateCells.rows[0].values.map(v => v.userEnteredValue?.stringValue);
        tab.report = r.updateCells.rows[1].values[header.indexOf('Report ID')]?.userEnteredValue?.stringValue ?? null;
      }
    }
    return Response.json({spreadsheetId: exportSpreadsheet, replies: body.requests.map(() => ({}))});
  });
  store.putConnection(
    actor,
    {
      id: 'synthetic-export-sheets',
      tenantId: actor.tenantId,
      gateway: sheetsGateway,
      enabled: true,
      accounts: [exportSpreadsheet],
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      label: 'Synthetic Sheets login',
    },
    {accessToken: 'synthetic-export-sheets'},
  );
  store.putConnection(
    actor,
    {
      id: 'synthetic-export-meta',
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      enabled: true,
      accounts: ['123'],
      scopes: ['ads_read'],
      label: 'Synthetic Meta source',
    },
    {accessToken: 'synthetic-export-source'},
  );
  store.putDocument(actor.tenantId, 'sheets_destination', 'synthetic-dest', {
    connection_id: 'synthetic-export-sheets',
    spreadsheet_id: exportSpreadsheet,
    sheet_id: 7,
    tab_name: 'Client report',
    name: 'Synthetic client sheet',
  });
  const service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(recorded.transport, async () => {}),
      undefined,
      undefined,
      recorded.transport,
    ),
    overview = new ReportingOverview(service, recorded.transport),
    worker = new ReportWorker(
      store,
      async () => ({}),
      (tenant, kind, input) => overview.work(tenant, kind, input),
    );
  const snapshot = (webActor, id, capturedAt) => {
    const r = {
      state: 'complete',
      captured_at: capturedAt,
      created_at: capturedAt,
      completed_at: capturedAt + 5,
      config: {
        name: 'Synthetic client report',
        client_name: 'Synthetic client',
        date_range: {since: '2026-09-01', until: '2026-09-02'},
        metrics: ['spend'],
        custom_metrics: [],
        targets: {},
        objectives: [],
        partial_delivery: 'allow_marked',
        sources: [{platform: 'meta', account_id: '123', connection_id: 'synthetic-export-meta'}],
      },
      sources: [],
      actor_binding: store.bindJobActor(webActor, id),
      row_count: 1,
      rows: [
        {
          platform: 'meta',
          account_id: '123',
          campaign_id: '9',
          campaign_name: 'Synthetic campaign',
          currency: 'USD',
          timezone: 'UTC',
          date_from: '2026-09-01',
          date_to: '2026-09-02',
          metrics: {spend: capturedAt % 1000},
          recommendation: {decision: 'observe', reason: 'Synthetic'},
          complete: true,
          captured_at: capturedAt,
        },
      ],
    };
    r.job_id = store.enqueue(actor.tenantId, 'report_overview', {report_id: id});
    store.db.prepare("UPDATE jobs SET state='complete' WHERE id=?").run(r.job_id);
    store.putDocument(actor.tenantId, 'overview_report', id, r);
  };
  return {
    keyByte,
    actor,
    store,
    service,
    overview,
    requests: recorded.reads,
    syntheticWrites: () => recorded.synthetic.length,
    writes: () => recorded.counts().provider_writes,
    tab,
    /** A newer and an older snapshot for this journey; both newer than any earlier journey's. */
    seed(webActor) {
      const base = Date.parse('2026-09-03T00:00:00Z') + ++sequence * 100000;
      const older = 'synthetic-older-' + sequence,
        newer = 'synthetic-newer-' + sequence;
      snapshot(webActor, older, base);
      snapshot(webActor, newer, base + 50000);
      return {older, newer, destination: 'synthetic-dest'};
    },
    /** Runs the queued delivery job, as the worker process would. */
    workOnce: () => {
      store.db.prepare('UPDATE jobs SET available_at=0').run();
      return worker.once();
    },
    close: () => store.close(),
  };
}
