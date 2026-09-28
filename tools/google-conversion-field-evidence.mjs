import fs from 'node:fs';
import {createHash} from 'node:crypto';
// The conversion_action GAQL field table, from public reference text (the v23 field reference); never an account query.
const [file, date] = process.argv.slice(2);
if (!file || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? ''))
  throw Error('Usage: node tools/google-conversion-field-evidence.mjs <public-reference-text> <YYYY-MM-DD> [--check]');
const bytes = fs.readFileSync(file),
  text = bytes.toString('utf8').replace(/^L\d+: /gm, ''),
  fields = {};
for (const m of text.matchAll(/## conversion_action\.([a-z_.]+)\n([\s\S]*?)(?=\n## |\n-{5}|$)/g)) {
  const s = /Selectable (True|False)/.exec(m[2]),
    r = /Repeated (True|False)/.exec(m[2]);
  if (s && r) fields[m[1]] = {selectable: s[1] === 'True', repeated: r[1] === 'True'};
}
if (!fields.id?.selectable || !fields.phone_call_duration_seconds?.selectable || !fields.app_id?.selectable)
  throw Error('Missing official field-table evidence. Supply the public v23 conversion_action field reference text.');
const output = 'tests/fixtures/google-conversion-fields-v23.json',
  pinned =
    JSON.stringify(
      {
        api_version: 'v23',
        source: 'https://developers.google.com/google-ads/api/fields/v23/conversion_action',
        checked_at: date,
        method:
          'Offline field-heading/table extraction from public web-tool reference excerpts; not a live account query.',
        source_text_sha256: createHash('sha256').update(bytes).digest('hex'),
        fields,
      },
      null,
      2,
    ) + '\n';
if (process.argv.includes('--check')) {
  if (fs.readFileSync(output, 'utf8') !== pinned) throw Error('Conversion field evidence changed.');
} else fs.writeFileSync(output, pinned);
console.log(JSON.stringify({fields: Object.keys(fields).length}));
