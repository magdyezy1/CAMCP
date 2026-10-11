// ACC-05 phases 1, 2 and 5 (R25 provider-eligibility-register, R16 conditional-program-registry-coverage): no record
// said which provider approvals the deployment holds, only three gated programs were modelled while others lived as
// prose refusal reasons, and the owner had no view of provider access. The register is data with dated declarations,
// the other gated programs are discovery-only entries that make no request, withheld-write reasons are derived from
// them, and the owner's health view shows the panel from stored state only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createContext, Script} from 'node:vm';
import {
  providerAccessPanel,
  providerAccessRegister,
  registerProblems,
  reviewBy,
  unsafeDeclaredValue,
  validateProviderAccess,
} from '../dist/src/provider-access.js';
import {discoveryOnlyPrograms, withheldWriteProgram} from '../dist/src/discovery-programs.js';
import {withheldWriteProgramId, withheldWriteReason} from '../dist/src/withheld-writes.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {providerContracts} from '../dist/src/provider-contracts.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ownerOperations} from '../dist/src/owner-operations.js';

const committed = JSON.parse(fs.readFileSync('src/provider-access.json', 'utf8'));
const withApproval = (id, patch) => {
  const data = structuredClone(committed);
  Object.assign(data.providers[id].approvals[0], patch);
  return data;
};

test('the committed register validates, names every provider contract, and declares nothing yet', () => {
  assert.deepEqual(registerProblems, []);
  assert.deepEqual(Object.keys(committed.providers).sort(), providerContracts.map(c => String(c.id)).sort());
  // Unknown stays unknown: the owner has not declared an approval yet (owner action R4).
  for (const entry of Object.values(providerAccessRegister.providers))
    for (const a of entry.approvals) assert.deepEqual([a.status, a.value, a.declared_at], ['undeclared', null, null]);
});

test('a declaration carries its date and refuses secrets, account IDs, e-mail and future dates', () => {
  const today = '2026-10-12';
  assert.deepEqual(
    validateProviderAccess(
      withApproval('google', {status: 'approved', value: 'Standard', declared_at: '2026-10-01'}),
      today,
    ),
    [],
  );
  const cases = [
    ['a declaration without a date', {status: 'approved', value: 'Standard'}, /declared_at/],
    ['a future date', {status: 'approved', value: 'Standard', declared_at: '2026-10-13'}, /not in the future/],
    ['a token as value', {status: 'approved', value: 'ya29.' + 'a'.repeat(40), declared_at: '2026-10-01'}, /no token/],
    [
      'an account ID as value',
      {status: 'approved', value: 'customer 1234567890', declared_at: '2026-10-01'},
      /no account/,
    ],
    ['an e-mail as value', {status: 'approved', value: 'owner@example.com', declared_at: '2026-10-01'}, /e-mail/],
    ['an undeclared value', {value: 'Basic'}, /undeclared approval has no value/],
    ['an unknown status', {status: 'granted', declared_at: '2026-10-01'}, /status is/],
    ['an unknown field', {token: 'x'}, /unknown approval field token/],
    ['a multi-line value', {status: 'applied', value: 'a\nb', declared_at: '2026-10-01'}, /one line/],
  ];
  for (const [label, patch, pattern] of cases) {
    const problems = validateProviderAccess(withApproval('meta', patch), today);
    assert.ok(
      problems.some(p => pattern.test(p)),
      label + ': ' + problems.join('; '),
    );
  }
  const missing = structuredClone(committed);
  delete missing.providers.reddit;
  assert.ok(validateProviderAccess(missing).some(p => /reddit: every provider contract has a register entry/.test(p)));
  const extra = structuredClone(committed);
  extra.providers.myspace = committed.providers.reddit;
  assert.ok(validateProviderAccess(extra).some(p => /myspace: no provider contract/.test(p)));
  assert.equal(unsafeDeclaredValue('Standard access'), undefined);
  assert.equal(reviewBy('2026-10-01', 90), '2026-12-30');
  assert.equal(reviewBy(null, 90), null);
});

test('the published register is current and lists every provider with its programs and ledger state', () => {
  const check = spawnSync(process.execPath, ['tools/acceptance/provider-access.mjs', '--check'], {encoding: 'utf8'});
  assert.equal(check.status, 0, check.stderr);
  const doc = fs.readFileSync('docs/PROVIDER-ACCESS.md', 'utf8');
  for (const p of discoveryOnlyPrograms) assert.ok(doc.includes('`' + p.id + '`'), p.id);
  for (const id of ['program:linkedin_forecast', 'program:linkedin_audience_insights', 'program:dv360_advertiser'])
    assert.ok(doc.includes('`' + id + '`'), id);
  assert.match(doc, /\| Write-accepted \(ledger, current contract\) \| 0 \|/);
  assert.doesNotMatch(doc, /undefined|NaN/);
});

test('discovery-only programs make no request: capabilities lists them, program_check refuses them first', async t => {
  const store = new Store(':memory:', Buffer.alloc(32, 31).toString('base64')),
    actor = {tenantId: 'acc05', userId: 'owner', role: 'admin'};
  t.after(() => store.close());
  let requests = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      requests++;
      return Response.json({});
    }),
  );
  store.putConnection(
    actor,
    {
      id: 'li',
      tenantId: actor.tenantId,
      gateway: 'linkedin_native_action',
      accounts: ['5551234'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['r_ads'],
    },
    {accessToken: 'synthetic-token'},
  );
  const graph = await service.call('amcp_workspace', {action: 'capabilities', view: 'graph'}, actor);
  assert.equal(graph.success, true, JSON.stringify(graph.error));
  assert.equal(graph.data.network_requests, 0);
  const listed = graph.data.discovery_only_programs;
  assert.deepEqual(listed.map(p => p.id).sort(), discoveryOnlyPrograms.map(p => p.id).sort());
  for (const p of listed) {
    assert.equal(p.mode, 'discovery_only');
    assert.equal(p.provider_requests, 0);
    assert.equal(p.next_call, null);
    assert.equal(p.entitlement, 'unverified');
    assert.equal(p.withheld_reason, undefined);
    assert.ok(p.prerequisites.length && p.program.reference.startsWith('https://'), p.id);
  }
  // Not workflows: no account is listed and nothing can be checked.
  assert.ok(!graph.data.workflows.some(w => listed.some(p => p.id === w.id)));
  assert.ok(graph.data.workflows.filter(w => w.kind === 'conditional_program').every(w => w.mode === 'live_read'));
  const summary = await service.call('amcp_workspace', {action: 'capabilities'}, actor);
  assert.deepEqual(summary.data.discovery_only_programs.sort(), discoveryOnlyPrograms.map(p => p.id).sort());
  const narrowed = await service.call(
    'amcp_workspace',
    {action: 'capabilities', view: 'graph', gateway: 'x_ads_native_action'},
    actor,
  );
  assert.deepEqual(
    narrowed.data.discovery_only_programs.map(p => p.id),
    ['program:x_ads_api_access'],
  );
  for (const live of [false, true]) {
    const refused = await service.call(
      'amcp_workspace',
      {
        action: 'program_check',
        workflow_id: 'program:linkedin_lead_sync',
        connection_id: 'li',
        account_id: '5551234',
        live,
      },
      actor,
    );
    assert.equal(refused.success, false);
    assert.equal(refused.error.code, 'PROGRAM_CHECK_UNAVAILABLE');
  }
  assert.equal(requests, 0);
  assert.equal(store.documents(actor.tenantId, 'conditional_program_observation').length, 0);
  // Lead Sync never fetches leads: it withholds nothing and names its personal-data boundary.
  const leadSync = discoveryOnlyPrograms.find(p => p.id === 'program:linkedin_lead_sync');
  assert.deepEqual(leadSync.withheld_actions, []);
  assert.match(leadSync.personal_data, /never reads lead responses/);
});

test('withheld-write reasons come from their program entries, and refusals and ledger rows name the program', async t => {
  const rows = actionContracts(new Registry());
  for (const program of discoveryOnlyPrograms)
    for (const action of program.withheld_actions) {
      assert.equal(withheldWriteProgram(program.gateway, action)?.id, program.id);
      assert.equal(withheldWriteProgramId(program.gateway, action), program.id);
      assert.ok(withheldWriteReason(program.gateway, action), action);
      const row = rows.find(r => r.gateway === program.gateway && r.action === action);
      assert.equal(row?.status, 'blocked_write', action);
      assert.equal(row.program_id, program.id, action);
    }
  // One source of truth: the reason text is the program's own.
  const audiences = discoveryOnlyPrograms.find(p => p.id === 'program:linkedin_matched_audiences');
  assert.equal(
    withheldWriteReason('linkedin_native_action', 'linkedin_rest_ad_page_sets_post'),
    audiences.withheld_reason,
  );
  const plans = discoveryOnlyPrograms.find(p => p.id === 'program:linkedin_media_plans');
  assert.equal(withheldWriteReason('linkedin_native_action', 'linkedin_rest_media_plans_post'), plans.withheld_reason);
  // A withheld write that waits on no program names none.
  assert.equal(withheldWriteProgramId('meta_native_action', 'meta_ad_account_id_campaigns_delete'), undefined);
  assert.equal(rows.find(r => r.action === 'meta_ad_account_id_campaigns_delete')?.program_id, undefined);
  // The write refusal names the program.
  const liWrite = '00000000-0000-4000-8000-000000000005';
  const store = new Store(':memory:', Buffer.alloc(32, 32).toString('base64')),
    actor = {tenantId: 'acc05-write', userId: 'owner', role: 'admin'};
  t.after(() => store.close());
  store.putConnection(
    actor,
    {
      id: liWrite,
      tenantId: actor.tenantId,
      gateway: 'linkedin_native_action',
      accounts: ['5551234'],
      writeAccounts: ['5551234'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['rw_ads'],
    },
    {accessToken: 'synthetic-token'},
  );
  let requests = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      requests++;
      return Response.json({});
    }),
    undefined,
    {allowWrites: true},
  );
  const out = await service.call(
    'amcp_write',
    {
      action: 'inspect',
      gateway: 'linkedin_native_action',
      arguments: {action: 'linkedin_rest_media_plans_post', account_id: '5551234', connection_id: liWrite, payload: {}},
    },
    actor,
  );
  const text = JSON.stringify(out);
  assert.match(text, /WRITE_CONTRACT_UNAVAILABLE/);
  assert.match(text, /program:linkedin_media_plans/);
  assert.equal(requests, 0);
});

/** A synthetic workspace: a LinkedIn login with a failed sync, an observation of a program read, and one Meta login. */
function panelFixture(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 33).toString('base64')),
    owner = {tenantId: 'acc05-panel', userId: 'owner-1', role: 'admin'},
    now = Date.parse('2026-10-12T12:00:00Z');
  t.after(() => store.close());
  for (const [id, gateway, account] of [
    ['li', 'linkedin_native_action', '5559991'],
    ['meta', 'meta_native_action', 'act_5558881'],
  ])
    store.putConnection(
      owner,
      {
        id,
        tenantId: owner.tenantId,
        gateway,
        accounts: [account],
        enabled: true,
        label: 'Private login label',
        scopes: [],
      },
      {accessToken: 'synthetic-secret-token'},
    );
  store.putDocument(owner.tenantId, 'website_assets', 'li', {
    groups: [],
    lastSync: now - 86400000,
    lastAttemptAt: now - 3600000,
    error: 'Discovery failed (PROVIDER_ACCESS_DENIED). Prior metadata is retained and must not be treated as fresh.',
  });
  store.putDocument(owner.tenantId, 'website_assets', 'meta', {groups: [], lastSync: now - 7200000, error: null});
  store.putDocument(owner.tenantId, 'conditional_program_observation', 'obs', {
    record_kind: 'conditional_program_observation',
    workflow_id: 'program:linkedin_forecast',
    gateway: 'linkedin_native_action',
    connection_id: 'li',
    account_id: '5559991',
    state: 'blocked',
    code: 'PROVIDER_ACCESS_DENIED',
    http_status: 403,
    provider_code: 'ACCESS_DENIED',
    checked_at: now - 600000,
    expires_at: now + 86400000,
    grant: false,
  });
  return {store, owner, now};
}

test('the owner panel renders from stored synthetic state only, with dated and stale declarations', t => {
  const {store, owner, now} = panelFixture(t);
  const declared = structuredClone(committed);
  Object.assign(declared.providers.linkedin.approvals[0], {
    status: 'approved',
    value: 'Standard',
    declared_at: '2026-06-01',
  });
  Object.assign(declared.providers.meta.approvals[0], {status: 'applied', value: null, declared_at: '2026-10-01'});
  assert.deepEqual(validateProviderAccess(declared, '2026-10-12'), []);
  const panel = providerAccessPanel(store, owner, now, declared);
  assert.equal(panel.network_requests, 0);
  assert.equal(panel.register, 'valid');
  assert.deepEqual(
    panel.providers.map(p => p.id),
    ['meta', 'linkedin'],
  );
  assert.equal(panel.other_providers, providerContracts.length - 2);
  const li = panel.providers.find(p => p.id === 'linkedin'),
    meta = panel.providers.find(p => p.id === 'meta');
  // Declared 2026-06-01 with a 90-day lifetime: stale on 2026-10-12. Declared 2026-10-01: current.
  assert.deepEqual([li.approvals.declared, li.approvals.stale], [1, 1]);
  assert.equal(li.approvals.items[0].stale, true);
  assert.deepEqual([meta.approvals.declared, meta.approvals.stale], [1, 0]);
  assert.equal(li.last_successful_sync_at, now - 86400000);
  assert.deepEqual(li.last_sync_refusal, {code: 'PROVIDER_ACCESS_DENIED', at: now - 3600000});
  assert.equal(meta.last_sync_refusal, null);
  const forecast = li.programs.find(p => p.id === 'program:linkedin_forecast');
  assert.deepEqual(forecast.last_observation, {
    state: 'blocked',
    code: 'PROVIDER_ACCESS_DENIED',
    provider_code: 'ACCESS_DENIED',
    checked_at: now - 600000,
  });
  assert.equal(li.programs.find(p => p.id === 'program:linkedin_audience_insights').last_observation, null);
  assert.equal(li.programs.find(p => p.id === 'program:linkedin_lead_sync').provider_requests, 0);
  assert.deepEqual([li.acceptance.read_accepted, li.acceptance.write_accepted, li.acceptance.rows], [0, 0, 0]);
  // No token, account ID or login label reaches the panel.
  const text = JSON.stringify(panel);
  assert.doesNotMatch(text, /synthetic-secret-token|5559991|5558881|Private login label/);
  // An expired observation is not shown.
  assert.equal(
    providerAccessPanel(store, owner, now + 2 * 86400000, declared).providers.find(p => p.id === 'linkedin').programs[0]
      .last_observation,
    null,
  );
  // An invalid register declares nothing, and says so.
  const invalid = providerAccessPanel(store, owner, now, null);
  assert.equal(invalid.register, 'invalid');
  assert.ok(invalid.providers.every(p => p.approvals.total === 0));
});

test('owner health carries the panel through the workspace tool; ownerOperations alone leaves it null', async t => {
  const {store, owner} = panelFixture(t);
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw Error('no provider request is expected');
    }),
  );
  const health = await service.call('amcp_workspace', {action: 'health'}, owner);
  assert.equal(health.success, true, JSON.stringify(health.error));
  assert.equal(health.data.provider_access.record_kind, 'provider_access_panel');
  assert.deepEqual(health.data.provider_access.providers.map(p => p.id).sort(), ['linkedin', 'meta']);
  assert.equal(ownerOperations(store, {action: 'health'}, owner).provider_access, null);
});

const controller = readFileSync('web/owner-operations.js', 'utf8');
const helper = controller.slice(
  controller.indexOf('function ownerProviderAccess('),
  controller.indexOf('const ownerCall = async'),
);
function render(locale, value) {
  const context = createContext({
    Intl,
    document: {addEventListener() {}},
    renderSettings: () => {},
    esc: text =>
      String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    date: ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' '),
    platformName: gateway => ({linkedin_native_action: 'LinkedIn', meta_native_action: 'Meta'})[gateway] ?? gateway,
    catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  });
  const run = source => new Script(source).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  run(helper);
  context.value = value;
  return run('ownerProviderAccess(value)');
}

test('the Settings panel renders the synthetic panel in English and Arabic without provider calls', t => {
  assert.ok(helper.startsWith('function ownerProviderAccess('), 'the helper is found');
  const {store, owner, now} = panelFixture(t);
  const declared = structuredClone(committed);
  Object.assign(declared.providers.linkedin.approvals[0], {
    status: 'approved',
    value: 'Standard',
    declared_at: '2026-06-01',
  });
  const panel = providerAccessPanel(store, owner, now, declared);
  const en = render('en', panel);
  assert.match(en, /<section class="panel" id="owner-provider-access"><h3>Provider access<\/h3>/);
  assert.match(
    en,
    /<strong>LinkedIn<\/strong> · 1 of 4 approvals declared · <span class="status attention">1 stale<\/span>/,
  );
  assert.match(en, /Last sync refusal: .*<code dir="ltr">PROVIDER_ACCESS_DENIED<\/code>/);
  assert.match(en, /Last observation: Blocked on .*<code dir="ltr">PROVIDER_ACCESS_DENIED ACCESS_DENIED<\/code>/);
  assert.match(en, /LinkedIn Lead Sync<\/strong> · Listed for discovery only; no request/);
  assert.match(en, /<bdi dir="ltr">Standard<\/bdi>/);
  assert.match(en, /Acceptance ledger: 0 read-accepted and 0 write-accepted actions; 0 refused; 0 stale\./);
  const ar = render('ar', panel);
  assert.match(ar, /<h3>صلاحيات المنصات<\/h3>/);
  assert.match(ar, /صُرِّح بـ 1 من 4 من الموافقات/);
  assert.match(ar, /مزامنة العملاء المحتملين في LinkedIn/);
  // Every English label of the panel has its Arabic: no English sentence of the panel is left in the Arabic page.
  for (const english of [
    'Provider access',
    'approvals declared',
    'Last successful sync',
    'Listed for discovery only',
    'Not declared',
  ])
    assert.ok(!ar.includes(english), english);
  assert.equal(render('en', null), '');
  assert.match(render('en', {providers: []}), /Connect a platform to see its access here\./);
  assert.match(render('en', {register: 'invalid', providers: []}), /register is invalid/);
});

const center = readFileSync('web/capability-center.js', 'utf8'),
  discoveryHelper = center.slice(
    center.indexOf('function capabilityDiscoveryOnly('),
    center.indexOf('function capabilityProgramRequirements('),
  );
function renderDiscovery(locale, programs) {
  const context = createContext({
    Intl,
    document: {addEventListener() {}},
    esc: text =>
      String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    capabilityPlatform: gateway => String(gateway).replace(/_native_action$/, ''),
    catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  });
  const run = source => new Script(source).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  run(discoveryHelper);
  context.value = programs;
  return run('capabilityDiscoveryOnly(value)');
}

test('the Capability Center lists the discovery-only programs in English and Arabic, with no check to run', async t => {
  assert.ok(discoveryHelper.startsWith('function capabilityDiscoveryOnly('), 'the helper is found');
  const store = new Store(':memory:', Buffer.alloc(32, 34).toString('base64')),
    actor = {tenantId: 'acc05-center', userId: 'owner', role: 'admin'};
  t.after(() => store.close());
  const graph = await new MirrorService(new Registry(), store, new NativeTransport(async () => Response.json({}))).call(
    'amcp_workspace',
    {action: 'capabilities', view: 'graph'},
    actor,
  );
  const en = renderDiscovery('en', graph.data.discovery_only_programs);
  assert.match(
    en,
    /<section class="panel" id="capability-discovery-only"><h2>Programs that need provider approval<\/h2>/,
  );
  for (const p of discoveryOnlyPrograms) assert.ok(en.includes('data-discovery-program="' + p.id + '"'), p.id);
  assert.doesNotMatch(en, /data-program-check|<form|<button/);
  assert.match(en, /AMCP never reads lead responses through this entry/);
  const ar = renderDiscovery('ar', graph.data.discovery_only_programs);
  assert.match(ar, /<h2>برامج تحتاج إلى موافقة المنصة<\/h2>/);
  // Every program text has Arabic; native names stay literal.
  for (const p of discoveryOnlyPrograms)
    for (const text of [p.name, p.description, p.program.access, ...p.prerequisites.map(x => x.text), ...p.unlocks])
      assert.ok(!ar.includes(text), 'untranslated: ' + text);
  assert.match(ar, /r_marketing_leadgen_automation/);
  assert.equal(renderDiscovery('en', []), '');
  assert.equal(renderDiscovery('en', undefined), '');
});
