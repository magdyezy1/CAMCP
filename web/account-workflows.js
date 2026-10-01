'use strict';
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
  content.innerHTML += `<p class="notice">Browse current Google Ads and Meta campaigns, their ad groups or ad sets, and ads. Inventory is read-only; provider changes require a separate review.</p><form id="portfolio-account" class="panel workspace-form"><label>Advertising account<select name="target" required><option value="">Choose a login and account</option>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label><button class="button primary" type="submit">Read campaigns</button></form><div id="portfolio-view" aria-live="polite"></div>`;
  const view = $('#portfolio-view'),
    form = $('#portfolio-account');
  let target = null,
    current = {entity: 'campaign'},
    cursor = null,
    sequence = 0;
  const load = async (config, next = null) => {
    if (!target) throw Error('Choose an account and read its campaigns first.');
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
      child = meta ? 'Ad sets' : 'Ad groups';
    const money = r => {
      if (r.native_money) {
        const entries = Object.entries(r.native_money).filter(([, v]) => v !== null);
        return entries.length
          ? entries.map(([k, v]) => `<div>${esc(pretty(k))}: <b>${esc(v)}</b></div>`).join('') +
              '<small>Meta native integers · unconverted</small>'
          : 'No amount returned';
      }
      return r.budget_micros != null
        ? esc(r.budget_micros) + ' budget micros'
        : r.cpc_bid_micros != null
          ? esc(r.cpc_bid_micros) + ' CPC bid micros'
          : '—';
    };
    view.innerHTML = `<section class="panel"><div class="dialog-actions"><button id="portfolio-root" class="button">Campaigns</button>${config.campaign_id ? `<button id="portfolio-parent" class="button">${child} for ${esc(config.campaign_id)}</button>` : ''}<a class="button" href="/campaigns#campaign-create">Create or clone a plan</a><a class="button" href="/reports#report-capture">Capture performance evidence</a></div><h2 id="portfolio-heading" tabindex="-1">${config.entity === 'adset' ? 'Ad set' : esc(pretty(config.entity))} inventory</h2><p><strong>${meta ? 'Meta' : 'Google Ads'} · Account ${esc(out.account_id)}</strong>${config.campaign_id ? ' · Campaign ' + esc(config.campaign_id) : ''}${config.adset_id || config.ad_group_id ? ' · ' + (meta ? 'Ad set ' : 'Ad group ') + esc(config.adset_id ?? config.ad_group_id) : ''}</p><p>Read ${date(out.captured_at)} · Current inventory</p><details class="workspace-details"><summary>Inventory scope and native units</summary><p>${esc(out.meaning)}</p></details><div class="data-scroll" role="region" aria-label="Portfolio entities" tabindex="0"><table class="review-table"><thead><tr><th scope="col">Entity</th><th scope="col">Native status</th><th scope="col">Native money fields</th><th scope="col">Next view</th></tr></thead><tbody>${out.rows.map((r, i) => `<tr><th scope="row">${esc(r.name)}<small>${esc(r.id)}</small></th><td><strong>${esc(r.status ?? 'Unknown')}</strong>${meta ? `<small>Effective: ${esc(r.effective_status ?? 'Unknown')}</small>` : ''}${recordDetails(r.native, 'Native fields')}</td><td>${money(r)}<small>${esc(r.currency ?? 'Currency unknown')} · ${esc(r.timezone ?? 'Timezone unknown')}</small></td><td>${config.entity !== 'ad' ? `<button class="button small" data-portfolio-child="${i}">${config.entity === 'campaign' ? child : 'Ads'}</button>` : 'Read-only ad record'}</td></tr>`).join('') || '<tr><td colspan="4">No entities in this page. Follow Next page if the provider supplies a continuation.</td></tr>'}</tbody></table></div><div class="dialog-actions"><button class="button" id="portfolio-refresh">Refresh first page</button><button class="button" id="portfolio-next" ${out.has_more ? '' : 'hidden'}>Next page</button></div></section>`;
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
    view.innerHTML = blank('Read campaigns to open the selected account.');
  });
  workspaceBind('#portfolio-account', async form => {
    const t = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !t) throw Error('Choose an account.');
    const {label, ...binding} = t;
    target = binding;
    await load({entity: 'campaign'});
  });
}
async function renderMeasurement() {
  const targets = accountChoices(['gtm']);
  content.innerHTML += `<section class="panel"><h2>Measurement evidence</h2><p>Review configured tags, trigger dependencies, workspace conflicts and published-version consistency. Configuration evidence is distinct from observed event delivery and attribution.</p><div class="work-links"><a href="/reporting-overview"><strong>GA4 and Search Console context</strong><small>Collect measurement reports with source definitions.</small></a><a href="/profiles"><strong>Client conversion mappings</strong><small>Inspect approved conversion definitions and account bindings.</small></a><a href="/capabilities"><strong>Reviewed measurement changes</strong><small>Discover exact conversion and tag contracts.</small></a></div></section><section class="panel workspace-form"><h2>Google Tag Manager configuration audit</h2><form id="measurement-audit"><label>Tag Manager account<select name="target" required><option value="">Choose a selected account</option>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label>${controls('Container ID (optional for account inventory)', 'text', '', 'container_id')}${controls('Workspace ID (optional)', 'text', '', 'workspace_id')}<button class="button primary" type="submit">Read configuration evidence</button></form><div id="measurement-result"></div></section>`;
  workspaceBind('#measurement-audit', async form => {
    const t = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !t) throw Error('Choose a Tag Manager account.');
    const requirements = Object.fromEntries(
      ['container_id', 'workspace_id']
        .filter(k => form.elements[k].value.trim())
        .map(k => [k, form.elements[k].value.trim()]),
    );
    const out = await workspaceCall('workspace', {
        action: 'measurement_audit',
        connection_id: t.connection_id,
        account_id: t.account_id,
        requirements,
      }),
      c = out.configuration;
    $('#measurement-result').innerHTML =
      `<p class="notice">${esc(out.meaning)}</p>${badge(c.complete ? 'complete' : 'incomplete')}<h3>Configuration findings</h3>${(c.findings ?? []).map(f => `<article><h4>${esc(pretty(f.code))} · ${esc(f.severity)}</h4><p>${esc(f.message)}</p><code>${esc(f.path)}</code></article>`).join('') || '<p>No configuration finding was returned for this scope.</p>'}${reviewTable(c.versions ?? {}, 'Published version evidence')}${recordDetails(c, 'Audit scope, limits and native evidence')}`;
  });
}
function parseProductCSV(text) {
  if (text.length > 131072) throw Error('Use a CSV smaller than 128 KiB and at most 50 products.');
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
      if (field || closed) throw Error('Invalid CSV quoting.');
      quoted = true;
      continue;
    }
    if (closed && !['\r', '\n', ','].includes(c)) throw Error('Unexpected text after a quoted CSV value.');
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
  if (quoted) throw Error('A quoted CSV value is not closed.');
  row.push(field);
  if (row.some(v => v !== '')) rows.push(row);
  const headers = rows.shift()?.map(h => h.replace(/^\uFEFF/, '').trim());
  if (!headers?.length || new Set(headers).size !== headers.length) throw Error('Use unique named CSV columns.');
  if (rows.length > 50) throw Error('Import at most 50 products in each reviewed plan.');
  return rows.map(r => {
    if (r.length !== headers.length) throw Error('Every CSV row must match the header columns.');
    return Object.fromEntries(headers.map((h, i) => [h, r[i]]).filter(([, v]) => v !== ''));
  });
}
async function renderCommerce() {
  const targets = accountChoices(['meta']);
  content.innerHTML += `<section class="panel workspace-form"><h2>Reviewed Meta product import</h2><p>Import up to 50 product rows into an existing authorized catalog. Every item retains a separate native review, receipt and read-back in its saved plan. Missing items are retained.</p><form id="catalog-import"><label>Meta ad account<select name="target" required><option value="">Choose an account</option>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label>${controls('Native product catalog ID', 'text', '', 'catalog_id')}${controls('Import plan name', 'text', 'Product catalog import', 'name')}<label>Product CSV<input type="file" name="file" accept=".csv,text/csv" required></label><p class="form-note">Required columns: retailer_id, name, price, currency, image_url. Optional: url, availability, condition, brand, description. Price is a decimal amount in the product currency with at most two decimal places. Use HTTPS links.</p><label>Existing retailer IDs<select name="allow_upsert"><option value="false">Create only — refuse existing IDs</option><option value="true">Explicitly update existing IDs after native review</option></select></label><button class="button primary" type="submit">Validate and preview products</button></form><div id="catalog-preview"></div></section><p class="notice">This workflow uses the qualified Meta product contract. WooCommerce ingestion, supplementary feeds and other destinations require separate adapters and qualification.</p>`;
  workspaceBind('#catalog-import', async form => {
    const generation = navigationGeneration;
    const target = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !target) throw Error('Choose the exact account.');
    const file = form.elements.file.files[0];
    if (!file || file.size > 131072) throw Error('Choose a CSV smaller than 128 KiB.');
    const text = await file.text();
    if (generation !== navigationGeneration) return;
    const products = parseProductCSV(text),
      {label, ...binding} = target;
    const request = {
      ...binding,
      catalog_id: form.elements.catalog_id.value.trim(),
      name: form.elements.name.value.trim(),
      allow_upsert: form.elements.allow_upsert.value === 'true',
      products,
    };
    const out = await workspaceCall('workspace', {action: 'catalog_preview', ...request});
    $('#catalog-preview').innerHTML =
      reviewTable(out.items, 'Products and exact native price units') +
      `<p>${esc(out.meaning)}</p><p>Source hash <code>${esc(out.source_hash)}</code></p><button class="button primary" id="create-catalog-plan">Save this product plan for native review</button>`;
    workspaceBind('#create-catalog-plan', async () => {
      const plan = await workspaceCall('workspace', {action: 'catalog_plan', ...request});
      await navigate('/campaigns?id=' + encodeURIComponent(plan.id));
    });
  });
}
