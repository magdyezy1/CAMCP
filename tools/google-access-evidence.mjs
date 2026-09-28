import {googleVersion, pin, readProtos} from './google-protos.mjs';
// Only locally supplied public googleapis protos are read. No credentials.
const {sources, content} = readProtos(
  [
    'resources/customer_user_access',
    'resources/customer_user_access_invitation',
    'services/customer_user_access_service',
    'services/customer_user_access_invitation_service',
    'enums/access_role',
    'enums/access_invitation_status',
    'errors/customer_user_access_error',
    'errors/access_invitation_error',
    'resources/multi_party_auth_review',
  ],
  'access protos',
);
const enums = {};
for (const name of ['access_role', 'access_invitation_status']) {
  const matches = [...content['enums/' + name].matchAll(/^\s+([A-Z_]+) = (\d+);/gm)];
  if (matches.length < 5) throw Error('Changed native enum: ' + name);
  enums[name] = Object.fromEntries(matches.map(m => [m[1], Number(m[2])]));
}
const patterns = {};
for (const name of ['customer_user_access', 'customer_user_access_invitation', 'multi_party_auth_review']) {
  const pattern = /pattern: "([^"]+)"/.exec(content['resources/' + name])?.[1];
  if (!pattern) throw Error('Missing native resource identity: ' + name);
  patterns[name] = pattern;
}
const services = {};
for (const [name, collection] of [
  ['customer_user_access', 'customerUserAccesses'],
  ['customer_user_access_invitation', 'customerUserAccessInvitations'],
]) {
  const text = content['services/' + name + '_service'];
  const route = '/' + googleVersion + '/customers/{customer_id=*}/' + collection + ':mutate';
  if (
    !text.includes(route) ||
    !/Operation operation = 2/.test(text) ||
    /bool (?:validate_only|partial_failure)/.test(text) ||
    !text.includes('Result result = 1')
  )
    throw Error('Changed singular access request/response contract: ' + name);
  services[name] = {
    method: 'POST',
    route,
    request_field: 'operation',
    response_field: 'result',
    validate_only: false,
    partial_failure: false,
  };
}
pin(
  'tests/fixtures/google-user-access-' + googleVersion + '.json',
  {
    version: googleVersion,
    checked_at: '2026-09-28',
    meaning:
      'Source-hashed official Google ' +
      googleVersion +
      ' proto extraction plus pinned Discovery validation; schema evidence only, not live access approval.',
    sources,
    enums,
    patterns,
    services,
  },
  'Google user-access evidence',
);
console.log(
  'Verified two singular mutation services, two role/status enums, three resource patterns and nine public proto source hashes.',
);
