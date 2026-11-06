import {MirrorError} from './errors.js';
import {fingerprint, reportContractVersion} from './report-quality.js';
import {collectionAllowance, collectionAllowanceEnded, collectionCheckpoint} from './report-collection-budget.js';
import {
  assertSnapchatReportMetadata,
  snapchatDailyRange,
  snapchatNextCursor,
  snapchatReportId,
} from './snapchat-evidence.js';
import {mergeCaptures, windowSpans} from './overview-detail-spans.js';
import {unmatchedScopeWarning, type DetailCollector, type ReportCollection} from './report-source.js';
import type {JsonObject} from './types.js';
import {storedLogin} from './connection-authority.js';
import {snapchatScope} from './provider-grants.js';

const success = (value: unknown) => typeof value === 'string' && value.toUpperCase() === 'SUCCESS';
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
function refuse(code: string, message: string, status = 502): never {
  throw new MirrorError(code, message, {}, status);
}
const changed = (): never =>
  refuse('REPORT_DEFINITION_CHANGED', 'Collection counters belong to another report definition.', 409);

/** What one source reads of an account, stated in its quality so a refusal at a bound means what it says. */
export const snapchatDetailBounds = Object.freeze({
  campaign_pages: 100,
  campaign_page_size: 100,
  native_daily_rows: 10000,
  days_per_read: 31,
});
/** Campaigns whose stats are read before the native parents of their ad squads are read together, once for the batch. */
export const snapchatCampaignsPerBatch = 50;
/** Captured campaigns are saved this often, and when a batch fails, so a retry does not repeat them. */
const capturesPerSave = 10;
/**
 * The provider requests of one period at the ad squad level: the pages of the campaign list, one stats read per campaign
 * and span, the parents of each batch (the ad squads, then their campaigns) and the closing read of the account.
 */
export const snapchatDetailRequests = (campaigns: number, spans: number, pages = 1) =>
  pages + campaigns * spans + 2 * Math.ceil(campaigns / snapchatCampaignsPerBatch) + 1;
/** The provider requests of one period at the ad level: per span the stats and two account reads, then the parents. */
export const snapchatAdRequests = (spans: number) => 3 * spans + 3;
/** Shown when the whole-job allowance ended before every selected campaign was read. */
export const snapchatAllowanceWarning = (read: number, total: number) =>
  read +
  ' of ' +
  total +
  ' campaigns read. The collection allowance for this report ended, so the other campaigns are not in it; the campaigns that were read are kept. Scope the report by campaign IDs to read the rest.';

/**
 * The ad squad level across all campaigns of the account (V2-RPT-07): the complete campaign population, proven once, then
 * the qualified daily stats of each campaign, read in batches whose ad squads' parents are read together. Windows over 31
 * days are read in spans whose daily rows add. A whole-job allowance that ends part-way keeps the campaigns already read
 * and says how many were.
 */
export async function collectSnapchatOverviewDetail(c: ReportCollection, detail: DetailCollector) {
  if (c.source.campaign_id) return detail();
  const spans = windowSpans(c.range, snapchatDetailBounds.days_per_read);
  if (c.detail === 'ad') return spans.length === 1 ? detail() : collectAdSpans(c, detail, spans);
  if (c.detail !== 'adset') return detail();
  const lookup = c.lookup ?? {},
    options = c.source.report_options,
    declaration = options.complete_window,
    definition = fingerprint({
      version: 1,
      source: c.source,
      range: c.range,
      currency: c.currency,
      timezone: c.timezone,
    });
  const authority = () => {
    c.store.assertActorActive(c.actor);
    const connection = c.store.resolveConnection(c.actor, 'snapchat_native_action', c.account, c.connection);
    if (!connection.scopes.includes(snapchatScope))
      refuse('INSUFFICIENT_SCOPE', 'This login requires Snapchat Marketing API permission.', 403);
    return fingerprint({login: storedLogin(c.store, connection), scopes: [...connection.scopes].sort()});
  };
  const authorization = authority(),
    current = () => {
      collectionCheckpoint();
      if (authority() !== authorization)
        refuse('CONNECTION_AUTHORITY_CHANGED', 'The Snapchat login or permissions changed. Capture a new report.', 403);
    };
  for (const span of spans)
    snapchatDailyRange(
      {date_from: span.since, date_to: span.until, timezone: c.timezone, complete: declaration === true},
      true,
    );
  let state: JsonObject | undefined = c.checkpoint.snapchat_squads_v1,
    pagesRead = 0;
  const persist = () => c.save({...c.checkpoint, snapchat_squads_v1: state});
  const populationPath = '/v1/adaccounts/' + c.account + '/campaigns',
    query = {limit: snapchatDetailBounds.campaign_page_size, read_deleted_entities: true};
  if (state) {
    if (state.authorization !== authorization)
      refuse('CONNECTION_AUTHORITY_CHANGED', 'The Snapchat login or permissions changed. Capture a new report.', 403);
    if (
      state.version !== 1 ||
      state.definition !== definition ||
      !Array.isArray(state.campaigns) ||
      !Array.isArray(state.parts) ||
      !Array.isArray(state.population_lineage) ||
      (state.captures !== undefined && !Array.isArray(state.captures)) ||
      state.campaigns.length > 10000 ||
      state.parts.length > state.campaigns.length
    )
      changed();
    state = structuredClone(state);
  } else {
    const proven = lookup.snapchatPopulation;
    if (proven && proven.authorization === authorization)
      // An earlier period of this job proved the population; it is not listed again.
      state = {
        version: 1,
        definition,
        authorization,
        campaigns: proven.campaigns,
        population_lineage: proven.lineage,
        parts: [],
        scanned_at: proven.scanned_at,
      };
    else {
      const campaigns: JsonObject[] = [],
        seen = new Set<string>(),
        cursors = new Set<string>(),
        start = c.lineage.length;
      let cursor: string | undefined;
      for (let page = 1; page <= snapchatDetailBounds.campaign_pages; page++) {
        current();
        const data = await c.run(
          c.plan(populationPath, {...query, ...(cursor ? {cursor} : {})}),
          false,
          'parent_population',
        );
        current();
        pagesRead++;
        assertSnapchatReportMetadata(data);
        if (!success(data.request_status) || !Array.isArray(data.campaigns) || data.campaigns.length > query.limit)
          refuse('REPORT_SHAPE_CHANGED', 'Snapchat did not return a bounded parent campaign collection.');
        for (const wrapped of data.campaigns as JsonObject[]) {
          if (!object(wrapped) || !success(wrapped.sub_request_status) || !object(wrapped.campaign))
            refuse('REPORT_INCOMPLETE', 'Snapchat returned failed or malformed parent campaign evidence.');
          assertSnapchatReportMetadata(wrapped);
          const campaign = wrapped.campaign;
          assertSnapchatReportMetadata(campaign);
          if (!snapchatReportId(campaign.id) || campaign.ad_account_id !== c.account || seen.has(campaign.id))
            refuse('REPORT_ACCOUNT_MISMATCH', 'Snapchat parent evidence has another account or malformed identity.');
          seen.add(campaign.id);
          campaigns.push(campaign);
        }
        const next = snapchatNextCursor(data, populationPath, query);
        if (next === undefined) break;
        if (!data.campaigns.length)
          refuse(
            'REPORT_INCOMPLETE',
            'Snapchat returned an empty page with a continuation while listing the campaigns of this account, so the list cannot be proven complete.',
          );
        if (cursors.has(next))
          refuse(
            'REPORT_INCOMPLETE',
            'Snapchat repeated a continuation cursor while listing the campaigns of this account, so the list cannot be proven complete.',
          );
        if (page === snapchatDetailBounds.campaign_pages)
          refuse(
            'REPORT_INCOMPLETE',
            'Snapchat listed the campaigns of this account over more than 100 pages, the most a report reads, so the list cannot be proven complete.',
          );
        cursors.add(next);
        cursor = next;
      }
      state = {
        version: 1,
        definition,
        authorization,
        campaigns,
        population_lineage: c.lineage.slice(start),
        parts: [],
        scanned_at: Date.now(),
      };
    }
    persist();
  }
  const seenCampaigns = new Set<string>();
  for (const campaign of state.campaigns as JsonObject[]) {
    if (
      !object(campaign) ||
      !snapchatReportId(campaign.id) ||
      campaign.ad_account_id !== c.account ||
      seenCampaigns.has(campaign.id)
    )
      changed();
    seenCampaigns.add(campaign.id);
  }
  // The proven population is kept for the job, and is what a campaign's stats are read under without reading it again.
  lookup.snapchatPopulation = {
    authorization,
    campaigns: state.campaigns,
    lineage: state.population_lineage,
    scanned_at: state.scanned_at,
    byId: new Map((state.campaigns as JsonObject[]).map(campaign => [campaign.id, campaign])),
  };
  const scoped = new Set<string>(c.source.campaign_ids ?? []),
    statuses: string[] = c.source.statuses ?? ['all'],
    archivedWanted = statuses.includes('all') || statuses.includes('archived'),
    named = (state.campaigns as JsonObject[]).filter(campaign => !scoped.size || scoped.has(campaign.id)),
    // Only a campaign the list shows as deleted is skipped, and only when the statuses cannot select archived rows. An
    // active or paused campaign never prunes its ad squads: a squad's status is its own (a paused campaign may hold an
    // active squad), so they are filtered by their own status after they are read.
    skipped = archivedWanted ? [] : named.filter(campaign => campaign.deleted === true),
    // Live campaigns are read first, so a collection allowance that ends early leaves the deleted ones unread.
    selected = named
      .filter(campaign => archivedWanted || campaign.deleted !== true)
      .sort((a, b) => Number(a.deleted === true) - Number(b.deleted === true)),
    unmatched = [...scoped].filter(id => !seenCampaigns.has(id)),
    parts: JsonObject[] = state.parts,
    captures: JsonObject[] = (state.captures ??= []);
  if (
    parts.length > selected.length ||
    parts.some((part, index) => part.campaign_id !== selected[index]?.id || !object(part.result)) ||
    captures.length > selected.length - parts.length ||
    captures.some((entry, index) => entry.campaign_id !== selected[parts.length + index]?.id || !object(entry.captured))
  )
    changed();
  const checkRows = () => {
    const identities = new Set<string>();
    let count = 0;
    for (const part of parts) {
      if (
        !Array.isArray(part.result.rows) ||
        part.result.currency !== c.currency ||
        part.result.timezone !== c.timezone ||
        fingerprint(part.result.date_range) !== fingerprint(c.range)
      )
        changed();
      for (const row of part.result.rows as JsonObject[]) {
        if (
          !snapchatReportId(row.entity_id) ||
          row.parent_ids?.campaign_id !== part.campaign_id ||
          identities.has(row.entity_id)
        )
          refuse('REPORT_ACCOUNT_MISMATCH', 'The detailed entity changed native parents during collection.');
        identities.add(row.entity_id);
        count += Array.isArray(row.native?.daily_rows) ? row.native.daily_rows.length : 1;
      }
    }
    if (count > snapchatDetailBounds.native_daily_rows)
      refuse('REPORT_COLLECTION_LIMIT', 'Narrow the Snapchat evidence to at most 10000 daily rows.', 422);
    return count;
  };
  checkRows();
  // Batches: the stats of up to 50 campaigns, then the native parents of all their ad squads in one read, then the rows.
  // Each batch is sized to the allowance that is left, so that an allowance that ends part-way ends between batches with
  // the closing account read still inside it. Reading more than one batch is the only reason the population is kept.
  let stopped: {dimension: unknown} | undefined;
  while (parts.length < selected.length) {
    const pending = selected.slice(parts.length),
      want = Math.min(pending.length, snapchatCampaignsPerBatch),
      allowance = collectionAllowance()?.requests ?? Infinity,
      // Per campaign one read per span; for the batch its parents (at most the ad squads and their campaigns) and the
      // account read that closes the collection.
      affordable = Math.floor((allowance - 1 - 2) / spans.length),
      size = captures.length + Math.max(0, Math.min(want - captures.length, affordable));
    if (!size) {
      // Nothing left to read a campaign with. With nothing read at all, the read itself raises the real limit error.
      if (parts.length) {
        stopped = {dimension: 'requests'};
        break;
      }
    }
    const batch = pending.slice(0, size || 1);
    try {
      for (let index = captures.length; index < batch.length; index++) {
        current();
        const spanned: JsonObject[] = [];
        for (const span of spans) spanned.push(await detail.capture(batch[index]!.id, span, lookup));
        current();
        captures.push({campaign_id: batch[index]!.id, captured: mergeCaptures(spanned, c.range)});
        if (captures.length % capturesPerSave === 0) persist();
      }
      const read = await detail.parents(
        captures.map(entry => entry.captured),
        lookup,
      );
      current();
      // The reads of the batch's parents are lineage of its first campaign only (not of every result it holds), and only
      // the reads this batch made: an earlier batch's are already in its own result.
      const fresh = read.lineage.filter(entry => entry.cached !== true),
        assembled = captures.map((entry, index) => ({
          campaign_id: entry.campaign_id,
          result: detail.assemble(entry.campaign_id, entry.captured, {
            parents: read.parents,
            lineage: index ? [] : fresh,
            warnings: index ? [] : read.warnings,
          }),
        }));
      parts.push(...assembled);
      captures.length = 0;
    } catch (error) {
      // What was captured is kept, so a retry does not repeat it; and a collection allowance that ends after at least one
      // campaign is finished ends the collection there instead of failing it.
      persist();
      if (!collectionAllowanceEnded(error) || !parts.length) throw error;
      stopped = {dimension: error.details.dimension};
      break;
    }
    checkRows();
    persist();
  }
  // Even an empty inventory must finish inside the same current account/authority bracket.
  let verifiedAfter = true;
  try {
    current();
    const verified = await c.run(c.plan('/v1/adaccounts/' + c.account), false, 'account_verify');
    current();
    assertSnapchatReportMetadata(verified);
    if (
      !success(verified.request_status) ||
      !Array.isArray(verified.adaccounts) ||
      verified.adaccounts.length !== 1 ||
      !object(verified.adaccounts[0]) ||
      !success(verified.adaccounts[0].sub_request_status) ||
      !object(verified.adaccounts[0].adaccount) ||
      verified.adaccounts[0].adaccount.id !== c.account
    )
      refuse('REPORT_ACCOUNT_MISMATCH', 'Snapchat did not return the exact selected account.');
    assertSnapchatReportMetadata(verified.adaccounts[0]);
    assertSnapchatReportMetadata(verified.adaccounts[0].adaccount);
    if (verified.adaccounts[0].adaccount.currency !== c.currency)
      refuse('REPORT_CURRENCY_MISMATCH', 'The declared currency does not match the Snapchat account.');
    if (verified.adaccounts[0].adaccount.timezone !== c.timezone)
      refuse('REPORT_TIMEZONE_MISMATCH', 'The declared timezone does not match the Snapchat account.');
    current();
  } catch (error) {
    // An allowance that already ended the collection cannot pay for the closing read; the result says it was not made.
    if (!stopped || !collectionAllowanceEnded(error)) throw error;
    verifiedAfter = false;
  }
  const results: JsonObject[] = parts.map(part => part.result),
    warnings = [
      ...new Set([
        ...results.flatMap(result => result.warnings ?? []),
        ...(!results.length && declaration !== true
          ? [
              declaration === false
                ? 'The reporting window was declared incomplete. The source stays partial and recommendations are held until a complete window is collected.'
                : 'The reporting window was not declared complete. Results remain partial and recommendations are withheld.',
            ]
          : []),
        ...(unmatched.length ? [unmatchedScopeWarning(unmatched.length)] : []),
        ...(stopped ? [snapchatAllowanceWarning(parts.length, selected.length)] : []),
      ]),
    ],
    lineage = [
      ...state.population_lineage.map((entry: JsonObject) => ({...entry, cached: true})),
      ...results.flatMap(result => result.lineage ?? []),
      ...c.lineage,
    ],
    uniqueLineage = [...new Map(lineage.map(entry => [fingerprint({...entry, cached: undefined}), entry])).values()],
    first = results[0],
    attribution =
      'Snapchat ' +
      options.swipe_up_attribution_window +
      ' swipe / ' +
      options.view_attribution_window +
      ' view; conversion time; total sources',
    population = {
      campaigns_observed: state.campaigns.length,
      campaigns_selected: selected.length,
      campaigns_collected: parts.length,
      campaigns_skipped_deleted: skipped.length,
      native_daily_rows: checkRows(),
      includes_deleted: true,
      complete: true,
      collection_complete: !stopped,
      account_verified_after: verifiedAfter,
      observed_at: state.scanned_at,
      // The figure for this period once the population is known (the queue-time one is a lower bound without a scope).
      requests_estimated: snapchatDetailRequests(selected.length, spans.length, pagesRead),
      spans: spans.length,
      unmatched: {campaign_ids: unmatched},
      unmatched_count: unmatched.length,
      bounds: snapchatDetailBounds,
      ...(stopped
        ? {stopped: {campaigns_read: parts.length, campaigns_selected: selected.length, dimension: stopped.dimension}}
        : {}),
    };
  return {
    ...(first ?? {
      contract_version: reportContractVersion,
      detail_contract: 'overview-detail-v4',
      source_kind: 'paid',
      metadata: c.metadata,
      account_name: c.metadata.name ?? null,
      currency: c.currency,
      timezone: c.timezone,
      date_range: c.range,
      quality: {
        version: 1,
        pages_collected: true,
        measurement_complete: declaration === true,
        reporting_window_declared_complete: declaration,
        status: 'declared_measurement',
        entity_level: 'adset',
      },
      attribution,
      result_definition: 'conversion_purchases (total sources)',
    }),
    rows: results.flatMap(result => result.rows),
    collection_complete: !stopped && results.every(result => result.collection_complete === true),
    complete: declaration === true && !stopped && results.every(result => result.complete === true),
    quality: {
      ...(first?.quality ?? {
        version: 1,
        pages_collected: true,
        measurement_complete: declaration === true,
        reporting_window_declared_complete: declaration,
        status: 'declared_measurement',
        entity_level: 'adset',
      }),
      population,
    },
    lineage: uniqueLineage,
    query_fingerprint: fingerprint({
      population: {path: populationPath, query},
      source: c.source,
      range: c.range,
      parents: results.map(result => result.query_fingerprint),
    }),
    source_hash: fingerprint({population: state.campaigns, parts: results.map(result => result.source_hash)}),
    native_account_evidence: {
      account_id: c.account,
      currency: c.currency,
      timezone: c.timezone,
      checks: [
        ...uniqueLineage.filter(entry => ['account_lookup', 'account_verify'].includes(entry.stage)),
        ...results.flatMap(result => result.native_account_evidence?.checks ?? []),
      ],
      parent_campaigns: results.map(result => result.native_account_evidence?.parent_campaign).filter(Boolean),
      population,
    },
    warnings,
    captured_at: results.length ? Math.min(...results.map(result => result.captured_at)) : Date.now(),
  };
}

/**
 * The ad level reads the account's stats at once; a window over 31 days is read in spans, whose daily rows add exactly,
 * and the parents of the ads are read once for all of them.
 */
async function collectAdSpans(c: ReportCollection, detail: DetailCollector, spans: {since: string; until: string}[]) {
  const lookup = c.lookup ?? {},
    captures: JsonObject[] = [];
  for (const span of spans) captures.push(await detail.capture(undefined, span, lookup));
  const merged = mergeCaptures(captures, c.range);
  return detail.assemble(undefined, merged, await detail.parents([merged], lookup));
}
