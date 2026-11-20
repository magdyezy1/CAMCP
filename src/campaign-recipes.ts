import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';
import type {CampaignRecipe, RecipeDefinition} from './provider-adapter.js';
import {providerById} from './provider-adapters.js';
import {providerHooks, registeredProviderHooks} from './provider-hooks.js';
// The Meta and Google conversion tables live with their providers' builders (src/meta-website-recipes.ts,
// src/google-search-recipes.ts); recipe_context reads each recipe's own context instead (wave 4c), so nothing imports
// them from here any more.

/**
 * The guided campaign recipes (ARC-04): campaignRecipe was one 706-line function whose provider branches built each
 * recipe's plan, and is now a table of per-recipe builders. Each provider declares its recipes, a catalog entry and a
 * builder each, in its adapter hooks (ARC-01 phase B: `campaign.recipes`, registered in src/provider-hooks.ts); the
 * catalog lists them in the order of `recipeProviders` and keeps the checks every brief passes before its builder runs.
 */
/** The providers whose recipes the catalog lists, in its order, by provider ID (src/provider-adapters.ts). */
const recipeProviders = ['meta', 'google', 'microsoft', 'snapchat', 'tiktok', 'linkedin'];
const providerRecipes = (id: string): readonly CampaignRecipe[] =>
  providerHooks(providerById(id)?.gateway)?.campaign?.recipes ?? [];
const recipeTable = new Map<string, CampaignRecipe>(
  recipeProviders.flatMap(providerRecipes).map(recipe => [recipe.definition.id, recipe]),
);
// A load-time check, like the grant order's: every provider that declares recipes is listed once, every recipe has its
// own ID, and each recipe's platform is the ID of the provider that declares it (whose gateway its plan writes to).
if (
  new Set(recipeProviders).size !== recipeProviders.length ||
  recipeProviders.some(id => !providerRecipes(id).length) ||
  registeredProviderHooks.some(
    hooks =>
      hooks.campaign?.recipes?.length && !recipeProviders.some(id => providerById(id)?.gateway === hooks.gateway),
  ) ||
  recipeTable.size !== recipeProviders.flatMap(providerRecipes).length ||
  recipeProviders.some(id => providerRecipes(id).some(recipe => recipe.definition.platform !== id))
)
  throw new Error(
    'The campaign recipe catalog must list every provider that declares recipes once, each recipe by its own ID.',
  );
/** Every recipe's catalog entry, in catalog order. */
export const campaignRecipes: RecipeDefinition[] = [...recipeTable.values()].map(recipe => recipe.definition);
/** A recipe as its provider declares it (its builder and its recipe_context facts), or undefined for an unknown ID. */
export function campaignRecipeOf(id: string): CampaignRecipe | undefined {
  return recipeTable.get(id);
}
/** The gateway of a recipe's platform: its declaring provider's, whose accounts its plan writes to. */
export function recipeGateway(id: string): string | undefined {
  const recipe = recipeTable.get(id);
  return recipe ? providerById(recipe.definition.platform)?.gateway : undefined;
}
/**
 * The plan ID a read-only check binds a compiled recipe with (the preflight and the eligibility check, which send nothing and save
 * nothing), so that a field a provider's compile leaves for the plan's own ID (`bindToPlan`) holds a value its contract accepts.
 */
export const recipeProbePlanId = 'recipe-probe';
/**
 * A recipe's step as a saved plan with this ID holds it (R2.5 M4, the lead's decision L3): the provider's `bindToPlan` gives a field the
 * compile left open its value for that plan; a step that is no write, and a step with nothing open, are returned as they are.
 */
export function bindRecipeStep(step: JsonObject, planId: string): JsonObject {
  return step.kind === 'write' && typeof step.gateway === 'string'
    ? (providerHooks(step.gateway)?.campaign?.bindToPlan?.(step, planId) ?? step)
    : step;
}
/** The step as the compile made it: the fields `bindRecipeStep` gave are at their placeholder again (the provider's `unbindFromPlan`). */
export function unbindRecipeStep(step: JsonObject): JsonObject {
  return step.kind === 'write' && typeof step.gateway === 'string'
    ? (providerHooks(step.gateway)?.campaign?.unbindFromPlan?.(step) ?? step)
    : step;
}
/** The required inputs a brief still lacks; an input satisfied by one of its listed alternatives is not missing. */
export function recipeMissing(definition: JsonObject, b: JsonObject): string[] {
  const given = (key: string) => b[key] !== undefined && b[key] !== '';
  return definition.required.filter(
    (k: string) => !given(k) && !(definition.alternatives?.[k] ?? []).some((alternative: string) => given(alternative)),
  );
}
/**
 * CMP-03 compatibility: a microsoft_search plan drafted before the recipe set location targets has no `targets` step, so
 * it would create a campaign Microsoft could serve in any location it supports. While nothing of it has been prepared
 * it is refused with the new required input named, and is drafted again from the recipe. A plan that already prepared
 * a step, or continues another, keeps its recovery: its campaign is still activated only with a positive location
 * criterion (microsoft-native.ts).
 */
export function assertRecipeDraftCurrent(run: JsonObject): void {
  if (
    run.recipe?.id !== 'microsoft_search' ||
    run.activation_of ||
    run.supersedes ||
    !Array.isArray(run.steps) ||
    run.steps.some((s: JsonObject) => s.id === 'targets' || s.status !== 'pending')
  )
    return;
  throw new MirrorError(
    'RECIPE_INPUT_REQUIRED',
    'This Microsoft Search plan was drafted before the recipe set location targets, so it would create a campaign Microsoft could serve in any location it supports. Draft it again from the recipe with location_ids.',
    {missing_fields: ['location_ids'], recipe: 'microsoft_search'},
  );
}
export function campaignRecipe(id: string, b: JsonObject): JsonObject {
  const recipe = recipeTable.get(id),
    definition = recipe?.definition;
  if (!definition) throw new MirrorError('RECIPE_NOT_FOUND', 'Choose an available campaign recipe.');
  if (!b || typeof b !== 'object') throw new MirrorError('RECIPE_INPUT_REQUIRED', 'Provide the business inputs.');
  const missing = recipeMissing(definition, b);
  if (missing.length)
    throw new MirrorError('RECIPE_INPUT_REQUIRED', 'Complete the brief before creating the campaign plan.', {
      missing_fields: missing,
    });
  if (
    !/^[A-Z]{3}$/.test(b.currency) ||
    typeof b.name !== 'string' ||
    b.name.length > 100 ||
    typeof b.account_id !== 'string' ||
    typeof b.connection_id !== 'string'
  )
    throw new MirrorError('RECIPE_INPUT_INVALID', 'Use a name, explicit account/connection and ISO currency.');
  return recipe!.build(b);
}
