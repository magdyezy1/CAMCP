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
 *
 * Q1, owner 2026-11-15 (R2.5 M4, package r25-m4-smartops; TikTok's levels): a level that confirms a serving parent (`serving: 'confirm'`)
 * lets its child start active under parents the review reads as serving, every one it names read, because the spend flag then asks: the
 * provider's `writes.activatesUnderServingParent` (src/preflight.ts) requires spend_change_confirmed and names the serving parents, and
 * the owner's allow_activation still refuses the child. A parent the review could not read still refuses (`parent_unread`), and a level
 * without the option (Snapchat, Meta) is unchanged: they follow in M9 and M13.
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
/**
 * What the review's read of an active child's parents says (Q1, owner 2026-11-15; R2.5 M4): `paused` when a parent the level names reads
 * paused (nothing under it serves), `serving` when every parent it names was read with the level's active value (the child serves as soon
 * as it is created), and `unread` otherwise: a status the review did not read, or one that is neither value, fails closed. Undefined for a
 * request that is no child create of a level, and for a child that starts paused.
 */
function parentReading(plan: CompiledRequest, states: readonly unknown[]) {
  const l = levelOf(plan),
    body = object(plan.body) ? plan.body : {};
  if (!l || !l.statuses(body).includes(l.active)) return undefined;
  const parent = l.parentRow(body, [...states]),
    status = parent?.[l.field],
    campaignId = parent && l.campaign ? l.campaign.id(parent) : undefined,
    campaign = l.campaign && campaignId !== undefined ? l.campaign.row([...states], campaignId)?.[l.field] : undefined;
  const reading =
    status === l.paused || campaign === l.paused
      ? ('paused' as const)
      : status === l.active && (!l.campaign || campaign === l.active)
        ? ('serving' as const)
        : ('unread' as const);
  return {l, status, campaign, reading};
}
/**
 * Q1, owner 2026-11-15 (R2.5 M4, the lead's design (b) of L5): the serving parents of a child created active on a level that confirms them
 * (`serving: 'confirm'`), every one the level names read serving, as the details name them; undefined in every other case (a paused child, a
 * paused or unread parent, a level without the option). A provider's `writes.activatesUnderServingParent` may answer from it, and
 * src/preflight.ts names these details with the spend acknowledgement such a child needs.
 */
export function servingParents(plan: CompiledRequest, states: readonly unknown[]): JsonObject | undefined {
  const r = parentReading(plan, states);
  if (!r || r.reading !== 'serving' || r.l.serving !== 'confirm') return undefined;
  return {
    parent: r.l.parent,
    parent_status: r.status as string,
    ...(r.l.campaign ? {campaign_status: r.campaign as string} : {}),
  };
}
/** Whether a child is created active under parents the review's state reads as serving, on a level that confirms them (`servingParents`). */
export const activeUnderServingParent = (plan: CompiledRequest, states: readonly unknown[]): boolean =>
  servingParents(plan, states) !== undefined;
export function validatePausedParents(plan: CompiledRequest, states: unknown[]) {
  const r = parentReading(plan, states);
  if (!r || r.reading === 'paused') return;
  const {l, status, campaign} = r;
  // Q1, owner 2026-11-15 (R2.5 M4): on a level that confirms a serving parent, the child may start active once every parent it names reads
  // serving; that it then serves at once is the spend flag's to say (`servingParents`, asked through the provider's hook in src/preflight.ts).
  if (l.serving === 'confirm' && r.reading === 'serving') return;
  // A status the message names is a status token; any other text the provider's row holds is shown as unread, and the details keep the raw
  // value (R2.5 M4, r25-m4-smartops fix round, the lead's review S4-3: no provider free text in a message).
  const named = (v: unknown) => (typeof v === 'string' && /^[A-Z_]{1,32}$/.test(v) ? v : 'unread');
  if (l.serving === 'confirm')
    throw new MirrorError(
      'PARENT_SERVING',
      'A new ' +
        l.child +
        ' must start ' +
        l.paused +
        ' while the status of its ' +
        l.parent +
        (l.campaign ? ' or campaign' : '') +
        ' is not read as ' +
        l.paused +
        ' or ' +
        l.active +
        ' (' +
        l.parent +
        ' ' +
        named(status) +
        (l.campaign ? ', campaign ' + named(campaign) : '') +
        '). Once it is, it may start ' +
        l.active +
        ': under a ' +
        l.paused +
        ' parent as it is, and under serving ones with spend_change_confirmed.',
      {
        field: l.field,
        parent: l.parent,
        parent_status: typeof status === 'string' ? status : null,
        ...(l.campaign ? {campaign_status: typeof campaign === 'string' ? campaign : null} : {}),
        allowed: [l.paused],
        parent_unread: true,
      },
    );
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
