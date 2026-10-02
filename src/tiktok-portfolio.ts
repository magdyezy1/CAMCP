import {createHmac, timingSafeEqual} from 'node:crypto';
import {bad, fingerprint, obj, validate, type ToolCall} from './workspace-core.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';

const gateway = 'tiktok_native_action';
const nativeId = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
const invalid = (message: string): never => bad(message, 'PORTFOLIO_INVALID_RESPONSE');
const sign = (v: JsonObject, key: string) => createHmac('sha256', key).update(fingerprint(v)).digest('hex');
const fields: Record<string, string[]> = {
  campaign: [
    'advertiser_id',
    'campaign_id',
    'campaign_name',
    'operation_status',
    'secondary_status',
    'objective_type',
    'budget_mode',
    'budget',
    'create_time',
    'modify_time',
  ],
  adgroup: [
    'advertiser_id',
    'campaign_id',
    'adgroup_id',
    'adgroup_name',
    'operation_status',
    'secondary_status',
    'budget_mode',
    'budget',
    'scheduled_budget',
    'bid_price',
    'create_time',
    'modify_time',
  ],
  ad: [
    'advertiser_id',
    'campaign_id',
    'adgroup_id',
    'ad_id',
    'ad_name',
    'operation_status',
    'secondary_status',
    'ad_format',
    'create_time',
    'modify_time',
  ],
};
function text(v: unknown, max = 2000): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > max) invalid('TikTok returned a malformed inventory text field.');
  return v as string;
}
function money(v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  // Preserve the provider JSON type; a parsed number is never described as its original decimal lexeme.
  if (typeof v === 'string' && /^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,12})?$/.test(v)) return v;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER) return v;
  return invalid('TikTok returned an invalid or unsafe native money value.');
}
function paging(d: JsonObject, page: number, limit: number) {
  if (!Array.isArray(d.list) || d.list.length > limit || !obj(d.page_info))
    return invalid('TikTok did not return a bounded inventory page.');
  const p = d.page_info;
  if (
    p.page !== page ||
    p.page_size !== limit ||
    !Number.isSafeInteger(p.total_number) ||
    p.total_number < 0 ||
    !Number.isSafeInteger(p.total_page) ||
    p.total_page < 0 ||
    (p.total_number === 0
      ? page !== 1 || d.list.length !== 0 || ![0, 1].includes(p.total_page)
      : p.total_page !== Math.ceil(p.total_number / limit) ||
        page > p.total_page ||
        d.list.length !== Math.min(limit, p.total_number - (page - 1) * limit))
  )
    invalid('TikTok returned inconsistent inventory page counts.');
  return {rows: d.list as unknown[], total: p.total_number as number, more: page < p.total_page};
}

/** Standard advertiser-scoped list routes. Smart+, GMV Max and other specialized routes remain independent. */
export async function tiktokPortfolioPage(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  const config = input.requirements ?? {};
  validate(config, ['entity', 'campaign_id', 'adgroup_id']);
  const entity = config.entity ?? 'campaign',
    limit = input.limit ?? 50,
    account = input.account_id;
  if (!Object.hasOwn(fields, entity)) bad('For TikTok choose campaign, adgroup or ad.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) bad('TikTok portfolio pages contain 1–100 entities.');
  if (!nativeId(account)) bad('Choose an exact TikTok advertiser ID.');
  if (
    (entity === 'campaign' && (config.campaign_id !== undefined || config.adgroup_id !== undefined)) ||
    (entity !== 'campaign' && !nativeId(config.campaign_id)) ||
    (entity === 'adgroup' && config.adgroup_id !== undefined) ||
    (entity === 'ad' && !nativeId(config.adgroup_id))
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
      bad('The TikTok login or permissions changed. Restart inventory.', 'REAUTHORIZATION_REQUIRED');
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
    version: 'v1.3',
  });
  let page = 1,
    expires = Date.now() + 300000,
    total: number | undefined,
    previous: string[] = [];
  if (input.cursor !== undefined) {
    try {
      if (
        typeof input.cursor !== 'string' ||
        input.cursor.length > 14000 ||
        !/^[A-Za-z0-9_-]+$/.test(input.cursor) ||
        Buffer.from(input.cursor, 'base64url').toString('base64url') !== input.cursor
      )
        throw Error();
      const c = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      if (!obj(c)) throw Error();
      const {signature, ...signed} = c;
      if (
        typeof signature !== 'string' ||
        !/^[0-9a-f]{64}$/.test(signature) ||
        !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(signed, authorization), 'hex')) ||
        c.version !== 1 ||
        c.binding !== binding ||
        !Number.isInteger(c.page) ||
        c.page < 2 ||
        c.page > 100 ||
        !Number.isSafeInteger(c.total) ||
        c.total < 1 ||
        !Number.isSafeInteger(c.expires_at) ||
        c.expires_at <= Date.now() ||
        c.expires_at > Date.now() + 300000 ||
        !Array.isArray(c.previous) ||
        c.previous.length !== limit ||
        !c.previous.every(nativeId) ||
        new Set(c.previous).size !== c.previous.length
      )
        throw Error();
      page = c.page;
      expires = c.expires_at;
      total = c.total;
      previous = c.previous;
    } catch {
      bad(
        'Restart this advertiser, login, hierarchy and page size; the TikTok cursor is invalid or expired.',
        'INVALID_CURSOR',
      );
    }
  }
  current();
  const budget = new ReportCollectionBudget(undefined, binding, () => {}, {
    requests: 6,
    rows: 101,
    bytes: 8 * 1024 * 1024,
    elapsed_ms: 60000,
  });
  const read = async (action: string, query: JsonObject) => {
    current();
    const r = await call(
      gateway,
      {action, account_id: account, connection_id: connection.id, query, aggregate_pages: false, dry_run: false},
      actor,
    );
    current();
    if (!r.success) bad(r.error?.message ?? 'TikTok inventory read failed.', r.error?.code ?? 'PORTFOLIO_FAILED');
    const v = r.data?.data;
    if (
      r.data?.truncated ||
      !obj(v) ||
      v.code !== 0 ||
      v.error ||
      v.truncated ||
      !obj(v.data) ||
      v.data.error ||
      v.data.truncated ||
      ['next_cursor', 'next_page_token', 'has_more'].some(k => v.data[k] !== undefined)
    )
      invalid('TikTok returned incomplete or unknown inventory evidence.');
    return v.data as JsonObject;
  };
  try {
    return await budget.run(async () => {
      const info = await read('tiktok_advertiser_info_get', {
        advertiser_ids: [account],
        fields: ['advertiser_id', 'currency', 'timezone'],
      });
      if (
        !Array.isArray(info.list) ||
        info.list.length !== 1 ||
        !obj(info.list[0]) ||
        info.list[0].advertiser_id !== account
      )
        invalid('TikTok did not return the exact selected advertiser.');
      if (info.page_info !== undefined) {
        const p = paging(info, 1, 1);
        if (p.more) invalid('TikTok advertiser metadata was incomplete.');
      }
      budget.rows('account', 1);
      const currency = text(info.list[0].currency, 3),
        timezone = text(info.list[0].timezone, 100);
      if (currency !== null && !/^[A-Z]{3}$/.test(currency)) invalid('TikTok returned an invalid account currency.');
      const filtering = {
        primary_status: 'STATUS_NOT_DELETE',
        ...(config.campaign_id ? {campaign_ids: [config.campaign_id]} : {}),
        ...(config.adgroup_id ? {adgroup_ids: [config.adgroup_id]} : {}),
      };
      const data = await read('tiktok_' + entity + '_get', {
        advertiser_id: account,
        filtering,
        fields: fields[entity],
        page,
        page_size: limit,
      });
      const inventory = paging(data, page, limit);
      budget.rows('inventory', inventory.rows.length);
      if (total !== undefined && inventory.total !== total)
        bad('TikTok inventory changed between pages. Restart the current hierarchy.', 'PORTFOLIO_CHANGED');
      const seen = new Set<string>();
      const rows = inventory.rows.map(value => {
        if (!obj(value)) return invalid('TikTok returned a malformed inventory item.');
        const id = value[entity + '_id'];
        if (
          !nativeId(id) ||
          value.advertiser_id !== account ||
          !nativeId(value.campaign_id) ||
          (entity !== 'campaign' && value.campaign_id !== config.campaign_id) ||
          (entity === 'adgroup' && !nativeId(value.adgroup_id)) ||
          (entity === 'ad' && value.adgroup_id !== config.adgroup_id) ||
          seen.has(id) ||
          previous.includes(id)
        )
          invalid('TikTok returned a foreign, duplicate or overlapping inventory entity.');
        seen.add(id);
        const native: JsonObject = {};
        for (const field of fields[entity]!)
          native[field] = ['budget', 'scheduled_budget', 'bid_price'].includes(field)
            ? money(value[field])
            : text(value[field], field.endsWith('_id') ? 32 : 2000);
        const nativeMoney: JsonObject = {};
        for (const field of ['budget', 'scheduled_budget', 'bid_price'])
          if (fields[entity]!.includes(field)) nativeMoney[field] = native[field];
        return {
          id,
          name: native[entity + '_name'] ?? id,
          entity,
          campaign_id: value.campaign_id,
          adgroup_id: entity === 'campaign' ? null : value.adgroup_id,
          status: native.operation_status,
          secondary_status: native.secondary_status,
          budget_mode: native.budget_mode ?? null,
          native_money: nativeMoney,
          currency,
          timezone,
          native,
        };
      });
      if (inventory.more && page >= 100)
        bad('This TikTok inventory reached its 100-page bound. Restart inventory.', 'PORTFOLIO_INCOMPLETE');
      const cursor = inventory.more
        ? {
            version: 1,
            binding,
            page: page + 1,
            total: inventory.total,
            previous: rows.map(r => r.id),
            expires_at: expires,
          }
        : null;
      current();
      budget.check();
      return {
        gateway,
        connection_id: connection.id,
        account_id: account,
        entity,
        rows,
        has_more: inventory.more,
        next_cursor: cursor
          ? Buffer.from(JSON.stringify({...cursor, signature: sign(cursor, authorization)})).toString('base64url')
          : null,
        captured_at: Date.now(),
        meaning:
          'Current TikTok standard campaign/ad-group/ad route inventory, excluding deleted entities. Native money keeps its JSON type and account-currency units, without conversion; budget_mode determines its meaning. Operation and secondary status remain separate and do not prove serving. Smart+, GMV Max and specialized route coverage is not implied. Page counts may change; this is not a point-in-time snapshot. This read grants no write authority.',
      };
    });
  } finally {
    budget.close();
  }
}
