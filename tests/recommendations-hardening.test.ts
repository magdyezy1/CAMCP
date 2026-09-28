import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {ReportingOverview} from '../src/reporting-overview.js';
import {ReportWorker} from '../src/worker.js';
import {createEncryptedBackup, verifyEncryptedBackup} from '../src/backup.js';
import {saveSpendPolicy, checkSpendPolicy} from '../src/spend-policy.js';
import {MirrorError} from '../src/errors.js';
import {campaignRecipe} from '../src/campaign-recipes.js';
import {metaPrerequisites} from '../src/meta-prerequisites.js';
import {campaignPreflight} from '../src/campaign-preflight.js';
import {reportSummary} from '../src/report-summary.js';
import {calculateMetrics} from '../src/report-metrics.js';
import {xCampaignReport} from '../src/x-campaign-report.js';
import {zonedMidnight} from '../src/workflows.js';
import {normalizeNativeRow, NativeCampaignReports} from '../src/report-native.js';
import type {Actor, CompiledRequest, JsonObject} from '../src/types.js';

const key = Buffer.alloc(32, 37).toString('base64'),
  actor: Actor = {tenantId: 'hardening', userId: 'owner', role: 'admin'},
  registry = new Registry();
const connection = (store: Store, gateway = 'meta_native_action') =>
  store.putConnection(
    actor,
    {
      id: gateway,
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      label: 'Fixture',
      enabled: true,
      scopes: [],
    },
    {accessToken: 'fixture', developerToken: 'fixture'},
  );
/** Messages are user-facing prose; the code is the contract. Pin both. */
const policyRefusal = (fn: () => unknown, code: string, message: RegExp) => {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof MirrorError)) throw e;
    assert.equal(e.code, code, 'expected ' + code + ' but got ' + e.code + ': ' + e.message);
    assert.match(e.message, message);
    return;
  }
  throw new Error('expected ' + code + ', but the call returned normally');
};
const policyPlan: CompiledRequest = {
  gateway: 'meta_native_action',
  accountId: '123',
  action: 'meta_adset_update',
  method: 'POST',
  path: '/v25.0/456',
  query: {},
  body: {daily_budget: 120},
  headers: {},
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  evidence: 'fixture',
  warnings: [],
};

test('owner budgets enforce percentage, cumulative daily limits and activation without weakening review', () => {
  const store = new Store(':memory:', key);
  try {
    connection(store);
    saveSpendPolicy(store, actor, {
      gateway: policyPlan.gateway,
      account_id: '123',
      confirmed: true,
      policy: {
        allow_activation: false,
        allow_deletion: false,
        max_budget_native: 200,
        max_budget_increase_percent: 25,
        max_daily_increase_native: 30,
      },
    });
    assert.equal(
      checkSpendPolicy(store, actor, policyPlan, [{daily_budget: 100}], 'first').requested_increase_native,
      20,
    );
    policyRefusal(
      () => checkSpendPolicy(store, actor, {...policyPlan, body: {daily_budget: 130}}, [{daily_budget: 100}]),
      'POLICY_INCREASE_LIMIT',
      /percentage/,
    );
    policyRefusal(
      () => checkSpendPolicy(store, actor, policyPlan, [{daily_budget: 100}], 'second'),
      'POLICY_DAILY_INCREASE_LIMIT',
      /daily policy/,
    );
    assert.equal(
      checkSpendPolicy(store, actor, policyPlan, [{daily_budget: 100}], 'first').requested_increase_native,
      20,
    );
    policyRefusal(
      () => checkSpendPolicy(store, actor, {...policyPlan, body: {status: 'ACTIVE'}}, []),
      'POLICY_ACTIVATION_FORBIDDEN',
      /activation/,
    );
    policyRefusal(
      () => checkSpendPolicy(store, actor, {...policyPlan, destructive: true}, []),
      'POLICY_DELETION_FORBIDDEN',
      /deletion/,
    );
    policyRefusal(
      () =>
        saveSpendPolicy(
          store,
          {...actor, role: 'operator'},
          {gateway: policyPlan.gateway, account_id: '123', confirmed: true, policy: {}},
        ),
      'OWNER_REQUIRED',
      /owner/,
    );
  } finally {
    store.close();
  }
});

test('whole-plan preflight blocks a later missing account grant before any provider mutation', async () => {
  const store = new Store(':memory:', key),
    calls: JsonObject[] = [];
  try {
    connection(store);
    store.putConnection(
      actor,
      {
        id: 'later',
        tenantId: actor.tenantId,
        gateway: 'meta_native_action',
        accounts: ['789'],
        writeAccounts: [],
        enabled: true,
        label: 'No grant',
        scopes: [],
      },
      {accessToken: 'fixture'},
    );
    const service = new MirrorService(
      registry,
      store,
      new NativeTransport(async (url, init) => {
        calls.push({url, method: init?.method});
        return Response.json({id: 'act_123', account_status: 1, currency: 'USD'});
      }),
      undefined,
      {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
    );
    const steps = [
      {
        id: 'first',
        kind: 'write',
        gateway: 'meta_native_action',
        account_id: '123',
        connection_id: 'meta_native_action',
        arguments: {
          action: 'meta_campaign_create',
          payload: {name: 'test', objective: 'OUTCOME_TRAFFIC', status: 'PAUSED', special_ad_categories: []},
        },
        depends_on: [],
      },
      {
        id: 'later',
        kind: 'write',
        gateway: 'meta_native_action',
        account_id: '789',
        connection_id: 'later',
        arguments: {action: 'meta_ad_create', payload: {}},
        depends_on: [],
      },
    ];
    const r = await campaignPreflight(service, actor, steps);
    assert.equal(r.status, 'blocked');
    assert.equal(r.checks.find((c: JsonObject) => c.step === 'later').error.code, 'WRITE_ACCOUNT_FORBIDDEN');
    assert.ok(calls.every(c => c.method === 'GET'));
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM idempotency').get()!.n, 0);
  } finally {
    store.close();
  }
});

test('business recipes compile every native contract and require explicit political/category declarations', async () => {
  const store = new Store(':memory:', key);
  try {
    for (const gateway of ['google_ads_native_action', 'microsoft_ads_native_action', 'meta_native_action'])
      connection(store, gateway);
    const service = new MirrorService(registry, store, new NativeTransport(async () => Response.json({})), undefined, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    });
    service.runPlan = async p => ({
      data: p.path.endsWith('/promote_pages')
        ? {data: [{id: '456'}]}
        : {currency: 'USD', Account: {CurrencyCode: 'USD'}, results: [{customer: {id: '123', currencyCode: 'USD'}}]},
    });
    const business = {
      name: 'Website demand',
      account_id: '123',
      currency: 'USD',
      daily_budget: '25.00',
      cpc_bid: '1.25',
      country_criterion_ids: ['2840'],
      language_criterion_ids: ['1000'],
      country_codes: ['US'],
      page_id: '456',
      message: 'Explore the collection',
      headline: 'Made for every day',
      drive_url: 'https://drive.google.com/file/d/abcdefghijklmno/view',
      keywords: ['running shoes'],
      headlines: ['Explore the collection', 'Find your next pair', 'Built for every day'],
      descriptions: [
        'Discover our latest collection online today.',
        'Explore styles and find a pair that fits your day.',
      ],
      destination_url: 'https://example.test/',
      language: 'English',
      location_ids: ['190'],
      start_date: '2026-10-01',
      end_date: '2026-10-31',
      start_time: '2026-10-01T00:00:00Z',
      end_time: '2026-11-01T00:00:00Z',
      contains_eu_political_advertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      special_ad_categories: [],
    };
    for (const id of ['google_search', 'microsoft_search', 'meta_website_traffic']) {
      const gateway = id.startsWith('google')
          ? 'google_ads_native_action'
          : id.startsWith('meta')
            ? 'meta_native_action'
            : 'microsoft_ads_native_action',
        plan = campaignRecipe(id, {...business, connection_id: gateway});
      const steps = plan.steps.filter((s: JsonObject) => s.kind !== 'media');
      if (id.startsWith('meta'))
        steps.find((s: JsonObject) => s.id === 'creative').arguments.payload.object_story_spec.link_data.image_hash =
          'fixturehash';
      const result = await campaignPreflight(service, actor, steps);
      assert.equal(result.status, 'ready', id + ': ' + JSON.stringify(result));
      assert.ok(JSON.stringify(plan).includes('PAUSED') || JSON.stringify(plan).includes('Paused'));
    }
    assert.throws(
      () =>
        campaignRecipe('google_search', {
          ...business,
          connection_id: 'google_ads_native_action',
          contains_eu_political_advertising: undefined,
        }),
      /brief/,
    );
    assert.throws(
      () =>
        campaignRecipe('meta_website_traffic', {
          ...business,
          connection_id: 'meta_native_action',
          start_time: '2026-02-30T00:00:00Z',
        }),
      /valid ISO/,
    );
    assert.throws(
      () =>
        campaignRecipe('google_search', {
          ...business,
          connection_id: 'google_ads_native_action',
          start_date: '2026-02-30',
        }),
      /valid YYYY/,
    );
    assert.throws(
      () =>
        campaignRecipe('meta_website_traffic', {
          ...business,
          connection_id: 'meta_native_action',
          special_ad_categories: ['HOUSING'],
        }),
      /tailored/,
    );
  } finally {
    store.close();
  }
});

test('encrypted backup restores audit and credentials, rejects tampering and never overwrites a file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-backup-test-')),
    file = path.join(dir, 'backup.amcp'),
    store = new Store(':memory:', key);
  try {
    connection(store);
    store.appendAudit(actor.tenantId, 'one', {event: 'fixture'});
    const receipt = await createEncryptedBackup(store, file, key);
    assert.equal(receipt.status, 'verified');
    assert.ok(!fs.readFileSync(file).includes(Buffer.from('SQLite format')));
    assert.equal((await verifyEncryptedBackup(file, key)).sha256, receipt.sha256);
    await assert.rejects(() => createEncryptedBackup(store, file, key), /exist/i);
    const bytes = fs.readFileSync(file);
    bytes[bytes.length - 1]! ^= 1;
    fs.writeFileSync(file, bytes);
    await assert.rejects(() => verifyEncryptedBackup(file, key), /authentication|restoration/);
  } finally {
    store.close();
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});

test('Google resumable upload queries a lost chunk offset and never repeats a lost finalization', async () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024, 73),
    calls: JsonObject[] = [],
    progress: number[] = [];
  let lost = true;
  const t = new NativeTransport(async (_url, init) => {
    const h = new Headers(init?.headers);
    calls.push({method: init?.method, offset: h.get('X-Goog-Upload-Offset'), command: h.get('X-Goog-Upload-Command')});
    if (init?.method === 'POST')
      return new Response(null, {headers: {'x-goog-upload-size-received': String(4 * 1024 * 1024)}});
    if (lost) {
      lost = false;
      throw Error('lost response');
    }
    assert.equal(h.get('X-Goog-Upload-Offset'), String(4 * 1024 * 1024));
    assert.equal((init?.body as Uint8Array).length, 1024 * 1024);
    return Response.json({resourceName: 'customers/123/youTubeVideoUploads/456'});
  });
  const result = await t.uploadGoogleVideo(
    'https://googleads.googleapis.com/resumable/upload/v23/session',
    bytes,
    'fixture',
    {progress: n => progress.push(n)},
  );
  assert.equal(result.status, 200);
  assert.deepEqual(
    calls.map(c => c.command),
    ['upload', 'query', 'upload, finalize'],
  );
  assert.deepEqual(progress, [4 * 1024 * 1024, bytes.length]);
  let attempts = 0;
  const final = new NativeTransport(async () => {
    attempts++;
    throw Error('lost final');
  });
  await assert.rejects(
    () =>
      final.uploadGoogleVideo(
        'https://googleads.googleapis.com/resumable/upload/v23/session',
        Buffer.alloc(10),
        'fixture',
      ),
    /lost/,
  );
  assert.equal(attempts, 1);
});

test('encrypted media staging spans chunks, detects corruption and supports a worker-owned frozen upload', async () => {
  const store = new Store(':memory:', key),
    png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    );
  try {
    connection(store);
    const bytes = Buffer.alloc(9 * 1024 * 1024, 61);
    store.reserveMedia(actor.tenantId, 'chunked', Date.now() + 300000);
    store.stageMedia(actor.tenantId, 'chunked', bytes);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM media_chunks').get()!.n, 3);
    assert.deepEqual(store.stagedMedia(actor.tenantId, 'chunked'), bytes);
    store.db.prepare('DELETE FROM media_chunks WHERE chunk_index=1').run();
    assert.throws(() => store.stagedMedia(actor.tenantId, 'chunked'));
    store.removeStagedMedia(actor.tenantId, 'chunked');
    let writes = 0;
    const service = new MirrorService(
      registry,
      store,
      new NativeTransport(async (_u, i) => {
        if (i?.method === 'GET') return Response.json({id: 'act_123', account_status: 1, currency: 'USD'});
        writes++;
        return Response.json({images: {one: {hash: 'fixturehash'}}});
      }),
      undefined,
      {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
      async () => new Response(png),
    );
    const p = await service.call(
      'amcp_media',
      {
        action: 'prepare',
        platform: 'meta',
        account_id: '123',
        drive_url: 'https://drive.google.com/file/d/abcdefghijklmno/view',
      },
      actor,
    );
    assert.equal(p.success, true);
    const queued = await service.call(
      'amcp_media',
      {action: 'execute_async', review_id: p.data.review_id, idempotency_key: p.data.review_id, confirmed: true},
      actor,
    );
    assert.equal(writes, 0);
    const overview = new ReportingOverview(service),
      worker = new ReportWorker(
        store,
        async () => ({}),
        (t, k, i) => overview.work(t, k, i),
      );
    await worker.once();
    assert.equal(writes, 1);
    const status = await service.call('amcp_media', {action: 'job_status', review_id: p.data.review_id}, actor);
    assert.equal(status.data.state, 'complete', JSON.stringify(status));
    await worker.once();
    assert.equal(writes, 1);
    assert.equal(queued.data.job_id, status.data.job_id);
  } finally {
    store.close();
  }
});

test('report totals preserve currencies, missing values and non-additive reach; ratios use aggregated components', () => {
  const row = (currency: string, spend: number, clicks: number, reach: number) => ({
    platform: 'meta',
    account_id: currency,
    currency,
    timezone: 'UTC',
    objective_group: 'traffic',
    result_definition: 'clicks',
    attribution: 'configured',
    complete: true,
    recommendation: {decision: 'maintain'},
    metrics: calculateMetrics({spend, clicks, impressions: 100, reach}),
  });
  const totals = reportSummary([row('USD', 10, 10, 50), row('USD', 30, 5, 70), row('EUR', 99, 9, 90)]);
  assert.equal(totals.length, 2);
  assert.equal(totals[0]!.metrics.spend, 40);
  assert.equal(totals[0]!.metrics.cpc, 40 / 15);
  assert.equal(totals[0]!.metrics.reach, null);
  assert.equal(totals[0]!.metrics.conversions, null);
  assert.equal(new Date(zonedMidnight('2026-09-01', 'Asia/Kolkata', true)).toISOString(), '2026-08-31T18:30:00.000Z');
  assert.throws(() => zonedMidnight('2026-09-01', 'Asia/Kolkata'), /whole-hour/);
});

test('X covers every placement, separates mobile conversion requests and sums nested hourly metrics', async () => {
  const calls: JsonObject[] = [];
  const r = await xCampaignReport(
    [{id: 'one', name: 'Traffic', objective: 'WEBSITE_CLICKS'}],
    Date.parse('2026-08-01'),
    Date.parse('2026-08-02'),
    ['MOBILE_CONVERSION'],
    async query => {
      calls.push(query);
      return {
        data: [
          {
            id: 'one',
            id_data: [
              {
                segment: null,
                metrics:
                  query.metric_groups === 'MOBILE_CONVERSION'
                    ? {mobile: {installs: Array(24).fill(1)}}
                    : {
                        impressions: Array(24).fill(2),
                        clicks: Array(24).fill(1),
                        billed_charge_local_micro: Array(24).fill(1000000),
                      },
              },
            ],
          },
        ],
      };
    },
  );
  assert.equal(r.complete, true);
  assert.equal(calls.length, 6);
  assert.deepEqual([...new Set(calls.map(c => c.placement))], ['ALL_ON_TWITTER', 'SPOTLIGHT', 'TREND']);
  assert.ok(
    calls.every(c => !c.metric_groups.includes('MOBILE_CONVERSION') || c.metric_groups === 'MOBILE_CONVERSION'),
  );
  assert.equal(r.rows[0]!.metrics.spend, 72);
  assert.equal(r.rows[0]!.native_metrics.mobile_installs, 72);
  await assert.rejects(
    () => xCampaignReport([{id: 'one'}], 0, 86400000, [], async () => ({data: [{id: 'other', id_data: []}]})),
    /unexpected/,
  );
});

test('native report collectors read Reddit metrics envelopes and GA4 property metadata without account-scope changes', async () => {
  const store = new Store(':memory:', key);
  try {
    connection(store, 'reddit_native_action');
    connection(store, 'ga4_native_action');
    const requests: CompiledRequest[] = [],
      service = {
        store,
        runPlan: async (p: CompiledRequest) => {
          requests.push(p);
          if (p.path.endsWith('/reports'))
            return {
              success: true,
              data: {data: {metrics: [{campaign_id: '456', spend: 2500000, impressions: 40, clicks: 2}]}},
            };
          if (p.path.endsWith('/campaigns'))
            return {success: true, data: {data: [{id: '456', name: 'Traffic', objective: 'TRAFFIC'}]}};
          if (p.path.includes('runReport'))
            return {
              success: true,
              data: {
                metricHeaders: [{name: 'sessions'}, {name: 'totalUsers'}, {name: 'keyEvents'}, {name: 'totalRevenue'}],
                rows: [
                  {
                    dimensionValues: [{value: '456'}, {value: 'Traffic'}],
                    metricValues: [{value: '10'}, {value: '8'}, {value: '2'}, {value: '25'}],
                  },
                ],
                rowCount: 1,
              },
            };
          return {success: true, data: {data: {currency: 'USD'}, currencyCode: 'USD', timeZone: 'Asia/Kolkata'}};
        },
      } as unknown as MirrorService;
    const native = new NativeCampaignReports(service);
    for (const platform of ['reddit', 'ga4']) {
      const result = await native.collect(
        {platform, connection_id: platform + '_native_action', account_id: '123'},
        {since: '2026-08-01', until: '2026-08-07'},
        actor,
      );
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].campaign_id, '456');
      if (platform === 'reddit') assert.equal(result.rows[0].metrics.spend, 2.5);
      else assert.equal(result.rows[0].metrics.sessions, 10);
    }
    assert.ok(requests.every(p => p.readOnly && p.accountId === '123'));
    const snap = normalizeNativeRow('snapchat', {
      id: 'one',
      objective: 'SALES',
      stats: {spend: 1500000, conversion_purchases_value: 4000000, conversion_purchases: 2},
    });
    assert.equal(snap.metrics.conversion_value, 4);
  } finally {
    store.close();
  }
});

test('Meta preflight requires the actual Page and conversion pixel using only account-scoped reads', async () => {
  const store = new Store(':memory:', key);
  try {
    connection(store);
    const calls: CompiledRequest[] = [];
    const service = new MirrorService(
      registry,
      store,
      new NativeTransport(async () => {
        throw Error('Unexpected egress');
      }),
      undefined,
      {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
    );
    service.runPlan = async p => {
      calls.push(p);
      return {data: {data: []}};
    };
    await assert.rejects(
      () =>
        metaPrerequisites(
          service,
          actor,
          {
            ...policyPlan,
            path: '/v25.0/act_123/adcreatives',
            body: {object_story_spec: {page_id: '456', link_data: {link: 'https://example.test/'}}},
          },
          'meta_native_action',
        ),
      /Facebook Page/,
    );
    assert.equal(calls[0]!.path, '/v25.0/act_123/promote_pages');
    await assert.rejects(
      () =>
        metaPrerequisites(
          service,
          actor,
          {...policyPlan, path: '/v25.0/act_123/adsets', body: {optimization_goal: 'OFFSITE_CONVERSIONS'}},
          'meta_native_action',
        ),
      /pixel and conversion/,
    );
    await assert.rejects(
      () =>
        metaPrerequisites(
          service,
          actor,
          {
            ...policyPlan,
            path: '/v25.0/act_123/adsets',
            body: {optimization_goal: 'VALUE', promoted_object: {pixel_id: '789', custom_event_type: 'PURCHASE'}},
          },
          'meta_native_action',
        ),
      /Meta pixel/,
    );
    assert.ok(calls.every(p => p.readOnly && p.method === 'GET'));
  } finally {
    store.close();
  }
});

test('spending policy interprets JSON Patch budgets and rejects unknown budget units', () => {
  const store = new Store(':memory:', key);
  try {
    connection(store);
    saveSpendPolicy(store, actor, {
      gateway: policyPlan.gateway,
      account_id: '123',
      confirmed: true,
      policy: {max_budget_native: 200, max_budget_increase_percent: 25},
    });
    assert.equal(
      checkSpendPolicy(store, actor, {...policyPlan, body: [{op: 'replace', path: '/daily_budget', value: 120}]}, [
        {daily_budget: 100},
      ]).requested_increase_native,
      20,
    );
    policyRefusal(
      () =>
        checkSpendPolicy(store, actor, {...policyPlan, body: [{op: 'replace', path: '/daily_budget', value: 140}]}, [
          {daily_budget: 100},
        ]),
      'POLICY_INCREASE_LIMIT',
      /percentage/,
    );
    policyRefusal(
      () => checkSpendPolicy(store, actor, {...policyPlan, body: {unmapped_budget_field: 150}}, []),
      'POLICY_AMOUNT_UNSUPPORTED',
      /unit mapping/,
    );
  } finally {
    store.close();
  }
});

test('a resource-scoped REST.li POST is a budget update, not a create, and stays under the percentage policy', () => {
  const store = new Store(':memory:', key);
  try {
    connection(store, 'linkedin_native_action');
    saveSpendPolicy(store, actor, {
      gateway: 'linkedin_native_action',
      account_id: '123',
      confirmed: true,
      policy: {max_budget_increase_percent: 25},
    });
    const update: CompiledRequest = {
      gateway: 'linkedin_native_action',
      accountId: '123',
      action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_campaign_id_post',
      method: 'POST',
      path: '/rest/adAccounts/123/adCampaigns/456',
      query: {},
      body: {patch: {$set: {dailyBudget: {amount: '500', currencyCode: 'USD'}}}},
      headers: {'X-RestLi-Method': 'PARTIAL_UPDATE'},
      readOnly: false,
      destructive: false,
      requiresConfirmation: true,
      evidence: 'fixture',
      warnings: [],
    };
    const before = [{dailyBudget: {amount: '100', currencyCode: 'USD'}}];
    policyRefusal(() => checkSpendPolicy(store, actor, update, before), 'POLICY_INCREASE_LIMIT', /percentage/);
    // The same action name without the explicit REST.li header is still scoped to one campaign.
    policyRefusal(
      () => checkSpendPolicy(store, actor, {...update, headers: {}}, before),
      'POLICY_INCREASE_LIMIT',
      /percentage/,
    );
    // A change inside the limit still passes, proving the rule is applied rather than the write blocked.
    assert.equal(
      checkSpendPolicy(
        store,
        actor,
        {...update, body: {patch: {$set: {dailyBudget: {amount: '120', currencyCode: 'USD'}}}}},
        before,
      ).requested_increase_native,
      20,
    );
    // A collection POST remains a create: it has no baseline and must not be forced through the update path.
    const create: CompiledRequest = {
      ...update,
      action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_post',
      path: '/rest/adAccounts/123/adCampaigns',
      headers: {},
      body: {dailyBudget: {amount: '500', currencyCode: 'USD'}},
    };
    assert.equal(checkSpendPolicy(store, actor, create, []).requested_increase_native, 500);
  } finally {
    store.close();
  }
});
