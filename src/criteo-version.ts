/**
 * The Criteo Retail Media API version AMCP sends requests to: 2026-07 since 2026-09-29, pinned from Criteo's official
 * OpenAPI document (.mirror/VENDOR/criteo-retail-2026-07.json). Criteo supports each version for 12 months (Versioning
 * Policy); 2026-01, the version before, is supported until 27 January 2027. There is no switch back: 2026-07 changed
 * the report and balance request shapes, so the previous version would need its own document and families.
 */
export const criteoApiVersion = '2026-07';
/** The prefix of every Retail Media path at the current version: criteoPrefix + '/accounts'. */
export const criteoPrefix = '/' + criteoApiVersion + '/retail-media';
/** A Retail Media route at the current version, for recognising requests: criteoRoute('/campaigns/[1-9][0-9]*$'). */
export const criteoRoute = (rest: string, flags?: string) => new RegExp('^' + criteoPrefix + rest, flags);
/** A Criteo guide of the current version: Criteo serves it without a version in the path (2026.07 when checked, 2026-09-29). */
export const criteoDocs = (page: string) => 'https://developers.criteo.com/retail-media/docs/' + page;
