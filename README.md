# Video Thumbnail Picker

A browser-based tool for extracting multiple thumbnails from a video and downloading them as a ZIP file.

This app is built with React + Vite and runs fully client-side. You can drag and drop a video, choose how many thumbnails to generate, preview them in a grid, and download all frames in one archive.

## Features

- Drag-and-drop or file picker video upload
- Adjustable thumbnail count (slider)
- Adjustable quality percentage (40% to 100%)
- Extraction mode selector (Canvas or FFmpeg)
- Thumbnail preview grid with per-image download
- ZIP download of all generated thumbnails
- Fully client-side processing (no backend)

## Tech Stack

- React
- Vite
- `@ffmpeg/ffmpeg` + `@ffmpeg/core` (WebAssembly processing)
- Canvas-based browser capture fallback
- JSZip

## Attribution

Most of this project implementation was produced with GitHub Copilot assistance (GPT-5.3-Codex), then iterated and validated in this repository.

## Local Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Run the development server

```bash
npm run dev
```

Open the local URL shown by Vite (typically `http://localhost:5173`).

### 3. Build for production

```bash
npm run build
```

### 4. Preview the production build

```bash
npm run preview
```

## Deployment (GitHub Pages)

This repository includes a GitHub Actions workflow at [.github/workflows/deploy.yml](.github/workflows/deploy.yml) that builds and deploys the app to GitHub Pages.

For this repository (`vaslabs/thumbnail-lab`), the published site URL is:

- https://vaslabs.github.io/thumbnail-lab/

### One-time GitHub setup

1. Go to your repository Settings.
2. Open Pages.
3. Set Source to GitHub Actions.

After that, each push to `main` or `master` triggers deployment automatically.

The workflow automatically builds with the correct Vite base path for this repo (`/thumbnail-lab/`).

## Implementation Highlights

### 1. FFmpeg WebAssembly extraction

The app first attempts thumbnail extraction with FFmpeg in the browser:

- Loads FFmpeg core via Vite URL imports (`@ffmpeg/core?url`, `@ffmpeg/core/wasm?url`)
- Writes input video to FFmpeg virtual FS
- Runs frame extraction and scaling
- Reads generated JPEG files and zips them

### 2. Memory-aware fallback strategy

Large videos can hit browser WASM memory limits. To improve reliability, extraction is layered:

1. Bulk FFmpeg extraction
2. Sequential FFmpeg extraction (single frame per command)
3. Browser-native Canvas extraction

The UI defaults to Canvas mode because it is more stable across large or high-bitrate uploads.

### 3. Canvas fallback (browser-native)

Canvas mode uses browser media APIs directly:

- Seeks an HTML video element to target timestamps
- Draws frames to canvas
- Exports compressed JPEG blobs
- Adds blobs to ZIP and preview grid

This keeps the tool functional even for heavier inputs where FFmpeg WASM may fail.

If you switch to FFmpeg mode, note that browser memory limits may still cause extraction failures on bigger files.

### 4. Runtime diagnostics

The generation pipeline is instrumented with console logging to trace stages such as:

- FFmpeg load/write/exec progress
- Bulk and sequential extraction steps
- Fallback activation
- ZIP generation and cleanup

## Notes

- Processing runs entirely in the browser and depends on available device memory.
- Very large or high-bitrate videos may take longer to process.
- If FFmpeg fails due to memory limits, the app automatically falls back to canvas extraction.
