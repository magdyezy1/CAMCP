import type {CompiledRequest, JsonObject} from './types.js';
import {deprecationEffective, refuseDeprecated} from './provider-deprecations.js';
import {tiktokParentCampaign} from './tiktok-manual-ad-identities.js';

/**
 * The 2027-01-01 cut-off of TikTok's classic create routes (R2.5 M4; the lead's decision L2, 2026-11-20; the dated provider deprecation
 * `tiktok_manual_sales_app_lead_creates`, PRV-04, src/provider-deprecations.ts, which cites the page and holds the date).
 *
 * A banner on TikTok's "Create ads" page (https://business-api.tiktok.com/portal/docs/create-ads/v1.3, read 2026-11-19) says that from
 * January 1, 2027 /campaign/create/, /adgroup/create/, /ad/create/ and /ad/aco/create/ no longer create non-Search Legacy Manual Flow
 * campaigns, or ad groups or ads under them, for the Sales, App Promotion and Lead Generation objectives. TikTok then refuses what AMCP
 * would send, and the agent would meet an opaque TikTok code instead of the route that works. From that day (00:00 UTC) AMCP refuses it
 * first, before any request, with PROVIDER_DEPRECATED naming the Upgraded Smart+ route, and a test keeps what survives accepted (the
 * registry's `surviving`: Traffic, and a Search campaign of any objective).
 *
 * What is refused, and where it is caught:
 *   - a classic campaign create whose body names such an objective and is not a Search campaign: stateless, in TikTok's write shape, so at
 *     inspect, prepare, execute and plan validation (tiktokManualCutoffShape);
 *   - a classic ad group create whose parent campaign row (read for the create anyway) names such an objective, is not a Search campaign
 *     and is a manual campaign, whose campaign_automation_type is MANUAL or absent: an existing classic campaign's new ad groups stop
 *     too, per the banner (tiktokManualCutoffPrerequisites, with the other state prerequisites; a campaign of Upgraded Smart+ is
 *     refused by its own route check, src/tiktok-manual-ad-identities.ts, and a legacy Smart+ campaign is not Legacy Manual Flow);
 *   - the website purchases pack's compile (src/tiktok-launch-recipes.ts: tiktokManualCutoffPurchases) and a clone of such a source
 *     (src/tiktok-campaign-clone.ts: tiktokManualCutoffClone).
 * A classic ad create is not enforced: its ad group row is not known to carry the objective, so TikTok's own refusal stands. That
 * refusal applies nothing; with one of the nine definitive codes M2 records it `rejected` (src/tiktok-write-rejection.ts), and with
 * any other it is uncertain and the automatic read-only reconcile looks it up by name. `/ad/aco/create/` is withheld already
 * (src/withheld-writes.ts). The Upgraded Smart+ routes are other routes and are untouched, whatever objective they carry.
 *
 * UNVERIFIED until the lead's documentation session (SPLIT section 7, item 1): that Sales means WEB_CONVERSIONS, PRODUCT_SALES or
 * virtual_objective_type SALES, and the banner's time zone (AMCP refuses from 00:00 UTC, at most hours early). Whether TikTok also stops
 * edits or status changes of existing classic campaigns is not handled here: the banner speaks of creating.
 */
const id = 'tiktok_manual_sales_app_lead_creates';
/** The objective_type values the cut-off covers: Sales (as AMCP sends it), App Promotion and Lead Generation. Never a guess at TikTok's enum. */
export const tiktokCutoffObjectives: readonly string[] = Object.freeze([
  'WEB_CONVERSIONS',
  'PRODUCT_SALES',
  'APP_PROMOTION',
  'LEAD_GENERATION',
]);
/** The virtual_objective_type values it covers: SALES, the combined Website Conversions and Product Sales objective. */
export const tiktokCutoffVirtualObjectives: readonly string[] = Object.freeze(['SALES']);
/** The objective_type values that are Sales, for which the guided Smart+ pack is the replacement. */
const salesObjectives: readonly string[] = ['WEB_CONVERSIONS', 'PRODUCT_SALES'];
const smartPlusCampaign = 'tiktok_smart_plus_campaign_create',
  smartPlusPurchases = 'tiktok_smart_plus_website_conversions';

/**
 * The objective a campaign body or row names that the cut-off covers, as the details that name it (`objective_type`, or
 * `virtual_objective_type` when only that decides); undefined for a Search campaign (`is_search_campaign` is the boolean true, as TikTok
 * documents it) and for any other objective.
 */
function covered(campaign: JsonObject): JsonObject | undefined {
  if (campaign.is_search_campaign === true) return undefined;
  const objective = campaign.objective_type,
    virtual = campaign.virtual_objective_type;
  if (typeof objective === 'string' && tiktokCutoffObjectives.includes(objective)) return {objective_type: objective};
  if (typeof virtual === 'string' && tiktokCutoffVirtualObjectives.includes(virtual))
    return {virtual_objective_type: virtual};
  return undefined;
}
/** The route and, for a Sales objective, the guided pack that replace the refused create. */
function replacement(objective: JsonObject): JsonObject {
  const sales =
    objective.virtual_objective_type !== undefined || salesObjectives.includes(String(objective.objective_type));
  return {use_action: smartPlusCampaign, ...(sales ? {use_recipe: smartPlusPurchases} : {})};
}
const named = (objective: JsonObject) =>
  objective.objective_type !== undefined
    ? 'objective_type ' + objective.objective_type
    : 'virtual_objective_type ' + objective.virtual_objective_type;
const advice = (objective: JsonObject) =>
  'Create an Upgraded Smart+ campaign with ' +
  smartPlusCampaign +
  (replacement(objective).use_recipe ? ', or run the guided pack ' + smartPlusPurchases : '') +
  '. A Search campaign and a Traffic campaign are not affected';

/** A classic campaign create that TikTok stops accepting is refused from the day, before any request (stateless: at every stage that checks the shape). */
export function tiktokManualCutoffShape(plan: CompiledRequest, body: JsonObject): void {
  if (plan.method !== 'POST' || plan.path !== '/v1.3/campaign/create/' || !deprecationEffective(id)) return;
  const objective = covered(body);
  if (!objective) return;
  refuseDeprecated(
    id,
    'TikTok no longer creates a manual campaign with the Sales, App Promotion or Lead Generation objective (here ' +
      named(objective) +
      '). ' +
      advice(objective),
    {field: Object.keys(objective)[0]!, ...objective, ...replacement(objective)},
  );
}
/**
 * A classic ad group create under a classic campaign that TikTok stops creating ad groups for, refused from the day, after the campaign read
 * the create already makes. A campaign row that names no such objective keeps what it did.
 */
export function tiktokManualCutoffPrerequisites(plan: CompiledRequest, values: unknown[]): void {
  if (
    plan.gateway !== 'tiktok_native_action' ||
    plan.method !== 'POST' ||
    plan.path !== '/v1.3/adgroup/create/' ||
    !deprecationEffective(id)
  )
    return;
  const campaign = tiktokParentCampaign(plan, values);
  if (!campaign) return;
  const type = campaign.campaign_automation_type;
  if (type !== undefined && type !== null && type !== '' && type !== 'MANUAL') return;
  const objective = covered(campaign);
  if (!objective) return;
  refuseDeprecated(
    id,
    'TikTok no longer creates ad groups in a manual campaign with the Sales, App Promotion or Lead Generation objective (campaign_id ' +
      String(campaign.campaign_id) +
      ', ' +
      named(objective) +
      '). ' +
      advice(objective),
    {field: 'campaign_id', campaign_id: String(campaign.campaign_id), ...objective, ...replacement(objective)},
  );
}
/** The website purchases pack creates a classic Sales campaign: from the day its compile is refused, naming the Smart+ pack. */
export function tiktokManualCutoffPurchases(): void {
  if (!deprecationEffective(id)) return;
  refuseDeprecated(
    id,
    'The TikTok website purchases pack creates a manual campaign with the Sales objective (WEB_CONVERSIONS), which TikTok no longer creates. Use the Upgraded Smart+ pack ' +
      smartPlusPurchases,
    {
      recipe: 'tiktok_website_conversions',
      objective_type: 'WEB_CONVERSIONS',
      use_recipe: smartPlusPurchases,
      use_action: smartPlusCampaign,
    },
  );
}
/** A clone of a classic campaign that TikTok stops creating is refused from the day, after the campaign row and before anything else is read. */
export function tiktokManualCutoffClone(campaign: JsonObject): void {
  if (!deprecationEffective(id)) return;
  const objective = covered(campaign);
  if (!objective) return;
  refuseDeprecated(
    id,
    'TikTok no longer creates a manual campaign with the Sales, App Promotion or Lead Generation objective, so source.campaign_id ' +
      String(campaign.campaign_id) +
      ' (' +
      named(objective) +
      ') cannot be cloned as one. ' +
      advice(objective),
    {field: 'source.campaign_id', campaign_id: String(campaign.campaign_id), ...objective, ...replacement(objective)},
  );
}
