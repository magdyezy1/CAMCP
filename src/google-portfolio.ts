import {createHmac, timingSafeEqual} from 'node:crypto';
import {bad, fingerprint, obj, validate, type ToolCall} from './workspace-core.js';
import {normalizeAccount} from './scope.js';
import {googleAdsVersion} from './google-version.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';

const gateway = 'google_ads_native_action';
const maxInt64 = 9223372036854775807n;
const nativeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= maxInt64;
const invalid = (message: string): never => bad(message, 'PORTFOLIO_INVALID_RESPONSE');
const signature = (value: JsonObject, key: string) =>
  createHmac('sha256', key).update(fingerprint(value)).digest('hex');
const fields: Record<string, string[]> = {
  campaign: [
    'campaign.id',
    'campaign.name',
    'campaign.status',
    'campaign.advertising_channel_type',
    'campaign.campaign_budget',
    'campaign_budget.amount_micros',
  ],
  ad_group: [
    'campaign.id',
    'ad_group.id',
    'ad_group.name',
    'ad_group.status',
    'ad_group.type',
    'ad_group.cpc_bid_micros',
  ],
  ad: [
    'campaign.id',
    'ad_group.id',
    'ad_group_ad.resource_name',
    'ad_group_ad.status',
    'ad_group_ad.ad.id',
    'ad_group_ad.ad.name',
    'ad_group_ad.ad.type',
  ],
};
function text(value: unknown, max = 2000): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) invalid('Google returned a malformed inventory text field.');
  return value as string;
}
function money(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= maxInt64) ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  )
    return String(value);
  return invalid('Google returned money without an exact nonnegative int64 value in micros.');
}
function resource(value: unknown, expected: string, required = false) {
  if (value === undefined && !required) return;
  if (value !== expected)
    bad('Google returned a different account or native resource identity.', 'STATE_TARGET_MISMATCH');
}
function projection(row: JsonObject, entity: string, account: string, config: JsonObject) {
  const c = row.campaign,
    g = row.adGroup,
    ga = row.adGroupAd,
    a = ga?.ad,
    customer = row.customer;
  const main = entity === 'campaign' ? c : entity === 'ad_group' ? g : a;
  if (!obj(customer) || customer.id !== account || !obj(c) || !nativeId(c.id) || !obj(main) || !nativeId(main.id))
    invalid('Google inventory requires exact account, campaign and entity IDs.');
  resource(customer.resourceName, `customers/${account}`);
  resource(c.resourceName, `customers/${account}/campaigns/${c.id}`, true);
  if (config.campaign_id && c.id !== config.campaign_id)
    bad('Google returned a different parent campaign.', 'STATE_TARGET_MISMATCH');
  if (entity !== 'campaign') {
    if (!obj(g) || !nativeId(g.id)) invalid('Google returned an ad group without an exact native ID.');
    resource(g.resourceName, `customers/${account}/adGroups/${g.id}`, true);
    if (config.ad_group_id && g.id !== config.ad_group_id)
      bad('Google returned a different parent ad group.', 'STATE_TARGET_MISMATCH');
  }
  if (entity === 'ad') {
    if (!obj(ga)) invalid('Google returned an incomplete ad record.');
    resource(ga.resourceName, `customers/${account}/adGroupAds/${g.id}~${a.id}`, true);
    resource(a.resourceName, `customers/${account}/ads/${a.id}`);
  }
  const currency = text(customer.currencyCode, 3),
    timezone = text(customer.timeZone, 100);
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) invalid('Google returned an invalid account currency.');
  if (timezone !== null && (!timezone || /[\x00-\x1f\x7f]/.test(timezone)))
    invalid('Google returned an invalid account timezone.');
  const name = text(main.name),
    status = text(entity === 'ad' ? ga.status : main.status, 100);
  if (status === 'REMOVED') invalid('Google returned a removed entity outside the requested inventory.');
  const native: JsonObject = {
    customer: {id: account, currencyCode: currency, timeZone: timezone},
    campaign: {id: c.id, resourceName: c.resourceName},
  };
  let budget: string | null = null,
    bid: string | null = null;
  if (entity === 'campaign') {
    Object.assign(native.campaign, {name, status, advertisingChannelType: text(c.advertisingChannelType, 100)});
    if (c.campaignBudget !== undefined) {
      if (
        typeof c.campaignBudget !== 'string' ||
        !c.campaignBudget.startsWith(`customers/${account}/campaignBudgets/`) ||
        c.campaignBudget.split('/').length !== 4 ||
        !nativeId(c.campaignBudget.split('/')[3])
      )
        invalid('Google returned an invalid budget resource.');
      native.campaign.campaignBudget = c.campaignBudget;
    }
    if (row.campaignBudget !== undefined) {
      if (!obj(row.campaignBudget)) invalid('Google returned a malformed campaign budget.');
      if (row.campaignBudget.resourceName !== undefined)
        resource(row.campaignBudget.resourceName, c.campaignBudget, true);
      budget = money(row.campaignBudget.amountMicros);
      native.campaignBudget = {
        ...(row.campaignBudget.resourceName === undefined ? {} : {resourceName: row.campaignBudget.resourceName}),
        amountMicros: budget,
      };
    }
  } else {
    native.adGroup = {id: g.id, resourceName: g.resourceName};
    if (entity === 'ad_group') {
      bid = money(g.cpcBidMicros);
      Object.assign(native.adGroup, {name, status, type: text(g.type, 100), cpcBidMicros: bid});
    } else
      native.adGroupAd = {
        resourceName: ga.resourceName,
        status,
        ad: {
          id: a.id,
          name,
          type: text(a.type, 100),
          ...(a.resourceName === undefined ? {} : {resourceName: a.resourceName}),
        },
      };
  }
  return {
    id: main.id,
    name: name ?? main.id,
    status,
    entity,
    campaign_id: c.id,
    ad_group_id: entity === 'campaign' ? null : g.id,
    resource_name: entity === 'ad' ? ga.resourceName : main.resourceName,
    currency,
    timezone,
    budget_micros: budget,
    cpc_bid_micros: bid,
    native,
  };
}

/** Account-scoped GAQL proves the complete child chain in the same response; no global-ID parent lookup is used. */
export async function googlePortfolioPage(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  const config = input.requirements ?? {};
  validate(config, ['entity', 'campaign_id', 'ad_group_id']);
  const entity = config.entity ?? 'campaign',
    limit = input.limit ?? 50;
  if (!Object.hasOwn(fields, entity)) bad('For Google choose campaign, ad_group or ad.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) bad('Portfolio pages contain 1–100 entities.');
  if (typeof input.account_id !== 'string') bad('Choose an exact Google account ID.');
  const account = normalizeAccount(gateway, input.account_id);
  if (!nativeId(account)) bad('Choose an exact Google account ID.');
  if (
    (entity === 'campaign' && (config.campaign_id !== undefined || config.ad_group_id !== undefined)) ||
    (entity !== 'campaign' && !nativeId(config.campaign_id)) ||
    (entity === 'ad_group' && config.ad_group_id !== undefined) ||
    (entity === 'ad' && !nativeId(config.ad_group_id))
  )
    bad('Choose the exact campaign, and for ads its exact ad group.');
  const connection = store.resolveConnection(actor, gateway, account, input.connection_id);
  const authorization = fingerprint({
    credentials: store.connectionCredentials(connection),
    scopes: [...connection.scopes].sort(),
  });
  const current = () => {
    const c = store.resolveConnection(actor, gateway, account, connection.id);
    if (fingerprint({credentials: store.connectionCredentials(c), scopes: [...c.scopes].sort()}) !== authorization)
      bad('The Google login or permissions changed. Restart inventory.', 'REAUTHORIZATION_REQUIRED');
  };
  const binding = fingerprint({
    tenant: actor.tenantId,
    user: actor.userId,
    gateway,
    connection: connection.id,
    account,
    entity,
    config,
    limit,
    authorization,
    provider_version: googleAdsVersion,
    version: 1,
  });
  let after: string | undefined,
    page = 0,
    expires = Date.now() + 300000;
  if (input.cursor !== undefined) {
    try {
      if (
        typeof input.cursor !== 'string' ||
        input.cursor.length > 2048 ||
        !/^[A-Za-z0-9_-]+$/.test(input.cursor) ||
        Buffer.from(input.cursor, 'base64url').toString('base64url') !== input.cursor
      )
        throw Error();
      const c = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      if (!obj(c)) throw Error();
      const {signature: sig, ...signed} = c;
      if (
        typeof sig !== 'string' ||
        !/^[0-9a-f]{64}$/.test(sig) ||
        !timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(signature(signed, authorization), 'hex')) ||
        c.version !== 1 ||
        c.binding !== binding ||
        !nativeId(c.after) ||
        !Number.isInteger(c.page) ||
        c.page < 1 ||
        c.page >= 100 ||
        !Number.isSafeInteger(c.expires_at) ||
        c.expires_at <= Date.now() ||
        c.expires_at > Date.now() + 300000
      )
        throw Error();
      after = c.after;
      page = c.page;
      expires = c.expires_at;
    } catch {
      bad(
        'Restart this account, login, hierarchy and page size; the Google cursor is invalid or expired.',
        'INVALID_CURSOR',
      );
    }
  }
  current();
  const type = entity === 'ad' ? 'ad_group_ad' : entity,
    key = entity === 'ad' ? 'ad_group_ad.ad.id' : entity + '.id';
  const where = [
    `${type}.status != 'REMOVED'`,
    ...(config.campaign_id ? [`campaign.id = ${config.campaign_id}`] : []),
    ...(config.ad_group_id ? [`ad_group.id = ${config.ad_group_id}`] : []),
    ...(after ? [`${key} > ${after}`] : []),
  ];
  const query = `SELECT customer.id, customer.currency_code, customer.time_zone, ${fields[entity]!.join(', ')} FROM ${type} WHERE ${where.join(' AND ')} ORDER BY ${key} LIMIT ${limit + 1}`;
  const budget = new ReportCollectionBudget(undefined, binding, () => {}, {
    requests: 5,
    rows: 101,
    elapsed_ms: 60000,
    bytes: 8 * 1024 * 1024,
  });
  try {
    return await budget.run(async () => {
      const response = await call(
        gateway,
        {
          action: 'google_ads_v23_google_ads_search',
          account_id: account,
          connection_id: connection.id,
          payload: {query},
          aggregate_pages: false,
          dry_run: false,
        },
        actor,
      );
      current();
      if (!response.success)
        bad(response.error?.message ?? 'Google inventory read failed.', response.error?.code ?? 'PORTFOLIO_FAILED');
      const d = response.data?.data;
      if (
        !obj(d) ||
        response.data?.truncated ||
        d.truncated ||
        d.partialFailureError ||
        d.partial_failure_error ||
        d.error ||
        (d.nextPageToken !== undefined && d.nextPageToken !== '') ||
        (d.next_page_token !== undefined && d.next_page_token !== '')
      )
        bad('Google inventory did not return one complete bounded page.', 'PORTFOLIO_INCOMPLETE');
      // ProtoJSON omits empty repeated fields. The exact requested mask distinguishes that response from an
      // unknown object; any contradictory total or explicitly malformed collection remains refused.
      const expectedMask = query.slice(7, query.indexOf(' FROM ')).split(', ').sort().join(',');
      const empty =
        d.results === undefined &&
        typeof d.fieldMask === 'string' &&
        d.fieldMask
          .replace(/[A-Z]/g, (letter: string) => '_' + letter.toLowerCase())
          .split(',')
          .sort()
          .join(',') === expectedMask &&
        (d.totalResultsCount === undefined || d.totalResultsCount === '0');
      const raw: unknown = empty ? [] : d.results;
      if (!Array.isArray(raw)) return invalid('Google did not return a qualified inventory collection.');
      if (raw.length > limit + 1) invalid('Google returned more entities than requested.');
      budget.rows('page', raw.length);
      const rows = raw.map((row: unknown) => {
        if (!obj(row)) invalid('Google returned a malformed inventory row.');
        return projection(row as JsonObject, entity, account, config);
      });
      if (
        rows.some(
          (r, i) => (i > 0 && BigInt(r.id) <= BigInt(rows[i - 1]!.id)) || (after && BigInt(r.id) <= BigInt(after)),
        ) ||
        new Set(rows.filter(r => r.currency !== null).map(r => r.currency)).size > 1 ||
        new Set(rows.filter(r => r.timezone !== null).map(r => r.timezone)).size > 1
      )
        invalid('Google returned inconsistent account metadata or an unordered inventory continuation.');
      const more = rows.length > limit,
        visible = rows.slice(0, limit);
      if (more && page + 1 >= 100)
        bad('This inventory reached its 100-page bound. Restart inventory.', 'PORTFOLIO_INCOMPLETE');
      const cursor = more
        ? {version: 1, binding, after: visible.at(-1)!.id, page: page + 1, expires_at: expires}
        : null;
      current();
      budget.check();
      return {
        gateway,
        connection_id: connection.id,
        account_id: account,
        entity,
        rows: visible,
        has_more: more,
        next_cursor: cursor
          ? Buffer.from(JSON.stringify({...cursor, signature: signature(cursor, authorization)})).toString('base64url')
          : null,
        captured_at: Date.now(),
        meaning:
          'Current non-removed Google inventory, ordered by exact immutable IDs. Native micros remain unconverted. Configured status does not prove serving. Provider changes across pages are possible; this is not a point-in-time snapshot. This read grants no write authority.',
      };
    });
  } finally {
    budget.close();
  }
}
