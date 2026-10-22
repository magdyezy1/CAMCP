// Reference solutions of the MCP evaluation set (tests/fixtures/mcp-evaluation/evaluation.xml), one per question in
// the same order. Each answers its question as an assistant would, through read-only AMCP tool calls only, starting
// from the workspace's connections rather than from fixture knowledge, and returns the answer string. The verifier
// (tests/mcp-evaluation-set.test.mjs) runs each on a fresh workspace and holds its answer equal to the XML answer, so
// every answer in the set is proven by the tools, not asserted. `call(tool, args)` returns the tool's envelope.
const ok = (result, what) => {
  if (result?.success !== true) throw Error(what + ' was refused: ' + result?.error?.code);
  return result.data;
};
/** The connected accounts, from the workspace context tool. */
const accounts = async call => ok(await call('amcp_platform_workspace', {operation: 'list_accounts'}), 'list_accounts');
/** The Meta ad accounts of the login whose label names `client`. */
const metaAccountsOf = async (call, client) =>
  (await accounts(call)).filter(a => a.platform === 'meta_native_action' && a.connection_label.includes(client));
/** One Meta ad account's own record, as Meta returns it. */
const metaAccount = (call, account) =>
  call('meta_native_action', {
    action: 'meta_ad_account_id_get',
    account_id: account.id,
    connection_id: account.connection_id,
  });
/** The saved report snapshot of one client, read whole. */
const snapshotOf = async (call, client) => {
  const listed = ok(await call('amcp_reporting_overview', {action: 'list'}), 'list'),
    report = listed.reports.find(r => r.config.client_name.includes(client));
  return ok(await call('amcp_reporting_overview', {action: 'get', id: report.id}), 'get');
};
/** Every saved campaign plan, each read in full. */
const plans = async call => {
  const listed = ok(await call('amcp_campaign', {action: 'list'}), 'list');
  const out = [];
  for (const plan of listed.campaigns)
    out.push(ok(await call('amcp_campaign', {action: 'get', id: plan.id, detail: 'full'}), 'get'));
  return out;
};

export const solutions = [
  {
    question:
      'Our outdoor-gear client has two Meta ad accounts connected to AMCP, but Meta will not let AMCP read one of them. Which ad account is it? Answer with the ad account ID only.',
    async solve(call) {
      const refused = [];
      for (const account of await metaAccountsOf(call, 'Northwind'))
        if ((await metaAccount(call, account)).success === false) refused.push(account.id);
      if (refused.length !== 1) throw Error('Expected one refused account, found ' + refused.length);
      return refused[0];
    },
  },
  {
    question:
      "In which IANA time zone does the bakery client's Meta ad account report? Answer with the time zone name only, for example Europe/Paris.",
    async solve(call) {
      const [account] = await metaAccountsOf(call, 'Bakery');
      return ok(await metaAccount(call, account), 'the account read').data.timezone_name;
    },
  },
  {
    question:
      'In the saved weekly performance report for the outdoor-gear client covering 1 to 7 September 2026, which campaign spent the most? Answer with the campaign name exactly as the report shows it.',
    async solve(call) {
      const report = await snapshotOf(call, 'Northwind');
      return [...report.rows].sort((a, b) => b.metrics.spend - a.metrics.spend)[0].campaign_name;
    },
  },
  {
    question:
      "What did the bakery client's campaigns spend in total in its saved weekly performance report for 1 to 7 September 2026? Answer in the report's currency as a number with two decimals and no currency sign.",
    async solve(call) {
      const report = await snapshotOf(call, 'Bakery'),
        cents = report.rows.reduce((sum, row) => sum + Math.round(row.metrics.spend * 100), 0);
      return (cents / 100).toFixed(2);
    },
  },
  {
    question:
      'One of the captured Google Ads reports for the outdoor-gear client is marked as incomplete evidence. What source name was recorded for that capture? Answer with the source name exactly.',
    async solve(call) {
      const google = (await accounts(call)).find(
          a => a.platform === 'google_ads_native_action' && a.connection_label.includes('Northwind'),
        ),
        listed = ok(await call('amcp_reporting', {action: 'list'}), 'list'),
        incomplete = [];
      for (const r of listed.reports.filter(r => r.connection_id === google.connection_id)) {
        const report = ok(await call('amcp_reporting', {action: 'get', id: r.id, limit: 1}), 'get');
        if (report.semantics.complete === false) incomplete.push(report.semantics.source_name);
      }
      if (incomplete.length !== 1) throw Error('Expected one incomplete capture, found ' + incomplete.length);
      return incomplete[0];
    },
  },
  {
    question:
      'Which saved campaign plan would create a Meta campaign whose objective is lead generation? Answer with the plan name exactly.',
    async solve(call) {
      const leads = (await plans(call)).filter(plan =>
        plan.steps.some(s => s.gateway === 'meta_native_action' && s.arguments?.payload?.objective === 'OUTCOME_LEADS'),
      );
      if (leads.length !== 1) throw Error('Expected one lead plan, found ' + leads.length);
      return leads[0].name;
    },
  },
  {
    question:
      "How many saved campaign plans would create campaigns in the outdoor-gear client's Meta ad account that reports in euros? Answer with a number only.",
    async solve(call) {
      let euro;
      for (const account of await metaAccountsOf(call, 'Northwind')) {
        const read = await metaAccount(call, account);
        if (read.success && read.data.data.currency === 'EUR') euro = account.id;
      }
      const listed = ok(await call('amcp_campaign', {action: 'list'}), 'list');
      return String(
        listed.campaigns.filter(p => p.accounts.some(a => a.gateway === 'meta_native_action' && a.account_id === euro))
          .length,
      );
    },
  },
  {
    question:
      "In the outdoor-gear client's Tag Manager workspace 66 of container 55, one tag waits for the visitor's consent to analytics storage before it fires. What is that tag's ID? Answer with the tag ID only.",
    async solve(call) {
      const tags = (await accounts(call)).filter(a => a.platform === 'gtm_native_action');
      for (const account of tags) {
        const listed = await call('gtm_native_action', {
          operation: 'gtm_ops',
          arguments: {
            action: 'LIST_TAGS',
            connection_id: account.connection_id,
            account_id: account.id,
            container_id: '55',
            workspace_id: '66',
          },
        });
        if (!listed.success) continue;
        const consent = listed.data.data.tag.filter(t =>
          t.consentSettings?.consentType?.list?.some(v => v.value === 'analytics_storage'),
        );
        if (consent.length === 1) return consent[0].tagId;
      }
      throw Error('No tag waits for analytics_storage');
    },
  },
  {
    question:
      'One image in the media library was uploaded to two different ad accounts from the very same original file. What is its name in the library? Answer with the name exactly.',
    async solve(call) {
      const library = ok(await call('amcp_media', {action: 'library'}), 'library'),
        byOriginal = new Map();
      for (const asset of library.assets.filter(a => a.media_type === 'image' && a.original_sha256))
        byOriginal.set(asset.original_sha256, [...(byOriginal.get(asset.original_sha256) ?? []), asset]);
      const shared = [...byOriginal].filter(([, assets]) => new Set(assets.map(a => a.account_id)).size > 1);
      if (shared.length !== 1) throw Error('Expected one shared original, found ' + shared.length);
      // The library confirms it: the receipts of that one original, across accounts.
      const same = ok(await call('amcp_media', {action: 'library', original_sha256: shared[0][0]}), 'library');
      return [...new Set(same.assets.map(a => a.name))].join(', ');
    },
  },
  {
    question:
      'Which campaign of the outdoor-gear client appears in its saved weekly performance report but is paused in Meta? Answer with the campaign name exactly.',
    async solve(call) {
      const report = await snapshotOf(call, 'Northwind'),
        reported = new Set(report.rows.map(r => r.campaign_name)),
        account = report.config.sources[0],
        campaigns = ok(
          await call('meta_native_action', {
            action: 'meta_ad_account_id_campaigns_get',
            account_id: account.account_id,
            connection_id: account.connection_id,
            params: {fields: 'name,status,objective'},
          }),
          'campaigns',
        ).data.data,
        paused = campaigns.filter(c => c.status === 'PAUSED' && reported.has(c.name));
      if (paused.length !== 1) throw Error('Expected one paused reported campaign, found ' + paused.length);
      return paused[0].name;
    },
  },
];
