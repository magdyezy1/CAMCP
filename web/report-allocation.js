'use strict';
function mountAllocationModel(report) {
  if (!['google_campaign', 'meta_campaign'].includes(report.preset)) return;
  const generation = navigationGeneration,
    identity = identityGeneration;
  $('#report-detail').insertAdjacentHTML(
    'beforeend',
    `<details id="allocation-panel" class="panel workspace-form"><summary>${esc(uiText('Allocate a budget across campaigns'))}</summary><p>${esc(uiText('Compare a constrained allocation using this account’s observed campaign efficiency. Select campaigns and set your own floor and cap for each.'))}</p><p class="notice">${esc(uiText('Amounts are totals for a comparable period with the same duration as {from} — {through}. This model does not change live daily budgets or forecast delivery.', {from: report.semantics.date_from, through: report.semantics.date_to}))}</p><p>${esc(uiText('Account'))} ${esc(report.account_id)} · ${esc(report.semantics.currency)} · ${esc(report.semantics.timezone)}</p><div id="allocation-candidates"></div><form id="allocation-model"><h3>${esc(uiText('Your allocation limits'))}</h3><p id="allocation-selection-count" role="status">${esc(uiText('Select 2–50 campaigns.'))}</p><div id="allocation-selection"></div><div class="recipe-fields"><label>${esc(uiText('Total period budget ({currency})', {currency: report.semantics.currency}))}<input name="budget" inputmode="decimal" required></label><label>${esc(uiText('Minimum observed conversions per campaign'))}<input name="minimum_conversions" type="number" min="1" max="1000000" value="10" step="any" required></label><label>${esc(uiText('Maximum evidence age (days)'))}<input name="maximum_age_days" type="number" min="1" max="90" value="7" required></label><label>${esc(uiText('Low efficiency factor'))}<input name="efficiency_low" type="number" min="0.000001" max="10" step="any" value="0.8" required></label><label>${esc(uiText('High efficiency factor'))}<input name="efficiency_high" type="number" min="0.000001" max="10" step="any" value="1.2" required></label></div><p class="form-note">${esc(uiText('A factor of 1.0 retains observed conversions per unit of spend. Lower or higher factors are assumptions, not confidence intervals. Floors and caps are your planning constraints; provider budget limits and shared-budget ownership require a separate review.'))}</p><button class="button primary" type="submit">${esc(uiText('Model allocation'))}</button></form><div id="allocation-result" aria-live="polite" tabindex="-1"></div></details>`,
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
  let sequence = 0,
    modeled = false;
  const invalidate = () => {
    sequence++;
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
  const drawSelection = () => {
    root.querySelector('#allocation-selection-count').textContent = uiText(
      '{count} selected · choose 2–50 campaigns.',
      {count: uiNumber(selected.size)},
    );
    root.querySelector('#allocation-selection').innerHTML = [...selected.values()]
      .map(
        row =>
          `<article class="branding-preview" data-allocation-campaign="${esc(row.entity_id)}"><h3>${esc(row.name)}</h3><p class="form-note">${esc(uiText('Campaign {id} · Observed spend {spend} {currency} · {conversions} conversions', {id: row.entity_id, spend: row.observed_spend ?? uiText('Unknown'), currency: report.semantics.currency, conversions: row.observed_conversions ?? uiText('Unknown')}))}</p><div class="work-filter"><label>${esc(uiText('Floor for {name} ({id})', {name: row.name, id: row.entity_id}))}<input data-floor inputmode="decimal" value="${esc(row.minimum)}" required></label><label>${esc(uiText('Cap for {name} ({id})', {name: row.name, id: row.entity_id}))}<input data-cap inputmode="decimal" value="${esc(row.maximum)}" required></label><button class="button small" type="button" data-allocation-remove="${esc(row.entity_id)}">${esc(uiText('Remove {name}', {name: row.name}))}</button></div></article>`,
      )
      .join('');
    workspaceBind('#allocation-selection [data-allocation-remove]', button => {
      if (!current()) return;
      captureBounds();
      selected.delete(button.dataset.allocationRemove);
      invalidate();
      drawSelection();
    });
  };
  const pages = workPageLoader(
    '#allocation-candidates',
    uiText('Campaign evidence'),
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
            `<div class="token-row"><div><strong>${esc(row.name)}</strong><small>${esc(row.entity_id)} · ${esc(row.observed_spend ?? uiText('Unknown'))} ${esc(out.currency)} · ${esc(uiText('{count} conversions', {count: row.observed_conversions ?? uiText('Unknown')}))}</small></div><button class="button small" type="button" data-allocation-add="${esc(row.entity_id)}">${esc(uiText('Add {name}', {name: row.name}))}</button></div>`,
        )
        .join('') || blank(uiText('No campaign evidence in this report.')),
    out => {
      if (!current()) return;
      workspaceBind('#allocation-candidates [data-allocation-add]', button => {
        if (!current()) return;
        const row = out.candidates.find(candidate => candidate.entity_id === button.dataset.allocationAdd);
        if (!row || selected.has(row.entity_id)) return;
        if (selected.size >= 50) throw Error(uiText('Model at most 50 campaigns at once.'));
        captureBounds();
        selected.set(row.entity_id, {...row, minimum: '', maximum: ''});
        invalidate();
        drawSelection();
        root.querySelector(`[data-allocation-campaign="${row.entity_id}"] [data-floor]`).focus();
      });
    },
  );
  root.addEventListener('toggle', () => {
    if (root.open) void pages.load();
  });
  workspaceBind('#allocation-model', async () => {
    if (!current()) return;
    captureBounds();
    if (selected.size < 2) throw Error(uiText('Select at least two campaigns and enter their floors and caps.'));
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
    result.innerHTML = `<h3>${esc(uiText('Proposed period allocation'))}</h3><p><strong>${esc(out.total_budget)} ${esc(out.currency)}</strong> ${esc(uiText('across {count} campaigns for a comparable {days}-day period.', {count: uiNumber(out.allocations.length), days: uiNumber(out.period.days)}))}</p><p>${esc(uiText('Modeled conversions under your assumptions: {low}–{high}. The model assigns remaining budget to higher observed efficiency within your caps.', {low: n(out.modeled_conversions_low), high: n(out.modeled_conversions_high)}))}</p><div class="data-scroll" role="region" aria-label="${esc(uiText('Proposed campaign allocation, scroll for all columns'))}" tabindex="0"><table class="review-table"><caption>${esc(uiText('Budget floors, caps and modeled outcomes'))}</caption><thead><tr><th scope="col">${esc(uiText('Campaign'))}</th><th scope="col">${esc(uiText('Observed spend'))}</th><th scope="col">${esc(uiText('Floor / cap'))}</th><th scope="col">${esc(uiText('Proposed budget'))}</th><th scope="col">${esc(uiText('Modeled conversions'))}</th></tr></thead><tbody>${out.allocations.map(row => `<tr><th scope="row">${esc(row.name)}<small>${esc(row.entity_id)}</small></th><td>${esc(row.observed_spend)}</td><td>${esc(row.minimum)} / ${esc(row.maximum)}</td><td>${esc(row.proposed_budget)} ${esc(out.currency)}${row.binding_constraints.length ? `<small>${esc(uiText('At {constraints}', {constraints: row.binding_constraints.map(x => (x === 'cap' ? uiText('cap') : x === 'floor' ? uiText('floor') : x)).join(uiText(' and '))}))}</small>` : ''}</td><td>${n(row.modeled_conversions_low)}–${n(row.modeled_conversions_high)}</td></tr>`).join('')}</tbody></table></div><ul>${out.limitations.map(value => `<li>${esc(uiReportExplanation(value))}</li>`).join('')}</ul><button id="allocation-download" class="button" type="button">${esc(uiText('Download proposal and evidence'))}</button>${recordDetails(out, uiText('Exact assumptions and retained evidence'))}`;
    modeled = true;
    if (report.preset === 'google_campaign' && session.workspaceRole !== 'viewer') {
      result.insertAdjacentHTML(
        'beforeend',
        `<section id="allocation-plan" class="branding-preview"><h3>${esc(uiText('Prepare a native budget draft'))}</h3><p>${esc(uiText('Read current Google campaign budget ownership and convert this proposal into an unapproved plan. Only dedicated daily budgets qualify.'))}</p><label>${esc(uiText('How to convert period totals'))}<select id="allocation-conversion"><option value="">${esc(uiText('Choose explicitly'))}</option><option value="equal_daily">${esc(uiText('Divide equally over {days} days; round down to whole micros', {days: out.period.days}))}</option></select></label><p class="notice">${esc(uiText('Google average daily budgets remain in effect until separately changed. This creates no end date or automatic period spending cap. Native review and spending approval still follow in Campaigns.'))}</p><button class="button" id="allocation-preview-plan" type="button">${esc(uiText('Read budgets & preview conversion'))}</button><div id="allocation-plan-result" aria-live="polite" tabindex="-1"></div></section>`,
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

function allocationPlanPreview(p) {
  return `<h4>${esc(uiText('Current budgets and proposed daily amounts'))}</h4><p>${esc(uiText('Account'))} ${esc(p.account_id)} · ${esc(p.currency)} · ${esc(p.timezone)} · ${esc(uiText('{days} reference days', {days: p.period_days}))}</p><div class="data-scroll" role="region" aria-label="${esc(uiText('Daily budget conversion, scroll for all columns'))}" tabindex="0"><table class="review-table"><caption>${esc(uiText('Exact period-to-daily conversion in {currency}', {currency: p.currency}))}</caption><thead><tr><th scope="col">${esc(uiText('Campaign / budget'))}</th><th scope="col">${esc(uiText('Current daily'))}</th><th scope="col">${esc(uiText('Proposed period total'))}</th><th scope="col">${esc(uiText('Proposed average daily'))}</th><th scope="col">${esc(uiText('Rounding residual'))}</th></tr></thead><tbody>${p.targets.map(t => `<tr><th scope="row">${esc(t.name)}<small>${esc(t.campaign_id)} · ${esc(t.budget_resource)}</small></th><td>${esc(t.current_daily_budget)}</td><td>${esc(t.period_budget)}</td><td>${esc(t.daily_budget)}<small>${esc(uiText('{amount} micros', {amount: t.daily_budget_micros}))}</small></td><td>${esc(t.rounding_residual)}</td></tr>`).join('')}</tbody></table></div><p>${esc(uiReportExplanation(p.meaning))}</p><button class="button primary" id="allocation-create-plan" type="button">${esc(uiText('Create unapproved draft'))}</button>`;
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
          const confirmed = await confirmAction({
            title: uiText('Create an unapproved budget draft?'),
            consequence: uiText(
              'Save {count} Google budget changes for account {account} in {currency}. The daily amounts shown are ongoing budgets; the reference period sets no end date. No advertising change is sent until separate native review and approval.',
              {count: uiNumber(p.targets.length), account: p.account_id, currency: p.currency},
            ),
            confirmLabel: uiText('Create draft'),
          });
          if (!confirmed || !current() || request !== sequence) return;
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
          if (current() && request === sequence) output.textContent = e.message;
        }
      });
    } catch (e) {
      if (current() && request === sequence) output.textContent = e.message;
    }
  });
}
