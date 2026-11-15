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
    // F-L1-06: the rules that no explicit set reaches, each with a code no set names.
    ['NEW_CODE', {}, 401, 'connection'],
    ['NEW_CODE', {}, 429, 'rate_limit'],
    ['SOMETHING_INVALID', {}, 400, 'request'],
    ['INVALID_THING', {}, 400, 'request'],
    ['SOMETHING_REQUIRED', {}, 400, 'request'],
    ['SOMETHING_UNSUPPORTED', {}, 400, 'request'],
    ['NEW_CODE', {}, 503, 'provider'],
    ['NEW_CODE', {}, 400, 'internal'],
    // The provider-error layer comes before the HTTP status.
    ['NEW_CODE', {layer: 'consent'}, 400, 'connection'],
    ['NEW_CODE', {layer: 'role_or_asset_access'}, 400, 'permission'],
    ['NEW_CODE', {layer: 'app_eligibility'}, 400, 'permission'],
    ['NEW_CODE', {layer: 'rate_limit'}, 400, 'rate_limit'],
    ['NEW_CODE', {layer: 'api_version'}, 400, 'provider'],
    ['NEW_CODE', {layer: 'credential'}, 403, 'connection'],
    ['NEW_CODE', {layer: 'unknown'}, 403, 'permission'],
    // F-L1-05: a generic provider code never hides the party the transport named.
    ['PLATFORM_ERROR', {http_status: 200, layer: 'credential'}, 401, 'connection'],
    ['PLATFORM_ERROR', {http_status: 200, layer: 'consent'}, 403, 'connection'],
    ['PLATFORM_ERROR', {http_status: 200, layer: 'rate_limit'}, 429, 'rate_limit'],
    ['UPSTREAM_ERROR', {http_status: 400, layer: 'role_or_asset_access'}, 400, 'permission'],
    ['PLATFORM_ERROR', {http_status: 200, layer: 'unknown'}, 502, 'provider'],
    ['PLATFORM_ERROR', {http_status: 200}, 502, 'provider'],
    // The generic provider codes stay provider failures with no status or HTTP status to say so.
    ['PLATFORM_ERROR', {}, 400, 'provider'],
    ['UPSTREAM_ERROR', {}, 400, 'provider'],
    ['PROVIDER_REPORT_FAILED', {}, undefined, 'provider'],
    ['UPSTREAM_ERROR', {http_status: 500, layer: 'api_version'}, 502, 'provider'],
  ])
    assert.equal(reportErrorCategory(code, details, status), category, code + ' ' + JSON.stringify(details));
});

test('every code of an explicit set keeps its category whatever the layer, status or HTTP status says', () => {
  const sets = {
    provider_data: [...providerDataCodes],
    connection: [
      'AUTH_EXPIRED',
      'REAUTHORIZATION_REQUIRED',
      'CREDENTIALS_REQUIRED',
      'TOKEN_REFRESH_FAILED',
      'CONNECTION_AUTHORITY_CHANGED',
    ],
    permission: [
      'INSUFFICIENT_SCOPE',
      'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
      'INSUFFICIENT_PERMISSION',
      'PROVIDER_PERMISSION_MISSING',
      'PROVIDER_ACCESS_DENIED',
    ],
    rate_limit: ['PLATFORM_RATE_LIMIT', 'CIRCUIT_OPEN'],
    request: [
      'REPORT_COLLECTION_LIMIT',
      'REPORT_ROW_LIMIT',
      'REPORT_LEVEL_UNSUPPORTED',
      'REPORT_CURRENCY_MISMATCH',
      'REPORT_TIMEZONE_MISMATCH',
      'INVALID_DATE_RANGE',
      'INCOMPLETE_REPORT',
    ],
    provider: ['PROVIDER_VERSION_UNSUPPORTED'],
    internal: ['INTERNAL_ERROR', 'REPORT_FAILED'],
  };
  for (const [category, codes] of Object.entries(sets))
    for (const code of codes)
      for (const [details, status] of [
        [{}, undefined],
        [{}, 400],
        [{layer: 'credential'}, 401],
        [{layer: 'rate_limit', http_status: 429}, 429],
        [{http_status: 500}, 503],
      ])
        assert.equal(reportErrorCategory(code, details, status), category, code + ' ' + JSON.stringify(details));
});

test('a layer that is not one of the closed set names no category, even a name every object inherits (F-L1-09)', () => {
  for (const layer of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'unknown', ''])
    assert.equal(reportErrorCategory('X', {layer}, 400), 'internal', JSON.stringify(layer));
  for (const layer of [7, null, {}, ['credential']])
    assert.equal(reportErrorCategory('X', {layer}, 400), 'internal', JSON.stringify(layer));
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

test('a provider-data diagnostic carries its page facts and its remedy, never an HTTP status', () => {
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
  // r25-hotfix (error 7): page_longer_than_size checks what one answer says, so TikTok's remedy says a retry returns the
  // same answer (src/tiktok-remedies.ts) where this test used to pin the shared retry action. A rule that may follow
  // TikTok's data moving (rows short of the total) keeps the retry action.
  assert.notEqual(d.next_action, providerDataAction);
  assert.match(d.next_action, /Retrying the same request returns the same answer/);
  const moving = reportSourceError(
    new MirrorError(
      'REPORT_INCOMPLETE',
      'm',
      {...details, page_facts: {...details.page_facts, rule: 'fewer_rows_than_declared'}},
      502,
    ),
    tiktok,
  );
  assert.equal(moving.next_action, providerDataAction);
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

test('a connection diagnostic keeps the provider’s HTTP status and its reconnect action', () => {
  const d = reportSourceError(new MirrorError('AUTH_EXPIRED', 'm', {http_status: 401}, 401), {
    ...tiktok,
    platform: 'meta',
  });
  assert.equal(d.category, 'connection');
  assert.equal(d.http_status, 401);
  assert.notEqual(d.next_action, providerDataAction);
  assert.match(d.next_action, /Reconnect/);
});

test('the HTTP status is the provider’s own 4xx or 5xx, never AMCP’s status or a 200 body (F-L1-05, F-L1-08)', () => {
  const meta = {...tiktok, platform: 'meta'},
    shown = (code, details, status) => reportSourceError(new MirrorError(code, 'm', details, status), meta).http_status;
  // The provider answered with an error status.
  for (const [code, details, status, expected] of [
    ['UPSTREAM_ERROR', {http_status: 503}, 503, 503],
    ['UPSTREAM_ERROR', {http_status: 400}, 502, 400],
    ['PLATFORM_RATE_LIMIT', {http_status: 429}, 429, 429],
    ['PROVIDER_ACCESS_DENIED', {http_status: 403}, 403, 403],
    ['AUTH_EXPIRED', {http_status: 401}, 401, 401],
    ['UPSTREAM_ERROR', {http_status: 599}, 502, 599],
    ['UPSTREAM_ERROR', {http_status: 400}, 502, 400],
  ])
    assert.equal(shown(code, details, status), expected, code + ' ' + JSON.stringify(details));
  // A 200 whose body reports a failure is not an HTTP failure, whatever status AMCP gave the error.
  for (const [code, details, status] of [
    ['PLATFORM_ERROR', {http_status: 200}, 502],
    ['PLATFORM_ERROR', {http_status: 200, layer: 'credential'}, 401],
    ['PLATFORM_ERROR', {http_status: 200, layer: 'rate_limit'}, 429],
    ['UPSTREAM_ERROR', {http_status: 204}, 502],
    ['UPSTREAM_ERROR', {http_status: 399}, 502],
    ['UPSTREAM_ERROR', {http_status: 600}, 502],
    ['UPSTREAM_ERROR', {http_status: '503'}, 503],
    ['UPSTREAM_ERROR', {http_status: null}, 503],
  ])
    assert.equal(shown(code, details, status), undefined, code + ' ' + JSON.stringify(details));
  // AMCP's own refusals carry the status AMCP gave them, which no provider returned.
  for (const [code, status] of [
    ['INVALID_DATE_RANGE', 400],
    ['REPORT_COLLECTION_LIMIT', 422],
    ['INCOMPLETE_REPORT', 400],
    ['AUTH_EXPIRED', 401],
    ['TOKEN_REFRESH_FAILED', 401],
    ['UPSTREAM_UNAVAILABLE', 502],
    ['DEADLINE_EXCEEDED', 504],
    ['REPORT_FAILED', 500],
  ])
    assert.equal('http_status' in reportSourceError(new MirrorError(code, 'm', {}, status), meta), false, code);
});

test('a credential failure the provider reports inside a 200 body is a connection failure with the reconnect action (F-L1-05)', () => {
  // The transport marks the layer when the provider's own table names it, and gives such an in-body failure status 401.
  const upstream = {code: 40105, message: 'Access token is invalid or expired', request_id: 'synthetic'},
    d = reportSourceError(
      new MirrorError(
        'PLATFORM_ERROR',
        'Platform reported an unsuccessful result.',
        {http_status: 200, layer: 'credential', provider_code: 40105, upstream},
        401,
      ),
      tiktok,
    );
  assert.equal(d.category, 'connection');
  assert.equal('http_status' in d, false);
  assert.equal(d.layer, 'credential');
  assert.equal(d.provider.code, '40105');
  assert.match(d.next_action, /Reconnect the affected login in Connections/);
  // A failure whose party nothing names stays a provider failure, still without an HTTP label.
  const unknown = reportSourceError(
    new MirrorError(
      'PLATFORM_ERROR',
      'Platform reported an unsuccessful result.',
      {
        http_status: 200,
        layer: 'unknown',
        provider_code: 40002,
        upstream: {code: 40002, message: 'Unsupported metric'},
      },
      502,
    ),
    tiktok,
  );
  assert.equal(unknown.category, 'provider');
  assert.equal('http_status' in unknown, false);
  assert.equal(unknown.provider.code, '40002');
});

test('a TikTok access denial inside a 200 body is a permission failure that points at the account’s access', () => {
  // TikTok's table gives 40001 and 40119 the role layer and 40118 the eligibility layer; the transport answers an
  // in-body failure of those layers with status 502, so the action follows the code, not an HTTP 403.
  for (const [layer, providerCode] of [
    ['role_or_asset_access', 40119],
    ['app_eligibility', 40118],
  ]) {
    const d = reportSourceError(
      new MirrorError(
        'PROVIDER_ACCESS_DENIED',
        'Platform reported an unsuccessful result.',
        {http_status: 200, layer, provider_code: providerCode, upstream: {code: providerCode, message: 'Denied'}},
        502,
      ),
      tiktok,
    );
    assert.equal(d.category, 'permission', layer);
    assert.equal('http_status' in d, false, layer);
    assert.equal(d.layer, layer);
    assert.match(d.next_action, /account permissions and provider app\/API access/, layer);
  }
});

test('the diagnostic fields a website source card reads keep their names (F-L1-05, F-L1-08, F-L1-11)', () => {
  const diagnostic = (code, details, status) => reportSourceError(new MirrorError(code, 'm', details, status), tiktok),
    base = ['account_id', 'category', 'code', 'connection_id', 'message', 'next_action', 'platform', 'retryable'];
  for (const [label, d, extra, category] of [
    [
      'a provider-data refusal',
      diagnostic('REPORT_INCOMPLETE', {page_facts: {rule: 'x'}, declared_rows: 2, returned_rows: 1}, 502),
      ['declared_rows', 'page_facts', 'returned_rows'],
      'provider_data',
    ],
    ['a replaced login', diagnostic('CONNECTION_AUTHORITY_CHANGED', {}, 409), [], 'connection'],
    [
      'a provider HTTP error',
      diagnostic('UPSTREAM_ERROR', {http_status: 503, layer: 'unknown', upstream: {message: 'down'}}, 502),
      ['http_status', 'layer', 'provider'],
      'provider',
    ],
  ]) {
    assert.deepEqual(Object.keys(d).sort(), [...base, ...extra].sort(), label);
    assert.equal(d.category, category, label);
  }
  // The card for a replaced login offers Retry on this code (web-report), so the action keeps saying to retry.
  assert.match(
    diagnostic('CONNECTION_AUTHORITY_CHANGED', {}, 409).next_action,
    /Retry the report with the current login/,
  );
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
