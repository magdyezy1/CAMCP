'use strict';
function portfolioEntityLabel(value) {
  switch (value) {
    case 'campaign':
      return uiText('Campaign');
    case 'adset':
      return uiText('Ad set');
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
  const targets = accountChoices(['google', 'meta']),
    generation = navigationGeneration,
    identity = identityGeneration;
  content.innerHTML += `<p class="notice">${esc(uiText('Browse current Google Ads and Meta campaigns, their ad groups or ad sets, and ads. Inventory is read-only; provider changes require a separate review.'))}</p><form id="portfolio-account" class="panel workspace-form"><label>${esc(uiText('Advertising account'))}<select name="target" required><option value="">${esc(uiText('Choose a login and account'))}</option>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label><button class="button primary" type="submit">${esc(uiText('Read campaigns'))}</button></form><div id="portfolio-view" aria-live="polite"></div>`;
  const view = $('#portfolio-view'),
    form = $('#portfolio-account');
  let target = null,
    current = {entity: 'campaign'},
    cursor = null,
    sequence = 0;
  const load = async (config, next = null) => {
    if (!target) throw Error(uiText('Choose an account and read its campaigns first.'));
    const seq = ++sequence,
      selected = {...target};
    const active = () =>
      seq === sequence && generation === navigationGeneration && identity === identityGeneration && view.isConnected;
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
      child = meta ? uiText('Ad sets') : uiText('Ad groups');
    const money = r => {
      if (r.native_money) {
        const entries = Object.entries(r.native_money).filter(([, v]) => v !== null);
        return entries.length
          ? entries.map(([k, v]) => `<div>${esc(k)}: <b>${esc(v)}</b></div>`).join('') +
              `<small>${esc(uiText('Meta native integers · unconverted'))}</small>`
          : uiText('No amount returned');
      }
      return r.budget_micros != null
        ? esc(uiText('{amount} budget micros', {amount: r.budget_micros}))
        : r.cpc_bid_micros != null
          ? esc(uiText('{amount} CPC bid micros', {amount: r.cpc_bid_micros}))
          : '—';
    };
    view.innerHTML = `<section class="panel"><div class="dialog-actions"><button id="portfolio-root" class="button">${esc(uiText('Campaigns'))}</button>${config.campaign_id ? `<button id="portfolio-parent" class="button">${esc(uiText(meta ? 'Ad sets for {id}' : 'Ad groups for {id}', {id: config.campaign_id}))}</button>` : ''}<a class="button" href="/campaigns#campaign-create">${esc(uiText('Create or clone a plan'))}</a><a class="button" href="/reports#report-capture">${esc(uiText('Capture performance evidence'))}</a></div><h2 id="portfolio-heading" tabindex="-1">${esc(uiText('{entity} inventory', {entity: portfolioEntityLabel(config.entity)}))}</h2><p><strong>${esc(uiText('{platform} · Account {account}', {platform: meta ? 'Meta' : 'Google Ads', account: out.account_id}))}</strong>${config.campaign_id ? ' · ' + esc(uiText('Campaign {id}', {id: config.campaign_id})) : ''}${config.adset_id || config.ad_group_id ? ' · ' + esc(uiText(meta ? 'Ad set {id}' : 'Ad group {id}', {id: config.adset_id ?? config.ad_group_id})) : ''}</p><p>${esc(uiText('Read {date} · Current inventory', {date: date(out.captured_at)}))}</p><details class="workspace-details"><summary>${esc(uiText('Inventory scope and native units'))}</summary><p>${esc(out.meaning)}</p></details><div class="data-scroll" role="region" aria-label="${esc(uiText('Portfolio entities'))}" tabindex="0"><table class="review-table"><thead><tr><th scope="col">${esc(uiText('Entity'))}</th><th scope="col">${esc(uiText('Native status'))}</th><th scope="col">${esc(uiText('Native money fields'))}</th><th scope="col">${esc(uiText('Next view'))}</th></tr></thead><tbody>${out.rows.map((r, i) => `<tr><th scope="row">${esc(r.name)}<small>${esc(r.id)}</small></th><td><strong>${esc(r.status ?? uiText('Unknown'))}</strong>${meta ? `<small>${esc(uiText('Effective:'))} ${esc(r.effective_status ?? uiText('Unknown'))}</small>` : ''}${recordDetails(r.native, uiText('Native fields'))}</td><td>${money(r)}<small>${esc(r.currency ?? uiText('Currency unknown'))} · ${esc(r.timezone ?? uiText('Timezone unknown'))}</small></td><td>${config.entity !== 'ad' ? `<button class="button small" data-portfolio-child="${i}">${config.entity === 'campaign' ? child : uiText('Ads')}</button>` : uiText('Read-only ad record')}</td></tr>`).join('') || `<tr><td colspan="4">${esc(uiText('No entities in this page. Follow Next page if the provider supplies a continuation.'))}</td></tr>`}</tbody></table></div><div class="dialog-actions"><button class="button" id="portfolio-refresh">${esc(uiText('Refresh first page'))}</button><button class="button" id="portfolio-next" ${out.has_more ? '' : 'hidden'}>${esc(uiText('Next page'))}</button></div></section>`;
    workspaceBind('#portfolio-root', () => load({entity: 'campaign'}));
    workspaceBind('#portfolio-parent', () =>
      load({entity: meta ? 'adset' : 'ad_group', campaign_id: config.campaign_id}),
    );
    workspaceBind('[data-portfolio-child]', b => {
      const r = out.rows[Number(b.dataset.portfolioChild)];
      return load(
        config.entity === 'campaign'
          ? {entity: meta ? 'adset' : 'ad_group', campaign_id: r.id}
          : {entity: 'ad', campaign_id: config.campaign_id, [meta ? 'adset_id' : 'ad_group_id']: r.id},
      );
    });
    workspaceBind('#portfolio-next', () => load(current, cursor));
    workspaceBind('#portfolio-refresh', () => load(current));
    $('#portfolio-heading').focus();
  };
  form.elements.target.addEventListener('change', () => {
    sequence++;
    target = null;
    cursor = null;
    view.setAttribute('aria-busy', 'false');
    view.innerHTML = blank(uiText('Read campaigns to open the selected account.'));
  });
  workspaceBind('#portfolio-account', async form => {
    const t = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !t) throw Error(uiText('Choose an account.'));
    const {label, ...binding} = t;
    target = binding;
    await load({entity: 'campaign'});
  });
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
  const targets = accountChoices(['gtm']);
  content.innerHTML += `<section class="panel"><h2>${esc(uiText('Measurement evidence'))}</h2><p>${esc(uiText('Review configured tags, trigger dependencies, workspace conflicts and published-version consistency. Configuration evidence is distinct from observed event delivery and attribution.'))}</p><div class="work-links"><a href="/reporting-overview"><strong>${esc(uiText('GA4 and Search Console context'))}</strong><small>${esc(uiText('Collect measurement reports with source definitions.'))}</small></a><a href="/profiles"><strong>${esc(uiText('Client conversion mappings'))}</strong><small>${esc(uiText('Inspect approved conversion definitions and account bindings.'))}</small></a><a href="/capabilities"><strong>${esc(uiText('Reviewed measurement changes'))}</strong><small>${esc(uiText('Discover exact conversion and tag contracts.'))}</small></a></div></section><section class="panel workspace-form"><h2>${esc(uiText('Google Tag Manager configuration audit'))}</h2><form id="measurement-audit"><label>${esc(uiText('Tag Manager account'))}<select name="target" required><option value="">${esc(uiText('Choose a selected account'))}</option>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label>${controls(uiText('Container ID (optional for account inventory)'), 'text', '', 'container_id')}${controls(uiText('Workspace ID (optional)'), 'text', '', 'workspace_id')}<button class="button primary" type="submit">${esc(uiText('Read configuration evidence'))}</button></form><div id="measurement-result"></div></section>`;
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
    result.innerHTML = `<p class="notice">${esc(out.meaning)}</p>${badge(c.complete ? 'complete' : 'incomplete')}<h3>${esc(uiText('Configuration findings'))}</h3>${(c.findings ?? []).map(f => `<article><h4>${esc(pretty(f.code))} · ${esc(f.severity)}</h4><p>${esc(f.message)}</p><code>${esc(f.path)}</code></article>`).join('') || `<p>${esc(uiText('No configuration finding was returned for this scope.'))}</p>`}${reviewTable(c.versions ?? {}, uiText('Published version evidence'))}${recordDetails(c, uiText('Audit scope, limits and native evidence'))}`;
  });
}
function parseProductCSV(text) {
  if (text.length > 131072) throw Error(uiText('Use a CSV smaller than 128 KiB and at most 50 products.'));
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
  if (!headers?.length || new Set(headers).size !== headers.length)
    throw Error(uiText('Use unique named CSV columns.'));
  if (rows.length > 50) throw Error(uiText('Import at most 50 products in each reviewed plan.'));
  return rows.map(r => {
    if (r.length !== headers.length) throw Error(uiText('Every CSV row must match the header columns.'));
    return Object.fromEntries(headers.map((h, i) => [h, r[i]]).filter(([, v]) => v !== ''));
  });
}
async function renderCommerce() {
  const targets = accountChoices(['meta']);
  content.innerHTML += `<section class="panel workspace-form"><h2>${esc(uiText('Reviewed Meta product import'))}</h2><p>${esc(uiText('Import up to 50 product rows into an existing authorized catalog. Every item retains a separate native review, receipt and read-back in its saved plan. Missing items are retained.'))}</p><form id="catalog-import"><label>${esc(uiText('Meta ad account'))}<select name="target" required><option value="">${esc(uiText('Choose an account'))}</option>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label>${controls(uiText('Native product catalog ID'), 'text', '', 'catalog_id')}${controls(uiText('Import plan name'), 'text', 'Product catalog import', 'name')}<label>${esc(uiText('Product CSV'))}<input type="file" name="file" accept=".csv,text/csv" required></label><p class="form-note">${esc(uiText('Required columns: retailer_id, name, price, currency, image_url. Optional: url, availability, condition, brand, description. Price is a decimal amount in the product currency with at most two decimal places. Use HTTPS links.'))}</p><label>${esc(uiText('Existing retailer IDs'))}<select name="allow_upsert"><option value="false">${esc(uiText('Create only — refuse existing IDs'))}</option><option value="true">${esc(uiText('Explicitly update existing IDs after native review'))}</option></select></label><button class="button primary" type="submit">${esc(uiText('Validate and preview products'))}</button></form><div id="catalog-preview"></div></section><p class="notice">${esc(uiText('This workflow uses the qualified Meta product contract. WooCommerce ingestion, supplementary feeds and other destinations require separate adapters and qualification.'))}</p>`;
  const form = $('#catalog-import'),
    result = $('#catalog-preview'),
    begin = accountWorkflowContext(form, result);
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
      const text = await file.text();
      if (!current()) return;
      request = {...settings, products: parseProductCSV(text)};
      out = await workspaceCall('workspace', {action: 'catalog_preview', ...request});
    } catch (error) {
      if (current()) throw error;
      return;
    }
    if (!current()) return;
    result.innerHTML =
      reviewTable(out.items, uiText('Products and exact native price units')) +
      `<p>${esc(out.meaning)}</p><p>${esc(uiText('Source hash'))} <code>${esc(out.source_hash)}</code></p><button class="button primary" id="create-catalog-plan">${esc(uiText('Save this product plan for native review'))}</button>`;
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
