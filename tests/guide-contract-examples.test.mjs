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
import {campaignRecipe, campaignRecipes} from '../dist/src/campaign-recipes.js';
import {campaignPreflight} from '../dist/src/campaign-preflight.js';
import {providerContracts} from '../dist/src/provider-contracts.js';
import {platforms} from '../dist/server/platform-oauth.js';
import {reportPlatforms} from '../dist/src/report-metrics.js';
import {mediaPlatforms} from '../dist/src/media-routing.js';
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
        {meta: 'meta', google: 'google_ads', microsoft: 'microsoft_ads'}[recipe.platform] + '_native_action';
      store.putConnection(
        actor,
        {
          id: 'synthetic-login',
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
      service.runPlan = async p => ({
        data:
          p.path.endsWith('/promote_pages') || p.path.endsWith('/adspixels')
            ? {data: [{id: '456'}]}
            : {
                currency: 'USD',
                Account: {CurrencyCode: 'USD'},
                results: [{customer: {id: '123', currencyCode: 'USD'}}],
              },
      });
      const b = {
        ...examples.recipe_business,
        ...(recipe.id === 'meta_website_sales' || recipe.id === 'meta_website_leads'
          ? {pixel_id: '456', click_attribution_days: 7, view_attribution_days: 1}
          : {}),
        ...(recipe.id === 'google_search'
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
      const preflight = await campaignPreflight(service, actor, steps);
      assert.equal(preflight.status, 'ready', JSON.stringify(preflight));
      if (recipe.platform === 'google') {
        const chunks = steps.filter(s => s.id.startsWith('targeting'));
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
