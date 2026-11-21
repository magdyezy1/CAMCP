import type {Actor, JsonObject} from './types.js';
import type {Store} from './store.js';
import {recipeContext, recipeInputs, resolveBrief} from './recipe-context.js';
import {
  bindRecipeStep,
  campaignRecipe,
  recipeMissing,
  recipeProbePlanId,
  unbindRecipeStep,
} from './campaign-recipes.js';
import {recipeDependencies, readinessBinding} from './capability-eligibility.js';
import {normalizeAccount} from './scope.js';
import {MirrorError} from './errors.js';
import {fingerprint, optional, type ToolCall} from './workspace-core.js';
import {randomUUID} from 'node:crypto';
import {writePause} from './owner-operations.js';
import {storedLogin} from './connection-authority.js';
import {providerHooks} from './provider-hooks.js';

/** A bounded read-only assessment of the current compiled brief, never a write grant or saved campaign plan. */
export async function recipeEligibility(
  store: Store,
  call: ToolCall,
  preflight: ((actor: Actor, steps: JsonObject[]) => Promise<JsonObject>) | undefined,
  input: JsonObject,
  actor: Actor,
  inspectConversionGoals?: (actor: Actor, scope: JsonObject, current: () => void) => Promise<JsonObject>,
): Promise<JsonObject> {
  if (input.live !== undefined && typeof input.live !== 'boolean')
    throw new MirrorError('INVALID_ARGUMENT', 'live is an explicit boolean; false performs only local inspection.');
  const original = input;
  input = resolveBrief(store, actor, input);
  const context = recipeContext(store, actor, input.recipe, input.profile_id),
    resolved = recipeInputs(context, input.business ?? {}, {
      apply_playbook_rules: input.apply_playbook_rules,
      client_brief: input.client_brief,
    }),
    business = resolved.business,
    checkedAt = Date.now(),
    missing = recipeMissing(context.recipe, business),
    base = {
      version: 1,
      record_kind: 'recipe_eligibility',
      recipe_id: input.recipe,
      checked_at: checkedAt,
      expires_at: checkedAt + 5 * 60000,
      provenance: resolved.provenance,
      provider_mutations: 0,
      saved_plan: false,
      live_qualification: 'unverified',
    };
  if (missing.length)
    return {
      ...base,
      status: 'needs_user_input',
      local_compilation: 'needs_user_input',
      missing_fields: missing,
      dependencies: [],
      contracts: [],
      // The follow-up is the narrowed one when the brief names its account or login, so that following it lists that account and not every client's
      // (package r25-field3-recipes, fix round S4-1); a value that is not an exact short text is not carried.
      next_call: {
        tool: 'amcp_campaign',
        arguments: {
          action: 'recipe_context',
          recipe: input.recipe,
          ...(input.profile_id ? {profile_id: input.profile_id} : {}),
          ...Object.fromEntries(
            ['connection_id', 'account_id']
              .filter(key => typeof business[key] === 'string' && business[key] && business[key].length <= 200)
              .map(key => [key, business[key]]),
          ),
        },
      },
    };
  const compiled = campaignRecipe(input.recipe, business),
    steps = compiled.steps.map((step: JsonObject) => ({...step, depends_on: step.depends_on ?? []})),
    write = steps.find((step: JsonObject) => step.kind === 'write'),
    declared = recipeDependencies[input.recipe];
  if (!write || !declared)
    throw new MirrorError('READINESS_CONTRACT_UNAVAILABLE', 'The recipe has no declared native workflow dependencies.');
  const gateway = write.gateway,
    accountId = normalizeAccount(gateway, business.account_id),
    connection = store.resolveConnection(actor, gateway, accountId, business.connection_id),
    binding = readinessBinding(connection),
    credentialBinding = storedLogin(store, connection),
    pause = fingerprint(writePause(store, actor.tenantId)),
    scope = {gateway, connection_id: connection.id, account_id: accountId};
  const current = () => {
    store.assertActorActive(actor);
    if (
      readinessBinding(store.resolveConnection(actor, gateway, accountId, connection.id)) !== binding ||
      storedLogin(store, connection) !== credentialBinding ||
      fingerprint(writePause(store, actor.tenantId)) !== pause ||
      (context.profile &&
        store.document(actor.tenantId, 'client_profile', context.profile.id).revision !== context.profile.revision) ||
      Date.now() >= base.expires_at
    )
      throw new MirrorError(
        'STATE_CHANGED',
        'Account access, workspace controls, profile revision or evidence freshness changed. Inspect the current brief again.',
      );
  };
  const graph = await call(
    'amcp_workspace',
    {action: 'capabilities', view: 'graph', workflow_id: 'recipe:' + input.recipe, ...scope},
    actor,
  );
  current();
  if (!graph.success) throw new MirrorError(graph.error.code, graph.error.message, graph.error.details);
  const workflow = graph.data.workflows[0],
    target = workflow?.accounts.find(
      (a: JsonObject) => a.connection_id === connection.id && a.account_id === accountId,
    );
  if (!target) throw new MirrorError('ACCOUNT_SCOPE_MISMATCH', 'The selected account is unavailable for this recipe.');
  let native: JsonObject | undefined;
  if (input.live === true && !target.blockers.length && preflight) {
    // A compiled recipe's step leaves what a provider derives from the plan's own ID at a placeholder no request can carry (TikTok's request_id of an
    // Upgraded Smart+ create; R2.5 M4, the lead's decision L3), so its contract is checked with a probe, which this read-only check never sends. The preflight
    // itself binds nothing (S4-1, the lead's review of eb0c133f): the steps of a saved plan hold their values, and a hand-made placeholder is blocked there.
    native = await preflight(
      actor,
      steps.map((step: JsonObject) => bindRecipeStep(step, recipeProbePlanId)),
    );
    current();
    if (native.provider_mutations !== 0)
      throw new MirrorError('STATE_READ_FAILED', 'Eligibility requires a read-only preflight result.');
  }
  let conversionGoals: JsonObject | undefined;
  if (
    input.live === true &&
    !(native?.checks ?? []).some((c: JsonObject) => c.status === 'blocked') &&
    declared.objects.includes('account_default_conversion_goals') &&
    inspectConversionGoals
  ) {
    conversionGoals = await inspectConversionGoals(
      actor,
      {
        ...scope,
        currency: compiled.recipe.currency,
        ...(declared.objects.includes('conversion_value_configuration') ? {include_value_settings: true} : {}),
        ...(declared.objects.includes('reported_conversion_activity') ? {include_activity: true} : {}),
      },
      current,
    );
    current();
    if (conversionGoals.provider_mutations !== 0)
      throw new MirrorError('STATE_READ_FAILED', 'Conversion prerequisites require a read-only result.');
  }
  const accounts: JsonObject[] = [...(native?.account_evidence ?? [])];
  if (conversionGoals?.complete && !accounts.length) {
    const source = conversionGoals.source_references.at(-1),
      page = source.pages[0];
    accounts.push({
      ...scope,
      currency: conversionGoals.customer.currency,
      timezone: conversionGoals.customer.timezone,
      source_reference: {
        source_kind: 'native_account_conversion_settings_read',
        request: {method: source.request.method, path: source.request.path, body: {query: source.request.query}},
        response_hash: page.response_hash,
        captured_at: page.captured_at,
      },
    });
  }
  const checks: JsonObject[] = native?.checks ?? [],
    assets: JsonObject[] = checks.flatMap(check => check.assets ?? []),
    blockers = [
      ...target.blockers.map((code: string) => ({code, source: 'current_workspace_prerequisite'})),
      ...checks.filter(check => check.status === 'blocked').map(check => ({step_id: check.step, ...check.error})),
    ],
    dependencies = declared.objects.map((id: string) => {
      const out: JsonObject = {
        id,
        status: 'unknown',
        input_validation: 'compiled_recipe',
        meaning:
          'The declared input compiled locally. Native eligibility requires the current resource checks and later review.',
      };
      if (
        [
          'account_default_conversion_goals',
          'primary_conversion_actions',
          'conversion_value_configuration',
          'reported_conversion_activity',
        ].includes(id) &&
        conversionGoals
      ) {
        const status = conversionGoals.dependency_statuses?.[id] ?? 'unknown';
        Object.assign(out, {
          status,
          evidence: {
            kind: 'current_account_default_configuration',
            complete: conversionGoals.complete,
            state_hash: conversionGoals.state_hash ?? null,
            captured_at: conversionGoals.captured_at,
            summary: conversionGoals.summary ?? null,
            ...(conversionGoals.error ? {error: conversionGoals.error} : {}),
          },
          meaning:
            id === 'account_default_conversion_goals'
              ? 'The bounded current read checks account-default goal biddability only. It does not prove event delivery or objective acceptance.'
              : id === 'conversion_value_configuration'
                ? 'Current selected fields describe primary-action defaults and event-value overrides. Missing optional settings stay unknown; configured defaults do not prove delivered values, history or return.'
                : id === 'reported_conversion_activity'
                  ? 'Selected native dates describe the last reported conversion and tag detection in the account timezone. Missing dates stay unknown. A detected tag may have no attributable conversion; dates do not establish delivered values, recent volume, bidding eligibility or return.'
                  : 'The bounded current read checks enabled actions with explicit primary flags that match biddable goals. Missing optional flags stay unknown; event delivery and objective acceptance remain unverified.',
        });
        if (status === 'blocked')
          blockers.push({
            code:
              id === 'account_default_conversion_goals'
                ? 'GOOGLE_BIDDABLE_GOALS_UNAVAILABLE'
                : 'GOOGLE_PRIMARY_ACTIONS_UNAVAILABLE',
            source: 'current_conversion_configuration',
            message:
              id === 'account_default_conversion_goals'
                ? 'No biddable account-default conversion goal was found. Resolve the account settings before activation.'
                : 'No enabled explicit primary conversion action matches a biddable account-default goal. Resolve the account settings before activation.',
          });
      }
      if (id === 'account_currency') {
        const proof = accounts.find(a => a.connection_id === connection.id && a.account_id === accountId);
        if (proof)
          Object.assign(out, {
            status: 'ready',
            evidence: proof,
            meaning: 'The exact selected account read confirmed this currency. This is not objective acceptance.',
          });
      } else {
        // Every other dependency's evidence is its recipe's provider's (ARC-01 phase B, wave 4c: its adapter's
        // `campaign.dependencyEvidence`): Snapchat's creatives and lead form, TikTok's identity, post and pixel,
        // LinkedIn's lead form, Meta's Page, pixel and attribution windows, Google's explicit bidding settings and
        // Performance Max asset counts, each from the preflight's checked assets or the compiled brief.
        const evidence = providerHooks(gateway)?.campaign?.dependencyEvidence?.(id, {
          assets,
          scope,
          business,
          recipe: compiled.recipe,
          steps,
        });
        if (evidence) Object.assign(out, evidence);
      }
      return out;
    });
  dependencies.push({
    id: 'provider_objective_acceptance',
    status: 'unknown',
    meaning: 'Account/resource access does not prove that the provider accepts this exact objective and payload.',
  });
  const deferred = native?.deferred ?? [],
    status = blockers.length ? 'blocked' : 'unknown';
  const next =
    input.live !== true && !blockers.length ? {tool: 'amcp_campaign', arguments: {...original, live: true}} : undefined;
  // A live read-only preflight is kept for five minutes so the plan created from this exact brief can reuse it
  // instead of reading the provider again (CMP-06); it is applied only when every binding still matches.
  const eligibilityRef = native
    ? saveEligibility(store, actor, {
        recipe: input.recipe,
        profile: context.profile,
        business_fingerprint: resolved.provenance.business_fingerprint,
        steps_hash: eligibilityStepsHash(steps),
        binding,
        credential: fingerprint(credentialBinding),
        pause,
        preflight: native,
        checked_at: checkedAt,
        expires_at: base.expires_at,
      })
    : undefined;
  return {
    ...base,
    status,
    scope,
    local_compilation: 'passed',
    business_fingerprint: resolved.provenance.business_fingerprint,
    contracts: workflow.contracts,
    dependencies,
    ...(conversionGoals ? {conversion_goal_inspection: conversionGoals} : {}),
    accounts,
    blockers,
    deferred,
    ...(native
      ? {
          preflight: {status: native.status, checked_at: native.checked_at, plan_hash: native.plan_hash},
          eligibility_ref: eligibilityRef,
          warnings: native.warnings ?? [],
        }
      : {}),
    ...(next ? {next_call: next} : {}),
    meaning:
      'Inspection saves no campaign plan and submits no provider mutation. Ready dependency rows describe only their stated evidence; objective acceptance and verified predecessor IDs remain subject to native preparation and review.',
  };
}
/** The compiled steps as preflight checks them; a plan whose steps hash differently cannot reuse the result. */
export function eligibilityStepsHash(steps: JsonObject[]): string {
  return fingerprint(
    steps.map(s => ({
      id: s.id,
      kind: s.kind,
      gateway: s.gateway ?? null,
      connection_id: s.connection_id,
      account_id: s.account_id,
      arguments: s.arguments,
      depends_on: s.depends_on ?? [],
      expected_currency: s.expected_currency ?? null,
      prerequisites: s.prerequisites ?? [],
    })),
  );
}
/** Live eligibility checks one person keeps; an older one is removed when a newer one is saved. */
export const eligibilityRecordsPerUser = 20;
function saveEligibility(store: Store, actor: Actor, record: JsonObject): string {
  const id = randomUUID();
  store.transaction(() => {
    const checks = store.repo('recipe_eligibility', actor.tenantId);
    // Expired checks go in one statement (no scan of the workspace's documents in JavaScript); a check without an expiry
    // counts as expired (its declared expiry, src/document-kinds.ts).
    checks.purgeExpired(Date.now());
    store.putDocument(actor.tenantId, 'recipe_eligibility', id, {
      ...record,
      user_id: actor.userId,
      saved_at: Date.now(),
    });
    // Each person keeps their newest checks only; each one carries a whole native preflight result.
    checks.keepNewest('user_id', actor.userId, 'saved_at', eligibilityRecordsPerUser);
  });
  return id;
}
/**
 * Whether a saved plan may start from a live eligibility check instead of running preflight again (CMP-06): the same
 * person, recipe, playbook revision, resolved business inputs and compiled steps, the same login and account grant,
 * the same owner write pause, and an unexpired check. Anything else leaves the plan to run its own preflight.
 */
export function eligibilityReuse(
  store: Store,
  actor: Actor,
  ref: unknown,
  run: JsonObject,
  recipe: string,
  provenance: JsonObject,
): JsonObject {
  const refuse = (reason: string) => ({applied: false, eligibility_ref: ref, reason});
  if (typeof ref !== 'string') return refuse('unknown_reference');
  const record = optional(store, actor.tenantId, 'recipe_eligibility', ref);
  if (!record || record.user_id !== actor.userId) return refuse('unknown_reference');
  if (Date.now() >= Number(record.expires_at)) return refuse('expired');
  if (record.recipe !== recipe) return refuse('recipe_changed');
  const profile = provenance.profile ?? null;
  if ((record.profile?.id ?? null) !== (profile?.id ?? null)) return refuse('profile_changed');
  if (profile && optional(store, actor.tenantId, 'client_profile', profile.id)?.revision !== record.profile?.revision)
    return refuse('profile_revision_changed');
  if (record.business_fingerprint !== provenance.business_fingerprint) return refuse('brief_changed');
  // The saved steps compare as the compile made them: a field a provider gave from the plan's own ID (TikTok's request_id of an Upgraded
  // Smart+ create, R2.5 M4) is a value of this plan, and no part of what the eligibility check preflighted.
  if (record.steps_hash !== eligibilityStepsHash(run.steps.map(unbindRecipeStep))) return refuse('steps_changed');
  const write = run.steps.find((s: JsonObject) => s.kind === 'write');
  try {
    const connection = store.resolveConnection(actor, write.gateway, write.account_id, write.connection_id);
    if (readinessBinding(connection) !== record.binding) return refuse('account_access_changed');
    if (fingerprint(storedLogin(store, connection)) !== record.credential) return refuse('login_changed');
  } catch {
    return refuse('account_access_changed');
  }
  if (fingerprint(writePause(store, actor.tenantId)) !== record.pause) return refuse('write_pause_changed');
  return {
    applied: true,
    eligibility_ref: ref,
    checked_at: record.checked_at,
    preflight: {...record.preflight, seeded_from: {eligibility_ref: ref, checked_at: record.checked_at}},
  };
}
