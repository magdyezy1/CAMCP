import {microsoftOutcome, microsoftSnapshots, compileMicrosoft} from './microsoft-native.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import {familyCodeError, type OneCodeRefusal} from './family-kit.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {microsoftAssociationContracts, microsoftExtensionTypes} from './microsoft-association-contracts.js';
type Compile = (input: JsonObject) => CompiledRequest;

// The contract data lives in a leaf that src/microsoft-native.ts reads while it is evaluated (ARC-04).
export {microsoftAssociationContracts, microsoftExtensionTypes};
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const fail: OneCodeRefusal = familyCodeError('INVALID_MICROSOFT_ASSOCIATION');
export function microsoftAssociationWrite(p: CompiledRequest) {
  return (
    p.gateway === 'microsoft_ads_native_action' &&
    ['SetAdExtensionsAssociations', 'DeleteAdExtensionsAssociations'].includes(p.action)
  );
}
/** An association write at the exact route of its contract. */
export function microsoftAssociationKind(p: CompiledRequest): boolean {
  return (
    microsoftAssociationWrite(p) &&
    microsoftAssociationContracts.some(c => c.name === p.action && c.path === p.path && c.method === p.method)
  );
}
export function microsoftAssociationActivates(p: CompiledRequest) {
  return microsoftAssociationWrite(p) && p.action === 'SetAdExtensionsAssociations';
}
export function extensionTypes(value: unknown): string[] {
  if (typeof value !== 'string' || !value || value !== value.trim())
    return fail('AdExtensionType must be the documented space-separated type flags.');
  const types = value.split(' ');
  if (new Set(types).size !== types.length || types.some(t => !microsoftExtensionTypes.includes(t)))
    fail('Use known, unique AdExtensionType flags.');
  return types;
}
export function assertMicrosoftAssociation(p: CompiledRequest) {
  const b = p.body as JsonObject,
    rows = b.AdExtensionIdToEntityIdAssociations;
  if (!['Account', 'Campaign', 'AdGroup'].includes(b.AssociationType))
    fail('Choose one AssociationType: Account, Campaign or AdGroup.');
  if (
    !Array.isArray(rows) ||
    !rows.length ||
    rows.length > 100 ||
    rows.some(
      r =>
        !obj(r) ||
        Object.keys(r).some(k => !['AdExtensionId', 'EntityId'].includes(k)) ||
        ['AdExtensionId', 'EntityId'].some(
          k => typeof r[k] !== 'string' || !/^[1-9][0-9]{0,18}$/.test(r[k]) || BigInt(r[k]) > 9223372036854775807n,
        ),
    )
  )
    fail('Use 1â€“100 exact positive 64-bit string AdExtensionId/EntityId pairs.');
  if (new Set(rows.map((r: JsonObject) => r.EntityId + '/' + r.AdExtensionId)).size !== rows.length)
    fail('Association pairs must be unique.');
  const types = p.scopeContext?.microsoftExtensionTypes;
  if (!types?.length)
    return fail('Provide ad_extension_types from discovery so exact asset content can be read for review.');
  extensionTypes(types.join(' '));
  if (b.AssociationType === 'Account' && rows.some((r: JsonObject) => r.EntityId !== p.accountId))
    fail('Account associations must name the selected account.');
  if (b.AssociationType === 'AdGroup' && !p.scopeContext?.campaignId)
    fail('Ad-group associations require campaign_id for exact parent validation.');
  if (
    (types.includes('CallAdExtension') && b.AssociationType !== 'Campaign') ||
    (types.includes('LocationAdExtension') && b.AssociationType === 'AdGroup')
  )
    fail('Call extensions are campaign-only; location extensions cannot attach to ad groups.');
}
function reader(p: CompiledRequest, compile: Compile) {
  return (action: string, payload: JsonObject) => compile({action, account_id: p.accountId, payload});
}
export function microsoftAssociationSnapshots(p: CompiledRequest, compile: Compile): CompiledRequest[] {
  const read = reader(p, compile),
    b = p.body as JsonObject,
    pairs = b.AdExtensionIdToEntityIdAssociations as JsonObject[],
    entityIds = [...new Set(pairs.map(r => r.EntityId))].sort(),
    assetIds = [...new Set(pairs.map(r => r.AdExtensionId))].sort(),
    types = p.scopeContext!.microsoftExtensionTypes!.join(' '),
    reads = [read('GetAccount', {})];
  if (b.AssociationType === 'Campaign')
    reads.push(read('GetCampaignsByIds', {CampaignIds: entityIds, CampaignType: 'Search'}));
  if (b.AssociationType === 'AdGroup')
    reads.push(
      read('GetCampaignsByIds', {CampaignIds: [p.scopeContext!.campaignId], CampaignType: 'Search'}),
      read('GetAdGroupsByIds', {CampaignId: p.scopeContext!.campaignId, AdGroupIds: entityIds}),
    );
  reads.push(read('GetAdExtensionsByIds', {AdExtensionIds: assetIds, AdExtensionType: types}));
  reads.push({
    ...read('GetAdExtensionsAssociations', {
      EntityIds: entityIds,
      AssociationType: b.AssociationType,
      AdExtensionType: types,
    }),
    scopeContext: {microsoftAssociationPairs: pairs.map(r => ({entityId: r.EntityId, extensionId: r.AdExtensionId}))},
  });
  return reads;
}
export function validateMicrosoftAssociations(read: CompiledRequest, data: JsonObject): void {
  const b = read.body as JsonObject,
    rows = data.AdExtensionAssociationCollection;
  if (!Array.isArray(rows) || rows.length !== b.EntityIds.length)
    fail('Provider association collections must correspond to every requested entity.');
  for (let i = 0; i < rows.length; i++) {
    const collection = rows[i];
    if (
      !obj(collection) ||
      !Object.hasOwn(collection, 'AdExtensionAssociations') ||
      (collection.AdExtensionAssociations !== null && !Array.isArray(collection.AdExtensionAssociations))
    )
      fail('Provider returned an invalid association collection.');
    const seen = new Set<string>();
    for (const r of collection.AdExtensionAssociations ?? []) {
      if (
        !obj(r) ||
        r.EntityId !== b.EntityIds[i] ||
        r.AssociationType !== b.AssociationType ||
        !obj(r.AdExtension) ||
        typeof r.AdExtension.Id !== 'string' ||
        !/^[1-9][0-9]*$/.test(r.AdExtension.Id) ||
        !extensionTypes(b.AdExtensionType).includes(r.AdExtension.Type) ||
        seen.has(r.AdExtension.Id)
      )
        fail('Provider returned a foreign, duplicate or incorrectly typed association.');
      seen.add(r.AdExtension.Id);
    }
  }
}
export function microsoftAssociationProjection(read: CompiledRequest, data: JsonObject): JsonObject {
  const pairs = read.scopeContext?.microsoftAssociationPairs;
  return {
    AdExtensionAssociationCollection: data.AdExtensionAssociationCollection.map((c: JsonObject) => ({
      AdExtensionAssociations: (c.AdExtensionAssociations ?? [])
        .filter(
          (r: JsonObject) => !pairs || pairs.some(p => p.entityId === r.EntityId && p.extensionId === r.AdExtension.Id),
        )
        .map((r: JsonObject) => ({
          EntityId: r.EntityId,
          AssociationType: r.AssociationType,
          AdExtension: r.AdExtension,
        }))
        .sort((a: JsonObject, b: JsonObject) => a.AdExtension.Id.localeCompare(b.AdExtension.Id, 'en')),
    })),
  };
}
export function validateMicrosoftAssociationState(p: CompiledRequest, state: unknown[], preparing = false) {
  if (!microsoftAssociationWrite(p)) return;
  const rows = state as JsonObject[],
    b = p.body as JsonObject,
    extensions = rows.flatMap(r => r.AdExtensions ?? []),
    links = rows.flatMap(r => r.AdExtensionAssociationCollection ?? []).flatMap(r => r.AdExtensionAssociations ?? []);
  for (const r of b.AdExtensionIdToEntityIdAssociations) {
    const asset = extensions.find(a => a.Id === r.AdExtensionId);
    if (!asset || !p.scopeContext!.microsoftExtensionTypes!.includes(asset.Type) || asset.Status === 'Deleted')
      fail('Every requested extension must exist with its discovered type in the selected account.');
    const link = links.find(a => a.EntityId === r.EntityId && a.AdExtension.Id === r.AdExtensionId);
    if (preparing && p.action === 'SetAdExtensionsAssociations' && link)
      throw new MirrorError(
        'ASSET_LINK_EXISTS',
        'The extension is already associated. Inspect it instead of replaying a set.',
      );
    if (p.action === 'DeleteAdExtensionsAssociations' && !link)
      throw new MirrorError('STATE_NOT_FOUND', 'Only an existing exact association may be removed.');
  }
}
export function microsoftAssociationVerification(p: CompiledRequest, compile: Compile) {
  const read = reader(p, compile);
  return ((p.body as JsonObject).AdExtensionIdToEntityIdAssociations as JsonObject[]).map(pair => ({
    read: {
      ...read('GetAdExtensionsAssociations', {
        EntityIds: [pair.EntityId],
        AssociationType: (p.body as JsonObject).AssociationType,
        AdExtensionType: p.scopeContext!.microsoftExtensionTypes!.join(' '),
      }),
      scopeContext: {microsoftAssociationPairs: [{entityId: pair.EntityId, extensionId: pair.AdExtensionId}]},
    },
    expected: {
      EntityId: pair.EntityId,
      AdExtensionId: pair.AdExtensionId,
      associated: p.action === 'SetAdExtensionsAssociations',
    },
    id: pair.EntityId + '/' + pair.AdExtensionId,
  }));
}
export function microsoftAssociationObserved(read: CompiledRequest, data: JsonObject) {
  const p = read.scopeContext!.microsoftAssociationPairs![0]!;
  return {
    EntityId: p.entityId,
    AdExtensionId: p.extensionId,
    associated: data.AdExtensionAssociationCollection.some((c: JsonObject) =>
      (c.AdExtensionAssociations ?? []).some(
        (r: JsonObject) => r.EntityId === p.entityId && r.AdExtension.Id === p.extensionId,
      ),
    ),
  };
}

/** What an association write changes, as prepare returns it for review. */
export function microsoftAssociationImpact(plan: CompiledRequest): JsonObject {
  return {
    provider: 'microsoft',
    effect:
      'Changes existing extension associations without modifying the asset library. Linking may serve immediately under an enabled parent.',
    may_activate: microsoftAssociationActivates(plan),
    limits:
      'Exact membership read-back does not establish editorial approval or delivery. Search parents only; ad-group associations require campaign_id. Review freezes the discovered extension types and asset content.',
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const microsoftAssociationFamily: ReviewedFamily = {
  name: 'microsoft_asset_links',
  files: ['src/microsoft-associations.ts', ['tests/microsoft-associations.test.ts']],
  kind: microsoftAssociationKind,
  snapshots: microsoftSnapshots,
  isRead: (read: CompiledRequest) =>
    read.gateway === 'microsoft_ads_native_action' && read.action === 'GetAdExtensionsAssociations',
  snapshotState: microsoftAssociationProjection,
  prerequisites: (plan, state) => validateMicrosoftAssociationState(plan, state),
  stateChecks: (plan, state, preparing) => {
    if (preparing) validateMicrosoftAssociationState(plan, state, true);
  },
  impact: microsoftAssociationImpact,
  outcome: microsoftOutcome,
  verification: (plan: CompiledRequest) => microsoftAssociationVerification(plan, compileMicrosoft),
  observed: (read: CompiledRequest, data: JsonObject) =>
    data.amcp_absent === true ? data : microsoftAssociationObserved(read, data),
  spendConfirmation: {
    needed: () => true,
    message:
      'Asset associations change which creative can serve. Review the parent state and provide spend_change_confirmed=true.',
  },
  activates: plan => !!microsoftAssociationActivates(plan),
};
