'use strict';
// Preview your ads: the platform's own preview links for ads that already exist (amcp_ad_previews). Links open in a
// new tab; they work for anyone who has them and expire, so the panel says so.

const previewGateways = {
  meta_native_action: 'meta',
  tiktok_native_action: 'tiktok',
  snapchat_native_action: 'snapchat',
  linkedin_native_action: 'linkedin',
  reddit_native_action: 'reddit',
  google_ads_native_action: 'google_ads',
};
const previewFormats = [
  ['MOBILE_FEED_STANDARD', 'Facebook mobile feed'],
  ['DESKTOP_FEED_STANDARD', 'Facebook desktop feed'],
  ['INSTAGRAM_STANDARD', 'Instagram feed'],
  ['INSTAGRAM_STORY', 'Instagram story'],
  ['INSTAGRAM_REELS', 'Instagram Reels'],
  ['FACEBOOK_STORY_MOBILE', 'Facebook story'],
  ['AUDIENCE_NETWORK_OUTSTREAM_VIDEO', 'Audience Network video'],
];

/** The advertising accounts whose ads AMCP can preview, one option each. */
function previewTargets() {
  return platforms.flatMap(p =>
    previewGateways[p.gateway]
      ? p.connections
          .filter(c => c.enabled)
          .flatMap(c =>
            c.accounts.map(a => ({
              platform: previewGateways[p.gateway],
              account_id: a,
              connection_id: c.id,
              label: accountLabel(p, c, a),
            })),
          )
      : [],
  );
}

function adPreviewsPanel() {
  const targets = previewTargets();
  return `<section class="panel workspace-form ad-previews" aria-labelledby="previews-title">
<h2 id="previews-title">${esc(uiText('Preview your ads'))}</h2>
<p class="workspace-copy">${esc(uiText("Get each platform's own preview links for ads that already exist. Anyone with a link can open it, and links expire."))}</p>
<form id="preview-form">
<label>${esc(uiText('Advertising account'))}<select name="target" required>${
    targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('') ||
    `<option value="">${esc(uiText('Connect and select an advertising account first'))}</option>`
  }</select></label>
<label>${esc(uiText('Ad IDs (optional; Snapchat and LinkedIn: creative IDs)'))}<input name="ad_ids" placeholder="${esc(uiText('Leave empty for the first five ads'))}"></label>
<label id="preview-format" hidden>${esc(uiText('Placement'))}<select name="ad_format">${previewFormats
    .map(([v, l]) => `<option value="${v}">${esc(uiText(l))}</option>`)
    .join('')}</select></label>
<button class="button" type="submit">${esc(uiText('Get preview links'))}</button></form>
<div id="preview-results" role="status"></div></section>`;
}

function bindAdPreviews() {
  const targets = previewTargets(),
    form = $('#preview-form');
  if (!form) return;
  const syncFormat = () => {
    $('#preview-format').hidden = targets[Number(form.elements.target.value)]?.platform !== 'meta';
  };
  form.addEventListener('change', syncFormat);
  syncFormat();
  workspaceBind('#preview-form', async f => {
    const target = targets[Number(f.elements.target.value)];
    if (!target) throw Error(uiText('Connect and select an advertising account first.'));
    const ids = f.elements.ad_ids.value
      .split(/[\s,]+/)
      .map(s => s.trim())
      .filter(Boolean);
    $('#preview-results').innerHTML =
      `<p class="form-note">${esc(uiText('Reading the account’s ads and their previews…'))}</p>`;
    try {
      const r = await workspaceCall('previews', {
        platform: target.platform,
        account_id: target.account_id,
        connection_id: target.connection_id,
        ...(ids.length ? {ad_ids: ids.slice(0, 10)} : {}),
        ...(target.platform === 'meta' ? {ad_format: f.elements.ad_format.value} : {}),
      });
      $('#preview-results').innerHTML = previewResults(r);
    } catch (e) {
      $('#preview-results').innerHTML =
        `<p class="form-note">${esc(uiText('No previews:'))} ${esc(errorMessage(e))}</p>`;
      throw e;
    }
  });
}

function previewResults(r) {
  if (r.explanation)
    return `<p>${esc(r.explanation)}</p>${r.next_call ? recordDetails(r.next_call, uiText('The reviewed call that creates it')) : ''}${r.next_step ? `<p class="form-note">${esc(r.next_step)}</p>` : ''}`;
  const rows = r.previews
    .map(p => {
      const links = p.links.length
        ? p.links
            .map(
              (url, i) =>
                `<a class="button small" href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(
                  uiText('Open preview {number} of {name} in a new tab', {
                    number: p.links.length > 1 ? i + 1 : '',
                    name: p.name ?? p.ad_id,
                  }),
                )}">${esc(uiText('Open preview'))}${p.links.length > 1 ? ' ' + (i + 1) : ''} ↗</a>`,
            )
            .join(' ')
        : `<span class="form-note">${esc(p.error?.message ?? p.note ?? uiText('The platform returned no preview link for this ad.'))}</span>`;
      const when = p.expires_at
        ? uiText(' · link expires {date}', {date: date(p.expires_at)})
        : p.expires
          ? ' · ' + p.expires
          : '';
      return `<div class="token-row"><div><strong>${esc(p.name ?? uiText('Untitled'))}</strong><small>${esc(p.ad_id)}${esc(when)}</small></div><div class="preview-links">${links}</div></div>`;
    })
    .join('');
  const missing = r.not_found?.length
    ? `<p class="form-note">${esc(uiText('Not found:'))} ${esc(r.not_found.join(', '))}. ${esc(r.not_found_reason ?? '')}</p>`
    : '';
  return (
    (rows || blank(uiText('The account has no ads to preview.'))) +
    missing +
    `<p class="form-note">${esc(r.meaning)}</p>`
  );
}
