import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {auditInputRedactors, auditedInput} from '../dist/src/service.js';
import {withoutPeople} from '../dist/src/personal-data.js';
import {redactMetaPostInput} from '../dist/src/meta-existing-posts.js';
import {redactPlaceActionInput} from '../dist/src/google-place-action-links.js';
import {redactConnectionInput} from '../dist/src/connection-diagnostics.js';
import {redactReportingRecord} from '../dist/src/report-query-access.js';
import {reviewedFamilies} from '../dist/src/reviewed-families.js';

// ARC-04 stage D: the audit record of a refused tool call keeps its arguments through a table of redactors instead of
// five nested calls in MirrorService.callOnce. Loading the catalog first evaluates the registry, as entry points do.
new Registry();
const personal = new Set(reviewedFamilies().flatMap(f => f.personalData?.actions ?? []));
// The nesting callOnce applied before the table, innermost first.
const nested = (tool, input) =>
  redactReportingRecord(
    redactConnectionInput(
      tool,
      redactPlaceActionInput(tool, redactMetaPostInput(tool, withoutPeople(tool, input, personal))),
    ),
  );
const [personalGateway, personalAction] = [...personal][0].split(' ');
const samples = {
  people: [
    'amcp_write',
    {action: 'prepare', gateway: 'meta_native_action', people: {rows: [{email: 'a@example.com'}]}},
  ],
  personalArguments: [
    'amcp_write',
    {action: 'prepare', gateway: personalGateway, arguments: {action: personalAction, phone: '+15550100'}},
  ],
  metaPost: [
    'amcp_native_action',
    {
      operation: 'fetch_meta_existing_posts',
      arguments: {account_id: '1', url: 'https://www.facebook.com/a/posts/1', after: 'c', params: {pageToken: 'n'}},
    },
  ],
  placeAction: [
    'google_business_native_action',
    {operation: 'gmb_engagement_ops', arguments: {websiteUri: 'http://127.0.0.1/private'}},
  ],
  connection: [
    'ga4_native_action',
    {operation: 'ga4_connection_ops', arguments: {action: 'status', code: 'oauth-code', state: 'oauth-state'}},
  ],
  reporting: [
    'amcp_workspace',
    {action: 'save_report_query', query_config: {gateway: 'meta_native_action', arguments: {access_token: 'EAAB1'}}},
  ],
  combined: [
    'amcp_native_action',
    {operation: 'fetch_meta_existing_posts', arguments: {url: 'https://www.facebook.com/a/posts/2', access_token: 'x'}},
  ],
  untouched: ['amcp_workspace', {action: 'dashboard', limit: 5}],
};

test('the audit redactor table keeps exactly what the nested redactors kept, in their order', () => {
  assert.equal(auditInputRedactors.length, 5);
  assert.ok(Object.isFrozen(auditInputRedactors));
  for (const [name, [tool, input]] of Object.entries(samples))
    assert.deepEqual(auditedInput(tool, structuredClone(input)), nested(tool, structuredClone(input)), name);
});

test('each redactor of the table does its part: people, post links, place links, OAuth codes, reporting credentials', () => {
  const kept = name => auditedInput(samples[name][0], structuredClone(samples[name][1]));
  assert.deepEqual(kept('people').people, {withheld: 'personal data', rows: 1});
  assert.deepEqual(kept('personalArguments').arguments, {action: personalAction, withheld: 'personal data arguments'});
  assert.deepEqual(
    [kept('metaPost').arguments.url, kept('metaPost').arguments.after, kept('metaPost').arguments.params.pageToken],
    ['[REDACTED]', '[REDACTED]', '[REDACTED]'],
  );
  assert.equal(kept('placeAction').arguments.websiteUri, '[PRIVATE_OR_INVALID_URL_REDACTED]');
  assert.deepEqual(
    [kept('connection').arguments.code, kept('connection').arguments.state],
    ['[REDACTED]', '[REDACTED]'],
  );
  assert.equal(kept('reporting').query_config.arguments.access_token, '[REDACTED]');
  assert.deepEqual(
    [kept('combined').arguments.url, kept('combined').arguments.access_token],
    ['[REDACTED]', '[REDACTED]'],
  );
  assert.deepEqual(kept('untouched'), samples.untouched[1]);
});
