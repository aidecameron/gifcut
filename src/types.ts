
export interface GifFrame {
  imageData: ImageData;
  delay: number; // 延迟时间（毫秒）
  index: number;
  canvas: HTMLCanvasElement; // 用于预览的 canvas
}
