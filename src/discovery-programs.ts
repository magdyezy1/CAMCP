import type {DiscoveryProgramFacts} from './provider-adapter.js';
import {discoveryProgramProviders} from './provider-hooks.js';
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

/** A program's entry: what its provider declares (src/<provider>-adapter.ts), with what every entry says, as plain data. */
function entry(gateway: string, facts: DiscoveryProgramFacts): DiscoveryOnlyProgram {
  const f = structuredClone(facts) as DiscoveryOnlyProgram;
  return {
    id: f.id,
    kind: 'discovery_only_program',
    mode: 'discovery_only',
    name: f.name,
    gateway,
    description: f.description,
    effects: 'none',
    provider_requests: 0,
    prerequisites: f.prerequisites,
    program: f.program,
    unlocks: f.unlocks,
    withheld_actions: f.withheld_actions,
    ...(f.withheld_reason !== undefined ? {withheld_reason: f.withheld_reason} : {}),
    ...(f.personal_data !== undefined ? {personal_data: f.personal_data} : {}),
    meaning,
  };
}
/** Every provider's programs (ARC-01, wave 4c round 6), in the order src/provider-hooks.ts declares. */
export const discoveryOnlyPrograms: DiscoveryOnlyProgram[] = discoveryProgramProviders.flatMap(hooks =>
  hooks.programs!.map(facts => entry(hooks.gateway, facts)),
);

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
