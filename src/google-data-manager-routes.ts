import type {Action} from './types.js';

/**
 * Google's Data Manager API v1 (discovery revision 20260929; reference pages read 2026-09-30), which replaces Customer
 * Match and offline conversion uploads through the Google Ads API for projects new to them. AMCP maps the three writes
 * its reviewed families use and the status read that verifies them, on the Google Ads connection with the datamanager
 * scope the owner approved on 2026-09-30.
 */
const gateway = 'google_ads_native_action',
  origin = 'https://datamanager.googleapis.com',
  source = 'https://developers.google.com/data-manager/api/reference/rest';
function route(name: string, method: string, path: string, readOnly: boolean): Action {
  return {
    gateway,
    name,
    canonical_name: name,
    aliases: [],
    method,
    path: origin + path,
    read_only: readOnly,
    destructive: false,
    required: [],
    path_parameters: [],
    evidence: 'VENDOR_DOCUMENTED_NOT_AMCP_VERIFIED',
    raw: {
      name,
      canonical_action: name,
      method,
      path: origin + path,
      category: 'Data Manager API',
      read_only: readOnly,
      destructive: false,
      access_management: false,
      path_parameters: [],
      required_parameters: [],
      native_fields: [],
      source,
    },
  } as unknown as Action;
}
export const dataManagerOrigin = origin;
export const dataManagerActions: Action[] = [
  route('DATA_MANAGER_INGEST_AUDIENCE_MEMBERS', 'POST', '/v1/audienceMembers:ingest', false),
  route('DATA_MANAGER_REMOVE_AUDIENCE_MEMBERS', 'POST', '/v1/audienceMembers:remove', false),
  route('DATA_MANAGER_INGEST_EVENTS', 'POST', '/v1/events:ingest', false),
  route('DATA_MANAGER_RETRIEVE_REQUEST_STATUS', 'GET', '/v1/requestStatus:retrieve', true),
];
