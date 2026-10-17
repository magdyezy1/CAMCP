'use strict';
// WEB-07: the Measurement page (/measurement): Tag Manager audits and consent, GA4 configuration, Google goals, the
// evidence ledger, event identity and trace import. Loaded with web/account-workflows.js, web/campaign-workflows.js
// (its review table) and web/measurement-trace-import.js.
const gtmFindingLabels = {
  MERGE_CONFLICT: 'Merge conflict',
  DUPLICATE_NAME: 'Duplicate name',
  UNRESOLVED_FOLDER: 'Unresolved parent folder',
  UNRESOLVED_VARIABLE: 'Unresolved variable reference',
  UNRESOLVED_OR_SYSTEM_TRIGGER: 'Unresolved or system trigger',
  NO_FIRING_TRIGGER: 'No explicit firing trigger',
  NO_LIVE_VERSION: 'No live version',
  NO_LATEST_VERSION: 'No latest version',
  VERSION_CHANGED_DURING_AUDIT: 'Version changed during audit',
  CONSENT_CONFIGURATION_UNINTERPRETABLE: 'Unrecognized consent configuration',
};
const gtmEntityLabels = {
  tag: 'Tag',
  trigger: 'Trigger',
  variable: 'Variable',
  folder: 'Folder',
  customTemplate: 'Custom template',
  client: 'Client',
  transformation: 'Transformation',
  zone: 'Zone',
  gtagConfig: 'Google tag configuration',
  builtInVariable: 'Built-in variable',
};
function uiGtmFindingLabel(code) {
  return Object.hasOwn(gtmFindingLabels, code) ? uiText(gtmFindingLabels[code]) : String(code ?? '');
}
function uiGtmFindingSeverity(value) {
  switch (value) {
    case 'error':
      return uiText('Error');
    case 'warning':
      return uiText('Warning');
    case 'unknown':
      return uiText('Unknown');
    default:
      return String(value ?? '');
  }
}
function uiGtmFindingMessage(finding) {
  const message = String(finding.message ?? ''),
    meta = finding.message_localization;
  if (uiLocale !== 'ar' || !meta || typeof meta !== 'object' || Array.isArray(meta))
    return uiAccountExplanation(message);
  if (
    meta.key === 'duplicate_name' &&
    finding.code === 'DUPLICATE_NAME' &&
    typeof meta.kind === 'string' &&
    Object.hasOwn(gtmEntityLabels, meta.kind) &&
    message === 'Another ' + meta.kind + ' has this same name; choose IDs explicitly.'
  )
    return uiText('Another {kind} has this same name; choose IDs explicitly.', {
      kind: uiText(gtmEntityLabels[meta.kind]),
    });
  if (
    meta.key === 'unresolved_trigger' &&
    finding.code === 'UNRESOLVED_OR_SYSTEM_TRIGGER' &&
    typeof meta.trigger_id === 'string' &&
    /^[A-Za-z0-9_-]+$/.test(meta.trigger_id) &&
    message ===
      'Trigger ' +
        meta.trigger_id +
        ' is not in the workspace inventory; resolve whether it is provider-managed or missing before publishing.'
  )
    return uiText(
      'Trigger {id} is not in the workspace inventory; resolve whether it is provider-managed or missing before publishing.',
      {id: meta.trigger_id},
    );
  if (meta.key === 'missing_version') {
    if (
      meta.version === 'live' &&
      finding.code === 'NO_LIVE_VERSION' &&
      message === 'No live version was returned (scoped 404).'
    )
      return uiText('No live version was returned (scoped 404).');
    if (
      meta.version === 'latest' &&
      finding.code === 'NO_LATEST_VERSION' &&
      message === 'No latest version was returned (scoped 404).'
    )
      return uiText('No latest version was returned (scoped 404).');
  }
  return uiAccountExplanation(message);
}
function measurementReadFeedback(form) {
  const generation = navigationGeneration,
    identity = identityGeneration,
    button = form.querySelector('button[type=submit]'),
    id = form.id + '-feedback';
  button.id = form.id + '-submit';
  button.insertAdjacentHTML(
    'beforebegin',
    '<div class="measurement-read-feedback" id="' +
      id +
      '" role="alert" aria-atomic="true" hidden><strong>' +
      esc(uiText('Read needs attention')) +
      '</strong><p id="' +
      id +
      '-message"></p><p>' +
      esc(uiText('Review the message and your settings before reading again.')) +
      '</p></div>',
  );
  const region = $('#' + id),
    message = $('#' + id + '-message'),
    connected = () =>
      generation === navigationGeneration && identity === identityGeneration && form.isConnected && region.isConnected;
  const describe = include => {
    for (const control of [form, button]) {
      const ids = (control.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean),
        remaining = ids.filter(value => value !== id);
      if (include) remaining.push(id);
      if (remaining.length) control.setAttribute('aria-describedby', remaining.join(' '));
      else control.removeAttribute('aria-describedby');
    }
  };
  const clear = () => {
    if (!connected()) return;
    region.hidden = true;
    message.textContent = '';
    describe(false);
  };
  form.addEventListener('input', clear);
  form.addEventListener('change', clear);
  return {
    clear,
    show(error) {
      if (!connected()) return;
      // WEB-03: the message, what to do, the provider's facts and the reference each on their own line.
      const text = errorLines(error);
      if (!text) return;
      message.textContent = text;
      describe(true);
      region.hidden = false;
    },
  };
}
function measurementSectionHeading(id, label) {
  return (
    '<div class="measurement-section-heading"><h2 id="' +
    esc(id) +
    '" tabindex="-1">' +
    esc(label) +
    '</h2><a class="measurement-task-return" id="' +
    esc(id) +
    '-return" href="#measurement-task-heading">' +
    esc(uiText('Back to measurement tasks')) +
    '</a></div>'
  );
}
function measurementTaskNavigationMarkup() {
  const tasks = [
    ['ledger', uiText('Measurement evidence ledger')],
    ['gtm', uiText('Google Tag Manager configuration audit')],
    ['events', uiText('Recent GA4 events')],
    ['identity', uiText('Inspect a specific GA4 test identifier')],
    ['ga4config', uiText('GA4 property configuration')],
    ['conversions', uiText('LinkedIn conversion settings')],
    ['goals', uiText('Google Ads conversion goals')],
    ['trace', uiText('Inspect a sanitized event trace')],
  ];
  return (
    '<nav id="measurement-task-navigation" class="measurement-task-navigation" aria-labelledby="measurement-task-heading" aria-describedby="measurement-task-help">' +
    '<h3 id="measurement-task-heading" tabindex="-1">' +
    esc(uiText('Choose a measurement task')) +
    '</h3><p class="form-note" id="measurement-task-help">' +
    esc(uiText('Jump between sections without changing your entries. Reads start only when you submit a form.')) +
    '</p><ul class="measurement-task-links">' +
    tasks
      .map(
        ([id, label]) =>
          '<li><a id="measurement-task-link-' +
          id +
          '" href="#measurement-section-' +
          id +
          '">' +
          esc(label) +
          '</a></li>',
      )
      .join('') +
    '</ul></nav>'
  );
}
function bindMeasurementTaskNavigation() {
  const navigation = $('#measurement-task-navigation'),
    generation = navigationGeneration,
    identity = identityGeneration,
    sections = ['ledger', 'gtm', 'events', 'identity', 'ga4config', 'conversions', 'goals', 'trace'],
    headingIds = ['measurement-task-heading', ...sections.map(id => 'measurement-section-' + id)];
  const attached = () =>
    generation === navigationGeneration && identity === identityGeneration && navigation.isConnected;
  const focusHeading = id => {
    if (!attached() || !headingIds.includes(id)) return false;
    const heading = $('#' + id);
    if (!heading || !heading.isConnected) return false;
    heading.setAttribute('tabindex', '-1');
    heading.focus({preventScroll: true});
    heading.scrollIntoView({block: 'start'});
    return true;
  };
  const links = sections.flatMap(id => [
    ['measurement-task-link-' + id, 'measurement-section-' + id],
    ['measurement-section-' + id + '-return', 'measurement-task-heading'],
  ]);
  for (const [linkId, headingId] of links) {
    const link = $('#' + linkId);
    link.addEventListener('click', event => {
      if (
        !attached() ||
        !link.isConnected ||
        event.currentTarget !== link ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey ||
        link.getAttribute('download') !== null ||
        link.getAttribute('target') ||
        link.getAttribute('href') !== '#' + headingId
      )
        return;
      if (focusHeading(headingId)) event.preventDefault();
    });
  }
  const fragment = typeof location === 'undefined' ? '' : location.hash;
  const headingId = headingIds.find(id => fragment === '#' + id);
  if (headingId) focusHeading(headingId);
}
async function renderMeasurement() {
  const targets = accountChoices(['gtm']),
    eventTargets = accountChoices(['ga4']),
    conversionTargets = accountChoices(['linkedin']),
    goalTargets = accountChoices(['google']),
    hubTargets = accountChoices(['meta', 'snapchat', 'tiktok', 'gsc', 'adjust']),
    // One ledger picker: Google Ads accounts first, then GA4 properties (the scope bar relies on this order), then the
    // providers owner direction P8 added (MSR-03).
    ledgerTargets = Object.assign(
      [
        ...goalTargets.map(t => ({...t, gateway: 'google_ads_native_action'})),
        ...eventTargets.map(t => ({...t, gateway: 'ga4_native_action'})),
        ...hubTargets,
      ],
      // What the working client hid of any of them (SEC-08), for the empty picker's notice.
      {
        hiddenByClient:
          (goalTargets.hiddenByClient ?? 0) + (eventTargets.hiddenByClient ?? 0) + (hubTargets.hiddenByClient ?? 0),
      },
    ),
    scopeSets = {gtm: targets, ga4: eventTargets, google: goalTargets, linkedin: conversionTargets};
  content.innerHTML += `<section class="panel"><h2>${esc(uiText('Measurement evidence'))}</h2><p>${esc(uiText('Review configured tags, trigger dependencies, workspace conflicts and published-version consistency. Configuration evidence is distinct from observed event delivery and attribution.'))}</p>${measurementTaskNavigationMarkup()}<details class="workspace-details"><summary>${esc(uiText('Related measurement workflows'))}</summary><div class="work-links"><a href="/reporting-overview"><strong>${esc(uiText('GA4 and Search Console context'))}</strong><small>${esc(uiText('Collect measurement reports with source definitions.'))}</small></a><a href="/profiles"><strong>${esc(uiText('Client conversion mappings'))}</strong><small>${esc(uiText('Inspect approved conversion definitions and account bindings.'))}</small></a><a href="/capabilities"><strong>${esc(uiText('Reviewed measurement changes'))}</strong><small>${esc(uiText('Discover exact conversion and tag contracts.'))}</small></a></div></details></section>${measurementScopeMarkup(scopeSets)}${measurementLedgerMarkup(ledgerTargets)}<section class="panel workspace-form">${measurementSectionHeading('measurement-section-gtm', uiText('Google Tag Manager configuration audit'))}<p>${esc(uiText('Read the configured tags, triggers, conflicts and published version of one account, container or workspace. Leave the container empty to list containers, or the workspace empty to list workspaces.'))}</p><form id="measurement-audit">${measurementTargetField(targets, uiText('Tag Manager account'), 'Connect Google Tag Manager and select an account in Connections to audit its configuration.')}${controls(uiText('Container ID (optional for account inventory)'), 'text', '', 'container_id')}${controls(uiText('Workspace ID (optional)'), 'text', '', 'workspace_id')}<button class="button primary" type="submit" ${targets.length ? '' : 'disabled'}>${esc(uiText('Read configuration evidence'))}</button></form><div id="measurement-result"></div></section>`;
  content.innerHTML += measurementEventsMarkup(eventTargets);
  content.innerHTML += measurementEventIdentityMarkup(eventTargets);
  content.innerHTML += measurementGa4ConfigMarkup(eventTargets);
  content.innerHTML += measurementConversionsMarkup(conversionTargets);
  content.innerHTML += measurementGoogleGoalsMarkup(goalTargets);
  content.innerHTML += measurementTraceMarkup(eventTargets);
  const form = $('#measurement-audit'),
    result = $('#measurement-result'),
    begin = accountWorkflowContext(form, result);
  // The shared scope fills each task first; an explicit handoff link for one task then takes precedence (MSR-02).
  bindMeasurementScope(scopeSets);
  prefillMeasurementAudit(form, result, targets);
  workspaceBind('#measurement-audit', async form => {
    const current = begin();
    if (!current()) return;
    const t = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !t) throw Error(uiText('Choose a Tag Manager account.'));
    const requirements = Object.fromEntries(
      ['container_id', 'workspace_id']
        .filter(k => form.elements[k].value.trim())
        .map(k => [k, form.elements[k].value.trim()]),
    );
    let out;
    try {
      out = await workspaceCall('workspace', {
        action: 'measurement_audit',
        connection_id: t.connection_id,
        account_id: t.account_id,
        requirements,
      });
    } catch (error) {
      if (current()) throw error;
      return;
    }
    if (!current()) return;
    const c = out.configuration,
      findings = Array.isArray(c.findings) ? c.findings.slice(0, 1000) : [],
      discovery = gtmDiscoveryRows(c, t, requirements);
    result.innerHTML = `<p class="notice">${esc(uiAccountExplanation(out.meaning))}</p>${badge(c.complete ? 'complete' : 'incomplete')}${gtmDiscoveryMarkup(discovery)}<h3>${esc(uiText('Configuration findings'))}</h3>${gtmFindingsMarkup(c, findings)}${c.limitations?.length ? `<section><h3>${esc(uiText('Observation limits'))}</h3><ul>${c.limitations.map(value => `<li>${esc(uiAccountExplanation(value))}</li>`).join('')}</ul></section>` : ''}<div id="gtm-consent-evidence"></div><div id="gtm-consent-diff"></div><div id="gtm-consent-draft"></div>${reviewTable(c.versions ?? {}, uiText('Published version evidence'))}${recordDetails(c, uiText('Audit scope, limits and native evidence'))}`;
    mountGtmDiscovery(discovery, form, current);
    mountGtmFindings(findings, current);
    mountGtmConsentEvidence(c.consent_evidence, current);
    mountGtmConsentDiff(c.consent_diff, c.live_consent_evidence, current);
    mountGtmConsentDraft(c.consent_evidence, out.scope, current);
  });
  bindMeasurementEvents(eventTargets);
  bindMeasurementEventIdentity(eventTargets);
  bindMeasurementGa4Config(eventTargets);
  bindMeasurementConversions(conversionTargets);
  bindMeasurementGoogleGoals(goalTargets);
  bindMeasurementLedger(ledgerTargets);
  bindMeasurementTrace(eventTargets);
  bindMeasurementTaskNavigation();
}
// An explicitly supplied, sanitized trace is browser-local evidence. It never upgrades a native read,
// configuration audit or aggregate count into runtime acceptance and never sends a measurement event.
// Version 2 (MSR-03) adds region-specific defaults for a declared visitor region, wait_for_update_ms and the merge of
// undeclared types; version 1 keeps its original model. The SHA-256 of an empty transaction ID is always flagged.
const measurementTraceEmptyKey = 'opaque-e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  measurementTraceRegion = v => typeof v === 'string' && /^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/.test(v);
function measurementTraceInspect(text, target, streams) {
  const fail = message => {
      throw Error(message);
    },
    object = v => v !== null && typeof v === 'object' && !Array.isArray(v),
    exact = (v, keys, required) =>
      object(v) && Object.keys(v).every(k => keys.includes(k)) && required.every(k => Object.hasOwn(v, k)),
    numeric = v => typeof v === 'string' && /^[1-9][0-9]{0,19}$/.test(v),
    consentTypes = ['analytics_storage', 'ad_storage', 'ad_user_data', 'ad_personalization'];
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 131072)
    fail(uiText('Use a sanitized trace of at most 128 KiB.'));
  // Bound nesting before parsing and reject duplicate keys, including escaped spelling aliases.
  // JSON.parse alone would silently discard conflicting scope or consent declarations.
  const stack = [];
  for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^{}\[\],:\s]+/g)) {
    const token = match[0],
      top = stack.at(-1);
    if (token === '{' || token === '[') {
      stack.push({object: token === '{', keys: new Set(), key: token === '{'});
      if (stack.length > 6) fail(uiText('The sanitized trace is nested too deeply.'));
    } else if (token === '}' || token === ']') stack.pop();
    else if (token === ',' && top?.object) top.key = true;
    else if (token.startsWith('"') && top?.object && top.key) {
      let key;
      try {
        key = JSON.parse(token);
      } catch {
        fail(uiText('Use valid JSON for the sanitized trace.'));
      }
      if (top.keys.has(key)) fail(uiText('Duplicate trace fields cannot establish unambiguous evidence.'));
      top.keys.add(key);
      top.key = false;
    }
  }
  let trace;
  try {
    trace = JSON.parse(text);
  } catch {
    fail(uiText('Use valid JSON for the sanitized trace.'));
  }
  const scopeKeys =
    trace?.version === 2
      ? ['property_id', 'stream_id', 'test_id', 'visitor_region']
      : ['property_id', 'stream_id', 'test_id'];
  if (
    !exact(trace, ['version', 'scope', 'coverage', 'steps'], ['version', 'scope', 'coverage', 'steps']) ||
    ![1, 2].includes(trace.version) ||
    !exact(trace.scope, scopeKeys, scopeKeys) ||
    (trace.version === 2 &&
      trace.scope.visitor_region !== null &&
      !measurementTraceRegion(trace.scope.visitor_region)) ||
    !numeric(trace.scope.property_id) ||
    !numeric(trace.scope.stream_id) ||
    trace.scope.property_id !== target?.account_id ||
    typeof trace.scope.test_id !== 'string' ||
    !/^amcp-test-[A-Za-z0-9-]{8,64}$/.test(trace.scope.test_id) ||
    !['complete', 'partial'].includes(trace.coverage) ||
    !Array.isArray(trace.steps) ||
    trace.steps.length < 1 ||
    trace.steps.length > 1000
  )
    fail(
      trace?.version === 2
        ? uiText(
            'Use trace version 2 with the selected GA4 property, an exact stream, a synthetic test identifier, a visitor region code or null, and 1–1000 steps.',
          )
        : uiText(
            'Use trace version 1, the selected GA4 property, an exact stream, a synthetic test identifier and 1–1000 steps.',
          ),
    );
  const v2 = trace.version === 2,
    visitor = v2 ? trace.scope.visitor_region : null;
  let consent = Object.fromEntries(consentTypes.map(k => [k, 'unknown'])),
    previous = -1,
    defaults = 0;
  const transactions = new Map(),
    rows = [],
    findings = [];
  const finding = (code, step) => {
    if (!findings.some(f => f.code === code && f.step === step)) findings.push({code, step});
  };
  // Version 2 consent state: applicable defaults by specificity, the latest update per type, types whose default
  // arrived after an update (ordering not established) and types still waiting for an update.
  const applied = [],
    updated = new Map(),
    ambiguous = new Set(),
    waiting = new Map();
  const applies = regions => {
    if (!regions) return {applies: true, level: 0};
    const levels = regions.map(r => (r.includes('-') ? 2 : 1));
    if (visitor === null) return {applies: 'maybe', level: Math.max(...levels)};
    const matches = regions
      .map((r, i) => (r === visitor || visitor.startsWith(r + '-') ? levels[i] : 0))
      .filter(level => level > 0);
    return matches.length ? {applies: true, level: Math.max(...matches)} : {applies: false, level: 0};
  };
  const defaultValue = type => {
    const declaring = applied.filter(d => Object.hasOwn(d.consent, type));
    if (!declaring.length) return 'unknown';
    // An undeclared visitor region leaves a regional default's applicability open: only agreeing values survive.
    const level = visitor === null ? null : Math.max(...declaring.map(d => d.level)),
      values = new Set(declaring.filter(d => level === null || d.level === level).map(d => d.consent[type]));
    return values.size === 1 ? [...values][0] : 'unknown';
  };
  const v2State = () =>
    Object.fromEntries(
      consentTypes.map(k => [k, ambiguous.has(k) ? 'unknown' : updated.has(k) ? updated.get(k) : defaultValue(k)]),
    );
  for (const [index, step] of trace.steps.entries()) {
    if (
      !object(step) ||
      !Number.isSafeInteger(step.sequence) ||
      step.sequence !== index + 1 ||
      !Number.isSafeInteger(step.at_ms) ||
      step.at_ms < 0 ||
      step.at_ms < previous ||
      step.at_ms > 86400000 ||
      !['consent_default', 'consent_update', 'event'].includes(step.kind)
    )
      fail(uiText('Trace steps require consecutive sequence numbers and nondecreasing relative times within one day.'));
    previous = step.at_ms;
    let region = null,
      wait = null,
      rowConsent;
    if (step.kind !== 'event') {
      if (
        !exact(
          step,
          v2 && step.kind === 'consent_default'
            ? ['sequence', 'at_ms', 'kind', 'consent', 'region', 'wait_for_update_ms']
            : ['sequence', 'at_ms', 'kind', 'consent'],
          ['sequence', 'at_ms', 'kind', 'consent'],
        ) ||
        !object(step.consent) ||
        !Object.keys(step.consent).length ||
        Object.entries(step.consent).some(([k, v]) => !consentTypes.includes(k) || !['granted', 'denied'].includes(v))
      )
        fail(uiText('Consent steps accept only the four Google consent types with granted or denied values.'));
      if (
        (step.region !== undefined &&
          (!Array.isArray(step.region) ||
            step.region.length < 1 ||
            step.region.length > 50 ||
            !step.region.every(measurementTraceRegion) ||
            new Set(step.region).size !== step.region.length)) ||
        (step.wait_for_update_ms !== undefined &&
          (!Number.isSafeInteger(step.wait_for_update_ms) ||
            step.wait_for_update_ms < 0 ||
            step.wait_for_update_ms > 60000))
      )
        fail(
          uiText(
            'A version 2 consent default takes 1–50 distinct region codes such as US or US-CA, and wait_for_update_ms from 0 to 60000.',
          ),
        );
      region = step.region ? [...step.region] : null;
      wait = step.wait_for_update_ms ?? null;
      if (v2 && step.kind === 'consent_default') {
        const scope = applies(region);
        if (region && visitor === null) finding('default_region_unknown', step.sequence);
        if (scope.applies !== false) {
          const key = region ? [...region].sort().join(',') : '';
          if (applied.some(d => d.key === key && Object.keys(step.consent).some(k => Object.hasOwn(d.consent, k))))
            finding('repeated_default', step.sequence);
          if (rows.some(row => row.kind === 'event')) finding('late_default', step.sequence);
          // Whether a later default overrides an earlier update is not documented: the type becomes unknown.
          for (const type of Object.keys(step.consent))
            if (updated.has(type)) {
              ambiguous.add(type);
              finding('ordering_ambiguous', step.sequence);
            }
          applied.push({key, level: scope.level, consent: {...step.consent}});
          defaults++;
          if (wait)
            for (const type of Object.keys(step.consent))
              waiting.set(type, Math.max(waiting.get(type) ?? 0, step.at_ms + wait));
        }
        consent = v2State();
      } else if (v2) {
        if (!defaults) finding('update_without_default', step.sequence);
        for (const [type, value] of Object.entries(step.consent)) {
          updated.set(type, value);
          ambiguous.delete(type);
          waiting.delete(type);
        }
        consent = v2State();
      } else if (step.kind === 'consent_default') {
        if (defaults) finding('repeated_default', step.sequence);
        if (rows.some(row => row.kind === 'event')) finding('late_default', step.sequence);
        defaults++;
        consent = Object.fromEntries(consentTypes.map(k => [k, step.consent[k] ?? 'unknown']));
      } else {
        if (!defaults) finding('update_without_default', step.sequence);
        consent = {...consent, ...step.consent};
      }
    } else {
      if (
        !exact(
          step,
          [
            'sequence',
            'at_ms',
            'kind',
            'event_name',
            'test_id',
            'transaction_key',
            'analytics_storage_write',
            'ad_storage_write',
            ...(v2 ? ['transaction_id_empty'] : []),
          ],
          ['sequence', 'at_ms', 'kind', 'event_name', 'test_id'],
        ) ||
        typeof step.event_name !== 'string' ||
        !/^\p{L}[\p{L}\p{N}_]{0,39}$/u.test(step.event_name) ||
        step.test_id !== trace.scope.test_id ||
        ['analytics_storage_write', 'ad_storage_write'].some(
          k => step[k] !== undefined && typeof step[k] !== 'boolean',
        ) ||
        (step.transaction_key !== undefined &&
          (step.event_name !== 'purchase' ||
            typeof step.transaction_key !== 'string' ||
            !/^opaque-[a-f0-9]{64}$/.test(step.transaction_key))) ||
        (step.transaction_id_empty !== undefined &&
          (step.transaction_id_empty !== true || step.event_name !== 'purchase' || step.transaction_key !== undefined))
      )
        fail(
          uiText(
            'Event steps accept only an exact event name, the selected synthetic test identifier, optional hashed purchase key and storage-write observations.',
          ),
        );
      if (!defaults) finding('event_without_default', step.sequence);
      rowConsent = {...consent};
      // A tag waiting for an update fires with whichever state exists when the update or the timeout comes first.
      for (const [type, until] of waiting)
        if (step.at_ms < until) {
          rowConsent[type] = 'unknown';
          finding('event_during_consent_wait', step.sequence);
        }
      for (const [type, key] of [
        ['analytics_storage', 'analytics_storage_write'],
        ['ad_storage', 'ad_storage_write'],
      ])
        if (step[key] === true && rowConsent[type] === 'denied')
          finding(type === 'analytics_storage' ? 'analytics_storage_conflict' : 'ad_storage_conflict', step.sequence);
      if (step.event_name === 'purchase') {
        const key = step.transaction_id_empty ? measurementTraceEmptyKey : step.transaction_key;
        // GA4 deduplicates every purchase whose transaction ID is empty, so an empty ID is never a unique identity.
        if (key === measurementTraceEmptyKey) finding('empty_transaction_key', step.sequence);
        if (!key) finding('purchase_identity_unknown', step.sequence);
        else if (transactions.has(key)) finding('repeated_purchase_key', step.sequence);
        else transactions.set(key, step.sequence);
      }
    }
    rows.push({
      sequence: step.sequence,
      at_ms: step.at_ms,
      kind: step.kind,
      event_name: step.event_name ?? null,
      consent: rowConsent ?? {...consent},
      analytics_storage_write: step.analytics_storage_write ?? null,
      ad_storage_write: step.ad_storage_write ?? null,
      ...(v2 && step.kind === 'consent_default' ? {region, wait_for_update_ms: wait} : {}),
    });
  }
  // MSR-03: the trace's stream is compared with the synchronized data streams of the property (stored, no request).
  const listed = Array.isArray(streams) ? streams.find(s => s.id === trace.scope.stream_id) : undefined;
  return {
    version: trace.version,
    scope: {...trace.scope},
    coverage: trace.coverage,
    rows,
    findings,
    ...(v2 ? {consent_model: 'regional_defaults_merged'} : {}),
    stream_check: !Array.isArray(streams)
      ? {state: 'inventory_unavailable', stream_type: null}
      : listed
        ? {state: 'listed', stream_type: listed.type ?? null}
        : {state: 'not_listed', stream_type: null},
    qualification: 'supplied_sanitized_trace',
    provider_mutations: 0,
    network_requests: 0,
    runtime_acceptance: 'unverified',
    native_deduplication: 'unverified',
    attribution: 'unverified',
  };
}
function measurementTraceMarkup(targets) {
  return `<section class="panel workspace-form">${measurementSectionHeading('measurement-section-trace', uiText('Inspect a sanitized event trace'))}<p>${esc(uiText('Inspect an explicitly supplied test sequence in this browser. The trace is never sent to AMCP or a provider and is cleared when you leave. This does not certify live consent, deduplication or attribution.'))}</p><form id="measurement-trace">${measurementTargetField(targets, uiText('Selected GA4 property'), 'Connect a GA4 property in Connections to inspect a trace for it.')}<details class="measurement-trace-import"><summary>${esc(uiText('Convert a dataLayer export or HAR file in this browser'))}</summary><p class="form-note" id="measurement-trace-import-help">${esc(uiText('The file is read only in this browser and is never uploaded or stored. Only consent commands, event names, their order and keyed hashes of purchase transaction IDs are kept; URLs, cookies, user and client IDs, transaction IDs and every other field are left out.'))}</p><label>${esc(uiText('File type'))}<select name="import_format"><option value="datalayer">${esc(uiText('dataLayer export (JSON)'))}</option><option value="har">${esc(uiText('HAR file'))}</option></select></label><label>${esc(uiText('File to convert'))}<input type="file" name="import_file" accept=".json,.har,application/json" aria-describedby="measurement-trace-import-help"></label><label>${esc(uiText('Data stream ID'))}<input name="import_stream" inputmode="numeric" dir="ltr" autocomplete="off"></label><label>${esc(uiText('Synthetic test identifier'))}<input name="import_test_id" dir="ltr" autocomplete="off"></label><button class="button" type="button" id="measurement-trace-convert" ${targets.length ? '' : 'disabled'}>${esc(uiText('Convert locally'))}</button><p id="measurement-trace-import-status" class="form-note" role="status"></p></details><label>${esc(uiText('Sanitized trace JSON'))}<textarea name="trace" rows="12" maxlength="1048576" dir="ltr" required aria-describedby="measurement-trace-help"></textarea></label><p id="measurement-trace-help" class="form-note">${esc(uiText('Use version 1 with scope, coverage and steps. Include only synthetic test IDs, relative times, consent states and hashed purchase keys. Raw URLs, cookies, user IDs and original transaction IDs are refused.')).replace(/\b(scope|coverage|steps)\b/g, '<code dir="ltr">$1</code>')} ${esc(uiText('Version 2 also declares scope.visitor_region (a region code or null), optional region lists and wait_for_update_ms on consent defaults, and transaction_id_empty for a purchase whose transaction ID was empty.')).replace(/\b(scope\.visitor_region|wait_for_update_ms|transaction_id_empty)\b/g, '<code dir="ltr">$1</code>')}</p><div class="dialog-actions"><button class="button primary" type="submit" ${targets.length ? '' : 'disabled'}>${esc(uiText('Inspect trace locally'))}</button><button class="button" type="button" id="measurement-trace-example" ${targets.length ? '' : 'disabled'}>${esc(uiText('Load a synthetic example'))}</button><button class="button" type="button" id="measurement-trace-clear">${esc(uiText('Clear trace'))}</button></div></form><div id="measurement-trace-result" aria-live="polite"></div></section>`;
}
function measurementTraceResult(out, page = 0) {
  const labels = {
    event: uiText('Measurement event'),
    consent_default: uiText('Consent default'),
    consent_update: uiText('Consent update'),
    repeated_default: uiText('Repeated default declaration'),
    late_default: uiText('Consent default follows an event'),
    update_without_default: uiText('Consent update has no preceding default'),
    event_without_default: uiText('Event has no preceding consent default'),
    analytics_storage_conflict: uiText('Declared analytics storage write under denied analytics consent'),
    ad_storage_conflict: uiText('Declared advertising storage write under denied advertising consent'),
    purchase_identity_unknown: uiText('Purchase identity is unavailable'),
    repeated_purchase_key: uiText('Repeated hashed purchase key'),
    ordering_ambiguous: uiText(
      'A consent default follows an update of the same type; which one applies is not established, so the type is unknown',
    ),
    default_region_unknown: uiText(
      'A region-specific default applies only if the visitor is in that region, and the trace declares no visitor region',
    ),
    event_during_consent_wait: uiText(
      'Event observed while a consent default was still waiting for an update; its consent state is unknown',
    ),
    empty_transaction_key: uiText(
      'Purchase key comes from an empty transaction ID; GA4 deduplicates every purchase with an empty transaction ID',
    ),
    granted: uiText('Granted'),
    denied: uiText('Denied'),
    unknown: uiText('Unknown'),
  };
  const types = ['analytics_storage', 'ad_storage', 'ad_user_data', 'ad_personalization'],
    written = v => esc(v === true ? uiText('Yes') : v === false ? uiText('No') : uiText('Not declared')),
    detail = r =>
      r.region || r.wait_for_update_ms
        ? ` · ${r.region ? esc(uiText('Regions: {regions}', {regions: r.region.join(', ')})) : esc(uiText('All regions'))}${r.wait_for_update_ms ? ' · ' + esc(uiText('Waits {ms} ms for an update', {ms: r.wait_for_update_ms})) : ''}`
        : '',
    stream = out.stream_check?.state,
    v2 = out.version === 2;
  return `<h3 id="measurement-trace-heading" tabindex="-1">${esc(uiText('Supplied trace observations'))}</h3><p class="notice">${esc(uiText('Findings describe only the supplied sequence. A repeated purchase key does not prove that GA4 counted twice. Events under denied consent can be cookieless; an event alone is not a consent violation. Missing observations remain unknown.'))}</p>${v2 ? `<p class="form-note">${esc(uiText('Version 2 applies the most specific default that matches the declared visitor region and keeps types an earlier default set unless a later one declares them. A default after an update of the same type is reported as unknown, not as a conflict.'))}</p>` : ''}<p>${esc(uiText('Coverage'))}: ${esc(out.coverage === 'complete' ? uiText('Declared complete') : uiText('Declared partial'))} · ${out.rows.length} ${esc(uiText('steps'))} · ${out.findings.length} ${esc(uiText('findings'))}</p><p dir="ltr"><code>${esc(out.scope.property_id)} / ${esc(out.scope.stream_id)} / ${esc(out.scope.test_id)}${v2 ? ' / ' + esc(out.scope.visitor_region ?? '—') : ''}</code></p>${stream ? `<p class="form-note">${esc(stream === 'listed' ? uiText('The trace stream is one of the synchronized data streams of this property.') : stream === 'not_listed' ? uiText('The trace stream is not among the synchronized data streams of this property. Synchronize data streams in Connections or check the stream ID.') : uiText('Data streams of this property are not synchronized, so the trace stream was not compared.'))}${out.stream_check.stream_type ? ` <code dir="ltr">${esc(out.stream_check.stream_type)}</code>` : ''}${out.stream_check.stream_type && out.stream_check.stream_type !== 'WEB_DATA_STREAM' ? ' ' + esc(uiText('GA4 deduplicates purchases by transaction ID only for web streams.')) : ''}</p>` : ''}<ul>${out.findings.map(f => `<li>${esc(uiText('Step {step}: {finding}', {step: f.step, finding: labels[f.code]}))}</li>`).join('') || `<li>${esc(uiText('No selected issue was observed in the supplied trace. Live acceptance remains unverified.'))}</li>`}</ul><div class="report-table-wrap" role="region" tabindex="0" aria-label="${esc(uiText('Event and consent sequence'))}"><table class="report-table"><caption>${esc(uiText('Event and consent sequence'))}</caption><thead><tr><th scope="col">${esc(uiText('Step'))}</th><th scope="col">${esc(uiText('Relative time (ms)'))}</th><th scope="col">${esc(uiText('Observation'))}</th>${types.map(k => `<th scope="col"><code dir="ltr">${k}</code></th>`).join('')}<th scope="col">${esc(uiText('Declared analytics storage write'))}</th><th scope="col">${esc(uiText('Declared advertising storage write'))}</th></tr></thead><tbody>${out.rows
    .slice(page * 25, (page + 1) * 25)
    .map(
      r =>
        `<tr><th scope="row">${r.sequence}</th><td>${r.at_ms}</td><td>${esc(labels[r.kind])}${r.event_name ? ` · <code dir="ltr">${esc(r.event_name)}</code>` : ''}${detail(r)}</td>${types.map(k => `<td>${esc(labels[r.consent[k]])}</td>`).join('')}<td>${r.kind === 'event' ? written(r.analytics_storage_write) : ''}</td><td>${r.kind === 'event' ? written(r.ad_storage_write) : ''}</td></tr>`,
    )
    .join(
      '',
    )}</tbody></table></div><div class="dialog-actions"><button class="button" id="measurement-trace-previous" ${page ? '' : 'disabled'}>${esc(uiText('Previous page'))}</button><span>${esc(uiText('Page'))} ${page + 1}</span><button class="button" id="measurement-trace-next" ${(page + 1) * 25 < out.rows.length ? '' : 'disabled'}>${esc(uiText('Next page'))}</button></div>`;
}
function bindMeasurementTrace(targets) {
  const form = $('#measurement-trace'),
    result = $('#measurement-trace-result'),
    begin = accountWorkflowContext(form, result),
    importStatus = $('#measurement-trace-import-status');
  const clear = () => {
    form.elements.trace.value = '';
    result.innerHTML = '';
    if (form.elements.import_file) form.elements.import_file.value = '';
    if (importStatus) importStatus.textContent = '';
    form.dispatchEvent(new Event('input', {bubbles: true}));
  };
  workspaceBind('#measurement-trace-clear', clear);
  // MSR-03: a dataLayer export or HAR file is converted in this page only; nothing is uploaded, stored or sent.
  // The converter loads with this page (route-assets.js); without it the test identifier is typed. The generated
  // identifier is the field's starting value, not an unsaved edit (WEB-05: a fresh /measurement is pristine).
  if (
    form.elements.import_test_id &&
    !form.elements.import_test_id.value &&
    typeof measurementTraceImportTestId === 'function'
  )
    uiSetInitialValue(form.elements.import_test_id, measurementTraceImportTestId());
  workspaceBind('#measurement-trace-convert', async () => {
    const generation = navigationGeneration,
      identity = identityGeneration,
      attached = () => generation === navigationGeneration && identity === identityGeneration && form.isConnected;
    if (form.elements.target.value === '' && targets.length === 1) form.elements.target.value = '0';
    const t = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !t) throw Error(uiText('Choose a selected GA4 property first.'));
    const format = form.elements.import_format.value === 'har' ? 'har' : 'datalayer',
      file = form.elements.import_file.files?.[0];
    if (!file) throw Error(uiText('Choose a file to convert.'));
    // The size is checked before anything is read.
    if (
      !Number.isSafeInteger(file.size) ||
      file.size >
        (format === 'har' ? measurementTraceImportLimits.har_bytes : measurementTraceImportLimits.datalayer_bytes)
    )
      throw Error(
        uiText(
          format === 'har' ? 'Choose a HAR file of at most 16 MiB.' : 'Choose a dataLayer export of at most 2 MiB.',
        ),
      );
    const streams = measurementInventory('ga4', 'data_streams', t),
      streamId = form.elements.import_stream.value.trim() || (streams.length === 1 ? streams[0].id : ''),
      text = await file.text();
    if (!attached()) return;
    const out = await measurementTraceImport(text, {
      format,
      property_id: t.account_id,
      stream_id: streamId,
      test_id: form.elements.import_test_id.value.trim(),
      measurement_id: streams.find(s => s.id === streamId)?.measurement_id ?? null,
    });
    if (!attached()) return;
    form.elements.import_stream.value = streamId;
    form.elements.trace.value = out.json;
    form.dispatchEvent(new Event('input', {bubbles: true}));
    const s = out.summary;
    importStatus.textContent = [
      uiText(
        'Converted in this browser: {events} events and {consent} consent commands kept, {dropped} entries left out. Times follow the original order; real timing is unknown. Review the trace, then inspect it.',
        {events: uiNumber(s.events), consent: uiNumber(s.consent), dropped: uiNumber(s.dropped)},
      ),
      s.format === 'har'
        ? uiText('A HAR file establishes no consent state, because GA4 does not document its gcs and gcd parameters.')
        : '',
      s.format === 'har' && s.stream_filter === 'none'
        ? uiText('The measurement ID of this stream is not synchronized, so requests of every GA4 stream were kept.')
        : '',
      s.other_streams
        ? uiText('{count} requests of other streams were left out.', {count: uiNumber(s.other_streams)})
        : '',
      s.truncated ? uiText('Only the first {steps} steps were kept.', {steps: uiNumber(s.steps)}) : '',
    ]
      .filter(Boolean)
      .join(' ');
  });
  workspaceBind('#measurement-trace-example', () => {
    // MSR-02: the only property is preselected; otherwise the example explains inline which choice it needs.
    if (form.elements.target.value === '' && targets.length === 1) form.elements.target.value = '0';
    const t = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !t) {
      result.innerHTML = `<p class="notice" role="alert">${esc(uiText('Choose a selected GA4 property first.'))}</p>`;
      form.elements.target.focus?.();
      return;
    }
    form.elements.trace.value = JSON.stringify(
      {
        version: 1,
        scope: {
          property_id: t.account_id,
          stream_id: measurementInventory('ga4', 'data_streams', t)[0]?.id ?? '100',
          test_id: 'amcp-test-local-example',
        },
        coverage: 'partial',
        steps: [
          {
            sequence: 1,
            at_ms: 0,
            kind: 'consent_default',
            consent: {
              analytics_storage: 'denied',
              ad_storage: 'denied',
              ad_user_data: 'denied',
              ad_personalization: 'denied',
            },
          },
          {
            sequence: 2,
            at_ms: 100,
            kind: 'event',
            event_name: 'page_view',
            test_id: 'amcp-test-local-example',
            analytics_storage_write: false,
          },
          {sequence: 3, at_ms: 200, kind: 'consent_update', consent: {analytics_storage: 'granted'}},
          {
            sequence: 4,
            at_ms: 300,
            kind: 'event',
            event_name: 'purchase',
            test_id: 'amcp-test-local-example',
            transaction_key: 'opaque-' + 'a'.repeat(64),
            analytics_storage_write: true,
          },
        ],
      },
      null,
      2,
    );
    form.dispatchEvent(new Event('input', {bubbles: true}));
  });
  workspaceBind('#measurement-trace', () => {
    const current = begin(),
      t = targets[Number(form.elements.target.value)];
    if (!current()) return;
    if (form.elements.target.value === '' || !t) throw Error(uiText('Choose a selected GA4 property first.'));
    const out = measurementTraceInspect(form.elements.trace.value, t, measurementStreamInventory(t));
    let page = 0;
    const render = focus => {
      if (!current()) return;
      result.innerHTML = measurementTraceResult(out, page);
      workspaceBind('#measurement-trace-previous', () => {
        page = Math.max(0, page - 1);
        render(true);
      });
      workspaceBind('#measurement-trace-next', () => {
        page = Math.min(Math.ceil(out.rows.length / 25) - 1, page + 1);
        render(true);
      });
      if (focus) $('#measurement-trace-heading').focus();
    };
    render(true);
  });
}
function prefillMeasurementAudit(form, result, targets) {
  if (typeof location === 'undefined') return;
  const params = new URLSearchParams(location.search),
    keys = ['connection_id', 'account_id', 'container_id', 'workspace_id'];
  if (['conversion_rules', 'event_identity', 'google_goals', 'ga4_config', 'ledger'].some(key => params.has(key)))
    return;
  if (!keys.some(key => params.has(key))) return;
  for (const key of ['target', 'container_id', 'workspace_id']) form.elements[key].value = '';
  const account = params.get('account_id'),
    login = params.get('connection_id'),
    container = params.get('container_id') ?? '',
    workspace = params.get('workspace_id') ?? '',
    index = targets.findIndex(target => target.connection_id === login && target.account_id === account),
    valid =
      keys.every(key => params.getAll(key).length <= 1) &&
      index >= 0 &&
      (!container || /^[A-Za-z0-9_-]{1,128}$/.test(container)) &&
      (!workspace || (container && /^[A-Za-z0-9_-]{1,128}$/.test(workspace)));
  if (!valid) {
    result.innerHTML = `<p class="notice">${esc(uiText('The linked audit scope is unavailable. Choose a currently selected account.'))}</p>`;
    return;
  }
  form.elements.target.value = String(index);
  form.elements.container_id.value = container;
  form.elements.workspace_id.value = workspace;
  result.innerHTML = `<p class="form-note" role="status">${esc(uiText('Scope selected from an audit link. Read current configuration to refresh the evidence.'))}</p>`;
}
// MSR-02: every measurement form uses one target field. Without an eligible account it says how to connect one (and
// the caller disables submit); with exactly one it is preselected. Preselection never starts a read.
function measurementTargetField(targets, label, emptyNotice, choose = uiText('Choose a selected account')) {
  return `${targets.length ? '' : `<p class="notice measurement-empty">${accountChoicesEmptyNotice(targets, uiText(emptyNotice))}</p>`}<label>${esc(label)}<select name="target" required ${targets.length ? '' : 'disabled'}><option value="">${esc(choose)}</option>${targets.map((t, i) => `<option value="${i}" ${targets.length === 1 ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></label>`;
}
const measurementId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
// Synchronized inventory this login already holds (no request): GTM containers and GA4 data streams of one account.
function measurementInventory(platformId, kind, target) {
  if (!target) return [];
  const connection = platforms
      .find(p => p.id === platformId)
      ?.connections.find(c => c.enabled && c.id === target.connection_id),
    assets = connection?.groups?.find(g => g.kind === kind)?.assets ?? [],
    pattern =
      kind === 'containers'
        ? new RegExp('^accounts/' + target.account_id + '/containers/([0-9]{1,20})$')
        : new RegExp('^properties/' + target.account_id + '/dataStreams/([1-9][0-9]{0,19})$');
  const rows = [],
    seen = new Set();
  for (const asset of assets) {
    const id = typeof asset?.id === 'string' ? pattern.exec(asset.id)?.[1] : undefined;
    if (!id || seen.has(id) || rows.length >= 500) continue;
    seen.add(id);
    rows.push({
      id,
      name: typeof asset.name === 'string' && asset.name !== asset.id ? asset.name.slice(0, 200) : null,
      // MSR-03: synced GA4 streams retain their native type and measurement ID when discovery returned them.
      detail: [asset.measurementId, asset.streamType]
        .filter(v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v))
        .join(' · '),
      type: typeof asset.streamType === 'string' && /^[A-Z_]{1,64}$/.test(asset.streamType) ? asset.streamType : null,
      measurement_id:
        typeof asset.measurementId === 'string' && /^G-[A-Z0-9]{4,20}$/.test(asset.measurementId)
          ? asset.measurementId
          : null,
    });
  }
  return rows;
}
// The synchronized data streams of one property, or null when they were never completely synchronized (MSR-03).
function measurementStreamInventory(target) {
  if (!target) return null;
  const group = platforms
    .find(p => p.id === 'ga4')
    ?.connections.find(c => c.enabled && c.id === target.connection_id)
    ?.groups?.find(g => g.kind === 'data_streams');
  return group && group.complete !== false && Array.isArray(group.assets)
    ? measurementInventory('ga4', 'data_streams', target)
    : null;
}
// The audit's own discovery of containers and workspaces, kept in memory for the current identity only.
let measurementDiscovered = null;
function measurementDiscoveredRows(key) {
  if (!measurementDiscovered || measurementDiscovered.identity !== identityGeneration) return [];
  return measurementDiscovered.rows.get(key) ?? [];
}
const measurementScopeParams = {
  gtm: ['ms_gtm_login', 'ms_gtm_account'],
  ga4: ['ms_ga4_login', 'ms_ga4_property'],
  google: ['ms_google_login', 'ms_google_account'],
  linkedin: ['ms_linkedin_login', 'ms_linkedin_account'],
};
function measurementScopeMarkup(sets) {
  const select = (name, label, targets) =>
    `<label>${esc(label)}<select name="${name}" ${targets.length ? '' : 'disabled'}><option value="">${esc(uiText('Not chosen'))}</option>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label>`;
  return `<section class="panel workspace-form measurement-scope" aria-labelledby="measurement-scope-heading"><h2 id="measurement-scope-heading">${esc(uiText('Measurement scope'))}</h2><p class="form-note" id="measurement-scope-help">${esc(uiText('Choose accounts once and every task below starts with them. Choosing makes no request; each read starts only when you submit its form.'))}</p><form id="measurement-scope" aria-describedby="measurement-scope-help"><fieldset><legend>${esc(uiText('Google Tag Manager'))}</legend>${select('gtm', uiText('Tag Manager account'), sets.gtm)}<label>${esc(uiText('Container'))}<select name="container" disabled><option value="">${esc(uiText('All containers'))}</option></select></label><label>${esc(uiText('Workspace'))}<select name="workspace" disabled><option value="">${esc(uiText('All workspaces'))}</option></select></label></fieldset><fieldset><legend>${esc(uiText('Google Analytics 4'))}</legend>${select('ga4', uiText('GA4 property'), sets.ga4)}<label>${esc(uiText('Data stream'))}<select name="stream" disabled><option value="">${esc(uiText('All streams'))}</option></select></label></fieldset><fieldset><legend>${esc(uiText('Advertising accounts'))}</legend>${select('google', uiText('Google Ads account'), sets.google)}${select('linkedin', uiText('LinkedIn advertising account'), sets.linkedin)}</fieldset><p class="form-note">${esc(uiText('Each task keeps its own fields, so you can still choose another account or type an ID there.'))}</p><button type="button" class="button small" id="measurement-scope-clear">${esc(uiText('Clear scope'))}</button><p id="measurement-scope-status" class="form-note" role="status"></p></form></section>`;
}
/**
 * One measurement scope shared by every task (MSR-02). It lives only in this page's URL (ms_* parameters), so leaving
 * the page clears it. Values that no longer match an account selected for the current identity are dropped and removed
 * from the URL, so an identity change clears a stale scope. Applying a scope only fills form fields and clears their earlier results; reads stay
 * submit-only.
 */
function bindMeasurementScope(sets) {
  const form = $('#measurement-scope'),
    status = $('#measurement-scope-status'),
    fields = form?.elements ?? {},
    generation = navigationGeneration,
    identity = identityGeneration,
    attached = () => generation === navigationGeneration && identity === identityGeneration && form.isConnected;
  if (!form || !fields.gtm) return;
  const params = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
  const indexOf = (kind, login, account) =>
    sets[kind].findIndex(t => t.connection_id === login && t.account_id === account);
  // Only accounts someone chose (here or in the link) are written to the URL; a preselected only account is not.
  const chosen = new Set();
  let scope = {gtm: null, container: '', workspace: '', ga4: null, stream: '', google: null, linkedin: null},
    stale = false;
  {
    for (const [kind, [loginKey, accountKey]] of Object.entries(measurementScopeParams)) {
      if (!params.has(loginKey) && !params.has(accountKey)) continue;
      const index =
        params.getAll(loginKey).length === 1 && params.getAll(accountKey).length === 1
          ? indexOf(kind, params.get(loginKey), params.get(accountKey))
          : -1;
      if (index < 0) stale = true;
      else {
        scope[kind] = index;
        chosen.add(kind);
      }
    }
    const extra = (key, valid) => {
      if (!params.has(key)) return '';
      const value = params.getAll(key).length === 1 ? params.get(key) : '';
      if (!valid(value)) stale = true;
      return valid(value) ? value : '';
    };
    scope.container = extra('ms_container', value => scope.gtm !== null && /^[0-9]{1,20}$/.test(value));
    scope.workspace = extra('ms_workspace', value => !!scope.container && measurementId(value));
    scope.stream = extra('ms_stream', value => scope.ga4 !== null && /^[1-9][0-9]{0,19}$/.test(value));
  }
  for (const kind of Object.keys(measurementScopeParams))
    if (scope[kind] === null && sets[kind].length === 1) scope[kind] = 0;
  let ledgerKind = ['google', 'ga4'].find(kind => chosen.has(kind)) ?? null;
  const options = (select, empty, rows, chosen) => {
    const list = rows.some(r => r.id === chosen) || !chosen ? rows : [...rows, {id: chosen, name: null, detail: ''}];
    select.innerHTML =
      `<option value="">${esc(empty)}</option>` +
      list
        .map(
          r =>
            `<option value="${esc(r.id)}">${esc(r.name ? r.name + ' (' + r.id + ')' : r.id)}${r.detail ? ' · ' + esc(r.detail) : ''}</option>`,
        )
        .join('');
    select.value = chosen;
    select.disabled = false;
  };
  const choices = () => {
    const gtm = scope.gtm === null ? null : sets.gtm[scope.gtm],
      ga4 = scope.ga4 === null ? null : sets.ga4[scope.ga4];
    if (gtm) {
      const discovered = measurementDiscoveredRows('containers|' + gtm.connection_id + '|' + gtm.account_id),
        inventory = measurementInventory('gtm', 'containers', gtm);
      options(
        fields.container,
        uiText('All containers'),
        [...inventory, ...discovered.filter(r => !inventory.some(i => i.id === r.id))],
        scope.container,
      );
    } else {
      fields.container.innerHTML = `<option value="">${esc(uiText('All containers'))}</option>`;
      fields.container.value = '';
      fields.container.disabled = true;
    }
    if (gtm && scope.container)
      options(
        fields.workspace,
        uiText('All workspaces'),
        measurementDiscoveredRows('workspaces|' + gtm.connection_id + '|' + gtm.account_id + '|' + scope.container),
        scope.workspace,
      );
    else {
      fields.workspace.innerHTML = `<option value="">${esc(uiText('All workspaces'))}</option>`;
      fields.workspace.value = '';
      fields.workspace.disabled = true;
    }
    if (ga4)
      options(fields.stream, uiText('All streams'), measurementInventory('ga4', 'data_streams', ga4), scope.stream);
    else {
      fields.stream.innerHTML = `<option value="">${esc(uiText('All streams'))}</option>`;
      fields.stream.value = '';
      fields.stream.disabled = true;
    }
    for (const kind of Object.keys(measurementScopeParams))
      fields[kind].value = scope[kind] === null ? '' : String(scope[kind]);
  };
  const remember = () => {
    if (typeof location === 'undefined' || typeof history === 'undefined' || typeof history.replaceState !== 'function')
      return;
    const next = new URLSearchParams(location.search);
    for (const key of [...Object.values(measurementScopeParams).flat(), 'ms_container', 'ms_workspace', 'ms_stream'])
      next.delete(key);
    for (const [kind, [loginKey, accountKey]] of Object.entries(measurementScopeParams)) {
      const t = scope[kind] === null ? null : sets[kind][scope[kind]];
      if (!t || !(chosen.has(kind) || (kind === 'gtm' && scope.container) || (kind === 'ga4' && scope.stream)))
        continue;
      next.set(loginKey, t.connection_id);
      next.set(accountKey, t.account_id);
    }
    if (scope.container) next.set('ms_container', scope.container);
    if (scope.workspace) next.set('ms_workspace', scope.workspace);
    if (scope.stream) next.set('ms_stream', scope.stream);
    const query = next.toString();
    history.replaceState(history.state, '', location.pathname + (query ? '?' + query : '') + (location.hash ?? ''));
  };
  // Writes the scope into each task form. Initially only chosen values are written; an explicit change also writes
  // cleared values and invalidates that form's earlier result.
  const apply = explicit => {
    const write = (formId, values) => {
      const target = $('#' + formId),
        elements = target?.elements;
      if (!elements) return;
      let changed = false;
      for (const [name, value] of Object.entries(values)) {
        if (!elements[name] || value === undefined || (!explicit && value === '')) continue;
        if (elements[name].value !== value) changed = true;
        elements[name].value = value;
      }
      if (explicit && changed) target.dispatchEvent(new Event('change', {bubbles: true}));
    };
    const index = kind => (scope[kind] === null ? '' : String(scope[kind])),
      // Without an account, an explicit change clears the dependent IDs; the initial fill leaves typed IDs alone.
      dependent = (kind, value) => (scope[kind] === null ? (explicit ? '' : undefined) : value);
    write('measurement-audit', {
      target: index('gtm'),
      container_id: dependent('gtm', scope.container),
      workspace_id: dependent('gtm', scope.workspace),
    });
    for (const id of ['measurement-events', 'measurement-event-identity'])
      write(id, {target: index('ga4'), stream_id: dependent('ga4', scope.stream)});
    write('measurement-trace', {target: index('ga4'), import_stream: dependent('ga4', scope.stream)});
    write('measurement-ga4-config', {target: index('ga4')});
    write('measurement-conversions', {target: index('linkedin')});
    write('measurement-google-goals', {target: index('google')});
    // The ledger lists Google Ads accounts, then GA4 properties, and follows the kind chosen last (MSR-03).
    const ledger = [ledgerKind, 'google', 'ga4'].find(kind => kind && scope[kind] !== null);
    write('measurement-ledger', {
      target: ledger ? String((ledger === 'ga4' ? sets.google.length : 0) + scope[ledger]) : '',
    });
  };
  measurementScopeController = {
    attached,
    // A container or workspace chosen from the audit's own discovery list (never a request).
    choose(kind, value, container) {
      if (!attached()) return;
      if (kind === 'container') {
        scope.container = value;
        scope.workspace = '';
      } else {
        scope.container = container;
        scope.workspace = value;
      }
      choices();
      remember();
      apply(true);
    },
    discovered() {
      if (attached()) choices();
    },
  };
  choices();
  apply(false);
  if (stale) {
    remember();
    status.textContent = uiText(
      'Part of the linked measurement scope no longer matches your selected accounts and was cleared.',
    );
  }
  form.addEventListener('change', event => {
    if (!attached()) return;
    const name = event?.target?.name;
    if (['gtm', 'ga4', 'google', 'linkedin'].includes(name)) {
      const value = fields[name].value,
        index = value === '' ? null : Number(value);
      if (index !== null && !sets[name][index]) return;
      scope[name] = index;
      if (index === null) chosen.delete(name);
      else chosen.add(name);
      if (name === 'google' || name === 'ga4')
        ledgerKind = index !== null ? name : ledgerKind === name ? null : ledgerKind;
      if (name === 'gtm') scope.container = scope.workspace = '';
      if (name === 'ga4') scope.stream = '';
    } else if (name === 'container') {
      scope.container = /^[0-9]{1,20}$/.test(fields.container.value) ? fields.container.value : '';
      scope.workspace = '';
    } else if (name === 'workspace')
      scope.workspace = measurementId(fields.workspace.value) ? fields.workspace.value : '';
    else if (name === 'stream')
      scope.stream = /^[1-9][0-9]{0,19}$/.test(fields.stream.value) ? fields.stream.value : '';
    else return;
    status.textContent = '';
    choices();
    remember();
    apply(true);
  });
  $('#measurement-scope-clear')?.addEventListener('click', () => {
    if (!attached()) return;
    scope = {gtm: null, container: '', workspace: '', ga4: null, stream: '', google: null, linkedin: null};
    chosen.clear();
    ledgerKind = null;
    status.textContent = uiText('The measurement scope was cleared.');
    choices();
    remember();
    apply(true);
  });
}
let measurementScopeController = null;
// The audit lists the containers of an account or the workspaces of a container. Each can be chosen without typing.
function gtmDiscoveryRows(c, target, requirements) {
  const kind = !requirements.container_id ? 'container' : !requirements.workspace_id ? 'workspace' : null,
    source = kind === 'container' ? c.containers : kind === 'workspace' ? c.workspaces : null;
  if (!kind || !target || !Array.isArray(source) || source.length > 1000) return null;
  const seen = new Set(),
    rows = [];
  for (const row of source) {
    const id = kind === 'container' ? row?.container_id : row?.workspace_id;
    if (
      !(kind === 'container' ? /^[0-9]{1,20}$/.test(id ?? '') : measurementId(id)) ||
      seen.has(id) ||
      (row.name !== null && row.name !== undefined && (typeof row.name !== 'string' || row.name.length > 256))
    )
      return null;
    seen.add(id);
    rows.push({id, name: row.name ?? null, detail: ''});
  }
  return {kind, target, container: requirements.container_id ?? '', rows};
}
function gtmDiscoveryMarkup(discovery) {
  if (!discovery) return '';
  const shown = discovery.rows.slice(0, 200),
    container = discovery.kind === 'container';
  return `<section class="measurement-discovery"><h3>${esc(uiText(container ? 'Containers in this account' : 'Workspaces in this container'))}</h3><p class="form-note">${esc(uiText('Choose one to fill the audit scope, then read its configuration. Choosing makes no request.'))}</p>${shown.length ? `<ul class="measurement-choice-list">${shown.map((r, i) => `<li><span dir="auto">${esc(r.name ?? uiText('Unnamed'))}</span> <code dir="ltr">${esc(r.id)}</code> <button type="button" class="button small" id="gtm-choice-${i}">${esc(uiText(container ? 'Use this container' : 'Use this workspace'))}</button></li>`).join('')}</ul>` : `<p>${esc(uiText(container ? 'No containers were returned for this account.' : 'No workspaces were returned for this container.'))}</p>`}${discovery.rows.length > shown.length ? `<p class="form-note">${esc(uiText('Only the first 200 are listed. Type another ID in the audit form.'))}</p>` : ''}</section>`;
}
function mountGtmDiscovery(discovery, form, selectionCurrent) {
  if (!discovery) return;
  const {kind, target, container} = discovery,
    key =
      kind === 'container'
        ? 'containers|' + target.connection_id + '|' + target.account_id
        : 'workspaces|' + target.connection_id + '|' + target.account_id + '|' + container;
  if (!measurementDiscovered || measurementDiscovered.identity !== identityGeneration)
    measurementDiscovered = {identity: identityGeneration, rows: new Map()};
  measurementDiscovered.rows.set(key, discovery.rows.slice(0, 1000));
  measurementScopeController?.discovered();
  discovery.rows.slice(0, 200).forEach((row, i) => {
    $('#gtm-choice-' + i)?.addEventListener('click', () => {
      if (!selectionCurrent() || !form.isConnected) return;
      const scopeForm = $('#measurement-scope'),
        index = scopeForm?.elements?.gtm?.value;
      // The scope bar follows the chosen row when it already names this account; the audit form is always filled.
      if (measurementScopeController?.attached() && index !== undefined && index === form.elements.target.value) {
        measurementScopeController.choose(kind, row.id, container);
      }
      if (kind === 'container') {
        form.elements.container_id.value = row.id;
        form.elements.workspace_id.value = '';
      } else form.elements.workspace_id.value = row.id;
      form.dispatchEvent(new Event('change', {bubbles: true}));
      $('#measurement-audit-submit')?.focus();
    });
  });
}
const measurementGoalStatuses = {
  account_default_conversion_goals: 'Biddable account-default goals',
  primary_conversion_actions: 'Primary conversion actions',
  conversion_value_configuration: 'Conversion value settings',
  reported_conversion_activity: 'Reported conversion activity',
};
const measurementGoalReasons = {
  manager_account: 'This is a manager account. Choose a client account that records its own conversions.',
  shared_conversion_customer:
    'This account uses another customer’s conversion tracking. AMCP did not read that customer, so goals stay unknown.',
  conversion_customer_unknown: 'Google Ads did not report the conversion tracking customer, so goals stay unknown.',
};
function measurementGoogleGoalsMarkup(targets) {
  return `<section class="panel workspace-form">${measurementSectionHeading('measurement-section-goals', uiText('Google Ads conversion goals'))}<p>${esc(uiText('Inspect account-default conversion goals, primary conversion actions, their value settings and last reported activity for one Google Ads account. This is configuration, not proof of delivery.'))}</p><form id="measurement-google-goals">${measurementTargetField(targets, uiText('Google Ads account'), 'Connect Google Ads and select a customer account in Connections to inspect conversion goals.')}<button class="button primary" type="submit" ${targets.length ? '' : 'disabled'}>${esc(uiText('Read conversion goals'))}</button></form><div id="measurement-google-goals-result" aria-live="polite"></div></section>`;
}
function measurementGoogleGoalsValid(out, target) {
  const text = (v, max = 256) => typeof v === 'string' && v.length <= max && !/[\x00-\x1f\x7f]/.test(v),
    code = v => typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(v),
    nullableText = (v, max) => v === null || text(v, max),
    statuses = ['ready', 'blocked', 'unknown'];
  if (
    !out ||
    out.record_kind !== 'measurement_google_goals' ||
    out.provider_mutations !== 0 ||
    out.scope?.gateway !== 'google_ads_native_action' ||
    out.scope.account_id !== target.account_id ||
    out.scope.connection_id !== target.connection_id ||
    typeof out.complete !== 'boolean' ||
    !out.dependency_statuses ||
    Object.entries(out.dependency_statuses).some(
      ([k, v]) => !Object.hasOwn(measurementGoalStatuses, k) || !statuses.includes(v),
    )
  )
    return false;
  if (!out.complete) return true;
  return (
    Array.isArray(out.goals) &&
    out.goals.length <= 20 &&
    out.goals.every(
      g =>
        g &&
        text(g.resource_name, 300) &&
        code(g.category) &&
        code(g.origin) &&
        typeof g.biddable === 'boolean' &&
        Number.isSafeInteger(g.matching_primary_actions),
    ) &&
    Array.isArray(out.primary_actions) &&
    out.primary_actions.length <= 20 &&
    out.primary_actions.every(
      a =>
        a &&
        text(a.resource_name, 300) &&
        text(a.name) &&
        code(a.category) &&
        code(a.origin) &&
        code(a.status) &&
        (!a.value_settings ||
          ((a.value_settings.default_value === null || Number.isFinite(a.value_settings.default_value)) &&
            nullableText(a.value_settings.default_currency_code, 3) &&
            [true, false, null].includes(a.value_settings.always_use_default_value))) &&
        (!a.activity ||
          (nullableText(a.activity.last_conversion_date, 10) && nullableText(a.activity.last_tag_received_time, 26))),
    ) &&
    !!out.summary &&
    typeof out.summary === 'object' &&
    Object.values(out.summary).every(v => Number.isSafeInteger(v) && v >= 0)
  );
}
function measurementGoogleGoalsView(out, target) {
  const unknown = esc(uiText('Unknown')),
    native = v => (v === null || v === undefined ? unknown : `<code dir="ltr">${esc(v)}</code>`),
    status = v => esc(v === 'ready' ? uiText('Ready') : v === 'blocked' ? uiText('Blocked') : uiText('Unknown')),
    statusRows = Object.entries(out.dependency_statuses)
      .map(([k, v]) => `<li>${esc(uiText(measurementGoalStatuses[k]))}: ${status(v)}</li>`)
      .join('');
  let html = `<h3 id="measurement-google-goals-heading" tabindex="-1">${esc(target.label)}</h3><p>${esc(uiText('Requested {requested} · Returned {captured}', {requested: date(out.requested_at), captured: date(out.captured_at)}))}</p>${badge(out.complete ? 'complete' : 'incomplete')}<p class="notice">${esc(uiAccountExplanation(out.meaning))}</p><ul>${statusRows}</ul>`;
  if (!out.complete) {
    const reason = Object.hasOwn(measurementGoalReasons, out.reason)
      ? measurementGoalReasons[out.reason]
      : 'The current conversion configuration could not be completely inspected. Read it again.';
    return (
      html +
      `<p class="notice" role="status">${esc(uiText(reason))}</p>${recordDetails(out, uiText('Conversion goal scope, limits and source references'))}`
    );
  }
  const values = a =>
      !a.value_settings
        ? unknown
        : a.value_settings.default_value === null
          ? unknown
          : `<span dir="ltr">${esc(String(a.value_settings.default_value))} ${esc(a.value_settings.default_currency_code ?? '')}</span>`,
    always = a =>
      esc(
        a.value_settings?.always_use_default_value === true
          ? uiText('Yes')
          : a.value_settings?.always_use_default_value === false
            ? uiText('No')
            : uiText('Unknown'),
      );
  html += `<div class="workspace-metrics"><article><strong>${esc(uiNumber(out.summary.goals ?? 0))}</strong><span>${esc(uiText('Account-default goals'))}</span></article><article><strong>${esc(uiNumber(out.summary.biddable_goals ?? 0))}</strong><span>${esc(uiText('Biddable goals'))}</span></article><article><strong>${esc(uiNumber(out.summary.matching_primary_actions ?? 0))}</strong><span>${esc(uiText('Matching primary actions'))}</span></article></div>`;
  html += `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Account-default conversion goals'))}"><table class="review-table"><caption>${esc(uiText('Account-default conversion goals'))}</caption><thead><tr><th scope="col">${esc(uiText('Goal category'))}</th><th scope="col">${esc(uiText('Origin'))}</th><th scope="col">${esc(uiText('Biddable'))}</th><th scope="col">${esc(uiText('Matching primary actions'))}</th></tr></thead><tbody>${out.goals.map(g => `<tr><th scope="row">${native(g.category)}</th><td>${native(g.origin)}</td><td>${esc(g.biddable ? uiText('Yes') : uiText('No'))}</td><td>${esc(uiNumber(g.matching_primary_actions))}</td></tr>`).join('') || `<tr><td colspan="4">${esc(uiText('No account-default goals were returned.'))}</td></tr>`}</tbody></table></div>`;
  html += `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Primary conversion actions'))}"><table class="review-table"><caption>${esc(uiText('Primary conversion actions'))}</caption><thead><tr><th scope="col">${esc(uiText('Conversion action'))}</th><th scope="col">${esc(uiText('Goal category'))}</th><th scope="col">${esc(uiText('Status'))}</th><th scope="col">${esc(uiText('Default value'))}</th><th scope="col">${esc(uiText('Always use default value'))}</th><th scope="col">${esc(uiText('Last conversion date'))}</th><th scope="col">${esc(uiText('Last tag detected'))}</th></tr></thead><tbody>${out.primary_actions.map(a => `<tr><th scope="row"><bdi dir="auto">${esc(a.name)}</bdi><br><code dir="ltr">${esc(a.resource_name)}</code></th><td>${native(a.category)} · ${native(a.origin)}</td><td>${native(a.status)}</td><td>${values(a)}</td><td>${always(a)}</td><td>${native(a.activity?.last_conversion_date ?? null)}</td><td>${native(a.activity?.last_tag_received_time ?? null)}</td></tr>`).join('') || `<tr><td colspan="7">${esc(uiText('No enabled primary action matches a biddable goal.'))}</td></tr>`}</tbody></table></div>`;
  if (out.display_omissions?.goals > 0 || out.display_omissions?.primary_actions > 0)
    html += `<p class="form-note">${esc(uiText('Only the first 20 goals and 20 primary actions are listed; the counts above include every row read.'))}</p>`;
  return (
    html +
    `<p>${esc(uiText('Configured goals and actions are not proof that conversions are delivered, deduplicated, consented or attributed. Dates are reported by Google Ads in the account timezone. Nothing was changed and no snapshot was saved.'))}</p>${recordDetails(out, uiText('Conversion goal scope, limits and source references'))}`
  );
}
function bindMeasurementGoogleGoals(targets) {
  const form = $('#measurement-google-goals'),
    result = $('#measurement-google-goals-result');
  if (!form?.elements?.target) return;
  const begin = accountWorkflowContext(form, result);
  if (typeof location !== 'undefined') {
    const params = new URLSearchParams(location.search);
    if (params.has('google_goals')) {
      const index = targets.findIndex(
          t => t.account_id === params.get('account_id') && t.connection_id === params.get('connection_id'),
        ),
        valid =
          params.get('google_goals') === '1' &&
          ['google_goals', 'account_id', 'connection_id'].every(k => params.getAll(k).length === 1) &&
          index >= 0;
      form.elements.target.value = valid ? String(index) : '';
      result.innerHTML = `<p class="form-note" role="status">${esc(valid ? uiText('Account selected from a conversion goal link. Read current goals to refresh the evidence.') : uiText('The linked Google Ads account is unavailable. Choose a currently selected account.'))}</p>`;
    }
  }
  workspaceBind('#measurement-google-goals', async () => {
    const current = begin();
    if (!current()) return;
    const target = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !target) throw Error(uiText('Choose a Google Ads account.'));
    let out;
    try {
      out = await workspaceCall('workspace', {
        action: 'measurement_google_goals',
        gateway: 'google_ads_native_action',
        connection_id: target.connection_id,
        account_id: target.account_id,
      });
    } catch (error) {
      if (current()) throw error;
      return;
    }
    if (!current()) return;
    if (!measurementGoogleGoalsValid(out, target))
      throw Error(
        uiText('The conversion goal response is incomplete or belongs to a different selection. Read it again.'),
      );
    result.innerHTML = measurementGoogleGoalsView(out, target);
    $('#measurement-google-goals-heading')?.focus();
  });
}
// MSR-03 slice B: one GA4 property's Admin configuration. Google tags are related to its streams from the synchronized
// Tag Manager inventory, without a request; the read itself starts only on submit.
const measurementTestDimension = {
  registered: 'Registered with event scope',
  other_scope: 'Registered with another scope',
  not_registered: 'Not registered',
  not_read: 'Not read',
};
function measurementGa4ConfigMarkup(targets) {
  return `<section class="panel workspace-form">${measurementSectionHeading('measurement-section-ga4config', uiText('GA4 property configuration'))}<p>${esc(uiText('Read key events, custom dimensions and metrics, data streams, Google Ads links and data retention for one GA4 property. This reads configuration only; it does not show that events are sent or counted.'))}</p><form id="measurement-ga4-config">${measurementTargetField(targets, uiText('GA4 property'), 'Connect a GA4 property in Connections to read its configuration.', uiText('Choose a login and account'))}<button class="button primary" type="submit" ${targets.length ? '' : 'disabled'}>${esc(uiText('Read property configuration'))}</button></form><div id="measurement-ga4-config-result" aria-live="polite"></div></section>`;
}
function measurementGa4ConfigValid(out, target) {
  const text = (v, max = 300) => v === null || (typeof v === 'string' && v.length <= max),
    code = v => v === null || (typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(v)),
    list = (v, check) =>
      v === undefined ||
      (Array.isArray(v) && v.length <= 1000 && v.every(r => !!r && typeof r === 'object' && check(r)));
  return (
    !!out &&
    out.record_kind === 'measurement_ga4_config' &&
    out.provider_mutations === 0 &&
    out.complete === true &&
    out.scope?.gateway === 'ga4_native_action' &&
    out.scope.property_id === target.account_id &&
    out.scope.connection_id === target.connection_id &&
    Object.hasOwn(measurementTestDimension, out.checks?.test_identifier_dimension) &&
    // MSR-04: absent from older responses.
    [undefined, 'registered', 'not_registered', 'not_read'].includes(out.checks.realtime_identity_dimension) &&
    list(out.key_events, r => text(r.event_name, 100) && !!r.event_name && code(r.counting_method)) &&
    list(out.custom_dimensions, r => text(r.parameter_name, 100) && text(r.display_name) && code(r.scope)) &&
    list(
      out.custom_metrics,
      r =>
        text(r.parameter_name, 100) &&
        text(r.display_name) &&
        code(r.measurement_unit) &&
        Array.isArray(r.restricted_metric_types) &&
        r.restricted_metric_types.every(code),
    ) &&
    list(
      out.data_streams,
      r =>
        /^[1-9][0-9]{0,19}$/.test(r.stream_id ?? '') &&
        code(r.type) &&
        text(r.display_name) &&
        (r.measurement_id === null || /^G-[A-Z0-9]{4,20}$/.test(r.measurement_id ?? '')),
    ) &&
    list(out.google_ads_links, r => /^[0-9]{1,32}$/.test(r.customer_id ?? '')) &&
    (out.data_retention === undefined ||
      (!!out.data_retention &&
        code(out.data_retention.event_data_retention) &&
        code(out.data_retention.user_data_retention)))
  );
}
// Synchronized Tag Manager containers whose Google tag IDs include a measurement ID (stored inventory, no request).
function measurementTagContainers(measurementId) {
  let synced = false;
  const found = new Map();
  for (const c of platforms.find(p => p.id === 'gtm')?.connections ?? [])
    for (const group of c.enabled ? (c.groups ?? []) : [])
      if (group.kind === 'containers' && Array.isArray(group.assets)) {
        synced = true;
        for (const asset of group.assets)
          if (typeof asset?.id === 'string' && Array.isArray(asset.tagIds) && asset.tagIds.includes(measurementId))
            found.set(asset.id, {
              name: typeof asset.name === 'string' ? asset.name.slice(0, 200) : asset.id,
              public_id: typeof asset.publicId === 'string' ? asset.publicId : null,
            });
      }
  return {synced, containers: [...found.values()].slice(0, 10)};
}
function measurementGa4ConfigView(out, target) {
  const unknown = esc(uiText('Unknown')),
    native = v => (v === null || v === undefined || v === '' ? unknown : `<code dir="ltr">${esc(v)}</code>`),
    flag = v => esc(v === true ? uiText('Yes') : v === false ? uiText('No') : uiText('Unknown')),
    shown = rows => (rows ?? []).slice(0, 100),
    table = (caption, headers, rows, cells) =>
      rows === undefined
        ? ''
        : `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(caption)}"><table class="review-table"><caption>${esc(caption)}</caption><thead><tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${shown(rows).map(cells).join('') || `<tr><td colspan="${headers.length}">${esc(uiText('None returned.'))}</td></tr>`}</tbody></table></div>`,
    lists = ['key_events', 'custom_dimensions', 'custom_metrics', 'data_streams', 'google_ads_links'];
  const tags = stream => {
    if (!stream.measurement_id) return unknown;
    const found = measurementTagContainers(stream.measurement_id);
    if (!found.synced) return esc(uiText('Tag Manager containers are not synchronized.'));
    return found.containers.length
      ? found.containers
          .map(
            c =>
              `<bdi dir="auto">${esc(c.name)}</bdi>${c.public_id ? ` <code dir="ltr">${esc(c.public_id)}</code>` : ''}`,
          )
          .join('<br>')
      : esc(uiText('No synchronized container refers to this measurement ID.'));
  };
  let html = `<h3 id="measurement-ga4-config-heading" tabindex="-1">${esc(target.label)}</h3><p>${esc(uiText('Requested {requested} · Returned {captured}', {requested: date(out.requested_at), captured: date(out.captured_at)}))}</p>${badge('complete')}<p class="notice">${esc(uiAccountExplanation(out.meaning))}</p><p>${esc(uiText('Test identifier dimension'))}: ${esc(uiText(measurementTestDimension[out.checks.test_identifier_dimension]))}${out.checks.test_identifier_dimension === 'registered' ? '' : ' · ' + esc(uiText('Inspecting a specific GA4 test identifier needs an event-scoped amcp_test_id custom dimension.'))}</p>${out.checks.realtime_identity_dimension === undefined ? '' : `<p>${esc(uiText('User-scoped amcp_test_id for realtime test reads'))}: ${esc(uiText(out.checks.realtime_identity_dimension === 'registered' ? 'Registered with user scope' : out.checks.realtime_identity_dimension === 'not_read' ? 'Not read' : 'Not registered'))}</p>`}`;
  html += table(
    uiText('Key events'),
    [uiText('Event name'), uiText('Counting method'), uiText('Default value')],
    out.key_events,
    k =>
      `<tr><th scope="row"><code dir="ltr">${esc(k.event_name)}</code></th><td>${native(k.counting_method)}</td><td>${k.default_value?.numeric_value === null || k.default_value?.numeric_value === undefined ? unknown : `<span dir="ltr">${esc(String(k.default_value.numeric_value))} ${esc(k.default_value.currency_code ?? '')}</span>`}</td></tr>`,
  );
  html += table(
    uiText('Data streams'),
    [uiText('Stream'), uiText('Type'), uiText('Measurement ID'), uiText('Google tags in synchronized containers')],
    out.data_streams,
    s =>
      `<tr><th scope="row"><bdi dir="auto">${esc(s.display_name ?? s.stream_id)}</bdi><br><code dir="ltr">${esc(s.stream_id)}</code></th><td>${native(s.type)}</td><td>${native(s.measurement_id)}</td><td>${tags(s)}</td></tr>`,
  );
  html += table(
    uiText('Custom dimensions'),
    [uiText('Parameter'), uiText('Display name'), uiText('Scope')],
    out.custom_dimensions,
    d =>
      `<tr><th scope="row"><code dir="ltr">${esc(d.parameter_name)}</code></th><td><bdi dir="auto">${esc(d.display_name ?? '')}</bdi></td><td>${native(d.scope)}</td></tr>`,
  );
  html += table(
    uiText('Custom metrics'),
    [uiText('Parameter'), uiText('Display name'), uiText('Measurement unit'), uiText('Restricted metric types')],
    out.custom_metrics,
    m =>
      `<tr><th scope="row"><code dir="ltr">${esc(m.parameter_name)}</code></th><td><bdi dir="auto">${esc(m.display_name ?? '')}</bdi></td><td>${native(m.measurement_unit)}</td><td>${m.restricted_metric_types.map(native).join(' ') || esc(uiText('None returned.'))}</td></tr>`,
  );
  html += table(
    uiText('Google Ads links'),
    [uiText('Google Ads customer ID'), uiText('Ads personalization'), uiText('Can manage clients')],
    out.google_ads_links,
    l =>
      `<tr><th scope="row"><code dir="ltr">${esc(l.customer_id)}</code></th><td>${flag(l.ads_personalization_enabled)}</td><td>${flag(l.can_manage_clients)}</td></tr>`,
  );
  if (out.data_retention)
    html += `<section><h4>${esc(uiText('Data retention'))}</h4><ul><li>${esc(uiText('Event data retention'))}: ${native(out.data_retention.event_data_retention)}</li><li>${esc(uiText('User data retention'))}: ${native(out.data_retention.user_data_retention)}</li><li>${esc(uiText('Reset user data on new activity'))}: ${flag(out.data_retention.reset_user_data_on_new_activity)}</li></ul></section>`;
  if (lists.some(key => (out[key]?.length ?? 0) > 100))
    html += `<p class="form-note">${esc(uiText('Only the first 100 rows of each list are shown; the counts include every row read.'))}</p>`;
  return (
    html +
    `<p>${esc(uiText('Configured GA4 settings are not proof that events are sent, counted, deduplicated, consented or attributed. Nothing was changed and no snapshot was saved.'))}</p>${recordDetails(out, uiText('GA4 configuration scope, limits and source references'))}`
  );
}
function bindMeasurementGa4Config(targets) {
  const form = $('#measurement-ga4-config'),
    result = $('#measurement-ga4-config-result');
  if (!form?.elements?.target) return;
  const begin = accountWorkflowContext(form, result);
  if (typeof location !== 'undefined') {
    const params = new URLSearchParams(location.search);
    if (params.has('ga4_config')) {
      const index = targets.findIndex(
          t => t.account_id === params.get('account_id') && t.connection_id === params.get('connection_id'),
        ),
        valid =
          params.get('ga4_config') === '1' &&
          ['ga4_config', 'account_id', 'connection_id'].every(k => params.getAll(k).length === 1) &&
          index >= 0;
      form.elements.target.value = valid ? String(index) : '';
      result.innerHTML = `<p class="form-note" role="status">${esc(valid ? uiText('Property selected from a configuration link. Read current configuration to refresh the evidence.') : uiText('The linked GA4 property is unavailable. Choose a currently selected property.'))}</p>`;
    }
  }
  workspaceBind('#measurement-ga4-config', async () => {
    const current = begin();
    if (!current()) return;
    const target = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !target) throw Error(uiText('Choose a selected GA4 property first.'));
    let out;
    try {
      out = await workspaceCall('workspace', {
        action: 'measurement_ga4_config',
        gateway: 'ga4_native_action',
        connection_id: target.connection_id,
        account_id: target.account_id,
      });
    } catch (error) {
      if (current()) throw error;
      return;
    }
    if (!current()) return;
    if (!measurementGa4ConfigValid(out, target))
      throw Error(
        uiText('The GA4 configuration response is incomplete or belongs to a different selection. Read it again.'),
      );
    result.innerHTML = measurementGa4ConfigView(out, target);
    $('#measurement-ga4-config-heading')?.focus();
  });
}
// MSR-03: the measurement evidence ledger of one asset. Slice C read a Google Ads account or a GA4 property; owner
// direction P8 (2026-10-11) adds Meta, Snapchat and TikTok ad accounts with their pixels, Search Console sites and Adjust
// apps (Adjust apps are bound administratively and appear only when the workspace lists them). Six fixed layers, each
// observed, unknown, unavailable or not applicable. The website explains each reason code itself; native values stay
// literal. Choosing an account never reads; the ledger is read only on submit.
const measurementLedgerLayers = {
  configuration: 'Configuration',
  provider_observed_activity: 'Provider-observed activity',
  provider_diagnostics: 'Provider diagnostics',
  supplied_runtime_trace: 'Supplied runtime trace',
  consent: 'Consent',
  attribution_settings: 'Attribution settings',
};
const measurementLedgerStates = {
  observed: 'Observed',
  unknown: 'Unknown',
  unavailable: 'Unavailable',
  not_applicable: 'Not applicable',
};
const measurementLedgerReasons = {
  complete_configuration: 'Read completely from the provider.',
  manager_account: 'This is a manager account. Choose a client account that records its own conversions.',
  shared_conversion_customer:
    'This account uses another customer’s conversion tracking. AMCP did not read that customer, so goals stay unknown.',
  conversion_customer_unknown: 'Google Ads did not report the conversion tracking customer, so goals stay unknown.',
  configuration_incomplete: 'The configuration could not be completely inspected.',
  configuration_unknown: 'Not read, because the configuration is unknown.',
  activity_reported: 'Google Ads reported a last conversion date and a last tag detection for every primary action.',
  activity_incomplete: 'Google Ads did not report activity for every primary action.',
  key_events_reported: 'GA4 reported key events in the last 30 minutes.',
  no_recent_key_events: 'No key event was reported in the last 30 minutes. Absence does not establish a broken tag.',
  key_events_unreadable: 'No key event name can be read as an exact realtime event name.',
  no_key_events: 'The property has no key event.',
  upload_summaries: 'Offline conversion upload summaries by upload client.',
  no_uploads: 'Google Ads reported no offline conversion upload for this account.',
  action_settings: 'Attribution model and lookback windows of enabled conversion actions.',
  no_enabled_actions: 'The account has no enabled conversion action.',
  read_failed: 'This read failed or was incomplete, so the layer stays unknown.',
  browser_only: 'Supplied traces are inspected only in this browser and never reach AMCP.',
  no_provider_source: 'The provider exposes no source for this layer to AMCP.',
  unpinned_api: 'This is available only in a provider API version AMCP has not pinned.',
  unpinned_contract: 'The provider publishes no response contract AMCP could pin, so this is not read.',
  unpinned_request:
    'AMCP sends this read only as a pinned copy of the provider’s specification documents it, and this deployment has not pinned it yet, so this is not read.',
  unconfirmed_fields:
    'TikTok returned these pixel event statistics. Their field meanings are not confirmed yet, so AMCP shows them as returned and does not interpret them.',
  pixels_listed: 'The pixels the account lists, read completely from the provider.',
  no_pixels: 'The account lists no pixel.',
  pixel_not_selected: 'The account lists several pixels. Enter one pixel ID and read the ledger again.',
  pixel_not_listed: 'The pixel ID you entered is not listed for this account, so it was not read.',
  pixel_events_reported: 'Meta reported pixel events by event name in the last 24 hours.',
  pixel_domains_reported: 'Snapchat reported the domains that fired the pixel in the last 7 days.',
  no_recent_events: 'No pixel event was reported in the read window. Absence does not establish a broken pixel.',
  dataset_quality:
    'Meta dataset quality of web events: match quality, Conversions API coverage, deduplication keys and freshness.',
  quality_permission_missing:
    'Dataset quality needs the ads_management or business_management permission besides ads_read, so it was not read.',
  signal_readiness: 'Snapchat signal readiness recommendations by event type, with their priority and score.',
  no_quality_data: 'The provider reported no quality data for this pixel.',
  not_pixel_setting: 'Attribution windows are chosen per ad set, ad group or report, not on the pixel.',
  site_permission: 'The site as Search Console lists it for this login, with the login’s permission level.',
  site_unverified: 'This login is an unverified user of the site and has no access to its data.',
  search_totals_reported: 'Final daily web search clicks and impressions over the last seven complete days.',
  no_search_activity:
    'Search Console reported no final search data for the last seven days. Data can lag by several days.',
  sitemaps_listed: 'Submitted sitemaps with their errors, warnings and last download.',
  no_sitemaps: 'No sitemap is submitted for this site.',
  no_consent_setting: 'This provider has no consent setting.',
  no_attribution: 'This provider attributes no conversions.',
  event_catalog: 'The events defined for the app in Adjust.',
  daily_activity_reported: 'Installs and events Adjust reported per day over the last seven complete UTC days.',
  report_incomplete: 'Adjust returned warnings or missing totals, so the report is incomplete.',
  no_recent_activity:
    'Adjust reported no activity for the app in the last seven days. Absence does not establish broken tracking.',
};
// The related task of a layer, on this page; following it makes no request.
const measurementLedgerTasks = {
  google_ads_native_action: {configuration: 'goals', provider_observed_activity: 'goals', consent: 'gtm'},
  ga4_native_action: {configuration: 'ga4config', provider_observed_activity: 'events', consent: 'gtm'},
  meta_native_action: {consent: 'gtm'},
  snapchat_native_action: {consent: 'gtm'},
  tiktok_native_action: {consent: 'gtm'},
  google_search_console_native_action: {},
  adjust_native_action: {},
};
// The gateways whose ledger reads one pixel or dataset of the selected account.
const measurementLedgerPixelGateways = ['meta_native_action', 'snapchat_native_action', 'tiktok_native_action'],
  measurementLedgerPixel = v => typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(v);
function measurementLedgerMarkup(targets) {
  return `<section class="panel workspace-form">${measurementSectionHeading('measurement-section-ledger', uiText('Measurement evidence ledger'))}<p>${esc(uiText('Collect configuration, provider-observed activity, diagnostics, consent and attribution evidence for one advertising account, GA4 property, Search Console site or app in one view. Each layer says whether it was observed, is unknown, is unavailable or does not apply.'))}</p><form id="measurement-ledger">${measurementTargetField(targets, uiText('Account, property, site or app'), 'Connect an advertising, analytics or Search Console account in Connections to read its measurement evidence ledger.')}<label>${esc(uiText('Pixel or dataset ID (optional)'))}<input name="pixel_id" type="text" maxlength="64" autocomplete="off" spellcheck="false" dir="ltr" aria-describedby="measurement-ledger-pixel-help"></label><p class="form-note" id="measurement-ledger-pixel-help">${esc(uiText('Only for a Meta, Snapchat or TikTok account. The ledger lists the account’s pixels first and reads the only pixel, or the one you enter here.'))}</p><button class="button primary" type="submit" ${targets.length ? '' : 'disabled'}>${esc(uiText('Read the evidence ledger'))}</button></form><div id="measurement-ledger-result" aria-live="polite"></div></section>`;
}
function measurementLedgerValid(out, target, pixel) {
  const code = v => typeof v === 'string' && /^[a-z_]{1,64}$/.test(v),
    counts = out?.summary;
  return (
    !!out &&
    out.record_kind === 'measurement_ledger' &&
    out.provider_mutations === 0 &&
    out.scope?.gateway === target.gateway &&
    Object.hasOwn(measurementLedgerTasks, target.gateway) &&
    out.scope.account_id === target.account_id &&
    out.scope.connection_id === target.connection_id &&
    // A pixel ledger names the pixel it read, or none; when a pixel was entered, it is that one.
    (measurementLedgerPixelGateways.includes(target.gateway)
      ? out.scope.pixel_id === null ||
        (measurementLedgerPixel(out.scope.pixel_id) && (!pixel || out.scope.pixel_id === pixel))
      : out.scope.pixel_id === undefined) &&
    Array.isArray(out.layers) &&
    out.layers.map(l => l?.layer).join() === Object.keys(measurementLedgerLayers).join() &&
    out.layers.every(
      l =>
        Object.hasOwn(measurementLedgerStates, l.state) &&
        code(l.reason) &&
        (l.evidence === null || (typeof l.evidence === 'object' && !Array.isArray(l.evidence))),
    ) &&
    !!counts &&
    Object.keys(measurementLedgerStates).every(s => counts[s] === out.layers.filter(l => l.state === s).length) &&
    // A failed read carries only its error code and the provider's allow-listed facts, never partial rows.
    out.layers.every(
      l =>
        l.reason !== 'read_failed' ||
        (l.state === 'unknown' &&
          !!l.evidence &&
          Object.keys(l.evidence).every(key => ['error', 'http_status', 'provider_code', 'request_id'].includes(key)) &&
          /^[A-Z][A-Z0-9_]{0,63}$/.test(l.evidence.error ?? '')),
    )
  );
}
function measurementLedgerEvidence(l, gateway) {
  const e = l.evidence ?? {},
    unknown = esc(uiText('Unknown')),
    native = v => (v === null || v === undefined || v === '' ? unknown : `<code dir="ltr">${esc(String(v))}</code>`),
    list = rows => (rows.length ? `<ul class="measurement-ledger-list">${rows.join('')}</ul>` : ''),
    rows = v => (Array.isArray(v) ? v.slice(0, 5) : []),
    count = v => (Number.isSafeInteger(v) ? uiNumber(v) : '0'),
    percent = v =>
      typeof v === 'number' && Number.isFinite(v)
        ? `<span dir="ltr">${esc(uiNumber(v / 100, {style: 'percent', maximumFractionDigits: 1}))}</span>`
        : unknown,
    more = (v, total) =>
      Number.isSafeInteger(total) && total > Math.min(5, Array.isArray(v) ? v.length : 0)
        ? `<p class="form-note">${esc(uiText('{shown} of {total} shown.', {shown: Math.min(5, Array.isArray(v) ? v.length : 0), total: uiNumber(total)}))}</p>`
        : '';
  const pixel = measurementLedgerPixelGateways.includes(gateway);
  // A provider's refusal keeps its HTTP status, error code and request ID (allow-listed facts, never its message).
  const providerStatus =
      Number.isInteger(e.http_status) && e.http_status >= 400 && e.http_status <= 599 ? e.http_status : null,
    providerCode =
      Number.isSafeInteger(e.provider_code) ||
      (typeof e.provider_code === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(e.provider_code))
        ? String(e.provider_code)
        : null,
    providerRequest =
      typeof e.request_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:+=\/-]{0,127}$/.test(e.request_id)
        ? e.request_id
        : null;
  if (typeof e.error === 'string')
    return `${esc(uiText('Error code'))}: ${native(e.error)}${providerStatus !== null ? ` ${esc(uiText('Provider response: HTTP {status}.', {status: providerStatus}))}` : ''}${providerCode !== null ? ` ${esc(uiText('Provider code: {code}.', {code: providerCode}))}` : ''}${providerRequest !== null ? ` ${esc(uiText('Provider request ID: {id}.', {id: providerRequest}))}` : ''}`;
  if (l.state !== 'observed') {
    if (
      l.layer === 'provider_observed_activity' &&
      gateway === 'google_ads_native_action' &&
      l.reason === 'activity_incomplete'
    )
      return esc(
        uiText(
          '{conversions} of {actions} primary actions report a last conversion; {tags} report a last tag detection.',
          {
            conversions: uiNumber(e.primary_last_conversion_known ?? 0),
            actions: uiNumber(e.matching_primary_actions ?? 0),
            tags: uiNumber(e.primary_last_tag_known ?? 0),
          },
        ),
      );
    if (l.layer === 'provider_observed_activity' && gateway === 'ga4_native_action' && Array.isArray(e.events))
      return list(
        rows(e.events).map(
          v =>
            `<li><code dir="ltr">${esc(v.event_name)}</code>: ${v.reported_count === null ? esc(uiText('None reported')) : native(v.reported_count)}</li>`,
        ),
      );
    if (l.layer === 'provider_observed_activity' && gateway === 'meta_native_action' && 'last_fired_time' in e)
      return `${esc(uiText('Last fired'))} ${native(e.last_fired_time)}`;
    // MSR-03: TikTok's statistics as returned, each value literal, with no meaning claimed for any field. Paths and values
    // are TikTok's own: escape-by-default markup (WEB-07).
    if (l.reason === 'unconfirmed_fields' && Array.isArray(e.fields)) {
      const shown = e.fields.slice(0, 20),
        value = v =>
          v === null
            ? html`<code dir="ltr">null</code>`
            : v === undefined || v === ''
              ? uiText('Unknown')
              : html`<code dir="ltr">${String(v)}</code>`;
      return String(
        html`${uiText('{start} to {end} in UTC days; TikTok’s day basis is not confirmed.', {start: e.window?.start_date ?? '', end: e.window?.end_date ?? ''})}${shown.length ? html`<ul class="measurement-ledger-list">${shown.map(f => html`<li><code dir="ltr">${String(f.path)}</code>: ${value(f.value)}</li>`)}</ul>` : ''}${Number.isSafeInteger(e.field_count) && e.field_count > shown.length ? html`<p class="form-note">${uiText('{shown} of {total} shown.', {shown: uiNumber(shown.length), total: uiNumber(e.field_count)})}</p>` : ''}`,
      );
    }
    if (l.reason === 'report_incomplete' && Number.isSafeInteger(e.warnings))
      return esc(uiText('{count} provider warnings', {count: uiNumber(e.warnings)}));
    return '';
  }
  if (l.layer === 'configuration' && gateway === 'google_ads_native_action')
    return esc(
      uiText('{goals} account-default goals · {actions} matching primary actions', {
        goals: uiNumber(e.summary?.goals ?? 0),
        actions: uiNumber(e.summary?.matching_primary_actions ?? 0),
      }),
    );
  if (l.layer === 'configuration' && gateway === 'ga4_native_action')
    return `${esc(uiText('{events} key events · {streams} data streams', {events: uiNumber(e.summary?.key_events ?? 0), streams: uiNumber(e.summary?.data_streams ?? 0)}))}${list(rows(e.data_streams).map(s => `<li><code dir="ltr">${esc(s.stream_id)}</code> ${native(s.type)} ${s.measurement_id ? native(s.measurement_id) : ''}</li>`))}`;
  if (l.layer === 'configuration' && pixel) {
    const detail = p =>
      gateway === 'meta_native_action'
        ? ` · ${esc(uiText('Last fired'))} ${native(p.last_fired_time)}${p.is_unavailable === true ? ' · ' + esc(uiText('Unavailable')) : ''}`
        : gateway === 'snapchat_native_action'
          ? ` · ${native(p.effective_status ?? p.status)}`
          : ` · ${esc(p.owned === true ? uiText('Owned') : p.owned === false ? uiText('Shared or unbound') : uiText('Ownership unknown'))}`;
    return `${esc(uiText('{count} pixels listed', {count: count(e.pixel_count)}))}${list(
      rows(e.pixels).map(p => {
        const id = p.id ?? p.pixel_id,
          name = p.name ?? p.pixel_name;
        return `<li><code dir="ltr">${esc(String(id))}</code>${name ? ` <bdi dir="auto">${esc(name)}</bdi>` : ''}${detail(p)}${id === e.selected_pixel ? ' · <strong>' + esc(uiText('Selected')) + '</strong>' : ''}</li>`;
      }),
    )}${more(e.pixels, e.pixel_count)}`;
  }
  if (l.layer === 'configuration' && gateway === 'google_search_console_native_action')
    return `${native(e.site_url)} · ${esc(uiText('Permission'))} ${native(e.permission_level)}`;
  if (l.layer === 'configuration' && gateway === 'adjust_native_action')
    return `${esc(uiText('{count} events defined', {count: count(e.event_count)}))}${list(rows(e.events).map(v => `<li><code dir="ltr">${esc(String(v.id))}</code>${v.name ? ` <bdi dir="auto">${esc(v.name)}</bdi>` : ''}</li>`))}${more(e.events, e.event_count)}`;
  if (l.layer === 'provider_observed_activity' && gateway === 'google_ads_native_action')
    return list(
      rows(e.primary_actions).map(
        a =>
          `<li><bdi dir="auto">${esc(a.name ?? a.resource_name)}</bdi>: ${esc(uiText('Last conversion date'))} ${native(a.last_conversion_date)} · ${esc(uiText('Last tag detected'))} ${native(a.last_tag_received_time)}</li>`,
      ),
    );
  if (l.layer === 'provider_observed_activity' && gateway === 'ga4_native_action')
    return list(
      rows(e.events).map(
        v =>
          `<li><code dir="ltr">${esc(v.event_name)}</code>: ${v.reported_count === null ? esc(uiText('None reported')) : native(v.reported_count)}</li>`,
      ),
    );
  if (l.layer === 'provider_observed_activity' && gateway === 'meta_native_action')
    return `${esc(uiText('Last {hours} hours', {hours: count(e.window_hours)}))} · ${esc(uiText('Last fired'))} ${native(e.last_fired_time)}${list(rows(e.events).map(v => `<li><code dir="ltr">${esc(v.event_name)}</code>: ${native(v.count)}</li>`))}${more(e.events, e.event_count)}`;
  if (l.layer === 'provider_observed_activity' && gateway === 'snapchat_native_action')
    return `${esc(uiText('{events} events from {domains} domains in the last 7 days', {events: count(e.total_events), domains: count(e.domain_count)}))}${list(rows(e.domains).map(d => `<li><code dir="ltr">${esc(d.domain_name)}</code>: ${native(d.total_events)}</li>`))}${more(e.domains, e.domain_count)}`;
  if (l.layer === 'provider_observed_activity' && gateway === 'google_search_console_native_action')
    return esc(
      uiText('{clicks} clicks · {impressions} impressions on {days} reported days ({start} to {end}, Pacific time)', {
        clicks: count(e.clicks),
        impressions: count(e.impressions),
        days: count(e.days_reported),
        start: e.start_date,
        end: e.end_date,
      }),
    );
  if (l.layer === 'provider_observed_activity' && gateway === 'adjust_native_action')
    return `${esc(uiText('Installs {installs} · Events {events} from {start} to {end} (UTC)', {installs: e.totals?.installs ?? uiText('Unknown'), events: e.totals?.events ?? uiText('Unknown'), start: e.start_date, end: e.end_date}))}${list(rows(e.days).map(d => `<li><code dir="ltr">${esc(d.day)}</code>: ${native(d.installs)} · ${native(d.events)}</li>`))}`;
  if (l.layer === 'provider_diagnostics' && gateway === 'meta_native_action')
    return (
      list(
        rows(e.events).map(
          v =>
            `<li><code dir="ltr">${esc(v.event_name)}</code>: ${v.composite_score === null ? `${esc(uiText('Match quality'))} ${unknown}` : esc(uiText('Match quality {score} of 10', {score: uiNumber(v.composite_score)}))} · ${esc(uiText('Conversions API coverage'))} ${percent(v.event_coverage_percentage)} · ${esc(uiText('Upload frequency'))} ${native(v.upload_frequency)}${rows(
              v.dedupe_keys,
            )
              .map(
                k => ` · ${esc(uiText('Deduplication key'))} ${native(k.dedupe_key)} ${percent(k.server_percentage)}`,
              )
              .join('')}</li>`,
        ),
      ) + more(e.events, e.event_count)
    );
  if (l.layer === 'provider_diagnostics' && gateway === 'snapchat_native_action')
    return (
      list(
        rows(e.scores).map(
          s =>
            `<li><code dir="ltr">${esc(s.event_type)}</code> ${native(s.action_source)} ${native(s.event_source)}${list(rows(s.recommendations).map(r => `<li>${native(r.recommendation_code)} · ${native(r.priority)} · ${native(r.score)}${r.title ? ` · <bdi dir="auto">${esc(r.title)}</bdi>` : ''}</li>`))}</li>`,
        ),
      ) + more(e.scores, e.score_count)
    );
  if (l.layer === 'provider_diagnostics' && gateway === 'google_search_console_native_action')
    return `${esc(uiText('{errors} with errors · {warnings} with warnings · {pending} pending', {errors: count(e.with_errors), warnings: count(e.with_warnings), pending: count(e.pending)}))}${list(rows(e.sitemaps).map(s => `<li><code dir="ltr">${esc(s.path)}</code>: ${esc(uiText('Errors'))} ${native(s.errors)} · ${esc(uiText('Warnings'))} ${native(s.warnings)} · ${esc(uiText('Last downloaded'))} ${native(s.last_downloaded)}</li>`))}${more(e.sitemaps, e.sitemap_count)}`;
  if (l.layer === 'provider_diagnostics')
    return (
      list(
        rows(e.upload_summaries).map(
          s =>
            `<li>${native(s.client)} · ${native(s.status)} · ${esc(uiText('Success rate'))} ${s.success_rate === null ? unknown : `<span dir="ltr">${esc(uiNumber(s.success_rate, {style: 'percent', maximumFractionDigits: 1}))}</span>`} · ${esc(uiText('Last upload'))} ${native(s.last_upload_date_time)}${Number.isSafeInteger(s.alert_count) && s.alert_count ? ` · ${esc(uiText('{count} alerts', {count: uiNumber(s.alert_count)}))}` : ''}</li>`,
        ),
      ) + more(e.upload_summaries, e.summary_count)
    );
  if (l.layer === 'attribution_settings')
    return (
      list(
        rows(e.actions).map(
          a =>
            `<li><bdi dir="auto">${esc(a.name)}</bdi>: ${native(a.attribution_model)} · ${esc(uiText('Click-through window'))} ${a.click_through_lookback_window_days === null ? unknown : esc(uiText('{days} days', {days: uiNumber(a.click_through_lookback_window_days)}))} · ${esc(uiText('View-through window'))} ${a.view_through_lookback_window_days === null ? unknown : esc(uiText('{days} days', {days: uiNumber(a.view_through_lookback_window_days)}))}</li>`,
        ),
      ) + more(e.actions, e.action_count)
    );
  return '';
}
function measurementLedgerView(out, target) {
  const tasks = measurementLedgerTasks[out.scope.gateway],
    link = l => {
      const task = l.layer === 'supplied_runtime_trace' ? 'trace' : tasks[l.layer];
      return task
        ? `<a href="#measurement-section-${task}">${esc(uiText(task === 'trace' ? 'Inspect a sanitized event trace' : task === 'gtm' ? 'Google Tag Manager configuration audit' : task === 'goals' ? 'Google Ads conversion goals' : task === 'ga4config' ? 'GA4 property configuration' : 'Recent GA4 events'))}</a>`
        : '';
    };
  const summary = Object.entries(measurementLedgerStates)
    .map(
      ([state, label]) =>
        `<article><strong>${esc(uiNumber(out.summary[state]))}</strong><span>${esc(uiText(label))}</span></article>`,
    )
    .join('');
  const body = out.layers
    .map(
      l =>
        `<tr><th scope="row">${esc(uiText(measurementLedgerLayers[l.layer]))}</th><td><span class="measurement-ledger-state measurement-ledger-${esc(l.state)}">${esc(uiText(measurementLedgerStates[l.state]))}</span></td><td>${esc(Object.hasOwn(measurementLedgerReasons, l.reason) ? uiText(measurementLedgerReasons[l.reason]) : l.reason)}${link(l) ? `<br>${link(l)}` : ''}</td><td>${measurementLedgerEvidence(l, out.scope.gateway)}</td></tr>`,
    )
    .join('');
  const pixel = out.scope.pixel_id
    ? `<p>${esc(uiText('Pixel or dataset ID'))}: <code dir="ltr">${esc(out.scope.pixel_id)}</code></p>`
    : '';
  return `<h3 id="measurement-ledger-heading" tabindex="-1">${esc(target.label)}</h3>${pixel}<p>${esc(uiText('Requested {requested} · Returned {captured}', {requested: date(out.requested_at), captured: date(out.captured_at)}))}</p><p class="notice">${esc(uiAccountExplanation(out.meaning))}</p><div class="workspace-metrics">${summary}</div><div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Evidence layers'))}"><table class="review-table measurement-ledger"><caption>${esc(uiText('Evidence layers'))}</caption><thead><tr><th scope="col">${esc(uiText('Layer'))}</th><th scope="col">${esc(uiText('State'))}</th><th scope="col">${esc(uiText('What this means'))}</th><th scope="col">${esc(uiText('Evidence'))}</th></tr></thead><tbody>${body}</tbody></table></div><p>${esc(uiText('Configuration and reported activity do not prove that conversions are delivered, deduplicated, consented or attributed. Nothing was changed and no snapshot was saved.'))}</p>${recordDetails(out, uiText('Evidence ledger scope, limits and source references'))}`;
}
function bindMeasurementLedger(targets) {
  const form = $('#measurement-ledger'),
    result = $('#measurement-ledger-result');
  if (!form?.elements?.target) return;
  const begin = accountWorkflowContext(form, result);
  if (typeof location !== 'undefined') {
    const params = new URLSearchParams(location.search);
    if (params.has('ledger')) {
      const index = targets.findIndex(
          t =>
            t.gateway === params.get('gateway') &&
            t.account_id === params.get('account_id') &&
            t.connection_id === params.get('connection_id'),
        ),
        pixel = params.get('pixel_id'),
        valid =
          params.get('ledger') === '1' &&
          ['ledger', 'gateway', 'account_id', 'connection_id'].every(k => params.getAll(k).length === 1) &&
          index >= 0 &&
          (!params.has('pixel_id') ||
            (params.getAll('pixel_id').length === 1 &&
              measurementLedgerPixelGateways.includes(targets[index].gateway) &&
              measurementLedgerPixel(pixel)));
      form.elements.target.value = valid ? String(index) : '';
      if (form.elements.pixel_id) form.elements.pixel_id.value = valid && pixel ? pixel : '';
      result.innerHTML = `<p class="form-note" role="status">${esc(valid ? uiText('Account selected from an evidence ledger link. Read the ledger to refresh the evidence.') : uiText('The linked account is unavailable. Choose a currently selected account, property, site or app.'))}</p>`;
    }
  }
  workspaceBind('#measurement-ledger', async () => {
    const current = begin();
    if (!current()) return;
    const target = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !target) throw Error(uiText('Choose an account, property, site or app.'));
    const pixel = (form.elements.pixel_id?.value ?? '').trim();
    if (pixel && !measurementLedgerPixelGateways.includes(target.gateway))
      throw Error(uiText('A pixel ID applies only to a Meta, Snapchat or TikTok account.'));
    if (pixel && !measurementLedgerPixel(pixel))
      throw Error(uiText('Use the exact pixel or dataset ID the account lists.'));
    let out;
    try {
      out = await workspaceCall('workspace', {
        action: 'measurement_ledger',
        gateway: target.gateway,
        connection_id: target.connection_id,
        account_id: target.account_id,
        ...(pixel ? {requirements: {pixel_id: pixel}} : {}),
      });
    } catch (error) {
      if (current()) throw error;
      return;
    }
    if (!current()) return;
    if (!measurementLedgerValid(out, target, pixel))
      throw Error(
        uiText('The evidence ledger response is incomplete or belongs to a different selection. Read it again.'),
      );
    result.innerHTML = measurementLedgerView(out, target);
    $('#measurement-ledger-heading')?.focus();
  });
}
function measurementConversionsMarkup(targets) {
  return `<section class="panel workspace-form">${measurementSectionHeading('measurement-section-conversions', uiText('LinkedIn conversion settings'))}<p>${esc(uiText('Inspect current conversion rules, attribution windows and configured values for one selected account.'))}</p><form id="measurement-conversions">${measurementTargetField(targets, uiText('LinkedIn advertising account'), 'Connect LinkedIn and select an ad account to inspect conversion settings.')}<button class="button" type="submit" ${targets.length ? '' : 'disabled'}>${esc(uiText('Read conversion settings'))}</button></form><div id="measurement-conversions-result"></div></section>`;
}
function bindMeasurementConversions(targets) {
  const form = $('#measurement-conversions'),
    result = $('#measurement-conversions-result'),
    begin = accountWorkflowContext(form, result);
  if (typeof location !== 'undefined') {
    const params = new URLSearchParams(location.search);
    if (params.has('conversion_rules')) {
      const index = targets.findIndex(
          t => t.account_id === params.get('account_id') && t.connection_id === params.get('connection_id'),
        ),
        valid =
          params.get('conversion_rules') === '1' &&
          ['conversion_rules', 'account_id', 'connection_id'].every(k => params.getAll(k).length === 1) &&
          index >= 0;
      form.elements.target.value = valid ? String(index) : '';
      result.innerHTML = `<p class="form-note" role="status">${esc(valid ? uiText('Account selected from a conversion link. Read current settings to refresh the evidence.') : uiText('The linked conversion account is unavailable. Choose a currently selected account.'))}</p>`;
    }
  }
  workspaceBind('#measurement-conversions', async form => {
    const current = begin();
    if (!current()) return;
    const target = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !target) throw Error(uiText('Choose a LinkedIn advertising account.'));
    let out;
    try {
      out = await workspaceCall('workspace', {
        action: 'measurement_conversions',
        gateway: 'linkedin_native_action',
        connection_id: target.connection_id,
        account_id: target.account_id,
      });
    } catch (error) {
      if (current()) throw error;
      return;
    }
    if (!current()) return;
    const seen = new Set();
    if (
      !out ||
      out.record_kind !== 'conversion_rules' ||
      out.complete !== true ||
      !Number.isSafeInteger(out.captured_at) ||
      out.captured_at < 1 ||
      !Array.isArray(out.rules) ||
      out.rules.length > 1000 ||
      out.rule_count !== out.rules.length ||
      out.scope?.gateway !== 'linkedin_native_action' ||
      out.scope.account_id !== target.account_id ||
      out.scope.connection_id !== target.connection_id ||
      (out.collection_request !== undefined &&
        (!out.collection_request ||
          typeof out.collection_request !== 'object' ||
          Array.isArray(out.collection_request) ||
          Object.keys(out.collection_request).length !== 3 ||
          out.collection_request.finder !== 'account' ||
          out.collection_request.ownership_selection !== 'provider_default_owned' ||
          out.collection_request.shared_rules_requested !== false)) ||
      out.rules.some(r => {
        if (
          !r ||
          typeof r !== 'object' ||
          typeof r.id !== 'string' ||
          !/^[1-9][0-9]{0,19}$/.test(r.id) ||
          seen.has(r.id)
        )
          return true;
        seen.add(r.id);
        return (
          [r.name, r.type, r.attribution_type, r.value_type].some(
            v => v !== null && (typeof v !== 'string' || v.length > 256 || /[\x00-\x1f\x7f]/.test(v)),
          ) ||
          [r.conversion_method, r.ownership_type].some(
            v => v != null && (typeof v !== 'string' || !v.trim() || v.length > 100 || /[\x00-\x1f\x7f]/.test(v)),
          ) ||
          (r.enabled !== null && typeof r.enabled !== 'boolean') ||
          [r.post_click_days, r.post_view_days].some(
            v => v !== null && (!Number.isSafeInteger(v) || v < 0 || v > 365),
          ) ||
          // Observed activity (MSR-04): absent from older responses, null when LinkedIn reports none (unknown).
          [r.last_callback_at, r.latest_first_party_callback_at].some(
            v => v != null && (!Number.isSafeInteger(v) || v < 1),
          ) ||
          (r.value !== null &&
            (!r.value ||
              typeof r.value.amount !== 'string' ||
              !/^-?\d{1,30}(?:\.\d{1,18})?$/.test(r.value.amount) ||
              typeof r.value.currency !== 'string' ||
              !/^[A-Z]{3}$/.test(r.value.currency)))
        );
      })
    )
      throw Error(uiText('Conversion evidence changed or is incomplete. Read current settings again.'));
    result.innerHTML = `<h3 id="conversion-settings-heading" tabindex="-1">${esc(uiText('Current conversion configuration'))}</h3><p>${esc(target.label)} · ${esc(date(out.captured_at))}</p><p class="notice">${esc(uiText('These are current rule settings. Campaign links, event delivery, deduplication, consent and historical attribution remain unverified. Omitted fields stay unknown. No rule was changed and no snapshot was saved.'))}</p><p class="form-note" id="conversion-collection-scope">${esc(uiText("This view requests LinkedIn's default owned-rule selection. Shared rules are not requested. Missing method or ownership fields stay unknown."))}</p><label>${esc(uiText('Find a conversion rule'))}<input id="conversion-rule-search" type="search" maxlength="150" aria-describedby="conversion-rule-search-help"></label><p class="form-note" id="conversion-rule-search-help">${esc(uiText('Search name, ID, type, method or ownership.'))}</p><div id="conversion-rule-rows"></div>${recordDetails(out, uiText('Conversion configuration source references'))}`;
    mountConversionRuleRows(out.rules, current);
    $('#conversion-settings-heading').focus();
  });
}
function mountConversionRuleRows(rules, selectionCurrent) {
  const root = $('#conversion-rule-rows'),
    field = $('#conversion-rule-search'),
    current = () => root.isConnected && field.isConnected && selectionCurrent(),
    unknown = () => esc(uiText('Unknown')),
    nativeMetadata = value => (value == null ? unknown() : '<code dir="ltr">' + esc(value) + '</code>'),
    days = value => (value == null ? unknown() : esc(uiText('{count} days', {count: uiNumber(value)}))),
    // MSR-04: LinkedIn's last-fired times; a missing time stays Unknown, never "never fired".
    observed = r =>
      r.last_callback_at == null && r.latest_first_party_callback_at == null
        ? unknown()
        : [
            r.last_callback_at == null ? '' : esc(uiText('Last fired: {time}', {time: uiDate(r.last_callback_at)})),
            r.latest_first_party_callback_at == null
              ? ''
              : esc(uiText('Latest first-party callback: {time}', {time: uiDate(r.latest_first_party_callback_at)})),
          ]
            .filter(Boolean)
            .join('<br>'),
    attribution = value =>
      value === 'LAST_TOUCH_BY_CAMPAIGN'
        ? uiText('Last touch for each campaign')
        : value === 'LAST_TOUCH_BY_CONVERSION'
          ? uiText('Last touch across campaigns')
          : (value ?? uiText('Unknown'));
  let offset = 0,
    needle = '';
  const render = (focus = false) => {
    if (!current()) return;
    const rows = rules.filter(
        r =>
          !needle ||
          [r.id, r.name, r.type, r.conversion_method, r.ownership_type].some(
            v => typeof v === 'string' && v.toLowerCase().includes(needle),
          ),
      ),
      page = rows.slice(offset, offset + 50);
    root.innerHTML =
      (rows.length
        ? `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Conversion settings, scroll for all fields'))}"><table class="review-table"><caption>${esc(uiText('Native conversion rule settings'))}</caption><thead><tr><th scope="col">${esc(uiText('Conversion rule'))}</th><th scope="col">${esc(uiText('Native conversion type'))}</th><th scope="col">${esc(uiText('Registration method'))}</th><th scope="col">${esc(uiText('Reported ownership'))}</th><th scope="col">${esc(uiText('Enabled'))}</th><th scope="col">${esc(uiText('Post-click window'))}</th><th scope="col">${esc(uiText('Post-view window'))}</th><th scope="col">${esc(uiText('Attribution model'))}</th><th scope="col">${esc(uiText('Configured conversion value'))}</th><th scope="col">${esc(uiText('Observed activity'))}</th></tr></thead><tbody>${page.map(r => `<tr><th scope="row"><span dir="auto">${esc(r.name || uiText('Unnamed conversion'))}</span><br><code dir="ltr">${esc(r.id)}</code></th><td>${r.type == null ? unknown() : `<code dir="ltr">${esc(r.type)}</code>`}</td><td>${nativeMetadata(r.conversion_method)}</td><td>${nativeMetadata(r.ownership_type)}</td><td>${esc(r.enabled === true ? uiText('Enabled') : r.enabled === false ? uiText('Disabled') : uiText('Unknown'))}</td><td>${days(r.post_click_days)}</td><td>${days(r.post_view_days)}</td><td>${esc(attribution(r.attribution_type))}</td><td>${r.value == null ? unknown() : `<span dir="ltr">${esc(r.value.amount)} ${esc(r.value.currency)}</span>`}<br>${r.value_type == null ? unknown() : `<code dir="ltr">${esc(r.value_type)}</code>`}</td><td>${observed(r)}</td></tr>`).join('')}</tbody></table></div><p class="form-note" id="conversion-observed-activity-note">${esc(uiText('Observed activity is the last time LinkedIn reports a rule’s URL match fired. LinkedIn may take about 20 minutes to update it. Unknown means LinkedIn reported no time, not that the rule never fired; a time does not verify event delivery.'))}</p>`
        : `<p>${esc(needle ? uiText('No conversion rules match this search') : uiText('No conversion rules were returned for this account.'))}</p>`) +
      `<div class="report-pagination"><p id="conversion-rule-status" role="status" tabindex="-1">${esc(uiText('Showing {shown} of {matched} matching rules; {total} collected', {shown: uiNumber(page.length), matched: uiNumber(rows.length), total: uiNumber(rules.length)}))}</p><div><button class="button small" type="button" id="conversion-rule-previous">${esc(uiText('Previous page'))}</button><button class="button small" type="button" id="conversion-rule-next">${esc(uiText('Next page'))}</button></div></div>`;
    $('#conversion-rule-previous').disabled = offset === 0;
    $('#conversion-rule-next').disabled = offset + 50 >= rows.length;
    $('#conversion-rule-previous').addEventListener('click', () => {
      if (current() && offset >= 50) {
        offset -= 50;
        render(true);
      }
    });
    $('#conversion-rule-next').addEventListener('click', () => {
      if (current() && offset + 50 < rows.length) {
        offset += 50;
        render(true);
      }
    });
    if (focus) $('#conversion-rule-status').focus();
  };
  field.addEventListener('input', () => {
    if (!current()) return;
    needle = field.value.slice(0, 150).trim().toLowerCase();
    offset = 0;
    render();
  });
  render();
}
// MSR-01: the audit groups unresolved trigger references by trigger ID. A grouped row is shown only when its counts
// and bounded sample are well formed; otherwise the finding renders exactly as before.
function gtmFindingRow(f) {
  const grouped =
    f.code === 'UNRESOLVED_OR_SYSTEM_TRIGGER' &&
    f.grouping === 'trigger_id' &&
    Number.isSafeInteger(f.entity_count) &&
    f.entity_count > 0 &&
    Number.isSafeInteger(f.tag_count) &&
    f.tag_count >= 0 &&
    f.tag_count <= f.entity_count &&
    Array.isArray(f.sample_paths) &&
    f.sample_paths.length >= 1 &&
    f.sample_paths.length <= 20 &&
    f.sample_paths.every(value => typeof value === 'string' && value.length <= 512);
  return `<article><h4>${esc(uiGtmFindingLabel(f.code))} · ${esc(uiGtmFindingSeverity(f.severity))}</h4><p>${esc(uiGtmFindingMessage(f))}</p>${grouped ? `<p>${esc(uiText('Referenced by {count} entities, including {tags} tags.', {count: uiNumber(f.entity_count), tags: uiNumber(f.tag_count)}))}</p><details><summary>${esc(uiText('Referencing paths'))}</summary><ul>${f.sample_paths.map(value => `<li><code dir="ltr">${esc(value)}</code></li>`).join('')}</ul>${f.sample_paths_truncated === true ? `<p class="form-note">${esc(uiText('Only the first 20 referencing paths are listed.'))}</p>` : ''}</details>` : ''}<p><code dir="ltr">${esc(f.code)}</code></p><code dir="ltr">${esc(f.path)}</code></article>`;
}
const gtmFindingSeverities = ['all', 'error', 'warning', 'unknown'];
function gtmFindingsList(findings, severity = 'all', page = 0) {
  const rows = findings.filter(f => severity === 'all' || f?.severity === severity),
    last = Math.max(0, Math.ceil(rows.length / 25) - 1),
    current = Math.min(Math.max(0, page), last),
    shown = rows.slice(current * 25, current * 25 + 25);
  return (
    (shown.map(gtmFindingRow).join('') ||
      `<p>${esc(findings.length ? uiText('No findings match this severity.') : uiText('No configuration finding was returned for this scope.'))}</p>`) +
    (rows.length > 25
      ? `<div class="report-pagination"><p id="gtm-findings-status" role="status" tabindex="-1">${esc(uiText('Showing {shown} of {total} matching findings', {shown: uiNumber(shown.length), total: uiNumber(rows.length)}))}</p><div><button type="button" class="button small" id="gtm-findings-previous" ${current ? '' : 'disabled'}>${esc(uiText('Previous page'))}</button><button type="button" class="button small" id="gtm-findings-next" ${current < last ? '' : 'disabled'}>${esc(uiText('Next page'))}</button></div></div>`
      : '')
  );
}
function gtmFindingsMarkup(c, findings) {
  const total = Number.isSafeInteger(c.finding_count) && c.finding_count >= findings.length ? c.finding_count : null,
    truncated = c.finding_list === 'truncated' || c.findings_truncated === true;
  return `${truncated ? `<p class="notice">${esc(uiText(c.complete ? 'This list shows {shown} of {total} findings, errors and warnings first. Every configuration read completed; only the list is shortened.' : 'This list shows {shown} of {total} findings, errors and warnings first.', {shown: uiNumber(findings.length), total: total === null ? uiText('Unknown') : uiNumber(total)}))}</p>` : ''}${findings.length ? `<div class="work-filter"><label>${esc(uiText('Severity'))}<select id="gtm-findings-severity">${gtmFindingSeverities.map(value => `<option value="${value}">${esc(value === 'all' ? uiText('All severities') : uiGtmFindingSeverity(value))}</option>`).join('')}</select></label></div>` : ''}<div id="gtm-findings-list">${gtmFindingsList(findings)}</div>`;
}
function mountGtmFindings(findings, selectionCurrent) {
  if (!findings.length) return;
  const filter = $('#gtm-findings-severity'),
    list = $('#gtm-findings-list'),
    generation = navigationGeneration,
    identity = identityGeneration,
    current = () =>
      generation === navigationGeneration &&
      identity === identityGeneration &&
      list.isConnected &&
      filter.isConnected &&
      selectionCurrent();
  let page = 0;
  const bind = () => {
    for (const [id, step] of [
      ['#gtm-findings-previous', -1],
      ['#gtm-findings-next', 1],
    ]) {
      const button = $(id);
      if (!button) continue;
      button.addEventListener('click', () => {
        if (!current() || !gtmFindingSeverities.includes(filter.value)) return;
        page += step;
        render(true);
      });
    }
  };
  const render = focus => {
    list.innerHTML = gtmFindingsList(findings, filter.value, page);
    bind();
    if (focus) $('#gtm-findings-status')?.focus();
  };
  filter.value = 'all';
  bind();
  filter.addEventListener('change', () => {
    if (!current() || !gtmFindingSeverities.includes(filter.value)) return;
    page = 0;
    render(false);
  });
}
const gtmConsentDiffStates = ['all', 'differs', 'draft_only', 'live_only', 'unknown', 'same'];
function uiGtmConsentDiffState(value) {
  switch (value) {
    case 'differs':
      return uiText('Draft differs from published');
    case 'draft_only':
      return uiText('Only in the draft workspace');
    case 'live_only':
      return uiText('Only in the published version');
    case 'same':
      return uiText('Same as published');
    case 'all':
      return uiText('All tags');
    default:
      return uiText('Unknown');
  }
}
// MSR-01: the published (live) version and the draft workspace come from the same audit reads. The comparison is
// configuration only; it never shows which version a site serves or how consent behaves at runtime.
function mountGtmConsentDiff(diff, live, selectionCurrent) {
  const root = $('#gtm-consent-diff');
  if (!root || !selectionCurrent()) return;
  const settings = ['notSet', 'notNeeded', 'needed', 'unknown'],
    nativeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value),
    types = value =>
      value === null ||
      (Array.isArray(value) &&
        value.length <= 20 &&
        value.every(type => typeof type === 'string' && type.length <= 100)),
    side = value => value === null || (value && settings.includes(value.setting) && types(value.required_types));
  if (!live || live.scope !== 'published_version_configuration') return;
  if (!diff) {
    root.innerHTML =
      live.status === 'unavailable'
        ? `<p class="notice">${esc(uiText('Published-version consent settings could not be summarized within the audit bounds.'))}</p>`
        : live.counts && settings.every(state => Number.isSafeInteger(live.counts[state]))
          ? `<h3>${esc(uiText('Published version consent settings'))}</h3><p>${settings.map(state => `${esc(uiGtmConsentSetting(state))}: ${esc(uiNumber(live.counts[state]))}`).join(' · ')}</p><p class="form-note">${esc(uiText('Choose a workspace to compare its draft consent settings with the published version.'))}</p>`
          : '';
    return;
  }
  const seen = new Set();
  if (
    !Array.isArray(diff.rows) ||
    diff.rows.length > 2000 ||
    !nativeId(diff.live_version_id) ||
    diff.rows.some(row => {
      if (!row || !nativeId(row.tag_id) || seen.has(row.tag_id)) return true;
      seen.add(row.tag_id);
      return !gtmConsentDiffStates.slice(1).includes(row.state) || !side(row.draft) || !side(row.live);
    })
  ) {
    root.innerHTML = `<p class="notice error" role="alert">${esc(uiText('The published and draft consent comparison could not be displayed. Read the audit again.'))}</p>`;
    return;
  }
  const generation = navigationGeneration,
    identity = identityGeneration,
    current = () =>
      generation === navigationGeneration && identity === identityGeneration && root.isConnected && selectionCurrent(),
    cell = value =>
      value === null
        ? esc(uiText('Not present'))
        : `${esc(uiGtmConsentSetting(value.setting))}${value.required_types?.length ? `<br>${value.required_types.map(type => `<code dir="ltr">${esc(type)}</code>`).join(', ')}` : ''}`;
  root.innerHTML = `<h3>${esc(uiText('Published vs draft consent'))}</h3><p class="form-note">${esc(uiText('Compares additional consent settings in the selected workspace with the published version {id}. Both came from this audit; runtime consent and event delivery remain unverified.', {id: diff.live_version_id}))}</p><p>${gtmConsentDiffStates
    .slice(1)
    .map(
      state =>
        `${esc(uiGtmConsentDiffState(state))}: ${esc(uiNumber(diff.rows.filter(row => row.state === state).length))}`,
    )
    .join(
      ' · ',
    )}</p><div class="work-filter"><label>${esc(uiText('Comparison'))}<select id="gtm-consent-diff-filter">${gtmConsentDiffStates.map(state => `<option value="${state}">${esc(uiGtmConsentDiffState(state))}</option>`).join('')}</select></label></div><div id="gtm-consent-diff-rows"></div>`;
  const filter = $('#gtm-consent-diff-filter'),
    rowsNode = $('#gtm-consent-diff-rows');
  filter.value = 'all';
  let page = 0;
  const render = focus => {
    if (!current() || !gtmConsentDiffStates.includes(filter.value)) return;
    const rows = diff.rows.filter(row => filter.value === 'all' || row.state === filter.value),
      last = Math.max(0, Math.ceil(rows.length / 25) - 1);
    page = Math.min(Math.max(0, page), last);
    const shown = rows.slice(page * 25, page * 25 + 25);
    rowsNode.innerHTML =
      (shown.length
        ? `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Published vs draft consent'))}"><table class="review-table"><caption>${esc(uiText('Published vs draft consent'))}</caption><thead><tr><th scope="col">${esc(uiText('Tag'))}</th><th scope="col">${esc(uiText('Draft workspace'))}</th><th scope="col">${esc(uiText('Published version'))}</th><th scope="col">${esc(uiText('Comparison'))}</th></tr></thead><tbody>${shown.map(row => `<tr><th scope="row"><span dir="auto">${esc(row.name ?? uiText('Unknown'))}</span><br><code dir="ltr">${esc(row.tag_id)}</code></th><td>${cell(row.draft)}</td><td>${cell(row.live)}</td><td>${esc(uiGtmConsentDiffState(row.state))}</td></tr>`).join('')}</tbody></table></div>`
        : `<p>${esc(uiText('No tags match these filters.'))}</p>`) +
      `<div class="report-pagination"><p id="gtm-consent-diff-status" role="status" tabindex="-1">${esc(uiText('Showing {shown} of {total} matching tags', {shown: uiNumber(shown.length), total: uiNumber(rows.length)}))}</p><div><button type="button" class="button small" id="gtm-consent-diff-previous" ${page ? '' : 'disabled'}>${esc(uiText('Previous page'))}</button><button type="button" class="button small" id="gtm-consent-diff-next" ${page < last ? '' : 'disabled'}>${esc(uiText('Next page'))}</button></div></div>`;
    $('#gtm-consent-diff-previous').addEventListener('click', () => {
      if (!current() || page <= 0) return;
      page--;
      render(true);
    });
    $('#gtm-consent-diff-next').addEventListener('click', () => {
      if (!current() || page >= last) return;
      page++;
      render(true);
    });
    if (focus) $('#gtm-consent-diff-status').focus();
  };
  filter.addEventListener('change', () => {
    page = 0;
    render(false);
  });
  render(false);
}
function uiGtmConsentSetting(value) {
  switch (value) {
    case 'notSet':
      return uiText('Additional consent not set');
    case 'notNeeded':
      return uiText('No additional consent required');
    case 'needed':
      return uiText('Additional consent required');
    default:
      return uiText('Unknown');
  }
}
// The documented Google consent types (MSR-01); the server applies the same list. Native values are never translated.
const gtmDocumentedConsentTypes = [
  'ad_storage',
  'analytics_storage',
  'ad_user_data',
  'ad_personalization',
  'functionality_storage',
  'personalization_storage',
  'security_storage',
];
function gtmCheckedValues(field) {
  if (!field) return [];
  const nodes = typeof field.length === 'number' && typeof field.item === 'function' ? Array.from(field) : [field];
  return nodes.filter(node => node?.checked === true).map(node => String(node.value));
}
/** Names the non-standard types and, for a likely misspelling, the documented type one or two edits away. */
function gtmCustomTypeWarning(custom) {
  const distance = (a, b) => {
    const row = Array.from({length: b.length + 1}, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let previous = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const saved = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
        previous = saved;
      }
    }
    return row[b.length];
  };
  const suggestions = custom
    .map(value => [value, gtmDocumentedConsentTypes.find(type => distance(value.toLowerCase(), type) <= 2)])
    .filter(([, type]) => type);
  return [
    uiText(
      'Some consent types are not documented Google consent types: {types}. Check their spelling, or confirm that your consent platform grants them.',
      {types: custom.join(', ')},
    ),
    ...suggestions.map(([value, type]) => uiText('Did you mean {type} instead of {value}?', {type, value})),
  ].join(' ');
}
function mountGtmConsentDraft(evidence, scope, selectionCurrent) {
  const root = $('#gtm-consent-draft');
  if (!root || !selectionCurrent()) return;
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value),
    seen = new Set(),
    validScope =
      scope && ['account_id', 'connection_id', 'container_id', 'workspace_id'].every(key => validId(scope[key])),
    path = validScope
      ? `accounts/${scope.account_id}/containers/${scope.container_id}/workspaces/${scope.workspace_id}`
      : null;
  if (
    !validScope ||
    evidence?.scope !== 'workspace_configuration' ||
    evidence.workspace_path !== path ||
    !Array.isArray(evidence.rows) ||
    evidence.rows.length > 1000 ||
    evidence.tag_count !== evidence.rows.length ||
    evidence.rows.some(row => {
      if (!row || !validId(row.tag_id) || row.path !== path + '/tags/' + row.tag_id || seen.has(row.tag_id))
        return true;
      seen.add(row.tag_id);
      return !['notSet', 'notNeeded', 'needed', 'unknown'].includes(row.setting);
    })
  ) {
    root.innerHTML = `<p class="form-note">${esc(uiText('Choose an exact container and workspace, then read its audit to draft consent changes.'))}</p>`;
    return;
  }
  if (!evidence.rows.length) return;
  root.innerHTML = `<section class="workspace-form"><h3>${esc(uiText('Draft additional consent requirements'))}</h3><p id="gtm-consent-draft-help">${esc(uiText('Choose the tags and literal types your policy requires. Existing required types, tag parameters, triggers and paused state are preserved. Preview and saving make no provider changes. Each update needs native review; publishing remains separate.'))}</p><form id="gtm-consent-form" aria-describedby="gtm-consent-draft-help"><label>${esc(uiText('Choose 1–10 tags'))}<select name="tag_ids" multiple size="6" required>${evidence.rows.map(row => `<option value="${esc(row.tag_id)}" ${row.setting === 'unknown' ? 'disabled' : ''}>${esc(row.name ?? row.tag_id)} · ${esc(row.tag_id)} · ${esc(uiGtmConsentSetting(row.setting))}</option>`).join('')}</select></label><fieldset><legend>${esc(uiText('Documented Google consent types'))}</legend>${gtmDocumentedConsentTypes.map(type => `<label class="checkbox-row"><input type="checkbox" name="standard_types" value="${type}"><code dir="ltr">${type}</code></label>`).join('')}</fieldset><label>${esc(uiText('Other consent types (comma-separated)'))}<input name="required_types" type="text" maxlength="2020" dir="ltr" autocomplete="off" spellcheck="false" aria-describedby="gtm-consent-types-help"></label><p class="form-note" id="gtm-consent-types-help">${esc(uiText('Use 1–20 distinct literal types. Variables and automatic policy selection are unavailable. Unknown native settings need separate inspection.'))} ${esc(uiText('Enter other types only when your consent platform grants them; a misspelled type is never granted and the tag stops firing after publishing.'))}</p><label class="checkbox-row"><input type="checkbox" name="custom_types_acknowledged" value="true">${esc(uiText('I confirm our consent platform grants the non-standard types entered above.'))}</label><p id="gtm-consent-custom-warning" class="notice" role="alert" hidden></p><button type="submit" class="button primary">${esc(uiText('Preview consent additions'))}</button></form><div id="gtm-consent-preview"></div></section>`;
  const form = $('#gtm-consent-form'),
    result = $('#gtm-consent-preview'),
    begin = accountWorkflowContext(form, result);
  workspaceBind('#gtm-consent-form', async () => {
    const attemptCurrent = begin(),
      current = () => selectionCurrent() && root.isConnected && attemptCurrent();
    if (!current()) return;
    const tagIds = Array.from(form.elements.tag_ids.selectedOptions, option => option.value),
      checked = gtmCheckedValues(form.elements.standard_types).filter(value =>
        gtmDocumentedConsentTypes.includes(value),
      ),
      typed = form.elements.required_types.value.trim()
        ? form.elements.required_types.value.split(/[,،]/).map(value => value.trim())
        : [],
      types = [...checked, ...typed.filter(value => !checked.includes(value))],
      custom = types.filter(value => !gtmDocumentedConsentTypes.includes(value)),
      acknowledged = gtmCheckedValues(form.elements.custom_types_acknowledged).includes('true'),
      warning = $('#gtm-consent-custom-warning');
    if (warning) {
      warning.hidden = true;
      warning.textContent = '';
    }
    if (
      !tagIds.length ||
      tagIds.length > 10 ||
      new Set(tagIds).size !== tagIds.length ||
      tagIds.some(id => !evidence.rows.some(row => row.tag_id === id && row.setting !== 'unknown'))
    )
      throw Error(uiText('Choose 1–10 distinct exact tag IDs.'));
    if (
      !types.length ||
      types.length > 20 ||
      new Set(typed).size !== typed.length ||
      types.some(value => !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(value))
    )
      throw Error(
        uiText('Choose 1–20 distinct literal additional-consent types. Variables and duplicate types are refused.'),
      );
    // MSR-01: a non-standard type is never granted unless a consent platform grants it by that exact name.
    if (custom.length && !acknowledged) {
      const message = gtmCustomTypeWarning(custom);
      if (warning) {
        warning.textContent = message;
        warning.hidden = false;
      }
      throw Error(message);
    }
    let p;
    try {
      p = await workspaceCall('workspace', {
        action: 'preview_consent_plan',
        gateway: 'gtm_native_action',
        account_id: scope.account_id,
        connection_id: scope.connection_id,
        requirements: {
          container_id: scope.container_id,
          workspace_id: scope.workspace_id,
          tag_ids: tagIds,
          required_types: types,
          ...(custom.length ? {custom_types_acknowledged: true} : {}),
        },
      });
    } catch (error) {
      if (current()) throw Error(uiAccountExplanation(error.message));
      return;
    }
    if (!current()) return;
    const valid =
      p?.record_kind === 'gtm_consent_preview' &&
      typeof p.preview_id === 'string' &&
      /^[a-f0-9]{64}$/.test(p.preview_hash) &&
      Number.isSafeInteger(p.expires_at) &&
      p.expires_at > Date.now() &&
      p.provider_mutations === 0 &&
      p.publishing === false &&
      p.scope?.gateway === 'gtm_native_action' &&
      p.scope?.workspace_path === path &&
      ['account_id', 'connection_id', 'container_id', 'workspace_id'].every(key => p.scope[key] === scope[key]) &&
      JSON.stringify(p.scope.tag_ids) === JSON.stringify(tagIds) &&
      JSON.stringify(p.scope.required_types) === JSON.stringify(types) &&
      JSON.stringify(p.scope.custom_types ?? []) === JSON.stringify(custom) &&
      Array.isArray(p.targets) &&
      p.targets.length === tagIds.length &&
      p.targets.some(t => t.state === 'change') &&
      p.targets.every(
        (t, i) =>
          t &&
          t.tag_id === tagIds[i] &&
          t.path === path + '/tags/' + tagIds[i] &&
          ['change', 'unchanged'].includes(t.state) &&
          ['notSet', 'notNeeded', 'needed'].includes(t.before_setting) &&
          Array.isArray(t.before_required_types) &&
          Array.isArray(t.proposed_required_types) &&
          t.proposed_required_types.length <= 20 &&
          t.proposed_required_types.every(v => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(v)) &&
          t.before_required_types.every(v => t.proposed_required_types.includes(v)) &&
          JSON.stringify(t.proposed_required_types) ===
            JSON.stringify([...t.before_required_types, ...types.filter(v => !t.before_required_types.includes(v))]),
      );
    if (!valid) throw Error(uiText('The consent preview does not match this selection. Read a new preview.'));
    const table = `<h4 tabindex="-1" id="gtm-consent-preview-title">${esc(uiText('Review explicit consent additions'))}</h4><p class="notice">${esc(uiText('This is an unapproved workspace proposal. Built-in consent checks, consent defaults and updates, runtime order and event delivery remain unverified.'))}</p>${custom.length ? `<p class="notice warning"><strong>${esc(uiText('Non-standard consent type'))}</strong>: ${custom.map(value => `<code dir="ltr">${esc(value)}</code>`).join(', ')}. ${esc(uiText('A tag that requires a type your consent platform never grants will not fire after publishing.'))}</p>` : ''}<p>${esc(uiText('Preview expires: {date}', {date: uiDate(p.expires_at)}))}</p><div class="data-scroll" role="region" aria-label="${esc(uiText('Consent additions'))}" tabindex="0"><table class="review-table"><caption>${esc(uiText('Consent additions'))}</caption><thead><tr><th scope="col">${esc(uiText('Tag'))}</th><th scope="col">${esc(uiText('Original consent setting'))}</th><th scope="col">${esc(uiText('Original required types'))}</th><th scope="col">${esc(uiText('Proposed required types'))}</th><th scope="col">${esc(uiText('Draft change'))}</th></tr></thead><tbody>${p.targets.map(t => `<tr><th scope="row"><bdi dir="auto">${esc(t.name ?? t.tag_id)}</bdi><br><code dir="ltr">${esc(t.tag_id)}</code></th><td>${esc(uiGtmConsentSetting(t.before_setting))}</td><td><code dir="ltr">${esc(t.before_required_types.join(', ') || '—')}</code></td><td><code dir="ltr">${esc(t.proposed_required_types.join(', '))}</code></td><td>${esc(uiText(t.state === 'change' ? 'Add required types' : 'Already required; no step'))}</td></tr>`).join('')}</tbody></table></div>${recordDetails({workspace_path: path, source_hash: p.source_hash, source_references: p.source_references, network_requests: p.network_requests}, uiText('Consent source references'))}`;
    result.innerHTML =
      table +
      `<button id="gtm-consent-save" class="button primary" type="button">${esc(uiText('Save unapproved consent draft'))}</button>`;
    $('#gtm-consent-preview-title').focus();
    const button = $('#gtm-consent-save');
    workspaceBind(
      '#gtm-consent-save',
      async () => {
        if (!current()) return;
        if (p.expires_at <= Date.now()) throw Error(uiText('The consent preview expired. Read a new preview.'));
        let saved;
        try {
          saved = await workspaceCall('workspace', {
            action: 'create_consent_plan',
            preview_id: p.preview_id,
            preview_hash: p.preview_hash,
            confirmed: true,
          });
        } catch (error) {
          if (current()) throw Error(uiAccountExplanation(error.message));
          return;
        }
        if (!current()) return;
        if (
          saved?.record_kind !== 'gtm_consent_plan' ||
          typeof saved.id !== 'string' ||
          !validId(saved.id) ||
          saved.provider_mutations !== 0 ||
          saved.publishing !== false ||
          saved.approval_required !== true
        )
          throw Error(
            uiText('The saved consent draft could not be verified. Inspect the original preview before retrying.'),
          );
        result.innerHTML =
          table +
          `<p role="status" class="notice">${esc(uiText('Unapproved consent draft saved. Review each native update before execution. Publishing remains separate.'))} <a href="/campaigns?id=${encodeURIComponent(saved.id)}">${esc(uiText('Open consent draft'))}</a></p>`;
      },
      {disabled: () => !current() || !button.isConnected || p.expires_at <= Date.now()},
    );
  });
}
function mountGtmConsentEvidence(evidence, selectionCurrent) {
  if (!evidence) return;
  const root = $('#gtm-consent-evidence'),
    generation = navigationGeneration,
    identity = identityGeneration,
    current = () =>
      generation === navigationGeneration && identity === identityGeneration && root.isConnected && selectionCurrent(),
    states = ['notSet', 'notNeeded', 'needed', 'unknown'];
  if (!current()) return;
  if (
    evidence.scope !== 'workspace_configuration' ||
    !Array.isArray(evidence.rows) ||
    evidence.rows.length > 1000 ||
    evidence.tag_count !== evidence.rows.length ||
    evidence.rows.some(
      row =>
        !row ||
        typeof row.tag_id !== 'string' ||
        typeof row.path !== 'string' ||
        !states.includes(row.setting) ||
        (row.required_types !== null &&
          (!Array.isArray(row.required_types) ||
            row.required_types.length > 20 ||
            row.required_types.some(v => typeof v !== 'string' || v.length > 100))),
    )
  ) {
    root.innerHTML = `<p class="notice error" role="alert">${esc(uiText('Consent evidence could not be displayed. Read the audit again.'))}</p>`;
    return;
  }
  root.innerHTML = `<h3>${esc(uiText('Workspace consent settings'))}</h3><p class="form-note">${esc(uiText('These are additional consent settings in the selected workspace. Built-in checks, default and updated consent states, runtime timing and event delivery remain unverified.'))}</p><p><code dir="ltr">${esc(evidence.workspace_path)}</code></p><p>${states.map(state => `${esc(uiGtmConsentSetting(state))}: ${esc(uiNumber(evidence.rows.filter(row => row.setting === state).length))}`).join(' · ')}</p><div class="work-filter"><label>${esc(uiText('Additional consent'))}<select id="gtm-consent-filter"><option value="all">${esc(uiText('All tags'))}</option>${states.map(state => `<option value="${state}">${esc(uiGtmConsentSetting(state))}</option>`).join('')}</select></label><label>${esc(uiText('Search tag name, ID or consent type'))}<input type="search" id="gtm-consent-search" maxlength="150"></label></div><div id="gtm-consent-rows"></div>`;
  const filter = $('#gtm-consent-filter'),
    search = $('#gtm-consent-search'),
    rowsNode = $('#gtm-consent-rows');
  filter.value = 'all';
  search.value = '';
  let offset = 0;
  const render = (focus = false) => {
    if (!current()) return;
    const query = search.value.slice(0, 150).toLocaleLowerCase(),
      rows = evidence.rows.filter(
        row =>
          (filter.value === 'all' || row.setting === filter.value) &&
          [row.tag_id, row.name, row.type, ...(row.required_types ?? [])].some(value =>
            String(value ?? '')
              .toLocaleLowerCase()
              .includes(query),
          ),
      ),
      page = rows.slice(offset, offset + 50);
    rowsNode.innerHTML = rows.length
      ? `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Tag consent configuration table'))}"><table class="review-table"><caption>${esc(uiText('Additional consent by tag'))}</caption><thead><tr>${['Tag', 'Type', 'Additional consent', 'Required consent types', 'Configured status'].map(label => `<th scope="col">${esc(uiText(label))}</th>`).join('')}</tr></thead><tbody>${page.map(row => `<tr><th scope="row"><span dir="auto">${esc(row.name ?? uiText('Unknown'))}</span><br><code dir="ltr">${esc(row.tag_id)}</code></th><td dir="ltr">${esc(row.type ?? uiText('Unknown'))}</td><td>${esc(uiGtmConsentSetting(row.setting))}${row.reason ? `<p class="form-note">${esc(uiText('The additional consent types could not be interpreted. Inspect the native tag settings.'))}</p>` : ''}</td><td>${row.required_types === null ? esc(uiText('Unknown')) : row.required_types.length ? row.required_types.map(value => `<code dir="ltr">${esc(value)}</code>`).join(', ') : esc(uiText('No additional types listed'))}</td><td>${esc(row.paused === true ? uiText('Paused') : row.paused === false ? uiText('Unpaused') : uiText('Unknown'))}</td></tr>`).join('')}</tbody></table></div>`
      : `<p>${esc(evidence.rows.length ? uiText('No tags match these filters.') : uiText('No tags in this workspace inventory.'))}</p>`;
    rowsNode.innerHTML += `<div class="report-pagination"><p id="gtm-consent-status" role="status" tabindex="-1">${esc(uiText('Showing {shown} of {total} matching tags', {shown: uiNumber(page.length), total: uiNumber(rows.length)}))}</p><div><button type="button" class="button small" id="gtm-consent-previous">${esc(uiText('Previous page'))}</button><button type="button" class="button small" id="gtm-consent-next">${esc(uiText('Next page'))}</button></div></div>`;
    $('#gtm-consent-previous').disabled = offset === 0;
    $('#gtm-consent-next').disabled = offset + 50 >= rows.length;
    $('#gtm-consent-previous').addEventListener('click', () => {
      if (current() && offset > 0) {
        offset -= 50;
        render(true);
      }
    });
    $('#gtm-consent-next').addEventListener('click', () => {
      if (current() && offset + 50 < rows.length) {
        offset += 50;
        render(true);
      }
    });
    if (focus) $('#gtm-consent-status').focus();
  };
  const refresh = () => {
    if (current() && ['all', ...states].includes(filter.value)) {
      offset = 0;
      render();
    }
  };
  filter.addEventListener('change', refresh);
  search.addEventListener('input', refresh);
  render();
}
const measurementIdentityLabels = {
  matches_declared: 'Reported count matches your expectation',
  above_declared: 'Reported count is above your expectation',
  below_declared: 'Reported count is below your expectation',
  not_observed: 'No matching count returned',
};
function measurementIdentityPeriod(from, to) {
  const day = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return null;
    const time = Date.parse(value + 'T00:00:00Z');
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
  };
  const first = day(from),
    last = day(to);
  return first !== null && last !== null && last >= first && last - first <= 6 * 86400000;
}
function measurementIdentityRows(out, requirements) {
  if (!Array.isArray(out.rows) || out.rows.length > 1000 || !out.observation) return false;
  const seen = new Set();
  let total = 0n;
  for (const row of out.rows) {
    if (
      !row ||
      row.event_name !== requirements.event_name ||
      row.test_id !== requirements.test_id ||
      !/^[1-9][0-9]{0,19}$/.test(row.stream_id ?? '') ||
      typeof row.stream_id !== 'string' ||
      (requirements.stream_id && row.stream_id !== requirements.stream_id) ||
      seen.has(row.stream_id) ||
      typeof row.event_count !== 'string' ||
      !/^(?:0|[1-9][0-9]{0,29})$/.test(row.event_count)
    )
      return false;
    seen.add(row.stream_id);
    total += BigInt(row.event_count);
  }
  const count = out.rows.length ? String(total) : null,
    expected = BigInt(requirements.expected_count);
  const comparison =
    count === null
      ? 'not_observed'
      : total === expected
        ? 'matches_declared'
        : total > expected
          ? 'above_declared'
          : 'below_declared';
  return out.observation.reported_count === count && out.observation.comparison === comparison;
}
function measurementEventIdentityMarkup(targets) {
  return `<section class="panel workspace-form">${measurementSectionHeading('measurement-section-identity', uiText('Inspect a specific GA4 test identifier'))}<p>${esc(uiText('Use an existing event-scoped amcp_test_id custom dimension and a synthetic identifier already sent by your own test instrumentation. AMCP does not register the dimension or send an event.'))}</p><form id="measurement-event-identity">${measurementTargetField(targets, uiText('GA4 property'), 'Connect a GA4 property in Connections to inspect a test identifier.', uiText('Choose a login and account'))}<label>${esc(uiText('Exact event name'))}<input name="event_name" type="text" maxlength="40" required></label><label>${esc(uiText('Synthetic test identifier'))}<input name="test_id" type="text" maxlength="74" required aria-describedby="measurement-identity-help" dir="ltr"></label><p class="form-note" id="measurement-identity-help">${esc(uiText('Use amcp-test- followed by 8–64 letters, digits or hyphens. Generate a new identifier only before your separate test; enter the original identifier to inspect an existing test.'))}</p><button id="measurement-identity-generate" type="button" class="button small">${esc(uiText('Generate a synthetic test identifier'))}</button><label>${esc(uiText('Report source'))}<select name="mode" aria-describedby="measurement-identity-mode-help"><option value="core_report">${esc(uiText('Core reports: property calendar dates'))}</option><option value="realtime_user_scope">${esc(uiText('Realtime: user scope, test properties only'))}</option></select></label><p class="form-note" id="measurement-identity-mode-help">${esc(uiText('Realtime reads a user-scoped amcp_test_id on a GA4 property the workspace owner marked as a test property. Counts arrive within minutes but cover every event of the test user, so they are not event-level proof.'))}</p><div id="measurement-identity-dates"><label>${esc(uiText('From date'))}<input name="date_from" type="date" required></label><label>${esc(uiText('To date'))}<input name="date_to" type="date" required></label><p class="form-note">${esc(uiText('Choose at most seven calendar days in the GA4 property timezone. Core reporting may lag; this is not a realtime event trace.'))}</p></div><div id="measurement-identity-minutes" hidden><label>${esc(uiText('Recent window (minutes)'))}<input name="minutes" type="number" min="1" max="30" step="1" value="30"></label></div><label>${esc(uiText('Stream ID (optional)'))}<input name="stream_id" type="text" maxlength="20" inputmode="numeric" dir="ltr"></label><label>${esc(uiText('Your expected count'))}<input name="expected_count" type="number" min="1" max="1000" step="1" value="1" required></label><button type="submit" class="button primary" ${targets.length ? '' : 'disabled'}>${esc(uiText('Read matching test counts'))}</button></form><div id="measurement-event-identity-result" aria-live="polite"></div></section>`;
}
function bindMeasurementEventIdentity(targets) {
  const form = $('#measurement-event-identity'),
    result = $('#measurement-event-identity-result'),
    feedback = measurementReadFeedback(form),
    begin = accountWorkflowContext(form, result);
  // MSR-04: the realtime mode reads a recent minute window instead of property calendar dates.
  const realtimeMode = () => form.elements.mode?.value === 'realtime_user_scope',
    modeSwitch = () => {
      const realtime = realtimeMode();
      $('#measurement-identity-dates').hidden = realtime;
      $('#measurement-identity-minutes').hidden = !realtime;
      form.elements.date_from.required = form.elements.date_to.required = !realtime;
      if (form.elements.minutes) form.elements.minutes.required = realtime;
    };
  form.elements.mode?.addEventListener('change', modeSwitch);
  if (typeof location !== 'undefined') {
    const p = new URLSearchParams(location.search);
    if (p.has('event_identity')) {
      const realtime = p.get('mode') === 'realtime_user_scope',
        keys = [
          'event_identity',
          'account_id',
          'connection_id',
          'event_name',
          'test_id',
          ...(realtime ? ['mode', 'minutes'] : ['date_from', 'date_to']),
          'expected_count',
        ],
        index = targets.findIndex(
          t => t.account_id === p.get('account_id') && t.connection_id === p.get('connection_id'),
        ),
        valid =
          p.get('event_identity') === '1' &&
          keys.every(k => p.getAll(k).length === 1) &&
          p.getAll('stream_id').length <= 1 &&
          index >= 0 &&
          /^amcp-test-[A-Za-z0-9-]{8,64}$/.test(p.get('test_id') ?? '') &&
          /^\p{L}[\p{L}\p{N}_]{0,39}$/u.test(p.get('event_name') ?? '') &&
          (realtime
            ? /^[1-9][0-9]?$/.test(p.get('minutes') ?? '') &&
              Number(p.get('minutes')) <= 30 &&
              !p.has('date_from') &&
              !p.has('date_to')
            : !p.has('mode') && !p.has('minutes') && measurementIdentityPeriod(p.get('date_from'), p.get('date_to'))) &&
          /^[1-9][0-9]{0,3}$/.test(p.get('expected_count') ?? '') &&
          Number(p.get('expected_count')) <= 1000 &&
          (!p.has('stream_id') || /^[1-9][0-9]{0,19}$/.test(p.get('stream_id') ?? ''));
      form.elements.target.value = valid ? String(index) : '';
      if (form.elements.mode) form.elements.mode.value = valid && realtime ? 'realtime_user_scope' : 'core_report';
      if (form.elements.minutes) form.elements.minutes.value = valid && realtime ? p.get('minutes') : '30';
      modeSwitch();
      for (const k of ['event_name', 'test_id', 'date_from', 'date_to', 'stream_id', 'expected_count'])
        form.elements[k].value = valid ? (p.get(k) ?? '') : k === 'expected_count' ? '1' : '';
      result.innerHTML = `<p class="form-note" role="status">${esc(uiText(valid ? 'Test scope selected from the original inspection. Read current evidence to refresh it.' : 'The linked test scope is unavailable. Choose a currently selected property and original test identifier.'))}</p>`;
    }
  }
  workspaceBind('#measurement-identity-generate', async () => {
    const current = begin();
    if (!current()) return;
    form.elements.test_id.value = 'amcp-test-' + crypto.randomUUID();
    form.elements.test_id.focus();
  });
  workspaceBind('#measurement-event-identity', async () => {
    const current = begin();
    if (!current()) return;
    feedback.clear();
    try {
      const target = targets[Number(form.elements.target.value)];
      if (form.elements.target.value === '' || !target) throw Error(uiText('Choose a GA4 property.'));
      const realtime = realtimeMode(),
        requirements = realtime
          ? {
              mode: 'realtime_user_scope',
              event_name: form.elements.event_name.value.trim(),
              test_id: form.elements.test_id.value.trim(),
              minutes: Number(form.elements.minutes.value),
              expected_count: Number(form.elements.expected_count.value),
            }
          : {
              event_name: form.elements.event_name.value.trim(),
              test_id: form.elements.test_id.value.trim(),
              date_from: form.elements.date_from.value,
              date_to: form.elements.date_to.value,
              expected_count: Number(form.elements.expected_count.value),
            },
        stream = form.elements.stream_id.value.trim();
      if (stream) requirements.stream_id = stream;
      const {label, ...scope} = target;
      let out;
      out = await workspaceCall('workspace', {action: 'measurement_event_identity', ...scope, requirements});
      if (!current()) return;
      if (
        out?.record_kind !== 'measurement_event_identity' ||
        out.scope?.property_id !== scope.account_id ||
        out.scope.connection_id !== scope.connection_id ||
        out.scope.event_name !== requirements.event_name ||
        out.scope.test_id !== requirements.test_id ||
        out.scope.stream_id !== (stream || null) ||
        (realtime
          ? out.mode !== 'realtime_user_scope' ||
            out.scope.mode !== 'realtime_user_scope' ||
            out.scope.identity_dimension !== 'customUser:amcp_test_id' ||
            out.scope.minutes !== requirements.minutes ||
            out.relative_window?.start_minutes_ago !== requirements.minutes - 1 ||
            out.relative_window.end_minutes_ago !== 0 ||
            out.checks?.event_level_proof !== 'not_established'
          : out.mode === 'realtime_user_scope' ||
            out.scope.date_from !== requirements.date_from ||
            out.scope.date_to !== requirements.date_to ||
            out.period?.date_from !== requirements.date_from ||
            out.period.date_to !== requirements.date_to ||
            typeof out.period.timezone !== 'string' ||
            !out.period.timezone) ||
        !out.observation ||
        !Object.hasOwn(measurementIdentityLabels, out.observation.comparison) ||
        (out.observation.reported_count !== null &&
          (typeof out.observation.reported_count !== 'string' || !/^\d+$/.test(out.observation.reported_count))) ||
        out.observation.declared_expected_count !== String(requirements.expected_count) ||
        !measurementIdentityRows(out, requirements)
      )
        throw Error(
          uiText('The test inspection response is incomplete or belongs to a different selection. Read it again.'),
        );
      result.innerHTML = `<h3 id="measurement-identity-heading" tabindex="-1">${esc(uiText('GA4 property {id}', {id: out.scope.property_id}))}</h3><p><bdi dir="auto">${esc(out.scope.event_name)}</bdi> · <bdi dir="ltr">${esc(out.scope.test_id)}</bdi></p>${realtime ? `<p>${esc(uiText('Realtime window: the last {minutes} minutes, relative to GA4 processing time', {minutes: uiNumber(out.scope.minutes)}))}</p><p class="notice">${esc(uiText('User-scoped realtime counts: every event of the synthetic test user carries this identifier, so a match is not event-level proof. Realtime processing can lag by a few minutes.'))}</p>` : `<p>${esc(uiText('Property calendar dates'))}: <bdi dir="ltr">${esc(out.period.date_from)} — ${esc(out.period.date_to)}</bdi> · ${esc(uiText('Timezone'))}: <bdi dir="ltr">${esc(out.period.timezone)}</bdi></p>`}<div class="workspace-metrics"><article><strong class="${out.observation.reported_count === null ? 'measurement-count-missing' : ''}"><bdi dir="ltr">${esc(out.observation.reported_count ?? uiText('No count returned'))}</bdi></strong><span>${esc(uiText('Reported matching count'))}</span></article><article><strong><bdi dir="ltr">${esc(out.observation.declared_expected_count)}</bdi></strong><span>${esc(uiText('Your declared expectation'))}</span></article></div><p class="notice">${esc(uiText(measurementIdentityLabels[out.observation.comparison]))}</p><p>${esc(uiText('Matching this test identifier does not establish deduplication, consent, attribution or overall tracking health. Multiple counts are a reason to investigate, not proof of duplicate delivery. Missing or zero counts can reflect processing delays or filters.'))}</p><p class="form-note">${esc(uiText('No event was sent and no snapshot was saved. The existing custom dimension was checked before and after this bounded report.'))}</p>${realtime ? `<p class="form-note">${esc(uiText('The user-scoped amcp_test_id value stays on the synthetic test user in GA4. Use a fresh identifier and a dedicated test browser or device for each test.'))}</p>` : ''}<div class="data-scroll" role="region" aria-label="${esc(uiText('Matching test counts by stream'))}" tabindex="0"><table class="review-table"><caption>${esc(uiText('Matching test counts by stream'))}</caption><thead><tr><th scope="col">${esc(uiText('Stream ID'))}</th><th scope="col">${esc(uiText('Reported count'))}</th></tr></thead><tbody>${out.rows.map(r => `<tr><th scope="row"><bdi dir="ltr">${esc(r.stream_id)}</bdi></th><td><bdi dir="ltr">${esc(r.event_count)}</bdi></td></tr>`).join('') || `<tr><td colspan="2">${esc(uiText('No matching test rows were returned.'))}</td></tr>`}</tbody></table></div>${recordDetails(out, uiText('Test scope, source references and unverified checks'))}`;
      $('#measurement-identity-heading').focus();
    } catch (error) {
      if (current()) feedback.show(error);
    }
  });
}
function measurementEventsMarkup(targets) {
  return `<section class="panel workspace-form">${measurementSectionHeading('measurement-section-events', uiText('Recent GA4 events'))}<p>${esc(uiText('Read aggregate counts for exact event names in one selected property and a recent window. This does not send a test event.'))}</p>
  <form id="measurement-events">${measurementTargetField(targets, uiText('GA4 property'), 'Connect a GA4 property in Connections to read recent events.', uiText('Choose a login and account'))}
  <label>${esc(uiText('Exact event names'))}<textarea name="event_names" rows="2" maxlength="900" required aria-describedby="measurement-event-names-help"></textarea></label><p class="form-note" id="measurement-event-names-help">${esc(uiText('Separate names with commas or new lines. Names are case-sensitive; select at most 20.'))}</p>
  <label>${esc(uiText('Recent window (minutes)'))}<input name="minutes" type="number" min="1" max="30" step="1" value="5" required></label><label>${esc(uiText('Stream ID (optional)'))}<input name="stream_id" type="text" inputmode="numeric" maxlength="20"></label>
  <button class="button primary" type="submit" ${targets.length ? '' : 'disabled'}>${esc(uiText('Read recent event counts'))}</button></form><div id="measurement-events-result" aria-live="polite"></div></section>`;
}
function bindMeasurementEvents(targets) {
  const form = $('#measurement-events'),
    result = $('#measurement-events-result'),
    feedback = measurementReadFeedback(form),
    begin = accountWorkflowContext(form, result);
  workspaceBind('#measurement-events', async form => {
    const current = begin();
    if (!current()) return;
    feedback.clear();
    try {
      const t = targets[Number(form.elements.target.value)];
      if (form.elements.target.value === '' || !t) throw Error(uiText('Choose a GA4 property.'));
      const event_names = form.elements.event_names.value
          .split(/[,\r\n]+/)
          .map(s => s.trim())
          .filter(Boolean),
        minutes = Number(form.elements.minutes.value),
        stream = form.elements.stream_id.value.trim();
      if (!event_names.length || event_names.length > 20) throw Error(uiText('Enter 1–20 exact event names.'));
      const {label, ...scope} = t;
      let out;
      out = await workspaceCall('workspace', {
        action: 'measurement_events',
        ...scope,
        requirements: {event_names, minutes, ...(stream ? {stream_id: stream} : {})},
      });
      if (!current()) return;
      const status = e => (e.state === 'observed' ? uiText('Activity observed') : uiText('No positive count observed'));
      result.innerHTML = `<h3 id="measurement-events-heading" tabindex="-1">${esc(uiText('GA4 property {id}', {id: out.scope.property_id}))}</h3>
      <p>${esc(uiText('Window: {minutes} minutes · Stream: {stream}', {minutes: out.scope.minutes, stream: out.scope.stream_id ?? uiText('All returned streams')}))}</p><p>${esc(uiText('Requested {requested} · Returned {captured}', {requested: date(out.requested_at), captured: date(out.captured_at)}))}</p>
      <div class="data-scroll" role="region" aria-label="${esc(uiText('Recent event counts'))}" tabindex="0"><table class="review-table"><caption>${esc(uiText('Recent event counts'))}</caption><thead><tr><th scope="col">${esc(uiText('Event'))}</th><th scope="col">${esc(uiText('Reported count'))}</th><th scope="col">${esc(uiText('Observation'))}</th></tr></thead><tbody>${out.events.map(e => `<tr><th scope="row"><bdi dir="ltr">${esc(e.event_name)}</bdi></th><td><bdi dir="ltr">${esc(e.reported_count ?? uiText('No count returned'))}</bdi></td><td>${esc(status(e))}</td></tr>`).join('')}</tbody></table></div>
      <p class="notice">${esc(uiText('Missing or zero counts do not establish a broken tag; realtime processing can lag.'))}</p><p>${esc(uiText('These aggregate counts cannot identify your test event or verify deduplication, consent or attribution. They do not establish conversion configuration or overall tracking health. No test events were sent and no snapshot was saved.'))}</p>
      <details class="workspace-details"><summary>${esc(uiText('Minute and stream evidence'))}</summary><p>${esc(uiText('Minutes ago are relative to GA4 request processing time, not exact event timestamps.'))}</p><div class="data-scroll" role="region" aria-label="${esc(uiText('Minute and stream evidence'))}" tabindex="0"><table class="review-table"><caption>${esc(uiText('Minute and stream evidence'))}</caption><thead><tr><th scope="col">${esc(uiText('Event'))}</th><th scope="col">${esc(uiText('Minutes ago'))}</th><th scope="col">${esc(uiText('Stream ID'))}</th><th scope="col">${esc(uiText('Reported count'))}</th></tr></thead><tbody>${out.rows.map(r => `<tr><th scope="row"><bdi dir="ltr">${esc(r.event_name)}</bdi></th><td><bdi dir="ltr">${esc(r.minutes_ago)}</bdi></td><td><bdi dir="ltr">${esc(r.stream_id)}</bdi></td><td><bdi dir="ltr">${esc(r.event_count)}</bdi></td></tr>`).join('') || `<tr><td colspan="4">${esc(uiText('No minute rows were returned.'))}</td></tr>`}</tbody></table></div></details>${recordDetails(out, uiText('Observation scope and evidence limits'))}`;
      $('#measurement-events-heading').focus();
    } catch (error) {
      if (current()) feedback.show(error);
    }
  });
}
// The page body this module provides (web/routes.js).
AMCP.routes.register('/measurement', {render: renderMeasurement});
