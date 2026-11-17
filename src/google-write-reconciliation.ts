import type {CompiledRequest, JsonObject} from './types.js';
import type {CreatedLookup, CreatedLookupContext, StateReadBuilder} from './provider-adapter.js';
import {normalizeAccount} from './account-id.js';
import {googleAdsCustomers} from './google-version.js';
import {normalize} from './verification-core.js';
import {googleAdsReviewVolatile} from './google-review-volatile.js';
import {object} from './write-common.js';
import {agrees, frozen, lookupKey, type Echo} from './created-agreement.js';
import {googleBuildLookup} from './google-atomic-builds.js';
import {googleAssetLinkCreates} from './google-asset-links.js';
import {googleListingGroupLookup, googleListingGroupTree} from './google-listing-groups.js';

// Writes and campaigns (ARC-01 phase B, wave 4c): Google Ads' parts of the read-only reconciliation of an uncertain
// write, moved verbatim from src/write-reconciliation.ts, which asks them as the adapter's `writes.createdLookup` and
// `writes.namedTargets`; its state reads are built with the stage's read builder. R2.5 M2 (L2-13) adds the lookups of a
// build, an asset link batch and a listing group tree edit, which are reviewed families with their own read-back.
const gaqlText = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 255 && !/['\\\n\r]/.test(v);
const googleCreatable: Record<string, string> = {
  campaigns: 'campaign',
  campaignBudgets: 'campaign_budget',
  adGroups: 'ad_group',
  assetGroups: 'asset_group',
};
/**
 * The fields Google echoes of each named create that the lookup compares with the frozen request (R2.5 M2, lead review S2-3), as the
 * normalized row spells them (snake_case); a name is no identity, so another object of that name that differs in one is a doubt.
 */
const createdEchoes: Record<string, readonly Echo[]> = {
  campaign_budget: [
    ['amount_micros', 'amount_micros'],
    ['delivery_method', 'delivery_method'],
  ],
  campaign: [
    ['status', 'status'],
    ['advertising_channel_type', 'advertising_channel_type'],
  ],
  ad_group: [
    ['status', 'status'],
    ['type', 'type'],
  ],
  asset_group: [['status', 'status']],
};
/** The field of each resource that names the parent a create gives it (a campaign's budget, an ad group's or asset group's campaign). */
const parentOf: Record<string, string> = {campaign: 'campaign_budget', ad_group: 'campaign', asset_group: 'campaign'};
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const rowsOf = (response: unknown, entity: string): JsonObject[] => {
  const results = object(object(response).data).results;
  return (Array.isArray(results) ? results : []).map(r => object(object(r)[camel(entity)]));
};
/** The most rows a lookup's search asks for (its LIMIT). */
const searchLimit = 100;
/**
 * True unless a response leaves a page unread, or, for a search with a LIMIT, has as many rows as it: Google answers a search cut by
 * its LIMIT with no page token, so the answer may be the first of more, and a lookup never calls such an answer whole (R2.5 M2, lead
 * review S2-4).
 */
const wholeAnswer = (responses: {data?: unknown}[], limit?: number) =>
  responses.every(r => {
    const data = object(r.data);
    return !data.nextPageToken && !(limit !== undefined && Array.isArray(data.results) && data.results.length >= limit);
  });
/**
 * What the review froze of the objects a Google lookup counts (R2.5 M2, lead re-review N3): the IDs of those that existed when it was
 * prepared, which are not this write's, and whether that list is unknown (it could not be read whole), so that no match can be told
 * from an older object. A review prepared before the list existed has none, and is read as it was.
 */
function frozenObjects(context?: CreatedLookupContext): {older: Set<string>; blind: boolean} {
  const before = context?.existing;
  return {older: new Set(before?.whole ? before.ids : []), blind: before !== undefined && !before.whole};
}
/**
 * Google Ads creates of named resources (campaigns, budgets, ad groups, asset groups): one bounded search by the frozen
 * names. Google refuses a duplicate name for these, so one match per name is the created resource. A build, an asset link
 * batch and a listing group tree edit have lookups of their own (R2.5 M2, L2-13).
 */
export function googleCreated(
  plan: CompiledRequest,
  read: StateReadBuilder,
  context?: CreatedLookupContext,
): CreatedLookup | undefined {
  const kind = /\/([A-Za-z]+):mutate$/.exec(plan.path)?.[1];
  if (kind === 'googleAds') return googleBuildCreated(plan, read, context);
  if (kind === 'assetGroupListingGroupFilters') return googleTreeCreated(plan, read, context);
  const links = googleAssetLinkCreates(plan);
  if (links) return googleLinksCreated(plan, read, links);
  const resource = kind ? googleCreatable[kind] : undefined,
    operations = object(plan.body).operations;
  if (!resource || !Array.isArray(operations) || !operations.length || operations.some(op => !object(op).create))
    return undefined;
  const creates = operations.map(op => object(object(op).create)),
    names = creates.map(c => c.name),
    echoes = createdEchoes[resource] ?? [],
    // The parent each create gives its object, asked for in the search and matched (R2.5 M2, lead review S2-5): ad group and asset
    // group names repeat across campaigns.
    parentCol = parentOf[resource],
    parents = parentCol ? creates.map(c => frozen(c, parentCol)) : [],
    bound = parentCol !== undefined && parents.every(p => typeof p === 'string' && gaqlText(p));
  if (!names.every(gaqlText) || new Set(names).size !== names.length) return undefined;
  const id = normalizeAccount(plan.gateway, plan.accountId!);
  const query =
    'SELECT ' +
    [
      resource + '.resource_name',
      resource + '.name',
      ...(parentCol ? [resource + '.' + parentCol] : []),
      ...echoes.map(([, listed]) => resource + '.' + listed),
    ].join(', ') +
    ' FROM ' +
    resource +
    ' WHERE ' +
    resource +
    '.name IN (' +
    names.map(n => "'" + n + "'").join(', ') +
    // A removed object's name is free again: only live objects are this create's.
    ') AND ' +
    resource +
    ".status != 'REMOVED'" +
    (bound
      ? ' AND ' + resource + '.' + parentCol + ' IN (' + [...new Set(parents)].map(p => "'" + p + "'").join(', ') + ')'
      : '') +
    ' LIMIT ' +
    searchLimit;
  const {older, blind} = frozenObjects(context),
    listed = (responses: {data?: unknown}[]) =>
      (normalize(object(responses[0]?.data).results ?? [], googleAdsReviewVolatile) as JsonObject[]).map(r =>
        object(r[resource]),
      );
  return {
    reads: [read(googleAdsCustomers + id + '/googleAds:search', {}, {query}, 'POST')],
    keys: names.map((name, i) => lookupKey(resource, bound ? parents[i] : '', name)),
    existing: responses => ({
      ids: listed(responses).map(r => String(r.resource_name)),
      whole: wholeAnswer(responses, searchLimit),
    }),
    match(responses) {
      // An object of the name that existed when the review was prepared is not this write's (Google refuses a duplicate name, so an
      // older object is exactly why such a create fails); where that list is unknown, no match can be told from an older object.
      const rows = listed(responses).filter(r => !older.has(String(r.resource_name))),
        named = names.map((name, i) => rows.filter(r => r.name === name && (!bound || r[parentCol!] === parents[i]))),
        // Another object of that name that differs in a field the review froze is a doubt, never this write's (R2.5 M2, S2-3).
        found = named.map((list, i) => (blind ? [] : list.filter(r => agrees(creates[i]!, r, echoes)))),
        doubts = named.flatMap((list, i) => list.filter(r => blind || !agrees(creates[i]!, r, echoes)));
      return {
        expected: names.length,
        complete: wholeAnswer(responses, searchLimit),
        found: found.every(list => list.length === 1)
          ? found.map((list, index) => ({index, id: list[0]!.resource_name, name: names[index]}))
          : found.flat().map(r => ({id: r.resource_name, name: r.name})),
        ...(doubts.length ? {undated: doubts.map(r => ({id: r.resource_name, name: r.name}))} : {}),
      };
    },
    receipt: found => ({results: found.map(f => ({resourceName: f.id}))}),
  };
}
/**
 * A build (`googleAds:mutate`): one bounded search for each kind of the resources it names that Google keeps unique, by
 * those names and not removed (a removed campaign's name is free again). The build is found only as the set it made: every
 * named resource exactly once, each under the parent the build gave it (a campaign on the budget it named, an ad group or
 * asset group in the campaign it named). A build is all or nothing, so some of the set is another's, and two of a name are
 * shown and never chosen between. The receipt names what was found at the operations that made it; the results of the
 * build's unnamed operations (keywords, ads, criteria) are not known to a lookup by name.
 */
function googleBuildCreated(
  plan: CompiledRequest,
  read: StateReadBuilder,
  context?: CreatedLookupContext,
): CreatedLookup | undefined {
  const build = googleBuildLookup(plan);
  if (!build?.anchors.length || !build.anchors.every(a => gaqlText(a.name))) return undefined;
  const id = normalizeAccount(plan.gateway, plan.accountId!),
    parentField = parentOf,
    resources = [...new Set(build.anchors.map(a => a.resource))];
  const reads = resources.map(resource => {
    const anchors = build.anchors.filter(a => a.resource === resource),
      names = [...new Set(anchors.map(a => a.name))],
      fields = ['resource_name', 'name', ...(parentField[resource] ? [parentField[resource]!] : [])],
      // The parent the build gave them, in the query, where every one of them is an existing resource (not one the build creates):
      // ad group and asset group names repeat across campaigns, so a search by name alone may be cut by its LIMIT (S2-4).
      parents =
        parentField[resource] &&
        anchors.every(
          a =>
            !!a.parent &&
            !build.anchorTemps.includes(a.parent.ref) &&
            !/\/-\d+$/.test(a.parent.ref) &&
            gaqlText(a.parent.ref),
        )
          ? [...new Set(anchors.map(a => a.parent!.ref))]
          : [];
    return read(
      googleAdsCustomers + id + '/googleAds:search',
      {},
      {
        query:
          'SELECT ' +
          fields.map(f => resource + '.' + f).join(', ') +
          ' FROM ' +
          resource +
          ' WHERE ' +
          resource +
          '.name IN (' +
          names.map(n => "'" + n + "'").join(', ') +
          ') AND ' +
          resource +
          ".status != 'REMOVED'" +
          (parents.length
            ? ' AND ' +
              resource +
              '.' +
              parentField[resource] +
              ' IN (' +
              parents.map(p => "'" + p + "'").join(', ') +
              ')'
            : '') +
          ' LIMIT ' +
          searchLimit,
      },
      'POST',
    );
  });
  return {
    reads,
    // A parent the build itself creates has no name yet: it is the same as any other, under no parent.
    keys: build.anchors.map(a =>
      lookupKey(
        a.resource,
        a.parent && !build.anchorTemps.includes(a.parent.ref) && !/\/-\d+$/.test(a.parent.ref) ? a.parent.ref : '',
        a.name,
      ),
    ),
    existing: responses => ({
      ids: resources.flatMap((resource, i) => rowsOf(responses[i], resource).map(r => String(r.resourceName))),
      whole: wholeAnswer(responses, searchLimit),
    }),
    match(responses) {
      // The objects that existed when the review was prepared are not this build's; where that list is unknown, no match can be told
      // from an older object, so every match is a doubt.
      const {older, blind} = frozenObjects(context),
        rows = new Map(
          resources.map((resource, i) => [
            resource,
            rowsOf(responses[i], resource).filter(r => !older.has(String(r.resourceName))),
          ]),
        ),
        chosen = new Map<string, string>(),
        picked: JsonObject[] = [],
        others: JsonObject[] = [];
      let every = true;
      for (const [index, a] of build.anchors.entries()) {
        const field = parentField[a.resource],
          // The parent the build gave it: a resource it creates (the one found for it), or one that already existed.
          want = a.parent
            ? build.anchorTemps.includes(a.parent.ref)
              ? chosen.get(a.parent.ref)
              : a.parent.ref
            : undefined,
          constrained = !!a.parent && (build.anchorTemps.includes(a.parent.ref) || !/\/-\d+$/.test(a.parent.ref)),
          candidates = (rows.get(a.resource) ?? []).filter(
            r =>
              r.name === a.name &&
              (!constrained || (field !== undefined && want !== undefined && r[camel(field)] === want)),
          );
        if (candidates.length === 1 && !blind) {
          const name = String(candidates[0]!.resourceName);
          if (a.temp) chosen.set(a.temp, name);
          picked.push({index, id: name, name: a.name});
        } else {
          every = false;
          for (const c of candidates) others.push({id: String(c.resourceName), name: a.name});
        }
      }
      const found = every
        ? picked
        : [...picked.map(({index: _index, ...rest}) => rest), ...others].filter(
            (f, i, all) => all.findIndex(g => g.id === f.id) === i,
          );
      const complete = wholeAnswer(responses, searchLimit);
      // Where the objects that existed before cannot be told from the build's, what was found is shown as a doubt.
      return blind
        ? {found: [], undated: found, expected: build.anchors.length, complete}
        : {found, expected: build.anchors.length, complete};
    },
    receipt: found => ({
      mutateOperationResponses: build.operations.map((op, i) => {
        const at = build.anchors.findIndex(a => a.op === i);
        return at >= 0 && found[at] ? {[op.result]: {resourceName: found[at]!.id}} : {};
      }),
    }),
  };
}
/**
 * An asset link batch that only creates: the links have deterministic names, so one bounded search by them, live links only
 * (a removed link is no link: creating over it is allowed). All of them is applied, none is absent, and some of them is
 * another's change, which settles nothing. The receipt is the one Google answers, so the family's own read-back runs from it.
 */
function googleLinksCreated(
  plan: CompiledRequest,
  read: StateReadBuilder,
  links: {entity: string; names: string[]},
): CreatedLookup {
  const id = normalizeAccount(plan.gateway, plan.accountId!),
    {entity, names} = links;
  const query =
    'SELECT ' +
    entity +
    '.resource_name, ' +
    entity +
    '.status FROM ' +
    entity +
    ' WHERE ' +
    entity +
    '.resource_name IN (' +
    names.map(n => "'" + n + "'").join(', ') +
    ') AND ' +
    entity +
    ".status IN ('ENABLED', 'PAUSED')";
  return {
    reads: [read(googleAdsCustomers + id + '/googleAds:search', {}, {query}, 'POST')],
    match(responses) {
      const live = new Set(rowsOf(responses[0], entity).map(r => r.resourceName)),
        found = names.flatMap((name, index) => (live.has(name) ? [{index, id: name}] : []));
      return {
        found: found.length === names.length || !found.length ? found : found.map(({id: name}) => ({id: name})),
        expected: names.length,
        complete: wholeAnswer(responses),
      };
    },
    receipt: found => ({results: found.map(f => ({resourceName: f.id}))}),
  };
}
/**
 * A listing group tree edit, compared by shape as the family's own read-back compares it: the whole tree of each asset group
 * the review edits is read (R2.5 M3, G4b: a review has up to ten); every tree at the shape the reviewed request gives it means
 * applied (one result per group, naming the nodes that are new since the review read the tree), every tree at the shape the
 * review read before means not applied, and anything else (someone else changed one, half of one exists, a tree cannot be
 * read, or the edit changes nothing in any group) settles nothing.
 */
function googleTreeCreated(
  plan: CompiledRequest,
  read: StateReadBuilder,
  context?: CreatedLookupContext,
): CreatedLookup | undefined {
  const trees = googleListingGroupLookup(plan, context?.state ?? []);
  if (!trees?.length) return undefined;
  const id = normalizeAccount(plan.gateway, plan.accountId!),
    same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
  return {
    reads: trees.map(tree => read(googleAdsCustomers + id + '/googleAds:search', {}, {query: tree.query}, 'POST')),
    match(responses) {
      const nows = trees.map((_, i) => googleListingGroupTree(object(responses[i]?.data).results)),
        whole = wholeAnswer(responses) && nows.every(now => now !== undefined);
      // A group the edit leaves as it is proves nothing; a review that changes none of its groups settles nothing.
      if (!whole || trees.every(tree => same(tree.before, tree.after)))
        return {found: [], expected: trees.length, complete: false};
      if (trees.every((tree, i) => same(nows[i]!.shape, tree.after)))
        return {
          found: trees.map((tree, index) => ({
            index,
            id: tree.group + ' listing groups',
            created: nows[index]!.names.filter(n => !tree.existing.includes(n)),
          })),
          expected: trees.length,
          complete: true,
        };
      return {
        found: [],
        expected: trees.length,
        complete: trees.every((tree, i) => same(nows[i]!.shape, tree.before)),
      };
    },
    receipt: found => ({
      results: found
        .flatMap(f => (Array.isArray(f.created) ? (f.created as string[]) : []))
        .map(resourceName => ({resourceName})),
    }),
  };
}
/** An update or removal of Google Ads operations: the receipt names each operation's resource. */
export function googleNamedTargets(plan: CompiledRequest): JsonObject | undefined {
  const body = object(plan.body);
  if (Array.isArray(body.operations) && body.operations.length) {
    const names = body.operations.map((op: JsonObject) => {
      const update = object(op.update);
      return op.create ? undefined : (op.remove ?? update.resourceName ?? update.resource_name);
    });
    return names.every((n: unknown) => typeof n === 'string')
      ? {success: true, data: {results: names.map((resourceName: string) => ({resourceName}))}}
      : undefined;
  }
  return undefined;
}
