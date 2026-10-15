import {bad, fingerprint, obj, type ToolCall} from './workspace-core.js';
import {normalizeAccount} from './scope.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import type {Actor, JsonObject} from './types.js';
import type {Store} from './store.js';
import {storedLogin} from './connection-authority.js';
import {MirrorError} from './errors.js';
import {accessRefusalCodes} from './overview-parents.js';

const gateway = 'google_ads_native_action';
/**
 * Two complete observations of the selected dedicated budgets; not an atomic account snapshot. With `window` (the
 * allocation evidence period, preview only) it also reads each campaign's Search budget-lost impression share over that
 * window once (DEC-02 indicator): descriptive, never a gate, and unavailable rather than failing when Google refuses it.
 */
export async function googleAllocationBudgets(
  store: Store,
  call: ToolCall,
  actor: Actor,
  source: JsonObject,
  ids: string[],
  window?: {since: string; until: string},
) {
  const account = normalizeAccount(gateway, source.account_id),
    connection = store.resolveConnection(actor, gateway, account, source.connection_id),
    authorization = fingerprint(storedLogin(store, connection));
  if (!ids.length || ids.length > 50 || ids.some(id => !/^[0-9]{1,40}$/.test(id)) || new Set(ids).size !== ids.length)
    bad('Select 1–50 distinct native Google campaign IDs.', 'ALLOCATION_BUDGET_CHANGED');
  const current = () => {
    store.assertActorActive(actor);
    const c = store.resolveConnection(actor, gateway, account, connection.id);
    if (connection.scopes.some(s => !c.scopes.includes(s)))
      bad('The selected login lost permissions. Preview the allocation again.', 'INSUFFICIENT_SCOPE');
    if (fingerprint(storedLogin(store, c)) !== authorization)
      bad('The selected login changed. Preview the allocation again.', 'CONNECTION_AUTHORITY_CHANGED');
  };
  const query =
      'SELECT customer.id, customer.currency_code, customer.time_zone, campaign.id, campaign.resource_name, campaign.status, campaign.campaign_budget, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.reference_count, campaign_budget.period, campaign_budget.status FROM campaign WHERE campaign.id IN (' +
      ids.join(',') +
      ') ORDER BY campaign.id',
    args = {
      action: 'google_ads_v23_google_ads_search',
      account_id: account,
      connection_id: connection.id,
      payload: {query},
      aggregate_pages: false,
      dry_run: false,
    },
    references: JsonObject[] = [],
    bound = new ReportCollectionBudget(undefined, fingerprint({account, ids, authorization}), () => {}, {
      requests: 10,
      rows: 100,
      elapsed_ms: 60000,
      bytes: 2 * 1024 * 1024,
    });
  const read = async (observation: number) => {
    current();
    const requested_at = Date.now(),
      response = await call(gateway, args, actor);
    current();
    if (!response.success)
      bad(
        response.error?.message ?? 'Current campaign budgets could not be read.',
        response.error?.code ?? 'ALLOCATION_BUDGET_UNAVAILABLE',
      );
    const data = response.data?.data,
      rows = data?.results;
    if (
      !obj(data) ||
      !Array.isArray(rows) ||
      rows.length !== ids.length ||
      response.data?.truncated ||
      data.nextPageToken ||
      data.next_page_token ||
      data.truncated === true ||
      data.partial === true ||
      data.partialFailureError ||
      data.error !== undefined ||
      data.errors !== undefined
    )
      bad('Retain one complete current budget row per selected campaign.', 'ALLOCATION_BUDGET_CHANGED');
    bound.rows('budgets:' + observation, rows.length);
    const seen = new Set(),
      resources = new Set();
    const targets = rows.map((row: JsonObject) => {
      const c = row?.campaign,
        b = row?.campaignBudget,
        u = row?.customer;
      // ProtoJSON may omit false scalars. Non-default period, count, identity and currency stay explicit.
      if (
        !obj(c) ||
        !obj(b) ||
        !obj(u) ||
        !ids.includes(c.id) ||
        seen.has(c.id) ||
        u.id !== account ||
        u.currencyCode !== source.currency ||
        u.timeZone !== source.timezone ||
        c.resourceName !== 'customers/' + account + '/campaigns/' + c.id ||
        !['ENABLED', 'PAUSED'].includes(c.status) ||
        typeof b.resourceName !== 'string' ||
        !new RegExp('^customers/' + account + '/campaignBudgets/[0-9]+$').test(b.resourceName) ||
        c.campaignBudget !== b.resourceName ||
        resources.has(b.resourceName) ||
        b.explicitlyShared === true ||
        (b.explicitlyShared !== undefined && b.explicitlyShared !== false) ||
        String(b.referenceCount) !== '1' ||
        b.period !== 'DAILY' ||
        b.status !== 'ENABLED' ||
        typeof b.amountMicros !== 'string' ||
        !/^\d+$/.test(b.amountMicros) ||
        BigInt(b.amountMicros) <= 0n ||
        BigInt(b.amountMicros) > BigInt(Number.MAX_SAFE_INTEGER)
      )
        bad(
          'Use current, dedicated daily budgets in the report account, currency and timezone. Shared, lifetime, removed or ambiguous budgets need their own native review.',
          'ALLOCATION_BUDGET_CHANGED',
        );
      seen.add(c.id);
      resources.add(b.resourceName);
      const state = {
        campaign_id: c.id,
        campaign_resource: c.resourceName,
        campaign_status: c.status,
        budget_resource: b.resourceName,
        amount_micros: b.amountMicros,
        currency: u.currencyCode,
        timezone: u.timeZone,
        period: b.period,
        reference_count: 1,
        explicitly_shared: false,
      };
      return {...state, native_signature: fingerprint(state)};
    });
    references.push({source_request: args, source_hash: fingerprint(data), requested_at, captured_at: Date.now()});
    return targets;
  };
  /**
   * Google reports search_budget_lost_impression_share from 0 to 0.9 and any higher share as 0.9001. A campaign Google
   * omits (no impressions in the window) or that is not a Search campaign has no value; nothing is guessed.
   */
  const budgetLost = async (period: {since: string; until: string}) => {
    if (![period.since, period.until].every(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)))
      return {status: 'unavailable', campaigns: {}, reference: null};
    const indicator = {
        ...args,
        payload: {
          query:
            'SELECT campaign.id, campaign.advertising_channel_type, metrics.search_budget_lost_impression_share FROM campaign WHERE campaign.id IN (' +
            ids.join(',') +
            ") AND segments.date BETWEEN '" +
            period.since +
            "' AND '" +
            period.until +
            "'",
        },
      },
      requested_at = Date.now();
    current();
    let response: JsonObject;
    try {
      response = await call(gateway, indicator, actor);
    } catch (e) {
      // A provider refusal or failure leaves this descriptive indicator unavailable; AMCP's own access refusals do not.
      if (!(e instanceof MirrorError) || accessRefusalCodes.has(e.code)) throw e;
      current();
      return {status: 'unavailable', campaigns: {}, reference: null};
    }
    current();
    const data = response.data?.data,
      rows = data?.results,
      reference = {
        source_request: indicator,
        source_hash: fingerprint(data ?? null),
        requested_at,
        captured_at: Date.now(),
      },
      unavailable = {status: 'unavailable', campaigns: {}, reference: response.success ? reference : null};
    if (
      !response.success ||
      !obj(data) ||
      !Array.isArray(rows) ||
      rows.length > ids.length ||
      response.data?.truncated ||
      data.nextPageToken
    )
      return unavailable;
    const campaigns: Record<string, JsonObject> = {};
    for (const row of rows) {
      const c = row?.campaign,
        share = row?.metrics?.searchBudgetLostImpressionShare;
      if (!obj(c) || typeof c.id !== 'string' || !ids.includes(c.id) || campaigns[c.id]) return unavailable;
      campaigns[c.id] =
        c.advertisingChannelType !== 'SEARCH'
          ? {status: c.advertisingChannelType === undefined ? 'not_reported' : 'not_search'}
          : typeof share === 'number' && Number.isFinite(share) && share >= 0 && share <= 1
            ? {status: 'read', share: String(share), above_90_percent: share > 0.9}
            : {status: 'not_reported'};
    }
    for (const id of ids) campaigns[id] ??= {status: 'not_reported'};
    return {status: 'read', campaigns, reference};
  };
  try {
    return await bound.run(async () => {
      const first = await read(1),
        second = await read(2);
      if (
        first.some(
          before =>
            second.find(after => after.campaign_id === before.campaign_id)?.native_signature !==
            before.native_signature,
        )
      )
        bad(
          'Google campaign budgets or account metadata changed during allocation inspection. Preview again.',
          'ALLOCATION_BUDGET_CHANGED',
        );
      current();
      const indicators = window ? await budgetLost(window) : undefined;
      return {targets: first, source_references: references, ...(indicators ? {search_budget_lost: indicators} : {})};
    });
  } finally {
    bound.close();
  }
}
