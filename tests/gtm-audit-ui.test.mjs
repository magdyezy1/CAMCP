// MSR-01: the website pages GTM findings 25 at a time with a severity filter, shows grouped trigger references and
// a published-vs-draft consent view, all from the single audit response (no extra request).
import test from 'node:test';
import assert from 'node:assert/strict';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';

const w = 'accounts/001/containers/001/workspaces/002';
const findings = [
  ...Array.from({length: 30}, (_, i) => ({
    code: 'UNRESOLVED_FOLDER',
    severity: 'error',
    path: w + '/tags/' + (i + 1),
    message: 'The parent folder is absent from the complete workspace inventory.',
  })),
  ...Array.from({length: 20}, (_, i) => ({
    code: 'NO_FIRING_TRIGGER',
    severity: 'warning',
    path: w + '/tags/' + (i + 100),
    message: 'This unpaused tag has no explicit firing trigger; confirm whether tag sequencing invokes it.',
  })),
  {
    code: 'UNRESOLVED_OR_SYSTEM_TRIGGER',
    severity: 'unknown',
    path: w + '/tags/1',
    message:
      'Trigger 2147479553 is not in the workspace inventory; resolve whether it is provider-managed or missing before publishing.',
    message_localization: {key: 'unresolved_trigger', trigger_id: '2147479553'},
    grouping: 'trigger_id',
    trigger_id: '2147479553',
    entity_count: 1000,
    tag_count: 998,
    sample_paths: Array.from({length: 20}, (_, i) => w + '/tags/' + (i + 1)),
    sample_paths_truncated: true,
  },
];
const side = (setting, required_types = []) => ({setting, required_types});
const audit = {
  record_kind: 'measurement_audit',
  meaning: 'Native evidence',
  scope: {connection_id: 'gtm-login', account_id: '001', container_id: '001', workspace_id: '002'},
  configuration: {
    complete: true,
    finding_count: 1051,
    findings_truncated: true,
    finding_list: 'truncated',
    findings,
    versions: {live: {id: '8'}},
    live_consent_evidence: {
      scope: 'published_version_configuration',
      version_id: '8',
      counts: {notSet: 1, notNeeded: 1, needed: 2, unknown: 0},
    },
    consent_diff: {
      version: 1,
      draft_workspace_path: w,
      live_version_id: '8',
      network_requests: 0,
      rows: [
        {
          tag_id: '1',
          name: 'Purchase <img>',
          draft: side('needed', ['ad_storage']),
          live: side('needed', ['ad_storage']),
          state: 'same',
        },
        {tag_id: '2', name: 'Lead', draft: side('needed', ['ad_storage']), live: side('notNeeded'), state: 'differs'},
        {tag_id: '3', name: 'New', draft: side('notSet'), live: null, state: 'draft_only'},
        {tag_id: '4', name: 'Old', draft: null, live: side('needed', ['ad_user_data']), state: 'live_only'},
      ],
    },
  },
};
const articles = html => (html.match(/<article>/g) ?? []).length;

for (const locale of ['en', 'ar'])
  test(locale + ' MSR-01 findings are paged with a severity filter and grouped trigger counts', async () => {
    const f = accountWorkflowFixture(locale);
    f.respond(() => structuredClone(audit));
    await f.run('renderMeasurement()');
    await f.bindings.get('#measurement-audit')(f.node('#measurement-audit'));
    assert.equal(f.calls.length, 1, 'the views come from one audit response');
    const html = f.node('#measurement-result').innerHTML;
    assert.equal(articles(html), 25, 'only the first page renders');
    assert.match(html, /id="gtm-findings-severity"/);
    assert.match(
      html,
      locale === 'ar' ? new RegExp(f.context.catalog['Severity']) : /This list shows 51 of 1,051 findings/,
    );
    const list = f.node('#gtm-findings-list'),
      filter = f.node('#gtm-findings-severity');
    f.node('#gtm-findings-next').events.get('click')();
    assert.equal(articles(list.innerHTML), 25);
    assert.match(list.innerHTML, /tags\/26</);
    filter.value = 'unknown';
    filter.events.get('change')();
    assert.equal(articles(list.innerHTML), 1);
    assert.match(
      list.innerHTML,
      locale === 'ar'
        ? new RegExp(f.context.catalog['Referencing paths'])
        : /Referenced by 1,000 entities, including 998 tags\./,
    );
    assert.match(list.innerHTML, /2147479553/);
    filter.value = 'warning';
    filter.events.get('change')();
    assert.equal(articles(list.innerHTML), 20);
    filter.value = '<script>';
    filter.events.get('change')();
    assert.equal(articles(list.innerHTML), 20, 'an unknown filter value is ignored');
    f.context.identityGeneration++;
    filter.value = 'error';
    filter.events.get('change')();
    assert.equal(articles(list.innerHTML), 20, 'a stale view stops repainting');
    assert.equal(f.calls.length, 1);
  });

for (const locale of ['en', 'ar'])
  test(locale + ' MSR-01 published vs draft consent view filters the comparison without a request', async () => {
    const f = accountWorkflowFixture(locale);
    f.respond(() => structuredClone(audit));
    await f.run('renderMeasurement()');
    await f.bindings.get('#measurement-audit')(f.node('#measurement-audit'));
    const root = f.node('#gtm-consent-diff'),
      rows = f.node('#gtm-consent-diff-rows'),
      filter = f.node('#gtm-consent-diff-filter');
    assert.match(
      root.innerHTML,
      new RegExp(locale === 'ar' ? f.context.catalog['Published vs draft consent'] : 'Published vs draft consent'),
    );
    assert.equal((rows.innerHTML.match(/<tr>/g) ?? []).length, 5);
    assert.doesNotMatch(rows.innerHTML, /<img>/);
    filter.value = 'differs';
    filter.events.get('change')();
    assert.equal((rows.innerHTML.match(/<tr>/g) ?? []).length, 2);
    assert.match(rows.innerHTML, /Lead/);
    filter.value = 'live_only';
    filter.events.get('change')();
    assert.match(rows.innerHTML, /ad_user_data/);
    assert.equal(f.calls.length, 1);
  });

test('MSR-01 malformed comparisons and container-only audits never render an unverified diff', async () => {
  const f = accountWorkflowFixture('en');
  const broken = structuredClone(audit);
  broken.configuration.consent_diff.rows[0].state = 'verified';
  f.respond(() => broken);
  await f.run('renderMeasurement()');
  await f.bindings.get('#measurement-audit')(f.node('#measurement-audit'));
  assert.match(f.node('#gtm-consent-diff').innerHTML, /could not be displayed/);
  const container = structuredClone(audit);
  delete container.configuration.consent_diff;
  f.respond(() => container);
  await f.bindings.get('#measurement-audit')(f.node('#measurement-audit'));
  assert.match(f.node('#gtm-consent-diff').innerHTML, /Published version consent settings/);
  container.configuration.live_consent_evidence = {
    scope: 'published_version_configuration',
    version_id: '8',
    status: 'unavailable',
  };
  await f.bindings.get('#measurement-audit')(f.node('#measurement-audit'));
  assert.match(f.node('#gtm-consent-diff').innerHTML, /could not be summarized/);
});
