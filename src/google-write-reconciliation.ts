import type {CompiledRequest, JsonObject} from './types.js';
import type {CreatedLookup, CreatedLookupContext, StateReadBuilder} from './provider-adapter.js';
import {normalizeAccount} from './account-id.js';
import {googleAdsCustomers} from './google-version.js';
import {normalize} from './verification-core.js';
import {googleAdsReviewVolatile} from './google-review-volatile.js';
import {object} from './write-common.js';
import {agrees, type Echo} from './created-agreement.js';
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
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const rowsOf = (response: unknown, entity: string): JsonObject[] => {
  const results = object(object(response).data).results;
  return (Array.isArray(results) ? results : []).map(r => object(object(r)[camel(entity)]));
};
/** True unless a response leaves a page unread. */
const wholeAnswer = (responses: {data?: unknown}[]) => responses.every(r => !object(r.data).nextPageToken);
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
  if (kind === 'googleAds') return googleBuildCreated(plan, read);
  if (kind === 'assetGroupListingGroupFilters') return googleTreeCreated(plan, read, context);
  const links = googleAssetLinkCreates(plan);
  if (links) return googleLinksCreated(plan, read, links);
  const resource = kind ? googleCreatable[kind] : undefined,
    operations = object(plan.body).operations;
  if (!resource || !Array.isArray(operations) || !operations.length || operations.some(op => !object(op).create))
    return undefined;
  const creates = operations.map(op => object(object(op).create)),
    names = creates.map(c => c.name),
    echoes = createdEchoes[resource] ?? [];
  if (!names.every(gaqlText) || new Set(names).size !== names.length) return undefined;
  const id = normalizeAccount(plan.gateway, plan.accountId!);
  const query =
    'SELECT ' +
    [resource + '.resource_name', resource + '.name', ...echoes.map(([, listed]) => resource + '.' + listed)].join(
      ', ',
    ) +
    ' FROM ' +
    resource +
    ' WHERE ' +
    resource +
    '.name IN (' +
    names.map(n => "'" + n + "'").join(', ') +
    ') LIMIT 100';
  return {
    reads: [read(googleAdsCustomers + id + '/googleAds:search', {}, {query}, 'POST')],
    match(responses) {
      const rows = (normalize(object(responses[0]?.data).results ?? [], googleAdsReviewVolatile) as JsonObject[]).map(
          r => object(r[resource]),
        ),
        named = names.map(name => rows.filter(r => r.name === name)),
        // Another object of that name that differs in a field the review froze is a doubt, never this write's (R2.5 M2, S2-3).
        found = named.map((list, i) => list.filter(r => agrees(creates[i]!, r, echoes))),
        doubts = named.flatMap((list, i) => list.filter(r => !agrees(creates[i]!, r, echoes)));
      return {
        expected: names.length,
        complete: !object(responses[0]?.data).nextPageToken,
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
function googleBuildCreated(plan: CompiledRequest, read: StateReadBuilder): CreatedLookup | undefined {
  const build = googleBuildLookup(plan);
  if (!build?.anchors.length || !build.anchors.every(a => gaqlText(a.name))) return undefined;
  const id = normalizeAccount(plan.gateway, plan.accountId!),
    parentField: Record<string, string> = {campaign: 'campaign_budget', ad_group: 'campaign', asset_group: 'campaign'},
    resources = [...new Set(build.anchors.map(a => a.resource))];
  const reads = resources.map(resource => {
    const names = [...new Set(build.anchors.filter(a => a.resource === resource).map(a => a.name))],
      fields = ['resource_name', 'name', ...(parentField[resource] ? [parentField[resource]!] : [])];
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
          ".status != 'REMOVED' LIMIT 100",
      },
      'POST',
    );
  });
  return {
    reads,
    match(responses) {
      const rows = new Map(resources.map((resource, i) => [resource, rowsOf(responses[i], resource)])),
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
        if (candidates.length === 1) {
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
      return {found, expected: build.anchors.length, complete: wholeAnswer(responses)};
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
 * A listing group tree edit, compared by shape as the family's own read-back compares it: the whole tree of the asset group
 * is read; the shape the reviewed request gives it means applied (one result, naming the nodes that are new since the review
 * read the tree), the shape the review read before means not applied, and anything else (someone else changed it, half of it
 * exists, the tree cannot be read, or the edit changes nothing) settles nothing.
 */
function googleTreeCreated(
  plan: CompiledRequest,
  read: StateReadBuilder,
  context?: CreatedLookupContext,
): CreatedLookup | undefined {
  const tree = googleListingGroupLookup(plan, context?.state ?? []);
  if (!tree) return undefined;
  const id = normalizeAccount(plan.gateway, plan.accountId!),
    same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
  return {
    reads: [read(googleAdsCustomers + id + '/googleAds:search', {}, {query: tree.query}, 'POST')],
    match(responses) {
      const data = object(responses[0]?.data),
        now = googleListingGroupTree(data.results),
        whole = wholeAnswer(responses) && now !== undefined;
      if (!now || !whole || same(tree.before, tree.after)) return {found: [], expected: 1, complete: false};
      if (same(now.shape, tree.after))
        return {
          found: [
            {index: 0, id: tree.group + ' listing groups', created: now.names.filter(n => !tree.existing.includes(n))},
          ],
          expected: 1,
          complete: true,
        };
      return {found: [], expected: 1, complete: same(now.shape, tree.before)};
    },
    receipt: found => ({
      results: (Array.isArray(found[0]?.created) ? (found[0]!.created as string[]) : []).map(resourceName => ({
        resourceName,
      })),
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
