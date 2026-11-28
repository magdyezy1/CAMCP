import type {JsonObject} from './types.js';

const distance = (a: string, b: string) => {
  let row = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
};
/**
 * Whether a refusal may name a value in its message: up to 64 characters of the kind an action name has. Text an agent typed where a
 * name belongs (spaces, markup, a long string) is not echoed into a message (the rule of the account IDs of src/compiler.ts, S4-5).
 */
export const echoableName = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 64 && /^[\w.:/@%+=-]+$/.test(value);
const wordsOf = (name: string) => name.split(/[^a-z0-9]+/).filter(Boolean);
/** The same word, or a word of five letters or more with one typo: "campains" is "campaigns", "get" is not "gut". */
const sameWord = (a: string, b: string) => a === b || (a.length >= 5 && b.length >= 5 && distance(a, b) <= 1);
/**
 * What a refusal of an unknown name carries (MCP-05): the value, how many names are valid, the first 20 of them and
 * up to five close ones from the same list (never another gateway's), so the caller can correct it in one call.
 * A name is close when it contains the value or is contained in it, when it has every word of the value (one typo in a
 * word of five letters or more), or when it differs by a typo: at most `max(2, a tenth of the value's length)` edits. It was
 * a third of the length, so a guess at the account's activity read, in the catalog's own naming, was offered ad creatives,
 * ad images and ad videos (r25-fr-meta-reads D6). Nothing close gives no names and `nothing_similar`, which the remedy says in words.
 */
export function nameCandidates(value: string, candidates: string[]): JsonObject {
  const needle = value.toLowerCase().slice(0, 200),
    wanted = wordsOf(needle),
    limit = Math.max(2, Math.ceil(needle.length / 10)),
    close = candidates
      .map(name => {
        const lower = name.toLowerCase(),
          own = wordsOf(lower),
          shares = wanted.join('').length >= 4 && wanted.every(w => own.some(c => sameWord(w, c)));
        return {
          name,
          // A name with every word of the value comes after one that contains it, and the one with fewer other words first.
          extra: shares ? own.length - wanted.length : 0,
          score:
            needle.length >= 4 && (lower.includes(needle) || needle.includes(lower))
              ? 0
              : shares
                ? 1
                : distance(needle, lower.slice(0, 200)),
        };
      })
      .filter(c => c.score <= limit)
      .sort((a, b) => a.score - b.score || a.extra - b.extra || a.name.localeCompare(b.name))
      .slice(0, 5)
      .map(c => c.name);
  return {
    value: value.slice(0, 200),
    count: candidates.length,
    allowed: candidates.slice(0, 20),
    did_you_mean: close,
    ...(close.length ? {} : {nothing_similar: true}),
  };
}
/** A short search term for a list call: the longest word of the unknown name. */
export const searchTerm = (value: string) =>
  (value.split(/[^A-Za-z0-9]+/).sort((a, b) => b.length - a.length)[0] ?? '').slice(0, 40);
