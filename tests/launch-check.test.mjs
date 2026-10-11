// CMP-07: amcp_reporting launch_check. The generic audit refuses Meta and Snapchat (native-only platforms), so 6 of the
// 12 packs had no rule-based post-launch check. Synthetic Meta and Snapchat launches, native reads and retained captures
// feed the pure campaign audit; missing evidence stays an explicit unknown, a paused campaign is never a false alarm and
// nothing is written.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {campaignRecipe} from '../dist/src/campaign-recipes.js';
import {launchCheck} from '../dist/src/launch-check.js';
import {assertRefused} from './helpers/assert-refused.mjs';

const examples = JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'));
const actor = {tenantId: 'launch-check', userId: 'operator', role: 'operator'};
const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');

function launch(platform, {verified = true} = {}) {
  const recipe = platform === 'meta' ? 'meta_website_traffic' : 'snapchat_website_traffic',
    business =
      platform === 'meta'
        ? {...examples.recipe_business, connection_id: 'meta-login'}
        : {...examples.snapchat_traffic_business, connection_id: 'snap-login'},
    plan = campaignRecipe(recipe, business),
    results =
      platform === 'meta'
        ? {
            campaign: {data: {id: '701'}},
            adset: {data: {id: '702'}},
            creative: {data: {id: '703'}},
            ad: {data: {id: '704'}},
          }
        : {
            campaign: {data: {campaigns: [{campaign: {id: uuid(1)}}]}},
            squad: {data: {adsquads: [{adsquad: {id: uuid(2)}}]}},
            ad: {data: {ads: [{ad: {id: uuid(3)}}]}},
          };
  return {
    id: 'plan-' + platform,
    state: verified ? 'complete' : 'draft',
    recipe: plan.recipe,
    steps: plan.steps.map(s => ({
      ...s,
      status: verified ? 'verified' : 'draft',
      ...(verified ? {result: results[s.id] ?? {}} : {}),
    })),
  };
}
function fixture(platform, state = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 77).toString('base64')),
    gateway = platform + '_native_action',
    login = platform === 'meta' ? 'meta-login' : 'snap-login',
    account = platform === 'meta' ? '123' : examples.snapchat_traffic_business.account_id;
  store.putConnection(
    {...actor, role: 'admin'},
    {
      id: login,
      tenantId: actor.tenantId,
      gateway,
      accounts: [account, '999'],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const run = state.run ?? launch(platform),
    reads = [],
    native = {
      meta_campaign_get: () => ({
        id: state.campaignId ?? '701',
        status: state.status ?? 'PAUSED',
        effective_status: state.status ?? 'PAUSED',
        objective: 'OUTCOME_TRAFFIC',
        start_time: '2026-11-01T10:00:00+0300',
      }),
      meta_ad_set_id_get: () => ({
        id: '702',
        campaign_id: '701',
        status: 'ACTIVE',
        start_time: '2026-11-01T10:00:00+0300',
        end_time: '2026-11-30T10:00:00+0300',
        daily_budget: '2500',
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      }),
      meta_ad_account_id_get: () => ({account_id: '123', currency: 'USD', timezone_name: 'UTC'}),
      snapchat_campaign_get: () => ({
        campaigns: [
          {
            campaign: {
              id: uuid(1),
              ad_account_id: account,
              status: state.status ?? 'PAUSED',
              start_time: '2026-11-01T07:00:00.000Z',
            },
          },
        ],
      }),
      snapchat_adsquad_get: () => ({
        adsquads: [
          {
            adsquad: {
              id: uuid(2),
              campaign_id: uuid(1),
              status: 'PAUSED',
              daily_budget_micro: 20000001,
              bid_strategy: 'AUTO_BID',
            },
          },
        ],
      }),
      snapchat_account_get: () => ({adaccounts: [{adaccount: {id: account, currency: 'USD', timezone: 'UTC'}}]}),
    };
  const readPlan = async id => {
    assert.equal(id, run.id);
    return {success: true, data: run};
  };
  const call = async (tool, input) => {
    reads.push(input);
    assert.ok(native[input.action], 'only reads are made: ' + input.action);
    assert.equal(tool, gateway);
    return {success: true, data: {data: native[input.action]()}};
  };
  const report = (rows, extra = {}) => {
    const id = 'report-' + Math.random().toString(36).slice(2);
    store.putDocument(actor.tenantId, 'decision_report', id, {
      gateway,
      connection_id: login,
      account_id: account,
      grain: 'campaign × day',
      semantics: {currency: 'USD', timezone: 'UTC', date_from: '2026-11-02', date_to: '2026-11-03', complete: true},
      rows,
      ...extra,
    });
    return id;
  };
  return {
    store,
    reads,
    report,
    check: input => launchCheck(store, call, readPlan, actor, {id: run.id, ...input}),
    close: () => store.close(),
  };
}

test('a paused Snapchat launch is checked from its own native reads; delivery stays unknown, never a false alarm', async t => {
  const f = fixture('snapchat');
  t.after(f.close);
  const out = await f.check({});
  assert.deepEqual(
    f.reads.map(r => [r.action, r.path_params]),
    [
      ['snapchat_campaign_get', {campaign_id: uuid(1)}],
      ['snapchat_adsquad_get', {ad_squad_id: uuid(2)}],
      ['snapchat_account_get', {ad_account_id: examples.snapchat_traffic_business.account_id}],
    ],
  );
  assert.equal(out.delivery.status, 'unknown');
  assert.equal(out.delivery.reason, 'campaign_paused');
  const finding = id => out.audit.findings.find(x => x.check === id);
  assert.equal(finding('budget').status, 'pass', 'the ad squad budget of 20.000001 USD meets the USD 5 rule');
  assert.equal(out.field_sources.daily_budget, 'ad_squad');
  assert.equal(finding('bid_strategy').status, 'pass');
  assert.equal(finding('schedule').status, 'unknown', 'an open-ended flight is not assumed intentional');
  assert.equal(finding('creative_fatigue').status, 'unknown');
  assert.equal(finding('targeting').status, 'unknown');
  assert.ok(out.audit.unknowns.length >= 3, 'unknowns are explicit');
  assert.equal(out.audit.automated_changes, false);
  assert.equal(out.network_requests, 3);
  assert.ok(out.sources.every(s => /^[0-9a-f]{64}$/.test(s.response_hash)));
});

test('an active Meta launch with a retained capture shows observed delivery and frequency findings', async t => {
  const f = fixture('meta', {status: 'ACTIVE'});
  t.after(f.close);
  const id = f.report([
    {
      entity_id: '701',
      date: '2026-11-02',
      impressions: '1000',
      clicks: '20',
      spend: '12.5',
      conversions: '1',
      frequency: '7.2',
    },
    {
      entity_id: '701',
      date: '2026-11-03',
      impressions: '900',
      clicks: '15',
      spend: '11',
      conversions: '0',
      frequency: '2.1',
    },
    {entity_id: '888', date: '2026-11-02', impressions: '5', clicks: '0', spend: '1', conversions: '0', frequency: '1'},
  ]);
  const out = await f.check({report_id: id});
  assert.equal(out.delivery.status, 'observed');
  assert.equal(out.delivery.impressions, 1900, 'only this campaign’s rows count');
  const finding = c => out.audit.findings.find(x => x.check === c);
  assert.equal(finding('creative_fatigue').status, 'critical');
  assert.equal(finding('budget').status, 'pass', 'the ad set budget of 2500 cents is 25 USD');
  assert.equal(out.field_sources.daily_budget, 'ad_set');
  assert.equal(finding('schedule').status, 'pass');
  assert.equal(out.audit.observed_metrics.impressions, 1900);
  assert.equal(out.report_complete, true);
  // A capture without impressions for this campaign is "none reported", which is still unknown, not a fault.
  const quiet = f.report([{entity_id: '888', date: '2026-11-02', impressions: '5'}]);
  const none = await f.check({report_id: quiet});
  assert.equal(none.delivery.status, 'unknown');
  assert.equal(none.delivery.reason, 'none_reported');
  assert.equal(none.audit.findings.find(x => x.check === 'creative_fatigue').status, 'unknown');
  // Without a capture, delivery is unknown and the next read is named.
  const bare = await f.check({});
  assert.equal(bare.delivery.reason, 'no_report');
  assert.equal(bare.delivery.next_call.arguments.action, 'capture_presets');
});

test('a capture of another account or grain, a foreign campaign and an unfinished launch are refused', async t => {
  const f = fixture('meta', {status: 'ACTIVE'});
  t.after(f.close);
  await assert.rejects(f.check({report_id: f.report([], {account_id: '999'})}), e =>
    assertRefused(e, 'LAUNCH_CHECK_REPORT_MISMATCH'),
  );
  await assert.rejects(f.check({report_id: f.report([], {grain: 'ad set × day'})}), e =>
    assertRefused(e, 'LAUNCH_CHECK_REPORT_MISMATCH'),
  );
  const foreign = fixture('meta', {campaignId: '9999'});
  t.after(foreign.close);
  await assert.rejects(foreign.check({}), e => assertRefused(e, 'STATE_TARGET_MISMATCH'));
  const draft = fixture('snapchat', {run: launch('snapchat', {verified: false})});
  t.after(draft.close);
  await assert.rejects(draft.check({}), e => assertRefused(e, 'LAUNCH_CHECK_NOT_READY'));
  assert.equal(draft.reads.length, 0, 'nothing is read before the launch is verified');
});

test('amcp_reporting serves launch_check; a Google launch is pointed to the campaign audit workflow', async t => {
  const store = new Store(':memory:', Buffer.alloc(32, 78).toString('base64'));
  t.after(() => store.close());
  store.putConnection(
    {...actor, role: 'admin'},
    {
      id: 'synthetic-login',
      tenantId: actor.tenantId,
      gateway: 'google_ads_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Google',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  let requests = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      requests++;
      throw Error('No provider request is expected');
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const plan = campaignRecipe('google_search', examples.recipe_business),
    created = await service.call(
      'amcp_campaign',
      {action: 'create', name: 'Google launch', brief: 'Synthetic.', steps: plan.steps},
      actor,
    );
  assert.equal(created.success, true, JSON.stringify(created.error));
  const saved = store.document(actor.tenantId, 'campaign_run', created.data.id);
  store.putDocument(actor.tenantId, 'campaign_run', saved.id, {...saved, recipe: plan.recipe}, saved.revision);
  const out = await service.call('amcp_reporting', {action: 'launch_check', id: saved.id}, actor);
  assertRefused(out, 'LAUNCH_CHECK_UNSUPPORTED');
  assert.equal(out.error.details.next_call.tool, 'amcp_native_action');
  assert.equal(requests, 0);
});
