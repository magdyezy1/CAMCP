import type {CompiledRequest, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {normalizeAccount} from './account-id.js';
import {googleJson} from './google-contracts.js';
import type {CampaignPreflight} from './provider-adapter.js';

// Google Ads' part of a campaign plan's preflight, its adapter's `campaign.preflight` (ARC-01 phase B, wave 4c: moved
// verbatim from src/campaign-preflight.ts, which keeps every check a step passes and their order). The predecessor's
// request is compiled by the preflight's compiler (`compile`, passed in so that no adapter imports it).
//
// A reference's stand-in names the predecessor's resource by its shape and varies only by the number of the result it names
// (`ordinal`, src/plan-reference-standins.ts; R2.5 r25-field3-refs, AMCP-01): the resources of two different results are two resources.

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
  const composite: Record<string, string> = {
    adGroupAds: n + '~' + n,
    adGroupCriteria: n + '~' + n,
    campaignCriteria: n + '~' + n,
  };
  let id = composite[match[2]!] ?? n;
  if (['campaignAssets', 'adGroupAssets', 'customerAssets', 'assetGroupAssets'].includes(match[2]!)) {
    const type = operation.create?.fieldType;
    if (typeof type !== 'string' || !type.match(/^[A-Z_]+$/))
      throw new MirrorError('INVALID_REFERENCE', 'An asset-association predecessor requires its exact field type.');
    id = (match[2] === 'customerAssets' ? n + '~' : n + '~' + n + '~') + type;
  }
  return 'customers/' + match[1] + '/' + match[2] + '/' + id;
}
/** A predecessor's resource name is the one its compiled mutation names or creates, symbolically. */
export const googlePreflight: CampaignPreflight = Object.freeze<CampaignPreflight>({
  reference: ({parent, ref, ordinal, compile}) => googleReference(compile, parent, ref, ordinal),
});
