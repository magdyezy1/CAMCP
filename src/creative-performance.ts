import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {bad, fingerprint, identifier} from './workspace-core.js';
import {normalizeAccount} from './scope.js';

const scopes: Record<string, {gateway: string; preset: string; grain: string; actions: string[]}> = {
  meta: {
    gateway: 'meta_native_action',
    preset: 'meta_ad',
    grain: 'ad × day',
    actions: ['meta_ad_create', 'meta_ad_account_id_ads_create'],
  },
  google_ads: {
    gateway: 'google_ads_native_action',
    preset: 'google_ad',
    grain: 'ad group × ad × day',
    actions: ['google_ads_v23_ad_group_ad_mutate_ad_group_ads'],
  },
  snapchat: {
    gateway: 'snapchat_native_action',
    preset: 'snapchat_ad',
    grain: 'ad × day',
    actions: ['snapchat_ad_create'],
  },
  tiktok: {gateway: 'tiktok_native_action', preset: 'tiktok_ad', grain: 'ad × day', actions: ['tiktok_ad_create']},
};
export const linkedPerformanceSupported = (platform: string) => Object.hasOwn(scopes, platform);
export function linkedAdStep(gateway: string, action: string) {
  return Object.values(scopes).some(scope => scope.gateway === gateway && scope.actions.includes(action));
}
function exactAdId(platform: string, account: string, id: unknown): id is string {
  if (typeof id !== 'string') return false;
  if (platform === 'google_ads')
    return (
      /^[1-9][0-9]{0,19}$/.test(account) &&
      new RegExp('^customers/' + account + '/adGroupAds/[1-9][0-9]{0,19}~[1-9][0-9]{0,19}$').test(id)
    );
  if (platform === 'snapchat') return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
  return /^[0-9]{1,31}$/.test(id);
}
export function linkedPlanAdIds(asset: JsonObject, steps: JsonObject[]) {
  if (!linkedPerformanceSupported(asset.platform)) return [];
  const scope = scopes[asset.platform]!,
    account = normalizeAccount(scope.gateway, asset.account_id);
  return steps
    .filter(
      s =>
        s.entity_type === 'ad' &&
        s.gateway === scope.gateway &&
        s.connection_id === asset.connection_id &&
        normalizeAccount(s.gateway, s.account_id) === account,
    )
    .flatMap(s => s.resource_ids)
    .filter(id => exactAdId(asset.platform, account, id));
}

const projection = `SELECT id,json_object('gateway',json_extract(data,'$.gateway'),
  'preset',json_extract(data,'$.preset'),'grain',json_extract(data,'$.grain'),
  'account_id',json_extract(data,'$.account_id'),'connection_id',json_extract(data,'$.connection_id'),
  'captured_at',json_extract(data,'$.captured_at'),'source_hash',json_extract(data,'$.source_hash'),
  'semantics',json_extract(data,'$.semantics'),'row_count',json_array_length(data,'$.rows')) AS metadata
  FROM documents WHERE tenant_id=? AND kind='decision_report' AND json_extract(data,'$.preset')=?
  AND json_extract(data,'$.grain')=? AND json_extract(data,'$.source')='provider_read'
  AND json_extract(data,'$.gateway')=?
  AND json_extract(data,'$.account_id')=? AND json_extract(data,'$.connection_id')=?`;
export function creativePerformance(
  store: Store,
  actor: Actor,
  input: JsonObject,
  asset: JsonObject,
  readUsage: () => JsonObject,
) {
  const scope = scopes[asset.platform];
  if (!linkedPerformanceSupported(asset.platform) || !scope)
    bad(
      'Linked-ad performance requires a Meta, Google Ads, Snapchat or standard TikTok asset and its compatible guided ad snapshot.',
    );
  const limit = input.limit ?? 30;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) bad('Use a page size of 1–100.');
  const account = normalizeAccount(scope.gateway, asset.account_id),
    params = [actor.tenantId, scope.preset, scope.grain, scope.gateway, account, asset.connection_id];
  const metadata = (row: any) => ({id: row.id, ...JSON.parse(row.metadata)});
  if (input.report_id === undefined) {
    const bound = fingerprint({
      asset_id: asset.asset_id,
      gateway: scope.gateway,
      account_id: account,
      connection_id: asset.connection_id,
      preset: scope.preset,
      grain: scope.grain,
      ...Object.fromEntries(['tenantId', 'userId', 'role'].map(k => [k, actor[k as keyof Actor]])),
      session: store.sessionIdentity(actor) ?? null,
    });
    let after = '';
    if (input.cursor !== undefined) {
      try {
        const c = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
        if (c.version !== 1 || c.binding !== bound) throw Error();
        after = identifier(c.after);
      } catch {
        bad('Refresh the performance choices for this identity and asset.', 'INVALID_CURSOR');
      }
    }
    const rows = store.db.prepare(projection + ' AND id>? ORDER BY id LIMIT ?').all(...params, after, limit + 1);
    const reports = rows.slice(0, limit).map(metadata),
      more = rows.length > limit;
    return {
      reports,
      has_more: more,
      next_cursor: more
        ? Buffer.from(JSON.stringify({version: 1, binding: bound, after: reports.at(-1)!.id})).toString('base64url')
        : null,
      network_requests: 0,
    };
  }
  const reportId = identifier(input.report_id, 'report_id'),
    planId = identifier(input.plan_id, 'plan_id');
  const row = store.db.prepare(projection + ' AND id=?').get(...params, reportId);
  if (!row)
    bad(
      'Choose an accessible compatible guided ad report from the same provider, account and login.',
      'REPORT_SCOPE_MISMATCH',
    );
  const meta = metadata(row),
    usage = readUsage().usage.find((p: JsonObject) => p.plan_id === planId);
  const adIds = new Set<string>(linkedPlanAdIds(asset, usage?.steps ?? []));
  if (!adIds.size)
    bad(
      'This plan has no currently accessible, verified ad reference to the selected asset.',
      'CREATIVE_USAGE_REQUIRED',
    );
  const report = store.document(actor.tenantId, 'decision_report', reportId);
  if (!Array.isArray(report.rows) || report.rows.length > 10000) bad('Choose a bounded guided ad snapshot.');
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) bad('Use a nonnegative performance offset.');
  const matched = report.rows.filter((r: JsonObject) => adIds.has(r.entity_id));
  const fields = [
    'entity_id',
    'entity_name',
    'date',
    'spend',
    'impressions',
    'clicks',
    'conversions',
    'conversion_value',
    'reach',
    'frequency',
  ];
  return {
    ...meta,
    report_id: reportId,
    plan_id: planId,
    asset_id: asset.asset_id,
    platform: asset.platform,
    rows: matched
      .slice(offset, offset + limit)
      .map((r: JsonObject) => Object.fromEntries(fields.map(k => [k, r[k] ?? null]))),
    row_count: matched.length,
    offset,
    next_offset: offset + limit < matched.length ? offset + limit : null,
    matched_ad_ids: [...new Set(matched.map((r: JsonObject) => r.entity_id))],
    plan_ad_ids_without_rows: [...adIds].filter(id => !matched.some((r: JsonObject) => r.entity_id === id)),
    report_path: '/reports?id=' + encodeURIComponent(reportId),
    network_requests: 0,
    historical_creative_assignment: 'not_established',
    limitations: [
      'These are performance rows for exact ad IDs linked by the retained verified plan, not an allocation of results to an individual image.',
      'The retained plan does not establish that the same creative served for the entire reporting window; later external edits and dynamic creative combinations remain unverified.',
      'No matching row is missing evidence, not proof of zero delivery. Attribution, currency, timezone and completeness remain those of the selected snapshot.',
    ],
  };
}
