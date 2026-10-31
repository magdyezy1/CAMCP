import type {ConditionalProgram, ProviderConditionalProgram} from './provider-adapter.js';
import type {JsonObject} from './types.js';
import {bad, obj, validate} from './workspace-core.js';
import {withEffects} from './call-effects.js';

/**
 * Display & Video 360's conditional program (CON-04): the exact advertiser read. Moved verbatim from
 * src/conditional-programs.ts (ARC-01, wave 4c round 6), which lists it from DV360's hooks (src/dv360-adapter.ts) and
 * keeps every shared rule of a check: this supplies the program, its native request and the evidence it keeps. It
 * takes no requirements, so it has no template of its own.
 */
const gateway = 'dv360_native_action';
const advertiser: ConditionalProgram = {
  id: 'program:dv360_advertiser',
  kind: 'conditional_program',
  mode: 'live_read',
  name: 'Display & Video 360 advertiser access',
  gateway,
  objective: 'advertiser_access',
  description: 'Read the exact configured advertiser and retain its native partner, currency and status.',
  effects: 'provider_reads',
  effect_details: 'This read changes no advertiser settings, line items, reports or download jobs.',
  required_inputs: ['connection_id', 'account_id'],
  prerequisite_ids: ['display_video_oauth_scope', 'dv360_customer_role', 'exact_advertiser_access'],
  actions: ['DV360_ADVERTISERS_GET'],
  recorded_scopes: ['https://www.googleapis.com/auth/display-video'],
  program: {
    access:
      'The Google identity must have access to the selected Display & Video 360 advertiser or its parent partner. The recorded OAuth scope is a separate prerequisite.',
    reference: 'https://developers.google.com/display-video/api/guides/getting-started/overview',
    checked_on: '2026-10-06',
    limitations:
      'An advertiser read does not establish write permission, line-item eligibility or Bid Manager reporting access. Bid Manager uses its own OAuth scope and report workflow.',
  },
  // Display & Video 360 documents no program-specific refusal codes; a refusal points to the user profile (CON-04).
  undocumented_refusal: {
    kind: 'verify_member_role',
    text: 'Display & Video 360 refused this advertiser read. Confirm that the Google identity of this login has a Display & Video 360 user profile with Admin, Standard or Read only access to this advertiser or its partner, then check again. AMCP infers no other cause.',
  },
  account_setup: {
    text: 'No Display & Video 360 advertiser is selected for AMCP. On the Connections page, connect the Google identity that has Display & Video 360 access, sync it and select the advertiser, then inspect this program again.',
    prerequisites: [
      {
        id: 'dv360_customer_role',
        text: 'The Google identity needs a Display & Video 360 user profile with Admin, Standard or Read only access to the partner or advertiser.',
      },
      {
        id: 'display_video_oauth_scope',
        text: 'Grant the Display & Video 360 permission when you connect the Google identity.',
      },
      {
        id: 'exact_advertiser_access',
        text: 'AMCP lists advertisers through the partners the identity can see. After syncing, select the advertiser to expose to MCP.',
      },
    ],
  },
  next_call: withEffects({
    tool: 'amcp_workspace',
    arguments: {action: 'program_check', workflow_id: 'program:dv360_advertiser', live: false},
  }),
  website_path: '/capabilities?workflow_id=program%3Adv360_advertiser',
  source: 'src/conditional-programs.ts',
};

/** DV360's program, with its check's steps. */
export const dv360ConditionalPrograms: readonly ProviderConditionalProgram[] = Object.freeze([
  Object.freeze({
    program: advertiser,
    steps: Object.freeze({
      // A local inspection's next call asks for the live read with no requirements.
      liveArguments: () => ({requirements: {}}),
      request(program: ConditionalProgram, requirements: JsonObject, account: string): JsonObject {
        validate(requirements, []);
        return {action: program.actions[0], pathParams: {advertiserId: account}};
      },
      evidence(_program: ConditionalProgram, data: JsonObject, _requirements: JsonObject, account: string): JsonObject {
        if (
          data.advertiserId !== account ||
          typeof data.partnerId !== 'string' ||
          !/^[1-9][0-9]{0,19}$/.test(data.partnerId) ||
          !obj(data.generalConfig) ||
          typeof data.generalConfig.currencyCode !== 'string' ||
          !/^[A-Z]{3}$/.test(data.generalConfig.currencyCode) ||
          (data.entityStatus !== undefined &&
            (typeof data.entityStatus !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(data.entityStatus)))
        )
          bad('Retain the exact native advertiser, parent partner and currency.', 'PROGRAM_EVIDENCE_INVALID');
        return {
          advertiser_id: data.advertiserId,
          partner_id: data.partnerId,
          currency: data.generalConfig.currencyCode,
          entity_status: data.entityStatus ?? null,
        };
      },
    }),
  }),
]);
