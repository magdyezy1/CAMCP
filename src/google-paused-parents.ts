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
/**
 * The owner's decision of 2026-11-19 (R2.5 field fix r25-field-pausedspend), Q14's principle ("nothing can spend") for Google's child
 * creates, as Q26's is for X's promotions under a paused parent: a create under a parent the review reads PAUSED can start no spend, so it
 * needs no spend_change_confirmed. This is the one place that says which creates, and under which parent each one is read.
 * Each child kind and where its parent is read: the campaign alone (`campaign`), or the ad group and its campaign (`ad_group`: the ad group
 * is read with its campaign's status, so a PAUSED campaign covers it too).
 */
const coveredChildren: Record<string, 'campaign' | 'ad_group'> = {
  adGroups: 'campaign',
};
const snakeCase = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
/** A state row with every key in snake_case: Google's JSON keeps camelCase, the review's own state may keep either. */
const snaked = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(snaked)
    : object(value)
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [snakeCase(k), snaked(v)]))
      : value;
/** A field in either spelling Google takes (`ad_group`, `adGroup`); undefined when the record names both, which reads as nothing. */
const spelled = (record: JsonObject, snake: string): unknown => {
  const camel = snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return camel !== snake && Object.hasOwn(record, snake) && Object.hasOwn(record, camel)
    ? undefined
    : (record[snake] ?? record[camel]);
};
/** The one value every reading names; undefined when there is none or they disagree (a parent read twice with two statuses). */
const agreed = (values: unknown[]): unknown => (new Set(values).size === 1 ? values[0] : undefined);
/**
 * Whether the request creates children only, every one of them under a parent the review's state reads PAUSED (`parentReading`): nothing it
 * creates can serve, so it asks for no spend flag. src/preflight.ts asks this through the provider's `writes.pausedChildCreation`, and only
 * when it is given the review's state: at prepare, and at execute with the state the review froze and, after the state check, the one it
 * read again, which refuses a parent that changed (STATE_CHANGED) before anything is sent. With no state (inspect, the effect class of a
 * bare plan, a plan's local compile) it is not asked and the write asks for the flag, as it always did.
 * It reads only the rows the review already holds, and fails closed: false for anything it cannot read as a create of a covered kind under
 * a parent that reads PAUSED, for a request that holds anything but creates, for one parent in the request that reads otherwise, and
 * for a parent read twice with two statuses. A parent the review could not read is refused before this is asked (`parent_unread`).
 * It exempts nothing that updates or enables an existing object, no budget, bid or schedule edit of one, no atomic build and no cap.
 */
export function googleCreatesUnderPausedParents(plan: CompiledRequest, state: unknown): boolean {
  if (plan.gateway !== 'google_ads_native_action' || plan.method !== 'POST') return false;
  const kind = /^\/v\d+\/customers\/\d+\/([A-Za-z]+):mutate$/.exec(plan.path)?.[1],
    parent = kind !== undefined && Object.hasOwn(coveredChildren, kind) ? coveredChildren[kind] : undefined;
  if (!parent || !Array.isArray(state) || !object(plan.body)) return false;
  const operations = plan.body.operations;
  if (!Array.isArray(operations) || !operations.length) return false;
  const rows = state
    .flatMap(s => (object(s) && Array.isArray(s.results) ? s.results : []))
    .filter(object)
    .map(row => snaked(row) as JsonObject);
  /** The rows that name the parent: the campaign's own, or the ad group's (which carry its campaign's status beside it). */
  const rowsOf = (entity: 'campaign' | 'ad_group', name: string) =>
    rows.filter(row => object(row[entity]) && row[entity].resource_name === name);
  return operations.every(op => {
    if (!object(op) || Object.keys(op).length !== 1 || !object(op.create)) return false;
    const name = spelled(op.create, parent);
    if (typeof name !== 'string') return false;
    const named = rowsOf(parent, name),
      statuses =
        parent === 'campaign'
          ? [agreed(named.map(row => row.campaign.status))]
          : [
              agreed(named.map(row => row.ad_group.status)),
              agreed(named.map(row => (object(row.campaign) ? row.campaign.status : undefined))),
            ];
    return parentReading(statuses) === 'paused';
  });
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
