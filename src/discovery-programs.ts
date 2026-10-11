import type {JsonObject} from './types.js';

/**
 * Provider programs that gate AMCP workflows but that AMCP never checks with a request (ACC-05 phase 2, R16): each
 * entry names the program, its documented prerequisites and the workflows it would unlock. A discovery-only entry makes
 * no provider request, saves nothing and is never an entitlement; the owner records what the provider granted in the
 * provider access register (docs/PROVIDER-ACCESS.md). The three programs AMCP can check with one bounded read are the
 * live_read entries of src/conditional-programs.ts.
 *
 * Withheld-write reasons that wait on one of these programs are derived from its entry (`withheld_reason`), so the
 * refusal and the program listing cannot drift apart.
 */
export interface DiscoveryOnlyProgram extends JsonObject {
  id: string;
  kind: 'discovery_only_program';
  mode: 'discovery_only';
  name: string;
  gateway: string;
  description: string;
  effects: 'none';
  provider_requests: 0;
  prerequisites: {id: string; text: string}[];
  program: {access: string; reference: string; checked_on: string};
  unlocks: string[];
  withheld_actions: string[];
  withheld_reason?: string;
  personal_data?: string;
  meaning: string;
}
const meaning =
  'Listed for discovery only: AMCP makes no request for this program and cannot check it. Its prerequisites are external approvals the provider grants; record the outcome in the provider access register.';

const linkedinAudiencesReason =
  "Needs LinkedIn's rw_dmp_segments permission, which belongs to the Audiences program and \"is not granted automatically as part of the LinkedIn Marketing API Program\" (Matched Audiences pages, read 2026-09-30). AMCP's LinkedIn connection asks for r_ads, r_ads_reporting and rw_ads, so this waits on the owner's decision to request the permission and on LinkedIn's approval of the program.";
const linkedinMediaPlansReason =
  "Needs LinkedIn's rw_media_plans permission, which belongs to the Media Planning API program and \"is not granted automatically as part of the LinkedIn Marketing API Program\" (Manage Media Plans page, read 2026-09-30). AMCP's LinkedIn connection does not ask for it; this waits on the owner's decision and LinkedIn's approval.";

export const discoveryOnlyPrograms: DiscoveryOnlyProgram[] = [
  {
    id: 'program:linkedin_lead_sync',
    kind: 'discovery_only_program',
    mode: 'discovery_only',
    name: 'LinkedIn Lead Sync',
    gateway: 'linkedin_native_action',
    description: 'Read the lead responses members submit through LinkedIn lead gen forms.',
    effects: 'none',
    provider_requests: 0,
    prerequisites: [
      {
        id: 'lead_sync_program',
        text: 'LinkedIn must approve the application for the Lead Sync API, which is a separate program from the Advertising API.',
      },
      {
        id: 'lead_sync_permission',
        text: 'The connected member must grant r_marketing_leadgen_automation, which AMCP does not request today.',
      },
      {
        id: 'personal_data_policy',
        text: 'Lead responses are personal data: reading them also needs the personal-data policy to open LinkedIn leads.',
      },
    ],
    program: {
      access: 'The Lead Sync page states that the Lead Sync API is a separate program with its own permission.',
      reference: 'https://learn.microsoft.com/en-us/linkedin/marketing/lead-sync/leadsync?view=li-lms-2026-09',
      checked_on: '2026-10-08',
    },
    unlocks: ['LinkedIn lead responses for lead generation reporting'],
    withheld_actions: [],
    // A Lead Sync entry never fetches leads (R16): lead responses stay behind personal-data gating.
    personal_data:
      'AMCP never reads lead responses through this entry. Lead forms themselves are reviewed (linkedin_lead_forms); the responses stay behind the personal-data policy.',
    meaning,
  },
  {
    id: 'program:linkedin_matched_audiences',
    kind: 'discovery_only_program',
    mode: 'discovery_only',
    name: 'LinkedIn Matched Audiences',
    gateway: 'linkedin_native_action',
    description: 'Create and change DMP segments, company and contact lists, and page-set audiences.',
    effects: 'none',
    provider_requests: 0,
    prerequisites: [
      {
        id: 'audiences_program',
        text: 'LinkedIn must approve the application for the Audiences program; it is not granted with the Marketing API.',
      },
      {
        id: 'rw_dmp_segments_permission',
        text: 'The connected member must grant rw_dmp_segments, which AMCP does not request today.',
      },
    ],
    program: {
      access:
        'rw_dmp_segments belongs to the Audiences program and is not granted automatically with the LinkedIn Marketing API Program.',
      reference:
        'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/advertising-targeting/create-and-manage-segments?view=li-lms-2026-09',
      checked_on: '2026-09-30',
    },
    unlocks: ['Reviewed LinkedIn audience writes (DMP segments, page sets and company lists)'],
    withheld_actions: [
      'linkedin_rest_ad_page_sets_post',
      'linkedin_rest_ad_segment_sources_source_urn_li_ad_page_set_id_segment_urn_li_ad_segment_id_put',
      'linkedin_rest_ad_segment_sources_source_urn_li_ad_page_set_id_segment_urn_li_ad_segment_id_delete',
      'linkedin_rest_dmp_segments_segment_id_business_objective_based_audiences_post',
      'linkedin_rest_dmp_segments_segment_id_business_objective_based_audiences_audience_id_post',
      'linkedin_rest_dmp_segments_segment_id_business_objective_based_audiences_audience_id_delete',
      'linkedin_rest_dmp_segments_segment_id_destinations_post',
      'linkedin_rest_dmp_segments_segment_id_companies_post',
      'linkedin_rest_ad_segments_segment_id_post',
    ],
    withheld_reason: linkedinAudiencesReason,
    meaning,
  },
  {
    id: 'program:linkedin_media_plans',
    kind: 'discovery_only_program',
    mode: 'discovery_only',
    name: 'LinkedIn saved media plans',
    gateway: 'linkedin_native_action',
    description: 'Save media plans in Campaign Manager from a forecast.',
    effects: 'none',
    provider_requests: 0,
    prerequisites: [
      {
        id: 'media_planning_program',
        text: 'LinkedIn must provision the Media Planning API product for the application (Advertising API access, an application survey and Technical Sign Off).',
      },
      {
        id: 'rw_media_plans_permission',
        text: 'The connected member must grant rw_media_plans, which AMCP does not request today.',
      },
    ],
    program: {
      access:
        'rw_media_plans belongs to the Media Planning API program and is not granted automatically with the LinkedIn Marketing API Program.',
      reference:
        'https://learn.microsoft.com/en-us/linkedin/marketing/media-planning/media-planning-overview?view=li-lms-2026-09',
      checked_on: '2026-10-08',
    },
    unlocks: ['Reviewed LinkedIn media plan saves'],
    withheld_actions: ['linkedin_rest_media_plans_post'],
    withheld_reason: linkedinMediaPlansReason,
    meaning,
  },
  {
    id: 'program:x_ads_api_access',
    kind: 'discovery_only_program',
    mode: 'discovery_only',
    name: 'X Ads API access',
    gateway: 'x_ads_native_action',
    description: 'Use the X Ads API for an advertiser account: reads, reviewed writes and analytics.',
    effects: 'none',
    provider_requests: 0,
    prerequisites: [
      {
        id: 'ads_api_access_form',
        text: 'X must approve the developer application through the Ads API access form before any Ads API request succeeds.',
      },
      {
        id: 'advertiser_account_access',
        text: 'The connected X user needs access to the advertiser account in X Ads.',
      },
    ],
    program: {
      access: 'The X Ads API needs an approved application through the Ads API access form.',
      reference: 'https://docs.x.com/x-ads-api/introduction',
      checked_on: '2026-10-08',
    },
    unlocks: ['X reporting', 'Reviewed X campaign and catalog writes'],
    withheld_actions: [],
    meaning,
  },
  {
    id: 'program:dv360_bid_manager_reporting',
    kind: 'discovery_only_program',
    mode: 'discovery_only',
    name: 'Display & Video 360 reporting (Bid Manager)',
    gateway: 'dv360_native_action',
    description: 'Run Display & Video 360 reports through the Bid Manager API.',
    effects: 'none',
    provider_requests: 0,
    prerequisites: [
      {
        id: 'bid_manager_scope',
        text: 'The Google identity must grant the Bid Manager OAuth scope, which is separate from the Display & Video 360 scope.',
      },
      {
        id: 'dv360_customer_role',
        text: 'The Google identity needs a Display & Video 360 user profile with access to the partner or advertiser.',
      },
      {
        id: 'reporting_workflow',
        text: 'AMCP has no Bid Manager report workflow yet; reports, query runs and report retrieval are not available.',
      },
    ],
    program: {
      access:
        'Bid Manager reporting uses its own OAuth scope and report workflow; an advertiser read does not establish reporting access.',
      reference: 'https://developers.google.com/bid-manager',
      checked_on: '2026-10-08',
    },
    unlocks: ['Display & Video 360 reporting'],
    withheld_actions: [],
    meaning,
  },
];

export function discoveryOnlyProgram(id: unknown): DiscoveryOnlyProgram | undefined {
  return discoveryOnlyPrograms.find(p => p.id === id);
}
/** The discovery-only program a withheld write waits on, when it waits on one (ACC-05). */
export function withheldWriteProgram(gateway: string, action: string): DiscoveryOnlyProgram | undefined {
  return discoveryOnlyPrograms.find(p => p.gateway === gateway && p.withheld_actions.includes(action));
}
/** What capabilities lists for a discovery-only program: no account, no next call, zero requests. */
export function discoveryOnlyListing(program: DiscoveryOnlyProgram): JsonObject {
  const {withheld_reason: _reason, ...listed} = program;
  return {...listed, entitlement: 'unverified', next_call: null};
}
