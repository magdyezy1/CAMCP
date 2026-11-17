import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * New Google ad groups, ads and asset groups under their parents. The owner's item 6 (2026-09-29): nothing inside a paused
 * campaign or ad group serves, so requiring every child to start PAUSED and be enabled in a second reviewed pass protected
 * nothing. A child may start ENABLED when the review reads its campaign (for an ad group or asset group), or its ad group or
 * that ad group's campaign (for an ad), as PAUSED; enabling that parent later is its own reviewed activation.
 *
 * Q1, owner 2026-11-15 (R2.5 M3, G8): a child may also start ENABLED under a parent the review reads as serving, which is
 * the second pass the agent used to make by hand. The ENABLED status already asks for spend_change_confirmed at execute
 * and is what the owner's allow_activation switch refuses, so nothing is removed that protected anything. What still
 * refuses is a parent the review could not read (`parent_unread`): it may serve, and nothing says so. Campaigns are
 * created PAUSED only (the write shape). The check runs on the state read at prepare and again at execute, where a parent
 * enabled in between stops the write as STATE_CHANGED. Keywords follow the same rule in google-targeting-writes.ts.
 * This module is Google Ads' alone: TikTok follows in M4, Meta in M9 and the others in M13 (the lead's decision of 2026-11-17),
 * each in its own file (src/paused-parents.ts).
 */
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const field = (o: JsonObject, snake: string) =>
  o[snake] ?? o[snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())];
/**
 * What the review's read of a child's parents says of it (Q1): `paused` when a parent reads PAUSED (nothing under it serves),
 * `serving` when every parent was read and none is PAUSED (the child serves as soon as it is created), `unread` when some
 * parent's status was not read, which the child cannot be created ENABLED under. A status counts as read only when it is one
 * Google names (ENABLED, PAUSED, REMOVED): an unspecified or unknown one reads as no status at all, failing closed.
 */
export function parentReading(statuses: unknown[]): 'paused' | 'serving' | 'unread' {
  if (statuses.includes('PAUSED')) return 'paused';
  return statuses.every(s => s === 'ENABLED' || s === 'REMOVED') ? 'serving' : 'unread';
}
export function validateGooglePausedParents(plan: CompiledRequest, states: unknown[]) {
  if (plan.gateway !== 'google_ads_native_action') return;
  const kind = /\/(adGroups|adGroupAds|assetGroups):mutate$/.exec(plan.path)?.[1];
  if (!kind) return;
  const rows = states.flatMap(s => (object(s) && Array.isArray(s.results) ? s.results : [])).filter(object),
    record = (entity: string, name: unknown) =>
      rows.find(r => {
        const e = field(r, entity);
        return object(e) && field(e, 'resource_name') === name;
      });
  const operations = object(plan.body) && Array.isArray(plan.body.operations) ? plan.body.operations : [];
  for (const [index, op] of operations.entries()) {
    const r = object(op) ? op.create : undefined;
    if (!object(r) || r.status === 'PAUSED') continue;
    let statuses: Record<string, unknown>;
    if (kind === 'adGroupAds') {
      const parent = field(r, 'ad_group'),
        row = record('ad_group', parent);
      statuses = {
        ad_group: row ? field(field(row, 'ad_group'), 'status') : undefined,
        campaign: row && object(row.campaign) ? row.campaign.status : undefined,
      };
    } else {
      const row = record('campaign', field(r, 'campaign'));
      statuses = {campaign: row ? field(row, 'campaign').status : undefined};
    }
    // Under a paused parent it may start ENABLED (item 6); under a serving one with every parent read, too (Q1).
    if (parentReading(Object.values(statuses)) !== 'unread') continue;
    throw new MirrorError(
      'PARENT_SERVING',
      'A new ' +
        (kind === 'adGroups' ? 'ad group' : kind === 'adGroupAds' ? 'ad' : 'asset group') +
        ' must start PAUSED while the status of its parent cannot be read (' +
        Object.entries(statuses)
          .map(([k, v]) => k.replace('_', ' ') + ' ' + (v ?? 'unread'))
          .join(', ') +
        '). Once every parent is read it may start ENABLED: under a paused parent as it is, under a serving one with spend_change_confirmed.',
      {
        operation: index,
        field: 'status',
        parent_unread: true,
        ...Object.fromEntries(Object.entries(statuses).map(([k, v]) => [k + '_status', v ?? null])),
      },
    );
  }
}
