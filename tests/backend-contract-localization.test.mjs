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
  // ARC-01 phase B, wave 4c: the delegated compiler's provider rules move GA4's two property-scope refusals and
  // Business Profile's six location, account and read-mask refusals from src/delegated-native.ts (which keeps its
  // others) to their adapters, and Reddit's two report refusals to its adapter, which already owns reasons: two more
  // files with reasons, the same reasons. The action contract ledger's provider rules add the provider workflows
  // registry (src/provider-workflows.ts), whose rows are contract explanations; the service's provider steps move
  // the three refusals of a native read's provider checks there from src/service.ts (which keeps its others): one more
  // file with reasons, the same reasons.
  // Merged with the transport and catalog package (one more file, src/provider-workflows.ts, and three more with
  // reasons: the GA4 and Business Profile adapters and the provider workflows registry), the files add up: 735, 285
  // of them with reasons; that package moves reasons without adding one, so the owned reasons stay 1,590.
  // DOC-03's members-only Help page adds server/help-routes.ts (no owned reasons: its two failures are build defects,
  // plain errors) and seven website entries (its name, former names, description and page copy): 11,520 entries.
  // DOC-03's Home copy adds nine website entries (the capability outcomes and what verified means): 11,529 entries; no
  // owned reason changes.
  // Merged with the ARC packages, the Help page's module is one more file, without reasons: 736, 285 of them with
  // reasons, and the owned reasons stay 1,590.
  // ARC-01 wave 4c round 6 (w4c-arc6-versions) adds WooCommerce's adapter module (src/woocommerce-adapter.ts, its tool
  // notes, no owned reason): 737 files. It moves the Meta creative check's reasons from src/creative-validation.ts,
  // which keeps none, to src/meta-creative-features.ts, which already owns reasons: 284 files with reasons, the same
  // reasons.
  // Reviewer connector authority adds one directly owned refusal and its Arabic entry.
  // ARC-01 (wave 4c round 6, the shared tables) adds src/frozen-facts.ts, src/linkedin-programs.ts and
  // src/woocommerce-adapter.ts, none with an owned reason: the moved rows are facts, and the one refusal a moved rule
  // raises (LinkedIn's body format, from src/parameters.ts) is constructed in src/linkedin-adapter.ts, which owns
  // reasons: 739 files, as many with reasons, the same reasons.
  // Its wire contracts add src/discovery-issues.ts, the Discovery check, whose refusals name their label (it owns no
  // reason), and src/microsoft-wire-contract.ts, to which Microsoft's bounds refusal moves from src/wire-contracts.ts
  // (which keeps its others); its provider validation moves Meta's execution_options refusal from
  // src/provider-validation.ts (which keeps its others) to src/meta-adapter.ts, which owns reasons: 741 files, one more
  // with reasons, the same reasons.
  // Merged with the versions package, both add the one WooCommerce adapter module (it holds both packages' hooks), and
  // the versions package's move leaves src/creative-validation.ts without reasons: 741 files, 285 of them with reasons,
  // the same reasons.
  // ARC-01 phase B (wave 4c round 6): the workspace tool's provider actions add Tag Manager's measurement audit
  // (src/gtm-measurement-audit.ts) and WooCommerce's workspace actions (src/woocommerce-workspace.ts), neither owning a
  // reason. Merged with the versions and tables packages: 743 files, 285 of them with reasons, the same reasons.
  // ARC-01 (wave 4c round 6, catalog) moves each catalog destination's projection from src/catalog-ingestion.ts to
  // src/meta-catalog-ingestion.ts and its X and Snapchat siblings, the rules they share to
  // src/supplied-catalog-ingestion.ts, and the X removal's plan binding to src/x-catalog-removal-binding.ts; their
  // refusals are raised through bad(), as they were: five more files, the same reasons.
  // Its comparisons then move Meta's comparison from src/catalog-comparison.ts to src/meta-catalog-comparison.ts, with
  // its refusals: one more file, the same reasons. Its conditional programs move LinkedIn's and DV360's programs, their
  // requests and their evidence to src/linkedin-conditional-programs.ts and src/dv360-conditional-programs.ts: two more.
  // Merged with the versions, tables and workspace packages, the files add up: 751, 285 of them with reasons, the same
  // reasons. The merge then moves the declared effects of a suggested call to the leaf src/call-effects.ts (the
  // conditional programs label their calls there, without the workspace package's import of the providers' workflows
  // that would close a cycle), which raises no reason: 752, 285 of them with reasons, the same reasons.
  // Wave 4c round 6 (reporting) moves each allocation model's native budget draft from src/allocation-plan.ts to
  // src/<platform>-allocation-draft.ts (Google, Meta, LinkedIn, Snapchat): four more files. Their three refusals are
  // still raised through bad() and still authored allocation copy (tools/check-locales.mjs), so the files with
  // reasons and the reasons are the same.
  // It moves the Overview's native parent reads of TikTok, Snapchat and LinkedIn rows from src/overview-parents.ts,
  // which keeps its two reasons, to src/<platform>-detail-parents.ts: three more files, whose refusals go through the
  // shared module's helpers, so the files with reasons and the reasons are the same.
  // Merged with the versions, tables, workspace and catalog packages, the files add up: 759, 285 of them with reasons,
  // the same reasons.
  // The owner's decisions of 2026-10-31 (w4c-qualify-fixes) add the Arabic of "Reviewer", the name the approval page
  // shows for the reviewers' shared sign-in (web/operations-center.js), not an owned reason: 11,531 entries.
  // OWNER-REVIEWER-QA adds the Arabic of four connection progress messages the result page shows
  // (server/platform-routes.ts), none an owned reason: 11,534 entries on its base. Merged with "Reviewer": 11,535.
  // Its follow-up adds the Arabic of the note a test account reads on /account instead of the sign-in forms
  // (web/identity.js), not an owned reason: 11,535 on its base, 11,536 merged with "Reviewer".
  // Wave 5 round 1 (V2-RPT-05) adds the provider-data retry action (src/errors.ts providerDataAction, a report source's
  // next action) and the source card's "Retry" button, neither an owned reason: 11,538.
  // V2-RPT-02 adds the shared objective resolver (no new owned refusal) and objective explanations.
  // Result readers add three modules; the v4 boundary adds one.
  // Exact formula and advisory adapters add two further source modules.
  // V4 delivery-level reconciliation adds one source module without a new diagnostic.
  // Scope/status metadata adds three modules.
  // Adds the bounded selected-descendant rollup module.
  // Stored-definition migration adds its durable notice ledger module, without a new direct refusal.
  // Package D adds the Snapchat account-wide detail collector; its static refusals use the wrapper inventory.
  // Task 12 adds the X detail collector and its provider-owned level declarations.
  // V2-RPT-07 (levels) adds the 31-day span helper and Apple's bounded paging helper and detail collector.
  // V2-PRV-01's provider seam moves the previews tool's platform reads into src/<platform>-ad-previews.ts modules and a shared kit
  // (src/ad-preview-kit.ts); the sentences move with the code, so the owned reasons are unchanged.
  // The kit and the modules of Meta, TikTok, Snapchat, Reddit, Google Ads and X are new (LinkedIn's already existed): seven.
  // Design note 4 adds the leaf of Snapchat's continuation check (src/snapchat-paging.ts), without a reason of its own: one.
  // Merged with the levels package (779 modules), the previews package's eight make 787.
  // Package engine-core adds src/report-row-assembly.ts, the row assembly moved out of work() (F-L5-14): 788.
  // Package engine-surfaces adds src/report-coverage-notes.ts, the one computation of what a total covers (F-L5-01): 789,
  // and src/report-level-check.ts, the cross-level check in words for the PDF and the workbook (F-L5-05): 790,
  // and src/export-number.ts, the number a spreadsheet cell holds for an exact decimal (F-L5-07): 791.
  // Package mcp-typed adds src/report-tool-schema.ts, the typed reporting config generated from the report sources
  // (V2-MCP-02): 792,
  // and src/report-read-filters.ts, the filters of get and list (V2-MCP-02): 793,
  // and src/report-tool-output.ts, the typed result fields of the two reporting tools (V2-MCP-02): 794,
  // and server/mcp-progress.ts, the wait of a long run that carries a progress token (V2-MCP-02): 795,
  // and server/mcp-long-runs.ts, the two long runs the progress and the tasks follow (V2-MCP-02): 796,
  // and server/mcp-tasks.ts, the tasks extension of MCP 2026-07-28 (V2-MCP-02): 797.
  // Package charts adds src/report-chart-scale.ts, the exact ticks, labels, shares and colours every chart renderer shares
  // (V2-EXP-01): 792, and src/report-chart-spec.ts (the shape of a chart and the words AMCP writes in one) and
  // src/report-charts.ts (the charts of a finished snapshot): 794, then src/report-chart-kit.ts (what the builders share),
  // src/report-chart-breakdowns.ts and src/report-chart-measures.ts (the builders) and src/report-chart-change.ts (the
  // change of the key figures, read with the report): 798, then src/report-chart-layout.ts (where every mark of a chart
  // sits, shared by the three renderers): 799, then src/report-chart-theme.ts (the palette, the one escape function and a
  // spec's words in the report's language): 800, then src/report-chart-render.ts (the SVG back end): 801, then
  // src/report-chart-pdf.ts (the PDF back end: the chart, its table and the Charts section): 802.
  // Merge C, with mcp-typed (six files, 797 on its own base) and charts (eleven files, 802 on its own base): both count from 791 and their
  // new files are different files, so the merged tree measures, with this test's own inspector, 791 + 6 + 11 = 808.
  // Package mcp-surface (V2-MCP-06) adds src/contract-profile.ts (the contract profile and the scope a client's calls run in),
  // src/mcp-client-profile.ts (which profile an AI client's record gives it) and src/mcp-profile-help.ts (the help topic that
  // announces the profiles), none with a reason of its own: three more on Merge C's 808, 811. Whoever merges it adds the files
  // of every package it is merged with to this number.
  // Package mcp-surface adds server/mcp-budget.ts (the response budget of a v2 client's list reads) and src/call-kind.ts (whether a call
  // only reads), neither with a reason of its own: 813.
  // Package r25-m0-t1 (T1) adds src/tiktok-advertiser-state.ts, the advertiser row a TikTok review keeps, with no reason of
  // its own: 814.
  // Package r25-m0-review (Round 2.5) adds src/campaign-step-help.ts (the step shape of amcp_campaign create: the correction
  // of a refused step, the top-level hint and the worked example of help create), with no reason of its own: 814 on its own base.
  // Package r25-m0-errors (Round 2.5, M0: T7) adds src/action-aliases.ts, the generator of near-miss action names, with no
  // reason of its own: one more on the integration's 813, 814.
  // Merge r25-m0-merge, with r25-m0-t1, r25-m0-review and r25-m0-errors (each 814 on the same base of 813, and each adds a
  // different file): the merged tree measures 813 + 1 + 1 + 1 = 816.
  // Package r25-m1-hash (Round 2.5, M1: L5-02) adds six leaves, with no reason of their own: the flat-resource names of
  // src/review-flat-telemetry.ts and each provider's review table that its adapter and family modules share
  // (src/{x,linkedin,snapchat,criteo,google}-review-volatile.ts): 816 + 6 = 822.
  // The roles of the same package add one more, with no reason of its own: the identity of an X account
  // (src/x-identity-state.ts): 822 + 1 = 823. A parent is read whole, as a target is (lead review S2-1), so the module the
  // roles first added for a TikTok parent row (src/tiktok-parent-state.ts) is gone.
  // The rotation harness adds one more: the identity of a LinkedIn ad account, which the adapter and the families that read
  // the account themselves share (src/linkedin-account-state.ts): 823 + 1 = 824.
  // The accounts of Microsoft and Reddit are kept to their identity too (lead review S3-3), each in a module of its own with no
  // reason of its own (src/microsoft-account-state.ts, src/reddit-account-state.ts): 824 + 2 = 826.
  // Package r25-m1-diff (Round 2.5, M1: L5-04) adds src/review-diff.ts, which of the changed fields of a STATE_CHANGED
  // matter, with no reason of its own: one more on the integration's 816, 817 on its own base. Whoever merges it adds the
  // files of every package it is merged with to this number.
  // Merge r25-m1-merge, with r25-m1-hash (826 on the base of 816) and r25-m1-diff (817 on the same base): each adds different
  // files, so the merged tree measures, with this test's own inspector, 816 + 10 + 1 = 827.
  // Package r12-fix (the lead's ruling on item 1, decision 2, recency, 2026-11-16) adds src/snapchat-report-finalization.ts, the rule
  // that tells an empty Snapchat answer that is "no rows" from one that is not yet known, and its reason, with no reason of its own
  // (the sentence is a report warning, not a refusal): 817.
  // Merge r25-m1-merge, merge 3: r12-fix (817 on its own base of 816) on the 827 above adds one different file and nothing else
  // moves the count, so the merged tree measures, with this test's own inspector, 827 + 1 = 828.
  // Package r25-m2-reconcile (Round 2.5, M2: L5-05, L3-13) adds src/write-reconcile-job.ts, the worker job that checks an uncertain
  // write by reads alone, with no reason of its own (a refusal of the check is recorded, not raised): one more on the M1 head's
  // 828, 829 on its own base. Whoever merges it adds the files of every package it is merged with to this number.
  // Its item 2 adds src/tiktok-write-reconciliation.ts, TikTok's lookup of an uncertain campaign, ad group or ad create, with no
  // reason of its own (it reads and classifies; it refuses nothing): 830.
  // Its item 3 adds src/write-duplicates.ts, the guard against creating twice (a prepare of a create identical to an uncertain one is
  // refused), whose refusal goes through the write stages' shared fail, so it owns no reason here: 831.
  // Its rework (lead review S2-3) adds src/created-agreement.ts, the rule that a created lookup counts a match as this write's only when the
  // fields the review froze agree, which refuses nothing and has no reason of its own: 832.
  // Package r25-m2-refusal (Round 2.5, M2: L1-07) adds src/tiktok-write-rejection.ts, the closed set of TikTok return codes that declare
  // a refusal of the request and its proof that such a refusal applied nothing, with no reason of its own: one more on the integration's 828, 829
  // on its own base. Whoever merges it adds the files of every package it is merged with to this number.
  // The request_id of the same package (L1-09) first added src/tiktok-request-id.ts, the key a standard TikTok campaign or ad group create took
  // from its review at prepare, and the lead's review (S1-1) took it out again, because AMCP sends no request_id of its own: the count stays 829.
  // The rate governor of the same package (MT3) adds two modules, with no reason of their own: src/provider-usage.ts, what a provider's responses say of its
  // rate limit and the governor's table, mode and view, and src/meta-usage.ts, Meta's three usage headers read into it: 829 + 2 = 831.
  // Merge r25-m2-merge, merge 2: r25-m2-refusal (831 on its own base of 828) on r25-m2-reconcile's 832 above. Each added different files
  // (reconcile 4; refusal 3: src/tiktok-write-rejection.ts, src/provider-usage.ts, src/meta-usage.ts) and nothing else moves the count,
  // so the merged tree measures, with this test's own inspector, 828 + 4 + 3 = 835.
  // Package r25-m3-trees (Round 2.5, M3: L2-06, G4, G5, L2-09, G7) adds src/google-temp-names.ts, the one grammar of Google's temporary
  // resource names and the refusal of a chain over its route's limit, whose sentences are a fixed table this inventory does not read:
  // one more on the M2 head's 835, 836 on its own base. Its item 2 adds src/google-tree.ts, the one validation of a listing group tree
  // (its refusals are one sentence each, two of them moved from src/google-listing-groups.ts with their Arabic), and
  // src/google-shopping-tree.ts, the Standard Shopping node adapter, with three owned sentences of its own: 838. Whoever merges it adds
  // the files of every package it is merged with to this number.
  // Its item 5 adds src/google-build-trees.ts, a Performance Max tree inside a build (its two fixed refusals are owned by the wrapper
  // inventory, none by this one): 839.
  // Package r25-field-plan (Round 2.5, the owner's Google issue 2) adds src/campaign-spend-effects.ts, the local compile that says which write steps of
  // a plan need spend_change_confirmed, with no reason of its own (a step it cannot compile counts as spending; nothing is raised): one more on the
  // integration's 835, 836 on its own base. Whoever merges it adds the files of every package it is merged with to this number.
  // Merge r25-m3-merge, merge 13: r25-field-plan (836 on its own base of 835) on the 839 above. plan's one file (src/campaign-spend-effects.ts, no
  // owned reason) is none of the files counted above, so, measured with this test's own inspector: 839 + 1 = 840.
  // Package r25-m4-smartweb (Round 2.5, M4, item 3) adds src/tiktok-smart-plus-recipe.ts, the two guided Upgraded Smart+ website packs: one more
  // file (most of its refusals are raised through its own sole-throw helpers, which the wrapper inventory owns, and two directly, below):
  // 840 + 1 = 841. Whoever merges it adds the files of every package it is merged with to this number.
  // Package r25-m4-classic (Round 2.5, M4, item 5: the 2027-01-01 cut-off) adds src/tiktok-manual-cutoff.ts, with no reason of its own (its refusals are
  // composed by the deprecation registry, refuseDeprecated): 840 + 1 = 841. Whoever merges it adds the files of every package it is merged with to this number.
  // Merge r25-m4a-merge, merge 2: r25-m4-classic (841 on its own base of 840) on the 841 above. The two packages add one source file each (src/tiktok-smart-plus-recipe.ts and src/tiktok-manual-cutoff.ts), so, measured with this test's own inspector: 840 + 2 = 842. Both sides had moved this line to 841, so git carried it with no conflict marker: the value below is the measured one.
  // Package r25-m4-smartdelete (Round 2.5, M4; owner O3) adds src/tiktok-smart-plus-deletions.ts, the Smart+ deletion family, with
  // reasons of its own: 840 + 1 = 841 on its base 37ec65ba. Whoever merges it adds the files of every package it is merged with.
  // Merge r25-m4a-merge, merge 3: r25-m4-smartdelete (841 on its own base of 840) on the 842 above: one more source file, src/tiktok-smart-plus-deletions.ts, so, measured with this test's own inspector: 842 + 1 = 843.
  // Package r25-m4-smartedits (Round 2.5, M4: T5) adds src/tiktok-smart-plus-pixels.ts, the rule of an ad-level pixel of a Smart+ ad: its two fixed
  // refusals are raised through its own sole-throw helper, which the wrapper inventory owns and this one does not read, so it adds a file and no reason
  // here: one more on the merge's 840, 841 on its own base. Whoever merges it adds the files of every package it is merged with to this number.
  // Merge r25-m4a-merge, merge 4: r25-m4-smartedits (841 on its own base of 840) on the 843 above: one more source file, src/tiktok-smart-plus-pixels.ts, so, measured with this test's own inspector: 843 + 1 = 844.
  // Package r25-m4-search (Round 2.5, M4: Q6) adds src/tiktok-search-recipe.ts, the guided Search pack, whose keyword refusals go through its own
  // invalid(): one more file, 841 on its own base of 840. Whoever merges it adds the files of every package it is merged with to this number.
  // Merge r25-m4a-merge, merge 5: r25-m4-search (841 on its own base of 840) on the 844 above: one more source file, src/tiktok-search-recipe.ts, so, measured with this test's own inspector: 844 + 1 = 845.
  // Package r25-m4-smartops (Round 2.5, M4, item 2; cut from smartweb's head, 841) adds src/tiktok-serving-children.ts, TikTok's spend hook and
  // disclosure of a child created ENABLE under serving parents (Q1), with no reason of its own: 841 + 1 = 842. Whoever merges it adds the files
  // of every package it is merged with to this number.
  // Merge r25-m4a-merge, merge 6: r25-m4-smartops (842 on its own base of 841) on the 845 above: one more source file, src/tiktok-serving-children.ts, so, measured with this test's own inspector: 845 + 1 = 846.
  // Package r25-m4-search2 (Round 2.5, M4, item 2) adds src/tiktok-search-keywords.ts, the match types, the bound and the set of a Search
  // keyword list, which raises no refusal (the ad group contract raises them): one more file, 841 + 1 = 842.
  // Package r25-m4-search2, round 2, item 4 adds src/tiktok-account-negative-keywords.ts, the account level of the negative keyword family: one
  // more file, 842 + 1 = 843. Whoever merges it adds the files of every package it is merged with to this number.
  // Merge r25-m4a-merge, merge 7: r25-m4-search2 (843 on its own base of 841) on the 846 above: two more source files (src/tiktok-search-keywords.ts and src/tiktok-account-negative-keywords.ts), so, measured with this test's own inspector: 846 + 2 = 848.
  // Package r25-field2-access (B3) adds two modules: src/account-free-listing.ts, the ownership rule of an account-free listing, which
  // refuses nothing, and src/gtm-account-reads.ts, Tag Manager's account listing and container lookup, which owns reasons (counted below):
  // 840 + 2 = 842. Whoever merges it adds the files of every package it is merged with to this number.
  // Merge r25-m4a-merge, merge 8: r25-field2-access (842 on its own base of 840: src/account-free-listing.ts and src/gtm-account-reads.ts) on the 848 above: two more source files, so, measured with this test's own inspector: 848 + 2 = 850.
  // Package r25-field3-refs (the owner's second Google report of 2026-11-21, AMCP-01) adds src/plan-reference-standins.ts, the one function the plan's
  // preflight and the approval's spend effects ask for a step's stand-in request. It owns one reason, the refusal of a reference to a step that is not a
  // declared predecessor, moved from src/campaign-preflight.ts with its sentence unchanged (its Arabic key is the same, so no catalogue count moves):
  // 850 + 1 = 851 on its base 3356e390. Whoever merges it adds the files of every package it is merged with to this number.
  assert.equal(files.length, 851);
  // V2-RPT-02 validates fallbacks and overrides in report-objectives.ts: three owned refusals.
  // V2-RPT-04 adds direct creative metadata ownership in linkedin-detail-parents.ts.
  // V2-PRV-01 adds the minimal Meta ad identity observer's account refusal.
  // Apple's detail collector (its campaign bound) and Snapchat's evidence (its zone refusal now names the zone) own reasons.
  // Package mcp-typed: src/report-read-filters.ts owns the two sentences of the filter refusals (V2-MCP-02): 297.
  // Package r25-field-tiktok (#2): src/tiktok-manual-ad-identities.ts owns its first reason, the refusal of a classic ad create in an
  // Upgraded Smart+ ad group (a template with an {adgroup_id} slot; its identity refusal is built with the ad group's ID and is no
  // owned reason): 297 + 1 = 298.
  // Package r25-field-callshape (field fix, 2026-11-19) adds two sentences to src/campaign-step-help.ts, which owned none before:
  // what amcp_write refuses the keys of a plan step with (account_id, id, kind, depends_on and description beside arguments). One more file
  // with reasons, on the 297 above: 298.
  // Merge r25-m3-merge, merge 11: r25-field-callshape (298 on its own base of 297) on r25-field-tiktok's 298 above. The two packages add
  // different files (tiktok src/tiktok-manual-ad-identities.ts, callshape src/campaign-step-help.ts), each with a first owned reason, so
  // neither pin is the merged count and the line below, which both sides had moved to 298 and so carried no conflict marker, is the
  // measured value: 297 + 1 (tiktok) + 1 (callshape) = 299.
  // Package r25-m4-smartweb (item 3): src/tiktok-smart-plus-recipe.ts owns two reasons directly, the refusals of a landing page URL that
  // is not a full, public HTTPS one (DESTINATION_REQUIRED, the same two sentences, word for word, that src/recipe-steps.ts,
  // src/google-pmax-recipe.ts and src/tiktok-launch-recipes.ts raise for their own packs, so the Arabic is shared): one more file with
  // reasons, measured with this test's own inspector: 299 + 1 = 300.
  // Package r25-m4-classic (Round 2.5, M4: L1-03) gives src/tiktok-state-reads.ts its first owned reasons, the six refusals of an ad update in
  // TikTok's own shape (templates with slots): one more file with reasons, 299 + 1 = 300. Whoever merges it adds the files with reasons of
  // every package it is merged with to this number.
  // Merge r25-m4a-merge, merge 2: r25-m4-classic (300 on its own base of 299) on the 300 above. The two files with owned reasons are different files (src/tiktok-smart-plus-recipe.ts and src/tiktok-state-reads.ts), so, measured with this test's own inspector: 299 + 2 = 301. Both sides had moved this line to 300, so git carried it with no conflict marker: the value below is the measured one.
  // Package r25-m4-smartdelete: src/tiktok-smart-plus-deletions.ts owns reasons of its own, one more file with reasons: 299 + 1 = 300.
  // Merge r25-m4a-merge, merge 3: r25-m4-smartdelete (300 on its own base of 299) on the 301 above: src/tiktok-smart-plus-deletions.ts is one more file with owned reasons, so, measured with this test's own inspector: 301 + 1 = 302.
  // Package r25-m4-smartedits (item 3): src/tiktok-smart-plus-ad-updates.ts owns its first direct reason, the refusal that hands back the merged
  // ad_configuration of a patch (a sentence built with new MirrorError in handBack; the module's other refusals are built from the ad's ID): 299 + 1 = 300.
  // Whoever merges it adds the files with reasons of every package it is merged with to this number.
  // Merge r25-m4a-merge, merge 4: r25-m4-smartedits (300 on its own base of 299) on the 302 above: src/tiktok-smart-plus-pixels.ts is one more file with owned reasons, so, measured with this test's own inspector: 302 + 1 = 303.
  // Package r25-m4-search: src/tiktok-search-recipe.ts owns the reasons of its keyword refusals (six sentences, the Arabic of which is new,
  // and the shared input sentences it repeats from src/tiktok-launch-recipes.ts): one more file with reasons, 300 on its own base of 299.
  // Merge r25-m4a-merge, merge 5: r25-m4-search (300 on its own base of 299) on the 303 above: one more file with owned reasons, so, measured with this test's own inspector: 303 + 1 = 304.
  // Package r25-field2-access, B1: src/meta-dataset-scope.ts owns its first reason, the refusal of a pixel node read that names a field
  // outside the six pinned (INVALID_ARGUMENT with details.allowed_fields). One more file with reasons, on the 299 above: 300.
  // Package r25-field2-access, B3: src/gtm-account-reads.ts owns its first reasons, the refusals of Tag Manager's account listing and
  // container lookup (the two argument refusals, the answer that cannot be checked, the container not visible, GTM_ACCOUNT_NOT_CONNECTED
  // and the account mismatch). One more file with reasons, on the 300 above: 301.
  // Merge r25-m4a-merge, merge 8: r25-field2-access (301 on its own base of 299: src/meta-dataset-scope.ts and src/gtm-account-reads.ts) on the 304 above: two more files with owned reasons, so, measured with this test's own inspector: 304 + 2 = 306.
  // Package r25-field3-refs (AMCP-01): src/plan-reference-standins.ts owns one reason (the refusal of a reference to a step that is not a declared
  // predecessor, moved from src/campaign-preflight.ts, which still owns others), so one more file with owned reasons: 306 + 1 = 307 on its base 3356e390.
  // Whoever merges it adds the files with owned reasons of every package it is merged with to this number.
  assert.equal(selected.filter(row => row.messages.size).length, 307);
  // V2-RPT-01 replaces the adapter's count-change sentence and adds the campaign-window refusal.
  // Six group refusals, five creative refusals and one native-pivot refusal are now direct owned reasons.
  // V2-RPT-04 metric joins add one direct refusal.
  // V2-RPT-04 windows add the split-budget bound, creative retention/future guards and provider retention guidance.
  // The Meta result reader owns three new diagnostics.
  // Two TikTok native result diagnostics and one include-flags refusal are now direct reasons too.
  // The bounded exact formula evaluator owns one precision refusal.
  // V4 request-estimate guidance and the native metadata account refusal retain both old and new reasons.
  // Meta capture preserves its nested error fallback; mixed-pipeline checkpoints have a recovery refusal.
  // Eight direct X analytics entity/window/continuation refusals retain exact authored diagnostics.
  // Apple's campaign bound and Snapchat's zone-naming refusal are two more owned reasons; X's zone refusal replaces its own.
  // V2-RPT-04 (objectives, F-L2-07) keeps LinkedIn's "incomplete or at its response limit" sentence in one shared constant,
  // which is not a directly authored refusal reason: one fewer.
  // F-L4-13 (mcp) adds two owned reasons in server/http-app.ts: the refusal of a body encoding or character set AMCP does
  // not accept (415) and of a body that cannot be decoded (400): 1631 + 2 - 1 + 2.
  // Package results (item 10) removes one owned reason: the Apple refusal of more than 100 campaigns, now bounded by the
  // whole-job allowance instead: 1634 - 1.
  // Package mcp-typed (V2-MCP-02) owns three more: the two filter refusals of src/report-read-filters.ts and the offset
  // refusal of a filtered read in src/reporting-overview.ts (the reworded include refusal replaces its old sentence): 1636.
  // Package charts (V2-EXP-01) adds two owned reasons in src/reporting-overview.ts: a chart setting on a definition of the
  // earlier form, and a chart setting that is not charts.disabled with known kinds: 1633 + 2.
  // Merge C, with mcp-typed (1,636 on its own base) and charts (1,635 on its own base): no reason is owned by both, so the merged tree measures,
  // with this test's own inspector, 1,633 + 3 + 2 = 1,638.
  // Package mcp-surface (V2-MCP-06) owns one more: the MEDIA_REVIEW_REQUIRED refusal of src/media-routing.ts, which a native
  // upload answers under the v2 contract profile: 1,639.
  // Package r25-m0-errors (Round 2.5, M0: LEAD-03) owns one more: the OWNER_REQUIRED refusal of workspace health in
  // src/spend-policy.ts, now a sentence of its own that states the rule (it was built from a template and a tail): 1,640.
  // Its G9 owns two more, in src/transport.ts: the templates of a provider refusal that names its closed-set tokens (HTTP
  // error and unsuccessful result, each with a {refusal} slot): 1,642.
  // Package r25-m0-live (Round 2.5, item 1) owns two more: the date and date-order refusals of dateRange for a guided
  // capture's window (src/workflows.ts, templates that name the semantics key): 1,641. Its item 5 owns one more: the template of
  // Snapchat's refusal of attribution windows it did not use, which names the windows it did (src/snapchat-evidence.ts; the earlier
  // sentence is kept for a window outside the closed sets, and is raised through bad()): 1,642.
  // Merge r25-m0-merge, with r25-m0-errors (1,642 on its own base) and r25-m0-live (1,642 on the same base of 1,639): each adds
  // three different owned reasons, so the value line merged without a conflict and was wrong. No reason is owned by both:
  // 1,639 + 3 + 3 = 1,645, as this test's own inspector measures it on the merged tree.
  // Package r12-gpreview (item 3) owns one more: the refusal of a write whose provider answer did not match what AMCP reviewed,
  // a sentence of its own in src/service.ts (failedWrite; the generic sentence beside it is the one it had): 1,646.
  // Package r25-m3-pmax (Round 2.5, M3: G3) owns three more, in src/google-asset-links.ts: the refusal of an image whose shape is not
  // its field type's (INVALID_ASSET_LINK) and the two refusals of a link review that would leave an asset group below a minimum
  // (PMAX_ASSET_MINIMUMS: one for a missing 1.91:1 marketing image, one for any other minimum): 1,646 + 3 = 1,649. Whoever merges it
  // adds the owned reasons of every package it is merged with to this number.
  // Package r25-m3-pmax, round 2 (S3-1), owns one more in src/google-asset-links.ts: the refusal of a BUSINESS_NAME, LOGO or
  // LANDSCAPE_LOGO linked to an asset group of a campaign with brand guidelines on (INVALID_ASSET_LINK): 1,649 + 1 = 1,650.
  // Round 2 (S4-5, part 1) owns one more, also in src/google-asset-links.ts: the refusal of the first custom links of a retail asset
  // group that has no final URL (INVALID_ASSET_PARENT): 1,650 + 1 = 1,651. Round 3 (N1) replaced that refusal's sentence in place (it
  // names a route now): no change. Round 3 (N2) owns one more, in src/google-asset-links.ts: the refusal of a LOGO or LANDSCAPE_LOGO
  // linked to the campaign of a Performance Max campaign with brand guidelines off (INVALID_ASSET_LINK): 1,651 + 1 = 1,652.
  // Package r25-field-snap (Round 2.5 field fix, item 3, #9) owns one more: the shape refusal of result_ids that is no JSON array
  // of IDs (src/snapchat-result-ids.ts; the count refusal beside it is the one it had): 1,647. Measured with this test's own
  // inspector on that package's head.
  // Merge r25-m3-merge, merge 6: r25-field-snap (1,647 on its own base of 1,646) on r25-m3-pmax's 1,652 above. snap's sentence is in
  // src/snapchat-result-ids.ts and is none of pmax's, so, measured with this test's own inspector: 1,646 + 6 (pmax) + 1 (snap) = 1,653.
  // Package r25-field-tiktok (#2) owns one more: the refusal of a classic ad create in an Upgraded Smart+ ad group, with the Smart+
  // route named (src/tiktok-manual-ad-identities.ts): 1,646 + 1 = 1,647.
  // Package r25-field-tiktok (#6) owns one more: the template that answers a Smart+ ad create or edit that breaks several rules, the
  // first violation and a count ("{first}, and {more} more (details.violations lists every one)."; refuse() in
  // src/tiktok-smart-plus-ads.ts, whose file owned a reason already): 1,647 + 1 = 1,648.
  // Its round 2 (the lead's review, S3-1) takes that template away again: the refusal of several rules says the first rule's own
  // sentence as its message (refuse() passes it on, a value and no literal), and that there are more is the remedy of its code
  // (src/tiktok-remedies.ts, a shared recovery hint, counted in tests/shared-recovery-localization.test.mjs): 1,648 - 1 = 1,647.
  // Merge r25-m3-merge, merge 7: r25-field-tiktok (1,647 on its own base of 1,646) on the 1,653 above. tiktok's one direct reason is in no
  // module of pmax or snap, so, measured with this test's own inspector: 1,646 + 6 (pmax) + 1 (snap) + 1 (tiktok) = 1,654.
  // Package r25-media-drive-large (Round 2.5 field fix, item 2): +5 and -2. A public Drive download that was refused now says why, in
  // three sentences of src/drive-media.ts (the file is not shared, Google limits its downloads, Google flagged it), and a file over the
  // limit says "too large" in two parameterized sentences of src/media-buffer.ts (with its size and the maximum, or the maximum alone).
  // The two sentences they replace, "Media must be at most the configured media limit." (src/drive-media.ts, src/media-link.ts and
  // src/media-sources.ts) and "The media response exceeds its byte limit." (src/media-buffer.ts), are written by no source any more:
  // 1,646 + 5 - 2 = 1,649.
  // Its item 3 owns three more, in src/media-buffer.ts (readChunk): a download that stopped sending data, one that took too long, and
  // one whose body stopped before the whole file arrived, each a MEDIA_DOWNLOAD_FAILED sentence of its own: 1,649 + 3 = 1,652.
  // Its fix round 2 (S4-1 of the lead's review) owns one more, in src/media-buffer.ts (downloadStopped): a download whose reservation
  // in the shared byte budget lapsed before its file began to arrive, a MEDIA_DOWNLOAD_FAILED sentence of its own in place of the
  // upload sentence (MEDIA_ADMISSION_LOST) it used to end in: 1,652 + 1 = 1,653.
  // Merge r25-m3-merge, merge 8: r25-media-drive-large (1,653 on its own base of 1,646) on the 1,654 above. media's reasons are in
  // src/media-sources.ts, src/media-buffer.ts and the Drive modules and are none of the sentences counted above, so, measured with this
  // test's own inspector: 1,646 + 6 (pmax) + 1 (snap) + 1 (tiktok) + 7 (media, net: five new, two gone, then four more) = 1,661.
  // Package r25-field-gclone (items 1 and 2) owns four more, in src/google-campaign-clone.ts: the refusal of a source.ad_group_ids that
  // is not a list of 1-1,000 numeric IDs, of ad groups the source campaign does not have (details.missing), of a source.languages
  // that is not a list of 1-100 language constants, and of languages the source campaign does not target: 1,646 + 4 = 1,650. Its item 5
  // owns one more, in src/campaign-clone.ts: the refusal of those keys on a platform whose clone takes only campaign_id: 1,650 + 1 = 1,651.
  // Its round 2 (the lead, 2026-11-20) owns one more, in src/google-campaign-clone.ts: the Google variant of the refusal of a source that did not fit
  // the pages AMCP reads, which also names source.ad_group_ids: 1,651 + 1 = 1,652.
  // Merge r25-m3-merge, merge 10: r25-field-gclone (1,652 on its own base of 1,646) on the 1,661 above. gclone's six reasons are in
  // src/google-campaign-clone.ts and src/campaign-clone.ts and are none of the sentences counted above, so, measured with this test's
  // own inspector: 1,646 + 6 (pmax) + 1 (snap) + 1 (tiktok) + 7 (media) + 6 (gclone) = 1,667.
  // Package r25-field-callshape (item 2) owns two more, in src/campaign-step-help.ts: the sentence amcp_write refuses an account_id beside
  // arguments with, and the template it refuses an id, kind, depends_on or description with ({field} belongs to a plan step: ...): 1,646 + 2 = 1,648.
  // Merge r25-m3-merge, merge 11: r25-field-callshape (1,648 on its own base of 1,646) on the 1,667 above. callshape's two sentences are in
  // src/campaign-step-help.ts and are none of the sentences counted above, so, measured with this test's own inspector: 1,646 + 6 (pmax)
  // + 1 (snap) + 1 (tiktok) + 7 (media) + 6 (gclone) + 2 (callshape) = 1,669.
  // Package r25-m4-smartweb (item 3) owns no sentence more: the two it raises directly (src/tiktok-smart-plus-recipe.ts, the landing page
  // URL refusals) are three other files' sentences word for word, so the set does not grow: 1,669 + 0 = 1,669 (measured with this test's inspector).
  // Package r25-m4-classic (Round 2.5, M4: L1-03) owns six more, in src/tiktok-state-reads.ts: the refusals of an ad update in TikTok's own shape
  // (more than 20 ads, TikTok's limit for creatives, which the first version of this comment said was 25; an ad_id that is not numeric text, or missing; an ad repeated in two creatives; a top-level ad_ids or ad_id that names other
  // ads than the creatives; no patch_update: true; an ad that is in another ad group than the update names): 1,669 + 6 = 1,675. Measured with
  // this test's own inspector. Whoever merges it adds the owned reasons of every package it is merged with to this number.
  // Its item 2 (the twin of r25-field-tiktok #2) owns one more, in src/tiktok-manual-ad-identities.ts: the refusal of a classic ad group create in
  // an Upgraded Smart+ campaign, with the Smart+ route named (a template with a {campaign_id} slot): 1,675 + 1 = 1,676.
  // Its item 3 (L1-16, acceptance 7) owns one more, in src/tiktok-campaign-clone.ts: the refusal of a clone whose source campaign names an
  // automation type other than MANUAL (CLONE_UNSUPPORTED, a template with {campaign_id} and {campaign_automation_type} slots): 1,676 + 1 = 1,677.
  // Its follow-up to item 1 owns one more, in src/tiktok-state-reads.ts: the refusal of an ad update in TikTok's own shape whose adgroup_id is not
  // numeric text (INVALID_ARGUMENT): 1,677 + 1 = 1,678.
  // Its corrections after the lead's documentation session (2026-11-20; the coordinator, 2026-11-21) own one more, in src/tiktok-state-reads.ts: the refusal
  // of an ad update in TikTok's own shape that changes a field outside the ten its incremental update keeps the omitted values of (INVALID_ARGUMENT, a
  // template with a {fields} slot); the limit of 20 creatives and the patch_update sentence are reworded in place: 1,678 + 1 = 1,679.
  // Its round 2 (the lead's review, 2026-11-21) owns one more, in src/tiktok-state-reads.ts: the refusal of an ad update whose ad's row names another
  // ad group than the update, or none that reads as an ID (S3-3: STATE_TARGET_MISMATCH, which names no value TikTok returned): 1,679 + 1 = 1,680.
  // S3-4 owns one more, in the same file: the refusal of a key beside the creatives of an ad update in TikTok's own shape, which holds only
  // advertiser_id, adgroup_id, patch_update and creatives (INVALID_ARGUMENT, a template with a {fields} slot): 1,680 + 1 = 1,681.
  // Merge r25-m4a-merge, merge 2: r25-m4-smartweb adds none (1,669 + 0) and r25-m4-classic twelve (1,681 on its own base of 1,669), all in src/tiktok-state-reads.ts, src/tiktok-manual-ad-identities.ts and src/tiktok-campaign-clone.ts, so, measured with this test's own inspector: 1,669 + 12 = 1,681.
  // Package r25-m4-smartdelete owns one more, in src/tiktok-smart-plus-deletions.ts: the pause-first refusal of a Smart+ deletion
  // (TIKTOK_SMART_PLUS_DELETE_REQUIRES_PAUSE, a template with a {targets} slot). Its other new sentences are the wrapper
  // inventory's (tests/backend-wrapper-localization.test.mjs): 1,669 + 1 = 1,670 on its base 37ec65ba.
  // Merge r25-m4a-merge, merge 3: r25-m4-smartdelete (1,670 on its own base of 1,669) on the 1,681 above: one more owned reason, so, measured with this test's own inspector: 1,681 + 1 = 1,682.
  // Package r25-m4-smartedits (item 3) owns one more, in src/tiktok-smart-plus-ad-updates.ts (handBack): the sentence that hands back the configuration a
  // patch was merged into (INVALID_TIKTOK_SMART_PLUS_AD, with details.fix and details.next_call): 1,669 + 1 = 1,670. Whoever merges it adds the owned
  // reasons of every package it is merged with to this number.
  // Merge r25-m4a-merge, merge 4: r25-m4-smartedits (1,670 on its own base of 1,669) on the 1,682 above: one more owned reason, so, measured with this test's own inspector: 1,682 + 1 = 1,683.
  // Package r25-m4-smartops (item 2) owns one sentence more, in src/preflight.ts: the spend acknowledgement of a child created active under a
  // parent the review reads as serving (Q1): 1,669 + 1 = 1,670 (measured with this test's inspector). Whoever merges it adds it to the merged count.
  // Merge r25-m4a-merge, merge 6: r25-m4-smartops (1,670 on its own base of 1,669) on the 1,683 above: one more owned reason (the serving-parent refusal sentence of src/preflight.ts), so, measured with this test's own inspector: 1,683 + 1 = 1,684.
  // Package r25-field2-access, B1: the one sentence of src/meta-dataset-scope.ts (the pixel node read's field refusal): 1,669 + 1 = 1,670.
  // Its B3: the refusals of src/gtm-account-reads.ts, six sentences of its own (the two argument refusals, the answer that cannot be
  // checked, the container not visible, GTM_ACCOUNT_NOT_CONNECTED and the account mismatch) and the diagnostics' GET refusal ("Diagnostic
  // requests must be scoped native GETs.", raised there through the family kit, so no owned module had it); the two sentences of the
  // login's authority check were owned already (src/native-authority.ts). Measured with this test's own inspector, not summed:
  // 1,670 + 7 = 1,677.
  // Merge r25-m4a-merge, merge 8: r25-field2-access (1,677 on its own base of 1,669: eight more owned reasons) on the 1,684 above. Measured with this test's own inspector, not summed (a wrong value prints this one): 1,684 + 8 = 1,692.
  assert.equal(owned.size, 1692);
  // V2-RPT-01 adds request/window diagnostics and the updated evidence-page hint: six Arabic entries.
  // V2-RPT-01 totals add the match notice, gap templates and evidence refusal.
  // V2-RPT-02 adds nine objective-select and source labels; owned refusals are unchanged.
  // V2-RPT-04 adds seven refusals and two metadata warnings; existing level labels are reused.
  // V2-RPT-04 group results add seven labels and the Mixed explanation; refusal ownership is unchanged.
  // V2-RPT-04 results add three diagnostics and consolidate three omitted legends into two (net +2).
  // V2-RPT-04 windows add thirteen templates, partial-coverage notices and guards.
  // V2-RPT-04 contract notices add two notices, two artifact labels and one restart explanation.
  // V2-PRV-01 adds twelve selection, paging and ownership explanations.
  // V2-PRV-02 adds the documented iframe lifetime and rejected-placement note.
  // V2-PRV-03 adds Snapchat's lifetime and unusable-link note.
  // Sixteen result labels/diagnostics and eight v4 boundary refusals.
  // Collector/undeclared-window/include diagnostics add four more entries.
  // One durable objective-migration notice.
  // One formula refusal and two advisory coverage/definition messages.
  // The v4 aggregation explanations add two bilingual interface entries.
  // Seven v4 scope/status and request-estimate explanations.
  // Five selected-descendant scope, recovery and aggregation labels.
  // One migration-notice export column label.
  // Twelve per-account v4 control labels and explanations.
  // Thirteen truthful source-count and empty-scope explanations.
  // Package D adds the scalar-scope conflict and dated optional campaign reference.
  // Task 12 adds twenty unique X diagnostics, four warning messages and one native level label.
  // V2-RPT-07 (levels) adds 25 entries and replaces 7 (net +18): the X and Snapchat list-bound, mixed-objective, non-additive,
  // allowance and zone messages, and the nine Apple list, campaign-bound and report-row refusals.
  // V2-RPT-04 (objectives) adds five: the four reasons an objective was not read (refused, or beyond the bound) and the
  // label of the results a LinkedIn group lists apart from its primary one.
  // F-L3-10 (previews) adds seventeen: seven refusals and six notices of the previews tool, and the four platforms without a
  // preview route (the module's other refusals already had Arabic).
  // F-L3-06 (previews) adds four: the count the previews panel announces for a page, one and several, first and further.
  // F-L4-13 (mcp) adds two: the Arabic of the two body-encoding refusals above.
  // Web-report adds nineteen website messages: "n of m rows", the card notes and the cross-level check (F-L8-03).
  // Web-report adds the account settings group's name (F-L8-07).
  // Web-report adds ten collector warnings that reached the Arabic interface in English (F-L8-04).
  // Web-report adds the singular forms of two row-count messages (F-L8-12).
  // The stored and TikTok packages add none: 11,737 + 18 + 5 + 21 + 2 + 32.
  // Package engine-core adds four website messages (the levels of a source that could not be collected, F-L5-10; the selected IDs that matched no returned row, F-L5-27; the count of a figure built from native measurements, F-L5-31; the source collected again after an earlier platform contract, F-L5-16) and two reasons (a level that could not be collected in a cross-level pair, F-L5-10, and a figure past the calculation limits, F-L9-01), and deletes the two entries of the dead overviewV4Sum and overviewV4Ratio (F-L5-28): 11,817 + 2.
  // Package results adds the TikTok ad group results warning (F-L5-19): + 1.
  // Package results adds the mapped-result line of a report row and the mapped-result limitation (F-L5-12): + 2.
  // Package results removes the Apple refusal of more than 100 campaigns, which no code says any more (item 10): - 1.
  // Package results adds the reason a cost per result target cannot be compared with a conversion value (F-L5-13): + 1.
  // Merge B (engine-core and results both start from 11,815 on their base; their additions do not overlap): measured on the merged
  // catalogue, 11,815 + 4 (engine-core) + 3 (results) = 11,822.
  // Web-components adds 96 messages: the core components' defaults and the component state page (V2-WEB-02).
  // Web-components adds 46 more: the choosing components' defaults and the state page's tabs, list and tree sections (V2-WEB-02).
  // Web-components adds 37 more: the table and overlay components' defaults and their state page sections (V2-WEB-02).
  // Web-components adds 3 more: the legacy badge mapping on the state page (V2-WEB-02).
  // Merge B, with web-components (11,815 + 182 on its own base; none of its strings is one the other packages added): measured on
  // the merged catalogue, 11,822 + 182 = 12,004.
  // Package engine-surfaces adds one website message, the note of a sparkline that has hollow marks (F-L5-26): 11,820.
  // Package engine-surfaces removes the Arabic entry of the earlier TikTok capture note, which said 1–31 closed days and had no reader: 11,819.
  // Merge B, with engine-surfaces (11,819 on its own base): its one added and one removed entry net to zero, so the merged
  // catalogue measures 12,004, as it did before this package.
  // Package closing-fixes adds one website message, the preview link's name when it has no number (WCAG 2.5.3): 12,005.
  // Package meta-results adds fifteen labels of Meta’s results that had no Arabic (the indicator table of src/meta-report-results.ts,
  // the mapped table’s App installs, and Meta result for an indicator Meta adds later) and the two sentences a v4 Meta source states for
  // its result definition: 12,004 + 15 + 2.
  // Package meta-results then names a custom conversion, an action and a metric Meta adds later by their own value: it replaces the two generic
  // labels (Custom conversion, Meta result) with three templates that carry it (Custom conversion {id}, Meta action {action}, Meta result
  // {indicator}): 12,021 - 2 + 3.
  // Merge C, with closing-fixes (12,005 on its own base) and meta-results (12,022 on its own base): measured on the merged catalogue
  // (node tools/check-locales.mjs; a key by key three-way merge finds no clash and no key added by both), 12,023.
  // Package mcp-typed (V2-MCP-02) adds the three sentences of the get and list filter refusals and rewords the include
  // refusal to name charts (the old sentence leaves the catalogue): 12,007.
  // Merge C, with mcp-typed (12,007 on its own base): measured on the merged catalogue (node tools/check-locales.mjs; a key by key
  // three-way merge finds no clash and no key added by both), 12,023 + 3 = 12,026.
  // V2-WEB-03 (web-shell): +15 entries, the page subtitles the route registry now carries (the group names Home, Reports, Creatives, Campaigns, Connections, Operations and Settings were already translated).
  // V2-WEB-03 (web-shell): +3 entries, the sidebar's footer navigation name and the rail switch's two states.
  // V2-WEB-03 (web-shell): +1 entry, 'Back to {page}', the link a failed page offers to its registry parent.
  // V2-WEB-03 (web-shell): +2 entries, the titles of Home's two empty panels (no saved campaign plans, no accounts to check).
  // Merge C, with web-shell (12,025 on its own base): measured on the merged catalogue (node tools/check-locales.mjs: catalog_messages 12047;
  // a key by key three-way merge finds no clash and no key added by both), 12,026 + 21 = 12,047.
  // Package charts adds the Arabic of the sentences and labels a chart carries that the catalogue lacked (V2-EXP-01): 47
  // messages (the two owned reasons above among them; the include-flags reason is the earlier one, renamed; "Change" was
  // already there), 12,051. The page that draws the charts adds five more (charts, V2-EXP-01): the heading of its section,
  // the button that opens a chart's table and closes it, and the two lines of the setting that switches charts off, 12,056.
  // Merge C, with charts (12,056 on its own base): measured on the merged catalogue (node tools/check-locales.mjs: catalog_messages 12098).
  // Charts adds 53 entries and removes the old include-flags reason; the integration already has the new reason (mcp-typed, the same Arabic)
  // and lacks the old one, and meta-results added 'App installs' with another Arabic than charts, which now has one (meta-results', the
  // website's wording of App Installs), so 51 of the 53 are new: 12,047 + 51 = 12,098.
  // Package mcp-surface (V2-MCP-06) adds the Arabic of the MEDIA_REVIEW_REQUIRED refusal and its two remedies (with and without
  // the call it names): 12,101.
  // Package website-get adds the Arabic of the two sentences a row's source details and a source card's evidence show while they
  // load and when they fail to (web/reporting-overview.js, node tools/check-locales.mjs: catalog_messages 12100): 12,098 + 2 = 12,100.
  // Merge D, with mcp-surface (12,101 on its own base) and website-get (12,100 on its own base): measured on the merged catalogue
  // (node tools/check-locales.mjs: catalog_messages 12103; the two add different keys), 12,098 + 3 + 2 = 12,103.
  // Package linkedin-windows (V2-RPT-04, plan 4.7): +9 entries, the Arabic of the notes a LinkedIn source carries when the account's
  // conversion-rule windows are joined, mixed or left unknown with their reason; measured (node tools/check-locales.mjs:
  // catalog_messages 12107), 12,098 + 9 = 12,107. Moved by the lead with the owner's approval of 2026-11-14.
  // Merge E, with linkedin-windows (12,107 on its own base) and Merge D's head (12,103): measured on the merged catalogue
  // (node tools/check-locales.mjs: catalog_messages 12112; a key by key three-way merge finds no clash and no key added by both),
  // 12,103 + 9 = 12,112. The owner approved moving this pin for this package (2026-11-14).
  // Package r25-hotfix (item 1, error 7 of the live checks of 2026-11-15): +1 entry, the Arabic of the TikTok page-count remedy
  // (src/tiktok-remedies.ts), which the package brief requires; measured (node tools/check-locales.mjs: catalog_messages
  // 12113), 12,112 + 1 = 12,113.
  // Package r25-hotfix (item 2, error 16 of the same live checks): +1 entry, the Arabic of the remedy for a provider response
  // that does not match the pinned contract of its route (src/errors.ts), which the package brief requires; measured
  // (node tools/check-locales.mjs: catalog_messages 12114), 12,113 + 1 = 12,114.
  // Package r25-m0-review (S3-3, the lead's review of 2026-11-15): +2 entries, the Arabic of the two sentences amcp_campaign create
  // refuses a name or a brief with, which the website's plan form shows; measured on its own base (node tools/check-locales.mjs:
  // catalog_messages 12114), 12,112 + 2 = 12,114.
  // Package r25-m0-errors (Round 2.5, M0: LEAD-01) adds the Arabic of the five messages that name why a capability selection
  // left nothing to describe, and of four of their five next steps (the fifth is CONNECTION_REQUIRED's, already translated):
  // measured (node tools/check-locales.mjs: catalog_messages 12121), 12,112 + 9 = 12,121.
  // Its LEAD-03 adds the Arabic of the health refusal and of its next step: measured (catalog_messages 12123), 12,121 + 2.
  // Its L3-02 adds the Arabic of the next step of a write throttled after it was sent: measured (catalog_messages 12124).
  // Its G9 adds the Arabic of the two provider refusal templates: measured (catalog_messages 12126).
  // Merge r25-m0-merge, with r25-hotfix (12,114 on its own base), r25-m0-review (12,114) and r25-m0-errors (12,126): all
  // started from 12,112 and they add different keys, so no package's own pin is the merged count. Measured on the merged
  // catalogue (node tools/check-locales.mjs: catalog_messages 12130, problems none): 12,112 + 2 (hotfix) + 2 (review) + 14
  // (errors) = 12,130.
  // Package r25-m0-live (Round 2.5) item 1 adds the Arabic of the two date refusals of a guided capture's window: measured
  // (node tools/check-locales.mjs: catalog_messages 12114), 12,112 + 2 = 12,114. Its item 2 adds the two sentences that name
  // semantics.complete (TikTok and Snapchat; raised through bad(), so no owned reason changes): 12,114 + 2 = 12,116. Its item 3
  // adds the Arabic of LinkedIn's remedy for an empty analytics answer (src/linkedin-remedies.ts): 12,117. Its item 4 rewords
  // Microsoft's refusal of a payload AccountId that is not the call's account_id (the owned reason is replaced one for one, the
  // old entry leaves the catalogue) and adds the Arabic of the remedy that says the request is at fault: 12,117 + 2 - 1 = 12,118. Its
  // item 5 adds the Arabic of the Snapchat template that names the windows Snapchat used: 12,119. Its item 7 replaces the previews
  // notice that promised links open for anyone who has them and the page's line that said the same (two entries leave) with the notice
  // that makes no such promise, LinkedIn's that names its two links and the page's new line (three enter): 12,119 + 3 - 2 = 12,120.
  // Its review fix S2-1 rewords LinkedIn's remedy for an empty analytics answer so that it names no tool or action (the old entry
  // leaves, the new one enters) and adds the Arabic of the TikTok page-count remedy worded for people (src/tiktok-remedies.ts): 12,121.
  // Merge r25-m0-merge, live (12,121 on its own base of 12,112, nine more) on the 12,130 above: the TikTok page-count remedy is
  // translated by both the hotfix (its wording) and live (the reworded one, which wins, the lead's decision of 2026-11-15), and
  // the code carries only live's, so the hotfix's entry is dropped and counted once. Measured on the merged catalogue (node
  // tools/check-locales.mjs: catalog_messages 12138, problems none; ar.json has 12,138 keys and no duplicate): 12,130 + 9 - 1.
  // Package r25-m1-diff (Round 2.5, M1: L5-04, T2): +1 entry, the Arabic of the remedy of the refusal of a review's state check
  // (src/errors.ts; its next step is the same sentence); measured on its own base (node tools/check-locales.mjs:
  // catalog_messages 12139), 12,138 + 1 = 12,139.
  // Its item 2 (L5-04): +1 entry, the website's wording of the stop of a plan run at a step whose provider state changed after its
  // review (web/campaign-workflows.js runStopLabels.state_changed, also shown for the step execute_next sent back to pending):
  // measured (node tools/check-locales.mjs: catalog_messages 12140), 12,139 + 1 = 12,140.
  // Its item 5 (L6-11): +3 entries, the website's wording of the media block of the Review friction section of Settings (its heading,
  // its table's name and the line that says how many media reviews were prepared and uploads sent: web/owner-operations.js
  // ownerMediaFriction; every other label of the block was already translated): measured (node tools/check-locales.mjs:
  // catalog_messages 12143), 12,140 + 3 = 12,143.
  // Its item 4 (the alarm of the plan's idea 1): +3 entries, the website's wording of the fields that change on many prepares of
  // one provider, in the Review friction section (heading, the notice that states the rule, and the counts of each field:
  // web/owner-operations.js ownerReviewFriction): measured (node tools/check-locales.mjs: catalog_messages 12146), 12,143 + 3 = 12,146.
  // Lead review S2-2 (r25-m1-diff): +1 entry, the remedy of a STATE_CHANGED refused after a claim (a media resume, where part of
  // the upload may already have been sent: src/errors.ts reviewRemedy): measured (catalog_messages 12147), 12,146 + 1 = 12,147.
  // Package r12-fix (item 2, V2-RPT-07): +2 entries, the Arabic of the two refusals of the X line item and promoted tweet levels
  // that name the kind of parent they could not find and how many entities lack one (src/x-overview-detail.ts; the earlier
  // sentence stays, for a malformed objective): 12,138 + 2 = 12,140. Measured: node tools/check-locales.mjs, catalog_messages 12140.
  // Package r12-fix (item 3, V2-RPT-05): +5 entries, the Arabic of the five provider remedies it declares (Snapchat's four, one for
  // each timestamp of a stats answer that AMCP refused, and X's one for an entity whose parent is in neither list; remedies, not
  // refusal reasons): 12,140 + 5 = 12,145. Measured: node tools/check-locales.mjs, catalog_messages 12145.
  // Package r12-fix, the lead's ruling on item 1 (decision 2, recency, 2026-11-16): +2 entries for an empty Snapchat answer that
  // nothing confirms as final: the refusal of a capture that is one such answer (src/snapchat-evidence.ts incomplete(), a reporting
  // failure of that file) and the reason a source that is partial because of it shows (src/snapchat-report-finalization.ts, a report
  // warning registered in web/report-quality.js): 12,145 + 2 = 12,147. Measured: node tools/check-locales.mjs, catalog_messages 12147.
  // Merge r25-m1-merge, merge 3: r12-fix (12,147 on its own base of 12,138) on the diff package's 12,147 above. Both started from
  // 12,138 and add nine keys each, none of them the same: a script over the three versions of web/locales/ar.json (base, ours,
  // r12-fix) proves ar.json has 12,156 keys, no duplicate, every key of the base and of each side present with its own value, and
  // no key added by both. Measured on the merged catalogue (node tools/check-locales.mjs: catalog_messages 12156, problems none):
  // 12,138 + 9 (diff) + 9 (r12-fix) = 12,156.
  // Package r25-m2-reconcile (item 1, L5-05): +3 entries, the website's words for the automatic check of an uncertain write
  // (web/operations-center.js: that AMCP made it, when it looks again, and that its attempts ran out; website messages, not
  // refusal reasons): 12,156 + 3 = 12,159. Measured: node tools/check-locales.mjs, catalog_messages 12159.
  // Its rework (lead review): +2 entries, the Arabic of the two refusals of the permanent supersede (S2-2: a replaced write is settled, and
  // a check is dropped when the write settles while the provider is read), and +3, the Arabic of the remedies of the duplicate guard's two
  // codes (S3-5: DUPLICATE_OF_UNCERTAIN_WRITE for a create AMCP can look up and for one it cannot, and DUPLICATE_OF_COMPLETED_WRITE):
  // 12,159 + 5 = 12,164. Measured: node tools/check-locales.mjs, catalog_messages 12164.
  // Package r25-m2-refusal (Round 2.5, M2: L1-08) adds one key: the remedy of a rejected TikTok parameter refusal, in English and Arabic (12,157 on its
  // own base of 12,156).
  // Merge r25-m2-merge, merge 2: r25-m2-refusal (12,157 on its own base of 12,156) on r25-m2-reconcile's 12,164 above. The two sets of keys are
  // disjoint (web/locales/ar.json merged with no marker), so the merged catalogue measures, with this test's own inspector
  // (node tools/check-locales.mjs: catalog_messages 12165), 12,156 + 8 (reconcile) + 1 (refusal) = 12,165.
  // r12-gpreview item 2: one key, "Generate", the operation word that the review pages show for a Google shareable-preview
  // generation (web/campaign-workflows.js and web/operations-center.js), which read "Change" before: 12,156 + 1 = 12,157.
  // Measured: node tools/check-locales.mjs, catalog_messages 12157, problems none.
  // r12-gpreview item 3: two keys, the message and the remedy of the refusal of a write whose provider answer did not match what
  // AMCP reviewed (failedWrite in src/service.ts, reviewRemedy in src/errors.ts): 12,157 + 2 = 12,159. Measured:
  // node tools/check-locales.mjs, catalog_messages 12159, required_messages 11023, problems none.
  // Merge r25-m2-merge, merge 3: r12-gpreview (12,159 on its own base of 12,156) on the 12,165 above. gpreview's three keys are in no
  // other package's web/locales/ar.json (merged with no marker), so the merged catalogue measures, with this test's own inspector
  // (node tools/check-locales.mjs: catalog_messages 12168, required_messages 11032, problems none), 12,165 + 3 = 12,168.
  // Package r12-xpreview (item 2): +4 entries, the Arabic of the sentences X's previews answer with and refuse with now that
  // amcp_ad_previews reads them (src/x-ad-previews.ts: the expiry X does not state, the two reasons an entry has no link, and
  // the refusal of a filter that is not one of X's own IDs), and the sentence that said X's previews were not qualified leaves
  // (-1): 12,156 + 4 - 1 = 12,159. Measured: node tools/check-locales.mjs, catalog_messages 12159.
  // Its item 3: +4 entries, the website's wording of an X entry on the Preview your ads page (the Tweet, the promoted Tweet and the
  // promoted Tweets that share it: web/ad-previews.js previewIdentity) and of the hint beside the ad IDs, shown for X alone:
  // 12,159 + 4 = 12,163. Measured: node tools/check-locales.mjs, catalog_messages 12163.
  // Its review round (S4-5): +1 entry, the sentence of X's answer for a Tweet ID that is not among the account's dark Tweets
  // (src/x-ad-previews.ts xDarkTweetNotFound, in web/locales/ar/providers.json), kept as short as its English allows: 12,163 + 1 =
  // 12,164. Measured: node tools/check-locales.mjs, catalog_messages 12164.
  // Merge r25-m2-merge, merge 4: r12-xpreview (12,164 on its own base of 12,156, +8 net) on the 12,168 above. Its keys are in no other
  // package's web/locales/ar.json (merged with no marker), so the merged catalogue measures, with this test's own inspector
  // (node tools/check-locales.mjs: catalog_messages 12176, required_messages 11037, problems none), 12,168 + 8 = 12,176.
  // Package r25-ar-lazy (item 3): +1 entry, the Arabic of the one sentence a page says in place of a refusal's message when the
  // Arabic chunk that holds it cannot load (web/route-assets.js uiAnswerWithoutUnloaded): measured (node tools/check-locales.mjs:
  // catalog_messages 12157, problems none), 12,156 + 1 = 12,157.
  // Merge r25-m2-merge, merge 5: r25-ar-lazy (12,157 on its own base of 12,156) on the 12,176 above. Its one key is in no other package's
  // web/locales/ar.json (merged by taking the union: every package appends at the end, so the conflict was the last line's comma), so the
  // merged catalogue measures, with this test's own inspector (node tools/check-locales.mjs: catalog_messages 12177, problems none),
  // 12,176 + 1 = 12,177.
  // Package r25-m3-targeting (item 1, G6): +4 entries, the Arabic of the four sentences of Demand Gen's location and language targeting
  // (src/google-targeting-writes.ts: the refusal of an ad group's exclusion of either, the ad group whose campaign's channel was not read,
  // the ad group of another channel, and the campaign-level form on a Demand Gen campaign): 12,177 + 4 = 12,181. Measured:
  // node tools/check-locales.mjs, catalog_messages 12181, problems none.
  // Its item 2 (G8, Q1): +1 entry, the Arabic of the spend sentence of a Google build, which now says that its children may start ENABLED
  // under an existing campaign or ad group that serves (src/google-atomic-builds.ts, a family's message, not an owned reason): 12,181 + 1 =
  // 12,182. Measured: node tools/check-locales.mjs, catalog_messages 12182, problems none.
  // Round 2 (S2-1): +1 entry, the Arabic of the refusal of an ad-group location or language on a Demand Gen campaign created without
  // upgraded targeting (src/google-targeting-writes.ts): 12,182 + 1 = 12,183. Measured: catalog_messages 12183, problems none.
  // Package r25-m3-pmax (Round 2.5, M3: L2-07, G2): +4 entries, the Arabic of the four remedies it declares for Google's asset link and
  // Performance Max refusals (src/google-remedies.ts: INVALID_ASSET_LINK, ASSET_TYPE_MISMATCH, PMAX_ASSET_MINIMUMS, PMAX_ASSET_TYPE_MISMATCH;
  // remedies, not refusal reasons, so owned.size does not move): measured (node tools/check-locales.mjs: catalog_messages 12181, problems
  // none), 12,177 + 4 = 12,181. Whoever merges it adds the keys of every package it is merged with to this number.
  // Package r25-m3-pmax, G3: +6 entries, the Arabic of its three direct refusals (src/google-asset-links.ts: the ratio and the two minimums)
  // and its three read refusals (above), and the asset-link remedy of ASSET_TYPE_MISMATCH reworded in the same package (no key added or
  // removed by that): measured (node tools/check-locales.mjs: catalog_messages 12187, problems none), 12,181 + 6 = 12,187.
  // Package r25-m3-pmax, round 2 (S3-1): +1 entry, the Arabic of the brand-asset level refusal above (measured: catalog_messages
  // 12188, problems none), 12,187 + 1 = 12,188.
  // Round 2 (S4-5, part 1): +1 entry, the Arabic of the retail asset group's missing final URL refusal (measured: catalog_messages
  // 12189, problems none), 12,188 + 1 = 12,189. Round 2's S3-2 replaced the Arabic of the PMAX_ASSET_MINIMUMS remedy in place: no key.
  // Round 3: N1 replaced the Arabic of the final URL refusal in place (the English key changed, so the old key is gone and the new one
  // stands in its place): no change; N2 adds +1 entry, the Arabic of the campaign-level brand refusal above (measured: catalog_messages
  // 12190, problems none), 12,189 + 1 = 12,190.
  // Merge r25-m3-merge, merge 2: r25-m3-pmax (12,190 on its own base of 12,177) on r25-m3-targeting's 12,183 above. pmax's 13 keys are in
  // no other package's web/locales/ar.json (merged by taking the union: every package appends at the end, so the conflict was the last
  // line's comma), so the merged catalogue measures, with this test's own inspector (node tools/check-locales.mjs: catalog_messages
  // 12196, problems none), 12,177 + 6 (targeting) + 13 (pmax) = 12,196.
  // Package r25-m3-trees (Round 2.5, M3, item 1: L2-06, G4c): +3 entries, the Arabic of the three sentences of TEMP_ID_CHAIN_TOO_LONG (a chain
  // linked by temporary names over the limit of its route: 25, a product tree review's 500, a build's 1,000; src/google-temp-names.ts),
  // appended at the end of web/locales/ar.json: 12,177 + 3 = 12,180. Measured: node tools/check-locales.mjs, catalog_messages 12180.
  // Its item 2: +3 entries, the Arabic of the three sentences of the Standard Shopping node adapter that are fixed (the ad group already has a
  // root; it would have no tree; a tree needs a unit; src/google-shopping-tree.ts): 12,180 + 3 = 12,183. Measured: node tools/check-locales.mjs,
  // catalog_messages 12183, required_messages 11041, problems none.
  // Its item 5: +2 entries, the Arabic of the two fixed refusals of a tree in a build (a tree of an asset group that exists belongs to the
  // tree review; a tree under a new asset group while the temporary-parent switch is off; src/google-build-trees.ts): 12,183 + 2 = 12,185.
  // Measured: node tools/check-locales.mjs, catalog_messages 12185, required_messages 11042, problems none.
  // Its item 7 (G5 route B): +5 entries, the Arabic of the five fixed refusals of the Standard Shopping tree review that the Performance Max
  // one has a twin of (one ad group per review; each operation creates or removes one listing group; only listing group creates and removals;
  // the state read of the ad group; the rows of its tree): 12,185 + 5 = 12,190. Measured: node tools/check-locales.mjs, catalog_messages 12190,
  // required_messages 11047, problems none.
  // Its item 6 (G5 route A): +2 entries, the Arabic of the two fixed refusals of a Standard Shopping tree inside a build that the Performance
  // Max build tree has a twin of (a tree of an ad group that exists; a tree under a new ad group while Q7's switch is off; both in
  // src/google-build-trees.ts): 12,190 + 2 = 12,192. Measured: node tools/check-locales.mjs, catalog_messages 12192, required_messages 11049.
  // Its item 8 (G7): +1 entry, the Arabic of the refusal of enable_local: false on a Shopping campaign create (src/google-ads-adapter.ts,
  // googleWriteShape; a sentence this inventory does not read, so owned.size does not move): 12,192 + 1 = 12,193. Measured: node
  // tools/check-locales.mjs, catalog_messages 12193, required_messages 11049.
  // Its item 9 (L2-07): +6 entries, the Arabic of the six remedy actions that src/google-remedies.ts now declares (a product tree refused
  // in the Performance Max review or in a build; the same for Standard Shopping; a chain of temporary names over a route's limit, and
  // over a build's), which the inventory counts as shared recovery hints, so owned.size does not move: 12,193 + 6 = 12,199. Measured:
  // node tools/check-locales.mjs, catalog_messages 12199, required_messages 11055.
  // Round 2 (lead review of r25-m3-trees), S3-1 and S4-5: +6 entries, the Arabic of the four refusals of a tree Google refuses at execute
  // (a dimension twice on a path; a level without the level before it; the "Other" node of a level refined by the hierarchy; a bid on an
  // excluded unit) and of the two Shopping refusals whose node name moved into the details, so each is one fixed sentence now (a bid on a
  // subdivision; a negative subdivision): 12,199 + 6 = 12,205. Measured: node tools/check-locales.mjs, catalog_messages 12205,
  // required_messages 11061.
  // Round 2, S3-4: +1 entry, the Arabic of the remedy of a tree review over 500 operations (src/google-remedies.ts): 12,205 + 1 = 12,206.
  // Measured: node tools/check-locales.mjs, catalog_messages 12206, required_messages 11062.
  // Round 3, N6: no entry added. The sentence of a tree review over 500 operations lost its plan clause (src/google-temp-names.ts), so the
  // Arabic of the old sentence is replaced in place: 12,206 stays.
  // Merge r25-m3-merge, merge 3: r25-m3-trees (12,206 on its own base of 12,177) on the 12,196 above. trees' 29 keys are in no other
  // package's web/locales/ar.json (merged by taking the union: every package appends at the end, so the conflict was the last line's
  // comma), so the merged catalogue measures, with this test's own inspector (node tools/check-locales.mjs: catalog_messages 12225,
  // required_messages 11080, problems none), 12,177 + 6 (targeting) + 13 (pmax) + 29 (trees) = 12,225.
  // Package r25-m3-dupstep (Round 2.5, M3: a plan step held by the duplicate guard): +3 entries, website wording and no refusal reason
  // (web/campaign-workflows.js campaignDuplicateWords and campaignEarlierPlanLink): the page's own message and remedy for
  // DUPLICATE_OF_UNCERTAIN_WRITE (the server's text names next_call and supersedes_review_id, which a person never uses) and the label of
  // the link to the plan that holds the earlier create: measured (node tools/check-locales.mjs: catalog_messages 12180, problems none),
  // 12,177 + 3 = 12,180.
  // Package r25-m3-dupstep, fix round 2, item 4 (lead review S3-1): +1 entry, the sentence beside the Amend form's tick box, which no longer
  // promises that saving invalidates the plan approval when the amendment may change nothing (web/campaign-workflows.js amend): measured
  // (node tools/check-locales.mjs: catalog_messages 12181, problems none), 12,180 + 1 = 12,181.
  // Package r25-m3-dupstep, fix round 2, item 2 (lead review S2-1 a and S3-2): +2 entries net, the page's remedy for a held step by what the refusal
  // says (web/campaign-workflows.js campaignDuplicateWords): the usual remedy now keeps the branch for a create that was applied (it replaces the
  // one that led to preparing the step again: -1, +1), and two more for a create AMCP cannot look up and for a colleague's (+2): measured
  // (node tools/check-locales.mjs: catalog_messages 12183, problems none), 12,181 - 1 + 3 = 12,183.
  // Package r25-m3-dupstep, fix round 2, item 5 (lead review S3-3): +2 entries, the page's own message and remedy for a step held for a twin that
  // completed (DUPLICATE_OF_COMPLETED_WRITE at execute; web/campaign-workflows.js campaignDuplicateWords): measured
  // (node tools/check-locales.mjs: catalog_messages 12185, problems none), 12,183 + 2 = 12,185.
  // Package r25-m3-dupstep, fix round 2, item 3 (lead review S2-2): +2 entries, the page's warning of a review that repeats a create completed in
  // the last ten minutes and the label of the person's own tick for it (web/campaign-workflows.js reviewDuplicateNotice and
  // reviewConsentLabels.duplicate_acknowledged): measured (node tools/check-locales.mjs: catalog_messages 12187, problems none),
  // 12,185 + 2 = 12,187.
  // Package r25-m3-dupstep, fix round 3, item 3 (lead re-review S4-c): +1 entry, the page's own refusal of a save of the Amend form that changes nothing, for
  // a step the guard against creating twice holds (web/campaign-workflows.js amend): the engine's refusal of it is English with agent names and no Arabic:
  // measured (node tools/check-locales.mjs: catalog_messages 12188, problems none), 12,187 + 1 = 12,188.
  // Package r25-m3-dupstep, fix round 3, item 4 (lead re-review S4-d): 0 net, the remedy of a step held for a twin that completed reworded in place, because
  // it promised a warning that comes only within ten minutes of the completion (web/campaign-workflows.js campaignDuplicateWords): one key out, one in:
  // measured (node tools/check-locales.mjs: catalog_messages 12188, problems none), 12,188 - 1 + 1 = 12,188.
  // Merge r25-m3-merge, merge 4: r25-m3-dupstep (12,188 on its own base of 12,177) on the 12,225 above. dupstep's 11 net keys are in no
  // other package's web/locales/ar.json (merged by taking the union: every package appends at the end, so the conflict was the last
  // line's comma), so the merged catalogue measures, with this test's own inspector (node tools/check-locales.mjs: catalog_messages
  // 12236, required_messages 11091, problems none), 12,177 + 6 (targeting) + 13 (pmax) + 29 (trees) + 11 (dupstep) = 12,236.
  // Package r25-field-snap (Round 2.5 field fix, item 3, #9): +1 entry, the Arabic of the shape refusal of result_ids that is no
  // JSON array of IDs (src/snapchat-result-ids.ts, web/locales/ar/providers.json): 12,177 + 1 = 12,178. Measured:
  // node tools/check-locales.mjs, catalog_messages 12178, problems none.
  // Merge r25-m3-merge, merge 6: r25-field-snap (12,178 on its own base of 12,177) on the 12,236 above. snap's one key is in no other
  // package's web/locales/ar.json (it merged with no marker: it sits in the middle of the file, clear of the appended tail), so the
  // merged catalogue measures, with this test's own inspector (node tools/check-locales.mjs: catalog_messages 12237,
  // required_messages 11092, problems none), 12,236 + 1 = 12,237.
  // Package r25-field-tiktok (#2): +1 entry, the Arabic of the refusal of a classic ad create in an Upgraded Smart+ ad group (one more
  // owned reason above): measured (node tools/check-locales.mjs: catalog_messages 12178, problems none), 12,177 + 1 = 12,178.
  // Its item 3 (#6): +2 entries, the Arabic of the count template above and of the refusal of a product_info_enabled other than UNSET
  // (a wrapper reason, counted in tests/backend-wrapper-localization.test.mjs): measured (node tools/check-locales.mjs:
  // catalog_messages 12180, problems none), 12,178 + 2 = 12,180.
  // Its round 2 (S3-1) replaces the count template's entry with the Arabic of the remedy that says there are more rules (a shared
  // recovery hint, counted in tests/shared-recovery-localization.test.mjs): measured (node tools/check-locales.mjs:
  // catalog_messages 12180, problems none), 12,180 - 1 + 1 = 12,180.
  // Its S4-3 (round 2): +1 entry, the Arabic of the refusal of a review that is not the caller's, when it is named in
  // supersedes_review_id and was never sent (a wrapper reason of src/write-reconciliation.ts, counted in
  // tests/backend-wrapper-localization.test.mjs, so owned.size above does not move): measured (node tools/check-locales.mjs:
  // catalog_messages 12181, problems none), 12,180 + 1 = 12,181.
  // Merge r25-m3-merge, merge 7: r25-field-tiktok (12,181 on its own base of 12,177) on the 12,237 above. tiktok's 4 net keys are in no
  // other package's web/locales/ar.json (merged by taking the union: every package appends at the end, so the conflict was the last
  // line's comma), so the merged catalogue measures, with this test's own inspector (node tools/check-locales.mjs: catalog_messages
  // 12241, required_messages 11096, problems none), 12,177 + 6 (targeting) + 13 (pmax) + 29 (trees) + 11 (dupstep) + 1 (snap) + 4 (tiktok) = 12,241.
  // Package r25-media-drive-large (item 2): +8 entries, the Arabic of the five owned sentences counted above and of the three remedies of
  // a refused public Drive download (not shared, download quota, flagged: src/errors.ts workflowRemedy). The two replaced sentences stay
  // in the catalogue, unused. Inserted beside the Drive sentence they follow, not at the end. Measured (node tools/check-locales.mjs:
  // catalog_messages 12185, required_messages 11044, problems none): 12,177 + 8 = 12,185.
  // Its item 3: +3 entries, the Arabic of the three download sentences counted above (idle, too long, stopped before the whole file
  // arrived), beside the Drive sentences. Measured (node tools/check-locales.mjs: catalog_messages 12188, required_messages 11047,
  // problems none): 12,185 + 3 = 12,188.
  // Its fix round 2 (S4-1): +1 entry, the Arabic of the sentence counted above, beside the download sentences. Measured
  // (node tools/check-locales.mjs: catalog_messages 12189, required_messages 11048, problems none): 12,188 + 1 = 12,189.
  // Merge r25-m3-merge, merge 8: r25-media-drive-large (12,189 on its own base of 12,177) on the 12,241 above. media's 12 keys are in no
  // other package's web/locales/ar.json (it merged with no marker: media inserts them beside the Drive sentences, not at the end, so
  // the file needed no hand merge), so the merged catalogue measures, with this test's own inspector (node tools/check-locales.mjs:
  // catalog_messages 12253, required_messages 11106, problems none), 12,177 + 6 (targeting) + 13 (pmax) + 29 (trees) + 11 (dupstep) +
  // 1 (snap) + 4 (tiktok) + 12 (media) = 12,253.
  // Package r25-field-gclone (items 1, 2 and 5): +5 entries, the Arabic of the four sentences the Google clone says of
  // source.ad_group_ids and source.languages (src/google-campaign-clone.ts) and of the refusal of those keys on another platform
  // (src/campaign-clone.ts), in web/locales/ar/providers.json: 12,177 + 5 = 12,182. Measured: node tools/check-locales.mjs,
  // catalog_messages 12182, problems none. Its round 2 (the lead, 2026-11-20): +1 entry, the Google variant of the sentence of a source that did not
  // fit the pages AMCP reads (src/google-campaign-clone.ts); the shared remedy of every CLONE_ refusal (src/errors.ts) gained a sentence in place, its
  // Arabic entry renamed with it, so it adds none: 12,182 + 1 = 12,183. Measured: node tools/check-locales.mjs, catalog_messages 12183, problems none.
  // Merge r25-m3-merge, merge 10: r25-field-gclone (12,183 on its own base of 12,177) on the 12,253 above. gclone's 6 keys are in no
  // other package's web/locales/ar.json (it merged with no marker: gclone inserts them in the middle of the file, and the remedy it
  // renames in place has no other edit), so the merged catalogue measures, with this test's own inspector (node tools/check-locales.mjs:
  // catalog_messages 12259, required_messages 11112, problems none), 12,177 + 6 (targeting) + 13 (pmax) + 29 (trees) + 11 (dupstep) +
  // 1 (snap) + 4 (tiktok) + 12 (media) + 6 (gclone) = 12,259.
  // Package r25-field-callshape (item 2): +2 entries, the Arabic of the two sentences above (the second is a template with a {field} slot,
  // which the Arabic keeps): measured (node tools/check-locales.mjs: catalog_messages 12179), 12,177 + 2 = 12,179.
  // Merge r25-m3-merge, merge 11: r25-field-callshape (12,179 on its own base of 12,177) on the 12,259 above. callshape's 2 keys are in no
  // other package's web/locales/ar.json (merged by taking the union: callshape appends at the end, as dupstep does, so the conflict was
  // the last line's comma), so the merged catalogue measures, with this test's own inspector (node tools/check-locales.mjs:
  // catalog_messages 12261, required_messages 11114, problems none), 12,177 + 6 (targeting) + 13 (pmax) + 29 (trees) + 11 (dupstep) +
  // 1 (snap) + 4 (tiktok) + 12 (media) + 6 (gclone) + 2 (callshape) = 12,261.
  // Package r25-field-plan, item 3 (the lead's re-review of dupstep, R-2): 0 net, the usual remedy and the colleague's remedy of a held step reworded in place, because
  // the step now replaces an earlier create that was found not applied, and a colleague's is replaced where it was prepared (web/campaign-workflows.js
  // campaignDuplicateWords): two keys out, two in: measured (node tools/check-locales.mjs: catalog_messages 12188, problems none), 12,188 - 2 + 2 = 12,188.
  // Package r25-field-plan, round 2, item 2 (lead review S3-1): +1 entry, the badge the plan approval puts on each step that can change spending or
  // serving (web/campaign-workflows.js approvalView), and the tick beside it reworded in place to name the steps marked (one key out, one in):
  // measured (node tools/check-locales.mjs: catalog_messages 12189, problems none), 12,188 + 1 = 12,189.
  // Merge r25-m3-merge, merge 13: r25-field-plan (12,189 on its own base of 12,188) on the 12,261 above. plan's one net key (the approval badge) is
  // in no other package's web/locales/ar.json, and its two keys reworded in place replaced dupstep's two where they stood (the file merged with
  // no marker and has no duplicate key), so the merged catalogue measures, with this test's own inspector (node tools/check-locales.mjs:
  // catalog_messages 12262, required_messages 11115, problems none), 12,261 + 1 = 12,262.
  // Merge r25-m3-merge, the last code commit: +1 entry, the Arabic of the rewritten impact sentence of a Google build (googleAtomicImpact
  // `meaning` in src/google-atomic-builds.ts: it now says that an ENABLED child serves as soon as it is created under an existing campaign
  // that serves, Q1's rule). The old sentence had no Arabic entry, so it leaves none. Measured (node tools/check-locales.mjs:
  // catalog_messages 12263, required_messages 11115, problems none): 12,262 + 1 = 12,263.
  // Package r25-m3-live, F2: the Arabic of one new fixed refusal, a Standard Shopping create that sends a status other than ENABLED (Google does not
  // keep a listing group's status; src/google-shopping-tree.ts shoppingCreate). Its old sentence was built with the field path and had no entry.
  // Measured, not summed (node tools/check-locales.mjs: catalog_messages 12264, required_messages 11116, problems none).
  // Package r25-m3-live, F3: the Arabic of one more fixed refusal, a campaign language criterion on a Shopping campaign (Google refuses it;
  // src/google-targeting-writes.ts refuseShoppingLanguage). Measured again (catalog_messages 12265, required_messages 11117, problems none).
  // Package r25-m3-live, F4: the Arabic of one more fixed refusal, a unit that bids created without cpc_bid_micros under a Manual CPC campaign
  // (src/google-shopping-tree.ts assertUnitBids). Measured again (catalog_messages 12266, required_messages 11118, problems none).
  // Package r25-field2-google, G3: the Arabic of one new shared recovery hint, the next step of a state refusal whose reason is a rule of the
  // conversion goal graph (src/errors.ts familyRemedy). It is a remedy, not a refusal reason, so owned.size does not move. Measured, not
  // summed (node tools/check-locales.mjs: catalog_messages 12267, required_messages 11119, problems none).
  // Package r25-m4-smartweb, item 1 (Smart+ click ad groups, src/tiktok-smart-plus-adgroups.ts): +7 entries, the Arabic of seven new fixed
  // sentences (landing page views are not qualified yet; a click ad group takes no pixel, event, custom conversion or attribution setting;
  // its custom bid is bid_price and never conversion_bid_price, and the reverse; a click bid is needed with BID_TYPE_CUSTOM and refused with
  // BID_TYPE_NO_BID; click ad groups bill with CPC), and the sentence of the goal reworded in place to name CONVERT and CLICK (one key out,
  // one in). Measured (node tools/check-locales.mjs: catalog_messages 12270, problems none): 12,263 + 7 = 12,270.
  // Package r25-m4-smartweb, item 1b (landing page views, qualified from TikTok's pages as the lead's documentation session read them on
  // 2026-11-20): -1 entry, the sentence that refused TRAFFIC_LANDING_PAGE_VIEW as not qualified; the goal's, the pixel-free and the OCPM billing
  // sentences are reworded in place to name the goal (one key out, one in each). Measured (node tools/check-locales.mjs: catalog_messages
  // 12269, problems none): 12,270 - 1 = 12,269.
  // Package r25-m4-smartweb, item 3 (the two guided Upgraded Smart+ website packs, src/tiktok-smart-plus-recipe.ts and web/campaign-recipes.js):
  // +19 entries, none removed: the two pack titles (2), the two pack descriptions (2), the two "uses" lines (2), the two impact lines
  // (2), the seven fixed sentences of the packs (call_to_action_id in place of call_to_action; the numeric ID of a dynamic CTA portfolio;
  // no optimization_goal on the purchases pack; the traffic pack's refusal of a pixel or an event, which names both of its goals, the
  // classic pack's sentence naming clicks alone; the two traffic goals; a CTA portfolio TikTok did not return; a portfolio that is not
  // dynamic) (7), the meaning of the CTA portfolio asset (1), the two labels of the portfolio (2), and the label of the automatic click
  // bidding dependency (1). Measured (node tools/check-locales.mjs: catalog_messages 12288, problems none; the key set of
  // web/locales/ar.json compared with HEAD's: 19 added, none removed): 12,269 + 19 = 12,288.
  // Package r25-m4-smartweb, round 2 (the lead's review of eb0c133f), S2-1: +2 entries, the Arabic of the two fixed sentences it adds: the packs'
  // refusal of an end time (src/tiktok-smart-plus-recipe.ts), and the Smart+ ad group contract's rule that a schedule with an end needs a total
  // budget (src/tiktok-smart-plus-adgroups.ts, raised by both of its checks). Measured (node tools/check-locales.mjs: catalog_messages 12290,
  // problems none): 12,288 + 2 = 12,290.
  // Merge r25-m4a-merge, merge 1: r25-m4-smartweb (12,290 on its own base of 12,263: 31 entries added, 4 removed) on the 12,267 above. Measured, not summed (node tools/check-locales.mjs: catalog_messages 12294, required_messages 11139, problems none): 12,267 + 27 = 12,294.
  // Package r25-m4-classic (Round 2.5, M4: L1-03): +6 entries, the Arabic of the six refusals of an ad update in TikTok's own shape
  // (src/tiktok-state-reads.ts, all owned reasons): measured (node tools/check-locales.mjs: catalog_messages 12269, required_messages 11121,
  // problems none), 12,263 + 6 = 12,269. Whoever merges it adds the keys of every package it is merged with to this number.
  // Its item 2: +1 entry, the Arabic of the refusal of a classic ad group create in an Upgraded Smart+ campaign (src/tiktok-manual-ad-identities.ts):
  // measured (node tools/check-locales.mjs: catalog_messages 12270, required_messages 11122, problems none), 12,269 + 1 = 12,270.
  // Its item 3: +1 entry, the Arabic of the refusal of a clone of a TikTok campaign that is not a manual one (src/tiktok-campaign-clone.ts):
  // measured (node tools/check-locales.mjs: catalog_messages 12271, required_messages 11123, problems none), 12,270 + 1 = 12,271.
  // Its item 5 (the 2027-01-01 cut-off, the lead's decision L2): +1 entry, the Arabic of the static sentence the website purchases pack's context
  // gains (src/tiktok-launch-recipes.ts: TikTok stops manual website purchase campaigns on 2027-01-01; use tiktok_smart_plus_website_conversions). Its
  // refusals are composed by the deprecation registry (PROVIDER_DEPRECATED, as DV360's and Reddit's are) and are no owned reason: measured
  // (node tools/check-locales.mjs: catalog_messages 12272, required_messages 11123, problems none), 12,271 + 1 = 12,272.
  // Its follow-up to item 1: +1 entry, the Arabic of the refusal of an ad update in TikTok's own shape whose adgroup_id is not numeric text
  // (src/tiktok-state-reads.ts): measured (node tools/check-locales.mjs: catalog_messages 12273, required_messages 11124, problems none),
  // 12,272 + 1 = 12,273.
  // Its corrections after the documentation session: +1 entry, the Arabic of the refusal of a change to a field outside the ten of an ad update in
  // TikTok's own shape, and two entries replaced in place (the limit of 20 creatives, the patch_update sentence): measured (node tools/check-locales.mjs:
  // catalog_messages 12274, required_messages 11125, problems none), 12,273 + 1 = 12,274.
  // Its round 2 (the lead's review, 2026-11-21), S3-3: +1 entry, the Arabic of the refusal of an ad update whose ad's row names no ad group that reads
  // as an ID (src/tiktok-state-reads.ts, an owned reason): measured (node tools/check-locales.mjs: catalog_messages 12275, required_messages 11126,
  // problems none), 12,274 + 1 = 12,275.
  // S3-4: +1 entry, the Arabic of the refusal of a key beside the creatives of an ad update in TikTok's own shape (src/tiktok-state-reads.ts, an owned
  // reason): measured (node tools/check-locales.mjs: catalog_messages 12276, required_messages 11127, problems none), 12,275 + 1 = 12,276.
  // S3-1: +4 entries, the Arabic of the refusals of the 2027-01-01 cut-off (src/tiktok-manual-cutoff.ts): the three templates of a campaign create, an
  // ad group create and a clone, one for each advice a create is given, and the purchases pack's fixed sentence with its citation. They are no owned
  // reason (the refusals are given to refuseDeprecated, not to an error's constructor), so tests/tiktok-manual-cutoff.test.mjs keeps them: measured
  // (node tools/check-locales.mjs: catalog_messages 12280, required_messages 11127, problems none), 12,276 + 4 = 12,280.
  // The lead's added item (2026-11-21): +1 entry, the Arabic of the static notice the classic website traffic pack's context gains, of what TikTok's
  // Upgraded Smart+ migration guide says about manual campaigns (src/tiktok-launch-recipes.ts), not an owned or a wrapper reason: measured (node
  // tools/check-locales.mjs: catalog_messages 12281, required_messages 11127, problems none), 12,280 + 1 = 12,281.
  // Merge r25-m4a-merge, merge 2: r25-m4-classic (12,281 on its own base of 12,263: 18 entries added, none removed) on the 12,294 above. Measured, not summed (node tools/check-locales.mjs: catalog_messages 12312, problems none): 12,294 + 18 = 12,312.
  // Package r25-m4-smartdelete: +3 entries, the Arabic of the Smart+ deletion family's three new sentences (the pause-first refusal,
  // the SKAN postback refusal and an ad outside the reviewed campaigns). Measured on its base 37ec65ba (node tools/check-locales.mjs:
  // catalog_messages 12266, required_messages 11118, problems none): 12,263 + 3 = 12,266.
  // Its lead review round (S4-7, the documentation answers): +3 entries, the Arabic of the deletion's three effect sentences, one
  // per kind (tiktokSmartPlusDeletionImpact `effect`; like the Google build's impact sentence, the checker does not require them).
  // Measured (node tools/check-locales.mjs: catalog_messages 12269, required_messages 11118, problems none): 12,266 + 3 = 12,269.
  // Merge r25-m4a-merge, merge 3: r25-m4-smartdelete (12,269 on its own base of 12,263: six entries added, none removed) on the 12,312 above. Measured, not summed (node tools/check-locales.mjs: catalog_messages 12318, problems none): 12,312 + 6 = 12,318.
  // Package r25-m4-smartedits (Round 2.5, M4: T5): +7 entries, the Arabic of the seven fixed sentences of the contract of an ad-level pixel and of the
  // keys TikTok returns with every Smart+ ad (src/tiktok-smart-plus-ads.ts, src/tiktok-smart-plus-pixels.ts), at the end of web/locales/ar.json.
  // Measured (node tools/check-locales.mjs: catalog_messages 12270, required_messages 11122, problems none): 12,263 + 7 = 12,270.
  // Its item 2 (the probe of a website ad's pixel edit): +1 entry, the Arabic of the impact note that says TikTok decides (src/tiktok-smart-plus-ad-updates.ts;
  // a constant no refusal raises, so it is no required message): catalog_messages 12271, required_messages 11122: 12,270 + 1 = 12,271.
  // Its item 3 (the ad_configuration patch): +4 entries, the Arabic of the sentences of the patch's own refusals (an object naming a key; a patch beside ad_configuration;
  // the merged configuration handed back) and of the remedy of that answer (src/tiktok-remedies.ts): catalog_messages 12275, required_messages 11126: 12,271 + 4 = 12,275.
  // Its item 5 (T6, the schedule of a Smart+ ad group): +1 entry, the Arabic of the sentence that refuses a start time that is not in the future (owned by
  // tests/backend-wrapper-localization.test.mjs): catalog_messages 12276, required_messages 11127: 12,275 + 1 = 12,276.
  // Its round 2 (the lead's review, S3-8): +1 entry, the Arabic of the sentence that refuses a catalog_creative_toggle other than false (owned by
  // tests/backend-wrapper-localization.test.mjs): catalog_messages 12277, required_messages 11128: 12,276 + 1 = 12,277.
  // Whoever merges it adds the entries of every package it is merged with to this number.
  // Merge r25-m4a-merge, merge 4: r25-m4-smartedits (12,277 on its own base of 12,263: 14 entries added, none removed) on the 12,318 above. Measured, not summed (node tools/check-locales.mjs: catalog_messages 12332, problems none): 12,318 + 14 = 12,332.
  // Package r25-m4-search, item 1 (the Search pack, server side): +11 entries, the Arabic of the pack's name, description and limitation,
  // of the effect its dependencies declare and of its allowlist evidence, and of the six sentences of its keyword and pixel refusals
  // (src/tiktok-search-recipe.ts, src/capability-eligibility.ts). Measured (node tools/check-locales.mjs: catalog_messages 12274,
  // problems none), 12,263 + 11 = 12,274 on its own base.
  // Its migration notice (the lead's addition of 2026-11-21: the date TikTok's migration guide names for creating Manual Campaigns, in the pack's
  // context): +1 entry, 12,274 + 1 = 12,275 (node tools/check-locales.mjs: catalog_messages 12275, problems none).
  // Item 1, website side: +3 entries, the label of the pack's keywords (one MATCH_TYPE: keyword line each) and the labels of its two new
  // dependencies on the recipe page and the capability center (web/campaign-recipes.js, web/capability-center.js): 12,275 + 3 = 12,278
  // (node tools/check-locales.mjs: catalog_messages 12278, problems none).
  // The fix round (the lead's review S3-2): +4 entries, the Arabic of the four fixed sentences of the negative keyword gate
  // (src/tiktok-negative-keywords.ts: an ad group or a campaign of a Smart+ Search campaign, whose negative keywords are account level, and
  // one that is not a manual Search Ads campaign), which are now literals; the ID and the type TikTok returned are in the refusal's
  // details: 12,278 + 4 = 12,282 (node tools/check-locales.mjs: catalog_messages 12282, problems none).
  // S3-4 of the same round: +1 entry, the count under the keywords box of the Search pack on the website, "{count} of {limit} keywords"
  // (web/campaign-recipes.js; the box holds the 1,000 keywords the pack takes, and the refusal of a longer list is the compile's own sentence,
  // which has its Arabic): 12,282 + 1 = 12,283 (node tools/check-locales.mjs: catalog_messages 12283, problems none).
  // S4-3 of the same round: +1 entry, the Arabic of the refusal of a keyword that holds a line break or another control character
  // (src/tiktok-search-recipe.ts): 12,283 + 1 = 12,284 (node tools/check-locales.mjs: catalog_messages 12284, problems none).
  // Merge r25-m4a-merge, merge 5: r25-m4-search (12,284 on its own base of 12,263: 21 entries added, none removed) on the 12,332 above. Measured, not summed (node tools/check-locales.mjs: catalog_messages 12353, problems none): 12,332 + 21 = 12,353.
  // Package r25-m4-smartops (item 2): +1 entry, the Arabic of the spend acknowledgement it adds to src/preflight.ts (Q1: a child created active
  // under a parent the review reads as serving). Measured (node tools/check-locales.mjs: catalog_messages 12291, problems none): 12,290 + 1 = 12,291.
  // Merge r25-m4a-merge, merge 6: r25-m4-smartops (12,291 on its own base of 12,290: one entry added) on the 12,353 above. Measured, not summed (node tools/check-locales.mjs: catalog_messages 12354, problems none): 12,353 + 1 = 12,354.
  // Package r25-m4-search2, item 1 (a Smart+ Search campaign, src/tiktok-smart-plus-campaigns.ts): +1 entry, the Arabic of the one fixed sentence
  // it adds (is_search_campaign is a boolean). The sentence of an unknown key is spliced with the key, so it has no entry and loses "search"
  // from its list in place. Measured (node tools/check-locales.mjs: catalog_messages 12291, problems none): 12,290 + 1 = 12,291.
  // Package r25-m4-search2, item 2 (Search keywords on a Smart+ ad group, src/tiktok-smart-plus-adgroups.ts): +2 entries, the Arabic of the two
  // fixed sentences it adds: the rule of a keyword list, said once for every way a list can break it (the field names the item and the part),
  // and automated_keywords_enabled is a boolean. The sentences of the campaign check and the two reworded ones are spliced with an ID or a
  // key and have no entry. Measured (node tools/check-locales.mjs: catalog_messages 12293, problems none): 12,291 + 2 = 12,293.
  // Package r25-m4-search2, item 5 (the guided Smart+ Search pack, src/tiktok-smart-plus-recipe.ts and the two web files): +10 entries, none
  // removed: the pack's title, description and context line (3), the effects sentence of its dependency entry (1), the three labels of its
  // new dependencies (the keywords, the Smart+ Search allowlist and the Search bidding) (3), and the three fixed sentences it raises
  // (a line of the wrong form, a goal that is neither CLICK nor CONVERT, a pixel with a click goal) (3). Its keyword list rule is the ad
  // group contract's own sentence, raised again with the recipe's code, so it adds no entry. Measured (node tools/check-locales.mjs:
  // catalog_messages 12303, problems none): 12,293 + 10 = 12,303.
  // Package r25-m4-search2, round 2, S2-1: +1 entry, the Arabic of the sentence that says a Search campaign needs budget_optimize_on set to
  // false; the three sentences of the pack that name its budget (its description, its context line, its dependency effects) were reworded and
  // renamed in place with their Arabic, so they add none. Measured (node tools/check-locales.mjs: catalog_messages 12304, problems none).
  // S2-2: +2 entries, the Arabic of the sentence that says a Search ad group sends MANUAL targeting and of the one that says it runs on the
  // TikTok search placement only. Measured (node tools/check-locales.mjs: catalog_messages 12306, problems none): 12,304 + 2 = 12,306.
  // S3-1: +1 entry, the Arabic of the sentence that says the rule of one keyword. Measured (node tools/check-locales.mjs: catalog_messages 12307,
  // problems none): 12,306 + 1 = 12,307.
  // Item 4: +3 entries, the Arabic of the three fixed sentences of the account level of the negative keywords (src/tiktok-account-negative-
  // keywords.ts). Measured (node tools/check-locales.mjs: catalog_messages 12310, problems none): 12,307 + 3 = 12,310.
  // Merge r25-m4a-merge, merge 7: r25-m4-search2 (12,310 on its own base of 12,290: 20 entries added, none removed; two of them are search's, with the same Arabic, and are kept once) on the 12,354 above. Measured, not summed (node tools/check-locales.mjs: catalog_messages 12372, problems none): 12,354 + 18 = 12,372.
  // Merge r25-m4a-merge, join 3 (the website keywords box of search and search2): +1 entry, the Arabic of the label of the Smart+ Search pack's keywords box, which says that hyphens and underscores are refused (web/campaign-recipes.js; a label, no owned or wrapper reason): node tools/check-locales.mjs: catalog_messages 12373, required_messages 11200, problems none: 12,372 + 1 = 12,373.
  // Package r25-field2-access, B6: the Arabic of one more shared recovery hint, the next step of an ownership refusal that names no read
  // (src/errors.ts, errorResult). It replaces, in that function's `remediation` table, the sentence that named details.next_call, which now
  // sits where the step is chosen and keeps its Arabic, so the inventory of required messages does not move. Measured, not summed (node
  // tools/check-locales.mjs: catalog_messages 12268, required_messages 11119, problems none).
  // Package r25-field2-access, B1: the Arabic of one new direct refusal, the pixel node read that names a field outside the six pinned
  // (src/meta-dataset-scope.ts), counted in owned.size and in the files that own a reason above. Measured (node tools/check-locales.mjs:
  // catalog_messages 12269, required_messages 11120, problems none).
  // Package r25-field2-access, B2: the Arabic of one more sentence, the block of the Meta pixel activation gate when the ad account does not
  // list the pixel (src/meta-recipe-activation.ts; a gate message this inventory does not read, so owned.size does not move). Measured
  // (node tools/check-locales.mjs: catalog_messages 12270, required_messages 11120, problems none).
  // Package r25-field2-access, B3: +8 entries: the six refusals of src/gtm-account-reads.ts (counted in owned.size above), the remedy of
  // GTM_ACCOUNT_NOT_CONNECTED (src/errors.ts, a shared recovery hint, tests/shared-recovery-localization.test.mjs) and the explanation of
  // the workflow's action contract row (src/provider-workflows.ts, shown by web/capability-center.js). Measured (node tools/check-locales.mjs:
  // catalog_messages 12278, required_messages 11128, problems none), 12,270 + 8 = 12,278.
  // Package r25-field2-access, lead review S4-5: the refusal of a plan that is not a native GET, which the workflow had worded with the
  // diagnostics' sentence (still the diagnostics' own), now says its own (src/gtm-account-reads.ts); owned.size above did not move
  // (measured). Measured (node tools/check-locales.mjs: catalog_messages 12279, required_messages 11129, problems none). The lead
  // review's S2-1 replaced the Arabic of B6's step one for one (12,278 and 11,128 stay).
  // Merge r25-m4a-merge, merge 8: r25-field2-access (12,279 on its own base of 12,267: 12 entries added, none removed) on the 12,373 above. Measured, not summed (node tools/check-locales.mjs: catalog_messages 12385, required_messages 11210, problems none): 12,373 + 12 = 12,385.
  assert.equal(Object.keys(catalog).length, 12385);
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
    // Package r25-m0-live (item 4): the sentence that replaced 'AccountId must match account_id.'.
    [
      'AccountId in the payload is not the account_id of the call. Send the same ID as a string in both, or leave AccountId out of the payload: AMCP fills it from account_id.',
      ['AccountId', 'account_id'],
    ],
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

// Package r25-field-gclone, round 3 (the lead's review, S4-5): the Arabic of the refusal of a selection key on a platform whose clone takes only
// campaign_id. The verb agrees with the noun it governs (the campaign is feminine: تُنسخ الحملة), and the sentence still names source and
// details.supported as the English does. The key is the English sentence, so the pins of the catalogue and of the owned reasons do not move.
test('the refusal of a clone selection key on another platform is shown in the reviewed Arabic sentence, in the catalogue, its chunk and the page', () => {
  const english =
      'A clone on this platform copies the whole campaign; source takes only the keys in details.supported.',
    arabic = 'تُنسخ الحملة كاملةً على هذه المنصة؛ ولا يقبل source إلا المفاتيح المذكورة في details.supported.';
  assert.ok(owned.has(english), 'the sentence is one this package owns');
  assert.equal(catalog[english], arabic);
  const chunk = JSON.parse(fs.readFileSync('web/locales/ar/providers.json', 'utf8'));
  assert.equal(chunk[english], arabic, 'the generated chunk holds the same sentence');
  const fixture = accountWorkflowFixture('ar');
  fixture.context.response = errorResult(
    new MirrorError(
      'CLONE_UNSUPPORTED',
      english,
      {field: 'source.ad_group_ids', unsupported: ['ad_group_ids'], supported: ['campaign_id']},
      400,
      false,
    ),
    'original-backend-reference',
    0,
  );
  fixture.context.error = fixture.run('requestError(response)');
  // The page names the field after the sentence, in place of its final full stop (details.supported: source.ad_group_ids).
  assert.ok(fixture.run('errorMessage(error)').includes(arabic.slice(0, -1) + ': source.ad_group_ids.'));
});
