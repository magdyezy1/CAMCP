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

/**
 * The advertising accounts whose ads AMCP can preview, one option each, narrowed to the working client (SEC-08), and
 * the account to preselect only when exactly one remains (before, the first account of any client was).
 */
function previewTargets() {
  const narrow =
    typeof clientAccountOptions === 'function'
      ? clientAccountOptions
      : list => ({options: list, preselect: list.length === 1 ? list[0] : null});
  return narrow(
    platforms.flatMap(p =>
      previewGateways[p.gateway]
        ? p.connections
            .filter(c => c.enabled)
            .flatMap(c =>
              c.accounts.map(a => ({
                platform: previewGateways[p.gateway],
                gateway: p.gateway,
                account_id: a,
                connection_id: c.id,
                label: accountLabel(p, c, a),
              })),
            )
        : [],
    ),
  );
}

/** No account to offer: the working client hid them all (SEC-08), or none is connected and selected yet. */
const previewNoTarget = hidden =>
  hidden && typeof workingClientEmptyNotice === 'function'
    ? workingClientEmptyNotice()
    : uiText('Connect and select an advertising account first.');

function adPreviewsPanel() {
  const {options: targets, preselect, hidden} = previewTargets();
  return `<section class="panel workspace-form ad-previews" aria-labelledby="previews-title">
<h2 id="previews-title">${esc(uiText('Preview your ads'))}</h2>
<p class="workspace-copy">${esc(uiText("Get each platform's own preview links for ads that already exist. Anyone with a link can open it, and links expire."))}</p>
<form id="preview-form">
<label>${esc(uiText('Advertising account'))}<select name="target" required>${
    (targets.length && !preselect
      ? `<option value="" selected disabled>${esc(uiText('Choose an account'))}</option>`
      : '') +
      targets
        .map((t, i) => `<option value="${esc(i)}" ${t === preselect ? 'selected' : ''}>${esc(t.label)}</option>`)
        .join('') ||
    (hidden
      ? `<option value="">${esc(previewNoTarget(hidden))}</option>`
      : `<option value="">${esc(uiText('Connect and select an advertising account first'))}</option>`)
  }</select></label>
<label>${esc(uiText('Ad IDs (optional; Snapchat and LinkedIn: creative IDs)'))}<input name="ad_ids" placeholder="${esc(uiText('Leave empty for the first five ads'))}"></label>
<label>${esc(uiText('Status'))}<select name="statuses">${['active', 'paused', 'archived', 'all'].map((value, index) => `<option value="${esc(value)}">${esc(uiText(['Active', 'Paused', 'Archived', 'All'][index]))}</option>`).join('')}</select></label>
<label id="preview-format" hidden>${esc(uiText('Placement'))}<select name="ad_format">${previewFormats
    .map(([v, l]) => `<option value="${esc(v)}">${esc(uiText(l))}</option>`)
    .join('')}</select></label>
<button class="button" type="submit">${esc(uiText('Get preview links'))}</button></form>
<div id="preview-results"></div>
<p id="preview-status" class="form-note" role="status"></p></section>`;
}

/**
 * The previews list sits in the results region as rows and a footer (the notes under the rows, and Load more). Load more
 * appends the new rows to the rows and writes the footer again; the rows already read stay as they are, their place
 * (and the reader's) with them. The short message in the status line is the only thing a screen reader is told of a page.
 */
function bindAdPreviews() {
  const {options: targets, hidden} = previewTargets(),
    form = $('#preview-form');
  if (!form) return;
  // An empty choice is no account: Number('') would have picked the first one.
  const chosen = value => (value === '' ? undefined : targets[Number(value)]);
  let generation = 0,
    selection = null,
    accumulated = [],
    pending = false;
  const say = message => {
    $('#preview-status').textContent = message;
  };
  const reset = () => {
    generation++;
    selection = null;
    accumulated = [];
    pending = false;
    $('#preview-results').textContent = '';
    say('');
  };
  const syncFormat = () => {
    $('#preview-format').hidden = chosen(form.elements.target.value)?.platform !== 'meta';
    reset();
  };
  form.addEventListener('change', syncFormat);
  form.addEventListener('input', reset);
  syncFormat();
  // A button that is busy stays focusable (a disabled one drops the reader's place); its click is ignored meanwhile.
  const busy = on => $('#preview-load-more')?.setAttribute?.('aria-disabled', on ? 'true' : 'false');
  /** A later page that fails keeps the rows read and says so beside Load more, with the way to start again. */
  const failedMore = e => {
    const box = $('#preview-more-error'),
      restart = $('#preview-restart');
    if (box) box.textContent = errorMessage(e);
    if (restart) restart.hidden = false;
  };
  const load = async (args, more = false) => {
    const version = generation;
    pending = true;
    busy(true);
    if (more) {
      const box = $('#preview-more-error'),
        restart = $('#preview-restart');
      if (box) box.textContent = '';
      if (restart) restart.hidden = true;
      say(uiText('Reading the account’s ads and their previews…'));
    }
    try {
      const r = await workspaceCall('previews', args);
      if (version !== generation) return;
      const first = more ? accumulated.length : 0,
        seen = new Set(more ? accumulated.map(p => p.source_ad_id ?? p.ad_id) : []),
        fresh = (r.previews ?? []).filter(p => {
          const key = p.source_ad_id ?? p.ad_id;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      accumulated = (more ? accumulated : []).concat(fresh);
      selection = {args: {...args, cursor: undefined}, cursor: r.has_more ? r.next_cursor : null};
      if (more) {
        insertHtml($('#preview-rows'), 'beforeend', previewRows(fresh, first));
        setHtml($('#preview-footer'), previewFooter(r));
        // The reader's place moves to the first new row, not to the top of the page.
        if (fresh.length) $('#preview-row-' + first)?.focus();
        say(uiPlural(fresh.length, '{count} more preview', '{count} more previews'));
      } else {
        setHtml($('#preview-results'), previewMarkup({...r, previews: fresh}));
        say(
          r.explanation
            ? ''
            : fresh.length
              ? uiPlural(fresh.length, '{count} preview', '{count} previews')
              : uiText('No ads match this preview selection.'),
        );
      }
    } catch (e) {
      if (version !== generation) return;
      if (more) {
        failedMore(e);
        say('');
      } else {
        setHtml($('#preview-results'), html`<p class="form-note">${uiText('No previews:')} ${errorMessage(e)}</p>`);
        say('');
      }
      throw e;
    } finally {
      if (version === generation) {
        pending = false;
        busy(false);
      }
    }
  };
  $('#preview-results').addEventListener('click', event => {
    if (pending || !selection) return;
    if (event.target.closest('#preview-load-more')) {
      if (selection.cursor) void load({...selection.args, cursor: selection.cursor}, true).catch(() => {});
    } else if (event.target.closest('#preview-restart')) {
      // Start again: the same selection from its first page, in place of the rows read so far.
      const args = selection.args;
      reset();
      say(uiText('Reading the account’s ads and their previews…'));
      void load(args).catch(() => {});
    }
  });
  workspaceBind('#preview-form', async f => {
    const target = chosen(f.elements.target.value);
    if (!targets.length) throw Error(previewNoTarget(hidden));
    if (!target) throw Error(uiText('Choose the advertising account to preview.'));
    const ids = f.elements.ad_ids.value
      .split(/[\s,]+/)
      .map(s => s.trim())
      .filter(Boolean);
    reset();
    say(uiText('Reading the account’s ads and their previews…'));
    await load({
      platform: target.platform,
      account_id: target.account_id,
      connection_id: target.connection_id,
      statuses: [f.elements.statuses?.value ?? 'active'],
      ...(ids.length ? {ad_ids: ids.slice(0, 10)} : {}),
      ...(target.platform === 'meta' ? {ad_format: f.elements.ad_format.value} : {}),
    });
  });
}

/**
 * A link is opened only when it is an https link without credentials. The server returns no other, so this keeps a
 * value that is not one from becoming an href at all (design note 7); it is the same rule, written once more at the
 * page where the value becomes a link.
 */
const previewHref = url => (typeof url === 'string' && /^https:\/\/[^\s/?#@\\]+(?:[/?#]\S*)?$/i.test(url) ? url : null);

/** One ad's row: its name, which ad and creative it is, when its links expire, and the links (or why there are none). */
function previewRow(p, index) {
  const hrefs = (p.links ?? []).map(previewHref).filter(Boolean),
    when = p.expires_at
      ? uiText(' · link expires {date}', {date: date(p.expires_at)})
      : p.expires
        ? ' · ' + uiText(p.expires)
        : '';
  return html`<div class="token-row" id="preview-row-${index}" tabindex="-1"><div><strong>${p.name ?? uiText('Untitled')}</strong><small>${p.source_ad_id ? uiText('Ad {ad} · Creative {creative}', {ad: p.source_ad_id, creative: p.ad_id}) : p.ad_id}${when}</small></div><div class="preview-links">${
    hrefs.length
      ? hrefs.map(
          // WCAG 2.5.3: the name opens with the words the link shows ("Open preview", and its number when there are
          // several), so the sentence is one message with the number and one without: no gap where it would be.
          (url, i) =>
            html`<a class="button small" href="${url}" target="_blank" rel="noopener noreferrer" aria-label="${hrefs.length > 1 ? uiText('Open preview {number} of {name} in a new tab', {number: i + 1, name: p.name ?? p.ad_id}) : uiText('Open preview of {name} in a new tab', {name: p.name ?? p.ad_id})}">${uiText('Open preview')}${hrefs.length > 1 ? ' ' + (i + 1) : ''} ↗</a> `,
        )
      : p.error && typeof renderSourceDiagnostic === 'function'
        ? // V2-RPT-05: the provider's own refusal (message, request ID) through the shell's diagnostic renderer.
          raw(renderSourceDiagnostic(p.error))
        : html`<span class="form-note">${p.error?.message ?? uiText(p.note ?? 'The platform returned no preview link for this ad.')}</span>`
  }</div></div>`;
}

/** The rows of `list`, numbered from `first` (the number of rows before them), as markup. */
const previewRows = (list, first) => html`${list.map((p, i) => previewRow(p, first + i))}`;

/** What follows the rows: the IDs not found, the notices, and Load more with the place its failure is told. */
function previewFooter(r) {
  return html`${
    r.not_found?.length
      ? html`<p class="form-note">${uiText('Not found:')} ${r.not_found.join(', ')}. ${uiText(r.not_found_reason ?? '')}</p>`
      : ''
  }<p class="form-note">${uiText(r.meaning)}</p>${r.selection_note ? html`<p class="form-note">${uiText(r.selection_note)}</p>` : ''}${
    r.has_more && r.next_cursor
      ? html`<div class="preview-more"><button class="button" id="preview-load-more" type="button">${uiText('Load more')}</button><p class="error" id="preview-more-error" role="alert"></p><button class="button small" id="preview-restart" type="button" hidden>${uiText('Start again')}</button></div>`
      : ''
  }`;
}

/** The whole answer: the rows, then the footer (or the explanation of a platform whose previews AMCP cannot read). */
const previewMarkup = r =>
  r.explanation
    ? html`<p>${uiText(r.explanation)}</p>${r.next_call ? raw(recordDetails(r.next_call, uiText('The reviewed call that creates it'))) : ''}${r.next_step ? html`<p class="form-note">${uiText(r.next_step)}</p>` : ''}`
    : html`<div id="preview-rows">${r.previews.length ? previewRows(r.previews, 0) : html`<div class="empty">${uiText('No ads match this preview selection.')}</div>`}</div><div id="preview-footer">${previewFooter(r)}</div>`;
/** The same as text, for a caller that wants the markup rather than to write it. */
const previewResults = r => String(previewMarkup(r));
