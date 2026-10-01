import {bad, fingerprint, obj, validate, type ToolCall} from './workspace-core.js';
import {normalizeAccount} from './scope.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {metaApiVersion} from './meta-version.js';
import {createHmac, timingSafeEqual} from 'node:crypto';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';

const gateway = 'meta_native_action';
const nativeId = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,31}$/.test(value);
const common = ['id', 'name', 'account_id', 'status', 'effective_status', 'updated_time'];
export const metaPortfolioFields: Record<string, string[]> = {
  campaign: [...common, 'objective', 'daily_budget', 'lifetime_budget'],
  adset: [
    ...common,
    'campaign_id',
    'daily_budget',
    'lifetime_budget',
    'bid_amount',
    'optimization_goal',
    'start_time',
    'end_time',
  ],
  ad: [...common, 'campaign_id', 'adset_id'],
};
const invalid = (message: string): never => bad(message, 'PORTFOLIO_INVALID_RESPONSE');
function money(value: unknown) {
  if (value === undefined || value === null) return null;
  if (
    (typeof value === 'string' && /^\d{1,30}$/.test(value)) ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  )
    return String(value);
  return invalid('Meta returned a native money field without an exact nonnegative integer.');
}
function text(value: unknown, max = 2000) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) return invalid('Meta returned a malformed text field.');
  return value;
}
const cursorToken = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u0020\u007f]/.test(value);

const signature = (value: JsonObject, key: string) =>
  createHmac('sha256', key).update(fingerprint(value)).digest('hex');
const encodeCursor = (value: JsonObject, key: string) =>
  Buffer.from(JSON.stringify({...value, signature: signature(value, key)})).toString('base64url');

/** Bounded native inventory. Parent ownership comes from a prior scoped read, never from the requested ID alone. */
export async function metaPortfolioPage(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  const config = input.requirements ?? {};
  validate(config, ['entity', 'campaign_id', 'adset_id']);
  const entity = config.entity ?? 'campaign',
    limit = input.limit ?? 50;
  if (!Object.hasOwn(metaPortfolioFields, entity)) bad('For Meta choose campaign, adset or ad.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) bad('Portfolio pages contain 1–100 entities.');
  if (typeof input.account_id !== 'string') bad('Choose the exact Meta account.');
  const account = normalizeAccount(gateway, input.account_id);
  if (!nativeId(account)) bad('Choose the exact Meta account.');
  if (
    (entity === 'campaign' && (config.campaign_id !== undefined || config.adset_id !== undefined)) ||
    (entity !== 'campaign' && !nativeId(config.campaign_id)) ||
    (entity === 'ad' && !nativeId(config.adset_id)) ||
    (entity === 'adset' && config.adset_id !== undefined)
  )
    bad('Choose an exact parent campaign, and for ads its exact ad set.');
  const connection = store.resolveConnection(actor, gateway, account, input.connection_id);
  const authorization = fingerprint(store.connectionCredentials(connection));
  const current = () => {
    const c = store.resolveConnection(actor, gateway, account, connection.id);
    if (connection.scopes.some(scope => !c.scopes.includes(scope)))
      bad('The selected login lost permissions. Restart the portfolio read.', 'INSUFFICIENT_SCOPE');
    if (fingerprint(store.connectionCredentials(c)) !== authorization)
      bad('The selected login changed. Restart the portfolio read.', 'REAUTHORIZATION_REQUIRED');
    return c;
  };
  const binding = fingerprint({
    tenant: actor.tenantId,
    user: actor.userId,
    gateway,
    version: metaApiVersion,
    connection: connection.id,
    account,
    entity,
    campaign: config.campaign_id,
    adset: config.adset_id,
    limit,
    authorization,
  });
  let after: string | undefined,
    page = 0,
    expires = Date.now() + 300000,
    previousIds: string[] = [],
    cursors: string[] = [];
  if (input.cursor !== undefined) {
    try {
      if (typeof input.cursor !== 'string' || input.cursor.length > 24000 || !/^[A-Za-z0-9_-]+$/.test(input.cursor))
        throw Error();
      const c = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      if (!obj(c)) throw Error();
      const {signature: suppliedSignature, ...signed} = c;
      if (
        typeof suppliedSignature !== 'string' ||
        !/^[0-9a-f]{64}$/.test(suppliedSignature) ||
        !timingSafeEqual(Buffer.from(suppliedSignature, 'hex'), Buffer.from(signature(signed, authorization), 'hex'))
      )
        throw Error();
      if (
        !obj(c) ||
        c.binding !== binding ||
        c.version !== 1 ||
        !cursorToken(c.after) ||
        !Number.isInteger(c.page) ||
        c.page < 1 ||
        c.page >= 100 ||
        !Number.isSafeInteger(c.expires_at) ||
        c.expires_at <= Date.now() ||
        c.expires_at > Date.now() + 300000 ||
        !Array.isArray(c.previous_ids) ||
        c.previous_ids.length > limit ||
        !c.previous_ids.every(nativeId) ||
        new Set(c.previous_ids).size !== c.previous_ids.length ||
        !Array.isArray(c.seen_cursors) ||
        c.seen_cursors.length !== c.page ||
        !c.seen_cursors.every((v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) ||
        new Set(c.seen_cursors).size !== c.seen_cursors.length ||
        c.seen_cursors.at(-1) !== fingerprint(c.after)
      )
        throw Error();
      after = c.after;
      page = c.page;
      expires = c.expires_at;
      previousIds = c.previous_ids;
      cursors = c.seen_cursors;
    } catch {
      bad(
        'Restart this exact account, login, entity and page size; the portfolio cursor is invalid or expired.',
        'INVALID_CURSOR',
      );
    }
  }
  // The native scope guard requires this observation too. Fail before any account request when the parent is stale.
  for (const parent of [config.campaign_id, config.adset_id].filter(Boolean))
    if (!store.ownsResource(connection, account, parent))
      bad(
        'Read the parent inventory page with this login first. Parent observations last five minutes.',
        'RESOURCE_SCOPE_REQUIRED',
      );
  const budget = new ReportCollectionBudget(undefined, binding, () => {}, {
    requests: 8,
    rows: 100,
    bytes: 8 * 1024 * 1024,
    elapsed_ms: 60000,
  });
  const read = async (action: string, path: JsonObject, fields: string[], query: JsonObject = {}) => {
    current();
    const response = await call(
      gateway,
      {
        action,
        account_id: account,
        connection_id: connection.id,
        path_params: path,
        query: {fields: fields.join(','), ...query},
        dry_run: false,
      },
      actor,
    );
    current();
    if (!response.success)
      bad(response.error?.message ?? 'Meta inventory read failed.', response.error?.code ?? 'PORTFOLIO_FAILED');
    if (response.data?.truncated || !obj(response.data?.data))
      invalid('Meta returned incomplete or malformed inventory.');
    return response.data.data as JsonObject;
  };
  try {
    return await budget.run(async () => {
      const accountRow = await read('meta_ad_account_id_get', {ad_account_id: account}, [
        'id',
        'account_id',
        'currency',
        'timezone_name',
      ]);
      if (
        accountRow.id !== 'act_' + account ||
        (accountRow.account_id !== undefined && accountRow.account_id !== account)
      )
        bad('Meta returned a different account.', 'STATE_TARGET_MISMATCH');
      const currency = text(accountRow.currency, 3),
        timezone = text(accountRow.timezone_name, 100);
      if (currency !== null && !/^[A-Z]{3}$/.test(currency)) invalid('Meta returned an invalid account currency.');
      if (entity !== 'campaign') {
        const parent = await read('meta_campaign_id_get', {campaign_id: config.campaign_id}, ['id', 'account_id']);
        if (parent.id !== config.campaign_id || parent.account_id !== account)
          bad('Meta returned a different parent campaign or account.', 'STATE_TARGET_MISMATCH');
      }
      if (entity === 'ad') {
        const parent = await read('meta_ad_set_id_get', {ad_set_id: config.adset_id}, [
          'id',
          'account_id',
          'campaign_id',
        ]);
        if (parent.id !== config.adset_id || parent.account_id !== account || parent.campaign_id !== config.campaign_id)
          bad('Meta returned a different ad set, campaign or account.', 'STATE_TARGET_MISMATCH');
      }
      const fields = metaPortfolioFields[entity]!;
      const body = await read(
        entity === 'campaign'
          ? 'meta_ad_account_id_campaigns_get'
          : entity === 'adset'
            ? 'meta_campaign_id_adsets_get'
            : 'meta_ad_set_id_ads_get',
        entity === 'campaign'
          ? {ad_account_id: account}
          : entity === 'adset'
            ? {campaign_id: config.campaign_id}
            : {ad_set_id: config.adset_id},
        fields,
        {limit, ...(after ? {after} : {})},
      );
      if (!Array.isArray(body.data) || body.data.length > limit)
        invalid('Meta did not return a bounded inventory page.');
      budget.rows('entities', body.data.length);
      const ids = new Set<string>();
      const rows = (body.data as JsonObject[]).map(r => {
        if (!obj(r) || !nativeId(r.id) || ids.has(r.id) || previousIds.includes(r.id))
          invalid('Meta returned a missing, inexact or repeated native ID. Restart inventory if it changed.');
        ids.add(r.id);
        if (r.account_id !== account) invalid('Meta inventory did not retain the exact selected account.');
        if (
          (entity !== 'campaign' && r.campaign_id !== config.campaign_id) ||
          (entity === 'ad' && r.adset_id !== config.adset_id)
        )
          bad('Meta returned inventory under a different parent.', 'STATE_TARGET_MISMATCH');
        const native = Object.fromEntries(
          fields.map(field => [
            field,
            ['daily_budget', 'lifetime_budget', 'bid_amount'].includes(field) ? money(r[field]) : text(r[field]),
          ]),
        );
        return {
          id: r.id,
          name: native.name ?? r.id,
          entity,
          status: native.status,
          effective_status: native.effective_status,
          campaign_id: entity === 'campaign' ? r.id : r.campaign_id,
          adset_id: entity === 'adset' ? r.id : (r.adset_id ?? null),
          currency,
          timezone,
          native_money: Object.fromEntries(
            ['daily_budget', 'lifetime_budget', 'bid_amount'].filter(f => fields.includes(f)).map(f => [f, native[f]]),
          ),
          money_unit: 'exact Meta native integer; no currency conversion applied',
          native,
        };
      });
      if (body.paging !== undefined && !obj(body.paging)) invalid('Meta returned malformed paging metadata.');
      const paging = body.paging ?? {};
      if (paging.cursors !== undefined && !obj(paging.cursors)) invalid('Meta returned malformed cursor metadata.');
      if (paging.next !== undefined && (typeof paging.next !== 'string' || !paging.next))
        invalid('Meta returned malformed continuation metadata.');
      const more = paging.next !== undefined,
        next = paging.cursors?.after;
      if (more && (!cursorToken(next) || cursors.includes(fingerprint(next)) || page + 1 >= 100))
        invalid('Meta continuation is missing, repeated or exceeds 100 pages. Restart or use a narrower parent.');
      const active = current();
      if (entity !== 'campaign') {
        for (const parent of [config.campaign_id, config.adset_id].filter(Boolean))
          if (!store.ownsResource(active, account, parent))
            bad('Parent ownership expired during the read. Refresh its inventory page.', 'RESOURCE_SCOPE_REQUIRED');
        // Only after the entire page, account, hierarchy, continuation and current authorization have passed.
        for (const row of rows) store.rememberResource(active, account, row.id);
      }
      return {
        gateway,
        connection_id: connection.id,
        account_id: account,
        entity,
        rows,
        has_more: more,
        next_cursor: more
          ? encodeCursor(
              {
                version: 1,
                binding,
                after: next,
                page: page + 1,
                expires_at: expires,
                previous_ids: rows.map(r => r.id),
                seen_cursors: [...cursors, fingerprint(next)],
              },
              authorization,
            )
          : null,
        captured_at: Date.now(),
        currency,
        timezone,
        page_number: page + 1,
        meaning:
          'Current native inventory in provider order and default status visibility, not a point-in-time snapshot. Provider changes between pages can move, repeat or remove entities. Configured and effective status stay separate. Native money remains exact and unconverted. This read grants no write authority.',
      };
    });
  } finally {
    budget.close();
  }
}
