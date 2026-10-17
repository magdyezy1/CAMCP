/**
 * Offers parked providers to this test process (ARC-01, P9). A parked provider (src/provider-adapters.ts) is offered
 * only where AMCP_PROVIDERS names it; its code keeps compiling and its tests keep running by naming it here. The
 * names are added to any the environment already sets, and child processes inherit them.
 */
export function offerParkedProviders(...ids: string[]): void {
  const named = new Set((process.env.AMCP_PROVIDERS ?? '').split(/[\s,]+/).filter(Boolean));
  for (const id of ids) named.add(id);
  process.env.AMCP_PROVIDERS = [...named].join(',');
}
