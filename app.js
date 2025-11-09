const elements = {
  videoInput: document.getElementById("videoInput"),
  generateBtn: document.getElementById("generateBtn"),
  resetBtn: document.getElementById("resetBtn"),
  statusText: document.getElementById("statusText"),
  progressBar: document.getElementById("progressBar"),
  previewVideo: document.getElementById("previewVideo"),
  downloadLink: document.getElementById("downloadLink"),
  algorithmSelect: document.getElementById("algorithmSelect"),
  detailInput: document.getElementById("detailInput"),
  detailValue: document.getElementById("detailValue"),
  pixelSizeInput: document.getElementById("pixelSizeInput"),
  pixelSizeValue: document.getElementById("pixelSizeValue"),
  instantPreviewCanvas: document.getElementById("instantPreview"),
  previewStatus: document.getElementById("previewStatus"),
};

const DEFAULT_SETTINGS = {
  algorithm: "ordered",
  mix: 0.85,
  pixelSize: 1,
  rampSeconds: 2.5,
};

const state = {
  videoFile: null,
  processing: false,
  outputUrl: null,
  settings: { ...DEFAULT_SETTINGS },
};

const previewState = {
  ctx:
    elements.instantPreviewCanvas?.getContext("2d", { willReadFrequently: true }) ??
    null,
  requestId: 0,
  debounceHandle: null,
};

function setPreviewStatus(message) {
  if (elements.previewStatus) {
    elements.previewStatus.textContent = message;
  }
}

setPreviewStatus("Select a video to see a quick preview.");

const GPU_SUPPORTED_ALGORITHMS = new Set(["ordered", "none"]);

const BAYER_MATRIX = [
  0, 8, 2, 10, //
  12, 4, 14, 6, //
  3, 11, 1, 9, //
  15, 7, 13, 5,
];

elements.videoInput.addEventListener("change", (event) => {
  state.videoFile = event.target.files?.[0] ?? null;
  updateStatus(
    state.videoFile
      ? `Loaded video: ${state.videoFile.name}`
      : "Video removed. Select new files to continue."
  );
  refreshControls();
  scheduleInstantPreview();
});

elements.generateBtn.addEventListener("click", async () => {
  if (!state.videoFile || state.processing) {
    return;
  }
  try {
    state.processing = true;
    refreshControls();
    await runDitherPipeline();
  } catch (error) {
    console.error(error);
    updateStatus(
      `Processing failed: ${
        error?.message ?? "Unknown error. Check console for details."
      }`
    );
  } finally {
    state.processing = false;
    refreshControls();
  }
});

elements.resetBtn.addEventListener("click", () => resetWorkspace());

initializeEffectControls();

function refreshControls() {
  elements.generateBtn.disabled =
    state.processing || !state.videoFile;
  elements.resetBtn.disabled = state.processing && !state.outputUrl;
}

function updateStatus(message) {
  elements.statusText.textContent = message;
}

function updateProgress(percent) {
  const clamped = Math.max(0, Math.min(100, percent));
  elements.progressBar.style.width = `${clamped}%`;
  elements.progressBar.parentElement?.setAttribute(
    "aria-valuenow",
    clamped.toFixed(0)
  );
}

function resetWorkspace() {
  if (state.processing) {
    return;
  }
  state.videoFile = null;
  if (state.outputUrl) {
    URL.revokeObjectURL(state.outputUrl);
    state.outputUrl = null;
  }
  elements.videoInput.value = "";
  elements.previewVideo.removeAttribute("src");
  elements.previewVideo.load();
  elements.downloadLink.hidden = true;
  elements.downloadLink.removeAttribute("href");
  updateStatus("Workspace cleared. Select a video to begin.");
  updateProgress(0);
  refreshControls();
  clearInstantPreview("Select a video to see a quick preview.");
}

function initializeEffectControls() {
  if (
    !elements.algorithmSelect ||
    !elements.detailInput ||
    !elements.pixelSizeInput
  ) {
    return;
  }

  elements.algorithmSelect.value = DEFAULT_SETTINGS.algorithm;
  elements.detailInput.value = String(Math.round(DEFAULT_SETTINGS.mix * 100));
  elements.pixelSizeInput.value = String(DEFAULT_SETTINGS.pixelSize);
  syncEffectSettingOutputs();
  applyEffectSettingsFromInputs();

  elements.algorithmSelect.addEventListener("change", () => {
    applyEffectSettingsFromInputs();
  });

  elements.detailInput.addEventListener("input", () => {
    syncEffectSettingOutputs();
    applyEffectSettingsFromInputs();
  });

  elements.pixelSizeInput.addEventListener("input", () => {
    syncEffectSettingOutputs();
    applyEffectSettingsFromInputs();
  });
}

function syncEffectSettingOutputs() {
  if (elements.detailValue && elements.detailInput) {
    elements.detailValue.textContent = `${elements.detailInput.value}%`;
  }
  if (elements.pixelSizeValue && elements.pixelSizeInput) {
    elements.pixelSizeValue.textContent = `${elements.pixelSizeInput.value}px`;
  }
}

function applyEffectSettingsFromInputs() {
  const mixValue = clamp01(Number(elements.detailInput?.value ?? 0) / 100);
  const pixelSizeValue = Math.max(
    1,
    Number(elements.pixelSizeInput?.value ?? 1)
  );

  state.settings = {
    algorithm: elements.algorithmSelect?.value ?? DEFAULT_SETTINGS.algorithm,
    mix: Number.isNaN(mixValue) ? DEFAULT_SETTINGS.mix : mixValue,
    pixelSize: Number.isNaN(pixelSizeValue)
      ? DEFAULT_SETTINGS.pixelSize
      : pixelSizeValue,
    rampSeconds: DEFAULT_SETTINGS.rampSeconds,
  };

  scheduleInstantPreview();
}

function scheduleInstantPreview() {
  if (!previewState.ctx || !elements.instantPreviewCanvas) {
    return;
  }
  if (!state.videoFile) {
    clearInstantPreview("Select a video to see a quick preview.");
    return;
  }
  if (previewState.debounceHandle) {
    clearTimeout(previewState.debounceHandle);
  }
  previewState.debounceHandle = setTimeout(() => {
    previewState.debounceHandle = null;
    runInstantPreview().catch((error) => {
      console.warn("Instant preview failed", error);
      setPreviewStatus("Preview unavailable.");
    });
  }, 200);
}

function clearInstantPreview(message) {
  const canvas = elements.instantPreviewCanvas;
  const ctx = previewState.ctx;
  if (canvas && ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  if (typeof message === "string") {
    setPreviewStatus(message);
  }
}

async function runInstantPreview() {
  if (!previewState.ctx || !elements.instantPreviewCanvas || !state.videoFile) {
    return;
  }

  const token = ++previewState.requestId;
  const file = state.videoFile;
  const settings = { ...state.settings };
  setPreviewStatus("Rendering preview...");

  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";

  try {
    await waitForEvent(video, "loadeddata");

    if (token !== previewState.requestId) {
      return;
    }

    const duration = video.duration || 0;
    const sampleTime = duration > 0 ? Math.min(duration * 0.05, duration - 0.01) : 0;
    if (sampleTime > 0 && Math.abs(video.currentTime - sampleTime) > 0.01) {
      await seekVideo(video, sampleTime);
    }

    if (token !== previewState.requestId) {
      return;
    }

    const canvas = elements.instantPreviewCanvas;
    const ctx = previewState.ctx;
    const maxWidth = 360;
    const sourceWidth = video.videoWidth || maxWidth;
    const sourceHeight = video.videoHeight || Math.round(maxWidth * (9 / 16));
    const aspect = sourceHeight ? sourceWidth / sourceHeight : 16 / 9;
    const targetWidth = Math.max(1, Math.min(maxWidth, sourceWidth));
    const targetHeight = Math.max(1, Math.round(targetWidth / (aspect || 1.777)));

    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const pixelBlock = Math.max(1, Math.floor(settings.pixelSize));
    let pixelCanvas = null;
    let pixelCtx = null;
    if (pixelBlock > 1) {
      pixelCanvas = document.createElement("canvas");
      pixelCanvas.width = Math.max(1, Math.floor(targetWidth / pixelBlock));
      pixelCanvas.height = Math.max(1, Math.floor(targetHeight / pixelBlock));
      pixelCtx = pixelCanvas.getContext("2d") ?? null;
      if (!pixelCtx) {
        pixelCanvas = null;
      }
    }

    drawFrameWithPixelation({
      ctx,
      source: video,
      width: targetWidth,
      height: targetHeight,
      pixelBlock,
      pixelCanvas,
      pixelCtx,
    });

    applyDitherPipeline(ctx, targetWidth, targetHeight, {
      algorithm: settings.algorithm,
      mix: settings.mix,
    });

    if (token === previewState.requestId) {
      setPreviewStatus("Instant preview (first frame)");
    }
  } catch (error) {
    if (token === previewState.requestId) {
      setPreviewStatus("Preview unavailable.");
    }
    throw error;
  } finally {
    video.pause();
    URL.revokeObjectURL(url);
  }
}

function seekVideo(videoEl, time) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Failed to seek video for preview."));
    };
    const cleanup = () => {
      videoEl.removeEventListener("seeked", onSeeked);
      videoEl.removeEventListener("error", onError);
    };

    videoEl.addEventListener("seeked", onSeeked);
    videoEl.addEventListener("error", onError);

    try {
      videoEl.currentTime = Math.max(0, time);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function runDitherPipeline() {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
    throw new Error(
      "MediaRecorder API is not available in this browser. Please try a recent Chromium or Firefox build."
    );
  }

  updateStatus("Initializing pipeline...");
  updateProgress(5);

  const videoUrl = URL.createObjectURL(state.videoFile);
  const hiddenVideo = createHiddenMediaElement("video", videoUrl);
  document.body.append(hiddenVideo);

  let audioTap = null;

  try {
    await waitForEvent(hiddenVideo, "loadedmetadata");

    const canvas = document.createElement("canvas");
    canvas.width = hiddenVideo.videoWidth;
    canvas.height = hiddenVideo.videoHeight;

    const useGpuWorker = shouldUseGpuWorker(state.settings);
    const ctx = useGpuWorker
      ? null
      : canvas.getContext("2d", { willReadFrequently: true });
    if (!useGpuWorker && !ctx) {
      throw new Error("Unable to acquire 2D canvas context.");
    }

    try {
      audioTap = await tapOriginalAudio(hiddenVideo);
    } catch (error) {
      console.warn("Audio capture unavailable, output will be silent.", error);
    }

    const canvasStream = canvas.captureStream(
      Math.min(60, hiddenVideo.frameRate || 30)
    );
    const combinedStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...(audioTap?.audioDest?.stream?.getAudioTracks() ?? []),
    ]);

    const mimeType = pickSupportedMimeType([
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ]);
    if (!mimeType) {
      throw new Error("No supported MediaRecorder mime type was found.");
    }

    let recorder = null;
    let recordingDone = null;
    let outputBlob = null;

    try {
      recorder = new MediaRecorder(combinedStream, { mimeType });
      const recordedChunks = [];
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data && event.data.size > 0) {
          recordedChunks.push(event.data);
        }
      });

      recordingDone = new Promise((resolve) => {
        recorder.addEventListener(
          "stop",
          () =>
            resolve(
              new Blob(recordedChunks, { type: recorder.mimeType || mimeType })
            ),
          { once: true }
        );
      });

      hiddenVideo.currentTime = 0;
      hiddenVideo.muted = true;
      await hiddenVideo.play();

      recorder.start(250);
      updateStatus("Rendering frames with custom dither...");

      const effectConfig = { ...state.settings };

      if (useGpuWorker) {
        try {
          await renderFramesWithWorker({
            videoEl: hiddenVideo,
            canvas,
            options: effectConfig,
            onProgress: (ratio) => updateProgress(5 + ratio * 85),
          });
        } catch (workerError) {
          console.warn(
            "GPU worker pipeline failed, falling back to CPU renderer.",
            workerError
          );
          await renderFramesOnMainThread({
            videoEl: hiddenVideo,
            ctx: canvas.getContext("2d", { willReadFrequently: true }),
            options: effectConfig,
            onProgress: (ratio) => updateProgress(5 + ratio * 85),
          });
        }
      } else {
        await renderFramesOnMainThread({
          videoEl: hiddenVideo,
          ctx,
          options: effectConfig,
          onProgress: (ratio) => updateProgress(5 + ratio * 85),
        });
      }

      hiddenVideo.pause();
      recorder.stop();
      outputBlob = await recordingDone;
    } finally {
      try {
        hiddenVideo.pause();
      } catch {
        /* ignore */
      }
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          /* ignore */
        }
      }
      if (recordingDone) {
        try {
          await recordingDone;
        } catch {
          /* ignore */
        }
      }
      if (audioTap?.dispose) {
        try {
          await audioTap.dispose();
        } catch {
          /* ignore */
        }
      }
    }

    if (!outputBlob) {
      throw new Error("Failed to produce a recording.");
    }

    updateProgress(100);
    updateStatus("Done! Preview ready below.");
    displayResult(outputBlob);
  } finally {
    hiddenVideo.remove();
    URL.revokeObjectURL(videoUrl);
  }
}

function createHiddenMediaElement(tag, src) {
  const el = document.createElement(tag);
  el.src = src;
  el.crossOrigin = "anonymous";
  el.playsInline = true;
  el.preload = "auto";
  el.style.position = "fixed";
  el.style.opacity = "0";
  el.style.pointerEvents = "none";
  el.style.width = "0";
  el.style.height = "0";
  return el;
}

function waitForEvent(target, eventName) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(eventName, onSuccess);
      target.removeEventListener("error", onError);
    };
    const onSuccess = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Failed waiting for ${eventName}`));
    };
    target.addEventListener(eventName, onSuccess, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

function pickSupportedMimeType(types) {
  return types.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

async function tapOriginalAudio(videoEl) {
  if (!window.AudioContext) {
    throw new Error("Web Audio API is not available.");
  }
  const audioCtx = new AudioContext();
  await audioCtx.resume();
  const source = audioCtx.createMediaElementSource(videoEl);
  const audioDest = audioCtx.createMediaStreamDestination();
  source.connect(audioDest);

  return {
    audioDest,
    dispose: async () => {
      source.disconnect();
      await audioCtx.close();
    },
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp01(value) {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function supportsWorkerRendering() {
  return (
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap === "function" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.transferControlToOffscreen === "function"
  );
}

function shouldUseGpuWorker(settings) {
  const algorithm = settings?.algorithm ?? DEFAULT_SETTINGS.algorithm;
  return (
    GPU_SUPPORTED_ALGORITHMS.has(algorithm) && supportsWorkerRendering()
  );
}

async function renderFramesWithWorker({ videoEl, canvas, options, onProgress }) {
  return new Promise((resolve, reject) => {
    let cancelled = false;
    const worker = new Worker("ditherWorker.js");
    let rafId = 0;
    let workerReady = false;
    let workerBusy = false;

    const cleanup = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      worker.terminate();
      cancelled = true;
    };

    worker.addEventListener("message", (event) => {
      if (cancelled) {
        return;
      }
      const { type, progress, done, error } = event.data || {};
      if (type === "ready") {
        workerReady = true;
        rafId = requestAnimationFrame(pump);
      } else if (type === "frameRendered") {
        workerBusy = false;
        onProgress?.(progress ?? 0);
        if (done || videoEl.ended) {
          cleanup();
          resolve();
        } else {
          rafId = requestAnimationFrame(pump);
        }
      } else if (type === "finished") {
        cleanup();
        resolve();
      } else if (type === "error") {
        cleanup();
        reject(new Error(error ?? "Worker rendering failed."));
      }
    });

    const pump = () => {
      if (cancelled) {
        return;
      }
      if (!workerReady || workerBusy) {
        rafId = requestAnimationFrame(pump);
        return;
      }
      if (videoEl.ended) {
        worker.postMessage({ type: "finish" });
        return;
      }
      if (videoEl.paused) {
        rafId = requestAnimationFrame(pump);
        return;
      }

      workerBusy = true;
      createImageBitmap(videoEl)
        .then((bitmap) => {
          worker.postMessage(
            {
              type: "frame",
              bitmap,
              currentTime: videoEl.currentTime,
              duration: videoEl.duration || 0,
            },
            [bitmap]
          );
        })
        .catch((error) => {
          workerBusy = false;
          cleanup();
          reject(error);
        });
    };

    try {
      const offscreen = canvas.transferControlToOffscreen();
      worker.postMessage(
        {
          type: "init",
          canvas: offscreen,
          width: canvas.width,
          height: canvas.height,
          options,
        },
        [offscreen]
      );
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function renderFramesOnMainThread({ videoEl, ctx, options, onProgress }) {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  const duration = videoEl.duration || 1;
  const {
    rampSeconds = DEFAULT_SETTINGS.rampSeconds,
    mix = DEFAULT_SETTINGS.mix,
    pixelSize = DEFAULT_SETTINGS.pixelSize,
    algorithm = DEFAULT_SETTINGS.algorithm,
  } = options ?? DEFAULT_SETTINGS;

  const rampDuration = Math.max(0.1, rampSeconds);
  const pixelBlock = Math.max(1, Math.floor(pixelSize));
  let easedMix = 0;
  let pixelateCanvas = null;
  let pixelateCtx = null;

  if (pixelBlock > 1) {
    pixelateCanvas = document.createElement("canvas");
    pixelateCanvas.width = Math.max(1, Math.floor(width / pixelBlock));
    pixelateCanvas.height = Math.max(1, Math.floor(height / pixelBlock));
    pixelateCtx = pixelateCanvas.getContext("2d") ?? null;
    if (!pixelateCtx) {
      pixelateCanvas = null;
    }
  }

  await new Promise((resolve) => {
    const step = () => {
      if (videoEl.ended) {
        onProgress?.(1);
        resolve();
        return;
      }

      if (!videoEl.paused) {
        drawFrameWithPixelation({
          ctx,
          source: videoEl,
          width,
          height,
          pixelBlock,
          pixelCanvas: pixelateCanvas,
          pixelCtx: pixelateCtx,
        });

        const ramp = Math.min(1, videoEl.currentTime / rampDuration);
        const targetMix = ramp * mix;
        easedMix = lerp(easedMix, targetMix, 0.08);

        applyDitherPipeline(ctx, width, height, {
          algorithm,
          mix: easedMix,
        });

        onProgress?.(Math.min(1, videoEl.currentTime / duration));
      }

      requestAnimationFrame(step);
    };

    requestAnimationFrame(step);
  });
}

function drawFrameWithPixelation({
  ctx,
  source,
  width,
  height,
  pixelBlock,
  pixelCanvas,
  pixelCtx,
}) {
  if (!ctx || !source) {
    return;
  }
  if (pixelBlock > 1 && pixelCanvas && pixelCtx) {
    pixelCtx.drawImage(source, 0, 0, pixelCanvas.width, pixelCanvas.height);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(pixelCanvas, 0, 0, width, height);
    ctx.restore();
  } else {
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0, width, height);
  }
}

function applyDitherPipeline(ctx, width, height, { algorithm, mix }) {
  if (!algorithm || mix <= 0 || algorithm === "none") {
    return;
  }

  const image = ctx.getImageData(0, 0, width, height);

  switch (algorithm) {
    case "floyd":
      applyFloydSteinbergDither(image, mix);
      break;
    case "ordered":
    default:
      applyOrderedDither(image, mix);
      break;
  }

  ctx.putImageData(image, 0, 0);
}

function applyOrderedDither(image, mix) {
  const { data, width, height } = image;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const gray = Math.min(255, 0.299 * r + 0.587 * g + 0.114 * b);

      const threshold =
        (BAYER_MATRIX[((y & 3) << 2) + (x & 3)] + 0.5) / 16 - 0.5;
      const adjusted = gray + threshold * 255 * mix;
      const bw = adjusted < 128 ? 0 : 255;

      data[idx] = lerp(r, bw, mix);
      data[idx + 1] = lerp(g, bw, mix);
      data[idx + 2] = lerp(b, bw, mix);
    }
  }
}

function applyFloydSteinbergDither(image, mix) {
  const { data, width, height } = image;
  const totalPixels = width * height;
  const buffer = new Float32Array(totalPixels);

  for (let i = 0; i < totalPixels; i += 1) {
    const idx = i * 4;
    buffer[i] =
      0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      const oldPixel = buffer[idx];
      const newPixel = oldPixel < 128 ? 0 : 255;
      const error = oldPixel - newPixel;
      buffer[idx] = newPixel;

      if (x + 1 < width) {
        buffer[idx + 1] += (error * 7) / 16;
      }
      if (y + 1 < height) {
        if (x > 0) {
          buffer[idx + width - 1] += (error * 3) / 16;
        }
        buffer[idx + width] += (error * 5) / 16;
        if (x + 1 < width) {
          buffer[idx + width + 1] += error / 16;
        }
      }
    }
  }

  for (let i = 0; i < totalPixels; i += 1) {
    const idx = i * 4;
    const bw = buffer[i] < 128 ? 0 : 255;
    data[idx] = lerp(data[idx], bw, mix);
    data[idx + 1] = lerp(data[idx + 1], bw, mix);
    data[idx + 2] = lerp(data[idx + 2], bw, mix);
  }
}

function displayResult(blob) {
  if (state.outputUrl) {
    URL.revokeObjectURL(state.outputUrl);
  }
  const url = URL.createObjectURL(blob);
  state.outputUrl = url;
  elements.previewVideo.src = url;
  elements.previewVideo.load();
  elements.previewVideo.play().catch(() => {
    /* autoplay might be blocked */
  });
  elements.downloadLink.href = url;
  elements.downloadLink.hidden = false;
}
