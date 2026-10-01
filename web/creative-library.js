'use strict';
function creativeAssetCard(a) {
  return `<article class="operation-card creative-asset"><div class="operation-heading"><div><h3>${esc(a.name)}</h3><small>${esc(recordAccountLabel(a.platform, a.connection_id, a.account_id))}</small></div>${badge(a.media_type || 'media')}</div><p>${a.tags.map(t => `<span class="creative-tag">${esc(t)}</span>`).join('') || '<span class="form-note">No tags yet</span>'}</p><p class="form-note">Provider ID <code>${esc(a.media_id)}</code></p><p class="form-note">${a.last_checked_at ? 'Last availability check ' + date(a.last_checked_at) : 'Availability has not been checked'}. Check again before reuse.</p><button class="button small" data-creative-asset="${esc(a.asset_id)}">Inspect asset and usage</button></article>`;
}
function creativeUsageRows(a) {
  return (
    a.usage
      .map(
        p =>
          `<article class="operation-card"><h3><a href="${esc(p.website_path)}">${esc(p.name)}</a></h3><ol>${p.steps.map(s => `<li><strong>${esc(s.step_id)}</strong> · ${esc(pretty(s.status))}<p class="form-note">${s.resource_ids.map(id => `<code>${esc(id)}</code>`).join(' · ')}</p></li>`).join('')}</ol></article>`,
      )
      .join('') || blank('No verified usage found on this page of retained plans within your access.')
  );
}
async function bindCreativeLibrary(targets, showStatus) {
  const root = $('#creative-library'),
    generation = navigationGeneration,
    params = new URLSearchParams(location.search);
  root.innerHTML = `<div class="panel-header"><h2>Creative library</h2><button id="creative-refresh" class="button small">Refresh</button></div><p class="workspace-copy">Find uploaded media, organize it with names and tags, and trace its use in campaign plans.</p><form id="creative-filter" class="work-filter"><label>Search name or provider ID<input name="search" type="search" maxlength="200" value="${esc(params.get('search'))}"></label><label>Tag<input name="tag" maxlength="40" value="${esc(params.get('tag'))}"></label><label>Advertising account<select name="target"><option value="">All accessible accounts</option>${targets.map((t, i) => `<option value="${i}" ${t.connection_id === params.get('connection_id') && t.account_id === params.get('account_id') ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></label><button class="button primary" type="submit">Find media</button></form><div id="creative-results"><p data-page-status role="status">Loading library…</p></div><p class="form-note">Metadata remains available after original files expire. Upload receipts are historical; reuse checks provider availability again.</p>`;
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
      '<option value="unavailable" selected>Previously selected account</option>',
    );
  }
  const pager = workPageLoader(
    '#creative-results',
    'Uploaded media',
    cursor => workspaceCall('media', {action: 'library', ...filters, limit: 12, ...(cursor ? {cursor} : {})}),
    r =>
      r.assets.map(creativeAssetCard).join('') ||
      blank(
        r.has_more
          ? 'No matching assets on this page. Continue to the next page.'
          : 'No matching uploaded media within your current access.',
      ),
    () => workspaceBind('[data-creative-asset]', b => openAsset(b.dataset.creativeAsset)),
  );
  const detail = $('#creative-detail');
  let sequence = 0;
  const current = request => request === sequence && generation === navigationGeneration && detail.isConnected;
  const openAsset = async id => {
    const request = ++sequence;
    detail.innerHTML = '<p role="status">Loading asset details…</p>';
    const query = new URLSearchParams(location.search);
    query.set('asset_id', id);
    history.replaceState(null, '', '/media?' + query);
    try {
      const a = await workspaceCall('media', {action: 'asset', asset_id: id});
      if (!current(request)) return;
      const readOnly = session.workspaceRole === 'viewer';
      detail.innerHTML = `<section class="panel workspace-form creative-asset"><div class="panel-header"><h2>${esc(a.name)}</h2><a href="${esc(a.website_path)}">Link to this asset</a></div><p>${esc(recordAccountLabel(a.platform, a.connection_id, a.account_id))}</p><div class="workspace-columns"><div><h3>File and receipt</h3><dl class="creative-facts"><dt>Provider name</dt><dd>${esc(a.provider_name)}</dd><dt>Provider ID</dt><dd><code>${esc(a.media_id)}</code></dd><dt>Uploaded bytes SHA-256</dt><dd><code>${esc(a.uploaded_sha256)}</code></dd><dt>Original file</dt><dd>${a.source.available ? 'Available until ' + date(a.source.expires_at) : 'Unavailable or expired. Import the original file again to create new variants.'}</dd>${a.dimensions_uploaded ? `<dt>Uploaded dimensions</dt><dd>${esc(a.dimensions_uploaded.width)} × ${esc(a.dimensions_uploaded.height)}</dd>` : ''}</dl><div class="dialog-actions work-actions"><button id="creative-status" class="button" ${readOnly ? 'disabled' : ''}>Check provider status</button><button id="creative-reuse" class="button" ${readOnly ? 'disabled' : ''}>Check availability for reuse</button></div><div id="creative-reuse-result" role="status"></div></div><form id="creative-metadata"><h3>Library metadata</h3><p class="form-note">These labels organize your workspace. They do not rename media at the provider.</p><label>Library name<input name="name" maxlength="160" required value="${esc(a.name)}" ${readOnly ? 'disabled' : ''}></label><label>Tags, separated by commas<input name="tags" value="${esc(a.tags.join(', '))}" ${readOnly ? 'disabled' : ''}></label><label class="form-note"><input type="checkbox" name="confirmed" required ${readOnly ? 'disabled' : ''}> Save these workspace labels</label><button type="submit" class="button primary" ${readOnly ? 'disabled' : ''}>Save metadata</button></form></div><h3>Verified campaign usage</h3><p class="form-note">Only verified steps linked through actual result references are included. External usage is unknown; performance has not been attributed to this asset.</p><div id="creative-usage"></div></section>`;
      workspaceBind('#creative-status', () => showStatus(id));
      workspaceBind('#creative-reuse', async () => {
        const r = await workspaceCall('media', {action: 'reuse', asset_id: id});
        if (current(request))
          $('#creative-reuse-result').innerHTML = recordDetails(r, 'Fresh provider availability and retained receipt');
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
        toast('Library metadata saved.');
      });
      let initial = a;
      const usage = workPageLoader(
        '#creative-usage',
        'Retained plan evidence',
        async cursor => {
          if (!cursor && initial) {
            const result = initial;
            initial = null;
            return result;
          }
          return workspaceCall('media', {action: 'asset', asset_id: id, ...(cursor ? {cursor} : {})});
        },
        creativeUsageRows,
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
