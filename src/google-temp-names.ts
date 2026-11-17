import {MirrorError} from './errors.js';

/**
 * The temporary resource names of a Google Ads mutate request (R2.5 M3, L2-06 and G4c). Google lets the operations of one
 * request name a resource they create with a negative number where the server allocates the ID, and lets later operations
 * of the same request name it; the operations are applied in one transaction. Two grammars carry that, and this leaf is
 * the one place that knows both:
 *
 * - the simple form, `customers/{c}/{Collection}/-{n}`: a budget, campaign, ad group, asset or asset group;
 * - the composite form, `customers/{c}/{adGroupCriteria|assetGroupListingGroupFilters}/{parent}~-{n}`: a listing group
 *   node, named after the ad group or asset group it belongs to, `{parent}` being an existing positive ID or the
 *   temporary `-{m}` of one the same request creates (Google documents `{ad_group_id}~{temporary_criterion_id}` with an
 *   existing ad group; a temporary parent inside the name is UNVERIFIED until the lead's live checks A1 and A2).
 *
 * Operations linked by a temporary name travel in one request and are never split into parts (googleBatch). A leaf: it
 * imports no lifecycle module, so a family may use it without joining the registry's import cycle.
 */
export interface TempName {
  customer: string;
  collection: string;
  /** The temporary number of this resource: the digits after the minus sign of its last component. */
  number: string;
  /** The composite form only: what the name is under, an existing ID or the temporary number of a resource created earlier. */
  parent?: {id: string; temporary: boolean};
}
/** The collections whose names are composite: a listing group node is named after the ad group or asset group it is in. */
export const compositeCollections: readonly string[] = Object.freeze([
  'adGroupCriteria',
  'assetGroupListingGroupFilters',
]);
const simple = /^customers\/([^/]+)\/([A-Za-z]+)\/-(\d+)$/,
  composite =
    /^customers\/([^/]+)\/(adGroupCriteria|assetGroupListingGroupFilters)\/(?:([1-9][0-9]*)|-([1-9][0-9]*))~-([1-9][0-9]*)$/,
  // A temporary name in a shape wider than the grammar, so that the splitter fails closed: a name of another collection
  // with a `~-N` tail, or free text that holds one, is never cut apart. `leading` is a string that starts with one.
  anywhere = /customers\/[^/\s"']+\/[A-Za-z]+\/(?:-\d|\d+~-\d)/,
  leading = /^customers\/[^/]+\/[A-Za-z]+\/(?:-\d|\d+~-\d)/;

/** A temporary name as its parts, or undefined for any other value (an existing resource, another string, a number). */
export function parseTempName(name: unknown): TempName | undefined {
  if (typeof name !== 'string') return undefined;
  const s = simple.exec(name);
  if (s) return {customer: s[1]!, collection: s[2]!, number: s[3]!};
  const c = composite.exec(name);
  if (!c) return undefined;
  return {
    customer: c[1]!,
    collection: c[2]!,
    number: c[5]!,
    parent: c[3] !== undefined ? {id: c[3], temporary: false} : {id: c[4]!, temporary: true},
  };
}
/** The name of a parsed temporary name, in its grammar. */
export function formatTempName(t: TempName): string {
  const tail = t.parent ? (t.parent.temporary ? '-' : '') + t.parent.id + '~-' + t.number : '-' + t.number;
  return 'customers/' + t.customer + '/' + t.collection + '/' + tail;
}
function someString(value: unknown, test: (s: string) => boolean): boolean {
  const stack: unknown[] = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') {
      if (test(v)) return true;
    } else if (Array.isArray(v)) stack.push(...v);
    else if (v && typeof v === 'object') stack.push(...Object.values(v));
  }
  return false;
}
/** Whether any string inside `value` (an operation, a list of them, a request body) holds a temporary name of either form. */
export function containsTempName(value: unknown): boolean {
  return someString(value, s => anywhere.test(s));
}
/** Whether any string inside `value` starts with a temporary name of either form: a resource name field, as a build reads one. */
export function holdsTempName(value: unknown): boolean {
  return someString(value, s => leading.test(s));
}

/** The first positive ID a temporary number stands in as: far above any real one (the one-service checks accept existing IDs only). */
const standInBase = 9_000_000_000_000;
const stand = (n: string) => String(standInBase + Number(n));
/** A temporary name as the positive-ID name the one-service checks accept; any other string stays as it is. */
export function standIn(name: string): string {
  const t = parseTempName(name);
  if (!t) return name;
  return (
    'customers/' +
    t.customer +
    '/' +
    t.collection +
    '/' +
    (t.parent ? (t.parent.temporary ? stand(t.parent.id) : t.parent.id) + '~' + stand(t.number) : stand(t.number))
  );
}
/** The temporary name a stand-in stands for; any other string stays as it is. */
export function fromStandIn(name: string): string {
  const m = /^customers\/([^/]+)\/([A-Za-z]+)\/(?:(\d+)~)?(\d+)$/.exec(name);
  if (!m) return name;
  const back = (id: string) => Number(id) - standInBase,
    standing = (id: string) => Number(id) > standInBase;
  if (!standing(m[4]!)) return name;
  const tail = m[3] === undefined ? '-' + back(m[4]!) : (standing(m[3]) ? '-' + back(m[3]) : m[3]) + '~-' + back(m[4]!);
  return 'customers/' + m[1] + '/' + m[2] + '/' + tail;
}

/** The limits of the routes that take operations linked by temporary names (Q28, owner 2026-11-15: none of them is a raise of Google's 25 for independent operations). */
export const chainLimits = Object.freeze({oneService: 25, tree: 500, build: 1000});
/**
 * The sentence of each limit, fixed so the website translates it (the numbers are in the details). None says "1–25", which
 * is the splitter's own trigger (src/write-groups.ts groupLimitRefusal): a request this refuses is never cut into parts.
 */
const chainSentences: Record<number, string> = {
  [chainLimits.oneService]:
    'These operations are linked by temporary names, so they travel in one request and are never split into parts, and this route takes at most 25 of them. Send them as a build (google_ads_v23_google_ads_mutate, up to 1,000 operations), or as a plan whose later steps name earlier results with $ref.',
  [chainLimits.tree]:
    'These operations are linked by temporary names, so they travel in one request and are never split into parts, and a product tree review takes at most 500 of them. Send a smaller tree, or create the tree together with its ad group or asset group in a build (google_ads_v23_google_ads_mutate, up to 1,000 operations), or in a plan whose later steps name earlier results with $ref.',
  [chainLimits.build]:
    'These operations are linked by temporary names, so they travel in one request and are never split into parts, and a build takes at most 1,000 of them. Send the resources as several builds in one plan whose later steps name earlier results with $ref.',
};
/**
 * The refusal of a request whose operations are linked by temporary names and exceed the limit of the route they were sent
 * to (R2.5 M3, G4c): they cannot be cut into parts, because a part would name a resource that another part creates.
 * `route` is the action the request was sent to; the details are {operations, limit, route}, and the `field` that holds the
 * list (L2-07).
 */
export function chainTooLong(operations: number, limit: number, route: string, field = 'operations'): MirrorError {
  return new MirrorError('TEMP_ID_CHAIN_TOO_LONG', chainSentences[limit] ?? chainSentences[chainLimits.oneService]!, {
    operations,
    limit,
    route,
    field,
  });
}
/** Refuses a list of operations that is longer than `limit` and carries a temporary name; any other list passes. */
export function assertChainWithin(list: unknown, limit: number, route: string, field = 'operations'): void {
  if (Array.isArray(list) && list.length > limit && containsTempName(list))
    throw chainTooLong(list.length, limit, route, field);
}
