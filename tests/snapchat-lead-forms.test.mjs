import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {WriteVerifier} from '../dist/src/write-verification.js';

/**
 * Snapchat lead generation forms (official Lead Generation Ads guide, checked 2026-09-26): create only, since no
 * update/delete is documented. Lead reports and webhooks carry submitted personal data and stay unqualified.
 */
const SNAP = '33333333-3333-4333-8333-333333333333',
  gateway = 'snapchat_native_action',
  account = 'acct1';
const actor = {tenantId: 'snap-leads', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 61).toString('base64');
const form = (extra = {}) => ({
  name: 'Residences enquiry',
  description: 'Tell us how to reach you.',
  title: 'Book a viewing',
  privacy_policy_url: 'https://example.test/privacy',
  form_fields: [
    {type: 'FIRST_NAME'},
    {type: 'LAST_NAME'},
    {type: 'EMAIL'},
    {
      type: 'CUSTOM',
      custom_form_field_properties: {
        type: 'MULTIPLE_CHOICE_SINGLE_SELECTION',
        description: 'When are you buying?',
        multiple_choice_options: [
          {choice_description: 'This year', option_preferred_status: 'PREFERRED'},
          {choice_description: 'Later', option_preferred_status: 'NOT_PREFERRED'},
        ],
      },
    },
  ],
  legal_disclosures: {
    title: 'Terms',
    description: 'We contact you about this project.',
    consent_form_fields: [{consent_description: 'I agree to be contacted', required: true}],
  },
  banner_media_id: 'banner1',
  end_page_properties: {call_to_action: 'LEARN_MORE', url: 'https://example.test/residences'},
  ...extra,
});
function fixture({readTitle} = {}) {
  const store = new Store(':memory:', key),
    connection = {
      id: SNAP,
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic Snap',
      scopes: [],
    };
  store.putConnection(admin, connection, {accessToken: 'synthetic'});
  const forms = new Map(),
    creatives = new Map(),
    requests = [],
    writes = [];
  let n = 0,
    mode = '';
  const ok = (kind, rows) =>
    Response.json({
      request_status: 'SUCCESS',
      request_id: 'r' + ++n,
      paging: {},
      [kind]: rows.map(r => ({sub_request_status: 'SUCCESS', [kind === 'media' ? 'media' : kind.slice(0, -1)]: r})),
    });
  const transport = new NativeTransport(async (raw, init = {}) => {
    const path = new URL(String(raw)).pathname,
      method = init.method ?? 'GET';
    requests.push(method + ' ' + path);
    let m;
    if (method === 'GET' && path === '/v1/adaccounts/acct1')
      return ok('adaccounts', [{id: account, currency: 'USD', timezone: 'Asia/Riyadh'}]);
    if (method === 'GET' && path === '/v1/adaccounts/acct1/media')
      return ok('media', [{id: 'banner1', ad_account_id: account, type: 'IMAGE', media_status: 'READY'}]);
    if (method === 'GET' && path === '/v1/media/banner1')
      return ok('media', [{id: 'banner1', ad_account_id: account, type: 'IMAGE', media_status: 'READY'}]);
    if (method === 'POST' && path === '/v1/adaccounts/acct1/lead_generation_forms') {
      writes.push(path);
      const out = JSON.parse(init.body).lead_generation_forms.map(f => {
        const row = {...f, id: 'form' + (forms.size + 1), ad_account_id: account, strategy_type: 'MORE_VOLUME'};
        forms.set(row.id, row);
        return {
          sub_request_status: mode === 'write_error' ? 'ERROR' : 'SUCCESS',
          lead_generation_form: {...row, form_fields: row.form_fields.map(x => ({...x, is_required: true}))},
        };
      });
      if (mode === 'lost') throw new Error('Synthetic accepted response lost');
      return Response.json({
        request_status: 'SUCCESS',
        request_id: 'r' + ++n,
        paging: {},
        lead_generation_forms: mode === 'empty_receipt' ? [] : mode === 'duplicate_receipt' ? [...out, ...out] : out,
      });
    }
    if (method === 'GET' && path === '/v1/adaccounts/acct1/lead_generation_forms')
      return ok('lead_generation_forms', [...forms.values()]);
    if (method === 'GET' && (m = /^\/v1\/lead_generation_forms\/([^/]+)$/.exec(path))) {
      const f = forms.get(m[1]);
      return f
        ? ok('lead_generation_forms', [{...f, ...(readTitle ? {title: readTitle} : {})}])
        : Response.json({request_status: 'ERROR'}, {status: 404});
    }
    if (method === 'POST' && path === '/v1/adaccounts/acct1/creatives') {
      writes.push(path);
      return ok(
        'creatives',
        JSON.parse(init.body).creatives.map(c => {
          const row = {...c, id: 'creative' + (creatives.size + 1), ad_account_id: account};
          creatives.set(row.id, row);
          return row;
        }),
      );
    }
    if (method === 'GET' && (m = /^\/v1\/creatives\/([^/]+)$/.exec(path)))
      return ok('creatives', [creatives.get(m[1])]);
    throw new Error('Unexpected Snapchat request ' + method + ' ' + path);
  });
  const start = () =>
    new MirrorService(new Registry(), store, transport, undefined, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    });
  let service = start();
  const call = (tool, input) => service.call(tool, input, actor);
  const prepare = (action, payload) =>
    call('amcp_write', {
      action: 'prepare',
      gateway,
      connection_id: SNAP,
      arguments: {action, account_id: account, payload},
    });
  const execute = id => call('amcp_write', {action: 'execute', review_id: id, idempotency_key: id, confirmed: true});
  const knowBanner = () => call(gateway, {action: 'snapchat_media_list', connection_id: SNAP, account_id: account});
  const verify = id => call('amcp_campaign', {action: 'verify', review_id: id});
  // Restart keeps only what the store persisted: claims, receipts and observed ownership.
  return {
    store,
    get service() {
      return service;
    },
    transport,
    requests,
    writes,
    call,
    prepare,
    execute,
    verify,
    knowBanner,
    mode: v => {
      mode = v;
    },
    restart: () => {
      service = start();
    },
  };
}

test('lead form creation joins the reviewed Snapchat family; lead reports and webhooks stay blocked', async () => {
  const f = fixture();
  try {
    for (const action of [
      'snapchat_lead_form_create',
      'snapchat_lead_generation_form_create',
      'snapchat_adaccounts_ad_account_id_lead_generation_forms_create',
    ]) {
      const inspected = await f.call('amcp_write', {
        action: 'inspect',
        gateway,
        connection_id: SNAP,
        arguments: {action, account_id: account, payload: {lead_generation_forms: [form()]}},
      });
      assert.equal(inspected.data.review_contract_supported, true, action + ' ' + JSON.stringify(inspected));
    }
    const contracts = (await f.call('amcp_workspace', {action: 'contracts', gateway, search: 'lead', limit: 100})).data
      .actions;
    const status = Object.fromEntries(contracts.map(r => [r.action, r.status]));
    assert.equal(status.snapchat_lead_form_create, 'reviewed_write_family');
    assert.equal(status.snapchat_lead_webhook_create, 'blocked_write');
    assert.equal(status.snapchat_leads_report_create, 'unqualified_read');
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('documented form requirements are enforced before any provider request', async () => {
  const f = fixture();
  try {
    const without = type => form({form_fields: form().form_fields.filter(x => x.type !== type)});
    const custom = props =>
      form({form_fields: [...form().form_fields.slice(0, 3), {type: 'CUSTOM', custom_form_field_properties: props}]});
    const cases = {
      'no first name': without('FIRST_NAME'),
      'no last name': without('LAST_NAME'),
      'no email or phone': without('EMAIL'),
      'address and postal code': form({form_fields: [...form().form_fields, {type: 'ADDRESS'}, {type: 'POSTAL_CODE'}]}),
      'title over 25': form({title: 'x'.repeat(26)}),
      'description over 180': form({description: 'x'.repeat(181)}),
      'missing name': form({name: ''}),
      'legal title over 35': form({legal_disclosures: {title: 'x'.repeat(36), description: 'ok'}}),
      'legal description over 80': form({legal_disclosures: {title: 'Terms', description: 'x'.repeat(81)}}),
      'three consents': form({
        legal_disclosures: {
          title: 'Terms',
          description: 'ok',
          consent_form_fields: [1, 2, 3].map(i => ({consent_description: 'Consent ' + i, required: true})),
        },
      }),
      'non-boolean consent': form({
        legal_disclosures: {
          title: 'Terms',
          description: 'ok',
          consent_form_fields: [{consent_description: 'Agree', required: 'yes'}],
        },
      }),
      'undocumented key': form({is_required: false}),
      'undocumented field key': form({
        form_fields: [{type: 'FIRST_NAME', is_required: false}, ...form().form_fields.slice(1)],
      }),
      'unknown field type': form({form_fields: [...form().form_fields, {type: 'NATIONAL_ID'}]}),
      'custom without properties': form({form_fields: [...form().form_fields.slice(0, 3), {type: 'CUSTOM'}]}),
      'multiple choice without options': custom({type: 'MULTIPLE_CHOICE_MULTI_SELECTION', description: 'Pick'}),
      'text with options': custom({
        type: 'TEXT',
        description: 'Why?',
        multiple_choice_options: [{choice_description: 'A'}],
      }),
      'preferred on multi select': custom({
        type: 'MULTIPLE_CHOICE_MULTI_SELECTION',
        description: 'Pick',
        multiple_choice_options: [
          {choice_description: 'A', option_preferred_status: 'PREFERRED'},
          {choice_description: 'B', option_preferred_status: 'NOT_PREFERRED'},
        ],
      }),
      'preferred without a not-preferred option': custom({
        type: 'MULTIPLE_CHOICE_SINGLE_SELECTION',
        description: 'Pick',
        multiple_choice_options: [
          {choice_description: 'A', option_preferred_status: 'PREFERRED'},
          {choice_description: 'B'},
        ],
      }),
      'two preferred questions': form({form_fields: [...form().form_fields, form().form_fields[3]]}),
      'end page call to action': form({end_page_properties: {call_to_action: 'SHOP_NOW', url: 'https://example.test'}}),
      'end page without url': form({end_page_properties: {call_to_action: 'LEARN_MORE'}}),
      'privacy policy not a web URL': form({privacy_policy_url: 'javascript:alert(1)'}),
      'another ad account': form({ad_account_id: 'acct2'}),
    };
    for (const [name, payload] of Object.entries(cases)) {
      const r = await f.prepare('snapchat_lead_form_create', {lead_generation_forms: [payload]});
      assert.equal(
        r.error?.code,
        'INVALID_SNAPCHAT_LEAD_FORM',
        name + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 300),
      );
    }
    assert.equal(f.requests.length, 0, 'validation happens before any read or write');
  } finally {
    f.store.close();
  }
});

test('a lead form review reads the account and its owned banner, executes once and verifies despite provider-added fields', async () => {
  const f = fixture();
  try {
    assert.equal((await f.knowBanner()).success, true);
    const p = await f.prepare('snapchat_lead_form_create', {lead_generation_forms: [form()]});
    assert.equal(p.success, true, JSON.stringify(p));
    assert.deepEqual(p.data.state_reads, [
      {method: 'GET', path: '/v1/adaccounts/acct1'},
      {method: 'GET', path: '/v1/media/banner1'},
    ]);
    const done = await f.execute(p.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done));
    assert.equal(done.data.data.lead_generation_forms[0].lead_generation_form.id, 'form1');
    const verified = await new WriteVerifier(f.store, new Registry(), f.transport, f.service.credentials).verify(
      actor,
      p.data.review_id,
    );
    assert.equal(verified.status, 'verified', JSON.stringify(verified));
    assert.ok(verified.checks[0].checked_fields.includes('form_fields'));
    assert.equal((await f.execute(p.data.review_id)).data.replayed, true);
    assert.deepEqual(f.writes, ['/v1/adaccounts/acct1/lead_generation_forms']);
    const read = await f.call(gateway, {
      action: 'snapchat_lead_form_get',
      connection_id: SNAP,
      account_id: account,
      path_params: {lead_generation_form_id: 'form1'},
    });
    assert.equal(read.success, true, JSON.stringify(read));
    assert.equal(read.data.data.lead_generation_forms[0].lead_generation_form.title, 'Book a viewing');
  } finally {
    f.store.close();
  }
});

test('a banner or lead form this login does not own blocks preparation', async () => {
  const f = fixture();
  try {
    const banner = await f.prepare('snapchat_lead_form_create', {lead_generation_forms: [form()]});
    assert.equal(banner.error.code, 'RESOURCE_SCOPE_REQUIRED');
    assert.equal(banner.error.details.path, '/v1/media/banner1');
    const creative = await f.prepare('snapchat_creative_create', {
      creatives: [
        {
          ad_account_id: account,
          name: 'Lead creative',
          type: 'LEAD_GENERATION',
          headline: 'Book a viewing',
          brand_name: 'Synthetic',
          shareable: true,
          call_to_action: 'SIGN_UP',
          top_snap_media_id: 'banner1',
          profile_properties: {profile_id: 'profile1'},
          lead_generation_form_id: 'foreign-form',
        },
      ],
    });
    assert.equal(creative.error.code, 'RESOURCE_SCOPE_REQUIRED');
    assert.equal(creative.error.details.path, '/v1/lead_generation_forms/foreign-form');
    assert.equal(f.writes.length, 0);
    const malformed = await f.prepare('snapchat_creative_create', {
      creatives: [
        {
          ad_account_id: account,
          name: 'Lead creative',
          type: 'LEAD_GENERATION',
          headline: 'Book a viewing',
          brand_name: 'Synthetic',
          shareable: true,
          call_to_action: 'SIGN_UP',
          top_snap_media_id: 'banner1',
          profile_properties: {profile_id: 'profile1'},
          lead_generation_form_id: '../media/banner1',
        },
      ],
    });
    assert.equal(
      malformed.error.code,
      'INVALID_SNAPCHAT_LEAD_FORM',
      'a form ID that cannot be read must not skip the ownership read',
    );
    assert.equal(malformed.error.details.field, 'lead_generation_form_id');
    const noBanner = await f.prepare('snapchat_lead_form_create', {
      lead_generation_forms: [form({banner_media_id: undefined})],
    });
    assert.equal(noBanner.success, true, JSON.stringify(noBanner));
    assert.deepEqual(noBanner.data.state_reads, [{method: 'GET', path: '/v1/adaccounts/acct1'}]);
  } finally {
    f.store.close();
  }
});

test('a LEAD_GENERATION creative reads its owned form before review and execution', async () => {
  const f = fixture();
  try {
    await f.knowBanner();
    const p = await f.prepare('snapchat_lead_form_create', {lead_generation_forms: [form()]});
    await f.execute(p.data.review_id);
    const creative = await f.prepare('snapchat_creative_create', {
      creatives: [
        {
          ad_account_id: account,
          name: 'Lead creative',
          type: 'LEAD_GENERATION',
          headline: 'Book a viewing',
          brand_name: 'Synthetic',
          shareable: true,
          call_to_action: 'SIGN_UP',
          top_snap_media_id: 'banner1',
          profile_properties: {profile_id: 'profile1'},
          lead_generation_form_id: 'form1',
        },
      ],
    });
    assert.equal(creative.success, true, JSON.stringify(creative));
    assert.deepEqual(creative.data.state_reads, [
      {method: 'GET', path: '/v1/adaccounts/acct1'},
      {method: 'GET', path: '/v1/lead_generation_forms/form1'},
    ]);
    const done = await f.execute(creative.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done));
    assert.equal(
      f.requests.filter(r => r === 'GET /v1/lead_generation_forms/form1').length,
      2,
      'read at preparation and again before execution',
    );
  } finally {
    f.store.close();
  }
});

test('a lead form that reads back differently stays inconclusive', async () => {
  const f = fixture({readTitle: 'Edited elsewhere'});
  try {
    await f.knowBanner();
    const p = await f.prepare('snapchat_lead_form_create', {lead_generation_forms: [form()]});
    await f.execute(p.data.review_id);
    const verified = await new WriteVerifier(f.store, new Registry(), f.transport, f.service.credentials).verify(
      actor,
      p.data.review_id,
    );
    assert.equal(verified.status, 'inconclusive');
    assert.deepEqual(verified.checks[0].changed_fields, ['/title']);
  } finally {
    f.store.close();
  }
});

test('failed, partial or lost lead form receipts never submit a second form', async () => {
  for (const mode of ['write_error', 'empty_receipt', 'duplicate_receipt', 'lost']) {
    const f = fixture();
    try {
      await f.knowBanner();
      const p = await f.prepare('snapchat_lead_form_create', {lead_generation_forms: [form()]});
      assert.equal(p.success, true, mode);
      const code = mode === 'lost' ? 'WRITE_OUTCOME_UNCERTAIN' : 'WRITE_PARTIAL_OR_FAILED';
      f.mode(mode);
      assert.equal((await f.execute(p.data.review_id)).error?.code, code, mode);
      f.mode('');
      assert.equal((await f.execute(p.data.review_id)).error?.code, code, mode);
      assert.equal(f.writes.length, 1, mode);
      assert.notEqual((await f.verify(p.data.review_id)).data?.status, 'verified', mode);
    } finally {
      f.store.close();
    }
  }
});

test('lead form claims survive concurrent execution and restart; a lost receipt stays uncertain', async () => {
  const f = fixture();
  try {
    await f.knowBanner();
    const p = await f.prepare('snapchat_lead_form_create', {lead_generation_forms: [form()]});
    const results = await Promise.all([f.execute(p.data.review_id), f.execute(p.data.review_id)]);
    assert.ok(results.some(r => r.success));
    assert.equal(f.writes.length, 1);
    f.restart();
    assert.equal((await f.execute(p.data.review_id)).data.replayed, true);
    const verified = await f.verify(p.data.review_id);
    assert.equal(verified.data.status, 'verified', JSON.stringify(verified));
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    await g.knowBanner();
    const p = await g.prepare('snapchat_lead_form_create', {lead_generation_forms: [form()]});
    g.mode('lost');
    assert.equal((await g.execute(p.data.review_id)).success, false);
    g.mode('');
    g.restart();
    assert.equal((await g.execute(p.data.review_id)).error.code, 'WRITE_OUTCOME_UNCERTAIN');
    assert.equal(g.writes.length, 1);
  } finally {
    g.store.close();
  }
});
