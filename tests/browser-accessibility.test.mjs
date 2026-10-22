import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accessibilityTreeSummary,
  accessibilityProblems,
  inspectBrowserAccessibility,
  startOverflowProblems,
  variantColourProblems,
  focusIndicatorTargets,
} from '../tools/browser-accessibility.mjs';

const node = (role, name, extra = {}) => ({
  ignored: false,
  role: {type: 'role', value: role},
  name: {type: 'computedString', value: name},
  ...extra,
});
const heading = level =>
  node('heading', 'Original heading', {properties: [{name: 'level', value: {type: 'integer', value: level}}]});
const valid = () => [
  node('main', ''),
  heading(1),
  node('button', 'Original action'),
  node('textbox', 'Original field'),
];
const ids = {missing_references: [], duplicate_ids: []};

test('Chromium semantics retain literal names/identities and ignore hidden controls', () => {
  const nodes = [
    ...valid(),
    node('checkbox', 'Original 9007199254740993 <label>'),
    {...node('button', ''), ignored: true},
    node('StaticText', ''),
  ];
  const before = structuredClone(nodes),
    summary = accessibilityTreeSummary(nodes);
  assert.equal(summary.exposed_nodes, 6);
  assert.equal(summary.interactive_controls, 3);
  assert.equal(summary.main_count, 1);
  assert.equal(summary.primary_heading_count, 1);
  assert.deepEqual(accessibilityProblems({...summary, ...ids}), []);
  assert.deepEqual(nodes, before);
  assert.throws(() => accessibilityTreeSummary(undefined), /node list/);
});

test('exposed blank controls and dialogs refuse without echoing names or values', () => {
  const nodes = [
    ...valid(),
    node('link', '   ', {backendDOMNodeId: 27}),
    node('DisclosureTriangle', ''),
    node('dialog', ''),
    node('alertdialog', ''),
  ];
  const summary = accessibilityTreeSummary(nodes);
  assert.deepEqual(summary.unnamed_controls, [
    {role: 'link', backend_dom_node: 27},
    {role: 'DisclosureTriangle', backend_dom_node: null},
    {role: 'dialog', backend_dom_node: null},
    {role: 'alertdialog', backend_dom_node: null},
  ]);
  assert.deepEqual(accessibilityProblems({...summary, ...ids}), ['Unnamed accessibility controls: 4']);
});

test('initial landmarks and final modal boundaries keep ID/name refusals independent', () => {
  const missing = {
    ...accessibilityTreeSummary([heading(2), node('dialog', 'Original modal'), node('button', 'Original close')]),
    ...ids,
  };
  assert.deepEqual(accessibilityProblems(missing), [
    'Expected one exposed main landmark, observed 0',
    'Expected one exposed primary heading, observed 0',
  ]);
  assert.deepEqual(accessibilityProblems(missing, {requireLandmarks: false}), []);
  const invalid = {
    ...missing,
    missing_references: [{element: 'Original', attribute: 'aria-describedby', reference: 'missing'}],
    duplicate_ids: [{id: 'Original', count: 2}],
  };
  assert.deepEqual(accessibilityProblems(invalid, {requireLandmarks: false}), [
    'Unresolved ARIA ID references: 1',
    'Duplicate HTML IDs: 1',
  ]);
  const duplicated = {...accessibilityTreeSummary([...valid(), node('main', ''), heading(1)]), ...ids};
  assert.deepEqual(accessibilityProblems(duplicated), [
    'Expected one exposed main landmark, observed 2',
    'Expected one exposed primary heading, observed 2',
  ]);
});

// Design review 2026-10: a right-aligned action row that did not wrap put Reporting's "New report" at -114 px on a
// 375 px phone; the page cannot scroll to its start side, and the end-side reflow check (scrollWidth) never saw it.
test('a control past the page start is out of reach unless a scroll region holds it, in either direction', () => {
  const control = (left, right, extra = {}) => ({control: 'button#x', left, right, in_scroll_region: false, ...extra});
  assert.deepEqual(
    startOverflowProblems({width: 375, rtl: false, controls: [control(-114, -10), control(0, 375), control(10, 380)]}),
    ["button#x lies past the page's start edge (-114 to -10 of 375 px)"],
  );
  // A horizontally scrolling region (a wide table) brings its own controls into view.
  assert.deepEqual(
    startOverflowProblems({width: 375, rtl: false, controls: [control(-300, -200, {in_scroll_region: true})]}),
    [],
  );
  // Right to left, the start edge is the right one; past the left edge is the end side.
  assert.deepEqual(startOverflowProblems({width: 375, rtl: true, controls: [control(-50, 40)]}), []);
  assert.equal(startOverflowProblems({width: 375, rtl: true, controls: [control(300, 420)]}).length, 1);
  assert.deepEqual(startOverflowProblems(undefined), []);
});

// Design review 2026-10: in the dark theme every primary and danger button rendered like a plain button and status
// badges lost their tone, because a shared dark group of theme.css outranked the variants.
test('a variant coloured exactly like its plain counterpart is a problem; an absent variant is not measured', () => {
  const plain = {color: 'rgb(242, 237, 248)', background: 'rgb(37, 32, 50)', border: 'rgb(81, 71, 95)'};
  assert.deepEqual(
    variantColourProblems({plain, primary: plain, danger: plain, online: plain, attention: plain, offline: plain}),
    [
      'A primary button is coloured like a plain button',
      'A danger button is coloured like a plain button',
      'An online status badge has the neutral badge’s colours',
      'An attention status badge has the neutral badge’s colours',
    ],
  );
  assert.deepEqual(
    variantColourProblems({
      plain,
      primary: {...plain, color: 'rgb(33, 23, 47)', background: 'rgb(199, 173, 255)'},
      danger: {...plain, color: 'rgb(255, 182, 191)', border: 'rgb(255, 182, 191)'},
      online: {...plain, background: 'rgb(24, 56, 46)'},
      attention: {...plain, background: 'rgb(61, 46, 25)'},
      offline: plain,
    }),
    [],
  );
  assert.deepEqual(variantColourProblems({plain, primary: null, danger: null}), []);
  // Every rendered case also measures the closing band's call to action and a focusable command block.
  assert.ok(focusIndicatorTargets.some(t => t.selector === '.closing-note a[href]'));
  assert.ok(focusIndicatorTargets.some(t => t.selector === 'main pre.code-block'));
});

test('a refused Chromium inspection detaches its session and never evaluates the page', async () => {
  for (const failure of ['Accessibility.enable', 'Accessibility.getFullAXTree', 'Accessibility.disable']) {
    const calls = [];
    let evaluated = false,
      detached = 0;
    const page = {
      context: () => ({
        newCDPSession: async selected => {
          assert.equal(selected, page);
          return {
            send: async method => {
              calls.push(method);
              if (method === failure) throw Error('Original inspection refusal');
              return {};
            },
            detach: async () => {
              detached++;
            },
          };
        },
      }),
      evaluate: async () => {
        evaluated = true;
      },
    };
    await assert.rejects(inspectBrowserAccessibility(page), /Original inspection refusal/);
    assert.equal(detached, 1);
    assert.equal(evaluated, false);
    assert.deepEqual(
      calls,
      failure === 'Accessibility.enable'
        ? ['Accessibility.enable']
        : ['Accessibility.enable', 'Accessibility.getFullAXTree', 'Accessibility.disable'],
    );
  }
});
