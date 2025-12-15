# GifCut

A GIF editor application based on Tauri + React.

## Features

- **GIF Playback Preview**: Supports loading GIF files with full playback control (play/pause, frame jumping).
- **Frame Preview Timeline**: Visualizes every frame, supporting quick positioning and browsing.
- **Playback Speed Adjustment**: Modify frame delay time to adjust the playback speed of the whole GIF or specific segments.
- **Segment Cropping**: Select start and end frames to save the selected range as a new GIF file.
- **Deduplication & Slimming**: Reduce file size by removing duplicate frames and optimizing the color table.
- **Resolution Adjustment**: Supports resizing GIF width and height.
- **Frame Rate Control**: Supports lowering FPS by dropping frames while keeping keyframes.
- **Multi-version Management**: Keep the original file and multiple edited versions in the same session for easy comparison and switching.

## Integrated Tools

This software includes the following excellent open-source command-line tools for processing GIF files:

- **gifsicle** (v1.96): Used for GIF optimization, cropping, resizing, etc.
  - License: **GPL-2.0** (GNU General Public License v2.0)
- **gifski** (v1.34.0): High-quality GIF encoder for generating higher quality GIF files.
  - License: **AGPL-3.0** (GNU Affero General Public License v3.0)

## Installation & Running (macOS)

This software is usually released as a `.dmg` installer or `.app` application.

### 1. Installation
1. Download the latest version of `GifCut_x.x.x_x64.dmg` or `GifCut_x.x.x_aarch64.dmg` (Choose based on your Mac chip type: select aarch64 for M1/M2/M3 series, x64 for Intel chips).
2. Double-click to open the `.dmg` file.
3. Drag the `GifCut.app` icon into the `Applications` folder.

### 2. First Run
Since this application may not have an Apple developer signature, you may encounter a macOS security prompt when running it for the first time:

> "GifCut" cannot be opened because the developer cannot be verified.
> Or prompts that the application is "damaged and cannot be opened".

**Solutions**:

**Method 1 (Recommended):**
1. In Finder, find `GifCut` in the `Applications` folder.
2. **Right-click** (or Control-click) the application icon.
3. Select **"Open"** from the pop-up menu.
4. Click the **"Open"** button in the subsequent dialog box.
   *(This operation only needs to be performed once upon first run)*

**Method 2:**
1. If blocked after attempting to open, please open **System Settings** -> **Privacy & Security**.
2. Scroll down on the right to find the **Security** section.
3. You will see a message stating "GifCut" was blocked from use because it is not from an identified developer. Click **"Open Anyway"**.
4. Click **"Open"** in the confirmation box.

## User Guide

### 1. Load File
After launching the application, click the load button (or use the File menu) to select a local GIF file. By default, the application may load a sample file.

### 2. Browse & Play
- **Timeline**: The timeline at the bottom displays all frames of the GIF. Click any frame to jump to it.
- **Keyboard Control**: Use `←` (Left Arrow) and `→` (Right Arrow) keys to switch frames one by one; hold to speed up browsing.
- **Playback Control**: Use the play/pause button on the interface to control playback status.

### 3. Editing Functions
In the right (or functional) panel, you can use various editing functions through different tabs:

- **Speed**: Adjust frame delay (milliseconds) to change playback rate.
- **Segment**: Set "Start Frame" and "End Frame", click apply to crop the segment and generate a new file.
- **Deduplicate**: Set similarity threshold and quality parameters to remove visually repetitive frames and reduce size.
- **Resize**: Input new width and height, select scaling algorithm to adjust resolution.
- **Frequency**: Set frame drop interval or delay threshold to reduce frame rate.

### 4. Preview & Save
- Edit operations usually generate a new GIF version, listed in the version list.
- Click the "Preview" button to view the actual playback effect of the current version in an independent window.
- After confirmation, the newly generated GIF file is usually saved in the working directory (specific path can be viewed in version information).

## Credits

- **gifsicle** project: [https://github.com/kohler/gifsicle](https://github.com/kohler/gifsicle)
- **gifski** project: [https://github.com/ImageOptim/gifski](https://github.com/ImageOptim/gifski)
- **Flaticon** icons:
<a href="https://www.flaticon.com/free-icons/gif-file" title="gif file icons">Gif file icons created by Grand Iconic - Flaticon</a>
<a href="https://www.flaticon.com/free-icons/format-file" title="format file icons">Format file icons created by Steven Edward Simanjuntak - Flaticon</a>
<a href="https://www.flaticon.com/free-icons/gif" title="gif icons">Gif icons created by Alfredo Hernandez - Flaticon</a>
<a href="https://www.flaticon.com/free-icons/format-file" title="format file icons">Format file icons created by Steven Edward Simanjuntak - Flaticon</a>
<a href="https://www.flaticon.com/free-icons/ui" title="ui icons">Ui icons created by Freepik - Flaticon</a>
