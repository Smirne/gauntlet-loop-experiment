// WebGLRenderer configuration for MICRO GAUNTLET.
//
// Colour pipeline, stated once so the rest of the render package can rely on it:
//
//   scene  --(RenderPass, HalfFloat RT)-->  linear HDR
//          --(PostFX grade: exposure -> ACES -> CDL -> LUT)-->  display-referred linear
//          --(OutputPass)-->  sRGB encoded canvas
//
// three only applies material tone mapping when a draw targets the canvas
// (WebGLPrograms: `toneMapping = currentRenderTarget === null ? renderer.toneMapping
// : NoToneMapping`), so everything the composer sees is linear HDR regardless of what
// is set here. The renderer still carries ACESFilmic + exposure because that is the
// path used when post-processing is unavailable, and because PostFX reads
// `renderer.toneMappingExposure` as the single source of truth for exposure.

import * as THREE from 'three';

/** Base exposure. Lighting presets scale this; PostFX reads the product. */
export const BASE_EXPOSURE = 1.04;

/**
 * Per-tier render budget.
 *
 * `maxPixels` is a hard budget on the drawing buffer: on a 4K panel a naive
 * devicePixelRatio of 2 would ask for 33 Mpx and the whole post chain would fall
 * off a cliff, so the effective pixel ratio is the smaller of the tier cap and
 * whatever keeps us inside the budget.
 */
export const RENDER_TIERS = {
  low: { pixelRatio: 1.0, maxPixels: 1.15e6, anisotropy: 2, shadowMapSize: 512 },
  medium: { pixelRatio: 1.0, maxPixels: 2.10e6, anisotropy: 4, shadowMapSize: 1024 },
  high: { pixelRatio: 1.5, maxPixels: 3.10e6, anisotropy: 8, shadowMapSize: 2048 },
  ultra: { pixelRatio: 2.0, maxPixels: 4.40e6, anisotropy: 16, shadowMapSize: 2048 },
};

const DEFAULT_TIER = 'ultra';

function tierOf(settings) {
  const q = settings && settings.quality;
  return RENDER_TIERS[q] ? q : DEFAULT_TIER;
}

/**
 * Effective device pixel ratio for a viewport, clamped by tier and pixel budget.
 * @param {number} w CSS pixels
 * @param {number} h CSS pixels
 * @param {string} tier
 * @param {number} [dpr]
 * @returns {number}
 */
export function computePixelRatio(w, h, tier, dpr) {
  const t = RENDER_TIERS[tier] || RENDER_TIERS[DEFAULT_TIER];
  const device = typeof dpr === 'number' ? dpr : (globalThis.devicePixelRatio || 1);
  const area = Math.max(1, w * h);
  const budgetRatio = Math.sqrt(t.maxPixels / area);
  return Math.max(0.5, Math.min(device, t.pixelRatio, budgetRatio));
}

/**
 * Anisotropic filtering level for a tier, clamped to what the GPU actually offers.
 * Texture modules should call this rather than hardcoding a number.
 */
export function pickAnisotropy(renderer, tier) {
  const t = RENDER_TIERS[tier] || RENDER_TIERS[DEFAULT_TIER];
  let max = 1;
  try {
    max = renderer.capabilities.getMaxAnisotropy();
  } catch (e) {
    max = 1;
  }
  return Math.max(1, Math.min(t.anisotropy, max || 1));
}

/** Snapshot of GPU capabilities, cached on `renderer.userData.mg`. */
export function describeCapabilities(renderer) {
  const caps = renderer.capabilities;
  const gl = renderer.getContext();
  let maxSamples = 0;
  try {
    maxSamples = gl.getParameter(gl.MAX_SAMPLES) || 0;
  } catch (e) {
    maxSamples = 0;
  }
  return {
    precision: caps.precision,
    maxTextureSize: caps.maxTextureSize,
    maxAnisotropy: caps.getMaxAnisotropy(),
    maxSamples,
    floatLinear: !!renderer.extensions.get('OES_texture_float_linear'),
    colorBufferFloat: !!renderer.extensions.get('EXT_color_buffer_float'),
    vendor: (() => {
      try {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
      } catch (e) {
        return 'unknown';
      }
    })(),
  };
}

/**
 * Apply every renderer-level setting that is not size related.
 * Safe to call repeatedly (quality changes, preset changes).
 */
export function configureRenderer(renderer, settings) {
  const tier = tierOf(settings);

  THREE.ColorManagement.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // ACESFilmic here is the no-post fallback path; PostFX takes the curve over when
  // its grade pass is live and hands the renderer back untouched afterwards.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  if (!(renderer.toneMappingExposure > 0)) renderer.toneMappingExposure = BASE_EXPOSURE;

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Lighting drives cascades individually through LightShadow.autoUpdate, so the
  // global switch stays on.
  renderer.shadowMap.autoUpdate = true;

  renderer.autoClear = true;
  renderer.autoClearColor = true;
  renderer.autoClearDepth = true;
  renderer.sortObjects = true;
  renderer.localClippingEnabled = false;
  renderer.info.autoReset = true;

  renderer.setClearColor(0x000000, 1);

  const ud = (renderer.userData = renderer.userData || {});
  ud.mg = ud.mg || {};
  ud.mg.tier = tier;
  ud.mg.caps = ud.mg.caps || describeCapabilities(renderer);
  ud.mg.anisotropy = pickAnisotropy(renderer, tier);
  ud.mg.shadowMapSize = Math.min(
    (settings && settings.render && settings.render.shadowMapSize) || RENDER_TIERS[tier].shadowMapSize,
    2048,
    ud.mg.caps.maxTextureSize
  );

  return renderer;
}

/**
 * Create and fully configure the game's WebGLRenderer.
 *
 * Accepts either shape, because the bootstrap may call it positionally:
 *   createRenderer({ canvas, settings, width, height, antialias, bus })
 *   createRenderer(canvasElement, settings)
 *
 * @param {object|HTMLCanvasElement} [a]
 * @param {object} [b] settings, when called positionally
 */
export function createRenderer(a = {}, b) {
  const opts =
    a && typeof a === 'object' && (a.nodeType === 1 || typeof a.getContext === 'function')
      ? { canvas: a, settings: b }
      : a || {};

  const canvas =
    opts.canvas || (typeof document !== 'undefined' ? document.getElementById('stage') : undefined);
  const settings = opts.settings || {};
  const post = settings.post || {};
  const postLikely =
    opts.antialias === undefined
      ? !(post.enabled === false) &&
        (post.bloom !== false || post.tiltShift !== false || post.grade !== false)
      : false;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    // With the composer live the canvas only ever receives one fullscreen triangle,
    // so default-framebuffer MSAA is pure bandwidth. SMAA in post does the AA.
    antialias: opts.antialias !== undefined ? !!opts.antialias : !postLikely,
    alpha: false,
    depth: true,
    stencil: false,
    premultipliedAlpha: true,
    // Capture.js reads the canvas back with toDataURL after rendering on demand.
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
    failIfMajorPerformanceCaveat: false,
    // Explicitly off: the contract fixes near/far at 2/4000, which a 24-bit depth
    // buffer resolves comfortably, and logarithmic depth breaks depth-reading
    // post passes and costs a per-fragment write.
    logarithmicDepthBuffer: false,
    // Highp everywhere, including the packed-depth shadow materials.
    precision: 'highp',
  });

  configureRenderer(renderer, settings);

  const w = opts.width || (canvas && canvas.clientWidth) || 1600;
  const h = opts.height || (canvas && canvas.clientHeight) || 900;
  resizeRenderer(renderer, w, h, settings);

  // A lost context otherwise silently freezes the game on a black canvas.
  const el = renderer.domElement;
  if (el && el.addEventListener) {
    el.addEventListener(
      'webglcontextlost',
      (e) => {
        e.preventDefault();
        renderer.userData.mg.contextLost = true;
        opts.bus?.emit?.('render:contextlost');
        console.warn('[MICRO GAUNTLET] WebGL context lost');
      },
      false
    );
    el.addEventListener(
      'webglcontextrestored',
      () => {
        renderer.userData.mg.contextLost = false;
        configureRenderer(renderer, settings);
        opts.bus?.emit?.('render:contextrestored');
        console.warn('[MICRO GAUNTLET] WebGL context restored');
      },
      false
    );
  }

  return renderer;
}

/**
 * Resize path. `w`/`h` are CSS pixels; the drawing buffer is scaled by the
 * budgeted pixel ratio. Returns the drawing-buffer size so composers can follow.
 */
export function resizeRenderer(renderer, w, h, settings) {
  const tier = tierOf(settings || { quality: renderer.userData?.mg?.tier });
  const explicit = settings && settings.render && settings.render.pixelRatio;
  const pr = explicit > 0 ? Math.min(explicit, computePixelRatio(w, h, tier)) : computePixelRatio(w, h, tier);

  renderer.setPixelRatio(pr);
  // updateStyle=false: the canvas is laid out by CSS, we only own the buffer.
  renderer.setSize(w, h, false);

  const ud = (renderer.userData = renderer.userData || {});
  ud.mg = ud.mg || {};
  ud.mg.pixelRatio = pr;
  ud.mg.cssWidth = w;
  ud.mg.cssHeight = h;

  return { width: Math.round(w * pr), height: Math.round(h * pr), pixelRatio: pr };
}

/** Re-apply tier-dependent renderer state after a quality change. */
export function applyQuality(renderer, tier, settings) {
  const s = Object.assign({}, settings || {}, { quality: RENDER_TIERS[tier] ? tier : DEFAULT_TIER });
  configureRenderer(renderer, s);
  const ud = renderer.userData.mg;
  resizeRenderer(renderer, ud.cssWidth || 1600, ud.cssHeight || 900, s);
  return renderer;
}

/**
 * System-interface wrapper, for engines that register the renderer like any other
 * subsystem. `main.js` may equally just call `createRenderer()` and hold the
 * renderer itself — both are supported.
 */
export class RendererSystem {
  name = 'renderer';

  constructor(ctx = {}, opts = {}) {
    this.ctx = ctx;
    this.renderer =
      ctx.renderer ||
      createRenderer({
        canvas: opts.canvas,
        settings: ctx.settings,
        width: opts.width,
        height: opts.height,
        bus: ctx.bus,
      });
    ctx.renderer = this.renderer;
  }

  async init() {
    return this.renderer;
  }

  setQuality(tier) {
    applyQuality(this.renderer, tier, this.ctx.settings);
  }

  onResize(w, h) {
    return resizeRenderer(this.renderer, w, h, this.ctx.settings);
  }

  get caps() {
    return this.renderer.userData?.mg?.caps;
  }

  dispose() {
    try {
      this.renderer.dispose();
    } catch (e) {
      /* already gone */
    }
  }
}

export default createRenderer;
