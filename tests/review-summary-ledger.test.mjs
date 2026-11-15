import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewSummary} from '../dist/src/review-summary.js';
import {reviewedWriteRoutes} from './helpers/ledger-write-plans.mjs';

/**
 * Round 2.5, package r25-m0-review, S2-2 and S4-4: the person approving a write reads a summary that names what it does, and
 * the milestone's own condition is that every create review reads "Create". This sweeps every write route the review
 * accepts (the action ledger's reviewed_write_family rows: a registered family's, or a provider's entity writes) and checks
 * the summary against an oracle that shares nothing with the code that reads the route.
 *
 * The oracle never looks at how the summary reads a path. It takes what the route is from the vendor's own name for it
 * (the method name the ledger records as the route's anchor: the SDK's or the API reference's), else from the ledger's
 * action name where that carries a verb, and, for X and LinkedIn, whose names carry only the HTTP method, from the route
 * template of the ledger: a POST to a collection (a template that ends in a literal) creates in it, and a POST to an entity
 * (one that ends in a key) acts on it. Google Ads' :mutate requests are summarized from the operations of their body, which
 * tests/provider-review-stages.test.mjs and tests/review-summary-operations.test.mjs pin, so they are not read from routes.
 * Every row is a synthetic request the ledger itself builds; nothing is sent and no account is named.
 */
const segments = template => template.split('/').filter(Boolean);
const isKey = segment => /^\{.*\}$/.test(segment);

/** Families that start a report job or an export with a POST: the job is created, whatever the vendor calls the call. */
const jobFamilies = new Set(['meta_insights_jobs', 'x_report_jobs', 'criteo_report_jobs']);

/** Whether the route creates what it names, by the oracle's sources alone. */
function creates({row}) {
  const anchor = row.anchor?.method ?? '',
    name = row.action.toLowerCase(),
    template = row.path.split('?')[0];
  if (jobFamilies.has(row.family)) return row.method === 'POST';
  switch (row.gateway) {
    case 'apple_ads_native_action':
      // The Python SDK of the platform names a POST to a collection <collection>Post.
      return /Post$/.test(anchor);
    case 'criteo_native_action':
      return /^(?:Create|bulkCreate|CatalogApi_Post|Catalog_Post)/.test(anchor);
    case 'dv360_native_action':
      return /\.(?:create|bulkCreate|duplicate)$/.test(anchor);
    case 'ga4_native_action':
    case 'google_business_native_action':
    case 'gtm_native_action':
      return /\.create(?:_version)?$/.test(anchor);
    case 'google_search_console_native_action':
      return /\.add$/.test(anchor);
    case 'meta_native_action':
      return anchor ? /^[A-Za-z]+\.create_/.test(anchor) : /_create$/.test(name);
    case 'microsoft_ads_native_action':
      return /^Add/.test(anchor);
    case 'reddit_native_action':
      return /^Create /.test(anchor);
    case 'snapchat_native_action':
      return /_create(?:_\d+)?$/.test(name);
    case 'tiktok_native_action':
      return /_(?:create|add)$/.test(name);
    case 'linkedin_native_action':
    case 'x_ads_native_action':
      return row.method === 'POST' && !isKey(segments(template).at(-1));
  }
  return undefined;
}

/**
 * The routes whose summary is not the oracle's create, each with what it reads and why. A route is listed only when the
 * oracle's sources are not what the person should read: it must be a documented difference, never a route left unfixed.
 */
const exceptions = {
  // Meta's SDK names this POST create_delete_rule_set, but it deletes the rule set: the summary says so.
  meta_value_rule_set_id_delete_rule_set_create: 'delete',
};
/**
 * A route whose operations the body decides, so a sample with no body cannot say: the batch goldens of
 * tests/review-summary-operations.test.mjs pin it item by item.
 */
const bodyDecides = new Set(['x_batch_accounts_account_id_targeting_criteria_post']);

const routes = reviewedWriteRoutes().filter(({row}) => row.gateway !== 'google_ads_native_action');

test('the sweep reaches the write routes of every provider the review accepts, as the ledger sampled them', () => {
  // The count keeps the sweep from passing vacuously should the ledger lose its rows.
  assert.ok(routes.length >= 560, 'reviewed write routes: ' + routes.length);
  const byGateway = Object.groupBy(routes, ({row}) => row.gateway);
  for (const gateway of [
    'apple_ads_native_action',
    'criteo_native_action',
    'dv360_native_action',
    'ga4_native_action',
    'google_business_native_action',
    'google_search_console_native_action',
    'gtm_native_action',
    'linkedin_native_action',
    'meta_native_action',
    'microsoft_ads_native_action',
    'reddit_native_action',
    'snapchat_native_action',
    'tiktok_native_action',
    'x_ads_native_action',
  ])
    assert.ok(byGateway[gateway]?.length >= 2, gateway + ': ' + byGateway[gateway]?.length);
  // DV360's routes have no read_only flag in the captured data, which is why the old sweeps skipped them all.
  assert.ok(byGateway.dv360_native_action.length >= 50, 'DV360 routes: ' + byGateway.dv360_native_action.length);
  // Each sample is the request the ledger classified the route by: the registry claims it for the family the ledger names.
  assert.deepEqual(
    routes.filter(r => !r.matches).map(r => r.row.gateway + ' ' + r.row.action),
    [],
  );
  assert.equal(routes.filter(creates).length >= 190, true);
});

test('every write route the review accepts reads as a create exactly when the vendor’s own name for it says it creates', () => {
  const wrong = [];
  let created = 0;
  for (const {row, plan} of routes) {
    if (bodyDecides.has(row.action)) continue;
    const expected = exceptions[row.action] ?? (creates({row}) ? 'create' : undefined),
      got = reviewSummary(plan, []);
    if (expected === 'create') created++;
    const matches =
      expected === undefined
        ? got.operation !== 'create'
        : expected === 'create'
          ? got.operation === 'create' && /^Create 1 /.test(got.text)
          : got.operation === expected;
    if (!matches)
      wrong.push(
        [
          row.gateway.replace('_native_action', ''),
          row.family,
          row.method,
          row.path.split('?')[0],
          row.action,
          'reads ' + got.operation + ', the oracle says ' + (expected ?? 'not a create'),
        ].join(' | '),
      );
  }
  assert.deepEqual(wrong, []);
  assert.ok(created >= 190, 'routes the oracle says create: ' + created);
});

test('a create of any reviewed route borrows no status from the account it is created in', () => {
  const account = [{id: 123, name: 'Synthetic account', currency: 'USD', status: 'ACTIVE'}],
    body = {status: 'PAUSED', entity_status: 'PAUSED', operation_status: 'DISABLE'},
    borrowed = [];
  for (const {row, plan} of routes) {
    const s = reviewSummary({...plan, body}, account);
    // A create has no earlier status: its status entries name only what it sets.
    if (s.operation === 'create') for (const entry of s.status ?? []) if ('from' in entry) borrowed.push(row.action);
  }
  assert.deepEqual(borrowed, []);
});
