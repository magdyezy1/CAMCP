// WEB-05: the website serves English and Arabic from one set of stylesheets, so a side is named by its logical
// direction (start/end, inline/block) and the same rule is right in both. A physical left/right declaration is refused
// unless it is listed here with the reason it must stay physical. Transforms have no logical form and are not covered;
// html[dir='rtl'] rules in localization.css carry them.
export const physicalAllowed = new Map([
  // 'file|selector|declaration' -> reason
]);
const physicalProperty =
  /^(?:margin|padding|scroll-margin|scroll-padding)-(?:left|right)$|^(?:left|right)$|^border-(?:left|right)(?:-(?:width|style|color))?$|^border-(?:top|bottom)-(?:left|right)-radius$/;
const physicalValue = {'text-align': /^(?:left|right)\b/, float: /^(?:left|right)\b/, clear: /^(?:left|right)\b/};
const sides = value => value.trim().split(/\s+(?![^(]*\))/);
/** The reason a declaration is physical, or null when it reads the same in both directions. */
export function physicalReason(property, value) {
  property = property.trim().toLowerCase();
  value = value.replace(/!important\s*$/, '').trim();
  if (physicalProperty.test(property)) return property + ' names a physical side';
  if (physicalValue[property]?.test(value)) return property + ': ' + value + ' names a physical side';
  if (['margin', 'padding', 'inset', 'border-width', 'border-style', 'border-color'].includes(property)) {
    const v = sides(value);
    if (v.length === 4 && v[1] !== v[3]) return property + ' has different left and right values';
  }
  if (property === 'border-radius') {
    const v = sides(value);
    if (value.includes('/') || (v.length >= 3 && v[0] !== v[1]) || (v.length === 4 && v[2] !== v[3]))
      return 'border-radius has different left and right corners';
  }
  return null;
}
/** Every physical left/right declaration in a stylesheet that is not allow-listed, as "file:line: ..." problems. */
export function rtlProblems(css, file) {
  const problems = [],
    selectors = [];
  let buffer = '',
    line = 1,
    start = 1;
  const text = css.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '));
  const declaration = () => {
    const colon = buffer.indexOf(':');
    if (colon > 0 && selectors.length) {
      const property = buffer.slice(0, colon).trim(),
        value = buffer.slice(colon + 1).trim(),
        selector = selectors.at(-1),
        reason = physicalReason(property, value);
      if (reason && !physicalAllowed.has(file + '|' + selector + '|' + property + ': ' + value))
        problems.push(
          file +
            ':' +
            start +
            ': ' +
            selector +
            ' { ' +
            property +
            ': ' +
            value +
            ' } — ' +
            reason +
            '; use the logical property',
        );
    }
    buffer = '';
  };
  for (const char of text) {
    if (char === '{') {
      selectors.push(buffer.trim().replace(/\s+/g, ' '));
      buffer = '';
    } else if (char === '}') {
      if (buffer.trim()) declaration();
      selectors.pop();
      buffer = '';
    } else if (char === ';') declaration();
    else {
      if (!buffer.trim() && char.trim()) start = line;
      buffer += char;
    }
    if (char === '\n') line++;
  }
  return problems;
}
// Account names, logins and IDs in running markup go through the isolating helpers (accountHtml, accountLabelHtml,
// recordAccountLabelHtml), so an English name or a numeric ID keeps its order inside Arabic text. Option labels are
// plain text and keep the text helpers.
export function accountMarkupProblems(source, file) {
  const problems = [];
  for (const m of source.matchAll(/esc\((accountText|accountLabel|recordAccountLabel)\(/g)) {
    const tag = source.lastIndexOf('<', m.index);
    if (tag >= 0 && /^<option\b/.test(source.slice(tag))) continue;
    problems.push(
      file +
        ':' +
        source.slice(0, m.index).split('\n').length +
        ': ' +
        m[1] +
        ' in markup; use ' +
        (m[1] === 'accountText' ? 'accountHtml' : m[1] + 'Html') +
        ' so the name and ID are isolated',
    );
  }
  return problems;
}
