import type {JsonObject} from './types.js';
import {defaultContractProfile, type ContractProfile} from './contract-profile.js';
import {keptCautiousReason, v2KeptCautiousGateways, v2ReadOnlyGateways} from './tool-annotations.js';

/**
 * `amcp_workspace {action:"help",topic:"mcp_profile"}` (V2-MCP-06): what the contract profile of this connection is and what
 * the other one changes, in the help of the tool and not in tools/list, which has no room for it. The plan asks that a
 * changed default be announced in the tool's own help before it reaches a client; none reaches any client until its profile
 * is set, so this is where an AI client, and the person using it, finds out what they would be switching to.
 *
 * `v2Changes` lists each behaviour the v2 profile serves, one entry per behaviour, in the words a client acts on.
 */
export const v2Changes: readonly {id: string; text: string}[] = Object.freeze([
  {
    id: 'annotations',
    text: 'tools/list marks seven native gateways readOnlyHint:true: meta, tiktok, snapchat, dv360, linkedin, google_ads and x_ads (native_gateways_read_only below). Under v2 no call through them saves AMCP state or sends anything but a provider read: a native upload is handed to amcp_media (MEDIA_REVIEW_REQUIRED, below) and a native change to amcp_write (WRITE_REVIEW_REQUIRED). The other native gateways keep their annotations: the read-only ones stay read-only, and the five in native_gateways_unchanged below stay as they were because one of their actions writes. The hints of one operation are in amcp_tool_help {gateway, operation}.',
  },
  {
    id: 'media_handoff',
    text: 'A native upload with dry_run:false (a native gateway’s upload action with the file in payload.url, or amcp_native_action platform_media_upload) saves no review and fetches no file. It is refused with MEDIA_REVIEW_REQUIRED and a next_call to amcp_media prepare for the same file, as a native change is refused with WRITE_REVIEW_REQUIRED and a next_call to amcp_write; run that call, show the review to the user and execute it only after they approve. A caller who could not upload is refused exactly as before. The dry_run preview, amcp_media and amcp_write prepare are unchanged.',
  },
  {
    id: 'response_budget',
    text: 'An MCP read that returns a list is cut at a row boundary to a budget of 64 KiB of JSON; max_bytes (4,096 to 262,144) asks for another. A cut result has meta.budget (truncated, rows_total, rows_before, rows_returned, rows_omitted, max_bytes, and the next_call that continues it) and, in its data when that is an object, truncated and the same next_call; its own next_offset, next_cursor and provider next_call are emptied, so the continuation is the only way forward, and the last piece carries the result’s own paging again. A row is never cut: one larger than the budget is returned whole and marked over_budget. The continuation (the continuation argument of the call) belongs to the AI client, the person, the workspace and the exact arguments it was issued for, not to the access token, so it survives a token refresh; with any argument changed, or by another client, it is INVALID_CURSOR. Each piece reads the call again, so follow the pieces promptly, and ask for less with max_items or result_fields. Calls that save or send anything are never cut or re-run, an answer under the budget is returned whole, and legacy clients and the website are answered whole.',
  },
]);

/** The topic, for the profile this connection is served. */
export function contractProfileTopic(profile: ContractProfile = defaultContractProfile): JsonObject {
  return {
    topic: 'mcp_profile',
    profile,
    meaning:
      'AMCP serves each AI client one contract profile. legacy is every client’s profile today and what it keeps until its profile is set. v2 is opt-in per client: it changes how the MCP surface is shaped, as listed below, and nothing else. Permissions, reviews, spending policy and every other safeguard are the same in both. The profile is a record AMCP keeps for the client, so no argument, header or protocol field a request carries chooses it, and the website’s own pages are never affected.',
    switch:
      'No client is on v2 until its profile is set, and the control that sets it, a switch on the AI clients page, is planned. A change applies at the client’s next request and survives a token refresh.',
    v2_changes: v2Changes.map(change => ({...change})),
    // Which native gateways a v2 client is told only read, and why the others are not (the annotation change above).
    native_gateways_read_only: [...v2ReadOnlyGateways],
    native_gateways_unchanged: v2KeptCautiousGateways.map(gateway => ({
      gateway,
      annotations: 'the same under legacy and v2',
      writes: keptCautiousReason(gateway),
    })),
  };
}
