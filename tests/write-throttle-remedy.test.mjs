import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {MirrorError, errorRemedy} from '../dist/src/errors.js';
import {localeProblems} from '../tools/check-locales.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * L3-02 (Round 2.5, M0), the text part: a write the provider throttled at execute answered PLATFORM_RATE_LIMIT with
 * retryable:false and retry_after_ms, and the remedy "Wait for the provider retry interval; preserve the original review
 * for any submitted mutation": a caller would wait and execute the same review again, which answers
 * WRITE_OUTCOME_UNCERTAIN, because the dispatched write stays uncertain. The remedy now names the sequence that works: status,
 * the wait and a minute after the claim, reconcile, then prepare again with supersedes_review_id. A throttle of a read, or of a
 * write that was never sent, keeps its remedy. Every fixture is synthetic; nothing contacts a provider.
 */
const actor = {tenantId: 'write-throttle', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  CONNECTION = '30303030-3030-4303-8303-303030303030',
  account = '7000000000000000003',
  catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
const old = 'Wait for the provider retry interval; preserve the original review for any submitted mutation.';
const sequence =
  'The provider throttled this write, and AMCP cannot yet prove that nothing was applied, so this review is uncertain and is never executed again. Read amcp_write status with its review_id (details.next_call); after the wait in details.retry_after_ms and at least a minute after the claim, run amcp_write reconcile; if it finds the change was not applied, prepare the same request again with supersedes_review_id. Where reconcile cannot tell, check the provider before anything else.';

function fixture(throttle) {
  const store = new Store(':memory:', Buffer.alloc(32, 92).toString('base64'));
  store.putConnection(
    owner,
    {
      id: CONNECTION,
      tenantId: actor.tenantId,
      gateway: 'tiktok_native_action',
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic TikTok',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const campaign = {campaign_id: '100', campaign_name: 'Spring', operation_status: 'ENABLE'},
    writes = [];
  const transport = new NativeTransport(async (raw, init = {}) => {
    const url = new URL(String(raw)),
      path = url.pathname.replace(/^\/open_api/, '');
    if ((init.method ?? 'GET') === 'GET' && path === '/v1.3/campaign/get/')
      return Response.json({
        code: 0,
        message: 'OK',
        request_id: 'synthetic-request',
        data: {
          list: [structuredClone(campaign)],
          page_info: {page: 1, page_size: 1000, total_number: 1, total_page: 1},
        },
      });
    if (init.method === 'POST' && path === '/v1.3/campaign/status/update/') {
      writes.push(JSON.parse(init.body));
      return throttle();
    }
    throw new Error('Unexpected request ' + path);
  });
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  store.rememberResource({id: CONNECTION, tenantId: actor.tenantId, gateway: 'tiktok_native_action'}, account, '100');
  const call = (tool, input) => service.call(tool, input, actor);
  return {
    store,
    writes,
    call,
    prepare: () =>
      call('amcp_write', {
        action: 'prepare',
        gateway: 'tiktok_native_action',
        connection_id: CONNECTION,
        arguments: {
          action: 'tiktok_campaign_status_update',
          account_id: account,
          payload: {campaign_ids: ['100'], operation_status: 'DISABLE'},
        },
      }),
    execute: id =>
      call('amcp_write', {
        action: 'execute',
        review_id: id,
        idempotency_key: id,
        confirmed: true,
        spend_change_confirmed: true,
      }),
  };
}

test('a write throttled at execute is told the sequence that works, and the same review is indeed uncertain', async () => {
  const f = fixture(() => new Response('{}', {status: 429, headers: {'retry-after': '60'}}));
  try {
    const prepared = await f.prepare();
    assert.equal(prepared.success, true, JSON.stringify(prepared));
    const throttled = await f.execute(prepared.data.review_id);
    assertRefused(throttled, 'PLATFORM_RATE_LIMIT');
    assert.equal(f.writes.length, 1);
    assert.equal(throttled.error.details.retry_after_ms, 60000);
    assert.deepEqual(throttled.error.details.next_call, {
      tool: 'amcp_write',
      arguments: {action: 'status', review_id: prepared.data.review_id},
    });
    // The remedy is the sequence, not "wait and retry the review".
    assert.equal(throttled.error.remedy.action, sequence);
    assert.equal(throttled.error.next_action, sequence);
    assert.equal(throttled.error.remedy.mutation_retry_safe, false);
    assert.doesNotMatch(throttled.error.remedy.action, /Wait for the provider retry interval/);
    for (const step of [
      /amcp_write status/,
      /retry_after_ms/,
      /a minute after the claim/,
      /amcp_write reconcile/,
      /supersedes_review_id/,
    ])
      assert.match(throttled.error.remedy.action, step);
    // The behaviour the advice is written for: executing the same review again is refused as uncertain, sending nothing.
    const again = await f.execute(prepared.data.review_id);
    assertRefused(again, 'WRITE_OUTCOME_UNCERTAIN', {writes: () => f.writes.length - 1});
  } finally {
    f.store.close();
  }
});

test('a throttle of a read, and of a write that was never sent, keep the remedy they had', () => {
  const throttle = details => new MirrorError('PLATFORM_RATE_LIMIT', 'Platform returned HTTP 429', details, 429, false);
  // A read: no review, no status call to read.
  assert.equal(errorRemedy(throttle({http_status: 429, retry_after_ms: 60000, upstream: {}})).action, old);
  // A write refused before it was sent (the cooldown was already open): the same review may run again, as it said.
  assert.equal(
    errorRemedy(throttle({retry_after_ms: 30000, submission: 'not_sent', review_id: 'r', upstream: {}})).action,
    old,
  );
  // Nothing else about a throttle changed: category, owner and retry safety.
  const kept = errorRemedy(throttle({retry_after_ms: 30000, upstream: {}}));
  assert.equal(kept.category, 'provider');
  assert.equal(kept.owner, 'provider_or_account_admin');
  assert.equal(kept.mutation_retry_safe, false);
  // Another code of a dispatched write is not rewritten by this rule.
  const uncertain = new MirrorError(
    'UPSTREAM_ERROR',
    'Platform returned HTTP 502',
    {next_call: {tool: 'amcp_write', arguments: {action: 'status', review_id: 'r'}}, upstream: {}},
    502,
    true,
  );
  assert.doesNotMatch(errorRemedy(uncertain).action, /supersedes_review_id/);
});

test('the sequence has its Arabic, keeping every native name', () => {
  assert.deepEqual(localeProblems(catalog, [sequence]), []);
  assert.match(catalog[sequence], /[؀-ۿ]/u);
  for (const token of new Set(sequence.match(/\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g) ?? []))
    assert.ok(catalog[sequence].includes(token), 'keeps ' + token);
  assert.ok(catalog[old], 'the remedy of a read throttle keeps its Arabic');
});
