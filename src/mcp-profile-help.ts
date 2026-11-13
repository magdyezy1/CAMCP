import type {JsonObject} from './types.js';
import {defaultContractProfile, type ContractProfile} from './contract-profile.js';

/**
 * `amcp_workspace {action:"help",topic:"mcp_profile"}` (V2-MCP-06): what the contract profile of this connection is and what
 * the other one changes, in the help of the tool and not in tools/list, which has no room for it. The plan asks that a
 * changed default be announced in the tool's own help before it reaches a client; none reaches any client until its profile
 * is set, so this is where an AI client, and the person using it, finds out what they would be switching to.
 *
 * `v2Changes` lists each behaviour the v2 profile serves, one entry per behaviour, in the words a client acts on.
 */
export const v2Changes: readonly {id: string; text: string}[] = Object.freeze([]);

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
  };
}
