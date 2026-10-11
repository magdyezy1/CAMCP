// Shared synthetic Google Ads API answers for the conformance descriptors (not a descriptor itself). Google Ads reads
// are GAQL queries to googleAds:search; a page that is not the last one carries `nextPageToken`. The synthetic provider
// answers every page of a paginated snapshot with the same token, the shape a family must refuse instead of reviewing
// an incomplete or endless collection.
export const account = '123';
export const connection = {scopes: ['https://www.googleapis.com/auth/adwords']};
export const credentials = {accessToken: 'synthetic', developerToken: 'synthetic'};
export const resource = (collection, id) => 'customers/' + account + '/' + collection + '/' + id;
export const camel = name => name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
export const customer = {
  id: account,
  currencyCode: 'USD',
  timeZone: 'UTC',
  descriptiveName: 'Synthetic',
  manager: false,
};
/** The GAQL resource a query selects FROM. */
export const from = query => /\bFROM\s+([a-z_]+)/i.exec(String(query))?.[1];
/** Whether a request is a googleAds:search read. */
export const isSearch = ({method, path}) => method === 'POST' && /\/googleAds:search(?:Stream)?$/.test(path);
/**
 * One googleAds:search answer. `rows(kind, body)` returns the rows for the GAQL resource, each either a whole result
 * row ({campaign: {...}, ...}) or the resource object itself, which is wrapped under its camelCase name.
 */
export function search({body, mode}, rows) {
  const kind = from(body?.query),
    key = camel(kind ?? ''),
    own = rows(kind, body) ?? [],
    // The selected customer, unless the descriptor holds its own.
    list = kind === 'customer' && !own.length ? [{customer}] : own,
    results = list.map(row => (row && typeof row === 'object' && row[key] !== undefined ? row : {[key]: row}));
  return {
    json: {
      ...(results.length ? {results: structuredClone(results)} : {}),
      fieldMask: 'synthetic',
      queryResourceConsumption: '1',
      // Another page: Google names it with nextPageToken; the synthetic token never changes.
      ...(mode.paginate ? {nextPageToken: 'synthetic-next-page'} : {}),
    },
  };
}
/** The quoted resource names a GAQL query filters on. */
export const names = query => [...String(query).matchAll(/'(customers\/[^']+)'/g)].map(m => m[1]);
/**
 * The rows of `list` a query selects: when the query names resources, the rows that are one of them or point at one
 * (a parent filter such as `campaign_asset.campaign IN (...)`); otherwise every row.
 */
export function named(list = [], query) {
  const wanted = names(query);
  return wanted.length
    ? list.filter(
        row =>
          wanted.includes(row.resourceName) ||
          Object.values(row).some(v => typeof v === 'string' && wanted.includes(v)),
      )
    : list;
}
/** A search answer from `state[kind]`, filtered by the resource names the query mentions. */
export const table = (request, state = request.state) =>
  search(request, kind => named(state[kind], request.body.query));
/** The mutate collection of a `/vNN/customers/123/<collection>:mutate` path. */
export const mutateOf = path => /\/customers\/\d+\/([A-Za-z]+):mutate$/.exec(path)?.[1];
/** Google's answer to a request it rejected in part: no results and a partial failure. */
export const partialFailure = () => ({
  json: {results: [], partialFailureError: {code: 3, message: 'Synthetic partial failure', details: []}},
});
