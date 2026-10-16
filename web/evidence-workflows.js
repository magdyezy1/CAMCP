'use strict';
function mountSearchExclusions(report, selectionCurrent) {
  if (report.preset !== 'google_search_terms') return;
  const root = $('#search-exclusion-workflow'),
    generation = navigationGeneration,
    identity = identityGeneration,
    current = () =>
      root.isConnected && generation === navigationGeneration && identity === identityGeneration && selectionCurrent();
  if (!current()) return;
  root.innerHTML = `<section class="panel workspace-form"><h2>${esc(uiText('Possible exact keyword exclusions'))}</h2><p>${esc(uiText('Select reported search terms to inspect as exact negative keywords in their original ad groups. Review relevance and conversion lag before creating a draft.'))}</p><form id="search-exclusion-find"><div class="workspace-columns"><label>${esc(uiText('Minimum clicks'))}<input id="search-exclusion-clicks" type="number" min="1" max="1000000" step="1" value="30" required></label><label>${esc(uiText('Maximum evidence age (days)'))}<input id="search-exclusion-age" type="number" min="1" max="90" step="1" value="7" required></label></div><p class="form-note">${esc(uiText('Uses recent complete Google search-term evidence with known zero conversions. Missing metrics and terms outside the supported literal format are excluded from this list.'))}</p><button type="submit" class="button">${esc(uiText('Read possible exclusions'))}</button></form><div id="search-exclusion-rows"></div><p id="search-exclusion-selected" role="status"></p><button id="search-exclusion-preview" type="button" class="button" disabled>${esc(uiText('Preview selected exclusions'))}</button><div id="search-exclusion-result"></div></section>`;
  const form = $('#search-exclusion-find'),
    table = $('#search-exclusion-rows'),
    result = $('#search-exclusion-result'),
    clicks = $('#search-exclusion-clicks'),
    age = $('#search-exclusion-age'),
    previewButton = $('#search-exclusion-preview'),
    selected = new Map();
  let revision = 0,
    pageAttempt = 0,
    previewAttempt = 0,
    saveAttempt = 0,
    offset = 0,
    metadata = null,
    savedPreview = null,
    previewBusy = false,
    saveBusy = false;
  const options = () => ({minimum_clicks: Number(clicks.value), maximum_age_days: Number(age.value)});
  const status = () => {
    $('#search-exclusion-selected').textContent = uiText('{count} of 20 terms selected', {
      count: uiNumber(selected.size),
    });
    previewButton.disabled = !selected.size || previewBusy || saveBusy;
  };
  const invalidate = (clear = false) => {
    revision++;
    pageAttempt++;
    previewAttempt++;
    saveAttempt++;
    savedPreview = null;
    previewBusy = false;
    saveBusy = false;
    result.innerHTML = '';
    if (clear) {
      selected.clear();
      metadata = null;
      table.innerHTML = '';
      offset = 0;
    }
    status();
  };
  const notice = (message, error) =>
    `<p class="notice" role="alert">${esc(message)}</p>${error?.message ? recordDetails({message: error.message}, uiText('Original diagnostic')) : ''}`;
  const responseScope = out =>
    out &&
    out.report_id === report.id &&
    out.source_hash === report.source_hash &&
    out.gateway === report.gateway &&
    out.account_id === report.account_id &&
    out.connection_id === report.connection_id &&
    out.currency === report.semantics.currency &&
    Number.isSafeInteger(out.report_revision) &&
    (report.revision === undefined || out.report_revision === report.revision);
  const validRow = r =>
    r &&
    typeof r.entity_id === 'string' &&
    r.entity_id.length <= 1000 &&
    typeof r.search_term === 'string' &&
    r.search_term.length <= 80 &&
    /^[1-9][0-9]{0,19}$/.test(r.campaign_id) &&
    /^[1-9][0-9]{0,19}$/.test(r.ad_group_id) &&
    r.ad_group_resource === 'customers/' + report.account_id + '/adGroups/' + r.ad_group_id &&
    r.match_type === 'EXACT' &&
    typeof r.observed_clicks === 'string' &&
    /^\d+$/.test(r.observed_clicks) &&
    typeof r.observed_spend === 'string' &&
    /^\d+(?:\.\d{1,9})?$/.test(r.observed_spend) &&
    r.observed_conversions === '0';
  const sameRow = (a, b) =>
    [
      'entity_id',
      'campaign_id',
      'ad_group_id',
      'ad_group_resource',
      'search_term',
      'observed_clicks',
      'observed_spend',
      'observed_conversions',
      'match_type',
    ].every(k => a?.[k] === b?.[k]);
  const load = async (requested, fresh = false) => {
    if (!current()) return;
    if (fresh) invalidate(true);
    else invalidate();
    const seq = ++pageAttempt,
      version = revision,
      requestedOptions = options(),
      active = () =>
        current() &&
        seq === pageAttempt &&
        version === revision &&
        JSON.stringify(options()) === JSON.stringify(requestedOptions);
    table.innerHTML = `<p role="status">${esc(uiText('Reading possible exclusions…'))}</p>`;
    try {
      const out = await workspaceCall('reporting', {
        action: 'search_exclusion_candidates',
        id: report.id,
        options: requestedOptions,
        offset: requested,
        limit: 50,
      });
      if (!active()) return;
      if (
        !responseScope(out) ||
        out.record_kind !== 'search_exclusion_candidates' ||
        !Number.isSafeInteger(out.candidate_count) ||
        out.candidate_count < 0 ||
        out.candidate_count > 10000 ||
        !Array.isArray(out.candidates) ||
        out.candidates.length !== Math.max(0, Math.min(50, out.candidate_count - requested)) ||
        out.candidates.some(r => !validRow(r)) ||
        new Set(out.candidates.map(r => r.entity_id)).size !== out.candidates.length ||
        JSON.stringify(out.options) !== JSON.stringify(requestedOptions) ||
        out.next_offset !== (requested + 50 < out.candidate_count ? requested + 50 : null) ||
        (metadata &&
          (metadata.report_revision !== out.report_revision || metadata.candidate_count !== out.candidate_count))
      )
        throw Error(uiText('Exclusion evidence changed or is incomplete. Reopen the report and refresh.'));
      metadata = out;
      offset = requested;
      table.innerHTML =
        (out.candidates.length
          ? `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Search terms and proposed exclusion scope'))}"><table class="review-table"><caption>${esc(uiText('Choose terms for individual review'))}</caption><thead><tr><th scope="col">${esc(uiText('Select'))}</th><th scope="col">${esc(uiText('Search term'))}</th><th scope="col">${esc(uiText('Campaign / ad group'))}</th><th scope="col">${esc(uiText('Reported clicks'))}</th><th scope="col">${esc(uiText('Reported spend'))} · ${esc(out.currency)}</th></tr></thead><tbody>${out.candidates.map((r, i) => `<tr><td><input type="checkbox" id="search-exclusion-choose-${i}" aria-label="${esc(uiText('Select term {term}', {term: r.search_term}))}"></td><th scope="row" dir="auto">${esc(r.search_term)}</th><td dir="ltr">${esc(r.campaign_id)} / ${esc(r.ad_group_id)}</td><td dir="ltr">${esc(r.observed_clicks)}</td><td dir="ltr">${esc(r.observed_spend)}</td></tr>`).join('')}</tbody></table></div>`
          : `<p>${esc(uiText('No retained search terms meet these exclusion criteria.'))}</p>`) +
        `<div class="report-pagination"><p id="search-exclusion-page-status" role="status" tabindex="-1">${esc(uiText('Terms {from}–{to} of {total}', {from: uiNumber(out.candidates.length ? offset + 1 : 0), to: uiNumber(offset + out.candidates.length), total: uiNumber(out.candidate_count)}))}</p><div><button type="button" class="button small" id="search-exclusion-previous">${esc(uiText('Previous page'))}</button><button type="button" class="button small" id="search-exclusion-next">${esc(uiText('Next page'))}</button></div></div>`;
      out.candidates.forEach((r, i) => {
        const checkbox = $('#search-exclusion-choose-' + i);
        checkbox.checked = selected.has(r.entity_id);
        checkbox.addEventListener('change', () => {
          if (!current() || !checkbox.isConnected || metadata !== out) return;
          if (checkbox.checked && !selected.has(r.entity_id) && selected.size >= 20) {
            checkbox.checked = false;
            result.innerHTML = notice(uiText('Select at most 20 terms for one draft.'));
            return;
          }
          invalidate();
          if (checkbox.checked) selected.set(r.entity_id, r);
          else selected.delete(r.entity_id);
          status();
        });
      });
      $('#search-exclusion-previous').disabled = offset === 0;
      $('#search-exclusion-next').disabled = out.next_offset === null;
      workspaceBind('#search-exclusion-previous', () =>
        current() && metadata === out && offset >= 50 ? load(offset - 50) : undefined,
      );
      workspaceBind('#search-exclusion-next', () =>
        current() && metadata === out && out.next_offset !== null ? load(out.next_offset) : undefined,
      );
      $('#search-exclusion-page-status').focus();
      status();
    } catch (error) {
      if (active()) {
        selected.clear();
        metadata = null;
        table.innerHTML = notice(
          uiText('Possible exclusions could not be read. Refresh the report or revise the evidence limits.'),
          error,
        );
        status();
      }
    }
  };
  for (const event of ['input', 'change'])
    form.addEventListener(event, () => {
      if (current()) invalidate(true);
    });
  workspaceBind('#search-exclusion-find', () => load(0, true));
  workspaceBind('#search-exclusion-preview', async () => {
    if (!current() || !selected.size || !metadata || previewBusy || saveBusy) return;
    const version = revision,
      seq = ++previewAttempt,
      chosen = [...selected.values()],
      chosenOptions = options(),
      active = () =>
        current() &&
        version === revision &&
        seq === previewAttempt &&
        JSON.stringify(options()) === JSON.stringify(chosenOptions);
    previewBusy = true;
    savedPreview = null;
    result.innerHTML = '';
    status();
    try {
      const out = await workspaceCall('reporting', {
        action: 'preview_search_exclusions',
        id: report.id,
        ids: chosen.map(r => r.entity_id),
        options: chosenOptions,
      });
      if (!active()) return;
      if (
        !responseScope(out) ||
        out.record_kind !== 'search_exclusion_preview' ||
        out.report_revision !== metadata.report_revision ||
        out.advertising_writes !== 0 ||
        typeof out.preview_id !== 'string' ||
        !out.preview_id ||
        typeof out.preview_hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(out.preview_hash) ||
        !Number.isSafeInteger(out.expires_at) ||
        out.expires_at <= Date.now() ||
        !Array.isArray(out.targets) ||
        out.targets.length !== chosen.length ||
        out.targets.some((r, i) => !validRow(r) || !sameRow(r, chosen[i])) ||
        JSON.stringify(out.options) !== JSON.stringify(chosenOptions)
      )
        throw Error(uiText('Exclusion evidence changed or is incomplete. Reopen the report and refresh.'));
      savedPreview = out;
      result.innerHTML = `<h3 id="search-exclusion-preview-heading" tabindex="-1">${esc(uiText('Review the exclusion draft'))}</h3><p class="notice">${esc(uiText('These exact negative keywords may reduce traffic. Review business relevance and conversion lag. This saves an unapproved draft; each change still requires native review, spending acknowledgement and read-back.'))}</p><p>${esc(uiText('Current exact ad-group keywords were checked. Broader, campaign and shared exclusions remain unassessed.'))}</p><div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Proposed exact keyword exclusions'))}"><table class="review-table"><caption>${esc(uiText('Proposed exact keyword exclusions'))}</caption><thead><tr><th scope="col">${esc(uiText('Search term'))}</th><th scope="col">${esc(uiText('Ad group'))}</th><th scope="col">${esc(uiText('Match type'))}</th></tr></thead><tbody>${out.targets.map(r => `<tr><th scope="row" dir="auto">${esc(r.search_term)}</th><td dir="ltr">${esc(r.ad_group_id)}</td><td><code dir="ltr">EXACT</code></td></tr>`).join('')}</tbody></table></div><p>${esc(uiText('Preview expires:'))} ${esc(date(out.expires_at))}</p><button type="button" class="button primary" id="search-exclusion-save">${esc(uiText('Save exclusion draft'))}</button><div id="search-exclusion-save-status"></div>${recordDetails(out, uiText('Exclusion source and current account evidence'))}`;
      workspaceBind('#search-exclusion-save', async () => {
        if (!active() || savedPreview !== out || saveBusy) return;
        if (out.expires_at <= Date.now()) {
          savedPreview = null;
          result.innerHTML = notice(uiText('This preview expired. Preview the selected terms again.'));
          return;
        }
        const saving = ++saveAttempt,
          stillCurrent = () => active() && savedPreview === out && saving === saveAttempt;
        saveBusy = true;
        status();
        $('#search-exclusion-save').disabled = true;
        try {
          const approved = await confirmAction({
            title: uiText('Save exclusion draft'),
            consequence: uiText(
              'Save these exact terms and original ad groups as an unapproved plan after reviewing relevance and conversion lag. Advertising changes require separate native approval.',
            ),
            confirmLabel: uiText('Save draft'),
          });
          if (!approved || !stillCurrent()) return;
          const saved = await workspaceCall('reporting', {
            action: 'create_search_exclusion_plan',
            id: report.id,
            preview_id: out.preview_id,
            preview_hash: out.preview_hash,
            confirmed: true,
          });
          if (!stillCurrent()) return;
          if (
            saved?.record_kind !== 'search_exclusion_plan' ||
            typeof saved.id !== 'string' ||
            !saved.id ||
            saved.advertising_writes !== 0 ||
            saved.approval_required !== true
          )
            throw Error(uiText('The draft response is incomplete. Inspect Campaigns before trying again.'));
          result.innerHTML = `<p class="notice" id="search-exclusion-saved" role="status" tabindex="-1">${esc(uiText('Exclusion draft saved. Review its native steps in Campaigns.'))}</p><a class="button" href="/campaigns?id=${encodeURIComponent(saved.id)}">${esc(uiText('Open exclusion draft'))}</a>`;
          savedPreview = null;
          saveBusy = false;
          status();
          $('#search-exclusion-saved').focus();
        } catch (error) {
          if (stillCurrent())
            $('#search-exclusion-save-status').innerHTML = notice(
              uiText('The draft save was not confirmed. Retry this same preview or inspect Campaigns.'),
              error,
            );
        } finally {
          if (stillCurrent()) {
            saveBusy = false;
            status();
            const button = $('#search-exclusion-save');
            if (button) button.disabled = false;
          }
        }
      });
      $('#search-exclusion-preview-heading').focus();
    } catch (error) {
      if (active()) {
        savedPreview = null;
        result.innerHTML = notice(
          uiText('The exclusion preview could not be completed. Refresh the evidence or revise your selection.'),
          error,
        );
      }
    } finally {
      if (active()) {
        previewBusy = false;
        status();
      }
    }
  });
  status();
}
function mountEvidenceDownload(report, selectionCurrent) {
  const root = $('#report-evidence-download'),
    generation = navigationGeneration,
    identity = identityGeneration,
    current = () =>
      generation === navigationGeneration && identity === identityGeneration && root.isConnected && selectionCurrent();
  if (!current()) return;
  // Report files are for operators unless the owner allows viewer downloads (SEC-05); the server refuses them too.
  if (typeof session !== 'undefined' && session?.downloadsAllowed === false) {
    root.innerHTML = `<p class="form-note">${esc(uiText('Report file downloads are limited to operators in this workspace. Ask an operator, or ask the workspace owner to allow viewer downloads.'))}</p>`;
    return;
  }
  root.innerHTML = `<div class="report-pagination"><label>${esc(uiText('Excel language'))}<select id="evidence-download-language"><option value="en">${esc(uiText('English'))}</option><option value="ar">${esc(uiText('Arabic'))}</option></select></label><button type="button" class="button small" id="evidence-download-xlsx">${esc(uiText('Download all rows as Excel'))}</button></div><p class="form-note">${esc(uiText('Includes all retained rows, totals, field mappings and source references. Numeric values remain text to preserve precision.'))}</p><p id="evidence-download-status" role="status"></p>`;
  const language = $('#evidence-download-language'),
    button = $('#evidence-download-xlsx'),
    status = $('#evidence-download-status');
  language.value = 'en';
  let busy = false;
  button.addEventListener('click', async () => {
    if (!current() || busy) return;
    if (!['en', 'ar'].includes(language.value) || typeof report.id !== 'string' || !report.id) {
      status.textContent = uiText('Choose English or Arabic for the workbook.');
      return;
    }
    busy = true;
    button.disabled = true;
    language.disabled = true;
    root.setAttribute('aria-busy', 'true');
    status.textContent = uiText('Preparing all retained rows…');
    try {
      const response = await fetch(
        '/api/reporting-evidence/' + encodeURIComponent(report.id) + '.xlsx?language=' + language.value,
        {cache: 'no-store'},
      );
      if (!current()) return;
      if (
        !response.ok ||
        response.headers.get('content-type')?.split(';')[0].trim() !==
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
        throw Error('Invalid workbook response');
      const blob = await response.blob();
      if (!current()) return;
      if (!Number.isSafeInteger(blob.size) || blob.size <= 0 || blob.size > 20 * 1024 * 1024)
        throw Error('Invalid workbook size');
      const url = URL.createObjectURL(blob),
        link = document.createElement('a');
      try {
        link.href = url;
        link.download = 'AMCP-detailed-evidence.xlsx';
        link.click();
        status.textContent = uiText('Detailed evidence prepared for download.');
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch {
      if (current())
        status.textContent = uiText('The evidence workbook could not be downloaded. Retry or reopen the report.');
    } finally {
      busy = false;
      if (current()) {
        button.disabled = false;
        language.disabled = false;
        root.setAttribute('aria-busy', 'false');
      }
    }
  });
}
function mountEvidenceRows(report, selectionCurrent) {
  if (report.preset === 'google_search_terms') mountSearchExclusions(report, selectionCurrent);
  const root = $('#report-native-rows'),
    generation = navigationGeneration,
    identity = identityGeneration,
    current = () =>
      generation === navigationGeneration && identity === identityGeneration && root.isConnected && selectionCurrent(),
    total = report.row_count;
  const labels = {
    entity_id: uiText('Entity ID'),
    entity_name: uiText('Entity name'),
    date: uiText('Date'),
    search_term: uiText('Search term'),
    keyword_match_type: uiText('Native keyword match type'),
    native_device: uiText('Native device'),
    native_hour: uiText('Native hour'),
    native_country_criterion_id: uiText('Native country criterion ID'),
    native_location_type: uiText('Native location type'),
    native_geographic_resource: uiText('Native geographic resource'),
    // RPT-07 dimension packs: literal native breakdown values.
    native_ad_network: uiText('Native ad network'),
    native_age: uiText('Native age'),
    native_gender: uiText('Native gender'),
    native_country: uiText('Native country'),
    native_publisher_platform: uiText('Native publisher platform'),
    native_platform_position: uiText('Native placement'),
    spend: uiText('Spend'),
    impressions: uiText('Impressions'),
    clicks: uiText('Clicks'),
    conversions: uiText('Conversions'),
    conversion_value: uiText('Conversion value'),
    reach: uiText('Reach'),
    frequency: uiText('Frequency'),
  };
  const breakdowns = [
    'native_ad_network',
    'native_age',
    'native_gender',
    'native_country',
    'native_publisher_platform',
    'native_platform_position',
  ].filter(key => Object.hasOwn(report.mapping ?? {}, key));
  const order =
    report.preset === 'google_keyword'
      ? [
          'entity_name',
          'keyword_match_type',
          'date',
          'entity_id',
          ...Object.keys(labels).filter(
            key => !['entity_name', 'keyword_match_type', 'date', 'entity_id'].includes(key),
          ),
        ]
      : report.preset === 'google_campaign_device'
        ? [
            'entity_name',
            'native_device',
            'date',
            'entity_id',
            ...Object.keys(labels).filter(key => !['entity_name', 'native_device', 'date', 'entity_id'].includes(key)),
          ]
        : report.preset === 'google_campaign_hour'
          ? [
              'entity_name',
              'native_hour',
              'date',
              'entity_id',
              ...Object.keys(labels).filter(key => !['entity_name', 'native_hour', 'date', 'entity_id'].includes(key)),
            ]
          : report.preset === 'google_campaign_country'
            ? [
                'entity_name',
                'native_country_criterion_id',
                'native_location_type',
                'date',
                'entity_id',
                ...Object.keys(labels).filter(
                  key =>
                    ![
                      'entity_name',
                      'native_country_criterion_id',
                      'native_location_type',
                      'date',
                      'entity_id',
                    ].includes(key),
                ),
              ]
            : breakdowns.length
              ? [
                  'entity_name',
                  ...breakdowns,
                  'date',
                  'entity_id',
                  ...Object.keys(labels).filter(
                    key => !['entity_name', ...breakdowns, 'date', 'entity_id'].includes(key),
                  ),
                ]
              : Object.keys(labels);
  const columns = order.filter(
    key =>
      ['entity_id', 'entity_name'].includes(key) ||
      Object.hasOwn(report.mapping ?? {}, key) ||
      (key === 'date' && report.source === 'overview_snapshot'),
  );
  // RPT-05: long native resource identities are hidden by default behind a per-viewer "Show native IDs" toggle.
  const mappedPath = key => {
      const mapped = report.mapping?.[key];
      return typeof mapped === 'string' ? mapped : String(mapped?.path ?? '');
    },
    nativeIdColumns = columns.filter(
      key =>
        key === 'native_geographic_resource' ||
        (key === 'entity_id' && columns.includes('entity_name') && /resourceName$/.test(mappedPath('entity_id'))),
    ),
    nativeIdsPreference = 'amcp.evidence.native_ids';
  let showNativeIds = false;
  try {
    showNativeIds = localStorage.getItem(nativeIdsPreference) === 'shown';
  } catch {
    showNativeIds = false;
  }
  const visible = new Set(columns.filter(key => showNativeIds || !nativeIdColumns.includes(key)));
  let limit = 50,
    offset = 0,
    busy = false,
    columnsOpen = false,
    query = report.row_query ?? '',
    draft = query,
    matched = report.matched_row_count ?? total,
    lastPage = report;
  const pages = () => Math.max(1, Math.ceil(matched / limit));
  const matches = page => page.matched_row_count ?? (query ? undefined : total);
  const valid = (page, start, fresh) =>
    page &&
    typeof page === 'object' &&
    ['id', 'gateway', 'account_id', 'connection_id', 'source_hash'].every(key => page[key] === report[key]) &&
    /^[a-f0-9]{64}$/.test(report.source_hash ?? '') &&
    Number.isSafeInteger(total) &&
    total >= 0 &&
    total <= 10000 &&
    page.row_count === total &&
    (page.row_query ?? '') === query &&
    Number.isSafeInteger(matches(page)) &&
    matches(page) >= 0 &&
    matches(page) <= total &&
    (query !== '' || matches(page) === total) &&
    (fresh || matches(page) === matched) &&
    Array.isArray(page.rows) &&
    page.rows.length === Math.min(limit, Math.max(0, matches(page) - start)) &&
    page.has_more === start + limit < matches(page) &&
    page.rows.every(
      row =>
        row &&
        typeof row === 'object' &&
        !Array.isArray(row) &&
        columns.every(
          key =>
            row[key] == null ||
            typeof row[key] === 'string' ||
            (typeof row[key] === 'number' && Number.isFinite(row[key])),
        ),
    );
  // RPT-05: metrics use one precision-preserving format with the exact value on hover; long native identities are
  // middle-truncated with a copy button; location types read as plain labels with the native enum on hover.
  const metricDigits = {impressions: 0, clicks: 0, reach: 0, conversions: 2, frequency: 2},
    locationTypes = {
      LOCATION_OF_PRESENCE: uiText('Physical presence'),
      AREA_OF_INTEREST: uiText('Area of interest'),
    },
    shortId = value => (value.length > 28 ? value.slice(0, 12) + '…' + value.slice(-12) : value);
  const content = (key, value) => {
    const text = String(value);
    if (['spend', 'conversion_value'].includes(key))
      return uiDecimalMarkup(text, {minorUnitsOf: report.semantics?.currency});
    if (Object.hasOwn(metricDigits, key)) return uiDecimalMarkup(text, {maximumFractionDigits: metricDigits[key]});
    if (key === 'native_location_type' && Object.hasOwn(locationTypes, text))
      return `<abbr title="${esc(text)}">${esc(locationTypes[text])}</abbr>`;
    if (['entity_id', 'native_geographic_resource'].includes(key) && shortId(text) !== text)
      return `<code title="${esc(text)}">${esc(shortId(text))}</code> <button type="button" class="button small evidence-copy" data-copy-native="${esc(text)}" aria-label="${esc(uiText('Copy native ID {id}', {id: text}))}">${esc(uiText('Copy'))}</button>`;
    return esc(text);
  };
  const cell = (row, key, identityKey) => {
    const tag = key === identityKey ? 'th' : 'td',
      scope = key === identityKey ? ' scope="row"' : '';
    return row[key] == null
      ? `<${tag}${scope}>${esc(uiText('Unknown'))}</${tag}>`
      : `<${tag}${scope} dir="${['entity_name', 'search_term'].includes(key) ? 'auto' : 'ltr'}">${content(key, row[key])}</${tag}>`;
  };
  const heading = () => `<h3>${esc(uiText('Retained native rows'))}</h3>`;
  const controls = () =>
    `<form id="evidence-row-search" class="report-pagination"><label>${esc(uiText(Object.hasOwn(report.mapping ?? {}, 'keyword_match_type') ? 'Find a keyword, date or native match type' : Object.hasOwn(report.mapping ?? {}, 'native_device') ? 'Find a campaign, date or native device' : Object.hasOwn(report.mapping ?? {}, 'native_hour') ? 'Find a campaign, date or native hour' : Object.hasOwn(report.mapping ?? {}, 'native_country_criterion_id') ? 'Find a campaign, country ID, location type or date' : breakdowns.length ? 'Find a campaign, date or native breakdown value' : 'Find an entity, date or search term'))}<input id="evidence-row-query" type="search" maxlength="150" value="${esc(draft)}"></label><label>${esc(uiText('Rows per page'))}<select id="evidence-rows-page-size">${[10, 25, 50, 100].map(size => `<option value="${size}">${esc(uiNumber(size))}</option>`).join('')}</select></label><div><button type="submit" class="button small" id="evidence-row-apply">${esc(uiText('Search retained rows'))}</button><button type="button" class="button small" id="evidence-row-clear">${esc(uiText('Clear search'))}</button></div></form><p class="form-note">${esc(uiText('Search changes displayed rows only. Totals, analysis and Excel retain the complete report.'))}</p><details id="evidence-columns"${columnsOpen ? ' open' : ''}><summary>${esc(uiText('Visible columns'))}</summary><div class="recipe-fields">${columns.map(key => `<label><input type="checkbox" id="evidence-column-${key}" ${visible.has(key) ? 'checked' : ''}> ${esc(labels[key])}</label>`).join('')}</div><button type="button" class="button small" id="evidence-columns-reset">${esc(uiText('Show all columns'))}</button></details>${nativeIdColumns.length ? `<label class="check"><input type="checkbox" id="evidence-native-ids" ${showNativeIds ? 'checked' : ''}> ${esc(uiText('Show native IDs'))}</label>` : ''}`;
  const bind = () => {
    const field = $('#evidence-row-query'),
      columnDetails = $('#evidence-columns'),
      size = $('#evidence-rows-page-size');
    size.value = String(limit);
    size.disabled = busy;
    size.addEventListener('change', () => {
      if (!current()) return;
      if (busy || !['10', '25', '50', '100'].includes(size.value) || Number(size.value) === limit) {
        size.value = String(limit);
        return;
      }
      limit = Number(size.value);
      return load(0);
    });
    columnDetails.open = columnsOpen;
    columnDetails.addEventListener('toggle', () => {
      if (current() && columnDetails.isConnected) columnsOpen = columnDetails.open;
    });
    field.value = draft;
    field.addEventListener('input', () => {
      if (!current()) return;
      draft = field.value;
      $('#evidence-row-clear').disabled = busy || (!query && !draft);
    });
    $('#evidence-row-apply').disabled = false;
    $('#evidence-row-search').addEventListener('submit', event => {
      event.preventDefault();
      if (!current() || busy) return;
      if (draft.length > 150 || /[\x00-\x1f\x7f]/.test(draft)) return;
      query = draft.trim();
      return load(0, true);
    });
    $('#evidence-row-clear').disabled = !query && !draft;
    $('#evidence-row-clear').addEventListener('click', () => {
      if (!current() || busy) return;
      draft = '';
      if (!query && lastPage) {
        field.value = '';
        $('#evidence-row-clear').disabled = true;
        field.focus();
        return;
      }
      query = '';
      return load(0, true);
    });
    for (const key of columns) {
      const control = $('#evidence-column-' + key);
      control.checked = visible.has(key);
      control.disabled = !lastPage;
      control.addEventListener('change', () => {
        if (!current() || busy || !lastPage) return;
        columnsOpen = columnDetails.open;
        if (control.checked) visible.add(key);
        else if (visible.size > 1) visible.delete(key);
        else control.checked = true;
        if (lastPage) {
          render(lastPage);
          $('#evidence-column-' + key).focus();
        }
      });
    }
    const nativeIds = $('#evidence-native-ids');
    if (nativeIds) {
      nativeIds.checked = showNativeIds;
      nativeIds.disabled = !lastPage;
      nativeIds.addEventListener('change', () => {
        if (!current() || busy || !lastPage) return;
        showNativeIds = nativeIds.checked;
        try {
          localStorage.setItem(nativeIdsPreference, showNativeIds ? 'shown' : 'hidden');
        } catch {
          // A blocked browser store keeps the choice for this page only.
        }
        for (const key of nativeIdColumns)
          if (showNativeIds) visible.add(key);
          else if (visible.size > 1) visible.delete(key);
        render(lastPage);
        $('#evidence-native-ids')?.focus();
      });
    }
    for (const button of root.querySelectorAll?.('[data-copy-native]') ?? [])
      button.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(button.dataset.copyNative);
          toast(uiText('Native ID copied.'));
        } catch {
          toast(uiText('Copy is unavailable in this browser. Select the ID from its tooltip instead.'));
        }
      });
    $('#evidence-columns-reset').disabled = !lastPage;
    $('#evidence-columns-reset').addEventListener('click', () => {
      if (!current() || busy || !lastPage) return;
      columnsOpen = columnDetails.open;
      columns.forEach(key => visible.add(key));
      if (lastPage) {
        render(lastPage);
        $('#evidence-columns-reset').focus();
      }
    });
  };
  const failure = (start, changed = false, fresh = false) => {
    if (!current()) return;
    busy = false;
    lastPage = null;
    root.setAttribute('aria-busy', 'false');
    root.innerHTML =
      heading() +
      controls() +
      `<p class="notice error" role="alert">${esc(changed ? uiText('This evidence changed. Reopen the report before browsing more rows.') : uiText('The saved rows could not be read. Retry or reopen the report.'))}</p><button type="button" class="button small" id="evidence-rows-retry">${esc(uiText('Retry row read'))}</button>`;
    bind();
    $('#evidence-rows-retry').disabled = false;
    $('#evidence-rows-retry').addEventListener('click', () => load(start, fresh));
    $('#evidence-rows-retry').focus();
  };
  function render(page, focus = false) {
    if (!current()) return;
    root.setAttribute('aria-busy', 'false');
    lastPage = page;
    const shown = columns.filter(key => visible.has(key)),
      identityKey = shown.find(key => ['entity_id', 'entity_name'].includes(key));
    const range = matched
      ? uiText('Rows {from}–{through} of {total}', {
          from: uiNumber(offset + 1),
          through: uiNumber(offset + page.rows.length),
          total: uiNumber(matched),
        })
      : query
        ? uiText('No rows match this search')
        : uiText('No mapped native rows');
    root.innerHTML =
      heading() +
      controls() +
      (query
        ? `<p>${esc(uiText('Matching {matched} of {total} retained rows', {matched: uiNumber(matched), total: uiNumber(total)}))}: <code dir="auto">${esc(query)}</code></p>`
        : '') +
      `<p class="form-note">${esc(uiText('Values retain native IDs and decimal strings. Missing metrics remain unknown.'))}</p>` +
      (matched
        ? `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Native evidence rows, scroll for all fields'))}"><table class="review-table evidence-rows-table"><caption>${esc(uiText('Mapped native evidence'))}</caption><thead><tr>${shown.map(key => `<th scope="col">${esc(labels[key])}${['spend', 'conversion_value'].includes(key) ? ' · <span dir="ltr">' + esc(report.semantics.currency) + '</span>' : ''}</th>`).join('')}</tr></thead><tbody>${page.rows.map(row => `<tr>${shown.map(key => cell(row, key, identityKey)).join('')}</tr>`).join('')}</tbody></table></div>`
        : '') +
      `<div class="report-pagination"><p id="evidence-rows-status" role="status" tabindex="-1">${esc(range)}</p><div><button type="button" class="button small" id="evidence-rows-previous">${esc(uiText('Previous page'))}</button><label>${esc(uiText('Page'))}<select id="evidence-rows-page">${Array.from({length: pages()}, (_, i) => `<option value="${i + 1}">${esc(uiNumber(i + 1))}</option>`).join('')}</select></label><button type="button" class="button small" id="evidence-rows-next">${esc(uiText('Next page'))}</button></div></div>`;
    bind();
    $('#evidence-rows-previous').disabled = offset === 0;
    $('#evidence-rows-next').disabled = offset + limit >= matched;
    const select = $('#evidence-rows-page');
    select.value = String(offset / limit + 1);
    select.disabled = pages() === 1;
    $('#evidence-rows-previous').addEventListener('click', () => load(offset - limit));
    $('#evidence-rows-next').addEventListener('click', () => load(offset + limit));
    select.addEventListener('change', () => {
      if (!/^[1-9][0-9]*$/.test(select.value) || Number(select.value) > pages()) return;
      return load((Number(select.value) - 1) * limit);
    });
    if (focus) $('#evidence-rows-status').focus();
  }
  async function load(start, fresh = false) {
    if (
      !current() ||
      busy ||
      !Number.isSafeInteger(start) ||
      start < 0 ||
      start % limit !== 0 ||
      (!fresh && start >= Math.max(1, matched))
    )
      return;
    busy = true;
    root.setAttribute('aria-busy', 'true');
    for (const id of [
      'evidence-rows-previous',
      'evidence-rows-next',
      'evidence-rows-page',
      'evidence-rows-page-size',
      'evidence-rows-retry',
      'evidence-row-apply',
      'evidence-row-clear',
      'evidence-columns-reset',
      ...columns.map(key => 'evidence-column-' + key),
    ]) {
      const control = $('#' + id);
      if (control) control.disabled = true;
    }
    let page;
    try {
      page = await workspaceCall('reporting', {
        action: 'get',
        id: report.id,
        offset: start,
        limit,
        ...(query ? {row_query: query} : {}),
      });
    } catch {
      if (current()) failure(start, false, fresh);
      return;
    }
    if (!current()) return;
    if (!valid(page, start, fresh)) {
      failure(start, true, fresh);
      return;
    }
    offset = start;
    matched = matches(page);
    busy = false;
    render(page, true);
  }
  if (!current()) return;
  if (typeof query !== 'string' || query.length > 150 || !valid(report, 0, false)) {
    failure(0, true);
    return;
  }
  render(report);
}

function evidencePresetLabel(preset) {
  switch (preset.id) {
    case 'google_campaign':
      return uiText('Google campaign performance');
    case 'google_adset':
      return uiText('Google ad group performance');
    case 'google_ad':
      return uiText('Google ad performance');
    case 'google_keyword':
      return uiText('Google keyword performance');
    case 'google_campaign_device':
      return uiText('Google campaign device performance');
    case 'google_campaign_hour':
      return uiText('Google campaign hourly performance');
    case 'google_campaign_country':
      return uiText('Google campaign country performance');
    case 'google_search_terms':
      return uiText('Google search term evidence');
    case 'google_pmax_search_terms':
      return uiText('Google Performance Max search terms');
    case 'google_campaign_network':
      return uiText('Google campaign network performance');
    case 'meta_campaign':
      return uiText('Meta campaign performance');
    case 'meta_campaign_age_gender':
      return uiText('Meta campaign age and gender');
    case 'meta_campaign_country':
      return uiText('Meta campaign country');
    case 'meta_campaign_placement':
      return uiText('Meta campaign placement');
    case 'meta_adset':
      return uiText('Meta ad set performance');
    case 'meta_ad':
      return uiText('Meta ad performance');
    case 'linkedin_campaign_group':
      return uiText('LinkedIn campaign group performance');
    case 'linkedin_campaign':
      return uiText('LinkedIn campaign performance');
    case 'linkedin_creative':
      return uiText('LinkedIn creative performance');
    case 'linkedin_campaign_conversion':
      return uiText('LinkedIn campaign conversions with verified rule windows');
    case 'tiktok_campaign':
      return uiText('TikTok campaign performance');
    case 'tiktok_adgroup':
      return uiText('TikTok ad group performance');
    case 'tiktok_ad':
      return uiText('TikTok ad performance');
    case 'snapchat_campaign':
      return uiText('Snapchat campaign performance');
    case 'snapchat_adsquad':
      return uiText('Snapchat ad squad performance');
    case 'snapchat_ad':
      return uiText('Snapchat ad performance');
    case 'snapchat_campaign_leads':
      return uiText('Snapchat campaign native lead submissions');
    case 'snapchat_adsquad_leads':
      return uiText('Snapchat ad squad native lead submissions');
    case 'snapchat_ad_leads':
      return uiText('Snapchat ad native lead submissions');
    default:
      return preset.name;
  }
}
function evidenceCaptureFeedback(form, current) {
  const button = form.querySelector('button[type=submit]');
  button.id = 'capture-preset-submit';
  button.insertAdjacentHTML(
    'beforebegin',
    `<div id="capture-feedback" role="alert" aria-atomic="true" hidden><strong>${esc(uiText('Capture needs attention'))}</strong><p id="capture-feedback-message"></p><p>${esc(uiText('Review the message and your settings before submitting again.'))}</p></div>`,
  );
  const region = $('#capture-feedback'),
    message = $('#capture-feedback-message'),
    connected = () => current() && form.isConnected && region.isConnected;
  const describe = include => {
    for (const control of [form, button]) {
      const ids = (control.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean),
        remaining = ids.filter(id => id !== 'capture-feedback');
      if (include) remaining.push('capture-feedback');
      if (remaining.length) control.setAttribute('aria-describedby', remaining.join(' '));
      else control.removeAttribute('aria-describedby');
    }
  };
  return {
    clear() {
      if (!connected()) return;
      region.hidden = true;
      message.textContent = '';
      describe(false);
    },
    show(error) {
      if (!connected()) return;
      const text = errorMessage(error);
      if (!text) return;
      message.textContent = text;
      describe(true);
      region.hidden = false;
    },
  };
}

function evidenceFormContext(form, current, onChange) {
  let sequence = 0;
  const invalidate = event => {
    if (!current()) return;
    sequence++;
    onChange?.(event);
  };
  form.addEventListener('input', invalidate);
  form.addEventListener('change', invalidate);
  return () => {
    const attempt = ++sequence;
    return () => current() && form.isConnected && attempt === sequence;
  };
}
async function mountCaptureWizard(openReport) {
  const generation = navigationGeneration,
    identity = identityGeneration,
    root = $('#report-capture'),
    current = () => generation === navigationGeneration && identity === identityGeneration && root.isConnected;
  let presets;
  try {
    ({presets} = await workspaceCall('reporting', {action: 'capture_presets'}));
  } catch (error) {
    if (current()) throw error;
    return;
  }
  if (!current()) return;
  const gateways = {
    google: 'google_ads_native_action',
    meta: 'meta_native_action',
    linkedin: 'linkedin_native_action',
    tiktok: 'tiktok_native_action',
    snapchat: 'snapchat_native_action',
  };
  const connected = platforms
    .filter(p => presets.some(s => s.gateway === gateways[p.id]))
    .flatMap(p =>
      p.connections
        .filter(c => c.enabled)
        .flatMap(c =>
          c.accounts.map(account_id => ({
            gateway: gateways[p.id],
            connection_id: c.id,
            account_id,
            label: accountLabel(p, c, account_id),
          })),
        ),
    );
  // The account picker follows the working client (SEC-08); an account a link names stays listed.
  const targets = typeof clientAccountOptions === 'function' ? clientAccountOptions(connected).options : connected;
  root.innerHTML = `<summary>${esc(uiText('Capture detailed native evidence'))}</summary><p>${esc(uiText('Choose detailed Google, Meta, LinkedIn, TikTok or Snapchat evidence. Each provider keeps its native reporting levels and measurement definitions. Reading may take up to two minutes.'))}</p><form id="capture-preset"><div class="recipe-fields"><label>${esc(uiText('Report detail'))}<select name="preset">${presets.map(p => `<option value="${esc(p.id)}">${esc(evidencePresetLabel(p))}</option>`).join('')}</select></label><label>${esc(uiText('Account'))}<select name="target" required></select></label>${controls(uiText('Evidence name'), 'text', '', 'source_name')}${controls(uiText('From'), 'date', '', 'date_from')}${controls(uiText('Through'), 'date', '', 'date_to')}${controls(uiText('Native currency'), 'text', '', 'currency')}${controls(uiText('Native IANA timezone'), 'text', '', 'timezone')}</div><p id="capture-account-metadata" class="form-note" hidden></p><div class="recipe-fields" id="capture-generic-measurement">${controls(uiText('Attribution definition'), 'text', '', 'attribution')}${controls(uiText('Conversion definition'), 'text', '', 'conversion_definition')}</div><div class="recipe-fields" id="capture-meta-measurement" hidden><label>${esc(uiText('Exact Meta conversion action type'))}<input name="result_action_type" maxlength="160" list="meta-action-examples" placeholder="offsite_conversion.fb_pixel_purchase"></label><datalist id="meta-action-examples"><option value="offsite_conversion.fb_pixel_purchase"></option><option value="offsite_conversion.fb_pixel_lead"></option></datalist><label>${esc(uiText('Meta attribution window'))}<select name="attribution_windows"><option value="">${esc(uiText('Choose explicitly'))}</option><option value="1d_click">${esc(uiText('1-day click'))}</option><option value="7d_click">${esc(uiText('7-day click'))}</option><option value="1d_click,1d_view">${esc(uiText('1-day click and 1-day view'))}</option><option value="7d_click,1d_view">${esc(uiText('7-day click and 1-day view'))}</option><option value="7d_click,1d_view,1d_ev">${esc(uiText('7-day click, 1-day view and 1-day engaged view'))}</option><option value="28d_click">${esc(uiText('28-day click'))}</option><option value="28d_click,1d_view">${esc(uiText('28-day click and 1-day view'))}</option><option value="1d_view">${esc(uiText('1-day view only'))}</option></select></label><p class="form-note">${esc(uiText('Uses impression-time reporting and the exact selected action type. Overlapping purchase aliases are not combined; an absent action remains unknown.'))}</p></div><p class="form-note">${esc(uiText('Match the native account currency, timezone and report window. Search-term visibility can prevent equality with campaign totals. Missing metrics stay unknown.'))}</p><label class="form-note"><input name="complete" type="checkbox"> ${esc(uiText('The selected reporting window is complete under these declared measurement settings.'))}</label><button type="submit" class="button primary">${esc(uiText('Read and retain evidence'))}</button></form>`;
  const form = $('#capture-preset'),
    feedback = evidenceCaptureFeedback(form, current);
  $('#capture-meta-measurement').insertAdjacentHTML(
    'beforeend',
    `<p class="form-note">${esc(uiText('Meta verifies account currency and timezone before and after complete Insights pages, including empty reports. Each page keeps its source reference. Keep attribution choices explicit; complete paging does not verify conversion delivery.'))}</p>`,
  );
  form.insertAdjacentHTML(
    'beforeend',
    `<p id="capture-google-keyword-measurement" class="form-note" hidden>${esc(uiText('Positive Search keyword performance by account-local day. Keeps original keyword text, match type and full resource identity. This does not establish search-query coverage or eligibility for exclusions or budget changes.'))}</p><p id="capture-google-device-measurement" class="form-note" hidden>${esc(uiText('Campaign performance by original device and account-local day. Retains native device values and complete captured totals. Missing device categories are not proof of zero activity. This report does not qualify device bid or budget changes.'))}</p><p id="capture-google-hour-measurement" class="form-note" hidden>${esc(uiText('Retains the original reported hour (0–23), date and account timezone. Explicit hour zero is preserved; missing hours are not proof of zero activity. No timezone conversion is applied. This report does not qualify delivery schedule, bid or budget changes.'))}</p><p id="capture-google-country-measurement" class="form-note" hidden>${esc(uiText('Retains native country criterion IDs, location presence or interest, and account-local dates. Country IDs are not country names. Missing countries are not proof of zero activity. This report does not qualify geographic targeting or budget changes.'))}</p><p id="capture-google-measurement" class="form-note" hidden>${esc(uiText('Google verifies customer currency and timezone before and after complete report pages. Ads and search terms keep their full resource identity. Conversions use metrics.conversions; declare attribution windows or enter unknown. Search-term evidence excludes Performance Max and may not equal campaign totals.'))}</p>`,
  );
  form.insertAdjacentHTML(
    'beforeend',
    `<p id="capture-linkedin-measurement" class="form-note" hidden>${esc(uiText('LinkedIn uses UTC daily dates and externalWebsiteConversions. Account identity and currency are verified before and after the complete analytics response. Each read keeps its source reference. Declare the conversion-rule attribution windows, or enter unknown. Empty results cannot prove zero activity. Use the current month or previous five calendar months; narrow large reports.'))}</p><p id="capture-linkedin-conversion-measurement" class="form-note" hidden>${esc(uiText('Conversions by campaign and conversion rule, with post-click and post-view counts. The account’s current conversion rules are read in the same check and each conversion is joined to its rule’s windows: verified when all rules match, mixed when they differ (no single window), unknown when a rule is missing. Spend, impressions and clicks are not split by conversion and stay unmapped.'))}</p>`,
  );
  let declaredTimezone = form.elements.timezone.value,
    declaredConversion = form.elements.conversion_definition.value,
    declaredAttribution = form.elements.attribution.value;
  form.insertAdjacentHTML(
    'beforeend',
    `<p id="capture-tiktok-measurement" class="form-note" hidden>${esc(uiText('TikTok uses advertiser-local daily dates for standard auction campaigns, ad groups and ads. Currency and timezone are verified before and after collection. Choose 1–31 closed days. Native conversion follows each entity optimization goal; goals may differ. Declare attribution windows or enter unknown. Smart+ and GMV Max reports are separate.'))}</p>`,
  );
  form.insertAdjacentHTML(
    'beforeend',
    `<div class="recipe-fields" id="capture-snapchat-measurement" hidden><div id="capture-snapchat-purchases" class="recipe-fields"><label>${esc(uiText('Swipe attribution window'))}<select name="swipe_up_attribution_window"><option value="">${esc(uiText('Choose explicitly'))}</option><option value="1_DAY">${esc(uiText('1-day swipe'))}</option><option value="7_DAY">${esc(uiText('7-day swipe'))}</option><option value="28_DAY">${esc(uiText('28-day swipe'))}</option></select></label><label>${esc(uiText('View attribution window'))}<select name="view_attribution_window"><option value="">${esc(uiText('Choose explicitly'))}</option><option value="none">${esc(uiText('No view attribution'))}</option><option value="1_HOUR">${esc(uiText('1-hour view'))}</option><option value="3_HOUR">${esc(uiText('3-hour view'))}</option><option value="6_HOUR">${esc(uiText('6-hour view'))}</option><option value="1_DAY">${esc(uiText('1-day view'))}</option><option value="7_DAY">${esc(uiText('7-day view'))}</option></select></label><p class="form-note">${esc(uiText('Snapchat purchase evidence uses conversion-time reporting and total conversion sources. Swipes map to clicks. Choose 1–31 closed days; native delivery and conversion processing must cover the whole window. Missing metrics remain unknown.'))}</p></div><p id="capture-snapchat-lead-note" class="form-note" hidden>${esc(uiText('Counts submitted native lead forms with native_leads; no submitted lead records are read. Purchase attribution controls do not apply. Choose 1–31 closed account-local days with finalized non-conversion metrics. Missing counts stay unknown; lead quality and off-platform attribution are not established.'))}</p></div>`,
  );
  $('#capture-snapchat-measurement').insertAdjacentHTML(
    'beforeend',
    `<div id="capture-snapchat-parent" hidden>${controls(uiText('Snapchat parent campaign UUID'), 'text', '', 'campaign_id')}<p class="form-note">${esc(uiText('Parent-scoped ad-squad or ad evidence is limited to this exact campaign. Its account ownership is checked before and after the complete report; use Portfolio to select the campaign UUID.'))}</p><a href="/portfolio">${esc(uiText('Open Portfolio'))}</a></div>`,
  );
  const begin = evidenceFormContext(form, current, event => {
    feedback.clear();
    if (event.target !== form.elements.complete) form.elements.complete.checked = false;
  });
  const selectPreset = () => {
    const preset = presets.find(p => p.id === form.elements.preset.value),
      selected = form.elements.target.value;
    form.elements.target.innerHTML =
      `<option value="">${esc(uiText('Choose the exact login and account'))}</option>` +
      targets
        .map((t, i) => (t.gateway === preset.gateway ? `<option value="${i}">${esc(t.label)}</option>` : ''))
        .join('');
    if (selected !== '' && targets[Number(selected)]?.gateway === preset.gateway) form.elements.target.value = selected;
    const meta = preset.gateway === 'meta_native_action';
    const linkedin = preset.gateway === 'linkedin_native_action';
    const tiktok = preset.gateway === 'tiktok_native_action';
    const google = preset.gateway === 'google_ads_native_action';
    const snapchat = preset.gateway === 'snapchat_native_action';
    const leads = ['snapchat_campaign_leads', 'snapchat_adsquad_leads', 'snapchat_ad_leads'].includes(preset.id);
    const squad = ['snapchat_adsquad', 'snapchat_adsquad_leads', 'snapchat_ad_leads'].includes(preset.id);
    // RPT-07: rule windows are read and joined by the server; the person never types a LinkedIn window here.
    const ruleWindows = preset.id === 'linkedin_campaign_conversion';
    $('#capture-linkedin-conversion-measurement').hidden = !ruleWindows;
    $('#capture-snapchat-parent').hidden = !squad;
    form.elements.campaign_id.required = squad;
    form.elements.campaign_id.disabled = !squad;
    $('#capture-snapchat-measurement').hidden = !snapchat;
    $('#capture-snapchat-purchases').hidden = leads;
    $('#capture-snapchat-lead-note').hidden = !leads;
    $('#capture-linkedin-measurement').hidden = !linkedin;
    $('#capture-tiktok-measurement').hidden = !tiktok;
    $('#capture-google-measurement').hidden = !google;
    for (const [key, fixed] of [
      ['timezone', linkedin ? 'UTC' : null],
      ['attribution', ruleWindows ? 'verified_per_rule' : null],
      [
        'conversion_definition',
        ruleWindows
          ? 'externalWebsiteConversions by conversion rule'
          : linkedin
            ? 'externalWebsiteConversions'
            : tiktok
              ? 'conversion (optimization goal)'
              : google
                ? 'metrics.conversions'
                : null,
      ],
    ]) {
      const field = form.elements[key];
      if (fixed !== null) {
        if (!field.readOnly) {
          if (key === 'timezone') declaredTimezone = field.value;
          else if (key === 'attribution') declaredAttribution = field.value;
          else declaredConversion = field.value;
        }
        field.value = fixed;
      } else if (field.readOnly)
        field.value =
          key === 'timezone' ? declaredTimezone : key === 'attribution' ? declaredAttribution : declaredConversion;
      field.readOnly = fixed !== null;
    }
    $('#capture-google-keyword-measurement').hidden = form.elements.preset.value !== 'google_keyword';
    $('#capture-google-device-measurement').hidden = form.elements.preset.value !== 'google_campaign_device';
    $('#capture-google-hour-measurement').hidden = form.elements.preset.value !== 'google_campaign_hour';
    $('#capture-google-country-measurement').hidden = form.elements.preset.value !== 'google_campaign_country';
    $('#capture-generic-measurement').hidden = meta || snapchat;
    $('#capture-meta-measurement').hidden = !meta;
    for (const key of ['result_action_type', 'attribution_windows']) {
      form.elements[key].required = meta;
      form.elements[key].disabled = !meta;
    }
    for (const key of ['attribution', 'conversion_definition']) {
      form.elements[key].required = !meta && !snapchat;
      form.elements[key].disabled = meta || snapchat;
    }
    for (const key of ['swipe_up_attribution_window', 'view_attribution_window']) {
      form.elements[key].required = snapchat && !leads;
      form.elements[key].disabled = !snapchat || leads;
    }
  };
  // One listener: harnesses and browsers alike re-render the accounts, then refresh the account hint (RPT-05).
  form.elements.preset.addEventListener('change', () => {
    selectPreset();
    void prefill();
  });
  selectPreset();
  // RPT-05: the selected account's stored currency and timezone prefill the declared fields. They stay editable and
  // the capture still verifies both against the provider. Empty dates default to the last 7 complete account-local
  // days. Values the person typed are never replaced.
  let metadataSequence = 0;
  const prefilled = {};
  const localDay = zone => {
    const options = {year: 'numeric', month: '2-digit', day: '2-digit'};
    try {
      return new Intl.DateTimeFormat('en-CA', {...options, timeZone: zone}).format(new Date());
    } catch {
      return new Intl.DateTimeFormat('en-CA', options).format(new Date());
    }
  };
  const shiftDay = (day, days) => new Date(Date.parse(day + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
  const prefill = async () => {
    const sequence = ++metadataSequence,
      t = targets[Number(form.elements.target.value)],
      hint = $('#capture-account-metadata');
    if (form.elements.target.value === '' || !t) {
      hint.hidden = true;
      hint.textContent = '';
      return;
    }
    let target = null;
    try {
      ({target} = await workspaceCall('reporting', {
        action: 'capture_presets',
        connection_id: t.connection_id,
        account_id: t.account_id,
      }));
    } catch {
      target = null;
    }
    if (!current() || sequence !== metadataSequence) return;
    const fill = (key, value) => {
      const field = form.elements[key];
      if (typeof value !== 'string' || !value) return;
      if (field.readOnly) {
        if (key === 'timezone' && (declaredTimezone === '' || declaredTimezone === prefilled.timezone)) {
          declaredTimezone = value;
          prefilled.timezone = value;
        }
      } else if (field.value === '' || field.value === prefilled[key]) {
        field.value = value;
        prefilled[key] = value;
      }
    };
    fill('currency', target?.currency);
    fill('timezone', target?.timezone);
    const today = localDay(target?.timezone ?? undefined);
    fill('date_to', shiftDay(today, -1));
    fill('date_from', shiftDay(today, -7));
    hint.textContent = target?.checked_at
      ? target.stale
        ? uiText(
            'Account details were read on {date}, more than 7 days ago. Check the currency and timezone before capturing.',
            {date: uiDate(target.checked_at)},
          )
        : uiText(
            'Currency and timezone from the account read on {date}. Edit them if they changed; the capture verifies both.',
            {date: uiDate(target.checked_at)},
          )
      : uiText(
          'No account read is stored for this account yet. Enter its native currency and timezone; the capture verifies both.',
        );
    hint.hidden = false;
  };
  form.elements.target.addEventListener('change', () => void prefill());
  // WEB-06: Portfolio's "Capture evidence for this campaign" (/reports?connection_id=&account_id=&campaign_id=
  // #report-capture) preselects the account and, for Snapchat, the parent campaign. Nothing is read until submitted.
  const linked =
      typeof URLSearchParams === 'function' && typeof location === 'object' && location
        ? new URLSearchParams(location.search ?? '')
        : new Map(),
    linkedTarget = targets.findIndex(
      t => t.connection_id === linked.get('connection_id') && t.account_id === linked.get('account_id'),
    );
  if (linkedTarget >= 0) {
    // A Snapchat campaign opens its parent-scoped ad-squad evidence; other providers report the whole account.
    const gateway = targets[linkedTarget].gateway,
      campaign = (linked.get('campaign_id') ?? '').slice(0, 200),
      preset =
        (campaign && gateway === 'snapchat_native_action' && presets.find(p => p.id === 'snapchat_adsquad')) ||
        presets.find(p => p.gateway === gateway);
    if (preset) {
      form.elements.preset.value = preset.id;
      selectPreset();
      form.elements.target.value = String(linkedTarget);
      if (campaign) form.elements.campaign_id.value = campaign;
      root.open = true;
      // RPT-05: the linked account prefills its stored currency, timezone and dates like a chosen one.
      void prefill();
    }
  } else if (linked.get('connection_id') || linked.get('account_id'))
    form.elements.target.insertAdjacentHTML(
      'afterbegin',
      `<option value="" selected>${esc(uiText('Previously selected account — check access'))}</option>`,
    );
  workspaceBind('#capture-preset', async form => {
    const active = begin();
    if (!active()) return;
    feedback.clear();
    const t = targets[Number(form.elements.target.value)];
    const preset = presets.find(p => p.id === form.elements.preset.value);
    let out;
    try {
      if (form.elements.target.value === '' || !t || !preset || t.gateway !== preset.gateway)
        throw Error(uiText('Choose the exact account for this provider.'));
      const semantics = Object.fromEntries(
        ['source_name', 'date_from', 'date_to', 'currency', 'timezone', 'attribution', 'conversion_definition'].map(
          k => [k, form.elements[k].value.trim()],
        ),
      );
      out = await workspaceCall('reporting', {
        action: 'capture_preset',
        preset: form.elements.preset.value,
        connection_id: t.connection_id,
        account_id: t.account_id,
        semantics: {...semantics, complete: form.elements.complete.checked},
        ...(preset.gateway === 'snapchat_native_action' && !preset.id.endsWith('_leads')
          ? {
              swipe_up_attribution_window: form.elements.swipe_up_attribution_window.value,
              view_attribution_window: form.elements.view_attribution_window.value,
            }
          : {}),
        ...(['snapchat_adsquad', 'snapchat_adsquad_leads', 'snapchat_ad_leads'].includes(preset.id)
          ? {campaign_id: form.elements.campaign_id.value.trim()}
          : {}),
        ...(preset.gateway === 'meta_native_action'
          ? {
              result_action_type: form.elements.result_action_type.value.trim(),
              attribution_windows: form.elements.attribution_windows.value.split(','),
            }
          : {}),
      });
    } catch (error) {
      if (active()) feedback.show(error);
      return;
    }
    if (!active()) return;
    await openReport(out.id);
    if (active()) toast(uiText('Evidence retained with its original source and mapping.'));
  });
}
function mountScenarioModel(report) {
  const generation = navigationGeneration,
    identity = identityGeneration;
  $('#report-detail').insertAdjacentHTML(
    'beforeend',
    `<details class="panel workspace-form"><summary>${esc(uiText('Explore budget scenarios'))}</summary><p>${esc(uiText('Model a range of outcomes from this report’s observed cost per conversion. This is a sensitivity model, not a forecast.'))}</p><form id="scenario-model"><label>${esc(uiText('Budgets in {currency} — one per line', {currency: report.semantics.currency}))}<textarea name="budgets" rows="3" required></textarea></label>${controls(uiText('Low efficiency factor'), 'number', '0.8', 'efficiency_low')}${controls(uiText('High efficiency factor'), 'number', '1.2', 'efficiency_high')}<p class="form-note">${esc(uiText('1.0 keeps the observed conversion efficiency; 0.8 assumes 20% fewer conversions per unit of budget.'))}</p><button type="submit" class="button">${esc(uiText('Model scenarios'))}</button></form><div id="scenario-result" aria-live="polite"></div></details>`,
  );
  const scenarioResult = $('#scenario-result'),
    form = $('#scenario-model'),
    current = () =>
      generation === navigationGeneration && identity === identityGeneration && scenarioResult.isConnected,
    begin = evidenceFormContext(form, current, () => {
      scenarioResult.innerHTML = '';
    });
  workspaceBind('#scenario-model', async form => {
    const active = begin();
    if (!active()) return;
    scenarioResult.innerHTML = '';
    let out;
    try {
      out = await workspaceCall('reporting', {
        action: 'scenarios',
        id: report.id,
        options: {
          budgets: form.elements.budgets.value
            .split(/\r?\n/)
            .map(s => s.trim())
            .filter(Boolean),
          efficiency_low: Number(form.elements.efficiency_low.value),
          efficiency_high: Number(form.elements.efficiency_high.value),
        },
      });
    } catch (error) {
      if (active()) throw error;
      return;
    }
    if (!active()) return;
    scenarioResult.innerHTML = `<p>${badge(out.evidence_status)} · ${esc(uiText('Observed CPA: {amount} {currency}', {amount: out.observed.cpa, currency: out.currency}))}</p><div class="data-scroll"><table class="review-table"><caption>${esc(uiText('Modeled outcomes under your assumptions'))}</caption><thead><tr><th scope="col">${esc(uiText('Budget'))}</th><th scope="col">${esc(uiText('Low conversions'))}</th><th scope="col">${esc(uiText('High conversions'))}</th></tr></thead><tbody>${out.scenarios.map(s => `<tr><td>${esc(s.budget)} ${esc(out.currency)}</td><td>${esc(uiNumber(s.modeled_conversions_low, {maximumFractionDigits: 1}))}</td><td>${esc(uiNumber(s.modeled_conversions_high, {maximumFractionDigits: 1}))}</td></tr>`).join('')}</tbody></table></div><ul>${out.limitations.map(x => `<li>${esc(uiReportExplanation(x))}</li>`).join('')}</ul>${recordDetails(out, uiText('Model assumptions and source lineage'))}`;
  });
  mountAllocationModel(report);
}
function reportPackBody(pack) {
  // RPT-05: platform display names, localized report dates and currency values in their own minor units.
  const value = x => (x === null || x === undefined ? uiText('Unknown') : esc(uiDecimal(x)));
  const money = (x, currency) =>
    x === null || x === undefined ? uiText('Unknown') : esc(uiDecimal(x, currency ? {currency} : {}));
  const platform = id => pack.platform_names?.[id] ?? pretty(id ?? uiText('Source'));
  const day = v =>
    /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''))
      ? uiDate(v + 'T00:00:00Z', {dateStyle: 'medium', timeZone: 'UTC'})
      : String(v ?? '');
  const context = s =>
    `${esc(platform(s.platform))} · ${esc(s.account_id)} · ${esc(s.objective_group ? uiText(pretty(s.objective_group)) : uiText('All objectives'))}`;
  const charts = pack.summary.filter(s => Number.isFinite(s.metrics.ctr)).slice(0, 30);
  const scale = Math.max(1, ...charts.map(s => s.metrics.ctr));
  return `<article class="report-pack">
    <header><svg viewBox="0 0 1000 5" aria-hidden="true"><rect width="1000" height="5" fill="${esc(pack.presentation?.accent_color || '#354B67')}"/></svg><p class="eyebrow">AMCP · ${esc(pack.presentation?.brand_name || pack.client_name || uiText('Performance report'))}</p>
      <h1>${esc(pack.title)}</h1><p>${esc(day(pack.date_range.since))} — ${esc(day(pack.date_range.until))} · ${esc(uiText('{grain} grouping', {grain: uiText(pretty(pack.grain))}))}</p>
      <p>${esc(uiText('{state} snapshot · {count} source rows · Collected {date}', {state: uiText(pretty(pack.state)), count: uiNumber(pack.row_count), date: date(pack.created_at)}))}</p></header>
    ${pack.state === 'partial' ? `<p class="notice">${esc(uiText('Partial evidence: some sources or periods are incomplete. See source coverage before interpreting results.'))}</p>` : ''}
    <h2>${esc(uiText('Account and measurement summaries'))}</h2><p>${esc(uiText('Each row retains its own currency, timezone, attribution, conversion definition and reporting window.'))}</p>
    <div class="data-scroll" role="region" aria-label="${esc(uiText('Account performance, scroll for all metrics'))}" tabindex="0"><table class="review-table">
      <caption>${esc(uiText('Performance by account, objective and period'))}</caption>
      <thead><tr><th scope="col">${esc(uiText('Account / context'))}</th><th scope="col">${esc(uiText('Period'))}</th><th scope="col">${esc(uiText('Spend'))}</th><th scope="col">${esc(uiText('Impressions'))}</th><th scope="col">${esc(uiText('Clicks'))}</th><th scope="col">${esc(uiText('Conversions'))}</th><th scope="col">CPA</th></tr></thead>
      <tbody>${pack.summary.map(s => `<tr><th scope="row">${context(s)}<small>${esc(s.timezone)}<br>${esc(s.result_definition)}<br>${esc(s.attribution)} · ${s.complete ? uiText('Complete') : uiText('Incomplete')}</small></th><td>${esc(day(s.date_from))}<br>${esc(day(s.date_to))}</td><td class="pack-value">${money(s.metrics.spend, s.currency)}</td><td class="pack-value">${value(s.metrics.impressions)}</td><td class="pack-value">${value(s.metrics.clicks)}</td><td class="pack-value">${value(s.metrics.conversions)}</td><td class="pack-value">${money(s.metrics.cpa, s.currency)}</td></tr>`).join('')}</tbody></table></div>
    <h2>${esc(uiText('Click-through rate by account and period'))}</h2><p>${esc(uiText('Each bar uses compatible native totals. The shared scale runs from 0% to {scale}%; accounts are not combined.', {scale: uiNumber(scale, {maximumFractionDigits: 2})}))}${pack.summary.length > 30 ? ' ' + esc(uiText('The first 30 available ratios are shown; the table includes all groups.')) : ''}</p>
    ${
      charts.length
        ? charts
            .map(s => {
              const rate = s.metrics.ctr,
                width = Math.max(0, Math.min(100, (rate / scale) * 100));
              return `<figure><figcaption>${context(s)} · ${esc(day(s.date_from))} — ${esc(day(s.date_to))}: ${value(rate)}%</figcaption><svg viewBox="0 0 500 18" role="img" aria-label="${esc(uiText('Click-through rate {rate} percent', {rate: uiNumber(rate, {maximumFractionDigits: 2})}))}"><rect width="500" height="18" fill="#ebe9f6"/><rect width="${width * 5}" height="18" fill="#5a43ad"/></svg></figure>`;
            })
            .join('')
        : `<p>${esc(uiText('Click-through rate is unavailable in this snapshot.'))}</p>`
    }
    <h2>${esc(uiText('Source coverage'))}</h2>
    ${pack.sources.map(s => `<section class="pack-evidence"><h3>${esc(platform(s.platform))} · ${esc(s.account_id ?? uiText('Account'))}</h3><p>${s.complete ? uiText('Complete') : uiText('Incomplete')} · ${esc(uiText('{count} rows', {count: s.row_count == null ? uiText('Unknown') : uiNumber(s.row_count)}))}${s.error ? ' · ' + esc(s.error.code ?? uiText('Source error')) + ': ' + esc(s.error.message ?? uiText('Inspect source evidence for recovery details.')) : ''}</p><details><summary>${esc(uiText('Measurement definitions and source reference'))}</summary><dl><dt>${esc(uiText('Attribution'))}</dt><dd>${esc(s.attribution ?? uiText('Unknown'))}</dd><dt>${esc(uiText('Conversion definition'))}</dt><dd>${esc(s.result_definition ?? uiText('Unknown'))}</dd><dt>${esc(uiText('Query fingerprint'))}</dt><dd><code>${esc(s.query_fingerprint ?? uiText('Not supplied'))}</code></dd></dl></details></section>`).join('')}
    <h2>${esc(uiText('Reading this report'))}</h2><ul>${pack.limitations.map(x => `<li>${esc(uiReportExplanation(x))}</li>`).join('')}</ul>
    <details class="pack-evidence"><summary>${esc(uiText('Snapshot and audit reference'))}</summary><p>${esc(uiText('Snapshot:'))} <code>${esc(pack.snapshot_id)}</code><br>${esc(uiText('Source hash:'))} <code>${esc(pack.source_hash)}</code></p></details>
    ${pack.presentation?.footer ? `<p>${esc(pack.presentation.footer)}</p>` : ''}
    <p>${esc(uiText('Retain the raw CSV and source evidence JSON with this report pack. This pack presents the saved snapshot and does not refresh provider data.'))}</p></article>`;
}
async function renderReportPack(focus = false) {
  const generation = navigationGeneration,
    identity = identityGeneration,
    current = () => generation === navigationGeneration && identity === identityGeneration;
  const id = new URLSearchParams(location.search).get('report_id');
  if (!id) throw Error(uiText('Open a report pack from a retained snapshot.'));
  const pack = await overviewCall({action: 'report_pack', id});
  if (!current()) return false;
  // Report files are for operators unless the owner allows viewer downloads (SEC-05); the server refuses them too.
  const downloads = typeof session === 'undefined' || session?.downloadsAllowed !== false;
  content.innerHTML =
    `<div class="dialog-actions report-pack-actions"><a class="button" href="/reporting-overview?report_id=${encodeURIComponent(id)}">${esc(uiText('Back to snapshot'))}</a>${downloads ? `<button class="button primary" id="download-pack">${esc(uiText('Download HTML report pack'))}</button><button class="button" id="download-pack-pdf">${esc(uiText('Download PDF'))}</button><button class="button" id="download-pack-xlsx">${esc(uiText('Download Excel'))}</button>` : ''}<button class="button" id="print-pack">${esc(uiText('Print preview'))}</button>${downloads ? `<a class="button" href="${esc(pack.csv_path)}" download="AMCP-report-rows.csv">${esc(uiText('Raw CSV'))}</a><a class="button" href="${esc(pack.evidence_path)}" download="AMCP-report-evidence.json">${esc(uiText('Source evidence'))}</a>` : ''}</div><p class="notice report-pack-actions">${esc(uiText('Review client labels, selected accounts and source coverage before sharing. The downloaded HTML contains these displayed account details.'))}</p>` +
    reportPackBody(pack);
  await bindReportPresentation(pack, id);
  if (!current()) return false;
  workspaceBind('#print-pack', () => {
    if (current()) window.print();
  });
  workspaceBind('#download-pack', () => {
    if (!current()) return;
    const html =
      `<!doctype html><html lang="${uiLocale}" dir="${uiLocale === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>` +
      esc(pack.title) +
      `</title><style>body{font:15px/1.55 system-ui,sans-serif;color:#252336;max-width:1200px;margin:auto;padding:40px}h1{font-size:36px}h2{margin-top:36px}table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:start;padding:10px;border-bottom:1px solid #ddd;vertical-align:top}small{display:block;font-weight:normal;margin-top:6px}.data-scroll{overflow-x:auto}.review-table{min-width:760px}.review-table th:first-child{min-width:180px}.pack-value{white-space:nowrap}.pack-evidence{border-top:1px solid #ddd;padding:12px 0}.pack-evidence dl{display:grid;grid-template-columns:1fr 3fr;gap:8px}.pack-evidence dd{margin:0;overflow-wrap:anywhere}figure{max-width:650px}code{overflow-wrap:anywhere;direction:ltr;unicode-bidi:isolate}summary{cursor:pointer}pre{white-space:pre-wrap}thead{display:table-header-group}@media print{body{padding:0}.data-scroll{overflow:visible}.review-table{min-width:0;font-size:9pt}.review-table th:first-child{min-width:0;width:25%}td,th{padding:5pt}tr,figure{break-inside:avoid}}</style></head><body>` +
      reportPackBody(pack) +
      `</body></html>`;
    const url = URL.createObjectURL(new Blob([html], {type: 'text/html'})),
      link = document.createElement('a');
    link.href = url;
    link.download = 'AMCP-report-pack.html';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  if (focus) {
    const heading = content.querySelector('.report-pack h1');
    heading.setAttribute('tabindex', '-1');
    heading.focus();
  }
  return true;
}
