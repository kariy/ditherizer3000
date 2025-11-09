const DEFAULTS = {
  rampSeconds: 2.5,
  mix: 0.85,
  algorithm: "ordered",
  pixelSize: 1,
  brightness: 1,
  smoothFactor: 0.08,
};

const BAYER_MATRIX = [
  0, 8, 2, 10, //
  12, 4, 14, 6, //
  3, 11, 1, 9, //
  15, 7, 13, 5,
];

let ctx = null;
let width = 0;
let height = 0;
let options = { ...DEFAULTS };
let easedMix = 0;
let pixelCanvas = null;
let pixelCtx = null;
let pixelBlock = 1;

self.addEventListener("message", async (event) => {
  const { data } = event;
  if (!data || typeof data.type !== "string") {
    return;
  }

  switch (data.type) {
    case "init":
      handleInit(data);
      break;
    case "frame":
      await handleFrame(data);
      break;
    case "finish":
      dispose();
      self.postMessage({ type: "finished" });
      break;
    case "updateOptions":
      options = { ...options, ...(data.options ?? {}) };
      break;
    default:
      break;
  }
});

function handleInit(payload) {
  const { canvas, width: w, height: h, options: initialOptions } = payload;
  width = w;
  height = h;
  options = { ...DEFAULTS, ...(initialOptions ?? {}) };
  easedMix = 0;

  ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    self.postMessage({
      type: "error",
      error: "Unable to acquire 2D context in worker.",
    });
    return;
  }

  configurePixelation();
  self.postMessage({ type: "ready" });
}

function configurePixelation() {
  pixelBlock = Math.max(1, Math.floor(options.pixelSize ?? 1));
  if (pixelBlock <= 1) {
    pixelCanvas = null;
    pixelCtx = null;
    return;
  }

  pixelCanvas = new OffscreenCanvas(
    Math.max(1, Math.floor(width / pixelBlock)),
    Math.max(1, Math.floor(height / pixelBlock))
  );
  pixelCtx = pixelCanvas.getContext("2d");
}

async function handleFrame(payload) {
  if (!ctx || !payload?.bitmap) {
    return;
  }

  const { bitmap, currentTime = 0, duration = 0 } = payload;
  try {
    drawFrame(bitmap);
    bitmap.close();

    const rampSeconds = Math.max(0.1, options.rampSeconds ?? DEFAULTS.rampSeconds);
    const ramp = duration > 0 ? Math.min(1, currentTime / rampSeconds) : 1;
    const targetMix = clamp01(ramp * (options.mix ?? DEFAULTS.mix));
    const smooth = clamp01(options.smoothFactor ?? DEFAULTS.smoothFactor);
    easedMix = lerp(easedMix, targetMix, smooth);

    applyPipeline(easedMix);

    const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;
    const done = duration > 0 && currentTime >= duration;
    self.postMessage({ type: "frameRendered", progress, done });
  } catch (error) {
    self.postMessage({
      type: "error",
      error: error?.message ?? "Worker frame processing failed.",
    });
  }
}

function drawFrame(bitmap) {
  if (pixelBlock > 1 && pixelCanvas && pixelCtx) {
    pixelCtx.drawImage(bitmap, 0, 0, pixelCanvas.width, pixelCanvas.height);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(pixelCanvas, 0, 0, width, height);
    ctx.restore();
  } else {
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
  }
}

function applyPipeline(mixValue) {
  const image = ctx.getImageData(0, 0, width, height);
  const brightness = Number.isFinite(options.brightness)
    ? options.brightness
    : DEFAULTS.brightness;
  if (brightness !== 1) {
    applyBrightness(image, brightness);
  }

  const algorithm = options.algorithm ?? DEFAULTS.algorithm;
  const mix = mixValue;

  if (mix <= 0 || algorithm === "none") {
    ctx.putImageData(image, 0, 0);
    return;
  }

  switch (algorithm) {
    case "floyd":
      applyFloydSteinberg(image, mix);
      break;
    case "ordered":
    default:
      applyOrdered(image, mix);
      break;
  }

  ctx.putImageData(image, 0, 0);
}

function applyBrightness(image, factor) {
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.max(0, Math.min(255, data[i] * factor));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] * factor));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] * factor));
  }
}

function applyOrdered(image, mix) {
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

function applyFloydSteinberg(image, mix) {
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

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp01(value) {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function dispose() {
  ctx = null;
  pixelCanvas = null;
  pixelCtx = null;
  easedMix = 0;
}
