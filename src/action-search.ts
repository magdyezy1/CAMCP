import type {Action, JsonObject} from './types.js';

/**
 * The search of LIST_ACTIONS (r25-fr-meta-reads D4, the owner's friction report of 2026-11-26). It was the whole phrase as one
 * substring of the record's JSON, parameter lists included, so "adgroup get" found nothing (names join words with underscores),
 * "advertiser" found 375 of TikTok's 561 actions (it is in their parameter lists) and Meta's own tool text recommends searches
 * ("assigned users", "business user") that found nothing. A search is now its words: each must begin a word of the action, and
 * what is searched is what the tool's text says it is (action, alias, category, endpoint, documentation), never a parameter list.
 *
 * The words of a text are its runs of letters and digits, split again where lower case turns to upper case, in lower case, with a
 * final "s" folded away from a word of more than three letters ("adgroups" is "adgroup", "get" stays "get").
 * Tier 0: the words are in the action's name, canonical name or aliases. Tier 1: they are in those and the path, endpoint or
 * category. Tier 2: they are in those and any other text the record states (its description, service, method). An exact name
 * comes first; then tier 0, 1, 2; within a tier the name with fewer other words, then the catalog's order.
 */
const fold = (word: string) => (word.length > 3 ? word.replace(/s$/, '') : word);
export const searchWords = (text: string): string[] =>
  text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(fold);
/** At most this many words of a search count: a phrase longer than that is a sentence, not a name. */
const maxWords = 8;
/** The records of a search page unless the call asks for more (about 7 KiB), and the most it may carry (about 17 KiB). */
export const searchPageDefault = 20,
  searchPageMaximum = 50;
const strings = (values: unknown[]): string[] =>
  values.filter((v): v is string => typeof v === 'string' && v.length > 0);

interface Pools {
  readonly names: string[];
  readonly first: string[];
  readonly second: string[];
  readonly third: string[];
}
const pools = new WeakMap<Action, Pools>();
function poolsOf(action: Action): Pools {
  let own = pools.get(action);
  if (!own) {
    const raw: JsonObject = action.raw ?? {},
      names = strings([
        action.name,
        action.canonical_name,
        ...(action.aliases ?? []),
        raw.name,
        raw.action,
        raw.canonical_action,
      ]),
      first = names.flatMap(searchWords),
      second = [...first, ...strings([action.path, raw.path, raw.endpoint, raw.category]).flatMap(searchWords)],
      // Scalar strings only: an array or an object is a list of fields or parameters, which is never searched.
      third = [...second, ...strings(Object.values(raw)).flatMap(searchWords)];
    pools.set(action, (own = {names: names.map(n => n.toLowerCase()), first, second, third}));
  }
  return own;
}

/** The actions that match a search, best first (see the module comment); none for a search with no words. */
export function searchActions<T extends Action>(actions: readonly T[], search: string): T[] {
  const wanted = searchWords(search).slice(0, maxWords),
    exact = search.trim().toLowerCase();
  if (!wanted.length) return [];
  const covers = (pool: string[]) => wanted.every(word => pool.some(token => token.startsWith(word)));
  const ranked: {action: T; tier: number; extra: number; order: number}[] = [];
  actions.forEach((action, order) => {
    const own = poolsOf(action),
      tier = own.names.includes(exact)
        ? -1
        : covers(own.first)
          ? 0
          : covers(own.second)
            ? 1
            : covers(own.third)
              ? 2
              : undefined;
    if (tier !== undefined)
      ranked.push({action, tier, extra: Math.max(0, searchWords(action.name).length - wanted.length), order});
  });
  return ranked.sort((a, b) => a.tier - b.tier || a.extra - b.extra || a.order - b.order).map(r => r.action);
}

/**
 * A record as a search page carries it: its scalar facts and the parameters it requires. Its field and parameter lists (TikTok's
 * `native_fields` run to 23 names for one action, 13 KB for 20 records) are named in `omitted` and are one DESCRIBE_ACTION away.
 */
export function briefRecord(record: JsonObject): JsonObject {
  const kept: JsonObject = {},
    omitted: string[] = [];
  for (const [key, value] of Object.entries(record))
    if (value !== null && typeof value === 'object' && !key.startsWith('required')) omitted.push(key);
    else kept[key] = value;
  return omitted.length ? {...kept, omitted} : kept;
}
