import type {Store} from './store.js';
import type {Actor} from './types.js';
import {contractProfiles, defaultContractProfile, type ContractProfile} from './contract-profile.js';
import {registeredClient, setRegisteredClientProfile, tableExists} from './mcp-client-repository.js';

/**
 * Which contract profile an MCP client is served (V2-MCP-06, owner decision D26), read from the AI client's record.
 *
 * A client is the OAuth client an AI client's access token was issued to: its actor is `oauth/<client ID>`. The profile is the
 * `contract_profile` field of that client's registration record (amcp_mcp_clients), where `v2` opts the client in and anything
 * else, a record without the field included, means `legacy`. It is read on every request, so a change applies at the
 * client's next request and survives a token refresh, which is another credential of the same client. Nothing the request
 * says can choose it: not a header, an argument, a protocol field or a client's own registration (a registration copies only
 * the metadata fields AMCP reads, server/mcp-oauth.ts), and no website control sets it yet (Round 3 adds the switch on the AI
 * clients page, through `setContractProfile`).
 *
 * Every caller that is not such a client is `legacy`: an API key, a connector token, a local or stdio actor, and the
 * website's own calls. A client without a registration row (one identified by a client metadata document, which has none) is
 * legacy as well, for there is no record to hold a profile; giving those clients one is Round 3's to decide.
 */
const prefix = 'oauth/';
/** The client ID of an AI client's actor, or undefined for any other caller. */
export function mcpClientOf(actor: Pick<Actor, 'userId'>): string | undefined {
  return actor.userId.startsWith(prefix) && actor.userId.length > prefix.length
    ? actor.userId.slice(prefix.length)
    : undefined;
}
export function contractProfileOf(store: Store, actor: Pick<Actor, 'userId'>): ContractProfile {
  const client = mcpClientOf(actor);
  if (client === undefined) return defaultContractProfile;
  try {
    // An MCP-only store has no registration table: nothing there can vouch for a client, and nothing is opted in.
    if (!tableExists(store, 'amcp_mcp_clients')) return defaultContractProfile;
    const row = registeredClient(store, client);
    if (!row) return defaultContractProfile;
    const profile = JSON.parse(row.data)?.contract_profile;
    return contractProfiles.includes(profile) ? profile : defaultContractProfile;
  } catch {
    // A record or a store that cannot be read serves the client what it has always been served; the call itself reports a
    // store that is failing.
    return defaultContractProfile;
  }
}
/**
 * Sets an AI client's profile: for Round 3's switch and for tests. Returns whether the client has a record to hold it; a
 * client without one is not given one, and a profile that is not one of the two is refused.
 */
export function setContractProfile(store: Store, clientId: string, profile: ContractProfile): boolean {
  if (!contractProfiles.includes(profile)) throw new TypeError('A contract profile is legacy or v2.');
  return tableExists(store, 'amcp_mcp_clients') && setRegisteredClientProfile(store, clientId, profile);
}
