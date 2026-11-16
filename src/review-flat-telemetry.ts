/**
 * The response metadata and telemetry names a FLAT resource carries beside its configuration (R2.5 M1, L5-02). A provider
 * whose answers have no container to keep only the configuration of (Meta's Graph nodes, LinkedIn's and DV360's resources,
 * the measurement providers' entities) has nowhere to cut a request ID, a last-modified time or a counter off, so its
 * review table lists these names. This is what src/review-state-core.ts once applied to every provider, key by key, at every
 * depth. It is now an opt-in list: a provider that projects its answer to the records it keeps (TikTok, Snapchat, X,
 * Reddit, Microsoft, Apple, Google Ads) does not list it, so a field that merely shares a name with another provider's
 * telemetry stays protected.
 *
 * Names only, and only names that no user edit changes. Nothing here names a provider.
 */
export const flatResourceTelemetry: readonly string[] = Object.freeze([
  'delivery_status',
  'effective_status',
  'secondary_status',
  'updated_at',
  'updated_time',
  'last_modified_time',
  'last_modified_at',
  'last_modified',
  'update_time',
  'modification_time',
  'modify_time',
  'modified_at',
  'modified_time',
  'last_updated_at',
  'last_update_time',
  'request_id',
  'request_time',
  'trace_id',
  'sub_request_status',
  'request_status',
  'stats',
  'statistics',
  'metrics',
  'insights',
  'reporting',
  'pacing_stats',
  'pacing_metrics',
  'total_stats',
  'timeseries_stats',
  'delivery_metrics',
  'delivery_stats',
  'delivery_pacing',
  'spend_to_date',
  'last_synced_at',
  // A pixel's last event (Reddit last_fired_at, PRV-06 D) is telemetry; a review keeps whether and how recently it fired.
  'last_fired_at',
]);
