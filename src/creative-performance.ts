import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {bad, fingerprint, identifier} from './workspace-core.js';
import {normalizeAccount} from './scope.js';

const projection = `SELECT id,json_object('gateway',json_extract(data,'$.gateway'),
  'account_id',json_extract(data,'$.account_id'),'connection_id',json_extract(data,'$.connection_id'),
  'captured_at',json_extract(data,'$.captured_at'),'source_hash',json_extract(data,'$.source_hash'),
  'semantics',json_extract(data,'$.semantics'),'row_count',json_array_length(data,'$.rows')) AS metadata
  FROM documents WHERE tenant_id=? AND kind='decision_report' AND json_extract(data,'$.preset')='meta_ad'
  AND json_extract(data,'$.grain')='ad × day' AND json_extract(data,'$.source')='provider_read'
  AND json_extract(data,'$.gateway')='meta_native_action'
  AND json_extract(data,'$.account_id')=? AND json_extract(data,'$.connection_id')=?`;
export function creativePerformance(
  store: Store,
  actor: Actor,
  input: JsonObject,
  asset: JsonObject,
  readUsage: () => JsonObject,
) {
  if (asset.platform !== 'meta')
    bad('Linked-ad performance currently requires a Meta asset and a guided Meta ad snapshot.');
  const limit = input.limit ?? 30;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) bad('Use a page size of 1–100.');
  const params = [actor.tenantId, normalizeAccount('meta_native_action', asset.account_id), asset.connection_id];
  const metadata = (row: any) => ({id: row.id, ...JSON.parse(row.metadata)});
  if (input.report_id === undefined) {
    const bound = fingerprint({
      asset_id: asset.asset_id,
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
  if (!row) bad('Choose an accessible guided Meta ad report from the same account and login.', 'REPORT_SCOPE_MISMATCH');
  const meta = metadata(row),
    usage = readUsage().usage.find((p: JsonObject) => p.plan_id === planId);
  const adIds = new Set<string>(
    (usage?.steps ?? [])
      .filter(
        (s: JsonObject) =>
          s.entity_type === 'ad' &&
          s.gateway === 'meta_native_action' &&
          s.connection_id === asset.connection_id &&
          normalizeAccount(s.gateway, s.account_id) === params[1],
      )
      .flatMap((s: JsonObject) => s.resource_ids),
  );
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
