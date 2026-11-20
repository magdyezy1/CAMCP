import {recipeContext, recipeInputs, resolveBrief} from './recipe-context.js';
import {eligibilityReuse, recipeEligibility} from './recipe-eligibility.js';
import {assertAllocationStep, allocationCreationBinding} from './allocation-plan.js';
import {scheduleAllocationOutcomeQuietly} from './allocation-outcome.js';
import {catalogLineageCreationBinding, catalogRetirementCreationBinding} from './catalog-lineage.js';
import {catalogRetirementOf, withCatalogRetirement} from './catalog-retirement.js';
import {addNativeRequests, meterNativeRequests} from './native-request-meter.js';
import {
  assertSearchExclusionStep,
  assertNewSearchExclusionDraft,
  searchExclusionCreationBinding,
} from './search-exclusion-plan.js';
import {expandTemplate as substitute} from './client-playbooks.js';
import {assertAccountWrite} from './write-access.js';
import {workspaceOwner} from './spend-policy.js';
import {normalizeAccount} from './scope.js';
import {assertRecipeDraftCurrent, campaignRecipe, campaignRecipes, recipeMissing} from './campaign-recipes.js';
import {verificationContractVersion} from './verification-reads.js';
import {randomUUID} from 'node:crypto';
import {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {ownership, ownsRecord, principalOf} from './actor-identity.js';
import {reconciliationFreshMs, supersededBy} from './write-records.js';
import {
  MirrorError,
  errorRemedy,
  refusedBeforeSending,
  refusedByDuplicateGuard,
  refusedByStateCheck,
} from './errors.js';
import {amendmentCall, applyPatch} from './campaign-amendment.js';
import {applyCloneChanges, assertCloneGateway, clonePlan, dropClosure} from './campaign-clone.js';
// A clone's all-or-nothing build is its provider's (ARC-01 phase B, wave 4c: Google's `campaign.clone.allOrNothing`),
// and so are a refused build that created nothing (`campaign.refusedBuild`) and the recipe lookups (`campaign.lookups`).
import {providerHooks, registeredProviderHooks} from './provider-hooks.js';
import type {CampaignPlanBinding, RecipeLookup} from './provider-adapter.js';
import {compactPlan, preflightView, reviewView} from './campaign-view.js';
import {approvalMoney, approvalSpends, approvalStep, approvalSummary} from './plan-approval.js';
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
  field,
  fingerprint,
  noSecrets,
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
import {correctedStep, createHelpCall, stepShape, topLevelMoves} from './campaign-step-help.js';
import {visibleProfile} from './client-scope.js';
import {actionHandler, type ActionTable, type ToolContext} from './tool-actions.js';
export const campaignTool = tool(
  'amcp_campaign',
  'Use this for a launch whose later steps need IDs that earlier steps create (campaign, then ad set, then ad); for one change use amcp_write. Create a durable campaign dependency plan from a brief and explicit native steps. Apply approved profiles/templates. recipe_eligibility checks the current business brief without saving a plan: local by default; live:true adds exact read-only account prerequisites. The four Google conversion Search recipes inspect current account-default goals and enabled explicit primary actions in a selected client using its own conversion customer; shared tracking stays unknown. Google Search with Maximize Conversion Value and Google Search with a target ROAS explicitly choose ACCOUNT_RECORDED_VALUES, leave goal and value settings unchanged and save a paused parent with a dedicated budget. target_roas is decimal ratio text from 0.01 to 1000 (3.5 means 350%), compiled to the native double; delivered values, conversion history, eligibility and actual return remain unverified. For the two value-bidding recipes, live eligibility also selects current default value, conversion currency and event-value override settings for the same matching primary actions. It also reads the last reported conversion date and last tag-detection time twice in the native account timezone. These optional aggregate dates remain unknown when absent; tag detection may have no attributable conversion, and no event-level records are read. Optional missing settings stay unknown; configuration does not prove received event values. Pending plans reread retired conversion-value proofs through their original accepted receipts before approval or advancing; completed historical runs are not replayed. The Snapchat website traffic recipe reuses an existing WEB_VIEW creative and saves three paused steps with an explicit AUTO_BID/SWIPES budget and offset schedule. Read-only preflight checks its selected-account ownership, creative type and original HTTPS destination syntax; advertising approval and destination availability remain unverified. The Snapchat lead-generation recipe reuses an existing LEAD_GENERATION creative and its original account-owned form, with an explicit SWIPES or LEAD_FORM_SUBMISSIONS goal. Preflight and native review inspect both definitions; no submitted leads are read, and provider eligibility, privacy and consent acceptance remain unverified. Readers can inspect these settings while existing write blockers remain active. Configuration does not prove event delivery, objective acceptance or write approval. prepare_next resolves only verified predecessor outputs and returns the existing native review; execute_next consumes that exact review, automatically reads back the result, and resumes without duplicate writes. Responses are compact: one row per step with its resource IDs, and the step the call acted on; get with step_id returns one step whole, and detail:"full" the whole plan. A step preflight blocked, or one that failed before reaching the provider, is amended in place with recover_step (patch one field, or send corrected arguments), following the next_call its refusal carries; nothing is sent until its new review. A step the provider refused without applying it (a Google request refused outright) is amended the same way under a new key; for a refusal AMCP cannot prove applied nothing (Meta), confirm_absent reads whether a resource of that name exists and, once the user confirms it does not, allows recover_step. continue_as_new {id, confirmed} carries the steps still to write into a new linked plan, adopting verified predecessors’ IDs with their provenance; the original plan becomes superseded. activation_plan {id} on a completed recipe plan creates a separate linked draft that activates its paused launch (Meta, Google: the campaign; Snapchat: campaign, ad squad, ad in order; Microsoft: refused without a positive location criterion), with its own approval and read-only gates at preflight. list returns compact rows newest first (accounts and platforms per plan), filtered by state, archived, gateway, account_id, connection_id, profile_id, search or awaiting_approval, continued with next_cursor. archive {id, confirmed} sets aside a complete, cancelled or superseded plan: get still returns it, the default list and the 500-plan limit leave it out; unarchive restores it. The plan’s owner or an administrator can assign {id, user_id, role} a workspace member as viewer (read), editor (prepare, run steps, amend, archive) or approver (approve and run); assign {id} lists members, unassign removes one; collaborators see a plan only within their current account access and every write still checks the acting person’s own grant. When the owner requires a distinct approver, a plan that changes spending or activates a launch cannot be approved by its own owner, and its steps execute only under another person’s current approval. To approve a whole plan once: approve returns what the approval covers (every step’s action, account, money and status fields, a large step aggregated with truncated: true; approve with its step_id lists every field); approve with confirmed, that plan_hash and its summary_hash records it; run then prepares and executes every step under it, each still a frozen, read-back review, and stops for anything that needs a person. run_background queues an approved plan whose steps are all media uploads to run on the server: leaving the page or client does not stop it, get shows its progress, and in a plan of independent uploads one failed upload does not hold the others. clone reads an existing Snapchat, Google Search, TikTok or LinkedIn campaign (source.campaign_id; a LinkedIn campaign group) into a new draft plan under a new name, with changes applied (set a field, drop a step); a Google copy is one all-or-nothing step (atomic: false for one step per resource type); the new campaign starts PAUSED and nothing is sent until the plan is reviewed or approved. create, create_from_recipe and clone accept an optional stable idempotency_key (8–100 letters, digits, hyphens or underscores); identical creation input reuses the original plan, while different input conflicts. Recipe and clone steps are saved literally; {{variable}} substitution applies only to the explicit and template steps of create. Allocation preview handoffs bind their exact source and budget ownership to the draft; stale source, changed ownership or amended proposal targets require a fresh preview. Search-exclusion preview handoffs similarly preserve exact retained terms and original ad groups; changed source or target arguments require a new preview. Accepted and uncertain receipts retain their original recovery. No fabricated IDs, implicit launch, or review bypass.',
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
    if (at < 1 || !deps.has(id)) bad('A result reference must name a declared predecessor.');
    const result = results.get(id);
    if (!result) bad('The referenced step is not verified.', 'DEPENDENCY_PENDING');
    const value = structuredClone(pointer(result, path));
    if (prefix === undefined) return value;
    if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9][0-9]{0,19}$/.test(String(value)))
      bad('The referenced value is not a numeric ID, so it cannot become a ' + prefix + ' URN.', 'INVALID_REFERENCE');
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
 */
const spendStop = (
  run: JsonObject,
  current: JsonObject,
  prepared: JsonObject,
): {view: JsonObject; reason: string; extra?: JsonObject} => {
  const approval = run.approval,
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
            id: run.id,
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
    /**
     * The spend effect of each write step of a plan, by step ID (R2.5 r25-field-plan, src/campaign-spend-effects.ts): whether its review will
     * ask execute for spend_change_confirmed, decided by compiling it locally. Absent, the approval names no spend effect and offers the
     * flag by money fields alone, as before.
     */
    private spendEffects?: (steps: JsonObject[]) => ReadonlyMap<string, boolean>,
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
  private save(actor: Actor, run: JsonObject) {
    const {id, revision, ...data} = run;
    this.store.putDocument(actor.tenantId, 'campaign_run', id, {...data, updated_at: Date.now()}, revision);
    const saved = this.owned(actor, id);
    // DEC-02: a completed allocation plan whose every step was verified schedules its outcome review (idempotent).
    if (saved.allocation && saved.state === 'complete') scheduleAllocationOutcomeQuietly(this.store, actor, saved);
    return saved;
  }
  /** The idempotency claim of a submitted step, if its review ever reached execution. */
  private claim(actor: Actor, reviewId: unknown): JsonObject | undefined {
    return typeof reviewId === 'string'
      ? (this.store.db
          .prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?')
          .get(actor.tenantId, reviewId) as JsonObject | undefined)
      : undefined;
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
  ): {run: JsonObject; next_call: JsonObject} {
    const held = heldDuplicate(run.id, error, this.earlierHolder(actor, error));
    step.error = held.error;
    step.status = 'pending';
    // A wait for a twin that was still being sent ends here: it turned out unresolved, and the plan says what settles it.
    delete step.busy;
    run.state = 'attention';
    return {run: this.save(actor, run), next_call: held.next_call};
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
    return {
      recovery:
        'Step ' +
        step.id +
        ' reached the provider and its outcome is not confirmed, so AMCP never sends it again.' +
        (claim?.state === 'complete'
          ? ' reconcile_step reads the resource back from its original receipt (next_call).'
          : step.kind === 'write' && claim
            ? ' No completed receipt exists: reconcile it with read-only provider lookups (next_call, WRT-08). Once the user accepts it as applied, reconcile_step reads it back and dependent steps continue. Steps already verified stay.'
            : ' No completed receipt exists: check in the provider whether the resource exists. Steps already verified stay; anything still to be written needs a new plan.'),
      next_call:
        claim?.state === 'complete'
          ? {tool: 'amcp_campaign', arguments: {action: 'reconcile_step', id: run.id, step_id: step.id}}
          : step.kind === 'write' && claim
            ? {tool: 'amcp_write', arguments: {action: 'reconcile', review_id: step.review_id}}
            : null,
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
   */
  private approve(input: JsonObject, actor: Actor, run: JsonObject): JsonObject {
    const summary = approvalSummary(run, this.spendEffectsOf(run)),
      spending = approvalSpends(summary),
      // Maker-checker (CMP-05, owner policy, off by default): a plan that changes spending or activates a launch is
      // approved by someone other than its owner. It reads the money fields, as it always has: the spend effects widen what the
      // approval offers, not who may give it.
      checker = this.needsDistinctApprover(actor, run, approvalMoney(summary)) && ownsRecord(actor, run);
    if (input.confirmed !== true && typeof input.step_id === 'string') {
      const fields = approvalStep(run, input.step_id);
      if (!fields) bad('Name a step of this plan.', 'INVALID_ARGUMENT', {field: 'step_id'});
      return {id: run.id, plan_hash: run.plan_hash, summary_hash: summary.summary_hash, ...fields};
    }
    const distinct = distinctApproverCall(run);
    if (input.confirmed !== true && checker)
      return compactPlan(run, undefined, {
        approval: summary,
        summary_hash: summary.summary_hash,
        approver_required: true,
        notice:
          'This workspace requires someone other than the plan’s owner to approve a plan that changes spending or activates a launch. Assign an approver; they approve and run it.',
        next_call: distinct,
      });
    if (input.confirmed !== true)
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
    if (input.plan_hash !== run.plan_hash)
      bad(
        'plan_hash does not match: the plan changed since that summary. Show the user the current summary (approve without confirmed).',
        'PLAN_CHANGED',
        {field: 'plan_hash', plan_hash: run.plan_hash},
      );
    if (summaryHashRequired() && input.summary_hash !== summary.summary_hash)
      bad(
        input.summary_hash === undefined
          ? 'summary_hash is required: approve with the summary_hash of the summary the user was shown (approve without confirmed returns it).'
          : 'summary_hash does not match the current summary. Show the user the current summary (approve without confirmed) and approve that.',
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
   * What the local compile says of each write step's spend effect, for the approval summary (R2.5 r25-field-plan); undefined where this
   * runner has no compile. A compile that fails altogether names no step, and a write step the summary finds unnamed counts as spending.
   */
  private spendEffectsOf(run: JsonObject): ReadonlyMap<string, boolean> | undefined {
    if (!this.spendEffects) return undefined;
    try {
      return this.spendEffects(run.steps);
    } catch {
      return new Map();
    }
  }
  /**
   * Whether the owner's distinct-approver policy (CMP-05, off by default) governs this plan: it is on, and the plan
   * changes spending or activates a launch.
   */
  private needsDistinctApprover(actor: Actor, run: JsonObject, spending?: boolean): boolean {
    if (planPolicy(this.store, actor.tenantId).require_distinct_approver !== true) return false;
    return !!run.activation_of || (spending ?? approvalSpends(approvalSummary(run)));
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
        'This plan has no current approval. Show the user the summary (approve), then approve it with confirmed: true.',
        'APPROVAL_REQUIRED',
        {next_call: {tool: 'amcp_campaign', arguments: {action: 'approve', id: run.id}}},
      );
    // The plan follows its person across their connections (MCP-02); an approval, like a review, stays with the
    // connection that recorded it. The administrator exemption is unchanged.
    if (run.approval.by !== actor.userId && actor.role !== 'admin')
      bad(
        'This plan was approved from another connection. Show the user the summary here (approve), then approve it with confirmed: true.',
        'APPROVAL_REQUIRED',
        {next_call: {tool: 'amcp_campaign', arguments: {action: 'approve', id: run.id}}},
      );
  }
  /**
   * Runs an approved plan: each step is prepared (a frozen review of the state it reads) and executed under the
   * plan's approval, then read back, exactly as prepare_next and execute_next do one at a time. It stops for anything
   * that needs a person: a spending acknowledgement the approval did not give, an owner cap override, a creative
   * edit, a failure, a mismatch, or a read-back still settling. It also stops after about 25 seconds so a response
   * always arrives; run again to continue. Nothing is rolled back: steps already done stay, as created (paused).
   */
  private async runApproved(input: JsonObject, actor: Actor, run: JsonObject): Promise<JsonObject> {
    this.assertApproval(actor, run);
    const started = Date.now(),
      executed: string[] = [];
    const stop = (view: JsonObject, reason: string, extra: JsonObject = {}) => ({
      ...view,
      run: {executed, stopped: reason, ...extra},
    });
    // In a plan of independent uploads (a creative push) one failed, uncertain or processing upload holds none of the
    // others: run moves every upload it can, then stops for the rest (MED-03 B). Other plans stop at the first one.
    const uploads = independentUploads(run);
    // R25 M1 (L5-04): the last execute of this call that a refusal of the state check sent back to pending. In a push of
    // independent uploads the other uploads move first, and the run stops with it once nothing else can.
    let refusedHere: JsonObject | undefined;
    for (let i = 0; i < run.steps.length * 3 + 3; i++) {
      if (Date.now() - started > 25000)
        return stop(this.respond({}, this.owned(actor, run.id)), 'time', {
          next_call: {tool: 'amcp_campaign', arguments: {action: 'run', id: run.id}},
        });
      // The steps a refusal of the state check sent back to pending, in this call or in an earlier one.
      const current = this.owned(actor, run.id),
        held = new Map<string, JsonObject>(
          current.steps.filter(heldByStateCheck).map((s: JsonObject) => [s.id, s.error] as [string, JsonObject]),
        );
      if (uploads && refusedHere && held.size && !nextUpload(current))
        return stop(refusedHere, 'state_changed', {
          reason: stateChangedReason([...held.keys()][0], false),
          next_call: {tool: 'amcp_campaign', arguments: {action: 'prepare_next', id: run.id}},
        });
      const ask: JsonObject = this.approved({action: 'prepare_next', id: run.id});
      if (uploads) this.pastStopped.add(ask);
      const prepared = await this.handle(ask, actor);
      // A step a crash or restart left executing resumes under its original review and key (CMP-02 c). The same-key
      // claim replays a completed receipt and refuses a pending or uncertain one without sending it again.
      const resume =
        !prepared.review && prepared.next_call?.arguments?.action === 'execute_next'
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
        return stop(view, view.blocked ? 'needs_attention' : 'waiting');
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
              needs.spend_change_confirmed && !approvalCoversSpend(run.approval, prepared.step_id)
              ? 'spend_change_confirmed'
              : undefined;
      if (human) {
        const spend = human === 'spend_change_confirmed' ? spendStop(run, current, prepared) : undefined;
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
      executed.push(prepared.step_id);
      if (out.state === 'complete') return stop(out, 'complete');
      const step = out.steps?.find((s: JsonObject) => s.id === prepared.step_id);
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
    const claimed = this.store.db
      .prepare('SELECT created_at FROM idempotency WHERE tenant_id=? AND key=?')
      .get(actor.tenantId, step.review_id) as {created_at: number};
    const probe = await probeAbsence(this.call, actor, step, Number(claimed.created_at));
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
        next_call: {tool: 'amcp_campaign', arguments: {action: 'approve', id: next.id}},
      });
    }
    // A step found already current (COM-01) sent nothing and resolved no value to adopt: it is carried and prepared
    // again in the new plan, so a reference into it never resolves to an empty result.
    const adoptable = (s: JsonObject) => settled(s) && s.status !== 'skipped_unchanged',
      carried = run.steps.filter((s: JsonObject) => !adoptable(s));
    if (!carried.length) bad('Every step of this plan is settled; nothing remains to continue.', 'INVALID_ARGUMENT');
    if (run.allocation || run.search_exclusions || run.gtm_consent || run.catalog_removal)
      bad(
        'This plan was saved from a preview, and its steps stay bound to that preview. Prepare a fresh preview for the remaining changes instead.',
        'RECOVERY_NOT_SAFE',
      );
    const blocked = carried
      .map((s: JsonObject) => {
        const claim = this.claim(actor, s.review_id);
        if (!claim || claim.state === 'rejected' || rejectedBuild(s) || absenceConfirmed(s)) return undefined;
        const stop = this.stopped(actor, run, s);
        return {step_id: s.id, status: s.status, next_call: stop.next_call ?? null};
      })
      .filter(Boolean);
    if (blocked.length)
      bad(
        'Steps ' +
          blocked.map((b: JsonObject) => b.step_id).join(', ') +
          ' reached the provider and their outcome is not settled, so a new plan cannot carry them: they could be applied twice. Settle each first (details.blocked_steps names the call), or check in the provider.',
        'RECOVERY_NOT_SAFE',
        {blocked_steps: blocked},
      );
    // A Google clone saved as one all-or-nothing build holds its ad groups as operations of that build, not as steps: no step names one of
    // them, and the build is applied whole or not at all. The way to copy fewer ad groups is to clone again with the ones wanted, and that is
    // offered only here, after every refusal above (lead review of r25-field-plan, S2-1): a build that reached the provider is refused above
    // (RECOVERY_NOT_SAFE when its outcome is not settled, "every step is settled" when it is), so an agent is never handed a call that
    // cancels the plan and copies the campaign again while the first copy may exist. A plan already continued answers above too.
    if (drop.length && run.clone?.all_or_nothing === true) {
      const build = run.steps.find((s: JsonObject) => s.kind === 'write') ?? {},
        unsent = ['pending', 'review_ready'].includes(build.status);
      bad(
        'Plan ' +
          run.id +
          ' is one all-or-nothing clone: its ad groups are operations of a single build, not steps, so none of them can be dropped from it. ' +
          (unsent
            ? 'Cancel it and clone again with source.ad_group_ids naming the ad groups to copy.'
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
                      source: {campaign_id: run.clone.source?.campaign_id},
                    },
                    add: ['source.ad_group_ids'],
                  },
                },
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
      // One continuation per plan: a retry returns the plan already saved.
      idempotency_key:
        'continue-' +
        String(run.id)
          .replace(/[^A-Za-z0-9_-]/g, '')
          .slice(0, 80),
      ...(input.acknowledge_temporary_sources === true ? {acknowledge_temporary_sources: true} : {}),
      detail: 'full',
    };
    this.origins.set(create, {continuation: {run_id: run.id, plan_hash: run.plan_hash}});
    const created = await this.handle(create, actor);
    let next = this.owned(actor, created.id);
    if (!next.supersedes) {
      next.supersedes = {id: run.id, plan_hash: run.plan_hash, at: Date.now(), by: actor.userId};
      for (const s of next.steps) if (adoptedBy.get(s.id)?.length) s.adopted_from = adoptedBy.get(s.id);
      if (run.recipe) next.recipe = run.recipe;
      // A colleague's continuation keeps the team in view (CMP-05).
      const team = linkedTeam(actor, run);
      if (team) next.collaborators = team;
      next = this.save(actor, next);
    }
    run.state = 'superseded';
    // The drop is recorded with the continuation, so that a second call is answered by it only when it asks for the same drop.
    run.superseded_by = {id: next.id, at: Date.now(), by: actor.userId, ...(drop.length ? {drop, dropped} : {})};
    audit(this.store, actor, 'campaign_plan_superseded', {
      id: run.id,
      superseded_by: next.id,
      carried: [...ids],
      ...(dropped.length ? {dropped} : {}),
      adopted: [...new Set([...adoptedBy.values()].flat().map(a => a.step_id))],
    });
    this.save(actor, run);
    return this.respond(input, next, undefined, {
      continued_from: run.id,
      ...(dropped.length ? {dropped} : {}),
      next_call: {tool: 'amcp_campaign', arguments: {action: 'approve', id: next.id}},
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
      steps = activationSteps(platform, results, {connection_id: write.connection_id, account_id: write.account_id});
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
    this.origins.set(create, {activation: {run_id: run.id, plan_hash: run.plan_hash}});
    const created = await this.handle(create, actor);
    let next = this.owned(actor, created.id);
    if (!next.activation_of) {
      next.activation_of = {
        id: run.id,
        plan_hash: run.plan_hash,
        recipe_id: run.recipe.id,
        platform,
        ...record,
      };
      // A colleague's activation keeps the team in view (CMP-05).
      const team = linkedTeam(actor, run);
      if (team) next.collaborators = team;
      next = this.save(actor, next);
      audit(this.store, actor, 'campaign_activation_planned', {
        id: next.id,
        activation_of: run.id,
        platform,
        steps: steps.map(s => s.id),
      });
    }
    run.activation_plan = {id: next.id, at: Date.now(), by: actor.userId};
    this.save(actor, run);
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
    const collaboration = actionHandler(this.collaborationActions, input.action);
    if (collaboration) return collaboration({input, actor, run});
    if (run.archived)
      bad('This campaign plan is archived. Unarchive it to work on it again.', 'PLAN_ARCHIVED', {
        next_call: {tool: 'amcp_campaign', arguments: {action: 'unarchive', id: run.id}},
      });
    if (input.action === 'continue_as_new') return this.continueAsNew(input, actor, run);
    if (run.state === 'superseded')
      bad(
        'This campaign plan was superseded by plan ' +
          String(run.superseded_by?.id ?? '') +
          ', which carries its remaining steps. Continue there.',
        'INVALID_ARGUMENT',
        {
          superseded_by: run.superseded_by?.id ?? null,
          next_call: {tool: 'amcp_campaign', arguments: {action: 'get', id: run.superseded_by?.id}},
        },
      );
    if (input.action === 'cancel') return this.cancelPlan({input, actor, run});
    if (run.state === 'cancelled') bad('This campaign plan was cancelled.');
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
    // Each blocked step says what refused it, what to do (its remedy) and the call that amends it (Snapchat S2).
    const blockedBy = (r: JsonObject) => {
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
      return input.detail === 'full'
        ? {...r, ...extra}
        : compactPlan(r, undefined, {...extra, preflight: preflightView(r.preflight)});
    };
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
    if (['uncertain', 'failed', 'mismatch'].includes(next.status)) {
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
        v = await meterNativeRequests(count, () => this.verifyWrite(actor, next.review_id));
      next.native_requests = addNativeRequests(next.native_requests, 'verify', count);
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
  /** The recipe catalog and its lookups: no plan, and no recipe-argument check yet. */
  private readonly recipeActions: ActionTable<CampaignCall> = {
    recipes: () => ({recipes: campaignRecipes}),
    recipe_lookup: call => this.recipeLookup(call),
    recipe_context: ({input, actor}) => recipeContext(this.store, actor, input.recipe, input.profile_id),
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
      return {
        view: 'step',
        id: run.id,
        name: run.name,
        revision: run.revision,
        state: run.state,
        plan_hash: run.plan_hash,
        step,
        execution_journal: journal([step]),
      };
    }
    // A background run's state comes from its job (MED-03 B): queued, running, complete or failed.
    const background = backgroundRunView(this.store, actor.tenantId, run),
      running = background ? {background} : {};
    if (input.detail === 'full') return {...run, execution_journal: journal(run.steps), ...running};
    return compactPlan(run, undefined, {
      ...(run.preflight ? {preflight: preflightView(run.preflight, true)} : {}),
      ...running,
      ...activationOffer(run),
    });
  }
  /** clone: a draft plan built from an existing campaign, created once per creation key. */
  private async cloneCampaign({input, actor}: CampaignCall): Promise<JsonObject> {
    assertCloneGateway(input.gateway);
    const connection = this.store.resolveConnection(actor, input.gateway, input.account_id, input.connection_id);
    // A keyed clone names its request, not what the source reads: a retry returns the original draft without reading
    // the source again, and the key with another request conflicts before any read (CMP-02 b).
    const origin = {
      clone: {
        gateway: input.gateway,
        connection_id: connection.id,
        account_id: input.account_id,
        source: input.source ?? null,
        changes: input.changes ?? null,
        atomic: input.atomic ?? null,
        name: input.name ?? null,
        brief: input.brief ?? null,
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
          next_call: {tool: 'amcp_campaign', arguments: {action: 'approve', id: run.id}},
        });
      }
    }
    const source = await clonePlan(this.call, actor, {...input, connection_id: connection.id}),
      changed = applyCloneChanges(source.steps, input.changes),
      allOrNothing = providerHooks(input.gateway)?.campaign?.clone?.allOrNothing;
    if (changed.steps.length > 50 && (!allOrNothing || input.atomic === false))
      bad(
        'The clone has ' + changed.steps.length + ' steps; a plan holds at most 50. Leave some out with changes.drop.',
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
        next_call: {tool: 'amcp_campaign', arguments: {action: 'approve', id: run.id}},
      });
    run.clone = {
      source: source.source,
      not_copied: source.notCopied,
      ...(changed.set.length ? {set: changed.set} : {}),
      ...(changed.dropped.length ? {dropped: changed.dropped} : {}),
      ...(atomic ? {all_or_nothing: true, steps: changed.steps.map(s => s.id)} : {}),
    };
    audit(this.store, actor, 'campaign_plan_cloned', {id: run.id, source: source.source, plan_hash: run.plan_hash});
    return this.respond(input, this.save(actor, run), undefined, {
      clone: run.clone,
      next_call: {tool: 'amcp_campaign', arguments: {action: 'approve', id: run.id}},
    });
  }
  /** create: a draft plan of explicit or templated steps, created once per creation key. */
  private createPlan({input, actor}: CampaignCall): JsonObject {
    const origin = this.origins.get(input);
    // A gateway, account or connection beside the name, where each step takes its own, is the mistake the White Friday
    // agent made first: the refusals a caller can correct say so and name where each one goes (R2.5 T4), in details.hint and
    // details.move, beside a message that stays one sentence the website can show in Arabic (R2.5 S3-3).
    const moved = topLevelMoves(input),
      refuse = (message: string, details: JsonObject = {}): never =>
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
                !['meta_image_hash', 'tiktok_spark_post', 'tiktok_pixel', 'linkedin_lead_form'].includes(p as string),
            ) ||
            new Set(s.prerequisites).size !== s.prerequisites.length) &&
          'prerequisites lists checks preflight must make: "meta_image_hash", "tiktok_spark_post", "tiktok_pixel" or "linkedin_lead_form"',
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
    run.state = 'cancelled';
    run = this.save(actor, run);
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
    const claim = this.store.db
      .prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?')
      .get(actor.tenantId, step.review_id) as JsonObject | undefined;
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
    if (next.status === 'executing')
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
    if (next.status === 'review_ready' && Date.parse(next.review.expires_at) > Date.now())
      return {
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
      };
    if (next.depends_on.some((id: string) => !settled(run.steps.find((s: JsonObject) => s.id === id))))
      bad('Wait for predecessor verification.', 'DEPENDENCY_PENDING');
    const results = new Map<string, JsonObject>(run.steps.filter(settled).map((s: JsonObject) => [s.id, s.result]));
    const resolved = references(next.arguments, results, new Set(next.depends_on));
    let prepared: JsonObject;
    // Native requests per step are recorded in the plan's journal metadata (COM-02 C).
    const prepareCount = {reads: 0, writes: 0};
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
      prepared = await meterNativeRequests(prepareCount, () =>
        removal
          ? removalBinding.under!(removal, prepare)
          : retiring
            ? withCatalogRetirement(retiring, prepare)
            : prepare(),
      );
    }
    next.native_requests = addNativeRequests(next.native_requests, 'prepare', prepareCount);
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
              : amendmentCall(run.id, next, prepared.error),
        },
        {error: prepared.error},
      );
    }
    const review = prepared.data;
    delete next.busy;
    // The refusal that sent this step back to pending (L5-04) concerned the review being replaced; the audit keeps it.
    if (refusedByStateCheck(next.error) || refusedByDuplicateGuard(next.error)) delete next.error;
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
  /** execute_next: the exact review prepared for the next step, executed and read back. */
  private async executeNext({input, actor, run, next}: StepCall): Promise<JsonObject> {
    if (
      (next.status !== 'review_ready' && next.status !== 'executing') ||
      input.review_id !== next.review_id ||
      (input.idempotency_key ?? next.review_id) !== next.review_id ||
      input.confirmed !== true
    )
      bad('Execute the exact returned review with confirmation.');
    this.assertReviewHolder(actor, run, next);
    // A step a crash left executing resumes under the decision already made; a new execution needs the second person.
    if (next.status === 'review_ready') this.assertDistinctApproval(actor, run);
    // Persist the review reference before egress. A crash resumes with the same native idempotency key.
    if (run.allocation) await assertAllocationStep(this.store, this.call, actor, run, next);
    if (run.search_exclusions) await assertSearchExclusionStep(this.store, this.call, actor, run, next);
    if (run.gtm_consent) await consentBinding.check!(this.store, this.call, actor, run, next);
    const removal = run.catalog_removal ? removalBinding.expectation!(run, next) : undefined,
      retiring = catalogRetirementOf(run, next),
      before = {status: next.status, state: run.state};
    next.status = 'executing';
    run.state = 'in_progress';
    run = this.save(actor, run);
    const step = run.steps.find((s: JsonObject) => s.id === next.id)!;
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
      executeCount = {reads: 0, writes: 0};
    const result = await meterNativeRequests(executeCount, () =>
      removal
        ? removalBinding.under!(removal, execute)
        : retiring
          ? withCatalogRetirement(retiring, execute)
          : execute(),
    );
    step.native_requests = addNativeRequests(step.native_requests, 'execute', executeCount);
    this.store.assertActorActive(actor);
    // A selected-removal step whose product changed since its review is refused before anything is claimed or sent
    // (COM-02 C): the step keeps its review as it did when a separate comparison refused it, and the remedy is a new
    // removal preview.
    if (removal && !result.success && ['STATE_CHANGED', 'CATALOG_REMOVAL_CHANGED'].includes(result.error?.code)) {
      step.status = before.status;
      run.state = before.state;
      this.save(actor, run);
      removalBinding.changed!();
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
      return this.respond(input, this.save(actor, run), step.id, {next_call: again});
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
      const held = this.holdDuplicate(actor, run, step, result.error);
      return this.respond(input, held.run, step.id, {next_call: held.next_call});
    }
    if (!result.success) {
      step.error = result.error; // An expired review was refused before anything was sent: prepare_next prepares it again.
      // A refusal that sent nothing released its claim (WRT-04): a pause, rate limit, open circuit or busy target clears
      // on its own, so the same review is executed again; anything else is amended like any unsent step.
      const unsent = result.error?.details?.submission === 'not_sent';
      step.status = ['WRITE_OUTCOME_UNCERTAIN', 'WRITE_PARTIAL_OR_FAILED', 'UPSTREAM_RESPONSE_INVALID'].includes(
        result.error?.code,
      )
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
            ].includes(result.error?.code) ||
            // The refusals the transport raises before it sends (the one list of src/errors.ts) and the media gates' own.
            (unsent &&
              [...refusedBeforeSending, 'MEDIA_MEMORY_BUSY', 'MEDIA_UPLOAD_BUSY'].includes(result.error?.code)) ||
            // A create identical to this one is still being sent (R2.5 M2, lead re-review N7): the review waits for it.
            (unsent && duplicateOfExecuting(result.error))
          ? 'review_ready'
          : result.error?.code === 'REVIEW_EXPIRED'
            ? 'pending'
            : 'failed';
      if (step.status === 'failed' && unsent) step.submission = 'not_submitted';
      // Refused without applying it (CMP-04): the key is retired, and the step is amended under a new one.
      if (step.status === 'failed' && result.error?.details?.submission === 'rejected') step.submission = 'rejected';
      run.state = 'attention';
      return this.respond(input, this.save(actor, run), step.id);
    }
    delete step.error;
    step.result = result.data;
    step.status = step.kind === 'media' ? (result.data.ready ? 'verified' : 'processing') : 'verifying';
    if (step.kind === 'write') {
      const verifyCount = {reads: 0, writes: 0};
      step.verification = await meterNativeRequests(verifyCount, () => this.verifyWrite(actor, step.review_id));
      step.native_requests = addNativeRequests(step.native_requests, 'verify', verifyCount);
      step.status = verificationStepStatus(step.verification.status);
      if (step.status === 'verified' && step.verification.verified_resources)
        step.result = {...step.result, verified_resources: step.verification.verified_resources};
    }
    run.state = uploadsState(run, step);
    run = this.save(actor, run);
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
