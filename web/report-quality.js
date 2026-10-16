function renderReportReconciliation(out) {
  const labels = {
    spend: uiText('Spend'),
    impressions: uiText('Impressions'),
    clicks: uiText('Clicks'),
    conversions: uiText('Conversions'),
    conversion_value: uiText('Conversion value'),
  };
  const value = v => (v === null || v === undefined ? esc(uiText('Unknown')) : `<bdi dir="ltr">${esc(v)}</bdi>`);
  const withinTolerance = out.matched && out.differences.some(d => d.difference !== null && Number(d.difference) !== 0);
  const retained = out.comparison_kind === 'retained_reports' && out.context_compatible === true;
  const declared = out.comparison_kind === 'declared_reference' && out.context_compatible === true;
  return `<section class="panel"><h2>${esc(uiText('Reconciliation'))}</h2><p class="notice">${esc(declared ? uiText('Declared reference settings align. The file provenance, entities, filters and attribution rules have not been independently verified.') : retained ? uiText('Retained report settings align. These are saved measurement declarations, not independent verification of provider attribution or an external export.') : uiText('Numerical agreement only. The reference account, dates, currency, timezone and attribution have not been checked.'))}</p><p><strong>${esc(out.matched ? (withinTolerance ? uiText('Compared totals agree within tolerance') : uiText('Compared totals match')) : uiText('Review differences or missing values'))}</strong></p><div class="data-scroll"><table class="review-table"><caption>${esc(uiText('Exact differences: current report minus reference'))}</caption><thead><tr><th scope="col">${esc(uiText('Metric'))}</th><th scope="col">${esc(uiText('Current report'))}</th><th scope="col">${esc(uiText('Reference'))}</th><th scope="col">${esc(uiText('Difference'))}</th><th scope="col">${esc(uiText('Tolerance'))}</th><th scope="col">${esc(uiText('Result'))}</th></tr></thead><tbody>${out.differences.map(d => `<tr><th scope="row">${esc(labels[d.metric] ?? d.metric)}</th><td>${value(d.actual)}</td><td>${value(d.reference)}</td><td>${value(d.difference)}</td><td>${value(d.tolerance ?? out.reference?.tolerance?.[d.metric] ?? '0')}</td><td>${esc(d.matched === null ? uiText('Unknown') : d.matched ? (d.difference !== null && Number(d.difference) !== 0 ? uiText('Within tolerance') : uiText('Matches')) : uiText('Differs'))}</td></tr>`).join('')}</tbody></table></div>${recordDetails(out, uiText('Comparison sources and definitions'))}</section>`;
}
// Exact authored explanations only; provider diagnostics and user content retain their original text.
const reportExplanationMessages = new Set([
  'Select 1–50 distinct native Google campaign IDs.',
  'The selected login lost permissions. Preview the allocation again.',
  'Google campaign budgets or account metadata changed during allocation inspection. Preview again.',
  'A native budget changed since preview. Inspect a new preview before creating the draft.',
  'A recent change or seasonal event may explain this result. Review the supplied context before changing budgets.',
  'Account currencies, timezones, attribution and conversion definitions remain separate.',
  'Ad-squad evidence must have one row per ad squad/day inside the declared period.',
  'Assumes unchanged prices, auction conditions, targeting, creative and measurement. Actual delivery can differ.',
  'At most 100 current allocation previews may be retained.',
  'Attribution, conversion lag and source mappings must be verified before acting.',
  'Budgets cover a comparable period with the same number of days as the evidence. They are not native daily or lifetime budgets.',
  'Campaign evidence must have one row per campaign/day inside the declared period.',
  'Capture a guided Google, Meta or LinkedIn campaign-by-day report, or a Snapchat ad-squad-by-day report, before modeling allocations.',
  'Check current campaign budgets and prepare a separate reviewed change. This proposal uses caller-declared budget values.',
  'Choose distinct ad-squad IDs from this retained report.',
  'Choose distinct campaign IDs from this retained report.',
  "Choose this session's exact allocation preview.",
  'Confirm attribution and the primary conversion definition before making budget recommendations.',
  'This campaign’s ad groups optimize for different events, so its conversions are not one result. Review each ad group before acting on cost per result.',
  'Confirm this campaign’s objective and primary result metric.',
  'Confirm this exact conversion before creating its unapproved draft.',
  'Declare a minimum of 1–1,000,000 observed conversions per ad squad and an evidence age of 1–90 days.',
  'Declare a minimum of 1–1,000,000 observed conversions per campaign and an evidence age of 1–90 days.',
  'Declare efficiency factors with 0 < low ≤ high ≤ 10.',
  'Draft creation lost its current preview.',
  'Each floor must be at most its cap, and each cap at most 1 trillion.',
  'Every Snapchat daily budget must meet the documented minimum of 5000000 native micros.',
  'Every converted daily budget must be positive and within the exact allocation precision limit.',
  'Every selected ad squad needs known positive spend and the declared minimum conversions. Narrow the selection or collect enough evidence.',
  'Every selected campaign needs known positive spend and the declared minimum conversions. Narrow the selection or collect enough evidence.',
  'Evidence dates must increase.',
  'Explicitly choose equal_daily conversion. Period totals are not native daily budgets.',
  'Heuristic evidence, not a causal estimate or performance guarantee.',
  'Illustrative constrained sensitivity model, not a forecast or statistical confidence interval.',
  'Illustrative sensitivity model, not a forecast or a statistical confidence interval.',
  'Inspect creative, audience, placement and delivery changes before replacing this creative.',
  'Investigate budget, schedule and targeting changes.',
  'Linear response ignores saturation, auction changes, audience overlap, creative changes and causal incrementality. Caps are user assumptions, not verified provider limits.',
  'LinkedIn account metadata changed during allocation inspection. Preview again.',
  'LinkedIn campaign configuration changed during allocation inspection. Preview again.',
  'LinkedIn campaign-group configuration changed during allocation inspection. Preview again.',
  'LinkedIn returned incomplete, ambiguous or oversized native budget evidence.',
  'Measurement and organic reports provide context; they do not establish an advertising budget action.',
  'Measurement completeness and timezone retain the original report declarations; the minimum conversion threshold is a user assumption, not statistical significance.',
  'Native allocation drafts qualify Google dedicated campaign budgets, LinkedIn independent campaign daily budgets, Meta campaign or single-ad-set daily budgets and Snapchat ad-squad daily budgets. Other budget modes need their separate native planning flow.',
  // DEC-02: the Meta budget binding (meta-allocation-budgets.ts).
  'Meta budgets count in the account currency’s minor unit, and AMCP has no pinned Meta offset for this currency. Pin Meta’s currency table before converting an allocation; nothing was read or saved.',
  'Preview only. Each Meta daily budget is set on its current owner: the campaign when it has a campaign daily budget, otherwise its one spending ad set. Amounts are whole Meta minor units of the account currency, rounded down; residuals are shown. Meta can spend up to 75% more than a daily budget on a day with better opportunities and at most seven times it over a calendar week. Daily budgets remain in effect until changed; this draft sets no end date and does not approve or execute any change.',
  'Retain exact nonnegative Meta budget amounts in the account currency’s minor unit.',
  'Select at most 20 exact Meta campaign IDs from this account’s verified report.',
  'Meta returned failed, incomplete or oversized budget evidence.',
  'Meta returned a malformed account collection.',
  'Meta returned an object from another account.',
  'Meta ownership lookup repeated or exceeded its bounded pages.',
  'Every selected Meta object must be observed in this account’s own collection.',
  'Use an active Meta account with the exact report identity, currency and time zone.',
  'Use an owned active or paused Meta campaign in the report account.',
  'Only auction Meta campaigns qualify; reserved buying needs its own planning flow.',
  'This Meta campaign has more ad sets than one bounded read covers; its budget ownership is unknown.',
  'Meta returned a malformed, repeated or foreign ad set.',
  'Meta returned an ad set from another account.',
  'This Meta campaign has a lifetime campaign budget; lifetime budgets need their own planning flow.',
  'This Meta campaign reports a campaign budget and ad-set budgets at once; its budget ownership is ambiguous.',
  'This Meta campaign keeps its budget on several ad sets (or none). Allocating between ad sets needs ad-set evidence; no budget was chosen for you.',
  'The ad set that owns this Meta campaign’s budget uses a lifetime budget; it needs its own planning flow.',
  'Meta budget ownership changed during allocation inspection. Preview again.',
  'Meta campaign or ad-set budgets changed during allocation inspection. Preview again.',
  'Meta account metadata changed during allocation inspection. Preview again.',
  'No live budget or approval is created. Any later change needs current native budget ownership, units, eligibility, preflight and a separate reviewed plan.',
  'Observational comparison; no causal lift or seasonal adjustment is inferred.',
  'Observational evidence does not establish causality or adjust for seasonality.',
  'Performance is below target. Consider a bounded budget reduction and diagnose the cause.',
  'Performance is close to the configured target. Maintain delivery and monitor.',
  'Performance is comfortably above target. Consider a bounded budget increase after checking capacity and recent changes.',
  'Performance is materially below target. Review tracking, targeting and creative before deciding whether to pause.',
  'Performance supports growth, but a confirmed capacity or budget constraint prevents increasing delivery.',
  'Preview only. Daily amounts round down to the smallest unit of the account currency; residuals are shown. These are ongoing average daily budgets, not a scheduled period spending cap. Creating a draft does not approve or execute it.',
  'Preview only. Daily amounts round down to the smallest unit of the account currency; residuals are shown. These are ongoing daily budgets, not a scheduled period spending cap. Creating a draft does not approve or execute it.',
  'Preview only. LinkedIn native daily budgets use decimal account-currency amounts, rounded down to the smallest unit of the currency and checked against LinkedIn’s daily budget limits for the account when it states them. Rounding residuals are shown. Daily settings remain in effect until changed, and LinkedIn can charge up to 150% of a daily budget on a day with strong auction opportunities. Existing group caps are preserved. This draft sets no end date or automatic period spending cap, and does not approve or execute any change.',
  'Reach and frequency are not summed. Calculated ratios come from compatible additive totals.',
  'Recommendations are advisory; a separate review is required for advertising changes.',
  'Refresh a complete reporting window before acting.',
  'Refresh complete data with verified currency and timezone before recommending a change.',
  'Retain an active LinkedIn account with the exact report identity and currency.',
  'Retain exact LinkedIn decimal budget amounts in the account currency, with at most six decimal places.',
  'Retain exact Snapchat campaign ownership and ad-squad source evidence.',
  'Retain exact native ad-squad IDs.',
  'Retain exact native campaign IDs.',
  'Retain one complete current budget row per selected campaign.',
  'Retain the original LinkedIn campaign URNs, UTC daily analytics mapping and verified account currency evidence.',
  'Retain valid evidence dates.',
  'Review conversion lag and targeting before preparing a bid or budget change.',
  'Review delivery and budget pacing.',
  'Review relevance and conversion lag before preparing an exact negative keyword.',
  'Review whether delivery can meet the planned budget.',
  'Rounding this allocation down to the smallest amount of the account currency per day would fall below a selected period floor. Adjust the model bounds.',
  'The report names no ISO currency, so daily budgets cannot be rounded to an amount the account can be charged.',
  'A converted daily budget is outside the daily budget limits LinkedIn states for this account. Adjust the model bounds.',
  'Select 2–50 distinct ad squads and supply a floor and cap for each.',
  'Select 2–50 distinct campaigns and supply a floor and cap for each.',
  'Select at most 20 exact LinkedIn campaign URNs from this account’s verified UTC report.',
  'Spend exceeded three target acquisition costs with no reported results. Check tracking and conversion lag, then consider pausing.',
  'The allocation contains an unchanged daily budget; adjust the modeled selection before creating a plan.',
  'The allocation source changed. Model and preview a new draft.',
  'The campaign budget or its ownership changed after the allocation preview. Create a fresh preview; no write was submitted.',
  'The campaign plan changed during the budget check. Refresh it before continuing.',
  'The draft differs from the exact allocation preview.',
  'The draft is missing its original allocation binding.',
  'The local draft engine is unavailable.',
  'The preview expired. Read current budgets and preview again.',
  'The reporting window is still inside the configured conversion-lag period.',
  'The reporting window needs an unambiguous account timezone boundary.',
  'The secondary KPI is unavailable or below its target. Resolve the conflicting evidence before changing delivery.',
  'The selected login changed. Preview the allocation again.',
  'The supplied daily budget limit leaves no room for an increase.',
  'The target currency must match the campaign account currency.',
  'These scenarios never change budgets, activate campaigns or create an approval.',
  'This draft is already being created. Inspect or retry its original preview.',
  'This login requires LinkedIn reporting and advertising write permission for an allocation draft.',
  'This step no longer matches its allocation proposal. Create a new source-bound draft.',
  'Tracking is marked unverified. Resolve measurement before changing delivery.',
  'Use a LinkedIn campaign group without dynamic budget optimization or a group daily budget. Preserve any existing group total cap.',
  'Use a closed reporting period within your declared evidence-age limit. A fresh capture cannot make old dates recent.',
  'Use a positive total budget up to 1 trillion.',
  'Use an offset >= 0 and page size 1–100.',
  'Use an owned active or paused LinkedIn campaign with an independent daily budget. Lifetime, accelerated, shared or unknown budget modes need a separate native review.',
  'Use at most 10,000 retained daily ad-squad rows.',
  'Use at most 10,000 retained daily campaign rows.',
  'Use current, dedicated daily budgets in the report account, currency and timezone. Shared, lifetime, removed or ambiguous budgets need their own native review.',
  'Use positive LinkedIn budget amounts within the exact allocation precision limit.',
  'Use recent complete evidence with known currency, attribution and conversion definitions.',
  'Use the native IANA reporting timezone.',
  "Use this session's current confirmed allocation preview.",
  'Wait for enough results to distinguish a signal from a small sample.',
  'Calibration needs exact known daily spend and conversions; missing values are not zero.',
  'Choose 7–21 training days, 1–1,000,000 minimum training conversions and a central share of 50, 60, 70, 80 or 90 percent.',
  'Choose 1–20 distinct original report entity IDs for calibration.',
  'Calibration needs 14–31 consecutive closed days, including at least seven test days after the selected training window.',
  'Retain the original report source SHA-256 for calibration.',
  'Choose calibration IDs from this exact retained report.',
  'Every selected entity needs one explicit row for every calendar day. Missing days are not zero.',
  'Historical factors fit the allocation input bounds. Inspect them before applying.',
  'Historical factors cannot be applied: at least seven known ratios, no unknown test days and positive factors at most ten are required. No values were clipped.',
  'Retrospective one-day diagnostics conditioned on the actual test-day spend, not a forecast of future spend, delivery or causal budget effects.',
  'Each test uses only the selected preceding training days. The held-out conversion count is never used to fit that test estimate.',
  'Nearest-rank empirical factor quantiles describe these observed test days. The central share is not a confidence level or a guarantee of future coverage.',
  'The factor envelope uses the lowest entity low and highest entity high. It is not pooled campaign attribution or an account-wide probability interval.',
  'Zero predictions, insufficient training and missing ratios remain explicit. Factors outside allocation bounds are not clipped or silently applied.',
  'Original currency, timezone, attribution, conversion lag, completeness declarations and exact entity identity remain unchanged. Auction, creative and measurement changes can invalidate this history.',
  'Calibration arithmetic truncates metrics to nine decimal places; factor bounds round outward to six. No provider read, saved change, native plan or advertising mutation is made.',
  'Declare an evidence age of 1–90 days.',
  'Provider values with more than nine decimal places were rounded half to even to nine places. Each rounded value differs from the provider value by at most 0.0000000005, so totals can differ slightly from provider totals.',
  'The reporting window includes a day that has not ended in the source time zone. Wait until it closes.',
  'The reporting window was declared incomplete or its measurement is incomplete. Collect a complete window before recommending a change.',
  'Set whether higher or lower is better for this target KPI (direction) before recommending a change.',
  'No spend, or less than the minimum spend, in this window. Wait for delivered spend before recommending a change.',
  'Recommendations in this snapshot have expired. Refresh the report before acting on them.',
  'The baseline window is not declared complete; comparisons with it (spend anomaly, creative fatigue) may reflect missing baseline data.',
  'The paired previous-period baseline could not be used, so no baseline was applied.',
  // DEC-02: allocation factor provenance and indicators.
  'The efficiency factors were entered directly, without a retained calibration; they are assumptions with no historical provenance.',
  'The efficiency factors come from a one-day, spend-conditioned calibration of this report. The allocation applies them to a multi-day period at new spend levels, which that calibration did not test.',
  'At least one proposed daily average lies outside the daily spend observed in the evidence, so the linear model is extrapolating there.',
  'Name the calibration the efficiency factors came from, or omit factor_source.',
  'The named calibration does not match this report’s current evidence. Calibrate again before using its factors.',
  'The efficiency factors differ from the named calibration. Use its factors unchanged, or omit factor_source.',
  'Every allocated entity must be one the named calibration evaluated.',
]);
/** DEC-01: frozen recommendations show their as-of time, and are flagged expired at display time after 48 hours. */
function reportRecommendationAsOf(row) {
  const r = row.recommendation ?? {},
    asOf = typeof r.as_of === 'number' ? r.as_of : row.captured_at,
    validUntil =
      typeof r.valid_until === 'number'
        ? r.valid_until
        : typeof row.captured_at === 'number'
          ? row.captured_at + 48 * 3600000
          : null;
  if (typeof asOf !== 'number') return '';
  const expired = validUntil !== null && Date.now() > validUntil;
  return `<small class="recommendation-as-of">${esc(uiText('As of {date}', {date: date(asOf)}))}${expired ? ` · <strong>${esc(uiText('Expired — refresh before acting'))}</strong>` : ''}</small>`;
}
// Collector warnings AMCP authors for a source's reporting window (RPT-02); other warnings stay as written.
const reportSourceWarnings = new Set([
  'Includes an in-progress day: the last reporting day has not ended in the source time zone. The source stays partial and recommendations wait until it closes.',
  'The reporting window was declared incomplete. The source stays partial and recommendations are held until a complete window is collected.',
  // RPT-03 and RPT-04 collection notices.
  'X refused the active-entities read; every listed campaign was requested instead (at most 100 analytics requests).',
  'The provider refused one day-segmented request, so each day was requested separately.',
  'Search Console returned the 10,000-row request limit; lower-ranked pages are not included, so this organic context is partial.',
  'Microsoft did not return a recognized account time zone, so report days use GreenwichMeanTimeDublinEdinburghLisbonLondon (Europe/London, including daylight saving).',
  'TikTok campaign reporting covers auction campaigns only (AUCTION_CAMPAIGN); Reach & Frequency and other reserved campaigns are not included.',
  'TikTok ad group optimization events could not be read, so conversions use one generic result definition and campaigns optimizing for different events are not told apart.',
  // RPT-07: LinkedIn campaign names and objectives come from a current metadata read.
  'LinkedIn campaign names and objectives could not be read, so rows show campaign IDs and objectives stay unknown unless confirmed in report settings.',
  'LinkedIn conversion-rule attribution windows are not independently verified; the verified-window preset is linkedin_campaign_conversion. Campaign names and objectives are current campaign metadata, not the values at delivery time.',
  'LinkedIn conversion-rule attribution windows are not independently verified. Campaign objectives should be confirmed in report settings.',
  // RPT-07: native parents of detailed TikTok, Snapchat-ad and LinkedIn-creative rows (overview-parents.ts).
  'Native parents could not be read for this source, so its rows show entity IDs without parent campaigns or ad groups.',
  'This source reports more than 1000 entities, so the parents of entities beyond that bound stay unknown.',
]);
// Collector notices that carry a count or a field name (RPT-03, RPT-04). English keeps the collector's own sentence;
// another language fills the same exact value into its translated template.
const reportSourceWarningTemplates = [
  [
    /^Requested native metric (\S{1,150}) was not returned as a number; formulas that use it stay unavailable\. Check the field name for this provider\.$/,
    m =>
      uiText(
        'Requested native metric {name} was not returned as a number; formulas that use it stay unavailable. Check the field name for this provider.',
        {name: m[1]},
      ),
  ],
  [
    /^(\d{1,7}) X campaigns? (?:has|have) no reported activity in this window \(X active entities\)\. They are not listed and are never counted as zero\.$/,
    m =>
      uiText(
        'X campaigns with no reported activity in this window (X active entities): {count}. They are not listed and are never counted as zero.',
        {count: uiNumber(Number(m[1]))},
      ),
  ],
  [
    /^(\d{1,7}) active X campaigns? (?:is|are) missing from the campaign list; (?:it is|they are) shown by ID\.$/,
    m =>
      uiText('Active X campaigns missing from the campaign list, shown by ID: {count}.', {
        count: uiNumber(Number(m[1])),
      }),
  ],
];
function uiSourceWarning(value) {
  if (reportSourceWarnings.has(value)) return uiText(value);
  const text = String(value ?? '');
  if (typeof uiLocale === 'string' && uiLocale !== 'en')
    for (const [pattern, translate] of reportSourceWarningTemplates) {
      const match = pattern.exec(text);
      if (match) return translate(match);
    }
  return text;
}
function uiReportExplanation(value) {
  return reportExplanationMessages.has(value) ? uiText(value) : String(value ?? '');
}
function uiRecommendationReason(recommendation) {
  const message = recommendation.reason_localization;
  if (
    recommendation.decision === 'needs_target' &&
    message?.key === 'target_required' &&
    typeof message.kpi === 'string' &&
    typeof message.currency === 'string'
  )
    return uiText('Set a {kpi} target in {currency} for this objective or campaign.', {
      kpi: message.kpi,
      currency: message.currency,
    });
  return uiReportExplanation(recommendation.reason);
}
const reportAnalysisLabels = {
  data_quality: 'Data quality',
  budget_pacing: 'Budget pacing',
  search_waste: 'Search waste',
  possible_creative_fatigue: 'Possible creative fatigue',
  cpa_above_target: 'CPA above target',
  spend_anomaly: 'Spend anomaly',
  bounded_budget_proposal: 'Bounded budget proposal',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};
function uiAnalysisLabel(value) {
  return Object.hasOwn(reportAnalysisLabels, value)
    ? uiText(reportAnalysisLabels[value])
    : String(value ?? '').replaceAll('_', ' ');
}
function reportTargetContext(objective, context = {}) {
  const flag = (key, label) =>
    `<label>${label}<select data-target-context="${objective}:${key}">${[
      ['', uiText('Not supplied')],
      ['true', uiText('Yes')],
      ['false', uiText('No')],
    ]
      .map(
        ([value, text]) =>
          `<option value="${value}" ${String(context[key] ?? '') === value ? 'selected' : ''}>${text}</option>`,
      )
      .join('')}</select></label>`;
  return `<details><summary>${esc(uiText('Business context and constraints'))}</summary><div class="target-fields"><label>${esc(uiText('Context note'))}<textarea maxlength="1000" data-target-context="${objective}:note">${esc(context.note ?? '')}</textarea></label><label>${esc(uiText('Seasonal event or promotion'))}<input maxlength="1000" data-target-context="${objective}:seasonal_event" value="${esc(context.seasonal_event ?? '')}"></label>${flag('recent_change', uiText('Recent campaign or business change?'))}${flag('tracking_verified', uiText('Tracking verified?'))}${flag('capacity_available', uiText('Capacity available for growth?'))}${flag('budget_available', uiText('Budget available for growth?'))}<label>${esc(uiText('Current daily budget'))}<input type="number" min="0" step="any" data-target-context="${objective}:current_daily_budget" value="${context.current_daily_budget ?? ''}"></label><label>${esc(uiText('Maximum daily budget'))}<input type="number" min="0" step="any" data-target-context="${objective}:maximum_daily_budget" value="${context.maximum_daily_budget ?? ''}"></label><label>${esc(uiText('Secondary KPI'))}<select data-target-secondary="${objective}:kpi"><option value="">${esc(uiText('None supplied'))}</option>${['roas', 'cpa', 'ctr', 'conversion_rate', 'cpc'].map(k => `<option value="${k}" ${context.secondary_kpi?.kpi === k ? 'selected' : ''}>${k.toUpperCase()}</option>`).join('')}</select></label><label>${esc(uiText('Secondary target'))}<input type="number" min="0.000001" step="any" data-target-secondary="${objective}:target" value="${context.secondary_kpi?.target ?? ''}"></label><label>${esc(uiText('Secondary direction'))}<select data-target-secondary="${objective}:direction"><option value="higher" ${context.secondary_kpi?.direction === 'higher' ? 'selected' : ''}>${esc(uiText('Higher is better'))}</option><option value="lower" ${context.secondary_kpi?.direction === 'lower' ? 'selected' : ''}>${esc(uiText('Lower is better'))}</option></select></label></div><p class="form-note">${esc(uiText('Context is supplied by you. AMCP does not infer seasonal effects or causal impact.'))}</p></details>`;
}
function readTargetContext(objective) {
  const out = {};
  for (const el of document.querySelectorAll('[data-target-context]')) {
    const [id, key] = el.dataset.targetContext.split(':');
    if (id !== objective || el.value === '') continue;
    out[key] = ['current_daily_budget', 'maximum_daily_budget'].includes(key)
      ? Number(el.value)
      : ['recent_change', 'tracking_verified', 'capacity_available', 'budget_available'].includes(key)
        ? el.value === 'true'
        : el.value;
  }
  const s = {};
  for (const el of document.querySelectorAll('[data-target-secondary]')) {
    const [id, key] = el.dataset.targetSecondary.split(':');
    if (id === objective) s[key] = key === 'target' ? Number(el.value) : el.value;
  }
  if (s.kpi) out.secondary_kpi = s;
  return out;
}
function reportQualityDetails(source, report) {
  const q = source.quality;
  // RPT-05: a failed source records no quality metadata. "Legacy" is kept for snapshots from before source contracts.
  if (!q)
    return `<p class="form-note">${esc(
      source.error
        ? uiText('No quality metadata — source failed.')
        : report?.config?.source_contract_version
          ? uiText('Measurement-quality metadata was not recorded for this source.')
          : uiText('Legacy snapshot: measurement-quality metadata was not recorded.'),
    )}</p>`;
  const labels = [
    q.sampled ? uiText('Sampled') : '',
    q.thresholded ? uiText('Thresholded') : '',
    q.data_loss ? uiText('Aggregation loss') : '',
    q.truncated ? uiText('Truncated by GA4') : '',
    q.restricted_metrics?.length ? uiText('Restricted: {metrics}', {metrics: q.restricted_metrics.join(', ')}) : '',
    q.metric_rounding ? uiText('Provider values rounded to nine decimal places') : '',
    q.reporting_window_declared_complete === false ? uiText('Reporting window declared incomplete') : '',
    q.open_window ? uiText('Includes an in-progress day') : '',
    q.scope_limitations?.includes('ga4_unattributed_sessions')
      ? uiText('Scope limit: sessions without a GA4 campaign ID')
      : '',
    q.scope_limitations?.includes('search_console_top_rows') ? uiText('Scope limit: Search Console top rows only') : '',
    q.omitted_as_zero?.length
      ? uiText('Counted as 0 where the provider omitted the value: {metrics}', {metrics: q.omitted_as_zero.join(', ')})
      : '',
  ].filter(Boolean);
  return `<p class="form-note">${esc(labels.join(' · ') || uiText('No additional source-quality flags recorded.'))}</p><details><summary>${esc(uiText('Quality and source evidence'))}</summary><pre>${esc(JSON.stringify({quality: q, lineage: source.lineage, query_fingerprint: source.query_fingerprint}, null, 2))}</pre></details>`;
}
function refreshRecentReports(report) {
  overviewState.history = [
    {...report, rows: undefined},
    ...overviewState.history.filter(r => r.id !== report.id),
  ].slice(0, 50);
  const section = document.querySelector('.report-history');
  if (!section) return;
  section.innerHTML = renderOverviewHistory(
    overviewState.history,
    typeof session !== 'undefined' && session.workspaceRole === 'viewer',
  );
  bindOverviewHistory();
}
