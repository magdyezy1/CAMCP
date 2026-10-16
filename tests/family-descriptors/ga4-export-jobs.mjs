// ga4_export_jobs: POST https://analyticsdata.googleapis.com/v1alpha/properties/{id}/reportTasks (Google Analytics Data
// API, ReportTask) through the delegated ga4_create_report_task operation. A report task's date ranges are read in the
// property's reporting time zone (Property.time_zone: "Reporting Time Zone, used as the day boundary for reports"), so
// the property's `timeZone` decides which days the reviewed report covers and is the decisive field.
const property = 'properties/123',
  admin = 'https://analyticsadmin.googleapis.com',
  data = 'https://analyticsdata.googleapis.com';

export default {
  family: 'ga4_export_jobs',
  risk: 'settings',
  gateway: 'ga4_native_action',
  account: '123',
  connection: {scopes: ['https://www.googleapis.com/auth/analytics.readonly']},
  arguments: {
    operation: 'ga4_create_report_task',
    arguments: {
      property: '123',
      request: {
        reportDefinition: {
          dateRanges: [{startDate: '2026-09-01', endDate: '2026-09-02'}],
          metrics: [{name: 'sessions'}],
        },
      },
    },
  },
  seed: () => ({
    property: {name: property, displayName: 'Synthetic', timeZone: 'Africa/Cairo', currencyCode: 'EGP'},
    tasks: [],
  }),
  unpaginated: 'GET /v1beta/properties/{id} returns one Property resource; the Admin API pages only lists',
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && url.origin === admin && path === '/v1beta/' + property) return {json: state.property};
    if (url.origin !== data) return;
    const task = state.tasks.find(t => path.endsWith('/' + t.name));
    if (method === 'GET' && task) return {json: task};
    if (method === 'POST' && /^\/v1(?:alpha|beta)\/properties\/123\/reportTasks$/.test(path)) {
      // A partial answer: Google accepts the request but names no report task.
      if (mode.partial) return {json: {}};
      const created = {...body, name: property + '/reportTasks/' + (state.tasks.length + 1)};
      state.tasks.push({...created, reportMetadata: {state: 'CREATING'}});
      return {json: created};
    }
  },
  decisive: {change: state => (state.property.timeZone = 'America/New_York'), field: /timeZone/},
};
