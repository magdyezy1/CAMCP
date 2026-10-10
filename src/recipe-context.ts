import {campaignRecipes, metaConversionRecipes, googleConversionRecipes} from './campaign-recipes.js';
import {Store} from './store.js';
import {MirrorError} from './errors.js';
import {audit, bad, noSecrets, fingerprint, obj, optional, read, update, validate, writer} from './workspace-core.js';
import {randomUUID} from 'node:crypto';
import {expandTemplate, tagLandingPage} from './client-playbooks.js';
import type {Actor, JsonObject} from './types.js';
import {normalizeAccount} from './scope.js';
// Business inputs a client playbook may default per recipe. Regulated declarations, goal policies, resource IDs and
// currency stay in each brief, where preflight checks them.
export const profileDefaultKeys = [
  'daily_budget',
  'cpc_bid',
  'cpc_bid_ceiling',
  'target_cpa',
  'target_roas',
  'country_codes',
  'country_criterion_ids',
  'language_criterion_ids',
  'destination_url',
  'keywords',
  'headlines',
  'descriptions',
  'language',
];
/**
 * The recipes a playbook can hold defaults for, with only those fields (WEB-06). The workspace profiles response
 * carries them, so Clients & templates opens without the campaign tool, which a test account may not use.
 */
export function recipeDefaultFields(): JsonObject[] {
  return campaignRecipes.map(r => ({
    id: r.id,
    name: r.name,
    platform: r.platform,
    fields: r.required.filter(k => profileDefaultKeys.includes(k)),
  }));
}
export function recipeContext(store: Store, actor: Actor, recipeId: string, profileId?: string): JsonObject {
  store.assertActorActive(actor);
  const recipe = campaignRecipes.find(r => r.id === recipeId);
  if (!recipe) throw new MirrorError('RECIPE_NOT_FOUND', 'Choose an available campaign recipe.');
  const profile = profileId ? store.document(actor.tenantId, 'client_profile', profileId) : undefined,
    gateway =
      (
        {google: 'google_ads', meta: 'meta', microsoft: 'microsoft_ads', snapchat: 'snapchat'} as Record<string, string>
      )[recipe.platform] + '_native_action';
  const inventory = store.documents(actor.tenantId, 'website_assets'),
    targets = store
      .listConnections(actor.tenantId)
      .filter(c => c.gateway === gateway && c.enabled)
      .flatMap(c =>
        c.accounts
          .filter(
            account =>
              !profile?.bindings?.length ||
              profile.bindings.some(
                (b: JsonObject) =>
                  b.gateway === gateway &&
                  b.connection_id === c.id &&
                  normalizeAccount(gateway, b.account_id) === normalizeAccount(gateway, account),
              ),
          )
          .map(account => {
            const snapshot = inventory.find(a => a.id === c.id),
              asset = (snapshot?.groups ?? [])
                .flatMap((g: JsonObject) => g.assets ?? [])
                .find((a: JsonObject) => String(a.id).replace(/^act_/, '') === account);
            return {
              connection_id: c.id,
              account_id: account,
              // The login, account name and ID, each once: an account without a cached name is not repeated (CMP-06).
              label: [c.label, asset?.name, account]
                .filter((part, i, all) => typeof part === 'string' && part !== '' && all.indexOf(part) === i)
                .join(' · '),
              currency: asset?.currency ?? null,
              timezone: asset?.timezone ?? null,
              write_granted: c.writeAccounts?.includes(account) === true,
              metadata_source: 'cached discovery; verified again during preflight',
            };
          }),
      );
  // Shared defaults (defaults.common) apply to every recipe that takes the field; a recipe's own defaults win (CMP-06).
  const common = profile?.defaults?.common ?? {},
    own = profile?.defaults?.recipes?.[recipeId] ?? {};
  if (!obj(common) || !obj(own)) throw new MirrorError('INVALID_PROFILE', 'Recipe defaults must be an object.');
  const defaults = {
    ...Object.fromEntries(
      Object.entries(common).filter(([key]) => profileDefaultKeys.includes(key) && recipe.required.includes(key)),
    ),
    ...own,
  };
  noSecrets(defaults);
  return {
    version: 1,
    recipe,
    targets,
    defaults,
    profile: profile ? {id: profile.id, revision: profile.revision, name: profile.name} : null,
    conventions: playbookConventions(profile),
    pages: inventory.flatMap(i =>
      (i.groups ?? [])
        .filter((g: JsonObject) => g.kind === 'pages')
        .flatMap((g: JsonObject) => g.assets.map((a: JsonObject) => ({id: a.id, name: a.name, connection_id: i.id}))),
    ),
    drive_connections: store
      .listConnections(actor.tenantId)
      .filter(c => c.gateway === 'google_drive_native_action' && c.enabled)
      .map(c => ({id: c.id, label: c.label, files: c.accounts})),
    limitations:
      recipe.platform === 'snapchat'
        ? recipeId === 'snapchat_lead_generation'
          ? [
              'Uses an existing LEAD_GENERATION creative and its original account-owned form without editing either. Choose swipe or form-submission optimization explicitly. Native review reads both again; provider eligibility, privacy-policy availability and consent acceptance remain unverified. Activation is separate.',
            ]
          : [
              'Uses an existing WEB_VIEW creative without editing its destination or media. Inspect its exact account, destination and approval before review. Automatic swipe bidding may spend the daily budget; activation is separate.',
            ]
        : recipe.platform === 'microsoft'
          ? ['This Search recipe does not set geography. Configure qualified location targeting before activation.']
          : googleConversionRecipes[recipeId]?.value
            ? [
                'Uses recorded conversion values and account-default goals without editing either. Inspect current primary-action value defaults and reported activity dates, then verify delivered values, conversion history and provider eligibility before activation. A target ROAS is an average ratio, not guaranteed return or a spending cap.',
              ]
            : googleConversionRecipes[recipeId]
              ? [
                  'Uses account-default conversion goals without changing them. Verify current biddable goals, primary conversion actions, event delivery and provider eligibility before activation. A target CPA is an average optimization target, not a spending cap or guarantee.',
                ]
              : metaConversionRecipes[recipeId]
                ? [
                    'Uses the selected website pixel with ' +
                      metaConversionRecipes[recipeId]!.event +
                      '. Pixel/Page access is checked during preflight; active event delivery, provider objective eligibility and landing-page policy acceptance require separate evidence.',
                  ]
                : [],
    prerequisites: [
      'current account grant',
      'verified account currency',
      recipe.platform === 'snapchat'
        ? recipeId === 'snapchat_lead_generation'
          ? 'existing account-owned lead creative and form with explicit optimization/country/schedule inputs'
          : 'existing account-owned website creative and explicit country/schedule inputs'
        : 'required Page/media or search inputs',
      'whole-plan preflight',
      'review each resolved mutation',
      'provider read-back',
    ],
  };
}
/**
 * The naming and tracking rules of an approved playbook that recipe compilation applies (CMP-06), or null when the
 * playbook has none. A named-template naming object applies its `campaign` template.
 */
export function playbookConventions(profile: JsonObject | undefined): JsonObject | null {
  if (!profile) return null;
  const naming =
      typeof profile.naming === 'string'
        ? profile.naming.trim()
        : obj(profile.naming) && typeof profile.naming.campaign === 'string'
          ? profile.naming.campaign.trim()
          : '',
    utm = Object.fromEntries(
      Object.entries(obj(profile.utm) ? profile.utm : {}).filter(
        ([key, value]) => /^utm_[a-z]+$/.test(key) && typeof value === 'string' && value.trim() !== '',
      ),
    );
  if (!naming && !Object.keys(utm).length) return null;
  return {naming: naming || null, utm, variables: obj(profile.variables) ? profile.variables : {}};
}
const conventionText = (template: string, variables: JsonObject, rule: string): string => {
  try {
    return String(expandTemplate(template, variables)).trim();
  } catch {
    const missing = [...template.matchAll(/\{\{([A-Za-z0-9_.-]+)\}\}/g)]
      .map(m => m[1]!)
      .filter(key => !['campaign_name', 'profile.name', 'profile.id', 'profile.revision'].includes(key));
    throw new MirrorError(
      'PLAYBOOK_CONVENTION_UNRESOLVED',
      'A client playbook rule uses a variable this brief does not supply. Add it to the playbook variables, or turn off playbook rules for this plan.',
      {rule, template, variables: missing},
    );
  }
};
/**
 * Applies a playbook's naming and UTM rules to a brief (CMP-06): the campaign name comes from the naming template
 * with {{campaign_name}} as the name typed, and each UTM rule is appended to the landing page (tagLandingPage, which
 * the playbook preview shares). A URL that already sets a different value for one of those parameters is refused
 * rather than silently rewritten; the same value is kept once. Limits are checked after derivation.
 */
export function applyPlaybookConventions(
  conventions: JsonObject,
  business: JsonObject,
  profile: JsonObject | null,
  recipe: JsonObject,
): {business: JsonObject; record: JsonObject} {
  const out = {...business},
    record: JsonObject = {version: 1, applied: true, source: 'approved_profile_convention', profile};
  const variables = {
    ...conventions.variables,
    campaign_name: typeof business.name === 'string' ? business.name : '',
    profile: {id: profile?.id ?? '', name: profile?.name ?? '', revision: profile?.revision ?? ''},
  };
  if (conventions.naming && typeof business.name === 'string' && business.name.trim()) {
    const result = conventionText(conventions.naming, variables, 'naming');
    if (!result || result.length > 100)
      throw new MirrorError(
        'PLAYBOOK_NAME_TOO_LONG',
        'The client playbook naming rule makes a campaign name outside 1–100 characters. Shorten the name typed or the naming rule, or turn off playbook rules for this plan.',
        {name: result, length: result.length, limit: 100},
      );
    record.name = {input: business.name, result, template: conventions.naming};
    out.name = result;
  }
  const utm = Object.entries(conventions.utm as Record<string, string>);
  if (utm.length && recipe.required.includes('destination_url') && typeof business.destination_url === 'string') {
    let valid = true;
    try {
      new URL(business.destination_url);
    } catch {
      valid = false;
    }
    // An invalid landing page is refused by the recipe itself with its own message.
    if (valid) {
      const {result, parameters} = tagLandingPage(
        business.destination_url,
        Object.fromEntries(utm.map(([key, template]) => [key, conventionText(template, variables, key)])),
      );
      if (result.length > 2048)
        throw new MirrorError(
          'PLAYBOOK_URL_TOO_LONG',
          'The tagged landing page is longer than 2,048 characters. Shorten the URL or the tracking rules, or turn off playbook rules for this plan.',
          {length: result.length, limit: 2048},
        );
      record.destination_url = {input: business.destination_url, result, parameters};
      out.destination_url = result;
    }
  }
  return {business: out, record};
}
export function recipeInputs(context: JsonObject, input: JsonObject, options: JsonObject = {}): JsonObject {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new MirrorError('RECIPE_INPUT_REQUIRED', 'Supply business inputs.');
  noSecrets(input);
  if (options.apply_playbook_rules !== undefined && typeof options.apply_playbook_rules !== 'boolean')
    throw new MirrorError('INVALID_ARGUMENT', 'apply_playbook_rules is true or false.');
  let business: JsonObject = {...context.defaults, ...input},
    conventions: JsonObject | undefined;
  // A selected playbook's naming and tracking rules apply by default; the person may turn them off for one plan.
  if (context.conventions && options.apply_playbook_rules === false)
    conventions = {version: 1, applied: false, source: 'user_override', profile: context.profile};
  else if (context.conventions) {
    const applied = applyPlaybookConventions(context.conventions, business, context.profile, context.recipe);
    business = applied.business;
    conventions = applied.record;
  }
  const fields = Object.fromEntries(
    Object.keys(business).map(k => [
      k,
      conventions?.applied && conventions[k]
        ? {
            source: 'approved_profile_convention',
            input_source: Object.hasOwn(input, k) ? 'user' : 'approved_profile',
            profile_id: context.profile?.id,
            profile_revision: context.profile?.revision,
          }
        : Object.hasOwn(input, k)
          ? {source: 'user'}
          : {source: 'approved_profile', profile_id: context.profile?.id, profile_revision: context.profile?.revision},
    ]),
  );
  return {
    business,
    provenance: {
      version: 1,
      recipe_id: context.recipe.id,
      profile: context.profile,
      business_fingerprint: fingerprint(business),
      fields,
      ...(conventions ? {conventions} : {}),
      ...(options.client_brief ? {client_brief: options.client_brief} : {}),
    },
  };
}
/**
 * A saved client brief supplies the recipe, playbook and business inputs a later call would otherwise repeat
 * (CMP-06). Inputs sent with the call override the brief's; the brief's recipe must match an explicit one.
 */
export function resolveBrief(store: Store, actor: Actor, input: JsonObject): JsonObject {
  if (input.brief_id === undefined) return input;
  const brief = read(store, actor, 'client_brief', input.brief_id);
  if (input.recipe !== undefined && input.recipe !== brief.recipe)
    throw new MirrorError(
      'BRIEF_RECIPE_MISMATCH',
      'This saved brief is for a different workflow. Omit recipe, or choose the brief’s workflow.',
      {brief_recipe: brief.recipe},
    );
  if (input.business !== undefined && !obj(input.business))
    throw new MirrorError('RECIPE_INPUT_REQUIRED', 'Supply business inputs as an object.');
  return {
    ...input,
    recipe: brief.recipe,
    ...(input.profile_id === undefined && brief.profile_id ? {profile_id: brief.profile_id} : {}),
    business: {...brief.business, ...(input.business ?? {})},
    client_brief: {id: brief.id, revision: brief.revision, name: brief.name},
  };
}
/** At most this many saved client briefs per workspace (CMP-06). */
export const clientBriefLimit = 200;
const briefSummary = (b: JsonObject) => ({
  id: b.id,
  name: b.name,
  recipe: b.recipe,
  objective: b.objective ?? null,
  profile_id: b.profile_id ?? null,
  profile_revision: b.profile_revision ?? null,
  created_by: b.created_by,
  revision: b.revision,
  updated_at: b.updated_at ?? null,
});
/**
 * Saved client briefs (CMP-06): a named recipe, playbook and business inputs that a later preview, eligibility check
 * or plan reuses with brief_id. A brief grants nothing: accounts, currency and every provider prerequisite are checked
 * again when it is used, and a plan records the brief revision it came from.
 */
export function clientBriefs(store: Store, actor: Actor, input: JsonObject): JsonObject {
  if (input.action === 'briefs') {
    store.assertActorActive(actor);
    const briefs = store
      .documents(actor.tenantId, 'client_brief')
      .sort((a, b) => Number(b.updated_at ?? 0) - Number(a.updated_at ?? 0) || String(a.name).localeCompare(b.name));
    return {briefs: briefs.map(briefSummary), total: briefs.length, limit: clientBriefLimit};
  }
  if (input.action === 'brief') return read(store, actor, 'client_brief', input.id);
  writer(store, actor);
  if (input.action === 'delete_brief') {
    if (input.confirmed !== true) bad('Confirm brief deletion.');
    const brief = read(store, actor, 'client_brief', input.id);
    if (input.revision !== brief.revision) bad('Reload the current brief.', 'REVISION_CONFLICT');
    store.db
      .prepare('DELETE FROM documents WHERE tenant_id=? AND kind=? AND id=? AND revision=?')
      .run(actor.tenantId, 'client_brief', brief.id, brief.revision);
    audit(store, actor, 'client_brief_deleted', {id: brief.id});
    return {deleted: true};
  }
  const b = input.brief;
  if (!obj(b)) bad('Supply the brief: {name, recipe, profile_id?, business}.');
  validate(b, ['name', 'recipe', 'profile_id', 'business']);
  noSecrets(b);
  if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100) bad('Brief name must be 1–100 characters.');
  const recipe = campaignRecipes.find(r => r.id === b.recipe);
  if (!recipe) throw new MirrorError('RECIPE_NOT_FOUND', 'Choose an available campaign recipe.');
  if (!obj(b.business)) bad('Supply the business inputs as an object.', 'RECIPE_INPUT_REQUIRED');
  if (JSON.stringify(b.business).length > 32768) bad('Keep a brief’s business inputs under 32 KB.');
  const profile =
    b.profile_id === undefined || b.profile_id === null || b.profile_id === ''
      ? undefined
      : read(store, actor, 'client_profile', b.profile_id);
  const id = input.id ?? randomUUID(),
    previous = optional(store, actor.tenantId, 'client_brief', id);
  if (!previous && store.documents(actor.tenantId, 'client_brief').length >= clientBriefLimit)
    bad('Limit reached: ' + clientBriefLimit + ' saved client briefs.', 'LIMIT_REACHED');
  const record = update(
    store,
    actor,
    'client_brief',
    id,
    {
      name: b.name.trim(),
      recipe: recipe.id,
      objective: recipeObjective(recipe.id),
      profile_id: profile?.id ?? null,
      profile_revision: profile?.revision ?? null,
      business: b.business,
      created_by: previous?.created_by ?? actor.userId,
      created_at: previous?.created_at ?? Date.now(),
      updated_by: actor.userId,
      updated_at: Date.now(),
    },
    input.revision,
  );
  audit(store, actor, 'client_brief_saved', {id, revision: record.revision, recipe: recipe.id});
  return record;
}
/** The business objective a recipe serves, for grouping briefs and the website's objective-first chooser. */
export function recipeObjective(id: string): string {
  if (id.includes('lead')) return 'leads';
  if (id === 'meta_website_sales') return 'sales';
  if (id.endsWith('_traffic')) return 'traffic';
  return 'search';
}
