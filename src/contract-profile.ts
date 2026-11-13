import {AsyncLocalStorage} from 'node:async_hooks';

/**
 * The contract profile of an MCP client (V2-MCP-06, owner decision D26): which shape of the MCP surface a client is served.
 * `legacy` is every client's profile today and stays what a client is served until its profile is set; `v2` is the opt-in
 * profile: truthful annotations on the native gateways, a media hand-off in place of a saved review, a response budget with
 * continuations, compact projection of list reads, and guides in sections. The profile belongs to the AI client, is read on
 * the server from its record (src/mcp-client-profile.ts) and is never chosen by the request. The website's own calls, the
 * workers and every caller that is not an MCP client are legacy: they never enter a profile scope.
 *
 * This leaf holds the names and the scope the MCP server runs a client's calls in, so the code that differs by profile asks
 * `currentContractProfile()` instead of being handed the profile through every call. A call made outside a scope is legacy.
 */
export const contractProfiles = ['legacy', 'v2'] as const;
export type ContractProfile = (typeof contractProfiles)[number];
export const defaultContractProfile: ContractProfile = 'legacy';

const scope = new AsyncLocalStorage<ContractProfile>();
/** Runs `run`, and everything it awaits, as a client on `profile`: tool calls nested inside it inherit the profile. */
export const withContractProfile = <T>(profile: ContractProfile, run: () => T): T => scope.run(profile, run);
/** The profile of the call in flight: the client's inside a scope, else legacy. */
export const currentContractProfile = (): ContractProfile => scope.getStore() ?? defaultContractProfile;
