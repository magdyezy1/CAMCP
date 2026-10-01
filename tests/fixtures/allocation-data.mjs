export function allocationReport(now = Date.now()) {
  const today = Date.parse(new Date(now).toISOString().slice(0, 10));
  const first = new Date(today - 2 * 86400000).toISOString().slice(0, 10);
  const last = new Date(today - 86400000).toISOString().slice(0, 10);
  return {
    gateway: 'meta_native_action',
    account_id: '100',
    connection_id: 'meta',
    source: 'provider_read',
    preset: 'meta_campaign',
    grain: 'campaign × day',
    source_hash: 'synthetic-allocation-evidence',
    captured_at: now,
    semantics: {
      currency: 'USD',
      timezone: 'UTC',
      date_from: first,
      date_to: last,
      attribution: '7-day click; impression time',
      conversion_definition: 'Pixel purchase',
      source_name: 'Synthetic allocation evidence',
      complete: true,
    },
    rows: [
      {entity_id: '10', entity_name: 'Efficient', date: first, spend: '40', conversions: '8'},
      {entity_id: '10', entity_name: 'Efficient', date: last, spend: '60', conversions: '12'},
      {entity_id: '20', entity_name: 'Established', date: first, spend: '50', conversions: '5'},
      {entity_id: '20', entity_name: 'Established', date: last, spend: '50', conversions: '5'},
    ],
    totals: {spend: '200', conversions: '30', clicks: null, impressions: null},
  };
}
