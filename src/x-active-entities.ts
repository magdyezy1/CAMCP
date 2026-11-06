import {MirrorError} from './errors.js';
import {fingerprint} from './report-quality.js';
import {accessRefusalCodes} from './report-source.js';
import type {JsonObject} from './types.js';
import {xAnalyticsTime} from './x-report-jobs.js';
import type {XAnalyticsEntity} from './x-report-levels.js';

/**
 * RPT-03: X's analytics guide says the Active Entities endpoint "should dictate how analytics requests are made":
 * analytics are requested only for campaigns whose metrics changed, within their activity windows. The read is
 * bounded (whole hours, at most 90 days per request, at most 10,000 entities) and validated; a malformed or partial
 * response fails closed instead of narrowing a report silently.
 */
export const xActiveEntitiesChunkMs = 90 * 86400000;
const hour = 3600000;
const maxEntities = 10000;
export const xReportPlacements = ['ALL_ON_TWITTER', 'SPOTLIGHT', 'TREND'] as const;
/**
 * Whether X itself refused one read (HTTP 400, 404 or 422), so the report may go on without that answer. AMCP's own
 * errors are never X's refusal even when they carry the same status: the whole-job allowance (REPORT_COLLECTION_LIMIT is
 * a 422, REPORT_BUDGET_INVALID a 400) and every other REPORT_* refusal end the collection, as do a removed connection, a
 * changed login or a credential failure.
 */
export function xRefusedRead(error: unknown): error is MirrorError {
  return (
    error instanceof MirrorError &&
    !error.retryable &&
    !error.code.startsWith('REPORT_') &&
    !accessRefusalCodes.has(error.code) &&
    error.details.layer !== 'credential' &&
    [400, 404, 422].includes(error.status)
  );
}
export interface XActiveEntity {
  entity_id: string;
  /** Whole-hour UTC window covering the reported activity. */
  start: number;
  end: number;
  /** The placements X reported for the entity; null when X did not name them (every placement is requested). */
  placements: string[] | null;
}
export interface XActiveSet {
  version: 1;
  entities: XActiveEntity[];
  /** Hash of the validated response, part of the X checkpoint definition. */
  fingerprint: string;
  requests: number;
}
/**
 * `on` (default) narrows to active campaigns and their activity windows; `campaigns` keeps the active IDs but
 * requests the whole window (widening for late conversion updates); `off` restores the inventory path (rollback).
 */
export function xActiveEntitiesMode(): 'on' | 'campaigns' | 'off' {
  const mode = process.env.AMCP_X_ACTIVE_ENTITIES;
  return mode === 'off' || mode === 'campaigns' ? mode : 'on';
}
const shape = (problem: string, entity: XAnalyticsEntity = 'CAMPAIGN'): never => {
  if (entity !== 'CAMPAIGN')
    throw new MirrorError(
      'REPORT_SHAPE_CHANGED',
      'X returned an invalid active-entities response, so no native entities were narrowed.',
      {problem},
      502,
    );
  throw new MirrorError(
    'REPORT_SHAPE_CHANGED',
    'X returned an invalid active-entities response, so no campaigns were narrowed.',
    {problem},
    502,
  );
};
const time = (value: unknown, field: string, entity: XAnalyticsEntity) => {
  if (typeof value !== 'string' || value.length > 40) return shape(field + ' is not a timestamp.', entity);
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : shape(field + ' is not a timestamp.', entity);
};
/** Reads and validates the campaigns X reports as active between two instants (widened to whole UTC hours). */
export async function xActiveEntities(
  start: number,
  end: number,
  read: (query: JsonObject) => Promise<JsonObject>,
  entity: XAnalyticsEntity = 'CAMPAIGN',
): Promise<XActiveSet> {
  if (!['CAMPAIGN', 'LINE_ITEM', 'PROMOTED_TWEET'].includes(entity))
    throw new MirrorError('INVALID_REPORT_SOURCE', 'Choose a supported X analytics entity.');
  start = Math.floor(start / hour) * hour;
  end = Math.ceil(end / hour) * hour;
  if (!(end > start)) throw new MirrorError('INVALID_REPORT_RANGE', 'Choose a nonempty X report window.');
  const malformed = (problem: string): never => shape(problem, entity);
  const merged = new Map<string, XActiveEntity>(),
    responses: JsonObject[] = [];
  let requests = 0;
  for (let t = start; t < end; t += xActiveEntitiesChunkMs) {
    const stop = Math.min(end, t + xActiveEntitiesChunkMs);
    const response = await read({entity, start_time: xAnalyticsTime(t), end_time: xAnalyticsTime(stop)});
    requests++;
    if (!response || typeof response !== 'object' || !Array.isArray(response.data))
      malformed('the response has no entity collection.');
    if (response.next_cursor) malformed('the response is paginated; a partial active set is refused.');
    responses.push(response.data);
    for (const item of response.data as unknown[]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) malformed('an entity is not an object.');
      const native = item as JsonObject,
        id = native.entity_id;
      if (typeof id !== 'string' || !/^[A-Za-z0-9]{1,32}$/.test(id)) malformed('an entity ID is missing or invalid.');
      const from = time(native.activity_start_time, 'activity_start_time', entity),
        to = time(native.activity_end_time, 'activity_end_time', entity);
      if (to < from) malformed('an activity window ends before it starts.');
      const named = native.placements ?? (native.placement === undefined ? undefined : [native.placement]);
      if (
        named !== undefined &&
        (!Array.isArray(named) ||
          named.length > 10 ||
          named.some(p => typeof p !== 'string' || !/^[A-Z_]{1,40}$/.test(p)))
      )
        malformed('placements are invalid.');
      const window = {
        start: Math.max(start, Math.floor(from / hour) * hour),
        end: Math.min(end, Math.max(Math.ceil(to / hour) * hour, Math.floor(from / hour) * hour + hour)),
      };
      const prior = merged.get(id);
      const placements =
        named === undefined || prior?.placements === null
          ? null
          : [...new Set([...(prior?.placements ?? []), ...(named as string[])])].sort();
      merged.set(id, {
        entity_id: id,
        start: Math.min(prior?.start ?? window.start, window.start),
        end: Math.max(prior?.end ?? window.end, window.end),
        placements,
      });
      if (merged.size > maxEntities) {
        if (entity !== 'CAMPAIGN')
          throw new MirrorError(
            'REPORT_RANGE_LIMIT',
            'X reported more than 10,000 active native entities. Split the date range.',
            {platform: 'x'},
            422,
          );
        throw new MirrorError(
          'REPORT_RANGE_LIMIT',
          'X reported more than 10,000 active campaigns. Split the date range.',
          {platform: 'x'},
          422,
        );
      }
    }
  }
  const entities = [...merged.values()].sort((a, b) => (a.entity_id < b.entity_id ? -1 : 1));
  return {
    version: 1,
    entities,
    fingerprint: fingerprint({start, end, responses, ...(entity !== 'CAMPAIGN' ? {entity} : {})}),
    requests,
  };
}
/** A retained checkpoint copy is re-validated before it narrows a resumed run. */
export function xActiveSet(value: unknown): XActiveSet | undefined {
  if (value === undefined) return undefined;
  const v = value as JsonObject;
  if (
    !v ||
    v.version !== 1 ||
    typeof v.fingerprint !== 'string' ||
    !Array.isArray(v.entities) ||
    v.entities.some(
      (e: JsonObject) =>
        !e ||
        typeof e.entity_id !== 'string' ||
        !Number.isSafeInteger(e.start) ||
        !Number.isSafeInteger(e.end) ||
        (e.placements !== null && !Array.isArray(e.placements)),
    )
  )
    throw new MirrorError('REPORT_DEFINITION_CHANGED', 'The saved X active set is invalid. Start a new run.');
  return v as XActiveSet;
}
