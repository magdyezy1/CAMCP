import {sameNativeAccount} from './account-id.js';
import {scrubPeople} from './personal-data.js';
import {changeRank} from './plan-approval.js';
import {providerHooks} from './provider-hooks.js';
import {familyOf} from './reviewed-families.js';
import {redactCredentialShapesWithPaths} from './security.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * What a request changes, row by row (R2.5 r25-approval-fields; the owner's friction report of 2026-11-25, B2 and B6): the object it acts on, its
 * id, the field and the value it is given, for every platform. The rows are read from the request a step compiles to (method, path, query and
 * body), never from a provider read, and after the same scrubbing a review gives the request it shows (`redactCredentialShapesWithPaths`), and a scrub
 * of people. A row has an `old` value or a name in its `object` only where the plan or a review holds one (`ChangeContext.before` and `names`);
 * an absent one is left out of the row, never marked unknown. Nothing is dropped silently: a field the decoder does not know is shown as clipped
 * JSON under its own key, and a body that is not an object is shown whole.
 *
 * The shapes read are the ones the platforms use: a REST edit of an object (its id is the end of the route), a body that is a list of records
 * (Snapchat's `adsquads`, Microsoft's `Campaigns`), Google's `operations` (a create, an update under its `update_mask`, a remove), a JSON Patch,
 * LinkedIn's `patch.$set` and Reddit's `data`, and TikTok's body of `<entity>_id` or `<entity>_ids` beside the fields it sets.
 */
export type ChangeValue = string | number | boolean | null;
export interface RequestChange {
  /** What the row is about: the kind of object (`ad set`, `new ad set`) and, where the plan or a review holds it, its name. */
  object: string;
  id?: string;
  /** Several objects of one change (a status for twenty ad groups): their ids, and how many. */
  ids?: string[];
  count?: number;
  field: string;
  old?: ChangeValue;
  new: ChangeValue;
}
export interface ChangeContext {
  /** What the request does (`create`, `update`, `delete`...), as src/review-summary.ts `operationOf` says. */
  operation: string;
  /** What it acts on, in the singular (`ad set`). */
  entity: string;
  plural?: string;
  /** The reference each stand-in value stands for (`step#/pointer`), where the request was checked with stand-ins (src/plan-reference-standins.ts). */
  references?: ReadonlyMap<string, string>;
  /** The name of an object, by its id (or `result of <step>`), where the plan or a review holds it. */
  names?: (id: string) => string | undefined;
  /** The value an object has now, by its id and field, where the plan or a review holds it. */
  before?: (id: string, field: string) => ChangeValue | undefined;
}

const isObj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
/** A value as the display of a review shows it: credential shapes hidden, the opaque ones and a phone number in a phone-named field too. */
const displayed = (v: unknown): any => redactCredentialShapesWithPaths(v).value;
const flat = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');
/** The longest a value or a name is shown; a longer one ends in an ellipsis. The exact request is the review's. */
export const valueLimit = 80,
  nameLimit = 60;
export const clip = (text: string, limit = valueLimit) => (text.length > limit ? text.slice(0, limit - 1) + '…' : text);
/** Keys that steer the request and set nothing on the object: the field mask, a request or idempotency key, the platform's options. */
const controlKeys = new Set([
  'updatemask',
  'fieldmask',
  'requestid',
  'idempotencykey',
  'executionoptions',
  'validateonly',
  'dryrun',
  'fields',
]);
/** What steers a request in its query string besides: the method a server reads from it. */
const queryControlKeys = new Set(['method', 'httpmethod', 'methodoverride']);
const rank = changeRank;
/** A stand-in is read as a reference in an id always, and in a value only when it is no short number a real value could be. */
function reference(value: string, ctx: ChangeContext, strict: boolean): string | undefined {
  const ref = ctx.references?.get(value);
  return ref !== undefined && (!strict || value.length >= 4 || /\D/.test(value))
    ? 'result of ' + ref.split('#')[0]
    : undefined;
}
function idText(v: unknown, ctx: ChangeContext): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string' || !v) return undefined;
  const ref = reference(v, ctx, false);
  if (ref !== undefined) return ref;
  // Google names a resource `customers/1/campaigns/2`; its id is the end.
  return clip(v.includes('/') ? v.slice(v.lastIndexOf('/') + 1) : v, valueLimit);
}
const replaceReferences = (v: unknown, ctx: ChangeContext): unknown =>
  typeof v === 'string'
    ? (reference(v, ctx, true) ?? v)
    : Array.isArray(v)
      ? v.map(x => replaceReferences(x, ctx))
      : isObj(v)
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replaceReferences(x, ctx)]))
        : v;
/** A money object (`{amount, currencyCode}`, LinkedIn's and Apple's) as one value with its currency. */
function moneyObject(v: unknown): string | undefined {
  if (!isObj(v) || !Object.keys(v).every(k => ['amount', 'currency', 'currencyCode', 'currency_code'].includes(k)))
    return undefined;
  const code = v.currencyCode ?? v.currency_code ?? v.currency;
  return (typeof v.amount === 'string' || typeof v.amount === 'number') && typeof code === 'string'
    ? v.amount + ' ' + code
    : undefined;
}
function valueOf(v: unknown, ctx: ChangeContext): ChangeValue {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return clip(reference(v, ctx, true) ?? v);
  return clip(moneyObject(v) ?? JSON.stringify(replaceReferences(v, ctx)) ?? 'null');
}

/** A record the request writes: the objects it acts on and the fields it sets on them. */
interface Written {
  entity?: string;
  created: boolean;
  deleted?: boolean;
  ids: string[];
  entries: [string, unknown][];
  /** Where a created record goes, from an id of another entity beside its list (Microsoft's `CampaignId` over its `AdGroups`): `campaign 100`. */
  parent?: string;
}
/**
 * The keys that name the account a request is made on (`advertiser_id`, `account_id`, `customer_id`): only a value under one of them that equals the
 * account is the account repeated. A field that happens to hold the same digits (a budget of 123 on account 123, a name) is a change like any other.
 */
const accountKeys = /^(?:ad)?account(?:id)?$|^advertiser(?:id)?$|^customer(?:id)?$/;
/** The paths of an update mask (`displayName,campaignFlight.plannedDates.endDate`); none where the request has no mask, or a `*` that names every field. */
function maskOf(mask: unknown): string[] | undefined {
  const paths = String(mask ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return paths.length && !paths.includes('*') ? paths : undefined;
}
/** A record's value at a mask path, each segment found by its flat name, with the path as the record spells it. */
function valueAt(record: JsonObject, path: string): {field: string; value: unknown} | undefined {
  const keys: string[] = [];
  let node: unknown = record;
  for (const segment of path.split('.')) {
    if (!isObj(node)) return undefined;
    const key = Object.keys(node).find(k => flat(k) === flat(segment));
    if (key === undefined) return undefined;
    keys.push(key);
    node = node[key];
  }
  return {field: keys.join('.'), value: node};
}
/**
 * What an update changes under its mask (Google's `update_mask`, DV360's and Business Profile's `updateMask`): each path of the mask with the value the
 * record gives it, and a path the record leaves out as a clear (set to nothing), never skipped. A field of the record outside the mask is no change.
 */
const underMask = (record: JsonObject, mask: string[]): [string, unknown][] =>
  mask.map(path => {
    const found = valueAt(record, path);
    return found ? [found.field, found.value] : [path, null];
  });
/** An API version segment (`v26.0`, `v1beta`): it names no object. */
const version = /^v\d/i;
/**
 * The id the route of an edit ends with (`/v26.0/456`, `…/adCampaigns/1`), or the one before a sub-collection (`/v26.0/789/users`): a segment with
 * a digit that is no API version and no account. A create names no object yet.
 */
function routeId(plan: CompiledRequest, created: boolean): string | undefined {
  if (created) return undefined;
  const segments = plan.path.split('?')[0]!.split('/').filter(Boolean),
    idLike = (s: string | undefined) => {
      const id = s?.split(':')[0];
      return id && /\d/.test(id) && !version.test(id) && !sameNativeAccount(plan.gateway, id, String(plan.accountId))
        ? id
        : undefined;
    };
  return (
    idLike(segments.at(-1)) ?? (segments.at(-1) && !/\d/.test(segments.at(-1)!) ? idLike(segments.at(-2)) : undefined)
  );
}
/** The keys that name the objects of a request about `entity`: `id`, `ids`, and `<entity>_id` and `<entity>_ids` in any spelling. */
export function targetKeys(entity: string): Set<string> {
  const base = flat(entity).replace(/(?<=[^s])s$/, '');
  return new Set(['id', 'ids', base + 'id', base + 'ids']);
}
const entriesOf = (o: JsonObject): [string, unknown][] => Object.entries(o);
function listOf(v: unknown, ctx: ChangeContext): string[] {
  return (Array.isArray(v) ? v : [v]).flatMap(x => idText(x, ctx) ?? []);
}
/** A flat record: the ids it names (the objects of an edit, never of a create), then its fields. */
function flatRecord(
  o: JsonObject,
  ids: string[],
  ctx: ChangeContext,
  created: boolean,
  account: (key: string, v: unknown) => boolean,
): Written {
  const keys = targetKeys(ctx.entity),
    taken: string[] = [],
    entries = entriesOf(o).filter(([k, v]) => {
      if (controlKeys.has(flat(k)) || account(k, v)) return false;
      if (!created && keys.has(flat(k))) {
        taken.push(...listOf(v, ctx));
        return false;
      }
      return true;
    });
  return {created, ids: [...ids, ...taken], entries};
}
/** A Google operation (`create`, `update` under its mask, `remove`), or the same under a combined `mutate`'s `<entity>_operation`. */
function googleOperation(op: JsonObject, ctx: ChangeContext, entity?: string): Written {
  const kind =
    typeof op.remove === 'string' ? 'remove' : isObj(op.create) ? 'create' : isObj(op.update) ? 'update' : undefined;
  if (kind === 'remove') return {entity, created: false, deleted: true, ids: listOf(op.remove, ctx), entries: []};
  const record = isObj(op[kind ?? '']) ? (op[kind!] as JsonObject) : op,
    resource = record.resource_name ?? record.resourceName,
    fields = entriesOf(record).filter(
      ([k]) => !['resource_name', 'resourcename'].includes(flat(k)) || kind === undefined,
    ),
    // An update changes what its mask names: a field the update leaves out is cleared, and a field outside the mask is no change.
    mask = kind === 'update' ? maskOf(op.update_mask ?? op.updateMask) : undefined,
    entries = mask ? underMask(Object.fromEntries(fields), mask) : fields;
  return {entity, created: kind === 'create', ids: kind === 'create' ? [] : listOf(resource, ctx), entries};
}
const isPatchOp = (o: unknown): o is JsonObject => isObj(o) && typeof o.op === 'string' && typeof o.path === 'string';
/** The records a request writes, by the shape of its body. */
function recordsOf(plan: CompiledRequest, body: unknown, query: JsonObject, ctx: ChangeContext): Written[] {
  const created = ctx.operation === 'create',
    route = routeId(plan, created),
    ids = route === undefined ? [] : [idText(route, ctx) ?? route],
    account = (key: string, v: unknown) =>
      plan.accountId !== undefined &&
      accountKeys.test(flat(key)) &&
      (typeof v === 'string' || typeof v === 'number') &&
      sameNativeAccount(plan.gateway, v, plan.accountId),
    records: Written[] = [],
    // The mask a request names in its query (DV360's and Business Profile's `updateMask`): what the update changes.
    queryMask = created ? undefined : maskOf(entriesOf(query).find(([k]) => flat(k) === 'updatemask')?.[1]);
  const queryEntries = entriesOf(query).filter(
    ([k, v]) => !controlKeys.has(flat(k)) && !queryControlKeys.has(flat(k)) && !account(k, v),
  );
  if (Array.isArray(body) && body.length && body.every(isPatchOp)) {
    // A JSON Patch (Meta, Snapchat, DV360): a field by its path; only an add, a replace, a remove or a move sets something.
    const entries: [string, unknown][] = body.flatMap((op: JsonObject): [string, unknown][] => {
      const field = String(op.path).replace(/^\//, '').replaceAll('/', '.');
      return op.op === 'add' || op.op === 'replace'
        ? [[field, op.value]]
        : op.op === 'remove'
          ? [[field, '(removed)']]
          : op.op === 'move' || op.op === 'copy'
            ? [[field, op.op + ' from ' + String(op.from)]]
            : [];
    });
    records.push({created, ids, entries});
  } else if (Array.isArray(body)) {
    for (const record of body) {
      // A batch item names its operation and holds its fields under `params` (X's batch): the operation says whether it creates or deletes, and the
      // fields are the item's own.
      const batch = isObj(record) && typeof record.operation_type === 'string' && isObj(record.params),
        operation = batch ? String(record.operation_type).toLowerCase() : '',
        item = batch ? {...(record.params as JsonObject)} : record;
      if (isObj(item)) {
        const written = flatRecord(item, [], ctx, batch ? operation === 'create' : created, account);
        records.push(batch && operation === 'delete' ? {...written, deleted: true} : written);
      } else records.push({created, ids, entries: [['body', record] as [string, unknown]]});
    }
  } else if (isObj(body)) {
    const keys = Object.keys(body),
      list = (key: string) => (Array.isArray(body[key]) ? (body[key] as unknown[]) : undefined);
    if (list('operations')?.length && list('operations')!.every(isObj)) {
      for (const op of list('operations') as JsonObject[]) records.push(googleOperation(op, ctx));
    } else if (list('mutate_operations')?.length && list('mutate_operations')!.every(isObj)) {
      for (const wrapper of list('mutate_operations') as JsonObject[])
        for (const [key, op] of entriesOf(wrapper))
          if (isObj(op)) records.push(googleOperation(op, ctx, key.replace(/_operation$/, '').replaceAll('_', ' ')));
    } else if (isObj(body.patch) && (isObj(body.patch.$set) || Array.isArray(body.patch.$delete))) {
      // LinkedIn's REST.li patch: the fields it sets, and the ones it deletes.
      const set = isObj(body.patch.$set) ? entriesOf(body.patch.$set) : [],
        gone = (Array.isArray(body.patch.$delete) ? body.patch.$delete : []).map((f: unknown): [string, unknown] => [
          String(f),
          '(removed)',
        ]);
      records.push({created, ids, entries: [...set, ...gone]});
    } else if (keys.length === 1 && keys[0] === 'data' && isObj(body.data)) {
      records.push(
        queryMask
          ? {created, ids, entries: underMask(body.data, queryMask)}
          : flatRecord(body.data, ids, ctx, created, account),
      );
    } else {
      // A list of records under the plural of the entity (Snapchat's `adsquads`, Microsoft's `Campaigns`).
      const base = flat(ctx.entity).replace(/(?<=[^s])s$/, ''),
        plurals = new Set([base + 's', flat(ctx.plural ?? '')]),
        container = keys.find(k => plurals.has(flat(k)) && list(k)?.length && list(k)!.every(isObj)),
        // A list whose every item names its own object by `<entity>_id` (TikTok's budget updates: `budget: [{adgroup_id, budget}]`) is a record each, so
        // that no row loses the id of the object it changes. The bare `id` of a list is not enough: a list of labels or interests carries one.
        entityIds = new Set([base + 'id', base + 'ids']),
        lists = created
          ? []
          : keys.filter(
              k =>
                list(k)?.length && list(k)!.every(x => isObj(x) && Object.keys(x).some(kk => entityIds.has(flat(kk)))),
            );
      if (container !== undefined) {
        // An id of another entity beside the list (Microsoft's `CampaignId` over its `AdGroups`) says where a created record goes; it is no field of the
        // records, and no change of an existing one.
        const rest = entriesOf(body).filter(([k, v]) => k !== container && !controlKeys.has(flat(k)) && !account(k, v)),
          parents = rest.filter(
            ([k, v]) =>
              /id$/.test(flat(k)) && !entityIds.has(flat(k)) && (typeof v === 'string' || typeof v === 'number'),
          ),
          parent = parents
            .map(
              ([k, v]) =>
                k
                  .replace(/_?ids?$/i, '')
                  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
                  .replace(/[-_]+/g, ' ')
                  .toLowerCase() +
                ' ' +
                (idText(v, ctx) ?? String(v)),
            )
            .join(', ');
        for (const record of list(container) as JsonObject[]) {
          const written = flatRecord(record, ids, ctx, created, account);
          records.push(created && parent ? {...written, parent} : written);
        }
        const others = rest.filter(entry => !parents.includes(entry));
        if (others.length) records.push({created, ids: [], entries: others});
      } else if (lists.length) {
        for (const key of lists)
          for (const record of list(key) as JsonObject[]) records.push(flatRecord(record, ids, ctx, created, account));
        const rest = entriesOf(body).filter(
          ([k, v]) => !lists.includes(k) && !controlKeys.has(flat(k)) && !account(k, v),
        );
        if (rest.length) records.push({created, ids: [], entries: rest});
      } else
        records.push(
          queryMask
            ? {created, ids, entries: underMask(body, queryMask)}
            : flatRecord(body, ids, ctx, created, account),
        );
    }
  } else if (body !== undefined) records.push({created, ids, entries: [['body', body]]});
  if (queryEntries.length) {
    const first = records.length === 1 ? records[0] : undefined;
    if (first) first.entries.push(...queryEntries);
    else records.push({created, ids, entries: queryEntries});
  }
  if (!records.length) records.push({created, ids, entries: []});
  // A DELETE that sets nothing says what it deletes.
  if (ctx.operation === 'delete')
    for (const record of records) if (!record.entries.length && !record.deleted) record.deleted = true;
  return records;
}
/** A value that is an amount: a number, or the text of one (the money fields of a summary are amounts, and `budget_mode` is not). */
export const isAmount = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v));
/**
 * The money amounts and the statuses inside a nested value, by their path (`creatives.0.operation_status`): at most 40, to a depth of 8. A money
 * object (`{amount, currencyCode}`) is one value, and a reference is no leaf.
 */
function nestedLeaves(
  base: string,
  value: unknown,
  depth = 0,
  out: [string, string | number][] = [],
): [string, string | number][] {
  if (depth > 8 || out.length >= 40) return out;
  if (Array.isArray(value)) value.forEach((x, i) => nestedLeaves(base + '.' + i, x, depth + 1, out));
  else if (isObj(value) && moneyObject(value) === undefined && !Object.hasOwn(value, '$ref'))
    for (const [k, x] of Object.entries(value)) {
      const path = base + '.' + k,
        rank = changeRank(k);
      if ((typeof x === 'string' || typeof x === 'number') && ((rank === 0 && isAmount(x)) || rank === 1))
        out.length < 40 && out.push([path, x]);
      else nestedLeaves(path, x, depth + 1, out);
    }
  return out;
}
/** The name a create gives its object. */
function nameOfCreate(entries: [string, unknown][]): string | undefined {
  const named =
    entries.find(([k, v]) => flat(k) === 'name' && typeof v === 'string' && v) ??
    entries.find(([k, v]) => /name$/.test(flat(k)) && typeof v === 'string' && v);
  return named ? clip(String(named[1]), nameLimit) : undefined;
}
/** The request as its review shows it: its provider's own view (a place-action link made safe), or itself. */
function shown(plan: CompiledRequest): CompiledRequest {
  const view = providerHooks(plan.gateway)?.writes?.shownRequest;
  return (view ? view(plan) : plan) as CompiledRequest;
}
const label = (ctx: ChangeContext, created: boolean, entity: string = ctx.entity, name?: string, parent?: string) =>
  (created ? 'new ' : '') + entity + (name ? ' "' + name + '"' : '') + (parent ? ' in ' + parent : '');

/**
 * Rows in the order they are read: the same change to several objects is one row that names them all (an object twice with the same change is
 * that change once), and money comes before status, dates, the name and the rest, each in the order the request gave. The rows of the parts of a
 * step that is sent in parts (more than 25 records) are merged by this too.
 */
export function mergeChanges(rows: readonly RequestChange[]): RequestChange[] {
  const out: {row: RequestChange; ids?: string[]}[] = [],
    seen = new Map<string, {row: RequestChange; ids?: string[]}>();
  for (const row of rows) {
    const ids = row.ids ?? (row.id === undefined ? undefined : [row.id]),
      key = JSON.stringify([row.object, row.field, row.old ?? null, row.new]),
      first = ids === undefined ? undefined : seen.get(key);
    if (ids !== undefined && first?.ids) first.ids.push(...ids.filter(id => !first.ids!.includes(id)));
    else {
      const entry = {row, ...(ids === undefined ? {} : {ids: [...ids]})};
      out.push(entry);
      if (ids !== undefined) seen.set(key, entry);
    }
  }
  return out
    .map(({row, ids}, order) => {
      const {id: _id, ids: _ids, count: _count, object, ...rest} = row;
      void [_id, _ids, _count];
      const lead = ids === undefined ? {} : ids.length > 1 ? {ids, count: ids.length} : {id: ids[0]!};
      return {row: {object, ...lead, ...rest}, order, rank: rank(row.field)};
    })
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map(x => x.row);
}

/**
 * The rows of a compiled request. `[]` for a request that sets nothing, and for a generation; a request whose family uploads people lists none of its values.
 * A request this cannot decode is one row that says so, and nothing of its body.
 */
export function requestChanges(plan: CompiledRequest, ctx: ChangeContext): RequestChange[] {
  try {
    // A generation (a shareable preview's link) acts on no entity: it has no change to list.
    if (ctx.operation === 'generate') return [];
    const created = ctx.operation === 'create';
    const spec = familyOf(plan)?.personalData;
    if (spec && spec.direction(plan) !== undefined) {
      const route = routeId(plan, created);
      return [
        {
          object: label(ctx, false),
          ...(route === undefined ? {} : {id: idText(route, ctx) ?? route}),
          field: 'people',
          new: 'withheld: personal data',
        },
      ];
    }
    const request = shown(plan),
      // The scrubbing a review gives the request it shows, and of people: only what these leave is read.
      clean = scrubPeople(displayed({body: request.body, query: request.query ?? {}})) as {
        body: unknown;
        query: JsonObject;
      };
    const rows: RequestChange[] = [];
    for (const record of recordsOf(plan, clean.body, isObj(clean.query) ? clean.query : {}, ctx)) {
      const entity = record.entity ?? ctx.entity,
        targets: (string | undefined)[] = record.ids.length ? record.ids : [undefined],
        made: RequestChange[] = [];
      for (const id of targets) {
        const held = record.created || id === undefined ? undefined : ctx.names?.(id),
          // A name or a value the plan or a review holds is shown as short as one the request gives.
          name = record.created ? nameOfCreate(record.entries) : held === undefined ? undefined : clip(held, nameLimit),
          object = label(ctx, record.created, entity, name, record.parent),
          lead = id === undefined ? {} : {id};
        for (const [key, value] of record.entries) {
          const before = id === undefined ? undefined : ctx.before?.(id, key),
            old = typeof before === 'string' ? clip(before) : before;
          made.push({object, ...lead, field: key, ...(old === undefined ? {} : {old}), new: valueOf(value, ctx)});
          // A money amount or a status inside a nested value (a list of creatives, each with its own status) is a row of its own: what a person
          // must not miss is never left in the clipped text of the value it sits in.
          if (value !== null && typeof value === 'object')
            for (const [field, leaf] of nestedLeaves(key, value))
              made.push({object, ...lead, field, new: valueOf(leaf, ctx)});
        }
        if (record.deleted) made.push({object, ...lead, field: 'object', new: 'deleted'});
      }
      rows.push(...made);
    }
    return mergeChanges(rows);
  } catch {
    return [
      {
        object: label(ctx, ctx.operation === 'create'),
        field: 'request',
        new: clip('not decoded: ' + String(displayed(String(plan.method) + ' ' + String(plan.path)))),
      },
    ];
  }
}
