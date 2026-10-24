import {assertDV360WriteScope} from './dv360-scope.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {defineFamily, fail, stateReadOf} from './family-kit.js';
import {validateDiscoveryBody} from './discovery-body.js';
import {dv360AdGroupStateRead} from './dv360-demand-gen-ad-groups.js';
import {dv360AudienceCollections} from './dv360-audiences.js';
import {stable} from './security.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {pinnedJson} from './pinned-json.js';
import {
  deprecatedDV360ContentRatingTiers,
  deprecatedDV360SensitiveCategories,
  deprecationEffective,
  refuseDeprecated,
} from './provider-deprecations.js';

/**
 * Reviewed DV360 targeting of line items and advertisers, per Display & Video 360 API v4 (checked 2026-09-26):
 * advertisers.lineItems.bulkEditAssignedTargetingOptions and advertisers.lineItems.targetingTypes.assignedTargetingOptions
 * create/delete, advertisers.editAssignedTargetingOptions and advertisers.targetingTypes.assignedTargetingOptions
 * create/delete, and the "Assign targeting" guide. A line item inherits partner and advertiser targeting, which cannot be
 * edited at line item level. A line item bulk edit deletes, then creates; each line item is updated atomically, but other
 * line items of the same request can still be updated when one fails. YouTube & Partners line items cannot be updated
 * through the API. Advertiser targeting supports five brand-safety types, and every line item of the advertiser inherits it.
 */
export const dv360TargetingTypes = [
  'AGE_RANGE',
  'APP',
  'APP_CATEGORY',
  'AUDIENCE_GROUP',
  'AUDIO_CONTENT_TYPE',
  'AUTHORIZED_SELLER_STATUS',
  'BROWSER',
  'BUSINESS_CHAIN',
  'CARRIER_AND_ISP',
  'CATEGORY',
  'CHANNEL',
  'CONTENT_DURATION',
  'CONTENT_GENRE',
  'CONTENT_INSTREAM_POSITION',
  'CONTENT_OUTSTREAM_POSITION',
  'CONTENT_STREAM_TYPE',
  'DAY_AND_TIME',
  'DEVICE_MAKE_MODEL',
  'DEVICE_TYPE',
  'DIGITAL_CONTENT_LABEL_EXCLUSION',
  'ENVIRONMENT',
  'EXCHANGE',
  'GENDER',
  'GEO_REGION',
  'HOUSEHOLD_INCOME',
  'INVENTORY_SOURCE',
  'INVENTORY_SOURCE_GROUP',
  'KEYWORD',
  'LANGUAGE',
  'NATIVE_CONTENT_POSITION',
  'NEGATIVE_KEYWORD_LIST',
  'OMID',
  'ON_SCREEN_POSITION',
  'OPERATING_SYSTEM',
  'PARENTAL_STATUS',
  'POI',
  'PROXIMITY_LOCATION_LIST',
  'REGIONAL_LOCATION_LIST',
  'SENSITIVE_CATEGORY_EXCLUSION',
  'SUB_EXCHANGE',
  'THIRD_PARTY_VERIFIER',
  'URL',
  'USER_REWARDED_CONTENT',
  'VIDEO_PLAYER_SIZE',
  'VIEWABILITY',
].map(t => 'TARGETING_TYPE_' + t);
export const dv360AdvertiserTargetingTypes = [
  'CHANNEL',
  'DIGITAL_CONTENT_LABEL_EXCLUSION',
  'OMID',
  'SENSITIVE_CATEGORY_EXCLUSION',
  'KEYWORD',
].map(t => 'TARGETING_TYPE_' + t);
/** Types DV360 accepts on Demand Gen line items and on Demand Gen ad groups ("Assign targeting" of the Demand Gen guide, checked 2026-09-27). */
export const dv360DemandGenLineItemTypes = [
  'CARRIER_AND_ISP',
  'DAY_AND_TIME',
  'DEVICE_MAKE_MODEL',
  'DEVICE_TYPE',
  'GEO_REGION',
  'KEYWORD',
  'LANGUAGE',
  'NEGATIVE_KEYWORD_LIST',
  'OPERATING_SYSTEM',
  'POI',
].map(t => 'TARGETING_TYPE_' + t);
export const dv360AdGroupTargetingTypes = [
  'AGE_RANGE',
  'APP',
  'APP_CATEGORY',
  'AUDIENCE_GROUP',
  'CATEGORY',
  'GENDER',
  'GEO_REGION',
  'HOUSEHOLD_INCOME',
  'KEYWORD',
  'LANGUAGE',
  'PARENTAL_STATUS',
  'URL',
  'YOUTUBE_CHANNEL',
  'YOUTUBE_VIDEO',
].map(t => 'TARGETING_TYPE_' + t);
/** Location and language targeting of a Demand Gen line item sits on the line item when demandGenSettings.geoLanguageTargetingEnabled is true, and on its ad groups otherwise. */
const geoLanguage = new Set(['TARGETING_TYPE_GEO_REGION', 'TARGETING_TYPE_POI', 'TARGETING_TYPE_LANGUAGE']);
/** Demand Gen only excludes keywords, categories and placements (DV360 Help, "Create a Demand Gen line item", checked 2026-09-27). */
const demandGenExclusions = new Set(
  ['KEYWORD', 'CATEGORY', 'URL', 'APP', 'APP_CATEGORY', 'YOUTUBE_CHANNEL', 'YOUTUBE_VIDEO'].map(
    t => 'TARGETING_TYPE_' + t,
  ),
);
/** Assigning these references inventory whose advertiser access this contract does not read; removing them is qualified. */
const unreadReferences: Record<string, string> = {
  TARGETING_TYPE_INVENTORY_SOURCE: 'inventory sources',
  TARGETING_TYPE_INVENTORY_SOURCE_GROUP: 'inventory source groups',
};
/**
 * Audience group targeting (AudienceGroupAssignedTargetingOptionDetails of the pinned model and "Audience list targeting",
 * checked 2026-09-27): one option, ID audienceGroup, per resource. Included first-party and partner groups intersect;
 * every other included group is a union; excluded audiences are removed from the result. Each audience is read with the
 * advertiser's access (advertiserId), so an audience the advertiser cannot use is refused before any write.
 */
const audienceGroups: Record<string, {collection: string; id: string; many?: boolean; excluded?: boolean}> = {
  includedFirstPartyAndPartnerAudienceGroups: {
    collection: 'firstPartyAndPartnerAudiences',
    id: 'firstPartyAndPartnerAudienceId',
    many: true,
  },
  excludedFirstPartyAndPartnerAudienceGroup: {
    collection: 'firstPartyAndPartnerAudiences',
    id: 'firstPartyAndPartnerAudienceId',
    excluded: true,
  },
  includedGoogleAudienceGroup: {collection: 'googleAudiences', id: 'googleAudienceId'},
  excludedGoogleAudienceGroup: {collection: 'googleAudiences', id: 'googleAudienceId', excluded: true},
  includedCustomListGroup: {collection: 'customLists', id: 'customListId'},
  includedCombinedAudienceGroup: {collection: 'combinedAudiences', id: 'combinedAudienceId'},
};
/** Only these Google audience types can be excluded (excludedGoogleAudienceGroup of the pinned model). */
const excludableGoogleAudiences = new Set([
  'GOOGLE_AUDIENCE_TYPE_AFFINITY',
  'GOOGLE_AUDIENCE_TYPE_IN_MARKET',
  'GOOGLE_AUDIENCE_TYPE_INSTALLED_APPS',
]);
const maxAudiences = 100,
  maxCombinedAudiences = 5;
/** Assigned lists must be owned by the selected advertiser; partner-owned channels are not read under an advertiser. */
const references: Record<
  string,
  {field: string; collection: string; id: string; label: string; locationType?: string}
> = {
  TARGETING_TYPE_CHANNEL: {field: 'channelId', collection: 'channels', id: 'channelId', label: 'channel'},
  TARGETING_TYPE_NEGATIVE_KEYWORD_LIST: {
    field: 'negativeKeywordListId',
    collection: 'negativeKeywordLists',
    id: 'negativeKeywordListId',
    label: 'negative keyword list',
  },
  TARGETING_TYPE_REGIONAL_LOCATION_LIST: {
    field: 'regionalLocationListId',
    collection: 'locationLists',
    id: 'locationListId',
    label: 'regional location list',
    locationType: 'TARGETING_LOCATION_TYPE_REGIONAL',
  },
  TARGETING_TYPE_PROXIMITY_LOCATION_LIST: {
    field: 'proximityLocationListId',
    collection: 'locationLists',
    id: 'locationListId',
    label: 'proximity location list',
    locationType: 'TARGETING_LOCATION_TYPE_PROXIMITY',
  },
};
/** Advertiser channel and keyword targeting only excludes: the reference requires `negative` for advertiser channels, and advertisers carry brand-safety exclusions only. */
const advertiserExclusions = new Set(['TARGETING_TYPE_CHANNEL', 'TARGETING_TYPE_KEYWORD']);
const lineItemTypes = new Set(
  [
    'DISPLAY_DEFAULT',
    'DISPLAY_MOBILE_APP_INSTALL',
    'VIDEO_DEFAULT',
    'VIDEO_MOBILE_APP_INSTALL',
    'DISPLAY_MOBILE_APP_INVENTORY',
    'VIDEO_MOBILE_APP_INVENTORY',
    'AUDIO_DEFAULT',
    'VIDEO_OVER_THE_TOP',
    'DISPLAY_OUT_OF_HOME',
    'VIDEO_OUT_OF_HOME',
  ].map(t => 'LINE_ITEM_TYPE_' + t),
);
const editableStatus = new Set(['ENTITY_STATUS_ACTIVE', 'ENTITY_STATUS_PAUSED', 'ENTITY_STATUS_DRAFT']),
  advertiserStatus = new Set(['ENTITY_STATUS_ACTIVE', 'ENTITY_STATUS_PAUSED']);
/** One option per resource for these types; all browser, carrier/ISP and language options of a resource share `negative`. */
const singleOption = new Set([
  'TARGETING_TYPE_AUDIENCE_GROUP',
  'TARGETING_TYPE_AUTHORIZED_SELLER_STATUS',
  'TARGETING_TYPE_VIEWABILITY',
]);
const sharedNegative = new Set(['TARGETING_TYPE_BROWSER', 'TARGETING_TYPE_CARRIER_AND_ISP', 'TARGETING_TYPE_LANGUAGE']);
const maxLineItems = 10,
  maxChanges = 1000,
  maxRows = 20000,
  maxPages = 20,
  pageSize = 5000,
  maxFilter = 500;
const origin = 'https://displayvideo.googleapis.com',
  numeric = /^[1-9]\d*$/,
  advertiserOwner = 'advertiser';
const lineItemBulk = /^\/v4\/advertisers\/([1-9]\d*)\/lineItems:bulkEditAssignedTargetingOptions$/;
const lineItemOne =
  /^\/v4\/advertisers\/([1-9]\d*)\/lineItems\/([1-9]\d*)\/targetingTypes\/([^/]+)\/assignedTargetingOptions(?:\/([^/]+))?$/;
const advertiserBulk = /^\/v4\/advertisers\/([1-9]\d*):editAssignedTargetingOptions$/;
const advertiserOne =
  /^\/v4\/advertisers\/([1-9]\d*)\/targetingTypes\/([^/]+)\/assignedTargetingOptions(?:\/([^/]+))?$/;
const adGroupBulk = /^\/v4\/advertisers\/([1-9]\d*)\/adGroups:bulkEditAssignedTargetingOptions$/;
const adGroupOne =
  /^\/v4\/advertisers\/([1-9]\d*)\/adGroups\/([1-9]\d*)\/targetingTypes\/([^/]+)\/assignedTargetingOptions(?:\/([^/]+))?$/;
const maxAdGroups = 25;
/** Owners are line item or ad group IDs, or the single `advertiser` owner for advertiser targeting. */
type Edit = {
  level: 'line_item' | 'advertiser' | 'ad_group';
  route: 'bulk' | 'create' | 'delete';
  advertiser: string;
  owners: string[];
  deletes: {type: string; ids: string[]}[];
  creates: {type: string; options: unknown[]}[];
};
type Row = {owner: string; option: JsonObject};
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
function invalid(message: string): never {
  return fail('INVALID_DV360_TARGETING', message);
}
function decoded(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
const sameName = (actual: unknown, expected: string) =>
  typeof actual === 'string' && decoded(actual) !== undefined && decoded(actual) === decoded(expected);
const models = (): Record<string, JsonObject> => pinnedJson('.mirror/VENDOR/dv360-v4.json').document.schemas;
/** TARGETING_TYPE_GEO_REGION → geoRegionDetails, the union member that must match the targeting type. */
export const dv360DetailsField = (type: string) =>
  type
    .slice(15)
    .toLowerCase()
    .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) + 'Details';
const ownerLabel = (e: Edit, owner: string) =>
  owner === advertiserOwner
    ? 'Advertiser ' + e.advertiser
    : (e.level === 'ad_group' ? 'Ad group ' : 'Line item ') + owner;
const ownerDetails = (e: Edit, owner: string): JsonObject =>
  owner === advertiserOwner
    ? {advertiser_id: e.advertiser}
    : e.level === 'ad_group'
      ? {ad_group_id: owner}
      : {line_item_id: owner};
const optionName = (advertiser: string, owner: string, type: string, id: string, adGroup = false) =>
  'advertisers/' +
  advertiser +
  (owner === advertiserOwner ? '' : (adGroup ? '/adGroups/' : '/lineItems/') + owner) +
  '/targetingTypes/' +
  type +
  '/assignedTargetingOptions/' +
  id;
function requests(b: JsonObject) {
  return {
    deletes: list(b.deleteRequests).map(r => ({
      type: String(obj(r) ? r.targetingType : ''),
      ids: list(obj(r) ? r.assignedTargetingOptionIds : []).map(String),
    })),
    creates: list(b.createRequests).map(r => ({
      type: String(obj(r) ? r.targetingType : ''),
      options: list(obj(r) ? r.assignedTargetingOptions : []),
    })),
  };
}

export function dv360TargetingKind(p: CompiledRequest): Edit | undefined {
  if (p.gateway !== 'dv360_native_action' || (p.origin !== undefined && p.origin !== origin)) return;
  const body = obj(p.body) ? p.body : {};
  const bulk = lineItemBulk.exec(p.path);
  if (bulk && p.method === 'POST')
    return {
      level: 'line_item',
      route: 'bulk',
      advertiser: bulk[1]!,
      owners: list(body.lineItemIds).map(String),
      ...requests(body),
    };
  const edit = advertiserBulk.exec(p.path);
  if (edit && p.method === 'POST')
    return {level: 'advertiser', route: 'bulk', advertiser: edit[1]!, owners: [advertiserOwner], ...requests(body)};
  const groupBulk = adGroupBulk.exec(p.path);
  if (groupBulk && p.method === 'POST')
    return {
      level: 'ad_group',
      route: 'bulk',
      advertiser: groupBulk[1]!,
      owners: list(body.adGroupIds).map(String),
      ...requests(body),
    };
  const group = adGroupOne.exec(p.path);
  if (group) {
    const type = decoded(group[3]!) ?? '',
      id = group[4];
    if (p.method === 'POST' && id === undefined)
      return {
        level: 'ad_group',
        route: 'create',
        advertiser: group[1]!,
        owners: [group[2]!],
        deletes: [],
        creates: [{type, options: [p.body]}],
      };
    if (p.method === 'DELETE' && id !== undefined)
      return {
        level: 'ad_group',
        route: 'delete',
        advertiser: group[1]!,
        owners: [group[2]!],
        deletes: [{type, ids: [decoded(id) ?? '']}],
        creates: [],
      };
    return;
  }
  const li = lineItemOne.exec(p.path),
    adv = li ? undefined : advertiserOne.exec(p.path);
  if (!li && !adv) return;
  const level = li ? ('line_item' as const) : ('advertiser' as const),
    advertiser = (li ?? adv)![1]!,
    owner = li ? li[2]! : advertiserOwner,
    type = decoded((li ? li[3] : adv![2])!) ?? '',
    id = li ? li[4] : adv![3];
  if (p.method === 'POST' && id === undefined)
    return {level, route: 'create', advertiser, owners: [owner], deletes: [], creates: [{type, options: [p.body]}]};
  if (p.method === 'DELETE' && id !== undefined)
    return {
      level,
      route: 'delete',
      advertiser,
      owners: [owner],
      deletes: [{type, ids: [decoded(id) ?? '']}],
      creates: [],
    };
  return;
}
/** The three targeting families of the ledger, by the level the edit targets. */
export function dv360AdvertiserTargetingKind(p: CompiledRequest): boolean {
  return dv360TargetingKind(p)?.level === 'advertiser';
}
export function dv360AdGroupTargetingKind(p: CompiledRequest): boolean {
  return dv360TargetingKind(p)?.level === 'ad_group';
}
export function dv360LineItemTargetingKind(p: CompiledRequest): boolean {
  const kind = dv360TargetingKind(p);
  return !!kind && kind.level !== 'advertiser' && kind.level !== 'ad_group';
}
/** Output-only fields dropped, int64 values as strings and an unset `negative` equal to false, so sent and read options compare. */
function clean(schema: JsonObject, value: unknown): unknown {
  const s = schema.$ref ? (models()[schema.$ref as string] ?? {}) : schema;
  if (Array.isArray(value)) return value.map(v => clean(obj(s.items) ? s.items : {}, v));
  if (obj(value)) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) {
      const child = obj(s.properties) ? s.properties[k] : undefined;
      if (!obj(child) || child.readOnly === true || (k === 'negative' && v === false)) continue;
      out[k] = clean(child, v);
    }
    return out;
  }
  if ((s.format === 'int64' || s.format === 'uint64') && (typeof value === 'number' || typeof value === 'string'))
    return String(value);
  return value;
}
const detailsSchema = (type: string): JsonObject => {
  const p = models().AssignedTargetingOption?.properties as JsonObject | undefined,
    f = p?.[dv360DetailsField(type)];
  return obj(f) ? f : {};
};
/** Settings and first-party groups compare without order; RECENCY_NO_LIMIT is the documented meaning of no recency. */
function audienceCanonical(details: unknown): unknown {
  if (!obj(details)) return details;
  const order = (a: unknown, b: unknown) => {
    const x = stable(a),
      y = stable(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
  const group = (g: unknown) =>
    obj(g) && Array.isArray(g.settings)
      ? {
          ...g,
          settings: g.settings
            .map(s =>
              obj(s) && s.recency === 'RECENCY_NO_LIMIT'
                ? Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'recency'))
                : s,
            )
            .sort(order),
        }
      : g;
  return Object.fromEntries(
    Object.entries(details).map(([k, v]) => [
      k,
      k === 'includedFirstPartyAndPartnerAudienceGroups' && Array.isArray(v) ? v.map(group).sort(order) : group(v),
    ]),
  );
}
const canonical = (type: string, details: unknown) =>
  type +
  ' ' +
  stable(
    type === 'TARGETING_TYPE_AUDIENCE_GROUP'
      ? audienceCanonical(clean(detailsSchema(type), details))
      : clean(detailsSchema(type), details),
  );
/** The audiences named by audience group details, in request order. */
function audienceRefs(details: unknown): {group: string; collection: string; id: string; recency?: unknown}[] {
  const out: {group: string; collection: string; id: string; recency?: unknown}[] = [];
  if (!obj(details)) return out;
  for (const [k, g] of Object.entries(audienceGroups))
    for (const grp of g.many ? list(details[k]) : details[k] === undefined ? [] : [details[k]])
      for (const s of list(obj(grp) ? grp.settings : []))
        if (obj(s))
          out.push({
            group: k,
            collection: g.collection,
            id: String(s[g.id]),
            ...(s.recency !== undefined ? {recency: s.recency} : {}),
          });
  return out;
}
function audienceGroup(d: JsonObject, at: string): void {
  if (!Object.keys(d).length) invalid(at + ' needs at least one included or excluded audience group.');
  const firstParty = new Set<string>();
  for (const [k, v] of Object.entries(d)) {
    const g = audienceGroups[k];
    if (!g) invalid(at + '.' + k + ' is not an audience group of the pinned model.');
    if (g.many && (!Array.isArray(v) || !v.length))
      invalid(at + '.' + k + ' lists at least one first-party and partner audience group.');
    (g.many ? (v as unknown[]) : [v]).forEach((grp, i) => {
      const where = at + '.' + k + (g.many ? '[' + i + ']' : ''),
        fields = g.collection === 'firstPartyAndPartnerAudiences' ? [g.id, 'recency'] : [g.id];
      if (
        !obj(grp) ||
        Object.keys(grp).some(x => x !== 'settings') ||
        !Array.isArray(grp.settings) ||
        !grp.settings.length
      )
        invalid(where + ' is {settings} with at least one audience.');
      const ids = grp.settings.map((s: unknown, j: number) => {
        if (
          !obj(s) ||
          Object.keys(s).some(x => !fields.includes(x)) ||
          typeof s[g.id] !== 'string' ||
          !numeric.test(s[g.id])
        )
          invalid(
            where + '.settings[' + j + '] is {' + fields.join(', ') + '} with the numeric ' + g.id + ' as a string.',
          );
        return s[g.id] as string;
      });
      if (new Set(ids).size !== ids.length)
        invalid(
          where +
            ' names an audience twice; DV360 ' +
            (g.collection === 'firstPartyAndPartnerAudiences' ? 'refuses' : 'ignores') +
            ' repeated settings.',
        );
      if (g.collection === 'combinedAudiences' && ids.length > maxCombinedAudiences)
        invalid(where + ' lists at most ' + maxCombinedAudiences + ' combined audiences.');
      if (g.many) {
        const key = stable(audienceCanonical({[k]: [grp]}));
        if (firstParty.has(key))
          invalid(
            where + ' repeats another included first-party and partner audience group; DV360 ignores repeated groups.',
          );
        firstParty.add(key);
      }
    });
  }
  const refs = audienceRefs(d),
    audiences = new Set(refs.map(r => r.collection + '/' + r.id));
  if (audiences.size > maxAudiences)
    invalid(at + ' names ' + audiences.size + ' audiences; a review reads at most ' + maxAudiences + '.');
  for (const r of refs)
    if (
      !audienceGroups[r.group]!.excluded &&
      refs.some(x => audienceGroups[x.group]!.excluded && x.collection === r.collection && x.id === r.id)
    )
      invalid(at + ': audience ' + r.id + ' is both included and excluded.');
}
const optionKey = (type: string, option: unknown) =>
  canonical(type, obj(option) ? option[dv360DetailsField(type)] : undefined);
const matches = (o: JsonObject, id: string) =>
  o.assignedTargetingOptionId === id || o.assignedTargetingOptionIdAlias === id;
const inherited = (o: JsonObject) =>
  o.inheritance === 'INHERITED_FROM_PARTNER' || o.inheritance === 'INHERITED_FROM_ADVERTISER';
function radius(amount: unknown, unit: unknown, step: boolean) {
  const max = unit === 'DISTANCE_UNIT_MILES' ? 500 : unit === 'DISTANCE_UNIT_KILOMETERS' ? 800 : 0;
  if (
    !max ||
    typeof amount !== 'number' ||
    amount < 1 ||
    amount > max ||
    (step && Math.abs(amount * 10 - Math.round(amount * 10)) > 1e-9)
  )
    invalid(
      'The proximity radius must be 1 to 500 miles or 1 to 800 kilometers' + (step ? ', in steps of 0.1' : '') + '.',
    );
}
function option(type: string, value: unknown, at: string): void {
  if (!obj(value)) invalid(at + ' must be an assigned targeting option object.');
  validateDiscoveryBody('AssignedTargetingOption', models(), value, true);
  const field = dv360DetailsField(type),
    d = value[field];
  if (Object.keys(value).length !== 1 || !obj(d))
    invalid(at + ' must hold only ' + field + ', the details of ' + type + '.');
  for (const [k, v] of Object.entries(d))
    if (typeof v === 'string' && /_UNSPECIFIED$/.test(v))
      invalid(at + '.' + field + '.' + k + ' must name a specific value.');
  if (typeof d.targetingOptionId === 'string' && (!d.targetingOptionId || /[\s/\\]/.test(d.targetingOptionId)))
    invalid(at + ' needs the native targetingOptionId from targeting option search or list.');
  const ref = references[type];
  if (ref && !numeric.test(String(d[ref.field])))
    invalid(at + '.' + field + '.' + ref.field + ' must be the ID of an advertiser-owned ' + ref.label + '.');
  if (type === 'TARGETING_TYPE_KEYWORD') {
    const k = d.keyword;
    if (
      typeof k !== 'string' ||
      !k.trim() ||
      k !== k.trim() ||
      Buffer.byteLength(k, 'utf8') > 255 ||
      [...k].length > 80 ||
      k.split(/\s+/).length > 10
    )
      invalid('A keyword needs 1–80 characters, at most 10 words and 255 UTF-8 bytes, without surrounding spaces.');
    if (d.exemptedPolicyNames !== undefined)
      invalid('Keyword policy exemptions apply only to allowlisted Demand Gen resources and are not qualified here.');
  }
  if (
    type === 'TARGETING_TYPE_URL' &&
    (typeof d.url !== 'string' || !d.url || /[\s\x00-\x1f]/.test(d.url) || d.url.length > 2048)
  )
    invalid('A URL target is a native URL such as example.com/path, without spaces.');
  if (type === 'TARGETING_TYPE_APP') {
    if (typeof d.appId !== 'string' || !d.appId || /[\s\x00-\x1f]/.test(d.appId))
      invalid('An app target needs the native app ID.');
    if (d.appPlatform === undefined)
      invalid(
        'Name appPlatform explicitly; DV360 otherwise derives it from the app ID, and the review compares what it sent.',
      );
  }
  if (
    type === 'TARGETING_TYPE_DAY_AND_TIME' &&
    (!Number.isInteger(d.startHour) ||
      !Number.isInteger(d.endHour) ||
      d.startHour < 0 ||
      d.startHour > 23 ||
      d.endHour < 1 ||
      d.endHour > 24 ||
      d.endHour <= d.startHour)
  )
    invalid('Day and time targeting needs a startHour from 0 to 23 before an endHour from 1 to 24.');
  if (type === 'TARGETING_TYPE_POI' || type === 'TARGETING_TYPE_BUSINESS_CHAIN')
    radius(d.proximityRadiusAmount, d.proximityRadiusUnit, true);
  if (type === 'TARGETING_TYPE_PROXIMITY_LOCATION_LIST') radius(d.proximityRadius, d.proximityRadiusUnit, false);
  if (type === 'TARGETING_TYPE_AUDIENCE_GROUP') audienceGroup(d, at);
  if (
    type === 'TARGETING_TYPE_THIRD_PARTY_VERIFIER' &&
    ['integralAdScience', 'doubleVerify', 'adloox'].filter(k => d[k] !== undefined).length !== 1
  )
    invalid('Third-party verification names exactly one verifier.');
}
/**
 * Exclusions DV360 stops accepting in line item and ad group targeting from 2026-10-01 (src/provider-deprecations.ts):
 * refused with PROVIDER_DEPRECATED before any request. Advertiser-level targeting stays provider-checked.
 */
const exclusionDeprecations: Record<string, {field: string; id: string; values: readonly string[]}> = {
  TARGETING_TYPE_SENSITIVE_CATEGORY_EXCLUSION: {
    field: 'excludedSensitiveCategory',
    id: 'dv360_line_item_sensitive_category_exclusions',
    values: deprecatedDV360SensitiveCategories,
  },
  TARGETING_TYPE_DIGITAL_CONTENT_LABEL_EXCLUSION: {
    field: 'excludedContentRatingTier',
    id: 'dv360_line_item_content_rating_exclusions',
    values: deprecatedDV360ContentRatingTiers,
  },
};
function deprecatedExclusions(type: string, options: unknown[]): void {
  const rule = exclusionDeprecations[type];
  if (!rule || !deprecationEffective(rule.id)) return;
  const refused = options
    .map(o => (obj(o) && obj(o[dv360DetailsField(type)]) ? o[dv360DetailsField(type)][rule.field] : undefined))
    .filter((v): v is string => typeof v === 'string' && rule.values.includes(v));
  if (refused.length)
    refuseDeprecated(
      rule.id,
      'DV360 no longer accepts ' + [...new Set(refused)].join(', ') + ' as ' + rule.field + ' in line item targeting',
      {field: rule.field, values: [...new Set(refused)]},
    );
}
export function assertDV360Targeting(p: CompiledRequest): void {
  const e = dv360TargetingKind(p);
  if (!e) return;
  const advertiser = e.level === 'advertiser',
    group = e.level === 'ad_group',
    types = advertiser ? dv360AdvertiserTargetingTypes : group ? dv360AdGroupTargetingTypes : dv360TargetingTypes,
    where = advertiser ? 'an advertiser' : group ? 'a Demand Gen ad group' : 'a line item';
  if (e.advertiser !== p.accountId) fail('ACCOUNT_SCOPE_MISMATCH', 'DV360 path must belong to account_id.');
  if (Object.keys(p.query).length || Object.keys(p.headers ?? {}).length)
    invalid('DV360 targeting reviews take no query parameters or header overrides.');
  if (e.route === 'delete') {
    if (p.body !== undefined && (!obj(p.body) || Object.keys(p.body).length))
      invalid('Deleting an assigned targeting option takes no body.');
    if (!e.deletes[0]!.ids[0]) invalid('Name the assigned targeting option ID to delete.');
  } else if (!obj(p.body)) invalid('Provide the native request object.');
  if (e.route === 'bulk') {
    const b = p.body as JsonObject;
    validateDiscoveryBody(
      advertiser
        ? 'BulkEditAdvertiserAssignedTargetingOptionsRequest'
        : group
          ? 'BulkEditAdGroupAssignedTargetingOptionsRequest'
          : 'BulkEditAssignedTargetingOptionsRequest',
      models(),
      b,
      true,
    );
    if (
      group &&
      (!Array.isArray(b.adGroupIds) ||
        !b.adGroupIds.length ||
        b.adGroupIds.length > maxAdGroups ||
        b.adGroupIds.some(id => typeof id !== 'string' || !numeric.test(id)) ||
        new Set(b.adGroupIds).size !== b.adGroupIds.length)
    )
      invalid(
        'adGroupIds must name 1 to ' +
          maxAdGroups +
          ' distinct Demand Gen ad groups of the selected advertiser as decimal strings.',
      );
    if (
      e.level === 'line_item' &&
      (!Array.isArray(b.lineItemIds) ||
        !b.lineItemIds.length ||
        b.lineItemIds.length > maxLineItems ||
        b.lineItemIds.some(id => typeof id !== 'string' || !numeric.test(id)) ||
        new Set(b.lineItemIds).size !== b.lineItemIds.length)
    )
      invalid(
        'lineItemIds must name 1 to ' +
          maxLineItems +
          ' distinct line items of the selected advertiser as decimal strings.',
      );
    if (
      list(b.deleteRequests).some(
        r => !obj(r) || !Array.isArray(r.assignedTargetingOptionIds) || !r.assignedTargetingOptionIds.length,
      )
    )
      invalid('Each delete request names a targeting type and at least one assigned targeting option ID.');
    if (
      list(b.createRequests).some(
        r => !obj(r) || !Array.isArray(r.assignedTargetingOptions) || !r.assignedTargetingOptions.length,
      )
    )
      invalid('Each create request names a targeting type and at least one assigned targeting option.');
    if (!list(b.deleteRequests).length && !list(b.createRequests).length)
      invalid('A bulk edit needs at least one delete or create request.');
  }
  const deleted = new Set<string>(),
    created = new Set<string>();
  let changes = 0;
  for (const d of e.deletes) {
    if (!types.includes(d.type)) invalid(d.type + ' is not ' + where + ' targeting type DV360 supports for deletion.');
    if (deleted.has(d.type)) invalid('Name ' + d.type + ' once in deleteRequests.');
    deleted.add(d.type);
    if (
      d.ids.some(
        id => !id || id.length > 1024 || /[\x00-\x1f]/.test(id) || (e.route === 'delete' && /[/\\]/.test(id)),
      ) ||
      new Set(d.ids).size !== d.ids.length
    )
      invalid('Assigned targeting option IDs must be distinct native IDs.');
    changes += d.ids.length;
  }
  for (const c of e.creates) {
    if (!types.includes(c.type)) invalid(c.type + ' is not ' + where + ' targeting type DV360 supports for creation.');
    if (unreadReferences[c.type])
      invalid(
        'Assigning ' +
          c.type +
          ' references ' +
          unreadReferences[c.type] +
          ' whose access by this advertiser the review does not read yet; assign it in Display & Video 360.',
      );
    if (created.has(c.type)) invalid('Name ' + c.type + ' once in createRequests.');
    created.add(c.type);
    c.options.forEach((o, i) =>
      option(c.type, o, e.route === 'bulk' ? 'createRequests[' + c.type + '][' + i + ']' : 'The option'),
    );
    if (!advertiser) deprecatedExclusions(c.type, c.options);
    if (
      advertiser &&
      advertiserExclusions.has(c.type) &&
      c.options.some(o => (o as JsonObject)[dv360DetailsField(c.type)].negative !== true)
    )
      invalid(
        'Advertiser ' +
          (c.type === 'TARGETING_TYPE_CHANNEL' ? 'channel' : 'keyword') +
          ' targeting only excludes; set negative to true.',
      );
    const keys = c.options.map(o => optionKey(c.type, o));
    if (new Set(keys).size !== keys.length) invalid('A ' + c.type + ' option is repeated in this review.');
    changes += c.options.length;
  }
  if (changes * e.owners.length > maxChanges)
    invalid('A review supports at most ' + maxChanges + ' targeting changes across its line items.');
}
const filterOf = (types: string[]) => types.map(t => 'targetingType="' + t + '"').join(' OR ');
function chunks(types: string[]): string[][] {
  const out: string[][] = [];
  for (const t of types) {
    const last = out.at(-1);
    if (last && filterOf([...last, t]).length <= maxFilter) last.push(t);
    else out.push([t]);
  }
  return out;
}
function stateRead(
  p: CompiledRequest,
  path: string,
  marker: NonNullable<CompiledRequest['dv360TargetingState']>,
  optional = false,
): CompiledRequest {
  return stateReadOf(
    p,
    optional ? 'AMCP_STATE_OPTIONAL' : 'AMCP_DV360_TARGETING_STATE',
    path,
    {},
    {queryArrayEncoding: undefined, dv360TargetingState: marker},
  );
}
function targetingRead(p: CompiledRequest, e: Edit, types: string[]): CompiledRequest {
  if (e.level === 'advertiser')
    return {
      ...stateRead(p, '/v4/advertisers/' + e.advertiser + ':listAssignedTargetingOptions', {kind: 'targeting', types}),
      query: {filter: filterOf(types), pageSize},
    };
  if (e.level === 'ad_group') {
    const groups = [...e.owners].sort();
    return {
      ...stateRead(p, '/v4/advertisers/' + e.advertiser + '/adGroups:bulkListAssignedTargetingOptions', {
        kind: 'targeting',
        adGroupIds: groups,
        types,
      }),
      query: {adGroupIds: groups, filter: filterOf(types), pageSize},
      queryArrayEncoding: 'repeat',
    };
  }
  const lineItems = [...e.owners].sort();
  return {
    ...stateRead(p, '/v4/advertisers/' + e.advertiser + '/lineItems:bulkListAssignedTargetingOptions', {
      kind: 'targeting',
      lineItemIds: lineItems,
      types,
    }),
    query: {lineItemIds: lineItems, filter: filterOf(types), pageSize},
    queryArrayEncoding: 'repeat',
  };
}
const owners = (m: NonNullable<CompiledRequest['dv360TargetingState']>) =>
  m.lineItemIds ?? m.adGroupIds ?? [advertiserOwner];
const listKey = (read: CompiledRequest) =>
  read.path.endsWith(':listAssignedTargetingOptions')
    ? 'assignedTargetingOptions'
    : read.path.endsWith('/adGroups:bulkListAssignedTargetingOptions')
      ? 'adGroupAssignedTargetingOptions'
      : 'lineItemAssignedTargetingOptions';
/** The advertiser or each line item, then the complete assigned targeting of the edited types, then each assigned list. */
export function dv360TargetingSnapshots(p: CompiledRequest): CompiledRequest[] {
  const e = dv360TargetingKind(p)!,
    a = e.advertiser;
  const types = [...new Set([...e.deletes.map(d => d.type), ...e.creates.map(c => c.type)])].sort();
  const refs = new Map<string, CompiledRequest>();
  for (const c of e.creates) {
    const ref = references[c.type];
    if (!ref) continue;
    for (const o of c.options) {
      const id = String((o as JsonObject)[dv360DetailsField(c.type)][ref.field]),
        path = '/v4/advertisers/' + a + '/' + ref.collection + '/' + id;
      if (!refs.has(path)) refs.set(path, stateRead(p, path, {kind: 'reference', reference: c.type}, true));
    }
  }
  for (const c of e.creates) {
    if (c.type !== 'TARGETING_TYPE_AUDIENCE_GROUP') continue;
    for (const o of c.options)
      for (const r of audienceRefs((o as JsonObject)[dv360DetailsField(c.type)])) {
        const path = '/v4/' + r.collection + '/' + r.id;
        if (!refs.has(path))
          refs.set(path, {
            ...stateRead(p, path, {kind: 'audience', reference: r.collection}, true),
            query: {advertiserId: a},
          });
      }
  }
  const holders =
    e.level === 'advertiser'
      ? [stateRead(p, '/v4/advertisers/' + a, {kind: 'advertiser'})]
      : e.level === 'ad_group'
        ? e.owners.map(id => dv360AdGroupStateRead(p, {adGroupId: id}))
        : e.owners.map(id => stateRead(p, '/v4/advertisers/' + a + '/lineItems/' + id, {kind: 'line_item'}));
  return [...holders, ...chunks(types).map(ts => targetingRead(p, e, ts)), ...refs.values()];
}
export function isDV360TargetingRead(p: CompiledRequest): boolean {
  return p.gateway === 'dv360_native_action' && !!p.dv360TargetingState;
}
export function isDV360AudienceStateRead(p: CompiledRequest): boolean {
  return p.gateway === 'dv360_native_action' && p.dv360TargetingState?.kind === 'audience';
}
/** The identity and types of an audience; its sizes change daily and do not change what the review assigns. */
export function dv360AudienceReviewState(read: CompiledRequest, d: JsonObject): JsonObject {
  if (d.amcp_absent === true) return d;
  const c = dv360AudienceCollections[read.dv360TargetingState!.reference!]!;
  return Object.fromEntries(
    [
      c.id,
      'name',
      'displayName',
      'firstPartyAndPartnerAudienceType',
      'audienceType',
      'audienceSource',
      'googleAudienceType',
    ]
      .filter(k => d[k] !== undefined)
      .map(k => [k, d[k]]),
  );
}
function rowsOf(value: unknown): Row[] {
  if (!obj(value)) return [];
  if (Array.isArray(value.assignedTargetingOptions))
    return value.assignedTargetingOptions.filter(obj).map(o => ({owner: advertiserOwner, option: o}));
  if (Array.isArray(value.adGroupAssignedTargetingOptions))
    return value.adGroupAssignedTargetingOptions.filter(obj).map(r => ({
      owner: String(r.adGroupId),
      option: obj(r.assignedTargetingOption) ? r.assignedTargetingOption : {},
    }));
  return list(value.lineItemAssignedTargetingOptions)
    .filter(obj)
    .map(r => ({owner: String(r.lineItemId), option: obj(r.assignedTargetingOption) ? r.assignedTargetingOption : {}}));
}
export function validateDV360TargetingState(read: CompiledRequest, result: TransportResult): void {
  const m = read.dv360TargetingState!,
    d = result.data,
    account = read.accountId!;
  if (m.kind === 'audience' && result.status === 404) {
    if (read.action !== 'AMCP_STATE_OPTIONAL' || !obj(d) || d.amcp_absent !== true || d.path !== read.path)
      fail('STATE_TARGET_MISMATCH', 'Unqualified absent DV360 audience.');
    return;
  }
  if (m.kind === 'reference' && result.status === 404) {
    if (read.action !== 'AMCP_STATE_OPTIONAL' || !obj(d) || d.amcp_absent !== true || d.path !== read.path)
      fail('STATE_TARGET_MISMATCH', 'Unqualified absent DV360 reference.');
    return;
  }
  if (result.status !== 200 || !obj(d) || d.error)
    fail('STATE_READ_FAILED', 'DV360 targeting state requires a successful native response.');
  if (m.kind === 'line_item') {
    const id = read.path.split('/').at(-1);
    if (
      String(d.advertiserId) !== account ||
      String(d.lineItemId) !== id ||
      d.name !== read.path.slice(4) ||
      typeof d.lineItemType !== 'string' ||
      typeof d.entityStatus !== 'string'
    )
      fail('STATE_TARGET_MISMATCH', 'Line item state did not identify the exact selected-advertiser line item.');
    return;
  }
  if (m.kind === 'advertiser') {
    if (String(d.advertiserId) !== account || d.name !== 'advertisers/' + account || typeof d.entityStatus !== 'string')
      fail('STATE_TARGET_MISMATCH', 'Advertiser state did not identify the selected advertiser.');
    return;
  }
  if (m.kind === 'audience') {
    const c = dv360AudienceCollections[m.reference!]!,
      id = read.path.split('/').at(-1);
    if (String(d[c.id]) !== id || (d.name !== undefined && d.name !== m.reference + '/' + id))
      fail('STATE_TARGET_MISMATCH', 'The ' + c.label + ' did not identify the requested audience.');
    return;
  }
  if (m.kind === 'reference') {
    const ref = references[m.reference!]!,
      id = read.path.split('/').at(-1);
    if (String(d[ref.id]) !== id || String(d.advertiserId) !== account)
      fail('STATE_TARGET_MISMATCH', 'The ' + ref.label + ' did not identify the exact selected-advertiser resource.');
    return;
  }
  const key = listKey(read);
  if (d.nextPageToken) fail('INCOMPLETE_STATE', 'Assigned targeting was read incompletely.');
  if (d[key] !== undefined && !Array.isArray(d[key])) fail('STATE_READ_FAILED', 'Malformed assigned targeting list.');
  const seen = new Set<string>();
  for (const row of list(d[key])) {
    const advertiserRow = key === 'assignedTargetingOptions',
      groupRow = key === 'adGroupAssignedTargetingOptions',
      o = advertiserRow
        ? obj(row)
          ? row
          : undefined
        : obj(row) && obj(row.assignedTargetingOption)
          ? row.assignedTargetingOption
          : undefined,
      owner = advertiserRow ? advertiserOwner : obj(row) ? String(groupRow ? row.adGroupId : row.lineItemId) : '';
    if (
      !o ||
      !owners(m).includes(owner) ||
      !m.types!.includes(o.targetingType) ||
      typeof o.assignedTargetingOptionId !== 'string' ||
      !o.assignedTargetingOptionId ||
      !sameName(o.name, optionName(account, owner, o.targetingType, o.assignedTargetingOptionId, groupRow))
    )
      fail(
        'STATE_TARGET_MISMATCH',
        'Assigned targeting must belong to the requested ' +
          (advertiserRow ? 'advertiser' : groupRow ? 'ad groups' : 'line items') +
          ' and targeting types of the selected advertiser.',
      );
    const id = owner + ' ' + o.targetingType + ' ' + o.assignedTargetingOptionId;
    if (seen.has(id)) fail('STATE_TARGET_MISMATCH', 'DV360 returned an assigned targeting option twice.');
    seen.add(id);
  }
}
/** Complete bounded pagination of assigned targeting. Page tokens are opaque query values and are never followed as links. */
export async function readDV360Targeting(
  p: CompiledRequest,
  request: (read: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  if (p.dv360TargetingState?.kind !== 'targeting') return request(p);
  const key = listKey(p),
    rows: JsonObject[] = [],
    tokens = new Set<string>();
  let current = p;
  const sortKey = (r: JsonObject) => {
    const o = key === 'assignedTargetingOptions' ? r : r.assignedTargetingOption;
    return (
      String(r.lineItemId ?? r.adGroupId ?? '') +
      ' ' +
      String(o?.targetingType) +
      ' ' +
      String(o?.assignedTargetingOptionId)
    );
  };
  for (let page = 0; page < maxPages; page++) {
    const response = await request(current),
      d = response.data;
    if (
      response.status !== 200 ||
      !obj(d) ||
      d.error ||
      (d[key] !== undefined && !Array.isArray(d[key])) ||
      (d.nextPageToken !== undefined && typeof d.nextPageToken !== 'string')
    )
      fail(
        'STATE_READ_FAILED',
        'DV360 must return pages of the assigned targeting of the selected line items or advertiser.',
      );
    rows.push(...(list(d[key]) as JsonObject[]));
    if (rows.length > maxRows)
      fail(
        'STATE_TOO_LARGE',
        'More than ' + maxRows + ' assigned targeting options of these types exist; no mutation was submitted.',
      );
    if (!d.nextPageToken) {
      const sorted = rows.sort((a, b) => {
        const x = sortKey(a),
          y = sortKey(b);
        return x < y ? -1 : x > y ? 1 : 0;
      });
      const result = {...response, data: {[key]: sorted}};
      validateDV360TargetingState(p, result);
      return result;
    }
    if (tokens.has(d.nextPageToken)) fail('INCOMPLETE_STATE', 'DV360 repeated an assigned targeting page token.');
    tokens.add(d.nextPageToken);
    current = {...p, query: {...p.query, pageToken: d.nextPageToken}};
  }
  return fail('INCOMPLETE_STATE', 'Assigned targeting pagination exceeded ' + maxPages + ' pages.');
}
/** Current assignments per owner and type after this edit, as comparable keys. */
function finalKeys(e: Edit, rows: Row[], owner: string, type: string): string[] {
  const del = e.deletes.find(d => d.type === type)?.ids ?? [];
  const kept = rows
    .filter(r => r.owner === owner && r.option.targetingType === type && !del.some(id => matches(r.option, id)))
    .map(r => optionKey(type, r.option));
  return [...kept, ...(e.creates.find(c => c.type === type)?.options ?? []).map(o => optionKey(type, o))].sort();
}
/** Demand Gen targeting takes the documented types of its level, and location and language only where the line item's setting puts them. */
function demandGen(e: Edit, label: string, geoHere: boolean, types: string[]): void {
  for (const t of [...e.deletes.map(d => d.type), ...e.creates.map(c => c.type)])
    if (!types.includes(t))
      invalid(
        label +
          ' is Demand Gen; ' +
          t +
          ' is not among its targeting types (' +
          types.map(x => x.slice(15)).join(', ') +
          ').',
      );
  for (const c of e.creates)
    if (
      demandGenExclusions.has(c.type) &&
      c.options.some(o => obj(o) && obj(o[dv360DetailsField(c.type)]) && o[dv360DetailsField(c.type)].negative !== true)
    )
      invalid(
        label +
          ' is Demand Gen, which only excludes keywords, categories and placements; set negative to true for ' +
          c.type +
          '.',
      );
  for (const c of e.creates)
    if (geoLanguage.has(c.type) && !geoHere)
      invalid(
        label +
          ': location and language targeting of this Demand Gen line item belongs to ' +
          (e.level === 'ad_group' ? 'the line item' : 'its ad groups') +
          ' (demandGenSettings.geoLanguageTargetingEnabled).',
      );
}
export function validateDV360TargetingPrerequisites(plan: CompiledRequest, state: unknown[]): void {
  const e = dv360TargetingKind(plan);
  if (!e) return;
  const reads = dv360TargetingSnapshots(plan);
  if (state.length < reads.length) fail('STATE_READ_FAILED', 'DV360 targeting state is incomplete.');
  if (e.level === 'advertiser') {
    const adv = obj(state[0]) ? state[0] : {};
    if (!advertiserStatus.has(adv.entityStatus))
      invalid(
        'Advertiser ' +
          e.advertiser +
          ' is ' +
          adv.entityStatus +
          '; only active and paused advertisers can be retargeted.',
      );
  } else if (e.level === 'ad_group')
    e.owners.forEach((id, i) => {
      const s = obj(state[i]) ? state[i] : {},
        group = obj(s.adGroup) ? s.adGroup : undefined,
        line = obj(s.lineItem) ? s.lineItem : undefined;
      if (!group || !line) fail('STATE_READ_FAILED', 'Ad group ' + id + ' and its line item were not read.');
      if (group.entityStatus === 'ENTITY_STATUS_ARCHIVED' || line.entityStatus === 'ENTITY_STATUS_ARCHIVED')
        invalid('Ad group ' + id + ' or its line item is archived.');
      demandGen(e, 'Ad group ' + id, line.geoLanguageTargetingEnabled !== true, dv360AdGroupTargetingTypes);
    });
  else
    e.owners.forEach((id, i) => {
      const li = obj(state[i]) ? state[i] : {};
      if (li.lineItemType === 'LINE_ITEM_TYPE_DEMAND_GEN')
        demandGen(
          e,
          'Line item ' + id,
          obj(li.demandGenSettings) && li.demandGenSettings.geoLanguageTargetingEnabled === true,
          dv360DemandGenLineItemTypes,
        );
      else if (!lineItemTypes.has(li.lineItemType))
        invalid(
          'Line item ' +
            id +
            ' is ' +
            li.lineItemType +
            '; YouTube & Partners line items cannot be updated through the API.',
        );
      if (!editableStatus.has(li.entityStatus))
        invalid(
          'Line item ' +
            id +
            ' is ' +
            li.entityStatus +
            '; only active, paused and draft line items can be retargeted.',
        );
    });
  reads.forEach((r, i) => {
    if (r.dv360TargetingState?.kind !== 'reference') return;
    const ref = references[r.dv360TargetingState.reference!]!,
      d = obj(state[i]) ? state[i] : {},
      id = r.path.split('/').at(-1);
    if (d.amcp_absent === true)
      fail(
        'STATE_TARGET_MISMATCH',
        ref.label[0]!.toUpperCase() +
          ref.label.slice(1) +
          ' ' +
          id +
          ' is not owned by the selected advertiser. Partner-owned lists are not assigned by this contract.',
        {[ref.field]: id},
      );
    if (ref.locationType && d.locationType !== ref.locationType)
      invalid('Location list ' + id + ' is ' + d.locationType + ', not ' + ref.locationType + '.');
  });
  const audiences = new Map<string, JsonObject>();
  reads.forEach((r, i) => {
    if (r.dv360TargetingState?.kind !== 'audience') return;
    const c = dv360AudienceCollections[r.dv360TargetingState.reference!]!,
      d = obj(state[i]) ? state[i] : {},
      id = r.path.split('/').at(-1)!;
    if (d.amcp_absent === true)
      fail(
        'STATE_TARGET_MISMATCH',
        c.label[0]!.toUpperCase() +
          c.label.slice(1) +
          ' ' +
          id +
          ' is not available to advertiser ' +
          e.advertiser +
          '.',
        {[c.id]: id},
      );
    audiences.set(r.dv360TargetingState.reference + '/' + id, d);
  });
  for (const c of e.creates)
    if (c.type === 'TARGETING_TYPE_AUDIENCE_GROUP')
      for (const o of c.options)
        for (const r of audienceRefs((o as JsonObject)[dv360DetailsField(c.type)])) {
          const a = audiences.get(r.collection + '/' + r.id);
          if (!a) fail('STATE_READ_FAILED', 'Audience ' + r.id + ' was not read.');
          if (
            r.recency !== undefined &&
            r.recency !== 'RECENCY_NO_LIMIT' &&
            a.firstPartyAndPartnerAudienceType !== 'TYPE_FIRST_PARTY'
          )
            invalid(
              'Recency applies only to first-party audiences; audience ' +
                r.id +
                ' is ' +
                String(a.firstPartyAndPartnerAudienceType) +
                '.',
            );
          if (r.group === 'excludedGoogleAudienceGroup' && !excludableGoogleAudiences.has(a.googleAudienceType))
            invalid(
              'Only affinity, in-market and installed-apps Google audiences can be excluded; audience ' +
                r.id +
                ' is ' +
                String(a.googleAudienceType) +
                '.',
            );
        }
  const rows = reads.flatMap((r, i) => (r.dv360TargetingState?.kind === 'targeting' ? rowsOf(state[i]) : []));
  for (const owner of e.owners) {
    const label = ownerLabel(e, owner),
      mine = rows.filter(r => r.owner === owner).map(r => r.option);
    for (const d of e.deletes)
      for (const id of d.ids) {
        const row = mine.find(o => o.targetingType === d.type && matches(o, id));
        if (!row)
          fail('STATE_NOT_FOUND', label + ' has no ' + d.type + ' assignment ' + id + '.', {
            ...ownerDetails(e, owner),
            assigned_targeting_option_id: id,
          });
        if (inherited(row))
          invalid(
            label +
              ' inherits ' +
              d.type +
              ' assignment ' +
              id +
              ' (' +
              row.inheritance +
              '); change it where it is set.',
          );
      }
    const kept = mine.filter(o => !e.deletes.some(d => d.type === o.targetingType && d.ids.some(id => matches(o, id))));
    for (const c of e.creates)
      for (const o of c.options) {
        const key = optionKey(c.type, o),
          existing = kept.find(k => k.targetingType === c.type && optionKey(c.type, k) === key);
        if (existing)
          fail(
            'CONFIGURATION_EXISTS',
            label +
              ' already has this ' +
              c.type +
              ' assignment' +
              (inherited(existing) ? ' (' + existing.inheritance + ')' : '') +
              '.',
            {...ownerDetails(e, owner), assigned_targeting_option_id: existing.assignedTargetingOptionId},
          );
      }
    // Limits apply to the resource's own assignments after the edit.
    for (const type of new Set(e.creates.map(c => c.type))) {
      const own = [
        ...kept
          .filter(o => o.targetingType === type && !inherited(o))
          .map(o => o[dv360DetailsField(type)] as JsonObject),
        ...(e.creates.find(c => c.type === type)!.options as JsonObject[]).map(
          o => o[dv360DetailsField(type)] as JsonObject,
        ),
      ];
      if (singleOption.has(type) && own.length > 1)
        invalid(label + ' can have only one ' + type + ' assignment; delete the current one in the same review.');
      if (type === 'TARGETING_TYPE_NEGATIVE_KEYWORD_LIST' && own.length > 4)
        invalid(label + ' can have at most 4 negative keyword lists.');
      if (type === 'TARGETING_TYPE_KEYWORD' && own.filter(o => o?.negative === true).length > 5000)
        invalid(label + ' can have at most 5000 direct negative keywords.');
      if (sharedNegative.has(type) && new Set(own.map(o => o?.negative === true)).size > 1)
        invalid(
          'All ' +
            type +
            ' assignments of ' +
            label[0]!.toLowerCase() +
            label.slice(1) +
            ' must be either targeted or excluded; delete the others in the same review.',
        );
    }
  }
}
export function dv360TargetingImpact(plan: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const e = dv360TargetingKind(plan);
  if (!e) return;
  const changes = {
    deletes: e.deletes.map(d => ({targeting_type: d.type, assigned_targeting_option_ids: d.ids})),
    creates: e.creates.map(c => ({
      targeting_type: c.type,
      options: c.options.map(o => clean(detailsSchema(c.type), (o as JsonObject)[dv360DetailsField(c.type)])),
    })),
  };
  if (e.level === 'advertiser') {
    const adv = obj(state[0]) ? state[0] : {};
    return {
      provider: 'dv360',
      scope: 'advertiser_targeting',
      advertiser: {
        advertiser_id: e.advertiser,
        display_name: adv.displayName ?? null,
        entity_status: adv.entityStatus ?? null,
      },
      may_affect_serving: true,
      ...changes,
      effect:
        'Every line item of this advertiser inherits advertiser targeting and cannot change it. Adding an exclusion narrows delivery of all of them; removing one broadens delivery of all of them, including active line items.',
      inheritance: 'Partner targeting is inherited by the advertiser and cannot be changed here.',
      verification:
        'Reads the complete advertiser targeting of the edited types and compares it with the expected result.',
      source:
        'https://developers.google.com/display-video/api/reference/rest/v4/advertisers/editAssignedTargetingOptions',
    };
  }
  if (e.level === 'ad_group') {
    const groups = e.owners.map((id, i) => {
      const s = obj(state[i]) ? state[i] : {},
        g = obj(s.adGroup) ? s.adGroup : {},
        l = obj(s.lineItem) ? s.lineItem : {};
      return {
        ad_group_id: id,
        display_name: g.displayName ?? null,
        entity_status: g.entityStatus ?? null,
        line_item_id: l.lineItemId ?? null,
        line_item_status: l.entityStatus ?? null,
        serving: g.entityStatus === 'ENTITY_STATUS_ACTIVE' && l.entityStatus === 'ENTITY_STATUS_ACTIVE',
      };
    });
    return {
      provider: 'dv360',
      scope: 'ad_group_targeting',
      ad_groups: groups,
      may_affect_serving: groups.some(g => g.entity_status === 'ENTITY_STATUS_ACTIVE'),
      ...changes,
      effect:
        'Changes which people and placements the listed Demand Gen ad groups reach. Removing targeting broadens reach; adding narrows it. Active ad groups under active line items change delivery at once.',
      ...(e.route === 'bulk'
        ? {
            bulk_semantics:
              'DV360 deletes, then creates, for each ad group; when one ad group fails the others are still updated, and the receipt lists failed ad groups.',
          }
        : {}),
      inheritance:
        'Partner, advertiser and line item targeting also applies; Demand Gen resources show only inherited keyword targeting.',
      verification:
        'Reads the complete assigned targeting of the edited types for every listed ad group and compares it with the expected result.',
      source: 'https://developers.google.com/display-video/api/guides/tasks/serve-demand-gen-ad/assign-targeting',
    };
  }
  const lineItems = e.owners.map((id, i) => {
    const li = obj(state[i]) ? state[i] : {};
    return {
      line_item_id: id,
      display_name: li.displayName ?? null,
      line_item_type: li.lineItemType ?? null,
      entity_status: li.entityStatus ?? null,
      serving: li.entityStatus === 'ENTITY_STATUS_ACTIVE',
    };
  });
  return {
    provider: 'dv360',
    scope: 'line_item_targeting',
    line_items: lineItems,
    may_affect_serving: lineItems.some(l => l.serving),
    ...changes,
    effect:
      'Changes which impressions the listed line items can buy. Removing targeting broadens eligible inventory and audiences; adding narrows it. Active line items change delivery immediately.',
    ...(e.route === 'bulk'
      ? {
          bulk_semantics:
            'DV360 deletes, then creates. Each line item is updated atomically, but when one line item fails the others are still updated; the receipt lists failed line items.',
        }
      : {}),
    inheritance: 'Partner and advertiser targeting is inherited and cannot be changed at line item level.',
    verification:
      'Reads the complete assigned targeting of the edited types for every listed line item and compares it with the expected result.',
    source: 'https://developers.google.com/display-video/api/guides/tasks/run-ad-campaign/assign-targeting',
  };
}
function createdOption(e: Edit, o: unknown, owner: string, types: string[]): boolean {
  return (
    obj(o) &&
    typeof o.assignedTargetingOptionId === 'string' &&
    !!o.assignedTargetingOptionId &&
    types.includes(o.targetingType) &&
    obj(o[dv360DetailsField(o.targetingType)]) &&
    sameName(
      o.name,
      optionName(e.advertiser, owner, o.targetingType, o.assignedTargetingOptionId, e.level === 'ad_group'),
    )
  );
}
export function dv360TargetingOutcome(plan: CompiledRequest, response: TransportResult): boolean {
  const e = dv360TargetingKind(plan)!,
    d = response.data;
  if (response.status !== 200 || !obj(d) || d.error) return false;
  if (e.route === 'delete') return Object.keys(d).length === 0;
  if (e.route === 'create') return createdOption(e, d, e.owners[0]!, [e.creates[0]!.type]);
  if (e.level === 'advertiser') {
    // The response lists every created option; its count per type must equal the review.
    const created = list(d.createdAssignedTargetingOptions),
      count = (types: unknown[], type: string) => types.filter(t => t === type).length;
    return (
      created.length === e.creates.reduce((n, c) => n + c.options.length, 0) &&
      created.every(o =>
        createdOption(
          e,
          o,
          advertiserOwner,
          e.creates.map(c => c.type),
        ),
      ) &&
      e.creates.every(
        c =>
          count(
            created.map(o => (o as JsonObject).targetingType),
            c.type,
          ) === c.options.length,
      )
    );
  }
  if (e.level === 'ad_group') {
    const groups = list(d.updatedAdGroupIds).map(String).sort();
    return (
      stable(groups) === stable([...e.owners].sort()) && !list(d.failedAdGroupIds).length && !list(d.errors).length
    );
  }
  const updated = list(d.updatedLineItemIds).map(String).sort();
  return (
    stable(updated) === stable([...e.owners].sort()) && !list(d.failedLineItemIds).length && !list(d.errors).length
  );
}
export function dv360TargetingVerification(
  plan: CompiledRequest,
  before: unknown[],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const e = dv360TargetingKind(plan)!;
  return dv360TargetingSnapshots(plan).flatMap((read, i) => {
    // Ad group holders carry the ad group read marker, not a targeting one.
    const m = read.dv360TargetingState;
    if (m?.kind !== 'targeting') return [];
    const rows = rowsOf(before[i]),
      expected: JsonObject = {};
    for (const owner of owners(m)) {
      expected[owner] = {};
      for (const type of m.types!) expected[owner][type] = finalKeys(e, rows, owner, type);
    }
    return [
      {
        read,
        expected: {targeting: expected},
        id:
          (m.lineItemIds
            ? 'lineItems ' + m.lineItemIds.join(',')
            : m.adGroupIds
              ? 'adGroups ' + m.adGroupIds.join(',')
              : 'advertiser ' + e.advertiser) +
          ' ' +
          m.types!.join(','),
      },
    ];
  });
}
export function dv360TargetingObserved(read: CompiledRequest, data: JsonObject): JsonObject {
  const m = read.dv360TargetingState;
  if (m?.kind !== 'targeting') return data;
  const rows = rowsOf(data),
    out: JsonObject = {};
  for (const owner of owners(m)) {
    out[owner] = {};
    for (const type of m.types!)
      out[owner][type] = rows
        .filter(r => r.owner === owner && r.option.targetingType === type)
        .map(r => optionKey(type, r.option))
        .sort();
  }
  return {targeting: out};
}
export function dv360TargetingRemoves(p: CompiledRequest): boolean {
  const e = dv360TargetingKind(p);
  return !!e && e.deletes.some(d => d.ids.length > 0);
}
/** Targeting of an active line item, or of an advertiser, changes delivery at once, so an owner policy that forbids activation forbids it; unknown state counts as active. */
export function dv360TargetingServing(p: CompiledRequest, before: unknown): boolean {
  const e = dv360TargetingKind(p);
  if (!e) return false;
  if (e.level === 'advertiser') return true;
  if (e.level === 'ad_group')
    return (
      !Array.isArray(before) ||
      e.owners.some((_, i) => {
        const s = before[i];
        return !obj(s) || !obj(s.adGroup) || s.adGroup.entityStatus === 'ENTITY_STATUS_ACTIVE';
      })
    );
  return (
    !Array.isArray(before) ||
    e.owners.some((_, i) => !obj(before[i]) || before[i].entityStatus === 'ENTITY_STATUS_ACTIVE')
  );
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const dv360AdGroupTargetingFamily: ReviewedFamily = defineFamily({
  name: 'dv360_ad_group_targeting',
  files: ['src/dv360-line-item-targeting.ts', ['tests/dv360-ad-group-targeting.test.mjs']],
  kind: dv360AdGroupTargetingKind,
  assert: plan => assertDV360Targeting(plan),
  scope: (c, write) => {
    if (write) assertDV360WriteScope(c, true);
  },
  snapshots: dv360TargetingSnapshots,
  prerequisites: (plan, state) => validateDV360TargetingPrerequisites(plan, state),
  impact: dv360TargetingImpact,
  outcome: dv360TargetingOutcome,
  verification: (plan: CompiledRequest, result: JsonObject, before: unknown[]) =>
    dv360TargetingVerification(plan, before),
  spendConfirmation: {
    needed: () => true,
    message:
      'DV360 targeting changes which impressions line items and ad groups can buy, at once for active ones. Review them and the changes and provide spend_change_confirmed=true.',
  },
  activates: (plan, before) => !!dv360TargetingServing(plan, before),
  destructive: plan => !!dv360TargetingRemoves(plan),
});

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const dv360AdvertiserTargetingFamily: ReviewedFamily = defineFamily({
  name: 'dv360_advertiser_targeting',
  files: ['src/dv360-line-item-targeting.ts', ['tests/dv360-advertiser-targeting.test.ts']],
  kind: dv360AdvertiserTargetingKind,
  assert: plan => assertDV360Targeting(plan),
  scope: (c, write) => {
    if (write) assertDV360WriteScope(c, true);
  },
  snapshots: dv360TargetingSnapshots,
  prerequisites: (plan, state) => validateDV360TargetingPrerequisites(plan, state),
  impact: dv360TargetingImpact,
  outcome: dv360TargetingOutcome,
  verification: (plan: CompiledRequest, result: JsonObject, before: unknown[]) =>
    dv360TargetingVerification(plan, before),
  spendConfirmation: {
    needed: () => true,
    message:
      'DV360 targeting changes which impressions line items and ad groups can buy, at once for active ones. Review them and the changes and provide spend_change_confirmed=true.',
  },
  activates: (plan, before) => !!dv360TargetingServing(plan, before),
  destructive: plan => !!dv360TargetingRemoves(plan),
});

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const dv360LineItemTargetingFamily: ReviewedFamily = defineFamily({
  name: 'dv360_line_item_targeting',
  files: ['src/dv360-line-item-targeting.ts', ['tests/dv360-line-item-targeting.test.ts']],
  kind: dv360LineItemTargetingKind,
  assert: plan => assertDV360Targeting(plan),
  scope: (c, write) => {
    if (write) assertDV360WriteScope(c, true);
  },
  snapshots: dv360TargetingSnapshots,
  isRead: isDV360TargetingRead,
  reader: (read, next) => readDV360Targeting(read, next),
  validateState: validateDV360TargetingState,
  snapshotState: (read: CompiledRequest, data: JsonObject) =>
    isDV360AudienceStateRead(read) ? dv360AudienceReviewState(read, data) : data,
  prerequisites: (plan, state) => validateDV360TargetingPrerequisites(plan, state),
  impact: dv360TargetingImpact,
  outcome: dv360TargetingOutcome,
  verification: (plan: CompiledRequest, result: JsonObject, before: unknown[]) =>
    dv360TargetingVerification(plan, before),
  observed: (read: CompiledRequest, data: JsonObject) =>
    data.amcp_absent === true ? data : dv360TargetingObserved(read, data),
  spendConfirmation: {
    needed: () => true,
    message:
      'DV360 targeting changes which impressions line items and ad groups can buy, at once for active ones. Review them and the changes and provide spend_change_confirmed=true.',
  },
  activates: (plan, before) => !!dv360TargetingServing(plan, before),
  destructive: plan => !!dv360TargetingRemoves(plan),
});
