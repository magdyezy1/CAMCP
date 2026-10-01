'use strict';
function capabilityMatches(workflow, query) {
  const needle = query.trim().toLowerCase();
  return (
    !needle ||
    [workflow.name, uiText(workflow.name), workflow.description, uiText(workflow.description), workflow.objective]
      .join(' ')
      .toLowerCase()
      .includes(needle)
  );
}
function capabilityBlocker(code) {
  const labels = {
    connection_disabled: 'Connection is disabled',
    deployment_writes_disabled: 'Reviewed writes are disabled in this deployment',
    workspace_writes_paused: 'The owner paused provider writes',
    operator_required: 'An operator role is required',
    account_write_grant_required: 'This account needs a write grant',
  };
  if (labels[code]) return uiText(labels[code]);
  if (code.startsWith('provider_scope:')) return uiText('Missing recorded permission: ') + code.slice(15);
  if (code.startsWith('contract:')) return uiText('Unqualified native contract: ') + code.slice(9);
  return pretty(code);
}
function capabilityCard(w) {
  return `<details class="capability-card"><summary><strong>${esc(uiText(w.name))}</strong> · ${esc(pretty(w.objective))}</summary><p>${esc(uiText(w.description))}</p><p class="notice">${esc(uiText(w.effect_details))}</p><h3>${esc(uiText('Before you start'))}</h3><p>${esc(uiText('Required inputs:'))} ${esc(w.required_inputs.join(', '))}</p><ul>${w.dependencies.map(d => `<li>${esc(pretty(d.id))} — ${esc(pretty(d.status))}</li>`).join('')}</ul><h3>${esc(uiText('Selected account readiness'))}</h3>${w.accounts.map(a => `<article class="operation-card"><div class="operation-heading"><h4>${esc(a.label)} · ${esc(a.account_id)}</h4>${badge(a.local_state)}</div><p>${esc(a.blockers.map(capabilityBlocker).join(' · ') || uiText('Local prerequisites available. Native preflight is still required.'))}</p><p>${esc(uiText('Account evidence:'))} ${esc(pretty(a.provider_evidence.status))}${a.provider_evidence.checked_at ? ' · ' + date(a.provider_evidence.checked_at) : ''}</p><p class="form-note">${esc(uiText(a.provider_evidence.meaning))}</p><details><summary>${esc(uiText('Still to verify'))}</summary><ul>${a.unresolved.map(u => `<li>${esc(pretty(u))}</li>`).join('')}</ul></details><a href="/connections" class="button small">${esc(uiText('Manage account access'))}</a>${recordDetails(a.next_call, uiText('Inspect prerequisites in MCP'))}</article>`).join('') || `<p>${esc(uiText('Connect and select a matching account first.'))}</p>`}<h3>${esc(uiText('Workflow stages'))}</h3><ol>${w.lifecycle.map(s => `<li><strong>${esc(pretty(s.stage))}</strong> — ${esc(uiText(s.meaning))}${s.tool ? `<small class="form-note">${esc(s.tool)} · ${esc(s.action)}</small>` : ''}</li>`).join('')}</ol>${w.contracts.length ? `<h3>${esc(uiText('Native contract dependencies'))}</h3>${w.contracts.map(c => `<details><summary><code dir="ltr">${esc(c.action)}</code> · ${badge(c.status)}</summary><p>${esc(uiText('Family:'))} ${esc(c.family ?? uiText('Unqualified'))}</p><p>${esc(uiText('Evidence:'))} ${esc(c.source ?? uiText('Unavailable'))}</p><p>${esc(uiText('Tests:'))} ${esc(c.tests.join(', '))}</p><p>${esc(uiText('Account-specific provider acceptance remains unverified.'))}</p></details>`).join('')}` : ''}<div class="dialog-actions work-actions"><a class="button small" href="${esc(w.website_path)}">${esc(uiText('Open workflow'))}</a><a class="button small" href="/capabilities?workflow_id=${encodeURIComponent(w.id)}">${esc(uiText('Link to this workflow'))}</a></div>${recordDetails(w.next_call, uiText('Continue in MCP'))}</details>`;
}
async function renderCapabilityCenter() {
  const graph = await workspaceCall('workspace', {action: 'capabilities'}),
    params = new URLSearchParams(location.search);
  const targets = [
    ...new Map(graph.workflows.flatMap(w => w.accounts.map(a => [a.connection_id + '\0' + a.account_id, a]))).values(),
  ];
  const selected = targets.findIndex(
    a => a.connection_id === params.get('connection_id') && a.account_id === params.get('account_id'),
  );
  content.innerHTML += `<p class="notice">${esc(uiText(graph.meaning))}</p><section class="panel workspace-form"><h2>${esc(uiText('Find a workflow'))}</h2><form id="capability-filter" class="work-filter"><label>${esc(uiText('Workflow'))}<select name="workflow_id"><option value="">${esc(uiText('All workflows'))}</option>${graph.workflows.map(w => `<option value="${esc(w.id)}" ${w.id === params.get('workflow_id') ? 'selected' : ''}>${esc(uiText(w.name))}</option>`).join('')}</select></label><label>${esc(uiText('Account and login'))}<select name="target"><option value="">${esc(uiText('All selected accounts'))}</option>${targets.map((a, i) => `<option value="${i}" ${i === selected ? 'selected' : ''}>${esc(a.label)} · ${esc(a.account_id)}</option>`).join('')}</select></label><label>${esc(uiText('Search workflows'))}<input name="search" type="search" maxlength="200"></label><button class="button primary" type="submit">${esc(uiText('Check prerequisites'))}</button></form></section><section class="panel" id="capability-results"><p data-page-status role="status">${esc(uiText('Loading workflows…'))}</p></section><section class="panel workspace-form"><h2>${esc(uiText('Action contract reference'))}</h2><form id="contract-filter" class="work-filter"><label>${esc(uiText('Platform'))}<select name="gateway"><option value="">${esc(uiText('All platforms'))}</option>${graph.contracts.map(g => `<option value="${esc(g.gateway)}">${esc(g.gateway.replace('_native_action', ''))}</option>`).join('')}</select></label><label>${esc(uiText('Search action, route or classification'))}<input name="search" type="search" maxlength="200"></label><button type="submit" class="button">${esc(uiText('Search contracts'))}</button></form><div id="contract-results" aria-live="polite"></div></section>`;
  const form = $('#capability-filter');
  if (params.get('workflow_id') && !graph.workflows.some(w => w.id === params.get('workflow_id')))
    form.elements.workflow_id.add(new Option(uiText('Unavailable workflow'), params.get('workflow_id'), true, true));
  if ((params.get('account_id') || params.get('connection_id')) && selected < 0)
    form.elements.target.add(
      new Option(uiText('Previously selected account — check access'), 'unavailable', true, true),
    );
  let filters = {};
  const collect = () => {
    const target = form.elements.target.value === '' ? null : targets[Number(form.elements.target.value)];
    filters = {
      workflow_id: form.elements.workflow_id.value,
      search: form.elements.search.value,
      ...(target ? {connection_id: target.connection_id, account_id: target.account_id} : {}),
      ...(form.elements.target.value === 'unavailable'
        ? {
            ...(params.get('connection_id') ? {connection_id: params.get('connection_id')} : {}),
            ...(params.get('account_id') ? {account_id: params.get('account_id')} : {}),
          }
        : {}),
    };
    const url = new URL(location.href);
    for (const key of ['workflow_id', 'connection_id', 'account_id']) {
      if (filters[key]) url.searchParams.set(key, filters[key]);
      else url.searchParams.delete(key);
    }
    history.replaceState(null, '', url);
  };
  const pager = workPageLoader(
    '#capability-results',
    uiText('Workflow prerequisites'),
    async () => {
      const captured = {...filters};
      const result = await workspaceCall('workspace', {
        action: 'capabilities',
        ...(captured.workflow_id ? {workflow_id: captured.workflow_id} : {}),
        ...(captured.connection_id ? {connection_id: captured.connection_id} : {}),
        ...(captured.account_id ? {account_id: captured.account_id} : {}),
      });
      return {
        ...result,
        workflows: result.workflows.filter(w => capabilityMatches(w, captured.search ?? '')),
      };
    },
    result =>
      result.workflows.map(capabilityCard).join('') || `<p>${esc(uiText('No workflows match these filters.'))}</p>`,
  );
  workspaceBind('#capability-filter', async () => {
    collect();
    await pager.load();
  });
  collect();
  await pager.load();
  const contracts = $('#contract-filter');
  let contractFilters = {};
  const contractPager = workPageLoader(
    '#contract-results',
    uiText('Matching contracts'),
    async offset => {
      const result = await workspaceCall('workspace', {
        action: 'contracts',
        ...contractFilters,
        offset: offset ?? 0,
        limit: 30,
      });
      return {...result, next_offset: result.has_more ? result.offset + result.limit : null};
    },
    result =>
      `<p>${esc(result.meaning)}</p>${result.actions.map(a => `<details><summary><strong>${esc(a.action)}</strong> · ${badge(a.status)}</summary><p>${esc(a.reason)}</p><code dir="ltr">${esc(a.method)} ${esc(a.path)}</code><p>${esc(uiText('Aliases:'))} ${esc(a.aliases.join(', ') || uiText('None'))}</p><p>${esc(uiText('Implementation:'))} ${esc(a.implementation)} ${esc(uiText('· Live qualification:'))} ${esc(a.live_qualification)}</p><p>${esc(uiText('Evidence:'))} ${esc(a.source)}</p><p>${esc(uiText('Tests:'))} ${esc(a.tests.join(', '))}</p></details>`).join('')}`,
  );
  workspaceBind('#contract-filter', async () => {
    contractFilters = {
      search: contracts.elements.search.value,
      ...(contracts.elements.gateway.value ? {gateway: contracts.elements.gateway.value} : {}),
    };
    await contractPager.load();
  });
  await contractPager.load();
}
