'use strict';

// A readable projection of the frozen server review. Units and identifiers remain native: a budget in micros is
// never relabelled as currency without a provider's currency/unit contract. The complete review stays available.
function reviewFields(value, path = '', out = []) {
  if (out.length >= 160) return out;
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, '$ref')) {
    out.push({path, value: uiText('Verified dependency: {reference}', {reference: value.$ref}), reference: true});
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (out.length >= 160) break;
      reviewFields(child, path + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1'), out);
    }
  } else out.push({path, value});
  return out;
}
const reviewValue = value => (value === null ? uiText('Not supplied') : String(value ?? ''));
// A request's warnings are AMCP's own notes: translated, unlike the native values beside them (design review 2026-10).
const reviewNote = f => (/^\/warnings(\/|$)/.test(f.path) ? uiText(reviewValue(f.value)) : reviewValue(f.value));
// `native`: which values are the native request or provider-observed state, kept literal in every language (QA-03):
// true for all, or a test of the field path. AMCP's own notes (a request's warnings) stay translatable text.
function reviewTable(value, caption, {native = false} = {}) {
  const fields = reviewFields(value);
  return fields.length
    ? `<div class="data-scroll" role="region" aria-label="${esc(caption)}" tabindex="0"><table class="review-table"><caption>${esc(caption)}</caption><thead><tr><th scope="col">${esc(uiText('Field / native unit'))}</th><th scope="col">${esc(uiText('Value'))}</th></tr></thead><tbody>${fields.map(f => `<tr><th scope="row"><code dir="ltr">${esc(f.path || 'value')}</code></th><td dir="auto"${(typeof native === 'function' ? native(f.path) : native) ? ' data-native' : ''}>${esc(reviewNote(f))}</td></tr>`).join('')}</tbody></table></div>${fields.length === 160 ? `<p class="form-note">${esc(uiText('Summary limited to 160 fields. Inspect the complete request below before approving.'))}</p>` : ''}`
    : blank(uiText('No values supplied.'));
}
const reviewConsentLabels = {
  confirmed: 'I reviewed this exact request and authorize its execution.',
  spend_change_confirmed: 'I authorize the budget, bid or serving change shown in this review.',
  cap_override_confirmed: 'I authorize the specific spending-policy override shown in this review.',
  creative_edit_confirmed: 'I authorize the creative edit and its stated impact on existing ads.',
  // WRT-09: the owner's opt-in acknowledgement before a deletion.
  destructive_confirmed: 'I authorize the deletion shown in this review. It cannot be undone.',
};
const reviewConsentIds = {
  confirmed: 'review-consent',
  spend_change_confirmed: 'spend-consent',
  cap_override_confirmed: 'cap-consent',
  creative_edit_confirmed: 'creative-consent',
  destructive_confirmed: 'destructive-consent',
};
/**
 * A person's approval on the website that a review needs before it runs (WRT-09): who approves, and the approval page.
 * The server's path is followed only when it is this site's own.
 */
function reviewApprovalNotice(approval) {
  if (!approval || approval.required !== true) return '';
  const path = typeof approval.website_path === 'string' ? approval.website_path : '',
    own = /^\/(?![/\\])/.test(path),
    byMode = Array.isArray(approval.classes) && approval.classes.length > 0,
    who = [
      ...(byMode && approval.mode === 'distinct_approver'
        ? [
            uiText(
              'Another member than the one who prepared it, or the workspace owner, approves it on the AMCP website.',
            ),
          ]
        : byMode && approval.mode === 'website_approval'
          ? [uiText('A signed-in member with write access approves it on the AMCP website.')]
          : []),
      ...(approval.owner_required
        ? [
            uiText(
              'Only the workspace owner executes a change beyond a spending cap, or approves it on the AMCP website first.',
            ),
          ]
        : []),
    ];
  return `<div class="notice" role="note"><p><strong>${esc(uiText('This change needs a person’s approval on the AMCP website before it runs.'))}</strong></p>${who.map(text => `<p class="form-note">${esc(text)}</p>`).join('')}${own ? `<a class="button small" href="${esc(path)}">${esc(uiText('Open the approval page'))}</a>` : ''}</div>`;
}
function requiredReviewConsents(review) {
  return Object.keys(reviewConsentLabels).filter(
    key => key === 'confirmed' || review.execute_requirements?.[key] === true,
  );
}
// WEB-03 (design review 2026-10): an authorization not ticked is refused beside its box, which takes focus; before, the
// box's own label came back as a six-second toast in the corner that outlived the execution. Ticking clears it.
function readReviewConsents(review) {
  const ids = requiredReviewConsents(review).map(key => reviewConsentIds[key]),
    missing = ids.filter(id => !$('#' + id)?.checked);
  if (missing.length)
    reviewConsentRefusal(
      ids,
      missing,
      missing.length === 1
        ? 'Tick the authorization above to execute this request.'
        : 'Tick each authorization above to execute this request.',
    );
  reviewConsentMark(ids, []);
  return Object.fromEntries(requiredReviewConsents(review).map(key => [key, true]));
}
/** Marks the boxes not ticked and shows (or, with none, hides) the refusal beside the authorizations. */
function reviewConsentMark(ids, missing, text = '') {
  const note = $('#review-consent-error');
  if (note) {
    note.textContent = text;
    note.hidden = !missing.length;
  }
  for (const id of ids) {
    const box = $('#' + id);
    if (!box) continue;
    // Only the refusal's own id is added or removed; a description the box already has stays.
    const described = (box.getAttribute?.('aria-describedby') ?? '')
      .split(/\s+/)
      .filter(token => token && token !== 'review-consent-error');
    if (missing.includes(id)) {
      box.setAttribute('aria-invalid', 'true');
      described.push('review-consent-error');
    } else box.removeAttribute('aria-invalid');
    if (described.length) box.setAttribute('aria-describedby', described.join(' '));
    else box.removeAttribute('aria-describedby');
  }
}
/** Refuses an execution whose authorizations are not all ticked: shown in place, never as a toast. */
function reviewConsentRefusal(ids, missing, message) {
  const text = uiText(message);
  reviewConsentMark(ids, missing, text);
  $('#' + missing[0])?.focus();
  throw Object.assign(Error(text), {code: 'CONSENT_REQUIRED', presented: true});
}
/** Ticking a box clears its own refusal; the note goes once every box is ticked. */
function bindReviewConsents() {
  const ids = Object.values(reviewConsentIds).filter(id => $('#' + id));
  for (const id of ids)
    $('#' + id).addEventListener?.('change', () => {
      if (!$('#review-consent-error') || $('#review-consent-error').hidden) return;
      const missing = ids.filter(other => !$('#' + other).checked);
      reviewConsentMark(ids, missing, missing.length ? $('#review-consent-error').textContent : '');
    });
}
// The server's one-line summary of a review (WRT-05): the operation is translated; entity, account, field names,
// amounts and statuses stay as the server wrote them. The exact table below remains what is sent.
const reviewOperationLabels = {
  create: 'Create',
  update: 'Update',
  delete: 'Delete',
  remove: 'Remove',
  publish: 'Publish',
  change: 'Change',
};
function reviewSummaryLine(summary) {
  if (!summary || typeof summary !== 'object' || typeof summary.operation !== 'string') return '';
  const account = summary.account ?? {},
    accountText = account.name ? account.name + ' (' + (account.id ?? '') + ')' : (account.id ?? ''),
    items = [
      ...(summary.money ?? []).map(
        m =>
          `<li><code dir="ltr">${esc(String(m.field).split('/').at(-1))}</code> <bdi dir="ltr">${m.amount !== undefined ? esc(m.amount + (m.currency ? ' ' + m.currency : '')) + ' · ' : ''}${esc(m.native)}${m.native_unit ? ' ' + esc(m.native_unit) : ''}</bdi></li>`,
      ),
      ...(summary.status ?? []).map(
        s =>
          `<li><code dir="ltr">${esc(String(s.field).split('/').at(-1))}</code> <bdi dir="ltr">${s.from ? esc(s.from) + ' → ' : ''}${esc(s.to)}</bdi></li>`,
      ),
    ];
  // The server lists the first entries of a large request; the exact table below holds every one.
  const more =
    Math.max(0, (summary.money_total ?? 0) - (summary.money ?? []).length) +
    Math.max(0, (summary.status_total ?? 0) - (summary.status ?? []).length);
  if (more > 0) items.push(`<li>${esc(uiText('(+{count} more)', {count: uiNumber(more)}))}</li>`);
  return `<div class="review-summary"><p><strong>${esc(uiText(reviewOperationLabels[summary.operation] ?? 'Change'))}</strong> <bdi dir="ltr">${esc(uiNumber(summary.count ?? 1))} × ${esc(summary.entity ?? '')}</bdi>${accountText ? ` ${esc(uiText('· Account'))} <bdi dir="auto">${esc(accountText)}</bdi>` : ''}</p>${items.length ? `<ul>${items.join('')}</ul>` : ''}<p class="form-note">${esc(uiText('A summary only: the exact native request below is what is sent.'))}</p></div>`;
}
let reviewCountdownTimer;
/**
 * A live countdown to the review's server expires_at. At zero Execute is disabled, the review says nothing was sent,
 * and "Prepare again" (when the page can prepare the same request again) reads the state again for a new review.
 */
function bindReviewCountdown(review, prepareAgain) {
  clearInterval(reviewCountdownTimer);
  // Every review panel binds its countdown right after it renders; its authorizations are wired here too.
  bindReviewConsents();
  const label = $('#review-countdown'),
    deadline = Date.parse(review?.expires_at);
  if (!label || !Number.isFinite(deadline)) return;
  const tick = () => {
    if (label.isConnected === false) {
      clearInterval(reviewCountdownTimer);
      return true;
    }
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (left > 0) {
      label.textContent = uiText('Expires in {time}', {
        time: Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0'),
      });
      return false;
    }
    clearInterval(reviewCountdownTimer);
    label.textContent = uiText('This review expired. Nothing was sent.');
    const execute = $('#execute-reviewed');
    if (execute) execute.disabled = true;
    const expired = $('#review-expired');
    if (expired) expired.hidden = false;
    return true;
  };
  if (!tick()) reviewCountdownTimer = setInterval(tick, 1000);
  if (prepareAgain) workspaceBind('#prepare-again', prepareAgain);
  else if ($('#prepare-again')) $('#prepare-again').hidden = true;
}
// What Meta's is_adset_budget_sharing_enabled choice means, in words; the native field and value stay literal.
function budgetSharingNote(value) {
  const shared = typeof value === 'string' ? value === 'true' : value;
  if (typeof shared !== 'boolean') return '';
  return `<p class="form-note"><code dir="ltr">is_adset_budget_sharing_enabled: ${esc(String(value))}</code> — ${esc(
    uiText(
      shared
        ? 'Ad set budget sharing is on: Meta may move part of one ad set’s budget to another ad set in this campaign. Meta requires this choice from Graph API v24.0 when budgets are set on ad sets.'
        : 'Ad set budget sharing is off: each ad set spends only its own budget, and Meta does not move budget between this campaign’s ad sets. Meta requires this choice from Graph API v24.0 when budgets are set on ad sets.',
    ),
  )}</p>`;
}
function readableReview(review, buttonLabel) {
  const request = review.request ?? {},
    needs = review.execute_requirements ?? {},
    sharing = reviewFields(request).find(f => f.path.endsWith('/is_adset_budget_sharing_enabled'));
  return `<section class="panel workspace-form review-panel"><div class="panel-header"><h2>${esc(uiText('Review this change'))}</h2>${badge('awaiting_review')}</div><p>${esc(uiText('Expires'))} ${date(review.expires_at)}${esc(uiText('. Approval applies to this frozen request only.'))}</p><p class="form-note" id="review-countdown" role="timer"></p><div id="review-expired" role="status" hidden><p class="notice">${esc(uiText('This review expired before it was executed. Nothing was sent. Prepare it again: the current state is read again and a new review is created.'))}</p><button id="prepare-again" class="button" type="button">${esc(uiText('Prepare again'))}</button></div>${review.unchanged_since_review ? `<p class="form-note">${esc(uiText('Nothing changed since the expired review: the request and the state it read are the same.'))}</p>` : ''}${reviewSummaryLine(review.summary)}${effectBadges(review.effects ?? needs.effects, needs.reasons)}${reviewTable(request, uiText('Request to submit — exact native fields'), {native: path => !path.startsWith('/warnings')})}${sharing ? budgetSharingNote(sharing.value) : ''}${review.creative_impact ? reviewTable(review.creative_impact, uiText('Creative impact')) : ''}${review.spend_policy ? spendPolicyView(review.spend_policy) : ''}${review.before_state ? `<details><summary>${esc(uiText('Current state read from the provider'))}</summary>${reviewTable(review.before_state, uiText('Observed before preparation'), {native: true})}</details>` : ''}${needs.reasons ? reviewTable(needs.reasons, uiText('Why acknowledgement is required')) : ''}${reviewApprovalNotice(review.approval)}${recordDetails(review, uiText('Complete request, state, prerequisites and evidence'))}<fieldset class="review-consents"><legend>${esc(uiText('Authorize this request'))}</legend>${requiredReviewConsents(
    review,
  )
    .map(
      key =>
        `<label class="form-note"><input id="${reviewConsentIds[key]}" type="checkbox"> ${esc(uiText(reviewConsentLabels[key]))}</label>`,
    )
    .join(
      '',
    )}<p id="review-consent-error" class="error" role="alert" hidden></p></fieldset><button id="execute-reviewed" type="button" class="button primary">${esc(uiText(buttonLabel))}</button></section>`;
}
/**
 * A review's spending-policy effects (WEB-03, design review 2026-10). An account without a policy is said in the page's
 * words, with where the owner sets one; the server's advice names an MCP tool and the rest of its record only says
 * that. A configured policy keeps its exact table.
 */
function spendPolicyView(policy) {
  if (policy?.unprotected !== true) return reviewTable(policy, uiText('Spending-policy effects'));
  const owner = typeof session === 'object' && session?.workspaceRole === 'owner';
  return `<p class="notice warning" role="note">${esc(uiText('No spending policy protects this account. The workspace owner can set one for this account, or a default for every account, in Workspace settings.'))}${owner ? ` <a href="/settings#owner-spend-policy">${esc(uiText('Open spending policies'))}</a>` : ''}</p>`;
}
const campaignNativeValue = value => `<bdi dir="ltr">${esc(value ?? uiText('Unknown'))}</bdi>`;
const campaignProviderNames = {
  google_ads_native_action: 'Google Ads',
  snapchat_native_action: 'Snapchat',
  meta_native_action: 'Meta',
};
const allocationReviewLabels = {
  provider: 'Provider',
  account: 'Account',
  currency: 'Currency',
  timezone: 'Timezone',
  period: 'Reference period',
  parent: 'Parent campaign',
  campaign: 'Campaign',
  squad: 'Ad squad',
  currentDaily: 'Daily budget at preview',
  currentAverage: 'Average daily budget at preview',
  proposedDaily: 'Proposed daily budget',
  proposedAverage: 'Proposed average daily budget',
  micros: 'Native budget in micros',
  periodBudget: 'Reference-period allocation',
  // DEC-02: Meta budgets sit on the campaign or on its one spending ad set, in whole Meta minor units.
  owner: 'Budget owner',
  minorUnits: 'Native budget in Meta minor units',
};
function allocationAmountMatches(amount, micros) {
  if (typeof amount !== 'string' || !/^\d+(?:\.\d{1,6})?$/.test(amount)) return false;
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0')) === BigInt(micros);
}
function allocationReviewContext(run) {
  const a = run.allocation;
  if (
    !a ||
    !['google_ads_native_action', 'linkedin_native_action', 'snapchat_native_action', 'meta_native_action'].includes(
      a.gateway,
    )
  )
    return null;
  const snap = a.gateway === 'snapchat_native_action',
    linkedin = a.gateway === 'linkedin_native_action',
    meta = a.gateway === 'meta_native_action';
  if (
    typeof a.account_id !== 'string' ||
    !a.account_id ||
    typeof a.report_id !== 'string' ||
    !a.report_id ||
    typeof a.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(a.currency) ||
    typeof a.timezone !== 'string' ||
    !a.timezone ||
    !Number.isInteger(a.period_days) ||
    a.period_days <= 0 ||
    (snap && (typeof a.parent_campaign_id !== 'string' || !a.parent_campaign_id)) ||
    (linkedin && (a.timezone !== 'UTC' || !/^20\d{2}(?:0[1-9]|1[0-2])$/.test(a.api_version))) ||
    !Array.isArray(a.targets) ||
    !a.targets.length ||
    a.targets.some(
      t =>
        !t ||
        typeof t !== 'object' ||
        typeof (snap ? t.entity_id : t.campaign_id) !== 'string' ||
        !(snap ? t.entity_id : t.campaign_id) ||
        typeof t.daily_budget_micros !== 'string' ||
        !/^\d+$/.test(t.daily_budget_micros) ||
        !allocationAmountMatches(t.daily_budget, t.daily_budget_micros) ||
        (linkedin &&
          (!/^[1-9][0-9]{0,19}$/.test(t.campaign_id) || t.entity_id !== 'urn:li:sponsoredCampaign:' + t.campaign_id)) ||
        (meta &&
          (!/^[1-9][0-9]{0,31}$/.test(t.campaign_id) ||
            t.entity_id !== t.campaign_id ||
            !['campaign', 'ad_set'].includes(t.budget_owner) ||
            (t.budget_owner === 'ad_set' && !/^[1-9][0-9]{0,31}$/.test(t.adset_id ?? '')) ||
            typeof t.daily_budget_native !== 'string' ||
            !/^[1-9][0-9]*$/.test(t.daily_budget_native))),
    )
  )
    return null;
  return {allocation: a, snap, linkedin, meta};
}
function allocationProposalView(context) {
  if (!context) return '';
  const {allocation: a, snap, linkedin, meta} = context;
  const caption = uiText(snap ? 'Retained ad-squad budgets' : 'Retained campaign budgets');
  const fields = [
    [allocationReviewLabels.provider, campaignNativeValue(campaignProviderNames[a.gateway])],
    [allocationReviewLabels.account, campaignNativeValue(a.account_id)],
    [allocationReviewLabels.currency, campaignNativeValue(a.currency)],
    [allocationReviewLabels.timezone, campaignNativeValue(a.timezone)],
    [allocationReviewLabels.period, esc(uiText('Days: {count}', {count: uiNumber(a.period_days)}))],
    ...(snap ? [[allocationReviewLabels.parent, campaignNativeValue(a.parent_campaign_id)]] : []),
  ];
  const daily = snap || linkedin || meta;
  const headers = [
    snap ? allocationReviewLabels.squad : allocationReviewLabels.campaign,
    ...(meta ? [allocationReviewLabels.owner] : []),
    daily ? allocationReviewLabels.currentDaily : allocationReviewLabels.currentAverage,
    daily ? allocationReviewLabels.proposedDaily : allocationReviewLabels.proposedAverage,
    ...(linkedin ? [] : [meta ? allocationReviewLabels.minorUnits : allocationReviewLabels.micros]),
    allocationReviewLabels.periodBudget,
  ];
  return `<section class="allocation-proposal" aria-label="${esc(uiText('Retained budget proposal'))}"><h3>${esc(uiText('Retained budget proposal'))}</h3><p class="form-note">${esc(uiText('These are the saved preview amounts. Current provider settings must be checked again before review and execution.'))}</p><dl>${fields.map(([label, value]) => `<div><dt>${esc(uiText(label))}</dt><dd>${value}</dd></div>`).join('')}</dl><div class="data-scroll" role="region" aria-label="${esc(caption)}" tabindex="0"><table class="review-table"><caption>${esc(caption)}</caption><thead><tr>${headers.map(label => `<th scope="col">${esc(uiText(label))}</th>`).join('')}</tr></thead><tbody>${a.targets
    .map(t => {
      const id = snap || linkedin ? t.entity_id : t.campaign_id;
      const name =
        t.name && t.name !== id
          ? `<bdi dir="auto">${esc(t.name)}</bdi><small>${campaignNativeValue(id)}</small>`
          : campaignNativeValue(id);
      const owner = meta
        ? `<td>${t.budget_owner === 'ad_set' ? `${esc(uiText('Ad set'))} ${campaignNativeValue(t.adset_id)}` : esc(uiText('Campaign budget'))}</td>`
        : '';
      return `<tr><th scope="row">${name}</th>${owner}<td>${campaignNativeValue(t.current_daily_budget)} ${campaignNativeValue(a.currency)}</td><td>${campaignNativeValue(t.daily_budget)} ${campaignNativeValue(a.currency)}</td>${linkedin ? '' : `<td>${campaignNativeValue(meta ? t.daily_budget_native : t.daily_budget_micros)}</td>`}<td>${campaignNativeValue(t.period_budget)} ${campaignNativeValue(a.currency)}</td></tr>`;
    })
    .join(
      '',
    )}</tbody></table></div><p class="form-note">${esc(uiText(linkedin ? 'LinkedIn native budgets are decimal amounts in account currency. Daily settings can spend up to 150% on a day with strong auction opportunities. Existing group caps are preserved; this proposal sets no end date or automatic period cap.' : meta ? 'Each Meta daily budget is set on its current owner in whole Meta minor units. Meta can spend up to 75% more than a daily budget on a day with better opportunities, and at most seven times it over a calendar week. This proposal sets no end date or automatic period cap.' : snap ? 'Daily budgets remain in effect until separately changed; this proposal sets no end date or period spending cap.' : 'Average daily budgets remain in effect until separately changed; this proposal sets no end date or period spending cap.'))} <a href="/reports?id=${encodeURIComponent(a.report_id)}">${esc(uiText('Inspect original report'))}</a></p></section>`;
}
function allocationStepDescription(step, context) {
  if (!context || step.kind !== 'write') return null;
  const {allocation: a, snap, linkedin, meta} = context,
    args = step.arguments;
  // A readable description is only a projection of this exact saved budget request. Additional or changed
  // native fields fall back to the original description; this helper never validates or authorizes execution.
  const keysAre = (value, keys) =>
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key));
  if (
    step.gateway !== a.gateway ||
    step.account_id !== a.account_id ||
    (a.connection_id !== undefined && step.connection_id !== a.connection_id) ||
    (step.expected_currency !== undefined && step.expected_currency !== a.currency) ||
    !keysAre(
      args,
      linkedin
        ? ['action', 'api_version', 'restli_method', 'path_params', 'payload']
        : ['action', 'path_params', 'payload'].filter(key => snap || meta || key !== 'path_params'),
    )
  )
    return null;
  const target = a.targets.find(t => {
    if (meta) {
      // DEC-02: the budget owner's own reviewed update, with the exact Meta minor-unit amount.
      const p = args.payload,
        path = args.path_params,
        adSet = t.budget_owner === 'ad_set';
      return (
        args.action === (adSet ? 'meta_ad_set_id_update' : 'meta_campaign_id_update') &&
        keysAre(path, [adSet ? 'ad_set_id' : 'campaign_id']) &&
        (adSet ? path.ad_set_id === t.adset_id : path.campaign_id === t.campaign_id) &&
        keysAre(p, ['daily_budget']) &&
        p.daily_budget === t.daily_budget_native
      );
    }
    if (linkedin) {
      const p = args.payload,
        path = args.path_params,
        money = p?.patch?.$set?.dailyBudget;
      return (
        args.action === 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_campaign_id_post' &&
        args.api_version === a.api_version &&
        args.restli_method === 'PARTIAL_UPDATE' &&
        keysAre(path, ['ad_account_id', 'campaign_id']) &&
        path.ad_account_id === a.account_id &&
        path.campaign_id === t.campaign_id &&
        keysAre(p, ['patch']) &&
        keysAre(p.patch, ['$set']) &&
        keysAre(p.patch.$set, ['dailyBudget']) &&
        keysAre(money, ['amount', 'currencyCode']) &&
        money.amount === t.daily_budget &&
        money.currencyCode === a.currency
      );
    }
    if (snap) {
      const p = args.payload,
        path = args.path_params;
      return (
        args.action === 'snapchat_adsquad_update' &&
        keysAre(path, ['campaign_id', 'ad_squad_id']) &&
        path.campaign_id === a.parent_campaign_id &&
        path.ad_squad_id === t.entity_id &&
        Array.isArray(p) &&
        p.length === 1 &&
        keysAre(p[0], ['op', 'path', 'value']) &&
        p[0].op === 'replace' &&
        p[0].path === '/daily_budget_micro' &&
        String(p[0].value) === t.daily_budget_micros
      );
    }
    const p = args.payload,
      operations = p?.operations,
      op = operations?.[0];
    return (
      args.action === 'google_ads_v23_campaign_budget_mutate_campaign_budgets' &&
      keysAre(p, ['operations', 'partial_failure']) &&
      p.partial_failure === false &&
      Array.isArray(operations) &&
      operations.length === 1 &&
      keysAre(op, ['update', 'update_mask']) &&
      op.update_mask === 'amount_micros' &&
      keysAre(op.update, ['resource_name', 'amount_micros']) &&
      typeof t.budget_resource === 'string' &&
      op.update.resource_name === t.budget_resource &&
      op.update.amount_micros === t.daily_budget_micros
    );
  });
  if (!target) return null;
  return `${esc(uiText(snap ? 'Ad squad' : 'Campaign'))} ${campaignNativeValue(snap || linkedin ? target.entity_id : target.campaign_id)}${meta && target.budget_owner === 'ad_set' ? ` · ${esc(uiText('Ad set'))} ${campaignNativeValue(target.adset_id)}` : ''}: ${esc(uiText(snap || linkedin || meta ? 'Proposed daily budget' : 'Proposed average daily budget'))} ${campaignNativeValue(target.daily_budget)} ${campaignNativeValue(a.currency)}`;
}
function consentReviewContext(run) {
  const c = run.gtm_consent,
    s = c?.scope,
    id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value),
    types = values =>
      Array.isArray(values) &&
      values.length <= 20 &&
      new Set(values).size === values.length &&
      values.every(value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(value));
  if (
    c?.workflow !== 'gtm-consent-add-v1' ||
    s?.gateway !== 'gtm_native_action' ||
    !['account_id', 'connection_id', 'container_id', 'workspace_id'].every(key => id(s[key])) ||
    s.workspace_path !== `accounts/${s.account_id}/containers/${s.container_id}/workspaces/${s.workspace_id}` ||
    !Array.isArray(s.tag_ids) ||
    !s.tag_ids.length ||
    s.tag_ids.length > 10 ||
    new Set(s.tag_ids).size !== s.tag_ids.length ||
    !types(s.required_types) ||
    !s.required_types.length ||
    (s.custom_types !== undefined &&
      (!types(s.custom_types) ||
        !s.custom_types.length ||
        s.custom_types_acknowledged !== true ||
        !s.custom_types.every(v => s.required_types.includes(v)))) ||
    !Array.isArray(c.targets) ||
    c.targets.length !== s.tag_ids.length ||
    c.targets.some(
      (t, i) =>
        !t ||
        !id(t.tag_id) ||
        t.tag_id !== s.tag_ids[i] ||
        t.path !== s.workspace_path + '/tags/' + t.tag_id ||
        !['notSet', 'notNeeded', 'needed'].includes(t.before_setting) ||
        !['change', 'unchanged'].includes(t.state) ||
        !types(t.before_required_types) ||
        !types(t.proposed_required_types) ||
        !t.proposed_required_types.length ||
        !t.before_required_types.every(v => t.proposed_required_types.includes(v)) ||
        !s.required_types.every(v => t.proposed_required_types.includes(v)),
    )
  )
    return null;
  return c;
}
function consentProposalView(c) {
  const setting = value => {
    switch (value) {
      case 'needed':
        return uiText('Additional consent required');
      case 'notNeeded':
        return uiText('No additional consent required');
      default:
        return uiText('Additional consent not set');
    }
  };
  return `<section><h3>${esc(uiText('Saved consent additions'))}</h3><p class="notice">${esc(uiText('These explicit additional-consent requirements apply to workspace tags. Native review and read-back remain required. Publishing is separate; runtime consent and event delivery remain unverified.'))}</p>${c.scope.custom_types?.length ? `<p class="notice warning"><strong>${esc(uiText('Non-standard consent type'))}</strong>: <code dir="ltr">${esc(c.scope.custom_types.join(', '))}</code>. ${esc(uiText('A tag that requires a type your consent platform never grants will not fire after publishing.'))}</p>` : ''}<p><code dir="ltr">${esc(c.scope.workspace_path)}</code></p><div class="data-scroll" role="region" aria-label="${esc(uiText('Consent additions'))}" tabindex="0"><table class="review-table"><caption>${esc(uiText('Consent additions'))}</caption><thead><tr><th scope="col">${esc(uiText('Tag'))}</th><th scope="col">${esc(uiText('Original consent setting'))}</th><th scope="col">${esc(uiText('Original required types'))}</th><th scope="col">${esc(uiText('Proposed required types'))}</th><th scope="col">${esc(uiText('Draft change'))}</th></tr></thead><tbody>${c.targets.map(t => `<tr><th scope="row"><bdi dir="auto">${esc(t.name ?? t.tag_id)}</bdi><br><code dir="ltr">${esc(t.tag_id)}</code></th><td>${esc(setting(t.before_setting))}</td><td><code dir="ltr">${esc(t.before_required_types.join(', ') || '—')}</code></td><td><code dir="ltr">${esc(t.proposed_required_types.join(', '))}</code></td><td>${esc(uiText(t.state === 'change' ? 'Add required types' : 'Already required; no step'))}</td></tr>`).join('')}</tbody></table></div></section>`;
}
function consentStepDescription(step, context) {
  if (
    !context ||
    step.kind !== 'write' ||
    step.gateway !== 'gtm_native_action' ||
    step.account_id !== context.scope.account_id ||
    step.connection_id !== context.scope.connection_id
  )
    return null;
  const t = context.targets.filter(t => t.state === 'change')[
      Number(step.id?.match(/^consent-([1-9][0-9]*)$/)?.[1]) - 1
    ],
    a = step.arguments?.arguments,
    // MSR-01: non-standard types this step adds were acknowledged in the preview and stay labelled in review.
    custom = t ? (context.scope.custom_types ?? []).filter(v => !t.before_required_types.includes(v)) : [];
  if (
    !t ||
    step.arguments.operation !== 'gtm_ops' ||
    a?.action !== 'UPDATE_TAG' ||
    a.path !== t.path ||
    a.fingerprint !== t.native_fingerprint ||
    a.account_id !== context.scope.account_id ||
    a.connection_id !== context.scope.connection_id ||
    a.payload?.name !== t.name ||
    a.payload.type !== t.type ||
    a.payload.consentSettings?.consentStatus !== 'needed' ||
    JSON.stringify(
      a.payload.consentSettings.consentType?.list?.map(item => (item.type === 'template' ? item.value : null)),
    ) !== JSON.stringify(t.proposed_required_types) ||
    step.description !==
      'Tag ' +
        t.tag_id +
        ': require additional consent ' +
        t.proposed_required_types.join(', ') +
        (custom.length ? '. Non-standard types acknowledged: ' + custom.join(', ') : '')
  )
    return null;
  return `${esc(uiText('Tag'))} ${campaignNativeValue(t.tag_id)}: ${esc(uiText('Proposed required types'))} <code dir="ltr">${esc(t.proposed_required_types.join(', '))}</code>${custom.length ? ` · <strong>${esc(uiText('Non-standard consent type'))}</strong> <code dir="ltr">${esc(custom.join(', '))}</code>` : ''}`;
}
/**
 * A media step whose file expired, changed or is deleted too soon, whether its prepare failed or preflight blocked it:
 * a new file answers it (MED-03 B).
 */
const campaignReplaceable = (step, run) => {
  const code =
    step.status === 'failed'
      ? step.error?.code
      : step.status === 'pending'
        ? run?.preflight?.checks?.find(c => c.step === step.id && c.status === 'blocked')?.error?.code
        : undefined;
  return (
    step.kind === 'media' &&
    typeof step.arguments?.source_id === 'string' &&
    ['MEDIA_SOURCE_NOT_FOUND', 'UPLOAD_DEADLINE_TOO_CLOSE', 'MEDIA_CHANGED', 'TEMPORARY_SOURCES_EXPIRING'].includes(
      code,
    )
  );
};
/**
 * What to do about a step's error, as the website words it (WEB-03): a remedy written for an MCP client is never shown.
 * Without the shell's presentation layer (an isolated page script), nothing is added.
 */
function campaignStepRemedy(error) {
  const remedy = typeof websiteRemedy === 'function' ? websiteRemedy(error) : '';
  return remedy ? `<p class="form-note">${esc(remedy)}</p>` : '';
}
/** What a plan's server run is doing (amcp_campaign run_background, MED-03 B). */
function campaignBackgroundLabel(background) {
  switch (background.state) {
    case 'queued':
      return uiText('Queued on the AMCP server');
    case 'running':
      return uiText('Running on the AMCP server: you can leave this page');
    case 'complete':
      return uiText('The server run finished');
    default:
      return uiText('The server run stopped. Run the plan again to continue it.');
  }
}
function campaignJournal(run) {
  const context = allocationReviewContext(run),
    consent = consentReviewContext(run);
  const originalBrief = `<p><bdi dir="auto">${esc(run.brief)}</bdi></p>`;
  const recipeBrief = ['snapchat_website_traffic', 'snapchat_lead_generation'].includes(run.recipe?.id)
    ? `<p class="notice">${esc(uiText('This saved Snapchat workflow uses an existing creative. Inspect the native steps and original brief; each change requires review and activation is separate.'))}</p><details><summary>${esc(uiText('Original plan brief'))}</summary>${originalBrief}</details>`
    : originalBrief;
  // A plan that uses temporary files shows when they are deleted (owner decision D23).
  const temporary = run.temporary_sources
    ? `<p class="notice">${esc(
        run.temporary_sources.earliest_expires_at && Date.parse(run.temporary_sources.earliest_expires_at) > Date.now()
          ? uiText(
              'This plan uses temporary files, deleted from {time}. Run it before then; afterwards upload the files again and save a new plan.',
              {time: uiDate(run.temporary_sources.earliest_expires_at)},
            )
          : uiText('This plan uses temporary files that were deleted. Upload the files again and save a new plan.'),
      )}</p>`
    : '';
  // A plan continued in a new linked plan points forward; the new plan points back (CMP-04).
  const linked =
    (run.superseded_by?.id
      ? `<p class="notice">${esc(uiText('This plan continues in a new linked plan.'))} <a href="/campaigns?id=${encodeURIComponent(run.superseded_by.id)}">${esc(uiText('Open the new plan'))}</a></p>`
      : '') +
    (run.supersedes?.id
      ? `<p class="form-note">${esc(uiText('This plan continues an earlier plan. Steps it adopted keep their original receipts there.'))} <a href="/campaigns?id=${encodeURIComponent(run.supersedes.id)}">${esc(uiText('Open the earlier plan'))}</a></p>`
      : '') +
    // A launch and the separate plan that activates it point to each other (CMP-03).
    (run.activation_of?.id
      ? `<p class="notice">${esc(uiText('This plan activates a completed launch. Each status change is reviewed, approved and read back on its own.'))} <a href="/campaigns?id=${encodeURIComponent(run.activation_of.id)}">${esc(uiText('Open the launch plan'))}</a></p>`
      : '') +
    (run.activation_plan?.id
      ? `<p class="form-note">${esc(uiText('An activation plan was prepared for this launch.'))} <a href="/campaigns?id=${encodeURIComponent(run.activation_plan.id)}">${esc(uiText('Open the activation plan'))}</a></p>`
      : '') +
    // Archived plans and shared plans say so (CMP-05).
    (run.archived
      ? `<p class="notice">${esc(uiText('This plan is archived. It does not count toward the plan limit; unarchive it to work on it again.'))}</p>`
      : '') +
    (run.collaborators?.length
      ? `<p class="form-note">${esc(uiText('Shared with {count} colleagues.', {count: uiNumber(run.collaborators.length)}))}</p>`
      : '') +
    // A catalog plan saved as one part of a plan group says which part it is (COM-03).
    (['part', 'parts', 'group_products'].every(k => Number.isSafeInteger(run.catalog_lineage?.lineage_group?.[k]))
      ? `<p class="notice">${esc(uiText('This plan is part {part} of {parts} of one product import of {count} products. Approve and run each part separately.', {part: uiNumber(run.catalog_lineage.lineage_group.part), parts: uiNumber(run.catalog_lineage.lineage_group.parts), count: uiNumber(run.catalog_lineage.lineage_group.group_products)}))}</p>`
      : '');
  // When the plan must have run, and its server run (MED-03 B).
  const runBy =
      run.temporary_sources?.earliest_expires_at && Date.parse(run.temporary_sources.earliest_expires_at) > Date.now()
        ? `<span>${esc(uiText('Runnable until {time}', {time: uiDate(run.temporary_sources.earliest_expires_at, {hour: '2-digit', minute: '2-digit'})}))}</span>`
        : '',
    server = run.background?.state ? `<span>${esc(campaignBackgroundLabel(run.background))}</span>` : '';
  return `<h2 tabindex="-1"><bdi dir="auto">${esc(consent && run.name === 'Tag consent draft' ? uiText('Tag consent draft') : run.name)}</bdi></h2><div class="work-summary">${badge(run.state)}<span>${esc(uiText('Revision'))} ${campaignNativeValue(run.revision)}</span>${runBy}${server}<a href="/campaigns?id=${encodeURIComponent(run.id)}">${esc(uiText('Link to this plan'))}</a></div>${temporary}${linked}${context ? allocationProposalView(context) + `<details><summary>${esc(uiText('Original plan brief'))}</summary>${originalBrief}</details>` : consent ? consentProposalView(consent) + `<details><summary>${esc(uiText('Original plan brief'))}</summary>${originalBrief}</details>` : recipeBrief}<ol class="campaign-steps">${run.steps
    .map(s => {
      const description = allocationStepDescription(s, context) ?? consentStepDescription(s, consent);
      return `<li><div><strong>${description ?? `<bdi dir="auto">${esc(s.description ?? s.id)}</bdi>`}</strong><small>${campaignNativeValue(campaignProviderNames[s.gateway] ?? s.gateway ?? s.arguments?.platform)} · ${campaignNativeValue(s.account_id)}</small><small>${esc(uiText('Depends on:'))} ${esc(s.depends_on?.join(', ') || uiText('No predecessor'))}</small>${description ? `<details><summary>${esc(uiText('Original step description'))}</summary><p><bdi dir="auto">${esc(s.description ?? s.id)}</bdi></p></details>` : ''}</div>${badge(s.status)}${s.error ? `<p class="error">${esc((typeof websiteOwnMessage === 'function' && websiteOwnMessage(s.error)) || uiOwnedError(s.error).message)}</p>${campaignStepRemedy(s.error)}${recordDetails(s.error, uiText('Error and remedy'))}` : ''}${s.verification ? `${verificationComparison(s.verification)}${recordDetails(s.verification, uiText('Read-back evidence'))}` : ''}${s.review_id ? `<small>${esc(uiText('Original review:'))} <code dir="ltr">${esc(s.review_id)}</code></small>` : ''}${campaignReplaceable(s, run) ? `<button class="button small" type="button" data-replace-source="${esc(s.id)}">${esc(uiText('Replace the file'))}</button>` : ''}</li>`;
    })
    .join(
      '',
    )}</ol>${run.clone ? reviewTable(run.clone.not_copied ?? [], uiText('Source fields not copied')) : ''}${run.allocation && !context ? `<p class="notice">${esc(uiText('This budget plan came from a retained allocation.'))} <a href="/reports?id=${encodeURIComponent(run.allocation.report_id)}">${esc(uiText('Inspect original report'))}</a>${esc(uiText('. Daily budgets remain in effect until separately changed; the reference period sets no end date.'))}</p>` : ''}${run.allocation ? '<section id="allocation-outcome" class="allocation-outcome" aria-live="polite"></section>' : ''}${recordDetails({allocation: run.allocation, gtm_consent: run.gtm_consent, catalog_lineage: run.catalog_lineage, plan_hash: run.plan_hash, profile_id: run.profile_id, profile_revision: run.profile_revision, recipe: run.recipe, clone: run.clone, execution_journal: run.execution_journal}, uiText('Plan provenance and execution journal'))}`;
}
function verificationComparison(verification) {
  const checks = (verification.checks ?? []).flatMap(check =>
    check.diff?.length ? check.diff.map(diff => ({...diff, status: check.status})) : [check],
  );
  return checks.length
    ? `<div class="data-scroll" role="region" aria-label="${esc(uiText('Read-back comparison'))}" tabindex="0"><table class="review-table"><caption>${esc(uiText('Read-back comparison'))}</caption><thead><tr><th>${esc(uiText('Check'))}</th><th>${esc(uiText('Expected'))}</th><th>${esc(uiText('Observed'))}</th><th>${esc(uiText('Result'))}</th></tr></thead><tbody>${checks.map(c => `<tr><th scope="row">${esc(c.field ?? c.name ?? c.path ?? c.id ?? (c.changed_fields ?? []).join(', '))}</th><td>${esc(JSON.stringify(c.expected ?? c.expected_value ?? null))}</td><td>${esc(JSON.stringify(c.actual ?? c.actual_value ?? c.observed ?? null))}</td><td>${badge(c.status ?? (c.matches === true ? 'verified' : 'unknown'))}</td></tr>`).join('')}</tbody></table></div>`
    : '';
}
// WEB-03: what a plan run's stop means for a person, and the one control that continues it. Every run.stopped value of
// src/campaign-runner.ts has an entry (tests/website-presentation.test.mjs fails when one is added without it). The
// server's reason is written for MCP clients ("execute_next with it continues the step"); it stays under "Result,
// receipts and next safe action". No control acts without a click, and a review's consents start unchecked.
const runStopLabels = {
  complete: 'Every step of this plan is done.',
  time: 'The run paused to stay responsive. Continue to run the remaining steps.',
  limit: 'The run paused to stay responsive. Continue to run the remaining steps.',
  not_sent:
    'The next step was not sent: a pause, a provider limit or a busy upload held it. Its review stays ready; continue in a moment.',
  waiting:
    'The next step waits for an earlier step to settle (a read-back or an upload still processing). Read it back, or continue in a moment.',
  needs_attention: 'A step needs your attention, so the run stopped. Steps already done stay as they are.',
  needs_spend_change_confirmed:
    'This step changes budget, bid or serving beyond what the plan approval covers. Check its review here and authorize it to continue.',
  needs_cap_override_confirmed:
    'This step goes beyond a spending cap. Check its review here and authorize the override to continue.',
  needs_creative_edit_confirmed:
    'This step edits a creative that existing ads use. Check its review here and authorize the edit to continue.',
  // WRT-09's opt-in settings: a person's decision that a plan approval never gives. Nothing was sent, and the step's
  // review stays ready until it expires (src/campaign-runner.ts personDecisions).
  needs_destructive_confirmed:
    'This step deletes something at the provider, and the workspace owner asks for an explicit acknowledgement first. Check its review here and authorize the deletion to continue.',
  needs_website_approval:
    'This step needs a person’s approval on the AMCP website before it runs. Nothing was sent, and its review stays ready. Open its approval page, then continue the run once the step is approved.',
  needs_owner_approval:
    'Only the workspace owner runs a change beyond a spending cap. Nothing was sent, and the step’s review stays ready. The owner continues the run, or approves the step on its approval page first.',
  // R25 M1 (L5-04): the provider changed after the step's review was prepared. Nothing was claimed or sent, and the step went
  // back to pending; a plan approval is of the plan, not of a state that moved, so the run stops instead of preparing the
  // step again on its own, and the outcome offers no Continue: the person reviews the step again on its current state.
  state_changed:
    'The provider changed after this step was prepared, so nothing was sent. Review the step again to see its current state. Nothing skips this check.',
  // A plan its preflight blocked returns the blocked view, not a run (src/campaign-background.ts).
  blocked: 'A prerequisite blocks this plan. Correct the blocked step, then run the plan again.',
};
/** execute_next's answer for a step its review's state check refused: pending again, nothing sent (src/campaign-runner.ts). */
const campaignStateChanged = out => out?.current?.status === 'pending' && out.current.error?.code === 'STATE_CHANGED';
// A stopped step's way forward, by the call the server names for it (src/campaign-runner.ts stopped()).
const runRecoveryLabels = {
  recover_step:
    'Correct the blocked step. It is reviewed again under a new key, and steps already verified are never sent again.',
  confirm_absent:
    'The provider refused this step after it was sent, and AMCP cannot prove nothing was created. Check the provider before you correct it.',
  reconcile_step:
    'This step reached the provider and its result is not confirmed, so AMCP never sends it again. Read it back from its receipt.',
  accept_observed:
    'The provider holds different values than this step sent. Compare them: accept them if they are right, or correct the step with a new reviewed change.',
  reconcile:
    'This step reached the provider without a completed receipt, so AMCP never sends it again. Reconcile it in Operations with read-only provider checks.',
  unconfirmed:
    'This step reached the provider and its result is not confirmed, so AMCP never sends it again. Check at the provider whether it exists; anything still to be written needs a new plan.',
};
// What became of the step a call executed, when it did not complete; its own message and remedy stand with the step.
const executedStepOutcomes = {
  uncertain:
    'The provider’s answer to this step was lost, so AMCP cannot confirm the change. It is never sent again: use Read back submitted step to check the account.',
  failed: 'This step did not complete. What happened and what to do are shown with the step.',
};
/**
 * The plan's one emphasized action once a step went wrong (design review 2026-10): a read-back for a step whose result
 * is not confirmed, otherwise the correction of a failed or blocked step, otherwise (R25 M1, L5-04) the review of a step
 * whose review the state check refused, which is pending again and not broken; '' when none applies.
 */
function campaignNextSafeAction(run) {
  if (run?.steps?.some(s => s.status === 'uncertain' && s.review_id)) return 'reconcile';
  if (run?.steps && campaignNeedsAmendment(run)) return 'amend';
  return run?.steps?.some(s => s.status === 'pending' && s.error?.code === 'STATE_CHANGED') ? 'review' : '';
}
function runRecoveryKind(out) {
  const call = out?.next_call,
    action = call?.arguments?.action;
  if (call?.add_after_user_approval?.accept_observed === true) return 'accept_observed';
  if (call?.tool === 'amcp_write' && action === 'reconcile') return 'reconcile';
  if (['recover_step', 'confirm_absent', 'reconcile_step'].includes(action)) return action;
  return typeof out?.recovery === 'string' || typeof out?.decision === 'string' ? 'unconfirmed' : null;
}
/** The submitted step a read-back can settle, from the plan as the page last read it. */
const campaignReadBackStep = run =>
  run?.steps?.find(s => s.review_id && ['verifying', 'processing', 'executing'].includes(s.status));
/**
 * A response's outcome for a person: what happened, what to do, and the control for it. `run` is the plan as the
 * page shows it. Controls are bound by bindCampaignWorkflow; each calls what the person could already call.
 */
function runOutcomeView(out, run) {
  const stopped = typeof out?.run?.stopped === 'string' ? out.run.stopped : out?.blocked === true ? 'blocked' : '',
    recovery = runRecoveryKind(out),
    executed = Array.isArray(out?.run?.executed) ? out.run.executed.length : 0,
    lines = [],
    controls = [];
  const button = (id, label, primary = false) =>
    `<button id="${id}" type="button" class="button${primary ? ' primary' : ''}">${esc(label)}</button>`;
  if (stopped) {
    lines.push(
      uiText(
        Object.hasOwn(runStopLabels, stopped)
          ? runStopLabels[stopped]
          : 'The run stopped. Continue to run the remaining steps.',
      ),
    );
    if (out.run && stopped !== 'complete' && executed > 0)
      lines.push(
        uiText(executed === 1 ? '{count} step ran before it stopped.' : '{count} steps ran before it stopped.', {
          count: uiNumber(executed),
        }),
      );
    if (stopped === 'not_sent' && Number.isFinite(out.run?.retry_after_ms))
      lines.push(
        uiText('Try again in about {seconds} seconds.', {
          seconds: uiNumber(Math.max(1, Math.ceil(out.run.retry_after_ms / 1000))),
        }),
      );
  } else if (out?.preflight?.status === 'ready' && out.blocked === false)
    lines.push(uiText('Prerequisites checked: nothing blocks this plan.'));
  else if (out?.background?.state) lines.push(campaignBackgroundLabel(out.background));
  else if (out?.approved) lines.push(uiText('Plan approved. Run it when you are ready; the approval lasts 24 hours.'));
  // A step its review's state check refused, sent back to pending unsent (R25 M1, L5-04): never announced as saved.
  else if (!recovery && campaignStateChanged(out)) lines.push(uiText(runStopLabels.state_changed));
  // The step a call executed and that did not complete (design review 2026-10): it was announced as "Saved.".
  else if (!recovery && Object.hasOwn(executedStepOutcomes, out?.current?.status ?? ''))
    lines.push(uiText(executedStepOutcomes[out.current.status]));
  else if (!recovery)
    lines.push(
      uiText(
        out?.state === 'complete'
          ? runStopLabels.complete
          : out?.next_call?.arguments?.action === 'prepare_next'
            ? 'Saved. Review the next step when you are ready.'
            : 'Saved.',
      ),
    );
  if (recovery) lines.push(uiText(runRecoveryLabels[recovery]));
  // The one control for this outcome.
  if (/^needs_(spend_change|cap_override|creative_edit|destructive)_confirmed$/.test(stopped) && !out.review)
    controls.push(button('outcome-review-step', uiText('Review the step'), true));
  // A step waiting for a person's website approval links its approval page, followed only when it is this site's own
  // (as reviewApprovalNotice does); without one, the step's review shows who approves it. Running again before the
  // approval would only stop here again.
  else if (stopped === 'needs_website_approval' || stopped === 'needs_owner_approval') {
    const path = typeof out.run?.website_path === 'string' ? out.run.website_path : '';
    controls.push(
      /^\/(?![/\\])/.test(path)
        ? `<a class="button primary" href="${esc(path)}">${esc(uiText('Open the approval page'))}</a>`
        : button('outcome-review-step', uiText('Review the step'), true),
    );
  } else if (stopped === 'state_changed' || (!stopped && !recovery && campaignStateChanged(out)))
    controls.push(button('outcome-review-step', uiText('Review the step'), true));
  else if (recovery === 'recover_step') controls.push(button('outcome-amend', uiText('Correct blocked step'), true));
  else if (recovery === 'confirm_absent')
    controls.push(button('outcome-confirm-absent', uiText('Check the provider'), true));
  else if (recovery === 'reconcile_step') controls.push(button('outcome-read-back', uiText('Read back'), true));
  else if (recovery === 'accept_observed')
    controls.push(button('outcome-accept', uiText('Compare observed values'), true));
  else if (recovery === 'reconcile')
    controls.push(`<a class="button primary" href="/operations">${esc(uiText('Open Operations'))}</a>`);
  // An activation gate is checked again once the provider state it names has changed (CMP-03).
  else if (out?.next_call?.arguments?.action === 'preflight')
    controls.push(button('outcome-preflight', uiText('Check prerequisites again'), true));
  else if (stopped === 'waiting' && campaignReadBackStep(run))
    controls.push(button('outcome-read-back', uiText('Read back'), true));
  else if (
    ['time', 'limit', 'not_sent', 'waiting'].includes(stopped) ||
    (stopped && !Object.hasOwn(runStopLabels, stopped))
  )
    controls.push(button('outcome-continue', uiText('Continue the run'), true));
  else if (out?.approved && out?.next_call?.arguments?.action === 'run')
    controls.push(button('outcome-continue', uiText('Run the approved plan'), true));
  else if (!stopped && !recovery && out?.next_call?.arguments?.action === 'prepare_next')
    controls.push(button('outcome-review-step', uiText('Review next step')));
  return `<div class="notice run-outcome" role="status">${lines.map(line => `<p>${esc(line)}</p>`).join('')}${controls.length ? `<div class="dialog-actions">${controls.join('')}</div>` : ''}</div>`;
}
/** A response's outcome, the prerequisites that block it, and the exact response under its details. */
function campaignOutcome(out, run) {
  return `${blockedRequirementsView(out)}${runOutcomeView(out, run)}${recordDetails(out, uiText('Result, receipts and next safe action'))}`;
}
/** Now on the server's clock (serverNow in web/app.js), which assertApproval counts on; the device's without it. */
const campaignNow = () => (typeof serverNow === 'function' ? serverNow() : Date.now());
/** The campaign plan's approval is for this exact plan and less than a day old (src/campaign-runner.ts assertApproval). */
function campaignApprovalCurrent(run) {
  return !!run?.approval && run.approval.plan_hash === run.plan_hash && !(campaignNow() - run.approval.at > 86400000);
}
/** An approval of this exact plan that is older than a day: the plan is reviewed and approved again (WEB-03). */
function campaignApprovalExpired(run) {
  return !!run?.approval && run.approval.plan_hash === run.plan_hash && campaignNow() - run.approval.at > 86400000;
}
// A step with more money and status fields than the summary lists is aggregated by the server (WRT-05): one row per
// field pattern. Its complete list is one call away, and approval stays disabled until every such list was opened.
const approvalSpending = summary =>
  summary.steps.some(s => s.spend?.length || s.status?.length || s.aggregates?.length);
const effectLabels = {
  destructive: 'Deletes or removes',
  irreversible: 'Cannot be undone',
  publishes_live: 'Publishes live',
  stops_delivery: 'Stops delivery',
};
// The target an effect reason names, from the review's before-state: provider values stay literal (WRT-05).
function effectTarget(reasons) {
  const target = (Array.isArray(reasons) ? reasons : []).find(r => r?.effect && r.target)?.target;
  if (!target) return '';
  const label =
    target.name && target.id && target.name !== target.id
      ? target.name + ' (' + target.id + ')'
      : (target.id ?? target.name ?? '');
  return `<br>${esc(uiText('Target:'))} <bdi dir="auto">${esc(label)}</bdi>${target.status ? ` · ${esc(uiText('Current status:'))} <bdi dir="ltr">${esc(target.status)}</bdi>` : ''}`;
}
function effectBadges(effects, reasons) {
  const shown = Object.keys(effectLabels).filter(key => effects?.[key] === true);
  return shown.length
    ? `<p class="notice" role="note"><strong>${esc(uiText('Effects that need attention:'))}</strong> ${shown.map(key => esc(uiText(effectLabels[key]))).join(' · ')}${effectTarget(reasons)}</p>`
    : '';
}
function approvalAggregates(step) {
  const caption = uiText('{count} fields in this step, summarized by field', {count: uiNumber(step.fields_total)});
  return `<div class="data-scroll" role="region" aria-label="${esc(caption)}" tabindex="0"><table class="review-table"><caption>${esc(caption)}</caption><thead><tr><th scope="col">${esc(uiText('Field / native unit'))}</th><th scope="col">${esc(uiText('Count'))}</th><th scope="col">${esc(uiText('Distinct values'))}</th><th scope="col">${esc(uiText('Smallest'))}</th><th scope="col">${esc(uiText('Largest'))}</th></tr></thead><tbody>${step.aggregates.map(a => `<tr><th scope="row"><code dir="ltr">${esc(a.field)}</code></th><td>${esc(uiNumber(a.count))}</td><td dir="auto">${esc(a.values.map(reviewValue).join(', '))}${a.distinct_count > a.values.length ? esc(' ' + uiText('(+{count} more)', {count: uiNumber(a.distinct_count - a.values.length)})) : ''}</td><td dir="ltr">${a.min === undefined ? '' : esc(reviewValue(a.min))}</td><td dir="ltr">${a.max === undefined ? '' : esc(reviewValue(a.max))}</td></tr>`).join('')}</tbody></table></div><details class="approval-all-fields" data-approval-step="${esc(step.id)}"><summary>${esc(uiText('Show all {count} fields', {count: uiNumber(step.fields_total)}))}</summary><div class="approval-all-fields-body" aria-live="polite"></div></details>`;
}
function approvalFieldList(fields, caption) {
  return `<div class="data-scroll" role="region" aria-label="${esc(caption)}" tabindex="0"><table class="review-table"><caption>${esc(caption)}</caption><thead><tr><th scope="col">${esc(uiText('Field / native unit'))}</th><th scope="col">${esc(uiText('Value'))}</th></tr></thead><tbody>${fields.map(f => `<tr><th scope="row"><code dir="ltr">${esc(f.field)}</code></th><td dir="auto">${esc(reviewValue(f.value))}</td></tr>`).join('')}</tbody></table></div>`;
}
function approvalView(summary) {
  const spending = approvalSpending(summary),
    truncated = summary.steps.some(s => s.truncated);
  return `<section class="panel workspace-form"><h2>${esc(uiText('Approve this complete plan'))}</h2><p>${esc(summary.covers)}</p><ol class="campaign-steps">${summary.steps.map(s => `<li><strong>${esc(s.id)} · ${esc(s.action)}</strong><small>${esc(s.gateway)} ${esc(uiText('· Account'))} ${esc(s.account_id)}</small>${effectBadges(s.effects)}${s.truncated ? approvalAggregates(s) : reviewTable([...(s.spend ?? []), ...(s.status ?? []), ...(s.settings ?? [])], uiText('Budget, bid and status fields'))}${[...(s.spend ?? []), ...(s.settings ?? [])].map(f => (String(f.field).endsWith('/is_adset_budget_sharing_enabled') ? budgetSharingNote(f.value) : '')).join('')}${s.depends_on?.length ? `<small>${esc(uiText('Requires:'))} ${esc(s.depends_on.join(', '))}</small>` : ''}</li>`).join('')}</ol><p>${esc(uiText('Amounts retain their provider field names and units. Inspect all steps and account bindings before approval.'))}</p>${truncated ? `<p class="form-note" id="approval-fields-note">${esc(uiText('Open every “Show all fields” list before approving.'))}</p>` : ''}<label class="form-note"><input id="plan-consent" type="checkbox"> ${esc(uiText('I authorize every step in this exact plan.'))}</label>${spending ? `<label class="form-note"><input id="plan-spend-consent" type="checkbox"> ${esc(uiText('I authorize the budget, bid and serving changes shown above.'))}</label>` : ''}<button id="approve-plan" class="button primary" type="button"${truncated ? ' disabled aria-describedby="approval-fields-note"' : ''}>${esc(uiText('Save plan approval'))}</button>${recordDetails(summary, uiText('Exact plan hash and approval scope'))}</section>`;
}
// A plan offers "Correct blocked step" when a step failed before reaching the provider or preflight blocked one. The
// stored preflight keeps only its status; `blocked` is a field of the preflight response alone (CMP-02 a).
function campaignNeedsAmendment(run) {
  return run.steps.some(s => s.status === 'failed') || run.preflight?.status === 'blocked';
}
/** A completed recipe launch that can draft its separate activation plan (CMP-03). */
function campaignCanActivate(run) {
  return (
    run.state === 'complete' &&
    ['meta', 'google', 'snapchat', 'microsoft', 'tiktok'].includes(run.recipe?.platform) &&
    !run.activation_of &&
    !run.activation_plan &&
    !run.archived
  );
}
// Plan inventory and team handoff (CMP-05): archive, list filters kept in the URL, and sharing with colleagues.
const campaignPlanStates = [
  'draft',
  'awaiting_review',
  'in_progress',
  'attention',
  'complete',
  'cancelled',
  'superseded',
];
const campaignArchivableStates = ['complete', 'cancelled', 'superseded'];
const collaboratorRoleLabels = {
  viewer: 'Viewer: can read the plan',
  editor: 'Editor: can prepare, run steps and amend',
  approver: 'Approver: can approve and run',
};
const collaboratorAccessLabels = {
  admin: 'Workspace administrator',
  viewer: 'Shared with you to view',
  editor: 'Shared with you to edit',
  approver: 'Shared with you to approve',
};
/** Whether the signed-in person may share this plan: its owner, or a workspace owner or administrator. */
function campaignCanManage(run) {
  return (
    session.administrator === true ||
    ['owner', 'admin'].includes(session.workspaceRole) ||
    (run.principal || run.user_id) === session.id
  );
}
function campaignTeamActions(run) {
  return (
    (run.archived
      ? `<button id="unarchive-campaign" class="button">${esc(uiText('Unarchive plan'))}</button>`
      : campaignArchivableStates.includes(run.state)
        ? `<button id="archive-campaign" class="button">${esc(uiText('Archive plan'))}</button>`
        : '') +
    (campaignCanManage(run) ? `<button id="share-campaign" class="button">${esc(uiText('Share plan'))}</button>` : '')
  );
}
function campaignTeamView(out) {
  const team = out.collaborators ?? [],
    members = out.members ?? [];
  return `<section class="panel workspace-form" id="campaign-team"><h2>${esc(uiText('Share this plan'))}</h2><p>${esc(uiText('Colleagues see this plan only while its accounts are within their access. Every change they make is still reviewed and checked against their own account grant.'))}</p>${team.length ? `<ul>${team.map(c => `<li><bdi dir="auto">${esc(c.name ?? c.user_id)}</bdi> · ${esc(uiText(collaboratorRoleLabels[c.role] ?? c.role))} <button class="button small" type="button" data-unassign="${esc(c.user_id)}">${esc(uiText('Remove'))}</button></li>`).join('')}</ul>` : `<p class="form-note">${esc(uiText('Not shared with anyone yet.'))}</p>`}${
    members.length
      ? `<form id="assign-form"><label>${esc(uiText('Workspace member'))}<select name="user_id" required>${members.map(m => `<option value="${esc(m.user_id)}">${esc(m.name ?? m.user_id)}</option>`).join('')}</select></label><label>${esc(uiText('Role'))}<select name="role">${Object.entries(
          collaboratorRoleLabels,
        )
          .map(([value, label]) => `<option value="${value}">${esc(uiText(label))}</option>`)
          .join(
            '',
          )}</select></label><button class="button primary" type="submit">${esc(uiText('Share'))}</button></form>`
      : `<p class="form-note">${esc(uiText('No other workspace members to share with.'))}</p>`
  }</section>`;
}
/** The Campaigns list filters, kept in the URL so a filtered list reloads and can be shared. */
function campaignListFilters() {
  const q = new URLSearchParams(location.search),
    state = q.get('state'),
    search = (q.get('q') ?? '').trim().slice(0, 200);
  return {
    ...(campaignPlanStates.includes(state) ? {state} : {}),
    ...(search ? {search} : {}),
    ...(q.get('archived') === '1' ? {archived: true} : {}),
    ...(q.get('approval') === '1' ? {awaiting_approval: true} : {}),
  };
}
function campaignFilterForm(filters, total) {
  return `<form id="campaign-filters" class="workspace-form" role="search"><label>${esc(uiText('State'))}<select name="state"><option value="">${esc(uiText('All states'))}</option>${campaignPlanStates.map(s => `<option value="${s}"${filters.state === s ? ' selected' : ''}>${esc(statusLabel(s))}</option>`).join('')}</select></label><label>${esc(uiText('Name or account'))}<input name="q" type="search" maxlength="200" value="${esc(filters.search ?? '')}"></label><label class="check"><input name="approval" type="checkbox"${filters.awaiting_approval ? ' checked' : ''}> ${esc(uiText('Awaiting my approval'))}</label><label class="check"><input name="archived" type="checkbox"${filters.archived ? ' checked' : ''}> ${esc(uiText('Archived plans'))}</label><button class="button" type="submit">${esc(uiText('Filter'))}</button><small role="status">${esc(uiText('{count} plans', {count: uiNumber(total)}))}</small></form>`;
}
function campaignPlanRow(c) {
  const where = [
    ...(c.platforms ?? []).map(p => campaignProviderNames[p + '_native_action'] ?? p),
    ...(c.accounts ?? []).map(a => a.account_id),
  ];
  return `<div class="token-row"><div><strong dir="auto" data-native>${esc(c.name)}</strong><small>${esc(uiPlural(c.step_count, '{count} step', '{count} steps'))} · ${date(c.updated_at)}${where.length ? ' · ' + where.map(campaignNativeValue).join(', ') : ''}${c.access && c.access !== 'owner' ? ' · ' + esc(uiText(collaboratorAccessLabels[c.access] ?? c.access)) : ''}${c.archived ? ' · ' + esc(uiText('Archived')) : ''}</small></div>${badge(c.state)}<button class="button small" data-run="${esc(c.id)}">${esc(uiText('Open'))}</button></div>`;
}
/** Filters reload the list with their state in the URL; "Load more" continues the same filters with next_cursor. */
function bindCampaignList(page, filters, open) {
  workspaceBind('#campaign-filters', async form => {
    const q = new URLSearchParams(),
      v = Object.fromEntries(new FormData(form));
    if (v.state) q.set('state', v.state);
    if (String(v.q ?? '').trim()) q.set('q', String(v.q).trim());
    if (v.approval) q.set('approval', '1');
    if (v.archived) q.set('archived', '1');
    history.replaceState({}, '', '/campaigns' + (q.size ? '?' + q : ''));
    await renderWorkspacePage();
  });
  let cursor = page.next_cursor,
    batch = 0;
  workspaceBind('#campaign-more', async button => {
    const next = await workspaceCall('campaign', {action: 'list', limit: 50, ...filters, cursor});
    const rows = document.createElement('div');
    rows.dataset.batch = String(++batch);
    rows.innerHTML = next.campaigns.map(campaignPlanRow).join('');
    $('#campaign-rows').append(rows);
    workspaceBind('[data-batch="' + batch + '"] [data-run]', b => open(b.dataset.run));
    cursor = next.next_cursor;
    if (!cursor) button.remove();
  });
}
// The locations a Microsoft activation gate read (CMP-03): Microsoft's names stay literal, for the operator to confirm.
function activationLocationsView(out) {
  const gate = (out?.preflight?.activation_gates ?? []).find(
    g => g.gate === 'microsoft_location_criteria' && Array.isArray(g.locations),
  );
  return gate?.locations.length
    ? `<section class="notice" role="status"><h3>${esc(uiText('Locations Microsoft targets for this campaign'))}</h3><p>${esc(uiText('Confirm these are the intended locations before approving the activation.'))}</p><ul>${gate.locations.map(l => `<li><bdi dir="auto">${esc(l.name ?? uiText('Not returned'))}</bdi> · <code dir="ltr">${esc(l.location_id)}</code></li>`).join('')}</ul></section>`
    : '';
}
// Each prerequisite preflight found missing, with what to do about it: the server's remedy as the website words it
// (WEB-03), so a remedy written for an MCP client ("amend the step with recover_step") is never shown to a person.
function blockedRequirementsView(out) {
  const missing = out?.missing_requirements ?? [];
  return missing.length
    ? `<section class="notice" role="status"><h3>${esc(uiText('Prerequisites that block this plan'))}</h3><ul>${missing
        .map(m => {
          const remedy = m.error ? websiteRemedy(m.error) : '';
          return `<li><strong><code dir="ltr">${esc(m.step)}</code></strong> ${esc(uiText(m.error?.message ?? m.error?.code ?? ''))}${remedy ? `<br><small>${esc(remedy)}</small>` : ''}</li>`;
        })
        .join('')}</ul></section>`
    : '';
}
/** Loads a truncated step's complete field list when its list is opened; approval unlocks once every list was seen. */
function bindApprovalFields(id, summary) {
  const pending = new Set(summary.steps.filter(s => s.truncated).map(s => s.id));
  if (!pending.size) return;
  for (const details of document.querySelectorAll('[data-approval-step]'))
    details.addEventListener('toggle', async () => {
      if (!details.open || details.dataset.loaded) return;
      details.dataset.loaded = 'loading';
      try {
        const out = await workspaceCall('campaign', {action: 'approve', id, step_id: details.dataset.approvalStep});
        if (out.summary_hash !== summary.summary_hash)
          throw Error(uiText('The plan changed. Review the whole plan again.'));
        details.querySelector('.approval-all-fields-body').innerHTML = approvalFieldList(
          out.fields,
          uiText('Every budget, bid and status field of this step'),
        );
        details.dataset.loaded = 'true';
        pending.delete(details.dataset.approvalStep);
        if (!pending.size && $('#approve-plan')) $('#approve-plan').disabled = false;
      } catch (error) {
        delete details.dataset.loaded;
        details.open = false;
        toast(errorMessage(error), 'error');
      }
    });
}
// All progress actions operate on the original plan, review and key. A run may stop for an additional approval or
// uncertain result; continuing never invents a new key or replays a submitted mutation. `after` is the response that
// led to this view: one that names a recover_step call opens the amendment form on it; `{outcome}` is the response of
// an action on this page, shown with its one control (WEB-03).
function bindCampaignWorkflow(run, open, current, after) {
  const id = run.id,
    show = html => {
      if (current()) $('#campaign-review').innerHTML = html;
    };
  // A step whose state check refused its review is reviewed again: that is the plan's emphasized action (R25 M1, L5-04).
  if (campaignNextSafeAction(run) === 'review') $('#next-campaign')?.classList.add('primary');
  // DEC-02: an allocation plan shows its outcome review (a local read; capturing it is a separate choice).
  if (run.allocation) void mountAllocationOutcome(run, current);
  // The plan is read again, then the response's outcome is shown with its control (WEB-03) by the new view.
  const refresh = async out => {
    if (current()) await open(id, {outcome: out});
  };
  // A refusal the page can continue from is shown here, next to the plan, with its one control (WEB-03).
  const recoverable = {
    APPROVAL_REQUIRED: ['outcome-approve', 'Review plan approval'],
    PLAN_CHANGED: ['outcome-approve', 'Review plan approval'],
    REVIEW_EXPIRED: ['outcome-prepare-again', 'Prepare again'],
    STATE_CHANGED: ['outcome-prepare-again', 'Prepare again'],
  };
  const showRefusal = error => {
    const control = Object.hasOwn(recoverable, error?.code) ? recoverable[error.code] : null;
    if (!control || !current()) return false;
    show(
      `<section class="notice run-outcome" role="alert">${errorBlock(error)}<div class="dialog-actions"><button id="${control[0]}" type="button" class="button primary">${esc(uiText(control[1]))}</button></div></section>`,
    );
    workspaceBind('#outcome-approve', () => approvePlan());
    workspaceBind('#outcome-prepare-again', () => reviewStep());
    return true;
  };
  const guarded = async call => {
    try {
      return await call();
    } catch (error) {
      if (showRefusal(error)) return undefined;
      throw error;
    }
  };
  const runPlan = async (action = 'run') => {
    const out = await guarded(() => workspaceCall('campaign', {action, id}));
    if (out) await refresh(out);
  };
  // One step's review, with its consents unchecked, wired to execute_next for exactly that review and key.
  const showReview = (review, lead = '') => {
    show(lead + readableReview(review, uiText('Execute reviewed campaign step')));
    // An expired step review is prepared again by prepare_next, which reads the state again (WRT-05).
    bindReviewCountdown(review, reviewStep);
    workspaceBind('#execute-reviewed', async () => {
      const out = await guarded(() =>
        workspaceCall('campaign', {
          action: 'execute_next',
          id,
          review_id: review.review_id,
          idempotency_key: review.idempotency_key,
          ...readReviewConsents(review),
        }),
      );
      if (out) await refresh(out);
    });
  };
  const reviewStep = async () => {
    const r = await workspaceCall('campaign', {action: 'prepare_next', id, detail: 'full'});
    if (!current()) return;
    if (r.review) showReview(r.review);
    else await open(id, r);
  };
  workspaceBind('#next-campaign', reviewStep);
  // A response's outcome and its control. A run that stopped for an acknowledgement renders the returned review here.
  const showOutcome = (out, lead = '') => {
    if (
      /^needs_(spend_change|cap_override|creative_edit|destructive)_confirmed$/.test(out?.run?.stopped) &&
      out.review?.review_id
    ) {
      showReview(out.review, lead + runOutcomeView(out, run));
      return;
    }
    show(lead + campaignOutcome(out, run));
    workspaceBind('#outcome-continue', () => runPlan('run'));
    workspaceBind('#outcome-review-step', reviewStep);
    workspaceBind('#outcome-amend', async () => amend(out));
    workspaceBind('#outcome-confirm-absent', async () => confirmAbsent(out));
    workspaceBind('#outcome-preflight', async () => {
      const checked = await workspaceCall('campaign', {action: 'preflight', id, detail: 'full'});
      if (current()) await open(id, checked);
    });
    workspaceBind('#outcome-read-back', async () => {
      const stepId = out.next_call?.arguments?.action === 'reconcile_step' ? out.next_call.arguments.step_id : null,
        step = stepId ? {id: stepId} : campaignReadBackStep(run);
      if (!step) throw Error(uiText('No submitted step needs reconciliation.'));
      const read = await workspaceCall('campaign', {action: 'reconcile_step', id, step_id: step.id});
      await refresh(read);
    });
    workspaceBind('#outcome-accept', async () => acceptObserved(out.next_call?.arguments?.step_id));
  };
  // Sharing with colleagues (CMP-05): the owner names a member as viewer, editor or approver, or removes one.
  const team = async () => {
    const out = await workspaceCall('campaign', {action: 'assign', id});
    if (!current()) return;
    show(campaignTeamView(out));
    workspaceBind('#assign-form', async form => {
      await workspaceCall('campaign', {
        action: 'assign',
        id,
        user_id: form.elements.user_id.value,
        role: form.elements.role.value,
      });
      toast(uiText('Plan shared.'));
      await team();
    });
    workspaceBind('[data-unassign]', async button => {
      await workspaceCall('campaign', {action: 'unassign', id, user_id: button.dataset.unassign});
      await team();
    });
  };
  workspaceBind('#share-campaign', team);
  workspaceBind('#archive-campaign', async () => {
    if (
      !(await confirmAction({
        title: uiText('Archive this plan?'),
        consequence: uiText(
          'The plan leaves the default list and no longer counts toward the 500-plan limit. It stays readable and can be unarchived. Nothing changes at the provider.',
        ),
        confirmLabel: uiText('Archive plan'),
      }))
    )
      return;
    await workspaceCall('campaign', {action: 'archive', id, confirmed: true});
    if (current()) await open(id);
  });
  workspaceBind('#unarchive-campaign', async () => {
    await workspaceCall('campaign', {action: 'unarchive', id});
    if (current()) await open(id);
  });
  const approvePlan = async () => {
    const out = await workspaceCall('campaign', {action: 'approve', id});
    if (!current()) return;
    // The workspace requires a different approver for this plan: offer sharing instead of the approval form.
    if (out.approver_required) {
      show(
        `<section class="notice" role="status"><p>${esc(uiText(out.notice))}</p>${campaignCanManage(run) ? `<button id="share-for-approval" class="button" type="button">${esc(uiText('Share plan'))}</button>` : ''}</section>`,
      );
      workspaceBind('#share-for-approval', team);
      return;
    }
    show(approvalView(out.approval));
    bindApprovalFields(id, out.approval);
    workspaceBind('#approve-plan', async () => {
      if (!$('#plan-consent').checked) throw Error(uiText('Review and authorize this complete plan first.'));
      if ($('#approve-plan').disabled) throw Error(uiText('Open every “Show all fields” list before approving.'));
      const spending = approvalSpending(out.approval);
      if (spending && !$('#plan-spend-consent').checked)
        throw Error(uiText('Acknowledge the displayed budget and serving changes.'));
      // A plan that changed after this summary is refused as PLAN_CHANGED, shown with "Review plan approval" (WEB-03).
      const approved = await guarded(() =>
        workspaceCall('campaign', {
          action: 'approve',
          id,
          plan_hash: out.approval.plan_hash,
          summary_hash: out.approval.summary_hash,
          confirmed: true,
          ...(spending ? {spend_change_confirmed: true} : {}),
        }),
      );
      if (approved) await refresh(approved);
    });
  };
  workspaceBind('#approve-campaign', approvePlan);
  workspaceBind('#run-campaign', () => runPlan('run'));
  // An approved plan of uploads runs on the server: leaving the page does not stop it (MED-03 B).
  workspaceBind('#run-background', () => runPlan('run_background'));
  // A step whose file expired or changed gets a new file: planned for its one destination, then amended. The step is
  // reviewed again with the new file; the old bytes are never reused (MED-03 B).
  workspaceBind('[data-replace-source]', async button => {
    const step = run.steps.find(s => s.id === button.dataset.replaceSource);
    if (!step || !campaignReplaceable(step, run)) return;
    const listed = await api('/api/media/sources');
    if (!current()) return;
    const choices = (listed.sources ?? []).filter(
      s => s.state === 'complete' && s.source_id !== step.arguments.source_id,
    );
    show(
      `<section class="panel workspace-form"><h2>${esc(uiText('Replace the file of step {step}', {step: step.id}))}</h2><p>${esc(uiText('Its file expired or changed, so nothing was sent. Choose the file again; upload it on the Media page first if it is not listed. The step is reviewed again with the new file, and the old one is never reused. A website upload is deleted 30 minutes after it started, so run the plan before then.'))}</p>${
        choices.length
          ? `<form id="replace-source"><label>${esc(uiText('New file'))}<select name="source">${choices.map((s, i) => `<option value="${i}">${esc(s.filename)} · ${esc(uiDate(s.uploaded_at, {hour: '2-digit', minute: '2-digit'}))}</option>`).join('')}</select></label><label class="form-note"><input name="confirmed" type="checkbox" required> ${esc(uiText('Save this correction and invalidate the previous plan approval.'))}</label><button type="submit" class="button primary">${esc(uiText('Replace the file'))}</button></form>`
          : `<p>${esc(uiText('No other file is ready. Upload the file on the Media page, then come back.'))}</p>`
      }<a class="button" href="/media">${esc(uiText('Open the Media page'))}</a></section>`,
    );
    workspaceBind('#replace-source', async form => {
      const chosen = choices[Number(form.elements.source.value)],
        a = step.arguments;
      if (!chosen) throw Error(uiText('Choose the new file first.'));
      const planned = await workspaceCall('media', {
          action: 'plan',
          source_id: chosen.source_id,
          fit_to_platform: a.fit_to_platform === true,
          stage_fits: a.fit_to_platform === true,
          destinations: [
            Object.fromEntries(
              ['platform', 'account_id', 'connection_id', 'owner_urn', 'dv360_target']
                .filter(k => a[k] !== undefined)
                .map(k => [k, a[k]]),
            ),
          ],
        }),
        target = planned.destinations?.[0];
      if (!target?.ready) throw Error(target?.error?.message ?? uiText('This file cannot go to this account.'));
      const result = await workspaceCall('campaign', {
        action: 'recover_step',
        id,
        step_id: step.id,
        ...(run.revision !== undefined ? {expected_revision: run.revision} : {}),
        confirmed: form.elements.confirmed.checked,
        ...(/^src-/.test(chosen.source_id) ? {acknowledge_temporary_sources: true} : {}),
        patch: [
          {path: '/source_id', value: chosen.source_id},
          ...(a.expected_sha256 !== undefined ? [{path: '/expected_sha256', value: target.file.sha256}] : []),
        ],
      });
      await refresh(result);
    });
  });
  // The amendment form on the recover_step call a response names: a patch of one field, or, when the correction adds or
  // restructures fields (for example a field the provider now requires), the step's corrected native arguments.
  const amend = out => {
    const call = out.next_call;
    if (call?.arguments?.action !== 'recover_step') {
      showOutcome(out);
      return;
    }
    const step = run.steps.find(s => s.id === call.arguments.step_id);
    if (!step) {
      showOutcome(out);
      return;
    }
    // The server's reason names recover_step and next_call for MCP clients; the page says what the form does (WEB-03).
    const reason = out.recovery ?? out.decision,
      lead =
        typeof reason === 'string' && !agentDirected(reason)
          ? uiText(reason)
          : call.correct
            ? uiText(call.correct)
            : uiText(runRecoveryLabels.recover_step);
    const fields =
      call.choose ??
      reviewFields(step.arguments).filter(
        f => !f.reference && f.value !== null && ['string', 'number', 'boolean'].includes(typeof f.value),
      );
    const native = !call.choose && call.add_after_correction?.arguments;
    show(
      `${blockedRequirementsView(out)}<section class="panel workspace-form"><h2>${esc(uiText('Amend'))} ${esc(step.id)}</h2><p>${esc(lead)}</p>${fields.length ? `<form id="amend-step"><label>${esc(uiText('Field'))}<select name="field">${fields.map((f, i) => `<option value="${i}">${esc(f.path)}</option>`).join('')}</select></label><div id="amend-value"></div><label class="form-note"><input name="confirmed" type="checkbox" required> ${esc(uiText('Save this correction and invalidate the previous plan approval.'))}</label><button type="submit" class="button primary">${esc(uiText('Save amendment'))}</button></form>` : ''}${native ? `<details${fields.length ? '' : ' open'}><summary>${esc(uiText('Correct the native arguments instead'))}</summary><form id="amend-arguments"><label>${esc(uiText('Corrected native arguments'))}<textarea name="arguments" rows="10" dir="ltr" required>${esc(JSON.stringify(step.arguments, null, 2))}</textarea></label><label class="form-note"><input name="confirmed" type="checkbox" required> ${esc(uiText('Save this correction and invalidate the previous plan approval.'))}</label><button type="submit" class="button">${esc(uiText('Save corrected arguments'))}</button></form></details>` : ''}</section>`,
    );
    if (native)
      workspaceBind('#amend-arguments', async form => {
        let args;
        try {
          args = JSON.parse(form.elements.arguments.value);
        } catch {
          throw Error(uiText('Enter the corrected arguments as one JSON object.'));
        }
        if (!args || typeof args !== 'object' || Array.isArray(args))
          throw Error(uiText('Enter the corrected arguments as one JSON object.'));
        const result = await workspaceCall('campaign', {
          action: 'recover_step',
          id,
          step_id: step.id,
          ...(out.revision !== undefined ? {expected_revision: out.revision} : {}),
          confirmed: form.elements.confirmed.checked,
          arguments: args,
        });
        await refresh(result);
      });
    if (!fields.length) {
      if (!native) showOutcome(out);
      return;
    }
    const form = $('#amend-step');
    const field = () => fields[Number(form.elements.field.value)];
    const edit = () => {
      const f = field(),
        value = f.current ?? f.value;
      $('#amend-value').innerHTML =
        `<p>${esc(uiText('Current value:'))} <code>${esc(reviewValue(value))}</code></p><label>${esc(uiText('Corrected value'))}${f.allowed_values ? `<select name="value">${f.allowed_values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}</select>` : typeof value === 'boolean' ? `<select name="value"><option value="true"${value ? ' selected' : ''}>${esc(uiText('true'))}</option><option value="false"${!value ? ' selected' : ''}>${esc(uiText('false'))}</option></select>` : `<input name="value" type="${typeof value === 'number' ? 'number' : 'text'}" step="any" value="${esc(value)}" required>`}</label>`;
    };
    form.elements.field.addEventListener('change', edit);
    edit();
    workspaceBind('#amend-step', async () => {
      const f = field(),
        previous = f.current ?? f.value,
        raw = form.elements.value.value;
      const value = typeof previous === 'number' ? Number(raw) : typeof previous === 'boolean' ? raw === 'true' : raw;
      const result = await workspaceCall('campaign', {
        action: 'recover_step',
        id,
        step_id: step.id,
        ...(out.revision !== undefined ? {expected_revision: out.revision} : {}),
        confirmed: form.elements.confirmed.checked,
        patch: [{path: f.path, value}],
      });
      await refresh(result);
    });
  };
  workspaceBind('#amend-campaign', async () => {
    const out = await workspaceCall('campaign', {action: 'prepare_next', id});
    if (!current()) return;
    if (out.next_call?.arguments?.action === 'confirm_absent') confirmAbsent(out);
    else amend(out);
  });
  // A step the provider refused after submission whose outcome AMCP cannot prove (CMP-04): a read-only check of the
  // provider, then the person's confirmation, lets the step be corrected under a new review. Nothing is sent here.
  const confirmAbsent = out => {
    const stepId = out.next_call.arguments.step_id;
    show(
      `<section class="panel workspace-form"><h2>${esc(uiText('Confirm the resource does not exist'))}</h2><p>${esc(uiText('The provider refused this step after it was sent, and AMCP cannot prove nothing was created. Check the provider first: a resource of the same name created since then means the step may have been applied.'))}</p><p class="form-note"><code dir="ltr">${esc(stepId)}</code></p><button id="probe-absent" class="button" type="button">${esc(uiText('Check the provider'))}</button><div id="absence-result" aria-live="polite"></div></section>`,
    );
    workspaceBind('#probe-absent', async () => {
      const probe = await workspaceCall('campaign', {action: 'confirm_absent', id, step_id: stepId});
      if (!current()) return;
      $('#absence-result').innerHTML =
        `<p>${esc(uiText('A complete read of the provider found no resource of this name created since the step was sent.'))}</p>${recordDetails(probe.probe, uiText('Provider read'))}<label class="form-note"><input id="absent-consent" type="checkbox"> ${esc(uiText('I confirm this resource does not exist at the provider.'))}</label><button id="confirm-absent" class="button primary" type="button">${esc(uiText('Record that it does not exist'))}</button>`;
      workspaceBind('#confirm-absent', async () => {
        if (!$('#absent-consent').checked) throw Error(uiText('Confirm that the resource does not exist first.'));
        const confirmed = await workspaceCall('campaign', {
          action: 'confirm_absent',
          id,
          step_id: stepId,
          confirmed: true,
        });
        if (current()) await open(id, confirmed);
      });
    });
  };
  // The steps still to write continue in a new linked plan; verified steps are adopted, never sent again (CMP-04).
  workspaceBind('#continue-campaign', async () => {
    if (
      !(await confirmAction({
        title: uiText('Continue in a new linked plan?'),
        consequence: uiText(
          'The steps not yet done move to a new plan that uses the IDs this plan already created. This plan is marked superseded; nothing is sent until the new plan is reviewed.',
        ),
        confirmLabel: uiText('Continue in a new linked plan'),
      }))
    )
      return;
    const next = await workspaceCall('campaign', {action: 'continue_as_new', id, confirmed: true});
    if (current()) await open(next.id);
  });
  // Activation is its own plan with its own approval and spend confirmation; drafting it sends nothing (CMP-03).
  workspaceBind('#activate-campaign', async () => {
    if (
      !(await confirmAction({
        title: uiText('Prepare activation?'),
        consequence: uiText(
          'AMCP drafts a separate plan that activates this paused launch. Read-only checks run first, and nothing is sent until you review and approve that plan with its own spend confirmation.',
        ),
        confirmLabel: uiText('Prepare activation'),
      }))
    )
      return;
    const next = await workspaceCall('campaign', {action: 'activation_plan', id});
    if (current()) await open(next.id);
  });
  // The observed values of a read-back step, for the person to accept or not; nothing is sent (CMP-04).
  const acceptObserved = stepId => {
    const step = run.steps.find(s => s.id === stepId);
    if (!step?.verification?.actual_hash) throw Error(uiText('Read back this step before accepting observed values.'));
    show(
      `<section class="panel workspace-form"><h2>${esc(uiText('Accept observed values for'))} ${esc(step.id)}</h2><p>${esc(uiText('This records your acceptance of the values read back from the provider. Dependent steps may then proceed.'))}</p>${verificationComparison(step.verification)}${recordDetails(step.verification, uiText('Complete comparison'))}<label class="form-note"><input id="observed-consent" type="checkbox"> ${esc(uiText('I accept these exact observed values as the result of this step.'))}</label><button id="accept-observed" class="button primary">${esc(uiText('Record acceptance'))}</button></section>`,
    );
    workspaceBind('#accept-observed', async () => {
      if (!$('#observed-consent').checked)
        throw Error(uiText('Review and accept the displayed provider values first.'));
      const out = await workspaceCall('campaign', {
        action: 'reconcile_step',
        id,
        step_id: step.id,
        actual_hash: step.verification.actual_hash,
        accept_observed: true,
      });
      await refresh(out);
    });
  };
  workspaceBind('[data-accept-observed]', async button => acceptObserved(button.dataset.acceptObserved));
  // Preflight or prepare_next found a step to correct: show what blocked it and the form, not the raw plan state. The
  // response of an action on this page shows its outcome and its one control (WEB-03).
  if (after?.outcome) showOutcome(after.outcome);
  else if (after) {
    if (after.next_call?.arguments?.action === 'recover_step') amend(after);
    else if (after.next_call?.arguments?.action === 'confirm_absent') confirmAbsent(after);
    // A preflight's Microsoft activation gate names the locations it read, for the operator to confirm (CMP-03).
    else showOutcome(after, activationLocationsView(after));
  }
}
function mountCampaignClone(open) {
  const supported = [
    'google_ads_native_action',
    'snapchat_native_action',
    'tiktok_native_action',
    'linkedin_native_action',
  ];
  const writable = platforms
    .filter(p => supported.includes(p.gateway))
    .flatMap(p =>
      p.connections
        .filter(c => c.enabled)
        .flatMap(c =>
          c.accounts
            .filter(id => c.writeAccounts?.includes(id) || c.write_accounts?.includes(id))
            .map(id => ({gateway: p.gateway, connection_id: c.id, account_id: id, label: accountLabel(p, c, id)})),
        ),
    );
  // The source picker follows the working client (SEC-08); an account a link names stays listed.
  const targets = typeof clientAccountOptions === 'function' ? clientAccountOptions(writable).options : writable;
  // WEB-06: /campaigns?clone=1&connection_id=&account_id=&source_id=#campaign-clone (Portfolio's "Clone into a draft")
  // preselects the source; nothing is read until the person submits. An account they cannot clone from is named.
  const params =
      typeof URLSearchParams === 'function' && typeof location === 'object' && location
        ? new URLSearchParams(location.search ?? '')
        : new Map(),
    linked = params.get('clone') === '1',
    linkedIndex = linked
      ? targets.findIndex(
          t => t.connection_id === params.get('connection_id') && t.account_id === params.get('account_id'),
        )
      : -1,
    linkedMissing = linked && !!(params.get('connection_id') || params.get('account_id')) && linkedIndex < 0,
    linkedSource = linked ? (params.get('source_id') ?? '').slice(0, 200) : '';
  $('#campaign-clone').innerHTML =
    `<summary>${esc(uiText('Clone an existing campaign'))}</summary><p>${esc(uiText('Supported sources: Google Search, Snapchat, TikTok and LinkedIn campaign groups. The source is read into a draft; review the fields omitted from the clone before approval.'))}</p>${linkedMissing ? `<p class="notice" role="status">${esc(uiText('The linked account is not available for cloning. Choose an account with write access.'))}</p>` : ''}<form id="clone-form"><label>${esc(uiText('Source account'))}<select name="target" required>${linkedMissing ? `<option value="" selected>${esc(uiText('Previously selected account — check access'))}</option>` : ''}<option value="">${esc(uiText('Choose an account with write access'))}</option>${targets.map((t, i) => `<option value="${i}" ${i === linkedIndex ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></label>${controls(uiText('Source campaign or group ID'), 'text', linkedSource, 'source')}${controls(uiText('New campaign name'), 'text', '', 'name')}<button type="submit" class="button">${esc(uiText('Read source and create draft'))}</button></form>`;
  if (linked) {
    $('#campaign-create').open = true;
    $('#campaign-clone').open = true;
  }
  workspaceBind('#clone-form', async form => {
    const target = targets[Number(form.elements.target.value)];
    if (
      form.elements.target.value === '' ||
      !target ||
      !form.elements.source.value.trim() ||
      !form.elements.name.value.trim()
    )
      throw Error(uiText('Choose the source account, ID and new campaign name.'));
    const {label, ...binding} = target;
    const request = {
      action: 'clone',
      ...binding,
      source: {campaign_id: form.elements.source.value.trim()},
      name: form.elements.name.value.trim(),
    };
    // One creation key per exact clone request: a retry returns the draft already saved (CMP-02 b).
    const signature = JSON.stringify(request);
    if (form.dataset.cloneRequest !== signature) {
      form.dataset.cloneRequest = signature;
      form.dataset.cloneKey = crypto.randomUUID();
    }
    const key = form.dataset.cloneKey;
    const out = await workspaceCall('campaign', {...request, idempotency_key: key});
    if (form.dataset.cloneKey === key) delete form.dataset.cloneRequest;
    await open(out.id);
    toast(uiText('Clone saved as a draft. Review omitted fields and approve the exact plan.'));
  });
}

/** DEC-02: first-party labels for an outcome review's codes; provider values and amounts stay literal. */
const allocationOutcomePositions = {
  within: 'Within the modeled range',
  below: 'Below the modeled range',
  above: 'Above the modeled range',
  unknown: 'Unknown',
};
const allocationOutcomeReasons = {
  plan_not_complete: 'The plan has not finished: every budget step must be executed and verified first.',
  steps_not_verified: 'Not every budget step was verified by read-back.',
  not_an_allocation_plan: 'This plan did not come from an allocation proposal.',
  source_report_deleted: 'The proposal’s evidence report was deleted.',
  source_report_changed: 'The proposal’s evidence report changed after the plan was created.',
  proposal_not_reproducible: 'The proposal can no longer be reproduced from its evidence.',
  preset_unqualified: 'The proposal’s evidence report type does not qualify.',
  measurement_definition_changed: 'The outcome report used different measurement settings than the proposal.',
  not_recorded:
    'No outcome review is recorded for this plan yet. Someone who can edit or approve the plan records it by opening this outcome.',
};
const allocationOutcomeText = (labels, code) => (Object.hasOwn(labels, code) ? uiText(labels[code]) : String(code));
/** An exact range of decimal strings, or Unknown. */
function allocationOutcomeRange(low, high) {
  return low === null || high === null
    ? esc(uiText('Unknown'))
    : `${campaignNativeValue(low)}–${campaignNativeValue(high)}`;
}
/** One row of the comparison: never coloured as good or bad, every amount as AMCP retained it. */
function allocationOutcomeRow(row, currency, heading) {
  const share =
    row.spend_to_proposed === null
      ? ''
      : `<small>${esc(uiText('{percent}% of the proposed budget', {percent: uiNumber(Number(row.spend_to_proposed) * 100, {maximumFractionDigits: 1})}))}</small>`;
  return `<tr><th scope="row">${heading}</th><td>${campaignNativeValue(row.proposed_budget)} ${campaignNativeValue(currency)}</td><td>${row.realized_spend === null ? esc(uiText('Unknown')) : `${campaignNativeValue(row.realized_spend)} ${campaignNativeValue(currency)}`}${share}</td><td>${allocationOutcomeRange(row.modeled_conversions_low, row.modeled_conversions_high)}</td><td>${row.realized_conversions === null ? esc(uiText('Unknown')) : campaignNativeValue(row.realized_conversions)}<small>${esc(allocationOutcomeText(allocationOutcomePositions, row.position))}</small></td><td>${allocationOutcomeRange(row.spend_conditioned_low, row.spend_conditioned_high)}<small>${esc(allocationOutcomeText(allocationOutcomePositions, row.spend_conditioned_position))}</small></td><td>${row.realized_factor === null ? esc(uiText('Unknown')) : campaignNativeValue(row.realized_factor)}</td></tr>`;
}
function allocationOutcomeView(out, viewer) {
  const heading = `<h3>${esc(uiText('Outcome review'))}</h3>`,
    period = out.window
      ? `<p>${esc(uiText('Outcome window: {since} – {until} ({days} days, {timezone}).', {since: out.window.since, until: out.window.until, days: uiNumber(out.window.days), timezone: out.window.timezone}))}</p>`
      : '';
  if (out.state === 'not_scheduled')
    return `${heading}<p class="form-note">${esc(allocationOutcomeText(allocationOutcomeReasons, out.reason))} ${esc(uiText(out.meaning))}</p>`;
  if (out.state === 'unavailable')
    return `${heading}<p class="notice">${esc(uiText('This outcome cannot be compared with the proposal: {reason}', {reason: allocationOutcomeText(allocationOutcomeReasons, out.reason)}))}</p>`;
  if (out.state === 'scheduled')
    return `${heading}${period}<p>${esc(uiText('After the window closes, AMCP captures the same entities with the proposal’s report settings and shows them beside the proposal. Nothing is read before then.'))}</p><p class="form-note">${esc(uiText('The window closes {time}.', {time: uiDate(out.due_at)}))}${out.automatic ? '' : ' ' + esc(uiText('Open this plan after it closes to review the outcome.'))}</p>`;
  if (out.state === 'due')
    return `${heading}${period}<p>${esc(uiText('The outcome window has closed.'))}</p>${out.last_error ? `<p class="notice">${esc(uiText('The automatic review could not finish ({code}). You can review the outcome now.', {code: out.last_error.code}))}</p>` : ''}${viewer ? '' : `<button id="allocation-outcome-capture" class="button" type="button">${esc(uiText('Review the outcome now'))}</button>`}`;
  const entity = out.entity_kind === 'ad_squad' ? uiText('Ad squad') : uiText('Campaign'),
    caption = uiText('Outcome beside the proposal');
  return `${heading}${period}<p class="notice">${esc(uiText(out.limitations[0]))}</p><div class="data-scroll" role="region" aria-label="${esc(uiText('Outcome beside the proposal, scroll for all columns'))}" tabindex="0"><table class="review-table"><caption>${esc(caption)}</caption><thead><tr><th scope="col">${esc(entity)}</th><th scope="col">${esc(uiText('Proposed budget'))}</th><th scope="col">${esc(uiText('Realized spend'))}</th><th scope="col">${esc(uiText('Modeled conversions at the proposed budget'))}</th><th scope="col">${esc(uiText('Realized conversions'))}</th><th scope="col">${esc(uiText('Modeled at the realized spend'))}</th><th scope="col">${esc(uiText('Realized factor'))}</th></tr></thead><tbody>${out.entities
    .map(row =>
      allocationOutcomeRow(
        row,
        out.currency,
        row.name && row.name !== row.entity_id
          ? `<bdi dir="auto">${esc(row.name)}</bdi><small>${campaignNativeValue(row.entity_id)}</small>`
          : campaignNativeValue(row.entity_id),
      ),
    )
    .join(
      '',
    )}${allocationOutcomeRow(out.totals, out.currency, esc(uiText('Total')))}</tbody></table></div><ul class="form-note">${out.limitations
    .slice(1)
    .map(message => `<li>${esc(uiText(message))}</li>`)
    .join(
      '',
    )}</ul><p class="form-note">${esc(uiText(out.calibration_evidence.meaning))} <a href="${esc(out.calibration_evidence.website_path)}">${esc(uiText('Inspect the outcome evidence'))}</a></p>`;
}
/** Loads the outcome review of an allocation plan; capturing it after the window closes is an explicit choice. */
async function mountAllocationOutcome(run, current) {
  const root = $('#allocation-outcome'),
    alive = () => current() && root?.isConnected,
    viewer = typeof session === 'object' && session.workspaceRole === 'viewer',
    paint = out => {
      if (!alive()) return;
      root.innerHTML = allocationOutcomeView(out, viewer);
      // workspaceBind keeps the button disabled while the capture runs and shows a refusal as a notice.
      workspaceBind('#allocation-outcome-capture', async () => {
        if (!alive()) return;
        paint(await workspaceCall('reporting', {action: 'capture_allocation_outcome', id: run.id}));
      });
    };
  if (!root) return;
  try {
    paint(await workspaceCall('reporting', {action: 'allocation_outcome', id: run.id}));
  } catch (e) {
    if (alive())
      root.innerHTML = `<h3>${esc(uiText('Outcome review'))}</h3><p class="notice">${esc(errorMessage(e))}</p>`;
  }
}
