import {campaignRecipeOf, campaignRecipes, recipeGateway} from './campaign-recipes.js';
// The Drive logins a recipe's media may come from: the Drive provider's gateway, from the leaf registry (wave 4c).
import {providerById} from './provider-adapters.js';
import {Store} from './store.js';
import {MirrorError} from './errors.js';
import {audit, bad, noSecrets, fingerprint, obj, optional, read, update, validate, writer} from './workspace-core.js';
import {randomUUID} from 'node:crypto';
import {expandTemplate, tagLandingPage} from './client-playbooks.js';
import type {Actor, JsonObject} from './types.js';
import {normalizeAccount} from './scope.js';
import {accountMetadataView, resolveAccountMetadata} from './account-metadata.js';
import {profileWithinAccess, visibleProfile} from './client-scope.js';
import {currentContractProfile, isClientCall} from './contract-profile.js';
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
  'location_ids',
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
/**
 * The inputs of a recipe that are declarations (`declaration` in its `inputs`): the person's own statements of a fact, which no client playbook
 * supplies (R2.5 field3 fix round, the lead's review S2-2). With no recipe, every input that is a declaration in any recipe, which is what a
 * playbook's shared defaults (`defaults.common`) are checked against, as they apply to every recipe that takes the field.
 */
export function recipeDeclarations(recipeId?: string): string[] {
  const names = campaignRecipes
    .filter(r => recipeId === undefined || r.id === recipeId)
    .flatMap(r => Object.entries(r.inputs).flatMap(([key, spec]) => (spec.declaration === true ? [key] : [])));
  return [...new Set(names)];
}
/**
 * The declarations of every recipe, for the website's playbook editor (R2.5 field3 follow-up, the lead's re-review S3-5): the names the shared
 * defaults are checked against, and the names of each recipe that has any. The editor takes them out of a playbook it saves, as the server refuses to.
 */
export function recipeDeclarationFields(): JsonObject {
  return {
    common: recipeDeclarations(),
    recipes: Object.fromEntries(
      campaignRecipes.flatMap(r => {
        const names = recipeDeclarations(r.id);
        return names.length ? [[r.id, names]] : [];
      }),
    ),
  };
} /** The gateway of the Google Drive logins a recipe's media may come from. */
const driveGateway = providerById('drive')?.gateway;
/**
 * What a call of `recipe_context` may narrow its accounts by (AMCP-06, R2.5 field3 package r25-field3-recipes): the account the agent works
 * on (in the account form of the recipe's platform), the login it is under, or both; and `gateway`, which must be the recipe's own. A call
 * with none of them is the unfiltered context the internal callers (preview, creation, eligibility) have always had.
 */
export interface RecipeContextScope {
  readonly account_id?: string;
  readonly connection_id?: string;
  readonly gateway?: string;
}
export function recipeContext(
  store: Store,
  actor: Actor,
  recipeId: string,
  profileId?: string,
  scope: RecipeContextScope = {},
): JsonObject {
  store.assertActorActive(actor);
  const recipe = campaignRecipes.find(r => r.id === recipeId);
  if (!recipe) throw new MirrorError('RECIPE_NOT_FOUND', 'Choose an available campaign recipe.');
  // A profile outside the actor's client access set is not found, like one that does not exist (SEC-08).
  const profile = profileId ? visibleProfile(store, actor, profileId) : undefined,
    // The recipe's platform gateway is its declaring provider's (src/campaign-recipes.ts), and what the context says
    // of the recipe beyond its definition is the recipe's own (ARC-01 phase B, wave 4c: its adapter's recipes).
    gateway = recipeGateway(recipeId)!,
    facts = campaignRecipeOf(recipeId)?.context;
  // The gateway a call names is the recipe's own or nothing (AMCP-06): a recipe of another platform is a conflict in the request.
  if (scope.gateway !== undefined && scope.gateway !== gateway)
    throw new MirrorError(
      'CONFLICTING_PARAMETER',
      'The recipe runs on another gateway than the one named; the details name the recipe’s gateway.',
      {recipe_gateway: gateway},
    );
  const inventory = store.documents(actor.tenantId, 'website_assets'),
    filtered = scope.account_id !== undefined || scope.connection_id !== undefined,
    wanted = scope.account_id === undefined ? undefined : normalizeAccount(gateway, scope.account_id),
    // The enabled logins of the recipe's platform that this actor reaches (a client access set already narrows them).
    logins = store.connectionsFor(actor).filter(c => c.gateway === gateway && c.enabled),
    // The accounts a selected playbook's bindings allow: a filter below only ever takes from these, so it never widens them.
    bound = logins.flatMap(c =>
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
        .map(account => ({login: c, account})),
    ),
    chosen = bound.filter(
      ({login, account}) =>
        (scope.connection_id === undefined || login.id === scope.connection_id) &&
        (wanted === undefined || normalizeAccount(gateway, account) === wanted),
    );
  // A filter that matches nothing is one refusal whatever the cause (an account that does not exist, one outside the client access set or the
  // playbook, a login that is not the account's): it never says which, so the refusal tells nothing about accounts the caller may not see.
  if (filtered && !chosen.length)
    throw new MirrorError('ACCOUNT_SCOPE_MISMATCH', 'The selected account is unavailable for this recipe.');
  // The one account-metadata resolver (CON-05): the same name and source as list_accounts and capabilities.
  const targets = chosen.map(({login: c, account}) => {
    const meta = resolveAccountMetadata(store, actor.tenantId, c, account);
    return {
      connection_id: c.id,
      account_id: account,
      name: meta.name,
      // The login, account name and ID, each once: an account without a known name is not repeated (CMP-06).
      label: [c.label, meta.name, account]
        .filter((part, i, all) => typeof part === 'string' && part !== '' && all.indexOf(part) === i)
        .join(' · '),
      currency: meta.currency ?? null,
      timezone: meta.timezone ?? null,
      write_granted: c.writeAccounts?.includes(account) === true,
      metadata: accountMetadataView(meta),
      metadata_source:
        meta.source === 'live_account_read'
          ? 'live account read; verified again during preflight'
          : meta.source === 'cached_discovery'
            ? 'cached discovery; verified again during preflight'
            : 'not read yet; verified during preflight',
    };
  });
  // Shared defaults (defaults.common) apply to every recipe that takes the field; a recipe's own defaults win (CMP-06).
  const common = profile?.defaults?.common ?? {},
    own = profile?.defaults?.recipes?.[recipeId] ?? {};
  if (!obj(common) || !obj(own)) throw new MirrorError('INVALID_PROFILE', 'Recipe defaults must be an object.');
  // A declaration is the person's own statement in each brief: a playbook never supplies it, whatever its stored defaults say (the lead's review
  // S2-2; the same rule the comment above profileDefaultKeys states, which the per-recipe defaults did not keep).
  const declared = recipeDeclarations(recipeId),
    defaults = {
      ...Object.fromEntries(
        Object.entries(common).filter(
          ([key]) => profileDefaultKeys.includes(key) && recipe.required.includes(key) && !declared.includes(key),
        ),
      ),
      ...Object.fromEntries(Object.entries(own).filter(([key]) => !declared.includes(key))),
    };
  noSecrets(defaults);
  // Page suggestions come only from the logins that hold an eligible account of this recipe, after the playbook's
  // bindings (SEC-08): before, every login's Pages were offered, mixing clients. A Page belongs to a login, not an
  // account, so access limited to a client access set gets none and names its Page explicitly (preflight checks it).
  const pageLogins = new Set(actor.accessSetId === undefined ? targets.map(t => t.connection_id) : []);
  // Connected accounts the selected playbook's bindings leave out (CMP-06), so an empty account list can say why. It is the playbook's count
  // alone: an account a filter left out is not one the playbook left out (AMCP-06).
  const connected = logins.reduce((count, c) => count + c.accounts.length, 0);
  return {
    version: 1,
    recipe,
    targets,
    excluded_by_playbook: profile ? connected - bound.length : 0,
    defaults,
    profile: profile ? {id: profile.id, revision: profile.revision, name: profile.name} : null,
    conventions: playbookConventions(profile),
    pages: inventory
      .filter(i => pageLogins.has(i.id))
      .flatMap(i =>
        (i.groups ?? [])
          .filter((g: JsonObject) => g.kind === 'pages')
          .flatMap((g: JsonObject) => g.assets.map((a: JsonObject) => ({id: a.id, name: a.name, connection_id: i.id}))),
      ),
    // The Drive logins in reach, each with its label and its files; under a filter, an ID and the count of its files, not their IDs (AMCP-06) and not
    // its label, which often names the client the login belongs to (the lead's review S4-2).
    drive_connections: store
      .connectionsFor(actor)
      .filter(c => c.gateway === driveGateway && c.enabled)
      .map(c =>
        filtered ? {id: c.id, files_count: c.accounts.length} : {id: c.id, label: c.label, files: c.accounts},
      ),
    // The recipe's provider facts (CMP-03: whether recipe_lookup can search Microsoft's geographical locations file in
    // this deployment), what it leaves unverified and its own prerequisite.
    ...(facts?.extra ? facts.extra() : {}),
    limitations: [...(facts?.limitations ?? [])],
    prerequisites: [
      'current account grant',
      'verified account currency',
      facts?.prerequisite ?? 'required Page/media or search inputs',
      'whole-plan preflight',
      'review each resolved mutation',
      'provider read-back',
    ],
  };
}
/**
 * The `recipe_context` action (AMCP-06, R2.5 field3 package r25-field3-recipes): the context narrowed by the filters the call names, and what
 * the contract profile of the caller makes of the default when it names none.
 *
 * - A filter (account_id, connection_id or both) answers with the matched accounts in full and the Pages of their logins, as before.
 * - The legacy profile (the website, the workers, every MCP client that has not opted in) keeps its default answer, the full list the website's
 *   account picker reads, and adds `targets_notice` when the list spans more than one login, naming the filter. Round 3 flips this default.
 * - The v2 profile's own call answers ID-only rows (`connection_id`, `account_id`, `write_granted`) and the call that returns the rest
 *   (`full_targets_call`, `detail: "full"`), so an agent working for one client is not handed other clients' names, currencies and time
 *   zones unasked; `detail: "full"` returns them. A call a workflow made while serving the client's (isClientCall) is the unfiltered context.
 */
export function recipeContextCall(store: Store, actor: Actor, input: JsonObject): JsonObject {
  for (const key of ['gateway', 'connection_id', 'account_id'])
    if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key] || input[key].length > 200))
      bad('Use an exact gateway, connection_id or account_id of up to 200 characters.', 'INVALID_ARGUMENT', {
        field: key,
      });
  const answer = recipeContext(store, actor, input.recipe, input.profile_id, {
    account_id: input.account_id,
    connection_id: input.connection_id,
    gateway: input.gateway,
  });
  if (input.account_id !== undefined || input.connection_id !== undefined || input.detail === 'full') return answer;
  if (currentContractProfile() === 'v2' && isClientCall(input))
    return {
      ...answer,
      targets: answer.targets.map((t: JsonObject) => ({
        connection_id: t.connection_id,
        account_id: t.account_id,
        write_granted: t.write_granted,
      })),
      // A Page name is usually a client's brand: the default says which Pages there are and whose login they belong to, not what they are called (the
      // lead's review S3-1); the names come with a filter or with detail:"full".
      pages: answer.pages.map((p: JsonObject) => ({id: p.id, connection_id: p.connection_id})),
      // The Drive logins the same way: an ID and a count (the lead's review S4-2); the labels and the files come with detail:"full".
      drive_connections: answer.drive_connections.map((d: JsonObject) => ({id: d.id, files_count: d.files.length})),
      full_targets_call: {
        tool: 'amcp_campaign',
        arguments: {
          action: 'recipe_context',
          recipe: input.recipe,
          ...(input.profile_id === undefined ? {} : {profile_id: input.profile_id}),
          detail: 'full',
        },
      },
    };
  return new Set(answer.targets.map((t: JsonObject) => t.connection_id)).size > 1
    ? {
        ...answer,
        targets_notice:
          'These targets belong to more than one login. Send account_id or connection_id to see only the account you are working on.',
      }
    : answer;
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
  const brief = visibleBrief(store, actor, input.brief_id);
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
/**
 * Whether a saved brief is this person's to see (SEC-08): always without a client access set; with one, a brief of a
 * client profile within the set, or a brief without a profile that the same person saved.
 */
function briefVisible(store: Store, actor: Actor, brief: JsonObject): boolean {
  if (actor.accessSetId === undefined) return true;
  if (brief.profile_id) {
    const profile = optional(store, actor.tenantId, 'client_profile', String(brief.profile_id));
    return !!profile && profileWithinAccess(store, actor, profile);
  }
  return brief.created_by === actor.userId || (!!actor.ownerUserId && brief.created_by === actor.ownerUserId);
}
function visibleBrief(store: Store, actor: Actor, id: unknown): JsonObject {
  const brief = read(store, actor, 'client_brief', id as string);
  if (!briefVisible(store, actor, brief))
    throw new MirrorError('NOT_FOUND', 'Document not found in this tenant.', {}, 404);
  return brief;
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
      .filter(b => briefVisible(store, actor, b))
      .sort((a, b) => Number(b.updated_at ?? 0) - Number(a.updated_at ?? 0) || String(a.name).localeCompare(b.name));
    return {briefs: briefs.map(briefSummary), total: briefs.length, limit: clientBriefLimit};
  }
  if (input.action === 'brief') return visibleBrief(store, actor, input.id);
  writer(store, actor);
  if (input.action === 'delete_brief') {
    if (input.confirmed !== true) bad('Confirm brief deletion.');
    const brief = visibleBrief(store, actor, input.id);
    if (input.revision !== brief.revision) bad('Reload the current brief.', 'REVISION_CONFLICT');
    store.repo('client_brief', actor.tenantId).deleteRevision(brief.id, brief.revision);
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
      : visibleProfile(store, actor, b.profile_id);
  const id = input.id ?? randomUUID(),
    previous = optional(store, actor.tenantId, 'client_brief', id);
  // Replacing a brief outside the actor's client access set is refused as if it did not exist (SEC-08).
  if (previous && !briefVisible(store, actor, previous))
    throw new MirrorError('NOT_FOUND', 'Document not found in this tenant.', {}, 404);
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
  // R2.5 M4 (package r25-m4-search): a Search pack is search acquisition, though its ID may end in _traffic (the rule below).
  if (id.includes('search')) return 'search';
  if (id.includes('lead')) return 'leads';
  // The Smart+ purchases pack is listed by name: an ID that is none of these and ends in no `_traffic` would group as search (R2.5 M4).
  if (
    [
      'meta_website_sales',
      'tiktok_website_conversions',
      'tiktok_smart_plus_website_conversions',
      'google_performance_max',
    ].includes(id)
  )
    return 'sales';
  if (id.endsWith('_traffic')) return 'traffic';
  return 'search';
}
