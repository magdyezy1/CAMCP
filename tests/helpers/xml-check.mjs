// A small well-formedness check and parser for the SVG a chart renders, with no dependency: tags open and close in order,
// attributes are quoted and free of markup characters, text holds no markup and no bare ampersand, one root. It is not a
// general XML parser (it has no DTDs, CDATA or namespaces), which is exactly why it is a good check for generated output:
// anything it cannot read is something the renderer should not have written.

const name = '[A-Za-z][\\w:-]*';
const attribute = '\\s+[A-Za-z_:][\\w:.-]*\\s*=\\s*(?:"[^"<]*"|\'[^\'<]*\')';
const token = new RegExp(
  `<!--[\\s\\S]*?-->|<\\/(${name})\\s*>|<(${name})((?:${attribute})*)\\s*(\\/?)>|([^<]+)|(<)`,
  'y',
);
const entity = /&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/y;

function checkText(text) {
  for (let at = text.indexOf('&'); at !== -1; at = text.indexOf('&', at + 1)) {
    entity.lastIndex = at;
    if (!entity.test(text))
      throw new Error('a bare ampersand in ' + JSON.stringify(text.slice(Math.max(0, at - 20), at + 20)));
  }
}
function attributesOf(source) {
  const attrs = {};
  for (const match of source.matchAll(/\s+([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g)) {
    const value = match[2] ?? match[3];
    checkText(value);
    if (Object.hasOwn(attrs, match[1])) throw new Error('attribute ' + match[1] + ' twice');
    attrs[match[1]] = value;
  }
  return attrs;
}

/** The element tree of a document: `{name, attrs, children, text}`, where `text` is the element's own text, entities kept. */
export function parseXml(source) {
  const root = {name: '#document', attrs: {}, children: [], text: ''},
    stack = [root];
  token.lastIndex = 0;
  while (token.lastIndex < source.length) {
    const match = token.exec(source);
    if (!match)
      throw new Error('unreadable markup at ' + JSON.stringify(source.slice(token.lastIndex, token.lastIndex + 40)));
    const [, close, open, attributes, selfClosing, text, stray] = match;
    if (stray)
      throw new Error(
        'a markup character that starts no tag at ' + JSON.stringify(source.slice(match.index, match.index + 40)),
      );
    if (text !== undefined) {
      checkText(text);
      stack.at(-1).text += text;
    } else if (open) {
      const element = {name: open, attrs: attributesOf(attributes), children: [], text: ''};
      stack.at(-1).children.push(element);
      if (!selfClosing) stack.push(element);
    } else if (close) {
      if (stack.length < 2 || stack.at(-1).name !== close)
        throw new Error('</' + close + '> closes ' + stack.at(-1).name);
      stack.pop();
    }
  }
  if (stack.length !== 1) throw new Error('<' + stack.at(-1).name + '> is never closed');
  if (root.children.length !== 1) throw new Error('a document has one root element, this has ' + root.children.length);
  if (root.text.trim()) throw new Error('text outside the root element');
  return root.children[0];
}
/** Every element of a tree, in document order. */
export function elementsOf(tree, wanted) {
  const found = [];
  const walk = element => {
    if (!wanted || element.name === wanted) found.push(element);
    for (const child of element.children) walk(child);
  };
  walk(tree);
  return found;
}
/** The text a reader gets from an element, with its entities decoded. */
export const textOf = element =>
  element.text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
