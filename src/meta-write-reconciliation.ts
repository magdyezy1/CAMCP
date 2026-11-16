import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {CreatedLookup, CreatedLookupContext, StateReadBuilder} from './provider-adapter.js';
import {object} from './write-common.js';
import {agrees, lookupKey, sameValue, type Echo} from './created-agreement.js';
import {metaProductSetKind, metaProductSetListRead} from './meta-product-sets.js';
import {metaProductFeedKind, metaProductFeedListRead} from './meta-product-feeds.js';
import {metaProductCatalogKind, metaProductCatalogListRead} from './meta-product-catalogs.js';

// Writes and campaigns (ARC-01 phase B, wave 4c): Meta's parts of the read-only reconciliation of an uncertain write,
// moved verbatim from src/write-reconciliation.ts, which asks them as the adapter's `writes.createdLookup` and
// `writes.namedTargets`; its state read is built with the stage's read builder. R2.5 M2 (L1-07, L5-05) adds the lookups of a
// catalog, product set, feed, creative and audience, and closes the window of the lookup of a campaign, ad set and ad.
//
// What dates a Meta object differs by kind, so a lookup shows what it can tell and never more: a campaign, ad set and ad
// carry `created_time` and an audience `time_created`, so each is looked up by name and the window around the claim; a
// product set and a feed carry none, but the review froze the sets and feeds its catalog held, so one of that name that the
// review did not see is the one this write made; a catalog and a creative carry none and the review froze no list of them, so
// one of that name is shown (`undated`) and never called created, while none of that name in a whole list proves it absent.
/** A created object may carry a time a little before the claim (clock skew) and, at most, a quarter of an hour after it. */
const skewMs = 120000,
  afterMs = 15 * 60000;
const account = (v: unknown) => String(v ?? '').replace(/^act_/, '');
/** Names are compared as Meta's families compare them where they collide (case and surrounding space ignored), or exactly. */
const folded = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : undefined);
const trimmed = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);

/** The rows of the pages a lookup read, and whether Meta gave them whole: every answer a list, the last naming no page after it. */
function listed(responses: TransportResult[]): {rows: JsonObject[]; complete: boolean} {
  const pages = responses.map(r => {
    const rows = object(r?.data).data;
    return Array.isArray(rows) ? rows.map(object) : undefined;
  });
  return {
    rows: pages.flatMap(p => p ?? []),
    complete:
      pages.length > 0 && pages.every(p => p !== undefined) && !object(object(responses.at(-1)?.data).paging).next,
  };
}
/** The read of the page after the last answer, when it names a next page and the cursor to it; none otherwise. */
function nextPage(first: CompiledRequest, responses: TransportResult[]): CompiledRequest[] {
  const paging = object(object(responses.at(-1)?.data).paging),
    after = object(paging.cursors).after;
  return paging.next && typeof after === 'string' && after ? [{...first, query: {...first.query, after}}] : [];
}
/** What a lookup shows of an object: its ID and name, and when it was made where that is known. */
const shown = (r: JsonObject, at?: number): JsonObject => ({
  id: String(r.id),
  name: r.name,
  ...(at !== undefined ? {created_time: new Date(at).toISOString()} : {}),
});
/** One created object is the one this write made (its record's `index` says so); two or more are shown, never chosen between. */
const verdict = (found: JsonObject[], undated: JsonObject[], complete: boolean) => ({
  expected: 1,
  complete,
  found: found.length === 1 ? [{index: 0, ...found[0]}] : found,
  ...(undated.length ? {undated} : {}),
});
const receipt = (found: JsonObject[]): JsonObject => ({id: found[0]!.id});

/**
 * Dates rows by their creation time: in the window around the claim means created by this write, a time outside it means
 * another's, and a time that is missing or cannot be read cannot be placed against the claim (`undated`).
 */
function byTime(
  rows: JsonObject[],
  claimedAt: number,
  timeOf: (r: JsonObject) => number | undefined,
  // Whether the fields Meta echoes agree with the frozen request (R2.5 M2, lead review S2-3): an object of the same name, made in
  // the window, that differs in one of them is another's, a doubt that is shown and never called created.
  agree: (r: JsonObject) => boolean = () => true,
) {
  const found: JsonObject[] = [],
    undated: JsonObject[] = [];
  for (const r of rows) {
    const at = timeOf(r);
    if (at === undefined) undated.push(shown(r));
    else if (at >= claimedAt - skewMs && at <= claimedAt + afterMs)
      (agree(r) ? found : undated).push(shown(r, agree(r) ? at : undefined));
  }
  return {found, undated};
}
/** A campaign, ad set or ad's `created_time` (ISO 8601, as Meta writes it), or undefined. */
const isoTime = (r: JsonObject) => {
  const at = Date.parse(String(r.created_time));
  return Number.isFinite(at) ? at : undefined;
};
/** An audience's `time_created`: Unix seconds, a number or its digits (a value too large for seconds is milliseconds). */
const unixTime = (r: JsonObject) => {
  const v = r.time_created,
    n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? (n < 1e11 ? n * 1000 : n) : undefined;
};
/** The IDs of what the review saw in its catalog (`sets`, `feeds`), or undefined where its state kept no such list. */
function seen(context: CreatedLookupContext | undefined, key: 'sets' | 'feeds'): Set<string> | undefined {
  const rows = object(context?.state[0])[key];
  return Array.isArray(rows) ? new Set(rows.map(r => String(object(r).id))) : undefined;
}

const same = (...names: string[]): Echo[] => names.map(n => [n, n]);
/** The fields Meta echoes of a campaign, ad set or ad create that the lookup compares with the frozen request. */
const edgeEchoes: Record<string, readonly Echo[]> = {
  campaigns: same('objective', 'status', 'daily_budget', 'lifetime_budget'),
  adsets: same('status', 'daily_budget', 'lifetime_budget', 'optimization_goal', 'billing_event'),
  ads: same('status'),
};
/** The body field that names the parent an ad set (its campaign) or an ad (its ad set) is created under: the row echoes it too. */
const edgeParent: Record<string, string> = {adsets: 'campaign_id', ads: 'adset_id'};
/**
 * Meta campaign, ad set and ad creates: the account's edge filtered by the frozen name, created in the window of the claim, under
 * the parent the review froze (R2.5 M2, lead review S2-5): a multi-campaign launch repeats ad set and ad names under several parents.
 */
function metaEdgeCreated(read: StateReadBuilder, edge: RegExpExecArray, name: string, body: JsonObject): CreatedLookup {
  const echoes = edgeEchoes[edge[3]!] ?? [],
    parentField = edgeParent[edge[3]!],
    parent = parentField === undefined ? '' : String(body[parentField] ?? '');
  const request = read('/' + edge[1] + '/' + edge[2] + '/' + edge[3], {
    fields: [
      'id',
      'name',
      'created_time',
      ...(parentField ? [parentField] : []),
      ...echoes.map(([, listed]) => listed),
    ].join(','),
    filtering: JSON.stringify([{field: 'name', operator: 'EQUAL', value: name}]),
    limit: 25,
  });
  return {
    reads: [request],
    keys: [lookupKey(edge[3], parent, name)],
    match(responses, submittedAt) {
      // Whole only when Meta answered a list and named no page after it: an answer that is no list proves nothing absent.
      const {rows, complete} = listed(responses),
        bound = parentField !== undefined && parent !== '',
        // Another parent's object is plainly another's; a row that does not name its parent cannot be told, so it is a doubt.
        named = rows.filter(
          r => r.name === name && (!bound || r[parentField!] === undefined || String(r[parentField!]) === parent),
        ),
        {found, undated} = byTime(
          named.filter(r => !bound || r[parentField!] !== undefined),
          submittedAt,
          isoTime,
          r => agrees(body, r, echoes),
        ),
        unknown = named.filter(r => bound && r[parentField!] === undefined).map(r => shown(r));
      return verdict(found, [...undated, ...unknown], complete);
    },
    receipt,
  };
}
/**
 * A product set or feed: of the frozen name in the catalog, and one the review did not see in its catalog (it made it), while
 * the check runs within the window after the claim that dates the other kinds (R2.5 M2, lead review S3-2). Neither kind carries
 * a creation time, so a new one of that name read later may be another's (made in Commerce Manager, by another tool, or by a
 * replacement): it is shown, a doubt, and never called created.
 */
function metaCatalogEdgeCreated(
  first: CompiledRequest,
  name: string,
  before: Set<string> | undefined,
  inCatalog: (r: JsonObject) => boolean,
  agree: (r: JsonObject) => boolean,
  key: string,
): CreatedLookup {
  return {
    reads: [first],
    keys: [key],
    more: responses => nextPage(first, responses),
    match(responses, submittedAt, checkedAt = Date.now()) {
      const {rows, complete} = listed(responses),
        named = rows.filter(r => folded(r.name) === folded(name) && inCatalog(r));
      // Without the review's list nothing of that name can be told from an older one.
      const fresh = before ? named.filter(r => !before.has(String(r.id))) : [],
        recent = checkedAt <= submittedAt + afterMs;
      return before
        ? verdict(
            recent ? fresh.filter(agree).map(r => shown(r)) : [],
            (recent ? fresh.filter(r => !agree(r)) : fresh).map(r => shown(r)),
            complete,
          )
        : verdict(
            [],
            named.map(r => shown(r)),
            complete,
          );
    },
    receipt,
  };
}
/** An audience: of the frozen name in the account, made in the window of the claim, as its `time_created` says. */
function metaAudienceCreated(
  plan: CompiledRequest,
  first: CompiledRequest,
  name: string,
  body: JsonObject,
): CreatedLookup {
  return {
    reads: [first],
    keys: [lookupKey('customaudiences', account(plan.accountId), trimmed(name))],
    more: responses => nextPage(first, responses),
    match(responses, submittedAt) {
      const {rows, complete} = listed(responses),
        // An audience shared in from another ad account is that account's creation, not this write's.
        {found, undated} = byTime(
          rows.filter(
            r =>
              trimmed(r.name) === trimmed(name) &&
              (r.account_id === undefined || account(r.account_id) === account(plan.accountId)),
          ),
          submittedAt,
          unixTime,
          r => agrees(body, r, same('subtype')),
        );
      return verdict(found, undated, complete);
    },
    receipt,
  };
}
/**
 * Whether `candidate` is the frozen name with a separator, a date and, as a rule, a hash after it (`<name> 2026-10-10-ab12cd`):
 * how Meta is reported to decorate a creative's name (the L3 M6 report, unconfirmed, lead review S3-3). It is the frozen name
 * and not another creative's: only a name of that shape counts, and the exact name is matched separately.
 */
function decoratedName(frozen: string, candidate: unknown): boolean {
  const head = folded(frozen),
    c = folded(candidate);
  return (
    !!head &&
    !!c &&
    c.startsWith(head) &&
    /^[^a-z0-9]*\d{4}-\d{2}-\d{2}(?:[^a-z0-9]?[0-9a-f]{4,})?$/.test(c.slice(head.length))
  );
}
/**
 * A catalog or a creative: nothing dates it, so one of the frozen name is shown and none is the proof the create is absent. A
 * creative's name Meta may have decorated is matched as well (`decorated`), so a creative that was made never reads as absent.
 */
function metaUndatedCreated(
  first: CompiledRequest,
  name: string,
  live: (r: JsonObject) => boolean,
  key: string,
  decorated = false,
): CreatedLookup {
  return {
    reads: [first],
    keys: [key],
    more: responses => nextPage(first, responses),
    match(responses) {
      const {rows, complete} = listed(responses);
      return verdict(
        [],
        rows
          .filter(r => (folded(r.name) === folded(name) || (decorated && decoratedName(name, r.name))) && live(r))
          .map(r => shown(r)),
        complete,
      );
    },
    receipt,
  };
}

/** Whether a listed product set holds what the review froze: its filter (as JSON, whichever way it is written) and retailer ID. */
function setAgrees(body: JsonObject, listedSet: JsonObject): boolean {
  const json = (v: unknown) => {
    if (typeof v !== 'string') return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  };
  const asked = json(body.filter),
    got = json(listedSet.filter);
  return (
    (asked === undefined || got === undefined || got === null || sameValue(asked, got)) &&
    agrees(body, listedSet, [['retailer_id', 'retailer_id']])
  );
}
export function metaCreated(
  plan: CompiledRequest,
  read: StateReadBuilder,
  context?: CreatedLookupContext,
): CreatedLookup | undefined {
  const name = object(plan.body).name;
  if (plan.method !== 'POST' || typeof name !== 'string' || !name.trim()) return undefined;
  if (metaProductSetKind(plan) === 'create')
    return metaCatalogEdgeCreated(
      metaProductSetListRead(plan),
      name,
      seen(context, 'sets'),
      r => {
        const catalog = object(r.product_catalog).id;
        return catalog === undefined || String(catalog) === plan.path.split('/')[2];
      },
      r => setAgrees(object(plan.body), r),
      lookupKey('product_set', plan.path.split('/')[2], folded(name)),
    );
  if (metaProductFeedKind(plan) === 'create')
    return metaCatalogEdgeCreated(
      metaProductFeedListRead(plan),
      name,
      seen(context, 'feeds'),
      () => true,
      r =>
        agrees(
          object(plan.body),
          r,
          same('deletion_enabled', 'default_currency', 'feed_type', 'delimiter', 'encoding', 'quoted_fields_mode'),
        ),
      lookupKey('product_feed', plan.path.split('/')[2], folded(name)),
    );
  if (metaProductCatalogKind(plan) === 'create')
    return metaUndatedCreated(
      metaProductCatalogListRead(plan),
      name,
      () => true,
      lookupKey('catalog', plan.path.split('/')[2], folded(name)),
    );
  const edge = /^\/(v\d+\.\d+)\/(act_\d+)\/(campaigns|adsets|ads|adcreatives|customaudiences)$/.exec(plan.path);
  if (!edge) return undefined;
  const listing = (fields: string) => read('/' + edge[1] + '/' + edge[2] + '/' + edge[3], {fields, limit: 100});
  if (edge[3] === 'adcreatives')
    return metaUndatedCreated(
      listing('id,name,status'),
      name,
      r => r.status !== 'DELETED',
      lookupKey('adcreative', account(plan.accountId), folded(name)),
      true,
    );
  if (edge[3] === 'customaudiences')
    return metaAudienceCreated(plan, listing('id,account_id,name,time_created,subtype'), name, object(plan.body));
  return name.length > 400 ? undefined : metaEdgeCreated(read, edge, name, object(plan.body));
}
/** A Meta node edit (a POST to the node's ID): the receipt names the node. */
export function metaNamedTargets(plan: CompiledRequest): JsonObject | undefined {
  if (plan.method === 'POST' && /\/\d+$/.test(plan.path))
    return {success: true, data: {id: plan.path.split('/').at(-1)}};
  return undefined;
}
