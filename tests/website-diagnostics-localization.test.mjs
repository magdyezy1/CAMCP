import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inspectWebsiteFailures, localeProblems, websiteFailureSources} from '../tools/check-locales.mjs';
import {MirrorError, errorResult} from '../dist/src/errors.js';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
// ARC-01 phase B, the server discovery configurations: each provider's discovery step left server/asset-discovery.ts
// for its website login module (src/<provider>-login.ts), and Google Ads' hierarchy discovery left
// server/google-account-discovery.ts (now its re-export) for src/google-account-discovery.ts. Their 37 reasons moved with
// them out of this inventory into the backend one (tests/backend-contract-localization.test.mjs, whose owned reasons
// are unchanged): the stage keeps 20, its own, and the total below fell from 259 to 222.
const counts = {
  'server/account-routes.ts': 4,
  'server/account-security.ts': 45,
  'server/asset-discovery.ts': 20,
  'server/google-account-discovery.ts': 0,
  'server/google-reauthorization.ts': 12,
  'server/http-app.ts': 6,
  'server/media-source-routes.ts': 5,
  'server/password-hashes.ts': 1,
  'server/platform-oauth.ts': 24,
  'server/social-signin.ts': 21,
  'server/user-accounts.ts': 32,
  'server/web-store.ts': 14,
  // ARC-04 stage D split createWebsite (server/website.ts, which held 45 reasons) into route modules registered in
  // order; each reason moved with its route, so the same 45 are owned and the total below is unchanged.
  'server/website.ts': 0,
  'server/access-routes.ts': 6,
  'server/activity-routes.ts': 0,
  'server/connection-routes.ts': 18,
  'server/mcp-consent-routes.ts': 3,
  'server/mcp-token-routes.ts': 0,
  'server/page-routes.ts': 0,
  'server/platform-routes.ts': 5,
  'server/report-download-routes.ts': 4,
  'server/session-routes.ts': 2,
  'server/website-connections.ts': 1,
  'server/website-gates.ts': 2,
  'server/workspace-routes.ts': 4,
};
const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
const owned = new Set(
  Object.keys(counts).flatMap(file => [...inspectWebsiteFailures(fs.readFileSync(file, 'utf8'), file)]),
);
test('website diagnostic ownership resolves the imported constructor and excludes lexical shadows and native positions', () => {
  const source = [
    "import {MirrorError as OwnedError} from '../src/errors.js';",
    "new OwnedError('CODE','Owned account sentence.');",
    "new OwnedError(native.code,'Owned permission sentence.');",
    "new OwnedError('CODE',native.message??'Native fallback.');",
    "new native.OwnedError('CODE','Native property constructor.');",
    "const payload={message:'Native payload.',type:'urn:li:adAccount:9007199254740993'};",
    "function shadow(OwnedError){new OwnedError('CODE','Shadowed parameter.');}",
    "function local(){const OwnedError=native.Error;new OwnedError('CODE','Shadowed local.');}",
    "function unpack({OwnedError}){new OwnedError('CODE','Destructured parameter.');}",
    "try{}catch(OwnedError){new OwnedError('CODE','Shadowed catch.');}",
    "for(let OwnedError of native.values){new OwnedError('CODE','Shadowed loop.');}",
    "const value=class OwnedError{run(){new OwnedError('CODE','Named class expression.');}};",
  ].join('\n');
  const expected = ['Owned account sentence.', 'Owned permission sentence.'];
  for (const file of ['server/website.ts', 'server\\website.ts'])
    assert.deepEqual([...inspectWebsiteFailures(source, file)], expected);
});
test('website diagnostic ownership excludes unrelated source, unresolved constructors, type-only imports and dynamic copy', () => {
  for (const file of ['src/website.ts', 'tests/website.ts', 'server/other-website.ts'])
    assert.deepEqual(
      [
        ...inspectWebsiteFailures(
          "import {MirrorError} from '../src/errors.js';new MirrorError('CODE','Native source.');",
          file,
        ),
      ],
      [],
    );
  for (const source of [
    "new MirrorError('CODE','Unresolved constructor.');",
    "import {MirrorError} from './native-errors.js';new MirrorError('CODE','Wrong module.');",
    "import type {MirrorError} from '../src/errors.js';new MirrorError('CODE','Type-only import.');",
    "import {type MirrorError} from '../src/errors.js';new MirrorError('CODE','Type-only specifier.');",
    "import {MirrorError} from '../src/errors.js';new MirrorError('CODE',native.message);new MirrorError('CODE','Prefix '+native.field);",
  ])
    assert.deepEqual([...inspectWebsiteFailures(source, 'server/website.ts')], []);
});
test('all selected website sources have exact authored diagnostic coverage with native tokens and limits preserved', () => {
  // The inventory's own list (tools/check-locales.mjs) is the one these counts cover.
  assert.deepEqual(Object.keys(counts).sort(), [...websiteFailureSources].sort());
  for (const [file, count] of Object.entries(counts))
    assert.equal(inspectWebsiteFailures(fs.readFileSync(file, 'utf8'), file).size, count, file);
  assert.equal(owned.size, 222);
  assert.deepEqual(localeProblems(catalog, owned), []);
  for (const message of owned) {
    const translated = catalog[message];
    assert.match(translated, /[\u0600-\u06ff]/);
    assert.notEqual(translated, message);
    for (const quantity of new Set(message.match(/\b\d[\d,]*\b/g) ?? []))
      assert.ok(
        translated.includes(quantity) ||
          (message === 'Use a name between 1 and 80 characters.' &&
            quantity === '1' &&
            translated.includes('حرف واحد')),
        message,
      );
  }
  for (const [message, tokens] of [
    ['AMCP_REDDIT_USER_AGENT must not contain line breaks.', ['AMCP_REDDIT_USER_AGENT']],
    ['write_access must be a boolean.', ['write_access', 'boolean']],
    ['link must be a boolean.', ['link', 'boolean']],
    ['Choose an evidence workbook language: en or ar.', ['en', 'ar']],
    ['Choose reader or operator access.', ['reader', 'operator']],
    ['Send each part as application/octet-stream.', ['application/octet-stream']],
    [
      'Microsoft authorization must return offline access and a valid lifetime. Reconnect with offline_access.',
      ['offline_access'],
    ],
  ])
    for (const token of tokens) assert.ok(catalog[message].includes(token), 'Native token ' + token);
});
for (const locale of ['en', 'ar'])
  test(
    'actual ' +
      locale +
      ' formatter translates every selected website sentence and retains original authority and native data',
    () => {
      const f = accountWorkflowFixture(locale);
      for (const message of owned) {
        const result = errorResult(
            new MirrorError('WEBSITE_ORIGINAL_CODE', message, {
              native_id: '9007199254740993',
              account_urn: 'urn:li:adAccount:9007199254740993',
              currency: 'SAR',
              amount: '0012.34',
              native_name: 'Native <img> name',
            }),
            'original-account-reference',
            0,
          ),
          before = JSON.stringify(result);
        f.context.response = result;
        f.context.error = f.run('requestError(response)');
        const display = f.run('errorMessage(error)');
        assert.ok(display.includes(locale === 'ar' ? catalog[message] : message));
        assert.ok(display.includes('original-account-reference'));
        assert.equal(f.context.error.message, message);
        assert.equal(f.context.error.code, 'WEBSITE_ORIGINAL_CODE');
        assert.equal(f.context.error.details, result.error.details);
        assert.equal(result.error.remedy.mutation_retry_safe, false);
        assert.equal(JSON.stringify(result), before);
      }
      for (const message of [
        'Native dynamic diagnostic 00123',
        'UNKNOWN_PROVIDER_DIAGNOSTIC',
        '9007199254740993',
        'urn:li:adAccount:9007199254740993',
      ]) {
        assert.equal(Object.hasOwn(catalog, message), false);
        f.context.response = errorResult(new MirrorError('NATIVE_CODE', message), 'native-reference', 0);
        f.context.error = f.run('requestError(response)');
        assert.ok(f.run('errorMessage(error)').includes(message));
      }
    },
  );
test('a future exact owned website sentence fails the locale gate without selecting fallback text or data', () => {
  const source =
    "import {MirrorError} from '../src/errors.js';new MirrorError('CODE','Future owned website reason.');new MirrorError('CODE',native.message??'Future native fallback.');";
  assert.deepEqual(localeProblems(catalog, inspectWebsiteFailures(source, 'server/website.ts')), [
    'Missing Arabic message: Future owned website reason.',
  ]);
});
