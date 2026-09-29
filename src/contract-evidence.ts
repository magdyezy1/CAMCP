import {MirrorError} from './errors.js';
import {effectiveProviderContract, providerContracts} from './provider-contracts.js';
import {providerSunset} from './provider-sunsets.js';
import type {CompiledRequest, JsonObject} from './types.js';
export const providerMaintenance: Record<string, JsonObject> = {
  criteo: {
    campaigns: 'https://developers.criteo.com/retail-media/v2026.01/docs/campaigns-endpoints',
    changelog: 'https://developers.criteo.com/retail-media/changelog/version-202601-release-notes',
    lifecycle: 'https://developers.criteo.com/retail-media/docs/dsp-analytics-migration-guide',
    sandbox: 'No AMCP live Criteo sandbox fixture is qualified.',
    traps: [
      'Campaign PUT can clear omitted limits. The qualified family requires complete manual finite-limit fields, standard Criteo-budget balances and no budget overrides; campaign status is computed, not writable.',
      'AMCP is pinned to 2026.01. The 2026.07 reporting redesign uses different endpoints, filters and row/date limits; it cannot be enabled by changing a version string.',
      'Report submission is a reviewed one-attempt job creation. It does not change advertising spend, but consumes quota.',
      'Version-specific OpenAPI uses timezone; older guide examples use timeZone. AMCP freezes the OpenAPI spelling and explicit timezone. Provider wire acceptance still needs live qualification.',
      'Exact account/date/entity scope, successful completion, count, bytes and checksum must all hold before a downloaded report is complete. A complete file does not imply settled attribution.',
    ],
  },
  google: {
    changelog: 'https://developers.google.com/google-ads/api/docs/release-notes',
    lifecycle: 'https://developers.google.com/google-ads/api/docs/sunset-dates',
    sandbox: 'Test accounts under a test manager; production hostname. Project access level and quota are separate.',
    traps: [
      'v23 and v25 use start_date_time/end_date_time in customer timezone, not start_date/end_date.',
      'Discovery validates fields; review contracts still restrict mutation families and batch sizes.',
      'Explorer access needs administrator/provider approval; do not infer a token sunset.',
    ],
  },
  microsoft: {
    changelog: 'https://learn.microsoft.com/en-us/advertising/guides/release-notes?view=bingads-13',
    sandbox: 'Separate Microsoft sandbox service hosts and credentials.',
    traps: [
      'Six WSDLs document SOAP operation/type structure. JSON transport has independent contracts.',
      'Search writes only; media import remains unsupported.',
    ],
  },
  meta: {
    changelog: 'https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog',
    lifecycle: 'https://developers.facebook.com/docs/graph-api/changelog/',
    sandbox: 'Provider-provisioned sandbox ad accounts; no hostname-only safety guarantee.',
    traps: [
      'Per-account AMCP write grants are separate from Meta token/Page permissions.',
      'v25 rejects legacy AUTOMATED_SHOPPING_ADS/SMART_APP_PROMOTION. New campaigns cannot set existing_customer_budget_percentage; advantage state fields are read-only.',
      'Changelog access can be rate-limited; do not impose unverified blanket creative field bans.',
    ],
  },
  tiktok: {
    changelog: 'https://business-api.tiktok.com/portal/docs',
    sandbox: 'Provider sandbox advertiser and token must be verified before any live fixture.',
    traps: [
      'Native /ad/create/ uses one creatives[] record in each AMCP review. Smart+ differs.',
      'Discover an authorized existing identity; identity provisioning remains unqualified.',
      'Pixel, CTA and format prerequisites depend on the endpoint and objective. Keep large IDs as strings.',
    ],
  },
  snapchat: {
    changelog: 'https://developers.snap.com/marketing-api/Ads-API/changelog',
    sandbox: 'No general AMCP live sandbox fixture qualified.',
    traps: [
      'Creative collection PUT and JSON Patch have separate native payloads. PATCH was not removed.',
      'Shared creative edits can affect all attached ads and trigger provider re-review.',
    ],
  },
  linkedin: {
    changelog: 'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/recent-changes',
    sandbox: 'No general AMCP live sandbox fixture qualified.',
    traps: [
      'Monthly version is pinned across prepare, mutation and read-back.',
      'Organization DSC requires exact binding, recorded read/write social scopes and matching AVAILABLE media. Provider products and Page roles remain separate.',
      'PUBLISHED non-feed DSC is content; the later ad creative is created PAUSED.',
    ],
  },
  x: {
    changelog: 'https://docs.x.com/x-ads-api/fundamentals/versioning',
    sandbox:
      'ads-api-sandbox.x.com; external media-upload endpoints are not covered by its campaign non-serving guarantee.',
    traps: [
      'No fake PAUSED promoted Tweet. Promotion is activation.',
      'Creative edits may disrupt existing promotions; retain the impact guard and explicit override.',
      'Register the exact media_key without media_category; upload INIT still uses its category.',
    ],
  },
};
export function providerContractView(gateway?: string): JsonObject | undefined {
  const item = providerContracts.find(c => c.gateway === gateway);
  if (!item) return undefined;
  const contract = effectiveProviderContract(item.id)!;
  return {
    ...contract,
    ...(contract.write_scope
      ? {write_scope: 'Implemented and tested locally; not verified against a live account: ' + contract.write_scope}
      : {}),
    status_meaning:
      'unsupported: not built. implemented_unverified and partial_unverified: built (in part) and tested against local fixtures and the pinned provider contract, but not proven against a live account; treat them as unverified. Reviewed writes a workspace has verified on its own accounts are listed by amcp_workspace dashboard (capabilities.providers[].live_verified).',
    maintenance: providerMaintenance[item.id] ?? {sandbox: 'unqualified', changelog: item.documentation},
    // When the version AMCP sends stops working, as far as AMCP has evidence (F-56).
    version_end: providerSunset(String(item.id)) ?? null,
    evidence_interpretation:
      'Catalog evidence is captured compatibility metadata. Vendor schemas, local reviewed contracts and live provider qualification are distinct. Use amcp_write inspect with the exact payload.',
  };
}
/**
 * A reference to a gateway's provider contract (F-29): what identifies the contract and the version AMCP sends, and the
 * call that returns the whole of it. It stands in for the 1.3-6.6 KB contract when the caller already has it.
 */
export function providerContractReference(gateway?: string): JsonObject | undefined {
  const view = providerContractView(gateway);
  if (!view) return undefined;
  const fields = [
    'id',
    'gateway',
    'api_version',
    'contract_version',
    'reviewed_at',
    'reviewed_writes',
    'live_qualification',
    'version_end',
  ];
  return {
    ...Object.fromEntries(fields.filter(f => view[f] !== undefined).map(f => [f, view[f]])),
    full_contract: {tool: 'amcp_tool_help', arguments: {gateway}, result_field: 'amcp_contract'},
  };
}
/**
 * Which caller has received which provider contract whole, so that a caller that does not choose gets it once per
 * session and a reference afterwards (F-89). A session is a credential (a refreshed token starts a new one) for at most
 * `ttl` milliseconds. Process memory only: a restart sends each contract once more.
 */
export class ContractMemory {
  private sent = new Map<string, number>();
  constructor(
    private ttl = 12 * 3600000,
    private now: () => number = Date.now,
  ) {}
  /** The form a caller without a choice receives for this gateway. */
  form(session: string, gateway: string): EvidenceForm {
    const at = this.sent.get(session + '\0' + gateway);
    return at !== undefined && this.now() - at <= this.ttl ? 'ref' : 'full';
  }
  /** Records that this session received the gateway's whole contract. */
  delivered(session: string, gateway: string): void {
    const key = session + '\0' + gateway;
    this.sent.delete(key);
    this.sent.set(key, this.now());
    // Bounded: the oldest sessions are forgotten first, which only means sending their contract again.
    if (this.sent.size > 10000) this.sent.delete(this.sent.keys().next().value!);
  }
}
/** How much of the provider contract a review carries: the whole of it (the default) or a reference to it. */
export type EvidenceForm = 'full' | 'ref';
export function evidenceForm(value: unknown): EvidenceForm {
  if (value === undefined) return 'full';
  if (value === 'full' || value === 'ref') return value;
  throw new MirrorError('INVALID_ARGUMENT', 'evidence must be "full" or "ref".', {parameter: 'evidence'});
}
export function executionEvidence(plan: CompiledRequest, form: EvidenceForm = 'full'): JsonObject {
  return {
    catalog_evidence: plan.evidence,
    ...(plan.contractEvidence ?? {
      route_source: 'AMCP_INDEPENDENT_CONTRACT_OR_CAPTURE',
      live_qualification: 'unverified',
    }),
    provider: form === 'ref' ? providerContractReference(plan.gateway) : providerContractView(plan.gateway),
    review_authorization:
      'Existing deployment, actor, account, resource, review and spending gates remain mandatory; provenance never grants access.',
  };
}
