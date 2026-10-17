import {servicePartitionOf} from './document-kinds.js';
import type {Store} from './store.js';
import type {JsonObject} from './types.js';

/** A heartbeat larger than this is not decoded; at most this many recent valid observations are returned. */
export const heartbeatBytes = 512,
  observationLimit = 100;
// Keep unselected document bodies and identifiers inside SQLite. One statement observes one database snapshot.
// CASE bounds JSON parsing before validation; duplicate keys never turn malformed metadata into healthy liveness.
const query = `WITH bounded AS MATERIALIZED (
  SELECT id,CASE WHEN length(CAST(data AS BLOB))<=${heartbeatBytes}
    THEN CASE WHEN json_valid(data) THEN data ELSE '{}' END ELSE '{}' END AS metadata
  FROM documents WHERE tenant_id='${servicePartitionOf('worker_heartbeat')}' AND kind='worker_heartbeat'
), projected AS MATERIALIZED (
  SELECT id,json_extract(metadata,'$.at') AS at,json_extract(metadata,'$.state') AS state,
    CASE WHEN json_type(metadata,'$.at')='integer' AND json_extract(metadata,'$.at') BETWEEN 0 AND ?
      AND json_type(metadata,'$.state')='text' AND json_extract(metadata,'$.state') IN ('idle','working')
      AND (SELECT count(*) FROM json_each(metadata) WHERE key='at')=1
      AND (SELECT count(*) FROM json_each(metadata) WHERE key='state')=1 THEN 1 ELSE 0 END AS qualified
  FROM bounded
), summary AS (
  SELECT count(*) AS total_records,coalesce(sum(qualified),0) AS observed_records,
    coalesce(sum(CASE WHEN qualified=1 AND at>=? THEN 1 ELSE 0 END),0) AS active_records,
    coalesce(sum(CASE WHEN qualified=0 THEN 1 ELSE 0 END),0) AS unavailable_records FROM projected
), observations AS (
  SELECT json_group_array(json_object('at',at,'state',state)) AS rows FROM (
    SELECT at,state FROM projected WHERE qualified=1 ORDER BY at DESC,id LIMIT ${observationLimit}
  )
) SELECT summary.*,observations.rows FROM summary CROSS JOIN observations`;

/**
 * The worker heartbeats (service documents, ARC-02) in one SQLite snapshot: counts of all records, of valid ones and
 * of those at or after `activeSince`, and at most `observationLimit` recent valid observations (`at` and `state` only)
 * as JSON text in `rows`. Records at or before `now` only count as valid.
 */
export function heartbeatSnapshot(store: Store, now: number, activeSince: number): JsonObject {
  return store.sql().prepare(query).get(now, activeSince) as JsonObject;
}
