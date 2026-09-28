import {fieldNames, googleVersion, message, pin, readProtos} from './google-protos.mjs';
// The GAQL field table of conversion_action is separate evidence: tools/google-conversion-field-evidence.mjs.
const names = [
    'resources/conversion_action',
    'services/conversion_action_service',
    'enums/conversion_action_type',
    'enums/conversion_action_category',
    'enums/conversion_action_status',
    'enums/conversion_action_counting_type',
    'enums/attribution_model',
    'errors/conversion_action_error',
  ],
  {sources, content} = readProtos(names, 'conversion-action protos');
const fields = {};
for (const name of ['ConversionAction', 'ValueSettings', 'AttributionModelSettings'])
  fields[name] = fieldNames(message(content['resources/conversion_action'], name));
const enums = {};
for (const name of names.filter(n => n.startsWith('enums/') || n.startsWith('errors/'))) {
  enums[name.split('/')[1]] = Object.fromEntries(
    [...content[name].matchAll(/^\s+([A-Z_]+) = (\d+)(?:\s*\[[^\]]+\])?;/gm)].map(m => [m[1], Number(m[2])]),
  );
  if (Object.keys(enums[name.split('/')[1]]).length < 4) throw Error('Changed native enum ' + name);
}
const resourcePattern = /pattern: "([^"]+)"/.exec(content['resources/conversion_action'])?.[1],
  route = '/' + googleVersion + '/customers/{customer_id=*}/conversionActions:mutate',
  service = content['services/conversion_action_service'];
if (
  resourcePattern !== 'customers/{customer_id}/conversionActions/{conversion_action_id}' ||
  !service.includes(route) ||
  !service.includes('repeated ConversionActionOperation operations = 2') ||
  !service.includes('repeated MutateConversionActionResult results = 2;')
)
  throw Error('Native conversion action route or request/receipt changed.');
pin(
  'tests/fixtures/google-conversion-actions-' + googleVersion + '.json',
  {
    version: googleVersion,
    checked_at: '2026-09-28',
    meaning:
      'Public source-hashed protocol evidence. Native definition support does not establish tracking, upload eligibility or provider permissions.',
    sources,
    resourcePattern,
    route,
    fields,
    enums,
  },
  'Conversion evidence',
);
console.log(
  'Verified conversion-action service, resource, nested business settings, six enums and eight public source hashes.',
);
