import {MirrorError} from './errors.js';
import {sha256, stable} from './security.js';
import {chainLimits} from './google-temp-names.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * The product partition trees of Google Ads, one validation for both (R2.5 M3, G5 and L2-09). A listing group tree decides
 * which Merchant Center products an ad group or an asset group advertises (Google Ads API, "Listing Groups for Retail" for
 * Performance Max, "Create listing groups" for Standard Shopping): one root; each subdivision completely partitioned along
 * one dimension, with an "Other" node of that dimension; units as leaves. Nodes created in one request name each other with
 * temporary names (src/google-temp-names.ts), parents come before their children, and removals go leaves first.
 *
 * Performance Max (src/google-listing-groups.ts) and Standard Shopping (src/google-shopping-tree.ts) differ in what a node is
 * (an asset group listing group filter with an included or excluded unit; an ad group criterion with a unit that may be
 * negative and carries the bid), so each describes its nodes with an adapter, and this module holds what they share: the
 * dimension of a case value, the tree that a request leaves, the completeness of a tree, and its shape, the path of dimension
 * values to each node, which compares trees regardless of the IDs Google allocates.
 *
 * Every refusal here carries the details {field, rule} and, where one operation is at fault, {operation, node} (L2-07): `rule`
 * is one of `treeRules`, `field` the path of the request it is about (the operation's own field, or `operations` for a
 * refusal about the tree the request leaves as a whole), and `allowed` the closed list a value was refused against. The
 * refusals that name what the tree belongs to (the asset group, the ad group) are the adapter's own sentences.
 */
export const treeRules = Object.freeze([
  // The dimension of a node's case value.
  'dimension_kind',
  'dimension_fields',
  'dimension_level',
  'dimension_value',
  // The tree a request leaves: how its operations apply, in order, to the tree there is.
  'node_missing',
  'remove_before_children',
  'node_exists',
  'existing_root',
  'missing_parent',
  'parent_is_unit',
  // The completeness of that tree.
  'empty_tree',
  'foreign_source',
  'root_count',
  'excluded_root',
  'unit_children',
  'subdivision_children',
  'mixed_dimensions',
  'other_missing',
  'other_repeated',
  'repeated_value',
  // A path from the root: a dimension is used once on it, a level follows the level before it, and the "Other" node of a level is
  // not refined by the hierarchy (R2.5 M3 round 2, S3-1: each is a refusal Google gives at execute, which the review gives at prepare).
  'ancestor_dimension',
  'level_order',
  'other_refined',
  // Rules of one adapter's own nodes (src/google-shopping-tree.ts).
  'bid_on_subdivision',
  'negative_subdivision',
  'bid_on_excluded_unit',
  'no_unit',
] as const);
export type TreeRule = (typeof treeRules)[number];
/**
 * The closed set of rules of the refusals that come before a tree exists (R2.5 M3 round 2, S4-4): one create that does not meet the
 * shape of its node, one operation of a review, and a tree inside a build. A refusal of the tree modules carries its rule from this set
 * or from `treeRules`, which names the refusals about the tree itself; a refusal about the whole request (the query, the body, the number
 * of operations, the account) or about what the review read of Google has none. The two sets share no value.
 */
export const nodeRules = Object.freeze([
  // One create of a node (src/google-listing-groups.ts pmaxCreate, src/google-shopping-tree.ts shoppingCreate).
  'create_keys',
  'create_group',
  'listing_group_keys',
  'node_type',
  'listing_source',
  'negative_value',
  'status_value',
  'bid_value',
  'node_name',
  'subdivision_unnamed',
  'parent_link',
  'root_case_value',
  // One operation of a review.
  'remove_target',
  'node_twice',
  'one_group',
  'group_limit',
  'operation_kind',
  'other_criterion',
  // A tree inside a build (src/google-build-trees.ts).
  'tree_of_existing_group',
  'temporary_parent_refused',
] as const);
export type NodeRule = (typeof nodeRules)[number];
/**
 * The details of a refusal of the tree modules (R2.5 M3 round 3, N8): `rule`, when there is one, is a value of one of the two closed
 * sets, so a rule that is in neither does not compile at the helpers that throw the refusals (the `invalid` of each module, the
 * adapter's `refuse`, a build's `refuse`); every other key is open, as the details of any refusal are.
 */
export type RefusalDetails = JsonObject & {rule?: TreeRule | NodeRule};

/** A node of a tree, as the final tree holds it: the fields that any adapter's checks and shape need. */
export interface TreeNode {
  /** Its resource name; the temporary name of a new node, or `operations[i]` for a new node that has none. */
  name: string;
  /** The adapter's node type: Performance Max SUBDIVISION, UNIT_INCLUDED or UNIT_EXCLUDED; Standard Shopping SUBDIVISION or UNIT. */
  type: string;
  parent?: string;
  /** The dimension and value that refine its parent; none on the root. */
  caseValue?: JsonObject;
  /** Performance Max: the listing source of the filter (a retail tree has SHOPPING). */
  source?: string;
  /** Standard Shopping: whether the unit excludes its products. */
  negative?: boolean;
  /** Standard Shopping: the unit's bid in micros, as a decimal string; none on a subdivision. */
  bid?: string;
  /**
   * Standard Shopping: the node's status as Google lists it (a create sends ENABLED or none: Google does not keep a listing group's status,
   * package r25-m3-live F2); an omitted one reads as ENABLED. Only a unit's counts in the shape, never a subdivision's.
   */
  status?: string;
  /** The request's operation that creates it and where its create is, for the details of a refusal; none for a node that exists. */
  op?: number;
  at?: string;
}
/** An operation of a tree edit: the removal of a node that exists, or the creation of one. */
export interface TreeOperation {
  remove?: string;
  create?: TreeNode;
  /** The request's operation and the path of this one in it, for the details of a refusal. */
  op?: number;
  at?: string;
}
/** What the two trees differ in. */
export interface TreeAdapter {
  /** The code of this tree's input refusals. */
  readonly code: string;
  /** Where a node's parent link and case value are in its create, as paths after `.create` in the spelling the request uses (L2-07). */
  readonly fields: {readonly parent: string; readonly caseValue: string};
  /**
   * Each dimension of a case value: the field that holds a value (absent for the "Other" node), the level or index that splits
   * siblings, and whether its levels form a hierarchy (product type and product category: level 2 refines level 1).
   */
  readonly dimensions: Readonly<Record<string, {value: string; level?: string; hierarchical?: boolean}>>;
  isSubdivision(node: TreeNode): boolean;
  isUnit(node: TreeNode): boolean;
  /** A unit that removes its products from what serves. */
  isExcluded(node: TreeNode): boolean;
  /** What the shape shows of a node after its path, in brackets. */
  label(node: TreeNode): string;
  /** A node of another kind than this tree edits (a webpage listing group in a retail tree), and the refusal of one. */
  readonly foreign?: {is(node: TreeNode): boolean; refuse(details: RefusalDetails): never};
  /** This tree's own rules on one node of the final tree (a bid on a subdivision). */
  node?(node: TreeNode): void;
  /** This tree's own rules on the whole final tree, once it is complete (at least one unit). */
  tree?(nodes: TreeNode[]): void;
  /** The refusals that name what the tree belongs to; each is a refusal, never a return. */
  readonly refuse: {
    missing(name: string, details: RefusalDetails): never;
    existingRoot(details: RefusalDetails): never;
    emptyTree(details: RefusalDetails): never;
  };
}
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(code: string, message: string, details: RefusalDetails): never {
  throw new MirrorError(code, message, details);
}
/** What a refusal about the tree the request leaves as a whole names as its field: the request's list of operations (L2-07). */
export const wholeTree = 'operations';

/**
 * The sentence of a body that carries validateOnly (r25-fr-listings, the owner's friction report A3: "validateOnly was refused on the
 * listing-group review"). It stays refused, because a frozen request that held it would make execute a success that applied nothing; what
 * validates a review is the provider check, which prepare runs by default for Google and `provider_check` asks for or skips.
 * One sentence for the Performance Max review, the Standard Shopping review, the combined mutate and every other Google mutate.
 */
export const validateOnlySentence =
  'validateOnly cannot be part of a reviewed request: prepare already asks Google to validate the request without applying it (provider_check, on by default for Google; send provider_check: true to require it), and a review that Google rejects cannot be executed. Send the operations without it.';
/** Whether a body key is a validation-only request, in either spelling. */
export const isValidateOnlyKey = (key: string) => key === 'validateOnly' || key === 'validate_only';

/**
 * The shape of a tree as a review lists it (`final_tree`): every line, but for a tree the server built, which lists its first lines and counts
 * the rest, with the hash of them all (r25-fr-listings): a result, a receipt and an audit row of 3,000 lines are none of them what a person reads.
 */
export function listedShape(plan: CompiledRequest, lines: string[], shown = 25): JsonObject {
  if (!plan.treeBuild || lines.length <= shown) return {final_tree: lines};
  return {
    final_tree: lines.slice(0, shown),
    final_tree_omitted: lines.length - shown,
    final_tree_sha256: sha256(lines.join('\n')),
  };
}
/**
 * The most operations a tree request may hold (r25-fr-listings; Q28, owner 2026-11-27 in chat: "Yes, 10,000 for built trees"): the 500 of a
 * request a caller sent, `chainLimits.treeBuild` for one the server built from a source and marked (`CompiledRequest.treeBuild`). The mark
 * is the SHA-256 of the operations it was made for, so it holds for this body and no other: a plan whose operations changed after it was
 * marked, or a mark on a request that holds other operations, is refused and sends nothing (a refusal about the whole request, which names
 * the field `operations` and no rule, as the others of its kind do). Execute asks again with the frozen plan.
 */
export function treeLimit(p: CompiledRequest, code: string): number {
  const mark = p.treeBuild;
  if (!mark) return chainLimits.tree;
  const operations = object(p.body) && Array.isArray(p.body.operations) ? p.body.operations : undefined;
  if (!operations || mark.operations !== operations.length || mark.operations_sha256 !== sha256(stable(operations)))
    invalid(
      code,
      'The mark of a built tree is not the mark of these operations: a request passes the limit of a hand-sent review only when the server built it, and it holds exactly what the server built.',
      {field: wholeTree, mark: 'treeBuild'},
    );
  return chainLimits.treeBuild;
}
/**
 * The details of a refusal about `node`: its operation and where it is in the request (when it came from one), its name, the rule.
 * A node that exists, or a refusal about the whole tree, names `operations` as its field.
 */
export function treeDetails(rule: TreeRule, node?: TreeNode, field = '', extra: JsonObject = {}): JsonObject {
  return {
    ...(node?.op !== undefined ? {operation: node.op} : {}),
    ...(node ? {node: node.name} : {}),
    field: node?.at ? node.at + field : wholeTree,
    rule,
    ...extra,
  };
}

/** The dimension that splits a node from its siblings and whether it is the "Other" node of that dimension. */
export function dimension(
  a: TreeAdapter,
  caseValue: unknown,
  at: string,
  where: {operation?: number; node?: string; field?: string} = {},
): {key: string; other: boolean; value: string} {
  const details = (rule: TreeRule): JsonObject => ({
    ...(where.operation !== undefined ? {operation: where.operation} : {}),
    ...(where.node !== undefined ? {node: where.node} : {}),
    field: where.field ?? wholeTree,
    rule,
  });
  if (!object(caseValue) || Object.keys(caseValue).length !== 1 || !a.dimensions[Object.keys(caseValue)[0]!])
    invalid(
      a.code,
      at + ' needs caseValue with exactly one retail dimension: ' + Object.keys(a.dimensions).join(', ') + '.',
      {...details('dimension_kind'), allowed: Object.keys(a.dimensions)},
    );
  const d = Object.keys(caseValue)[0]!,
    spec = a.dimensions[d]!,
    o = (caseValue as JsonObject)[d];
  if (!object(o) || Object.keys(o).some(k => k !== spec.value && k !== spec.level))
    invalid(a.code, at + '.' + d + ' accepts only ' + [spec.value, spec.level].filter(Boolean).join(' and ') + '.', {
      ...details('dimension_fields'),
      allowed: [spec.value, spec.level].filter(Boolean),
    });
  if (spec.level && (typeof o[spec.level] !== 'string' || !o[spec.level]))
    invalid(a.code, at + '.' + d + ' needs its ' + spec.level + '.', details('dimension_level'));
  const value = o[spec.value];
  if (value !== undefined && ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim()))
    invalid(
      a.code,
      at + '.' + d + '.' + spec.value + ' must be a nonblank value, or absent for the "Other" node.',
      details('dimension_value'),
    );
  return {
    key: d + (spec.level ? ':' + o[spec.level] : ''),
    other: value === undefined,
    value: value === undefined ? '' : String(value).trim().toLowerCase(),
  };
}

/**
 * Applies the operations in order, as Google does, to the tree there is, refusing parents removed before their children and
 * children created before their parents. `current` is the tree read (none, for a tree a build creates whole).
 */
export function finalTree(a: TreeAdapter, ops: TreeOperation[], current: TreeNode[]): Map<string, TreeNode> {
  const tree = new Map(current.map(n => [n.name, n])),
    children = (name: string) => [...tree.values()].filter(n => n.parent === name);
  for (const op of ops) {
    const here = (rule: TreeRule, extra: JsonObject = {}): JsonObject => ({
      ...(op.op !== undefined ? {operation: op.op} : {}),
      field: op.at ?? wholeTree,
      rule,
      ...extra,
    });
    if (op.remove) {
      if (!tree.has(op.remove)) a.refuse.missing(op.remove, here('node_missing', {node: op.remove}));
      if (children(op.remove).length)
        invalid(
          a.code,
          'Remove the children of ' + op.remove + ' before it: removals go leaves first.',
          here('remove_before_children', {node: op.remove}),
        );
      tree.delete(op.remove);
      continue;
    }
    const n = op.create!;
    if (tree.has(n.name)) invalid(a.code, n.name + ' already exists.', treeDetails('node_exists', n));
    if (n.parent === undefined) {
      if ([...tree.values()].some(x => x.parent === undefined)) a.refuse.existingRoot(treeDetails('existing_root', n));
    } else {
      const parent = tree.get(n.parent);
      if (!parent)
        invalid(
          a.code,
          'The parent ' + n.parent + ' of a new node does not exist yet: create parents before their children.',
          treeDetails('missing_parent', n, '.' + a.fields.parent),
        );
      if (!a.isSubdivision(parent!))
        invalid(
          a.code,
          'The parent ' + n.parent + ' is a unit; only subdivisions have children.',
          treeDetails('parent_is_unit', n, '.' + a.fields.parent),
        );
    }
    tree.set(n.name, n);
  }
  return tree;
}

/** A tree is complete: one root; each subdivision partitioned along one dimension with an "Other" node; units as leaves. */
export function assertTree(a: TreeAdapter, tree: Map<string, TreeNode>): void {
  const nodes = [...tree.values()];
  if (!nodes.length) a.refuse.emptyTree({field: wholeTree, rule: 'empty_tree'});
  if (a.foreign && nodes.some(n => a.foreign!.is(n))) a.foreign.refuse({field: wholeTree, rule: 'foreign_source'});
  const roots = nodes.filter(n => n.parent === undefined);
  if (roots.length !== 1)
    invalid(a.code, 'The tree needs exactly one root.', {field: wholeTree, rule: 'root_count', found: roots.length});
  if (a.isExcluded(roots[0]!))
    invalid(
      a.code,
      'An excluded root would exclude every product; include all products, or subdivide.',
      treeDetails('excluded_root', roots[0]),
    );
  a.tree?.(nodes);
  // The dimension each non-root node splits by, read once, for the rules on a path below.
  const paths = new Map<string, PathDimension>();
  for (const n of nodes) {
    a.node?.(n);
    const kids = nodes.filter(k => k.parent === n.name);
    if (!a.isSubdivision(n)) {
      if (kids.length) invalid(a.code, 'Unit ' + n.name + ' cannot have children.', treeDetails('unit_children', n));
      continue;
    }
    if (kids.length < 2)
      invalid(
        a.code,
        'Subdivision ' + n.name + ' needs at least one product group and an "Other" node.',
        treeDetails('subdivision_children', n, '', {found: kids.length}),
      );
    const dims = kids.map(k =>
      dimension(a, k.caseValue, k.name, {
        ...(k.op !== undefined ? {operation: k.op} : {}),
        node: k.name,
        ...(k.at ? {field: k.at + '.' + a.fields.caseValue} : {}),
      }),
    );
    if (new Set(dims.map(d => d.key)).size !== 1)
      invalid(
        a.code,
        'All children of ' + n.name + ' must use the same dimension (and level or index).',
        treeDetails('mixed_dimensions', n, '', {dimensions: [...new Set(dims.map(d => d.key))]}),
      );
    const others = dims.filter(d => d.other).length;
    if (others !== 1)
      invalid(
        a.code,
        'Subdivision ' + n.name + ' needs exactly one "Other" node, with the dimension and no value.',
        treeDetails(others ? 'other_repeated' : 'other_missing', n, '', {found: others}),
      );
    const values = dims.filter(d => !d.other).map(d => d.value);
    if (new Set(values).size !== values.length)
      invalid(a.code, 'Subdivision ' + n.name + ' repeats a product group value.', treeDetails('repeated_value', n));
    kids.forEach((k, i) => {
      const [name, level] = dims[i]!.key.split(':');
      paths.set(k.name, {key: dims[i]!.key, name: name!, ...(level ? {level} : {}), other: dims[i]!.other});
    });
  }
  assertPaths(a, tree, nodes, paths);
}
/** The dimension a node splits its parent by: its key (dimension, with the level or index), the dimension, the level or index, "Other". */
interface PathDimension {
  key: string;
  name: string;
  level?: string;
  other: boolean;
}
/**
 * What a path from the root may be (R2.5 M3 round 2, S3-1). Google refuses each of these at execute, and the review refuses them at
 * prepare, before a spend confirmation is asked: a dimension (or a level of one) used twice on a path (AssetGroupListingGroupFilterError
 * SAME_DIMENSION_TYPE_BETWEEN_ANCESTORS, CriterionError DUPLICATE_LISTING_DIMENSION_TYPE); a product type or product category level above 1
 * without the level before it on its path, since the levels go in ascending order from level 1 (MUST_REFINE_HIERARCHICAL_PARENT_TYPE,
 * INVALID_LISTING_DIMENSION_TYPE); the "Other" node of a level subdivided by the hierarchy
 * (CANNOT_REFINE_HIERARCHICAL_EVERYTHING_ELSE). A tree has a depth limit too (TREE_TOO_DEEP, LISTING_GROUP_TREE_TOO_DEEP), which is not
 * checked: neither the pinned v25 document nor Google's pages give the number (UNVERIFIED), and it becomes a named constant once a live
 * check does. Every non-root node of a complete tree has a dimension in `paths`: its parent is a subdivision, which was checked above.
 */
function assertPaths(
  a: TreeAdapter,
  tree: Map<string, TreeNode>,
  nodes: TreeNode[],
  paths: Map<string, PathDimension>,
): void {
  const parentOf = (n: TreeNode) => (n.parent === undefined ? undefined : tree.get(n.parent));
  for (const n of nodes) {
    const mine = paths.get(n.name);
    if (!mine) continue;
    // Its ancestors' dimensions, nearest first; the root has none. A tree read from Google has no cycle; the bound is for a corrupt one.
    const above: PathDimension[] = [];
    for (let p = parentOf(n), steps = 0; p && steps <= nodes.length; p = parentOf(p), steps++) {
      const d = paths.get(p.name);
      if (d) above.push(d);
    }
    const here = '.' + a.fields.caseValue;
    if (above.some(d => d.key === mine.key))
      invalid(
        a.code,
        'A node cannot split by a dimension, or a level of it, that one of its ancestors already splits by; each is used once on a path from the root.',
        treeDetails('ancestor_dimension', n, here, {dimension: mine.key}),
      );
    const up = parentOf(n),
      parent = up ? paths.get(up.name) : undefined;
    if (parent && parent.other && parent.name === mine.name && a.dimensions[mine.name]?.hierarchical)
      invalid(
        a.code,
        'The "Other" node of a product type or product category cannot be subdivided by a level of the same hierarchy; subdivide it by another dimension.',
        treeDetails('other_refined', n, here, {parent: n.parent, dimension: mine.name}),
      );
    const level = /^LEVEL([1-9][0-9]*)$/.exec(mine.level ?? '');
    if (level && a.dimensions[mine.name]?.hierarchical && Number(level[1]) > 1) {
      const required = 'LEVEL' + (Number(level[1]) - 1);
      if (!above.some(d => d.name === mine.name && d.level === required))
        invalid(
          a.code,
          'A product type or product category level above LEVEL1 needs the level before it on its path from the root: start at LEVEL1 and go down one level at a time.',
          treeDetails('level_order', n, here, {dimension: mine.name, level: mine.level, required}),
        );
    }
  }
}

/** Every node as its path of dimension values from the root, so trees compare regardless of IDs. */
export function shape(a: TreeAdapter, tree: Map<string, TreeNode>): string[] {
  const path = (n: TreeNode): string =>
    n.parent === undefined
      ? 'root'
      : path(tree.get(n.parent)!) +
        ' > ' +
        (() => {
          const d = dimension(a, n.caseValue, n.name);
          return d.key + '=' + (d.other ? '*' : d.value);
        })();
  return [...tree.values()].map(n => path(n) + ' [' + a.label(n) + ']').sort();
}

/**
 * What an edit of a tree changes, in counts, a sample and a hash (r25-fr-listings): the answer of a review of a tree too long to list. A node
 * is compared by its shape (its path of dimension values and its label), so a node Google gives a new ID is not a change. `added` and `removed`
 * are the first `sample` shapes, in order; the counts are of every one. `tree_sha256` is of the whole final shape, one line each.
 */
export interface TreeChange {
  operations: number;
  create: number;
  remove: number;
  keep: number;
  nodes: {before: number; after: number};
  subdivisions: number;
  included: number;
  excluded: number;
  added: string[];
  removed: string[];
  tree_sha256: string;
  /** The units that are removed and made again at another bid, where the edit does that (a bid is part of what a unit is). */
  bid_changes?: BidChanges;
}
/**
 * How many units change their bid, from which bids to which: the distinct values in ascending order, the first `sample` of each (`more` says
 * that a list was cut, so the sentence that names the bids does not say they are all the bids).
 */
export interface BidChanges {
  units: number;
  from: string[];
  to: string[];
  more?: true;
}
const byValue = (a: string, b: string) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
/**
 * The bid changes of an edit, from the shapes it removes and the shapes it adds (r25-fr-listings, the Opus review S3-2): a unit at a path in
 * both, whose bid is not the same, is a unit whose bid changes (it is removed and made again, as a unit's bid is part of its kind). A unit
 * that goes, or comes, with no unit of its path on the other side is a removal or a creation, not a change of bid.
 */
export function bidChanges(removed: string[], added: string[], sample = 5): BidChanges | undefined {
  const bids = (lines: string[]) =>
    new Map(
      lines.flatMap(line => {
        const m = /^(.*) \[UNIT bid=(\d+)(?: status=\S+)?\]$/.exec(line);
        return m ? [[m[1]!, m[2]!] as [string, string]] : [];
      }),
    );
  const was = bids(removed),
    moved = [...bids(added)].filter(([path, bid]) => was.has(path) && was.get(path) !== bid);
  if (!moved.length) return undefined;
  const from = [...new Set(moved.map(([path]) => was.get(path)!))].sort(byValue),
    to = [...new Set(moved.map(([, bid]) => bid))].sort(byValue);
  return {
    units: moved.length,
    from: from.slice(0, sample),
    to: to.slice(0, sample),
    ...(from.length > sample || to.length > sample ? {more: true as const} : {}),
  };
}
/** The bid changes of several edits together, as the parts of a group make them: the units added up, the distinct bids merged. */
export function mergeBidChanges(parts: BidChanges[], sample = 5): BidChanges | undefined {
  if (!parts.length) return undefined;
  const union = (key: 'from' | 'to') => [...new Set(parts.flatMap(p => p[key]))].sort(byValue),
    from = union('from'),
    to = union('to');
  return {
    units: parts.reduce((total, p) => total + p.units, 0),
    from: from.slice(0, sample),
    to: to.slice(0, sample),
    ...(parts.some(p => p.more) || from.length > sample || to.length > sample ? {more: true as const} : {}),
  };
}
export function treeChange(a: TreeAdapter, current: TreeNode[], ops: TreeOperation[], sample = 5): TreeChange {
  const before = shape(a, new Map(current.map(n => [n.name, n]))),
    final = finalTree(a, ops, current),
    after = shape(a, final),
    had = new Set(before),
    has = new Set(after),
    added = after.filter(s => !had.has(s)),
    removed = before.filter(s => !has.has(s)),
    nodes = [...final.values()],
    bids = bidChanges(removed, added, sample);
  return {
    operations: ops.length,
    create: added.length,
    remove: removed.length,
    keep: before.length - removed.length,
    nodes: {before: before.length, after: after.length},
    subdivisions: nodes.filter(n => a.isSubdivision(n)).length,
    included: nodes.filter(n => a.isUnit(n) && !a.isExcluded(n)).length,
    excluded: nodes.filter(n => a.isExcluded(n)).length,
    added: added.slice(0, sample),
    removed: removed.slice(0, sample),
    tree_sha256: sha256(after.join('\n')),
    ...(bids ? {bid_changes: bids} : {}),
  };
}
