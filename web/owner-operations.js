'use strict';
const baseWorkspaceSettings = renderSettings;
let ownerSettingsRequest = 0;
const platformName = g =>
  ({
    google_ads_native_action: 'Google Ads',
    meta_native_action: 'Meta',
    tiktok_native_action: 'TikTok',
    snapchat_native_action: 'Snapchat',
    linkedin_native_action: 'LinkedIn',
    x_ads_native_action: 'X',
    microsoft_ads_native_action: 'Microsoft Advertising',
    reddit_native_action: 'Reddit',
    dv360_native_action: 'DV360',
    apple_ads_native_action: 'Apple Ads',
    criteo_native_action: 'Criteo',
  })[g] ?? String(g).replace('_native_action', '');
/** What the amounts of an account policy mean for the selected platform. */
const policyUnitNote = (h, g) => {
  if (!g) return uiText('Choose an account to see how its platform counts money.');
  const u = (h.budget_units ?? {})[g];
  return u
    ? uiText('{platform} counts {unit}; amounts in account currency are converted ({evidence}).', {
        platform: platformName(g),
        unit: u.unit,
        evidence: u.evidence,
      }) +
        // Meta's unit depends on the currency (WRT-07): name it, and a currency Meta does not list stays native.
        (g === 'meta_native_action'
          ? ' ' +
            uiText(
              'For Meta, AMCP converts with the currency of these caps; a currency Meta does not list, such as KWD or OMR, must be stated in native API units.',
            )
          : '')
    : uiText(
        '{platform} has no documented unit in AMCP: choose “Native API units” and use the unit of the native request you review.',
        {platform: platformName(g)},
      );
};
/**
 * Spending-policy edits change only what the owner changed (WRT-03). The form shows the stored policy of the selected
 * account, a save sends the revision it showed (a stale one is refused), and a save that weakens the policy names
 * every weakening in the confirmation first.
 */
const policyMoney = {
  max_budget: ['max_budget_native', 'max_budget_currency'],
  max_daily_increase: ['max_daily_increase_native', 'max_daily_increase_currency'],
  max_bid: ['max_bid_native', 'max_bid_currency'],
  max_total_budget: ['max_total_budget_native', 'max_total_budget_currency'],
};
const policyCapLabels = {
  max_budget: 'maximum budget',
  max_daily_increase: 'cumulative daily increases',
  max_bid: 'maximum bid',
  max_total_budget: 'maximum lifetime or total budget',
  max_budget_increase_percent: 'maximum increase per change',
};
const policyMeta = [
  'id',
  'revision',
  'scope',
  'gateway',
  'account_id',
  'updated_at',
  'updated_by',
  'money_units',
  'native_unit',
];
/** What an owner's write pause stops, by its scope (RPT-06): everything, advertising writes only, or report jobs only. */
function pauseScopeText(scope) {
  // The Microsoft report submission of a Reporting overview snapshot is a provider job: the scopes covering jobs stop it.
  return scope === 'provider_jobs'
    ? uiText(
        'Every report and export job of this workspace, Microsoft report submissions of Reporting overview included, is refused until you resume. Advertising writes, media uploads, other reads, reviews and verification continue.',
      )
    : scope === 'advertising'
      ? uiText(
          'Every advertising write and media upload of this workspace is refused until you resume. Report and export jobs, reads, reviews and verification continue.',
        )
      : uiText(
          'Every reviewed write and media upload of this workspace, and every Microsoft report submission of Reporting overview, is refused until you resume. Other reads, reviews and verification continue.',
        );
}
/** The provider-job switch and the jobs created in the last seven days, counted from their receipts (RPT-06). */
function providerJobsLine(jobs) {
  if (!jobs) return '';
  const count = String(jobs.receipts?.created ?? 0);
  return `<p class="form-note">${esc(
    jobs.switch === 'on'
      ? uiText(
          'Report and export jobs are allowed while live writes are off; each needs an account report-job grant. Jobs created in the last 7 days: {count}.',
          {count},
        )
      : uiText(
          'Report and export jobs are reviewed writes in this deployment. Jobs created in the last 7 days: {count}.',
          {count},
        ),
  )}</p>`;
}
/** What the workspace default sets for one platform: its shared settings under that platform's own limits. */
function workspaceDefaultFor(stored, gateway) {
  if (!stored) return undefined;
  const {per_gateway: per, ...shared} = stored;
  return {...shared, ...(per?.[gateway] ?? {})};
}
/** The stored policy of the account a binding names, matched by the server's own normalized key. */
function storedAccountPolicy(h, gateway, connectionId, account) {
  const bindings = Array.isArray(h?.spend_policy_bindings) ? h.spend_policy_bindings : [],
    b =
      bindings.find(x => x.gateway === gateway && x.connection_id === connectionId && x.account_id === account) ??
      bindings.find(x => x.gateway === gateway && x.account_id === account);
  return b ? (h.policies ?? []).find(p => p.id === b.policy_id) : undefined;
}
/** The account's currency from its last live check, as the server recorded it for the binding (WRT-07). */
function bindingCurrency(h, gateway, connectionId, account) {
  const b = (Array.isArray(h?.spend_policy_bindings) ? h.spend_policy_bindings : []).find(
    x => x.gateway === gateway && x.connection_id === connectionId && x.account_id === account,
  );
  return typeof b?.account_currency === 'string' ? b.account_currency : undefined;
}
/** Which policy a stored-policy warning is about, in words: the workspace default or a platform and account. */
function policyWarningLabel(h, warning) {
  const p = (h.policies ?? []).find(x => x.id === warning.policy_id);
  return p?.gateway ? platformName(p.gateway) + ' · ' + p.account_id : uiText('Workspace default');
}
const policyText = v => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
/**
 * Form values that show a stored account policy as it is; the earlier defaults for an account without one. The currency
 * of the caps (WRT-07) is the stored one, else the account's currency from its last live check (accountCurrency).
 */
function accountPolicyValues(stored, accountCurrency) {
  if (!stored)
    return {
      enforcement: 'confirm',
      unit: 'currency',
      currency: accountCurrency ?? '',
      max_budget: '',
      max_budget_increase_percent: '20',
      max_daily_increase: '',
      max_bid: '',
      max_total_budget: '',
      allow_activation: true,
      allow_deletion: false,
    };
  const set = Object.values(policyMoney).filter(([n, c]) => stored[n] !== undefined || stored[c] !== undefined),
    unit = set.every(([, c]) => stored[c] !== undefined) ? 'currency' : 'native',
    values = {
      enforcement: stored.enforcement === 'block' ? 'block' : 'confirm',
      unit,
      currency: typeof stored.currency === 'string' ? stored.currency : (accountCurrency ?? ''),
      max_budget_increase_percent: policyText(stored.max_budget_increase_percent),
      allow_activation: stored.allow_activation !== false,
      allow_deletion: stored.allow_deletion !== false,
    };
  for (const [field, [n, c]] of Object.entries(policyMoney))
    values[field] = policyText(unit === 'currency' ? stored[c] : stored[n]);
  return values;
}
/**
 * The account policy a save sends. A save replaces the stored policy, so it carries every field the form shows; a
 * setting the stored policy left out stays out while the form keeps its meaning (confirm, activation and deletion
 * allowed), so an unchanged field is stored as it was.
 */
function accountPolicyInput(values, stored) {
  const policy = {},
    kept = (key, value, meaning) => {
      if (!stored || stored[key] !== undefined || value !== meaning) policy[key] = value;
    };
  kept('enforcement', values.enforcement === 'block' ? 'block' : 'confirm', 'confirm');
  kept('allow_activation', !!values.allow_activation, true);
  kept('allow_deletion', !!values.allow_deletion, true);
  if (String(values.max_budget_increase_percent ?? '') !== '')
    policy.max_budget_increase_percent = Number(values.max_budget_increase_percent);
  for (const [field, [n, c]] of Object.entries(policyMoney))
    if (String(values[field] ?? '') !== '') policy[values.unit === 'native' ? n : c] = Number(values[field]);
  // The currency the caps are stated in (WRT-07); left empty, the server takes the account's from its last live check.
  const currency = String(values.currency ?? '')
    .trim()
    .toUpperCase();
  if (currency) policy.currency = currency;
  // WRT-09: the account's own approval settings have no control here, so a save keeps them as they are.
  for (const key of ['approval_mode', 'require_destructive_confirmation', 'cap_override_owner_only'])
    if (stored?.[key] !== undefined) policy[key] = stored[key];
  return policy;
}
/**
 * WRT-09 (owner questions P1 and P5, open): who approves spending, cap and deletion changes, the opt-in acknowledgement
 * before deletions and the opt-in owner-only execution beyond a cap, as the workspace default sets them. Each is off by
 * default. They apply to every account; an account policy (set over MCP) can only add to them.
 */
function approvalPolicyControls(stored) {
  const mode = stored?.approval_mode ?? 'assistant_ack',
    option = (value, label) => `<option value="${value}"${mode === value ? ' selected' : ''}>${esc(label)}</option>`;
  return `<label>${esc(uiText('Who approves spending, cap and deletion changes'))}<select name="approval_mode">${option('assistant_ack', uiText('The user, in the AI client (default)'))}${option('website_approval', uiText('A member, on the AMCP website'))}${option('distinct_approver', uiText('Another member than the preparer, or the owner'))}</select></label><p class="form-note">${esc(uiText('With approval on the website, a reviewed change to spending, beyond a cap or deleting something runs only after a member approves that exact review on the Operations page. This applies to every account, also one with a policy of its own.'))}</p><label class="check"><input name="require_destructive_confirmation" type="checkbox"${stored?.require_destructive_confirmation === true ? ' checked' : ''}> ${esc(uiText('Require an explicit acknowledgement before deletions'))}</label><label class="check"><input name="cap_override_owner_only" type="checkbox"${stored?.cap_override_owner_only === true ? ' checked' : ''}> ${esc(uiText('Only the workspace owner executes a change beyond a spending cap'))}</label><p class="form-note">${esc(uiText('When this is on, anyone else executes a change beyond a cap only after the owner approves that exact review on the AMCP website. When it is off, the user’s acknowledgement in the AI client is enough.'))}</p>`;
}
const approvalModeRank = mode =>
  ['assistant_ack', 'website_approval', 'distinct_approver'].indexOf(mode ?? 'assistant_ack');
/** The workspace default a save sends: the settings the form shows over the stored ones it does not show. */
function workspacePolicyInput(values, stored) {
  const policy = {};
  for (const [k, v] of Object.entries(stored ?? {}))
    if (![...policyMeta, 'applies_to', 'enforcement', 'max_budget_increase_percent', 'per_gateway'].includes(k))
      policy[k] = v;
  if (!stored || stored.enforcement !== undefined || values.enforcement !== 'confirm')
    policy.enforcement = values.enforcement === 'block' ? 'block' : 'confirm';
  if (String(values.max_budget_increase_percent ?? '') !== '')
    policy.max_budget_increase_percent = Number(values.max_budget_increase_percent);
  // WRT-09: the approval settings the form shows; a default left at its meaning is not stored.
  if (values.approval_mode !== undefined) {
    if (values.approval_mode !== 'assistant_ack' || stored?.approval_mode !== undefined)
      policy.approval_mode = values.approval_mode;
    else delete policy.approval_mode;
  }
  if (values.require_destructive_confirmation !== undefined) {
    if (values.require_destructive_confirmation || stored?.require_destructive_confirmation !== undefined)
      policy.require_destructive_confirmation = !!values.require_destructive_confirmation;
    else delete policy.require_destructive_confirmation;
  }
  if (values.cap_override_owner_only !== undefined) {
    if (values.cap_override_owner_only || stored?.cap_override_owner_only !== undefined)
      policy.cap_override_owner_only = !!values.cap_override_owner_only;
    else delete policy.cap_override_owner_only;
  }
  const per = {};
  for (const [g, limits] of Object.entries(stored?.per_gateway ?? {})) {
    per[g] = {...limits};
    // The server derives a native cap from its currency twin; sending both would let the stale one win.
    for (const [n, c] of Object.values(policyMoney)) if (per[g][c] !== undefined) delete per[g][n];
  }
  for (const [g, v] of Object.entries(values.caps ?? {})) {
    const limits = (per[g] ??= {});
    if (String(v) !== '') {
      limits.max_budget_currency = Number(v);
      delete limits.max_budget_native;
    } else if (limits.max_budget_currency !== undefined) delete limits.max_budget_currency;
    // The currency of this platform's caps (WRT-07): accounts in another currency are asked about or refused.
    if (values.currencies && Object.hasOwn(values.currencies, g)) {
      const currency = String(values.currencies[g] ?? '')
        .trim()
        .toUpperCase();
      if (currency) limits.currency = currency;
      else delete limits.currency;
    }
    if (Object.keys(limits).every(k => k === 'currency')) delete per[g];
  }
  if (Object.keys(per).length) policy.per_gateway = per;
  return policy;
}
/** Each way `next` is weaker than `stored`, in words, for the confirmation that comes before the save. */
function policyWeakenings(stored, next, platform = g => g) {
  if (!stored) return [];
  const out = [],
    fmt = v => uiNumber(v, {maximumFractionDigits: 6});
  if (stored.enforcement === 'block' && next.enforcement !== 'block')
    out.push(uiText('A change beyond a cap is asked about instead of refused.'));
  if (stored.allow_activation === false && next.allow_activation !== false)
    out.push(uiText('Activation after review becomes allowed.'));
  if (stored.allow_deletion === false && next.allow_deletion !== false)
    out.push(uiText('Deletion after review becomes allowed, feed deletion rules included.'));
  // WRT-09: fewer people approve, or deletions no longer need their own acknowledgement.
  if (approvalModeRank(next.approval_mode) < approvalModeRank(stored.approval_mode))
    out.push(uiText('Fewer approvals are needed before spending, cap and deletion changes are executed.'));
  if (stored.require_destructive_confirmation === true && next.require_destructive_confirmation !== true)
    out.push(uiText('Deletions no longer need an explicit acknowledgement.'));
  if (stored.cap_override_owner_only === true && next.cap_override_owner_only !== true)
    out.push(
      uiText('Members other than the owner may execute a change beyond a spending cap on the user’s acknowledgement.'),
    );
  const caps = (from, to, prefix) => {
    const pairs = [
      ...Object.entries(policyMoney),
      ['max_budget_increase_percent', ['max_budget_increase_percent', 'max_budget_increase_percent']],
    ];
    // Caps that no longer name their currency compare an account in any currency with the same number (WRT-07).
    if (typeof from.currency === 'string' && from.currency !== to.currency)
      out.push(
        typeof to.currency === 'string'
          ? uiText('{prefix}Caps are stated in {now} instead of {was}; check them.', {
              prefix,
              was: from.currency,
              now: to.currency,
            })
          : uiText('{prefix}Caps no longer name their currency (was {was}).', {prefix, was: from.currency}),
      );
    for (const [field, [n, c]] of pairs) {
      const cap = prefix + uiText(policyCapLabels[field]),
        was = from[c] ?? from[n];
      if (was === undefined) continue;
      if (to[c] === undefined && to[n] === undefined)
        out.push(uiText('Removes the {cap} (was {was}).', {cap, was: fmt(was)}));
      else if (from[c] !== undefined && to[c] !== undefined) {
        if (to[c] > from[c])
          out.push(uiText('Raises the {cap} from {was} to {now}.', {cap, was: fmt(from[c]), now: fmt(to[c])}));
      } else if (from[n] !== undefined && to[n] !== undefined) {
        if (to[n] > from[n])
          out.push(uiText('Raises the {cap} from {was} to {now}.', {cap, was: fmt(from[n]), now: fmt(to[n])}));
      } else out.push(uiText('States the {cap} in another unit; check it.', {cap}));
    }
  };
  caps(stored, next, '');
  const gateways = new Set([...Object.keys(stored.per_gateway ?? {}), ...Object.keys(next.per_gateway ?? {})]);
  for (const g of gateways) caps(stored.per_gateway?.[g] ?? {}, next.per_gateway?.[g] ?? {}, platform(g) + ' · ');
  return out;
}
/** Shows `values` in the policy form: checkboxes by checked, every other field by value. */
function fillPolicyForm(form, values) {
  for (const [name, v] of Object.entries(values)) {
    const el = form?.elements?.namedItem?.(name);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = String(v ?? '');
  }
}
/** The line under the account picker: which stored policy the form shows, or that saving creates one. */
function storedPolicyNote(stored) {
  return stored
    ? uiText('Existing policy · revision {revision} · last updated {time} · ID {id}', {
        revision: stored.revision,
        time: date(stored.updated_at),
        id: String(stored.id).slice(0, 12),
      })
    : uiText('This account has no policy of its own yet; saving creates one.');
}
let pendingPolicyBinding = '';
function ownerServiceTimings(timing) {
  const labels = {
    workspace: 'Workspace',
    campaign: 'Campaign plans',
    analysis: 'Reporting analysis',
    overview: 'Reporting Overview',
    preview: 'Ad previews',
    media: 'Creative preparation',
    write: 'Reviewed writes',
    native_other: 'Native and other tools',
  };
  const number = value =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? uiNumber(value, {maximumFractionDigits: 3})
      : uiText('Unknown');
  const bucket = value =>
    !value
      ? uiText('Unknown')
      : value.upper_ms === null
        ? uiText('Over {value} ms', {value: number(value.lower_ms)})
        : uiText('Up to {value} ms', {value: number(value.upper_ms)});
  const rows = Array.isArray(timing?.items) ? timing.items : [];
  const gaps =
    timing?.unavailable_counters > 0 ||
    timing?.persistence_failures_in_this_process > 0 ||
    rows.some(row => row.omitted_count > 0 || ['clock_changed', 'invalid_counter'].includes(row.reset_reason));
  return `<p>${esc(uiText('Completed tool attempts in the current 15-minute interval. Internal calls and ownership refreshes are included; provider HTTP requests are counted separately.'))}</p><p>${esc(uiText('Timings measure work inside the tool handler, before timing storage and response delivery.'))}</p><p>${esc(uiText('Success and error counts describe response envelopes. A successful response can contain a blocked, pending or failed workflow. Percentile buckets are approximate bounds.'))}</p>${timing ? `<p>${esc(uiText('Interval begins: {time}', {time: date(timing.window_start_ms)}))}</p>` : ''}${gaps ? `<p class="notice">${esc(uiText('Some counters restarted or omitted measurements. Timing summaries cover the measured attempts only.'))}</p>` : ''}${timing?.persistence_failures_in_this_process > 0 ? `<p>${esc(uiText('Timing storage errors in this process: {count}', {count: number(timing.persistence_failures_in_this_process)}))}</p>` : ''}${rows.length ? `<p class="small">${esc(uiText('Scroll horizontally to see every metric.'))}</p><div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Tool response timings'))}"><table class="review-table service-timings-table"><caption>${esc(uiText('Tool response timings'))}</caption><thead><tr>${['Tool group', 'Measured attempts', 'Success responses', 'Error responses', 'Mean time in ms', 'Median bucket', '95th percentile bucket', 'Omitted measurements'].map(label => `<th scope="col">${esc(uiText(label))}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr><th scope="row">${esc(uiText(labels[row.category] ?? 'Unknown'))}</th><td>${esc(number(row.attempts))}</td><td>${esc(number(row.successes))}</td><td>${esc(number(row.errors))}</td><td>${esc(number(row.mean_ms))}</td><td>${esc(bucket(row.p50_bucket))}</td><td>${esc(bucket(row.p95_bucket))}</td><td>${esc(number(row.omitted_count))}</td></tr>`).join('')}</tbody></table></div>` : `<p class="empty">${esc(uiText('No usable timing observations are available for this interval.'))}</p>`}`;
}
function ownerWorkerHealth(worker) {
  const count = value => Number.isSafeInteger(value) && value >= 0,
    observed = worker?.observations,
    known =
      worker?.version === 1 &&
      count(worker.at) &&
      worker.at <= 8640000000000000 &&
      worker.observation_limit === 100 &&
      worker.heartbeat_byte_limit === 512 &&
      worker.stale_after_ms === 90000 &&
      ['total_heartbeat_records', 'observed_records', 'active_records', 'unavailable_records'].every(key =>
        count(worker[key]),
      ) &&
      worker.total_heartbeat_records === worker.observed_records + worker.unavailable_records &&
      worker.active_records <= worker.observed_records &&
      Array.isArray(observed) &&
      observed.length === Math.min(worker.observed_records, 100) &&
      worker.has_more === worker.observed_records > observed.length &&
      observed.every(
        (row, index) =>
          row &&
          ['idle', 'working'].includes(row.state) &&
          count(row.age_ms) &&
          row.age_ms <= worker.at &&
          row.stale === row.age_ms > 90000 &&
          (!index || row.age_ms >= observed[index - 1].age_ms),
      ) &&
      observed.filter(row => !row.stale).length === Math.min(worker.active_records, 100) &&
      worker.status ===
        (worker.active_records > 0
          ? 'active'
          : worker.unavailable_records > 0
            ? worker.observed_records > 0
              ? 'uncertain'
              : 'unavailable'
            : worker.observed_records > 0
              ? 'stale'
              : 'not_observed');
  const meaning = `<p>${esc(uiText('These observations show whether shared background processes have recently reported. They do not confirm workspace jobs, delivery, capacity or provider acceptance.'))}</p>`;
  if (!known)
    return (
      meaning +
      `<p class="notice">${esc(uiText('Process observations are unavailable. Refresh health to obtain a current, bounded observation.'))}</p>`
    );
  const label =
      worker.status === 'active'
        ? uiText('Background processes recently observed')
        : worker.status === 'stale'
          ? uiText('Only older process observations')
          : worker.status === 'uncertain'
            ? uiText('Process observations uncertain')
            : worker.status === 'unavailable'
              ? uiText('Process observations unavailable')
              : uiText('No process heartbeat has been observed'),
    number = value => uiNumber(value, {maximumFractionDigits: 3});
  // WEB-08: lead with a verdict (the newest report's age in human terms, the threshold used and the counts by
  // activity); the raw observations stay available, collapsed, with their exact seconds.
  const working = observed.filter(row => row.state === 'working').length,
    verdict = observed.length
      ? uiText('Newest report {age} ago; reports older than {threshold} are not recent.', {
          age: ownerAge(observed[0].age_ms),
          threshold: ownerAge(worker.stale_after_ms),
        }) +
        ' ' +
        uiText('Newest observations shown: {shown} ({working} working, {idle} idle).', {
          shown: uiNumber(observed.length),
          working: uiNumber(working),
          idle: uiNumber(observed.length - working),
        })
      : '';
  return (
    meaning +
    `<p class="worker-health-verdict"><strong>${esc(label)}</strong>${verdict ? ' · ' + esc(verdict) : ''}</p><p>${esc(uiText('Observed at: {time}', {time: date(worker.at)}))}</p><p>${esc(uiText('Stored heartbeats: {total}. Valid observations: {valid}. Recently observed: {active}. Unavailable observations: {unavailable}.', {total: number(worker.total_heartbeat_records), valid: number(worker.observed_records), active: number(worker.active_records), unavailable: number(worker.unavailable_records)}))}</p><p class="small">${esc(uiText('Counts cover all stored process heartbeats. At most 100 valid observations are shown. Missing, malformed, oversized, duplicate-key or future records do not establish health.'))}</p>${worker.has_more ? `<p class="notice">${esc(uiText('More valid observations are included in the aggregate counts.'))}</p>` : ''}${observed.length ? `<details class="worker-health-details"><summary>${esc(uiText('Show observations ({count})', {count: uiNumber(observed.length)}))}</summary><p class="small">${esc(uiText('Scroll horizontally to see every metric.'))}</p><div class="data-scroll worker-health-table" role="region" tabindex="0" aria-label="${esc(uiText('Background process observations'))}"><table class="review-table"><caption>${esc(uiText('Background process observations'))}</caption><thead><tr>${['Reported activity', 'Observation age', 'Older than 90 seconds'].map(label => `<th scope="col">${esc(uiText(label))}</th>`).join('')}</tr></thead><tbody>${observed.map(row => `<tr><th scope="row">${esc(row.state === 'idle' ? uiText('Idle') : uiText('Working'))}</th><td title="${esc(uiText('{seconds} seconds', {seconds: number(row.age_ms / 1000)}))}">${esc(ownerAge(row.age_ms))}</td><td>${esc(row.stale ? uiText('Yes') : uiText('No'))}</td></tr>`).join('')}</tbody></table></div></details>` : `<p class="empty">${esc(uiText('No valid process observations are available.'))}</p>`}`
  );
}
/** An age in the largest unit that keeps it readable: seconds under 2 minutes, minutes under 2 hours, then hours. */
function ownerAge(ms) {
  const seconds = ms / 1000,
    unit = (value, name, digits = 0) =>
      uiNumber(value, {style: 'unit', unit: name, unitDisplay: 'long', maximumFractionDigits: digits});
  if (seconds < 120) return unit(Math.round(seconds), 'second');
  if (seconds < 7200) return unit(Math.round(seconds / 60), 'minute');
  if (seconds < 172800) return unit(seconds / 3600, 'hour', 1);
  return unit(seconds / 86400, 'day', 1);
}
/** Deployment-wide rate-limit attribution (SEC-01): counts and booleans only; no client address is ever shown. */
function ownerRateLimits(limits) {
  const state = value => (value ? uiText('Yes') : uiText('No')),
    count = Number.isSafeInteger(limits.distinct_limit_keys_last_hour)
      ? uiNumber(limits.distinct_limit_keys_last_hour)
      : uiText('Unknown');
  return `<section class="panel" id="owner-rate-limits"><h3>${esc(uiText('Rate-limit attribution'))}</h3><p>${esc(uiText('Key source: {source}', {source: String(limits.key_source)}))}</p><p>${esc(uiText('Distinct rate-limit keys in the last hour: {count}', {count}))}</p><p>${esc(uiText('X-Real-IP seen in the last hour: {state}. CF-Connecting-IP seen in the last hour: {cf}.', {state: state(limits.headers_seen_last_hour?.x_real_ip), cf: state(limits.headers_seen_last_hour?.cf_connecting_ip)}))}</p>${limits.proxy_headers_ignored ? `<p class="notice">${esc(uiText('A proxy sends X-Real-IP, but this key source ignores it, so clients may share one rate-limit key. Set AMCP_CLIENT_IP_SOURCE as the Railway deployment guide describes.'))}</p>` : ''}${Number.isSafeInteger(limits.email_requests_withheld) ? `<p>${esc(uiText('Reset, registration and email-change requests answered without sending at the per-email limit: {withheld}. Sign-in refusals to known devices: {refused}.', {withheld: uiNumber(limits.email_requests_withheld), refused: uiNumber(limits.known_device_refusals ?? 0)}))}</p>` : ''}<p class="small">${esc(uiText('Counts cover this server process since it started. AMCP never stores or shows client addresses here.'))}</p></section>`;
}
/**
 * The deployment's AI-client registrations (MCP-03): the registered count under its storage backstop, the registrations
 * of the last 24 hours against the per-address and daily limits, and an alarm near a limit. Counts only, never a client
 * or an address.
 */
function ownerMcpClients(c) {
  const n = value => (Number.isSafeInteger(value) ? uiNumber(value) : uiText('Unknown'));
  return `<p id="owner-mcp-clients">${esc(uiText('AI client registrations: {registered} of {limit}. {headroom} free; {releasable} can be released at the next registration.', {registered: n(c.registered), limit: n(c.limit), headroom: n(c.headroom), releasable: n(c.releasable_on_next_registration)}))}${Number.isSafeInteger(c.daily_limit) ? ` ${esc(uiText('New registrations in the last 24 hours: {recent} of {daily}; at most {perAddress} from one network address.', {recent: n(c.registered_last_24h), daily: n(c.daily_limit), perAddress: n(c.per_address_daily_limit)}))}` : ''}</p>${c.alarms?.length ? `<p class="notice" id="owner-mcp-clients-alarm" role="status">${esc(uiText('AI client registrations are close to a limit. New connections may be refused until older registrations leave the 24-hour window or are released.'))}</p>` : ''}`;
}
/** The report retention in force (SEC-07, owner decision P3): this workspace's period or the deployment default. */
function ownerReportRetention(r) {
  if (!r) return '';
  const days = uiNumber(r.days);
  return `<p class="form-note" id="owner-report-retention">${esc(
    r.source === 'workspace'
      ? uiText('In force: finished report records of this workspace are deleted after {days} days.', {days})
      : r.source === 'deployment_default'
        ? uiText(
            'In force: until you save a period, finished report records are deleted after {days} days, the default of this deployment.',
            {days},
          )
        : uiText('Automatic report cleanup is off on this deployment until you save a period.'),
  )}</p>`;
}
// WRT-05: what the owner sees of executions over a cap and of review friction, both read from the audit.
function ownerCapOverrides(o) {
  if (!o || !Number.isSafeInteger(o.count)) return `<p class="empty">${esc(uiText('Unknown'))}</p>`;
  const days = uiNumber(o.window_days);
  if (!o.count) return `<p>${esc(uiText('No change went beyond a spending cap in the last {days} days.', {days}))}</p>`;
  return `<p class="notice" role="status">${esc(uiText('In the last {days} days, {count} reviewed changes went beyond a spending cap after the user confirmed it.', {days, count: uiNumber(o.count)}))}</p><div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Executions over a spending cap'))}"><table class="review-table"><caption>${esc(uiText('Executions over a spending cap'))}</caption><thead><tr>${['When', 'Account', 'Caps exceeded', 'Executed by', 'Role', 'Review'].map(label => `<th scope="col">${esc(uiText(label))}</th>`).join('')}</tr></thead><tbody>${o.latest.map(x => `<tr><th scope="row">${esc(date(x.at))}</th><td><bdi dir="ltr">${esc(x.gateway ? platformName(x.gateway) : '')} ${esc(x.account_id ?? '')}</bdi></td><td><code dir="ltr">${esc((x.rules ?? []).join(', '))}</code></td><td><bdi dir="auto">${esc(x.actor ?? uiText('Unknown'))}</bdi></td><td>${esc(x.actor_role ?? uiText('Unknown'))}</td><td><code dir="ltr">${esc(x.review_id)}</code></td></tr>`).join('')}</tbody></table></div>`;
}
function ownerReviewFriction(r) {
  if (!r || !Number.isSafeInteger(r.prepares)) return `<p class="empty">${esc(uiText('Unknown'))}</p>`;
  const n = value => (typeof value === 'number' ? uiNumber(value, {maximumFractionDigits: 2}) : uiText('Unknown')),
    rows = [
      ['Expired reviews', r.counts.REVIEW_EXPIRED, r.per_100_prepares.review_expired],
      ['Changed state', r.counts.STATE_CHANGED, r.per_100_prepares.state_changed],
      ['Acknowledgement refusals', r.counts.acknowledgement_refusals, r.per_100_prepares.acknowledgement_refusals],
      ['Uncertain outcomes', r.counts.WRITE_OUTCOME_UNCERTAIN, r.per_100_prepares.write_outcome_uncertain],
      ['Not sent', r.counts.write_not_sent, r.per_100_prepares.write_not_sent],
      // WRT-09: a person's approvals on the website, while an approval mode is on.
      ...(r.approvals?.approved
        ? [['Approvals on the website', r.approvals.approved, r.approvals.per_100_prepares]]
        : []),
    ];
  return `<p>${esc(uiText('In the last {days} days: {prepares} reviews prepared, {executes} executed.', {days: n(r.window_days), prepares: n(r.prepares), executes: n(r.executes)}))}</p><p>${esc(uiText('Time from prepare to execute (ms): median {p50}, 90th percentile {p90}, 99th percentile {p99}.', {p50: n(r.latency_ms.p50), p90: n(r.latency_ms.p90), p99: n(r.latency_ms.p99)}))}</p>${r.approvals?.latency_ms?.count ? `<p>${esc(uiText('Time from prepare to a person’s approval on the website (ms): median {p50}, 90th percentile {p90}.', {p50: n(r.approvals.latency_ms.p50), p90: n(r.approvals.latency_ms.p90)}))}</p>` : ''}${r.complete ? '' : `<p class="notice">${esc(uiText('More audit rows than one read covers; these counts are partial.'))}</p>`}<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Review friction'))}"><table class="review-table"><caption>${esc(uiText('Review friction'))}</caption><thead><tr>${['Outcome', 'Count', 'Per 100 prepares'].map(label => `<th scope="col">${esc(uiText(label))}</th>`).join('')}</tr></thead><tbody>${rows.map(([label, count, rate]) => `<tr><th scope="row">${esc(uiText(label))}</th><td>${esc(n(count))}</td><td>${esc(n(rate))}</td></tr>`).join('')}</tbody></table></div>${r.state_changed_paths?.length ? `<h4>${esc(uiText('Most changed fields (paths only)'))}</h4><ul>${r.state_changed_paths.map(p => `<li><code dir="ltr">${esc(p.path)}</code> · ${esc(n(p.count))}</li>`).join('')}</ul>` : ''}`;
}
/**
 * The provider access panel (ACC-05): per connected platform, the owner's dated declarations from the provider access
 * register, the last successful sync and last sync refusal, each program's latest observation and the acceptance
 * ledger's counts. Stored state only: no platform is asked, and no token, account ID or login name is shown.
 */
function ownerProviderAccess(pa) {
  if (!pa || !Array.isArray(pa.providers)) return '';
  const n = value => (Number.isSafeInteger(value) ? uiNumber(value) : uiText('Unknown')),
    when = value => (Number.isSafeInteger(value) ? date(value) : uiText('Unknown')),
    statuses = {
      undeclared: 'Not declared',
      approved: 'Approved',
      applied: 'Applied for',
      denied: 'Denied',
      not_needed: 'Not needed',
    },
    observed = {observed: 'Observed', blocked: 'Blocked', unverified: 'Unverified'},
    approvals = p =>
      `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Declared approvals'))}"><table class="review-table"><caption>${esc(uiText('Declared approvals'))}</caption><thead><tr>${['Approval', 'Status', 'Value', 'Declared', 'Stale'].map(label => `<th scope="col">${esc(uiText(label))}</th>`).join('')}</tr></thead><tbody>${p.approvals.items.map(a => `<tr><th scope="row">${esc(uiText(a.label))}</th><td>${esc(uiText(statuses[a.status] ?? 'Unknown'))}</td><td>${a.value ? `<bdi dir="ltr">${esc(a.value)}</bdi>` : '—'}</td><td>${a.declared_at ? `<bdi dir="ltr">${esc(a.declared_at)}</bdi>` : '—'}</td><td>${esc(a.stale ? uiText('Yes') : uiText('No'))}</td></tr>`).join('')}</tbody></table></div>`,
    program = x =>
      `<li><strong>${esc(uiText(x.name))}</strong> · ${esc(x.mode === 'live_read' ? uiText('Checked with one bounded read') : uiText('Listed for discovery only; no request'))}${x.mode === 'live_read' ? ` · ${x.last_observation ? esc(uiText('Last observation: {state} on {time}', {state: uiText(observed[x.last_observation.state] ?? 'Unknown'), time: when(x.last_observation.checked_at)})) + (x.last_observation.code ? ` <code dir="ltr">${esc(x.last_observation.code)}${x.last_observation.provider_code ? ' ' + esc(x.last_observation.provider_code) : ''}</code>` : '') : esc(uiText('No observation in the last 30 days.'))}` : ''}</li>`;
  return `<section class="panel" id="owner-provider-access"><h3>${esc(uiText('Provider access'))}</h3><p>${esc(uiText('What each connected platform has granted this deployment, as you declared it in the provider access register. A declaration grants nothing: the platform decides every request.'))}</p>${pa.register === 'invalid' ? `<p class="notice" role="status">${esc(uiText('The provider access register is invalid, so no declaration is shown.'))}</p>` : ''}${
    pa.providers.length
      ? pa.providers
          .map(
            p =>
              `<details class="provider-access" data-provider="${esc(p.id)}"><summary><strong>${esc(platformName(p.gateway))}</strong> · ${esc(uiText('{declared} of {total} approvals declared', {declared: n(p.approvals.declared), total: n(p.approvals.total)}))}${p.approvals.stale ? ` · <span class="status attention">${esc(uiText('{count} stale', {count: n(p.approvals.stale)}))}</span>` : ''}</summary>${approvals(p)}<p>${esc(p.last_successful_sync_at ? uiText('Last successful sync: {time}', {time: when(p.last_successful_sync_at)}) : uiText('No successful sync is recorded.'))}</p>${p.last_sync_refusal ? `<p>${esc(uiText('Last sync refusal: {time}', {time: when(p.last_sync_refusal.at)}))} <code dir="ltr">${esc(p.last_sync_refusal.code)}</code></p>` : ''}${p.programs.length ? `<h4>${esc(uiText('Programs'))}</h4><ul>${p.programs.map(program).join('')}</ul>` : ''}<p>${esc(uiText('Acceptance ledger: {read} read-accepted and {write} write-accepted actions; {refused} refused; {stale} stale.', {read: n(p.acceptance.read_accepted), write: n(p.acceptance.write_accepted), refused: n(p.acceptance.refused), stale: n(p.acceptance.stale)}))}</p></details>`,
          )
          .join('')
      : `<p class="empty">${esc(uiText('Connect a platform to see its access here.'))}</p>`
  }</section>`;
}
const ownerCall = async input => {
  const r = await api('/api/workspace/workspace', {method: 'POST', body: JSON.stringify(input)});
  // The whole refusal, with its remedy and request reference, so the owner sees what to do and what to quote (WEB-03).
  if (!r.success)
    throw Object.assign(new Error(r.error?.message ?? uiText('Workspace operation failed.')), r.error ?? {}, {
      requestId: r.meta?.requestId ?? r.meta?.request_id,
    });
  return r.data;
};
renderSettings = async function () {
  const request = ++ownerSettingsRequest,
    ownerSession = session,
    ownerIdentity = identityKey(session),
    ownerNavigation = navigationGeneration;
  baseWorkspaceSettings();
  if (!session.authenticated || (!session.administrator && session.workspaceRole !== 'owner')) return;
  const [h, signin] = await Promise.all([ownerCall({action: 'health'}), api('/api/account/options')]);
  if (
    location.pathname !== '/settings' ||
    request !== ownerSettingsRequest ||
    session !== ownerSession ||
    ownerIdentity !== identityKey(session) ||
    ownerNavigation !== navigationGeneration ||
    !session.authenticated ||
    (!session.administrator && session.workspaceRole !== 'owner')
  )
    return;
  const workspaceDefault = (h.policies ?? []).find(p => p.id === 'workspace_default');
  const area = document.createElement('section');
  area.className = 'owner-operations';
  // Below the page's own heading, so the page title comes first (F-43).
  const pageHeading = content.querySelector(':scope > .page-heading');
  if (pageHeading) pageHeading.after(area);
  else content.append(area);
  // WEB-08: Safety first (the emergency stop and spending caps), then Access (account-approvals.js fills it for the
  // instance owner), Health and Retention, each reachable from the sub-navigation in one step.
  area.innerHTML = `<div class="report-heading"><div><span class="eyebrow">${esc(uiText('WORKSPACE OWNER'))}</span><h2>${esc(uiText('Health & operating controls'))}</h2><p>${esc(uiText('Connection readiness, deliveries and the boundaries you set for your team.'))}</p></div><button class="button" id="owner-refresh">${esc(uiText('Refresh health'))}</button></div><p id="owner-error" class="error" role="alert"></p><nav class="settings-subnav" aria-label="${esc(uiText('Settings sections'))}"><ul><li><a href="#settings-safety">${esc(uiText('Safety'))}</a></li><li data-settings-access hidden><a href="#settings-access">${esc(uiText('Access'))}</a></li><li><a href="#settings-health">${esc(uiText('Health'))}</a></li><li><a href="#settings-retention">${esc(uiText('Retention'))}</a></li><li><a href="#settings-account">${esc(uiText('Account'))}</a></li></ul></nav><section id="settings-safety" class="settings-group" aria-labelledby="settings-safety-heading"><h2 id="settings-safety-heading">${esc(uiText('Safety'))}</h2><section class="panel" id="owner-write-pause"><h3>${esc(uiText('Pause all writes'))}</h3>${h.write_pause ? `<p class="notice"><strong>${esc(uiText('Writes are paused'))}</strong> ${esc(uiText('since'))} ${esc(date(h.write_pause.paused_at))} ${esc(uiText('by'))} ${esc(h.write_pause.paused_by)}: ${esc(h.write_pause.reason)}</p><p>${esc(pauseScopeText(h.write_pause.scope))}</p><button class="button primary" id="owner-resume-writes">${esc(uiText('Resume writes'))}</button>` : `<p>${esc(uiText('An emergency stop for this workspace: every reviewed write and media upload is refused until an owner resumes. Nothing already submitted is undone.'))}</p><form id="owner-pause-writes"><label>${esc(uiText('Reason (shown to everyone whose write is refused)'))}<input name="reason" maxlength="500" required></label><label>${esc(uiText('What to pause'))}<select name="pause_scope"><option value="all">${esc(uiText('Everything: advertising writes, media uploads and report jobs'))}</option><option value="advertising">${esc(uiText('Advertising writes and media uploads only'))}</option><option value="provider_jobs">${esc(uiText('Report and export jobs only'))}</option></select></label><button class="button">${esc(uiText('Pause all writes'))}</button></form>`}${providerJobsLine(h.provider_jobs)}</section><section class="panel"><h3>${esc(uiText('Account spending policy'))}</h3><p>${esc(uiText('Set caps for reviewed changes. These limits govern requested budgets; they do not measure or cap the provider’s billed spend.'))}</p><form id="owner-spend-policy" class="workspace-form"><label>${esc(uiText('Selected account'))}<select name="binding" required><option value="">${esc(uiText('Choose an account'))}</option>${platforms
    .filter(p => p.reviewedWrites !== false)
    .flatMap(p =>
      p.connections.flatMap(c =>
        (c.accounts ?? []).map(
          a =>
            `<option value="${esc(JSON.stringify([c.gateway ?? p.gateway, c.id, a]))}">${esc(accountLabel(p, c, a))}</option>`,
        ),
      ),
    )
    .join(
      '',
    )}</select></label><label>${esc(uiText('When a change goes beyond a cap'))}<select name="enforcement"><option value="confirm" selected>${esc(uiText('Ask for confirmation (recommended)'))}</option><option value="block">${esc(uiText('Refuse the change'))}</option></select></label><label>${esc(uiText('Amounts are in'))}<select name="unit"><option value="currency">${esc(uiText('Account currency (where the platform unit is documented)'))}</option><option value="native">${esc(uiText('Native API units'))}</option></select></label><label>${esc(uiText('Currency of these caps'))}<input name="currency" maxlength="3" pattern="[A-Za-z]{3}" autocomplete="off" placeholder="USD"></label><p class="form-note">${esc(uiText('Caps compare only an account that spends in this currency; AMCP never converts between currencies. Left empty, the account’s currency from its last live check is used.'))}</p><p class="form-note" id="owner-policy-unit" aria-live="polite">${policyUnitNote(h, '')}</p><p class="form-note" id="owner-policy-existing" aria-live="polite">${esc(uiText('Choose an account to see its stored policy.'))}</p><label>${esc(uiText('Maximum budget'))}<input name="max_budget" type="number" min="0" step="any"></label><label>${esc(uiText('Maximum increase per change, %'))}<input name="max_budget_increase_percent" type="number" min="0" max="10000" step="any" value="20"></label><label>${esc(uiText('Cumulative daily increases'))}<input name="max_daily_increase" type="number" min="0" step="any"></label><label>${esc(uiText('Maximum bid'))}<input name="max_bid" type="number" min="0" step="any"></label><label>${esc(uiText('Maximum lifetime or total budget'))}<input name="max_total_budget" type="number" min="0" step="any"></label><label class="check"><input name="allow_activation" type="checkbox" checked> ${esc(uiText('Allow activation after review'))}</label><label class="check"><input name="allow_deletion" type="checkbox"> ${esc(uiText('Allow deletion after review'))}</label><p class="form-note">${esc(uiText('Without it, AMCP also refuses deletion sent as a status value (TikTok DELETE, Meta DELETED) and Meta product feed deletion rules: turning feed deletion on, or a new file address or fetch interval for a feed whose deletion is on.'))}</p><p class="form-note">${esc(uiText('With “Ask for confirmation”, a change beyond a cap is still prepared; the reviewer sees which cap and by how much, and it runs only after they confirm. Activation and deletion rules always refuse.'))}</p><button class="button primary">${esc(uiText('Save account policy'))}</button></form><form id="owner-workspace-policy" class="workspace-form"><h4>${esc(uiText('Workspace default'))}</h4><p class="form-note">${esc(workspaceDefault ? uiText('Existing default · revision {revision} · last updated {time}', {revision: workspaceDefault.revision, time: date(workspaceDefault.updated_at)}) : uiText('No workspace default yet; saving creates one.'))}</p><p class="form-note">${esc(uiText('Covers every account without a policy of its own. Budget caps are per platform in account currency, because each platform counts money in its own unit.'))}</p><label>${esc(uiText('When a change goes beyond a cap'))}<select name="enforcement"><option value="confirm"${workspaceDefault?.enforcement === 'block' ? '' : ' selected'}>${esc(uiText('Ask for confirmation (recommended)'))}</option><option value="block"${workspaceDefault?.enforcement === 'block' ? ' selected' : ''}>${esc(uiText('Refuse the change'))}</option></select></label><label>${esc(uiText('Maximum increase per change, %'))}<input name="max_budget_increase_percent" type="number" min="0" max="10000" step="any" value="${esc(policyText(workspaceDefault?.max_budget_increase_percent))}"></label>${approvalPolicyControls(workspaceDefault)}${Object.entries(
    h.budget_units ?? {},
  )
    .filter(([g]) => platforms.some(p => p.connections.some(c => (c.gateway ?? p.gateway) === g)))
    .map(
      ([g, u]) =>
        `<label>${esc(platformName(g))} ${esc(uiText('maximum budget, account currency'))}<input name="cap:${esc(g)}" type="number" min="0" step="any" value="${esc(policyText(workspaceDefault?.per_gateway?.[g]?.max_budget_currency))}"><small>${esc(uiText('Stored as'))} ${esc(u.unit)}${workspaceDefault?.per_gateway?.[g]?.max_budget_currency === undefined && workspaceDefault?.per_gateway?.[g]?.max_budget_native !== undefined ? ' · ' + esc(uiText('kept as {amount} native units unless you enter a new cap', {amount: workspaceDefault.per_gateway[g].max_budget_native})) : ''}</small></label><label>${esc(platformName(g))} ${esc(uiText('currency of this cap'))}<input name="currency:${esc(g)}" maxlength="3" pattern="[A-Za-z]{3}" autocomplete="off" placeholder="USD" value="${esc(workspaceDefault?.per_gateway?.[g]?.currency ?? '')}"></label>`,
    )
    .join(
      '',
    )}<button class="button">${esc(uiText('Save workspace default'))}</button></form>${(h.policy_warnings ?? []).map(w => `<div class="notice" role="status"><strong>${esc(policyWarningLabel(h, w))}</strong><p>${esc(uiText(w.message))}</p></div>`).join('')}<div id="owner-policy-list">${h.policies.map(p => `<details><summary>${p.gateway ? esc(platformName(p.gateway)) + ' · ' + esc(p.account_id) : uiText('Workspace default')} · ${p.enforcement === 'block' ? uiText('refuses beyond caps') : uiText('asks beyond caps')}</summary><pre>${esc(JSON.stringify(p, null, 2))}</pre></details>`).join('')}</div></section><section class="panel" id="owner-cap-overrides"><h3>${esc(uiText('Executions over a spending cap'))}</h3>${ownerCapOverrides(h.cap_overrides)}</section><section class="panel" id="owner-review-friction"><h3>${esc(uiText('Review friction'))}</h3>${ownerReviewFriction(h.review_friction)}</section></section><section id="settings-access" class="settings-group" hidden></section><section id="settings-health" class="settings-group" aria-labelledby="settings-health-heading"><h2 id="settings-health-heading">${esc(uiText('Health'))}</h2><div class="report-summary-grid"><article class="report-summary-card"><small>${esc(uiText('Sign-in email'))}</small><h3>${signin.emailEnabled ? uiText('Configured') : uiText('Setup needed')}</h3><p>${esc(uiText('Verified registration, invitations and password recovery use the durable email queue.'))}</p>${!signin.emailEnabled ? `<code>AMCP_EMAIL_API_KEY<br>AMCP_EMAIL_FROM</code><p>${esc(uiText('Verify your sender domain in Resend, then set both server variables.'))}</p>` : ''}</article><article class="report-summary-card"><small>${esc(uiText('Social sign-in'))}</small><h3>${esc(uiText('Your providers'))}</h3>${signin.providers.map(p => `<p><strong>${esc(p.name)}</strong> · ${p.configured ? uiText('Configured') : uiText('Needs app credentials')}${p.callback ? `<br><code>` + esc(p.callback) + `</code>` : ''}</p>`).join('')}<a href="/account">${esc(uiText('Account security & members'))}</a></article><article class="report-summary-card"><small>${esc(uiText('Backup verification'))}</small><h3>${h.backup.status === 'verified' ? uiText('Restore checked') : uiText('Verification needed')}</h3><p>${esc(h.backup.message ?? uiText('Last verification: ') + date(h.backup.verified_at))}</p>${typeof h.backup.age_hours === 'number' ? `<p><strong>${esc(uiText('Last backup {age} hours ago ({time}).', {age: uiNumber(h.backup.age_hours, {maximumFractionDigits: 1}), time: date(h.backup.verified_at)}))}</strong></p>` : ''}<code>npm run admin -- backup &lt;new-file&gt;</code></article></div><section class="panel" id="owner-worker-health"><h3>${esc(uiText('Background process observations'))}</h3>${ownerWorkerHealth(h.operations?.worker)}</section><section class="panel" id="owner-service-timings"><h3>${esc(uiText('Tool response timings'))}</h3>${ownerServiceTimings(h.operations?.timings)}</section><section class="panel"><h3>${esc(uiText('Connection health'))}</h3>${h.connections.map(c => `<div class="schedule-row"><span><strong dir="auto" data-native>${esc(c.name)}</strong><small>${esc(c.gateway.replace('_native_action', ''))} · ${c.account_count} ${esc(uiText('selected ·'))} ${c.write_account_count} ${esc(uiText('write grants'))}</small></span><span class="status ${c.needs_attention ? 'attention' : ''}">${c.expires_at ? uiText('Expires ') + date(c.expires_at) : uiText('Provider expiry unavailable')}</span></div>`).join('') || `<p class="empty">${esc(uiText('Connect a platform to start.'))}</p>`}</section><section class="panel"><h3>${esc(uiText('Background work'))}</h3>${h.jobs.map(j => `<p><strong>${esc(pretty(j.kind))}</strong> · ${esc(j.state)} · ${j.count}</p>`).join('') || `<p>${esc(uiText('No background jobs.'))}</p>`}<h4>${esc(uiText('Email delivery'))}</h4>${h.email.map(e => `<p>${esc(pretty(e.state))}: ${e.count}</p>`).join('') || `<p>${esc(uiText('No queued deliveries for this workspace.'))}</p>`}${h.withheld_workbook_records ? `<h4>${esc(uiText('Workbook records withheld from Operations'))}</h4><p>${esc(uiText('Report runs: {runs}. Schedules: {schedules}. Records without a recoverable account scope are only counted here, never listed.', {runs: uiNumber(h.withheld_workbook_records.runs?.withheld ?? 0), schedules: uiNumber(h.withheld_workbook_records.schedules?.withheld ?? 0)}))}</p>` : ''}</section></section><section id="settings-retention" class="settings-group" aria-labelledby="settings-retention-heading"><h2 id="settings-retention-heading">${esc(uiText('Retention & downloads'))}</h2><section class="panel"><h3>${esc(uiText('Storage & retention'))}</h3><p>${(h.storage.database_bytes / 1048576).toFixed(1)} ${esc(uiText('MiB deployment database ·'))} ${h.storage.report_rows} ${esc(uiText('workspace report rows.'))}</p>${h.mcp_clients ? ownerMcpClients(h.mcp_clients) : ''}${Array.isArray(h.service_keys) ? `<div id="owner-service-keys"><p>${esc(uiText('Server-created service keys: {count} active. A member’s password, email or two-step change never ends them.', {count: uiNumber(h.service_keys.length)}))}</p>${h.service_keys.map(k => `<p><strong>${esc(k.label)}</strong> · ${esc(uiRole(k.role))} · ${k.expires_at ? esc(uiText('Expires {date}', {date: date(k.expires_at)})) : esc(uiText('No expiry'))}</p>`).join('')}</div>` : ''}<form id="owner-retention"><label>${esc(uiText('Keep completed report snapshots for (days)'))}<input name="days" type="number" min="7" max="365" value="${Number.isInteger(h.retention?.days) ? h.retention.days : ''}" required></label><p class="form-note">${esc(uiText('Saving sets this workspace’s own period in place of the deployment default. Audit records and write receipts are retained.'))}</p><button class="button">${esc(uiText('Save retention policy'))}</button></form>${ownerReportRetention(h.report_retention)}<details><summary>${esc(uiText('Workspace limits & API versions'))}</summary><pre>${esc(JSON.stringify({limits: h.limits, versions: h.api_versions}, null, 2))}</pre></details></section><section class="panel" id="owner-plan-policy-panel"><h3>${esc(uiText('Campaign plans'))}</h3>${h.plan_inventory ? `<p id="owner-plan-inventory">${esc(uiText('{active} of {limit} campaign plans in use; {archived} archived plans do not count.', {active: uiNumber(h.plan_inventory.active), limit: uiNumber(h.plan_inventory.limit), archived: uiNumber(h.plan_inventory.archived)}))}</p>` : ''}<form id="owner-plan-retention"><label>${esc(uiText('Delete archived campaign plans after (days; 0 keeps them)'))}<input name="days" type="number" min="0" max="3650" value="${h.retention?.archived_campaign_plans_days ?? 0}" required></label><p class="form-note">${esc(uiText('Only archived plans are deleted. Their audit records, write receipts and reviews are kept.'))}</p><button class="button">${esc(uiText('Save plan retention'))}</button></form><form id="owner-plan-policy"><label class="check"><input name="distinct" type="checkbox" ${h.plan_policy?.require_distinct_approver ? 'checked' : ''}> ${esc(uiText('A plan that changes spending or activates a launch needs an approver other than its owner'))}</label><button class="button">${esc(uiText('Save approval policy'))}</button></form></section><section class="panel" id="owner-export-policy-panel"><h3>${esc(uiText('Report file downloads'))}</h3><p>${esc(uiText('Operators, administrators and owners download report CSV, PDF, Excel and evidence files. Viewers read the same reports on screen.'))}</p><form id="owner-export-policy"><label class="check"><input name="viewer_downloads" type="checkbox" ${h.export_policy?.viewer_downloads ? 'checked' : ''}> ${esc(uiText('Viewers may download report files too'))}</label><button class="button">${esc(uiText('Save download policy'))}</button></form></section></section><h2 id="settings-account" class="settings-group-heading">${esc(uiText('Account & platform setup'))}</h2>`;
  if (h.rate_limits)
    area.querySelector('#owner-worker-health')?.insertAdjacentHTML('afterend', ownerRateLimits(h.rate_limits));
  // ACC-05: the provider access panel closes the Health group.
  if (h.provider_access)
    area.querySelector('#settings-health')?.insertAdjacentHTML('beforeend', ownerProviderAccess(h.provider_access));
  const bind = (selector, fn) =>
    authBind(selector, async el => {
      try {
        await fn(el);
      } catch (e) {
        // WEB-03: the reason, what to do and the request reference, not the message alone.
        $('#owner-error').textContent = errorMessage(e);
        $('#owner-error').scrollIntoView({block: 'center'});
      }
    });
  bind('#owner-refresh', async () => renderSettings());
  bind('#owner-retention', async f => {
    const days = Number(new FormData(f).get('days'));
    if (
      !(await confirmAction({
        title: uiText('Delete report snapshots older than {days} days?', {days}),
        consequence: uiText(
          'Saving turns on automatic cleanup: completed report snapshots older than {days} days are deleted from now on. Audit records and write receipts are kept.',
          {days},
        ),
        confirmLabel: uiText('Save and enable cleanup'),
      }))
    )
      return;
    await ownerCall({action: 'save_retention', days, confirmed: true});
    toast(uiText('Report retention policy saved.'));
    await renderSettings();
  });
  // Archived campaign plans are deleted only when the owner opts in; 0 keeps them (CMP-05).
  bind('#owner-plan-retention', async f => {
    const days = Number(new FormData(f).get('days'));
    if (
      days > 0 &&
      !(await confirmAction({
        title: uiText('Delete archived plans older than {days} days?', {days}),
        consequence: uiText(
          'Saving turns on automatic cleanup: campaign plans archived longer than {days} days are deleted from now on. Audit records, write receipts and reviews are kept.',
          {days},
        ),
        confirmLabel: uiText('Save and enable cleanup'),
      }))
    )
      return;
    await ownerCall({action: 'save_retention', archived_campaign_plans_days: days, confirmed: true});
    toast(uiText('Plan retention saved.'));
    await renderSettings();
  });
  // Maker-checker for plans that change spending (CMP-05); off by default. Either change asks first.
  bind('#owner-plan-policy', async f => {
    const distinct = new FormData(f).has('distinct');
    if (
      !(await confirmAction({
        title: distinct
          ? uiText('Require a different approver for spending plans?')
          : uiText('Let plan owners approve their own spending plans?'),
        consequence: distinct
          ? uiText(
              'A plan that changes spending or activates a launch can then be approved only by someone other than its owner: the owner shares it with an approver, who approves and runs it. One person alone can no longer approve such plans.',
            )
          : uiText('Any person who may approve a plan, its owner included, can then approve it.'),
        confirmLabel: uiText('Save approval policy'),
      }))
    )
      return;
    await ownerCall({action: 'save_plan_policy', require_distinct_approver: distinct, confirmed: true});
    toast(uiText('Approval policy saved.'));
    await renderSettings();
  });
  // Who may download report files (SEC-05): operators and up always; viewers only when the owner allows it.
  bind('#owner-export-policy', async f => {
    const viewers = new FormData(f).has('viewer_downloads');
    if (
      !(await confirmAction({
        title: viewers ? uiText('Let viewers download report files?') : uiText('Stop viewer downloads?'),
        consequence: viewers
          ? uiText('Viewers can then download CSV, PDF, Excel and evidence files of the reports they can read.')
          : uiText('Viewers keep reading reports on screen; only operators, administrators and owners download files.'),
        confirmLabel: uiText('Save download policy'),
      }))
    )
      return;
    await api('/api/export-policy', {
      method: 'POST',
      body: JSON.stringify({viewer_downloads: viewers, confirmed: true}),
    });
    toast(uiText('Download policy saved.'));
    await renderSettings();
  });
  bind('#owner-pause-writes', async f => {
    const reason = String(new FormData(f).get('reason') ?? '').trim(),
      // RPT-06: everything (the default), advertising writes only, or report and export jobs only.
      pauseScope = String(new FormData(f).get('pause_scope') ?? 'all');
    if (
      !(await confirmAction({
        title: uiText('Pause every reviewed write of this workspace?'),
        consequence: uiText(
          'Executions and media uploads are refused until an owner resumes writes. Reviews prepared now stay valid for five minutes.',
        ),
        confirmLabel: uiText('Pause all writes'),
      }))
    )
      return;
    await ownerCall({
      action: 'pause_writes',
      reason,
      ...(pauseScope !== 'all' ? {pause_scope: pauseScope} : {}),
      confirmed: true,
    });
    toast(uiText('Writes are paused.'));
    await renderSettings();
  });
  bind('#owner-resume-writes', async () => {
    if (
      !(await confirmAction({
        title: uiText('Resume reviewed writes?'),
        consequence: uiText('Executions and media uploads run again under every other control.'),
        confirmLabel: uiText('Resume writes'),
      }))
    )
      return;
    await ownerCall({action: 'resume_writes', confirmed: true});
    toast(uiText('Writes resumed.'));
    await renderSettings();
  });
  // A stale revision means another save came first: show the current policy again instead of overwriting it.
  const conflict = async (e, binding = '') => {
    if (e?.code !== 'REVISION_CONFLICT') throw e;
    pendingPolicyBinding = binding;
    await renderSettings();
    const el = $('#owner-error');
    if (el) {
      el.textContent = uiText(
        'This policy changed since the page was opened. The current policy is shown again; review it and save again.',
      );
      el.scrollIntoView?.({block: 'center'});
    }
  };
  const picker = $('#owner-spend-policy select[name=binding]');
  const showPolicy = () => {
    const b = picker.value ? JSON.parse(picker.value) : [''],
      stored = b[0] ? storedAccountPolicy(h, b[0], b[1], b[2]) : undefined;
    $('#owner-policy-unit').textContent = policyUnitNote(h, b[0]);
    $('#owner-policy-existing').textContent = b[0]
      ? storedPolicyNote(stored)
      : uiText('Choose an account to see its stored policy.');
    if (b[0])
      fillPolicyForm($('#owner-spend-policy'), accountPolicyValues(stored, bindingCurrency(h, b[0], b[1], b[2])));
  };
  picker?.addEventListener('change', showPolicy);
  if (picker && pendingPolicyBinding) {
    picker.value = pendingPolicyBinding;
    pendingPolicyBinding = '';
    showPolicy();
  }
  bind('#owner-spend-policy', async f => {
    const d = new FormData(f),
      binding = String(d.get('binding')),
      [gateway, connection_id, account_id] = JSON.parse(binding),
      stored = storedAccountPolicy(h, gateway, connection_id, account_id),
      values = Object.fromEntries(
        [
          'enforcement',
          'unit',
          'currency',
          'max_budget',
          'max_budget_increase_percent',
          'max_daily_increase',
          'max_bid',
          'max_total_budget',
        ].map(k => [k, String(d.get(k) ?? '')]),
      );
    values.allow_activation = d.has('allow_activation');
    values.allow_deletion = d.has('allow_deletion');
    // A new account policy replaces the workspace default for this account, so it is compared with that default.
    const policy = accountPolicyInput(values, stored),
      weaker = policyWeakenings(stored ?? workspaceDefaultFor(workspaceDefault, gateway), policy);
    if (
      weaker.length &&
      !(await confirmAction({
        title: uiText('Weaken the spending policy of this account?'),
        consequence: stored
          ? uiText('Saving makes these changes, and operators then work under them:')
          : uiText('This account follows the workspace default now. Its own policy would make these changes:'),
        items: weaker,
        confirmLabel: uiText('Save weaker policy'),
      }))
    )
      return;
    try {
      await ownerCall({
        action: 'save_spend_policy',
        gateway,
        connection_id,
        account_id,
        policy,
        expected_revision: stored?.revision ?? 0,
        confirmed: true,
      });
    } catch (e) {
      return conflict(e, binding);
    }
    toast(uiText('Account policy saved.'));
    pendingPolicyBinding = binding;
    await renderSettings();
  });
  bind('#owner-workspace-policy', async f => {
    const d = new FormData(f),
      caps = {},
      currencies = {};
    for (const [k, v] of d.entries())
      if (k.startsWith('cap:')) caps[k.slice(4)] = String(v);
      else if (k.startsWith('currency:')) currencies[k.slice(9)] = String(v);
    const policy = workspacePolicyInput(
        {
          enforcement: String(d.get('enforcement')),
          max_budget_increase_percent: String(d.get('max_budget_increase_percent') ?? ''),
          caps,
          currencies,
          approval_mode: String(d.get('approval_mode') ?? 'assistant_ack'),
          require_destructive_confirmation: d.has('require_destructive_confirmation'),
          cap_override_owner_only: d.has('cap_override_owner_only'),
        },
        workspaceDefault,
      ),
      weaker = policyWeakenings(workspaceDefault, policy, platformName);
    if (
      !(await confirmAction({
        title: uiText('Save the workspace default spending policy?'),
        consequence: weaker.length
          ? uiText(
              'It applies to every account without a policy of its own, from the next reviewed change, and weakens the default:',
            )
          : uiText('It applies to every account without a policy of its own, from the next reviewed change.'),
        items: weaker,
        confirmLabel: uiText('Save workspace default'),
      }))
    )
      return;
    try {
      await ownerCall({
        action: 'save_spend_policy',
        scope: 'workspace',
        policy,
        expected_revision: workspaceDefault?.revision ?? 0,
        confirmed: true,
      });
    } catch (e) {
      return conflict(e);
    }
    toast(uiText('Workspace default saved.'));
    await renderSettings();
  });
};
