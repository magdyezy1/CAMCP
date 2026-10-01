'use strict';
function creativeAssetCard(a) {
  return `<article class="operation-card creative-asset"><div class="operation-heading"><div><h3>${esc(a.name)}</h3><small>${esc(recordAccountLabel(a.platform, a.connection_id, a.account_id))}</small></div>${badge(a.media_type || 'media')}</div><p>${a.tags.map(t => `<span class="creative-tag">${esc(t)}</span>`).join('') || `<span class="form-note">${esc(uiText('No tags yet'))}</span>`}</p><p class="form-note">${esc(uiText('Provider ID'))} <code>${esc(a.media_id)}</code></p><p class="form-note">${a.last_checked_at ? uiText('Last availability check ') + date(a.last_checked_at) : uiText('Availability has not been checked')}${esc(uiText('. Check again before reuse.'))}</p><button class="button small" data-creative-asset="${esc(a.asset_id)}">${esc(uiText('Inspect asset and usage'))}</button></article>`;
}
function creativeUsageRows(a) {
  return (
    a.usage
      .map(
        p =>
          `<article class="operation-card"><h3><a href="${esc(p.website_path)}">${esc(p.name)}</a></h3><ol>${p.steps.map(s => `<li><strong>${esc(s.step_id)}</strong> · ${esc(pretty(s.status))}<p class="form-note">${s.resource_ids.map(id => `<code>${esc(id)}</code>`).join(' · ')}</p></li>`).join('')}</ol>${p.steps.some(s => s.entity_type === 'ad') ? `<button class="button small" data-creative-performance="${esc(p.plan_id)}">${esc(uiText('Inspect linked ad performance'))}</button>` : ''}</article>`,
      )
      .join('') || blank(uiText('No verified usage found on this page of retained plans within your access.'))
  );
}
async function mountCreativePerformance(asset, planId, current) {
  const host = $('#creative-performance'),
    root = document.createElement('section');
  host.replaceChildren(root);
  root.innerHTML = `<h3>${esc(uiText('Performance of linked ads'))}</h3><p>${esc(uiText('Choose retained Meta ad evidence from this exact account and login. This does not establish which creative served throughout the reporting window.'))}</p><div id="creative-report-choices"></div><form id="creative-performance-form"><label>${esc(uiText('Selected ad evidence'))}<select name="report_id" required><option value="">${esc(uiText('Choose a report below'))}</option></select></label><button class="button" type="submit">${esc(uiText('Show linked ad results'))}</button></form><div id="creative-performance-results" aria-live="polite"></div>`;
  const scope = {action: 'asset_performance', asset_id: asset.asset_id};
  const resetResults = () => {
    const next = document.createElement('div');
    next.id = 'creative-performance-results';
    next.setAttribute('aria-live', 'polite');
    root.querySelector('#creative-performance-results').replaceWith(next);
  };
  const choices = workPageLoader(
    '#creative-report-choices',
    uiText('Compatible evidence snapshots'),
    cursor => workspaceCall('media', {...scope, limit: 10, ...(cursor ? {cursor} : {})}),
    r =>
      r.reports.length
        ? r.reports
            .map(
              p =>
                `<p>${esc(p.semantics.source_name)} · ${esc(p.semantics.date_from)} — ${esc(p.semantics.date_to)} · ${esc(p.semantics.currency)} · ${date(p.captured_at)}</p>`,
            )
            .join('')
        : `<p>${esc(uiText('No matching evidence on this page.'))} <a href="/reports">${esc(uiText('Capture Meta ad evidence'))}</a> ${esc(uiText('for this account and login.'))}</p>`,
    r => {
      if (!current() || !root.isConnected) return;
      root.querySelector('select[name="report_id"]').innerHTML =
        `<option value="">${esc(uiText('Choose explicitly'))}</option>` +
        r.reports
          .map(
            p =>
              `<option value="${esc(p.id)}">${esc(p.semantics.source_name)} · ${esc(p.semantics.date_from)} — ${esc(p.semantics.date_to)}</option>`,
          )
          .join('');
      resetResults();
    },
  );
  await choices.load();
  if (!current() || !root.isConnected) return;
  root.querySelector('select[name="report_id"]').addEventListener('change', resetResults);
  let selected = 0;
  workspaceBind('#creative-performance-form', async form => {
    const reportId = form.elements.report_id.value,
      request = ++selected;
    if (!reportId) throw Error(uiText('Choose the exact retained report.'));
    resetResults();
    const results = workPageLoader(
      '#creative-performance-results',
      uiText('Daily rows for verified linked ads'),
      async cursor => {
        const r = await workspaceCall('media', {
          ...scope,
          plan_id: planId,
          report_id: reportId,
          offset: cursor ?? 0,
          limit: 20,
        });
        return {...r, next_cursor: r.next_offset};
      },
      r =>
        `<p>${esc(r.semantics.currency)} · ${esc(r.semantics.timezone)} · ${esc(r.semantics.attribution)} · ${esc(r.semantics.conversion_definition)} · ${r.semantics.complete ? uiText('Complete window') : uiText('Incomplete window')}</p><div class="data-scroll"><table class="review-table"><caption>${esc(uiText('Ad-level performance from the selected snapshot'))}</caption><thead><tr><th>${esc(uiText('Ad'))}</th><th>${esc(uiText('Date'))}</th><th>${esc(uiText('Spend'))}</th><th>${esc(uiText('Clicks'))}</th><th>${esc(uiText('Conversions'))}</th></tr></thead><tbody>${r.rows.map(row => `<tr><td><div>${esc(row.entity_name || row.entity_id)}</div><small>ID ${esc(row.entity_id)}</small></td><td>${esc(row.date)}</td><td>${esc(row.spend ?? uiText('Unknown'))}</td><td>${esc(row.clicks ?? uiText('Unknown'))}</td><td>${esc(row.conversions ?? uiText('Unknown'))}</td></tr>`).join('') || `<tr><td colspan="5">${esc(uiText('No matching performance rows. This is not evidence of zero delivery.'))}</td></tr>`}</tbody></table></div><p><a href="${esc(r.report_path)}">${esc(uiText('Inspect original evidence'))}</a></p><ul>${r.limitations.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`,
    );
    await results.load();
    if (current() && root.isConnected && request === selected) root.scrollIntoView({block: 'nearest'});
  });
}
async function bindCreativeLibrary(targets, showStatus) {
  const root = $('#creative-library'),
    generation = navigationGeneration,
    params = new URLSearchParams(location.search);
  root.innerHTML = `<div class="panel-header"><h2>${esc(uiText('Creative library'))}</h2><button id="creative-refresh" class="button small">${esc(uiText('Refresh'))}</button></div><p class="workspace-copy">${esc(uiText('Find uploaded media, organize it with names and tags, and trace its use in campaign plans.'))}</p><form id="creative-filter" class="work-filter"><label>${esc(uiText('Search name or provider ID'))}<input name="search" type="search" maxlength="200" value="${esc(params.get('search'))}"></label><label>${esc(uiText('Tag'))}<input name="tag" maxlength="40" value="${esc(params.get('tag'))}"></label><label>${esc(uiText('Advertising account'))}<select name="target"><option value="">${esc(uiText('All accessible accounts'))}</option>${targets.map((t, i) => `<option value="${i}" ${t.connection_id === params.get('connection_id') && t.account_id === params.get('account_id') ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></label><button class="button primary" type="submit">${esc(uiText('Find media'))}</button></form><div id="creative-results"><p data-page-status role="status">${esc(uiText('Loading library…'))}</p></div><p class="form-note">${esc(uiText('Metadata remains available after original files expire. Upload receipts are historical; reuse checks provider availability again.'))}</p>`;
  let filters = Object.fromEntries(
    ['search', 'tag', 'platform', 'account_id', 'connection_id']
      .filter(k => params.has(k))
      .map(k => [k, params.get(k)]),
  );
  const form = $('#creative-filter');
  if (
    filters.account_id &&
    !targets.some(t => t.account_id === filters.account_id && t.connection_id === filters.connection_id)
  ) {
    form.elements.target.insertAdjacentHTML(
      'beforeend',
      `<option value="unavailable" selected>${esc(uiText('Previously selected account'))}</option>`,
    );
  }
  const pager = workPageLoader(
    '#creative-results',
    uiText('Uploaded media'),
    cursor => workspaceCall('media', {action: 'library', ...filters, limit: 12, ...(cursor ? {cursor} : {})}),
    r =>
      r.assets.map(creativeAssetCard).join('') ||
      blank(
        r.has_more
          ? uiText('No matching assets on this page. Continue to the next page.')
          : uiText('No matching uploaded media within your current access.'),
      ),
    () => workspaceBind('[data-creative-asset]', b => openAsset(b.dataset.creativeAsset)),
  );
  const detail = $('#creative-detail');
  let sequence = 0;
  const current = request => request === sequence && generation === navigationGeneration && detail.isConnected;
  const openAsset = async id => {
    const request = ++sequence;
    detail.innerHTML = `<p role="status">${esc(uiText('Loading asset details…'))}</p>`;
    const query = new URLSearchParams(location.search);
    query.set('asset_id', id);
    history.replaceState(null, '', '/media?' + query);
    try {
      const a = await workspaceCall('media', {action: 'asset', asset_id: id});
      if (!current(request)) return;
      const readOnly = session.workspaceRole === 'viewer';
      detail.innerHTML = `<section class="panel workspace-form creative-asset"><div class="panel-header"><h2>${esc(a.name)}</h2><a href="${esc(a.website_path)}">${esc(uiText('Link to this asset'))}</a></div><p>${esc(recordAccountLabel(a.platform, a.connection_id, a.account_id))}</p><div class="workspace-columns"><div><h3>${esc(uiText('File and receipt'))}</h3><dl class="creative-facts"><dt>${esc(uiText('Provider name'))}</dt><dd>${esc(a.provider_name)}</dd><dt>${esc(uiText('Provider ID'))}</dt><dd><code>${esc(a.media_id)}</code></dd><dt>${esc(uiText('Uploaded bytes SHA-256'))}</dt><dd><code>${esc(a.uploaded_sha256)}</code></dd><dt>${esc(uiText('Original file'))}</dt><dd>${a.source.available ? uiText('Available until ') + date(a.source.expires_at) : uiText('Unavailable or expired. Import the original file again to create new variants.')}</dd>${a.dimensions_uploaded ? `<dt>${esc(uiText('Uploaded dimensions'))}</dt><dd>${esc(a.dimensions_uploaded.width)} × ${esc(a.dimensions_uploaded.height)}</dd>` : ''}</dl><div class="dialog-actions work-actions"><button id="creative-status" class="button" ${readOnly ? 'disabled' : ''}>${esc(uiText('Check provider status'))}</button><button id="creative-reuse" class="button" ${readOnly ? 'disabled' : ''}>${esc(uiText('Check availability for reuse'))}</button></div><div id="creative-reuse-result" role="status"></div></div><form id="creative-metadata"><h3>${esc(uiText('Library metadata'))}</h3><p class="form-note">${esc(uiText('These labels organize your workspace. They do not rename media at the provider.'))}</p><label>${esc(uiText('Library name'))}<input name="name" maxlength="160" required value="${esc(a.name)}" ${readOnly ? 'disabled' : ''}></label><label>${esc(uiText('Tags, separated by commas'))}<input name="tags" value="${esc(a.tags.join(', '))}" ${readOnly ? 'disabled' : ''}></label><label class="form-note"><input type="checkbox" name="confirmed" required ${readOnly ? 'disabled' : ''}> ${esc(uiText('Save these workspace labels'))}</label><button type="submit" class="button primary" ${readOnly ? 'disabled' : ''}>${esc(uiText('Save metadata'))}</button></form></div><h3>${esc(uiText('Verified campaign usage'))}</h3><p class="form-note">${esc(uiText('Only verified steps linked through actual result references are included. External usage is unknown; performance has not been attributed to this asset.'))}</p><div id="creative-usage"></div></section>`;
      workspaceBind('#creative-status', () => showStatus(id));
      workspaceBind('#creative-reuse', async () => {
        const r = await workspaceCall('media', {action: 'reuse', asset_id: id});
        if (current(request))
          $('#creative-reuse-result').innerHTML = recordDetails(
            r,
            uiText('Fresh provider availability and retained receipt'),
          );
      });
      workspaceBind('#creative-metadata', async f => {
        const v = Object.fromEntries(new FormData(f));
        await workspaceCall('media', {
          action: 'save_asset_metadata',
          asset_id: id,
          revision: a.metadata_revision,
          confirmed: v.confirmed === 'on',
          metadata: {
            name: v.name,
            tags: v.tags
              .split(',')
              .map(t => t.trim())
              .filter(Boolean),
          },
        });
        if (!current(request)) return;
        await openAsset(id);
        await pager.load();
        toast(uiText('Library metadata saved.'));
      });
      detail.querySelector('.creative-asset').insertAdjacentHTML('beforeend', `<div id="creative-performance"></div>`);
      let initial = a;
      const usage = workPageLoader(
        '#creative-usage',
        uiText('Retained plan evidence'),
        async cursor => {
          if (!cursor && initial) {
            const result = initial;
            initial = null;
            return result;
          }
          return workspaceCall('media', {action: 'asset', asset_id: id, ...(cursor ? {cursor} : {})});
        },
        creativeUsageRows,
        () =>
          workspaceBind('[data-creative-performance]', b =>
            mountCreativePerformance(a, b.dataset.creativePerformance, () => current(request)),
          ),
      );
      await usage.load();
      if (current(request)) {
        detail.setAttribute('tabindex', '-1');
        detail.focus();
      }
    } catch (e) {
      if (current(request)) detail.innerHTML = `<p class="error" role="alert">${esc(errorMessage(e))}</p>`;
    }
  };
  workspaceBind('#creative-filter', async () => {
    const v = Object.fromEntries(new FormData(form));
    if (v.target === 'unavailable') filters = {...filters, search: v.search, tag: v.tag};
    else {
      const t = targets[Number(v.target)];
      filters = {
        search: v.search,
        tag: v.tag,
        ...(v.target !== '' && t
          ? {platform: t.platform, connection_id: t.connection_id, account_id: t.account_id}
          : {}),
      };
    }
    history.replaceState(null, '', '/media?' + new URLSearchParams(Object.entries(filters).filter(([, v]) => v)));
    ++sequence;
    detail.innerHTML = '';
    await pager.load();
  });
  workspaceBind('#creative-refresh', () => pager.load());
  await pager.load();
  if (generation === navigationGeneration && root.isConnected && params.get('asset_id'))
    await openAsset(params.get('asset_id'));
}
