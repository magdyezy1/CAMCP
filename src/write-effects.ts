import type {CompiledRequest, JsonObject} from './types.js';
import {familyOf} from './reviewed-families.js';
import {deliveryStops} from './spend-effects.js';
// A provider's effects (ARC-01 phase B, wave 4c): its adapter's writes hooks, asked where this stage named it.
import {providerHooks} from './provider-hooks.js';

/**
 * Effects a person should see before approving a reviewed write (WRT-05 Stage B): it deletes or removes something,
 * cannot be undone, publishes live, or stops delivery. Disclosure only: nothing here refuses or adds a flag; the
 * owner's allow_deletion and allow_activation policies stay the controls. Only these effects are named, so ordinary
 * writes keep their plain review.
 */
export interface WriteEffects {
  destructive: boolean;
  irreversible: boolean;
  publishes_live: boolean;
  stops_delivery: boolean;
}
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const statusKeys = [
  'status',
  'effective_status',
  'entity_status',
  'entityStatus',
  'configured_status',
  'operation_status',
  'secondary_status',
  'Status',
];
/**
 * Requests that make a change live for everyone once executed: a family's own, then its provider's routes (Tag Manager's
 * publish, Search Console's sitemap submission, Business Profile's place action links).
 */
function publishesLive(plan: CompiledRequest): boolean {
  const family = familyOf(plan);
  if (family?.publishes) return family.publishes(plan);
  return providerHooks(plan.gateway)?.writes?.publishesLive?.(plan) ?? false;
}
/**
 * How many entities a request writes where it can be more than one (Google Ads operations, Snapchat record lists).
 * The before-state names one target's status only when there is exactly one.
 */
function targetCount(plan: CompiledRequest): number {
  const body = object(plan.body) ? plan.body : {},
    kind = plan.path.split('/').at(-1) ?? '';
  if (Array.isArray(body.operations)) return body.operations.length;
  // A provider that writes a list of records in one request (Snapchat).
  return providerHooks(plan.gateway)?.writes?.recordCount?.(body, kind) ?? 1;
}
/**
 * What a request that is a list of operations removes, and what else it does (R2.5 M3 live finding F5, package r25-m3-live; the lead's live run
 * of 2026-11-20): a route B tree edit that removed one node and created three said "This deletes or removes 4 resources", and one that removed
 * one and created one said "2", because the destructive reason counted every operation. The operations that remove are the ones with a string
 * `remove`; the others are told apart as creates and updates. Undefined when the body is no list of operations, or none of them removes (a
 * deletion that is a value in the body, such as a status of REMOVED, cannot be told from the operations around it: the count of operations stays).
 */
function operationKinds(plan: CompiledRequest): {removed: number; created: number; updated: number} | undefined {
  const operations =
      object(plan.body) && Array.isArray(plan.body.operations) ? plan.body.operations.filter(object) : [],
    removed = operations.filter(o => typeof o.remove === 'string').length;
  return removed
    ? {
        removed,
        created: operations.filter(o => object(o.create)).length,
        updated: operations.filter(o => object(o.update)).length,
      }
    : undefined;
}
/**
 * The effects of a compiled reviewed request, or undefined when it has none of them. With the before-state of a single
 * target, a status change to the status it already has, or a deletion of what is already not serving, does not stop
 * delivery.
 */
export function writeEffects(plan: CompiledRequest, state?: unknown[]): WriteEffects | undefined {
  // A write its provider documents as a deletion on a route that is not one (TikTok's status update to DELETE).
  const providerDeletes = providerHooks(plan.gateway)?.writes?.deletes?.(plan) === true;
  const destructive = plan.destructive === true || providerDeletes,
    delivery = deliveryStops(plan),
    publishes = publishesLive(plan),
    current = state && targetCount(plan) === 1 ? stateTarget(state)?.status?.toUpperCase() : undefined,
    changes = delivery.stops.filter(s => s.value.toUpperCase() !== current),
    // Deleting what is already paused, archived or removed stops nothing; an unknown current status may serve.
    stops = changes.length > 0 || (destructive && delivery.serving && !(current && delivery.idle.includes(current)));
  if (!destructive && !publishes && !stops) return undefined;
  return {destructive, irreversible: destructive, publishes_live: publishes, stops_delivery: stops};
}
/**
 * The first record of the review's before-state, as id, name and status, for the reason text. `skip` names a record that is
 * no target (the account's read, or a parent's, which most reviews read first): it and what it holds are passed over.
 */
export function stateTarget(
  state: unknown[],
  skip?: (record: JsonObject) => boolean,
): {id?: string; name?: string; status?: string} | undefined {
  const find = (v: unknown, depth: number): JsonObject | undefined => {
    if (depth > 5) return undefined;
    if (Array.isArray(v)) {
      for (const x of v) {
        const found = find(x, depth + 1);
        if (found) return found;
      }
      return undefined;
    }
    if (!object(v) || skip?.(v)) return undefined;
    if (statusKeys.some(k => typeof v[k] === 'string')) return v;
    for (const x of Object.values(v)) {
      const found = find(x, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  const record = find(state, 0);
  if (!record) return undefined;
  const text = (x: unknown) => (typeof x === 'string' || typeof x === 'number' ? String(x).slice(0, 200) : undefined);
  const status = statusKeys.map(k => record[k]).find(x => typeof x === 'string');
  return {
    ...(text(record.id ?? record.resourceName ?? record.resource_name ?? record.name)
      ? {id: text(record.id ?? record.resourceName ?? record.resource_name ?? record.name)}
      : {}),
    ...(text(record.name ?? record.displayName ?? record.campaign_name ?? record.adgroup_name)
      ? {name: text(record.name ?? record.displayName ?? record.campaign_name ?? record.adgroup_name)}
      : {}),
    ...(status ? {status} : {}),
  };
}
const effectWords: Record<keyof WriteEffects, string> = {
  destructive: 'deletes or removes',
  irreversible: 'cannot be undone',
  publishes_live: 'publishes live',
  stops_delivery: 'stops delivery',
};
/** The effects in words, for user_approval. */
export function effectNames(effects: WriteEffects): string[] {
  return (Object.keys(effectWords) as (keyof WriteEffects)[]).filter(k => effects[k]).map(k => effectWords[k]);
}
/** One reason per effect, naming the target and its current status from the before-state. */
export function effectReasons(plan: CompiledRequest, state: unknown[], effects: WriteEffects): JsonObject[] {
  const count = targetCount(plan),
    // A request that writes several entities is named by its count: the first record read is not "the" target.
    target = count === 1 ? stateTarget(state) : undefined,
    label =
      count > 1
        ? count + ' resources (' + plan.method + ' ' + plan.path + ')'
        : ((target?.name && target.id && target.name !== target.id
            ? '"' + target.name + '" (' + target.id + ')'
            : (target?.id ?? target?.name)) ?? plan.method + ' ' + plan.path),
    current = target?.status ? ' (current status: ' + target.status + ')' : '',
    stops = deliveryStops(plan).stops.filter(s => s.value.toUpperCase() !== target?.status?.toUpperCase());
  const reasons: JsonObject[] = [];
  if (effects.destructive) {
    // A request of several operations is named by the operations that remove (F5): the removals are what cannot be undone, and the rest is said
    // after them. A request of one operation, and one with no `remove` operation, are named as before.
    const kinds = count > 1 ? operationKinds(plan) : undefined,
      also = kinds
        ? [kinds.created ? 'creates ' + kinds.created : '', kinds.updated ? 'updates ' + kinds.updated : ''].filter(
            Boolean,
          )
        : [];
    reasons.push({
      effect: 'destructive',
      reason:
        'This deletes or removes ' +
        (kinds
          ? kinds.removed +
            (kinds.removed === 1 ? ' resource' : ' resources') +
            ' (' +
            plan.method +
            ' ' +
            plan.path +
            ')'
          : label) +
        current +
        (also.length ? ', and the same request ' + also.join(' and ') : '') +
        '. It cannot be undone.',
      ...(target ? {target} : {}),
    });
  }
  if (effects.publishes_live)
    reasons.push({
      effect: 'publishes_live',
      reason: 'This publishes ' + label + current + ' live: it takes effect for everyone as soon as it is executed.',
      ...(target ? {target} : {}),
    });
  if (effects.stops_delivery)
    reasons.push({
      effect: 'stops_delivery',
      reason:
        'This stops delivery of ' +
        label +
        current +
        (stops.length ? ': ' + stops.map(s => s.field + ' becomes ' + s.value).join(', ') : '') +
        '.',
      ...(target ? {target} : {}),
    });
  return reasons;
}
