import {randomUUID} from 'node:crypto';
import {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {audit, bad, field, fingerprint, obj, pointer, read, tool, validate, type ToolCall} from './workspace-core.js';
import {reportPlatforms} from './report-metrics.js';
import {reportPresets, reportPreset, validatePresetRows} from './report-presets.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {reportScenarios} from './report-scenarios.js';
import {allocationCandidates, reportAllocation} from './report-allocation.js';
import {previewAllocationPlan, createAllocationPlan} from './allocation-plan.js';
import {linkedInAnalyticsRows, linkedInReportDate} from './linkedin-reporting.js';
import {compareReportContext} from './report-references.js';
export const decisionTool = tool(
  'amcp_reporting',
  'Use this to analyse metrics captured from native reports: reconciliation, comparisons and recommendations. For saved client reports across platforms, schedules and Sheets exports, use amcp_reporting_overview. Capture source-linked native metrics; reconcile totals with an explicitly labeled reference; compare compatible reports and generate evidence-based pacing, anomaly, fatigue and search-waste recommendations. Search waste: capture a search-terms read whose mapping names search_term, clicks, spend and conversions, then analyze {id, options: {minimum_clicks}}; amcp://guides/workspace shows the Google request. capture_presets discovers Google, Meta and LinkedIn detailed reports. LinkedIn campaign_group, campaign and creative presets verify account currency, require UTC and use the exact externalWebsiteConversions metric. They require declared attribution windows (or unknown), reject ambiguous empty/truncated reports and retain native URNs. Daily dates are limited conservatively to the current month and previous five months. This reporting endpoint has no pagination. Meta capture_preset requires an exact result_action_type and explicit attribution_windows; its attribution and result definitions come from the generated request. Missing selected actions stay unknown and aliases are never added. allocation_candidates pages campaign totals from one guided Google or Meta campaign/day report with offset/limit. allocation models a comparable-period budget using options {budget, allocations:[{entity_id,minimum,maximum}], efficiency_low, efficiency_high, minimum_conversions, maximum_age_days}; select 2–50 campaigns. It requires recent complete evidence and exact feasible floors/caps; it is a linear sensitivity proposal, not a forecast, native daily budget or approval. preview_allocation_plan takes report id, the same allocation options and explicit conversion equal_daily; it reads current dedicated Google campaign daily budgets and shows exact micros and rounding residuals. create_allocation_plan requires that report id, preview_id, preview_hash and confirmed:true within the current session and ten-minute preview. It saves an unapproved source-bound campaign draft, not an advertising change. Current ownership/source checks precede unsent plan steps, and native review, spending acknowledgement and read-back remain separate. Other providers, shared/lifetime budgets and automatic end dates are unqualified. reconcile_report compares id against reference_id using retained guided presets or the same Overview definition/group; account, dates, currency, timezone, attribution, conversion definition, completeness and native grain must align. options.tolerance accepts additive metric decimals. It retains both source hashes, makes no new read and does not independently verify provider attribution. Legacy reconcile with manually supplied totals checks numerical agreement only. No advertising writes from reporting. Missing metrics stay unknown.',
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
    'allocation',
    'preview_allocation_plan',
    'create_allocation_plan',
  ],
  {
    gateway: field.id,
    arguments: field.object,
    connection_id: field.id,
    account_id: field.id,
    rows_pointer: field.id,
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
    ids: {type: 'array', items: {type: 'string'}, minItems: 1, maxItems: 20},
    reference: field.object,
    reference_id: field.id,
    baseline_id: field.id,
    options: field.object,
    conversion: {type: 'string', enum: ['equal_daily']},
    preview_id: field.id,
    preview_hash: field.id,
    confirmed: field.bool,
    offset: field.integer,
    limit: {type: 'integer', minimum: 1, maximum: 100},
  },
);
const metrics = ['spend', 'impressions', 'clicks', 'conversions', 'conversion_value', 'reach', 'frequency'];
const scaled = (s: unknown): bigint => {
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
        : decimal(rows.reduce((n, r) => n + scaled(r[k]), 0n)),
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
  ) {}
  async handle(input: JsonObject, actor: Actor, capturePreset?: string): Promise<JsonObject> {
    validate(input, Object.keys(decisionTool.inputSchema.properties));
    this.store.assertActorActive(actor);
    if (input.action === 'capture_presets') return {presets: reportPresets};
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
          ...(request.gateway === 'meta_native_action'
            ? {
                semantics_source:
                  'Meta action/window/report-time settings from the retained request; native row currency checked; timezone and completeness explicitly declared.',
              }
            : {}),
          ...(request.gateway === 'linkedin_native_action'
            ? {
                semantics_source:
                  'LinkedIn account currency verified from the retained account read; UTC dates and externalWebsiteConversions from the native request; attribution windows and completeness explicitly declared, not independently verified.',
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
    const view = (d: JsonObject) => ({
      ...d,
      rows: d.rows.slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 50)),
      row_count: d.rows.length,
      has_more: (input.offset ?? 0) + (input.limit ?? 50) < d.rows.length,
    });
    const accessible = (d: JsonObject) => {
      this.store.resolveConnection(actor, d.gateway, d.account_id, d.connection_id);
      return d;
    };
    if (
      (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 0)) ||
      (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100))
    )
      bad('Invalid report pagination.');
    if (input.action === 'list')
      return {
        reports: this.store
          .documents(actor.tenantId, 'decision_report')
          .filter(d => {
            try {
              accessible(d);
              return true;
            } catch {
              return false;
            }
          })
          .map(({rows, ...d}) => ({...d, row_count: rows.length})),
      };
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
      const rows = group.rows.map(row => ({
        entity_id: String(row.campaign_id),
        entity_name: row.campaign_name ?? null,
        date: row.date_from,
        search_term: null,
        ...Object.fromEntries(
          metrics.map(key => [key, row.metrics[key] == null ? null : decimal(scaled(row.metrics[key]))]),
        ),
      }));
      const report = {
        ...group.source,
        semantics: sem,
        semantics_source: 'retained Overview source definitions; no fresh provider collection',
        mapping: Object.fromEntries(metrics.map(key => [key, '/metrics/' + key])),
        source_request: {overview_id: snapshot.id, group_id: input.group_id, grain: snapshot.config.grain ?? 'total'},
        source_hash: fingerprint(group.rows),
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
        Object.keys(mapping).some(k => !['entity_id', 'entity_name', 'date', 'search_term', ...metrics].includes(k))
      )
        bad('Provide the native field mapping.');
      // Validate even an empty result's mappings before requesting provider data.
      for (const [key, spec] of Object.entries(mapping)) {
        if (typeof spec !== 'string')
          validate(spec, ['path', 'divisor', 'action_type', 'format'], undefined, 'mapping field');
        if (
          obj(spec) &&
          spec.format !== undefined &&
          (key !== 'date' ||
            spec.format !== 'linkedin_utc_date' ||
            spec.divisor !== undefined ||
            spec.action_type !== undefined)
        )
          bad('The linkedin_utc_date format is only available for the report date.');
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
      if (capturePreset?.startsWith('linkedin_')) {
        const request = {
          action: 'linkedin_rest_ad_accounts_ad_account_id_get',
          account_id: input.account_id,
          connection_id: c.id,
          path_params: {ad_account_id: input.account_id},
          dry_run: false,
        };
        const result = await this.call(input.gateway, request, actor);
        if (result.success !== true)
          bad(result.error?.message ?? 'LinkedIn account read failed.', result.error?.code ?? 'REPORT_FAILED');
        if (result.data?.dry_run || result.data?.executed === false || partial(result))
          bad('LinkedIn account metadata requires a complete native read.', 'REPORT_INCOMPLETE');
        const account = result.data?.data;
        if (!obj(account) || String(account.id ?? '') !== input.account_id)
          bad('LinkedIn returned a different or missing account ID.', 'REPORT_ACCOUNT_MISMATCH');
        if (account.currency !== sem.currency)
          bad('LinkedIn returned a different or missing account currency.', 'REPORT_CURRENCY_MISMATCH');
        nativeAccountEvidence = {
          account_id: input.account_id,
          currency: account.currency,
          source_request: request,
          source_hash: fingerprint(result.data),
          captured_at: Date.now(),
        };
        this.store.assertActorActive(actor);
        this.store.resolveConnection(actor, input.gateway, input.account_id, c.id);
      }
      const source = await this.call(input.gateway, args, actor);
      if (source.success !== true)
        bad(source.error?.message ?? 'Provider report failed.', source.error?.code ?? 'REPORT_FAILED');
      if (source.data?.executed === false || source.data?.dry_run || partial(source))
        bad('Capture requires a complete provider read, not a preview or partial page.', 'REPORT_INCOMPLETE');
      const raw = pointer(source, input.rows_pointer ?? '/data/data/results');
      if (capturePreset?.startsWith('linkedin_')) linkedInAnalyticsRows(source.data?.data);
      if (!Array.isArray(raw) || raw.length > 10000) bad('Select an array of at most 10000 provider rows.');
      validatePresetRows(capturePreset, input, raw);
      const rows = raw.map(r => {
        const out: JsonObject = {};
        for (const key of ['entity_id', 'entity_name', 'date', 'search_term', ...metrics]) {
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
          if (value === null || value === undefined) {
            out[key] = null;
            continue;
          }
          if (metrics.includes(key)) {
            let number = scaled(value);
            if (obj(spec) && spec.divisor !== undefined) {
              if (!['1', '100', '1000', '1000000', '1000000000'].includes(String(spec.divisor)))
                bad('Use an explicit native unit divisor.');
              number /= BigInt(spec.divisor);
            }
            out[key] = decimal(number);
          } else {
            if (obj(spec) && spec.format === 'linkedin_utc_date') value = linkedInReportDate(value);
            if (typeof value === 'object' || String(value).length > 1000) bad('Invalid report identifier or label.');
            out[key] = String(value);
          }
        }
        return out;
      });
      this.store.resolveConnection(actor, input.gateway, input.account_id, c.id);
      this.store.assertActorActive(actor);
      const id = randomUUID(),
        report = {
          gateway: input.gateway,
          account_id: input.account_id,
          connection_id: c.id,
          semantics: sem,
          semantics_source: 'explicit caller declaration; compare with native account/report metadata',
          mapping,
          source_request: args,
          source_hash: fingerprint(source.data),
          ...(nativeAccountEvidence ? {native_account_evidence: nativeAccountEvidence} : {}),
          captured_at: Date.now(),
          rows,
          totals: totals(rows, mapping),
          coverage: Object.fromEntries(
            metrics.map(k => [
              k,
              mapping[k] === undefined ? 'unmapped' : rows.some(r => r[k] === null) ? 'partial' : 'mapped',
            ]),
          ),
          source: 'provider_read',
        };
      if (Buffer.byteLength(JSON.stringify(report)) > 8 * 1024 * 1024) bad('Narrow the report to 8 MiB.');
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
    if (input.action === 'allocation') return reportAllocation(report, input.options ?? {});
    if (input.action === 'preview_allocation_plan')
      return previewAllocationPlan(this.store, this.call, actor, report, input);
    if (input.action === 'create_allocation_plan')
      return createAllocationPlan(this.store, this.call, actor, report, input, this.createDraft);
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
      for (const value of Object.values(tolerance)) scaled(value);
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
          const delta = actual === null || expected === null ? null : scaled(actual) - scaled(expected);
          return {
            metric,
            actual,
            reference: expected,
            difference: delta === null ? null : decimal(delta),
            tolerance: String(tolerance[metric] ?? '0'),
            matched: delta === null ? null : (delta < 0n ? -delta : delta) <= scaled(tolerance[metric] ?? '0'),
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
        ['label', 'captured_at', 'totals', 'tolerance', 'evidence_url'],
        undefined,
        'reference field',
      );
      if (typeof ref.label !== 'string' || !ref.label.trim() || !obj(ref.totals) || !Number.isFinite(ref.captured_at))
        bad('Provide labeled reference totals and capture time.');
      const differences = Object.entries(ref.totals).map(([metric, value]) => {
        if (!metrics.includes(metric) || ['reach', 'frequency'].includes(metric))
          bad('Only additive metrics can be reconciled.');
        const actual = report.totals[metric],
          delta = actual === null ? null : scaled(actual) - scaled(value),
          tolerance = scaled(ref.tolerance?.[metric] ?? '0');
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
        comparison_kind: 'manual_totals',
        context_compatible: null,
        independently_verified: false,
        qualification:
          'This is numerical agreement only. The reference account, dates, currency, timezone and attribution have not been verified.',
        reference_source: 'caller-provided reference; not independently fetched',
        reference: ref,
        differences,
        matched: differences.length > 0 && differences.every(r => r.matched === true),
        checked_at: Date.now(),
      };
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
      const budget = Number(decimal(scaled(options.planned_budget))),
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
      const target = Number(decimal(scaled(options.target_cpa))),
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
      const current = Number(decimal(scaled(options.current_daily_budget)));
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
      ],
    };
  }
}
