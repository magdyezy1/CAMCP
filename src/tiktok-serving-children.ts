import type {CompiledRequest, JsonObject} from './types.js';
import {activeUnderServingParent, servingParents} from './paused-parents.js';

/**
 * Q1, owner 2026-11-15 (R2.5 M4, package r25-m4-smartops; the lead's design (b) of QUESTIONS L5): a TikTok ad group or ad, standard or
 * Upgraded Smart+, may be created ENABLE under parents the review reads as serving, with spend_change_confirmed at execute and the owner's
 * allow_activation not forbidding it. Each of TikTok's four paused-parent levels confirms a serving parent (src/provider-adapters.ts), so
 * src/paused-parents.ts lets the child through once every parent the level names reads ENABLE, and still refuses a parent the review could
 * not read (PARENT_SERVING, `parent_unread`). The stateless Q14 exemption (`tiktokPausedCreation`) is unchanged, so a recipe's ENABLE
 * children under its own DISABLE campaign still ask nothing at approval.
 *
 * What this module adds is the other half of that rule: such a child serves as soon as it is created, so with the review's state the write
 * asks for the spend flag (`tiktokActivatesUnderServingParent`, asked by src/preflight.ts at prepare and at execute), and the review of a
 * standard create says so (`tiktokServingChildImpact`; the Smart+ ad group and ad families say it in their own impact). Campaigns are
 * always created paused.
 */
export const tiktokActivatesUnderServingParent = (plan: CompiledRequest, state: readonly unknown[]): boolean =>
  activeUnderServingParent(plan, state);

const standardChild: Record<string, {scope: string; child: string; parent: string; id: string}> = {
  '/v1.3/adgroup/create/': {scope: 'adgroups', child: 'ad group', parent: 'campaign', id: 'campaign_id'},
  '/v1.3/ad/create/': {scope: 'ads', child: 'ad', parent: 'ad group', id: 'adgroup_id'},
};
/**
 * The disclosure of a standard ad group or ad created ENABLE under parents the review reads as serving: it may affect serving at once.
 * Undefined for every other TikTok write (a standard create under a paused parent, and the writes whose family discloses its own impact).
 */
export function tiktokServingChildImpact(plan: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = Object.hasOwn(standardChild, plan.path) ? standardChild[plan.path] : undefined,
    serving = kind && plan.gateway === 'tiktok_native_action' ? servingParents(plan, state) : undefined;
  if (!kind || !serving) return undefined;
  const body = plan.body as JsonObject;
  return {
    provider: 'tiktok',
    scope: kind.scope,
    may_affect_serving: true,
    effect:
      'Creates an enabled ' +
      kind.child +
      ' in ' +
      kind.parent +
      ' ' +
      String(body[kind.id]) +
      ', which the review reads as serving: it starts serving at once (Q1), so execute needs spend_change_confirmed.',
    serving_parents: serving,
  };
}
