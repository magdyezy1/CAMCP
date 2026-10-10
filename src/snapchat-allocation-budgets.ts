import {bad, fingerprint, obj, type ToolCall} from './workspace-core.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {snapchatNextCursor, snapchatReportId} from './snapchat-evidence.js';
import type {Actor, JsonObject} from './types.js';
import {snapchatScope} from './provider-grants.js';
import type {Store} from './store.js';
import {storedLogin} from './connection-authority.js';

const gateway = 'snapchat_native_action';
const invalid = (message: string): never => bad(message, 'ALLOCATION_BUDGET_CHANGED');
const success = (v: unknown) => typeof v === 'string' && v.toUpperCase() === 'SUCCESS';
function nativeMoney(v: unknown): bigint {
  if (!(
    (typeof v === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(v)) ||
    (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)
  ))
    invalid('Retain exact nonnegative Snapchat budget micros.');
  const n = BigInt(v as string | number);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) invalid('The native budget exceeds the exact review integer limit.');
  return n;
}
/** Positive account-edge ownership and bracketed exact reads; never a complete or atomic account inventory. */
export async function snapchatAllocationBudgets(
  store: Store,
  call: ToolCall,
  actor: Actor,
  source: JsonObject,
  ids: string[],
) {
  const account = source.account_id,
    parentId = source.parent_campaign_id;
  if (!snapchatReportId(account) || !snapchatReportId(parentId) || ids.some(id => !snapchatReportId(id)))
    invalid('Retain exact Snapchat account, campaign and ad-squad identities.');
  const connection = store.resolveConnection(actor, gateway, account, source.connection_id),
    authorization = fingerprint(storedLogin(store, connection));
  const current = () => {
    store.assertActorActive(actor);
    const c = store.resolveConnection(actor, gateway, account, connection.id);
    if (!c.scopes.includes(snapchatScope))
      bad('This login requires Snapchat Marketing API permission.', 'INSUFFICIENT_SCOPE');
    if (fingerprint(storedLogin(store, c)) !== authorization)
      bad('The selected login changed. Preview the allocation again.', 'CONNECTION_AUTHORITY_CHANGED');
  };
  const budget = new ReportCollectionBudget(undefined, fingerprint({account, parentId, ids}), () => {}, {
      requests: 120,
      rows: 10000,
      bytes: 8 * 1024 * 1024,
      elapsed_ms: 60000,
    }),
    references: JsonObject[] = [];
  const read = async (action: string, path_params: JsonObject, query: JsonObject = {}) => {
    current();
    const args = {
        action,
        account_id: account,
        connection_id: connection.id,
        path_params,
        query,
        aggregate_pages: false,
        dry_run: false,
      },
      requested_at = Date.now();
    const response = await call(gateway, args, actor);
    current();
    if (!response.success)
      bad(
        response.error?.message ?? 'Current Snapchat budgets could not be read.',
        response.error?.code ?? 'ALLOCATION_BUDGET_UNAVAILABLE',
      );
    const d = response.data?.data;
    if (
      response.data?.truncated ||
      !obj(d) ||
      !success(d.request_status) ||
      d.error !== undefined ||
      d.errors !== undefined ||
      d.truncated ||
      d.partial === true ||
      ['next_cursor', 'nextPageToken', 'pagination', 'has_more'].some(k => d[k] !== undefined)
    )
      invalid('Snapchat returned failed, incomplete or ambiguous budget evidence.');
    references.push({source_request: args, source_hash: fingerprint(d), requested_at, captured_at: Date.now()});
    return d;
  };
  const unwrap = (d: JsonObject, group: string, max: number) => {
    if (!Array.isArray(d[group]) || d[group].length > max) invalid('Retain bounded native ownership rows.');
    const seen = new Set<string>();
    return d[group].map((wrapper: unknown) => {
      if (
        !obj(wrapper) ||
        !success(wrapper.sub_request_status) ||
        wrapper.error !== undefined ||
        wrapper.errors !== undefined ||
        !obj(wrapper[group.slice(0, -1)])
      )
        invalid('Snapchat returned failed or malformed ownership evidence.');
      const row = (wrapper as JsonObject)[group.slice(0, -1)];
      if (
        !snapchatReportId(row.id) ||
        seen.has(row.id) ||
        (row.ad_account_id !== undefined && row.ad_account_id !== account)
      )
        invalid('Snapchat returned duplicate, malformed or foreign ownership evidence.');
      seen.add(row.id);
      return row as JsonObject;
    });
  };
  const one = async (action: string, path: JsonObject, group: string, id: string) => {
    const d = await read(action, path),
      rows = unwrap(d, group, 1);
    if (rows.length !== 1 || rows[0]!.id !== id || snapchatNextCursor(d, '/v1/' + group + '/' + id, {}))
      invalid('Snapchat did not return the exact complete native resource.');
    return rows[0]!;
  };
  const establish = async (group: 'campaigns' | 'adsquads', wanted: string[]) => {
    const path = '/v1/adaccounts/' + account + '/' + group,
      query = {limit: 100, sort: 'created_at-desc'},
      missing = new Set(wanted),
      seen = new Set<string>(),
      rowIds = new Set<string>();
    let cursor: string | undefined;
    for (let page = 1; page <= 100; page++) {
      const d = await read(
          group === 'campaigns' ? 'snapchat_campaign_list' : 'snapchat_adsquad_list',
          {ad_account_id: account},
          {...query, ...(cursor ? {cursor} : {})},
        ),
        rows = unwrap(d, group, 100),
        next = snapchatNextCursor(d, path, query);
      for (const row of rows) {
        if (rowIds.has(row.id)) invalid('Snapchat repeated an ownership row across pages.');
        rowIds.add(row.id);
        if (group === 'campaigns' && row.ad_account_id !== account) invalid('Retain an exact matching campaign owner.');
        missing.delete(row.id);
      }
      if (!missing.size) return;
      if (next === undefined) break;
      if (!rows.length || seen.has(next) || page === 100)
        invalid('Snapchat ownership lookup repeated or exceeded its bounded pages.');
      seen.add(next);
      cursor = next;
    }
    invalid('Every selected resource must be observed in this account collection.');
  };
  const accountState = async () => {
    const row = await one('snapchat_account_get', {ad_account_id: account}, 'adaccounts', account);
    if (row.currency !== source.currency || row.timezone !== source.timezone)
      invalid('Current Snapchat currency/timezone differs from the allocation evidence.');
    return {id: row.id, currency: row.currency, timezone: row.timezone};
  };
  const parentState = async () => {
    const row = await one('snapchat_campaign_get', {campaign_id: parentId}, 'campaigns', parentId);
    if (
      row.ad_account_id !== account ||
      !['ACTIVE', 'PAUSED'].includes(row.status) ||
      row.buy_model !== 'AUCTION' ||
      row.pacing_level !== 'AD_SQUAD' ||
      row.shared_properties != null ||
      row.reserved_type != null ||
      (row.daily_budget_micro != null && nativeMoney(row.daily_budget_micro) !== 0n)
    )
      invalid(
        'Use an owned auction campaign with ad-squad pacing; campaign-level, shared and reserved budgets need their separate planning flow.',
      );
    return {
      id: row.id,
      ad_account_id: row.ad_account_id,
      status: row.status,
      buy_model: row.buy_model,
      pacing_level: row.pacing_level,
    };
  };
  const squadState = async (id: string, parent: JsonObject) => {
    const row = await one('snapchat_adsquad_get', {ad_squad_id: id}, 'adsquads', id),
      amount = nativeMoney(row.daily_budget_micro);
    if (
      row.campaign_id !== parentId ||
      !['ACTIVE', 'PAUSED'].includes(row.status) ||
      row.delivery_constraint !== 'DAILY_BUDGET' ||
      amount < 5000000n ||
      (row.lifetime_budget_micro != null && nativeMoney(row.lifetime_budget_micro) !== 0n) ||
      row.campaign_budget_optimization_properties != null
    )
      invalid(
        'Use an owned ad squad with an explicit daily budget, without lifetime or campaign budget optimization settings.',
      );
    const state = {
      entity_id: id,
      campaign_id: parentId,
      budget_resource: '/v1/campaigns/' + parentId + '/adsquads/' + id,
      amount_micros: String(amount),
      currency: source.currency,
      timezone: source.timezone,
      status: row.status,
      delivery_constraint: row.delivery_constraint,
      parent,
    };
    return {...state, native_signature: fingerprint(state)};
  };
  try {
    return await budget.run(async () => {
      const accountBefore = await accountState();
      await establish('campaigns', [parentId]);
      const parentBefore = await parentState();
      await establish('adsquads', ids);
      const targets: JsonObject[] = [];
      for (const id of ids) targets.push(await squadState(id, parentBefore));
      for (const target of targets)
        if ((await squadState(target.entity_id, parentBefore)).native_signature !== target.native_signature)
          invalid('Snapchat ad-squad budgets changed during allocation inspection. Preview again.');
      if (
        fingerprint(await parentState()) !== fingerprint(parentBefore) ||
        fingerprint(await accountState()) !== fingerprint(accountBefore)
      )
        invalid('Snapchat parent or account metadata changed during allocation inspection.');
      current();
      return {targets, source_references: references};
    });
  } finally {
    budget.close();
  }
}
