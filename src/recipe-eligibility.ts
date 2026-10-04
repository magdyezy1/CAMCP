import type {Actor, JsonObject} from './types.js';
import type {Store} from './store.js';
import {recipeContext, recipeInputs} from './recipe-context.js';
import {campaignRecipe} from './campaign-recipes.js';
import {recipeDependencies, readinessBinding} from './capability-eligibility.js';
import {normalizeAccount} from './scope.js';
import {MirrorError} from './errors.js';
import {fingerprint, type ToolCall} from './workspace-core.js';
import {writePause} from './owner-operations.js';

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
  const context = recipeContext(store, actor, input.recipe, input.profile_id),
    resolved = recipeInputs(context, input.business ?? {}),
    business = resolved.business,
    checkedAt = Date.now(),
    missing = context.recipe.required.filter((key: string) => business[key] === undefined || business[key] === ''),
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
      next_call: {
        tool: 'amcp_campaign',
        arguments: {
          action: 'recipe_context',
          recipe: input.recipe,
          ...(input.profile_id ? {profile_id: input.profile_id} : {}),
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
    credentialBinding = fingerprint(store.credentials(actor.tenantId, connection.id)),
    pause = fingerprint(writePause(store, actor.tenantId)),
    scope = {gateway, connection_id: connection.id, account_id: accountId};
  const current = () => {
    store.assertActorActive(actor);
    if (
      readinessBinding(store.resolveConnection(actor, gateway, accountId, connection.id)) !== binding ||
      fingerprint(store.credentials(actor.tenantId, connection.id)) !== credentialBinding ||
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
    {action: 'capabilities', workflow_id: 'recipe:' + input.recipe, ...scope},
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
    native = await preflight(actor, steps);
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
    conversionGoals = await inspectConversionGoals(actor, {...scope, currency: compiled.recipe.currency}, current);
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
      if (['account_default_conversion_goals', 'primary_conversion_actions'].includes(id) && conversionGoals) {
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
      } else if (['existing_website_creative', 'existing_lead_creative', 'existing_lead_form'].includes(id)) {
        const creative = assets.find(
          a =>
            a.asset_type === 'Snapchat creative' &&
            a.asset_id === business.creative_id &&
            a.account_id === scope.account_id &&
            a.connection_id === scope.connection_id,
        );
        const proof = assets.find(
          a =>
            a.asset_type === (id === 'existing_lead_form' ? 'Snapchat lead form' : 'Snapchat creative') &&
            a.asset_id === (id === 'existing_lead_form' ? creative?.lead_generation_form_id : business.creative_id) &&
            a.account_id === scope.account_id &&
            a.connection_id === scope.connection_id &&
            a.status === 'provider_read_checked',
        );
        if (proof) Object.assign(out, {status: 'ready', evidence: proof, meaning: proof.meaning});
      } else if (['page_identity', 'account_owned_pixel'].includes(id)) {
        const proof = assets.find(
          a =>
            a.asset_type === (id === 'page_identity' ? 'Facebook Page' : 'Meta pixel') &&
            a.status === 'provider_read_checked',
        );
        if (proof)
          Object.assign(out, {
            status: 'ready',
            evidence: proof,
            meaning: 'The account-scoped native collection confirmed access to this exact resource.',
          });
      } else if (id === 'attribution_window')
        Object.assign(out, {
          status: 'ready',
          evidence: {
            kind: 'compiled_explicit_settings',
            windows: steps.find((step: JsonObject) => step.id === 'adset')?.arguments.payload.attribution_spec,
          },
          meaning:
            'The explicit settings match the local recipe contract. Historical attribution and event delivery remain unverified.',
        });
      else if (id === 'campaign_cpc_ceiling')
        Object.assign(out, {
          status: 'ready',
          evidence: {kind: 'compiled_explicit_setting', ceiling: business.cpc_bid_ceiling},
          meaning:
            'The explicit ceiling passed exact native-unit compilation. Provider acceptance occurs during review.',
        });
      else if (id === 'conversion_value_policy')
        Object.assign(out, {
          status: 'ready',
          evidence: {kind: 'compiled_explicit_setting', policy: compiled.recipe.conversion_value_policy},
          meaning:
            'The operator explicitly chose recorded account values. This does not establish configured or delivered conversion values.',
        });
      else if (id === 'campaign_target_roas')
        Object.assign(out, {
          status: 'ready',
          evidence: {kind: 'compiled_explicit_setting', ratio: compiled.recipe.target_roas},
          meaning:
            'The explicit ratio passed local validation. Provider acceptance, historical eligibility and actual return remain unverified.',
        });
      else if (id === 'campaign_target_cpa')
        Object.assign(out, {
          status: 'ready',
          evidence: {kind: 'compiled_explicit_setting', target_cpa_micros: compiled.recipe.target_cpa_micros},
          meaning:
            'The explicit target CPA passed exact native-unit compilation. It is an average optimization target; provider acceptance and performance remain unverified.',
        });
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
    input.live !== true && !blockers.length ? {tool: 'amcp_campaign', arguments: {...input, live: true}} : undefined;
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
          warnings: native.warnings ?? [],
        }
      : {}),
    ...(next ? {next_call: next} : {}),
    meaning:
      'Inspection saves no campaign plan and submits no provider mutation. Ready dependency rows describe only their stated evidence; objective acceptance and verified predecessor IDs remain subject to native preparation and review.',
  };
}
