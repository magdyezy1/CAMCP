import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {backendContractSourceFiles, inspectBackendContractFailures, localeProblems} from '../tools/check-locales.mjs';
import {MirrorError, errorResult} from '../dist/src/errors.js';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';

const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
const files = backendContractSourceFiles();
const selected = files.map(file => ({
  file,
  messages: inspectBackendContractFailures(fs.readFileSync(file, 'utf8'), file),
}));
const owned = new Set(selected.flatMap(row => [...row.messages]));

test('backend diagnostics resolve canonical runtime imports in new and nested sources with lexical ownership intact', () => {
  const source = [
    "import {MirrorError as Owned} from '../../src/errors.js';",
    "import {MirrorError as Other} from '../../src/./errors.js';",
    "new Owned('CODE', 'Future nested reason.');",
    "new Other(native.code, 'Another canonical import.');",
    "new Owned('CODE', 'Future nested reason.');",
    "new Owned('CODE', native.message ?? 'Native fallback.');",
    "new Owned('CODE', 'Dynamic ' + native.message);",
    "new native.Owned('CODE', 'Native member.');",
    "function parameter(Owned){new Owned('CODE','Parameter shadow.');}",
    "function local(){const Owned=native.Error;new Owned('CODE','Local shadow.');}",
    "function unpack({Owned}){new Owned('CODE','Destructured shadow.');}",
    "try{}catch(Owned){new Owned('CODE','Catch shadow.');}",
    "for(let Owned of native.values){new Owned('CODE','Loop shadow.');}",
    "const value=class Owned{run(){new Owned('CODE','Named class shadow.');}};",
    "const result={message:'Provider message.',name:'Native name'};",
  ].join('\n');
  for (const file of ['server/new/routes.ts', 'server\\new\\routes.ts'])
    assert.deepEqual(
      [...inspectBackendContractFailures(source, file)],
      ['Future nested reason.', 'Another canonical import.'],
    );
  for (const file of ['src/new-contract.ts', 'src\\new-contract.ts'])
    assert.deepEqual(
      [
        ...inspectBackendContractFailures(
          "import {MirrorError as Alias} from './errors.js';new Alias('CODE','New file reason.');",
          file,
        ),
      ],
      ['New file reason.'],
    );
});

test('backend ownership rejects paths outside source roots, type imports, unrelated errors, wrappers and dynamic native reasons', () => {
  const source = "import {MirrorError} from './errors.js';new MirrorError('CODE','Owned reason.');";
  for (const file of [
    undefined,
    null,
    1,
    'src/../server/file.ts',
    'src//file.ts',
    './src/file.ts',
    '/src/file.ts',
    'C:\\src\\file.ts',
    'tests/file.ts',
    'src/file.js',
    'src/./file.ts',
    'src/../../private.ts',
  ])
    assert.deepEqual([...inspectBackendContractFailures(source, file)], []);
  for (const source of [
    "new MirrorError('CODE','Unresolved.');",
    "import {MirrorError} from './native-errors.js';new MirrorError('CODE','Unrelated.');",
    "import {MirrorError} from 'native-errors';new MirrorError('CODE','External.');",
    "import type {MirrorError} from './errors.js';new MirrorError('CODE','Type import.');",
    "import {type MirrorError} from './errors.js';new MirrorError('CODE','Type specifier.');",
    "import {MirrorError} from './errors.js';bad('Wrapper sentence.');new MirrorError('CODE',native.message??'Fallback sentence.');",
    "import * as Errors from './errors.js';new Errors.MirrorError('CODE','Namespace member.');",
    "import MirrorError from './errors.js';new MirrorError('CODE','Default import.');",
  ])
    assert.deepEqual([...inspectBackendContractFailures(source, 'src/new-contract.ts')], []);
});

test('source discovery automatically includes future nested TypeScript files and refuses their missing Arabic before publication', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-backend-locale-'));
  const records = {
    'src/errors.ts': 'export class MirrorError extends Error {}',
    'src/future.ts':
      "import {MirrorError} from './errors.js';new MirrorError('CODE','Future undiscovered source reason.');",
    'src/models/row.ts': 'export type Row = {name:string};',
    'server/new/routes.ts':
      "import {MirrorError} from '../../src/errors.js';new MirrorError('CODE','Future nested server reason.');",
    'src/not-source.json': '{}',
    'tests/native.ts': "throw new Error('External test text.');",
  };
  try {
    for (const [file, source] of Object.entries(records)) {
      const target = path.join(temporary, file);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.writeFileSync(target, source);
    }
    const discovered = backendContractSourceFiles(temporary);
    assert.deepEqual(discovered, ['server/new/routes.ts', 'src/errors.ts', 'src/future.ts', 'src/models/row.ts']);
    const messages = new Set(
      discovered.flatMap(file => [
        ...inspectBackendContractFailures(fs.readFileSync(path.join(temporary, file), 'utf8'), file),
      ]),
    );
    assert.deepEqual(localeProblems(catalog, messages), [
      'Missing Arabic message: Future nested server reason.',
      'Missing Arabic message: Future undiscovered source reason.',
    ]);
  } finally {
    for (const file of Object.keys(records)) fs.unlinkSync(path.join(temporary, file));
    for (const directory of ['src/models', 'server/new', 'src', 'server', 'tests'])
      fs.rmdirSync(path.join(temporary, directory));
    fs.rmdirSync(temporary);
  }
});

test('all actual directly owned backend reasons have Arabic with original native fields and numeric limits preserved', () => {
  // Wave 3a sources, among them CMP-03's src/microsoft-campaign-criteria.ts and PRV-06 C's
  // src/meta-creative-features.ts (five reasons; the catalog also holds its two remedies), and the Performance Max
  // brief's short-description refusal.
  // RPT-07 and DEC-02 add the period comparison, native parent, dimension pack, LinkedIn window, Microsoft portfolio,
  // Meta allocation budget and allocation outcome modules.
  // MED-06, MSR-04 and PRV-07 add the media spec, GA4 test property, Google change history and search overlap modules
  // (the Apple and Reddit planning reads extend existing modules).
  // MSR-03 adds the Meta dataset scope and the measurement hub's ledger adapter modules.
  // COM-02 and COM-03 add the catalog destination, lineage, mapping, requirement, source, native request meter and Snapchat
  // catalog comparison and read modules; the review fixes add src/catalog-retirement.ts (a retirement of a missing product)
  // and the refusal of an unrecognized Reddit account history.
  // WEB-09 adds server/workspace-search.ts (its query refusal); WEB-03 and WEB-05 add website copy.
  // ACC-05 adds src/acceptance-ledger.ts, src/discovery-programs.ts and src/provider-access.ts (no owned reasons) and the
  // owner provider access panel's catalog entries. Owner decision P9 adds the Commerce reason a Meta product needs review.
  // CMP-03's Microsoft location lookup adds src/microsoft-locations.ts (seven owned reasons) and its website copy;
  // RPT-07's period comparison table adds its caption; MSR-03's TikTok pixel event statistics add their refusals and
  // website copy. ARC-02 adds the document-kind registry and the tenant-bound repository modules (27 files, no owned
  // reasons: the refusals stay where they were raised). The TikTok ledger's unpinned statistics request adds one
  // website reason, and the refusal of a reserved workspace ID (ensureTenant, INVALID_TENANT) one owned reason. The
  // invitation lifetime's one- and two-hour sentences add two website entries.
  // ARC-03 adds src/route-anchors.ts (no owned reasons) and the nine route evidence entries of the contract reference.
  // ARC-01 adds src/provider-adapter.ts and src/provider-adapters.ts (no owned reasons) and the parked-provider refusal
  // of src/provider-offering.ts with its remedy; P9's parked WooCommerce notice on Commerce adds one catalog entry.
  // ARC-04 stage B adds six leaf modules split from existing ones (account-id, review-state-core, tiktok-paths,
  // microsoft-association-contracts, meta-ad-library-contract, google-business-notification-kind); their reasons moved
  // with them, so the owned reasons and the catalog are unchanged. Stage E adds src/signed-cursor.ts and
  // src/portfolio-runner.ts (no owned reasons: the portfolio refusals stay in each adapter). Stage F adds the report
  // source contract, its registry and ten provider report sources; the Apple source owns the reason it took from
  // src/report-native.ts (one more file with reasons, the same reasons).
  // Stage C adds src/family-kit.ts; the family modules that import its fail keep their owned reasons. Stage D adds
  // src/tool-actions.ts (no owned reasons). Stage F's report jobs add src/report-job.ts and src/report-jobs.ts (no
  // owned reasons); the 14 reasons of the X and Microsoft report retrievals and of the X and TikTok job-read checks
  // moved with that code from src/service.ts to src/x-report-download.ts (one more file with reasons),
  // src/microsoft-report-download.ts and src/tiktok-report-jobs.ts, so the owned reasons are the same. Stage D's split
  // of createWebsite adds 14 server modules: twelve route and helper modules, the website's site contract and its
  // store-layer repository. The 45 reasons of server/website.ts moved with their routes into nine of them, so the
  // owned reasons are the same. Stage C's provider remedies add src/provider-remedies.ts and nine remedy tables (no
  // refusals: remedies are not reasons).
  // ARC-01 phase B adds the provider hooks registry and fifteen provider adapter modules (src/<provider>-adapter.ts):
  // LinkedIn's share-authorization reason moved with its check from src/provider-read-contracts.ts to
  // src/linkedin-adapter.ts, so the files with reasons and the reasons are unchanged. Its paging concern moves each
  // provider's paging refusals with its cursor rules from src/pagination.ts (which keeps its own) to the Apple, Meta,
  // Reddit, Snapchat and TikTok adapters: five more files with reasons, the same reasons. Its wire profile adds the
  // Adjust and Amazon adapters and two leaves split from existing modules (src/oauth1.ts, src/provider-error-core.ts);
  // the transport refusals that name a provider's headers moved with them to the Amazon, Google Ads and Microsoft
  // adapters, and X's OAuth 1.0a refusal to src/oauth1.ts: four more files with reasons, the same reasons. Its read
  // authorizers move each provider's part of ScopeGuard to its adapter, the Microsoft refusals among them (files that
  // already own reasons), and Snapchat's scoped paths to src/snapchat-scope.ts (no reasons). Its review projections
  // move Google's state-identity refusals from src/review-state.ts, which owns no other reason, to
  // src/google-ads-adapter.ts, which already owns reasons: one file with reasons fewer, the same reasons.
  // Exempt by design: the refusal of a request two read authorizers claim (READ_AUTHORIZER_CONFLICT, src/scope.ts)
  // names the claiming authorizers in its message, so it owns no reason here and has no Arabic, as the refusal of two
  // families claiming one route (REVIEWED_FAMILY_CONFLICT) has none: both are wiring defects, refused with status 500
  // before anything is sent and fixed in the code, which no user action resolves.
  // The design review of 2026-10 adds 24 website entries (WEB-03's outcome and refusal copy, WEB-05's Operations
  // guidance and Settings sentences, the metric aggregation words and the one-step plural); no owned reason changes.
  // Its review fixes add the other three reviewer sign-in sentences the server can return (server/web-store.ts) and
  // reword an uncertain write (one message added, the remedy replaced): 11,513 entries.
  // ARC-04 stage F (wave 4c) moves each platform's collection from src/report-native.ts into its report source, with
  // the refusals of its requests, and the shared collection helpers into the report source contract
  // (src/report-source.ts): files with reasons are added, the reasons are the same (the contract; then the LinkedIn
  // report source, with LinkedIn's account and currency refusals; the Microsoft one, with its report job refusals; the
  // Reddit one, with its detail-name refusal; the GA4 one, with its row-limit refusal). ARC-01 (reporting) moves the
  // report table every export uses from src/google-sheets.ts into src/report-table.ts with its three refusals: one
  // file more, with reasons, and the same reasons. ARC-04 stage F moves the Overview's levels and detailed rows from
  // src/overview-granularity.ts, which keeps no reason, into the leaf src/overview-levels.ts with their refusals: one
  // file more, as many files with reasons, the same reasons. Its guided reporting adds src/google-guided-reports.ts
  // and src/meta-guided-reports.ts: Meta's unrequested-breakdown refusal moves from src/report-breakdowns.ts, which
  // keeps no reason, to the Meta module, and the undocumented-value refusal to the report source contract (which owns
  // reasons): two files more, as many files with reasons. That refusal was raised through bad() and is now raised
  // directly by the contract, so this guard owns it: one owned reason more, the same message and Arabic. The guided
  // presets, their requests and row checks move from src/report-presets.ts into the platforms' guided reporting, adding
  // src/snapchat-guided-reports.ts, src/tiktok-guided-reports.ts and src/linkedin-guided-reports.ts: three files
  // more; their refusals are raised through bad(), as they were, so the reasons are the same. The allocation models'
  // evidence checks move from src/report-allocation.ts to src/snapchat-allocation-evidence.ts and
  // src/linkedin-allocation-evidence.ts, and its evidence date check to the leaf src/evidence-dates.ts (three files
  // more), all still raised through bad() and still authored allocation copy (tools/check-locales.mjs): the same reasons.
  // ARC-04 (wave 4c) splits campaignRecipe into per-recipe builders: src/recipe-steps.ts and the Meta, Google Search
  // and Microsoft Search recipe modules, whose reasons moved with their code from src/campaign-recipes.ts (which keeps
  // the catalog's own): four more files with reasons, the same reasons. ARC-01 (wave 4c) adds Reddit's page step, whose
  // five refusals moved with it from src/reddit-adapter.ts (src/reddit-paging.ts: one more file with reasons, the same
  // reasons), and Meta's first write-shape checks (src/meta-write-shape.ts, whose refusals this inventory never owned in
  // src/write-shape.ts either). Its review hooks move Snapchat's affected-ads read to the leaf
  // src/snapchat-affected-ad-pages.ts, whose one reason moved with it from src/snapchat-affected-ads.ts (which keeps its
  // signature): one more file, the same files with reasons and the same reasons. Its state reads move the Google Ads,
  // TikTok, Meta and Snapchat branches of src/write-snapshots.ts to four provider modules (src/google-state-reads.ts and
  // its three siblings), whose refusals this inventory never owned in src/write-snapshots.ts either: four more files.
  // Its disclosures move Snapchat's creative replacement check from src/write-impact.ts, which owns no other reason, to
  // src/snapchat-write-impact.ts with its four reasons: one more file, the same files with reasons and reasons.
  // Its campaign clones move each provider's clone builder from src/campaign-clone.ts to src/<provider>-campaign-clone.ts
  // and the shared source read to src/campaign-clone-core.ts, their reasons with their code: five more files, four of
  // them with reasons (src/campaign-clone.ts keeps the gateway and input refusals), and the same reasons. Its guided
  // activations move each platform's steps and gates from src/campaign-activation.ts to
  // src/<provider>-recipe-activation.ts and the shared result checks to src/campaign-activation-core.ts: seven more
  // files, the same files with reasons and the same reasons. Its preflight moves Google's predecessor references and
  // Snapchat's pixel ownership from src/campaign-preflight.ts to src/google-preflight.ts and src/snapchat-preflight.ts
  // with their reasons, and Meta's preflight hooks to src/meta-preflight.ts: three more files, two more with reasons
  // (src/campaign-preflight.ts keeps its own), the same reasons. Its rejected outcome moves Google's proof that a
  // refusal applied nothing to src/google-write-rejection.ts and the definitive statuses to the leaf
  // src/write-rejection-core.ts, neither with reasons: two more files. Its reconciliation moves Google's and Meta's
  // created-resource lookups and named targets to src/google-write-reconciliation.ts and
  // src/meta-write-reconciliation.ts and the read normalization to the leaf src/verification-core.ts, none with
  // reasons: three more files. Its recipe context moves the Microsoft location lookup's pinned request to the leaf
  // src/microsoft-location-pin.ts with its two reasons (src/microsoft-locations.ts keeps its others): one more file, one
  // more with reasons, the same reasons. Its spending policy moves Meta's currency-cap refusal from
  // src/spend-policy.ts, where it reached MirrorError through a helper this inventory does not follow, to
  // src/meta-adapter.ts, which constructs it: one more owned reason, whose Arabic the catalog already held.
  // Merged, the reporting and writes packages' files add up (ten and 33 more files, six and twelve more with reasons),
  // and so do their two newly owned reasons: the report source contract's undocumented-value refusal and Meta's
  // currency-cap refusal, each already translated.
  // ARC-01 phase B's server discovery configurations move each provider's asset discovery step from
  // server/asset-discovery.ts to its website login module (src/<provider>-login.ts, fifteen, their registry
  // src/provider-logins.ts and their contract src/provider-login.ts, which owns no reason) and Google Ads' hierarchy
  // discovery to src/google-account-discovery.ts (the server module re-exports it): eighteen more files, eleven more
  // files with reasons (the eleven login modules that own reasons and the hierarchy module, less the server module the
  // hierarchy's reasons left), the same reasons. Its OAuth flow steps add Google's shared steps (src/google-oauth.ts)
  // and the leaf that signs X's authorization calls (src/oauth1-authorization.ts), neither owning a reason: two more
  // files; the 11 reasons the steps took from server/platform-oauth.ts are in login modules that already own reasons.
  // Its website server modules add the provider startup registry (src/provider-startup.ts) and WooCommerce's website
  // login steps (src/woocommerce-login.ts), neither owning a reason: two more files.
  // Merged, the server package's 22 more files, eleven of them with reasons, add to the reporting and writes packages'
  // 43 and 18; the server package owns no new reason, so the owned reasons stay the merged reporting and writes
  // packages' 1,590.
  assert.equal(files.length, 734);
  assert.equal(selected.filter(row => row.messages.size).length, 282);
  assert.equal(owned.size, 1590);
  assert.equal(Object.keys(catalog).length, 11513);
  assert.deepEqual(localeProblems(catalog, owned), []);
  for (const message of owned) {
    const translated = catalog[message];
    assert.match(translated, /[\u0600-\u06ff]/u);
    assert.notEqual(translated, message);
    for (const token of new Set(message.match(/\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g) ?? []))
      assert.ok(translated.includes(token), 'Original native field ' + token);
    for (const bound of new Set(message.match(/\b\d[\d,]*(?:\.\d+)?\b/g) ?? [])) {
      if (message === 'Use a name between 1 and 80 characters.' && bound === '1')
        assert.ok(translated.includes('حرف واحد'), 'Existing worded minimum remains one character');
      else assert.ok(translated.includes(bound), 'Original quantity ' + bound);
    }
  }
  for (const [message, tokens] of [
    [
      'Install FFmpeg and ffprobe, or configure AMCP_FFMPEG_PATH and AMCP_FFPROBE_PATH.',
      ['FFmpeg', 'ffprobe', 'AMCP_FFMPEG_PATH', 'AMCP_FFPROBE_PATH'],
    ],
    ['AccountId must match account_id.', ['AccountId', 'account_id']],
    ['New Microsoft entities require Status: Paused.', ['Status: Paused']],
    [
      'Choose square, portrait, vertical or landscape, with contain or crop.',
      ['square', 'portrait', 'vertical', 'landscape', 'contain', 'crop'],
    ],
    [
      'Use amcp_write prepare and execute; caller-supplied before_state is not a verified snapshot.',
      ['amcp_write', 'prepare', 'execute', 'before_state'],
    ],
    ['Live execution must explicitly set dry_run=false.', ['dry_run=false']],
    ['Declare regulated_content explicitly as a boolean.', ['regulated_content']],
    ['Server parsing supports Csv and Tsv reports; submit another report in one of those formats.', ['Csv', 'Tsv']],
    [
      'A reviewed creative may set destination_spec only to {destination_type: WEBSITE_AND_SHOP_OPT_OUT}, which keeps it off the shop.',
      ['destination_spec', 'destination_type', 'WEBSITE_AND_SHOP_OPT_OUT'],
    ],
    ['MIRROR_MASTER_KEY must encode exactly 32 random bytes.', ['MIRROR_MASTER_KEY', '32']],
    [
      'LinkedIn-Version must be a monthly YYYYMM version. Verify that the chosen version is supported by LinkedIn.',
      ['LinkedIn-Version', 'YYYYMM'],
    ],
    [
      'Use native JSON arrays/objects or a well-formed REST.li List/record. Encode reserved punctuation inside scalar values.',
      ['JSON', 'REST.li', 'List', 'record'],
    ],
  ])
    for (const token of tokens) assert.ok(catalog[message].includes(token), 'Original protocol token ' + token);
});

for (const locale of ['en', 'ar'])
  test(
    'actual ' +
      locale +
      ' backend formatter preserves raw native values, uncertainty and original reference for every selected reason',
    () => {
      const fixture = accountWorkflowFixture(locale);
      for (const message of owned) {
        const result = errorResult(
          new MirrorError(
            'ORIGINAL_BACKEND_CODE',
            message,
            {
              native_id: '9007199254740993',
              account_urn: 'urn:li:adAccount:9007199254740993',
              currency_code: 'SAR',
              daily_budget: '0012.3400',
              native_name: 'Original <img> campaign',
              original_false: false,
            },
            409,
            false,
          ),
          'original-backend-reference',
          0,
        );
        const before = JSON.stringify(result);
        fixture.context.response = result;
        fixture.context.error = fixture.run('requestError(response)');
        const displayed = fixture.run('errorMessage(error)');
        assert.ok(displayed.includes(locale === 'ar' ? catalog[message] : message));
        assert.ok(displayed.includes('original-backend-reference'));
        assert.equal(fixture.context.error.code, 'ORIGINAL_BACKEND_CODE');
        assert.equal(fixture.context.error.message, message);
        assert.equal(fixture.context.error.details, result.error.details);
        assert.equal(result.error.retryable, false);
        assert.equal(result.error.remedy.mutation_retry_safe, false);
        assert.equal(JSON.stringify(result), before);
      }
      for (const message of [
        'Unrecognized provider sentence 00123',
        '9007199254740993',
        'urn:li:adAccount:9007199254740993',
      ]) {
        assert.equal(Object.hasOwn(catalog, message), false);
        const result = errorResult(new MirrorError('NATIVE_UNCHANGED', message), 'original-native-reference', 0),
          before = JSON.stringify(result);
        fixture.context.response = result;
        fixture.context.error = fixture.run('requestError(response)');
        assert.ok(fixture.run('errorMessage(error)').includes(message));
        assert.equal(JSON.stringify(result), before);
      }
      assert.equal(fixture.calls.length, 0);
      assert.equal(fixture.visits.length, 0);
    },
  );
