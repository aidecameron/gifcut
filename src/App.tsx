import { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { GifPlayer } from './components/GifPlayer';
import { FrameTimeline } from './components/FrameTimeline';
import { LanguageSwitcher } from './components/LanguageSwitcher';
import { GifFrame } from './types';
import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';
import './App.css';

// 全局延迟缓存，避免重复解析 GIF 延迟信息
const _global_delay_cache: Map<string, number[]> = (globalThis as any)._global_delay_cache || new Map();
(globalThis as any)._global_delay_cache = _global_delay_cache;
interface VersionItem {
  id: string;
  name: string;
  path: string;
  timestamp: number;
  isOriginal: boolean;
  frameCount: number;
  duration: number; // 播放总时长（毫秒）
  fileSize?: number; // 文件大小（字节）
  frameDelays: number[]; // 保存每一帧的延迟时间
}

interface GifStats {
  frame_count: number;
  total_duration: number; // 秒
  avg_fps: number;
  min_fps: number;
  max_fps: number;
  file_size: number;
  mode1_fps?: number; // 第一众数帧率
  mode1_count?: number; // 第一众数出现次数
  mode2_fps?: number; // 第二众数帧率
  mode2_count?: number; // 第二众数出现次数
}

function App() {
  const { t } = useTranslation();
  const [frames, setFrames] = useState<GifFrame[]>([]);
  const [originalFrames, setOriginalFrames] = useState<GifFrame[]>([]); // 保存原始帧数据
  const [currentFrame, setCurrentFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false); // 初始状态为暂停
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(0);
  const [activeSlider, setActiveSlider] = useState<'start' | 'end' | null>(null);
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [currentVersionId, setCurrentVersionId] = useState<string>('original');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [activeTab, setActiveTab] = useState<'speed' | 'segment' | 'dedup' | 'resize' | 'fps'>('speed');
  const [workDir, setWorkDir] = useState<string>('');
  const [frameFilesDir, setFrameFilesDir] = useState<string>('');
  const [previewFilesDir, setPreviewFilesDir] = useState<string>('');
  const [gifStats, setGifStats] = useState<GifStats | null>(null);
  const [isApplyingChanges, setIsApplyingChanges] = useState(false);
  const [isLoadingWorkspace, setIsLoadingWorkspace] = useState(false);
  const [isLoadingGif, setIsLoadingGif] = useState(false);
  const [isLoadingStats, setIsLoadingStats] = useState(false);
  // 在初始化时就检查是否是预览模式
  // 注意：只有在新窗口（预览窗口）中才会有 #preview hash
  // 主窗口不应该有 #preview hash，如果有则清除
  const [isPreviewMode, setIsPreviewMode] = useState(() => {
    const hash = window.location.hash || '';
    const isPreview = hash.startsWith('#preview');
    console.log('[TEMP_DEBUG] Initial isPreviewMode check:', isPreview, 'hash:', hash);
    
    // 如果是主窗口但误设置了 #preview hash，清除它
    if (isPreview && !hash.includes('id=')) {
      console.warn('[TEMP_DEBUG] 主窗口误设置了 #preview hash，清除它');
      window.location.hash = '';
      return false;
    }
    
    return isPreview;
  });
  const [previewGifUrl, setPreviewGifUrl] = useState<string | null>(null);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [previewModalGifUrl, setPreviewModalGifUrl] = useState<string | null>(null);
  
  // 使用 ref 跟踪当前的 Blob URL，以便在组件卸载时清理
  const previewModalGifUrlRef = useRef<string | null>(null);
  
  useEffect(() => {
    previewModalGifUrlRef.current = previewModalGifUrl;
  }, [previewModalGifUrl]);
  
  // 确保模态窗口在组件卸载时清理 Blob URL
  useEffect(() => {
    return () => {
      // 只在组件卸载时清理
      if (previewModalGifUrlRef.current && previewModalGifUrlRef.current.startsWith('blob:')) {
        URL.revokeObjectURL(previewModalGifUrlRef.current);
      }
    };
  }, []);
  
  
  
  
  const resolvedPathCacheRef = useRef<Map<string, string>>(new Map());
  const resolvingMapRef = useRef<Map<string, Promise<string>>>(new Map());
  const playerAreaRef = useRef<HTMLDivElement>(null);
  // 标记是否是已载入的外部工作区（非临时工作区）
  const [loadedWorkspacePath, setLoadedWorkspacePath] = useState<string | null>(null);
  const [gifLoadingProgress, setGifLoadingProgress] = useState<{ current: number; total: number; stage?: string; message?: string; subCurrent?: number; subTotal?: number; subMessage?: string } | null>(null);
  const readingActiveRef = useRef<boolean>(false);
  const rehydratingRef = useRef<boolean>(false);
  const rehydratePathRef = useRef<string>('');
  // 解压进度状态
  const [extractProgress, setExtractProgress] = useState<{
    fullframes: { current: number; total: number };
    previews: { current: number; total: number };
  }>({
    fullframes: { current: 0, total: 0 },
    previews: { current: 0, total: 0 },
  });
  const [isExtractPaused, setIsExtractPaused] = useState(false);
  const [, setHasAutoPassedOnce] = useState(false); // 标记是否已经自动暂停过一次
  const [maxDelayCap, setMaxDelayCap] = useState<number | null>(null);
  const [capMax, setCapMax] = useState<number | null>(null);

  const roundTo10Bankers = (v: number) => {
    const q = v / 10;
    const f = Math.floor(q);
    const frac = q - f;
    if (frac > 0.5) return (f + 1) * 10;
    if (frac < 0.5) return f * 10;
    return ((f % 2 === 0) ? f : f + 1) * 10;
  };

  const minDelayCap = useMemo(() => {
    if (!frames || frames.length === 0) return 10;
    const freq = new Map<number, number>();
    for (let i = 0; i < frames.length; i++) {
      const r = roundTo10Bankers(frames[i].delay);
      freq.set(r, (freq.get(r) || 0) + 1);
    }
    const sorted = Array.from(freq.entries()).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0] - b[0];
    });
    const top = sorted.slice(0, 3).map(([v]) => v);
    return top.length ? Math.max(...top) : 10;
  }, [frames]);

  const longestFrameIndex = useMemo(() => {
    if (!frames || frames.length === 0) return 0;
    let max = -Infinity;
    let idx = 0;
    for (let i = 0; i < frames.length; i++) {
      const d = frames[i].delay;
      if (d > max) { max = d; idx = i; }
    }
    return idx;
  }, [frames]);

  useEffect(() => {
    if (frames.length > 0 && maxDelayCap === null) {
      const m = frames[longestFrameIndex]?.delay ?? 100;
      setMaxDelayCap(m);
      setCapMax(m);
    }
  }, [frames, longestFrameIndex, maxDelayCap]);
  
  const formatBytes = (n: number) => {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)}MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
  };

  const _safeBaseFromPath = (p: string) => {
    const baseName = (p.split(/[/\\]/).pop() || 'gif').replace(/\.[^/.]+$/, '');
    return Array.from(baseName).map(ch => {
      const cp = ch.codePointAt(0) ?? 0;
      return /[0-9A-Za-z]/.test(ch) ? ch : `_${cp}`;
    }).join('');
  };

  const _parseDelayBin = (bytes: Uint8Array) => {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = dv.getUint32(0, true);
    const delays: number[] = new Array(count);
    for (let i = 0; i < count; i++) {
      delays[i] = dv.getUint32(4 + i * 4, true);
    }
    return delays;
  };

  


  const _parsePreviewBin = (bytes: Uint8Array) => {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = dv.getUint32(0, true);
    const height = dv.getUint32(4, true);
    const count = dv.getUint32(8, true);
    let offset = 12;
    const outFrames: GifFrame[] = [];
    const delays: number[] = [];
    for (let i = 0; i < count; i++) {
      const delay = dv.getUint32(offset, true);
      const pw = dv.getUint32(offset + 4, true);
      const ph = dv.getUint32(offset + 8, true);
      const len = dv.getUint32(offset + 12, true);
      offset += 16;
      const raw = new Uint8Array(bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + offset + len));
      const arr = new Uint8ClampedArray(raw.byteLength);
      arr.set(raw);
      const previewCanvas = document.createElement('canvas');
      previewCanvas.width = pw;
      previewCanvas.height = ph;
      const ctx = previewCanvas.getContext('2d')!;
      const id = new ImageData(arr, pw, ph);
      ctx.putImageData(id, 0, 0);
      const imageData = new ImageData(1, 1);
      outFrames.push({ imageData, delay, index: i, canvas: previewCanvas });
      delays.push(delay);
      offset += len;
    }
    return { frames: outFrames, dims: { width, height }, frameDelays: delays };
  };

  // 删除：后端数据库读取型后台任务

  const _persistGifCaches = async (_workDirPath: string, _gifPath: string, _cache: { frames: GifFrame[]; dims: { width: number; height: number }; frameDelays: number[] }, _altPath?: string) => {
    return;
  };

  const _tryLoadDiskCaches = async (workDirPath: string, gifPath: string, altPath?: string, verify?: boolean) => {
    try {
      const safeBase = _safeBaseFromPath(gifPath);
      const previewName = `${workDirPath}/_${safeBase}_preview.bin`;
      const delayName = `${workDirPath}/_${safeBase}_delays.bin`;
      const previewHashName = `${workDirPath}/_${safeBase}_preview.sha256`;
      const delayHashName = `${workDirPath}/_${safeBase}_delays.sha256`;
      const existsPreview = await invoke<boolean>('path_exists', { path: previewName });
      const existsDelay = await invoke<boolean>('path_exists', { path: delayName });
      let loadedPreview: { frames: GifFrame[]; dims: { width: number; height: number }; frameDelays: number[] } | null = null;
      let loadedDelays: number[] | null = null;
      const doVerify = verify !== false;
      const totalSteps = (existsPreview ? 1 : 0) + (existsDelay ? 1 : 0) || 1;
      let cur = 0;
      if (existsPreview) {
        setGifLoadingProgress({ stage: 'verify-cache', current: cur, total: totalSteps, message: t('progress.thumbnails') });
        if (doVerify) {
          const existsPH = await invoke<boolean>('path_exists', { path: previewHashName });
          let phSize = 0;
          if (existsPH) {
            try { phSize = await invoke<number>('get_file_size', { path: previewHashName }); } catch {}
          }
          if (existsPH && phSize > 0) {
            const bin = await invoke<number[]>('read_file_in_chunks', { path: previewName, chunk_size: 1024 * 512, chunkSize: 1024 * 512 });
            const arr = new Uint8Array(bin);
            const parsed = _parsePreviewBin(arr);
            loadedPreview = parsed;
            // 迁移旧格式到 RocksDB
            await _persistGifCaches(workDirPath, gifPath, parsed, altPath);
          }
        } else {
          const bin = await invoke<number[]>('read_file_in_chunks', { path: previewName, chunk_size: 1024 * 512, chunkSize: 1024 * 512 });
          const arr = new Uint8Array(bin);
          const parsed = _parsePreviewBin(arr);
          loadedPreview = parsed;
          // 迁移旧格式到 RocksDB
          await _persistGifCaches(workDirPath, gifPath, parsed, altPath);
        }
        cur++;
        setGifLoadingProgress({ stage: 'verify-cache', current: cur, total: totalSteps, message: t('progress.thumbnailsLoaded') });
      }
      if (existsDelay) {
        setGifLoadingProgress({ stage: 'verify-cache', current: cur, total: totalSteps, message: t('progress.delays') });
        if (doVerify) {
          const existsDH = await invoke<boolean>('path_exists', { path: delayHashName });
          let dhSize = 0;
          if (existsDH) {
            try { dhSize = await invoke<number>('get_file_size', { path: delayHashName }); } catch {}
          }
          if (existsDH && dhSize > 0) {
            const bin = await invoke<number[]>('read_file_in_chunks', { path: delayName, chunk_size: 1024 * 256, chunkSize: 1024 * 256 });
            const arr = new Uint8Array(bin);
            const delays = _parseDelayBin(arr);
            loadedDelays = delays;
            _global_delay_cache.set(gifPath, delays);
            if (altPath) _global_delay_cache.set(altPath, delays);
          }
        } else {
          const bin = await invoke<number[]>('read_file_in_chunks', { path: delayName, chunk_size: 1024 * 256, chunkSize: 1024 * 256 });
          const arr = new Uint8Array(bin);
          const delays = _parseDelayBin(arr);
          loadedDelays = delays;
          _global_delay_cache.set(gifPath, delays);
          if (altPath) _global_delay_cache.set(altPath, delays);
        }
        cur++;
        setGifLoadingProgress({ stage: 'verify-cache', current: cur, total: totalSteps, message: t('progress.delaysLoaded') });
      }
      return { loadedPreview, loadedDelays };
    } catch (e) {
      console.warn('[TEMP_DEBUG] 磁盘缓存载入失败:', e);
      return { loadedPreview: null, loadedDelays: null };
    }
  };
  const formatPercent = (cur: number, tot: number) => {
    if (!tot) return '0%';
    const p = Math.floor((cur / tot) * 100);
    return `${p}%`;
  };

  // 分段 Tab 独立的范围选择状态
  const [segmentRangeStart, setSegmentRangeStart] = useState(0);
  const [segmentRangeEnd, setSegmentRangeEnd] = useState(0);
  const [isSliceOnlySelected, setIsSliceOnlySelected] = useState(true);
  const [reOptimizeAfterSlice, setReOptimizeAfterSlice] = useState(true);

  // 去重瘦身 Tab 参数状态
  const [dedupQuality, setDedupQuality] = useState(90); // 输出质量 1-100
  const [dedupThreshold, setDedupThreshold] = useState(95); // 相似度阈值 0-100
  const [dedupColors, setDedupColors] = useState(256); // 颜色数量 2-256
  const [dedupUsePalette, setDedupUsePalette] = useState(false); // 强制使用调色板模式
  const [isApplyingDedup, setIsApplyingDedup] = useState(false);
  const [dedupProgress, setDedupProgress] = useState<{
    stage: string;
    message: string;
    current?: number;
    total?: number;
    details?: string;
  } | null>(null);
  const [rangeTargetDuration, setRangeTargetDuration] = useState<number>(0);

  const [resizeWidth, setResizeWidth] = useState<number>(0);
  const [resizeHeight, setResizeHeight] = useState<number>(0);
  const [keepAspect, setKeepAspect] = useState<boolean>(true);
  const [resizeMethod, setResizeMethod] = useState<string>('mix');
  const [isResizing, setIsResizing] = useState<boolean>(false);

  // 频率调整 Tab 状态
  const [fpsKeepInterval, setFpsKeepInterval] = useState<number>(2); // 每 N 帧保留 1 帧
  const [fpsDelayThreshold, setFpsDelayThreshold] = useState<number>(100); // 时延阈值（ms），只抽取低于此值的快帧
  const [isApplyingFps, setIsApplyingFps] = useState<boolean>(false);

  // 计算抽帧预估效果
  const fpsPreview = useMemo(() => {
    if (frames.length === 0) {
      return {
        originalFrameCount: 0,
        newFrameCount: 0,
        newDelays: [] as number[],
        minDelay: 0,
        maxDelay: 0,
        maxDelayIndex: -1,
        totalDuration: 0,
        avgFps: 0,
        maxFps: 0,
        minFps: 0,
        fpsModes: [] as { fps: number; count: number }[],
      };
    }

    // 模拟抽帧逻辑：只对低于阈值的帧进行抽帧
    const newDelays: number[] = [];
    let i = 0;
    while (i < frames.length) {
      const currentDelay = frames[i].delay;
      
      // 如果当前帧延迟 >= 阈值，直接保留，不参与抽帧
      if (currentDelay >= fpsDelayThreshold) {
        newDelays.push(currentDelay);
        i++;
        continue;
      }
      
      // 当前帧延迟 < 阈值，参与抽帧逻辑
      // 累加连续快帧的延迟
      let accumulatedDelay = currentDelay;
      let fastFrameCount = 1;
      
      // 向后查看是否有连续的快帧需要合并
      for (let j = 1; j < fpsKeepInterval && (i + j) < frames.length; j++) {
        const nextDelay = frames[i + j].delay;
        if (nextDelay < fpsDelayThreshold) {
          accumulatedDelay += nextDelay;
          fastFrameCount++;
        } else {
          // 遇到慢帧，停止合并
          break;
        }
      }
      
      // 保留一帧，累加延迟（限制最大 65535）
      newDelays.push(Math.min(accumulatedDelay, 65535));
      i += fastFrameCount;
    }

    // 计算统计数据
    const minDelay = newDelays.length > 0 ? Math.min(...newDelays) : 0;
    const maxDelay = newDelays.length > 0 ? Math.max(...newDelays) : 0;
    const totalDuration = newDelays.reduce((sum, d) => sum + d, 0);

    // 找到最大时延的帧索引（第一个）
    const maxDelayIndex = newDelays.indexOf(maxDelay);

    // 平均帧率
    const avgFps = totalDuration > 0 ? Math.round((newDelays.length / (totalDuration / 1000)) * 10) / 10 : 0;

    // 最大/最小帧率
    const maxFps = minDelay > 0 ? Math.round((1000 / minDelay) * 10) / 10 : 0;
    const minFps = maxDelay > 0 ? Math.round((1000 / maxDelay) * 10) / 10 : 0;

    // 计算 FPS 众数（取小数点后一位）
    const fpsMap = new Map<number, number>();
    for (const delay of newDelays) {
      if (delay > 0) {
        const fps = Math.round((1000 / delay) * 10) / 10; // 保留一位小数
        fpsMap.set(fps, (fpsMap.get(fps) || 0) + 1);
      }
    }
    
    // 排序取前4个众数
    const fpsModes = Array.from(fpsMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([fps, count]) => ({ fps, count }));

    return {
      originalFrameCount: frames.length,
      newFrameCount: newDelays.length,
      newDelays,
      minDelay,
      maxDelay,
      maxDelayIndex,
      totalDuration,
      avgFps,
      maxFps,
      minFps,
      fpsModes,
    };
  }, [frames, fpsKeepInterval, fpsDelayThreshold]);

  // 当帧数据变化时，初始化阈值
  useEffect(() => {
    if (frames.length > 0) {
      // 设置阈值为众数帧延迟（大多数帧的延迟）
      const delayMap = new Map<number, number>();
      for (const f of frames) {
        delayMap.set(f.delay, (delayMap.get(f.delay) || 0) + 1);
      }
      const modeDelay = Array.from(delayMap.entries())
        .sort((a, b) => b[1] - a[1])[0]?.[0] || 100;
      // 阈值设为众数延迟的1.5倍，确保只抽快帧
      setFpsDelayThreshold(Math.round(modeDelay * 1.5));
    }
  }, [frames.length]); // 只在帧数变化时重置

  useEffect(() => {
    const hash = window.location.hash || '';
    console.log('[TEMP_DEBUG] Preview window hash:', hash);
    if (hash.startsWith('#preview')) {
      console.log('[TEMP_DEBUG] Setting isPreviewMode to true');
      setIsPreviewMode(true);
      const query = hash.includes('?') ? hash.split('?')[1] : '';
      const params = new URLSearchParams(query);
      const idParam = params.get('id') || '';
      const pathParam = params.get('path') || ''; // 兼容旧方式或作为fallback
      
      console.log('[TEMP_DEBUG] Preview params - id:', idParam, 'path:', pathParam);
      setLoading(true);

      // 定义数据处理逻辑
      const handlePreviewData = async (data: { 
        path: string,
        loop?: boolean,
      }) => {
        try {
          console.log('[TEMP_DEBUG] Preview data received:', data);
          
          // 预览窗口直接使用 GIF 文件 URL，不需要解析
          let gifUrl: string;
          const isLocalAbsolutePath = data.path.startsWith('/') && !data.path.startsWith('/gifs/');
          
          if (!isLocalAbsolutePath) {
            // Web 资源，直接使用
            gifUrl = data.path;
          } else {
            // 本地文件，转换为 Tauri 的 asset:// URL
            const { convertFileSrc } = await import('@tauri-apps/api/tauri');
            gifUrl = convertFileSrc(data.path);
          }

          // 直接设置 GIF URL，不需要解析
          setFrames([]); // 清空 frames，预览窗口不使用
          setDimensions({ width: 0, height: 0 }); // 尺寸会在 img 加载后自动获取
          setCurrentFrame(0);
          setIsPlaying(true);
          
          // 保存 GIF URL 用于渲染（使用 state 以便触发重新渲染）
          setPreviewGifUrl(gifUrl);
        } catch (e) {
          console.error('Preview load failed:', e);
          setError(t('preview.loadError', { error: String(e) }));
        } finally {
          setLoading(false);
          setGifLoadingProgress(null);
        }
      };

      // 启动监听
      let unlistenData: (() => void) | null = null;
      
      (async () => {
        // 如果有 ID，监听特定事件
        if (idParam) {
           console.log('[TEMP_DEBUG] Listening for preview data:', `preview-data-${idParam}`);
           unlistenData = await listen(`preview-data-${idParam}`, (event: any) => {
             handlePreviewData(event.payload);
           });
           
           // 发送就绪信号
           console.log('[TEMP_DEBUG] Sending ready signal:', `preview-ready-${idParam}`);
           const { emit } = await import('@tauri-apps/api/event');
           await emit(`preview-ready-${idParam}`);
           
           // 设置超时，如果没收到事件，尝试使用 pathParam (如果存在)
           setTimeout(() => {
             if (loading && pathParam) {
               console.warn('[TEMP_DEBUG] Timeout waiting for event, falling back to pathParam');
               handlePreviewData({ path: pathParam });
             }
           }, 2000);
        } else if (pathParam) {
           // 旧逻辑 fallback
           handlePreviewData({ path: pathParam });
        }
      })();

      return () => {
        if (unlistenData) unlistenData();
      };
    }
  }, []);

  // 统一的 GIF 加载逻辑：获取元数据、生成占位符、启动后台解压
  const loadGifForEditing = async (gifPath: string, currentWorkDir: string) => {
    console.log('[TEMP_DEBUG] loadGifForEditing:', gifPath);
    
    // 1. 获取文件大小 (仅用于日志或状态)
    let fileSize = 0;
    try { fileSize = await invoke<number>('get_file_size', { path: gifPath }); } catch {}

    // 2. 调用 parse_gif_preview 获取元数据
    // 这会生成 _temp_color_restored.gif (如果不存在) 并返回基本信息
    setGifLoadingProgress({ stage: 'extract', current: 0, total: 1, message: t('progress.parsingDelays') });
    
    const meta = await invoke<{ width: number; height: number; frame_count: number; delays_ms: number[]; preview_dir: string; preview_files: string[]; preview_width: number; preview_height: number }>('parse_gif_preview', {
      gifPath: gifPath,
      workDir: currentWorkDir,
      maxPreview: 120,
    });
    
    console.log('[TEMP_DEBUG] parse_gif_preview done. Meta:', meta.width, meta.height, meta.frame_count);

    // 3. 更新全局延迟缓存
    try {
      _global_delay_cache.set(gifPath, meta.delays_ms);
    } catch {}

    // 4. 设置解压进度 (基于已存在的文件)
    try {
      const safeBase = _safeBaseFromPath(gifPath);
      const framesDirCalc = `${currentWorkDir}/_${safeBase}_fullframes`;
      const previewsDirCalc = `${currentWorkDir}/_${safeBase}_previews`;
      setFrameFilesDir(framesDirCalc);
      setPreviewFilesDir(previewsDirCalc);
      
      const fullNames = await invoke<string[]>('read_dir_filenames', { path: framesDirCalc }).catch(() => []);
      const prevNames = await invoke<string[]>('read_dir_filenames', { path: previewsDirCalc }).catch(() => []);
      
      const fullCur = fullNames.filter(n => n.startsWith('frame.')).length;
      const prevCur = prevNames.filter(n => n.startsWith('preview.')).length;
      
      setExtractProgress({
        fullframes: { current: fullCur, total: meta.frame_count },
        previews: { current: prevCur, total: meta.frame_count },
      });
    } catch (e) {
      console.warn('[TEMP_DEBUG] Failed to init extract progress:', e);
    }

    // 5. 启动后台解压任务
    try { await invoke<string>('extract_fullframes_background', { workDir: currentWorkDir, gifPath: gifPath, batch_size: 100 }); } catch {}
    try { await invoke<string>('extract_previews_background', { workDir: currentWorkDir, gifPath: gifPath, max_preview: 120, batch_size: 100 }); } catch {}

    // 6. 生成占位符 frames
    setGifLoadingProgress({ stage: 'parse', current: 0, total: 1, message: t('progress.buildingPlaceholders') });
    const dims = { width: meta.width, height: meta.height };
    const placeholders: GifFrame[] = Array.from({ length: meta.frame_count }, (_, i) => {
      const c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      const id = new ImageData(1, 1);
      return { imageData: id, delay: meta.delays_ms[i] || 100, index: i, canvas: c };
    });

    return {
      placeholders,
      dims,
      meta,
      fileSize
    };
  };

  // 统一的状态初始化逻辑
  const initializeStateFromLoadedGif = (
    placeholders: GifFrame[], 
    dims: { width: number; height: number }, 
    meta: { width: number; height: number; frame_count: number; delays_ms: number[] }, 
    fileSize: number, 
    fileName: string, 
    path: string
  ) => {
    setFrames(placeholders);
    setOriginalFrames(JSON.parse(JSON.stringify(placeholders.map((f: GifFrame) => ({ delay: f.delay })))));
    setDimensions(dims);
    setResizeWidth(dims.width || 0);
    setResizeHeight(dims.height || 0);
    setCurrentFrame(0);
    setRangeStart(0);
    setRangeEnd(placeholders.length - 1);
    setSegmentRangeStart(0);
    setSegmentRangeEnd(placeholders.length - 1);
    
    const totalDuration = placeholders.reduce((sum, f) => sum + f.delay, 0);
    const initialVersion: VersionItem = {
      id: 'original',
      name: fileName,
      path: path,
      timestamp: Date.now(),
      isOriginal: true,
      frameCount: meta.frame_count,
      duration: totalDuration,
      fileSize: fileSize,
      frameDelays: placeholders.map(f => f.delay),
    };
    setVersions([initialVersion]);
    setCurrentVersionId('original');
    setHasUnsavedChanges(false);
    
    // Stats
    const fpsList = meta.delays_ms.map(d => 1000 / (d || 10));
    const counts: Record<number, number> = {};
    fpsList.forEach(fps => {
      const rounded = Math.round(fps);
      counts[rounded] = (counts[rounded] || 0) + 1;
    });
    const sortedFps = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    
    const stats: GifStats = {
      frame_count: meta.frame_count,
      total_duration: totalDuration / 1000,
      avg_fps: totalDuration > 0 ? meta.frame_count / (totalDuration / 1000) : 0,
      min_fps: Math.min(...fpsList),
      max_fps: Math.max(...fpsList),
      file_size: fileSize,
      mode1_fps: sortedFps[0] ? Number(sortedFps[0][0]) : undefined,
      mode1_count: sortedFps[0] ? sortedFps[0][1] : undefined,
      mode2_fps: sortedFps[1] ? Number(sortedFps[1][0]) : undefined,
      mode2_count: sortedFps[1] ? sortedFps[1][1] : undefined,
    };
    setGifStats(stats);
  };

  // 启动时初始化逻辑：检查依赖、恢复会话、设置监听器
  useEffect(() => {
    // 自动检查 gifski 是否可用
    const checkGifski = async () => {
      try {
        console.log('[TEMP_DEBUG] Checking gifski version...');
        const version = await invoke<string>('test_gifski_version');
        console.log('[TEMP_DEBUG] Gifski version:', version);
      } catch (err) {
        console.error('[TEMP_DEBUG] Gifski check failed:', err);
      }
    };
    
    checkGifski();

    const rehydrateSingleFile = async (lastPath: string) => {
        const lastSource = sessionStorage.getItem('lastSourcePath') || '';
        try {
          try { sessionStorage.setItem('rehydratedOnce', '1'); } catch {}
          rehydratePathRef.current = lastPath;
          
          console.log('[TEMP_DEBUG] Rehydrating from lastGifPath (Single File Fallback):', lastPath);
          setLoading(true);
          const workDirPath = await invoke<string>('init_work_dir');
          setWorkDir(workDirPath);
          
          let targetPath = lastPath;
          try {
            const { exists } = await import('@tauri-apps/api/fs');
            const fileExists = await exists(lastPath);
            if (!fileExists) {
                if (lastSource) {
                    console.log('[TEMP_DEBUG] lastGifPath missing, restoring from source:', lastSource);
                    const fileName = lastSource.split(/[/\\]/).pop() || 'image.gif';
                    targetPath = await invoke<string>('read_file_to_workdir', {
                        src_path: lastSource,
                        work_dir: workDirPath,
                        filename: fileName,
                        chunk_size: 1024 * 512,
                    });
                    try { sessionStorage.setItem('lastGifPath', targetPath); } catch {}
                } else {
                    throw new Error('lastGifPath not exists and no source');
                }
            }
          } catch (e) {
              throw e;
          }

          const { placeholders, dims, meta, fileSize } = await loadGifForEditing(targetPath, workDirPath);
          const fileName = targetPath.split(/[/\\]/).pop() || 'image.gif';
          
          initializeStateFromLoadedGif(placeholders, dims, meta, fileSize, fileName, targetPath);
          
          console.log('[TEMP_DEBUG] Rehydrate completed via unified loader.');
        } catch (rehydErr) {
          console.error('[TEMP_DEBUG] Rehydrate failed:', rehydErr);
        } finally {
          setLoading(false);
        }
    };

    let flag = false;
    try {
      flag = sessionStorage.getItem('hasUserLoadedGif') === '1';
      if (flag) {
        
        console.log('[TEMP_DEBUG] Skip default GIF: session flag detected');
        
        // 优先尝试恢复工作区
        const lastWorkspace = sessionStorage.getItem('loadedWorkspacePath');
        const tempWorkDirPath = sessionStorage.getItem('tempWorkDirPath');
        const lastPath = sessionStorage.getItem('lastGifPath') || '';
        
        if (frames.length === 0 && !rehydratingRef.current) {
          if (lastWorkspace) {
             rehydratingRef.current = true;
             (async () => {
                try {
                  console.log('[TEMP_DEBUG] Rehydrating workspace:', lastWorkspace);
                  await loadWorkspaceFromPath(lastWorkspace);
                } catch (err) {
                  console.error('[TEMP_DEBUG] Failed to rehydrate workspace:', err);
                } finally {
                  rehydratingRef.current = false;
                }
              })();
              return;
          } else if (tempWorkDirPath) {
             // 尝试恢复临时工作区
             rehydratingRef.current = true;
             (async () => {
                try {
                  const { exists } = await import('@tauri-apps/api/fs');
                  const dirExists = await exists(tempWorkDirPath);
                  if (dirExists) {
                     console.log('[TEMP_DEBUG] Rehydrating temp workspace:', tempWorkDirPath);
                     await loadWorkspaceFromPath(tempWorkDirPath, { isTemp: true, originalPath: lastPath });
                  } else {
                     throw new Error('Temp work dir no longer exists');
                  }
                } catch (err) {
                  console.warn('[TEMP_DEBUG] Failed to rehydrate temp workspace, falling back to single file:', err);
                  await rehydrateSingleFile(lastPath);
                } finally {
                  rehydratingRef.current = false;
                }
             })();
             return;
          }
        }

        if (frames.length === 0 && lastPath && !rehydratingRef.current) {
          rehydratingRef.current = true;
          (async () => {
             await rehydrateSingleFile(lastPath);
             rehydratingRef.current = false;
          })();
        }
      }
    } catch {}
    if (!flag) {
      console.log('[TEMP_DEBUG] Skip default GIF: startup requires manual load');
      setLoading(false);
    } else {
      console.log('[TEMP_DEBUG] Default GIF load bypassed');
      if (frames.length > 0) {
        setLoading(false);
      }
    }
    
    // 设置全局的去重进度事件监听器
    let unlistenFn: (() => void) | null = null;
    const setupListener = async () => {
      try {
        console.log('[TEMP_DEBUG] Setting up dedup progress listener...');
        const unlisten = await listen<{
          stage: string;
          message: string;
          current?: number;
          total?: number;
          details?: string;
        }>('dedup-progress', (event) => {
          console.log('[TEMP_DEBUG] ===== Dedup progress event received =====');
          console.log('[TEMP_DEBUG] Event:', event);
          console.log('[TEMP_DEBUG] Event payload:', JSON.stringify(event.payload, null, 2));
          console.log('[TEMP_DEBUG] Event payload type:', typeof event.payload);
          if (event.payload) {
            console.log('[TEMP_DEBUG] Event payload keys:', Object.keys(event.payload));
          }
          // 直接设置状态，确保立即更新
          const newProgress = {
            stage: event.payload.stage || '',
            message: event.payload.message || '',
            current: event.payload.current,
            total: event.payload.total,
            details: event.payload.details,
          };
          console.log('[TEMP_DEBUG] Setting new progress directly:', newProgress);
          // 直接设置状态，React 会自动批处理更新
          setDedupProgress(newProgress);
          // 强制触发 React 重新渲染
          console.log('[TEMP_DEBUG] State updated, triggering re-render');
        });
        unlistenFn = unlisten;
      console.log('[TEMP_DEBUG] Global dedup progress listener set up successfully');
      } catch (err) {
        console.error('[TEMP_DEBUG] Failed to set up dedup progress listener:', err);
      }
    };
    setupListener();
    
    // 清理函数
    return () => {
      if (unlistenFn) {
        console.log('[TEMP_DEBUG] Cleaning up dedup progress listener');
        unlistenFn();
      }
    };
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ 
        current: number; 
        total: number; 
        stage?: string; 
        message?: string; 
        subCurrent?: number; 
        subTotal?: number; 
        subMessage?: string;
      }>;
      if (ce.detail) {
        setGifLoadingProgress({
          current: ce.detail.current,
          total: ce.detail.total,
          stage: ce.detail.stage,
          message: ce.detail.message,
          subCurrent: ce.detail.subCurrent,
          subTotal: ce.detail.subTotal,
          subMessage: ce.detail.subMessage,
        });
      } else {
        setGifLoadingProgress(null);
      }
    };
    window.addEventListener('gif-parse-progress', handler as EventListener);
    return () => {
      window.removeEventListener('gif-parse-progress', handler as EventListener);
    };
  }, []);

  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const un = await listen<{ current: number; total: number }>('file-read-progress', (event) => {
          setGifLoadingProgress({ stage: 'read', current: event.payload.current, total: event.payload.total });
        });
        unlistenFn = un;
      } catch (err) {
        console.error('[TEMP_DEBUG] Failed to set up file-read-progress listener:', err);
      }
    })();
    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, []);

  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    const lastRef = { current: { stage: '', current: -1, total: -1, message: '', subCurrent: -1, subTotal: -1, subMessage: '' } } as React.MutableRefObject<{ 
      stage: string; 
      current: number; 
      total: number; 
      message?: string; 
      subCurrent?: number; 
      subTotal?: number; 
      subMessage?: string;
    }>;
    const pendingRef = { current: null as null | { 
      stage: string; 
      current: number; 
      total: number; 
      message?: string; 
      subCurrent?: number; 
      subTotal?: number; 
      subMessage?: string;
    } };
    const timerRef = { current: null as null | number };
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const un = await listen<{ 
          stage: string; 
          current: number; 
          total: number; 
          message?: string; 
          subCurrent?: number; 
          subTotal?: number; 
          subMessage?: string;
        }>('gif-parse-progress', (event) => {
          const p = { 
            stage: event.payload.stage, 
            current: event.payload.current, 
            total: event.payload.total,
            message: event.payload.message,
            subCurrent: event.payload.subCurrent,
            subTotal: event.payload.subTotal,
            subMessage: event.payload.subMessage,
          };
          // 检查是否有实质性变化（包括消息内容）
          if (p.stage === lastRef.current.stage && 
              p.current === lastRef.current.current && 
              p.total === lastRef.current.total &&
              p.message === lastRef.current.message &&
              p.subCurrent === lastRef.current.subCurrent &&
              p.subTotal === lastRef.current.subTotal &&
              p.subMessage === lastRef.current.subMessage) {
            return;
          }
          pendingRef.current = p;
          if (timerRef.current == null) {
            timerRef.current = window.setTimeout(() => {
              const cur = pendingRef.current;
              timerRef.current = null;
              if (!cur) return;
              // 再次检查是否有实质性变化
              if (cur.stage === lastRef.current.stage && 
                  cur.current === lastRef.current.current && 
                  cur.total === lastRef.current.total &&
                  cur.message === lastRef.current.message &&
                  cur.subCurrent === lastRef.current.subCurrent &&
                  cur.subTotal === lastRef.current.subTotal &&
                  cur.subMessage === lastRef.current.subMessage) {
                return;
              }
              lastRef.current = cur;
              setGifLoadingProgress(cur);
              pendingRef.current = null;
            }, 120);
          }
        });
        unlistenFn = un;
      } catch (err) {
        console.error('[TEMP_DEBUG] Failed to set up gif-parse-progress listener:', err);
      }
    })();
    return () => { if (unlistenFn) unlistenFn(); };
  }, []);

  // 监听 GIF 准备进度事件（恢复颜色和恢复优化）
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const un = await listen<{ stage: string; status: string; message: string }>('gif-prep-progress', (event) => {
          const { status, message } = event.payload;
          
          if (status === 'start') {
            // 开始某个步骤，显示进度
            setGifLoadingProgress({
              stage: 'extract',
              current: 0,
              total: 1,
              message: message
            });
          } else if (status === 'complete') {
            // 完成某个步骤，暂时保留进度（会被下一个步骤覆盖）
            console.log(`[TEMP_DEBUG] ${message}完成`);
          }
        });
        unlistenFn = un;
      } catch (err) {
        console.error('[TEMP_DEBUG] Failed to set up gif-prep-progress listener:', err);
      }
    })();
    return () => { if (unlistenFn) unlistenFn(); };
  }, []);

  // 监听解压进度事件
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    // 使用 ref 来避免闭包问题
    const autoPauseTriggeredRef = { current: false };
    
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const un = await listen<{ stage: string; current: number; total: number }>('extract-progress', (event) => {
          const { stage, current, total } = event.payload;
          setExtractProgress(prev => {
            if (stage === 'fullframes') {
              return { ...prev, fullframes: { current, total } };
            } else if (stage === 'previews') {
              return { ...prev, previews: { current, total } };
            }
            return prev;
          });
          
          // 如果总帧数超过 1000 帧，且当前已解压到 1000 帧，仅首次自动暂停
          if (total > 1000 && current >= 1000 && !autoPauseTriggeredRef.current) {
            autoPauseTriggeredRef.current = true; // 标记已经自动暂停过
            console.log(`[TEMP_DEBUG] 帧数超过 1000 (${total}), 在解压 ${current} 帧后自动暂停（仅首次）`);
            
            setIsExtractPaused(true);
            setHasAutoPassedOnce(true);
            
            (async () => {
              try {
                await invoke('pause_extraction');
              } catch (err) {
                console.error('[TEMP_DEBUG] 自动暂停解压失败:', err);
              }
            })();
          }
        });
        unlistenFn = un;
      } catch (err) {
        console.error('[TEMP_DEBUG] Failed to set up extract-progress listener:', err);
      }
    })();
    return () => { if (unlistenFn) unlistenFn(); };
  }, []); // 移除依赖项，使用 ref 来跟踪状态

  // 监控帧变化，标记为有未保存更改
  useEffect(() => {
    if (originalFrames.length > 0 && frames.length > 0) {
      const hasChanges = frames.some((frame, idx) => {
        return frame.delay !== originalFrames[idx]?.delay;
      });
      setHasUnsavedChanges(hasChanges);
    }
  }, [frames, originalFrames]);
  useEffect(() => {
    const sum = frames.slice(rangeStart, rangeEnd + 1).reduce((s, f) => s + (f?.delay || 0), 0);
    setRangeTargetDuration(sum);
  }, [rangeStart, rangeEnd, frames]);

  // 调试：监控范围变化
  useEffect(() => {
    console.log('[TEMP_DEBUG] Range Updated - Start:', rangeStart, 'End:', rangeEnd, 'Total Frames:', frames.length);
  }, [rangeStart, rangeEnd, frames.length]);

  useEffect(() => {
    const gs = gifStats?.frame_count ?? null;
    const fl = frames.length;
    const maxIndex = Math.max(0, (gifStats?.frame_count || frames.length) - 1);
    console.log('[TEMP_DEBUG] FrameCountSources', { gifStats_frame_count: gs, frames_length: fl, maxIndex, rangeStart, rangeEnd, segmentRangeStart, segmentRangeEnd });
  }, [gifStats?.frame_count, frames.length, rangeStart, rangeEnd, segmentRangeStart, segmentRangeEnd]);

  // 调试：监控activeSlider变化
  useEffect(() => {
    console.log('[TEMP_DEBUG] Active Slider Changed:', activeSlider);
  }, [activeSlider]);

  // 键盘控制：左右箭头键控制时间轴
  const keyPressTimerRef = useRef<number | null>(null);
  const keyPressStartTimeRef = useRef<number | null>(null);
  const currentKeyRef = useRef<'ArrowLeft' | 'ArrowRight' | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 如果正在输入，不处理键盘事件
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        
        // 如果已经有按键在处理，不重复处理
        if (currentKeyRef.current !== null) {
          return;
        }

        currentKeyRef.current = e.key as 'ArrowLeft' | 'ArrowRight';
        keyPressStartTimeRef.current = Date.now();

        // 立即移动一格
        const direction = e.key === 'ArrowLeft' ? -1 : 1;
        setCurrentFrame(prev => {
          const newFrame = Math.max(0, Math.min(frames.length - 1, prev + direction));
          return newFrame;
        });

        // 设置长按加速逻辑
        let delay = 500; // 初始延迟 500ms
        const minDelay = 50; // 最小延迟 50ms
        const acceleration = 0.85; // 每次加速系数

        const scheduleNext = () => {
          keyPressTimerRef.current = window.setTimeout(() => {
            if (currentKeyRef.current === e.key) {
              const direction = e.key === 'ArrowLeft' ? -1 : 1;
              setCurrentFrame(prev => {
                const newFrame = Math.max(0, Math.min(frames.length - 1, prev + direction));
                return newFrame;
              });

              // 加速：延迟逐渐缩短
              delay = Math.max(minDelay, delay * acceleration);
              scheduleNext();
            }
          }, delay);
        };

        scheduleNext();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (currentKeyRef.current === e.key) {
          currentKeyRef.current = null;
          keyPressStartTimeRef.current = null;
          if (keyPressTimerRef.current) {
            clearTimeout(keyPressTimerRef.current);
            keyPressTimerRef.current = null;
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      if (keyPressTimerRef.current) {
        clearTimeout(keyPressTimerRef.current);
      }
    };
  }, [frames.length]);

  

  const handleFrameChange = (index: number) => {
    // 简化：只更新当前帧状态，不触发任何预加载
    // 帧的显示由独立的后台解压线程和前端定时刷新机制负责
    setCurrentFrame(index);
  };

  // 确保 gifsicle 的输入路径是本地可访问文件
  const ensureLocalSourcePath = async (srcPath: string): Promise<string> => {
    try {
      if (!workDir) return srcPath;
      const isLocalPath = srcPath.startsWith('/') && !srcPath.startsWith('/gifs/');
      const isWebResource = srcPath.startsWith('http') || srcPath.startsWith('/gifs/');
      if (isLocalPath) return srcPath;
      if (isWebResource) {
        const fileName = srcPath.split('/').pop() || 'source.gif';
        const cached = resolvedPathCacheRef.current.get(srcPath);
        if (cached) {
          try {
            const { exists } = await import('@tauri-apps/api/fs');
            if (await exists(cached)) return cached;
          } catch {}
        }
        const targetPath = `${workDir}/${fileName}`;
        try {
          const { exists } = await import('@tauri-apps/api/fs');
          if (await exists(targetPath)) {
            resolvedPathCacheRef.current.set(srcPath, targetPath);
            return targetPath;
          }
        } catch {}
        if (resolvingMapRef.current.has(srcPath)) {
          return await resolvingMapRef.current.get(srcPath)!;
        }
        const p = (async () => {
          console.log('[TEMP_DEBUG] Resolving web resource to local file:', srcPath);
          const response = await fetch(srcPath);
          const blob = await response.blob();
          const arrayBuffer = await blob.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);
          const localPath = await invoke<string>('write_binary_file', {
            work_dir: workDir,
            workDir: workDir,
            filename: fileName,
            fileName: fileName,
            data: Array.from(uint8Array),
          });
          return localPath;
        })();
        resolvingMapRef.current.set(srcPath, p);
        try {
          const localPath = await p;
          resolvedPathCacheRef.current.set(srcPath, localPath);
          return localPath;
        } finally {
          resolvingMapRef.current.delete(srcPath);
        }
      }
    } catch (e) {
      console.error('[TEMP_DEBUG] ensureLocalSourcePath failed:', e);
    }
    return srcPath;
  };

  const handleFrameSelect = async (index: number) => {
    handleFrameChange(index);
    setIsPlaying(false);
  };

  const handlePlayingChange = async (playing: boolean) => {
    // 简化：只更新播放状态
    // 播放时的帧显示由 GifPlayer 组件内部处理
    setIsPlaying(!!playing);
  };

  // 生成预览 GIF 文件
  const generatePreviewGif = async (): Promise<string | null> => {
    if (!workDir) return null;
    
    const currentVersion = versions.find(v => v.id === currentVersionId);
    if (!currentVersion) return null;
    
    // 准备输入文件路径
    let inputPath: string;
    if (currentVersion.isOriginal) {
      inputPath = await ensureLocalSourcePath(currentVersion.path);
    } else {
      inputPath = currentVersion.path;
    }
    
    const previewPath = `${workDir}/_temp_preview.gif`;
    
    try {
      // 根据当前 tab 生成预览 GIF
      if (activeTab === 'speed' && hasUnsavedChanges) {
        // speed tab: 使用 modify_gif_delays
        let frameDelays = frames.map(f => f.delay);
        const currentRangeSum = frames.slice(rangeStart, rangeEnd + 1).reduce((s, f) => s + (f?.delay || 0), 0);
        const targetSum = rangeTargetDuration;
        if (targetSum > 0 && targetSum !== currentRangeSum) {
          const ratio = targetSum / currentRangeSum;
          frameDelays = frameDelays.map((d, i) => {
            if (i >= rangeStart && i <= rangeEnd) {
              return Math.max(10, Math.round(d * ratio));
            }
            return d;
          });
          let newRangeSum = frameDelays.slice(rangeStart, rangeEnd + 1).reduce((s, d) => s + d, 0);
          let diff = targetSum - newRangeSum;
          if (diff !== 0) {
            const dir = diff > 0 ? 1 : -1;
            diff = Math.abs(diff);
            for (let pass = 0; pass < 2 && diff > 0; pass++) {
              for (let i = rangeStart; i <= rangeEnd && diff > 0; i++) {
                const nd = frameDelays[i] + dir;
                if (dir < 0 && nd < 10) continue;
                frameDelays[i] = nd;
                diff -= 1;
              }
            }
          }
        }
        
        await invoke<string>('modify_gif_delays', {
          inputPath: inputPath,
          outputPath: previewPath,
          frameDelays: frameDelays,
        });
        return previewPath;
      } else if (activeTab === 'dedup' && (dedupQuality !== 90 || dedupThreshold !== 95 || dedupColors !== 256 || dedupUsePalette !== false)) {
        // dedup tab: 调用去重逻辑生成预览
        // 注意：去重是异步的，需要等待完成事件
        let dedupCompleted = false;
        let dedupError: string | null = null;
        
        const { listen } = await import('@tauri-apps/api/event');
        const unlisten = await listen<{
          stage: string;
          message: string;
        }>('dedup-progress', (event) => {
          if (event.payload.stage === 'complete') {
            dedupCompleted = true;
          } else if (event.payload.stage === 'error') {
            dedupError = event.payload.message;
          }
        });
        
        try {
          await invoke('dedup_gif', {
            inputPath: inputPath,
            outputPath: previewPath,
            quality: dedupQuality,
            threshold: dedupThreshold,
            colors: Math.min(dedupColors, 256),
            usePalette: dedupUsePalette,
          });
          
          // 等待完成（最多等待 30 秒）
          const maxWaitTime = 30 * 1000;
          const startTime = Date.now();
          while (!dedupCompleted && !dedupError && (Date.now() - startTime) < maxWaitTime) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          
          if (dedupError) {
            throw new Error(dedupError);
          }
          
          if (!dedupCompleted) {
            throw new Error('去重操作超时');
          }
          
          return previewPath;
        } finally {
          unlisten();
        }
      } else if (activeTab === 'resize' && (resizeWidth !== dimensions.width || resizeHeight !== dimensions.height)) {
        // resize tab: 调用调整分辨率逻辑
        await invoke('resize_gif', {
          inputPath: inputPath,
          outputPath: previewPath,
          width: resizeWidth,
          height: resizeHeight,
          method: resizeMethod,
          optimize: false,
        });
        return previewPath;
      } else if (activeTab === 'segment' && isSliceOnlySelected) {
        // segment tab: 使用切片逻辑
        const sliceDelays = frames.slice(segmentRangeStart, segmentRangeEnd + 1).map(f => f.delay);
        await invoke('save_gif_slice', {
          inputPath: inputPath,
          outputPath: previewPath,
          startIndex: segmentRangeStart,
          endIndex: segmentRangeEnd,
          frameDelays: sliceDelays
        });
        return previewPath;
      }
    } catch (err) {
      console.error('[TEMP_DEBUG] 生成预览 GIF 失败:', err);
      return null;
    }
    
    return null;
  };

  const handleOpenPreview = async () => {
    const currentVersion = versions.find(v => v.id === currentVersionId);
    if (!currentVersion) return;

    setLoading(true);
    try {
      // 1. 尝试生成预览 GIF（如果有改动）
      let previewPath: string | null = null;
      try {
        previewPath = await generatePreviewGif();
      } catch (err) {
        console.warn('[TEMP_DEBUG] 生成预览 GIF 失败，使用原始文件:', err);
      }
      
      // 2. 确定要预览的文件路径
      let finalPath: string;
      if (previewPath) {
        finalPath = previewPath;
      } else {
        // 没有改动或生成失败，使用原始文件
        if (currentVersion.isOriginal) {
          finalPath = await ensureLocalSourcePath(currentVersion.path);
        } else {
          finalPath = currentVersion.path;
        }
      }

      // 3. 转换为可访问的 URL
      let gifUrl: string;
      const isLocalAbsolutePath = finalPath.startsWith('/') && !finalPath.startsWith('/gifs/');
      
      if (!isLocalAbsolutePath) {
        // Web 资源，直接使用
        gifUrl = finalPath;
      } else {
        // 本地文件，读取文件内容并创建 Blob URL（更可靠）
        try {
          const bytes = await invoke<number[]>('read_file_in_chunks', { path: finalPath, chunk_size: 1024 * 512, chunkSize: 1024 * 512 });
          const uint8Array = new Uint8Array(bytes);
          const blob = new Blob([uint8Array], { type: 'image/gif' });
          gifUrl = URL.createObjectURL(blob);
        } catch (readErr) {
          // 如果读取失败，尝试使用 convertFileSrc
          console.warn('[TEMP_DEBUG] 读取文件失败，尝试使用 convertFileSrc:', readErr);
          const { convertFileSrc } = await import('@tauri-apps/api/tauri');
          gifUrl = convertFileSrc(finalPath);
        }
      }

      // 4. 显示模态窗口
      console.log('[TEMP_DEBUG] 设置预览模态窗口 URL:', gifUrl);
      setPreviewModalGifUrl(gifUrl);
      console.log('[TEMP_DEBUG] 设置 showPreviewModal 为 true');
      setShowPreviewModal(true);

    } catch (err) {
      console.error('预览生成失败:', err);
      alert(t('preview.generateError', { error: String(err) }));
    } finally {
      setLoading(false);
    }
  };

  




  const handleLoadGif = async () => {
    let totalStartTime: number | undefined = undefined;
    try {
      // 动态导入 Tauri API
      const { open } = await import('@tauri-apps/api/dialog');
      
      // 打开文件选择对话框（不统计耗时，因为包含用户操作时间）
      const selectedPath = await open({
        filters: [{
          name: 'GIF Image',
          extensions: ['gif']
        }],
        multiple: false
      });
      
      if (!selectedPath || typeof selectedPath !== 'string') {
        return; // 用户取消或出错
      }
      
      // 从用户选定文件后开始统计总耗时
      totalStartTime = performance.now();
      console.log('[TEMP_DEBUG] Selected file:', selectedPath);
      
      setIsLoadingGif(true);
      setError(null);
      // 重置解压进度状态
      setExtractProgress({
        fullframes: { current: 0, total: 0 },
        previews: { current: 0, total: 0 },
      });
      setIsExtractPaused(false);
      setHasAutoPassedOnce(false); // 重置自动暂停标记
      
      const initWorkDirStartTime = performance.now();
      const workDirPath = await invoke<string>('init_work_dir');
      const initWorkDirDuration = performance.now() - initWorkDirStartTime;
      console.log(`[TEMP_DEBUG] 步骤: 初始化工作目录(强制新临时工作区), 耗时: ${initWorkDirDuration.toFixed(2)}ms`);
      setWorkDir(workDirPath);
      console.log('[TEMP_DEBUG] Work directory initialized (new temp):', workDirPath);
      // 清除工作区路径标记
      setLoadedWorkspacePath(null);
      try { 
        sessionStorage.setItem('hasUserLoadedGif', '1'); 
        sessionStorage.removeItem('loadedWorkspacePath');
        sessionStorage.setItem('tempWorkDirPath', workDirPath);
      } catch {}
      
      
      let fileSize = 0;
      let knownTotal = 0;
      try { knownTotal = await invoke<number>('get_file_size', { path: selectedPath }); } catch {}
      setGifLoadingProgress({ stage: 'read', current: 0, total: knownTotal || 1 });
      const fileName = selectedPath.split(/[/\\]/).pop() || 'image.gif';
      readingActiveRef.current = true;
      const copyFileStartTime = performance.now();
      const destPath = await invoke<string>('read_file_to_workdir', {
        src_path: selectedPath,
        srcPath: selectedPath,
        work_dir: workDirPath,
        workDir: workDirPath,
        filename: fileName,
        fileName: fileName,
        chunk_size: 1024 * 512,
        chunkSize: 1024 * 512,
      });
      const copyFileDuration = performance.now() - copyFileStartTime;
      console.log(`[TEMP_DEBUG] 步骤: 复制文件到工作目录, 耗时: ${copyFileDuration.toFixed(2)}ms (${(knownTotal / 1024 / 1024).toFixed(2)}MB)`);
      readingActiveRef.current = false;
      try { fileSize = await invoke<number>('get_file_size', { path: destPath }); } catch { fileSize = knownTotal || 0; }
      try { sessionStorage.setItem('lastGifPath', destPath); } catch {}
      try { sessionStorage.setItem('lastSourcePath', selectedPath); } catch {}
      try {
        const pre = await _tryLoadDiskCaches(workDirPath, destPath, selectedPath as string);
        if (pre.loadedPreview) {
          console.log('[TEMP_DEBUG] 命中磁盘缩略图缓存');
        }
        if (pre.loadedDelays) {
          console.log('[TEMP_DEBUG] 命中磁盘延迟缓存');
        }
      } catch {}
      
      // 调用 unified loader
      const { placeholders, dims, meta, fileSize: loadedFileSize } = await loadGifForEditing(destPath, workDirPath);
      
      // 更新状态
      setFrames(placeholders);
      setOriginalFrames(JSON.parse(JSON.stringify(placeholders.map((f: GifFrame) => ({ delay: f.delay })))));
      setDimensions(dims);
      setResizeWidth(dims.width || 0);
      setResizeHeight(dims.height || 0);
      setCurrentFrame(0);
      setRangeStart(0);
      setRangeEnd(placeholders.length - 1);
      setSegmentRangeStart(0);
      setSegmentRangeEnd(placeholders.length - 1);
      
      const totalDuration = placeholders.reduce((sum, f) => sum + f.delay, 0);
      const initialVersion: VersionItem = {
        id: 'original',
        name: fileName,
        path: destPath,
        timestamp: Date.now(),
        isOriginal: true,
        frameCount: meta.frame_count,
        duration: totalDuration,
        fileSize: loadedFileSize || fileSize,
        frameDelays: placeholders.map(f => f.delay),
      };
      setVersions([initialVersion]);
      setCurrentVersionId('original');
      setHasUnsavedChanges(false);

      // 计算并设置 GifStats
      const fpsList = meta.delays_ms.map(d => 1000 / (d || 10));
      const counts: Record<number, number> = {};
      fpsList.forEach(fps => {
        const rounded = Math.round(fps);
        counts[rounded] = (counts[rounded] || 0) + 1;
      });
      const sortedFps = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      
      const stats: GifStats = {
        frame_count: meta.frame_count,
        total_duration: totalDuration / 1000,
        avg_fps: totalDuration > 0 ? meta.frame_count / (totalDuration / 1000) : 0,
        min_fps: Math.min(...fpsList),
        max_fps: Math.max(...fpsList),
        file_size: loadedFileSize || fileSize,
        mode1_fps: sortedFps[0] ? Number(sortedFps[0][0]) : undefined,
        mode1_count: sortedFps[0] ? sortedFps[0][1] : undefined,
        mode2_fps: sortedFps[1] ? Number(sortedFps[1][0]) : undefined,
        mode2_count: sortedFps[1] ? sortedFps[1][1] : undefined,
      };
      setGifStats(stats);
            
      // 扫描临时目录下的其他 GIF 文件并添加到成果列表
      try {
        const otherGifs = await invoke<string[]>('read_dir_filenames', { path: workDirPath });
        const gifFiles = otherGifs.filter(name => {
          const lowerName = name.toLowerCase();
          // 排除临时文件（以 _temp_ 开头或包含 _temp_）
          const isTempFile = name.startsWith('_temp_') || name.includes('_temp_');
          // 只保留 .gif 文件
          const isGif = lowerName.endsWith('.gif');
          // 排除当前已加载的文件（通过文件名比较）
          const isCurrentFile = name === fileName;
          return isGif && !isTempFile && !isCurrentFile;
        });
        
        if (gifFiles.length > 0) {
          console.log('[TEMP_DEBUG] 发现临时目录下的其他 GIF 文件:', gifFiles);
          
          // 为每个 GIF 文件创建 VersionItem
          const otherVersions: VersionItem[] = [];
          for (const gifFile of gifFiles) {
            try {
              // 使用路径分隔符构建完整路径
              const gifPath = workDirPath.endsWith('/') || workDirPath.endsWith('\\') 
                ? `${workDirPath}${gifFile}` 
                : `${workDirPath}/${gifFile}`;
              
              // 规范化路径用于比较
              const normalizedGifPath = gifPath.replace(/\\/g, '/');
              const normalizedCurrentPath = initialVersion.path.replace(/\\/g, '/');
              
              // 检查是否已经在成果列表中
              if (normalizedGifPath === normalizedCurrentPath) {
                continue;
              }
              
              // 获取文件大小
              let fileSize = 0;
              try {
                fileSize = await invoke<number>('get_file_size', { path: gifPath });
              } catch {}
              
              // 获取 GIF 元数据
              try {
                const meta = await invoke<{ width: number; height: number; frame_count: number; delays_ms: number[]; preview_dir: string; preview_files: string[]; preview_width: number; preview_height: number }>('parse_gif_preview', {
                  gifPath: gifPath,
                  workDir: workDirPath,
                  maxPreview: 120,
                });
                
                const totalDuration = meta.delays_ms.reduce((sum: number, d: number) => sum + d, 0);
                const versionId = `workdir-${gifFile.replace(/[^a-zA-Z0-9]/g, '_')}-${Date.now()}`;
                otherVersions.push({
                  id: versionId,
                  name: gifFile,
                  path: gifPath,
                  timestamp: Date.now(),
                  isOriginal: false,
                  frameCount: meta.frame_count,
                  duration: totalDuration,
                  fileSize: fileSize,
                  frameDelays: meta.delays_ms,
                });
              } catch (err) {
                console.error(`[TEMP_DEBUG] 无法解析 GIF ${gifFile}:`, err);
              }
            } catch (err) {
              console.error(`[TEMP_DEBUG] 处理 GIF ${gifFile} 时出错:`, err);
            }
          }
          
          // 将其他 GIF 添加到成果列表
          if (otherVersions.length > 0) {
            setVersions(prev => {
              const existingPaths = new Set(prev.map(v => v.path));
              const newVersions = otherVersions.filter(v => !existingPaths.has(v.path));
              if (newVersions.length > 0) {
                return [prev[0], ...newVersions, ...prev.slice(1)];
              }
              return prev;
            });
            console.log('[TEMP_DEBUG] 已将', otherVersions.length, '个其他 GIF 添加到成果列表');
          }
        }
      } catch (err) {
        console.error('[TEMP_DEBUG] 扫描临时目录失败:', err);
      }
      
      // 界面完全显示
      setLoading(false);
      setIsLoadingGif(false);
      setGifLoadingProgress(null);
      
    } catch (err) {
      if (totalStartTime !== undefined) {
        const totalDuration_ms = performance.now() - totalStartTime;
        console.error(`[TEMP_DEBUG] GIF 载入失败, 总耗时: ${totalDuration_ms.toFixed(2)}ms`);
      }
      console.error('加载 GIF 失败:', err);
      setError(t('common.loadGifError', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      
    }
  };

  // 清理资源
  useEffect(() => {
    return () => {
      console.log('[清理] 资源已清理');
    };
  }, []);

  // 保存工作区
  const handleSaveWorkspace = async () => {
    if (versions.length === 0) {
      alert(t('workspace.noVersions'));
      return;
    }

    try {
      const { open } = await import('@tauri-apps/api/dialog');
      const { createDir, exists } = await import('@tauri-apps/api/fs');
      
      // 1. 选择目标目录
      const selectedDir = await open({
        directory: true,
        multiple: false,
        title: t('workspace.selectDir')
      });

      if (!selectedDir || typeof selectedDir !== 'string') {
        return;
      }

      // 2. 创建带时间戳的子目录
      const originalVersion = versions.find(v => v.isOriginal);
      const baseName = originalVersion?.name.replace(/\.gif$/i, '') || 'workspace';
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const workspaceDirName = `${baseName}_${timestamp}`;
      const workspacePath = `${selectedDir}/${workspaceDirName}`;

      console.log('[TEMP_DEBUG] Creating workspace directory:', workspacePath);
      await createDir(workspacePath);
      try { sessionStorage.setItem('hasUserLoadedGif', '1'); } catch {}
      

      // 3. 复制成果文件
      let savedCount = 0;
      
      const savedVersionsOrder: string[] = [];

      for (const version of versions) {
        // 确定源文件路径
        let sourcePath = version.path;
        
        // 检查是否为本地绝对路径
        const isLocalAbsolutePath = version.path.startsWith('/') && !version.path.startsWith('/gifs/');
        
        // 如果是原始文件且在 Web 资源中（非本地绝对路径），需要先下载或查找临时文件
        if (version.isOriginal && version.path.startsWith('/') && !isLocalAbsolutePath) {
           // 这里简化处理：如果原始文件还没下载到本地，先尝试从 workDir 找
           const originalFileName = version.path.split('/').pop() || 'original.gif';
           const tempPath = `${workDir}/${originalFileName}`;
           
           if (await exists(tempPath)) {
             sourcePath = tempPath;
           } else {
             // 如果还没有本地副本，尝试下载
             console.warn('[TEMP_DEBUG] Original file might be missing locally:', version.path);
             // 尝试继续，可能会失败
           }
        }
        // 如果已经是本地绝对路径（例如从工作区加载的），直接使用 version.path 即可

        // 生成目标文件名
        const fileName = version.name.endsWith('.gif') ? version.name : `${version.name}.gif`;
        // 清理文件名中的非法字符
        const safeFileName = fileName.replace(/[\/\\:*?"<>|]/g, '_');
        const destPath = `${workspacePath}/${safeFileName}`;

        try {
          // 复制文件
          // 注意：如果 sourcePath 是 http URL（未处理的默认文件），copyFile 会失败
          // 这里我们假设所有成果在列表中都有有效的本地路径（或 workDir 中的路径）
          
          if (version.isOriginal && version.path.startsWith('http')) {
             // 处理 URL 类型的路径
             console.log('[TEMP_DEBUG] Downloading original from URL for workspace:', version.path);
             const response = await fetch(version.path);
             const blob = await response.blob();
             const arrayBuffer = await blob.arrayBuffer();
             const uint8Array = new Uint8Array(arrayBuffer);
             
             await invoke('write_file_to_path', {
               path: destPath,
               data: Array.from(uint8Array)
             });
          } else {
             // 本地文件复制
             await invoke('save_file', {
                sourcePath: sourcePath,
                destPath: destPath
             });
          }
          
          savedVersionsOrder.push(safeFileName);
          savedCount++;
        } catch (err) {
          console.error(`[TEMP_DEBUG] Failed to save version ${version.name}:`, err);
        }
      }

      // 4. 保存配置文件 .gifcut
      try {
        const { dump } = await import('js-yaml');
        
        // 找到原始文件名称
        const originalVersion = versions.find(v => v.isOriginal);
        let originalFileName = null;
        
        if (originalVersion) {
          // 如果原始文件名在保存列表中，直接使用
          const fileName = originalVersion.name.endsWith('.gif') ? originalVersion.name : `${originalVersion.name}.gif`;
          const safeFileName = fileName.replace(/[\/\\:*?"<>|]/g, '_');
          if (savedVersionsOrder.includes(safeFileName)) {
            originalFileName = safeFileName;
          }
        }
        
        const config = {
          order: savedVersionsOrder,
          original_file: originalFileName,
          timestamp: new Date().toISOString(),
          total_files: savedCount
        };
        
        const yamlContent = dump(config);
        const configPath = `${workspacePath}/.gifcut`;
        
        // 将字符串转换为 Uint8Array
        const encoder = new TextEncoder();
        const data = encoder.encode(yamlContent);
        
        await invoke('write_file_to_path', {
          path: configPath,
          data: Array.from(data)
        });
        
        console.log('[TEMP_DEBUG] Saved .gifcut config:', config);
      } catch (yamlErr) {
        console.error('保存配置文件失败:', yamlErr);
        // 不阻断主流程
      }

      // 5. 复制缓存与未优化文件
      try {
        const { readDir } = await import('@tauri-apps/api/fs');
        const entries = await readDir(workDir);
        for (const entry of entries) {
          const name = entry.name || '';
          if (!name) continue;
          
          // 检查目录：previews 和 fullframes
          // 注意：readDir 非递归模式下 entry.children 可能为 undefined，所以我们通过名字匹配来尝试复制
          if (name === 'previews' || name === 'fullframes') {
            const srcDir = `${workDir}/${name}`;
            const dstDir = `${workspacePath}/${name}`;
            try {
              await invoke('copy_dir_recursive', { sourceDir: srcDir, destDir: dstDir });
              console.log('[TEMP_DEBUG] Copied cache dir:', name);
            } catch (err) {
              console.warn(`[TEMP_DEBUG] Failed to copy dir ${name}:`, err);
            }
            continue;
          }

          // 检查缓存文件
          // 只要以特定后缀结尾，就尝试复制
          if (name.endsWith('_temp_color_restored.gif') || name.endsWith('_temp_unoptimized.gif')) {
            const src = `${workDir}/${name}`;
            const dst = `${workspacePath}/${name}`;
            try {
              await invoke('save_file', { sourcePath: src, destPath: dst });
              console.log('[TEMP_DEBUG] Copied cache file:', name);
            } catch (err) {
               console.warn(`[TEMP_DEBUG] Failed to copy file ${name}:`, err);
            }
          }
        }
      } catch (cacheErr) {
        console.warn('[TEMP_DEBUG] 复制缓存失败:', cacheErr);
      }

      alert(t('workspace.saveSuccess', { path: workspacePath, count: savedCount }));

      // 自动载入新保存的工作区
      await loadWorkspaceFromPath(workspacePath);

    } catch (err) {
      console.error('保存工作区失败:', err);
      alert(t('workspace.saveError', { error: err instanceof Error ? err.message : String(err) }));
    }
  };

  // 载入工作区
  const loadWorkspaceFromPath = async (selectedDir: string, options?: { isTemp?: boolean, originalPath?: string }) => {
    try {
      const { readDir } = await import('@tauri-apps/api/fs');
      
      setIsLoadingWorkspace(true); // 使用专门的加载状态
      // 重置解压进度状态
      setExtractProgress({
        fullframes: { current: 0, total: 0 },
        previews: { current: 0, total: 0 },
      });
      setIsExtractPaused(false);
      setHasAutoPassedOnce(false); // 重置自动暂停标记
      // 强制渲染 loading 状态
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // 2. 读取目录下的所有 GIF 文件
      console.log('[TEMP_DEBUG] Reading directory:', selectedDir);
      const entries = await readDir(selectedDir);
      console.log('[TEMP_DEBUG] Directory entries:', entries.map(e => e.name));
      
      const allGifEntries = entries.filter(entry => 
        entry.name && entry.name.toLowerCase().endsWith('.gif') && !entry.children && !entry.name.includes('_temp_')
      );

      // 延后空列表判断到选择完成后

      // 尝试读取 .gifcut 配置文件
      let fileOrder: string[] = [];
      let originalFileName: string | null = null;
      
      console.log('[TEMP_DEBUG] Starting config load process...');
      
      try {
        const { load } = await import('js-yaml');
        // const { readTextFile, exists } = await import('@tauri-apps/api/fs');
        // 确保路径分隔符正确
        const configPath = selectedDir.endsWith('/') 
          ? `${selectedDir}.gifcut` 
          : `${selectedDir}/.gifcut`;
        
        console.log('[TEMP_DEBUG] Checking config path:', configPath);
        
        // 尝试直接读取文件，如果文件不存在会抛出错误
        // Tauri 的 exists API 有时可能会有问题，或者权限问题
        try {
          console.log('[TEMP_DEBUG] Attempting to read config file directly via Rust backend...');
          // 使用 Rust 后端读取文件，绕过前端 Scope 限制
          const configContent = await invoke<string>('read_text_file', { path: configPath });
          
          console.log('[TEMP_DEBUG] Config content read. Length:', configContent.length);
          console.log('[TEMP_DEBUG] Config content snippet:', configContent.substring(0, 100));
          
          try {
            const config = load(configContent) as any;
            console.log('[TEMP_DEBUG] Parsed config object:', JSON.stringify(config, null, 2));
            
            if (config) {
              if (Array.isArray(config.order)) {
                fileOrder = config.order;
                console.log('[TEMP_DEBUG] File order loaded:', fileOrder);
              } else {
                console.warn('[TEMP_DEBUG] Config has no "order" array');
              }
              
              if (config.original_file) {
                originalFileName = config.original_file;
                console.log('[TEMP_DEBUG] Original file loaded:', originalFileName);
              } else {
                console.warn('[TEMP_DEBUG] Config has no "original_file" field');
              }
            } else {
              console.warn('[TEMP_DEBUG] Parsed config is null or undefined');
            }
          } catch (parseErr) {
            console.error('[TEMP_DEBUG] YAML parse error:', parseErr);
          }
        } catch (readErr) {
          console.log('[TEMP_DEBUG] Failed to read config file via Rust backend:', readErr);
          // 这种情况下通常是因为文件确实不存在
          console.log('[TEMP_DEBUG] Assuming no config file exists or access denied even for backend.');
        }
      } catch (configErr) {
        console.error('[TEMP_DEBUG] Critical error during config loading:', configErr);
      }

      // 3. 重新初始化应用状态
      // 将工作目录设置为用户选择的工作区目录
      const workDirPath = selectedDir;
      setWorkDir(workDirPath);
      
      if (!options?.isTemp) {
        // 记录当前载入的工作区路径
        setLoadedWorkspacePath(selectedDir);
        try {
          sessionStorage.setItem('loadedWorkspacePath', selectedDir);
          sessionStorage.setItem('hasUserLoadedGif', '1');
        } catch (e) {
          console.warn('[TEMP_DEBUG] Failed to save workspace path to session:', e);
        }
      }
      
      // 4. 选择要加载的 GIF 列表
      // 如果没有配置文件且提供了原始文件路径，设置原始文件名
      if (!originalFileName && options?.originalPath) {
        originalFileName = options.originalPath.split(/[/\\]/).pop() || null;
      }

      let gifEntries = allGifEntries;
      if (fileOrder.length > 0) {
        const matchEntryByName = (target: string) => {
          const normalizedTarget = target.normalize();
          const lowerTarget = normalizedTarget.toLowerCase();
          const safeTarget = normalizedTarget.replace(/[\/\\:*?"<>|]/g, '_');
          return allGifEntries.find(e => {
            const name = (e.name || '').normalize();
            const lower = name.toLowerCase();
            const safe = name.replace(/[\/\\:*?"<>|]/g, '_');
            return name === normalizedTarget || lower === lowerTarget || safe === safeTarget;
          }) || null;
        };
        gifEntries = fileOrder.map(n => matchEntryByName(n)).filter((e): e is typeof allGifEntries[number] => !!e);
      } else {
        gifEntries = allGifEntries.filter(e => {
          const n = (e.name || '').toLowerCase();
          return !n.includes('temp_color_restored') && !n.includes('temp_unoptimized');
        });
      }
      console.log('[TEMP_DEBUG] GIF entries selected:', gifEntries.map(e => e.name));
      if (gifEntries.length === 0) {
        alert(t('workspace.noGifsFound'));
        setLoading(false);
        return;
      }

      // 5. 加载所有文件为成果
      const loadedVersions: VersionItem[] = [];
      let firstLoadedFrames: GifFrame[] | null = null;
      let firstLoadedDims = { width: 0, height: 0 };

      // 按配置文件顺序排序
      gifEntries.sort((a, b) => {
        const nameA = (a.name || '').normalize();
        const nameB = (b.name || '').normalize();
        
        // 尝试精确匹配，如果不行尝试忽略 NFC/NFD 差异
        // 还要尝试将当前文件名转换为安全文件名后再匹配
        // 最后尝试忽略大小写
        const safeNameA = nameA.replace(/[\/\\:*?"<>|]/g, '_');
        const lowerNameA = nameA.toLowerCase();
        
        let indexA = fileOrder.indexOf(nameA);
        if (indexA === -1) indexA = fileOrder.findIndex(f => f.normalize() === nameA);
        if (indexA === -1) indexA = fileOrder.indexOf(safeNameA);
        if (indexA === -1) indexA = fileOrder.findIndex(f => f.toLowerCase() === lowerNameA);
        
        const safeNameB = nameB.replace(/[\/\\:*?"<>|]/g, '_');
        const lowerNameB = nameB.toLowerCase();

        let indexB = fileOrder.indexOf(nameB);
        if (indexB === -1) indexB = fileOrder.findIndex(f => f.normalize() === nameB);
        if (indexB === -1) indexB = fileOrder.indexOf(safeNameB);
        if (indexB === -1) indexB = fileOrder.findIndex(f => f.toLowerCase() === lowerNameB);
        
        // 如果两个都在列表中，按列表顺序
        if (indexA !== -1 && indexB !== -1) {
          return indexA - indexB;
        }
        
        // 如果只有 A 在列表中，A 排在前面
        if (indexA !== -1) return -1;
        
        // 如果只有 B 在列表中，B 排在前面
        if (indexB !== -1) return 1;
        
        // 都不在列表中，按字母顺序
        return nameA.localeCompare(nameB);
      });

      let __entryIndex = 0;
      for (const entry of gifEntries) {
        if (!entry.path || !entry.name) continue;
        
        try {
          let fileSize = 0;
          try { fileSize = await invoke<number>('get_file_size', { path: entry.path }); } catch {}
          const destPath = entry.path;
          const isFirstEntry = __entryIndex === 0;
          
          if (isFirstEntry) {
            setGifLoadingProgress({ stage: 'read', current: 0, total: 1 });
          }
          
          let dims: { width: number; height: number } = { width: 0, height: 0 };
          let frames: GifFrame[] = [];
          let frameDelays: number[] = [];
          let frameCount = 0;
          let totalDuration = 0;
          
          if (isFirstEntry && !firstLoadedFrames) {
             const { placeholders, dims: loadedDims, meta } = await loadGifForEditing(destPath, workDirPath);
             frames = placeholders;
             dims = loadedDims;
             frameDelays = meta.delays_ms;
             frameCount = meta.frame_count;
             totalDuration = placeholders.reduce((sum, f) => sum + f.delay, 0);
          } else {
             // 其他文件只获取元数据
             try {
                const meta = await invoke<{ width: number; height: number; frame_count: number; delays_ms: number[] }>('parse_gif_preview', {
                  gifPath: destPath,
                  workDir: workDirPath,
                  maxPreview: 1, 
                });
                frameDelays = meta.delays_ms;
                frameCount = meta.frame_count;
                totalDuration = frameDelays.reduce((sum, d) => sum + d, 0);
                try { _global_delay_cache.set(destPath, meta.delays_ms); } catch {}
             } catch (e) {
                console.warn('[TEMP_DEBUG] Failed to parse meta for', destPath, e);
             }
          }

          if (isFirstEntry && !firstLoadedFrames) {
            firstLoadedFrames = frames;
            firstLoadedDims = dims;
          }

          // 判断是否为原始文件
          // 1. 如果配置文件指定了原始文件，且当前文件名匹配
          // 2. 如果没有配置文件，且是列表中的第一个文件
          let isOriginal = false;
          if (originalFileName) {
            const entryName = (entry.name || '').normalize();
            const safeEntryName = entryName.replace(/[\/\\:*?"<>|]/g, '_');
            const targetName = originalFileName.normalize();
            
            // 尝试直接匹配和安全文件名匹配
            // 如果还不行，尝试忽略大小写匹配
            const isExactMatch = entryName === targetName;
            const isSafeMatch = safeEntryName === targetName;
            const isCaseInsensitiveMatch = entryName.toLowerCase() === targetName.toLowerCase();
            
            isOriginal = isExactMatch || isSafeMatch || isCaseInsensitiveMatch;
            console.log(`[TEMP_DEBUG] Checking original: "${entryName}" vs "${targetName}" -> exact:${isExactMatch}, safe:${isSafeMatch}, case:${isCaseInsensitiveMatch} => ${isOriginal}`);
          } else {
            isOriginal = loadedVersions.length === 0;
          }
          
          loadedVersions.push({
            id: `version-loaded-${Date.now()}-${loadedVersions.length}`,
            name: entry.name, // 保持文件名作为成果名
            path: destPath,
            timestamp: Date.now(),
            isOriginal: isOriginal,
            frameCount: frameCount,
            duration: totalDuration,
            fileSize: fileSize,
            frameDelays: frameDelays,
          });
          
        } catch (err) {
          console.error(`[TEMP_DEBUG] Failed to load file ${entry.name}:`, err);
        }
        __entryIndex++;
      }

      if (loadedVersions.length > 0 && firstLoadedFrames) {
        // 更新状态
        setVersions(loadedVersions);
        setCurrentVersionId(loadedVersions[0].id);
        setFrames(firstLoadedFrames);
        setOriginalFrames(JSON.parse(JSON.stringify(firstLoadedFrames.map(f => ({ delay: f.delay })))));
        setDimensions(firstLoadedDims);
        setResizeWidth(firstLoadedDims.width || 0);
        setResizeHeight(firstLoadedDims.height || 0);
        setCurrentFrame(0);
        setRangeStart(0);
        setRangeEnd(firstLoadedFrames.length - 1);
        setSegmentRangeStart(0);
        setSegmentRangeEnd(firstLoadedFrames.length - 1);
        setHasUnsavedChanges(false);
        
        // 手动设置统计信息，而不是调用 handleSelectVersion
        // 因为 state 更新是异步的，此时 handleSelectVersion 找不到 version
        const fps = firstLoadedFrames.map(f => 1000 / f.delay);
        const fpsCounts: { [key: string]: number } = {};
        fps.forEach(f => {
          const key = Math.round(f).toString();
          fpsCounts[key] = (fpsCounts[key] || 0) + 1;
        });
        const sortedFps = Object.entries(fpsCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([fps, count]) => [parseInt(fps), count]);

        const initialStats: GifStats = {
          frame_count: firstLoadedFrames.length,
          total_duration: firstLoadedFrames.reduce((sum, f) => sum + f.delay, 0) / 1000,
          avg_fps: 1000 / (firstLoadedFrames.reduce((sum, f) => sum + f.delay, 0) / firstLoadedFrames.length),
          min_fps: Math.min(...fps),
          max_fps: Math.max(...fps),
          file_size: loadedVersions[0].fileSize || 0,
          mode1_fps: sortedFps[0] ? sortedFps[0][0] : undefined,
          mode1_count: sortedFps[0] ? sortedFps[0][1] : undefined,
          mode2_fps: sortedFps[1] ? sortedFps[1][0] : undefined,
          mode2_count: sortedFps[1] ? sortedFps[1][1] : undefined,
        };
        setGifStats(initialStats);
        
        // 异步加载详细统计信息 (Gifsicle)
        const firstVersion = loadedVersions[0];
        setTimeout(() => {
          setIsLoadingStats(true);
          (async () => {
            try {
              let statsGifPath = firstVersion.path;
              if (firstVersion.isOriginal) {
                // 如果是原始文件，确保它在本地可访问（对于工作区载入，path 已经是本地路径）
                // 不需要像 Web 资源那样下载
              }
              
              const { invoke } = await import('@tauri-apps/api/tauri');
              const gifsicleStats = await invoke<any>('get_gif_stats', { gif_path: statsGifPath, gifPath: statsGifPath });
              console.log('[TEMP_DEBUG] Gifsicle stats for first version:', gifsicleStats);
              
              setGifStats(prev => prev ? ({
                ...prev,
                file_size: gifsicleStats.file_size,
                // 可以根据需要更新其他字段
              }) : prev);
            } catch (err) {
              console.warn('[TEMP_DEBUG] Failed to get gifsicle stats:', err);
            } finally {
              setIsLoadingStats(false);
            }
          })();
        }, 100);
        
        console.log(`成功载入工作区: ${loadedVersions.length} 个成果`);
      } else {
        alert(t('workspace.noValidGifs'));
      }

    } catch (err) {
      console.error('载入工作区失败:', err);
      alert(t('workspace.loadError', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setIsLoadingWorkspace(false);
      setLoading(false);
    }
  };

  // 载入工作区按钮处理函数
  const handleLoadWorkspace = async () => {
    const { open } = await import('@tauri-apps/api/dialog');
    
    // 1. 选择工作区目录
    const selectedDir = await open({
      directory: true,
      multiple: false,
      title: t('workspace.selectLoadDir')
    });

    if (!selectedDir || typeof selectedDir !== 'string') {
      return;
    }

    await loadWorkspaceFromPath(selectedDir);
  };

  const handleExport = async () => {
    const currentVersion = versions.find(v => v.id === currentVersionId);
    if (!currentVersion) {
      alert(t('versions.noSelection'));
      return;
    }

    try {
      // 动态导入 Tauri API
      const { save } = await import('@tauri-apps/api/dialog');

      // 生成默认文件名
      let defaultName = currentVersion.name;
      if (!defaultName.toLowerCase().endsWith('.gif')) {
        defaultName += '.gif';
      }
      // 如果是原始文件，尝试从路径中提取文件名
      if (currentVersion.isOriginal) {
        const originalName = currentVersion.path.split('/').pop();
        if (originalName) defaultName = originalName;
      }

      // 打开保存对话框
      const savePath = await save({
        defaultPath: defaultName,
        filters: [{
          name: 'GIF Image',
          extensions: ['gif']
        }]
      });

      if (!savePath) {
        return; // 用户取消
      }

      console.log('[TEMP_DEBUG] Exporting to:', savePath);

      // 确定源文件并复制/写入
      if (currentVersion.isOriginal) {
        // 原始文件可能在 Web 资源中，也可能已经下载到 temp
        // 检查是否已经下载
        
        
        // 使用 exists 检查可能不可靠（受 scope 限制），直接尝试通过 Rust 命令处理
        // 如果文件在 workDir 中，我们可以直接复制
        // 但我们不确定 exists 是否返回正确结果
        // 既然我们知道 tempOriginalPath 路径，我们可以尝试让 Rust 检查文件是否存在
        
        // 简单起见，如果是原始文件且来自 public 目录，我们重新下载并写入
        // 如果已经下载过，可以优化，但重新下载是最安全的路径
        
        console.log('[TEMP_DEBUG] Downloading original file from URL:', currentVersion.path);
        const response = await fetch(currentVersion.path);
        if (!response.ok) throw new Error(t('common.downloadFailed', { status: response.statusText }));
        
        const blob = await response.blob();
        const arrayBuffer = await blob.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        const fileData = Array.from(uint8Array);
        
        // 使用 Rust 命令写入文件（绕过 fs scope 限制）
        await invoke('write_file_to_path', {
          path: savePath,
          data: fileData
        });
      } else {
        // 生成的成果，路径应该是本地绝对路径
        console.log('[TEMP_DEBUG] Copying generated file from:', currentVersion.path);
        
        // 使用 Rust 命令复制文件（绕过 fs scope 限制）
        await invoke('save_file', {
          sourcePath: currentVersion.path,
          destPath: savePath
        });
      }

      alert(t('versions.exportSuccess', { path: savePath }));
      
    } catch (err) {
      console.error('导出失败:', err);
      alert(t('versions.exportError', { error: err instanceof Error ? err.message : String(err) }));
    }
  };

  const handleSliceSave = async () => {
    const currentVersion = versions.find(v => v.id === currentVersionId);
    if (!currentVersion) return;

    setIsApplyingChanges(true);

    try {
      // 1. 准备输入文件路径
      let inputPath: string;
      if (currentVersion.isOriginal) {
        const originalFileName = currentVersion.path.split('/').pop() || 'original.gif';
        inputPath = `${workDir}/${originalFileName}`;
        
        // 确保原始文件在本地可用
        try {
             const isLocalPath = currentVersion.path.startsWith('/') && !currentVersion.path.startsWith('/gifs/');
             const isWebResource = currentVersion.path.startsWith('http') || currentVersion.path.startsWith('/gifs/');

             if (isWebResource) {
                 console.log('[TEMP_DEBUG] Downloading resource for slicing:', currentVersion.path);
                 const response = await fetch(currentVersion.path);
                 const blob = await response.blob();
                 const arrayBuffer = await blob.arrayBuffer();
                 const uint8Array = new Uint8Array(arrayBuffer);
                 
                 // 写入到工作目录
                 await invoke('write_binary_file', {
                    workDir: workDir,
                    filename: originalFileName,
                    data: Array.from(uint8Array),
                 });
                 // inputPath 已经在上面设置为 workDir 中的路径了
             } else if (isLocalPath) {
                 // 如果已经是本地绝对路径（非 web 资源），直接使用
                 inputPath = currentVersion.path;
             }
        } catch (e) {
            console.error('准备原始文件失败:', e);
            throw e;
        }
      } else {
        inputPath = currentVersion.path;
      }

      // 2. 计算切片方案
      interface SlicePlan {
        start: number;
        end: number;
        suffix: string;
      }
      let slices: SlicePlan[] = [];
      const S = segmentRangeStart;
      const E = segmentRangeEnd;
      const L = frames.length - 1;

      if (isSliceOnlySelected) {
        slices.push({ start: S, end: E, suffix: '_selected' });
      } else {
        if (S === E) {
            // 重叠情况
            if (S > 0 && S < L) {
                // 切为两段：[0, S-1] 和 [S, L]
                slices.push({ start: 0, end: S - 1, suffix: '_part1' });
                slices.push({ start: S, end: L, suffix: '_part2' });
            } else {
                alert(t('segment.noSliceNeeded'));
                setIsApplyingChanges(false);
                return;
            }
        } else if (S < E) {
            // 范围情况，切为三段（如果存在）
            if (S > 0) {
                slices.push({ start: 0, end: S - 1, suffix: '_part1' });
            }
            slices.push({ start: S, end: E, suffix: '_part2' });
            if (E < L) {
                slices.push({ start: E + 1, end: L, suffix: '_part3' });
            }
        }
      }

      if (slices.length === 0) {
          alert(t('segment.invalidRange'));
          setIsApplyingChanges(false);
          return;
      }

      // 3. 执行切片
       let newVersionsCount = 0;
       const baseName = currentVersion.name.replace(/\.gif$/i, '');
       const timestamp = Date.now();
       const createdVersions: VersionItem[] = [];
 
       for (let i = 0; i < slices.length; i++) {
           const slice = slices[i];
           const sliceDelays = frames.slice(slice.start, slice.end + 1).map(f => f.delay);
           
           // 按照用户要求命名：原文件名-切片-序号
           // 如果只有一段切片，序号为 1；如果有多个切片，序号递增
           const suffix = slices.length > 1 ? `-slice-${i + 1}` : '-slice-1';
           
           // 检查文件名是否已存在，避免覆盖
           let newFileName = `${baseName}${suffix}.gif`;
           let counter = 1;
           // 简单的冲突检测：检查当前成果列表
           while (versions.some(v => v.name === newFileName) || createdVersions.some(v => v.name === newFileName)) {
             newFileName = `${baseName}${suffix}-${counter}.gif`;
             counter++;
           }

           const safeFileName = newFileName.replace(/[\/\\:*?"<>|]/g, '_');
           
           // 决定输出路径
           let outputDir = workDir;
           if (loadedWorkspacePath) {
               outputDir = loadedWorkspacePath;
           }
           const outputPath = `${outputDir}/${safeFileName}`;
 
           console.log(`[TEMP_DEBUG] Slicing: ${slice.start}-${slice.end} -> ${outputPath}`);
           console.log(`[TEMP_DEBUG] Input path: ${inputPath}`);
           
          try {
            await invoke('save_gif_slice', {
                inputPath: inputPath,
                outputPath: outputPath,
                startIndex: slice.start,
                endIndex: slice.end,
                frameDelays: sliceDelays,
                optimize: reOptimizeAfterSlice
            });
            console.log(`[TEMP_DEBUG] Slice created successfully: ${outputPath}`);
          } catch (sliceErr) {
            console.error(`[TEMP_DEBUG] Failed to create slice:`, sliceErr);
            throw new Error(t('segment.createError', { start: slice.start, end: slice.end, error: String(sliceErr) }));
          }
 
           // 获取文件大小
           let fileSize = 0;
           try {
               fileSize = await invoke<number>('get_file_size', { path: outputPath });
           } catch (e) {
               console.warn('获取文件大小失败:', e);
           }
 
           // 创建成果对象
           const newVersion: VersionItem = {
               id: `version-slice-${timestamp}-${newVersionsCount}`,
               name: newFileName,
               path: outputPath,
               timestamp: Date.now() + newVersionsCount,
               isOriginal: false,
               frameCount: slice.end - slice.start + 1,
               duration: sliceDelays.reduce((a, b) => a + b, 0),
               fileSize: fileSize,
               frameDelays: sliceDelays
           };
           createdVersions.push(newVersion);
           newVersionsCount++;
       }

      // 4. 更新成果列表
      setVersions(prev => [...prev, ...createdVersions]);
      
      // 5. 如果在工作区，更新配置文件
      if (loadedWorkspacePath && createdVersions.length > 0) {
          try {
            const { dump } = await import('js-yaml');
            // 构建当前文件列表（包含新生成的）
            const currentOrder = versions.map(v => v.name.endsWith('.gif') ? v.name : `${v.name}.gif`);
            createdVersions.forEach(v => currentOrder.push(v.name));
            const safeOrder = currentOrder.map(name => name.replace(/[\/\\:*?"<>|]/g, '_'));
            
            // 找到原始文件名
            const originalVersion = versions.find(v => v.isOriginal);
            let safeOriginalName = null;
            if (originalVersion) {
                const origName = originalVersion.name.endsWith('.gif') ? originalVersion.name : `${originalVersion.name}.gif`;
                safeOriginalName = origName.replace(/[\/\\:*?"<>|]/g, '_');
            }

            const config = {
                order: safeOrder,
                original_file: safeOriginalName,
                timestamp: new Date().toISOString(),
                total_files: safeOrder.length
            };
            
            const yamlContent = dump(config);
            const configPath = loadedWorkspacePath.endsWith('/') 
                ? `${loadedWorkspacePath}.gifcut` 
                : `${loadedWorkspacePath}/.gifcut`;
            
            const encoder = new TextEncoder();
            await invoke('write_file_to_path', {
                path: configPath,
                data: Array.from(encoder.encode(yamlContent))
            });
          } catch (err) {
              console.warn('更新配置文件失败:', err);
          }
      }

      alert(t('segment.successSlice', { count: newVersionsCount }));

    } catch (err) {
      console.error('切片保存失败:', err);
      alert(t('segment.saveError', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setIsApplyingChanges(false);
    }
  };

  const handleApplyDedup = async () => {
    const currentVersion = versions.find(v => v.id === currentVersionId);
    if (!currentVersion) return;

    setIsApplyingDedup(true);

    try {
      // 1. 准备输入文件路径
      let inputPath: string;
      if (currentVersion.isOriginal) {
        const originalFileName = currentVersion.path.split('/').pop() || 'original.gif';
        inputPath = `${workDir}/${originalFileName}`;
        
        // 确保原始文件在本地可用
        try {
          const isLocalPath = currentVersion.path.startsWith('/') && !currentVersion.path.startsWith('/gifs/');
          const isWebResource = currentVersion.path.startsWith('http') || currentVersion.path.startsWith('/gifs/');

          if (isWebResource) {
            console.log('[TEMP_DEBUG] Downloading resource for dedup:', currentVersion.path);
            const response = await fetch(currentVersion.path);
            const blob = await response.blob();
            const arrayBuffer = await blob.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            
            await invoke('write_binary_file', {
              workDir: workDir,
              filename: originalFileName,
              data: Array.from(uint8Array),
            });
          } else if (isLocalPath) {
            inputPath = currentVersion.path;
          }
        } catch (e) {
          console.error('准备原始文件失败:', e);
          throw e;
        }
      } else {
        inputPath = currentVersion.path;
      }

      // 2. 生成输出文件名
      const baseName = currentVersion.name.replace(/\.gif$/i, '');
      let counter = 1;
      let newFileName = `${baseName}-dedup-${counter}.gif`;
      
      while (versions.some(v => v.name === newFileName)) {
        counter++;
        newFileName = `${baseName}-dedup-${counter}.gif`;
      }

      const safeFileName = newFileName.replace(/[\/\\:*?"<>|]/g, '_');
      
      // 决定输出路径
      let outputDir = workDir;
      if (loadedWorkspacePath) {
        outputDir = loadedWorkspacePath;
      }
      const outputPath = `${outputDir}/${safeFileName}`;

      console.log(`[TEMP_DEBUG] Deduplicating: ${inputPath} -> ${outputPath}`);
      console.log(`[TEMP_DEBUG] Parameters: quality=${dedupQuality}, threshold=${dedupThreshold}, colors=${dedupColors}, palette=${dedupUsePalette}`);

      // 先设置初始进度
      console.log('[TEMP_DEBUG] Setting initial progress state');
      setDedupProgress({ stage: 'starting', message: '准备开始...', current: undefined, total: undefined, details: undefined });
      
      // 稍等一下确保 UI 更新和事件监听器就绪
      console.log('[TEMP_DEBUG] Waiting for UI and listener to be ready...');
      // 使用 requestAnimationFrame 确保 UI 已经渲染
      await new Promise(resolve => requestAnimationFrame(resolve));
      await new Promise(resolve => setTimeout(resolve, 50));
      console.log('[TEMP_DEBUG] Ready to invoke dedup_gif');

      // 3. 调用去重命令（确保 colors 不超过 256）
      // 注意：命令会立即返回，实际处理在后台线程进行
      // 我们需要监听完成事件来知道何时处理完成
      let dedupCompleted = false;
      let dedupError: string | null = null;
      
      // 设置完成监听器
      const unlistenPromise = listen<{
        stage: string;
        message: string;
        current?: number;
        total?: number;
        details?: string;
      }>('dedup-progress', (event) => {
        if (event.payload.stage === 'complete') {
          dedupCompleted = true;
          console.log('[TEMP_DEBUG] Dedup completed via event');
        } else if (event.payload.stage === 'error') {
          dedupError = event.payload.message;
          console.log('[TEMP_DEBUG] Dedup error via event:', dedupError);
        }
      });
      
      const tempUnlisten = await unlistenPromise;
      
      try {
        // 调用命令（立即返回）
        await invoke('dedup_gif', {
          inputPath: inputPath,
          outputPath: outputPath,
          quality: dedupQuality,
          threshold: dedupThreshold,
          colors: Math.min(dedupColors, 256),
          usePalette: dedupUsePalette,
        });
        
        // 等待完成或错误（最多等待 5 分钟）
        const maxWaitTime = 5 * 60 * 1000; // 5 分钟
        const startTime = Date.now();
        while (!dedupCompleted && !dedupError && (Date.now() - startTime) < maxWaitTime) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        if (dedupError) {
          throw new Error(dedupError);
        }
        
        if (!dedupCompleted) {
          throw new Error(t('dedup.timeout'));
        }
      } finally {
        // 清理监听器
        tempUnlisten();
      }

      // 4. 获取新文件的统计信息
      let fileSize = 0;
      let newFrameCount = 0;
      let newFrameDelays: number[] = [];
      
      try {
        fileSize = await invoke<number>('get_file_size', { path: outputPath });
        
        // 获取新 GIF 的统计信息
        const stats = await invoke<GifStats>('get_gif_stats', {
          gifPath: outputPath,
        });
        newFrameCount = stats.frame_count;
        
        // 解析帧延迟
        const meta = await invoke<{ width: number; height: number; frame_count: number; delays_ms: number[] }>('parse_gif_preview', {
          gifPath: outputPath,
          workDir: workDir,
          maxPreview: 1, 
        });
        newFrameDelays = meta.delays_ms;
        newFrameCount = meta.frame_count;
      } catch (e) {
        console.warn('获取文件信息失败:', e);
      }

      // 5. 创建成果对象
      const newVersion: VersionItem = {
        id: `version-dedup-${Date.now()}-${counter}`,
        name: newFileName,
        path: outputPath,
        timestamp: Date.now(),
        isOriginal: false,
        frameCount: newFrameCount,
        duration: newFrameDelays.reduce((a, b) => a + b, 0),
        fileSize: fileSize,
        frameDelays: newFrameDelays,
      };

      // 6. 更新成果列表
      setVersions(prev => [...prev, newVersion]);
      
      // 7. 如果在工作区，更新配置文件
      if (loadedWorkspacePath) {
        try {
          const { dump } = await import('js-yaml');
          const currentOrder = versions.map(v => v.name.endsWith('.gif') ? v.name : `${v.name}.gif`);
          currentOrder.push(newVersion.name);
          const safeOrder = currentOrder.map(name => name.replace(/[\/\\:*?"<>|]/g, '_'));
          
          const originalVersion = versions.find(v => v.isOriginal);
          let safeOriginalName = null;
          if (originalVersion) {
            const origName = originalVersion.name.endsWith('.gif') ? originalVersion.name : `${originalVersion.name}.gif`;
            safeOriginalName = origName.replace(/[\/\\:*?"<>|]/g, '_');
          }

          const config = {
            order: safeOrder,
            original_file: safeOriginalName,
            timestamp: new Date().toISOString(),
            total_files: safeOrder.length
          };
          
          const yamlContent = dump(config);
          const configPath = loadedWorkspacePath.endsWith('/') 
            ? `${loadedWorkspacePath}.gifcut` 
            : `${loadedWorkspacePath}/.gifcut`;
          
          const encoder = new TextEncoder();
          await invoke('write_file_to_path', {
            path: configPath,
            data: Array.from(encoder.encode(yamlContent))
          });
        } catch (err) {
          console.warn('更新配置文件失败:', err);
        }
      }

      alert(t('dedup.successAlert', {
        name: newVersion.name,
        original: currentVersion.frameCount,
        kept: newFrameCount,
        removed: currentVersion.frameCount - newFrameCount
      }));

    } catch (err) {
      console.error('去重瘦身失败:', err);
      setDedupProgress({
        stage: 'error',
        message: t('dedup.error', { error: err instanceof Error ? err.message : String(err) }),
        current: undefined,
        total: undefined,
        details: undefined,
      });
      alert(t('dedup.error', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setIsApplyingDedup(false);
      // 5秒后清除进度信息，恢复时间轴显示
      setTimeout(() => {
        setDedupProgress(null);
      }, 5000);
    }
  };

  // 频率调整（抽帧降低 FPS）
  const handleApplyFpsReduce = async () => {
    const currentVersion = versions.find(v => v.id === currentVersionId);
    if (!currentVersion) return;

    if (frames.length < 2) {
      alert(t('fps.tooFewFrames'));
      return;
    }

    setIsApplyingFps(true);

    try {
      // 1. 准备输入文件路径
      let inputPath: string;
      if (currentVersion.isOriginal) {
        const originalFileName = currentVersion.path.split('/').pop() || 'original.gif';
        inputPath = `${workDir}/${originalFileName}`;
        try {
          const isLocalPath = currentVersion.path.startsWith('/') && !currentVersion.path.startsWith('/gifs/');
          const isWebResource = currentVersion.path.startsWith('http') || currentVersion.path.startsWith('/gifs/');
          if (isWebResource) {
            const response = await fetch(currentVersion.path);
            const blob = await response.blob();
            const arrayBuffer = await blob.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            await invoke('write_binary_file', {
              workDir: workDir,
              filename: originalFileName,
              data: Array.from(uint8Array),
            });
          } else if (isLocalPath) {
            inputPath = currentVersion.path;
          }
        } catch (e) {
          console.error('[TEMP_DEBUG] 准备原始文件失败:', e);
          throw e;
        }
      } else {
        inputPath = currentVersion.path;
      }

      // 2. 生成输出文件名
      const baseName = currentVersion.name.replace(/\.gif$/i, '');
      let counter = 1;
      let newFileName = `${baseName}-fps-reduce-${fpsKeepInterval}-${counter}.gif`;
      
      while (versions.some(v => v.name === newFileName)) {
        counter++;
        newFileName = `${baseName}-fps-reduce-${fpsKeepInterval}-${counter}.gif`;
      }
      const safeFileName = newFileName.replace(/[\/\\:*?"<>|]/g, '_');
      let outputDir = workDir;
      if (loadedWorkspacePath) {
        outputDir = loadedWorkspacePath;
      }
      const outputPath = `${outputDir}/${safeFileName}`;

      // 3. 获取当前帧延迟
      const frameDelays = frames.map(f => f.delay);

      console.log(`[TEMP_DEBUG] Reducing FPS: ${inputPath} -> ${outputPath}, interval=${fpsKeepInterval}, threshold=${fpsDelayThreshold}ms`);

      // 4. 调用后端抽帧命令
      await invoke('reduce_gif_fps', {
        inputPath: inputPath,
        outputPath: outputPath,
        keepInterval: fpsKeepInterval,
        delayThreshold: fpsDelayThreshold,
        maxDelay: 65535, // 不再限制最大延迟，传 u16 最大值
        frameDelays: frameDelays,
      });

      // 5. 获取新文件的统计信息
      let fileSize = 0;
      let newFrameCount = 0;
      let newFrameDelays: number[] = [];
      try {
        fileSize = await invoke<number>('get_file_size', { path: outputPath });
        const meta = await invoke<{ width: number; height: number; frame_count: number; delays_ms: number[] }>('parse_gif_preview', {
          gifPath: outputPath,
          workDir: workDir,
          maxPreview: 1, 
        });
        newFrameCount = meta.frame_count;
        newFrameDelays = meta.delays_ms;
      } catch (e) {
        console.warn('[TEMP_DEBUG] 获取文件信息失败:', e);
      }

      // 6. 添加新版本
      const newVersion: VersionItem = {
        id: `version-fps-${Date.now()}-${counter}`,
        name: newFileName,
        path: outputPath,
        timestamp: Date.now(),
        isOriginal: false,
        frameCount: newFrameCount,
        duration: newFrameDelays.reduce((a, b) => a + b, 0),
        fileSize: fileSize,
        frameDelays: newFrameDelays,
      };

      setVersions(prev => [...prev, newVersion]);

      // 7. 更新工作区配置（如果是已保存的工作区）
      if (loadedWorkspacePath) {
        try {
          const { dump } = await import('js-yaml');
          const currentOrder = versions.map(v => v.name.endsWith('.gif') ? v.name : `${v.name}.gif`);
          currentOrder.push(newVersion.name);
          const safeOrder = currentOrder.map(name => name.replace(/[\/\\:*?"<>|]/g, '_'));
          const originalVersion = versions.find(v => v.isOriginal);
          let safeOriginalName = null as any;
          if (originalVersion) {
            const origName = originalVersion.name.endsWith('.gif') ? originalVersion.name : `${originalVersion.name}.gif`;
            safeOriginalName = origName.replace(/[\/\\:*?"<>|]/g, '_');
          }
          const config = {
            order: safeOrder,
            original_file: safeOriginalName,
            timestamp: new Date().toISOString(),
            total_files: safeOrder.length
          };
          const yamlContent = dump(config);
          const configPath = loadedWorkspacePath.endsWith('/') 
            ? `${loadedWorkspacePath}.gifcut` 
            : `${loadedWorkspacePath}/.gifcut`;
          const encoder = new TextEncoder();
          await invoke('write_file_to_path', {
            path: configPath,
            data: Array.from(encoder.encode(yamlContent))
          });
        } catch (err) {
          console.warn('[TEMP_DEBUG] 更新配置文件失败:', err);
        }
      }

      const originalFrameCount = frames.length;
      const reduction = ((1 - newFrameCount / originalFrameCount) * 100).toFixed(1);
      alert(t('fps.successAlert', { name: newVersion.name, original: originalFrameCount, new: newFrameCount, reduction: reduction }));
    } catch (err) {
      console.error('[TEMP_DEBUG] 频率调整失败:', err);
      alert(t('fps.error', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setIsApplyingFps(false);
    }
  };

  const handleApplyResize = async () => {
    const currentVersion = versions.find(v => v.id === currentVersionId);
    if (!currentVersion) return;

    if (!resizeWidth || !resizeHeight || resizeWidth < 1 || resizeHeight < 1) {
      alert(t('resize.invalidInput'));
      return;
    }

    setIsResizing(true);

    try {
      let inputPath: string;
      if (currentVersion.isOriginal) {
        const originalFileName = currentVersion.path.split('/').pop() || 'original.gif';
        inputPath = `${workDir}/${originalFileName}`;
        try {
          const isLocalPath = currentVersion.path.startsWith('/') && !currentVersion.path.startsWith('/gifs/');
          const isWebResource = currentVersion.path.startsWith('http') || currentVersion.path.startsWith('/gifs/');
          if (isWebResource) {
            const response = await fetch(currentVersion.path);
            const blob = await response.blob();
            const arrayBuffer = await blob.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            await invoke('write_binary_file', {
              workDir: workDir,
              filename: originalFileName,
              data: Array.from(uint8Array),
            });
          } else if (isLocalPath) {
            inputPath = currentVersion.path;
          }
        } catch (e) {
          console.error('[TEMP_DEBUG] 准备原始文件失败:', e);
          throw e;
        }
      } else {
        inputPath = currentVersion.path;
      }

      const baseName = currentVersion.name.replace(/\.gif$/i, '');
      let counter = 1;
      let newFileName = `${baseName}-resize-${resizeWidth}x${resizeHeight}-${counter}.gif`;
      
      while (versions.some(v => v.name === newFileName)) {
        counter++;
        newFileName = `${baseName}-resize-${resizeWidth}x${resizeHeight}-${counter}.gif`;
      }
      const safeFileName = newFileName.replace(/[\/\\:*?"<>|]/g, '_');
      let outputDir = workDir;
      if (loadedWorkspacePath) {
        outputDir = loadedWorkspacePath;
      }
      const outputPath = `${outputDir}/${safeFileName}`;

      await invoke('resize_gif', {
        inputPath: inputPath,
        outputPath: outputPath,
        width: resizeWidth,
        height: resizeHeight,
        method: resizeMethod,
        optimize: false,
      });

      let fileSize = 0;
      let newFrameCount = 0;
      let newFrameDelays: number[] = [];
      try {
        fileSize = await invoke<number>('get_file_size', { path: outputPath });
        const meta = await invoke<{ width: number; height: number; frame_count: number; delays_ms: number[] }>('parse_gif_preview', {
          gifPath: outputPath,
          workDir: workDir,
          maxPreview: 1, 
        });
        newFrameCount = meta.frame_count;
        newFrameDelays = meta.delays_ms;
      } catch (e) {
        console.warn('[TEMP_DEBUG] 获取文件信息失败:', e);
      }

      const newVersion: VersionItem = {
        id: `version-resize-${Date.now()}-${counter}`,
        name: newFileName,
        path: outputPath,
        timestamp: Date.now(),
        isOriginal: false,
        frameCount: newFrameCount,
        duration: newFrameDelays.reduce((a, b) => a + b, 0),
        fileSize: fileSize,
        frameDelays: newFrameDelays,
      };

      setVersions(prev => [...prev, newVersion]);

      if (loadedWorkspacePath) {
        try {
          const { dump } = await import('js-yaml');
          const currentOrder = versions.map(v => v.name.endsWith('.gif') ? v.name : `${v.name}.gif`);
          currentOrder.push(newVersion.name);
          const safeOrder = currentOrder.map(name => name.replace(/[\/\\:*?"<>|]/g, '_'));
          const originalVersion = versions.find(v => v.isOriginal);
          let safeOriginalName = null as any;
          if (originalVersion) {
            const origName = originalVersion.name.endsWith('.gif') ? originalVersion.name : `${originalVersion.name}.gif`;
            safeOriginalName = origName.replace(/[\/\\:*?"<>|]/g, '_');
          }
          const config = {
            order: safeOrder,
            original_file: safeOriginalName,
            timestamp: new Date().toISOString(),
            total_files: safeOrder.length
          };
          const yamlContent = dump(config);
          const configPath = loadedWorkspacePath.endsWith('/') 
            ? `${loadedWorkspacePath}.gifcut` 
            : `${loadedWorkspacePath}/.gifcut`;
          const encoder = new TextEncoder();
          await invoke('write_file_to_path', {
            path: configPath,
            data: Array.from(encoder.encode(yamlContent))
          });
        } catch (err) {
          console.warn('[TEMP_DEBUG] 更新配置文件失败:', err);
        }
      }

      alert(t('resize.successAlert', { name: newVersion.name, width: resizeWidth, height: resizeHeight }));
    } catch (err) {
      console.error('[TEMP_DEBUG] 分辨率调整失败:', err);
      alert(t('resize.error', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setIsResizing(false);
    }
  };

  const handleDeleteSegment = async () => {
    const currentVersion = versions.find(v => v.id === currentVersionId);
    if (!currentVersion) return;

    const S = segmentRangeStart;
    const E = segmentRangeEnd;
    const totalFrames = frames.length;

    // 验证范围
    if (S < 0 || E >= totalFrames || S > E) {
      alert(t('delete.invalidRange'));
      return;
    }

    // 检查是否删除了所有帧
    if (S === 0 && E === totalFrames - 1) {
      alert(t('delete.cannotDeleteAll'));
      return;
    }

    if (!confirm(t('delete.confirm', { start: S + 1, end: E + 1 }))) {
      return;
    }

    setIsApplyingChanges(true);

    try {
      // 1. 准备输入文件路径
      let inputPath: string;
      if (currentVersion.isOriginal) {
        const originalFileName = currentVersion.path.split('/').pop() || 'original.gif';
        inputPath = `${workDir}/${originalFileName}`;
        
        // 确保原始文件在本地可用
        try {
          const isLocalPath = currentVersion.path.startsWith('/') && !currentVersion.path.startsWith('/gifs/');
          const isWebResource = currentVersion.path.startsWith('http') || currentVersion.path.startsWith('/gifs/');

          if (isWebResource) {
            console.log('[TEMP_DEBUG] Downloading resource for deleting:', currentVersion.path);
            const response = await fetch(currentVersion.path);
            const blob = await response.blob();
            const arrayBuffer = await blob.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            
            // 写入到工作目录
            await invoke('write_binary_file', {
              workDir: workDir,
              filename: originalFileName,
              data: Array.from(uint8Array),
            });
          } else if (isLocalPath) {
            // 如果已经是本地绝对路径（非 web 资源），直接使用
            inputPath = currentVersion.path;
          }
        } catch (e) {
          console.error('准备原始文件失败:', e);
          throw e;
        }
      } else {
        inputPath = currentVersion.path;
      }

      // 2. 生成新文件名
      const baseName = currentVersion.name.replace(/\.gif$/i, '');
      let counter = 1;
      let newFileName = `${baseName}-deleted-${counter}.gif`;
      
      // 检查文件名是否已存在，如果存在则递增序号
      while (versions.some(v => v.name === newFileName)) {
        counter++;
        newFileName = `${baseName}-deleted-${counter}.gif`;
      }

      const safeFileName = newFileName.replace(/[\/\\:*?"<>|]/g, '_');
      
      // 决定输出路径
      let outputDir = workDir;
      if (loadedWorkspacePath) {
        outputDir = loadedWorkspacePath;
      }
      const outputPath = `${outputDir}/${safeFileName}`;

      console.log(`[TEMP_DEBUG] Deleting frames: ${S}-${E} from ${inputPath} -> ${outputPath}`);

      // 3. 删除指定范围的帧
      try {
        await invoke('delete_gif_frames', {
          inputPath: inputPath,
          outputPath: outputPath,
          startIndex: S,
          endIndex: E,
          optimize: reOptimizeAfterSlice
        });
        console.log(`[TEMP_DEBUG] Delete segment created successfully: ${outputPath}`);
      } catch (deleteErr) {
        console.error(`[TEMP_DEBUG] Failed to delete segment:`, deleteErr);
        throw new Error(t('delete.error', { error: String(deleteErr) }));
      }

      // 4. 获取新文件的统计信息
      let fileSize = 0;
      let newFrameCount = totalFrames - (E - S + 1);
      let newFrameDelays: number[] = [];
      
      try {
        fileSize = await invoke<number>('get_file_size', { path: outputPath });
        
        // 计算剩余帧的延迟
        if (S > 0) {
          newFrameDelays.push(...frames.slice(0, S).map(f => f.delay));
        }
        if (E < totalFrames - 1) {
          newFrameDelays.push(...frames.slice(E + 1).map(f => f.delay));
        }
      } catch (e) {
        console.warn('获取文件信息失败:', e);
        // 如果获取失败，使用估算值
        if (S > 0) {
          newFrameDelays.push(...frames.slice(0, S).map(f => f.delay));
        }
        if (E < totalFrames - 1) {
          newFrameDelays.push(...frames.slice(E + 1).map(f => f.delay));
        }
      }

      // 5. 创建成果对象
      const newVersion: VersionItem = {
        id: `version-delete-${Date.now()}-${counter}`,
        name: newFileName,
        path: outputPath,
        timestamp: Date.now(),
        isOriginal: false,
        frameCount: newFrameCount,
        duration: newFrameDelays.reduce((a, b) => a + b, 0),
        fileSize: fileSize,
        frameDelays: newFrameDelays
      };

      // 6. 更新成果列表
      setVersions(prev => [...prev, newVersion]);
      
      // 7. 如果在工作区，更新配置文件
      if (loadedWorkspacePath) {
        try {
          const { dump } = await import('js-yaml');
          // 构建当前文件列表（包含新生成的）
          const currentOrder = versions.map(v => v.name.endsWith('.gif') ? v.name : `${v.name}.gif`);
          currentOrder.push(newVersion.name);
          const safeOrder = currentOrder.map(name => name.replace(/[\/\\:*?"<>|]/g, '_'));
          
          // 找到原始文件名
          const originalVersion = versions.find(v => v.isOriginal);
          let safeOriginalName = null;
          if (originalVersion) {
            const origName = originalVersion.name.endsWith('.gif') ? originalVersion.name : `${originalVersion.name}.gif`;
            safeOriginalName = origName.replace(/[\/\\:*?"<>|]/g, '_');
          }

          const config = {
            order: safeOrder,
            original_file: safeOriginalName,
            timestamp: new Date().toISOString(),
            total_files: safeOrder.length
          };
          
          const yamlContent = dump(config);
          const configPath = loadedWorkspacePath.endsWith('/') 
            ? `${loadedWorkspacePath}.gifcut` 
            : `${loadedWorkspacePath}/.gifcut`;
          
          const encoder = new TextEncoder();
          await invoke('write_file_to_path', {
            path: configPath,
            data: Array.from(encoder.encode(yamlContent))
          });
        } catch (err) {
          console.warn('更新配置文件失败:', err);
        }
      }

      alert(t('versions.deleteSuccess', {
        name: newVersion.name,
        deleted: E - S + 1,
        remaining: newFrameCount
      }));

    } catch (err) {
      console.error('删除段落失败:', err);
      alert(t('delete.error', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setIsApplyingChanges(false);
    }
  };

  

  const handleApplyChanges = async () => {
    if (!hasUnsavedChanges || isApplyingChanges) {
      if (isApplyingChanges) {
        return; // 正在处理中，忽略重复点击
      }
      alert(t('common.noChanges'));
      return;
    }

    setIsApplyingChanges(true);
    
    try {
      console.log('[TEMP_DEBUG] Applying changes...');
      console.log('[TEMP_DEBUG] Work directory:', workDir);
      console.log('[TEMP_DEBUG] Current frames delays:', frames.map(f => f.delay));
      
      if (!workDir) {
        throw new Error(t('common.workDirNotInit'));
      }
      
      // 计算修改的帧数
      const modifiedFrameCount = frames.filter((frame, idx) => 
        frame.delay !== originalFrames[idx]?.delay
      ).length;
      
      let totalDuration = frames.reduce((sum, f) => sum + f.delay, 0);
      
      // 找到当前成果的源文件路径
      const currentVersion = versions.find(v => v.id === currentVersionId);
      if (!currentVersion) {
        throw new Error(t('common.versionNotFound'));
      }
      
      console.log('[TEMP_DEBUG] Current version:', currentVersion);
      
      // 确定输入文件路径
      let inputPath: string;
      if (currentVersion.isOriginal) {
        const currentPath = currentVersion.path;
        const originalFileName = currentPath.split('/').pop() || 'original.gif';
        const inWorkDir = !!workDir && currentPath.startsWith(workDir);
        let existsInPlace = false;
        try { existsInPlace = await invoke<boolean>('path_exists', { path: currentPath }); } catch {}

        if (inWorkDir && existsInPlace) {
          inputPath = currentPath;
          console.log('[TEMP_DEBUG] Using existing original in work dir:', inputPath);
        } else if (currentPath.startsWith('http') || currentPath.startsWith('/gifs/')) {
          console.log('[TEMP_DEBUG] Downloading original file (web resource):', currentPath);
          const response = await fetch(currentPath);
          if (!response.ok) {
            throw new Error(t('common.downloadFailed', { status: response.statusText }));
          }
          const blob = await response.blob();
          const arrayBuffer = await blob.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);
          console.log('[TEMP_DEBUG] Writing downloaded original via Rust...', 'size:', uint8Array.length, 'bytes');
          const fileData = Array.from(uint8Array);
          inputPath = await invoke<string>('write_binary_file', {
            workDir: workDir,
            filename: originalFileName,
            data: fileData,
          });
          console.log('[TEMP_DEBUG] Original file saved to work dir:', inputPath);
        } else {
          console.log('[TEMP_DEBUG] Copying local original into work dir:', currentPath);
          // 本地绝对路径但不在工作目录中：复制到工作目录
          inputPath = await invoke<string>('read_file_to_workdir', {
            src_path: currentPath,
            work_dir: workDir,
            filename: originalFileName,
            chunk_size: 1024 * 512,
          });
          console.log('[TEMP_DEBUG] Local original copied to:', inputPath);
        }
      } else {
        // 使用之前保存的成果文件
        inputPath = currentVersion.path;
        console.log('[TEMP_DEBUG] Using existing version file:', inputPath);
      }
      
      // 生成输出文件名
      const versionNumber = versions.filter(v => !v.isOriginal).length + 1;
      
      // 获取原始文件名（不带路径）
      const originalVersion = versions.find(v => v.isOriginal);
      const originalName = originalVersion?.name || 'original.gif';
      const baseName = originalName.replace(/\.gif$/i, '');
      
      // 新成果名称
      const newVersionName = `${baseName}-speed-${versionNumber}.gif`;
      // 确保安全文件名
      const safeNewVersionName = newVersionName.replace(/[\/\\:*?"<>|]/g, '_');
      
      // 决定输出路径：如果是已载入的工作区，直接保存到工作区目录；否则保存到临时目录
      let outputDir = workDir;
      if (loadedWorkspacePath) {
        outputDir = loadedWorkspacePath;
        console.log('[TEMP_DEBUG] Saving directly to loaded workspace:', outputDir);
      }
      
      const outputPath = `${outputDir}/${safeNewVersionName}`;
      
      console.log('[TEMP_DEBUG] Output path:', outputPath);
      
      let frameDelays = frames.map(f => f.delay);
      if (activeTab === 'speed') {
        const currentRangeSum = frames.slice(rangeStart, rangeEnd + 1).reduce((s, f) => s + (f?.delay || 0), 0);
        const targetSum = rangeTargetDuration;
        if (targetSum > 0 && targetSum !== currentRangeSum) {
          const ratio = targetSum / currentRangeSum;
          frameDelays = frameDelays.map((d, i) => {
            if (i >= rangeStart && i <= rangeEnd) {
              const v = Math.max(10, Math.round(d * ratio));
              return v;
            }
            return d;
          });
          let newRangeSum = frameDelays.slice(rangeStart, rangeEnd + 1).reduce((s, d) => s + d, 0);
          let diff = targetSum - newRangeSum;
          if (diff !== 0) {
            const dir = diff > 0 ? 1 : -1;
            diff = Math.abs(diff);
            for (let pass = 0; pass < 2 && diff > 0; pass++) {
              for (let i = rangeStart; i <= rangeEnd && diff > 0; i++) {
                const nd = frameDelays[i] + dir;
                if (dir < 0 && nd < 10) continue;
                frameDelays[i] = nd;
                diff -= 1;
              }
            }
          }
        }
      }
      totalDuration = frameDelays.reduce((sum, d) => sum + d, 0);
      console.log('[TEMP_DEBUG] Calling modify_gif_delays with:', {
        inputPath,
        outputPath,
        frameDelaysCount: frameDelays.length,
      });
      
      console.log('[TEMP_DEBUG] About to call modify_gif_delays...');
      let savedPath: string;
      try {
        savedPath = await invoke<string>('modify_gif_delays', {
          inputPath: inputPath,
          outputPath: outputPath,
          frameDelays: frameDelays,
        });
        console.log('[TEMP_DEBUG] GIF saved to:', savedPath);
      } catch (invokeErr) {
        console.error('[TEMP_DEBUG] modify_gif_delays error:', invokeErr);
        throw new Error(t('common.gifsicleFailed', { error: invokeErr }));
      }
      
      // 获取保存后的文件大小
      console.log('[TEMP_DEBUG] Getting file size for:', savedPath);
      let fileSize: number;
      try {
        fileSize = await invoke<number>('get_file_size', { path: savedPath });
        console.log('[TEMP_DEBUG] File size:', fileSize, 'bytes');
      } catch (sizeErr) {
        console.error('[TEMP_DEBUG] get_file_size error:', sizeErr);
        // 如果获取文件大小失败，使用估算值
        fileSize = originalVersion?.fileSize || 0;
        console.log('[TEMP_DEBUG] Using estimated file size:', fileSize);
      }
      
      // 创建新成果
      console.log('[TEMP_DEBUG] Creating new version record...');
      
      const newVersion: VersionItem = {
        id: `version-${Date.now()}`,
        name: newVersionName, // 保持显示名称（可能包含不安全字符，但在列表中显示没问题）
        path: savedPath,
        timestamp: Date.now(),
        isOriginal: false,
        frameCount: frames.length,
        duration: totalDuration,
        fileSize: fileSize,
        frameDelays: frameDelays,
      };
      
      console.log('[TEMP_DEBUG] New version:', newVersion);
      console.log('[TEMP_DEBUG] Current versions count:', versions.length);
      
      // 如果是在工作区模式下，需要更新 .gifcut 配置文件
      if (loadedWorkspacePath) {
        try {
          const { dump } = await import('js-yaml');
          
          // 构建新的文件顺序
          // 注意：我们需要确保原始文件和其他成果文件的顺序正确
          // 这里我们简单地将新成果追加到最后
          const currentOrder = versions.map(v => {
            const name = v.name;
            // 尝试找到对应的文件名（如果是安全文件名）
            // 这里简化处理：假设 versions 中的 name 就是我们想要保存的 name
            return name.endsWith('.gif') ? name : `${name}.gif`;
          });
          
          // 添加新成果
          currentOrder.push(newVersionName);
          
          // 安全化处理（虽然我们在保存时已经处理了，但为了保持一致性）
          const safeOrder = currentOrder.map(name => name.replace(/[\/\\:*?"<>|]/g, '_'));
          
          // 确定原始文件名（安全格式）
          let safeOriginalName = null;
          if (originalVersion) {
            const origName = originalVersion.name.endsWith('.gif') ? originalVersion.name : `${originalVersion.name}.gif`;
            safeOriginalName = origName.replace(/[\/\\:*?"<>|]/g, '_');
          }
          
          const config = {
            order: safeOrder,
            original_file: safeOriginalName,
            timestamp: new Date().toISOString(),
            total_files: safeOrder.length
          };
          
          const yamlContent = dump(config);
          const configPath = loadedWorkspacePath.endsWith('/') 
            ? `${loadedWorkspacePath}.gifcut` 
            : `${loadedWorkspacePath}/.gifcut`;
          
          // 将字符串转换为 Uint8Array
          const encoder = new TextEncoder();
          const data = encoder.encode(yamlContent);
          
          await invoke('write_file_to_path', {
            path: configPath,
            data: Array.from(data)
          });
          
          console.log('[TEMP_DEBUG] Updated .gifcut config in loaded workspace:', config);
        } catch (configErr) {
          console.error('[TEMP_DEBUG] Failed to update .gifcut config:', configErr);
          // 不阻断主流程，只提示警告
          alert(t('common.configUpdateError'));
        }
      }
      
      setVersions(prev => {
        const updated = [...prev, newVersion];
        console.log('[TEMP_DEBUG] Updated versions count:', updated.length);
        return updated;
      });
      
      // 不自动切换到新成果，让用户自己选择
      console.log('[TEMP_DEBUG] New version created:', newVersion.name);
      console.log('[TEMP_DEBUG] Keeping current version:', currentVersionId);
      
      // 更新原始帧数据为当前状态
      setOriginalFrames(JSON.parse(JSON.stringify(frames.map(f => ({ delay: f.delay })))));
      setHasUnsavedChanges(false);
      
      // 更新统计信息（保持当前成果的统计信息，因为当前成果没有改变）
      // 如果用户切换到新成果，统计信息会在 handleSelectVersion 中更新
      
      console.log('[TEMP_DEBUG] Changes applied successfully');
      
      // 使用更友好的提示
      alert(t('common.saveSuccess', { name: newVersion.name, count: modifiedFrameCount, duration: (totalDuration / 1000).toFixed(2) }));
    } catch (err) {
      console.error('[TEMP_DEBUG] 应用更改失败:', err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('[TEMP_DEBUG] Error details:', {
        error: err,
        message: errorMessage,
        stack: err instanceof Error ? err.stack : undefined,
      });
      alert(t('common.applyError', { error: errorMessage }));
    } finally {
      setIsApplyingChanges(false);
    }
  };

  const handleSelectVersion = async (versionId: string, force: boolean = false) => {
    if (versionId === currentVersionId && !force) return;
    
    console.log('[TEMP_DEBUG] Selecting version:', versionId);
    try {
      await invoke('cancel_extraction');
      setIsExtractPaused(false);
      console.log('[TEMP_DEBUG] 已通知后端取消并停止当前解压线程');
    } catch (err) {
      console.error('[TEMP_DEBUG] 取消解压线程失败:', err);
    }
    setExtractProgress({
      fullframes: { current: 0, total: 0 },
      previews: { current: 0, total: 0 },
    });
    
    // 查找选中的成果
    const selectedVersion = versions.find(v => v.id === versionId);
    if (!selectedVersion) {
      console.error('[TEMP_DEBUG] Version not found:', versionId);
      return;
    }
    
    const previousVersionId = currentVersionId;
    const _initStart = !workDir ? performance.now() : undefined;
    const wd = workDir || await invoke<string>('init_work_dir');
    if (!workDir) {
      const _initDur = performance.now() - (_initStart as number);
      console.log(`[TEMP_DEBUG] 步骤: 初始化工作目录, 耗时: ${_initDur.toFixed(2)}ms`);
      setWorkDir(wd);
    }
    
    // 设置全局加载状态，显示标准进度信息
    setIsLoadingGif(true);
    setError(null);
    
    let totalStartTime: number | undefined = performance.now();
    try {
      // 第一步：准备文件路径（统一拷贝到工作目录）
      setGifLoadingProgress({ stage: 'prepare', current: 0, total: 1, message: t('progress.preparingFiles') });
      await new Promise(resolve => setTimeout(resolve, 0));
      let destPath = selectedVersion.path;
      const isTempPath = wd && destPath.startsWith(wd);
      const isWebResource = destPath.startsWith('/gifs/') || destPath.startsWith('http');
      if (!isTempPath && !isWebResource) {
        const fileName = destPath.split(/[/\\]/).pop() || 'image.gif';
        let knownTotal = selectedVersion.fileSize || 0;
        try { if (!knownTotal) knownTotal = await invoke<number>('get_file_size', { path: selectedVersion.path }); } catch {}
        const copyFileStartTime = performance.now();
        destPath = await invoke<string>('read_file_to_workdir', {
          src_path: selectedVersion.path,
          work_dir: wd,
          filename: fileName,
          chunk_size: 1024 * 512,
        });
        const copyFileDuration = performance.now() - copyFileStartTime;
        console.log(`[TEMP_DEBUG] 步骤: 复制文件到工作目录, 耗时: ${copyFileDuration.toFixed(2)}ms (${(knownTotal / 1024 / 1024).toFixed(2)}MB)`);
      }
      
          const runExtract = () => {
            setGifLoadingProgress({ stage: 'extract', current: 0, total: 1, message: t('progress.parsingDelays') });
            setTimeout(() => {
              (async () => {
                try {
                  const safeBase = _safeBaseFromPath(destPath);
                  const framesDirCalc = `${wd}/_${safeBase}_fullframes`;
                  const previewsDirCalc = `${wd}/_${safeBase}_previews`;
                  const meta = await invoke<{ width: number; height: number; frame_count: number; delays_ms: number[]; preview_dir: string; preview_files: string[] }>('parse_gif_preview', {
                    gifPath: destPath,
                    workDir: wd,
                    maxPreview: 120,
                    reuseFramesDir: framesDirCalc,
                  });
                  try {
                    setFrameFilesDir(framesDirCalc);
                    setPreviewFilesDir(previewsDirCalc);
                    try {
                      const fullNames = await invoke<string[]>('read_dir_filenames', { path: framesDirCalc });
                      const prevNames = await invoke<string[]>('read_dir_filenames', { path: previewsDirCalc });
                      const fullCur = Array.isArray(fullNames) ? fullNames.filter(n => n.startsWith('frame.')).length : 0;
                      const prevCur = Array.isArray(prevNames) ? prevNames.filter(n => n.startsWith('preview.')).length : 0;
                      setExtractProgress({
                        fullframes: { current: fullCur, total: meta.frame_count },
                        previews: { current: prevCur, total: meta.frame_count },
                      });
                    } catch {
                      setExtractProgress({
                        fullframes: { current: 0, total: meta.frame_count },
                        previews: { current: 0, total: meta.frame_count },
                      });
                    }
                  } catch {}
                  try { await invoke<string>('extract_fullframes_background', { workDir: wd, gifPath: destPath, batch_size: 100 }); } catch {}
                  try { await invoke<string>('extract_previews_background', { workDir: wd, gifPath: destPath, max_preview: 120, batch_size: 100 }); } catch {}
                  try { _global_delay_cache.set(destPath, meta.delays_ms); } catch {}
                  setGifLoadingProgress({ stage: 'parse', current: 0, total: 1, message: t('progress.buildingPlaceholders') });
                  const dims = { width: meta.width, height: meta.height };
                  const placeholders: GifFrame[] = Array.from({ length: meta.frame_count }, (_, i) => {
                    const c = document.createElement('canvas');
                    c.width = 1; c.height = 1;
                    const id = new ImageData(1, 1);
                    return { imageData: id, delay: meta.delays_ms[i] || 100, index: i, canvas: c };
                  });
                  setFrames(placeholders);
              setOriginalFrames(JSON.parse(JSON.stringify(placeholders.map((f: GifFrame) => ({ delay: f.delay })))));
              setDimensions(dims);
              setResizeWidth(dims.width || 0);
              setResizeHeight(dims.height || 0);
              setCurrentFrame(0);
              setIsPlaying(false);
              setHasUnsavedChanges(false);
              setRangeStart(0);
              const finalMax = Math.max(0, meta.frame_count - 1);
              setRangeEnd(finalMax);
              setSegmentRangeStart(0);
              setSegmentRangeEnd(finalMax);
              const totalDuration = placeholders.reduce((sum: number, f: GifFrame) => sum + f.delay, 0);
              const estimatedStats: GifStats = {
                frame_count: meta.frame_count,
                total_duration: totalDuration / 1000,
                avg_fps: meta.frame_count / (totalDuration / 1000),
                min_fps: Math.min(...placeholders.map((f: GifFrame) => 1000 / f.delay)),
                max_fps: Math.max(...placeholders.map((f: GifFrame) => 1000 / f.delay)),
                file_size: selectedVersion.fileSize || 0,
              };
                setGifStats(estimatedStats);
                setVersions(prev => prev.map(v => v.id === selectedVersion.id ? {
                  ...v,
                  path: destPath,
                  frameCount: meta.frame_count,
                  duration: totalDuration,
                  frameDelays: meta.delays_ms,
                } : v));
              setCurrentVersionId(versionId);
              if (totalStartTime !== undefined) {
                const totalDuration_ms = performance.now() - totalStartTime;
                console.log(`[TEMP_DEBUG] ========== GIF 载入完成(版本选择-轻量) ==========`);
                console.log(`[TEMP_DEBUG] 总耗时: ${totalDuration_ms.toFixed(2)}ms (${(totalDuration_ms / 1000).toFixed(2)}秒)`);
                const fsize = selectedVersion.fileSize || 0;
                console.log(`[TEMP_DEBUG] 文件信息: ${meta.frame_count} 帧, ${dims.width}x${dims.height}${fsize ? `, ${(fsize / 1024 / 1024).toFixed(2)}MB` : ''}`);
              }
              setIsLoadingGif(false);
              setGifLoadingProgress(null);
              try { const stats = await invoke<GifStats>('get_gif_stats', { gifPath: destPath }); setGifStats(stats); } catch {}
              try { await invoke('resume_extraction'); setIsExtractPaused(false); } catch {}
            } catch (err) {
              if (totalStartTime !== undefined) {
                const totalDuration_ms = performance.now() - totalStartTime;
                console.error(`[TEMP_DEBUG] 成果载入失败(版本选择), 总耗时: ${totalDuration_ms.toFixed(2)}ms`);
              }
              console.error('加载成果失败:', err);
              setIsLoadingGif(false);
              setIsLoadingStats(false);
              setCurrentVersionId(previousVersionId);
              setError(t('common.loadVersionError', { error: err instanceof Error ? err.message : String(err) }));
            }
          })();
        }, 0);
      };

      // 检查延迟缓存，如果没有则尝试从磁盘加载
      try {
        const hasDelays = !!_global_delay_cache.get(destPath);
        if (!hasDelays) {
          setGifLoadingProgress({ stage: 'verify-cache', current: 0, total: 1, message: t('progress.verifyingCache') });
          setTimeout(() => {
            (async () => {
              const pre = await _tryLoadDiskCaches(wd, destPath);
              if (pre.loadedDelays) { console.log('[TEMP_DEBUG] 命中磁盘延迟缓存(版本选择)'); }
              setGifLoadingProgress({ stage: 'verify-cache', current: 1, total: 1, message: t('progress.cacheLoaded') });
              runExtract();
            })();
          }, 0);
        } else {
          console.log('[TEMP_DEBUG] 版本选择: 命中延迟缓存，跳过磁盘读取');
          runExtract();
        }
      } catch {
        runExtract();
      }
      return;
      
    } catch (err) {
      if (totalStartTime !== undefined) {
        const totalDuration_ms = performance.now() - totalStartTime;
        console.error(`[TEMP_DEBUG] 成果载入失败(版本选择), 总耗时: ${totalDuration_ms.toFixed(2)}ms`);
      }
      console.error('加载成果失败:', err);
      setIsLoadingGif(false);
      setIsLoadingStats(false);
      // 恢复到之前的成果ID，避免界面卡在错误状态
      setCurrentVersionId(previousVersionId);
      setError(t('common.loadVersionError', { error: err instanceof Error ? err.message : String(err) }));
    }
  };

  const handleReloadReset = async () => {
    const vid = currentVersionId;
    await handleSelectVersion(vid, true);
    setDedupQuality(90);
    setDedupThreshold(95);
    setDedupColors(256);
    setDedupUsePalette(false);
    setIsApplyingDedup(false);
    setDedupProgress(null);
    setResizeWidth(dimensions.width || 0);
    setResizeHeight(dimensions.height || 0);
    setKeepAspect(true);
    setResizeMethod('mix');
    setIsResizing(false);
  };

  const handleFrameDelayChange = (frameIndex: number, newDelay: number) => {
    // 更新指定帧的延迟时间
    setFrames(prevFrames => {
      const newFrames = [...prevFrames];
      newFrames[frameIndex] = {
        ...newFrames[frameIndex],
        delay: newDelay,
      };
      return newFrames;
    });
  };

  const handleResetFrameDelay = (frameIndex: number) => {
    // 重置指定帧的延迟时间为原始值
    if (originalFrames[frameIndex]) {
      handleFrameDelayChange(frameIndex, originalFrames[frameIndex].delay);
    }
  };

  const handleRangeStartChange = (start: number) => {
    // 拖动起始帧时，确保不超过结束帧
    const validStart = Math.max(0, Math.min(start, rangeEnd));
    console.log('[TEMP_DEBUG] Range Start Changed:', start, '→', validStart, 'Range End:', rangeEnd);
    setRangeStart(validStart);
    
    // 拖动起始滑块时，时间轴游标跟随到起始帧
    console.log('[TEMP_DEBUG] Moving currentFrame to start:', validStart);
    setCurrentFrame(validStart);
  };

  const handleRangeEndChange = (end: number) => {
    // 拖动结束帧时，确保不小于起始帧
    const maxIndex = Math.max(0, (gifStats?.frame_count || frames.length) - 1);
    const validEnd = Math.max(rangeStart, Math.min(end, maxIndex));
    console.log('[TEMP_DEBUG] RangeEndChange', { input: end, validEnd, maxIndex, rangeStart });
    console.log('[TEMP_DEBUG] Range End Changed:', end, '→', validEnd, 'Range Start:', rangeStart);
    setRangeEnd(validEnd);
    
    // 拖动结束滑块时，时间轴游标跟随到结束帧
    console.log('[TEMP_DEBUG] Moving currentFrame to end:', validEnd);
    setCurrentFrame(validEnd);
  };

  const handleSpeedUp = () => {
    // 加速一倍（延迟减半）
    setFrames(prevFrames => {
      const newFrames = [...prevFrames];
      for (let i = rangeStart; i <= rangeEnd; i++) {
        newFrames[i] = {
          ...newFrames[i],
          delay: Math.max(10, Math.round(newFrames[i].delay / 2)),
        };
      }
      return newFrames;
    });
  };

  const handleSlowDown = () => {
    // 减速一倍（延迟加倍）
    setFrames(prevFrames => {
      const newFrames = [...prevFrames];
      for (let i = rangeStart; i <= rangeEnd; i++) {
        newFrames[i] = {
          ...newFrames[i],
          delay: Math.min(10000, newFrames[i].delay * 2),
        };
      }
      return newFrames;
    });
  };

  if (loading) {
    return (
      <div className="app">
        <div className="loading">加载中...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="app">
        <div className="error">{error}</div>
      </div>
    );
  }

  if (frames.length === 0) {
    return (
      <div className="app">
        {(isApplyingChanges || isLoadingWorkspace || isLoadingGif) && (
          <div className="processing-overlay">
            <div className="processing-content">
              <div className="processing-spinner"></div>
              <div className="processing-text">
                {isLoadingGif ? t('progress.loadingGif') : isLoadingWorkspace ? t('progress.loadingWorkspace') : t('progress.saving')}
              </div>
              <div className="processing-subtext">
                {(isLoadingGif || isLoadingWorkspace) ? (
                  gifLoadingProgress ? (
                    gifLoadingProgress.stage === 'read' ? t('progress.readingFileWithCount', { current: formatBytes(gifLoadingProgress.current), total: formatBytes(gifLoadingProgress.total) }) :
                    gifLoadingProgress.stage === 'prepare' ? `${t('progress.preparingDecodeWithCount', { current: gifLoadingProgress.subCurrent ?? gifLoadingProgress.current, total: gifLoadingProgress.subTotal ?? gifLoadingProgress.total, percent: formatPercent(gifLoadingProgress.subCurrent ?? gifLoadingProgress.current, gifLoadingProgress.subTotal ?? gifLoadingProgress.total) })}${gifLoadingProgress.message ? '：' + gifLoadingProgress.message : ''}` :
                    gifLoadingProgress.stage === 'extract' ? `${gifLoadingProgress.message || t('progress.extractingToDisk')}${gifLoadingProgress.current !== undefined && gifLoadingProgress.total !== undefined && gifLoadingProgress.total > 1 ? `（${gifLoadingProgress.current}/${gifLoadingProgress.total}）` : ''}` :
                    gifLoadingProgress.stage === 'parse' ? `${gifLoadingProgress.message || t('progress.loadingThumbnails')}${gifLoadingProgress.current !== undefined && gifLoadingProgress.total !== undefined && gifLoadingProgress.total > 1 ? `（${gifLoadingProgress.current}/${gifLoadingProgress.total}）` : ''}` :
                    gifLoadingProgress.stage === 'verify-cache' ? `${gifLoadingProgress.message || t('progress.verifyingCache')}${gifLoadingProgress.current !== undefined && gifLoadingProgress.total !== undefined && gifLoadingProgress.total > 1 ? `（${gifLoadingProgress.current}/${gifLoadingProgress.total}）` : ''}` :
                    gifLoadingProgress.stage === 'decode' ? t('progress.decodingFramesWithCount', { current: gifLoadingProgress.current, total: gifLoadingProgress.total }) :
                    gifLoadingProgress.stage === 'assemble' ? t('progress.assemblingThumbnailsWithCount', { current: gifLoadingProgress.current, total: gifLoadingProgress.total }) :
                    gifLoadingProgress.stage === 'cleanup' ? `${gifLoadingProgress.message || t('progress.cleaningUp')}` :
                    `${gifLoadingProgress.message || t('progress.pleaseWait')}${gifLoadingProgress.current !== undefined && gifLoadingProgress.total !== undefined ? `（${gifLoadingProgress.current}/${gifLoadingProgress.total}）` : ''}`
                  ) : t('progress.pleaseWait')
                ) : t('progress.takingSeconds')}
              </div>
              {isLoadingGif && gifLoadingProgress && gifLoadingProgress.stage === 'prepare' && (
                <div className="processing-steps" style={{ marginTop: 8, fontSize: 13, lineHeight: 1.6 }}>
                  {[
                    'parser.init',
                    'parser.createBlob',
                    'parser.preReadSize',
                    'parser.initWorker',
                    'parser.transferData',
                    'parser.completeInit',
                    'parser.startDecode',
                  ].map((labelKey, idx) => (
                    <div key={idx} className="processing-step">
                      {idx < (gifLoadingProgress?.current || 0) ? `✔ ${t(labelKey)}` : idx === (gifLoadingProgress?.current || 0) ? `▶ ${gifLoadingProgress?.message || t(labelKey)}` : `… ${t(labelKey)}`}
                      {labelKey === 'parser.init' && (
                        <div style={{ marginLeft: 16 }}>
                          {['parser.loadToMemory','parser.checkHeader','parser.prepareView','parser.initState','parser.registerChannel','parser.createBlob','parser.preReadSize','parser.initWorker','parser.transferData','parser.completeInit','parser.startDecode'].map((sLabelKey, sIdx) => (
                            <div key={sIdx}>
                              {sIdx + 1 < (gifLoadingProgress?.subCurrent || 0) ? `✔ ${t(sLabelKey)}` : sIdx + 1 === (gifLoadingProgress?.subCurrent || 0) ? `▶ ${gifLoadingProgress?.subMessage || t(sLabelKey)}` : `… ${t(sLabelKey)}`}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        <div className="welcome" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
          <div style={{ width: 300, fontSize: '0.9rem', color: '#666', marginBottom: 12, textAlign: 'center', fontWeight: 500 }}>{t('home.noGifs')}</div>
          <div className="actions-panel" style={{ display: 'flex', gap: 12, width: 300 }}>
            <button className="action-button primary" onClick={handleLoadGif}>📁 {t('actions.loadGif') || 'Load GIF File'}</button>
            <button className="action-button secondary" onClick={handleLoadWorkspace}>📂 {t('actions.loadWorkspace') || 'Load Workspace'}</button>
            <LanguageSwitcher />
          </div>
        </div>
      </div>
    );
  }

  if (isPreviewMode) {
    if (loading) {
      return (
        <div className="app">
          <div className="loading">加载中...</div>
        </div>
      );
    }
    if (error) {
      return (
        <div className="app">
          <div className="error">{error}</div>
        </div>
      );
    }
    
    // 预览窗口直接使用 <img> 标签播放 GIF，不需要解析
    const pad = 8;
    
    return (
      <div style={{ 
        width: '100vw', 
        height: '100vh', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center', 
        padding: pad,
        backgroundColor: '#f5f5f5'
      }}>
        {previewGifUrl ? (
          <img 
            src={previewGifUrl} 
            alt="GIF 预览"
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              objectFit: 'contain',
              imageRendering: 'pixelated',
            }}
            onLoad={(e) => {
              const img = e.currentTarget;
              setDimensions({ width: img.naturalWidth, height: img.naturalHeight });
            }}
            onError={() => {
              console.error('[TEMP_DEBUG] 预览窗口 GIF 加载失败:', previewGifUrl);
              setError(t('preview.loadPathError'));
            }}
          />
        ) : (
          <div className="loading">{t('home.waiting')}</div>
        )}
      </div>
    );
  }
  return (
    <>
      {/* 预览模态窗口 */}
      {showPreviewModal && previewModalGifUrl && (
        <div 
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
            cursor: 'pointer',
          }}
          onClick={() => {
            console.log('[TEMP_DEBUG] 背景点击，关闭模态窗口');
            // 清理 Blob URL，避免内存泄漏
            if (previewModalGifUrl && previewModalGifUrl.startsWith('blob:')) {
              URL.revokeObjectURL(previewModalGifUrl);
            }
            setShowPreviewModal(false);
            setPreviewModalGifUrl(null);
          }}
        >
          <div 
            style={{
              maxWidth: '90vw',
              maxHeight: '90vh',
              position: 'relative',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => {
                console.log('[TEMP_DEBUG] 关闭按钮点击，关闭模态窗口');
                // 清理 Blob URL，避免内存泄漏
                if (previewModalGifUrl && previewModalGifUrl.startsWith('blob:')) {
                  URL.revokeObjectURL(previewModalGifUrl);
                }
                setShowPreviewModal(false);
                setPreviewModalGifUrl(null);
              }}
              style={{
                position: 'absolute',
                top: -40,
                right: 0,
                background: 'rgba(255, 255, 255, 0.9)',
                border: 'none',
                borderRadius: '4px',
                padding: '8px 16px',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: '600',
                color: '#333',
              }}
            >
              {t('home.close')}
            </button>
            <img 
              src={previewModalGifUrl} 
              alt={t('home.previewAlt')}
              style={{
                maxWidth: '100%',
                maxHeight: '90vh',
                objectFit: 'contain',
                imageRendering: 'pixelated',
                backgroundColor: '#f5f5f5',
                borderRadius: '4px',
              }}
              onError={(e) => {
                console.error('[TEMP_DEBUG] 预览 GIF 加载失败:', previewModalGifUrl, e);
                console.error('[TEMP_DEBUG] 错误详情:', e);
                // 不立即关闭模态窗口，让用户看到错误信息
                // setShowPreviewModal(false);
                // setPreviewModalGifUrl(null);
                alert(t('preview.loadPathError'));
              }}
              onLoad={() => {
                console.log('[TEMP_DEBUG] 预览 GIF 加载成功');
              }}
            />
          </div>
        </div>
      )}
      
      <div className="app">
        {/* 处理中的覆盖层 */}
      {(isApplyingChanges || isLoadingWorkspace || isLoadingGif) && (
        <div className="processing-overlay">
          <div className="processing-content">
            <div className="processing-spinner"></div>
            <div className="processing-text">
              {isLoadingGif ? t('home.loadingGif') : isLoadingWorkspace ? t('home.loadingWorkspace') : t('home.saving')}
            </div>
            <div className="processing-subtext">
              {(isLoadingGif || isLoadingWorkspace) ? (
                gifLoadingProgress ? (
                  gifLoadingProgress.stage === 'read' ? t('progress.readingFileWithCount', { current: formatBytes(gifLoadingProgress.current), total: formatBytes(gifLoadingProgress.total) }) :
                  gifLoadingProgress.stage === 'prepare' ? `${t('progress.preparingDecodeWithCount', { current: gifLoadingProgress.subCurrent ?? gifLoadingProgress.current, total: gifLoadingProgress.subTotal ?? gifLoadingProgress.total, percent: formatPercent(gifLoadingProgress.subCurrent ?? gifLoadingProgress.current, gifLoadingProgress.subTotal ?? gifLoadingProgress.total) })}${gifLoadingProgress.message ? ': ' + gifLoadingProgress.message : ''}` :
                  gifLoadingProgress.stage === 'extract' ? ((gifLoadingProgress.current !== undefined && gifLoadingProgress.total !== undefined && gifLoadingProgress.total > 1) ? t('progress.messageWithCount', { message: gifLoadingProgress.message || t('progress.extractingToDisk'), current: gifLoadingProgress.current, total: gifLoadingProgress.total }) : (gifLoadingProgress.message || t('progress.extractingToDisk'))) :
                  gifLoadingProgress.stage === 'parse' ? ((gifLoadingProgress.current !== undefined && gifLoadingProgress.total !== undefined && gifLoadingProgress.total > 1) ? t('progress.messageWithCount', { message: gifLoadingProgress.message || t('progress.loadingThumbnails'), current: gifLoadingProgress.current, total: gifLoadingProgress.total }) : (gifLoadingProgress.message || t('progress.loadingThumbnails'))) :
                  gifLoadingProgress.stage === 'verify-cache' ? ((gifLoadingProgress.current !== undefined && gifLoadingProgress.total !== undefined && gifLoadingProgress.total > 1) ? t('progress.messageWithCount', { message: gifLoadingProgress.message || t('progress.verifyingCache'), current: gifLoadingProgress.current, total: gifLoadingProgress.total }) : (gifLoadingProgress.message || t('progress.verifyingCache'))) :
                  gifLoadingProgress.stage === 'decode' ? t('progress.decodingFramesWithCount', { current: gifLoadingProgress.current, total: gifLoadingProgress.total }) :
                  gifLoadingProgress.stage === 'assemble' ? t('progress.assemblingThumbnailsWithCount', { current: gifLoadingProgress.current, total: gifLoadingProgress.total }) :
                  gifLoadingProgress.stage === 'cleanup' ? `${gifLoadingProgress.message || t('progress.cleaningUp')}` :
                  ((gifLoadingProgress.current !== undefined && gifLoadingProgress.total !== undefined) ? t('progress.messageWithCount', { message: gifLoadingProgress.message || t('progress.pleaseWait'), current: gifLoadingProgress.current, total: gifLoadingProgress.total }) : (gifLoadingProgress.message || t('progress.pleaseWait')))
                ) : t('progress.pleaseWait')
              ) : t('progress.takingSeconds')}
            </div>
            {isLoadingGif && gifLoadingProgress && gifLoadingProgress.stage === 'prepare' && (
              <div className="processing-steps" style={{ marginTop: 8, fontSize: 13, lineHeight: 1.6 }}>
                {[
                  t('parser.init'),
                  t('parser.createBlob'),
                  t('parser.preReadSize'),
                  t('parser.initWorker'),
                  t('parser.transferData'),
                  t('parser.completeInit'),
                  t('parser.startDecode'),
                ].map((label, idx) => (
                  <div key={idx} className="processing-step">
                    {idx < (gifLoadingProgress?.current || 0) ? `✔ ${label}` : idx === (gifLoadingProgress?.current || 0) ? `▶ ${gifLoadingProgress?.message || label}` : `… ${label}`}
                    {label === t('parser.init') && (
                      <div style={{ marginLeft: 16 }}>
                        {[
                          t('parser.loadToMemory'),
                          t('parser.checkHeader'),
                          t('parser.prepareView'),
                          t('parser.initState'),
                          t('parser.registerChannel'),
                          t('parser.createBlob'),
                          t('parser.preReadSize'),
                          t('parser.initWorker'),
                          t('parser.transferData'),
                          t('parser.completeInit'),
                          t('parser.startDecode')
                        ].map((sLabel, sIdx) => (
                          <div key={sIdx}>
                            {sIdx + 1 < (gifLoadingProgress?.subCurrent || 0) ? `✔ ${sLabel}` : sIdx + 1 === (gifLoadingProgress?.subCurrent || 0) ? `▶ ${gifLoadingProgress?.subMessage || sLabel}` : `… ${sLabel}`}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            
          </div>
        </div>
      )}
      <main className="app-main">
        {/* 编辑区域：操作按钮 + 播放器 + 成果列表 */}
        <div className="editor-section">
          {/* 左侧操作按钮和统计信息 */}
            <div className="left-panel">
              <div className="actions-panel">
                <button className="action-button primary" onClick={handleLoadGif}>
                  📁 {t('actions.loadGif')}
                </button>
                <button className="action-button secondary" onClick={handleLoadWorkspace}>
                  📂 {t('actions.loadWorkspace')}
                </button>
                <button className="action-button secondary" onClick={handleSaveWorkspace}>
                  💾 {t('actions.saveWorkspace')}
                </button>
              </div>
              
              {/* GIF 统计信息 */}
            {gifStats && (
              <div className="gif-stats-panel">
                <div className="stats-header-row">
                  <h4 className="stats-title">{t('stats.fileSummary')}</h4>
                  {isLoadingStats && (
                    <span className="stats-loading-indicator" title={t('stats.loading')}>
                      <span className="stats-spinner"></span>
                    </span>
                  )}
                </div>
                <div className="stats-grid">
                  <div className="stat-row">
                    <span className="stat-label">{t('stats.resolution')}:</span>
                    <span className="stat-value">{dimensions.width} × {dimensions.height}</span>
                  </div>
                  <div className="stat-row">
                    <span className="stat-label">{t('stats.frameCount')}:</span>
                    <span className="stat-value">{gifStats.frame_count}</span>
                  </div>
                  <div className="stat-row">
                    <span className="stat-label">{t('stats.duration')}:</span>
                    <span className="stat-value">{gifStats.total_duration.toFixed(2)}s</span>
                  </div>
                  <div className="stat-row">
                    <span className="stat-label">{t('stats.avgFps')}:</span>
                    <span className="stat-value">{gifStats.avg_fps.toFixed(1)} FPS</span>
                  </div>
                  <div className="stat-row">
                    <span className="stat-label">{t('stats.maxFps')}:</span>
                    <span className="stat-value">{gifStats.max_fps.toFixed(1)} FPS</span>
                  </div>
                  <div className="stat-row">
                    <span className="stat-label">{t('stats.minFps')}:</span>
                    <span className="stat-value">{gifStats.min_fps.toFixed(1)} FPS</span>
                  </div>
                  {gifStats.mode1_fps !== undefined && gifStats.mode1_fps !== null && (
                    <>
                      <div className="stat-row">
                        <span className="stat-label">{t('stats.modeFps')}:</span>
                    <span className="stat-value">
                      {gifStats.mode1_fps.toFixed(0)} FPS ({gifStats.mode1_count}次)
                    </span>
                      </div>
                      {gifStats.mode2_fps !== undefined && gifStats.mode2_fps !== null && (
                        <div className="stat-row">
                          <span className="stat-label"></span>
                          <span className="stat-value">
                            {gifStats.mode2_fps.toFixed(0)} FPS ({gifStats.mode2_count}次)
                          </span>
                        </div>
                      )}
                    </>
                  )}
                  <div className="stat-row">
                    <span className="stat-label">{t('stats.fileSize')}:</span>
                    <span className="stat-value">
                      {gifStats.file_size >= 1024 * 1024
                        ? `${(gifStats.file_size / 1024 / 1024).toFixed(2)}MB`
                        : `${(gifStats.file_size / 1024).toFixed(1)}KB`}
                    </span>
                  </div>
                </div>
              </div>
            )}
            
            {/* 解压进度显示 - 在统计信息面板下方 */}
            {(extractProgress.fullframes.total > 0 || extractProgress.previews.total > 0) && (
              <div style={{ 
                marginTop: '8px',
                background: '#f5f5f5',
                borderRadius: '4px',
                padding: '5px 6px',
                border: '1px solid #d1d1d1',
                fontSize: '10px', 
                color: '#666',
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: '8px'
              }}>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  {extractProgress.fullframes.total > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <span>{t('extract.fullFrames')}</span>
                      <span style={{ color: extractProgress.fullframes.current >= extractProgress.fullframes.total ? '#4caf50' : '#2196f3' }}>
                        {extractProgress.fullframes.current}/{extractProgress.fullframes.total}
                      </span>
                      {extractProgress.fullframes.current < extractProgress.fullframes.total && (
                        <span style={{ color: '#999' }}>
                          ({Math.round((extractProgress.fullframes.current / extractProgress.fullframes.total) * 100)}%)
                        </span>
                      )}
                    </div>
                  )}
                  {extractProgress.previews.total > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <span>{t('extract.thumbnails')}</span>
                      <span style={{ color: extractProgress.previews.current >= extractProgress.previews.total ? '#4caf50' : '#2196f3' }}>
                        {extractProgress.previews.current}/{extractProgress.previews.total}
                      </span>
                      {extractProgress.previews.current < extractProgress.previews.total && (
                        <span style={{ color: '#999' }}>
                          ({Math.round((extractProgress.previews.current / extractProgress.previews.total) * 100)}%)
                        </span>
                      )}
                    </div>
                  )}
                </div>
                {(extractProgress.fullframes.current < extractProgress.fullframes.total || 
                  extractProgress.previews.current < extractProgress.previews.total) && (
                  <button
                    onClick={async () => {
                      const newPaused = !isExtractPaused;
                      setIsExtractPaused(newPaused);
                      try {
                        if (newPaused) {
                          await invoke('pause_extraction');
                        } else {
                          await invoke('resume_extraction');
                        }
                      } catch (err) {
                        console.error('[TEMP_DEBUG] 暂停/继续解压失败:', err);
                      }
                    }}
                    style={{
                      width: '18px',
                      height: '18px',
                      padding: '0',
                      fontSize: '10px',
                      border: '1px solid #ccc',
                      borderRadius: '2px',
                      background: isExtractPaused ? '#fff' : '#f5f5f5',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0
                    }}
                    title={isExtractPaused ? t('extract.resume') : t('extract.pause')}
                  >
                    {isExtractPaused ? '▶' : '⏸'}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* 播放器区域 */}
          <div className="player-area" style={{ overflow: 'auto' }} ref={playerAreaRef}>
          <GifPlayer
            frames={frames}
            width={dimensions.width}
            height={dimensions.height}
            currentFrame={currentFrame}
            isPlaying={isPlaying}
            onFrameChange={handleFrameChange}
            onPlayingChange={handlePlayingChange}
            onPreview={() => handleOpenPreview()}
            fullframesDir={frameFilesDir}
          />
          </div>

          {/* 右侧成果列表 */}
          <div className="versions-panel">
            <div className="versions-header">
              <h3 className="versions-title">{t('versions.title')}</h3>
              {hasUnsavedChanges && <span className="unsaved-indicator">●</span>}
            </div>
            <div className="versions-list">
              {versions.map(version => {
                const durationInSeconds = (version.duration / 1000).toFixed(2);
                
                // 格式化文件大小
                let fileSizeDisplay = '?';
                if (version.fileSize) {
                  const sizeInKB = version.fileSize / 1024;
                  if (sizeInKB >= 1024) {
                    fileSizeDisplay = `${(sizeInKB / 1024).toFixed(2)}MB`;
                  } else {
                    fileSizeDisplay = `${sizeInKB.toFixed(1)}KB`;
                  }
                }
                
                // 获取短文件名（用于原始文件）
                const displayName = version.isOriginal 
                  ? version.path.split('/').pop() || version.name
                  : version.name;
                
                return (
                  <div
                    key={version.id}
                    className={`version-item ${version.id === currentVersionId ? 'active' : ''}`}
                    onClick={() => handleSelectVersion(version.id)}
                  >
                    <div className="version-header">
                      <span className="version-name" title={version.isOriginal ? version.path : version.name}>
                        {displayName}
                      </span>
                      {version.isOriginal && (
                        <span className="version-badge">{t('versions.badge')}</span>
                      )}
                    </div>
                    <div className="version-stats-compact">
                      <span className="stat-item">{version.frameCount} {t('common.frames')}</span>
                      <span className="stat-divider">•</span>
                      <span className="stat-item">{durationInSeconds}s</span>
                      <span className="stat-divider">•</span>
                      <span className="stat-item">{fileSizeDisplay}</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="versions-actions" style={{ marginTop: 'auto', paddingTop: '8px', borderTop: '1px solid #e0e0e0' }}>
              <button className="action-button" style={{ width: '100%', justifyContent: 'center' }} onClick={handleExport}>
                💾 {t('versions.exportSelected')}
              </button>
            </div>
          </div>
        </div>

        {/* 时间轴区域 - 横跨整个宽度 */}
        {/* 去重处理时显示进度，否则显示时间轴 */}
        <div className="timeline-section">
          {(dedupProgress || isApplyingDedup) ? (
            <div className="dedup-progress-panel" style={{ width: '100%', margin: 0 }}>
              <div className="dedup-progress-message">
                {dedupProgress?.message || (isApplyingDedup ? '正在处理...' : '')}
              </div>
              {dedupProgress?.current !== undefined && dedupProgress?.total !== undefined && dedupProgress.total > 0 && (
                <div className="dedup-progress-bar">
                  <div 
                    className="dedup-progress-fill"
                    style={{ width: `${Math.min(100, Math.max(0, ((dedupProgress.current || 0) / dedupProgress.total) * 100))}%` }}
                  ></div>
                </div>
              )}
              {dedupProgress?.details && (
                <div className="dedup-progress-details">{dedupProgress.details}</div>
              )}
            </div>
          ) : (
            <FrameTimeline
              frames={frames}
              currentFrame={currentFrame}
              onFrameSelect={handleFrameSelect}
              rangeStart={rangeStart}
              rangeEnd={rangeEnd}
              previewsDir={previewFilesDir}
            />
          )}
        </div>

        {/* Tab 控制区域 */}
        {frames.length > 0 && (
        <div className="tabs-section">
          {/* Tab 标签 */}
          <div className="tabs-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex' }}>
              <button
                className={`tab-button ${activeTab === 'speed' ? 'active' : ''}`}
                onClick={() => setActiveTab('speed')}
              >
                {t('tabs.speed')}
              </button>
              <button
                className={`tab-button ${activeTab === 'segment' ? 'active' : ''}`}
                onClick={() => setActiveTab('segment')}
              >
                {t('tabs.segment')}
              </button>
              <button
                className={`tab-button ${activeTab === 'dedup' ? 'active' : ''}`}
                onClick={() => setActiveTab('dedup')}
              >
                {t('tabs.dedup')}
              </button>
              <button
                className={`tab-button ${activeTab === 'resize' ? 'active' : ''}`}
                onClick={() => setActiveTab('resize')}
              >
                {t('tabs.resize')}
              </button>
              <button
                className={`tab-button ${activeTab === 'fps' ? 'active' : ''}`}
                onClick={() => setActiveTab('fps')}
              >
                {t('tabs.fps')}
              </button>
            </div>
            
            <button 
              className="reset-icon-button" 
              onClick={handleReloadReset}
              title={t('speed.reloadReset')}
              style={{ 
                marginRight: '8px', 
                background: 'none',
                border: 'none',
                fontSize: '1.2rem',
                padding: '4px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'opacity 0.2s'
              }}
            >
              🔄
            </button>
          </div>

          {/* Tab 内容 */}
          <div className="tabs-content">
            {activeTab === 'speed' && (
              <div className="tab-panel">
                {/* 单帧延迟控制和应用按钮 */}
                <div className="speed-control-row">
                  <div className="delay-editor">
                    <label className="delay-label">{t('speed.currentFrameDelay', { frame: currentFrame })}</label>
                    <input
                      type="range"
                      min="10"
                      max="1000"
                      step="10"
                      value={frames[currentFrame]?.delay || 100}
                      onChange={(e) => {
                        const newDelay = parseInt(e.target.value, 10);
                        handleFrameDelayChange(currentFrame, newDelay);
                      }}
                      className="delay-slider"
                    />
                    <input
                      type="number"
                      min="10"
                      max="10000"
                      value={frames[currentFrame]?.delay || 100}
                      onChange={(e) => {
                        const newDelay = parseInt(e.target.value, 10);
                        if (!isNaN(newDelay) && newDelay > 0) {
                          handleFrameDelayChange(currentFrame, newDelay);
                        }
                      }}
                      className="delay-input"
                    />
                    <span className="delay-unit">ms</span>
                    <button
                      onClick={() => handleResetFrameDelay(currentFrame)}
                      className="delay-reset-button"
                      disabled={frames[currentFrame]?.delay === originalFrames[currentFrame]?.delay}
                      title={t('speed.resetTo', { val: originalFrames[currentFrame]?.delay ?? 100 })}
                      aria-label={t('speed.resetTo', { val: originalFrames[currentFrame]?.delay ?? 100 })}
                      style={{
                        width: '22px',
                        height: '22px',
                        padding: 0,
                        marginLeft: '6px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: '1px solid #ccc',
                        borderRadius: '3px',
                        background: '#f5f5f5',
                        cursor: 'pointer'
                      }}
                    >
                      ↺
                    </button>
                  </div>
                  
                  <div className="delay-editor" style={{ marginLeft: '16px' }}>
                    <label className="delay-label">{t('speed.maxDelayCap')}</label>
                    <input
                      type="range"
                      min={minDelayCap}
                      max={capMax ?? (frames[longestFrameIndex]?.delay || 100)}
                      step={10}
                      value={maxDelayCap ?? (frames[longestFrameIndex]?.delay || 100)}
                      onChange={(e) => {
                        const raw = parseInt(e.target.value, 10);
                        if (!isNaN(raw) && raw > 0) {
                          const cap = Math.max(minDelayCap, raw);
                          setMaxDelayCap(cap);
                          setFrames(prev => prev.map(f => ({ ...f, delay: Math.min(f.delay, cap) })));
                        }
                      }}
                      className="delay-slider"
                    />
                    <input
                      type="number"
                      min={minDelayCap}
                      max={capMax ?? (frames[longestFrameIndex]?.delay || 100)}
                      step={10}
                      value={maxDelayCap ?? (frames[longestFrameIndex]?.delay || 100)}
                      onChange={(e) => {
                        const raw = parseInt(e.target.value, 10);
                        if (!isNaN(raw) && raw > 0) {
                          const cap = Math.max(minDelayCap, raw);
                          setMaxDelayCap(cap);
                          setFrames(prev => prev.map(f => ({ ...f, delay: Math.min(f.delay, cap) })));
                        }
                      }}
                      className="delay-input"
                      style={{ width: '100px' }}
                    />
                    <span className="delay-unit">ms</span>
                    <span style={{ marginLeft: '8px', fontSize: '12px', color: '#666' }}>#{longestFrameIndex}</span>
                  </div>

                  {/* 应用修改按钮（统一为分辨率 Tab 的样式） */}
                  <button
                    onClick={handleApplyChanges}
                    className={`apply-dedup-button ${isApplyingChanges ? 'processing' : ''}`}
                    disabled={(isApplyingChanges) || (!hasUnsavedChanges && !(rangeTargetDuration !== frames.slice(rangeStart, rangeEnd + 1).reduce((s, f) => s + (f?.delay || 0), 0)))}
                  >
                    {isApplyingChanges ? (
                      <>
                        <span className="button-icon spinning">⏳</span>
                        <span className="button-text">{t('progress.processing')}</span>
                      </>
                    ) : (
                      <>
                        <span className="button-icon">✓</span>
                        <span className="button-text">{t('actions.saveResult')}</span>
                      </>
                    )}
                  </button>
                </div>

                {/* 批量范围控制 */}
                <div className="range-selector">
            <div className="range-controls">
              <div className="range-inputs">
                <label className="range-label">{t('segment.rangeSelect')}</label>
                <div className="range-input-group">
                  <span className="range-input-label">{t('segment.rangeStart')}</span>
                  <input
                    type="number"
                    min="0"
                    max={Math.max(0, (gifStats?.frame_count || frames.length) - 1)}
                    value={rangeStart}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (!isNaN(val)) {
                        handleRangeStartChange(val);
                      }
                    }}
                    className="range-number-input"
                  />
                </div>
                <span className="range-separator">-</span>
                <div className="range-input-group">
                  <span className="range-input-label">{t('segment.rangeEnd')}</span>
                  <input
                    type="number"
                    min="0"
                    max={Math.max(0, (gifStats?.frame_count || frames.length) - 1)}
                    value={rangeEnd}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (!isNaN(val)) {
                        handleRangeEndChange(val);
                      }
                    }}
                    className="range-number-input"
                  />
                </div>
                <span className="range-info">
                  ({rangeEnd - rangeStart + 1} {t('common.frames')})
                </span>
              </div>
              
              <div className="range-actions">
                <button
                  onClick={handleSpeedUp}
                  className="range-action-button speed-up"
                >
                  {t('speed.speedUp')}
                </button>
                <button
                  onClick={handleSlowDown}
                  className="range-action-button slow-down"
                >
                  {t('speed.slowDown')}
                </button>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '16px' }}>
                  <label style={{ fontSize: '12px' }}>{t('speed.rangeDuration')}</label>
                  <input
                    type="number"
                    min={10}
                    value={rangeTargetDuration}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      if (!isNaN(v) && v > 0) {
                        setRangeTargetDuration(v);
                        setFrames(prev => {
                          const currentRangeSum = prev.slice(rangeStart, rangeEnd + 1).reduce((s, f) => s + (f?.delay || 0), 0);
                          if (currentRangeSum <= 0) return prev;
                          const ratio = v / currentRangeSum;
                          const next = prev.map((f, i) => {
                            if (i >= rangeStart && i <= rangeEnd) {
                              const nd = Math.max(10, Math.round(f.delay * ratio));
                              return { ...f, delay: nd };
                            }
                            return f;
                          });
                          let newRangeSum = next.slice(rangeStart, rangeEnd + 1).reduce((s, f) => s + f.delay, 0);
                          let diff = v - newRangeSum;
                          if (diff !== 0) {
                            const dir = diff > 0 ? 1 : -1;
                            let remaining = Math.abs(diff);
                            for (let pass = 0; pass < 2 && remaining > 0; pass++) {
                              for (let i = rangeStart; i <= rangeEnd && remaining > 0; i++) {
                                const cand = next[i].delay + dir;
                                if (dir < 0 && cand < 10) continue;
                                next[i] = { ...next[i], delay: cand };
                                remaining -= 1;
                              }
                            }
                          }
                          return next;
                        });
                      }
                    }}
                    className="delay-input"
                    style={{ width: '100px' }}
                  />
                  <span className="delay-unit">ms</span>
                  <button
                    onClick={() => {
                      const sumOrig = originalFrames.slice(rangeStart, rangeEnd + 1).reduce((s, f) => s + (f?.delay || 0), 0);
                      setRangeTargetDuration(sumOrig);
                      setFrames(prevFrames => {
                        const newFrames = [...prevFrames];
                        for (let i = rangeStart; i <= rangeEnd; i++) {
                          const orig = originalFrames[i]?.delay;
                          if (orig !== undefined) {
                            newFrames[i] = { ...newFrames[i], delay: orig };
                          }
                        }
                        return newFrames;
                      });
                    }}
                    className="delay-reset-button"
                  >
                    {t('speed.resetToOriginal', { duration: (originalFrames.slice(rangeStart, rangeEnd + 1).reduce((s, f) => s + (f?.delay || 0), 0) / 1000).toFixed(3) })}
                  </button>
                </div>
              </div>
            </div>
            
            {/* 范围滑块 - 自定义实现 */}
            <div className="range-slider-container">
              <div className="range-track">
                <div
                  className="range-track-selected"
                  style={{
                    left: `${(rangeStart / Math.max(1, (gifStats?.frame_count || frames.length) - 1)) * 100}%`,
                    right: `${100 - (rangeEnd / Math.max(1, (gifStats?.frame_count || frames.length) - 1)) * 100}%`,
                  }}
                ></div>
              </div>
              
              {/* 起始滑块（自定义圆形按钮） */}
              <div
                className="custom-range-thumb custom-range-thumb-start"
                style={{
                  left: `${(rangeStart / Math.max(1, (gifStats?.frame_count || frames.length) - 1)) * 100}%`,
                }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  console.log('[TEMP_DEBUG] Start Thumb PointerDown');
                  setActiveSlider('start');
                  
                  const container = e.currentTarget.parentElement;
                  if (!container) return;
                  
                  const handlePointerMove = (moveEvent: PointerEvent) => {
                    const rect = container.getBoundingClientRect();
                    const x = Math.max(0, Math.min(moveEvent.clientX - rect.left, rect.width));
                    const percent = x / rect.width;
                    const maxIndex = Math.max(0, (gifStats?.frame_count || frames.length) - 1);
                    const frameIndex = Math.round(percent * maxIndex);
                    console.log('[TEMP_DEBUG] DragStart', { percent, frameIndex, maxIndex });
                    handleRangeStartChange(frameIndex);
                  };
                  
                  const handlePointerUp = () => {
                    console.log('[TEMP_DEBUG] Start Thumb PointerUp');
                    setActiveSlider(null);
                    document.removeEventListener('pointermove', handlePointerMove);
                    document.removeEventListener('pointerup', handlePointerUp);
                  };
                  
                  document.addEventListener('pointermove', handlePointerMove);
                  document.addEventListener('pointerup', handlePointerUp);
                }}
              >
                <span className="thumb-label">{t('common.start')}</span>
              </div>
              
              {/* 结束滑块（自定义圆形按钮） */}
              <div
                className="custom-range-thumb custom-range-thumb-end"
                style={{
                  left: `${(rangeEnd / Math.max(1, (gifStats?.frame_count || frames.length) - 1)) * 100}%`,
                }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  console.log('[TEMP_DEBUG] End Thumb PointerDown');
                  setActiveSlider('end');
                  
                  const container = e.currentTarget.parentElement;
                  if (!container) return;
                  
                  const handlePointerMove = (moveEvent: PointerEvent) => {
                    const rect = container.getBoundingClientRect();
                    const x = Math.max(0, Math.min(moveEvent.clientX - rect.left, rect.width));
                    const percent = x / rect.width;
                    const maxIndex = Math.max(0, (gifStats?.frame_count || frames.length) - 1);
                    const frameIndex = Math.round(percent * maxIndex);
                    console.log('[TEMP_DEBUG] DragEnd', { percent, frameIndex, maxIndex });
                    handleRangeEndChange(frameIndex);
                  };
                  
                  const handlePointerUp = () => {
                    console.log('[TEMP_DEBUG] End Thumb PointerUp');
                    setActiveSlider(null);
                    document.removeEventListener('pointermove', handlePointerMove);
                    document.removeEventListener('pointerup', handlePointerUp);
                  };
                  
                  document.addEventListener('pointermove', handlePointerMove);
                  document.addEventListener('pointerup', handlePointerUp);
                }}
              >
                <span className="thumb-label">{t('common.end')}</span>
              </div>
            </div>
                </div>
              </div>
            )}
            {activeTab === 'segment' && (
              <div className="tab-panel">
                {/* 分段 - 范围选择器 */}
                <div className="range-selector">
                  <div className="range-controls">
                    <div className="range-inputs">
                      <label className="range-label">{t('segment.rangeSelect')}</label>
                      <div className="range-input-group">
                        <span className="range-input-label">{t('segment.rangeStart')}</span>
                        <input
                          type="number"
                          min="0"
                          max={Math.max(0, (gifStats?.frame_count || frames.length) - 1)}
                          value={segmentRangeStart}
                          onChange={(e) => {
                            const val = parseInt(e.target.value, 10);
                            if (!isNaN(val)) {
                              const maxIndex = Math.max(0, (gifStats?.frame_count || frames.length) - 1);
                              const newStart = Math.max(0, Math.min(val, segmentRangeEnd));
                              console.log('[TEMP_DEBUG] SegmentStartChange', { input: val, newStart, maxIndex, segmentRangeEnd });
                              setSegmentRangeStart(newStart);
                              setCurrentFrame(newStart);
                            }
                          }}
                          className="range-number-input"
                        />
                      </div>
                      <span className="range-separator">-</span>
                      <div className="range-input-group">
                        <span className="range-input-label">{t('segment.rangeEnd')}</span>
                        <input
                          type="number"
                          min="0"
                          max={Math.max(0, (gifStats?.frame_count || frames.length) - 1)}
                          value={segmentRangeEnd}
                          onChange={(e) => {
                            const val = parseInt(e.target.value, 10);
                            if (!isNaN(val)) {
                              const maxIndex = Math.max(0, (gifStats?.frame_count || frames.length) - 1);
                              const newEnd = Math.max(segmentRangeStart, Math.min(val, maxIndex));
                              console.log('[TEMP_DEBUG] SegmentEndChange', { input: val, newEnd, maxIndex, segmentRangeStart });
                              setSegmentRangeEnd(newEnd);
                              setCurrentFrame(newEnd);
                            }
                          }}
                          className="range-number-input"
                        />
                      </div>
                      <span className="range-info">
                        ({segmentRangeEnd - segmentRangeStart + 1} {t('common.frames')})
                      </span>
                    </div>
                    
                    <div className="range-actions">
                      <div style={{ display: 'flex', alignItems: 'center', marginRight: '10px' }}>
                        <input
                          type="checkbox"
                          id="re-optimize-after-slice"
                          checked={reOptimizeAfterSlice}
                          onChange={(e) => setReOptimizeAfterSlice(e.target.checked)}
                          style={{ marginRight: '4px' }}
                        />
                        <label htmlFor="re-optimize-after-slice" style={{ fontSize: '12px', cursor: 'pointer' }}>
                          {t('segment.reOptimize')}
                        </label>
                      </div>
                      <button
                        onClick={handleSliceSave}
                        className="range-action-button"
                        style={{
                          background: 'linear-gradient(180deg, #ffffff 0%, #f5f5f5 100%)',
                          border: '1px solid #c0c0c0',
                          color: '#333',
                          marginRight: '10px'
                        }}
                      >
                        {t('segment.sliceSave')}
                      </button>
                      <div style={{ display: 'flex', alignItems: 'center' }}>
                        <input
                          type="checkbox"
                          id="slice-only-selected"
                          checked={isSliceOnlySelected}
                          onChange={(e) => setIsSliceOnlySelected(e.target.checked)}
                          style={{ marginRight: '4px' }}
                        />
                        <label htmlFor="slice-only-selected" style={{ fontSize: '12px', cursor: 'pointer' }}>
                          {t('segment.onlySelected')}
                        </label>
                      </div>
                      <div
                        style={{
                          width: '1px',
                          height: '20px',
                          backgroundColor: '#c0c0c0',
                          margin: '0 10px'
                        }}
                      />
                      <button
                        onClick={handleDeleteSegment}
                        className="range-action-button"
                        style={{
                          background: 'linear-gradient(180deg, #ffffff 0%, #f5f5f5 100%)',
                          border: '1px solid #c0c0c0',
                          color: '#333'
                        }}
                      >
                        {t('segment.deleteSave')}
                      </button>
                    </div>
                  </div>
                  
                  {/* 范围滑块 - 分段独立状态 */}
                  <div className="range-slider-container">
                    <div className="range-track">
                      <div
                        className="range-track-selected"
                        style={{
                          left: `${(segmentRangeStart / Math.max(1, (gifStats?.frame_count || frames.length) - 1)) * 100}%`,
                          right: `${100 - (segmentRangeEnd / Math.max(1, (gifStats?.frame_count || frames.length) - 1)) * 100}%`,
                          background: '#8b5cf6'
                        }}
                      ></div>
                    </div>
                    
                    {/* 起始滑块 */}
                    <div
                      className="custom-range-thumb"
                      style={{
                        left: `${(segmentRangeStart / Math.max(1, (gifStats?.frame_count || frames.length) - 1)) * 100}%`,
                        borderColor: '#7c3aed'
                      }}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        setActiveSlider('start'); // 复用状态，仅用于禁用滚动等全局交互
                        
                        const container = e.currentTarget.parentElement;
                        if (!container) return;
                        
                        const handlePointerMove = (moveEvent: PointerEvent) => {
                          const rect = container.getBoundingClientRect();
                          const x = Math.max(0, Math.min(moveEvent.clientX - rect.left, rect.width));
                        const percent = x / rect.width;
                        const maxIndex = Math.max(0, (gifStats?.frame_count || frames.length) - 1);
                        const frameIndex = Math.round(percent * maxIndex);
                        console.log('[TEMP_DEBUG] SegmentDragStart', { percent, frameIndex, maxIndex });
                          const newStart = Math.max(0, Math.min(frameIndex, segmentRangeEnd));
                          setSegmentRangeStart(newStart);
                          setCurrentFrame(newStart);
                        };
                        
                        const handlePointerUp = () => {
                          setActiveSlider(null);
                          document.removeEventListener('pointermove', handlePointerMove);
                          document.removeEventListener('pointerup', handlePointerUp);
                        };
                        
                        document.addEventListener('pointermove', handlePointerMove);
                        document.addEventListener('pointerup', handlePointerUp);
                      }}
                    >
                      <span className="thumb-label">起始</span>
                    </div>
                    
                    {/* 结束滑块 */}
                    <div
                      className="custom-range-thumb"
                      style={{
                        left: `${(segmentRangeEnd / Math.max(1, (gifStats?.frame_count || frames.length) - 1)) * 100}%`,
                        borderColor: '#7c3aed'
                      }}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        setActiveSlider('end');
                        
                        const container = e.currentTarget.parentElement;
                        if (!container) return;
                        
                        const handlePointerMove = (moveEvent: PointerEvent) => {
                          const rect = container.getBoundingClientRect();
                          const x = Math.max(0, Math.min(moveEvent.clientX - rect.left, rect.width));
                        const percent = x / rect.width;
                        const maxIndex = Math.max(0, (gifStats?.frame_count || frames.length) - 1);
                        const frameIndex = Math.round(percent * maxIndex);
                        const newEnd = Math.max(segmentRangeStart, Math.min(frameIndex, maxIndex));
                        console.log('[TEMP_DEBUG] SegmentDragEnd', { percent, frameIndex, maxIndex, newEnd });
                          setSegmentRangeEnd(newEnd);
                          setCurrentFrame(newEnd);
                        };
                        
                        const handlePointerUp = () => {
                          setActiveSlider(null);
                          document.removeEventListener('pointermove', handlePointerMove);
                          document.removeEventListener('pointerup', handlePointerUp);
                        };
                        
                        document.addEventListener('pointermove', handlePointerMove);
                        document.addEventListener('pointerup', handlePointerUp);
                      }}
                    >
                      <span className="thumb-label">结束</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
            {activeTab === 'dedup' && (
              <div className="tab-panel">
                <div className="dedup-controls resize-controls">
                  {/* 三栏并排显示 */}
                  <div className="dedup-params-row">
                    {/* 输出质量 */}
                    <div className="dedup-param-column">
                      <div className="dedup-param-group">
                        <label className="dedup-param-label">
                          {t('dedup.outputQuality')} <span className="dedup-param-value">{dedupQuality}</span>
                        </label>
                        <input
                          type="range"
                          min="1"
                          max="100"
                          value={dedupQuality}
                          onChange={(e) => setDedupQuality(parseInt(e.target.value, 10))}
                          className="dedup-slider"
                        />
                        <div className="dedup-param-hint">{t('dedup.qualityHint')}</div>
                      </div>
                    </div>

                    {/* 分隔竖线 */}
                    <div className="dedup-column-divider"></div>

                    {/* 相似度阈值 */}
                    <div className="dedup-param-column">
                      <div className="dedup-param-group">
                        <label className="dedup-param-label">
                          {t('dedup.similarityThreshold')} <span className="dedup-param-value">{dedupThreshold}%</span>
                        </label>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={dedupThreshold}
                          onChange={(e) => setDedupThreshold(parseInt(e.target.value, 10))}
                          className="dedup-slider"
                        />
                        <div className="dedup-param-hint">{t('dedup.thresholdHint')}</div>
                      </div>
                    </div>

                    {/* 分隔竖线 */}
                    <div className="dedup-column-divider"></div>

                    {/* 颜色数量 */}
                    <div className="dedup-param-column">
                      <div className="dedup-param-group">
                        <label className="dedup-param-label">
                          {t('dedup.colorCount')} <span className="dedup-param-value">{dedupColors}</span>
                        </label>
                        <input
                          type="range"
                          min="2"
                          max="256"
                          step="1"
                          value={dedupColors}
                          onChange={(e) => setDedupColors(parseInt(e.target.value, 10))}
                          className="dedup-slider"
                        />
                        <div className="dedup-param-hint">{t('dedup.colorHint')}</div>
                      </div>
                    </div>
                  </div>

                  {/* 强制使用调色板模式和保存成果按钮 */}
                  <div className="dedup-actions-row">
                    <div className="dedup-checkbox-section">
                      <label className="dedup-checkbox-label">
                        <input
                          type="checkbox"
                          checked={dedupUsePalette}
                          onChange={(e) => setDedupUsePalette(e.target.checked)}
                          className="dedup-checkbox"
                        />
                        <span>{t('dedup.forcePalette')}</span>
                      </label>
                      <div className="dedup-param-hint">{t('dedup.paletteHint')}</div>
                    </div>
                    <div className="dedup-actions">
                      <button
                        onClick={handleApplyDedup}
                        className={`apply-dedup-button ${isApplyingDedup ? 'processing' : ''}`}
                        disabled={isApplyingDedup}
                      >
                        {isApplyingDedup ? (
                          <>
                            <span className="button-icon spinning">⏳</span>
                            <span className="button-text">{t('progress.processing')}</span>
                          </>
                        ) : (
                          <>
                            <span className="button-icon">✓</span>
                            <span className="button-text">{t('actions.saveResult')}</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
            {activeTab === 'resize' && (
              <div className="tab-panel">
                <div className="dedup-controls resize-controls">
                  <div className="dedup-param-hint" style={{ marginBottom: '8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span>{t('resize.originalResolution', { width: dimensions.width, height: dimensions.height })}</span>
                      <button
                        title={t('resize.resetToOriginal')}
                        onClick={() => {
                          setResizeWidth(dimensions.width || 0);
                          setResizeHeight(dimensions.height || 0);
                          setKeepAspect(true);
                        }}
                        style={{
                          background: 'none',
                          border: '1px solid #d1d1d1',
                          borderRadius: '4px',
                          width: '18px',
                          height: '18px',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '12px',
                          cursor: 'pointer',
                          color: '#666'
                        }}
                      >
                        ↺
                      </button>
                    </div>
                    <div className="dedup-actions">
                      <button
                        onClick={handleApplyResize}
                        className={`apply-dedup-button ${isResizing ? 'processing' : ''}`}
                        disabled={
                          isResizing ||
                          (dimensions.width > 0 && dimensions.height > 0 &&
                           resizeWidth === dimensions.width && resizeHeight === dimensions.height)
                        }
                      >
                        {isResizing ? (
                          <>
                            <span className="button-icon spinning">⏳</span>
                            <span className="button-text">{t('progress.processing')}</span>
                          </>
                        ) : (
                          <>
                            <span className="button-icon">✓</span>
                            <span className="button-text">{t('actions.saveResult')}</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                  <div className="dedup-params-row">
                    <div className="dedup-param-column" style={{ flex: '0 0 auto' }}>
                      {/* 标签行：仅显示文字与数值，便于下方输入对齐链条 */}
                      <div style={{ display: 'grid', gridTemplateColumns: '80px 56px 80px', alignItems: 'end', columnGap: '12px', marginBottom: '6px' }}>
                        <div className="dedup-param-label">{t('resize.targetWidth')}</div>
                        <div></div>
                        <div className="dedup-param-label">{t('resize.targetHeight')}</div>
                      </div>
                      {/* 输入行：左右输入框 + 中间锁链，连线对齐输入中心 */}
                        <div style={{ display: 'grid', gridTemplateColumns: '80px 44px 80px', alignItems: 'center', columnGap: '12px' }}>
                        <div style={{ margin: 0 }}>
                          <input
                            type="number"
                            min="1"
                            value={resizeWidth}
                            onChange={(e) => {
                              const val = parseInt(e.target.value, 10) || 0;
                              setResizeWidth(val);
                              if (keepAspect && dimensions.width > 0 && dimensions.height > 0) {
                                const ratio = dimensions.height / Math.max(1, dimensions.width);
                                setResizeHeight(Math.max(1, Math.round(val * ratio)));
                              }
                            }}
                            className="range-number-input"
                            style={{ width: '80px' }}
                          />
                        </div>
                        <div style={{ position: 'relative', height: '34px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <div style={{ position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)', height: '2px', width: '54px', backgroundColor: '#888', zIndex: 1 }}></div>
                          <button
                            onClick={() => setKeepAspect(!keepAspect)}
                            title={keepAspect ? t('resize.lockAspect') : t('resize.unlockAspect')}
                            style={{
                              background: 'none',
                              border: 'none',
                              borderRadius: '0',
                              width: '36px',
                              height: '36px',
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '14px',
                              cursor: 'pointer',
                              color: '#333',
                              position: 'relative',
                              zIndex: 2
                            }}
                          >
                            {keepAspect ? (
                              <svg width="36" height="36" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
                                <rect x="6.667" y="11.333" width="10.667" height="1.333" rx="0.667" fill="#fff" />
                                <rect x="6" y="8" width="12" height="8" rx="4" ry="4" fill="none" stroke="#888" strokeWidth="1.333" />
                              </svg>
                            ) : (
                              <svg width="36" height="36" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
                                <rect x="6" y="11.166" width="12" height="1.667" rx="0.333" fill="#fff" />
                                <path d="M9 6 A6 6 0 0 0 9 18" stroke="#888" strokeWidth="1.333" fill="none" />
                                <path d="M15 6 A6 6 0 0 1 15 18" stroke="#888" strokeWidth="1.333" fill="none" />
                              </svg>
                            )}
                          </button>
                          <div style={{ position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)', height: '2px', width: '54px', backgroundColor: '#888', zIndex: 1 }}></div>
                        </div>
                        <div style={{ margin: 0 }}>
                          <input
                            type="number"
                            min="1"
                            value={resizeHeight}
                            onChange={(e) => {
                              const val = parseInt(e.target.value, 10) || 0;
                              setResizeHeight(val);
                              if (keepAspect && dimensions.width > 0 && dimensions.height > 0) {
                                const ratio = dimensions.width / Math.max(1, dimensions.height);
                                setResizeWidth(Math.max(1, Math.round(val * ratio)));
                              }
                            }}
                            className="range-number-input"
                            style={{ width: '80px' }}
                          />
                        </div>
                      </div>
                    </div>
                    <div className="dedup-column-divider"></div>
                    <div className="dedup-param-column">
                      <div className="dedup-param-group">
                        <label className="dedup-param-label">{t('resize.methodLabel')}</label>
                        <select
                          value={resizeMethod}
                          onChange={(e) => setResizeMethod(e.target.value)}
                          className="range-number-input"
                        >
                          <option value="mix">{t('resize.methods.mix')}</option>
                          <option value="box">{t('resize.methods.box')}</option>
                          <option value="catrom">{t('resize.methods.catrom')}</option>
                          <option value="mitchell">{t('resize.methods.mitchell')}</option>
                          <option value="lanczos2">{t('resize.methods.lanczos2')}</option>
                          <option value="lanczos3">{t('resize.methods.lanczos3')}</option>
                        </select>
                        <div className="dedup-param-hint">
                          {resizeMethod === 'mix' ? t('resize.methods.mix') :
                           resizeMethod === 'box' ? t('resize.methods.box') :
                           (resizeMethod === 'catrom' || resizeMethod === 'mitchell') ? t('resize.methods.catrom') :
                           (resizeMethod === 'lanczos2' || resizeMethod === 'lanczos3') ? t('resize.methods.lanczos2') :
                           ''}
                        </div>
                      </div>
                    </div>
                  </div>
                  
                </div>
              </div>
            )}
            {activeTab === 'fps' && (
              <div className="tab-panel">
                <div className="dedup-controls resize-controls">
                  <div className="dedup-params-row">
                    {/* 抽帧间隔设置 */}
                    <div className="dedup-param-column" style={{ flex: '0 0 25%' }}>
                      <div className="dedup-param-group">
                        <label className="dedup-param-label">
                          {t('fps.dropInterval')} <span className="dedup-param-value">{t('fps.keepOneEvery', { n: fpsKeepInterval })}</span>
                        </label>
                        <input
                          type="range"
                          min="2"
                          max="10"
                          value={fpsKeepInterval}
                          onChange={(e) => setFpsKeepInterval(parseInt(e.target.value, 10))}
                          className="dedup-slider"
                        />
                        <div className="dedup-param-hint">
                          {t('fps.intervalHint')}
                        </div>
                      </div>
                    </div>

                    {/* 分隔竖线 */}
                    <div className="dedup-column-divider"></div>

                    {/* 时延阈值 */}
                    <div className="dedup-param-column" style={{ flex: '0 0 25%' }}>
                      <div className="dedup-param-group">
                        <label className="dedup-param-label">
                          {t('fps.delayThreshold')} <span className="dedup-param-value">{fpsDelayThreshold}ms ({Math.round(1000 / fpsDelayThreshold)} fps)</span>
                        </label>
                        <input
                          type="range"
                          min="10"
                          max="500"
                          step="10"
                          value={fpsDelayThreshold}
                          onChange={(e) => setFpsDelayThreshold(parseInt(e.target.value, 10))}
                          className="dedup-slider"
                        />
                        <div className="dedup-param-hint">
                          {t('fps.thresholdHint')}
                        </div>
                      </div>
                    </div>

                    {/* 分隔竖线 */}
                    <div className="dedup-column-divider"></div>

                    {/* 统计信息 */}
                    <div className="dedup-param-column" style={{ flex: '0 0 25%', fontSize: '11px', color: '#666', lineHeight: '1.6' }}>
                        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                            <span>{t('fps.dropped')} <b style={{color:'#dc3545'}}>{fpsPreview.originalFrameCount - fpsPreview.newFrameCount}</b> {t('extract.fullFrames').replace(':','')} 
                            {fpsPreview.originalFrameCount > 0 && (
                                <span style={{ marginLeft: '2px' }}>
                                    (-{((1 - fpsPreview.newFrameCount / fpsPreview.originalFrameCount) * 100).toFixed(0)}%)
                                </span>
                            )}
                            </span>
                            </div>
                            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                            <span>{t('fps.estSize')} <b style={{color:'#28a745'}}>{gifStats?.file_size ? formatBytes(Math.round(gifStats.file_size * fpsPreview.newFrameCount / fpsPreview.originalFrameCount)) : '-'}</b>
                            </span>
                        </div>
                        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                            <span>{t('fps.duration')} <b>{(fpsPreview.totalDuration / 1000).toFixed(2)}s</b></span>
                            </div>
                            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                          <span>{t('fps.modeFps')} <b>{fpsPreview.fpsModes.length > 0 ? (
                            fpsPreview.fpsModes.map((mode, idx) => (
                              <span key={idx}>
                                {t('fps.modeCount', { fps: mode.fps, count: mode.count })} &nbsp;
                              </span>
                            ))
                          ) : (
                            <span style={{ color: '#888' }}>-</span>
                          )}</b></span>
                        </div>
                    </div>

                    {/* 分隔竖线 */}
                    <div className="dedup-column-divider"></div>

                    {/* 按钮 */}
                    <div className="dedup-param-column" style={{ flex: '0 0 15%', display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
                      <button
                        onClick={handleApplyFpsReduce}
                        className={`apply-dedup-button ${isApplyingFps ? 'processing' : ''}`}
                        disabled={isApplyingFps || frames.length < 2 || fpsPreview.newFrameCount >= fpsPreview.originalFrameCount}
                        style={{ padding: '0 16px', height: '36px', fontSize: '13px', whiteSpace: 'nowrap' }}
                      >
                        {isApplyingFps ? (
                          <>
                            <span className="button-icon spinning">⏳</span>
                            <span className="button-text">{t('progress.processing')}</span>
                          </>
                        ) : (
                          <>
                            <span className="button-icon">✓</span>
                            <span className="button-text">{t('actions.saveResult')}</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* 提示信息 */}
                  <div className="dedup-param-hint" style={{ marginTop: '12px', padding: '8px', background: '#fff3cd', borderRadius: '4px', fontSize: '12px' }}>
                    {t('fps.hint')}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
        )}
      </main>
      
      {/* 底部状态栏 */}
      <footer className="app-status-bar">
        <span className="status-label">
          {loadedWorkspacePath ? t('footer.workspace') : t('footer.tempWorkspace')}
        </span>
        <span className="status-value" title={loadedWorkspacePath || workDir}>
          {loadedWorkspacePath || workDir}
        </span>
      </footer>

    </div>
    </>
  );
}

export default App;
