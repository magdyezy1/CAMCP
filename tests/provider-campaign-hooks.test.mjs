import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {MirrorError} from '../dist/src/errors.js';
import {providerHooks, registeredProviderHooks} from '../dist/src/provider-hooks.js';
import {isProviderModule, providerRegistries} from '../tools/architecture-map.mjs';
import {assertCloneGateway, clonePlan} from '../dist/src/campaign-clone.js';
import {snapchatClone} from '../dist/src/snapchat-campaign-clone.js';
import {googleClone} from '../dist/src/google-campaign-clone.js';
import {tiktokClone} from '../dist/src/tiktok-campaign-clone.js';
import {linkedinClone} from '../dist/src/linkedin-campaign-clone.js';
import {composeGoogleBuild} from '../dist/src/google-atomic-builds.js';

// ARC-01 phase B (wave 4c), the campaign modules: src/campaign-clone.ts named Snapchat, Google Ads, TikTok and LinkedIn
// where it read and rebuilt each one's campaign, and src/campaign-runner.ts named Google Ads where a clone becomes one
// all-or-nothing build. Each provider's part is now its adapter's `campaign` hooks; the stages keep every check and
// its order, and ask the provider where they named it. The call-replay proof of each move is in
// docs/review/ARCHITECTURE.md (section 9).

const gatewayLiterals = source => [...source.matchAll(/['"]([a-z0-9_]+_native_action)['"]/g)].map(m => m[1]);
const providerImports = source =>
  [...source.matchAll(/from '\.\/([^']+)\.js'/g)]
    .map(m => 'src/' + m[1] + '.ts')
    .filter(f => isProviderModule(f) && !providerRegistries.includes(f));
const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const refusal = async (run, code) => {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof MirrorError)) throw error;
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail('expected ' + code + ', but the check accepted the request');
};

test('the campaign clone names no provider and imports no provider module', () => {
  const source = read('src/campaign-clone.ts');
  assert.deepEqual(gatewayLiterals(source), []);
  assert.deepEqual(providerImports(source), []);
  // The runner asks the provider for a clone's all-or-nothing build instead of naming Google Ads.
  assert.doesNotMatch(read('src/campaign-runner.ts'), /composeGoogleBuild|google-atomic-builds/);
});

test('exactly Snapchat, Google Ads, TikTok and LinkedIn declare a clone, each its own module function', () => {
  const declared = Object.fromEntries(
    registeredProviderHooks.filter(h => h.campaign?.clone).map(h => [h.gateway, h.campaign.clone]),
  );
  assert.deepEqual(Object.keys(declared).sort(), [
    'google_ads_native_action',
    'linkedin_native_action',
    'snapchat_native_action',
    'tiktok_native_action',
  ]);
  assert.equal(declared.snapchat_native_action.build, snapchatClone);
  assert.equal(declared.google_ads_native_action.build, googleClone);
  assert.equal(declared.tiktok_native_action.build, tiktokClone);
  assert.equal(declared.linkedin_native_action.build, linkedinClone);
  for (const clone of Object.values(declared)) assert.ok(Object.isFrozen(clone));
  // Only Google's clone is one all-or-nothing build, of the customer without its display dashes.
  assert.deepEqual(
    Object.entries(declared)
      .filter(([, clone]) => clone.allOrNothing)
      .map(([gateway]) => gateway),
    ['google_ads_native_action'],
  );
  const steps = [
    {
      id: 'budget',
      kind: 'write',
      gateway: 'google_ads_native_action',
      arguments: {
        action: 'google_ads_v23_campaign_budget_mutate_campaign_budgets',
        payload: {operations: [{create: {name: 'B', amount_micros: '1000000'}}]},
      },
      depends_on: [],
    },
  ];
  assert.deepEqual(
    declared.google_ads_native_action.allOrNothing(structuredClone(steps), '123-456-7890'),
    composeGoogleBuild(structuredClone(steps), '1234567890'),
  );
});

test('a gateway without a clone is refused before any read, naming the clone gateways in their order', async () => {
  const supported = [
    'snapchat_native_action',
    'google_ads_native_action',
    'tiktok_native_action',
    'linkedin_native_action',
  ];
  for (const gateway of ['meta_native_action', 'x_ads_native_action', 'amcp_campaign', '__proto__', undefined]) {
    const error = await refusal(() => assertCloneGateway(gateway), 'CLONE_UNSUPPORTED');
    assert.deepEqual(error.details, {field: 'gateway', supported});
    let reads = 0;
    const call = async () => {
      reads++;
      return {success: true, data: {data: {}}};
    };
    await refusal(
      () => clonePlan(call, {tenantId: 't', userId: 'u'}, {gateway, source: {campaign_id: '1'}, name: 'Copy'}),
      'CLONE_UNSUPPORTED',
    );
    assert.equal(reads, 0, String(gateway));
  }
  // The source and name checks come first, for every gateway.
  await refusal(
    () => clonePlan(async () => assert.fail('no read'), {}, {gateway: 'snapchat_native_action', name: 'Copy'}),
    'INVALID_ARGUMENT',
  );
  assert.equal(providerHooks('meta_native_action')?.campaign?.clone, undefined);
});

test('a clone reads its source through the provider and groups what it did not copy', async () => {
  const calls = [];
  const call = async (gateway, input) => {
    calls.push([gateway, input.action]);
    if (input.action === 'snapchat_campaign_list')
      return {
        success: true,
        data: {data: {campaigns: [{campaign: {id: 'c1', name: 'Old', status: 'ACTIVE', extra: 1}}]}},
      };
    return {success: true, data: {data: {adsquads: [], ads: []}}};
  };
  const out = await clonePlan(
    call,
    {tenantId: 't', userId: 'u'},
    {gateway: 'snapchat_native_action', connection_id: 'k', account_id: 'a', source: {campaign_id: 'c1'}, name: 'N'},
  );
  assert.deepEqual(calls, [
    ['snapchat_native_action', 'snapchat_campaign_list'],
    ['snapchat_native_action', 'snapchat_adsquad_list'],
    ['snapchat_native_action', 'snapchat_ad_list'],
  ]);
  assert.deepEqual(
    out.steps.map(s => [s.id, s.gateway, s.arguments.action]),
    [['campaign', 'snapchat_native_action', 'snapchat_campaign_create']],
  );
  assert.deepEqual(out.notCopied, [{fields: ['extra'], steps: ['campaign']}]);
  assert.deepEqual(out.source, {campaign_id: 'c1', ad_squads: 0, ads: 0});
});
