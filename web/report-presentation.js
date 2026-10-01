'use strict';
async function bindReportPresentation(pack, id) {
  const style = pack.presentation ?? {brand_name: '', accent_color: '#354B67', footer: '', template: 'standard'},
    readOnly = session.workspaceRole === 'viewer',
    generation = navigationGeneration,
    identity = identityGeneration;
  const report = content.querySelector('.report-pack');
  report.insertAdjacentHTML(
    'beforebegin',
    `<details class="panel workspace-form report-pack-actions"><summary>Client branding and download layout</summary><form id="report-presentation"><div class="work-filter"><label>Client brand name<input name="brand_name" maxlength="100" value="${esc(style.brand_name)}" ${readOnly ? 'disabled' : ''}></label><label>Accent color<input name="accent_color" type="color" value="${esc(style.accent_color)}" ${readOnly ? 'disabled' : ''}></label><label>PDF layout<select name="template" ${readOnly ? 'disabled' : ''}><option value="standard" ${style.template === 'standard' ? 'selected' : ''}>Standard spacing</option><option value="compact" ${style.template === 'compact' ? 'selected' : ''}>Compact spacing</option></select></label></div><label>Footer<input name="footer" maxlength="200" value="${esc(style.footer)}" ${readOnly ? 'disabled' : ''}></label><p class="form-note">Branding belongs to this snapshot. Excel includes all campaign rows, separate account summaries and source evidence. PDF presents measurement summaries with embedded evidence. Each download checks current account access.</p><label class="form-note"><input type="checkbox" name="confirmed" required ${readOnly ? 'disabled' : ''}> Save these presentation settings</label><button class="button primary" type="submit" ${readOnly ? 'disabled' : ''}>Save presentation</button></form></details>`,
  );
  workspaceBind('#report-presentation', async form => {
    const {confirmed, ...presentation} = Object.fromEntries(new FormData(form));
    await overviewCall({
      action: 'save_presentation',
      id,
      presentation,
      presentation_revision: pack.presentation_revision ?? 0,
      confirmed: confirmed === 'on',
    });
    if (generation !== navigationGeneration || identity !== identityGeneration || !report.isConnected) return;
    if (await renderReportPack(true)) toast('Report presentation saved.');
  });
  for (const format of ['pdf', 'xlsx'])
    workspaceBind('#download-pack-' + format, async () => {
      const response = await fetch('/api/reporting-overview/' + encodeURIComponent(id) + '.' + format, {
        cache: 'no-store',
      });
      if (!response.ok) {
        let message = 'Report download failed.';
        try {
          message = errorMessage(requestError(await response.json(), message));
        } catch {}
        throw Error(message);
      }
      const blob = await response.blob();
      if (generation !== navigationGeneration || identity !== identityGeneration || !report.isConnected) return;
      const url = URL.createObjectURL(blob),
        link = document.createElement('a');
      link.href = url;
      link.download = 'AMCP-report-pack.' + format;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Report ' + format.toUpperCase() + ' prepared for download.');
    });
  if (pack.presentation_source) {
    const source = pack.presentation_source;
    report.insertAdjacentHTML(
      'beforebegin',
      `<p class="form-note report-pack-actions">Branding copied from ${esc(source.profile_name)}, approved revision ${esc(source.profile_revision)}. Later profile edits do not change this snapshot.</p>`,
    );
  }
  await mountReportProfileBranding(
    pack,
    id,
    report,
    () => generation === navigationGeneration && identity === identityGeneration && report.isConnected,
  );
}
async function mountReportProfileBranding(pack, id, report, current) {
  const readOnly = session.workspaceRole === 'viewer';
  report.insertAdjacentHTML(
    'beforebegin',
    `<details class="panel workspace-form report-pack-actions" id="report-profile-branding"><summary>Use approved client branding</summary><p>Choose a compatible client profile. Applying copies its exact approved revision; future profile changes leave this snapshot unchanged.</p><p><a href="/profiles">Create or edit a client profile</a></p><div id="report-branding-choices"></div><form id="apply-profile-branding"><label>Approved client profile<select name="profile_id" required ${readOnly ? 'disabled' : ''}><option value="">Choose explicitly</option></select></label><div id="selected-profile-branding"></div><label class="form-note"><input type="checkbox" name="confirmed" required ${readOnly ? 'disabled' : ''}> Replace this snapshot’s presentation with the selected approved branding</label><button type="submit" class="button primary" ${readOnly ? 'disabled' : ''}>Apply approved branding</button></form></details>`,
  );
  const root = $('#report-profile-branding'),
    form = $('#apply-profile-branding');
  let profiles = [];
  const chosen = () => profiles.find(p => p.id === form.elements.profile_id.value);
  const resetPreview = () => {
    form.elements.confirmed.checked = false;
    const p = chosen();
    root.querySelector('#selected-profile-branding').innerHTML = p
      ? `<section class="branding-preview" aria-label="Selected approved report branding"><h3>${esc(p.name)}</h3><p class="form-note">Approved revision ${esc(p.revision)}</p><dl>${[
          ['Brand name', p.presentation.brand_name || pack.client_name || 'Performance report'],
          ['Accent color', p.presentation.accent_color],
          ['PDF layout', p.presentation.template === 'compact' ? 'Compact spacing' : 'Standard spacing'],
          ['Footer', p.presentation.footer || 'No custom footer'],
        ]
          .map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`)
          .join('')}</dl></section>`
      : '';
  };
  form.elements.profile_id.addEventListener('change', resetPreview);
  const pages = workPageLoader(
    '#report-branding-choices',
    'Compatible client profiles',
    async offset => {
      const r = await overviewCall({action: 'presentation_profiles', id, offset: offset ?? 0, limit: 10});
      return {...r, next_cursor: r.next_offset};
    },
    r =>
      r.profiles.length
        ? `<p>${r.profiles.length} approved ${r.profiles.length === 1 ? 'profile' : 'profiles'} on this page. Each profile covers all report accounts or has no account restrictions.</p>`
        : blank('No compatible approved branding on this page. Add report branding to a client profile.'),
    r => {
      if (!current() || !root.isConnected) return;
      profiles = r.profiles;
      form.elements.profile_id.innerHTML =
        '<option value="">Choose explicitly</option>' +
        profiles
          .map(p => `<option value="${esc(p.id)}">${esc(p.name)} · revision ${esc(p.revision)}</option>`)
          .join('');
      resetPreview();
    },
  );
  workspaceBind('#apply-profile-branding', async () => {
    const p = chosen();
    if (!p) throw Error('Choose an approved client profile.');
    await overviewCall({
      action: 'apply_profile_presentation',
      id,
      profile_id: p.id,
      profile_revision: p.revision,
      presentation_revision: pack.presentation_revision ?? 0,
      confirmed: form.elements.confirmed.checked,
    });
    if (!current() || !root.isConnected) return;
    if (await renderReportPack(true)) toast('Approved client branding copied to this report pack.');
  });
  await pages.load();
}
