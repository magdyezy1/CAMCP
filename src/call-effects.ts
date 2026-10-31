import type {JsonObject} from './types.js';

// The declared effects of a suggested call (MCP-09), a leaf: it imports no module at run time. A provider's module
// labels its follow-up calls here (LinkedIn's and DV360's conditional programs, src/linkedin-conditional-programs.ts and
// src/dv360-conditional-programs.ts) without importing src/workflow-outcomes.ts, which reads the providers' workspace
// workflows (src/provider-workflows.ts) and so would close an import cycle through src/provider-hooks.ts.
// src/workflow-outcomes.ts re-exports both functions, so its importers are unchanged.

/**
 * What following a suggested call does (MCP-09): whether it reaches a provider, which AMCP records it may save, and that
 * it changes no advertising account. It labels the effects the called action already has and changes none of them:
 * `amcp_workspace check` with live:false makes no request and saves nothing; with live:true it reads the provider
 * account and saves the shared account-read evidence (`readiness`, CON-03) and the account's metadata.
 * `program_check` with live:true keeps one timestamped observation of the read (CON-04, owner decision D20); with
 * live:false it saves nothing. `saves` is the most a call saves: a read that fails before the provider answers, or a
 * login without an account read, saves less. Calls it does not know are left unlabelled rather than guessed.
 */
export function callEffects(call: {tool?: unknown; arguments?: JsonObject}): JsonObject | undefined {
  const args = call.arguments ?? {},
    live = args.live === true,
    effects = (provider_requests: 'none' | 'read_only', saves: string[]) => ({
      provider_requests,
      saves,
      advertising_writes: 0,
    });
  // A retained review read back (AMCP alone), or an uncertain one reconciled with provider reads only (WRT-08).
  if (call.tool === 'amcp_write' && args.action === 'status') return effects('none', []);
  if (call.tool === 'amcp_write' && args.action === 'reconcile' && args.accept_applied === undefined)
    return effects('read_only', ['write_reconciliation']);
  if (call.tool !== 'amcp_workspace') return;
  if (args.action === 'check')
    return effects(live ? 'read_only' : 'none', live ? ['readiness', 'account_metadata'] : []);
  if (args.action === 'program_check')
    return effects(live ? 'read_only' : 'none', live ? ['conditional_program_observation'] : []);
  if (['capabilities', 'contracts', 'dashboard', 'operations', 'history'].includes(args.action))
    return effects('none', []);
}

/** A suggested call with its declared effects (MCP-09). */
export function withEffects<T extends {tool: string; arguments: JsonObject}>(call: T): T & {effects?: JsonObject} {
  const effects = callEffects(call);
  return effects ? {...call, effects} : call;
}
