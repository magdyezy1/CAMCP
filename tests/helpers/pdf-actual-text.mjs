import {inflateSync} from 'node:zlib';

/** Accessible text retained by the real PDF renderer, including UTF-16 Arabic ActualText spans. */
export function pdfActualText(bytes) {
  const raw = bytes.toString('latin1'),
    streams = [...raw.matchAll(/<<[^]*?\/Length (\d+)\s*\/Filter \/FlateDecode\s*>>\s*stream\r?\n/g)].map(match =>
      inflateSync(bytes.subarray(match.index + match[0].length, match.index + match[0].length + Number(match[1]))),
    );
  return streams
    .flatMap(stream =>
      [...stream.toString('latin1').matchAll(/\/ActualText\s*\(((?:\\[\s\S]|[^\\)])*)\)/g)].map(match => {
        const literal = match[1].replace(
            /\\([\\()nrtbf])/g,
            (_, value) => ({n: '\n', r: '\r', t: '\t', b: '\b', f: '\f'})[value] ?? value,
          ),
          value = Buffer.from(literal, 'latin1');
        return value[0] === 254 && value[1] === 255 ? value.subarray(2).swap16().toString('utf16le') : literal;
      }),
    )
    .join(' ')
    .replace(/\s+/gu, ' ');
}
