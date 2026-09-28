import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const directory = process.argv[process.argv.indexOf('--source-dir') + 1];
if (!process.argv.includes('--source-dir') || !directory)
  throw Error('Supply --source-dir containing the public v23 shareable_preview_service.proto.');
const bytes = fs.readFileSync(path.join(directory, 'shareable_preview_service.proto')),
  source = bytes.toString('utf8');
function message(name) {
  const start = source.indexOf('message ' + name + ' {');
  if (start < 0) throw Error('Message disappeared: ' + name);
  const begin = source.indexOf('{', start);
  let depth = 1,
    end = begin;
  while (depth && ++end < source.length) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  if (depth) throw Error('Unclosed message');
  return source.slice(begin + 1, end);
}
const fields = {},
  oneofs = {};
for (const name of [
  'GenerateShareablePreviewsRequest',
  'ShareablePreview',
  'AssetGroupIdentifier',
  'GenerateShareablePreviewsResponse',
  'ShareablePreviewOrError',
  'ShareablePreviewResult',
  'YouTubeLivePreviewResult',
]) {
  const text = message(name);
  fields[name] = [...text.matchAll(/^\s+(?:(?:optional|repeated)\s+)?[\w.]+\s+([a-z_]+)\s*=\s*\d+/gm)]
    .map(m => m[1])
    .sort();
  oneofs[name] = [...text.matchAll(/oneof\s+([a-z_]+)/g)].map(m => m[1]).sort();
}
const route = '/v23/customers/{customer_id=*}:generateShareablePreviews',
  scope = 'https://www.googleapis.com/auth/adwords';
if (!source.includes('post: "' + route + '"') || !source.includes('option (google.api.oauth_scopes) = "' + scope + '"'))
  throw Error('Preview route/scope changed.');
const fixture = {
  version: 'v23',
  checked_at: '2026-09-24',
  meaning: 'Public native protocol evidence, not live format eligibility or permission.',
  source: {
    url: 'https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v23/services/shareable_preview_service.proto',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  },
  route,
  scope,
  fields,
  oneofs,
};
const output = 'tests/fixtures/google-preview-v23.json',
  text = JSON.stringify(fixture, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (fs.readFileSync(output, 'utf8') !== text)
    throw Error('Preview evidence differs from pinned fixture. Review upstream changes.');
} else fs.writeFileSync(output, text);
console.log('Verified Google v23 preview route, scope, seven message field sets, oneofs and public source hash.');
