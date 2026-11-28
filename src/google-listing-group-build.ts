import {MirrorError} from './errors.js';
import {sha256, stable} from './security.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {BuiltGroup} from './write-groups.js';
import type {BuildHooks} from './provider-adapter.js';
import {googleAdsCustomers} from './google-version.js';
import {chainLimits} from './google-temp-names.js';
import {
  dimension,
  mergeBidChanges,
  type BidChanges,
  type TreeAdapter,
  type TreeChange,
  type TreeNode,
} from './google-tree.js';
import {
  googleListingGroupChange,
  googleListingGroupTreeNodes,
  googleListingGroupTreeRead,
  pmaxTree,
} from './google-listing-groups.js';
import {
  googleShoppingTreeChange,
  googleShoppingTreeNodes,
  googleShoppingTreeRead,
  shoppingTree,
} from './google-shopping-tree.js';
import {copyListingGroups, listingGroupBuildGateway, listingGroupBuildNames} from './google-listing-group-routes.js';

/**
 * Product trees built from a source (r25-fr-listings, the owner's friction report A2, 2026-11-27: "No copy, file upload or match this list.
 * Every entry must be typed into the call, and Shopping takes one ad group per review. The first script copied 3,047 entries").
 *
 * `AMCP_COPY_LISTING_GROUPS` makes the trees of its targets the tree of its source; `AMCP_MATCH_LISTING_GROUPS` makes each include exactly the
 * item ids of a list and exclude every other product. Both read the trees they start from, work out for each target the operations that take its
 * tree to the wanted one (nodes are compared by their path of dimension values and their kind, never by ID, so a node that is already right is
 * left alone and a repeat finds nothing to do), and hand the service one ordinary tree review for each target that has something to change.
 *
 * What this module does not change is what a tree is. A tree is one mutate and is never cut (Google wants the whole tree in one request); every
 * review the service prepares from what this builds is the family's own review of a tree (src/google-listing-groups.ts, src/google-shopping-tree.ts):
 * the same checks, the same spend confirmation, activation and deletion rules, the same read-back. What goes in parts is the set of trees: a write
 * group with one part for each target (src/write-groups.ts). A built part may pass the 500 operations of a hand-sent review, up to 10,000, with the
 * mark the service puts on it (Q28, owner 2026-11-27: "Yes, 10,000 for built trees"; src/google-tree.ts `treeLimit`).
 *
 * The list is given in the call: `item_ids`, or `csv` text (one id a line, or a column named item_id, id, offer_id or sku), at most 4,998 ids.
 * Release 2 takes a file already uploaded (a `source_id` of MediaSources), which keeps the ids from passing through the model; it is not built.
 */
export const maxTargets = 40;
/** A tree of at most 5,000 nodes (`maxNodes` of both tree modules) holds its root, its "Other" node and the units. */
export const maxItemIds = 4998;
const maxListRows = 20000,
  maxIdLength = 100,
  maxCsvBytes = 196608,
  sampleSize = 5,
  digits = /^[1-9][0-9]{0,18}$/,
  idColumns = ['item_id', 'item id', 'itemid', 'id', 'offer_id', 'offer id', 'offerid', 'sku'],
  acceptedHeaders = 'item_id, id, offer_id or sku';
export type GroupKind = 'ad_group' | 'asset_group';
export interface Target {
  kind: GroupKind;
  id: string;
}
/** The list of a match: its ids in the order given (first spelling of each), and what shows it. */
export interface ParsedList {
  ids: string[];
  rows: number;
  unique: number;
  duplicates: number;
  /** The SHA-256 of the text as received (csv), or of the ids as received (item_ids). */
  sha256: string;
  /** The SHA-256 of the sorted, lower-case, unique ids joined by a line each: the set, whatever form it was sent in. */
  ids_sha256: string;
  /** For a CSV: the header of the column the ids were read from (null when the file has none), and that column's place, 1 for the first. */
  header?: string | null;
  column?: number;
}
export interface BuildCall {
  action: string;
  kind: GroupKind;
  account: string;
  source?: Target;
  targets: Target[];
  list?: ParsedList;
  bid?: string;
  connectionId?: string;
  supersedes?: string;
  /** What `prepare` is called with, which a part's "prepare again" repeats. */
  prepareInput: JsonObject;
}
type Reader = (request: CompiledRequest) => Promise<TransportResult>;
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function bad(message: string, field: string, extra: JsonObject = {}): never {
  throw new MirrorError('INVALID_ARGUMENT', message, {field, ...extra});
}
const upper = (v: unknown) => (typeof v === 'string' ? v.toUpperCase() : '');
/** Whether this call prepares or inspects one of the two build actions. */
export function isListingGroupBuild(input: JsonObject): boolean {
  return (
    input.gateway === listingGroupBuildGateway &&
    obj(input.arguments) &&
    listingGroupBuildNames.includes(upper(input.arguments.action))
  );
}

/** Rows of cells of CSV text: quotes, doubled quotes and a line break inside quotes, as the catalog CSV source reads them; blank rows are left out. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false;
  const end = () => {
    row.push(field);
    if (row.some(v => v.trim() !== '')) rows.push(row);
    row = [];
    field = '';
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      end();
    } else field += c;
  }
  if (quoted) bad('A quoted CSV value is not closed.', 'payload.list.csv');
  end();
  return rows;
}
/** The list of a match, checked: 1 to 4,998 distinct ids (without regard to case) of 1 to 100 printable characters, from `item_ids` or `csv`. */
export function parseList(value: unknown): ParsedList {
  const field = 'payload.list';
  if (!obj(value)) bad('payload.list is {item_ids: [...]} or {csv: "..."}.', field);
  const keys = Object.keys(value);
  if (keys.length !== 1 || !['item_ids', 'csv'].includes(keys[0]!))
    bad(
      'payload.list takes exactly one of item_ids (a list of ids) and csv (text with one id a line, or a column named item_id, id, offer_id or sku).',
      field,
      {allowed: ['item_ids', 'csv']},
    );
  let given: unknown[],
    received: string,
    read: Pick<ParsedList, 'header' | 'column'> = {};
  if (keys[0] === 'item_ids') {
    if (!Array.isArray(value.item_ids) || value.item_ids.length > maxListRows)
      bad('payload.list.item_ids is a list of item ids, at most ' + maxListRows + ' lines.', field + '.item_ids', {
        limit: maxListRows,
      });
    given = value.item_ids;
    received = stable(value.item_ids);
  } else {
    const text = value.csv;
    if (typeof text !== 'string' || Buffer.byteLength(text) > maxCsvBytes)
      bad('payload.list.csv is text of at most 192 KiB.', field + '.csv', {limit_bytes: maxCsvBytes});
    const rows = csvRows(text.replace(/^﻿/, '')),
      names = (rows[0] ?? []).map(c => c.trim().toLowerCase()),
      at = names.findIndex(c => idColumns.includes(c)),
      body = at >= 0 ? rows.slice(1) : rows;
    if (at < 0) {
      // No header the list knows: the file is one id a line and nothing else, or it is refused. A Shopify export (`Handle,Variant SKU`), a
      // file with ";" (`item_id;title`) and a title line (`Product ID`) were read as ids, and a tree was built from them (the Opus review, S2-1).
      const wide = rows.findIndex(r => r.length > 1),
        semicolon = rows.findIndex(r => r.some(c => c.includes(';'))),
        title = rows.length && rows[0]!.length === 1 && /\s/.test(rows[0]![0]!.trim()) ? 0 : -1,
        row = [wide, semicolon, title].find(i => i >= 0);
      if (row !== undefined)
        bad(
          'payload.list.csv has ' +
            (wide >= 0
              ? 'more than one column'
              : semicolon >= 0
                ? 'a ";"'
                : 'a first line that is a title, not an item id') +
            ' (line ' +
            (row + 1) +
            ') and no first line that names the item id column: make that line ' +
            acceptedHeaders +
            ', or send one item id a line and nothing else.',
          field + '.csv',
          {row: row + 1, accepted: ['item_id', 'id', 'offer_id', 'sku']},
        );
    }
    if (body.length > maxListRows)
      bad('payload.list.csv holds at most ' + maxListRows + ' lines.', field + '.csv', {limit: maxListRows});
    given = body.map((r, i) => {
      const cell = (r[Math.max(at, 0)] ?? '').trim();
      if (!cell) bad('A row of payload.list.csv has no item id.', field + '.csv', {row: i + 1});
      return cell;
    });
    received = text;
    read = {header: at >= 0 ? rows[0]![at]!.trim() : null, column: Math.max(at, 0) + 1};
  }
  const seen = new Map<string, string>();
  for (const [i, raw] of given.entries()) {
    const id = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : raw;
    if (typeof id !== 'string' || !id.trim() || id.trim().length > maxIdLength || /[\x00-\x1f\x7f]/.test(id))
      bad(
        'Each item id is text of 1 to ' + maxIdLength + ' printable characters; the one at index ' + i + ' is not.',
        field,
        {index: i, limit: maxIdLength},
      );
    const trimmed = id.trim(),
      key = trimmed.toLowerCase();
    // "*" names the excluded "Other" node of a tree (a unit of that name would collide with it): it is no product (the Opus review, S4).
    if (trimmed === '*')
      bad(
        'An item id of "' +
          trimmed +
          '" (index ' +
          i +
          ') is the name of the excluded "Other" node, not a product: leave it out.',
        field,
        {index: i},
      );
    if (!seen.has(key)) seen.set(key, trimmed);
  }
  if (!seen.size) bad('payload.list holds no item id.', field);
  if (seen.size > maxItemIds)
    bad(
      'A tree holds at most 5,000 nodes: payload.list has ' +
        seen.size +
        ' distinct item ids and may have ' +
        maxItemIds +
        '.',
      field,
      {limit: maxItemIds, unique: seen.size},
    );
  return {
    ids: [...seen.values()],
    rows: given.length,
    unique: seen.size,
    duplicates: given.length - seen.size,
    sha256: sha256(received),
    ids_sha256: sha256([...seen.keys()].sort().join('\n')),
    ...read,
  };
}

const accountOf = (value: unknown): string => {
  const id = typeof value === 'string' ? value.replaceAll('-', '') : typeof value === 'number' ? String(value) : '';
  if (!/^\d+$/.test(id)) bad('Name one Google Ads customer with account_id.', 'arguments.account_id');
  return id;
};
const idOf = (value: unknown, field: string): string => {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof id !== 'string' || !digits.test(id) || BigInt(id) > 9223372036854775807n)
    bad('Name each ad group or asset group by its numeric ID.', field);
  return id as string;
};
/** One ad group or asset group of a call, as `{ad_group_id}` or `{asset_group_id}`. */
function targetOf(value: unknown, field: string): Target {
  const keys = obj(value) ? Object.keys(value) : [];
  if (!obj(value) || keys.length !== 1 || !['ad_group_id', 'asset_group_id'].includes(keys[0]!))
    bad(
      field +
        ' is {ad_group_id} for a Standard Shopping ad group or {asset_group_id} for a Performance Max asset group.',
      field,
    );
  const kind: GroupKind = keys[0] === 'ad_group_id' ? 'ad_group' : 'asset_group';
  return {kind, id: idOf((value as JsonObject)[keys[0]!], field)};
}
const label = (t: Target): JsonObject => ({[t.kind + '_id']: t.id});

/** The call of a build, checked before anything is read: its arguments, the targets, the source or the list. */
export function parseListingGroupBuild(input: JsonObject): BuildCall {
  const args = input.arguments as JsonObject,
    action = upper(args.action);
  for (const key of Object.keys(input))
    if (
      ![
        'action',
        'gateway',
        'arguments',
        'connection_id',
        'provider_check',
        'supersedes_review_id',
        'evidence',
      ].includes(key)
    )
      bad(action + ' takes action, gateway, arguments, connection_id, provider_check and supersedes_review_id.', key);
  for (const key of Object.keys(args))
    if (!['action', 'account_id', 'customer_id', 'connection_id', 'payload'].includes(key))
      bad(action + ' takes action, account_id, connection_id and payload in arguments.', 'arguments.' + key);
  if (
    args.account_id !== undefined &&
    args.customer_id !== undefined &&
    String(args.account_id) !== String(args.customer_id)
  )
    bad('account_id and customer_id name different customers.', 'arguments.account_id');
  const account = accountOf(args.account_id ?? args.customer_id),
    payload = args.payload,
    copying = action === copyListingGroups;
  if (!obj(payload)) bad(action + ' takes a payload.', 'arguments.payload');
  const allowed = copying ? ['source', 'targets'] : ['targets', 'list', 'cpc_bid_micros'];
  for (const key of Object.keys(payload))
    if (!allowed.includes(key)) bad('payload.' + key + ' is not accepted.', 'payload.' + key, {allowed});
  const list = payload.targets;
  if (!Array.isArray(list) || !list.length)
    bad('payload.targets lists the ad groups or asset groups to change.', 'payload.targets', {limit: maxTargets});
  if (list.length > maxTargets)
    bad(
      'One review takes at most ' +
        maxTargets +
        ' targets, a part of the group for each; this has ' +
        list.length +
        '.',
      'payload.targets',
      {
        limit: maxTargets,
      },
    );
  const targets = list.map(t => targetOf(t, 'payload.targets'));
  const kind = targets[0]!.kind;
  if (targets.some(t => t.kind !== kind))
    bad('The targets are all ad groups or all asset groups, never both.', 'payload.targets');
  if (new Set(targets.map(t => t.id)).size !== targets.length) bad('A target is named twice.', 'payload.targets');
  const connectionId = input.connection_id ?? args.connection_id;
  if (
    input.connection_id !== undefined &&
    args.connection_id !== undefined &&
    input.connection_id !== args.connection_id
  )
    bad('Connection IDs must agree.', 'connection_id');
  if (connectionId !== undefined && typeof connectionId !== 'string') bad('connection_id is text.', 'connection_id');
  if (input.provider_check !== undefined && typeof input.provider_check !== 'boolean')
    bad('provider_check is a boolean that prepare takes.', 'provider_check');
  if (input.supersedes_review_id !== undefined && typeof input.supersedes_review_id !== 'string')
    bad('supersedes_review_id is the ID of a review.', 'supersedes_review_id');
  const call: BuildCall = {
    action,
    kind,
    account,
    targets,
    ...(connectionId !== undefined ? {connectionId} : {}),
    ...(input.supersedes_review_id !== undefined ? {supersedes: input.supersedes_review_id as string} : {}),
    // The input a part's "prepare again" repeats: this call without a supersedes (the one review it replaced is spent).
    prepareInput: {
      gateway: input.gateway,
      arguments: structuredClone(args),
      ...(input.connection_id !== undefined ? {connection_id: input.connection_id} : {}),
      ...(typeof input.provider_check === 'boolean' ? {provider_check: input.provider_check} : {}),
    },
  };
  if (copying) {
    if (payload.source === undefined)
      bad('payload.source names the ad group or asset group to copy.', 'payload.source');
    const source = targetOf(payload.source, 'payload.source');
    if (source.kind !== kind) bad('The source and the targets are of one kind.', 'payload.targets');
    if (targets.some(t => t.id === source.id)) bad('The source cannot be one of its own targets.', 'payload.targets');
    call.source = source;
    return call;
  }
  if (payload.list === undefined) bad('payload.list gives the item ids to include.', 'payload.list');
  call.list = parseList(payload.list);
  if (payload.cpc_bid_micros !== undefined) {
    const bid = typeof payload.cpc_bid_micros === 'number' ? String(payload.cpc_bid_micros) : payload.cpc_bid_micros;
    if (typeof bid !== 'string' || !/^\d{1,19}$/.test(bid))
      bad('payload.cpc_bid_micros is a whole number of micros, as a decimal string.', 'payload.cpc_bid_micros');
    if (kind === 'asset_group')
      bad('A Performance Max filter takes no bid: leave cpc_bid_micros out.', 'payload.cpc_bid_micros');
    call.bid = bid;
  }
  return call;
}

/** What differs between the two trees: how a node is written, read and shown. */
interface Flavor {
  adapter: TreeAdapter;
  /** The one-service action of the review a part is: the family's own. */
  route: string;
  path: string;
  collection: string;
  /** The temporary name of a subdivision created in a group. */
  temporary(account: string, group: string, n: number): string;
  read(shell: CompiledRequest, group: string): CompiledRequest;
  nodes(read: CompiledRequest, result: TransportResult): TreeNode[];
  change(plan: CompiledRequest, state: unknown[]): TreeChange | undefined;
  /** The nodes of a list: the root, a unit for each id, and the "Other" node, as the family wants them. */
  root(): TreeNode;
  unit(id: string, bid?: string): TreeNode;
  other(): TreeNode;
  create(
    account: string,
    group: string,
    node: TreeNode,
    name: string | undefined,
    parent: string | undefined,
  ): JsonObject;
  /** What a node of the source is as a node of the copy: what carries over, without what Google lists and does not keep. */
  copyOf(node: TreeNode): TreeNode;
}
const itemId = (value?: string) => ({productItemId: value === undefined ? {} : {value}});
const flavors: Record<GroupKind, Flavor> = {
  ad_group: {
    adapter: shoppingTree,
    route: 'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria',
    path: '/adGroupCriteria:mutate',
    collection: 'adGroups',
    temporary: (c, g, n) => 'customers/' + c + '/adGroupCriteria/' + g + '~-' + n,
    read: (shell, g) => googleShoppingTreeRead(shell, g),
    nodes: googleShoppingTreeNodes,
    change: googleShoppingTreeChange,
    root: () => ({name: 'root', type: 'SUBDIVISION'}),
    unit: (id, bid) => ({name: id, type: 'UNIT', caseValue: itemId(id), negative: false, ...(bid ? {bid} : {})}),
    other: () => ({name: '*', type: 'UNIT', caseValue: itemId(), negative: true}),
    create: (c, g, n, name, parent) => ({
      create: {
        ...(name ? {resourceName: name} : {}),
        adGroup: 'customers/' + c + '/adGroups/' + g,
        listingGroup: {type: n.type, ...(parent ? {parentAdGroupCriterion: parent, caseValue: n.caseValue} : {})},
        ...(n.negative ? {negative: true} : {}),
        ...(n.type === 'UNIT' && !n.negative && n.bid !== undefined ? {cpcBidMicros: n.bid} : {}),
      },
    }),
    // A unit keeps its bid and its exclusion; a subdivision keeps neither (Google lists the bid it inherited), and no node keeps a status.
    copyOf: n => ({
      name: n.name,
      type: n.type,
      ...(n.parent !== undefined ? {parent: n.parent, caseValue: n.caseValue} : {}),
      negative: n.negative === true,
      ...(n.type === 'UNIT' && n.negative !== true && n.bid !== undefined ? {bid: n.bid} : {}),
    }),
  },
  asset_group: {
    adapter: pmaxTree,
    route: 'google_ads_v23_asset_group_listing_group_filter_mutate_asset_group_listing_group_filters',
    path: '/assetGroupListingGroupFilters:mutate',
    collection: 'assetGroups',
    temporary: (c, g, n) => 'customers/' + c + '/assetGroupListingGroupFilters/' + g + '~-' + n,
    read: (shell, g) => googleListingGroupTreeRead(shell, g),
    nodes: googleListingGroupTreeNodes,
    change: googleListingGroupChange,
    root: () => ({name: 'root', type: 'SUBDIVISION', source: 'SHOPPING'}),
    unit: id => ({name: id, type: 'UNIT_INCLUDED', source: 'SHOPPING', caseValue: itemId(id)}),
    other: () => ({name: '*', type: 'UNIT_EXCLUDED', source: 'SHOPPING', caseValue: itemId()}),
    create: (c, g, n, name, parent) => ({
      create: {
        ...(name ? {resourceName: name} : {}),
        assetGroup: 'customers/' + c + '/assetGroups/' + g,
        type: n.type,
        listingSource: 'SHOPPING',
        ...(parent ? {parentListingGroupFilter: parent, caseValue: n.caseValue} : {}),
      },
    }),
    copyOf: n => ({
      name: n.name,
      type: n.type,
      source: 'SHOPPING',
      ...(n.parent !== undefined ? {parent: n.parent, caseValue: n.caseValue} : {}),
    }),
  },
};

/** Each node's path of dimension values from the root: what two trees are compared by, whatever IDs Google gave. */
function pathsOf(a: TreeAdapter, nodes: TreeNode[]): Map<string, string> {
  const byName = new Map(nodes.map(n => [n.name, n])),
    out = new Map<string, string>();
  const of = (n: TreeNode): string => {
    let path = out.get(n.name);
    if (path === undefined) {
      const d = n.parent === undefined ? undefined : dimension(a, n.caseValue, n.name),
        parent = n.parent === undefined ? undefined : byName.get(n.parent);
      path = d && parent ? of(parent) + ' > ' + d.key + '=' + (d.other ? '*' : d.value) : 'root';
      out.set(n.name, path);
    }
    return path;
  };
  for (const n of nodes) of(n);
  return out;
}
/** How many nodes lie above a node: a tree's removals go deepest first. */
function depths(nodes: TreeNode[]): Map<string, number> {
  const byName = new Map(nodes.map(n => [n.name, n])),
    out = new Map<string, number>();
  const of = (n: TreeNode): number => {
    let d = out.get(n.name);
    if (d === undefined) {
      const parent = n.parent === undefined ? undefined : byName.get(n.parent);
      d = parent ? of(parent) + 1 : 0;
      out.set(n.name, d);
    }
    return d;
  };
  for (const n of nodes) of(n);
  return out;
}
/** A node is as wanted when it is of the same kind: its type, its exclusion and, for a unit, its bid. */
const alike = (a: TreeAdapter, x: TreeNode, y: TreeNode) =>
  x.type === y.type &&
  (x.negative === true) === (y.negative === true) &&
  (!a.isUnit(x) || (x.bid ?? '') === (y.bid ?? ''));

interface Wanted {
  path: string;
  parentPath?: string;
  node: TreeNode;
}
/** The nodes a tree is to have, parents first, from nodes whose names are theirs alone. */
function wantedOf(a: TreeAdapter, nodes: TreeNode[]): Wanted[] {
  const paths = pathsOf(a, nodes),
    depth = depths(nodes),
    byName = new Map(nodes.map(n => [n.name, n]));
  return [...nodes]
    .sort((x, y) => depth.get(x.name)! - depth.get(y.name)!)
    .map(node => ({
      path: paths.get(node.name)!,
      ...(node.parent !== undefined ? {parentPath: paths.get(byName.get(node.parent)!.name)!} : {}),
      node,
    }));
}
/** The tree of a list: the root, a unit for each id and the "Other" node, which the list does not include. */
function wantedList(f: Flavor, list: ParsedList, bid?: string): Wanted[] {
  const root = f.root(),
    child = (n: TreeNode): TreeNode => ({...n, name: 'want:' + n.name, parent: root.name});
  return wantedOf(f.adapter, [root, ...list.ids.map(id => child(f.unit(id, bid))), child(f.other())]);
}
/** The tree of a source: what carries over from each of its nodes. */
function wantedCopy(f: Flavor, source: TreeNode[]): Wanted[] {
  return wantedOf(f.adapter, source.map(f.copyOf));
}

interface Plan {
  operations: JsonObject[];
  created: number;
  removed: number;
  kept: number;
}
/**
 * The operations that take `current` to the wanted tree, or none when it already is: a wanted node is kept when the node at its path is of its
 * kind and its parent is kept; every other node of the tree now is removed, deepest first; every other wanted node is created, parents first, a
 * subdivision under a temporary name its children name. Applied in order (src/google-tree.ts `finalTree`) they leave exactly the wanted tree, which
 * the family's review checks again, as a hand-sent review is checked.
 */
function planTree(f: Flavor, account: string, group: string, current: TreeNode[], wanted: Wanted[]): Plan {
  const a = f.adapter,
    paths = pathsOf(a, current),
    byPath = new Map(current.map(n => [paths.get(n.name)!, n])),
    kept = new Set<string>();
  for (const w of wanted) {
    const there = byPath.get(w.path);
    if (there && alike(a, there, w.node) && (w.parentPath === undefined || kept.has(w.parentPath))) kept.add(w.path);
  }
  const depth = depths(current),
    removes = current
      .filter(n => !kept.has(paths.get(n.name)!))
      .sort((x, y) => depth.get(y.name)! - depth.get(x.name)!),
    names = new Map<string, string>();
  for (const path of kept) names.set(path, byPath.get(path)!.name);
  const creates: JsonObject[] = [];
  let temporary = 0;
  for (const w of wanted) {
    if (kept.has(w.path)) continue;
    const name = a.isSubdivision(w.node) ? f.temporary(account, group, ++temporary) : undefined;
    creates.push(
      f.create(account, group, w.node, name, w.parentPath === undefined ? undefined : names.get(w.parentPath)),
    );
    if (name) names.set(w.path, name);
  }
  return {
    operations: [...removes.map(n => ({remove: n.name})), ...creates],
    created: creates.length,
    removed: removes.length,
    kept: kept.size,
  };
}

const num = (n: number) => n.toLocaleString('en-US');
/** A part's spend policy for the answer: the rows that exceed a cap are counted and the first few shown, never the three thousand. */
export function boundedSpend(policy: unknown): unknown {
  if (!obj(policy) || !Array.isArray(policy.exceeded) || policy.exceeded.length <= sampleSize) return policy;
  const {exceeded, exceeded_summary: _summary, ...rest} = policy;
  void _summary;
  return {...rest, exceeded: exceeded.slice(0, sampleSize), exceeded_count: exceeded.length};
}

/**
 * The shell of a request of the family a build prepares, for the account it writes: what a review's access checks read. The family finds its
 * Standard Shopping requests by a create that names a listing group (`googleShoppingTreeKind`), so the shell holds one: its scope check, like a
 * review's, then runs before the first read (a login without the adwords scope is refused with nothing read).
 */
export function buildShell(call: BuildCall): CompiledRequest {
  const f = flavors[call.kind];
  return {
    gateway: listingGroupBuildGateway,
    action: f.route,
    method: 'POST',
    path: googleAdsCustomers + call.account + f.path,
    query: {},
    headers: {},
    body: {operations: call.kind === 'ad_group' ? [{create: {listingGroup: {}}}] : []},
    readOnly: false,
    destructive: false,
    requiresConfirmation: true,
    accountId: call.account,
    evidence: '',
    warnings: [],
  };
}

/**
 * The group a tree request edits, as `ad_group:55` or `asset_group:9`, from its first operation: which target a review that a call
 * supersedes was a part for. Undefined for a request that names none.
 */
export function treeTargetOf(plan: CompiledRequest): string | undefined {
  const first = obj(plan.body) && Array.isArray(plan.body.operations) ? plan.body.operations[0] : undefined,
    name = obj(first)
      ? (first.remove ?? (obj(first.create) ? (first.create.adGroup ?? first.create.assetGroup) : undefined))
      : undefined,
    m =
      typeof name === 'string'
        ? /\/(adGroups|assetGroups|adGroupCriteria|assetGroupListingGroupFilters)\/(\d+)/.exec(name)
        : null;
  return m ? (m[1]!.startsWith('ad') ? 'ad_group:' : 'asset_group:') + m[2] : undefined;
}

/** What a CSV list was read from, for the answer: the header of its column and the column's place (1 is the first); nothing for a list of ids. */
const listRead = (list: ParsedList): JsonObject =>
  list.column === undefined ? {} : {header: list.header ?? null, column: list.column};
/** The names of values in a sentence: "300000", "300000 and 900000", "1, 2 and 3". */
const said = (values: string[]) =>
  values.length < 2 ? values.join('') : values.slice(0, -1).join(', ') + ' and ' + values.at(-1);
/** The targets of a group in a sentence: the first few by ID, and how many more. */
const named = (ids: string[], shown = 5) =>
  ids.slice(0, shown).join(', ') + (ids.length > shown ? ' and ' + (ids.length - shown) + ' more' : '');
/** The sentence of the bid changes of a build: "2 units' bids change from 300000 and 900000 to 600000". */
const bidSentence = (b: BidChanges) =>
  b.units +
  (b.units === 1 ? " unit's bid changes" : " units' bids change") +
  ' from ' +
  said(b.from) +
  ' to ' +
  said(b.to) +
  (b.more ? ' (not every bid is named)' : '');

/** What `inspect` says of a build: what prepare reads, and what it hands back. Nothing is sent. */
export function inspectListingGroupBuild(call: BuildCall): JsonObject {
  return {
    executed: false,
    network_requests: 0,
    review_contract_supported: true,
    build: {
      action: call.action,
      kind: call.kind,
      targets: call.targets.length,
      ...(call.source ? {source: label(call.source)} : {}),
      ...(call.list
        ? {
            list: {
              rows: call.list.rows,
              unique: call.list.unique,
              duplicates: call.list.duplicates,
              ...listRead(call.list),
            },
          }
        : {}),
    },
    live_permissions_verified: false,
    next_step:
      'Use prepare: it reads the source and each target’s tree, builds one tree review for each target that has something to change, and returns them as one write group of digests (counts, a sample and hashes), never the nodes. One approval executes every part.',
  };
}

/**
 * Reads the trees a build starts from and builds the parts: one for each target that has something to change, in the order the call named them.
 * The trees are read once each, through `read` (the review's own authority). Returns the group the service prepares, and the targets that already
 * have the tree, which are left out; a build with no part is one that changes nothing.
 */
export async function expandListingGroupBuild(
  call: BuildCall,
  read: Reader,
  superseded?: {review: string; target: string},
): Promise<{built: BuiltGroup | undefined; skipped: JsonObject[]; digest: JsonObject}> {
  const f = flavors[call.kind],
    shell = buildShell(call),
    treeOf = async (id: string) => {
      const request = f.read(shell, id);
      return f.nodes(request, await read(request));
    };
  let wanted: Wanted[], origin: JsonObject;
  if (call.source) {
    const nodes = await treeOf(call.source.id);
    if (!nodes.length)
      throw new MirrorError(
        'STATE_NOT_FOUND',
        'The ' +
          call.kind.replace('_', ' ') +
          ' ' +
          call.source.id +
          ' has no listing group tree, so there is nothing to copy.',
        {field: 'payload.source'},
      );
    wanted = wantedCopy(f, nodes);
    origin = {source: {...label(call.source), nodes: nodes.length}};
  } else {
    wanted = wantedList(f, call.list!, call.bid);
    origin = {
      list: {
        rows: call.list!.rows,
        unique: call.list!.unique,
        duplicates: call.list!.duplicates,
        sha256: call.list!.sha256,
        ids_sha256: call.list!.ids_sha256,
        ...listRead(call.list!),
      },
      ...(call.bid !== undefined ? {cpc_bid_micros: call.bid} : {}),
    };
  }
  const parts: BuiltGroup['parts'] = [],
    skipped: JsonObject[] = [];
  for (const target of call.targets) {
    const plan = planTree(f, call.account, target.id, await treeOf(target.id), wanted);
    if (!plan.operations.length) {
      skipped.push({target: label(target), reason: 'already has this tree'});
      continue;
    }
    if (plan.operations.length > chainLimits.treeBuild)
      throw new MirrorError(
        'INVALID_ARGUMENT',
        'The tree of ' +
          call.kind.replace('_', ' ') +
          ' ' +
          target.id +
          ' needs ' +
          num(plan.operations.length) +
          ' operations in one request, and a built tree takes at most ' +
          num(chainLimits.treeBuild) +
          '.',
        {field: 'payload.targets', limit: chainLimits.treeBuild, operations: plan.operations.length},
      );
    parts.push({
      arguments: {
        action: f.route,
        account_id: call.account,
        ...(call.connectionId !== undefined ? {connection_id: call.connectionId} : {}),
        payload: {operations: plan.operations},
      },
      target: label(target),
      records: plan.operations.length,
      mark: {by: call.action, prepareInput: call.prepareInput},
      ...(superseded && superseded.target === target.kind + ':' + target.id ? {supersedes: superseded.review} : {}),
    });
  }
  // The ids of a list are the person's: nothing reads them against the account's Merchant Center products (the Opus review, S3-1).
  const digest: JsonObject = {
    action: call.action,
    kind: call.kind,
    entity: 'listing groups',
    targets: call.targets.length,
    ...origin,
    ...(call.list ? {merchant_center_checked: false} : {}),
  };
  return {
    skipped,
    digest,
    built: parts.length
      ? {
          parts,
          prepareInput: call.prepareInput,
          view: (answer, review, index) => {
            const change = f.change(review.plan as CompiledRequest, review.state as unknown[]);
            return {
              part: index + 1,
              review_id: answer.review_id,
              records: parts[index]!.records,
              target: parts[index]!.target,
              tree_change: {...change, operations_sha256: review.plan?.treeBuild?.operations_sha256},
              state_hash: answer.state_hash,
              spend_policy: boundedSpend(answer.spend_policy),
              ...(answer.provider_check
                ? {
                    provider_check: {
                      status: answer.provider_check.status,
                      default: answer.provider_check.default === true,
                    },
                  }
                : {}),
              ...(answer.duplicate_warning ? {duplicate_warning: answer.duplicate_warning} : {}),
            };
          },
          digest: views => {
            const sum = (key: 'create' | 'remove' | 'keep' | 'operations') =>
              views.reduce((total, v) => total + Number(v.tree_change?.[key] ?? 0), 0);
            const created = sum('create'),
              removed = sum('remove'),
              kept = sum('keep'),
              // The ad groups or asset groups that change, by ID, for the person who approves (at most 40).
              targetIds = views.map(v => String(Object.values(v.target as JsonObject)[0])),
              moved = mergeBidChanges(
                views.flatMap(v => (v.tree_change?.bid_changes ? [v.tree_change.bid_changes] : [])),
              );
            return {
              ...digest,
              operations: sum('operations'),
              created,
              removed,
              kept,
              target_ids: targetIds,
              ...(moved ? {bid_changes: moved} : {}),
              ...(skipped.length ? {skipped} : {}),
              summary:
                (call.source
                  ? 'Copy the tree of ' + call.kind.replace('_', ' ') + ' ' + call.source.id
                  : 'Match ' + num(call.list!.unique) + ' item ids') +
                ' on ' +
                num(parts.length) +
                ' ' +
                call.kind.replace('_', ' ') +
                (parts.length === 1 ? '' : 's') +
                ' (' +
                named(targetIds) +
                '): creates ' +
                num(created) +
                ' and removes ' +
                num(removed) +
                ' listing groups, in ' +
                num(parts.length) +
                ' mutate request' +
                (parts.length === 1 ? '' : 's') +
                (moved ? '; ' + bidSentence(moved) : '') +
                (call.list ? '; list SHA-256 ' + call.list.sha256.slice(0, 12) + '…' : '') +
                '.' +
                (call.list
                  ? ' The item ids are not checked against Merchant Center: an id the feed lacks makes a unit that matches no product.'
                  : ''),
            };
          },
        }
      : undefined,
  };
}

/**
 * What the service asks of Google Ads where a prepare or an inspect names one of the two build actions (the provider's `writes.build`,
 * src/provider-adapter.ts): the service imports no Google module, and this is how it finds the build, reads the trees through the review's own
 * authority and prepares the group.
 */
const hooks: BuildHooks = {
  claims: isListingGroupBuild,
  inspect: input => inspectListingGroupBuild(parseListingGroupBuild(input)),
  shell: input => buildShell(parseListingGroupBuild(input)),
  connection: input => parseListingGroupBuild(input).connectionId,
  async expand(input, read, replaces) {
    const call = parseListingGroupBuild(input);
    let superseded: {review: string; target: string} | undefined;
    if (call.supersedes) {
      // supersedes_review_id replaces the uncertain tree review that was the part for one of the targets (the duplicate guard's one exception).
      const target = replaces?.plan.treeBuild ? treeTargetOf(replaces.plan) : undefined;
      if (
        !replaces ||
        replaces.id !== call.supersedes ||
        !target ||
        !call.targets.some(t => t.kind + ':' + t.id === target)
      )
        throw new MirrorError(
          'INVALID_ARGUMENT',
          'supersedes_review_id names a review that was no part of a build for one of these targets.',
          {field: 'supersedes_review_id'},
        );
      superseded = {review: replaces.id, target};
    }
    const {built, skipped, digest} = await expandListingGroupBuild(call, read, superseded);
    return {group: built, skipped, digest};
  },
};
export const listingGroupBuildHooks = Object.freeze(hooks);
