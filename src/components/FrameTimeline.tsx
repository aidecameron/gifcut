import React, { useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/tauri';
import { GifFrame } from '../types';

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

interface FrameTimelineProps {
  frames: GifFrame[];
  currentFrame: number;
  onFrameSelect: (index: number) => void;
  rangeStart?: number;
  rangeEnd?: number;
  previewsDir?: string;
}

/**
 * 帧时间轴组件
 * 所有帧堆叠显示，当前帧及前后各一帧完全展开，支持拖动游标选择帧
 */
export const FrameTimeline: React.FC<FrameTimelineProps> = ({
  frames,
  currentFrame,
  onFrameSelect,
  rangeStart = 0,
  rangeEnd = frames.length - 1,
  previewsDir,
}) => {
  const { t } = useTranslation();
  const timelineContainerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [scrubberPosition, setScrubberPosition] = useState(0);
  const rafIdRef = useRef<number | null>(null);
  const pendingXRef = useRef<number | null>(null);
  const canvasMapRef = useRef<Map<number, HTMLCanvasElement>>(new Map());

  // 获取范围内的帧数
  const rangeFrameCount = rangeEnd - rangeStart + 1;

  // 确保 currentFrame 有效
  const safeCurrentFrame = Math.max(0, Math.min(currentFrame, frames.length - 1));

  // 计算游标位置（基于当前帧在范围内的相对位置）
  const calculateScrubberPosition = useCallback((): number => {
    if (!timelineContainerRef.current || rangeFrameCount === 0) return 0;
    
    const containerWidth = timelineContainerRef.current.clientWidth;
    const leftPadding = 5; // 左侧留白，让游标能滑到左边
    const rightPadding = 120; // 右侧留白，避免尾帧缩略图被截掉
    const trackWidth = containerWidth - leftPadding - rightPadding;
    
    // 计算当前帧在范围内的相对位置
    const relativeFrame = Math.max(0, Math.min(rangeFrameCount - 1, safeCurrentFrame - rangeStart));
    
    // 如果只有一帧，直接返回 leftPadding 位置
    if (rangeFrameCount <= 1) {
      return leftPadding;
    }
    
    // 计算位置：第一帧在 leftPadding 位置，最后一帧在 containerWidth - rightPadding 位置
    const position = (relativeFrame / (rangeFrameCount - 1)) * trackWidth + leftPadding;
    
    return position;
  }, [safeCurrentFrame, rangeStart, rangeFrameCount]);

  // 根据游标位置计算对应的帧索引（映射到实际帧索引）
  const getFrameIndexFromPosition = useCallback((xPosition: number): number => {
    if (!timelineContainerRef.current || rangeFrameCount === 0) return rangeStart;
    
    const containerWidth = timelineContainerRef.current.clientWidth;
    const leftPadding = 5; // 左侧留白
    const rightPadding = 120; // 右侧留白
    const trackWidth = containerWidth - leftPadding - rightPadding;
    
    // 计算相对位置（0 到 1）
    const relativePosition = Math.max(0, Math.min(trackWidth, xPosition - leftPadding)) / trackWidth;
    
    // 计算范围内的相对帧索引
    const relativeFrameIndex = Math.round(relativePosition * Math.max(0, rangeFrameCount - 1));
    
    // 映射回实际帧索引
    const actualFrameIndex = rangeStart + relativeFrameIndex;
    
    return Math.max(rangeStart, Math.min(rangeEnd, actualFrameIndex));
  }, [rangeStart, rangeEnd, rangeFrameCount]);

  // 处理游标拖动开始
  const handleScrubberMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  // 处理鼠标移动（拖动游标）
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging || !timelineContainerRef.current) return;
    const rect = timelineContainerRef.current.getBoundingClientRect();
    pendingXRef.current = e.clientX - rect.left;
    if (rafIdRef.current == null) {
      const loop = () => {
        if (!isDragging) {
          rafIdRef.current = null;
          return;
        }
        const x = pendingXRef.current;
        if (x != null) {
          setScrubberPosition(x);
          const idx = getFrameIndexFromPosition(x);
          if (idx !== safeCurrentFrame) onFrameSelect(idx);
        }
        rafIdRef.current = requestAnimationFrame(loop);
      };
      rafIdRef.current = requestAnimationFrame(loop);
    }
  }, [isDragging, safeCurrentFrame, onFrameSelect, getFrameIndexFromPosition]);

  // 处理拖动结束
  const handleMouseUp = useCallback(() => {
    if (isDragging) {
      setIsDragging(false);
    }
  }, [isDragging]);

  // 监听全局鼠标事件
  React.useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
        if (rafIdRef.current != null) {
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp]);

  // 更新游标位置（当前帧改变时）
  React.useEffect(() => {
    if (!isDragging) {
      const position = calculateScrubberPosition();
      setScrubberPosition(position);
    }
  }, [safeCurrentFrame, isDragging, calculateScrubberPosition]);

  // 处理时间轴点击
  const handleTimelineClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.current-frame-indicator')) {
      return;
    }
    
    if (!timelineContainerRef.current) return;
    
    const containerRect = timelineContainerRef.current.getBoundingClientRect();
    const xPosition = e.clientX - containerRect.left;
    
    const frameIndex = getFrameIndexFromPosition(xPosition);
    onFrameSelect(frameIndex);
  }, [onFrameSelect, getFrameIndexFromPosition]);

  // 计算游标位置（用于对齐当前帧）
  const getScrubberPosition = useCallback((): number => {
    return scrubberPosition || calculateScrubberPosition();
  }, [scrubberPosition, calculateScrubberPosition]);

  // 计算帧的样式（堆叠效果，基于范围内的相对位置）
  const getFrameStyle = useCallback((actualIndex: number): React.CSSProperties => {
    if (!timelineContainerRef.current) {
      return { left: '0px', transform: 'translate(-50%, -50%)', opacity: 0 };
    }
    
    const containerWidth = timelineContainerRef.current.clientWidth;
    const leftPadding = 5; // 左侧留白
    const rightPadding = 120; // 右侧留白，避免尾帧缩略图被截掉
    const distance = Math.abs(actualIndex - safeCurrentFrame);
    
    // 计算基准位置（游标位置）- 使用与游标完全相同的计算方式
    const baseLeft = getScrubberPosition();
    
    // 当前帧及前后各一帧完全展开
    if (distance <= 1) {
      // 当前帧始终使用游标位置（baseLeft），确保游标在缩略图中心
      if (actualIndex === safeCurrentFrame) {
        return {
          left: `${baseLeft}px`,
          transform: 'translate(-50%, -50%)',
          zIndex: 100 - distance,
          opacity: 1,
        };
      }
      
      const offset = (actualIndex - safeCurrentFrame) * 95; // 完全展开的间距
      let leftPosition = baseLeft + offset;
      
      // 确保第一帧和最后一帧（非当前帧）不会超出边界
      // 第一帧（rangeStart）的中心应该在 leftPadding 位置
      if (actualIndex === rangeStart) {
        leftPosition = leftPadding;
      }
      // 最后一帧（rangeEnd）的中心应该在 containerWidth - rightPadding 位置
      else if (actualIndex === rangeEnd) {
        leftPosition = containerWidth - rightPadding;
      }
      
      return {
        left: `${leftPosition}px`,
        transform: 'translate(-50%, -50%)',
        zIndex: 100 - distance,
        opacity: 1,
      };
    }
    
    // 其他帧堆叠显示
    const side = actualIndex < safeCurrentFrame ? -1 : 1; // 左侧或右侧
    const stackDistance = distance - 1; // 距离展开区域的距离
    const stackOffset = side * (95 + stackDistance * 8); // 堆叠位置
    let leftPosition = baseLeft + stackOffset;
    
    // 确保堆叠的帧不会超出边界
    if (actualIndex === rangeStart) {
      leftPosition = leftPadding;
    } else if (actualIndex === rangeEnd) {
      leftPosition = containerWidth - rightPadding;
    }
    
    return {
      left: `${leftPosition}px`,
      transform: `translate(-50%, -50%) scale(${0.7})`,
      zIndex: 100 - distance,
      opacity: Math.max(0.3, 1 - stackDistance * 0.15),
    };
  }, [safeCurrentFrame, getScrubberPosition, rangeStart, rangeEnd]);

  return (
    <div className={`frame-timeline ${isDragging ? 'dragging' : ''}`}>
      {/* 时间轴容器 - 无滚动 */}
      <div 
        className="timeline-stacked-container" 
        ref={timelineContainerRef}
        onClick={handleTimelineClick}
      >
        {/* 范围内的帧 - 绝对定位，堆叠显示 */}
        <div className="timeline-frames-layer">
          {(() => {
            const windowSize = 48;
            const half = Math.floor(windowSize / 2);
            const vStart = Math.max(rangeStart, safeCurrentFrame - half);
            const vEnd = Math.min(rangeEnd, safeCurrentFrame + half);
            return frames.slice(vStart, vEnd + 1).map((frame, relativeIndex) => {
              const actualIndex = vStart + relativeIndex;
              return (
                <div
                  key={actualIndex}
                  className={`timeline-frame-stacked ${actualIndex === safeCurrentFrame ? 'current' : ''} ${Math.abs(actualIndex - safeCurrentFrame) <= 1 ? 'expanded' : 'collapsed'}`}
                  style={getFrameStyle(actualIndex)}
                  onClick={(e) => {
                    e.stopPropagation();
                    onFrameSelect(actualIndex);
                  }}
                >
                  <div className="frame-thumbnail">
                    <canvas
                      ref={(canvas) => {
                        if (!canvas) return;
                        canvasMapRef.current.set(actualIndex, canvas);
                        
                        // 尝试从文件加载
                        if (previewsDir) {
                          (async () => {
                            try {
                              const p1 = `${previewsDir}/preview.${String(actualIndex).padStart(3, '0')}`;
                              const p2 = `${previewsDir}/preview.${actualIndex}`;
                              
                              let blobUrl: string | null = null;
                              try {
                                blobUrl = await loadImageAsBlob(p1);
                              } catch {
                                try {
                                  blobUrl = await loadImageAsBlob(p2);
                                } catch {
                                  // 文件不存在，等待后台线程解压
                                  return;
                                }
                              }
                              
                              if (blobUrl) {
                                const url = blobUrl;
                                const img = new Image();
                                img.onload = () => {
                                  const w = img.naturalWidth || img.width;
                                  const h = img.naturalHeight || img.height;
                                  if (canvas.width !== w) canvas.width = w;
                                  if (canvas.height !== h) canvas.height = h;
                                  const ctx = canvas.getContext('2d');
                                  if (ctx) {
                                    ctx.imageSmoothingEnabled = false;
                                    ctx.clearRect(0, 0, w, h);
                                    ctx.drawImage(img, 0, 0);
                                  }
                                  URL.revokeObjectURL(url);
                                };
                                img.onerror = () => {
                                  URL.revokeObjectURL(url);
                                };
                                img.src = url;
                              }
                            } catch (err) {
                              // 静默失败，等待后台线程解压
                            }
                          })();
                        } else if (frame.canvas && frame.canvas.width > 0) {
                          // 回退：如果没有预览目录（如刚加载时），直接绘制内存中的 canvas
                          const ctx = canvas.getContext('2d');
                          if (ctx) {
                            ctx.imageSmoothingEnabled = false;
                            ctx.clearRect(0, 0, canvas.width, canvas.height);
                            ctx.drawImage(frame.canvas, 0, 0);
                          }
                        }
                  }}
                  width={frame.canvas ? frame.canvas.width : 100}
                  height={frame.canvas ? frame.canvas.height : 100}
                />
                    <div className="frame-info">
                      <span className="frame-index">{actualIndex}</span>
                      <span className="frame-duration">{frame.delay}ms</span>
                    </div>
                  </div>
                </div>
              );
            });
          })()}
        </div>
        
        {/* 游标 - 可拖动 */}
        <div 
          className={`current-frame-indicator ${isDragging ? 'dragging' : ''}`}
          style={{ 
            left: `${getScrubberPosition()}px`,
            transform: 'translate(-50%, -50%)'
          }}
          onMouseDown={handleScrubberMouseDown}
          title={t('timeline.dragToSelect')}
        >
          <div className="scrubber-handle"></div>
        </div>

        {/* 时间轴轨道（底部基准线） */}
        <div className="timeline-track-line"></div>
      </div>
      
      {/* 定期刷新缺失的缩略图（由独立工作线程解压完成后可见） */}
      {(() => {
        const refreshIntervalRef = useRef<number | null>(null);
        React.useEffect(() => {
          if (!previewsDir) return;
          
          // 每秒检查并重新加载缺失的缩略图
          refreshIntervalRef.current = window.setInterval(() => {
            const windowSize = 48;
            const half = Math.floor(windowSize / 2);
            const vStart = Math.max(rangeStart, safeCurrentFrame - half);
            const vEnd = Math.min(rangeEnd, safeCurrentFrame + half);
            
            for (let actualIndex = vStart; actualIndex <= vEnd; actualIndex++) {
              const canvas = canvasMapRef.current.get(actualIndex);
              if (!canvas) continue;
              
              // 检查 canvas 是否为空（只有1x1像素）
              if (canvas.width <= 1 || canvas.height <= 1) {
                (async () => {
                  try {
                    const p1 = `${previewsDir}/preview.${String(actualIndex).padStart(3, '0')}`;
                    const p2 = `${previewsDir}/preview.${actualIndex}`;
                    
                    let blobUrl: string | null = null;
                    try {
                      blobUrl = await loadImageAsBlob(p1);
                    } catch {
                      try {
                        blobUrl = await loadImageAsBlob(p2);
                      } catch {
                        return;
                      }
                    }
                    
                    if (blobUrl) {
                      const url = blobUrl;
                      const img = new Image();
                      img.onload = () => {
                        const w = img.naturalWidth || img.width;
                        const h = img.naturalHeight || img.height;
                        if (canvas.width !== w) canvas.width = w;
                        if (canvas.height !== h) canvas.height = h;
                        const ctx = canvas.getContext('2d');
                        if (ctx) {
                          ctx.imageSmoothingEnabled = false;
                          ctx.clearRect(0, 0, w, h);
                          ctx.drawImage(img, 0, 0);
                        }
                        URL.revokeObjectURL(url);
                      };
                      img.onerror = () => {
                        URL.revokeObjectURL(url);
                      };
                      img.src = url;
                    }
                  } catch {
                    // 静默失败
                  }
                })();
              }
            }
          }, 1000);
          
          return () => {
            if (refreshIntervalRef.current) {
              clearInterval(refreshIntervalRef.current);
            }
          };
        }, [previewsDir, safeCurrentFrame, rangeStart, rangeEnd]);
        return null;
      })()}

      {/* 拖动提示 */}
        {isDragging && (
          <div 
            className="dragging-hint"
            style={{ left: `${getScrubberPosition()}px` }}
          >
            {t('timeline.frame')} {safeCurrentFrame}
          </div>
        )}
    </div>
  );
};
