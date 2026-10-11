import {randomUUID} from 'node:crypto';
import {
  searchExclusionCandidates,
  previewSearchExclusions,
  createSearchExclusionPlan,
} from './search-exclusion-plan.js';
import {Store} from './store.js';
import {accountMetadataStaleMs, recallAccountMetadata} from './account-metadata.js';
import type {Actor, JsonObject} from './types.js';
import {audit, bad, field, fingerprint, obj, pointer, read, tool, validate, type ToolCall} from './workspace-core.js';
import {metricNumber, reportPlatforms} from './report-metrics.js';
import {reportPresets, reportPreset, validatePresetRows} from './report-presets.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {reportScenarios} from './report-scenarios.js';
import {allocationCandidates, reportAllocation} from './report-allocation.js';
import {calibrateAllocation} from './allocation-calibration.js';
import {previewAllocationPlan, createAllocationPlan} from './allocation-plan.js';
import {linkedInReportDate} from './linkedin-reporting.js';
import {assertCompatibleBaseline, compareDeclaredReference, compareReportContext} from './report-references.js';
import {collectTikTokDailyReport, tiktokReportDate} from './tiktok-reporting.js';
import {
  collectGoogleReport,
  googleReportDevices,
  googleReportCountryId,
  googleReportLocationTypes,
  googleGeographicResource,
} from './google-reporting.js';
import {normalizeAccount} from './scope.js';
import {collectMetaEvidence} from './meta-evidence.js';
import {collectLinkedInEvidence} from './linkedin-evidence.js';
import {collectSnapchatEvidence} from './snapchat-evidence.js';
import {evidenceIndex} from './evidence-index.js';
import {googleServingDiagnostics} from './google-serving-diagnostics.js';
import {launchCheck} from './launch-check.js';
import {
  metricRoundingLimitation,
  metricRoundingRecord,
  parseProviderDecimal,
  providerDecimalText,
} from './provider-decimal.js';
const nativeDeviceMappingFailure = (message: string): never => bad(message, 'REPORT_SHAPE_CHANGED');
const nativeHourMappingFailure = (message: string): never => bad(message, 'REPORT_SHAPE_CHANGED');
const nativeCountryMappingFailure = (message: string): never => bad(message, 'REPORT_SHAPE_CHANGED');
/** RPT-04: analyze against a baseline whose window is not declared complete. */
const baselineIncompleteLimitation =
  'The baseline window is not declared complete; comparisons with it (spend anomaly, creative fatigue) may reflect missing baseline data.';
export const decisionTool = tool(
  'amcp_reporting',
  'Use this to analyse metrics captured from native reports: reconciliation, comparisons and recommendations. For saved client reports across platforms, schedules and Sheets exports, use amcp_reporting_overview. Capture source-linked native metrics; reconcile totals with an explicitly labeled reference; compare compatible reports and generate evidence-based pacing, anomaly, fatigue and search-waste recommendations. Search waste: capture a search-terms read whose mapping names search_term, clicks, spend and conversions, then analyze {id, options: {minimum_clicks}}; amcp://guides/workspace shows the Google request. capture_presets discovers Google, Meta, LinkedIn, TikTok and Snapchat detailed reports; with connection_id and account_id it also returns the stored currency, timezone and read time of that account (target), without a provider read. Snapchat campaign/ad presets and the campaign-scoped adsquad preset require explicit swipe_up_attribution_window (1_DAY, 7_DAY or 28_DAY) and view_attribution_window (none, 1_HOUR, 3_HOUR, 6_HOUR, 1_DAY or 7_DAY); seven-day view needs at least seven-day swipe. They retain conversion_purchases from total sources with conversion-time reporting, exact spend micros and swipes as clicks. Require 1–31 closed account-local days, whole-hour midnight boundaries and complete:true. Both account checks and every bounded page keep source references. Native delivery and conversion processing timestamps must cover the requested end; duplicate entities, missing days, foreign cursors, changed settings or authorization are refused. Ad-squad evidence requires campaign_id, reads its account collection and exact parent before and after complete campaign stats pages, retains parent source references, and refuses reconciliation across different parents. Native lead presets snapchat_campaign_leads, snapchat_adsquad_leads and snapchat_ad_leads retain native_leads submitted-form counts without submitted lead records or purchase attribution-window controls. They require finalized_data_end_time for each complete daily page; conversion-processing timestamps do not establish these native counts. Lead ad-squad/ad presets require the exact owned campaign_id before and after collection. Original purchase presets remain unchanged. No conversion-value or historical creative-assignment claim. Google guided presets verify exact customer identity, currency and timezone before and after complete bounded Search pages, retain account/page source hashes, and reject mismatched counts, dates, native resources or duplicate grain. Ads use ad-group-ad resource names as entity_id; search terms use search-term-view resource names, preserving native parents. google_keyword retains positive Search keyword × day evidence from keyword_view with exact criterion/view resources, original keyword text as entity_name and optional keyword_match_type (EXACT, PHRASE or BROAD). False negative flags may be omitted under ProtoJSON defaults; malformed, foreign, negative or changed immutable keyword metadata is refused before persistence. The preset does not qualify search-exclusion or budget writes. Custom keyword_match_type mapping requires a plain field pointer and a literal supported native enum; old mappings/rows remain unchanged. google_campaign_device retains campaign × native device × day evidence from campaign, with full campaign resource identities and no device/status filtering. native_device preserves one of UNSPECIFIED, UNKNOWN, MOBILE, TABLET, DESKTOP, CONNECTED_TV or OTHER using a plain mapped pointer; missing categories do not establish zero activity. This separate grain does not qualify device bids, campaign budgets or search exclusions. google_campaign_country retains campaign × native country × native location type × day from geographic_view, with original nonnegative int64 country strings, literal UNSPECIFIED/UNKNOWN/AREA_OF_INTEREST/LOCATION_OF_PRESENCE and full geographic resource identities. Presence and interest stay distinct; IDs are not inferred country names and absent countries do not establish zero activity. Geographic mappings require unmodified pointers and matching native identity. This grain does not qualify geographic targeting, campaign budgets or search exclusions. Campaign and ad group IDs stay numeric strings. Conversions use metrics.conversions; attribution windows and period completeness remain declared. search_term_view excludes Performance Max. Older retained reports are unchanged and incompatible native mappings/grains cannot be reconciled. TikTok campaign, adgroup and ad presets use BASIC auction daily reporting. They verify advertiser currency and timezone before and after complete native pages; require 1–31 closed days and complete:true; retain native string IDs, exact decimals and per-page request hashes; reject changed totals or duplicate entity/day rows; and bound collections to 10000 rows. The native conversion metric follows each entity optimization goal, which can differ; attribution windows remain declared. Smart+, GMV Max and specialized reports are separate. LinkedIn campaign_group, campaign and creative presets verify exact account identity and currency before and after one complete bounded analytics response under unchanged credentials/scopes, require UTC and use the exact externalWebsiteConversions metric. Both account checks and the original analytics response keep source references; no continuation is invented. They require declared attribution windows (or unknown), reject ambiguous empty/truncated reports and retain native URNs. Daily dates are limited conservatively to the current month and previous five months. This reporting endpoint has no pagination. Meta capture_preset requires an exact result_action_type and explicit attribution_windows; its attribution and result definitions come from the generated request. It verifies exact native account identity, currency and timezone before and after complete Insights pages, including empty reports; retains account/page request hashes; checks parent/day grain and unchanged credentials/scopes around each read; and follows only bounded native cursors on the original account/query. On a delivered row (impressions above 0) an absent selected action counts as 0 and is named in omitted_as_zero; without delivery it stays unknown. Aliases are never added. calibrate_allocation diagnoses retained daily efficiency using id, 1–20 exact entity ids and options {training_days:7–21 (default 7), minimum_training_conversions:1–1000000 (default 10), maximum_age_days:1–90 (default 7), central_share_percent:50|60|70|80|90 (default 80)}. Requires 14–31 closed consecutive days with an explicit known spend/conversion row for every selected entity/day and at least seven test days after training. Each one-day estimate uses only the selected preceding training window, conditioned on actual test-day spend. Exact rational errors, empirical nearest-rank factor bands and an optional outward-rounded envelope remain inspectable. Unknown/zero expected ratios and factors outside allocation limits are never clipped or automatically applied. This diagnoses historical assumptions; it is not a delivery forecast, future coverage guarantee or causal budget response and makes no provider read, saved change or native plan. allocation_candidates pages selected unit totals from a guided Google/Meta/LinkedIn campaign/day or parent-bound Snapchat ad-squad/day report with offset/limit. allocation models a comparable-period budget using options {budget, allocations:[{entity_id,minimum,maximum}], efficiency_low, efficiency_high, minimum_conversions, maximum_age_days}; select 2–50 native campaigns or ad squads from the same report scope. It requires recent complete evidence and exact feasible floors/caps; it is a linear sensitivity proposal, not a forecast, native daily budget or approval. preview_allocation_plan takes report id, the same allocation options and explicit conversion equal_daily; it reads current dedicated Google campaign daily budgets, independent LinkedIn campaign daily budgets or Snapchat ad-squad daily budgets and shows exact native amounts and rounding residuals. LinkedIn selects at most 20 original campaign URNs, requires verified UTC analytics and account currency, current reporting/write scopes and account write grant, brackets campaign/group/account evidence, refuses shared/lifetime/accelerated modes, and emits native decimal dailyBudget amounts through the existing REST.li PARTIAL_UPDATE review. Daily settings may spend up to 150% on a day with strong auction opportunities; existing group caps remain unchanged. Snapchat requires exact retained parent evidence, positive account-edge ownership, current account/parent checks and owned auction ad-squad pacing; it refuses lifetime, reserved and Smart Budgets. Every native read retains request/hash/time; one shared reference array avoids duplication across targets. create_allocation_plan requires that report id, preview_id, preview_hash and confirmed:true within the current session and ten-minute preview. It saves an unapproved source-bound campaign draft, not an advertising change. Current ownership/source checks precede unsent plan steps, and native review, spending acknowledgement and read-back remain separate. Other providers, shared/lifetime/reserved/Smart Budgets and automatic end dates are unqualified. reconcile_report compares id against reference_id using retained guided presets or the same Overview definition/group; account, dates, currency, timezone, attribution, conversion definition, completeness and native grain must align. options.tolerance accepts additive metric decimals. It retains both source hashes, makes no new read and does not independently verify provider attribution. Legacy reconcile with manually supplied totals checks numerical agreement only. Optional reference.context explicitly declares gateway, account_id, currency, timezone, date_from, date_to, attribution, conversion_definition, grain, complete:true and same_entities_and_filters:true; all must match known guided or Overview evidence. It returns declared_reference with independently_verified:false. Optional reference.file metadata records a browser-parsed one-row CSV hash, bytes, encoding, delimiter, rows:1, number_format, selected columns and money_scales, never the original file. File hashes and declared source settings are not independently fetched or verified. list returns bounded source-linked metadata pages (default limit:30, maximum:100), not native rows/requests/page bodies. Continue only with next_cursor and the same search/gateway/connection/account/preset filters; account filtering requires gateway. Cursors expire after 15 minutes and bind current identity/session/role and connection read scope. Each returned item rechecks current access; at most 500 candidates are scanned per call, so an empty page with has_more is not a complete empty collection. search matches original report IDs, names, account IDs or presets case-insensitively. Nonzero offset is refused for list. get still inspects original complete bounded evidence and its source definitions. get accepts optional row_query (at most 150 plain-text characters) to search retained entity IDs/names, dates, search terms and explicitly mapped native keyword match types, devices, original hours, country criterion IDs, location types or geographic resources case-insensitively before offset/limit paging. row_count stays the full retained count; matched_row_count and row_query describe the filtered view. Totals, analysis, source hashes and Excel remain the complete original report; searching makes no provider call or saved change. get and capture results include xlsx_path for an authenticated website download of all retained mapped rows, exact totals, mappings and selected source references. Add ?language=en or ar explicitly; English is the default. Excel stores numeric metrics as text to preserve precision. Generation rechecks current account access and report revision, shares the bounded report artifact concurrency limit, and makes no provider call or retained binary. search_exclusion_candidates pages recent complete guided Google search-term evidence meeting options {minimum_clicks:1–1000000 (default 30),maximum_age_days:1–90 (default 7)}. Dates must be closed and recent in the account timezone, attribution declared and conversions exactly zero; missing metrics never qualify. Only 1–80 character, at most 10-word literal terms using Unicode letters, marks, digits, spaces and apostrophes qualify. preview_search_exclusions takes report id, 1–20 distinct entity resource ids in ids and the same options; it verifies current standard Search parents before and after a complete bounded exact-keyword read, rejecting existing positive/negative exact conflicts. Existing broader, campaign and shared exclusions remain unassessed. create_search_exclusion_plan needs preview_id and preview_hash from the same session and confirmed:true within ten minutes. It saves one unapproved exact negative-keyword step per selected term in the original ad group. Source revision, current access and native parent checks bind unsent steps; each still requires native review, spending acknowledgement and read-back. serving_diagnostics reads why Google entities serve or not, as Google reports it: account_id, connection_id, optional campaign_id and options {levels:[campaign|ad_group|ad|asset_group|asset_group_asset], limit:1–100 (default 50)}; one bounded page per level of primary_status, primary_status_reasons, policy approval/review status and topic types, ad_strength and action_items. Native symbols pass through unchanged and unknown_symbols lists any outside the pinned v25 enums; policy evidence and asset contents are not returned and nothing is saved. launch_check takes a completed guided Meta or Snapchat launch plan id and optional report_id (a retained campaign × day capture_preset of that account): native reads of the plan’s verified campaign, its ad set or ad squad and the account feed the rule-based campaign audit (budget, schedule, bid strategy, frequency, targeting) with explicit unknowns. Delivery is observed only from reported impressions; a paused campaign or a missing capture stays unknown, never a false alarm. Nothing is saved or changed. No advertising writes from reporting. Missing metrics stay unknown.',
  [
    'capture',
    'capture_presets',
    'capture_preset',
    'overview_sources',
    'capture_overview',
    'get',
    'list',
    'reconcile',
    'reconcile_report',
    'analyze',
    'combine',
    'scenarios',
    'allocation_candidates',
    'calibrate_allocation',
    'allocation',
    'preview_allocation_plan',
    'create_allocation_plan',
    'search_exclusion_candidates',
    'preview_search_exclusions',
    'create_search_exclusion_plan',
    'serving_diagnostics',
    'launch_check',
  ],
  {
    gateway: field.id,
    arguments: field.object,
    connection_id: field.id,
    account_id: field.id,
    campaign_id: field.id,
    rows_pointer: field.id,
    row_query: {type: 'string', maxLength: 150},
    search: {type: 'string', maxLength: 150},
    cursor: {type: 'string', maxLength: 32768},
    mapping: field.object,
    semantics: field.object,
    id: field.id,
    group_id: field.id,
    preset: field.id,
    result_action_type: field.id,
    attribution_windows: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
      items: {type: 'string', enum: ['1d_click', '7d_click', '1d_view']},
    },
    swipe_up_attribution_window: {type: 'string', enum: ['1_DAY', '7_DAY', '28_DAY']},
    view_attribution_window: {type: 'string', enum: ['none', '1_HOUR', '3_HOUR', '6_HOUR', '1_DAY', '7_DAY']},
    ids: {type: 'array', items: {type: 'string'}, minItems: 1, maxItems: 20},
    reference: field.object,
    reference_id: field.id,
    baseline_id: field.id,
    options: field.object,
    conversion: {type: 'string', enum: ['equal_daily']},
    preview_id: field.id,
    preview_hash: field.id,
    report_id: field.id,
    confirmed: field.bool,
    offset: field.integer,
    limit: {type: 'integer', minimum: 1, maximum: 100},
  },
);
/**
 * RPT-05: one capture target's stored account metadata from its last live account read, so the website can prefill the
 * native currency and time zone. Nothing is read from the provider; capture still verifies both before and after.
 */
function captureTarget(store: Store, actor: Actor, input: JsonObject) {
  const gateways = new Set(reportPresets.map(p => p.gateway)),
    accountId = String(input.account_id ?? ''),
    connection = store
      .listConnections(actor.tenantId)
      .find(
        c => c.enabled && c.id === input.connection_id && gateways.has(c.gateway) && c.accounts.includes(accountId),
      );
  if (!connection)
    bad('Choose an enabled reporting connection and one of its accounts.', 'CONNECTION_REQUIRED', {
      connection_id: input.connection_id ?? null,
      account_id: input.account_id ?? null,
    });
  // The same actor and connection authorization as a capture of this account.
  store.resolveConnection(actor, connection.gateway, accountId, connection.id);
  const meta = recallAccountMetadata(store, actor.tenantId, connection.id, accountId);
  return {
    gateway: connection.gateway,
    connection_id: connection.id,
    account_id: accountId,
    currency: meta?.currency ?? null,
    timezone: meta?.timezone ?? null,
    checked_at: meta ? new Date(meta.checked_at).toISOString() : null,
    stale: !meta || Date.now() - meta.checked_at > accountMetadataStaleMs,
  };
}
const metrics = ['spend', 'impressions', 'clicks', 'conversions', 'conversion_value', 'reach', 'frequency'];
const nonAdditive = ['reach', 'frequency'];
/** Caller-declared totals, tolerances and options keep the strict nine-place grammar; provider values use provider-decimal. */
const scaledDeclared = (s: unknown): bigint => {
  if (typeof s === 'number' && (!Number.isFinite(s) || Math.abs(s) > Number.MAX_SAFE_INTEGER))
    bad('Use a decimal string for large metrics.');
  if ((typeof s !== 'string' && typeof s !== 'number') || !/^\d+(?:\.\d{1,9})?$/.test(String(s)))
    bad('Metrics require nonnegative decimal values with up to 9 decimal places.');
  const [a, b = ''] = String(s).split('.');
  return BigInt(a!) * 1000000000n + BigInt(b.padEnd(9, '0'));
};
const decimal = (n: bigint) => {
  const sign = n < 0n ? '-' : '';
  n = n < 0n ? -n : n;
  return (
    sign +
    n / 1000000000n +
    (n % 1000000000n
      ? '.' +
        String(n % 1000000000n)
          .padStart(9, '0')
          .replace(/0+$/, '')
      : '')
  );
};
/**
 * Provider metric values: additive metrics keep nine decimal places, rounding half to even (owner decision D10) and
 * counting rounded rows per metric for semantics.metric_rounding. Reach and frequency are never summed, so they stay
 * exact display values. Malformed provider values are shape errors naming the field, not caller-input errors.
 */
function providerMetric(
  key: string,
  value: unknown,
  field: string,
  rounding: Record<string, number>,
  divisor?: unknown,
): string {
  if (nonAdditive.includes(key)) return providerDecimalText(value, {field, divisor});
  const parsed = parseProviderDecimal(value, {field, divisor});
  if (parsed.rounded) rounding[key] = (rounding[key] ?? 0) + 1;
  return decimal(parsed.scaled);
}
const ratio = (a: unknown, b: unknown, m = 1) =>
  a !== null && b !== null && Number(b) > 0 ? (Number(a) / Number(b)) * m : null;
function totals(rows: JsonObject[], mapping?: JsonObject) {
  return Object.fromEntries(
    metrics.map(k => [
      k,
      ['reach', 'frequency'].includes(k) ||
      (mapping && mapping[k] === undefined) ||
      (!rows.length && !mapping) ||
      rows.some(r => r[k] == null)
        ? null
        : decimal(rows.reduce((n, r) => n + scaledDeclared(r[k]), 0n)),
    ]),
  );
}
function partial(v: any): boolean {
  if (!obj(v)) return false;
  return (
    v.truncated === true ||
    v.has_more === true ||
    v.hasMore === true ||
    !!v.nextPageToken ||
    !!v.next_page_token ||
    !!v.next_cursor ||
    !!v.paging?.next ||
    !!v.paging?.next_link ||
    (!!v.paging?.cursors?.after && v.paging?.has_next_page === true) ||
    (!!v.page_info && Number(v.page_info.page) < Number(v.page_info.total_page)) ||
    partial(v.data)
  );
}
function grouped(rows: JsonObject[]): JsonObject[] {
  const groups = new Map<string, JsonObject[]>();
  for (const r of rows) {
    if (!r.entity_id) continue;
    const key = r.entity_id;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups].map(([id, rs]) => ({entity_id: id, ...totals(rs)}));
}
function semantic(input: JsonObject) {
  validate(
    input,
    ['currency', 'timezone', 'date_from', 'date_to', 'attribution', 'conversion_definition', 'source_name', 'complete'],
    undefined,
    'semantics field',
  );
  if (!/^[A-Z]{3}$/.test(input.currency) || typeof input.timezone !== 'string')
    bad('Declare the native currency and IANA timezone.');
  try {
    new Intl.DateTimeFormat('en', {timeZone: input.timezone});
  } catch {
    bad('Invalid timezone.');
  }
  for (const k of ['date_from', 'date_to'])
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input[k]) || new Date(input[k]).toISOString().slice(0, 10) !== input[k])
      bad('Declare valid report dates.');
  if (input.date_to < input.date_from) bad('Report dates must increase.');
  for (const k of ['attribution', 'conversion_definition', 'source_name'])
    if (typeof input[k] !== 'string' || !input[k].trim() || input[k].length > 200)
      bad('Declare ' + k + ' (use unknown when not established).');
  if (typeof input.complete !== 'boolean') bad('Declare whether the requested reporting window is complete.');
  return input;
}
function compatibility(a: JsonObject, b: JsonObject) {
  const fields = ['currency', 'timezone', 'attribution', 'conversion_definition'];
  const mismatch = fields.filter(
    k =>
      a.semantics[k] !== b.semantics[k] ||
      (['attribution', 'conversion_definition'].includes(k) && a.semantics[k] === 'unknown'),
  );
  if (mismatch.length) bad('Report semantics cannot be combined: ' + mismatch.join(', '), 'REPORT_SEMANTICS_MISMATCH');
}
export class DecisionReporting {
  constructor(
    private store: Store,
    private call: ToolCall,
    private createDraft?: (plan: JsonObject, actor: Actor) => Promise<JsonObject>,
    /** CMP-07: a campaign plan as amcp_campaign get returns it, under that tool's own access checks. */
    private readPlan?: (id: string, actor: Actor) => Promise<JsonObject>,
  ) {}
  /** Internal Overview collector: reuse the exact qualified preset without creating a second saved snapshot or budget. */
  async collectGuided(input: JsonObject, actor: Actor) {
    return this.handle({action: 'capture', ...reportPreset(input)}, actor, input.preset, true);
  }
  async handle(input: JsonObject, actor: Actor, capturePreset?: string, transient = false): Promise<JsonObject> {
    validate(input, Object.keys(decisionTool.inputSchema.properties));
    this.store.assertActorActive(actor);
    if (
      input.row_query !== undefined &&
      (input.action !== 'get' ||
        typeof input.row_query !== 'string' ||
        input.row_query.length > 150 ||
        /[\x00-\x1f\x7f]/.test(input.row_query))
    )
      bad('Retained row search is available on get and requires at most 150 plain-text characters.');
    if (input.action === 'capture_presets')
      return input.connection_id === undefined && input.account_id === undefined
        ? {presets: reportPresets}
        : {presets: reportPresets, target: captureTarget(this.store, actor, input)};
    // CMP-07: read-only serving diagnostics (Google) and the post-launch check of a guided Meta or Snapchat launch.
    if (input.action === 'serving_diagnostics') return googleServingDiagnostics(this.store, this.call, actor, input);
    if (input.action === 'launch_check') {
      if (!this.readPlan) bad('Launch checks need the campaign plan service.', 'LAUNCH_CHECK_UNSUPPORTED');
      return launchCheck(this.store, this.call, this.readPlan, actor, input);
    }
    if (input.action === 'capture_preset') {
      const request = reportPreset(input);
      let usage: JsonObject = {};
      const budget = new ReportCollectionBudget(
        undefined,
        fingerprint(request),
        v => {
          usage = v;
        },
        {requests: 120, rows: 10000, elapsed_ms: 120000, bytes: 32 * 1024 * 1024},
      );
      try {
        const result = await budget.run(() => this.handle({action: 'capture', ...request}, actor, input.preset));
        const provenance = {
          preset: input.preset,
          collection_usage: {requests: usage.requests, bytes: usage.bytes, elapsed_ms: usage.elapsed_ms},
          grain: reportPresets.find(p => p.id === input.preset)!.grain,
          ...(request.gateway === 'snapchat_native_action'
            ? {
                semantics_source:
                  request.arguments.query.fields === 'spend,impressions,swipes,native_leads'
                    ? 'Snapchat account identity, currency and timezone verified before and after complete daily pages. Native submitted-form counts use native_leads; every page confirms non-conversion metric finalization through the selected end. Swipes are clicks; spend is native micros. No submitted lead records are read. Collection is not a point-in-time snapshot; off-platform attribution, lead quality and measurement setup remain unverified.'
                    : 'Snapchat account identity, currency and timezone verified before and after complete daily pages. Explicit swipe/view windows, conversion-time reporting and total conversion sources come from the retained request; each page confirms delivery and conversion processing through the selected end. Swipes are clicks; spend is native micros. Collection is not a point-in-time snapshot or proof of measurement setup.',
              }
            : {}),
          ...(request.gateway === 'google_ads_native_action'
            ? {
                semantics_source:
                  'Google customer currency and timezone verified before and after complete Search pages; native resource identity, dates, result counts and unique grain checked; conversions use metrics.conversions. Attribution and reporting-window completeness remain declared, not independently verified. Collection is not a point-in-time snapshot.',
              }
            : {}),
          ...(request.gateway === 'meta_native_action'
            ? {
                semantics_source:
                  'Meta account currency and timezone verified before and after complete Insights pages; action/window/report-time settings come from the retained request, native account/parent/day grain is checked, and reporting-window completeness remains declared. Collection is not a point-in-time snapshot.',
              }
            : {}),
          ...(request.gateway === 'linkedin_native_action'
            ? {
                semantics_source:
                  'LinkedIn account identity and currency verified before and after a complete bounded analytics response with unchanged authorization; UTC dates and externalWebsiteConversions from the native request; attribution windows and completeness explicitly declared, not independently verified. Collection is not a point-in-time snapshot.',
              }
            : {}),
          ...(request.gateway === 'tiktok_native_action'
            ? {
                semantics_source:
                  'TikTok advertiser currency and timezone verified before and after complete native pages; native conversion refers to each entity optimization goal and goals may differ; attribution windows and completeness declared, not independently verified. Collection is not a point-in-time snapshot.',
              }
            : {}),
        };
        const saved = read(this.store, actor, 'decision_report', result.id);
        this.store.assertActorActive(actor);
        this.store.resolveConnection(actor, saved.gateway, saved.account_id, saved.connection_id);
        this.store.putDocument(actor.tenantId, 'decision_report', saved.id, {...saved, ...provenance});
        return {...result, ...provenance};
      } finally {
        budget.close();
      }
    }
    const view = (d: JsonObject) => {
      if (!Array.isArray(d.rows) || d.rows.length > 10000)
        bad('Retained evidence exceeds the bounded row view.', 'REPORT_SHAPE_CHANGED');
      const query = (input.row_query ?? '').trim(),
        needle = query.toLowerCase();
      const rows = query
        ? d.rows.filter((row: JsonObject) =>
            [
              'entity_id',
              'entity_name',
              'date',
              'search_term',
              ...(Object.hasOwn(d.mapping ?? {}, 'keyword_match_type') ? ['keyword_match_type'] : []),
              ...(Object.hasOwn(d.mapping ?? {}, 'native_device') ? ['native_device'] : []),
              ...(Object.hasOwn(d.mapping ?? {}, 'native_hour') ? ['native_hour'] : []),
              ...['native_country_criterion_id', 'native_location_type', 'native_geographic_resource'].filter(key =>
                Object.hasOwn(d.mapping ?? {}, key),
              ),
            ].some(key => typeof row?.[key] === 'string' && row[key].toLowerCase().includes(needle)),
          )
        : d.rows;
      return {
        ...d,
        xlsx_path: '/api/reporting-evidence/' + encodeURIComponent(d.id) + '.xlsx',
        rows: rows.slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 50)),
        row_count: d.rows.length,
        matched_row_count: rows.length,
        row_query: query,
        has_more: (input.offset ?? 0) + (input.limit ?? 50) < rows.length,
      };
    };
    const accessible = (d: JsonObject) => {
      this.store.resolveConnection(actor, d.gateway, d.account_id, d.connection_id);
      return d;
    };
    if (
      (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 0)) ||
      (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100))
    )
      bad('Invalid report pagination.');
    if (input.action === 'list') return evidenceIndex(this.store, actor, input);
    if (input.action === 'get') return view(accessible(read(this.store, actor, 'decision_report', input.id)));
    if (['overview_sources', 'capture_overview'].includes(input.action)) {
      const snapshot = read(this.store, actor, 'overview_report', input.id);
      if (!['complete', 'partial'].includes(snapshot.state))
        bad('Use a completed or marked partial snapshot.', 'REPORT_NOT_READY');
      for (const source of snapshot.config.sources)
        this.store.resolveConnection(
          actor,
          reportPlatforms[source.platform]!.gateway,
          source.account_id,
          source.connection_id,
        );
      const groups = new Map<string, {semantics: JsonObject; source: JsonObject; rows: JsonObject[]}>();
      for (const row of snapshot.rows) {
        const sem = {
          currency: row.currency,
          timezone: row.timezone,
          date_from: snapshot.config.date_range.since,
          date_to: snapshot.config.date_range.until,
          attribution: row.attribution ?? 'unknown',
          conversion_definition: row.result_definition ?? 'unknown',
          source_name: String(snapshot.config.name).slice(0, 200),
          complete: row.complete === true && row.quality?.measurement_complete !== false,
        };
        const source = {
          gateway: reportPlatforms[row.platform]!.gateway,
          account_id: row.account_id,
          connection_id: row.connection_id,
          ...(row.entity_level ? {entity_level: row.entity_level, native_entity_type: row.native_entity_type} : {}),
        };
        const key = fingerprint({
          ...source,
          currency: sem.currency,
          timezone: sem.timezone,
          attribution: sem.attribution,
          conversion_definition: sem.conversion_definition,
        });
        const group: {semantics: JsonObject; source: JsonObject; rows: JsonObject[]} = groups.get(key) ?? {
          semantics: sem,
          source,
          rows: [],
        };
        group.rows.push(row);
        group.semantics.complete &&= sem.complete;
        groups.set(key, group);
      }
      if (input.action === 'overview_sources')
        return {
          overview_id: snapshot.id,
          network_requests: 0,
          groups: [...groups].map(([id, g]) => ({
            id,
            ...g.source,
            semantics: g.semantics,
            row_count: g.rows.length,
            eligible: !!g.semantics.currency && !!g.semantics.timezone,
          })),
          meaning:
            'Choose one account, currency, timezone and conversion definition. Source data is reused from this snapshot; currencies and attribution models are never blended.',
        };
      const group = groups.get(String(input.group_id));
      if (!group) bad('Choose a group returned by overview_sources for this snapshot.', 'REPORT_GROUP_REQUIRED');
      const sem = semantic(group.semantics);
      if (!group.rows.length || group.rows.length > 10000) bad('Choose a snapshot group of 1–10,000 rows.');
      const rounding: Record<string, number> = {};
      const rows = group.rows.map(row => ({
        entity_id: String(row.entity_id ?? row.campaign_id),
        entity_name: row.entity_name ?? row.campaign_name ?? null,
        date: row.date_from,
        search_term: null,
        ...Object.fromEntries(
          metrics.map(key => [
            key,
            row.metrics[key] == null ? null : providerMetric(key, row.metrics[key], 'metrics.' + key, rounding),
          ]),
        ),
      }));
      const metricRounding = metricRoundingRecord(rounding);
      const report = {
        ...group.source,
        semantics: metricRounding ? {...sem, metric_rounding: metricRounding} : sem,
        semantics_source: 'retained Overview source definitions; no fresh provider collection',
        mapping: Object.fromEntries(metrics.map(key => [key, '/metrics/' + key])),
        source_request: {overview_id: snapshot.id, group_id: input.group_id, grain: snapshot.config.grain ?? 'total'},
        source_hash: fingerprint(metricRounding ? {rows: group.rows, metric_rounding: metricRounding} : group.rows),
        source_lineage: {
          overview_id: snapshot.id,
          definition_fingerprint: fingerprint(snapshot.config),
          row_keys: group.rows.map(row => row.row_key),
          query_fingerprints: [...new Set(group.rows.map(row => row.query_fingerprint))],
        },
        captured_at: Math.min(...group.rows.map(row => row.captured_at ?? snapshot.captured_at)),
        rows,
        totals: totals(rows),
        coverage: Object.fromEntries(
          metrics.map(key => [key, rows.some(row => row[key as keyof typeof row] == null) ? 'partial' : 'mapped']),
        ),
        source: 'overview_snapshot',
      };
      const id = fingerprint({snapshot: snapshot.id, group: input.group_id, source_hash: report.source_hash});
      if (Buffer.byteLength(JSON.stringify(report)) > 8 * 1024 * 1024) bad('Narrow the report to 8 MiB.');
      this.store.putDocument(actor.tenantId, 'decision_report', id, report);
      audit(this.store, actor, 'overview_evidence_captured', {
        id,
        overview_id: snapshot.id,
        group_id: input.group_id,
        source_hash: report.source_hash,
      });
      return {...view({...report, id}), website_path: '/reports?id=' + encodeURIComponent(id), network_requests: 0};
    }
    if (input.action === 'capture') {
      const sem = semantic(input.semantics ?? {}),
        mapping = input.mapping;
      if (
        !obj(mapping) ||
        Object.keys(mapping).some(
          k =>
            ![
              'entity_id',
              'entity_name',
              'date',
              'search_term',
              'keyword_match_type',
              'native_device',
              'native_hour',
              'native_country_criterion_id',
              'native_location_type',
              'native_geographic_resource',
              ...metrics,
            ].includes(k),
        )
      )
        bad('Provide the native field mapping.');
      // Validate even an empty result's mappings before requesting provider data.
      for (const [key, spec] of Object.entries(mapping)) {
        if (typeof spec !== 'string')
          validate(spec, ['path', 'divisor', 'action_type', 'format'], undefined, 'mapping field');
        if (key === 'keyword_match_type' && obj(spec) && Object.keys(spec).some(k => k !== 'path'))
          bad('Native keyword match type requires an unmodified field pointer.');
        if (key === 'native_device' && obj(spec) && Object.keys(spec).some(k => k !== 'path'))
          nativeDeviceMappingFailure('Native device requires an unmodified field pointer.');
        if (key === 'native_hour' && obj(spec) && Object.keys(spec).some(k => k !== 'path'))
          nativeHourMappingFailure('Native hour requires an unmodified field pointer.');
        if (
          ['native_country_criterion_id', 'native_location_type', 'native_geographic_resource'].includes(key) &&
          obj(spec) &&
          Object.keys(spec).some(k => k !== 'path')
        )
          nativeCountryMappingFailure('Native geographic dimensions require unmodified field pointers.');
        if (
          obj(spec) &&
          spec.format !== undefined &&
          (key !== 'date' ||
            !['linkedin_utc_date', 'tiktok_day'].includes(spec.format) ||
            spec.divisor !== undefined ||
            spec.action_type !== undefined)
        )
          bad('Native date formats are only available for the report date.');
        const path = typeof spec === 'string' ? spec : (spec as JsonObject).path;
        if (typeof path !== 'string' || path.length > 512 || (path !== '' && !path.startsWith('/')))
          bad('Invalid metric JSON pointer.');
        if (
          obj(spec) &&
          spec.divisor !== undefined &&
          !['1', '100', '1000', '1000000', '1000000000'].includes(String(spec.divisor))
        )
          bad('Use an explicit native unit divisor.');
        if (
          obj(spec) &&
          spec.action_type !== undefined &&
          (!metrics.includes(key) ||
            typeof spec.action_type !== 'string' ||
            !/^[a-z][a-z0-9_.]{0,159}$/.test(spec.action_type))
        )
          bad('An action_type selector requires an exact native metric action type.');
      }
      if (typeof input.account_id !== 'string' || typeof input.gateway !== 'string' || !obj(input.arguments))
        bad('Specify a gateway, account and native read arguments.');
      const c = this.store.resolveConnection(actor, input.gateway, input.account_id, input.connection_id);
      const args = structuredClone(input.arguments);
      if (args.operation) {
        args.arguments = {...args.arguments, account_id: input.account_id, connection_id: c.id, dry_run: false};
      } else Object.assign(args, {account_id: input.account_id, connection_id: c.id, dry_run: false});
      let nativeAccountEvidence: JsonObject | undefined;
      const linkedin = capturePreset?.startsWith('linkedin_')
        ? await collectLinkedInEvidence(this.store, this.call, actor, args, sem, rows =>
            validatePresetRows(capturePreset, input, rows),
          )
        : undefined;
      const tiktok = capturePreset?.startsWith('tiktok_')
        ? await collectTikTokDailyReport(this.store, this.call, actor, args, sem)
        : undefined;
      const google = capturePreset?.startsWith('google_')
        ? await collectGoogleReport(this.store, this.call, actor, args, sem, capturePreset)
        : undefined;
      const meta = capturePreset?.startsWith('meta_')
        ? await collectMetaEvidence(this.store, this.call, actor, args, sem)
        : undefined;
      const snapchat = capturePreset?.startsWith('snapchat_')
        ? await collectSnapchatEvidence(this.store, this.call, actor, args, sem)
        : undefined;
      const collected = tiktok ?? google ?? meta ?? linkedin ?? snapchat;
      if (collected) nativeAccountEvidence = collected.nativeAccountEvidence;
      const source: JsonObject = collected?.source ?? (await this.call(input.gateway, args, actor));
      if (source.success !== true)
        bad(source.error?.message ?? 'Provider report failed.', source.error?.code ?? 'REPORT_FAILED');
      if (source.data?.executed === false || source.data?.dry_run || partial(source))
        bad('Capture requires a complete provider read, not a preview or partial page.', 'REPORT_INCOMPLETE');
      const raw = pointer(source, input.rows_pointer ?? '/data/data/results');
      if (!Array.isArray(raw) || raw.length > 10000) bad('Select an array of at most 10000 provider rows.');
      if (!linkedin) validatePresetRows(capturePreset, input, raw);
      const rounding: Record<string, number> = {};
      // RPT-04 (owner policy P6): guided Meta pages are complete, and Meta omits zero-valued action entries, so a
      // delivered row (impressions above 0) counts an absent selected action as 0 and names it in `omitted_as_zero`.
      const metaOmittedZero = meta !== undefined,
        omittedCounts: Record<string, number> = {};
      const rows = raw.map(r => {
        const out: JsonObject = {},
          omitted: string[] = [];
        let delivered = false;
        if (metaOmittedZero)
          try {
            const spec = mapping.impressions,
              impressions = pointer(r, typeof spec === 'string' ? spec : spec?.path);
            delivered = (metricNumber(impressions) ?? 0) > 0;
          } catch {
            delivered = false;
          }
        for (const key of [
          'entity_id',
          'entity_name',
          'date',
          'search_term',
          ...(Object.hasOwn(mapping, 'keyword_match_type') ? ['keyword_match_type'] : []),
          ...(Object.hasOwn(mapping, 'native_device') ? ['native_device'] : []),
          ...(Object.hasOwn(mapping, 'native_hour') ? ['native_hour'] : []),
          ...['native_country_criterion_id', 'native_location_type', 'native_geographic_resource'].filter(key =>
            Object.hasOwn(mapping, key),
          ),
          ...metrics,
        ]) {
          const spec = mapping[key];
          if (spec === undefined) {
            out[key] = null;
            continue;
          }
          const path = typeof spec === 'string' ? spec : spec.path;
          let value: any;
          try {
            value = pointer(r, path);
          } catch {
            value = null;
          }
          if (obj(spec) && spec.action_type !== undefined && value !== null && value !== undefined) {
            if (!Array.isArray(value) || value.some(v => !obj(v)))
              bad('The native action metric is not a row collection.', 'REPORT_SHAPE_CHANGED');
            const matching = value.filter(v => v.action_type === spec.action_type);
            if (matching.length > 1)
              bad('The native action metric has duplicate selected action types.', 'REPORT_METRIC_AMBIGUOUS');
            value = matching[0]?.value ?? null;
          }
          if (
            (value === null || value === undefined) &&
            delivered &&
            obj(spec) &&
            spec.action_type !== undefined &&
            metrics.includes(key)
          ) {
            value = '0';
            omitted.push(key);
            omittedCounts[key] = (omittedCounts[key] ?? 0) + 1;
          }
          if (value === null || value === undefined) {
            out[key] = null;
            continue;
          }
          if (metrics.includes(key)) {
            const divisor = obj(spec) && spec.divisor !== undefined ? spec.divisor : undefined;
            if (divisor !== undefined && !['1', '100', '1000', '1000000', '1000000000'].includes(String(divisor)))
              bad('Use an explicit native unit divisor.');
            // The native unit is applied to the exact decimal text before the nine-place rounding policy.
            out[key] = providerMetric(key, value, key + ' (' + (path || '/') + ')', rounding, divisor);
          } else {
            if (obj(spec) && spec.format === 'linkedin_utc_date') value = linkedInReportDate(value);
            if (obj(spec) && spec.format === 'tiktok_day') value = tiktokReportDate(value);
            if (typeof value === 'object' || String(value).length > 1000) bad('Invalid report identifier or label.');
            if (
              key === 'keyword_match_type' &&
              (typeof value !== 'string' || !['EXACT', 'PHRASE', 'BROAD'].includes(value))
            )
              bad('Native keyword match type must retain EXACT, PHRASE or BROAD.', 'REPORT_SHAPE_CHANGED');
            if (key === 'native_device' && (typeof value !== 'string' || !googleReportDevices.includes(value)))
              nativeDeviceMappingFailure('Native device must retain a documented Google device value.');
            if (key === 'native_hour' && (!Number.isInteger(value) || value < 0 || value > 23))
              nativeHourMappingFailure('Native hour must retain an explicit integer from 0 through 23.');
            if (key === 'native_country_criterion_id' && !googleReportCountryId(value))
              nativeCountryMappingFailure('Native country criterion IDs must retain exact nonnegative int64 strings.');
            if (
              key === 'native_location_type' &&
              (typeof value !== 'string' || !Object.hasOwn(googleReportLocationTypes, value))
            )
              nativeCountryMappingFailure('Native location type must retain a documented Google geographic value.');
            if (
              key === 'native_geographic_resource' &&
              (input.gateway !== 'google_ads_native_action' ||
                googleGeographicResource(value)?.account_id !== normalizeAccount(input.gateway, input.account_id))
            )
              nativeCountryMappingFailure('Native geographic resources must retain the exact selected customer.');
            out[key] = String(value);
          }
        }
        if (out.native_geographic_resource !== undefined && out.native_geographic_resource !== null) {
          const geographic = googleGeographicResource(out.native_geographic_resource)!;
          if (
            (out.native_country_criterion_id !== undefined &&
              out.native_country_criterion_id !== null &&
              out.native_country_criterion_id !== geographic.country_criterion_id) ||
            (out.native_location_type !== undefined &&
              out.native_location_type !== null &&
              googleReportLocationTypes[out.native_location_type as keyof typeof googleReportLocationTypes] !==
                geographic.location_type_value)
          )
            nativeCountryMappingFailure('Native geographic dimensions disagree with their original resource identity.');
        }
        if (omitted.length) out.omitted_as_zero = omitted;
        return out;
      });
      this.store.resolveConnection(actor, input.gateway, input.account_id, c.id);
      this.store.assertActorActive(actor);
      collected?.assertCurrent();
      const metricRounding = metricRoundingRecord(rounding);
      const id = randomUUID(),
        report = {
          gateway: input.gateway,
          account_id: input.account_id,
          connection_id: c.id,
          semantics: metricRounding ? {...sem, metric_rounding: metricRounding} : sem,
          semantics_source: 'explicit caller declaration; compare with native account/report metadata',
          mapping,
          source_request: args,
          // Rounding provenance is part of new evidence identity; exact captures keep their original hash shape.
          source_hash: fingerprint(metricRounding ? {data: source.data, metric_rounding: metricRounding} : source.data),
          ...(nativeAccountEvidence ? {native_account_evidence: nativeAccountEvidence} : {}),
          ...(collected
            ? {
                source_pages: collected.sourcePages,
                source_collection: tiktok
                  ? 'tiktok_daily_pages'
                  : google
                    ? 'google_search_pages'
                    : meta
                      ? 'meta_insights_pages'
                      : snapchat
                        ? 'snapchat_daily_pages'
                        : 'linkedin_analytics',
              }
            : {}),
          captured_at: Date.now(),
          rows,
          totals: totals(rows, mapping),
          coverage: Object.fromEntries(
            metrics.map(k => [
              k,
              mapping[k] === undefined
                ? 'unmapped'
                : rows.some(r => r[k] === null)
                  ? 'partial'
                  : omittedCounts[k]
                    ? 'omitted_as_zero'
                    : 'mapped',
            ]),
          ),
          ...(Object.keys(omittedCounts).length ? {omitted_as_zero: omittedCounts} : {}),
          source: 'provider_read',
        };
      if (Buffer.byteLength(JSON.stringify(report)) > 8 * 1024 * 1024) bad('Narrow the report to 8 MiB.');
      if (transient) return {...report, native_rows: raw};
      this.store.putDocument(actor.tenantId, 'decision_report', id, report);
      audit(this.store, actor, 'report_captured', {
        id,
        gateway: input.gateway,
        account_id: input.account_id,
        source_hash: report.source_hash,
      });
      return view({...report, id});
    }
    const report = read(this.store, actor, 'decision_report', input.id);
    this.store.resolveConnection(actor, report.gateway, report.account_id, report.connection_id);
    if (input.action === 'scenarios') return reportScenarios(report, input.options ?? {});
    if (input.action === 'allocation_candidates') return allocationCandidates(report, input);
    if (input.action === 'calibrate_allocation') {
      const result = calibrateAllocation(report, input.ids, input.options ?? {});
      this.store.assertActorActive(actor);
      this.store.resolveConnection(actor, report.gateway, report.account_id, report.connection_id);
      return result;
    }
    if (input.action === 'allocation') return reportAllocation(report, input.options ?? {});
    if (input.action === 'preview_allocation_plan')
      return previewAllocationPlan(this.store, this.call, actor, report, input);
    if (input.action === 'create_allocation_plan')
      return createAllocationPlan(this.store, this.call, actor, report, input, this.createDraft);
    if (input.action === 'search_exclusion_candidates') return searchExclusionCandidates(report, input);
    if (input.action === 'preview_search_exclusions')
      return previewSearchExclusions(this.store, this.call, actor, report, input);
    if (input.action === 'create_search_exclusion_plan')
      return createSearchExclusionPlan(this.store, this.call, actor, report, input, this.createDraft);
    if (input.action === 'reconcile_report') {
      const reference = read(this.store, actor, 'decision_report', input.reference_id);
      this.store.resolveConnection(actor, reference.gateway, reference.account_id, reference.connection_id);
      const context = compareReportContext(report, reference);
      validate(input.options ?? {}, ['tolerance'], undefined, 'reconciliation option');
      const tolerance = input.options?.tolerance ?? {};
      validate(
        tolerance,
        metrics.filter(k => !['reach', 'frequency'].includes(k)),
        undefined,
        'metric tolerance',
      );
      for (const value of Object.values(tolerance)) scaledDeclared(value);
      const differences = metrics
        .filter(
          k =>
            !['reach', 'frequency'].includes(k) &&
            report.mapping?.[k] !== undefined &&
            reference.mapping?.[k] !== undefined,
        )
        .map(metric => {
          const actual = report.totals[metric] ?? null,
            expected = reference.totals[metric] ?? null;
          const delta = actual === null || expected === null ? null : scaledDeclared(actual) - scaledDeclared(expected);
          return {
            metric,
            actual,
            reference: expected,
            difference: delta === null ? null : decimal(delta),
            tolerance: String(tolerance[metric] ?? '0'),
            matched: delta === null ? null : (delta < 0n ? -delta : delta) <= scaledDeclared(tolerance[metric] ?? '0'),
          };
        });
      if (!differences.length) bad('These reports have no shared additive metrics.', 'REPORT_REFERENCE_REQUIRED');
      const result = {
        report_id: report.id,
        reference_report_id: reference.id,
        comparison_kind: 'retained_reports',
        context_compatible: true,
        independently_verified: false,
        context,
        qualification:
          'Retained account, period, measurement declarations and grain match. This checks numerical agreement, not independent provider attribution or an external export.',
        reference_source: 'retained report; no new provider read',
        source_hash: report.source_hash,
        reference_source_hash: reference.source_hash,
        captured_at: report.captured_at,
        reference_captured_at: reference.captured_at,
        network_requests: 0,
        differences,
        matched: differences.every(r => r.matched === true),
        checked_at: Date.now(),
      };
      this.store.assertActorActive(actor);
      this.store.resolveConnection(actor, report.gateway, report.account_id, report.connection_id);
      this.store.resolveConnection(actor, reference.gateway, reference.account_id, reference.connection_id);
      this.store.putDocument(actor.tenantId, 'report_reconciliation', randomUUID(), result);
      return result;
    }
    if (input.action === 'reconcile') {
      const ref = input.reference;
      validate(
        ref ?? {},
        ['label', 'captured_at', 'totals', 'tolerance', 'evidence_url', 'context', 'file'],
        undefined,
        'reference field',
      );
      if (typeof ref?.label !== 'string' || !ref.label.trim() || !obj(ref.totals) || !Number.isFinite(ref.captured_at))
        bad('Provide labeled reference totals and capture time.');
      const declaredContext = compareDeclaredReference(report, ref);
      const differences = Object.entries(ref.totals).map(([metric, value]) => {
        if (!metrics.includes(metric) || ['reach', 'frequency'].includes(metric))
          bad('Only additive metrics can be reconciled.');
        const actual = report.totals[metric] ?? null,
          expected = value === null ? null : scaledDeclared(value),
          delta = actual === null || expected === null ? null : scaledDeclared(actual) - expected,
          tolerance = scaledDeclared(ref.tolerance?.[metric] ?? '0');
        return {
          metric,
          actual,
          reference: value,
          difference: delta === null ? null : decimal(delta),
          matched: delta === null ? null : (delta < 0n ? -delta : delta) <= tolerance,
        };
      });
      const result = {
        report_id: report.id,
        comparison_kind: declaredContext ? 'declared_reference' : 'manual_totals',
        context_compatible: declaredContext ? true : null,
        independently_verified: false,
        file_hash_verified_by_server: false,
        source_hash: report.source_hash,
        network_requests: 0,
        qualification: declaredContext
          ? 'Caller-declared reference settings match the retained report. File provenance, entities, filters and provider attribution have not been independently verified.'
          : 'This is numerical agreement only. The reference account, dates, currency, timezone and attribution have not been verified.',
        reference_source: 'caller-provided reference; not independently fetched',
        reference: ref,
        differences,
        matched: differences.length > 0 && differences.every(r => r.matched === true),
        checked_at: Date.now(),
      };
      this.store.assertActorActive(actor);
      this.store.resolveConnection(actor, report.gateway, report.account_id, report.connection_id);
      this.store.putDocument(actor.tenantId, 'report_reconciliation', randomUUID(), result);
      return result;
    }
    if (input.action === 'combine') {
      if (
        !Array.isArray(input.ids) ||
        !input.ids.length ||
        input.ids.length > 20 ||
        new Set(input.ids).size !== input.ids.length
      )
        bad('Choose 1–20 distinct report IDs.');
      const all = [
        report,
        ...input.ids
          .filter((id: string) => id !== report.id)
          .map((id: string) => read(this.store, actor, 'decision_report', id)),
      ];
      const seen = new Set<string>();
      for (const r of all) {
        this.store.resolveConnection(actor, r.gateway, r.account_id, r.connection_id);
        compatibility(report, r);
        if (r.semantics.date_from !== report.semantics.date_from || r.semantics.date_to !== report.semantics.date_to)
          bad('Combined reports must cover the same window.');
        const key = [r.gateway, r.account_id].join('/');
        if (seen.has(key)) bad('Overlapping same-account reports must not be summed.');
        seen.add(key);
      }
      return {
        report_ids: all.map(r => r.id),
        semantics: report.semantics,
        totals: totals(all.flatMap(r => r.rows)),
        cross_platform_deduplicated: false,
        warning:
          'Platform-attributed conversions can overlap across platforms; this is not unique business conversions.',
      };
    }
    if (input.action !== 'analyze') bad('Unknown reporting action.');
    const options = input.options ?? {};
    validate(
      options,
      [
        'planned_budget',
        'total_days',
        'elapsed_days',
        'target_cpa',
        'minimum_clicks',
        'minimum_impressions',
        'maximum_change_percent',
        'stale_after_hours',
        'current_daily_budget',
      ],
      undefined,
      'option',
    );
    const recommendations: JsonObject[] = [],
      t = report.totals;
    const add = (type: string, evidence: JsonObject, proposal: string, confidence = 'medium') =>
      recommendations.push({type, evidence, proposal, confidence, requires_review: true, automatic_execution: false});
    const staleHours = options.stale_after_hours ?? 48;
    if (typeof staleHours !== 'number' || staleHours < 1 || staleHours > 168) bad('stale_after_hours must be 1–168.');
    const stale = Date.now() - report.captured_at > staleHours * 3600000;
    if (stale || !report.semantics.complete)
      add(
        'data_quality',
        {captured_at: report.captured_at, complete: report.semantics.complete},
        'Refresh a complete reporting window before acting.',
        'high',
      );
    if (options.planned_budget !== undefined) {
      const budget = Number(decimal(scaledDeclared(options.planned_budget))),
        days = options.total_days,
        elapsed = options.elapsed_days;
      if (
        !Number.isInteger(days) ||
        days < 1 ||
        !Number.isInteger(elapsed) ||
        elapsed < 1 ||
        elapsed > days ||
        budget <= 0
      )
        bad('Pacing needs a positive budget, total_days and elapsed_days.');
      if (t.spend !== null) {
        const expected = (budget * elapsed) / days,
          projected = (Number(t.spend) / elapsed) * days;
        add(
          'budget_pacing',
          {
            spend: t.spend,
            expected_to_date: expected,
            projected_total: projected,
            planned_budget: budget,
            deviation_percent: ((Number(t.spend) - expected) / expected) * 100,
          },
          projected > budget
            ? 'Review delivery and budget pacing.'
            : 'Review whether delivery can meet the planned budget.',
        );
      }
    }
    let baseline: JsonObject | undefined;
    if (input.baseline_id) {
      baseline = read(this.store, actor, 'decision_report', input.baseline_id);
      this.store.resolveConnection(actor, baseline.gateway, baseline.account_id, baseline.connection_id);
      compatibility(report, baseline);
      if (baseline.account_id !== report.account_id || baseline.gateway !== report.gateway)
        bad('The baseline must use the same account and platform.');
      // RPT-04: a different preset, grain or mapping would turn a grain difference into spend or fatigue advice.
      assertCompatibleBaseline(report, baseline);
      const days = (r: JsonObject) =>
        (Date.parse(r.semantics.date_to) - Date.parse(r.semantics.date_from)) / 86400000 + 1;
      if (days(report) !== days(baseline) || baseline.semantics.date_to >= report.semantics.date_from)
        bad('Compare equal-length, non-overlapping windows.');
    }
    const minClicks = options.minimum_clicks ?? 30,
      minImpressions = options.minimum_impressions ?? 1000;
    if (!Number.isInteger(minClicks) || minClicks < 1 || !Number.isInteger(minImpressions) || minImpressions < 1)
      bad('Use positive sample thresholds.');
    const baseById = new Map(grouped(baseline?.rows ?? []).map((r: JsonObject) => [r.entity_id, r]));
    for (const row of report.rows) {
      if (row.search_term && row.clicks !== null && Number(row.clicks) >= minClicks && row.conversions === '0')
        add(
          'search_waste',
          {
            entity_id: row.entity_id,
            search_term: row.search_term,
            clicks: row.clicks,
            spend: row.spend,
            conversions: '0',
          },
          'Review relevance and conversion lag before preparing an exact negative keyword.',
        );
    }
    for (const row of grouped(report.rows)) {
      const before = baseById.get(row.entity_id) as JsonObject | undefined;
      if (before && Number(row.impressions) >= minImpressions && Number(before.impressions) >= minImpressions) {
        const nowCtr = ratio(row.clicks, row.impressions),
          oldCtr = ratio(before.clicks, before.impressions);
        if (nowCtr !== null && oldCtr !== null && oldCtr > 0 && nowCtr < oldCtr * 0.75)
          add(
            'possible_creative_fatigue',
            {entity_id: row.entity_id, current_ctr: nowCtr, baseline_ctr: oldCtr},
            'Inspect creative, audience, placement and delivery changes before replacing this creative.',
            'low',
          );
      }
    }
    if (options.target_cpa !== undefined) {
      const target = Number(decimal(scaledDeclared(options.target_cpa))),
        actual = ratio(t.spend, t.conversions);
      if (target <= 0) bad('target_cpa must be positive.');
      if (actual !== null && actual > target && Number(t.clicks) >= minClicks)
        add(
          'cpa_above_target',
          {actual_cpa: actual, target_cpa: target, clicks: t.clicks, conversions: t.conversions},
          'Review conversion lag and targeting before preparing a bid or budget change.',
        );
    }
    if (
      baseline &&
      t.spend !== null &&
      baseline.totals.spend !== null &&
      Number(baseline.totals.spend) > 0 &&
      Number(t.spend) > Number(baseline.totals.spend) * 1.5
    )
      add(
        'spend_anomaly',
        {current_spend: t.spend, baseline_spend: baseline.totals.spend},
        'Investigate budget, schedule and targeting changes.',
      );
    const cap = options.maximum_change_percent ?? 10;
    if (typeof cap !== 'number' || cap < 0 || cap > 100) bad('maximum_change_percent must be 0–100.');
    if (options.current_daily_budget !== undefined) {
      const current = Number(decimal(scaledDeclared(options.current_daily_budget)));
      if (!Number.isFinite(current) || current <= 0 || options.planned_budget === undefined)
        bad('A bounded budget suggestion needs current_daily_budget and a valid pacing plan.');
      const remaining = options.total_days - options.elapsed_days;
      if (t.spend !== null && remaining > 0) {
        const target = Math.max(0, (Number(options.planned_budget) - Number(t.spend)) / remaining),
          proposed = Math.min(current * (1 + cap / 100), Math.max(current * (1 - cap / 100), target));
        add(
          'bounded_budget_proposal',
          {
            current_daily_budget: current,
            desired_daily_pacing: target,
            proposed_daily_budget: proposed,
            change_percent: ((proposed - current) / current) * 100,
            maximum_change_percent: cap,
            currency: report.semantics.currency,
          },
          'Check current campaign budgets and prepare a separate reviewed change. This proposal uses caller-declared budget values.',
        );
      }
    }

    return {
      report_id: report.id,
      baseline_id: baseline?.id ?? null,
      source_hash: report.source_hash,
      semantics: report.semantics,
      generated_at: Date.now(),
      stale,
      eligible_for_action: !stale && report.semantics.complete,
      recommendations: recommendations.slice(0, 100),
      constraints: {
        maximum_proposed_budget_change_percent: cap,
        minimum_clicks: minClicks,
        minimum_impressions: minImpressions,
      },
      kpis: {
        ctr: ratio(t.clicks, t.impressions, 100),
        cpc: ratio(t.spend, t.clicks),
        cpa: ratio(t.spend, t.conversions),
        roas: ratio(t.conversion_value, t.spend),
      },
      limitations: [
        'Heuristic evidence, not a causal estimate or performance guarantee.',
        'Attribution, conversion lag and source mappings must be verified before acting.',
        ...(report.semantics.metric_rounding ? [metricRoundingLimitation] : []),
        // RPT-04: also among the limitations, which every client already reads (the website shows data_quality).
        ...(baseline && baseline.semantics?.complete !== true ? [baselineIncompleteLimitation] : []),
      ],
      ...(baseline && baseline.semantics?.complete !== true ? {data_quality: [baselineIncompleteLimitation]} : {}),
    };
  }
}
