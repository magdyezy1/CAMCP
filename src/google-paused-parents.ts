import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * New Google ad groups, ads and asset groups under a paused parent (the owner's item 6, 2026-09-29). Nothing inside a
 * paused campaign or ad group serves, so requiring every child to start PAUSED and be enabled in a second reviewed
 * pass protected nothing. A child may now start ENABLED when the review reads its campaign (for an ad group or asset
 * group), or its ad group or that ad group's campaign (for an ad), as PAUSED; enabling that parent later is its own
 * reviewed activation. Under a serving parent, or one the review could not read, it still starts PAUSED. The check
 * runs on the state read at prepare and again at execute. Keywords follow the same rule in google-targeting-writes.ts.
 */
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const field = (o: JsonObject, snake: string) =>
  o[snake] ?? o[snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())];
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
  for (const op of operations) {
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
    if (!Object.values(statuses).includes('PAUSED'))
      throw new MirrorError(
        'PARENT_SERVING',
        'A new ' +
          (kind === 'adGroups' ? 'ad group' : kind === 'adGroupAds' ? 'ad' : 'asset group') +
          ' must start PAUSED while its parent can serve (' +
          Object.entries(statuses)
            .map(([k, v]) => k.replace('_', ' ') + ' ' + (v ?? 'unread'))
            .join(', ') +
          '). Under a paused parent it may start ENABLED.',
        {field: 'status', ...Object.fromEntries(Object.entries(statuses).map(([k, v]) => [k + '_status', v ?? null]))},
      );
  }
}
