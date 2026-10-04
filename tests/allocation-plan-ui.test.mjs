import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {Script, createContext} from 'node:vm';
const preview = () => ({
  preview_id: 'original',
  preview_hash: 'hash',
  model_fingerprint: 'model',
  account_id: '123',
  currency: 'USD',
  timezone: 'UTC',
  period_days: 2,
  meaning: 'Preview only',
  targets: [
    {
      name: '<img src=x>',
      campaign_id: '10',
      budget_resource: 'customers/123/campaignBudgets/110',
      current_daily_budget: '200',
      period_budget: '125',
      daily_budget: '62.5',
      daily_budget_micros: '62500000',
      rounding_residual: '0',
    },
  ],
});
function fixture(
  request = async args => (args.action === 'preview_allocation_plan' ? preview() : {id: 'draft/id'}),
  snap = false,
  language = 'en',
) {
  const bindings = new Map(),
    nodes = new Map(),
    calls = [];
  let current = true,
    confirm = async () => true;
  const node = id => {
    if (!nodes.has(id))
      nodes.set(id, {
        value: '',
        innerHTML: '',
        textContent: '',
        events: new Map(),
        addEventListener(k, fn) {
          this.events.set(k, fn);
        },
        focus() {},
      });
    return nodes.get(id);
  };
  const context = createContext({
    document: {addEventListener() {}},
    $: node,
    esc: v => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    workspaceBind: (s, fn) => bindings.set(s, fn),
    workspaceCall: async (tool, args) => {
      calls.push({tool, args});
      return request(args);
    },
    confirmAction: args => confirm(args),
    recordDetails: (data, label) => '<details><summary>' + label + '</summary>' + JSON.stringify(data) + '</details>',
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  if (language === 'ar') {
    context.arabic = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
    new Script('uiLocale="ar";uiMessages=new Map(Object.entries(arabic))').runInContext(context);
  }
  new Script(readFileSync('web/report-quality.js', 'utf8')).runInContext(context);
  new Script(
    readFileSync(path.join(process.env.AMCP_TEST_WEB_ROOT ?? 'web', 'report-allocation.js'), 'utf8'),
  ).runInContext(context);
  context.current = () => current;
  new Script(
    'bindAllocationPlan({id:"source",preset:"' +
      (snap === true ? 'snapchat_adsquad' : snap === 'linkedin' ? 'linkedin_campaign' : 'google_campaign') +
      '"},{budget:"200"},{model_fingerprint:"model"},current)',
  ).runInContext(context);
  return {
    node,
    bindings,
    calls,
    invalidate: () => {
      current = false;
    },
    confirm: fn => {
      confirm = fn;
    },
    preview: () => bindings.get('#allocation-preview-plan')(),
    create: () => bindings.get('#allocation-create-plan')(),
  };
}
test('Snapchat allocation preview identifies ad-squad/parent and confirms the same native request in English and Arabic', async () => {
  for (const language of ['en', 'ar']) {
    const p = {
      ...preview(),
      gateway: 'snapchat_native_action',
      parent_campaign_id: 'parent',
      targets: preview().targets.map(t => ({
        ...t,
        campaign_id: 'parent',
        entity_id: 'squad',
        budget_resource: '/v1/campaigns/parent/adsquads/squad',
      })),
    };
    const f = fixture(async args => (args.action === 'preview_allocation_plan' ? p : {id: 'draft/id'}), true, language);
    f.node('#allocation-conversion').value = 'equal_daily';
    await f.preview();
    const html = f.node('#allocation-plan-result').innerHTML;
    assert.match(html, /squad/);
    assert.match(html, /parent/);
    assert.match(html, language === 'ar' ? /مجموعة إعلانية/ : /Ad squad/);
    f.confirm(async args => {
      assert.match(args.consequence, /Snapchat/);
      assert.doesNotMatch(args.consequence, /Google/);
      return true;
    });
    await f.create();
    assert.equal(f.calls[1].args.action, 'create_allocation_plan');
    assert.equal(f.calls[1].args.preview_id, 'original');
  }
});

test('LinkedIn budget previews retain exact campaign URNs and decimal currency without labelling them native micros', async () => {
  for (const language of ['en', 'ar']) {
    const p = {
      ...preview(),
      gateway: 'linkedin_native_action',
      native_source_references: [{source_hash: 'source'}],
      targets: preview().targets.map(t => ({
        ...t,
        entity_id: 'urn:li:sponsoredCampaign:9007199254740993',
        campaign_id: '9007199254740993',
        parent: {id: '400'},
        daily_budget: '62.500001',
        daily_budget_micros: '62500001',
      })),
    };
    const f = fixture(
      async args => (args.action === 'preview_allocation_plan' ? p : {id: 'draft/id'}),
      'linkedin',
      language,
    );
    f.node('#allocation-conversion').value = 'equal_daily';
    await f.preview();
    const html = f.node('#allocation-plan-result').innerHTML;
    assert.match(html, /9007199254740993/);
    assert.match(html, /62\.500001/);
    assert.match(html, /400/);
    assert.match(html, language === 'ar' ? /المبلغ العشري المرسل للمنصة/ : /Native decimal amount/);
    assert.doesNotMatch(html, /62500001|micros/);
    assert.match(html, /&lt;img src=x>/);
    f.confirm(async args => {
      assert.match(args.consequence, /LinkedIn/);
      assert.doesNotMatch(args.consequence, /Google|Snapchat/);
      return true;
    });
    await f.create();
    assert.equal(f.calls[1].args.preview_id, 'original');
    assert.equal(f.calls[1].args.preview_hash, 'hash');
  }
});

test('a budget preview that expires during confirmation requires a new current read and never saves a draft', async () => {
  const p = {...preview(), expires_at: Date.now() + 600000},
    f = fixture(async () => p, 'linkedin', 'ar');
  f.node('#allocation-conversion').value = 'equal_daily';
  await f.preview();
  f.confirm(async () => {
    p.expires_at = Date.now() - 1;
    return true;
  });
  await f.create();
  assert.equal(f.calls.length, 1);
  assert.match(f.node('#allocation-plan-result').textContent, /انتهت صلاحية معاينة الميزانية/);
});
test('allocation draft UI requires explicit conversion, shows exact native amounts and confirms only a local draft', async () => {
  const f = fixture();
  await f.preview();
  assert.equal(f.calls.length, 0);
  f.node('#allocation-conversion').value = 'equal_daily';
  await f.preview();
  const html = f.node('#allocation-plan-result').innerHTML;
  assert.match(html, /62500000 micros/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
  f.confirm(async () => false);
  await f.create();
  assert.equal(f.calls.length, 1);
  f.confirm(async args => {
    assert.match(args.consequence, /No advertising change/);
    return true;
  });
  await f.create();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1].args)), {
    action: 'create_allocation_plan',
    id: 'source',
    preview_id: 'original',
    preview_hash: 'hash',
    confirmed: true,
  });
  assert.match(f.node('#allocation-plan-result').innerHTML, /\/campaigns\?id=draft%2Fid/);
});
test('allocation conversion changes invalidate the old preview and its pending confirmation', async () => {
  const f = fixture();
  f.node('#allocation-conversion').value = 'equal_daily';
  await f.preview();
  let release;
  f.confirm(
    () =>
      new Promise(r => {
        release = r;
      }),
  );
  const pending = f.create();
  f.node('#allocation-conversion').value = '';
  f.node('#allocation-conversion').events.get('change')?.();
  release(true);
  await pending;
  assert.equal(f.calls.length, 1);
  assert.doesNotMatch(f.node('#allocation-plan-result').innerHTML, /Current budgets/);
});
test('allocation preview and creation responses cannot overwrite a newer route or identity', async () => {
  for (const stage of ['preview_allocation_plan', 'create_allocation_plan']) {
    let release, enter;
    const entered = new Promise(r => {
      enter = r;
    });
    const f = fixture(args =>
      args.action === stage
        ? new Promise(r => {
            release = r;
            enter();
          })
        : Promise.resolve(preview()),
    );
    f.node('#allocation-conversion').value = 'equal_daily';
    let pending = f.preview();
    if (stage === 'create_allocation_plan') {
      await pending;
      pending = f.create();
    }
    await entered;
    f.invalidate();
    f.node('#allocation-plan-result').innerHTML = 'New session';
    release(stage === 'preview_allocation_plan' ? preview() : {id: 'old'});
    await pending;
    assert.equal(f.node('#allocation-plan-result').innerHTML, 'New session');
  }
});
