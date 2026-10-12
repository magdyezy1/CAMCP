// PRV-07 A: the Live portfolio page reads one Google Ads account's change history on submit and shows a bilingual
// timeline. A window Google cannot answer is refused before any request; a response for another account, another
// window or with a field the read never selects (such as who made a change) is refused rather than shown.
import test from 'node:test';
import assert from 'node:assert/strict';
import {accountWorkflowFixture as fixture} from './fixtures/account-workflows-ui.mjs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

const isoDay = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const from = isoDay(-6),
  to = isoDay(0);
const row = (id, extra = {}) => ({
  change_date_time: from + ' 10:00:0' + (id % 10),
  resource_type: 'CAMPAIGN',
  operation: 'UPDATE',
  client_type: 'GOOGLE_ADS_WEB_CLIENT',
  resource_name: 'customers/001/campaigns/77',
  changed_fields: ['status', 'campaign_budget'],
  campaign: 'customers/001/campaigns/77',
  ad_group: null,
  asset: null,
  change_event: 'customers/001/changeEvents/' + id,
  ...extra,
});
function history(rows, overrides = {}) {
  const byDay = {};
  for (const r of rows) byDay[r.change_date_time.slice(0, 10)] = (byDay[r.change_date_time.slice(0, 10)] ?? 0) + 1;
  return {
    record_kind: 'change_history',
    scope: {
      gateway: 'google_ads_native_action',
      connection_id: 'google-login',
      account_id: '001',
      date_from: from,
      date_to: to,
      limit: 1000,
      resource_types: null,
    },
    requested_at: 1,
    captured_at: 2,
    timezone: 'account',
    complete: rows.length < 1000,
    limit_reached: rows.length === 1000,
    row_count: rows.length,
    rows,
    timeline: {by_day: byDay, by_resource_type: {}, by_operation: {}, by_client_type: {}},
    personal_data: {user_email: 'not_requested'},
    source_references: [],
    provider_mutations: 0,
    retained_snapshot: false,
    meaning:
      'Google Ads change events of the selected customer in the requested account-local dates, newest first. Who made a change is personal data and was not requested; client_type names the tool used. Changed field paths name what changed, not its old or new value. limit_reached means older changes in the window may exist. Change history explains configuration changes; it does not prove their effect on performance. Nothing was saved or changed.',
    ...overrides,
  };
}
async function page(locale, respond, dates = {date_from: from, date_to: to}) {
  const f = fixture(locale);
  f.respond(respond);
  await f.run('renderPortfolio()');
  const form = f.node('#change-history');
  form.elements.target.value = '0';
  form.elements.date_from.value = dates.date_from;
  form.elements.date_to.value = dates.date_to;
  return {f, form, submit: () => f.bindings.get('#change-history')(form)};
}

for (const locale of ['en', 'ar'])
  test(
    locale + ' change history sends one bounded read and shows a translated timeline with native values',
    async () => {
      const rows = [
        row(2, {
          change_date_time: to + ' 08:30:00',
          resource_type: 'AD_GROUP_AD',
          operation: 'CREATE',
          client_type: 'GOOGLE_ADS_API',
          resource_name: 'customers/001/adGroupAds/5~6',
          changed_fields: [],
          campaign: null,
          ad_group: 'customers/001/adGroups/5',
        }),
        row(1),
        row(3, {operation: null, client_type: null}),
      ];
      const {f, submit} = await page(locale, () => history(rows));
      const markup = f.node('content').innerHTML;
      assert.match(markup, locale === 'ar' ? /سجل تغييرات Google Ads/ : /Google Ads change history/);
      assert.match(markup, /name="date_from" type="date" required min="\d{4}-\d{2}-\d{2}" max="\d{4}-\d{2}-\d{2}"/);
      await submit();
      assert.deepEqual(f.calls, [
        {
          action: 'change_history',
          gateway: 'google_ads_native_action',
          connection_id: 'google-login',
          account_id: '001',
          requirements: {date_from: from, date_to: to, limit: 1000},
        },
      ]);
      const html = f.node('#change-history-result').innerHTML;
      // Native values stay literal in both languages.
      for (const native of ['AD_GROUP_AD', 'CAMPAIGN', 'CREATE', 'GOOGLE_ADS_WEB_CLIENT', 'campaign_budget', '5~6'])
        assert.ok(html.includes(native), native);
      if (locale === 'ar') {
        assert.match(html, /التغييرات في كل يوم/);
        assert.match(html, /التغييرات حسب الأداة المستخدمة/);
        assert.match(html, /هوية من أجرى التغيير بيانات شخصية ولم تُطلب/);
        assert.match(html, /غير مُبلّغ عنه/);
      } else {
        assert.match(html, /Changes per day/);
        assert.match(html, /Changes by tool used/);
        assert.match(html, /Who made a change is personal data and was not requested/);
        assert.match(html, /Not reported/);
      }
      // The timeline is newest day first: today's change, then the two from six days ago.
      const days = [
        ...html.matchAll(/<th scope="row"><bdi dir="ltr">(\d{4}-\d{2}-\d{2})<\/bdi><\/th><td>(\d+)<\/td>/g),
      ];
      assert.deepEqual(
        days.map(m => [m[1], m[2]]),
        [
          [to, '1'],
          [from, '2'],
        ],
      );
      assert.equal(f.node('#change-history-heading').focused, true);
      assert.doesNotMatch(html, /change-history-next/, 'three rows need no paging');
    },
  );

test('a window Google cannot answer is refused before any request', async () => {
  for (const dates of [
    {date_from: isoDay(-30), date_to: isoDay(0)},
    {date_from: isoDay(-30), date_to: isoDay(-1)},
    {date_from: isoDay(-2), date_to: isoDay(2)},
    {date_from: to, date_to: from},
    {date_from: '', date_to: to},
    {date_from: '2026-02-30', date_to: to},
  ]) {
    const {f, submit} = await page('ar', () => assert.fail('no request'), dates);
    await assert.rejects(submit(), error => {
      assert.match(error.message, /اختر تواريخ صريحة تغطي 30 يومًا كحد أقصى/);
      return true;
    });
    assert.deepEqual(f.calls, [], JSON.stringify(dates));
  }
  // Exactly 30 days ending today is the widest accepted window.
  const widest = {date_from: isoDay(-29), date_to: isoDay(0)},
    {f, submit} = await page('en', () => history([], {scope: {...history([]).scope, ...widest}}), widest);
  await submit();
  assert.deepEqual(f.calls[0].requirements, {...widest, limit: 1000});
  assert.match(f.node('#change-history-result').innerHTML, /Google Ads reported no changes in these dates\./);
});

test('a response for another selection or with a field the read never selects is refused, not shown', async () => {
  for (const change of [
    out => (out.scope.account_id = '002'),
    out => (out.scope.connection_id = 'other-login'),
    out => (out.scope.date_from = isoDay(-20)),
    out => (out.scope.limit = 50),
    out => (out.rows[0].user_email = 'person@example.test'),
    out => (out.rows[0].change_event = 'customers/002/changeEvents/1'),
    out => (out.rows[0].campaign = 'customers/002/campaigns/9'),
    out => (out.rows[0].change_date_time = isoDay(-20) + ' 10:00:00'),
    out => (out.rows[0].changed_fields = ['status;drop']),
    out => (out.rows[0].resource_type = 'campaign <img>'),
    out => (out.timeline.by_day = {}),
    out => (out.personal_data = {user_email: 'hashed'}),
    out => (out.provider_mutations = 1),
    out => (out.row_count = 2),
    out => (out.complete = false),
  ]) {
    const out = history([row(1)]);
    change(out);
    const {f, submit} = await page('en', () => out);
    await assert.rejects(submit(), /The change history response is incomplete or belongs to a different selection/);
    assert.equal(f.node('#change-history-result').innerHTML, '');
    assert.equal(f.calls.length, 1);
  }
});

test('rows page locally 50 at a time without another read; a full 1,000-row read says older changes may exist', async () => {
  const rows = Array.from({length: 120}, (_, i) => row(1000 + i)),
    {f, submit} = await page('en', () => history(rows));
  await submit();
  const shown = () =>
    [...f.node('#change-history-result').innerHTML.matchAll(/<tr><th scope="row"><bdi dir="ltr">\d{4}-\d{2}-\d{2} /g)]
      .length;
  assert.equal(shown(), 50);
  assert.match(f.node('#change-history-result').innerHTML, /Page 1 of 3/);
  await f.bindings.get('#change-history-next')();
  await f.bindings.get('#change-history-next')();
  assert.match(f.node('#change-history-result').innerHTML, /Page 3 of 3/);
  assert.equal(shown(), 20);
  await f.bindings.get('#change-history-previous')();
  assert.match(f.node('#change-history-result').innerHTML, /Page 2 of 3/);
  assert.equal(f.calls.length, 1, 'paging never reads Google Ads again');
  const full = await page('ar', () => history(Array.from({length: 1000}, (_, i) => row(i))));
  await full.submit();
  assert.match(full.f.node('#change-history-result').innerHTML, /قُرئت أحدث 1,000 من التغييرات فقط/);
  const empty = await page('en', () => history([]));
  await empty.submit();
  assert.match(empty.f.node('#change-history-result').innerHTML, /Google Ads reported no changes in these dates\./);
});

test('the page accepts the actual change_history response of the server for the same selection', async t => {
  const store = new Store(':memory:', Buffer.alloc(32, 74).toString('base64'));
  t.after(() => store.close());
  const owner = {tenantId: 'change-history-ui', userId: 'owner', role: 'admin'};
  store.putConnection(
    owner,
    {
      id: 'google-login',
      tenantId: owner.tenantId,
      gateway: 'google_ads_native_action',
      accounts: ['001'],
      enabled: true,
      label: 'Synthetic Google',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    {accessToken: 'synthetic'},
  );
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async () =>
        Response.json({
          results: [
            {
              changeEvent: {
                resourceName: 'customers/001/changeEvents/1',
                changeDateTime: from + ' 10:00:00.123456',
                changeResourceType: 'CAMPAIGN',
                changeResourceName: 'customers/001/campaigns/77',
                clientType: 'GOOGLE_ADS_WEB_CLIENT',
                resourceChangeOperation: 'UPDATE',
                changedFields: 'status',
                campaign: 'customers/001/campaigns/77',
              },
            },
          ],
        }),
      async () => {},
      30000,
      8 * 1024 * 1024,
      100,
    ),
  );
  const {f, submit} = await page('en', async args => {
    const r = await service.call('amcp_workspace', args, {...owner, userId: 'reader', role: 'reader'});
    assert.equal(r.success, true, JSON.stringify(r));
    return r.data;
  });
  await submit();
  const html = f.node('#change-history-result').innerHTML;
  assert.match(html, /customers\/001\/campaigns\/77/);
  assert.match(html, /Changes per day/);
});
