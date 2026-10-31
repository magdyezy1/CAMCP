import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reportQuerySQL,
  reportResourceFieldsSQL,
  reportRunFeedSQL,
  reportScopeFieldsSQL,
  reportSelectorProviders,
  workbookScheduleFeedSQL,
} from '../dist/src/workbook-repository.js';
import {reportResourceFieldsSQL as reExported} from '../dist/src/report-resource-scope.js';
import {registeredProviderHooks} from '../dist/src/provider-hooks.js';

/**
 * ARC-01 (reporting, wave 4c round 6): the workbook selectors' SQL projection is written by the store layer
 * (src/workbook-repository.ts) from the selectors the providers' reportScope hooks declare as data. Its SQL text is the
 * text the projection named the five gateways with before; `legacyResourceFieldsSQL` is that function as it was.
 */
function legacyResourceFieldsSQL(native) {
  const source = "CASE WHEN length(CAST(j.input AS BLOB))<=131072 THEN j.input ELSE '{}' END",
    config = `json_extract(${source},'$.query_config')`,
    wrapper = `json_extract(${source},'$.query_config.arguments')`,
    occurrences = (cell, key) => `(SELECT count(*) FROM json_each(${cell}) WHERE key='${key}')`,
    wrapped = "json_type(j.input,'$.query_config.arguments.operation')='text'",
    envelopeValid = `length(CAST(j.input AS BLOB))<=131072
      AND ${occurrences(source, 'query_config')}=1 AND json_type(${source},'$.query_config')='object'
      AND ${occurrences(config, 'gateway')}=1 AND ${occurrences(config, 'arguments')}=1
      AND CASE WHEN ${wrapped} THEN ${occurrences(wrapper, 'operation')}=1 AND ${occurrences(wrapper, 'arguments')}=1 ELSE 1 END`,
    args = `CASE WHEN ${wrapped} THEN json_extract(j.input,'$.query_config.arguments.arguments')
      ELSE json_extract(j.input,'$.query_config.arguments') END`,
    argsType = `CASE WHEN ${wrapped} THEN json_type(j.input,'$.query_config.arguments.arguments')
      ELSE json_type(j.input,'$.query_config.arguments') END`,
    valid = `${envelopeValid} AND ${argsType}='object' AND length(CAST(${args} AS BLOB))<=65536`,
    bounded = `CASE WHEN ${valid} THEN ${args} ELSE '{}' END`,
    key = 'native_parameter_key(r.key)',
    direct = `r.path IN ('$','$.params','$."path_params"')`,
    ga4 = `(${direct} AND ${key} IN ('property','name','parent'))
      OR (r.path IN ('$','$.params') AND ${key} IN ('reporttaskname','audienceexportname')
        AND (r.type!='text' OR instr(r.value,'/')>0))
      OR ((r.path='$.request' OR substr(r.path,1,10) IN ('$.request.','$.request[')) AND ${key}='property')`,
    gsc = `r.path IN ('$','$.params','$."path_params"','$.payload') AND ${key} IN ('siteurl','site','propertyurl')`,
    gtm = `${direct} AND ${key} IN ('path','parent','accountid')`,
    business = `${direct} AND ${key} IN ('name','parent','accountid','locationid')`,
    reddit = `${direct} AND ${key} IN ('accountid','adaccountid')`,
    project = (where, kind) => `(SELECT json_group_array(json_object('kind',v.kind,'value',
      CASE WHEN v.type='text' THEN substr(v.value,1,513) ELSE json('{"invalid":true}') END))
      FROM (SELECT r.type,r.value,${kind} AS kind FROM json_tree(${bounded}) r WHERE ${where} LIMIT 9) v)`,
    invalidBody = body => `EXISTS(SELECT 1 FROM json_tree(${bounded}) r
      WHERE r.path='$' AND r.key='${body}' AND r.type!='object')`;
  return `'resource_account_anchors',CASE WHEN ${native} THEN CASE json_extract(j.input,'$.query_config.gateway')
      WHEN 'ga4_native_action' THEN json_array(${project(ga4, `CASE WHEN ${key}='property' THEN 'property' ELSE 'resource' END`)})
      WHEN 'google_search_console_native_action' THEN json_array(${project(gsc, "'site'")})
      WHEN 'gtm_native_action' THEN json_array(${project(gtm, `CASE WHEN ${key}='accountid' THEN 'account' ELSE 'resource' END`)})
      WHEN 'google_business_native_action' THEN json_array(${project(business, `CASE ${key} WHEN 'accountid' THEN 'account' WHEN 'locationid' THEN 'location' ELSE 'resource' END`)})
      WHEN 'reddit_native_action' THEN json_array(${project(reddit, "'account'")})
      ELSE json_array() END ELSE json_array() END,
    'resource_body_invalid',CASE WHEN ${native} THEN CASE json_extract(j.input,'$.query_config.gateway')
      WHEN 'ga4_native_action' THEN CASE WHEN NOT coalesce((${valid}),0) OR ${invalidBody('request')} THEN 1 ELSE 0 END
      WHEN 'google_search_console_native_action' THEN CASE WHEN NOT coalesce((${valid}),0) OR ${invalidBody('payload')} THEN 1 ELSE 0 END
      WHEN 'gtm_native_action' THEN CASE WHEN NOT coalesce((${valid}),0) OR ${invalidBody('payload')} THEN 1 ELSE 0 END
      WHEN 'google_business_native_action' THEN CASE WHEN NOT coalesce((${valid}),0) OR ${invalidBody('payload')} THEN 1 ELSE 0 END
      WHEN 'reddit_native_action' THEN CASE WHEN NOT coalesce((${valid}),0) THEN 1 ELSE 0 END
      ELSE 0 END ELSE 0 END`;
}
// The store layer's native-query test, which reportScopeFieldsSQL passes to the projection.
const native = "json_extract(j.input,'$.query_config.gateway') IS NOT NULL";

test('the workbook selector projection keeps its SQL text, for both stored columns and in every statement', () => {
  for (const argument of [native, 'n.native IS NOT NULL'])
    assert.equal(reportResourceFieldsSQL(argument), legacyResourceFieldsSQL(argument));
  assert.equal(reExported, reportResourceFieldsSQL);
  for (const column of ['j.input', 'q.data']) {
    const fields = reportScopeFieldsSQL(column);
    assert.ok(fields.endsWith(legacyResourceFieldsSQL(native).replaceAll('j.input', column)), column);
  }
  assert.ok(reportRunFeedSQL.includes(reportScopeFieldsSQL('j.input')));
  assert.ok(workbookScheduleFeedSQL.includes(reportScopeFieldsSQL('q.data')));
  assert.ok(reportQuerySQL.includes(reportScopeFieldsSQL('q.data')));
});

test('the selector providers are the five the projection named, in its order, from their reportScope hooks', () => {
  assert.deepEqual(
    reportSelectorProviders(registeredProviderHooks).map(({gateway, selectors}) => [gateway, selectors.order]),
    [
      ['ga4_native_action', 1],
      ['google_search_console_native_action', 2],
      ['gtm_native_action', 3],
      ['google_business_native_action', 4],
      ['reddit_native_action', 5],
    ],
  );
  for (const hooks of registeredProviderHooks)
    if (hooks.reportScope?.selectors) {
      assert.ok(Object.isFrozen(hooks.reportScope.selectors), hooks.gateway);
      for (const group of hooks.reportScope.selectors.groups) assert.ok(Object.isFrozen(group), hooks.gateway);
    }
});

test('selectors that are not plain, distinctly ordered names are refused at load', () => {
  const selectors = (overrides = {}) => ({
    order: 1,
    groups: [{paths: ['$', '$.params', '$."path_params"'], keys: ['accountid']}],
    otherwise: 'account',
    ...overrides,
  });
  const provider = (gateway, overrides) => ({gateway, reportScope: {selectors: selectors(overrides)}});
  // Hooks without selectors are skipped, and the rest come in their order.
  assert.deepEqual(
    reportSelectorProviders([
      provider('b_native_action', {order: 2}),
      {gateway: 'c_native_action', reportScope: {}},
      {gateway: 'd_native_action'},
      provider('a_native_action', {order: 1}),
    ]).map(p => p.gateway),
    ['a_native_action', 'b_native_action'],
  );
  const refused = (hooks, gateway) =>
    assert.throws(
      () => reportSelectorProviders(hooks),
      e => e.message === 'The report selectors of ' + gateway + ' are not plain, ordered names.',
    );
  refused([provider('a_native_action', {}), provider('b_native_action', {})], 'a_native_action');
  for (const overrides of [
    {order: 0},
    {order: 1.5},
    {groups: []},
    {groups: [{paths: [], keys: ['accountid']}]},
    {groups: [{paths: ['$'], within: '$.request', keys: ['accountid']}]},
    {groups: [{keys: ['accountid']}]},
    {groups: [{paths: ["$') OR 1=1 --"], keys: ['accountid']}]},
    {groups: [{within: "$.request'", keys: ['property']}]},
    {groups: [{paths: ['$'], keys: []}]},
    {groups: [{paths: ['$'], keys: ["accountid'"]}]},
    {kinds: {accountid: "account' END"}},
    {kinds: {'account id': 'account'}},
    {otherwise: 'Account'},
    {body: "payload'"},
  ])
    refused([provider('a_native_action', overrides)], 'a_native_action');
  refused([provider("a_native_action'", {})], "a_native_action'");
});
