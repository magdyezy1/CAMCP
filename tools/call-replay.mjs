// The call-replay equivalence proof for ARC-01 phase B (the batch-33 technique, kept as a tool). A provider concern moves
// out of a shared module only when the provider requests and authorization decisions are the same before and after:
//   1. record: run test files on the build before the change with tools/call-replay-recorder.mjs preloaded. A loader
//      hook wraps the functions named in `targets` in their compiled modules (dist/src); every call is written with its
//      arguments and its result or refusal, the requests each NativeTransport sends included, normalized so that random
//      IDs, times and signatures do not count. Nothing is sent anywhere: the suites' synthetic fetchers answer.
//   2. change the source, build, and record the same test files again;
//   3. compare: the two recordings must hold the same records per test file (0 differences), and replay runs the
//      recorded calls of the pure functions in `replayable` through the current build and compares their results.
// Usage:
//   npm run build && node tools/call-replay.mjs record <dir> [test file ...] [--list file] [--related source file ...]
//   node tools/call-replay.mjs compare <before> <after> [--calibration <dir> <dir>] [--ignore id ...]
//       [--timing-dependent <test file>[=CODE,...] ...] [--show N]
//   node tools/call-replay.mjs replay <before dir> [--ignore id ...]
// A calibration is two recordings of the build before the change: a paired record that differs only where they
// differed (a fixture's random value, a clock-relative time inside a digest) is noise, reported apart. An outcome flip
// (a result on one side, a refusal on the other) and the records of a function whose call count varied in the
// calibration are never noise: when the calibration would have absorbed them they are unsettled, every one printed,
// and fail the comparison. --timing-dependent names a test file whose clock decides how many of the same calls run and
// which of them are refused with the named codes (the burst-pacing test: tests/transport.test.ts=TENANT_RATE_LIMIT);
// those records are counted apart. --ignore names a helper that intentionally left its module, whose callers still
// compare.
// Recordings stay outside the repository (they hold test payloads); the commit that moves a concern states the counts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

/**
 * What is recorded, by compiled module: free functions (`export function` or `export const` arrow) and class methods.
 * Each phase B concern adds the entry points of the shared module it changes; entry points stay in place (a shared
 * function that now consults the provider's adapter keeps its name), so both recordings see the same calls.
 */
export const targets = Object.freeze({
  'dist/src/transport.js': {
    functions: ['buildUrl', 'providerRetryDelay', 'losslessReportNumbers'],
    classes: {NativeTransport: ['request', 'uploadGoogleVideo', 'uploadLinkedIn']},
  },
  'dist/src/scope.js': {
    functions: ['ownershipReads'],
    classes: {ScopeGuard: ['authorize', 'observe', 'observeCreated']},
  },
  // The Snapchat scoped-resource paths left scope.js for this leaf (ARC-01 phase B, the read authorizers), which
  // scope.js re-exported until wave 4c; a recording made before names them dist/src/scope.js#... (compare with
  // --ignore for both).
  'dist/src/snapchat-scope.js': {functions: ['snapchatScopedResource', 'snapchatOrganizationPixels']},
  'dist/src/store.js': {
    classes: {Store: ['rememberResource', 'ownsResource', 'updateConnection', 'resolveConnection', 'putConnection']},
  },
  'dist/src/account-id.js': {functions: ['normalizeAccount']},
  'dist/src/execution-risk.js': {functions: ['applyExecutionRisk', 'independentlyReadOnly', 'bodyDeletion']},
  // Google Ads' global planning reads left execution-risk.js for its adapter (ARC-01 phase B, the read
  // classification); a recording made before names it dist/src/execution-risk.js#googleGlobalRead (compare with
  // --ignore for both).
  'dist/src/google-ads-adapter.js': {functions: ['googleGlobalRead']},
  'dist/src/pagination.js': {functions: ['paginate', 'nextPage', 'continuationArguments', 'nextPageCall']},
  'dist/src/account-metadata.js': {
    functions: ['accountPlan', 'accountMetadata', 'accountCurrency', 'accountTimezone', 'accountKind'],
  },
  'dist/src/provider-error-taxonomy.js': {
    functions: ['classifyProviderError', 'providerErrorCode', 'providerRequestId'],
  },
  'dist/src/write-shape.js': {functions: ['assertWriteShape', 'metaValidationOptions']},
  'dist/src/write-state.js': {functions: ['validateState']},
  'dist/src/review-state.js': {functions: ['normalizeSnapshot']},
  'dist/src/verification-reads.js': {
    functions: ['verificationReads', 'entity', 'verificationContractVersion', 'googleValueVerificationVersion'],
  },
  'dist/src/write-snapshots.js': {functions: ['snapshotPlans']},
  'dist/src/write-outcome.js': {functions: ['writeOutcome']},
  'dist/src/compiler.js': {classes: {Compiler: ['compile']}},
  'dist/src/delegated-native.js': {
    functions: ['delegatedParameterMatches'],
    classes: {DelegatedNativeCompiler: ['compile', 'validateResponse']},
  },
  'dist/src/auth.js': {classes: {CredentialProvider: ['get']}},
  'dist/server/platform-oauth.js': {
    functions: ['platform', 'selectionKind', 'selectableKinds'],
    // `start` since the OAuth flow steps moved into the adapters (ARC-01 phase B): its authorization URL, and X's
    // request-token call through the instance's fetcher.
    classes: {PlatformOAuth: ['config', 'publicConfig', 'connectService', 'exchange', 'start']},
  },
  'dist/server/asset-discovery.js': {classes: {AssetDiscovery: ['sync', 'discoverWith']}},
  // The reviewed route of a write (ARC-01 phase B, the entity writes: each platform's generic entity routes left
  // reviewed-routes.ts for its adapter's facts).
  'dist/src/reviewed-routes.js': {functions: ['reviewedWriteFamily']},
  // The offline-upload rehearsal of a reviewed write's inspection (ARC-01 phase B: its routes became the conversion
  // families' personal-data facts).
  'dist/src/offline-upload-rehearsal.js': {functions: ['offlineUploadRehearsal']},
  // The one-line summary of a reviewed write, its spending confirmation and the structural spend effects (ARC-01
  // phase B: Google Ads' operations, Reddit's confirmed writes and Meta's unshared campaign budgets left them for
  // their adapters' facts).
  'dist/src/review-summary.js': {functions: ['reviewSummary']},
  'dist/src/preflight.js': {functions: ['spendConfirmationError']},
  'dist/src/spend-effects.js': {functions: ['namesSpendField', 'deliveryEditFields', 'deliveryStops']},
  // ARC-04 stage F and ARC-01 (reporting): the native report collector and the reporting modules whose provider facts
  // move into report sources and registries, Adjust reporting and the Sheets client (whose requests are recorded too).
  'dist/src/report-native.js': {
    functions: ['normalizeNativeRow', 'missingNativeMetrics'],
    classes: {NativeCampaignReports: ['collect', 'collectDaily', 'verifyAccount']},
  },
  'dist/src/adjust-reporting.js': {functions: ['adjustReporting', 'adjustReportingKind']},
  'dist/src/google-sheets.js': {
    functions: ['sheetsPresentationRequests', 'deliveryProjection'],
    classes: {GoogleSheetsExports: ['write', 'checkDelivery', 'releaseDestination', 'create', 'bind']},
  },
  // The report table left google-sheets.js for this shared module (ARC-01), which google-sheets.js re-exports; a
  // recording made before names them dist/src/google-sheets.js#... (compare with --ignore for both).
  'dist/src/report-table.js': {functions: ['reportTable', 'exportCsv', 'assertReportExportable']},
  'dist/src/report-presets.js': {functions: ['reportPreset', 'validatePresetRows']},
  'dist/src/decision-reporting.js': {classes: {DecisionReporting: ['handle', 'collectGuided']}},
  'dist/src/report-resource-scope.js': {functions: ['reportingResourceAccount', 'reportingResourceAccounts']},
  'dist/src/report-runs.js': {functions: ['reportRunScope']},
  'dist/src/report-breakdowns.js': {functions: ['breakdownValue', 'breakdownDescriptor']},
  // Meta's breakdown key left report-breakdowns.js for Meta's guided reporting (ARC-04 stage F), which it re-exports; a
  // recording made before names it dist/src/report-breakdowns.js#metaBreakdownKey (compare with --ignore for both).
  'dist/src/meta-guided-reports.js': {functions: ['metaBreakdownKey']},
  'dist/src/report-allocation.js': {functions: ['allocationCandidates', 'allocationEvidence', 'reportAllocation']},
  'dist/src/overview-parents.js': {functions: ['detailParentKind', 'detailParents']},
  'dist/src/overview-granularity.js': {functions: ['collectDetailedOverview']},
  // The levels and detailed rows left overview-granularity.js for this leaf (ARC-04 stage F), which it re-exports; a
  // recording made before names them dist/src/overview-granularity.js#... (compare with --ignore for both).
  'dist/src/overview-levels.js': {
    functions: ['campaignAttributionProfile', 'overviewSourceLevel', 'detailedOverviewRows'],
  },
  'dist/src/report-windows.js': {functions: ['reportWindowState', 'markReportWindow', 'sourceReportTimezone']},
  'dist/src/report-query-access.js': {
    functions: ['reportingConfigScope', 'validateReportingConfig', 'reportingBootstrap'],
  },
  'dist/src/report-file-delivery.js': {classes: {ReportFileDelivery: ['bind', 'queue', 'work', 'download']}},
  'dist/src/reporting-overview.js': {classes: {ReportingOverview: ['handle', 'work']}},
  // Writes and campaigns (ARC-01 phase B, ARC-04; wave 4c): the outputs of amcp_write and amcp_campaign, the review's
  // access and state stages, and the campaign, recipe, spending-policy and write stages whose provider branches move to
  // adapter hooks or whose long functions become staged steps.
  'dist/src/write-review.js': {classes: {WriteReviewService: ['call', 'access', 'state']}},
  'dist/src/campaign-runner.js': {classes: {CampaignRunner: ['handle']}},
  'dist/src/campaign-recipes.js': {functions: ['campaignRecipe', 'recipeMissing', 'assertRecipeDraftCurrent']},
  'dist/src/campaign-clone.js': {functions: ['assertCloneGateway', 'clonePlan', 'applyCloneChanges']},
  'dist/src/campaign-activation.js': {functions: ['activationSteps', 'activationGates']},
  'dist/src/campaign-preflight.js': {functions: ['campaignPreflight']},
  'dist/src/spend-policy.js': {
    functions: [
      'checkSpendPolicy',
      'checkGroupSpendPolicy',
      'policyActivates',
      'unprotectedAccounts',
      'saveSpendPolicy',
    ],
  },
  'dist/src/google-goal-inspection.js': {functions: ['inspectGoogleRecipeGoals']},
  'dist/src/write-effects.js': {functions: ['writeEffects', 'stateTarget', 'effectNames', 'effectReasons']},
  'dist/src/write-impact.js': {functions: ['writeImpact']},
  'dist/src/write-groups.js': {functions: ['splittableBatch', 'needsGroup', 'groupLimitRefusal', 'groupParts']},
  'dist/src/write-rejection.js': {functions: ['nonAppliedRejection', 'rejectedError']},
  // Google Ads' proof that a refusal applied nothing left write-rejection.js for its own module (ARC-01 phase B, wave
  // 4c); a recording made before names it dist/src/write-rejection.js#... (compare with --ignore for both).
  'dist/src/google-write-rejection.js': {functions: ['googleServiceMutate', 'googleRejectionIsNonApplied']},
  'dist/src/write-reconciliation.js': {
    functions: ['findCreated', 'namedTargets'],
    classes: {WriteReconciler: ['call']},
  },
  'dist/src/recipe-context.js': {functions: ['recipeDefaultFields', 'recipeObjective', 'recipeContext']},
  'dist/src/recipe-eligibility.js': {functions: ['recipeEligibility']},
  // The last round of wave 4c: the verification of a write, whose provider parts move to adapter hooks (with the
  // reconciliation's WriteReconciler, the recipe context and the spending policy's saveSpendPolicy above).
  'dist/src/write-verification.js': {classes: {WriteVerifier: ['verify']}},
  // Reddit's page step (wave 4c), with which its creative family reads its profile and post pages instead of
  // src/pagination.ts; a recording made before names those calls dist/src/pagination.js#nextPage.
  'dist/src/reddit-paging.js': {functions: ['redditNextPage']},
  // ARC-04: the WooCommerce store setup, split into staged steps; its outcome per call (the requests go through the
  // caller's own request function, which the suites' fixtures answer).
  'dist/src/woocommerce-connection.js': {functions: ['connectWooCommerce']},
  // ARC-01 phase B, the website's server modules, whose provider facts moved into the registries: the Google renewal
  // (its reads go through NativeTransport, recorded above), Facebook sign-in (SocialSignIn.json is its one fetch: each
  // request and answer), the composition root's startup checks (each refusal and started runtime) and Commerce's store
  // sources.
  'dist/server/google-reauthorization.js': {functions: ['reauthorizeGoogleConnection', 'googleAuthorizationInfo']},
  'dist/server/social-signin.js': {classes: {SocialSignIn: ['start', 'identity', 'json']}},
  'dist/server/runtime.js': {functions: ['createRuntime']},
  'dist/src/woocommerce-source.js': {functions: ['wooCommerceSources', 'wooCommerceStoreDiscovery']},
  // ARC-01 phase B and ARC-04, the website's connection routes and views: what a login's asset selection, sync,
  // default and name save (a route's refusal stops before any of them); Store.updateConnection records the connection
  // a selection, write-access change, sync or renewal saves.
  'dist/server/website-repository.js': {functions: ['saveWebsiteAssets', 'writeDefaultFlag', 'writeConnectionLabel']},
  // ARC-01 phase B, the account model: a client access set's account comparison (Store.resolveConnection, above,
  // compares in the same form).
  'dist/src/access-sets.js': {functions: ['accountKey']},
  // ARC-01 phase B, the website's disconnect with provider revocation: each gateway's revocation target (its endpoint),
  // the offer the disconnect dialog shows and the revocation's outcome (its one request goes through the caller's
  // fetcher, which the suites' fixtures answer).
  'dist/src/provider-revocation.js': {
    functions: ['revocationTarget', 'providerRevocationOffer', 'disconnectWithProviderRevocation'],
  },
  // Wave 4c (ARC-01 phase B, the catalog, compiler, delegated compiler, contracts and service concerns): the catalog
  // registry's validation, help and lookups, and the provider steps whose call sites leave the shared modules for the
  // provider hooks and the provider workflows registry. The steps stay in their provider modules, so both recordings
  // see their calls.
  'dist/src/catalog.js': {classes: {Registry: ['validate', 'help', 'unknownAction', 'acceptsArgument']}},
  'dist/src/google-generation.js': {functions: ['validateGoogleGeneration', 'googleGenerationResult']},
  'dist/src/dv360-targeting-search.js': {functions: ['validateDV360TargetingSearch', 'runDV360TargetingSearch']},
  'dist/src/snapchat-by-ids.js': {functions: ['validateSnapchatByIds', 'checkSnapchatByIdsResult']},
  'dist/src/snapchat-result-ids.js': {functions: ['snapchatResultIds', 'keepResultIds']},
  'dist/src/x-audience-estimate.js': {functions: ['validateXAudienceEstimate', 'runXAudienceEstimate']},
  'dist/src/google-place-action-discovery.js': {
    functions: ['validatePlaceActionRead', 'placeActionReadResult', 'runPlaceActionDiscovery'],
  },
  'dist/src/google-place-action-links.js': {functions: ['placeActionSafeError', 'redactPlaceActionInput']},
  'dist/src/apple-native.js': {functions: ['validateAppleResponse']},
  'dist/src/microsoft-native.js': {functions: ['validateMicrosoftResponse', 'compileMicrosoft']},
  'dist/src/reddit-extensions.js': {functions: ['projectRedditAccountHistory']},
  'dist/src/google-legacy.js': {functions: ['legacyLimitDisclosure', 'adaptGoogleLegacy']},
  // WooCommerce's store discovery (`wooCommerceStoreDiscovery`) is recorded with its store sources, and its store
  // setup (`connectWooCommerce`), Adjust's reporting (`adjustReporting`) and `inspectGoogleRecipeGoals` by the entries
  // above: one entry per module, since a repeated key would replace the earlier list.
  'dist/src/measurement-connection-sync.js': {functions: ['syncMeasurementConnection']},
  'dist/src/google-business-sync.js': {functions: ['syncBusinessConnection']},
  'dist/src/meta-ad-library.js': {functions: ['searchMetaAdLibrary']},
  'dist/src/meta-existing-posts.js': {functions: ['fetchMetaExistingPosts', 'redactMetaPostInput']},
  'dist/src/gtm-diagnostics.js': {functions: ['gtmDiagnostics']},
  'dist/src/microsoft-locations.js': {functions: ['microsoftLocationLookup']},
  'dist/src/meta-asset-usage.js': {functions: ['metaAssetUsage']},
  'dist/src/google-image-usage.js': {functions: ['googleImageUsage']},
  'dist/src/snapchat-asset-usage.js': {functions: ['snapchatAssetUsage']},
  // Wave 4c round 6 (w4c-arc6-workspace): the workspace tool, whose providers' actions are the provider workflows
  // registry's workspace entries, and the outcome links that ask the registry for a provider's page.
  'dist/src/workspace.js': {classes: {WorkspaceService: ['handle']}},
  'dist/src/workflow-outcomes.js': {functions: ['workflowOutcome']},
});
/** Pure functions whose recorded calls replay through the current build (arguments and results are plain data). */
export const replayable = Object.freeze([
  'dist/src/account-id.js#normalizeAccount',
  'dist/src/execution-risk.js#applyExecutionRisk',
  'dist/src/execution-risk.js#independentlyReadOnly',
  'dist/src/execution-risk.js#bodyDeletion',
  'dist/src/google-ads-adapter.js#googleGlobalRead',
  'dist/src/pagination.js#nextPage',
  'dist/src/pagination.js#continuationArguments',
  'dist/src/account-metadata.js#accountPlan',
  'dist/src/account-metadata.js#accountMetadata',
  'dist/src/account-metadata.js#accountCurrency',
  'dist/src/account-metadata.js#accountTimezone',
  'dist/src/account-metadata.js#accountKind',
  'dist/src/scope.js#ownershipReads',
  'dist/src/snapchat-scope.js#snapchatScopedResource',
  'dist/src/snapchat-scope.js#snapchatOrganizationPixels',
  'dist/src/transport.js#losslessReportNumbers',
  'dist/src/provider-error-taxonomy.js#providerErrorCode',
  'dist/src/write-shape.js#assertWriteShape',
  'dist/src/write-shape.js#metaValidationOptions',
  'dist/src/review-state.js#normalizeSnapshot',
  'dist/src/verification-reads.js#entity',
  'dist/src/verification-reads.js#verificationContractVersion',
  'dist/src/verification-reads.js#googleValueVerificationVersion',
  'dist/src/delegated-native.js#delegatedParameterMatches',
  'dist/server/platform-oauth.js#selectionKind',
  'dist/server/platform-oauth.js#selectableKinds',
  'dist/src/reviewed-routes.js#reviewedWriteFamily',
  'dist/src/review-summary.js#reviewSummary',
  'dist/src/preflight.js#spendConfirmationError',
  'dist/src/spend-effects.js#namesSpendField',
  'dist/src/spend-effects.js#deliveryEditFields',
  'dist/src/spend-effects.js#deliveryStops',
  // ARC-04 stage F and ARC-01 (reporting).
  'dist/src/report-native.js#normalizeNativeRow',
  'dist/src/report-native.js#missingNativeMetrics',
  'dist/src/adjust-reporting.js#adjustReportingKind',
  'dist/src/google-sheets.js#sheetsPresentationRequests',
  'dist/src/report-presets.js#validatePresetRows',
  'dist/src/report-resource-scope.js#reportingResourceAccount',
  'dist/src/report-resource-scope.js#reportingResourceAccounts',
  'dist/src/report-breakdowns.js#breakdownValue',
  'dist/src/meta-guided-reports.js#metaBreakdownKey',
  'dist/src/overview-levels.js#campaignAttributionProfile',
  'dist/src/overview-levels.js#overviewSourceLevel',
  'dist/src/overview-parents.js#detailParentKind',
  // Writes and campaigns (wave 4c): builders and stage helpers that read neither the clock nor the environment.
  'dist/src/campaign-recipes.js#campaignRecipe',
  'dist/src/campaign-recipes.js#recipeMissing',
  'dist/src/campaign-activation.js#activationSteps',
  'dist/src/campaign-clone.js#applyCloneChanges',
  'dist/src/write-effects.js#writeEffects',
  'dist/src/write-effects.js#stateTarget',
  'dist/src/write-effects.js#effectNames',
  'dist/src/write-effects.js#effectReasons',
  'dist/src/write-impact.js#writeImpact',
  'dist/src/access-sets.js#accountKey',
  'dist/src/provider-revocation.js#revocationTarget',
  // Wave 4c round 6 (w4c-arc6-workspace).
  'dist/src/workflow-outcomes.js#workflowOutcome',
]);

const posix = file => file.replaceAll('\\', '/');
/** The source text of a compiled target module with its targets wrapped; unchanged for any other module. */
export function instrument(source, spec, moduleId) {
  let out = String(source);
  const appended = [];
  for (const name of spec.functions ?? []) {
    const declaration = new RegExp('^export (async )?function ' + name + '\\(', 'm'),
      arrow = new RegExp('^export const ' + name + ' = ', 'm'),
      original = '__callReplayOriginal_' + name,
      id = JSON.stringify(moduleId + '#' + name),
      call = 'globalThis.__amcpCallReplay ? globalThis.__amcpCallReplay.call(' + id + ', ' + original;
    if (declaration.test(out)) {
      out = out.replace(declaration, (_m, async) => (async ?? '') + 'function ' + original + '(');
      appended.push(
        'export function ' +
          name +
          '(...args) { return ' +
          call +
          ', this, args) : ' +
          original +
          '.apply(this, args); }',
      );
    } else if (arrow.test(out)) {
      out = out.replace(arrow, 'const ' + original + ' = ');
      appended.push(
        'export const ' + name + ' = (...args) => ' + call + ', undefined, args) : ' + original + '(...args);',
      );
    } else appended.push('globalThis.__amcpCallReplay?.missing(' + id + ');');
  }
  for (const [name, methods] of Object.entries(spec.classes ?? {}))
    appended.push(
      'globalThis.__amcpCallReplay?.patchClass(' +
        name +
        ', ' +
        JSON.stringify(moduleId + '#' + name) +
        ', ' +
        JSON.stringify(methods) +
        ');',
    );
  return appended.length ? out + '\n// call-replay instrumentation\n' + appended.join('\n') + '\n' : out;
}

/** The target module id (`dist/src/scope.js`) of a file URL under the repository, or undefined. */
export function targetOf(url, root) {
  if (!String(url).startsWith('file:')) return undefined;
  const relative = posix(path.relative(root, fileURLToPath(url)));
  return Object.hasOwn(targets, relative) ? relative : undefined;
}

const uuid = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi,
  iso = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?(?![\d.])/g,
  epochMs = /\b1[6-9]\d{11}\b/g,
  epochS = /\b1[78]\d{8}\b/g,
  oauthPart = /\b(oauth_(?:nonce|timestamp|signature))="[^"]*"/g,
  randomField = /\b(code_verifier|code_challenge|state|nonce)=([^&\s"]+)/g;
/** Text values that differ between two runs of the same test without meaning anything: IDs, clocks, signatures. */
export function normalizeText(text) {
  return String(text)
    .replace(uuid, '<uuid>')
    .replace(iso, '<time>')
    .replace(epochMs, '<epoch-ms>')
    .replace(epochS, '<epoch-s>')
    .replace(oauthPart, '$1="<oauth>"')
    .replace(randomField, '$1=<random>');
}
/** A recorded value with run-to-run noise removed: strings through normalizeText, epoch numbers as placeholders. */
export function normalizeValue(value) {
  if (typeof value === 'string') return normalizeText(value);
  if (typeof value === 'number')
    return Number.isInteger(value) && value >= 1.6e12 && value < 2e12
      ? '<epoch-ms>'
      : Number.isInteger(value) && value >= 1.7e9 && value < 1.9e9
        ? '<epoch-s>'
        : value;
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === 'object') {
    const out = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeValue(v)]));
    // A refusal whose wait comes from the process clock (also in a recording made before a code joined the set).
    if (
      typeof out.$error === 'string' &&
      clockRefusals.has(out.code) &&
      typeof out.details?.retry_after_ms === 'number'
    )
      out.details = {...out.details, retry_after_ms: '<clock>'};
    return out;
  }
  return value;
}
const secretKey =
  /^(?:authorization|access[-_]?token|refresh[-_]?token|client[-_]?secret|code[-_]?verifier|developer[-_]?token|x-api-key|api[-_]?key|cookie|password)$/i;
const credentialKey =
  /^(?:accessToken|refreshToken|clientSecret|consumerSecret|tokenSecret|password|apiKey|applePrivateKey|developerToken)$/;
const secretField =
  /\b(client_secret|refresh_token|access_token|code_verifier|client_assertion|oauth_token_secret|password)=([^&\s"]+)/g;
// A PKCE verifier, OAuth state or nonce is random by design: a mixed-case token under these names.
const randomKey = /^(?:verifier|codeVerifier|code_verifier|state|nonce|codeChallenge|code_challenge)$/,
  randomToken = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9._~-]{16,}$/;
const digest = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
// These refusals compute their wait from the process clock or the daily reset; a provider's own Retry-After is kept.
const clockRefusals = new Set([
  'TENANT_RATE_LIMIT',
  'PLATFORM_RATE_LIMIT',
  'CIRCUIT_OPEN',
  'PROVIDER_COORDINATION_BUSY',
  'PROVIDER_QUOTA_SHARE_EXHAUSTED',
  'TOKEN_REFRESH_FAILED',
]);
/**
 * A JSON-safe copy of a recorded value: undefined, functions, bytes, maps, sets and errors are marked; instances of
 * classes (a Store, a Registry) are named, not walked; header and credential values are digested, never written;
 * clock-derived deadlines and random OAuth values are placeholders.
 */
export function encode(value, seen = new Set(), depth = 0, key = '') {
  if (value === undefined) return {$undefined: true};
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return {$number: String(value)};
    if (/deadline/i.test(key) || (/timeout|until|_at$|At$/.test(key) && !Number.isInteger(value))) return '<clock>';
    return value;
  }
  if (typeof value === 'bigint') return {$bigint: String(value)};
  if (typeof value === 'string') {
    if (secretKey.test(key) || credentialKey.test(key)) return '<secret:' + digest(normalizeText(value)) + '>';
    if (randomKey.test(key) && randomToken.test(value)) return '<random>';
    const text = value.includes('=')
      ? value.replace(secretField, (_m, name, secret) => name + '=<secret:' + digest(secret) + '>')
      : value;
    return text.length > 20000 ? {$text: digest(normalizeText(text)), length: text.length} : text;
  }
  if (typeof value === 'function') return {$function: value.name || 'anonymous'};
  if (typeof value === 'symbol') return {$symbol: String(value.description)};
  if (depth > 40) return {$deep: true};
  if (seen.has(value)) return {$cycle: true};
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return {$bytes: value.byteLength, sha256: digest(Buffer.from(value.buffer, value.byteOffset, value.byteLength))};
  if (value instanceof ArrayBuffer) return {$bytes: value.byteLength, sha256: digest(Buffer.from(value))};
  if (value instanceof URL) return {$url: value.href};
  if (value instanceof Date) return {$date: Number.isFinite(value.getTime()) ? '<time>' : 'invalid'};
  if (value instanceof URLSearchParams) return {$search: encode(value.toString(), seen, depth + 1, key)};
  if (typeof FormData !== 'undefined' && value instanceof FormData) {
    const entries = [];
    for (const [name, part] of value.entries())
      entries.push([
        name,
        typeof part === 'string'
          ? encode(part, seen, depth + 1, name)
          : {$blob: part.type, size: part.size, name: part.name},
      ]);
    return {$form: entries};
  }
  if (typeof Headers !== 'undefined' && value instanceof Headers)
    return encode(Object.fromEntries([...value.entries()]), seen, depth + 1, key);
  if (value instanceof Error) {
    const details = encode(value.details, seen, depth + 1, 'details');
    if (clockRefusals.has(value.code) && details && typeof details.retry_after_ms === 'number')
      details.retry_after_ms = '<clock>';
    return {
      $error: value.name,
      code: value.code,
      message: value.message,
      status: value.status,
      retryable: value.retryable,
      details,
    };
  }
  seen.add(value);
  try {
    if (value instanceof Map) return {$map: [...value.entries()].map(e => encode(e, seen, depth + 1))};
    if (value instanceof Set) return {$set: [...value].map(v => encode(v, seen, depth + 1))};
    if (Array.isArray(value)) return value.map(v => encode(v, seen, depth + 1, key));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return {$instance: value.constructor?.name ?? 'object'};
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = encode(value[k], seen, depth + 1, k);
    return out;
  } finally {
    seen.delete(value);
  }
}
/** Deterministic JSON of a recorded record after normalization (keys are already sorted by encode). */
export const recordText = record => JSON.stringify(normalizeValue(record));

/**
 * The records of a recording directory, per test file: a map of record text to its count. `failed` names the test
 * files whose process exited with a failure (the recorder's `$exit` record), kept apart from the calls.
 */
export function readRecording(directory) {
  const perTest = new Map(),
    failed = new Set();
  for (const name of fs.readdirSync(directory).sort()) {
    if (!name.endsWith('.calls.jsonl')) continue;
    const test = name.replace(/\.\d+\.calls\.jsonl$/, '');
    const records = perTest.get(test) ?? new Map();
    for (const line of fs.readFileSync(path.join(directory, name), 'utf8').split('\n')) {
      if (!line) continue;
      const {count = 1, ...record} = JSON.parse(line);
      if (record.id === '$exit') {
        if (record.code) failed.add(test);
        continue;
      }
      const text = recordText(record);
      records.set(text, (records.get(text) ?? 0) + count);
    }
    perTest.set(test, records);
  }
  perTest.failed = failed;
  return perTest;
}

/** The leaf paths where two records differ, array indices generalized to `#`. */
export function differingPaths(x, y, prefix = '', out = new Set()) {
  if (x && y && typeof x === 'object' && typeof y === 'object' && Array.isArray(x) === Array.isArray(y)) {
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)]))
      differingPaths(x[k], y[k], prefix + '/' + (Array.isArray(x) ? '#' : k), out);
  } else if (JSON.stringify(x) !== JSON.stringify(y)) out.add(prefix || '/');
  return out;
}

/**
 * The differing records of two recordings, per test file and function: each record only one side holds is paired with
 * the other side's record of the same function that differs from it at the fewest paths.
 */
function pairs(before, after) {
  const out = [];
  for (const test of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = before.get(test) ?? new Map(),
      b = after.get(test) ?? new Map(),
      only = {before: new Map(), after: new Map()};
    for (const text of new Set([...a.keys(), ...b.keys()])) {
      const x = a.get(text) ?? 0,
        y = b.get(text) ?? 0;
      if (x === y) continue;
      const side = x > y ? only.before : only.after,
        id = JSON.parse(text).id;
      side.set(id, [...(side.get(id) ?? []), ...Array(Math.abs(x - y)).fill(text)]);
    }
    for (const id of new Set([...only.before.keys(), ...only.after.keys()])) {
      const left = only.before.get(id) ?? [],
        right = (only.after.get(id) ?? []).map(text => ({text, value: JSON.parse(text)}));
      for (const text of left) {
        const x = JSON.parse(text);
        let best = -1,
          bestPaths;
        right.forEach((other, i) => {
          const paths = differingPaths(x, other.value);
          if (!bestPaths || paths.size < bestPaths.size) [best, bestPaths] = [i, paths];
        });
        if (best < 0) out.push({test, id, before: text});
        else out.push({test, id, before: text, after: right.splice(best, 1)[0].text, paths: [...bestPaths].sort()});
      }
      for (const {text} of right) out.push({test, id, after: text});
    }
  }
  return out;
}

/**
 * What differs between two recordings of the same build: the paths where paired records of each test file and
 * function differed, which a later comparison may ignore unless the outcome flipped, and the functions whose call
 * counts differed, whose differences a later comparison never ignores (compareRecordings: they are unsettled).
 */
export function noiseProfile(before, after) {
  const paths = new Map(),
    counts = new Set();
  for (const p of pairs(before, after)) {
    const key = p.test + '\n' + p.id;
    if (!p.paths) counts.add(key);
    else paths.set(key, new Set([...(paths.get(key) ?? []), ...p.paths]));
  }
  return {paths, counts};
}

/** The key a recording gives a test file (`tests/transport.test.ts` -> `dist_tests_transport.test.js`), or the key. */
export function recordingKey(testFile) {
  const file = posix(String(testFile)),
    run = file.startsWith('tests/') && file.endsWith('.ts') ? 'dist/' + file.replace(/\.ts$/, '.js') : file;
  return run.replace(/[^\w.-]+/g, '_');
}
const outcomeOf = text => (text === undefined ? undefined : JSON.parse(text).out);
const outcomeKind = text => {
  const out = outcomeOf(text);
  return out && typeof out === 'object'
    ? Object.hasOwn(out, 'throws')
      ? 'throws'
      : Object.hasOwn(out, 'returns')
        ? 'returns'
        : undefined
    : undefined;
};
/** A pair whose outcome kind changed: a call returned on one side and threw on the other (an allow and a refusal). */
export const outcomeFlip = p =>
  p.before !== undefined && p.after !== undefined && outcomeKind(p.before) !== outcomeKind(p.after);
const refusalCode = text => {
  const out = outcomeOf(text);
  return typeof out?.throws?.code === 'string' ? out.throws.code : undefined;
};

/**
 * Differences between two recordings, per test file: a paired record that differs only where the calibration
 * (two recordings of one build) also differed is noise; every other paired or unpaired record is a difference.
 * Two kinds of record are never noise, whatever the calibration shows: an outcome flip, and any record of a function
 * whose call count differed in the calibration (a test racing promises or the clock pairs its records differently in
 * each comparison, so the calibration cannot settle them; this rule once classed every difference of such a function
 * as noise, a returns-to-throws flip included). Where the calibration would have absorbed them they are `unsettled`:
 * listed in full and failing the comparison as a difference does. `timing` names, by test file (a path or its
 * recording key), the refusal codes elapsed time decides there (tests/transport.test.ts's burst-pacing test:
 * TENANT_RATE_LIMIT): in that file a flip between a result and one of those refusals, and a record both recordings hold
 * a different number of times, are `timing_dependent`, counted apart without failing; everything else still compares.
 */
export function compareRecordings(before, after, noise, {timing = {}} = {}) {
  const differences = [],
    unsettled = [],
    totals = {},
    noisy = {},
    timed = {};
  const timingCodes = new Map(Object.entries(timing).map(([file, codes]) => [recordingKey(file), new Set(codes)]));
  // Records per side; totals per function count the recording after the change.
  const count = recording =>
    [...recording.values()].reduce((n, map) => n + [...map.values()].reduce((a, c) => a + c, 0), 0);
  for (const map of after.values())
    for (const [text, n] of map) {
      const id = JSON.parse(text).id;
      totals[id] = (totals[id] ?? 0) + n;
    }
  for (const p of pairs(before, after)) {
    const key = p.test + '\n' + p.id,
      allowed = noise?.paths.get(key),
      flip = outcomeFlip(p),
      codes = timingCodes.get(p.test);
    if (codes) {
      // The named file's clock decides how many of the same calls are served, and which are refused with its codes.
      const multiplicity = !p.paths && (p.before ? after.get(p.test)?.has(p.before) : before.get(p.test)?.has(p.after)),
        timedFlip = flip && [refusalCode(p.before), refusalCode(p.after)].some(code => code && codes.has(code));
      if (multiplicity || timedFlip) {
        timed[p.id] = (timed[p.id] ?? 0) + 1;
        continue;
      }
    }
    const varied = noise?.counts.has(key),
      withinCalibration = !!(p.paths && allowed && p.paths.every(path => allowed.has(path)));
    if (varied || (flip && withinCalibration)) {
      unsettled.push({...p, reason: varied ? 'call_count_varied_in_calibration' : 'outcome_flipped_in_calibration'});
      continue;
    }
    if (withinCalibration) {
      noisy[p.id] = (noisy[p.id] ?? 0) + 1;
      continue;
    }
    differences.push(p);
  }
  return {
    tests: new Set([...before.keys(), ...after.keys()]).size,
    records_before: count(before),
    records_after: count(after),
    totals,
    noise: noisy,
    timing_dependent: timed,
    unsettled,
    differences,
    failed_before: [...(before.failed ?? [])].sort(),
    failed_after: [...(after.failed ?? [])].sort(),
  };
}

/** Recorded calls of the replayable functions, distinct by their arguments. */
export function replayCalls(directory) {
  const calls = new Map();
  for (const name of fs.readdirSync(directory).sort()) {
    if (!name.endsWith('.replay.jsonl')) continue;
    for (const line of fs.readFileSync(path.join(directory, name), 'utf8').split('\n')) {
      if (!line) continue;
      const call = JSON.parse(line),
        key = call.id + '\n' + call.args;
      if (!calls.has(key)) calls.set(key, call);
    }
  }
  return [...calls.values()];
}

/** Revives arguments written by the recorder's raw encoder (`$undefined` markers become undefined). */
export function revive(value) {
  if (Array.isArray(value)) return value.map(revive);
  if (!value || typeof value !== 'object') return value;
  if (value.$undefined === true && Object.keys(value).length === 1) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const r = revive(v);
    if (r !== undefined || (v && v.$undefined === true)) out[k] = r;
  }
  return out;
}

async function replay(root, directory, moved) {
  const calls = replayCalls(directory),
    modules = new Map(),
    counts = {},
    differences = [];
  for (const call of calls) {
    const [moduleId, name] = call.id.split('#');
    if (moved.has(call.id)) continue;
    if (!modules.has(moduleId)) modules.set(moduleId, await import(pathToFileURL(path.join(root, moduleId)).href));
    const fn = modules.get(moduleId)[name];
    let outcome;
    if (typeof fn !== 'function') outcome = {missing: true};
    else
      try {
        outcome = {returns: encode(fn(...revive(JSON.parse(call.args))))};
      } catch (error) {
        outcome = {throws: encode(error)};
      }
    const now = JSON.stringify(normalizeValue(outcome)),
      then = JSON.stringify(normalizeValue(call.outcome));
    counts[call.id] = (counts[call.id] ?? 0) + 1;
    if (now !== then)
      differences.push({
        id: call.id,
        args: call.args.slice(0, 400),
        before: then.slice(0, 400),
        after: now.slice(0, 400),
      });
  }
  console.log(
    JSON.stringify({event: 'call_replay_replay', calls: calls.length, differences: differences.length, counts}),
  );
  for (const d of differences.slice(0, 10)) console.log(JSON.stringify(d));
  return differences.length ? 1 : 0;
}

/** Values of a repeated option (`--ignore a --ignore b`). */
const option = (args, name) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
/**
 * `--timing-dependent` values (`tests/transport.test.ts=TENANT_RATE_LIMIT`) as recording key -> the refusal codes the
 * file's clock decides; a file named without codes has only the records it repeats a different number of times
 * counted apart.
 */
export function timingOption(values) {
  const out = {};
  for (const value of values) {
    const [file, codes = '', extra] = String(value).split('=');
    if (!file || extra !== undefined || !/^[A-Z0-9_,]*$/.test(codes))
      throw Error('--timing-dependent takes <test file>[=CODE,...]: ' + value);
    const key = recordingKey(file);
    out[key] = [...new Set([...(out[key] ?? []), ...codes.split(',').filter(Boolean)])].sort();
  }
  return out;
}

function main(argv) {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url))),
    [mode, ...rest] = argv;
  if (mode === 'record') {
    const [directory, ...args] = rest;
    if (!directory) throw Error('record needs an output directory');
    fs.mkdirSync(directory, {recursive: true});
    for (const name of fs.readdirSync(directory))
      if (/\.(?:calls|replay)\.jsonl$/.test(name)) fs.rmSync(path.join(directory, name));
    // Test files: those named, those listed one per line in --list files, and with --related the related selection
    // (tools/related-tests.mjs) of the source files named after it.
    const named = [],
      changed = [];
    for (let i = 0, related = false; i < args.length; i++) {
      if (args[i] === '--list') named.push(...fs.readFileSync(args[++i], 'utf8').split(/\r?\n/).filter(Boolean));
      else if (args[i] === '--related') related = true;
      else (related ? changed : named).push(args[i]);
    }
    if (changed.length) {
      const plan = JSON.parse(
        spawnSync(process.execPath, ['tools/related-tests.mjs', '--plan', ...changed], {cwd: root, encoding: 'utf8'})
          .stdout,
      );
      named.push(...plan.selected);
    }
    const run = [...new Set(named.map(t => (t.endsWith('.ts') ? 'dist/' + t.replace(/\.ts$/, '.js') : t)))].sort();
    if (!run.length) throw Error('no test files to record');
    console.log(JSON.stringify({event: 'call_replay_record', directory, test_files: run.length}));
    const recorder = pathToFileURL(path.join(root, 'tools/call-replay-recorder.mjs')).href;
    let output = '',
      exit = 0;
    // Batches keep each command line short (Windows) while the test runner still runs a batch's files in parallel.
    const batch = 300;
    for (let start = 0; start < run.length; start += batch) {
      const result = spawnSync(
        process.execPath,
        ['--test', '--import', recorder, '--test-reporter=dot', ...run.slice(start, start + batch)],
        {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
          maxBuffer: 1024 * 1024 * 1024,
          env: {...process.env, AMCP_CALL_REPLAY_DIR: path.resolve(directory), AMCP_CALL_REPLAY_ROOT: root},
        },
      );
      output += result.stdout + result.stderr;
      if (result.status !== 0) exit = result.status ?? 1;
    }
    fs.writeFileSync(path.join(directory, 'test-output.txt'), output);
    const recording = readRecording(directory);
    console.log(
      JSON.stringify({
        event: 'call_replay_recorded',
        exit,
        test_processes: recording.size,
        failed_test_files: [...recording.failed].sort(),
        output: 'test-output.txt',
      }),
    );
    return exit === 0 ? 0 : 2;
  }
  if (mode === 'compare') {
    // compare <before> <after> [--calibration <dir> <dir>] [--ignore id ...] [--timing-dependent file=CODE,...]
    // [--show N]
    const [a, b] = rest,
      show = Number(option(rest, '--show')[0] ?? 10) || 10,
      ignore = new Set(option(rest, '--ignore')),
      timing = timingOption(option(rest, '--timing-dependent')),
      at = rest.indexOf('--calibration'),
      calibration = at >= 0 ? [rest[at + 1], rest[at + 2]] : undefined;
    // An intended move (a helper that left its module) is named with --ignore; its callers' records still compare.
    const load = directory => {
      const recording = readRecording(directory);
      for (const [test, map] of recording)
        recording.set(test, new Map([...map].filter(([text]) => !ignore.has(JSON.parse(text).id))));
      return recording;
    };
    const noise = calibration ? noiseProfile(load(calibration[0]), load(calibration[1])) : undefined;
    const result = compareRecordings(load(a), load(b), noise, {timing});
    console.log(
      JSON.stringify({
        event: 'call_replay_compare',
        tests: result.tests,
        records_before: result.records_before,
        records_after: result.records_after,
        differences: result.differences.length,
        unsettled: result.unsettled.length,
        noise: result.noise,
        timing_dependent: result.timing_dependent,
        ignored: [...ignore],
        timing,
        failed_before: result.failed_before,
        failed_after: result.failed_after,
        totals: result.totals,
      }),
    );
    for (const d of result.differences.slice(0, show)) console.log(JSON.stringify(d).slice(0, 4000));
    // Every unsettled record prints: the calibration could not tell it from noise, so a person reads each one.
    for (const d of result.unsettled) console.log(JSON.stringify({unsettled: d.reason, ...d}).slice(0, 4000));
    return result.differences.length || result.unsettled.length ? 1 : 0;
  }
  if (mode === 'replay') {
    const [directory] = rest;
    return replay(root, directory, new Set(option(rest, '--ignore')));
  }
  console.error('Usage: node tools/call-replay.mjs record|compare|replay ...');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const status = main(process.argv.slice(2));
  if (status instanceof Promise) status.then(code => (process.exitCode = code));
  else process.exitCode = status;
}
