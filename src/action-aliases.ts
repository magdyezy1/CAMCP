import type {Action, JsonObject} from './types.js';

/**
 * Near-miss action names (T7, Round 2.5 M0; L2-04, L6-21). A gateway's action names are long and regular, so an agent
 * that writes `campaign_get` for the provider's `<provider>_campaign_get`, or leaves the trailing `_get` off a read,
 * meant exactly one action, and the refusal that only offered `did_you_mean` cost a round trip. This module generates, from
 * a gateway's own exact names, the spellings that stand for exactly one action; the registry (src/catalog.ts) resolves
 * them, and every call that resolves one answers with a deprecation warning that names the canonical name.
 *
 * What may be an alias, and nothing else (no fuzzy match, no edit distance):
 * - the name without the gateway's provider prefix, the longest `word_` prefix every lower-case name shares;
 * - for a read only, the name without its trailing `_get` or `_list`, or with the other of the two;
 * - whatever the provider's own rule adds (CatalogHooks.aliases: Google Ads' version-neutral spellings).
 *
 * What may never be one: a spelling that is already an exact name of the gateway, or that two actions could claim, or of
 * one word; and a spelling that ends `_get` or `_list` and leads to anything but a read (a write is never reached by a
 * name that reads). An alias is not an action: it is neither listed nor offered by `did_you_mean`, and it resolves to the
 * very action its canonical name does, so everything that decides about the call (the review, the grants, the spending
 * policy) decides on the canonical action.
 */
export interface ActionAliasEntry {
  /** The action the spelling stands for: the one its canonical name reaches. */
  readonly action: Action;
  readonly canonical: string;
}
export interface ActionAliasTable {
  readonly aliases: ReadonlyMap<string, ActionAliasEntry>;
  /** The spellings more than one action could claim, with the canonical names that claim each: never resolved. */
  readonly ambiguous: ReadonlyMap<string, readonly string[]>;
}

/** A lower-case snake name of at least two words: the shape of every name the rules read and write. */
const shape = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const longest = 200;
const readsAs = /_(?:get|list)$/;

/** The longest `word_` prefix every name shares, or '' (a prefix needs at least two names to be a fact of the gateway). */
function commonPrefix(names: readonly string[]): string {
  if (names.length < 2) return '';
  let prefix = names[0]!;
  for (const name of names) {
    while (!name.startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (!prefix) return '';
  }
  const cut = prefix.lastIndexOf('_');
  return cut > 0 ? prefix.slice(0, cut + 1) : '';
}

/**
 * The alias table of one gateway, from its exact names (every name, canonical name and captured alias of its actions,
 * each with the action it reaches) and the provider's own spellings for an action. `retired` says which spellings the
 * provider has withdrawn: they are refused with the replacement they name, never resolved to another action, so no rule and
 * no provider hook may produce one (the review's S4-2).
 */
export function actionAliasTable(
  names: ReadonlyMap<string, Action>,
  extra?: (action: Action) => readonly string[],
  retired?: (spelling: string) => boolean,
): ActionAliasTable {
  const spelled = [...names].filter(([name]) => shape.test(name)),
    prefix = commonPrefix(spelled.map(([name]) => name)),
    claims = new Map<string, Map<string, Action>>();
  const claim = (spelling: string, source: Action) => {
    if (spelling.length > longest || !shape.test(spelling) || names.has(spelling) || retired?.(spelling)) return;
    const canonical = source.canonical_name || source.name,
      target = names.get(canonical) ?? source;
    // A spelling that reads may not lead to an action that does not: a write is never reached by a name that reads.
    if (readsAs.test(spelling) && target.read_only !== true) return;
    const row = claims.get(spelling) ?? new Map<string, Action>();
    row.set(canonical, target);
    claims.set(spelling, row);
  };
  const provided = new Set<Action>();
  for (const [name, action] of spelled) {
    // An executable route only: a name with no route (a legacy name the provider adapts) has nothing to be an alias of.
    if (!action.path) continue;
    const variants = new Set<string>([name]),
      suffix = action.read_only === true ? /^(.*)_(get|list)$/.exec(name) : null;
    // A read answers without its suffix and with the other one, unless some action already has that name.
    if (suffix)
      for (const variant of [suffix[1]!, suffix[1] + '_' + (suffix[2] === 'get' ? 'list' : 'get')])
        if (!names.has(variant)) variants.add(variant);
    for (const variant of variants) {
      if (variant !== name) claim(variant, action);
      if (prefix && variant.startsWith(prefix)) claim(variant.slice(prefix.length), action);
    }
    provided.add(action);
  }
  if (extra) for (const action of provided) for (const spelling of extra(action)) claim(spelling, action);
  const aliases = new Map<string, ActionAliasEntry>(),
    ambiguous = new Map<string, readonly string[]>();
  for (const [spelling, row] of claims)
    if (row.size === 1) {
      const [canonical, action] = [...row][0]!;
      aliases.set(spelling, {action, canonical});
    } else ambiguous.set(spelling, [...row.keys()].sort());
  return {aliases, ambiguous};
}

/**
 * The deprecation warning of a call that used an alias, in the style of `meta.argument_warnings`: the report-only
 * findings a response carries beside its result. `field` is where the caller wrote the name (`action`,
 * `arguments.action`, `steps[0].arguments.action`).
 */
export const actionAliasWarning = (field: string, used: string, canonical: string): JsonObject => ({
  code: 'ACTION_ALIAS_DEPRECATED',
  field,
  used,
  canonical,
  message:
    used +
    ' is an alias of ' +
    canonical +
    '; send ' +
    canonical +
    '. A later release may refuse an alias with UNKNOWN_ACTION.',
});
