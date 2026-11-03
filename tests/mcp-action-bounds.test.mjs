// V2-MCP-01: operation help's limits/defaults come from the handler limits pinned in round-1.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {contractsMarkdown} from '../dist/src/first-party-contracts.js';
import {assertRefused} from './helpers/assert-refused.mjs';

const names = {
  overview: 'amcp_reporting_overview',
  workspace: 'amcp_workspace',
  campaign: 'amcp_campaign',
  reporting: 'amcp_reporting',
  media: 'amcp_media',
  write: 'amcp_write',
};
const pinned = [
  ['overview', 'list', 'limit', {minimum: 1, maximum: 100, default: 50}],
  ['overview', 'get', 'limit', {minimum: 1, maximum: 500, default: 100}],
  ['overview', 'compare_candidates', 'limit', {minimum: 1, maximum: 100, default: 50}],
  ['overview', 'compare', 'limit', {minimum: 1, maximum: 500, default: 100}],
  ['overview', 'presentation_profiles', 'limit', {minimum: 1, maximum: 100, default: 30}],
  ['overview', 'bind_destination', 'tab_name', {maxLength: 80, default: 'AMCP Overview'}],
  ['workspace', 'capabilities', 'limit', {minimum: 1, maximum: 25, default: 20}],
  ['workspace', 'operations', 'limit', {minimum: 1, maximum: 100, default: 30}],
  ['workspace', 'history', 'limit', {minimum: 1, maximum: 100, default: 100}],
  ['workspace', 'contracts', 'limit', {default: 50}],
  ['workspace', 'report_queries', 'limit', {default: 50}],
  ['workspace', 'report_bindings', 'limit', {default: 20}],
  ['workspace', 'monitors', 'limit', {default: 50}],
  ['workspace', 'incidents', 'limit', {default: 50}],
  ['workspace', 'portfolio', 'limit', {minimum: 1, maximum: 100, default: 50, note: 'Snapchat accepts 50–100.'}],
  ['workspace', 'portfolio_reconcile', 'limit', {minimum: 1, maximum: 100, default: 50}],
  ['workspace', 'portfolio_reconcile', 'max_entities', {minimum: 1, maximum: 1000, default: 500}],
  ['workspace', 'portfolio_reconcile', 'max_pages', {minimum: 1, maximum: 25, default: 20}],
  ['workspace', 'save_retention', 'days', {minimum: 7, maximum: 365}],
  ['workspace', 'save_retention', 'archived_campaign_plans_days', {note: '0, or 7–3650.'}],
  ['campaign', 'list', 'limit', {minimum: 1, maximum: 100, default: 50}],
  ['reporting', 'get', 'limit', {default: 50}],
  ['reporting', 'list', 'limit', {default: 30, note: 'offset must be 0.'}],
  ['reporting', 'allocation_candidates', 'limit', {default: 20}],
  ['reporting', 'search_exclusion_candidates', 'limit', {default: 50}],
  ['media', 'list', 'limit', {minimum: 1, maximum: 100, default: 50}],
  ['media', 'library', 'limit', {minimum: 1, maximum: 100, default: 30}],
  ['media', 'asset_performance', 'limit', {minimum: 1, maximum: 100, default: 30}],
  ['media', 'asset_usage', 'limit', {default: 50, note: 'Meta 1–100; Google and Snapchat 1–1000.'}],
  ['media', 'library', 'cursor', {maxLength: 1024}],
  ['write', 'execute', 'idempotency_key', {note: 'Defaults to the review_id; any other value is refused.'}],
];
function fixture(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 71).toString('base64')),
    actor = {tenantId: 'synthetic-action-bounds', userId: 'owner', role: 'admin'};
  t.after(() => store.close());
  let requests = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      requests++;
      throw Error('No provider egress permitted');
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  return {service, call: (tool, args) => service.call(tool, args, actor), requests: () => requests};
}
test('every pinned limit and default is exposed by operation help', async t => {
  const f = fixture(t);
  for (const [tool, action, argument, expected] of pinned) {
    const result = await f.call('amcp_tool_help', {gateway: names[tool], operation: action});
    assert.equal(result.success, true, JSON.stringify(result.error));
    const property = result.data.contract.arguments_schema.properties[argument];
    assert.ok(property, tool + ' ' + action + ' ' + argument);
    for (const [key, value] of Object.entries(expected))
      if (key === 'note')
        assert.ok(property.description?.includes(value), tool + ' ' + action + ' ' + argument + ' note');
      else assert.deepEqual(property[key], value, tool + ' ' + action + ' ' + argument + ' ' + key);
  }
  assert.equal(f.requests(), 0);
});
test('bounded local list handlers refuse one past their maximum and accept the maximum', async t => {
  const f = fixture(t);
  for (const [tool, action, max, code] of [
    ['amcp_reporting_overview', 'list', 100, 'INVALID_PAGE'],
    ['amcp_workspace', 'capabilities', 25, 'INVALID_ARGUMENT'],
    ['amcp_campaign', 'list', 100, 'INVALID_ARGUMENT'],
    ['amcp_media', 'list', 100, 'INVALID_ARGUMENT'],
  ]) {
    const invalid = await f.call(tool, {action, limit: max + 1});
    assertRefused(invalid, code);
    const valid = await f.call(tool, {action, limit: max});
    assert.equal(valid.success, true, tool + ' ' + JSON.stringify(valid.error));
  }
  assert.equal(f.requests(), 0);
});
test('the flat media tag accepts the library handler limit of 200 characters', async t => {
  const f = fixture(t),
    media = f.service.firstPartyTools().find(tool => tool.name === 'amcp_media');
  assert.equal(media.inputSchema.properties.tag.maxLength, 200);
  assert.equal((await f.call('amcp_media', {action: 'library', tag: 'x'.repeat(200)})).success, true);
  assertRefused(await f.call('amcp_media', {action: 'library', tag: 'x'.repeat(201)}), 'INVALID_ARGUMENT');
  assert.equal(f.requests(), 0);
});
test('contracts Markdown includes argument bounds and defaults', t => {
  const f = fixture(t),
    markdown = contractsMarkdown(f.service.firstPartyTools()).replace(/[*`]/g, '');
  assert.ok(markdown.includes('limit (1–100, default 50)'));
  assert.ok(markdown.includes('tab_name (maxLength 80, default "AMCP Overview")'));
});
