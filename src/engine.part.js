  const TAU = Math.PI * 2;
  const SIM_SIZE = 256;
  const MAX_PARTICLES = SIM_SIZE * SIM_SIZE;
  const CAMERA_Z = 3.1;
  const MESH_SCALE = 5;
  const HALF_FOV_TAN = Math.tan((40 * Math.PI) / 360);
  // 官网用 poisson-disk-sampling 的 "fixed density" 实现：
  // minDistance / maxDistance 随 density 在 10..2 / 11..3 之间线性映射
  const DENSITY_MIN_DIST = (density) => mapRange(clamp(density, 0, 300), 0, 300, 10, 2);
  const DENSITY_MAX_DIST = (density) => mapRange(clamp(density, 0, 300), 0, 300, 11, 3);

  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointerQuery = window.matchMedia('(hover: hover) and (pointer: fine)');

  /* ---------------- 小工具 ---------------- */
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function mapRange(v, inMin, inMax, outMin, outMax) {
    return ((v - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin;
  }
  // 原站把十六进制颜色直接当作 0..1 的着色器值使用（未做 sRGB→linear 转换），
  // 这里保持一致，否则粒子会明显偏暗、偏饱和。
  function hexToUnit(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  }

  /* ---------------- 低频值噪声（光标空闲时的漂移） ---------------- */
  class ValueNoise {
    constructor() {
      this.MASK = 255;
      this.amplitude = 1;
      this.scale = 1;
      this.r = new Float32Array(256);
      for (let i = 0; i < 256; i++) this.r[i] = Math.random();
    }
    getVal(t) {
      const x = t * this.scale;
      const i = Math.floor(x);
      const f = x - i;
      const u = f * f * (3 - 2 * f);
      const a = this.r[i & this.MASK];
      const b = this.r[(i + 1) & this.MASK];
      return (a * (1 - u) + b * u) * this.amplitude;
    }
  }

  /* ---------------- Poisson 圆盘采样 ----------------
     按 poisson-disk-sampling 的 fixed-density 实现改写：
     - 候选点落在当前点 [minDistance, maxDistance] 的圆环上；
     - 队列按 FIFO 处理，候选点连续 maxTries 次失败后才移出队列。 */
  function poissonDisk(size, minDist, maxDist, tries, maxPoints) {
    const cell = minDist / Math.SQRT2;
    const gridW = Math.ceil(size / cell);
    const grid = new Int32Array(gridW * gridW).fill(-1);
    const points = [];
    const active = [];

    const addPoint = (x, y) => {
      const index = points.length / 2;
      points.push(x, y);
      active.push(index);
      grid[((y / cell) | 0) * gridW + ((x / cell) | 0)] = index;
    };

    const isFree = (x, y) => {
      const gx = (x / cell) | 0;
      const gy = (y / cell) | 0;
      for (let yy = Math.max(0, gy - 2); yy <= Math.min(gridW - 1, gy + 2); yy++) {
        for (let xx = Math.max(0, gx - 2); xx <= Math.min(gridW - 1, gx + 2); xx++) {
          const index = grid[yy * gridW + xx];
          if (index === -1) continue;
          const dx = x - points[index * 2];
          const dy = y - points[index * 2 + 1];
          if (dx * dx + dy * dy < minDist * minDist) return false;
        }
      }
      return true;
    };

    addPoint(Math.random() * size, Math.random() * size);

    // 与官网实现一致：队首点一次只接受一个候选；整批 maxTries 都失败才移出队列
    for (let head = 0; head < active.length && points.length / 2 < maxPoints;) {
      const index = active[head];
      const px = points[index * 2];
      const py = points[index * 2 + 1];
      let accepted = false;
      for (let k = 0; k < tries; k++) {
        const angle = Math.random() * TAU;
        const radius = minDist + Math.random() * (maxDist - minDist);
        const x = px + Math.cos(angle) * radius;
        const y = py + Math.sin(angle) * radius;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        if (!isFree(x, y)) continue;
        addPoint(x, y);
        accepted = true;
        break;
      }
      if (!accepted) head++;
    }
    return points;
  }

  /* ---------------- 全局光标（与原站一致：window 级监听） ---------------- */
  const pointer = { x: 0, y: 0, hasMoved: false };
  const onPointerMove = (e) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.hasMoved = true;
  };
  if (finePointerQuery.matches) {
    window.addEventListener('mousemove', onPointerMove, { passive: true });
  } else {
    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') onPointerMove(e);
    }, { passive: true, capture: true });
  }

  /* ==========================================================
     Ashima Arts / Stefan Gustavson simplex noise（原站内联的实现）
     ========================================================== */
  const NOISE_GLSL = `__NOISE_GLSL__`;

  const SIM_VERT = `#version 300 es
    precision highp float;
    void main() {
      // 无顶点缓冲的全屏三角形
      vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
      gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
    }`;

  const SIM_FRAG = `#version 300 es
    precision highp float;

    uniform sampler2D uPosition;
    uniform sampler2D uPosRefs;
    uniform vec2  uRingPos;
    uniform float uTime;
    uniform float uDeltaTime;
    uniform float uRingRadius;
    uniform float uRingWidth;
    uniform float uRingWidth2;
    uniform float uRingDisplacement;

    out vec4 outColor;

    ${NOISE_GLSL}

    void main() {
      vec2 simTexCoords = gl_FragCoord.xy / vec2(${SIM_SIZE.toFixed(1)}, ${SIM_SIZE.toFixed(1)});
      vec4 pFrame = texture(uPosition, simTexCoords);

      float scale = pFrame.z;
      float velocity = pFrame.w;
      vec2 refPos = texture(uPosRefs, simTexCoords).xy;

      float time = uTime * 0.5;
      vec2 curentPos = refPos;

      vec2 pos = pFrame.xy;
      pos *= 0.8;

      float dist = distance(curentPos.xy, uRingPos);
      float noise0 = snoise(vec3(curentPos.xy * 0.2 + vec2(18.4924, 72.9744), time * 0.5));
      float dist1 = distance(curentPos.xy + (noise0 * 0.005), uRingPos);

      float t  = smoothstep(uRingRadius - (uRingWidth * 2.0), uRingRadius, dist) - smoothstep(uRingRadius, uRingRadius + uRingWidth, dist1);
      float t2 = smoothstep(uRingRadius - (uRingWidth2 * 2.0), uRingRadius, dist) - smoothstep(uRingRadius, uRingRadius + uRingWidth2, dist1);
      float t3 = smoothstep(uRingRadius + uRingWidth2, uRingRadius, dist);

      t = pow(t, 2.0);
      t2 = pow(t2, 3.0);

      t += t2 * 3.0;
      t += t3 * 0.4;
      t += snoise(vec3(curentPos.xy * 30.0 + vec2(11.4924, 12.9744), time * 0.5)) * t3 * 0.5;

      float nS = snoise(vec3(curentPos.xy * 2.0 + vec2(18.4924, 72.9744), time * 0.5));
      t += pow((nS + 1.5) * 0.5, 2.0) * 0.6;

      // 中尺度噪声
      float noise1 = snoise(vec3(curentPos.xy * 4.0 + vec2(88.494, 32.4397), time * 0.35));
      float noise2 = snoise(vec3(curentPos.xy * 4.0 + vec2(50.904, 120.947), time * 0.35));

      // 近距离噪声
      float noise3 = snoise(vec3(curentPos.xy * 20.0 + vec2(18.4924, 72.9744), time * 0.5));
      float noise4 = snoise(vec3(curentPos.xy * 20.0 + vec2(50.904, 120.947), time * 0.5));

      vec2 disp = vec2(noise1, noise2) * 0.03;
      disp += vec2(noise3, noise4) * 0.005;

      // 正弦波
      disp.x += sin((refPos.x * 20.0) + (time * 4.0)) * 0.02 * clamp(dist, 0.0, 1.0);
      disp.y += cos((refPos.y * 20.0) + (time * 3.0)) * 0.02 * clamp(dist, 0.0, 1.0);

      pos -= (uRingPos - (curentPos + disp)) * pow(t2, 0.75) * uRingDisplacement;

      // scale 缓动
      float scaleDiff = t - scale;
      scaleDiff *= 0.2;
      scale += scaleDiff;

      // 最终位置：参考位置 + 噪声位移 + 惯性
      vec2 finalPos = curentPos + disp + (pos * 0.25);

      velocity *= 0.5;
      velocity += scale * 0.25;

      outColor = vec4(finalPos, scale, velocity);
    }`;

  const RENDER_VERT = `#version 300 es
    precision highp float;

    in vec2 aUv;

    uniform sampler2D uPosition;
    uniform vec2  uNdcScale;
    uniform float uParticleScale;
    uniform float uPixelRatio;

    out float vScale;
    out float vVelocity;
    out vec2  vLocalPos;

    void main() {
      vec4 pos = texture(uPosition, aUv);

      vScale = pos.z;
      vVelocity = pos.w;
      vLocalPos = pos.xy;

      gl_Position = vec4(pos.xy * uNdcScale, 0.0, 1.0);
      gl_PointSize = vScale * 7.0 * (uPixelRatio * 0.5) * uParticleScale;
    }`;

  const RENDER_FRAG = `#version 300 es
    precision highp float;

    in float vScale;
    in float vVelocity;
    in vec2  vLocalPos;

    uniform vec3  uColor1;
    uniform vec3  uColor2;
    uniform vec3  uColor3;
    uniform vec2  uRingPos;
    uniform float uAlpha;
    uniform float uTime;
    uniform int   uColorScheme;

    out vec4 outColor;

    ${NOISE_GLSL}

    float sdRoundBox(in vec2 p, in vec2 b, in vec4 r) {
      r.xy = (p.x > 0.0) ? r.xy : r.zw;
      r.x  = (p.y > 0.0) ? r.x  : r.y;
      vec2 q = abs(p) - b + r.x;
      return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r.x;
    }

    vec2 rotate(vec2 v, float a) {
      float s = sin(a);
      float c = cos(a);
      mat2 m = mat2(c, s, -s, c);
      return m * v;
    }

    void main() {
      float noiseAngle = snoise(vec3(vLocalPos * 10.0 + vec2(18.4924, 72.9744), uTime * 0.85));
      float noiseColor = snoise(vec3(vLocalPos * 2.0 + vec2(74.664, 91.556), uTime * 0.5));
      noiseColor = (noiseColor + 1.0) * 0.5;

      // 点精灵朝向环心，形成放射状短棒
      float angle = atan(vLocalPos.y - uRingPos.y, vLocalPos.x - uRingPos.x);

      vec2 uv = gl_PointCoord.xy - 0.5;
      uv.y *= -1.0;
      uv = rotate(uv, -angle + (noiseAngle * 0.5));

      float h = 0.8;
      float progress = smoothstep(0.0, 0.75, pow(noiseColor, 2.0));
      vec3 color = mix(
        mix(uColor1, uColor2, progress / h),
        mix(uColor2, uColor3, (progress - h) / (1.0 - h)),
        step(h, progress)
      );

      float rounded = sdRoundBox(uv, vec2(0.5, 0.2), vec4(0.25));
      rounded = smoothstep(0.1, 0.0, rounded);

      float a = uAlpha * rounded * smoothstep(0.1, 0.2, vScale);
      if (a < 0.01) discard;

      color = clamp(color, 0.0, 1.0);
      color = mix(color, color * clamp(vVelocity, 0.0, 1.0), float(uColorScheme));

      outColor = vec4(color, clamp(a, 0.0, 1.0));
    }`;

  const THEMES = {
    light: {
      colors: ['#2c64ed', '#f84242', '#ffcf03'].map(hexToUnit),
      background: [1, 1, 1],
      colorScheme: 1,
    },
    dark: {
      colors: ['#7189ff', '#3074f9', '#000000'].map(hexToUnit),
      background: [0, 0, 0],
      colorScheme: 0,
    },
  };

  /* ========================================================== */
  class ParticleField {
    constructor(canvas, config) {
      this.canvas = canvas;
      this.theme = config.theme;
      this.palette = THEMES[config.theme];
      this.interactive = true;
      this.defaults = {
        density: config.density,
        particlesScale: config.particlesScale,
        ringWidth: config.ringWidth,
        ringWidth2: config.ringWidth2,
        ringDisplacement: config.ringDisplacement,
      };
      this.opts = { ...this.defaults };

      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.reduced = reducedMotionQuery.matches;
      this.isMobile = window.innerWidth <= 768;
      this.time = 0;
      this.everRendered = false;
      this.pointerInside = false;
      this.offscreen = false;
      this.frameSkip = false;
      this.intersection = [0, 0];
      this.ringPos = new Float32Array([0, 0]);
      this.cursorPos = new Float32Array([0, 0]);
      this.noiseX = new ValueNoise();
      this.noiseY = new ValueNoise();
      this.count = 0;
      this.ready = false;

      this.posData = new Float32Array(MAX_PARTICLES * 4);
      this.uvData = new Float32Array(MAX_PARTICLES * 2);
      for (let i = 0; i < MAX_PARTICLES; i++) {
        this.uvData[i * 2] = (i % SIM_SIZE) / SIM_SIZE;
        this.uvData[i * 2 + 1] = Math.floor(i / SIM_SIZE) / SIM_SIZE;
      }

      try {
        this.init();
      } catch (err) {
        console.warn('[antigravity-bg] init failed:', err);
        this.ready = false;
      }
      if (!this.ready) this.markFallback();
    }

    markFallback() {
      // The DSH shell has no fallback surface; the plugin simply keeps the UI plain.
      this.failed = true;
    }

    /* ---------------- WebGL 初始化 ---------------- */
    compile(type, source) {
      const gl = this.gl;
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error('Shader compile error: ' + log);
      }
      return shader;
    }

    program(vertSource, fragSource) {
      const gl = this.gl;
      const program = gl.createProgram();
      const vs = this.compile(gl.VERTEX_SHADER, vertSource);
      const fs = this.compile(gl.FRAGMENT_SHADER, fragSource);
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error('Program link error: ' + gl.getProgramInfoLog(program));
      }
      return program;
    }

    init() {
      const gl = this.canvas.getContext('webgl2', {
        alpha: false,
        antialias: true,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance',
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
      });
      if (!gl) throw new Error('WebGL2 is not available');
      this.gl = gl;

      // 浮点渲染目标是 GPU 模拟的前提
      if (gl.getExtension('EXT_color_buffer_float')) {
        this.simFormat = gl.RGBA32F;
      } else if (gl.getExtension('EXT_color_buffer_half_float')) {
        this.simFormat = gl.RGBA16F;
      } else {
        throw new Error('No float color-buffer support');
      }

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.BLEND);

      this.simProgram = this.program(SIM_VERT, SIM_FRAG);
      this.renderProgram = this.program(RENDER_VERT, RENDER_FRAG);

      this.simUniforms = {};
      ['uPosition', 'uPosRefs', 'uRingPos', 'uTime', 'uDeltaTime', 'uRingRadius',
        'uRingWidth', 'uRingWidth2', 'uRingDisplacement'].forEach((name) => {
        this.simUniforms[name] = gl.getUniformLocation(this.simProgram, name);
      });
      this.renderUniforms = {};
      ['uPosition', 'uNdcScale', 'uParticleScale', 'uPixelRatio', 'uTime', 'uRingPos',
        'uColor1', 'uColor2', 'uColor3', 'uAlpha', 'uColorScheme'].forEach((name) => {
        this.renderUniforms[name] = gl.getUniformLocation(this.renderProgram, name);
      });

      this.createParticleTextures();
      this.createTargets();
      this.createPointMesh();

      gl.useProgram(this.simProgram);
      gl.uniform1i(this.simUniforms.uPosition, 0);
      gl.uniform1i(this.simUniforms.uPosRefs, 1);
      gl.useProgram(this.renderProgram);
      gl.uniform1i(this.renderUniforms.uPosition, 0);

      this.resize();
      this.ready = true;
      this.observe();
    }

    createFloatTexture(data) {
      const gl = this.gl;
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, this.simFormat, SIM_SIZE, SIM_SIZE, 0,
        gl.RGBA, gl.FLOAT, data || null);
      return texture;
    }

    createParticleTextures() {
      const gl = this.gl;
      this.posTex = this.createFloatTexture(this.posData);
      this.buildParticles();
    }

    buildParticles() {
      const gl = this.gl;
      const density = this.reduced || this.isMobile
        ? Math.min(this.opts.density, 110)
        : this.opts.density;
      const minDist = DENSITY_MIN_DIST(density);
      const maxDist = DENSITY_MAX_DIST(density);
      const tries = this.reduced || this.isMobile ? 12 : 20;
      const points = poissonDisk(500, minDist, maxDist, tries, MAX_PARTICLES);
      this.count = Math.min(points.length / 2, MAX_PARTICLES);

      this.posData.fill(0);
      for (let i = 0; i < this.count; i++) {
        this.posData[i * 4] = (points[i * 2] - 250) / 250;
        this.posData[i * 4 + 1] = (points[i * 2 + 1] - 250) / 250;
      }

      gl.bindTexture(gl.TEXTURE_2D, this.posTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SIM_SIZE, SIM_SIZE, gl.RGBA, gl.FLOAT, this.posData);
    }

    createTarget(index) {
      const gl = this.gl;
      const texture = this.createFloatTexture(null);
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error('Simulation framebuffer incomplete: 0x' + status.toString(16));
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.targets[index] = { texture, framebuffer };
    }

    createTargets() {
      this.targets = [null, null];
      this.createTarget(0);
      this.createTarget(1);
      this.clearTargets();
    }

    clearTargets() {
      const gl = this.gl;
      gl.clearColor(0, 0, 0, 0);
      for (const target of this.targets) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    createPointMesh() {
      const gl = this.gl;
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.uvData, gl.STATIC_DRAW);
      const location = gl.getAttribLocation(this.renderProgram, 'aUv');
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      this.uvBuffer = buffer;
    }

    observe() {
      if ('IntersectionObserver' in window) {
        this.visibilityObserver = new IntersectionObserver((entries) => {
          for (const entry of entries) this.offscreen = !entry.isIntersecting;
        }, { rootMargin: '100px' });
        this.visibilityObserver.observe(this.canvas);
      }
      if ('ResizeObserver' in window) {
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.canvas);
      }
      this.onResize = () => this.resize();
      window.addEventListener('resize', this.onResize, { passive: true });
    }

    /* ---------------- 尺寸 / 布局 ---------------- */
    resize() {
      if (!this.gl) return;
      const gl = this.gl;
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(rect.width * this.dpr));
      const height = Math.max(1, Math.round(rect.height * this.dpr));
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }

      // 与原站一致：PerspectiveCamera(40°, aspect, 0.1, 1000) @ z=3.1，点云 mesh.scale = 5
      const aspect = width / height;
      const k = MESH_SCALE / (HALF_FOV_TAN * CAMERA_Z);
      this.ndcScale = new Float32Array([k / aspect, k]);
      this.particleScale = rect.width / 2000 * this.opts.particlesScale;

      gl.viewport(0, 0, width, height);
    }

    /* ---------------- 每帧更新 ---------------- */
    updatePointer() {
      if (!this.interactive) { this.pointerInside = false; return; }
      const rect = this.canvas.getBoundingClientRect();
      const p = pointer;
      const inside = p.hasMoved &&
        p.x >= rect.left && p.x <= rect.right &&
        p.y >= rect.top && p.y <= rect.bottom;
      this.pointerInside = inside;
      if (!inside) return;

      const width = rect.width || 1;
      const height = rect.height || 1;
      const ndcX = ((p.x - rect.left) / width) * 2 - 1;
      const ndcY = -((p.y - rect.top) / height) * 2 + 1;
      const halfH = HALF_FOV_TAN * CAMERA_Z;
      const halfW = halfH * (width / height);
      this.intersection[0] = ndcX * halfW;
      this.intersection[1] = ndcY * halfH;
    }

    updateTarget() {
      const t = this.time;
      // 空闲漂移（两个不同频率/相位的值噪声）
      const nx = (this.noiseX.getVal(t * 0.66 + 94.234) - 0.5) * 2;
      const ny = (this.noiseY.getVal(t * 0.75 + 21.028) - 0.5) * 2;
      const ring = this.ringPos;
      const cursor = this.cursorPos;

      if (this.pointerInside) {
        cursor[0] = this.intersection[0] * 0.175 + nx * 0.1;
        cursor[1] = this.intersection[1] * 0.175 + ny * 0.1;
        ring[0] += (cursor[0] - ring[0]) * 0.02;
        ring[1] += (cursor[1] - ring[1]) * 0.02;
      } else {
        cursor[0] = nx * 0.2;
        cursor[1] = ny * 0.1;
        ring[0] += (cursor[0] - ring[0]) * 0.01;
        ring[1] += (cursor[1] - ring[1]) * 0.01;
      }

      return 0.175 + Math.sin(t) * 0.03 + Math.cos(t * 3) * 0.02;
    }

    simulate(dt, ringRadius) {
      const gl = this.gl;
      const sim = this.simProgram;
      const u = this.simUniforms;
      const readTexture = this.everRendered ? this.targets[0].texture : this.posTex;
      const writeTarget = this.targets[1];

      gl.bindFramebuffer(gl.FRAMEBUFFER, writeTarget.framebuffer);
      gl.viewport(0, 0, SIM_SIZE, SIM_SIZE);
      gl.disable(gl.BLEND);
      gl.useProgram(sim);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, readTexture);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.posTex);
      gl.activeTexture(gl.TEXTURE0);

      gl.uniform2fv(u.uRingPos, this.ringPos);
      gl.uniform1f(u.uTime, this.time);
      gl.uniform1f(u.uDeltaTime, dt);
      gl.uniform1f(u.uRingRadius, ringRadius);
      gl.uniform1f(u.uRingWidth, this.opts.ringWidth);
      gl.uniform1f(u.uRingWidth2, this.opts.ringWidth2);
      gl.uniform1f(u.uRingDisplacement, this.opts.ringDisplacement);

      gl.bindVertexArray(null);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    draw() {
      const gl = this.gl;
      const r = this.renderUniforms;
      const latest = this.targets[1];

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(this.palette.background[0], this.palette.background[1], this.palette.background[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.renderProgram);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, latest.texture);

      gl.uniform2fv(r.uNdcScale, this.ndcScale);
      gl.uniform1f(r.uParticleScale, this.particleScale);
      gl.uniform1f(r.uPixelRatio, this.dpr);
      gl.uniform1f(r.uTime, this.time);
      gl.uniform2fv(r.uRingPos, this.ringPos);
      gl.uniform3fv(r.uColor1, this.palette.colors[0]);
      gl.uniform3fv(r.uColor2, this.palette.colors[1]);
      gl.uniform3fv(r.uColor3, this.palette.colors[2]);
      gl.uniform1f(r.uAlpha, 1);
      gl.uniform1i(r.uColorScheme, this.palette.colorScheme);

      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.POINTS, 0, this.count);
      gl.bindVertexArray(null);

      // ping-pong 交换
      const swap = this.targets[0];
      this.targets[0] = this.targets[1];
      this.targets[1] = swap;
      this.everRendered = true;
    }

    frame(dt) {
      if (!this.ready || this.offscreen) return;

      // 移动端 / 低性能模式隔帧更新（与原站一致）
      if ((this.isMobile || this.reduced) && this.everRendered) {
        this.frameSkip = !this.frameSkip;
        if (this.frameSkip) return;
      }

      this.time += dt;
      this.updatePointer();
      const ringRadius = this.updateTarget();
      this.simulate(dt, ringRadius);
      this.draw();
    }

    setDensity(value) {
      if (!this.ready || value === this.opts.density) return;
      this.opts.density = value;
      this.buildParticles();
      this.clearTargets();
      this.everRendered = false;
      this.time = 0;
    }

    resetParams() {
      this.opts = { ...this.defaults };
      if (!this.ready) return;
      this.buildParticles();
      this.resetSimulation();
    }

    resetSimulation() {
      if (!this.ready) return;
      this.clearTargets();
      this.everRendered = false;
      this.time = 0;
    }
  }

