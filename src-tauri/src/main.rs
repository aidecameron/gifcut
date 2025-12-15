// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::Read;
use std::io::Write;
use std::time::Duration;
use std::path::PathBuf;
use std::env::temp_dir;
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use image::{DynamicImage, Rgb, RgbImage};
use gif::{DecodeOptions, Decoder};
use tauri::Manager;

// 全局暂停状态
static EXTRACT_PAUSED: Mutex<bool> = Mutex::new(false);
// 全局取消状态：用于彻底停止当前后台解压线程
static EXTRACT_CANCELLED: Mutex<bool> = Mutex::new(false);
// 线程句柄：用于在取消时 join，避免线程驻留
static FULLFRAMES_HANDLE: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);
static PREVIEWS_HANDLE: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);

// 辅助函数：执行 sidecar 命令并打印日志
fn run_sidecar_with_logging(command: &str, args: Vec<String>) -> Result<tauri::api::process::Output, String> {
    println!("[TEMP_DEBUG] [CMD] {} {}", command, args.join(" "));
    let cmd = tauri::api::process::Command::new_sidecar(command)
        .map_err(|e| format!("创建 sidecar 命令失败: {}", e))?;
    let output = cmd.args(args).output()
        .map_err(|e| format!("调用 {} 失败: {}", command, e))?;
    
    let stdout = output.stdout.as_str();
    let lines: Vec<&str> = stdout.lines().collect();
    let last_lines = if lines.len() > 5 {
        &lines[lines.len() - 5..]
    } else {
        &lines[..]
    };
    
    if !last_lines.is_empty() {
        println!("[TEMP_DEBUG] [CMD RESULT] Last 5 lines:\n{}", last_lines.join("\n"));
    } else {
        println!("[TEMP_DEBUG] [CMD RESULT] (Empty output)");
    }
    
    Ok(output)
}

#[derive(Debug, Serialize, Deserialize)]
struct GifStats {
    frame_count: usize,
    total_duration: f64, // 秒
    avg_fps: f64,
    min_fps: f64,
    max_fps: f64,
    file_size: u64,
    mode1_fps: Option<f64>, // 第一众数帧率
    mode1_count: Option<usize>, // 第一众数出现次数
    mode2_fps: Option<f64>, // 第二众数帧率
    mode2_count: Option<usize>, // 第二众数出现次数
}

// 初始化工作目录
#[tauri::command]
fn init_work_dir() -> Result<String, String> {
    let temp = temp_dir();
    let work_dir = temp.join(format!("gif-editor-{}", std::process::id()));
    
    // 保留已有目录，仅在不存在时创建
    if !work_dir.exists() {
        fs::create_dir_all(&work_dir).map_err(|e| e.to_string())?;
    }
    
    Ok(work_dir.to_str().unwrap().to_string())
}

// 清理工作目录中的临时文件
#[tauri::command]
fn cleanup_work_dir(work_dir: String) -> Result<(), String> {
    let wd = PathBuf::from(&work_dir);
    
    // 清理 fullframes 目录
    let fullframes_dir = wd.join("fullframes");
    if fullframes_dir.exists() {
        fs::remove_dir_all(&fullframes_dir).map_err(|e| format!("清理 fullframes 目录失败: {}", e))?;
    }
    
    // 清理 previews 目录
    let previews_dir = wd.join("previews");
    if previews_dir.exists() {
        fs::remove_dir_all(&previews_dir).map_err(|e| format!("清理 previews 目录失败: {}", e))?;
    }
    
    // 清理 _temp 前缀的文件
    if wd.exists() {
        let entries = fs::read_dir(&wd).map_err(|e| format!("读取工作目录失败: {}", e))?;
        for entry in entries {
            if let Ok(entry) = entry {
                let path = entry.path();
                if path.is_file() {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        if name.starts_with("_temp") {
                            let _ = fs::remove_file(&path);
                        }
                    }
                }
            }
        }
    }
    
    Ok(())
}

// 获取文件大小
#[tauri::command]
fn get_file_size(path: String) -> Result<u64, String> {
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(metadata.len())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GifPreviewResult {
    width: u32,
    height: u32,
    frame_count: usize,
    delays_ms: Vec<u16>,
    preview_dir: String,
    preview_files: Vec<String>,
    preview_width: u32,
    preview_height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ParseProgress {
    stage: String,
    current: usize,
    total: usize,
}

#[tauri::command]
async fn parse_gif_preview(
    app: tauri::AppHandle,
    gif_path: String,
    work_dir: String,
    max_preview: Option<u32>,
    reuse_frames_dir: Option<String>,
) -> Result<GifPreviewResult, String> {
    let path = gif_path.clone();
    let wd = work_dir.clone();
    let mps = max_preview.unwrap_or(120);
    let app_handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<GifPreviewResult, String> {
        let file = std::fs::File::open(&path).map_err(|e| format!("打开文件失败: {}", e))?;
        let mut opts = DecodeOptions::new();
        opts.set_color_output(gif::ColorOutput::RGBA);
        let reader = opts.read_info(file).map_err(|e| format!("读取 GIF 信息失败: {}", e))?;
        let width = reader.width() as u32;
        let height = reader.height() as u32;

        // 如果提供了复用目录，直接使用其中的 frame.* 作为预览
        if let Some(reuse_dir_str) = reuse_frames_dir.clone() {
            let reuse_dir = PathBuf::from(reuse_dir_str);
            if reuse_dir.exists() {
                // 获取延迟信息
                let info_output = run_sidecar_with_logging("gifsicle", vec!["--info".to_string(), path.clone()])?;
                if !info_output.status.success() {
                    return Err(format!("gifsicle 获取信息失败: {}", info_output.stderr.as_str()));
                }
                let mut delays_ms: Vec<u16> = Vec::new();
                for line in info_output.stdout.as_str().lines() {
                    if line.contains("delay") && line.contains("s") {
                        if let Some(delay_part) = line.split("delay").nth(1) {
                            if let Some(delay_str) = delay_part.trim().split('s').next() {
                                if let Ok(delay) = delay_str.parse::<f64>() {
                                    let ms = (delay * 1000.0).round() as u16;
                                    delays_ms.push(ms);
                                }
                            }
                        }
                    }
                }
                let mut files: Vec<PathBuf> = fs::read_dir(&reuse_dir)
                    .map_err(|e| format!("读取复用目录失败: {}", e))?
                    .filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| p.is_file())
                    .filter(|p| p.file_name().and_then(|s| s.to_str()).map(|n| n.starts_with("frame.")).unwrap_or(false))
                    .collect();
                files.sort();
                let frame_count = files.len();
                let preview_files: Vec<String> = files.iter().filter_map(|p| p.to_str().map(|s| s.to_string())).collect();
                let res = GifPreviewResult {
                    width,
                    height,
                    frame_count,
                    delays_ms,
                    preview_dir: reuse_dir.to_str().unwrap().to_string(),
                    preview_files,
                    preview_width: width,
                    preview_height: height,
                };
                return Ok(res);
            }
        }

        let info_output = run_sidecar_with_logging("gifsicle", vec!["--info".to_string(), path.clone()])?;
        if !info_output.status.success() {
            return Err(format!("gifsicle 获取信息失败: {}", info_output.stderr.as_str()));
        }
        let mut delays_ms: Vec<u16> = Vec::new();
        for line in info_output.stdout.as_str().lines() {
            if line.contains("delay") && line.contains("s") {
                if let Some(delay_part) = line.split("delay").nth(1) {
                    if let Some(delay_str) = delay_part.trim().split('s').next() {
                        if let Ok(delay) = delay_str.parse::<f64>() {
                            let ms = (delay * 1000.0).round() as u16;
                            delays_ms.push(ms);
                        }
                    }
                }
            }
        }

        // 只生成 temp_color_restored.gif，不解压预览帧
        let base_name = std::path::Path::new(&path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("gif")
            .to_string();
        let mut safe_base = String::new();
        for c in base_name.chars() {
            if c.is_ascii_alphanumeric() {
                safe_base.push(c);
            } else {
                safe_base.push('_');
                safe_base.push_str(&(c as u32).to_string());
            }
        }
        
        let temp_color_path = PathBuf::from(&wd).join(format!("_{}_temp_color_restored.gif", safe_base));
        let temp_unopt_path = PathBuf::from(&wd).join(format!("_{}_temp_unoptimized.gif", safe_base));
        
        // 第一步：生成 color_restored（如果不存在或不完整）
        let need_color_restored = if temp_color_path.exists() {
            // 检查文件大小是否合理（至少大于0）
            if let Ok(metadata) = fs::metadata(&temp_color_path) {
                let size = metadata.len();
                if size == 0 {
                    println!("[TEMP_DEBUG] [parse_gif_preview] color_restored 文件大小为0，重新生成");
                    true
                } else {
                    println!("[TEMP_DEBUG] [parse_gif_preview] color_restored 文件已存在且完整 ({} bytes)", size);
                    false
                }
            } else {
                true
            }
        } else {
            true
        };
        
        if need_color_restored {
            // 发送"恢复颜色"开始通知
            let _ = app_handle.emit_all("gif-prep-progress", serde_json::json!({
                "stage": "color_restore",
                "status": "start",
                "message": "恢复颜色"
            }));
            
            let color_args: Vec<String> = vec![
                "--colors=255".to_string(),
                path.clone(),
                "-o".to_string(),
                temp_color_path.to_str().unwrap().to_string(),
            ];
            
            let color_output = run_sidecar_with_logging("gifsicle", color_args)?;
            if !color_output.status.success() {
                return Err(format!("gifsicle 还原颜色失败: {}", color_output.stderr.as_str()));
            }
            
            // 发送"恢复颜色"完成通知
            let _ = app_handle.emit_all("gif-prep-progress", serde_json::json!({
                "stage": "color_restore",
                "status": "complete",
                "message": "恢复颜色"
            }));
        }
        
        // 第二步：生成 unoptimized（如果不存在或不完整）- 这里统一生成，后台线程只负责 explode
        let need_unoptimized = if temp_unopt_path.exists() {
            // 检查文件大小是否合理（至少大于0）
            if let Ok(metadata) = fs::metadata(&temp_unopt_path) {
                let size = metadata.len();
                if size == 0 {
                    println!("[TEMP_DEBUG] [parse_gif_preview] unoptimized 文件大小为0，重新生成");
                    true
                } else {
                    println!("[TEMP_DEBUG] [parse_gif_preview] unoptimized 文件已存在且完整 ({} bytes)", size);
                    false
                }
            } else {
                true
            }
        } else {
            true
        };
        
        if need_unoptimized {
            println!("[TEMP_DEBUG] [parse_gif_preview] 生成 unoptimized 版本...");
            
            // 发送"恢复优化"开始通知
            let _ = app_handle.emit_all("gif-prep-progress", serde_json::json!({
                "stage": "unoptimize",
                "status": "start",
                "message": "恢复优化"
            }));
            
            let unopt_args: Vec<String> = vec![
                "--unoptimize".to_string(),
                temp_color_path.to_str().unwrap().to_string(),
                "-o".to_string(),
                temp_unopt_path.to_str().unwrap().to_string(),
            ];
            
            let unopt_output = run_sidecar_with_logging("gifsicle", unopt_args)?;
            if !unopt_output.status.success() {
                return Err(format!("gifsicle unoptimize 失败: {}", unopt_output.stderr.as_str()));
            }
            println!("[TEMP_DEBUG] [parse_gif_preview] unoptimized 版本生成完成");
            
            // 发送"恢复优化"完成通知
            let _ = app_handle.emit_all("gif-prep-progress", serde_json::json!({
                "stage": "unoptimize",
                "status": "complete",
                "message": "恢复优化"
            }));
        }
        
        // 获取帧数
        let mut frame_count = 0;
        for line in info_output.stdout.as_str().lines() {
            if line.contains("images") {
                if let Some(num_str) = line.split_whitespace()
                    .find(|s| s.parse::<usize>().is_ok())
                {
                    frame_count = num_str.parse().unwrap_or(0);
                }
            }
        }
        
        // 计算预览尺寸（保持宽高比）
        let preview_width;
        let preview_height;
        if width > height {
            preview_width = mps;
            preview_height = (height as f32 / width as f32 * mps as f32) as u32;
        } else {
            preview_height = mps;
            preview_width = (width as f32 / height as f32 * mps as f32) as u32;
        }
        
        let previews_dir = PathBuf::from(&wd).join(format!("_{}_previews", safe_base));
        let preview_files: Vec<String> = vec![]; // 空列表，后台线程会解压
        let res = GifPreviewResult {
            width,
            height,
            frame_count,
            delays_ms,
            preview_dir: previews_dir.to_str().unwrap().to_string(),
            preview_files,
            preview_width,
            preview_height,
        };
        Ok(res)
    })
    .await
    .map_err(|e| format!("后台线程失败: {}", e))??;
    Ok(result)
}

#[derive(Serialize, Clone)]
struct ReadProgress {
    current: u64,
    total: u64,
}

// 以分块方式读取本地文件，并通过事件上报进度
#[tauri::command]
fn read_file_in_chunks(app: tauri::AppHandle, path: String, chunk_size: Option<usize>) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(&path).map_err(|e| format!("读取元数据失败: {}", e))?;
    let total = metadata.len();
    let mut file = std::fs::File::open(&path).map_err(|e| format!("打开文件失败: {}", e))?;
    let mut buf: Vec<u8> = Vec::with_capacity(total as usize);
    let size = chunk_size.unwrap_or(1024 * 512);
    let mut chunk = vec![0u8; size];
    let mut read_total: u64 = 0;

    loop {
        let n = file.read(&mut chunk).map_err(|e| format!("读取文件失败: {}", e))?;
        if n == 0 { break; }
        buf.extend_from_slice(&chunk[..n]);
        read_total += n as u64;
        let _ = app.emit_all("file-read-progress", ReadProgress { current: read_total, total });
    }

    Ok(buf)
}

// 分块复制到工作目录并上报进度，返回目标路径
#[tauri::command]
async fn read_file_to_workdir(
    app: tauri::AppHandle,
    src_path: String,
    work_dir: String,
    filename: Option<String>,
    chunk_size: Option<usize>,
) -> Result<String, String> {
    let app2 = app.clone();
    let src = src_path.clone();
    let wd = work_dir.clone();
    let fname = filename.clone();
    let csz = chunk_size.unwrap_or(1024 * 512);
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let metadata = fs::metadata(&src).map_err(|e| format!("读取元数据失败: {}", e))?;
        let total = metadata.len();
        let base = fname.unwrap_or_else(|| {
            PathBuf::from(&src)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("image.gif")
                .to_string()
        });
        let dest_path = PathBuf::from(&wd).join(&base);

        // 防止源文件与目标文件相同导致源文件被清空
        let src_path_buf = PathBuf::from(&src);
        let same_path = src_path_buf == dest_path;

        // 如果相同，生成一个不冲突的副本文件名
        let final_dest = if same_path {
            let stem: String = std::path::Path::new(&base)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("image")
                .to_string();
            let ext: String = std::path::Path::new(&base)
                .extension()
                .and_then(|s| s.to_str())
                .map(|e| format!(".{}", e))
                .unwrap_or_else(|| String::from(""));
            let mut idx = 1;
            loop {
                let alt_name = format!("{}-copy-{}{}", stem, idx, ext);
                let alt = PathBuf::from(&wd).join(&alt_name);
                if !alt.exists() {
                    break alt;
                }
                idx += 1;
            }
        } else {
            dest_path.clone()
        };

        let mut in_f = std::fs::File::open(&src).map_err(|e| format!("打开源文件失败: {}", e))?;
        let mut out_f = std::fs::File::create(&final_dest).map_err(|e| format!("创建目标文件失败: {}", e))?;
        let mut chunk = vec![0u8; csz];
        let mut read_total: u64 = 0;
        loop {
            let n = in_f.read(&mut chunk).map_err(|e| format!("读取文件失败: {}", e))?;
            if n == 0 { break; }
            out_f.write_all(&chunk[..n]).map_err(|e| format!("写入文件失败: {}", e))?;
            read_total += n as u64;
            let _ = app2.emit_all("file-read-progress", ReadProgress { current: read_total, total });
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(final_dest.to_str().unwrap().to_string())
    })
    .await
    .map_err(|e| format!("后台线程失败: {}", e))??;
    Ok(result)
}

// 复制文件到工作目录
#[tauri::command]
fn copy_to_workdir(source_path: String, work_dir: String, filename: String) -> Result<String, String> {
    let dest_path = PathBuf::from(&work_dir).join(&filename);
    fs::copy(&source_path, &dest_path).map_err(|e| e.to_string())?;
    Ok(dest_path.to_str().unwrap().to_string())
}

// 写入二进制文件到工作目录
#[tauri::command]
fn write_binary_file(work_dir: String, filename: String, data: Vec<u8>) -> Result<String, String> {
    let file_path = PathBuf::from(&work_dir).join(&filename);
    fs::write(&file_path, data).map_err(|e| format!("写入文件失败: {}", e))?;
    Ok(file_path.to_str().unwrap().to_string())
}

// 使用 gifsicle 获取 GIF 统计信息
#[tauri::command]
fn get_gif_stats(gif_path: String) -> Result<GifStats, String> {
    // 使用 Tauri sidecar 调用 gifsicle
    // 调用 gifsicle --info
    let output = run_sidecar_with_logging("gifsicle", vec!["--info".to_string(), gif_path.clone()])?;
    
    if !output.status.success() {
        return Err(format!("gifsicle 执行失败: {}", output.stderr.as_str()));
    }
    
    let info_text = output.stdout.as_str();
    
    // 解析输出
    let mut frame_count = 0;
    let mut total_delay = 0.0;
    let mut delays: Vec<f64> = Vec::new();
    
    for line in info_text.lines() {
        // 提取帧数: "* example.gif 162 images"
        if line.contains("images") {
            if let Some(num_str) = line.split_whitespace()
                .find(|s| s.parse::<usize>().is_ok())
            {
                frame_count = num_str.parse().unwrap_or(0);
            }
        }
        
        // 提取延迟: "delay 0.05s"
        if line.contains("delay") && line.contains("s") {
            if let Some(delay_part) = line.split("delay").nth(1) {
                if let Some(delay_str) = delay_part.trim().split('s').next() {
                    if let Ok(delay) = delay_str.parse::<f64>() {
                        delays.push(delay);
                        total_delay += delay;
                    }
                }
            }
        }
    }
    
    // 计算统计信息
    let avg_fps = if total_delay > 0.0 && !delays.is_empty() {
        delays.len() as f64 / total_delay
    } else {
        0.0
    };
    
    let min_fps = delays.iter()
        .map(|&d| if d > 0.0 { 1.0 / d } else { 0.0 })
        .min_by(|a, b| a.partial_cmp(b).unwrap())
        .unwrap_or(0.0);
    
    let max_fps = delays.iter()
        .map(|&d| if d > 0.0 { 1.0 / d } else { 0.0 })
        .max_by(|a, b| a.partial_cmp(b).unwrap())
        .unwrap_or(0.0);
    
    let file_size = get_file_size(gif_path)?;
    
    // 计算帧率众数（前两位）
    // 1. 计算每帧的帧率并四舍五入到整数
    let mut fps_counts: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
    for delay in &delays {
        if *delay > 0.0 {
            let fps = (1.0 / delay + 0.5) as u32; // 四舍五入
            *fps_counts.entry(fps).or_insert(0) += 1;
        }
    }
    
    // 2. 按出现次数排序，找出前两位
    let mut fps_vec: Vec<(u32, usize)> = fps_counts.into_iter().collect();
    fps_vec.sort_by(|a, b| b.1.cmp(&a.1)); // 按次数降序排序
    
    let mode1_fps = fps_vec.get(0).map(|(fps, _)| *fps as f64);
    let mode1_count = fps_vec.get(0).map(|(_, count)| *count);
    let mode2_fps = fps_vec.get(1).map(|(fps, _)| *fps as f64);
    let mode2_count = fps_vec.get(1).map(|(_, count)| *count);
    
    Ok(GifStats {
        frame_count,
        total_duration: total_delay,
        avg_fps,
        min_fps,
        max_fps,
        file_size,
        mode1_fps,
        mode1_count,
        mode2_fps,
        mode2_count,
    })
}

// 使用 gifsicle 修改 GIF 帧延迟
#[tauri::command]
fn modify_gif_delays(
    input_path: String,
    output_path: String,
    frame_delays: Vec<u16>, // 毫秒
) -> Result<String, String> {
    // 使用 Tauri sidecar 调用 gifsicle
    
    // 构建参数列表
    let mut args: Vec<String> = vec![input_path.clone()];
    
    // 为每一帧设置延迟
    for (i, &delay_ms) in frame_delays.iter().enumerate() {
        let delay_cs = delay_ms / 10; // 转换为百分之一秒
        args.push("--delay".to_string());
        args.push(format!("{}", delay_cs));
        args.push(format!("#{}", i));
    }
    
    // 输出文件
    args.push("--output".to_string());
    args.push(output_path.clone());
    
    // 设置参数并执行命令（链式调用）
    let output = run_sidecar_with_logging("gifsicle", args)?;
    
    if !output.status.success() {
        let stderr = output.stderr.as_str();
        return Err(format!("gifsicle 执行失败: {}", stderr));
    }
    
    Ok(output_path)
}

// 通用：检查任意路径是否存在（绕过前端 FS scope 限制）
#[tauri::command]
fn path_exists(path: String) -> Result<bool, String> {
    Ok(std::path::Path::new(&path).exists())
}

// 通用：读取目录下的文件名列表（仅一级，绕过前端 FS scope 限制）
#[tauri::command]
fn read_dir_filenames(path: String) -> Result<Vec<String>, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("目录不存在: {}", path));
    }
    if !p.is_dir() {
        return Err(format!("不是目录: {}", path));
    }
    let mut names: Vec<String> = Vec::new();
    for entry in fs::read_dir(p).map_err(|e| format!("读取目录失败: {}", e))? {
        let entry = entry.map_err(|e| e.to_string())?;
        if let Some(name) = entry.file_name().to_str() {
            names.push(name.to_string());
        }
    }
    Ok(names)
}

fn check_if_optimized(path: &str) -> Result<bool, String> {
    let output = run_sidecar_with_logging("gifsicle", vec!["-I".to_string(), "--verbose".to_string(), path.to_string()])?;
    
    if !output.status.success() {
        return Err(format!("gifsicle 获取信息失败: {}", output.stderr.as_str()));
    }

    let txt = output.stdout.as_str();
    let mut logical_w: Option<usize> = None;
    let mut logical_h: Option<usize> = None;
    
    for line in txt.lines() {
        let trim = line.trim();
        if trim.starts_with("logical screen") {
            if let Some(dims) = trim.split_whitespace().find(|s| s.contains('x')) {
                if let Some((w, h)) = dims.split_once('x') {
                    logical_w = w.parse().ok();
                    logical_h = h.parse().ok();
                }
            }
        } else if trim.starts_with("+ image #") {
            // format: + image #N WxH
            // or: + image #N WxH at X,Y
            let parts: Vec<&str> = trim.split_whitespace().collect();
            // parts[0]="+", parts[1]="image", parts[2]="#N", parts[3]="WxH"
            if parts.len() >= 4 {
                if let Some((w, h)) = parts[3].split_once('x') {
                    let iw: usize = w.parse().unwrap_or(0);
                    let ih: usize = h.parse().unwrap_or(0);
                    
                    if let (Some(lw), Some(lh)) = (logical_w, logical_h) {
                        if iw != lw || ih != lh {
                            return Ok(true);
                        }
                    }
                }
                
                // check for "at X,Y"
                if let Some(at_idx) = parts.iter().position(|&x| x == "at") {
                    if at_idx + 1 < parts.len() {
                        let coords = parts[at_idx + 1]; // "X,Y"
                        if let Some((x, y)) = coords.split_once(',') {
                            let ix: usize = x.parse().unwrap_or(0);
                            let iy: usize = y.parse().unwrap_or(0);
                            if ix != 0 || iy != 0 {
                                return Ok(true);
                            }
                        }
                    }
                }
            }
        }
    }
    
    Ok(false)
}

// 保存 GIF 切片（指定范围和延迟）
#[tauri::command]
fn save_gif_slice(
    input_path: String,
    output_path: String,
    start_index: usize,
    end_index: usize,
    frame_delays: Vec<u16>, // 切片后每一帧的延迟（毫秒）
    _frame_order: Option<Vec<usize>>, // 可选：显式帧顺序
    optimize: bool,
) -> Result<String, String> {
    let range_len = if end_index >= start_index { end_index - start_index + 1 } else { 0 };
    if frame_delays.len() != range_len {
        return Err(format!("延迟数组长度 ({}) 与帧数 ({}) 不匹配", frame_delays.len(), range_len));
    }

    let out_dir = std::path::Path::new(&output_path)
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "无法确定输出目录".to_string())?;
    let base_name = std::path::Path::new(&input_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("gif")
        .to_string();
    let mut safe_base = String::new();
    for c in base_name.chars() {
        if c.is_ascii_alphanumeric() { safe_base.push(c); }
        else { safe_base.push('_'); safe_base.push_str(&(c as u32).to_string()); }
    }
    
    // 1. 如果存在 _<safebase>_temp_unoptimized.gif，则优先基于该文件操作
    let input_dir = std::path::Path::new(&input_path)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let temp_unopt_path = input_dir.join(format!("_{}_temp_unoptimized.gif", safe_base));
    let effective_input = if temp_unopt_path.exists() { temp_unopt_path.to_str().unwrap().to_string() } else { input_path.clone() };

    // 2. Check optimization（基于有效输入）
    let is_optimized = if temp_unopt_path.exists() && effective_input == temp_unopt_path.to_str().unwrap().to_string() {
        false
    } else {
        check_if_optimized(&effective_input)?
    };
    println!("[TEMP_DEBUG] GIF is optimized: {}", is_optimized);

    let frame_range = if start_index == end_index {
        format!("#{}", start_index)
    } else {
        format!("#{}-{}", start_index, end_index)
    };

    if is_optimized {
        // Step 2: Optimized path
        // a. Restore palette: gifsicle --colors=255 <input> -o <restored>
        let restored_path = out_dir.join(format!("_{}_temp_color_restored.gif", safe_base));
        let restored_str = restored_path.to_str().unwrap().to_string();
        if !restored_path.exists() {
            let out1 = run_sidecar_with_logging("gifsicle", vec![
                    "--colors=255".to_string(),
                    input_path.clone(),
                    "-o".to_string(),
                    restored_str.clone()
                ])?;
            if !out1.status.success() {
                return Err(format!("gifsicle 还原调色板失败: {}", out1.stderr.as_str()));
            }
        }

        // b. Unoptimize specific range: gifsicle --unopt <restored> '<frame_range>' -o <unopt_target>
        let unopt_path = out_dir.join(format!("_{}_temp_slice-unopt_{}-{}.gif", safe_base, start_index, end_index));
        let unopt_str = unopt_path.to_str().unwrap().to_string();
        
        // Construct input with frame selection: restored.gif"#range"
        // Note: passing selection as part of filename argument usually works in gifsicle CLI
        // but here we are passing args to process.
        // Gifsicle syntax: `gifsicle input.gif"#0-5"`
        // We can pass `restored_str` then `frame_range` as separate arg? No, usually it's attached.
        // Or we can use `--unopt` `restored_str` `frame_range` (as a frame selection argument).
        // Let's try passing the range string as a separate argument which acts as a frame selection on the previous input?
        // No, typically: `gifsicle --unopt input.gif '#0-5' -o output.gif`
        // The `#0-5` is a frame selection applied to the input.
        // In `Command::args`, we should pass it as a separate string if it's a separate shell argument.
        // `gifsicle input.gif #0-5`
        
        if !unopt_path.exists() {
        let out2 = run_sidecar_with_logging("gifsicle", vec![
                    "--unopt".to_string(),
                    restored_str.clone(),
                    frame_range.clone(),
                    "-o".to_string(),
                    unopt_str.clone()
                ])?;
            if !out2.status.success() {
                return Err(format!("gifsicle Unoptimize 切片失败: {}", out2.stderr.as_str()));
            }
        }
        
        // c. Apply delays without optimization, write to final output
        let mut args3 = vec![unopt_str.clone()];
        for (i, &delay_ms) in frame_delays.iter().enumerate() {
            let cs = delay_ms / 10;
            args3.push("--delay".to_string());
            args3.push(cs.to_string());
            args3.push(format!("#{}", i));
        }
        args3.push("-o".to_string());
        args3.push(output_path.clone());
        let out3 = run_sidecar_with_logging("gifsicle", args3)?;
        if !out3.status.success() {
            return Err(format!("gifsicle 应用延迟失败: {}", out3.stderr.as_str()));
        }
        
    } else {
        // Step 3: Direct Slicing (Not optimized)
        // gifsicle <input> '<range>' ... -o <final>
        
        // We first slice it to a temp file to ensure we have the right frames to apply delays to?
        // Or can we do it in one go?
        // `gifsicle input.gif"#0-5" --delay ...`
        // If we apply `--delay` it might apply to the input frames before selection or after?
        // Usually safer to slice first then apply delays if we have complex per-frame delays.
        // But let's try to be efficient.
        // If we use `input.gif` and select frames, we get a stream of frames.
        // If we then append `--delay` args...
        // `gifsicle input.gif"#0" --delay d0 input.gif"#1" --delay d1 ...` -> this repeats input file read.
        // Better: Slice to temp, then apply delays.
        
        let sliced_path = out_dir.join(format!("_{}_temp_sliced_{}-{}.gif", safe_base, start_index, end_index));
        let sliced_str = sliced_path.to_str().unwrap().to_string();
        if !sliced_path.exists() {
        let out_slice = run_sidecar_with_logging("gifsicle", vec![
                    effective_input.clone(),
                    frame_range.clone(),
                    "-o".to_string(),
                    sliced_str.clone()
                ])?;
            if !out_slice.status.success() {
                return Err(format!("gifsicle 切片失败: {}", out_slice.stderr.as_str()));
            }
        }
        
        // Apply delays to sliced file
        let mut args_delay = vec![sliced_str.clone()];
        
        for (i, &delay_ms) in frame_delays.iter().enumerate() {
            let cs = delay_ms / 10;
            args_delay.push("--delay".to_string());
            args_delay.push(cs.to_string());
            args_delay.push(format!("#{}", i));
        }
        
        args_delay.push("-o".to_string());
        args_delay.push(output_path.clone());
        
        let out_delay = run_sidecar_with_logging("gifsicle", args_delay)?;
        if !out_delay.status.success() {
            return Err(format!("gifsicle 应用延迟失败: {}", out_delay.stderr.as_str()));
        }
    }

    // Optional optimization step
    if optimize {
        let opt_out = run_sidecar_with_logging("gifsicle", vec![
            "-b".to_string(),
            "-O3".to_string(),
            output_path.clone(),
        ])?;
        if !opt_out.status.success() {
            return Err(format!("gifsicle 优化失败: {}", opt_out.stderr.as_str()));
        }
    }

    Ok(output_path)
}

 

// 导出文件（复制到指定路径）
#[tauri::command]
fn save_file(source_path: String, dest_path: String) -> Result<(), String> {
    fs::copy(&source_path, &dest_path).map_err(|e| e.to_string())?;
    Ok(())
}

// 写入文件到指定路径
#[tauri::command]
fn write_file_to_path(path: String, data: Vec<u8>) -> Result<(), String> {
    fs::write(&path, data).map_err(|e| format!("写入文件失败: {}", e))?;
    Ok(())
}

// 递归复制目录
#[tauri::command]
fn copy_dir_recursive(source_dir: String, dest_dir: String) -> Result<(), String> {
    let src = PathBuf::from(&source_dir);
    let dst = PathBuf::from(&dest_dir);
    if !src.exists() {
        return Err(format!("源目录不存在: {}", source_dir));
    }
    fs::create_dir_all(&dst).map_err(|e| format!("创建目标目录失败: {}", e))?;
    fn copy_rec(s: &std::path::Path, d: &std::path::Path) -> Result<(), String> {
        for entry in fs::read_dir(s).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let p = entry.path();
            let name = entry.file_name();
            let dp = d.join(name);
            if p.is_dir() {
                fs::create_dir_all(&dp).map_err(|e| e.to_string())?;
                copy_rec(&p, &dp)?;
            } else {
                fs::copy(&p, &dp).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
    copy_rec(&src, &dst)?;
    Ok(())
}

// 读取文本文件内容
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {}", e))
}


// 读取文件字节内容（用于图像加载）
#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| format!("读取文件失败: {}", e))
}

#[tauri::command]
fn read_temp_file(rel_path: String) -> Result<Vec<u8>, String> {
    let p = temp_dir().join(&rel_path);
    let pid_prefix = format!("gif-editor-{}", std::process::id());
    if !rel_path.starts_with(&pid_prefix) && !rel_path.starts_with("gif-editor-") {
        return Err("invalid temp path".to_string());
    }
    let mut f = fs::File::open(&p).map_err(|e| e.to_string())?;
    let mut buf: Vec<u8> = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

// 删除 GIF 中的指定帧范围
#[tauri::command]
fn delete_gif_frames(
    input_path: String,
    output_path: String,
    start_index: usize,
    end_index: usize,
    optimize: bool,
) -> Result<String, String> {
    // 使用 Tauri sidecar 调用 gifsicle
    
    // 如果存在 _<safebase>_temp_unoptimized.gif，则优先基于该文件操作
    let base_name = std::path::Path::new(&input_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("gif")
        .to_string();
    let mut safe_base = String::new();
    for c in base_name.chars() { if c.is_ascii_alphanumeric() { safe_base.push(c); } else { safe_base.push('_'); safe_base.push_str(&(c as u32).to_string()); } }
    let input_dir = std::path::Path::new(&input_path)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let temp_unopt_path = input_dir.join(format!("_{}_temp_unoptimized.gif", safe_base));
    let effective_input = if temp_unopt_path.exists() { temp_unopt_path.to_str().unwrap().to_string() } else { input_path.clone() };

    // 构建参数列表
    // gifsicle input.gif --delete "#start-end" -o output.gif
    let mut args: Vec<String> = vec![effective_input.clone()];
    
    // 忽略警告
    args.push("--no-warnings".to_string());
    
    // 删除指定范围的帧
    if start_index == end_index {
        args.push("--delete".to_string());
        args.push(format!("#{}", start_index));
    } else {
        args.push("--delete".to_string());
        args.push(format!("#{}-{}", start_index, end_index));
    }
    
    // 输出文件
    args.push("--output".to_string());
    args.push(output_path.clone());
    
    println!("Executing gifsicle delete command: {} to {}", start_index, end_index);
    
    // 设置参数并执行命令
    let output = run_sidecar_with_logging("gifsicle", args)?;
    
    if !output.status.success() {
        let stderr = output.stderr.as_str();
        println!("Gifsicle delete failed: {}", stderr);
        return Err(format!("gifsicle 执行失败: {}", stderr));
    }
    
    println!("Gifsicle delete success: created {}", output_path);

    if optimize {
        let opt_out = run_sidecar_with_logging("gifsicle", vec![
            "-b".to_string(),
            "-O3".to_string(),
            output_path.clone(),
        ])?;
        if !opt_out.status.success() {
            return Err(format!("gifsicle 优化失败: {}", opt_out.stderr.as_str()));
        }
    }

    Ok(output_path)
}

// 测试 gifski 是否可用
#[tauri::command]
fn test_gifski_version() -> Result<String, String> {
    let output = run_sidecar_with_logging("gifski", vec!["--version".to_string()])?;
        
    if !output.status.success() {
        return Err(format!("gifski 执行失败: {}", output.stderr));
    }
    
    Ok(output.stdout)
}

// 计算感知哈希 (pHash) - 简化版本，使用差异哈希 (dHash)
fn compute_phash(img: &DynamicImage) -> Result<u64, String> {
    // 缩放到 9x8 (用于 dHash) 或 32x32 (用于 pHash)
    // 这里使用 dHash 作为简化实现，因为它不需要 DCT
    let small = img.resize_exact(9, 8, image::imageops::FilterType::Lanczos3);
    let gray = small.to_luma8();
    
    // 计算水平差异哈希
    let mut hash: u64 = 0;
    for y in 0..8 {
        for x in 0..8 {
            let left = gray.get_pixel(x, y)[0] as i32;
            let right = gray.get_pixel(x + 1, y)[0] as i32;
            if left > right {
                hash |= 1 << (y * 8 + x);
            }
        }
    }
    
    Ok(hash)
}

// 计算 Hamming 距离
fn hamming_distance(hash1: u64, hash2: u64) -> u32 {
    (hash1 ^ hash2).count_ones()
}

// 帧信息结构
struct FrameInfo {
    delay: f64, // 秒
    hash: u64,
    path: PathBuf, // PNG 路径（用于哈希计算）
    original_gif_path: PathBuf, // 原始 GIF 帧文件路径（用于最终输出）
}

// 进度事件结构
#[derive(Debug, Clone, Serialize, Deserialize)]
struct DedupProgress {
    stage: String,  // "extracting", "deduplicating", "rebuilding", "complete"
    message: String,
    current: Option<usize>,
    total: Option<usize>,
    details: Option<String>,
}

// GIF 去重命令 - 立即返回，在后台线程执行
#[tauri::command]
fn dedup_gif(
    window: tauri::Window,
    input_path: String,
    output_path: String,
    quality: u8,
    threshold: u8,
    colors: u16,
    use_palette: bool,
) -> Result<String, String> {
    // 获取 AppHandle 用于发送事件到所有窗口
    let app = window.app_handle();
    
    // 克隆 AppHandle 用于后台线程
    let app_clone = app.clone();
    
    // 发送开始处理事件（在主线程）
    println!("[TEMP_DEBUG] Emitting starting event");
    if let Err(e) = app.emit_all("dedup-progress", DedupProgress {
        stage: "starting".to_string(),
        message: format!("开始处理: {}", input_path),
        current: None,
        total: None,
        details: None,
    }) {
        println!("[TEMP_DEBUG] Failed to emit starting event: {}", e);
    }
    
    // 在后台线程中执行耗时操作，不阻塞主线程
    std::thread::spawn(move || {
        let result = dedup_gif_worker(
            app_clone.clone(),
            input_path.clone(),
            output_path.clone(),
            quality,
            threshold,
            colors,
            use_palette,
        );
        
        // 通过事件发送结果
        match result {
            Ok(path) => {
                // 成功已经在 worker 中发送了 complete 事件
                println!("[TEMP_DEBUG] Dedup completed successfully: {}", path);
            }
            Err(err) => {
                // 发送错误事件
                println!("[TEMP_DEBUG] Dedup failed: {}", err);
                let _ = app_clone.emit_all("dedup-progress", DedupProgress {
                    stage: "error".to_string(),
                    message: format!("去重失败: {}", err),
                    current: None,
                    total: None,
                    details: None,
                });
            }
        }
    });
    
    // 立即返回，不等待后台线程
    Ok("处理已开始，请等待完成".to_string())
}

// 后台工作函数
fn dedup_gif_worker(
    app: tauri::AppHandle,
    input_path: String,
    output_path: String,
    quality: u8,
    threshold: u8,
    colors: u16,
    use_palette: bool,
) -> Result<String, String> {
    // 验证参数
    if quality < 1 || quality > 100 {
        return Err("质量参数必须在 1-100 之间".to_string());
    }
    if threshold > 100 {
        return Err("阈值参数必须在 0-100 之间".to_string());
    }
    if colors < 2 {
        return Err("颜色数量必须至少为 2".to_string());
    }
    
    // 发送开始处理事件
    println!("[TEMP_DEBUG] Emitting starting event (in worker thread)");
    if let Err(e) = app.emit_all("dedup-progress", DedupProgress {
        stage: "starting".to_string(),
        message: format!("开始处理: {}", input_path),
        current: None,
        total: None,
        details: None,
    }) {
        println!("[TEMP_DEBUG] Failed to emit starting event: {}", e);
    } else {
        println!("[TEMP_DEBUG] Starting event emitted successfully");
    }
    // 给 UI 一些时间来处理初始事件
    std::thread::sleep(std::time::Duration::from_millis(50));
    
    // 计算 Hamming 阈值（从相似度百分比转换）
    // threshold 是相似度百分比 (0-100)，我们需要转换为 Hamming 距离
    // 64位哈希，100%相似度 = 0 距离，0%相似度 = 64 距离
    let hamming_threshold = ((100 - threshold as u32) * 64 / 100).max(1);
    
    // 创建临时目录
    let temp_dir = temp_dir().join(format!("gif_dedup_{}", std::process::id()));
    fs::create_dir_all(&temp_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;
    
    let frames_dir = temp_dir.join("frames");
    let unique_frames_dir = temp_dir.join("unique");
    fs::create_dir_all(&frames_dir).map_err(|e| format!("创建帧目录失败: {}", e))?;
    fs::create_dir_all(&unique_frames_dir).map_err(|e| format!("创建唯一帧目录失败: {}", e))?;
    
    // 1. 使用 gifsicle 提取帧（更可靠）
    println!("[TEMP_DEBUG] Emitting extracting event");
    if let Err(e) = app.emit_all("dedup-progress", DedupProgress {
        stage: "extracting".to_string(),
        message: "提取帧...".to_string(),
        current: None,
        total: None,
        details: Some(format!("预处理 GIF (使用 {} 种颜色)...", colors)),
    }) {
        println!("[TEMP_DEBUG] Failed to emit extracting event: {}", e);
    }
    
    // 先获取 GIF 信息
    let info_output = run_sidecar_with_logging("gifsicle", vec!["--info".to_string(), input_path.clone()])?;
    
    if !info_output.status.success() {
        return Err(format!("gifsicle 获取信息失败: {}", info_output.stderr.as_str()));
    }
    
    // 解析延迟信息
    let mut delays: Vec<f64> = Vec::new();
    for line in info_output.stdout.as_str().lines() {
        if line.contains("delay") && line.contains("s") {
            if let Some(delay_part) = line.split("delay").nth(1) {
                if let Some(delay_str) = delay_part.trim().split('s').next() {
                    if let Ok(delay) = delay_str.parse::<f64>() {
                        delays.push(delay);
                    }
                }
            }
        }
    }
    
    // 预处理 GIF：先优化颜色表（与命令行脚本一致）
    let optimized_gif = temp_dir.join("optimized.gif");
    
    let optimize_output = run_sidecar_with_logging("gifsicle", vec![
            "--colors".to_string(),
            std::cmp::min(colors as u32, 256).to_string(),
            input_path.clone(),
            "-o".to_string(),
            optimized_gif.to_str().unwrap().to_string(),
        ])?;
    
    // 决定使用哪个文件提取帧
    let source_gif = if optimize_output.status.success() && optimized_gif.exists() {
        println!("使用预处理后的 GIF 提取帧");
        optimized_gif.to_str().unwrap().to_string()
    } else {
        println!("预处理失败，使用原始 GIF 提取帧");
        input_path.clone()
    };
    
    // 提取帧（使用预处理后的 GIF 或原始 GIF）
    let frame_prefix = frames_dir.join("frame");
    let extract_output = run_sidecar_with_logging("gifsicle", vec![
            "--explode".to_string(),
            "--unoptimize".to_string(),
            source_gif,
            "-o".to_string(),
            frame_prefix.to_str().unwrap().to_string(),
        ])?;
    
    if !extract_output.status.success() {
        let stderr = extract_output.stderr.as_str();
        let stdout = extract_output.stdout.as_str();
        return Err(format!("gifsicle 提取帧失败: stderr={}, stdout={}", stderr, stdout));
    }
    
    // 获取所有帧文件（gifsicle --explode 会生成 frame.000, frame.001 等文件）
    let mut frame_files: Vec<PathBuf> = fs::read_dir(&frames_dir)
        .map_err(|e| format!("读取帧目录失败: {}", e))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            // 检查文件名是否以 frame. 开头
            if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                file_name.starts_with("frame.") && path.is_file()
            } else {
                false
            }
        })
        .collect();
    
    // 按文件名排序（确保顺序正确）
    frame_files.sort();
    
    // 如果没找到文件，尝试列出目录内容用于调试
    if frame_files.is_empty() {
        let dir_contents: Vec<String> = fs::read_dir(&frames_dir)
            .map_err(|e| format!("读取帧目录失败: {}", e))?
            .filter_map(|entry| entry.ok())
            .map(|entry| {
                entry.path().file_name()
                    .and_then(|n| n.to_str())
                    .map(|s| s.to_string())
                    .unwrap_or_default()
            })
            .collect();
        return Err(format!("未找到帧文件。目录内容: {:?}", dir_contents));
    }
    
    let mut frame_infos: Vec<FrameInfo> = Vec::new();
    
    // 处理每一帧
    let total_frames = frame_files.len();
    println!("找到 {} 个帧文件，延迟信息数量: {}", total_frames, delays.len());
    
    println!("[TEMP_DEBUG] Emitting total frames event: {}", total_frames);
    if let Err(e) = app.emit_all("dedup-progress", DedupProgress {
        stage: "extracting".to_string(),
        message: format!("总帧数: {}", total_frames),
        current: Some(total_frames),
        total: Some(total_frames),
        details: None,
    }) {
        println!("[TEMP_DEBUG] Failed to emit total frames event: {}", e);
    }
    
    println!("[TEMP_DEBUG] Emitting deduplicating start event");
    if let Err(e) = app.emit_all("dedup-progress", DedupProgress {
        stage: "deduplicating".to_string(),
        message: format!("使用算法去重 (Hamming 阈值: {})...", hamming_threshold),
        current: None,
        total: None,
        details: None,
    }) {
        println!("[TEMP_DEBUG] Failed to emit deduplicating start event: {}", e);
    }
    
    for (i, frame_path) in frame_files.iter().enumerate() {
        // 发送处理进度（每5帧或最后一帧发送一次，更频繁的更新）
        if i % 5 == 0 || i == total_frames - 1 {
            println!("[TEMP_DEBUG] Emitting processing event: {}/{}", i + 1, total_frames);
            if let Err(e) = app.emit_all("dedup-progress", DedupProgress {
                stage: "processing".to_string(),
                message: format!("处理帧 {}/{}", i + 1, total_frames),
                current: Some(i + 1),
                total: Some(total_frames),
                details: None,
            }) {
                println!("[TEMP_DEBUG] Failed to emit processing event: {}", e);
            }
        }
        // 使用 gif crate 读取 GIF 帧文件
        let file = fs::File::open(frame_path).map_err(|e| format!("打开帧文件失败 {}: {}", frame_path.display(), e))?;
        let mut decoder = Decoder::new(file).map_err(|e| format!("创建 GIF 解码器失败: {}", e))?;
        
        // 在读取帧之前先获取解码器信息
        let width = decoder.width() as u32;
        let height = decoder.height() as u32;
        // 复制全局调色板数据（避免借用冲突）
        let global_palette: Option<Vec<u8>> = decoder.global_palette().map(|p| p.to_vec());
        
        // 读取第一帧（每个 frame.xxx 文件应该只包含一帧）
        let mut img: Option<DynamicImage> = None;
        if let Some(frame) = decoder.read_next_frame().map_err(|e| format!("读取帧失败: {}", e))? {
            // 将 GIF 帧数据转换为 RGB 图像
            let mut rgb_img = RgbImage::new(width, height);
            
            // 优先使用帧的本地调色板，否则使用全局调色板
            let palette: Option<&[u8]> = frame.palette.as_deref().or(global_palette.as_deref());
            
            if let Some(palette) = palette {
                // 调色板模式
                for (idx, pixel) in frame.buffer.chunks_exact(1).enumerate() {
                    let palette_idx = pixel[0] as usize;
                    if palette_idx * 3 + 2 < palette.len() {
                        let r = palette[palette_idx * 3];
                        let g = palette[palette_idx * 3 + 1];
                        let b = palette[palette_idx * 3 + 2];
                        let x = (idx % width as usize) as u32;
                        let y = (idx / width as usize) as u32;
                        rgb_img.put_pixel(x, y, Rgb([r, g, b]));
                    }
                }
            } else {
                // 没有调色板，buffer 应该是索引值，但我们需要处理
                // 这种情况通常不会发生，但为了安全起见
                for (idx, &pixel) in frame.buffer.iter().enumerate() {
                    let x = (idx % width as usize) as u32;
                    let y = (idx / width as usize) as u32;
                    // 将索引值作为灰度值
                    rgb_img.put_pixel(x, y, Rgb([pixel, pixel, pixel]));
                }
            }
            
            img = Some(DynamicImage::ImageRgb8(rgb_img));
        }
        
        let img = img.ok_or_else(|| format!("帧文件 {} 没有有效图像数据", frame_path.display()))?;
        
        // 计算哈希
        let hash = compute_phash(&img)?;
        
        // 获取延迟（如果可用，使用索引或默认值）
        let delay = if delays.len() == frame_files.len() {
            delays.get(i).copied().unwrap_or(0.1)
        } else if !delays.is_empty() {
            // 如果延迟数量不匹配，使用第一个延迟或平均延迟
            delays[0]
        } else {
            0.1 // 默认延迟
        };
        
        // 保存为 PNG
        let png_path = frames_dir.join(format!("frame_{:04}.png", i));
        img.save(&png_path).map_err(|e| format!("保存帧失败: {}", e))?;
        
        frame_infos.push(FrameInfo {
            delay,
            hash,
            path: png_path,
            original_gif_path: frame_path.clone(),
        });
    }
    
    if frame_infos.is_empty() {
        return Err("GIF 文件没有帧".to_string());
    }
    
    // 2. 去重：找出唯一帧
    let mut unique_frames: Vec<(usize, f64)> = Vec::new(); // (frame_index, accumulated_delay)
    
    // 第一帧总是保留，初始化累积延迟
    let mut accumulated_delay = frame_infos[0].delay;
    unique_frames.push((0, 0.0)); // 延迟稍后设置
    
    let total_frames_count = frame_infos.len();
    for i in 1..frame_infos.len() {
        // 发送去重进度（每5帧或最后一帧发送一次）
        if i % 5 == 0 || i == total_frames_count - 1 {
            println!("[TEMP_DEBUG] Emitting deduplicating progress: {}/{}", i + 1, total_frames_count);
            if let Err(e) = app.emit_all("dedup-progress", DedupProgress {
                stage: "deduplicating".to_string(),
                message: format!("比较帧 {}/{}", i + 1, total_frames_count),
                current: Some(i + 1),
                total: Some(total_frames_count),
                details: None,
            }) {
                println!("[TEMP_DEBUG] Failed to emit deduplicating progress: {}", e);
            }
        }
        let current_hash = frame_infos[i].hash;
        let prev_unique_index = unique_frames.last().unwrap().0;
        let prev_hash = frame_infos[prev_unique_index].hash;
        
        let distance = hamming_distance(current_hash, prev_hash);
        
        if distance <= hamming_threshold {
            // 重复帧，累加延迟到当前唯一帧
            accumulated_delay += frame_infos[i].delay;
        } else {
            // 不重复，保存前一帧的累积延迟，开始新的累积
            if let Some(last) = unique_frames.last_mut() {
                last.1 = accumulated_delay;
            }
            unique_frames.push((i, 0.0)); // 延迟稍后设置
            accumulated_delay = frame_infos[i].delay;
        }
    }
    
    // 更新最后一帧的延迟（包括第一帧如果是唯一帧的情况）
    if let Some(last) = unique_frames.last_mut() {
        last.1 = accumulated_delay;
    }
    
    // 发送去重结果
    let unique_count = unique_frames.len();
    let removed_count = frame_infos.len() - unique_count;
    println!("[TEMP_DEBUG] Emitting deduplication result");
    if let Err(e) = app.emit_all("dedup-progress", DedupProgress {
        stage: "deduplicating".to_string(),
        message: format!("保留帧数: {} (去除了 {} 帧)", unique_count, removed_count),
        current: Some(unique_count),
        total: Some(frame_infos.len()),
        details: None,
    }) {
        println!("[TEMP_DEBUG] Failed to emit deduplication result: {}", e);
    }
    
    // 3. 复制唯一帧到新目录（从原始 GIF 帧文件读取，类似命令行脚本）
    let mut unique_delays: Vec<f64> = Vec::new();
    for (i, (frame_idx, delay)) in unique_frames.iter().enumerate() {
        // 从原始 GIF 帧文件读取（不是从 PNG）
        let src_gif = &frame_infos[*frame_idx].original_gif_path;
        let dst = unique_frames_dir.join(format!("frame_{:04}.png", i));
        
        // 使用 gif crate 读取 GIF 帧并转换为 PNG（保持质量）
        let file = fs::File::open(src_gif).map_err(|e| format!("打开原始帧文件失败 {}: {}", src_gif.display(), e))?;
        let mut decoder = Decoder::new(file).map_err(|e| format!("创建 GIF 解码器失败: {}", e))?;
        
        let width = decoder.width() as u32;
        let height = decoder.height() as u32;
        let global_palette: Option<Vec<u8>> = decoder.global_palette().map(|p| p.to_vec());
        
        if let Some(frame) = decoder.read_next_frame().map_err(|e| format!("读取帧失败: {}", e))? {
            let mut rgb_img = RgbImage::new(width, height);
            let palette: Option<&[u8]> = frame.palette.as_deref().or(global_palette.as_deref());
            
            if let Some(palette) = palette {
                // 调色板模式
                for (idx, pixel) in frame.buffer.chunks_exact(1).enumerate() {
                    let palette_idx = pixel[0] as usize;
                    if palette_idx * 3 + 2 < palette.len() {
                        let r = palette[palette_idx * 3];
                        let g = palette[palette_idx * 3 + 1];
                        let b = palette[palette_idx * 3 + 2];
                        let x = (idx % width as usize) as u32;
                        let y = (idx / width as usize) as u32;
                        rgb_img.put_pixel(x, y, Rgb([r, g, b]));
                    }
                }
            } else {
                // 没有调色板
                for (idx, &pixel) in frame.buffer.iter().enumerate() {
                    let x = (idx % width as usize) as u32;
                    let y = (idx / width as usize) as u32;
                    rgb_img.put_pixel(x, y, Rgb([pixel, pixel, pixel]));
                }
            }
            
            let img = DynamicImage::ImageRgb8(rgb_img);
            img.save(&dst).map_err(|e| format!("保存帧失败: {}", e))?;
        } else {
            return Err(format!("帧文件 {} 没有有效图像数据", src_gif.display()));
        }
        
        unique_delays.push(*delay);
    }
    
    // 4. 使用 gifski 重建 GIF
    let total_time: f64 = unique_delays.iter().sum();
    println!("[TEMP_DEBUG] Emitting rebuilding event");
    if let Err(e) = app.emit_all("dedup-progress", DedupProgress {
        stage: "rebuilding".to_string(),
        message: format!("重建 GIF (质量: {}, 总时长: {:.2}s)...", quality, total_time),
        current: None,
        total: None,
        details: None,
    }) {
        println!("[TEMP_DEBUG] Failed to emit rebuilding event: {}", e);
    }
    if use_palette {
        let mut args: Vec<String> = Vec::new();
        args.push("--no-warnings".to_string());
        for (i, (_idx, delay)) in unique_frames.iter().enumerate() {
            let src_gif = &frame_infos[unique_frames[i].0].original_gif_path;
            args.push(src_gif.to_str().unwrap().to_string());
            let cs = ((*delay) * 100.0).round() as u32;
            args.push("--delay".to_string());
            args.push(cs.to_string());
        }
        args.push("--colors".to_string());
        args.push(std::cmp::min(colors as u32, 256).to_string());
        args.push("--optimize=3".to_string());
        args.push("-o".to_string());
        args.push(output_path.clone());
        let out = run_sidecar_with_logging("gifsicle", args)?;
        if !out.status.success() {
            return Err(format!("gifsicle 合并失败: {}", out.stderr.as_str()));
        }
    } else {
        let info_output = run_sidecar_with_logging("gifsicle", vec!["--info".to_string(), input_path.clone()])?;
        let mut width = 0;
        let mut height = 0;
        for line in info_output.stdout.as_str().lines() {
            if line.contains("logical screen") {
                if let Some(dims) = line.split_whitespace().find(|s| s.contains('x')) {
                    if let Some((w, h)) = dims.split_once('x') {
                        width = w.parse().unwrap_or(0);
                        height = h.parse().unwrap_or(0);
                    }
                }
            }
        }
        if width == 0 || height == 0 {
            if let Some(first_frame) = frame_infos.first() {
                let img = image::open(&first_frame.path).map_err(|e| format!("打开第一帧失败: {}", e))?;
                width = img.width();
                height = img.height();
            } else {
                return Err("无法确定 GIF 尺寸".to_string());
            }
        }
        let avg_fps = if total_time > 0.0 {
            unique_frames.len() as f64 / total_time
        } else { 10.0 };
        let mut gifski_args = vec![
            "-o".to_string(),
            output_path.clone(),
            "-Q".to_string(),
            quality.to_string(),
            "-r".to_string(),
            format!("{:.2}", avg_fps),
            "-W".to_string(),
            width.to_string(),
            "-H".to_string(),
            height.to_string(),
        ];
        for i in 0..unique_frames.len() {
            let frame_path = unique_frames_dir.join(format!("frame_{:04}.png", i));
            gifski_args.push(frame_path.to_str().unwrap().to_string());
        }
        let gifski_output = run_sidecar_with_logging("gifski", gifski_args)?;
        if !gifski_output.status.success() {
            return Err(format!("gifski 执行失败: {}", gifski_output.stderr.as_str()));
        }
        let temp_output = temp_dir.join("temp_output.gif");
        let adjusted_frames_dir = temp_dir.join("adjusted_frames");
        fs::create_dir_all(&adjusted_frames_dir).map_err(|e| format!("创建调整帧目录失败: {}", e))?;
        let mut temp_frames: Vec<PathBuf> = Vec::new();
        for (i, delay) in unique_delays.iter().enumerate() {
            let delay_cs = (delay * 100.0) as u32;
            let temp_frame = adjusted_frames_dir.join(format!("adjusted_{:04}.gif", i));
            
            let mut frame_args = vec![
                output_path.clone(),
                format!("#{}", i),
                "--delay".to_string(),
                delay_cs.to_string(),
            ];
            frame_args.push("--colors".to_string());
            frame_args.push(colors.to_string());
            frame_args.push("-o".to_string());
            frame_args.push(temp_frame.to_str().unwrap().to_string());
            let frame_output = run_sidecar_with_logging("gifsicle", frame_args)?;
            if frame_output.status.success() && temp_frame.exists() {
                temp_frames.push(temp_frame);
            } else {
                println!("警告: 无法调整第 {} 帧延迟", i);
            }
        }
        if !temp_frames.is_empty() {
            let mut merge_args: Vec<String> = temp_frames.iter().map(|p| p.to_str().unwrap().to_string()).collect();
            merge_args.push("--colors".to_string());
            merge_args.push(colors.to_string());
            merge_args.push("-o".to_string());
            merge_args.push(temp_output.to_str().unwrap().to_string());
            let merge_output = run_sidecar_with_logging("gifsicle", merge_args)?;
            if merge_output.status.success() && temp_output.exists() {
                fs::copy(&temp_output, &output_path).map_err(|e| format!("复制文件失败: {}", e))?;
                println!("延迟调整完成");
            } else {
                println!("警告: 延迟调整失败，使用 gifski 的默认延迟");
            }
        }
    }
    
    // 清理临时目录
    let _ = fs::remove_dir_all(&temp_dir);
    
    // 获取文件大小对比
    let original_size = fs::metadata(&input_path)
        .map(|m| m.len())
        .unwrap_or(0);
    let new_size = fs::metadata(&output_path)
        .map(|m| m.len())
        .unwrap_or(0);
    
    let compression_ratio = if original_size > 0 {
        ((1.0 - new_size as f64 / original_size as f64) * 100.0) as i32
    } else {
        0
    };
    
    // 发送完成事件
    println!("[TEMP_DEBUG] Emitting complete event");
    if let Err(e) = app.emit_all("dedup-progress", DedupProgress {
        stage: "complete".to_string(),
        message: format!("成功创建: {}", output_path),
        current: None,
        total: None,
        details: Some(format!(
            "原始大小: {:.1}KB, 新文件大小: {:.1}KB, 压缩率: {}%",
            original_size as f64 / 1024.0,
            new_size as f64 / 1024.0,
            compression_ratio
        )),
    }) {
        println!("[TEMP_DEBUG] Failed to emit complete event: {}", e);
    }
    
    Ok(output_path)
}

// 后台解压全尺寸帧的进度事件
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExtractProgress {
    stage: String,  // "fullframes" or "previews"
    current: usize,
    total: usize,
}

// 后台解压全尺寸帧（每次解压 100 帧）
#[tauri::command]
fn extract_fullframes_background(
    app: tauri::AppHandle,
    work_dir: String,
    gif_path: String,
    batch_size: Option<usize>,
) -> Result<String, String> {
    let app_clone = app.clone();
    let batch = batch_size.unwrap_or(100);
    
    // 在后台线程中执行
    let handle = std::thread::spawn(move || {
        let result = extract_fullframes_worker(
            app_clone.clone(),
            work_dir,
            gif_path,
            batch,
        );
        
        match result {
            Ok(_) => {
                println!("[TEMP_DEBUG] Fullframes extraction completed");
            }
            Err(err) => {
                println!("[TEMP_DEBUG] Fullframes extraction failed: {}", err);
            }
        }
    });
    {
        let mut h = FULLFRAMES_HANDLE.lock().unwrap();
        *h = Some(handle);
    }
    
    Ok("后台解压全尺寸帧已启动".to_string())
}

fn extract_fullframes_worker(
    app: tauri::AppHandle,
    work_dir: String,
    gif_path: String,
    batch_size: usize,
) -> Result<(), String> {
    // 重置暂停/取消状态
    {
        let mut paused = EXTRACT_PAUSED.lock().map_err(|e| format!("获取暂停状态失败: {}", e))?;
        *paused = false;
    }
    {
        let mut cancelled = EXTRACT_CANCELLED.lock().map_err(|e| format!("获取取消状态失败: {}", e))?;
        *cancelled = false;
    }
    
    let wd = PathBuf::from(&work_dir);
    let base_name = std::path::Path::new(&gif_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("gif")
        .to_string();
    let mut safe_base = String::new();
    for c in base_name.chars() {
        if c.is_ascii_alphanumeric() {
            safe_base.push(c);
        } else {
            safe_base.push('_');
            safe_base.push_str(&(c as u32).to_string());
        }
    }
    
    let temp_color_path = wd.join(format!("_{}_temp_color_restored.gif", safe_base));
    let temp_unopt_path = wd.join(format!("_{}_temp_unoptimized.gif", safe_base));
    let fullframes_dir = wd.join(format!("_{}_fullframes", safe_base));
    
    // 如果 temp_color_restored 不存在，直接返回
    if !temp_color_path.exists() {
        return Err("temp_color_restored.gif 不存在".to_string());
    }
    
    // 创建 fullframes 目录
    if !fullframes_dir.exists() {
        fs::create_dir_all(&fullframes_dir).map_err(|e| format!("创建 fullframes 目录失败: {}", e))?;
    }
    
    // 获取总帧数
    let info_output = run_sidecar_with_logging("gifsicle", vec!["--info".to_string(), temp_color_path.to_str().unwrap().to_string()])?;
    if !info_output.status.success() {
        return Err(format!("gifsicle 获取信息失败: {}", info_output.stderr.as_str()));
    }
    
    let mut total_frames = 0;
    for line in info_output.stdout.as_str().lines() {
        if line.contains("images") {
            if let Some(num_str) = line.split_whitespace()
                .find(|s| s.parse::<usize>().is_ok())
            {
                total_frames = num_str.parse().unwrap_or(0);
            }
        }
    }
    
    if total_frames == 0 {
        return Err("无法获取总帧数".to_string());
    }
    
    // unoptimized 文件应该在 parse_gif_preview 中已经生成
    if !temp_unopt_path.exists() {
        return Err("temp_unoptimized.gif 不存在，请先调用 parse_gif_preview".to_string());
    }
    
    // 检查是否已经全部解压完成（统一使用不填充0的格式）
    let mut existing_count = 0;
    for frame_idx in 0..total_frames {
        let frame_path = fullframes_dir.join(format!("frame.{}", frame_idx));
        if frame_path.exists() {
            existing_count += 1;
        }
    }
    
    if existing_count == total_frames {
        println!("[TEMP_DEBUG] [extract_fullframes_worker] 所有帧已存在 ({} / {})，跳过解压", existing_count, total_frames);
        // 发送完成事件
        let _ = app.emit_all("extract-progress", ExtractProgress {
            stage: "fullframes".to_string(),
            current: total_frames,
            total: total_frames,
        });
        return Ok(());
    } else if existing_count > 0 {
        println!("[TEMP_DEBUG] [extract_fullframes_worker] 部分帧已存在 ({} / {})，继续解压", existing_count, total_frames);
    }
    
    // 分批 explode，每次处理 100 帧
    let mut current = 0;
    while current < total_frames {
        // 检查是否已取消
        {
            let cancelled = EXTRACT_CANCELLED.lock().unwrap();
            if *cancelled {
                println!("[TEMP_DEBUG] [extract_fullframes_worker] 收到取消信号，提前结束");
                return Ok(());
            }
        }
        // 检查暂停状态
        loop {
            let paused = EXTRACT_PAUSED.lock().unwrap();
            if !*paused {
                break;
            }
            drop(paused);
            // 暂停期间也检查取消
            {
                let cancelled = EXTRACT_CANCELLED.lock().unwrap();
                if *cancelled {
                    println!("[TEMP_DEBUG] [extract_fullframes_worker] 暂停期间收到取消信号，提前结束");
                    return Ok(());
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        
        let end = std::cmp::min(current + batch_size - 1, total_frames - 1);
        
        // 检查这批帧是否都已存在（统一使用不填充0的格式）
        let mut all_exist = true;
        for frame_idx in current..=end {
            let output_file = fullframes_dir.join(format!("frame.{}", frame_idx));
            if !output_file.exists() {
                all_exist = false;
                break;
            }
        }
        
        if all_exist {
            current = end + 1;
            continue;
        }
        
        // 构建帧范围选择器
        let frame_range = if current == end {
            format!("#{}", current)
        } else {
            format!("#{}-{}", current, end)
        };
        
        // 为这批帧创建临时输出前缀
        let batch_prefix = fullframes_dir.join("frame");
        
        let args: Vec<String> = vec![
            "--explode".to_string(),
            temp_unopt_path.to_str().unwrap().to_string(),
            frame_range,
            "-o".to_string(),
            batch_prefix.to_str().unwrap().to_string(),
        ];
        
        let output = run_sidecar_with_logging("gifsicle", args)?;
        if !output.status.success() {
            return Err(format!("gifsicle explode 批次 {}-{} 失败: {}", current, end, output.stderr.as_str()));
        }
        
        // gifsicle --explode 会生成带填充0的文件名（如 frame.0000, frame.0100）
        // 需要重命名为不填充0的格式（如 frame.0, frame.100）
        let mut missing_count = 0;
        for frame_idx in current..=end {
            let target_file = fullframes_dir.join(format!("frame.{}", frame_idx));
            
            // 如果目标文件已存在，跳过
            if target_file.exists() {
                continue;
            }
            
            // 尝试找到 gifsicle 生成的带填充0的文件并重命名
            let possible_sources = [
                fullframes_dir.join(format!("frame.{:04}", frame_idx)),
                fullframes_dir.join(format!("frame.{:03}", frame_idx)),
            ];
            
            let mut renamed = false;
            for source_file in &possible_sources {
                if source_file.exists() {
                    if let Err(e) = fs::rename(source_file, &target_file) {
                        println!("[TEMP_DEBUG] 警告: 重命名失败 {:?} -> {:?}: {}", source_file, target_file, e);
                    } else {
                        renamed = true;
                        break;
                    }
                }
            }
            
            if !renamed && !target_file.exists() {
                missing_count += 1;
                if missing_count <= 3 {
                    println!("[TEMP_DEBUG] 警告: 预期文件不存在且无法重命名: frame.{}", frame_idx);
                }
            }
        }
        if missing_count > 0 {
            println!("[TEMP_DEBUG] 批次 {}-{} 有 {} 个文件未生成", current, end, missing_count);
        }
        
        current = end + 1;
        
        // 发送进度事件（在批次完成后发送）
        let _ = app.emit_all("extract-progress", ExtractProgress {
            stage: "fullframes".to_string(),
            current: current,
            total: total_frames,
        });
        
        // 稍作延时，避免占用过多 CPU
        std::thread::sleep(Duration::from_millis(100));
    }
    
    // 发送完成事件
    let _ = app.emit_all("extract-progress", ExtractProgress {
        stage: "fullframes".to_string(),
        current: total_frames,
        total: total_frames,
    });
    
    Ok(())
}

// 后台解压预览缩略图（每次解压 100 帧）
#[tauri::command]
fn extract_previews_background(
    app: tauri::AppHandle,
    work_dir: String,
    gif_path: String,
    max_preview: Option<u32>,
    batch_size: Option<usize>,
) -> Result<String, String> {
    let app_clone = app.clone();
    let mps = max_preview.unwrap_or(120);
    let batch = batch_size.unwrap_or(100);
    
    // 在后台线程中执行
    let handle = std::thread::spawn(move || {
        let result = extract_previews_worker(
            app_clone.clone(),
            work_dir,
            gif_path,
            mps,
            batch,
        );
        
        match result {
            Ok(_) => {
                println!("[TEMP_DEBUG] Previews extraction completed");
            }
            Err(err) => {
                println!("[TEMP_DEBUG] Previews extraction failed: {}", err);
            }
        }
    });
    {
        let mut h = PREVIEWS_HANDLE.lock().unwrap();
        *h = Some(handle);
    }
    
    Ok("后台解压预览缩略图已启动".to_string())
}

fn extract_previews_worker(
    app: tauri::AppHandle,
    work_dir: String,
    gif_path: String,
    max_preview: u32,
    batch_size: usize,
) -> Result<(), String> {
    // 重置暂停/取消状态
    {
        let mut paused = EXTRACT_PAUSED.lock().map_err(|e| format!("获取暂停状态失败: {}", e))?;
        *paused = false;
    }
    {
        let mut cancelled = EXTRACT_CANCELLED.lock().map_err(|e| format!("获取取消状态失败: {}", e))?;
        *cancelled = false;
    }
    
    let wd = PathBuf::from(&work_dir);
    let base_name = std::path::Path::new(&gif_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("gif")
        .to_string();
    let mut safe_base = String::new();
    for c in base_name.chars() {
        if c.is_ascii_alphanumeric() {
            safe_base.push(c);
        } else {
            safe_base.push('_');
            safe_base.push_str(&(c as u32).to_string());
        }
    }
    
    let temp_color_path = wd.join(format!("_{}_temp_color_restored.gif", safe_base));
    let temp_unopt_path = wd.join(format!("_{}_temp_unoptimized.gif", safe_base));
    let previews_dir = wd.join(format!("_{}_previews", safe_base));
    
    // 如果 temp_color_restored 不存在，直接返回
    if !temp_color_path.exists() {
        return Err("temp_color_restored.gif 不存在".to_string());
    }
    
    // 创建 previews 目录
    if !previews_dir.exists() {
        fs::create_dir_all(&previews_dir).map_err(|e| format!("创建 previews 目录失败: {}", e))?;
    }
    
    // 获取总帧数
    let info_output = run_sidecar_with_logging("gifsicle", vec!["--info".to_string(), temp_color_path.to_str().unwrap().to_string()])?;
    if !info_output.status.success() {
        return Err(format!("gifsicle 获取信息失败: {}", info_output.stderr.as_str()));
    }
    
    let mut total_frames = 0;
    for line in info_output.stdout.as_str().lines() {
        if line.contains("images") {
            if let Some(num_str) = line.split_whitespace()
                .find(|s| s.parse::<usize>().is_ok())
            {
                total_frames = num_str.parse().unwrap_or(0);
            }
        }
    }
    
    if total_frames == 0 {
        return Err("无法获取总帧数".to_string());
    }
    
    // unoptimized 文件应该在 parse_gif_preview 中已经生成
    if !temp_unopt_path.exists() {
        return Err("temp_unoptimized.gif 不存在，请先调用 parse_gif_preview".to_string());
    }
    
    // 检查是否已经全部解压完成（统一使用不填充0的格式）
    let mut existing_count = 0;
    for frame_idx in 0..total_frames {
        let preview_path = previews_dir.join(format!("preview.{}", frame_idx));
        if preview_path.exists() {
            existing_count += 1;
        }
    }
    
    if existing_count == total_frames {
        println!("[TEMP_DEBUG] [extract_previews_worker] 所有预览帧已存在 ({} / {})，跳过解压", existing_count, total_frames);
        // 发送完成事件
        let _ = app.emit_all("extract-progress", ExtractProgress {
            stage: "previews".to_string(),
            current: total_frames,
            total: total_frames,
        });
        return Ok(());
    } else if existing_count > 0 {
        println!("[TEMP_DEBUG] [extract_previews_worker] 部分预览帧已存在 ({} / {})，继续解压", existing_count, total_frames);
    }
    
    // 分批 explode + resize，每次处理 100 帧
    let mut current = 0;
    while current < total_frames {
        // 检查是否已取消
        {
            let cancelled = EXTRACT_CANCELLED.lock().unwrap();
            if *cancelled {
                println!("[TEMP_DEBUG] [extract_previews_worker] 收到取消信号，提前结束");
                return Ok(());
            }
        }
        // 检查暂停状态
        loop {
            let paused = EXTRACT_PAUSED.lock().unwrap();
            if !*paused {
                break;
            }
            drop(paused);
            // 暂停期间也检查取消
            {
                let cancelled = EXTRACT_CANCELLED.lock().unwrap();
                if *cancelled {
                    println!("[TEMP_DEBUG] [extract_previews_worker] 暂停期间收到取消信号，提前结束");
                    return Ok(());
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        
        let end = std::cmp::min(current + batch_size - 1, total_frames - 1);
        
        // 检查这批帧是否都已存在（统一使用不填充0的格式）
        let mut all_exist = true;
        for frame_idx in current..=end {
            let output_file = previews_dir.join(format!("preview.{}", frame_idx));
            if !output_file.exists() {
                all_exist = false;
                break;
            }
        }
        
        if all_exist {
            current = end + 1;
            continue;
        }
        
        // 构建帧范围选择器
        let frame_range = if current == end {
            format!("#{}", current)
        } else {
            format!("#{}-{}", current, end)
        };
        
        // 为这批帧创建临时输出前缀
        let batch_prefix = previews_dir.join("preview");
        
        let args: Vec<String> = vec![
            "--explode".to_string(),
            "--resize".to_string(),
            format!("{}x{}", max_preview, max_preview),
            "--resize-method".to_string(),
            "mix".to_string(),
            temp_unopt_path.to_str().unwrap().to_string(),
            frame_range,
            "-o".to_string(),
            batch_prefix.to_str().unwrap().to_string(),
        ];
        
        let output = run_sidecar_with_logging("gifsicle", args)?;
        if !output.status.success() {
            return Err(format!("gifsicle explode 预览批次 {}-{} 失败: {}", current, end, output.stderr.as_str()));
        }
        
        // gifsicle --explode 会生成带填充0的文件名（如 preview.0000, preview.0100）
        // 需要重命名为不填充0的格式（如 preview.0, preview.100）
        let mut missing_count = 0;
        for frame_idx in current..=end {
            let target_file = previews_dir.join(format!("preview.{}", frame_idx));
            
            // 如果目标文件已存在，跳过
            if target_file.exists() {
                continue;
            }
            
            // 尝试找到 gifsicle 生成的带填充0的文件并重命名
            let possible_sources = [
                previews_dir.join(format!("preview.{:04}", frame_idx)),
                previews_dir.join(format!("preview.{:03}", frame_idx)),
            ];
            
            let mut renamed = false;
            for source_file in &possible_sources {
                if source_file.exists() {
                    if let Err(e) = fs::rename(source_file, &target_file) {
                        println!("[TEMP_DEBUG] 警告: 重命名失败 {:?} -> {:?}: {}", source_file, target_file, e);
                    } else {
                        renamed = true;
                        break;
                    }
                }
            }
            
            if !renamed && !target_file.exists() {
                missing_count += 1;
                if missing_count <= 3 {
                    println!("[TEMP_DEBUG] 警告: 预期预览文件不存在且无法重命名: preview.{}", frame_idx);
                }
            }
        }
        if missing_count > 0 {
            println!("[TEMP_DEBUG] 预览批次 {}-{} 有 {} 个文件未生成", current, end, missing_count);
        }
        
        current = end + 1;
        
        // 发送进度事件（在批次完成后发送）
        let _ = app.emit_all("extract-progress", ExtractProgress {
            stage: "previews".to_string(),
            current: current,
            total: total_frames,
        });
        
        // 稍作延时，避免占用过多 CPU
        std::thread::sleep(Duration::from_millis(100));
    }
    
    // 发送完成事件
    let _ = app.emit_all("extract-progress", ExtractProgress {
        stage: "previews".to_string(),
        current: total_frames,
        total: total_frames,
    });
    
    Ok(())
}

// 暂停解压
#[tauri::command]
fn pause_extraction() -> Result<(), String> {
    let mut paused = EXTRACT_PAUSED.lock().map_err(|e| format!("获取暂停状态失败: {}", e))?;
    *paused = true;
    println!("[TEMP_DEBUG] 解压已暂停");
    Ok(())
}

// 继续解压
#[tauri::command]
fn resume_extraction() -> Result<(), String> {
    let mut paused = EXTRACT_PAUSED.lock().map_err(|e| format!("获取暂停状态失败: {}", e))?;
    *paused = false;
    println!("[TEMP_DEBUG] 解压已继续");
    Ok(())
}

// 取消并彻底停止后台解压线程：设置取消标志并 join 线程
#[tauri::command]
fn cancel_extraction() -> Result<(), String> {
    {
        let mut cancelled = EXTRACT_CANCELLED.lock().map_err(|e| format!("设置取消状态失败: {}", e))?;
        *cancelled = true;
    }
    println!("[TEMP_DEBUG] 解压已取消，开始等待线程结束");
    // 尝试 join 全尺寸线程
    {
        let mut h = FULLFRAMES_HANDLE.lock().map_err(|e| format!("获取线程句柄失败: {}", e))?;
        if let Some(handle) = h.take() {
            let _ = handle.join();
            println!("[TEMP_DEBUG] 全尺寸解压线程已结束");
        }
    }
    // 尝试 join 预览线程
    {
        let mut h = PREVIEWS_HANDLE.lock().map_err(|e| format!("获取线程句柄失败: {}", e))?;
        if let Some(handle) = h.take() {
            let _ = handle.join();
            println!("[TEMP_DEBUG] 预览解压线程已结束");
        }
    }
    Ok(())
}

// 降低 GIF 帧率（抽帧）：只对低于阈值的快帧进行抽帧，慢帧保留
#[tauri::command]
fn reduce_gif_fps(
    input_path: String,
    output_path: String,
    keep_interval: usize,     // 每 N 帧保留 1 帧（仅对快帧生效）
    delay_threshold: u16,     // 时延阈值（ms），只抽取低于此值的快帧
    max_delay: u16,           // 最大时延限制（ms）
    frame_delays: Vec<u16>,   // 原始每帧延迟（毫秒）
) -> Result<String, String> {
    if keep_interval < 2 {
        return Err("抽帧间隔必须至少为 2".to_string());
    }
    
    let total_frames = frame_delays.len();
    if total_frames == 0 {
        return Err("帧数为 0".to_string());
    }
    
    // 计算保留的帧索引和新的延迟
    let mut keep_frames: Vec<usize> = Vec::new();
    let mut new_delays: Vec<u16> = Vec::new();
    
    let mut i = 0;
    while i < total_frames {
        let current_delay = frame_delays[i];
        
        // 如果当前帧延迟 >= 阈值，直接保留，不参与抽帧
        if current_delay >= delay_threshold {
            keep_frames.push(i);
            new_delays.push(std::cmp::min(current_delay, max_delay));
            i += 1;
            continue;
        }
        
        // 当前帧延迟 < 阈值，参与抽帧逻辑
        keep_frames.push(i);
        
        // 累加连续快帧的延迟
        let mut accumulated_delay: u32 = current_delay as u32;
        let mut fast_frame_count = 1usize;
        
        // 向后查看是否有连续的快帧需要合并
        for j in 1..keep_interval {
            if i + j >= total_frames {
                break;
            }
            let next_delay = frame_delays[i + j];
            if next_delay < delay_threshold {
                accumulated_delay += next_delay as u32;
                fast_frame_count += 1;
            } else {
                // 遇到慢帧，停止合并
                break;
            }
        }
        
        // 应用最大延迟限制
        let final_delay = std::cmp::min(accumulated_delay, max_delay as u32) as u16;
        new_delays.push(final_delay);
        
        i += fast_frame_count;
    }
    
    println!("[TEMP_DEBUG] Reducing FPS: {} -> {} frames (keep interval: {}, threshold: {}ms, max: {}ms)", 
             total_frames, keep_frames.len(), keep_interval, delay_threshold, max_delay);
    
    // 构建 gifsicle 参数
    // 先选择要保留的帧，然后设置延迟
    let mut args: Vec<String> = vec![input_path.clone()];
    
    // 忽略警告
    args.push("--no-warnings".to_string());
    
    // 选择保留的帧
    let frame_selection: Vec<String> = keep_frames.iter().map(|&f| format!("#{}", f)).collect();
    args.extend(frame_selection);
    
    // 输出到临时文件
    let temp_output = format!("{}.temp", output_path);
    args.push("-o".to_string());
    args.push(temp_output.clone());
    
    // 第一步：选择帧
    let output1 = run_sidecar_with_logging("gifsicle", args)?;
    if !output1.status.success() {
        return Err(format!("gifsicle 选择帧失败: {}", output1.stderr.as_str()));
    }
    
    // 第二步：设置新的延迟
    let mut delay_args: Vec<String> = vec![temp_output.clone()];
    delay_args.push("--no-warnings".to_string());
    
    for (idx, &delay_ms) in new_delays.iter().enumerate() {
        let delay_cs = delay_ms / 10; // 转换为百分之一秒
        delay_args.push("--delay".to_string());
        delay_args.push(format!("{}", delay_cs));
        delay_args.push(format!("#{}", idx));
    }
    
    delay_args.push("-o".to_string());
    delay_args.push(output_path.clone());
    
    let output2 = run_sidecar_with_logging("gifsicle", delay_args)?;
    if !output2.status.success() {
        // 清理临时文件
        let _ = fs::remove_file(&temp_output);
        return Err(format!("gifsicle 设置延迟失败: {}", output2.stderr.as_str()));
    }
    
    // 清理临时文件
    let _ = fs::remove_file(&temp_output);
    
    println!("[TEMP_DEBUG] FPS reduction complete: {}", output_path);
    Ok(output_path)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            init_work_dir,
            cleanup_work_dir,
            get_file_size,
            read_file_in_chunks,
            read_file_to_workdir,
            parse_gif_preview,
            extract_gif_frames_full,
            get_gif_frame_data,
            get_preview_frame_data,
            extract_frame_gif,
            copy_to_workdir,
            write_binary_file,
            path_exists,
            read_dir_filenames,
            get_gif_stats,
            modify_gif_delays,
            save_gif_slice,
            delete_gif_frames,
            save_file,
            write_file_to_path,
            copy_dir_recursive,
            read_text_file,
            read_file_bytes,
            read_temp_file,
            test_gifski_version,
            dedup_gif,
            resize_gif,
            extract_fullframes_background,
            extract_previews_background,
            pause_extraction,
            resume_extraction,
            cancel_extraction,
            reduce_gif_fps
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// 提取 GIF 元数据并提取帧到磁盘（用于滑动窗口加载）
#[tauri::command]
async fn extract_gif_frames_full(
    app: tauri::AppHandle,
    gif_path: String,
    work_dir: String,
    cached_delays: Option<Vec<u16>>, // 可选：前端提供的延迟缓存
    reuse_frames_dir: Option<String>,
) -> Result<GifPreviewResult, String> {
    let app2 = app.clone();
    let path = gif_path.clone();
    let wd = work_dir.clone();
    
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<GifPreviewResult, String> {
        let file = std::fs::File::open(&path).map_err(|e| format!("打开文件失败: {}", e))?;
        let mut opts = DecodeOptions::new();
        opts.set_color_output(gif::ColorOutput::RGBA);
        let reader = opts.read_info(file).map_err(|e| format!("读取 GIF 信息失败: {}", e))?;
        let width = reader.width() as u32;
        let height = reader.height() as u32;

        let base_name = std::path::Path::new(&path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("gif")
            .to_string();
        let mut safe_base = String::new();
        for c in base_name.chars() {
            if c.is_ascii_alphanumeric() {
                safe_base.push(c);
            } else {
                safe_base.push('_');
                safe_base.push_str(&(c as u32).to_string());
            }
        }
        // 如果提供了复用目录，优先使用该目录；否则使用默认目录
        let default_frames_dir = PathBuf::from(&wd).join(format!("_{}_fullframes", safe_base));
        let mut frames_dir = if let Some(reuse_dir_str) = reuse_frames_dir.clone() { PathBuf::from(reuse_dir_str) } else { default_frames_dir.clone() };
        let mut prefix = frames_dir.join("frame");
        let temp_color_path = PathBuf::from(&wd).join(format!("_{}_temp_color_restored.gif", safe_base));

        // 获取延迟信息：优先使用缓存
        let mut delays_ms: Vec<u16> = Vec::new();
        if let Some(cached) = cached_delays.clone() {
            delays_ms = cached;
        } else {
            let info_output = run_sidecar_with_logging("gifsicle", vec!["--info".to_string(), path.clone()])?;
            if !info_output.status.success() {
                return Err(format!("gifsicle 获取信息失败: {}", info_output.stderr.as_str()));
            }
            for line in info_output.stdout.as_str().lines() {
                if line.contains("delay") && line.contains("s") {
                    if let Some(delay_part) = line.split("delay").nth(1) {
                        if let Some(delay_str) = delay_part.trim().split('s').next() {
                            if let Ok(delay) = delay_str.parse::<f64>() {
                                let ms = (delay * 1000.0).round() as u16;
                                delays_ms.push(ms);
                            }
                        }
                    }
                }
            }
        }

        // 决定是否需要重新提取：当且仅当帧目录存在且包含帧文件，且临时颜色还原文件存在时，才复用
        let mut has_frames = false;
        if frames_dir.exists() {
            if let Ok(entries) = fs::read_dir(&frames_dir) {
                for entry in entries.flatten() {
                    if let Some(name) = entry.file_name().to_str() {
                        if name.starts_with("frame.") { has_frames = true; break; }
                    }
                }
            }
        }
        let temp_exists = temp_color_path.exists();
        let mut need_extract = !(has_frames && temp_exists);
        // 如果前端提供了复用目录但不可复用，回退到默认目录并重新判断
        if need_extract && reuse_frames_dir.is_some() {
            frames_dir = default_frames_dir.clone();
            prefix = frames_dir.join("frame");
            has_frames = false;
            if frames_dir.exists() {
                if let Ok(entries) = fs::read_dir(&frames_dir) {
                    for entry in entries.flatten() {
                        if let Some(name) = entry.file_name().to_str() {
                            if name.starts_with("frame.") { has_frames = true; break; }
                        }
                    }
                }
            }
            need_extract = !(has_frames && temp_exists);
        }
        if need_extract {
            if !frames_dir.exists() {
                fs::create_dir_all(&frames_dir).map_err(|e| format!("创建帧目录失败: {}", e))?;
            } else {
                if let Ok(entries) = fs::read_dir(&frames_dir) {
                    for entry in entries.flatten() {
                        let p = entry.path();
                        if p.is_file() { let _ = fs::remove_file(p); }
                    }
                }
            }
            let color_args: Vec<String> = vec![
                "--colors=255".to_string(),
                path.clone(),
                "-o".to_string(),
                temp_color_path.to_str().unwrap().to_string(),
            ];
            let color_output = run_sidecar_with_logging("gifsicle", color_args)?;
            if !color_output.status.success() {
                return Err(format!("gifsicle 还原颜色失败: {}", color_output.stderr.as_str()));
            }
            let explode_args: Vec<String> = vec![
                "--unoptimize".to_string(),
                "--explode".to_string(),
                temp_color_path.to_str().unwrap().to_string(),
                "-o".to_string(),
                prefix.to_str().unwrap().to_string(),
            ];
            let explode_output = run_sidecar_with_logging("gifsicle", explode_args)?;
            if !explode_output.status.success() {
                return Err(format!("gifsicle 提取帧失败: {}", explode_output.stderr.as_str()));
            }
        }

        // 读取提取的帧文件
        let mut gif_files: Vec<PathBuf> = fs::read_dir(&frames_dir)
            .map_err(|e| format!("读取帧目录失败: {}", e))?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_file())
            .filter(|p| {
                if let Some(n) = p.file_name().and_then(|s| s.to_str()) {
                    n.starts_with("frame.")
                } else { false }
            })
            .collect();
        gif_files.sort_by_key(|p| {
            p.file_name()
                .and_then(|s| s.to_str())
                .and_then(|n| n.strip_prefix("frame."))
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(usize::MAX)
        });
        
        let frame_files: Vec<String> = gif_files.iter().map(|p| p.to_str().unwrap().to_string()).collect();
        let frame_count = frame_files.len();
        
        for (i, _) in frame_files.iter().enumerate() {
            if i % 100 == 0 || i == frame_count - 1 {
                let _ = app2.emit_all("gif-parse-progress", ParseProgress { 
                    stage: "extract".to_string(), 
                    current: i, 
                    total: frame_count 
                });
            }
        }
        
        let res = GifPreviewResult {
            width,
            height,
            frame_count,
            delays_ms,
            preview_dir: frames_dir.to_str().unwrap().to_string(),
            preview_files: frame_files,
            preview_width: width,  // 全尺寸帧，预览宽度等于原始宽度
            preview_height: height, // 全尺寸帧，预览高度等于原始高度
        };
        Ok(res)
    })
    .await
    .map_err(|e| format!("后台线程失败: {}", e))??;
    
    Ok(result)
}

// 获取单个 GIF 帧的像素数据（从已提取的帧文件读取）
#[tauri::command]
async fn get_gif_frame_data(
    work_dir: String,
    frame_index: usize,
    frames_dir: Option<String>,
) -> Result<Vec<u8>, String> {
    let wd = work_dir.clone();
    
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        // let t_total = std::time::Instant::now();
        let default_dir = PathBuf::from(&wd).join("fullframes");
        let frames_dir = if let Some(fd) = frames_dir.clone() { PathBuf::from(fd) } else { default_dir };
        // 统一使用不填充0的格式
        let mut frame_path = frames_dir.join(format!("frame.{}", frame_index));
        
        if !frame_path.exists() {
            // 如果还是不存在，尝试读取目录中的所有 frame.* 文件，按文件名排序后取对应索引
            let mut gif_files: Vec<PathBuf> = fs::read_dir(&frames_dir)
                .map_err(|e| format!("读取帧目录失败: {}", e))?
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_file())
                .filter(|p| {
                    if let Some(n) = p.file_name().and_then(|s| s.to_str()) {
                        n.starts_with("frame.")
                    } else { false }
                })
                .collect();
            gif_files.sort_by_key(|p| {
                p.file_name()
                    .and_then(|s| s.to_str())
                    .and_then(|n| n.strip_prefix("frame."))
                    .and_then(|s| s.parse::<usize>().ok())
                    .unwrap_or(usize::MAX)
            });
            
            if frame_index < gif_files.len() {
                frame_path = gif_files[frame_index].clone();
            } else {
                return Err(format!("帧文件不存在: 索引 {} 超出范围 (共 {} 个文件)", frame_index, gif_files.len()));
            }
        }
        
        if !frame_path.exists() {
            return Err(format!("帧文件不存在: {:?}", frame_path));
        }
        
        // 读取并解码单个 GIF 帧文件
        use image::io::Reader as ImageReader;
        use std::io::BufReader;
        
        // let t_open = std::time::Instant::now();
        let file = std::fs::File::open(&frame_path)
            .map_err(|e| format!("无法打开帧文件 {:?}: {}", frame_path, e))?;
        let reader = BufReader::new(file);
        let img_reader = ImageReader::new(reader)
            .with_guessed_format()
            .map_err(|e| format!("无法读取帧文件 {:?}: {}", frame_path, e))?;
        // let d_open = t_open.elapsed().as_millis();
        
        // let t_decode = std::time::Instant::now();
        let img = img_reader.decode()
            .map_err(|e| format!("无法解码帧文件 {:?}: {}", frame_path, e))?;
        // let d_decode = t_decode.elapsed().as_millis();
        
        // 转换为 RGBA
        // let t_rgba = std::time::Instant::now();
        let rgba = img.to_rgba8();
        // let d_rgba = t_rgba.elapsed().as_millis();
        let raw = rgba.into_raw();
        // let d_total = t_total.elapsed().as_millis();
        // println!(
        //     "[TEMP_DEBUG] 帧解码: idx={}, open={}ms, decode={}ms, rgba={}ms, total={}ms, file={}",
        //     frame_index,
        //     d_open,
        //     d_decode,
        //     d_rgba,
        //     d_total,
        //     frame_path.to_string_lossy()
        // );
        Ok(raw)
    })
    .await
    .map_err(|e| format!("后台线程失败: {}", e))??;
    
    Ok(result)
}

// 获取单个预览帧的像素数据（从已提取的缩略图文件读取）
#[tauri::command]
async fn get_preview_frame_data(
    work_dir: String,
    frame_index: usize,
) -> Result<Vec<u8>, String> {
    let wd = work_dir.clone();
    
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let previews_dir = PathBuf::from(&wd).join("previews");
        
        // 统一使用不填充0的格式
        let preview_path = previews_dir.join(format!("preview.{}", frame_index));
        
        if !preview_path.exists() {
            return Err(format!("预览文件不存在: {:?}", preview_path));
        }
        
        // 读取并解码 GIF 文件
        use image::io::Reader as ImageReader;
        use std::io::BufReader;
        
        let file = std::fs::File::open(&preview_path)
            .map_err(|e| format!("无法打开预览文件 {:?}: {}", preview_path, e))?;
        let reader = BufReader::new(file);
        let img_reader = ImageReader::new(reader)
            .with_guessed_format()
            .map_err(|e| format!("无法读取预览文件 {:?}: {}", preview_path, e))?;
        
        let img = img_reader.decode()
            .map_err(|e| format!("无法解码预览文件 {:?}: {}", preview_path, e))?;
        
        // 转换为 RGBA
        let rgba = img.to_rgba8();
        Ok(rgba.into_raw())
    })
    .await
    .map_err(|e| format!("后台线程失败: {}", e))??;
    
    Ok(result)
}

// GIF 分辨率调整命令（后台线程执行，避免阻塞）
#[tauri::command]
async fn resize_gif(
    input_path: String,
    output_path: String,
    width: u32,
    height: u32,
    method: Option<String>,
    optimize: Option<bool>,
) -> Result<String, String> {
    if width == 0 || height == 0 {
        return Err("宽高必须为正整数".to_string());
    }

    let m = method.unwrap_or_else(|| "mix".to_string());
    let opt = optimize.unwrap_or(true);

    println!("[TEMP_DEBUG] Resizing GIF: {} -> {} ({}x{}, method={}, optimize={})", input_path, output_path, width, height, m, opt);

    let input = input_path.clone();
    let output = output_path.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut args: Vec<String> = Vec::new();
        args.push("--no-warnings".to_string());
        args.push("--resize".to_string());
        args.push(format!("{}x{}", width, height));
        args.push("--resize-method".to_string());
        args.push(m);
        // 画质增强
        args.push("--resize-colors".to_string());
        args.push("256".to_string());
        args.push("--dither".to_string());
        if opt {
            args.push("--optimize=3".to_string());
        }
        args.push(input.clone());
        args.push("-o".to_string());
        args.push(output.clone());

        let out = run_sidecar_with_logging("gifsicle", args)?;
        if !out.status.success() {
            return Err(format!("gifsicle 执行失败: {}", out.stderr.as_str()));
        }

        Ok(output)
    })
    .await
    .map_err(|e| format!("后台线程失败: {}", e))??;

    println!("[TEMP_DEBUG] Resize completed: {}", result);
    Ok(result)
}
// 提取指定帧为单帧 GIF（全尺寸），返回临时文件路径
#[tauri::command]
fn extract_frame_gif(input_path: String, work_dir: String, frame_index: usize) -> Result<String, String> {
    let dir = PathBuf::from(&work_dir).join("full_frames");
    fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {}", e))?;
    let dest = dir.join(format!("frame_{:04}.gif", frame_index));
    let args = vec![
        input_path.clone(),
        format!("#{}", frame_index),
        "--unoptimize".to_string(),
        "-o".to_string(),
        dest.to_str().unwrap().to_string(),
    ];
    let out = run_sidecar_with_logging("gifsicle", args)?;
    if !out.status.success() {
        return Err(format!("gifsicle 执行失败: {}", out.stderr.as_str()));
    }
    Ok(dest.to_str().unwrap().to_string())
}
