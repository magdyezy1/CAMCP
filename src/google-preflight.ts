import type {CompiledRequest, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {normalizeAccount} from './account-id.js';
import {googleJson} from './google-contracts.js';
import {googleBuildResults} from './google-atomic-builds.js';
import {snake} from './write-common.js';
import {boundedPointer, boundedStepId, obj} from './workspace-core.js';
import legacyMapping from './google-legacy-mapping.json' with {type: 'json'};
import type {CampaignPreflight} from './provider-adapter.js';

// Google Ads' part of a campaign plan's preflight, its adapter's `campaign.preflight` (ARC-01 phase B, wave 4c: moved
// verbatim from src/campaign-preflight.ts, which keeps every check a step passes and their order). The predecessor's
// request is compiled by the preflight's compiler (`compile`, passed in so that no adapter imports it).
//
// A reference's stand-in names the predecessor's resource by its shape and varies only by the number of the result it names
// (`ordinal`, src/plan-reference-standins.ts; R2.5 r25-field3-refs, AMCP-01): the resources of two different results are two resources.
// The parts of a composite name that the predecessor's create names (the ad group of a node, the asset of a link) are the IDs it names, or the
// number of the reference that names them (`ordinalOf`; the fix round, the lead's review S3-2), so that a parent and its child agree on their group.

/**
 * The parts of the resource name of each customer collection, in order, as the pinned Google descriptors give them: their `resourcePattern`
 * (src/google-legacy-mapping.json) `customers/{customer_id}/assetGroupSignals/{asset_group_id}~{criterion_id}` is
 * `assetGroupSignals: ['asset_group_id', 'criterion_id']`. The stand-in of a created resource has these parts, so that a check of a composite name
 * accepts it; the shape is read from the pattern and never written out by collection (R2.5 r25-field3-refs, AMCP-01, F1-4), so no collection is
 * missed, as the signals, listing group filters, bid modifiers, shared criteria, campaign shared sets, asset set links and label links were.
 */
const nameParts: ReadonlyMap<string, readonly string[]> = (() => {
  const table = new Map<string, readonly string[]>();
  for (const descriptor of Object.values(
    legacyMapping.googleProto.descriptors as unknown as Record<string, {resourcePattern?: string}>,
  )) {
    const m = /^customers\/\{customer_id\}\/([A-Za-z]+)\/(\{[a-z_0-9]+\}(?:~\{[a-z_0-9]+\})*)$/.exec(
      descriptor.resourcePattern ?? '',
    );
    if (m)
      table.set(
        m[1]!,
        m[2]!.split('~').map(part => part.slice(1, -1)),
      );
  }
  return table;
})();

const camelCase = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
/** The ordinal the step being checked gives a reference it names, by the reference's text; undefined when it names none such (src/plan-reference-standins.ts). */
type OrdinalOf = ((ref: string) => number | undefined) | undefined;
/** The ID a field of a create stands for in a name, or undefined when the create does not name one (the part then keeps the ordinal of the reference). */
type Known = (value: unknown) => string | undefined;
/**
 * What a field of a create names, as an ID part of a name (R2.5 r25-field3-refs, the fix round, the lead's review S3-2): the ID in a resource name the
 * create gives (`customers/123/adGroups/20` is 20), or the number the step being checked gives the reference the create holds, when that step names the same
 * reference (`{$ref: "ag#/data/results/0/resourceName"}`), so that the ad group of the unit and the ad group of its parent node are one identity. A temporary
 * name (`-1`), a name of another shape and a reference the step does not name are none.
 */
const knownOf =
  (ordinalOf: OrdinalOf): Known =>
  value => {
    if (typeof value === 'string') return /^customers\/[0-9]+\/[A-Za-z]+\/([1-9][0-9]*)$/.exec(value)?.[1];
    const ref = obj(value) ? value.$ref : undefined,
      ordinal = typeof ref === 'string' ? ordinalOf?.(ref) : undefined;
    return ordinal === undefined ? undefined : String(ordinal);
  };

/**
 * The stand-in of the resource an operation creates: its collection's resource name with the parts its pattern gives (nameParts). An ID part of a
 * composite name is the ID the create names for it, where it names one: `ad_group_id` is the ad group the create's `adGroup` is, `asset_id` its `asset`
 * (`known`: the literal ID, or the number of the reference the step being checked names); an ID Google makes up (the new criterion, the new ad) is the
 * number of the result the reference names, `n`, as is a part the create does not name. The tree reviews compare the group part of a parent node's name
 * with the group the unit names, so the parent part must follow the parent and not the child (the lead's review S3-2). The exact field type an asset
 * association is made with (its pattern's {field_type}) is the create's. A collection of one part is the resource's own ID, which Google makes up; a
 * collection the descriptors do not know is one number. An association create without its exact field type is refused.
 */
function createdName(
  customer: string,
  collection: string,
  n: string,
  operation: JsonObject,
  where: JsonObject,
  known: Known,
): string {
  const parts = nameParts.get(collection) ?? [''],
    id = parts
      .map(part => {
        if (part === 'field_type') {
          const type = operation.create?.fieldType;
          if (typeof type !== 'string' || !type.match(/^[A-Z_]+$/))
            throw new MirrorError(
              'INVALID_REFERENCE',
              'An asset-association predecessor requires its exact field type.',
              where,
            );
          return type;
        }
        return (
          (parts.length > 1 && part.endsWith('_id')
            ? known(operation.create?.[camelCase(part.slice(0, -3))])
            : undefined) ?? n
        );
      })
      .join('~');
  return 'customers/' + customer + '/' + collection + '/' + id;
}

/**
 * A reference into the result of a build, one all-or-nothing `googleAds:mutate` (R2.5 r25-field3-refs, the owner's second Google report of
 * 2026-11-21, AMCP-02). Google answers a build with `mutateOperationResponses`, one entry for each operation, holding the field of that operation's type
 * (`campaignResult`, `assetGroupResult`), and the step's result keeps that answer as Google writes it, in camelCase, so the pointer is
 * `/data/mutateOperationResponses/<i>/<result>/resourceName` and nothing else: <i> is an operation of the build, and <result> the field of the
 * type of the operation at <i> (googleBuildResults, the table the build is checked with). A snake_case pointer would name nothing in the result, so
 * it is refused, and the refusal names the camelCase form. Every refusal says what to send: bounded names and numbers, never a value.
 */
const buildForm = '/data/mutateOperationResponses/<i>/<result>/resourceName';
const buildPointer = /^\/data\/mutateOperationResponses\/(0|[1-9][0-9]*)\/([A-Za-z]+)\/resourceName$/;
function buildReference(
  where: JsonObject,
  customer: string,
  body: any,
  ref: string,
  n: string,
  ordinalOf: OrdinalOf,
): string {
  const received = ref.slice(ref.indexOf('#') + 1),
    operations: unknown[] = Array.isArray(body?.mutateOperations) ? body.mutateOperations : [],
    // What every refusal says: the step, the pointer as it was sent, the form to send and how many operations the build has.
    details = (more: JsonObject = {}): JsonObject => ({
      ...where,
      accepted_form: buildForm,
      operations: operations.length,
      ...more,
    }),
    camel = received.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
    m = buildPointer.exec(camel),
    index = m ? Number(m[1]) : -1;
  if (!m)
    throw new MirrorError(
      'INVALID_REFERENCE',
      'Select an operation result of this build with /data/mutateOperationResponses/N/RESULT/resourceName in camelCase, N being the operation and RESULT the result field of its type.',
      details(),
    );
  if (!Number.isSafeInteger(index) || index >= operations.length)
    throw new MirrorError(
      'INVALID_REFERENCE',
      'This build has no operation at the index this reference names.',
      details(),
    );
  // The operation at <i>: its type, the result field that type answers with, and the pointer that names it.
  const operation = operations[index],
    key =
      operation && typeof operation === 'object' && Object.keys(operation).length === 1
        ? Object.keys(operation)[0]!
        : undefined,
    type = key ? googleBuildResults[snake(key)] : undefined,
    named: JsonObject = {
      operation: index,
      ...(type
        ? {
            operation_type: snake(key!),
            expected_pointer: '/data/mutateOperationResponses/' + index + '/' + type.result + '/resourceName',
          }
        : {}),
    };
  if (camel !== received)
    throw new MirrorError(
      'INVALID_REFERENCE',
      'Select an operation result of this build with /data/mutateOperationResponses/N/RESULT/resourceName in camelCase, N being the operation and RESULT the result field of its type.',
      details(named),
    );
  if (!type || m[2] !== type.result)
    throw new MirrorError(
      'INVALID_REFERENCE',
      'This operation of the build answers with another result field than this reference names.',
      details(named),
    );
  const inner = (operation as JsonObject)[key!],
    existing = inner?.update?.resourceName ?? inner?.remove;
  if (typeof existing === 'string') return existing;
  // A parent the build names by a temporary name (`customers/123/assetGroups/-20`) is the result of the operation of the build that creates it, so that
  // it is the same identity as the reference that names that operation's result (the lead's review S3-2).
  const stepId = ref.slice(0, ref.indexOf('#')),
    plain = knownOf(ordinalOf),
    known: Known = value => {
      const direct = plain(value);
      if (
        direct !== undefined ||
        typeof value !== 'string' ||
        !/^customers\/[0-9]+\/[A-Za-z]+\/-[1-9][0-9]*$/.test(value)
      )
        return direct;
      const made = operations.findIndex(
        op =>
          op &&
          typeof op === 'object' &&
          Object.keys(op).length === 1 &&
          (op as JsonObject)[Object.keys(op)[0]!]?.create?.resourceName === value,
      );
      const madeType =
        made < 0 ? undefined : googleBuildResults[snake(Object.keys(operations[made] as JsonObject)[0]!)];
      return madeType
        ? plain({$ref: stepId + '#/data/mutateOperationResponses/' + made + '/' + madeType.result + '/resourceName'})
        : undefined;
    };
  return createdName(customer, type.kind, n, inner ?? {}, {...where, operation: index}, known);
}
function googleReference(
  compile: (gateway: string, args: JsonObject) => CompiledRequest,
  parent: JsonObject | undefined,
  ref: string,
  ordinal: number,
  ordinalOf: OrdinalOf,
): string {
  // Every refusal says which step and which pointer it is about, as they were sent (R2.5 r25-field3-refs, AMCP-02, F2-2).
  const where: JsonObject = {
    predecessor: boundedStepId(ref.split('#')[0]),
    received_pointer: boundedPointer(ref.slice(ref.indexOf('#') + 1)),
  };
  if (!parent) throw new MirrorError('INVALID_REFERENCE', 'The Google resource predecessor is missing.', where);
  const account = normalizeAccount('google_ads_native_action', parent.account_id),
    n = String(ordinal);
  if (parent.kind === 'media' && parent.arguments.platform === 'google_ads')
    return 'customers/' + account + '/assets/' + n;
  if (parent.gateway !== 'google_ads_native_action')
    throw new MirrorError('INVALID_REFERENCE', 'A Google resource name must come from a Google predecessor.', where);
  const plan = compile(parent.gateway, {...parent.arguments, account_id: account});
  const match = plan.path.match(/^\/v\d+\/customers\/(\d+)\/([A-Za-z]+):mutate$/);
  if (!match)
    throw new MirrorError(
      'INVALID_REFERENCE',
      'This predecessor has no declared Google resource mutation receipt.',
      where,
    );
  // A build is answered with mutateOperationResponses, not with results.
  if (match[2] === 'googleAds') return buildReference(where, match[1]!, googleJson(plan.body), ref, n, ordinalOf);
  const pointer = /^\/data\/results\/(0|[1-9][0-9]*)\/resourceName$/.exec(ref.slice(ref.indexOf('#') + 1));
  const operations = googleJson(plan.body)?.operations,
    index = pointer ? Number(pointer[1]) : -1;
  if (!Number.isSafeInteger(index) || index < 0 || !Array.isArray(operations) || index >= operations.length)
    throw new MirrorError(
      'INVALID_REFERENCE',
      'Select an existing operation result resourceName from this Google predecessor.',
      {
        ...where,
        accepted_form: '/data/results/<i>/resourceName',
        operations: Array.isArray(operations) ? operations.length : 0,
        range: Array.isArray(operations) && operations.length ? '0..' + (operations.length - 1) : 'none',
      },
    );
  const operation = operations[index],
    existing = operation.update?.resourceName ?? operation.remove;
  if (typeof existing === 'string') return existing;
  // Symbolic contract checking uses the actual compiled collection and customer,
  // not guesses based on the action name. Verified native IDs replace these at review.
  return createdName(match[1]!, match[2]!, n, operation, {...where, operation: index}, knownOf(ordinalOf));
}
/** A predecessor's resource name is the one its compiled mutation names or creates, symbolically. */
export const googlePreflight: CampaignPreflight = Object.freeze<CampaignPreflight>({
  reference: ({parent, ref, ordinal, ordinalOf, compile}) => googleReference(compile, parent, ref, ordinal, ordinalOf),
});
