// Project the official public SDK fields and read edges used by the Meta portfolio. No network or credentials.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {argumentDirectory, readSdk, sdkClass, metaSdkTag, metaVersion} from './meta-sdk.mjs';
export function portfolioEvidence(directory) {
  const {sources, text} = readSdk(directory, ['adaccount', 'campaign', 'adset', 'ad']);
  const methods = {
    adaccount: ['api_get', 'get_campaigns'],
    campaign: ['api_get', 'get_ad_sets'],
    adset: ['api_get', 'get_ads'],
    ad: [],
  };
  return {
    api_version: metaVersion,
    sdk_tag: metaSdkTag,
    checked_at: '2026-10-01',
    sources,
    meaning:
      'Official generated read schema evidence; not live provider acceptance or point-in-time inventory reconciliation.',
    models: Object.fromEntries(
      Object.entries(text).map(([name, source]) => {
        const parsed = sdkClass(source);
        const calls = methods[name].map(method => {
          const call = parsed.calls.find(c => c.name === method && c.method === 'GET');
          if (!call) throw Error('Missing read ' + name + '.' + method);
          return call;
        });
        return [name, {fields: parsed.fields, calls}];
      }),
    ),
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = portfolioEvidence(argumentDirectory('--sdk-dir', 'Meta SDK ' + metaSdkTag + ' adobjects'));
  const target = 'tests/fixtures/meta-portfolio-sdk-v26.json',
    text = JSON.stringify(value, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (fs.readFileSync(target, 'utf8') !== text) throw Error('Meta portfolio SDK evidence changed.');
  } else fs.writeFileSync(target, text);
  console.log('Meta portfolio SDK evidence ' + (process.argv.includes('--check') ? 'checked.' : 'written.'));
}
