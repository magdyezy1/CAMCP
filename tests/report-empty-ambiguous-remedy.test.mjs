// Package r25-m0-live (Round 2.5, item 3: error 8 of the live checks of 2026-11-15). LinkedIn answered a guided capture with
// no rows, and the refusal (REPORT_EMPTY_AMBIGUOUS: no activity and missing reporting access look alike, so no zero was
// saved) carried the remedy "Retry the report; if it happens again, copy the error details for support." A retry of the same
// window answers the same, so the agent had nothing to do. The remedy now names what an agent can do: widen the window
// within LinkedIn's limit, check the account's reporting access, or read the account natively to tell no activity from no
// access. The remedy is LinkedIn's own (src/linkedin-remedies.ts); the website's source card reads the same text.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {MirrorError, errorRemedy, errorResult, providerDataAction, providerDataCodes} from '../dist/src/errors.js';
import {reportSourceError} from '../dist/src/report-errors.js';
import {providerRemedy} from '../dist/src/provider-remedies.js';
import {assertRefused} from './helpers/assert-refused.mjs';

const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
const actor = {tenantId: 'synthetic-empty-ambiguous', userId: 'owner', role: 'admin'},
  connectionId = 'aaaaaaaa-1111-4111-8111-111111111111';
const day = offset => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
const input = {
  action: 'capture_preset',
  preset: 'linkedin_campaign',
  account_id: '100',
  connection_id: connectionId,
  semantics: {
    currency: 'USD',
    timezone: 'UTC',
    date_from: day(2),
    date_to: day(1),
    source_name: 'Synthetic LinkedIn',
    attribution: 'unknown',
    complete: true,
  },
};
/** A LinkedIn account whose analytics answer is empty: the real capture path, with the provider's answers faked. */
function emptyAccount(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 83).toString('base64'));
  t.after(() => store.close());
  store.putConnection(
    actor,
    {
      id: connectionId,
      tenantId: actor.tenantId,
      gateway: 'linkedin_native_action',
      accounts: ['100'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['r_ads', 'r_ads_reporting'],
    },
    {accessToken: 'synthetic'},
  );
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async raw => {
      const path = new URL(raw).pathname;
      if (path === '/rest/adAccounts/100') return Response.json({id: 100, currency: 'USD'});
      if (path === '/rest/adAnalytics') return Response.json({elements: []});
      throw new Error('Unexpected request: ' + path);
    }),
  );
  return {store, call: args => service.call('amcp_reporting', args, actor)};
}

test('an empty LinkedIn capture names what to do, not a retry, and saves no zero', async t => {
  const f = emptyAccount(t),
    result = await f.call(input);
  assertRefused(result, 'REPORT_EMPTY_AMBIGUOUS', {
    message: /^LinkedIn returned no rows\. No activity and missing reporting access cannot be distinguished/,
  });
  const {remedy, next_action: next} = result.error;
  assert.equal(result.error.category, 'report');
  assert.deepEqual([remedy.owner, remedy.mutation_retry_safe], ['operator', false]);
  assert.notEqual(remedy.action, providerDataAction);
  assert.doesNotMatch(remedy.action, /Retry the report/);
  // The three things an agent can do, in LinkedIn's terms.
  assert.match(remedy.action, /Widen the window within LinkedIn’s limit/);
  assert.match(remedy.action, /the current month and the previous five calendar months/);
  assert.match(remedy.action, /check that this login can read the account’s reporting/i);
  assert.match(remedy.action, /read the account natively \(linkedin_native_action linkedin_rest_ad_analytics_get\)/);
  assert.match(remedy.action, /tell no activity from no access/);
  assert.equal(next, remedy.action, 'the MCP next_action is the remedy');
  // An empty answer is still refused as it was: nothing is retained as evidence.
  assert.equal(f.store.documents(actor.tenantId, 'decision_report').length, 0);
});

test('the remedy is LinkedIn’s own declared one, and answers the code wherever it is raised', () => {
  const declared = providerRemedy('REPORT_EMPTY_AMBIGUOUS', {});
  assert.ok(declared, 'a provider declares it');
  assert.deepEqual(errorRemedy(new MirrorError('REPORT_EMPTY_AMBIGUOUS', 'm', {}, 502)), declared);
  // The Overview raises it from another place, with a template message; the remedy is the same.
  const overview = new MirrorError(
    'REPORT_EMPTY_AMBIGUOUS',
    'LinkedIn returned no rows for {from}–{to}. Check that the account delivered in those dates.',
    {},
    400,
    false,
    {from: '2026-09-01', to: '2026-09-07'},
  );
  assert.deepEqual(errorRemedy(overview), declared);
  assert.equal(errorResult(overview, 'request-1', 1).error.remedy.action, declared.action);
});

test('the website’s source card shows the same next step for an empty LinkedIn source', () => {
  const error = new MirrorError('REPORT_EMPTY_AMBIGUOUS', 'LinkedIn returned no rows.', {}, 502),
    source = {platform: 'linkedin', account_id: '100', connection_id: connectionId};
  const card = reportSourceError(error, source);
  assert.equal(card.category, 'provider_data');
  assert.equal(card.next_action, providerRemedy('REPORT_EMPTY_AMBIGUOUS', {}).action);
  assert.notEqual(card.next_action, providerDataAction);
});

// The other provider-data codes still ask for a retry: their cause may be transient, and none declares a remedy of its own.
test('every other provider-data code keeps its retry action, on the MCP error and on the source card', () => {
  for (const code of providerDataCodes) {
    if (code === 'REPORT_EMPTY_AMBIGUOUS') continue;
    assert.equal(providerRemedy(code, {}), undefined, code + ' declares no provider remedy');
    const card = reportSourceError(new MirrorError(code, 'm', {}, 502), {platform: 'tiktok', account_id: '7'});
    assert.equal(card.next_action, providerDataAction, code);
  }
});

test('the remedy has Arabic that keeps the native action name, in the catalogue the website loads', () => {
  const {action} = providerRemedy('REPORT_EMPTY_AMBIGUOUS', {});
  assert.ok(Object.hasOwn(catalog, action), 'Arabic for the remedy');
  assert.match(catalog[action], /\p{Script=Arabic}/u);
  for (const token of ['linkedin_native_action', 'linkedin_rest_ad_analytics_get'])
    assert.ok(catalog[action].includes(token), token);
});
