import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

async function fixture(request, locale = 'en') {
  const bindings = new Map(),
    events = new Map(),
    nodes = new Map(),
    calls = [];
  const node = key => {
    if (!nodes.has(key))
      nodes.set(key, {
        innerHTML: '',
        isConnected: true,
        attributes: {},
        focus() {
          this.focused = true;
        },
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
      });
    return nodes.get(key);
  };
  node('#portfolio-account').elements = {target: {value: '0', addEventListener: (event, fn) => events.set(event, fn)}};
  const context = createContext({
    navigationGeneration: 1,
    identityGeneration: 1,
    document: {addEventListener() {}},
    content: node('content'),
    $: node,
    platforms: ['meta', 'google', 'linkedin', 'snapchat', 'tiktok', 'x'].map(id => ({
      id,
      gateway: ['google', 'x'].includes(id) ? id + '_ads_native_action' : id + '_native_action',
      connections: [{id: id + '-login', enabled: true, accounts: ['100']}],
    })),
    accountLabel: p => p.id,
    workspaceBind: (selector, fn) => bindings.set(selector, fn),
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('"', '&quot;'),
    pretty: String,
    date: String,
    blank: String,
    recordDetails: JSON.stringify,
    catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
    workspaceCall: async (_tool, args) => {
      calls.push(args);
      return request(args);
    },
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  new Script(
    `uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`,
  ).runInContext(context);
  new Script(readFileSync('web/account-workflows.js', 'utf8')).runInContext(context);
  await new Script('renderPortfolio()').runInContext(context);
  return {
    context,
    nodes,
    node,
    bindings,
    events,
    calls,
    submit: () => bindings.get('#portfolio-account')(node('#portfolio-account')),
  };
}
const page = args => ({
  account_id: args.account_id,
  rows: [
    {
      id: args.requirements.entity === 'campaign' ? '10' : '201',
      name: 'Synthetic',
      status: 'ACTIVE',
      effective_status: 'CAMPAIGN_PAUSED',
      native_money: {daily_budget: '9007199254740993'},
      currency: 'USD',
      timezone: 'UTC',
      native: {id: '10'},
    },
  ],
  has_more: true,
  next_cursor: 'cursor',
  captured_at: 1,
  meaning: 'Native inventory',
});

test('LinkedIn portfolio presents exact shared group and campaign budgets with scoped meaning in English and Arabic', async () => {
  for (const locale of ['en', 'ar']) {
    const data = {
      gateway: 'linkedin_native_action',
      entity: 'campaign',
      account_id: '100',
      currency: 'USD',
      rows: [
        {
          id: '201',
          entity: 'campaign',
          name: 'Native <campaign>',
          status: 'PAUSED',
          native_money: {dailyBudget: {amount: '80.25', currencyCode: 'USD'}},
          budget_context: {
            mode: 'group_dynamic',
            group_id: '9007199254740993',
            group_daily_budget: {amount: '90.000001', currencyCode: 'USD'},
            group_total_budget: {amount: '123456789012345678.90', currencyCode: 'USD'},
          },
        },
      ],
    };
    const f = await fixture(
      async args =>
        args.requirements.entity === 'campaign_group'
          ? {
              ...data,
              entity: 'campaign_group',
              rows: [{id: '9007199254740993', entity: 'campaign_group', name: 'Group'}],
            }
          : data,
      locale,
    );
    f.node('#portfolio-account').elements.target.value = '2';
    await f.submit();
    await f.bindings.get('[data-portfolio-child]')({dataset: {portfolioChild: '0'}});
    const html = f.node('#portfolio-view').innerHTML;
    assert.match(html, /80\.25/);
    assert.match(html, /90\.000001/);
    assert.match(html, /123456789012345678\.90/);
    assert.match(html, /9007199254740993/);
    assert.match(html, locale === 'ar' ? /تحسين مشترك لميزانية مجموعة الحملات/ : /Shared campaign-group optimization/);
    assert.match(
      html,
      locale === 'ar' ? /إعدادات الحملات اليومية/ : /Campaign daily settings are not a separate group spending cap/,
    );
    assert.match(html, /Native &lt;campaign>/);
    assert.doesNotMatch(html, /<campaign>/);
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls.every(c => c.action === 'portfolio' && c.gateway === 'linkedin_native_action'));
    assert.equal(f.calls[1].requirements.entity, 'campaign');
    assert.equal(f.calls[1].requirements.campaign_group_id, '9007199254740993');
  }
});

test('future LinkedIn portfolio budget modes stay unknown and preserve escaped native pacing without a write action', async () => {
  const data = {
      entity: 'campaign',
      rows: [
        {
          id: '201',
          entity: 'campaign',
          name: 'Native',
          native_money: {},
          budget_context: {mode: 'future', campaign_pacing: '<native pacing>'},
        },
      ],
    },
    f = await fixture(async () => data, 'ar');
  f.node('#portfolio-account').elements.target.value = '2';
  await f.submit();
  const html = f.node('#portfolio-view').innerHTML;
  assert.match(html, /نمط الميزانية يحتاج إلى مراجعة لدى المنصة/);
  assert.match(html, /&lt;native pacing>/);
  assert.doesNotMatch(html, /Shared campaign-group optimization|data.*execute/);
  assert.equal(f.calls[0].action, 'portfolio');
});

test('X portfolio navigates native line-item and promoted-post IDs with exact money and independent status in both languages', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = await fixture(
      args => ({
        ...page(args),
        rows: [
          {
            id:
              args.requirements.entity === 'campaign'
                ? 'camp1'
                : args.requirements.entity === 'line_item'
                  ? 'line1'
                  : 'post1',
            name: 'Native',
            status: 'ACTIVE',
            effective_status: 'UNKNOWN',
            servable: false,
            reasons_not_servable: ['PAUSED_BY_ADVERTISER'],
            tweet_id: args.requirements.entity === 'promoted_tweet' ? '880290790664060928' : null,
            approval_status: 'ACCEPTED',
            native_money: {daily_budget_amount_local_micro: '9007199254740993'},
            currency: 'USD',
            timezone: 'America/Los_Angeles',
            native: {},
          },
        ],
      }),
      locale,
    );
    f.node('#portfolio-account').elements.target.value = '5';
    await f.submit();
    const html = f.node('#portfolio-view').innerHTML;
    assert.match(html, /9007199254740993/);
    assert.match(html, /PAUSED_BY_ADVERTISER/);
    assert.doesNotMatch(html, /Meta native integers|TikTok native account-currency/);
    if (locale === 'ar') assert.match(html, /قابلية العرض/);
    await f.bindings.get('[data-portfolio-child]')({dataset: {portfolioChild: '0'}});
    assert.equal(f.calls.at(-1).requirements.entity, 'line_item');
    await f.bindings.get('[data-portfolio-child]')({dataset: {portfolioChild: '0'}});
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1).requirements)), {
      entity: 'promoted_tweet',
      campaign_id: 'camp1',
      line_item_id: 'line1',
    });
    assert.match(f.node('#portfolio-view').innerHTML, /880290790664060928/);
    assert.match(f.node('#portfolio-view').innerHTML, /ACCEPTED/);
    assert.doesNotMatch(f.node('#portfolio-view').innerHTML, /data-portfolio-child/);
    await f.bindings.get('#portfolio-next')();
    assert.equal(f.calls.at(-1).cursor, 'cursor');
    await f.bindings.get('#portfolio-parent')();
    assert.equal(f.calls.at(-1).requirements.entity, 'line_item');
    const count = f.calls.length;
    f.context.identityGeneration++;
    await f.bindings.get('#portfolio-refresh')();
    assert.equal(f.calls.length, count);
    transcripts.push(JSON.stringify(f.calls));
  }
  assert.equal(transcripts[0], transcripts[1]);
});

test('TikTok portfolio preserves native adgroup hierarchy, budget modes and separate operation/secondary statuses in both languages', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = await fixture(
      args => ({
        ...page(args),
        rows: [
          {
            id:
              args.requirements.entity === 'campaign'
                ? '9007199254740993'
                : args.requirements.entity === 'adgroup'
                  ? '9007199254740995'
                  : '9007199254740997',
            name: 'Native',
            status: 'ENABLE',
            secondary_status: 'CAMPAIGN_STATUS_BUDGET_EXCEED',
            budget_mode: 'BUDGET_MODE_DAY',
            native_money: {budget: '30.50', scheduled_budget: 35},
            currency: 'USD',
            timezone: 'Etc/GMT',
            native: {},
          },
        ],
      }),
      locale,
    );
    f.node('#portfolio-account').elements.target.value = '4';
    await f.submit();
    assert.match(f.node('#portfolio-view').innerHTML, /TikTok/);
    assert.match(f.node('#portfolio-view').innerHTML, /30.50/);
    assert.match(f.node('#portfolio-view').innerHTML, /BUDGET_MODE_DAY/);
    assert.match(f.node('#portfolio-view').innerHTML, /CAMPAIGN_STATUS_BUDGET_EXCEED/);
    assert.doesNotMatch(f.node('#portfolio-view').innerHTML, /Meta native integers|Snapchat native micros/);
    if (locale === 'ar') assert.match(f.node('#portfolio-view').innerHTML, /الحالة الثانوية/);
    await f.bindings.get('[data-portfolio-child]')({dataset: {portfolioChild: '0'}});
    assert.equal(f.calls.at(-1).requirements.entity, 'adgroup');
    await f.bindings.get('[data-portfolio-child]')({dataset: {portfolioChild: '0'}});
    assert.equal(f.calls.at(-1).requirements.adgroup_id, '9007199254740995');
    assert.equal(f.calls.at(-1).requirements.campaign_id, '9007199254740993');
    await f.bindings.get('#portfolio-next')();
    assert.equal(f.calls.at(-1).cursor, 'cursor');
    await f.bindings.get('#portfolio-parent')();
    assert.equal(f.calls.at(-1).requirements.entity, 'adgroup');
    const count = f.calls.length;
    f.context.identityGeneration++;
    await f.bindings.get('#portfolio-refresh')();
    assert.equal(f.calls.length, count);
    transcripts.push(JSON.stringify(f.calls));
  }
  assert.equal(transcripts[0], transcripts[1]);
});

test('Snapchat portfolio preserves ad-squad hierarchy, native micros and separate review/delivery statuses in both languages', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = await fixture(
      async args => ({
        ...page(args),
        rows: [
          {
            id:
              args.requirements.entity === 'campaign'
                ? 'campaign-id'
                : args.requirements.entity === 'adsquad'
                  ? 'squad-id'
                  : 'ad-id',
            name: 'Snap entity',
            status: 'ACTIVE',
            review_status: 'PENDING',
            delivery_status: ['INVALID_NOT_ACTIVE'],
            native_money: {daily_budget_micro: '9007199254740993'},
            currency: 'SAR',
            timezone: 'Asia/Riyadh',
            native: {status: 'ACTIVE'},
          },
        ],
      }),
      locale,
    );
    f.node('#portfolio-account').elements.target.value = '3';
    await f.submit();
    assert.match(f.node('#portfolio-view').innerHTML, /Snapchat/);
    assert.match(f.node('#portfolio-view').innerHTML, /9007199254740993/);
    if (locale === 'ar') assert.match(f.node('#portfolio-view').innerHTML, /فرق الإعلانات/);
    await f.bindings.get('[data-portfolio-child]')({dataset: {portfolioChild: '0'}});
    await f.bindings.get('[data-portfolio-child]')({dataset: {portfolioChild: '0'}});
    const html = f.node('#portfolio-view').innerHTML;
    assert.match(html, /PENDING/);
    assert.match(html, /INVALID_NOT_ACTIVE/);
    await f.bindings.get('#portfolio-next')();
    await f.bindings.get('#portfolio-parent')();
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls.map(c => c.requirements))), [
      {entity: 'campaign'},
      {entity: 'adsquad', campaign_id: 'campaign-id'},
      {entity: 'ad', campaign_id: 'campaign-id', ad_squad_id: 'squad-id'},
      {entity: 'ad', campaign_id: 'campaign-id', ad_squad_id: 'squad-id'},
      {entity: 'adsquad', campaign_id: 'campaign-id'},
    ]);
    assert.ok(f.calls.every(c => c.gateway === 'snapchat_native_action' && c.limit === 50));
    transcripts.push(JSON.parse(JSON.stringify(f.calls)));
  }
  assert.deepEqual(transcripts[0], transcripts[1]);
});

test('departed Snapchat inventory controls cannot issue fresh reads or navigate their stale hierarchy', async () => {
  const f = await fixture(async args => page(args));
  f.node('#portfolio-account').elements.target.value = '3';
  await f.submit();
  const oldChild = f.bindings.get('[data-portfolio-child]'),
    oldNext = f.bindings.get('#portfolio-next');
  f.context.identityGeneration++;
  await oldChild({dataset: {portfolioChild: '0'}});
  await oldNext();
  await f.submit();
  assert.equal(f.calls.length, 1);
});

test('portfolio navigation keeps native Meta hierarchy, money, effective state and cursor in the chosen account', async () => {
  const f = await fixture(async args => page(args));
  await f.submit();
  assert.match(f.node('#portfolio-view').innerHTML, /9007199254740993/);
  assert.match(f.node('#portfolio-view').innerHTML, /Effective: CAMPAIGN_PAUSED/);
  assert.doesNotMatch(f.node('#portfolio-view').innerHTML, /undefined budget micros/);
  assert.equal(f.node('#portfolio-heading').focused, true);
  await f.bindings.get('[data-portfolio-child]')({dataset: {portfolioChild: '0'}});
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1).requirements)), {entity: 'adset', campaign_id: '10'});
  await f.bindings.get('[data-portfolio-child]')({dataset: {portfolioChild: '0'}});
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1).requirements)), {
    entity: 'ad',
    campaign_id: '10',
    adset_id: '201',
  });
  await f.bindings.get('#portfolio-next')();
  assert.equal(f.calls.at(-1).cursor, 'cursor');
  await f.bindings.get('#portfolio-refresh')();
  assert.equal(f.calls.at(-1).cursor, undefined);
  assert.ok(f.calls.every(c => c.connection_id === 'meta-login' && c.account_id === '100'));
});

test('portfolio results and errors cannot repaint a newer selection, route, identity or detached view', async () => {
  for (const change of ['selection', 'navigationGeneration', 'identityGeneration', 'detach']) {
    for (const reject of [false, true]) {
      let finish;
      const f = await fixture(
        args =>
          new Promise((resolve, fail) => {
            finish = () => (reject ? fail(Error('Old failure')) : resolve(page(args)));
          }),
      );
      const pending = f.submit();
      if (change === 'selection') f.events.get('change')();
      else if (change === 'detach') f.node('#portfolio-view').isConnected = false;
      else f.context[change]++;
      f.node('#portfolio-view').innerHTML = 'Current page';
      finish();
      await pending;
      assert.equal(f.node('#portfolio-view').innerHTML, 'Current page');
      assert.equal(f.bindings.has('#portfolio-next'), false);
    }
  }
});

test('Google portfolio keeps ad_group and ad_group_id while a newer read supersedes an older read', async () => {
  let old;
  const f = await fixture(args =>
    f.calls.length === 1
      ? new Promise(resolve => {
          old = () => resolve(page(args));
        })
      : Promise.resolve(page(args)),
  );
  const stale = f.submit();
  f.node('#portfolio-account').elements.target.value = '1';
  f.events.get('change')();
  await f.submit();
  old();
  await stale;
  assert.match(f.node('#portfolio-view').innerHTML, /Google Ads/);
  await f.bindings.get('[data-portfolio-child]')({dataset: {portfolioChild: '0'}});
  assert.equal(f.calls.at(-1).requirements.entity, 'ad_group');
  await f.bindings.get('[data-portfolio-child]')({dataset: {portfolioChild: '0'}});
  assert.equal(f.calls.at(-1).requirements.ad_group_id, '201');
  assert.equal(f.calls.at(-1).requirements.adset_id, undefined);
});

test('LinkedIn portfolio follows groups, campaigns and creatives with exact money and independent serving evidence in English and Arabic', async () => {
  for (const locale of ['en', 'ar']) {
    const f = await fixture(
      async args => ({
        ...page(args),
        rows: [
          {
            id:
              args.requirements.entity === 'campaign_group'
                ? '10'
                : args.requirements.entity === 'campaign'
                  ? '201'
                  : '301',
            name: 'Synthetic',
            status: 'ACTIVE',
            currency: 'USD',
            timezone: null,
            native_money: {totalBudget: {amount: '123456789012345678.90', currencyCode: 'USD'}},
            is_serving: false,
            serving_hold_reasons: ['CAMPAIGN_STOPPED'],
            native: {id: '301'},
          },
        ],
      }),
      locale,
    );
    f.node('#portfolio-account').elements.target.value = '2';
    await f.submit();
    assert.equal(f.calls.at(-1).requirements.entity, 'campaign_group');
    assert.match(f.node('#portfolio-view').innerHTML, /123456789012345678\.90 USD/);
    assert.doesNotMatch(f.node('#portfolio-view').innerHTML, /\[object Object\]|Meta native integers/);
    await f.bindings.get('[data-portfolio-child]')({dataset: {portfolioChild: '0'}});
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1).requirements)), {
      entity: 'campaign',
      campaign_group_id: '10',
    });
    await f.bindings.get('[data-portfolio-child]')({dataset: {portfolioChild: '0'}});
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1).requirements)), {
      entity: 'creative',
      campaign_group_id: '10',
      campaign_id: '201',
    });
    assert.match(f.node('#portfolio-view').innerHTML, /CAMPAIGN_STOPPED/);
    assert.match(f.node('#portfolio-view').innerHTML, locale === 'ar' ? /العرض الفعلي: لا/ : /Observed serving: No/);
    assert.match(f.node('#portfolio-view').innerHTML, locale === 'ar' ? /الحالة المقصودة/ : /Intended status/);
    assert.doesNotMatch(f.node('#portfolio-view').innerHTML, /data-portfolio-child=/);
    await f.bindings.get('#portfolio-next')();
    assert.equal(f.calls.at(-1).cursor, 'cursor');
    await f.bindings.get('#portfolio-parent')();
    assert.equal(f.calls.at(-1).requirements.entity, 'campaign');
    assert.equal(f.calls.at(-1).requirements.campaign_group_id, '10');
    await f.bindings.get('#portfolio-root')();
    assert.equal(f.calls.at(-1).requirements.entity, 'campaign_group');
    assert.ok(f.calls.every(c => c.gateway === 'linkedin_native_action' && c.connection_id === 'linkedin-login'));
  }
});

test('detached or obsolete portfolio controls never initiate new provider reads', async () => {
  for (const reason of ['navigationGeneration', 'identityGeneration', 'detach']) {
    const f = await fixture(async args => page(args));
    await f.submit();
    const n = f.calls.length;
    if (reason === 'detach') f.node('#portfolio-view').isConnected = false;
    else f.context[reason]++;
    for (const selector of ['#portfolio-next', '#portfolio-refresh', '#portfolio-root'])
      await f.bindings.get(selector)();
    await f.submit();
    assert.equal(f.calls.length, n, reason);
  }
});
