import {bad, fingerprint, obj, type ToolCall} from './workspace-core.js';
import {collectionCheckpoint} from './report-collection-budget.js';
import {metaPrefix} from './meta-version.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';

const gateway = 'meta_native_action';
const incomplete = (message: string): never => bad(message, 'REPORT_INCOMPLETE');
const cursor = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x20\x7f]/.test(value);

/** Complete native Insights pages in a fixed account/query. No report link or link credential is followed. */
export async function collectMetaEvidence(
  store: Store,
  call: ToolCall,
  actor: Actor,
  args: JsonObject,
  semantics: JsonObject,
) {
  const account = args.account_id,
    connection = store.resolveConnection(actor, gateway, account, args.connection_id),
    authorization = fingerprint({
      credentials: store.connectionCredentials(connection),
      scopes: [...connection.scopes].sort(),
    });
  const current = () => {
    store.assertActorActive(actor);
    const c = store.resolveConnection(actor, gateway, account, connection.id);
    if (fingerprint({credentials: store.connectionCredentials(c), scopes: [...c.scopes].sort()}) !== authorization)
      bad('The Meta login or permissions changed. Capture a new report.', 'REAUTHORIZATION_REQUIRED');
    collectionCheckpoint();
  };
  const read = async (request: JsonObject) => {
    current();
    const result = await call(gateway, request, actor);
    current();
    if (result.success !== true)
      bad(result.error?.message ?? 'Meta report read failed.', result.error?.code ?? 'REPORT_FAILED');
    const data = result.data?.data;
    if (
      result.data?.executed === false ||
      result.data?.dry_run ||
      !obj(data) ||
      [result.data, data].some(
        v =>
          v.error !== undefined ||
          v.errors !== undefined ||
          v.truncated === true ||
          ['nextPageToken', 'next_page_token', 'next_cursor', 'has_more', 'hasMore', 'pagination'].some(
            k => v[k] !== undefined,
          ),
      )
    )
      incomplete('Meta returned partial or unknown report completion metadata.');
    return {
      data: data as JsonObject,
      evidence: {source_request: request, source_hash: fingerprint(result.data), captured_at: Date.now()},
    };
  };
  const checks: JsonObject[] = [];
  const verifyAccount = async () => {
    const {data, evidence} = await read({
      action: 'meta_ad_account_id_get',
      account_id: account,
      connection_id: connection.id,
      path_params: {ad_account_id: account},
      query: {fields: 'id,account_id,currency,timezone_name'},
      aggregate_pages: false,
      dry_run: false,
    });
    if (data.id !== 'act_' + account || data.account_id !== account)
      bad('Meta did not return the exact selected advertising account.', 'REPORT_ACCOUNT_MISMATCH');
    if (data.paging !== undefined || data.data !== undefined)
      incomplete('Meta did not return one complete advertising account.');
    if (data.currency !== semantics.currency)
      bad('The declared currency does not match the current Meta account.', 'REPORT_CURRENCY_MISMATCH');
    if (data.timezone_name !== semantics.timezone)
      bad('The declared timezone does not match the current Meta account.', 'REPORT_TIMEZONE_MISMATCH');
    checks.push(evidence);
  };
  await verifyAccount();
  const rows: JsonObject[] = [],
    pages: JsonObject[] = [],
    seen = new Set<string>();
  let after: string | undefined;
  for (let page = 1; page <= 100; page++) {
    const request = {...args, aggregate_pages: false, query: {...args.query, ...(after ? {after} : {})}},
      {data, evidence} = await read(request);
    if (!Array.isArray(data.data) || data.data.some((r: unknown) => !obj(r)))
      bad('Meta did not return the requested Insights row collection.', 'REPORT_SHAPE_CHANGED');
    if (data.data.length > args.query.limit)
      incomplete('Meta returned more Insights rows than the requested page limit.');
    if (rows.length + data.data.length > 10000)
      bad('Narrow the Meta report to at most 10000 rows.', 'REPORT_COLLECTION_LIMIT');
    rows.push(...data.data);
    pages.push({...evidence, page, row_count: data.data.length});
    if (data.paging !== undefined && !obj(data.paging)) incomplete('Meta returned malformed paging metadata.');
    const paging = data.paging;
    if (
      paging?.cursors !== undefined &&
      (!obj(paging.cursors) || Object.values(paging.cursors).some(value => !cursor(value)))
    )
      incomplete('Meta returned malformed report cursors.');
    if (paging?.next === undefined) break;
    if (typeof paging.next !== 'string' || !paging.next || paging.next.length > 16384 || !cursor(paging.cursors?.after))
      incomplete('Meta advertised another report page without a bounded native cursor.');
    let link: URL;
    try {
      link = new URL(paging.next);
    } catch {
      return incomplete('Meta returned a malformed report continuation link.');
    }
    if (
      link.origin !== 'https://graph.facebook.com' ||
      link.username ||
      link.password ||
      link.hash ||
      link.pathname !== metaPrefix + 'act_' + account + '/insights' ||
      link.searchParams.getAll('after').length > 1 ||
      (link.searchParams.has('after') && link.searchParams.get('after') !== paging.cursors.after)
    )
      incomplete('Meta report continuation changed the selected account, route or cursor.');
    after = paging.cursors.after;
    if (seen.has(after!)) incomplete('Meta repeated a report continuation cursor.');
    seen.add(after!);
    if (page === 100) bad('Narrow the Meta report to at most 100 pages.', 'REPORT_COLLECTION_LIMIT');
  }
  await verifyAccount();
  current();
  return {
    source: {success: true, data: {collection_kind: 'meta_insights_pages', data: {data: rows}, source_pages: pages}},
    sourcePages: pages,
    nativeAccountEvidence: {account_id: account, currency: semantics.currency, timezone: semantics.timezone, checks},
    assertCurrent: current,
  };
}
