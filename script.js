(function () {
  const CONFIG = {
    SIM_RESOLUTION: 128,
    DYE_RESOLUTION: 1440,
    CAPTURE_RESOLUTION: 512,
    DENSITY_DISSIPATION: 3.5,
    VELOCITY_DISSIPATION: 2,
    PRESSURE: 0.1,
    PRESSURE_ITERATIONS: 20,
    CURL: 3,
    SPLAT_RADIUS: 0.2,
    SPLAT_FORCE: 6000,
    SHADING: true,
    COLOR_UPDATE_SPEED: 10,
    BACK_COLOR: { r: 0.5, g: 0, b: 0 },
    TRANSPARENT: true,
    PAUSED: false,
  };

  const canvas = document.getElementById("splash");
  if (!canvas) return;

  class Pointer {
    constructor() {
      this.id = -1;
      this.texcoordX =
        this.texcoordY =
        this.prevTexcoordX =
        this.prevTexcoordY =
        this.deltaX =
        this.deltaY =
          0;
      this.down = this.moved = false;
      this.color = { r: 0, g: 0, b: 0 };
    }
  }
  const pointers = [new Pointer()];

  function supportRenderTextureFormat(gl, internalFormat, format, type) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      internalFormat,
      4,
      4,
      0,
      format,
      type,
      null,
    );

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    return (
      gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
    );
  }

  function getSupportedFormat(gl, internalFormat, format, type) {
    if (!supportRenderTextureFormat(gl, internalFormat, format, type)) {
      if (internalFormat === gl.R16F)
        return getSupportedFormat(gl, gl.RG16F, gl.RG, type);
      if (internalFormat === gl.RG16F)
        return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
      return null;
    }
    return { internalFormat, format };
  }

  function getWebGLContext(canvas) {
    const params = {
      alpha: true,
      depth: false,
      stencil: false,
      antialias: false,
      preserveDrawingBuffer: false,
    };
    let gl = canvas.getContext("webgl2", params);
    const isWebGL2 = !!gl;
    if (!isWebGL2)
      gl =
        canvas.getContext("webgl", params) ||
        canvas.getContext("experimental-webgl", params);

    if (!gl) return { gl: null, ext: null };

    const halfFloat = isWebGL2
      ? null
      : gl.getExtension("OES_texture_half_float");
    const supportLinearFiltering = gl.getExtension(
      isWebGL2 ? "OES_texture_float_linear" : "OES_texture_half_float_linear",
    );
    if (isWebGL2) gl.getExtension("EXT_color_buffer_float");

    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    const halfFloatTexType = isWebGL2
      ? gl.HALF_FLOAT
      : halfFloat?.HALF_FLOAT_OES;

    return {
      gl,
      ext: {
        formatRGBA: getSupportedFormat(
          gl,
          isWebGL2 ? gl.RGBA16F : gl.RGBA,
          gl.RGBA,
          halfFloatTexType,
        ),
        formatRG: getSupportedFormat(
          gl,
          isWebGL2 ? gl.RG16F : gl.RG,
          isWebGL2 ? gl.RG : gl.RGBA,
          halfFloatTexType,
        ),
        formatR: getSupportedFormat(
          gl,
          isWebGL2 ? gl.R16F : gl.RED,
          isWebGL2 ? gl.RED : gl.RGBA,
          halfFloatTexType,
        ),
        halfFloatTexType,
        supportLinearFiltering,
      },
    };
  }

  const { gl, ext } = getWebGLContext(canvas);
  if (!gl) {
    console.warn("WebGL not supported in this browser.");
    return;
  }
  if (!ext.supportLinearFiltering) {
    CONFIG.DYE_RESOLUTION = 256;
    CONFIG.SHADING = false;
  }

  function compileShader(type, source, keywords = null) {
    if (keywords) {
      source = keywords.map((k) => `#define ${k}\n`).join("") + source;
    }
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      console.trace(gl.getShaderInfoLog(shader));
    return shader;
  }

  function createProgram(vertexShader, fragmentShader) {
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      console.trace(gl.getProgramInfoLog(program));
    return program;
  }

  function getUniforms(program) {
    const uniforms = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const name = gl.getActiveUniform(program, i).name;
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    return uniforms;
  }

  class Material {
    constructor(vertexShader, fragmentShaderSource) {
      this.vertexShader = vertexShader;
      this.fragmentShaderSource = fragmentShaderSource;
      this.programs = {};
      this.activeProgram = null;
      this.uniforms = {};
    }
    setKeywords(keywords) {
      const hash = keywords.join(",");
      if (!this.programs[hash]) {
        const frag = compileShader(
          gl.FRAGMENT_SHADER,
          this.fragmentShaderSource,
          keywords,
        );
        this.programs[hash] = createProgram(this.vertexShader, frag);
      }
      if (this.programs[hash] === this.activeProgram) return;
      this.activeProgram = this.programs[hash];
      this.uniforms = getUniforms(this.activeProgram);
    }
    bind() {
      gl.useProgram(this.activeProgram);
    }
  }

  class Program {
    constructor(vertexShader, fragmentShader) {
      this.program = createProgram(vertexShader, fragmentShader);
      this.uniforms = getUniforms(this.program);
    }
    bind() {
      gl.useProgram(this.program);
    }
  }

  const baseVertexShader = compileShader(
    gl.VERTEX_SHADER,
    `
    precision highp float;
    attribute vec2 aPosition;
    varying vec2 vUv, vL, vR, vT, vB;
    uniform vec2 texelSize;
    void main () {
      vUv = aPosition * 0.5 + 0.5;
      vL = vUv - vec2(texelSize.x, 0.0);
      vR = vUv + vec2(texelSize.x, 0.0);
      vT = vUv + vec2(0.0, texelSize.y);
      vB = vUv - vec2(0.0, texelSize.y);
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `,
  );

  const copyShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision mediump float;
    varying highp vec2 vUv;
    uniform sampler2D uTexture;
    void main () { gl_FragColor = texture2D(uTexture, vUv); }
  `,
  );

  const clearShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision mediump float;
    varying highp vec2 vUv;
    uniform sampler2D uTexture;
    uniform float value;
    void main () { gl_FragColor = value * texture2D(uTexture, vUv); }
  `,
  );

  const displayShaderSource = `
    precision highp float;
    precision highp sampler2D;
    varying vec2 vUv, vL, vR, vT, vB;
    uniform sampler2D uTexture;
    uniform vec2 texelSize;
    void main () {
      vec3 c = texture2D(uTexture, vUv).rgb;
      #ifdef SHADING
        float dx = length(texture2D(uTexture, vR).rgb) - length(texture2D(uTexture, vL).rgb);
        float dy = length(texture2D(uTexture, vT).rgb) - length(texture2D(uTexture, vB).rgb);
        vec3 n = normalize(vec3(dx, dy, length(texelSize)));
        c *= clamp(dot(n, vec3(0.0, 0.0, 1.0)) + 0.7, 0.7, 1.0);
      #endif
      gl_FragColor = vec4(c, max(c.r, max(c.g, c.b)));
    }
  `;

  const splatShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uTarget;
    uniform float aspectRatio, radius;
    uniform vec3 color;
    uniform vec2 point;
    void main () {
      vec2 p = vUv - point.xy;
      p.x *= aspectRatio;
      vec3 splat = exp(-dot(p, p) / radius) * color;
      gl_FragColor = vec4(texture2D(uTarget, vUv).xyz + splat, 1.0);
    }
  `,
  );

  const advectionShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision highp float;
    precision highp sampler2D;
    varying vec2 vUv;
    uniform sampler2D uVelocity, uSource;
    uniform vec2 texelSize, dyeTexelSize;
    uniform float dt, dissipation;
    vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
      vec2 st = uv / tsize - 0.5;
      vec2 iuv = floor(st), fuv = fract(st);
      vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
      vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
      vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
      vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
      return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
    }
    void main () {
      #ifdef MANUAL_FILTERING
        vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
        vec4 result = bilerp(uSource, coord, dyeTexelSize);
      #else
        vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
        vec4 result = texture2D(uSource, coord);
      #endif
      gl_FragColor = result / (1.0 + dissipation * dt);
    }
  `,
    ext.supportLinearFiltering ? null : ["MANUAL_FILTERING"],
  );

  const divergenceShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision mediump float;
    varying highp vec2 vUv, vL, vR, vT, vB;
    uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uVelocity, vL).x, R = texture2D(uVelocity, vR).x;
      float T = texture2D(uVelocity, vT).y, B = texture2D(uVelocity, vB).y;
      vec2 C = texture2D(uVelocity, vUv).xy;
      if (vL.x < 0.0) L = -C.x; if (vR.x > 1.0) R = -C.x;
      if (vT.y > 1.0) T = -C.y; if (vB.y < 0.0) B = -C.y;
      gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
    }
  `,
  );

  const curlShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision mediump float;
    varying highp vec2 vL, vR, vT, vB;
    uniform sampler2D uVelocity;
    void main () {
      gl_FragColor = vec4(0.5 * (texture2D(uVelocity, vR).y - texture2D(uVelocity, vL).y - texture2D(uVelocity, vT).x + texture2D(uVelocity, vB).x), 0.0, 0.0, 1.0);
    }
  `,
  );

  const vorticityShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision highp float;
    varying vec2 vUv, vL, vR, vT, vB;
    uniform sampler2D uVelocity, uCurl;
    uniform float curl, dt;
    void main () {
      float L = texture2D(uCurl, vL).x, R = texture2D(uCurl, vR).x;
      float T = texture2D(uCurl, vT).x, B = texture2D(uCurl, vB).x;
      vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
      force = (force / (length(force) + 0.0001)) * curl * texture2D(uCurl, vUv).x;
      force.y *= -1.0;
      gl_FragColor = vec4(min(max(texture2D(uVelocity, vUv).xy + force * dt, -1000.0), 1000.0), 0.0, 1.0);
    }
  `,
  );

  const pressureShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision mediump float;
    varying highp vec2 vUv, vL, vR, vT, vB;
    uniform sampler2D uPressure, uDivergence;
    void main () {
      float L = texture2D(uPressure, vL).x, R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x, B = texture2D(uPressure, vB).x;
      gl_FragColor = vec4((L + R + B + T - texture2D(uDivergence, vUv).x) * 0.25, 0.0, 0.0, 1.0);
    }
  `,
  );

  const gradientSubtractShader = compileShader(
    gl.FRAGMENT_SHADER,
    `
    precision mediump float;
    varying highp vec2 vUv, vL, vR, vT, vB;
    uniform sampler2D uPressure, uVelocity;
    void main () {
      float L = texture2D(uPressure, vL).x, R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x, B = texture2D(uPressure, vB).x;
      gl_FragColor = vec4(texture2D(uVelocity, vUv).xy - vec2(R - L, T - B), 0.0, 1.0);
    }
  `,
  );

  const blit = (() => {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]),
      gl.STATIC_DRAW,
    );
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(
      gl.ELEMENT_ARRAY_BUFFER,
      new Uint16Array([0, 1, 2, 0, 2, 3]),
      gl.STATIC_DRAW,
    );
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);
    return (target, clear = false) => {
      if (!target) {
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      } else {
        gl.viewport(0, 0, target.width, target.height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      }
      if (clear) {
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    };
  })();

  let dye, velocity, divergence, curl, pressure;

  const copyProgram = new Program(baseVertexShader, copyShader);
  const clearProgram = new Program(baseVertexShader, clearShader);
  const splatProgram = new Program(baseVertexShader, splatShader);
  const advectionProgram = new Program(baseVertexShader, advectionShader);
  const divergenceProgram = new Program(baseVertexShader, divergenceShader);
  const curlProgram = new Program(baseVertexShader, curlShader);
  const vorticityProgram = new Program(baseVertexShader, vorticityShader);
  const pressureProgram = new Program(baseVertexShader, pressureShader);
  const gradienSubtractProgram = new Program(
    baseVertexShader,
    gradientSubtractShader,
  );
  const displayMaterial = new Material(baseVertexShader, displayShaderSource);

  function createFBO(w, h, internalFormat, format, type, param) {
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      internalFormat,
      w,
      h,
      0,
      format,
      type,
      null,
    );

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);

    return {
      texture,
      fbo,
      width: w,
      height: h,
      texelSizeX: 1.0 / w,
      texelSizeY: 1.0 / h,
      attach(id) {
        gl.activeTexture(gl.TEXTURE0 + id);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return id;
      },
    };
  }

  function createDoubleFBO(w, h, internalFormat, format, type, param) {
    let fbo1 = createFBO(w, h, internalFormat, format, type, param);
    let fbo2 = createFBO(w, h, internalFormat, format, type, param);
    return {
      width: w,
      height: h,
      texelSizeX: fbo1.texelSizeX,
      texelSizeY: fbo1.texelSizeY,
      get read() {
        return fbo1;
      },
      set read(v) {
        fbo1 = v;
      },
      get write() {
        return fbo2;
      },
      set write(v) {
        fbo2 = v;
      },
      swap() {
        const temp = fbo1;
        fbo1 = fbo2;
        fbo2 = temp;
      },
    };
  }

  function resizeDoubleFBO(target, w, h, internalFormat, format, type, param) {
    if (target && target.width === w && target.height === h) return target;
    if (target) {
      const newFBO = createFBO(w, h, internalFormat, format, type, param);
      copyProgram.bind();
      gl.uniform1i(copyProgram.uniforms.uTexture, target.read.attach(0));
      blit(newFBO);
      target.read = newFBO;
      target.write = createFBO(w, h, internalFormat, format, type, param);
      target.width = w;
      target.height = h;
      target.texelSizeX = 1.0 / w;
      target.texelSizeY = 1.0 / h;
      return target;
    }
    return createDoubleFBO(w, h, internalFormat, format, type, param);
  }

  function getResolution(resolution) {
    let aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspect < 1) aspect = 1.0 / aspect;
    const min = Math.round(resolution),
      max = Math.round(resolution * aspect);
    return gl.drawingBufferWidth > gl.drawingBufferHeight
      ? { width: max, height: min }
      : { width: min, height: max };
  }

  const scaleByPixelRatio = (input) =>
    Math.floor(input * (window.devicePixelRatio || 1));
  const HSVtoRGB = (h, s, v) => {
    const i = Math.floor(h * 6),
      f = h * 6 - i,
      p = v * (1 - s),
      q = v * (1 - f * s),
      t = v * (1 - (1 - f) * s);
    const cases = [
      [v, t, p],
      [q, v, p],
      [p, v, t],
      [p, q, v],
      [t, p, v],
      [v, p, q],
    ];
    const [r, g, b] = cases[i % 6] || [1, 1, 1];
    return { r, g, b };
  };

  function generateColor() {
    const c = HSVtoRGB(Math.random(), 1.0, 1.0);
    return { r: c.r * 0.15, g: c.g * 0.15, b: c.b * 0.15 };
  }

  function initFramebuffers() {
    const simRes = getResolution(CONFIG.SIM_RESOLUTION),
      dyeRes = getResolution(CONFIG.DYE_RESOLUTION);
    const type = ext.halfFloatTexType,
      filter = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;
    gl.disable(gl.BLEND);

    dye = resizeDoubleFBO(
      dye,
      dyeRes.width,
      dyeRes.height,
      ext.formatRGBA.internalFormat,
      ext.formatRGBA.format,
      type,
      filter,
    );
    velocity = resizeDoubleFBO(
      velocity,
      simRes.width,
      simRes.height,
      ext.formatRG.internalFormat,
      ext.formatRG.format,
      type,
      filter,
    );
    divergence = createFBO(
      simRes.width,
      simRes.height,
      ext.formatR.internalFormat,
      ext.formatR.format,
      type,
      gl.NEAREST,
    );
    curl = createFBO(
      simRes.width,
      simRes.height,
      ext.formatR.internalFormat,
      ext.formatR.format,
      type,
      gl.NEAREST,
    );
    pressure = resizeDoubleFBO(
      pressure,
      simRes.width,
      simRes.height,
      ext.formatR.internalFormat,
      ext.formatR.format,
      type,
      gl.NEAREST,
    );
  }

  displayMaterial.setKeywords(CONFIG.SHADING ? ["SHADING"] : []);
  initFramebuffers();

  let lastUpdateTime = Date.now(),
    colorUpdateTimer = 0.0;
  function calcDeltaTime() {
    const now = Date.now();
    const dt = Math.min((now - lastUpdateTime) / 1000, 0.016666);
    lastUpdateTime = now;
    return dt;
  }

  function resizeCanvas() {
    const w = scaleByPixelRatio(canvas.clientWidth || window.innerWidth);
    const h = scaleByPixelRatio(canvas.clientHeight || window.innerHeight);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      return true;
    }
    return false;
  }

  function step(dt) {
    gl.disable(gl.BLEND);

    curlProgram.bind();
    gl.uniform2f(
      curlProgram.uniforms.texelSize,
      velocity.texelSizeX,
      velocity.texelSizeY,
    );
    gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(curl);

    vorticityProgram.bind();
    gl.uniform2f(
      vorticityProgram.uniforms.texelSize,
      velocity.texelSizeX,
      velocity.texelSizeY,
    );
    gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(vorticityProgram.uniforms.uCurl, curl.attach(1));
    gl.uniform1f(vorticityProgram.uniforms.curl, CONFIG.CURL);
    gl.uniform1f(vorticityProgram.uniforms.dt, dt);
    blit(velocity.write);
    velocity.swap();

    divergenceProgram.bind();
    gl.uniform2f(
      divergenceProgram.uniforms.texelSize,
      velocity.texelSizeX,
      velocity.texelSizeY,
    );
    gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);

    clearProgram.bind();
    gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearProgram.uniforms.value, CONFIG.PRESSURE);
    blit(pressure.write);
    pressure.swap();

    pressureProgram.bind();
    gl.uniform2f(
      pressureProgram.uniforms.texelSize,
      velocity.texelSizeX,
      velocity.texelSizeY,
    );
    gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.attach(0));
    for (let i = 0; i < CONFIG.PRESSURE_ITERATIONS; i++) {
      gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
      blit(pressure.write);
      pressure.swap();
    }

    gradienSubtractProgram.bind();
    gl.uniform2f(
      gradienSubtractProgram.uniforms.texelSize,
      velocity.texelSizeX,
      velocity.texelSizeY,
    );
    gl.uniform1i(
      gradienSubtractProgram.uniforms.uPressure,
      pressure.read.attach(0),
    );
    gl.uniform1i(
      gradienSubtractProgram.uniforms.uVelocity,
      velocity.read.attach(1),
    );
    blit(velocity.write);
    velocity.swap();

    advectionProgram.bind();
    gl.uniform2f(
      advectionProgram.uniforms.texelSize,
      velocity.texelSizeX,
      velocity.texelSizeY,
    );
    if (!ext.supportLinearFiltering)
      gl.uniform2f(
        advectionProgram.uniforms.dyeTexelSize,
        velocity.texelSizeX,
        velocity.texelSizeY,
      );
    const velId = velocity.read.attach(0);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velId);
    gl.uniform1i(advectionProgram.uniforms.uSource, velId);
    gl.uniform1f(advectionProgram.uniforms.dt, dt);
    gl.uniform1f(
      advectionProgram.uniforms.dissipation,
      CONFIG.VELOCITY_DISSIPATION,
    );
    blit(velocity.write);
    velocity.swap();

    if (!ext.supportLinearFiltering)
      gl.uniform2f(
        advectionProgram.uniforms.dyeTexelSize,
        dye.texelSizeX,
        dye.texelSizeY,
      );
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
    gl.uniform1f(
      advectionProgram.uniforms.dissipation,
      CONFIG.DENSITY_DISSIPATION,
    );
    blit(dye.write);
    dye.swap();
  }

  function render(target) {
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);
    const w = target ? target.width : gl.drawingBufferWidth;
    const h = target ? target.height : gl.drawingBufferHeight;
    displayMaterial.bind();
    if (CONFIG.SHADING)
      gl.uniform2f(displayMaterial.uniforms.texelSize, 1.0 / w, 1.0 / h);
    gl.uniform1i(displayMaterial.uniforms.uTexture, dye.read.attach(0));
    blit(target);
  }

  function splat(x, y, dx, dy, color) {
    splatProgram.bind();
    gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(
      splatProgram.uniforms.aspectRatio,
      canvas.width / canvas.height || 1,
    );
    gl.uniform2f(splatProgram.uniforms.point, x, y);
    gl.uniform3f(splatProgram.uniforms.color, dx, dy, 0.0);
    let radius = CONFIG.SPLAT_RADIUS / 100.0;
    if (canvas.width / canvas.height > 1)
      radius *= canvas.width / canvas.height;
    gl.uniform1f(splatProgram.uniforms.radius, radius);
    blit(velocity.write);
    velocity.swap();

    gl.uniform1i(splatProgram.uniforms.uTarget, dye.read.attach(0));
    gl.uniform3f(splatProgram.uniforms.color, color.r, color.g, color.b);
    blit(dye.write);
    dye.swap();
  }

  // Unified Pointer State Handlers
  function updatePointerDownData(pointer, id, posX, posY) {
    pointer.id = id;
    pointer.down = true;
    pointer.moved = false;
    pointer.texcoordX = pointer.prevTexcoordX = posX / canvas.width;
    pointer.texcoordY = pointer.prevTexcoordY = 1.0 - posY / canvas.height;
    pointer.deltaX = pointer.deltaY = 0;
    pointer.color = generateColor();
  }

  function updatePointerMoveData(pointer, posX, posY, color) {
    pointer.prevTexcoordX = pointer.texcoordX;
    pointer.prevTexcoordY = pointer.texcoordY;
    pointer.texcoordX = posX / canvas.width;
    pointer.texcoordY = 1.0 - posY / canvas.height;

    let dx = pointer.texcoordX - pointer.prevTexcoordX;
    let dy = pointer.texcoordY - pointer.prevTexcoordY;
    const aspect = canvas.width / canvas.height;
    pointer.deltaX = aspect < 1 ? dx * aspect : dx;
    pointer.deltaY = aspect > 1 ? dy / aspect : dy;

    pointer.moved =
      Math.abs(pointer.deltaX) > 0 || Math.abs(pointer.deltaY) > 0;
    if (color) pointer.color = color;
  }

  const getPos = (e) => ({
    x: scaleByPixelRatio(e.clientX),
    y: scaleByPixelRatio(e.clientY),
  });

  // Unified Event Listeners
  window.addEventListener("mousedown", (e) => {
    const pos = getPos(e),
      pointer = pointers[0];
    updatePointerDownData(pointer, -1, pos.x, pos.y);
    const c = generateColor();
    splat(
      pointer.texcoordX,
      pointer.texcoordY,
      10 * (Math.random() - 0.5),
      30 * (Math.random() - 0.5),
      { r: c.r * 10, g: c.g * 10, b: c.b * 10 },
    );
  });

  window.addEventListener("mousemove", (e) => {
    const pos = getPos(e),
      pointer = pointers[0];
    updatePointerMoveData(pointer, pos.x, pos.y, pointer.color);
  });

  const handleTouch = (e, type) => {
    const touches = e.targetTouches.length ? e.targetTouches : e.changedTouches;
    const pointer = pointers[0];
    for (let i = 0; i < touches.length; i++) {
      const posX = scaleByPixelRatio(touches[i].clientX);
      const posY = scaleByPixelRatio(touches[i].clientY);
      if (type === "down")
        updatePointerDownData(pointer, touches[i].identifier, posX, posY);
      else if (type === "move")
        updatePointerMoveData(pointer, posX, posY, pointer.color);
      else pointer.down = false;
    }
  };

  window.addEventListener("touchstart", (e) => handleTouch(e, "down"));
  window.addEventListener("touchmove", (e) => handleTouch(e, "move"), {
    passive: false,
  });
  window.addEventListener("touchend", (e) => handleTouch(e, "up"));

  // Animation Engine setup
  let rafId = null;
  function updateFrame() {
    rafId = requestAnimationFrame(updateFrame);
    const dt = calcDeltaTime();
    if (resizeCanvas()) initFramebuffers();

    colorUpdateTimer += dt * CONFIG.COLOR_UPDATE_SPEED;
    if (colorUpdateTimer >= 1) {
      colorUpdateTimer = ((colorUpdateTimer % 1) + 1) % 1;
      pointers.forEach((p) => (p.color = generateColor()));
    }

    pointers.forEach((p) => {
      if (p.moved) {
        p.moved = false;
        splat(
          p.texcoordX,
          p.texcoordY,
          p.deltaX * CONFIG.SPLAT_FORCE,
          p.deltaY * CONFIG.SPLAT_FORCE,
          p.color,
        );
      }
    });

    step(dt);
    render(null);
  }

  // First Interaction Listeners to trigger simulation loop seamlessly
  const triggerFirstFrame = () => {
    if (!rafId) updateFrame();
    document.body.removeEventListener("mousemove", triggerFirstFrame);
    document.body.removeEventListener("touchstart", triggerFirstFrame);
  };
  document.body.addEventListener("mousemove", triggerFirstFrame);
  document.body.addEventListener("touchstart", triggerFirstFrame);

  setTimeout(() => {
    if (!rafId) updateFrame();
  }, 1000);
  window.addEventListener("beforeunload", () => {
    if (rafId) cancelAnimationFrame(rafId);
  });

  console.log("Fluid Splash Cursor initialized.");
})();
