import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import {defineFamily, familyCodeError, type OneCodeRefusal} from './family-kit.js';
import type {CompiledRequest, DeclaredOperation, JsonObject} from './types.js';
import {compileMicrosoft, getByIdsPayload} from './microsoft-native.js';

/**
 * Microsoft Advertising campaign location criteria (CMP-03, owner decision P7). A campaign created through the API has
 * no criteria and effectively targets every location until one is added (Microsoft's targeting guide), so AMCP
 * activates a Microsoft campaign only once it holds a positive location criterion, and this reviewed family is how AMCP
 * adds one.
 *
 * Contracts: the v13 REST pages of AddCampaignCriterions, GetCampaignCriterionsByIds and DeleteCampaignCriterions,
 * pinned in .mirror/VENDOR/microsoft-rest-v13.json (tools/microsoft-rest.mjs), and the pinned Campaign Management
 * WSDL. The rules below come from Microsoft Learn (those pages, the data-object pages they use, the targeting guide and
 * the geographical location codes guide); the pin records each page's read time and the rules taken from it
 * (`relies_on`), so a changed page is checked against them:
 * - Location criteria are added and deleted with CriterionType `Targets`, but read with CriterionType `Location`
 *   (`Targets` is not allowed on the read); a read with CampaignCriterionIds null returns every location criterion of
 *   the campaign.
 * - A positive location is a `BiddableCampaignCriterion` holding a `LocationCriterion` (LocationId from Microsoft's
 *   geographical locations file); a `NegativeCampaignCriterion` excludes a location. Status, Id, DisplayName and
 *   LocationType are read-only on add; the bid multiplier is optional and Microsoft sets 0 when it is omitted.
 * - The first criterion adds a LocationIntentCriterion with IntentOption PeopleInOrSearchingForOrViewingPages; ad-group
 *   location criteria, when an ad group has any, replace the campaign's for that ad group.
 * - AddCampaignCriterions answers with CampaignCriterionIds (null where a row failed) and NestedPartialErrors (the
 *   failures, not aligned with the rows).
 * - A deprecated location cannot be added, and a deprecated location criterion still reads back but no longer targets.
 *   A criterion read does not show a location's status in the geographical locations file, so the activation gate
 *   lists each location's ID and name for the operator to confirm.
 *
 * Phase 1 (the ticket's proposal): positive LocationCriterion rows only, no bid multiplier (a multiplier changes what
 * is paid), one campaign per request, and only while that campaign is paused, so adding or removing a location can
 * neither start nor widen delivery. Activation stays a separate reviewed change (microsoft-native.ts reads the
 * campaign's location criteria before an UpdateCampaigns that sets Status Active).
 */
const gateway = 'microsoft_ads_native_action';
/**
 * A function that reads no module constant: microsoft-native.ts calls it while it is evaluated, which may be before this
 * module's own body has run (the two modules import each other).
 */
export function microsoftCriterionContracts() {
  const base = '/CampaignManagement/v13/';
  return [
    {
      name: 'GetCampaignCriterionsByIds',
      method: 'POST',
      path: base + 'CampaignCriterions/QueryByIds',
      fields: ['CampaignCriterionIds', 'CampaignId', 'CriterionType', 'ReturnAdditionalFields'],
      required: ['CampaignId', 'CriterionType'],
      result: 'CampaignCriterions',
      kind: 'CampaignCriterions',
      parent: 'CampaignId',
    },
    {
      name: 'AddCampaignCriterions',
      method: 'POST',
      path: base + 'CampaignCriterions',
      fields: ['CampaignCriterions', 'CriterionType'],
      required: ['CampaignCriterions', 'CriterionType'],
      result: 'CampaignCriterionIds',
      kind: 'CampaignCriterions',
    },
    {
      name: 'DeleteCampaignCriterions',
      method: 'DELETE',
      path: base + 'CampaignCriterions',
      fields: ['CampaignCriterionIds', 'CampaignId', 'CriterionType'],
      required: ['CampaignCriterionIds', 'CampaignId', 'CriterionType'],
      result: 'PartialErrors',
      kind: 'CampaignCriterions',
      parent: 'CampaignId',
    },
  ];
}
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown) =>
  typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
const fail: OneCodeRefusal = familyCodeError('INVALID_MICROSOFT_REQUEST');
/** A campaign-criterion write (add or delete) of this family, at any route; kind() also checks the exact route. */
export function microsoftCriterionWrite(p: CompiledRequest): boolean {
  return p.gateway === gateway && ['AddCampaignCriterions', 'DeleteCampaignCriterions'].includes(p.action);
}
function microsoftCriterionKind(p: CompiledRequest): boolean {
  return (
    microsoftCriterionWrite(p) &&
    microsoftCriterionContracts().some(c => c.name === p.action && c.path === p.path && c.method === p.method)
  );
}
/** What the review's summary names for an AddCampaignCriterions (R2.5 S2-1): a create of every row it lists. A deletion keeps its words. */
export function microsoftCriterionOperation(p: CompiledRequest): DeclaredOperation | undefined {
  const rows = obj(p.body) ? p.body.CampaignCriterions : undefined;
  if (p.method !== 'POST') return undefined;
  return {operation: 'create', entity: 'campaign criterion', count: Array.isArray(rows) ? rows.length : undefined};
}
/** The one campaign a criterion write changes. */
export function criterionCampaign(p: CompiledRequest): string {
  const b = p.body as JsonObject;
  return p.method === 'DELETE' ? b.CampaignId : b.CampaignCriterions[0].CampaignId;
}
/**
 * A positive location criterion of `campaign`, as Microsoft returns it: a BiddableCampaignCriterion holding a location
 * criterion (Type LocationCriterion in the REST templates; the reference page names the read value Location).
 */
export function positiveLocation(row: unknown, campaign: string): boolean {
  return (
    obj(row) &&
    row.Type === 'BiddableCampaignCriterion' &&
    String(row.CampaignId) === campaign &&
    obj(row.Criterion) &&
    ['LocationCriterion', 'Location'].includes(row.Criterion.Type) &&
    /^[1-9][0-9]*$/.test(String(row.Criterion.LocationId ?? '')) &&
    [undefined, null, 'Active'].includes(row.Status)
  );
}
/** The read of every location criterion of a campaign (CampaignCriterionIds null), or of the IDs given. */
export function locationCriteriaPayload(campaign: string, ids: string[] | null = null): JsonObject {
  return {CampaignId: campaign, CriterionType: 'Location', CampaignCriterionIds: ids};
}
const shape =
  'Add 1–100 positive location criteria, each exactly {"Type":"BiddableCampaignCriterion","CampaignId","Criterion":{"Type":"LocationCriterion","LocationId"}}. Negative criteria, other criterion types, Id, Status and bid or cashback adjustments are not part of this reviewed contract; Microsoft applies no bid adjustment when CriterionBid is omitted.';
export function assertMicrosoftCriteria(p: CompiledRequest): void {
  const b = p.body as JsonObject;
  if (b.CriterionType !== 'Targets')
    fail('Microsoft location criteria are added and deleted with CriterionType Targets.', {field: 'CriterionType'});
  if (p.method === 'DELETE') return;
  const rows = b.CampaignCriterions;
  if (
    !Array.isArray(rows) ||
    !rows.length ||
    rows.length > 100 ||
    rows.some(
      r =>
        !obj(r) ||
        Object.keys(r).sort().join() !== 'CampaignId,Criterion,Type' ||
        r.Type !== 'BiddableCampaignCriterion' ||
        !numeric(r.CampaignId) ||
        !obj(r.Criterion) ||
        Object.keys(r.Criterion).sort().join() !== 'LocationId,Type' ||
        r.Criterion.Type !== 'LocationCriterion' ||
        !numeric(r.Criterion.LocationId),
    )
  )
    fail(shape);
  if (new Set(rows.map((r: JsonObject) => r.CampaignId)).size !== 1)
    fail('All location criteria of one request must name the same campaign.');
  if (new Set(rows.map((r: JsonObject) => r.Criterion.LocationId)).size !== rows.length)
    fail('Each location may be added once per request.');
}
export function microsoftCriterionSnapshots(p: CompiledRequest): CompiledRequest[] {
  const campaign = criterionCampaign(p),
    read = (action: string, payload: JsonObject) => compileMicrosoft({action, account_id: p.accountId, payload});
  return [
    read('GetAccount', {}),
    // The parent campaign read by exact ID under the account header: a campaign of another account is not returned.
    read('GetCampaignsByIds', getByIdsPayload('Campaigns', undefined, [campaign])),
    read('GetCampaignCriterionsByIds', locationCriteriaPayload(campaign)),
  ];
}
/** Microsoft's statuses of a campaign paused by its advertiser (a budget pause alone does not count). */
const paused = ['Paused', 'BudgetAndManualPaused'];
export function microsoftCriterionPrerequisites(p: CompiledRequest, state: unknown[], reads: CompiledRequest[]): void {
  const at = (action: string): JsonObject => {
      const value = state[reads.findIndex(r => r.action === action)];
      return obj(value) ? value : {};
    },
    campaignId = criterionCampaign(p),
    campaign = (at('GetCampaignsByIds').Campaigns ?? []).find((c: unknown) => obj(c) && c.Id === campaignId),
    existing = ((at('GetCampaignCriterionsByIds').CampaignCriterions ?? []) as unknown[]).filter(obj),
    b = p.body as JsonObject;
  if (!obj(campaign) || !paused.includes(campaign.Status))
    throw new MirrorError(
      'LOCATION_PARENT_NOT_PAUSED',
      'AMCP changes a Microsoft campaign’s location criteria only while the campaign is paused, so the change can neither start nor widen delivery.',
      {campaign_id: campaignId, status: obj(campaign) ? (campaign.Status ?? null) : null},
      409,
    );
  if (p.method === 'POST') {
    const repeated = (b.CampaignCriterions as JsonObject[])
      .map(r => r.Criterion.LocationId)
      .filter(id => existing.some(r => String(r.Criterion?.LocationId) === id));
    if (repeated.length)
      throw new MirrorError(
        'CONFIGURATION_EXISTS',
        'The campaign already has a location criterion for a requested location. Read its current location criteria instead of adding the location again.',
        {campaign_id: campaignId, location_ids: repeated},
        409,
      );
    return;
  }
  const missing = (b.CampaignCriterionIds as string[]).filter(
    id => !existing.some(r => String(r.Id) === id && positiveLocation(r, campaignId)),
  );
  if (missing.length)
    throw new MirrorError(
      'STATE_NOT_FOUND',
      'Only an existing positive location criterion of this campaign can be deleted through this contract.',
      {campaign_id: campaignId, campaign_criterion_ids: missing},
      404,
    );
}
/** AddCampaignCriterions confirms every row (an ID for each, no nested error); a deletion answers PartialErrors. */
export function microsoftCriterionOutcome(p: CompiledRequest, result: {status: number; data: unknown}): boolean {
  const d = result.data,
    clean = (key: string) =>
      obj(d) &&
      Object.hasOwn(d, key) &&
      (d[key] === null || (Array.isArray(d[key]) && d[key].every((e: unknown) => e === null)));
  if (result.status !== 200 || !obj(d)) return false;
  if (p.method === 'DELETE') return clean('PartialErrors');
  const ids = d.CampaignCriterionIds,
    rows = (p.body as JsonObject).CampaignCriterions;
  return (
    (clean('NestedPartialErrors') || !Object.hasOwn(d, 'NestedPartialErrors')) &&
    (clean('PartialErrors') || !Object.hasOwn(d, 'PartialErrors')) &&
    Array.isArray(ids) &&
    ids.length === rows.length &&
    ids.every(numeric) &&
    new Set(ids).size === ids.length
  );
}
/**
 * Reads each added criterion back by its ID (Microsoft names the location in DisplayName), and confirms each deleted
 * criterion is gone from the campaign's location criteria (Get operations do not return deleted criteria, and a read by
 * a deleted ID may answer with a partial error instead of an empty slot).
 */
export function microsoftCriterionVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const b = p.body as JsonObject,
    campaign = criterionCampaign(p),
    read = (id: string, ids: string[] | null): CompiledRequest => {
      const r = compileMicrosoft({
        action: 'GetCampaignCriterionsByIds',
        account_id: p.accountId,
        payload: locationCriteriaPayload(campaign, ids),
      });
      return {...r, scopeContext: {...r.scopeContext, microsoftCriterionId: id}};
    };
  if (p.method === 'DELETE')
    return (b.CampaignCriterionIds as string[]).map(id => ({read: read(id, null), expected: {present: false}, id}));
  const ids = result.data?.CampaignCriterionIds;
  if (!Array.isArray(ids)) return [];
  return ids.map((id: string, i: number) => ({
    read: read(id, [id]),
    expected: {
      present: true,
      positive: true,
      CampaignId: campaign,
      LocationId: b.CampaignCriterions[i].Criterion.LocationId,
      BidMultiplier: 0,
    },
    id,
  }));
}
/** What a verification read shows of one criterion: present or not, and what Microsoft holds for it. */
export function microsoftCriterionObserved(read: CompiledRequest, data: JsonObject): JsonObject {
  if (data.amcp_absent === true) return data;
  const id = read.scopeContext!.microsoftCriterionId!,
    campaign = (read.body as JsonObject).CampaignId,
    row = (Array.isArray(data.CampaignCriterions) ? data.CampaignCriterions : []).find(
      (r: unknown) => obj(r) && String(r.Id) === id,
    );
  if (!row) return {present: false};
  return {
    present: true,
    positive: positiveLocation(row, campaign),
    CampaignId: String(row.CampaignId),
    LocationId: String(row.Criterion?.LocationId ?? ''),
    BidMultiplier: row.CriterionBid?.Multiplier ?? 0,
    DisplayName: row.Criterion?.DisplayName ?? null,
    LocationType: row.Criterion?.LocationType ?? null,
  };
}
/** Refuses a criterion read that returns a criterion of another campaign. */
export function validateMicrosoftCriteria(read: CompiledRequest, data: JsonObject): void {
  const campaign = (read.body as JsonObject).CampaignId;
  if (
    (data.CampaignCriterions ?? []).some((r: unknown) => r !== null && (!obj(r) || String(r.CampaignId) !== campaign))
  )
    throw new MirrorError(
      'STATE_TARGET_MISMATCH',
      'Microsoft returned a campaign criterion of another campaign.',
      {campaign_id: campaign},
      502,
    );
}
/** What a location-criterion write changes, as prepare returns it for review. */
export function microsoftCriterionImpact(p: CompiledRequest): JsonObject {
  return {
    provider: 'microsoft',
    effect:
      p.method === 'DELETE'
        ? 'Removes location targets from a paused Microsoft Search campaign.'
        : 'Adds positive location targets to a paused Microsoft Search campaign. The campaign’s location intent applies; Microsoft’s default, set with a campaign’s first criterion, is people in, searching for or viewing pages about these locations.',
    may_activate: false,
    limits:
      'The campaign stays paused; activating it is a separate reviewed change, refused without a positive location criterion. Ad-group location criteria, which replace the campaign’s for their ad group, are not read or changed. Activation preflight lists each location with the name Microsoft gives it; confirm the names before approving the activation.',
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const microsoftCriterionFamily: ReviewedFamily = defineFamily({
  name: 'microsoft_location_targets',
  files: ['src/microsoft-campaign-criteria.ts', ['tests/microsoft-campaign-criteria.test.ts']],
  kind: microsoftCriterionKind,
  operation: microsoftCriterionOperation,
  snapshots: microsoftCriterionSnapshots,
  prerequisites: microsoftCriterionPrerequisites,
  impact: microsoftCriterionImpact,
  outcome: microsoftCriterionOutcome,
  verification: (plan, result) => microsoftCriterionVerification(plan, result),
  // Only the verification reads, which name the criterion they look for.
  isRead: read =>
    read.gateway === gateway &&
    read.action === 'GetCampaignCriterionsByIds' &&
    typeof read.scopeContext?.microsoftCriterionId === 'string',
  observed: (read, data) => microsoftCriterionObserved(read, data),
  activates: () => false,
});
