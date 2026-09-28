import {MirrorError} from './errors.js';
import {stable} from './security.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {metaPrefix, metaRoute} from './meta-version.js';

/**
 * Account-level Meta brand safety, per the Marketing API references "Ad Account Account Controls", "Ad Account Business
 * Constraints", "Audience Controls" and "Ad Account Publisher Block Lists" (checked 2026-09-26 at Graph v25.0;
 * the v26.0 SDK keeps both routes and adds one optional account control, placement_controls_per_objective).
 * - Account controls set the Advantage+ audience controls (minimum age 18–25, included countries and regions, excluded
 *   locations, and interest and employment exclusions) and up to five placement exclusions for every eligible campaign of
 *   the account. Each post sets the controls as sent, so leaving a control out removes it.
 * - A publisher block list is created empty with a name; it blocks nothing until publishers are added and it is applied.
 */
const actions = {
  controls: 'meta_ad_account_id_account_controls_create',
  blocklist: 'meta_ad_account_id_publisher_block_lists_create',
} as const;
type Kind = keyof typeof actions;
const placements = [
  'audience_network_classic',
  'audience_network_rewarded_video',
  'audience_network_instream_video',
  'facebook_marketplace',
  'facebook_rhc',
];
const numeric = /^[1-9]\d*$/;
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function fail(code: string, message: string, details: JsonObject = {}): never {
  throw new MirrorError(code, message, details);
}
function invalid(message: string): never {
  return fail('INVALID_META_BRAND_SAFETY', message);
}
export function metaBrandSafetyKind(p: CompiledRequest): Kind | undefined {
  if (
    p.gateway !== 'meta_native_action' ||
    p.method !== 'POST' ||
    (p.origin !== undefined && p.origin !== 'https://graph.facebook.com')
  )
    return;
  if (p.action === actions.controls && metaRoute('act_\\d+/account_controls$').test(p.path)) return 'controls';
  if (p.action === actions.blocklist && metaRoute('act_\\d+/publisher_block_lists$').test(p.path)) return 'blocklist';
  return;
}
/** A list of {key} or {id} targets, distinct, with keys of the given shape. */
function targets(value: unknown, field: string, key: 'key' | 'id', shape: RegExp, extra: string[] = []): void {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 1000 ||
    value.some(
      v =>
        !obj(v) ||
        Object.keys(v).some(k => k !== key && !extra.includes(k)) ||
        typeof v[key] !== 'string' ||
        !shape.test(v[key]),
    ) ||
    new Set(value.map(v => (v as JsonObject)[key])).size !== value.length
  )
    invalid(field + ' must list 1–1000 distinct targets with a native ' + key + '.');
}
function controls(b: JsonObject): void {
  if (Object.keys(b).some(k => !['audience_controls', 'placement_controls'].includes(k)))
    invalid('Account controls take audience_controls and placement_controls only.');
  const a = b.audience_controls;
  if (!obj(a)) invalid('audience_controls is required.');
  if (Object.keys(a).some(k => !['age_min', 'geo_locations', 'excluded_geo_locations', 'exclusions'].includes(k)))
    invalid('audience_controls takes age_min, geo_locations, excluded_geo_locations and exclusions only.');
  if (a.age_min !== undefined && (!Number.isInteger(a.age_min) || a.age_min < 18 || a.age_min > 25))
    invalid('age_min raises the minimum age from 18 up to 25.');
  if (a.geo_locations !== undefined) {
    const g = a.geo_locations;
    if (!obj(g) || !Object.keys(g).length || Object.keys(g).some(k => !['countries', 'regions'].includes(k)))
      invalid('geo_locations includes countries and regions only.');
    if (
      g.countries !== undefined &&
      (!Array.isArray(g.countries) ||
        !g.countries.length ||
        g.countries.some((c: unknown) => typeof c !== 'string' || !/^[A-Z]{2}$/.test(c)) ||
        new Set(g.countries).size !== g.countries.length)
    )
      invalid('geo_locations.countries must list distinct two-letter country codes.');
    if (g.regions !== undefined) targets(g.regions, 'geo_locations.regions', 'key', numeric, ['name']);
  }
  if (a.excluded_geo_locations !== undefined) {
    const g = a.excluded_geo_locations;
    if (
      !obj(g) ||
      !Object.keys(g).length ||
      Object.keys(g).some(k => !['regions', 'cities', 'zips', 'geo_markets'].includes(k))
    )
      invalid('excluded_geo_locations excludes regions, cities, zips and geo_markets only.');
    if (g.regions !== undefined) targets(g.regions, 'excluded_geo_locations.regions', 'key', numeric, ['name']);
    if (g.cities !== undefined) targets(g.cities, 'excluded_geo_locations.cities', 'key', numeric, ['name']);
    if (g.zips !== undefined)
      targets(g.zips, 'excluded_geo_locations.zips', 'key', /^[A-Z]{2}:[A-Za-z0-9 -]{2,12}$/, ['name']);
    if (g.geo_markets !== undefined)
      targets(g.geo_markets, 'excluded_geo_locations.geo_markets', 'key', /^DMA:\d{3}$/, ['name']);
  }
  if (a.exclusions !== undefined) {
    const x = a.exclusions;
    if (
      !obj(x) ||
      !Object.keys(x).length ||
      Object.keys(x).some(k => !['interests', 'work_employers', 'work_positions'].includes(k))
    )
      invalid('exclusions excludes interests, work_employers and work_positions only.');
    for (const [k, v] of Object.entries(x)) targets(v, 'exclusions.' + k, 'id', numeric, ['name']);
  }
  if (b.placement_controls !== undefined) {
    const pc = b.placement_controls;
    if (
      !obj(pc) ||
      Object.keys(pc).some(k => k !== 'placement_exclusions') ||
      !Array.isArray(pc.placement_exclusions) ||
      pc.placement_exclusions.some((v: unknown) => typeof v !== 'string' || !placements.includes(v)) ||
      new Set(pc.placement_exclusions).size !== pc.placement_exclusions.length
    )
      invalid('placement_controls.placement_exclusions may list only ' + placements.join(', ') + '.');
  }
}
export function assertMetaBrandSafety(p: CompiledRequest): void {
  const kind = metaBrandSafetyKind(p);
  if (!kind) return;
  if (p.path.split('/')[2] !== 'act_' + p.accountId)
    fail('ACCOUNT_SCOPE_MISMATCH', 'The request must use the selected ad account.');
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Brand safety reviews take no query or header overrides.');
  const b = obj(p.body) ? p.body : undefined;
  if (!b) invalid('Provide the native request object.');
  if (kind === 'controls') {
    controls(b!);
    return;
  }
  if (
    Object.keys(b!).some(k => k !== 'name') ||
    typeof b!.name !== 'string' ||
    !b!.name.trim() ||
    b!.name !== b!.name.trim() ||
    [...b!.name].length > 255
  )
    invalid('A publisher block list takes only a name of 1–255 characters.');
}
export function metaBrandSafetyReads(p: CompiledRequest): CompiledRequest[] {
  const kind = metaBrandSafetyKind(p)!;
  return [
    {
      ...p,
      action: 'AMCP_META_BRAND_SAFETY_READ',
      method: 'GET',
      path:
        metaPrefix + 'act_' + p.accountId + '/' + (kind === 'controls' ? 'account_controls' : 'publisher_block_lists'),
      query: kind === 'controls' ? {} : {fields: 'id,name', limit: 100},
      body: undefined,
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      responseControls: undefined,
      specialTransport: undefined,
      metaBrandSafetyState: kind,
    },
  ];
}
export function isMetaBrandSafetyRead(p: CompiledRequest): boolean {
  return p.gateway === 'meta_native_action' && !!p.metaBrandSafetyState;
}
export function validateMetaBrandSafetyState(read: CompiledRequest, result: TransportResult): void {
  const d = result.data;
  if (result.status !== 200 || !obj(d) || d.error || !Array.isArray(d.data) || (obj(d.paging) && d.paging.next))
    fail(
      read.metaBrandSafetyState === 'blocklist' && obj(d) && obj(d.paging) && d.paging.next
        ? 'INCOMPLETE_STATE'
        : 'STATE_READ_FAILED',
      'Meta must return the complete ' +
        (read.metaBrandSafetyState === 'controls' ? 'account controls' : 'publisher block lists (up to 100)') +
        ' of the selected account.',
    );
  if (read.metaBrandSafetyState === 'controls' && d.data.length > 1)
    fail('STATE_TARGET_MISMATCH', 'An ad account has at most one set of account controls.');
  if (read.metaBrandSafetyState === 'blocklist') {
    const seen = new Set<string>();
    for (const l of d.data) {
      if (!obj(l) || typeof l.id !== 'string' || !numeric.test(l.id) || seen.has(l.id))
        fail('STATE_TARGET_MISMATCH', 'Publisher block lists must have unique IDs.');
      seen.add(l.id);
    }
  }
}
const rows = (v: unknown): JsonObject[] => (obj(v) && Array.isArray(v.data) ? v.data.filter(obj) : []);
/** The controls as Meta applies them, in one normalized form: target lists sorted by key or ID without display names, empty
 * parts dropped and placement exclusions sorted. It accepts its own output, so frozen review states normalize again unchanged. */
function normalizedControls(c: unknown): JsonObject {
  const a = obj(c) && obj(c.audience_controls) ? c.audience_controls : {},
    pc = obj(c) && obj(c.placement_controls) ? c.placement_controls : {};
  const list = (v: unknown, key: string) =>
    Array.isArray(v) && v.length
      ? v
          .map(x => ({[key]: String(obj(x) ? x[key] : x)}))
          .sort((p, q) => (p[key]! < q[key]! ? -1 : p[key]! > q[key]! ? 1 : 0))
      : undefined;
  const part = (o: JsonObject) => {
    const r = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
    return Object.keys(r).length ? r : undefined;
  };
  const g = obj(a.geo_locations) ? a.geo_locations : {},
    x = obj(a.excluded_geo_locations) ? a.excluded_geo_locations : {},
    e = obj(a.exclusions) ? a.exclusions : {};
  return {
    audience_controls:
      part({
        age_min: a.age_min,
        geo_locations: part({
          countries: Array.isArray(g.countries) && g.countries.length ? g.countries.map(String).sort() : undefined,
          regions: list(g.regions, 'key'),
        }),
        excluded_geo_locations: part({
          regions: list(x.regions, 'key'),
          cities: list(x.cities, 'key'),
          zips: list(x.zips, 'key'),
          geo_markets: list(x.geo_markets, 'key'),
        }),
        exclusions: part({
          interests: list(e.interests, 'id'),
          work_employers: list(e.work_employers, 'id'),
          work_positions: list(e.work_positions, 'id'),
        }),
      }) ?? {},
    placement_controls: {
      placement_exclusions: Array.isArray(pc.placement_exclusions) ? pc.placement_exclusions.map(String).sort() : [],
    },
  };
}
/** Stable review state without paging cursors or the application status Meta updates while it applies the controls. */
export function metaBrandSafetyState(read: CompiledRequest, data: JsonObject): JsonObject {
  if (read.metaBrandSafetyState === 'controls') return {data: rows(data).map(normalizedControls)};
  return {
    data: rows(data)
      .map(l => ({id: l.id, name: l.name ?? null}))
      .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1)),
  };
}
const currentControls = (state: unknown) => normalizedControls(rows(state)[0] ?? {});
export function validateMetaBrandSafetyPrerequisites(plan: CompiledRequest, state: unknown[]): void {
  const kind = metaBrandSafetyKind(plan);
  if (!kind) return;
  const b = plan.body as JsonObject;
  if (kind === 'blocklist') {
    if (rows(state[0]).some(l => String(l.name).toLowerCase() === String(b.name).toLowerCase()))
      fail('CONFIGURATION_EXISTS', 'A publisher block list named "' + b.name + '" already exists in this account.', {
        name: b.name,
      });
    return;
  }
  if (stable(currentControls(state[0])) === stable(normalizedControls(b)))
    invalid('The account controls already match this request.');
}
export function metaBrandSafetyImpact(plan: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = metaBrandSafetyKind(plan);
  if (!kind) return;
  const b = plan.body as JsonObject;
  if (kind === 'blocklist')
    return {
      provider: 'meta',
      scope: 'publisher_block_list',
      name: b.name,
      lists_in_account: rows(state[0]).length,
      may_affect_serving: false,
      effect:
        'Creates an empty publisher block list; nothing is blocked until publishers are added and the list is applied.',
      source:
        'https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/publisher_block_lists',
    };
  return {
    provider: 'meta',
    scope: 'account_controls',
    before: rows(state[0]).length ? currentControls(state[0]) : null,
    after: normalizedControls(b),
    may_affect_serving: true,
    effect:
      'Sets the audience and placement controls of every eligible Advantage+ campaign of this account. Controls left out of the request are removed, which widens delivery; campaigns whose settings conflict are listed in campaigns_with_error.',
    verification:
      'Reads the account controls again and compares the audience and placement controls exactly; the application status is not compared.',
    source:
      'https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/account_controls',
  };
}
export function metaBrandSafetyOutcome(plan: CompiledRequest, result: TransportResult): boolean {
  const d = result.data;
  if (result.status !== 200 || !obj(d) || d.error || d.error_code || d.error_message) return false;
  return metaBrandSafetyKind(plan) === 'blocklist'
    ? typeof d.id === 'string' && numeric.test(d.id)
    : d.success === true;
}
export function metaBrandSafetyVerification(
  plan: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = metaBrandSafetyKind(plan)!,
    read = metaBrandSafetyReads(plan)[0]!,
    b = plan.body as JsonObject;
  if (kind === 'blocklist') {
    const id = String(result.data?.id);
    return [{read, expected: {lists: {[id]: b.name}}, id: 'publisher block list ' + id}];
  }
  // Compared as one serialized value, so a control that should have been removed cannot pass as an extra field.
  return [{read, expected: {controls: stable(normalizedControls(b))}, id: 'account controls of act_' + plan.accountId}];
}
export function metaBrandSafetyObserved(read: CompiledRequest, data: JsonObject): JsonObject {
  if (read.metaBrandSafetyState === 'blocklist')
    return {lists: Object.fromEntries(rows(data).map(l => [l.id, l.name ?? null]))};
  return {controls: stable(currentControls(data))};
}
/** Account controls change delivery of every eligible campaign; an empty new block list changes nothing. */
export function metaAccountControlsKind(p: CompiledRequest): boolean {
  return metaBrandSafetyKind(p) === 'controls';
}
