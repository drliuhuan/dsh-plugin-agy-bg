(function () {
  'use strict';

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
  const NOISE_GLSL = `// MATHS
  vec3 permute(vec3 x) { return mod(((x*34.0)+1.0)*x, 289.0); }
  vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x, 289.0);}
  float permute(float x){return floor(mod(((x*34.0)+1.0)*x, 289.0));}

  vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
  float taylorInvSqrt(float r){return 1.79284291400159 - 0.85373472095314 * r;}

  // SIMPLEX NOISES
  // Simplex 2D noise
  //
  float snoise(vec2 v){
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
            -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy) );
    vec2 x0 = v -   i + dot(i, C.xx);
    vec2 i1;
    i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod(i, 289.0);
    vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 ))
    + i.x + vec3(0.0, i1.x, 1.0 ));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy),
      dot(x12.zw,x12.zw)), 0.0);
    m = m*m ;
    m = m*m ;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * ( a0*a0 + h*h );
    vec3 g;
    g.x  = a0.x  * x0.x  + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

  //	Simplex 3D Noise
  //	by Ian McEwan, Ashima Arts
  //
  float snoise(vec3 v){
    const vec2  C = vec2(1.0/6.0, 1.0/3.0) ;
    const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);

  // First corner
    vec3 i  = floor(v + dot(v, C.yyy) );
    vec3 x0 =   v - i + dot(i, C.xxx) ;

  // Other corners
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min( g.xyz, l.zxy );
    vec3 i2 = max( g.xyz, l.zxy );

    //  x0 = x0 - 0. + 0.0 * C
    vec3 x1 = x0 - i1 + 1.0 * C.xxx;
    vec3 x2 = x0 - i2 + 2.0 * C.xxx;
    vec3 x3 = x0 - 1. + 3.0 * C.xxx;

  // Permutations
    i = mod(i, 289.0 );
    vec4 p = permute( permute( permute(
              i.z + vec4(0.0, i1.z, i2.z, 1.0 ))
            + i.y + vec4(0.0, i1.y, i2.y, 1.0 ))
            + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));

  // Gradients
  // ( N*N points uniformly over a square, mapped onto an octahedron.)
    float n_ = 1.0/7.0; // N=7
    vec3  ns = n_ * D.wyz - D.xzx;

    vec4 j = p - 49.0 * floor(p * ns.z *ns.z);  //  mod(p,N*N)

    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_ );    // mod(j,N)

    vec4 x = x_ *ns.x + ns.yyyy;
    vec4 y = y_ *ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);

    vec4 b0 = vec4( x.xy, y.xy );
    vec4 b1 = vec4( x.zw, y.zw );

    vec4 s0 = floor(b0)*2.0 + 1.0;
    vec4 s1 = floor(b1)*2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));

    vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy ;
    vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww ;

    vec3 p0 = vec3(a0.xy,h.x);
    vec3 p1 = vec3(a0.zw,h.y);
    vec3 p2 = vec3(a1.xy,h.z);
    vec3 p3 = vec3(a1.zw,h.w);

  //Normalise gradients
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
    p0 *= norm.x;
    p1 *= norm.y;
    p2 *= norm.z;
    p3 *= norm.w;

  // Mix final noise value
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1),
                                  dot(p2,x2), dot(p3,x3) ) );
  }


  //	Simplex 4D Noise
  //	by Ian McEwan, Ashima Arts
  //
  vec4 grad4(float j, vec4 ip){
    const vec4 ones = vec4(1.0, 1.0, 1.0, -1.0);
    vec4 p,s;

    p.xyz = floor( fract (vec3(j) * ip.xyz) * 7.0) * ip.z - 1.0;
    p.w = 1.5 - dot(abs(p.xyz), ones.xyz);
    s = vec4(lessThan(p, vec4(0.0)));
    p.xyz = p.xyz + (s.xyz*2.0 - 1.0) * s.www;

    return p;
  }

  float snoise(vec4 v){
    const vec2  C = vec2( 0.138196601125010504,  // (5 - sqrt(5))/20  G4
                          0.309016994374947451); // (sqrt(5) - 1)/4   F4
  // First corner
    vec4 i  = floor(v + dot(v, C.yyyy) );
    vec4 x0 = v -   i + dot(i, C.xxxx);

  // Other corners

  // Rank sorting originally contributed by Bill Licea-Kane, AMD (formerly ATI)
    vec4 i0;

    vec3 isX = step( x0.yzw, x0.xxx );
    vec3 isYZ = step( x0.zww, x0.yyz );
  //  i0.x = dot( isX, vec3( 1.0 ) );
    i0.x = isX.x + isX.y + isX.z;
    i0.yzw = 1.0 - isX;

  //  i0.y += dot( isYZ.xy, vec2( 1.0 ) );
    i0.y += isYZ.x + isYZ.y;
    i0.zw += 1.0 - isYZ.xy;

    i0.z += isYZ.z;
    i0.w += 1.0 - isYZ.z;

    // i0 now contains the unique values 0,1,2,3 in each channel
    vec4 i3 = clamp( i0, 0.0, 1.0 );
    vec4 i2 = clamp( i0-1.0, 0.0, 1.0 );
    vec4 i1 = clamp( i0-2.0, 0.0, 1.0 );

    //  x0 = x0 - 0.0 + 0.0 * C
    vec4 x1 = x0 - i1 + 1.0 * C.xxxx;
    vec4 x2 = x0 - i2 + 2.0 * C.xxxx;
    vec4 x3 = x0 - i3 + 3.0 * C.xxxx;
    vec4 x4 = x0 - 1.0 + 4.0 * C.xxxx;

  // Permutations
    i = mod(i, 289.0);
    float j0 = permute( permute( permute( permute(i.w) + i.z) + i.y) + i.x);
    vec4 j1 = permute( permute( permute( permute (
              i.w + vec4(i1.w, i2.w, i3.w, 1.0 ))
            + i.z + vec4(i1.z, i2.z, i3.z, 1.0 ))
            + i.y + vec4(i1.y, i2.y, i3.y, 1.0 ))
            + i.x + vec4(i1.x, i2.x, i3.x, 1.0 ));
  // Gradients
  // ( 7*7*6 points uniformly over a cube, mapped onto a 4-octahedron.)
  // 7*7*6 = 294, which is close to the ring size 17*17 = 289.

    vec4 ip = vec4(1.0/294.0, 1.0/49.0, 1.0/7.0, 0.0) ;

    vec4 p0 = grad4(j0,   ip);
    vec4 p1 = grad4(j1.x, ip);
    vec4 p2 = grad4(j1.y, ip);
    vec4 p3 = grad4(j1.z, ip);
    vec4 p4 = grad4(j1.w, ip);

  // Normalise gradients
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
    p0 *= norm.x;
    p1 *= norm.y;
    p2 *= norm.z;
    p3 *= norm.w;
    p4 *= taylorInvSqrt(dot(p4,p4));

  // Mix contributions from the five corners
    vec3 m0 = max(0.6 - vec3(dot(x0,x0), dot(x1,x1), dot(x2,x2)), 0.0);
    vec2 m1 = max(0.6 - vec2(dot(x3,x3), dot(x4,x4)            ), 0.0);
    m0 = m0 * m0;
    m1 = m1 * m1;
    return 49.0 * ( dot(m0*m0, vec3( dot( p0, x0 ), dot( p1, x1 ), dot( p2, x2 )))
                + dot(m1*m1, vec2( dot( p3, x3 ), dot( p4, x4 ) ) ) ) ;

  }`;

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
        preserveDrawingBuffer: false,
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



/* ------------------------------------------------------------------
   DSH Web UI glue.

   The particle engine above is the same one shipped in `antigravity-bg/`.
   This half integrates it with the Harness shell:

     * a fixed canvas behind the app window (z-index -1);
     * the shell's fully-opaque page surfaces are tagged so the canvas can
       show through them, while the sidebar, composer, cards and dialogs keep
       their own backgrounds;
     * a Settings → General switch that turns the whole thing on/off
       (persisted in localStorage, default on);
     * light/dark palettes follow the shell's `body[data-ds-dark-theme]`.
   ------------------------------------------------------------------ */

  var PLUGIN_ID = 'dsh-plugin-antigravity-bg';
  var STORAGE_KEY = 'dsh-plugin-antigravity-bg:v1';
  var LOCALE_NS = 'antigravity-bg';
  var SURFACE_ATTR = 'data-dsh-antigravity-surface';
  var FADE_ATTR = 'data-dsh-antigravity-fade';
  var CANVAS_ID = 'dsh-antigravity-canvas';
  var STYLE_ID = 'dsh-antigravity-style';

  /** React runtime handed to the factory by the harness module loader. */
  var React = null;
  /** Locale face captured on apply, used to re-render the switch copy. */
  var localeFace = null;
  /** The live background manager (one per plugin load). */
  var background = null;

  var EN = {
    title: 'Antigravity particle background',
    description: 'A mouse-following WebGL particle field behind the interface, recreated from antigravity.google. The ring follows your cursor; turn it off here for a plain background.',
    on: 'Particle background on',
    off: 'Particle background off',
    switchOn: 'Turn particle background off',
    switchOff: 'Turn particle background on'
  };

  var ZH = {
    title: 'Antigravity 粒子背景',
    description: '在界面背后铺一层跟随鼠标的 WebGL 粒子场，复刻自 antigravity.google。粒子环会跟着光标走；不想要时在这里关掉，恢复纯色背景。',
    on: '粒子背景已开启',
    off: '粒子背景已关闭',
    switchOn: '关闭粒子背景',
    switchOff: '开启粒子背景'
  };

  /* ---------------- preference state ---------------- */

  function readPreference() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return { enabled: true };
      var parsed = JSON.parse(raw);
      return { enabled: parsed.enabled !== false };
    } catch (err) {
      return { enabled: true };
    }
  }

  function writePreference(preference) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preference));
    } catch (err) {
      // A private-mode browser without storage still gets a working toggle.
    }
  }

  var preference = readPreference();
  var preferenceListeners = new Set();

  function getPreferenceEnabled() {
    return preference.enabled;
  }

  function setPreferenceEnabled(value) {
    var next = value !== false;
    if (preference.enabled === next) return;
    preference = { enabled: next };
    writePreference(preference);
    preferenceListeners.forEach(function (listener) {
      try { listener(); } catch (err) { /* keep other subscribers alive */ }
    });
    if (background) background.setEnabled(next);
  }

  function subscribePreference(listener) {
    preferenceListeners.add(listener);
    return function () { preferenceListeners.delete(listener); };
  }

  /* ---------------- color / theme helpers ---------------- */

  function parseRgb(value) {
    if (typeof value !== 'string') return null;
    var match = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  }

  function sameRgb(a, b) {
    if (!a || !b) return false;
    return Math.abs(a[0] - b[0]) < 2 && Math.abs(a[1] - b[1]) < 2 && Math.abs(a[2] - b[2]) < 2;
  }

  function themeName() {
    return document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light';
  }

  /** Resolve the shell's current `--dsw-alias-bg-base` to an rgb() string. */
  function readBaseColor() {
    var probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;background:var(--dsw-alias-bg-base)';
    document.body.appendChild(probe);
    var color = window.getComputedStyle(probe).backgroundColor;
    probe.remove();
    if (!parseRgb(color)) color = window.getComputedStyle(document.body).backgroundColor;
    return color;
  }

  /** The shell frame (the full-window grid that owns the sidebar and center). */
  function findShellFrame() {
    var candidates = document.querySelectorAll('[class*="_frame"]');
    var width = window.innerWidth;
    var height = window.innerHeight;
    var best = null;
    var bestArea = 0;
    for (var i = 0; i < candidates.length; i++) {
      var element = candidates[i];
      var rect = element.getBoundingClientRect();
      if (rect.width < width * 0.98 || rect.height < height * 0.9) continue;
      var area = rect.width * rect.height;
      if (area > bestArea) {
        best = element;
        bestArea = area;
      }
    }
    return best;
  }

  /* ---------------- background manager ---------------- */

  var CANVAS_CSS = [
    '#dsh-antigravity-canvas{position:fixed;inset:0;display:block;width:100%;height:100%;',
    'z-index:-1;pointer-events:none;opacity:0;transition:opacity .5s ease}',
    '#dsh-antigravity-canvas[data-visible="true"]{opacity:.94}',
    // Tagged by the manager: only full-page surfaces lose their fill, so the
    // particle field shows through the workspace while every control keeps its
    // own background.
    '[data-dsh-antigravity-surface="transparent"]{background-color:transparent !important;',
    'background-image:none !important}',
    // The shell paints a 36px gradient above the composer so scrolled content
    // fades into the page background. With a particle field behind the page that
    // gradient reads as a solid band, so the tag removes it.
    '[data-dsh-antigravity-fade="off"]{background-image:none !important}',
    '[data-dsh-antigravity-fade="off"]::before,[data-dsh-antigravity-fade="off"]::after{',
    'background-image:none !important}'
  ].join('');

  var ROW_CSS = [
    '.abg_row{display:flex;align-items:center;gap:8px;padding:16px 0;',
    'border-bottom:.5px solid var(--dsw-alias-border-l2)}',
    '.abg_text{display:flex;flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px}',
    '.abg_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
    '.abg_desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}',
    '.abg_switch{position:relative;flex:0 0 auto;width:40px;height:22px;padding:0;border:none;',
    'border-radius:999px;background:var(--dsw-alias-bg-layer-3);',
    'box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2);cursor:pointer;',
    'transition:background .18s ease}',
    '.abg_switch[data-on="true"]{background:var(--dsw-alias-state-business-primary);',
    'box-shadow:none}',
    '.abg_switch:focus-visible{outline:2px solid var(--dsw-focus-ring-color,',
    'var(--dsw-alias-state-business-primary));outline-offset:2px}',
    '.abg_knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;',
    'background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .18s ease}',
    '.abg_switch[data-on="true"] .abg_knob{transform:translateX(18px)}'
  ].join('');

  function createBackground() {
    var canvas = null;
    var field = null;
    var marked = [];
    var faded = [];
    var styleElement = null;
    var frameId = 0;
    var lastTime = 0;
    var scanTimer = 0;
    var scanDebounce = 0;
    var themeObserver = null;
    var active = false;

    function loop(now) {
      if (!active) return;
      frameId = window.requestAnimationFrame(loop);
      if (!field || !field.ready || document.hidden) return;
      var dt = Math.min(Math.max((now - lastTime) / 1000, 0), 0.1);
      lastTime = now;
      field.frame(dt);
    }

    function mark(element) {
      if (!element || element.hasAttribute(SURFACE_ATTR)) return;
      element.setAttribute(SURFACE_ATTR, 'transparent');
      marked.push(element);
    }

    function markFade(element) {
      if (!element || element.hasAttribute(FADE_ATTR)) return;
      element.setAttribute(FADE_ATTR, 'off');
      faded.push(element);
    }

    /**
     * The composer sits on a `.composerSeat` layer that fades scrolled content
     * into the page background with a short linear gradient. Tag that layer (and
     * any gradient ancestor of the composer input) so the canvas stays visible
     * right up to the input box.
     */
    function syncComposerFade() {
      if (!active) return;
      var center = document.querySelector('[class*="_centerCol"]');
      if (!center) return;

      var seats = center.querySelectorAll('[class*="_composerSeat"]');
      for (var i = 0; i < seats.length; i++) markFade(seats[i]);

      var input = center.querySelector('textarea, [contenteditable="true"], input[type="text"]');
      var node = input;
      var guard = 0;
      while (node && node !== center && guard < 12) {
        var self = window.getComputedStyle(node).backgroundImage;
        var before = window.getComputedStyle(node, '::before').backgroundImage;
        var after = window.getComputedStyle(node, '::after').backgroundImage;
        if ((self && self !== 'none') || (before && before !== 'none') || (after && after !== 'none')) {
          markFade(node);
        }
        node = node.parentElement;
        guard++;
      }
    }

    /**
     * Tag the shell frame plus every large page surface in the center column
     * whose fill is exactly the theme base color. The size thresholds leave the
     * composer, cards, and side panels opaque.
     */
    function syncSurfaces() {
      if (!active || !field || !field.ready) return;
      var base = parseRgb(readBaseColor());
      mark(findShellFrame());

      var center = document.querySelector('[class*="_centerCol"]');
      if (!center || !base) return;
      var centerRect = center.getBoundingClientRect();
      if (centerRect.width <= 0 || centerRect.height <= 0) return;

      syncComposerFade();

      // On Windows the shell paints `--dsw-alias-bg-base` on the center column
      // itself (`[data-windows-titlebar] .mP3x-q_centerCol`). That element is a
      // direct child of the frame, not a descendant, so the scan below never
      // reached it: the whole workspace stayed opaque and the canvas only leaked
      // through the column's rounded top-left corner. Tag it as well.
      if (sameRgb(parseRgb(window.getComputedStyle(center).backgroundColor), base)) {
        mark(center);
      }

      var nodes = center.querySelectorAll('*');
      for (var i = 0; i < nodes.length; i++) {
        var element = nodes[i];
        if (element.hasAttribute(SURFACE_ATTR)) continue;
        var style = window.getComputedStyle(element);
        if (!sameRgb(parseRgb(style.backgroundColor), base)) continue;
        var rect = element.getBoundingClientRect();
        if (rect.width < centerRect.width * 0.85) continue;
        if (rect.height < centerRect.height * 0.5) continue;
        mark(element);
      }
    }

    function scheduleScan() {
      if (!active || scanDebounce) return;
      scanDebounce = window.setTimeout(function () {
        scanDebounce = 0;
        syncSurfaces();
      }, 320);
    }

    function syncPalette() {
      if (!field) return;
      var next = THEMES[themeName()];
      if (field.palette !== next) field.palette = next;
    }

    function onResize() {
      if (!field) return;
      field.resize();
      scheduleScan();
    }

    function onVisibilityChange() {
      lastTime = performance.now();
    }

    function onThemeMutation() {
      if (!active) return;
      syncPalette();
      scheduleScan();
    }

    function start() {
      if (active) return;

      styleElement = document.createElement('style');
      styleElement.id = STYLE_ID;
      styleElement.textContent = CANVAS_CSS;
      document.head.appendChild(styleElement);

      canvas = document.createElement('canvas');
      canvas.id = CANVAS_ID;
      canvas.setAttribute('aria-hidden', 'true');
      document.body.insertBefore(canvas, document.body.firstChild);

      field = new ParticleField(canvas, {
        theme: themeName(),
        // Same configuration as antigravity.google's hero section.
        density: 230,
        particlesScale: 0.59,
        ringWidth: 0.006,
        ringWidth2: 0.107,
        ringDisplacement: 0.62
      });

      if (!field.ready) {
        stop();
        return;
      }

      active = true;
      syncSurfaces();
      syncPalette();

      window.addEventListener('resize', onResize);
      window.addEventListener('click', scheduleScan, { passive: true });
      document.addEventListener('visibilitychange', onVisibilityChange);

      if (typeof MutationObserver === 'function') {
        themeObserver = new MutationObserver(onThemeMutation);
        themeObserver.observe(document.body, {
          attributes: true,
          attributeFilter: ['data-ds-dark-theme']
        });
      }

      // Page surfaces can be replaced by client-side navigation; a cheap scan
      // every couple of seconds keeps the transparency tags on the right
      // elements without observing every DOM mutation.
      scanTimer = window.setInterval(syncSurfaces, 2000);

      lastTime = performance.now();
      frameId = window.requestAnimationFrame(loop);
      window.requestAnimationFrame(function () {
        if (canvas) canvas.setAttribute('data-visible', 'true');
      });
    }

    function stop() {
      active = false;
      if (frameId) {
        window.cancelAnimationFrame(frameId);
        frameId = 0;
      }
      if (scanTimer) {
        window.clearInterval(scanTimer);
        scanTimer = 0;
      }
      if (scanDebounce) {
        window.clearTimeout(scanDebounce);
        scanDebounce = 0;
      }
      window.removeEventListener('resize', onResize);
      window.removeEventListener('click', scheduleScan);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (themeObserver) {
        themeObserver.disconnect();
        themeObserver = null;
      }
      for (var i = 0; i < marked.length; i++) {
        try { marked[i].removeAttribute(SURFACE_ATTR); } catch (err) { /* detached */ }
      }
      marked = [];
      for (var j = 0; j < faded.length; j++) {
        try { faded[j].removeAttribute(FADE_ATTR); } catch (err) { /* detached */ }
      }
      faded = [];
      if (field && typeof field.dispose === 'function') field.dispose();
      field = null;
      if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
      canvas = null;
      if (styleElement && styleElement.parentNode) styleElement.parentNode.removeChild(styleElement);
      styleElement = null;
    }

    var api = {
      setEnabled: function (value) {
        if (value) start();
        else stop();
      },
      dispose: function () {
        stop();
        if (window.__DSH_ANTIGRAVITY_BG__ === api) delete window.__DSH_ANTIGRAVITY_BG__;
      },
      get active() { return active; }
    };
    return api;
  }

  /* ---------------- Settings row ---------------- */

  function fallbackTranslate(key) {
    return EN[key] || key;
  }

  function usePreference() {
    var state = React.useState(getPreferenceEnabled());
    var setValue = state[1];
    React.useEffect(function () {
      return subscribePreference(function () { setValue(getPreferenceEnabled()); });
    }, []);
    return state[0];
  }

  function useLocaleTick() {
    var bump = React.useState(0)[1];
    React.useEffect(function () {
      if (!localeFace || typeof localeFace.subscribe !== 'function') return undefined;
      return localeFace.subscribe(function () { bump(function (value) { return value + 1; }); });
    }, []);
  }

  function AntigravityRow(props) {
    var translate = typeof props.t === 'function' ? props.t : fallbackTranslate;
    var enabled = usePreference();
    useLocaleTick();

    return React.createElement(
      React.Fragment,
      null,
      React.createElement('style', {
        key: 'style',
        dangerouslySetInnerHTML: { __html: ROW_CSS }
      }),
      React.createElement(
        'div',
        { key: 'row', className: 'abg_row' },
        React.createElement(
          'div',
          { className: 'abg_text' },
          React.createElement('div', {
            className: 'abg_title',
            children: translate('title')
          }),
          React.createElement('div', {
            className: 'abg_desc',
            children: translate('description')
          })
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            role: 'switch',
            className: 'abg_switch',
            'data-on': enabled ? 'true' : 'false',
            'aria-checked': enabled ? 'true' : 'false',
            'aria-label': translate(enabled ? 'switchOn' : 'switchOff'),
            title: translate(enabled ? 'switchOn' : 'switchOff'),
            onClick: function () { setPreferenceEnabled(!enabled); }
          },
          React.createElement('span', { className: 'abg_knob' })
        )
      )
    );
  }

  /* ---------------- module loading ---------------- */

  if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load({
      id: PLUGIN_ID,
      factory: function (require) {
        React = require('react');
        return {
          inject: ['slots', 'locale'],
          apply: function (ctx) {
            // HMR can reload this bundle without running the previous copy's
            // teardown; drop the old manager before replacing it.
            var previous = window.__DSH_ANTIGRAVITY_BG__;
            if (previous && typeof previous.dispose === 'function') {
              try { previous.dispose(); } catch (err) { /* already gone */ }
            }

            background = createBackground();
            window.__DSH_ANTIGRAVITY_BG__ = background;
            if (getPreferenceEnabled()) background.setEnabled(true);

            localeFace = ctx.locale;

            ctx.effect(function () {
              return function () {
                if (background) {
                  background.dispose();
                  background = null;
                }
              };
            }, PLUGIN_ID + ': background');

            ctx.effect(function () {
              return ctx.locale.register(LOCALE_NS, 'en', EN);
            }, PLUGIN_ID + ': en dictionary');

            ctx.effect(function () {
              return ctx.locale.register(LOCALE_NS, 'zh', ZH);
            }, PLUGIN_ID + ': zh dictionary');

            ctx.slots.inject('settings.general.item', function () {
              return ctx.slots.register({
                name: 'settings.general.item',
                id: 'antigravity-bg',
                order: 14,
                locale: LOCALE_NS
              }, AntigravityRow);
            });
          }
        };
      }
    });
  }

})();
