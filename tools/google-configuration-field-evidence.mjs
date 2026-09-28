import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {extractGoogleFields} from './google-asset-field-evidence.mjs';

// Public documentation only. Runtime review queries never use caller-supplied fields.
const resources = [
  'label',
  'campaign_label',
  'ad_group_label',
  'ad_group_ad_label',
  'ad_group_criterion_label',
  'customizer_attribute',
  'campaign_customizer',
  'ad_group_customizer',
  'ad_group_criterion_customizer',
  'customer_customizer',
  'ad_parameter',
  'campaign_group',
  'conversion_custom_variable',
  'remarketing_action',
  'asset_group_signal',
  'customer_negative_criterion',
  'asset_set',
  'asset_set_asset',
  'campaign_asset_set',
  'ad_group_asset_set',
  'customer_asset_set',
  'keyword_plan',
  'keyword_plan_campaign',
  'keyword_plan_ad_group',
  'keyword_plan_ad_group_keyword',
  'keyword_plan_campaign_keyword',
];
const [directory, date] = process.argv.slice(2);
if (!directory || !date)
  throw Error(
    'Usage: node tools/google-configuration-field-evidence.mjs <public-html-directory> <retrieval-date> [--check]',
  );
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Error('Supply the retrieval date as YYYY-MM-DD.');
const entries = Object.fromEntries(
  resources.map(resource => {
    if (fs.existsSync(directory + '/' + resource + '.html'))
      return [resource, extractGoogleFields(fs.readFileSync(directory + '/' + resource + '.html'), date, resource)];
    const files = [directory + '/' + resource + '.txt', directory + '/' + resource + '-additional.txt'].filter(file =>
      fs.existsSync(file),
    );
    if (!files.length) throw Error('Missing public reference text: ' + resource);
    const raw = files.map(file => fs.readFileSync(file, 'utf8')).join('\n'),
      plain = raw.replaceAll('\r\n', '\n').replace(/^L\d+: ?/gm, ''),
      fields = {};
    for (const m of plain.matchAll(
      new RegExp('(?:^|\\n)## ' + resource + '\\.([a-z0-9_.]+)\\n([\\s\\S]*?)(?=\\n## |\\n\\[Button|\\nExcept|$)', 'g'),
    )) {
      const selectable = m[2].match(/Selectable (True|False)/),
        repeated = m[2].match(/Repeated (True|False)/);
      if (!selectable || !repeated) throw Error('Incomplete public field table: ' + resource + '.' + m[1]);
      const row = {selectable: selectable[1] === 'True', repeated: repeated[1] === 'True'};
      if (fields[m[1]] && JSON.stringify(fields[m[1]]) !== JSON.stringify(row))
        throw Error('Conflicting public field table: ' + resource + '.' + m[1]);
      fields[m[1]] = row;
    }
    if (!Object.keys(fields).length) throw Error('No field tables: ' + resource);
    return [
      resource,
      {
        source: 'https://developers.google.com/google-ads/api/fields/v23/' + resource,
        checked_at: date,
        method:
          'Public reference field-heading/table text extraction through web tool; original HTML fetch unavailable; not a live account query',
        source_text_sha256: createHash('sha256').update(raw).digest('hex'),
        fields,
      },
    ];
  }),
);
const text = JSON.stringify({api_version: 'v23', resources: entries}, null, 2) + '\n',
  output = 'tests/fixtures/google-configuration-fields-v23.json';
if (process.argv.includes('--check')) {
  if (fs.readFileSync(output, 'utf8') !== text) throw Error('Configuration field evidence is stale.');
} else fs.writeFileSync(output, text);
console.log(
  JSON.stringify({
    resources: resources.length,
    fields: Object.values(entries).reduce((n, e) => n + Object.keys(e.fields).length, 0),
  }),
);
