// Contract-faithful fakes (QA-02 step 4). Provider doubles in tests used to follow the implementation's assumptions:
// they answered any request and only sent values in AMCP's preferred grammar. These helpers make a fake check what the
// pinned vendor contract says instead, through the same spec reader as PRV-05 (src/wire-contracts.ts):
//   - discoveryRequestIssues: a Google Discovery method (Google Ads, Tag Manager, GA4, DV360, ...) found by verb and
//     path in the pinned, sealed document; its required path and query parameters, unknown query parameters, and the
//     request body against the method's request schema;
//   - discoveryResponseIssues: what a fake answers, against the method's response schema, so a fake never sends a shape
//     the contract does not declare (Google Ads metrics.conversions is a double);
//   - pinnedRequestIssues: any compiled request with a pinned schema (Microsoft WSDL model, DV360, Tag Manager, ...),
//     plus the fields vendor documentation marks required where the machine-readable document does not (listed in
//     `documentedRequired`, each with its source; such a fake can be stricter than the live API, which is stated);
//   - providerDoubles and pageShapes: value and pagination generators for the shapes vendors declare (JSON doubles
//     with long fractions or exponent form; cursor, has_more, paging.next and page_info pages).
import {discoveryIssues, sealedVendorDocument, wireContractCheck} from '../../dist/src/wire-contracts.js';

/**
 * JSON doubles as a provider sends them (shortest round-trip text), with the nine-place half-to-even value owner
 * decision D10 retains and whether retaining it rounds.
 */
export const providerDoubles = Object.freeze([
  {value: 1 / 3, nine: '0.333333333', rounded: true},
  {value: 0.1 + 0.2, nine: '0.300000000', rounded: true},
  {value: 1e-7, nine: '0.000000100', rounded: false},
  {value: 2.5e-10, nine: '0.000000000', rounded: true},
  {value: 1.5e-9, nine: '0.000000002', rounded: true},
  {value: 2.5e-9, nine: '0.000000002', rounded: true},
  {value: 123456.123456789, nine: '123456.123456789', rounded: false},
  {value: 7.0000000005, nine: '7.000000000', rounded: true},
  {value: 2.5e3, nine: '2500.000000000', rounded: false},
]);

/**
 * Fields vendor documentation marks required where the pinned machine-readable document does not. The Microsoft
 * Advertising WSDL declares every request element minOccurs="0"; Microsoft Learn's Campaign Management v13 request body
 * tables mark these Required (checked 2026-10-11). The live API may accept less in some cases; a fake that refuses less
 * would hide the defect PRV-03 fixed (a GetAdsByIds verification read without AdTypes).
 */
export const documentedRequired = Object.freeze({
  microsoft_ads_native_action: {
    GetAdsByIds: ['AdGroupId', 'AdIds', 'AdTypes'],
    GetAdsByAdGroupId: ['AdGroupId', 'AdTypes'],
    AddAds: ['AdGroupId', 'Ads'],
    UpdateAds: ['AdGroupId', 'Ads'],
  },
});

const methodCache = new Map();
/** Every method of the pinned Discovery document `name`, with a matcher of its full path. */
function methods(name) {
  if (!methodCache.has(name)) {
    const pinned = sealedVendorDocument(name);
    if (!pinned) throw new Error('No pinned vendor document ' + name);
    if (!pinned.sealed) throw new Error('The pinned vendor document ' + name + ' fails its recorded digest');
    const document = pinned.envelope.document,
      found = [];
    const visit = resource => {
      for (const m of Object.values(resource.methods ?? {})) {
        const template = '/' + (document.servicePath ?? '') + (m.flatPath ?? m.path);
        found.push({
          method: m,
          pattern: new RegExp(
            '^' +
              template
                .split(/(\{[^}]+\})/)
                .map(p => (p.startsWith('{') ? '[^/:]+' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
                .join('') +
              '$',
          ),
        });
      }
      for (const nested of Object.values(resource.resources ?? {})) visit(nested);
    };
    visit(document);
    methodCache.set(name, {document, found});
  }
  return methodCache.get(name);
}
/** The pinned Discovery method of `verb` and `path`, or undefined. */
export function discoveryMethod(name, verb, path) {
  const {document, found} = methods(name),
    matches = found.filter(f => f.method.httpMethod === verb && f.pattern.test(path));
  return matches.length === 1 ? {document, method: matches[0].method} : undefined;
}
/**
 * Issues of an outgoing request against the pinned Discovery method its verb and path name: an unknown route, a
 * missing required parameter, a query parameter the method and the document's standard parameters do not declare,
 * and the body against the method's request schema. An empty list means the request conforms.
 */
export function discoveryRequestIssues(name, {method, url, body}) {
  const target = new URL(String(url)),
    found = discoveryMethod(name, method, target.pathname);
  if (!found) return [{field: '', reason: 'No pinned ' + name + ' method for ' + method + ' ' + target.pathname}];
  const issues = [],
    params = found.method.parameters ?? {},
    standard = found.document.parameters ?? {};
  for (const [key, p] of Object.entries(params))
    if (p.required && p.location === 'query' && !target.searchParams.has(key))
      issues.push({field: '?' + key, reason: 'Required query parameter missing'});
  for (const key of new Set(target.searchParams.keys()))
    if (!(params[key]?.location === 'query') && !standard[key])
      issues.push({field: '?' + key, reason: 'Query parameter absent from the pinned method'});
  if (found.method.request) {
    if (body === undefined) issues.push({field: '', reason: 'The method takes a request body'});
    else
      issues.push(
        ...discoveryIssues(found.document.schemas ?? {}, found.method.request, body, {readOnly: false, label: name}),
      );
  } else if (body !== undefined && !(body && typeof body === 'object' && !Object.keys(body).length))
    issues.push({field: '', reason: 'The method takes no request body'});
  return issues;
}
/** Issues of a fake's answer against the pinned method's response schema (output fields are allowed here). */
export function discoveryResponseIssues(name, {method, url}, answer) {
  const found = discoveryMethod(name, method, new URL(String(url)).pathname);
  if (!found?.method.response) return [{field: '', reason: 'No pinned response schema'}];
  return discoveryIssues(found.document.schemas ?? {}, found.method.response, answer, {readOnly: true, label: name});
}
/**
 * Issues of a compiled request (`CompiledRequest`) against its pinned request schema (src/wire-contracts.ts) and the
 * fields its vendor documentation marks required. Throws when the route has no pinned schema, so a fake never claims
 * a check it did not make.
 */
export function pinnedRequestIssues(plan) {
  const check = wireContractCheck(plan, 'shadow');
  if (!check) throw new Error('No pinned request schema for ' + plan.gateway + ' ' + plan.action);
  if (check.status === 'unpinned' || check.status === 'unsealed')
    throw new Error('The pinned contract of ' + plan.action + ' is ' + check.status);
  const body = plan.body && typeof plan.body === 'object' ? plan.body : {};
  return [
    ...check.issues,
    ...(documentedRequired[plan.gateway]?.[plan.action] ?? [])
      .filter(field => body[field] === undefined || body[field] === null)
      .map(field => ({field: '/' + field, reason: 'Required by the vendor documentation'})),
  ];
}

/**
 * Pages of `rows` in a provider's own pagination shape. Each page is {answer, continuation}: the provider answer,
 * and the query parameters a request for the next page must carry (undefined on the last page).
 *   meta            {data, paging: {cursors: {after}, next}}   continued by ?after=
 *   tiktok_cursor   {code, data: {list, cursor, has_more}}     continued by ?cursor= (a number, as TikTok sends)
 *   tiktok_string   the same with an opaque string cursor
 *   tiktok_page     {code, data: {list, page_info}}            continued by ?page=
 *   x               {data, next_cursor}                       continued by ?cursor=
 *   linkedin        {elements, metadata: {nextPageToken}}      continued by ?pageToken=
 */
export function pageShapes(rows, size, shape) {
  const pages = [];
  for (let start = 0; start === 0 || start < rows.length; start += size) {
    const chunk = rows.slice(start, start + size),
      index = pages.length,
      more = start + size < rows.length;
    const token = 'p' + (index + 1) + '-' + (index + 1) * 7919;
    if (shape === 'meta')
      pages.push({
        answer: {
          data: chunk,
          paging: {
            cursors: {before: 'b' + index, after: token},
            ...(more ? {next: 'https://graph.facebook.com/v26.0/next?after=' + token} : {}),
          },
        },
        continuation: more ? {after: token} : undefined,
      });
    else if (shape === 'tiktok_cursor' || shape === 'tiktok_string') {
      const cursor = shape === 'tiktok_cursor' ? start + size : token;
      pages.push({
        answer: {code: 0, message: 'OK', request_id: 'r', data: {list: chunk, cursor, has_more: more}},
        continuation: more ? {cursor: String(cursor)} : undefined,
      });
    } else if (shape === 'tiktok_page')
      pages.push({
        answer: {
          code: 0,
          message: 'OK',
          request_id: 'r',
          data: {
            list: chunk,
            page_info: {
              page: index + 1,
              page_size: size,
              total_number: rows.length,
              total_page: Math.max(1, Math.ceil(rows.length / size)),
            },
          },
        },
        continuation: more ? {page: String(index + 2)} : undefined,
      });
    else if (shape === 'x')
      pages.push({
        answer: {data: chunk, ...(more ? {next_cursor: token} : {next_cursor: null})},
        continuation: more ? {cursor: token} : undefined,
      });
    else if (shape === 'linkedin')
      pages.push({
        answer: {elements: chunk, metadata: more ? {nextPageToken: token} : {}},
        continuation: more ? {pageToken: token} : undefined,
      });
    else throw new Error('Unknown page shape ' + shape);
    if (!rows.length) break;
  }
  return pages;
}
/**
 * A fake that serves `pages` in order and refuses (throws) a request that does not continue from the page before it:
 * page n+1 is served only to a request carrying exactly the previous page's continuation parameters. `served` counts
 * the pages answered.
 */
export function pagedFake(pages) {
  const fake = {served: 0, requests: []};
  fake.answer = query => {
    fake.requests.push({...query});
    const index = fake.served;
    if (index >= pages.length) throw new Error('Request beyond the last page: ' + JSON.stringify(query));
    const expected = index === 0 ? undefined : pages[index - 1].continuation;
    for (const [key, value] of Object.entries(expected ?? {}))
      if (String(query[key]) !== value)
        throw new Error(
          'Page ' + (index + 1) + ' requested without ' + key + '=' + value + ': ' + JSON.stringify(query),
        );
    fake.served++;
    return structuredClone(pages[index].answer);
  };
  return fake;
}
