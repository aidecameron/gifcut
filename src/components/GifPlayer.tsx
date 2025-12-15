import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GifFrame } from '../types';
import { invoke } from '@tauri-apps/api/tauri';

// 通过 Tauri 命令读取文件并创建 Blob URL
const loadImageAsBlob = async (filePath: string): Promise<string> => {
  try {
    const bytes = await invoke<number[]>('read_file_bytes', { path: filePath });
    const uint8Array = new Uint8Array(bytes);
    const blob = new Blob([uint8Array], { type: 'image/gif' });
    return URL.createObjectURL(blob);
  } catch (err) {
    throw new Error(`Failed to load image: ${err}`);
  }
};

interface GifPlayerProps {
  frames: GifFrame[];
  width: number;
  height: number;
  currentFrame?: number; // 外部控制的当前帧
  isPlaying?: boolean; // 外部控制的播放状态
  onFrameChange?: (frameIndex: number) => void;
  onPlayingChange?: (isPlaying: boolean) => void;
  onPreview?: (opts: { loop: boolean }) => void;
  initialLoop?: boolean;
  fullSize?: boolean;
  hideControls?: boolean;
  fullframesDir?: string; // 全尺寸帧目录
}

/**
 * GIF 播放器组件
 * 支持播放、暂停、跳转到指定帧
 */
export const GifPlayer: React.FC<GifPlayerProps> = ({
  frames,
  width,
  height,
  currentFrame: externalCurrentFrame,
  isPlaying: externalIsPlaying,
  onFrameChange,
  onPlayingChange,
  onPreview,
  initialLoop,
  fullSize,
  hideControls,
  fullframesDir,
}) => {
  const { t } = useTranslation();
  // dimensions no longer used in compact info; keep width/height via props
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bufferCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [renderTick, setRenderTick] = useState(0);
  const [internalCurrentFrame, setInternalCurrentFrame] = useState(0);
  const [internalIsPlaying, setInternalIsPlaying] = useState(true);
  const [loop, setLoop] = useState(initialLoop ?? false);
  const animationRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);
  
  // 预读缓存
  const preloadCacheRef = useRef<Map<number, HTMLImageElement>>(new Map());
  const preloadingRef = useRef<Set<number>>(new Set());

  // 使用外部状态或内部状态
  const currentFrame = externalCurrentFrame !== undefined ? externalCurrentFrame : internalCurrentFrame;
  const isPlaying = externalIsPlaying !== undefined ? externalIsPlaying : internalIsPlaying;
  
  // 预读函数 - 预读接下来的 N 帧
  const preloadFrames = async (startFrame: number, count: number = 5) => {
    if (!fullframesDir) return;
    
    for (let i = 0; i < count; i++) {
      const frameIdx = (startFrame + i) % frames.length;
      
      // 如果已经在缓存中或正在加载，跳过
      if (preloadCacheRef.current.has(frameIdx) || preloadingRef.current.has(frameIdx)) {
        continue;
      }
      
      preloadingRef.current.add(frameIdx);
      
      try {
        const framePath1 = `${fullframesDir}/frame.${String(frameIdx).padStart(3, '0')}`;
        const framePath2 = `${fullframesDir}/frame.${frameIdx}`;
        
        let blobUrl: string | null = null;
        try {
          blobUrl = await loadImageAsBlob(framePath1);
        } catch {
          try {
            blobUrl = await loadImageAsBlob(framePath2);
          } catch {
            // 文件不存在，跳过
            preloadingRef.current.delete(frameIdx);
            continue;
          }
        }
        
        if (blobUrl) {
          const url = blobUrl;
          const img = new Image();
          await new Promise<void>((resolve, reject) => {
            img.onload = () => {
              preloadCacheRef.current.set(frameIdx, img);
              // 保持缓存大小在合理范围内（最多20帧）
              if (preloadCacheRef.current.size > 20) {
                const firstKey = preloadCacheRef.current.keys().next().value as number | undefined;
                if (firstKey !== undefined) {
                  const oldImg = preloadCacheRef.current.get(firstKey);
                  if (oldImg && oldImg.src.startsWith('blob:')) {
                    URL.revokeObjectURL(oldImg.src);
                  }
                  preloadCacheRef.current.delete(firstKey);
                }
              }
              resolve();
            };
            img.onerror = () => {
              URL.revokeObjectURL(url);
              reject();
            };
            img.src = url;
          });
        }
      } catch (err) {
        // 预读失败，静默处理
      } finally {
        preloadingRef.current.delete(frameIdx);
      }
    }
  };

  useEffect(() => {
    if (frames.length === 0) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 异步渲染帧
    const renderFrame = async () => {
      let frame: GifFrame | null = null;
      
      // 如果提供了 fullframesDir，从文件系统加载全尺寸帧
      if (fullframesDir) {
        // 先检查预读缓存
        const cachedImg = preloadCacheRef.current.get(currentFrame);
        if (cachedImg) {
          ctx.imageSmoothingEnabled = false;
          ctx.clearRect(0, 0, width, height);
          ctx.drawImage(cachedImg, 0, 0, width, height);
          
          // 触发下一批预读
          if (isPlaying) {
            preloadFrames(currentFrame + 1, 5).catch(() => {});
          }
          return;
        }
        
        try {
          const framePath1 = `${fullframesDir}/frame.${String(currentFrame).padStart(3, '0')}`;
          const framePath2 = `${fullframesDir}/frame.${currentFrame}`;
          
          let blobUrl: string | null = null;
          try {
            blobUrl = await loadImageAsBlob(framePath1);
          } catch (err1) {
            try {
              blobUrl = await loadImageAsBlob(framePath2);
            } catch (err2) {
              // 文件不存在，等待后台线程解压
              if (currentFrame < 5) {
                console.log(`[TEMP_DEBUG] 帧 ${currentFrame} 加载失败:`, framePath1, err1, framePath2, err2);
              }
              frame = frames[currentFrame]; // 使用占位帧
            }
          }
          
          if (blobUrl) {
            const url = blobUrl;
            const img = new Image();
            await new Promise<void>((resolve, reject) => {
              img.onload = () => {
                ctx.imageSmoothingEnabled = false;
                ctx.clearRect(0, 0, width, height);
                ctx.drawImage(img, 0, 0, width, height);
                
                // 将这帧加入缓存
                preloadCacheRef.current.set(currentFrame, img);
                
                // 触发下一批预读
                if (isPlaying) {
                  preloadFrames(currentFrame + 1, 5).catch(() => {});
                }
                
                resolve();
              };
              img.onerror = () => {
                URL.revokeObjectURL(url);
                reject();
              };
              img.src = url;
            });
            return; // 成功渲染，直接返回
          }
        } catch (err) {
          // 加载失败，使用占位帧
          frame = frames[currentFrame];
        }
      } else {
        // 否则使用 frames 数组中的帧（传统模式）
        frame = frames[currentFrame];
      }
      
      if (frame) {
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, width, height);
        
        // 优先使用全尺寸数据 (imageData)
        if (frame.imageData && frame.imageData.width > 1) {
          const buf = bufferCanvasRef.current || document.createElement('canvas');
          bufferCanvasRef.current = buf;
          const fw = frame.imageData.width;
          const fh = frame.imageData.height;
          if (buf.width !== fw || buf.height !== fh) {
            buf.width = fw;
            buf.height = fh;
          }
          const bctx = buf.getContext('2d');
          if (bctx) {
            bctx.putImageData(frame.imageData, 0, 0);
            ctx.drawImage(buf, 0, 0, width, height);
          }
        } else if (frame.canvas && frame.canvas.width > 1 && frame.canvas.height > 1) {
          // 降级使用预览 canvas
          ctx.drawImage(frame.canvas, 0, 0, width, height);
        } else {
          // 占位帧，显示加载提示
          ctx.fillStyle = '#f0f0f0';
          ctx.fillRect(0, 0, width, height);
          ctx.fillStyle = '#666';
          ctx.font = '14px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(t('common.loading'), width / 2, height / 2);
        }
      } else {
        // 帧还在加载中或不存在，显示加载提示
        ctx.fillStyle = '#f0f0f0';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#666';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(t('common.loading'), width / 2, height / 2);
      }
    };

    renderFrame();

    // 通知父组件帧变化
    if (onFrameChange) {
      onFrameChange(currentFrame);
    }
  }, [currentFrame, frames, width, height, onFrameChange, renderTick, fullframesDir]);

  // 清理预读缓存
  useEffect(() => {
    return () => {
      // 组件卸载时清理所有预读的 blob URLs
      preloadCacheRef.current.forEach((img) => {
        if (img.src.startsWith('blob:')) {
          URL.revokeObjectURL(img.src);
        }
      });
      preloadCacheRef.current.clear();
    };
  }, []);
  
  // 定期重试加载失败的帧
  useEffect(() => {
    if (!fullframesDir) return;
    
    const interval = setInterval(() => {
      // 检查当前帧是否已加载
      if (!preloadCacheRef.current.has(currentFrame) && !preloadingRef.current.has(currentFrame)) {
        // 触发重新渲染，尝试重新加载
        setRenderTick(t => t + 1);
      }
    }, 2000); // 每2秒检查一次
    
    return () => clearInterval(interval);
  }, [fullframesDir, currentFrame]);
  
  useEffect(() => {
    if (!isPlaying || frames.length === 0) {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
      return;
    }
    
    // 播放开始时，触发初始预读
    if (fullframesDir) {
      preloadFrames(currentFrame, 10).catch(() => {});
    }

    let startTime = performance.now();
    lastFrameTimeRef.current = startTime;

    const animate = (currentTime: number) => {
      const elapsed = currentTime - lastFrameTimeRef.current;
      const frame = frames[currentFrame];

      if (elapsed >= frame.delay) {
        // 计算下一帧或结束播放
        if (!loop && currentFrame + 1 >= frames.length) {
          // 播放到末尾后停止
          if (externalIsPlaying !== undefined && onPlayingChange) {
            onPlayingChange(false);
          } else {
            setInternalIsPlaying(false);
          }
          animationRef.current = null;
          return;
        } else {
          const nextFrame = loop ? (currentFrame + 1) % frames.length : currentFrame + 1;
          
          // 如果使用外部状态，通过回调更新
          if (externalCurrentFrame !== undefined && onFrameChange) {
            onFrameChange(nextFrame);
          } else {
            setInternalCurrentFrame(nextFrame);
          }
          lastFrameTimeRef.current = currentTime;
        }
      }

      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [isPlaying, currentFrame, frames, externalCurrentFrame, onFrameChange, loop, externalIsPlaying]);

  const togglePlay = () => {
    const newPlayingState = !isPlaying;
    
    // 如果使用外部状态，通过回调更新
    if (externalIsPlaying !== undefined && onPlayingChange) {
      onPlayingChange(newPlayingState);
    } else {
      setInternalIsPlaying(newPlayingState);
    }
  };

  // 计算时间信息
  const totalTime = frames.reduce((sum, frame) => sum + frame.delay, 0);
  const elapsedTime = frames.slice(0, currentFrame).reduce((sum, frame) => sum + frame.delay, 0);
  const remainingTime = totalTime - elapsedTime;

  // 格式化时间显示（毫秒 -> 秒.毫秒）
  const formatTime = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const milliseconds = ms % 1000;
    return `${seconds}.${milliseconds.toString().padStart(3, '0')}s`;
  };

  return (
    <div className="gif-player">
      <div className="player-canvas-container">
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          style={{
            border: fullSize ? 'none' : '1px solid #ccc',
            maxWidth: fullSize ? 'none' : '100%',
            height: fullSize ? undefined : 'auto',
            maxHeight: fullSize ? 'none' : undefined,
            imageRendering: 'pixelated',
          }}
        />
      </div>

      {/* 时间信息和控制 */}
      {hideControls ? null : (
        <div className="time-info-display">
          <button onClick={togglePlay} className="control-button play-button" title={isPlaying ? t('player.pause') : t('player.play')}>
            {isPlaying ? '⏸' : '▶'}
          </button>
          <button onClick={() => onPreview && onPreview({ loop })} className="control-button play-button" title={t('player.preview')}>
            🖼️
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.8rem' }}>
            <input
              type="checkbox"
              checked={loop}
              onChange={(e) => setLoop(e.target.checked)}
            />
            {t('player.loop')}
          </label>
          <div className="file-info-compact">
            {t('player.frames', { current: currentFrame + 1, total: frames.length })}
          </div>
          <div className="time-item-group" style={{ marginLeft: 'auto', display: 'flex', gap: '12px' }}>
            <div className="time-item">
              <span className="time-label">{t('player.played')}</span>
              <span className="time-value">{formatTime(elapsedTime)}</span>
            </div>
            <div className="time-item">
              <span className="time-label">{t('player.remaining')}</span>
              <span className="time-value">{formatTime(remainingTime)}</span>
            </div>
            <div className="time-item">
              <span className="time-label">{t('player.total')}</span>
              <span className="time-value">{formatTime(totalTime)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
