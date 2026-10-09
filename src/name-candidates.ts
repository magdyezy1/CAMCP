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
 * What a refusal of an unknown name carries (MCP-05): the value, how many names are valid, the first 20 of them and
 * up to five close ones from the same list (never another gateway's), so the caller can correct it in one call.
 */
export function nameCandidates(value: string, candidates: string[]): JsonObject {
  const needle = value.toLowerCase().slice(0, 200),
    close = candidates
      .map(name => {
        const lower = name.toLowerCase();
        return {
          name,
          score:
            needle.length >= 4 && (lower.includes(needle) || needle.includes(lower))
              ? 0
              : distance(needle, lower.slice(0, 200)),
        };
      })
      .filter(c => c.score <= Math.max(3, Math.floor(needle.length / 3)))
      .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
      .slice(0, 5)
      .map(c => c.name);
  return {value: value.slice(0, 200), count: candidates.length, allowed: candidates.slice(0, 20), did_you_mean: close};
}
/** A short search term for a list call: the longest word of the unknown name. */
export const searchTerm = (value: string) =>
  (value.split(/[^A-Za-z0-9]+/).sort((a, b) => b.length - a.length)[0] ?? '').slice(0, 40);
