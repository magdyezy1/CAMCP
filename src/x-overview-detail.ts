import {MirrorError} from './errors.js';
import {collectionCheckpoint} from './report-collection-budget.js';
import {fingerprint} from './report-quality.js';
import {storedLogin} from './connection-authority.js';
import {nextDay, unmatchedScopeWarning, type ReportCollection} from './report-source.js';
import type {JsonObject} from './types.js';
import {zonedMidnight} from './workflows.js';
import {xActiveEntities, xActiveEntitiesMode, xActiveSet, xRefusedRead} from './x-active-entities.js';
import {xCampaignReport} from './x-campaign-report.js';
import {nativeDecimal} from './overview-native-detail.js';

const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9]{1,32}$/.test(value);
function refuse(code: string, message: string, status = 502, values?: Record<string, string>): never {
  throw new MirrorError(code, message, {}, status, false, values);
}
/** The population bounds: rows of one kind, and pages of one list. */
const populationRows = 10000,
  populationPages = 100;
const kindNames = {campaigns: 'campaigns', line_items: 'line items', promoted_tweets: 'promoted tweets'} as const;

/** Complete native population proof, with shared synchronous analytics arithmetic and checkpoint semantics. */
export async function collectXOverviewDetail(c: ReportCollection) {
  if (!c.timezone) refuse('INVALID_REPORT_SOURCE', 'X account timezone is required.', 400);
  const entity = c.detail === 'ad' ? 'PROMOTED_TWEET' : 'LINE_ITEM',
    needPromoted = c.detail === 'ad' || !!c.source.ad_ids?.length,
    mode = xActiveEntitiesMode(),
    definition = fingerprint({
      version: 1,
      source: c.source,
      range: c.range,
      currency: c.currency,
      timezone: c.timezone,
      mode,
    });
  const authority = () => {
    c.store.assertActorActive(c.actor);
    const connection = c.store.resolveConnection(c.actor, 'x_ads_native_action', c.account, c.connection);
    return fingerprint({login: storedLogin(c.store, connection), scopes: [...connection.scopes].sort()});
  };
  const authorization = authority(),
    current = () => {
      collectionCheckpoint();
      if (authority() !== authorization)
        refuse('CONNECTION_AUTHORITY_CHANGED', 'The X login or permissions changed. Start a new report.', 403);
    };
  let state = c.checkpoint.x_detail_v1;
  const save = () => {
    current();
    c.save({...c.checkpoint, x_detail_v1: state});
  };
  const list = async (kind: 'campaigns' | 'line_items' | 'promoted_tweets'): Promise<JsonObject[]> => {
    const rows: JsonObject[] = [],
      seen = new Set<string>(),
      cursors = new Set<string>(),
      values = {kind: kindNames[kind]};
    let cursor: string | undefined;
    for (let page = 1; page <= populationPages; page++) {
      current();
      const response = await c.run(
        c.plan('/12/accounts/' + c.account + '/' + kind, {
          count: 1000,
          with_deleted: true,
          ...(cursor ? {cursor} : {}),
        }),
        false,
        'detail_population',
      );
      current();
      if (
        !object(response) ||
        !Array.isArray(response.data) ||
        response.data.length > 1000 ||
        (response.request?.params?.account_id !== undefined && response.request.params.account_id !== c.account)
      )
        refuse('REPORT_SHAPE_CHANGED', 'X did not return a bounded native entity collection.');
      if (!Object.hasOwn(response, 'next_cursor'))
        refuse('REPORT_INCOMPLETE', 'X did not return an explicit native pagination boundary.');
      for (const row of response.data) {
        if (
          !object(row) ||
          !id(row.id) ||
          seen.has(row.id) ||
          (row.account_id !== undefined && row.account_id !== c.account)
        )
          refuse('REPORT_ACCOUNT_MISMATCH', 'X returned a foreign, repeated or malformed native entity.');
        seen.add(row.id);
        rows.push(row);
        if (rows.length > populationRows)
          refuse(
            'REPORT_COLLECTION_LIMIT',
            'This X account has more than 10,000 {kind}, the most a report reads. A scope applies after the account is read in full, so it cannot bring this read under that bound.',
            422,
            values,
          );
      }
      const next = response.next_cursor;
      if (next === null || next === '') return rows;
      // `with_total_count` cannot be combined with a cursor (X's documentation), so a page cannot be checked against a
      // declared total; the list is complete only when X ends it.
      if (typeof next !== 'string' || next.length > 2000 || /[\x00-\x1f\x7f]/.test(next))
        refuse(
          'REPORT_INCOMPLETE',
          'X returned a continuation cursor AMCP cannot use while listing {kind}, so the list cannot be proven complete.',
          502,
          values,
        );
      if (!response.data.length)
        refuse(
          'REPORT_INCOMPLETE',
          'X returned an empty page with a continuation while listing {kind}, so the list cannot be proven complete.',
          502,
          values,
        );
      if (cursors.has(next))
        refuse(
          'REPORT_INCOMPLETE',
          'X repeated a continuation cursor while listing {kind}, so the list cannot be proven complete.',
          502,
          values,
        );
      if (page === populationPages)
        refuse(
          'REPORT_INCOMPLETE',
          'X listed {kind} over more than 100 pages, the most a report reads, so the list cannot be proven complete.',
          502,
          values,
        );
      cursors.add(next);
      cursor = next;
    }
    return rows;
  };
  if (state) {
    if (state.authorization !== authorization)
      refuse('CONNECTION_AUTHORITY_CHANGED', 'The X login or permissions changed. Start a new report.', 403);
    if (
      state.version !== 1 ||
      state.definition !== definition ||
      !Array.isArray(state.campaigns) ||
      !Array.isArray(state.line_items) ||
      !Array.isArray(state.promoted_tweets) ||
      !Array.isArray(state.lineage)
    )
      refuse('REPORT_DEFINITION_CHANGED', 'The X checkpoint does not match this frozen report. Start a new run.', 409);
    state = structuredClone(state);
  } else {
    const start = c.lineage.length,
      campaigns = await list('campaigns'),
      line_items = await list('line_items'),
      promoted_tweets = needPromoted ? await list('promoted_tweets') : [];
    state = {
      version: 1,
      definition,
      authorization,
      campaigns,
      line_items,
      promoted_tweets,
      lineage: c.lineage.slice(start),
      observed_at: Date.now(),
    };
  }
  const owned = (rows: unknown): JsonObject[] => {
    if (!Array.isArray(rows) || rows.length > 10000)
      refuse('REPORT_DEFINITION_CHANGED', 'The X checkpoint does not match this frozen report. Start a new run.', 409);
    const seen = new Set<string>();
    for (const row of rows) {
      if (
        !object(row) ||
        !id(row.id) ||
        seen.has(row.id) ||
        (row.account_id !== undefined && row.account_id !== c.account)
      )
        refuse('REPORT_ACCOUNT_MISMATCH', 'X returned a foreign, repeated or malformed native entity.');
      if (
        (row.currency !== undefined && c.currency && row.currency !== c.currency) ||
        (row.deleted !== undefined && typeof row.deleted !== 'boolean')
      )
        refuse(
          'REPORT_SHAPE_CHANGED',
          'X native entity currency or deleted status does not match the selected account.',
        );
      seen.add(row.id);
    }
    return rows;
  };
  const campaigns = new Map(owned(state.campaigns).map(row => [row.id, row])),
    lines = new Map(owned(state.line_items).map(row => [row.id, row])),
    promoted = owned(state.promoted_tweets);
  for (const line of lines.values())
    if (
      !id(line.campaign_id) ||
      !campaigns.has(line.campaign_id) ||
      (line.objective != null && (typeof line.objective !== 'string' || !/^[A-Z][A-Z_]{0,63}$/.test(line.objective)))
    )
      refuse('REPORT_ACCOUNT_MISMATCH', 'X detailed entities did not retain exact owned native parents.');
  for (const tweet of promoted)
    if (!id(tweet.line_item_id) || !lines.has(tweet.line_item_id))
      refuse('REPORT_ACCOUNT_MISMATCH', 'X detailed entities did not retain exact owned native parents.');
    else if (
      tweet.tweet_id !== undefined &&
      !(typeof tweet.tweet_id === 'string' && /^[1-9][0-9]{0,31}$/.test(tweet.tweet_id))
    )
      refuse('REPORT_SHAPE_CHANGED', 'X returned an unsafe native tweet identity.');
  const inventory = c.detail === 'ad' ? promoted : [...lines.values()],
    selectedAds = new Set<string>(c.source.ad_ids ?? []),
    selectedLines = new Set<string>(c.source.adset_ids ?? []),
    selectedCampaigns = new Set<string>(c.source.campaign_ids ?? []),
    // The population is proven complete above, so a requested ID that is in none of it is known to match nothing.
    promotedIds = new Set(promoted.map(row => row.id)),
    unmatched = {
      campaign_ids: [...selectedCampaigns].filter(value => !campaigns.has(value)),
      adset_ids: [...selectedLines].filter(value => !lines.has(value)),
      ad_ids: [...selectedAds].filter(value => !promotedIds.has(value)),
    },
    unmatchedCount = unmatched.campaign_ids.length + unmatched.adset_ids.length + unmatched.ad_ids.length,
    adParents = new Set(promoted.filter(row => selectedAds.has(row.id)).map(row => row.line_item_id)),
    selected = inventory.filter(row => {
      const line = c.detail === 'ad' ? lines.get(row.line_item_id)! : row;
      return (
        (!selectedCampaigns.size || selectedCampaigns.has(line.campaign_id)) &&
        (!selectedLines.size || selectedLines.has(line.id)) &&
        (!selectedAds.size || (c.detail === 'ad' ? selectedAds.has(row.id) : adParents.has(row.id)))
      );
    }),
    selectedIds = new Set(selected.map(row => row.id)),
    start = zonedMidnight(c.range.since, c.timezone!),
    end = zonedMidnight(nextDay(c.range.until), c.timezone!);
  save();
  let active = xActiveSet(state.active),
    fallback = state.active_fallback === true;
  if (mode !== 'off' && !active && !fallback)
    try {
      active = await xActiveEntities(
        start,
        end,
        query => c.run(c.plan('/12/stats/accounts/' + c.account + '/active_entities', query), false, 'active_entities'),
        entity,
      );
      const population = new Set(inventory.map(row => row.id));
      if (active.entities.some(row => !population.has(row.entity_id)))
        refuse('REPORT_SCOPE_MISMATCH', 'X active detail IDs are missing from the complete native entity population.');
      active = {
        ...active,
        entities: active.entities.filter(row => selectedIds.has(row.entity_id)),
        fingerprint: fingerprint({population: active.fingerprint, definition, selected: [...selectedIds]}),
      };
      state.active = active;
    } catch (error) {
      if (!xRefusedRead(error)) throw error;
      state.active_fallback = fallback = true;
    }
  if (active?.entities.some(row => !selectedIds.has(row.entity_id)))
    refuse('REPORT_DEFINITION_CHANGED', 'The X checkpoint does not match this frozen report. Start a new run.', 409);
  save();
  if (fallback)
    c.warnings.push(
      'X refused the active-entities read; every scoped entity was requested instead (at most 100 analytics requests).',
    );
  const report = await xCampaignReport(
    selected,
    start,
    end,
    [...new Set(['VIDEO', ...c.extra])],
    async query => {
      current();
      const response = await c.run(c.plan('/12/stats/accounts/' + c.account, query), false);
      current();
      if (response.request?.params?.account_id !== undefined && response.request.params.account_id !== c.account)
        refuse('REPORT_ACCOUNT_MISMATCH', 'X analytics returned another account.');
      return response;
    },
    {
      entity,
      exact: true,
      checkpoint: state.report,
      ...(active ? {active, windows: mode === 'on'} : {}),
      save: report => {
        state.report = report;
        save();
      },
    },
  );
  current();
  const parents: Record<string, JsonObject> = {},
    selectedById = new Map(selected.map(row => [row.id, row]));
  c.raw = report.rows.map(row => {
    const metadata = selectedById.get(row.id);
    if (!metadata)
      refuse('REPORT_SCOPE_MISMATCH', 'X active detail IDs are missing from the complete native entity population.');
    const line = c.detail === 'ad' ? lines.get(metadata.line_item_id)! : metadata,
      campaign = campaigns.get(line.campaign_id)!;
    parents[row.id] = {
      campaign_id: campaign.id,
      campaign_name: campaign.name ?? null,
      ...(c.detail === 'ad' ? {adset_id: line.id, adset_name: line.name ?? null} : {}),
      objective: line.objective ?? null,
      entity_metadata: metadata,
    };
    return {...row, entity_metadata: metadata, objective: line.objective ?? null};
  });
  c.detailRows = {
    parents,
    rows: c.raw.map(row => ({
      entity_id: row.id,
      // X documents no name for a promoted tweet, so it is labelled by its promotion ID.
      entity_name: row.name ?? (c.detail === 'ad' ? 'Promoted tweet ' + row.id : null),
      spend: nativeDecimal(row.native_metrics.billed_charge_local_micro, 'spend', c.detailRounding, 1e6),
      impressions: nativeDecimal(row.native_metrics.impressions, 'impressions', c.detailRounding),
      clicks: nativeDecimal(row.native_metrics.clicks, 'clicks', c.detailRounding),
      conversions: null,
      conversion_value: null,
      reach: null,
      frequency: null,
      additional_metrics: {
        engagements: nativeDecimal(row.native_metrics.engagements, 'engagements', c.detailRounding),
        video_views: nativeDecimal(row.native_metrics.video_total_views, 'video_views', c.detailRounding),
      },
      omitted_as_zero: Object.entries({
        spend: 'billed_charge_local_micro',
        impressions: 'impressions',
        clicks: 'clicks',
      })
        .filter(([, field]) => row.provider_omitted?.includes(field))
        .map(([key]) => key),
    })),
  };
  c.complete = c.collectionComplete = report.complete;
  c.warnings.push(...report.warnings);
  if (unmatchedCount) c.warnings.push(unmatchedScopeWarning(unmatchedCount));
  c.context.no_activity_count = report.no_activity_count;
  c.context.native_population = {
    campaigns: campaigns.size,
    line_items: lines.size,
    promoted_tweets: promoted.length,
    selected: selected.length,
    includes_deleted: true,
    observed_at: state.observed_at,
    unmatched,
    unmatched_count: unmatchedCount,
  };
  const lineage = [...state.lineage.map((entry: JsonObject) => ({...entry, cached: true})), ...c.lineage];
  c.lineage.splice(
    0,
    c.lineage.length,
    ...new Map(lineage.map(entry => [fingerprint({...entry, cached: undefined}), entry])).values(),
  );
}
