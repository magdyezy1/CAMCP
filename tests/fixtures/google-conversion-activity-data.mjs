import {valueInspectionFixture} from './google-value-inspection-data.mjs';

/** Exact selected-account aggregate dates only; no event identifiers, event sender or mutation route. */
export function conversionActivityFixture(t, options = {}) {
  const transform = options.data?.transform;
  return valueInspectionFixture(t, {
    ...options,
    data: {
      ...options.data,
      transform(context) {
        const {body, envelope, requests} = context;
        if (!body.query.includes('metrics.conversion_last_conversion_date')) return transform?.(context) ?? envelope;
        const pass = requests.filter(
          r => r.body.query.includes('metrics.conversion_last_conversion_date') && !r.body.pageToken,
        ).length;
        const out = {
          ...envelope,
          results: envelope.results.map(({conversionAction}) => {
            const metrics = options.activity
              ? options.activity(conversionAction, pass, context.page)
              : {
                  conversionLastConversionDate: '2026-10-01',
                  conversionLastReceivedRequestDateTime: '2026-10-02 13:14:15',
                };
            return {
              conversionAction: {resourceName: conversionAction.resourceName},
              ...(metrics === undefined ? {} : {metrics}),
            };
          }),
        };
        return options.transformActivity?.({...context, pass, envelope: out}) ?? out;
      },
    },
  });
}
