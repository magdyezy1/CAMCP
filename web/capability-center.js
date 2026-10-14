'use strict';
const capabilityContractMessages = new Set([
  'No provider request mapping exists. The advertised name is not executable.',
  'The provider documents this method as no longer supported. Retained in the denominator; no replacement API is invented.',
  'A mapped route passes independent read classification. Exact scope, payload, pagination and account/provider access still require verification.',
  'Documented fixed GET semantics override ambiguous resource names; Business/Catalog/member resources still require exact administrator bindings.',
  'Native advertiser-scoped POST search for geo regions, POIs and business chains; exact body variants, current scopes, bounded pagination and explicit completeness. It creates no targeting assignments.',
  'Native JSON potential-audience range, bounded criteria and private-reference reads, current account/login authority and explicit non-additive estimate semantics; no targeting or ad mutation.',
  'Original AMCP job/account/connection/app-user binding; fresh native status and bounded server-only gzip retrieval with encrypted result recovery, exact row identity and explicit incomplete output.',
  'Exact original task/advertiser/connection/token binding; bounded untranslated CSV_STRING retrieval with fresh status, row/date checks and explicit pending/failed/cancelled states.',
  'Fixed draft-generation RPC: native required inputs and oneofs, selected Ads scope, one attempt and explicit no-output semantics. It does not save assets or apply recommendations. Text/image generation requires provider closed-beta access.',
  'Route belongs to a reviewed family. Only amcp_write inspect with the exact payload can establish request support; family fixtures do not test every field or variant.',
  'Use amcp_media or the native Drive import bridge. Raw native upload variants are not thereby enabled.',
  'Captured read metadata did not pass independent read-only classification. This route cannot execute without a specific risk contract.',
  'Mapping exists, but there is no reviewed write family. Add exact scope, prerequisites, state projection, spending rules, receipt, recovery and negative tests before execution.',
  'An explicit legacy adapter exists, but its route depends on the requested scope/type. Inspect the exact payload; each selected destination retains its own reviewed contract.',
  'Implemented AMCP workflow; platform and payload support depend on its underlying contracts. This row never enables native writes.',
  'AMCP scoped read-only configuration audit or local reviewed-write verification job status. This workflow never publishes or resubmits a mutation.',
  'Implemented local retirement-status diagnostic. Google discontinued Q&A on 2025-11-03; no Q&A provider request or replacement API is available.',
  'Read-only tenant-scoped connection metadata with explicit/default identity resolution; no credential access, provider request or implicit connection/grant changes. Recorded configuration is not live readiness.',
  'Administrator-scoped GA4 properties or Search Console sites discovery with dry-run default, bounded native GETs and atomic complete metadata persistence. Preserves selections/write grants; scopes, login, concurrent sync and current authority are fenced. No OAuth grant change or provider mutation.',
  'Administrator-scoped Business Profile account and optional location discovery. Bounded native GETs, required read mask, shared location parents, current authority and per-attempt login fencing; complete groups persist atomically without changing selections or grants. Website Connections uses the same discovery; no OAuth grant change or provider mutation.',
  'Scoped Adjust app/event/filter discovery and bounded native JSON or app-indexed pivot reporting. Encrypted token transport, current grants, exact numeric strings, documented no-content, warning/completeness metadata and no provider writes. Local asset listing describes configured bindings only.',
  'Bounded public Meta Ad Library search through the sole/default connection. Media format is translated separately from provider ad category. Geographic API coverage and result limits are explicit; no performance inference or token-bearing URLs are returned.',
  'Account-scoped Page/Instagram identity discovery, ephemeral server-side Page token and owned content reads. Exact IDs or bounded canonical permalink lookup with encrypted, scoped continuations. No arbitrary URL fetching or automatic creative writes; native eligibility and approval remain unverified.',
  'Administrator-only explicit-UUID local disconnect, with dry-run default. Atomically removes the encrypted credential row, resource bindings and discovery metadata while retaining recovery history. No provider calls or grant revocation; default selection never chooses the identity.',
  'Native place-action metadata, complete bounded link lists or exact link read. Location filters bind the selected location grant; global/region metadata does not establish eligibility. Current scope checks, native envelopes, private URL redaction and explicit page continuation; no ownership or write grants are inferred.',
  'Complete local action/enum inventory, not complete vendor API coverage or live qualification. Route membership is conditional on exact-payload inspect, permissions, server-read review and provider validation.',
]);
// First-party display labels only; native identifiers and request values remain literal.
const capabilityLabels = {
  website_traffic: 'Website traffic',
  website_purchases: 'Website purchases',
  website_leads: 'Website leads',
  search_acquisition: 'Search acquisition',
  search_clicks: 'Search clicks',
  search_conversions: 'Search conversions',
  search_conversion_value: 'Search conversion value',
  lead_generation: 'Lead generation',
  measurement: 'Measurement',
  creative_preparation: 'Creative preparation',
  name: 'Campaign name',
  account_id: 'Selected account',
  connection_id: 'Provider login',
  currency: 'Currency',
  daily_budget: 'Daily budget',
  country_codes: 'Country codes',
  page_id: 'Page ID',
  destination_url: 'Destination URL',
  message: 'Ad message',
  headline: 'Headline',
  drive_url: 'Source media or Google Drive URL',
  special_ad_categories: 'Special ad categories',
  page_identity: 'Page identity',
  media_receipt: 'Original media receipt',
  landing_page: 'Landing page',
  account_currency: 'Verified account currency',
  eligibility: 'Eligibility',
  draft: 'Draft',
  preflight: 'Native preflight',
  verify: 'Verify',
  pixel_id: 'Pixel ID',
  click_attribution_days: 'Post-click attribution days',
  view_attribution_days: 'Post-view attribution days',
  account_owned_pixel: 'Account-owned pixel',
  conversion_event_delivery: 'Observed conversion event delivery',
  attribution_window: 'Explicit attribution window',
  country_criterion_ids: 'Native country criterion IDs',
  language_criterion_ids: 'Native language criterion IDs',
  location_ids: 'Microsoft location IDs',
  keywords: 'Keywords',
  headlines: 'Headlines',
  descriptions: 'Descriptions',
  cpc_bid: 'CPC bid',
  contains_eu_political_advertising: 'EU political advertising declaration',
  location_criteria: 'Native location criteria',
  language_criteria: 'Native language criteria',
  cpc_bid_ceiling: 'Campaign CPC ceiling',
  campaign_cpc_ceiling: 'Campaign CPC ceiling',
  conversion_goal_policy: 'Conversion goal policy',
  account_default_conversion_goals: 'Account-default conversion goals',
  primary_conversion_actions: 'Primary conversion actions',
  target_cpa: 'Target CPA',
  campaign_target_cpa: 'Campaign target CPA',
  conversion_value_policy: 'Conversion value policy',
  conversion_value_configuration: 'Native conversion value configuration',
  reported_conversion_activity: 'Reported conversion activity',
  conversion_value_delivery: 'Observed conversion values',
  conversion_history_eligibility: 'Conversion history eligibility',
  target_roas: 'Target ROAS',
  campaign_target_roas: 'Campaign target ROAS',
  language: 'Language',
  creative_id: 'Creative ID',
  regulated_content: 'Regulated content declaration',
  start_time: 'Start time',
  existing_website_creative: 'Existing website creative',
  country_targeting: 'Country targeting',
  automatic_swipe_bidding: 'Automatic swipe bidding',
  optimization_goal: 'Optimization goal',
  existing_lead_creative: 'Existing lead creative',
  existing_lead_form: 'Original native lead form',
  lead_form_policy_acceptance: 'Lead form policy acceptance',
  lead_optimization_goal: 'Lead optimization goal',
  date_range: 'Date range',
  timezone: 'Time zone',
  exact_account: 'Exact selected account',
  measurement_context: 'Measurement context',
  complete_source_evidence: 'Complete source evidence',
  'source_id or source_url': 'Uploaded source or source URL',
  source_hash: 'Source hash',
  exact_source_hash: 'Exact original source hash',
  destination_account: 'Destination account',
  provider_processing_receipt: 'Original provider processing receipt',
  semantics: 'Report measurement definitions',
  forecast: 'Forecast metric',
  request: 'Exact native request',
  ready_for_preflight: 'Ready for native inspection',
  observed: 'Observed',
  native_read: 'Native read',
  reviewed_write_family: 'Reviewed write contract',
  media_workflow: 'Media workflow',
  local_workflow: 'Local workflow',
  adapter_requires_input: 'Requires exact input',
  blocked_write: 'Write contract unavailable',
  unmapped: 'No executable mapping',
  unqualified_read: 'Read contract unqualified',
  provider_unsupported: 'Provider no longer supports this action',
  directional_forecast: 'Directional forecast',
  audience_estimate: 'Audience estimate',
  advertiser_access: 'Advertiser access',
  forecastReaches: 'Reach',
  forecastImpressions: 'Impressions',
  forecastLeads: 'Leads',
  costPerReach: 'Cost per reached member',
  costPerThousandImpressions: 'Cost per thousand impressions',
  costPerLead: 'Cost per lead',
  averageFrequency: 'Average frequency',
  observed_at_discovery: 'Recorded at the last discovery',
  not_observed: 'Not recorded',
  private_application_product: 'Application approval for this private product',
  member_account_access: 'Current member access to the selected account',
  positive_geographic_targeting: 'Explicit included geography',
  exact_targeting_criteria: 'Exact audience criteria and a supported grouping',
  display_video_oauth_scope: 'Recorded Display & Video 360 permission',
  dv360_customer_role: 'Current customer role in Display & Video 360',
  exact_advertiser_access: 'Access to this exact advertiser',
  conditional_application_access: 'Application approval for this exact program',
  exact_program_request: 'Eligibility of this exact program request',
  current_provider_permissions: 'Current provider permissions',
  exact_payload_and_objective: 'Eligibility of the exact request and objective',
  provider_acceptance: 'Provider acceptance of this exact workflow',
  requires_evidence: 'Current evidence required',
  needs_user_input: 'Needs your inputs',
  per_account: 'Resolved per account',
  ready: 'Ready',
  blocked: 'Blocked',
  unknown: 'Not known yet',
  resolved_locally: 'From this account’s evidence',
  user_input: 'From your brief or request',
  collection_time: 'Known when collected',
  native_review_only: 'Decided only by the provider',
  provider_objective_acceptance: 'Provider acceptance of the objective and request',
  recent_account_read: 'Recent account read',
  not_current: 'Account evidence is no longer current',
  inspect: 'Inspect',
  qualify: 'Check this exact request',
  review: 'Review',
  execute: 'Execute',
  recover: 'Recover',
  configure: 'Configure',
  collect: 'Collect',
  jobFunctions: 'Job functions',
  seniorities: 'Seniority',
  titles: 'Job titles',
  yearsOfExperienceRanges: 'Years of experience',
  interests: 'Member interests',
  productInterests: 'Product interests',
  skills: 'Skills',
  industries: 'Company industries',
  staffCountRanges: 'Company size',
  growthRate: 'Company growth rate',
  employers: 'Company names',
  bingContinent: 'Continents',
  bingCountry: 'Countries and regions',
  bingCity: 'Cities',
  bingState: 'States and provinces',
  // Reporting workflows (src/capability-graph.ts builds them from src/report-metrics.ts); listed so their Arabic is
  // required. tests/status-labels.test.mjs fails when these drift from the server's names (WEB-05).
  'report:google': 'Google Ads reporting',
  'report:meta': 'Meta reporting',
  'report:tiktok': 'TikTok reporting',
  'report:snapchat': 'Snapchat reporting',
  'report:linkedin': 'LinkedIn reporting',
  'report:x': 'X Ads reporting',
  'report:microsoft': 'Microsoft Ads reporting',
  'report:apple': 'Apple Ads reporting',
  'report:reddit': 'Reddit Ads reporting',
  'report:ga4': 'Google Analytics 4 reporting',
  'report:gsc': 'Search Console reporting',
  'report-kind:paid': 'paid context with native metric definitions and source evidence.',
  'report-kind:measurement': 'measurement context with native metric definitions and source evidence.',
  'report-kind:organic': 'organic context with native metric definitions and source evidence.',
};
// A capability value's first-party label; workflow states share the workspace status labels (WEB-05).
const capabilityLabel = value =>
  Object.hasOwn(capabilityLabels, value)
    ? uiText(capabilityLabels[value])
    : typeof statusLabel === 'function'
      ? statusLabel(value)
      : uiText(String(value).replaceAll('_', ' '));
function capabilityContractReason(value) {
  if (typeof value !== 'string') return '';
  let remaining = value.trim();
  const translated = [],
    messages = [...capabilityContractMessages].sort((a, b) => b.length - a.length);
  while (remaining) {
    const message = messages.find(m => remaining === m || remaining.startsWith(m + ' '));
    if (!message) return value;
    translated.push(uiText(message));
    remaining = remaining.slice(message.length).trim();
  }
  return translated.join(' ');
}
function capabilityProgramRequirements(w) {
  if (!w.program) return '';
  return `<section><h3>${esc(uiText('Conditional program requirements'))}</h3><p>${esc(uiText(w.program.access))}</p><p class="form-note">${esc(uiText(w.program.limitations))}</p><p><a href="${esc(w.program.reference)}" target="_blank" rel="noopener noreferrer">${esc(uiText('Official program requirements'))}</a> · ${esc(uiText('Checked on'))} ${esc(w.program.checked_on)}</p></section>`;
}
function capabilityMatches(workflow, query) {
  const needle = query.trim().toLowerCase();
  return (
    !needle ||
    [workflow.name, uiText(workflow.name), workflow.description, uiText(workflow.description), workflow.objective]
      .join(' ')
      .toLowerCase()
      .includes(needle)
  );
}
function capabilityBlocker(code) {
  const labels = {
    connection_disabled: 'Connection is disabled',
    deployment_writes_disabled: 'Reviewed writes are disabled in this deployment',
    workspace_writes_paused: 'The owner paused provider writes',
    operator_required: 'An operator role is required',
    account_write_grant_required: 'This account needs a write grant',
    PROVIDER_ACCESS_DENIED:
      'The provider refused this exact program request. Check application approval and account access separately.',
    INSUFFICIENT_SCOPE: 'The provider requires a permission that this login does not currently have.',
    AUTH_EXPIRED: 'Reconnect this login before checking the program again.',
    native_read_contract_required: 'This program requires a qualified native read contract.',
  };
  if (labels[code]) return uiText(labels[code]);
  if (code.startsWith('provider_scope_declined:'))
    return uiText('Declined permission; reauthorize and allow it: {scope}', {
      scope: code.slice('provider_scope_declined:'.length),
    });
  if (code.startsWith('provider_scope:'))
    return uiText('Missing recorded permission: {scope}', {scope: code.slice(15)});
  if (code.startsWith('contract:')) return uiText('Unqualified native contract: {action}', {action: code.slice(9)});
  return pretty(code);
}
/** The next action for a dependency (CON-03): check a recipe brief, manage access, or nothing when only the provider decides. */
function capabilityResolver(w, d) {
  const call = d.resolver_call;
  if (!call) return '';
  if (call.website_path) return ` <a href="${esc(call.website_path)}">${esc(uiText('Manage account access'))}</a>`;
  if (call.arguments?.action === 'recipe_eligibility')
    return ` <a href="${esc(w.website_path)}">${esc(uiText('Check this brief'))}</a>`;
  return '';
}
// The last program read of each workflow, login and account in this session (CON-04), so a re-rendered card keeps the
// observation; a read retained by the server (D20) arrives as program_evidence.last_observation.
const capabilityProgramReads = new Map();
const capabilityProgramKey = (workflow, connection, account) => [workflow, connection, account].join('\n');
function capabilityLastRead(w, a) {
  return [
    capabilityProgramReads.get(capabilityProgramKey(w.id, a.connection_id, a.account_id)),
    a.program_evidence?.last_observation,
  ]
    .filter(read => read && Number.isFinite(read.checked_at))
    .sort((x, y) => y.checked_at - x.checked_at)[0];
}
function capabilityReadLabel(read) {
  const state =
    read.state === 'observed'
      ? uiText('Observed')
      : read.state === 'blocked'
        ? uiText('Provider refused')
        : uiText('No usable provider answer');
  return state + ' · ' + uiDate(read.checked_at, {dateStyle: 'medium', timeStyle: 'long'});
}
function capabilityReadChip(w, a) {
  const read = w.program ? capabilityLastRead(w, a) : undefined;
  return read ? badge(read.state, capabilityReadLabel(read)) : badge(a.local_state, capabilityLabel(a.local_state));
}
function capabilityReadSummary(w, a) {
  const read = capabilityLastRead(w, a);
  if (!read) return '';
  const code = (label, value) => (value ? ` · ${esc(uiText(label))} <code dir="ltr">${esc(value)}</code>` : '');
  return `<p>${esc(uiText('Last observed:'))} ${esc(capabilityReadLabel(read))}${code('Provider code', read.provider_code)}${code('Provider request reference', read.provider_request_id)}</p><p class="form-note">${esc(uiText('This is a timestamped observation, not a grant. It does not establish current access.'))}</p>`;
}
// A program with no selected account shows how to set one up instead of a check that can only refuse (CON-04).
function capabilityProgramSetup(w) {
  const s = w.setup;
  if (!s) return `<p>${esc(uiText('Connect and select a matching account first.'))}</p>`;
  return `<section class="notice"><h4>${esc(uiText('Set up access first'))}</h4><p>${esc(uiText(s.text))}</p><ul>${(s.prerequisites ?? []).map(p => `<li><strong>${esc(capabilityLabel(p.id))}</strong> — ${esc(uiText(p.text))}</li>`).join('')}</ul><a class="button small" href="${esc(s.website_path)}">${esc(uiText('Open Connections'))}</a></section>`;
}
function capabilityCard(w) {
  return `<details class="capability-card"><summary><strong>${esc(uiText(w.name))}</strong> · ${esc(capabilityLabel(w.objective))}</summary><p>${esc(uiText(w.description))}</p><p class="notice">${esc(uiText(w.effect_details))}</p>${capabilityProgramRequirements(w)}<h3>${esc(uiText('Before you start'))}</h3><p>${esc(uiText('Required inputs:'))} ${esc(uiList(w.required_inputs.map(capabilityLabel)))}</p><ul>${w.dependencies.map(d => `<li>${esc(capabilityLabel(d.id))} — ${esc(capabilityLabel(d.status))}${d.resolution ? ` · ${esc(capabilityLabel(d.resolution))}` : ''}${capabilityResolver(w, d)}</li>`).join('')}</ul><h3>${esc(uiText('Selected account readiness'))}</h3>${w.accounts.map((a, index) => `<article class="operation-card"><div class="operation-heading"><h4>${esc(a.label)} · ${esc(a.account_id)}</h4><span data-program-status>${capabilityReadChip(w, a)}</span></div><p>${esc(a.blockers.map(capabilityBlocker).join(' · ') || uiText('Local prerequisites available. Native preflight is still required.'))}</p><p>${esc(uiText('Account evidence:'))} ${esc(capabilityLabel(a.provider_evidence.status))}${a.provider_evidence.checked_at ? ' · ' + date(a.provider_evidence.checked_at) : ''}</p><p class="form-note">${esc(uiText(a.provider_evidence.meaning))}</p>${a.dependencies?.length ? `<ul>${a.dependencies.map(d => `<li>${esc(capabilityLabel(d.id))} — ${badge(d.status, capabilityLabel(d.status))}</li>`).join('')}</ul>` : ''}${w.program ? `<div data-program-last>${capabilityReadSummary(w, a)}</div>` : ''}<details><summary>${esc(uiText('Still to verify'))}</summary><ul>${a.unresolved.map(u => `<li>${esc(capabilityLabel(u))}</li>`).join('')}</ul></details><a href="/connections" class="button small">${esc(uiText('Manage account access'))}</a>${recordDetails(a.next_call, uiText('Inspect prerequisites in MCP'))}${capabilityProgram(w, a, index)}</article>`).join('') || capabilityProgramSetup(w)}<h3>${esc(uiText('Workflow stages'))}</h3><ol>${w.lifecycle.map(s => `<li><strong>${esc(capabilityLabel(s.stage))}</strong> — ${esc(uiText(s.meaning))}${s.tool ? `<small class="form-note">${esc(s.tool)} · ${esc(s.action)}</small>` : ''}</li>`).join('')}</ol>${w.contracts.length ? `<h3>${esc(uiText('Native contract dependencies'))}</h3>${w.contracts.map(c => `<details><summary><code dir="ltr">${esc(c.action)}</code> · ${badge(c.status, capabilityLabel(c.status))}</summary><p>${esc(uiText('Family:'))} ${esc(c.family ?? uiText(c.status === 'native_read' ? 'Native read' : 'Unqualified'))}</p><p>${esc(uiText('Evidence:'))} ${esc(c.source ?? uiText('Unavailable'))}</p><p>${esc(uiText('Tests:'))} ${esc(c.tests.join(', '))}</p><p>${esc(uiText('Account-specific provider acceptance remains unverified.'))}</p></details>`).join('')}` : ''}<div class="dialog-actions work-actions"><a class="button small" href="${esc(w.website_path)}">${esc(uiText('Open workflow'))}</a><a class="button small" href="/capabilities?workflow_id=${encodeURIComponent(w.id)}">${esc(uiText('Link to this workflow'))}</a></div>${w.next_call ? recordDetails(w.next_call, uiText('Continue in MCP')) : ''}</details>`;
}
function capabilityProgram(w, a, index) {
  if (!w.program) return '';
  const id = 'program-read-' + w.id.replace(/[^a-z0-9_-]/gi, '-') + '-' + index,
    forecast = w.id === 'program:linkedin_forecast',
    insights = w.id === 'program:linkedin_audience_insights';
  const facets = [
    'jobFunctions',
    'seniorities',
    'titles',
    'yearsOfExperienceRanges',
    'interests',
    'productInterests',
    'skills',
    'industries',
    'staffCountRanges',
    'growthRate',
    'employers',
    'bingContinent',
    'bingCountry',
    'bingCity',
    'bingState',
  ];
  const locations = `<label>${esc(uiText('Native geographic URNs, one per line'))}<textarea name="locations" rows="3" maxlength="2000" required dir="ltr"></textarea></label>`;
  const inputs = forecast
    ? `<label>${esc(uiText('Forecast metric'))}<select name="forecast"><option value="forecastReaches">${esc(uiText('Reach'))}</option><option value="forecastImpressions">${esc(uiText('Impressions'))}</option><option value="forecastLeads">${esc(uiText('Leads'))}</option></select></label><label>${esc(uiText('Objective'))}<select name="objective"><option value="BRAND_AWARENESS">${esc(uiText('Brand awareness'))}</option><option value="VIDEO_VIEW">${esc(uiText('Video views'))}</option><option value="LEAD_GENERATION">${esc(uiText('Lead generation'))}</option></select></label><label>${esc(uiText('Forecast period budget (USD)'))}<input name="budget" inputmode="decimal" required></label><label>${esc(uiText('Start date (UTC)'))}<input name="date_from" type="date" required></label><label>${esc(uiText('End date (UTC)'))}<input name="date_to" type="date" required></label><label>${esc(uiText('Native geographic URNs, one per line'))}<textarea name="locations" rows="3" maxlength="2000" required dir="ltr"></textarea></label><label>${esc(uiText('Audience network'))}<select name="network"><option value="false">${esc(uiText('Disabled'))}</option><option value="true">${esc(uiText('Enabled'))}</option></select></label><label>${esc(uiText('Audience expansion'))}<select name="expansion"><option value="false">${esc(uiText('Disabled'))}</option><option value="true">${esc(uiText('Enabled'))}</option></select></label>`
    : insights
      ? `<label>${esc(uiText('Audience input'))}<select name="input_kind"><option value="guided">${esc(uiText('Guided audience criteria'))}</option><option value="native">${esc(uiText('Advanced native request'))}</option></select></label><div data-program-guided class="recipe-fields">${locations}<label>${esc(uiText('Additional audience attribute'))}<select name="audience_facet">${['skills', 'jobFunctions', 'industries', 'employers'].map(f => `<option value="${f}">${esc(capabilityLabel(f))}</option>`).join('')}</select></label><label>${esc(uiText('Native attribute URNs, one per line'))}<textarea name="audience_values" rows="3" maxlength="4000" required dir="ltr"></textarea></label><label>${esc(uiText('Group audience by'))}<select name="group_by">${facets.map(f => `<option value="${f}">${esc(capabilityLabel(f))}</option>`).join('')}</select></label><label>${esc(uiText('Maximum segments'))}<input name="max_segments" type="number" min="1" max="100" step="1" value="5" required></label><p class="form-note">${esc(uiText('Choose geography and one additional professional attribute. LinkedIn validates the exact audience and may suppress segments below its minimum size.'))}</p></div><div data-program-native hidden><label>${esc(uiText('Native audience-insights request (JSON)'))}<textarea name="request" rows="6" maxlength="64000" dir="ltr" disabled></textarea></label><p class="form-note">${esc(uiText('Use the exact native targeting criteria and grouping. This account’s sponsored account URN must remain unchanged.'))}</p></div>`
      : '';
  const notices =
    forecast || insights
      ? `<p class="notice">${esc(uiText('LinkedIn tools may not be used to discriminate based on personal characteristics like gender, age, race, or ethnicity.'))}</p>${forecast ? `<p class="notice">${esc(uiText("The forecasted results are directional estimates and don't guarantee the actual performance of campaigns."))}</p>` : ''}`
      : '';
  return `<section class="workspace-form"><h5>${esc(uiText('Inspect this conditional program'))}</h5>${notices}<form id="${id}" data-program-check data-workflow-id="${esc(w.id)}" data-connection-id="${esc(a.connection_id)}" data-account-id="${esc(a.account_id)}"><div class="recipe-fields">${inputs}</div><button type="submit" class="button">${esc(uiText('Read this exact program request'))}</button></form><div id="${id}-result" aria-live="polite" tabindex="-1"></div></section>`;
}
// The allow-listed facts of a refused program read (PRV-02): observation time with its time zone, the provider's HTTP
// status, code and request reference, and the prerequisite its documented refusal names. No cause is inferred otherwise.
function capabilityProgramFacts(checked) {
  const e = checked.native_error;
  if (!e) return '';
  const reported = checked.provider_reported_prerequisite,
    value = v => (v === null || v === undefined ? esc(uiText('Not reported')) : `<code dir="ltr">${esc(v)}</code>`);
  return `<dl class="program-facts"><dt>${esc(uiText('Observed at'))}</dt><dd>${esc(uiDate(checked.checked_at, {dateStyle: 'medium', timeStyle: 'long'}))}</dd><dt>${esc(uiText('Provider HTTP status'))}</dt><dd>${value(e.http_status)}</dd><dt>${esc(uiText('Provider code'))}</dt><dd>${value(e.provider_code)}</dd><dt>${esc(uiText('Provider request reference'))}</dt><dd>${value(e.provider_request_id)}${e.provider_request_id ? ` <button type="button" class="button small" data-copy-reference="${esc(e.provider_request_id)}">${esc(uiText('Copy reference'))}</button>` : ''}</dd><dt>${esc(uiText('AMCP request reference'))}</dt><dd>${value(e.amcp_request_id ?? e.request_id)}</dd></dl>${
    reported
      ? `<p><strong>${esc(uiText('As reported by LinkedIn'))}</strong>: ${esc(capabilityLabel(reported.prerequisite_id))}. ${esc(uiText(reported.resolution))} <a href="${esc(reported.reference)}" target="_blank" rel="noopener noreferrer">${esc(uiText('Provider documentation'))}</a></p>`
      : ''
  }<p class="form-note">${esc(uiText('No cause is inferred beyond what the provider reports.'))}</p>`;
}
// The follow-up a program result names (CON-04): after a refusal, what the owner does before checking again (no live
// retry is offered); after another failure, the one retry that can change the answer.
function capabilityOwnerAction(checked) {
  const o = checked.owner_action,
    hint = checked.retry_hint;
  if (!o)
    return hint
      ? `<p class="form-note">${esc(uiText(hint.text))}${Number.isSafeInteger(hint.retry_after_ms) ? ' ' + esc(uiText('Check again after {seconds} seconds.', {seconds: uiNumber(Math.ceil(hint.retry_after_ms / 1000))})) : ''}</p>`
      : '';
  const repeated = o.text === checked.provider_reported_prerequisite?.resolution;
  return `<div class="notice"><p><strong>${esc(uiText('Owner action'))}</strong>${repeated ? '' : `: ${esc(uiText(o.text))}`}${o.reference ? ` <a href="${esc(o.reference)}" target="_blank" rel="noopener noreferrer">${esc(uiText('Official program requirements'))}</a>` : ''}</p>${checked.retry_after_provisioning ? `<p>${esc(uiText('Check again only after this is done. Repeating the same request now returns the same refusal.'))}</p>` : ''}</div>`;
}
// Budgets in USD currency style, with the exact six-decimal micros value kept in the title (CON-04).
function capabilityUsd(micros) {
  const value = BigInt(micros),
    exact = (value / 1000000n).toString() + '.' + (value % 1000000n).toString().padStart(6, '0') + ' USD';
  return {text: uiNumber(Number(value) / 1e6, {style: 'currency', currency: 'USD'}), title: exact};
}
function capabilityUsdHtml(micros) {
  const usd = capabilityUsd(micros);
  return `<bdi dir="ltr" title="${esc(usd.title)}">${esc(usd.text)}</bdi>`;
}
// LinkedIn's documented cost and frequency estimates at the selected budget, labelled directional (PRV-02).
function capabilityDirectionalEstimates(estimates, number) {
  const points = Object.entries(estimates?.points ?? {}),
    unavailable = estimates?.unavailable ?? [];
  if (!points.length && !unavailable.length) return '';
  return `<h6>${esc(uiText('Directional estimates at the selected budget'))}</h6><ul>${points.map(([name, p]) => `<li>${esc(capabilityLabel(name))}: ${esc(number(p.metricValue))}</li>`).join('')}</ul>${unavailable.length ? `<p class="form-note">${esc(uiText('Unavailable estimates:'))} ${esc(unavailable.map(capabilityLabel).join(', '))}</p>` : ''}<p class="form-note">${esc(uiText(estimates.meaning))}</p>`;
}
function capabilityProgramEvidence(checked) {
  const e = checked.evidence;
  if (!e) return '';
  const capabilityEvidenceHeaders = {
    forecast: ['Budget (USD)', 'Native estimate', 'Native lower bound', 'Native upper bound'],
    audience: ['Native segment URN', 'Reported count', 'Reported percentage'],
  };
  const number = value => (value === null || value === undefined ? uiText('Unavailable') : uiNumber(value)),
    table = (headers, rows) =>
      `<div class="report-table-wrap" tabindex="0" role="region" aria-label="${esc(uiText('Program observation'))}"><table class="report-table"><caption>${esc(uiText('Program observation'))}</caption><thead><tr>${headers.map(h => `<th scope="col">${esc(uiText(h))}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map((value, index) => (index === 0 ? `<th scope="row" dir="ltr"${value?.title ? ` title="${esc(value.title)}"` : ''}>${esc(value?.text ?? value)}</th>` : `<td>${esc(value)}</td>`)).join('')}</tr>`).join('')}</tbody></table></div>`;
  if (checked.workflow_id === 'program:linkedin_forecast') {
    const point = e.single_point_metric;
    return `<p>${esc(uiText('Forecast metric'))}: ${esc(capabilityLabel(e.forecast))}</p>${point ? `<p><strong>${esc(uiText('Selected budget estimate'))}</strong>: ${capabilityUsdHtml(point.budgetMicros)} · ${esc(number(point.metricValue))}</p>` : ''}<p class="form-note">${esc(uiText('Native forecast points and provider bounds are retained without interpolation. Missing bounds remain unavailable.'))}</p>${table(
      capabilityEvidenceHeaders.forecast,
      e.metric_curve.map(p => [
        capabilityUsd(p.budgetMicros),
        number(p.metricValue),
        number(p.metricLower),
        number(p.metricUpper),
      ]),
    )}${capabilityDirectionalEstimates(e.directional_estimates, number)}`;
  }
  if (checked.workflow_id === 'program:linkedin_audience_insights') {
    return `<p><strong>${esc(uiText('Reported audience count'))}</strong>: ${esc(number(e.total_audience_count))}</p><p class="form-note">${esc(uiText(e.meaning))}</p>${e.grouped_by ? `<p>${esc(uiText('Grouping'))}: ${esc(capabilityLabel(e.grouped_by.replace('urn:li:adTargetingFacet:', '')))} · <bdi dir="ltr">${esc(e.grouped_by)}</bdi></p>` : ''}${
      e.segmentations?.length
        ? table(
            capabilityEvidenceHeaders.audience,
            e.segmentations.map(s => [s.value, number(s.entityCount), number(s.entityPercentage) + '%']),
          )
        : `<p>${esc(uiText('No audience segments returned. Omitted segments are not zero.'))}</p>`
    }`;
  }
  return `<dl><dt>${esc(uiText('Advertiser ID'))}</dt><dd><bdi dir="ltr">${esc(e.advertiser_id)}</bdi></dd><dt>${esc(uiText('Partner ID'))}</dt><dd><bdi dir="ltr">${esc(e.partner_id)}</bdi></dd><dt>${esc(uiText('Currency'))}</dt><dd>${esc(e.currency)}</dd><dt>${esc(uiText('Native configured status'))}</dt><dd><bdi dir="ltr">${esc(e.entity_status ?? uiText('Unavailable'))}</bdi></dd></dl>`;
}
function bindCapabilityPrograms(root) {
  root.querySelectorAll('[data-program-check]').forEach(form => {
    const result = $('#' + form.id + '-result'),
      navigation = navigationGeneration,
      identity = identityGeneration;
    let version = 0;
    const current = () =>
      navigation === navigationGeneration &&
      identity === identityGeneration &&
      root.isConnected &&
      form.isConnected &&
      result.isConnected;
    const invalidate = () => {
      version++;
      if (current()) result.innerHTML = '';
    };
    form.addEventListener('input', invalidate);
    form.addEventListener('change', invalidate);
    const mode = form.elements.input_kind;
    if (mode) {
      const update = () => {
        const native = mode.value === 'native';
        for (const [selector, enabled] of [
          ['[data-program-guided]', !native],
          ['[data-program-native]', native],
        ]) {
          const group = form.querySelector(selector);
          group.hidden = !enabled;
          group.querySelectorAll('input,select,textarea').forEach(control => {
            control.disabled = !enabled;
          });
        }
        form.elements.request.required = native;
      };
      mode.addEventListener('change', update);
      update();
    }
    workspaceBind('#' + form.id, async () => {
      const attempt = ++version;
      const value = name => form.elements[name].value,
        workflow = form.dataset.workflowId,
        account = form.dataset.accountId;
      let requirements = {};
      const geography = () => {
        const values = value('locations').trim().split(/\s+/);
        if (
          !values.length ||
          values.length > 50 ||
          new Set(values).size !== values.length ||
          !values.every(v => /^urn:li:geo:[1-9][0-9]{0,18}$/.test(v))
        )
          throw Error(uiText('Supply 1–50 distinct native geographic URNs.'));
        return {or: {'urn:li:adTargetingFacet:locations': values}};
      };
      if (workflow === 'program:linkedin_forecast') {
        if (!/^\d{1,10}(?:\.\d{1,6})?$/.test(value('budget')))
          throw Error(uiText('Enter a positive USD budget with at most six decimal places.'));
        const [whole, fraction = ''] = value('budget').split('.'),
          budget = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
        if (budget < 100000000n || budget > BigInt(Number.MAX_SAFE_INTEGER))
          throw Error(uiText('A forecast budget must be at least USD 100 and within the exact integer limit.'));
        const date = name => {
          const text = value(name),
            stamp = Date.parse(text);
          if (
            !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
            !Number.isFinite(stamp) ||
            new Date(stamp).toISOString().slice(0, 10) !== text
          )
            throw Error(uiText('Choose valid UTC calendar dates.'));
          const [year, month, day] = text.split('-').map(Number);
          return {year, month, day};
        };
        requirements = {
          forecast: value('forecast'),
          request: {
            sponsoredAccountUrn: 'urn:li:sponsoredAccount:' + account,
            currencyCode: 'USD',
            objectiveType: value('objective'),
            targetBudgetMicros: Number(budget),
            startDateOn: date('date_from'),
            endDateOn: date('date_to'),
            targetingCriteria: {include: {and: [geography()]}},
            enableAudienceNetwork: value('network') === 'true',
            enableAudienceExpansion: value('expansion') === 'true',
          },
        };
      } else if (workflow === 'program:linkedin_audience_insights' && value('input_kind') === 'guided') {
        const facet = value('audience_facet'),
          patterns = {
            skills: /^urn:li:skill:[1-9][0-9]{0,18}$/,
            jobFunctions: /^urn:li:function:[1-9][0-9]{0,18}$/,
            industries: /^urn:li:industry:[1-9][0-9]{0,18}$/,
            employers: /^urn:li:organization:[1-9][0-9]{0,18}$/,
          },
          values = value('audience_values').trim().split(/\s+/),
          max = value('max_segments');
        if (
          !patterns[facet] ||
          !values.length ||
          values.length > 50 ||
          new Set(values).size !== values.length ||
          !values.every(v => patterns[facet].test(v))
        )
          throw Error(uiText('Supply 1–50 distinct native URNs for the selected professional attribute.'));
        if (!/^[1-9][0-9]{0,2}$/.test(max) || Number(max) > 100)
          throw Error(uiText('Choose 1–100 returned audience segments.'));
        requirements = {
          request: {
            requestMetaData: {sponsoredAccountUrn: 'urn:li:sponsoredAccount:' + account},
            targetingCriteria: {include: {and: [geography(), {or: {['urn:li:adTargetingFacet:' + facet]: values}}]}},
            groupBy: 'urn:li:adTargetingFacet:' + value('group_by'),
            maxReturnCount: Number(max),
          },
        };
      } else if (workflow === 'program:linkedin_audience_insights') {
        let request;
        try {
          request = JSON.parse(value('request'));
        } catch {
          throw Error(uiText('Enter a valid native audience-insights request object.'));
        }
        if (!request || Array.isArray(request) || typeof request !== 'object')
          throw Error(uiText('Enter a valid native audience-insights request object.'));
        requirements = {request};
      }
      const checked = await workspaceCall('workspace', {
        action: 'program_check',
        workflow_id: workflow,
        connection_id: form.dataset.connectionId,
        account_id: account,
        requirements,
        live: true,
      });
      if (!current() || attempt !== version) return;
      if (
        checked.workflow_id !== workflow ||
        checked.scope?.connection_id !== form.dataset.connectionId ||
        checked.scope?.account_id !== account
      )
        throw Error(uiText('The program result does not match the selected account and login.'));
      result.innerHTML = `<h5>${esc(uiText('Program observation'))} · ${badge(checked.state, capabilityLabel(checked.state))}</h5><p>${esc(uiText(checked.meaning))}</p>${checked.blockers?.length ? `<p class="notice">${esc(checked.blockers.map(capabilityBlocker).join(' · '))}</p>` : ''}${capabilityProgramFacts(checked)}${capabilityOwnerAction(checked)}${capabilityProgramEvidence(checked)}${recordDetails(checked, uiText('Original program evidence'))}`;
      // A read that reached the provider replaces the card's readiness chip and last-observed line (CON-04).
      if (checked.provider_requests > 0 && Number.isFinite(checked.checked_at)) {
        const e = checked.native_error ?? {},
          w = {id: workflow, program: true},
          a = {connection_id: form.dataset.connectionId, account_id: account};
        capabilityProgramReads.set(capabilityProgramKey(workflow, a.connection_id, account), {
          state: checked.state,
          checked_at: checked.checked_at,
          code: e.code ?? null,
          provider_code: e.provider_code ?? null,
          provider_request_id: e.provider_request_id ?? null,
        });
        const card = form.closest?.('.operation-card'),
          chip = card?.querySelector('[data-program-status]'),
          last = card?.querySelector('[data-program-last]');
        if (chip) chip.innerHTML = capabilityReadChip(w, a);
        if (last) last.innerHTML = capabilityReadSummary(w, a);
      }
      result.querySelectorAll?.('[data-copy-reference]').forEach(button =>
        button.addEventListener('click', async () => {
          // A denied clipboard permission or an insecure context rejects; the reference stays on screen to select.
          try {
            await navigator.clipboard.writeText(button.dataset.copyReference);
            toast(uiText('Reference copied.'));
          } catch {
            toast(uiText('Copy failed; select the reference manually.'));
          }
        }),
      );
      result.focus();
    });
  });
}
/** A workflow's platform as its provider names it (a literal, not translated). */
function capabilityPlatform(gateway) {
  const known = (typeof platforms === 'undefined' ? [] : platforms).find(
    p => p.gateway === gateway || (p.connections ?? []).some(c => c.gateway === gateway),
  );
  return (
    known?.name ??
    String(gateway ?? '')
      .replace(/_native_action$/, '')
      .replaceAll('_', ' ')
  );
}
/**
 * WEB-08: the graph already fetched for the filter choices answers page 1 when the server would give the same answer:
 * no account and login is chosen, and the workflow, if any, is one it lists. So the page loads with one graph request.
 * An account filter always asks the server, which resolves account-scoped prerequisites only when exactly one account
 * is in view; an unknown workflow asks it too, so its refusal stays authoritative.
 */
function capabilityLocalSelection(graph, filters) {
  if (filters.connection_id || filters.account_id) return null;
  if (filters.workflow_id && !graph.workflows.some(w => w.id === filters.workflow_id)) return null;
  return {...graph, workflows: graph.workflows.filter(w => !filters.workflow_id || w.id === filters.workflow_id)};
}
/**
 * WEB-08: workflows with a selected account on their platform first ("Available to me"), grouped by objective with
 * counts and sorted by platform; the others stay discoverable in a collapsed "Not available yet" group. An exact
 * workflow link shows that workflow as it is.
 */
function capabilityGroups(result, filters) {
  const all = result.workflows;
  if (!all.length) return `<p>${esc(uiText('No workflows match these filters.'))}</p>`;
  if (filters.workflow_id) return all.map(capabilityCard).join('');
  const grouped = list => {
    const groups = new Map();
    for (const w of [...list].sort(
      (a, b) =>
        capabilityPlatform(a.gateway).localeCompare(capabilityPlatform(b.gateway)) ||
        String(uiText(a.name)).localeCompare(uiText(b.name)),
    ))
      groups.set(w.objective, [...(groups.get(w.objective) ?? []), w]);
    return [...groups]
      .map(([objective, items]) => {
        const counts = new Map();
        for (const w of items)
          counts.set(capabilityPlatform(w.gateway), (counts.get(capabilityPlatform(w.gateway)) ?? 0) + 1);
        return `<section class="capability-group"><h4>${esc(uiText('{objective} ({count})', {objective: capabilityLabel(objective), count: uiNumber(items.length)}))}</h4><p class="form-note">${[...counts].map(([platform, count]) => `<bdi>${esc(platform)}</bdi> ${esc(uiNumber(count))}`).join(' · ')}</p>${items.map(capabilityCard).join('')}</section>`;
      })
      .join('');
  };
  const available = all.filter(w => w.accounts.length),
    later = all.filter(w => !w.accounts.length);
  return (
    `<h3>${esc(uiText('Available to me ({count})', {count: uiNumber(available.length)}))}</h3>` +
    (available.length
      ? grouped(available)
      : `<p class="empty">${esc(uiText('No workflow has a selected account on its platform yet. Select accounts in Connections.'))}</p>`) +
    (later.length
      ? `<details class="capability-unavailable"><summary>${esc(uiText('Not available yet ({count})', {count: uiNumber(later.length)}))}</summary><p class="form-note">${esc(uiText('These workflows have no selected account on their platform. Connect a login and select an account in Connections to use them.'))}</p>${grouped(later)}</details>`
      : '')
  );
}
async function renderCapabilityCenter() {
  const graph = await workspaceCall('workspace', {action: 'capabilities', view: 'graph'}),
    params = new URLSearchParams(location.search);
  const targets = [
    ...new Map(graph.workflows.flatMap(w => w.accounts.map(a => [a.connection_id + '\0' + a.account_id, a]))).values(),
  ];
  const selected = targets.findIndex(
    a => a.connection_id === params.get('connection_id') && a.account_id === params.get('account_id'),
  );
  content.innerHTML += `<p class="notice">${esc(uiText(graph.meaning))}</p><section class="panel workspace-form"><h2>${esc(uiText('Find a workflow'))}</h2><form id="capability-filter" class="work-filter"><label>${esc(uiText('Workflow'))}<select name="workflow_id"><option value="">${esc(uiText('All workflows'))}</option>${graph.workflows.map(w => `<option value="${esc(w.id)}" ${w.id === params.get('workflow_id') ? 'selected' : ''}>${esc(uiText(w.name))}</option>`).join('')}</select></label><label>${esc(uiText('Account and login'))}<select name="target"><option value="">${esc(uiText('All selected accounts'))}</option>${targets.map((a, i) => `<option value="${i}" ${i === selected ? 'selected' : ''}>${esc(a.label)} · ${esc(a.account_id)}</option>`).join('')}</select></label><label>${esc(uiText('Search workflows'))}<input name="search" type="search" maxlength="200" value="${esc((params.get('search') ?? '').slice(0, 200))}"></label><button class="button primary" type="submit">${esc(uiText('Check prerequisites'))}</button></form></section><section class="panel" id="capability-results"><p data-page-status role="status">${esc(uiText('Loading workflows…'))}</p></section><section class="panel workspace-form"><h2>${esc(uiText('Action contract reference'))}</h2><form id="contract-filter" class="work-filter"><label>${esc(uiText('Platform'))}<select name="gateway"><option value="">${esc(uiText('All platforms'))}</option>${graph.contracts.map(g => `<option value="${esc(g.gateway)}">${esc(g.gateway.replace('_native_action', ''))}</option>`).join('')}</select></label><label>${esc(uiText('Search action, route or classification'))}<input name="search" type="search" maxlength="200"></label><button type="submit" class="button">${esc(uiText('Search contracts'))}</button></form><div id="contract-results" aria-live="polite"></div></section>`;
  const form = $('#capability-filter');
  if (params.get('workflow_id') && !graph.workflows.some(w => w.id === params.get('workflow_id')))
    form.elements.workflow_id.add(new Option(uiText('Unavailable workflow'), params.get('workflow_id'), true, true));
  if ((params.get('account_id') || params.get('connection_id')) && selected < 0)
    form.elements.target.add(
      new Option(uiText('Previously selected account — check access'), 'unavailable', true, true),
    );
  let filters = {};
  const collect = () => {
    const target = form.elements.target.value === '' ? null : targets[Number(form.elements.target.value)];
    filters = {
      workflow_id: form.elements.workflow_id.value,
      search: form.elements.search.value,
      ...(target ? {connection_id: target.connection_id, account_id: target.account_id} : {}),
      ...(form.elements.target.value === 'unavailable'
        ? {
            ...(params.get('connection_id') ? {connection_id: params.get('connection_id')} : {}),
            ...(params.get('account_id') ? {account_id: params.get('account_id')} : {}),
          }
        : {}),
    };
    // Every filter, the search included, stays in the address so a reload or a shared link shows the same view (WEB-08).
    const url = new URL(location.href);
    for (const key of ['workflow_id', 'connection_id', 'account_id', 'search']) {
      if (filters[key]) url.searchParams.set(key, filters[key]);
      else url.searchParams.delete(key);
    }
    history.replaceState(null, '', url);
  };
  // WEB-08: page 1 reuses the graph fetched above instead of asking for it a second time.
  let initial = graph;
  const pager = workPageLoader(
    '#capability-results',
    uiText('Workflow prerequisites'),
    async () => {
      const captured = {...filters},
        local = initial && capabilityLocalSelection(initial, captured);
      initial = null;
      const result =
        local ??
        (await workspaceCall('workspace', {
          action: 'capabilities',
          view: 'graph',
          ...(captured.workflow_id ? {workflow_id: captured.workflow_id} : {}),
          ...(captured.connection_id ? {connection_id: captured.connection_id} : {}),
          ...(captured.account_id ? {account_id: captured.account_id} : {}),
        }));
      return {
        ...result,
        workflows: result.workflows.filter(w => capabilityMatches(w, captured.search ?? '')),
        shown_filters: captured,
      };
    },
    result => capabilityGroups(result, result.shown_filters),
    () => bindCapabilityPrograms($('#capability-results')),
  );
  workspaceBind('#capability-filter', async () => {
    collect();
    await pager.load();
  });
  collect();
  await pager.load();
  const contracts = $('#contract-filter');
  let contractFilters = {};
  const contractPager = workPageLoader(
    '#contract-results',
    uiText('Matching contracts'),
    async offset => {
      const result = await workspaceCall('workspace', {
        action: 'contracts',
        ...contractFilters,
        offset: offset ?? 0,
        limit: 30,
      });
      return {...result, next_offset: result.has_more ? result.offset + result.limit : null};
    },
    result =>
      `<p>${esc(uiText(result.meaning))}</p>${result.actions.map(a => `<details><summary><strong>${esc(a.action)}</strong> · ${badge(a.status, capabilityLabel(a.status))}</summary><p>${esc(capabilityContractReason(a.reason))}</p><code dir="ltr">${esc(a.method)} ${esc(a.path)}</code><p>${esc(uiText('Aliases:'))} ${esc(a.aliases.join(', ') || uiText('None'))}</p><p>${esc(uiText('Implementation:'))} ${esc(a.implementation)} ${esc(uiText('· Live qualification:'))} ${esc(a.live_qualification)}</p><p>${esc(uiText('Evidence:'))} ${esc(a.source)}</p><p>${esc(uiText('Tests:'))} ${esc(a.tests.join(', '))}</p></details>`).join('')}`,
  );
  workspaceBind('#contract-filter', async () => {
    contractFilters = {
      search: contracts.elements.search.value,
      ...(contracts.elements.gateway.value ? {gateway: contracts.elements.gateway.value} : {}),
    };
    await contractPager.load();
  });
  await contractPager.load();
}
