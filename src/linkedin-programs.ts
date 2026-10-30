import type {DiscoveryProgramFacts} from './provider-adapter.js';
import {deepFrozen} from './frozen-facts.js';

const linkedinAudiencesReason =
  "Needs LinkedIn's rw_dmp_segments permission, which belongs to the Audiences program and \"is not granted automatically as part of the LinkedIn Marketing API Program\" (Matched Audiences pages, read 2026-09-30). AMCP's LinkedIn connection asks for r_ads, r_ads_reporting and rw_ads, so this waits on the owner's decision to request the permission and on LinkedIn's approval of the program.";
const linkedinMediaPlansReason =
  "Needs LinkedIn's rw_media_plans permission, which belongs to the Media Planning API program and \"is not granted automatically as part of the LinkedIn Marketing API Program\" (Manage Media Plans page, read 2026-09-30). AMCP's LinkedIn connection does not ask for it; this waits on the owner's decision and LinkedIn's approval.";

/**
 * LinkedIn's discovery-only programs (ACC-05 phase 2, R16; wave 4c round 6: moved unchanged from
 * src/discovery-programs.ts, which lists them): programs that gate AMCP workflows but that AMCP never checks with a
 * request. A withheld write's refusal is derived from its program's `withheld_reason`.
 */
export const linkedinPrograms: readonly DiscoveryProgramFacts[] = deepFrozen([
  {
    id: 'program:linkedin_lead_sync',
    name: 'LinkedIn Lead Sync',
    description: 'Read the lead responses members submit through LinkedIn lead gen forms.',
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
  },
  {
    id: 'program:linkedin_matched_audiences',
    name: 'LinkedIn Matched Audiences',
    description: 'Create and change DMP segments, company and contact lists, and page-set audiences.',
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
  },
  {
    id: 'program:linkedin_media_plans',
    name: 'LinkedIn saved media plans',
    description: 'Save media plans in Campaign Manager from a forecast.',
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
  },
]);
