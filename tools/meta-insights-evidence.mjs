import {argumentDirectory, dictionary, metaSdkTag, metaVersion, pin, readSdk, sdkMethod} from './meta-sdk.mjs';

// Read only downloaded PUBLIC SDK sources. Runtime credentials are never used.
// Usage: node tools/meta-insights-evidence.mjs --source-dir <download-dir> [--check]
const {sources, text} = readSdk(argumentDirectory('--source-dir', 'the pinned public SDK files'), [
  'adreportrun',
  'adsinsights',
  'adaccount',
  'campaign',
  'adset',
]);
const models = Object.fromEntries(['adreportrun', 'adsinsights'].map(n => [n, dictionary(text[n], '_field_types')]));
const creation = {};
for (const name of ['adaccount', 'campaign', 'adset']) {
  const method = sdkMethod(text[name], 'get_insights_async');
  if (
    !method ||
    !method.includes("method='POST'") ||
    !method.includes("endpoint='/insights'") ||
    !method.includes('target_class=AdReportRun')
  )
    throw Error('Changed asynchronous SDK route: ' + name);
  creation[name] = {
    method: 'POST',
    edge: '/insights',
    result: 'AdReportRun',
    parameters: dictionary(method, 'param_types'),
  };
}
if (
  !text.adreportrun.includes("method='GET'") ||
  !text.adreportrun.includes("endpoint='/insights'") ||
  !text.adreportrun.includes('target_class=AdsInsights')
)
  throw Error('Changed result route.');
pin(
  'tests/fixtures/meta-insights-sdk-' + metaVersion.replace('.0', '') + '.json',
  {
    api_version: metaVersion,
    sdk_tag: metaSdkTag,
    checked_at: '2026-09-28',
    method:
      'Deterministic extraction from the pinned official public Python SDK; schema evidence, not live provider acceptance.',
    sources,
    creation,
    models,
  },
  'Meta Insights SDK evidence',
);
console.log('Verified 3 async creation edges, 2 response models and 5 pinned public SDK source hashes.');
