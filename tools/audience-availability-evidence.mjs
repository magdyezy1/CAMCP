import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const directory = process.argv[process.argv.indexOf('--source-dir') + 1];
if (!process.argv.includes('--source-dir') || !directory)
  throw Error(
    'Supply a directory containing the four public source files, fetched from the URLs below. This generator never reads credentials.',
  );
const urls = {
    'x-campaign-reference.md': 'https://docs.x.com/x-ads-api/campaign-management/reference.md',
    'x-campaign-overview.md': 'https://docs.x.com/x-ads-api/campaign-management.md',
    'x-audiences-reference.md': 'https://docs.x.com/x-ads-api/audiences/reference.md',
    'customizer-attribute-service.proto':
      'https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v23/services/customizer_attribute_service.proto',
  },
  sources = {},
  texts = {};
for (const [name, url] of Object.entries(urls)) {
  const bytes = fs.readFileSync(path.join(directory, name));
  sources[name] = {url, sha256: createHash('sha256').update(bytes).digest('hex')};
  texts[name] = bytes.toString('utf8');
}
function section(text, start, end) {
  const at = text.indexOf(start);
  if (at < 0) throw Error('Missing source section ' + start);
  const finish = text.indexOf(end, at + start.length);
  if (finish < 0) throw Error('Missing section terminator ' + end);
  return text.slice(at, finish);
}
const doc = texts['x-campaign-reference.md'],
  estimate = section(doc, '### Audience Estimate', '### Authenticated User Access');
if (
  !estimate.includes('Content-Type: application/json') ||
  !estimate.includes('/12/accounts/:account_id/audience_estimate') ||
  !estimate.includes('primary')
)
  throw Error('Audience estimate semantics changed.');
const examples = [...estimate.matchAll(/```json[^\n]*\n([\s\S]*?)```/g)].map(m => JSON.parse(m[1]));
if (
  examples.length !== 2 ||
  examples[0].targeting_criteria.length !== 5 ||
  !Number.isSafeInteger(examples[1].data.audience_size.min)
)
  throw Error('Native request/response examples changed.');
const targeting = section(doc, '#### POST accounts/:account\\_id/targeting\\_criteria[', '#### POST batch/accounts/'),
  typeBlock = section(targeting, '<ParamField query="targeting_type"', '</ParamField>');
const criterionTypes = [...new Set([...typeBlock.matchAll(/`([A-Z][A-Z_]+)`/g)].map(m => m[1]))].sort();
if (criterionTypes.length !== 31 || !criterionTypes.includes('APP_LIST'))
  throw Error('Native targeting type vocabulary changed.');
const overview = texts['x-campaign-overview.md'];
for (const group of ['Followers', 'Tailored Audiences', 'Interests', 'Keywords', 'TV'])
  if (!overview.includes(group)) throw Error('Primary-targeting evidence missing.');
const audience = section(
  texts['x-audiences-reference.md'],
  '#### GET accounts/:account\\_id/custom\\_audiences/:custom\\_audience\\_id[]',
  '#### POST accounts/:account\\_id/custom\\_audiences[]',
);
if (
  !audience.includes('"targetable": false') ||
  !audience.includes('"owner_account_id"') ||
  !audience.includes('"deleted": false')
)
  throw Error('Custom-audience response evidence changed.');
const proto = texts['customizer-attribute-service.proto'].replace(/\/\/[^\n]*/g, ''),
  operation = section(proto, 'message CustomizerAttributeOperation {', 'message MutateCustomizerAttributesResponse');
const verbs = [...operation.matchAll(/\b(create|update|remove)\s*=\s*\d+/g)].map(m => m[1]);
if (JSON.stringify(verbs) !== '["create","remove"]')
  throw Error('Native customizer operation union changed; review availability.');
const output = {
  checked_at: '2026-09-25',
  meaning: 'Public source evidence and documented examples; not live account or provider-approval evidence.',
  sources,
  x: {
    api_version: '12',
    route: '/12/accounts/{account_id}/audience_estimate',
    method: 'POST',
    content_type: 'application/json',
    criterion_types: criterionTypes,
    primary_groups: ['Followers', 'Tailored Audiences', 'Interests', 'Keywords', 'TV'],
    request_example: examples[0],
    response_example: examples[1],
    amcp_unqualified_types: ['APP_LIST'],
    amcp_limits: {criteria: 200, private_references: 25, bytes: 131072, response_bytes: 2097152, deadline_ms: 60000},
  },
  google: {
    api_version: 'v23',
    operation_message: 'CustomizerAttributeOperation',
    supported_verbs: verbs,
    unsupported_legacy_alias: 'UPDATE_CUSTOMIZER_ATTRIBUTE',
  },
};
const file = 'tests/fixtures/audience-availability-evidence.json',
  data = JSON.stringify(output, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (fs.readFileSync(file, 'utf8') !== data) throw Error('Evidence fixture changed.');
} else fs.writeFileSync(file, data);
console.log(
  'Verified four public source hashes, documented X JSON examples and criterion vocabulary, and Google operation union.',
);
