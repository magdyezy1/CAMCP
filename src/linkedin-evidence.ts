import {bad, fingerprint, obj, type ToolCall} from './workspace-core.js';
import {collectionCheckpoint} from './report-collection-budget.js';
import {linkedInAnalyticsRows} from './linkedin-reporting.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {storedLogin} from './connection-authority.js';

const gateway = 'linkedin_native_action';
const incomplete = (message: string): never => bad(message, 'REPORT_INCOMPLETE');

/** A single native analytics response, bracketed by current account and authorization checks. */
export async function collectLinkedInEvidence(
  store: Store,
  call: ToolCall,
  actor: Actor,
  args: JsonObject,
  semantics: JsonObject,
  validateRows: (rows: JsonObject[]) => void,
) {
  const account = args.account_id,
    connection = store.resolveConnection(actor, gateway, account, args.connection_id),
    authorization = fingerprint({
      login: storedLogin(store, connection),
      scopes: [...connection.scopes].sort(),
    });
  const current = () => {
    store.assertActorActive(actor);
    const c = store.resolveConnection(actor, gateway, account, connection.id);
    if (fingerprint({login: storedLogin(store, c), scopes: [...c.scopes].sort()}) !== authorization)
      bad('The LinkedIn login or permissions changed. Capture a new report.', 'CONNECTION_AUTHORITY_CHANGED');
    collectionCheckpoint();
  };
  const read = async (request: JsonObject) => {
    current();
    const result = await call(gateway, request, actor);
    current();
    if (result.success !== true)
      bad(result.error?.message ?? 'LinkedIn report read failed.', result.error?.code ?? 'REPORT_FAILED');
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
            key => v[key] !== undefined,
          ),
      )
    )
      incomplete('LinkedIn returned partial or unknown report completion metadata.');
    return {
      result,
      data: data as JsonObject,
      evidence: {source_request: request, source_hash: fingerprint(result.data), captured_at: Date.now()},
    };
  };
  const checks: JsonObject[] = [];
  const verifyAccount = async () => {
    const {data, evidence} = await read({
      action: 'linkedin_rest_ad_accounts_ad_account_id_get',
      account_id: account,
      connection_id: connection.id,
      path_params: {ad_account_id: account},
      aggregate_pages: false,
      dry_run: false,
    });
    const id = typeof data.id === 'number' && Number.isSafeInteger(data.id) && data.id > 0 ? String(data.id) : data.id;
    if (typeof id !== 'string' || !/^[1-9][0-9]{0,31}$/.test(id) || id !== account)
      bad('LinkedIn did not return the exact selected advertising account.', 'REPORT_ACCOUNT_MISMATCH');
    if (['paging', 'elements', 'data', 'metadata'].some(key => data[key] !== undefined))
      incomplete('LinkedIn did not return one complete advertising account.');
    if (data.currency !== semantics.currency)
      bad('The declared currency does not match the current LinkedIn account.', 'REPORT_CURRENCY_MISMATCH');
    checks.push(evidence);
  };
  await verifyAccount();
  const request = {...args, aggregate_pages: false},
    response = await read(request),
    rows = linkedInAnalyticsRows(response.data);
  if (rows.length > 10000) bad('Narrow the LinkedIn report to at most 10000 rows.', 'REPORT_COLLECTION_LIMIT');
  validateRows(rows);
  await verifyAccount();
  current();
  return {
    source: response.result,
    sourcePages: [{...response.evidence, page: 1, row_count: rows.length}],
    nativeAccountEvidence: {account_id: account, currency: semantics.currency, ...checks[0], checks},
    assertCurrent: current,
  };
}
