/** Fixed original aggregate report shape; no live provider or event sender. */
export const measurementEventFixtureConnection = 'aaaaaaaa-1111-4111-8111-111111111111';
export function measurementEventReport() {
  const row = (minute, count) => ({
    dimensionValues: [{value: 'purchase'}, {value: minute}, {value: '900'}],
    metricValues: [{value: count}],
    private: 'UNUSED-PRIVATE-EVENT',
  });
  return {
    kind: 'analyticsData#runRealtimeReport',
    dimensionHeaders: ['eventName', 'minutesAgo', 'streamId'].map(name => ({name})),
    metricHeaders: [{name: 'eventCount', type: 'TYPE_INTEGER'}],
    rows: [row('00', '9007199254740993'), row('01', '2')],
    rowCount: 2,
  };
}
