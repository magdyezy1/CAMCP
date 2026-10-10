// PRV-04: lifecycle was governed per gateway default, so dated provider changes inside a version (withdrawn DV360
// exclusions, Reddit's 2026-12-08 breakdown rules, the sunset Google developer token) were found by users as provider
// failures. These tests pin the dated table, its cited refusals, the values it leaves accepted and the startup warning.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  assertDeprecationRegistry,
  deprecatedDV360ContentRatingTiers,
  deprecatedDV360SensitiveCategories,
  deprecationStatus,
  providerDeprecation,
  providerDeprecations,
  setDeprecationClock,
} from '../src/provider-deprecations.js';
import {assertDV360Targeting} from '../src/dv360-line-item-targeting.js';
import {
  assertRedditReportRules,
  redditBreakdownProblems,
  redditReportWarning,
  savedRedditReportProblems,
} from '../src/reddit-report-rules.js';
import {DelegatedNativeCompiler} from '../src/delegated-native.js';
import {Store} from '../src/store.js';
import {reportingBootstrap} from '../src/report-query-access.js';
import {googleDeveloperTokenWarning} from '../src/google-version.js';
import type {CompiledRequest, JsonObject} from '../src/types.js';

const at = (day: string) => Date.parse(day + 'T00:00:00Z');
const code = (fn: () => unknown) => {
  try {
    fn();
    return 'accepted';
  } catch (e) {
    return (e as {code?: string}).code ?? String(e);
  }
};

test('every dated deprecation is cited, dated, unique and keeps its surviving values out of the refused set', () => {
  assertDeprecationRegistry();
  for (const entry of providerDeprecations) {
    assert.match(entry.source_url, /^https:\/\//, entry.id);
    assert.ok(entry.enforcement.length > 0, entry.id);
  }
  const first = providerDeprecations[0]!;
  assert.throws(() => assertDeprecationRegistry([first, first]), /recorded twice/);
  assert.throws(() => assertDeprecationRegistry([{...first, effective_date: '2026-13-40x'}]), /malformed/);
  assert.throws(() => assertDeprecationRegistry([{...first, source_url: 'http://example.test'}]), /https/);
  assert.throws(
    () => assertDeprecationRegistry([{...first, values: ['A'], surviving: ['A']}]),
    /surviving value is also deprecated/,
  );
});

test('a deprecation raises an alarm while it is 90 days away or less, and is marked effective from its day', () => {
  const byId = (day: string) => Object.fromEntries(deprecationStatus(at(day)).map(d => [d.id, d]));
  const reddit = 'reddit_report_breakdowns_2026_12';
  assert.deepEqual([byId('2026-09-08')[reddit]!.days_until_effective, byId('2026-09-08')[reddit]!.alarm], [91, false]);
  assert.deepEqual([byId('2026-09-09')[reddit]!.days_until_effective, byId('2026-09-09')[reddit]!.alarm], [90, true]);
  assert.deepEqual([byId('2026-12-08')[reddit]!.effective, byId('2026-12-08')[reddit]!.alarm], [true, false]);
  assert.equal(byId('2026-10-09').x_v5_recommendations!.effective, true);
});

const dv360Plan = (path: string, body: JsonObject): CompiledRequest =>
  ({
    gateway: 'dv360_native_action',
    accountId: '123',
    action: 'synthetic',
    method: 'POST',
    path,
    query: {},
    headers: {},
    body,
    readOnly: false,
    destructive: false,
    requiresConfirmation: true,
    evidence: '',
    warnings: [],
  }) as unknown as CompiledRequest;
const lineItemEdit = (type: string, details: JsonObject) =>
  dv360Plan('/v4/advertisers/123/lineItems:bulkEditAssignedTargetingOptions', {
    lineItemIds: ['456'],
    createRequests: [{targetingType: type, assignedTargetingOptions: [details]}],
  });
const advertiserEdit = (type: string, details: JsonObject) =>
  dv360Plan('/v4/advertisers/123:editAssignedTargetingOptions', {
    createRequests: [{targetingType: type, assignedTargetingOptions: [details]}],
  });
const sensitive = (value: string) => ({sensitiveCategoryExclusionDetails: {excludedSensitiveCategory: value}});
const rating = (value: string) => ({digitalContentLabelExclusionDetails: {excludedContentRatingTier: value}});
const SENSITIVE = 'TARGETING_TYPE_SENSITIVE_CATEGORY_EXCLUSION',
  RATING = 'TARGETING_TYPE_DIGITAL_CONTENT_LABEL_EXCLUSION';

test('from 2026-10-01 withdrawn DV360 line item exclusions are refused with a cited code; the surviving values pass', t => {
  t.after(() => setDeprecationClock());
  setDeprecationClock(() => at('2026-10-01'));
  for (const value of ['SENSITIVE_CATEGORY_ADULT', 'SENSITIVE_CATEGORY_GAMBLING', 'SENSITIVE_CATEGORY_SHOCKING'])
    assert.equal(
      code(() => assertDV360Targeting(lineItemEdit(SENSITIVE, sensitive(value)))),
      'PROVIDER_DEPRECATED',
    );
  for (const value of ['CONTENT_RATING_TIER_MATURE', 'CONTENT_RATING_TIER_GENERAL'])
    assert.equal(
      code(() => assertDV360Targeting(lineItemEdit(RATING, rating(value)))),
      'PROVIDER_DEPRECATED',
    );
  try {
    assertDV360Targeting(lineItemEdit(SENSITIVE, sensitive('SENSITIVE_CATEGORY_ADULT')));
  } catch (e) {
    const details = (e as {details: JsonObject}).details;
    assert.equal(details.deprecation, 'dv360_line_item_sensitive_category_exclusions');
    assert.equal(details.effective_date, '2026-10-01');
    assert.deepEqual(details.values, ['SENSITIVE_CATEGORY_ADULT']);
    assert.match(String(details.source), /^https:\/\/developers\.google\.com\/display-video\//);
  }
  // The values the provider keeps accepting are never blocked by a too-strict entry.
  for (const value of providerDeprecation('dv360_line_item_sensitive_category_exclusions').surviving!)
    assert.equal(
      code(() => assertDV360Targeting(lineItemEdit(SENSITIVE, sensitive(value)))),
      'accepted',
      value,
    );
  for (const value of providerDeprecation('dv360_line_item_content_rating_exclusions').surviving!)
    assert.equal(
      code(() => assertDV360Targeting(lineItemEdit(RATING, rating(value)))),
      'accepted',
      value,
    );
  // Advertiser-level targeting stays provider-checked.
  assert.equal(
    code(() => assertDV360Targeting(advertiserEdit(SENSITIVE, sensitive('SENSITIVE_CATEGORY_ADULT')))),
    'accepted',
  );
  // The day before, the review does not refuse early.
  setDeprecationClock(() => at('2026-09-30'));
  assert.equal(
    code(() => assertDV360Targeting(lineItemEdit(SENSITIVE, sensitive('SENSITIVE_CATEGORY_ADULT')))),
    'accepted',
  );
});

test('the DV360 deprecation lists equal what the pinned Discovery document stops accepting', () => {
  const schemas = JSON.parse(fs.readFileSync('.mirror/VENDOR/dv360-v4.json', 'utf8')).document.schemas;
  const field = (schema: string, name: string) => schemas[schema].properties[name];
  const categories = field('SensitiveCategoryAssignedTargetingOptionDetails', 'excludedSensitiveCategory'),
    tiers = field('DigitalContentLabelAssignedTargetingOptionDetails', 'excludedContentRatingTier');
  assert.match(categories.description, /October 1, 2026.*SENSITIVE_CATEGORY_EMBEDDED_VIDEO.*LIVE_STREAMING_VIDEO/s);
  assert.match(tiers.description, /October 1, 2026.*only accept the value `CONTENT_RATING_TIER_UNRATED`/s);
  const surviving = (id: string) => providerDeprecation(id).surviving!;
  // Every enum value other than UNSPECIFIED and the survivors is in the refused list, and nothing else is.
  assert.deepEqual(
    [...deprecatedDV360SensitiveCategories].sort(),
    categories.enum
      .filter(
        (v: string) =>
          v !== 'SENSITIVE_CATEGORY_UNSPECIFIED' &&
          !surviving('dv360_line_item_sensitive_category_exclusions').includes(v),
      )
      .sort(),
  );
  assert.equal(deprecatedDV360SensitiveCategories.length, 17);
  assert.deepEqual(
    [...deprecatedDV360ContentRatingTiers].sort(),
    tiers.enum.filter((v: string) => !surviving('dv360_line_item_content_rating_exclusions').includes(v)).sort(),
  );
});

const redditReport = (data: JsonObject) => ({
  operation: 'reddit_reporting_ops',
  arguments: {
    action: 'GET_INSIGHTS',
    account_id: 'a2_111',
    payload: {
      data: {
        starts_at: '2027-01-01T00:00:00Z',
        ends_at: '2027-01-02T00:00:00Z',
        fields: ['IMPRESSIONS'],
        breakdowns: ['DATE'],
        ...data,
      },
    },
  },
});

test('from 2026-12-08 Reddit reports that Reddit will answer with 400 are refused before any request', t => {
  t.after(() => setDeprecationClock());
  const eightDays = {starts_at: '2027-01-01T00:00:00Z', ends_at: '2027-01-09T00:00:00Z'},
    sevenDays = {starts_at: '2027-01-01T00:00:00Z', ends_at: '2027-01-08T00:00:00Z'};
  const cases: [string, JsonObject, string[]][] = [
    ['hourly over eight days', {...eightDays, breakdowns: ['HOUR']}, ['HOUR_RANGE_OVER_7_DAYS']],
    ['two audience breakdowns', {breakdowns: ['KEYWORD', 'INTEREST']}, ['MULTIPLE_AUDIENCE_BREAKDOWNS']],
    ['community with language', {breakdowns: ['COMMUNITY', 'LANGUAGE']}, ['MULTIPLE_AUDIENCE_BREAKDOWNS']],
    ['audience with country', {breakdowns: ['COMMUNITY', 'COUNTRY']}, ['AUDIENCE_WITH_LOCATION_OR_PLACEMENT']],
  ];
  const surviving: [string, JsonObject][] = [
    ['hourly over exactly seven days', {...sevenDays, breakdowns: ['HOUR']}],
    ['one audience breakdown with the date', {breakdowns: ['DATE', 'KEYWORD']}],
    ['location without an audience breakdown', {breakdowns: ['COUNTRY', 'DMA', 'OS_TYPE']}],
  ];
  const compiler = new DelegatedNativeCompiler();
  const compile = (data: JsonObject) => code(() => compiler.compile('reddit_native_action', redditReport(data)));
  for (const [label, data, problems] of cases) {
    assert.deepEqual(redditBreakdownProblems(redditReport(data).arguments.payload.data), problems, label);
    // Injected clock: the day before passes, the effective day refuses.
    assert.doesNotThrow(() => assertRedditReportRules(redditReport(data).arguments.payload.data, at('2026-12-07')));
    setDeprecationClock(() => at('2026-12-07'));
    assert.equal(compile(data), 'accepted', label);
    setDeprecationClock(() => at('2026-12-08'));
    assert.equal(compile(data), 'PROVIDER_DEPRECATED', label);
  }
  for (const [label, data] of surviving) assert.equal(compile(data), 'accepted', label);
  // The legacy SUBREDDIT name counts as COMMUNITY (the pinned schema already refuses it as a breakdown value).
  assert.deepEqual(redditBreakdownProblems({breakdowns: ['SUBREDDIT', 'KEYWORD']}), ['MULTIPLE_AUDIENCE_BREAKDOWNS']);
});

test('the reporting bootstrap lists a saved Reddit report and its schedule that the 2026-12-08 rules affect', () => {
  const actor = {tenantId: 'reddit-deprecation', userId: 'operator', role: 'operator' as const},
    connection = '00000000-0000-4000-8000-0000000000aa',
    book = '00000000-0000-4000-8000-0000000000bb',
    affected = '00000000-0000-4000-8000-0000000000c1',
    clean = '00000000-0000-4000-8000-0000000000c2',
    schedule = '00000000-0000-4000-8000-0000000000d1';
  const store = new Store(':memory:', Buffer.alloc(32, 41).toString('base64'));
  try {
    store.putConnection(
      {...actor, role: 'admin'},
      {
        id: connection,
        tenantId: actor.tenantId,
        gateway: 'reddit_native_action',
        accounts: ['a2_111'],
        enabled: true,
        label: 'Synthetic Reddit',
        scopes: ['adsread'],
        userAgent: 'server:amcp-test:0.1.0 (synthetic)',
      },
      {accessToken: 'synthetic'},
    );
    const saved = (data: JsonObject, encoded = false) => {
      const report = redditReport(data);
      const args: JsonObject = {...report.arguments, connection_id: connection};
      if (encoded) args.payload = JSON.stringify(args.payload);
      return {gateway: 'reddit_native_action', arguments: {operation: report.operation, arguments: args}};
    };
    store.putDocument(actor.tenantId, 'workbook', book, {spreadsheet_id: 'synthetic-book', created_by: actor.userId});
    store.putDocument(actor.tenantId, 'reporting_query', affected, {
      name: 'Hourly community',
      workbook_binding_id: book,
      query_config: saved({breakdowns: ['COMMUNITY', 'COUNTRY']}, true),
    });
    store.putDocument(actor.tenantId, 'reporting_query', clean, {
      name: 'Daily',
      workbook_binding_id: book,
      query_config: saved({breakdowns: ['DATE']}),
    });
    store.putDocument(actor.tenantId, 'reporting_schedule', schedule, {
      name: 'Weekly',
      workbook_binding_id: book,
      schedule_config: {query_id: affected, timezone: 'UTC', frequency: 'weekly'},
    });
    const out = reportingBootstrap(store, actor, {}) as JsonObject;
    assert.equal(out.queries.length, 2);
    assert.equal(out.provider_deprecation_warnings.length, 1);
    const [warning] = out.provider_deprecation_warnings;
    assert.equal(warning.query_id, affected);
    assert.deepEqual(warning.schedule_ids, [schedule]);
    assert.deepEqual(warning.problems, ['AUDIENCE_WITH_LOCATION_OR_PLACEMENT']);
    assert.equal(warning.effective_date, '2026-12-08');
    assert.match(warning.source, /^https:\/\/ads-api\.reddit\.com\//);
    assert.deepEqual(savedRedditReportProblems(saved({breakdowns: ['DATE']})), []);
    // Ahead of the day it warns; from the day it states the refusal.
    assert.equal(
      redditReportWarning(affected, warning.problems, [], at('2026-12-07')).code,
      'PROVIDER_DEPRECATION_AHEAD',
    );
    assert.equal(redditReportWarning(affected, warning.problems, [], at('2026-12-08')).code, 'PROVIDER_DEPRECATED');
  } finally {
    store.close();
  }
});

test('a configured Google developer token earns a startup warning and is never sent', () => {
  assert.equal(googleDeveloperTokenWarning({}), undefined);
  assert.match(googleDeveloperTokenWarning({AMCP_GOOGLE_DEVELOPER_TOKEN: 'synthetic'})!, /sunset developer tokens/);
  const runtime = new URL('../server/runtime.js', import.meta.url).href,
    script = `const {createRuntime}=await import(${JSON.stringify(runtime)});const r=createRuntime();r.store.close();`;
  const env: NodeJS.ProcessEnv = {...process.env, MIRROR_DB: ':memory:'};
  delete env.MIRROR_ALLOW_WRITES;
  const run = (extra: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: {...env, ...extra},
      encoding: 'utf8',
      timeout: 30000,
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
    });
  const warned = run({AMCP_GOOGLE_DEVELOPER_TOKEN: 'synthetic-legacy-token'});
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, /"event":"google_developer_token_ignored"/);
  assert.match(warned.stderr, /AMCP_GOOGLE_DEVELOPER_TOKEN is set, but Google sunset developer tokens/);
  assert.doesNotMatch(warned.stderr, /synthetic-legacy-token/);
  const quiet = run({AMCP_GOOGLE_DEVELOPER_TOKEN: ''});
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.doesNotMatch(quiet.stderr, /DEVELOPER_TOKEN/);
});
