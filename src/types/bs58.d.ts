declare module 'bs58' {
  const bs58: {
    encode: (buffer: Uint8Array | number[]) => string;
    decode: (string: string) => Uint8Array;
  };
  export = bs58;
}
