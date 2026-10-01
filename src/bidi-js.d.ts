declare module 'bidi-js' {
  type Embedding = {levels: Uint8Array; paragraphs: {start: number; end: number; level: number}[]};
  export default function bidiFactory(): {
    getEmbeddingLevels(text: string, direction?: 'ltr' | 'rtl'): Embedding;
    getReorderedIndices(text: string, embedding: Embedding, start?: number, end?: number): number[];
    getMirroredCharactersMap(text: string, levels: Uint8Array, start?: number, end?: number): Map<number, string>;
  };
}
