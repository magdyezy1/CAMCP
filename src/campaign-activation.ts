import type {Actor, JsonObject} from './types.js';
import {bad, type ToolCall} from './workspace-core.js';
import type {CampaignActivation} from './provider-adapter.js';
import {providerById} from './provider-adapters.js';
import {providerHooks, registeredProviderHooks} from './provider-hooks.js';
import type {ConversionGoalInspector} from './campaign-activation-core.js';

/**
 * Launch activation (CMP-03). A recipe creates its campaign paused; activation is a separate, linked plan with its own
 * approval, preflight and spend confirmation, never part of the launch approval. Each platform's activation steps
 * come from the resources its completed plan verified, in the order that keeps delivery off until the last switch:
 *
 * - Meta and Google: the paused campaign holds ACTIVE/ENABLED children, so enabling the campaign is the one step.
 * - Snapchat: campaign, ad squad and ad were all created PAUSED, so all three are activated, each after the one
 *   before it is verified (activating the campaign alone delivers nothing).
 * - Microsoft: campaign, ad group, keywords and ad were all created Paused. The campaign needs a positive location
 *   criterion (owner decision P7): the gate below reads its location criteria, and the campaign step's own review
 *   reads them again (microsoft-native.ts) before anything is sent.
 * - TikTok (CMP-07): the DISABLE campaign holds ENABLE children, so enabling the campaign through the reviewed
 *   tiktok_entity_status family is the one step.
 * - LinkedIn (CMP-07): campaign group, campaign and creative were all created PAUSED, so all three are activated
 *   through REST.li PARTIAL_UPDATE reviews, each after the one before it is verified; the creative is the last switch.
 *
 * Read-only gates run at the activation plan's preflight, as one set, before any status write: the Snapchat ad's
 * creative review, the Meta ad's effective status and review feedback, the Meta conversion pixel, the Google
 * conversion recipes' account-default goals and primary actions (the reads recipe_eligibility makes), the Microsoft
 * campaign's positive location criteria, whose names Microsoft returns are listed for the operator, and the state of
 * the LinkedIn lead form a lead launch uses.
 *
 * Each platform's steps and gates are its provider's (ARC-01 phase B, wave 4c: its adapter's `campaign.activation`,
 * moved verbatim to src/<provider>-recipe-activation.ts); this module keeps the platforms offered, the step builder
 * and the refusal of a plan without a guided activation.
 */
export const activationPlatforms = ['meta', 'google', 'snapchat', 'microsoft', 'tiktok', 'linkedin'];
export type {ConversionGoalInspector} from './campaign-activation-core.js';

type Results = Map<string, JsonObject>;
/** A platform's gateway and its provider's activation, by the provider ID a recipe names as its platform. */
const activations = new Map<string, {gateway: string; activation: CampaignActivation}>(
  activationPlatforms.map(platform => {
    const gateway = providerById(platform)?.gateway,
      activation = providerHooks(gateway)?.campaign?.activation;
    // A load-time check, like the recipe catalog's: every platform offered has its provider's activation.
    if (!gateway || !activation) throw new Error('Guided activation has no provider activation for ' + platform + '.');
    return [platform, {gateway, activation}];
  }),
);
if (
  registeredProviderHooks.some(
    hooks => hooks.campaign?.activation && ![...activations.values()].some(a => a.gateway === hooks.gateway),
  )
)
  throw new Error('Every provider that declares a guided activation must be an activation platform.');
/** The provider activation of a recipe platform; an inherited name such as `constructor` is no platform. */
export const platformActivation = (platform: unknown) =>
  typeof platform === 'string' ? activations.get(platform) : undefined;

/**
 * The activation steps of a completed recipe plan, from its verified results (step id → result, including any plan
 * it continues). Every ID is a literal read from a verified receipt; nothing is looked up or guessed.
 */
export function activationSteps(
  platform: string,
  results: Results,
  scope: JsonObject,
  recipe?: JsonObject,
): JsonObject[] {
  const offered = platformActivation(platform);
  if (!offered)
    bad(
      'This plan’s recipe has no guided activation. Activate it through its provider’s reviewed writes.',
      'ACTIVATION_UNAVAILABLE',
    );
  const gateway = offered.gateway;
  const step = (id: string, description: string, args: JsonObject, depends_on: string[] = []) => ({
    id,
    kind: 'write',
    gateway,
    connection_id: scope.connection_id,
    account_id: scope.account_id,
    description,
    arguments: args,
    depends_on,
  });
  return offered.activation.steps(results, scope, step, recipe);
}

/**
 * The read-only gates of an activation plan (CMP-03), run as one set at its preflight. A read that fails or shows an
 * unexpected shape blocks too: readiness must be shown, never assumed. Returns the gate checks, passed or blocked.
 * `current` re-checks the actor between reads, as recipe_eligibility does. The gates are the platform's provider's.
 */
export async function activationGates(
  call: ToolCall,
  actor: Actor,
  activation: JsonObject,
  steps: JsonObject[],
  inspectConversionGoals?: ConversionGoalInspector,
  current: () => void = () => {},
): Promise<JsonObject[]> {
  const scope = {account_id: steps[0]?.account_id, connection_id: steps[0]?.connection_id},
    gates = platformActivation(activation.platform)?.activation.gates;
  if (!gates) return [];
  return gates({call, actor, activation, steps, scope, current, inspectConversionGoals});
}
