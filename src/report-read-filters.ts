import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';
import {overviewRowQueryLimit, overviewSnapshotStates, overviewTableFacts} from './report-tool-schema.js';

/**
 * The filters of the Overview's reads (V2-MCP-02, decision 3): `get` narrows the rows of one snapshot by platform, level,
 * entity and a row query; `list` narrows the snapshots by client, platform and state. A filter only ever hides what the
 * caller may already read: the handlers run it after the access checks, on rows and snapshots that passed them. Its
 * values are checked against the tables (an unknown platform, level or state is refused, never matched against
 * nothing), so a mistyped filter cannot be read as "no data".
 */
export interface RowFilters {
  platform?: string;
  level?: string;
  entity?: string;
  query?: string;
}
export interface SnapshotFilters {
  client?: string;
  platform?: string;
  state?: string;
}
/** The longest native ID `entity` and the longest client profile ID `client` take (the scope ID pattern allows 200). */
const idLimit = 200;

// Fixed sentences with the specifics in details, so the Arabic inventory tracks each reason (tools/check-locales.mjs).
const notInList = (field: string, allowed: readonly string[]) =>
  new MirrorError('INVALID_ARGUMENT', 'Use one of the values the details list for this filter.', {
    field,
    allowed: [...allowed],
  });
const notText = (field: string, max: number) =>
  new MirrorError('INVALID_ARGUMENT', 'Use plain text of at most the length the details give for this filter.', {
    field,
    max_length: max,
  });
const oneOf = (input: JsonObject, field: string, allowed: readonly string[]): string | undefined => {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value)) throw notInList(field, allowed);
  return value;
};
const exactText = (input: JsonObject, field: string, max: number): string | undefined => {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw notText(field, max);
  return value;
};
const without = <T extends object>(filters: T): T =>
  Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined)) as T;

/** The row filters of a `get`, checked; an unset filter is absent. A query of blanks narrows nothing. */
export function rowFilters(input: JsonObject): RowFilters {
  const facts = overviewTableFacts(),
    query = input.query;
  if (query !== undefined && (typeof query !== 'string' || query.length > overviewRowQueryLimit))
    throw notText('query', overviewRowQueryLimit);
  return without({
    platform: oneOf(input, 'platform', facts.platforms),
    level: oneOf(input, 'level', facts.levels),
    entity: exactText(input, 'entity', idLimit),
    query: typeof query === 'string' && query.trim() ? query.trim() : undefined,
  });
}
/** The snapshot filters of a `list`, checked. */
export function snapshotFilters(input: JsonObject): SnapshotFilters {
  return without({
    client: exactText(input, 'client', idLimit),
    platform: oneOf(input, 'platform', overviewTableFacts().platforms),
    state: oneOf(input, 'state', overviewSnapshotStates),
  });
}
export const filterActive = (filters: object): boolean => Object.keys(filters).length > 0;

const present = (value: unknown): value is string | number =>
  typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
/**
 * Whether a stored row passes the row filters. The platform is the row’s own; a row without a level is a campaign row;
 * an entity matches the row’s own native ID and the IDs of the campaign and ad set above it, so one campaign gives its
 * ad sets and ads; the query is a case-insensitive text search over those IDs and the names beside them.
 */
export function rowMatches(row: JsonObject, filters: RowFilters): boolean {
  if (filters.platform !== undefined && row.platform !== filters.platform) return false;
  if (filters.level !== undefined && (row.entity_level ?? 'campaign') !== filters.level) return false;
  const parents = row.parent_ids ?? {},
    ids = [row.entity_id, row.campaign_id, parents.campaign_id, parents.adset_id].filter(present).map(String);
  if (filters.entity !== undefined && !ids.includes(filters.entity)) return false;
  if (filters.query !== undefined) {
    const needle = filters.query.toLowerCase(),
      haystack = [...ids, row.entity_name, row.campaign_name, parents.campaign_name, parents.adset_name]
        .filter(present)
        .map(value => String(value).toLowerCase());
    if (!haystack.some(text => text.includes(needle))) return false;
  }
  return true;
}
