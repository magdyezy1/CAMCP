'use strict';

// A readable projection of the frozen server review. Units and identifiers remain native: a budget in micros is
// never relabelled as currency without a provider's currency/unit contract. The complete review stays available.
function reviewFields(value, path = '', out = []) {
  if (out.length >= 160) return out;
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, '$ref')) {
    out.push({path, value: 'Verified dependency: ' + value.$ref, reference: true});
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (out.length >= 160) break;
      reviewFields(child, path + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1'), out);
    }
  } else out.push({path, value});
  return out;
}
const reviewValue = value => (value === null ? 'Not supplied' : String(value ?? ''));
function reviewTable(value, caption) {
  const fields = reviewFields(value);
  return fields.length
    ? `<div class="data-scroll" role="region" aria-label="${esc(caption)}" tabindex="0"><table class="review-table"><caption>${esc(caption)}</caption><thead><tr><th scope="col">Field / native unit</th><th scope="col">Value</th></tr></thead><tbody>${fields.map(f => `<tr><th scope="row"><code dir="ltr">${esc(f.path || 'value')}</code></th><td dir="auto">${esc(reviewValue(f.value))}</td></tr>`).join('')}</tbody></table></div>${fields.length === 160 ? '<p class="form-note">Summary limited to 160 fields. Inspect the complete request below before approving.</p>' : ''}`
    : blank('No values supplied.');
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
      if (!$('#' + reviewConsentIds[key])?.checked) throw Error(reviewConsentLabels[key]);
      return [key, true];
    }),
  );
}
function readableReview(review, buttonLabel) {
  const request = review.request ?? {},
    needs = review.execute_requirements ?? {};
  return `<section class="panel workspace-form review-panel"><div class="panel-header"><h2>Review this change</h2>${badge('awaiting_review')}</div><p>Expires ${date(review.expires_at)}. Approval applies to this frozen request only.</p>${reviewTable(request, 'Request to submit — exact native fields')}${review.creative_impact ? reviewTable(review.creative_impact, 'Creative impact') : ''}${review.spend_policy ? reviewTable(review.spend_policy, 'Spending-policy effects') : ''}${review.before_state ? `<details><summary>Current state read from the provider</summary>${reviewTable(review.before_state, 'Observed before preparation')}</details>` : ''}${needs.reasons ? reviewTable(needs.reasons, 'Why acknowledgement is required') : ''}${recordDetails(review, 'Complete request, state, prerequisites and evidence')}<fieldset class="review-consents"><legend>Authorize this request</legend>${requiredReviewConsents(
    review,
  )
    .map(
      key =>
        `<label class="form-note"><input id="${reviewConsentIds[key]}" type="checkbox"> ${esc(reviewConsentLabels[key])}</label>`,
    )
    .join(
      '',
    )}</fieldset><button id="execute-reviewed" type="button" class="button primary">${esc(buttonLabel)}</button></section>`;
}
function campaignJournal(run) {
  return `<h2 tabindex="-1">${esc(run.name)}</h2><p>${esc(run.brief)}</p><div class="work-summary">${badge(run.state)}<span>Revision ${esc(run.revision)}</span><a href="/campaigns?id=${encodeURIComponent(run.id)}">Link to this plan</a></div><ol class="campaign-steps">${run.steps.map(s => `<li><div><strong>${esc(s.description ?? s.id)}</strong><small>${esc(s.gateway ?? s.arguments?.platform)} · ${esc(s.account_id)}</small><small>Depends on: ${esc(s.depends_on?.join(', ') || 'No predecessor')}</small></div>${badge(s.status)}${s.error ? `<p class="error">${esc(s.error.message)}</p>${recordDetails(s.error, 'Error and remedy')}` : ''}${s.verification ? `${verificationComparison(s.verification)}${recordDetails(s.verification, 'Read-back evidence')}` : ''}${s.review_id ? `<small>Original review: <code dir="ltr">${esc(s.review_id)}</code></small>` : ''}</li>`).join('')}</ol>${run.clone ? reviewTable(run.clone.not_copied ?? [], 'Source fields not copied') : ''}${recordDetails({plan_hash: run.plan_hash, profile_id: run.profile_id, profile_revision: run.profile_revision, recipe: run.recipe, clone: run.clone, execution_journal: run.execution_journal}, 'Plan provenance and execution journal')}`;
}
function verificationComparison(verification) {
  const checks = (verification.checks ?? []).flatMap(check =>
    check.diff?.length ? check.diff.map(diff => ({...diff, status: check.status})) : [check],
  );
  return checks.length
    ? `<div class="data-scroll" role="region" aria-label="Read-back comparison" tabindex="0"><table class="review-table"><caption>Read-back comparison</caption><thead><tr><th>Check</th><th>Expected</th><th>Observed</th><th>Result</th></tr></thead><tbody>${checks.map(c => `<tr><th scope="row">${esc(c.field ?? c.name ?? c.path ?? c.id ?? (c.changed_fields ?? []).join(', '))}</th><td>${esc(JSON.stringify(c.expected ?? c.expected_value ?? null))}</td><td>${esc(JSON.stringify(c.actual ?? c.actual_value ?? c.observed ?? null))}</td><td>${badge(c.status ?? (c.matches === true ? 'verified' : 'unknown'))}</td></tr>`).join('')}</tbody></table></div>`
    : '';
}
function campaignOutcome(out) {
  const reason = out.run?.reason ?? out.recovery ?? out.decision ?? out.run?.stopped ?? out.state ?? 'Saved';
  return `<div class="notice" role="status"><p>${esc(reason)}</p></div>${recordDetails(out, 'Result, receipts and next safe action')}`;
}
function approvalView(summary) {
  const spending = summary.steps.some(s => s.spend?.length || s.status?.length);
  return `<section class="panel workspace-form"><h2>Approve this complete plan</h2><p>${esc(summary.covers)}</p><ol class="campaign-steps">${summary.steps.map(s => `<li><strong>${esc(s.id)} · ${esc(s.action)}</strong><small>${esc(s.gateway)} · Account ${esc(s.account_id)}</small>${reviewTable([...(s.spend ?? []), ...(s.status ?? [])], 'Budget, bid and status fields')}${s.depends_on?.length ? `<small>Requires: ${esc(s.depends_on.join(', '))}</small>` : ''}</li>`).join('')}</ol><p>Amounts retain their provider field names and units. Inspect all steps and account bindings before approval.</p><label class="form-note"><input id="plan-consent" type="checkbox"> I authorize every step in this exact plan.</label>${spending ? '<label class="form-note"><input id="plan-spend-consent" type="checkbox"> I authorize the budget, bid and serving changes shown above.</label>' : ''}<button id="approve-plan" class="button primary" type="button">Save plan approval</button>${recordDetails(summary, 'Exact plan hash and approval scope')}</section>`;
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
      if (!$('#plan-consent').checked) throw Error('Review and authorize this complete plan first.');
      const spending = out.approval.steps.some(s => s.spend?.length || s.status?.length);
      if (spending && !$('#plan-spend-consent').checked)
        throw Error('Acknowledge the displayed budget and serving changes.');
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
      `<section class="panel workspace-form"><h2>Amend ${esc(step.id)}</h2><p>${esc(out.recovery ?? out.decision ?? call.correct ?? 'Correct the blocked step. It will need a new review.')}</p><form id="amend-step"><label>Field<select name="field">${fields.map((f, i) => `<option value="${i}">${esc(f.path)}</option>`).join('')}</select></label><div id="amend-value"></div><label class="form-note"><input name="confirmed" type="checkbox" required> Save this correction and invalidate the previous plan approval.</label><button type="submit" class="button primary">Save amendment</button></form></section>`,
    );
    const form = $('#amend-step');
    const field = () => fields[Number(form.elements.field.value)];
    const edit = () => {
      const f = field(),
        value = f.current ?? f.value;
      $('#amend-value').innerHTML =
        `<p>Current value: <code>${esc(reviewValue(value))}</code></p><label>Corrected value${f.allowed_values ? `<select name="value">${f.allowed_values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}</select>` : typeof value === 'boolean' ? `<select name="value"><option value="true"${value ? ' selected' : ''}>true</option><option value="false"${!value ? ' selected' : ''}>false</option></select>` : `<input name="value" type="${typeof value === 'number' ? 'number' : 'text'}" step="any" value="${esc(value)}" required>`}</label>`;
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
    if (!step?.verification?.actual_hash) throw Error('Read back this step before accepting observed values.');
    show(
      `<section class="panel workspace-form"><h2>Accept observed values for ${esc(step.id)}</h2><p>This records your acceptance of the values read back from the provider. Dependent steps may then proceed.</p>${verificationComparison(step.verification)}${recordDetails(step.verification, 'Complete comparison')}<label class="form-note"><input id="observed-consent" type="checkbox"> I accept these exact observed values as the result of this step.</label><button id="accept-observed" class="button primary">Record acceptance</button></section>`,
    );
    workspaceBind('#accept-observed', async () => {
      if (!$('#observed-consent').checked) throw Error('Review and accept the displayed provider values first.');
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
    `<summary>Clone an existing campaign</summary><p>Supported sources: Google Search, Snapchat, TikTok and LinkedIn campaign groups. The source is read into a draft; review the fields omitted from the clone before approval.</p><form id="clone-form"><label>Source account<select name="target" required><option value="">Choose an account with write access</option>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label>${controls('Source campaign or group ID', 'text', '', 'source')}${controls('New campaign name', 'text', '', 'name')}<button type="submit" class="button">Read source and create draft</button></form>`;
  workspaceBind('#clone-form', async form => {
    const target = targets[Number(form.elements.target.value)];
    if (
      form.elements.target.value === '' ||
      !target ||
      !form.elements.source.value.trim() ||
      !form.elements.name.value.trim()
    )
      throw Error('Choose the source account, ID and new campaign name.');
    const {label, ...binding} = target;
    const out = await workspaceCall('campaign', {
      action: 'clone',
      ...binding,
      source: {campaign_id: form.elements.source.value.trim()},
      name: form.elements.name.value.trim(),
    });
    await open(out.id);
    toast('Clone saved as a draft. Review omitted fields and approve the exact plan.');
  });
}
