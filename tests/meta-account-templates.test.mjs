import test from 'node:test';
import assert from 'node:assert/strict';
import {Compiler, expandPath} from '../dist/src/compiler.js';
import {metaPrefix} from '../dist/src/meta-version.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {metaService, registry} from './helpers/meta-service.mjs';

// r25-fr-meta-reads, D5 (the owner's friction report of 2026-11-26): two Meta insights actions, and the one named for the account's
// insights failed on ownership and offered lists of campaigns, ad sets and ads. 69 captured reads name their account node as
// `{ad_account_id}` without `act_` (the ad account's Graph node is `act_<id>`); the compiler stripped `act_` only where the template
// showed it, so account_id "123" was sent as /123/insights, which the scope guard rightly takes for an object ID. Synthetic IDs only.
const gateway = 'meta_native_action',
  compiler = new Compiler(registry),
  strict = {mode: 'strict', flags: {}},
  insights = ['meta_ad_account_id_insights_get', 'meta_ad_account_id_insights_get_2', 'meta_insights_get'],
  compile = input => compiler.compile(gateway, input, strict);
const bare = /^\/v[^/]+\/\{ad_account_id\}(?:\/|$)/;

test('the account insights read has one path whichever of its three names and whichever spelling of the account ID is sent', () => {
  const expected = metaPrefix + 'act_123/insights';
  for (const action of insights)
    for (const shape of [
      {account_id: '123'},
      {account_id: 'act_123'},
      {ad_account_id: '123'},
      {ad_account_id: 'act_123'},
      {account_id: '123', ad_account_id: 'act_123'},
      {path_params: {ad_account_id: '123'}},
      {path_params: {ad_account_id: 'act_123'}, account_id: '123'},
    ])
      assert.equal(
        compile({action, query: {fields: 'spend'}, ...shape}).path,
        expected,
        action + ' ' + JSON.stringify(shape),
      );
});

test('every read whose template starts with the bare ad account is sent to act_<id>, and no other template changes', () => {
  const reads = registry.catalogs.get(gateway).actions.filter(a => bare.test(a.path));
  assert.ok(reads.length > 60, 'the bare ad account templates: ' + reads.length);
  for (const a of reads) {
    assert.equal(a.read_only, true, a.name);
    const params = Object.fromEntries([...a.path.matchAll(/\{([^{}]+)\}/g)].map(m => [m[1], 'test']));
    params.ad_account_id = '123';
    const planned = compile({action: a.name, account_id: '123', params, path_params: params});
    assert.equal(
      planned.path,
      expandPath(a.path.replace('{ad_account_id}', 'act_{ad_account_id}'), params).path,
      a.name,
    );
  }
  // A template that names an object, or already names the account with its prefix, is expanded as it always was.
  assert.equal(
    compile({action: 'meta_campaign_id_insights_get', account_id: '123', campaign_id: '456'}).path,
    metaPrefix + '456/insights',
  );
  assert.equal(
    compile({action: 'meta_ad_account_id_campaigns_get', account_id: '123'}).path,
    metaPrefix + 'act_123/campaigns',
  );
  assert.equal(
    compile({action: 'meta_ad_account_id_adlabels_get', account_id: 'act_123'}).path,
    metaPrefix + 'act_123/adlabels',
  );
});

test('the insights read the report named sends one request for account_id "123", where it was refused before', async t => {
  const f = metaService(t, {
    answer: () => Response.json({data: [{spend: '1.5'}], paging: {cursors: {before: 'a', after: 'b'}}}),
  });
  for (const action of insights) {
    const before = f.requests.length,
      out = await f.call({action, account_id: '123', query: {fields: 'spend'}});
    assert.equal(out.success, true, action + ' ' + JSON.stringify(out.error));
    assert.deepEqual(out.data.data.data, [{spend: '1.5'}], action);
    assert.equal(f.requests.length, before + 1, action);
    assert.equal(f.requests.at(-1).path, metaPrefix + 'act_123/insights', action);
    assert.equal(f.requests.at(-1).query.fields, 'spend', action);
  }
});

test('the guard still refuses what it refused: an object ID without its list, another account, an account the login lacks', async t => {
  const f = metaService(t);
  // A campaign's insights are a node read: ownership comes from the account's campaign list, as before.
  const node = await f.call({action: 'meta_campaign_id_insights_get', account_id: '123', campaign_id: '456'});
  assertRefused(node, 'RESOURCE_SCOPE_REQUIRED');
  assert.equal(node.error.details.next_call.arguments.action, 'meta_campaign_list');
  // The account named twice and differently is the request's fault.
  assertRefused(
    await f.call({action: insights[0], account_id: '123', ad_account_id: 'act_999', query: {fields: 'spend'}}),
    'ACCOUNT_SCOPE_MISMATCH',
  );
  assertRefused(
    await f.call({action: insights[0], account_id: '123', params: {ad_account_id: '124'}, query: {fields: 'spend'}}),
    'ACCOUNT_SCOPE_MISMATCH',
  );
  // An account this login does not grant has no connection to read it.
  const other = await f.call({action: insights[0], account_id: '999', query: {fields: 'spend'}});
  assert.equal(other.success, false);
  assert.notEqual(other.error.code, 'INTERNAL_ERROR');
  assert.equal(f.requests.length, 0, 'nothing was sent');
});
