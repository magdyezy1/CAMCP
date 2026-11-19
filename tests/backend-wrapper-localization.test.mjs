import test from 'node:test';
import assert from 'node:assert/strict';
import {parsers} from 'prettier/plugins/babel';
import {backendContractSourceFiles, inspectBackendWrapperFailures, localeProblems} from '../tools/check-locales.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MirrorError, errorResult} from '../dist/src/errors.js';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
  files = backendContractSourceFiles(),
  selected = files.map(file => ({file, messages: inspectBackendWrapperFailures(fs.readFileSync(file, 'utf8'), file)})),
  owned = new Set(selected.flatMap(row => [...row.messages]));
const file = 'src/wrapped.ts',
  imports = "import {MirrorError as Failure} from './errors.js';\n",
  wrapper = 'function fail(code:string,message:string){throw new Failure(code,message,{},400);}\n';
const inspect = (source, target = file) => [...inspectBackendWrapperFailures(source, target)].sort();
test('canonical runtime aliases qualify only a sole-throw helper static message argument', () => {
  assert.deepEqual(inspect(imports + wrapper + "fail('CODE','Authored explanation.');fail('CODE',native.message);"), [
    'Authored explanation.',
  ]);
});
test('multi-stage local forwarding preserves the actual parameter position and excludes transformed reasons', () => {
  const source =
    imports +
    wrapper +
    "function reject(message:string){return fail('CODE',message);}function forward(code:string,reason:string){reject(reason);}function altered(reason:string){reject(reason.trim());}forward('NATIVE','Forwarded authored explanation.');altered('Native transformation.');";
  assert.deepEqual(inspect(source), ['Forwarded authored explanation.']);
});
test('nested Windows paths resolve actual canonical source imports', () => {
  const source =
    imports.replace("'./errors.js'", "'../../errors.js'") + wrapper + "fail('CODE','Nested owned reason.');";
  assert.deepEqual(inspect(source, 'src\\nested\\deep\\wrapped.ts'), ['Nested owned reason.']);
  assert.deepEqual(inspect(source, 'server/nested/deep/wrapped.ts'), []);
});
test('type-only, default, namespace and unrelated constructors or imported helper calls remain unqualified', () => {
  for (const prefix of [
    "import type {MirrorError as Failure} from './errors.js';",
    "import Failure from './errors.js';",
    "import * as Failure from './errors.js';",
    "import {MirrorError as Failure} from './native.js';",
  ]) {
    assert.deepEqual(inspect(prefix + wrapper + "fail('CODE','Unowned reason.');"), []);
  }
  assert.deepEqual(inspect("import {fail} from './helper.js';fail('Native reason.');"), []);
});
test('ARC-04: the family kit fail owns its reasons as a local copy did; type, foreign and shadowed bindings do not', () => {
  const kit = "import {fail} from './family-kit.js';\n";
  assert.deepEqual(inspect(kit + "fail('CODE','Kit-owned reason.');fail('CODE',native.message);"), [
    'Kit-owned reason.',
  ]);
  assert.deepEqual(inspect("import {fail as refuse} from './family-kit.js';refuse('CODE','Aliased kit reason.');"), [
    'Aliased kit reason.',
  ]);
  assert.deepEqual(
    inspect("import {fail} from '../family-kit.js';fail('CODE','Nested kit reason.');", 'src/nested/wrapped.ts'),
    ['Nested kit reason.'],
  );
  assert.deepEqual(
    inspect(kit + "function invalid(message:string){return fail('INVALID',message);}invalid('Forwarded kit reason.');"),
    ['Forwarded kit reason.'],
  );
  for (const source of [
    "import type {fail} from './family-kit.js';fail('CODE','Type-only binding.');",
    "import {type fail} from './family-kit.js';fail('CODE','Type-only specifier.');",
    "import {fail} from './errors.js';fail('CODE','Another module.');",
    "import {fail} from './family-kits.js';fail('CODE','Another file.');",
    kit + "function parameter(fail:any){fail('CODE','Shadowed parameter.');}",
    kit + "{const fail=native;fail('CODE','Shadowed block.');}",
    kit + "fail=native;fail('CODE','Reassigned binding.');",
  ])
    assert.deepEqual(inspect(source), [], source);
  assert.deepEqual(inspect(kit + "fail('CODE','Server reason.');", 'server/wrapped.ts'), [], 'src family kit only');
});
test('constructor parameter shadows and callable parameter, block, catch, class and var shadows cannot author provider text', () => {
  const source =
    imports +
    wrapper +
    "function other(Failure:any,message:string){throw new Failure('CODE',message);}function parameter(fail:any){fail('X','Native parameter.');}function hoisted(){fail('X','Native var.');var fail=native;}try{}catch(fail){fail('X','Native catch.');}{let fail=native;fail('X','Native block.');}{class fail{};fail('X','Native class.');}const named=function fail(){fail('X','Native named expression.');};for(let fail of native){fail('X','Native loop.');}fail('X','Outside owned reason.');other(native,'Native constructor.');";
  assert.deepEqual(inspect(source), ['Outside owned reason.']);
});
test('global assignment, destructuring, update or loop reassignment invalidates helper ownership and its forwarders', () => {
  for (const assignment of ['fail=native;', '[fail]=native;', 'fail++;', 'for(fail of native){}'])
    assert.deepEqual(
      inspect(
        imports +
          wrapper +
          "function forward(message:string){fail('X',message);}" +
          assignment +
          "fail('X','Unowned mutable reason.');forward('Unowned forwarded reason.');",
      ),
      [],
    );
});
test('an assignment to a shadowed parameter does not disqualify the outer owned helper', () => {
  assert.deepEqual(
    inspect(
      imports +
        wrapper +
        "function nativeScope(fail:any){fail=native;fail('X','Native parameter.');}fail('X','Outer owned reason.');",
    ),
    ['Outer owned reason.'],
  );
});
test('a reassigned forwarder is excluded without disqualifying its canonical direct helper', () => {
  assert.deepEqual(
    inspect(
      imports +
        wrapper +
        "function forward(message:string){fail('X',message);}forward=native;forward('Native reassigned forwarder.');fail('X','Direct owned reason.');",
    ),
    ['Direct owned reason.'],
  );
});
test('wrapper parameter shadows prevent forwarder qualification', () => {
  assert.deepEqual(
    inspect(
      imports +
        wrapper +
        "function forward(fail:any,reason:string){return fail('X',reason);}forward(native,'Native shadowed forwarder.');",
    ),
    [],
  );
});
test('member calls, dynamic messages, aliases, arrow helpers and multiple-statement helpers stay outside this qualified scope', () => {
  const source =
    imports +
    wrapper +
    "const alias=fail;const arrow=(m:string)=>{throw new Failure('X',m);};function larger(m:string){before();throw new Failure('X',m);}object.fail('X','Native member.');alias('X','Alias reason.');arrow('Arrow reason.');larger('Larger reason.');fail('X',native.message);fail('X',`dynamic ${native.message}`);";
  assert.deepEqual(inspect(source), []);
});
test('an existing constructor sentence cannot collide with an ownership probe for an unrelated helper', () => {
  const prefix = imports + "function nativeFail(message:string){throw new NativeFailure('X',message);}";
  const fn = parsers['babel-ts'].parse(prefix).program.body[1];
  const collision = '__AMCP_LOCAL_WRAPPER_' + fn.start + '__';
  const source = prefix + "new Failure('X'," + JSON.stringify(collision) + ");nativeFail('Unowned collision reason.');";
  assert.deepEqual(inspect(source), []);
});
test('unsafe/private, absolute or absent source paths refuse before parsing arbitrary source text', () => {
  for (const target of [
    null,
    undefined,
    'C:/private.ts',
    '../src/file.ts',
    '.mirror/PRIVATE/file.ts',
    'tests/file.ts',
    'src/../server/file.ts',
    'src/file.js',
  ])
    assert.deepEqual([...inspectBackendWrapperFailures('not valid code', target)], []);
});
test('ownership inspection never executes authored calls, native functions or global mutations', () => {
  assert.equal(globalThis.__amcp_wrapper_probe, undefined);
  const source =
    imports + wrapper + "globalThis.__amcp_wrapper_probe=1;native.write();fail('X','Unexecuted authored reason.');";
  assert.deepEqual(inspect(source), ['Unexecuted authored reason.']);
  assert.equal(globalThis.__amcp_wrapper_probe, undefined);
});

test('spread calls cannot pretend a static argument occupies the canonical message position', () => {
  const source =
    imports +
    wrapper +
    "fail(...native,'Unqualified shifted reason.');fail('X','Unqualified trailing spread.',...native);fail('X','Exact owned reason.');";
  assert.deepEqual(inspect(source), ['Exact owned reason.']);
});
test('spread forwarding helpers cannot qualify their static callers through unknown argument positions', () => {
  const source =
    imports +
    wrapper +
    "function forward(message:string){return fail(...native,message);}function tail(message:string){return fail('X',message,...native);}forward('Unqualified forwarded spread.');tail('Unqualified trailing forwarded spread.');fail('X','Direct exact reason.');";
  assert.deepEqual(inspect(source), ['Direct exact reason.']);
});

test('all actual qualified wrapper reasons have Arabic while native fields, limits and examples remain exact', () => {
  // PRV-06 C adds src/meta-creative-features.ts (no wrapper reasons) and seven catalog messages; CMP-03 adds
  // src/microsoft-campaign-criteria.ts; QA-02 adds the Meta ad image read's paging refusal, and the Performance Max
  // build's short-description refusal makes src/google-pmax-build.ts an owner of a literal wrapper reason; the Snapchat
  // targeting specs read's paging refusal adds one.
  // The Meta window refusal is now one shared constant (meta-attribution-windows.ts); report-dimension-packs pins its
  // Arabic. WEB-09 adds server/workspace-search.ts (no wrapper reasons); WEB-03 and WEB-05 add website catalog entries.
  // ACC-05 adds three modules without wrapper reasons and the owner provider access panel's catalog entries. Owner
  // decision P9 adds the Commerce reason a Meta product needs review.
  // CMP-03's Microsoft location lookup adds src/microsoft-locations.ts (five wrapper reasons of its file checks);
  // RPT-07's period comparison table adds its caption to the catalog, and MSR-03's TikTok pixel event statistics their
  // refusals and website copy. ARC-02 adds the document-kind registry and the tenant-bound repository modules (27
  // files without wrapper reasons). The TikTok ledger's envelope refusal (it keeps TikTok's code and request ID) makes
  // its two envelope reasons wrapper reasons of src/measurement-ledger-tiktok.ts, and the unpinned statistics request
  // adds one website reason; the reserved workspace ID refusal adds one catalog entry and the invitation lifetime's one-
  // and two-hour sentences two.
  // ARC-03 adds src/route-anchors.ts (no wrapper reasons) and the nine route evidence entries of the contract reference.
  // ARC-01 adds two registry modules without wrapper reasons and the parked-provider refusal and remedy entries, and
  // P9's parked WooCommerce notice on Commerce one more catalog entry.
  // ARC-04 stage B adds six leaf modules split from existing ones (account-id, review-state-core, tiktok-paths,
  // microsoft-association-contracts, meta-ad-library-contract, google-business-notification-kind); their reasons moved
  // with them, so the owned reasons and the catalog are unchanged. Stage E adds src/signed-cursor.ts and
  // src/portfolio-runner.ts (no owned reasons: the portfolio refusals stay in each adapter). Stage F adds the report
  // source contract, its registry and ten provider report sources (no wrapper reasons).
  // Stage C adds src/family-kit.ts; the family modules that import its fail keep their owned reasons. Stage D adds
  // src/tool-actions.ts (no wrapper reasons). Stage F's report jobs add src/report-job.ts and src/report-jobs.ts,
  // stage D's split of createWebsite 14 server modules, and stage C's provider remedies src/provider-remedies.ts and
  // nine remedy tables, none with a wrapper reason.
  // ARC-01 phase B adds the provider hooks registry and fifteen provider adapter modules (src/<provider>-adapter.ts),
  // without wrapper reasons; its wire profile adds the Adjust and Amazon adapters and two leaves split from existing
  // modules (src/oauth1.ts, src/provider-error-core.ts), without wrapper reasons; its read authorizers add
  // src/snapchat-scope.ts, Snapchat's scoped paths, without wrapper reasons; the action contract ledger's provider
  // rules add the provider workflows registry (src/provider-workflows.ts), without wrapper reasons.
  // The design review of 2026-10 adds 24 website entries to the catalog, none a wrapper reason, and its review fixes
  // three reviewer sign-in sentences and one uncertain-write message (its remedy replaced), none a wrapper reason.
  // ARC-04 stage F (reporting) adds ten modules split from the reporting modules, without wrapper reasons: the shared
  // report table (src/report-table.ts), the leaf src/overview-levels.ts, five platforms' guided reporting
  // (src/<platform>-guided-reports.ts), two allocation evidence checks and src/evidence-dates.ts.
  // ARC-04 (wave 4c) splits campaignRecipe into per-recipe builders: src/recipe-steps.ts and the Meta, Google Search
  // and Microsoft Search recipe modules, whose reasons moved with their code from src/campaign-recipes.ts. ARC-01
  // (wave 4c) adds src/reddit-paging.ts, src/meta-write-shape.ts, src/snapchat-affected-ad-pages.ts and four provider
  // state-read modules (src/<provider>-state-reads.ts) and src/snapchat-write-impact.ts, without wrapper reasons, and
  // the campaign clones' src/campaign-clone-core.ts and four src/<provider>-campaign-clone.ts modules, and the guided
  // activations' src/campaign-activation-core.ts and six src/<provider>-recipe-activation.ts modules, and the
  // preflight's src/google-preflight.ts, src/snapchat-preflight.ts and src/meta-preflight.ts, and the rejected
  // outcome's src/google-write-rejection.ts and src/write-rejection-core.ts, and the reconciliation's
  // src/google-write-reconciliation.ts, src/meta-write-reconciliation.ts and src/verification-core.ts, and the recipe
  // context's src/microsoft-location-pin.ts.
  // Merged, the reporting package's ten modules and the writes package's 33 add up.
  // ARC-01 phase B (wave 4c, the website's server modules) adds 22 modules without wrapper reasons: fifteen provider
  // login modules (src/<provider>-login.ts), their contract src/provider-login.ts and registry src/provider-logins.ts,
  // Google Ads' hierarchy discovery (src/google-account-discovery.ts), Google's shared OAuth steps
  // (src/google-oauth.ts), the leaf that signs X's authorization calls (src/oauth1-authorization.ts), the provider
  // startup registry (src/provider-startup.ts) and WooCommerce's login steps (src/woocommerce-login.ts); the reasons
  // the login steps took from server/ were never wrapper reasons, so the wrapper reasons are unchanged.
  // Merged with the transport and catalog package's provider workflows registry (above), the modules add up: 735.
  // DOC-03's members-only Help page adds server/help-routes.ts and seven website entries, none a wrapper reason, and
  // its Home copy nine website entries (the capability outcomes), none a wrapper reason.
  // Merged with the ARC packages, the Help page's module is one more: 736.
  // ARC-01 wave 4c round 6 (w4c-arc6-versions) adds WooCommerce's adapter module (src/woocommerce-adapter.ts, its tool
  // notes), without wrapper reasons, and moves the Meta creative check's reasons to src/meta-creative-features.ts: 737.
  // Reviewer connector authority adds one catalog entry, without adding a wrapper reason.
  // ARC-01 (wave 4c round 6, the shared tables) adds src/frozen-facts.ts, src/linkedin-programs.ts and
  // src/woocommerce-adapter.ts, without wrapper reasons: 739. Its wire contracts add src/discovery-issues.ts and
  // src/microsoft-wire-contract.ts, without wrapper reasons: 741.
  // Merged with the versions package, both add the one WooCommerce adapter module (it holds both packages' hooks), so
  // the modules add up: 741, the same wrapper reasons.
  // ARC-01 phase B (wave 4c round 6) adds Tag Manager's measurement audit and WooCommerce's workspace actions
  // (src/gtm-measurement-audit.ts, src/woocommerce-workspace.ts), without wrapper reasons. Merged with the versions and
  // tables packages, the modules add up: 743, the same wrapper reasons.
  // ARC-01 (wave 4c round 6, catalog) adds the catalog destinations' projections (src/meta-catalog-ingestion.ts and its
  // X and Snapchat siblings), the rules they share (src/supplied-catalog-ingestion.ts) and the X removal's plan
  // binding (src/x-catalog-removal-binding.ts), without wrapper reasons: five modules. Meta's comparison then moves from
  // src/catalog-comparison.ts to src/meta-catalog-comparison.ts, and LinkedIn's and DV360's conditional programs to
  // src/linkedin-conditional-programs.ts and src/dv360-conditional-programs.ts: three more. Merged with the versions,
  // tables and workspace packages, the modules add up: 751, the same wrapper reasons. The merge then moves the declared
  // effects of a suggested call to the leaf src/call-effects.ts, without wrapper reasons: 752.
  // Wave 4c round 6 (reporting) adds the four allocation models' native budget drafts
  // (src/<platform>-allocation-draft.ts), moved from src/allocation-plan.ts without wrapper reasons, and moves the
  // Overview's native parent reads to src/<platform>-detail-parents.ts (TikTok, Snapchat, LinkedIn), without wrapper
  // reasons: seven modules. Merged with the versions, tables, workspace and catalog packages, the modules add up: 759,
  // the same wrapper reasons.
  // The owner's decisions of 2026-10-31 (w4c-qualify-fixes) add one catalog entry ("Reviewer"), not a wrapper reason.
  // OWNER-REVIEWER-QA adds four catalog entries (connection progress messages), none a wrapper reason. Merged with
  // "Reviewer": 11,535 entries. Its follow-up adds one (the note a test account reads on /account), not a wrapper
  // reason: 11,536. Wave 5 round 1 (V2-RPT-05) adds two (the provider-data retry action and "Retry"), neither a
  // wrapper reason: 11,538.
  // V2-RPT-02 adds the shared objective resolver (no new wrapper) and objective explanations.
  // Result readers add three modules; the v4 boundary adds one.
  // Exact formula and advisory adapters add two further source modules.
  // V4 delivery-level reconciliation adds one source module without a new diagnostic.
  // Scope/status metadata adds three modules.
  // Adds the bounded selected-descendant rollup module.
  // Stored-definition migration adds its durable notice ledger module.
  // Package D adds the bounded Snapchat detail collector with eleven already-translated refusal sentences.
  // Task 12 adds two X source modules; its collector owns thirteen new diagnostics and reuses a checkpoint refusal.
  // V2-RPT-07 (levels) adds the 31-day span helper and Apple's bounded paging helper and detail collector; the helper's six
  // list refusals go through its refuse() wrapper.
  // F-L3-10 takes src/ad-previews.ts off the never-owned list: one more module with owned reasons.
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
  // wrapper reason: one more on the integration's 813, 814.
  // Merge r25-m0-merge, with r25-m0-t1, r25-m0-review and r25-m0-errors (each 814 on the same base of 813, and each adds a
  // different file): the merged tree measures 813 + 1 + 1 + 1 = 816.
  // Package r25-m1-hash (Round 2.5, M1: L5-02) adds six leaves, with no wrapper reason of their own: the flat-resource names
  // of src/review-flat-telemetry.ts and each provider's review table that its adapter and family modules share
  // (src/{x,linkedin,snapchat,criteo,google}-review-volatile.ts): 816 + 6 = 822.
  // The roles of the same package add one more, with no wrapper reason of its own: the identity of an X account
  // (src/x-identity-state.ts): 822 + 1 = 823. A parent is read whole, as a target is (lead review S2-1), so the module the
  // roles first added for a TikTok parent row (src/tiktok-parent-state.ts) is gone.
  // The rotation harness adds one more: the identity of a LinkedIn ad account, which the adapter and the families that read
  // the account themselves share (src/linkedin-account-state.ts): 823 + 1 = 824.
  // The accounts of Microsoft and Reddit are kept to their identity too (lead review S3-3), each in a module of its own with no
  // wrapper reason of its own (src/microsoft-account-state.ts, src/reddit-account-state.ts): 824 + 2 = 826.
  // Package r25-m1-diff (Round 2.5, M1: L5-04) adds src/review-diff.ts, which of the changed fields of a STATE_CHANGED
  // matter, with no wrapper reason of its own: one more on the integration's 816, 817 on its own base. Whoever merges it adds the
  // files of every package it is merged with to this number.
  // Merge r25-m1-merge, with r25-m1-hash (826 on the base of 816) and r25-m1-diff (817 on the same base): each adds different
  // files, so the merged tree measures, with this test's own inspector, 816 + 10 + 1 = 827.
  // Package r12-fix (the lead's ruling on item 1, decision 2, recency, 2026-11-16) adds src/snapchat-report-finalization.ts, the rule
  // that tells an empty Snapchat answer that is "no rows" from one that is not yet known, and its reason, with no wrapper reason
  // (the sentence is a report warning, not a refusal): 817.
  // Merge r25-m1-merge, merge 3: r12-fix (817 on its own base of 816) on the 827 above adds one different file and nothing else
  // moves the count, so the merged tree measures, with this test's own inspector, 827 + 1 = 828.
  // Package r25-m2-reconcile (Round 2.5, M2: L5-05, L3-13) adds src/write-reconcile-job.ts, the worker job that checks an uncertain
  // write by reads alone, with no wrapper reason of its own: one more on the M1 head's 828, 829 on its own base. Whoever merges it
  // adds the files of every package it is merged with to this number.
  // Its item 2 adds src/tiktok-write-reconciliation.ts, TikTok's lookup of an uncertain campaign, ad group or ad create, with no
  // wrapper reason of its own: 830.
  // Its item 3 adds src/write-duplicates.ts, the guard against creating twice, whose refusal is raised through the write stages' shared
  // ail (imported, not a wrapper this module defines): 831.
  // Its rework (lead review S2-3) adds src/created-agreement.ts, the rule that a created lookup counts a match as this write's only when the
  // fields the review froze agree, with no wrapper reason of its own: 832.
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
  assert.equal(files.length, 835);
  // The previews modules of Meta, TikTok, Snapchat, LinkedIn and Reddit own the reasons they took from
  // src/ad-previews.ts (no new sentence), and src/ad-previews.ts itself is now owned: six modules here, one from the levels
  // package, on the base's 189 (189 + 1 + 6).
  // Package r12-xpreview: src/x-ad-previews.ts reads X's previews now and raises its refusals through the kit's fail(), so it
  // owns reasons too (the one new sentence, and the two the other previews modules already own): 196 + 1 = 197.
  assert.equal(selected.filter(row => row.messages.size).length, 197);
  // Eight new v4 refusals; its attribution refusal already belongs to this inventory.
  // Source-owned status applicability adds one refusal.
  // The v4 boundary now rejects unsupported descendant ID scopes before egress.
  // The stored-config upgrader also owns the existing platform/connection/account refusal.
  // The scope-alias conflict is one new wrapper sentence.
  // V2-RPT-07 (levels): Apple's six list refusals and the reworded X and Snapchat population refusals, ten more in all.
  // The stored-definition package's shape check of a saved report body (src/overview-v4.ts) raises four sentences the
  // catalog already held (the platform-account count, the report name and the two template-default refusals) through its
  // invalid() wrapper: four more.
  // F-L3-10 (previews): the previews tool's own refusals (sixteen sentences) are now owned and translated: 2886 + 10 + 4 + 16.
  // Package engine-core deletes the unused overviewV4Sum and overviewV4Ratio (F-L5-28), whose two invalid() refusals
  // (a metric not declared additive, an unsupported ratio unit) go with them: 2916 - 2.
  // Package r12-fix (item 2, V2-RPT-07): the X population's parent refusal (src/x-overview-detail.ts refuse()) is now two
  // sentences, one for the campaign of line items and one for the line item of promoted tweets, each with its own Arabic; the
  // earlier sentence stays for a malformed objective (it was one sentence raised from two places): 2914 + 2.
  // Its rework (lead review S2-2) adds two refusals of src/write-reconciliation.ts, raised through its own fail(): a write that a new review
  // replaced is settled (never reconciled, accepted or replaced again), and a check dropped because the write settled while the provider
  // was read: 2916 + 2.
  // Package r12-xpreview: X's previews refuse a filter that is not one of X's own IDs with a sentence of their own (the other
  // two sentences of src/x-ad-previews.ts are owned already): 2916 + 1.
  // Merge r25-m2-merge, merge 4: r12-xpreview (2,917 on its own base of 2,916) on the 2,918 above. Reconcile's two reasons are in
  // src/write-reconciliation.ts and xpreview's one in src/x-ad-previews.ts, so no package's own pin is the merged count; measured with
  // this test's own inspector: 2,916 + 2 (reconcile) + 1 (xpreview) = 2,919.
  // Package r25-field-tiktok (#6) owns one more: the refusal of an ad_configuration.product_info_enabled other than UNSET, a literal
  // passed to invalid() in src/tiktok-smart-plus-ads.ts (the file owned wrapper reasons already, so the 197 files above do not move):
  // 2,919 + 1 = 2,920.
  assert.equal(owned.size, 2920);
  // V2-RPT-01 adds request/window diagnostics and the updated evidence-page hint: six Arabic entries.
  // V2-RPT-01 totals add the match notice, gap templates and evidence refusal.
  // V2-RPT-02 adds nine objective-select and source labels; owned wrappers are unchanged.
  // V2-RPT-04 adds seven direct refusals and two metadata warnings; wrapper ownership is unchanged.
  // V2-RPT-04 group results add seven labels and the Mixed explanation; refusal ownership is unchanged.
  // V2-RPT-04 results add three diagnostics and consolidate the omitted legends (net +2); wrappers unchanged.
  // V2-RPT-04 window templates and partial-coverage notices; wrapper ownership is unchanged.
  // V2-RPT-04 contract notices add five entries without changing wrapper refusal ownership.
  // V2-PRV-01 adds twelve selection/paging entries without changing wrapper ownership.
  // V2-PRV-02 adds two iframe/lifetime notes, with no wrapper ownership change.
  // V2-PRV-03 adds two Snapchat notes, with no wrapper ownership change.
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
  // V2-RPT-07 (levels) adds 25 catalog entries and replaces 7 (net +18).
  // V2-RPT-04 (objectives) adds five: four reasons an objective was not read and the label of a LinkedIn group's other
  // results; no wrapper ownership changes.
  // F-L3-10 (previews) adds seventeen: seven refusals and six notices of the previews tool, and the four platforms without a
  // preview route (the module's other refusals already had Arabic).
  // F-L3-06 (previews) adds four: the count the previews panel announces for a page, one and several, first and further.
  // F-L4-13 (mcp) adds two: the Arabic of the body-encoding refusals of server/http-app.ts, which are direct reasons, not
  // wrapper reasons.
  // Web-report adds nineteen website messages: "n of m rows", the card notes and the cross-level check (F-L8-03).
  // Web-report adds the account settings group's name (F-L8-07).
  // Web-report adds ten collector warnings that reached the Arabic interface in English (F-L8-04).
  // Web-report adds the singular forms of two row-count messages (F-L8-12); none is a wrapper reason.
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
  // Package r25-m0-live (Round 2.5) item 1 adds the Arabic of the two date refusals of a guided capture's window (direct
  // reasons, not wrapper reasons): measured (node tools/check-locales.mjs: catalog_messages 12114), 12,112 + 2 = 12,114. Its
  // item 2 adds the two sentences that name semantics.complete (TikTok and Snapchat; raised through bad(), which this
  // inventory does not own): 12,114 + 2 = 12,116. Its item 3 adds the Arabic of LinkedIn's remedy for an empty analytics
  // answer (a remedy, not a refusal reason): 12,117. Its item 4 replaces Microsoft's AccountId refusal (a direct reason, one for
  // one) and adds the Arabic of the remedy that says the request is at fault: 12,117 + 2 - 1 = 12,118. Its item 5 adds the Arabic
  // of the Snapchat template that names the windows Snapchat used (a direct reason, not a wrapper reason): 12,119. Its item 7
  // replaces two previews sentences that promised links open for anyone who has them with three that do not (two entries leave, three
  // enter): 12,120. Its review fix S2-1 rewords a remedy (one entry leaves, one enters) and adds the Arabic of the TikTok page-count
  // remedy (a remedy, not a refusal reason): 12,121.
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
  // failure of that file, not an owned wrapper reason: owned.size below does not move) and the reason a source that is partial
  // because of it shows (src/snapchat-report-finalization.ts, a report warning registered in web/report-quality.js): 12,145 + 2 =
  // 12,147. Measured: node tools/check-locales.mjs, catalog_messages 12147.
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
  // Package r12-xpreview (item 2): +4 entries and -1, as tests/backend-contract-localization.test.mjs counts them (the Arabic of
  // X's previews' sentences; the sentence that said X's previews were not qualified leaves): 12,156 + 3 = 12,159. Its item 3 adds
  // the four website entries counted there: 12,159 + 4 = 12,163. Its review round (S4-5) adds the one entry counted there, the
  // sentence for a Tweet ID that is not among the account's dark Tweets: 12,163 + 1 = 12,164.
  // Merge r25-m2-merge, merge 4: r12-xpreview (12,164 on its own base of 12,156, +8 net) on the 12,168 above. Its keys are in no other
  // package's web/locales/ar.json (merged with no marker), so the merged catalogue measures, with this test's own inspector
  // (node tools/check-locales.mjs: catalog_messages 12176, required_messages 11037, problems none), 12,168 + 8 = 12,176.
  // Package r25-ar-lazy (item 3): +1 entry, the Arabic of the one sentence a page says in place of a refusal's message when the
  // Arabic chunk that holds it cannot load (web/route-assets.js uiAnswerWithoutUnloaded; a website sentence, not an owned reason, so
  // owned.size does not move): measured (node tools/check-locales.mjs: catalog_messages 12157, problems none), 12,156 + 1 = 12,157.
  // Merge r25-m2-merge, merge 5: r25-ar-lazy (12,157 on its own base of 12,156) on the 12,176 above. Its one key is in no other package's
  // web/locales/ar.json (merged by taking the union: every package appends at the end, so the conflict was the last line's comma), so the
  // merged catalogue measures, with this test's own inspector (node tools/check-locales.mjs: catalog_messages 12177, problems none),
  // 12,176 + 1 = 12,177.
  // Package r25-field-tiktok (#2): +1 entry, the Arabic of the refusal of a classic ad create in an Upgraded Smart+ ad group (a direct
  // owned reason of src/tiktok-manual-ad-identities.ts, counted in tests/backend-contract-localization.test.mjs, not a wrapper reason, so
  // owned.size above does not move): measured (node tools/check-locales.mjs: catalog_messages 12178, problems none), 12,177 + 1 = 12,178.
  // Its item 3 (#6): +2 entries, the Arabic of the refusal of a product_info_enabled other than UNSET (a wrapper reason of
  // src/tiktok-smart-plus-ads.ts, counted above) and of the template that answers a request breaking several rules (a direct reason,
  // counted in tests/backend-contract-localization.test.mjs): measured (node tools/check-locales.mjs: catalog_messages 12180, problems
  // none), 12,178 + 2 = 12,180.
  // Its round 2 (the lead's review, S3-1) replaces the count template's entry with the Arabic of the remedy that says a request
  // breaks more than one rule (a shared recovery hint of src/tiktok-remedies.ts, counted in tests/shared-recovery-localization.test.mjs;
  // owned.size above does not move): measured (node tools/check-locales.mjs: catalog_messages 12180, problems none), 12,180 - 1 + 1 = 12,180.
  assert.equal(Object.keys(catalog).length, 12180);
  assert.deepEqual(localeProblems(catalog, owned), []);
  const rephrased = 'requestMetaData names only the ad account: {sponsoredAccountUrn: "urn:li:sponsoredAccount:<id>"}.';
  for (const message of owned) {
    const translated = catalog[message];
    assert.match(translated, /[\u0600-\u06ff]/u);
    assert.notEqual(translated, message);
    for (const token of new Set(message.match(/\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g) ?? []))
      assert.ok(translated.includes(token), 'Original native field ' + token);
    for (const bound of new Set(message.match(/\b\d[\d,]*(?:\.\d+)?\b/g) ?? []))
      assert.ok(translated.includes(bound), 'Original quantity ' + bound);
    const stack = [];
    for (let i = 0; i < message.length; i++) {
      if (message[i] === '{') stack.push(i);
      if (message[i] === '}' && stack.length) {
        const example = message.slice(stack.pop(), i + 1);
        if (message === rephrased && example.includes('<id>')) {
          for (const token of ['requestMetaData', 'sponsoredAccountUrn', 'urn:li:sponsoredAccount:'])
            assert.ok(translated.includes(token));
          assert.doesNotMatch(translated, /[<>]/);
        } else assert.ok(translated.includes(example), 'Original native example ' + example);
      }
    }
  }
  assert.equal(owned.has(rephrased), true);
  for (const [message, tokens] of [
    ['Give exactly one of type (similarity or reach) and ratio.', ['type', 'similarity', 'reach', 'ratio']],
    ['Expected the reviewed CSV_STRING stream, not JSON, an error or a signed download URL.', ['CSV_STRING', 'JSON']],
  ]) {
    assert.equal(owned.has(message), true);
    for (const token of tokens) assert.ok(catalog[message].includes(token));
  }
  assert.equal(owned.has('Claim into the selected ad account.'), true);
  assert.match(catalog['Claim into the selected ad account.'], /claim/);
  assert.equal(owned.has('Store credentials through Connections, not workspace documents.'), true);
  assert.match(catalog['Store credentials through Connections, not workspace documents.'], /«الاتصالات»/);
});
test('future nested sole-throw helpers are discovered and their missing Arabic is refused without executing source', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-wrapper-locale-'));
  const records = {
    'src/errors.ts': 'export class MirrorError extends Error {}',
    'src/future.ts':
      "import {MirrorError} from './errors.js';function fail(reason:string){throw new MirrorError('CODE',reason);}fail('Future wrapper reason.');",
    'server/new/routes.ts':
      "import {MirrorError as Failure} from '../../src/errors.js';function deny(code:string,reason:string){throw new Failure(code,reason);}function forward(reason:string){return deny('CODE',reason);}forward('Future forwarded server reason.');",
  };
  try {
    for (const [file, source] of Object.entries(records)) {
      const target = path.join(temporary, file);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.writeFileSync(target, source);
    }
    const discovered = backendContractSourceFiles(temporary);
    assert.deepEqual(discovered, ['server/new/routes.ts', 'src/errors.ts', 'src/future.ts']);
    const messages = new Set(
      discovered.flatMap(file => [
        ...inspectBackendWrapperFailures(fs.readFileSync(path.join(temporary, file), 'utf8'), file),
      ]),
    );
    assert.deepEqual(localeProblems(catalog, messages), [
      'Missing Arabic message: Future forwarded server reason.',
      'Missing Arabic message: Future wrapper reason.',
    ]);
  } finally {
    for (const file of Object.keys(records)) fs.unlinkSync(path.join(temporary, file));
    for (const directory of ['server/new', 'server', 'src']) fs.rmdirSync(path.join(temporary, directory));
    fs.rmdirSync(temporary);
  }
});
for (const locale of ['en', 'ar'])
  test(
    'actual ' + locale + ' wrapper formatter preserves every original machine value and reference without calls',
    () => {
      const fixture = accountWorkflowFixture(locale);
      for (const message of owned) {
        const result = errorResult(
            new MirrorError(
              'ORIGINAL_WRAPPER_CODE',
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
            'original-wrapper-reference',
            0,
          ),
          before = JSON.stringify(result);
        fixture.context.response = result;
        fixture.context.error = fixture.run('requestError(response)');
        const displayed = fixture.run('errorMessage(error)');
        assert.ok(displayed.includes(locale === 'ar' ? catalog[message] : message));
        assert.ok(displayed.includes('original-wrapper-reference'));
        assert.equal(fixture.context.error.code, 'ORIGINAL_WRAPPER_CODE');
        assert.equal(fixture.context.error.message, message);
        assert.equal(fixture.context.error.details, result.error.details);
        assert.equal(result.error.retryable, false);
        assert.equal(result.error.remedy.mutation_retry_safe, false);
        assert.equal(JSON.stringify(result), before);
      }
      for (const message of [
        'Unrecognized native wrapper sentence 00123',
        '9007199254740993',
        'urn:li:adAccount:9007199254740993',
      ]) {
        assert.equal(Object.hasOwn(catalog, message), false);
        fixture.context.response = errorResult(
          new MirrorError('NATIVE_UNCHANGED', message),
          'original-native-reference',
          0,
        );
        const before = JSON.stringify(fixture.context.response);
        fixture.context.error = fixture.run('requestError(response)');
        assert.ok(fixture.run('errorMessage(error)').includes(message));
        assert.equal(JSON.stringify(fixture.context.response), before);
      }
      assert.equal(fixture.calls.length, 0);
      assert.equal(fixture.visits.length, 0);
    },
  );
