import {createHmac, timingSafeEqual} from 'node:crypto';
import {bad, fingerprint, obj, validate, type ToolCall} from './workspace-core.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';

const gateway = 'snapchat_native_action',
  origin = 'https://adsapi.snapchat.com',
  sort = 'created_at-desc';
const nativeId = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const invalid = (message: string): never => bad(message, 'PORTFOLIO_INVALID_RESPONSE');
const token = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\x00-\x20\x7f]/.test(v);
const success = (v: unknown) => typeof v === 'string' && v.toUpperCase() === 'SUCCESS';
const observation = (entity: string, id: string) => 'portfolio/snapchat/' + entity + '/' + id;
const sign = (v: JsonObject, key: string) => createHmac('sha256', key).update(fingerprint(v)).digest('hex');
const groups: Record<string, string> = {campaign: 'campaigns', adsquad: 'adsquads', ad: 'ads'};
function text(v: unknown, max = 2000): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > max) invalid('Snapchat returned a malformed inventory text field.');
  return v as string;
}
function money(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (
    (typeof v === 'string' && /^(?:0|[1-9][0-9]{0,29})$/.test(v)) ||
    (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)
  )
    return String(v);
  return invalid('Snapchat returned a money value without an exact nonnegative integer in micros.');
}
function deliveries(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 50 || v.some(s => typeof s !== 'string' || !s || s.length > 100))
    invalid('Snapchat returned malformed delivery status codes.');
  return v as string[];
}
function unwrap(d: JsonObject, group: string, limit: number): JsonObject[] {
  if (!Array.isArray(d[group]) || d[group].length > limit)
    invalid('Snapchat did not return a bounded inventory collection.');
  return d[group].map((w: unknown) => {
    if (!obj(w) || !success(w.sub_request_status) || w.error || !obj(w[group.slice(0, -1)]))
      invalid('Snapchat returned a failed or malformed inventory item.');
    return (w as JsonObject)[group.slice(0, -1)];
  });
}

/** Current hierarchy only. Qualified parent observations supplement native ownership; they grant no write access. */
export async function snapchatPortfolioPage(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  const config = input.requirements ?? {};
  validate(config, ['entity', 'campaign_id', 'ad_squad_id']);
  const entity = config.entity ?? 'campaign',
    limit = input.limit ?? 50,
    account = input.account_id;
  if (!Object.hasOwn(groups, entity)) bad('For Snapchat choose campaign, adsquad or ad.');
  if (!Number.isInteger(limit) || limit < 50 || limit > 100)
    bad('Snapchat portfolio pages contain 50–100 entities, matching its native minimum.');
  if (!nativeId(account)) bad('Choose an exact Snapchat account UUID.');
  if (
    (entity === 'campaign' && (config.campaign_id !== undefined || config.ad_squad_id !== undefined)) ||
    (entity !== 'campaign' && !nativeId(config.campaign_id)) ||
    (entity === 'adsquad' && config.ad_squad_id !== undefined) ||
    (entity === 'ad' && !nativeId(config.ad_squad_id))
  )
    bad('Choose the exact campaign, and for ads its exact ad squad.');
  const connection = store.resolveConnection(actor, gateway, account, input.connection_id),
    authorization = fingerprint(store.connectionCredentials(connection));
  const current = () => {
    const c = store.resolveConnection(actor, gateway, account, connection.id);
    if (!c.scopes.includes('snapchat-marketing-api'))
      bad('This login requires Snapchat Marketing API permission.', 'INSUFFICIENT_SCOPE');
    if (fingerprint(store.connectionCredentials(c)) !== authorization)
      bad('The Snapchat login changed. Restart inventory.', 'REAUTHORIZATION_REQUIRED');
    return c;
  };
  const assertParents = () => {
    const c = current();
    for (const [kind, id] of [
      ['campaign', config.campaign_id],
      ['adsquad', config.ad_squad_id],
    ])
      if (
        id &&
        (!store.ownsResource(c, account, observation(kind, id)) ||
          !store.ownsResource(c, account, groups[kind]! + '/' + id))
      )
        bad(
          'Read the parent Snapchat portfolio with this login first. Qualified observations last five minutes.',
          'RESOURCE_SCOPE_REQUIRED',
        );
    return c;
  };
  assertParents();
  const binding = fingerprint({
    tenant: actor.tenantId,
    user: actor.userId,
    gateway,
    version: 'v1',
    connection: connection.id,
    account,
    entity,
    config,
    limit,
    authorization,
  });
  let after: string | undefined,
    page = 0,
    expires = Date.now() + 300000,
    previous: string[] = [],
    seen: string[] = [];
  if (input.cursor !== undefined) {
    try {
      if (
        typeof input.cursor !== 'string' ||
        input.cursor.length > 24000 ||
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
        !token(c.after) ||
        !Number.isInteger(c.page) ||
        c.page < 1 ||
        c.page >= 100 ||
        !Number.isSafeInteger(c.expires_at) ||
        c.expires_at <= Date.now() ||
        c.expires_at > Date.now() + 300000 ||
        !Array.isArray(c.previous) ||
        c.previous.length > limit ||
        !c.previous.every(nativeId) ||
        new Set(c.previous).size !== c.previous.length ||
        !Array.isArray(c.seen) ||
        c.seen.length !== c.page ||
        c.seen.some((v: unknown) => typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) ||
        new Set(c.seen).size !== c.seen.length ||
        c.seen.at(-1) !== fingerprint(c.after)
      )
        throw Error();
      after = c.after;
      page = c.page;
      expires = c.expires_at;
      previous = c.previous;
      seen = c.seen;
    } catch {
      bad(
        'Restart this account, login, hierarchy and page size; the Snapchat cursor is invalid or expired.',
        'INVALID_CURSOR',
      );
    }
  }
  const budget = new ReportCollectionBudget(undefined, binding, () => {}, {
    requests: 8,
    rows: 100,
    bytes: 8 * 1024 * 1024,
    elapsed_ms: 60000,
  });
  const read = async (action: string, path: JsonObject, query: JsonObject = {}) => {
    current();
    const r = await call(
      gateway,
      {action, account_id: account, connection_id: connection.id, path_params: path, query, dry_run: false},
      actor,
    );
    current();
    if (!r.success) bad(r.error?.message ?? 'Snapchat inventory read failed.', r.error?.code ?? 'PORTFOLIO_FAILED');
    const d = r.data?.data;
    if (r.data?.truncated || !obj(d) || !success(d.request_status) || d.error || d.truncated)
      invalid('Snapchat returned an incomplete or failed inventory response.');
    if (d.paging !== undefined && !obj(d.paging)) invalid('Snapchat returned malformed paging metadata.');
    return d as JsonObject;
  };
  const one = async (action: string, path: JsonObject, group: string, id: string) => {
    const d = await read(action, path),
      rows = unwrap(d, group, 1);
    if (rows.length !== 1 || rows[0]!.id !== id || d.paging?.next_link !== undefined)
      invalid('Snapchat did not confirm the exact requested account or parent.');
    return rows[0]!;
  };
  try {
    return await budget.run(async () => {
      const metadata = await one('snapchat_account_get', {ad_account_id: account}, 'adaccounts', account),
        currency = text(metadata.currency, 3),
        timezone = text(metadata.timezone, 100);
      if (currency !== null && !/^[A-Z]{3}$/.test(currency)) invalid('Snapchat returned an invalid account currency.');
      if (entity !== 'campaign') {
        const parent = await one(
          'snapchat_campaign_get',
          {campaign_id: config.campaign_id},
          'campaigns',
          config.campaign_id,
        );
        if (parent.ad_account_id !== account)
          bad('Snapchat campaign belongs to another account.', 'STATE_TARGET_MISMATCH');
      }
      if (entity === 'ad') {
        const parent = await one(
          'snapchat_adsquad_get',
          {ad_squad_id: config.ad_squad_id},
          'adsquads',
          config.ad_squad_id,
        );
        if (
          parent.campaign_id !== config.campaign_id ||
          (parent.ad_account_id !== undefined && parent.ad_account_id !== account)
        )
          bad('Snapchat ad squad belongs to another campaign or account.', 'STATE_TARGET_MISMATCH');
      }
      const path =
        entity === 'campaign'
          ? '/v1/adaccounts/' + account + '/campaigns'
          : entity === 'adsquad'
            ? '/v1/campaigns/' + config.campaign_id + '/adsquads'
            : '/v1/adsquads/' + config.ad_squad_id + '/ads';
      const d = await read(
        entity === 'campaign'
          ? 'snapchat_campaign_list'
          : entity === 'adsquad'
            ? 'snapchat_campaign_adsquad_list'
            : 'snapchat_adsquad_ads_list',
        entity === 'campaign'
          ? {ad_account_id: account}
          : entity === 'adsquad'
            ? {campaign_id: config.campaign_id}
            : {ad_squad_id: config.ad_squad_id},
        {limit, sort, ...(after ? {cursor: after} : {})},
      );
      const raw = unwrap(d, groups[entity]!, limit),
        ids = new Set<string>();
      budget.rows('entities', raw.length);
      const rows = raw.map(row => {
        if (!nativeId(row.id) || ids.has(row.id) || previous.includes(row.id))
          invalid('Snapchat returned a missing, malformed or repeated inventory ID.');
        ids.add(row.id);
        if (
          (entity === 'campaign' && row.ad_account_id !== account) ||
          (row.ad_account_id !== undefined && row.ad_account_id !== account) ||
          (entity === 'adsquad' && row.campaign_id !== config.campaign_id) ||
          (entity === 'ad' &&
            (row.ad_squad_id !== config.ad_squad_id ||
              (row.campaign_id !== undefined && row.campaign_id !== config.campaign_id)))
        )
          bad('Snapchat inventory belongs to a different account or parent.', 'STATE_TARGET_MISMATCH');
        const amountKeys =
          entity === 'campaign'
            ? ['daily_budget_micro', 'lifetime_spend_cap_micro']
            : entity === 'adsquad'
              ? ['daily_budget_micro', 'lifetime_budget_micro', 'bid_micro']
              : [];
        const nativeMoney = Object.fromEntries(amountKeys.map(key => [key, money(row[key])])),
          delivery = deliveries(row.delivery_status);
        if (row.creative_id !== undefined && !nativeId(row.creative_id))
          invalid('Snapchat returned a malformed creative ID.');
        const native = {
          id: row.id,
          name: text(row.name),
          status: text(row.status, 100),
          review_status: text(row.review_status, 100),
          delivery_status: delivery,
          ad_account_id: row.ad_account_id ?? null,
          campaign_id: row.campaign_id ?? null,
          ad_squad_id: row.ad_squad_id ?? null,
          created_at: text(row.created_at, 100),
          updated_at: text(row.updated_at, 100),
          type: text(row.type, 100),
          objective: text(row.objective, 100),
          optimization_goal: text(row.optimization_goal, 100),
          creative_id: row.creative_id ?? null,
          ...nativeMoney,
        };
        return {
          id: row.id,
          name: native.name ?? row.id,
          entity,
          status: native.status,
          review_status: native.review_status,
          delivery_status: delivery,
          campaign_id: entity === 'campaign' ? row.id : config.campaign_id,
          ad_squad_id: entity === 'adsquad' ? row.id : (config.ad_squad_id ?? null),
          currency,
          timezone,
          native_money: nativeMoney,
          money_unit: 'micros',
          native,
        };
      });
      let next: string | undefined;
      if (d.paging?.next_link !== undefined) {
        try {
          const link = d.paging.next_link;
          if (typeof link !== 'string' || !link || link.length > 8192) throw Error();
          const u = new URL(link);
          if (
            u.origin !== origin ||
            u.username ||
            u.password ||
            u.hash ||
            u.pathname !== path ||
            [...u.searchParams.keys()].some(
              k => !['cursor', 'limit', 'sort'].includes(k) || u.searchParams.getAll(k).length !== 1,
            ) ||
            (u.searchParams.has('limit') && u.searchParams.get('limit') !== String(limit)) ||
            (u.searchParams.has('sort') && u.searchParams.get('sort') !== sort) ||
            !token(u.searchParams.get('cursor'))
          )
            throw Error();
          next = u.searchParams.get('cursor')!;
        } catch {
          invalid('Snapchat continuation changed origin, hierarchy, query or page size.');
        }
        if (seen.includes(fingerprint(next)) || page + 1 >= 100)
          invalid('Snapchat continuation repeats or exceeds 100 pages. Narrow the hierarchy.');
      }
      const active = assertParents();
      budget.check();
      for (const row of rows) {
        store.rememberResource(active, account, observation(entity, row.id));
        store.rememberResource(active, account, groups[entity]! + '/' + row.id);
      }
      const continuation = {
        version: 1,
        binding,
        after: next,
        page: page + 1,
        expires_at: expires,
        previous: rows.map(r => r.id),
        seen: next ? [...seen, fingerprint(next)] : seen,
      };
      return {
        gateway,
        connection_id: connection.id,
        account_id: account,
        entity,
        rows,
        currency,
        timezone,
        has_more: next !== undefined,
        next_cursor: next
          ? Buffer.from(JSON.stringify({...continuation, signature: sign(continuation, authorization)})).toString(
              'base64url',
            )
          : null,
        page_number: page + 1,
        captured_at: Date.now(),
        sort,
        meaning:
          'Current Snapchat inventory in created-at descending order with provider default visibility, not a point-in-time or complete deleted-entity snapshot. Native money remains exact micros. Configured status, review status and delivery codes are independent and do not establish actual delivery. Only the opaque continuation token is reused on the fixed authorized native route. This read grants no write authority.',
      };
    });
  } finally {
    budget.close();
  }
}
