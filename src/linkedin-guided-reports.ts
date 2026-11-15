import {compileReport, linkedinReportPivots} from './workflows.js';
import {bad} from './workspace-core.js';
import {linkedinAllocationEvidence} from './linkedin-allocation-evidence.js';
import type {GuidedReporting} from './report-source.js';
import {linkedInDailyRange, linkedInReportDate} from './linkedin-reporting.js';
import {
  linkedInConversionUrn,
  linkedInConversionWindowSentinel,
  linkedInConversionWindows,
} from './linkedin-conversion-windows.js';
import {collectLinkedInEvidence} from './linkedin-evidence.js';
import {linkedInConversionEvidence} from './linkedin-conversion-evidence.js';
import {linkedinAllocationDraft} from './linkedin-allocation-draft.js';

/**
 * LinkedIn's guided reporting (ARC-04 stage F): its capture presets (UTC daily analytics by campaign group, campaign
 * and creative, and campaign × conversion with verified rule windows), the analytics read each defines and the checks
 * of its evidence rows. LinkedIn's report source declares it; src/report-presets.ts lists the presets and keeps the
 * shared checks.
 */
const presets = [
  ...[
    {
      id: 'linkedin_campaign_group',
      name: 'LinkedIn campaign group performance',
      level: 'campaign_group',
      grain: 'campaign group × day',
    },
    {id: 'linkedin_campaign', name: 'LinkedIn campaign performance', level: 'campaign', grain: 'campaign × day'},
    {id: 'linkedin_creative', name: 'LinkedIn creative performance', level: 'creative', grain: 'creative × day'},
  ].map(p => ({
    ...p,
    gateway: 'linkedin_native_action',
    max_rows: 10000,
    max_requests: 120,
    meaning:
      'Native UTC daily analytics with account identity and currency verified before and after collection under unchanged authorization. Keeps source references for both account checks and the single complete analytics response. Uses externalWebsiteConversions; attribution windows remain declared. Empty responses are ambiguous and cannot establish zero activity. No pagination; narrow oversized reports. Current month and previous five calendar months only.',
  })),
  {
    // RPT-07 (B18): windows verified per conversion rule instead of declared.
    id: 'linkedin_campaign_conversion',
    name: 'LinkedIn campaign conversions with verified rule windows',
    level: 'campaign_conversion',
    grain: 'campaign × conversion × day',
    gateway: 'linkedin_native_action',
    max_rows: 10000,
    max_requests: 120,
    meaning:
      'Native UTC daily conversions by campaign and conversion rule (statistics finder, CAMPAIGN and CONVERSION pivots) with post-click and post-view counts. In the same authorization bracket the account’s current conversion rules are read and each conversion is joined to its rule’s windows: verified_per_rule when all match, mixed when they differ (no single window), unknown when a rule is missing. Declare attribution verified_per_rule; windows are never typed. Spend, impressions and clicks are not split by conversion and stay unmapped. Empty or truncated (15,000-element) responses are refused. Current month and previous five calendar months only.',
  },
];

export const linkedinGuidedReporting: GuidedReporting = {
  presets,
  presetPrefix: 'linkedin_',
  // What amcp_reporting capture_preset help shows of LinkedIn's presets (R25 M0, owner 2026-11-15, observation 7 of the live checks).
  help: {
    preset: 'linkedin_campaign',
    account: '123456789',
    timezone: 'UTC',
    currency: 'USD',
    source: 'LinkedIn Campaign Manager analytics',
    rules: [
      'semantics.timezone must be UTC: LinkedIn reports its dates in UTC.',
      'The window lies in the current month and the previous five calendar months, through today in UTC: LinkedIn keeps daily rows for no longer.',
      'semantics.complete may be true or false. semantics.attribution names the attribution settings in text, or unknown when they are not established.',
      'The campaign × conversion preset (linkedin_campaign_conversion) takes semantics.attribution verified_per_rule: AMCP reads each conversion’s windows from its rule.',
      'An empty answer is refused as REPORT_EMPTY_AMBIGUOUS, because no activity and missing reporting access look alike; no zero is saved.',
    ],
  },
  // DEC-01: an allocation models campaign evidence kept with its original URNs, UTC daily analytics mapping and
  // verified account currency.
  allocation: {
    preset: 'linkedin_campaign',
    evidence: linkedinAllocationEvidence,
    entity: id => typeof id === 'string' && /^urn:li:sponsoredCampaign:[1-9][0-9]{0,19}$/.test(id),
  },
  presetRequest(preset, input, range) {
    if (typeof input.account_id !== 'string' || !/^[1-9][0-9]{0,31}$/.test(input.account_id))
      bad('Use the exact LinkedIn advertising account ID.');
    if (input.semantics.timezone !== 'UTC') bad('LinkedIn analytics dates require UTC.');
    linkedInDailyRange(range.since, range.until);
    if (preset.level === 'campaign_conversion') {
      // RPT-07: windows come from the conversion rules read in the same bracket; a typed window is never accepted.
      if (input.semantics.attribution !== linkedInConversionWindowSentinel)
        bad(
          'LinkedIn conversion windows are read from each conversion rule. Declare attribution verified_per_rule; a typed single window is not accepted.',
          'REPORT_ATTRIBUTION_DECLARED',
        );
      const tuple = (date: string) => {
        const [y, m, d] = date.split('-').map(Number);
        return `(year:${y},month:${m},day:${d})`;
      };
      return {
        gateway: preset.gateway,
        account_id: input.account_id,
        connection_id: input.connection_id,
        arguments: {
          action: 'linkedin_rest_ad_analytics_get',
          query: {
            q: 'statistics',
            pivots: 'List(CAMPAIGN,CONVERSION)',
            accounts: 'List(urn:li:sponsoredAccount:' + input.account_id + ')',
            timeGranularity: 'DAILY',
            dateRange: `(start:${tuple(range.since)},end:${tuple(range.until)})`,
            fields: [
              'dateRange',
              'pivotValues',
              'externalWebsiteConversions',
              'externalWebsitePostClickConversions',
              'externalWebsitePostViewConversions',
              'conversionValueInLocalCurrency',
            ].join(','),
          },
          aggregate_pages: false,
        },
        semantics: {...input.semantics, conversion_definition: 'externalWebsiteConversions by conversion rule'},
        rows_pointer: '/data/data/elements',
        mapping: {
          entity_id: '/pivotValues/0',
          native_conversion: '/pivotValues/1',
          date: {path: '/dateRange/start', format: 'linkedin_utc_date'},
          conversions: '/externalWebsiteConversions',
          post_click_conversions: '/externalWebsitePostClickConversions',
          post_view_conversions: '/externalWebsitePostViewConversions',
          conversion_value: '/conversionValueInLocalCurrency',
        },
      };
    }
    const level = Object.entries(linkedinReportPivots).find(
      ([, pivot]) => pivot === String(preset.level).toUpperCase(),
    )?.[0];
    const native = compileReport({
      platform: 'linkedin',
      account_id: input.account_id,
      date_range: range,
      level,
      granularity: 'day',
    });
    return {
      gateway: native.gateway,
      account_id: input.account_id,
      connection_id: input.connection_id,
      arguments: {...native.input, aggregate_pages: false},
      semantics: {...input.semantics, conversion_definition: 'externalWebsiteConversions'},
      rows_pointer: '/data/data/elements',
      mapping: {
        entity_id: '/pivotValues/0',
        date: {path: '/dateRange/start', format: 'linkedin_utc_date'},
        spend: '/costInLocalCurrency',
        impressions: '/impressions',
        clicks: '/clicks',
        conversions: '/externalWebsiteConversions',
        conversion_value: '/conversionValueInLocalCurrency',
      },
    };
  },
  /** Guided evidence must retain its requested native hierarchy, reporting window and grain. */
  validateRows(preset, input, rows) {
    if (!rows.length)
      bad(
        'LinkedIn returned no rows. No activity and missing reporting access cannot be distinguished; no zero-performance evidence was saved.',
        'REPORT_EMPTY_AMBIGUOUS',
      );
    const kind: Record<string, string> = {
      linkedin_campaign_group: 'sponsoredCampaignGroup',
      linkedin_campaign: 'sponsoredCampaign',
      linkedin_creative: 'sponsoredCreative',
      linkedin_campaign_conversion: 'sponsoredCampaign',
    };
    const pattern = new RegExp('^urn:li:' + kind[preset] + ':[1-9][0-9]{0,31}$'),
      // RPT-07: the conversion preset pivots by campaign and conversion; pivotValues follow the requested order.
      conversion = preset === 'linkedin_campaign_conversion',
      seen = new Set<string>();
    for (const row of rows) {
      if (
        !row ||
        typeof row !== 'object' ||
        !Array.isArray(row.pivotValues) ||
        row.pivotValues.length !== (conversion ? 2 : 1) ||
        typeof row.pivotValues[0] !== 'string' ||
        !pattern.test(row.pivotValues[0]) ||
        (conversion && (typeof row.pivotValues[1] !== 'string' || !linkedInConversionUrn.test(row.pivotValues[1])))
      )
        bad('LinkedIn did not return the requested native entity pivot.', 'REPORT_SHAPE_CHANGED');
      const date = linkedInReportDate(row.dateRange?.start);
      if (
        date !== linkedInReportDate(row.dateRange?.end) ||
        date < input.semantics.date_from ||
        date > input.semantics.date_to
      )
        bad('LinkedIn returned a different reporting period or grain.', 'REPORT_DATE_MISMATCH');
      const key = row.pivotValues.join('|') + ':' + date;
      if (seen.has(key)) bad('LinkedIn returned duplicate entity/day rows.', 'REPORT_DUPLICATE_ROWS');
      seen.add(key);
    }
  },
  // ARC-01 (reporting): a capture of a LinkedIn preset reads one complete bounded analytics response, bracketed by
  // account and authorization checks, and checks its rows before the last check (src/linkedin-evidence.ts).
  collect: ({store, call, actor, args, semantics, validateRows}) =>
    collectLinkedInEvidence(store, call, actor, args, semantics, validateRows),
  sourceCollection: 'linkedin_analytics',
  collectorChecksRows: true,
  semanticsSource: preset =>
    preset === 'linkedin_campaign_conversion'
      ? "LinkedIn account identity and currency verified before and after a complete bounded campaign × conversion analytics response and the account's current conversion rules, all under unchanged authorization; each conversion's post-click and post-view windows come from its current rule (verified_per_rule, mixed or unknown). Rule settings are current, not historical. Reporting-window completeness remains declared. Collection is not a point-in-time snapshot."
      : 'LinkedIn account identity and currency verified before and after a complete bounded analytics response with unchanged authorization; UTC dates and externalWebsiteConversions from the native request; attribution windows and completeness explicitly declared, not independently verified. Collection is not a point-in-time snapshot.',
  // A mapping may read the report date from LinkedIn's UTC date range.
  dateFormats: {linkedin_utc_date: linkedInReportDate},
  // The conversion a campaign × conversion row retains is an exact conversion rule URN of a LinkedIn capture.
  dimensionChecks: {
    native_conversion: {
      valid: (value, capture) =>
        capture.gateway === 'linkedin_native_action' && typeof value === 'string' && linkedInConversionUrn.test(value),
    },
  },
  // RPT-07 (B18): the conversion preset joins every reported conversion to its current rule's windows. The rules are
  // read after the analytics response and before the bracket's final authorization check, so both reads share it.
  conversionRules: {
    preset: 'linkedin_campaign_conversion',
    async read({store, call, actor}, capture) {
      const rules = await linkedInConversionEvidence(store, call, actor, capture);
      return {
        currency: rules.account_evidence?.currency,
        join: conversions => linkedInConversionWindows(rules.rules, conversions),
        provenance: () => ({
          rules_source_hash: rules.source_hash,
          rules_captured_at: rules.captured_at,
          rule_count: rules.rule_count,
          rule_source_pages: rules.source_pages,
          rule_account_checks: rules.account_evidence.checks,
        }),
      };
    },
  },
  // Wave 4c round 6 (w4c-arc6-reporting): DEC-02's native budget draft of the allocation model (campaign budgets).
  allocationDraft: linkedinAllocationDraft,
};
