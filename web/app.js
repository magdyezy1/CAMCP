'use strict';
const $ = s => document.querySelector(s),
  esc = v =>
    String(v ?? '').replace(
      /[&<>"']/g,
      c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c],
    );
const labels = {
  spreadsheets: 'Spreadsheets',
  files: 'Drive files',
  folders: 'Drive folders',
  ad_accounts: 'Ad accounts',
  advertisers: 'Advertisers',
  pages: 'Pages',
  instagram: 'Instagram',
  catalogs: 'Catalogs',
  pixels: 'Pixels',
  mobile_apps: 'Mobile apps',
  custom_conversions: 'Custom conversions',
  profiles: 'Profiles',
  identities: 'Identities',
  properties: 'GA4 properties',
  data_streams: 'Data streams',
  tag_accounts: 'Tag Manager accounts',
  containers: 'Containers & Google tags',
  sites: 'Search Console sites',
  sitemaps: 'Sitemaps',
  locations: 'Business locations',
  business_accounts: 'Business accounts',
};
let session = {authenticated: false, csrf: null},
  platforms = [],
  commerceSources = [],
  // Parked providers this deployment does not offer (ARC-01, P9), from /api/platforms.
  providersNotOffered = [],
  filter = 'all',
  search = '',
  currentPlatform = null,
  currentConnection = null,
  assetKind = 'ad_accounts',
  selected = new Set(),
  writeSelected = new Set(),
  // The accounts checked in the report-job panel (RPT-06).
  reportJobSelected = new Set(),
  // The last Save and check access result of each login, shown inline in the asset manager (CON-05).
  accessChecks = new Map(),
  assetSearch = '',
  client = 'codex',
  tokens = [],
  oauthClients = [],
  oauthEnded = [],
  // The client access sets this person may limit a token or AI client to (SEC-08).
  accessSetChoices = [],
  pollTimer;
let navigationGeneration = 0,
  identityGeneration = 0,
  // The path and query the current view was rendered for; a history step that changes only the fragment keeps it.
  renderedLocation = null,
  // A page holding unsaved edits answers true here, so an in-app link asks before leaving (CMP-06). Every render of a
  // different address and every identity reset clears it, so it never blocks signing out or switching workspace.
  pageLeaveGuard = null;
const identityKey = value =>
  JSON.stringify([!!value.authenticated, value.id ?? value.userId, value.workspaceId, value.workspaceRole, value.csrf]);
/** Clears what the previous identity saw. */
function resetPrivateState() {
  identityGeneration++;
  navigationGeneration++;
  pageLeaveGuard = null;
  clearTimeout(pollTimer);
  clearTimeout(toastTimer);
  platforms = [];
  commerceSources = [];
  providersNotOffered = [];
  tokens = [];
  oauthClients = [];
  oauthEnded = [];
  accessSetChoices = [];
  currentPlatform = currentConnection = null;
  selected.clear();
  writeSelected.clear();
  reportJobSelected.clear();
  accessChecks.clear();
  search = assetSearch = '';
  filter = 'all';
  if (typeof overviewState !== 'undefined')
    overviewState = {
      bootstrap: null,
      config: null,
      report: null,
      page: 0,
      custom: [],
      history: [],
      selection: null,
      destinationId: null,
      loadSequence: (overviewState.loadSequence ?? 0) + 1,
      dirty: false,
    };
  if (typeof recipeDrafts !== 'undefined') recipeDrafts.clear();
  // The palette's workspace search results belong to the previous identity (WEB-09).
  if (typeof commandSearchCache !== 'undefined') {
    commandSearchCache.clear();
    clearTimeout(commandSearchTimer);
    commandSearchSequence++;
  }
  if (typeof loginMfaTicket !== 'undefined') loginMfaTicket = null;
  if (typeof deliveryTimer !== 'undefined') clearTimeout(deliveryTimer);
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  content.innerHTML = '';
  $('#toast').textContent = '';
  $('#toast').hidden = true;
}
/** Signing out or switching workspace also forgets the drafts this tab kept for the identity (CMP-06). */
function resetTabState() {
  resetPrivateState();
  if (typeof recipeDraftsForget === 'function') recipeDraftsForget();
  workingClientForget();
}
function requestError(result, fallback = uiText('This request could not be completed.')) {
  const error = Error(result.error?.message ?? fallback);
  Object.assign(error, result.error ?? {});
  error.requestId = result.meta?.requestId ?? result.meta?.request_id ?? result.request_id;
  const parts = result.meta?.message_parts;
  if (
    parts &&
    typeof parts.base === 'string' &&
    typeof parts.suffix === 'string' &&
    error.message === parts.base.replace(/\.?$/, '') + ': ' + parts.suffix
  )
    error.messageParts = {base: parts.base, suffix: parts.suffix};
  return error;
}
const supersededRequest = () => Object.assign(Error(''), {code: 'REQUEST_SUPERSEDED'});
// The server's clock, learned from the Date header of each AMCP response (WEB-03): a plan approval's 24 hours are
// counted on it, so a device clock that is hours off neither offers Run for an expired approval nor hides it for a
// current one. Without a Date header the device clock is used, as before.
let serverClockOffset = 0;
function noteServerClock(response) {
  const at = Date.parse(response?.headers?.get?.('date') ?? '');
  if (Number.isFinite(at)) serverClockOffset = at - Date.now();
}
const serverNow = () => Date.now() + serverClockOffset;
// WEB-03: one presentation layer for errors. The server writes its messages and remedies for MCP clients as well as
// people; a remedy written for an MCP client ("execute_next", "details.next_call", "send the call again") is replaced by
// what to do on the page, and the server's exact text stays under Technical details. A remedy written for people is
// shown as the server wrote it, in the interface language. tests/website-presentation.test.mjs fails when a remedy
// category, provider layer or run stop has no website wording.
// Text that addresses an MCP client: tool, action and argument names, envelope paths, consent flags, "the call" and
// "the user" (on the website, the person reading is the user).
const agentDirectedText =
  /\b[a-z][a-z0-9]*_[a-z0-9_]+\b|\b(?:details|current)\.[a-z]|\b[a-z_]+:\s*(?:true|false)\b|=true\b|tools\/list|\b(?:the|this|corrected) call\b|\bcall again\b|\(a write is prepared again\)|\bthe user\b/;
/** Whether server text addresses an MCP client rather than the person on the page. */
const agentDirected = text => typeof text === 'string' && agentDirectedText.test(text);
// The website's wording, by error code, for a refusal whose server remedy addresses an MCP client. First match wins.
const websiteRemedies = [
  [
    /^REVIEW_EXPIRED$/,
    'Nothing was sent. Prepare the change again: AMCP reads the current state again and shows you a new review to check.',
  ],
  [
    /^APPROVAL_REQUIRED$/,
    'Open Review whole plan, check every step and approve the plan, then run it again. An approval lasts 24 hours and covers this exact plan only.',
  ],
  [
    /^PLAN_CHANGED$/,
    'The plan changed after you opened its summary. Review the whole plan again and approve the current version.',
  ],
  [
    /^REVIEW_HELD_ELSEWHERE$/,
    'Continue this step where its review was prepared (an AI client or another sign-in). A review that is never executed expires after five minutes, and the step can then be prepared again here.',
  ],
  [
    /^DISTINCT_APPROVER_REQUIRED$/,
    'Share the plan with a colleague as its approver; they approve and run it. The workspace owner sets this rule in Settings.',
  ],
  [
    /^STATE_CHANGED$/,
    'Nothing was sent: the account changed after this review was prepared. Prepare the change again and check the new review.',
  ],
  [
    /^(?:CAP_|SPEND_|CREATIVE_EDIT_|DESTRUCTIVE_)?CONFIRMATION_REQUIRED$/,
    'The review is still valid. Tick the authorization it asks for, then execute it again; there is no need to prepare it again.',
  ],
  // WRT-09's opt-in approval settings: a person's approval on the website, which no AI client can give.
  [
    /^HUMAN_APPROVAL_REQUIRED$/,
    'Approve this exact review on its approval page in Operations, or ask a colleague the workspace’s rule allows. Then execute it again before the review expires; there is no need to prepare it again.',
  ],
  [
    /^CAP_OVERRIDE_OWNER_REQUIRED$/,
    'Ask the workspace owner to execute this change, or to approve its review on the approval page in Operations first, as the message says.',
  ],
  [
    /^RESOURCE_SCOPE_REQUIRED$/,
    'AMCP could not confirm that this object belongs to the selected account. Check the account and the object, then try again.',
  ],
  [
    /^CONNECTOR_READ_ONLY$/,
    'Your access to this workspace is read-only. Ask a workspace administrator for a role that makes reviewed changes.',
  ],
  [
    /^AMBIGUOUS_CONNECTION$/,
    'More than one login covers this account. Choose the login on this page, or set a default login on the Connections page.',
  ],
  [
    /^(?:CONNECTION_NOT_FOUND|CONNECTION_ID_REQUIRED|CREDENTIALS_REQUIRED|CONNECTION_REQUIRED)$/,
    'Choose a login that includes this account, or connect the provider and select the account on the Connections page.',
  ],
  [
    /^REVISION_CONFLICT$/,
    'Someone changed this since you opened it. Refresh the page to see the current version, then try again.',
  ],
  [/^DEPENDENCY_PENDING$/, 'Wait until the step this one depends on is verified, then review the next step again.'],
  [
    /^WRITE_REJECTED$/,
    'Nothing was applied, and this change is never sent again. Correct what the provider’s message names and prepare a new review; in a campaign plan, correct the blocked step.',
  ],
  [
    /^PLAN_LIMIT_REACHED$/,
    'Archive complete, cancelled or superseded plans on the Campaigns page. Archived plans stay readable and no longer count toward the limit.',
  ],
  [/^PLAN_ARCHIVED$/, 'Unarchive the plan on the Campaigns page to work on it again.'],
  [
    /^POLICY_REQUIRED$/,
    'Nothing was sent. This change needs a spending policy on the account: the workspace owner saves one in Settings, then prepare the change again.',
  ],
  // Owner decision P5: caps in account currency that name no currency refuse budget and bid changes until saved again.
  [
    /^POLICY_CURRENCY_UNSET$/,
    'Nothing was sent. The workspace owner saves this account’s spending policy again in Settings, with the currency its caps are stated in; then prepare the change again.',
  ],
  [
    /^(?:MEDIA_SOURCE_NOT_FOUND|MEDIA_UPLOAD_COMPLETE)$/,
    'Uploads last 30 minutes. Choose a current upload on the Media page, or upload the file again.',
  ],
  [
    /(?:^|_)MEDIA_(?:NOT_READY|CONVERSION_INCOMPLETE)$/,
    'The media is still processing. Check it on the Media page and continue once it is ready.',
  ],
  [
    /^(?:MEDIA_MEMORY_BUSY|MEDIA_UPLOAD_BUSY)$/,
    'Another upload is in progress. Wait a moment, then check this upload on the Media page before you try again.',
  ],
  [
    /^(?:MEDIA_ADMISSION_LOST|MEDIA_UPLOAD_LEASE_LOST|MEDIA_UPLOAD_URL_EXPIRED|RECOVERY_NOT_SAFE)$/,
    'AMCP never repeats an upload or step whose outcome is not confirmed. Check its recovery in Operations before you do anything else.',
  ],
  [
    /^(?:RECIPE_|DESTINATION_REQUIRED$)/,
    'Supply or correct the recipe input the message names, then preview the recipe again.',
  ],
  [
    /^PROGRAM_/,
    'Choose a configured account and supply what the message names, then check again. This check only reads; nothing is prepared or changed.',
  ],
  [
    /^SNAPCHAT_PIXEL_NOT_OWNED$/,
    'Nothing was sent. Correct the blocked step with a pixel this ad account owns, or have the pixel’s owner share it to the ad account in Snapchat Business Manager.',
  ],
  [
    /^STATE_TARGET_MISMATCH$/,
    'The provider returned a different object, parent or account than this request names. Check that every ID belongs to the selected account and login, then try again.',
  ],
  [
    /_SCOPE_REQUIRED$/,
    'Reconnect the login on the Connections page with the permission the message names, then try again.',
  ],
  [
    /(?:^|_)NOT_FOUND$/,
    'The object the message names is not in this account or workspace. Check the account’s own list for the right ID, then try again.',
  ],
];
// Who must act on a provider refusal, as the provider-error layer (PRV-01) names it; an unknown cause is never guessed.
const providerLayerRemedies = {
  credential: 'The provider ended this login’s access. Reconnect the login on the Connections page.',
  consent:
    'The login has not granted the permission the provider needs. Reconnect it on the Connections page and grant that permission.',
  role_or_asset_access:
    'The login’s role on this account does not allow this. Ask an administrator of the account at the provider to give the login access.',
  app_eligibility:
    'The provider has not approved AMCP’s application for this feature. Only the deployment owner can apply for that access.',
  rate_limit: 'The provider is limiting requests for now. Nothing more was sent; try again after a short wait.',
  api_version: 'The provider no longer accepts the API version AMCP used. The deployment owner needs to update AMCP.',
};
// When the server's remedy addresses an MCP client and no code above applies, its category decides the wording.
const websiteCategoryRemedies = {
  request: 'Check the values you entered or selected, correct what the message names, then try again.',
  state: 'Refresh the page to see the current state, then try again.',
  provider:
    'The provider did not complete this. Try again later; if it keeps happening, share the reference with the workspace owner.',
  grant:
    'This login or account is missing access for this. Check it on the Connections page or ask the workspace owner.',
  permission: 'Your role in this workspace does not include this. Ask the workspace owner.',
  policy: 'A workspace policy stopped this. The workspace owner manages it in Settings.',
  deployment: 'This AMCP deployment is not set up for this. Share the reference with the workspace owner.',
  contract: 'AMCP does not support this here. Choose another option on this page.',
  report:
    'The report could not be completed as asked. Narrow it (a shorter date range, fewer accounts or metrics) or try again later.',
  auth: 'Sign in again, then try again.',
  confirmation: 'Confirm the choice shown on this page, then try again.',
  discovery: 'Refresh this login’s accounts on the Connections page, then try again.',
  internal: 'Something went wrong in AMCP. Share the reference with the workspace owner.',
};
// A server message that addresses an MCP client, by code: the website states the cause in its own words.
const websiteMessages = {
  APPROVAL_REQUIRED: raw =>
    /another connection/.test(raw)
      ? 'This plan was approved from another connection (an AI client or another sign-in). Approve it here to run it here.'
      : 'This plan has no current approval.',
  // WRT-09: the server's messages name website_path and the acknowledgement flag for MCP clients.
  HUMAN_APPROVAL_REQUIRED: () =>
    'The owner requires a person’s approval on the AMCP website before this change is executed. Nothing was sent.',
  CAP_OVERRIDE_OWNER_REQUIRED: () =>
    'Only the workspace owner executes a change beyond a spending cap the owner set. Nothing was sent.',
  DESTRUCTIVE_CONFIRMATION_REQUIRED: () =>
    'The owner requires an explicit acknowledgement before anything is deleted on this account. Nothing was sent.',
};
// Codes whose server wording suits an MCP client but is technical for a person ("a new idempotency key"): the page
// says them in its own words whatever the server wrote, and keeps the server's text under Technical details (design
// review 2026-10). [message, what to do].
const websiteWording = {
  WRITE_OUTCOME_UNCERTAIN: [
    'The provider’s answer to this change was lost, so AMCP cannot confirm whether it was applied.',
    'AMCP never sends it again. Read it back to check the account; a read-back changes nothing.',
  ],
};
/** The page's own message for an error, or ''. */
function websiteOwnMessage(error) {
  return Object.hasOwn(websiteWording, error?.code ?? '') ? uiText(websiteWording[error.code][0]) : '';
}
/** The remedy as the website words it, or ''. */
function websiteRemedy(error) {
  const code = typeof error?.code === 'string' ? error.code : '',
    layer = error?.details?.layer;
  if (Object.hasOwn(websiteWording, code)) return uiText(websiteWording[code][1]);
  if (typeof layer === 'string' && Object.hasOwn(providerLayerRemedies, layer))
    return uiText(providerLayerRemedies[layer]);
  const server =
    error?.next_action ??
    error?.remedy?.action ??
    error?.remedy?.message ??
    error?.remedy?.next_action ??
    error?.details?.next_action;
  if (typeof server !== 'string' || !server) return '';
  if (!agentDirected(server)) return uiText(server);
  const rule = websiteRemedies.find(([pattern]) => pattern.test(code));
  if (rule) return uiText(rule[1]);
  const category = typeof error.category === 'string' ? error.category : error.remedy?.category,
    fallback = uiText(websiteCategoryRemedies[Object.hasOwn(websiteCategoryRemedies, category) ? category : 'request']);
  // The safety facts such a remedy states are kept in the website's words: a leading "Nothing was sent", and a write
  // that is never sent again or a failed read that never authorizes one, wherever the server put it.
  return [
    /^Nothing was (?:submitted|sent|prepared)\b/.test(server) ? uiText('Nothing was sent.') : '',
    fallback,
    ...websiteSafetyFacts.filter(([pattern]) => pattern.test(server)).map(([, text]) => uiText(text)),
  ]
    .filter(Boolean)
    .join(' ');
}
// Safety facts of a server remedy that the website keeps when the rest of it gives way to the page's wording (WEB-03).
const websiteSafetyFacts = [
  [
    /never resubmit|is never resubmitted|do not send it again|never sent again/i,
    'A change whose outcome is not confirmed is never sent again.',
  ],
  [/never authorizes a write/i, 'A failed or incomplete read never authorizes a change.'],
];
/**
 * The provider's own facts about a refusal (owner decision D21): its HTTP status, its error code and its request ID,
 * from allow-listed detail fields of a provider refusal only. A provider body, message or token is never shown here.
 */
function providerFacts(error) {
  const d = error?.details && typeof error.details === 'object' ? error.details : {};
  // Only a provider's refusal: the transport keeps the provider's answer (upstream) and its layer, and a PROVIDER_ code
  // names the provider's HTTP status. An http_status of AMCP's own or of a link or Drive download is not the provider's
  // answer, and a request ID alone may be AMCP's.
  if (
    d.upstream === undefined &&
    typeof d.layer !== 'string' &&
    !(/^PROVIDER_/.test(String(error?.code ?? '')) && Number.isInteger(d.http_status))
  )
    return null;
  const status = Number.isInteger(d.http_status) && d.http_status >= 100 && d.http_status <= 599 ? d.http_status : null,
    code = Number.isSafeInteger(d.provider_code)
      ? String(d.provider_code)
      : typeof d.provider_code === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(d.provider_code)
        ? d.provider_code
        : null,
    requestId =
      typeof d.request_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:+=\/-]{0,127}$/.test(d.request_id)
        ? d.request_id
        : null;
  return status === null && code === null && requestId === null ? null : {status, code, requestId};
}
/** An error as its parts: AMCP's or the provider's message, what to do on the page, provider facts and the reference. */
function errorParts(error) {
  if (!error || error.code === 'REQUEST_SUPERSEDED') return {message: '', remedy: '', provider: '', reference: ''};
  const parts = error.messageParts,
    split =
      parts &&
      typeof parts.base === 'string' &&
      typeof parts.suffix === 'string' &&
      error.message === parts.base.replace(/\.?$/, '') + ': ' + parts.suffix,
    raw = typeof error.message === 'string' ? error.message : '',
    facts = providerFacts(error);
  return {
    message: split
      ? uiText(parts.base).replace(/\.?$/, '') + ': ' + parts.suffix
      : websiteOwnMessage(error) ||
        (Object.hasOwn(websiteMessages, error.code) && agentDirected(raw)
          ? uiText(websiteMessages[error.code](raw))
          : uiText(raw)),
    remedy: websiteRemedy(error),
    provider: facts
      ? [
          facts.status !== null ? uiText('Provider response: HTTP {status}.', {status: facts.status}) : '',
          facts.code !== null && facts.code !== String(facts.status)
            ? uiText('Provider code: {code}.', {code: facts.code})
            : '',
          facts.requestId !== null ? uiText('Provider request ID: {id}.', {id: facts.requestId}) : '',
        ]
          .filter(Boolean)
          .join(' ')
      : '',
    reference: error.requestId ? uiText('Reference: {id}', {id: error.requestId}) : '',
  };
}
const errorPartList = parts => [parts.message, parts.remedy, parts.provider, parts.reference].filter(Boolean);
/** The error as one line, for a toast: its message, what to do, the provider's facts and the reference. */
function errorMessage(error) {
  return errorPartList(errorParts(error)).join(' ');
}
/** The same parts one per line, for an alert whose text keeps its line breaks (white-space: pre-line). */
function errorLines(error) {
  return errorPartList(errorParts(error)).join('\n');
}
/** The server's exact error text, kept under Technical details: its code, message and remedy, never a provider body. */
function errorTechnical(error) {
  if (typeof error?.code !== 'string' || error.code === 'REQUEST_SUPERSEDED') return null;
  const remedy = error.next_action ?? error.remedy?.action;
  return {
    code: error.code,
    message: typeof error.message === 'string' ? error.message : '',
    ...(typeof remedy === 'string' ? {next_action: remedy} : {}),
  };
}
/** The error as markup: one paragraph per part, then the server's exact text under Technical details. */
function errorBlock(error) {
  const parts = errorParts(error),
    technical = errorTechnical(error);
  if (!parts.message && !parts.remedy) return '';
  return (
    errorPartList(parts)
      .map((line, i) => `<p${i ? ' class="form-note"' : ''}>${esc(line)}</p>`)
      .join('') +
    (technical
      ? `<details class="error-technical"><summary>${esc(uiText('Technical details'))}</summary><pre class="code-block" dir="ltr" tabindex="0" role="region" aria-label="${esc(uiText('Technical details'))}">${esc(JSON.stringify(technical, null, 2))}</pre></details>`
      : '')
  );
}
const content = $('#content'),
  date = v => (v ? uiDate(v) : uiText('Not synced'));
// A new message restarts the timer; before, an older timer could hide a newer message after a second.
// One styled confirmation for destructive actions: it names the consequence, and Cancel has focus. Escape cancels.
function confirmAction({title, consequence, confirmLabel = 'Confirm', items = []}) {
  const d = $('#action-dialog');
  $('#action-title').textContent = uiText(title);
  $('#action-copy').textContent = uiText(consequence);
  // What the action changes, one item each, when the caller names it (a spending policy's weakenings).
  d.querySelector?.('#action-items')?.remove();
  if (items.length) {
    const list = document.createElement('ul');
    list.id = 'action-items';
    for (const item of items) {
      const li = document.createElement('li');
      li.textContent = item;
      list.append(li);
    }
    $('#action-copy').after(list);
  }
  d.setAttribute?.('aria-describedby', items.length ? 'action-copy action-items' : 'action-copy');
  $('#action-confirm').textContent = uiText(confirmLabel);
  return new Promise(resolve => {
    const cancel = $('#action-cancel'),
      confirm = $('#action-confirm');
    const keydown = event => {
      if (event.key !== 'Tab') return;
      if (!event.shiftKey && document.activeElement === confirm) {
        event.preventDefault();
        cancel.focus();
      } else if (event.shiftKey && document.activeElement === cancel) {
        event.preventDefault();
        confirm.focus();
      }
    };
    const closed = () => {
      d.removeEventListener('close', closed);
      d.removeEventListener('keydown', keydown);
      resolve(d.returnValue === 'confirm');
    };
    d.addEventListener('close', closed);
    d.addEventListener('keydown', keydown);
    d.returnValue = '';
    d.showModal();
    cancel.focus();
  });
}
let toastTimer;
function toast(message) {
  if (!message) return;
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => {
    $('#toast').hidden = true;
  }, 6000);
}
// A page that fails to open says why and offers a way on, instead of a six-second toast over a page stuck loading.
const pageErrorCauses = {
  NOT_FOUND: 'This link has expired or belongs to another workspace.',
  CSRF_INVALID: 'Your session changed in another tab. Refresh the page and try again.',
  FORBIDDEN: 'Your role in this workspace does not include this page.',
  FORBIDDEN_ORIGIN: 'Open AMCP from its own address and try again.',
};
function showPageError(e) {
  const reload = e?.code === 'PAGE_ASSET_RELOAD_REQUIRED';
  content.innerHTML =
    `<section class="panel page-error" role="alert"><h1 tabindex="-1">${esc(e?.updated ? uiText('AMCP was updated') : uiText('This page could not open'))}</h1>` +
    // WEB-03: one paragraph per part, so the cause, what to do and the reference never run together.
    errorBlock({...e, message: pageErrorCauses[e?.code] ?? e?.message ?? 'Something went wrong.'}) +
    `<div class="dialog-actions"><button class="button primary" type="button" data-retry-page>${esc(uiText(reload ? 'Reload page' : 'Try again'))}</button><a class="button" href="/connections">${esc(uiText('Back to Connections'))}</a></div></section>`;
  content.querySelector('[data-retry-page]').addEventListener('click', () => (reload ? reloadPage() : render()));
  content.querySelector('h1').focus();
}
/** Reloads the document, asking first while it still holds unsaved edits: a reload never discards them silently. */
async function reloadPage() {
  if (
    uiHasUnsavedEdits() &&
    !(await confirmAction({
      title: uiText('Reload AMCP?'),
      consequence: uiText(
        'Unsaved edits on this page will be cleared. Save any recovery codes or one-time tokens first. Saved work is kept.',
      ),
      confirmLabel: uiText('Reload page'),
    }))
  )
    return false;
  location.reload();
  return true;
}
// AMCP was updated while this page was open: its files belong to a snapshot the server no longer has, so only a reload
// can continue (WEB-04). The person chooses when, after saving what they need; `prepare` runs only when they confirm.
async function reloadForUpdate(prepare) {
  const confirmed = await confirmAction({
    title: uiText('AMCP was updated'),
    consequence: uiHasUnsavedEdits()
      ? uiText(
          'Reload to continue. Unsaved edits on this page will be cleared, so save them first. Saved work is kept.',
        )
      : uiText('Reload to continue. Saved work is kept.'),
    confirmLabel: uiText('Reload page'),
  });
  if (!confirmed) return false;
  prepare?.();
  location.reload();
  return true;
}
/**
 * "Confirm it's you" (SEC-06): a sensitive change made long after sign-in is refused with REAUTH_REQUIRED before it has
 * any effect. This dialog proves the person again in place, with a password, a two-step code or a linked social
 * sign-in, so the page and its form keep their state. Resolves true once the server accepted the proof, false when
 * the person cancels. A social confirmation leaves the page and returns to it afterwards.
 */
function confirmIdentity() {
  const d = $('#reauth-dialog'),
    form = $('#reauth-form'),
    password = $('#reauth-password'),
    code = $('#reauth-code'),
    error = $('#reauth-error');
  if (!d || !form) return Promise.resolve(false);
  const usesPassword = session.hasPassword !== false,
    usesCode = session.mfaEnabled === true,
    providers = session.administrator || session.testAccount ? [] : (session.identities ?? []).map(i => i.provider);
  $('#reauth-password-field').hidden = !usesPassword;
  $('#reauth-code-field').hidden = !usesCode;
  $('#reauth-social').innerHTML = providers
    .map(
      p =>
        `<button type="button" class="button" data-reauth-social="${esc(p)}">${esc(uiText('Confirm with {provider}', {provider: p === 'google' ? 'Google' : p === 'apple' ? 'Apple' : p === 'facebook' ? 'Facebook' : p}))}</button>`,
    )
    .join('');
  password.value = code.value = error.textContent = '';
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      form.removeEventListener('submit', submit);
      $('#reauth-cancel').removeEventListener('click', cancel);
      $('#reauth-social').removeEventListener('click', social);
      d.removeEventListener('close', cancel);
      password.value = code.value = '';
      if (d.open) d.close();
      resolve(value);
    };
    const cancel = () => finish(false);
    const submit = async event => {
      event.preventDefault();
      const button = $('#reauth-confirm');
      button.disabled = true;
      error.textContent = '';
      try {
        await api('/api/account/reauthenticate', {
          method: 'POST',
          body: JSON.stringify(code.value.trim() ? {code: code.value.trim()} : {password: password.value}),
        });
        finish(true);
      } catch (e) {
        error.textContent = errorMessage(e);
      } finally {
        button.disabled = false;
      }
    };
    const social = async event => {
      const provider = event.target.closest?.('[data-reauth-social]')?.dataset.reauthSocial;
      if (!provider) return;
      try {
        sessionStorage.setItem('amcp.return', location.pathname + location.search);
        const r = await api('/api/signin/' + provider + '/start', {
          method: 'POST',
          body: JSON.stringify({reauth: true}),
        });
        location.assign(r.url);
      } catch (e) {
        error.textContent = errorMessage(e);
      }
    };
    form.addEventListener('submit', submit);
    $('#reauth-cancel').addEventListener('click', cancel);
    $('#reauth-social').addEventListener('click', social);
    d.addEventListener('close', cancel);
    d.showModal();
    (usesPassword ? password : usesCode ? code : d.querySelector('[data-reauth-social]'))?.focus();
  });
}
async function api(url, options = {}) {
  const generation = navigationGeneration,
    identity = identityGeneration;
  // `reauthRetried` marks the one repeat after "Confirm it's you"; it is not a fetch option.
  const {reauthRetried, ...init} = options;
  const method = init.method ?? 'GET',
    headers = {
      'Accept': 'application/json',
      ...(method !== 'GET' ? {'Content-Type': 'application/json', 'X-AMCP-CSRF': session.csrf ?? ''} : {}),
      ...init.headers,
    };
  let response, data;
  try {
    response = await fetch(url, {...init, headers, credentials: 'same-origin'});
    noteServerClock(response);
    data = await response.json();
  } catch {
    if (generation !== navigationGeneration || identity !== identityGeneration) throw supersededRequest();
    throw Error(uiText('AMCP could not read the server response.'));
  }
  if (generation !== navigationGeneration || identity !== identityGeneration) throw supersededRequest();
  if (!response.ok) {
    const e = requestError(data);
    // The server refused before any effect; after the person confirms, the same request is sent exactly once more.
    if (e.code === 'REAUTH_REQUIRED' && !reauthRetried && url !== '/api/account/reauthenticate') {
      const confirmed = await confirmIdentity();
      if (generation !== navigationGeneration || identity !== identityGeneration) throw supersededRequest();
      if (confirmed) return api(url, {...init, reauthRetried: true});
    }
    if (response.status === 401 && !url.startsWith('/api/account/') && !url.startsWith('/api/session')) {
      resetPrivateState();
      session = {authenticated: false, csrf: null};
      showLogin();
    }
    throw e;
  }
  if (url === '/api/session' && method === 'GET' && identityKey(session) !== identityKey(data)) resetPrivateState();
  if (url === '/api/session' && method === 'DELETE') resetTabState();
  if (url === '/api/workspaces/switch') resetTabState();
  return data;
}
function showLogin() {
  if (location.pathname === '/login') return;
  if (!['/signup', '/forgot-password', '/verify-email', '/reset-password'].includes(location.pathname))
    sessionStorage.setItem('amcp.return', location.pathname + location.search);
  navigate('/login');
}
function requireLogin() {
  if (session.authenticated) return true;
  showLogin();
  return false;
}
function logo(p) {
  return html`<span class="platform-logo ${p.id}" aria-hidden="true">${p.logo}</span>`;
}
/** The element a same-page fragment names, or null. Fragments only ever select an existing element by its ID. */
function fragmentTarget(hash) {
  if (!hash || hash.length < 2 || !hash.startsWith('#')) return null;
  try {
    return document.getElementById(decodeURIComponent(hash.slice(1)));
  } catch {
    return null;
  }
}
/** Moves keyboard focus to a section of the current page, opening it when it is a disclosure. */
function focusFragmentTarget(target) {
  if (target.tagName === 'DETAILS') target.open = true;
  if (!target.matches?.('a[href],button,input,select,textarea,summary,[tabindex]'))
    target.setAttribute('tabindex', '-1');
  target.scrollIntoView({block: 'start'});
  target.focus({preventScroll: true});
}
async function navigate(route) {
  // The next page keeps the working client in its address (SEC-08).
  route = withWorkingClient(route);
  history.pushState({}, '', route);
  await render();
  // render() keeps the working client in the address, or drops a stale one: that is still the page opened here.
  if (!sameAddressIgnoringClient(location.pathname + location.search + location.hash, route)) return;
  let target = fragmentTarget(location.hash);
  if (!target && location.pathname === '/reporting-overview' && new URLSearchParams(location.search).has('report_id'))
    target = document.getElementById('overview-results');
  if (target) focusFragmentTarget(target);
  else {
    window.scrollTo(0, 0);
    focusPageHeading();
  }
}
/**
 * Records a page's own state (a selection, a drill-down) in the address without re-rendering it, so Back returns to
 * the previous state and a reload restores it (WEB-06). The view stays rendered for the new address.
 */
function setViewLocation(url, push = false) {
  // A page's own state keeps the working client in the address (SEC-08).
  url = withWorkingClient(url);
  if (url === location.pathname + location.search + location.hash) return;
  history[push ? 'pushState' : 'replaceState']({}, '', url);
  renderedLocation = location.pathname + location.search;
}
/** After a page opens, keyboard and screen-reader focus starts on its heading (WEB-06), or on the main region. */
function focusPageHeading() {
  const heading = content.querySelector('h1');
  if (heading) {
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    heading.focus({preventScroll: true});
  } else document.getElementById('main').focus({preventScroll: true});
}
// The page key comes from the route registry (web/routes.js, WEB-06). Only the connections page and a provider's
// connection flow belong to Connections; the legal and sign-in pages belong to no section of the navigation (F-43).
function route() {
  return routeSection(location.pathname);
}
function header(title, description, action = '') {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div>${action}</div>`;
}
function connectionCount(p) {
  return p.connections.length;
}
function assetsFor(p, kind) {
  return new Set(p.connections.flatMap(c => (c.groups.find(g => g.kind === kind)?.assets ?? []).map(a => a.id))).size;
}
/** Whether the open platform's logins may select assets of this kind (Drive: files and folders). */
function selectableKind(kind) {
  const p = platforms.find(p => p.id === currentPlatform);
  return (p?.selectableKinds ?? [p?.selectionKind ?? 'ad_accounts']).includes(kind);
}
/** An account's own name as the last sync of this login read it, or null when no sync named it. */
function accountDisplayName(c, id) {
  const bare = v => String(v).replace(/^act_/, '');
  for (const g of c.groups ?? [])
    for (const a of g.assets ?? [])
      if (bare(a.id) === bare(id) && a.source !== 'configured_binding' && a.name && bare(a.name) !== bare(id))
        return a.name;
  return null;
}
/** An account as the website names it within its platform: its name and ID, and its login when there are several. */
function accountText(p, c, id) {
  const name = accountDisplayName(c, id),
    logins = p.connections.filter(x => x.enabled).length;
  return (name ? name + ' (' + id + ')' : id) + (logins > 1 ? ' · ' + (c.name ?? c.label ?? '') : '');
}
/**
 * accountText as escaped markup for running text (WEB-05): the label is isolated from the text around it, the name and
 * login keep their own direction, and the ID reads left to right inside Arabic. Option labels keep accountText.
 */
function accountHtml(p, c, id) {
  const name = accountDisplayName(c, id),
    logins = p.connections.filter(x => x.enabled).length;
  return (
    '<bdi>' +
    (name ? uiBidi(name) + ' (' + uiBidi(id, 'ltr') + ')' : uiBidi(id, 'ltr')) +
    (logins > 1 ? ' · ' + uiBidi(c.name ?? c.label ?? '') : '') +
    '</bdi>'
  );
}
/** The same with its platform first, for lists that mix platforms. */
function accountLabel(p, c, id) {
  return p.name + ' · ' + accountText(p, c, id);
}
function accountLabelHtml(p, c, id) {
  return '<bdi>' + uiBidi(p.name) + ' · ' + accountHtml(p, c, id) + '</bdi>';
}
/** The platform and login a stored record (a receipt, a review) names through its platform, login and account. */
function recordAccountSource(platform, connectionId, id) {
  const p = platforms.find(
      x => x.id === platform || x.gateway === platform + '_native_action' || x.gateway === platform,
    ),
    c = p?.connections.find(x => x.id === connectionId) ?? p?.connections.find(x => x.accounts?.includes(String(id)));
  return {p, c};
}
/** The same name for a stored record. */
function recordAccountLabel(platform, connectionId, id) {
  const {p, c} = recordAccountSource(platform, connectionId, id);
  return p && c ? accountLabel(p, c, id) : (p?.name ?? platform) + ' · ' + id;
}
function recordAccountLabelHtml(platform, connectionId, id) {
  const {p, c} = recordAccountSource(platform, connectionId, id);
  return p && c
    ? accountLabelHtml(p, c, id)
    : '<bdi>' + uiBidi(p?.name ?? platform) + ' · ' + uiBidi(id, 'ltr') + '</bdi>';
}
function renderConnections() {
  const connected = platforms.filter(p => connectionCount(p) > 0),
    accounts = new Set(platforms.flatMap(p => p.connections.flatMap(c => c.accounts.map(a => p.id + ':' + a)))),
    logins = platforms.reduce((n, p) => n + p.connections.length, 0);
  setHtml(
    content,
    html`${raw(header(uiText('Connections'), uiText('Connect your platforms. Choose what AMCP can access.'), html`<button class="button" data-action="refresh">↻ <span>${uiText('Refresh')}</span></button>`))}${!session.authenticated ? html`<div class="notice"><span>◈</span><p><strong>${uiText('Your workspace, securely connected.')}</strong><br>${uiText('Sign in to manage platform logins and choose your advertising assets.')}</p><button class="button dark" data-action="login">${uiText('Sign in →')}</button></div>` : ''}<div class="stat-grid"><div class="stat"><div><div class="stat-label">${uiText('Connected platforms')}</div><div class="stat-value">${connected.length}<span class="muted stat-denominator"> / ${platforms.length}</span></div></div><span class="stat-icon" aria-hidden="true">◈</span></div><div class="stat"><div><div class="stat-label">${uiText('Selected accounts & properties')}</div><div class="stat-value">${accounts.size}</div></div><span class="stat-icon" aria-hidden="true">▦</span></div><div class="stat"><div><div class="stat-label">${uiText('Secure logins')}</div><div class="stat-value">${logins}</div></div><span class="stat-icon" aria-hidden="true">↗</span></div></div><div class="section-tools"><div class="filter-tabs" role="group" aria-label="${uiText('Filter platforms')}"><button class="filter-tab ${filter === 'all' ? 'active' : ''}" data-filter="all">${uiText('All platforms')} <span class="muted">${platforms.length}</span></button><button class="filter-tab ${filter === 'connected' ? 'active' : ''}" data-filter="connected">${uiText('Connected')} <span class="muted">${connected.length}</span></button></div><label class="search"><span aria-hidden="true">⌕</span><input id="platform-search" type="search" value="${search}" placeholder="${uiText('Search platforms…')}" aria-label="${uiText('Search platforms')}"></label></div><div class="platform-grid" id="platform-grid"></div>`,
  );
  renderPlatformCards();
}
function renderPlatformCards() {
  const visible = platforms.filter(
    p => (filter === 'all' || p.connections.length) && p.name.toLowerCase().includes(search.toLowerCase()),
  );
  const card = p => {
    const n = p.connections.length,
      // A login the provider no longer accepts is never shown as Connected (CON-02).
      dead = p.connections.some(c => c.status === 'reauthorization_required'),
      attention = dead || p.connections.some(c => c.error || c.status === 'expiring_soon'),
      status = dead
        ? uiText('Reauthorization required')
        : attention
          ? uiText('Needs attention')
          : n
            ? uiText('Connected')
            : uiText('Not connected'),
      metrics = p.assetKinds.slice(0, 3);
    while (metrics.length < 3) metrics.push(metrics.length === 1 ? 'logins' : 'selected');
    return html`<article class="platform-card"><div class="platform-main"><div class="platform-top"><div class="platform-identity">${logo(p)}<div><div class="platform-name">${p.name}</div><div class="platform-kind">${uiText(p.kind)}</div></div></div><span class="status ${attention ? 'attention' : n ? 'online' : 'offline'}"><i></i>${status}</span></div><p class="platform-description">${uiText(p.description)}</p><div class="platform-bottom"><span class="platform-login">${n ? uiText('Connected logins: {count}', {count: uiNumber(n)}) : p.configured ? uiText('Ready to connect') : uiText('Administrator setup required')}</span><div class="platform-actions"><button class="button small" data-manage="${p.id}">${uiText('Manage')}</button><button class="button small ${n ? '' : 'primary'}" data-connect="${p.id}">${n ? uiText('+ Add login') : p.configured ? uiText('+ Connect') : uiText('Set up →')}</button></div></div></div><div class="platform-metrics">${metrics.map(k => html`<div><small>${uiText(labels[k] ?? k).toUpperCase()}</small><b>${k === 'logins' ? n : k === 'selected' ? p.connections.reduce((v, c) => v + c.accounts.length, 0) : assetsFor(p, k)}</b></div>`)}</div></article>`;
  };
  setHtml(
    $('#platform-grid'),
    visible.length
      ? html`${visible.map(card)}`
      : html`<div class="empty">${uiText('No platforms match your search.')}</div>`,
  );
}
function renderConnectionSyncStatus(c) {
  if (!c?.lastSync) return '';
  const reason = c.groups?.flatMap(g => g.diagnostics ?? []).find(d => d.provider?.code)?.provider?.code;
  return (
    `<div class="notice connection-sync-status" role="status"><div><strong>` +
    esc(c.error ? uiText('Sync needs attention') + (reason ? ' — ' + reason : '') : uiText('Sync completed')) +
    `</strong><p class="small-text">` +
    esc(date(c.lastSync)) +
    (c.error
      ? ' · ' + uiText('Review the provider details below. Your saved login and selections are retained.')
      : ' · ' + uiText('The requested assets were refreshed.')) +
    `</p></div></div>`
  );
}
/** One line of recorded login health (CON-02); never a token or its first-hour expiry. */
function loginHealthLine(login) {
  const h = login.credentialHealth ?? {},
    expiry = h.login_expires_at ? uiText('Login expires {date}', {date: date(h.login_expires_at)}) : '';
  if (h.state === 'reauthorization_required') return uiText('Reauthorization required');
  if (h.state === 'credentials_unreadable') return uiText('Saved login cannot be read by this server');
  if (h.state === 'refresh_failed') return uiText('Renewal failed; AMCP retries automatically');
  if (h.state === 'client_changed') return uiText('Saved OAuth client differs; reauthorize');
  if (h.state === 'expiring') return uiText('Expiring soon') + (expiry ? ' · ' + expiry : '');
  if (h.renews_automatically) return uiText('Access renews automatically') + (expiry ? ' · ' + expiry : '');
  return expiry || uiText('Expiry not provided');
}
/** A reviewer workspace login's age and automatic removal (SEC-06), as text; empty for every other login. */
function reviewerLoginLine(login) {
  if (!login.reviewerRemovesAt) return '';
  return (
    ' · ' +
    (login.connectedAt
      ? uiText('Connected {connected} · removed automatically {date}', {
          connected: date(login.connectedAt),
          date: date(login.reviewerRemovesAt),
        })
      : uiText('Removed automatically {date}', {date: date(login.reviewerRemovesAt)}))
  );
}
function renderCredentialHealth(c) {
  const h = c?.credentialHealth;
  if (
    !h ||
    !['reauthorization_required', 'refresh_failed', 'expiring', 'client_changed', 'credentials_unreadable'].includes(
      h.state,
    )
  )
    return '';
  const failure = h.last_failure
    ? html`<p class="small-text">${uiText('Last renewal attempt: {date}', {date: date(h.last_failure.at)})}${h.last_failure.http_status ? ' · HTTP ' + String(h.last_failure.http_status) : ''}${h.last_failure.code ? ' · ' + h.last_failure.code : ''}</p>`
    : '';
  const text =
    h.state === 'reauthorization_required'
      ? uiText(
          'This login no longer works. Reauthorize it to keep this connection, its selections, saved reports and schedules.',
        )
      : h.state === 'refresh_failed'
        ? uiText('AMCP could not renew access. It retries after a short pause; Retry renewal asks again now.')
        : h.state === 'client_changed'
          ? uiText('This login was authorized with a different OAuth client. Reauthorize it with the current client.')
          : h.state === 'credentials_unreadable'
            ? uiText(
                'AMCP cannot open this saved login, usually because the server encryption key is missing or changed. The deployment administrator should restore the key; reauthorizing replaces the saved login.',
              )
            : uiText('This login expires soon and cannot renew itself. Reauthorize it before it expires.');
  const actions = [
    c.reauthorizeAvailable
      ? html`<button class="button small ${h.state === 'reauthorization_required' ? 'primary' : ''}" data-reauthorize="${c.id}">${uiText('Reauthorize')}</button>`
      : '',
    h.last_failure
      ? html`<button class="button small" data-credential-retry="${c.id}">${uiText('Retry renewal')}</button>`
      : '',
  ].filter(Boolean);
  return html`<div class="notice credential-health" role="status"><div><strong>${loginHealthLine(c)}</strong><p>${text}</p>${failure}${actions.length ? html`<p>${actions.map((action, index) => html`${index ? ' ' : ''}${action}`)}</p>` : ''}</div></div>`;
}
/** What the provider confirmed this login was granted (CON-03): declined permissions, or that it is not confirmed. */
function renderGrantedPermissions(c) {
  const g = c?.grants;
  if (!g) return '';
  const reauthorize = c.reauthorizeAvailable
    ? html` <button class="button small" data-reauthorize="${c.id}">${uiText('Reauthorize')}</button>`
    : '';
  if (g.requested_access_type === 'read')
    return html`<div class="notice" role="status"><p>${uiText('This login was authorized for read access only.')}${reauthorize}</p></div>`;
  if (g.source !== 'permissions_endpoint') return '';
  if (!g.known)
    return html`<div class="notice" role="status"><p>${uiText('AMCP could not confirm which permissions this login granted. Sync to check again; until then readiness reports them as unknown.')}</p></div>`;
  const declined = [...(g.declined ?? []), ...(g.expired ?? [])];
  if (!declined.length) return '';
  return html`<div class="notice" role="status"><div><strong>${uiText('Declined permissions')}</strong><p><code dir="ltr">${declined.join(', ')}</code></p><p>${uiText('Features that need these permissions stay unavailable. Reauthorize and allow them to use those features.')}${reauthorize}</p><p class="small-text">${uiText('Checked {date}', {date: date(g.checked_at)})}</p></div></div>`;
}
/**
 * Save and check access (CON-05): after a selection is saved, one bounded live account read for each newly selected
 * account (at most 20, read four at a time by the server), on this explicit click only.
 */
async function checkSelectedAccess(platformId, connectionId, before) {
  const c = platforms.find(p => p.id === platformId)?.connections.find(x => x.id === connectionId);
  if (!c) return;
  const added = c.accounts.filter(id => !before.has(id)),
    ids = added.slice(0, 20);
  if (!ids.length) {
    toast(uiText('No newly selected accounts to check.'));
    return;
  }
  const result = await workspaceCall('workspace', {action: 'check', connection_id: c.id, account_ids: ids, live: true});
  accessChecks.set(c.id, {...result, skipped: added.length - ids.length});
  if ($('#manage-dialog').open && currentConnection === c.id) renderManage();
}
/** Two or more enabled logins without a default: AI tools must name a login on every request (CON-05). */
function renderDefaultPrompt(p) {
  const enabled = p.connections.filter(c => c.enabled);
  if (enabled.length < 2 || enabled.some(c => c.isDefault)) return '';
  return html`<div class="notice" role="status"><p><strong>${uiText('Choose a default login')}</strong> ${uiText('Several {platform} logins are enabled and none is the default, so AI tools must name a login for every request. Use Make default on one of them.', {platform: p.name})}</p></div>`;
}
/** The login's own name in AMCP and the provider identity it was authorized with (CON-05). */
function renderLoginIdentity(c) {
  const identity = c.identity?.name
    ? html`<p class="small-text">${uiText('Provider identity: {name}', {name: c.identity.name})}</p>`
    : '';
  if (!session.administrator) return identity ? html`<div class="notice">${identity}</div>` : '';
  return html`<div class="notice login-identity"><div><label for="login-label">${uiText('Login name')}</label><div class="copy-row"><input id="login-label" type="text" maxlength="80" value="${c.name}" autocomplete="off"><button class="button small" data-rename-login="${c.id}">${uiText('Rename')}</button></div>${identity}</div></div>`;
}
function renderAccessChecks(p, c) {
  const result = c ? accessChecks.get(c.id) : undefined;
  if (!result?.results) return '';
  const name = id => c.groups.flatMap(g => g.assets).find(a => a.id === id)?.name ?? id,
    reason = r => r.checks?.find(x => x.status !== 'passed');
  return html`<section class="notice access-checks" role="status" aria-live="polite"><div><strong>${uiText('Access check')}</strong><ul>${result.results.map(r => html`<li><bdi><bdi>${name(r.account_id)}</bdi></bdi> <small><bdi dir="ltr">${r.account_id}</bdi></small> ${raw(readinessBadge(r))}${reason(r) ? html` <small>${uiText(reason(r).message)}</small>` : ''}</li>`)}</ul>${result.skipped > 0 ? html`<p class="small-text">${uiText('{count} more accounts were not checked; check them from Home.', {count: uiNumber(result.skipped)})}</p>` : ''}<p class="small-text">${uiText('Each check read one selected account from {platform}. Nothing was changed.', {platform: p.name})}</p></div></section>`;
}
function renderGoogleAuthorization(c) {
  const a = c?.authorization;
  if (!a) return '';
  return (
    `<div class="notice"><div><strong>${esc(uiText('Google authorization'))}</strong><p>${esc(uiText('Sync reloads accounts using this saved login. Reauthorize asks Google for fresh consent and keeps this connection after account access is verified.'))}</p><p class="small-text">` +
    (a.matchesCurrentClient === true
      ? uiText('Saved OAuth client matches the current configuration.')
      : a.matchesCurrentClient === false
        ? uiText(
            'Saved OAuth client differs from the current configuration. Use Reauthorize to connect with the current client.',
          )
        : uiText('The saved OAuth client could not be compared. Reauthorize to establish a fresh connection.')) +
    `</p>` +
    (a.clientId
      ? `<p class="small-text">${esc(uiText('Saved client:'))} <span class="oauth-client-id">` +
        esc(a.clientId) +
        `</span></p>`
      : '') +
    (!a.adsScopeRecorded
      ? `<p>${esc(uiText('Google Ads permission is not recorded on this login. Reauthorize and approve Google Ads access.'))}</p>`
      : '') +
    `</div></div>`
  );
}
async function syncConnection(id, kinds) {
  const result = await api('/api/connections/' + id + '/sync', {method: 'POST', body: JSON.stringify({kinds})});
  currentConnection = id;
  await refresh();
  if (result.error) {
    const reason = result.groups?.flatMap(g => g.diagnostics ?? []).find(d => d.provider?.code)?.provider?.code;
    toast(
      uiText('Sync needs attention') +
        (reason ? ' — ' + reason : '') +
        uiText('. Open the error details below. For authorization errors, use Reauthorize.'),
    );
  } else toast(uiText('Accounts synced successfully.'));
}
function renderManage() {
  const p = platforms.find(p => p.id === currentPlatform);
  if (!p) return;
  const c = p.connections.find(c => c.id === currentConnection);
  if (!c && p.connections.length) {
    currentConnection = (p.connections.find(c => c.isDefault) ?? p.connections[0]).id;
    return openManage(p.id, currentConnection);
  }
  const group = c?.groups.find(g => g.kind === assetKind),
    assets = (group?.assets ?? []).filter(a => (a.name + ' ' + a.id).toLowerCase().includes(assetSearch.toLowerCase()));
  const loginRow = login =>
    html`<div class="oauth-login"><span class="avatar">${login.name.slice(0, 1).toUpperCase()}</span><div><button class="button quiet small" data-select-login="${login.id}"><strong>${login.name}</strong></button>${login.isDefault ? html`<span class="default-badge">${uiText('Default')}</span>` : ''}<small>${loginHealthLine(login)}${reviewerLoginLine(login)} · ${login.enabled ? uiText('Enabled in AMCP') : uiText('Choose assets')}${login.duplicateOf ? ' · ' + uiText('Same identity as another login') : ''}</small></div><div class="actions"><button class="button small" data-sync="${login.id}">${uiText('↻ Sync')}</button>${login.reauthorizeAvailable ? html`<button class="button small ${login.status === 'reauthorization_required' ? 'primary' : ''}" data-reauthorize="${login.id}">${uiText('Reauthorize')}</button>` : ''}${!login.isDefault && login.enabled ? html`<button class="button small" data-default="${login.id}">${uiText('Make default')}</button>` : ''}<button class="button small danger" data-disconnect="${login.id}" aria-label="${uiText('Disconnect {name}', {name: login.name})}">↗</button></div></div>`;
  setHtml(
    $('#manage-content'),
    html`<div class="manage-header"><div class="platform-identity">${logo(p)}<div><h3>${p.name} ${uiText('assets')}</h3><div class="platform-kind">${uiText('Manage logins and access inside AMCP')}</div></div></div><button class="icon-button" data-close="manage-dialog" aria-label="${uiText('Close asset manager')}">×</button></div><div class="manage-body"><div class="panel-header"><div><h3>${uiText('Connected logins')}</h3><p class="muted login-caption">${uiText('Each login keeps its own encrypted credentials and permissions.')}</p></div><button class="button dark small" data-connect="${p.id}">${uiText('+ Connect another')}</button></div><div class="login-list">${p.connections.length ? p.connections.map(loginRow) : html`<div class="empty"><strong>${uiText('No logins connected')}</strong>${uiText('Connect your account to discover its advertising assets.')}</div>`}</div>${renderDefaultPrompt(p)}${c ? html`${renderLoginIdentity(c)}${renderCredentialHealth(c)}${renderGrantedPermissions(c)}${raw(renderConnectionSyncStatus(c))}${renderAccessChecks(p, c)}${raw(renderGoogleAuthorization(c))}<div class="notice asset-notice"><span>✓</span><p>${uiText('Select')} ${uiText(labels[p.selectionKind] ?? p.selectionKind ?? 'Resources').toLowerCase()} ${uiText('to grant MCP access to their data. Other tabs show related asset inventory. Saving this selection changes AMCP access only.')}</p></div>${session.writesEnabled && p.reviewedWrites !== false ? html`<label class="form-note"><input type="checkbox" id="selection-write-access" ${c.defaultWriteAccess ? 'checked' : ''}> ${uiText('Enable read + reviewed write access for all selected resources')}</label>` : ''}${p.reviewedWrites === false ? '' : writeAccessPanel(c)}${reportJobPanel(c)}<div class="asset-tabs" role="group" aria-label="${uiText('Asset types')}">${p.assetKinds.map(k => html`<button data-asset-kind="${k}" class="${assetKind === k ? 'active' : ''}">${uiText(labels[k] ?? k)} <span class="asset-count">${c.groups.find(g => g.kind === k)?.assets.length ?? '—'}</span></button>`)}</div><div class="asset-toolbar"><label class="search"><span>⌕</span><input id="asset-search" type="search" value="${assetSearch}" placeholder="${uiText('Search {kind}…', {kind: uiText(labels[assetKind] ?? assetKind)})}" aria-label="${uiText('Search assets')}"></label><button class="button small" data-sync-kind="${assetKind}">${uiText('↻ Sync this tab')}</button></div>${raw(renderAssetSyncDiagnostics(group))}<div id="asset-rows">${assetRows(assets, group)}</div>` : ''}</div><div class="manage-footer"><span class="muted small-text">${c ? uiText('Last sync: {date}', {date: date(c.lastSync)}) : uiText('Your provider opens in a secure authorization flow.')}</span>${c && selectableKind(assetKind) ? html`<div class="platform-actions"><button class="button small" data-select-all="true">${uiText('Select visible')}</button><button class="button primary" data-save-assets="true">${uiText('Save selection')}</button>${p.accountRead ? html`<button class="button" data-save-assets="check">${uiText('Save and check access')}</button>` : ''}</div>` : ''}</div>`,
  );
}
/**
 * The resources a selection save would newly enable for writes, as display names, mirroring the server rule: with the
 * read + reviewed write option every selected resource has write access, otherwise only existing grants stay.
 */
function selectionWriteAdditions(p, c, writeOption) {
  if (!p || !c || !session.writesEnabled || p.reviewedWrites === false) return [];
  const kinds = p.selectableKinds ?? [p.selectionKind ?? 'ad_accounts'],
    accounts = [...selected]
      .map(key => {
        const kind = kinds.find(k => key.startsWith(k + ':'));
        return kind ? key.slice(kind.length + 1) : undefined;
      })
      .filter(Boolean),
    previous = (c.writeAccounts ?? []).filter(id => c.accounts.includes(id)),
    writes = (writeOption ?? c.defaultWriteAccess === true) ? accounts : writeOption === false ? [] : previous;
  return writes
    .filter(id => !previous.includes(id))
    .map(id => {
      const asset = c.groups.flatMap(g => g.assets).find(a => a.id === id);
      return asset && asset.name !== id ? asset.name + ' · ' + id : id;
    });
}
function writeAccessPanel(c) {
  // Every selectable kind names its resources (Business Profile locations and accounts, CON-06), ad accounts first.
  const assets = [...(c.groups.find(g => g.kind === 'ad_accounts')?.assets ?? []), ...c.groups.flatMap(g => g.assets)];
  return html`<section class="panel consent-panel"><h3>${uiText('Resource write access')}</h3><p>${session.writesEnabled ? uiText('Operator connectors may change only the selected accounts you explicitly enable below. Each change still requires a reviewed request through amcp_write.') : uiText('Write support is disabled in this deployment. You can revoke existing account grants below.')}</p>${c.accounts.length ? c.accounts.map(id => html`<label class="token-row"><span>${assets.find(a => a.id === id)?.name ?? id}<small>${id}</small></span><input type="checkbox" data-write-account="${id}" aria-label="${uiText('Allow writes to {id}', {id})}" ${writeSelected.has(id) ? 'checked' : ''} ${!session.writesEnabled ? 'disabled' : ''}></label>`) : html`<p class="muted">${uiText('Save a resource selection before granting write access.')}</p>`}${session.writesEnabled && c.accounts.length ? html`<label class="form-note"><input type="checkbox" id="confirm-write-access"> ${uiText('I authorize operator connectors to change the checked resources.')}</label>` : ''}<div class="dialog-actions">${c.writeAccounts?.length ? html`<button class="button danger" data-revoke-write-access="true">${uiText('Revoke all write access')}</button>` : ''}${session.writesEnabled && c.accounts.length ? html`<button class="button" data-save-write-access="true">${uiText('Save write access')}</button>` : ''}</div></section>`;
}
/**
 * Report-job access (RPT-06): while the deployment owner allows provider report and export jobs, an administrator
 * chooses the accounts on which AI clients and members, readers included, may create them. Existing grants can always
 * be revoked.
 */
function reportJobPanel(c) {
  if (!c.reportJobsAvailable || (!session.providerJobs && !c.reportJobAccounts?.length)) return '';
  const assets = c.groups.flatMap(g => g.assets),
    editable = session.providerJobs === true;
  return html`<section class="panel consent-panel"><h3>${uiText('Report jobs')}</h3><p>${editable ? uiText('Report and export jobs create a processing job at the provider and use its quota; they change no campaign, budget or spend. Choose the accounts on which AI clients and members, readers included, may create them. Each job is still prepared and executed as a review.') : uiText('This deployment does not allow report jobs outside reviewed writes. You can revoke existing report-job grants below.')}</p>${c.accounts.length ? c.accounts.map(id => html`<label class="token-row"><span>${assets.find(a => a.id === id)?.name ?? id}<small>${id}</small></span><input type="checkbox" data-report-job-account="${id}" aria-label="${uiText('Allow report jobs on {id}', {id})}" ${reportJobSelected.has(id) ? 'checked' : ''} ${editable ? '' : 'disabled'}></label>`) : html`<p class="muted">${uiText('Save a resource selection before granting report jobs.')}</p>`}${editable && c.accounts.length ? html`<label class="form-note"><input type="checkbox" id="confirm-report-jobs"> ${uiText('I allow report jobs on the checked accounts.')}</label>` : ''}<div class="dialog-actions">${c.reportJobAccounts?.length ? html`<button class="button danger" data-revoke-report-jobs="true">${uiText('Revoke report jobs')}</button>` : ''}${editable && c.accounts.length ? html`<button class="button" data-save-report-jobs="true">${uiText('Save report jobs')}</button>` : ''}</div></section>`;
}
function assetRows(assets, group) {
  // DV360 discovers advertisers through partners: an empty list names the user profile to set up (CON-04).
  if (!assets.length && group?.complete && currentPlatform === 'dv360')
    return html`<div class="empty"><strong>${uiText('No Display & Video 360 advertisers found')}</strong>${uiText('AMCP lists advertisers through the partners this Google identity can access. Ask a Display & Video 360 administrator to give it a user profile with Admin, Standard or Read only access to the partner or advertiser, keep the Display & Video 360 permission granted at sign-in, then sync again.')}</div>`;
  if (!assets.length)
    return html`<div class="empty"><strong>${group?.complete ? uiText('No assets found') : group ? uiText('No assets available') : uiText('This tab has not been synced')}</strong>${group?.complete ? uiText('The provider returned an empty list for this login.') : uiText('Sync this tab to load the assets your login can access.')}</div>`;
  return html`<table class="asset-table"><thead><tr><th scope="col" aria-label="${uiText('Select')}"></th><th scope="col">${uiText(labels[assetKind] ?? assetKind)}</th><th scope="col">${uiText('Access')}</th></tr></thead><tbody>${assets.map(a => html`<tr><td>${selectableKind(assetKind) ? html`<input type="checkbox" data-asset-key="${a.kind + ':' + a.id}" aria-label="${uiText('Select {name}', {name: a.name})}" ${selected.has(a.kind + ':' + a.id) ? 'checked' : ''}>` : ''}</td><td><bdi>${a.name}</bdi><small><bdi dir="ltr">${a.id}</bdi>${a.currency ? html` · <bdi dir="ltr">${a.currency}</bdi>` : ''}${currentPlatform === 'google' ? googleAssetLabel(a) : ''}${a.source === 'configured_binding' ? ' · ' + uiText('locally configured') : ''}</small></td><td><span class="status ${selected.has(a.kind + ':' + a.id) ? 'online' : 'offline'}">${selectableKind(assetKind) ? (selected.has(a.kind + ':' + a.id) ? uiText('Selected') : uiText('Available')) : uiText('Inventory')}</span></td></tr>`)}</tbody></table>`;
}
function openManage(id, connectionId) {
  if (!requireLogin()) return;
  currentPlatform = id;
  const p = platforms.find(p => p.id === id);
  assetKind = p.selectionKind ?? 'ad_accounts';
  currentConnection = connectionId ?? p.connections.find(c => c.isDefault)?.id ?? p.connections[0]?.id ?? null;
  selected = new Set(p.connections.find(c => c.id === currentConnection)?.selected ?? []);
  writeSelected = new Set(p.connections.find(c => c.id === currentConnection)?.writeAccounts ?? []);
  reportJobSelected = new Set(p.connections.find(c => c.id === currentConnection)?.reportJobAccounts ?? []);
  assetSearch = '';
  renderManage();
  if (!$('#manage-dialog').open) $('#manage-dialog').showModal();
}
/**
 * An Operations item for a login that needs reauthorization or is turned off links to `/connections?connection_id=`
 * (OPS-06): open that login's Manage view, where it is reauthorized in place or turned on. Only a login this workspace
 * lists opens; the link is then cleared so a refresh does not reopen it.
 */
function openLinkedConnection() {
  const id = new URLSearchParams(location.search).get('connection_id');
  if (!id || !session.authenticated) return;
  const p = platforms.find(p => p.connections.some(c => c.id === id));
  history.replaceState(null, '', '/connections');
  if (p) openManage(p.id, id);
  else toast(uiText('That connection is no longer in this workspace.'));
}
async function startConnection(id) {
  if (!requireLogin()) return;
  const p = platforms.find(p => p.id === id);
  if (!p.configured) {
    if ($('#manage-dialog').open) $('#manage-dialog').close();
    navigate('/settings#' + id);
    toast(
      session.administrator
        ? uiText('Add the {platform} app credentials to your server environment to enable Connect.', {platform: p.name})
        : uiText('This platform needs setup by the site administrator. Your existing connections remain available.'),
    );
    return;
  }
  const result = await api('/api/auth/' + id + '/start', {method: 'POST', body: '{}'});
  location.assign(result.url);
}
async function refresh() {
  const data = await api('/api/platforms');
  platforms = data.platforms;
  commerceSources = data.commerce_sources ?? [];
  providersNotOffered = data.providers_not_offered ?? [];
  const c = platforms.find(p => p.id === currentPlatform)?.connections.find(c => c.id === currentConnection);
  if (c) {
    selected = new Set(c.selected ?? []);
    writeSelected = new Set(c.writeAccounts ?? []);
    reportJobSelected = new Set(c.reportJobAccounts ?? []);
  }
  await render();
  if ($('#manage-dialog').open) renderManage();
}
function connectorCode() {
  const url = session.origin + '/mcp';
  if (client === 'codex') return `[mcp_servers.amcp]\nurl = "${url}"\nbearer_token_env_var = "AMCP_MCP_TOKEN"`;
  if (client === 'cursor')
    return JSON.stringify(
      {mcpServers: {amcp: {url, headers: {Authorization: 'Bearer ${env:AMCP_MCP_TOKEN}'}}}},
      null,
      2,
    );
  return JSON.stringify(
    {url, transport: 'streamable-http', headers: {Authorization: 'Bearer <your AMCP connector token>'}},
    null,
    2,
  );
}
/** "Limit to client" for a new connector token (SEC-08); a member limited to a set hands on that set. */
function tokenAccessSetControl() {
  if (!session.authenticated || !accessSetChoices.length) return '';
  const required = session.accessSet?.id ?? null;
  return html`<label class="form-note token-limit">${uiText('Limit to client')}<select id="token-access-set">${required ? '' : html`<option value="">${uiText('No limit: the accounts I can reach')}</option>`}${accessSetChoices.map(s => html`<option value="${s.id}" ${s.id === required ? 'selected' : ''}>${s.name}</option>`)}</select></label>`;
}
/** " · Limited to {client}" for a token or AI client limited to a client access set, as text. */
function accessSetNote(id) {
  if (!id) return '';
  const set = accessSetChoices.find(s => s.id === id);
  return ' ' + (set ? uiText('· Limited to {client}', {client: set.name}) : uiText('· Limited to one client'));
}
async function renderConnectors() {
  if (session.authenticated) {
    try {
      tokens = (await api('/api/connector-tokens')).tokens;
      // The client access sets a new token may be limited to (SEC-08); none listed, no choice shown.
      accessSetChoices = (await api('/api/access-sets').catch(() => ({sets: []}))).sets ?? [];
      const authorizations = await api('/api/mcp/authorizations');
      oauthClients = authorizations.clients;
      oauthEnded = authorizations.ended ?? [];
    } catch (e) {
      toast(errorMessage(e));
    }
  } else {
    tokens = [];
    oauthClients = [];
    oauthEnded = [];
  }
  // MCP-08: every member may connect their own AI tools, capped by role. Owners and administrators manage every
  // token and client of the workspace; a member revokes their own.
  const viewer = session.workspaceRole === 'viewer',
    manages = item =>
      session.administrator === true || ['owner', 'admin'].includes(session.workspaceRole) || item.yours,
    endedReason = reason =>
      ({
        refresh_replay: uiText('Ended: a refresh token was reused'),
        code_replay: uiText('Ended: an authorization code was reused'),
        client_revoke: uiText('Ended: the app revoked its access'),
        workspace_revoke: uiText('Ended: revoked in AMCP'),
        membership_change: uiText('Ended: workspace membership changed'),
        password_change: uiText('Ended: the account password changed'),
        email_change: uiText('Ended: the account email changed'),
        mfa_change: uiText('Ended: two-step verification changed'),
        account_access_revoked: uiText('Ended: account access was removed'),
        owner_migration: uiText('Ended: the workspace moved to its owner account'),
        door_password_change: uiText('Ended: the administrator password changed'),
        restore_quarantine: uiText('Ended: AMCP was restored from a backup'),
      })[reason] ?? uiText('Ended');
  const tokenRow = t =>
      html`<div class="token-row"><div><strong><bdi>${t.name}</bdi></strong><small>${t.role === 'operator' ? uiText('Operator · reviewed writes') : uiText('Reader')}${accessSetNote(t.access_set_id)} ${uiText('· Created')} ${uiDateZoned(t.createdAt)} ${uiText('· Expires')} ${uiDateZoned(t.expiresAt)}</small></div>${t.revoked ? html`<span class="status offline">${uiText('Revoked')}</span>` : manages(t) ? html`<button class="button small danger" data-revoke-token="${t.id}">${uiText('Revoke')}</button>` : ''}</div>`,
    approvedBy = c => (c.ownerName ? html` ${uiText('· Approved by')} <bdi>${c.ownerName}</bdi>` : ''),
    clientRow = c =>
      html`<div class="token-row"><div><strong><bdi>${c.name}</bdi></strong><small>${c.role === 'operator' ? uiText('Operator · reviewed writes') : uiText('Reader')}${accessSetNote(c.access_set_id)} ${uiText('· Authorization expires')} ${uiDateZoned(c.expiresAt)}${approvedBy(c)}</small></div>${manages(c) ? html`<button class="button small danger" data-revoke-client="${c.id}"${'owner' in c ? html` data-revoke-owner="${c.owner ?? ''}"` : ''}>${uiText('Revoke access')}</button>` : ''}</div>`,
    endedRow = c =>
      html`<div class="token-row"><div><strong><bdi>${c.name}</bdi></strong><small>${endedReason(c.reason)} · ${uiDateZoned(c.endedAt)}${approvedBy(c)}</small></div></div>`;
  setHtml(
    content,
    html`${raw(header(uiText('AI connectors'), uiText('Give your AI tools access to the accounts you select.')))}<section class="connector-hero"><div><span class="status online"><i></i>${session.writesEnabled ? uiText('Write support enabled') : uiText('Read-only deployment')}</span><h2 class="connector-title">${uiText('Your workspace.')}<br>${uiText('In the tools you already use.')}</h2><p>${session.writesEnabled ? uiText('Connect your AI tools for reporting and reviewed advertising changes. New connections default to read and reviewed write access.') : uiText('Connect Codex or another MCP client to read advertising data and prepare dry-run requests.')}</p></div><div class="endpoint-box"><small>${uiText('AMCP MCP ENDPOINT')}</small><div class="copy-row"><code>${session.origin + '/mcp'}</code><button class="button small" data-copy-endpoint="true">${uiText('Copy')}</button></div></div></section><section class="panel consent-panel"><h2>${uiText('Connect with browser authorization')}</h2><p>${uiText('In an MCP client that supports OAuth, add the endpoint above and choose Sign in. AMCP requests read and reviewed write access when enabled.')} ${session.writesEnabled ? html`${uiText('New clients default to')} <code>mcp:read mcp:write</code>${uiText('; the consent screen identifies operator access. Clients can explicitly request')} <code>mcp:read</code> ${uiText('for read-only access. Existing reader authorizations stay read-only until reauthorized.')} ${uiText('On the consent screen you can also choose read-only access. Viewers can approve read-only access only.')}` : uiText('Advertising writes are disabled in this deployment.')}</p><pre class="code-block">codex mcp add amcp --url ${session.origin + '/mcp'}
codex mcp login amcp</pre><p class="muted">${uiText('For clients using a bearer token, follow the setup below.')}</p></section><section class="panel"><div class="panel-header"><h2>${uiText('Connect with a token')}</h2><span class="status">${uiText('Streamable HTTP')}</span></div><div class="client-tabs"><button class="client-tab ${client === 'codex' ? 'active' : ''}" data-client="codex">${uiText('Codex')}</button><button class="client-tab ${client === 'cursor' ? 'active' : ''}" data-client="cursor">${uiText('Cursor')}</button><button class="client-tab ${client === 'other' ? 'active' : ''}" data-client="other">${uiText('Other MCP client')}</button></div><div class="steps"><div class="step"><div><strong>${uiText('Create a connector token')}</strong><p class="muted">${uiText('Create a separate token for each tool. Tokens expire after 30 days and can be revoked below.')}</p></div></div><div class="step"><div><strong>${uiText('Add your token to the tool’s environment')}</strong><p class="muted">${uiText('Use the environment variable')} <code>AMCP_MCP_TOKEN</code>${uiText('. Keep the value private.')}</p></div></div><div class="step"><div class="step-content"><div class="copy-row"><strong>${client === 'codex' ? uiText('Add this to your Codex config.toml') : client === 'cursor' ? uiText('Add this to your Cursor MCP configuration') : uiText('Configure your MCP client')}</strong><button class="button small" data-copy-config="true">${uiText('Copy config')}</button></div><pre class="code-block">${connectorCode()}</pre><p class="muted">${client === 'codex' ? uiText('Reload your MCP connections, then ask Codex to list the tools available from AMCP.') : uiText('Use a client that supports Streamable HTTP and bearer authentication.')}</p></div></div></div></section><section class="panel"><div class="panel-header"><div><h2>${uiText('Connector tokens')}</h2><span class="muted token-caption">${uiText('Access follows your current AMCP asset selections.')}</span></div>${session.authenticated ? html`<button class="button" data-create-token="true">${uiText('Create read-only token')}</button>` : html`<a class="button" href="/login">${uiText('Sign in to create a token')}</a>`}</div>${session.writesEnabled && session.authenticated && !viewer ? html`<div class="consent-panel"><p><strong>${uiText('Read + write (default)')}</strong> ${uiText('Create an operator token for your selected resources, then use')} <code>amcp_write</code> ${uiText('to prepare and review a change before executing it.')}</p><label class="form-note"><input type="checkbox" id="operator-token-consent"> ${uiText('I authorize this connector to execute reviewed changes on accounts with write access.')}</label><p><button class="button primary" data-create-operator-token="true">${uiText('+ Create read + write token')}</button></p></div>` : ''}${tokenAccessSetControl()}<div id="new-token"></div>${tokens.length ? tokens.map(tokenRow) : html`<div class="empty">${session.authenticated ? uiText('No connector tokens yet.') : uiText('Sign in to create and manage connector tokens.')}</div>`}</section><section class="panel"><div class="panel-header"><h2>${uiText('Authorized MCP clients')}</h2></div>${oauthClients.length ? oauthClients.map(clientRow) : html`<div class="empty">${uiText('No clients authorized through browser sign-in.')}</div>`}${oauthEnded.length ? html`<h3>${uiText('Recently ended connections')}</h3>${oauthEnded.map(endedRow)}` : ''}</section><p class="muted small-text">${uiText('Codex configuration follows')} <a href="https://learn.chatgpt.com/docs/extend/mcp?surface=cli" target="_blank" rel="noreferrer">${uiText('official OpenAI documentation ↗')}</a>.</p>`,
  );
}
/** Settings: the shared page, then the parts registered for it in their order (WEB-07); every re-render comes here. */
async function renderSettings() {
  renderWorkspaceSettings();
  await AMCP.routes.renderParts('/settings');
}
function renderWorkspaceSettings() {
  if (session.authenticated && !session.administrator) {
    content.innerHTML =
      header(uiText('Workspace settings'), uiText('A few thoughtful details make this space yours.')) +
      `<section class="panel"><h2>${esc(uiText('Your account & security'))}</h2><p>${esc(uiText('Edit your profile, personalize your workspace name, link social accounts, and manage browser sessions.'))}</p><a class="button primary" href="/account">${esc(uiText('Manage your account →'))}</a></section><section class="panel"><h2>${esc(uiText('Connected platforms'))}</h2><p>${esc(uiText('Choose the accounts your workspace can access, refresh assets, and manage permissions.'))}</p><a class="button" href="/connections">${esc(uiText('Manage connections'))}</a></section>`;
    return;
  }
  content.innerHTML =
    header(uiText('Workspace settings'), uiText('Register AMCP with your advertising and measurement platforms.')) +
    `<div class="notice"><span>◈</span><p><strong>${esc(uiText('Keep provider secrets on the server.'))}</strong><br>${esc(uiText('Add API credentials to your server environment. Register each browser OAuth callback exactly as shown below.'))}</p></div><div class="settings-grid">` +
    platforms
      .map(p => {
        const apple = p.authType === 'client_credentials',
          googleMeasurement = ['ga4', 'gtm', 'gsc'].includes(p.id);
        const variables = apple
          ? `AMCP_APPLE_CLIENT_ID<br>AMCP_APPLE_TEAM_ID<br>AMCP_APPLE_KEY_ID<br>AMCP_APPLE_PRIVATE_KEY`
          : 'AMCP_' +
            p.env +
            `_CLIENT_ID<br>AMCP_` +
            p.env +
            '_CLIENT_SECRET' +
            (p.id === 'google_business' ? '<br>AMCP_GBP_API_APPROVED' : '');
        return (
          `<section class="panel" id="` +
          esc(p.id) +
          `"><div class="panel-header"><div class="platform-identity">` +
          logo(p) +
          `<h2>` +
          esc(p.name) +
          `</h2></div><span class="status ` +
          (p.configured ? 'online' : 'attention') +
          '">' +
          (p.configured ? uiText('Configured') : uiText('Setup needed')) +
          `</span></div><div class="setting-field"><label>${esc(uiText('APP NAME'))}</label><strong>AMCP</strong></div><div class="setting-field"><label>` +
          (apple ? uiText('CONNECTION METHOD') : uiText('REDIRECT / CALLBACK URI')) +
          `</label>` +
          (apple
            ? `<p>${esc(uiText('Server-side Apple Ads API credentials. No browser callback is required.'))}</p>`
            : `<div class="copy-row"><code>` +
              esc(p.callback) +
              `</code><button class="button small" data-copy-callback="` +
              esc(p.id) +
              `">${esc(uiText('Copy'))}</button></div>`) +
          `</div><div class="setting-field"><label>${esc(uiText('SERVER VARIABLES'))}</label><code>` +
          variables +
          `</code></div><div class="setting-field"><label>${esc(uiText('REQUESTED PERMISSIONS'))}</label><code>` +
          esc(p.scopes.join(', ') || uiText('Configure permissions in the provider app')) +
          `</code></div>` +
          (googleMeasurement
            ? `<p class="form-note">${esc(uiText('You may reuse AMCP_GOOGLE_CLIENT_ID and AMCP_GOOGLE_CLIENT_SECRET when both dedicated variables are unset. Enable this product’s API in Google Cloud and register its separate callback. Each connection has its own tokens and selected resources.'))}</p>`
            : '') +
          (p.id === 'google_business'
            ? `<p class="form-note">${esc(uiText('Google approves each Cloud project for the Business Profile APIs separately; a quota of 0 requests per minute means it has not approved yours yet. After approval, set AMCP_GBP_API_APPROVED=true to connect with AMCP_GOOGLE_CLIENT_ID and AMCP_GOOGLE_CLIENT_SECRET, or set the dedicated variables. Enable the Business Profile APIs and register this callback in that project.'))}</p>`
            : '') +
          (apple
            ? `<p class="form-note">${esc(uiText('Upload the matching P-256 public key in Apple Ads API settings, then store the private PEM key only in Railway. AMCP signs short-lived client secrets and renews access tokens automatically. A pre-generated AMCP_APPLE_CLIENT_SECRET is also supported, but you must replace it before it expires.'))}</p>`
            : '') +
          (p.reviewedWrites === false
            ? `<p class="form-note">${esc(uiText('This connection enables provider reads and asset discovery. Reviewed live mutations are not enabled for this provider.'))}</p>`
            : '') +
          (p.id === 'tiktok'
            ? `<p class="form-note">${esc(uiText('Use the callback parameter from your developer portal. AMCP_TIKTOK_REDIRECT_PARAMETER accepts redirect_uri or redirect_url. Marketing API long-term tokens require reauthorization if revoked; consumer TikTok token endpoints are not used.'))}</p>`
            : '') +
          (p.id === 'meta'
            ? `<p class="form-note">${esc(uiText('AMCP exchanges the initial user token for a long-lived token and records Meta’s actual expiry. Use your own approved Meta app. Configure AMCP_META_LONG_LIVED_TOKEN=false only for a separately documented token type that does not support this exchange.'))}</p>`
            : '') +
          `</section>`
        );
      })
      .join('') +
    `</div>`;
}
async function renderActivity() {
  const heading = raw(
    header(uiText('Audit activity'), uiText('Account activity and your workspace events, within current access.')),
  );
  setHtml(content, heading);
  if (!session.authenticated) {
    setHtml(content, html`${heading}<div class="empty">${uiText('Sign in to view workspace activity.')}</div>`);
    return;
  }
  const generation = navigationGeneration,
    identity = identityGeneration;
  // The working client narrows the history to its accounts (SEC-08).
  const client = typeof workingClientQuery === 'function' ? workingClientQuery() : {},
    initial = await api('/api/activity' + (client.profile_id ? '?' + new URLSearchParams(client) : ''));
  if (generation !== navigationGeneration || identity !== identityGeneration) return;
  const entry = e => {
    const ids = [e.event.gateway ?? e.event.platform, e.event.account_id, e.event.connection_id].filter(Boolean);
    return html`<article class="activity-entry"><div class="token-row"><div><strong>${String(e.event.event ?? uiText('Workspace request')).replaceAll('_', ' ')}</strong><small>${ids.length ? ids.map((value, index) => html`${index ? ' · ' : ''}<bdi dir="ltr">${value}</bdi>`) : uiText('AMCP workspace')}</small></div><span class="muted">${uiDateZoned(e.at)}</span></div>${e.event.action ? html`<p>${e.event.action}</p>` : ''}${e.event.request_id ? html`<p class="form-note">${uiText('Request reference')}: <code>${e.event.request_id}</code></p>` : ''}${e.event.error ? html`<details class="activity-failure" open><summary>${e.event.error.code ?? uiText('Request failed')}</summary>${(e.diagnostics ?? []).length ? e.diagnostics.map(d => raw(renderSourceDiagnostic(d))) : html`<p>${uiText('Inspect the original work for more details.')}</p>`}</details>` : ''}</article>`;
  };
  const rows = result =>
    result.events.length
      ? result.events.map(entry)
      : html`<div class="empty">${uiText('No accessible events on this page. Continue if another page is available.')}</div>`;
  let page = 0,
    next = initial.next_cursor ?? null,
    cursors = [undefined],
    filters = {...client},
    sequence = 0;
  const markup = result =>
    html`${rows(result)}<p id="activity-status" role="status">${next ? uiText('More results are available.') : uiText('End of available results.')}</p><nav class="dialog-actions" aria-label="${uiText('Activity pages')}"><button id="activity-prev" class="button small" ${page ? '' : 'disabled'}>${uiText('Previous')}</button><span>${uiText('Page')} ${page + 1}</span><button id="activity-next" class="button small" ${next ? '' : 'disabled'}>${uiText('Next')}</button></nav>`;
  setHtml(
    content,
    html`${heading}<p class="notice">${uiText('This history shows retained AMCP event metadata. Request bodies and receipts are omitted. Refresh to include newer events.')}</p><form id="activity-filter" class="panel work-filter"><label>${uiText('Search event, action or request reference')}<input type="search" name="search" maxlength="200"></label><label>${uiText('Account ID')}<input name="account_id" maxlength="200"></label><button type="submit" class="button primary">${uiText('Apply filters')}</button><button type="button" id="activity-refresh" class="button">${uiText('Refresh')}</button></form><section class="panel" id="activity-results" aria-label="${uiText('Activity results')}">${markup(initial)}</section>`,
  );
  const root = $('#activity-results'),
    form = $('#activity-filter');
  const current = () =>
    generation === navigationGeneration && identity === identityGeneration && root.isConnected && form.isConnected;
  const bind = () => {
    workspaceBind('#activity-prev', () => (page > 0 ? load(page - 1) : undefined));
    workspaceBind('#activity-next', () => (next ? load(page + 1) : undefined));
  };
  const load = async (index = 0, reset = false) => {
    if (!current()) return;
    const attempt = ++sequence,
      cursor = reset ? undefined : index === page + 1 ? next : cursors[index];
    const query = new URLSearchParams({...filters, ...(cursor ? {cursor} : {})});
    const active = () => attempt === sequence && current();
    root.setAttribute('aria-busy', 'true');
    try {
      const result = await api('/api/activity' + (query.size ? '?' + query : ''));
      if (!active()) return;
      if (reset) cursors = [undefined];
      else cursors[index] = cursor;
      page = index;
      next = result.next_cursor ?? null;
      setHtml(root, markup(result));
      bind();
    } catch (e) {
      if (active()) $('#activity-status').textContent = uiText('Could not load this page.') + ' ' + errorMessage(e);
    } finally {
      if (active()) root.setAttribute('aria-busy', 'false');
    }
  };
  bind();
  workspaceBind('#activity-refresh', () => load(0, true));
  workspaceBind('#activity-filter', async () => {
    if (!current()) return;
    const typed = Object.fromEntries(
      ['search', 'account_id'].map(k => [k, form.elements[k].value.trim()]).filter(([, v]) => v),
    );
    // An account typed here is an explicit choice: the working client does not narrow it further (SEC-08).
    filters = {...(typed.account_id ? {} : client), ...typed};
    await load(0, true);
  });
  form.addEventListener('input', () => {
    if (current()) {
      sequence++;
      root.setAttribute('aria-busy', 'false');
    }
  });
}
/**
 * The provider callback could not be accepted before any login was saved (CON-05). Only these fixed codes are shown;
 * nothing from the address other than a known platform ID is displayed.
 */
function renderCallbackRefusal(code, platformId) {
  const p = platforms.find(x => x.id === platformId),
    signIn = !session.authenticated,
    text = uiText(
      code === 'SIGN_IN_REQUIRED'
        ? 'Your AMCP session ended before the provider returned. Nothing was saved. Sign in, then start the connection again from Connections.'
        : code === 'FORBIDDEN'
          ? 'Only a workspace administrator can complete a platform connection. Nothing was saved. Sign in as an administrator and start again.'
          : code === 'OAUTH_STATE_INVALID'
            ? 'This authorization expired or was already used. Authorizations last 10 minutes and finish only in the browser session that started them. Nothing was saved. Start again from Connections.'
            : 'The provider returned an unexpected response. Nothing was saved. Start again from Connections.',
    );
  setHtml(
    content,
    html`<div class="callback-layout"><div class="callback-card" role="alert"><div class="callback-top"><div class="brand"><img src="${publicAssetUrl('/assets/mark.svg')}" width="34" height="34" alt=""><span>AMCP</span></div><h1>${p ? uiText('{platform} was not connected.', {platform: p.name}) : uiText('The platform was not connected.')}</h1><p>${text}</p></div><div class="callback-bottom">${signIn ? html`<a href="/login" class="button primary">${uiText('Sign in')}</a>` : html`<a href="/connections" class="button primary">${uiText('Start again')}</a>`}</div></div></div>`,
  );
}
/** A new login of an identity that is already connected (CON-05): renewing the existing login keeps its work. */
function renderDuplicateLogin(result) {
  const existing = result.duplicateOf
    ? platforms.find(p => p.id === result.platform)?.connections.find(c => c.id === result.duplicateOf)
    : undefined;
  if (!existing) return '';
  return html`<div class="notice" role="status"><div><strong>${uiText('This identity is already connected')}</strong><p>${uiText('The same provider identity is also saved as {name}. To renew that login and keep its selections, saved reports and schedules, reauthorize it instead, then disconnect this new login.', {name: existing.name})}</p>${existing.reauthorizeAvailable ? html`<p><button class="button small" data-reauthorize="${existing.id}">${uiText('Reauthorize existing')}</button></p>` : ''}</div></div>`;
}
async function renderCallback() {
  const params = new URLSearchParams(location.search),
    refusal = params.get('error');
  if (refusal && !params.get('attempt')) return renderCallbackRefusal(refusal, params.get('platform'));
  const id = params.get('attempt');
  const back = html`<a href="/connections" class="button primary">${uiText('Back to connections')}</a>`;
  let result;
  try {
    result = id ? await api('/api/oauth/progress/' + encodeURIComponent(id)) : null;
  } catch (e) {
    setHtml(content, html`${raw(header(uiText('Connection needs attention'), ''))}${raw(errorBlock(e))}${back}`);
    return;
  }
  if (!result) {
    setHtml(
      content,
      html`${raw(header(uiText('Connection not found'), uiText('Start a connection from your AMCP workspace.')))}${back}`,
    );
    return;
  }
  const p = platforms.find(p => p.id === result.platform),
    done = result.state === 'complete',
    failed = result.state === 'failed' || result.state === 'sync_attention',
    steps = [
      [
        'authorization',
        p?.authType === 'client_credentials'
          ? uiText('API credentials verified')
          : uiText('Approve on {platform}', {platform: p?.name ?? uiText('the provider')}),
        uiText('Provider authorization'),
      ],
      ['exchange', uiText('Secure connection'), uiText('Encrypted credential storage')],
      ['sync', uiText('Sync workspace assets'), uiText('Available advertising assets')],
    ];
  setHtml(
    content,
    html`<div class="callback-layout"><div class="callback-card"><div class="callback-top"><div class="brand"><img src="${publicAssetUrl('/assets/mark.svg')}" width="34" height="34" alt=""><span>AMCP</span></div><h1>${done ? uiText('You’re connected.') : failed ? uiText('A little attention needed.') : uiText('Connecting {platform}.', {platform: p?.name ?? uiText('your platform')})}</h1><p>${result.message ?? (done ? uiText('Your login is secured. Choose the assets to make available in AMCP.') : uiText('Securing your connection and discovering workspace assets.'))}</p></div><div class="callback-steps">${steps.map(([key, title, sub], i) => html`<div class="callback-step ${result[key] ? 'done' : failed ? 'failed' : ''}"><span class="step-number">${result[key] ? '✓' : i + 1}</span><div>${title}<small>${sub}</small></div></div>`)}</div>${(result.diagnostics ?? []).length ? html`<div class="reauthorization-errors">${result.diagnostics.map(d => raw(renderSourceDiagnostic(d)))}</div>` : ''}${renderDuplicateLogin(result)}<div class="callback-bottom"><a href="/connections" class="muted">${uiText('Back to connections')}</a>${result.connectionId ? html`<button class="button primary" data-callback-manage="${result.platform}" data-connection-id="${result.connectionId}">${uiText('Choose assets →')}</button>` : html`<a href="/connections" class="button">${uiText('Try again')}</a>`}</div></div></div>`,
  );
  if (!done && !failed) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(renderCallback, 1500);
  }
}
// Privacy, Terms and Data deletion are complete static pages that need no session or JavaScript (WEB-02). A view that
// still reaches one of them in the workspace opens the static page in the interface language.
function renderLegal() {
  const target = location.pathname + '?lang=' + uiLocale;
  if (location.pathname + location.search !== target) return location.replace(target);
  // A stale shell already at the static address: no reload loop, and no empty view either. target="_self" opens the
  // static page itself instead of the client router (WEB-02 review).
  content.innerHTML = `<section class="panel"><p><a class="button primary" href="${esc(target)}" target="_self">${esc(uiText('Open this page'))}</a></p></section>`;
}
/**
 * "Limit to client" on the consent page (SEC-08): the AI client reaches only one client access set's accounts. A member
 * limited to a set hands on that set; anyone else may choose one or keep their whole access.
 */
function consentAccessSet(info) {
  const sets = info.access_sets ?? [],
    required = info.access_set_required ?? null;
  if (!sets.length) return '';
  return html`<label class="consent-limit">${uiText('Limit to client')}<select id="consent-access-set">${required ? '' : html`<option value="">${uiText('No limit: the accounts I can reach')}</option>`}${sets.map(s => html`<option value="${s.id}" ${s.id === required ? 'selected' : ''}>${s.name}</option>`)}</select></label><p class="form-note">${uiText('A client limit lets this app reach only that client’s accounts. The app cannot widen it.')}</p>`;
}
async function renderConsent() {
  if (!session.authenticated) {
    setHtml(
      content,
      html`${raw(header(uiText('Authorize an MCP client'), uiText('Sign in to review this access request.')))}<button class="button primary" data-action="login">${uiText('Sign in')}</button>`,
    );
    return;
  }
  const request = new URLSearchParams(location.search).get('request');
  const info = await api('/api/mcp/consent?request=' + encodeURIComponent(request ?? ''));
  // MCP-08: the workspace is named above the decision, the return host is shown large, and the member chooses read only
  // or read and reviewed changes within what the app asked for and their role allows. Write stays the default choice.
  const choices = info.choices ?? [info.scope],
    write = choices.includes('mcp:read mcp:write'),
    option = (scope, title, text, checked) =>
      html`<label class="consent-choice"><input type="radio" name="consent-scope" value="${scope}" ${checked ? 'checked' : ''}><span><strong>${title}</strong><small>${text}</small></span></label>`;
  setHtml(
    content,
    html`${raw(header(esc(uiText('Authorize {name}', {name: info.name})), uiText('Review the tool requesting access to your workspace.')))}<section class="panel consent-panel"><span class="eyebrow">${uiText('WORKSPACE')}</span><h2>${info.workspace?.name ?? uiText('AMCP workspace')}</h2><p>${uiText('After you decide, AMCP returns you to:')}</p><p class="consent-host"><strong>${info.redirectHost ?? ''}</strong></p>${info.loopback ? html`<p class="notice" role="note">${uiText('This app receives the result on this computer (a loopback address). Approve only if you started this connection from an app on this device.')}</p>` : ''}<p class="muted">${uiText('The name “{name}” is provided by the app and is not verified by AMCP.', {name: info.name})}${info.clientMetadataHost ? ' ' + uiText('The app identifies itself with a metadata document that AMCP fetched from {host}.', {host: info.clientMetadataHost}) : ''}</p><fieldset class="consent-choices"><legend>${uiText('Access to grant')}</legend>${write ? option('mcp:read mcp:write', uiText('Read and change enabled advertising accounts'), uiText('This tool receives operator access. It can read your selected accounts and execute reviewed changes through amcp_write on accounts you explicitly enable for writes. Changes may affect campaign delivery or spend.'), true) : ''}${option('mcp:read', uiText('Read your selected advertising accounts'), uiText('This tool can read data available through your current AMCP account selections and prepare local dry runs. It cannot change your advertising accounts.'), !write)}</fieldset>${consentAccessSet(info)}${info.capped ? html`<p class="notice" role="note">${uiText('The app asked for reviewed changes too. Your workspace role allows read-only access, so it receives read access only.')}</p>` : ''}<details><summary>${uiText('Return address:')}</summary><code>${info.redirectUri}</code></details><p>${uiText('Requested permission:')} <code>${info.requestedScope ?? info.scope}</code></p><div class="dialog-actions"><button class="button" data-consent="deny">${uiText('Cancel')}</button><button class="button primary" data-consent="approve">${uiText('Authorize access')}</button></div></section>`,
  );
}
/**
 * What this person can do here, from their role and the deployment together (WEB-06). Before, the line showed only the
 * deployment's write switch, so a viewer read "Read + reviewed writes". The server still decides every request.
 */
function accessLine(s) {
  if (!s?.authenticated) return uiText('Not signed in');
  if (s.testAccount) return uiText('Test workspace · read access');
  // A member limited to a client access set (SEC-08) sees which client their access covers.
  if (s.accessSet)
    return s.accessSet.removed
      ? uiText('Access limited to a client that was removed')
      : uiText('Access limited to {client}', {client: s.accessSet.name ?? ''});
  const role = s.administrator ? uiText('Deployment administrator') : s.workspaceRole ? uiRole(s.workspaceRole) : '';
  if (s.workspaceRole === 'viewer' || (!s.administrator && !['owner', 'admin', 'operator'].includes(s.workspaceRole)))
    return role ? uiText('{role} · read-only access', {role}) : uiText('Read-only access');
  return s.writesEnabled
    ? uiText('{role} · read + reviewed writes', {role})
    : uiText('{role} · read-only workspace', {role});
}
/** Shell links follow the session: the brand opens Home when signed in, and members get the workspace switcher. */
function shellLinks() {
  document.querySelector('.sidebar .brand')?.setAttribute('href', session.authenticated ? '/dashboard' : '/');
  const toggle = document.getElementById('workspace-switch-open');
  if (!toggle) return;
  toggle.hidden = !session.authenticated || !!session.testAccount;
  if (toggle.hidden || toggle.dataset.identity !== identityKey(session)) closeWorkspaceMenu();
}
function closeWorkspaceMenu() {
  const toggle = document.getElementById('workspace-switch-open'),
    menu = document.getElementById('workspace-switch-menu');
  if (toggle) {
    toggle.setAttribute('aria-expanded', 'false');
    delete toggle.dataset.identity;
  }
  if (menu) {
    menu.hidden = true;
    menu.innerHTML = '';
  }
}
/**
 * The sidebar's workspace card switches workspaces in place (WEB-06): it lists the workspaces this sign-in belongs to,
 * read when opened, and switches with the account page's endpoint. api() resets private state on a switch.
 */
async function openWorkspaceMenu() {
  const toggle = document.getElementById('workspace-switch-open'),
    menu = document.getElementById('workspace-switch-menu');
  if (toggle.getAttribute('aria-expanded') === 'true') return closeWorkspaceMenu();
  const identity = identityGeneration;
  toggle.setAttribute('aria-expanded', 'true');
  toggle.dataset.identity = identityKey(session);
  menu.hidden = false;
  menu.innerHTML = `<p role="status">${esc(uiText('Loading your workspaces…'))}</p>`;
  const {workspaces = []} = await api('/api/workspaces');
  if (identity !== identityGeneration || toggle.getAttribute('aria-expanded') !== 'true') return;
  menu.innerHTML =
    `<p class="workspace-menu-title">${esc(uiText('Your workspaces'))}</p>` +
    workspaces
      .map(
        w =>
          `<button type="button" data-shell-switch="${esc(w.id)}" ${w.id === session.workspaceId ? 'aria-current="true" disabled' : ''}><bdi>${esc(w.name)}</bdi><small>${esc(w.id === session.workspaceId ? uiText('Current workspace') : uiRole(w.role))}</small></button>`,
      )
      .join('') +
    `<a href="/account">${esc(uiText('Manage your workspaces'))}</a>`;
  menu.querySelector('button:not([disabled]),a')?.focus();
}
async function switchWorkspaceFromShell(id) {
  if (!id || id === session.workspaceId) return;
  await api('/api/workspaces/switch', {method: 'POST', body: JSON.stringify({workspaceId: id})});
  session = await api('/api/session');
  const platformData = await api('/api/platforms');
  platforms = platformData.platforms;
  commerceSources = platformData.commerce_sources ?? [];
  providersNotOffered = platformData.providers_not_offered ?? [];
  closeWorkspaceMenu();
  // Plan, report and account IDs in the address belonged to the previous workspace: keep only the page.
  navigate(routeEntry(location.pathname) && routeAvailable(location.pathname) ? location.pathname : '/dashboard');
}
/**
 * The working client (SEC-08 phase 1, owner direction P1: many clients per workspace). Choosing a client narrows the
 * account pickers and lists to the accounts its client profile binds, within this person's current access. It is a
 * view filter, never access control: the server still decides every request, and only a client access set limits what
 * a person, token or AI client may reach. It is kept in the address (?client=) and in this tab for this person and
 * workspace, and forgotten on sign-out and on a workspace switch. The choices come with the session (/api/session
 * workingClients), so a page never waits for another request before it renders.
 */
const workingClientStore = 'amcp.workingClient';
const workingClientKey = () =>
  workingClientStore + ':' + JSON.stringify([session.id ?? session.userId ?? null, session.workspaceId ?? null]);
function workingClientRemembered() {
  try {
    return sessionStorage.getItem(workingClientKey());
  } catch {
    return null;
  }
}
function workingClientRemember(id) {
  try {
    if (id) sessionStorage.setItem(workingClientKey(), id);
    else sessionStorage.removeItem(workingClientKey());
  } catch {}
}
/** Forgets every working client this tab remembered (sign-out and workspace switch). */
function workingClientForget() {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(workingClientStore + ':')) sessionStorage.removeItem(key);
    }
  } catch {}
}
/**
 * The client profiles with accounts this person can reach, as the session lists them; none for a reviewer test account
 * or while a required two-step setup is pending.
 */
function workingClientList() {
  return session.authenticated &&
    !session.testAccount &&
    !session.mfaEnrollmentRequired &&
    Array.isArray(session.workingClients)
    ? session.workingClients
    : [];
}
/** The chosen working client: the address first, then this tab's memory; one no longer listed is no choice. */
function workingClient() {
  const listed = workingClientList();
  if (!listed.length) return null;
  const id = new URLSearchParams(location.search).get('client') ?? workingClientRemembered();
  return listed.find(c => c.profile_id === id) ?? null;
}
/** The profile_id argument of a list call: the working client's, or nothing. */
const workingClientQuery = () => (workingClient() ? {profile_id: workingClient().profile_id} : {});
const workingAccountKey = (gateway, id) => {
  const value = String(id ?? '');
  return gateway === 'meta_native_action'
    ? value.replace(/^act_/, '')
    : gateway === 'google_ads_native_action'
      ? value.replaceAll('-', '')
      : value;
};
/** Whether an account belongs to a client (the working client by default); always true when none is chosen. */
function inWorkingClient(gateway, accountId, connectionId, client = workingClient()) {
  if (!client) return true;
  return client.accounts.some(
    a =>
      a.gateway === gateway &&
      (!connectionId || a.connection_id === connectionId) &&
      workingAccountKey(gateway, a.account_id) === workingAccountKey(gateway, accountId),
  );
}
/** Whether the address names this account (?account_id=, with ?connection_id= when given), as a link to it does. */
function workingClientLinked(gateway, accountId, connectionId) {
  const params = new URLSearchParams(location.search),
    linked = params.get('account_id'),
    login = params.get('connection_id');
  return (
    !!linked &&
    workingAccountKey(gateway, linked) === workingAccountKey(gateway, accountId) &&
    (!login || !connectionId || login === connectionId)
  );
}
/**
 * The one account-option builder of the pickers (SEC-08): the accounts a picker offers, narrowed to the working client,
 * and the account to preselect, only when exactly one remains (otherwise the picker shows an explicit placeholder).
 * An account the address names stays listed, so a link to another client's account still opens it. `hidden` counts
 * the accounts the working client left out, so an empty picker can say so instead of asking to connect one.
 * describe maps an option to {gateway, account_id, connection_id}.
 */
function clientAccountOptions(options, describe = o => o) {
  const listed = options.filter(o => {
    const d = describe(o);
    return (
      inWorkingClient(d.gateway, d.account_id, d.connection_id) ||
      workingClientLinked(d.gateway, d.account_id, d.connection_id)
    );
  });
  return {options: listed, preselect: listed.length === 1 ? listed[0] : null, hidden: options.length - listed.length};
}
/** The notice of a picker the working client left empty, instead of asking to connect an account that is connected. */
const workingClientEmptyNotice = () =>
  uiText('The working client has no account for this. Choose All clients in the top bar to see every account.');
/**
 * The names of the clients a set of accounts spans, or none when one client holds every account a playbook binds: an
 * account two playbooks share, or one no playbook binds, mixes no clients.
 */
function workingClientsOf(scopes) {
  const clients = workingClientList(),
    holds = (c, s) => inWorkingClient(s.gateway, s.account_id, s.connection_id, c),
    bound = scopes.filter(s => clients.some(c => holds(c, s))),
    touched = clients.filter(c => bound.some(s => holds(c, s)));
  return touched.some(c => bound.every(s => holds(c, s))) ? [] : touched.map(c => c.name);
}
/** Work that spans accounts of different clients asks first (SEC-08); true when it does not, or once confirmed. */
async function confirmCrossClient(scopes, confirmLabel = uiText('Continue')) {
  const names = workingClientsOf(scopes);
  if (names.length < 2) return true;
  return confirmAction({
    title: uiText('These accounts belong to different clients'),
    consequence: uiText(
      'This work spans accounts of {count} clients. Continue only if mixing these clients is intended.',
      {count: names.length},
    ),
    confirmLabel,
    items: names,
  });
}
/**
 * The pages the working client applies to: signed-in workspace pages. Sign-in and authorization steps are left alone,
 * so their addresses stay as the provider or sign-in flow wrote them and the consent page shows only its own client
 * limit, never the view filter beside it.
 */
const workingClientSkipped = ['/auth/complete', '/oauth/consent', '/oauth/result'];
function workingClientApplies(path) {
  const entry = routeEntry(path);
  return !!entry && entry.public !== true && !workingClientSkipped.includes(path);
}
/** Addresses are compared and rewritten as path, query and fragment only, on a fixed placeholder origin. */
const addressOrigin = 'https://amcp.invalid';
const currentAddress = () => new URL(location.pathname + location.search + location.hash, addressOrigin);
/** An address that keeps the chosen working client (?client=), as render() keeps it; unchanged when none is chosen. */
function withWorkingClient(address) {
  const current = workingClient();
  if (!current) return address;
  try {
    const url = new URL(address, addressOrigin + location.pathname);
    if (url.origin !== addressOrigin || url.searchParams.has('client') || !workingClientApplies(url.pathname))
      return address;
    url.searchParams.set('client', current.profile_id);
    return url.pathname + url.search + url.hash;
  } catch {
    return address;
  }
}
/** Whether two addresses show the same page, whichever working client either names. */
function sameAddressIgnoringClient(a, b) {
  try {
    const plain = address => {
      const url = new URL(address, addressOrigin);
      url.searchParams.delete('client');
      return url.pathname + url.search + url.hash;
    };
    return plain(a) === plain(b);
  } catch {
    return a === b;
  }
}
/** Keeps ?client= in the address for the chosen client, and drops one this person no longer has. True if changed. */
function syncWorkingClientLocation() {
  const url = currentAddress(),
    named = url.searchParams.get('client'),
    current = workingClient();
  if (current) {
    workingClientRemember(current.profile_id);
    if (named === current.profile_id) return false;
    url.searchParams.set('client', current.profile_id);
  } else if (named !== null) {
    workingClientRemember(null);
    url.searchParams.delete('client');
  } else return false;
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  return true;
}
/** The top bar's working-client selector, shown when this person has client profiles with accounts. */
function renderWorkingClientControl() {
  const actions = document.querySelector('.top-actions');
  if (!actions) return;
  let control = document.getElementById('working-client-control');
  const listed = workingClientList();
  if (!listed.length || !workingClientApplies(location.pathname)) {
    control?.remove?.();
    return;
  }
  if (!control) {
    control = document.createElement('label');
    control.id = 'working-client-control';
    control.className = 'working-client-control';
    actions.prepend(control);
  }
  const current = workingClient(),
    note = uiText('A view filter for lists and pickers. It does not limit access.');
  control.title = note;
  control.innerHTML = `<span>${esc(uiText('Working client'))}</span><select data-working-client aria-describedby="working-client-note"><option value="">${esc(uiText('All clients'))}</option>${listed.map(c => `<option value="${esc(c.profile_id)}" ${current?.profile_id === c.profile_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select><small id="working-client-note" hidden>${esc(note)}</small>`;
}
document.addEventListener('change', async event => {
  const select = event.target.closest?.('[data-working-client]');
  if (!select) return;
  if (
    typeof pageLeaveGuard === 'function' &&
    pageLeaveGuard() &&
    !(await confirmAction({
      title: uiText('Leave without saving?'),
      consequence: uiText('Unsaved edits on this page will be lost. Saved work is kept.'),
      confirmLabel: uiText('Leave page'),
    }))
  ) {
    select.value = workingClient()?.profile_id ?? '';
    return;
  }
  workingClientRemember(select.value);
  const url = currentAddress();
  if (select.value) url.searchParams.set('client', select.value);
  else url.searchParams.delete('client');
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  await render();
});
/**
 * After a client playbook is saved or deleted, the selector lists the playbooks as they are now; a working client
 * whose playbook was deleted is dropped from the address and from this tab's memory. A failed read keeps the list as
 * it was: the playbook itself was saved.
 */
async function workingClientsChanged() {
  let data;
  try {
    data = await api('/api/working-clients');
  } catch (e) {
    if (e.code === 'REQUEST_SUPERSEDED') throw e;
    return;
  }
  session.workingClients = Array.isArray(data.clients) ? data.clients : [];
  if (syncWorkingClientLocation()) renderedLocation = location.pathname + location.search;
  renderWorkingClientControl();
}
// WEB-06: a failed shell action stays on screen until the next action or page, instead of a six-second toast.
function showShellAlert(message) {
  const alert = document.getElementById('shell-alert');
  if (!alert || !message) return toast(message);
  alert.textContent = message;
  alert.hidden = false;
}
function clearShellAlert() {
  const alert = document.getElementById('shell-alert');
  if (!alert || alert.hidden) return;
  alert.textContent = '';
  alert.hidden = true;
}
/** Renders the current address; scripts adjust it through AMCP hooks and parts, never by wrapping it (WEB-07). */
async function render() {
  AMCP.hooks.runBefore();
  const result = await renderCurrentPage();
  await AMCP.hooks.runAfter();
  return result;
}
async function renderCurrentPage() {
  const generation = ++navigationGeneration,
    identity = identityGeneration,
    pathname = location.pathname,
    routeChanged = renderedLocation !== location.pathname + location.search;
  renderedLocation = location.pathname + location.search;
  clearTimeout(pollTimer);
  if (routeChanged) clearShellAlert();
  pageLeaveGuard = null;
  const page = routeEntry(location.pathname),
    navigationKey = routeNavigationKey(location.pathname);
  document.body.classList.toggle('public-view', page?.public === true);
  // One name per page (WEB-06): the tab title, breadcrumb and heading use the registry's canonical label.
  const pageTitle =
    page?.label ??
    (location.pathname
      .slice(1)
      .replaceAll('-', ' ')
      .replace(/^./, c => c.toUpperCase()) ||
      uiText('Workspace'));
  document.title = uiText(pageTitle) + ' · AMCP';
  applyUILocale();
  document.getElementById('workspace-name').textContent = uiWorkspaceName(session.workspaceName, session.name);
  document.getElementById('user-avatar').textContent = (session.name ?? 'A').slice(0, 1).toUpperCase();
  $('.readonly-indicator').innerHTML = `<i></i>` + esc(accessLine(session));
  shellLinks();
  const footerAccess = session.writesEnabled
    ? 'Encrypted connections · Reviewed write access'
    : 'Encrypted connections · Read-only access';
  const footer = $('.page-footer').lastElementChild;
  footer.setAttribute('data-ui-text', footerAccess);
  footer.textContent = uiText(footerAccess);
  document.querySelectorAll('[data-route]').forEach(a => {
    const current = a.dataset.route === navigationKey;
    a.classList.toggle('active', current);
    if (current) {
      a.setAttribute('aria-current', 'page');
      const group = a.closest?.('details');
      if (group) group.open = true;
    } else a.removeAttribute('aria-current');
  });
  // A child page names its parent first: "Connections / Connection result".
  $('#breadcrumb').textContent = page
    ? (page.parent ? uiText(routeLabel(page.parent)) + ' / ' : '') + uiText(page.label)
    : uiText(
        {terms: 'Terms', 'data-deletion': 'Data deletion', privacy: 'Privacy'}[location.pathname.slice(1)] ??
          'Workspace',
      );
  $('#login-button').hidden = session.authenticated;
  $('#logout-button').hidden = !session.authenticated;
  try {
    // WEB-06: a new page replaces the previous one at once with its heading and a busy placeholder, so the previous
    // page's controls cannot be used while this one loads its files and data.
    const pending = pageAssetsPending(pathname);
    if (pending || (routeChanged && page && !page.public))
      content.innerHTML = `<div class="page-heading"><div><h1>${esc(uiText(pageTitle))}</h1></div></div><section class="panel" role="status" aria-busy="true" id="route-loading"><p>${esc(uiText('Loading this page…'))}</p></section>`;
    if (pending) await ensurePageAssets(pathname);
    // The working client (SEC-08): the session lists the choices, and the address keeps ?client= for this page.
    if (session.authenticated && workingClientApplies(location.pathname) && syncWorkingClientLocation())
      renderedLocation = location.pathname + location.search;
    renderWorkingClientControl();
    if (generation !== navigationGeneration || identity !== identityGeneration || pathname !== location.pathname)
      return;
    if (location.pathname === '/') return await renderLanding();
    if (['/login', '/signup', '/forgot-password', '/reset-password', '/verify-email'].includes(location.pathname))
      return await renderAuthPage();
    if (location.pathname === '/auth/complete') {
      afterSignIn();
      return;
    }
    // A member whose workspace now requires two-step verification sets it up first (SEC-06); the server refuses the
    // other workspace APIs until then, so every other page shows Account instead.
    if (session.authenticated && session.mfaEnrollmentRequired && location.pathname !== '/account') {
      history.replaceState({}, '', '/account');
      return await renderAccountPage();
    }
    if (location.pathname === '/account') return await renderAccountPage();
    if (location.pathname === '/reporting-overview') return await renderReportingOverview();
    if (
      [
        '/dashboard',
        '/campaigns',
        '/media',
        '/reports',
        '/operations',
        '/capabilities',
        '/report-library',
        '/report-pack',
        '/monitors',
        '/portfolio',
        '/measurement',
        '/commerce',
        '/schedules',
        '/profiles',
      ].includes(location.pathname)
    )
      return await renderWorkspacePage();
    if (['/privacy', '/terms', '/data-deletion'].includes(location.pathname)) return renderLegal();
    if (location.pathname === '/oauth/consent') return await renderConsent();
    if (location.pathname === '/oauth/result') return await renderCallback();
    if (location.pathname === '/connectors') return await renderConnectors();
    if (location.pathname === '/activity') return await renderActivity();
    if (location.pathname === '/settings') return await renderSettings();
    renderConnections();
    if (location.pathname === '/login') showLogin();
    else if (location.pathname === '/connections') openLinkedConnection();
  } catch (e) {
    if (
      generation === navigationGeneration &&
      identity === identityGeneration &&
      pathname === location.pathname &&
      e.code !== 'REQUEST_SUPERSEDED'
    )
      showPageError(e);
  }
}
document.addEventListener('click', async event => {
  const el = event.target.closest('button,a');
  if (!el) return;
  // Skip links and in-page jumps (#main, #overview-config) move focus without a history entry or a re-render.
  const section = fragmentLink(event, el);
  if (section) {
    event.preventDefault();
    focusFragmentTarget(section);
    return;
  }
  if (clientNavigation(event, el)) {
    event.preventDefault();
    const href = el.getAttribute('href');
    if (
      typeof pageLeaveGuard === 'function' &&
      pageLeaveGuard() &&
      !(await confirmAction({
        title: uiText('Leave without saving?'),
        consequence: uiText('Unsaved edits on this page will be lost. Saved work is kept.'),
        confirmLabel: uiText('Leave page'),
      }))
    )
      return;
    navigate(href);
    return;
  }
  if (el.dataset.close) {
    $('#' + el.dataset.close).close();
    return;
  }
  // A shell action's error stays on screen until the person's next action (WEB-06).
  if (typeof clearShellAlert === 'function') clearShellAlert();
  let disabledHere = false;
  const disableControl = () => {
    disabledHere = true;
    el.disabled = true;
  };
  try {
    if (el.id === 'workspace-switch-open') return await openWorkspaceMenu();
    if (el.dataset.shellSwitch) {
      disableControl();
      return await switchWorkspaceFromShell(el.dataset.shellSwitch);
    }
    if (el.dataset.consent) {
      disableControl();
      const approved = el.dataset.consent === 'approve',
        scope = approved ? $('input[name="consent-scope"]:checked')?.value : undefined,
        accessSet = approved ? $('#consent-access-set')?.value : undefined;
      const result = await api('/api/mcp/consent', {
        method: 'POST',
        body: JSON.stringify({
          request: new URLSearchParams(location.search).get('request'),
          approved,
          ...(scope ? {scope} : {}),
          ...(accessSet ? {access_set_id: accessSet} : {}),
        }),
      });
      location.assign(result.url);
      return;
    }
    if (el.id === 'login-button' || el.dataset.action === 'login') return showLogin();
    if (el.id === 'logout-button') {
      await api('/api/session', {method: 'DELETE'});
      session = await api('/api/session');
      const platformData = await api('/api/platforms');
      platforms = platformData.platforms;
      commerceSources = platformData.commerce_sources ?? [];
      providersNotOffered = platformData.providers_not_offered ?? [];
      navigate('/');
      return;
    }
    if (el.dataset.action === 'refresh') {
      disableControl();
      await refresh();
      toast(uiText('Workspace refreshed. Use Sync to refresh provider assets.'));
      return;
    }
    if (el.dataset.filter) {
      filter = el.dataset.filter;
      return renderConnections();
    }
    if (el.dataset.manage) return openManage(el.dataset.manage);
    if (el.dataset.selectLogin) return openManage(currentPlatform, el.dataset.selectLogin);
    if (el.dataset.connect) {
      disableControl();
      return await startConnection(el.dataset.connect);
    }
    if (el.dataset.reauthorize) {
      disableControl();
      const result = await api('/api/connections/' + encodeURIComponent(el.dataset.reauthorize) + '/reauthorize', {
        method: 'POST',
      });
      location.assign(result.url);
      return;
    }
    if (el.dataset.credentialRetry) {
      disableControl();
      const result = await api(
        '/api/connections/' + encodeURIComponent(el.dataset.credentialRetry) + '/credential-retry',
        {
          method: 'POST',
          body: '{}',
        },
      );
      currentConnection = el.dataset.credentialRetry;
      await refresh();
      toast(
        result.retry
          ? uiText('AMCP will ask the provider to renew this login on its next request.')
          : uiText('No renewal failure is recorded for this login.'),
      );
      return;
    }
    if (el.dataset.assetKind) {
      assetKind = el.dataset.assetKind;
      assetSearch = '';
      return renderManage();
    }
    if (el.dataset.sync || el.dataset.syncKind) {
      disableControl();
      el.textContent = uiText('Syncing…');
      const id = el.dataset.sync ?? currentConnection;
      await syncConnection(id, [
        el.dataset.syncKind ?? platforms.find(p => p.id === currentPlatform)?.selectionKind ?? 'ad_accounts',
      ]);
      return;
    }
    if (el.dataset.default) {
      await api('/api/connections/' + el.dataset.default + '/default', {method: 'POST', body: '{}'});
      await refresh();
      toast(uiText('Default login updated.'));
      return;
    }
    if (el.dataset.renameLogin) {
      const label = $('#login-label')?.value.trim() ?? '';
      if (!label || label.length > 80) {
        toast(uiText('Use a login name of 1 to 80 characters.'));
        return;
      }
      disableControl();
      await api('/api/connections/' + encodeURIComponent(el.dataset.renameLogin) + '/label', {
        method: 'PATCH',
        body: JSON.stringify({label}),
      });
      await refresh();
      toast(uiText('Login renamed.'));
      return;
    }
    if (el.dataset.disconnect) {
      // CON-05 sub-item 10: provider revocation is offered only where the deployment owner turned it on.
      const offer = platforms.find(p => p.connections?.some(c => c.id === el.dataset.disconnect))?.provider_revocation;
      $('#confirm-form').dataset.connectionId = el.dataset.disconnect;
      $('#confirm-revoke').hidden = !(offer?.available && offer.provider === 'google');
      $('#confirm-revoke-provider').checked = false;
      $('#confirm-error').textContent = '';
      $('#confirm-submit').disabled = false;
      $('#confirm-dialog').showModal();
      return;
    }
    if (el.dataset.selectAll) {
      document.querySelectorAll('[data-asset-key]').forEach(input => {
        input.checked = true;
        selected.add(input.dataset.assetKey);
      });
      renderManage();
      return;
    }
    if (el.dataset.saveAssets) {
      const p = platforms.find(p => p.id === currentPlatform),
        login = p?.connections.find(c => c.id === currentConnection),
        toggle = $('#selection-write-access'),
        writeAccess = toggle && toggle.checked !== (login?.defaultWriteAccess === true) ? toggle.checked : undefined,
        added = selectionWriteAdditions(p, login, toggle ? toggle.checked : undefined);
      // A selection that enables write access for more resources names them and asks first (D19, CON-05).
      if (
        added.length &&
        !(await confirmAction({
          title: uiText('Enable write access for these resources?'),
          consequence: uiText(
            'Write access will be enabled for the resources below. Operator connectors may then prepare and execute reviewed changes on them; each change still needs its own review.',
          ),
          confirmLabel: uiText('Enable write access'),
          items: added,
        }))
      )
        return;
      disableControl();
      const checkAfter = el.dataset.saveAssets === 'check',
        before = new Set(login?.accounts ?? []);
      await api('/api/connections/' + currentConnection + '/assets', {
        method: 'PATCH',
        body: JSON.stringify({
          selected: [...selected],
          ...(writeAccess === undefined ? {} : {write_access: writeAccess}),
          ...(added.length ? {confirmed: true} : {}),
        }),
      });
      await refresh();
      toast(uiText('Selection saved. Platform data was not changed.'));
      if (checkAfter) await checkSelectedAccess(currentPlatform, currentConnection, before);
      return;
    }
    if (el.dataset.saveWriteAccess || el.dataset.revokeWriteAccess) {
      if (
        el.dataset.revokeWriteAccess &&
        !(await confirmAction({
          title: uiText('Revoke write access for this login?'),
          consequence: uiText(
            'Operators can no longer prepare or execute changes on any account of this login. Reads and existing reviews are unaffected; executes will be refused.',
          ),
          confirmLabel: uiText('Revoke write access'),
        }))
      )
        return;
      const accounts = el.dataset.revokeWriteAccess ? [] : [...writeSelected];
      if (accounts.length && !$('#confirm-write-access')?.checked) {
        toast(uiText('Confirm account write access before saving.'));
        return;
      }
      disableControl();
      await api('/api/connections/' + currentConnection + '/write-access', {
        method: 'PATCH',
        body: JSON.stringify({accounts, confirmed: accounts.length > 0}),
      });
      await refresh();
      toast(
        accounts.length
          ? uiText('Write access saved for the selected accounts. No advertising changes were executed.')
          : uiText('Resource write access revoked for this login.'),
      );
      return;
    }
    if (el.dataset.saveReportJobs || el.dataset.revokeReportJobs) {
      const accounts = el.dataset.revokeReportJobs ? [] : [...reportJobSelected];
      if (accounts.length && !$('#confirm-report-jobs')?.checked) {
        toast(uiText('Confirm report-job access before saving.'));
        return;
      }
      disableControl();
      await api('/api/connections/' + currentConnection + '/report-job-access', {
        method: 'PATCH',
        body: JSON.stringify({accounts, confirmed: accounts.length > 0}),
      });
      await refresh();
      toast(
        accounts.length
          ? uiText('Report-job access saved. No report job was created.')
          : uiText('Report-job access revoked for this login.'),
      );
      return;
    }
    if (el.dataset.client) {
      client = el.dataset.client;
      return await renderConnectors();
    }
    if (el.dataset.copyEndpoint) {
      await navigator.clipboard.writeText(session.origin + '/mcp');
      toast(uiText('Endpoint copied.'));
      return;
    }
    if (el.dataset.copyConfig) {
      await navigator.clipboard.writeText(connectorCode());
      toast(uiText('Configuration copied.'));
      return;
    }
    if (el.dataset.copyCallback) {
      await navigator.clipboard.writeText(platforms.find(p => p.id === el.dataset.copyCallback).callback);
      toast(uiText('Callback URI copied.'));
      return;
    }
    if (el.dataset.createToken || el.dataset.createOperatorToken) {
      if (!requireLogin()) return;
      const operator = !!el.dataset.createOperatorToken;
      if (operator && !$('#operator-token-consent')?.checked) {
        toast(uiText('Confirm operator access before creating this token.'));
        return;
      }
      disableControl();
      const limit = $('#token-access-set')?.value;
      const result = await api('/api/connector-tokens', {
        method: 'POST',
        body: JSON.stringify({
          name: client === 'codex' ? 'Codex' : client === 'cursor' ? 'Cursor' : 'MCP client',
          role: operator ? 'operator' : 'reader',
          confirmed: operator,
          ...(limit ? {access_set_id: limit} : {}),
        }),
      });
      await renderConnectors();
      setHtml(
        $('#new-token'),
        html`<div class="notice"><div><strong>${uiText('Save this token now. It is shown only once.')}</strong><pre class="code-block token-secret" id="token-value"></pre><button class="button small" id="copy-new-token">${uiText('Copy token')}</button></div></div>`,
      );
      $('#token-value').textContent = result.token;
      $('#copy-new-token').onclick = async () => {
        await navigator.clipboard.writeText(result.token);
        toast(uiText('Token copied. Keep it private.'));
      };
      return;
    }
    if (el.dataset.revokeClient) {
      if (
        !(await confirmAction({
          title: uiText('Revoke this MCP client?'),
          consequence: uiText(
            'Its access and refresh tokens stop working now. The client has to be authorized again to reconnect.',
          ),
          confirmLabel: uiText('Revoke client'),
        }))
      )
        return;
      // A client metadata document's client ID is a URL, and one app's ID is shared by everyone who uses it: encode the
      // ID, and end only the listed person's connection when the row names one (MCP-08 with CIMD).
      await api(
        '/api/mcp/authorizations/' +
          encodeURIComponent(el.dataset.revokeClient) +
          (el.dataset.revokeOwner !== undefined ? '?owner=' + encodeURIComponent(el.dataset.revokeOwner) : ''),
        {method: 'DELETE'},
      );
      await renderConnectors();
      toast(uiText('MCP client access revoked.'));
      return;
    }
    if (el.dataset.revokeToken) {
      if (
        !(await confirmAction({
          title: uiText('Revoke this connector token?'),
          consequence: uiText(
            'Every MCP client configured with this token loses access now. Create a new token to reconnect.',
          ),
          confirmLabel: uiText('Revoke token'),
        }))
      )
        return;
      await api('/api/connector-tokens/' + el.dataset.revokeToken, {method: 'DELETE'});
      await renderConnectors();
      toast(uiText('Connector token revoked.'));
      return;
    }
    if (el.dataset.callbackManage) {
      navigate('/connections');
      return openManage(el.dataset.callbackManage, el.dataset.connectionId);
    }
  } catch (e) {
    // On the page, the error persists above the content until the next action; inside a dialog it stays a toast.
    if (el.closest?.('dialog')) toast(errorMessage(e));
    else showShellAlert(errorLines(e));
  } finally {
    if (disabledHere && el.isConnected) el.disabled = false;
  }
});
document.addEventListener('input', event => {
  if (event.target.id === 'platform-search') {
    search = event.target.value;
    renderPlatformCards();
  }
  if (event.target.id === 'asset-search') {
    assetSearch = event.target.value;
    const c = platforms.find(p => p.id === currentPlatform)?.connections.find(c => c.id === currentConnection),
      group = c?.groups.find(g => g.kind === assetKind);
    setHtml(
      $('#asset-rows'),
      assetRows(
        (group?.assets ?? []).filter(a => (a.name + ' ' + a.id).toLowerCase().includes(assetSearch.toLowerCase())),
        group,
      ),
    );
  }
});
document.addEventListener('change', event => {
  if (event.target.dataset.writeAccount) {
    if (event.target.checked) writeSelected.add(event.target.dataset.writeAccount);
    else writeSelected.delete(event.target.dataset.writeAccount);
    const confirm = $('#confirm-write-access');
    if (confirm) confirm.checked = false;
  }
  if (event.target.dataset.reportJobAccount) {
    if (event.target.checked) reportJobSelected.add(event.target.dataset.reportJobAccount);
    else reportJobSelected.delete(event.target.dataset.reportJobAccount);
    const confirm = $('#confirm-report-jobs');
    if (confirm) confirm.checked = false;
  }
  if (event.target.dataset.assetKey) {
    if (event.target.checked) selected.add(event.target.dataset.assetKey);
    else selected.delete(event.target.dataset.assetKey);
    const badge = event.target.closest('tr').querySelector('.status');
    badge.className = 'status ' + (event.target.checked ? 'online' : 'offline');
    badge.textContent = event.target.checked ? uiText('Selected') : uiText('Available');
  }
});
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $('#login-error').textContent = '';
  try {
    const result = await api('/api/session', {method: 'POST', body: JSON.stringify({password: $('#password').value})});
    session = await api('/api/session');
    $('#password').value = '';
    $('#login-dialog').close();
    const platformData = await api('/api/platforms');
    platforms = platformData.platforms;
    commerceSources = platformData.commerce_sources ?? [];
    providersNotOffered = platformData.providers_not_offered ?? [];
    afterSignIn();
  } catch (e) {
    $('#login-error').textContent = errorMessage(e);
  } finally {
    button.disabled = false;
  }
});
$('#confirm-form').addEventListener('submit', async event => {
  event.preventDefault();
  // One request at a time: a second click while Google answers would send the token again. A refusal is shown inside
  // the dialog, which stays open so the administrator can retry or disconnect without revocation (CON-05).
  const button = $('#confirm-submit'),
    error = $('#confirm-error'),
    id = event.currentTarget.dataset.connectionId;
  if (button.disabled) return;
  button.disabled = true;
  error.textContent = '';
  try {
    const revoke = !$('#confirm-revoke').hidden && $('#confirm-revoke-provider').checked;
    const result = await api('/api/connections/' + encodeURIComponent(id), {
      method: 'DELETE',
      ...(revoke ? {body: JSON.stringify({revoke_at_provider: true})} : {}),
    });
    $('#confirm-dialog').close();
    currentConnection = null;
    await refresh();
    // Only the outcome Google gave is claimed: an answer without one (say the server took the local path) never reads
    // as a revocation that may not have happened.
    const outcome = result?.provider_revocation?.outcome;
    toast(
      !revoke
        ? uiText('Login disconnected from AMCP.')
        : outcome === 'revoked'
          ? uiText('Login disconnected from AMCP and its access revoked at Google.')
          : outcome === 'token_already_invalid'
            ? uiText(
                'Login disconnected. Google reported that its token no longer worked, so AMCP’s access through it had already ended.',
              )
            : uiText(
                'Login disconnected from AMCP. AMCP could not confirm that Google revoked its access; remove AMCP in the Google Account’s third-party connections.',
              ),
    );
  } catch (e) {
    if ($('#confirm-dialog').open) error.textContent = errorMessage(e);
    else toast(errorMessage(e));
  } finally {
    button.disabled = false;
  }
});
// A history step that changes only the fragment (a skip link, an in-page jump, or Back over one) moves focus to its
// section. Re-rendering would clear what the person typed and repeat the page's requests (WEB-01).
window.addEventListener('popstate', async () => {
  if (renderedLocation === location.pathname + location.search) {
    const target = fragmentTarget(location.hash);
    if (target) focusFragmentTarget(target);
    return;
  }
  // Back and Forward land on the page heading like a link does, once that page has rendered and is still current.
  const shown = location.pathname + location.search + location.hash;
  await render();
  // An older entry gains the working client in its address as it renders (SEC-08); it is still the page shown.
  if (!sameAddressIgnoringClient(location.pathname + location.search + location.hash, shown)) return;
  const target = fragmentTarget(location.hash);
  if (target) focusFragmentTarget(target);
  else focusPageHeading();
});
/** A plain activation of a link to a section of the current page, or null. */
function fragmentLink(event, el) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.altKey ||
    el.tagName !== 'A' ||
    el.hasAttribute('download') ||
    el.getAttribute('target')
  )
    return null;
  const href = el.getAttribute('href');
  return href?.startsWith('#') ? fragmentTarget(href) : null;
}
function clientNavigation(event, el) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.altKey ||
    el.tagName !== 'A' ||
    el.hasAttribute('download') ||
    el.getAttribute('target')
  )
    return false;
  const href = el.getAttribute('href');
  if (!href?.startsWith('/') || href.startsWith('//')) return false;
  // Every page in the route registry is client-navigable; anything else is a document (WEB-06).
  return routeEntry(href.split(/[?#]/)[0]) !== undefined;
}
(async () => {
  // All deferred feature scripts must be initialized before a fast local session response can start rendering.
  if (document.readyState !== 'complete')
    await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, {once: true}));
  try {
    // The session is asked while the shell chunk downloads (WEB-07); the page renders once both are here.
    const sessionRequest = api('/api/session');
    // A page's own scripts and chunks start once the session says this person may open it, while the shell chunk and
    // the platforms load; a signed-out or out-of-scope visitor downloads nothing for a page it cannot open.
    sessionRequest.then(
      answer => {
        if (typeof pageAssetsFor !== 'function' || !answer?.authenticated || !routeAvailable(location.pathname, answer))
          return;
        for (const file of pageAssetsFor(location.pathname)) loadPageAsset(file).catch(() => {});
        uiPrefetchChunks(pageLocaleChunks(location.pathname));
      },
      () => {},
    );
    await initializeUILocale();
    session = await sessionRequest;
    await refresh();
    // A fresh load at a section of a workspace page opens there once the page has its data, as an in-app link does
    // (WEB-08: the palette's /settings#owner-write-pause). The browser found nothing there while the page was empty.
    if (globalThis.location?.hash && !document.body.classList.contains('public-view')) {
      const section = fragmentTarget(location.hash);
      if (section) focusFragmentTarget(section);
    }
  } catch (e) {
    content.innerHTML =
      header('AMCP', uiText('Your advertising workspace')) + `<div class="notice warning">${errorBlock(e)}</div>`;
  }
})();

function googleAssetLabel(a) {
  const status = {CANCELED: 'Cancelled', ENABLED: 'Active', SUSPENDED: 'Suspended', CLOSED: 'Closed'}[a.status];
  return html`${a.status ? ' · ' + uiText(status ?? a.status) : ''}${a.manager ? ' · ' + uiText('Manager') : ''}${a.hidden ? ' · ' + uiText('Hidden') : ''}${a.testAccount ? ' · ' + uiText('Test account') : ''}${a.parentId ? html` · ${raw(uiMarkup('Via manager {id}', {id: html`<bdi dir="ltr">${a.parentId}</bdi>`}))}` : ''}`;
}

function renderAssetSyncDiagnostics(group) {
  const diagnostics = group?.diagnostics ?? [];
  if (!diagnostics.length) return group?.error ? `<p class="error" role="alert">${esc(group.error)}</p>` : '';
  return `<div role="status"><p class="error">${esc(uiText('Some assets could not be synced. Your login is saved; review the provider details below.'))}</p>${diagnostics.map(d => `<details class="activity-failure" open><summary>${esc(d.account_id ?? uiText('Connection'))} · ${esc(d.provider?.code ?? d.code)}</summary>${renderSourceDiagnostic(d)}</details>`).join('')}</div>`;
}
