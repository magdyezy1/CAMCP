import type {JsonObject} from './types.js';
import {reportPlatforms} from './report-metrics.js';
import {reportSource} from './report-sources.js';
import {reportGrains} from './report-periods.js';
import {overviewV4ScopeFields, overviewV4ScopeIdLimit} from './overview-v4.js';

/**
 * The typed reporting contract of the MCP input schema (V2-MCP-02). A report definition's `config` used to be an opaque
 * object, so a client could learn the levels, the scope lists and the statuses of a v4 source only from code. They are
 * generated here from the tables validation and the bootstrap read: each platform's report source (`overview`:
 * levels, supported statuses, option names), the level and scope-field tables of src/overview-v4.ts, the platform and
 * grain tables. Nothing below names a platform, a level or a status.
 *
 * The schema describes the fields every platform shares. It never refuses what the handlers accept: no property is
 * required that some use of `config` leaves out, and no object is closed, so a definition saved by an earlier build or
 * one that carries fields only a platform reads (its report options, its parent filter) still validates. What differs by
 * platform (a level a platform lacks, the option names and their values, the native ID pattern, the defaults) stays in
 * the bootstrap, platforms[].reporting_v4, which is built from the same tables.
 *
 * What is left out of the listing, and why (tools/list was built to fit 97,280 bytes, its limit until the owner raised it
 * to 256 KiB on 2026-11-23, and the schema is paid for in each of them):
 * `name`, `date_range`, `metrics` and the other fields every platform shares and a client fills from the description of
 * the report, which the handler checks with its own refusals; the per-platform union of `report_options` (its names
 * and values are in the bootstrap).
 */
/** The limits `config` validation (src/reporting-overview.ts) and this schema share. */
export const overviewConfigLimits = {name: 100, sources: 30} as const;
/** The longest text a row query (`get`) takes, as amcp_reporting's row_query does. */
export const overviewRowQueryLimit = 150;
/** The longest continuation cursor of a filtered `get` or `list` (src/page-cursor.ts accepts 1,024). */
export const overviewCursorLimit = 1024;
/** The states a report snapshot is in; `list` filters on them. */
export const overviewSnapshotStates = ['queued', 'running', 'complete', 'partial', 'failed', 'cancelled'] as const;
/** What `get` adds when asked: the native fields, each source's lineage, and the charts a v4 snapshot stores with it. */
export const overviewIncludeFlags: readonly string[] = ['native', 'lineage', 'charts'];

/** What the tables say across all platforms, in the order the tables list them. */
export interface OverviewTableFacts {
  /** Every reporting platform. */
  platforms: string[];
  /** Every level any platform reports at. */
  levels: string[];
  /** The most levels one platform reports at. */
  maxLevels: number;
  /** Every status any platform filters by. */
  statuses: string[];
  /** Each level's scope list: the field that holds the native IDs of its entities. */
  scopeFields: string[];
}
let facts: OverviewTableFacts | undefined;
const unique = <T>(values: T[]): T[] => [...new Set(values)];
export function overviewTableFacts(): OverviewTableFacts {
  if (facts) return facts;
  const platforms = Object.keys(reportPlatforms),
    declared = platforms.flatMap(platform => {
      const overview = reportSource(platform)?.overview;
      return overview ? [overview] : [];
    });
  return (facts = {
    platforms,
    levels: unique(declared.flatMap(overview => overview.levels.map(level => level.id))),
    maxLevels: Math.max(...declared.map(overview => overview.levels.length)),
    statuses: unique(declared.flatMap(overview => [...overview.supported_statuses])),
    scopeFields: overviewV4ScopeFields.map(([field]) => field),
  });
}
const text = (extra: JsonObject = {}) => ({type: 'string', ...extra});
const choice = (values: readonly string[]) => ({type: 'string', enum: [...values]});

/** One report source of a definition, as every platform shares it. */
export function overviewSourceSchema(): JsonObject {
  const f = overviewTableFacts(),
    idList = {type: 'array', maxItems: overviewV4ScopeIdLimit, items: text()};
  return {
    type: 'object',
    properties: {
      platform: choice(f.platforms),
      levels: {type: 'array', minItems: 1, maxItems: f.maxLevels, items: choice(f.levels)},
      level: choice(f.levels),
      statuses: {type: 'array', items: choice(f.statuses)},
      delivered_only: {type: 'boolean'},
      ...Object.fromEntries(f.scopeFields.map(field => [field, idList])),
      report_options: {type: 'object'},
    },
  };
}

/** The `config` argument: a report definition, v3 or v4. */
export function overviewConfigSchema(): JsonObject {
  return {
    type: 'object',
    properties: {
      grain: choice(reportGrains),
      sources: {type: 'array', items: overviewSourceSchema()},
    },
  };
}

/**
 * The arguments that narrow `get` (platform, level, entity, query) and `list` (client, platform, state), and the cursor
 * that continues a narrowed read. They only ever hide what the caller may already read. The handler checks the values
 * against the tables (src/report-read-filters.ts: an unknown platform, level or state is refused, never matched against
 * nothing), so the listing leaves them as text and spends no bytes on the lists.
 */
export function overviewFilterProperties(): JsonObject {
  return {
    platform: text(),
    level: text(),
    entity: text(),
    query: text({maxLength: overviewRowQueryLimit}),
    client: text(),
    state: text(),
    cursor: text({maxLength: overviewCursorLimit}),
  };
}
