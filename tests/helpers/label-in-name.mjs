// WCAG 2.5.3 Label in Name, read as the browser qualification reads it (axe-core's label-content-name-mismatch): the words
// a control shows are contained, in order, in its accessible name. Both are compared without case, punctuation, symbols
// (an arrow glyph is not a word) and spacing. A control that shows no word has nothing to be contained.

/** The words of a text, as the comparison sees them. */
export const curate = text =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Whether the accessible name holds the visible words. A visible text with no words is not a mismatch. */
export function nameContainsLabel(name, visible) {
  const words = curate(visible);
  return words === '' || curate(name).includes(words);
}

/** The text of an attribute value or element content that the page's escaping made into character references. */
export const decodeMarkup = markup =>
  String(markup)
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
