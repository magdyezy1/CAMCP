export const measurementIdentityId = 'amcp-test-12345678-abcd';
export const measurementIdentityInput = {
  action: 'measurement_event_identity',
  gateway: 'ga4_native_action',
  account_id: '123',
  connection_id: 'aaaaaaaa-1111-4111-8111-111111111111',
  requirements: {
    event_name: 'purchase',
    test_id: measurementIdentityId,
    date_from: '2026-10-01',
    date_to: '2026-10-02',
    stream_id: '900',
    expected_count: 1,
  },
};
export const measurementIdentityMetadata = () => ({
  name: 'properties/123/metadata',
  dimensions: [
    {apiName: 'eventName'},
    {apiName: 'streamId'},
    {apiName: 'customEvent:amcp_test_id', customDefinition: true},
  ],
  metrics: [{apiName: 'eventCount', type: 'TYPE_INTEGER'}],
  private: 'PRIVATE-NATIVE-METADATA',
});
export const measurementIdentityRow = (count = '1', stream = '900', testId = measurementIdentityId) => ({
  dimensionValues: ['purchase', testId, stream].map(value => ({value})),
  metricValues: [{value: count}],
  private: 'PRIVATE-NATIVE-ROW',
});
export const measurementIdentityReport = (rows = [measurementIdentityRow()]) => ({
  kind: 'analyticsData#runReport',
  dimensionHeaders: [{name: 'eventName'}, {name: 'customEvent:amcp_test_id'}, {name: 'streamId'}],
  metricHeaders: [{name: 'eventCount', type: 'TYPE_INTEGER'}],
  rows,
  rowCount: rows.length,
  metadata: {timeZone: 'Asia/Riyadh'},
  private: 'PRIVATE-NATIVE-REPORT',
});
