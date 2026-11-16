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
  // Package r25-m1-diff (Round 2.5, M1: L5-04) adds src/review-diff.ts, which of the changed fields of a STATE_CHANGED
  // matter, with no reason of its own: one more on the integration's 816, 817 on its own base. Whoever merges it adds the
  // files of every package it is merged with to this number.
  assert.equal(files.length, 817);
  // V2-RPT-02 validates fallbacks and overrides in report-objectives.ts: three owned refusals.
  // V2-RPT-04 adds direct creative metadata ownership in linkedin-detail-parents.ts.
  // V2-PRV-01 adds the minimal Meta ad identity observer's account refusal.
  // Apple's detail collector (its campaign bound) and Snapchat's evidence (its zone refusal now names the zone) own reasons.
  // Package mcp-typed: src/report-read-filters.ts owns the two sentences of the filter refusals (V2-MCP-02): 297.
  assert.equal(selected.filter(row => row.messages.size).length, 297);
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
  assert.equal(owned.size, 1645);
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
  assert.equal(Object.keys(catalog).length, 12143);
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
