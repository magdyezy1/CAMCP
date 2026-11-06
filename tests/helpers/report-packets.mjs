// Collected report packets and definitions in the shapes the collectors hand to the assembly, for tests that need no
// provider: v4 rows with a mapped result, packets of one source level, and a frozen v4 definition.
export const range = {since: '2026-09-01', until: '2026-09-02'};
export const leads = {
  id: 'meta:leads',
  metric: 'leads',
  label: 'Leads',
  native_metric: 'actions.lead',
  aggregation: 'sum',
  unit: 'number',
};
/** One v4-shaped campaign or entity row. `more` overrides any field, `more.definition` the result definition. */
export function row(level, id, metrics = {}, more = {}) {
  const {definition = leads, value = '2', ...rest} = more,
    entity =
      level === 'campaign' ? {} : {entity_id: id, entity_name: id, entity_level: level, native_entity_type: level};
  return {
    campaign_id: level === 'campaign' ? id : (rest.parent_ids?.campaign_id ?? 'c1'),
    campaign_name: level === 'campaign' ? id : 'c1',
    ...entity,
    ...(level === 'campaign'
      ? {}
      : {
          parent_ids: {
            campaign_id: 'c1',
            campaign_name: 'c1',
            ...(level === 'ad' ? {adset_id: 's1', adset_name: 's1'} : {}),
          },
        }),
    objective: 'OUTCOME_LEADS',
    currency: null,
    status: 'active',
    metrics: {impressions: '100', clicks: '10', spend: '1', reach: null, frequency: null, ...metrics},
    result: definition
      ? {metric: definition.metric, label: definition.label, value, cost_per_result: null, definition_id: definition.id}
      : {metric: null, label: null, value: null, cost_per_result: null, definition_id: null},
    result_context: definition
      ? {definition, source: 'mapped', cost_source: 'derived', unavailable_reason: null, rounding: {}}
      : {
          definition: null,
          source: 'unknown',
          cost_source: 'unknown',
          unavailable_reason: 'unsupported_goal',
          rounding: {},
        },
    native: {delivery_activity: true},
    ...rest,
  };
}
export const source = (level, more = {}) => ({
  platform: 'meta',
  account_id: '100',
  connection_id: 'login',
  level,
  levels: ['campaign', 'ad'],
  source_ref: 0,
  reporting_contract: 'overview-config-v4',
  ...more,
});
/** The packet a collector returns for one level of one source. `more.source` changes the source, the rest the packet. */
export const packet = (level, rows, more = {}) => ({
  rows,
  currency: 'USD',
  timezone: 'UTC',
  complete: true,
  collection_complete: true,
  source_kind: 'ads',
  date_range: range,
  warnings: [],
  lineage: [],
  captured_at: 1790000000000,
  result_definition: 'Synthetic results',
  attribution: 'Synthetic click window',
  quality: {version: 2, status: 'complete'},
  ...more,
  source: source(level, more.source),
});
/** A frozen v4 definition. */
export const config = (more = {}) => ({
  contract_version: 'overview-config-v4',
  name: 'Synthetic',
  sources: [source('campaign')],
  date_range: range,
  grain: 'total',
  metrics: ['spend', 'cpc'],
  custom_metrics: [],
  objectives: [],
  targets: {},
  formula_version: 'synthetic-formula',
  ...more,
});
