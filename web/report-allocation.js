'use strict';
function mountAllocationModel(report) {
  if (!['google_campaign', 'meta_campaign'].includes(report.preset)) return;
  const generation = navigationGeneration,
    identity = identityGeneration;
  $('#report-detail').insertAdjacentHTML(
    'beforeend',
    `<details id="allocation-panel" class="panel workspace-form"><summary>Allocate a budget across campaigns</summary><p>Compare a constrained allocation using this account’s observed campaign efficiency. Select campaigns and set your own floor and cap for each.</p><p class="notice">Amounts are totals for a comparable period with the same duration as ${esc(report.semantics.date_from)} — ${esc(report.semantics.date_to)}. This model does not change live daily budgets or forecast delivery.</p><p>Account ${esc(report.account_id)} · ${esc(report.semantics.currency)} · ${esc(report.semantics.timezone)}</p><div id="allocation-candidates"></div><form id="allocation-model"><h3>Your allocation limits</h3><p id="allocation-selection-count" role="status">Select 2–50 campaigns.</p><div id="allocation-selection"></div><div class="recipe-fields"><label>Total period budget (${esc(report.semantics.currency)})<input name="budget" inputmode="decimal" required></label><label>Minimum observed conversions per campaign<input name="minimum_conversions" type="number" min="1" max="1000000" value="10" step="any" required></label><label>Maximum evidence age (days)<input name="maximum_age_days" type="number" min="1" max="90" value="7" required></label><label>Low efficiency factor<input name="efficiency_low" type="number" min="0.000001" max="10" step="any" value="0.8" required></label><label>High efficiency factor<input name="efficiency_high" type="number" min="0.000001" max="10" step="any" value="1.2" required></label></div><p class="form-note">A factor of 1.0 retains observed conversions per unit of spend. Lower or higher factors are assumptions, not confidence intervals. Floors and caps are your planning constraints; provider budget limits and shared-budget ownership require a separate review.</p><button class="button primary" type="submit">Model allocation</button></form><div id="allocation-result" aria-live="polite" tabindex="-1"></div></details>`,
  );
  const root = $('#allocation-panel'),
    form = $('#allocation-model'),
    result = $('#allocation-result');
  const current = () => generation === navigationGeneration && identity === identityGeneration && root.isConnected;
  const selected = new Map();
  let sequence = 0,
    modeled = false;
  const invalidate = () => {
    sequence++;
    if (modeled) {
      result.innerHTML = '<p>Inputs changed. Model again to update the proposal.</p>';
      modeled = false;
    }
  };
  form.addEventListener('input', invalidate);
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
    root.querySelector('#allocation-selection-count').textContent =
      selected.size + ' selected · choose 2–50 campaigns.';
    root.querySelector('#allocation-selection').innerHTML = [...selected.values()]
      .map(
        row =>
          `<article class="branding-preview" data-allocation-campaign="${esc(row.entity_id)}"><h3>${esc(row.name)}</h3><p class="form-note">Campaign ${esc(row.entity_id)} · Observed spend ${esc(row.observed_spend ?? 'Unknown')} ${esc(report.semantics.currency)} · ${esc(row.observed_conversions ?? 'Unknown')} conversions</p><div class="work-filter"><label>Floor for ${esc(row.name)} (${esc(row.entity_id)})<input data-floor inputmode="decimal" value="${esc(row.minimum)}" required></label><label>Cap for ${esc(row.name)} (${esc(row.entity_id)})<input data-cap inputmode="decimal" value="${esc(row.maximum)}" required></label><button class="button small" type="button" data-allocation-remove="${esc(row.entity_id)}">Remove ${esc(row.name)}</button></div></article>`,
      )
      .join('');
    workspaceBind('#allocation-selection [data-allocation-remove]', button => {
      captureBounds();
      selected.delete(button.dataset.allocationRemove);
      invalidate();
      drawSelection();
    });
  };
  const pages = workPageLoader(
    '#allocation-candidates',
    'Campaign evidence',
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
            `<div class="token-row"><div><strong>${esc(row.name)}</strong><small>${esc(row.entity_id)} · ${esc(row.observed_spend ?? 'Unknown')} ${esc(out.currency)} · ${esc(row.observed_conversions ?? 'Unknown')} conversions</small></div><button class="button small" type="button" data-allocation-add="${esc(row.entity_id)}">Add ${esc(row.name)}</button></div>`,
        )
        .join('') || blank('No campaign evidence in this report.'),
    out => {
      if (!current()) return;
      workspaceBind('#allocation-candidates [data-allocation-add]', button => {
        const row = out.candidates.find(candidate => candidate.entity_id === button.dataset.allocationAdd);
        if (!row || selected.has(row.entity_id)) return;
        if (selected.size >= 50) throw Error('Model at most 50 campaigns at once.');
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
    captureBounds();
    if (selected.size < 2) throw Error('Select at least two campaigns and enter their floors and caps.');
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
    const out = await workspaceCall('reporting', {
      action: 'allocation',
      id: report.id,
      options,
    });
    if (!current() || request !== sequence) return;
    const n = value => Number(value).toLocaleString(undefined, {maximumFractionDigits: 2});
    result.innerHTML = `<h3>Proposed period allocation</h3><p><strong>${esc(out.total_budget)} ${esc(out.currency)}</strong> across ${out.allocations.length} campaigns for a comparable ${out.period.days}-day period.</p><p>Modeled conversions under your assumptions: ${n(out.modeled_conversions_low)}–${n(out.modeled_conversions_high)}. The model assigns remaining budget to higher observed efficiency within your caps.</p><div class="data-scroll" role="region" aria-label="Proposed campaign allocation, scroll for all columns" tabindex="0"><table class="review-table"><caption>Budget floors, caps and modeled outcomes</caption><thead><tr><th scope="col">Campaign</th><th scope="col">Observed spend</th><th scope="col">Floor / cap</th><th scope="col">Proposed budget</th><th scope="col">Modeled conversions</th></tr></thead><tbody>${out.allocations.map(row => `<tr><th scope="row">${esc(row.name)}<small>${esc(row.entity_id)}</small></th><td>${esc(row.observed_spend)}</td><td>${esc(row.minimum)} / ${esc(row.maximum)}</td><td>${esc(row.proposed_budget)} ${esc(out.currency)}${row.binding_constraints.length ? '<small>At ' + row.binding_constraints.map(esc).join(' and ') + '</small>' : ''}</td><td>${n(row.modeled_conversions_low)}–${n(row.modeled_conversions_high)}</td></tr>`).join('')}</tbody></table></div><ul>${out.limitations.map(value => `<li>${esc(value)}</li>`).join('')}</ul><button id="allocation-download" class="button" type="button">Download proposal and evidence</button>${recordDetails(out, 'Exact assumptions and retained evidence')}`;
    modeled = true;
    if (report.preset === 'google_campaign' && session.workspaceRole !== 'viewer') {
      result.insertAdjacentHTML(
        'beforeend',
        `<section id="allocation-plan" class="branding-preview"><h3>Prepare a native budget draft</h3><p>Read current Google campaign budget ownership and convert this proposal into an unapproved plan. Only dedicated daily budgets qualify.</p><label>How to convert period totals<select id="allocation-conversion"><option value="">Choose explicitly</option><option value="equal_daily">Divide equally over ${esc(out.period.days)} days; round down to whole micros</option></select></label><p class="notice">Google average daily budgets remain in effect until separately changed. This creates no end date or automatic period spending cap. Native review and spending approval still follow in Campaigns.</p><button class="button" id="allocation-preview-plan" type="button">Read budgets & preview conversion</button><div id="allocation-plan-result" aria-live="polite" tabindex="-1"></div></section>`,
      );
      bindAllocationPlan(report, options, out, () => current() && request === sequence);
    }
    workspaceBind('#allocation-download', () => {
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
  return `<h4>Current budgets and proposed daily amounts</h4><p>Account ${esc(p.account_id)} · ${esc(p.currency)} · ${esc(p.timezone)} · ${p.period_days} reference days</p><div class="data-scroll" role="region" aria-label="Daily budget conversion, scroll for all columns" tabindex="0"><table class="review-table"><caption>Exact period-to-daily conversion in ${esc(p.currency)}</caption><thead><tr><th scope="col">Campaign / budget</th><th scope="col">Current daily</th><th scope="col">Proposed period total</th><th scope="col">Proposed average daily</th><th scope="col">Rounding residual</th></tr></thead><tbody>${p.targets.map(t => `<tr><th scope="row">${esc(t.name)}<small>${esc(t.campaign_id)} · ${esc(t.budget_resource)}</small></th><td>${esc(t.current_daily_budget)}</td><td>${esc(t.period_budget)}</td><td>${esc(t.daily_budget)}<small>${esc(t.daily_budget_micros)} micros</small></td><td>${esc(t.rounding_residual)}</td></tr>`).join('')}</tbody></table></div><p>${esc(p.meaning)}</p><button class="button primary" id="allocation-create-plan" type="button">Create unapproved draft</button>`;
}

function bindAllocationPlan(report, options, modeled, current) {
  const output = $('#allocation-plan-result');
  let sequence = 0;
  $('#allocation-conversion').addEventListener('change', () => {
    sequence++;
    if (current()) output.innerHTML = '<p>Conversion changed. Preview again before creating a draft.</p>';
  });
  workspaceBind('#allocation-preview-plan', async () => {
    if (!current()) return;
    const request = ++sequence;
    try {
      if ($('#allocation-conversion').value !== 'equal_daily')
        throw Error('Choose the period-to-daily conversion before reading budgets.');
      output.textContent = 'Reading current budget ownership…';
      const p = await workspaceCall('reporting', {
        action: 'preview_allocation_plan',
        id: report.id,
        options,
        conversion: 'equal_daily',
      });
      if (!current() || request !== sequence) return;
      if (p.model_fingerprint !== modeled.model_fingerprint)
        throw Error('The allocation evidence changed. Model again before creating a draft.');
      output.innerHTML = allocationPlanPreview(p);
      output.focus();
      workspaceBind('#allocation-create-plan', async () => {
        if (!current() || request !== sequence) return;
        try {
          const confirmed = await confirmAction({
            title: 'Create an unapproved budget draft?',
            consequence:
              'Save ' +
              p.targets.length +
              ' Google budget changes for account ' +
              p.account_id +
              ' in ' +
              p.currency +
              '. The daily amounts shown are ongoing budgets; the reference period sets no end date. No advertising change is sent until separate native review and approval.',
            confirmLabel: 'Create draft',
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
          output.innerHTML = `<p>Draft saved. Review its native changes in Campaigns before approving.</p><a class="button primary" href="/campaigns?id=${encodeURIComponent(created.id)}">Open original draft</a>`;
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
