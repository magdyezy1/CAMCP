'use strict';
function bindReportPresentation(pack, id) {
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
    await renderReportPack();
    toast('Report presentation saved.');
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
}
