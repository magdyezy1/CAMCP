import {MirrorError} from './errors.js';
import {sha256, stable} from './security.js';
import type {CompiledRequest, JsonObject} from './types.js';

const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const incomplete = (message: string): never => {
  throw new MirrorError('REPORT_INCOMPLETE', message);
};
export const tiktokIntegratedReport = (plan: CompiledRequest) =>
  plan.gateway === 'tiktok_native_action' && plan.method === 'GET' && plan.path === '/v1.3/report/integrated/get/';

/** Validate one native page, without turning its metadata into an invented aggregate response. */
export function tiktokReportPageData(data: JsonObject, page: number, size: number) {
  const info = data.page_info;
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    !Array.isArray(data.list) ||
    data.list.length > size ||
    !object(info) ||
    info.page !== page ||
    info.page_size !== size ||
    !Number.isSafeInteger(info.total_number) ||
    info.total_number < 0 ||
    !Number.isSafeInteger(info.total_page) ||
    info.total_page < 0 ||
    (info.total_number === 0
      ? page !== 1 || data.list.length !== 0 || ![0, 1].includes(info.total_page)
      : info.total_page !== Math.ceil(info.total_number / size) ||
        page > info.total_page ||
        data.list.length !== Math.min(size, info.total_number - (page - 1) * size))
  )
    return incomplete('TikTok returned missing or inconsistent native report page counts.');
  return {
    rows: data.list as JsonObject[],
    page,
    size,
    total: info.total_number as number,
    pages: info.total_page as number,
  };
}
export function tiktokReportPage(response: unknown, query: JsonObject) {
  if (
    !object(response) ||
    response.code !== 0 ||
    !object(response.data) ||
    [response, response.data].some(
      v =>
        v.error ||
        v.errors ||
        v.truncated ||
        ['next_cursor', 'next_page_token', 'nextPageToken', 'next', 'has_more', 'hasMore', 'paging', 'pagination'].some(
          key => v[key] !== undefined,
        ),
    )
  )
    return incomplete('TikTok returned partial or unknown report completion metadata.');
  return tiktokReportPageData(response.data, query.page ?? 1, query.page_size ?? 10);
}
/** A requested native dimensional tuple, not its metric values, identifies a reporting row. */
export function tiktokReportGrain(query: JsonObject) {
  let dimensions = query.dimensions;
  if (typeof dimensions === 'string') {
    try {
      dimensions = JSON.parse(dimensions);
    } catch {
      dimensions = undefined;
    }
  }
  if (
    !Array.isArray(dimensions) ||
    !dimensions.length ||
    dimensions.some(v => typeof v !== 'string' || !v) ||
    new Set(dimensions).size !== dimensions.length
  )
    throw new MirrorError('REPORT_SHAPE_CHANGED', 'TikTok aggregation requires explicit unique native dimensions.');
  return [...dimensions].sort() as string[];
}
export function tiktokReportRowKey(row: unknown, dimensions: string[]) {
  if (
    !object(row) ||
    !object(row.dimensions) ||
    !object(row.metrics) ||
    Object.keys(row.dimensions).length !== dimensions.length ||
    dimensions.some(
      k =>
        !Object.hasOwn(row.dimensions, k) ||
        (row.dimensions[k] !== null &&
          typeof row.dimensions[k] !== 'string' &&
          !Number.isSafeInteger(row.dimensions[k])),
    )
  )
    throw new MirrorError('REPORT_SHAPE_CHANGED', 'TikTok returned a different or malformed native dimensional grain.');
  return sha256(stable(dimensions.map(key => (row.dimensions[key] === null ? null : String(row.dimensions[key])))));
}
