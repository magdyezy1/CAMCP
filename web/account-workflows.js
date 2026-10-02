'use strict';
const accountExplanationMessages = new Set([
  'Current X campaign, line-item and promoted-post association inventory in provider order, excluding deleted and draft entities. Native micros stay exact and unconverted. Configured status, effective status, servability and approval are separate; none proves actual delivery. Post content, scheduled posts, promoted accounts and media creatives are outside this view. Provider changes can move or omit entities between pages; this is not a point-in-time snapshot. This read grants no write authority.',
  'Current non-removed Google inventory, ordered by exact immutable IDs. Native micros remain unconverted. Configured status does not prove serving. Provider changes across pages are possible; this is not a point-in-time snapshot. This read grants no write authority.',
  'Current native inventory in provider order and default status visibility, not a point-in-time snapshot. Provider changes between pages can move, repeat or remove entities. Configured and effective status stay separate. Native money remains exact and unconverted. This read grants no write authority.',
  'Current LinkedIn inventory in ascending native ID order, not a point-in-time snapshot. Campaign groups cover the seven documented status filters; test and non-test entities are included. Current parent reads verify account and hierarchy. Native decimal money and currency remain unconverted. Creative intended status and observed serving state stay separate. No write authority is granted.',
  'Current Snapchat inventory in created-at descending order with provider default visibility, not a point-in-time or complete deleted-entity snapshot. Native money remains exact micros. Configured status, review status and delivery codes are independent and do not establish actual delivery. Only the opaque continuation token is reused on the fixed authorized native route. This read grants no write authority.',
  'Current TikTok standard campaign/ad-group/ad route inventory, excluding deleted entities. Native money keeps its JSON type and account-currency units, without conversion; budget_mode determines its meaning. Operation and secondary status remain separate and do not prove serving. Smart+, GMV Max and specialized route coverage is not implied. Page counts may change; this is not a point-in-time snapshot. This read grants no write authority.',
  'Configuration evidence only. This audit does not establish that real events fire, deduplicate, satisfy consent or attribute correctly.',
  'Preview is based on supplied product data. Current provider items are read by each native review before execution. Partial or uncertain writes retain per-item receipts in the campaign journal.',
  'This job reads back an already submitted reviewed mutation. Polling never resubmits the mutation.',
  'Read-only configuration observations; no compiler, browser execution, consent or live tag-delivery qualification.',
  'References absent from the workspace inventory may include provider-managed system triggers; unknown is not passed.',
  'Resolve this conflict in a separately reviewed request before version creation.',
  'The parent folder is absent from the complete workspace inventory.',
  'A template parameter references a variable name absent from this workspace inventory.',
  'This unpaused tag has no explicit firing trigger; confirm whether tag sequencing invokes it.',
  'Latest version changed during the audit. Read a fresh snapshot before reviewing a mutation.',
]);
const gtmFindingLabels = {
  MERGE_CONFLICT: 'Merge conflict',
  DUPLICATE_NAME: 'Duplicate name',
  UNRESOLVED_FOLDER: 'Unresolved parent folder',
  UNRESOLVED_VARIABLE: 'Unresolved variable reference',
  UNRESOLVED_OR_SYSTEM_TRIGGER: 'Unresolved or system trigger',
  NO_FIRING_TRIGGER: 'No explicit firing trigger',
  NO_LIVE_VERSION: 'No live version',
  NO_LATEST_VERSION: 'No latest version',
  VERSION_CHANGED_DURING_AUDIT: 'Version changed during audit',
};
const gtmEntityLabels = {
  tag: 'Tag',
  trigger: 'Trigger',
  variable: 'Variable',
  folder: 'Folder',
  customTemplate: 'Custom template',
  client: 'Client',
  transformation: 'Transformation',
  zone: 'Zone',
  gtagConfig: 'Google tag configuration',
  builtInVariable: 'Built-in variable',
};
function uiAccountExplanation(value) {
  return accountExplanationMessages.has(value) ? uiText(value) : String(value ?? '');
}
function uiGtmFindingLabel(code) {
  return Object.hasOwn(gtmFindingLabels, code) ? uiText(gtmFindingLabels[code]) : String(code ?? '');
}
function uiGtmFindingSeverity(value) {
  switch (value) {
    case 'error':
      return uiText('Error');
    case 'warning':
      return uiText('Warning');
    case 'unknown':
      return uiText('Unknown');
    default:
      return String(value ?? '');
  }
}
function uiGtmFindingMessage(finding) {
  const message = String(finding.message ?? ''),
    meta = finding.message_localization;
  if (uiLocale !== 'ar' || !meta || typeof meta !== 'object' || Array.isArray(meta))
    return uiAccountExplanation(message);
  if (
    meta.key === 'duplicate_name' &&
    finding.code === 'DUPLICATE_NAME' &&
    typeof meta.kind === 'string' &&
    Object.hasOwn(gtmEntityLabels, meta.kind) &&
    message === 'Another ' + meta.kind + ' has this same name; choose IDs explicitly.'
  )
    return uiText('Another {kind} has this same name; choose IDs explicitly.', {
      kind: uiText(gtmEntityLabels[meta.kind]),
    });
  if (
    meta.key === 'unresolved_trigger' &&
    finding.code === 'UNRESOLVED_OR_SYSTEM_TRIGGER' &&
    typeof meta.trigger_id === 'string' &&
    /^[A-Za-z0-9_-]+$/.test(meta.trigger_id) &&
    message ===
      'Trigger ' +
        meta.trigger_id +
        ' is not in the workspace inventory; resolve whether it is provider-managed or missing before publishing.'
  )
    return uiText(
      'Trigger {id} is not in the workspace inventory; resolve whether it is provider-managed or missing before publishing.',
      {id: meta.trigger_id},
    );
  if (meta.key === 'missing_version') {
    if (
      meta.version === 'live' &&
      finding.code === 'NO_LIVE_VERSION' &&
      message === 'No live version was returned (scoped 404).'
    )
      return uiText('No live version was returned (scoped 404).');
    if (
      meta.version === 'latest' &&
      finding.code === 'NO_LATEST_VERSION' &&
      message === 'No latest version was returned (scoped 404).'
    )
      return uiText('No latest version was returned (scoped 404).');
  }
  return uiAccountExplanation(message);
}
function portfolioEntityLabel(value) {
  switch (value) {
    case 'campaign_group':
      return uiText('Campaign group');
    case 'line_item':
      return uiText('Line item');
    case 'promoted_tweet':
      return uiText('Promoted post');
    case 'creative':
      return uiText('Creative');
    case 'campaign':
      return uiText('Campaign');
    case 'adsquad':
      return uiText('Ad squad');
    case 'adset':
      return uiText('Ad set');
    case 'adgroup':
    case 'ad_group':
      return uiText('Ad Group');
    case 'ad':
      return uiText('Ad');
    default:
      return pretty(value);
  }
}
function accountChoices(ids) {
  return platforms
    .filter(p => ids.includes(p.id))
    .flatMap(p =>
      p.connections
        .filter(c => c.enabled)
        .flatMap(c =>
          c.accounts.map(account_id => ({
            gateway: p.gateway,
            connection_id: c.id,
            account_id,
            label: accountLabel(p, c, account_id),
          })),
        ),
    );
}
async function renderPortfolio() {
  const targets = accountChoices(['google', 'meta', 'linkedin', 'snapchat', 'tiktok', 'x']),
    generation = navigationGeneration,
    identity = identityGeneration;
  content.innerHTML += `<p class="notice">${esc(uiText('Browse current Google Ads, Meta, LinkedIn, Snapchat, TikTok and X inventory. Inventory is read-only; provider changes require a separate review.'))}</p><form id="portfolio-account" class="panel workspace-form"><label>${esc(uiText('Advertising account'))}<select name="target" required><option value="">${esc(uiText('Choose a login and account'))}</option>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label><button class="button primary" type="submit">${esc(uiText('Read inventory'))}</button></form><div id="portfolio-view" aria-live="polite"></div>`;
  const view = $('#portfolio-view'),
    form = $('#portfolio-account');
  const attached = () =>
    generation === navigationGeneration && identity === identityGeneration && view.isConnected && form.isConnected;
  let target = null,
    current = {entity: 'campaign'},
    cursor = null,
    sequence = 0;
  const load = async (config, next = null) => {
    if (!attached()) return;
    if (!target) throw Error(uiText('Choose an account and read its inventory first.'));
    const seq = ++sequence,
      selected = {...target};
    const active = () => seq === sequence && attached();
    view.setAttribute('aria-busy', 'true');
    let out;
    try {
      out = await workspaceCall('workspace', {
        action: 'portfolio',
        ...selected,
        requirements: config,
        cursor: next ?? undefined,
        limit: 50,
      });
    } catch (e) {
      if (active()) throw e;
      return;
    } finally {
      if (active()) view.setAttribute('aria-busy', 'false');
    }
    if (!active()) return;
    current = config;
    cursor = out.next_cursor;
    const meta = selected.gateway === 'meta_native_action',
      linkedin = selected.gateway === 'linkedin_native_action',
      snap = selected.gateway === 'snapchat_native_action',
      tiktok = selected.gateway === 'tiktok_native_action',
      x = selected.gateway === 'x_ads_native_action',
      root = linkedin ? 'campaign_group' : 'campaign',
      leaf = linkedin ? 'creative' : x ? 'promoted_tweet' : 'ad',
      child = linkedin
        ? config.entity === 'campaign_group'
          ? uiText('Campaigns')
          : uiText('Creatives')
        : config.entity === 'campaign'
          ? meta
            ? uiText('Ad sets')
            : snap
              ? uiText('Ad squads')
              : x
                ? uiText('Line items')
                : uiText('Ad groups')
          : x
            ? uiText('Promoted posts')
            : uiText('Ads');
    const money = r => {
      if (r.native_money) {
        const entries = Object.entries(r.native_money).filter(([, v]) => v !== null);
        return entries.length
          ? entries
              .map(
                ([k, v]) =>
                  `<div>${esc(linkedin || snap || tiktok || x ? portfolioMoneyLabel(k) : k)}: <b>${esc(linkedin ? v.amount + ' ' + v.currencyCode : v)}</b></div>`,
              )
              .join('') +
              `<small>${esc(linkedin ? uiText('LinkedIn native decimal amounts · unconverted') : snap ? uiText('Snapchat native micros · unconverted') : x ? uiText('X native micros · unconverted') : tiktok ? uiText('TikTok native account-currency amounts · unconverted') : uiText('Meta native integers · unconverted'))}</small>`
          : uiText('No amount returned');
      }
      return r.budget_micros != null
        ? esc(uiText('{amount} budget micros', {amount: r.budget_micros}))
        : r.cpc_bid_micros != null
          ? esc(uiText('{amount} CPC bid micros', {amount: r.cpc_bid_micros}))
          : '—';
    };
    const serving = r =>
      x
        ? config.entity === 'campaign'
          ? `<small>${esc(uiText('Effective:'))} ${esc(r.effective_status ?? uiText('Unknown'))}</small><small>${esc(uiText('Servable: {state}', {state: r.servable === true ? uiText('Yes') : r.servable === false ? uiText('No') : uiText('Unknown')}))}</small>${r.reasons_not_servable?.length ? `<small>${esc(uiText('Not servable reasons: {reasons}', {reasons: r.reasons_not_servable.join(', ')}))}</small>` : ''}`
          : config.entity === 'promoted_tweet'
            ? `<small>${esc(uiText('Approval status: {status}', {status: r.approval_status ?? uiText('Unknown')}))}</small><small>${esc(uiText('Post ID: {id}', {id: r.tweet_id}))}</small>`
            : ''
        : tiktok
          ? `<small>${esc(uiText('Secondary status: {status}', {status: r.secondary_status ?? uiText('Unknown')}))}</small>${r.budget_mode ? `<small>${esc(uiText('Budget mode: {mode}', {mode: r.budget_mode}))}</small>` : ''}`
          : linkedin && config.entity === 'creative'
            ? `<small>${esc(uiText('Observed serving: {state}', {state: r.is_serving === true ? uiText('Yes') : r.is_serving === false ? uiText('No') : uiText('Unknown')}))}</small>${r.serving_hold_reasons?.length ? `<small>${esc(uiText('Serving hold reasons: {reasons}', {reasons: r.serving_hold_reasons.join(', ')}))}</small>` : ''}`
            : snap
              ? `${config.entity === 'ad' ? `<small>${esc(uiText('Review status: {status}', {status: r.review_status ?? uiText('Unknown')}))}</small>` : ''}<small>${esc(r.delivery_status?.length ? uiText('Delivery codes: {codes}', {codes: r.delivery_status.join(', ')}) : uiText('No delivery status codes returned'))}</small>`
              : '';
    const parent = linkedin
      ? config.campaign_group_id
        ? `<button id="portfolio-parent" class="button">${esc(uiText('Campaigns for group {id}', {id: config.campaign_group_id}))}</button>`
        : ''
      : config.campaign_id
        ? `<button id="portfolio-parent" class="button">${esc(uiText(meta ? 'Ad sets for {id}' : snap ? 'Ad squads for {id}' : x ? 'Line items for {id}' : 'Ad groups for {id}', {id: config.campaign_id}))}</button>`
        : '';
    view.innerHTML = `<section class="panel"><div class="dialog-actions"><button id="portfolio-root" class="button">${esc(linkedin ? uiText('Campaign groups') : uiText('Campaigns'))}</button>${parent}<a class="button" href="/campaigns#campaign-create">${esc(uiText('Create or clone a plan'))}</a><a class="button" href="/reports#report-capture">${esc(uiText('Capture performance evidence'))}</a></div>
      <h2 id="portfolio-heading" tabindex="-1">${esc(uiText('{entity} inventory', {entity: portfolioEntityLabel(config.entity)}))}</h2>
      <p><strong>${esc(uiText('{platform} · Account {account}', {platform: linkedin ? 'LinkedIn' : meta ? 'Meta' : snap ? 'Snapchat' : tiktok ? 'TikTok' : x ? 'X' : 'Google Ads', account: out.account_id}))}</strong>${config.campaign_group_id ? ' · ' + esc(uiText('Campaign group {id}', {id: config.campaign_group_id})) : ''}${config.campaign_id ? ' · ' + esc(uiText('Campaign {id}', {id: config.campaign_id})) : ''}${config.adset_id || config.ad_group_id || config.ad_squad_id || config.adgroup_id || config.line_item_id ? ' · ' + esc(uiText(meta ? 'Ad set {id}' : snap ? 'Ad squad {id}' : x ? 'Line item {id}' : 'Ad group {id}', {id: config.adset_id ?? config.ad_group_id ?? config.ad_squad_id ?? config.adgroup_id ?? config.line_item_id})) : ''}</p>
      <p>${esc(uiText('Read {date} · Current inventory', {date: date(out.captured_at)}))}</p><details class="workspace-details"><summary>${esc(uiText('Inventory scope and native units'))}</summary><p>${esc(uiAccountExplanation(out.meaning))}</p></details>
      <div class="data-scroll" role="region" aria-label="${esc(uiText('Portfolio entities'))}" tabindex="0"><table class="review-table"><thead><tr><th scope="col">${esc(uiText('Entity'))}</th><th scope="col">${esc(linkedin && config.entity === 'creative' ? uiText('Intended status') : uiText('Native status'))}</th><th scope="col">${esc(uiText('Native money fields'))}</th><th scope="col">${esc(uiText('Next view'))}</th></tr></thead><tbody>
      ${out.rows.map((r, i) => `<tr><th scope="row">${esc(r.name)}<small>${esc(r.id)}</small></th><td><strong>${esc(r.status ?? uiText('Unknown'))}</strong>${meta ? `<small>${esc(uiText('Effective:'))} ${esc(r.effective_status ?? uiText('Unknown'))}</small>` : ''}${serving(r)}${recordDetails(r.native, uiText('Native fields'))}</td><td>${money(r)}<small>${esc(r.currency ?? uiText('Currency unknown'))} · ${esc(r.timezone ?? uiText('Timezone unknown'))}</small></td><td>${config.entity !== leaf ? `<button class="button small" data-portfolio-child="${i}">${esc(child)}</button>` : esc(linkedin ? uiText('Read-only creative record') : x ? uiText('Read-only promoted-post association') : uiText('Read-only ad record'))}</td></tr>`).join('') || `<tr><td colspan="4">${esc(uiText('No entities in this page. Follow Next page if the provider supplies a continuation.'))}</td></tr>`}
      </tbody></table></div><div class="dialog-actions"><button class="button" id="portfolio-refresh">${esc(uiText('Refresh first page'))}</button><button class="button" id="portfolio-next" ${out.has_more ? '' : 'hidden'}>${esc(uiText('Next page'))}</button></div></section>`;
    workspaceBind('#portfolio-root', () => load({entity: root}));
    workspaceBind('#portfolio-parent', () =>
      load(
        linkedin
          ? {entity: 'campaign', campaign_group_id: config.campaign_group_id}
          : {
              entity: meta ? 'adset' : snap ? 'adsquad' : tiktok ? 'adgroup' : x ? 'line_item' : 'ad_group',
              campaign_id: config.campaign_id,
            },
      ),
    );
    workspaceBind('[data-portfolio-child]', b => {
      if (!active()) return;
      const r = out.rows[Number(b.dataset.portfolioChild)];
      return load(
        linkedin
          ? config.entity === 'campaign_group'
            ? {entity: 'campaign', campaign_group_id: r.id}
            : {entity: 'creative', campaign_group_id: config.campaign_group_id, campaign_id: r.id}
          : config.entity === 'campaign'
            ? {
                entity: meta ? 'adset' : snap ? 'adsquad' : tiktok ? 'adgroup' : x ? 'line_item' : 'ad_group',
                campaign_id: r.id,
              }
            : {
                entity: x ? 'promoted_tweet' : 'ad',
                campaign_id: config.campaign_id,
                [meta ? 'adset_id' : snap ? 'ad_squad_id' : tiktok ? 'adgroup_id' : x ? 'line_item_id' : 'ad_group_id']:
                  r.id,
              },
      );
    });
    workspaceBind('#portfolio-next', () => load(current, cursor));
    workspaceBind('#portfolio-refresh', () => load(current));
    $('#portfolio-heading').focus();
  };
  form.elements.target.addEventListener('change', () => {
    if (!attached()) return;
    sequence++;
    target = null;
    cursor = null;
    view.setAttribute('aria-busy', 'false');
    view.innerHTML = blank(uiText('Read inventory to open the selected account.'));
  });
  workspaceBind('#portfolio-account', async form => {
    if (!attached()) return;
    const t = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !t) throw Error(uiText('Choose an account.'));
    const {label, ...binding} = t;
    target = binding;
    await load({entity: binding.gateway === 'linkedin_native_action' ? 'campaign_group' : 'campaign'});
  });
}
function portfolioMoneyLabel(value) {
  switch (value) {
    case 'budget':
      return uiText('Budget');
    case 'scheduled_budget':
      return uiText('Scheduled budget');
    case 'bid_price':
      return uiText('Bid price');
    case 'total_budget_amount_local_micro':
      return uiText('Total budget micros');
    case 'target_cpa_local_micro':
      return uiText('Target CPA micros');
    case 'bid_amount_local_micro':
      return uiText('Bid micros');
    case 'daily_budget_amount_local_micro':
    case 'daily_budget_micro':
      return uiText('Daily budget micros');
    case 'lifetime_budget_micro':
      return uiText('Lifetime budget micros');
    case 'lifetime_spend_cap_micro':
      return uiText('Lifetime spend cap micros');
    case 'bid_micro':
      return uiText('Bid micros');
    case 'totalBudget':
      return uiText('Total budget');
    case 'dailyBudget':
      return uiText('Daily budget');
    case 'unitCost':
      return uiText('Unit cost');
    default:
      return value;
  }
}
// A reviewed preview belongs to the current form and identity, including while local files are read.
function accountWorkflowContext(form, result) {
  const generation = navigationGeneration,
    identity = identityGeneration;
  let sequence = 0;
  const current = () =>
    generation === navigationGeneration && identity === identityGeneration && form.isConnected && result.isConnected;
  const invalidate = () => {
    if (!current()) return;
    sequence++;
    result.innerHTML = '';
  };
  form.addEventListener('input', invalidate);
  form.addEventListener('change', invalidate);
  return () => {
    const attempt = ++sequence;
    if (current()) result.innerHTML = '';
    return () => attempt === sequence && current();
  };
}
async function renderMeasurement() {
  const targets = accountChoices(['gtm']),
    eventTargets = accountChoices(['ga4']);
  content.innerHTML += `<section class="panel"><h2>${esc(uiText('Measurement evidence'))}</h2><p>${esc(uiText('Review configured tags, trigger dependencies, workspace conflicts and published-version consistency. Configuration evidence is distinct from observed event delivery and attribution.'))}</p><div class="work-links"><a href="/reporting-overview"><strong>${esc(uiText('GA4 and Search Console context'))}</strong><small>${esc(uiText('Collect measurement reports with source definitions.'))}</small></a><a href="/profiles"><strong>${esc(uiText('Client conversion mappings'))}</strong><small>${esc(uiText('Inspect approved conversion definitions and account bindings.'))}</small></a><a href="/capabilities"><strong>${esc(uiText('Reviewed measurement changes'))}</strong><small>${esc(uiText('Discover exact conversion and tag contracts.'))}</small></a></div></section><section class="panel workspace-form"><h2>${esc(uiText('Google Tag Manager configuration audit'))}</h2><form id="measurement-audit"><label>${esc(uiText('Tag Manager account'))}<select name="target" required><option value="">${esc(uiText('Choose a selected account'))}</option>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label>${controls(uiText('Container ID (optional for account inventory)'), 'text', '', 'container_id')}${controls(uiText('Workspace ID (optional)'), 'text', '', 'workspace_id')}<button class="button primary" type="submit">${esc(uiText('Read configuration evidence'))}</button></form><div id="measurement-result"></div></section>`;
  content.innerHTML += measurementEventsMarkup(eventTargets);
  const form = $('#measurement-audit'),
    result = $('#measurement-result'),
    begin = accountWorkflowContext(form, result);
  workspaceBind('#measurement-audit', async form => {
    const current = begin();
    if (!current()) return;
    const t = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !t) throw Error(uiText('Choose a Tag Manager account.'));
    const requirements = Object.fromEntries(
      ['container_id', 'workspace_id']
        .filter(k => form.elements[k].value.trim())
        .map(k => [k, form.elements[k].value.trim()]),
    );
    let out;
    try {
      out = await workspaceCall('workspace', {
        action: 'measurement_audit',
        connection_id: t.connection_id,
        account_id: t.account_id,
        requirements,
      });
    } catch (error) {
      if (current()) throw error;
      return;
    }
    if (!current()) return;
    const c = out.configuration;
    result.innerHTML = `<p class="notice">${esc(uiAccountExplanation(out.meaning))}</p>${badge(c.complete ? 'complete' : 'incomplete')}<h3>${esc(uiText('Configuration findings'))}</h3>${(c.findings ?? []).map(f => `<article><h4>${esc(uiGtmFindingLabel(f.code))} · ${esc(uiGtmFindingSeverity(f.severity))}</h4><p>${esc(uiGtmFindingMessage(f))}</p><p><code dir="ltr">${esc(f.code)}</code></p><code dir="ltr">${esc(f.path)}</code></article>`).join('') || `<p>${esc(uiText('No configuration finding was returned for this scope.'))}</p>`}${c.limitations?.length ? `<section><h3>${esc(uiText('Observation limits'))}</h3><ul>${c.limitations.map(value => `<li>${esc(uiAccountExplanation(value))}</li>`).join('')}</ul></section>` : ''}${reviewTable(c.versions ?? {}, uiText('Published version evidence'))}${recordDetails(c, uiText('Audit scope, limits and native evidence'))}`;
  });
  bindMeasurementEvents(eventTargets);
}
function measurementEventsMarkup(targets) {
  return `<section class="panel workspace-form"><h2>${esc(uiText('Recent GA4 events'))}</h2><p>${esc(uiText('Read aggregate counts for exact event names in one selected property and a recent window. This does not send a test event.'))}</p>
  ${targets.length ? '' : `<p class="notice">${esc(uiText('Connect a GA4 property in Connections to read recent events.'))} <a href="/connections">${esc(uiText('Connections'))}</a></p>`}
  <form id="measurement-events"><label>${esc(uiText('GA4 property'))}<select name="target" required><option value="">${esc(uiText('Choose a login and account'))}</option>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label>
  <label>${esc(uiText('Exact event names'))}<textarea name="event_names" rows="2" maxlength="900" required aria-describedby="measurement-event-names-help"></textarea></label><p class="form-note" id="measurement-event-names-help">${esc(uiText('Separate names with commas or new lines. Names are case-sensitive; select at most 20.'))}</p>
  <label>${esc(uiText('Recent window (minutes)'))}<input name="minutes" type="number" min="1" max="30" step="1" value="5" required></label><label>${esc(uiText('Stream ID (optional)'))}<input name="stream_id" type="text" inputmode="numeric" maxlength="20"></label>
  <button class="button primary" type="submit" ${targets.length ? '' : 'disabled'}>${esc(uiText('Read recent event counts'))}</button></form><div id="measurement-events-result" aria-live="polite"></div></section>`;
}
function bindMeasurementEvents(targets) {
  const form = $('#measurement-events'),
    result = $('#measurement-events-result'),
    begin = accountWorkflowContext(form, result);
  workspaceBind('#measurement-events', async form => {
    const current = begin();
    if (!current()) return;
    const t = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !t) throw Error(uiText('Choose a GA4 property.'));
    const event_names = form.elements.event_names.value
        .split(/[,\r\n]+/)
        .map(s => s.trim())
        .filter(Boolean),
      minutes = Number(form.elements.minutes.value),
      stream = form.elements.stream_id.value.trim();
    if (!event_names.length || event_names.length > 20) throw Error(uiText('Enter 1–20 exact event names.'));
    const {label, ...scope} = t;
    let out;
    try {
      out = await workspaceCall('workspace', {
        action: 'measurement_events',
        ...scope,
        requirements: {event_names, minutes, ...(stream ? {stream_id: stream} : {})},
      });
    } catch (error) {
      if (current()) throw error;
      return;
    }
    if (!current()) return;
    const status = e => (e.state === 'observed' ? uiText('Activity observed') : uiText('No positive count observed'));
    result.innerHTML = `<h3 id="measurement-events-heading" tabindex="-1">${esc(uiText('GA4 property {id}', {id: out.scope.property_id}))}</h3>
    <p>${esc(uiText('Window: {minutes} minutes · Stream: {stream}', {minutes: out.scope.minutes, stream: out.scope.stream_id ?? uiText('All returned streams')}))}</p><p>${esc(uiText('Requested {requested} · Returned {captured}', {requested: date(out.requested_at), captured: date(out.captured_at)}))}</p>
    <div class="data-scroll" role="region" aria-label="${esc(uiText('Recent event counts'))}" tabindex="0"><table class="review-table"><thead><tr><th scope="col">${esc(uiText('Event'))}</th><th scope="col">${esc(uiText('Reported count'))}</th><th scope="col">${esc(uiText('Observation'))}</th></tr></thead><tbody>${out.events.map(e => `<tr><th scope="row">${esc(e.event_name)}</th><td>${esc(e.reported_count ?? uiText('No count returned'))}</td><td>${esc(status(e))}</td></tr>`).join('')}</tbody></table></div>
    <p class="notice">${esc(uiText('Missing or zero counts do not establish a broken tag; realtime processing can lag.'))}</p><p>${esc(uiText('These aggregate counts cannot identify your test event or verify deduplication, consent or attribution. They do not establish conversion configuration or overall tracking health. No test events were sent and no snapshot was saved.'))}</p>
    <details class="workspace-details"><summary>${esc(uiText('Minute and stream evidence'))}</summary><p>${esc(uiText('Minutes ago are relative to GA4 request processing time, not exact event timestamps.'))}</p><div class="data-scroll" role="region" aria-label="${esc(uiText('Minute and stream evidence'))}" tabindex="0"><table class="review-table"><thead><tr><th scope="col">${esc(uiText('Event'))}</th><th scope="col">${esc(uiText('Minutes ago'))}</th><th scope="col">${esc(uiText('Stream ID'))}</th><th scope="col">${esc(uiText('Reported count'))}</th></tr></thead><tbody>${out.rows.map(r => `<tr><th scope="row">${esc(r.event_name)}</th><td>${esc(r.minutes_ago)}</td><td>${esc(r.stream_id)}</td><td>${esc(r.event_count)}</td></tr>`).join('') || `<tr><td colspan="4">${esc(uiText('No minute rows were returned.'))}</td></tr>`}</tbody></table></div></details>${recordDetails(out, uiText('Observation scope and evidence limits'))}`;
    $('#measurement-events-heading').focus();
  });
}
function parseProductCSV(text) {
  return parseProductCSVTable(text).rows;
}
function parseProductCSVTable(text) {
  if (text.length > 131072) throw Error(uiText('Use a CSV smaller than 128 KiB and at most 50 products.'));
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [],
    field = '',
    quoted = false,
    closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
      continue;
    }
    if (c === '"') {
      if (field || closed) throw Error(uiText('Invalid CSV quoting.'));
      quoted = true;
      continue;
    }
    if (closed && !['\r', '\n', ','].includes(c)) throw Error(uiText('Unexpected text after a quoted CSV value.'));
    if (c === ',') {
      row.push(field);
      field = '';
      closed = false;
      continue;
    }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
      field = '';
      closed = false;
      continue;
    }
    field += c;
  }
  if (quoted) throw Error(uiText('A quoted CSV value is not closed.'));
  row.push(field);
  if (row.some(v => v !== '')) rows.push(row);
  const headers = rows.shift()?.map(h => h.replace(/^\uFEFF/, '').trim());
  if (
    !headers?.length ||
    headers.length > 100 ||
    headers.some(h => !h || h.length > 200 || /[\x00-\x1f\x7f]/.test(h)) ||
    new Set(headers).size !== headers.length
  )
    throw Error(uiText('Use 1–100 unique named CSV columns, each up to 200 characters.'));
  if (rows.length > 50) throw Error(uiText('Import at most 50 products in each reviewed plan.'));
  return {
    headers,
    rows: rows.map(r => {
      if (r.length !== headers.length) throw Error(uiText('Every CSV row must match the header columns.'));
      return Object.fromEntries(headers.map((h, i) => [h, r[i]]).filter(([, v]) => v !== ''));
    }),
  };
}
const catalogMapFields = [
  'retailer_id',
  'name',
  'price',
  'currency',
  'image_url',
  'url',
  'availability',
  'condition',
  'brand',
  'description',
];
function catalogFieldLabel(field) {
  switch (field) {
    case 'retailer_id':
      return uiText('Retailer ID');
    case 'name':
      return uiText('Product name');
    case 'price':
      return uiText('Decimal price');
    case 'currency':
      return uiText('Currency');
    case 'image_url':
      return uiText('Product image URL');
    case 'url':
      return uiText('Product page URL');
    case 'availability':
      return uiText('Availability');
    case 'condition':
      return uiText('Condition');
    case 'brand':
      return uiText('Brand');
    case 'description':
      return uiText('Description');
    default:
      return field;
  }
}
function mapProductCSV(table, settings) {
  const {columns, fixed_currency, image_mode} = settings;
  if (
    !columns ||
    Object.keys(columns).some(k => !catalogMapFields.includes(k)) ||
    Object.values(columns).some(v => typeof v !== 'string' || (v && !table.headers.includes(v)))
  )
    throw Error(uiText('Choose only columns from the loaded CSV.'));
  if (!['single', 'first_list'].includes(image_mode)) throw Error(uiText('Choose how to read the image column.'));
  if (
    typeof fixed_currency !== 'string' ||
    (columns.currency ? fixed_currency !== '' : !/^[A-Z]{3}$/.test(fixed_currency))
  )
    throw Error(
      uiText('Choose either a currency column or one explicit three-letter uppercase currency for every row.'),
    );
  for (const key of ['retailer_id', 'name', 'price', 'image_url'])
    if (!columns[key]) throw Error(uiText('Select a source column for {field}.', {field: catalogFieldLabel(key)}));
  if (!table.rows.length) throw Error(uiText('The CSV has no product rows.'));
  return table.rows.map((row, index) => {
    const product = Object.fromEntries(
      catalogMapFields
        .filter(key => columns[key] && row[columns[key]] !== undefined && row[columns[key]] !== '')
        .map(key => [key, row[columns[key]]]),
    );
    if (!columns.currency) product.currency = fixed_currency;
    if (image_mode === 'first_list' && product.image_url) product.image_url = product.image_url.split(',')[0].trim();
    for (const key of ['retailer_id', 'name', 'price', 'currency', 'image_url'])
      if (!product[key]?.trim())
        throw Error(uiText('CSV row {row} has no value for {field}.', {row: index + 1, field: catalogFieldLabel(key)}));
    return product;
  });
}
function catalogMappingMarkup() {
  return `<fieldset><legend>${esc(uiText('CSV column mapping'))}</legend><label>${esc(uiText('CSV layout'))}<select name="column_mode"><option value="canonical">${esc(uiText('AMCP product columns'))}</option><option value="mapped">${esc(uiText('Map supplier or WooCommerce export columns'))}</option></select></label><div id="catalog-mapping-controls" hidden><button type="button" class="button" id="catalog-load-columns">${esc(uiText('Load columns from the selected file'))}</button><p class="form-note">${esc(uiText('Choose the exact price column and stable retailer ID. Sale dates, tax, stock and product variants are not inferred. Every source row is included.'))}</p><div id="catalog-mapping"></div><label>${esc(uiText('Fixed currency when no currency column is selected'))}<input type="text" name="fixed_currency" maxlength="3" placeholder="SAR"></label><label>${esc(uiText('Image column handling'))}<select name="image_mode"><option value="single">${esc(uiText('One literal image URL per row'))}</option><option value="first_list">${esc(uiText('Use the first URL in a comma-separated image list'))}</option></select></label><p class="form-note">${esc(uiText('Only selected product columns are sent for preview. Blank optional fields are omitted from the request.'))}</p></div></fieldset>`;
}
async function renderCommerce() {
  const targets = accountChoices(['meta']);
  content.innerHTML += `<section class="panel workspace-form"><h2>${esc(uiText('Reviewed Meta product import'))}</h2><p>${esc(uiText('Import up to 50 product rows into an existing authorized catalog. Every item retains a separate native review, receipt and read-back in its saved plan. Missing items are retained.'))}</p><form id="catalog-import"><label>${esc(uiText('Meta ad account'))}<select name="target" required><option value="">${esc(uiText('Choose an account'))}</option>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label>${controls(uiText('Native product catalog ID'), 'text', '', 'catalog_id')}${controls(uiText('Import plan name'), 'text', 'Product catalog import', 'name')}<label>${esc(uiText('Product CSV'))}<input type="file" name="file" accept=".csv,text/csv" required></label><p class="form-note">${esc(uiText('Required columns: retailer_id, name, price, currency, image_url. Optional: url, availability, condition, brand, description. Price is a decimal amount in the product currency with at most two decimal places. Use HTTPS links.'))}</p>${catalogMappingMarkup()}<label>${esc(uiText('Existing retailer IDs'))}<select name="allow_upsert"><option value="false">${esc(uiText('Create only — refuse existing IDs'))}</option><option value="true">${esc(uiText('Explicitly update existing IDs after native review'))}</option></select></label><button class="button primary" type="submit">${esc(uiText('Validate and preview products'))}</button></form><div id="catalog-preview"></div></section><p class="notice">${esc(uiText('Mapped supplier and WooCommerce CSV exports use the same reviewed Meta product contract. Live store synchronization, supplementary feeds and other destinations require separate adapters and qualification.'))}</p>`;
  const form = $('#catalog-import'),
    result = $('#catalog-preview'),
    begin = accountWorkflowContext(form, result);
  let loaded = null;
  const resetMapping = () => {
    const current = begin();
    if (!current()) return;
    loaded = null;
    $('#catalog-mapping').innerHTML = '';
    $('#catalog-mapping-controls').hidden = form.elements.column_mode.value !== 'mapped';
  };
  form.elements.column_mode.addEventListener('change', resetMapping);
  form.elements.file.addEventListener('change', resetMapping);
  $('#catalog-mapping-controls').hidden = form.elements.column_mode.value !== 'mapped';
  workspaceBind('#catalog-load-columns', async () => {
    const current = begin();
    if (!current()) return;
    loaded = null;
    $('#catalog-mapping').innerHTML = '';
    const file = form.elements.file.files[0];
    if (!file || file.size > 131072) throw Error(uiText('Choose a CSV smaller than 128 KiB.'));
    let table;
    try {
      const text = await file.text();
      if (!current()) return;
      table = parseProductCSVTable(text);
    } catch (error) {
      if (current()) throw error;
      return;
    }
    if (!current()) return;
    if (!table.rows.length) throw Error(uiText('The CSV has no product rows.'));
    loaded = {file, table};
    $('#catalog-mapping').innerHTML =
      `<p>${esc(uiText('{rows} product rows loaded. Review each selected source column.', {rows: table.rows.length}))}</p><div class="work-filter">${catalogMapFields.map(field => `<label>${esc(catalogFieldLabel(field))}<select id="catalog-map-${field}"><option value="">${esc(uiText('No column selected'))}</option>${table.headers.map(header => `<option value="${esc(header)}">${esc(header)}</option>`).join('')}</select></label>`).join('')}</div>`;
    for (const key of catalogMapFields) $('#catalog-map-' + key).value = table.headers.includes(key) ? key : '';
  });
  workspaceBind('#catalog-import', async form => {
    const current = begin();
    if (!current()) return;
    const target = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !target) throw Error(uiText('Choose the exact account.'));
    const file = form.elements.file.files[0];
    if (!file || file.size > 131072) throw Error(uiText('Choose a CSV smaller than 128 KiB.'));
    const {label, ...binding} = target;
    const settings = {
      ...binding,
      catalog_id: form.elements.catalog_id.value.trim(),
      name: form.elements.name.value.trim(),
      allow_upsert: form.elements.allow_upsert.value === 'true',
    };
    let request, out;
    try {
      let products;
      if (form.elements.column_mode.value === 'mapped') {
        if (!loaded || loaded.file !== file)
          throw Error(uiText('Load the selected CSV columns before previewing mapped products.'));
        products = mapProductCSV(loaded.table, {
          columns: Object.fromEntries(catalogMapFields.map(k => [k, $('#catalog-map-' + k).value])),
          fixed_currency: form.elements.fixed_currency.value.trim(),
          image_mode: form.elements.image_mode.value,
        });
      } else {
        const text = await file.text();
        if (!current()) return;
        products = parseProductCSV(text);
      }
      request = {...settings, products};
      out = await workspaceCall('workspace', {action: 'catalog_preview', ...request});
    } catch (error) {
      if (current()) throw error;
      return;
    }
    if (!current()) return;
    result.innerHTML =
      reviewTable(out.items, uiText('Products and exact native price units')) +
      recordDetails(request.products, uiText('Exact product fields sent for review')) +
      `<p>${esc(uiAccountExplanation(out.meaning))}</p><p>${esc(uiText('Source hash'))} <code>${esc(out.source_hash)}</code></p><button class="button primary" id="create-catalog-plan">${esc(uiText('Save this product plan for native review'))}</button>`;
    workspaceBind('#create-catalog-plan', async () => {
      if (!current()) return;
      try {
        const plan = await workspaceCall('workspace', {action: 'catalog_plan', ...request});
        if (current()) await navigate('/campaigns?id=' + encodeURIComponent(plan.id));
      } catch (error) {
        if (current()) throw error;
      }
    });
  });
}
