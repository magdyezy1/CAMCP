import {MirrorError} from './errors.js';
import {fingerprint, reportContractVersion} from './report-quality.js';
import {collectionCheckpoint} from './report-collection-budget.js';
import {
  assertSnapchatReportMetadata,
  snapchatDailyRange,
  snapchatNextCursor,
  snapchatReportId,
} from './snapchat-evidence.js';
import type {ReportCollection} from './report-source.js';
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

/** Complete bounded account inventory, then the existing qualified daily collector for each owned parent. */
export async function collectSnapchatOverviewDetail(
  c: ReportCollection,
  collect: (parent?: string) => Promise<JsonObject>,
) {
  if (c.detail !== 'adset' || c.source.campaign_id) return collect();
  const options = c.source.report_options,
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
  snapchatDailyRange(
    {date_from: c.range.since, date_to: c.range.until, timezone: c.timezone, complete: declaration === true},
    true,
  );
  let state: JsonObject | undefined = c.checkpoint.snapchat_squads_v1;
  const persist = () => c.save({...c.checkpoint, snapchat_squads_v1: state});
  const populationPath = '/v1/adaccounts/' + c.account + '/campaigns',
    query = {limit: 100, read_deleted_entities: true};
  if (state) {
    if (state.authorization !== authorization)
      refuse('CONNECTION_AUTHORITY_CHANGED', 'The Snapchat login or permissions changed. Capture a new report.', 403);
    if (
      state.version !== 1 ||
      state.definition !== definition ||
      !Array.isArray(state.campaigns) ||
      !Array.isArray(state.parts) ||
      !Array.isArray(state.population_lineage) ||
      state.campaigns.length > 10000 ||
      state.parts.length > state.campaigns.length
    )
      changed();
    state = structuredClone(state);
  } else {
    const campaigns: JsonObject[] = [],
      seen = new Set<string>(),
      cursors = new Set<string>(),
      start = c.lineage.length;
    let cursor: string | undefined;
    for (let page = 1; page <= 100; page++) {
      current();
      const data = await c.run(
        c.plan(populationPath, {...query, ...(cursor ? {cursor} : {})}),
        false,
        'parent_population',
      );
      current();
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
      if (!data.campaigns.length || cursors.has(next) || page === 100)
        refuse('REPORT_INCOMPLETE', 'Snapchat parent lookup repeated or exceeded its bounded account collection.');
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
  const scoped = new Set<string>(c.source.campaign_ids ?? []),
    selected = (state.campaigns as JsonObject[]).filter(campaign => !scoped.size || scoped.has(campaign.id)),
    parts: JsonObject[] = state.parts;
  if (
    parts.length > selected.length ||
    parts.some((part, index) => part.campaign_id !== selected[index]?.id || !object(part.result))
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
    if (count > 10000)
      refuse('REPORT_COLLECTION_LIMIT', 'Narrow the Snapchat evidence to at most 10000 daily rows.', 422);
    return count;
  };
  checkRows();
  for (const campaign of selected.slice(parts.length)) {
    current();
    parts.push({campaign_id: campaign.id, result: await collect(campaign.id)});
    current();
    checkRows();
    persist();
  }
  // Even an empty inventory must finish inside the same current account/authority bracket.
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
      native_daily_rows: checkRows(),
      includes_deleted: true,
      complete: true,
      observed_at: state.scanned_at,
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
    collection_complete: results.every(result => result.collection_complete === true),
    complete: declaration === true && results.every(result => result.complete === true),
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
