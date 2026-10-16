import {MirrorError} from './errors.js';
import {fingerprint} from './report-quality.js';
import {collectionCheckpoint} from './report-collection-budget.js';
import {linkedinVersion} from './linkedin-version.js';
import {linkedInCampaignMetadata} from './linkedin-reporting.js';
import {reportPlatforms} from './report-metrics.js';
import {storedLogin} from './connection-authority.js';
import type {MirrorService} from './service.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';

/**
 * RPT-07: native parent identity for detailed Overview rows whose report response carries none.
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
export const detailParentsUnavailableWarning =
  'Native parents could not be read for this source, so its rows show entity IDs without parent campaigns or ad groups.';
export const detailParentsLimitedWarning =
  'This source reports more than 1000 entities, so the parents of entities beyond that bound stay unknown.';
type Kind = 'tiktok_adgroup' | 'tiktok_ad' | 'snapchat_ad' | 'linkedin_creative';
/** The detailed levels whose report rows carry no parents of their own. */
export function detailParentKind(platform: string, level: string, scoped = false): Kind | undefined {
  if (platform === 'tiktok') return level === 'adset' ? 'tiktok_adgroup' : level === 'ad' ? 'tiktok_ad' : undefined;
  if (platform === 'snapchat' && level === 'ad' && !scoped) return 'snapchat_ad';
  if (platform === 'linkedin' && level === 'ad') return 'linkedin_creative';
  return undefined;
}
const tiktokId = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
const snapchatId = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const creativeUrn = /^urn:li:sponsoredCreative:([1-9][0-9]{0,31})$/,
  campaignUrn = /^urn:li:sponsoredCampaign:([1-9][0-9]{0,31})$/;
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
const batches = <T>(values: T[], size: number) =>
  Array.from({length: Math.ceil(values.length / size)}, (_, i) => values.slice(i * size, i * size + size));
/** AMCP's own access and binding refusals: they fail the source, since only the provider can refuse an optional read. */
export const accessRefusalCodes: ReadonlySet<string> = new Set([
  'CONNECTION_REQUIRED',
  'CONNECTION_AUTHORITY_CHANGED',
  'RESOURCE_SCOPE_REQUIRED',
  'ACCOUNT_SCOPE_MISMATCH',
  'ACCOUNT_REQUIRED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'MEMBERSHIP_REVOKED',
  'ACCOUNT_ACCESS_REVOKED',
]);
/**
 * Whether `e` is a provider refusal (HTTP 400, 403 or 404) of an optional metadata read (names, objectives, parents),
 * after which the rows stay with unknown values and a warning. A malformed or partial response (REPORT_*), a retryable
 * failure, or a removed connection, changed login or scope refusal (accessRefusalCodes) fails the source instead.
 */
export function optionalReadRefused(e: unknown): e is MirrorError {
  return (
    e instanceof MirrorError &&
    !e.retryable &&
    !e.code.startsWith('REPORT_') &&
    !accessRefusalCodes.has(e.code) &&
    [400, 403, 404].includes(e.status)
  );
}

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
  const kind = detailParentKind(String(source.platform), level, !!source.campaign_id);
  if (!kind) return {parents: {}, lineage: [], warnings: []};
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
        headers:
          source.platform === 'linkedin'
            ? {
                'LinkedIn-Version': linkedinVersion(),
                'X-Restli-Protocol-Version': '2.0.0',
                'X-RestLi-Method': 'FINDER',
              }
            : {},
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
          plan.headers?.['LinkedIn-Version'] ?? plan.path.match(/\/(v?\d+(?:\.\d+)?)(?:\/|$)/)?.[1] ?? 'native',
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
      if (kind === 'tiktok_adgroup' || kind === 'tiktok_ad') {
        const list = async (entity: 'campaign' | 'adgroup' | 'ad', wantedIds: string[], fields: string[]) => {
          const rows: JsonObject[] = [];
          for (const batch of batches(wantedIds, 100)) {
            const d = await read('tiktok_' + entity + '_get', '/v1.3/' + entity + '/get/', {
              advertiser_id: account,
              filtering: {[entity + '_ids']: batch, primary_status: 'STATUS_ALL'},
              fields: ['advertiser_id', ...fields],
              page: 1,
              page_size: 100,
            });
            if (d.code !== 0) refused('TikTok refused the parent read.');
            const page = d.data;
            if (
              !obj(page) ||
              !Array.isArray(page.list) ||
              page.list.length > batch.length ||
              (page.page_info !== undefined &&
                (!obj(page.page_info) ||
                  Number(page.page_info.total_number) > batch.length ||
                  Number(page.page_info.total_page) > 1))
            )
              shape('TikTok returned malformed or incomplete parent evidence.');
            const seen = new Set<string>();
            for (const row of page.list as JsonObject[]) {
              const id = row?.[entity + '_id'];
              if (!obj(row) || !tiktokId(id) || !batch.includes(id) || seen.has(id))
                shape('TikTok returned an unrequested or repeated parent record.');
              if (row.advertiser_id !== undefined && row.advertiser_id !== account)
                foreign('TikTok returned a parent record of another advertiser.');
              seen.add(id);
              rows.push(row);
            }
          }
          return rows;
        };
        const child = kind === 'tiktok_ad' ? 'ad' : 'adgroup',
          children = await list(
            child,
            reading,
            child === 'ad' ? ['campaign_id', 'adgroup_id', 'ad_id'] : ['campaign_id', 'adgroup_id'],
          );
        for (const row of children)
          if (!tiktokId(row.campaign_id) || (child === 'ad' && !tiktokId(row.adgroup_id)))
            shape('TikTok returned a record without its exact native parents.');
        const groupIds = child === 'ad' ? [...new Set(children.map(row => String(row.adgroup_id)))] : [],
          groups = new Map<string, JsonObject>();
        for (const row of groupIds.length
          ? await list('adgroup', groupIds, ['campaign_id', 'adgroup_id', 'adgroup_name'])
          : [])
          groups.set(String(row.adgroup_id), row);
        const campaigns = new Map<string, JsonObject>();
        for (const row of await list(
          'campaign',
          [...new Set(children.map(row => String(row.campaign_id)))],
          ['campaign_id', 'campaign_name'],
        ))
          campaigns.set(String(row.campaign_id), row);
        for (const row of children) {
          const group = groups.get(String(row.adgroup_id));
          // An ad whose ad group names another campaign is a changed hierarchy, never a choice between the two.
          if (child === 'ad' && group && group.campaign_id !== row.campaign_id)
            foreign('The detailed entity changed native parents during collection.');
          record(String(row[child + '_id']), {
            campaign_id: String(row.campaign_id),
            campaign_name: name(campaigns.get(String(row.campaign_id))?.campaign_name),
            ...(child === 'ad' ? {adset_id: String(row.adgroup_id), adset_name: name(group?.adgroup_name)} : {}),
          });
        }
      } else if (kind === 'snapchat_ad') {
        const byIds = async (entities: 'ads' | 'adsquads' | 'campaigns', wantedIds: string[]) => {
          const rows: JsonObject[] = [],
            singular = {ads: 'ad', adsquads: 'adsquad', campaigns: 'campaign'}[entities];
          for (const batch of batches(wantedIds, 1000)) {
            const d = await read(
              'snapchat_' + singular + '_get_by_ids',
              '/v1/adaccounts/' + account + '/get_' + entities + '_by_ids',
              {},
              {entity_ids: batch.map(id => ({id}))},
            );
            if (d.request_status !== undefined && d.request_status !== 'SUCCESS')
              refused('Snapchat refused the parent read.');
            if (!Array.isArray(d[entities]) || d[entities].length > batch.length)
              shape('Snapchat returned malformed parent evidence.');
            const seen = new Set<string>();
            for (const entry of d[entities] as JsonObject[]) {
              if (!obj(entry)) shape('Snapchat returned malformed parent evidence.');
              // An entity Snapchat reports as not found stays unknown; it never borrows another record.
              if (entry.sub_request_status !== undefined && entry.sub_request_status !== 'SUCCESS') continue;
              const row = entry[singular];
              if (!obj(row) || !snapchatId(row.id) || !batch.includes(row.id) || seen.has(row.id))
                shape('Snapchat returned an unrequested or repeated parent record.');
              seen.add(row.id);
              rows.push(row);
            }
          }
          return rows;
        };
        const ads = await byIds('ads', reading);
        for (const ad of ads) if (!snapchatId(ad.ad_squad_id)) shape('Snapchat returned an ad without its ad squad.');
        const squads = new Map<string, JsonObject>();
        for (const squad of await byIds('adsquads', [...new Set(ads.map(ad => String(ad.ad_squad_id)))])) {
          if (!snapchatId(squad.campaign_id)) shape('Snapchat returned an ad squad without its campaign.');
          squads.set(String(squad.id), squad);
        }
        const campaigns = new Map<string, JsonObject>();
        for (const campaign of await byIds('campaigns', [
          ...new Set([...squads.values()].map(s => String(s.campaign_id))),
        ])) {
          if (campaign.ad_account_id !== account) foreign('Snapchat returned a parent campaign of another ad account.');
          campaigns.set(String(campaign.id), campaign);
        }
        for (const ad of ads) {
          const squad = squads.get(String(ad.ad_squad_id)),
            campaign = squad && campaigns.get(String(squad.campaign_id));
          // Without its ad squad and an owned campaign, the ad's parents stay unknown.
          if (!squad || !campaign) continue;
          record(String(ad.id), {
            campaign_id: String(campaign.id),
            campaign_name: name(campaign.name),
            adset_id: String(squad.id),
            adset_name: name(squad.name),
          });
        }
      } else {
        const owner = 'urn:li:sponsoredAccount:' + account,
          creatives: JsonObject[] = [];
        for (const batch of batches(reading, 100)) {
          for (const urn of batch) if (!creativeUrn.test(urn)) shape('LinkedIn did not report a native creative URN.');
          const d = await read(
            'linkedin_rest_ad_accounts_ad_account_id_creatives_get',
            '/rest/adAccounts/' + account + '/creatives',
            {q: 'criteria', creatives: batch, pageSize: 100},
          );
          if (
            !Array.isArray(d.elements) ||
            d.elements.length > batch.length ||
            (d.metadata !== undefined && (!obj(d.metadata) || d.metadata.nextPageToken)) ||
            d.paging?.links?.some?.((link: JsonObject) => link?.rel === 'next')
          )
            shape('LinkedIn returned malformed or incomplete creative parents.');
          const seen = new Set<string>();
          for (const row of d.elements as JsonObject[]) {
            if (!obj(row) || typeof row.id !== 'string' || !batch.includes(row.id) || seen.has(row.id))
              shape('LinkedIn returned an unrequested or repeated creative.');
            if (row.account !== owner) foreign('LinkedIn returned a creative of another advertising account.');
            if (typeof row.campaign !== 'string' || !campaignUrn.test(row.campaign))
              shape('LinkedIn returned a creative without its exact campaign.');
            seen.add(row.id);
            creatives.push(row);
          }
        }
        const named = creatives.length
          ? await linkedInCampaignMetadata(
              account,
              creatives.map(row => String(row.campaign)),
              query =>
                read(
                  'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_get',
                  '/rest/adAccounts/' + account + '/adCampaigns',
                  query,
                ),
            )
          : {campaigns: {} as Record<string, JsonObject>};
        for (const row of creatives)
          record(String(row.id), {
            campaign_id: campaignUrn.exec(String(row.campaign))![1]!,
            campaign_name: name(named.campaigns[String(row.campaign)]?.name),
          });
      }
      for (const id of reading) cache.parents[id] = found[id] ?? {};
      cache.lineage.push(...lineage);
    } catch (e) {
      // Only a provider refusal of this optional read keeps unknown parents (an HTTP 400/403/404, or a refusal the
      // provider states in its response body). A foreign, malformed or partial record, a retryable failure, a scope
      // guard refusal, or a revoked connection or credential fails the source.
      if (
        !(e instanceof MirrorError) ||
        e.retryable ||
        accessRefusalCodes.has(e.code) ||
        (e.code !== 'DETAIL_PARENTS_REFUSED' && e.code !== 'PLATFORM_ERROR' && !optionalReadRefused(e))
      )
        throw e;
      cache.unavailable = true;
    }
  }
  return {
    parents: Object.fromEntries(ids.filter(id => Object.hasOwn(cache.parents, id)).map(id => [id, cache.parents[id]!])),
    lineage: [...known, ...lineage],
    warnings: [
      ...(cache.unavailable ? [detailParentsUnavailableWarning] : []),
      ...(cache.limited ? [detailParentsLimitedWarning] : []),
    ],
  };
}
