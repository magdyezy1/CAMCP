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
function readableReview(review, buttonLabel) {
  const request = review.request ?? {},
    needs = review.execute_requirements ?? {};
  return `<section class="panel workspace-form review-panel"><div class="panel-header"><h2>${esc(uiText('Review this change'))}</h2>${badge('awaiting_review')}</div><p>${esc(uiText('Expires'))} ${date(review.expires_at)}${esc(uiText('. Approval applies to this frozen request only.'))}</p>${reviewTable(request, uiText('Request to submit — exact native fields'))}${review.creative_impact ? reviewTable(review.creative_impact, uiText('Creative impact')) : ''}${review.spend_policy ? reviewTable(review.spend_policy, uiText('Spending-policy effects')) : ''}${review.before_state ? `<details><summary>${esc(uiText('Current state read from the provider'))}</summary>${reviewTable(review.before_state, uiText('Observed before preparation'))}</details>` : ''}${needs.reasons ? reviewTable(needs.reasons, uiText('Why acknowledgement is required')) : ''}${recordDetails(review, uiText('Complete request, state, prerequisites and evidence'))}<fieldset class="review-consents"><legend>${esc(uiText('Authorize this request'))}</legend>${requiredReviewConsents(
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
  if (!a || !Object.hasOwn(campaignProviderNames, a.gateway)) return null;
  const snap = a.gateway === 'snapchat_native_action';
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
        !allocationAmountMatches(t.daily_budget, t.daily_budget_micros),
    )
  )
    return null;
  return {allocation: a, snap};
}
function allocationProposalView(context) {
  if (!context) return '';
  const {allocation: a, snap} = context;
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
    snap ? allocationReviewLabels.currentDaily : allocationReviewLabels.currentAverage,
    snap ? allocationReviewLabels.proposedDaily : allocationReviewLabels.proposedAverage,
    allocationReviewLabels.micros,
    allocationReviewLabels.periodBudget,
  ];
  return `<section class="allocation-proposal" aria-label="${esc(uiText('Retained budget proposal'))}"><h3>${esc(uiText('Retained budget proposal'))}</h3><p class="form-note">${esc(uiText('These are the saved preview amounts. Current provider settings must be checked again before review and execution.'))}</p><dl>${fields.map(([label, value]) => `<div><dt>${esc(uiText(label))}</dt><dd>${value}</dd></div>`).join('')}</dl><div class="data-scroll" role="region" aria-label="${esc(caption)}" tabindex="0"><table class="review-table"><caption>${esc(caption)}</caption><thead><tr>${headers.map(label => `<th scope="col">${esc(uiText(label))}</th>`).join('')}</tr></thead><tbody>${a.targets
    .map(t => {
      const id = snap ? t.entity_id : t.campaign_id;
      const name =
        t.name && t.name !== id
          ? `<bdi dir="auto">${esc(t.name)}</bdi><small>${campaignNativeValue(id)}</small>`
          : campaignNativeValue(id);
      return `<tr><th scope="row">${name}</th><td>${campaignNativeValue(t.current_daily_budget)} ${campaignNativeValue(a.currency)}</td><td>${campaignNativeValue(t.daily_budget)} ${campaignNativeValue(a.currency)}</td><td>${campaignNativeValue(t.daily_budget_micros)}</td><td>${campaignNativeValue(t.period_budget)} ${campaignNativeValue(a.currency)}</td></tr>`;
    })
    .join(
      '',
    )}</tbody></table></div><p class="form-note">${esc(uiText(snap ? 'Daily budgets remain in effect until separately changed; this proposal sets no end date or period spending cap.' : 'Average daily budgets remain in effect until separately changed; this proposal sets no end date or period spending cap.'))} <a href="/reports?id=${encodeURIComponent(a.report_id)}">${esc(uiText('Inspect original report'))}</a></p></section>`;
}
function allocationStepDescription(step, context) {
  if (!context || step.kind !== 'write') return null;
  const {allocation: a, snap} = context,
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
      ['action', 'path_params', 'payload'].filter(key => snap || key !== 'path_params'),
    )
  )
    return null;
  const target = a.targets.find(t => {
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
  return `${esc(uiText(snap ? 'Ad squad' : 'Campaign'))} ${campaignNativeValue(snap ? target.entity_id : target.campaign_id)}: ${esc(uiText(snap ? 'Proposed daily budget' : 'Proposed average daily budget'))} ${campaignNativeValue(target.daily_budget)} ${campaignNativeValue(a.currency)}`;
}
function campaignJournal(run) {
  const context = allocationReviewContext(run);
  const originalBrief = `<p><bdi dir="auto">${esc(run.brief)}</bdi></p>`;
  const recipeBrief = ['snapchat_website_traffic', 'snapchat_lead_generation'].includes(run.recipe?.id)
    ? `<p class="notice">${esc(uiText('This saved Snapchat workflow uses an existing creative. Inspect the native steps and original brief; each change requires review and activation is separate.'))}</p><details><summary>${esc(uiText('Original plan brief'))}</summary>${originalBrief}</details>`
    : originalBrief;
  return `<h2 tabindex="-1"><bdi dir="auto">${esc(run.name)}</bdi></h2><div class="work-summary">${badge(run.state)}<span>${esc(uiText('Revision'))} ${campaignNativeValue(run.revision)}</span><a href="/campaigns?id=${encodeURIComponent(run.id)}">${esc(uiText('Link to this plan'))}</a></div>${context ? allocationProposalView(context) + `<details><summary>${esc(uiText('Original plan brief'))}</summary>${originalBrief}</details>` : recipeBrief}<ol class="campaign-steps">${run.steps
    .map(s => {
      const description = allocationStepDescription(s, context);
      return `<li><div><strong>${description ?? `<bdi dir="auto">${esc(s.description ?? s.id)}</bdi>`}</strong><small>${campaignNativeValue(campaignProviderNames[s.gateway] ?? s.gateway ?? s.arguments?.platform)} · ${campaignNativeValue(s.account_id)}</small><small>${esc(uiText('Depends on:'))} ${esc(s.depends_on?.join(', ') || uiText('No predecessor'))}</small>${description ? `<details><summary>${esc(uiText('Original step description'))}</summary><p><bdi dir="auto">${esc(s.description ?? s.id)}</bdi></p></details>` : ''}</div>${badge(s.status)}${s.error ? `<p class="error">${esc(s.error.message)}</p>${recordDetails(s.error, uiText('Error and remedy'))}` : ''}${s.verification ? `${verificationComparison(s.verification)}${recordDetails(s.verification, uiText('Read-back evidence'))}` : ''}${s.review_id ? `<small>${esc(uiText('Original review:'))} <code dir="ltr">${esc(s.review_id)}</code></small>` : ''}</li>`;
    })
    .join(
      '',
    )}</ol>${run.clone ? reviewTable(run.clone.not_copied ?? [], uiText('Source fields not copied')) : ''}${run.allocation && !context ? `<p class="notice">${esc(uiText('This budget plan came from a retained allocation.'))} <a href="/reports?id=${encodeURIComponent(run.allocation.report_id)}">${esc(uiText('Inspect original report'))}</a>${esc(uiText('. Daily budgets remain in effect until separately changed; the reference period sets no end date.'))}</p>` : ''}${recordDetails({allocation: run.allocation, plan_hash: run.plan_hash, profile_id: run.profile_id, profile_revision: run.profile_revision, recipe: run.recipe, clone: run.clone, execution_journal: run.execution_journal}, uiText('Plan provenance and execution journal'))}`;
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
function approvalView(summary) {
  const spending = summary.steps.some(s => s.spend?.length || s.status?.length);
  return `<section class="panel workspace-form"><h2>${esc(uiText('Approve this complete plan'))}</h2><p>${esc(summary.covers)}</p><ol class="campaign-steps">${summary.steps.map(s => `<li><strong>${esc(s.id)} · ${esc(s.action)}</strong><small>${esc(s.gateway)} ${esc(uiText('· Account'))} ${esc(s.account_id)}</small>${reviewTable([...(s.spend ?? []), ...(s.status ?? [])], uiText('Budget, bid and status fields'))}${s.depends_on?.length ? `<small>${esc(uiText('Requires:'))} ${esc(s.depends_on.join(', '))}</small>` : ''}</li>`).join('')}</ol><p>${esc(uiText('Amounts retain their provider field names and units. Inspect all steps and account bindings before approval.'))}</p><label class="form-note"><input id="plan-consent" type="checkbox"> ${esc(uiText('I authorize every step in this exact plan.'))}</label>${spending ? `<label class="form-note"><input id="plan-spend-consent" type="checkbox"> ${esc(uiText('I authorize the budget, bid and serving changes shown above.'))}</label>` : ''}<button id="approve-plan" class="button primary" type="button">${esc(uiText('Save plan approval'))}</button>${recordDetails(summary, uiText('Exact plan hash and approval scope'))}</section>`;
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
    workspaceBind('#approve-plan', async () => {
      if (!$('#plan-consent').checked) throw Error(uiText('Review and authorize this complete plan first.'));
      const spending = out.approval.steps.some(s => s.spend?.length || s.status?.length);
      if (spending && !$('#plan-spend-consent').checked)
        throw Error(uiText('Acknowledge the displayed budget and serving changes.'));
      const approved = await workspaceCall('campaign', {
        action: 'approve',
        id,
        plan_hash: out.approval.plan_hash,
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
