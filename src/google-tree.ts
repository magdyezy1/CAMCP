import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

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
 * Every refusal here carries the details {operation?, node?, field?, rule}, `rule` being one of `treeRules`; the refusals that
 * name what the tree belongs to (the asset group, the ad group) are the adapter's own sentences.
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
  // Rules of one adapter's own nodes (src/google-shopping-tree.ts).
  'bid_on_subdivision',
  'negative_subdivision',
  'no_unit',
] as const);
export type TreeRule = (typeof treeRules)[number];

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
  /** Each dimension of a case value: the field that holds a value (absent for the "Other" node) and the level or index that splits siblings. */
  readonly dimensions: Readonly<Record<string, {value: string; level?: string}>>;
  isSubdivision(node: TreeNode): boolean;
  isUnit(node: TreeNode): boolean;
  /** A unit that removes its products from what serves. */
  isExcluded(node: TreeNode): boolean;
  /** What the shape shows of a node after its path, in brackets. */
  label(node: TreeNode): string;
  /** A node of another kind than this tree edits (a webpage listing group in a retail tree), and the refusal of one. */
  readonly foreign?: {is(node: TreeNode): boolean; refuse(details: JsonObject): never};
  /** This tree's own rules on one node of the final tree (a bid on a subdivision). */
  node?(node: TreeNode): void;
  /** This tree's own rules on the whole final tree, once it is complete (at least one unit). */
  tree?(nodes: TreeNode[]): void;
  /** The refusals that name what the tree belongs to; each is a refusal, never a return. */
  readonly refuse: {
    missing(name: string, details: JsonObject): never;
    existingRoot(details: JsonObject): never;
    emptyTree(details: JsonObject): never;
  };
}
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(code: string, message: string, details: JsonObject): never {
  throw new MirrorError(code, message, details);
}
/** The details of a refusal about `node`: its operation and where it is in the request (when it came from one), its name, the rule. */
export function treeDetails(rule: TreeRule, node?: TreeNode, field = '', extra: JsonObject = {}): JsonObject {
  return {
    ...(node?.op !== undefined ? {operation: node.op} : {}),
    ...(node ? {node: node.name} : {}),
    ...(node?.at ? {field: node.at + field} : {}),
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
    ...(where.field !== undefined ? {field: where.field} : {}),
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
      ...(op.at ? {field: op.at} : {}),
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
          treeDetails('missing_parent', n, '.parent'),
        );
      if (!a.isSubdivision(parent!))
        invalid(
          a.code,
          'The parent ' + n.parent + ' is a unit; only subdivisions have children.',
          treeDetails('parent_is_unit', n, '.parent'),
        );
    }
    tree.set(n.name, n);
  }
  return tree;
}

/** A tree is complete: one root; each subdivision partitioned along one dimension with an "Other" node; units as leaves. */
export function assertTree(a: TreeAdapter, tree: Map<string, TreeNode>): void {
  const nodes = [...tree.values()];
  if (!nodes.length) a.refuse.emptyTree({rule: 'empty_tree'});
  if (a.foreign && nodes.some(n => a.foreign!.is(n))) a.foreign.refuse({rule: 'foreign_source'});
  const roots = nodes.filter(n => n.parent === undefined);
  if (roots.length !== 1)
    invalid(a.code, 'The tree needs exactly one root.', {rule: 'root_count', found: roots.length});
  if (a.isExcluded(roots[0]!))
    invalid(
      a.code,
      'An excluded root would exclude every product; include all products, or subdivide.',
      treeDetails('excluded_root', roots[0]),
    );
  a.tree?.(nodes);
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
        ...(k.at ? {field: k.at + '.caseValue'} : {}),
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
