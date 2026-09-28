import {fieldNames, googleVersion, message, pin, readProtos} from './google-protos.mjs';
// Offline extraction from explicitly supplied public Google source files.
const {sources, content} = readProtos(
  [
    'resources/bidding_strategy',
    'services/bidding_strategy_service',
    'common/bidding',
    'enums/bidding_strategy_status',
    'enums/bidding_strategy_type',
    'enums/target_impression_share_location',
    'errors/bidding_strategy_error',
  ],
  'portfolio protos',
);
const fields = {};
for (const name of [
  'TargetCpa',
  'TargetRoas',
  'MaximizeConversions',
  'MaximizeConversionValue',
  'TargetImpressionShare',
  'TargetSpend',
])
  fields[name] = fieldNames(message(content['common/bidding'], name));
const enums = {};
for (const name of [
  'bidding_strategy_status',
  'bidding_strategy_type',
  'target_impression_share_location',
  'bidding_strategy_error',
]) {
  const file = (name === 'bidding_strategy_error' ? 'errors/' : 'enums/') + name;
  enums[name] = Object.fromEntries(
    [...content[file].matchAll(/^\s+([A-Z_]+) = (\d+);/gm)].map(m => [m[1], Number(m[2])]),
  );
  if (Object.keys(enums[name]).length < 4) throw Error('Changed native enum: ' + name);
}
const native = message(content['resources/bidding_strategy'], 'BiddingStrategy'),
  resourcePattern = /pattern: "([^"]+)"/.exec(native)?.[1],
  route = '/' + googleVersion + '/customers/{customer_id=*}/biddingStrategies:mutate';
if (
  resourcePattern !== 'customers/{customer_id}/biddingStrategies/{bidding_strategy_id}' ||
  !content['services/bidding_strategy_service'].includes(route) ||
  !content['services/bidding_strategy_service'].includes('repeated BiddingStrategyOperation operations = 2') ||
  !content['services/bidding_strategy_service'].includes('repeated MutateBiddingStrategyResult results = 2;')
)
  throw Error('The native portfolio resource or operation/result contract changed.');
const resourceFields = fieldNames(native);
pin(
  'tests/fixtures/google-portfolio-' + googleVersion + '.json',
  {
    version: googleVersion,
    checked_at: '2026-09-28',
    meaning: 'Public source-hashed protocol evidence; not live eligibility or permission.',
    sources,
    resourcePattern,
    route,
    resourceFields,
    fields,
    enums,
  },
  'Portfolio evidence',
);
console.log(
  'Verified portfolio native resource, mutation service, six schemes, four enums and seven public source hashes.',
);
