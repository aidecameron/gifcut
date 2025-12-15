declare module 'omggif' {
  export class GifReader {
    constructor(buf: Uint8Array);
    width: number;
    height: number;
    numFrames(): number;
    frameInfo(frameNum: number): {
      x: number;
      y: number;
      width: number;
      height: number;
      has_local_palette: boolean;
      palette_offset: number;
      palette_size: number;
      data_offset: number;
      data_length: number;
      transparent_index: number | null;
      interlaced: boolean;
      delay: number;
      disposal: number;
    };
    decodeAndBlitFrameRGBA(
      frameNum: number,
      pixels: Uint8ClampedArray
    ): void;
  }

  export class GifWriter {
    constructor(buf: Uint8Array, width: number, height: number, options?: {
      loop?: number;
      palette?: Uint8Array;
    });
    addFrame(
      x: number,
      y: number,
      w: number,
      h: number,
      indexed_pixels: Uint8Array,
      options?: {
        palette?: Uint8Array;
        delay?: number;
        disposal?: number;
        transparent?: number;
      }
    ): void;
    end(): number;
  }
}

