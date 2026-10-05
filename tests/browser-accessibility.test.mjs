import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accessibilityTreeSummary,
  accessibilityProblems,
  inspectBrowserAccessibility,
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
