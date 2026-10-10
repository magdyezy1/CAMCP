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
function reviewTable(value, caption) {
  const fields = reviewFields(value);
  return fields.length
    ? `<div class="data-scroll" role="region" aria-label="${esc(caption)}" tabindex="0"><table class="review-table"><caption>${esc(caption)}</caption><thead><tr><th scope="col">${esc(uiText('Field / native unit'))}</th><th scope="col">${esc(uiText('Value'))}</th></tr></thead><tbody>${fields.map(f => `<tr><th scope="row"><code dir="ltr">${esc(f.path || 'value')}</code></th><td dir="auto">${esc(reviewValue(f.value))}</td></tr>`).join('')}</tbody></table></div>${fields.length === 160 ? `<p class="form-note">${esc(uiText('Summary limited to 160 fields. Inspect the complete request below before approving.'))}</p>` : ''}`
    : blank(uiText('No values supplied.'));
}
const reviewConsentLabels = {
  confirmed: 'I reviewed this exact request and authorize its execution.',
  spend_change_confirmed: 'I authorize the budget, bid or serving change shown in this review.',
  cap_override_confirmed: 'I authorize the specific spending-policy override shown in this review.',
  creative_edit_confirmed: 'I authorize the creative edit and its stated impact on existing ads.',
};
const reviewConsentIds = {
  confirmed: 'review-consent',
  spend_change_confirmed: 'spend-consent',
  cap_override_confirmed: 'cap-consent',
  creative_edit_confirmed: 'creative-consent',
};
function requiredReviewConsents(review) {
  return Object.keys(reviewConsentLabels).filter(
    key => key === 'confirmed' || review.execute_requirements?.[key] === true,
  );
}
function readReviewConsents(review) {
  return Object.fromEntries(
    requiredReviewConsents(review).map(key => {
      if (!$('#' + reviewConsentIds[key])?.checked) throw Error(uiText(reviewConsentLabels[key]));
      return [key, true];
    }),
  );
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
function readableReview(review, buttonLabel) {
  const request = review.request ?? {},
    needs = review.execute_requirements ?? {};
  return `<section class="panel workspace-form review-panel"><div class="panel-header"><h2>${esc(uiText('Review this change'))}</h2>${badge('awaiting_review')}</div><p>${esc(uiText('Expires'))} ${date(review.expires_at)}${esc(uiText('. Approval applies to this frozen request only.'))}</p><p class="form-note" id="review-countdown" role="timer"></p><div id="review-expired" role="status" hidden><p class="notice">${esc(uiText('This review expired before it was executed. Nothing was sent. Prepare it again: the current state is read again and a new review is created.'))}</p><button id="prepare-again" class="button" type="button">${esc(uiText('Prepare again'))}</button></div>${review.unchanged_since_review ? `<p class="form-note">${esc(uiText('Nothing changed since the expired review: the request and the state it read are the same.'))}</p>` : ''}${reviewSummaryLine(review.summary)}${effectBadges(review.effects ?? needs.effects, needs.reasons)}${reviewTable(request, uiText('Request to submit — exact native fields'))}${review.creative_impact ? reviewTable(review.creative_impact, uiText('Creative impact')) : ''}${review.spend_policy ? reviewTable(review.spend_policy, uiText('Spending-policy effects')) : ''}${review.before_state ? `<details><summary>${esc(uiText('Current state read from the provider'))}</summary>${reviewTable(review.before_state, uiText('Observed before preparation'))}</details>` : ''}${needs.reasons ? reviewTable(needs.reasons, uiText('Why acknowledgement is required')) : ''}${recordDetails(review, uiText('Complete request, state, prerequisites and evidence'))}<fieldset class="review-consents"><legend>${esc(uiText('Authorize this request'))}</legend>${requiredReviewConsents(
    review,
  )
    .map(
      key =>
        `<label class="form-note"><input id="${reviewConsentIds[key]}" type="checkbox"> ${esc(uiText(reviewConsentLabels[key]))}</label>`,
    )
    .join(
      '',
    )}</fieldset><button id="execute-reviewed" type="button" class="button primary">${esc(uiText(buttonLabel))}</button></section>`;
}
const campaignNativeValue = value => `<bdi dir="ltr">${esc(value ?? uiText('Unknown'))}</bdi>`;
const campaignProviderNames = {
  google_ads_native_action: 'Google Ads',
  snapchat_native_action: 'Snapchat',
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
};
function allocationAmountMatches(amount, micros) {
  if (typeof amount !== 'string' || !/^\d+(?:\.\d{1,6})?$/.test(amount)) return false;
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0')) === BigInt(micros);
}
function allocationReviewContext(run) {
  const a = run.allocation;
  if (!a || !['google_ads_native_action', 'linkedin_native_action', 'snapchat_native_action'].includes(a.gateway))
    return null;
  const snap = a.gateway === 'snapchat_native_action',
    linkedin = a.gateway === 'linkedin_native_action';
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
          (!/^[1-9][0-9]{0,19}$/.test(t.campaign_id) || t.entity_id !== 'urn:li:sponsoredCampaign:' + t.campaign_id)),
    )
  )
    return null;
  return {allocation: a, snap, linkedin};
}
function allocationProposalView(context) {
  if (!context) return '';
  const {allocation: a, snap, linkedin} = context;
  const caption = uiText(snap ? 'Retained ad-squad budgets' : 'Retained campaign budgets');
  const fields = [
    [allocationReviewLabels.provider, campaignNativeValue(campaignProviderNames[a.gateway])],
    [allocationReviewLabels.account, campaignNativeValue(a.account_id)],
    [allocationReviewLabels.currency, campaignNativeValue(a.currency)],
    [allocationReviewLabels.timezone, campaignNativeValue(a.timezone)],
    [allocationReviewLabels.period, esc(uiText('Days: {count}', {count: uiNumber(a.period_days)}))],
    ...(snap ? [[allocationReviewLabels.parent, campaignNativeValue(a.parent_campaign_id)]] : []),
  ];
  const headers = [
    snap ? allocationReviewLabels.squad : allocationReviewLabels.campaign,
    snap || linkedin ? allocationReviewLabels.currentDaily : allocationReviewLabels.currentAverage,
    snap || linkedin ? allocationReviewLabels.proposedDaily : allocationReviewLabels.proposedAverage,
    ...(linkedin ? [] : [allocationReviewLabels.micros]),
    allocationReviewLabels.periodBudget,
  ];
  return `<section class="allocation-proposal" aria-label="${esc(uiText('Retained budget proposal'))}"><h3>${esc(uiText('Retained budget proposal'))}</h3><p class="form-note">${esc(uiText('These are the saved preview amounts. Current provider settings must be checked again before review and execution.'))}</p><dl>${fields.map(([label, value]) => `<div><dt>${esc(uiText(label))}</dt><dd>${value}</dd></div>`).join('')}</dl><div class="data-scroll" role="region" aria-label="${esc(caption)}" tabindex="0"><table class="review-table"><caption>${esc(caption)}</caption><thead><tr>${headers.map(label => `<th scope="col">${esc(uiText(label))}</th>`).join('')}</tr></thead><tbody>${a.targets
    .map(t => {
      const id = snap || linkedin ? t.entity_id : t.campaign_id;
      const name =
        t.name && t.name !== id
          ? `<bdi dir="auto">${esc(t.name)}</bdi><small>${campaignNativeValue(id)}</small>`
          : campaignNativeValue(id);
      return `<tr><th scope="row">${name}</th><td>${campaignNativeValue(t.current_daily_budget)} ${campaignNativeValue(a.currency)}</td><td>${campaignNativeValue(t.daily_budget)} ${campaignNativeValue(a.currency)}</td>${linkedin ? '' : `<td>${campaignNativeValue(t.daily_budget_micros)}</td>`}<td>${campaignNativeValue(t.period_budget)} ${campaignNativeValue(a.currency)}</td></tr>`;
    })
    .join(
      '',
    )}</tbody></table></div><p class="form-note">${esc(uiText(linkedin ? 'LinkedIn native budgets are decimal amounts in account currency. Daily settings can spend up to 150% on a day with strong auction opportunities. Existing group caps are preserved; this proposal sets no end date or automatic period cap.' : snap ? 'Daily budgets remain in effect until separately changed; this proposal sets no end date or period spending cap.' : 'Average daily budgets remain in effect until separately changed; this proposal sets no end date or period spending cap.'))} <a href="/reports?id=${encodeURIComponent(a.report_id)}">${esc(uiText('Inspect original report'))}</a></p></section>`;
}
function allocationStepDescription(step, context) {
  if (!context || step.kind !== 'write') return null;
  const {allocation: a, snap, linkedin} = context,
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
        : ['action', 'path_params', 'payload'].filter(key => snap || key !== 'path_params'),
    )
  )
    return null;
  const target = a.targets.find(t => {
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
  return `${esc(uiText(snap ? 'Ad squad' : 'Campaign'))} ${campaignNativeValue(snap || linkedin ? target.entity_id : target.campaign_id)}: ${esc(uiText(snap || linkedin ? 'Proposed daily budget' : 'Proposed average daily budget'))} ${campaignNativeValue(target.daily_budget)} ${campaignNativeValue(a.currency)}`;
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
  return `<section><h3>${esc(uiText('Saved consent additions'))}</h3><p class="notice">${esc(uiText('These explicit additional-consent requirements apply to workspace tags. Native review and read-back remain required. Publishing is separate; runtime consent and event delivery remain unverified.'))}</p><p><code dir="ltr">${esc(c.scope.workspace_path)}</code></p><div class="data-scroll" role="region" aria-label="${esc(uiText('Consent additions'))}" tabindex="0"><table class="review-table"><caption>${esc(uiText('Consent additions'))}</caption><thead><tr><th scope="col">${esc(uiText('Tag'))}</th><th scope="col">${esc(uiText('Original consent setting'))}</th><th scope="col">${esc(uiText('Original required types'))}</th><th scope="col">${esc(uiText('Proposed required types'))}</th><th scope="col">${esc(uiText('Draft change'))}</th></tr></thead><tbody>${c.targets.map(t => `<tr><th scope="row"><bdi dir="auto">${esc(t.name ?? t.tag_id)}</bdi><br><code dir="ltr">${esc(t.tag_id)}</code></th><td>${esc(setting(t.before_setting))}</td><td><code dir="ltr">${esc(t.before_required_types.join(', ') || '—')}</code></td><td><code dir="ltr">${esc(t.proposed_required_types.join(', '))}</code></td><td>${esc(uiText(t.state === 'change' ? 'Add required types' : 'Already required; no step'))}</td></tr>`).join('')}</tbody></table></div></section>`;
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
    a = step.arguments?.arguments;
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
    step.description !== 'Tag ' + t.tag_id + ': require additional consent ' + t.proposed_required_types.join(', ')
  )
    return null;
  return `${esc(uiText('Tag'))} ${campaignNativeValue(t.tag_id)}: ${esc(uiText('Proposed required types'))} <code dir="ltr">${esc(t.proposed_required_types.join(', '))}</code>`;
}
function campaignJournal(run) {
  const context = allocationReviewContext(run),
    consent = consentReviewContext(run);
  const originalBrief = `<p><bdi dir="auto">${esc(run.brief)}</bdi></p>`;
  const recipeBrief = ['snapchat_website_traffic', 'snapchat_lead_generation'].includes(run.recipe?.id)
    ? `<p class="notice">${esc(uiText('This saved Snapchat workflow uses an existing creative. Inspect the native steps and original brief; each change requires review and activation is separate.'))}</p><details><summary>${esc(uiText('Original plan brief'))}</summary>${originalBrief}</details>`
    : originalBrief;
  return `<h2 tabindex="-1"><bdi dir="auto">${esc(consent && run.name === 'Tag consent draft' ? uiText('Tag consent draft') : run.name)}</bdi></h2><div class="work-summary">${badge(run.state)}<span>${esc(uiText('Revision'))} ${campaignNativeValue(run.revision)}</span><a href="/campaigns?id=${encodeURIComponent(run.id)}">${esc(uiText('Link to this plan'))}</a></div>${context ? allocationProposalView(context) + `<details><summary>${esc(uiText('Original plan brief'))}</summary>${originalBrief}</details>` : consent ? consentProposalView(consent) + `<details><summary>${esc(uiText('Original plan brief'))}</summary>${originalBrief}</details>` : recipeBrief}<ol class="campaign-steps">${run.steps
    .map(s => {
      const description = allocationStepDescription(s, context) ?? consentStepDescription(s, consent);
      return `<li><div><strong>${description ?? `<bdi dir="auto">${esc(s.description ?? s.id)}</bdi>`}</strong><small>${campaignNativeValue(campaignProviderNames[s.gateway] ?? s.gateway ?? s.arguments?.platform)} · ${campaignNativeValue(s.account_id)}</small><small>${esc(uiText('Depends on:'))} ${esc(s.depends_on?.join(', ') || uiText('No predecessor'))}</small>${description ? `<details><summary>${esc(uiText('Original step description'))}</summary><p><bdi dir="auto">${esc(s.description ?? s.id)}</bdi></p></details>` : ''}</div>${badge(s.status)}${s.error ? `<p class="error">${esc(s.error.message)}</p>${recordDetails(s.error, uiText('Error and remedy'))}` : ''}${s.verification ? `${verificationComparison(s.verification)}${recordDetails(s.verification, uiText('Read-back evidence'))}` : ''}${s.review_id ? `<small>${esc(uiText('Original review:'))} <code dir="ltr">${esc(s.review_id)}</code></small>` : ''}</li>`;
    })
    .join(
      '',
    )}</ol>${run.clone ? reviewTable(run.clone.not_copied ?? [], uiText('Source fields not copied')) : ''}${run.allocation && !context ? `<p class="notice">${esc(uiText('This budget plan came from a retained allocation.'))} <a href="/reports?id=${encodeURIComponent(run.allocation.report_id)}">${esc(uiText('Inspect original report'))}</a>${esc(uiText('. Daily budgets remain in effect until separately changed; the reference period sets no end date.'))}</p>` : ''}${recordDetails({allocation: run.allocation, gtm_consent: run.gtm_consent, plan_hash: run.plan_hash, profile_id: run.profile_id, profile_revision: run.profile_revision, recipe: run.recipe, clone: run.clone, execution_journal: run.execution_journal}, uiText('Plan provenance and execution journal'))}`;
}
function verificationComparison(verification) {
  const checks = (verification.checks ?? []).flatMap(check =>
    check.diff?.length ? check.diff.map(diff => ({...diff, status: check.status})) : [check],
  );
  return checks.length
    ? `<div class="data-scroll" role="region" aria-label="${esc(uiText('Read-back comparison'))}" tabindex="0"><table class="review-table"><caption>${esc(uiText('Read-back comparison'))}</caption><thead><tr><th>${esc(uiText('Check'))}</th><th>${esc(uiText('Expected'))}</th><th>${esc(uiText('Observed'))}</th><th>${esc(uiText('Result'))}</th></tr></thead><tbody>${checks.map(c => `<tr><th scope="row">${esc(c.field ?? c.name ?? c.path ?? c.id ?? (c.changed_fields ?? []).join(', '))}</th><td>${esc(JSON.stringify(c.expected ?? c.expected_value ?? null))}</td><td>${esc(JSON.stringify(c.actual ?? c.actual_value ?? c.observed ?? null))}</td><td>${badge(c.status ?? (c.matches === true ? 'verified' : 'unknown'))}</td></tr>`).join('')}</tbody></table></div>`
    : '';
}
function campaignOutcome(out) {
  const reason = out.run?.reason ?? out.recovery ?? out.decision ?? out.run?.stopped ?? out.state ?? uiText('Saved');
  return `<div class="notice" role="status"><p>${esc(reason)}</p></div>${recordDetails(out, uiText('Result, receipts and next safe action'))}`;
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
  return `<section class="panel workspace-form"><h2>${esc(uiText('Approve this complete plan'))}</h2><p>${esc(summary.covers)}</p><ol class="campaign-steps">${summary.steps.map(s => `<li><strong>${esc(s.id)} · ${esc(s.action)}</strong><small>${esc(s.gateway)} ${esc(uiText('· Account'))} ${esc(s.account_id)}</small>${effectBadges(s.effects)}${s.truncated ? approvalAggregates(s) : reviewTable([...(s.spend ?? []), ...(s.status ?? [])], uiText('Budget, bid and status fields'))}${s.depends_on?.length ? `<small>${esc(uiText('Requires:'))} ${esc(s.depends_on.join(', '))}</small>` : ''}</li>`).join('')}</ol><p>${esc(uiText('Amounts retain their provider field names and units. Inspect all steps and account bindings before approval.'))}</p>${truncated ? `<p class="form-note" id="approval-fields-note">${esc(uiText('Open every “Show all fields” list before approving.'))}</p>` : ''}<label class="form-note"><input id="plan-consent" type="checkbox"> ${esc(uiText('I authorize every step in this exact plan.'))}</label>${spending ? `<label class="form-note"><input id="plan-spend-consent" type="checkbox"> ${esc(uiText('I authorize the budget, bid and serving changes shown above.'))}</label>` : ''}<button id="approve-plan" class="button primary" type="button"${truncated ? ' disabled aria-describedby="approval-fields-note"' : ''}>${esc(uiText('Save plan approval'))}</button>${recordDetails(summary, uiText('Exact plan hash and approval scope'))}</section>`;
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
        toast(errorMessage(error));
      }
    });
}
// All progress actions operate on the original plan, review and key. A run may stop for an additional approval or
// uncertain result; continuing never invents a new key or replays a submitted mutation.
function bindCampaignWorkflow(run, open, current) {
  const id = run.id,
    show = html => {
      if (current()) $('#campaign-review').innerHTML = html;
    };
  const refresh = async out => {
    if (current()) {
      if (await open(id)) $('#campaign-review').innerHTML = campaignOutcome(out);
    }
  };
  workspaceBind('#approve-campaign', async () => {
    const out = await workspaceCall('campaign', {action: 'approve', id});
    if (!current()) return;
    show(approvalView(out.approval));
    bindApprovalFields(id, out.approval);
    workspaceBind('#approve-plan', async () => {
      if (!$('#plan-consent').checked) throw Error(uiText('Review and authorize this complete plan first.'));
      if ($('#approve-plan').disabled) throw Error(uiText('Open every “Show all fields” list before approving.'));
      const spending = approvalSpending(out.approval);
      if (spending && !$('#plan-spend-consent').checked)
        throw Error(uiText('Acknowledge the displayed budget and serving changes.'));
      const approved = await workspaceCall('campaign', {
        action: 'approve',
        id,
        plan_hash: out.approval.plan_hash,
        summary_hash: out.approval.summary_hash,
        confirmed: true,
        ...(spending ? {spend_change_confirmed: true} : {}),
      });
      await refresh(approved);
    });
  });
  workspaceBind('#run-campaign', async () => {
    const out = await workspaceCall('campaign', {action: 'run', id});
    await refresh(out);
  });
  workspaceBind('#amend-campaign', async () => {
    const out = await workspaceCall('campaign', {action: 'prepare_next', id});
    if (!current()) return;
    const call = out.next_call;
    if (call?.arguments?.action !== 'recover_step') {
      show(campaignOutcome(out));
      return;
    }
    const step = run.steps.find(s => s.id === call.arguments.step_id);
    const fields =
      call.choose ??
      reviewFields(step?.arguments).filter(
        f => !f.reference && f.value !== null && ['string', 'number', 'boolean'].includes(typeof f.value),
      );
    show(
      `<section class="panel workspace-form"><h2>${esc(uiText('Amend'))} ${esc(step.id)}</h2><p>${esc(out.recovery ?? out.decision ?? call.correct ?? uiText('Correct the blocked step. It will need a new review.'))}</p><form id="amend-step"><label>${esc(uiText('Field'))}<select name="field">${fields.map((f, i) => `<option value="${i}">${esc(f.path)}</option>`).join('')}</select></label><div id="amend-value"></div><label class="form-note"><input name="confirmed" type="checkbox" required> ${esc(uiText('Save this correction and invalidate the previous plan approval.'))}</label><button type="submit" class="button primary">${esc(uiText('Save amendment'))}</button></form></section>`,
    );
    const form = $('#amend-step');
    const field = () => fields[Number(form.elements.field.value)];
    const edit = () => {
      const f = field(),
        value = f.current ?? f.value;
      $('#amend-value').innerHTML =
        `<p>${esc(uiText('Current value:'))} <code>${esc(reviewValue(value))}</code></p><label>${esc(uiText('Corrected value'))}${f.allowed_values ? `<select name="value">${f.allowed_values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}</select>` : typeof value === 'boolean' ? `<select name="value"><option value="true"${value ? ' selected' : ''}>${esc(uiText('true'))}</option><option value="false"${!value ? ' selected' : ''}>${esc(uiText('false'))}</option></select>` : `<input name="value" type="${typeof value === 'number' ? 'number' : 'text'}" step="any" value="${esc(value)}" required>`}</label>`;
    };
    if (!fields.length) {
      show(campaignOutcome(out));
      return;
    }
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
        expected_revision: out.revision,
        confirmed: form.elements.confirmed.checked,
        patch: [{path: f.path, value}],
      });
      await refresh(result);
    });
  });
  workspaceBind('[data-accept-observed]', async button => {
    const step = run.steps.find(s => s.id === button.dataset.acceptObserved);
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
  });
}
function mountCampaignClone(open) {
  const supported = [
    'google_ads_native_action',
    'snapchat_native_action',
    'tiktok_native_action',
    'linkedin_native_action',
  ];
  const targets = platforms
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
  $('#campaign-clone').innerHTML =
    `<summary>${esc(uiText('Clone an existing campaign'))}</summary><p>${esc(uiText('Supported sources: Google Search, Snapchat, TikTok and LinkedIn campaign groups. The source is read into a draft; review the fields omitted from the clone before approval.'))}</p><form id="clone-form"><label>${esc(uiText('Source account'))}<select name="target" required><option value="">${esc(uiText('Choose an account with write access'))}</option>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label>${controls(uiText('Source campaign or group ID'), 'text', '', 'source')}${controls(uiText('New campaign name'), 'text', '', 'name')}<button type="submit" class="button">${esc(uiText('Read source and create draft'))}</button></form>`;
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
    const out = await workspaceCall('campaign', {
      action: 'clone',
      ...binding,
      source: {campaign_id: form.elements.source.value.trim()},
      name: form.elements.name.value.trim(),
    });
    await open(out.id);
    toast(uiText('Clone saved as a draft. Review omitted fields and approve the exact plan.'));
  });
}
