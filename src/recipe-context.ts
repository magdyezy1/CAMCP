import {campaignRecipes, metaConversionRecipes, googleConversionRecipes} from './campaign-recipes.js';
import {Store} from './store.js';
import {MirrorError} from './errors.js';
import {noSecrets, fingerprint} from './workspace-core.js';
import type {Actor, JsonObject} from './types.js';
import {normalizeAccount} from './scope.js';
import {accountMetadataView, resolveAccountMetadata} from './account-metadata.js';
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
    // The one account-metadata resolver (CON-05): the same name and source as list_accounts and capabilities.
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
            const meta = resolveAccountMetadata(store, actor.tenantId, c, account);
            return {
              connection_id: c.id,
              account_id: account,
              name: meta.name,
              label: c.label + ' · ' + (meta.name ?? account) + ' · ' + account,
              currency: meta.currency,
              timezone: meta.timezone,
              write_granted: c.writeAccounts?.includes(account) === true,
              metadata: accountMetadataView(meta),
              metadata_source:
                meta.source === 'live_account_read'
                  ? 'live account read; verified again during preflight'
                  : meta.source === 'cached_discovery'
                    ? 'cached discovery; verified again during preflight'
                    : 'not read yet; verified during preflight',
            };
          }),
      );
  const defaults = profile?.defaults?.recipes?.[recipeId] ?? {};
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults))
    throw new MirrorError('INVALID_PROFILE', 'Recipe defaults must be an object.');
  noSecrets(defaults);
  return {
    version: 1,
    recipe,
    targets,
    defaults,
    profile: profile ? {id: profile.id, revision: profile.revision, name: profile.name} : null,
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
export function recipeInputs(context: JsonObject, input: JsonObject): JsonObject {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new MirrorError('RECIPE_INPUT_REQUIRED', 'Supply business inputs.');
  noSecrets(input);
  const business = {...context.defaults, ...input},
    fields = Object.fromEntries(
      Object.keys(business).map(k => [
        k,
        Object.hasOwn(input, k)
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
    },
  };
}
