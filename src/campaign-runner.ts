import {recipeContext, recipeInputs} from './recipe-context.js';
import {recipeEligibility} from './recipe-eligibility.js';
import {assertAllocationStep, allocationCreationBinding} from './allocation-plan.js';
import {assertConsentStep, consentCreationBinding} from './gtm-consent-plans.js';
import {assertCatalogRemovalStep, catalogRemovalCreationBinding} from './x-catalog-removal.js';
import {
  assertSearchExclusionStep,
  assertNewSearchExclusionDraft,
  searchExclusionCreationBinding,
} from './search-exclusion-plan.js';
import {expandTemplate as substitute} from './client-playbooks.js';
import {assertAccountWrite} from './write-access.js';
import {normalizeAccount} from './scope.js';
import {campaignRecipe, campaignRecipes} from './campaign-recipes.js';
import {verificationContractVersion} from './verification-reads.js';
import {randomUUID} from 'node:crypto';
import {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {MirrorError, errorRemedy} from './errors.js';
import {amendmentCall, applyPatch} from './campaign-amendment.js';
import {applyCloneChanges, assertCloneGateway, clonePlan, composeGoogleBuild} from './campaign-clone.js';
import {compactPlan, preflightView, reviewView} from './campaign-view.js';
import {approvalSpends, approvalStep, approvalSummary} from './plan-approval.js';
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
export const campaignTool = tool(
  'amcp_campaign',
  'Use this for a launch whose later steps need IDs that earlier steps create (campaign, then ad set, then ad); for one change use amcp_write. Create a durable campaign dependency plan from a brief and explicit native steps. Apply approved profiles/templates. recipe_eligibility checks the current business brief without saving a plan: local by default; live:true adds exact read-only account prerequisites. The four Google conversion Search recipes inspect current account-default goals and enabled explicit primary actions in a selected client using its own conversion customer; shared tracking stays unknown. Google Search with Maximize Conversion Value and Google Search with a target ROAS explicitly choose ACCOUNT_RECORDED_VALUES, leave goal and value settings unchanged and save a paused parent with a dedicated budget. target_roas is decimal ratio text from 0.01 to 1000 (3.5 means 350%), compiled to the native double; delivered values, conversion history, eligibility and actual return remain unverified. For the two value-bidding recipes, live eligibility also selects current default value, conversion currency and event-value override settings for the same matching primary actions. It also reads the last reported conversion date and last tag-detection time twice in the native account timezone. These optional aggregate dates remain unknown when absent; tag detection may have no attributable conversion, and no event-level records are read. Optional missing settings stay unknown; configuration does not prove received event values. Pending plans reread retired conversion-value proofs through their original accepted receipts before approval or advancing; completed historical runs are not replayed. The Snapchat website traffic recipe reuses an existing WEB_VIEW creative and saves three paused steps with an explicit AUTO_BID/SWIPES budget and offset schedule. Read-only preflight checks its selected-account ownership, creative type and original HTTPS destination syntax; advertising approval and destination availability remain unverified. The Snapchat lead-generation recipe reuses an existing LEAD_GENERATION creative and its original account-owned form, with an explicit SWIPES or LEAD_FORM_SUBMISSIONS goal. Preflight and native review inspect both definitions; no submitted leads are read, and provider eligibility, privacy and consent acceptance remain unverified. Readers can inspect these settings while existing write blockers remain active. Configuration does not prove event delivery, objective acceptance or write approval. prepare_next resolves only verified predecessor outputs and returns the existing native review; execute_next consumes that exact review, automatically reads back the result, and resumes without duplicate writes. Responses are compact: one row per step with its resource IDs, and the step the call acted on; get with step_id returns one step whole, and detail:"full" the whole plan. A step preflight blocked, or one that failed before reaching the provider, is amended in place with recover_step (patch one field, or send corrected arguments), following the next_call its refusal carries; nothing is sent until its new review. To approve a whole plan once: approve returns what the approval covers (every step’s action, account, money and status fields, a large step aggregated with truncated: true; approve with its step_id lists every field); approve with confirmed, that plan_hash and its summary_hash records it; run then prepares and executes every step under it, each still a frozen, read-back review, and stops for anything that needs a person. clone reads an existing Snapchat, Google Search, TikTok or LinkedIn campaign (source.campaign_id; a LinkedIn campaign group) into a new draft plan under a new name, with changes applied (set a field, drop a step); a Google copy is one all-or-nothing step (atomic: false for one step per resource type); the new campaign starts PAUSED and nothing is sent until the plan is reviewed or approved. create accepts an optional stable idempotency_key (8–100 letters, digits, hyphens or underscores); identical creation input reuses the original plan, while different input conflicts. Allocation preview handoffs bind their exact source and budget ownership to the draft; stale source, changed ownership or amended proposal targets require a fresh preview. Search-exclusion preview handoffs similarly preserve exact retained terms and original ad groups; changed source or target arguments require a new preview. Accepted and uncertain receipts retain their original recovery. No fabricated IDs, implicit launch, or review bypass.',
  [
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
    'recipes',
    'recipe_context',
    'recipe_eligibility',
    'recipe_lookup',
    'preview_recipe',
    'create_from_recipe',
    'clone',
  ],
  {
    id: field.id,
    name: field.id,
    brief: field.id,
    profile_id: field.id,
    template: field.id,
    variables: field.object,
    steps: {type: 'array', items: {type: 'object'}, minItems: 1, maxItems: 50},
    review_id: field.id,
    idempotency_key: field.id,
    allocation_preview_id: field.id,
    allocation_preview_hash: field.id,
    consent_preview_id: field.id,
    consent_preview_hash: field.id,
    catalog_removal_preview_id: field.id,
    catalog_removal_preview_hash: field.id,
    catalog_removal_save_nonce: field.id,
    search_exclusion_preview_id: field.id,
    search_exclusion_preview_hash: field.id,
    confirmed: field.bool,
    spend_change_confirmed: field.bool,
    creative_edit_confirmed: field.bool,
    cap_override_confirmed: field.bool,
    expected_revision: field.integer,
    query: field.id,
    lookup_kind: {type: 'string', enum: ['country', 'language']},
    account_id: field.id,
    recipe: field.id,
    business: field.object,
    live: field.bool,
    step_id: field.id,
    gateway: field.id,
    arguments: field.object,
    connection_id: field.id,
    detail: {
      type: 'string',
      enum: ['compact', 'full'],
      description:
        'compact (default): the plan header, one row per step, the step this call acted on and the next call, within 12 KB. full: the whole stored plan, as get returns it with this value.',
    },
    offset: {type: 'integer', minimum: 0},
    limit: {type: 'integer', minimum: 1, maximum: 100},
    plan_hash: {
      type: 'string',
      description: 'approve with confirmed: the plan_hash of the summary the user approved.',
    },
    summary_hash: {
      type: 'string',
      description:
        'approve with confirmed: the summary_hash of the summary the user was shown. A step with many fields is aggregated (truncated: true); approve with its step_id lists every field.',
    },
    accept_observed: {
      type: 'boolean',
      description:
        'reconcile_step: the user accepts the state a mismatched step reads back as its result, with actual_hash. Sends nothing to the provider; audited.',
    },
    actual_hash: {
      type: 'string',
      description: 'reconcile_step with accept_observed: the observed state hash accepted.',
    },
    atomic: {
      type: 'boolean',
      description:
        'clone (Google): true (the default) makes the copy one all-or-nothing step, a single googleAds:mutate; false keeps one step per resource type.',
    },
    source: {
      type: 'object',
      description: 'clone: {campaign_id} of the campaign to copy, in the account_id named.',
    },
    changes: {
      type: 'object',
      description:
        'clone: {set: [{step_id, path, value}], drop: [step_id]}. set changes one field of a step’s arguments by JSON pointer ("/payload/operations/0/create/amount_micros"); drop leaves a step and its dependants out.',
    },
    patch: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {type: 'object'},
      description:
        'recover_step: [{path, value}] changes to fields the step already has, as JSON pointers into its arguments ("/payload/adsquads/0/pixel_id"). Instead of arguments.',
    },
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
      ]
        .filter(k => s[k] !== undefined)
        .map(k => [k, s[k]]),
    ),
  );
const verificationStepStatus = (status: string) =>
  ['verified', 'failed', 'mismatch'].includes(status) ? status : 'verifying';
/** A step whose result later steps may use: verified, or accepted as observed by the user (Snapchat S5). */
const settled = (s: JsonObject) => ['verified', 'verified_with_acceptance', 'complete'].includes(s.status);
/**
 * A Google build Google refused outright (HTTP 4xx other than a timeout or rate limit). The pinned v25 contract
 * applies a partialFailure-false googleAds:mutate "if and only if" every operation is valid, so a refused build created
 * nothing (the owner's decision 5, 2026-09-29). Its key stays uncertain and is never sent again; the step may be
 * amended and reviewed under a new key. Every other refusal after submission, and a lost response, still stop the plan.
 */
const rejectedBuild = (step: JsonObject) =>
  step.kind === 'write' &&
  step.status === 'failed' &&
  step.gateway === 'google_ads_native_action' &&
  /_google_ads_mutate$/.test(String(step.arguments?.action ?? '')) &&
  step.arguments?.payload?.partial_failure !== true &&
  step.arguments?.payload?.partialFailure !== true &&
  [400, 401, 403, 404, 409, 412, 422].includes(Number(step.error?.details?.http_status));
const planState = (run: JsonObject, step: JsonObject) =>
  run.steps.every(settled) ? 'complete' : settled(step) ? 'in_progress' : 'attention';
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
/** Rollback switch for the summary binding (WRT-05): AMCP_PLAN_SUMMARY_HASH=false accepts an approval by plan_hash alone. */
const summaryHashRequired = () => process.env.AMCP_PLAN_SUMMARY_HASH !== 'false';
export class CampaignRunner {
  constructor(
    private store: Store,
    private call: ToolCall,
    private verifyWrite: (actor: Actor, id: string) => Promise<JsonObject>,
    private providerValidation: (actor: Actor, input: JsonObject) => Promise<JsonObject>,
    private preflight?: (actor: Actor, steps: JsonObject[]) => Promise<JsonObject>,
    private acceptsAccountId: (gateway: string, operation?: string) => boolean = () => true,
    private inspectConversionGoals?: (actor: Actor, scope: JsonObject, current: () => void) => Promise<JsonObject>,
  ) {}
  private owned(actor: Actor, id: string) {
    const p = read(this.store, actor, 'campaign_run', id);
    if (p.user_id !== actor.userId && actor.role !== 'admin')
      bad('Campaign plan belongs to another actor.', 'FORBIDDEN');
    if (p.plan_hash !== fingerprint(structure(p.steps)))
      bad('The saved plan failed its integrity check.', 'PLAN_CHANGED');
    return p;
  }
  private save(actor: Actor, run: JsonObject) {
    const {id, revision, ...data} = run;
    this.store.putDocument(actor.tenantId, 'campaign_run', id, {...data, updated_at: Date.now()}, revision);
    return this.owned(actor, id);
  }
  /** The idempotency claim of a submitted step, if its review ever reached execution. */
  private claim(actor: Actor, reviewId: unknown): JsonObject | undefined {
    return typeof reviewId === 'string'
      ? (this.store.db
          .prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?')
          .get(actor.tenantId, reviewId) as JsonObject | undefined)
      : undefined;
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
    return {
      recovery:
        'Step ' +
        step.id +
        ' reached the provider and its outcome is not confirmed, so AMCP never sends it again.' +
        (claim?.state === 'complete'
          ? ' reconcile_step reads the resource back from its original receipt (next_call).'
          : ' No completed receipt exists: check in the provider whether the resource exists. Steps already verified stay; anything still to be written needs a new plan.'),
      next_call:
        claim?.state === 'complete'
          ? {tool: 'amcp_campaign', arguments: {action: 'reconcile_step', id: run.id, step_id: step.id}}
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
   */
  private approve(input: JsonObject, actor: Actor, run: JsonObject): JsonObject {
    const summary = approvalSummary(run),
      spending = approvalSpends(summary);
    if (input.confirmed !== true && typeof input.step_id === 'string') {
      const fields = approvalStep(run, input.step_id);
      if (!fields) bad('Name a step of this plan.', 'INVALID_ARGUMENT', {field: 'step_id'});
      return {id: run.id, plan_hash: run.plan_hash, summary_hash: summary.summary_hash, ...fields};
    }
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
    run.approval = {
      plan_hash: run.plan_hash,
      summary_hash: summary.summary_hash,
      by: actor.userId,
      at: Date.now(),
      spend_change_confirmed: input.spend_change_confirmed === true,
    };
    audit(this.store, actor, 'campaign_plan_approved', {
      id: run.id,
      plan_hash: run.plan_hash,
      summary_hash: summary.summary_hash,
      steps: run.steps.length,
      fields_total: summary.fields_total,
      truncated_steps: summary.steps.filter((s: JsonObject) => s.truncated).length,
      spend_change_confirmed: input.spend_change_confirmed === true,
    });
    run = this.save(actor, run);
    return compactPlan(run, undefined, {
      approved: {by: actor.userId, spend_change_confirmed: run.approval.spend_change_confirmed},
      next_call: {tool: 'amcp_campaign', arguments: {action: 'run', id: run.id}},
    });
  }
  /**
   * Runs an approved plan: each step is prepared (a frozen review of the state it reads) and executed under the
   * plan's approval, then read back, exactly as prepare_next and execute_next do one at a time. It stops for anything
   * that needs a person: a spending acknowledgement the approval did not give, an owner cap override, a creative
   * edit, a failure, a mismatch, or a read-back still settling. It also stops after about 25 seconds so a response
   * always arrives; run again to continue. Nothing is rolled back: steps already done stay, as created (paused).
   */
  private async runApproved(input: JsonObject, actor: Actor, run: JsonObject): Promise<JsonObject> {
    if (!run.approval || run.approval.plan_hash !== run.plan_hash || Date.now() - run.approval.at > 86400000)
      bad(
        'This plan has no current approval. Show the user the summary (approve), then approve it with confirmed: true.',
        'APPROVAL_REQUIRED',
        {next_call: {tool: 'amcp_campaign', arguments: {action: 'approve', id: run.id}}},
      );
    const started = Date.now(),
      executed: string[] = [];
    const stop = (view: JsonObject, reason: string, extra: JsonObject = {}) => ({
      ...view,
      run: {executed, stopped: reason, ...extra},
    });
    for (let i = 0; i < run.steps.length * 3 + 3; i++) {
      if (Date.now() - started > 25000)
        return stop(this.respond({}, this.owned(actor, run.id)), 'time', {
          next_call: {tool: 'amcp_campaign', arguments: {action: 'run', id: run.id}},
        });
      const prepared = await this.handle({action: 'prepare_next', id: run.id}, actor);
      if (!prepared.review) {
        const view = prepared.view ? prepared : this.respond({}, this.owned(actor, run.id));
        if (view.state === 'complete') return stop(view, 'complete');
        return stop(view, view.blocked ? 'needs_attention' : 'waiting');
      }
      // A review still ready from an earlier call carries its requirements inside the review view.
      const needs = prepared.execute_requirements ?? prepared.review?.execute_requirements ?? {};
      const human = needs.cap_override_confirmed
        ? 'cap_override_confirmed'
        : needs.creative_edit_confirmed
          ? 'creative_edit_confirmed'
          : needs.spend_change_confirmed && !run.approval.spend_change_confirmed
            ? 'spend_change_confirmed'
            : undefined;
      if (human)
        return stop(prepared, 'needs_' + human, {
          reason:
            'Step ' +
            prepared.step_id +
            ' needs ' +
            human +
            ', which the plan approval does not give. Show the user this review; execute_next with it continues the step, then run continues the plan.',
        });
      const out = await this.handle(
        {
          action: 'execute_next',
          id: run.id,
          review_id: prepared.review.review_id,
          idempotency_key: prepared.review.idempotency_key,
          confirmed: true,
          ...(needs.spend_change_confirmed ? {spend_change_confirmed: true} : {}),
        },
        actor,
      );
      executed.push(prepared.step_id);
      if (out.state === 'complete') return stop(out, 'complete');
      const step = out.steps?.find((s: JsonObject) => s.id === prepared.step_id);
      if (step && ['failed', 'uncertain', 'mismatch'].includes(step.status)) return stop(out, 'needs_attention');
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
  async handle(input: JsonObject, actor: Actor): Promise<JsonObject> {
    validate(input, Object.keys(campaignTool.inputSchema.properties), 524288);
    this.store.assertActorActive(actor);
    if (input.action === 'recipes') return {recipes: campaignRecipes};
    if (input.action === 'recipe_lookup') {
      const query = String(input.query ?? '').trim();
      if (!/^[A-Za-z -]{2,60}$/.test(query) || !['country', 'language'].includes(input.lookup_kind))
        throw new MirrorError('INVALID_LOOKUP', 'Enter a country name/code or language name (2–60 letters).');
      this.store.resolveConnection(actor, 'google_ads_native_action', input.account_id, input.connection_id);
      const country = input.lookup_kind === 'country',
        gaql = country
          ? "SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.country_code FROM geo_target_constant WHERE geo_target_constant.target_type = 'Country' AND " +
            (query.length === 2
              ? "geo_target_constant.country_code = '" + query.toUpperCase() + "'"
              : "geo_target_constant.name LIKE '%" + query + "%'") +
            ' LIMIT 100'
          : 'SELECT language_constant.id, language_constant.name, language_constant.code FROM language_constant LIMIT 1000';
      const out = await this.call(
        'google_ads_native_action',
        {
          action: 'google_ads_v23_google_ads_search',
          connection_id: input.connection_id,
          account_id: input.account_id,
          payload: {query: gaql},
        },
        actor,
      );
      if (!out.success) throw new MirrorError(out.error.code, out.error.message, out.error.details);
      if (out.data.truncated)
        throw new MirrorError('INCOMPLETE_LOOKUP', 'This lookup is incomplete. Narrow the search.');
      const rows = out.data.data?.results;
      if (!Array.isArray(rows))
        throw new MirrorError('UPSTREAM_RESPONSE_INVALID', 'Google did not return targeting constants.');
      return {
        kind: input.lookup_kind,
        results: rows
          .map((r: JsonObject) => (country ? r.geoTargetConstant : r.languageConstant))
          .filter(
            (r: JsonObject) =>
              r &&
              typeof r.id === 'string' &&
              (country ||
                String(r.name ?? '')
                  .toLowerCase()
                  .includes(query.toLowerCase()) ||
                String(r.code ?? '').toLowerCase() === query.toLowerCase()),
          )
          .slice(0, 50)
          .map((r: JsonObject) => ({id: r.id, name: r.name, code: r.code ?? r.countryCode})),
        provider_mutations: 0,
      };
    }
    if (input.action === 'recipe_context') return recipeContext(this.store, actor, input.recipe, input.profile_id);
    if (input.action === 'recipe_eligibility')
      return recipeEligibility(this.store, this.call, this.preflight, input, actor, this.inspectConversionGoals);
    if (['preview_recipe', 'create_from_recipe'].includes(input.action)) {
      const context = recipeContext(this.store, actor, input.recipe, input.profile_id),
        {business, provenance} = recipeInputs(context, input.business ?? {});
      const missing = context.recipe.required.filter((k: string) => business[k] === undefined || business[k] === '');
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
      const result = await this.handle(
          {...plan, ...(input.profile_id ? {profile_id: input.profile_id} : {}), detail: 'full'},
          actor,
        ),
        run = this.owned(actor, result.id);
      run.recipe = {...recipe, provenance};
      // Which value came from the user and which from the approved profile is what a person checks next.
      return this.respond(input, this.save(actor, run), undefined, {recipe: run.recipe});
    }
    if (input.action === 'verify') return this.verifyWrite(actor, input.review_id);
    if (input.action === 'validate_provider') return this.providerValidation(actor, input);
    if (input.action === 'list') {
      const all = this.store
          .documents(actor.tenantId, 'campaign_run')
          .filter(r => r.user_id === actor.userId || actor.role === 'admin'),
        offset = input.offset ?? 0,
        limit = input.limit ?? 50;
      return {
        campaigns: all
          .slice(offset, offset + limit)
          .map(r => ({id: r.id, name: r.name, state: r.state, updated_at: r.updated_at, step_count: r.steps.length})),
        total: all.length,
        ...(offset + limit < all.length ? {next_offset: offset + limit} : {}),
      };
    }
    if (input.action === 'get') {
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
      if (input.detail === 'full') return {...run, execution_journal: journal(run.steps)};
      return compactPlan(run, undefined, run.preflight ? {preflight: preflightView(run.preflight, true)} : {});
    }
    writer(this.store, actor);
    if (input.action === 'clone') {
      assertCloneGateway(input.gateway);
      const connection = this.store.resolveConnection(actor, input.gateway, input.account_id, input.connection_id),
        source = await clonePlan(this.call, actor, {...input, connection_id: connection.id}),
        changed = applyCloneChanges(source.steps, input.changes);
      if (changed.steps.length > 50 && (input.gateway !== 'google_ads_native_action' || input.atomic === false))
        bad(
          'The clone has ' +
            changed.steps.length +
            ' steps; a plan holds at most 50. Leave some out with changes.drop.',
          'CLONE_SOURCE_TOO_LARGE',
          {field: 'changes.drop', steps: changed.steps.slice(0, 100).map(s => s.id)},
        );
      // A Google clone is one all-or-nothing build unless the caller asks for step-by-step (atomic: false).
      const atomic = input.gateway === 'google_ads_native_action' && input.atomic !== false;
      const created = await this.handle(
          {
            action: 'create',
            name: input.name,
            brief: input.brief ?? 'Clone of campaign ' + source.source.campaign_id + '.',
            steps: atomic
              ? [composeGoogleBuild(changed.steps, String(input.account_id).replace(/-/g, ''))]
              : changed.steps,
            detail: 'full',
          },
          actor,
        ),
        run = this.owned(actor, created.id);
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
    if (input.action === 'create') {
      if (
        typeof input.name !== 'string' ||
        !input.name.trim() ||
        input.name.length > 100 ||
        typeof input.brief !== 'string' ||
        input.brief.length > 12000
      )
        bad('Provide a campaign name and brief.');
      const profile = input.profile_id ? read(this.store, actor, 'client_profile', input.profile_id) : undefined,
        variables = {...(profile?.variables ?? {}), ...(input.variables ?? {}), profile: profile ?? {}};
      noSecrets(variables);
      const raw = input.steps ?? profile?.templates?.[input.template];
      if (!Array.isArray(raw) || !raw.length || raw.length > 50)
        bad('Provide 1–50 explicit steps, or choose an approved saved template.');
      const steps = substitute(raw, variables),
        seen = new Set<string>();
      for (const s of steps) {
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
        ]);
        const problems = [
          !/^[A-Za-z][A-Za-z0-9_-]{0,50}$/.test(s.id) &&
            'id must start with a letter (up to 51 letters, digits, _ or -)',
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
        ].filter(Boolean);
        if (problems.length)
          bad(
            'Step ' +
              JSON.stringify(String(s.id ?? '')) +
              ': ' +
              problems.join('; ') +
              '. Each step is {"id","kind":"write","gateway","connection_id","account_id","arguments":{"action","payload"},"depends_on":[earlier ids]}; later steps use results as {"$ref":"<step id>#/data/<JSON pointer>"}.',
          );
        const deps = s.depends_on ?? [];
        if (!Array.isArray(deps) || new Set(deps).size !== deps.length || deps.some(d => !seen.has(d)))
          bad('Dependencies must refer to earlier steps.');
        seen.add(s.id);
        noSecrets(s.arguments);
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
      const gtm_consent = consentCreationBinding(this.store, actor, input, steps);
      const catalog_removal = catalogRemovalCreationBinding(this.store, actor, input, steps);
      const creation_fingerprint = fingerprint({
        name: input.name,
        brief: input.brief,
        user: actor.userId,
        profile_id: profile?.id ?? null,
        profile_revision: profile?.revision ?? null,
        variables,
        steps: structure(steps),
        allocation: allocation ?? null,
        ...(search_exclusions ? {search_exclusions} : {}),
        ...(gtm_consent ? {gtm_consent} : {}),
        ...(catalog_removal ? {catalog_removal} : {}),
      });
      const id = input.idempotency_key
        ? fingerprint({kind: 'campaign-create', tenant: actor.tenantId, user: actor.userId, key: input.idempotency_key})
        : randomUUID();
      const existing = input.idempotency_key ? optional(this.store, actor.tenantId, 'campaign_run', id) : undefined;
      if (existing) {
        if (existing.creation_fingerprint !== creation_fingerprint)
          bad('This creation key belongs to a different campaign plan.', 'IDEMPOTENCY_CONFLICT');
        return this.respond(input, this.owned(actor, id));
      }
      if (this.store.documents(actor.tenantId, 'campaign_run').length >= 500)
        bad('Limit reached: 500 saved campaign plans.');
      const run = {
        name: input.name,
        brief: input.brief,
        user_id: actor.userId,
        profile_id: profile?.id ?? null,
        profile_revision: profile?.revision ?? null,
        variables,
        steps,
        state: 'draft',
        created_at: Date.now(),
        updated_at: Date.now(),
        plan_hash: fingerprint(structure(steps)),
        ...(input.idempotency_key ? {creation_fingerprint} : {}),
        ...(allocation ? {allocation} : {}),
        ...(search_exclusions ? {search_exclusions} : {}),
        ...(gtm_consent ? {gtm_consent} : {}),
        ...(catalog_removal ? {catalog_removal} : {}),
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
    let run = this.owned(actor, input.id);
    if (input.expected_revision !== undefined && input.expected_revision !== run.revision)
      bad('Reload the current campaign plan.', 'REVISION_CONFLICT');
    if (input.action === 'cancel') {
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
    if (run.state === 'cancelled') bad('This campaign plan was cancelled.');
    if (input.action === 'reconcile_step' && input.accept_observed !== undefined) {
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
    if (input.action === 'reconcile_step') {
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
    if (input.action === 'recover_step') {
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
      // Whether the step can be recovered comes first: asking to confirm a recovery that is refused anyway helps no one.
      if (step.status !== 'failed' && !blockedCheck)
        bad(
          'Step ' +
            step.id +
            ' is ' +
            step.status +
            '. Only a step preflight blocked, or one that failed before reaching the provider, can be amended; unknown, verifying and mismatched outcomes need investigation.',
          'RECOVERY_NOT_SAFE',
          {step_id: step.id, status: step.status},
        );
      if (this.claim(actor, step.review_id) && !rejectedBuild(step))
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
          'Set confirmed: true to amend step ' +
            step.id +
            '; it is prepared and reviewed again before anything is sent.',
          'INVALID_ARGUMENT',
          {field: 'confirmed'},
        );
      const attempt: JsonObject = {
        at: Date.now(),
        ...(step.review_id ? {review_id: step.review_id} : {}),
        ...(step.error ? {error: step.error} : {}),
        ...(blockedCheck?.error ? {preflight_error: blockedCheck.error} : {}),
      };
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
      noSecrets(step.arguments);
      if (rejectedBuild(step)) {
        attempt.rejected_build = {http_status: step.error.details.http_status, key_retired: step.review_id};
        audit(this.store, actor, 'campaign_step_recovered_after_rejection', {
          id: run.id,
          step_id: step.id,
          review_id: step.review_id,
          http_status: step.error.details.http_status,
        });
      }
      step.previous_attempts = [...(step.previous_attempts ?? []), attempt].slice(-10);
      for (const k of ['review', 'review_id', 'resolved', 'error', 'result', 'verification', 'submission'])
        delete step[k];
      step.status = 'pending';
      run.state = 'draft';
      run.plan_hash = fingerprint(structure(run.steps));
      delete run.preflight;
      return this.respond(input, this.save(actor, run), step.id, {
        next_call: {tool: 'amcp_campaign', arguments: {action: 'prepare_next', id: run.id}},
      });
    }
    if (['prepare_next', 'execute_next', 'approve', 'run'].includes(input.action))
      for (const s of run.steps.filter((s: JsonObject) => !settled(s))) {
        const gateway = s.kind === 'media' ? s.arguments.platform + '_native_action' : s.gateway,
          c = this.store.resolveConnection(actor, gateway, s.account_id, s.connection_id);
        assertAccountWrite(this.store, c, normalizeAccount(gateway, s.account_id));
      }
    if (['preflight', 'prepare_next', 'execute_next', 'approve', 'run'].includes(input.action))
      assertNewSearchExclusionDraft(this.store, actor, run);
    // Each blocked step says what refused it, what to do (its remedy) and the call that amends it (Snapchat S2).
    const blockedBy = (r: JsonObject) => {
      const missing = r.preflight.checks
          .filter((c: JsonObject) => c.status === 'blocked')
          .map((c: JsonObject) => {
            const step = r.steps.find((x: JsonObject) => x.id === c.step),
              error = c.error
                ? {...c.error, remedy: errorRemedy(new MirrorError(c.error.code, c.error.message, c.error.details))}
                : c.error;
            return {...c, error, ...(step ? {next_call: amendmentCall(r.id, step, c.error)} : {})};
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
      this.preflight &&
      (input.action === 'preflight' || (['prepare_next', 'approve', 'run'].includes(input.action) && !run.preflight))
    ) {
      run.preflight = await this.preflight(actor, run.steps);
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
    if (input.action === 'approve') return this.approve(input, actor, run);
    if (input.action === 'run') return this.runApproved(input, actor, run);
    let next = run.steps.find((s: JsonObject) => !settled(s));
    if (!next) return this.respond(input, {...run, state: 'complete'});
    if (['uncertain', 'failed', 'mismatch'].includes(next.status)) {
      // A mismatch holds only its dependants; the user's decision on it can wait while other steps run.
      const other = next.status === 'mismatch' ? independentStep(run) : undefined;
      if (!other) return this.respond(input, run, next.id, {blocked: true, ...this.stopped(actor, run, next)});
      next = run.steps.find((s: JsonObject) => s.id === other)!;
    }
    if (next.status === 'processing') {
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
      const v = await this.verifyWrite(actor, next.review_id);
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
    if (input.action === 'prepare_next') {
      if (run.allocation) await assertAllocationStep(this.store, this.call, actor, run, next);
      if (run.search_exclusions) await assertSearchExclusionStep(this.store, this.call, actor, run, next);
      if (run.gtm_consent) await assertConsentStep(this.store, this.call, actor, run, next);
      if (run.catalog_removal) await assertCatalogRemovalStep(this.store, this.call, actor, run, next);
      if (next.status === 'executing')
        return {
          campaign_id: run.id,
          step_id: next.id,
          recovery: 'Resume the original execution with the same idempotency key.',
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
      if (next.kind === 'media')
        prepared = await this.call(
          'amcp_media',
          resolved.action === 'prepare_library'
            ? {action: 'prepare_library', review_id: resolved.review_id}
            : {...resolved, action: 'prepare', account_id: next.account_id, connection_id: next.connection_id},
          actor,
        );
      else {
        // DV360, Amazon and many delegated operations name the account with their own key and forbid account_id.
        if (this.acceptsAccountId(next.gateway, resolved.operation)) {
          if (resolved.operation) resolved.arguments = {...resolved.arguments, account_id: next.account_id};
          else Object.assign(resolved, {account_id: next.account_id});
        }
        // Each step keeps a reference to the provider contract: the whole one is a single amcp_tool_help call away
        // and would otherwise repeat 1.3-6.6 KB in every step of the run and its responses (F-29).
        prepared = await this.call(
          'amcp_write',
          {
            action: 'prepare',
            gateway: next.gateway,
            connection_id: next.connection_id,
            arguments: resolved,
            evidence: 'ref',
          },
          actor,
        );
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
            // A refusal that names its own next call (the ownership read) comes first; the step is amended after it.
            next_call: prepared.error?.details?.next_call
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
      if (review.reused === true) {
        next.result = review;
        next.status = 'verified';
        run.state = planState(run, next);
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
          review.execute_requirements?.creative_edit_confirmed === true
            ? {
                add_after_user_approval: {
                  ...(review.execute_requirements.spend_change_confirmed === true
                    ? {spend_change_confirmed: true}
                    : {}),
                  ...(review.execute_requirements.cap_override_confirmed === true
                    ? {cap_override_confirmed: true}
                    : {}),
                  ...(review.execute_requirements.creative_edit_confirmed === true
                    ? {creative_edit_confirmed: true}
                    : {}),
                },
              }
            : {}),
        },
      };
    }
    if (input.action !== 'execute_next') bad('Unknown campaign action.');
    if (
      (next.status !== 'review_ready' && next.status !== 'executing') ||
      input.review_id !== next.review_id ||
      (input.idempotency_key ?? next.review_id) !== next.review_id ||
      input.confirmed !== true
    )
      bad('Execute the exact returned review with confirmation.');
    // Persist the review reference before egress. A crash resumes with the same native idempotency key.
    if (run.allocation) await assertAllocationStep(this.store, this.call, actor, run, next);
    if (run.search_exclusions) await assertSearchExclusionStep(this.store, this.call, actor, run, next);
    if (run.gtm_consent) await assertConsentStep(this.store, this.call, actor, run, next);
    if (run.catalog_removal) await assertCatalogRemovalStep(this.store, this.call, actor, run, next);
    next.status = 'executing';
    run.state = 'in_progress';
    run = this.save(actor, run);
    const step = run.steps.find((s: JsonObject) => s.id === next.id)!;
    const result = await this.call(
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
            }
          : {}),
      },
      actor,
    );
    this.store.assertActorActive(actor);
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
              'WRITES_PAUSED',
              'STATE_BUSY',
            ].includes(result.error?.code) ||
            (unsent &&
              [
                'TENANT_RATE_LIMIT',
                'PLATFORM_RATE_LIMIT',
                'CIRCUIT_OPEN',
                'PROVIDER_COORDINATION_BUSY',
                'MEDIA_MEMORY_BUSY',
                'MEDIA_UPLOAD_BUSY',
              ].includes(result.error?.code))
          ? 'review_ready'
          : result.error?.code === 'REVIEW_EXPIRED'
            ? 'pending'
            : 'failed';
      if (step.status === 'failed' && unsent) step.submission = 'not_submitted';
      run.state = 'attention';
      return this.respond(input, this.save(actor, run), step.id);
    }
    delete step.error;
    step.result = result.data;
    step.status = step.kind === 'media' ? (result.data.ready ? 'verified' : 'processing') : 'verifying';
    if (step.kind === 'write') {
      step.verification = await this.verifyWrite(actor, step.review_id);
      step.status = verificationStepStatus(step.verification.status);
      if (step.status === 'verified' && step.verification.verified_resources)
        step.result = {...step.result, verified_resources: step.verification.verified_resources};
    }
    run.state = planState(run, step);
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
          verified: run.steps.filter(settled).map((s: JsonObject) => s.id),
          remaining: run.steps
            .filter((s: JsonObject) => !settled(s))
            .map((s: JsonObject) => ({id: s.id, status: s.status})),
        },
      },
    );
  }
}
