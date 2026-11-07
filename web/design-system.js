'use strict';
// V2-WEB-02: the component state page (docs/DESIGN-SYSTEM.md). Members only, not in the navigation: every component of
// web/components*.js in every state it has, to be read in English and Arabic and in both themes (the language and
// appearance controls of the shell). States that need the pointer or the keyboard (hover, active, focus) are drawn with
// data-state, so they can be seen at rest and compared. It is the review surface for the owner's sign-off.
const designSystemStates = {
  rest: () => uiText('Rest'),
  hover: () => uiText('Hover'),
  active: () => uiText('Active'),
  focus: () => uiText('Focus'),
  disabled: () => uiText('Disabled'),
  loading: () => uiText('Loading'),
  error: () => uiText('Error'),
};
/** One labelled example: the state or variant it shows, then the component. */
const designSystemSpecimen = (label, markup) =>
  html`<figure class="amcp-ds-specimen"><figcaption class="amcp-ds-caption">${label}</figcaption>${markup}</figure>`;
const designSystemSection = (id, title, intro, body) =>
  html`<section class="amcp-ds-section" id="section-${id}" aria-labelledby="section-${id}-title" tabindex="-1"><h2 class="amcp-ds-title" id="section-${id}-title">${title}</h2><div class="amcp-ds-intro">${intro}</div>${body}</section>`;

function designSystemButtons() {
  const variants = [
    ['primary', () => uiText('Primary')],
    ['secondary', () => uiText('Secondary')],
    ['quiet', () => uiText('Quiet')],
    ['danger', () => uiText('Danger')],
  ];
  return designSystemSection(
    'buttons',
    uiText('Buttons'),
    uiText('Four variants and three sizes. A primary button is always at least 44 pixels high and wide.'),
    html`<div class="amcp-stack">${variants.map(
      ([variant, name]) =>
        html`<div class="amcp-ds-row"><h3 class="amcp-ds-row-title">${name()}</h3><div class="amcp-ds-specimens">${[
          designSystemSpecimen(designSystemStates.rest(), AmcpUI.button({label: name(), variant})),
          designSystemSpecimen(designSystemStates.hover(), AmcpUI.button({label: name(), variant, state: 'hover'})),
          designSystemSpecimen(designSystemStates.active(), AmcpUI.button({label: name(), variant, state: 'active'})),
          designSystemSpecimen(designSystemStates.focus(), AmcpUI.button({label: name(), variant, state: 'focus'})),
          designSystemSpecimen(designSystemStates.disabled(), AmcpUI.button({label: name(), variant, disabled: true})),
          designSystemSpecimen(
            designSystemStates.loading(),
            AmcpUI.button({label: name(), variant, loading: true, loadingLabel: uiText('Working…')}),
          ),
        ]}</div></div>`,
    )}<div class="amcp-ds-row"><h3 class="amcp-ds-row-title">${uiText('Sizes and forms')}</h3><div class="amcp-ds-specimens">${[
      designSystemSpecimen(uiText('Small'), AmcpUI.button({label: uiText('Small'), size: 'sm'})),
      designSystemSpecimen(uiText('Medium'), AmcpUI.button({label: uiText('Medium'), size: 'md'})),
      designSystemSpecimen(uiText('Large'), AmcpUI.button({label: uiText('Large'), size: 'lg'})),
      designSystemSpecimen(uiText('Icon button'), AmcpUI.iconButton({icon: 'close', label: uiText('Close')})),
      designSystemSpecimen(uiText('Link'), AmcpUI.button({label: uiText('Open reports'), href: '/report-library'})),
      designSystemSpecimen(uiText('Toggle'), AmcpUI.button({label: uiText('Show totals'), pressed: true})),
    ]}</div></div></div>`,
  );
}

function designSystemBadges() {
  const tones = [
    ['neutral', () => uiText('Draft')],
    ['success', () => uiText('Connected')],
    ['warning', () => uiText('Partial data')],
    ['danger', () => uiText('Failed')],
    ['info', () => uiText('Default')],
    ['marker', () => uiText('Needs attention')],
  ];
  return designSystemSection(
    'badges',
    uiText('Badge'),
    uiText(
      'One badge replaces the four of the older pages. A status always has an icon and a word; peach is a marker beside the word.',
    ),
    html`<div class="amcp-stack"><div class="amcp-ds-specimens">${tones.map(([tone, name]) => designSystemSpecimen(name(), AmcpUI.badge({label: name(), tone})))}</div>${designSystemSpecimen(uiText('The old badge classes and the badge each becomes'), designSystemLegacyBadges())}</div>`,
  );
}

/** The four old badge components beside the badge that replaces each (AmcpUI.badge.legacy is the map). */
function designSystemLegacyBadges() {
  const dot = html`<i></i>`,
    samples = [
      ['status online', uiText('Connected'), label => html`<span class="status online">${dot}${label}</span>`],
      ['status attention', uiText('Needs review'), label => html`<span class="status attention">${dot}${label}</span>`],
      ['status offline', uiText('Offline'), label => html`<span class="status offline">${dot}${label}</span>`],
      ['status error', uiText('Failed'), label => html`<span class="status error">${dot}${label}</span>`],
      ['status', uiText('Draft'), label => html`<span class="status">${dot}${label}</span>`],
      ['default-badge', uiText('Default'), label => html`<span class="default-badge">${label}</span>`],
      ['creative-tag', uiText('Image'), label => html`<span class="creative-tag">${label}</span>`],
      [
        'measurement-ledger-state',
        uiText('Observed'),
        label => html`<span class="measurement-ledger-state">${label}</span>`,
      ],
    ];
  return html`<div class="amcp-ds-legacy">${samples.map(
    ([name, label, old]) =>
      html`<div class="amcp-ds-legacy-row">${old(label)}<code dir="ltr">.${name.replace(' ', '.')}</code><span aria-hidden="true">→</span>${AmcpUI.badge({label, tone: AmcpUI.badge.legacy[name]})}<code dir="ltr">${AmcpUI.badge.legacy[name]}</code></div>`,
  )}</div>`;
}

function designSystemFields() {
  return designSystemSection(
    'fields',
    uiText('Fields'),
    uiText('Text, number and date inputs and a select. The state is on the border and in words, never colour alone.'),
    html`<div class="amcp-ds-specimens amcp-ds-wide">${[
      designSystemSpecimen(
        designSystemStates.rest(),
        AmcpUI.input({
          id: 'ds-text',
          label: uiText('Report name'),
          hint: uiText('Shown to your client.'),
          placeholder: uiText('Weekly performance'),
        }),
      ),
      designSystemSpecimen(
        designSystemStates.hover(),
        AmcpUI.input({id: 'ds-text-hover', label: uiText('Report name'), state: 'hover'}),
      ),
      designSystemSpecimen(
        designSystemStates.focus(),
        AmcpUI.input({id: 'ds-text-focus', label: uiText('Report name'), state: 'focus'}),
      ),
      designSystemSpecimen(
        designSystemStates.error(),
        AmcpUI.input({
          id: 'ds-text-error',
          label: uiText('Report name'),
          value: '',
          error: uiText('Enter a name for the report.'),
          required: true,
        }),
      ),
      designSystemSpecimen(
        designSystemStates.disabled(),
        AmcpUI.input({
          id: 'ds-text-off',
          label: uiText('Report name'),
          value: uiText('Weekly performance'),
          disabled: true,
        }),
      ),
      designSystemSpecimen(
        uiText('Read only'),
        AmcpUI.input({
          id: 'ds-text-ro',
          label: uiText('Report name'),
          value: uiText('Weekly performance'),
          readonly: true,
        }),
      ),
      designSystemSpecimen(
        designSystemStates.loading(),
        AmcpUI.input({id: 'ds-text-load', label: uiText('Report name'), loading: true}),
      ),
      designSystemSpecimen(
        uiText('Number (exact decimal)'),
        AmcpUI.input({
          id: 'ds-number',
          label: uiText('Daily budget'),
          type: 'number',
          value: '1250.50',
          hint: uiText('Digits are kept exactly as typed.'),
        }),
      ),
      designSystemSpecimen(
        uiText('Date'),
        AmcpUI.input({id: 'ds-date', label: uiText('Start date'), type: 'date', value: '2026-01-15'}),
      ),
      designSystemSpecimen(
        uiText('Select'),
        AmcpUI.select({
          id: 'ds-select',
          label: uiText('Reporting level'),
          value: 'ad',
          options: [
            {value: 'campaign', label: uiText('Campaign')},
            {value: 'ad_set', label: uiText('Ad set')},
            {value: 'ad', label: uiText('Ad')},
          ],
        }),
      ),
      designSystemSpecimen(
        uiText('Select, error'),
        AmcpUI.select({
          id: 'ds-select-error',
          label: uiText('Currency'),
          options: [{value: '', label: uiText('Choose a currency')}],
          error: uiText('Choose a currency.'),
        }),
      ),
      designSystemSpecimen(
        uiText('Checkbox'),
        html`<div class="amcp-stack">${[AmcpUI.checkbox({id: 'ds-check-on', label: uiText('Include totals'), checked: true}), AmcpUI.checkbox({id: 'ds-check-mixed', label: uiText('Some accounts selected'), mixed: true}), AmcpUI.checkbox({id: 'ds-check-off', label: uiText('Not available'), disabled: true})]}</div>`,
      ),
    ]}</div>`,
  );
}

function designSystemChips() {
  return designSystemSection(
    'chips',
    uiText('Filter chips'),
    uiText('Toggle buttons that say whether they are pressed. Removable chips name what they remove.'),
    html`<div class="amcp-stack">${[
      designSystemSpecimen(
        uiText('Several can be pressed'),
        AmcpUI.chips({
          label: uiText('Platforms'),
          chips: [
            {id: 'meta', label: 'Meta', pressed: true, count: 12},
            {id: 'tiktok', label: 'TikTok', count: 4},
            {id: 'google', label: 'Google Ads', count: 9},
            {id: 'x', label: 'X', disabled: true},
          ],
        }),
      ),
      designSystemSpecimen(
        uiText('One at a time'),
        AmcpUI.chips({
          label: uiText('Period'),
          mode: 'single',
          chips: [
            {id: '7', label: uiText('Last 7 days'), pressed: true},
            {id: '30', label: uiText('Last 30 days')},
            {id: 'month', label: uiText('This month')},
          ],
        }),
      ),
      designSystemSpecimen(
        uiText('Removable'),
        AmcpUI.chips({
          label: uiText('Active filters'),
          removable: true,
          chips: [
            {id: 'a', label: uiText('Spend above 100')},
            {id: 'b', label: uiText('Active campaigns')},
            {id: 'c', label: uiText('Last 30 days')},
          ],
        }),
      ),
    ]}</div>`,
  );
}

function designSystemFeedback() {
  return designSystemSection(
    'feedback',
    uiText('Progress, loading and states'),
    uiText('A bar is determinate only when the value is known. An empty state always offers one next action.'),
    html`<div class="amcp-stack">${[
      html`<div class="amcp-ds-specimens amcp-ds-wide">${[
        designSystemSpecimen(uiText('Known value'), AmcpUI.progress({label: uiText('Report run'), value: 42})),
        designSystemSpecimen(
          uiText('Steps'),
          AmcpUI.progress({label: uiText('Accounts read'), value: 3, max: 5, text: uiText('3 of 5')}),
        ),
        designSystemSpecimen(uiText('Unknown value'), AmcpUI.progress({label: uiText('Report run')})),
        designSystemSpecimen(
          uiText('Complete'),
          AmcpUI.progress({label: uiText('Export'), value: 100, tone: 'success'}),
        ),
      ]}</div>`,
      html`<div class="amcp-ds-specimens amcp-ds-wide">${[
        designSystemSpecimen(uiText('Skeleton, text'), AmcpUI.skeleton({shape: 'text', lines: 3})),
        designSystemSpecimen(uiText('Skeleton, card'), AmcpUI.skeleton({shape: 'card'})),
        designSystemSpecimen(uiText('Skeleton, row'), AmcpUI.skeleton({shape: 'row'})),
      ]}</div>`,
      html`<div class="amcp-ds-specimens amcp-ds-wide">${[
        designSystemSpecimen(
          uiText('Empty state'),
          AmcpUI.emptyState({
            title: uiText('No reports yet'),
            body: uiText('Create a report to see results here.'),
            action: {label: uiText('New report'), href: '/reporting-overview'},
          }),
        ),
        designSystemSpecimen(
          uiText('Error state'),
          AmcpUI.errorState({
            title: uiText('The report could not run'),
            body: uiText('The platform did not answer in time.'),
            retry: {label: uiText('Try again')},
            reference: 'REQ-4F2A91',
            details: uiText('The request timed out after 30 seconds.'),
          }),
        ),
      ]}</div>`,
      designSystemSpecimen(
        uiText('Stepper'),
        AmcpUI.stepper({
          label: uiText('Report setup'),
          steps: [
            {id: 'scope', label: uiText('What to report'), status: 'complete'},
            {id: 'period', label: uiText('When'), status: 'current', description: uiText('Last 30 days')},
            {id: 'measures', label: uiText('Measures'), status: 'error', description: uiText('Choose a measure')},
            {id: 'review', label: uiText('Review')},
          ],
        }),
      ),
    ]}</div>`,
  );
}

function designSystemCards() {
  return designSystemSection(
    'cards',
    uiText('Cards'),
    uiText('A KPI is plain large type. Zero is shown as 0 and a missing figure as a dash with its reason.'),
    html`<div class="amcp-ds-specimens amcp-ds-wide">${[
      designSystemSpecimen(
        uiText('KPI'),
        AmcpUI.kpi({label: uiText('Spend'), value: '12,430.50', unit: 'USD', note: uiText('Last 30 days')}),
      ),
      designSystemSpecimen(
        uiText('KPI, zero'),
        AmcpUI.kpi({label: uiText('Conversions'), value: '0', note: uiText('Last 30 days')}),
      ),
      designSystemSpecimen(
        uiText('KPI, missing'),
        AmcpUI.kpi({label: uiText('Revenue'), value: null, note: uiText('No platform has returned revenue yet.')}),
      ),
      designSystemSpecimen(
        uiText('Platform card'),
        AmcpUI.platformCard({
          name: 'Meta',
          status: {tone: 'success', label: uiText('Connected')},
          meta: uiText('3 accounts'),
          action: {label: uiText('Manage'), href: '/connections'},
        }),
      ),
      designSystemSpecimen(
        uiText('Creative card'),
        AmcpUI.creativeCard({
          id: 'ds-a',
          title: uiText('Spring launch'),
          meta: uiText('Image, 1080 by 1080'),
          mediaLabel: uiText('Preview of Spring launch'),
          media: html`<span>${uiText('Image')}</span>`,
          selectable: true,
          badges: [{label: uiText('Approved'), tone: 'success'}],
        }),
      ),
      designSystemSpecimen(
        uiText('Creative card, selected'),
        AmcpUI.creativeCard({
          id: 'ds-b',
          title: uiText('Summer offer'),
          meta: uiText('Video, 15 seconds'),
          mediaLabel: uiText('Preview of Summer offer'),
          media: html`<span>${uiText('Video')}</span>`,
          selectable: true,
          selected: true,
          badges: [{label: uiText('Needs attention'), tone: 'marker'}],
        }),
      ),
    ]}</div>`,
  );
}

// Synthetic data for the choosing components: made-up names, never a real account.
const designSystemAccounts = Array.from({length: 120}, (_, index) => ({
  value: 'acct-' + (1001 + index),
  label:
    ['Harbor Outdoor', 'Cedar Cafe', 'Orchard Studio', 'Summit Sports', 'Willow Books'][index % 5] +
    ' ' +
    (Math.floor(index / 5) + 1),
  description: ['Meta', 'TikTok', 'Google Ads', 'Snapchat'][index % 4] + ' · ' + (1001 + index),
}));
const designSystemCampaigns = Array.from({length: 40}, (_, index) => ({
  value: 'camp-' + (index + 1),
  label:
    ['Spring launch', 'Summer offer', 'Back to school', 'Holiday gifts'][index % 4] + ' ' + (Math.floor(index / 4) + 1),
  description: ['Awareness', 'Traffic', 'Sales'][index % 3],
}));
const designSystemScope = [
  {
    id: 'meta',
    label: 'Meta',
    children: [
      {
        id: 'meta-a',
        label: 'Harbor Outdoor',
        meta: '3',
        children: [
          {id: 'meta-a1', label: 'Spring launch'},
          {id: 'meta-a2', label: 'Summer offer'},
          {id: 'meta-a3', label: 'Holiday gifts'},
        ],
      },
      {id: 'meta-b', label: 'Cedar Cafe', meta: '1', children: [{id: 'meta-b1', label: 'Back to school'}]},
    ],
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    children: [
      {
        id: 'tiktok-a',
        label: 'Orchard Studio',
        meta: '2',
        children: [
          {id: 'tiktok-a1', label: 'Spring launch'},
          {id: 'tiktok-a2', label: 'Summer offer', disabled: true},
        ],
      },
    ],
  },
  {id: 'google', label: 'Google Ads', children: [{id: 'google-a', label: 'Summit Sports', meta: '0', disabled: true}]},
];

function designSystemChoosing() {
  const panel = text => html`<div class="amcp-ds-panel">${text}</div>`;
  return designSystemSection(
    'choosing',
    uiText('Segmented control and tabs'),
    uiText(
      'A segmented control is a group of radio buttons. Tabs move with the arrow keys, Home and End, and a disabled tab is skipped.',
    ),
    html`<div class="amcp-stack">${[
      designSystemSpecimen(
        uiText('Segmented control'),
        AmcpUI.segmented({
          name: 'ds-density',
          label: uiText('Row density'),
          value: 'comfortable',
          options: [
            {value: 'comfortable', label: uiText('Comfortable')},
            {value: 'compact', label: uiText('Compact')},
            {value: 'dense', label: uiText('Dense'), disabled: true},
          ],
        }),
      ),
      designSystemSpecimen(
        uiText('Tabs, selected on arrow keys'),
        AmcpUI.tabs({
          id: 'ds-tabs',
          label: uiText('Report views'),
          tabs: [
            {
              id: 'overview',
              label: uiText('Overview'),
              panel: panel(uiText('Key figures, charts and the written summary.')),
            },
            {id: 'campaigns', label: uiText('Campaigns'), panel: panel(uiText('One row for each campaign.'))},
            {id: 'ads', label: uiText('Ads'), panel: panel(uiText('One row for each ad.'))},
            {
              id: 'quality',
              label: uiText('Data quality'),
              panel: panel(uiText('Where the figures came from.')),
              disabled: true,
            },
          ],
        }),
      ),
      designSystemSpecimen(
        uiText('Tabs, selected on Enter or Space'),
        AmcpUI.tabs({
          id: 'ds-tabs-manual',
          label: uiText('History'),
          activation: 'manual',
          tabs: [
            {id: 'snapshots', label: uiText('Snapshots'), panel: panel(uiText('Saved copies of this report.'))},
            {id: 'exports', label: uiText('Exports'), panel: panel(uiText('Files made from this report.'))},
          ],
        }),
      ),
      designSystemSpecimen(
        uiText('Tabs, vertical'),
        AmcpUI.tabs({
          id: 'ds-tabs-vertical',
          label: uiText('Settings sections'),
          orientation: 'vertical',
          tabs: [
            {id: 'general', label: uiText('General'), panel: panel(uiText('Name and language.'))},
            {id: 'access', label: uiText('Access'), panel: panel(uiText('Who can open this workspace.'))},
          ],
        }),
      ),
    ]}</div>`,
  );
}

function designSystemCombobox() {
  const specimen = (label, markup) => designSystemSpecimen(label, html`<div class="amcp-ds-static">${markup}</div>`);
  return designSystemSection(
    'combobox',
    uiText('Searchable list'),
    uiText(
      'Type to narrow a long list, ignoring case and accents. Arrow keys move, Enter chooses, Escape closes. The list says how many results there are.',
    ),
    html`<div class="amcp-ds-specimens amcp-ds-wide">${[
      specimen(
        uiText('Accounts, 120 of them'),
        AmcpUI.combobox({
          id: 'ds-accounts',
          label: uiText('Account'),
          hint: uiText('Type part of a name or an ID.'),
          name: 'account',
        }),
      ),
      specimen(
        uiText('Campaigns, searched on the server'),
        AmcpUI.combobox({id: 'ds-campaigns', label: uiText('Campaign'), hint: uiText('The list is read as you type.')}),
      ),
      specimen(uiText('Loading'), AmcpUI.combobox({id: 'ds-loading', label: uiText('Campaign')})),
      specimen(uiText('Could not load'), AmcpUI.combobox({id: 'ds-failed', label: uiText('Campaign')})),
      specimen(
        uiText('Error'),
        AmcpUI.combobox({
          id: 'ds-combo-error',
          label: uiText('Account'),
          required: true,
          error: uiText('Choose an account.'),
        }),
      ),
      specimen(uiText('Disabled'), AmcpUI.combobox({id: 'ds-combo-off', label: uiText('Account'), disabled: true})),
    ]}</div>`,
  );
}

function designSystemTree() {
  return designSystemSection(
    'tree',
    uiText('Scope tree'),
    uiText(
      'Checking a parent checks every account and campaign under it; a parent with only some of them shows a dash. Disabled items are skipped.',
    ),
    html`<div class="amcp-stack">${designSystemSpecimen(
      uiText('Platforms, accounts and campaigns'),
      html`${AmcpUI.tree({id: 'ds-tree', label: uiText('Choose what to report on'), nodes: designSystemScope, checked: ['meta-a1'], expanded: ['meta', 'meta-a', 'tiktok', 'tiktok-a']})}<div class="amcp-ds-note" id="ds-tree-summary" role="status"></div>`,
    )}</div>`,
  );
}

/** Fills the components that need a script: the lists' options and the tree's state. Runs after the page is drawn. */
function designSystemMount() {
  const host = id => document.getElementById(id + '-root'),
    later = (value, ms) => new Promise(resolve => setTimeout(() => resolve(value), ms)),
    found = query => AmcpUI.combobox.filter(designSystemCampaigns, query, 8).items;
  AmcpUI.combobox.mount(host('ds-accounts'), {options: designSystemAccounts});
  AmcpUI.combobox.mount(host('ds-campaigns'), {search: query => later(found(query), 400)});
  AmcpUI.combobox.mount(host('ds-loading'), {search: () => new Promise(() => {})}).open();
  let attempts = 0;
  AmcpUI.combobox
    .mount(host('ds-failed'), {
      search: query => (++attempts % 2 ? Promise.reject(Error('unavailable')) : later(found(query), 200)),
    })
    .open();
  const summary = document.getElementById('ds-tree-summary'),
    platforms = new Set(designSystemScope.map(platform => platform.id)),
    say = checked => {
      const campaigns = checked.filter(id => !platforms.has(id) && /\d$/.test(id) && !/^[a-z]+-[a-z]$/.test(id)).length;
      summary.textContent = uiPlural(campaigns, '{count} campaign selected', '{count} campaigns selected');
    },
    tree = AmcpUI.tree.mount(document.getElementById('ds-tree'), {
      nodes: designSystemScope,
      checked: ['meta-a1'],
      expanded: ['meta', 'meta-a', 'tiktok', 'tiktok-a'],
      onChange: say,
    });
  say(tree.checked());
  designSystemToasts = AmcpUI.toasts.mount(document.getElementById('ds-toasts'));
}
// The buttons of the overlay section: one delegated behaviour on the page's root, so a redraw never adds a second.
AmcpUI.behave('design-system', {
  click(event) {
    const button = event.target.closest('[data-ds-action]');
    if (!button) return false;
    const action = button.getAttribute('data-ds-action');
    if (action.startsWith('toast-')) designSystemToast(action.slice(6));
    else void designSystemDialog(action);
    return true;
  },
});

function designSystemTable() {
  const columns = () => [
      {id: 'name', label: uiText('Campaign'), native: true},
      {id: 'status', label: uiText('Status')},
      {id: 'spend', label: uiText('Spend'), numeric: true},
      {id: 'clicks', label: uiText('Clicks'), numeric: true},
      {id: 'rate', label: uiText('Click-through rate'), numeric: true},
    ],
    status = {
      active: () => AmcpUI.badge({label: uiText('Active'), tone: 'success'}),
      paused: () => AmcpUI.badge({label: uiText('Paused'), tone: 'warning'}),
      draft: () => AmcpUI.badge({label: uiText('Draft')}),
    },
    rows = () =>
      [
        ['Spring launch 1', 'active', '1,250.50', '3,100', '2.41%'],
        ['Summer offer 1', 'paused', '842.00', '1,980', '1.87%'],
        ['Back to school 1', 'active', '2,310.75', '6,420', '3.02%'],
        ['Holiday gifts 1', 'draft', '0', '0', '0%'],
        ['Spring launch 2', 'active', '98,431.20', '210,584', '2.15%'],
        ['Summer offer 2', 'active', '455.00', '902', '1.12%'],
        ['Back to school 2', 'paused', '7,001.00', '14,230', '2.66%'],
        ['Holiday gifts 2', 'active', '12.50', '31', '0.94%'],
      ].map(([name, state, spend, clicks, rate], index) => ({
        id: 'row-' + index,
        cells: {name, status: status[state](), spend, clicks, rate},
      }));
  return designSystemSection(
    'table',
    uiText('Table'),
    uiText(
      'The caption stays put while the columns scroll, and the header and first column stay in view. Choose the columns and the row density; below 40 rem of its own width each row becomes a card.',
    ),
    html`<div class="amcp-stack">${[
      designSystemSpecimen(
        uiText('Wide'),
        AmcpUI.table({
          id: 'ds-table',
          caption: uiText('Campaign results'),
          description: uiText('Last 30 days'),
          columns: columns(),
          rows: rows(),
        }),
      ),
      designSystemSpecimen(
        uiText('In a narrow space'),
        html`<div class="amcp-ds-narrow">${AmcpUI.table({id: 'ds-table-narrow', caption: uiText('Campaign results'), columns: columns(), rows: rows().slice(0, 3), chooser: false, densityToggle: false})}</div>`,
      ),
      designSystemSpecimen(
        uiText('Loading'),
        AmcpUI.table({
          id: 'ds-table-loading',
          caption: uiText('Campaign results'),
          columns: columns(),
          rows: [],
          state: 'loading',
          chooser: false,
          densityToggle: false,
        }),
      ),
      designSystemSpecimen(
        uiText('Empty'),
        AmcpUI.table({
          id: 'ds-table-empty',
          caption: uiText('Campaign results'),
          columns: columns(),
          rows: [],
          chooser: false,
          densityToggle: false,
          empty: {
            title: uiText('No campaigns match'),
            body: uiText('Change the filters to see more rows.'),
            action: {label: uiText('Clear the filters'), attrs: {type: 'button'}},
          },
        }),
      ),
      designSystemSpecimen(
        uiText('Could not load'),
        AmcpUI.table({
          id: 'ds-table-error',
          caption: uiText('Campaign results'),
          columns: columns(),
          rows: [],
          state: 'error',
          chooser: false,
          densityToggle: false,
          error: {
            title: uiText('The table could not load'),
            body: uiText('The platform did not answer in time.'),
            retry: {label: uiText('Try again')},
          },
        }),
      ),
    ]}</div>`,
  );
}

let designSystemToasts = null;
function designSystemOverlays() {
  const open = (action, label, variant = 'secondary') =>
    AmcpUI.button({label, variant, attrs: {'data-ds-action': action}});
  return designSystemSection(
    'overlays',
    uiText('Dialog, side sheet and toast'),
    uiText(
      'A dialog traps focus, makes the page behind it inert, closes on Escape and returns focus to the button that opened it. Toasts wait while the pointer or the keyboard is on them and never take focus.',
    ),
    html`<div class="amcp-stack">${[
      designSystemSpecimen(
        uiText('Dialog'),
        html`<div class="amcp-cluster">${[
          open('dialog-confirm', uiText('Confirm a deletion')),
          open('dialog-save', uiText('Save with an error first')),
        ]}</div>`,
      ),
      designSystemSpecimen(
        uiText('Side sheet'),
        html`<div class="amcp-cluster">${[
          open('sheet-modal', uiText('Open a details sheet')),
          open('sheet-side', uiText('Open a sheet beside the page')),
        ]}</div>`,
      ),
      designSystemSpecimen(
        uiText('Toast'),
        html`<div class="amcp-cluster">${[
          open('toast-success', uiText('Success')),
          open('toast-info', uiText('Information')),
          open('toast-warning', uiText('Warning')),
          open('toast-danger', uiText('Error')),
        ]}</div><div id="ds-toasts"></div>`,
      ),
    ]}</div>`,
  );
}
function designSystemToast(tone) {
  const messages = {
    success: () => uiText('The report was saved.'),
    info: () => uiText('A copy of the link is on your clipboard.'),
    warning: () => uiText('Some accounts returned partial data.'),
    danger: () => uiText('The export could not be made.'),
  };
  designSystemToasts?.show({
    tone,
    message: messages[tone](),
    action: tone === 'danger' ? {label: uiText('Try again')} : undefined,
  });
}
async function designSystemDialog(kind) {
  const retry = {tries: 0};
  if (kind === 'dialog-confirm') {
    const dialog = AmcpUI.dialog.open({
      title: uiText('Delete this report?'),
      body: uiText('The report is removed from the library. Its saved copies stay.'),
      role: 'alertdialog',
      size: 'sm',
      actions: [
        {label: uiText('Cancel'), value: 'cancel', initial: true},
        {label: uiText('Delete'), value: 'delete', variant: 'danger'},
      ],
    });
    const answer = await dialog.closed;
    designSystemToasts?.show({
      tone: answer === 'delete' ? 'success' : 'info',
      message: answer === 'delete' ? uiText('The report was deleted.') : uiText('Nothing was deleted.'),
    });
  } else if (kind === 'dialog-save') {
    const dialog = AmcpUI.dialog.open({
      title: uiText('Save the report'),
      body: html`<div class="amcp-stack">${AmcpUI.input({id: 'ds-dialog-name', label: uiText('Report name'), value: uiText('Weekly performance')})}</div>`,
      actions: [
        {label: uiText('Cancel'), value: 'cancel'},
        {label: uiText('Save'), value: 'save', variant: 'primary', keepOpen: true},
      ],
    });
    dialog.element.addEventListener('amcp-action', () => {
      dialog.setError(null);
      dialog.setLoading(true);
      setTimeout(() => {
        dialog.setLoading(false);
        if (++retry.tries === 1) dialog.setError(uiText('The report could not be saved. Try again.'));
        else dialog.close('save');
      }, 900);
    });
    if ((await dialog.closed) === 'save')
      designSystemToasts?.show({tone: 'success', message: uiText('The report was saved.')});
  } else {
    const modal = kind === 'sheet-modal',
      sheet = AmcpUI.sheet.open({
        title: uiText('Campaign details'),
        body: html`<div class="amcp-stack">${[
          AmcpUI.kpi({label: uiText('Spend'), value: '1,250.50', unit: 'USD', note: uiText('Last 30 days')}),
          AmcpUI.badge({label: uiText('Active'), tone: 'success'}),
        ]}</div>`,
        modal,
        actions: [{label: uiText('Done'), value: 'done', variant: 'primary'}],
      });
    await sheet.closed;
  }
}

function renderDesignSystem() {
  if (!session.authenticated) return showLogin();
  const sections = [
    designSystemButtons(),
    designSystemBadges(),
    designSystemChips(),
    designSystemFields(),
    designSystemChoosing(),
    designSystemCombobox(),
    designSystemTree(),
    designSystemTable(),
    designSystemFeedback(),
    designSystemCards(),
    designSystemOverlays(),
  ];
  const index = [
    ['buttons', uiText('Buttons')],
    ['badges', uiText('Badge')],
    ['chips', uiText('Filter chips')],
    ['fields', uiText('Fields')],
    ['choosing', uiText('Segmented control and tabs')],
    ['combobox', uiText('Searchable list')],
    ['tree', uiText('Scope tree')],
    ['table', uiText('Table')],
    ['feedback', uiText('Progress, loading and states')],
    ['cards', uiText('Cards')],
    ['overlays', uiText('Dialog, side sheet and toast')],
  ];
  setHtml(
    content,
    html`<div class="page-heading"><div><h1>${uiText('Design system')}</h1><p>${uiText('Every component in every state. Change the language and the appearance above to review both.')}</p></div></div><div class="amcp-surface amcp-ds" data-amcp="design-system"><div class="amcp-ds-layout"><nav class="amcp-ds-index" aria-label="${uiText('Components')}"><ul>${index.map(([id, name]) => html`<li><a href="#section-${id}">${name}</a></li>`)}</ul></nav><div class="amcp-ds-body">${sections}</div></div></div>`,
  );
  AmcpUI.bind(content);
  designSystemMount();
}
AMCP.routes.register('/design-system', {render: renderDesignSystem});
