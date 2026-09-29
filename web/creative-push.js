'use strict';
// Push creatives: bring in several images and videos at once (uploaded, from a public link, or from Google Drive files
// and folders selected in a Drive login), choose the advertising accounts they go to (every account of a platform at
// once, or one by one), and review what each account receives (amcp_media plan: the exact file and every change AMCP
// makes). After one confirmation each file and account gets an ordinary reviewed amcp_media prepare, bound to the
// planned file by its SHA-256, and execute, one at a time, so the workspace never holds more than one staged review.

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
/** amcp_media plan takes at most 20 destinations; one push reviews at most 200 uploads. */
const pushPlanChunk = 20,
  pushMaxUploads = 200;
const pushName = filename =>
  filename
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[\\/\x00-\x1f]/g, ' ')
    .slice(0, 80) || 'AMCP media';

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

/** The enabled Drive logins with the files and folders each selected, named as their last sync read them. */
function pushDrives() {
  const drive = platforms.find(p => p.id === 'drive');
  return (drive?.connections ?? [])
    .filter(c => c.enabled)
    .map(c => {
      const named = kind => new Map((c.groups?.find(g => g.kind === kind)?.assets ?? []).map(a => [a.id, a.name]));
      const files = named('files'),
        folders = named('folders');
      return {
        id: c.id,
        name: c.name ?? c.label ?? 'Google Drive',
        files: c.accounts.filter(id => !folders.has(id)).map(id => ({id, name: files.get(id) ?? id})),
        folders: c.accounts.filter(id => folders.has(id)).map(id => ({id, name: folders.get(id) ?? id})),
      };
    });
}

/** The panel's markup; `targets` are the advertising accounts the member can upload media to. */
function creativePushPanel(targets, recent, drives) {
  const groups = [];
  targets.forEach((t, index) => {
    let g = groups.find(g => g.name === t.platformName);
    if (!g) groups.push((g = {name: t.platformName, items: []}));
    g.items.push({...t, index});
  });
  return `<section class="panel workspace-form creative-push" aria-labelledby="push-title">
<h2 id="push-title">Push creatives</h2>
<p class="workspace-copy">Bring in several images and videos at once, from your computer, a link or Google Drive. Choose the accounts they go to, on one platform or several, review each upload, then push.</p>
<div class="push-step"><h3>1. Your files</h3>
<form id="push-upload"><label>Images or videos (choose several at once)<input type="file" name="file" accept="image/png,image/jpeg,video/mp4,video/quicktime" multiple required></label><button class="button" type="submit">Upload</button></form>
<form id="push-link"><label>Or a public link to a file<input type="url" name="url" inputmode="url" placeholder="https://" required></label><button class="button" type="submit">Import from the link</button></form>
${
  drives.length
    ? `<div class="push-drive"><h4>From Google Drive</h4><label>Drive login<select id="push-drive-login">${drives
        .map((d, i) => `<option value="${i}">${esc(d.name)}</option>`)
        .join('')}</select></label><div id="push-drive-items"></div></div>`
    : '<p class="form-note">To import from Google Drive, connect it on the Connections page and select files or folders there.</p>'
}
<p class="form-note">PNG, JPEG, MP4 or MOV. AMCP keeps each file encrypted for 30 minutes, then deletes it.</p>
${
  recent.length
    ? `<div class="push-recent"><p class="form-note">Or add a recent upload:</p>${recent
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
${
  groups
    .map(
      g =>
        `<fieldset class="push-targets"><legend>${esc(g.name)}</legend>${
          g.items.length > 1
            ? `<label class="push-all"><input type="checkbox" data-push-all="${esc(g.name)}"> Every ${esc(g.name)} account (${g.items.length})</label>`
            : ''
        }${g.items
          .map(
            t =>
              `<label><input type="checkbox" name="target" value="${t.index}" data-push-platform="${esc(g.name)}"> ${esc(t.account)}</label>`,
          )
          .join('')}</fieldset>`,
    )
    .join('') || '<p class="form-note">Connect an advertising account and select it first.</p>'
}
<label id="push-owner" hidden>LinkedIn video owner: the organization URN of the page that posts it<input name="owner_urn" placeholder="urn:li:organization:123"></label>
<label id="push-name">Media name<input name="name" maxlength="80"></label>
<p id="push-names" class="form-note" hidden>Each file keeps its own name (its file name without the extension).</p>
<label class="form-note"><input type="checkbox" name="fit" checked> Fit to each platform: scale down anything larger than 1080 × 1920 (never cropped or enlarged), re-encode an image above a platform's size limit, convert MOV to MP4 for X and LinkedIn.</label>
<button class="button primary" type="submit">Review the push</button></form>
<div id="push-reviews"></div></section>`;
}

/** Wires the panel after it is on the page. */
function bindCreativePush(targets, drives) {
  let sources = [],
    rows = [];
  const form = $('#push-review');
  const status = (text, done, total) => {
    $('#push-status').textContent = text;
    $('#push-bar').hidden = total === undefined;
    if (total !== undefined) {
      $('#push-bar').max = total;
      $('#push-bar').value = done;
    }
  };
  const outcome = (done, total, failed, noun) =>
    (failed.length
      ? done + ' of ' + total + ' ' + noun + ' ready. Not added: ' + failed.join('; ') + '.'
      : total === 1
        ? 'The file is ready.'
        : 'All ' + total + ' files are ready.') + (sources.length ? ' Choose where they go.' : '');
  const drawFiles = () => {
    rows = [];
    $('#push-reviews').innerHTML = '';
    $('#push-file').innerHTML = sources.length
      ? `<p class="form-note">${sources.length === 1 ? '1 file' : sources.length + ' files'} in this push.</p>` +
        sources
          .map(
            (s, i) =>
              `<div class="push-file">${
                s.thumbnail_url ? `<img src="${esc(s.thumbnail_url)}" alt="Preview of ${esc(s.filename)}">` : ''
              }<div><strong>${esc(s.filename)}</strong><p class="form-note">${esc(pushFacts(s))} · kept until ${date(s.expires_at)}</p><button class="button small" type="button" data-push-drop="${i}">Leave out of this push</button> <button class="button small" type="button" data-push-delete="${i}">Delete the file</button></div></div>`,
          )
          .join('')
      : '';
    form.hidden = !sources.length;
    const one = sources.length === 1;
    $('#push-name').hidden = !one;
    form.elements.name.required = one;
    $('#push-names').hidden = one;
    if (one) form.elements.name.value = pushName(sources[0].filename);
    ownerField();
    workspaceBind('[data-push-drop]', button => {
      sources.splice(Number(button.dataset.pushDrop), 1);
      drawFiles();
    });
    workspaceBind('[data-push-delete]', async button => {
      const s = sources[Number(button.dataset.pushDelete)];
      await api(pushSourceUrl(s.source_id), {method: 'DELETE'});
      sources = sources.filter(x => x !== s);
      drawFiles();
      status(s.filename + ' was deleted.');
    });
  };
  const add = s => {
    if (!sources.some(x => x.source_id === s.source_id)) sources.push(s);
    drawFiles();
  };
  const ownerField = () => {
    const linkedin = [...form.querySelectorAll('input[name=target]:checked')].some(
      box => targets[Number(box.value)]?.platform === 'linkedin',
    );
    $('#push-owner').hidden = !(sources.some(s => s.kind === 'video') && linkedin);
  };
  const syncAll = () =>
    form.querySelectorAll('[data-push-all]').forEach(all => {
      const boxes = [...form.querySelectorAll('input[name=target]')].filter(
          b => b.dataset.pushPlatform === all.dataset.pushAll,
        ),
        checked = boxes.filter(b => b.checked).length;
      all.checked = checked > 0 && checked === boxes.length;
      all.indeterminate = checked > 0 && checked < boxes.length;
    });
  form.addEventListener('change', event => {
    const all = event.target.dataset?.pushAll;
    if (all !== undefined)
      form.querySelectorAll('input[name=target]').forEach(box => {
        if (box.dataset.pushPlatform === all) box.checked = event.target.checked;
      });
    syncAll();
    ownerField();
  });
  workspaceBind('#push-upload', async upload => {
    const files = [...upload.elements.file.files];
    if (!files.length) throw Error('Choose one or more files first.');
    const failed = [];
    for (const [i, file] of files.entries()) {
      const step = files.length > 1 ? 'File ' + (i + 1) + ' of ' + files.length + ', ' : '';
      status(step + 'uploading ' + file.name + '…', 0, 1);
      try {
        add(
          await uploadCreative(file, (done, total, text) =>
            status(step + (text ?? file.name + ': part ' + done + ' of ' + total), done, total),
          ),
        );
      } catch (e) {
        failed.push(file.name + ' (' + e.message + ')');
      }
    }
    upload.reset();
    status(outcome(files.length - failed.length, files.length, failed, 'uploads'));
  });
  workspaceBind('#push-link', async link => {
    status('Importing the file from the link…');
    add(await api('/api/media/sources/link', {method: 'POST', body: JSON.stringify({url: link.elements.url.value})}));
    link.reset();
    status(outcome(1, 1, [], 'imports'));
  });
  workspaceBind('[data-push-source]', async button => {
    const all = (await api('/api/media/sources')).sources,
      chosen = all.find(s => s.source_id === button.dataset.pushSource && s.state === 'complete');
    if (!chosen) throw Error('That upload expired. Upload the file again.');
    add(chosen);
    status(chosen.filename + ' is in this push.');
  });
  const drawDrive = () => {
    const d = drives[Number($('#push-drive-login')?.value ?? 0)],
      area = $('#push-drive-items');
    if (!d || !area) return;
    area.innerHTML =
      (d.files.length
        ? `<fieldset class="push-targets"><legend>Selected files</legend>${d.files
            .map(f => `<label><input type="checkbox" data-drive-file="${esc(f.id)}"> ${esc(f.name)}</label>`)
            .join('')}</fieldset>`
        : '') +
      d.folders
        .map(
          (f, i) =>
            `<fieldset class="push-targets"><legend>Folder: ${esc(f.name)}</legend><button class="button small" type="button" data-drive-folder="${i}">Show its images and videos</button><div id="drive-folder-${i}"></div></fieldset>`,
        )
        .join('') +
      (d.files.length || d.folders.length
        ? '<button class="button" type="button" id="push-drive-add">Add the checked Drive files</button>'
        : '<p class="form-note">This Drive login has no selected files or folders. Select them on the Connections page.</p>');
    workspaceBind('[data-drive-folder]', async button => {
      const index = button.dataset.driveFolder,
        folder = d.folders[Number(index)];
      status('Reading the folder ' + folder.name + '…');
      const out = await api('/api/media/drive/folder', {
        method: 'POST',
        body: JSON.stringify({connection_id: d.id, folder_id: folder.id}),
      });
      $('#drive-folder-' + index).innerHTML = out.files.length
        ? (out.files.length > 1
            ? `<label class="push-all"><input type="checkbox" data-drive-all="${esc(folder.id)}"> Every file in this folder (${out.files.length})</label>`
            : '') +
          out.files
            .map(
              x =>
                `<label><input type="checkbox" data-drive-file="${esc(x.id)}" data-drive-in="${esc(folder.id)}"> ${esc(x.name)} · ${esc(pushKind(x.mime))} · ${esc(pushSize(x.size))}</label>`,
            )
            .join('') +
          (out.truncated ? '<p class="form-note">The folder holds more files than one list shows (500).</p>' : '')
        : '<p class="form-note">No PNG, JPEG, MP4 or MOV file you can download is directly in this folder.</p>';
      status(out.files.length + ' file(s) in ' + folder.name + '. Check the ones to add.');
    });
    workspaceBind('#push-drive-add', async () => {
      const chosen = [...area.querySelectorAll('input[data-drive-file]:checked')];
      if (!chosen.length) throw Error('Check the Drive files to add first.');
      const failed = [];
      for (const [i, box] of chosen.entries()) {
        status('Importing ' + (i + 1) + ' of ' + chosen.length + ' from Google Drive…', i, chosen.length);
        try {
          add(
            await api('/api/media/sources/drive', {
              method: 'POST',
              body: JSON.stringify({
                connection_id: d.id,
                file_id: box.dataset.driveFile,
                ...(box.dataset.driveIn ? {folder_id: box.dataset.driveIn} : {}),
              }),
            }),
          );
          box.checked = false;
        } catch (e) {
          failed.push(box.parentElement.textContent.trim() + ' (' + e.message + ')');
        }
      }
      area.querySelectorAll('[data-drive-all]').forEach(all => (all.checked = false));
      status(outcome(chosen.length - failed.length, chosen.length, failed, 'imports'));
    });
  };
  $('#push-drive-login')?.addEventListener('change', drawDrive);
  $('#push-drive-items')?.addEventListener('change', event => {
    const folder = event.target.dataset?.driveAll;
    if (folder !== undefined)
      $('#push-drive-items')
        .querySelectorAll('input[data-drive-in]')
        .forEach(box => {
          if (box.dataset.driveIn === folder) box.checked = event.target.checked;
        });
  });
  drawDrive();
  workspaceBind('#push-review', async () => {
    if (!sources.length) throw Error('Add a file first.');
    const chosen = [...form.querySelectorAll('input[name=target]:checked')].map(box => targets[Number(box.value)]);
    if (!chosen.length) throw Error('Choose at least one advertising account.');
    if (sources.length * chosen.length > pushMaxUploads)
      throw Error(
        'One push reviews at most ' +
          pushMaxUploads +
          ' uploads; this is ' +
          sources.length * chosen.length +
          '. Choose fewer files or accounts.',
      );
    const owner = form.elements.owner_urn.value.trim(),
      fit = form.elements.fit.checked,
      one = sources.length === 1,
      typed = form.elements.name.value.trim();
    if (one && !typed) throw Error('Give the media a name.');
    const destination = (target, source) => ({
      platform: target.platform,
      account_id: target.account_id,
      connection_id: target.connection_id,
      ...(target.platform === 'linkedin' && source.kind === 'video' && owner ? {owner_urn: owner} : {}),
    });
    rows = [];
    for (const [i, source] of sources.entries()) {
      const name = one ? typed : pushName(source.filename);
      for (let start = 0; start < chosen.length; start += pushPlanChunk) {
        const part = chosen.slice(start, start + pushPlanChunk);
        status(
          'Working out what each account receives' +
            (sources.length > 1 ? ' (file ' + (i + 1) + ' of ' + sources.length + ')' : '') +
            '…',
        );
        try {
          const plan = await workspaceCall('media', {
            action: 'plan',
            source_id: source.source_id,
            fit_to_platform: fit,
            destinations: part.map(t => destination(t, source)),
          });
          plan.destinations.forEach((p, j) =>
            rows.push({
              source,
              target: part[j],
              destination: destination(part[j], source),
              name,
              fit,
              state: p.ready ? 'ready' : 'refused',
              file: p.file,
              transform: p.transform,
              error: p.error?.message,
            }),
          );
        } catch (e) {
          for (const target of part)
            rows.push({
              source,
              target,
              destination: destination(target, source),
              name,
              fit,
              state: 'refused',
              error: e.message,
            });
        }
      }
    }
    drawRows();
    const ready = rows.filter(r => r.state === 'ready').length;
    status(
      ready + ' of ' + rows.length + (rows.length === 1 ? ' upload is' : ' uploads are') + ' ready for your review.',
    );
    $('#push-reviews-title')?.focus();
  });
  const drawRows = () => {
    const ready = rows.filter(r => r.state === 'ready');
    $('#push-reviews').innerHTML =
      `<div class="push-step"><h3 id="push-reviews-title" tabindex="-1">3. Review and push</h3>
<div class="push-table-wrap" tabindex="0" role="region" aria-labelledby="push-reviews-title"><table class="push-table" aria-labelledby="push-reviews-title">
<thead><tr><th scope="col">Account</th><th scope="col">File</th><th scope="col">What it receives</th><th scope="col">What AMCP changes</th><th scope="col">Status</th></tr></thead>
<tbody>${rows.map(pushRow).join('')}</tbody></table></div>
${
  ready.length && !rows.some(r => ['waiting', 'pushing'].includes(r.state))
    ? `<p class="form-note">Each upload then gets its own review, bound to exactly the file shown; AMCP stops for an upload if anything differs.</p>
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
            source_id: row.source.source_id,
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
      file = row.file ? pushFacts({...row.file, duration: row.source.duration}) : '—',
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
    return `<tr><th scope="row">${esc(row.target.label)}</th><td>${esc(row.source.filename)}</td><td>${esc(file)}</td><td>${changes}</td><td><span class="status ${tone}">${esc(state)}</span>${detail}</td></tr>`;
  };
}
