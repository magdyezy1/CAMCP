import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

export function extractGoogleFields(bytes, checkedAt, resource) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkedAt)) throw Error('Supply the actual retrieval date as YYYY-MM-DD.');
  if (!/^[a-z][a-z0-9_]*$/.test(resource)) throw Error('Supply one Google Ads GAQL resource name.');
  const fields = {};
  for (const m of bytes
    .toString('utf8')
    .matchAll(new RegExp('<h2\\b[^>]*id="' + resource + '\\.([a-z0-9_.]+)"[^>]*>[\\s\\S]*?<\\/table>', 'g'))) {
    const selectable = m[0].match(/<td>Selectable<\/td>\s*<td>(True|False)<\/td>/),
      repeated = m[0].match(/<td>Repeated<\/td>\s*<td>(True|False)<\/td>/);
    if (!selectable || !repeated || Object.hasOwn(fields, m[1]))
      throw Error('Unrecognized or duplicated official field table: ' + m[1]);
    fields[m[1]] = {selectable: selectable[1] === 'True', repeated: repeated[1] === 'True'};
  }
  if (!Object.keys(fields).length) throw Error('No Google Ads ' + resource + ' field tables found.');
  return {
    source: 'https://developers.google.com/google-ads/api/fields/v23/' + resource,
    checked_at: checkedAt,
    method: 'Public documentation field-heading/table extraction; not a live account query',
    source_sha256: createHash('sha256').update(bytes).digest('hex'),
    fields,
  };
}
export const extractAssetFields = (bytes, checkedAt) => extractGoogleFields(bytes, checkedAt, 'asset');
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [html, date] = process.argv.slice(2);
  if (!html || !date)
    throw Error('Usage: node tools/google-asset-field-evidence.mjs <saved-public-HTML> <retrieval-date> [--check]');
  const evidence = extractAssetFields(fs.readFileSync(html), date),
    target = 'tests/fixtures/google-asset-fields-v23.json';
  if (process.argv.includes('--check')) {
    if (JSON.stringify(JSON.parse(fs.readFileSync(target, 'utf8'))) !== JSON.stringify(evidence))
      throw Error('Asset field evidence differs from the supplied official HTML.');
  } else fs.writeFileSync(target, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({fields: Object.keys(evidence.fields).length, source_sha256: evidence.source_sha256}));
}
