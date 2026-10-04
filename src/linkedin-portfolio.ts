import {createHmac, timingSafeEqual} from 'node:crypto';
import {bad, fingerprint, obj, validate, type ToolCall} from './workspace-core.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {linkedinVersion} from './linkedin-version.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';

const gateway = 'linkedin_native_action';
const groupStatuses = ['ACTIVE', 'ARCHIVED', 'CANCELED', 'DRAFT', 'PAUSED', 'PENDING_DELETION', 'REMOVED'];
const invalid = (message: string): never => bad(message, 'PORTFOLIO_INVALID_RESPONSE');
const idString = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
function nativeId(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (idString(value)) return value;
  return invalid('LinkedIn returned an inexact or malformed native entity ID.');
}
function text(value: unknown, limit = 2000) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > limit) invalid('LinkedIn returned a malformed text field.');
  return value as string;
}
const token = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u0020\u007f]/.test(value);
const sign = (value: JsonObject, key: string) => createHmac('sha256', key).update(fingerprint(value)).digest('hex');
const observation = (entity: string, id: string) => 'portfolio/linkedin/' + entity + '/' + id;
function amount(value: unknown, currency: string | null) {
  if (value === undefined || value === null) return null;
  if (
    !obj(value) ||
    typeof value.amount !== 'string' ||
    !/^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,18})?$/.test(value.amount) ||
    typeof value.currencyCode !== 'string' ||
    !/^[A-Z]{3}$/.test(value.currencyCode) ||
    (currency && value.currencyCode !== currency)
  )
    invalid('LinkedIn returned money without an exact nonnegative decimal and matching native currency.');
  const money = value as JsonObject;
  return {amount: money.amount, currencyCode: money.currencyCode};
}

/** An inventory observation of budget controls, never effective spend or write eligibility. */
function budgetContext(row: JsonObject, entity: string, parent: JsonObject | undefined, currency: string | null) {
  const group = entity === 'campaign_group' ? row : parent;
  if (!group) return {mode: 'unknown'};
  const strategy = obj(group.budgetOptimization)
      ? text(group.budgetOptimization.budgetOptimizationStrategy, 100)
      : null,
    daily = amount(group.dailyBudget, currency),
    total = amount(group.totalBudget, currency),
    unknownGroup = Object.keys(group).some(
      k => /budget|pacing/i.test(k) && !['dailyBudget', 'totalBudget', 'budgetOptimization'].includes(k),
    );
  let mode = 'unknown';
  if (strategy === 'DYNAMIC') mode = 'group_dynamic';
  else if (!unknownGroup && group.budgetOptimization === undefined && group.dailyBudget === undefined) {
    if (entity === 'campaign_group') mode = total ? 'group_total' : 'unknown';
    else if (
      row.pacingStrategy === undefined &&
      !Object.keys(row).some(k => /budget|pacing/i.test(k) && !['dailyBudget', 'totalBudget'].includes(k))
    ) {
      if (row.dailyBudget != null && row.totalBudget != null) mode = 'campaign_daily_and_total';
      else if (row.dailyBudget != null) mode = 'campaign_daily';
      else if (row.totalBudget != null) mode = 'campaign_total';
    }
  }
  return {
    mode,
    group_id: nativeId(group.id),
    optimization_strategy: strategy,
    group_daily_budget: daily,
    group_total_budget: total,
    campaign_pacing: entity === 'campaign' ? text(row.pacingStrategy, 100) : null,
    observed_at: Date.now(),
  };
}

/** Native account paths, current parent reads and scoped cursor continuations; never an advertising mutation. */
export async function linkedinPortfolioPage(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  const config = input.requirements ?? {};
  validate(config, ['entity', 'campaign_group_id', 'campaign_id']);
  const entity = config.entity ?? 'campaign_group',
    limit = input.limit ?? 50,
    account = input.account_id;
  if (!['campaign_group', 'campaign', 'creative'].includes(entity))
    bad('For LinkedIn choose campaign_group, campaign or creative.');
  if (!idString(account)) bad('Choose the exact numeric LinkedIn ad account ID.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) bad('Portfolio pages contain 1–100 entities.');
  if (
    (entity === 'campaign_group' && (config.campaign_group_id !== undefined || config.campaign_id !== undefined)) ||
    (entity !== 'campaign_group' && !idString(config.campaign_group_id)) ||
    (entity === 'creative' && !idString(config.campaign_id)) ||
    (entity === 'campaign' && config.campaign_id !== undefined)
  )
    bad('Choose an exact parent campaign group, and for creatives its exact campaign.');
  const connection = store.resolveConnection(actor, gateway, account, input.connection_id);
  const authorization = fingerprint(store.connectionCredentials(connection)),
    version = linkedinVersion();
  const current = () => {
    const active = store.resolveConnection(actor, gateway, account, connection.id);
    if (!active.scopes.some(scope => scope === 'r_ads' || scope === 'rw_ads'))
      bad('The selected login requires LinkedIn advertising read permission.', 'INSUFFICIENT_SCOPE');
    if (fingerprint(store.connectionCredentials(active)) !== authorization)
      bad('The selected login changed. Restart the portfolio read.', 'REAUTHORIZATION_REQUIRED');
    return active;
  };
  current();
  const binding = fingerprint({
    tenant: actor.tenantId,
    user: actor.userId,
    gateway,
    version,
    account,
    connection: connection.id,
    entity,
    config,
    limit,
    authorization,
  });
  let after: string | undefined,
    page = 0,
    expires = Date.now() + 300000,
    lastId: string | null = null,
    seen: string[] = [];
  if (input.cursor !== undefined) {
    try {
      if (typeof input.cursor !== 'string' || input.cursor.length > 24000 || !/^[A-Za-z0-9_-]+$/.test(input.cursor))
        throw Error();
      const decoded = Buffer.from(input.cursor, 'base64url');
      if (decoded.toString('base64url') !== input.cursor) throw Error();
      const parsed = JSON.parse(decoded.toString('utf8'));
      if (!obj(parsed)) throw Error();
      const {signature, ...signed} = parsed;
      if (
        typeof signature !== 'string' ||
        !/^[a-f0-9]{64}$/.test(signature) ||
        !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(signed, authorization), 'hex')) ||
        parsed.version !== 1 ||
        parsed.binding !== binding ||
        !token(parsed.after) ||
        !Number.isSafeInteger(parsed.page) ||
        parsed.page < 1 ||
        parsed.page >= 100 ||
        !Number.isSafeInteger(parsed.expires_at) ||
        parsed.expires_at <= Date.now() ||
        parsed.expires_at > Date.now() + 300000 ||
        !(parsed.last_id === null || idString(parsed.last_id)) ||
        !Array.isArray(parsed.seen) ||
        parsed.seen.length !== parsed.page ||
        !parsed.seen.every((s: unknown) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)) ||
        new Set(parsed.seen).size !== parsed.seen.length ||
        parsed.seen.at(-1) !== fingerprint(parsed.after)
      )
        throw Error();
      after = parsed.after;
      page = parsed.page;
      expires = parsed.expires_at;
      lastId = parsed.last_id;
      seen = parsed.seen;
    } catch {
      bad(
        'Restart the exact account, login, hierarchy and page size; this cursor is invalid or expired.',
        'INVALID_CURSOR',
      );
    }
  }
  const parents: [string, string][] = [
    ...(entity !== 'campaign_group' ? [['campaign_group', config.campaign_group_id] as [string, string]] : []),
    ...(entity === 'creative' ? [['campaign', config.campaign_id] as [string, string]] : []),
  ];
  const assertParents = () => {
    const active = current();
    for (const [kind, id] of parents)
      if (!store.ownsResource(active, account, observation(kind, id)))
        bad(
          'Read this parent in the same account/login portfolio first. Parent observations last five minutes.',
          'RESOURCE_SCOPE_REQUIRED',
        );
    return active;
  };
  assertParents();
  const budget = new ReportCollectionBudget(undefined, binding, () => {}, {
    requests: 8,
    rows: 100,
    bytes: 8 * 1024 * 1024,
    elapsed_ms: 60000,
  });
  const read = async (action: string, path: JsonObject, query: JsonObject = {}) => {
    current();
    const response = await call(
      gateway,
      {
        action,
        account_id: account,
        connection_id: connection.id,
        api_version: version,
        path_params: path,
        query,
        dry_run: false,
      },
      actor,
    );
    current();
    if (!response.success)
      bad(response.error?.message ?? 'LinkedIn inventory read failed.', response.error?.code ?? 'PORTFOLIO_FAILED');
    const body = response.data?.data;
    if (response.data?.truncated || !obj(body) || body.serviceErrorCode !== undefined || body.truncated === true)
      invalid('LinkedIn returned an incomplete or malformed inventory response.');
    return body as JsonObject;
  };
  const urn = 'urn:li:sponsoredAccount:' + account;
  try {
    return await budget.run(async () => {
      const accountRow = await read('linkedin_rest_ad_accounts_ad_account_id_get', {ad_account_id: account});
      if (nativeId(accountRow.id) !== account)
        bad('LinkedIn returned a different ad account.', 'STATE_TARGET_MISMATCH');
      const currency = text(accountRow.currency, 3);
      if (currency !== null && !/^[A-Z]{3}$/.test(currency)) invalid('LinkedIn returned an invalid account currency.');
      let currentGroup: JsonObject | undefined;
      for (const [kind, id] of parents) {
        const parent = await read(
          kind === 'campaign_group'
            ? 'linkedin_rest_ad_accounts_ad_account_id_ad_campaign_groups_ad_campaign_groups_id_get'
            : 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_campaign_id_get',
          {ad_account_id: account, [kind === 'campaign_group' ? 'ad_campaign_groups_id' : 'campaign_id']: id},
        );
        if (
          nativeId(parent.id) !== id ||
          parent.account !== urn ||
          (kind === 'campaign' && parent.campaignGroup !== 'urn:li:sponsoredCampaignGroup:' + config.campaign_group_id)
        )
          bad('LinkedIn returned a different parent account or hierarchy.', 'STATE_TARGET_MISMATCH');
        if (kind === 'campaign_group') {
          budgetContext(parent, 'campaign_group', undefined, currency);
          currentGroup = parent;
        }
      }
      const query: JsonObject = {
        q: entity === 'creative' ? 'criteria' : 'search',
        pageSize: limit,
        sortOrder: 'ASCENDING',
        ...(after ? {pageToken: after} : {}),
      };
      if (entity === 'campaign_group') query.search = {status: {values: groupStatuses}};
      else if (entity === 'campaign')
        query.search = {campaignGroup: {values: ['urn:li:sponsoredCampaignGroup:' + config.campaign_group_id]}};
      else query.campaigns = ['urn:li:sponsoredCampaign:' + config.campaign_id];
      const body = await read(
        entity === 'campaign_group'
          ? 'linkedin_rest_ad_accounts_ad_account_id_ad_campaign_groups_get'
          : entity === 'campaign'
            ? 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_get'
            : 'linkedin_rest_ad_accounts_ad_account_id_creatives_get',
        {ad_account_id: account},
        query,
      );
      if (
        !Array.isArray(body.elements) ||
        body.elements.length > limit ||
        body.paging !== undefined ||
        (body.metadata !== undefined && !obj(body.metadata))
      )
        invalid('LinkedIn did not return a bounded cursor-based inventory page.');
      budget.rows('entities', body.elements.length);
      const rows = (body.elements as JsonObject[]).map(row => {
        if (!obj(row)) invalid('LinkedIn returned an invalid inventory row.');
        const id =
          entity === 'creative'
            ? (/^urn:li:sponsoredCreative:([1-9][0-9]{0,19})$/.exec(String(row.id))?.[1] ??
              invalid('LinkedIn returned a malformed creative URN.'))
            : nativeId(row.id);
        if (lastId && BigInt(id) <= BigInt(lastId))
          invalid('LinkedIn returned repeated or unordered entity IDs. Restart inventory if it changed.');
        lastId = id;
        if (
          row.account !== urn ||
          (entity === 'campaign' &&
            row.campaignGroup !== 'urn:li:sponsoredCampaignGroup:' + config.campaign_group_id) ||
          (entity === 'creative' && row.campaign !== 'urn:li:sponsoredCampaign:' + config.campaign_id)
        )
          bad('LinkedIn inventory did not retain the selected account and parent.', 'STATE_TARGET_MISMATCH');
        if (row.isServing !== undefined && typeof row.isServing !== 'boolean')
          invalid('LinkedIn returned an invalid serving state.');
        if (
          row.servingHoldReasons !== undefined &&
          (!Array.isArray(row.servingHoldReasons) ||
            row.servingHoldReasons.length > 50 ||
            row.servingHoldReasons.some((v: unknown) => typeof v !== 'string' || v.length > 100))
        )
          invalid('LinkedIn returned malformed serving hold reasons.');
        const moneyFields =
          entity === 'campaign_group'
            ? ['dailyBudget', 'totalBudget']
            : entity === 'campaign'
              ? ['dailyBudget', 'totalBudget', 'unitCost']
              : [];
        const nativeMoney = Object.fromEntries(moneyFields.map(key => [key, amount(row[key], currency)]));
        const native: JsonObject = {
          id: entity === 'creative' ? row.id : id,
          account: urn,
          name: text(row.name),
          ...(entity === 'campaign_group'
            ? {}
            : entity === 'campaign'
              ? {campaignGroup: row.campaignGroup, objectiveType: text(row.objectiveType, 100)}
              : {campaign: row.campaign}),
          [entity === 'creative' ? 'intendedStatus' : 'status']: text(
            entity === 'creative' ? row.intendedStatus : row.status,
            100,
          ),
          ...nativeMoney,
          ...(entity === 'creative'
            ? {isServing: row.isServing ?? null, servingHoldReasons: row.servingHoldReasons ?? []}
            : {}),
        };
        return {
          id,
          name: native.name ?? String(native.id),
          entity,
          status: native[entity === 'creative' ? 'intendedStatus' : 'status'],
          campaign_group_id: entity === 'campaign_group' ? id : config.campaign_group_id,
          campaign_id: entity === 'campaign' ? id : (config.campaign_id ?? null),
          resource_name:
            entity === 'creative'
              ? row.id
              : 'urn:li:' + (entity === 'campaign_group' ? 'sponsoredCampaignGroup:' : 'sponsoredCampaign:') + id,
          currency,
          timezone: null,
          native_money: nativeMoney,
          ...(entity === 'creative' ? {} : {budget_context: budgetContext(row, entity, currentGroup, currency)}),
          is_serving: entity === 'creative' ? (row.isServing ?? null) : null,
          serving_hold_reasons: entity === 'creative' ? (row.servingHoldReasons ?? []) : [],
          native,
        };
      });
      const next = body.metadata?.nextPageToken,
        more = next !== undefined && next !== null;
      if (more && (!token(next) || seen.includes(fingerprint(next)) || page + 1 >= 100))
        invalid('LinkedIn continuation is malformed, repeated or exceeds 100 pages. Narrow the hierarchy.');
      const active = assertParents();
      for (const row of rows) store.rememberResource(active, account, observation(entity, row.id));
      const continuation = {
        version: 1,
        binding,
        after: next,
        page: page + 1,
        expires_at: expires,
        last_id: lastId,
        seen: more ? [...seen, fingerprint(next)] : seen,
      };
      return {
        gateway,
        connection_id: connection.id,
        account_id: account,
        entity,
        rows,
        has_more: more,
        next_cursor: more
          ? Buffer.from(JSON.stringify({...continuation, signature: sign(continuation, authorization)})).toString(
              'base64url',
            )
          : null,
        captured_at: Date.now(),
        page_number: page + 1,
        currency,
        timezone: null,
        filters:
          entity === 'campaign_group'
            ? {statuses: groupStatuses, test: 'both'}
            : entity === 'campaign'
              ? {campaign_group_id: config.campaign_group_id, test: 'both'}
              : {campaign_id: config.campaign_id, test: 'both'},
        meaning:
          'Current LinkedIn inventory in ascending native ID order, not a point-in-time snapshot. Campaign groups cover the seven documented status filters; test and non-test entities are included. Current parent reads verify account and hierarchy. Native decimal money and currency remain unconverted. Observed group controls and campaign pacing do not establish effective spend or budget-edit eligibility. Campaign daily settings are not a hard calendar-day spending cap. Creative intended status and observed serving state stay separate. No write authority is granted.',
      };
    });
  } finally {
    budget.close();
  }
}
