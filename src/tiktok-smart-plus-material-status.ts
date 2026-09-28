import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * Pausing and enabling creatives inside an Upgraded Smart+ ad, per API for Business v1.3 "Disable or enable creatives
 * in an Upgraded Smart+ Ad" and "Get Upgraded Smart+ Ads" (checked 2026-09-26): 1-20 ad material IDs of the ad,
 * never carousel and non-carousel creatives together. The ad read lists only explicitly selected creatives, so
 * automatically added ones are outside this contract.
 */
export const tiktokSmartPlusMaterialStatusPath = '/v1.3/smart_plus/ad/material_status/update/';
const getPath = '/v1.3/smart_plus/ad/get/';
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);

export const tiktokSmartPlusMaterialStatusKind = (p: CompiledRequest) =>
  p.gateway === 'tiktok_native_action' && p.method === 'POST' && p.path === tiktokSmartPlusMaterialStatusPath;

function invalid(field: string, message: string): never {
  throw new MirrorError('INVALID_TIKTOK_SMART_PLUS_MATERIAL_STATUS', message, {field});
}

/** Validates the request before review; nothing here reads or contacts TikTok. */
export function assertTiktokSmartPlusMaterialStatus(plan: CompiledRequest, body: JsonObject): void {
  const extra = Object.keys(body).find(
    k => !['advertiser_id', 'smart_plus_ad_id', 'ad_material_ids', 'operation_status'].includes(k),
  );
  if (extra) invalid(extra, '"' + extra + '" is outside the Smart+ creative status contract.');
  if (body.advertiser_id !== undefined && String(body.advertiser_id) !== plan.accountId)
    invalid('advertiser_id', 'advertiser_id must equal the selected advertiser.');
  if (!numeric(body.smart_plus_ad_id))
    invalid('smart_plus_ad_id', 'smart_plus_ad_id must be the numeric ID of an Upgraded Smart+ ad.');
  const ids = body.ad_material_ids;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 20 ||
    !ids.every(v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v)) ||
    new Set(ids).size !== ids.length
  )
    invalid(
      'ad_material_ids',
      'ad_material_ids must list 1-20 distinct ad material IDs from the ad, as /smart_plus/ad/get/ returns them.',
    );
  if (body.operation_status !== 'ENABLE' && body.operation_status !== 'DISABLE')
    invalid('operation_status', 'operation_status must be ENABLE or DISABLE.');
}
export function tiktokSmartPlusMaterialStatusRead(plan: CompiledRequest) {
  return {
    path: getPath,
    query: {
      advertiser_id: plan.accountId,
      filtering: {smart_plus_ad_ids: [(plan.body as JsonObject).smart_plus_ad_id]},
      page_size: 100,
    },
    action: 'tiktok_smart_plus_ad_get',
  };
}
const adOf = (plan: CompiledRequest, state: unknown[]) =>
  state
    .flatMap(s => (obj(s) && obj(s.data) && Array.isArray(s.data.list) ? s.data.list : []))
    .find((r: JsonObject) => String(r?.smart_plus_ad_id) === (plan.body as JsonObject).smart_plus_ad_id) as
    JsonObject | undefined;
const materialsOf = (row: JsonObject) =>
  (Array.isArray(row.creative_list) ? row.creative_list : []).filter(
    (c: JsonObject) => obj(c) && c.ad_material_id !== undefined && c.ad_material_id !== null,
  ) as JsonObject[];
/** Checked against the state read before review and again before execution. */
export function tiktokSmartPlusMaterialStatusPrerequisites(plan: CompiledRequest, values: unknown[]): void {
  if (!tiktokSmartPlusMaterialStatusKind(plan)) return;
  const b = plan.body as JsonObject,
    row = adOf(plan, values),
    ad = b.smart_plus_ad_id;
  if (!row)
    throw new MirrorError(
      'STATE_TARGET_MISMATCH',
      'Smart+ ad ' + ad + ' was not returned for the selected advertiser.',
      {smart_plus_ad_id: ad},
    );
  if (row.operation_status === 'FROZEN') invalid('smart_plus_ad_id', 'Smart+ ad ' + ad + ' is terminated (FROZEN).');
  const materials = materialsOf(row),
    chosen = (b.ad_material_ids as string[]).map(id => {
      const m = materials.find(c => String(c.ad_material_id) === id);
      if (!m)
        throw new MirrorError(
          'STATE_TARGET_MISMATCH',
          'Creative ' +
            id +
            ' is not an explicitly selected creative of ad ' +
            ad +
            '; automatically added creatives are not managed here.',
          {ad_material_id: id},
        );
      return m;
    });
  const carousel = chosen.map(m => (obj(m.creative_info) ? m.creative_info.ad_format : undefined) === 'CAROUSEL_ADS');
  if (carousel.some(Boolean) && !carousel.every(Boolean))
    invalid(
      'ad_material_ids',
      'Send carousel and non-carousel creatives in separate requests; TikTok does not accept them together.',
    );
}
export function tiktokSmartPlusMaterialStatusImpact(plan: CompiledRequest, state: unknown[]): JsonObject {
  const b = plan.body as JsonObject,
    row = adOf(plan, state) ?? {},
    status = b.operation_status as string,
    ids = b.ad_material_ids as string[],
    materials = materialsOf(row);
  const changes = ids.map(id => {
    const m = materials.find(c => String(c.ad_material_id) === id);
    return {
      ad_material_id: id,
      tiktok_item_id: obj(m?.creative_info) ? (m.creative_info.tiktok_item_id ?? null) : null,
      before: m?.material_operation_status ?? null,
      after: status,
    };
  });
  const enabledAfter = materials.filter(m =>
    ids.includes(String(m.ad_material_id)) ? status === 'ENABLE' : m.material_operation_status === 'ENABLE',
  ).length;
  return {
    provider: 'tiktok',
    scope: 'smart_plus_material_status',
    may_affect_serving: row.operation_status === 'ENABLE' && changes.some(c => c.before !== c.after),
    effect:
      (status === 'ENABLE'
        ? 'Turns the listed creatives on; they deliver while the ad is on.'
        : 'Turns the listed creatives off in this ad; nothing is deleted.') +
      (enabledAfter === 0 ? ' No explicitly selected creative of the ad stays on.' : ''),
    ad: {
      smart_plus_ad_id: b.smart_plus_ad_id,
      operation_status: row.operation_status ?? null,
      selected_creatives: materials.length,
      enabled_after: enabledAfter,
    },
    creatives: changes,
    source: 'https://business-api.tiktok.com/portal/docs/disable-or-enable-creatives-in-an-upgraded-smart-ad/v1.3',
  };
}
/** The receipt must name every requested creative with the requested status. */
export function tiktokSmartPlusMaterialStatusOutcome(plan: CompiledRequest, d: JsonObject): boolean {
  const b = plan.body as JsonObject,
    data = obj(d.data) ? d.data : {},
    got = Array.isArray(data.ad_material_ids) ? data.ad_material_ids.map(String).sort() : [],
    want = [...(b.ad_material_ids as string[])].sort();
  const status = data.operation_status ?? data.material_status;
  return JSON.stringify(got) === JSON.stringify(want) && (status === undefined || status === b.operation_status);
}
export function tiktokSmartPlusMaterialStatusVerification(plan: CompiledRequest) {
  const b = plan.body as JsonObject,
    id = b.smart_plus_ad_id as string;
  return [
    {
      path: getPath,
      query: {advertiser_id: plan.accountId, filtering: {smart_plus_ad_ids: [id]}, page_size: 100},
      expected: {
        smart_plus_ad_id: id,
        material_statuses: Object.fromEntries((b.ad_material_ids as string[]).map(m => [m, b.operation_status])),
      },
      id,
    },
  ];
}
