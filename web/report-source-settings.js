'use strict';

function overviewEditorSource(platform, config = {}) {
  const caps = platform.reporting_v4 ?? {},
    modern = overviewState.config?.contract_version === 'overview-config-v4' || config.levels !== undefined,
    levels = modern ? (config.levels ?? [config.level ?? 'campaign']) : [config.level ?? 'campaign'],
    report_options = {...caps.defaults, ...config.report_options};
  const scopes = Object.fromEntries(
    ['campaign_ids', 'adset_ids', 'ad_ids'].map(key => [key, modern ? [...(config[key] ?? [])] : []]),
  );
  for (const [alias, field] of Object.entries(caps.scope_aliases ?? {})) {
    if (config[alias] === undefined) continue;
    if (scopes[field]?.length && !scopes[field].includes(config[alias]))
      throw new Error(uiText('The parent campaign filter conflicts with the selected campaign IDs.'));
    scopes[field] = [config[alias]];
  }
  if (!modern && levels.length === 1 && levels[0] === 'campaign' && config.report_options === undefined)
    for (const key of caps.provider_configured_options ?? []) report_options[key] = null;
  return {
    level: levels[0],
    levels: [...levels],
    statuses: modern ? (config.statuses ?? ['all']) : ['all'],
    delivered_only: modern ? (config.delivered_only ?? true) : false,
    ...scopes,
    report_options,
  };
}
function overviewScopeFields(platform, config, account = false) {
  const caps = platform.reporting_v4 ?? {},
    levels = caps.levels ?? platform.entity_levels ?? [],
    statuses = caps.supported_statuses ?? ['all'];
  return html`<details class="native-settings"><summary>${uiText('Source filters')}</summary>${
    account
      ? html`<p class="form-note">${uiText('Enter exact IDs separated by commas or spaces. Leave empty to include all.')}</p>${levels.map(
          level => {
            const field = {campaign: 'campaign_ids', adset: 'adset_ids', ad: 'ad_ids'}[level.id];
            return field
              ? html`<label>${uiText('IDs for {level} (optional)', {level: uiText(level.label)})}<textarea data-report-scope="${field}" rows="2" dir="ltr">${config[field].join(', ')}</textarea></label>`
              : '';
          },
        )}`
      : ''
  }${statuses.length > 1 ? html`<label>${uiText('Configuration statuses')}<select multiple size="${statuses.length}" data-report-statuses="${platform.id}" required>${statuses.map(status => html`<option value="${status}" ${config.statuses.includes(status) ? 'selected' : ''}>${reportLabel(status)}</option>`)}</select></label><p class="form-note">${uiText('Select All by itself, or choose one or more individual statuses.')}</p>` : ''}<label class="check"><input type="checkbox" data-report-delivered="${platform.id}" ${config.delivered_only ? 'checked' : ''}> ${uiText('Only rows with activity in this window')}</label></details>`;
}
function overviewGranularityFields(platform, original = {}, account = false) {
  const caps = platform.reporting_v4 ?? {},
    choices = caps.levels ?? platform.entity_levels ?? [{id: 'campaign', label: 'Campaign / resource'}],
    config = overviewEditorSource(platform, original),
    selected = config.levels,
    detailed = selected.some(level => level !== 'campaign'),
    options = {
      ...caps.defaults,
      ...Object.fromEntries(Object.entries(config.report_options).filter(([, value]) => value !== null)),
    },
    profileKeys = caps.provider_configured_options ?? [],
    campaignProfile = profileKeys.length
      ? profileKeys.every(key => config.report_options[key] !== null)
      : original.report_options !== undefined;
  const windows =
    platform.id === 'meta'
      ? html`<label>${uiText('Click attribution window')}<select data-report-click-window="meta"><option value="7d_click" ${options.attribution_windows?.includes('7d_click') || !options.attribution_windows ? 'selected' : ''}>7d_click</option><option value="1d_click" ${options.attribution_windows?.includes('1d_click') ? 'selected' : ''}>1d_click</option><option value="28d_click" ${options.attribution_windows?.includes('28d_click') ? 'selected' : ''}>28d_click</option><option value="" ${options.attribution_windows && !options.attribution_windows.some(w => /_click$/.test(w)) ? 'selected' : ''}>${uiText('No click window')}</option></select></label><label class="check"><input type="checkbox" data-report-view-window="meta" ${options.attribution_windows?.includes('1d_view') ? 'checked' : ''}> 1d_view</label><label class="check"><input type="checkbox" data-report-engaged-view-window="meta" ${options.attribution_windows?.includes('1d_ev') ? 'checked' : ''}> 1d_ev (${uiText('engaged view')})</label>`
      : platform.id === 'snapchat'
        ? html`<label>${uiText('Swipe attribution window')}<select data-report-swipe="snapchat">${['1_DAY', '7_DAY', '28_DAY'].map(value => html`<option value="${value}" ${(options.swipe_up_attribution_window ?? '28_DAY') === value ? 'selected' : ''}>${value}</option>`)}</select></label><label>${uiText('View attribution window')}<select data-report-view="snapchat">${['none', '1_HOUR', '3_HOUR', '6_HOUR', '1_DAY', '7_DAY'].map(value => html`<option value="${value}" ${(options.view_attribution_window ?? '1_DAY') === value ? 'selected' : ''}>${value}</option>`)}</select></label>`
        : undefined;
  const measurement =
    platform.id === 'meta'
      ? html`<label>${uiText('Exact Meta result action (optional)')}<input data-report-result="meta" value="${options.result_action_type ?? ''}" pattern="[a-z][a-z0-9_.]{0,159}" maxlength="160"></label><p class="form-note">${uiText('Leave empty to use the platform goal. An exact action overrides the primary result.')}</p>`
      : platform.id === 'snapchat'
        ? ''
        : html`<label>${uiText('Declared conversion attribution')}<input data-report-attribution="${platform.id}" value="${options.attribution ?? 'unknown'}" maxlength="200"></label>`;
  const showMeasurement =
    detailed || caps.requires_complete_window_declaration || caps.option_names?.includes('result_action_type');
  return html`<label>${uiText('Reporting level')}<select data-report-level="${platform.id}" multiple size="${Math.min(choices.length, 3)}" required>${choices.map(level => html`<option value="${level.id}" ${selected.includes(level.id) ? 'selected' : ''}>${uiText(level.label)}</option>`)}</select></label><p class="form-note">${uiText('Select one or more reporting levels.')}</p>${windows ? html`<label class="check" data-report-campaign-profile-field="${platform.id}" ${detailed ? 'hidden' : ''}><input type="checkbox" data-report-campaign-profile="${platform.id}" ${campaignProfile ? 'checked' : ''}> ${uiText('Use explicit attribution windows for campaign rows')}</label><fieldset data-report-windows="${platform.id}" ${!detailed && !campaignProfile ? 'hidden disabled' : ''}><legend>${uiText('Attribution windows')}</legend>${windows}</fieldset>` : ''}${choices.length > 1 || caps.requires_complete_window_declaration ? html`<fieldset data-report-detail="${platform.id}" ${showMeasurement ? '' : 'hidden disabled'}><legend>${uiText('Detailed measurement settings')}</legend>${measurement}<label class="check"><input type="checkbox" data-report-complete-window="${platform.id}" data-original-complete="${config.report_options.complete_window === false ? 'false' : 'null'}" ${config.report_options.complete_window === true ? 'checked' : ''}> ${uiText('I have checked the reporting window is complete')}</label><p class="form-note">${uiText('An undeclared window stays partial where required. Recommendations wait for complete measurement.')}</p>${platform.id === 'linkedin' ? html`<p class="form-note">${uiText('LinkedIn campaigns are the native middle level; its ad-level report uses sponsored creatives. No ad-set hierarchy is invented.')}</p>` : ''}</fieldset>` : ''}${overviewScopeFields(platform, config, account)}`;
}
function overviewSourceQuery(platform, account) {
  const root = account
    ? $('[data-report-source="' + CSS.escape(account) + '"]')
    : $('[data-report-defaults="' + CSS.escape(platform) + '"]');
  return root && typeof root.querySelector === 'function' ? selector => root.querySelector(selector) : $;
}
function overviewSelectedLevels(platform, query = $) {
  const select = query('[data-report-level="' + CSS.escape(platform) + '"]');
  return select?.selectedOptions
    ? [...select.selectedOptions].map(option => option.value)
    : [select?.value || 'campaign'];
}
function overviewAttributionProfile(platform, query = $) {
  return platform === 'meta'
    ? {
        attribution_windows: [
          query('[data-report-click-window="meta"]')?.value ?? '7d_click',
          ...(query('[data-report-view-window="meta"]')?.checked ? ['1d_view'] : []),
          ...(query('[data-report-engaged-view-window="meta"]')?.checked ? ['1d_ev'] : []),
        ].filter(Boolean),
      }
    : {
        swipe_up_attribution_window: query('[data-report-swipe="snapchat"]')?.value ?? '28_DAY',
        view_attribution_window: query('[data-report-view="snapchat"]')?.value ?? '1_DAY',
      };
}
function overviewGranularityConfig(platform, account, previous) {
  const declaration = overviewState.bootstrap?.platforms.find(p => p.id === platform) ?? {id: platform},
    caps = declaration.reporting_v4 ?? {},
    root = account ? $('[data-report-source="' + CSS.escape(account) + '"]') : null;
  // An unavailable account has no editable controls; retain its exact saved setup for the server's access check.
  if (account && !root && previous) return overviewEditorSource(declaration, previous);
  const query = overviewSourceQuery(platform, account),
    levels = overviewSelectedLevels(platform, query),
    detailed = levels.some(level => level !== 'campaign'),
    report_options = {...caps.defaults},
    complete = query('[data-report-complete-window="' + CSS.escape(platform) + '"]');
  report_options.complete_window = complete?.checked
    ? true
    : complete?.dataset.originalComplete === 'false'
      ? false
      : null;
  const attribution = query('[data-report-attribution="' + CSS.escape(platform) + '"]');
  if (attribution) report_options.attribution = attribution.value.trim() || 'unknown';
  if (['meta', 'snapchat'].includes(platform)) {
    if (detailed || query('[data-report-campaign-profile="' + CSS.escape(platform) + '"]')?.checked)
      Object.assign(report_options, overviewAttributionProfile(platform, query));
    else for (const key of caps.provider_configured_options ?? []) report_options[key] = null;
  }
  const action = query('[data-report-result="' + CSS.escape(platform) + '"]')?.value.trim();
  if (action) report_options.result_action_type = action;
  const status = query('[data-report-statuses="' + CSS.escape(platform) + '"]'),
    statuses = status?.selectedOptions ? [...status.selectedOptions].map(option => option.value) : ['all'];
  const result = {
    level: levels[0],
    levels,
    statuses,
    delivered_only: query('[data-report-delivered="' + CSS.escape(platform) + '"]')?.checked ?? true,
    report_options: caps.option_names
      ? Object.fromEntries(Object.entries(report_options).filter(([key]) => caps.option_names.includes(key)))
      : report_options,
  };
  if (account)
    for (const key of ['campaign_ids', 'adset_ids', 'ad_ids'])
      result[key] = (query('[data-report-scope="' + key + '"]')?.value ?? '').split(/[\s,]+/).filter(Boolean);
  return result;
}
/** Each selected account has the same controls, so its group is named after it (and told from a namesake by its ID). */
function overviewAccountFields(platform, source, account, selected, metadata = {}) {
  const name = metadata.label ?? metadata.account_id ?? '',
    id = metadata.account_id !== undefined && String(metadata.account_id) !== String(name) ? metadata.account_id : null;
  return html`<fieldset data-report-source="${account}" ${selected ? '' : 'hidden disabled'}><legend>${name === '' ? uiText('Account report settings') : html`${uiText('Report settings for')} <bdi dir="auto" data-native>${name}</bdi>${id === null ? '' : html` (<bdi dir="ltr">${id}</bdi>)`}`}</legend>${overviewGranularityFields(platform, source, true)}${reportParentChoices(metadata)}</fieldset>`;
}
/** A detailed level reads its preset metrics, so a platform's additional native metrics do nothing there (F-L8-14). */
function overviewNativeNote(platform) {
  return html`<p class="form-note" role="status" data-native-detail-note="${platform}" hidden>${uiText('Detailed reporting uses the preset metrics. Clear additional native metrics before selecting this level.')}</p>`;
}
/** Shows each platform's note while a selected account (or the template) is at a detailed level and native metrics are set. */
function updateOverviewNativeNotes() {
  for (const note of document.querySelectorAll('[data-native-detail-note]')) {
    const platform = note.dataset.nativeDetailNote,
      roots = [
        ...[...document.querySelectorAll('[data-report-source]')].filter(
          root => !root.hidden && JSON.parse(root.dataset.reportSource)[0] === platform,
        ),
        ...document.querySelectorAll('[data-report-defaults="' + CSS.escape(platform) + '"]'),
      ];
    note.hidden = !(
      $('[data-native-for="' + CSS.escape(platform) + '"]')?.value.trim() &&
      roots.some(root =>
        overviewSelectedLevels(platform, selector => root.querySelector(selector)).some(level => level !== 'campaign'),
      )
    );
  }
}
document.addEventListener('input', event => {
  if (event.target.matches?.('[data-native-for]')) updateOverviewNativeNotes();
});
function updateOverviewGranularity() {
  const selected = new Set(
    [...document.querySelectorAll('[data-report-account]:checked')].map(control => control.value),
  );
  document.querySelectorAll('[data-report-source]').forEach(root => {
    root.hidden = !selected.has(root.dataset.reportSource);
    root.disabled = root.hidden;
  });
  document.querySelectorAll('[data-report-windows]').forEach(fieldset => {
    const root = fieldset.closest('[data-report-source], [data-report-defaults]'),
      query = root ? selector => root.querySelector(selector) : $,
      id = fieldset.dataset.reportWindows,
      detailed = overviewSelectedLevels(id, query).some(level => level !== 'campaign'),
      profile = query('[data-report-campaign-profile="' + CSS.escape(id) + '"]');
    profile.closest('[data-report-campaign-profile-field]').hidden = detailed;
    fieldset.hidden = !detailed && !profile.checked;
    fieldset.disabled = fieldset.hidden;
  });
  document.querySelectorAll('[data-report-detail]').forEach(fieldset => {
    const root = fieldset.closest('[data-report-source], [data-report-defaults]'),
      id = fieldset.dataset.reportDetail,
      query = root ? selector => root.querySelector(selector) : $,
      caps = overviewState.bootstrap?.platforms.find(p => p.id === id)?.reporting_v4;
    fieldset.hidden =
      !overviewSelectedLevels(id, query).some(level => level !== 'campaign') &&
      !caps?.requires_complete_window_declaration &&
      !caps?.option_names?.includes('result_action_type');
    fieldset.disabled = fieldset.hidden;
  });
  updateOverviewNativeNotes();
}
