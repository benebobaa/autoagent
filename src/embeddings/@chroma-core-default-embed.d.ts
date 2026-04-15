declare module '@chroma-core/default-embed' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const DefaultEmbeddingFunction: new (...args: any[]) => {
    (texts: string[]): Promise<number[][]>;
  };
  export { DefaultEmbeddingFunction };
}
