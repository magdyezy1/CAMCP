'use strict';
// Push creatives: bring in several images and videos at once (uploaded, from a public link, or from Google Drive files
// and folders selected in a Drive login), choose the advertising accounts they go to (every account of a platform at
// once, or one by one), and review what each account receives (amcp_media plan: the exact file and every change AMCP
// makes, and an upload already in the account that can be reused). After one confirmation each file and account gets
// an ordinary reviewed amcp_media prepare, bound to the planned file by its SHA-256, and execution, one at a time, so
// the workspace never holds more than one staged review. The push runs on the server (MED-03 B): it is saved as plans
// of independent uploads, approved with that confirmation and run by the worker, so leaving the page does not stop it.
// With server runs turned off (AMCP_SERVER_PUSH=false) the page drives each row itself through a durable job.

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
/**
 * A Drive import whose Drive selection is gone (owner decision D23 (4), MED-05): the import is a frozen copy, so
 * revoking Drive access neither removes nor blocks it; the member is told so.
 */
const pushDriveAccessNote = s =>
  s.drive_access === 'revoked'
    ? `<p class="form-note">${esc(uiText('Drive access since revoked. This imported copy is frozen and not affected: it can still be pushed until it expires or an owner removes it.'))}</p>`
    : '';
/** amcp_media plan takes at most 20 destinations; one push reviews at most 200 uploads, run as plans of 50. */
const pushPlanChunk = 20,
  pushMaxUploads = 200,
  pushPlanSize = 50;
/** A push must leave this long before an upload is deleted: the server refuses to run a plan with less (MED-03 B). */
const pushRunByMinimumMs = 5 * 60000;
/** How often a running push is read back: bounded, and only while the page shows it. */
const pushPollMs = 4000;
const pushSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/**
 * Asks the browser to confirm leaving the page while rows still depend on it (MED-03 A): rows the page drives itself,
 * or a server push whose plans are still being saved. Returns the function that removes the guard.
 */
function pushLeaveGuard() {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
  const guard = event => {
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', guard);
  return () => window.removeEventListener('beforeunload', guard);
}
/** "file → platform · account": how a saved or server-run push plan names each upload (MED-03 A). */
const pushStepDescription = row =>
  [
    row.source.filename ?? row.source.source_id,
    '→',
    (row.target?.platformName ?? row.destination.platform) + ' ·',
    row.target?.account ?? row.destination.account_id,
  ]
    .join(' ')
    .slice(0, 300);
/** One planned row as a plan step: a reviewed upload bound to its planned file, reused when the member chose to. */
const pushPlanStep = (row, index) => ({
  id: 'upload-' + (index + 1),
  kind: 'media',
  description: pushStepDescription(row),
  account_id: row.destination.account_id,
  connection_id: row.destination.connection_id,
  arguments: {
    ...row.destination,
    source_id: row.source.source_id,
    name: row.name,
    fit_to_platform: row.fit,
    expected_sha256: row.file.sha256,
    ...(row.reuse ? {reuse_existing: true} : {}),
  },
  depends_on: [],
});
/** A row's state from its plan step while the push runs on the server. */
function pushStepState(step) {
  if (step.status === 'pending') return step.waiting ? 'busy' : 'waiting';
  return (
    {
      review_ready: 'pushing',
      executing: 'pushing',
      verified: 'uploaded',
      verified_with_acceptance: 'uploaded',
      processing: 'processing',
      failed: 'failed',
      uncertain: 'failed',
      mismatch: 'failed',
    }[step.status] ?? 'waiting'
  );
}
const pushName = filename =>
  filename
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[\\/\x00-\x1f]/g, ' ')
    .slice(0, 80) || 'AMCP media';

/**
 * Deadlines count down on the server's clock: the offset is learned from server_time in AMCP's responses, so a device
 * clock that is wrong does not move a deadline (MED-01 Stage E).
 */
let pushServerOffset = 0;
function pushNoteServerTime(value) {
  const at = Date.parse(value ?? '');
  if (Number.isFinite(at)) pushServerOffset = at - Date.now();
}
const pushNow = () => Date.now() + pushServerOffset;
/** A source's absolute deadline in milliseconds; Infinity for a retained original, which has none. */
const pushDeadline = source =>
  source?.retained === true || !source?.expires_at ? Infinity : Date.parse(source.expires_at);
/** A website upload or an import not retained (src-…): deleted 30 minutes after it started. */
const pushTemporary = source => source?.retained !== true && /^src-/.test(source?.source_id ?? '');
/** Time left before `deadline`, as minutes:seconds ('0:00' once passed); empty for no deadline. */
function pushRemaining(deadline, now = pushNow()) {
  if (!Number.isFinite(deadline)) return '';
  const left = Math.max(0, Math.ceil((deadline - now) / 1000));
  return Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
}
/**
 * The deadline announcement due for `source` at `now`, once per threshold (10, 5 and 1 minutes, then deletion), for
 * a polite live region; the visible countdown changes every second but is not announced. `announced` remembers them.
 */
function pushDeadlineAnnouncement(source, announced, now = pushNow()) {
  const deadline = pushDeadline(source);
  if (!Number.isFinite(deadline)) return '';
  const left = deadline - now,
    key = threshold => source.source_id + ':' + threshold;
  if (left <= 0) {
    if (announced.has(key(0))) return '';
    [0, 1, 5, 10].forEach(t => announced.add(key(t)));
    return uiText('{filename} was deleted at its deadline. Upload it again to push it.', {filename: source.filename});
  }
  const threshold = [1, 5, 10].find(t => left <= t * 60000);
  if (threshold === undefined || announced.has(key(threshold))) return '';
  [1, 5, 10].filter(t => t >= threshold).forEach(t => announced.add(key(t)));
  const minutes = Math.ceil(left / 60000);
  return minutes === 1
    ? uiText('{filename}: 1 minute left before it is deleted. Push it now or upload it again.', {
        filename: source.filename,
      })
    : uiText('{filename}: {minutes} minutes left before it is deleted. Push it now or upload it again.', {
        filename: source.filename,
        minutes,
      });
}
/** A conservative time to prepare and push one row: half a minute plus a second per MiB. */
const pushRowBudgetMs = row => 30000 + Math.ceil((row.file?.size ?? row.source?.size ?? 0) / 1048576) * 1000;
/** Rows in the order they are pushed: earliest upload deadline first (durable originals last), else as planned. */
const pushOrder = rows =>
  rows
    .map((row, index) => ({row, index}))
    .sort((a, b) => pushDeadline(a.row.source) - pushDeadline(b.row.source) || a.index - b.index)
    .map(x => x.row);
/**
 * Points planned rows whose upload expired, or expires sooner, at a new upload of the identical file (the same
 * SHA-256 the server computed for both): a new upload with its own 30-minute window, never an extension. Returns how
 * many rows now use it; a file with another SHA-256 changes nothing.
 */
function pushRebindRows(rows, source) {
  if (source?.state !== 'complete' || typeof source.sha256 !== 'string' || !source.sha256) return 0;
  let count = 0;
  for (const row of rows)
    if (
      ['expired', 'ready'].includes(row.state) &&
      row.source.source_id !== source.source_id &&
      row.source.sha256 === source.sha256 &&
      pushDeadline(row.source) < pushDeadline(source)
    ) {
      row.source = source;
      row.state = 'ready';
      delete row.error;
      count++;
    }
  return count;
}

/**
 * Which moments of a transfer a screen reader hears (MED-05): returns `(done, total) => percent`, the quarter (25, 50,
 * 75 or 100) a part has just reached, or null in between. Below the first quarter it returns 0 (the start, which the
 * caller has already announced), so an upload of any number of parts is announced at most four times while it
 * transfers; a resumed upload is first announced at the quarter its first part sent reaches.
 */
function pushProgressAnnouncer() {
  let last = -1;
  return (done, total) => {
    const quarter = total > 0 ? Math.max(0, Math.min(4, Math.floor((done * 4) / total))) : 0;
    if (quarter === last) return null;
    last = quarter;
    return quarter * 25;
  };
}
/** This tab's unfinished uploads (name, size, last change of each file), to offer a resume after a reload. */
const pushUploadsKey = 'amcp.unfinished-uploads';
function pushUploads() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(pushUploadsKey) ?? '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}
function pushRemember(id, file) {
  try {
    const saved = pushUploads();
    saved[id] = {name: file.name, size: file.size, last_modified: file.lastModified};
    sessionStorage.setItem(pushUploadsKey, JSON.stringify(Object.fromEntries(Object.entries(saved).slice(-20))));
  } catch {
    /* Private modes may deny storage; the server's list of unfinished uploads still offers the resume. */
  }
}
function pushForget(id) {
  try {
    const saved = pushUploads();
    delete saved[id];
    sessionStorage.setItem(pushUploadsKey, JSON.stringify(saved));
  } catch {}
}
/** Whether a failed upload is kept to resume: a lost connection, a busy server, a missing part or a page change. */
const pushResumable = e =>
  e?.code === undefined ||
  ['REQUEST_SUPERSEDED', 'MEDIA_PARTS_BUSY', 'MEDIA_UPLOAD_INCOMPLETE', 'MEDIA_UPLOAD_COMPLETING'].includes(e.code);
/**
 * Frees the place an upload that cannot finish holds, at once instead of when it expires. It survives a page change
 * (keepalive) and keeps the session's CSRF check; a refusal changes nothing, since the server releases it anyway.
 */
function pushDiscard(id) {
  try {
    fetch(pushSourceUrl(id), {
      method: 'DELETE',
      keepalive: true,
      credentials: 'same-origin',
      headers: {'Accept': 'application/json', 'Content-Type': 'application/json', 'X-AMCP-CSRF': session.csrf ?? ''},
      body: '{}',
    }).catch(() => {});
  } catch {}
}
/**
 * Runs a media request again while AMCP refuses it only because other media work holds the shared budget (MED-02):
 * after the server's retry_after_ms with jitter, and only while `until` (milliseconds) leaves time. Such a refusal
 * comes before any review is claimed, so nothing was sent.
 */
async function pushRetryBusy(run, until = Date.now() + 120000) {
  for (let attempt = 0; ; attempt++)
    try {
      return await run();
    } catch (e) {
      const wait = Math.min(30000, (Number(e.details?.retry_after_ms) || 5000) * (1 + Math.random()));
      if (!['MEDIA_MEMORY_BUSY', 'MEDIA_PROCESSOR_BUSY'].includes(e.code) || attempt >= 20 || Date.now() + wait > until)
        throw e;
      await new Promise(resolve => setTimeout(resolve, wait));
    }
}
/** Until when (device clock) a request about `source` may keep retrying: two minutes, ending a minute before its deadline. */
const pushRetryUntil = source => Math.min(Date.now() + 120000, pushDeadline(source) - pushServerOffset - 60000);
/** SHA-256 of part of a file, in hex, to check a reselected file before a resume sends anything. */
async function pushDigest(blob) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('');
}
/** Completes an upload; while another request is still checking it, waits and completes it again. */
async function pushComplete(id) {
  for (let attempt = 0; ; attempt++)
    try {
      return await api(pushSourceUrl(id) + '/complete', {method: 'POST'});
    } catch (e) {
      if (e.code !== 'MEDIA_UPLOAD_COMPLETING' || attempt >= 60) throw e;
      await new Promise(resolve => setTimeout(resolve, Number(e.details?.retry_after_ms) || 2000));
    }
}
/**
 * Sends a file to AMCP in the parts the server asks for, retrying a part twice on a network error or a busy server.
 * `resume` (an unfinished upload's status) sends only the parts still missing. An upload that cannot finish is
 * discarded at once; one interrupted by a lost connection, a busy server or a page change is kept to resume, and
 * the error carries it as `unfinished`. A resume never extends the upload's 30-minute deadline.
 */
async function uploadCreative(file, progress, resume) {
  const generation = navigationGeneration;
  const started =
    resume ??
    (await api('/api/media/sources', {
      method: 'POST',
      body: JSON.stringify({filename: file.name, size: file.size, type: file.type}),
    }));
  pushRemember(started.source_id, file);
  const have = new Set(resume?.received_parts ?? []);
  let completed = false,
    keep = false,
    sealed = resume?.parts_sealed === true,
    sent = sealed ? started.chunks : have.size;
  try {
    parts: for (let index = 0; !sealed && index < started.chunks; index++) {
      if (have.has(index)) continue;
      const part = file.slice(index * started.chunk_bytes, (index + 1) * started.chunk_bytes);
      for (let attempt = 0; ; attempt++) {
        if (generation !== navigationGeneration) throw supersededRequest();
        try {
          await api(pushSourceUrl(started.source_id) + '/parts/' + index, {
            method: 'PUT',
            body: part,
            headers: {'Content-Type': 'application/octet-stream'},
          });
          break;
        } catch (e) {
          if (e.code === 'REQUEST_SUPERSEDED') throw e;
          // Every part already arrived and an earlier completion sealed them: complete it again.
          if (e.code === 'MEDIA_UPLOAD_COMPLETING') {
            sealed = true;
            break parts;
          }
          if (attempt >= 2 || (e.code !== undefined && e.code !== 'MEDIA_PARTS_BUSY')) throw e;
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
      progress(++sent, started.chunks);
    }
    progress(started.chunks, started.chunks, uiText('Checking the file…'));
    const done = await pushComplete(started.source_id);
    completed = true;
    return done;
  } catch (e) {
    keep = pushResumable(e);
    if (!keep) e.discarded = true;
    if (keep)
      e.unfinished = {
        source_id: started.source_id,
        filename: started.filename ?? file.name,
        size: file.size,
        chunks: started.chunks,
        received_chunks: sent,
        expires_at: started.expires_at,
        file,
      };
    throw e;
  } finally {
    if (completed) pushForget(started.source_id);
    else if (!keep) {
      pushForget(started.source_id);
      pushDiscard(started.source_id);
    }
  }
}
/**
 * Continues an unfinished upload with the file chosen again: the same size and, when part 0 arrived, the same first
 * part (SHA-256), then only the missing parts. Completion still checks the whole file's SHA-256.
 */
async function resumeCreativeUpload(sourceId, file, progress) {
  const status = await api(pushSourceUrl(sourceId));
  if (status.state === 'complete') {
    pushForget(sourceId);
    return status;
  }
  const mismatch = message => Object.assign(Error(message), {code: 'MEDIA_RESUME_FILE_MISMATCH'});
  if (file.size !== status.size)
    throw mismatch(uiText('This is not the same file: its size differs. Choose the file you were uploading.'));
  if (status.first_part_sha256 && (await pushDigest(file.slice(0, status.chunk_bytes))) !== status.first_part_sha256)
    throw mismatch(uiText('This is not the same file: its first part differs. Choose the file you were uploading.'));
  return uploadCreative(file, progress, status);
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

/**
 * Unfinished website uploads (state receiving): how far each got, when it is released if nothing more arrives and its
 * absolute deadline, with Resume (choose the same file again; only missing parts are sent) and Discard.
 */
function pushUnfinishedMarkup(unfinished) {
  if (!unfinished.length) return '';
  return `<h4 id="push-unfinished-title">${esc(uiText('Unfinished uploads'))}</h4><p class="form-note">${esc(uiText('An unfinished upload keeps its place in the workspace storage until you resume or discard it. It is released when nothing arrives for a while, and always 30 minutes after it started.'))}</p><ul class="push-unfinished-list" aria-labelledby="push-unfinished-title">${unfinished
    .map(
      u =>
        `<li data-push-unfinished="${esc(u.source_id)}"><bdi dir="auto">${esc(u.filename)}</bdi> · ${esc(uiText('{received} of {count} parts received', {received: u.received_chunks ?? 0, count: u.chunks ?? 0}))}${u.released_if_idle_at ? ' · ' + esc(uiText('released at {time} if nothing more arrives', {time: uiDate(u.released_if_idle_at, {hour: '2-digit', minute: '2-digit'})})) : ''} · ${esc(uiText('deleted by {time}', {time: uiDate(u.expires_at, {hour: '2-digit', minute: '2-digit'})}))} <button class="button small" type="button" data-push-resume="${esc(u.source_id)}" aria-label="${esc(uiText('Resume {filename}', {filename: u.filename}))}">${esc(uiText('Resume'))}</button> <button class="button small" type="button" data-push-discard="${esc(u.source_id)}" aria-label="${esc(uiText('Discard {filename}', {filename: u.filename}))}">${esc(uiText('Discard'))}</button></li>`,
    )
    .join(
      '',
    )}</ul><input type="file" id="push-resume-file" accept="image/png,image/jpeg,video/mp4,video/quicktime" hidden>`;
}

/** The panel's markup; `targets` are the advertising accounts the member can upload media to. */
function creativePushPanel(targets, recent, drives, unfinished = []) {
  const groups = [];
  targets.forEach((t, index) => {
    let g = groups.find(g => g.name === t.platformName);
    if (!g) groups.push((g = {name: t.platformName, items: []}));
    g.items.push({...t, index});
  });
  return `<section class="panel workspace-form creative-push" aria-labelledby="push-title">
<h2 id="push-title">${esc(uiText('Push creatives'))}</h2>
<p class="workspace-copy">${esc(uiText('Bring in several images and videos at once, from your computer, a link or Google Drive. Choose the accounts they go to, on one platform or several, review each upload, then push.'))}</p>
<div class="push-step"><h3>${esc(uiText('1. Your files'))}</h3>
<form id="push-upload"><label>${esc(uiText('Images or videos (choose several at once)'))}<input type="file" name="file" accept="image/png,image/jpeg,video/mp4,video/quicktime" multiple required></label><button class="button" type="submit">${esc(uiText('Upload'))}</button></form>
<form id="push-link"><label>${esc(uiText('Or a public link to a file'))}<input type="url" name="url" inputmode="url" placeholder="https://" required></label><button class="button" type="submit">${esc(uiText('Import from the link'))}</button></form>
${
  drives.length
    ? `<div class="push-drive"><h4>${esc(uiText('From Google Drive'))}</h4><label>${esc(uiText('Drive login'))}<select id="push-drive-login">${drives
        .map((d, i) => `<option value="${i}">${esc(d.name)}</option>`)
        .join('')}</select></label><div id="push-drive-items"></div></div>`
    : `<p class="form-note">${esc(uiText('To import from Google Drive, connect it on the Connections page and select files or folders there.'))}</p>`
}
<p class="form-note">${esc(uiText('PNG, JPEG, MP4 or MOV. Website uploads, previews and review copies expire 30 minutes after the upload starts. They cannot be retained. An owner can separately retain an original imported from a public link or Drive, within the shared file quota. Provider-hosted media is kept by the provider.'))}</p>
${
  recent.length
    ? `<div class="push-recent"><p class="form-note">${esc(uiText('Or add a recent upload or retained original:'))}</p>${recent
        .map(
          s =>
            `<button class="button small" type="button" data-push-source="${esc(s.source_id)}">${s.retained === true ? esc(uiText('Retained original')) + ' · ' : ''}<bdi dir="auto">${esc(s.filename)}</bdi> · ${esc(pushFacts(s))} · ${esc(uiDate(s.uploaded_at, {hour: '2-digit', minute: '2-digit'}))}${s.drive_access === 'revoked' ? ' · ' + esc(uiText('Drive access since revoked')) : ''}</button>`,
        )
        .join('')}</div>`
    : ''
}
<div id="push-unfinished" class="push-unfinished">${pushUnfinishedMarkup(unfinished)}</div>
<progress id="push-bar" class="push-bar" max="1" value="0" aria-label="${esc(uiText('Upload progress'))}" hidden></progress>
<p id="push-parts" class="form-note"></p>
<p id="push-status" class="form-note" role="status"></p>
<p id="push-deadline-status" class="form-note" role="status"></p>
<div id="push-file"></div></div>
<form id="push-review" class="push-step" hidden><h3>${esc(uiText('2. Where it goes'))}</h3>
${
  groups
    .map(
      g =>
        `<fieldset class="push-targets"><legend>${esc(g.name)}</legend>${
          g.items.length > 1
            ? `<label class="push-all"><input type="checkbox" data-push-all="${esc(g.name)}"> ${esc(uiText('All {platform} accounts ({count})', {platform: g.name, count: g.items.length}))}</label>`
            : ''
        }${g.items
          .map(
            t =>
              `<label><input type="checkbox" name="target" value="${t.index}" data-push-platform="${esc(g.name)}"> ${esc(t.account)}</label>`,
          )
          .join('')}</fieldset>`,
    )
    .join('') || `<p class="form-note">${esc(uiText('Connect an advertising account and select it first.'))}</p>`
}
<label id="push-owner" hidden>${esc(uiText('LinkedIn video owner: the organization URN of the page that posts it'))}<input name="owner_urn" placeholder="urn:li:organization:123"></label>
<label id="push-name">${esc(uiText('Media name'))}<input name="name" maxlength="80"></label>
<p id="push-names" class="form-note" hidden>${esc(uiText('Each file keeps its own name (its file name without the extension).'))}</p>
<label class="form-note"><input type="checkbox" name="fit" checked> ${esc(uiText("Fit to each platform: scale down anything larger than 1080 × 1920 (never cropped or enlarged), re-encode an image above a platform's size limit, convert MOV to MP4 for X and LinkedIn."))}</label>
<button class="button primary" type="submit">${esc(uiText('Review the push'))}</button></form>
<div id="push-reviews"></div></section>`;
}

/**
 * Wires the panel after it is on the page; `initialUnfinished` are the member's unfinished uploads and `serverTime`
 * the server's clock when they were listed. `serverPush` (amcp_media list's server_push) runs a push on the server.
 * Returns the countdown's tick, which runs every second while the panel shows.
 */
function bindCreativePush(targets, drives, initialUnfinished = [], serverTime, {serverPush = false} = {}) {
  pushNoteServerTime(serverTime);
  let sources = [],
    rows = [],
    unfinished = [...initialUnfinished],
    resuming = null;
  const form = $('#push-review'),
    root = $('#push-file'),
    generation = navigationGeneration,
    identity = identityGeneration;
  let sourceGeneration = 0;
  const current = () =>
    generation === navigationGeneration && identity === identityGeneration && form.isConnected && root.isConnected;
  const status = (text, done, total) => {
    $('#push-status').textContent = text;
    $('#push-parts').textContent = '';
    $('#push-bar').hidden = total === undefined;
    if (total !== undefined) {
      $('#push-bar').max = total;
      $('#push-bar').value = done;
      // Not one file's transfer (or not yet): the bar keeps its general name (MED-05).
      $('#push-bar').setAttribute('aria-label', uiText('Upload progress'));
    }
  };
  /**
   * One file's transfer, part by part (MED-05): the bar, its name and the visible "part N of M" move with every part,
   * while the status region speaks only at each quarter, so a 128-part upload is announced about six times (start,
   * 25, 50, 75 and 100 %, then the outcome) instead of 128. `prefix` names the file's place in a batch.
   */
  const transferProgress = (filename, prefix = '') => {
    const announce = pushProgressAnnouncer(),
      label = uiText('Upload progress of {filename}', {filename});
    $('#push-bar').setAttribute('aria-label', label);
    return (done, total, text) => {
      const bar = $('#push-bar');
      bar.hidden = false;
      bar.max = total;
      bar.value = done;
      bar.setAttribute('aria-label', label);
      $('#push-parts').textContent =
        prefix + (text ?? uiText('{filename}: part {number} of {count}', {filename, number: done, count: total}));
      const percent = announce(done, total);
      if (percent)
        $('#push-status').textContent = prefix + uiText('{filename}: {percent}% uploaded', {filename, percent});
    };
  };
  let reboundNote = '';
  const outcome = (done, total, failed) =>
    (failed.length
      ? uiText('{done} of {total} files ready. Not added: {failures}.', {done, total, failures: failed.join('; ')})
      : total === 1
        ? uiText('The file is ready.')
        : uiText('All {count} files are ready.', {count: total})) +
    (sources.length ? ' ' + uiText('Choose where the files go.') : '') +
    (reboundNote ? ' ' + reboundNote : '');
  const drawFiles = () => {
    const drawn = ++sourceGeneration;
    rows = [];
    $('#push-reviews').innerHTML = '';
    $('#push-file').innerHTML = sources.length
      ? `<p class="form-note">${esc(uiText('Files in this push: {count}.', {count: sources.length}))}</p>` +
        sources
          .map(
            (s, i) =>
              `<div class="push-file">${s.thumbnail_url ? `<img src="${esc(s.thumbnail_url)}" alt="${esc(uiText('Preview of {filename}', {filename: s.filename}))}">` : ''}<div><strong dir="auto">${esc(s.filename)}</strong><p class="form-note">${esc(pushFacts(s))} ${s.retained === true && s.retention?.mode !== 'temporary' ? esc(uiText('Kept until an owner removes it.')) : esc(uiText('· kept until')) + ' ' + date(s.expires_at) + ` <span id="push-left-${i}" class="push-countdown">${esc(uiText('{time} left', {time: pushRemaining(pushDeadline(s))}))}</span>`}</p>${pushDriveAccessNote(s)}<details class="push-source-details"><summary>${esc(uiText('Original file details'))}</summary><p>${esc(uiText('Source ID'))}: <code dir="ltr">${esc(s.source_id)}</code></p><p>${esc(uiText('Original file SHA-256'))}: <code dir="ltr">${esc(s.sha256)}</code></p></details><button class="button small" type="button" data-push-drop="${i}">${esc(uiText('Leave out of this push'))}</button> ${s.can_retain === true ? `<button class="button small" type="button" data-push-retain="${i}">${esc(uiText('Retain this original'))}</button>` : ''} ${s.retained !== true || s.can_remove_retained === true ? `<button class="button small" type="button" data-push-delete="${i}">${esc(uiText(s.retained === true ? 'Delete retained original' : 'Delete the file'))}</button>` : ''}</div></div>`,
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
      if (!current() || drawn !== sourceGeneration) return;
      sources.splice(Number(button.dataset.pushDrop), 1);
      drawFiles();
    });
    workspaceBind('[data-push-retain]', async button => {
      if (!current() || drawn !== sourceGeneration || !button.isConnected) return;
      const s = sources[Number(button.dataset.pushRetain)];
      if (!s || s.can_retain !== true) return;
      const active = () => current() && drawn === sourceGeneration && button.isConnected && sources.includes(s);
      if (
        !(await confirmAction({
          title: uiText('Retain {filename} until removal?', {filename: s.filename}),
          consequence: uiText(
            'Keep an encrypted copy with SHA-256 {hash} until a workspace owner removes it. It shares the workspace file quota. The temporary upload keeps its own expiry.',
            {hash: s.sha256},
          ),
          confirmLabel: uiText('Save retained original'),
        })) ||
        !active()
      )
        return;
      let held;
      try {
        held = await api(pushSourceUrl(s.source_id) + '/retain', {
          method: 'POST',
          body: JSON.stringify({confirmed: true, expected_sha256: s.sha256}),
        });
      } catch (error) {
        if (active()) throw error;
        return;
      }
      if (!active()) return;
      if (held.retained !== true || held.sha256 !== s.sha256 || held.source_id !== s.source_id.replace(/^src-/, 'lib-'))
        throw Error(uiText('Retained original response does not match the selected source. Refresh your files.'));
      const selected = new Set();
      sources = sources
        .map(x => (x === s ? held : x))
        .filter(x => {
          if (selected.has(x.source_id)) return false;
          selected.add(x.source_id);
          return true;
        });
      drawFiles();
      root.setAttribute('tabindex', '-1');
      root.focus();
      status(uiText('{filename} is retained until an owner removes it.', {filename: s.filename}));
    });
    workspaceBind('[data-push-delete]', async button => {
      if (!current() || drawn !== sourceGeneration || !button.isConnected) return;
      const s = sources[Number(button.dataset.pushDelete)];
      if (!s || (s.retained === true && s.can_remove_retained !== true)) return;
      const active = () => current() && drawn === sourceGeneration && button.isConnected && sources.includes(s);
      let options = {method: 'DELETE'};
      if (s.retained === true) {
        if (
          !(await confirmAction({
            title: uiText('Permanently remove {filename}?', {filename: s.filename}),
            consequence: uiText(
              'Permanently delete the saved original with SHA-256 {hash} from current workspace storage. Existing uploads and receipts are kept. Backups follow their existing retention.',
              {hash: s.sha256},
            ),
            confirmLabel: uiText('Delete retained original'),
          })) ||
          !active()
        )
          return;
        options.body = JSON.stringify({confirmed: true, expected_sha256: s.sha256});
      }
      try {
        await api(pushSourceUrl(s.source_id), options);
      } catch (error) {
        if (active()) throw error;
        return;
      }
      if (!active()) return;
      sources = sources.filter(x => x !== s);
      drawFiles();
      status(uiText('{filename} was deleted.', {filename: s.filename}));
    });
  };
  const add = s => {
    pushNoteServerTime(s.server_time);
    // An identical re-upload (same SHA-256) takes over planned rows of an expired or expiring copy (owner decision
    // D23): their review table is kept, and a copy no row uses any more leaves the push (the new one is identical).
    const planned = rows,
      replaced = new Set(planned.map(r => r.source)),
      rebound = pushRebindRows(planned, s);
    if (rebound) sources = sources.filter(x => !replaced.has(x) || planned.some(r => r.source === x));
    if (!sources.some(x => x.source_id === s.source_id)) sources.push(s);
    drawFiles();
    reboundNote = '';
    if (rebound) {
      rows = planned;
      drawRows();
      reboundNote = uiText(
        '{count} planned uploads now use the new upload of {filename}. Review and push them again.',
        {
          count: rebound,
          filename: s.filename,
        },
      );
      status(reboundNote);
    }
  };
  const drawUnfinished = () => {
    const area = $('#push-unfinished');
    if (!area) return;
    area.innerHTML = pushUnfinishedMarkup(unfinished);
    workspaceBind('[data-push-discard]', async button => {
      const u = unfinished.find(x => x.source_id === button.dataset.pushDiscard);
      if (!u || !current()) return;
      try {
        await api(pushSourceUrl(u.source_id), {method: 'DELETE'});
      } catch (e) {
        // Already released or expired: nothing is left to discard.
        if (e.code !== 'MEDIA_SOURCE_NOT_FOUND') throw e;
      }
      pushForget(u.source_id);
      if (!current()) return;
      forgetUnfinished(u.source_id);
      status(uiText('{filename} was discarded.', {filename: u.filename}));
    });
    workspaceBind('[data-push-resume]', async button => {
      const u = unfinished.find(x => x.source_id === button.dataset.pushResume);
      if (!u || !current()) return;
      // A file this page still holds resumes at once; otherwise the member chooses the same file again.
      if (u.file) return resumeUpload(u, u.file);
      resuming = u;
      const input = $('#push-resume-file');
      input.value = '';
      input.click();
    });
  };
  const forgetUnfinished = id => {
    unfinished = unfinished.filter(u => u.source_id !== id);
    drawUnfinished();
  };
  const keepUnfinished = u => {
    unfinished = [u, ...unfinished.filter(x => x.source_id !== u.source_id)];
    drawUnfinished();
  };
  const resumeUpload = async (u, file) => {
    status(uiText('Resuming {filename}…', {filename: u.filename}), u.received_chunks ?? 0, u.chunks || 1);
    let done;
    try {
      done = await resumeCreativeUpload(u.source_id, file, transferProgress(u.filename));
    } catch (e) {
      // Kept to resume again, or gone (discarded, released or expired). A different file changes nothing.
      if (current() && e.unfinished) keepUnfinished(e.unfinished);
      else if (current() && (e.discarded || e.code === 'MEDIA_SOURCE_NOT_FOUND')) forgetUnfinished(u.source_id);
      throw e;
    }
    if (!current()) return;
    forgetUnfinished(u.source_id);
    add(done);
    status(outcome(1, 1, []));
  };
  drawUnfinished();
  $('#push-unfinished')?.addEventListener('change', async event => {
    if (event.target.id !== 'push-resume-file') return;
    const file = event.target.files?.[0],
      u = resuming;
    resuming = null;
    if (!file || !u || !current()) return;
    try {
      await resumeUpload(u, file);
    } catch (e) {
      if (current()) toast(errorMessage(e));
    }
  });
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
    if (!files.length) throw Error(uiText('Choose one or more files first.'));
    const failed = [],
      remembered = pushUploads();
    for (const [i, file] of files.entries()) {
      const step = files.length > 1 ? uiText('File {number} of {count}: ', {number: i + 1, count: files.length}) : '';
      status(step + uiText('Uploading {filename}…', {filename: file.name}), 0, 1);
      // The same file (name, size and last change) as an unfinished upload of this tab continues that upload.
      const match = unfinished.find(u => {
          const r = remembered[u.source_id];
          return r && r.name === file.name && r.size === file.size && r.last_modified === file.lastModified;
        }),
        progress = transferProgress(file.name, step);
      try {
        add(match ? await resumeCreativeUpload(match.source_id, file, progress) : await uploadCreative(file, progress));
        if (match) forgetUnfinished(match.source_id);
      } catch (e) {
        if (e.code === 'REQUEST_SUPERSEDED') throw e;
        if (e.unfinished) keepUnfinished(e.unfinished);
        else if (match && (e.discarded || e.code === 'MEDIA_SOURCE_NOT_FOUND')) forgetUnfinished(match.source_id);
        failed.push(file.name + ' (' + e.message + ')');
      }
    }
    upload.reset();
    status(outcome(files.length - failed.length, files.length, failed));
  });
  workspaceBind('#push-link', async link => {
    status(uiText('Importing the file from the link…'));
    add(
      await pushRetryBusy(() =>
        api('/api/media/sources/link', {method: 'POST', body: JSON.stringify({url: link.elements.url.value})}),
      ),
    );
    link.reset();
    status(outcome(1, 1, []));
  });
  workspaceBind('[data-push-source]', async button => {
    const listed = await api('/api/media/sources'),
      chosen = listed.sources.find(s => s.source_id === button.dataset.pushSource && s.state === 'complete');
    if (!current()) return;
    if (!chosen) throw Error(uiText('That original is unavailable. Refresh the files or import it again.'));
    pushNoteServerTime(listed.server_time);
    add(chosen);
    status(uiText('{filename} is in this push.', {filename: chosen.filename}) + (reboundNote ? ' ' + reboundNote : ''));
  });
  const drawDrive = () => {
    const d = drives[Number($('#push-drive-login')?.value ?? 0)],
      area = $('#push-drive-items');
    if (!d || !area) return;
    area.innerHTML =
      (d.files.length
        ? `<fieldset class="push-targets"><legend>${esc(uiText('Selected files'))}</legend>${d.files
            .map(f => `<label><input type="checkbox" data-drive-file="${esc(f.id)}"> ${esc(f.name)}</label>`)
            .join('')}</fieldset>`
        : '') +
      d.folders
        .map(
          (f, i) =>
            `<fieldset class="push-targets"><legend>${esc(uiText('Folder:'))} ${esc(f.name)}</legend><button class="button small" type="button" data-drive-folder="${i}">${esc(uiText('Show its images and videos'))}</button><div id="drive-folder-${i}"></div></fieldset>`,
        )
        .join('') +
      (d.files.length || d.folders.length
        ? `<button class="button" type="button" id="push-drive-add">${esc(uiText('Add the checked Drive files'))}</button>`
        : `<p class="form-note">${esc(uiText('This Drive login has no selected files or folders. Select them on the Connections page.'))}</p>`);
    workspaceBind('[data-drive-folder]', async button => {
      const index = button.dataset.driveFolder,
        folder = d.folders[Number(index)];
      status(uiText('Reading folder {name}…', {name: folder.name}));
      const out = await api('/api/media/drive/folder', {
        method: 'POST',
        body: JSON.stringify({connection_id: d.id, folder_id: folder.id}),
      });
      $('#drive-folder-' + index).innerHTML = out.files.length
        ? (out.files.length > 1
            ? `<label class="push-all"><input type="checkbox" data-drive-all="${esc(folder.id)}"> ${esc(uiText('Every file in this folder ({count})', {count: out.files.length}))}</label>`
            : '') +
          out.files
            .map(
              x =>
                `<label><input type="checkbox" data-drive-file="${esc(x.id)}" data-drive-in="${esc(folder.id)}"> ${esc(x.name)} · ${esc(pushKind(x.mime))} · ${esc(pushSize(x.size))}</label>`,
            )
            .join('') +
          (out.truncated
            ? `<p class="form-note">${esc(uiText('The folder holds more files than one list shows (500).'))}</p>`
            : '')
        : `<p class="form-note">${esc(uiText('No PNG, JPEG, MP4 or MOV file you can download is directly in this folder.'))}</p>`;
      status(uiText('Files in {name}: {count}. Check the ones to add.', {name: folder.name, count: out.files.length}));
    });
    workspaceBind('#push-drive-add', async () => {
      const chosen = [...area.querySelectorAll('input[data-drive-file]:checked')];
      if (!chosen.length) throw Error(uiText('Check the Drive files to add first.'));
      const failed = [];
      for (const [i, box] of chosen.entries()) {
        status(
          uiText('Importing {number} of {count} from Google Drive…', {number: i + 1, count: chosen.length}),
          i,
          chosen.length,
        );
        try {
          add(
            await pushRetryBusy(() =>
              api('/api/media/sources/drive', {
                method: 'POST',
                body: JSON.stringify({
                  connection_id: d.id,
                  file_id: box.dataset.driveFile,
                  ...(box.dataset.driveIn ? {folder_id: box.dataset.driveIn} : {}),
                }),
              }),
            ),
          );
          box.checked = false;
        } catch (e) {
          if (e.code === 'REQUEST_SUPERSEDED') throw e;
          failed.push(box.parentElement.textContent.trim() + ' (' + e.message + ')');
        }
      }
      area.querySelectorAll('[data-drive-all]').forEach(all => (all.checked = false));
      status(outcome(chosen.length - failed.length, chosen.length, failed));
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
    if (!sources.length) throw Error(uiText('Add a file first.'));
    const chosen = [...form.querySelectorAll('input[name=target]:checked')].map(box => targets[Number(box.value)]);
    if (!chosen.length) throw Error(uiText('Choose at least one advertising account.'));
    // A push to accounts of different clients asks first (SEC-08).
    if (
      typeof confirmCrossClient === 'function' &&
      !(await confirmCrossClient(
        chosen.map(t => ({
          gateway: t.gateway ?? t.platform + '_native_action',
          account_id: t.account_id,
          connection_id: t.connection_id,
        })),
        uiText('Review the push'),
      ))
    )
      return;
    if (sources.length * chosen.length > pushMaxUploads)
      throw Error(
        uiText('One push reviews at most {limit} uploads; this is {count}. Choose fewer files or accounts.', {
          limit: pushMaxUploads,
          count: sources.length * chosen.length,
        }),
      );
    const owner = form.elements.owner_urn.value.trim(),
      fit = form.elements.fit.checked,
      one = sources.length === 1,
      typed = form.elements.name.value.trim();
    if (one && !typed) throw Error(uiText('Give the media a name.'));
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
          uiText('Working out what each account receives (file {number} of {count})…', {
            number: i + 1,
            count: sources.length,
          }),
        );
        try {
          // stage_fits keeps each changed file for the reviews that follow, so they do not convert it again (MED-03 C).
          const plan = await pushRetryBusy(
            () =>
              workspaceCall('media', {
                action: 'plan',
                source_id: source.source_id,
                fit_to_platform: fit,
                stage_fits: fit,
                destinations: part.map(t => destination(t, source)),
              }),
            pushRetryUntil(source),
          );
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
              // The exact file is already in this account: reused after a fresh availability check unless the member
              // chooses to upload it again (MED-03 D).
              receipts: p.existing_receipts ?? [],
              reuse: (p.existing_receipts ?? []).length > 0,
            }),
          );
        } catch (e) {
          if (e.code === 'REQUEST_SUPERSEDED') throw e;
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
    status(uiText('Uploads ready for your review: {ready} of {count}.', {ready, count: rows.length}));
    $('#push-reviews-title')?.focus();
  });
  const drawRows = () => {
    const ready = rows.filter(r => r.state === 'ready'),
      // The push-time estimate in deadline order: rows whose upload would be deleted before their turn are skipped.
      order = pushOrder(ready);
    let at = pushNow(),
      late = 0;
    for (const row of order) {
      at += pushRowBudgetMs(row);
      if (at > pushDeadline(row.source)) late++;
    }
    const minutes = Math.max(1, Math.ceil((at - pushNow()) / 60000));
    $('#push-reviews').innerHTML =
      `<div class="push-step"><h3 id="push-reviews-title" tabindex="-1">${esc(uiText('3. Review and push'))}</h3>
<div class="push-table-wrap" tabindex="0" role="region" aria-labelledby="push-reviews-title"><table class="push-table" aria-labelledby="push-reviews-title">
<thead><tr><th scope="col">${esc(uiText('Account'))}</th><th scope="col">${esc(uiText('File'))}</th><th scope="col">${esc(uiText('What it receives'))}</th><th scope="col">${esc(uiText('What AMCP changes'))}</th><th scope="col">${esc(uiText('Status'))}</th></tr></thead>
<tbody>${rows.map(pushRow).join('')}</tbody></table></div>
${
  ready.length && !rows.some(r => ['waiting', 'pushing', 'busy', 'queued'].includes(r.state))
    ? `<p class="form-note">${esc(uiText('Each upload then gets its own review, bound to exactly the file shown; AMCP stops for an upload if anything differs.'))}</p>
<p class="form-note" id="push-estimate">${esc(uiText('Uploads are pushed in deadline order, the soonest first. Estimated time: about {minutes} minutes.', {minutes}))}${late ? ' ' + esc(uiText('{count} of them would be deleted before their turn and are skipped; upload those files again.', {count: late})) : ''}</p>
<label class="form-note"><input type="checkbox" id="push-consent"> ${esc(ready.length === 1 ? uiText('I reviewed this upload and authorize sending it to the listed account.') : uiText('I reviewed these {count} uploads and authorize sending them to the listed accounts.', {count: ready.length}))}</label>
<button class="button primary" type="button" id="push-execute">${esc(uiText('Submit uploads: {count}', {count: ready.length}))}</button>${ready.length <= 50 ? `<button class="button" type="button" id="push-save-plan">${esc(uiText('Save as a resumable upload plan'))}</button>` : `<p>${esc(uiText('For a resumable plan, select at most 50 uploads.'))}</p>`}`
    : ''
}</div>`;
    workspaceBind('#push-save-plan', async () => {
      // A plan that uses temporary files (30-minute uploads and imports not retained) is saved only with their
      // deadline in view; the server refuses it otherwise (owner decision D23).
      const temporary = rows.filter(r => r.state === 'ready' && pushTemporary(r.source)),
        first = Math.min(...temporary.map(r => pushDeadline(r.source)));
      if (
        temporary.length &&
        !(await confirmAction({
          title: uiText('Save a plan that uses temporary uploads?'),
          consequence: uiText(
            'Temporary files in this plan are deleted from {time}, so the plan must run before then. For a plan that can wait, import the files from a link or Google Drive and have an owner retain them.',
            {time: uiDate(new Date(first).toISOString())},
          ),
          confirmLabel: uiText('Save with this deadline'),
        }))
      )
        return;
      if (!current()) return;
      const plan = await saveCreativePushPlan(rows, temporary.length > 0);
      await navigate('/campaigns?id=' + encodeURIComponent(plan.id));
    });
    workspaceBind('#push-execute', async () => {
      if (!$('#push-consent').checked) throw Error(uiText('Confirm that you reviewed the uploads first.'));
      // The soonest deadline goes first; a row whose upload is deleted before it could finish is skipped unsent.
      const pending = pushOrder(rows.filter(r => r.state === 'ready'));
      for (const row of pending) row.state = 'waiting';
      drawRows();
      if (serverPush) await pushOnServer(pending);
      else await pushInPage(pending);
    });
    // The member's choice for a row whose exact file is already in the account: reuse it or upload it again.
    $('#push-reviews')
      ?.querySelectorAll?.('[data-push-reuse]')
      .forEach(select =>
        select.addEventListener('change', () => {
          const row = rows[Number(select.dataset.pushReuse)];
          if (row?.state === 'ready') row.reuse = select.value === 'reuse';
        }),
      );
  };
  const skipLate = row => {
    row.state = 'expired';
    row.error = uiText(
      'Its upload is deleted before this push could finish, so nothing was sent. Upload the file again: these rows then use the new upload.',
    );
  };
  const finished = pending => {
    const done = pending.filter(r => ['queued', 'uploaded', 'processing', 'reused'].includes(r.state)).length;
    status(
      uiText('Submitted {done} of {count}. Follow each original upload receipt below.', {
        done,
        count: pending.length,
      }),
    );
    if (done) {
      $('#push-reviews').insertAdjacentHTML(
        'beforeend',
        `<button class="button" type="button" id="push-receipts">${esc(uiText('Show the upload receipts in the media library'))}</button>`,
      );
      workspaceBind('#push-receipts', () => renderWorkspacePage());
    }
  };
  /**
   * The push on the server (MED-03 B): the rows are saved as plans of independent uploads (50 at most each), every
   * plan is approved with the member's confirmation, its exact plan_hash and summary_hash, and queued with
   * run_background. The worker then prepares, executes and records every upload; this page only reads the plans back,
   * and leaving it stops nothing. A row whose upload is deleted within five minutes is skipped unsent: the server
   * refuses a plan that could not run in time.
   */
  const pushOnServer = async pending => {
    const generation = navigationGeneration,
      now = pushNow(),
      send = [];
    for (const row of pending)
      if (pushDeadline(row.source) - now < pushRunByMinimumMs) skipLate(row);
      else send.push(row);
    drawRows();
    status(uiText('Sending the push to AMCP…'));
    const plans = [],
      parts = Math.ceil(send.length / pushPlanSize),
      // Until every plan is saved and queued the push still needs this page; afterwards it runs without it.
      release = pushLeaveGuard();
    try {
      await sendServerPlans(send, plans, parts, generation);
    } finally {
      release();
    }
    if (generation !== navigationGeneration) return;
    if (plans.length)
      status(uiText('The push runs on AMCP: you can leave this page. Follow each upload below or in its plan.'));
    await followServerPush(plans, generation);
    if (generation === navigationGeneration && current()) finished(pending);
  };
  /** Saves, approves and queues the rows as plans of at most 50 uploads; a plan that fails marks its rows. */
  const sendServerPlans = async (send, plans, parts, generation) => {
    for (let start = 0; start < send.length; start += pushPlanSize) {
      const part = send.slice(start, start + pushPlanSize),
        temporary = part.some(r => pushTemporary(r.source));
      let id;
      try {
        const saved = await workspaceCall('campaign', {
          action: 'create',
          name:
            'Creative push · ' +
            part.length +
            ' uploads' +
            (parts > 1 ? ' · ' + (start / pushPlanSize + 1) + '/' + parts : ''),
          brief:
            'Upload only the previewed files to the selected accounts. Each source hash, native review and receipt is retained. Temporary sources must still be available when the plan runs.',
          // The member saw each upload's deadline and countdown before confirming (owner decision D23).
          ...(temporary ? {acknowledge_temporary_sources: true} : {}),
          steps: part.map(pushPlanStep),
        });
        id = saved.id;
        part.forEach((row, i) => {
          row.plan_id = id;
          row.step_id = 'upload-' + (i + 1);
        });
        const summary = await workspaceCall('campaign', {action: 'approve', id});
        if (!summary.approval)
          throw Error(
            summary.missing_requirements?.[0]?.error?.message ??
              uiText('AMCP could not check this plan. Open it to see why.'),
          );
        await workspaceCall('campaign', {
          action: 'approve',
          id,
          plan_hash: summary.approval.plan_hash,
          summary_hash: summary.approval.summary_hash,
          confirmed: true,
        });
        await workspaceCall('campaign', {action: 'run_background', id});
        plans.push({id, rows: part});
      } catch (e) {
        if (e.code === 'REQUEST_SUPERSEDED') throw e;
        for (const row of part) {
          row.state = 'failed';
          row.error = e.message;
        }
      }
      if (generation !== navigationGeneration) return;
      drawRows();
    }
  };
  /** Reads the plans of a server push back until no upload is left to move, while this page still shows them. */
  const followServerPush = async (plans, generation) => {
    for (let poll = 0; plans.length && poll < 2700; poll++) {
      await pushSleep(pushPollMs);
      if (generation !== navigationGeneration || !current()) return;
      let moving = false;
      for (const plan of plans) {
        let view;
        try {
          view = await workspaceCall('campaign', {action: 'get', id: plan.id});
        } catch (e) {
          if (e.code === 'REQUEST_SUPERSEDED') throw e;
          moving = true;
          continue;
        }
        // The member left: the server keeps running the plans; this page stops reading them.
        if (generation !== navigationGeneration || !current()) return;
        const stopped = ['complete', 'failed', 'unknown'].includes(view.background?.state);
        for (const row of plan.rows) {
          // A long plan's view lists its verified uploads by ID only (verified_steps).
          const step =
            view.steps?.find(s => s.id === row.step_id) ??
            (view.verified_steps?.includes(row.step_id) ? {id: row.step_id, status: 'verified'} : undefined);
          if (!step) continue;
          row.state = pushStepState(step);
          if (step.resource_ids?.length) row.result = {media_id: step.resource_ids[0]};
          if (row.state === 'failed') row.error_code = step.error ?? null;
          // The background run ended before this row moved: its plan shows why, and Run continues it.
          if (stopped && ['waiting', 'busy', 'pushing'].includes(row.state)) {
            row.state = 'failed';
            row.error =
              view.background?.error?.message ??
              uiText('The push stopped before this upload. Open its plan to continue it.');
          }
          if (['waiting', 'busy', 'pushing'].includes(row.state)) moving = true;
        }
      }
      drawRows();
      if (!moving) return;
    }
  };
  /**
   * The push driven by this page, when the server does not run it (AMCP_SERVER_PUSH=false): one row at a time, each
   * prepared, queued as a durable job (execute_async) and followed until it ends, so a long upload never waits on one
   * open request and the workspace never holds two staged reviews. Leaving the page stops the rows not yet started.
   */
  const pushInPage = async pending => {
    const generation = navigationGeneration,
      release = pushLeaveGuard();
    try {
      for (const [i, row] of pending.entries()) {
        if (pushNow() + pushRowBudgetMs(row) > pushDeadline(row.source)) {
          skipLate(row);
          drawRows();
          continue;
        }
        status(uiText('Submitting {number} of {count}…', {number: i + 1, count: pending.length}), i, pending.length);
        row.state = 'pushing';
        drawRows();
        try {
          await pushRowInPage(row);
        } catch (e) {
          if (e.code === 'REQUEST_SUPERSEDED') throw e;
          if (generation !== navigationGeneration) return;
          row.state = e.code === 'UPLOAD_DEADLINE_TOO_CLOSE' ? 'expired' : 'failed';
          row.error = e.message;
        }
        // The page changed while this row's job ran: the rows not yet started stay unsent.
        if (!current()) return;
        drawRows();
      }
    } finally {
      release();
    }
    finished(pending);
  };
  /** One row: prepare, reuse or queue it, then follow its durable job to the end. Busy refusals wait and retry. */
  const pushRowInPage = async row => {
    const until = pushRetryUntil(row.source),
      review = await pushRetryBusy(
        () =>
          workspaceCall('media', {
            action: 'prepare',
            ...row.destination,
            source_id: row.source.source_id,
            name: row.name,
            fit_to_platform: row.fit,
            expected_sha256: row.file.sha256,
            ...(row.reuse ? {reuse_existing: true} : {}),
          }),
        until,
      );
    if (review.reused === true) {
      row.result = review;
      row.state = 'reused';
      return;
    }
    row.review_id = review.review_id;
    // A busy refusal comes before the review is claimed, so queueing it again sends nothing twice.
    await pushRetryBusy(
      () => workspaceCall('media', {action: 'execute_async', review_id: review.review_id, confirmed: true}),
      until,
    );
    row.state = 'queued';
    drawRows();
    // The worker uploads it; this page follows the job at a bounded interval. Leaving the page stops following, not
    // the upload: the row keeps its queued state and its original review, where recovery shows how it ended.
    for (let poll = 0; poll < 2700; poll++) {
      const job = await workspaceCall('media', {action: 'job_status', review_id: review.review_id});
      if (job.state === 'complete') {
        row.result = job.result ?? {};
        row.state = job.result?.ready === false ? 'processing' : 'uploaded';
        return;
      }
      if (['failed', 'cancelled'].includes(job.state))
        throw Object.assign(Error(job.error?.message ?? uiText('The upload did not finish.')), {
          code: job.error?.code,
        });
      await pushSleep(pushPollMs);
      if (!current()) return;
    }
  };
  const pushRow = (row, index) => {
    const transform = row.transform,
      file = row.file ? pushFacts({...row.file, duration: row.source.duration}) : '—',
      changes = transform
        ? `<ul>` + transform.reasons.map(r => `<li>` + esc(r) + `</li>`).join('') + `</ul>`
        : row.file
          ? uiText('Nothing: uploaded as it is.')
          : '—',
      state = {
        ready: 'Ready to push',
        refused: 'Not ready',
        waiting: 'Waiting…',
        busy: 'Waiting: AMCP is busy with other media work',
        pushing: 'Pushing…',
        queued: 'Queued — follow durable progress',
        uploaded: 'Uploaded',
        reused: 'Reused after a fresh availability check',
        processing: 'Uploaded; the platform is processing it',
        failed: 'Needs inspection',
        expired: 'Upload again',
      }[row.state],
      detail = row.error
        ? `<p class="form-note">` + esc(row.error) + `</p>`
        : row.error_code
          ? `<p class="form-note"><code dir="ltr">${esc(row.error_code)}</code></p>`
          : row.result?.media_id
            ? `<p class="form-note">${esc(uiText('Media ID'))} ` + esc(row.result.media_id) + `</p>`
            : '',
      // The exact file is already in this account (MED-03 D): reuse it after a fresh check, or upload it again.
      reuse =
        row.state === 'ready' && row.receipts?.length
          ? `<label class="form-note">${esc(uiText('Already in this account'))}<select data-push-reuse="${index}"><option value="reuse"${row.reuse ? ' selected' : ''}>${esc(uiText('Reuse it (fresh availability check)'))}</option><option value="upload"${row.reuse ? '' : ' selected'}>${esc(uiText('Upload it again'))}</option></select></label>`
          : '',
      left = ['ready', 'waiting'].includes(row.state) ? pushRemaining(pushDeadline(row.source)) : '';
    const tone = ['uploaded', 'processing', 'ready', 'reused'].includes(row.state)
      ? 'online'
      : ['refused', 'failed', 'expired'].includes(row.state)
        ? 'attention'
        : 'offline';
    return `<tr><th scope="row">${esc(row.target.label)}</th><td>${esc(row.source.filename)}</td><td>${esc(file)}</td><td>${changes}</td><td><span class="status ${tone}">${esc(uiText(state))}</span>${left ? ` <span id="push-row-left-${index}" class="push-countdown">${esc(uiText('{time} left', {time: left}))}</span>` : ''}${reuse}${detail}${row.review_id ? `<a href="/media?review_id=${encodeURIComponent(row.review_id)}">${esc(uiText('Original upload progress and recovery'))}</a>` : row.plan_id ? `<a href="/campaigns?id=${encodeURIComponent(row.plan_id)}">${esc(uiText('Open its push plan'))}</a>` : ''}</td></tr>`;
  };
  // The countdown: every second while the panel shows, on the server's clock. Only the 10-, 5- and 1-minute marks
  // and deletion are announced, through a polite live region.
  const announced = new Set();
  let ticker;
  const tick = () => {
    if (!current()) {
      if (ticker !== undefined) clearInterval(ticker);
      return;
    }
    const now = pushNow(),
      notes = [];
    sources.forEach((s, i) => {
      const left = pushRemaining(pushDeadline(s), now),
        shown = $('#push-left-' + i);
      if (shown && left) shown.textContent = uiText('{time} left', {time: left});
      const note = pushDeadlineAnnouncement(s, announced, now);
      if (note) notes.push(note);
    });
    rows.forEach((row, j) => {
      const left = pushRemaining(pushDeadline(row.source), now),
        shown = $('#push-row-left-' + j);
      if (shown && left && ['ready', 'waiting'].includes(row.state))
        shown.textContent = uiText('{time} left', {time: left});
    });
    if (notes.length) $('#push-deadline-status').textContent = notes.join(' ');
  };
  if (typeof setInterval === 'function') ticker = setInterval(tick, 1000);
  return {tick};
}

/** Persist the reviewed file/account matrix before any provider upload. The campaign runner owns every review,
 * receipt and continuation, and stages one item at a time. Source expiry remains explicit; it is not permanent storage. */
async function saveCreativePushPlan(rows, acknowledgeTemporary = false) {
  const ready = rows.filter(r => r.state === 'ready');
  if (!ready.length || ready.length > 50) throw Error(uiText('Save 1–50 ready uploads in a resumable plan.'));
  return workspaceCall('campaign', {
    action: 'create',
    name: 'Creative push · ' + ready.length + ' uploads',
    brief:
      'Upload only the previewed files to the selected accounts. Each source hash, native review and receipt is retained. Temporary sources must still be available when the plan runs.',
    // The member saw and accepted the website uploads' deadlines; each step then records its own (owner decision D23).
    ...(acknowledgeTemporary ? {acknowledge_temporary_sources: true} : {}),
    // Each step is named "file → platform · account" and keeps the member's reuse choice (MED-03 A, D).
    steps: ready.map(pushPlanStep),
  });
}
