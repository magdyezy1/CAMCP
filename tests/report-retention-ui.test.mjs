// SEC-07, owner decision P3 (2026-10-11): report records follow a retention per document kind with a deployment
// default. Before this change Settings said saving a period "enables automatic cleanup", and a workspace without a saved
// period kept every report record forever without saying so. Settings now names the period in force and where it
// comes from. The real web/owner-operations.js function runs in a VM; no server is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

const source = readFileSync('web/owner-operations.js', 'utf8');
const slice = (from, to) => {
  const start = source.indexOf(from),
    end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'web/owner-operations.js still defines ' + from);
  return source.slice(start, end);
};

test('P3: Settings names the report retention in force: the workspace period, the deployment default, or off', () => {
  const context = createContext({
    uiText: (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, k) => values[k] ?? ''),
    uiNumber: n => String(n),
    esc: String,
  });
  new Script(slice('function ownerReportRetention(', '// WRT-05')).runInContext(context);
  const render = value => new Script('ownerReportRetention(' + JSON.stringify(value) + ')').runInContext(context);
  assert.match(
    render({days: 30, source: 'workspace'}),
    /In force: finished report records of this workspace are deleted after 30 days\./,
  );
  assert.match(
    render({days: 365, source: 'deployment_default'}),
    /until you save a period, finished report records are deleted after 365 days, the default of this deployment\./,
  );
  assert.match(render({days: null, source: 'off'}), /Automatic report cleanup is off on this deployment/);
  assert.equal(render(null), '', 'an older server without the field shows nothing');
  // The form's note no longer claims that saving is what turns cleanup on.
  assert.doesNotMatch(source, /Saving enables automatic cleanup after this period/);
  assert.match(source, /Saving sets this workspace’s own period in place of the deployment default\./);
  // Regression (wave 3a review): without a saved period the field was prefilled with the deployment default capped at
  // 365 days, so saving the form unchanged shortened a longer deployment default. It starts empty (and required) now.
  assert.doesNotMatch(source, /Math\.min\(365, h\.report_retention/);
  assert.match(
    source,
    /name="days" type="number" min="7" max="365" value="\$\{Number\.isInteger\(h\.retention\?\.days\) \? h\.retention\.days : ''\}" required/,
  );
});
