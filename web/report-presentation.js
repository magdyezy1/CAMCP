'use strict';
async function bindReportPresentation(pack, id) {
  const style = pack.presentation ?? {brand_name: '', accent_color: '#354B67', footer: '', template: 'standard'},
    readOnly = session.workspaceRole === 'viewer',
    generation = navigationGeneration,
    identity = identityGeneration;
  const report = content.querySelector('.report-pack'),
    current = () => generation === navigationGeneration && identity === identityGeneration && report.isConnected;
  report.insertAdjacentHTML(
    'beforebegin',
    `<details class="panel workspace-form report-pack-actions"><summary>${esc(uiText('Client branding and download layout'))}</summary><form id="report-presentation"><div class="work-filter"><label>${esc(uiText('Client brand name'))}<input name="brand_name" maxlength="100" value="${esc(style.brand_name)}" ${readOnly ? 'disabled' : ''}></label><label>${esc(uiText('Accent color'))}<input name="accent_color" type="color" value="${esc(style.accent_color)}" ${readOnly ? 'disabled' : ''}></label><label>${esc(uiText('PDF layout'))}<select name="template" ${readOnly ? 'disabled' : ''}><option value="standard" ${style.template === 'standard' ? 'selected' : ''}>${esc(uiText('Standard spacing'))}</option><option value="compact" ${style.template === 'compact' ? 'selected' : ''}>${esc(uiText('Compact spacing'))}</option></select></label></div><label>${esc(uiText('Footer'))}<input name="footer" maxlength="200" value="${esc(style.footer)}" ${readOnly ? 'disabled' : ''}></label><p class="form-note">${esc(uiText('Branding belongs to this snapshot. Excel includes all campaign rows, separate account summaries and source evidence. PDF presents measurement summaries with embedded evidence. Each download checks current account access.'))}</p><label class="form-note"><input type="checkbox" name="confirmed" required ${readOnly ? 'disabled' : ''}> ${esc(uiText('Save these presentation settings'))}</label><button class="button primary" type="submit" ${readOnly ? 'disabled' : ''}>${esc(uiText('Save presentation'))}</button></form></details>`,
  );
  const presentationForm = $('#report-presentation');
  let presentationVersion = 0;
  const invalidate = event => {
    if (!current() || event.target === presentationForm.elements.confirmed) return;
    presentationVersion++;
    presentationForm.elements.confirmed.checked = false;
  };
  presentationForm.addEventListener('input', invalidate);
  presentationForm.addEventListener('change', invalidate);
  workspaceBind('#report-presentation', async form => {
    if (!current() || !form.isConnected) return;
    const version = presentationVersion,
      active = () => current() && form.isConnected && version === presentationVersion;
    const {confirmed, ...presentation} = Object.fromEntries(new FormData(form));
    try {
      await overviewCall({
        action: 'save_presentation',
        id,
        presentation,
        presentation_revision: pack.presentation_revision ?? 0,
        confirmed: confirmed === 'on',
      });
    } catch (error) {
      if (active()) throw error;
      return;
    }
    if (!active()) return;
    if (await renderReportPack(true)) toast(uiText('Report presentation saved.'));
  });
  for (const format of ['pdf', 'xlsx'])
    workspaceBind('#download-pack-' + format, async () => {
      if (!current()) return;
      let blob;
      try {
        const response = await fetch('/api/reporting-overview/' + encodeURIComponent(id) + '.' + format, {
          cache: 'no-store',
        });
        if (!response.ok) {
          let message = uiText('Report download failed.');
          try {
            message = errorMessage(requestError(await response.json(), message));
          } catch {}
          throw Error(message);
        }
        blob = await response.blob();
      } catch (error) {
        if (current()) throw error;
        return;
      }
      if (!current()) return;
      const url = URL.createObjectURL(blob),
        link = document.createElement('a');
      link.href = url;
      link.download = 'AMCP-report-pack.' + format;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(uiText('Report {format} prepared for download.', {format: format.toUpperCase()}));
    });
  if (pack.presentation_source) {
    const source = pack.presentation_source;
    report.insertAdjacentHTML(
      'beforebegin',
      `<p class="form-note report-pack-actions">${esc(uiText('Branding copied from {name}, approved revision {revision}. Later profile edits do not change this snapshot.', {name: source.profile_name, revision: source.profile_revision}))}</p>`,
    );
  }
  await mountReportProfileBranding(pack, id, report, current);
}
async function mountReportProfileBranding(pack, id, report, current) {
  const readOnly = session.workspaceRole === 'viewer';
  report.insertAdjacentHTML(
    'beforebegin',
    `<details class="panel workspace-form report-pack-actions" id="report-profile-branding"><summary>${esc(uiText('Use approved client branding'))}</summary><p>${esc(uiText('Choose a compatible client profile. Applying copies its exact approved revision; future profile changes leave this snapshot unchanged.'))}</p><p><a href="/profiles">${esc(uiText('Create or edit a client profile'))}</a></p><div id="report-branding-choices"></div><form id="apply-profile-branding"><label>${esc(uiText('Approved client profile'))}<select name="profile_id" required ${readOnly ? 'disabled' : ''}><option value="">${esc(uiText('Choose explicitly'))}</option></select></label><div id="selected-profile-branding"></div><label class="form-note"><input type="checkbox" name="confirmed" required ${readOnly ? 'disabled' : ''}> ${esc(uiText('Replace this snapshot’s presentation with the selected approved branding'))}</label><button type="submit" class="button primary" ${readOnly ? 'disabled' : ''}>${esc(uiText('Apply approved branding'))}</button></form></details>`,
  );
  const root = $('#report-profile-branding'),
    form = $('#apply-profile-branding');
  let profiles = [],
    selection = 0;
  const chosen = () => profiles.find(p => p.id === form.elements.profile_id.value);
  const resetPreview = () => {
    selection++;
    form.elements.confirmed.checked = false;
    const p = chosen();
    root.querySelector('#selected-profile-branding').innerHTML = p
      ? `<section class="branding-preview" aria-label="${esc(uiText('Selected approved report branding'))}"><h3>${esc(p.name)}</h3><p class="form-note">${esc(uiText('Approved revision {revision}', {revision: p.revision}))}</p><dl>${[
          [uiText('Brand name'), p.presentation.brand_name || pack.client_name || uiText('Performance report')],
          [uiText('Accent color'), p.presentation.accent_color],
          [
            uiText('PDF layout'),
            p.presentation.template === 'compact' ? uiText('Compact spacing') : uiText('Standard spacing'),
          ],
          [uiText('Footer'), p.presentation.footer || uiText('No custom footer')],
        ]
          .map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`)
          .join('')}</dl></section>`
      : '';
  };
  form.elements.profile_id.addEventListener('change', resetPreview);
  const pages = workPageLoader(
    '#report-branding-choices',
    uiText('Compatible client profiles'),
    async offset => {
      const r = await overviewCall({action: 'presentation_profiles', id, offset: offset ?? 0, limit: 10});
      return {...r, next_cursor: r.next_offset};
    },
    r =>
      r.profiles.length
        ? `<p>${esc(uiText('Approved profiles on this page: {count}. Each profile covers all report accounts or has no account restrictions.', {count: uiNumber(r.profiles.length)}))}</p>`
        : blank(uiText('No compatible approved branding on this page. Add report branding to a client profile.')),
    r => {
      if (!current() || !root.isConnected) return;
      profiles = r.profiles;
      form.elements.profile_id.innerHTML =
        `<option value="">${esc(uiText('Choose explicitly'))}</option>` +
        profiles
          .map(
            p =>
              `<option value="${esc(p.id)}">${esc(uiText('{name} · revision {revision}', {name: p.name, revision: p.revision}))}</option>`,
          )
          .join('');
      resetPreview();
    },
  );
  workspaceBind('#apply-profile-branding', async () => {
    if (!current() || !root.isConnected || !form.isConnected) return;
    const version = selection,
      active = () => current() && root.isConnected && form.isConnected && version === selection;
    const p = chosen();
    if (!p) throw Error(uiText('Choose an approved client profile.'));
    try {
      await overviewCall({
        action: 'apply_profile_presentation',
        id,
        profile_id: p.id,
        profile_revision: p.revision,
        presentation_revision: pack.presentation_revision ?? 0,
        confirmed: form.elements.confirmed.checked,
      });
    } catch (error) {
      if (active()) throw error;
      return;
    }
    if (!active()) return;
    if (await renderReportPack(true)) toast(uiText('Approved client branding copied to this report pack.'));
  });
  await pages.load();
}
