import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inspectCoreContractFailures, localeProblems} from '../tools/check-locales.mjs';
import {Registry} from '../dist/src/catalog.js';
import {MirrorError, errorResult} from '../dist/src/errors.js';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';

const counts = {
  // ARC-01 phase B (wave 4c, the catalog registry): Microsoft's help argument and unknown operation refusals moved with
  // its help to src/microsoft-adapter.ts, unchanged; tests/backend-contract-localization.test.mjs keeps their Arabic.
  'src/catalog.ts': 5,
  // ARC-04 stage F moved the X and Microsoft report retrievals and the X and TikTok job-read checks from
  // MirrorService to their report jobs (src/x-report-download.ts, src/microsoft-report-download.ts,
  // src/tiktok-report-jobs.ts): their 14 reasons moved with them, unchanged, and stay owned, with the same Arabic, by
  // the backend contract inventory (tests/backend-contract-localization.test.mjs). ARC-01 phase B (wave 4c) moves
  // the three refusals of the native read's provider steps (X's audience estimate and its status, Google's draft
  // generation) with those steps to src/provider-workflows.ts, unchanged, which that inventory owns too.
  // Package mcp-surface (V2-MCP-06) adds the MEDIA_REVIEW_REQUIRED refusal of nativeUpload, which a native upload answers
  // under the v2 contract profile (its Arabic is in web/locales/ar.json): 14.
  'src/service.ts': 14,
  // ARC-02's reserved workspace ID refusal and reviewer connectors' administrator-access refusal.
  'src/store.ts': 90,
  // ARC-01 phase B's wire profile moves six refusals that name a provider's own headers to that provider's adapter
  // (Reddit's User-Agent, Microsoft's developer token and account, Amazon's client ID, Google Ads' login customer) and
  // X's OAuth 1.0a credentials to src/oauth1.ts; tests/backend-contract-localization.test.mjs keeps their Arabic.
  // Package r25-m0-errors (G9) adds the two templates a provider refusal uses when its provider's own error tokens are
  // known ("Platform returned HTTP {status}: {refusal}." and "Platform reported an unsuccessful result: {refusal}."):
  // 36 + 2, each with its Arabic in web/locales/ar.json.
  'src/transport.ts': 38,
  // ARC-01 phase B (wave 4c, the delegated compiler): the ten refusals of GA4's property scope, Business Profile's
  // location scope and read mask, and Reddit's report window and fields moved with their rules to those providers'
  // adapters, unchanged; tests/backend-contract-localization.test.mjs keeps their Arabic.
  'src/delegated-native.ts': 27,
  'src/workflows.ts': 52,
};
const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
const owned = new Set(
  Object.keys(counts).flatMap(file => [...inspectCoreContractFailures(fs.readFileSync(file, 'utf8'), file)]),
);

test('core diagnostic ownership resolves runtime imports and excludes lexical shadows, fallback copy and native fields', () => {
  const source = [
    "import {MirrorError as Owned} from './errors.js';",
    "new Owned('CODE','Authored core reason.');",
    "new Owned(native.code,'Authored response reason.');",
    "new Owned('CODE',native.message??'Native fallback.');",
    "new native.Owned('CODE','Unresolved member.');",
    "const response={message:'Native data.',name:'Original campaign'};",
    "function f(Owned){new Owned('CODE','Parameter shadow.');}",
    "function local(){const Owned=native.Error;new Owned('CODE','Local shadow.');}",
    "function unpack({Owned}){new Owned('CODE','Destructured shadow.');}",
    "try{}catch(Owned){new Owned('CODE','Catch shadow.');}",
    "for(let Owned of native.values){new Owned('CODE','Loop shadow.');}",
    "const value=class Owned{run(){new Owned('CODE','Named class shadow.');}};",
  ].join('\n');
  for (const file of ['src/transport.ts', 'src\\transport.ts'])
    assert.deepEqual(
      [...inspectCoreContractFailures(source, file)],
      ['Authored core reason.', 'Authored response reason.'],
    );
  for (const file of ['server/transport.ts', 'tests/transport.ts', 'src/other.ts'])
    assert.deepEqual([...inspectCoreContractFailures(source, file)], []);
  for (const source of [
    "new MirrorError('CODE','Unresolved.');",
    "import {MirrorError} from './native-errors.js';new MirrorError('CODE','Wrong module.');",
    "import type {MirrorError} from './errors.js';new MirrorError('CODE','Type import.');",
    "import {type MirrorError} from './errors.js';new MirrorError('CODE','Type specifier.');",
    "import {MirrorError} from './errors.js';new MirrorError('CODE','Prefix '+native.field);",
  ])
    assert.deepEqual([...inspectCoreContractFailures(source, 'src/transport.ts')], []);
});

test('all six selected core sources require every authored reason with native field names, limits and protocol tokens intact', () => {
  for (const [file, count] of Object.entries(counts))
    assert.equal(inspectCoreContractFailures(fs.readFileSync(file, 'utf8'), file).size, count, file);
  // Package mcp-surface (V2-MCP-06) adds the MEDIA_REVIEW_REQUIRED sentence of src/service.ts, owned by no other source: 223 + 1.
  // Package r25-m0-errors (G9) adds the two src/transport.ts templates, owned by no other source: 224 + 2.
  assert.equal(owned.size, 226);
  assert.deepEqual(localeProblems(catalog, owned), []);
  for (const message of owned) {
    const translated = catalog[message];
    assert.match(translated, /[\u0600-\u06ff]/);
    assert.notEqual(translated, message);
    for (const token of new Set(message.match(/\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g) ?? []))
      assert.ok(translated.includes(token), 'Native field ' + token);
    for (const quantity of new Set(message.match(/\b\d[\d,]*(?:\.\d+)?\b/g) ?? []))
      assert.ok(translated.includes(quantity), 'Original bound ' + quantity);
  }
  for (const [message, tokens] of [
    ['Unknown Microsoft operation. Use LIST_ACTIONS.', ['LIST_ACTIONS']],
    ['Choose an explicit nonempty readMask for this resource.', ['readMask']],
    ['Configure a descriptive Reddit application userAgent on the connection.', ['Reddit', 'userAgent']],
    ['Use amcp_write prepare and execute for a reviewed mutation.', ['amcp_write', 'prepare', 'execute']],
    ['Server parsing supports Csv and Tsv. Submit another report in one of those formats.', ['Csv', 'Tsv']],
    ['Google ad mutations require entity_id as adGroupId~adId.', ['entity_id', 'adGroupId~adId']],
    ['Use valid calendar dates in YYYY-MM-DD format.', ['YYYY-MM-DD']],
    ['Supply a complete HTTP(S) URL or sc-domain property.', ['HTTP(S)', 'sc-domain']],
    ['Use the exact numeric location ID or locations/{id}.', ['locations/{id}']],
    ['Use the exact numeric account ID or accounts/{id}.', ['accounts/{id}']],
    ['X Ads requires consumer and user OAuth 1.0a credentials.', ['X Ads', 'OAuth', '1.0a']],
    ['LinkedIn status and intendedStatus disagree.', ['status', 'intendedStatus']],
  ])
    for (const token of tokens) assert.ok(catalog[message].includes(token), 'Original token ' + token);
});

for (const locale of ['en', 'ar'])
  test(
    'actual ' +
      locale +
      ' core formatter retains codes, uncertainty, native money/IDs and reference for all selected reasons',
    () => {
      const f = accountWorkflowFixture(locale);
      for (const message of owned) {
        const result = errorResult(
            new MirrorError(
              'CORE_ORIGINAL_CODE',
              message,
              {
                native_id: '9007199254740993',
                account_urn: 'urn:li:adAccount:9007199254740993',
                currency_code: 'SAR',
                daily_budget: '0012.3400',
                native_name: 'Original <img> campaign',
                omitted_field: undefined,
              },
              409,
              false,
            ),
            'original-core-reference',
            0,
          ),
          before = JSON.stringify(result);
        f.context.response = result;
        f.context.error = f.run('requestError(response)');
        assert.ok(f.run('errorMessage(error)').includes(locale === 'ar' ? catalog[message] : message));
        assert.ok(f.run('errorMessage(error)').includes('original-core-reference'));
        assert.equal(f.context.error.code, 'CORE_ORIGINAL_CODE');
        assert.equal(f.context.error.message, message);
        assert.equal(f.context.error.details, result.error.details);
        assert.equal(result.error.retryable, false);
        assert.equal(result.error.remedy.mutation_retry_safe, false);
        assert.equal(JSON.stringify(result), before);
      }
      for (const message of [
        'Unknown native diagnostic 00123',
        '9007199254740993',
        'urn:li:adAccount:9007199254740993',
      ]) {
        assert.equal(Object.hasOwn(catalog, message), false);
        f.context.response = errorResult(new MirrorError('NATIVE_UNCHANGED', message), 'native-reference', 0);
        f.context.error = f.run('requestError(response)');
        assert.ok(f.run('errorMessage(error)').includes(message));
      }
    },
  );

test('actual original Registry unknown-gateway refusal keeps its backend code and bilingual reference without execution authority', () => {
  const registry = new Registry();
  let failure;
  try {
    registry.help({gateway: 'unconfigured-synthetic-gateway'}, {});
  } catch (e) {
    failure = e;
  }
  assert.ok(failure instanceof MirrorError);
  assert.equal(failure.code, 'UNKNOWN_GATEWAY');
  assert.equal(failure.message, 'Unknown gateway.');
  const result = errorResult(failure, 'original-registry-reference', 0),
    before = JSON.stringify(result);
  for (const locale of ['en', 'ar']) {
    const f = accountWorkflowFixture(locale);
    f.context.response = result;
    f.context.error = f.run('requestError(response)');
    assert.ok(f.run('errorMessage(error)').includes(locale === 'ar' ? catalog[failure.message] : failure.message));
    assert.ok(f.run('errorMessage(error)').includes('original-registry-reference'));
  }
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'UNKNOWN_GATEWAY');
  assert.equal(result.error.remedy.mutation_retry_safe, false);
  assert.equal(JSON.stringify(result), before);
});

test('future static core copy fails locale coverage while unresolved and dynamic native messages remain outside ownership', () => {
  const source =
    "import {MirrorError} from './errors.js';new MirrorError('CODE','Future authored contract reason.');new MirrorError('CODE',native.message??'Future native fallback.');";
  assert.deepEqual(localeProblems(catalog, inspectCoreContractFailures(source, 'src/service.ts')), [
    'Missing Arabic message: Future authored contract reason.',
  ]);
});
