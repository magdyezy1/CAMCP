/**
 * The Snapchat paths a scoped resource is read by (a leaf: src/scope.ts re-exports these, and Snapchat's scope hooks in
 * src/snapchat-adapter.ts read them; moved from src/scope.ts, ARC-01 phase B).
 */

/** The organization of GET /v1/organizations/{id}/pixels: the only organization read an account binding reaches. */
export function snapchatOrganizationPixels(path: string): string | undefined {
  return /^\/v1\/organizations\/([\w-]{1,64})\/pixels$/.exec(path)?.[1];
}
/** The global Snapchat entity that scopes a path (campaigns/<id>, adsquads/<id>, …), as held in resource ownership. */
export function snapchatScopedResource(path: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  return /^\/v1\/(campaigns|adsquads|ads|creatives|media|pixels|lead_generation_forms|segments)\/([^/]+)/
    .exec(decoded)
    ?.slice(1)
    .join('/');
}
