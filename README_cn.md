# GifCut

基于 Tauri + React 的 GIF 编辑器应用。

## 功能特性

- **GIF 播放预览**: 支持加载 GIF 文件，提供完整的播放控制（播放/暂停、帧跳转）。
- **帧预览时间轴**: 可视化展示每一帧，支持快速定位和浏览。
- **播放速度调整**: 可以修改帧延迟时间，调整整体或部分片段的播放速度。
- **片段裁剪**: 支持选择起始和结束帧，将选定范围保存为新的 GIF 文件。
- **去重瘦身**: 通过移除重复帧和优化颜色表来减小文件体积。
- **分辨率调整**: 支持调整 GIF 的宽度和高度。
- **帧率控制**: 支持通过抽帧方式降低 FPS，保留关键帧。
- **多成果管理**: 在工作区保留原始文件和编辑后的多个成果版本，方便对比和切换。

## 集成工具

本软件内置了以下优秀的开源命令行工具来处理 GIF 文件：

- **gifsicle** (v1.96): 用于 GIF 的优化、裁剪、调整大小等操作。
  - 协议: **GPL-2.0** (GNU General Public License v2.0)
- **gifski** (v1.34.0): 高质量 GIF 编码器，用于生成更高质量的 GIF 文件。
  - 协议: **AGPL-3.0** (GNU Affero General Public License v3.0)

## 安装与运行 (macOS)

本软件通常以 `.dmg` 安装包或 `.app` 应用程序的形式发布。

### 1. 安装
1. 下载最新版本的 `GifCut_x.x.x_x64.dmg` 或 `GifCut_x.x.x_aarch64.dmg`（根据您的 Mac 芯片类型选择，M1/M2/M3 系列请选 aarch64，Intel 芯片请选 x64）。
2. 双击打开 `.dmg` 文件。
3. 将 `GifCut.app` 图标拖入 `Applications`（应用程序）文件夹中。

### 2. 首次运行
由于本应用可能未进行 Apple 开发者签名，首次运行时可能会遇到 macOS 的安全提示：

> "GifCut" 无法打开，因为无法验证开发者。
> 或者提示应用“已损坏，无法打开”。

**解决方法**：

**方法一（推荐）：**
1. 在 Finder（访达）中，找到 `应用程序` 文件夹中的 `GifCut`。
2. **右键点击**（或按住 Control 键点击）应用图标。
3. 在弹出的菜单中选择 **“打开”**。
4. 在随后的弹窗中点击 **“打开”** 按钮即可。
   *(此操作仅需在首次运行时执行一次)*

**方法二：**
1. 如果尝试打开后被拦截，请打开 **系统设置** -> **隐私与安全性**。
2. 在右侧滚动找到 **安全性** 部分。
3. 您会看到一条消息提示 "GifCut" 被阻止打开，点击 **“仍要打开”**。
4. 在弹出的确认框中点击 **“打开”**。

运行下面的命令：

```bash
sudo xattr -d com.apple.quarantine /Applications/GifCut.app
```

## 使用说明

### 1. 加载文件
启动应用后，点击加载按钮（或使用文件菜单）选择本地 GIF 文件。默认情况下，应用可能会加载示例文件。

### 2. 浏览与播放
- **时间轴**: 底部的时间轴显示了 GIF 的所有帧，点击任意帧即可跳转。
- **键盘控制**: 使用键盘 `←` (左箭头) 和 `→` (右箭头) 键可以逐帧切换；长按可加速浏览。
- **播放控制**: 使用界面上的播放/暂停按钮控制播放状态。

### 3. 编辑功能
在右侧（或功能区）面板中，可以通过不同的标签页使用各项编辑功能：

- **速度**: 调整帧的延迟时间（毫秒），改变播放速率。
- **分段**: 设定“开始帧”和“结束帧”，点击应用后将截取该片段生成新文件。
- **去重**: 设置相似度阈值和质量参数，去除视觉上重复的帧以减小体积。
- **尺寸**: 输入新的宽度和高度，选择缩放算法进行分辨率调整。
- **频率**: 设置抽帧间隔或时延阈值，降低帧率。

### 4. 预览与保存
- 编辑操作通常会生成一个新的 GIF 版本，列在版本列表中。
- 点击“预览”按钮可以在独立窗口中查看当前版本的实际播放效果。
- 确认无误后，新生成的 GIF 文件通常保存在工作目录中（具体路径可在版本信息中查看）。


## 感谢

- **gifsicle** 项目：[https://github.com/kohler/gifsicle](https://github.com/kohler/gifsicle)
- **gifski** 项目：[https://github.com/ImageOptim/gifski](https://github.com/ImageOptim/gifski)
- **Flaticon** 图标：
<a href="https://www.flaticon.com/free-icons/gif-file" title="gif file icons">Gif file icons created by Grand Iconic - Flaticon</a>
<a href="https://www.flaticon.com/free-icons/format-file" title="format file icons">Format file icons created by Steven Edward Simanjuntak - Flaticon</a>
<a href="https://www.flaticon.com/free-icons/gif" title="gif icons">Gif icons created by Alfredo Hernandez - Flaticon</a>
<a href="https://www.flaticon.com/free-icons/format-file" title="format file icons">Format file icons created by Steven Edward Simanjuntak - Flaticon</a>
<a href="https://www.flaticon.com/free-icons/ui" title="ui icons">Ui icons created by Freepik - Flaticon</a>