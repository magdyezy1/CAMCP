'use strict';
const creativeNativeReferenceMessages = new Set([
  'Current explicit latest-version image links in the selected Google ad asset view and original upload account. The view covers App, Demand Gen and Responsive Search ads; Responsive Display, Performance Max and other formats remain outside this evidence. Missing link flags or types remain unknown, and removed links are counted separately. Configured statuses do not prove serving, historical attribution, performance, reuse eligibility or complete all-format absence. This read grants no write authority.',
  'Choose a complete Google image-reference limit of 1–1000. This read has no native continuation.',
  'The original image, login or native references changed. Read the original asset again.',
  'Current Google image references require the exact original account asset resource and uploaded SHA-256.',
  'Google returned malformed or unselected native image-reference fields.',
  'Google returned an unqualified native image-reference type or status.',
  'Google returned incomplete native image-reference evidence.',
  'Google returned unqualified image-reference result counts.',
  'The Google image-reference collection exceeds your selected limit. No partial inventory was returned.',
  'Google returned an incomplete native image-reference collection.',
  'One exact Google upload customer is required.',
  'Google returned a different or unqualified image upload customer.',
  'Select the original client upload account for Google image references.',
  'One exact original Google image asset is required.',
  'Google returned a different original image asset or native type.',
  'Google returned a foreign, inconsistent or malformed native image-reference identity.',
  'Google returned a repeated or removed native image-reference ad.',
  'Google image-reference inspection reached its bounded request, row, byte or time limit.',
  'Current native usage is qualified only for Meta v26 image or video upload receipts.',
  'Current scalar Meta creative image-hash or video-ID references in the original upload account. Missing and unsupported formats remain unknown. Configured and effective status do not prove delivery. This is not historical creative attribution or a point-in-time inventory; provider changes can move or repeat ads between pages. An empty matching page can still continue. This read grants no write authority.',
  'Meta continuation is missing, repeated or exceeds 100 native reference pages. Restart or narrow the view.',
  'Meta did not return a bounded native ad page.',
  'Meta returned a different native upload account.',
  'Meta returned a foreign or inexact native creative identity.',
  'Meta returned a foreign, repeated or inexact native ad reference.',
  'Meta returned a malformed native creative reference.',
  'Meta returned incomplete or oversized native reference evidence.',
  'Meta returned malformed native reference paging.',
  'Meta returned malformed native reference text.',
  'Native reference pages contain 1–100 ads.',
  'Restart this original asset, identity, login and page size; the native reference cursor is invalid or expired.',
  'Retain an exact native image hash or video ID and the original uploaded SHA-256.',
  'Retain the exact original Meta upload account.',
  'The Meta API version changed. Restart the native reference read.',
  'The native upload account changed during observation. Restart this view.',
  'The original asset changed. Restart its native reference read.',
  'The selected login changed. Restart the native reference read.',
  'This login requires Meta advertising read permission.',
  'This native reference read reached its request, row, byte or time limit. Restart with a smaller page.',
]);
function creativeAssetCard(a) {
  return `<article class="operation-card creative-asset"><div class="operation-heading"><div><h3>${esc(a.name)}</h3><small>${esc(recordAccountLabel(a.platform, a.connection_id, a.account_id))}</small></div>${badge(a.media_type || 'media')}</div><p>${a.tags.map(t => `<span class="creative-tag">${esc(t)}</span>`).join('') || `<span class="form-note">${esc(uiText('No tags yet'))}</span>`}</p><p class="form-note">${esc(uiText('Provider ID'))} <code>${esc(a.media_id)}</code></p><p class="form-note">${a.last_checked_at ? uiText('Last availability check ') + date(a.last_checked_at) : uiText('Availability has not been checked')}${esc(uiText('. Check again before reuse.'))}</p><button class="button small" data-creative-asset="${esc(a.asset_id)}">${esc(uiText('Inspect asset and usage'))}</button></article>`;
}
function creativeUsageRows(a) {
  return (
    a.usage
      .map(
        p =>
          `<article class="operation-card"><h3><a href="${esc(p.website_path)}">${esc(p.name)}</a></h3><ol>${p.steps.map(s => `<li><strong>${esc(s.step_id)}</strong> · ${esc(pretty(s.status))}<p class="form-note">${s.resource_ids.map(id => `<code>${esc(id)}</code>`).join(' · ')}</p></li>`).join('')}</ol>${p.linked_performance_available === true ? `<button class="button small" data-creative-performance="${esc(p.plan_id)}">${esc(uiText('Inspect linked ad performance'))}</button>` : ''}</article>`,
      )
      .join('') || blank(uiText('No verified usage found on this page of retained plans within your access.'))
  );
}
function creativeNativeReferenceExplanation(value) {
  return creativeNativeReferenceMessages.has(value) ? uiText(value) : String(value ?? '');
}
function creativeNativeReferenceRows(result) {
  if (result.platform === 'google_ads') return creativeGoogleImageReferences(result);
  return `<p class="workspace-copy">${esc(creativeNativeReferenceExplanation(result.meaning))}</p><p class="form-note">${esc(uiText('Examined {count} current ads on this page; {unknown} have no qualified scalar reference.', {count: uiNumber(result.examined_ads), unknown: uiNumber(result.unresolved_ads)}))}</p>${result.rows.length ? `<div class="report-table"><table><caption>${esc(uiText('Current native media references'))}</caption><thead><tr><th scope="col">${esc(uiText('Ad and creative'))}</th><th scope="col">${esc(uiText('Observed native hierarchy'))}</th><th scope="col">${esc(uiText('Reference field and value'))}</th><th scope="col">${esc(uiText('Observed status'))}</th></tr></thead><tbody>${result.rows.map(row => `<tr><th scope="row">${esc(row.name)}<small>${esc(uiText('Ad ID: {id}', {id: row.ad_id}))}</small><small>${esc(uiText('Creative ID: {id}', {id: row.creative_id}))}</small></th><td><small>${esc(uiText('Campaign ID: {id}', {id: row.campaign_id}))}</small><small>${esc(uiText('Ad set ID: {id}', {id: row.adset_id}))}</small></td><td><code>${esc(row.match_field)}</code><small><code>${esc(row.media_id)}</code></small></td><td><small>${esc(uiText('Configured:'))} ${esc(row.configured_status ?? uiText('Unknown'))}</small><small>${esc(uiText('Effective:'))} ${esc(row.effective_status ?? uiText('Unknown'))}</small>${row.native_updated_time ? `<small>${esc(uiText('Native updated time: {value}', {value: row.native_updated_time}))}</small>` : ''}</td></tr>`).join('')}</tbody></table></div>` : `<p class="notice">${esc(uiText('No matching scalar references on this page. Unsupported or missing formats remain unknown.'))}</p>`}${recordDetails(result.source_references, uiText('Native read references'))}`;
}
function creativeGoogleImageReferences(result) {
  const title = uiText('Current Google image links');
  return `<p class="workspace-copy">${esc(creativeNativeReferenceExplanation(result.meaning))}</p><p class="form-note">${esc(uiText('Observed {links} links across {ads} ads; {unknown} unresolved links and {removed} removed links. Selected complete-collection limit: {limit}.', {links: uiNumber(result.examined_links), ads: uiNumber(result.examined_ads), unknown: uiNumber(result.unresolved_links), removed: uiNumber(result.removed_links), limit: uiNumber(result.selected_limit)}))}</p>${result.rows.length ? `<div class="report-table-wrap" role="region" tabindex="0" aria-label="${esc(title)}"><table class="report-table"><caption>${esc(title)}</caption><thead><tr><th scope="col">${esc(uiText('Ad and native type'))}</th><th scope="col">${esc(uiText('Observed native hierarchy'))}</th><th scope="col">${esc(uiText('Image asset and link role'))}</th><th scope="col">${esc(uiText('Configured hierarchy status'))}</th></tr></thead><tbody>${result.rows.map(row => `<tr><th scope="row">${esc(row.name)}<small><bdi dir="ltr">${esc(row.ad_id)}</bdi></small><small><bdi dir="ltr">${esc(row.ad_type)}</bdi></small></th><td><small>${esc(uiText('Campaign'))}: <bdi dir="ltr">${esc(row.campaign_id)}</bdi></small><small>${esc(uiText('Ad group'))}: <bdi dir="ltr">${esc(row.ad_group_id)}</bdi></small><small><code dir="ltr">${esc(row.ad_resource_name)}</code></small></td><td><code dir="ltr">${esc(row.media_id)}</code><small><bdi dir="ltr">${esc(row.field_type)}</bdi></small></td><td><small>${esc(uiText('Ad'))}: <bdi dir="ltr">${esc(row.configured_status ?? uiText('Unknown'))}</bdi></small><small>${esc(uiText('Campaign'))}: <bdi dir="ltr">${esc(row.campaign_status ?? uiText('Unknown'))}</bdi></small><small>${esc(uiText('Ad group'))}: <bdi dir="ltr">${esc(row.ad_group_status ?? uiText('Unknown'))}</bdi></small></td></tr>`).join('')}</tbody></table></div>` : `<p class="notice">${esc(uiText('No qualified current image links in the selected Google view. Other formats and unresolved links remain unknown.'))}</p>`}${recordDetails(result.source_references, uiText('Native read references'))}`;
}
function mountCreativeGoogleImageReferences(asset, active, root) {
  const generation = navigationGeneration,
    identity = identityGeneration;
  const current = () =>
    active() && root.isConnected && generation === navigationGeneration && identity === identityGeneration;
  let sequence = 0;
  root.innerHTML = `<h3>${esc(uiText('Current Google image links'))}</h3><p class="form-note">${esc(uiText('Inspect current image links in the original Google upload account. App, Demand Gen and Responsive Search ads are covered by this selected view; Responsive Display, Performance Max, video and historical attribution remain outside it.'))}</p><label for="creative-google-reference-limit">${esc(uiText('Maximum native links to inspect (1–1000)'))}</label><input id="creative-google-reference-limit" type="number" min="1" max="1000" step="1" value="50" dir="ltr"><button id="creative-read-native-references" class="button">${esc(uiText('Read current native references'))}</button><div id="creative-native-reference-pages" aria-live="polite"></div>`;
  workspaceBind('#creative-read-native-references', async () => {
    if (!current()) return;
    const limit = Number($('#creative-google-reference-limit').value),
      request = ++sequence,
      target = $('#creative-native-reference-pages');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      target.innerHTML = `<p class="error" role="alert">${esc(uiText('Choose a complete Google image-reference limit of 1–1000. This read has no native continuation.'))}</p>`;
      return;
    }
    target.setAttribute('aria-busy', 'true');
    target.innerHTML = `<p role="status">${esc(uiText('Loading…'))}</p>`;
    try {
      const result = await workspaceCall('media', {action: 'asset_usage', asset_id: asset.asset_id, limit});
      if (!current() || request !== sequence || !target.isConnected) return;
      if (
        result.platform !== 'google_ads' ||
        result.asset_id !== asset.asset_id ||
        result.complete !== true ||
        result.selected_limit !== limit
      )
        throw new Error(
          uiText('The original image, login or native references changed. Read the original asset again.'),
        );
      target.innerHTML = creativeGoogleImageReferences(result);
    } catch (error) {
      if (!current() || request !== sequence || !target.isConnected) return;
      target.innerHTML = `<p class="error" role="alert">${esc(creativeNativeReferenceExplanation(error?.message ?? errorMessage(error)))}</p>`;
    } finally {
      if (current() && request === sequence && target.isConnected) target.setAttribute('aria-busy', 'false');
    }
  });
}
function mountCreativeNativeReferences(asset, active) {
  const root = $('#creative-native-references');
  if (!active() || !root?.isConnected) return;
  if (asset.native_usage_supported === true && asset.native_usage_kind === 'google_image_links') {
    mountCreativeGoogleImageReferences(asset, active, root);
    return;
  }
  root.innerHTML = `<h3>${esc(uiText('Current native media references'))}</h3><p class="form-note">${esc(uiText('Inspect current Meta image-hash or video-ID references in the original upload account. This can find ads outside AMCP plans; it does not attribute historical performance. Other formats and providers remain unknown.'))}</p>${asset.native_usage_supported === true ? `<button id="creative-read-native-references" class="button">${esc(uiText('Read current native references'))}</button><div id="creative-native-reference-pages"></div>` : `<p class="notice">${esc(uiText('Native reference inspection requires a qualified Meta image/video or original Google image receipt.'))}</p>`}`;
  if (asset.native_usage_supported !== true) return;
  const pager = workPageLoader(
    '#creative-native-reference-pages',
    'Current native media references',
    async cursor => {
      try {
        return await workspaceCall('media', {
          action: 'asset_usage',
          asset_id: asset.asset_id,
          limit: 50,
          ...(cursor ? {cursor} : {}),
        });
      } catch (error) {
        const display = new Error(creativeNativeReferenceExplanation(error?.message ?? errorMessage(error)));
        display.requestId = error?.requestId;
        throw display;
      }
    },
    creativeNativeReferenceRows,
    () => {},
    active,
  );
  workspaceBind('#creative-read-native-references', () => active() && pager.load());
}
function creativePerformanceMetric(r) {
  if (r.preset === 'snapchat_ad_leads') return uiText('Native lead submissions (native_leads)');
  if (r.preset === 'snapchat_ad') return uiText('Purchases (conversion_purchases)');
  return r.semantics.conversion_definition;
}
function creativePerformanceResults(r) {
  const labels = {
      spend: 'Spend',
      impressions: 'Impressions',
      clicks: 'Clicks',
      conversions: r.preset === 'snapchat_ad_leads' ? 'Native lead submissions' : 'Conversions',
      conversion_value: 'Conversion value',
      reach: 'Reach',
      frequency: 'Frequency',
    },
    fields = [
      'spend',
      'impressions',
      'clicks',
      'conversions',
      'conversion_value',
      ...['reach', 'frequency'].filter(key => r.rows.some(row => row[key] !== null && row[key] !== undefined)),
    ];
  return `<p>${esc(r.semantics.currency)} · ${esc(r.semantics.timezone)} · ${esc(r.semantics.attribution)} · ${esc(r.semantics.conversion_definition)} · ${esc(r.semantics.complete ? uiText('Complete window') : uiText('Incomplete window'))}</p><p>${esc(uiText('Reporting grain'))}: <span dir="auto">${esc(r.grain)}</span></p><p class="small">${esc(uiText('Scroll horizontally to see every metric.'))}</p><div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Ad-level performance from the selected snapshot'))}"><table class="review-table creative-performance-table"><caption>${esc(uiText('Ad-level performance from the selected snapshot'))}</caption><thead><tr><th scope="col">${esc(uiText('Ad'))}</th><th scope="col">${esc(uiText('Date'))}</th>${fields.map(key => `<th scope="col">${esc(uiText(labels[key]))}</th>`).join('')}</tr></thead><tbody>${r.rows.map(row => `<tr><th scope="row"><div dir="auto">${esc(row.entity_name || row.entity_id)}</div><code dir="ltr">${esc(row.entity_id)}</code></th><td>${esc(row.date)}</td>${fields.map(key => `<td dir="ltr">${esc(row[key] ?? uiText('Unknown'))}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${fields.length + 2}">${esc(uiText('No matching performance rows. This is not evidence of zero delivery.'))}</td></tr>`}</tbody></table></div><p><a href="${esc(r.report_path)}">${esc(uiText('Inspect original evidence'))}</a></p><ul>${r.limitations.map(value => `<li>${esc(uiText(value))}</li>`).join('')}</ul>`;
}
async function mountCreativePerformance(asset, planId, current) {
  const host = $('#creative-performance'),
    root = document.createElement('section');
  host.replaceChildren(root);
  root.innerHTML = `<h3>${esc(uiText('Performance of linked ads'))}</h3><p>${esc(recordAccountLabel(asset.platform, asset.connection_id, asset.account_id))}</p><p>${esc(uiText('Choose compatible retained ad evidence from this exact provider, account and login. This does not establish which creative served throughout the reporting window.'))}</p><div id="creative-report-choices"></div><form id="creative-performance-form"><label>${esc(uiText('Selected ad evidence'))}<select name="report_id" required><option value="">${esc(uiText('Choose a report below'))}</option></select></label><button class="button" type="submit">${esc(uiText('Show linked ad results'))}</button></form><div id="creative-performance-results" aria-live="polite"></div>`;
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
                `<p>${esc(p.semantics.source_name)} · ${esc(creativePerformanceMetric(p))} · ${esc(p.semantics.date_from)} — ${esc(p.semantics.date_to)} · ${esc(p.semantics.currency)} · ${date(p.captured_at)}</p>`,
            )
            .join('')
        : `<p>${esc(uiText('No matching evidence on this page.'))} <a href="/reports">${esc(uiText('Capture compatible ad evidence'))}</a> ${esc(uiText('for this account and login.'))}</p>`,
    r => {
      if (!current() || !root.isConnected) return;
      root.querySelector('select[name="report_id"]').innerHTML =
        `<option value="">${esc(uiText('Choose explicitly'))}</option>` +
        r.reports
          .map(
            p =>
              `<option value="${esc(p.id)}">${esc(p.semantics.source_name)} · ${esc(creativePerformanceMetric(p))} · ${esc(p.semantics.date_from)} — ${esc(p.semantics.date_to)}</option>`,
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
      creativePerformanceResults,
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
      detail.innerHTML = `<section class="panel workspace-form creative-asset"><div class="panel-header"><h2>${esc(a.name)}</h2><a href="${esc(a.website_path)}">${esc(uiText('Link to this asset'))}</a></div><p>${esc(recordAccountLabel(a.platform, a.connection_id, a.account_id))}</p><div class="workspace-columns"><div><h3>${esc(uiText('File and receipt'))}</h3><dl class="creative-facts"><dt>${esc(uiText('Provider name'))}</dt><dd>${esc(a.provider_name)}</dd><dt>${esc(uiText('Provider ID'))}</dt><dd><code>${esc(a.media_id)}</code></dd><dt>${esc(uiText('Uploaded bytes SHA-256'))}</dt><dd><code>${esc(a.uploaded_sha256)}</code></dd><dt>${esc(uiText('Original file'))}</dt><dd>${a.source.available ? (a.source.retained === true ? uiText('Kept until an owner removes it.') : uiText('Available until ') + date(a.source.expires_at)) : uiText('Unavailable or expired. Import the original file again to create new variants.')}</dd>${a.dimensions_uploaded ? `<dt>${esc(uiText('Uploaded dimensions'))}</dt><dd>${esc(a.dimensions_uploaded.width)} × ${esc(a.dimensions_uploaded.height)}</dd>` : ''}</dl><div class="dialog-actions work-actions"><button id="creative-status" class="button" ${readOnly ? 'disabled' : ''}>${esc(uiText('Check provider status'))}</button><button id="creative-reuse" class="button" ${readOnly ? 'disabled' : ''}>${esc(uiText('Check availability for reuse'))}</button></div><div id="creative-reuse-result" role="status"></div></div><form id="creative-metadata"><h3>${esc(uiText('Library metadata'))}</h3><p class="form-note">${esc(uiText('These labels organize your workspace. They do not rename media at the provider.'))}</p><label>${esc(uiText('Library name'))}<input name="name" maxlength="160" required value="${esc(a.name)}" ${readOnly ? 'disabled' : ''}></label><label>${esc(uiText('Tags, separated by commas'))}<input name="tags" value="${esc(a.tags.join(', '))}" ${readOnly ? 'disabled' : ''}></label><label class="form-note"><input type="checkbox" name="confirmed" required ${readOnly ? 'disabled' : ''}> ${esc(uiText('Save these workspace labels'))}</label><button type="submit" class="button primary" ${readOnly ? 'disabled' : ''}>${esc(uiText('Save metadata'))}</button></form></div><h3>${esc(uiText('Verified campaign usage'))}</h3><p class="form-note">${esc(uiText('Only verified steps linked through actual result references are included here. Current native references are inspected separately and do not establish historical performance attribution.'))}</p><div id="creative-usage"></div></section>`;
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
      detail
        .querySelector('.creative-asset')
        .insertAdjacentHTML(
          'beforeend',
          `<div id="creative-performance"></div><section id="creative-native-references"></section>`,
        );
      mountCreativeNativeReferences(a, () => current(request));
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
