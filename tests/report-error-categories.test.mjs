// V2-RPT-05 (wave 5 round 1, Task 1): every report error has one category, provider-data failures say so instead of
// borrowing an HTTP status, and the provider's own refusal details survive every hop (reports and previews).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MirrorError,
  errorRemedy,
  errorResult,
  nestedError,
  providerDataAction,
  providerDataCodes,
} from '../dist/src/errors.js';
import {reportErrorCategory, reportSourceError} from '../dist/src/report-errors.js';
import {AdPreviews} from '../dist/src/ad-previews.js';
import {Store} from '../dist/src/store.js';

const tiktok = {platform: 'tiktok', account_id: '1', connection_id: 'c'};

test('each report error code has one category, checked in a fixed order', () => {
  for (const [code, details, status, category] of [
    ['REPORT_INCOMPLETE', {}, 502, 'provider_data'],
    ['UNKNOWN_PAGINATION', {}, 502, 'provider_data'],
    ['AUTH_EXPIRED', {}, 401, 'connection'],
    ['CREDENTIALS_REQUIRED', {}, 400, 'connection'],
    ['NEW_CODE', {layer: 'credential'}, 400, 'connection'],
    ['INSUFFICIENT_SCOPE', {}, 403, 'permission'],
    ['NEW_CODE', {}, 403, 'permission'],
    ['PLATFORM_RATE_LIMIT', {}, 429, 'rate_limit'],
    ['INVALID_DATE_RANGE', {}, 400, 'request'],
    ['REPORT_ROW_LIMIT', {}, 400, 'request'],
    ['PROVIDER_VERSION_UNSUPPORTED', {}, 400, 'provider'],
    ['UPSTREAM_ERROR', {http_status: 500}, 502, 'provider'],
    ['NEW_CODE', {http_status: 400}, 400, 'provider'],
    ['INTERNAL_ERROR', {}, 500, 'internal'],
    ['REPORT_FAILED', {}, 400, 'internal'],
  ])
    assert.equal(reportErrorCategory(code, details, status), category, code);
});

test('the twelve provider-data codes exclude AMCP request limits', () => {
  assert.deepEqual([...providerDataCodes].sort(), [
    'DUPLICATE_CAMPAIGN_ROWS',
    'DUPLICATE_ENTITY_ROWS',
    'REPORT_ACCOUNT_MISMATCH',
    'REPORT_DATE_MISMATCH',
    'REPORT_DUPLICATE_ROWS',
    'REPORT_EMPTY_AMBIGUOUS',
    'REPORT_ID_MISSING',
    'REPORT_INCOMPLETE',
    'REPORT_METRIC_AMBIGUOUS',
    'REPORT_RESPONSE_INVALID',
    'REPORT_SHAPE_CHANGED',
    'UNKNOWN_PAGINATION',
  ]);
  assert.equal(reportErrorCategory('INCOMPLETE_REPORT', {}, 400), 'request');
});

test('a provider-data diagnostic carries its page facts and the retry action, never an HTTP status', () => {
  const facts = {
    page: 2,
    page_size: 1000,
    total_number: 1500,
    total_page: 2,
    list_length: 1200,
    rule: 'page_longer_than_size',
  };
  const details = {
    http_status: 400,
    page_facts: {...facts, spend: '9', nested: {page: 1}},
    declared_rows: 1500,
    returned_rows: 1300,
  };
  const d = reportSourceError(new MirrorError('REPORT_INCOMPLETE', 'm', details, 502), tiktok);
  assert.equal(d.category, 'provider_data');
  assert.equal('http_status' in d, false);
  assert.deepEqual(d.page_facts, facts);
  assert.equal(d.declared_rows, 1500);
  assert.equal(d.returned_rows, 1300);
  assert.equal(d.next_action, providerDataAction);
});

test('page facts keep only integer, null or string values, and counts only integers', () => {
  const details = {
    page_facts: {page: 1.5, page_size: null, total_number: '7', rule: {x: 1}},
    declared_rows: '9',
    returned_rows: 2.5,
  };
  const d = reportSourceError(new MirrorError('REPORT_INCOMPLETE', 'm', details, 502), tiktok);
  assert.deepEqual(d.page_facts, {page_size: null, total_number: '7'});
  assert.equal('declared_rows' in d, false);
  assert.equal('returned_rows' in d, false);
});

test('a connection diagnostic keeps its HTTP status and its reconnect action', () => {
  const d = reportSourceError(new MirrorError('AUTH_EXPIRED', 'm', {}, 401), {...tiktok, platform: 'meta'});
  assert.equal(d.category, 'connection');
  assert.equal(d.http_status, 401);
  assert.notEqual(d.next_action, providerDataAction);
  assert.match(d.next_action, /Reconnect/);
});

test('an unknown thrown value is an internal diagnostic', () => {
  const d = reportSourceError(new Error('boom'), {...tiktok, platform: 'meta'});
  assert.equal(d.code, 'REPORT_FAILED');
  assert.equal(d.category, 'internal');
});

test('nestedError keeps the allow-listed details, retryable and a provider-data status', () => {
  const fallback = {code: 'REPORT_FAILED', message: 'Provider report failed.'};
  const e = nestedError(
    {
      success: false,
      error: {
        code: 'REPORT_INCOMPLETE',
        message: 'm',
        retryable: true,
        details: {page_facts: {page: 1}, request_id: 'r-1', upstream: {message: 'x'}, secret: 's'},
      },
    },
    fallback,
  );
  assert.equal(e.code, 'REPORT_INCOMPLETE');
  assert.equal(e.status, 502);
  assert.equal(e.retryable, true);
  assert.deepEqual(Object.keys(e.details).sort(), ['page_facts', 'request_id', 'upstream']);
  const f = nestedError({success: false}, fallback);
  assert.equal(f.code, 'REPORT_FAILED');
  assert.equal(f.message, 'Provider report failed.');
  assert.equal(f.status, 400);
  assert.equal(f.retryable, false);
  const denied = {success: false, error: {code: 'UPSTREAM_ERROR', message: 'Denied.', details: {http_status: 403}}};
  assert.equal(nestedError(denied, fallback).status, 403);
  const odd = {success: false, error: {code: 'UPSTREAM_ERROR', message: 'Odd.', details: {http_status: 200}}};
  assert.equal(nestedError(odd, fallback).status, 400);
});

test('MCP keeps category report for provider-data codes and gives them the retry action', () => {
  for (const code of [
    'REPORT_INCOMPLETE',
    'REPORT_DUPLICATE_ROWS',
    'REPORT_EMPTY_AMBIGUOUS',
    'REPORT_ID_MISSING',
    'REPORT_METRIC_AMBIGUOUS',
  ]) {
    const r = errorRemedy(new MirrorError(code, 'm', {}, 502));
    assert.deepEqual([r.category, r.action, r.mutation_retry_safe], ['report', providerDataAction, false], code);
  }
  // F-L1-03: the other provider-data codes are named first by a broader rule (a mismatch, an unknown name, a duplicate),
  // which told an AI client to correct a request that was right. They keep the category that rule gives and are
  // retried like the rest, and no write is ever marked safe to retry.
  for (const [code, category] of [
    ['REPORT_DATE_MISMATCH', 'state'],
    ['REPORT_ACCOUNT_MISMATCH', 'state'],
    ['UNKNOWN_PAGINATION', 'request'],
    ['DUPLICATE_ENTITY_ROWS', 'request'],
    ['DUPLICATE_CAMPAIGN_ROWS', 'request'],
  ]) {
    const r = errorRemedy(new MirrorError(code, 'm', {}, 502));
    assert.deepEqual([r.category, r.action, r.mutation_retry_safe], [category, providerDataAction, false], code);
    const sent = errorResult(new MirrorError(code, 'm', {}, 502), 'request-1', 1).error;
    assert.equal(sent.remedy.action, providerDataAction, code);
    assert.equal(sent.next_action, providerDataAction, code);
    assert.equal(sent.category, category, code);
  }
  // A changed or invalid response shape keeps its own provider-shape advice, with its caution about a submitted write.
  for (const code of ['REPORT_SHAPE_CHANGED', 'REPORT_RESPONSE_INVALID']) {
    const p = errorRemedy(new MirrorError(code, 'm', {}, 502));
    assert.equal(p.category, 'provider', code);
    assert.notEqual(p.action, providerDataAction, code);
    assert.match(p.action, /submitted write/, code);
  }
  // Every provider-data code is one or the other: nothing is left telling the caller to correct its request.
  const own = new Set(['REPORT_SHAPE_CHANGED', 'REPORT_RESPONSE_INVALID']);
  for (const code of providerDataCodes)
    assert.equal(errorRemedy(new MirrorError(code, 'm', {}, 502)).action === providerDataAction, !own.has(code), code);
  // AMCP's own size limit is a different failure: the generic report family names its narrowing.
  assert.match(errorRemedy(new MirrorError('INCOMPLETE_REPORT', 'm')).action, /Narrow it/);
});

test('a preview error keeps the upstream detail', async t => {
  const actor = {tenantId: 't', userId: 'u', role: 'reader'},
    store = new Store(':memory:', Buffer.alloc(32, 14).toString('base64'));
  t.after(() => store.close());
  store.putConnection(
    {...actor, role: 'admin'},
    {
      id: 'aaaaaaaa-1111-4111-8111-000000000001',
      tenantId: 't',
      gateway: 'linkedin_native_action',
      accounts: ['7'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['r_ads'],
    },
    {accessToken: 'synthetic'},
  );
  const previews = new AdPreviews(async (tool, input) => {
    const action = input.action ?? input.arguments?.action;
    if (action === 'linkedin_rest_ad_accounts_ad_account_id_creatives_get')
      return {
        success: true,
        data: {data: {elements: [{id: 'urn:li:sponsoredCreative:1', name: 'C', intendedStatus: 'ACTIVE'}]}},
      };
    return {
      success: false,
      error: {
        code: 'UPSTREAM_ERROR',
        message: 'LinkedIn refused the preview.',
        details: {http_status: 400, request_id: 'abc', upstream: {message: 'Invalid account'}},
      },
    };
  }, store);
  const result = await previews.handle({platform: 'linkedin', account_id: '7'}, actor);
  const item = result.previews[0];
  assert.equal(item.error.code, 'UPSTREAM_ERROR');
  assert.equal(item.error.message, 'LinkedIn refused the preview.');
  assert.equal(item.error.category, 'provider');
  assert.equal(item.error.http_status, 400);
  assert.equal(item.error.provider.message, 'Invalid account');
  assert.equal(item.error.provider.request_id, 'abc');
  assert.equal(item.error.platform, 'linkedin');
  assert.equal(item.error.account_id, '7');
});
