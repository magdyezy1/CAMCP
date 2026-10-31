import {MirrorError} from './errors.js';
import {providerOf} from './provider-adapters.js';
import type {PausedParentLevel} from './provider-adapter.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * Paused parents cover their new children on Snapchat, Meta and TikTok (the owner's decision of 2026-09-29, after
 * Google's item 6 in google-paused-parents.ts). Each platform's child create already reads its parent in the review
 * (write-snapshots.ts): Snapchat the campaign or ad squad in the path, Meta the campaign_id or adset_id, TikTok the
 * campaign or ad group by ID. A child may start active when that read shows the parent paused: nothing under a
 * paused parent serves, and enabling the parent is its own reviewed activation. An ad whose ad squad, ad set or ad
 * group serves is also covered by a paused campaign: only then does the review read that campaign as well, named by
 * the parent's own record. Under serving parents, or ones the review could not read, the child still starts paused.
 * The check runs on the state read at prepare and again at execute, so a parent enabled in between stops the write.
 * Campaigns always start paused.
 */
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const safeId = (v: unknown) => (typeof v === 'string' || typeof v === 'number') && /^[\w-]{1,64}$/.test(String(v));
/**
 * The level of a POST child create: each platform's child creates, status values and parent records are its adapter's
 * facts (ARC-01 phase B, src/provider-adapters.ts `pausedParents`: Snapchat's, Meta's and TikTok's).
 */
function levelOf(plan: CompiledRequest): PausedParentLevel | undefined {
  if (plan.method !== 'POST') return undefined;
  return providerOf(plan.gateway)?.pausedParents?.(plan);
}
/** The status values a child create may carry: paused always, active only under a paused parent (checked below). */
export function pausedParentChildStatuses(plan: CompiledRequest): string[] | undefined {
  const l = levelOf(plan);
  return l ? [l.paused, l.active] : undefined;
}
/** The campaign read an active ad needs when its own parent serves; undefined in every other case. */
export function pausedParentFollowUp(plan: CompiledRequest, read: CompiledRequest, data: unknown) {
  const l = levelOf(plan),
    body = object(plan.body) ? plan.body : {};
  if (!l?.campaign || !l.statuses(body).includes(l.active)) return undefined;
  const parent = l.parentRow(body, [data]);
  if (!parent || parent[l.field] === l.paused) return undefined;
  const id = l.campaign.id(parent);
  return safeId(id) ? l.campaign.read(read, String(id)) : undefined;
}
export function validatePausedParents(plan: CompiledRequest, states: unknown[]) {
  const l = levelOf(plan),
    body = object(plan.body) ? plan.body : {};
  if (!l || !l.statuses(body).includes(l.active)) return;
  const parent = l.parentRow(body, states),
    status = parent?.[l.field],
    campaignId = parent && l.campaign ? l.campaign.id(parent) : undefined,
    campaign = l.campaign && campaignId !== undefined ? l.campaign.row(states, campaignId)?.[l.field] : undefined;
  if (status === l.paused || campaign === l.paused) return;
  const named = (v: unknown) => (typeof v === 'string' ? v : 'unread');
  throw new MirrorError(
    'PARENT_SERVING',
    'A new ' +
      l.child +
      ' must start ' +
      l.paused +
      ' while its ' +
      l.parent +
      (l.campaign ? ' and campaign' : '') +
      ' can serve (' +
      l.parent +
      ' ' +
      named(status) +
      (l.campaign ? ', campaign ' + named(campaign) : '') +
      '). Under a ' +
      l.paused +
      ' ' +
      l.parent +
      (l.campaign ? ' or campaign' : '') +
      ' it may start ' +
      l.active +
      '.',
    {
      field: l.field,
      parent: l.parent,
      parent_status: typeof status === 'string' ? status : null,
      ...(l.campaign ? {campaign_status: typeof campaign === 'string' ? campaign : null} : {}),
      allowed: [l.paused],
    },
  );
}
