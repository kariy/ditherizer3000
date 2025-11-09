const DEFAULTS = {
  rampSeconds: 2.5,
  mix: 0.85,
  algorithm: "ordered",
  pixelSize: 1,
  smoothFactor: 0.08,
};

const ORDERED = 0;
const NO_DITHER = 1;

const BAYER_MATRIX = [
  0, 8, 2, 10, //
  12, 4, 14, 6, //
  3, 11, 1, 9, //
  15, 7, 13, 5,
];

let gl = null;
let program = null;
let buffers = {};
let textures = {};
let uniforms = {};
let width = 0;
let height = 0;
let options = { ...DEFAULTS };
let easedMix = 0;

self.addEventListener("message", (event) => {
  const { data } = event;
  if (!data || typeof data.type !== "string") {
    return;
  }

  switch (data.type) {
    case "init":
      initializeRenderer(data);
      break;
    case "frame":
      renderFrame(data).catch((error) => {
        postMessage({
          type: "error",
          error: error?.message ?? "Worker failed while rendering frame.",
        });
      });
      break;
    case "finish":
      dispose();
      postMessage({ type: "finished" });
      break;
    case "updateOptions":
      options = { ...options, ...(data.options ?? {}) };
      break;
    default:
      break;
  }
});

function initializeRenderer(payload) {
  const { canvas, width: w, height: h, options: initialOptions } = payload;
  width = w;
  height = h;
  options = { ...DEFAULTS, ...(initialOptions ?? {}) };
  easedMix = 0;

  try {
    setupWebGL(canvas);
    postMessage({ type: "ready" });
  } catch (error) {
    dispose();
    postMessage({
      type: "error",
      error: error?.message ?? "Unable to initialize WebGL worker.",
    });
  }
}

function setupWebGL(canvas) {
  gl =
    canvas.getContext("webgl2", {
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
    }) ||
    canvas.getContext("webgl", {
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
    });

  if (!gl) {
    throw new Error("WebGL is not available inside the worker.");
  }

  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  const vertexSource = `
attribute vec2 aPosition;
attribute vec2 aUv;
varying vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

  const fragmentSource = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uVideo;
uniform sampler2D uBayer;
uniform vec2 uResolution;
uniform float uPixelSize;
uniform float uMix;
uniform int uAlgorithm;

vec2 snapUv(vec2 uv) {
  float pixel = max(uPixelSize, 1.0);
  if (pixel <= 1.0) {
    return uv;
  }
  vec2 grid = uResolution / pixel;
  vec2 snapped = (floor(uv * grid) + 0.5) / grid;
  return snapped;
}

float orderedThreshold(vec2 fragCoord) {
  vec2 cell = mod(fragCoord, 4.0);
  vec2 lookup = (cell + 0.5) / 4.0;
  return texture2D(uBayer, lookup).r;
}

void main() {
  vec2 fragCoord = vUv * uResolution;
  vec4 src = texture2D(uVideo, snapUv(vUv));
  float gray = dot(src.rgb, vec3(0.299, 0.587, 0.114));
  vec3 target = vec3(gray);

  if (uAlgorithm == 0) {
    float threshold = orderedThreshold(fragCoord) - 0.5;
    float adjusted = gray + threshold * (0.9 * uMix + 0.1);
    float bw = adjusted < 0.5 ? 0.0 : 1.0;
    target = vec3(bw);
  }

  vec3 color = mix(src.rgb, target, clamp(uMix, 0.0, 1.0));
  gl_FragColor = vec4(color, src.a);
}
`;

  program = createProgram(gl, vertexSource, fragmentSource);
  gl.useProgram(program);

  const data = new Float32Array([
    -1, -1, 0, 0,
    1, -1, 1, 0,
    -1, 1, 0, 1,
    1, 1, 1, 1,
  ]);

  buffers.quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.quad);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

  const aPosition = gl.getAttribLocation(program, "aPosition");
  const aUv = gl.getAttribLocation(program, "aUv");
  const stride = 4 * Float32Array.BYTES_PER_ELEMENT;

  gl.enableVertexAttribArray(aPosition);
  gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, stride, 0);

  gl.enableVertexAttribArray(aUv);
  gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);

  uniforms = {
    video: gl.getUniformLocation(program, "uVideo"),
    bayer: gl.getUniformLocation(program, "uBayer"),
    resolution: gl.getUniformLocation(program, "uResolution"),
    pixelSize: gl.getUniformLocation(program, "uPixelSize"),
    mix: gl.getUniformLocation(program, "uMix"),
    algorithm: gl.getUniformLocation(program, "uAlgorithm"),
  };

  textures.video = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, textures.video);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  textures.bayer = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, textures.bayer);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    4,
    4,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    createBayerTextureData()
  );

  gl.useProgram(program);
  gl.uniform1i(uniforms.video, 0);
  gl.uniform1i(uniforms.bayer, 1);
  gl.uniform2f(uniforms.resolution, width, height);
}

async function renderFrame(payload) {
  if (!gl || !program) {
    throw new Error("WebGL context is not ready.");
  }
  const { bitmap, currentTime = 0, duration = 0 } = payload;
  uploadBitmap(bitmap);
  bitmap.close();

  const rampSeconds = Math.max(0.1, options.rampSeconds ?? DEFAULTS.rampSeconds);
  const ramp = duration > 0 ? Math.min(1, currentTime / rampSeconds) : 1;
  const targetMix = clamp01(ramp * (options.mix ?? DEFAULTS.mix));
  const smooth = clamp01(options.smoothFactor ?? DEFAULTS.smoothFactor);
  easedMix = lerp(easedMix, targetMix, smooth);

  drawScene(easedMix);

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;
  const done = duration > 0 && currentTime >= duration;
  postMessage({ type: "frameRendered", progress, done });
}

function uploadBitmap(bitmap) {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, textures.video);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
}

function drawScene(mixValue) {
  gl.viewport(0, 0, width, height);
  gl.useProgram(program);
  gl.uniform2f(uniforms.resolution, width, height);
  gl.uniform1f(uniforms.pixelSize, Math.max(1, options.pixelSize ?? 1));
  gl.uniform1f(uniforms.mix, clamp01(mixValue));
  gl.uniform1i(uniforms.algorithm, getAlgorithmIndex(options.algorithm));
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.flush();
}

function createProgram(gl, vertexSource, fragmentSource) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const shaderProgram = gl.createProgram();
  gl.attachShader(shaderProgram, vertexShader);
  gl.attachShader(shaderProgram, fragmentShader);
  gl.linkProgram(shaderProgram);

  if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(shaderProgram);
    gl.deleteProgram(shaderProgram);
    throw new Error(`Failed to link shader program: ${log}`);
  }
  return shaderProgram;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compilation failed: ${log}`);
  }
  return shader;
}

function createBayerTextureData() {
  const data = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i += 1) {
    const value = Math.round((BAYER_MATRIX[i] / 16) * 255);
    const offset = i * 4;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  }
  return data;
}

function getAlgorithmIndex(algorithm) {
  switch (algorithm) {
    case "ordered":
      return ORDERED;
    case "none":
    default:
      return NO_DITHER;
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
  if (gl) {
    if (buffers.quad) {
      gl.deleteBuffer(buffers.quad);
    }
    if (textures.video) {
      gl.deleteTexture(textures.video);
    }
    if (textures.bayer) {
      gl.deleteTexture(textures.bayer);
    }
    if (program) {
      gl.deleteProgram(program);
    }
  }
  gl = null;
  program = null;
  buffers = {};
  textures = {};
  uniforms = {};
  easedMix = 0;
}
