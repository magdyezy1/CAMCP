import {createHmac, timingSafeEqual} from 'node:crypto';
import {bad, fingerprint, obj, validate, type ToolCall} from './workspace-core.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';

const gateway = 'x_ads_native_action';
const nativeId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9]{1,32}$/.test(v);
const token = (v: unknown): v is string => typeof v === 'string' && /^[\x21-\x7e]{1,2048}$/.test(v);
const invalid = (message: string): never => bad(message, 'PORTFOLIO_INVALID_RESPONSE');
const sign = (value: JsonObject, key: string) => createHmac('sha256', key).update(fingerprint(value)).digest('hex');
const moneyFields = [
  'daily_budget_amount_local_micro',
  'total_budget_amount_local_micro',
  'bid_amount_local_micro',
  'target_cpa_local_micro',
];
const fields: Record<string, string[]> = {
  campaign: [
    'id',
    'name',
    'entity_status',
    'effective_status',
    'servable',
    'reasons_not_servable',
    'daily_budget_amount_local_micro',
    'total_budget_amount_local_micro',
    'budget_optimization',
    'currency',
    'created_at',
    'updated_at',
    'deleted',
  ],
  line_item: [
    'id',
    'campaign_id',
    'name',
    'entity_status',
    'objective',
    'product_type',
    'bid_strategy',
    'daily_budget_amount_local_micro',
    'total_budget_amount_local_micro',
    'bid_amount_local_micro',
    'target_cpa_local_micro',
    'currency',
    'placements',
    'start_time',
    'end_time',
    'created_at',
    'updated_at',
    'deleted',
  ],
  promoted_tweet: [
    'id',
    'line_item_id',
    'tweet_id',
    'entity_status',
    'approval_status',
    'created_at',
    'updated_at',
    'deleted',
  ],
};
const resources: Record<string, string> = {
  campaign: 'campaigns',
  line_item: 'line_items',
  promoted_tweet: 'promoted_tweets',
};
function text(v: unknown, max = 2000): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > max) return invalid('X returned a malformed inventory text field.');
  return v;
}
function money(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n) return v;
  return invalid('X returned an unsafe native integer money value.');
}
function currency(v: unknown) {
  const result = text(v, 3);
  if (result !== null && !/^[A-Z]{3}$/.test(result)) return invalid('X returned an invalid native currency.');
  return result;
}
function strings(v: unknown): string[] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length > 100 || v.some(s => typeof s !== 'string' || s.length > 200))
    return invalid('X returned malformed native status codes or placements.');
  return v;
}
function identity(v: unknown, account: string, id?: string): JsonObject {
  if (
    !obj(v) ||
    !nativeId(v.id) ||
    (id !== undefined && v.id !== id) ||
    (v.account_id !== undefined && v.account_id !== account) ||
    v.deleted !== false ||
    v.entity_status === 'DRAFT'
  )
    return invalid('X returned a foreign, deleted, draft or unidentified inventory entity.');
  return v;
}

/** Scoped Ads API v12 campaigns, line items and promoted Tweet associations, without post-content reads. */
export async function xPortfolioPage(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  const config = input.requirements ?? {};
  validate(config, ['entity', 'campaign_id', 'line_item_id']);
  const entity = config.entity ?? 'campaign',
    limit = input.limit ?? 50,
    account = input.account_id;
  if (!Object.hasOwn(fields, entity)) bad('For X choose campaign, line_item or promoted_tweet.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) bad('X portfolio pages contain 1–100 entities.');
  if (!nativeId(account)) bad('Choose an exact X advertising account ID.');
  if (
    (entity === 'campaign' && (config.campaign_id !== undefined || config.line_item_id !== undefined)) ||
    (entity !== 'campaign' && !nativeId(config.campaign_id)) ||
    (entity === 'line_item' && config.line_item_id !== undefined) ||
    (entity === 'promoted_tweet' && !nativeId(config.line_item_id))
  )
    bad('Choose the exact campaign, and for promoted posts its exact line item.');
  const connection = store.resolveConnection(actor, gateway, account, input.connection_id);
  const authorization = fingerprint({
    credentials: store.connectionCredentials(connection),
    scopes: [...connection.scopes].sort(),
  });
  const current = () => {
    const c = store.resolveConnection(actor, gateway, account, connection.id);
    if (fingerprint({credentials: store.connectionCredentials(c), scopes: [...c.scopes].sort()}) !== authorization)
      bad('The X login or permissions changed. Restart inventory.', 'REAUTHORIZATION_REQUIRED');
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
    version: '12',
  });
  let page = 1,
    cursor: string | undefined,
    expires = Date.now() + 300000,
    previous: string[] = [],
    tokens: string[] = [];
  if (input.cursor !== undefined) {
    try {
      if (
        typeof input.cursor !== 'string' ||
        input.cursor.length > 20000 ||
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
        !token(c.cursor) ||
        !Number.isSafeInteger(c.expires_at) ||
        c.expires_at <= Date.now() ||
        c.expires_at > Date.now() + 300000 ||
        !Array.isArray(c.previous) ||
        c.previous.length > limit ||
        !c.previous.every(nativeId) ||
        new Set(c.previous).size !== c.previous.length ||
        !Array.isArray(c.tokens) ||
        c.tokens.length !== c.page - 1 ||
        !c.tokens.every((t: unknown) => typeof t === 'string' && /^[0-9a-f]{64}$/.test(t)) ||
        new Set(c.tokens).size !== c.tokens.length ||
        c.tokens.at(-1) !== fingerprint(c.cursor)
      )
        throw Error();
      page = c.page;
      cursor = c.cursor;
      expires = c.expires_at;
      previous = c.previous;
      tokens = c.tokens;
    } catch {
      bad(
        'Restart this account, login, hierarchy and page size; the X cursor is invalid or expired.',
        'INVALID_CURSOR',
      );
    }
  }
  current();
  const budget = new ReportCollectionBudget(undefined, binding, () => {}, {
    requests: 8,
    rows: 103,
    bytes: 8 * 1024 * 1024,
    elapsed_ms: 60000,
  });
  const read = async (action: string, path: JsonObject = {}, query: JsonObject = {}) => {
    current();
    const r = await call(
      gateway,
      {
        action,
        account_id: account,
        connection_id: connection.id,
        path_params: path,
        query,
        aggregate_pages: false,
        dry_run: false,
      },
      actor,
    );
    current();
    if (!r.success) bad(r.error?.message ?? 'X inventory read failed.', r.error?.code ?? 'PORTFOLIO_FAILED');
    const v = r.data?.data;
    if (
      r.data?.truncated ||
      !obj(v) ||
      v.error ||
      (v.errors !== undefined && (!Array.isArray(v.errors) || v.errors.length)) ||
      v.truncated ||
      v.partial ||
      !obj(v.request) ||
      !obj(v.request.params) ||
      v.request.params.account_id !== account ||
      ['next', 'next_token', 'next_page_token', 'nextLink', 'paging', 'pagination', 'has_more'].some(
        k => v[k] !== undefined,
      )
    )
      return invalid('X returned incomplete or unbound inventory evidence.');
    for (const [key, value] of Object.entries({...path, ...query})) {
      const echoed = v.request.params[key];
      if (
        echoed !== undefined &&
        !(
          (key.endsWith('_ids') && Array.isArray(echoed) && echoed.length === 1 && echoed[0] === value) ||
          echoed === value
        )
      )
        invalid('X returned conflicting inventory request bindings.');
    }
    return v;
  };
  const single = async (action: string, id: string, path: JsonObject = {}) => {
    const v = await read(action, path, {with_deleted: false});
    if (v.next_cursor !== undefined && v.next_cursor !== null) invalid('X returned incomplete single-entity evidence.');
    const row = identity(v.data, account, id);
    budget.rows('parent:' + action, 1);
    return row;
  };
  try {
    return await budget.run(async () => {
      const accountRow = await single('x_accounts_account_id_get', account);
      const timezone = text(accountRow.timezone, 100);
      let parentCurrency: string | null = null;
      if (entity !== 'campaign')
        await single('x_accounts_account_id_campaigns_campaign_id_get', config.campaign_id, {
          campaign_id: config.campaign_id,
        });
      if (entity === 'promoted_tweet') {
        const line = await single('x_accounts_account_id_line_items_line_item_id_get', config.line_item_id, {
          line_item_id: config.line_item_id,
        });
        if (line.campaign_id !== config.campaign_id) invalid('The X line item belongs to another campaign.');
        parentCurrency = currency(line.currency);
      }
      const query = {
        count: limit,
        with_deleted: false,
        ...(entity !== 'promoted_tweet' ? {with_draft: false} : {}),
        ...(entity === 'line_item' ? {campaign_ids: config.campaign_id} : {}),
        ...(entity === 'promoted_tweet' ? {line_item_ids: config.line_item_id} : {}),
        ...(cursor ? {cursor} : {}),
      };
      const v = await read('x_accounts_account_id_' + resources[entity] + '_get', {}, query);
      if (!Array.isArray(v.data) || v.data.length > limit || (v.next_cursor !== null && !token(v.next_cursor)))
        invalid('X did not return a bounded inventory page with explicit continuation.');
      budget.rows('inventory', v.data.length);
      if (v.next_cursor && tokens.includes(fingerprint(v.next_cursor)))
        invalid('X repeated an inventory continuation token.');
      const seen = new Set<string>();
      const rows = (v.data as unknown[]).map(value => {
        const row = identity(value, account);
        if (
          seen.has(row.id) ||
          previous.includes(row.id) ||
          (entity === 'line_item' && row.campaign_id !== config.campaign_id) ||
          (entity === 'promoted_tweet' &&
            (row.line_item_id !== config.line_item_id ||
              typeof row.tweet_id !== 'string' ||
              !/^[1-9][0-9]{0,24}$/.test(row.tweet_id)))
        )
          return invalid('X returned a foreign, duplicate or overlapping inventory entity.');
        seen.add(row.id);
        const native: JsonObject = {};
        for (const field of fields[entity]!) {
          if (moneyFields.includes(field)) native[field] = money(row[field]);
          else if (['servable', 'deleted'].includes(field)) {
            if (row[field] != null && typeof row[field] !== 'boolean')
              invalid('X returned a malformed native boolean.');
            native[field] = row[field] ?? null;
          } else if (['reasons_not_servable', 'placements'].includes(field)) native[field] = strings(row[field]);
          else if (field === 'currency') native[field] = currency(row[field]);
          else native[field] = text(row[field]);
        }
        return {
          id: row.id,
          name: native.name ?? native.tweet_id ?? row.id,
          entity,
          campaign_id: entity === 'campaign' ? row.id : config.campaign_id,
          line_item_id: entity === 'campaign' ? null : entity === 'line_item' ? row.id : config.line_item_id,
          tweet_id: native.tweet_id ?? null,
          status: native.entity_status,
          effective_status: native.effective_status ?? null,
          approval_status: native.approval_status ?? null,
          servable: native.servable ?? null,
          reasons_not_servable: native.reasons_not_servable ?? null,
          native_money: Object.fromEntries(
            moneyFields.filter(k => fields[entity]!.includes(k)).map(k => [k, native[k]]),
          ),
          currency: entity === 'promoted_tweet' ? parentCurrency : native.currency,
          timezone,
          native,
        };
      });
      if (v.next_cursor && page >= 100)
        bad('This X inventory reached its 100-page bound. Restart inventory.', 'PORTFOLIO_INCOMPLETE');
      const next = v.next_cursor
        ? {
            version: 1,
            binding,
            page: page + 1,
            cursor: v.next_cursor,
            previous: rows.map((r: JsonObject) => r.id),
            tokens: [...tokens, fingerprint(v.next_cursor)],
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
        has_more: !!next,
        next_cursor: next
          ? Buffer.from(JSON.stringify({...next, signature: sign(next, authorization)})).toString('base64url')
          : null,
        captured_at: Date.now(),
        meaning:
          'Current X campaign, line-item and promoted-post association inventory in provider order, excluding deleted and draft entities. Native micros stay exact and unconverted. Configured status, effective status, servability and approval are separate; none proves actual delivery. Post content, scheduled posts, promoted accounts and media creatives are outside this view. Provider changes can move or omit entities between pages; this is not a point-in-time snapshot. This read grants no write authority.',
      };
    });
  } finally {
    budget.close();
  }
}
