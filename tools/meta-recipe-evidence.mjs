// Extract the public Meta SDK types used by the guided website conversion recipes. No network or credentials.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {argumentDirectory, readSdk, sdkClass, metaSdkTag, metaVersion} from './meta-sdk.mjs';
export function recipeEvidence(directory) {
  const {sources, text} = readSdk(directory, ['adaccount', 'campaign', 'adset', 'adpromotedobject']);
  const account = sdkClass(text.adaccount),
    campaign = sdkClass(text.campaign),
    adset = sdkClass(text.adset),
    promoted = sdkClass(text.adpromotedobject);
  const create = name => {
    const c = account.calls.find(c => c.name === name);
    if (!c || c.method !== 'POST') throw Error('Missing SDK create method ' + name);
    return c;
  };
  return {
    api_version: metaVersion,
    sdk_tag: metaSdkTag,
    checked_at: '2026-10-01',
    meaning:
      'Official generated schema evidence; not eligible-account behavior, measurement delivery or live acceptance.',
    sources,
    campaign_create: create('create_campaign'),
    adset_create: create('create_ad_set'),
    insights_read: account.calls.find(c => c.name === 'get_insights' && c.method === 'GET'),
    objectives: campaign.enums.Objective,
    optimization_goals: adset.enums.OptimizationGoal,
    billing_events: adset.enums.BillingEvent,
    destinations: adset.enums.DestinationType,
    promoted_fields: promoted.fields,
    conversion_events: promoted.enums.CustomEventType,
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidence = recipeEvidence(
    argumentDirectory('--sdk-dir', 'the official SDK ' + metaSdkTag + ' adobjects files'),
  );
  const target = 'tests/fixtures/meta-website-recipe-sdk-v26.json',
    text = JSON.stringify(evidence, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (fs.readFileSync(target, 'utf8') !== text) throw Error('Meta recipe SDK evidence is stale.');
  } else fs.writeFileSync(target, text);
  console.log('Meta website recipe SDK evidence ' + (process.argv.includes('--check') ? 'checked.' : 'written.'));
}
