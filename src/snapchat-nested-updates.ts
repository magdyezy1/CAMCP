import {assertNoMethodOverride} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import {familyStateErrors, type StateFlaggedRefusal} from './family-kit.js';
import {stable} from './security.js';
import {changedStateFields} from './review-state-core.js';
import {
  snapTargetingKind,
  assertSnapTargeting,
  readSnapTargetingState,
  snapTargetingImpact,
  snapTargetingActivates,
  verifySnapTargeting,
  snapTargetingSpendMessage,
} from './snapchat-adsquad-targeting.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

type Send = (p: CompiledRequest) => Promise<TransportResult>;
type Kind = {collection: 'ads' | 'adsquads'; parent: 'adsquads' | 'campaigns'; parentId: string; target?: string};
const gateway = 'snapchat_native_action',
  origin = 'https://adsapi.snapchat.com',
  id = /^[A-Za-z0-9-]{1,128}$/;
const isId = (v: unknown): v is string =>
  typeof v === 'string' && id.test(v) && v !== 'prototype' && !Object.hasOwn(Object.prototype, v);
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const money = ['daily_budget_micro', 'lifetime_budget_micro', 'bid_micro'];
const scalar = ['name', 'status', 'start_time', 'end_time'];
const adMutable = [...scalar, 'third_party_paid_impression_tracking_urls', 'third_party_on_swipe_tracking_urls'];
const squadMutable = [
  ...scalar,
  ...money,
  'bid_strategy',
  'pacing_type',
  'targeting',
  'pixel_id',
  'cap_and_exclusion_config',
  'included_content_types',
  'excluded_content_types',
  'placement_v2',
  'event_sources',
  'measurement_provider_names',
  'ad_scheduling_config',
];
const preserved = [
  'targeting',
  'pixel_id',
  'cap_and_exclusion_config',
  'placement_v2',
  'event_sources',
  'measurement_provider_names',
  'ad_scheduling_config',
];
const adIdentity = ['id', 'ad_squad_id', 'creative_id', 'type', 'render_type', 'paying_advertiser_name'];
const squadIdentity = [
  'id',
  'campaign_id',
  'type',
  'billing_event',
  'optimization_goal',
  'placement',
  'ad_account_id',
  'ecid_status',
  'attribution_method',
  'conversion_window',
  'view_attribution_window',
  'swipe_up_attribution_window',
  'brand_safety_config',
  'child_ad_type',
  'forced_view_setting',
  'story_ad_creative_type',
  'skadnetwork_properties',
  'campaign_budget_optimization_properties',
];
const campaignFields = [
  'id',
  'ad_account_id',
  'name',
  'status',
  'start_time',
  'end_time',
  'daily_budget_micro',
  'lifetime_spend_cap_micro',
  'objective',
  'buy_model',
  'delivery_constraint',
  'measurement_spec',
  'objective_v2_properties',
  'regulations',
  'mobile_app_properties',
  'shared_properties',
  'pacing_level',
  'product_properties',
  'creation_state',
  'reserved_type',
];
const contentTypes = [
  'NEWS',
  'ENTERTAINMENT',
  'SCIENCE_TECHNOLOGY',
  'BEAUTY_FASHION',
  'MENS_LIFESTYLE',
  'WOMENS_LIFESTYLE',
  'GENERAL_LIFESTYLE',
  'OFFICIAL_STORIES',
  'FOOD',
  'SPORTS',
  'YOUNG_BOLD',
  'GAMING',
];
const targetCostGoals = [
  'APP_INSTALLS',
  'SWIPES',
  'USES',
  'VIDEO_VIEWS_15_SEC',
  'PIXEL_PURCHASE',
  'PIXEL_SIGNUP',
  'PIXEL_PAGE_VIEW',
  'PIXEL_ADD_TO_CART',
  'APP_PURCHASE',
  'APP_SIGNUP',
  'APP_ADD_TO_CART',
  'APP_REENGAGE_PURCHASE',
  'APP_REENGAGE_OPEN',
  'STORY_OPENS',
  'LANDING_PAGE_VIEW',
];
const metadata =
  /^(?:created_at|updated_at|delivery_status|effective_status|review_status(?:_.*)?|rejection(?:_.*)?|approval(?:_.*)?|deleted|request_id|sub_request_warnings|auto_bid|target_bid|targeting_reach_status|separated_types)$/;
const fail: StateFlaggedRefusal = familyStateErrors('INVALID_SNAPCHAT_UPDATE', 'SNAPCHAT_UPDATE_STATE_UNVERIFIED');
const fields = (k: Kind) =>
  k.collection === 'ads' ? [...adIdentity, ...adMutable] : [...squadIdentity, ...squadMutable];
const mutable = (k: Kind) => (k.collection === 'ads' ? adMutable : squadMutable);
const at = (row: JsonObject, path: string) => row[path.slice(1)];
export function snapUpdateKind(p: CompiledRequest): Kind | undefined {
  if (
    p.gateway !== gateway ||
    p.specialTransport ||
    (p.origin && p.origin !== origin) ||
    !['PUT', 'PATCH'].includes(p.method)
  )
    return;
  const m = /^\/v1\/(campaigns|adsquads)\/([A-Za-z0-9-]{1,128})\/(adsquads|ads)(?:\/([A-Za-z0-9-]{1,128}))?$/.exec(
    p.path,
  );
  if (
    !m ||
    (m[1] === 'campaigns' && m[3] !== 'adsquads') ||
    (m[1] === 'adsquads' && m[3] !== 'ads') ||
    (p.method === 'PATCH') !== !!m[4]
  )
    return;
  if (!isId(m[2]) || (m[4] !== undefined && !isId(m[4]))) return;
  return {
    collection: m[3] as Kind['collection'],
    parent: m[1] as Kind['parent'],
    parentId: m[2]!,
    ...(m[4] ? {target: m[4]} : {}),
  };
}
function date(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    fail('Dates need explicit ISO 8601 timestamps and timezone offsets.');
  const m = /^(.{19})(?:\.(\d{1,3}))?/.exec(value)!,
    local = m[1] + '.' + (m[2] ?? '').padEnd(3, '0') + 'Z';
  if (!Number.isFinite(Date.parse(local)) || new Date(local).toISOString() !== local) fail('Use real calendar dates.');
  return Date.parse(value);
}
function value(field: string, v: unknown) {
  if (v === null) {
    if (['end_time', ...adMutable.filter(k => k.startsWith('third_party_'))].includes(field)) return;
    fail('This field cannot be cleared.');
  }
  if (field === 'name' && (typeof v !== 'string' || !v.trim() || [...v].length > 375 || /[\u0000\r\n]/.test(v)))
    fail('name requires 1–375 characters without line breaks.');
  if (field === 'status' && !['ACTIVE', 'PAUSED'].includes(v as string)) fail('Use native ACTIVE or PAUSED.');
  if (money.includes(field) && (!Number.isSafeInteger(v) || Number(v) <= 0))
    fail('Budget and bid amounts require positive safe integer micro-currency values.');
  if (field === 'daily_budget_micro' && Number(v) < 5000000)
    fail(
      'The documented daily budget minimum is 5,000,000 micro-currency units. Additional account/goal constraints still apply.',
    );
  if (field.endsWith('_time')) date(v);
  if (field === 'bid_strategy' && !['LOWEST_COST_WITH_MAX_BID', 'AUTO_BID', 'TARGET_COST'].includes(v as string))
    fail('Use a documented auction bid strategy.');
  if (field === 'pacing_type' && !['STANDARD', 'ACCELERATED'].includes(v as string))
    fail('Use STANDARD or ACCELERATED pacing.');
  if (
    field.endsWith('_content_types') &&
    (!Array.isArray(v) ||
      v.some(x => typeof x !== 'string' || !contentTypes.includes(x)) ||
      new Set(v).size !== v.length)
  )
    fail('Use distinct documented content categories.');
  if (field.startsWith('third_party_') && (!Array.isArray(v) || v.length > 20 || v.some(x => !trackingUrl(x))))
    fail(
      'Tracking tags require a bounded list of explicit HTTPS URLs without credentials. Provider-approved domains remain required.',
    );
}
function trackingUrl(v: unknown) {
  if (typeof v !== 'string' || v.length > 8192 || /[\u0000\r\n]/.test(v)) return false;
  try {
    const url = new URL(v);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}
function changes(p: CompiledRequest, k: Kind): JsonObject[] {
  if (p.method === 'PATCH') return [{id: k.target}];
  const b = p.body;
  if (
    !object(b) ||
    Object.keys(b).some(x => x !== k.collection) ||
    !Array.isArray(b[k.collection]) ||
    b[k.collection].length < 1 ||
    b[k.collection].length > 25
  )
    fail('Provide 1–25 native update records under ' + k.collection + '.');
  const rows = b[k.collection] as JsonObject[];
  if (rows.some(r => !object(r) || !isId(r.id)) || new Set(rows.map(r => r.id)).size !== rows.length)
    fail('Each update requires a distinct exact resource ID.');
  return rows;
}
export function assertSnapUpdate(p: CompiledRequest) {
  const k = snapUpdateKind(p);
  if (!k) return;
  if (!isId(p.accountId) || Object.keys(p.query).length || Object.keys(p.headers).length)
    fail('Select one account and the exact native parent route without query/header overrides.');
  if (p.method === 'PATCH') {
    if (!Array.isArray(p.body) || !p.body.length || p.body.length > 25) fail('Use 1–25 native JSON Patch operations.');
    for (const op of p.body) {
      if (
        !object(op) ||
        Object.keys(op).some(x => !['op', 'path', 'value'].includes(x)) ||
        !['add', 'remove', 'replace', 'test'].includes(op.op) ||
        typeof op.path !== 'string' ||
        !/^\/[a-z_]+$/.test(op.path)
      )
        fail(
          'Use top-level add, remove, replace or test; array indexes, copy, move and nested rewrites are not qualified.',
        );
      const field = op.path.slice(1);
      // A targeting edit is its own reviewed contract (src/snapchat-adsquad-targeting.ts), never part of another edit.
      if (k.collection === 'adsquads' && field === 'targeting' && op.op !== 'test')
        fail(
          'Change targeting alone: send exactly one replace /targeting operation that holds the complete new targeting.',
        );
      if (
        !fields(k).includes(field) ||
        (op.op !== 'test' && (!mutable(k).includes(field) || preserved.includes(field)))
      )
        fail('This field is immutable or needs a separate identity/targeting contract. Preserve its current value.');
      // Native JSON Patch tests compare wire values. Do not compare their raw
      // timestamps or tracking objects with AMCP's semantic projections.
      if (
        op.op === 'test' &&
        (field.endsWith('_time') || field.startsWith('third_party_') || field.endsWith('_content_types'))
      )
        fail(
          'A wire-value test on a normalized field is not qualified. AMCP already checks its semantic value across review.',
        );
      if (op.op === 'remove') {
        if (
          Object.hasOwn(op, 'value') ||
          !['end_time', ...adMutable.filter(f => f.startsWith('third_party_'))].includes(field)
        )
          fail(
            'Only optional end time or tracking tags can be removed. Budgets and mandatory fields cannot be cleared.',
          );
      } else {
        if (!Object.hasOwn(op, 'value')) fail('Patch operation is missing its explicit value.');
        if (op.op !== 'test') value(field, op.value);
      }
    }
  } else
    for (const row of changes(p, k)) {
      if (Object.keys(row).some(f => !fields(k).includes(f)))
        fail('PUT must contain only qualified native configuration fields, without provider telemetry.');
      const parent = k.collection === 'ads' ? 'ad_squad_id' : 'campaign_id';
      if (
        row[parent] !== k.parentId ||
        row.name === undefined ||
        row.status === undefined ||
        typeof row.type !== 'string' ||
        (k.collection === 'ads' && !isId(row.creative_id))
      )
        fail('Preserve IDs, exact parent, immutable type and explicit name/status in the complete PUT.');
      for (const field of mutable(k))
        if (row[field] !== undefined && !preserved.includes(field)) value(field, row[field]);
    }
}
const read = (p: CompiledRequest, path: string): CompiledRequest => ({
  ...p,
  action: 'AMCP_SNAPCHAT_UPDATE_READ',
  method: 'GET',
  path,
  query: {},
  body: undefined,
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  responseControls: undefined,
});
export function snapUpdateSnapshots(p: CompiledRequest) {
  return [read(p, '/v1/adaccounts/' + p.accountId)];
}
function unpack(r: TransportResult, collection: string, expected: string) {
  if (r.status !== 200 || !object(r.data)) fail('A current complete native resource response is required.', true);
  const d = r.data,
    status = d.request_status ?? d.status;
  if (
    String(status).toUpperCase() !== 'SUCCESS' ||
    (d.request_status !== undefined &&
      d.status !== undefined &&
      String(d.request_status).toUpperCase() !== String(d.status).toUpperCase()) ||
    d.error ||
    d.errors ||
    d.partial === true ||
    d.paging?.next_link
  )
    fail('Provider response is failed, partial or ambiguous.', true);
  const rows = d[collection],
    singular =
      collection === 'adsquads' ? 'adsquad' : collection === 'adaccounts' ? 'adaccount' : collection.slice(0, -1);
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    !object(rows[0]) ||
    String(rows[0].sub_request_status ?? rows[0].status).toUpperCase() !== 'SUCCESS' ||
    (rows[0].sub_request_status !== undefined &&
      rows[0].status !== undefined &&
      String(rows[0].sub_request_status).toUpperCase() !== String(rows[0].status).toUpperCase()) ||
    rows[0].sub_request_error_reason ||
    rows[0].error ||
    rows[0].errors ||
    rows[0].partial === true ||
    !object(rows[0][singular])
  )
    fail('Expected one successful exact native resource.', true);
  const row = rows[0][singular];
  if (row.id !== expected || row.deleted === true) fail('Resource is foreign, deleted or missing.', true);
  return row as JsonObject;
}
function project(row: JsonObject, keys: string[], state = false) {
  try {
    const out: JsonObject = {};
    for (const key of keys)
      if (row[key] !== undefined) {
        let v = row[key];
        if (key.endsWith('_time') && v !== null) v = new Date(date(v)).toISOString();
        if (key.startsWith('third_party_') && v !== null) {
          if (!Array.isArray(v)) fail('Tracking configuration must be a native array.');
          v = v.map(x => (object(x) ? x.tracking_url : x));
          value(key, v);
        }
        if (key.endsWith('_content_types') && Array.isArray(v)) v = [...v].sort();
        out[key] = v;
      }
    return out;
  } catch (error) {
    if (state)
      fail(
        'Current native dates or original tracking URLs are malformed. Read the resource again; do not infer missing configuration.',
        true,
      );
    throw error;
  }
}
function validateCurrent(row: JsonObject, collection: 'ads' | 'adsquads' | 'campaigns') {
  const invalid = (field: string) => {
    throw new MirrorError(
      'SNAPCHAT_UPDATE_STATE_UNVERIFIED',
      'Current native configuration is missing or outside the qualified contract.',
      {resource_id: row.id, field},
      502,
    );
  };
  if (!isId(row.id) || typeof row.name !== 'string' || !row.name.trim() || !['ACTIVE', 'PAUSED'].includes(row.status))
    invalid('id/name/status');
  for (const field of [...money, 'lifetime_spend_cap_micro'])
    if (row[field] !== undefined && row[field] !== null && (!Number.isSafeInteger(row[field]) || row[field] < 0))
      invalid(field);
  if (collection === 'ads') {
    if (!isId(row.creative_id) || typeof row.type !== 'string' || !row.type) invalid('creative_id/type');
  }
  if (collection === 'adsquads') {
    if (
      !['SNAP_ADS', 'LENS', 'FILTER'].includes(row.type) ||
      row.billing_event !== 'IMPRESSION' ||
      typeof row.optimization_goal !== 'string' ||
      !row.optimization_goal
    )
      invalid('type/billing_event/optimization_goal');
    if (!object(row.targeting) || !object(row.placement_v2)) invalid('targeting/placement_v2');
    if (
      row.delivery_constraint != null &&
      !['DAILY_BUDGET', 'LIFETIME_BUDGET', 'REACH_AND_FREQUENCY'].includes(row.delivery_constraint)
    )
      invalid('delivery_constraint');
    if (
      !['LOWEST_COST_WITH_MAX_BID', 'AUTO_BID', 'TARGET_COST'].includes(row.bid_strategy) ||
      (row.bid_strategy !== 'AUTO_BID' && !(row.bid_micro > 0))
    )
      invalid('bid_strategy/bid_micro');
    // Snap still returns deprecated bid flags; updates must omit them. Verify
    // their documented mapping so a conflicting native response is not hidden.
    if (
      (row.auto_bid !== undefined && row.auto_bid !== (row.bid_strategy === 'AUTO_BID')) ||
      (row.target_bid !== undefined && row.target_bid !== (row.bid_strategy === 'TARGET_COST'))
    )
      invalid('auto_bid/target_bid');
    if (!(row.daily_budget_micro > 0 || row.lifetime_budget_micro > 0))
      invalid('daily_budget_micro/lifetime_budget_micro');
  }
  if (
    collection === 'campaigns' &&
    (row.buy_model !== 'AUCTION' ||
      (row.pacing_level != null && row.pacing_level !== 'AD_SQUAD') ||
      row.shared_properties != null ||
      row.reserved_type != null)
  )
    invalid('buy_model/pacing_level/shared_properties');
}
function apply(p: CompiledRequest, state: JsonObject, checkTime: boolean): JsonObject {
  const k = snapUpdateKind(p)!,
    next = structuredClone(state);
  for (const row of changes(p, k)) {
    const old = Object.hasOwn(state.targets, row.id) ? state.targets[row.id] : undefined;
    if (!object(old)) fail('A target is absent from the verified baseline.', true);
    let updated: JsonObject;
    if (p.method === 'PUT') {
      const missing = Object.keys(old).filter(key => !Object.hasOwn(row, key));
      if (missing.length)
        throw new MirrorError(
          'INCOMPLETE_SNAPCHAT_REPLACEMENT',
          'PUT can reset omitted settings. Preserve every current configuration field explicitly or use PATCH.',
          {resource_id: row.id, missing_fields: missing},
        );
      for (const field of fields(k).filter(f => !mutable(k).includes(f) || preserved.includes(f)))
        if (stable(row[field] ?? null) !== stable(old[field] ?? null))
          fail('Preserve immutable and additional-identity fields: ' + field);
      updated = project(row, fields(k));
    } else {
      updated = structuredClone(old);
      for (const op of p.body as JsonObject[]) {
        const field = op.path.slice(1),
          prior = at(updated, op.path);
        if (op.op === 'test') {
          if (stable(prior ?? null) !== stable(op.value))
            fail('A JSON Patch test does not match current configuration.');
          continue;
        }
        if (
          (op.op === 'replace' && !Object.hasOwn(updated, field)) ||
          (op.op === 'add' && prior !== null && prior !== undefined)
        )
          fail('Patch add/replace does not match current field presence.');
        updated[field] = op.op === 'remove' ? null : op.value;
      }
      updated = project(updated, fields(k));
    }
    if (!updated.name || !['ACTIVE', 'PAUSED'].includes(updated.status))
      fail('The resulting entity must retain its name and configured delivery state.');
    if (k.collection === 'adsquads') {
      if (
        !['LOWEST_COST_WITH_MAX_BID', 'AUTO_BID', 'TARGET_COST'].includes(updated.bid_strategy) ||
        (updated.bid_strategy !== 'AUTO_BID' && !(updated.bid_micro > 0)) ||
        !(updated.daily_budget_micro > 0 || updated.lifetime_budget_micro > 0)
      )
        fail('The resulting squad requires an explicit auction bid strategy and finite native budget.');
      if (updated.pacing_type === 'ACCELERATED' && updated.bid_strategy === 'AUTO_BID')
        fail('Accelerated pacing requires a qualified bid strategy.');
      if (
        updated.bid_strategy !== old.bid_strategy &&
        updated.bid_strategy !== 'LOWEST_COST_WITH_MAX_BID' &&
        ![...targetCostGoals, ...(updated.bid_strategy === 'AUTO_BID' ? ['IMPRESSIONS', 'VIDEO_VIEWS'] : [])].includes(
          updated.optimization_goal,
        )
      )
        fail('The requested bid strategy is not documented for this existing optimization goal.');
    }
    if (updated.end_time && updated.start_time && Date.parse(updated.end_time) <= Date.parse(updated.start_time))
      fail('End time must follow start time.');
    if (
      checkTime &&
      updated.start_time !== old.start_time &&
      updated.start_time &&
      Date.parse(updated.start_time) < Date.now()
    )
      fail('A changed start time must be in the future.');
    next.targets[row.id] = updated;
  }
  return next;
}
export async function readSnapUpdateState(p: CompiledRequest, send: Send, validateChange = true): Promise<unknown[]> {
  assertSnapUpdate(p);
  const k = snapUpdateKind(p)!,
    deadline = performance.now() + 60000;
  let calls = 0,
    bytes = 0;
  const get = async (collection: string, key: string) => {
    if (!isId(key) || ++calls > 110 || performance.now() >= deadline)
      fail('Snapshot exceeds its identity, request or deadline bounds.', true);
    const r = await send({...read(p, '/v1/' + collection + '/' + key), snapUpdateDeadline: deadline});
    bytes += Buffer.byteLength(JSON.stringify(r.data));
    if (bytes > 8 * 1024 * 1024 || performance.now() >= deadline)
      fail('Snapshot exceeds eight MiB or its deadline.', true);
    return unpack(r, collection, key);
  };
  const states: JsonObject[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const account = await get('adaccounts', p.accountId!);
    if (
      typeof account.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(account.currency) ||
      typeof account.timezone !== 'string'
    )
      fail('Current account currency and timezone are required.', true);
    try {
      new Intl.DateTimeFormat('en', {timeZone: account.timezone});
    } catch {
      fail('Invalid account timezone.', true);
    }
    const parent = await get(k.parent, k.parentId),
      campaign = k.parent === 'campaigns' ? parent : await get('campaigns', parent.campaign_id);
    if (
      campaign.ad_account_id !== p.accountId ||
      !['ACTIVE', 'PAUSED'].includes(campaign.status) ||
      (k.parent === 'adsquads' &&
        (!['ACTIVE', 'PAUSED'].includes(parent.status) ||
          (parent.ad_account_id !== undefined && parent.ad_account_id !== p.accountId)))
    )
      fail('The current parent chain does not belong to the selected account.', true);
    validateCurrent(campaign, 'campaigns');
    if (k.parent === 'adsquads') validateCurrent(parent, 'adsquads');
    const state: JsonObject = {
      account: project(account, ['id', 'currency', 'timezone'], true),
      campaign: project(campaign, campaignFields, true),
      ...(k.parent === 'adsquads' ? {parent: project(parent, [...squadIdentity, ...squadMutable], true)} : {}),
      targets: {},
      // Read-only delivery context belongs to the frozen review, not the mutable PUT/PATCH body.
      delivery_context: {
        ...(k.parent === 'adsquads' ? {parent: parent.delivery_constraint ?? null} : {}),
        ...(k.collection === 'adsquads' ? {targets: {}} : {}),
      },
    };
    for (const target of changes(p, k)) {
      const current = await get(k.collection, target.id),
        field = k.collection === 'ads' ? 'ad_squad_id' : 'campaign_id';
      if (
        current[field] !== k.parentId ||
        (current.ad_account_id !== undefined && current.ad_account_id !== p.accountId) ||
        typeof current.name !== 'string' ||
        !['ACTIVE', 'PAUSED'].includes(current.status)
      )
        fail('Target identity, current parent or configuration is unverified.', true);
      validateCurrent(current, k.collection);
      if (p.method === 'PUT' && Object.keys(current).some(f => !fields(k).includes(f) && !metadata.test(f)))
        fail(
          'The provider returned additional configuration not covered by complete PUT. Use a qualified PATCH instead.',
          true,
        );
      state.targets[target.id] = project(current, fields(k), true);
      if (k.collection === 'adsquads') state.delivery_context.targets[target.id] = current.delivery_constraint ?? null;
    }
    states.push(state);
  }
  if (stable(states[0]) !== stable(states[1])) fail('Configuration changed during the complete snapshot.', true);
  if (validateChange) apply(p, states[0]!, true);
  return [states[0]!];
}
export function snapUpdateActivates(p: CompiledRequest, before: unknown): boolean | undefined {
  if (!snapUpdateKind(p)) return;
  const state = Array.isArray(before) ? before[0] : undefined;
  if (!object(state)) fail('An exact baseline is required for activation policy.', true);
  const after = apply(p, state, false);
  return Object.entries(after.targets as Record<string, JsonObject>).some(
    ([key, row]) => row.status === 'ACTIVE' && state.targets[key].status !== 'ACTIVE',
  );
}
export function snapUpdateOutcome(p: CompiledRequest, r: TransportResult) {
  try {
    const k = snapUpdateKind(p)!,
      wanted = changes(p, k).map(r => r.id),
      d = r.data;
    if (!object(d) || !Array.isArray(d[k.collection]) || d[k.collection].length !== wanted.length) return false;
    const seen = new Set<string>();
    for (const entry of d[k.collection]) {
      const name = k.collection === 'ads' ? 'ad' : 'adsquad',
        key = entry?.[name]?.id;
      if (!wanted.includes(key) || seen.has(key)) return false;
      seen.add(key);
      const row = unpack({...r, data: {...d, [k.collection]: [entry]}}, k.collection, key);
      if (row[k.collection === 'ads' ? 'ad_squad_id' : 'campaign_id'] !== k.parentId) return false;
    }
    return true;
  } catch {
    return false;
  }
}
export function snapUpdateAmounts(
  p: CompiledRequest,
  before: unknown,
):
  | {
      creating: false;
      amounts: {key: string; path: string; amount: number}[];
      old: {key: string; path: string; amount: number}[];
    }
  | undefined {
  if (!snapUpdateKind(p)) return;
  const state = Array.isArray(before) ? before[0] : undefined;
  if (!object(state)) return;
  const after = apply(p, state, false),
    amounts = [] as {key: string; path: string; amount: number}[],
    old = [] as typeof amounts;
  for (const [key, row] of Object.entries(after.targets as Record<string, JsonObject>))
    for (const field of ['daily_budget_micro', 'lifetime_budget_micro']) {
      // Compare only the exact requested resource, never the parent campaign or a sibling.
      if (row[field] !== undefined && row[field] !== null && row[field] !== state.targets[key][field]) {
        amounts.push({key: key + ':' + field, path: '/targets/' + key + '/' + field, amount: row[field]});
        if (state.targets[key][field] !== undefined && state.targets[key][field] !== null)
          old.push({key: key + ':' + field, path: '/targets/' + key + '/' + field, amount: state.targets[key][field]});
      }
    }
  return {creating: false, amounts, old};
}
export async function verifySnapUpdate(p: CompiledRequest, before: unknown[], send: Send) {
  const expected = [apply(p, before[0] as JsonObject, false)],
    actual = await readSnapUpdateState(p, send, false),
    changed = changedStateFields(expected, actual),
    status = changed.length ? 'inconclusive' : 'verified';
  return {
    status,
    checks: [
      {
        status,
        verification_scope:
          'exact current account and parent chain, complete qualified configuration and original reviewed update',
        changed_fields: changed,
      },
    ],
  };
}
export const snapUpdateImpact = {
  provider: 'snapchat',
  effect:
    'Edits existing ads or auction ad squads under the exact reviewed parent. Status, bidding, dates and budget changes may affect current delivery immediately.',
  limits:
    '1–25 complete PUT records or one target with 1–25 top-level PATCH operations. Requires explicit AUCTION and ad-squad budget ownership; reserved/Smart Budgets need separate contracts. Targeting changes alone, as one replace /targeting PATCH of the ad squad. Pixel/app identities, placement and scheduling structures may be preserved in PUT but need separate dependency contracts to change. Tracking URLs remain subject to provider-approved domains. No automatic field merging or array-index patching.',
  recovery:
    'Re-use the original review/key after a lost client response. A partial or uncertain provider result never permits resubmission. Read-back checks the parent chain and requested configuration, not editorial approval, impressions or delivery.',
};

/**
 * Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). One request shape of its ad squad
 * PATCH route, a single replace /targeting operation, is the ad squad targeting contract (PRV-06 A,
 * src/snapchat-adsquad-targeting.ts): each hook below hands it to that contract, which has its own checks, state, impact,
 * activation rule and read-back. The ledger names one family per route, so the contract cannot be a family of its own.
 */
export const snapUpdateFamily: ReviewedFamily = {
  name: 'snapchat_nested_updates',
  files: [
    'src/snapchat-nested-updates.ts / src/snapchat-adsquad-targeting.ts',
    [
      'tests/snapchat-nested-updates.test.ts',
      'tests/snapchat-allocation-plan.test.mjs',
      'tests/snapchat-adsquad-targeting.test.mjs',
    ],
  ],
  kind: snapUpdateKind,
  assert: plan => {
    assertNoMethodOverride(plan);
    if (snapTargetingKind(plan)) assertSnapTargeting(plan);
    else assertSnapUpdate(plan);
  },
  snapshots: snapUpdateSnapshots,
  state: (plan, readers) => {
    const read = readers.guarded(
      'Snapchat prerequisites must remain read-only.',
      readers.sameLogin('The selected login changed during Snapchat checks. Prepare again with the current login.'),
    ).read;
    return snapTargetingKind(plan) ? readSnapTargetingState(plan, read) : readSnapUpdateState(plan, read);
  },
  impact: (plan, state) => (snapTargetingKind(plan) ? snapTargetingImpact(plan, state) : snapUpdateImpact),
  outcome: snapUpdateOutcome,
  verify: (plan, v) => {
    const read = v.guarded('Snapchat verification must remain read-only.', {
      binding: v.sameLogin('The selected login changed during Snapchat verification.'),
    });
    return (
      snapTargetingKind(plan) ? verifySnapTargeting(plan, v.state, read) : verifySnapUpdate(plan, v.state, read)
    ).then(o => ({status: o.status, checks: o.checks}));
  },
  verifyEveryTime: true,
  spendConfirmation: {
    needed: () => true,
    message: plan =>
      snapTargetingKind(plan)
        ? snapTargetingSpendMessage
        : 'Snapchat entity updates can change current delivery, dates, bidding and spending. Review the exact effects and provide spend_change_confirmed=true.',
  },
  activates: (plan, before) =>
    snapTargetingKind(plan) ? snapTargetingActivates(plan, before) : snapUpdateActivates(plan, before) === true,
  exemptFromActivationScan: true,
  // A targeting edit names no budget or bid; the owner's amount caps have nothing to measure in it.
  policyAmounts: (plan, before) => (snapTargetingKind(plan) ? undefined : snapUpdateAmounts(plan, before)),
};
