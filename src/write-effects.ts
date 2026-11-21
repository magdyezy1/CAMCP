import type {CompiledRequest, DeclaredOperation, JsonObject} from './types.js';
import {familyOf} from './reviewed-families.js';
import {providerOf} from './provider-adapters.js';
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
function targetCount(plan: CompiledRequest, declared: DeclaredOperation | undefined = declaredOperation(plan)): number {
  const body = object(plan.body) ? plan.body : {},
    kind = plan.path.split('/').at(-1) ?? '';
  if (Array.isArray(body.operations)) return body.operations.length;
  // A provider that writes a list of records in one request (Snapchat).
  const listed = providerHooks(plan.gateway)?.writes?.recordCount?.(body, kind);
  if (listed !== undefined) return listed;
  // A write that lists the IDs it acts on says how many its family or provider declares (TikTok's status changes and deletions of several), or
  // the convention of its route does (`listedIds`).
  return declared?.count !== undefined && Number.isSafeInteger(declared.count) && declared.count >= 1
    ? declared.count
    : (listedIds(plan) ?? 1);
}
/**
 * How many IDs a DELETE lists by the convention of its route (r25-field3-livefix, item 3): the last segment of the path is a collection and the body
 * lists its IDs under the collection's singular and `Ids` (DELETE …/Campaigns with CampaignIds, …/AdGroups with AdGroupIds). The summary and the
 * effects counted such a request as one, whatever it listed. Undefined for any other request.
 */
export function listedIds(plan: CompiledRequest): number | undefined {
  if (plan.method !== 'DELETE') return undefined;
  const collection = plan.path.split('/').filter(Boolean).at(-1) ?? '',
    body = object(plan.body) ? plan.body : {},
    list = body[collection.replace(/s$/, '') + 'Ids'];
  return Array.isArray(list) && list.length ? list.length : undefined;
}
/**
 * What the write's own side declares it does (R2.5 S2, owner 2026-11-15: the approver must read the real operation): the family that reviews
 * it, then its provider, for the writes the review accepts (a registered family's, or the provider's generic entity writes, as
 * src/reviewed-routes.ts decides). Each claims its routes by method and path, so an answer cannot be had by naming an action, and each
 * already tells a create from an edit to plan the review's reads. A write the review does not accept is read from its path. This never
 * refuses: a family that cannot be asked (two claiming one request is refused elsewhere, before anything is sent) leaves the path to be read.
 * `state` is the review's reads, given where the targets are named. Here, and not in src/review-summary.ts, because the effects ask it too
 * (r25-field3-livefix, item 3: they counted one target for a status change or a deletion of several).
 */
export function declaredOperation(plan: CompiledRequest, state?: unknown[]): DeclaredOperation | undefined {
  if (plan.readOnly || plan.specialTransport) return undefined;
  try {
    const family = familyOf(plan);
    return (
      family?.operation?.(plan, state) ??
      (family || providerOf(plan.gateway)?.entityWrites?.claims(plan)
        ? providerHooks(plan.gateway)?.writes?.operation?.(plan, state)
        : undefined)
    );
  } catch {
    return undefined;
  }
}
/**
 * The current status the review read for each target of the request, upper case (undefined for a target it read none for), or none at all where
 * it cannot say who the targets are: a write that lists several IDs and declares no targets (the first record read is no more one of them than the
 * account's row is). A target the write's family or provider names carries its own status; a single target is the first record with one.
 */
function targetStatuses(plan: CompiledRequest, state: unknown[]): (string | undefined)[] | undefined {
  const declared = declaredOperation(plan, state);
  if (declared?.targets?.length) return declared.targets.map(t => t.status?.toUpperCase());
  return targetCount(plan, declared) === 1 ? [targetRecord(plan, state)?.status?.toUpperCase()] : undefined;
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
    // The statuses of the targets the review read, one for each (a write that lists several IDs is decided over every one of them, not over
    // the first record read: r25-field3-livefix, item 3); none known where the review read none or the request has several it cannot name.
    statuses = state ? targetStatuses(plan, state) : undefined,
    differs = (value: string) => !statuses || statuses.some(status => status !== value.toUpperCase()),
    changes = delivery.stops.filter(s => differs(s.value)),
    // Deleting what is already paused, archived or removed stops nothing; an unknown current status may serve.
    stops =
      changes.length > 0 ||
      (destructive &&
        delivery.serving &&
        (!statuses || statuses.some(status => !(status && delivery.idle.includes(status)))));
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
/** How many targets a reason names one by one; the rest are counted (a deletion of twenty keywords names ten and says "and 10 more"). */
const namedTargetsShown = 10;
/**
 * The targets a write acts on, as a reason names them: "campaign "Brand" (111)" for one, "2 campaigns: "Brand" (111), "Sale" (112)" for several.
 * A name is the entity's own, clipped; `detail` (a negative keyword's match type) comes first inside the parentheses, with the ID.
 */
function namedTargets(
  targets: NonNullable<DeclaredOperation['targets']>,
  declared: DeclaredOperation | undefined,
): string {
  const entity = declared?.entity ?? 'resource',
    plural = declared?.plural ?? (/s$/.test(entity) ? entity : entity + 's'),
    each = (t: (typeof targets)[number]) => {
      const inside = [t.detail, t.id].filter(Boolean).join(', '),
        name = t.name?.slice(0, 120);
      return name && name !== t.id ? '"' + name + '" (' + inside + ')' : inside;
    },
    shown = targets.slice(0, namedTargetsShown).map(each).join(', '),
    rest = targets.length - namedTargetsShown;
  return (
    (targets.length === 1 ? entity + ' ' : targets.length + ' ' + plural + ': ') +
    shown +
    (rest > 0 ? ', and ' + rest + ' more' : '')
  );
}
/** The record of the account a review read (a currency marks it), or undefined. */
export function accountRecord(state: unknown[]): JsonObject | undefined {
  const find = (v: unknown, depth: number): JsonObject | undefined => {
    if (depth > 5) return undefined;
    if (Array.isArray(v)) {
      for (const x of v) {
        const found = find(x, depth + 1);
        if (found) return found;
      }
      return undefined;
    }
    if (!object(v)) return undefined;
    if (typeof v.currency === 'string' || typeof v.currencyCode === 'string' || typeof v.currency_code === 'string')
      return v;
    for (const x of Object.values(v)) {
      const found = find(x, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return find(state, 0);
}
/** Whether `record` is `inside` or holds it (an advertiser holds its general settings, where its currency is). */
export function holds(record: unknown, inside: JsonObject, depth = 0): boolean {
  if (record === inside) return true;
  if (depth > 5 || !record || typeof record !== 'object') return false;
  return Object.values(record).some(v => holds(v, inside, depth + 1));
}
/**
 * The record of the review's reads that is the one target of a write: the first with a status, as `stateTarget` finds it, but never the account's own
 * record or what it holds, unless the write is to the account itself (a path that is its provider's account path and nothing after it). The first
 * record a review reads is most often the account's, and a deletion of one of its parts named the account as what is deleted (r25-field3-livefix,
 * item 3: "This deletes or removes <the advertiser's name>"). The summary picks its target the same way.
 */
export function targetRecord(plan: CompiledRequest, state: unknown[]): ReturnType<typeof stateTarget> {
  const account = accountRecord(state),
    accountPath = providerHooks(plan.gateway)?.writes?.accountPath?.exec(plan.path)?.[0],
    writesAccount = accountPath !== undefined && accountPath.length === plan.path.length;
  return stateTarget(state, account && !writesAccount ? record => holds(record, account) : undefined);
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
  const declared = declaredOperation(plan, state),
    // A write that lists the IDs it acts on, and whose family or provider names them from the review's reads (r25-field3-livefix, item 3): the
    // reason counts and names every one of them. The first record the review read is no more one of them than the account's row is: the reason of
    // a deletion of four campaigns named the first, and that of a deletion of negative keywords named the advertiser.
    targets = declared?.targets?.length ? declared.targets : undefined,
    count = targets ? targets.length : targetCount(plan, declared),
    // A request that writes several entities is named by its count: the first record read is not "the" target.
    target = targets
      ? targets.length === 1
        ? {id: targets[0]!.id, name: targets[0]!.name, status: targets[0]!.status}
        : undefined
      : count === 1
        ? targetRecord(plan, state)
        : undefined,
    label = targets
      ? namedTargets(targets, declared)
      : count > 1
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
