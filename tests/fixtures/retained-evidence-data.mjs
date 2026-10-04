export const evidenceConnection = 'bbbbbbbb-1111-4111-8111-111111111111';
export const evidenceId = 'synthetic-retained-evidence';
export function retainedEvidence() {
  const rows = Array.from({length: 151}, (_, i) => ({
    entity_id: String(9007199254740993n + BigInt(i)),
    entity_name: i % 2 ? 'بيت الرياض' : 'Home <img> ' + i,
    date: i % 2 ? '2026-09-02' : '2026-09-01',
    spend: '9007199254.740993',
    impressions: '100',
    clicks: '0',
    conversions: null,
  }));
  return {
    gateway: 'google_ads_native_action',
    account_id: '123',
    connection_id: evidenceConnection,
    source: 'provider_read',
    source_hash: 'a'.repeat(64),
    semantics: {
      currency: 'USD',
      timezone: 'UTC',
      date_from: '2026-09-01',
      date_to: '2026-09-02',
      attribution: 'unknown',
      conversion_definition: 'metrics.conversions',
      source_name: 'Synthetic retained rows',
      complete: false,
    },
    grain: 'campaign × day',
    mapping: {
      entity_id: '/id',
      entity_name: '/name',
      date: '/day',
      spend: '/amount',
      impressions: '/impressions',
      clicks: '/clicks',
      conversions: '/conversions',
    },
    totals: {spend: '1360087087465.889943', impressions: '15100', clicks: '0', conversions: null},
    coverage: {spend: 'mapped', impressions: 'mapped', clicks: 'mapped', conversions: 'partial'},
    rows,
    source_request: {query: 'Synthetic source definition'},
    captured_at: 1790900000000,
  };
}
