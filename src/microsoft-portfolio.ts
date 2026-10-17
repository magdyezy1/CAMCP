import {bad, fingerprint, obj, validate, type ToolCall} from './workspace-core.js';
import {microsoftScope} from './microsoft-native.js';
import {providerDecimalText} from './provider-decimal.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {openCursor, sealCursor} from './signed-cursor.js';
import {portfolioAuthority, portfolioReader, withPortfolioBudget, type PortfolioAdapter} from './portfolio-runner.js';

/**
 * RPT-07 (B27): the Microsoft Advertising portfolio adapter. Microsoft's campaign, ad group and ad reads are not paged
 * (GetCampaignsByAccountId, GetAdGroupsByCampaignId, GetAdsByAdGroupId), so each page reads the complete bounded
 * collection and serves an ascending-ID slice under a signed five-minute cursor that binds the collection's content: a
 * collection that changes between pages, or exceeds the bound, is refused instead of truncated.
 *  - Campaigns are requested with every documented CampaignType (the API returns only Search campaigns by default).
 *  - Ads are requested with every documented AdType.
 *  - Ad groups and ads need their parents read in this account and login portfolio first (five-minute observations),
 *    and each current parent read confirms the hierarchy before the child collection is read.
 */
const gateway = 'microsoft_ads_native_action';
/** Pinned v13 CampaignType and AdType values (.mirror/VENDOR/microsoft-campaign-management-v13.json). */
export const microsoftCampaignTypes = Object.freeze([
  'Search',
  'Shopping',
  'DynamicSearchAds',
  'Audience',
  'Hotel',
  'PerformanceMax',
  'App',
  'ObjectiveBased',
]);
export const microsoftAdTypes = Object.freeze([
  'Text',
  'Image',
  'Product',
  'AppInstall',
  'ExpandedText',
  'DynamicSearch',
  'ResponsiveAd',
  'ResponsiveSearch',
  'Hotel',
]);
/** Entities in one complete Microsoft collection; a larger collection is refused, never truncated. */
export const microsoftPortfolioLimit = 1000;
const kinds: Record<string, {result: string; observation: string}> = {
  campaign: {result: 'Campaigns', observation: 'campaign'},
  ad_group: {result: 'AdGroups', observation: 'ad_group'},
  ad: {result: 'Ads', observation: 'ad'},
};
const invalid = (message: string): never => bad(message, 'PORTFOLIO_INVALID_RESPONSE');
const nativeId = (v: unknown): v is string =>
  typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
const observation = (entity: string, id: string) => 'portfolio/microsoft/' + entity + '/' + id;
function text(v: unknown, max = 2000): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > max) invalid('Microsoft returned a malformed inventory text field.');
  return v as string;
}
/** Decimal account-currency money (a JSON number or decimal text), as lossless decimal text. */
function money(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (obj(v)) return money(v.Amount);
  try {
    return providerDecimalText(v, {field: 'money'});
  } catch {
    return invalid('Microsoft returned money without an exact nonnegative decimal amount.');
  }
}

/** One page of current Microsoft inventory: campaigns, ad groups of a campaign, or ads of an ad group. */
export async function microsoftPortfolioPage(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  const config = input.requirements ?? {};
  validate(config, ['entity', 'campaign_id', 'ad_group_id']);
  const entity = config.entity ?? 'campaign',
    limit = input.limit ?? 50,
    account = input.account_id;
  if (!Object.hasOwn(kinds, entity)) bad('For Microsoft choose campaign, ad_group or ad.');
  if (!nativeId(account)) bad('Choose the exact numeric Microsoft Advertising account ID.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) bad('Portfolio pages contain 1–100 entities.');
  if (
    (entity === 'campaign' && (config.campaign_id !== undefined || config.ad_group_id !== undefined)) ||
    (entity !== 'campaign' && !nativeId(config.campaign_id)) ||
    (entity === 'ad_group' && config.ad_group_id !== undefined) ||
    (entity === 'ad' && !nativeId(config.ad_group_id))
  )
    bad('Choose the exact parent campaign, and for ads its exact ad group.');
  const connection = store.resolveConnection(actor, gateway, account, input.connection_id);
  const {authorization, current} = portfolioAuthority(store, actor, gateway, account, connection, {
    binds: 'login',
    permits: c => c.scopes.includes(microsoftScope),
    missingScope: () => bad('This login requires Microsoft Advertising permission.', 'INSUFFICIENT_SCOPE'),
    changed: () => bad('The Microsoft login changed. Restart inventory.', 'CONNECTION_AUTHORITY_CHANGED'),
  });
  const parents: [string, string][] = [
    ...(entity !== 'campaign' ? [['campaign', config.campaign_id] as [string, string]] : []),
    ...(entity === 'ad' ? [['ad_group', config.ad_group_id] as [string, string]] : []),
  ];
  const assertParents = () => {
    const c = current();
    for (const [kind, id] of parents)
      if (!store.ownsResource(c, account, observation(kind, id)))
        bad(
          'Read the parent Microsoft portfolio with this login first. Parent observations last five minutes.',
          'RESOURCE_SCOPE_REQUIRED',
        );
    return c;
  };
  assertParents();
  const binding = fingerprint({
    tenant: actor.tenantId,
    user: actor.userId,
    gateway,
    version: 'v13',
    connection: connection.id,
    account,
    entity,
    config,
    limit,
    authorization,
  });
  let offset = 0,
    page = 0,
    expires = Date.now() + 300000,
    content: string | undefined;
  if (input.cursor !== undefined) {
    try {
      const c = openCursor(input.cursor, {key: authorization, binding, maxLength: 4096});
      if (
        !Number.isSafeInteger(c.offset) ||
        c.offset < limit ||
        c.offset % limit !== 0 ||
        c.offset >= microsoftPortfolioLimit ||
        !Number.isSafeInteger(c.page) ||
        c.page !== c.offset / limit ||
        typeof c.content !== 'string' ||
        !/^[0-9a-f]{64}$/.test(c.content)
      )
        throw Error();
      offset = c.offset;
      page = c.page;
      expires = c.expires_at;
      content = c.content;
    } catch {
      bad(
        'Restart this account, login, hierarchy and page size; the Microsoft cursor is invalid or expired.',
        'INVALID_CURSOR',
      );
    }
  }
  const send = portfolioReader(call, actor, gateway, current, error =>
    bad(error?.message ?? 'Microsoft inventory read failed.', error?.code ?? 'PORTFOLIO_FAILED'),
  );
  const read = async (action: string, payload: JsonObject, campaign?: string) => {
    const r = await send({
      action,
      account_id: account,
      connection_id: connection.id,
      payload,
      ...(campaign ? {campaign_id: campaign} : {}),
      dry_run: false,
    });
    const d = r.data?.data;
    if (r.data?.truncated || !obj(d)) invalid('Microsoft returned an incomplete or failed inventory response.');
    return d as JsonObject;
  };
  const one = async (action: string, payload: JsonObject, result: string, id: string, campaign?: string) => {
    const d = await read(action, payload, campaign),
      rows = d[result];
    if (!Array.isArray(rows) || rows.length !== 1 || !obj(rows[0]) || String(rows[0].Id) !== id)
      bad('Microsoft did not confirm the exact parent in this account.', 'STATE_TARGET_MISMATCH');
    return rows[0] as JsonObject;
  };
  return withPortfolioBudget(
    binding,
    {requests: 6, rows: microsoftPortfolioLimit + 2, bytes: 16 * 1024 * 1024, elapsed_ms: 60000},
    async budget => {
      const accountRow = (await read('GetAccount', {})).Account;
      if (!obj(accountRow) || String(accountRow.Id) !== account)
        bad('Microsoft returned a different advertising account.', 'STATE_TARGET_MISMATCH');
      const currency = text(accountRow.CurrencyCode, 3),
        timezone = text(accountRow.TimeZone, 100);
      if (currency !== null && !/^[A-Z]{3}$/.test(currency)) invalid('Microsoft returned an invalid account currency.');
      const campaignTypes = microsoftCampaignTypes.join(',');
      if (entity !== 'campaign')
        await one(
          'GetCampaignsByIds',
          {CampaignIds: [config.campaign_id], CampaignType: campaignTypes},
          'Campaigns',
          config.campaign_id,
        );
      if (entity === 'ad')
        await one(
          'GetAdGroupsByIds',
          {CampaignId: config.campaign_id, AdGroupIds: [config.ad_group_id]},
          'AdGroups',
          config.ad_group_id,
          config.campaign_id,
        );
      const d =
        entity === 'campaign'
          ? await read('GetCampaignsByAccountId', {AccountId: account, CampaignType: campaignTypes})
          : entity === 'ad_group'
            ? await read('GetAdGroupsByCampaignId', {CampaignId: config.campaign_id}, config.campaign_id)
            : await read(
                'GetAdsByAdGroupId',
                {AdGroupId: config.ad_group_id, AdTypes: [...microsoftAdTypes]},
                config.campaign_id,
              );
      const raw = d[kinds[entity]!.result];
      if (!Array.isArray(raw)) invalid('Microsoft did not return the requested inventory collection.');
      if (raw.length > microsoftPortfolioLimit)
        bad(
          'This Microsoft collection has more than 1000 entities, and Microsoft does not page it. Narrow the hierarchy; nothing was truncated.',
          'PORTFOLIO_COLLECTION_LIMIT',
          {entities: raw.length, limit: microsoftPortfolioLimit},
        );
      budget.rows('entities', raw.length);
      const seen = new Set<string>();
      const rows = (raw as JsonObject[])
        .map(row => {
          if (!obj(row)) invalid('Microsoft returned an invalid inventory row.');
          const id = typeof row.Id === 'number' && Number.isSafeInteger(row.Id) ? String(row.Id) : row.Id;
          if (!nativeId(id) || seen.has(id)) invalid('Microsoft returned a missing, malformed or repeated native ID.');
          seen.add(id);
          if (entity === 'campaign' && row.CampaignType !== undefined) {
            // A flags value is a comma-separated list of documented types.
            const types = String(row.CampaignType)
              .split(/[,\s]+/)
              .filter(Boolean);
            if (!types.length || types.some(t => !microsoftCampaignTypes.includes(t)))
              invalid('Microsoft returned an undocumented campaign type.');
          }
          if (entity === 'ad' && row.Type !== undefined && !microsoftAdTypes.includes(row.Type))
            invalid('Microsoft returned an undocumented ad type.');
          const nativeMoney =
            entity === 'campaign'
              ? {DailyBudget: money(row.DailyBudget)}
              : entity === 'ad_group'
                ? {CpcBid: money(row.CpcBid)}
                : {};
          const native: JsonObject = {
            Id: id,
            // Ads have no name; a text ad's title is its readable label, otherwise the native ID is shown.
            Name: text(entity === 'ad' ? (row.Title ?? row.TitlePart1 ?? null) : row.Name),
            Status: text(row.Status, 100),
            ...(entity === 'campaign'
              ? {
                  CampaignType: text(row.CampaignType, 200),
                  BudgetType: text(row.BudgetType, 100),
                  BudgetId: row.BudgetId == null ? null : String(row.BudgetId),
                  TimeZone: text(row.TimeZone, 100),
                }
              : entity === 'ad_group'
                ? {AdGroupType: text(row.AdGroupType, 100), Network: text(row.Network, 100)}
                : {Type: text(row.Type, 100), EditorialStatus: text(row.EditorialStatus, 100)}),
            ...nativeMoney,
          };
          return {
            id,
            name: (native.Name as string | null) ?? id,
            entity,
            status: native.Status,
            campaign_id: entity === 'campaign' ? id : config.campaign_id,
            ad_group_id: entity === 'ad_group' ? id : (config.ad_group_id ?? null),
            currency,
            timezone,
            native_money: nativeMoney,
            money_unit: 'account currency decimal',
            native,
          };
        })
        .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
      const digest = fingerprint({rows, currency, timezone});
      // A continuation serves the next slice of the same collection; a changed collection is restarted, not merged.
      if (content !== undefined && content !== digest)
        bad('The Microsoft inventory changed since the first page. Restart from the first page.', 'PORTFOLIO_CHANGED');
      const slice = rows.slice(offset, offset + limit),
        more = offset + limit < rows.length;
      const active = assertParents();
      budget.check();
      for (const row of slice) store.rememberResource(active, account, observation(kinds[entity]!.observation, row.id));
      const continuation = {
        version: 1,
        binding,
        offset: offset + limit,
        page: page + 1,
        content: digest,
        expires_at: expires,
      };
      return {
        gateway,
        connection_id: connection.id,
        account_id: account,
        entity,
        rows: slice,
        currency,
        timezone,
        has_more: more,
        next_cursor: more ? sealCursor(continuation, authorization) : null,
        page_number: page + 1,
        captured_at: Date.now(),
        collection_size: rows.length,
        filters:
          entity === 'campaign'
            ? {campaign_types: [...microsoftCampaignTypes]}
            : entity === 'ad_group'
              ? {campaign_id: config.campaign_id}
              : {campaign_id: config.campaign_id, ad_group_id: config.ad_group_id, ad_types: [...microsoftAdTypes]},
        meaning:
          'Current Microsoft Advertising inventory in ascending native ID order, not a point-in-time snapshot. Microsoft does not page these reads, so each page reads the complete collection (at most 1000 entities, refused above it) and a collection that changes between pages is restarted. Campaigns include every documented campaign type and ads every documented ad type. Current parent reads confirm the account and hierarchy. Money is unconverted decimal account currency. No write authority is granted.',
      };
    },
  );
}

/** The Microsoft Advertising portfolio adapter (ARC-04 stage E). */
export const microsoftPortfolioAdapter: PortfolioAdapter = {
  gateway,
  entities: ['campaign', 'ad_group', 'ad'],
  page: microsoftPortfolioPage,
};
