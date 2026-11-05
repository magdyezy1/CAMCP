// Stored before fallback/override fields existed. A run preserves this config beside its upgraded v4 sidecar.
export const savedObjectiveViews = ['leads', 'unknown'].map(objective => ({
  id: 'saved-v3-' + objective,
  config: {
    name: 'Saved objective fixture',
    sources: [{platform: 'meta', account_id: '100', connection_id: 'login', objective}],
    date_range: {since: '2026-09-01', until: '2026-09-02'},
    metrics: ['spend', 'clicks', 'impressions'],
    custom_metrics: [],
    targets: {},
    objectives: [],
    source_contract_version: 'campaign-source-v3',
    version: 3,
  },
  created_at: 1,
  updated_at: 2,
}));
