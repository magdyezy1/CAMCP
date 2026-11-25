import {recipeContext, recipeContextCall, recipeInputs, resolveBrief} from './recipe-context.js';
import {eligibilityReuse, recipeEligibility} from './recipe-eligibility.js';
import {assertAllocationStep, allocationCreationBinding} from './allocation-plan.js';
import {scheduleAllocationOutcomeQuietly} from './allocation-outcome.js';
import {catalogLineageCreationBinding, catalogRetirementCreationBinding} from './catalog-lineage.js';
import {catalogRetirementOf, withCatalogRetirement} from './catalog-retirement.js';
import {addNativeRequests, meterNativeRequests, withTiming} from './native-request-meter.js';
import {reportRunProgress, runProgressWanted} from './run-progress.js';
import {
  assertSearchExclusionStep,
  assertNewSearchExclusionDraft,
  searchExclusionCreationBinding,
} from './search-exclusion-plan.js';
import {expandTemplate as substitute} from './client-playbooks.js';
import {assertAccountWrite} from './write-access.js';
import {workspaceOwner} from './spend-policy.js';
import {normalizeAccount} from './scope.js';
import {
  assertRecipeDraftCurrent,
  bindRecipeStep,
  campaignRecipe,
  campaignRecipeListing,
  recipeMissing,
} from './campaign-recipes.js';
import {verificationContractVersion} from './verification-reads.js';
import {randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {Store} from './store.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {ownership, ownsRecord, principalOf} from './actor-identity.js';
import {
  executingLeaseMs,
  executionInFlight,
  groupExecuteMarginMs,
  pendingUncertainMs,
  reconciliationFreshMs,
  supersededBy,
  writePartState,
} from './write-records.js';
import {
  groupProgress,
  groupResumable,
  reopenReview,
  retireReview,
  reviewClaim,
  type Retired,
  type Retirement,
} from './write-record-repository.js';
import {retiredRefusal} from './write-common.js';
import {
  MirrorError,
  errorRemedy,
  errorResult,
  refusedBeforeSending,
  refusedByDuplicateGuard,
  refusedByStateCheck,
} from './errors.js';
import {providerRejection} from './provider-validation.js';
import {amendmentCall, applyPatch} from './campaign-amendment.js';
import {
  applyCloneChanges,
  assertCloneGateway,
  cloneSelection,
  clonePlan,
  dropClosure,
  sourceWithoutSelection,
} from './campaign-clone.js';
// A clone's all-or-nothing build is its provider's (ARC-01 phase B, wave 4c: Google's `campaign.clone.allOrNothing`),
// and so are a refused build that created nothing (`campaign.refusedBuild`) and the recipe lookups (`campaign.lookups`).
import {providerHooks, registeredProviderHooks} from './provider-hooks.js';
import type {CampaignPlanBinding, RecipeLookup} from './provider-adapter.js';
import {
  compactPlan,
  detailFullEnvelope,
  detailFullLimit,
  pageBounds,
  preflightView,
  reviewView,
  groupPartsView,
  stepParts,
  stepView,
} from './campaign-view.js';
import {cursorBinding, decodeOffsetCursor, encodeOffsetCursor, invalidCursor} from './page-cursor.js';
import {redactCredentialShapesWithPaths, stable} from './security.js';
import {approvalMoney, approvalSpends, approvalStep, approvalSummary, type StepEffectEntry} from './plan-approval.js';
import {temporaryMediaSources} from './media-retention.js';
import {
  absenceConfirmed,
  absenceProbe,
  adoptReferences,
  probeAbsence,
  refusedAfterSubmission,
} from './campaign-continuation.js';
import {activationGates, activationPlatforms, activationSteps, platformActivation} from './campaign-activation.js';
import {recipeDependencies} from './capability-eligibility.js';
import {
  archivableStates,
  assertPlanRoom,
  assignableMembers,
  collaboratorOf,
  collaboratorRoles,
  linkedTeam,
  listPlans,
  planHoldingReview,
  planPolicy,
  planRight,
  planStates,
  type PlanRight,
} from './campaign-inventory.js';
import {
  backgroundRunView,
  BACKGROUND_RUN_KIND,
  enqueueBackgroundRun,
  heldByStateCheck,
  independentUploads,
  nextUpload,
  serverPushEnabled,
} from './campaign-background.js';
import {
  audit,
  bad,
  boundedPointer,
  boundedStepId,
  field,
  fingerprint,
  noSecrets,
  noSecretSteps,
  optional,
  obj,
  planReference,
  pointer,
  read,
  tool,
  validate,
  writer,
  type ToolCall,
} from './workspace-core.js';
// The refusal of a reference to a step that is not a declared predecessor says which step and which steps may be named (R2.5 r25-field3-refs).
import {undeclaredReference} from './plan-reference-standins.js';
import {
  correctedStep,
  createHelpCall,
  fillStepDefaults,
  liftStepGateways,
  stepShape,
  topLevelMoves,
  topLevelNotUsedWarning,
} from './campaign-step-help.js';
import {visibleProfile} from './client-scope.js';
import {actionHandler, type ActionTable, type ToolContext} from './tool-actions.js';
export const campaignTool = tool(
  'amcp_campaign',
  'Use this for a launch whose later steps need IDs that earlier steps create (campaign, then ad set, then ad); for one change use amcp_write. Create a durable campaign dependency plan from a brief and explicit native steps. Apply approved profiles/templates. recipe_eligibility checks the current business brief without saving a plan: local by default; live:true adds exact read-only account prerequisites. The four Google conversion Search recipes inspect current account-default goals and enabled explicit primary actions in a selected client using its own conversion customer; shared tracking stays unknown. Google Search with Maximize Conversion Value and Google Search with a target ROAS explicitly choose ACCOUNT_RECORDED_VALUES, leave goal and value settings unchanged and save a paused parent with a dedicated budget. target_roas is decimal ratio text from 0.01 to 1000 (3.5 means 350%), compiled to the native double; delivered values, conversion history, eligibility and actual return remain unverified. For the two value-bidding recipes, live eligibility also selects current default value, conversion currency and event-value override settings for the same matching primary actions. It also reads the last reported conversion date and last tag-detection time twice in the native account timezone. These optional aggregate dates remain unknown when absent; tag detection may have no attributable conversion, and no event-level records are read. Optional missing settings stay unknown; configuration does not prove received event values. Pending plans reread retired conversion-value proofs through their original accepted receipts before approval or advancing; completed historical runs are not replayed. The Snapchat website traffic recipe reuses an existing WEB_VIEW creative and saves three paused steps with an explicit AUTO_BID/SWIPES budget and offset schedule. Read-only preflight checks its selected-account ownership, creative type and original HTTPS destination syntax; advertising approval and destination availability remain unverified. The Snapchat lead-generation recipe reuses an existing LEAD_GENERATION creative and its original account-owned form, with an explicit SWIPES or LEAD_FORM_SUBMISSIONS goal. Preflight and native review inspect both definitions; no submitted leads are read, and provider eligibility, privacy and consent acceptance remain unverified. Readers can inspect these settings while existing write blockers remain active. Configuration does not prove event delivery, objective acceptance or write approval. prepare_next resolves only verified predecessor outputs and returns the existing native review; execute_next consumes that exact review, automatically reads back the result, and resumes without duplicate writes. Responses are compact: one row per step with its resource IDs, and the step the call acted on; get with step_id returns a step summary, and detail:"full" the whole plan. A step preflight blocked, or one that failed before reaching the provider, is amended in place with recover_step (patch one field, or send corrected arguments), following the next_call its refusal carries; nothing is sent until its new review. A step the provider refused without applying it (a Google request refused outright) is amended the same way under a new key; for a refusal AMCP cannot prove applied nothing (Meta), confirm_absent reads whether a resource of that name exists and, once the user confirms it does not, allows recover_step. continue_as_new {id, confirmed} carries the steps still to write into a new linked plan, adopting verified predecessors’ IDs with their provenance; the original plan becomes superseded. activation_plan {id} on a completed recipe plan creates a separate linked draft that activates its paused launch (Meta, Google: the campaign; Snapchat: campaign, ad squad, ad in order; Microsoft: refused without a positive location criterion), with its own approval and read-only gates at preflight. list returns compact rows newest first (accounts and platforms per plan), filtered by state, archived, gateway, account_id, connection_id, profile_id, search or awaiting_approval, continued with next_cursor. archive {id, confirmed} sets aside a complete, cancelled or superseded plan: get still returns it, the default list and the 500-plan limit leave it out; unarchive restores it. The plan’s owner or an administrator can assign {id, user_id, role} a workspace member as viewer (read), editor (prepare, run steps, amend, archive) or approver (approve and run); assign {id} lists members, unassign removes one; collaborators see a plan only within their current account access and every write still checks the acting person’s own grant. When the owner requires a distinct approver, a plan that changes spending or activates a launch cannot be approved by its own owner, and its steps execute only under another person’s current approval. To approve a whole plan once: approval_summary returns what the approval covers (every step’s action, account, money and status fields, a large step aggregated with truncated: true; with its step_id it lists every field) and only reads: it runs no preflight and saves, sends and records nothing; approve without confirmed returns the same after the preflight has run; approve with confirmed, that plan_hash and its summary_hash records it; run then prepares and executes every step under it, each still a frozen, read-back review, and stops for anything that needs a person. run_background queues an approved plan whose steps are all media uploads to run on the server: leaving the page or client does not stop it, get shows its progress, and in a plan of independent uploads one failed upload does not hold the others. clone reads an existing Snapchat, Google Search, TikTok or LinkedIn campaign (source.campaign_id; a LinkedIn campaign group) into a new draft plan under a new name, with changes applied (set a field, drop a step); a Google copy is one all-or-nothing step (atomic: false for one step per resource type); the new campaign starts PAUSED and nothing is sent until the plan is reviewed or approved. create, create_from_recipe and clone accept an optional stable idempotency_key (8–100 letters, digits, hyphens or underscores); identical creation input reuses the original plan, while different input conflicts. Recipe and clone steps are saved literally; {{variable}} substitution applies only to the explicit and template steps of create. Allocation preview handoffs bind their exact source and budget ownership to the draft; stale source, changed ownership or amended proposal targets require a fresh preview. Search-exclusion preview handoffs similarly preserve exact retained terms and original ad groups; changed source or target arguments require a new preview. Accepted and uncertain receipts retain their original recovery. No fabricated IDs, implicit launch, or review bypass.',
  [
    'help',
    'create',
    'get',
    'list',
    'prepare_next',
    'execute_next',
    'verify',
    'cancel',
    'validate_provider',
    'preflight',
    'recover_step',
    'reconcile_step',
    'approval_summary',
    'approve',
    'run',
    'run_background',
    'recipes',
    'recipe_context',
    'recipe_eligibility',
    'recipe_lookup',
    'preview_recipe',
    'create_from_recipe',
    'clone',
    'confirm_absent',
    'continue_as_new',
    'activation_plan',
    'archive',
    'unarchive',
    'assign',
    'unassign',
  ],
  {
    topic: {type: 'string', maxLength: 300},
    id: field.id,
    name: field.id,
    brief: field.id,
    profile_id: field.id,
    template: field.id,
    variables: field.object,
    steps: {type: 'array', items: {type: 'object'}, minItems: 1, maxItems: 50},
    review_id: field.id,
    idempotency_key: field.id,
    // Per-action argument notes live in src/first-party-contracts.ts, served by amcp_tool_help (MCP-07).
    acknowledge_temporary_sources: field.bool,
    allocation_preview_id: field.id,
    allocation_preview_hash: field.id,
    consent_preview_id: field.id,
    consent_preview_hash: field.id,
    // The guarded saves of the catalog workflows (COM-02, COM-03): {kind: "removal", preview_id, preview_hash,
    // save_nonce} or {kind: "lineage", id, hash, save_nonce}. Only the workflow that just stored the binding can name it.
    catalog_binding: field.object,
    search_exclusion_preview_id: field.id,
    search_exclusion_preview_hash: field.id,
    confirmed: field.bool,
    spend_change_confirmed: field.bool,
    creative_edit_confirmed: field.bool,
    cap_override_confirmed: field.bool,
    destructive_confirmed: field.bool,
    expected_revision: field.integer,
    query: field.id,
    lookup_kind: {type: 'string', enum: ['country', 'language', 'microsoft_location']},
    account_id: field.id,
    recipe: field.id,
    business: field.object,
    brief_id: field.id,
    apply_playbook_rules: field.bool,
    eligibility_ref: field.id,
    live: field.bool,
    step_id: field.id,
    gateway: field.id,
    arguments: field.object,
    connection_id: field.id,
    detail: {type: 'string', enum: ['compact', 'full']},
    offset: {type: 'integer', minimum: 0},
    limit: {type: 'integer', minimum: 1, maximum: 100},
    plan_hash: {type: 'string'},
    summary_hash: {type: 'string'},
    accept_observed: field.bool,
    actual_hash: {type: 'string'},
    atomic: field.bool,
    source: field.object,
    changes: field.object,
    patch: {type: 'array', minItems: 1, maxItems: 20, items: {type: 'object'}},
    cursor: {type: 'string'},
    state: {type: 'string', enum: planStates},
    archived: field.bool,
    awaiting_approval: field.bool,
    search: {type: 'string', maxLength: 200},
    user_id: {type: 'string'},
    role: {type: 'string', enum: collaboratorRoles},
  },
);
function references(v: any, results: Map<string, JsonObject>, deps: Set<string>): any {
  if (obj(v) && Object.hasOwn(v, '$ref')) {
    const {ref, prefix} = planReference(v),
      at = ref.indexOf('#'),
      id = ref.slice(0, at),
      path = ref.slice(at + 1);
    // Each refusal of a reference says which step and pointer it is about (R2.5 r25-field3-refs, AMCP-02, F2-2): names and pointers, never a value.
    if (at < 1 || !deps.has(id))
      bad('A result reference must name a declared predecessor.', 'INVALID_ARGUMENT', undeclaredReference(ref, deps));
    const result = results.get(id);
    if (!result) bad('The referenced step is not verified.', 'DEPENDENCY_PENDING');
    const value = structuredClone(pointer(result, path));
    if (prefix === undefined) return value;
    if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9][0-9]{0,19}$/.test(String(value)))
      bad('The referenced value is not a numeric ID, so it cannot become a ' + prefix + ' URN.', 'INVALID_REFERENCE', {
        predecessor: boundedStepId(id),
        received_pointer: boundedPointer(path),
        found_type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
      });
    return prefix + String(value);
  }
  if (Array.isArray(v)) return v.map(x => references(x, results, deps));
  return obj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, references(x, results, deps)])) : v;
}
const structure = (steps: JsonObject[]) =>
  steps.map(s =>
    Object.fromEntries(
      [
        'id',
        'kind',
        'gateway',
        'connection_id',
        'account_id',
        'arguments',
        'depends_on',
        'description',
        'expected_currency',
        'prerequisites',
      ]
        .filter(k => s[k] !== undefined)
        .map(k => [k, s[k]]),
    ),
  );
/** The plan a stable creation key names, for this tenant and user. */
function creationId(actor: Actor, key: unknown): string {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(key))
    bad('Use a stable campaign creation key of 8–100 letters, digits, hyphens or underscores.');
  return fingerprint({kind: 'campaign-create', tenant: actor.tenantId, user: actor.userId, key});
}
/** The creation key of a plan's continuation: one continuation per plan, so a retry returns the plan already saved. */
const continuationKey = (id: unknown): string =>
  'continue-' +
  String(id)
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 80);
/**
 * How long a plan stays held for a continuation whose new plan was never made before an editor's cancel releases the hold (r25-field3-errors, the sixth check K2). It
 * must be longer than a creation can run, and the code gives that bound: after it saves the hold, a continuation awaits nothing that leaves the process. `handle` reaches
 * `createPlan`, which is synchronous, without an await, and the saves that follow are synchronous too, so the call runs to its end in the turn of the event loop that
 * saved the hold, and the only time it takes is the store's wait for the database lock: at most `beginBusyDeadlineMs` (5 s, src/store.ts) for each of its six writes (the
 * hold, the new plan and its audit record, the new plan's link, the audit record of the supersession, the old plan), 30 s. No request timeout bounds a running call (the
 * HTTP listener's `requestTimeout`, 45 s, bounds only the receipt of the request), so a hold that has stood for ten minutes, twenty times that, is not being made any more:
 * its call was cut short. A call stopped for longer than that (the process paused, the clock moved) that finishes after the hold was released finds the plan cancelled
 * or continued by someone else, and cancels the plan it made (continueAsNew).
 */
const continuationHoldStaleMs = 10 * 60 * 1000;
/** How many times a call that settles a step after it awaited the provider reads the plan again and saves, when another call saved the plan meanwhile (r25-planmodel, F2). */
const settleAttempts = 5;
/** The states of a plan that can still run: the state a call that settles a step may set (a cancelled plan stays cancelled). */
const livePlanStates = ['draft', 'awaiting_review', 'in_progress', 'attention'];
/**
 * Whether a step is still the one a call executed, as that call left it (`saved`, the step after its first save): the same review, executing, under the stamp that save gave it
 * (`executing_at`, which every later execute of the step replaces). Another call that amended the step, went on from its review, settled it or began to execute it again
 * has made it another step to settle (r25-planmodel, M1, second round).
 */
const sameExecution = (target: JsonObject, saved: JsonObject) =>
  target.review_id === saved.review_id && target.status === 'executing' && target.executing_at === saved.executing_at;
/**
 * What a plan held for its continuation offers when the plan its key names does not exist (r25-field3-errors, the sixth check K2): the call that finishes the continuation,
 * which only the person making it (`superseded_by.by`) can repeat, and whether the hold is `stale`: it has stood longer than a creation can run (continuationHoldStaleMs),
 * and an editor's cancel releases it. A function of the run alone, so that whatever answers for the plan says the same.
 */
const unfinishedContinuation = (run: JsonObject): {next_call: JsonObject; stale: boolean} => ({
  stale: Date.now() - Number(run.superseded_by.at) > continuationHoldStaleMs,
  next_call: {tool: 'amcp_campaign', arguments: {action: 'continue_as_new', id: run.id, confirmed: true}},
});
/**
 * The refusal of a plan that is superseded or held for its continuation, one function of the run (r25-field3-errors, the sixth check K1 and K2): every sentence is a template
 * of src/errors.ts with its values, so that the website says it in Arabic (`message_localization`, and the catalog entry of each template) and no caller builds one by
 * concatenation. `unfinished`: the plan is held and the plan under its `to` does not exist, so the sentence says the continuation was not finished and names the repeat that
 * finishes it. `theirs`: the call is a continue_as_new of someone else's, which only the person making the continuation may repeat.
 */
const supersededRefusal = (
  run: JsonObject,
  unfinished?: ReturnType<typeof unfinishedContinuation>,
  theirs = false,
): MirrorError => {
  const hold = run.superseded_by,
    successor = hold?.id ?? hold?.to,
    named = {by: String(hold?.by ?? ''), to: String(hold?.to ?? '')},
    waiting = {...named, minutes: continuationHoldStaleMs / 60000},
    // The refusal of a held plan names the plan being made, who is making it and the repeat that finishes it (`next_call`: the plan itself, when it exists).
    details = {superseded_by: hold?.to, by: hold?.by, next_call: unfinished?.next_call};
  if (!unfinished && theirs)
    return new MirrorError(
      'RECOVERY_NOT_SAFE',
      "This plan's continuation is being made by {by} as plan {to}; only they can repeat it.",
      {...details, next_call: {tool: 'amcp_campaign', arguments: {action: 'get', id: hold?.to}}},
      400,
      false,
      named,
    );
  if (!unfinished)
    return new MirrorError(
      'INVALID_ARGUMENT',
      'This campaign plan was superseded by plan {successor}, which carries its remaining steps. Continue there.',
      {
        superseded_by: successor ?? null,
        next_call: {tool: 'amcp_campaign', arguments: {action: 'get', id: successor}},
      },
      400,
      false,
      {successor: String(successor ?? '')},
    );
  if (theirs && unfinished.stale)
    return new MirrorError(
      'RECOVERY_NOT_SAFE',
      "This plan's continuation is being made by {by} as plan {to}; only they can repeat it. The continuation of this campaign plan was not finished: plan {to}, which was to carry its remaining steps, has not been made. {by} started it and finishes it by repeating continue_as_new (next_call); an editor can cancel this plan instead.",
      details,
      400,
      false,
      named,
    );
  if (theirs)
    return new MirrorError(
      'RECOVERY_NOT_SAFE',
      "This plan's continuation is being made by {by} as plan {to}; only they can repeat it. The continuation of this campaign plan was not finished: plan {to}, which was to carry its remaining steps, has not been made. {by} started it and finishes it by repeating continue_as_new (next_call); if that cannot be done, an editor can cancel this plan once it has stood for {minutes} minutes.",
      details,
      400,
      false,
      waiting,
    );
  if (unfinished.stale)
    return new MirrorError(
      'INVALID_ARGUMENT',
      'The continuation of this campaign plan was not finished: plan {to}, which was to carry its remaining steps, has not been made. {by} started it and finishes it by repeating continue_as_new (next_call); an editor can cancel this plan instead.',
      details,
      400,
      false,
      named,
    );
  return new MirrorError(
    'INVALID_ARGUMENT',
    'The continuation of this campaign plan was not finished: plan {to}, which was to carry its remaining steps, has not been made. {by} started it and finishes it by repeating continue_as_new (next_call); if that cannot be done, an editor can cancel this plan once it has stood for {minutes} minutes.',
    details,
    400,
    false,
    waiting,
  );
};
const verificationStepStatus = (status: string) =>
  ['verified', 'failed', 'mismatch'].includes(status) ? status : 'verifying';
/**
 * A step whose result later steps may use: verified, accepted as observed by the user (Snapchat S5), or found already
 * current when it was prepared, so nothing was sent (COM-01).
 */
const settled = (s: JsonObject) =>
  ['verified', 'verified_with_acceptance', 'complete', 'skipped_unchanged'].includes(s.status);
/**
 * A family's exact-equality evidence that the target already holds every value a write step would send (COM-01): the
 * step is recorded as skipped_unchanged with that evidence instead of failed. Only a write step, only the refusal a
 * family raises itself from its frozen read (its prerequisites), never one that carries a provider body. A real
 * difference never raises it, so it never hides one.
 */
const alreadyCurrent = (step: JsonObject, error: JsonObject | undefined) =>
  step.kind === 'write' &&
  error?.details?.already_current === true &&
  !!error.details.no_op_evidence &&
  typeof error.details.no_op_evidence === 'object' &&
  !Array.isArray(error.details.no_op_evidence) &&
  error.details.upstream === undefined &&
  error.details.response === undefined;
/**
 * The refusal of a step's review for a changed provider state, with nothing sent (R25 M1, L5-04): the review's own state
 * check refused it (src/errors.ts refusedByStateCheck, raised before anything is claimed) and no idempotency claim exists
 * for the review. The claim is the proof that nothing was sent; a refusal that has one, whatever it says, is never this,
 * so an uncertain write is never taken for an unsent one. Such a step goes back to pending instead of failing.
 */
export const unsentStateChange = (error: JsonObject | undefined, claim: JsonObject | undefined) =>
  refusedByStateCheck(error) && !claim;
/**
 * The refusal of a step's review by the guard against creating twice, with nothing sent (R2.5 M2, lead re-review N7): raised in the
 * transaction that takes the claim, which it rolls back, so no idempotency claim exists for the review (the proof, as for a changed
 * state). Such a step goes back to pending too: the standalone prepare the refusal names would prepare a review that no step holds.
 */
export const unsentDuplicate = (error: JsonObject | undefined, claim: JsonObject | undefined) =>
  refusedByDuplicateGuard(error) && !claim;
/**
 * A duplicate of a create that is still being sent (the earlier claim is pending and young): it is not settled yet, and may never be an
 * obstacle, so the step waits with its review ready, as it does for a busy target (STATE_BUSY), instead of going back to pending.
 */
const duplicateOfExecuting = (error: JsonObject | undefined) =>
  error?.code === 'DUPLICATE_OF_UNCERTAIN_WRITE' && error.details?.earlier_state === 'executing';
/**
 * The status a step takes from the refusal of its execute, and whether the refusal sent nothing (`unsent`: it carries the mark of a refusal raised before the request left, as the
 * transport and the gates raise it). The one rule of both: the step's outcome, and the refusals of a second call of an execution in flight, which are not saved (r25-planmodel, M2).
 * A pause, rate limit, open circuit or busy target clears on its own, so the same review is executed again (`review_ready`); an expired review is prepared again (`pending`); a
 * request that may have reached the provider is `uncertain`; anything else is amended like any step that failed.
 */
const refusalOutcome = (error: JsonObject | undefined): {status: string; unsent: boolean} => {
  const unsent = error?.details?.submission === 'not_sent';
  return {
    unsent,
    status: ['WRITE_OUTCOME_UNCERTAIN', 'WRITE_PARTIAL_OR_FAILED', 'UPSTREAM_RESPONSE_INVALID'].includes(error?.code)
      ? 'uncertain'
      : [
            'SPEND_CONFIRMATION_REQUIRED',
            'CAP_CONFIRMATION_REQUIRED',
            'CREATIVE_EDIT_CONFIRMATION_REQUIRED',
            // WRT-09: refusals before anything is claimed that leave the review valid until a person acts.
            'DESTRUCTIVE_CONFIRMATION_REQUIRED',
            'HUMAN_APPROVAL_REQUIRED',
            'CAP_OVERRIDE_OWNER_REQUIRED',
            'WRITES_PAUSED',
            'STATE_BUSY',
          ].includes(error?.code) ||
          // The refusals the transport raises before it sends (the one list of src/errors.ts) and the media gates' own.
          (unsent && [...refusedBeforeSending, 'MEDIA_MEMORY_BUSY', 'MEDIA_UPLOAD_BUSY'].includes(error?.code)) ||
          // A create identical to this one is still being sent (R2.5 M2, lead re-review N7): the review waits for it.
          (unsent && duplicateOfExecuting(error))
        ? 'review_ready'
        : error?.code === 'REVIEW_EXPIRED'
          ? 'pending'
          : 'failed',
  };
};
/**
 * The step's copy of the guard's refusal, and the call that moves the plan on, for a step the guard held back with nothing sent (R2.5 M3,
 * dupstep). The guard refuses a create at prepare and again at execute, and a step that meets it on either path is waiting for the earlier
 * create to be settled, not broken: changing the request to get past the guard could make the second object the guard exists to prevent. One
 * helper builds the held step on both paths (`holdDuplicate`), so they cannot drift:
 * - the call is the earlier create's own, with the plan's prepare_next after it (lead re-review 2, F3: the guard refuses the plan's prepare while
 *   that create is unresolved, so a prepare_next alone would only be refused again); where the earlier create is a colleague's there is no call
 *   of theirs to name, and a completed twin needs only the new review, so it is the plan's prepare_next alone;
 * - the earlier create's call stays in the refusal (`earlier_next_call`);
 * - where the earlier review belongs to a step of a plan the actor can read, the copy names that plan and step (`earlier_plan_id`,
 *   `earlier_step_id`: `holder`, found from the store by `earlierHolder`), so the person opens the plan that holds the earlier create and reads it
 *   back there; the refusal itself is unchanged, and a colleague's review, or one no plan holds, adds nothing;
 * - the copy carries the mark of a refusal that sent nothing (`submission: "not_sent"`). The guard's refusal at execute sets it itself; at prepare it
 *   carries none (src/write-duplicates.ts, the refusal is unchanged), and the mark is what `heldByStateCheck` holds a step by, so the background
 *   runner never runs a step held on either path without a person's prepare_next.
 */
const heldDuplicate = (
  runId: string,
  error: JsonObject,
  holder?: {plan_id: string; step_id: string},
): {error: JsonObject; next_call: JsonObject} => {
  const again = {tool: 'amcp_campaign', arguments: {action: 'prepare_next', id: runId}},
    earlier = error.details?.next_call,
    next = error.code === 'DUPLICATE_OF_UNCERTAIN_WRITE' && earlier ? {...earlier, then: again} : again;
  return {
    next_call: next,
    error: {
      ...error,
      details: {
        ...error.details,
        submission: 'not_sent',
        next_call: next,
        ...(earlier ? {earlier_next_call: earlier} : {}),
        ...(holder ? {earlier_plan_id: holder.plan_id, earlier_step_id: holder.step_id} : {}),
      },
    },
  };
};
/**
 * What settles a step held for an uncertain twin, as a run tells an agent (R2.5 M3, dupstep round 2, lead review S4-4). It depends on the refusal
 * the step carries, as the step's next_call does (`heldDuplicate`): the earlier create's own call with prepare_next after it for one the actor may
 * settle; prepare_next alone for a colleague's, of which there is no call of theirs to name; and, for a create AMCP cannot look up, only a read of
 * its status, which settles nothing. (A twin still being sent is never held this way: it waits, and a run stops `not_sent` with a wait.)
 */
const duplicateSettling = (refusal: JsonObject | undefined): string =>
  refusal?.details?.earlier_checkable === false
    ? 'Nothing was sent. AMCP cannot look up this kind of create, so reads never settle the earlier one (next_call is only its status): check the provider for the object. If it exists, use it and do not create it again; if it does not, amend the step (recover_step with a changed request): a changed request is a new create. '
    : refusal?.details?.readable === false
      ? // R2.5 r25-field-plan (the lead's re-review R-2): a colleague's create is replaced where it was prepared, which only its owner may do.
        'Nothing was sent. The earlier create belongs to a colleague, so there is no call of theirs to name (next_call is prepare_next alone): ask them, or the workspace owner, to settle it. If it was applied, accept that: prepare_next would make a second object. If it was not applied, ask them to replace it where it was prepared; prepare_next then prepares the step again. '
      : // The actor’s own create that a fresh reconciliation found not applied is replaced by the step itself (`replaceableTwin`).
        'Nothing was sent. Settle the earlier create first (next_call is its call, and prepare_next comes after it). If it was applied, accept that: prepare_next would make a second object. If it was not applied, prepare_next replaces it, once it is your own create and its reconciliation, under fifteen minutes old, found it not applied. ';
/**
 * What a run tells an agent where it stops at a step that the guard against creating twice sent back to pending (R2.5 M2, N7): one
 * reason, for the run that met the refusal and for a later run that prepared the step again (`prepared`). The new review carries a
 * warning only while the earlier create completed in the last ten minutes (`warned`: R2.5 M3, dupstep round 2, lead review S2-1 b): the
 * reason says so only when it does, so that an agent is never told to look for a warning the review does not carry. `refusal` is the one the
 * step carries (`duplicateSettling`).
 */
export const duplicateReason = (
  stepId: unknown,
  code: unknown,
  prepared: boolean,
  warned = true,
  refusal?: JsonObject,
): string =>
  'Step ' +
  String(stepId) +
  (prepared ? ' was refused earlier' : ' was refused') +
  ' (' +
  String(code) +
  ') because an identical create ' +
  (code === 'DUPLICATE_OF_COMPLETED_WRITE'
    ? 'completed after its review was prepared'
    : 'is uncertain or still being sent') +
  ', so executing it could make a second object. ' +
  (prepared
    ? // The stop that shows the step prepared again (lead re-review R-1): the next run executes the review, as item 7 intends, so the reason says
      // what the next run does and never that run does not send it. "never sends it on its own" is true only before the step is prepared again.
      warned
      ? 'It is prepared again, and the new review carries a warning that says so: show the user this review, and only if they want a second object, execute_next with it. run stops here so that the warning is shown before anything is sent. A run called again after this stop executes it, so call run again only once the user has seen the warning and wants it.'
      : 'It is prepared again, and the new review carries no warning: the earlier create is no longer unresolved, and it did not complete in the last ten minutes. Show the user this review, and execute_next with it only if they want it. run stops here so that the review is shown before anything is sent. A run called again executes it.'
    : (code === 'DUPLICATE_OF_COMPLETED_WRITE'
        ? 'Nothing was sent. prepare_next prepares the step again, and the new review carries a warning that says so: show the user that review, and only if they want a second object, execute_next with it. '
        : duplicateSettling(refusal)) + 'run never sends it on its own.');
/**
 * What a run tells an agent where it stops, once, at a step whose ready review carries the warning of an identical create that completed in the
 * last ten minutes (R2.5 M3, dupstep round 2, item 7: the lead's answer to the open question of round 2). The review is shown before any run
 * sends it, as it is when a held step is prepared again; the stop is recorded on the step for that review (`showWarningOnce`), and a run called
 * again after it executes the review, as it did.
 */
const warnedReviewReason = (stepId: unknown): string =>
  'Step ' +
  String(stepId) +
  ' is ready, and its review carries a warning: an identical create completed in the last ten minutes, so executing it makes a second object. Nothing was sent. run stops at such a review once, so that the warning is shown before anything is sent: show the user this review, and only if they want a second object, execute_next with it. A run called again after this stop executes it, so call run again only once the user has seen the warning and wants it.';
/**
 * Whether a plan's approval covers the spend effect of a step (R2.5 r25-field-plan, the owner's Google issue 2): the person gave
 * spend_change_confirmed with it, and the step is one whose spend effect the approval showed (`spend_steps`). An approval recorded before
 * the approval named its steps has no list, and with the flag it covers every step, as it did.
 */
const approvalCoversSpend = (approval: JsonObject | undefined, stepId: unknown): boolean =>
  approval?.spend_change_confirmed === true &&
  (!Array.isArray(approval.spend_steps) || approval.spend_steps.includes(stepId));
/**
 * The stop of a run at a step whose review needs spend_change_confirmed that the plan's approval does not cover (R2.5 r25-field-plan): the
 * stop's view, its reason and what it adds under `run`. The one case with a call of its own: the approval was given without the flag and
 * showed this step as spending, so the same plan and summary approved again with the flag covers it and every other step it showed, and
 * the run stops once instead of at each of them (the owner's report: two calls a step, about 30 for a 16-step plan). Its next call is that
 * approval, the user's to give; the step's own execute_next stays in `step_call` for one step alone. Every other case is the step's own stop,
 * as before: a step the approval did not show (its local compile differed from its review), and an approval recorded without the list.
 * `current` is the plan as it stands now, so the approval is the one on record at this step (lead review S4-3).
 */
const spendStop = (
  current: JsonObject,
  prepared: JsonObject,
): {view: JsonObject; reason: string; extra?: JsonObject} => {
  const approval = current.approval,
    id = String(prepared.step_id),
    shown: string[] = Array.isArray(approval.spend_effect_steps) ? approval.spend_effect_steps : [];
  if (approval.spend_change_confirmed !== true && shown.includes(id)) {
    const open = new Set(current.steps.filter((s: JsonObject) => !settled(s)).map((s: JsonObject) => s.id));
    return {
      view: {
        ...prepared,
        next_call: {
          tool: 'amcp_campaign',
          arguments: {
            action: 'approve',
            id: current.id,
            plan_hash: approval.plan_hash,
            summary_hash: approval.summary_hash,
            confirmed: true,
          },
          add_after_user_approval: {spend_change_confirmed: true},
        },
      },
      reason:
        'Step ' +
        id +
        ' needs spend_change_confirmed, and this plan was approved without it. Nothing was sent. The approval summary showed which steps spend (run.spend_steps lists those still to run): show the user that summary, and only if they authorize those steps, send next_call, which approves this same plan and summary again with spend_change_confirmed. run then covers all of them and does not stop for it again. To authorize only this step instead, send run.step_call.',
      extra: {
        spend_steps: shown.filter(step => open.has(step)),
        ...(prepared.next_call ? {step_call: prepared.next_call} : {}),
      },
    };
  }
  return {
    view: prepared,
    reason:
      'Step ' +
      id +
      ' needs spend_change_confirmed, which the plan approval does not ' +
      (approval.spend_change_confirmed === true
        ? 'cover: its summary did not show this step as spending (approval.spend_steps lists the ones it covers). '
        : 'give. ') +
      'Show the user this review; execute_next with it continues the step, then run continues the plan.',
  };
};
/**
 * A run's time budget (R2.5 field3, AMCP-12; the owner saw it overrun to 41 and 58 seconds): a call returns after about this long so that a
 * response always arrives, and run again continues. It is checked between steps, never inside one (`runApproved`).
 */
const runBudgetMs = 25000;
/**
 * What each settled step of a plan took in all, in milliseconds: its prepare, execute and read-back, the last pass of each (`step.timing_ms`, kept
 * where the native requests are metered). Only a step that settled counts: one that failed or waits was not a whole pass, and a step that found
 * its target already current took only its prepare, which is what it costs.
 */
const stepTimes = (run: JsonObject): number[] =>
  run.steps
    .filter((s: JsonObject) => settled(s) && s.timing_ms && typeof s.timing_ms === 'object')
    .map((s: JsonObject) =>
      Object.values(s.timing_ms as Record<string, unknown>).reduce<number>(
        (sum, ms) => sum + (typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0),
        0,
      ),
    );
/** The median of some numbers (the mean of the middle two for an even count), or undefined for none. */
const medianOf = (values: number[]): number | undefined => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b),
    middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
};
/**
 * The steps of a plan that are settled and the steps that are left, with what is left estimated from what the plan's own steps took
 * (R2.5 field3, AMCP-12): under 300 bytes, on every stop of a run. The estimate is said to be one (`kind`, `not_a_promise`), is named for
 * its basis, and is there only when a settled step has a recorded time and something is left: no time is invented for a plan that has none.
 */
function runProgress(run: JsonObject, executedHere: number, elapsedMs: number): JsonObject {
  const total: number = run.steps.length,
    done: number = run.steps.filter(settled).length,
    times = stepTimes(run),
    median = medianOf(times),
    left = total - done;
  return {
    steps_total: total,
    settled: done,
    remaining: left,
    executed_this_call: executedHere,
    elapsed_ms: elapsedMs,
    budget_ms: runBudgetMs,
    ...(median !== undefined && left > 0
      ? {
          estimate: {
            kind: 'estimate',
            seconds: Math.max(1, Math.ceil((left * median) / 1000)),
            basis: 'median of ' + times.length + (times.length === 1 ? ' step' : ' steps') + ' of this plan',
            not_a_promise: true,
          },
        }
      : {}),
  };
}
/**
 * The steps a continue_as_new leaves out (R2.5 r25-field-plan, the owner's Google issue 1, fix 1b): `changes` is {drop: [step_id]} and nothing
 * else (a step of a saved plan is amended with recover_step), the IDs are text, and they come back sorted and each once, so that the same
 * drop in another order is the same drop.
 */
function continuationDrop(changes: unknown): string[] {
  if (changes === undefined) return [];
  if (!obj(changes) || Object.keys(changes).some(k => k !== 'drop'))
    bad(
      'continue_as_new takes changes: {drop: [step_id]} and nothing else (' +
        (obj(changes) ? Object.keys(changes).filter(k => k !== 'drop') : [typeof changes]).join(', ') +
        ' was sent). A step of a saved plan is amended with recover_step.',
      'INVALID_ARGUMENT',
      {field: 'changes'},
    );
  const drop: unknown = changes.drop ?? [];
  if (!Array.isArray(drop) || drop.some(d => typeof d !== 'string' || !d))
    bad('changes.drop is a list of step IDs (' + JSON.stringify(drop).slice(0, 60) + ' is not).', 'INVALID_ARGUMENT', {
      field: 'changes.drop',
    });
  return [...new Set(drop as string[])].sort();
}
/**
 * The steps a drop takes out of the steps a continue_as_new carries: the ones named and, by the drop rule of a clone (`dropClosure`), the
 * steps that depend on them. A name must be a step still to be written, and every step that goes must be one nothing was sent for (pending, or
 * its review ready): a step that failed, or is executing, is the plan's to settle, never to drop.
 */
function droppedSteps(carried: JsonObject[], drop: string[]): Set<string> {
  const ids = carried.map(s => s.id as string),
    unknown = drop.filter(d => !ids.includes(d));
  if (unknown.length)
    bad(
      'changes.drop names ' +
        unknown.join(', ') +
        ', which ' +
        (unknown.length === 1 ? 'is' : 'are') +
        ' not among the steps still to be written in this plan: ' +
        ids.join(', ') +
        '.',
      'INVALID_ARGUMENT',
      {field: 'changes.drop', allowed: ids},
    );
  const gone = dropClosure(carried, drop);
  for (const step of carried)
    if (gone.has(step.id) && !['pending', 'review_ready'].includes(step.status))
      bad(
        'Step ' +
          step.id +
          ' is ' +
          step.status +
          ', so it cannot be dropped: only a step nothing was sent for (pending, or its review ready) can be. Amend it with recover_step, or cancel the plan.',
        'RECOVERY_NOT_SAFE',
        {step_id: step.id, status: step.status},
      );
  return gone;
}
/**
 * What a run tells an agent where it stops at a step that a refusal of the state check sent back to pending (R25 M1, L5-04):
 * one reason, for the run that met the refusal and for a later run that prepared the step again (`prepared`).
 */
const stateChangedReason = (stepId: unknown, prepared: boolean): string =>
  'Step ' +
  String(stepId) +
  (prepared ? ' was refused earlier' : ' was refused') +
  ' because the provider’s state changed after its review was prepared. ' +
  (prepared
    ? 'It is prepared again over the state as it is now, and nothing was sent: show the user this review, then execute_next with it. run stops here so that the new review is shown before anything is sent. '
    : 'Nothing was sent. Show the user what changed (current.error.details.material, then changed_fields). prepare_next prepares the step again over the state as it is now, and so does run: either returns the new review before anything is sent, and execute_next with that review is the call that sends it. ') +
  'No flag skips this check.';
/**
 * A build its provider refused outright, which provably created nothing (its adapter's `campaign.refusedBuild`, ARC-01
 * phase B: Google's googleAds:mutate builds without partial failure refused with a definitive 4xx, the owner's decision
 * 5, 2026-09-29). Its key stays uncertain and is never sent again; the step may be amended and reviewed under a new key.
 * Every other refusal after submission, and a lost response, still stop the plan.
 */
const rejectedBuild = (step: JsonObject) =>
  step.kind === 'write' &&
  step.status === 'failed' &&
  providerHooks(step.gateway)?.campaign?.refusedBuild?.(step) === true;
/**
 * How a refused step names the refusal it was rejected for: its HTTP status or, for a refusal a provider reports in the body of
 * an HTTP 2xx answer (TikTok's, R2.5 M2), that fact and the provider's own code, a number, never its text.
 */
const refusalMark = (details: JsonObject | undefined): string => {
  const status = details?.http_status;
  return typeof status === 'number' && status >= 200 && status < 300
    ? 'a refusal in its answer' +
        (Number.isSafeInteger(details?.provider_code) ? ', code ' + String(details?.provider_code) : '')
    : 'HTTP ' + (status ?? '4xx');
};
/**
 * The recipe lookups by lookup_kind, each its provider's (`campaign.lookups`). Load-time checks: one provider declares
 * each kind, and one lookup is the service's own (the runner's `lookupMicrosoftLocations`).
 */
const recipeLookups = new Map<string, RecipeLookup>();
for (const hooks of registeredProviderHooks)
  for (const [kind, lookup] of Object.entries(hooks.campaign?.lookups ?? {})) {
    if (recipeLookups.has(kind) || !lookup.search === !lookup.unavailable)
      throw new Error('The recipe lookup ' + kind + ' must be one provider’s, searched or the service’s own.');
    recipeLookups.set(kind, lookup);
  }
if ([...recipeLookups.values()].filter(lookup => lookup.unavailable).length > 1)
  throw new Error('Only one recipe lookup is answered by the service’s own lookup.');
/**
 * The plan bindings by plan field, each its provider's (`campaign.planBinding`, ARC-01 phase B, wave 4c): Tag Manager's
 * consent preview and X's selected catalog removal. A load-time check: one provider each, and only the two the runner
 * keeps a place for.
 */
const planBindings = new Map<string, CampaignPlanBinding>();
for (const hooks of registeredProviderHooks) {
  const binding = hooks.campaign?.planBinding;
  if (!binding) continue;
  if (planBindings.has(binding.key)) throw new Error('Two providers declare the plan binding ' + binding.key + '.');
  planBindings.set(binding.key, binding);
}
const consentBinding = planBindings.get('gtm_consent')!,
  removalBinding = planBindings.get('catalog_removal')!;
if (
  planBindings.size !== 2 ||
  !consentBinding?.check ||
  !removalBinding?.expectation ||
  !removalBinding.under ||
  !removalBinding.changed
)
  throw new Error('The campaign runner keeps a place for the consent and catalog removal plan bindings only.');
const planState = (run: JsonObject, step: JsonObject) =>
  run.steps.every(settled) ? 'complete' : settled(step) ? 'in_progress' : 'attention';
/**
 * The separate activation a completed recipe plan offers (CMP-03): a call that drafts the linked activation plan,
 * never next_call, so a client never moves from a launch into activation without the user choosing it.
 */
const activationOffer = (run: JsonObject): JsonObject =>
  run.state === 'complete' &&
  activationPlatforms.includes(run.recipe?.platform) &&
  !run.activation_of &&
  !run.activation_plan &&
  !run.archived
    ? {
        activation_call: {
          tool: 'amcp_campaign',
          arguments: {action: 'activation_plan', id: run.id},
          meaning:
            'Drafts a separate plan that activates this paused launch, with its own approval, gates and spend confirmation. Nothing is sent by drafting it.',
        },
      }
    : {};
/**
 * Refusals of a step that wait for a person's decision a plan approval never gives (WRT-09: the owner rule beyond a cap
 * and the opt-in settings, owner decisions P1 and P5), and the stop `run` names for each. Each is raised before anything
 * is claimed or sent.
 */
const personDecisions: Record<string, string> = {
  HUMAN_APPROVAL_REQUIRED: 'needs_website_approval',
  CAP_OVERRIDE_OWNER_REQUIRED: 'needs_owner_approval',
  DESTRUCTIVE_CONFIRMATION_REQUIRED: 'needs_destructive_confirmed',
};
/** The call that lists the members who can be named a plan's approver (CMP-05 distinct-approver policy). */
const distinctApproverCall = (run: JsonObject): JsonObject => ({
  tool: 'amcp_campaign',
  arguments: {action: 'assign', id: run.id},
  meaning: 'Lists the workspace members you can name as this plan’s approver.',
});
/**
 * The call that shows a person what a plan's approval covers (R2.5 field3, AMCP-07): the read-only summary, which `approve` with `confirmed`
 * then records. Every refusal and answer that sends a client back to "show the user the summary" names it, so that the first thing a client
 * does is a call that reads, never one that records.
 */
const summaryCall = (planId: unknown): JsonObject => ({
  tool: 'amcp_campaign',
  arguments: {action: 'approval_summary', id: planId},
});
/**
 * The refusals of a plan that is archived, superseded or cancelled, which handle makes in the order the plan's checks run, and approval_summary
 * makes too: there is no approval to show for a plan that no longer runs. One place each, so that the two cannot drift.
 */
const refusePlanArchived = (run: JsonObject): never =>
  bad('This campaign plan is archived. Unarchive it to work on it again.', 'PLAN_ARCHIVED', {
    next_call: {tool: 'amcp_campaign', arguments: {action: 'unarchive', id: run.id}},
  });
// The refusal of a superseded plan, or of one held while its continuation is made (r25-field3-errors, the fifth check G and the sixth check K2), is one function of the
// plan (`supersededRefusal`): it names the plan that carries the steps, the one the hold's key names while that plan is being made, and, where that plan does not exist
// yet (`unfinished`, which only the runner can read from the store), says the continuation was not finished and names the repeat that finishes it. The helper is the one
// place handle and approval_summary both refuse through, so that a read says what every other action says (r25-field3-merge, merges 12 and 13).
const refusePlanSuperseded = (run: JsonObject, unfinished?: ReturnType<typeof unfinishedContinuation>): never => {
  throw supersededRefusal(run, unfinished);
};
const refusePlanCancelled = (): never => bad('This campaign plan was cancelled.');
/**
 * What a plan whose preflight blocked a step says beside the blocked view it always answered (R2.5 field3, M5-b: the M4a review's item 8). The view was
 * success-shaped, with `blocked: true` and the correction of the first blocked step, but no field a client could stop on: no `approvable: false`, no
 * refusal code and, for run, no `run` object. These fields are additive, and every old field stays, because the website reads
 * `missing_requirements[0].error.message` (web/creative-push.js) and `blocked` (web/campaign-workflows.js).
 *
 * - approve (with or without `confirmed`) and approval_summary: `approvable: false`, `approved: false` and the refusal PLAN_PREFLIGHT_BLOCKED, with its
 *   category and remedy as every refusal carries them and the count of blocked steps. A blocked plan stores no approval and sends nothing: this
 *   answer comes before approve does anything.
 * - run: `run: {executed: [], stopped: "needs_attention", reason: "preflight_blocked", progress}`, the stop the website already words. It carries
 *   the progress that every stop of a run carries (lead review S4-3): the plan's settled and remaining steps, nothing executed by this call and no
 *   time passed, since the blocked view is answered before anything is read or sent.
 * - every other action keeps its answer. Making the blocked answer an `isError` refusal is a wider design (the website's three readers and every
 *   journey baseline), which is the lead's and the owner's to decide.
 */
function blockedAnswer(action: unknown, blockedSteps: number, run: JsonObject): JsonObject {
  if (action === 'run')
    return {
      run: {executed: [], stopped: 'needs_attention', reason: 'preflight_blocked', progress: runProgress(run, 0, 0)},
    };
  if (action !== 'approve' && action !== 'approval_summary') return {};
  const refusal = new MirrorError(
      'PLAN_PREFLIGHT_BLOCKED',
      'Preflight blocked one or more steps of this plan, so it cannot be approved or run yet.',
      {blocked_steps: blockedSteps},
    ),
    remedy = errorRemedy(refusal);
  return {
    approvable: false,
    approved: false,
    refusal: {
      code: refusal.code,
      message: refusal.message,
      category: remedy.category,
      remedy,
      details: refusal.details,
    },
  };
}
/** The call that accepts a mismatched step's observed state; the flag is the user's, never pre-filled. */
const acceptCall = (run: JsonObject, step: JsonObject) => ({
  tool: 'amcp_campaign',
  arguments: {action: 'reconcile_step', id: run.id, step_id: step.id, actual_hash: step.verification.actual_hash},
  add_after_user_approval: {accept_observed: true},
});
/** While an earlier step awaits read-back or the user's decision on a mismatch, the first step whose declared
 * predecessors are all settled. Failed, uncertain or processing steps still stop the whole plan. */
function independentStep(run: JsonObject): string | undefined {
  if (run.steps.some((s: JsonObject) => ['uncertain', 'failed', 'processing'].includes(s.status))) return undefined;
  const done = new Set(run.steps.filter(settled).map((s: JsonObject) => s.id));
  for (const status of ['executing', 'review_ready', 'pending']) {
    const step = run.steps.find(
      (s: JsonObject) => s.status === status && s.depends_on.every((d: string) => done.has(d)),
    );
    if (step) return step.id;
  }
  return undefined;
}
/** The earliest deadline among a plan's temporary files (its run-by time), or null when none has one left. */
function earliestDeadline(temporary: {expires_at: string | null}[]): string | null {
  const deadlines = temporary.map(t => t.expires_at).filter((t): t is string => t !== null);
  return deadlines.length ? deadlines.reduce((a, b) => (a < b ? a : b)) : null;
}
/** A plan's run-by time must leave this long to run it (MED-03 B). */
export const RUN_BY_MINIMUM_MS = 5 * 60000;
/**
 * Refuses a plan whose temporary files are deleted too soon to run it: one already gone, or the earliest deadline less
 * than five minutes away (MED-03 B, owner decision D23). Upload those files again and use the new uploads.
 */
function assertRunnableSources(temporary: {step_id: string; source_id: string; expires_at: string | null}[]) {
  const soon = temporary.filter(
    t => t.expires_at === null || Date.parse(t.expires_at) - Date.now() < RUN_BY_MINIMUM_MS,
  );
  if (soon.length)
    bad(
      'Temporary files in this plan are deleted in less than 5 minutes, or already were, which is too soon to run it. Upload those files again and use the new uploads, or import them from a link or Google Drive and have an owner retain them.',
      'TEMPORARY_SOURCES_EXPIRING',
      {temporary_sources: soon, minimum_minutes: RUN_BY_MINIMUM_MS / 60000},
    );
}
/** A plan's state after a step of a plan of independent uploads: one that failed or is uncertain still needs a person. */
function uploadsState(run: JsonObject, step: JsonObject): string {
  return independentUploads(run) &&
    !run.steps.every(settled) &&
    run.steps.some((s: JsonObject) => ['failed', 'uncertain', 'mismatch'].includes(s.status))
    ? 'attention'
    : planState(run, step);
}
/**
 * Refusals of a media step's prepare that clear with time (shared media capacity, a busy processor, full review staging,
 * low storage, a provider rate limit). The step stays pending, nothing is sent, and run waits instead of failing it.
 */
const mediaPrepareBusy = (error: JsonObject | undefined) =>
  error?.retryable === true || ['MEDIA_STAGING_FULL', 'MEDIA_PROCESSOR_BUSY'].includes(error?.code);
/**
 * How long a step whose prepare met a busy target waits before it is prepared again (MED-03 B; R2.5 M3, dupstep, for a create identical to one
 * still being sent): the refusal's own wait, between one and sixty seconds, and five where it names none.
 */
const busyWait = (error: JsonObject | undefined): number =>
  Math.max(1000, Math.min(60000, Number(error?.details?.retry_after_ms) || 5000));
/**
 * Read lag after a create of the same plan (R2.5 field3, package r25-field3-livefix, item 6; the live check LV-19 LPV of 2026-11-21): right after a
 * plan created and verified an ad group, the ad step's prepare was refused STATE_TARGET_MISMATCH (one read, no write), because the provider's read had
 * not caught up, and the ad group read back moments later. A prepare only reads, so when it cannot find an object that a verified earlier step of the
 * same plan created, the engine waits briefly and prepares again: at most three prepares, with these waits between them (6 seconds in all), before it
 * refuses. Nothing is ever resent: a prepare sends no write, and a write's own review is never repeated by this. The refusal that remains says it may be
 * the provider's read delay and that preparing again is safe. The waits are a seam for the tests (`setPlanReadLagWaits`), as the deprecation clock is.
 *
 * What counts as that refusal (the lead's review of this package, S2-1): a read miss (STATE_TARGET_MISMATCH or STATE_NOT_FOUND) that names, in its details, a value
 * that one of the step's references to a verified write step of the plan resolved to (`verifiedWriteValues`). The exact-target refusal of the state stage names
 * the IDs its read asked for (src/write-state.ts) and the families' refusals name theirs (`adgroup_id`, `campaign_id`). A refusal of another object (a post that is
 * gone), one that names what blocked the step (`details.blocked_by`, as item 8's does), one with a call of its own (`details.next_call`) and every other code, a
 * provider's 404 included, which names no object, are prepared once and returned as they were, with their own remedy and amendment call.
 */
let readLagWaitsMs: readonly number[] = [2000, 4000];
export function setPlanReadLagWaits(waits: readonly number[]): readonly number[] {
  const previous = readLagWaitsMs;
  readLagWaitsMs = waits;
  return previous;
}
/** The codes of a read that did not find what it asked for. */
const readMissCodes: readonly string[] = ['STATE_TARGET_MISMATCH', 'STATE_NOT_FOUND'];
/** The IDs and names a refusal gives in its details: a value there, or the values of a list there, and nothing nested in an object (a call that echoes them names no object). */
const namedValues = (error: JsonObject): string[] =>
  Object.values(obj(error.details) ? error.details : {})
    .flatMap(value => (Array.isArray(value) ? value : [value]))
    .filter(value => typeof value === 'string' || typeof value === 'number')
    .map(String);
/**
 * Whether a refusal is a read that did not find an object a verified earlier step of the plan created, the only refusal a step is prepared again for: a read miss
 * that names one of `referenced` (the values the step's references to those steps resolved to), and no refusal that names what blocked the step or carries a call of its own.
 */
export function isReadLagMiss(error: JsonObject | undefined, referenced: ReadonlySet<string>): boolean {
  if (!error || !readMissCodes.includes(error.code) || !referenced.size) return false;
  const details = obj(error.details) ? error.details : {};
  if (details.blocked_by !== undefined || details.next_call !== undefined) return false;
  return namedValues(error).some(value => referenced.has(value));
}
/**
 * The values that a step's references to verified write steps of its plan resolve to (the IDs those steps created), and, for a reference with a URN prefix, the URN: a
 * step that references none cannot be waiting for an object its plan created. A reference that does not resolve here is left out (the step's own preparation refuses it).
 */
export function verifiedWriteValues(
  run: JsonObject,
  step: JsonObject,
  results: ReadonlyMap<string, JsonObject>,
): Set<string> {
  const verifiedWrites = new Set<string>(
      run.steps
        .filter(
          (s: JsonObject) => s.kind === 'write' && ['verified', 'verified_with_acceptance'].includes(String(s.status)),
        )
        .map((s: JsonObject) => s.id),
    ),
    values = new Set<string>(),
    walk = (v: unknown) => {
      if (obj(v) && Object.hasOwn(v, '$ref')) {
        const {ref, prefix} = planReference(v),
          at = ref.indexOf('#'),
          id = ref.slice(0, at);
        if (at < 1 || !verifiedWrites.has(id)) return;
        let value: unknown;
        try {
          value = pointer(results.get(id), ref.slice(at + 1));
        } catch {
          return;
        }
        if ((typeof value === 'string' || typeof value === 'number') && String(value) !== '') {
          values.add(String(value));
          if (prefix !== undefined) values.add(prefix + String(value));
        }
      } else if (Array.isArray(v)) v.forEach(walk);
      else if (obj(v)) Object.values(v).forEach(walk);
    };
  walk(step.arguments);
  return values;
}
const readDelayAction =
  'The provider did not show an object that this plan created and verified a moment earlier, and it still did not after AMCP waited and read again: it may be the provider’s read delay, which clears in seconds. Nothing was sent, so preparing the step again is safe: send recover_step for it with no change (the plan’s hash and approval stay), or run the plan again.';
/** The refusal with what the engine did and what it means (`details.read_delay`), in the words above. */
function withReadDelay(error: JsonObject, attempts: number, waitedMs: number): JsonObject {
  return {
    ...error,
    details: {...(error.details ?? {}), read_delay: {attempts, waited_ms: waitedMs, nothing_sent: true}},
    remedy: {...(error.remedy ?? {}), action: readDelayAction, mutation_retry_safe: false},
    next_action: readDelayAction,
  };
}
/**
 * A prepare, and again after each wait while it is refused by a read lag (`isReadLagMiss`), at most once for each wait. A success, a refusal that is no read lag, and
 * a refusal of a step that references no verified create are returned as they are, at once; a read lag that outlasts the waits is returned with what the engine did
 * (`withReadDelay`). `waits` and `sleep` are the test seams of the loop alone.
 */
export async function prepareAfterReadLag(
  prepare: () => Promise<JsonObject>,
  referenced: ReadonlySet<string>,
  waits: readonly number[] = readLagWaitsMs,
  sleep: (ms: number) => Promise<unknown> = pause,
): Promise<JsonObject> {
  let out = await prepare(),
    waited = 0,
    attempts = 1;
  if (out.success || !isReadLagMiss(out.error, referenced)) return out;
  for (const wait of waits) {
    await sleep(wait);
    waited += wait;
    attempts++;
    out = await prepare();
    if (out.success || !isReadLagMiss(out.error, referenced)) return out;
  }
  return {...out, error: withReadDelay(out.error, attempts, waited)};
}
/** Rollback switch for the summary binding (WRT-05): AMCP_PLAN_SUMMARY_HASH=false accepts an approval by plan_hash alone. */
const summaryHashRequired = () => process.env.AMCP_PLAN_SUMMARY_HASH !== 'false';
/** One amcp_campaign call (ARC-04 stage D): its arguments and the caller. */
type CampaignCall = ToolContext;
/** A call on a saved plan, which the checks before its action read and left as it is. */
interface PlanCall extends ToolContext {
  readonly run: JsonObject;
}
/** A call on the plan's next step, as the next-step checks found it. */
interface StepCall extends PlanCall {
  readonly next: JsonObject;
}
export class CampaignRunner {
  /**
   * The origin of a create that create_from_recipe or clone builds, keyed by that exact input object, so tool input
   * can never claim one. Its steps stay literal: ad text such as "Use code {{SAVE10}}" is saved byte for byte instead
   * of being expanded or refused (CMP-02 d). The origin joins the creation fingerprint, so one idempotency_key names
   * one recipe input or one clone request (CMP-02 b).
   */
  private origins = new WeakMap<JsonObject, JsonObject>();
  /** What a call that creates a plan for another puts in the plan's first save (`createPlan`): not part of what the creation key names (`origins`). */
  private bindings = new WeakMap<JsonObject, JsonObject>();
  /** The prepare and execute calls `run` makes under a plan's approval: an approver may make them (CMP-05). */
  private underApproval = new WeakSet<JsonObject>();
  /**
   * The prepare_next and execute_next calls `run` makes for a plan of independent uploads, keyed by that exact input
   * object so tool input can never claim it: they move past a failed, uncertain or processing upload to the next one
   * (MED-03 B). A person's own prepare_next and execute_next are unchanged and stop at the first unsettled step.
   */
  private pastStopped = new WeakSet<JsonObject>();
  constructor(
    private store: Store,
    private call: ToolCall,
    private verifyWrite: (actor: Actor, id: string) => Promise<JsonObject>,
    private providerValidation: (actor: Actor, input: JsonObject) => Promise<JsonObject>,
    private preflight?: (actor: Actor, steps: JsonObject[]) => Promise<JsonObject>,
    private acceptsAccountId: (gateway: string, operation?: string) => boolean = () => true,
    private inspectConversionGoals?: (actor: Actor, scope: JsonObject, current: () => void) => Promise<JsonObject>,
    /** The Microsoft location lookup (CMP-03, src/microsoft-locations.ts); absent, the lookup is unavailable. */
    private lookupMicrosoftLocations?: (actor: Actor, input: JsonObject) => Promise<JsonObject>,
    /**
     * The canonical name of an action a step names (T7, src/action-aliases.ts): a near-miss spelling comes back as the
     * action it stands for, and the caller is told where it was written (`field`); any other name comes back as it is.
     * Absent, names are saved as given.
     */
    private canonicalAction?: (gateway: string, name: string, field: string) => string,
    /** A finding the response carries beside its result (`meta.argument_warnings`): a gateway a step wrote inside its arguments. */
    private noteWarning?: (warning: JsonObject) => void,
    /**
     * The spend effect of each write step of a plan, by step ID (R2.5 r25-field-plan, src/campaign-spend-effects.ts): whether its review will
     * ask execute for spend_change_confirmed, decided by compiling it locally, and (r25-approval-effects) whether it deletes, from the same compile. Absent, the approval names no spend effect and offers the
     * flag by money fields alone, as before. It comes AFTER `noteWarning` (the M3 merge): both packages appended an optional callback
     * after `canonicalAction`, and a mis-ordered merge would hand the compile `noteWarning`'s slot.
     */
    private spendEffects?: (steps: JsonObject[]) => ReadonlyMap<string, StepEffectEntry>,
    /**
     * One compiled account-scoped read run as the actor (r25-field2-access B2, MirrorService.runPlan): what an activation gate reads
     * that no catalog action names (Meta's account pixel list). It comes AFTER `spendEffects`, the last optional callback of the M3 merge.
     */
    private runPlan?: (actor: Actor, plan: CompiledRequest, input: JsonObject) => Promise<unknown>,
    /**
     * The steps among those it is given that apply a secret-like value, such as a creator's authorization code, by step ID (r25-m4b-smartpush,
     * the lead's review S1-2, src/campaign-spend-effects.ts `stepsWithSecretFields`); `only` names the steps to judge. A plan is stored as it is
     * written, so create and an amendment refuse such a step. It comes AFTER `runPlan`; absent, no step is refused for it.
     */
    private secretSteps?: (steps: JsonObject[], only?: ReadonlySet<string>) => string[],
  ) {}
  /**
   * A plan the actor may act on with one of `rights` (CMP-05): its owner and administrators always; a collaborator by
   * role, within current account access. Reading needs `view`.
   */
  private owned(actor: Actor, id: string, rights: PlanRight[] = ['view']) {
    const p = read(this.store, actor, 'campaign_run', id);
    // A plan follows its person across the website and that person's AI clients (MCP-02); its reviews do not.
    if (!rights.some(right => planRight(this.store, actor, p, right))) {
      // A collaborator whose role does not cover the action is told so; anyone else learns nothing more (CMP-05).
      const role = collaboratorOf(p, actor)?.role;
      if (role && planRight(this.store, actor, p, 'view'))
        bad(
          'Your role on this campaign plan does not allow this action. Ask the plan’s owner to change your role.',
          'FORBIDDEN',
          {plan_role: role},
        );
      bad('Campaign plan belongs to another actor.', 'FORBIDDEN');
    }
    if (p.plan_hash !== fingerprint(structure(p.steps)))
      bad('The saved plan failed its integrity check.', 'PLAN_CHANGED');
    return p;
  }
  /**
   * A plan linked from one the actor already acts on (the plan it continues), read for its verified results only. The
   * link was recorded by a person allowed to make it; the integrity check still applies.
   */
  private linked(actor: Actor, id: string) {
    const p = read(this.store, actor, 'campaign_run', id);
    if (p.plan_hash !== fingerprint(structure(p.steps)))
      bad('The saved plan failed its integrity check.', 'PLAN_CHANGED');
    return p;
  }
  /**
   * The plan as it is stored, with the integrity check and nothing else: no check of the actor's rights, and none that they are still active. The plan a call that was allowed
   * when it began saves the outcome of (`settle`): withdrawing the person's role, or deactivating them, while their write was in flight does not take the outcome of the write
   * away from the plan, which was left executing for good (r25-planmodel, M5, second round). What the person is shown afterwards is checked by the caller.
   */
  private stored(actor: Actor, id: string) {
    const p = this.store.document(actor.tenantId, 'campaign_run', id);
    if (p.plan_hash !== fingerprint(structure(p.steps)))
      bad('The saved plan failed its integrity check.', 'PLAN_CHANGED');
    return p;
  }
  /**
   * A step's review, and the execution or upload it started, stays with the connection (credential) that prepared it
   * while the plan follows its person (MCP-02). Another connection is refused here, before the plan changes, so it can
   * neither mark the step failed nor be handed a review it cannot execute. As at execute, the workspace owner may
   * execute a review of people another member prepared (personal-data policy, rule 3).
   */
  private assertReviewHolder(actor: Actor, run: JsonObject, step: JsonObject) {
    if (typeof step.review_id !== 'string') return;
    for (const kind of step.kind === 'media'
      ? ['media_review']
      : ['write_review', 'write_review_group', 'media_review']) {
      const review = optional(this.store, actor.tenantId, kind, step.review_id);
      if (!review) continue;
      if (
        review.user_id === actor.userId ||
        (kind === 'write_review' && review.plan?.personalData && workspaceOwner(this.store, actor))
      )
        return;
      const pending = step.status === 'review_ready',
        expires = Number(review.expires_at);
      bad(
        pending
          ? 'This step’s review was prepared from another connection (an AI client, connector token or website session), and only that connection can execute it. Nothing was submitted.'
          : 'This step’s upload or execution was started from another connection (an AI client, connector token or website session), and only that connection can continue it.',
        'REVIEW_HELD_ELSEWHERE',
        {
          step_id: step.id,
          ...(pending && Number.isFinite(expires)
            ? {
                review_expires_at: new Date(expires).toISOString(),
                next_call: {tool: 'amcp_campaign', arguments: {action: 'prepare_next', id: run.id}},
              }
            : {}),
        },
      );
    }
  }
  /** `rights: false` reads the saved plan back without the actor's rights: the save of an outcome of a call that was allowed when it began (`settle`). */
  private save(actor: Actor, run: JsonObject, rights = true) {
    const {id, revision, ...data} = run;
    this.store.putDocument(actor.tenantId, 'campaign_run', id, {...data, updated_at: Date.now()}, revision);
    const saved = rights ? this.owned(actor, id) : this.stored(actor, id);
    // DEC-02: a completed allocation plan whose every step was verified schedules its outcome review (idempotent).
    if (saved.allocation && saved.state === 'complete') scheduleAllocationOutcomeQuietly(this.store, actor, saved);
    return saved;
  }
  /**
   * The save of a call that settles one step after it awaited the provider (r25-planmodel, F2). The call saved its copy of the plan with the step executing, and any save
   * another call made meanwhile (an approval, by the owner or by another person) made the revision of that copy out of date: the outcome was lost, the write was applied
   * and its claim complete, and the step stayed executing, with no crash and no fault. The plan is read again, `apply` changes the step it names on that copy (and the
   * plan's state, where it returns true), and the copy is saved with the revision check, at most `settleAttempts` times over, so that what the other call saved stays. When
   * the tries run out the refusal names the resume, which replays the receipt and settles the step. Undefined when `apply` has nothing to change.
   */
  private settle(
    actor: Actor,
    planId: string,
    stepId: string,
    apply: (plan: JsonObject, step: JsonObject) => boolean,
  ): JsonObject | undefined {
    let last: MirrorError | undefined;
    for (let attempt = 0; attempt < settleAttempts; attempt++) {
      // The call was allowed when it began (r25-planmodel, M5, second round): a person unassigned or deactivated while their write was in flight still has its outcome saved.
      const fresh = this.stored(actor, planId),
        step = fresh.steps.find((s: JsonObject) => s.id === stepId);
      if (!step || !apply(fresh, step)) return undefined;
      try {
        return this.save(actor, fresh, false);
      } catch (e) {
        if (!(e instanceof MirrorError && e.code === 'REVISION_CONFLICT')) throw e;
        last = e;
      }
    }
    const held = this.stored(actor, planId),
      resume = this.resumeCall(
        held,
        held.steps.find((s: JsonObject) => s.id === stepId),
      );
    throw new MirrorError('REVISION_CONFLICT', last!.message, {step_id: stepId, next_call: resume}, last!.status);
  }
  /**
   * What an execute that awaited the provider saved on its step, and on the plan's state, applied to the plan as it is now (`settle`). `step` is the call's copy after it
   * changed it, `saved` the step and the plan's state as that call saved them before it awaited: every field of the step that differs is set (or removed) on the plan's own
   * step, whatever else another call saved on it. The state is set only while the plan is live: a plan cancelled meanwhile stays cancelled, and its step records what the
   * provider did.
   *
   * Only to the step this call executed (r25-planmodel, M1, second round). While the call awaited, another call may have amended the step (it holds another review, or
   * none), settled it, or begun to execute it again: the outcome is then not the step's, and saving it put a step with no review in the plan, took a verified step back
   * to ready, or undid a live execute. A write that was applied (`applied`) or may have been (`sent`) is the step's whatever state it was left in, unless it is settled or
   * holds another review; one that sent nothing (`unsent`: busy, paused, a changed state, a held duplicate) says nothing of a step another call has moved on, and applies
   * only to the execution that made it (`sameExecution`). What is not applied leaves the plan as it is, with the receipt where a later read finds it (the review's claim, its
   * status) and a record in the audit.
   *
   * An applied write also takes off the step the error another call left on it, and the plan's state is the one its steps now imply (`uploadsState` of the plan as it is):
   * the state this call computed saw the steps as they were when it began, and two steps that settle together left a complete plan live (M4).
   */
  private saveSettled(
    actor: Actor,
    held: JsonObject,
    stepId: string,
    saved: {step: JsonObject; state: string},
    outcome: 'applied' | 'sent' | 'unsent',
  ): JsonObject {
    const step = held.steps.find((s: JsonObject) => s.id === stepId),
      changed = new Map<string, unknown>();
    for (const key of new Set([...Object.keys(saved.step), ...Object.keys(step)]))
      if (JSON.stringify(saved.step[key]) !== JSON.stringify(step[key])) changed.set(key, step[key]);
    const kept: JsonObject = {};
    const done = this.settle(actor, held.id, stepId, (plan, target) => {
      if (
        target.review_id !== saved.step.review_id ||
        settled(target) ||
        (outcome === 'unsent' && !sameExecution(target, saved.step))
      ) {
        kept.status = target.status;
        kept.review_id = target.review_id ?? null;
        return false;
      }
      for (const [key, value] of changed) {
        if (value === undefined) delete target[key];
        else target[key] = value;
      }
      delete target.executing_at;
      if (outcome === 'applied') delete target.error;
      if (livePlanStates.includes(plan.state)) {
        if (outcome === 'applied') plan.state = uploadsState(plan, target);
        else if (held.state !== saved.state) plan.state = held.state;
      }
      return true;
    });
    if (done) return this.owned(actor, held.id);
    audit(this.store, actor, 'campaign_step_outcome_kept', {
      id: held.id,
      step_id: stepId,
      review_id: saved.step.review_id ?? null,
      outcome,
      ended_as: step.status,
      kept_as: kept.status ?? null,
      kept_review_id: kept.review_id ?? null,
    });
    return this.owned(actor, held.id);
  }
  /**
   * The idempotency claim of a submitted step, if its review ever reached execution: the one way the runner reads whether a step's review was sent
   * (r25-field3-errors, the third re-review N1-c). A write group is judged by its parts as well as by its own key (`reviewClaim`), so every path of
   * the runner that decides "nothing was sent" (stopped, recover_step, continue_as_new, a refusal of a changed state or of a duplicate) sees a group
   * a part of which was sent as sent. A source scan (tests/campaign-group-claim-readers.test.mjs) fails if this file reads a claim any other way.
   */
  private claim(actor: Actor, reviewId: unknown): JsonObject | undefined {
    return typeof reviewId === 'string' ? reviewClaim(this.store, actor.tenantId, reviewId) : undefined;
  }
  /**
   * A write group a step holds that stopped part-way and that its plan can finish (r25-field3-errors, the third re-review P4): every part that was sent applied
   * and some were not sent (a refusal before they were claimed: a pause, a limit, a changed state), and the group's own key is free or was claimed uncertain by the
   * stop. open: its review window has more than the margin left, so the plan's execute_next can still send the parts not sent; once it has ended the group is
   * executed once and no call of the plan sends them. Undefined for a step that holds no such group.
   */
  private resumableGroup(
    actor: Actor,
    step: JsonObject,
  ): {open: boolean; applied: number; unsent: number; total: number} | undefined {
    if (step.kind !== 'write' || typeof step.review_id !== 'string') return undefined;
    const progress = groupProgress(this.store, actor.tenantId, step.review_id);
    if (!progress || !groupResumable(progress)) return undefined;
    const group = optional(this.store, actor.tenantId, 'write_review_group', step.review_id),
      unsent = progress.parts.filter(part => !part.sent).length;
    return {
      open: Number(group?.expires_at) > Date.now() + groupExecuteMarginMs,
      applied: progress.parts.length - unsent,
      unsent,
      total: progress.parts.length,
    };
  }
  /**
   * The review a step goes on from, retired by this plan (r25-field3-errors, the third re-review P2 and C1): the one way the runner does it, whenever a step
   * leaves a review that was never sent: recover_step amends the step, prepare_next prepares it again while the review is open, the plan is cancelled or is
   * continued as another plan. A retired review is refused by every execute, before anything is claimed (src/write-common.ts retiredRefusal), whoever asks
   * and with the owner's policy on or off; a group is retired with its parts. A review that holds a claim is not retired (the repository's rule), and a review
   * that carries a mark keeps it (the fifth check H): `marked` says this call retired it, `already` that it was retired before, by this plan or another call, so
   * that the step has gone on from it all the same; only a review this call marked is its to open again.
   */
  private retireStepReview(
    actor: Actor,
    run: JsonObject,
    step: JsonObject,
    reason: Retirement['reason'],
  ): Retired | false {
    return (
      typeof step.review_id === 'string' &&
      retireReview(this.store, actor.tenantId, step.review_id, {plan_id: run.id, step_id: step.id, reason})
    );
  }
  /**
   * Takes a plan out of the hold a continuation put it in when the new plan could not be made (r25-field3-errors, the fifth check G): its state is restored and
   * the link to the new plan removed. The plan is read again before it is saved. Answers whether it is live again: not when the new plan exists (`successor`,
   * named when the plan under the key is this continuation's: the creation went through and something after it failed, which a repeat of continue_as_new
   * completes, so the hold, and what it retired, stay) and not when the plan could not be saved (the hold stays, and nothing it retired is opened).
   */
  private release(actor: Actor, id: string, was: unknown, successor?: string): boolean {
    if (successor && optional(this.store, actor.tenantId, 'campaign_run', successor)) return false;
    try {
      const held = this.owned(actor, id);
      if (held.superseded_by?.pending !== true) return false;
      held.state = was;
      delete held.superseded_by;
      this.save(actor, held);
      return true;
    } catch {
      return false;
    }
  }
  /**
   * A plan held for a continuation whose new plan does not exist (r25-field3-errors, the sixth check K2): the call that held it was cut short before it made the plan, or is
   * still making it. The refusal of every action on it, and get, say it (`supersededRefusal`, with `unfinishedContinuation`). Undefined for a plan that is not held, and for
   * one whose new plan exists, which is where the refusal leads.
   */
  private unfinished(actor: Actor, run: JsonObject): ReturnType<typeof unfinishedContinuation> | undefined {
    const hold = run.state === 'superseded' && run.superseded_by?.pending === true ? run.superseded_by : undefined;
    return hold && !optional(this.store, actor.tenantId, 'campaign_run', hold.to)
      ? unfinishedContinuation(run)
      : undefined;
  }
  /**
   * Whether a review a step leaves can still be executed, read from its documents and not from the step's copy of its window (r25-field3-errors, the fourth
   * check F1). A write group counts whatever its window: it ends at least 3 s per part before every part's window, and each part is a review of its own that a
   * direct execute sends for as long as its own window lasts. A single review counts while its own window lasts: an expired one is refused by every execute.
   */
  private executable(actor: Actor, reviewId: string): boolean {
    return (
      !!optional(this.store, actor.tenantId, 'write_review_group', reviewId) ||
      Number(optional(this.store, actor.tenantId, 'write_review', reviewId)?.expires_at) > Date.now()
    );
  }
  /**
   * Holds a step the guard against creating twice refused, with nothing sent: the one rule of both places a step meets the refusal, prepare_next
   * and execute_next (R2.5 M3, dupstep). The step is pending again with the refusal on it (never failed or blocked, and amended only on purpose),
   * and the plan needs a person; the call that moves it on is the earlier create's, then the plan's prepare_next (`heldDuplicate`).
   */
  private holdDuplicate(
    actor: Actor,
    run: JsonObject,
    step: JsonObject,
    error: JsonObject,
    // How the plan is saved: an execute that awaited the provider saves onto the plan as it is now (`saveSettled`).
    save: (run: JsonObject) => JsonObject = held => this.save(actor, held),
  ): {run: JsonObject; next_call: JsonObject} {
    const held = heldDuplicate(run.id, error, this.earlierHolder(actor, error));
    step.error = held.error;
    step.status = 'pending';
    // A wait for a twin that was still being sent ends here: it turned out unresolved, and the plan says what settles it.
    delete step.busy;
    run.state = 'attention';
    return {run: save(run), next_call: held.next_call};
  }
  /**
   * Records that a run showed the warning of a step's ready review, once for that review (R2.5 M3, dupstep round 2, item 7): true when this run
   * is the one that shows it, false when it was shown for this review already, or the step no longer holds that ready review. The marker is on the
   * step, in the plan document (`duplicate_warning_shown_at`, with the review it is for, `duplicate_warning_shown_for`): it is no part of the
   * plan's structure, so the approval stands, and a new review (an expired one prepared again, an amended step) has none: a stop of its own.
   */
  private showWarningOnce(actor: Actor, id: string, stepId: string, reviewId: unknown): boolean {
    const current = this.owned(actor, id),
      step = current.steps.find((s: JsonObject) => s.id === stepId);
    if (
      !step ||
      step.status !== 'review_ready' ||
      typeof reviewId !== 'string' ||
      step.review_id !== reviewId ||
      step.duplicate_warning_shown_for === reviewId
    )
      return false;
    step.duplicate_warning_shown_at = Date.now();
    step.duplicate_warning_shown_for = reviewId;
    this.save(actor, current);
    return true;
  }
  /**
   * The earlier create a refused prepare of a plan step may replace (R2.5 r25-field-plan, the lead's re-review of dupstep, R-2): the guard
   * against creating twice named an uncertain create (not one still being sent) that the actor prepared, and the latest reconciliation of it,
   * under fifteen minutes old and neither accepted nor sealed, found it not applied. The step's prepare then names it in `supersedes_review_id`,
   * so the plan step becomes the replacement: its review seals the earlier create, which is never sent, and executing it sends one create.
   * This is the standalone replacement's own rule read from the store (`WriteReconciler.replaceable`, which checks it again at prepare and
   * is the authority): nothing is asked of the provider, and nothing is tried that the rule would refuse, so a refused replacement leaves
   * no failed call behind. A colleague's create (the workspace owner may read it, and it is still not the owner's own), another or older
   * reconciliation, and a create still being sent are not named: the step stays held, as before.
   */
  private replaceableTwin(actor: Actor, error: JsonObject | undefined): string | undefined {
    const id = error?.details?.earlier_review_id;
    if (error?.code !== 'DUPLICATE_OF_UNCERTAIN_WRITE' || typeof id !== 'string' || duplicateOfExecuting(error))
      return undefined;
    const review = optional(this.store, actor.tenantId, 'write_review', id),
      reconciliation = optional(this.store, actor.tenantId, 'write_reconciliation', id);
    return review &&
      (review.user_id === actor.userId || ownsRecord(actor, review)) &&
      reconciliation?.classification === 'appears_not_applied' &&
      !reconciliation.accepted_at &&
      !supersededBy(this.store, actor.tenantId, reconciliation) &&
      Date.now() - Number(reconciliation.checked_at) <= reconciliationFreshMs
      ? id
      : undefined;
  }
  /**
   * The plan and step of the actor's that hold the earlier create a refusal of the guard names (R2.5 M3, dupstep), if it names a review the
   * actor may read and a plan the actor may read holds it: found from the store, with no provider call. Otherwise nothing.
   */
  private earlierHolder(actor: Actor, error: JsonObject): {plan_id: string; step_id: string} | undefined {
    const review = error.details?.earlier_review_id;
    return typeof review === 'string' ? planHoldingReview(this.store, actor, review) : undefined;
  }
  /** Why a failed, uncertain or mismatched step stops the plan, and the one call that can move it (Snapchat S2). */
  private stopped(actor: Actor, run: JsonObject, step: JsonObject): JsonObject {
    const claim = this.claim(actor, step.review_id);
    if (rejectedBuild(step))
      return {
        recovery:
          'Google refused build ' +
          step.id +
          ' (HTTP ' +
          step.error.details.http_status +
          '), so none of it was created: a build is applied completely or not at all. Its key is never sent again. Correct what the error names with recover_step (next_call); the build is reviewed again under a new key.',
        next_call: amendmentCall(run.id, step, step.error),
      };
    // A definitive refusal its family proves applied nothing (CMP-04): the key is retired and the step is amended.
    if (step.status === 'failed' && claim?.state === 'rejected')
      return {
        recovery:
          'The provider refused step ' +
          step.id +
          ' (' +
          refusalMark(step.error?.details) +
          ') without applying it, so nothing of it was created. Its key is never sent again. Correct what the error names with recover_step (next_call); the step is reviewed again under a new key, and verified steps are never resubmitted.',
        next_call: amendmentCall(run.id, step, step.error),
      };
    if (step.status === 'failed' && absenceConfirmed(step))
      return {
        recovery:
          'The user confirmed, from a complete read of the provider, that step ' +
          step.id +
          ' created nothing. Its key is never sent again. Correct what the error names with recover_step (next_call); the step is reviewed again under a new key.',
        next_call: amendmentCall(run.id, step, step.error),
      };
    if (step.status === 'failed' && !claim)
      return {
        recovery:
          'Step ' +
          step.id +
          ' failed before reaching the provider. Amend it with recover_step (next_call); it is prepared and reviewed again, and verified steps are never resubmitted.',
        next_call: amendmentCall(run.id, step, step.error),
      };
    if (step.status === 'mismatch') {
      const fields = [...new Set((step.verification?.checks ?? []).flatMap((c: JsonObject) => c.changed_fields ?? []))];
      return {
        recovery:
          'Step ' +
          step.id +
          ' was written, but every read shows the provider holding different values in ' +
          (fields.join(', ') || 'the fields current.verification lists') +
          '. Reading again will not change that. If the user agrees the provider’s values are acceptable, accept them (next_call, adding accept_observed: true); nothing is sent. Otherwise a correction is a new reviewed write. Steps that depend on it wait; others continue.',
        next_call: typeof step.verification?.actual_hash === 'string' ? acceptCall(run, step) : null,
      };
    }
    // A refusal after submission AMCP cannot prove applied nothing: a complete read of the provider can (CMP-04).
    if (refusedAfterSubmission(step, claim) && absenceProbe(step))
      return {
        recovery:
          'The provider refused step ' +
          step.id +
          ' (HTTP ' +
          step.error.details.http_status +
          ') after it was submitted, and AMCP cannot prove that refusal applied nothing, so its key is never sent again. confirm_absent (next_call) reads the provider for a resource of that name created since; if none exists and the user confirms it, the step can be amended and reviewed under a new key.',
        next_call: {tool: 'amcp_campaign', arguments: {action: 'confirm_absent', id: run.id, step_id: step.id}},
      };
    // A write group that stopped part-way (r25-field3-errors, the third re-review P4): every part that was sent applied, and the others were refused before they were
    // claimed. The plan finishes it while the group's window lasts (execute_next sends only those parts); after that no call of the plan does, and it says so.
    const resume = step.status === 'mismatch' ? undefined : this.resumableGroup(actor, step);
    if (resume) {
      const stopped =
        'Step ' +
        step.id +
        ' is a write group that stopped part-way: ' +
        resume.applied +
        ' of its ' +
        resume.total +
        ' parts were applied and are never sent again, and the other ' +
        resume.unsent +
        (resume.open
          ? ' were refused before they were sent, so they hold no claim.'
          : ' were never sent, but the review windows have ended.');
      return resume.open
        ? {
            recovery:
              stopped +
              ' execute_next (next_call, under the plan’s current approval and its checks) sends only those parts while the group’s review window lasts; the applied parts replay, and the group is never prepared again.',
            next_call: this.resumeCall(run, step),
          }
        : {
            recovery:
              stopped +
              ' No call of the plan sends them: a group is executed once and is not prepared again, and nothing is sent for you. Read the parts (next_call) for what was applied and what was not; the records of the parts not sent are a new change, prepared, reviewed and approved as a new request.',
            next_call: {
              tool: 'amcp_campaign',
              arguments: {action: 'get', id: run.id, step_id: step.id, topic: 'parts'},
            },
          };
    }
    // A write group is read part by part: its own reconcile is refused (each part is reconciled by its own review_id), its status lists the parts.
    const group = step.kind === 'write' && !!claim && Array.isArray(step.review?.parts);
    return {
      recovery:
        'Step ' +
        step.id +
        ' reached the provider and its outcome is not confirmed, so AMCP never sends it again.' +
        (claim?.state === 'complete'
          ? ' reconcile_step reads the resource back from its original receipt (next_call).'
          : group
            ? ' It is a write group: read each of its parts by its own review (next_call, amcp_write status of the group lists them and the call of each), reconcile the parts that need it, and check the provider before any new change. Steps already verified stay.'
            : step.kind === 'write' && claim
              ? ' No completed receipt exists: reconcile it with read-only provider lookups (next_call, WRT-08). Once the user accepts it as applied, reconcile_step reads it back and dependent steps continue. Steps already verified stay.'
              : ' No completed receipt exists: check in the provider whether the resource exists. Steps already verified stay; anything still to be written needs a new plan.'),
      next_call:
        claim?.state === 'complete'
          ? {tool: 'amcp_campaign', arguments: {action: 'reconcile_step', id: run.id, step_id: step.id}}
          : group
            ? {tool: 'amcp_write', arguments: {action: 'status', review_id: step.review_id}}
            : step.kind === 'write' && claim
              ? {tool: 'amcp_write', arguments: {action: 'reconcile', review_id: step.review_id}}
              : null,
    };
  }
  /**
   * The call that resumes the stopped group a step holds, through its plan (the third re-review P4): execute_next with the exact review and its key, the
   * acknowledgements its execute asks for added after the user approves, as prepare_next names the call for the review it prepared.
   */
  private resumeCall(run: JsonObject, step: JsonObject): JsonObject {
    const need = step.review?.execute_requirements ?? {},
      flags = Object.fromEntries(
        ['spend_change_confirmed', 'cap_override_confirmed', 'creative_edit_confirmed', 'destructive_confirmed']
          .filter(key => need[key] === true)
          .map(key => [key, true]),
      );
    return {
      tool: 'amcp_campaign',
      arguments: {
        action: 'execute_next',
        id: run.id,
        review_id: step.review_id,
        idempotency_key: step.review_id,
        confirmed: true,
      },
      ...(Object.keys(flags).length ? {add_after_user_approval: flags} : {}),
    };
  }
  /**
   * The call that settles a step left executing (r25-planmodel, F3 and F4): the call that was sending it ended before it saved the outcome (the process stopped, or its save
   * failed), so the change may be applied and nothing in the plan said so. The plan's reads name execute_next with the exact review and its key, which replays the receipt
   * recorded under that key and sends nothing a second time, and, while the review's claim is open, the read to make after it (`then`): its status while the request may still
   * be going out, its reconcile once the claim counts as uncertain (the step then reads uncertain, and the plan names that same lookup). Nothing for a step that is not
   * executing, or a plan that no longer runs.
   */
  private resumeOffer(actor: Actor, run: JsonObject, step: JsonObject | undefined): JsonObject {
    if (step?.status !== 'executing' || !livePlanStates.includes(run.state)) return {};
    const claim = this.claim(actor, step.review_id);
    // A call is executing the step now (r25-planmodel, M2, second round): it is read again, never executed a second time.
    if (executionInFlight(step, claim)) return this.inFlightOffer(run, step, claim);
    const // Its status while the request may still be going out, and a write group's always (it is read part by part: its own reconcile is refused); else its reconcile.
      readStatus =
        Array.isArray(step.review?.parts) ||
        (claim?.state === 'pending' && Date.now() - Number(claim.created_at) < pendingUncertainMs),
      then =
        claim && ['pending', 'uncertain'].includes(claim.state)
          ? {tool: 'amcp_write', arguments: {action: readStatus ? 'status' : 'reconcile', review_id: step.review_id}}
          : undefined,
      // What the call does depends on what was recorded for the review, and the sentence says it (M6): a review no call claimed is sent now.
      does = !claim
        ? 'the call that was executing it ended before it claimed the review, so nothing was sent. This executes the review now, as the plan’s approval allows: it sends the change, once, and reads it back.'
        : claim.state === 'complete'
          ? 'the call that was sending it ended before it saved the outcome. This replays the receipt recorded under the review’s key, settles the step and never sends the change a second time.'
          : claim.state === 'rejected'
            ? 'the provider refused the request without applying it, and the call that ended did not save that. This sends nothing: it records the refusal on the step, which is then amended (recover_step).'
            : 'the call that was sending it ended before it saved the outcome, and the request may have reached the provider. This sends nothing: the review’s claim is open, so the step reads uncertain, and the plan then names the read-only lookups that settle it.';
    return {
      next_call: {
        ...this.resumeCall(run, step),
        meaning: 'Step ' + step.id + ' is executing, and ' + does,
        ...(then ? {then} : {}),
      },
    };
  }
  /**
   * What the plan's reads say of a step a call is executing now (`executionInFlight`, r25-planmodel, M2, second round): nothing to execute. While the request may still be going
   * out, the review's status, with its own sentence; otherwise the step in its plan, until the call has ended or its lease has run out, which the read then names. `retry_read_after_ms`
   * is when to read again.
   */
  private inFlightOffer(run: JsonObject, step: JsonObject, claim: JsonObject | undefined): JsonObject {
    const sending = claim?.state === 'pending',
      left = typeof step.executing_at === 'number' ? step.executing_at + executingLeaseMs - Date.now() : 0;
    return {
      next_call: sending
        ? {
            tool: 'amcp_write',
            arguments: {action: 'status', review_id: step.review_id},
            meaning:
              'Step ' +
              step.id +
              ' is executing: its request is being sent now. Read this status again in a moment; never execute it twice.',
          }
        : {
            tool: 'amcp_campaign',
            arguments: {action: 'get', id: run.id, step_id: step.id},
            meaning:
              'Step ' +
              step.id +
              ' is being executed by a call of this plan that has not ended (it began less than two minutes ago). Read the step again in a moment; never execute it twice. If that call ended without saving its outcome, this read names the call that settles it once the two minutes have run out.',
          },
      retry_read_after_ms: sending ? 5000 : Math.min(5000, Math.max(1000, left)),
    };
  }
  /** What comes after a step's read-back: the next step, another read that can still help, or the user's decision. */
  private followUp(actor: Actor, run: JsonObject, step: JsonObject): JsonObject {
    if (step.status === 'mismatch') return {blocked: true, ...this.stopped(actor, run, step)};
    if (step.status === 'verifying' && step.verification && !step.verification.next_call)
      return typeof step.verification.actual_hash === 'string'
        ? {
            next_call: acceptCall(run, step),
            decision:
              'Reading again cannot settle step ' +
              step.id +
              ' (current.verification). Accept the observed state if the user agrees, or correct it with a new reviewed write.',
          }
        : {next_call: null};
    return {
      next_call:
        run.state === 'complete' ? null : {tool: 'amcp_campaign', arguments: {action: 'prepare_next', id: run.id}},
      ...activationOffer(run),
      ...(step.status === 'verifying' && step.verification?.retry_read_after_ms
        ? {retry_read_after_ms: step.verification.retry_read_after_ms}
        : {}),
    };
  }
  /**
   * One approval for a whole plan (the owner's item 5, 2026-09-29: a 19-step build needed 19 separate approvals).
   * Without confirmation, approve returns what the user approves: every step's action, account and the budget,
   * bid and status fields it sets, every one counted (WRT-05): a large step is aggregated, with the call that lists all
   * of its fields. With confirmed: true, that summary's plan_hash and its summary_hash, the approval is recorded and
   * audited. It covers this plan_hash only: amending a step changes the hash and voids it. It lasts a day.
   *
   * The summary names each write step's spend effect (R2.5 r25-field-plan: `spendEffectsOf`), and spend_change_confirmed given with the
   * approval covers exactly the steps it names (`approval.spend_steps`): `run` passes the flag to those and to no other step.
   *
   * Showing is one half of this action and recording the other (R2.5 field3, AMCP-07): the shown half is `approvalPreview`, which
   * `approval_summary` answers as a read, so that a client can show a person what they approve without calling an action that records.
   */
  private approve(input: JsonObject, actor: Actor, run: JsonObject): JsonObject {
    const {summary, spending, checker} = this.approvalFacts(actor, run);
    if (input.confirmed !== true) return this.approvalPreview(input, run, summary, spending, checker);
    const distinct = distinctApproverCall(run);
    if (input.plan_hash !== run.plan_hash)
      bad(
        'plan_hash does not match: the plan changed since that summary. Show the user the current summary (approval_summary).',
        'PLAN_CHANGED',
        {field: 'plan_hash', plan_hash: run.plan_hash},
      );
    if (summaryHashRequired() && input.summary_hash !== summary.summary_hash)
      bad(
        input.summary_hash === undefined
          ? 'summary_hash is required: approve with the summary_hash of the summary the user was shown (approval_summary returns it).'
          : 'summary_hash does not match the current summary. Show the user the current summary (approval_summary) and approve that.',
        'PLAN_CHANGED',
        {field: 'summary_hash', plan_hash: run.plan_hash, summary_hash: summary.summary_hash},
      );
    if (checker)
      bad(
        'This workspace requires someone other than the plan’s owner to approve a plan that changes spending or activates a launch. Assign an approver; they approve and run it.',
        'DISTINCT_APPROVER_REQUIRED',
        {policy: 'require_distinct_approver', next_call: distinct},
      );
    // What the approval shows as spending (`summary.spend_steps`: absent where this runner names no spend effect) and what it covers: those
    // steps when the person gave spend_change_confirmed, none otherwise. `spend_effect_steps` keeps what was shown even without the flag,
    // so that `run` can offer the one re-approval for those steps instead of a stop for each (r25-field-plan).
    const given = input.spend_change_confirmed === true,
      shown: string[] | undefined = Array.isArray(summary.spend_steps) ? summary.spend_steps : undefined,
      covered = shown ? (given ? shown : []) : undefined;
    run.approval = {
      plan_hash: run.plan_hash,
      summary_hash: summary.summary_hash,
      by: actor.userId,
      principal: principalOf(actor),
      at: Date.now(),
      spend_change_confirmed: given,
      ...(shown ? {spend_steps: covered, spend_effect_steps: shown} : {}),
    };
    audit(this.store, actor, 'campaign_plan_approved', {
      id: run.id,
      plan_hash: run.plan_hash,
      summary_hash: summary.summary_hash,
      steps: run.steps.length,
      fields_total: summary.fields_total,
      truncated_steps: summary.steps.filter((s: JsonObject) => s.truncated).length,
      spend_change_confirmed: given,
      ...(covered ? {spend_steps: covered} : {}),
      // Who approved whose plan (CMP-05): the audit's actor is the approving credential.
      approver: principalOf(actor),
      plan_owner: run.principal ?? run.user_id ?? null,
    });
    run = this.save(actor, run);
    return compactPlan(run, undefined, {
      approved: {
        by: actor.userId,
        spend_change_confirmed: run.approval.spend_change_confirmed,
        ...(covered ? {spend_steps: covered} : {}),
      },
      next_call: {tool: 'amcp_campaign', arguments: {action: 'run', id: run.id}},
    });
  }
  /**
   * What an approval of this plan shows, as a function of the plan alone (a local compile, nothing read or sent): the summary, whether it offers
   * spend_change_confirmed, and whether the owner's distinct-approver policy makes the actor's own approval one that must go to someone else.
   */
  private approvalFacts(actor: Actor, run: JsonObject) {
    const summary = approvalSummary(run, this.spendEffectsOf(run));
    return {
      summary,
      spending: approvalSpends(summary),
      // Maker-checker (CMP-05, owner policy, off by default): a plan that changes spending or activates a launch is
      // approved by someone other than its owner. It reads the money fields, as it always has: the spend effects widen what the
      // approval offers, not who may give it.
      checker: this.needsDistinctApprover(actor, run, approvalMoney(summary)) && ownsRecord(actor, run),
    };
  }
  /**
   * What approve answers without `confirmed`, and approval_summary answers as a read (R2.5 field3, AMCP-07): the plan's summary and the call that
   * records its approval, or one step's fields, or (to the owner of a plan the distinct-approver policy governs) the notice that someone else
   * approves it. It changes nothing: the one function of the plan both actions show, so that the `summary_hash` a client was shown is the one
   * `approve` with `confirmed` checks, whichever of the two showed it.
   */
  private approvalPreview(
    input: JsonObject,
    run: JsonObject,
    summary: JsonObject,
    spending: boolean,
    checker: boolean,
  ): JsonObject {
    if (typeof input.step_id === 'string') {
      const fields = approvalStep(run, input.step_id);
      if (!fields) bad('Name a step of this plan.', 'INVALID_ARGUMENT', {field: 'step_id'});
      return {id: run.id, plan_hash: run.plan_hash, summary_hash: summary.summary_hash, ...fields};
    }
    if (checker)
      return compactPlan(run, undefined, {
        approval: summary,
        summary_hash: summary.summary_hash,
        approver_required: true,
        notice:
          'This workspace requires someone other than the plan’s owner to approve a plan that changes spending or activates a launch. Assign an approver; they approve and run it.',
        next_call: distinctApproverCall(run),
      });
    return compactPlan(run, undefined, {
      approval: summary,
      summary_hash: summary.summary_hash,
      next_call: {
        tool: 'amcp_campaign',
        arguments: {
          action: 'approve',
          id: run.id,
          plan_hash: run.plan_hash,
          summary_hash: summary.summary_hash,
          confirmed: true,
        },
        ...(spending ? {add_after_user_approval: {spend_change_confirmed: true}} : {}),
        ...(summary.effects ? {disclose: summary.effects} : {}),
      },
    });
  }
  /**
   * approval_summary (R2.5 field3, AMCP-07; the owner's second Google report of 2026-11-21): what approve answers without `confirmed`, as a read,
   * under the plan's `view` right. Showing a person what they are about to approve needed approve, whose contract hints are destructive because
   * it records the approval, saves a plan, runs a live preflight and may re-read the provider, so an automated permission check blocked the
   * summary and the person approved before seeing it. This action is the summary alone: it reads the plan and the preflight the plan already
   * holds, runs the local checks of a draft, compiles the spend effects locally, and saves, audits and sends nothing. A plan with no preflight
   * says so (`preflight.status: not_run`; approve runs it first and refuses on a block); a plan whose stored preflight blocked a step answers the
   * blocked view that approve answers. It refuses `confirmed`, `plan_hash`, `summary_hash` and `spend_change_confirmed`, so it can never record
   * anything: the approval is still approve with `confirmed` and the hashes of the summary the person was shown.
   */
  private approvalSummaryRead({input, actor}: CampaignCall): JsonObject {
    for (const field of ['confirmed', 'plan_hash', 'summary_hash', 'spend_change_confirmed'])
      if (input[field] !== undefined)
        bad(
          'approval_summary only shows what an approval covers and records nothing. To approve, call approve with confirmed: true and the plan_hash and summary_hash it returns.',
          'INVALID_ARGUMENT',
          {
            field,
            next_call: {
              tool: 'amcp_campaign',
              arguments: {action: 'approval_summary', ...(typeof input.id === 'string' ? {id: input.id} : {})},
            },
          },
        );
    const run = this.owned(actor, input.id);
    // A plan that was archived, superseded or cancelled has no approval to show, as approve refuses it.
    if (run.archived) refusePlanArchived(run);
    if (run.state === 'superseded') refusePlanSuperseded(run, this.unfinished(actor, run));
    if (run.state === 'cancelled') refusePlanCancelled();
    assertNewSearchExclusionDraft(this.store, actor, run);
    assertRecipeDraftCurrent(run);
    // The blocked view of this read is always the compact one (lead review S3-1): `detail` is no argument of this action, and a response budget never
    // cuts it into pieces, so it must never be the whole plan record that `detail: "full"` asks the blocked view of approve for.
    if (run.preflight?.status === 'blocked') return this.blockedView({action: input.action}, run);
    const {summary, spending, checker} = this.approvalFacts(actor, run),
      shown = this.approvalPreview(input, run, summary, spending, checker);
    // approve runs the preflight when the plan holds none (its provider reads are why it is not a read); this action never does, and says so.
    return !run.preflight && (this.preflight || run.activation_of) && typeof input.step_id !== 'string'
      ? {
          ...shown,
          preflight: {
            status: 'not_run',
            note: 'approve runs the prerequisite check first, and records no approval if it blocks a step.',
          },
        }
      : shown;
  }
  /**
   * What the local compile says of each write step's spend effect, for the approval summary (R2.5 r25-field-plan); undefined where this
   * runner has no compile. A compile that fails altogether names no step, and a write step the summary finds unnamed counts as spending.
   * So does an answer that is not a Map (lead review S3-3): the compile is the constructor's last slot, and a callback a merge leaves
   * there answers undefined or anything. That is a compile that failed, never "no compile", which would be the old blanket again: a flag
   * that covers every step whatever the approval showed.
   */
  private spendEffectsOf(run: JsonObject): ReadonlyMap<string, StepEffectEntry> | undefined {
    if (!this.spendEffects) return undefined;
    try {
      const effects: unknown = this.spendEffects(run.steps);
      return effects instanceof Map ? effects : new Map();
    } catch {
      return new Map();
    }
  }
  /**
   * Whether the owner's distinct-approver policy (CMP-05, off by default) governs this plan: it is on, and the plan
   * changes spending or activates a launch. A plan changes spending here by its money fields (`approvalMoney`), as the policy has always
   * read it, never by the spend effects the approval now names (`approvalSpends`, which only decides whether the approval offers the flag):
   * widening the policy to them would change who may approve a plan, which is the owner's to decide (lead review of r25-field-plan, S4-1).
   */
  private needsDistinctApprover(actor: Actor, run: JsonObject, spending?: boolean): boolean {
    if (planPolicy(this.store, actor.tenantId).require_distinct_approver !== true) return false;
    return !!run.activation_of || (spending ?? approvalMoney(approvalSummary(run)));
  }
  /**
   * Under the distinct-approver policy a governed plan's steps execute only under a current approval of its exact plan
   * recorded by someone other than its owner, so executing step by step cannot skip the second person (CMP-05). Checked
   * before anything is sent; the review stays valid.
   */
  private assertDistinctApproval(actor: Actor, run: JsonObject): void {
    if (!this.needsDistinctApprover(actor, run)) return;
    const owner = typeof run.principal === 'string' && run.principal ? run.principal : run.user_id,
      approval = run.approval;
    if (
      approval &&
      approval.plan_hash === run.plan_hash &&
      Date.now() - approval.at <= 86400000 &&
      typeof approval.principal === 'string' &&
      approval.principal !== owner
    )
      return;
    bad(
      'This workspace requires someone other than the plan’s owner to approve a plan that changes spending or activates a launch before its steps are executed. Assign an approver; they approve and run it.',
      'DISTINCT_APPROVER_REQUIRED',
      {policy: 'require_distinct_approver', next_call: distinctApproverCall(run)},
    );
  }
  /** Marks a call `run` makes under the plan's approval, so the approver who runs it may make it (CMP-05). */
  private approved(input: JsonObject): JsonObject {
    this.underApproval.add(input);
    return input;
  }
  /**
   * Queues an approved plan of media uploads to run on the server (MED-03 B): the worker runs it exactly as `run` does,
   * under the same approval and as the same person, so leaving the website or client no longer stops it; `get` shows
   * its progress and `background`. A run already queued or running is returned, never queued twice.
   */
  private runInBackground(input: JsonObject, actor: Actor, run: JsonObject): JsonObject {
    if (!serverPushEnabled())
      bad(
        'Background runs are turned off in this deployment. Run the plan with run, which continues while you keep this page or client open.',
        'BACKGROUND_RUN_DISABLED',
        {next_call: {tool: 'amcp_campaign', arguments: {action: 'run', id: run.id}}},
      );
    if (!run.steps.every((s: JsonObject) => s.kind === 'media'))
      bad(
        'run_background runs plans whose steps are all media uploads. Run this plan with run.',
        'BACKGROUND_RUN_UNSUPPORTED',
        {next_call: {tool: 'amcp_campaign', arguments: {action: 'run', id: run.id}}},
      );
    this.assertApproval(actor, run);
    const get = {tool: 'amcp_campaign', arguments: {action: 'get', id: run.id}};
    if (run.steps.every(settled)) return this.respond(input, {...run, state: 'complete'}, undefined, {next_call: null});
    // Checked and queued in one transaction (SQLite admits one writer at a time, across processes too): two concurrent
    // calls (two tabs, or the website and an MCP client) cannot both find no active run and queue two jobs.
    const queued = this.store.transaction(() => {
      const current = this.owned(actor, run.id),
        active = this.store.db
          .prepare(
            "SELECT id FROM jobs WHERE tenant_id=? AND kind=? AND state IN ('queued','running') AND json_extract(input,'$.plan_id')=? LIMIT 1",
          )
          .get(actor.tenantId, BACKGROUND_RUN_KIND, run.id) as {id?: string} | undefined;
      if (active?.id) return {run: current, queued: false};
      const job = enqueueBackgroundRun(this.store, actor, run.id);
      current.background = {job_id: job, queued_at: Date.now(), by: actor.userId};
      const saved = this.save(actor, current);
      audit(this.store, actor, 'campaign_plan_background_queued', {
        id: saved.id,
        plan_hash: saved.plan_hash,
        job_id: job,
      });
      return {run: saved, queued: true};
    });
    return this.respond(input, queued.run, undefined, {
      background: backgroundRunView(this.store, actor.tenantId, queued.run),
      next_call: get,
    });
  }
  /** The plan's current approval, recorded from this person's connection (or an administrator's), within a day. */
  private assertApproval(actor: Actor, run: JsonObject) {
    if (!run.approval || run.approval.plan_hash !== run.plan_hash || Date.now() - run.approval.at > 86400000)
      bad(
        'This plan has no current approval. Show the user the summary (approval_summary), then approve it with confirmed: true.',
        'APPROVAL_REQUIRED',
        {next_call: summaryCall(run.id)},
      );
    // The plan follows its person across their connections (MCP-02); an approval, like a review, stays with the
    // connection that recorded it. The administrator exemption is unchanged.
    if (run.approval.by !== actor.userId && actor.role !== 'admin')
      bad(
        'This plan was approved from another connection. Show the user the summary here (approval_summary), then approve it with confirmed: true.',
        'APPROVAL_REQUIRED',
        {next_call: summaryCall(run.id)},
      );
  }
  /**
   * Runs an approved plan: each step is prepared (a frozen review of the state it reads) and executed under the
   * plan's approval, then read back, exactly as prepare_next and execute_next do one at a time. It stops for anything
   * that needs a person: a spending acknowledgement the approval did not give, an owner cap override, a creative
   * edit, a failure, a mismatch, or a read-back still settling. It also stops after about 25 seconds so a response
   * always arrives; run again to continue. Nothing is rolled back: steps already done stay, as created (paused).
   *
   * R2.5 field3 (AMCP-12; the owner's second Google report of 2026-11-21: two runs answered `stopped: "time"` after 41 and 58 seconds, and
   * neither said how much was left):
   * - every stop carries `run.progress` (`runProgress`): the steps settled and left, how long this call has run and, once a settled step has a
   *   recorded time, an estimate labelled as one;
   * - the budget is checked before each step, against the median of what the plan's steps took, so a step that would end past it is not started
   *   (`elapsed + median > 25 s`). It is checked there and nowhere else: a step this call started is finished, so a stop never lands between a
   *   review and its execution and nothing is left executing or claimed, and the next run resumes with the same review. A call always tries
   *   its first step, so a plan whose steps are each longer than the budget still moves one step per call;
   * - a client that sent a progress token is told as each step settles (`tell`).
   */
  private async runApproved(input: JsonObject, actor: Actor, run: JsonObject): Promise<JsonObject> {
    this.assertApproval(actor, run);
    const started = Date.now(),
      executed: string[] = [];
    const progress = (): JsonObject => {
      try {
        return {progress: runProgress(this.owned(actor, run.id), executed.length, Date.now() - started)};
      } catch {
        // A stop is never lost for want of its progress: it is an addition to what a run always answered.
        return {};
      }
    };
    const stop = (view: JsonObject, reason: string, extra: JsonObject = {}) => ({
      ...view,
      run: {executed, stopped: reason, ...extra, ...progress()},
    });
    // The client of a call that sent a progress token hears of each step as it settles; a call without one runs in no scope, and this reads nothing.
    const listening = runProgressWanted(),
      tell = (message: (done: number, total: number) => string) => {
        if (!listening) return;
        try {
          const steps: JsonObject[] = this.owned(actor, run.id).steps,
            done = steps.filter(settled).length;
          reportRunProgress({progress: done, total: steps.length, message: message(done, steps.length)});
        } catch {
          // A courtesy to the client: whatever happens to it never reaches the plan.
        }
      };
    tell((done, total) => done + ' of ' + total + ' steps settled');
    // In a plan of independent uploads (a creative push) one failed, uncertain or processing upload holds none of the
    // others: run moves every upload it can, then stops for the rest (MED-03 B). Other plans stop at the first one.
    const uploads = independentUploads(run);
    // R25 M1 (L5-04): the last execute of this call that a refusal of the state check sent back to pending. In a push of
    // independent uploads the other uploads move first, and the run stops with it once nothing else can.
    let refusedHere: JsonObject | undefined;
    for (let i = 0; i < run.steps.length * 3 + 3; i++) {
      const current = this.owned(actor, run.id),
        elapsed = Date.now() - started,
        // AMCP-12: a step is not started when the plan's own steps say it would end past the budget. Only after this call ran a step (it always
        // tries its first), and only here, between steps.
        median = executed.length ? medianOf(stepTimes(current)) : undefined;
      if (elapsed > runBudgetMs || (median !== undefined && elapsed + median > runBudgetMs))
        return stop(this.respond({}, current), 'time', {
          next_call: {tool: 'amcp_campaign', arguments: {action: 'run', id: run.id}},
        });
      // The steps a refusal of the state check sent back to pending, in this call or in an earlier one.
      const held = new Map<string, JsonObject>(
        current.steps.filter(heldByStateCheck).map((s: JsonObject) => [s.id, s.error] as [string, JsonObject]),
      );
      // The approval as it stands now, not as this call found it (lead review of r25-field-plan, S4-3): an approval re-recorded without the
      // flag, or one the plan has outgrown, during a call of up to 25 seconds is seen before the next step, which the copy read at the start of
      // the call would not show. Nothing changes for a plan whose approval stands: the first pass reads what assertApproval just read.
      this.assertApproval(actor, current);
      if (uploads && refusedHere && held.size && !nextUpload(current))
        return stop(refusedHere, 'state_changed', {
          reason: stateChangedReason([...held.keys()][0], false),
          next_call: {tool: 'amcp_campaign', arguments: {action: 'prepare_next', id: run.id}},
        });
      const ask: JsonObject = this.approved({action: 'prepare_next', id: run.id});
      if (uploads) this.pastStopped.add(ask);
      // A step whose read-back the provider had not caught up with ends `verifying`, and prepare_next reads it again before anything else and answers with that step alone
      // (r25-planmodel, finding 4 of the live checks of 2026-11-25): the run goes on when it has settled.
      const reading = current.steps.find((s: JsonObject) => !settled(s));
      const prepared = await this.handle(ask, actor);
      // A step a crash or restart left executing resumes under its original review and key (CMP-02 c). The same-key
      // claim replays a completed receipt and refuses a pending or uncertain one without sending it again.
      // A stopped write group is not that (the third re-review P4): its step is blocked, and the execute_next its stop names is the person's call to make, so run
      // stops at it as at any step that needs a person.
      const resume =
        !prepared.review && !prepared.blocked && prepared.next_call?.arguments?.action === 'execute_next'
          ? prepared.next_call.arguments
          : undefined;
      // Busy media capacity refused the next upload's prepare before anything was staged or sent: run again later.
      if (prepared.busy === true)
        return stop(prepared, 'not_sent', {
          retry_after_ms: prepared.retry_after_ms,
          next_call: {tool: 'amcp_campaign', arguments: {action: 'run', id: run.id}},
        });
      if (!prepared.review && !resume) {
        const view = prepared.view ? prepared : this.respond({}, this.owned(actor, run.id));
        if (view.state === 'complete') return stop(view, 'complete');
        // R2.5 M3 (dupstep): a step the guard against creating twice held at prepare. Nothing was prepared or sent; the earlier create is
        // settled first. The stop and its reason are those of the same refusal at execute (below), so one outcome tells an agent what to do.
        if (
          view.current?.status === 'pending' &&
          view.current.error?.code === 'DUPLICATE_OF_UNCERTAIN_WRITE' &&
          typeof view.current.step_id === 'string'
        )
          return stop(view, 'needs_attention', {
            reason: duplicateReason(
              view.current.step_id,
              'DUPLICATE_OF_UNCERTAIN_WRITE',
              false,
              true,
              view.current.error,
            ),
            next_call: view.next_call ?? {tool: 'amcp_campaign', arguments: {action: 'prepare_next', id: run.id}},
          });
        // An upload whose preparation failed (its file expired, for example) holds none of the other uploads; a plan
        // its preflight blocked still stops as a whole.
        if (uploads && view.blocked && view.current?.status === 'failed' && nextUpload(this.owned(actor, run.id)))
          continue;
        if (view.blocked) return stop(view, 'needs_attention');
        // The read-back settled: nothing is waited for, and the next step is prepared by the next pass (the budget is checked before it). A read-back still settling stops the
        // run, which names run again, never prepare_next: that would send an agent through the plan one step at a time, each needing the person; a media upload still
        // processing keeps the status call its own stop names. Only the call that prepares the next step is run's to replace (r25-planmodel, M3, second round): a read-back that
        // reading again cannot settle names the decision of the person (accept what was observed, or correct it), and one that nothing can settle names no call, and run
        // naming itself over either sent an agent round in circles, call after call, with the person's answer out of its sight.
        if (
          reading?.status === 'verifying' &&
          this.owned(actor, run.id).steps.find((s: JsonObject) => s.id === reading.id)?.status !== 'verifying'
        )
          continue;
        const again = {tool: 'amcp_campaign', arguments: {action: 'run', id: run.id}},
          named = view.next_call,
          next_call = named === undefined || named?.arguments?.action === 'prepare_next' ? again : named;
        return stop(
          prepared.blocked_by ? view : {...view, next_call},
          'waiting',
          prepared.blocked_by ? {} : {next_call},
        );
      }
      // Lead review S2-1: a step that a refusal of the state check sent back to pending, in an earlier call, is prepared
      // again here over the state as it is now, and the run STOPS with the new review: the plan's approval is of the plan, not
      // of a state that moved, so the new review is shown before anything is sent. Only an explicit call sends it
      // (execute_next with this review); no flag skips the check, and nothing here retries it.
      if (prepared.review && typeof prepared.step_id === 'string' && held.has(prepared.step_id)) {
        // The same stop for a step the guard against creating twice sent back (R2.5 M2, N7): the new review carries the warning. It
        // stops as `needs_attention`, which the website already words: a stop reason of its own would need wording and Arabic there.
        const refusal = held.get(prepared.step_id)!;
        if (!refusedByDuplicateGuard(refusal))
          return stop(prepared, 'state_changed', {
            reason: stateChangedReason(prepared.step_id, true),
            next_call: prepared.next_call,
          });
        // This stop shows the new review: when it carries the warning, it is the stop on it (item 7), and a run called again proceeds.
        if (prepared.review.duplicate_warning)
          this.showWarningOnce(actor, run.id, prepared.step_id, prepared.review.review_id);
        return stop(prepared, 'needs_attention', {
          reason: duplicateReason(prepared.step_id, refusal.code, true, !!prepared.review.duplicate_warning),
          next_call: prepared.next_call,
        });
      }
      // R2.5 M3, dupstep round 2, item 7: a ready review that carries the warning of an identical create that completed in the last ten minutes is
      // shown once before any run sends it (the stop on a held step prepared again, above, is the same stop). Nothing is sent here; the stop is
      // recorded on the step for that review, so a run called again proceeds, as it did, and a new review has a stop of its own.
      if (
        prepared.review?.duplicate_warning &&
        typeof prepared.step_id === 'string' &&
        this.showWarningOnce(actor, run.id, prepared.step_id, prepared.review.review_id)
      )
        return stop(prepared, 'needs_attention', {
          reason: warnedReviewReason(prepared.step_id),
          next_call: prepared.next_call,
        });
      // A review still ready from an earlier call carries its requirements inside the review view.
      const needs = prepared.execute_requirements ?? prepared.review?.execute_requirements ?? {};
      const human = needs.cap_override_confirmed
        ? 'cap_override_confirmed'
        : needs.creative_edit_confirmed
          ? 'creative_edit_confirmed'
          : // WRT-09: the owner's destructive_confirmed tier is never given by a plan approval.
            needs.destructive_confirmed
            ? 'destructive_confirmed'
            : // R2.5 r25-field-plan: the approval's spend_change_confirmed covers the steps it showed as spending, and no other.
              needs.spend_change_confirmed && !approvalCoversSpend(current.approval, prepared.step_id)
              ? 'spend_change_confirmed'
              : undefined;
      if (human) {
        const spend = human === 'spend_change_confirmed' ? spendStop(current, prepared) : undefined;
        return stop(spend?.view ?? prepared, 'needs_' + human, {
          reason:
            spend?.reason ??
            'Step ' +
              prepared.step_id +
              ' needs ' +
              human +
              ', which the plan approval does not give. Show the user this review; execute_next with it continues the step, then run continues the plan.',
          ...(spend?.extra ?? {}),
        });
      }
      const execute: JsonObject = this.approved({
        action: 'execute_next',
        id: run.id,
        review_id: resume?.review_id ?? prepared.review.review_id,
        idempotency_key: resume?.idempotency_key ?? prepared.review.idempotency_key,
        confirmed: true,
        ...(needs.spend_change_confirmed ? {spend_change_confirmed: true} : {}),
      });
      if (uploads) this.pastStopped.add(execute);
      const out = await this.handle(execute, actor);
      const step = out.steps?.find((s: JsonObject) => s.id === prepared.step_id);
      // Another call is executing the step (the resume was refused, and changed nothing): this call did not run it. It waits, and run is called again later (M2, second round).
      if (step?.status === 'executing') {
        const again = {tool: 'amcp_campaign', arguments: {action: 'run', id: run.id}};
        return stop({...out, next_call: again}, 'waiting', {
          next_call: again,
          ...(out.retry_read_after_ms ? {retry_after_ms: out.retry_read_after_ms} : {}),
        });
      }
      executed.push(prepared.step_id);
      tell((done, total) => 'step ' + done + ' of ' + total + ' verified');
      if (out.state === 'complete') return stop(out, 'complete');
      if (step && ['failed', 'uncertain', 'mismatch'].includes(step.status) && !uploads)
        return stop(out, 'needs_attention');
      // R25 M1 (L5-04): a step refused for a changed provider state went back to pending, unsent. The plan's approval is of
      // the plan, not of a state that moved after the review, so run never prepares and executes that step again in this
      // call. A plan stops at once. A push of independent uploads moves the other uploads first (lead review S3-1): it
      // stops with this one when nothing else can move, and the agent and the user decide.
      const refusal = typeof step?.error === 'string' ? step.error : step?.error?.code;
      if (step?.status === 'pending' && refusal === 'STATE_CHANGED') {
        if (uploads) {
          refusedHere = out;
          continue;
        }
        return stop(out, 'state_changed', {
          reason: stateChangedReason(prepared.step_id, false),
          next_call: {tool: 'amcp_campaign', arguments: {action: 'prepare_next', id: run.id}},
        });
      }
      // R2.5 M2 (lead re-review N7): a step the guard against creating twice sent back to pending, unsent. The run never prepares and
      // executes it again on its own: the person is shown the new review, with its warning, before a second object is made. The stop
      // is `needs_attention` (the website's wording of it stands); its reason names the refusal and what to do.
      if (
        step?.status === 'pending' &&
        ['DUPLICATE_OF_COMPLETED_WRITE', 'DUPLICATE_OF_UNCERTAIN_WRITE'].includes(refusal)
      )
        return stop(out, 'needs_attention', {
          reason: duplicateReason(
            prepared.step_id,
            refusal,
            false,
            true,
            out.current?.step_id === prepared.step_id ? out.current.error : undefined,
          ),
          // The step's own next call: the earlier create's for an uncertain twin, with prepare_next after it (F3).
          next_call: out.next_call ?? {tool: 'amcp_campaign', arguments: {action: 'prepare_next', id: run.id}},
        });
      // WRT-09: refused before anything was sent for a person's decision the plan approval cannot give: a member's
      // approval of this step on the website (website_path), the owner's beyond a cap, or the destructive acknowledgement.
      // The review stays ready; run continues once the person has acted. A compact row names only the error code.
      const waiting =
        step?.status === 'review_ready'
          ? personDecisions[typeof step.error === 'string' ? step.error : step.error?.code]
          : undefined;
      if (waiting) {
        const refusal: JsonObject =
          this.owned(actor, run.id).steps.find((s: JsonObject) => s.id === prepared.step_id)?.error ?? {};
        return stop(out, waiting, {
          reason:
            'Step ' +
            prepared.step_id +
            ' waits for a person: ' +
            String(refusal.message ?? '') +
            ' Nothing was sent; the review stays ready until it expires.',
          ...(typeof refusal.details?.website_path === 'string' ? {website_path: refusal.details.website_path} : {}),
          next_call:
            waiting === 'needs_destructive_confirmed'
              ? {
                  tool: 'amcp_campaign',
                  arguments: {
                    action: 'execute_next',
                    id: run.id,
                    review_id: execute.review_id,
                    idempotency_key: execute.idempotency_key,
                    confirmed: true,
                  },
                  add_after_user_approval: {
                    destructive_confirmed: true,
                    ...(needs.spend_change_confirmed ? {spend_change_confirmed: true} : {}),
                  },
                }
              : {tool: 'amcp_campaign', arguments: {action: 'run', id: run.id}},
        });
      }
      // Refused before anything was sent (a pause, a rate limit, a busy target): the review stays ready, and run continues
      // it once the cause clears instead of retrying it at once.
      if (step?.status === 'review_ready' && step.error)
        return stop(out, 'not_sent', {
          next_call: {tool: 'amcp_campaign', arguments: {action: 'run', id: run.id}},
        });
    }
    return stop(this.respond({}, this.owned(actor, run.id)), 'limit', {
      next_call: {tool: 'amcp_campaign', arguments: {action: 'run', id: run.id}},
    });
  }
  /** A plan response: compact unless the caller asks for detail "full" (the stored plan, as before). `full` holds
   * fields only the full form carries; `extra` fields go in both. */
  private respond(input: JsonObject, run: JsonObject, current?: string, extra: JsonObject = {}, full: JsonObject = {}) {
    return input.detail === 'full' ? {...run, ...extra, ...full} : compactPlan(run, current, extra);
  }
  /** The step a call names, or the refusal listing the plan's steps. */
  private namedStep(run: JsonObject, stepId: unknown): JsonObject {
    const ids = run.steps.map((x: JsonObject) => x.id),
      step = run.steps.find((x: JsonObject) => x.id === stepId);
    if (!step)
      bad(
        'step_id ' + JSON.stringify(String(stepId ?? '')) + ' is not in this plan. Its steps: ' + ids.join(', ') + '.',
        'INVALID_ARGUMENT',
        {field: 'step_id', allowed: ids},
      );
    return step;
  }
  /**
   * confirm_absent (CMP-04): for a step the provider refused after submission whose family proves nothing, a complete
   * read-only list of its parent's children shows whether a resource of its name was created since its claim. Without
   * confirmed it reports the probe; with confirmed, a complete probe without a match records the user's attestation
   * (audited), and recover_step may amend the step under a new key. An incomplete probe, or a match, refuses.
   */
  private async confirmAbsent(input: JsonObject, actor: Actor, run: JsonObject): Promise<JsonObject> {
    const step = this.namedStep(run, input.step_id),
      claim = this.claim(actor, step.review_id);
    if (!refusedAfterSubmission(step, claim) || absenceConfirmed(step))
      bad(
        'Step ' +
          step.id +
          ' is ' +
          step.status +
          (absenceConfirmed(step) ? ' and its absence is already confirmed' : '') +
          '. confirm_absent applies only to a step the provider refused after submission (HTTP 4xx with its error body) whose outcome AMCP cannot otherwise prove. A lost response, a timeout or a 5xx is never settled this way.',
        'RECOVERY_NOT_SAFE',
        {step_id: step.id, status: step.status},
      );
    if (!absenceProbe(step))
      bad(
        'Step ' +
          step.id +
          ' has no absence probe: AMCP cannot list what its action creates. Check in the provider whether the resource exists; nothing is sent again.',
        'RECOVERY_NOT_SAFE',
        {step_id: step.id, status: step.status},
      );
    // The claim the refusal above found (`refusedAfterSubmission` needs one), dated.
    const probe = await probeAbsence(this.call, actor, step, Number(claim!.created_at));
    this.store.assertActorActive(actor);
    if (probe.complete !== true)
      bad(
        'The read of step ' +
          step.id +
          '’s parent is incomplete: ' +
          probe.reason +
          ' Absence is not proven, so nothing was recorded and the step is not sent again. Try again later, or check in the provider.',
        'RECOVERY_NOT_SAFE',
        {step_id: step.id, reason: 'absence_probe_incomplete', probe},
      );
    if (probe.matches.length)
      bad(
        'The provider lists ' +
          probe.matches.length +
          ' ' +
          probe.entity +
          (probe.matches.length === 1 ? '' : 's') +
          ' named ' +
          JSON.stringify(probe.name) +
          ' created since step ' +
          step.id +
          ' was submitted, so it may have been applied. It is never sent again: inspect ' +
          probe.matches.map((m: JsonObject) => m.id).join(', ') +
          ' in the provider.',
        'RECOVERY_NOT_SAFE',
        {step_id: step.id, reason: 'resource_may_exist', probe},
      );
    if (input.confirmed !== true)
      return this.respond(input, run, step.id, {
        probe,
        attestation:
          'A complete read found no ' +
          probe.entity +
          ' named ' +
          JSON.stringify(probe.name) +
          ' created since the step was submitted. If the user confirms it does not exist, record that (next_call, adding confirmed: true); the step can then be amended and reviewed under a new key.',
        next_call: {
          tool: 'amcp_campaign',
          arguments: {action: 'confirm_absent', id: run.id, step_id: step.id},
          add_after_user_approval: {confirmed: true},
        },
      });
    step.absence = {review_id: step.review_id, attested: true, by: actor.userId, at: Date.now(), probe};
    audit(this.store, actor, 'campaign_step_absence_confirmed', {
      id: run.id,
      step_id: step.id,
      review_id: step.review_id,
      action: probe.action,
      parent: probe.parent,
      name: probe.name,
      rows_read: probe.rows_read,
      pages: probe.pages,
    });
    run = this.save(actor, run);
    const saved = run.steps.find((s: JsonObject) => s.id === step.id);
    return this.respond(input, run, step.id, {probe, next_call: amendmentCall(run.id, saved, saved.error)});
  }
  /**
   * continue_as_new (CMP-04): a new linked plan of the steps still to write. References to settled predecessors become
   * the literal values they resolved to, each carried step recording adopted_from {run_id, step_id, review_id,
   * verified_resources}; the original plan becomes superseded and links forward, the new plan links back. A step whose
   * outcome is not settled (submitted and uncertain, verifying, mismatched) is never carried: it could be applied twice.
   *
   * `changes: {drop: [step_id]}` (R2.5 r25-field-plan, the owner's Google issue 1, fix 1b) leaves steps out of the continuation, with the
   * drop rule of a clone: a dropped step takes its dependants with it. Only a step nothing was sent for (pending, or its review ready)
   * may be dropped, and the guard above stands: a step that reached the provider blocks the continuation whatever is dropped. The new
   * plan has its own plan_hash, so it needs its own approval. An atomic Google clone (one all-or-nothing build) has no step to drop: a drop
   * on it is answered after that guard, with the cancel and clone it can be offered only while nothing was sent for its build.
   */
  private async continueAsNew(input: JsonObject, actor: Actor, run: JsonObject): Promise<JsonObject> {
    const drop = continuationDrop(input.changes);
    if (run.state === 'superseded' && typeof run.superseded_by?.id === 'string') {
      // The earlier continuation answers only the call that made it: another drop (or none) is not that continuation, and returning it
      // would tell the caller its steps were left out when they were not.
      const recorded: string[] = Array.isArray(run.superseded_by.drop) ? run.superseded_by.drop : [];
      if (recorded.join('\0') !== drop.join('\0'))
        bad(
          'This plan was already continued as plan ' +
            run.superseded_by.id +
            (recorded.length ? ' with changes.drop ' + recorded.join(', ') : ' without a drop') +
            ', so this continue_as_new, with ' +
            (drop.length ? 'changes.drop ' + drop.join(', ') : 'no drop') +
            ', is not that continuation. Continue from that plan to leave out more.',
          'INVALID_ARGUMENT',
          {
            field: 'changes.drop',
            superseded_by: run.superseded_by.id,
            recorded_drop: recorded,
            next_call: {tool: 'amcp_campaign', arguments: {action: 'get', id: run.superseded_by.id}},
          },
        );
      const next = this.owned(actor, run.superseded_by.id);
      return this.respond(input, next, undefined, {
        continued_from: run.id,
        next_call: summaryCall(next.id),
      });
    }
    // A plan held for a continuation (the fifth check G) is repeated only by the person who is making it (the sixth check K1). The plan a continuation makes is named
    // by its key, which includes the person (creationId): a colleague's repeat found the hold, took it for its own and made a plan under its own key, and both plans
    // were live and both sent the step. The hold names that person (`by`) and the plan their key names (`to`), so any other caller is refused here, before the
    // plan's reviews, its steps or its confirmation are looked at.
    const successor = creationId(actor, continuationKey(run.id)),
      repeating = run.state === 'superseded' && run.superseded_by?.pending === true;
    // Where the new plan does not exist yet, the way forward is the repeat, which is theirs, and not a plan that cannot be read (the sixth check K2).
    if (repeating && run.superseded_by.to !== successor)
      throw supersededRefusal(run, this.unfinished(actor, run), true);
    // A step found already current (COM-01) sent nothing and resolved no value to adopt: it is carried and prepared
    // again in the new plan, so a reference into it never resolves to an empty result.
    const adoptable = (s: JsonObject) => settled(s) && s.status !== 'skipped_unchanged',
      carried = run.steps.filter((s: JsonObject) => !adoptable(s));
    if (!carried.length) bad('Every step of this plan is settled; nothing remains to continue.', 'INVALID_ARGUMENT');
    // A catalog retirement is bound to its steps too (r25-planmodel, item 4 of the audit of 2026-11-25): the retailer IDs it retires are what each step's native review checks
    // against the catalog, a binding only catalog_plan can make, so a plan made by a continuation had no check and created the product the retirement refuses.
    if (run.allocation || run.search_exclusions || run.gtm_consent || run.catalog_removal || run.catalog_retirement)
      bad(
        'This plan was saved from a preview, and its steps stay bound to that preview. Prepare a fresh preview for the remaining changes instead.',
        'RECOVERY_NOT_SAFE',
      );
    // An activation plan is gated by what it is: its read-only gates and the second approver the workspace may require are decided by its `activation_of`, which a plan made by
    // a continuation is not given (item 4 of the audit): the owner continued a plan whose gates refused, approved the new one alone and sent the status changes. Its steps are
    // settled in the plan itself.
    if (run.activation_of)
      bad(
        'This plan activates plan ' +
          run.activation_of.id +
          ': its read-only gates and, where the workspace requires it, another person’s approval belong to this plan, and a new plan would not carry them. Settle its steps here (get names the call: preflight reads the gates again, recover_step amends a step that failed), or cancel it.',
        'RECOVERY_NOT_SAFE',
        {
          activation_of: run.activation_of.id,
          next_call: {tool: 'amcp_campaign', arguments: {action: 'get', id: run.id}},
        },
      );
    // A step whose execute is in flight (executing) may hold no claim yet: it waits for its target, or for the state and the credentials (r25-field3-errors, the
    // fourth check F2). Carried, its review would be sent by that execute and again by the new plan, so it is counted with the steps that reached the provider.
    // The same rule for the claim a review holds (not one the provider refused, or an absence confirmed): the one place that says which steps block.
    const blocking = (s: JsonObject): JsonObject | undefined => {
        const claim = this.claim(actor, s.review_id);
        if (
          s.status !== 'executing' &&
          (!claim || claim.state === 'rejected' || rejectedBuild(s) || absenceConfirmed(s))
        )
          return undefined;
        const stop = this.stopped(actor, run, s);
        return {
          step_id: s.id,
          status: s.status,
          next_call:
            stop.next_call ??
            (s.status === 'executing'
              ? {tool: 'amcp_campaign', arguments: {action: 'get', id: run.id, step_id: s.id}}
              : null),
        };
      },
      refuseBlocked = (stopping: JsonObject[]): never =>
        bad(
          'Steps ' +
            stopping.map((b: JsonObject) => b.step_id).join(', ') +
            ' reached the provider and their outcome is not settled, so a new plan cannot carry them: they could be applied twice. Settle each first (details.blocked_steps names the call), or check in the provider.',
          'RECOVERY_NOT_SAFE',
          {blocked_steps: stopping},
        ),
      blocked: JsonObject[] = carried.map(blocking).filter((b: JsonObject | undefined): b is JsonObject => !!b);
    if (blocked.length) refuseBlocked(blocked);
    // A Google clone saved as one all-or-nothing build holds its ad groups as operations of that build, not as steps: no step names one of
    // them, and the build is applied whole or not at all. The way to copy fewer ad groups is to clone again with the ones wanted, and that is
    // offered only here, after every refusal above (lead review of r25-field-plan, S2-1): a build that reached the provider is refused above
    // (RECOVERY_NOT_SAFE when its outcome is not settled, "every step is settled" when it is), so an agent is never handed a call that
    // cancels the plan and copies the campaign again while the first copy may exist. A plan already continued answers above too.
    if (drop.length && run.clone?.all_or_nothing === true) {
      const build = run.steps.find((s: JsonObject) => s.kind === 'write') ?? {},
        unsent = ['pending', 'review_ready'].includes(build.status),
        // The clone call that copies fewer ad groups (R2.5 M3 merge, the plan review's merge join 2 and S4-9, with r25-field-gclone's round 3).
        // It keeps the languages the plan was made with, as gclone stores them in normal form in run.clone.selection; the ad groups are not
        // carried, because choosing them anew is what the call is for. What it may add is what the build's provider declares as selection
        // keys of its clone (`campaign.clone.selection`), less what it already carries, so this shared runner names no provider's key.
        keptSelection = run.clone?.selection as JsonObject | undefined,
        cloneSource: JsonObject = {
          campaign_id: run.clone.source?.campaign_id,
          ...(Array.isArray(keptSelection?.languages) ? {languages: keptSelection.languages} : {}),
        },
        addable = (providerHooks(build.gateway)?.campaign?.clone?.selection ?? [])
          .filter(key => !Object.hasOwn(cloneSource, key))
          .map(key => 'source.' + key),
        // What the first clone was changed with (changes.set) is not kept: run.clone.set holds the step and the path of each change, never
        // the value, and no field is added for it (the lead's decision on the third bullet of join 15b, 2026-11-20). So the call that clones
        // again cannot carry the amounts. It offers changes.set after the selection keys, and the refusal names the paths that were changed,
        // once each, in the order they are stored, so the caller sends them again.
        changedPaths: string[] = [
          ...new Set<string>(
            (Array.isArray(run.clone.set) ? run.clone.set : [])
              .map((change: JsonObject) => change?.path)
              .filter((path: unknown): path is string => typeof path === 'string'),
          ),
        ],
        offered = [...addable, ...(changedPaths.length ? ['changes.set'] : [])];
      bad(
        'Plan ' +
          run.id +
          ' is one all-or-nothing clone: its ad groups are operations of a single build, not steps, so none of them can be dropped from it. ' +
          (unsent
            ? 'Cancel it and clone again with source.ad_group_ids naming the ad groups to copy.' +
              (changedPaths.length
                ? ' The first clone also changed ' +
                  changedPaths.join(', ') +
                  '; AMCP does not keep those values, so send them again in changes.set.'
                : '')
            : 'Its build is ' +
              build.status +
              ', which is the plan’s to settle first (get names the call): a clone is made again only once nothing it sent can still be applied.'),
        'INVALID_ARGUMENT',
        {
          field: 'changes.drop',
          ...(unsent
            ? {
                next_call: {
                  tool: 'amcp_campaign',
                  arguments: {action: 'cancel', id: run.id},
                  add_after_user_approval: {confirmed: true},
                  then: {
                    tool: 'amcp_campaign',
                    arguments: {
                      action: 'clone',
                      gateway: build.gateway,
                      connection_id: build.connection_id,
                      account_id: build.account_id,
                      name: run.name,
                      source: cloneSource,
                    },
                    ...(offered.length ? {add: offered} : {}),
                  },
                },
                ...(changedPaths.length ? {set_not_carried: changedPaths} : {}),
              }
            : {}),
        },
      );
    }
    // The steps left out, with their dependants, and the steps that remain (R2.5 r25-field-plan).
    const gone = droppedSteps(carried, drop),
      dropped: string[] = carried.filter((s: JsonObject) => gone.has(s.id)).map((s: JsonObject) => s.id),
      kept: JsonObject[] = carried.filter((s: JsonObject) => !gone.has(s.id));
    if (!kept.length)
      bad(
        'changes.drop leaves nothing to continue: ' +
          dropped.join(', ') +
          ' would all be dropped. Cancel the plan instead if nothing more should run.',
        'INVALID_ARGUMENT',
        {field: 'changes.drop'},
      );
    if (input.confirmed !== true)
      bad(
        'Set confirmed: true to continue steps ' +
          kept.map((s: JsonObject) => s.id).join(', ') +
          (dropped.length ? ', leaving out ' + dropped.join(', ') : '') +
          ' in a new linked plan. This plan becomes superseded; verified steps stay as they are and are never sent again.',
        'INVALID_ARGUMENT',
        {field: 'confirmed', carried: kept.map((s: JsonObject) => s.id), ...(dropped.length ? {dropped} : {})},
      );
    const results = new Map<string, JsonObject>(run.steps.filter(adoptable).map((s: JsonObject) => [s.id, s.result])),
      ids = new Set(kept.map((s: JsonObject) => s.id)),
      adoptedBy = new Map<string, JsonObject[]>();
    const steps = structure(kept).map(s => {
      const adopted = new Set<string>(),
        out = {
          ...s,
          arguments: adoptReferences(s.arguments, results, adopted),
          depends_on: (s.depends_on ?? []).filter((d: string) => ids.has(d)),
        };
      adoptedBy.set(
        s.id,
        [...adopted].map(id => {
          const from = run.steps.find((x: JsonObject) => x.id === id);
          return {
            run_id: run.id,
            step_id: id,
            review_id: from.review_id ?? null,
            verified_resources: from.result?.verified_resources ?? null,
          };
        }),
      );
      return out;
    });
    const create = {
      action: 'create',
      name: run.name,
      brief: run.brief,
      ...(run.profile_id ? {profile_id: run.profile_id} : {}),
      steps,
      idempotency_key: continuationKey(run.id),
      ...(input.acknowledge_temporary_sources === true ? {acknowledge_temporary_sources: true} : {}),
      detail: 'full',
    };
    this.origins.set(create, {continuation: {run_id: run.id, plan_hash: run.plan_hash}});
    // The reviews of the steps this plan no longer runs (carried, or left out) that nothing sent are retired with it: the new plan prepares its own, and the old
    // ones would otherwise execute directly and make a second object beside them (r25-field3-errors, the third re-review P2, the same rule). They are retired
    // here, before anything is awaited (the fourth check F2): the new plan's creation awaits, and an execute of one of these reviews that waits meanwhile (for its
    // target, for the state and the credentials) would otherwise claim and send it while the new plan sends it again. The claim transaction of an execute reads
    // the mark again, so that execute is refused. A review that holds a claim now was sent after this call read the claims (another process): nothing is carried,
    // and what was retired is opened again, as it is when the new plan cannot be made. Only what this call marked is opened again (the fifth check H): a review
    // already retired (a cancelled plan's, an earlier attempt's) keeps the mark that is on it, and is neither opened nor looked at for a claim.
    // The plan is held from there on, until the new plan is made (the fifth check G): it was saved as superseded only after the new plan was made, and any
    // action on it was allowed in between, so a recover_step that amended its step left two live plans that both sent it, and an execute_next left the step
    // executing for good. It is saved now as superseded, with `superseded_by.pending`, the plan that is being made (`to`, which its key names), and who and
    // when: the dispatcher refuses every action on it but a repeat of this one, as it does for a superseded plan, and the save refuses if the plan moved since it
    // was read. The state it was in (`was`) is kept in this call, which alone puts the plan back. A repeat of continue_as_new that finds the hold (the call was
    // cut short) makes the plan under the same key, which returns the plan already saved, and completes the continuation.
    const retiredNow: {review_id: string; step_id: string}[] = [],
      reopen = () => {
        for (const {review_id, step_id} of retiredNow)
          reopenReview(this.store, actor.tenantId, review_id, {plan_id: run.id, step_id, reason: 'continued'});
      },
      was = run.state;
    let held = false,
      created: JsonObject;
    try {
      for (const step of run.steps) {
        if (settled(step) || typeof step.review_id !== 'string') continue;
        const retired = this.retireStepReview(actor, run, step, 'continued');
        if (retired === 'marked') retiredNow.push({review_id: step.review_id, step_id: step.id});
        else if (!retired) {
          const sent = blocking(step);
          if (sent) refuseBlocked([sent]);
        }
      }
      if (!repeating) {
        run.state = 'superseded';
        run.superseded_by = {pending: true, to: successor, at: Date.now(), by: actor.userId};
        run = this.save(actor, run);
        held = true;
      }
      created = await this.handle(create, actor);
    } catch (e) {
      // The new plan could not be made. A plan this call held is put back as it was and its reviews are opened again, unless the new plan exists, which a repeat
      // of the call completes (a plan under the key that is another plan's, IDEMPOTENCY_CONFLICT, is not it). A repeat that found the hold leaves it, with what it
      // retired, for the next repeat: the plan is not this call's to put back.
      const foreign = e instanceof MirrorError && e.code === 'IDEMPOTENCY_CONFLICT';
      // The plan is read again (the sixth check S4-a): a cancel that landed since this call retired the reviews (another process; the hold's save is then refused, as the
      // plan moved) found each of them marked already and left the mark as this call's, and opening them would open the reviews of a cancelled plan.
      if (
        !repeating &&
        (!held || this.release(actor, run.id, was, foreign ? undefined : successor)) &&
        optional(this.store, actor.tenantId, 'campaign_run', run.id)?.state !== 'cancelled'
      )
        reopen();
      throw e;
    }
    let next = this.owned(actor, created.id);
    // The plan is read again, since another call, or a repeat of this one, may have saved it since.
    const old = this.owned(actor, run.id),
      hold = old.superseded_by,
      ours = old.state === 'superseded' && (hold?.pending === true ? hold.to === next.id : hold?.id === next.id);
    // The hold was released while the new plan was made (the sixth check K2): an editor's cancel released it once it had stood longer than a creation can run, which a call
    // that was stopped for longer than that finishes after, and the plan may have been continued by someone else since. The plan is not this continuation's any more, and
    // the plan this call made is not linked to it: it is cancelled, and the call says so. A plan put back by a failed call of the same person (S4-b) is live again, and is
    // continued below, with its reviews retired again.
    if (old.state === 'cancelled' || (old.state === 'superseded' && !ours)) {
      this.cancelPlan({input: {action: 'cancel', id: next.id, confirmed: true}, actor, run: next});
      bad(
        'This plan ' +
          (old.state === 'cancelled'
            ? 'was cancelled'
            : 'was continued as plan ' + String(hold?.id ?? hold?.to) + ' by someone else') +
          ' while its continuation was being made, so plan ' +
          next.id +
          ', which this continuation made, was cancelled: nothing of it will run.',
        'REVISION_CONFLICT',
        {
          cancelled_plan: next.id,
          next_call: {tool: 'amcp_campaign', arguments: {action: 'get', id: run.id}},
        },
      );
    }
    if (!next.supersedes) {
      next.supersedes = {id: run.id, plan_hash: run.plan_hash, at: Date.now(), by: actor.userId};
      for (const s of next.steps) if (adoptedBy.get(s.id)?.length) s.adopted_from = adoptedBy.get(s.id);
      if (run.recipe) next.recipe = run.recipe;
      // A colleague's continuation keeps the team in view (CMP-05).
      const team = linkedTeam(actor, run);
      if (team) next.collaborators = team;
      next = this.save(actor, next);
    }
    // The hold becomes the supersession (the fifth check G).
    old.state = 'superseded';
    // The drop is recorded with the continuation, so that a second call is answered by it only when it asks for the same drop.
    old.superseded_by = {id: next.id, at: Date.now(), by: actor.userId, ...(drop.length ? {drop, dropped} : {})};
    audit(this.store, actor, 'campaign_plan_superseded', {
      id: run.id,
      superseded_by: next.id,
      carried: [...ids],
      ...(dropped.length ? {dropped} : {}),
      adopted: [...new Set([...adoptedBy.values()].flat().map(a => a.step_id))],
    });
    this.save(actor, old);
    // The reviews are retired again, with the supersession (the sixth check S4-b). A call of the same person that failed while this one was making the plan put the plan
    // back and opened what it had retired (release, reopen), so a plan could end superseded, its new plan made, with its reviews open. retireReview marks only a review
    // that carries no mark and holds no claim: the reviews still retired are left as they are, and one that was sent (a settled step's, or one sent in between) holds a
    // claim and is not touched.
    for (const step of old.steps) this.retireStepReview(actor, old, step, 'continued');
    return this.respond(input, next, undefined, {
      continued_from: run.id,
      ...(dropped.length ? {dropped} : {}),
      next_call: summaryCall(next.id),
    });
  }
  /**
   * activation_plan (CMP-03): a separate linked draft that activates a completed recipe plan's paused launch. The
   * source must be complete (every step verified); each ID comes from a verified receipt, including those of a plan it
   * continues. The draft has its own approval, spend confirmation and preflight, where the read-only activation gates
   * run before any status write. One activation per launch: a repeat returns the same draft.
   */
  private async activationPlan(input: JsonObject, actor: Actor, run: JsonObject): Promise<JsonObject> {
    const offer = {tool: 'amcp_campaign', arguments: {action: 'preflight'}};
    if (run.activation_of)
      bad('This plan activates another plan; it has no activation of its own.', 'ACTIVATION_UNAVAILABLE');
    if (typeof run.activation_plan?.id === 'string') {
      const existing = this.owned(actor, run.activation_plan.id);
      return this.respond(input, existing, undefined, {
        next_call: {...offer, arguments: {...offer.arguments, id: existing.id}},
      });
    }
    const platform = run.recipe?.platform;
    if (typeof run.recipe?.id !== 'string' || !activationPlatforms.includes(platform))
      bad(
        'Guided activation is for completed Meta, Google, Snapchat, Microsoft, TikTok and LinkedIn recipe plans. Activate other plans through their provider’s reviewed writes.',
        'ACTIVATION_UNAVAILABLE',
      );
    if (run.state !== 'complete' || !run.steps.every(settled))
      bad(
        'Activation is prepared once every step of the launch plan is verified. Finish or settle the plan first.',
        'ACTIVATION_NOT_READY',
        {state: run.state, next_call: {tool: 'amcp_campaign', arguments: {action: 'get', id: run.id}}},
      );
    // A continued launch keeps its earlier resources in the plans it continues (CMP-04).
    const chain = [run];
    while (typeof chain[0]!.supersedes?.id === 'string' && chain.length < 10)
      chain.unshift(this.linked(actor, chain[0]!.supersedes.id));
    const results = new Map<string, JsonObject>();
    for (const plan of chain)
      for (const s of plan.steps.filter(settled) as JsonObject[]) results.set(s.id, s.result ?? {});
    const write = run.steps.find((s: JsonObject) => s.kind === 'write'),
      steps = activationSteps(
        platform,
        results,
        {connection_id: write.connection_id, account_id: write.account_id},
        run.recipe,
      );
    // What the gates read is the provider's to keep (its `campaign.activation.record`): Meta's ad and pixel, a
    // LinkedIn lead launch's form (CMP-07), a Google conversion launch's goal reads, from its recipe's declared
    // objects, which recipe_eligibility makes for it (CMP-03).
    const declared: string[] = recipeDependencies[run.recipe.id]?.objects ?? [],
      record = platformActivation(platform)?.activation.record?.(run, results, declared) ?? {};
    const create = {
      action: 'create',
      name: (run.name + ' · activation').slice(0, 100),
      brief:
        'Activates the paused launch of plan ' +
        run.id +
        '. Each status change is reviewed, approved and read back on its own; nothing is sent until this plan is approved.',
      steps,
      idempotency_key:
        'activation-' +
        String(run.id)
          .replace(/[^A-Za-z0-9_-]/g, '')
          .slice(0, 80),
      detail: 'full',
    };
    // The draft is created with what binds it (its gates, and the team of a colleague's launch, CMP-05) in the one save that creates it (r25-planmodel, M9, second round): a
    // second save made after it could fail, and left a live draft the gates did not know, which its owner could approve and run alone. The binding is not part of the creation's
    // identity (`origins` is), so a repeat after a failure finds the same draft.
    const team = linkedTeam(actor, run),
      binding = {
        activation_of: {id: run.id, plan_hash: run.plan_hash, recipe_id: run.recipe.id, platform, ...record},
        ...(team ? {collaborators: team} : {}),
      };
    this.origins.set(create, {activation: {run_id: run.id, plan_hash: run.plan_hash}});
    this.bindings.set(create, binding);
    const created = await this.handle(create, actor);
    let next = this.owned(actor, created.id);
    // A draft an earlier release made before it saved the binding is bound now.
    if (!next.activation_of) next = this.save(actor, Object.assign(next, binding));
    run.activation_plan = {id: next.id, at: Date.now(), by: actor.userId};
    this.save(actor, run);
    // Recorded once the launch names its activation: a repeat after a failed link records it when it links.
    audit(this.store, actor, 'campaign_activation_planned', {
      id: next.id,
      activation_of: run.id,
      platform,
      steps: steps.map(s => s.id),
    });
    return this.respond(input, next, undefined, {
      next_call: {...offer, arguments: {...offer.arguments, id: next.id}},
    });
  }
  /**
   * archive / unarchive (CMP-05). Only a plan nothing remains to run in (complete, cancelled or superseded) is
   * archived: get still returns it, while the default list and the workspace's 500-plan bound leave it out. Unarchiving
   * counts it again, so it needs room under the bound. Both are audited; nothing reaches a provider.
   */
  private archive(input: JsonObject, actor: Actor, run: JsonObject): JsonObject {
    if (input.action === 'unarchive') {
      if (!run.archived) return this.respond(input, run);
      assertPlanRoom(this.store, actor);
      delete run.archived;
      audit(this.store, actor, 'campaign_plan_unarchived', {id: run.id});
      return this.respond(input, this.save(actor, run));
    }
    if (run.archived) return this.respond(input, run);
    if (!archivableStates.includes(run.state))
      bad(
        'Only a complete, cancelled or superseded plan can be archived. Cancel it first if nothing more should run.',
        'PLAN_NOT_ARCHIVABLE',
        {state: run.state, archivable_states: archivableStates},
      );
    if (input.confirmed !== true)
      bad(
        'Set confirmed: true to archive this plan. It stays readable with get and can be unarchived; it leaves the default list and no longer counts toward the 500-plan limit.',
        'INVALID_ARGUMENT',
        {field: 'confirmed'},
      );
    run.archived = {at: Date.now(), by: actor.userId};
    audit(this.store, actor, 'campaign_plan_archived', {id: run.id, state: run.state});
    return this.respond(input, this.save(actor, run));
  }
  /**
   * assign / unassign (CMP-05): the plan's owner or an administrator names a workspace member as viewer, editor or
   * approver. Without user_id, assign lists the members who can be named. A workspace viewer can only view. Audited.
   */
  private assign(input: JsonObject, actor: Actor, run: JsonObject): JsonObject {
    const owner = typeof run.principal === 'string' && run.principal ? run.principal : run.user_id,
      members = assignableMembers(this.store, actor.tenantId).filter(m => m.user_id !== owner),
      team: JsonObject[] = Array.isArray(run.collaborators) ? run.collaborators : [];
    const view = (r: JsonObject, extra: JsonObject = {}) =>
      compactPlan(r, undefined, {
        collaborators: (Array.isArray(r.collaborators) ? r.collaborators : []).map((c: JsonObject) => ({
          user_id: c.user_id,
          role: c.role,
          name: members.find(m => m.user_id === c.user_id)?.name ?? null,
        })),
        ...extra,
      });
    if (input.action === 'assign' && input.user_id === undefined)
      return view(run, {
        members: members.map(m => ({user_id: m.user_id, name: m.name ?? null, workspace_role: m.workspace_role})),
        roles: collaboratorRoles,
        next_call: {tool: 'amcp_campaign', arguments: {action: 'assign', id: run.id}, add: ['user_id', 'role']},
      });
    if (typeof input.user_id !== 'string' || !input.user_id || input.user_id.length > 200)
      bad('Name the workspace member by user_id.', 'INVALID_ARGUMENT', {field: 'user_id'});
    if (input.action === 'unassign') {
      if (!team.some(c => c.user_id === input.user_id)) return view(run);
      run.collaborators = team.filter(c => c.user_id !== input.user_id);
      if (!run.collaborators.length) delete run.collaborators;
      audit(this.store, actor, 'campaign_plan_collaborator_removed', {id: run.id, user_id: input.user_id});
      return view(this.save(actor, run));
    }
    if (!collaboratorRoles.includes(input.role))
      bad('role is viewer, editor or approver.', 'INVALID_ARGUMENT', {field: 'role', allowed: collaboratorRoles});
    const member = members.find(m => m.user_id === input.user_id);
    if (!member)
      bad(
        input.user_id === owner
          ? 'The plan’s owner already has every right on it.'
          : 'Name an active member of this workspace; assign without user_id lists them.',
        'INVALID_ARGUMENT',
        {field: 'user_id'},
      );
    if (member.workspace_role === 'viewer' && input.role !== 'viewer')
      bad('A workspace viewer can only be a plan viewer.', 'INVALID_ARGUMENT', {field: 'role'});
    if (!team.some(c => c.user_id === input.user_id) && team.length >= 20)
      bad('A plan has at most 20 collaborators.', 'INVALID_ARGUMENT', {field: 'user_id'});
    run.collaborators = [
      ...team.filter(c => c.user_id !== input.user_id),
      {user_id: input.user_id, role: input.role, by: actor.userId, at: Date.now()},
    ];
    audit(this.store, actor, 'campaign_plan_collaborator_assigned', {
      id: run.id,
      user_id: input.user_id,
      role: input.role,
    });
    return view(this.save(actor, run));
  }
  async handle(input: JsonObject, actor: Actor): Promise<JsonObject> {
    validate(input, Object.keys(campaignTool.inputSchema.properties), 524288);
    this.store.assertActorActive(actor);
    // ARC-04 stage D: each action is an entry of an action table (src/tool-actions.ts), consulted in the order of the
    // checks the if-chain ran between them: the recipe catalog and its lookups; after the recipe-argument checks, the
    // reads; after the write check, the creations; on a saved plan, after the right the action needs and the revision,
    // its archive and collaborators; then, while it is neither archived, superseded nor cancelled, its confirmations,
    // activation plans and step recoveries; after the account write grants, the draft checks and the preflight,
    // approval and the runs it allows; and after the next step is found, preparing and executing it. An action in no
    // table is refused where the chain refused it.
    const recipe = actionHandler(this.recipeActions, input.action);
    if (recipe) return recipe({input, actor});
    if (
      !['preview_recipe', 'recipe_eligibility', 'create_from_recipe'].includes(input.action) &&
      (input.brief_id !== undefined || input.apply_playbook_rules !== undefined)
    )
      bad('brief_id and apply_playbook_rules apply to preview_recipe, recipe_eligibility and create_from_recipe.');
    if (input.action !== 'create_from_recipe' && input.eligibility_ref !== undefined)
      bad('eligibility_ref applies to create_from_recipe only.');
    const read = actionHandler(this.readActions, input.action);
    if (read) return read({input, actor});
    writer(this.store, actor);
    const creation = actionHandler(this.creationActions, input.action);
    if (creation) return creation({input, actor});
    // What a collaborator may do (CMP-05): approve and run need an approver (and so do the calls run makes under the
    // approval), naming collaborators is the owner's, preflight serves editors and approvers, the rest needs an editor.
    const rights: PlanRight[] = this.underApproval.has(input)
      ? ['approve']
      : ['approve', 'run', 'run_background'].includes(input.action)
        ? ['approve']
        : ['assign', 'unassign'].includes(input.action)
          ? ['manage']
          : input.action === 'preflight'
            ? ['edit', 'approve']
            : ['edit'];
    let run = this.owned(actor, input.id, rights);
    if (input.expected_revision !== undefined && input.expected_revision !== run.revision)
      bad('Reload the current campaign plan.', 'REVISION_CONFLICT');
    // The refusal of a superseded plan names the plan that carries its steps: the one its continuation made, or, while that plan is being made (the fifth check G: the
    // old plan is held, superseded with `superseded_by.pending`), the one the continuation's key names; and, where that plan does not exist yet, says the continuation was
    // not finished and names the repeat that finishes it (the sixth check K2). One function of the plan (supersededRefusal), reached through the shared helper
    // `refusePlanSuperseded`, which approval_summary calls too with the same `unfinished` (r25-field3-merge, merge 13).
    const unfinished = this.unfinished(actor, run);
    // A held plan refuses every action but a repeat of its continuation, the collaboration actions too, which would save it under the continuation.
    if (run.state === 'superseded' && run.superseded_by?.pending === true && input.action !== 'continue_as_new') {
      // Except the cancel of a hold that has stood longer than a creation can run, with no new plan made: it is released, and the plan is cancelled as usual.
      if (input.action === 'cancel' && unfinished?.stale) {
        delete run.superseded_by;
        return this.cancelPlan({input, actor, run});
      }
      refusePlanSuperseded(run, unfinished);
    }
    const collaboration = actionHandler(this.collaborationActions, input.action);
    if (collaboration) return collaboration({input, actor, run});
    if (run.archived) refusePlanArchived(run);
    if (input.action === 'continue_as_new') return this.continueAsNew(input, actor, run);
    if (run.state === 'superseded') refusePlanSuperseded(run, unfinished);
    if (input.action === 'cancel') return this.cancelPlan({input, actor, run});
    if (run.state === 'cancelled') refusePlanCancelled();
    const recovery = actionHandler(this.recoveryActions, input.action);
    if (recovery) return recovery({input, actor, run});
    if (['prepare_next', 'execute_next', 'approve', 'run', 'run_background'].includes(input.action))
      for (const s of run.steps.filter((s: JsonObject) => !settled(s))) {
        const gateway = s.kind === 'media' ? s.arguments.platform + '_native_action' : s.gateway,
          c = this.store.resolveConnection(actor, gateway, s.account_id, s.connection_id);
        assertAccountWrite(this.store, c, normalizeAccount(gateway, s.account_id));
      }
    if (['preflight', 'prepare_next', 'execute_next', 'approve', 'run'].includes(input.action)) {
      assertNewSearchExclusionDraft(this.store, actor, run);
      assertRecipeDraftCurrent(run);
    }
    const blockedBy = (r: JsonObject) => this.blockedView(input, r);
    if (run.preflight?.status === 'blocked' && input.action !== 'preflight') return blockedBy(run);
    if (
      (this.preflight || run.activation_of) &&
      (input.action === 'preflight' || (['prepare_next', 'approve', 'run'].includes(input.action) && !run.preflight))
    ) {
      run.preflight = this.preflight
        ? await this.preflight(actor, run.steps)
        : {status: 'ready', checks: [], checked_at: Date.now(), provider_mutations: 0};
      // An activation plan's read-only gates run as one set with its preflight, before any status write (CMP-03).
      if (run.activation_of) {
        const gates = await activationGates(
            this.call,
            actor,
            run.activation_of,
            run.steps,
            this.inspectConversionGoals,
            () => this.store.assertActorActive(actor),
            this.runPlan,
          ),
          checks = [...(run.preflight.checks ?? []), ...gates];
        this.store.assertActorActive(actor);
        run.preflight = {
          ...run.preflight,
          checks,
          status: checks.some((c: JsonObject) => c.status === 'blocked') ? 'blocked' : run.preflight.status,
          // A Microsoft location gate also names the locations Microsoft returned, for the operator to confirm.
          activation_gates: gates.map(g => ({
            gate: g.gate,
            step: g.step,
            status: g.status,
            ...(Array.isArray(g.locations) ? {locations: g.locations} : {}),
          })),
        };
        // Counts activation preflights and the gates that blocked them (the ticket's measurable outcome).
        audit(this.store, actor, 'campaign_activation_preflight', {
          id: run.id,
          activation_of: run.activation_of.id,
          status: run.preflight.status,
          blocked_gates: gates.filter(g => g.status === 'blocked').map(g => g.gate),
        });
      }
      run = this.save(actor, run);
      if (input.action === 'preflight' || run.preflight.status === 'blocked') return blockedBy(run);
    }
    if (
      ['prepare_next', 'execute_next', 'approve', 'run'].includes(input.action) &&
      run.steps.some((step: JsonObject) => !settled(step))
    )
      for (const stepId of run.steps.map((step: JsonObject) => step.id)) {
        const step = run.steps.find((candidate: JsonObject) => candidate.id === stepId)!;
        if (step.kind !== 'write' || step.status !== 'verified' || typeof step.review_id !== 'string') continue;
        const review = optional(this.store, actor.tenantId, 'write_review', step.review_id),
          version = review?.plan ? verificationContractVersion(review.plan) : undefined;
        if (!version || step.verification?.verification_cache_version === version) continue;
        // Older pending plans cannot advance from a retired native proof. Reuse the accepted receipt;
        // reinspection is read-only and never resets the key, approval intent or historical completed run.
        const proof = await this.verifyWrite(actor, step.review_id);
        this.store.assertActorActive(actor);
        step.verification = proof;
        step.status = verificationStepStatus(proof.status);
        if (step.status === 'verified' && proof.verified_resources)
          step.result = {...step.result, verified_resources: proof.verified_resources};
        run.state = planState(run, step);
        run = this.save(actor, run);
        if (step.status !== 'verified') return this.respond(input, run, step.id, this.followUp(actor, run, step));
      }
    const approval = actionHandler(this.approvalActions, input.action);
    if (approval) return approval({input, actor, run});
    let next = run.steps.find((s: JsonObject) => !settled(s));
    if (!next) return this.respond(input, {...run, state: 'complete'}, undefined, activationOffer(run));
    // In a plan of independent uploads run moves past an upload that needs a person: it prepares the next one, and
    // executes the exact review it just prepared (MED-03 B). An upload a refusal of the state check sent back to pending
    // waits for a person as well (lead review S3-1).
    if (
      this.pastStopped.has(input) &&
      (['uncertain', 'failed', 'processing'].includes(next.status) || heldByStateCheck(next))
    )
      next =
        (input.action === 'execute_next'
          ? run.steps.find(
              (s: JsonObject) => s.review_id === input.review_id && ['review_ready', 'executing'].includes(s.status),
            )
          : nextUpload(run)) ?? next;
    // A write group that stopped part-way is finished by the plan's own execute_next while its review window lasts (the third re-review P4): the step is
    // not blocked for that call, which executes the exact review under the plan's current approval and sends only the parts not sent.
    const resumes =
      input.action === 'execute_next' &&
      ['uncertain', 'failed'].includes(next.status) &&
      input.review_id === next.review_id &&
      this.resumableGroup(actor, next)?.open === true;
    if (!resumes && ['uncertain', 'failed', 'mismatch'].includes(next.status)) {
      // A mismatch holds only its dependants; the user's decision on it can wait while other steps run.
      const other = next.status === 'mismatch' ? independentStep(run) : undefined;
      if (!other) return this.respond(input, run, next.id, {blocked: true, ...this.stopped(actor, run, next)});
      next = run.steps.find((s: JsonObject) => s.id === other)!;
    }
    if (next.status === 'processing') {
      this.assertReviewHolder(actor, run, next);
      const status = await this.call('amcp_media', {action: 'status', review_id: next.review_id}, actor);
      if (!status.success) {
        next.error = status.error;
        next.status = 'failed';
        run.state = 'attention';
        return this.respond(input, this.save(actor, run), next.id);
      }
      next.result = status.data;
      if (
        !status.data.ready &&
        !(
          status.data.processing_status === 'succeeded' &&
          run.steps.some(
            (s: JsonObject) =>
              s.kind === 'media' && s.arguments.action === 'prepare_library' && s.depends_on.includes(next.id),
          )
        )
      )
        return this.respond(input, run, next.id, {next_call: status.data.next_call, blocked_by: 'media_processing'});
      next.status = 'verified';
      run = this.save(actor, run);
      return this.respond(input, run, next.id, {
        next_call: {tool: 'amcp_campaign', arguments: {action: 'prepare_next', id: run.id}},
      });
    }
    if (next.status === 'verifying') {
      const count = {reads: 0, writes: 0},
        readBackStarted = Date.now(),
        v = await meterNativeRequests(count, () => this.verifyWrite(actor, next.review_id));
      next.native_requests = addNativeRequests(next.native_requests, 'verify', count);
      next.timing_ms = withTiming(next.timing_ms, 'verify', Date.now() - readBackStarted);
      next.verification = v;
      next.status = verificationStepStatus(v.status);
      if (next.status === 'verified' && v.verified_resources)
        next.result = {...next.result, verified_resources: v.verified_resources};
      run.state = planState(run, next);
      // A read-back that is inconclusive, pending or mismatched must not stall steps that do not depend on it.
      const other = ['verifying', 'mismatch'].includes(next.status) ? independentStep(run) : undefined;
      if (!other) {
        run = this.save(actor, run);
        return this.respond(input, run, next.id, this.followUp(actor, run, next));
      }
      run = this.save(actor, run);
      next = run.steps.find((s: JsonObject) => s.id === other)!;
    }
    const step = actionHandler(this.stepActions, input.action);
    if (!step) bad('Unknown campaign action.');
    return step({input, actor, run, next});
  }
  /**
   * The answer for a plan whose preflight blocked a step: each blocked step says what refused it, what to do (its remedy) and the call that
   * amends it (Snapchat S2). One function for every action that meets a blocked plan, and for approval_summary, which reads the stored
   * preflight and answers the same view (R2.5 field3, AMCP-07).
   */
  private blockedView(input: JsonObject, r: JsonObject): JsonObject {
    const missing = r.preflight.checks
        .filter((c: JsonObject) => c.status === 'blocked')
        .map((c: JsonObject) => {
          const step = r.steps.find((x: JsonObject) => x.id === c.step),
            error = c.error
              ? {...c.error, remedy: errorRemedy(new MirrorError(c.error.code, c.error.message, c.error.details))}
              : c.error,
            // An activation gate or the Microsoft location rule is settled at the provider, not by amending the step
            // (CMP-03): both are checked again by preflight once the campaign holds a positive location criterion (a
            // preflight saved under the interim rule, which refused every Microsoft activation, included).
            settledElsewhere = c.gate || c.error?.code === 'LOCATION_CRITERIA_REQUIRED';
          return {
            ...c,
            error,
            ...(step && !settledElsewhere ? {next_call: amendmentCall(r.id, step, c.error)} : {}),
            ...(settledElsewhere
              ? {
                  next_call: {
                    tool: 'amcp_campaign',
                    arguments: {action: 'preflight', id: r.id},
                    after: 'the provider state the remedy names has changed',
                  },
                }
              : {}),
          };
        }),
      extra = {
        blocked: r.preflight.status === 'blocked',
        ...(missing.length ? {missing_requirements: missing, next_call: missing[0].next_call ?? null} : {}),
      };
    const view =
      input.detail === 'full'
        ? {...r, ...extra}
        : compactPlan(r, undefined, {...extra, preflight: preflightView(r.preflight)});
    return {...view, ...blockedAnswer(input.action, new Set(missing.map((m: JsonObject) => m.step)).size, r)};
  }
  /** The recipe catalog and its lookups: no plan, and no recipe-argument check yet. */
  private readonly recipeActions: ActionTable<CampaignCall> = {
    recipes: () => ({recipes: campaignRecipeListing()}),
    recipe_lookup: call => this.recipeLookup(call),
    recipe_context: ({input, actor}) => recipeContextCall(this.store, actor, input),
  };
  /** The reads and recipe compilations: eligibility, previews and creations from a recipe, verification, plans. */
  private readonly readActions: ActionTable<CampaignCall> = {
    recipe_eligibility: ({input, actor}) =>
      recipeEligibility(this.store, this.call, this.preflight, input, actor, this.inspectConversionGoals),
    preview_recipe: call => this.fromRecipe(call),
    create_from_recipe: call => this.fromRecipe(call),
    verify: ({input, actor}) => this.verifyWrite(actor, input.review_id),
    validate_provider: ({input, actor}) => this.providerValidation(actor, input),
    // Newest first, filtered, as an SQL projection with one account summary per plan (CMP-05).
    list: ({input, actor}) => listPlans(this.store, actor, input),
    get: call => this.getPlan(call),
    // R2.5 field3 (AMCP-07): what approve without confirmed shows, as a read of the plan under its `view` right.
    approval_summary: call => this.approvalSummaryRead(call),
  };
  /** The creations of a plan, by a caller who may write. */
  private readonly creationActions: ActionTable<CampaignCall> = {
    clone: call => this.cloneCampaign(call),
    create: call => this.createPlan(call),
  };
  /** A saved plan's archive and collaborators, before the checks of its state. */
  private readonly collaborationActions: ActionTable<PlanCall> = {
    archive: ({input, actor, run}) => this.archive(input, actor, run),
    unarchive: ({input, actor, run}) => this.archive(input, actor, run),
    assign: ({input, actor, run}) => this.assign(input, actor, run),
    unassign: ({input, actor, run}) => this.assign(input, actor, run),
  };
  /** The confirmations, activation plans and step recoveries of a plan neither archived, superseded nor cancelled. */
  private readonly recoveryActions: ActionTable<PlanCall> = {
    confirm_absent: ({input, actor, run}) => this.confirmAbsent(input, actor, run),
    activation_plan: ({input, actor, run}) => this.activationPlan(input, actor, run),
    reconcile_step: call => this.reconcileStep(call),
    recover_step: call => this.recoverStep(call),
  };
  /** Approval and the runs it allows, after the account write grants, the draft checks and the preflight. */
  private readonly approvalActions: ActionTable<PlanCall> = {
    approve: ({input, actor, run}) => this.approve(input, actor, run),
    run: ({input, actor, run}) => this.runApproved(input, actor, run),
    run_background: ({input, actor, run}) => this.runInBackground(input, actor, run),
  };
  /** The plan's next step: preparing its review, and executing the exact review prepared. */
  private readonly stepActions: ActionTable<StepCall> = {
    prepare_next: call => this.prepareNext(call),
    execute_next: call => this.executeNext(call),
  };
  /**
   * recipe_lookup: a lookup its provider answers (`campaign.lookups`): Microsoft locations from its geographical
   * locations file, or Google country and language constants.
   */
  private async recipeLookup({input, actor}: CampaignCall): Promise<JsonObject> {
    const lookup = typeof input.lookup_kind === 'string' ? recipeLookups.get(input.lookup_kind) : undefined;
    // CMP-03: Microsoft location IDs and names from its geographical locations file, by name or by ID.
    if (lookup?.unavailable) {
      if (!this.lookupMicrosoftLocations) throw lookup.unavailable();
      return this.lookupMicrosoftLocations(actor, input);
    }
    const query = String(input.query ?? '').trim();
    if (!/^[A-Za-z -]{2,60}$/.test(query) || !lookup?.search)
      throw new MirrorError('INVALID_LOOKUP', 'Enter a country name/code or language name (2–60 letters).');
    return lookup.search({store: this.store, call: this.call, actor, input, query});
  }
  /** preview_recipe and create_from_recipe: a recipe compiled from the business inputs, and a plan created from it. */
  private async fromRecipe({input, actor}: CampaignCall): Promise<JsonObject> {
    input = resolveBrief(this.store, actor, input);
    const context = recipeContext(this.store, actor, input.recipe, input.profile_id),
      {business, provenance} = recipeInputs(context, input.business ?? {}, {
        apply_playbook_rules: input.apply_playbook_rules,
        client_brief: input.client_brief,
      });
    const missing = recipeMissing(context.recipe, business);
    if (input.action === 'preview_recipe' && missing.length)
      return {ready: false, missing_fields: missing, provenance, provider_mutations: 0};
    const {recipe, ...plan} = campaignRecipe(input.recipe, business);
    if (input.action === 'preview_recipe')
      return {
        ready: true,
        plan,
        recipe,
        provenance,
        provider_mutations: 0,
        meaning: 'Local compilation. Run preflight before preparing mutations.',
      };
    writer(this.store, actor);
    const create = {
      ...plan,
      ...(input.profile_id ? {profile_id: input.profile_id} : {}),
      ...(input.idempotency_key !== undefined ? {idempotency_key: input.idempotency_key} : {}),
      ...(input.acknowledge_temporary_sources !== undefined
        ? {acknowledge_temporary_sources: input.acknowledge_temporary_sources}
        : {}),
      detail: 'full',
    };
    // The playbook-rule choice and the saved brief join the origin, so one creation key names one exact input.
    this.origins.set(create, {
      recipe: input.recipe,
      business: input.business ?? {},
      ...(input.apply_playbook_rules === false ? {playbook_rules: false} : {}),
      ...(input.client_brief ? {client_brief: input.client_brief} : {}),
    });
    const result = await this.handle(create, actor);
    let run = this.owned(actor, result.id);
    // A repeated keyed request returns the original plan, whose provenance is already saved.
    if (!run.recipe) {
      run.recipe = {...recipe, provenance};
      if (input.client_brief) run.client_brief = input.client_brief;
      // A live eligibility check of this exact brief seeds preflight when every binding still matches (CMP-06).
      const reuse =
        input.eligibility_ref === undefined
          ? undefined
          : eligibilityReuse(this.store, actor, input.eligibility_ref, run, input.recipe, provenance);
      if (reuse?.applied && !run.preflight) run.preflight = reuse.preflight;
      run = this.save(actor, run);
      const reused = reuse
        ? {eligibility_reuse: Object.fromEntries(Object.entries(reuse).filter(([key]) => key !== 'preflight'))}
        : {};
      // With a reused preflight that blocked nothing, the response carries the approval summary at once.
      if (reuse?.applied && run.preflight.status !== 'blocked') {
        const approval = this.approve({id: run.id}, actor, run);
        return {...approval, recipe: run.recipe, ...reused};
      }
      // Which value came from the user and which from the approved profile is what a person checks next.
      return this.respond(input, run, undefined, {recipe: run.recipe, ...reused});
    }
    return this.respond(input, run, undefined, {recipe: run.recipe});
  }
  /**
   * get with a step_id and a topic (r25-field3-errors, AMCP-11): one part of the step (`topic`: its request, arguments, before state or
   * receipt, and for a write group its parts, each with its review id and its state now: the lead re-review N2) as canonical JSON text in
   * pages of at most 24 KB, or the subtree of it that a JSON pointer names (`query`, such as
   * /body/mutate_operations/34, which an agent takes from the field path of an error). Values the review hides (credential shapes) are
   * hidden here too, and the answer says where. A page's cursor is bound to the person, the plan's revision and the exact read, so a
   * plan that changed, another read or another person's cursor continues nothing (INVALID_CURSOR). The tool's schema is untouched: topic,
   * query and cursor were its properties already.
   */
  private stepPart(actor: Actor, run: JsonObject, step: JsonObject, input: JsonObject): JsonObject {
    const part: string = input.topic;
    if (!(stepParts as readonly string[]).includes(part))
      bad(
        'topic names the part of the step to read: request, arguments, before_state, receipt or, for a write group, parts.',
        'INVALID_ARGUMENT',
        {field: 'topic', allowed: [...stepParts]},
      );
    const source =
      part === 'request'
        ? step.review?.request
        : part === 'arguments'
          ? step.arguments
          : part === 'before_state'
            ? step.review?.before_state
            : part === 'parts'
              ? Array.isArray(step.review?.parts)
                ? groupPartsView(step.review, id => writePartState(this.store, actor.tenantId, id))
                : undefined
              : step.result;
    // A step whose review is prepared and is no group never will have parts (the second re-review, S4-e): it is not told "yet".
    if (source === undefined)
      bad(
        part === 'parts' && step.review
          ? 'Step ' + step.id + ' is not a write group: its review is one request and has no parts.'
          : 'Step ' + step.id + ' has no ' + part + ' yet.',
        'INVALID_ARGUMENT',
        {field: 'topic', step_id: step.id},
      );
    // What a review hides in its request (credential shapes) is hidden here, and where is said, as the review says it.
    const {value, redacted} = redactCredentialShapesWithPaths(source);
    let shown = value;
    if (input.query !== undefined) {
      if (typeof input.query !== 'string' || !input.query.startsWith('/'))
        bad('query is a JSON pointer into the part, beginning with /.', 'INVALID_ARGUMENT', {field: 'query'});
      try {
        shown = pointer(value, input.query);
      } catch (e) {
        if (!(e instanceof MirrorError)) throw e;
        // "The parts … have", "The request … has" (the second re-review, S4-e).
        bad(
          'The ' +
            part +
            ' of step ' +
            step.id +
            (part === 'parts' ? ' have' : ' has') +
            ' nothing at ' +
            input.query +
            '.',
          'INVALID_ARGUMENT',
          {field: 'query'},
        );
      }
    }
    const text = stable(shown),
      bounds = pageBounds(text),
      binding = cursorBinding(this.store, actor, {
        action: 'get',
        id: run.id,
        step_id: step.id,
        topic: part,
        query: input.query ?? null,
        revision: run.revision,
      }),
      from = decodeOffsetCursor(input.cursor, binding, 'step part'),
      page = bounds.findIndex(([start]) => start === from);
    if (page < 0) throw invalidCursor('step part');
    const [start, end] = bounds[page]!;
    return {
      view: 'step_part',
      id: run.id,
      step_id: step.id,
      part,
      ...(input.query !== undefined ? {pointer: input.query} : {}),
      revision: run.revision,
      page: page + 1,
      pages: bounds.length,
      bytes: Buffer.byteLength(text),
      text: text.slice(start, end),
      ...(page + 1 < bounds.length ? {next_cursor: encodeOffsetCursor(binding, bounds[page + 1]![0])} : {}),
      ...(redacted.length ? {redacted: redacted.slice(0, 50)} : {}),
    };
  }
  /** get: one plan, compact or in full, or one of its steps, with the execution journal. */
  private getPlan({input, actor}: CampaignCall): JsonObject {
    const run = this.owned(actor, input.id),
      journal = (steps: JsonObject[]) =>
        steps
          .filter((s: JsonObject) => s.review_id)
          .map((s: JsonObject) => ({
            step_id: s.id,
            status: s.status,
            review_id: s.review_id,
            ...this.store.operationJournal(actor.tenantId, s.review_id),
          }));
    if (input.step_id !== undefined) {
      const step = run.steps.find((s: JsonObject) => s.id === input.step_id);
      if (!step)
        bad(
          'step_id ' +
            JSON.stringify(String(input.step_id)) +
            ' is not in this plan. Its steps: ' +
            run.steps.map((s: JsonObject) => s.id).join(', ') +
            '.',
          'INVALID_ARGUMENT',
          {field: 'step_id', allowed: run.steps.map((s: JsonObject) => s.id)},
        );
      // A write group that stopped part-way says what the plan can do with it, here too (the third re-review P4): the status sentences send a reader to this
      // read, and the stop's own error shows no details. The call that finishes it while its window lasts, or what is left once it has ended.
      const stoppedGroup =
          ['uncertain', 'failed'].includes(step.status) && this.resumableGroup(actor, step)
            ? this.stopped(actor, run, step)
            : undefined,
        header = {
          view: 'step',
          id: run.id,
          name: run.name,
          revision: run.revision,
          state: run.state,
          plan_hash: run.plan_hash,
          ...(stoppedGroup ? {recovery: stoppedGroup.recovery, next_call: stoppedGroup.next_call} : {}),
          // A step left executing names the call that settles it (r25-planmodel, F3).
          ...this.resumeOffer(actor, run, step),
        };
      // r25-field3-errors (AMCP-11): one part of the step on request, in pages or as the subtree of a JSON pointer.
      if (input.topic !== undefined) return this.stepPart(actor, run, step, input);
      // detail "full" is the step whole, as it always was, while it is small; a larger one comes as the default view and the size left out.
      if (input.detail === 'full') {
        const whole = {...header, step, execution_journal: journal([step])};
        if (Buffer.byteLength(JSON.stringify(whole)) + detailFullEnvelope <= detailFullLimit) return whole;
        return {
          ...header,
          ...stepView(run, step, journal([step])),
          full_omitted_bytes: Buffer.byteLength(JSON.stringify(step)),
        };
      }
      return {...header, ...stepView(run, step, journal([step]))};
    }
    // A background run's state comes from its job (MED-03 B): queued, running, complete or failed.
    const background = backgroundRunView(this.store, actor.tenantId, run),
      running = background ? {background} : {},
      // A held plan whose new plan does not exist says the continuation was not finished, and names the repeat (the sixth check K2).
      unfinished = this.unfinished(actor, run),
      offer = unfinished ? {notice: supersededRefusal(run, unfinished).message, next_call: unfinished.next_call} : {},
      // A step left executing names the call that settles it (r25-planmodel, F3).
      resume = this.resumeOffer(
        actor,
        run,
        run.steps.find((s: JsonObject) => s.status === 'executing'),
      );
    if (input.detail === 'full')
      return {...run, execution_journal: journal(run.steps), ...running, ...resume, ...offer};
    return compactPlan(run, undefined, {
      ...(run.preflight ? {preflight: preflightView(run.preflight, true)} : {}),
      ...running,
      ...activationOffer(run),
      ...resume,
      ...offer,
    });
  }
  /** clone: a draft plan built from an existing campaign, created once per creation key. */
  private async cloneCampaign({input, actor}: CampaignCall): Promise<JsonObject> {
    assertCloneGateway(input.gateway);
    const connection = this.store.resolveConnection(actor, input.gateway, input.account_id, input.connection_id);
    // A keyed clone names its request, not what the source reads: a retry returns the original draft without reading
    // the source again, and the key with another request conflicts before any read (CMP-02 b).
    // The selection a source names (ad_group_ids, languages) joins the identity only when there is one, in its normal form
    // and beside the source without those keys (field fix r25-field-gclone, round 3; the lead's review S2-1 and S4-7). A
    // request that names none keeps the identity it always had, so an old keyed retry still replays. A run made before this
    // release, when the selection was ignored and a whole-campaign plan was stored under the source as sent, names none, so
    // the same key and source conflict instead of returning that plan as if it matched; and the order or spelling of the
    // IDs does not make a second request.
    const selection = cloneSelection(input.source);
    const origin = {
      clone: {
        gateway: input.gateway,
        connection_id: connection.id,
        account_id: input.account_id,
        source: selection ? sourceWithoutSelection(input.source) : (input.source ?? null),
        changes: input.changes ?? null,
        atomic: input.atomic ?? null,
        name: input.name ?? null,
        brief: input.brief ?? null,
        ...(selection ? {selection} : {}),
      },
    };
    if (input.idempotency_key !== undefined) {
      const existing = optional(this.store, actor.tenantId, 'campaign_run', creationId(actor, input.idempotency_key));
      if (existing && existing.creation_origin !== fingerprint(origin))
        bad('This creation key belongs to a different campaign plan.', 'IDEMPOTENCY_CONFLICT');
      if (existing?.clone) {
        const run = this.owned(actor, existing.id);
        return this.respond(input, run, undefined, {
          clone: run.clone,
          next_call: summaryCall(run.id),
        });
      }
    }
    const source = await clonePlan(this.call, actor, {...input, connection_id: connection.id}),
      changed = applyCloneChanges(source.steps, input.changes),
      allOrNothing = providerHooks(input.gateway)?.campaign?.clone?.allOrNothing,
      // Where the provider's clone can choose what to copy, that is offered beside dropping steps (round 2, the lead 2026-11-20).
      shrink = providerHooks(input.gateway)?.campaign?.clone?.shrinkAdvice;
    if (changed.steps.length > 50 && (!allOrNothing || input.atomic === false))
      bad(
        'The clone has ' +
          changed.steps.length +
          ' steps; a plan holds at most 50. Leave some out with changes.drop' +
          (shrink ? ', or ' + shrink : '') +
          '.',
        'CLONE_SOURCE_TOO_LARGE',
        {field: 'changes.drop', steps: changed.steps.slice(0, 100).map(s => s.id)},
      );
    // A Google clone is one all-or-nothing build unless the caller asks for step-by-step (atomic: false): its provider
    // declares the build.
    const atomic = !!allOrNothing && input.atomic !== false;
    const create = {
      action: 'create',
      name: input.name,
      brief: input.brief ?? 'Clone of campaign ' + source.source.campaign_id + '.',
      steps: atomic ? [allOrNothing!(changed.steps, input.account_id)] : changed.steps,
      ...(input.idempotency_key !== undefined ? {idempotency_key: input.idempotency_key} : {}),
      detail: 'full',
    };
    this.origins.set(create, origin);
    const created = await this.handle(create, actor),
      run = this.owned(actor, created.id);
    if (run.clone)
      return this.respond(input, run, undefined, {
        clone: run.clone,
        next_call: summaryCall(run.id),
      });
    run.clone = {
      source: source.source,
      // What the caller chose, in the normal form the identity uses: a later plan that copies this one reads it here.
      ...(selection ? {selection} : {}),
      not_copied: source.notCopied,
      // Which step is which ad group of the source (field fix r25-field-gclone, owner 2026-11-19). A group whose step
      // changes.drop left out stays in the list, marked, so a drop made by position can be checked against the group.
      ...(source.adGroups?.length
        ? {
            ad_groups: source.adGroups.map(g => (changed.dropped.includes(g.step_id) ? {...g, dropped: true} : g)),
          }
        : {}),
      ...(changed.set.length ? {set: changed.set} : {}),
      ...(changed.dropped.length ? {dropped: changed.dropped} : {}),
      ...(atomic ? {all_or_nothing: true, steps: changed.steps.map(s => s.id)} : {}),
    };
    audit(this.store, actor, 'campaign_plan_cloned', {id: run.id, source: source.source, plan_hash: run.plan_hash});
    return this.respond(input, this.save(actor, run), undefined, {
      clone: run.clone,
      next_call: summaryCall(run.id),
    });
  }
  /** create: a draft plan of explicit or templated steps, created once per creation key. */
  private createPlan({input, actor}: CampaignCall): JsonObject {
    const origin = this.origins.get(input);
    // A gateway, account or connection beside the name is the default of the steps that leave it out, a media step taking the
    // connection and the account only (R2.5 field fix, call shape, the lead's decision of 2026-11-19, reversing T4 for the
    // unambiguous case). What create cannot use of them, a value that does not fit its field or one that a step contradicts, is
    // still the mistake the White Friday agent made first: the refusals a caller can correct say where each one goes (R2.5 T4), in
    // details.hint and details.move, beside a message that stays one sentence the website can show in Arabic (R2.5 S3-3). Before
    // the steps are read, only a value that cannot fit is known.
    let moved = topLevelMoves(fillStepDefaults([], input));
    const refuse = (message: string, details: JsonObject = {}): never =>
      bad(message, 'INVALID_ARGUMENT', {
        ...details,
        ...(moved ? {hint: moved.hint, move: moved.move} : {}),
        // The help that has the worked example of a plan.
        help_call: createHelpCall,
      });
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100)
      refuse('Provide a campaign name of 1–100 characters; brief is optional and defaults to the name.');
    // The brief defaults to the name when it is left out (R2.5 T4, owner General 3, 2026-11-15): a plan's steps say what
    // it does and its name what it is. A brief that is sent is checked as before, and is saved as sent.
    const brief = input.brief === undefined ? input.name : input.brief;
    if (typeof brief !== 'string' || brief.length > 12000)
      refuse('brief must be text of at most 12,000 characters, or left out: it then defaults to the name.');
    // A profile outside the actor's client access set is not found (SEC-08).
    const profile = input.profile_id ? visibleProfile(this.store, actor, input.profile_id) : undefined,
      variables = {...(profile?.variables ?? {}), ...(input.variables ?? {}), profile: profile ?? {}};
    noSecrets(variables);
    const raw = input.steps ?? profile?.templates?.[input.template];
    if (!Array.isArray(raw) || !raw.length || raw.length > 50)
      refuse('Provide 1–50 explicit steps, or choose an approved saved template.');
    const steps = origin ? structuredClone(raw) : substitute(raw, variables),
      seen = new Set<string>();
    // A gateway a step wrote inside its arguments is read as the step's own (R2.5 field fix, call shape, item 4), and the response says
    // so. Then the defaults are written into the steps that leave them out, before any step is checked: each step is the step it
    // would be if the caller had named the values in it, and so are the plan's hash and its approval summary.
    for (const warning of liftStepGateways(steps)) this.noteWarning?.(warning);
    const unused = fillStepDefaults(steps, input);
    moved = topLevelMoves(unused);
    for (const [index, s] of steps.entries()) {
      // A step with keys it does not take, or none at all, is answered with its correction too, keeping the refusal's own
      // details (what it does not take and what it does).
      try {
        validate(s, [
          'id',
          'kind',
          'gateway',
          'connection_id',
          'account_id',
          'arguments',
          'depends_on',
          'description',
          'expected_currency',
          'prerequisites',
        ]);
      } catch (error) {
        if (error instanceof MirrorError && error.code === 'INVALID_ARGUMENT' && (!obj(s) || error.details.unsupported))
          refuse(error.message, {...error.details, example: correctedStep(s, input)});
        throw error;
      }
      const problems = [
        !/^[A-Za-z][A-Za-z0-9_-]{0,50}$/.test(s.id) && 'id must start with a letter (up to 51 letters, digits, _ or -)',
        seen.has(s.id) && 'id must be unique',
        !['write', 'media'].includes(s.kind) && 'kind must be "write" or "media"',
        s.kind === 'write' &&
          typeof s.gateway !== 'string' &&
          'a write step needs gateway, e.g. "snapchat_native_action"',
        !obj(s.arguments) && 'arguments must be the native tool input object',
        typeof s.connection_id !== 'string' && 'connection_id is required',
        typeof s.account_id !== 'string' && 'account_id is required',
        s.expected_currency !== undefined &&
          !/^[A-Z]{3}$/.test(s.expected_currency) &&
          'expected_currency must be an ISO code such as "USD", or omitted',
        s.prerequisites !== undefined &&
          (!Array.isArray(s.prerequisites) ||
            s.prerequisites.some(
              (p: unknown) =>
                ![
                  'meta_image_hash',
                  'tiktok_spark_post',
                  'tiktok_cta_portfolio',
                  'tiktok_pixel',
                  'linkedin_lead_form',
                ].includes(p as string),
            ) ||
            new Set(s.prerequisites).size !== s.prerequisites.length) &&
          'prerequisites lists checks preflight must make: "meta_image_hash", "tiktok_spark_post", "tiktok_cta_portfolio", "tiktok_pixel" or "linkedin_lead_form"',
      ].filter(Boolean);
      // The step is answered with its own correction (R2.5 T4): the shape was learned only by failing.
      if (problems.length)
        refuse('Step ' + JSON.stringify(String(s.id ?? '')) + ': ' + problems.join('; ') + stepShape, {
          example: correctedStep(s, input),
        });
      const deps = s.depends_on ?? [];
      if (!Array.isArray(deps) || new Set(deps).size !== deps.length || deps.some(d => !seen.has(d)))
        bad('Dependencies must refer to earlier steps.');
      seen.add(s.id);
      noSecrets(s.arguments);
      // A near-miss action name (T7) is saved under its canonical name: the plan, its hash and its steps' reviews name
      // the one action the step stands for, and the response says where the caller wrote the alias.
      if (s.kind === 'write' && typeof s.arguments.action === 'string' && this.canonicalAction)
        s.arguments.action = this.canonicalAction(
          s.gateway,
          s.arguments.action,
          'steps[' + index + '].arguments.action',
        );
      const gateway = s.kind === 'media' ? s.arguments.platform + '_native_action' : s.gateway;
      this.store.resolveConnection(actor, gateway, s.account_id, s.connection_id);
      if (
        profile?.bindings?.length &&
        !profile.bindings.some(
          (b: JsonObject) =>
            b.gateway === gateway &&
            b.connection_id === s.connection_id &&
            normalizeAccount(gateway, b.account_id) === normalizeAccount(gateway, s.account_id),
        )
      )
        bad(
          'Step ' +
            s.id +
            ' is outside this approved client playbook’s account bindings. Choose a bound account or revise the playbook.',
          'PROFILE_ACCOUNT_MISMATCH',
        );
      if (
        s.kind === 'media' &&
        ((s.arguments.action !== undefined && !['prepare', 'prepare_library'].includes(s.arguments.action)) ||
          s.arguments.confirmed !== undefined ||
          s.arguments.idempotency_key !== undefined)
      )
        bad('Media steps contain preparation inputs only.');
      s.depends_on = deps;
      s.status = 'pending';
    }
    // A step that applies a secret-like value (a creator's authorization code) cannot be a step of a plan: the plan is stored as it is
    // written, and its steps never send the value that an execute takes again (r25-m4b-smartpush, the lead's review S1-2).
    noSecretSteps(this.secretSteps?.(steps) ?? []);
    // A top-level value that no step used, in a plan that is accepted all the same, is said so (round 2, S3-1): a caller that believed it
    // applied would learn otherwise only at approval. A refused plan says it in the hint of its refusal instead.
    for (const field of unused) this.noteWarning?.(topLevelNotUsedWarning(field));
    if (
      input.idempotency_key !== undefined &&
      (typeof input.idempotency_key !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(input.idempotency_key))
    )
      bad('Use a stable campaign creation key of 8–100 letters, digits, hyphens or underscores.');
    const allocation = allocationCreationBinding(this.store, actor, input, steps);
    const search_exclusions = searchExclusionCreationBinding(this.store, actor, input, steps);
    const gtm_consent = consentBinding.create(this.store, actor, input, steps);
    const catalog_removal = removalBinding.create(this.store, actor, input, steps);
    // Where a catalog plan's products came from (COM-03): set only by amcp_workspace catalog_plan.
    const catalog_lineage = catalogLineageCreationBinding(this.store, actor, input, steps);
    // The retailer IDs the plan retires (COM-02 B): their native reviews must find an existing product.
    const catalog_retirement = catalog_lineage ? catalogRetirementCreationBinding(this.store, actor, input) : undefined;
    const creation_fingerprint = fingerprint({
      name: input.name,
      brief,
      user: actor.userId,
      profile_id: profile?.id ?? null,
      profile_revision: profile?.revision ?? null,
      variables,
      steps: structure(steps),
      allocation: allocation ?? null,
      ...(search_exclusions ? {search_exclusions} : {}),
      ...(gtm_consent ? {gtm_consent} : {}),
      ...(catalog_removal ? {catalog_removal} : {}),
      ...(catalog_lineage ? {catalog_lineage} : {}),
      ...(catalog_retirement ? {catalog_retirement} : {}),
      ...(origin ? {origin} : {}),
    });
    const id = input.idempotency_key ? creationId(actor, input.idempotency_key) : randomUUID();
    const existing = input.idempotency_key ? optional(this.store, actor.tenantId, 'campaign_run', id) : undefined;
    if (existing) {
      if (existing.creation_fingerprint !== creation_fingerprint)
        bad('This creation key belongs to a different campaign plan.', 'IDEMPOTENCY_CONFLICT');
      return this.respond(input, this.owned(actor, id));
    }
    // A recipe's compiled steps leave the fields a provider derives from the plan's own ID (TikTok's request_id of an Upgraded Smart+
    // create) at a placeholder: they are given their values here, once the plan's ID is known, and frozen in the saved steps (R2.5 M4, the
    // lead's decision L3). After the creation fingerprint, which names the request, so that a repeat of it finds this plan; before the
    // plan's hash, so that the approval covers the keys. Only a recipe's plan: a plan made by hand keeps what its steps say.
    if (origin?.recipe !== undefined) for (const [i, s] of steps.entries()) steps[i] = bindRecipeStep(s, id);
    // Temporary files are deleted 30 minutes after they started: a plan that uses them is saved only with that
    // deadline acknowledged, and it records and shows the deadline (owner decision D23, MED-01).
    const temporary = temporaryMediaSources(this.store, actor.tenantId, steps),
      earliest = earliestDeadline(temporary);
    if (temporary.length && input.acknowledge_temporary_sources !== true)
      bad(
        'This plan uses temporary files (uploads or imports with a source_id src-…), deleted 30 minutes after they started, so it must run before then. Save it with acknowledge_temporary_sources: true, or for a plan that can wait import the files from a link or Google Drive and have an owner retain them.',
        'TEMPORARY_MEDIA_SOURCES',
        {temporary_sources: temporary, earliest_expires_at: earliest},
      );
    assertRunnableSources(temporary);
    // Archived plans do not count (CMP-05); the refusal names the remedy.
    assertPlanRoom(this.store, actor);
    const run = {
      name: input.name,
      brief,
      ...ownership(actor),
      profile_id: profile?.id ?? null,
      profile_revision: profile?.revision ?? null,
      variables,
      steps,
      state: 'draft',
      created_at: Date.now(),
      updated_at: Date.now(),
      plan_hash: fingerprint(structure(steps)),
      ...(input.idempotency_key ? {creation_fingerprint} : {}),
      ...(input.idempotency_key && origin ? {creation_origin: fingerprint(origin)} : {}),
      ...(allocation ? {allocation} : {}),
      ...(search_exclusions ? {search_exclusions} : {}),
      ...(gtm_consent ? {gtm_consent} : {}),
      ...(catalog_removal ? {catalog_removal} : {}),
      ...(catalog_lineage ? {catalog_lineage} : {}),
      ...(catalog_retirement ? {catalog_retirement} : {}),
      ...(this.bindings.get(input) ?? {}),
      ...(temporary.length
        ? {
            temporary_sources: {
              acknowledged_by: actor.userId,
              acknowledged_at: Date.now(),
              earliest_expires_at: earliest,
              sources: temporary,
            },
          }
        : {}),
      approval: gtm_consent
        ? 'Each workspace tag update needs separate native review, execution confirmation and read-back. No container version is created or published.'
        : search_exclusions
          ? 'Each exact keyword exclusion requires separate native review, approval and read-back. This draft changes no advertising.'
          : allocation
            ? 'Each native budget update needs separate review and approval. This unapproved draft does not change campaign status.'
            : 'Each resolved native request uses prepare → review → execute. A draft submits no provider changes; serving effects are stated in each native review.',
    };
    this.store.putDocument(actor.tenantId, 'campaign_run', id, run);
    audit(this.store, actor, 'campaign_plan_created', {id, name: run.name, plan_hash: run.plan_hash});
    return this.respond(input, this.owned(actor, id));
  }
  /** cancel: the steps not yet run will not run; what the provider already created stays. */
  private cancelPlan({input, actor, run}: PlanCall): JsonObject {
    if (input.confirmed !== true)
      bad(
        'Set confirmed: true to cancel this plan. Steps not yet run will not run; anything already created at the provider stays.',
        'INVALID_ARGUMENT',
        {field: 'confirmed'},
      );
    // The reviews the plan's unsettled steps hold, which nothing sent, are retired with the plan (r25-field3-errors, the third re-review C1): "Steps not yet
    // run will not run" was true of the plan and not of their reviews, which stayed valid for their window and executed directly (a step the plan sent,
    // or may have sent, holds a claim and keeps its receipt).
    // A step whose execute is in flight (executing) is not left executing (the fourth check F4): the execute's own copy of the plan is stale once this call has
    // saved it, so it can no longer record how it ended, and the step would read executing for good. When the cancel retired the review (nothing was claimed),
    // that execute is refused when it comes to claim it, nothing is sent, and the step is as every other step of the plan the cancel stopped, ready and never
    // executed. When the review holds a claim (the execute got that far, or a part of its group did) the change may have reached the provider, and the step is
    // uncertain, which the plan reads as it reads any step in that state: from the claim, by the status of its review.
    // The marks and the state are one transaction (r25-planmodel, F1): a save that failed or conflicted after the reviews were retired left a live plan holding retired
    // reviews, and the next execute_next of its step was refused as retired for good. Now a save that does not happen takes the marks back with it.
    run = this.store.transaction(() => {
      for (const step of run.steps) {
        if (settled(step)) continue;
        const retired = this.retireStepReview(actor, run, step, 'cancelled');
        if (step.status === 'executing') step.status = retired ? 'review_ready' : 'uncertain';
      }
      run.state = 'cancelled';
      return this.save(actor, run);
    });
    return this.respond(input, run, undefined, {notice: 'Already created provider resources remain intact.'});
  }
  /** reconcile_step: a submitted step read back from its original receipt, or an observed state the user accepts. */
  private async reconcileStep({input, actor, run}: PlanCall): Promise<JsonObject> {
    if (input.accept_observed !== undefined) {
      const ids = run.steps.map((x: JsonObject) => x.id),
        step = run.steps.find((x: JsonObject) => x.id === input.step_id);
      if (!step)
        bad(
          'step_id ' +
            JSON.stringify(String(input.step_id ?? '')) +
            ' is not in this plan. Its steps: ' +
            ids.join(', ') +
            '.',
          'INVALID_ARGUMENT',
          {field: 'step_id', allowed: ids},
        );
      const disagrees =
        step.kind === 'write' &&
        typeof step.review_id === 'string' &&
        (step.status === 'mismatch' ||
          (step.status === 'verifying' && ['mismatch', 'inconclusive'].includes(step.verification?.status)));
      if (!disagrees)
        bad(
          'Step ' +
            step.id +
            ' is ' +
            step.status +
            '. Only a written step whose read-back disagrees with what was sent can be accepted as observed.',
          'RECOVERY_NOT_SAFE',
          {step_id: step.id, status: step.status},
        );
      if (input.accept_observed !== true)
        bad('Set accept_observed: true once the user accepts the observed state.', 'INVALID_ARGUMENT', {
          field: 'accept_observed',
        });
      if (typeof input.actual_hash !== 'string')
        bad(
          'Send actual_hash: the observed state the user accepted (current.verification.actual_hash of step ' +
            step.id +
            ').',
          'INVALID_ARGUMENT',
          {field: 'actual_hash'},
        );
      if (this.claim(actor, step.review_id)?.state !== 'complete')
        bad('Step ' + step.id + ' has no completed receipt to accept.', 'RECOVERY_NOT_SAFE', {step_id: step.id});
      // Read it once more: the user accepts the state they saw, not whatever the provider holds by now.
      const v = await this.verifyWrite(actor, step.review_id);
      this.store.assertActorActive(actor);
      step.verification = v;
      if (v.status === 'verified') {
        step.status = 'verified';
        if (v.verified_resources) step.result = {...step.result, verified_resources: v.verified_resources};
      } else if (v.actual_hash !== input.actual_hash) {
        step.status = verificationStepStatus(v.status);
        run.state = planState(run, step);
        this.save(actor, run);
        throw new MirrorError(
          'STATE_CHANGED',
          'The provider’s state for step ' +
            step.id +
            ' changed since that diff: actual_hash is now ' +
            v.actual_hash +
            '. Show the user current.verification again before accepting.',
          {field: 'actual_hash', step_id: step.id, actual_hash: v.actual_hash ?? null},
          409,
        );
      } else {
        const changed = [...new Set(v.checks.flatMap((c: JsonObject) => c.changed_fields ?? []))];
        step.status = 'verified_with_acceptance';
        step.acceptance = {
          at: Date.now(),
          by: actor.userId,
          review_id: step.review_id,
          actual_hash: v.actual_hash,
          changed_fields: changed,
        };
        audit(this.store, actor, 'campaign_step_accepted', {
          id: run.id,
          step_id: step.id,
          review_id: step.review_id,
          actual_hash: v.actual_hash,
          changed_fields: changed,
        });
      }
      delete step.error;
      run.state = planState(run, step);
      run = this.save(actor, run);
      return this.respond(input, run, step.id, this.followUp(actor, run, step));
    }
    const step = run.steps.find((s: JsonObject) => s.id === input.step_id);
    if (
      !step?.review_id ||
      !['executing', 'uncertain', 'failed', 'verifying', 'mismatch', 'processing'].includes(step.status)
    )
      bad('Choose a submitted step requiring reconciliation.', 'RECOVERY_NOT_SAFE');
    const claim = this.claim(actor, step.review_id);
    if (claim?.state !== 'complete' || !claim.result)
      bad(
        'No completed original receipt exists. Inspect provider state; reconciliation never submits a mutation.',
        'RECOVERY_NOT_SAFE',
      );
    const receipt = JSON.parse(claim.result);
    if (step.kind === 'media') {
      const status = await this.call('amcp_media', {action: 'status', review_id: step.review_id}, actor);
      if (!status.success) throw new MirrorError(status.error.code, status.error.message, status.error.details);
      step.result = {...receipt, ...status.data};
      step.status = status.data.ready ? 'verified' : 'processing';
    } else {
      const verification = await this.verifyWrite(actor, step.review_id);
      step.result = receipt;
      step.verification = verification;
      step.status = verificationStepStatus(verification.status);
      if (step.status === 'verified' && verification.verified_resources)
        step.result = {...step.result, verified_resources: verification.verified_resources};
    }
    this.store.assertActorActive(actor);
    delete step.error;
    run.state = planState(run, step);
    run = this.save(actor, run);
    return this.respond(input, run, step.id, step.kind === 'write' ? this.followUp(actor, run, step) : {});
  }
  /** recover_step: an unsent step amended in place, its earlier attempts kept. */
  private recoverStep({input, actor, run}: PlanCall): JsonObject {
    const ids = run.steps.map((x: JsonObject) => x.id),
      step = run.steps.find((x: JsonObject) => x.id === input.step_id);
    if (!step)
      bad(
        'step_id ' +
          JSON.stringify(String(input.step_id ?? '')) +
          ' is not in this plan. Its steps: ' +
          ids.join(', ') +
          '.',
        'INVALID_ARGUMENT',
        {field: 'step_id', allowed: ids},
      );
    const blockedCheck =
      step.status === 'pending'
        ? run.preflight?.checks?.find((c: JsonObject) => c.step === step.id && c.status === 'blocked')
        : undefined;
    // Whether the step can be recovered comes first: asking to confirm a recovery that is refused anyway helps no one. A
    // step pending after the refusal of its review's state check provably never reached the provider (nothing was claimed
    // or sent), so it is amended like a failed step that did not (lead review S3-2).
    if (step.status !== 'failed' && !blockedCheck && !heldByStateCheck(step))
      bad(
        'Step ' +
          step.id +
          ' is ' +
          step.status +
          '. Only a step preflight blocked, one refused for a changed provider state, or one that failed before reaching the provider, can be amended; unknown, verifying and mismatched outcomes need investigation.',
        'RECOVERY_NOT_SAFE',
        {step_id: step.id, status: step.status},
      );
    // A key is retired, and the step amended under a new one, only when nothing of it was applied: a build Google
    // refused, a refusal the family proves non-applied (rejected), or an absence the user confirmed (CMP-04).
    const claim = this.claim(actor, step.review_id),
      retired = !claim
        ? undefined
        : rejectedBuild(step)
          ? 'rejected_build'
          : claim.state === 'rejected'
            ? 'rejected'
            : absenceConfirmed(step)
              ? 'confirmed_absent'
              : undefined;
    if (claim && !retired)
      bad(
        'Step ' +
          step.id +
          ' reached the provider or has an unknown outcome, so it is never sent again. Reconcile its existing resource; do not issue another create.',
        'RECOVERY_NOT_SAFE',
        {step_id: step.id, status: step.status},
      );
    const progressed = run.steps.find((x: JsonObject) => x.depends_on.includes(step.id) && x.status !== 'pending');
    if (progressed)
      bad(
        'Step ' +
          progressed.id +
          ', which depends on ' +
          step.id +
          ', has already progressed; ' +
          step.id +
          ' can no longer change.',
        'RECOVERY_NOT_SAFE',
        {step_id: step.id, dependant: progressed.id},
      );
    if (input.patch !== undefined && input.arguments !== undefined)
      bad('Send patch or arguments, not both.', 'INVALID_ARGUMENT', {field: 'patch'});
    if (blockedCheck && input.patch === undefined && input.arguments === undefined)
      bad(
        'Preflight blocked step ' +
          step.id +
          ': send the correction as patch or arguments (the refusal’s next_call shows the field). To re-check prerequisites that changed outside the plan, run preflight.',
        'INVALID_ARGUMENT',
        {field: 'patch'},
      );
    if (input.confirmed !== true)
      bad(
        'Set confirmed: true to amend step ' + step.id + '; it is prepared and reviewed again before anything is sent.',
        'INVALID_ARGUMENT',
        {field: 'confirmed'},
      );
    const attempt: JsonObject = {
      at: Date.now(),
      ...(step.review_id ? {review_id: step.review_id} : {}),
      ...(step.error ? {error: step.error} : {}),
      ...(blockedCheck?.error ? {preflight_error: blockedCheck.error} : {}),
    };
    const unamended = fingerprint(step.arguments);
    if (input.patch !== undefined) attempt.patch = applyPatch(step, input.patch);
    else if (input.arguments !== undefined) {
      if (blockedCheck && fingerprint(input.arguments) === fingerprint(step.arguments))
        bad(
          'The arguments are unchanged, so preflight would block step ' +
            step.id +
            ' again. Change what the refusal names.',
          'INVALID_ARGUMENT',
          {field: 'arguments'},
        );
      attempt.previous_arguments = step.arguments;
      step.arguments = input.arguments;
    }
    // R2.5 M3, dupstep round 2 (lead review S3-1): an amendment deletes the step's refusal, which is what holds it, and recomputes the plan
    // hash from the arguments, so one that changes nothing lifts the hold with the plan's approval standing over the same request, and the
    // next run executes the step: the second object the guard against creating twice exists to prevent, with no stop and no warning. A
    // step it holds is amended only to a different request (the earlier create is settled by its own call; a changed request is a new
    // create and the guard does not hold it back). Nothing was saved yet: the refusal leaves the step and the plan as they were.
    if (refusedByDuplicateGuard(step.error) && fingerprint(step.arguments) === unamended)
      bad(
        'Step ' +
          step.id +
          ' is held by the guard against creating twice (' +
          step.error.code +
          '), and this amendment changes nothing, so it would lift the hold with the plan approval standing over the same request. Change what the refusal names, or ' +
          (step.error.code === 'DUPLICATE_OF_COMPLETED_WRITE'
            ? 'prepare the step again (next_call): the new review carries the warning.'
            : 'settle the earlier create first (next_call).'),
        'INVALID_ARGUMENT',
        {
          field: input.arguments !== undefined ? 'arguments' : 'patch',
          ...(step.error.details?.next_call ? {next_call: step.error.details.next_call} : {}),
        },
      );
    noSecrets(step.arguments);
    // The step is not turned into the application of a secret-like value either (S1-2): the amended step is judged, as create judges a step.
    noSecretSteps(this.secretSteps?.(run.steps, new Set([String(step.id)])) ?? []);
    // A media step that now names another file (a replacement upload, MED-03 B) is prepared as a new review of that
    // file; the old bytes are never reused. A temporary replacement is acknowledged like one in a new plan, must
    // leave time to run, and moves the plan's run-by time.
    if (step.kind === 'media') {
      const a = step.arguments;
      if (
        (a.source_id !== undefined &&
          (typeof a.source_id !== 'string' || !/^(?:src|lib)-[0-9a-f-]{36}$/.test(a.source_id))) ||
        (a.expected_sha256 !== undefined &&
          (typeof a.expected_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.expected_sha256)))
      )
        bad(
          'Name the new file by its source_id (src-… or lib-…) and the exact file.sha256 its amcp_media plan returned.',
          'INVALID_ARGUMENT',
          {field: 'patch'},
        );
      const replaced = temporaryMediaSources(this.store, actor.tenantId, [step]);
      if (replaced.length && !run.temporary_sources && input.acknowledge_temporary_sources !== true)
        bad(
          'The replacement is a temporary file (source_id src-…), deleted 30 minutes after it started, so the plan must run before then. Send acknowledge_temporary_sources: true with this amendment.',
          'TEMPORARY_MEDIA_SOURCES',
          {temporary_sources: replaced, earliest_expires_at: earliestDeadline(replaced)},
        );
      assertRunnableSources(replaced);
      const temporary = temporaryMediaSources(
        this.store,
        actor.tenantId,
        run.steps.filter((s: JsonObject) => !settled(s)),
      );
      if (temporary.length)
        run.temporary_sources = {
          ...(run.temporary_sources ?? {acknowledged_by: actor.userId, acknowledged_at: Date.now()}),
          earliest_expires_at: earliestDeadline(temporary),
          sources: temporary,
        };
      else delete run.temporary_sources;
    }
    if (retired) {
      const status = step.error?.details?.http_status ?? null;
      if (retired === 'rejected_build') attempt.rejected_build = {http_status: status, key_retired: step.review_id};
      else attempt.key_retired = {reason: retired, review_id: step.review_id, http_status: status};
      if (retired === 'confirmed_absent') attempt.absence = step.absence;
      audit(this.store, actor, 'campaign_step_recovered_after_rejection', {
        id: run.id,
        step_id: step.id,
        review_id: step.review_id,
        http_status: status,
        reason: retired,
      });
    }
    // The review the step goes on from is retired by this plan (r25-field3-errors, the third re-review P2): it was never sent, and it is unexpired and
    // valid, so a direct execute of it would send what the amended step's own review sends again (and skip the plan's approvals). Retired before the
    // amendment is saved: a crash between the two leaves the step holding a review that cannot be executed, and recover_step again amends it.
    // A review that holds a claim now, which the check above did not find, was sent since (another process, the fourth check F2): the step is not unsent, and
    // is not amended.
    if (!this.retireStepReview(actor, run, step, 'amended') && !claim && this.claim(actor, step.review_id))
      bad(
        'Step ' +
          step.id +
          ' reached the provider or has an unknown outcome, so it is never sent again. Reconcile its existing resource; do not issue another create.',
        'RECOVERY_NOT_SAFE',
        {step_id: step.id, status: step.status},
      );
    step.previous_attempts = [...(step.previous_attempts ?? []), attempt].slice(-10);
    // `busy` too (R2.5 M3, dupstep): a wait for a twin still being sent concerned the request that was amended away.
    for (const k of [
      'review',
      'review_id',
      'resolved',
      'error',
      'result',
      'verification',
      'submission',
      'absence',
      'busy',
      // The stop a run made on that review's warning (item 7) belongs to the review that is gone.
      'duplicate_warning_shown_at',
      'duplicate_warning_shown_for',
    ])
      delete step[k];
    step.status = 'pending';
    run.state = 'draft';
    run.plan_hash = fingerprint(structure(run.steps));
    delete run.preflight;
    return this.respond(input, this.save(actor, run), step.id, {
      next_call: {tool: 'amcp_campaign', arguments: {action: 'prepare_next', id: run.id}},
    });
  }
  /**
   * A step whose review the provider rejected when it validated it at prepare (r25-field3-errors, M5-a). That review is never executed (its
   * execute is refused, PROVIDER_VALIDATION_FAILED, before anything is claimed), so the step does not wait for it as a ready review: it is failed
   * and unsent, with the refusal an execute would raise (built by the one function the execute uses, src/provider-validation.ts, so the words and
   * their Arabic are the same, and the provider's rows come with it), and the call it names is the step's correction. `run` stops at it as at any step
   * whose prepare failed. The step keeps its review and its ID, without the provider's whole answer. Undefined when the review's check is no rejection.
   */
  private stopRejectedReview(
    input: JsonObject,
    actor: Actor,
    run: JsonObject,
    step: JsonObject,
    review: JsonObject,
  ): JsonObject | undefined {
    const check = review.provider_check;
    if (check?.status !== 'provider_rejected') return undefined;
    const {response: _answer, ...kept} = check,
      error = errorResult(providerRejection(check, review.review_id), '', 0).error;
    delete step.busy;
    step.review_id = review.review_id;
    step.review = {...review, provider_check: kept};
    step.status = 'failed';
    step.error = error;
    step.submission = 'not_submitted';
    run.state = 'attention';
    return this.respond(
      input,
      this.save(actor, run),
      step.id,
      {blocked: true, next_call: amendmentCall(run.id, step, error)},
      {error},
    );
  }
  /** prepare_next: the native review of the next step, or the one still valid or executing. */
  private async prepareNext({input, actor, run, next}: StepCall): Promise<JsonObject> {
    if (
      next.status === 'executing' ||
      (next.status === 'review_ready' && Date.parse(next.review.expires_at) > Date.now())
    )
      this.assertReviewHolder(actor, run, next);
    if (run.allocation) await assertAllocationStep(this.store, this.call, actor, run, next);
    if (run.search_exclusions) await assertSearchExclusionStep(this.store, this.call, actor, run, next);
    if (run.gtm_consent) await consentBinding.check!(this.store, this.call, actor, run, next);
    // A selected-removal step is checked by its own native review against the bound product (COM-02 C), and the
    // review of a retirement step refuses a product the catalog does not have (COM-02 B).
    const removal = run.catalog_removal ? removalBinding.expectation!(run, next) : undefined,
      retiring = catalogRetirementOf(run, next);
    // A resumed or still-valid review keeps the acknowledgements it needs, so run asks for the same ones.
    if (next.status === 'executing') {
      // A call is executing the step now (r25-planmodel, M2, second round): it is read again, and run waits for it instead of resuming it.
      const claim = this.claim(actor, next.review_id);
      if (executionInFlight(next, claim)) {
        const offer = this.inFlightOffer(run, next, claim);
        return {
          campaign_id: run.id,
          step_id: next.id,
          recovery:
            'Step ' +
            next.id +
            ' is being executed by a call of this plan that has not ended. Nothing is prepared or executed again: read it again in a moment (next_call).',
          ...offer,
        };
      }
      return {
        campaign_id: run.id,
        step_id: next.id,
        recovery: 'Resume the original execution with the same idempotency key.',
        ...(next.review?.execute_requirements ? {execute_requirements: next.review.execute_requirements} : {}),
        next_call: {
          tool: 'amcp_campaign',
          arguments: {
            action: 'execute_next',
            id: run.id,
            review_id: next.review_id,
            idempotency_key: next.review_id,
            confirmed: true,
          },
        },
      };
    }
    if (next.status === 'review_ready' && Date.parse(next.review.expires_at) > Date.now())
      // A plan saved before this release can hold a ready review the provider rejected: it is stopped as a fresh one is (M5-a).
      return (
        this.stopRejectedReview(input, actor, run, next, next.review) ?? {
          ...(input.detail === 'full' ? {} : {view: 'compact'}),
          campaign_id: run.id,
          step_id: next.id,
          review: input.detail === 'full' ? next.review : reviewView(next.review, run.id, next.id),
          ...(next.review.execute_requirements ? {execute_requirements: next.review.execute_requirements} : {}),
          next_call: {
            tool: 'amcp_campaign',
            arguments: {
              action: 'execute_next',
              id: run.id,
              review_id: next.review_id,
              idempotency_key: next.review_id,
              confirmed: true,
            },
          },
        }
      );
    // A step whose review holds a claim is never prepared again (r25-field3-errors, the third follow-up's sweep; the same root as N1-b and N1-c): the review was
    // sent, or a part of its group was, and a new review of the same request would send it a second time. The step is pending, or its review expired, and
    // read nothing of the claim: a resume after a crash that an owner's pause refused (the step stays ready, which is right) and a pause that outlasts the
    // group's window reach it. It is read as a step whose outcome is not settled, and the plan says what it can do (stopped).
    if (typeof next.review_id === 'string' && this.claim(actor, next.review_id)) {
      next.status = 'uncertain';
      run.state = 'attention';
      return this.respond(input, this.save(actor, run), next.id, {blocked: true, ...this.stopped(actor, run, next)});
    }
    if (next.depends_on.some((id: string) => !settled(run.steps.find((s: JsonObject) => s.id === id))))
      bad('Wait for predecessor verification.', 'DEPENDENCY_PENDING');
    const results = new Map<string, JsonObject>(run.steps.filter(settled).map((s: JsonObject) => [s.id, s.result]));
    const resolved = references(next.arguments, results, new Set(next.depends_on));
    let prepared: JsonObject;
    // Native requests per step are recorded in the plan's journal metadata (COM-02 C), and so is the time each phase took (AMCP-12).
    const prepareCount = {reads: 0, writes: 0},
      prepareStarted = Date.now();
    if (next.kind === 'media')
      prepared = await meterNativeRequests(prepareCount, () =>
        this.call(
          'amcp_media',
          resolved.action === 'prepare_library'
            ? {action: 'prepare_library', review_id: resolved.review_id}
            : {...resolved, action: 'prepare', account_id: next.account_id, connection_id: next.connection_id},
          actor,
        ),
      );
    else {
      // DV360, Amazon and many delegated operations name the account with their own key and forbid account_id.
      if (this.acceptsAccountId(next.gateway, resolved.operation)) {
        if (resolved.operation) resolved.arguments = {...resolved.arguments, account_id: next.account_id};
        else Object.assign(resolved, {account_id: next.account_id});
      }
      // Each step keeps a reference to the provider contract: the whole one is a single amcp_tool_help call away
      // and would otherwise repeat 1.3-6.6 KB in every step of the run and its responses (F-29).
      const send = (supersedes?: string) =>
        this.call(
          'amcp_write',
          {
            action: 'prepare',
            gateway: next.gateway,
            connection_id: next.connection_id,
            arguments: resolved,
            evidence: 'ref',
            ...(supersedes ? {supersedes_review_id: supersedes} : {}),
          },
          actor,
        );
      // R2.5 r25-field-plan (the lead's re-review of dupstep, R-2): a step the guard held, because an earlier create of the actor's is uncertain,
      // is prepared as that create's replacement when its fresh reconciliation found it not applied (`replaceableTwin`), through the standalone
      // replacement's own argument and rules. Only a step already held: its replacement is then shown before it is sent, by the stop a run makes
      // at a held step prepared again, as the dupstep package made it. If the replacement is refused for any reason the guard's refusal stands.
      const held = refusedByDuplicateGuard(next.error);
      const prepare = async () => {
        const first = await send(),
          twin = held && !first.success ? this.replaceableTwin(actor, first.error) : undefined;
        if (!twin) return first;
        const replacement = await send(twin);
        return replacement.success ? replacement : first;
      };
      // R2.5 field3 (item 6): a prepare whose refusal names an object a verified earlier step of this plan created is read again after a short wait.
      const referenced = verifiedWriteValues(run, next, results),
        prepareAfterLag = () => prepareAfterReadLag(prepare, referenced);
      prepared = await meterNativeRequests(prepareCount, () =>
        removal
          ? removalBinding.under!(removal, prepareAfterLag)
          : retiring
            ? withCatalogRetirement(retiring, prepareAfterLag)
            : prepareAfterLag(),
      );
    }
    next.native_requests = addNativeRequests(next.native_requests, 'prepare', prepareCount);
    next.timing_ms = withTiming(next.timing_ms, 'prepare', Date.now() - prepareStarted);
    // The review read the selected product and it no longer matches its saved evidence: refused like before COM-02 C,
    // the step unchanged and nothing retained, and the remedy is a new removal preview.
    if (removal && !prepared.success && ['CATALOG_REMOVAL_CHANGED', 'STATE_NOT_FOUND'].includes(prepared.error?.code))
      removalBinding.changed!();
    if (!prepared.success && alreadyCurrent(next, prepared.error)) {
      // Nothing to change: recorded with the read evidence, and the plan moves on to its next step (COM-01).
      next.status = 'skipped_unchanged';
      next.submission = 'not_submitted';
      next.result = {
        already_current: true,
        evidence: prepared.error.details.no_op_evidence,
        checked_at: new Date().toISOString(),
      };
      delete next.error;
      run.state = planState(run, next);
      run = this.save(actor, run);
      // The next step is prepared under the same authority: a call run made under the plan's approval stays one, so
      // an approver collaborator is not refused after a skipped step (CMP-05).
      const following: JsonObject = {
        action: 'prepare_next',
        id: run.id,
        ...(input.detail ? {detail: input.detail} : {}),
      };
      return this.handle(this.underApproval.has(input) ? this.approved(following) : following, actor);
    }
    if (!prepared.success && next.kind === 'media' && mediaPrepareBusy(prepared.error)) {
      // Nothing was staged or sent, and the cause clears with time: the step stays pending (MED-03 B).
      const wait = busyWait(prepared.error);
      next.busy = {code: prepared.error.code, message: prepared.error.message, retry_after_ms: wait, at: Date.now()};
      run = this.save(actor, run);
      return this.respond(input, run, next.id, {
        busy: true,
        retry_after_ms: wait,
        next_call: {tool: 'amcp_campaign', arguments: {action: 'prepare_next', id: run.id}},
      });
    }
    // R2.5 M3 (dupstep): the guard against creating twice refused the prepare of a create identical to one that is uncertain or still being
    // sent. Nothing was prepared or sent, and the request is not wrong: the step waits for the earlier create to be settled, exactly as
    // when the same refusal meets it at execute (one rule, `holdDuplicate`). It used to end failed and blocked, with a recover_step
    // call, which sent an agent and the website to amend a request that needed nothing but the earlier create settled first.
    if (!prepared.success && next.kind !== 'media' && prepared.error?.code === 'DUPLICATE_OF_UNCERTAIN_WRITE') {
      if (duplicateOfExecuting(prepared.error)) {
        // A twin still being sent is not an obstacle yet and may never be one: the step waits for it as a busy target does (the media
        // branch above), pending, with the refusal on it so that nothing runs it unseen once the twin completes (`heldByStateCheck`).
        const wait = busyWait(prepared.error);
        next.error = heldDuplicate(run.id, prepared.error, this.earlierHolder(actor, prepared.error)).error;
        next.busy = {code: prepared.error.code, message: prepared.error.message, retry_after_ms: wait, at: Date.now()};
        run = this.save(actor, run);
        return this.respond(input, run, next.id, {
          busy: true,
          retry_after_ms: wait,
          next_call: {tool: 'amcp_campaign', arguments: {action: 'prepare_next', id: run.id}},
        });
      }
      const held = this.holdDuplicate(actor, run, next, prepared.error);
      return this.respond(input, held.run, next.id, {next_call: held.next_call});
    }
    if (!prepared.success) {
      next.status = 'failed';
      next.error = prepared.error;
      next.submission = 'not_submitted';
      run.state = 'attention';
      return this.respond(
        input,
        this.save(actor, run),
        next.id,
        {
          blocked: true,
          // An ownership refusal's own next call (the ownership read) comes first; the step is amended after it. Other
          // refusals that name a next call (a connection list, an inspect) need the step corrected, not retried.
          next_call:
            prepared.error?.code === 'RESOURCE_SCOPE_REQUIRED' && prepared.error?.details?.next_call
              ? {
                  ...prepared.error.details.next_call,
                  then: {
                    tool: 'amcp_campaign',
                    arguments: {action: 'recover_step', id: run.id, step_id: next.id, confirmed: true},
                  },
                }
              : prepared.error?.details?.read_delay
                ? // The step's arguments are not wrong: the same step is prepared again (R2.5 field3, item 6).
                  {
                    tool: 'amcp_campaign',
                    arguments: {action: 'recover_step', id: run.id, step_id: next.id, confirmed: true},
                    meaning:
                      'Nothing was sent. This prepares the same step again with no change to its arguments; the plan’s hash and approval stay.',
                  }
                : amendmentCall(run.id, next, prepared.error),
        },
        {error: prepared.error},
      );
    }
    const review = prepared.data;
    delete next.busy;
    // The refusal that sent this step back to pending (L5-04) concerned the review being replaced; the audit keeps it, and so does the attempt below.
    const heldRefusal = refusedByStateCheck(next.error) || refusedByDuplicateGuard(next.error) ? next.error : undefined;
    // The review this one replaces (r25-field3-errors, the third re-review P2, E2; the fourth check F1): a changed state or a duplicate hold sent the step back
    // to pending with the review it was refused for, which nothing sent and which can stay executable for its window. The plan goes on from it, so it is retired
    // and kept among the step's earlier attempts (as recover_step keeps the one it amends): a direct execute of it would otherwise send what the new review
    // sends, outside the plan, and outside the owner's approval where the policy is on. This comes before every other outcome of the new review: whether the
    // provider rejected it at validate-only (below) makes no difference to the review it replaces. Whether the replaced review can still be executed is
    // read from its documents and not from the step's copy of its window: a group's window ends before its parts' windows, and each part is a review of its
    // own. A single review whose window ended needs no retirement: nothing can execute it.
    const replaced = next.review_id;
    if (typeof replaced === 'string' && replaced !== review.review_id && this.executable(actor, replaced)) {
      if (this.retireStepReview(actor, run, next, 'replaced'))
        next.previous_attempts = [
          ...(next.previous_attempts ?? []),
          {
            at: Date.now(),
            review_id: replaced,
            replaced_by: review.review_id,
            ...(heldRefusal ? {error: heldRefusal} : {}),
          },
        ].slice(-10);
      else if (this.claim(actor, replaced)) {
        // Another call sent the review (or a part of its group) while this one prepared the new review: the step's outcome is not settled, and a new review of
        // the same request would send it twice. The review prepared meanwhile is the plan's and is not kept: it is retired, as the one it would have replaced.
        retireReview(this.store, actor.tenantId, review.review_id, {
          plan_id: run.id,
          step_id: next.id,
          reason: 'replaced',
        });
        next.status = 'uncertain';
        run.state = 'attention';
        return this.respond(input, this.save(actor, run), next.id, {blocked: true, ...this.stopped(actor, run, next)});
      }
    }
    // The provider rejected the request when it validated it (M5-a): the step stops here, with what the provider named, and no execute is offered.
    const stopped = this.stopRejectedReview(input, actor, run, next, review);
    if (stopped) return stopped;
    if (heldRefusal) delete next.error;
    // An expired review prepared again for the same request over unchanged state says so (WRT-05).
    if (
      typeof next.review?.fingerprint === 'string' &&
      next.review.review_id !== review.review_id &&
      next.review.fingerprint === review.fingerprint &&
      next.review.state_hash === review.state_hash
    )
      review.unchanged_since_review = next.review.review_id;
    if (review.reused === true) {
      next.result = review;
      next.status = 'verified';
      run.state = uploadsState(run, next);
      return this.respond(input, this.save(actor, run), next.id);
    }
    next.review_id = review.review_id;
    next.review = review;
    next.resolved = resolved;
    next.status = 'review_ready';
    run.state = 'awaiting_review';
    run = this.save(actor, run); // spend_change_confirmed is never pre-filled: execute_requirements says whether this step needs it, and the flag is the
    // user's acknowledgement of the reviewed spending effect, not a value to copy from a suggested call.
    return {
      ...(input.detail === 'full' ? {} : {view: 'compact'}),
      campaign_id: run.id,
      step_id: next.id,
      review: input.detail === 'full' ? review : reviewView(review, run.id, next.id),
      revision: run.revision,
      execute_requirements: review.execute_requirements,
      next_call: {
        tool: 'amcp_campaign',
        arguments: {
          action: 'execute_next',
          id: run.id,
          review_id: review.review_id,
          idempotency_key: review.idempotency_key,
          confirmed: true,
        },
        ...(review.execute_requirements?.spend_change_confirmed === true ||
        review.execute_requirements?.cap_override_confirmed === true ||
        review.execute_requirements?.creative_edit_confirmed === true ||
        review.execute_requirements?.destructive_confirmed === true
          ? {
              add_after_user_approval: {
                ...(review.execute_requirements.spend_change_confirmed === true ? {spend_change_confirmed: true} : {}),
                ...(review.execute_requirements.cap_override_confirmed === true ? {cap_override_confirmed: true} : {}),
                ...(review.execute_requirements.creative_edit_confirmed === true
                  ? {creative_edit_confirmed: true}
                  : {}),
                ...(review.execute_requirements.destructive_confirmed === true ? {destructive_confirmed: true} : {}),
              },
            }
          : {}),
        // A deletion, a live publish or stopped delivery is shown to the user before execute_next (WRT-05).
        ...(review.execute_requirements?.effects
          ? {
              disclose: (review.execute_requirements.reasons ?? []).filter((r: JsonObject) => r.effect),
            }
          : {}),
      },
    };
  }
  /**
   * The answer of a call that found the step it was to execute being executed by another call, and was refused without sending anything (M2, second round): the plan as it is,
   * and the read that says when that call has ended (`resumeOffer`). Nothing is saved.
   */
  private stillExecuting(
    input: JsonObject,
    actor: Actor,
    planId: string,
    stepId: string,
    error: JsonObject | undefined,
  ) {
    const plan = this.owned(actor, planId);
    return this.respond(input, plan, stepId, {
      notice:
        'Step ' +
        stepId +
        ' is being executed by another call of this plan, so this call changed nothing (' +
        String(error?.code ?? 'refused') +
        '). Read the step again in a moment; never execute it twice.',
      ...this.resumeOffer(
        actor,
        plan,
        plan.steps.find((s: JsonObject) => s.id === stepId),
      ),
    });
  }
  /** execute_next: the exact review prepared for the next step, executed and read back. */
  private async executeNext({input, actor, run, next}: StepCall): Promise<JsonObject> {
    // A write group that stopped part-way (every part that was sent applied) is resumed here too (the third re-review P4): the parts not sent are sent, and
    // the applied ones replay.
    const resuming = ['uncertain', 'failed'].includes(next.status) && this.resumableGroup(actor, next)?.open === true;
    if (
      (next.status !== 'review_ready' && next.status !== 'executing' && !resuming) ||
      input.review_id !== next.review_id ||
      (input.idempotency_key ?? next.review_id) !== next.review_id ||
      input.confirmed !== true
    )
      bad('Execute the exact returned review with confirmation.');
    this.assertReviewHolder(actor, run, next);
    // A step a crash left executing resumes under the decision already made; a new execution, and the resume of a stopped group, which sends what was never
    // sent, need the second person.
    if (next.status !== 'executing') this.assertDistinctApproval(actor, run);
    // Persist the review reference before egress. A crash resumes with the same native idempotency key.
    if (run.allocation) await assertAllocationStep(this.store, this.call, actor, run, next);
    if (run.search_exclusions) await assertSearchExclusionStep(this.store, this.call, actor, run, next);
    if (run.gtm_consent) await consentBinding.check!(this.store, this.call, actor, run, next);
    const removal = run.catalog_removal ? removalBinding.expectation!(run, next) : undefined,
      retiring = catalogRetirementOf(run, next),
      before = {status: next.status, state: run.state};
    // A call is executing this step now (r25-planmodel, M2, second round): this call is a second one, and it saves nothing before it sends nothing: the step is already
    // executing, and the stamp is the first call's. A refusal that sent nothing is not that step's outcome (below); anything else the execute does it does by the claims.
    const resumedInFlight = next.status === 'executing' && executionInFlight(next, this.claim(actor, next.review_id));
    if (!resumedInFlight) {
      next.status = 'executing';
      // When this execute began (r25-planmodel, M1 and M2, second round): the stamp tells a reader whether a call is executing the step now, and tells this call, when it ends,
      // whether the step is still the one it executed. Each execute of a step stamps it later than the one before, to the millisecond.
      next.executing_at = Math.max(Date.now(), Number(next.executing_at ?? 0) + 1);
      run.state = 'in_progress';
      run = this.save(actor, run);
    }
    const step = run.steps.find((s: JsonObject) => s.id === next.id)!,
      // The step and the plan's state as they were saved: what this call changes after it awaits the provider is saved onto the plan as it is then (`saveSettled`).
      saved = {step: structuredClone(step), state: run.state as string};
    const execute = () =>
        this.call(
          'amcp_write',
          {
            action: 'execute',
            review_id: step.review_id,
            idempotency_key: step.review_id,
            confirmed: true,
            ...(step.kind === 'write'
              ? {
                  spend_change_confirmed: input.spend_change_confirmed,
                  cap_override_confirmed: input.cap_override_confirmed,
                  creative_edit_confirmed: input.creative_edit_confirmed,
                  destructive_confirmed: input.destructive_confirmed,
                }
              : {}),
          },
          actor,
        ),
      executeCount = {reads: 0, writes: 0},
      executeStarted = Date.now();
    const result = await meterNativeRequests(executeCount, () =>
      removal
        ? removalBinding.under!(removal, execute)
        : retiring
          ? withCatalogRetirement(retiring, execute)
          : execute(),
    );
    step.native_requests = addNativeRequests(step.native_requests, 'execute', executeCount);
    step.timing_ms = withTiming(step.timing_ms, 'execute', Date.now() - executeStarted);
    // The person's access ended while the request was in flight (M5, second round): the outcome is saved first, and the refusal is the answer. The step was left executing for good
    // when the check came before the save, with the change applied and its claim complete. No read-back is made for the person (it is a request on their connection): the step
    // reads verifying, and the plan reads it again for whoever acts on it next.
    let inactive: unknown;
    try {
      this.store.assertActorActive(actor);
    } catch (e) {
      inactive = e;
    }
    const finish = <T>(done: T): T => {
      if (inactive) throw inactive;
      return done;
    };
    // The plan went on from this review while the execute waited (the fourth check F2: it was cancelled; a review that waits is retired by whatever goes on from
    // it): the execute was refused when it came to claim the review, and nothing was sent. That call saved the plan with its step as it stands, and this call's copy
    // of the plan is stale, so nothing is saved from it: the refusal is the answer, the same one an execute of the retired review always gets.
    // When nobody saved the plan (the retirement's save failed, or the process died after the marks were written), the plan still shows the step executing for a review
    // that nothing sent and nothing will send, and no read named a way out (r25-planmodel, F1): the step goes back to what it was before this call, ready, and the plan to
    // the state it had. A call that keeps losing the race to other saves leaves the refusal as the answer.
    if (!result.success && result.error?.code === 'REVIEW_RETIRED') {
      try {
        // Only the step this call executed (M7, second round): an amended review, or another execute of the step, is not this call's to put back.
        this.settle(actor, run.id, step.id, (plan, target) => {
          if (!sameExecution(target, saved.step)) return false;
          target.status = before.status === 'executing' ? 'review_ready' : before.status;
          delete target.executing_at;
          if (plan.state === 'in_progress') plan.state = before.state;
          return true;
        });
      } catch (e) {
        if (!(e instanceof MirrorError && e.code === 'REVISION_CONFLICT')) throw e;
      }
      const given = result.error.details ?? {};
      retiredRefusal(
        {plan_id: given.plan_id, step_id: given.step_id, reason: given.reason},
        String(given.review_id ?? step.review_id),
      );
    }
    // A selected-removal step whose product changed since its review is refused before anything is claimed or sent
    // (COM-02 C): the step keeps its review as it did when a separate comparison refused it, and the remedy is a new
    // removal preview.
    if (removal && !result.success && ['STATE_CHANGED', 'CATALOG_REMOVAL_CHANGED'].includes(result.error?.code)) {
      this.settle(actor, run.id, step.id, (plan, target) => {
        if (!sameExecution(target, saved.step)) return false;
        target.status = before.status;
        delete target.executing_at;
        if (livePlanStates.includes(plan.state)) plan.state = before.state;
        return true;
      });
      removalBinding.changed!();
    }
    // A second call of an execution in flight (M2, second round) that was refused without sending anything changes nothing: the refusal says nothing of the step the first call
    // is executing (busy because it holds the target, or uncertain because its request is going out, or a flag of this call's own), and saving it as the step's outcome put a
    // healthy write out of the plan's sight (the step read uncertain, or ready again, while its request was still being sent).
    if (resumedInFlight && !result.success) {
      const claim = this.claim(actor, step.review_id),
        {status, unsent} = refusalOutcome(result.error);
      if (
        unsentStateChange(result.error, claim) ||
        (unsentDuplicate(result.error, claim) && !duplicateOfExecuting(result.error)) ||
        ['review_ready', 'pending'].includes(status) ||
        (status === 'failed' && unsent) ||
        (result.error?.code === 'WRITE_OUTCOME_UNCERTAIN' &&
          claim?.state === 'pending' &&
          Date.now() - Number(claim.created_at) < pendingUncertainMs)
      )
        return finish(this.stillExecuting(input, actor, run.id, step.id, result.error));
    }
    // R25 M1 (L5-04): a review whose provider state changed since it was prepared is refused before anything is claimed or
    // sent, so the step is not failed and needs no recover_step. It goes back to pending with what changed
    // (`changed_fields`, `material`, `recurring_paths`) and the call that prepares it again, which is the plan's own:
    // the standalone prepare the write's refusal names would prepare a review that no step holds. Only the refusal of the
    // review's own check qualifies, and only while no claim exists for the review: a STATE_CHANGED of any other kind keeps
    // the outcome it had, since nothing proves it unsent. The check is as strict as before: this step is not executed
    // again until the agent and the user prepare it again (see run, which stops here).
    if (!result.success && unsentStateChange(result.error, this.claim(actor, step.review_id))) {
      const again = {tool: 'amcp_campaign', arguments: {action: 'prepare_next', id: run.id}};
      step.error = {...result.error, details: {...result.error.details, next_call: again}};
      step.status = 'pending';
      run.state = 'attention';
      return this.respond(input, finish(this.saveSettled(actor, run, step.id, saved, 'unsent')), step.id, {
        next_call: again,
      });
    }
    // R2.5 M2 (lead re-review N7): the guard against creating twice refused the review before anything was claimed. The step goes back
    // to pending as for a changed state, with the plan's own prepare_next: the standalone prepare the refusal names would prepare a
    // review that no step holds. The call that settles the earlier create stays in the refusal (`earlier_next_call`). A duplicate of a
    // create that is still being sent waits instead (below), as a busy target does. The step is held by the one rule that prepare_next
    // uses for the same refusal (R2.5 M3, dupstep: `holdDuplicate`).
    if (
      !result.success &&
      unsentDuplicate(result.error, this.claim(actor, step.review_id)) &&
      !duplicateOfExecuting(result.error)
    ) {
      const held = this.holdDuplicate(actor, run, step, result.error, copy =>
        finish(this.saveSettled(actor, copy, step.id, saved, 'unsent')),
      );
      return this.respond(input, held.run, step.id, {next_call: held.next_call});
    }
    if (!result.success) {
      step.error = result.error; // An expired review was refused before anything was sent: prepare_next prepares it again.
      // A refusal that sent nothing released its claim (WRT-04): a pause, rate limit, open circuit or busy target clears
      // on its own, so the same review is executed again; anything else is amended like any unsent step.
      const {status, unsent} = refusalOutcome(result.error);
      step.status = status;
      if (step.status === 'failed' && unsent) step.submission = 'not_submitted';
      // Refused without applying it (CMP-04): the key is retired, and the step is amended under a new one.
      if (step.status === 'failed' && result.error?.details?.submission === 'rejected') step.submission = 'rejected';
      run.state = 'attention';
      // A step that was not sent (ready or pending again, or failed before the provider) is the outcome of the execution that made it; a step the request may have reached is
      // the outcome of the review, whichever call saved the step meanwhile (`saveSettled`).
      const nothingSent = ['review_ready', 'pending'].includes(step.status) || (step.status === 'failed' && unsent);
      return this.respond(
        input,
        finish(this.saveSettled(actor, run, step.id, saved, nothingSent ? 'unsent' : 'sent')),
        step.id,
      );
    }
    delete step.error;
    step.result = result.data;
    step.status = step.kind === 'media' ? (result.data.ready ? 'verified' : 'processing') : 'verifying';
    if (step.kind === 'write' && !inactive) {
      const verifyCount = {reads: 0, writes: 0},
        verifyStarted = Date.now();
      step.verification = await meterNativeRequests(verifyCount, () => this.verifyWrite(actor, step.review_id));
      step.native_requests = addNativeRequests(step.native_requests, 'verify', verifyCount);
      step.timing_ms = withTiming(step.timing_ms, 'verify', Date.now() - verifyStarted);
      step.status = verificationStepStatus(step.verification.status);
      if (step.status === 'verified' && step.verification.verified_resources)
        step.result = {...step.result, verified_resources: step.verification.verified_resources};
    }
    run.state = uploadsState(run, step);
    run = finish(this.saveSettled(actor, run, step.id, saved, 'applied'));
    return this.respond(
      input,
      run,
      step.id,
      step.kind === 'write'
        ? this.followUp(actor, run, step)
        : {
            next_call:
              run.state === 'complete'
                ? null
                : {tool: 'amcp_campaign', arguments: {action: 'prepare_next', id: run.id}},
          },
      {
        receipt: {
          verified: run.steps
            .filter((s: JsonObject) => settled(s) && s.status !== 'skipped_unchanged')
            .map((s: JsonObject) => s.id),
          // Steps whose target already held every value; nothing was sent for them (COM-01).
          ...(run.steps.some((s: JsonObject) => s.status === 'skipped_unchanged')
            ? {
                skipped_unchanged: run.steps
                  .filter((s: JsonObject) => s.status === 'skipped_unchanged')
                  .map((s: JsonObject) => s.id),
              }
            : {}),
          remaining: run.steps
            .filter((s: JsonObject) => !settled(s))
            .map((s: JsonObject) => ({id: s.id, status: s.status})),
        },
      },
    );
  }
}
