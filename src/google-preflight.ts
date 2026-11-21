import type {CompiledRequest, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {normalizeAccount} from './account-id.js';
import {googleJson} from './google-contracts.js';
import {googleBuildResults} from './google-atomic-builds.js';
import {snake} from './write-common.js';
import {boundedPointer, boundedStepId} from './workspace-core.js';
import legacyMapping from './google-legacy-mapping.json' with {type: 'json'};
import type {CampaignPreflight} from './provider-adapter.js';

// Google Ads' part of a campaign plan's preflight, its adapter's `campaign.preflight` (ARC-01 phase B, wave 4c: moved
// verbatim from src/campaign-preflight.ts, which keeps every check a step passes and their order). The predecessor's
// request is compiled by the preflight's compiler (`compile`, passed in so that no adapter imports it).
//
// A reference's stand-in names the predecessor's resource by its shape and varies only by the number of the result it names
// (`ordinal`, src/plan-reference-standins.ts; R2.5 r25-field3-refs, AMCP-01): the resources of two different results are two resources.

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

/**
 * The stand-in of the resource an operation creates: its collection's resource name with the parts its pattern gives (nameParts), the number in
 * each ID part and the exact field type an asset association is made with (its pattern's {field_type}). A collection the descriptors do not know is
 * one number. An association create without its exact field type is refused.
 */
function createdName(customer: string, collection: string, n: string, operation: JsonObject): string {
  const id = (nameParts.get(collection) ?? [''])
    .map(part => {
      if (part !== 'field_type') return n;
      const type = operation.create?.fieldType;
      if (typeof type !== 'string' || !type.match(/^[A-Z_]+$/))
        throw new MirrorError('INVALID_REFERENCE', 'An asset-association predecessor requires its exact field type.');
      return type;
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
function buildReference(parent: JsonObject, customer: string, body: any, received: string, n: string): string {
  const operations: unknown[] = Array.isArray(body?.mutateOperations) ? body.mutateOperations : [],
    // What every refusal says: the step, the pointer as it was sent, the form to send and how many operations the build has.
    details = (more: JsonObject = {}): JsonObject => ({
      predecessor: boundedStepId(parent.id),
      received_pointer: boundedPointer(received),
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
  return typeof existing === 'string' ? existing : createdName(customer, type.kind, n, inner ?? {});
}

function googleReference(
  compile: (gateway: string, args: JsonObject) => CompiledRequest,
  parent: JsonObject | undefined,
  ref: string,
  ordinal: number,
): string {
  if (!parent) throw new MirrorError('INVALID_REFERENCE', 'The Google resource predecessor is missing.');
  const account = normalizeAccount('google_ads_native_action', parent.account_id),
    n = String(ordinal);
  if (parent.kind === 'media' && parent.arguments.platform === 'google_ads')
    return 'customers/' + account + '/assets/' + n;
  if (parent.gateway !== 'google_ads_native_action')
    throw new MirrorError('INVALID_REFERENCE', 'A Google resource name must come from a Google predecessor.');
  const plan = compile(parent.gateway, {...parent.arguments, account_id: account});
  const match = plan.path.match(/^\/v\d+\/customers\/(\d+)\/([A-Za-z]+):mutate$/);
  if (!match)
    throw new MirrorError('INVALID_REFERENCE', 'This predecessor has no declared Google resource mutation receipt.');
  // A build is answered with mutateOperationResponses, not with results.
  if (match[2] === 'googleAds')
    return buildReference(parent, match[1]!, googleJson(plan.body), ref.slice(ref.indexOf('#') + 1), n);
  const pointer = /^\/data\/results\/(0|[1-9][0-9]*)\/resourceName$/.exec(ref.slice(ref.indexOf('#') + 1));
  const operations = googleJson(plan.body)?.operations,
    index = pointer ? Number(pointer[1]) : -1;
  if (!Number.isSafeInteger(index) || index < 0 || !Array.isArray(operations) || index >= operations.length)
    throw new MirrorError(
      'INVALID_REFERENCE',
      'Select an existing operation result resourceName from this Google predecessor.',
    );
  const operation = operations[index],
    existing = operation.update?.resourceName ?? operation.remove;
  if (typeof existing === 'string') return existing;
  // Symbolic contract checking uses the actual compiled collection and customer,
  // not guesses based on the action name. Verified native IDs replace these at review.
  return createdName(match[1]!, match[2]!, n, operation);
}
/** A predecessor's resource name is the one its compiled mutation names or creates, symbolically. */
export const googlePreflight: CampaignPreflight = Object.freeze<CampaignPreflight>({
  reference: ({parent, ref, ordinal, compile}) => googleReference(compile, parent, ref, ordinal),
});
