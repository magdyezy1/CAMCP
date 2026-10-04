'use strict';
function mountAllocationModel(report) {
  if (!['google_campaign', 'meta_campaign', 'linkedin_campaign', 'snapchat_adsquad'].includes(report.preset)) return;
  const squad = report.preset === 'snapchat_adsquad',
    linkedin = report.preset === 'linkedin_campaign';
  const generation = navigationGeneration,
    identity = identityGeneration;
  $('#report-detail').insertAdjacentHTML(
    'beforeend',
    `<details id="allocation-panel" class="panel workspace-form"><summary>${esc(squad ? uiText('Allocate a budget across ad squads') : uiText('Allocate a budget across campaigns'))}</summary><p>${esc(squad ? uiText('Compare a constrained allocation using observed ad-squad efficiency within this parent campaign. Select ad squads and set your own floor and cap for each.') : uiText('Compare a constrained allocation using this account’s observed campaign efficiency. Select campaigns and set your own floor and cap for each.'))}</p><p class="notice">${esc(uiText('Amounts are totals for a comparable period with the same duration as {from} — {through}. This model does not change live daily budgets or forecast delivery.', {from: report.semantics.date_from, through: report.semantics.date_to}))}</p><p>${esc(uiText('Account'))} ${esc(report.account_id)} · ${esc(report.semantics.currency)} · ${esc(report.semantics.timezone)}</p><div id="allocation-candidates"></div><form id="allocation-model"><h3>${esc(uiText('Your allocation limits'))}</h3><p id="allocation-selection-count" role="status">${esc(squad ? uiText('Select 2–50 ad squads.') : linkedin ? uiText('Select 2–20 LinkedIn campaigns.') : uiText('Select 2–50 campaigns.'))}</p><div id="allocation-selection"></div><div class="recipe-fields"><label>${esc(uiText('Total period budget ({currency})', {currency: report.semantics.currency}))}<input name="budget" inputmode="decimal" required></label><label>${esc(squad ? uiText('Minimum observed conversions per ad squad') : uiText('Minimum observed conversions per campaign'))}<input name="minimum_conversions" type="number" min="1" max="1000000" value="10" step="any" required></label><label>${esc(uiText('Maximum evidence age (days)'))}<input name="maximum_age_days" type="number" min="1" max="90" value="7" required></label><label>${esc(uiText('Low efficiency factor'))}<input name="efficiency_low" type="number" min="0.000001" max="10" step="any" value="0.8" required></label><label>${esc(uiText('High efficiency factor'))}<input name="efficiency_high" type="number" min="0.000001" max="10" step="any" value="1.2" required></label></div><p class="form-note">${esc(uiText('A factor of 1.0 retains observed conversions per unit of spend. Lower or higher factors are assumptions, not confidence intervals. Floors and caps are your planning constraints; provider budget limits and shared-budget ownership require a separate review.'))}</p><button class="button primary" type="submit">${esc(uiText('Model allocation'))}</button></form><div id="allocation-result" aria-live="polite" tabindex="-1"></div></details>`,
  );
  const root = $('#allocation-panel'),
    form = $('#allocation-model'),
    result = $('#allocation-result');
  const current = () =>
    generation === navigationGeneration &&
    identity === identityGeneration &&
    root.isConnected &&
    form.isConnected &&
    result.isConnected;
  const selected = new Map();
  const calibration = mountAllocationCalibration(
    report,
    form,
    () => [...selected.keys()],
    current,
    () => invalidate({keepCalibration: true}),
  );
  let sequence = 0,
    modeled = false;
  const invalidate = (event = {}) => {
    sequence++;
    if (event.keepCalibration !== true) calibration.reset();
    if (modeled) {
      result.innerHTML = `<p>${esc(uiText('Inputs changed. Model again to update the proposal.'))}</p>`;
      modeled = false;
    }
  };
  form.addEventListener('input', invalidate);
  form.addEventListener('change', invalidate);
  const captureBounds = () => {
    root.querySelectorAll('[data-allocation-campaign]').forEach(node => {
      const row = selected.get(node.dataset.allocationCampaign);
      if (row) {
        row.minimum = node.querySelector('[data-floor]').value;
        row.maximum = node.querySelector('[data-cap]').value;
      }
    });
  };
  const drawCandidateState = () => {
    root.querySelectorAll('[data-allocation-add]').forEach(button => {
      const added = selected.has(button.dataset.allocationAdd);
      button.disabled = added;
      button.textContent = uiText(added ? 'Added' : 'Add');
      button.setAttribute(
        'aria-label',
        uiText(added ? 'Added {name}' : 'Add {name}', {name: button.dataset.allocationName}),
      );
    });
  };
  const drawSelection = () => {
    root.querySelector('#allocation-selection-count').textContent = uiText(
      squad
        ? '{count} selected · choose 2–50 ad squads.'
        : linkedin
          ? '{count} selected · choose 2–20 LinkedIn campaigns.'
          : '{count} selected · choose 2–50 campaigns.',
      {count: uiNumber(selected.size)},
    );
    root.querySelector('#allocation-selection').innerHTML = [...selected.values()]
      .map(
        row =>
          `<article class="branding-preview" data-allocation-campaign="${esc(row.entity_id)}"><h3>${esc(row.name)}</h3><p class="form-note">${esc(uiText(squad ? 'Ad squad {id} · Observed spend {spend} {currency} · {conversions} conversions' : 'Campaign {id} · Observed spend {spend} {currency} · {conversions} conversions', {id: row.entity_id, spend: row.observed_spend ?? uiText('Unknown'), currency: report.semantics.currency, conversions: row.observed_conversions ?? uiText('Unknown')}))}</p><div class="work-filter"><label>${esc(uiText('Floor for {name} ({id})', {name: row.name, id: row.entity_id}))}<input data-floor inputmode="decimal" value="${esc(row.minimum)}" required></label><label>${esc(uiText('Cap for {name} ({id})', {name: row.name, id: row.entity_id}))}<input data-cap inputmode="decimal" value="${esc(row.maximum)}" required></label><button class="button small" type="button" data-allocation-remove="${esc(row.entity_id)}">${esc(uiText('Remove {name}', {name: row.name}))}</button></div></article>`,
      )
      .join('');
    workspaceBind('#allocation-selection [data-allocation-remove]', button => {
      if (!current()) return;
      captureBounds();
      selected.delete(button.dataset.allocationRemove);
      invalidate();
      drawSelection();
    });
    drawCandidateState();
  };
  const pages = workPageLoader(
    '#allocation-candidates',
    squad ? uiText('Ad-squad evidence') : uiText('Campaign evidence'),
    offset =>
      workspaceCall('reporting', {
        action: 'allocation_candidates',
        id: report.id,
        offset: offset ?? 0,
        limit: 10,
      }),
    out =>
      out.candidates
        .map(
          row =>
            `<div class="token-row"><div><strong>${esc(row.name)}</strong><small>${esc(row.entity_id)} · ${esc(row.observed_spend ?? uiText('Unknown'))} ${esc(out.currency)} · ${esc(uiText('{count} conversions', {count: row.observed_conversions ?? uiText('Unknown')}))}</small></div><button class="button small" type="button" data-allocation-add="${esc(row.entity_id)}" data-allocation-name="${esc(row.name)}" aria-label="${esc(uiText('Add {name}', {name: row.name}))}">${esc(uiText('Add'))}</button></div>`,
        )
        .join('') ||
      blank(squad ? uiText('No ad-squad evidence in this report.') : uiText('No campaign evidence in this report.')),
    out => {
      if (!current()) return;
      workspaceBind(
        '#allocation-candidates [data-allocation-add]',
        button => {
          if (!current()) return;
          const row = out.candidates.find(candidate => candidate.entity_id === button.dataset.allocationAdd);
          if (!row || selected.has(row.entity_id)) return;
          if (selected.size >= (linkedin ? 20 : 50))
            throw Error(
              squad
                ? uiText('Model at most 50 ad squads at once.')
                : linkedin
                  ? uiText('Model at most 20 LinkedIn campaigns at once.')
                  : uiText('Model at most 50 campaigns at once.'),
            );
          captureBounds();
          selected.set(row.entity_id, {...row, minimum: '', maximum: ''});
          invalidate();
          drawSelection();
          root.querySelector(`[data-allocation-campaign="${row.entity_id}"] [data-floor]`).focus();
        },
        {disabled: button => selected.has(button.dataset.allocationAdd)},
      );
      drawCandidateState();
    },
  );
  root.addEventListener('toggle', () => {
    if (root.open) void pages.load();
  });
  workspaceBind('#allocation-model', async () => {
    if (!current()) return;
    captureBounds();
    if (selected.size < 2)
      throw Error(
        squad
          ? uiText('Select at least two ad squads and enter their floors and caps.')
          : uiText('Select at least two campaigns and enter their floors and caps.'),
      );
    const request = ++sequence;
    const options = {
      budget: form.elements.budget.value.trim(),
      allocations: [...selected.values()].map(row => ({
        entity_id: row.entity_id,
        minimum: row.minimum.trim(),
        maximum: row.maximum.trim(),
      })),
      ...Object.fromEntries(
        ['minimum_conversions', 'maximum_age_days', 'efficiency_low', 'efficiency_high'].map(key => [
          key,
          Number(form.elements[key].value),
        ]),
      ),
    };
    let out;
    try {
      out = await workspaceCall('reporting', {
        action: 'allocation',
        id: report.id,
        options,
      });
    } catch (error) {
      if (current() && request === sequence) throw error;
      return;
    }
    if (!current() || request !== sequence) return;
    const n = value => esc(uiNumber(value, {maximumFractionDigits: 2}));
    result.innerHTML = `<h3>${esc(uiText('Proposed period allocation'))}</h3><p><strong>${esc(out.total_budget)} ${esc(out.currency)}</strong> ${esc(uiText(squad ? 'across {count} ad squads for a comparable {days}-day period.' : 'across {count} campaigns for a comparable {days}-day period.', {count: uiNumber(out.allocations.length), days: uiNumber(out.period.days)}))}</p><p>${esc(uiText('Modeled conversions under your assumptions: {low}–{high}. The model assigns remaining budget to higher observed efficiency within your caps.', {low: n(out.modeled_conversions_low), high: n(out.modeled_conversions_high)}))}</p><div class="data-scroll" role="region" aria-label="${esc(uiText(squad ? 'Proposed ad-squad allocation, scroll for all columns' : 'Proposed campaign allocation, scroll for all columns'))}" tabindex="0"><table class="review-table"><caption>${esc(uiText('Budget floors, caps and modeled outcomes'))}</caption><thead><tr><th scope="col">${esc(uiText(squad ? 'Ad squad' : 'Campaign'))}</th><th scope="col">${esc(uiText('Observed spend'))}</th><th scope="col">${esc(uiText('Floor / cap'))}</th><th scope="col">${esc(uiText('Proposed budget'))}</th><th scope="col">${esc(uiText('Modeled conversions'))}</th></tr></thead><tbody>${out.allocations.map(row => `<tr><th scope="row">${esc(row.name)}<small>${esc(row.entity_id)}</small></th><td>${esc(row.observed_spend)}</td><td>${esc(row.minimum)} / ${esc(row.maximum)}</td><td>${esc(row.proposed_budget)} ${esc(out.currency)}${row.binding_constraints.length ? `<small>${esc(uiText('At {constraints}', {constraints: row.binding_constraints.map(x => (x === 'cap' ? uiText('cap') : x === 'floor' ? uiText('floor') : x)).join(uiText(' and '))}))}</small>` : ''}</td><td>${n(row.modeled_conversions_low)}–${n(row.modeled_conversions_high)}</td></tr>`).join('')}</tbody></table></div><ul>${out.limitations.map(value => `<li>${esc(uiReportExplanation(value))}</li>`).join('')}</ul><button id="allocation-download" class="button" type="button">${esc(uiText('Download proposal and evidence'))}</button>${recordDetails(out, uiText('Exact assumptions and retained evidence'))}`;
    modeled = true;
    if (
      ['google_campaign', 'linkedin_campaign', 'snapchat_adsquad'].includes(report.preset) &&
      session.workspaceRole !== 'viewer'
    ) {
      result.insertAdjacentHTML(
        'beforeend',
        `<section id="allocation-plan" class="branding-preview"><h3>${esc(uiText('Prepare a native budget draft'))}</h3><p>${esc(squad ? uiText('Read current Snapchat ad-squad budgets and parent ownership, then convert this proposal into an unapproved plan. Only auction campaigns with ad-squad pacing and explicit daily budgets qualify.') : linkedin ? uiText('Read current LinkedIn account, campaign and campaign-group budgets. Only independent campaign daily budgets in the verified UTC account qualify; shared, lifetime and accelerated budgets need a separate planning flow.') : uiText('Read current Google campaign budget ownership and convert this proposal into an unapproved plan. Only dedicated daily budgets qualify.'))}</p><label for="allocation-conversion">${esc(uiText('How to convert period totals'))}</label><select id="allocation-conversion"><option value="">${esc(uiText('Choose explicitly'))}</option><option value="equal_daily">${esc(uiText(linkedin ? 'Divide equally over {days} days; retain six decimal places in account currency' : 'Divide equally over {days} days; round down to whole micros', {days: out.period.days}))}</option></select><p class="notice">${esc(squad ? uiText('Snapchat daily budgets remain in effect until separately changed. This draft creates no end date or automatic period spending cap. Native review and any required spending approval still follow in Campaigns.') : linkedin ? uiText('LinkedIn daily settings remain in effect until changed and can spend up to 150% of the daily amount on a day with strong auction opportunities. Group total caps are preserved. This draft sets no end date or automatic period cap. Review and spending approval still follow in Campaigns.') : uiText('Google average daily budgets remain in effect until separately changed. This creates no end date or automatic period spending cap. Native review and spending approval still follow in Campaigns.'))}</p><button class="button" id="allocation-preview-plan" type="button">${esc(uiText('Read budgets & preview conversion'))}</button><div id="allocation-plan-result" aria-live="polite" tabindex="-1"></div></section>`,
      );
      bindAllocationPlan(report, options, out, () => current() && request === sequence);
    }
    workspaceBind('#allocation-download', () => {
      if (!current() || request !== sequence) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], {type: 'application/json'})),
        link = document.createElement('a');
      link.href = url;
      link.download = 'AMCP-allocation-proposal.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    result.focus();
  });
}

function renderAllocationCalibration(out) {
  const value = v => (v === null || v === undefined ? esc(uiText('Unknown')) : `<bdi dir="ltr">${esc(v)}</bdi>`);
  return `<h3>${esc(uiText('Historical efficiency calibration'))}</h3><p>${esc(uiText('Account'))} ${esc(out.account_id)} · ${esc(out.currency)} · ${esc(out.semantics.timezone)}</p><p class="notice">${esc(uiText('These are one-day historical estimates conditioned on actual test-day spend. They do not forecast future delivery or the effect of changing budgets.'))}</p><p>${esc(uiText('{training} preceding training days · requested central share {share}% · {from} — {through}', {training: uiNumber(out.training_days), share: uiNumber(out.central_share_percent), from: out.period.test_date_from, through: out.period.date_to}))}</p><div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Historical errors and factors, scroll for all columns'))}"><table class="review-table"><caption>${esc(uiText('Observed errors and empirical efficiency factors'))}</caption><thead><tr><th scope="col">${esc(uiText('Entity'))}</th><th scope="col">${esc(uiText('Known / unknown ratio days'))}</th><th scope="col">${esc(uiText('Mean absolute error (conversions)'))}</th><th scope="col">${esc(uiText('Mean error (observed minus estimate)'))}</th><th scope="col">${esc(uiText('Low / high historical factor'))}</th></tr></thead><tbody>${out.entities.map(row => `<tr><th scope="row">${esc(row.name)}<small>${esc(row.entity_id)}</small></th><td>${esc(uiNumber(row.known_ratio_days))} / ${esc(uiNumber(row.unknown_ratio_days))}<small>${esc(uiText('{inside} of {count} known ratios inside the empirical band', {inside: row.observed_inside_band === null ? uiText('Unknown') : uiNumber(row.observed_inside_band), count: uiNumber(row.observed_band_denominator)}))}</small></td><td>${value(row.mean_absolute_error)}</td><td>${value(row.mean_error)}</td><td>${value(row.efficiency_low)} / ${value(row.efficiency_high)}<small>${esc(uiReportExplanation(row.meaning))}</small></td></tr>`).join('')}</tbody></table></div><p>${esc(uiText('Envelope across the selected entities: {low}–{high}', {low: out.factor_envelope.efficiency_low ?? uiText('Unknown'), high: out.factor_envelope.efficiency_high ?? uiText('Unknown')}))}</p><ul>${out.limitations.map(message => `<li>${esc(uiReportExplanation(message))}</li>`).join('')}</ul>${recordDetails(out, uiText('Exact test dates, estimates and source evidence'))}`;
}
function mountAllocationCalibration(report, form, selectedIds, parentCurrent, invalidateModel) {
  form.insertAdjacentHTML(
    'beforebegin',
    `<section id="allocation-calibration" class="branding-preview"><h3>${esc(uiText('Check your efficiency assumptions against history'))}</h3><p>${esc(uiText('Select up to 20 entities from this report. Calibration requires an explicit daily spend and conversion row for each selected entity over 14–31 closed days; missing days are not filled with zero.'))}</p><div class="recipe-fields"><label for="calibration-training-days">${esc(uiText('Preceding training days'))}<input id="calibration-training-days" type="number" min="7" max="21" step="1" value="7"></label><label for="calibration-minimum-conversions">${esc(uiText('Minimum training conversions'))}<input id="calibration-minimum-conversions" type="number" min="1" max="1000000" step="1" value="10"></label><label for="calibration-central-share">${esc(uiText('Central share of historical ratios'))}<select id="calibration-central-share"><option value="50">${esc(uiText('50% of observed ratios'))}</option><option value="60">${esc(uiText('60% of observed ratios'))}</option><option value="70">${esc(uiText('70% of observed ratios'))}</option><option value="80" selected>${esc(uiText('80% of observed ratios'))}</option><option value="90">${esc(uiText('90% of observed ratios'))}</option></select></label></div><p class="form-note">${esc(uiText('The central share describes this history. It is not a confidence level. The evidence age below also applies to calibration.'))}</p><button id="allocation-calibrate" class="button" type="button">${esc(uiText('Evaluate historical efficiency'))}</button><div id="allocation-calibration-result" aria-live="polite" tabindex="-1"></div></section>`,
  );
  const root = $('#allocation-calibration'),
    output = $('#allocation-calibration-result');
  const current = () => parentCurrent() && root.isConnected && output.isConnected;
  let sequence = 0,
    evaluated = false;
  const reset = () => {
    sequence++;
    if (evaluated) output.innerHTML = `<p>${esc(uiText('Selection or settings changed. Evaluate history again.'))}</p>`;
    evaluated = false;
  };
  const input = () => ({
    action: 'calibrate_allocation',
    id: report.id,
    ids: selectedIds(),
    options: {
      training_days: Number($('#calibration-training-days').value),
      minimum_training_conversions: Number($('#calibration-minimum-conversions').value),
      central_share_percent: Number($('#calibration-central-share').value),
      maximum_age_days: Number(form.elements.maximum_age_days.value),
    },
  });
  root.addEventListener('input', reset);
  root.addEventListener('change', reset);
  workspaceBind('#allocation-calibrate', async () => {
    if (!current()) return;
    const args = input(),
      request = ++sequence,
      original = JSON.stringify(args);
    if (!args.ids.length || args.ids.length > 20)
      throw Error(uiText('Select 1–20 original report entities before evaluating history.'));
    evaluated = false;
    output.innerHTML = `<p role="status">${esc(uiText('Evaluating historical efficiency…'))}</p>`;
    const active = () => current() && sequence === request && JSON.stringify(input()) === original;
    try {
      const out = await workspaceCall('reporting', args);
      if (!active()) return;
      let applied = false;
      const factors = out.factor_envelope,
        applicable =
          factors.applicable === true &&
          Number(factors.efficiency_low) > 0 &&
          Number(factors.efficiency_high) >= Number(factors.efficiency_low) &&
          Number(factors.efficiency_high) <= 10;
      output.innerHTML =
        renderAllocationCalibration(out) +
        `<button id="allocation-use-calibration" class="button" type="button" ${applicable ? '' : 'disabled'}>${esc(uiText('Use these historical factors'))}</button>`;
      evaluated = true;
      workspaceBind(
        '#allocation-use-calibration',
        () => {
          if (!active() || !applicable || applied) return;
          applied = true;
          form.elements.efficiency_low.value = String(factors.efficiency_low);
          form.elements.efficiency_high.value = String(factors.efficiency_high);
          invalidateModel();
          output.insertAdjacentHTML(
            'beforeend',
            `<p class="notice">${esc(uiText('Historical factors applied to this form. Review them and model again; native approval still follows separately.'))}</p>`,
          );
          output.focus();
        },
        {disabled: () => !applicable || applied},
      );
      output.focus();
    } catch (error) {
      if (!active()) return;
      output.innerHTML = `<p class="notice">${esc(uiReportExplanation(error.message))}</p>${error.requestId ? `<code>${esc(error.requestId)}</code>` : ''}`;
      evaluated = true;
      output.focus();
    }
  });
  return {reset};
}

function allocationPlanPreview(p) {
  const squad = p.gateway === 'snapchat_native_action',
    linkedin = p.gateway === 'linkedin_native_action';
  return `<h4>${esc(uiText('Current budgets and proposed daily amounts'))}</h4><p>${esc(uiText('Account'))} ${esc(p.account_id)} · ${esc(p.currency)} · ${esc(p.timezone)} · ${esc(uiText('{days} reference days', {days: p.period_days}))}</p><div class="data-scroll" role="region" aria-label="${esc(uiText('Daily budget conversion, scroll for all columns'))}" tabindex="0"><table class="review-table"><caption>${esc(uiText('Exact period-to-daily conversion in {currency}', {currency: p.currency}))}</caption><thead><tr><th scope="col">${esc(squad ? uiText('Ad squad / parent campaign') : linkedin ? uiText('Campaign / campaign group') : uiText('Campaign / budget'))}</th><th scope="col">${esc(uiText('Current daily'))}</th><th scope="col">${esc(uiText('Proposed period total'))}</th><th scope="col">${esc(uiText(squad || linkedin ? 'Proposed daily budget' : 'Proposed average daily'))}</th><th scope="col">${esc(uiText('Rounding residual'))}</th></tr></thead><tbody>${p.targets.map(t => `<tr><th scope="row">${esc(t.name)}<small>${esc(t.entity_id ?? t.campaign_id)} · ${esc(linkedin ? t.parent?.id : t.budget_resource)}</small></th><td>${esc(t.current_daily_budget)}</td><td>${esc(t.period_budget)}</td><td>${esc(t.daily_budget)}<small>${esc(linkedin ? uiText('Native decimal amount') : uiText('{amount} micros', {amount: t.daily_budget_micros}))}</small></td><td>${esc(t.rounding_residual)}</td></tr>`).join('')}</tbody></table></div><p>${esc(uiReportExplanation(p.meaning))}</p>${squad || linkedin ? recordDetails({source_references: p.native_source_references}, uiText('Native budget ownership evidence')) : ''}<button class="button primary" id="allocation-create-plan" type="button">${esc(uiText('Create unapproved draft'))}</button>`;
}

function bindAllocationPlan(report, options, modeled, current) {
  const output = $('#allocation-plan-result');
  let sequence = 0;
  $('#allocation-conversion').addEventListener('change', () => {
    sequence++;
    if (current())
      output.innerHTML = `<p>${esc(uiText('Conversion changed. Preview again before creating a draft.'))}</p>`;
  });
  workspaceBind('#allocation-preview-plan', async () => {
    if (!current()) return;
    const request = ++sequence;
    try {
      if ($('#allocation-conversion').value !== 'equal_daily')
        throw Error(uiText('Choose the period-to-daily conversion before reading budgets.'));
      output.textContent = uiText('Reading current budget ownership…');
      const p = await workspaceCall('reporting', {
        action: 'preview_allocation_plan',
        id: report.id,
        options,
        conversion: 'equal_daily',
      });
      if (!current() || request !== sequence) return;
      if (p.model_fingerprint !== modeled.model_fingerprint)
        throw Error(uiText('The allocation evidence changed. Model again before creating a draft.'));
      output.innerHTML = allocationPlanPreview(p);
      output.focus();
      workspaceBind('#allocation-create-plan', async () => {
        if (!current() || request !== sequence) return;
        try {
          const unexpired = () => {
            if (Number.isFinite(p.expires_at) && p.expires_at <= Date.now())
              throw Error(uiText('The budget preview expired. Read current budgets and preview again.'));
          };
          unexpired();
          const confirmed = await confirmAction({
            title: uiText('Create an unapproved budget draft?'),
            consequence: uiText(
              report.preset === 'snapchat_adsquad'
                ? 'Save {count} Snapchat ad-squad budget changes for account {account} in {currency}. The daily amounts shown are ongoing budgets; the reference period sets no end date. No advertising change is sent until separate native review and approval.'
                : report.preset === 'linkedin_campaign'
                  ? 'Save {count} LinkedIn campaign daily-budget changes for account {account} in {currency}. Native amounts are decimals in account currency. Group caps and campaign statuses stay unchanged. The reference period sets no end date or automatic spending cap. Separate native review and spending approval are required.'
                  : 'Save {count} Google budget changes for account {account} in {currency}. The daily amounts shown are ongoing budgets; the reference period sets no end date. No advertising change is sent until separate native review and approval.',
              {count: uiNumber(p.targets.length), account: p.account_id, currency: p.currency},
            ),
            confirmLabel: uiText('Create draft'),
          });
          if (!confirmed || !current() || request !== sequence) return;
          unexpired();
          const created = await workspaceCall('reporting', {
            action: 'create_allocation_plan',
            id: report.id,
            preview_id: p.preview_id,
            preview_hash: p.preview_hash,
            confirmed: true,
          });
          if (!current() || request !== sequence) return;
          output.innerHTML = `<p>${esc(uiText('Draft saved. Review its native changes in Campaigns before approving.'))}</p><a class="button primary" href="/campaigns?id=${encodeURIComponent(created.id)}">${esc(uiText('Open original draft'))}</a>`;
          output.focus();
        } catch (e) {
          if (current() && request === sequence) output.textContent = uiReportExplanation(e.message);
        }
      });
    } catch (e) {
      if (current() && request === sequence) output.textContent = uiReportExplanation(e.message);
    }
  });
}
