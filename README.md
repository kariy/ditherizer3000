# Ordered Dither Video Editor

A browser-based mini video editor that remaps every frame of a video into a dithered, pixelated treatment. Drop a clip, tweak the algorithm/strength/pixel size, and the app exports a crunchy new WebM without leaving your browser.

## Getting Started

1. Install any static file server if you do not already have one. With Node.js:
   ```bash
   npx serve .
   ```
   or with Python:
   ```bash
   python3 -m http.server 4173
   ```
2. Open the served URL (e.g. `http://localhost:4173`) in a recent Chromium or Firefox build that supports `MediaRecorder` and `canvas.captureStream`.
3. Upload a source video file.
4. Adjust the effect controls (algorithm, mix, pixel size) to taste.
5. Hit **Generate Dithered Video** and wait for the preview to appear. Download the resulting WebM when you are happy with it.

All processing happens locally in the browser—no files ever leave your machine.

## How It Works

- The source video plays through a hidden `<video>` element. Every frame is drawn to an off-screen `<canvas>`, and a lightweight instant preview canvases the first frame so you can see settings before rendering.
- Ordered/none modes run inside an `OffscreenCanvas` WebGL worker that pixelates and dithers frames via a fragment shader, keeping the UI responsive while MediaRecorder captures the stream.
- Floyd–Steinberg currently falls back to the CPU renderer because the algorithm is iterative and harder to express as a single shader pass.
- The canvas stream is combined with the video's audio (if tap-able) and recorded via `MediaRecorder`. When the playback finishes, the recorded blob becomes the downloadable preview.

## Tuning the Effect

- **Dither Algorithm**: Choose classic 4×4 ordered Bayer, Floyd–Steinberg error diffusion, or disable dithering to only apply pixelation.
- **Effect Mix**: Blends between the original frame and the dithered frame. Lower values keep more of the source detail.
- **Pixel Size**: Downsamples the video before dithering to push it toward chunky, low-res art styles.

## Notes & Limitations

- Ordered and no-dither modes use WebGL2/WebGL inside a worker for speed. Floyd–Steinberg reverts to the CPU path, so it will still be slower, though the instant preview remains fast due to its tiny resolution.
- Dithering is CPU/GPU heavy. For 4K/60fps clips, prefer a desktop browser.
- MediaRecorder typically outputs WebM. Convert to other formats if needed via ffmpeg after download.
- Keep the browser tab focused while processing; throttled tabs can stall `requestAnimationFrame`.
- Some browsers block autoplay; if playback fails, press “Generate” again after interacting with the page.
- OffscreenCanvas/WebGL workers are available in the latest Chromium/Firefox builds. Unsupported browsers automatically fall back to the main-thread renderer.

## Verifying the Build

1. Serve the project locally (see “Getting Started”).
2. Use small sample files first (≤30 s) to confirm that rendering, preview playback, and downloads work.
3. Inspect DevTools for warnings/errors while processing; there should be none in a healthy run.

Enjoy making crunchy dithered visuals!
