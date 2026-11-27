/**
 * How long what a Meta account listed or AMCP created vouches for an ID (r25-fr-window; Q22 of the Round 2.5 plan, owner 2026-11-15: "6 h for IDs
 * that AMCP listed or created"; the owner's friction report of 2026-11-25, C1 and B3). A campaign, an ad set and an ad never change ad account, so what
 * the account's own list, the ad identity probe, AMCP's own create or an inventory page shows of them stays true for six hours. A creative, an audience,
 * a pixel, a label or a rule set can be shared, so each keeps the store's five minutes. The store keeps no observation longer than this (src/store.ts).
 */
export const metaOwnedMs = 6 * 60 * 60 * 1000;
/** The lifetime of an ID learned from the account edge at `path`, undefined (the store's default) for an edge whose IDs can be shared. */
export const metaOwnedFor = (path: string): number | undefined =>
  /\/(?:campaigns|adsets|ads)$/.test(path) ? metaOwnedMs : undefined;
