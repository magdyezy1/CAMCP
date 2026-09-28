import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

/**
 * Account-level TikTok brand safety, per API for Business v1.3 "Update the Pangle block list", "Get the Pangle block
 * list", "Set or update the Brand Safety Hub settings of an ad account" and "Get the Brand Safety Hub settings of an ad
 * account" (checked 2026-09-26).
 * - The Pangle block list keeps the advertiser's ads off listed apps (iTunes IDs for iOS, package names for Android). An
 *   update adds and deletes apps, or clears the list and adds; the response counts only added apps.
 * - The Brand Safety Hub sets the account's default inventory filter tier, content category exclusions and vertical
 *   sensitivity. It applies to future Upgraded Smart+ campaigns, not to regular campaigns. The three settings are sent
 *   together; exclusions and sensitivity apply only to the standard and limited tiers; and once the settings cover all
 *   objectives, that cannot be turned back off.
 */
export const tiktokBrandSafetyPaths = {
  pangle: '/v1.3/pangle_block_list/update/',
  hub: '/v1.3/tiktok_inventory_filters/update/',
};
const reads = {
  pangle: {path: '/v1.3/pangle_block_list/get/', action: 'tiktok_pangle_block_list_get'},
  hub: {path: '/v1.3/tiktok_inventory_filters/get/', action: 'tiktok_tiktok_inventory_filters_get'},
};
const tiers = ['EXPANDED_INVENTORY', 'STANDARD_INVENTORY', 'LIMITED_INVENTORY'],
  maxApps = 1000,
  numeric = /^[1-9]\d*$/;
const iosApp = /^[1-9]\d{3,11}$/,
  androidApp = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
type Kind = 'pangle' | 'hub';
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function fail(code: string, message: string, details: JsonObject = {}): never {
  throw new MirrorError(code, message, details);
}
function invalid(message: string): never {
  return fail('INVALID_TIKTOK_BRAND_SAFETY', message);
}
export function tiktokBrandSafetyKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== 'tiktok_native_action' || p.method !== 'POST') return;
  return p.path === tiktokBrandSafetyPaths.pangle
    ? 'pangle'
    : p.path === tiktokBrandSafetyPaths.hub
      ? 'hub'
      : undefined;
}
function apps(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > maxApps ||
    value.some(a => typeof a !== 'string' || !(iosApp.test(a) || androidApp.test(a))) ||
    new Set(value).size !== value.length
  )
    invalid(
      field +
        ' must list up to ' +
        maxApps +
        ' distinct apps: iTunes IDs for iOS or package names such as com.example.game for Android.',
    );
  return value as string[];
}
type Pangle = {add: string[]; remove: string[]; clear: boolean};
type Hub = {cover: boolean; tier?: string; categories?: string[]; vertical?: string};
function edit(p: CompiledRequest): {kind: Kind; pangle?: Pangle; hub?: Hub} {
  const kind = tiktokBrandSafetyKind(p)!,
    b = obj(p.body) ? p.body : {};
  if (!obj(p.body)) invalid('Provide the native request object.');
  if (String(b.advertiser_id) !== p.accountId)
    fail('ACCOUNT_SCOPE_MISMATCH', 'advertiser_id must be the selected advertiser.');
  if (kind === 'pangle') {
    if (Object.keys(b).some(k => !['advertiser_id', 'add_app_list', 'delete_app_list', 'clear_old_app'].includes(k)))
      invalid('The Pangle block list update takes add_app_list, delete_app_list and clear_old_app only.');
    if (b.clear_old_app !== undefined && typeof b.clear_old_app !== 'boolean')
      invalid('clear_old_app must be a boolean.');
    const add = apps(b.add_app_list, 'add_app_list'),
      remove = apps(b.delete_app_list, 'delete_app_list'),
      clear = b.clear_old_app === true;
    if (clear && remove.length)
      invalid(
        'clear_old_app replaces the whole list; delete_app_list would be ignored. Send only the apps to keep in add_app_list.',
      );
    if (!add.length && !remove.length && !clear) invalid('Add or delete at least one app, or clear the list.');
    if (add.some(a => remove.includes(a))) invalid('An app cannot be added and deleted in the same review.');
    return {kind, pangle: {add, remove, clear}};
  }
  if (
    Object.keys(b).some(
      k =>
        ![
          'advertiser_id',
          'cover_all_ad_objectives',
          'brand_safety_type',
          'category_exclusion_ids',
          'vertical_sensitivity_id',
        ].includes(k),
    )
  )
    invalid(
      'The Brand Safety Hub update takes cover_all_ad_objectives, brand_safety_type, category_exclusion_ids and vertical_sensitivity_id only.',
    );
  if (typeof b.cover_all_ad_objectives !== 'boolean')
    invalid('cover_all_ad_objectives is required and must be a boolean.');
  const settings = ['brand_safety_type', 'category_exclusion_ids', 'vertical_sensitivity_id'].filter(
    k => b[k] !== undefined,
  );
  if (!settings.length) return {kind, hub: {cover: b.cover_all_ad_objectives}};
  if (!tiers.includes(b.brand_safety_type))
    invalid(
      'brand_safety_type must be EXPANDED_INVENTORY, STANDARD_INVENTORY or LIMITED_INVENTORY, sent together with the other settings.',
    );
  if (b.brand_safety_type === 'EXPANDED_INVENTORY') {
    if (b.category_exclusion_ids !== undefined || b.vertical_sensitivity_id !== undefined)
      invalid('Category exclusions and vertical sensitivity apply only to STANDARD_INVENTORY and LIMITED_INVENTORY.');
    return {kind, hub: {cover: b.cover_all_ad_objectives, tier: b.brand_safety_type}};
  }
  if (
    !Array.isArray(b.category_exclusion_ids) ||
    b.category_exclusion_ids.some((id: unknown) => typeof id !== 'string' || !numeric.test(id)) ||
    new Set(b.category_exclusion_ids).size !== b.category_exclusion_ids.length
  )
    invalid(
      'category_exclusion_ids must list distinct category IDs from /tool/content_exclusion/get/ (an empty list excludes none).',
    );
  if (typeof b.vertical_sensitivity_id !== 'string' || !numeric.test(b.vertical_sensitivity_id))
    invalid(
      'vertical_sensitivity_id must be a vertical category ID from /tool/content_exclusion/get/; TikTok needs the three settings together.',
    );
  return {
    kind,
    hub: {
      cover: b.cover_all_ad_objectives,
      tier: b.brand_safety_type,
      categories: [...b.category_exclusion_ids].sort(),
      vertical: b.vertical_sensitivity_id,
    },
  };
}
export function assertTiktokBrandSafety(p: CompiledRequest): void {
  if (!tiktokBrandSafetyKind(p)) return;
  if (Object.keys(p.query).length) invalid('Brand safety reviews take no query parameters.');
  edit(p);
}
export function tiktokBrandSafetyReads(p: CompiledRequest): CompiledRequest[] {
  const kind = tiktokBrandSafetyKind(p)!,
    r = reads[kind];
  return [
    {
      ...p,
      action: r.action,
      method: 'GET',
      path: r.path,
      query: {advertiser_id: p.accountId},
      body: undefined,
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      responseControls: undefined,
      specialTransport: undefined,
      tiktokBrandSafetyState: kind,
    },
  ];
}
export function isTiktokBrandSafetyRead(p: CompiledRequest): boolean {
  return p.gateway === 'tiktok_native_action' && !!p.tiktokBrandSafetyState;
}
export function validateTiktokBrandSafetyState(read: CompiledRequest, result: TransportResult): void {
  const d = obj(result.data) ? result.data : {};
  if (result.status !== 200 || d.code !== 0 || !obj(d.data))
    fail('STATE_READ_FAILED', 'TikTok must confirm the brand safety settings read.');
  if (
    read.tiktokBrandSafetyState === 'pangle' &&
    d.data.app_list !== undefined &&
    (!Array.isArray(d.data.app_list) || d.data.app_list.some((a: unknown) => typeof a !== 'string'))
  )
    fail('STATE_READ_FAILED', 'The Pangle block list must be a list of app identifiers.');
  if (
    read.tiktokBrandSafetyState === 'hub' &&
    ((d.data.cover_all_ad_objectives !== undefined && typeof d.data.cover_all_ad_objectives !== 'boolean') ||
      (d.data.category_exclusion_ids !== undefined && !Array.isArray(d.data.category_exclusion_ids)))
  )
    fail('STATE_READ_FAILED', 'The Brand Safety Hub settings are malformed.');
}
const data = (v: unknown): JsonObject => (obj(v) && obj(v.data) ? v.data : {});
const appList = (v: unknown): string[] => (Array.isArray(data(v).app_list) ? data(v).app_list : []).map(String);
/** The settings a read returns, in the shape verification compares. */
function hubSettings(v: unknown): JsonObject {
  const d = data(v);
  return {
    cover_all_ad_objectives: d.cover_all_ad_objectives === true,
    brand_safety_type: d.brand_safety_type ?? null,
    category_exclusion_ids: Array.isArray(d.category_exclusion_ids) ? d.category_exclusion_ids.map(String).sort() : [],
    vertical_sensitivity_id:
      d.vertical_sensitivity_id == null || d.vertical_sensitivity_id === '' ? null : String(d.vertical_sensitivity_id),
  };
}
/** Stable review state: the sorted block list with its ID, or the hub settings. Frozen states are normalized again, so it accepts its own output. */
export function tiktokBrandSafetyState(read: CompiledRequest, value: JsonObject): JsonObject {
  return read.tiktokBrandSafetyState === 'pangle'
    ? {data: {app_list: [...new Set(appList(value))].sort(), app_package_id: data(value).app_package_id ?? null}}
    : {data: hubSettings(value)};
}
function expected(p: CompiledRequest, before: unknown): JsonObject {
  const e = edit(p);
  if (e.pangle) {
    const current = appList(before);
    return {
      apps: [
        ...new Set([...(e.pangle.clear ? [] : current.filter(a => !e.pangle!.remove.includes(a))), ...e.pangle.add]),
      ].sort(),
    };
  }
  const was = hubSettings(before),
    h = e.hub!;
  return {
    settings: {
      cover_all_ad_objectives: h.cover,
      ...(h.tier === undefined
        ? {
            brand_safety_type: was.brand_safety_type,
            category_exclusion_ids: was.category_exclusion_ids,
            vertical_sensitivity_id: was.vertical_sensitivity_id,
          }
        : {
            brand_safety_type: h.tier,
            category_exclusion_ids: h.categories ?? [],
            vertical_sensitivity_id: h.vertical ?? null,
          }),
    },
  };
}
export function validateTiktokBrandSafetyPrerequisites(plan: CompiledRequest, state: unknown[]): void {
  if (!tiktokBrandSafetyKind(plan)) return;
  const e = edit(plan),
    before = state[0];
  if (e.pangle) {
    const current = appList(before);
    for (const a of e.pangle.remove)
      if (!current.includes(a)) fail('STATE_NOT_FOUND', 'App ' + a + ' is not on the Pangle block list.', {app: a});
    if (!e.pangle.clear)
      for (const a of e.pangle.add)
        if (current.includes(a))
          fail('CONFIGURATION_EXISTS', 'App ' + a + ' is already on the Pangle block list.', {app: a});
    return;
  }
  const was = hubSettings(before);
  if (was.cover_all_ad_objectives === true && e.hub!.cover === false)
    invalid('The Brand Safety Hub settings already cover all objectives, and TikTok cannot turn that back off.');
  if (JSON.stringify(expected(plan, before).settings) === JSON.stringify(was))
    invalid('The update does not change the Brand Safety Hub settings.');
}
export function tiktokBrandSafetyImpact(plan: CompiledRequest, state: unknown[]): JsonObject | undefined {
  if (!tiktokBrandSafetyKind(plan)) return;
  const e = edit(plan),
    before = state[0],
    after = expected(plan, before);
  if (e.pangle)
    return {
      provider: 'tiktok',
      scope: 'pangle_block_list',
      apps_before: appList(before).length,
      apps_after: (after.apps as string[]).length,
      add: e.pangle.add,
      remove: e.pangle.remove,
      clear_existing: e.pangle.clear,
      may_affect_serving: tiktokBrandSafetyWidens(plan),
      effect:
        "Blocked apps stop showing the advertiser's ads on Pangle; removing apps from the list, or clearing it, lets ads show there again at once.",
      verification: 'Reads the block list again and compares the complete set of apps.',
      source: 'https://business-api.tiktok.com/portal/docs/update-the-pangle-block-list/v1.3',
    };
  const was = hubSettings(before);
  return {
    provider: 'tiktok',
    scope: 'brand_safety_hub',
    before: was,
    after: after.settings,
    irreversible:
      was.cover_all_ad_objectives !== true && e.hub!.cover === true
        ? 'cover_all_ad_objectives becomes true and cannot be turned back off.'
        : null,
    may_affect_serving: false,
    effect:
      'Sets the default inventory filter and suitability controls for future Upgraded Smart+ campaigns of this account. Existing campaigns and regular campaigns created with /campaign/create/ are not changed.',
    verification: 'Reads the settings again and compares them.',
    source:
      'https://business-api.tiktok.com/portal/docs/set-or-update-the-brand-safety-hub-settings-of-an-ad-account/v1.3',
  };
}
export function tiktokBrandSafetyOutcome(plan: CompiledRequest, response: TransportResult): boolean {
  const d = obj(response.data) ? response.data : {},
    e = edit(plan);
  if (response.status !== 200 || d.code !== 0 || !obj(d.data)) return false;
  // The Pangle response counts only added apps; a lower count means some were not blocked.
  return e.pangle ? d.data.success_count === e.pangle.add.length : true;
}
export function tiktokBrandSafetyVerification(
  plan: CompiledRequest,
  before: unknown[],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = tiktokBrandSafetyKind(plan)!;
  return [
    {
      read: tiktokBrandSafetyReads(plan)[0]!,
      expected: expected(plan, before[0]),
      id: (kind === 'pangle' ? 'Pangle block list' : 'Brand Safety Hub') + ' of advertiser ' + plan.accountId,
    },
  ];
}
export function tiktokBrandSafetyObserved(read: CompiledRequest, value: JsonObject): JsonObject {
  return read.tiktokBrandSafetyState === 'pangle'
    ? {apps: [...new Set(appList(value))].sort()}
    : {settings: hubSettings(value)};
}
/** Removing apps from the Pangle block list, or clearing it, lets ads show on more apps at once. */
export function tiktokBrandSafetyWidens(p: CompiledRequest): boolean {
  if (tiktokBrandSafetyKind(p) !== 'pangle') return false;
  const b = obj(p.body) ? p.body : {};
  return b.clear_old_app === true || (Array.isArray(b.delete_app_list) && b.delete_app_list.length > 0);
}
export function tiktokBrandSafetyRemoves(p: CompiledRequest): boolean {
  return tiktokBrandSafetyWidens(p);
}
/** Brand Safety Hub edits change the defaults of future Upgraded Smart+ campaigns, and covering all objectives is irreversible. */
export function tiktokBrandSafetyHubKind(p: CompiledRequest): boolean {
  return tiktokBrandSafetyKind(p) === 'hub';
}
