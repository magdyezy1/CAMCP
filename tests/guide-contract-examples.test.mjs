import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {writeContractGateways} from '../dist/src/write-shape.js';
import {reviewedWriteFamily} from '../dist/src/reviewed-routes.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {bindRecipeStep, campaignRecipe, campaignRecipes, recipeProbePlanId} from '../dist/src/campaign-recipes.js';
import {campaignPreflight} from '../dist/src/campaign-preflight.js';
import {providerContracts} from '../dist/src/provider-contracts.js';
import {platforms} from '../dist/server/platform-oauth.js';
import {reportPlatforms} from '../dist/src/report-metrics.js';
import {mediaPlatforms} from '../dist/src/media-routing.js';
import {offerParkedProviders} from './helpers/parked-providers.mjs';
import {pinBeforeTiktokCutoff} from './helpers/tiktok-cutoff-clock.mjs';

// Package r25-m4-classic: TikTok stops classic Sales, App Promotion and Lead Generation creates on 2027-01-01 and AMCP refuses them from
// that day (src/tiktok-manual-cutoff.ts); the guide’s checked examples include the website purchases pack’s brief (a classic Sales campaign), so the clock is pinned before it.
pinBeforeTiktokCutoff();

// Criteo is parked (ARC-01, P9): the guide keeps its examples, so this suite checks them with it offered, like a
// deployment whose AMCP_PROVIDERS names it.
offerParkedProviders('criteo');
const examples = JSON.parse(fs.readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'));
const actor = {tenantId: 'guidance-examples', userId: 'owner', role: 'admin'},
  key = Buffer.alloc(32, 81).toString('base64');

test('X audience-estimate guidance compiles a scoped read without credentials or writes', async () => {
  const store = new Store(':memory:'),
    service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async () => {
        throw Error('Example attempted egress');
      }),
    );
  try {
    assert.equal(examples.x_audience_estimate_previews.length, 1);
    for (const example of examples.x_audience_estimate_previews) {
      const out = await service.call(example.gateway, example.arguments, actor);
      assert.equal(out.success, true, JSON.stringify(out));
      assert.equal(out.data.executed, false);
      assert.equal(out.data.request.readOnly, true);
      assert.equal(out.data.request.accountId, 'abc12');
      assert.equal(out.data.request.body.targeting_criteria.length, 2);
      assert.match(out.data.request.warnings.join(' '), /estimated potential audience/);
    }
  } finally {
    store.close();
  }
});
test('TikTok preview and Smart Text examples compile as reads without credentials or egress', async () => {
  const store = new Store(':memory:'),
    service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async () => {
        throw Error('Example attempted egress');
      }),
    );
  try {
    assert.equal(examples.tiktok_preview_reads.length, 3);
    for (const example of examples.tiktok_preview_reads) {
      const out = await service.call(example.gateway, {...example.arguments, dry_run: true}, actor);
      assert.equal(out.success, true, JSON.stringify(out));
      assert.equal(out.data.executed, false);
      assert.equal(out.data.request.readOnly, true);
      assert.equal(out.data.request.requiresConfirmation, false);
      assert.match(out.data.request.warnings.join(' '), /Nothing in the ad account changes/);
    }
  } finally {
    store.close();
  }
});
test('X asynchronous report retrieval example compiles with server-only download controls and no egress', async () => {
  const store = new Store(':memory:'),
    service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async () => {
        throw Error('Example attempted provider egress');
      }),
    );
  try {
    assert.equal(examples.x_report_previews.length, 1);
    for (const example of examples.x_report_previews) {
      const out = await service.call(example.gateway, {...example.arguments, dry_run: true}, actor);
      assert.equal(out.success, true, JSON.stringify(out));
      assert.equal(out.data.executed, false);
      assert.equal(out.data.request.readOnly, true);
      assert.equal(out.data.request.reportDownload.limit, 100);
      assert.deepEqual(out.data.request.query, {job_ids: '1120829647711653888'});
    }
  } finally {
    store.close();
  }
});
test('draft-generation examples compile without credentials and never save or publish content', async () => {
  const store = new Store(':memory:'),
    service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async () => {
        throw Error('Example attempted provider egress');
      }),
    );
  try {
    assert.equal(examples.native_read_previews.length, 3);
    for (const example of examples.native_read_previews) {
      const out = await service.call(example.gateway, {...example.arguments, dry_run: true}, actor);
      assert.equal(out.success, true, JSON.stringify(out));
      assert.equal(out.data.executed, false);
      assert.equal(out.data.request.readOnly, true);
      assert.match(out.data.request.warnings.join(' '), /does not save assets/);
    }
  } finally {
    store.close();
  }
});
test('DV360 targeting-search examples compile as reads without credentials or targeting changes', async () => {
  const store = new Store(':memory:'),
    service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async () => {
        throw Error('Example attempted provider egress');
      }),
    );
  try {
    assert.equal(examples.targeting_search_previews.length, 3);
    for (const example of examples.targeting_search_previews) {
      const out = await service.call(example.gateway, {...example.arguments, dry_run: true}, actor);
      assert.equal(out.success, true, JSON.stringify(out));
      assert.equal(out.data.executed, false);
      assert.equal(out.data.request.readOnly, true);
      assert.match(out.data.request.warnings.join(' '), /discovery/);
    }
  } finally {
    store.close();
  }
});
test('every guided write family has a machine-checked inspect example without credentials or egress', async () => {
  const store = new Store(':memory:'),
    service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async () => {
        throw Error('Example attempted provider egress');
      }),
      undefined,
      {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
    );
  try {
    assert.deepEqual(new Set(examples.inspections.map(x => x.gateway)), writeContractGateways);
    for (const example of examples.inspections) {
      const out = await service.call('amcp_write', {action: 'inspect', ...example}, actor);
      assert.equal(out.success, true, example.gateway + ': ' + JSON.stringify(out));
      assert.equal(out.data.review_contract_supported, true, example.gateway + ': ' + JSON.stringify(out));
      assert.equal(out.data.network_requests, 0);
    }
    assert.equal(store.listConnections(actor.tenantId).length, 0);
  } finally {
    store.close();
  }
});

test('guide examples cover every declared reviewed route family, not only every gateway', async () => {
  const registry = new Registry(),
    store = new Store(':memory:'),
    service = new MirrorService(
      registry,
      store,
      new NativeTransport(async () => {
        throw Error('No network');
      }),
    );
  try {
    const found = new Set();
    for (const example of examples.inspections) {
      const r = await service.call('amcp_write', {action: 'inspect', ...example}, actor);
      assert.equal(r.data.review_contract_supported, true, JSON.stringify(r));
      found.add(reviewedWriteFamily(r.data.request));
    }
    assert.deepEqual(
      [...found].sort(),
      [
        ...new Set(
          actionContracts(registry)
            .map(a => a.family)
            .filter(Boolean),
        ),
      ].sort(),
    );
  } finally {
    store.close();
  }
});
test('all recipes validate their contracts, including the maximum 30 Google targeting criteria', async () => {
  const store = new Store(':memory:', key),
    service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async () => {
        throw Error('Unexpected provider call');
      }),
      undefined,
      {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
    );
  try {
    for (const recipe of campaignRecipes) {
      const gateway =
        {
          meta: 'meta',
          google: 'google_ads',
          microsoft: 'microsoft_ads',
          snapchat: 'snapchat',
          tiktok: 'tiktok',
          linkedin: 'linkedin',
        }[recipe.platform] + '_native_action';
      const login =
        recipe.platform === 'snapchat'
          ? examples.snapchat_traffic_business.connection_id
          : recipe.platform === 'tiktok'
            ? examples.tiktok_traffic_business.connection_id
            : recipe.platform === 'linkedin'
              ? examples.linkedin_lead_business.connection_id
              : 'synthetic-login';
      store.putConnection(
        actor,
        {
          id: login,
          tenantId: actor.tenantId,
          gateway,
          accounts: ['123'],
          writeAccounts: ['123'],
          enabled: true,
          label: 'Synthetic',
          scopes: [],
        },
        {accessToken: 'synthetic'},
      );
      // CMP-07: a TikTok pack's preflight reads the advertiser, the Spark identity and post, and the pixel.
      const tiktok = p =>
        p.path === '/v1.3/advertiser/info/'
          ? {code: 0, data: {list: [{advertiser_id: '123', currency: 'USD', timezone: 'Etc/GMT'}]}}
          : p.path === '/v1.3/identity/info/'
            ? {
                code: 0,
                data: {
                  identity_info: {
                    identity_id: p.query.identity_id,
                    identity_type: p.query.identity_type,
                    available_status: 'AVAILABLE',
                    can_pull_video: true,
                    is_gpppa: false,
                  },
                },
              }
            : p.path === '/v1.3/identity/video/info/'
              ? {code: 0, data: {video_details: [{item_id: '7300000000000000001', item_type: 'VIDEO'}]}}
              : // R2.5 M4 (r25-m4-smartweb): a Smart+ pack's preflight also reads its dynamic CTA portfolio.
                p.path === '/v1.3/creative/portfolio/get/'
                ? {code: 0, data: {portfolio_content: [{asset_ids: ['201781'], asset_content: 'learn_more'}]}}
                : {code: 0, data: {pixels: [{pixel_id: '456', asset_ownership: {asset_relation_status: 'OWNER'}}]}};
      // CMP-07: the LinkedIn lead pack's preflight reads the ad account and its lead forms (owner finder).
      const linkedin = p =>
        p.path === '/rest/leadForms'
          ? {
              elements: [{id: 4242, owner: {sponsoredAccount: 'urn:li:sponsoredAccount:123'}, state: 'PUBLISHED'}],
              paging: {start: 0, count: 100, total: 1},
            }
          : {id: 123, currency: 'USD', status: 'ACTIVE', type: 'BUSINESS'};
      service.runPlan = async p => ({
        data:
          p.gateway === 'tiktok_native_action'
            ? tiktok(p)
            : p.gateway === 'linkedin_native_action'
              ? linkedin(p)
              : p.gateway === 'snapchat_native_action'
                ? p.path.includes('/lead_generation_forms')
                  ? {
                      lead_generation_forms: [
                        {
                          lead_generation_form: {
                            id: 'form1',
                            ad_account_id: '123',
                            title: 'Synthetic form',
                            form_fields: [{type: 'EMAIL'}],
                          },
                        },
                      ],
                    }
                  : p.path.includes('/creatives')
                    ? {
                        creatives: [
                          {
                            creative: {
                              id: '33333333-3333-4333-8333-333333333333',
                              ad_account_id: '123',
                              type: recipe.id === 'snapchat_lead_generation' ? 'LEAD_GENERATION' : 'WEB_VIEW',
                              ...(recipe.id === 'snapchat_lead_generation' ? {lead_generation_form_id: 'form1'} : {}),
                              web_view_properties: {url: 'https://example.com/synthetic-snapchat'},
                            },
                          },
                        ],
                      }
                    : {adaccounts: [{adaccount: {id: '123', currency: 'USD'}}]}
                : p.path.endsWith('/promote_pages') || p.path.endsWith('/adspixels')
                  ? {data: [{id: '456'}]}
                  : p.gateway === 'google_ads_native_action'
                    ? {results: [{customer: {id: '123', currencyCode: 'USD'}}]}
                    : p.gateway === 'microsoft_ads_native_action'
                      ? {Account: {Id: 123, CurrencyCode: 'USD'}}
                      : {id: 'act_123', account_id: '123', currency: 'USD'},
      });
      const b = {
        ...examples.recipe_business,
        connection_id: login,
        ...(recipe.platform === 'snapchat'
          ? recipe.id === 'snapchat_lead_generation'
            ? examples.snapchat_lead_business
            : examples.snapchat_traffic_business
          : {}),
        ...(recipe.id === 'tiktok_website_traffic' ? examples.tiktok_traffic_business : {}),
        ...(recipe.id === 'tiktok_website_conversions' ? examples.tiktok_conversion_business : {}),
        // R2.5 M4 (r25-m4-smartweb): the Smart+ packs are compiled and preflighted from their own checked examples, with the request_id
        // placeholder their compile leaves (preflight gives it a probe, which it never sends).
        ...(recipe.id === 'tiktok_smart_plus_website_traffic' ? examples.tiktok_smart_plus_traffic_business : {}),
        ...(recipe.id === 'tiktok_smart_plus_website_conversions'
          ? examples.tiktok_smart_plus_conversion_business
          : {}),
        ...(recipe.id === 'linkedin_lead_generation' ? examples.linkedin_lead_business : {}),
        ...(recipe.id === 'google_performance_max' ? {...examples.google_pmax_business, cpc_bid: undefined} : {}),
        ...(recipe.id === 'meta_website_sales' || recipe.id === 'meta_website_leads'
          ? {pixel_id: '456', click_attribution_days: 7, view_attribution_days: 1}
          : {}),
        ...(recipe.id === 'google_search_clicks' ? {cpc_bid: undefined, cpc_bid_ceiling: '1.37'} : {}),
        ...([
          'google_search_conversions',
          'google_search_target_cpa',
          'google_search_conversion_value',
          'google_search_target_roas',
        ].includes(recipe.id)
          ? {
              cpc_bid: undefined,
              conversion_goal_policy: 'ACCOUNT_DEFAULT',
              ...(recipe.id === 'google_search_target_cpa' ? {target_cpa: '15.250001'} : {}),
              ...(['google_search_conversion_value', 'google_search_target_roas'].includes(recipe.id)
                ? {conversion_value_policy: 'ACCOUNT_RECORDED_VALUES'}
                : {}),
              ...(recipe.id === 'google_search_target_roas' ? {target_roas: '3.5'} : {}),
            }
          : {}),
        ...(recipe.platform === 'google'
          ? {
              country_criterion_ids: Array.from({length: 20}, (_, i) => String(2800 + i)),
              language_criterion_ids: Array.from({length: 10}, (_, i) => String(1000 + i)),
            }
          : {}),
      };
      const plan = campaignRecipe(recipe.id, b),
        steps = plan.steps.filter(s => s.kind !== 'media');
      if (recipe.platform === 'meta')
        steps.find(s => s.id === 'creative').arguments.payload.object_story_spec.link_data.image_hash =
          'synthetic-hash';
      // R2.5 M4 (r25-m4-smartweb, S4-1): a compiled recipe's step may leave a field a provider derives from the plan's ID at a placeholder no
      // request can carry (TikTok's request_id of a Smart+ create). The eligibility check gives such a step a probe before it preflights it, and so
      // does this test; the preflight itself binds nothing, so a saved plan's placeholder is blocked there.
      const preflight = await campaignPreflight(
        service,
        actor,
        steps.map(s => bindRecipeStep(s, recipeProbePlanId)),
      );
      assert.equal(preflight.status, 'ready', JSON.stringify(preflight));
      if (recipe.platform === 'google') {
        // The default all-or-nothing build carries all 30 criteria in its one request (CMP-04).
        assert.deepEqual(
          steps.map(s => s.id),
          ['build'],
        );
        assert.equal(
          steps[0].arguments.payload.mutate_operations.filter(o => o.campaign_criterion_operation).length,
          30,
        );
        // One step per resource type keeps the reviewed contract's 25-operation limit per request. The Performance Max
        // pack (CMP-07) is always one build: Google requires its asset group and assets in the same request.
        if (recipe.id === 'google_performance_max') continue;
        const split = campaignRecipe(recipe.id, {...b, atomic: false}).steps;
        assert.equal((await campaignPreflight(service, actor, split)).status, 'ready');
        const chunks = split.filter(s => s.id.startsWith('targeting'));
        assert.equal(chunks.length, 2);
        assert.deepEqual(
          chunks.map(s => s.arguments.payload.operations.length),
          [25, 5],
        );
        assert.equal(chunks.flatMap(s => s.arguments.payload.operations).length, 30);
      }
    }
  } finally {
    store.close();
  }
});
test('provider descriptors account for every offered platform and match executable family sets', () => {
  assert.equal(new Set(providerContracts.map(p => p.id)).size, providerContracts.length);
  for (const p of platforms) assert.equal(providerContracts.find(c => c.id === p.id)?.gateway, p.gateway);
  assert.deepEqual(
    new Set(providerContracts.filter(p => p.overview_reporting === 'implemented_unverified').map(p => p.id)),
    new Set(Object.keys(reportPlatforms)),
  );
  assert.deepEqual(
    new Set(providerContracts.filter(p => p.media_import === 'implemented_unverified').map(p => p.media_platform)),
    new Set(mediaPlatforms),
  );
  for (const p of providerContracts) {
    assert.equal(p.live_qualification, 'unverified');
    for (const file of p.tests) assert.ok(fs.existsSync(file), file);
  }
});
