/**
 * What the guided Search and website recipes share (ARC-04): campaignRecipe (src/campaign-recipes.ts) became a table of
 * per-recipe builders that each provider declares in its adapter hooks, and these are the parts its Meta, Google Search
 * and Microsoft Search branches shared. Each helper raises the refusal campaignRecipe raised, so a builder calls them in
 * campaignRecipe's order: the atomic flag, the destination, the steps, then its own inputs.
 */
import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

/** A list input of a brief: `min` to `max` nonempty strings. */
export function recipeStrings(v: unknown, name: string, min = 1, max = 50): string[] {
  if (!Array.isArray(v) || v.length < min || v.length > max || v.some(x => typeof x !== 'string' || !x.trim()))
    throw new MirrorError('RECIPE_INPUT_REQUIRED', 'Provide ' + name + ' (' + min + '–' + max + ' nonempty items).', {
      missing_fields: [name],
    });
  return v;
}
/** atomic belongs to the Google Search recipes: true (the default) builds the campaign in one step (CMP-04). */
export function assertRecipeAtomic(definition: JsonObject, b: JsonObject): void {
  if (b.atomic !== undefined && (definition.platform !== 'google' || typeof b.atomic !== 'boolean'))
    throw new MirrorError(
      'RECIPE_INPUT_INVALID',
      'atomic applies to Google Search recipes only: true (the default) builds the campaign in one all-or-nothing step, false one step per resource type.',
      {field: 'atomic'},
    );
}
/** The brief's landing page: a full, public HTTPS URL without credentials. */
export function recipeDestination(b: JsonObject): URL {
  let url: URL;
  try {
    url = new URL(b.destination_url);
  } catch {
    throw new MirrorError('DESTINATION_REQUIRED', 'Use a full HTTPS landing page URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new MirrorError('DESTINATION_REQUIRED', 'Use a public HTTPS landing page URL without credentials.');
  return url;
}
/** The plan's steps, a reference to an earlier step's result, and the write step of `gateway` that `add` appends. */
export function recipeSteps(b: JsonObject, gateway: string) {
  const steps: JsonObject[] = [],
    ref = (step: string, path: string) => ({$ref: step + '#' + path});
  const add = (sid: string, action: string, payload: JsonObject, deps: string[] = []) =>
    steps.push({
      id: sid,
      kind: 'write',
      gateway,
      expected_currency: b.currency,
      account_id: b.account_id,
      connection_id: b.connection_id,
      arguments: {action, payload},
      depends_on: deps,
    });
  return {steps, ref, add};
}
/** A Search recipe's headlines, descriptions and exact keywords, within the responsive search ad limits. */
export function recipeSearchText(b: JsonObject) {
  const headlines = recipeStrings(b.headlines, 'headlines', 3, 15),
    descriptions = recipeStrings(b.descriptions, 'descriptions', 2, 4),
    keywords = recipeStrings(b.keywords, 'keywords', 1, 25);
  if (headlines.some(h => h.length > 30) || descriptions.some(d => d.length > 90) || keywords.some(k => k.length > 80))
    throw new MirrorError(
      'AD_TEXT_LIMIT',
      'Use headlines of at most 30 characters, descriptions of at most 90, and keywords of at most 80.',
    );
  return {headlines, descriptions, keywords};
}
/**
 * A Search recipe's schedule: YYYY-MM-DD dates in the advertising account's time zone, each passed to `place` once
 * it is valid, and an end on or after the start.
 */
export function recipeDates(b: JsonObject, place: (key: string) => void): void {
  for (const k of ['start_date', 'end_date'])
    if (b[k] !== undefined) {
      if (
        typeof b[k] !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(b[k]) ||
        !Number.isFinite(Date.parse(b[k] + 'T00:00:00Z')) ||
        new Date(b[k] + 'T00:00:00Z').toISOString().slice(0, 10) !== b[k]
      )
        throw new MirrorError('RECIPE_DATE_INVALID', 'Use valid YYYY-MM-DD dates in the advertising account timezone.');
      place(k);
    }
  if (b.start_date && b.end_date && b.end_date < b.start_date)
    throw new MirrorError('RECIPE_DATE_INVALID', 'End date must be on or after start date.');
}
/** The plan a recipe builds: the create of its steps, with the brief's summary and the recipe's own record. */
export function recipePlan(
  definition: JsonObject,
  b: JsonObject,
  steps: JsonObject[],
  notes: string,
  recipe: JsonObject,
): JsonObject {
  return {
    action: 'create',
    name: b.name,
    brief:
      definition.name +
      ' in ' +
      b.currency +
      '. The campaign starts paused. ' +
      notes +
      'Confirm destination, identity, policy eligibility and native prerequisites during whole-plan preflight; activation is a separate reviewed change.',
    steps,
    recipe,
  };
}
