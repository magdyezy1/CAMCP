import {MirrorError} from './errors.js';
import {fingerprint} from './report-quality.js';
import {collectionCheckpoint} from './report-collection-budget.js';
import {accessRefusalCodes, detailParentsUnavailableWarning, optionalReadRefused} from './report-source.js';
import {reportSource} from './report-sources.js';
import {reportPlatforms} from './report-metrics.js';
import {storedLogin} from './connection-authority.js';
import type {MirrorService} from './service.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';

/**
 * RPT-07: native parent identity for detailed Overview rows whose report response carries none. The platform's report
 * source reads them (`detailParents`, ARC-01 reporting: src/tiktok-detail-parents.ts, src/snapchat-detail-parents.ts,
 * src/linkedin-detail-parents.ts):
 *  - TikTok ad groups (campaign) and ads (campaign and ad group): the advertiser's own ad group and ad reads filtered by
 *    the reported IDs with primary_status STATUS_ALL, so a deleted entity with history keeps its parents; then the
 *    parents' names. At most 100 IDs per request.
 *  - Snapchat ads (campaign and ad squad): Snapchat's documented by-ID reads of the reported ads, their ad squads and
 *    their campaigns in the source account; every campaign must name the source account.
 *  - LinkedIn creatives (campaign): the account's creatives criteria finder filtered by the reported creative URNs (100
 *    per page; every creative must name the source account), then the campaigns' current names.
 * These parent relationships cannot change for a native entity, so each entity is read once per source per job (later
 * periods read only new entities). A read the provider refuses keeps the rows with unknown parents and a warning; a
 * foreign, duplicate, malformed or conflicting parent refuses the source. Parents are never guessed.
 */
export interface DetailParentCache {
  /** Entity ID → native parents ({} when the provider returned no record for it: unknown). */
  parents: Record<string, JsonObject>;
  lineage: JsonObject[];
  /** The provider refused this optional read; the source's later entities keep unknown parents. */
  unavailable?: boolean;
  /** More distinct entities than the bounded parent read covers; entities beyond it keep unknown parents. */
  limited?: boolean;
}
/** Distinct entities per source and job whose parents are read. */
export const detailParentLimit = 1000;
// The optional-read rules moved to the report-source contract (wave 4c round 6), which the platforms' sources share.
export {accessRefusalCodes, detailParentsUnavailableWarning, optionalReadRefused} from './report-source.js';
export const detailParentsLimitedWarning =
  'This source reports more than 1000 entities, so the parents of entities beyond that bound stay unknown.';
/** The detailed levels whose report rows carry no parents of their own (the platform's report source says which). */
export function detailParentKind(
  platform: string,
  level: string,
  scoped = false,
  contract?: string,
): string | undefined {
  return reportSource(platform)?.detailParents?.kind(level, scoped, contract);
}
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const name = (v: unknown) => (typeof v === 'string' && v.length <= 1000 ? v : null);
const shape = (message: string): never => {
  throw new MirrorError('REPORT_SHAPE_CHANGED', message, {}, 502);
};
const foreign = (message: string): never => {
  throw new MirrorError('REPORT_ACCOUNT_MISMATCH', message, {}, 502);
};
/** A provider-level refusal inside a 200 response (TikTok code, Snapchat request status): the read is unavailable. */
const refused = (message: string): never => {
  throw new MirrorError('DETAIL_PARENTS_REFUSED', message, {}, 400);
};

/**
 * Reads the parents of `ids` not yet in `cache` and returns the parents of every requested ID, the lineage of the
 * reads (cached ones marked) and the warnings to show with the source.
 */
export async function detailParents(
  service: MirrorService,
  source: JsonObject,
  level: string,
  ids: string[],
  actor: Actor,
  cache: DetailParentCache = {parents: {}, lineage: []},
): Promise<{parents: Record<string, JsonObject>; lineage: JsonObject[]; warnings: string[]}> {
  const kind = detailParentKind(String(source.platform), level, !!source.campaign_id, source.reporting_contract);
  if (!kind) return {parents: {}, lineage: [], warnings: []};
  const reports = reportSource(String(source.platform))!,
    reader = reports.detailParents!;
  const known = cache.lineage.map(entry => ({...entry, cached: true})),
    wanted = [...new Set(ids)].filter(id => !Object.hasOwn(cache.parents, id)),
    room = Math.max(0, detailParentLimit - Object.keys(cache.parents).length),
    reading = cache.unavailable ? [] : wanted.slice(0, room),
    lineage: JsonObject[] = [];
  if (!cache.unavailable && wanted.length > room) cache.limited = true;
  if (reading.length) {
    const gateway = reportPlatforms[source.platform]!.gateway,
      account = String(source.account_id),
      connection = service.store.resolveConnection(actor, gateway, account, source.connection_id),
      authority = (c: typeof connection) =>
        fingerprint({login: storedLogin(service.store, c), scopes: [...c.scopes].sort()});
    const authorization = authority(connection),
      current = () => {
        service.store.assertActorActive(actor);
        const c = service.store.resolveConnection(actor, gateway, account, connection.id);
        if (authority(c) !== authorization)
          throw new MirrorError(
            'CONNECTION_AUTHORITY_CHANGED',
            'The login or its permissions changed while native parents were read. Run the report again.',
            {},
            409,
          );
        collectionCheckpoint();
      };
    // Each read names its catalog action, so the native scope guard confines it like any read of that action.
    const read = async (action: string, path: string, query: JsonObject, body?: JsonObject) => {
      const plan: CompiledRequest = {
        gateway,
        accountId: account,
        action,
        method: body ? 'POST' : 'GET',
        path,
        query,
        body,
        headers: reader.headers?.() ?? {},
        readOnly: true,
        destructive: false,
        requiresConfirmation: false,
        evidence: 'Native parent identity of reported entities, bounded account scope',
        warnings: [],
      };
      current();
      const out = (await service.runPlan(
        plan,
        {connection_id: connection.id, aggregate_pages: false, max_pages: 1},
        actor,
      )) as JsonObject;
      current();
      if (out.dry_run || out.success !== true || !obj(out.data) || out.truncated)
        throw new MirrorError('REPORT_INCOMPLETE', 'Native parents were not returned completely.', {}, 502);
      lineage.push({
        stage: 'detail_parents',
        method: plan.method,
        path: plan.path,
        origin: null,
        api_version:
          (reports.versionHeader ? plan.headers?.[reports.versionHeader] : undefined) ??
          plan.path.match(/\/(v?\d+(?:\.\d+)?)(?:\/|$)/)?.[1] ??
          'native',
        query_fingerprint: fingerprint({method: plan.method, path: plan.path, query: plan.query, body: plan.body}),
        response_fingerprint: fingerprint(out.data),
        captured_at: Date.now(),
      });
      return out.data as JsonObject;
    };
    const found: Record<string, JsonObject> = {};
    const record = (id: string, parents: JsonObject) => {
      // One entity named twice with different parents is drift; the same parents twice are one record.
      if (Object.hasOwn(found, id) && fingerprint(found[id]) !== fingerprint(parents))
        foreign('The detailed entity changed native parents during collection.');
      found[id] = parents;
    };
    try {
      await reader.read(kind, reading, {
        account,
        read,
        record,
        shape,
        foreign,
        refused,
        name,
        reportingContract: source.reporting_contract,
      });
      for (const id of reading) cache.parents[id] = found[id] ?? {};
      cache.lineage.push(...lineage);
    } catch (e) {
      current();
      // Only a provider refusal of this optional read keeps unknown parents (an HTTP 400/403/404, or a refusal the
      // provider states in its response body). A foreign, malformed or partial record, a retryable failure, a scope
      // guard refusal, or a revoked connection or credential fails the source.
      if (
        !(e instanceof MirrorError) ||
        e.retryable ||
        accessRefusalCodes.has(e.code) ||
        e.details.layer === 'credential' ||
        (e.code !== 'DETAIL_PARENTS_REFUSED' && !optionalReadRefused(e) && !reader.bodyRefused?.(e))
      )
        throw e;
      cache.unavailable = true;
    }
  }
  return {
    parents: Object.fromEntries(ids.filter(id => Object.hasOwn(cache.parents, id)).map(id => [id, cache.parents[id]!])),
    lineage: [...known, ...lineage],
    warnings: [
      ...(cache.unavailable ? [reader.unavailableWarning ?? detailParentsUnavailableWarning] : []),
      ...(cache.limited ? [reader.limitedWarning ?? detailParentsLimitedWarning] : []),
    ],
  };
}
