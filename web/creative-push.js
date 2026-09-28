'use strict';
// Push a creative: upload an image or video once (or import it from a public link), choose the advertising accounts it
// goes to, and review what each account receives (amcp_media plan: the exact file and every change AMCP makes). After
// one confirmation each account gets an ordinary reviewed amcp_media prepare, bound to the planned file by its SHA-256,
// and execute, one account at a time, so the workspace never holds more than one staged review for the push.

const pushSize = bytes =>
  bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MiB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
const pushKind = mime =>
  ({'image/png': 'PNG', 'image/jpeg': 'JPEG', 'video/mp4': 'MP4', 'video/quicktime': 'MOV'})[mime] ?? mime;
const pushFacts = s =>
  [
    pushKind(s.mime),
    s.width ? s.width + ' × ' + s.height : '',
    s.duration ? Math.round(s.duration) + ' s' : '',
    pushSize(s.size),
  ]
    .filter(Boolean)
    .join(' · ');
const pushSourceUrl = id => '/api/media/sources/' + encodeURIComponent(id);

/** Sends a file to AMCP in the parts the server asks for, retrying a part twice on a network error or a busy server. */
async function uploadCreative(file, progress) {
  const started = await api('/api/media/sources', {
    method: 'POST',
    body: JSON.stringify({filename: file.name, size: file.size, type: file.type}),
  });
  for (let index = 0; index < started.chunks; index++) {
    const part = file.slice(index * started.chunk_bytes, (index + 1) * started.chunk_bytes);
    for (let attempt = 0; ; attempt++) {
      try {
        await api(pushSourceUrl(started.source_id) + '/parts/' + index, {
          method: 'PUT',
          body: part,
          headers: {'Content-Type': 'application/octet-stream'},
        });
        break;
      } catch (e) {
        if (attempt >= 2 || (e.code !== undefined && e.code !== 'MEDIA_PARTS_BUSY')) throw e;
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
    progress(index + 1, started.chunks);
  }
  progress(started.chunks, started.chunks, 'Checking the file…');
  return api(pushSourceUrl(started.source_id) + '/complete', {method: 'POST'});
}

/** The panel's markup; `targets` are the advertising accounts the member can upload media to. */
function creativePushPanel(targets, recent) {
  return `<section class="panel workspace-form creative-push" aria-labelledby="push-title">
<h2 id="push-title">Push a creative</h2>
<p class="workspace-copy">Upload an image or video once, choose the accounts it goes to, review each upload, then push. No Google Drive needed.</p>
<div class="push-step"><h3>1. Your file</h3>
<form id="push-upload"><label>Image or video<input type="file" name="file" accept="image/png,image/jpeg,video/mp4,video/quicktime" required></label><button class="button" type="submit">Upload</button></form>
<form id="push-link"><label>Or a public link to the file<input type="url" name="url" inputmode="url" placeholder="https://" required></label><button class="button" type="submit">Import from the link</button></form>
<p class="form-note">PNG, JPEG, MP4 or MOV. AMCP keeps the file encrypted for 30 minutes, then deletes it.</p>
${
  recent.length
    ? `<div class="push-recent"><p class="form-note">Or use a recent upload:</p>${recent
        .map(
          s =>
            `<button class="button small" type="button" data-push-source="${esc(s.source_id)}">${esc(s.filename)} · ${esc(pushFacts(s))} · ${esc(new Date(s.uploaded_at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}))}</button>`,
        )
        .join('')}</div>`
    : ''
}
<progress id="push-bar" class="push-bar" max="1" value="0" hidden></progress>
<p id="push-status" class="form-note" role="status"></p>
<div id="push-file"></div></div>
<form id="push-review" class="push-step" hidden><h3>2. Where it goes</h3>
<fieldset class="push-targets"><legend>Advertising accounts</legend>${
    targets
      .map(
        (t, i) =>
          `<label><input type="checkbox" name="target" value="${i}"> ${esc(t.label)}</label>`,
      )
      .join('') || '<p class="form-note">Connect an advertising account and select it first.</p>'
  }</fieldset>
<label id="push-owner" hidden>LinkedIn video owner: the organization URN of the page that posts it<input name="owner_urn" placeholder="urn:li:organization:123"></label>
<label>Media name<input name="name" maxlength="80" required></label>
<label class="form-note"><input type="checkbox" name="fit" checked> Fit to each platform: scale down anything larger than 1080 × 1920 (never cropped or enlarged), re-encode an image above a platform's size limit, convert MOV to MP4 for X and LinkedIn.</label>
<button class="button primary" type="submit">Review the push</button></form>
<div id="push-reviews"></div></section>`;
}

/** Wires the panel after it is on the page. */
function bindCreativePush(targets) {
  let source = null,
    rows = [];
  const status = (text, done, total) => {
    $('#push-status').textContent = text;
    $('#push-bar').hidden = total === undefined;
    if (total !== undefined) {
      $('#push-bar').max = total;
      $('#push-bar').value = done;
    }
  };
  const showSource = s => {
    source = s;
    rows = [];
    $('#push-reviews').innerHTML = '';
    $('#push-file').innerHTML = `<div class="push-file">${
      s.thumbnail_url ? `<img src="${esc(s.thumbnail_url)}" alt="Preview of ${esc(s.filename)}">` : ''
    }<div><strong>${esc(s.filename)}</strong><p class="form-note">${esc(pushFacts(s))} · kept until ${date(s.expires_at)}</p><button class="button small" type="button" id="push-remove">Remove this file</button></div></div>`;
    const form = $('#push-review');
    form.hidden = false;
    form.elements.name.value = s.filename.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[\\/\x00-\x1f]/g, ' ').slice(0, 80) || 'AMCP media';
    ownerField();
    workspaceBind('#push-remove', async () => {
      await api(pushSourceUrl(s.source_id), {method: 'DELETE'});
      source = null;
      $('#push-file').innerHTML = '';
      $('#push-review').hidden = true;
      $('#push-reviews').innerHTML = '';
      status('The file was removed.');
    });
  };
  const ownerField = () => {
    const form = $('#push-review'),
      linkedin = [...form.querySelectorAll('input[name=target]:checked')].some(
        box => targets[Number(box.value)]?.platform === 'linkedin',
      );
    $('#push-owner').hidden = !(source?.kind === 'video' && linkedin);
  };
  $('#push-review').addEventListener('change', ownerField);
  workspaceBind('#push-upload', async form => {
    const file = form.elements.file.files[0];
    if (!file) throw Error('Choose a file first.');
    status('Uploading ' + file.name + '…', 0, 1);
    try {
      showSource(
        await uploadCreative(file, (done, total, text) =>
          status(text ?? 'Uploading ' + file.name + ': part ' + done + ' of ' + total, done, total),
        ),
      );
      status(file.name + ' is ready. Choose where it goes.');
    } catch (e) {
      status('The upload stopped: ' + e.message);
      throw e;
    }
  });
  workspaceBind('#push-link', async form => {
    status('Importing the file from the link…');
    showSource(
      await api('/api/media/sources/link', {method: 'POST', body: JSON.stringify({url: form.elements.url.value})}),
    );
    status('The file is ready. Choose where it goes.');
  });
  workspaceBind('[data-push-source]', async button => {
    const all = (await api('/api/media/sources')).sources,
      chosen = all.find(s => s.source_id === button.dataset.pushSource && s.state === 'complete');
    if (!chosen) throw Error('That upload expired. Upload the file again.');
    showSource(chosen);
    status(chosen.filename + ' is ready. Choose where it goes.');
  });
  workspaceBind('#push-review', async form => {
    if (!source) throw Error('Upload a file first.');
    const chosen = [...form.querySelectorAll('input[name=target]:checked')].map(box => targets[Number(box.value)]);
    if (!chosen.length) throw Error('Choose at least one advertising account.');
    const owner = form.elements.owner_urn.value.trim(),
      fit = form.elements.fit.checked,
      name = form.elements.name.value.trim();
    const destination = target => ({
      platform: target.platform,
      account_id: target.account_id,
      connection_id: target.connection_id,
      ...(target.platform === 'linkedin' && source.kind === 'video' && owner ? {owner_urn: owner} : {}),
    });
    status('Working out what each account receives…');
    const plan = await workspaceCall('media', {
      action: 'plan',
      source_id: source.source_id,
      fit_to_platform: fit,
      destinations: chosen.map(destination),
    });
    rows = plan.destinations.map((p, i) => ({
      target: chosen[i],
      destination: destination(chosen[i]),
      name,
      fit,
      state: p.ready ? 'ready' : 'refused',
      file: p.file,
      transform: p.transform,
      error: p.error?.message,
    }));
    drawRows();
    const ready = rows.filter(r => r.state === 'ready').length;
    status(ready + ' of ' + rows.length + (rows.length === 1 ? ' account is' : ' accounts are') + ' ready for your review.');
    $('#push-reviews-title')?.focus();
  });
  const drawRows = () => {
    const ready = rows.filter(r => r.state === 'ready');
    $('#push-reviews').innerHTML = `<div class="push-step"><h3 id="push-reviews-title" tabindex="-1">3. Review and push</h3>
<div class="push-table-wrap" tabindex="0" role="region" aria-labelledby="push-reviews-title"><table class="push-table" aria-labelledby="push-reviews-title">
<thead><tr><th scope="col">Account</th><th scope="col">File it receives</th><th scope="col">What AMCP changes</th><th scope="col">Status</th></tr></thead>
<tbody>${rows.map(pushRow).join('')}</tbody></table></div>
${
  ready.length && !rows.some(r => ['waiting', 'pushing'].includes(r.state))
    ? `<p class="form-note">Each account then gets its own review, bound to exactly the file shown; AMCP stops for an account if anything differs.</p>
<label class="form-note"><input type="checkbox" id="push-consent"> I reviewed ${ready.length === 1 ? 'this upload' : 'these ' + ready.length + ' uploads'}. Push ${ready.length === 1 ? 'it' : 'them'} to the accounts listed.</label>
<button class="button primary" type="button" id="push-execute">Push ${ready.length === 1 ? '1 upload' : ready.length + ' uploads'}</button>`
    : ''
}</div>`;
    workspaceBind('#push-execute', async () => {
      if (!$('#push-consent').checked) throw Error('Confirm that you reviewed the uploads first.');
      const pending = rows.filter(r => r.state === 'ready');
      for (const row of pending) row.state = 'waiting';
      drawRows();
      for (const [i, row] of pending.entries()) {
        status('Pushing ' + (i + 1) + ' of ' + pending.length + '…', i, pending.length);
        row.state = 'pushing';
        drawRows();
        try {
          const review = await workspaceCall('media', {
            action: 'prepare',
            ...row.destination,
            source_id: source.source_id,
            name: row.name,
            fit_to_platform: row.fit,
            expected_sha256: row.file.sha256,
          });
          row.result = await workspaceCall('media', {action: 'execute', review_id: review.review_id, confirmed: true});
          row.state = row.result.ready ? 'uploaded' : 'processing';
        } catch (e) {
          row.state = 'failed';
          row.error = e.message;
        }
        drawRows();
      }
      const done = pending.filter(r => ['uploaded', 'processing'].includes(r.state)).length;
      status('Pushed ' + done + ' of ' + pending.length + '.');
      if (done) {
        $('#push-reviews').insertAdjacentHTML(
          'beforeend',
          '<button class="button" type="button" id="push-receipts">Show the upload receipts in the media library</button>',
        );
        workspaceBind('#push-receipts', () => renderWorkspacePage());
      }
    });
  };
  const pushRow = row => {
    const transform = row.transform,
      label = row.target.label,
      file = row.file ? pushFacts({...row.file, duration: source.duration}) : '—',
      changes = transform
        ? '<ul>' + transform.reasons.map(r => '<li>' + esc(r) + '</li>').join('') + '</ul>'
        : row.file
          ? 'Nothing: uploaded as it is.'
          : '—',
      state = {
        ready: 'Ready to push',
        refused: 'Not ready',
        waiting: 'Waiting…',
        pushing: 'Pushing…',
        uploaded: 'Uploaded',
        processing: 'Uploaded; the platform is processing it',
        failed: 'Not uploaded',
      }[row.state],
      detail = row.error
        ? '<p class="form-note">' + esc(row.error) + '</p>'
        : row.result?.media_id
          ? '<p class="form-note">Media ID ' + esc(row.result.media_id) + '</p>'
          : '';
    const tone = ['uploaded', 'processing', 'ready'].includes(row.state)
      ? 'online'
      : ['refused', 'failed'].includes(row.state)
        ? 'attention'
        : 'offline';
    return `<tr><th scope="row">${esc(label)}</th><td>${esc(file)}</td><td>${changes}</td><td><span class="status ${tone}">${esc(state)}</span>${detail}</td></tr>`;
  };
}
