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
  const accounts: JsonObject[] = native?.account_evidence ?? [],
    checks: JsonObject[] = native?.checks ?? [],
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
      if (id === 'account_currency') {
        const proof = accounts.find(a => a.connection_id === connection.id && a.account_id === accountId);
        if (proof)
          Object.assign(out, {
            status: 'ready',
            evidence: proof,
            meaning: 'The exact selected account read confirmed this currency. This is not objective acceptance.',
          });
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
