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
  html`<section class="amcp-ds-section" id="ds-${id}" aria-labelledby="ds-${id}-title" tabindex="-1"><h2 class="amcp-ds-title" id="ds-${id}-title">${title}</h2><div class="amcp-ds-intro">${intro}</div>${body}</section>`;

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
    html`<div class="amcp-ds-specimens">${tones.map(([tone, name]) => designSystemSpecimen(name(), AmcpUI.badge({label: name(), tone})))}</div>`,
  );
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

function renderDesignSystem() {
  if (!session.authenticated) return showLogin();
  const sections = [
    designSystemButtons(),
    designSystemBadges(),
    designSystemChips(),
    designSystemFields(),
    designSystemFeedback(),
    designSystemCards(),
  ];
  const index = [
    ['buttons', uiText('Buttons')],
    ['badges', uiText('Badge')],
    ['chips', uiText('Filter chips')],
    ['fields', uiText('Fields')],
    ['feedback', uiText('Progress, loading and states')],
    ['cards', uiText('Cards')],
  ];
  setHtml(
    content,
    html`<div class="page-heading"><div><h1>${uiText('Design system')}</h1><p>${uiText('Every component in every state. Change the language and the appearance above to review both.')}</p></div></div><div class="amcp-surface amcp-ds"><div class="amcp-ds-layout"><nav class="amcp-ds-index" aria-label="${uiText('Components')}"><ul>${index.map(([id, name]) => html`<li><a href="#ds-${id}">${name}</a></li>`)}</ul></nav><div class="amcp-ds-body">${sections}</div></div></div>`,
  );
  AmcpUI.bind(content);
}
AMCP.routes.register('/design-system', {render: renderDesignSystem});
