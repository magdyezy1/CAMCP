// Project the official public SDK model of the ad account activity read (GET /act_<id>/activities, the account's change history):
// its request, parameters and the fields and enums of its AdActivity rows. No network or credentials: the two files named below
// are public (raw.githubusercontent.com, the tag 26.0.2 of facebook/facebook-python-business-sdk), fetched once and given here.
//   node tools/meta-activities-evidence.mjs --source-dir <dir with adaccount.py and adactivity.py> [--check]
// The SDK states the request and the row, not permissions, retention or page limits; src/meta-activities.ts says which of them AMCP
// sends and returns, and tests/meta-activities.test.mjs holds it to this record.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {argumentDirectory, metaSdkTag, metaVersion, pin, readSdk, sdkClass} from './meta-sdk.mjs';

export const fixtureFile = 'tests/fixtures/meta-activities-sdk-' + metaVersion.replace('.0', '') + '.json';

export function activitiesEvidence(directory) {
  const {sources, text} = readSdk(directory, ['adaccount', 'adactivity']),
    account = sdkClass(text.adaccount),
    call = account.calls.find(c => c.name === 'get_activities' && c.method === 'GET'),
    model = sdkClass(text.adactivity);
  if (call?.edge !== '/activities') throw Error('Pinned SDK read changed: adaccount.get_activities');
  if (model.class !== 'AdActivity' || !model.fields.includes('event_time') || !model.enums.EventType?.length)
    throw Error('Pinned SDK model changed: AdActivity');
  return {
    api_version: metaVersion,
    sdk_tag: metaSdkTag,
    checked_at: '2026-11-27',
    meaning:
      'Official generated schema of the ad account activity read: its request, parameters and row fields. The SDK states no permission, retention period or page maximum; those are not evidence here.',
    sources,
    request: {name: account.class + '.' + call.name, method: call.method, edge: call.edge, params: call.params},
    // The AMCP action that rests on this request: tools/route-anchors.ts anchors its route to it, as to the catalog's SDK requests.
    catalog_requests: {meta_ad_account_id_activities_get: account.class + '.' + call.name},
    fields: model.fields,
    enums: model.enums,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidence = activitiesEvidence(argumentDirectory('--source-dir', 'the two public SDK files'));
  pin(fixtureFile, evidence, 'Meta activities SDK evidence');
  console.log(
    'Meta activities SDK evidence ' +
      (process.argv.includes('--check') ? 'checked' : 'written') +
      ': ' +
      Object.keys(evidence.request.params).length +
      ' parameters, ' +
      evidence.fields.length +
      ' fields, ' +
      evidence.enums.EventType.length +
      ' event types, ' +
      Object.keys(evidence.sources).length +
      ' pinned source hashes.',
  );
}
