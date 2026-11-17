import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {applyExecutionRisk, independentlyReadOnly} from '../dist/src/execution-risk.js';
import {findCreated} from '../dist/src/write-reconciliation.js';
import {standardBodies} from './helpers/tiktok-standard-creates.mjs';
import {
  creates as metaCreates,
  gateway as metaGateway,
  account as metaAccount,
} from './helpers/meta-reconcile-fixture.mjs';
import {at, gateway as googleGateway} from './helpers/google-reconcile-fixture.mjs';

/**
 * R2.5 M2, property (c) of the plan: a reconciliation only reads. Every read that any provider's created lookup asks for is
 * a read by the rule `reconcile` applies to each one before it is sent (independentlyReadOnly), and is nothing else: not a
 * mutation, not destructive, asking for no confirmation. Google's search is a POST by the API's own design, and is the only
 * kind of POST among them. The lookups of every provider that has one (Google Ads, Meta, TikTok) are asked, over the creates
 * each of them covers.
 */
const compiler = new Compiler(new Registry()),
  options = {mode: 'strict', flags: {}};
const compile = (gateway, action, account, params, payload) =>
  applyExecutionRisk(
    compiler.compile(
      gateway,
      {action, account_id: account, ...(params ? {params} : {}), payload, dry_run: true},
      options,
    ),
  );
const claimed = Date.parse('2026-10-10T10:00:00Z');

const plans = [];
for (const [kind, [action, params, payload]] of Object.entries(metaCreates))
  plans.push(['Meta ' + kind, compile(metaGateway, action, metaAccount, params, payload)]);
for (const [kind, {action, payload}] of Object.entries(standardBodies('123')))
  plans.push(['TikTok ' + kind, compile('tiktok_native_action', action, '123', undefined, payload)]);
const budget = {create: {name: 'Property budget', amountMicros: '5000000', deliveryMethod: 'STANDARD'}};
plans.push([
  'Google budget',
  compile(googleGateway, 'google_ads_v23_campaign_budget_mutate_campaign_budgets', '123', undefined, {
    operations: [budget],
  }),
]);
plans.push([
  'Google build',
  compile(googleGateway, 'google_ads_v23_google_ads_mutate', '123', undefined, {
    mutate_operations: [
      {
        campaign_budget_operation: {
          create: {
            resource_name: at('campaignBudgets', '-1'),
            name: 'Property build budget',
            amount_micros: '40000000',
            delivery_method: 'STANDARD',
          },
        },
      },
      {
        campaign_operation: {
          create: {
            resource_name: at('campaigns', '-2'),
            name: 'Property build campaign',
            status: 'PAUSED',
            advertising_channel_type: 'SEARCH',
            campaign_budget: at('campaignBudgets', '-1'),
            manual_cpc: {},
            network_settings: {target_google_search: true, target_search_network: false, target_content_network: false},
            contains_eu_political_advertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
          },
        },
      },
    ],
  }),
]);

test('every read of every created lookup is a read by the rule reconcile applies, and the only POST is Google’s search', () => {
  assert.equal(plans.length, 11, 'Meta’s six creates, TikTok’s three, Google’s two');
  for (const [label, plan] of plans) {
    const lookup = findCreated(plan, {state: [{sets: [], feeds: []}], claimedAt: claimed});
    assert.ok(lookup, label + ' has a lookup');
    assert.ok(lookup.reads.length > 0, label);
    for (const read of lookup.reads) {
      assert.equal(independentlyReadOnly(read), true, label + ': ' + read.method + ' ' + read.path);
      assert.deepEqual([read.readOnly, read.destructive, read.requiresConfirmation], [true, false, false], label);
      if (read.method === 'POST')
        assert.match(read.path, /\/googleAds:search$/, label + ': a POST that is not Google’s search');
      else assert.deepEqual([read.method, read.body], ['GET', undefined], label);
      // Whatever the lookup asks, it asks of the account the write was made in.
      assert.equal(String(read.accountId).replace(/^act_/, ''), String(plan.accountId).replace(/^act_/, ''), label);
    }
  }
});

test('a lookup the follow-up page of a list asks for is as much a read as its first', () => {
  for (const [label, plan] of plans) {
    const lookup = findCreated(plan, {state: [{sets: [], feeds: []}], claimedAt: claimed});
    if (!lookup?.more) continue;
    // A list that names a next page, in the words of its provider: Meta's cursor, or TikTok's page counts (lead review S3-1).
    const answer =
      plan.gateway === 'tiktok_native_action'
        ? {
            status: 200,
            headers: {},
            data: {code: 0, data: {list: [], page_info: {page: 1, page_size: 100, total_number: 250, total_page: 3}}},
          }
        : {
            status: 200,
            headers: {},
            data: {data: [], paging: {cursors: {after: 'next'}, next: 'https://example.test/next'}},
          };
    const next = lookup.more(lookup.reads.map(() => answer));
    assert.ok(next.length > 0, label + ' follows a list that names a next page');
    for (const read of next) {
      assert.equal(independentlyReadOnly(read), true, label);
      assert.deepEqual(
        [read.method, read.readOnly, read.destructive, read.body],
        ['GET', true, false, undefined],
        label,
      );
    }
  }
});
