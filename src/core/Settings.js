// core/Settings.js — every tunable in the game, in one place.
//
// Three jobs:
//   1. Hold the live configuration. Systems read `Settings.x.y` directly and may
//      hold a reference to a group (`const P = Settings.post`) — so merges are
//      always performed *in place*. Group objects keep their identity forever.
//   2. Describe quality tiers as complete patches. `forQuality('low')` returns
//      everything that differs from the shipped defaults, not a partial hint.
//   3. Propagate. `apply(ctx)` walks the live systems and pushes the current
//      values into them, guarded so a peer that is still a stub cannot throw.
//
// Deliberately dependency-free: this module is imported by nearly everything,
// including code that runs before the renderer exists.

export const QUALITY = ['low', 'medium', 'high', 'ultra'];

const STORAGE_KEY = 'microgauntlet.settings.v1';

/* ------------------------------------------------------------------ defaults */

// Authored against the ultra tier: the game as it is meant to be seen. Lower
// tiers are subtractions from this.
const DEFAULTS = {
  quality: 'ultra',

  render: {
    pixelRatio: 1,          // resolved value handed to renderer.setPixelRatio()
    maxPixelRatio: 2,       // ceiling applied to window.devicePixelRatio
    renderScale: 1,         // extra multiplier — the dynamic-resolution knob
    shadows: true,
    shadowMapSize: 4096,
    shadowCascades: 3,
    shadowType: 'pcfsoft',  // 'basic' | 'pcf' | 'pcfsoft' | 'vsm'
    shadowBias: -0.00035,
    shadowNormalBias: 0.6,  // in world units (cm) — cars are 9 u long
    shadowDistance: 420,    // covers the ~460x340 playfield from the chase cam
    contactShadows: true,
    anisotropy: 16,
    msaaSamples: 4,         // MSAA on the composer's first render target
    exposure: 1.05,
    toneMapping: 'aces',
    targetFps: 60,
    adaptiveResolution: false, // off by default: it would perturb review shots
    powerPreference: 'high-performance',
  },

  post: {
    enabled: true,
    resolutionScale: 1,     // post chain can run below native if needed
    ssao: true,
    bloom: true,
    tiltShift: true,
    motionBlur: true,
    grade: true,
    grain: true,
    chromatic: true,
    vignette: true,
    crt: false,
    smaa: true,
    // Per-effect tuning. Toggles stay booleans (that is the published contract);
    // the dials live here so the debug panel has something to turn.
    params: {
      ssaoRadius: 6.5,          // world units — a wheel is 2.3 u across
      ssaoIntensity: 0.9,
      ssaoSamples: 16,
      ssaoDistance: 90,
      ssaoThickness: 4,

      bloomStrength: 0.42,
      bloomThreshold: 0.92,     // specular-only: keep it above diffuse white
      bloomRadius: 0.55,
      bloomSpecular: 1,         // 1 = key off the specular buffer, 0 = luminance

      tiltShiftAmount: 1,
      tiltShiftCenter: 0.52,    // screen-space Y of the in-focus band
      tiltShiftBand: 0.22,      // half-height of the sharp band
      tiltShiftFalloff: 2,      // quadratic ramp away from the band
      tiltShiftMaxRadius: 3.2,  // px at 1080p
      tiltShiftFollowPlayer: 1, // band tracks the player's screen position

      motionBlurAmount: 0.55,
      motionBlurSamples: 12,

      gradeContrast: 1.06,
      gradeSaturation: 1.08,
      gradeLift: 0.004,
      gradeGamma: 1,
      gradeGain: 1.02,
      gradeTemperature: 0.06,   // + warm, - cool
      gradeLutSize: 32,

      grainAmount: 0.035,       // ceiling is 0.04 at ultra, per the art contract
      grainSize: 1.35,

      chromaticAmount: 0.0022,
      vignetteAmount: 0.34,
      vignetteSmooth: 0.62,

      crtAmount: 0.35,
      crtScanlines: 900,
      crtCurvature: 0.06,
    },
  },

  textures: {
    resolution: 2048,
    maxResolution: 2048,
    mipmaps: true,
    normalStrength: 1,
    detailTiling: 1,
    generateAO: true,
    generateDisplacement: true,
    proceduralDetail: 1,   // multiplier on octave counts in ProcTex
    cacheBudgetMB: 320,
  },

  particles: {
    enabled: true,
    budget: 6000,          // total live particles across every kind
    softParticles: true,
    lit: true,
    shadows: false,        // particle shadow casting is never worth the cost
    sizeScale: 1,
    kinds: {
      tyreSmoke: 1400,
      dust: 1200,
      sand: 700,
      grassClipping: 400,
      sparks: 600,
      waterSplash: 500,
      milkSplash: 400,
      exhaust: 400,
      debris: 300,
      boostFlame: 300,
      dustMote: 900,       // the motes hanging in the light shafts
    },
  },

  world: {
    propDensity: 1.25,
    decalBudget: 512,
    skidBudget: 96,        // simultaneous skid ribbons
    grassDensity: 1,
    dustMotes: 1,
    drawDistance: 1400,
    lodBias: 1,
    instancedProps: true,
    crumbs: 1,
  },

  // Never varied by quality tier: physics must be bit-identical on every
  // machine or replays, AI lines and lap records stop matching.
  physics: {
    gravity: 260,          // the deliberate lie — see ARCHITECTURE section 2
    fixedHz: 120,
    substeps: 1,
    maxCatchUpSteps: 5,
    maxRenderDt: 0.05,
    timeScale: 1,
    contactIterations: 6,
    restitution: 0.28,
    friction: 1,
  },

  audio: {
    master: 0.8,
    music: 0.5,
    sfx: 0.9,
    engine: 0.85,
    ambience: 0.45,
    muted: false,
    maxVoices: 24,
    doppler: true,
    hrtf: true,
  },

  gameplay: {
    assists: true,
    aiDifficulty: 0.65,
    aiCount: 7,
    laps: 3,
    rubberBanding: 0.06,   // hard ceiling from the AI contract
    damage: true,
    cameraShake: 1,
    uiScale: 1,
    countdown: 3,
    mirrorSteering: false,
  },

  camera: {
    fov: 33,               // long lens — the miniature look lives or dies here
    near: 2,
    far: 4000,
    pitch: 55,             // degrees; contract band is 48-62
    distance: 46,
    height: 26,
    damping: 0.12,
    lookahead: 0.35,
    fovBoostKick: 4,
  },

  debug: {
    overlay: false,
    freeCam: false,
    showColliders: false,
    showRacingLine: false,
    showHelpers: false,
    logSystems: false,
  },
};

/* --------------------------------------------------------------- tier patches */

// Full patches, not hints. Anything a tier does not mention stays at DEFAULTS,
// which is the ultra authoring target.
const TIERS = {
  low: {
    render: {
      maxPixelRatio: 1, renderScale: 0.85, shadows: true, shadowMapSize: 512,
      shadowCascades: 1, shadowType: 'pcf', shadowDistance: 260,
      contactShadows: true, anisotropy: 1, msaaSamples: 0, exposure: 1.05,
    },
    post: {
      enabled: true, resolutionScale: 0.85,
      ssao: false, bloom: true, tiltShift: false, motionBlur: false,
      grade: true, grain: false, chromatic: false, vignette: true,
      crt: false, smaa: false,
      params: {
        bloomStrength: 0.3, bloomRadius: 0.4, ssaoSamples: 4,
        motionBlurSamples: 4, tiltShiftMaxRadius: 1.6, grainAmount: 0,
        gradeLutSize: 16,
      },
    },
    textures: {
      resolution: 512, maxResolution: 512, generateAO: true,
      generateDisplacement: false, proceduralDetail: 0.5, cacheBudgetMB: 64,
    },
    particles: {
      enabled: true, budget: 700, softParticles: false, lit: false, sizeScale: 1.15,
      kinds: {
        tyreSmoke: 180, dust: 140, sand: 80, grassClipping: 50, sparks: 70,
        waterSplash: 60, milkSplash: 50, exhaust: 40, debris: 40,
        boostFlame: 50, dustMote: 0,
      },
    },
    world: {
      propDensity: 0.45, decalBudget: 96, skidBudget: 24, grassDensity: 0.35,
      dustMotes: 0, drawDistance: 900, lodBias: 1.9, crumbs: 0.3,
    },
  },

  medium: {
    render: {
      maxPixelRatio: 1, renderScale: 1, shadows: true, shadowMapSize: 1024,
      shadowCascades: 2, shadowType: 'pcf', shadowDistance: 340,
      contactShadows: true, anisotropy: 4, msaaSamples: 0, exposure: 1.05,
    },
    post: {
      enabled: true, resolutionScale: 1,
      ssao: false, bloom: true, tiltShift: true, motionBlur: false,
      grade: true, grain: true, chromatic: false, vignette: true,
      crt: false, smaa: true,
      params: {
        bloomStrength: 0.36, bloomRadius: 0.5, ssaoSamples: 8,
        motionBlurSamples: 6, tiltShiftMaxRadius: 2.2, grainAmount: 0.025,
        gradeLutSize: 24,
      },
    },
    textures: {
      resolution: 1024, maxResolution: 1024, generateAO: true,
      generateDisplacement: false, proceduralDetail: 0.75, cacheBudgetMB: 140,
    },
    particles: {
      enabled: true, budget: 1800, softParticles: true, lit: false, sizeScale: 1.05,
      kinds: {
        tyreSmoke: 420, dust: 360, sand: 200, grassClipping: 120, sparks: 180,
        waterSplash: 150, milkSplash: 120, exhaust: 120, debris: 90,
        boostFlame: 110, dustMote: 180,
      },
    },
    world: {
      propDensity: 0.7, decalBudget: 192, skidBudget: 48, grassDensity: 0.6,
      dustMotes: 0.5, drawDistance: 1100, lodBias: 1.35, crumbs: 0.6,
    },
  },

  high: {
    render: {
      maxPixelRatio: 1.5, renderScale: 1, shadows: true, shadowMapSize: 2048,
      shadowCascades: 3, shadowType: 'pcfsoft', shadowDistance: 420,
      contactShadows: true, anisotropy: 8, msaaSamples: 0, exposure: 1.05,
    },
    post: {
      enabled: true, resolutionScale: 1,
      ssao: true, bloom: true, tiltShift: true, motionBlur: true,
      grade: true, grain: true, chromatic: true, vignette: true,
      crt: false, smaa: true,
      params: {
        bloomStrength: 0.4, bloomRadius: 0.55, ssaoSamples: 12,
        motionBlurSamples: 8, tiltShiftMaxRadius: 2.8, grainAmount: 0.03,
        gradeLutSize: 32,
      },
    },
    textures: {
      resolution: 1024, maxResolution: 2048, generateAO: true,
      generateDisplacement: true, proceduralDetail: 1, cacheBudgetMB: 220,
    },
    particles: {
      enabled: true, budget: 3200, softParticles: true, lit: true, sizeScale: 1,
      kinds: {
        tyreSmoke: 800, dust: 650, sand: 380, grassClipping: 220, sparks: 320,
        waterSplash: 280, milkSplash: 220, exhaust: 220, debris: 170,
        boostFlame: 180, dustMote: 460,
      },
    },
    world: {
      propDensity: 1, decalBudget: 320, skidBudget: 72, grassDensity: 0.85,
      dustMotes: 0.8, drawDistance: 1250, lodBias: 1.1, crumbs: 0.85,
    },
  },

  ultra: {
    render: {
      maxPixelRatio: 2, renderScale: 1, shadows: true, shadowMapSize: 4096,
      shadowCascades: 3, shadowType: 'pcfsoft', shadowDistance: 420,
      contactShadows: true, anisotropy: 16, msaaSamples: 4, exposure: 1.05,
    },
    post: {
      enabled: true, resolutionScale: 1,
      ssao: true, bloom: true, tiltShift: true, motionBlur: true,
      grade: true, grain: true, chromatic: true, vignette: true,
      crt: false, smaa: true,
      params: {
        bloomStrength: 0.42, bloomRadius: 0.55, ssaoSamples: 16,
        motionBlurSamples: 12, tiltShiftMaxRadius: 3.2, grainAmount: 0.035,
        gradeLutSize: 32,
      },
    },
    textures: {
      resolution: 2048, maxResolution: 2048, generateAO: true,
      generateDisplacement: true, proceduralDetail: 1, cacheBudgetMB: 320,
    },
    particles: {
      enabled: true, budget: 6000, softParticles: true, lit: true, sizeScale: 1,
      kinds: {
        tyreSmoke: 1400, dust: 1200, sand: 700, grassClipping: 400, sparks: 600,
        waterSplash: 500, milkSplash: 400, exhaust: 400, debris: 300,
        boostFlame: 300, dustMote: 900,
      },
    },
    world: {
      propDensity: 1.25, decalBudget: 512, skidBudget: 96, grassDensity: 1,
      dustMotes: 1, drawDistance: 1400, lodBias: 1, crumbs: 1,
    },
  },
};

/* ------------------------------------------------------------------ metadata */

// Range + label for every knob worth exposing. Doubles as the schema used to
// sanitise anything read back out of localStorage, and as the spec the debug
// tuning panel builds its controls from.
export const META = {
  'render.maxPixelRatio': { label: 'Max pixel ratio', min: 0.5, max: 3, step: 0.05 },
  'render.renderScale': { label: 'Render scale', min: 0.4, max: 1.4, step: 0.02 },
  'render.shadows': { label: 'Shadows' },
  'render.shadowMapSize': { label: 'Shadow map', options: [512, 1024, 2048, 4096] },
  'render.shadowCascades': { label: 'Cascades', min: 1, max: 4, step: 1 },
  'render.shadowType': { label: 'Shadow filter', options: ['basic', 'pcf', 'pcfsoft', 'vsm'] },
  'render.shadowDistance': { label: 'Shadow distance', min: 120, max: 900, step: 10 },
  'render.shadowBias': { label: 'Shadow bias', min: -0.002, max: 0.002, step: 0.00005 },
  'render.shadowNormalBias': { label: 'Normal bias', min: 0, max: 4, step: 0.05 },
  'render.contactShadows': { label: 'Contact shadows' },
  'render.anisotropy': { label: 'Anisotropy', options: [1, 2, 4, 8, 16] },
  'render.msaaSamples': { label: 'MSAA', options: [0, 2, 4, 8] },
  'render.exposure': { label: 'Exposure', min: 0.3, max: 2.5, step: 0.01 },
  'render.targetFps': { label: 'Target fps', options: [30, 60, 120, 144] },
  'render.adaptiveResolution': { label: 'Adaptive res' },

  'post.enabled': { label: 'Post enabled' },
  'post.resolutionScale': { label: 'Post scale', min: 0.5, max: 1, step: 0.05 },
  'post.ssao': { label: 'SSAO / GTAO' },
  'post.bloom': { label: 'Bloom' },
  'post.tiltShift': { label: 'Tilt-shift' },
  'post.motionBlur': { label: 'Motion blur' },
  'post.grade': { label: 'Colour grade' },
  'post.grain': { label: 'Film grain' },
  'post.chromatic': { label: 'Chromatic ab.' },
  'post.vignette': { label: 'Vignette' },
  'post.crt': { label: 'CRT grade' },
  'post.smaa': { label: 'SMAA' },

  'post.params.ssaoRadius': { label: 'AO radius', min: 0.5, max: 24, step: 0.1 },
  'post.params.ssaoIntensity': { label: 'AO intensity', min: 0, max: 3, step: 0.01 },
  'post.params.ssaoSamples': { label: 'AO samples', min: 4, max: 32, step: 1 },
  'post.params.ssaoDistance': { label: 'AO distance', min: 10, max: 400, step: 1 },
  'post.params.bloomStrength': { label: 'Bloom strength', min: 0, max: 2, step: 0.01 },
  'post.params.bloomThreshold': { label: 'Bloom threshold', min: 0, max: 2, step: 0.005 },
  'post.params.bloomRadius': { label: 'Bloom radius', min: 0, max: 1.5, step: 0.01 },
  'post.params.bloomSpecular': { label: 'Bloom specular key', min: 0, max: 1, step: 0.01 },
  'post.params.tiltShiftAmount': { label: 'Tilt amount', min: 0, max: 2, step: 0.01 },
  'post.params.tiltShiftCenter': { label: 'Tilt centre', min: 0, max: 1, step: 0.005 },
  'post.params.tiltShiftBand': { label: 'Tilt band', min: 0.02, max: 0.9, step: 0.005 },
  'post.params.tiltShiftFalloff': { label: 'Tilt falloff', min: 0.5, max: 5, step: 0.05 },
  'post.params.tiltShiftMaxRadius': { label: 'Tilt max blur', min: 0, max: 8, step: 0.05 },
  'post.params.tiltShiftFollowPlayer': { label: 'Tilt follows car', min: 0, max: 1, step: 0.01 },
  'post.params.motionBlurAmount': { label: 'Motion blur', min: 0, max: 2, step: 0.01 },
  'post.params.motionBlurSamples': { label: 'MB samples', min: 2, max: 24, step: 1 },
  'post.params.gradeContrast': { label: 'Contrast', min: 0.5, max: 1.8, step: 0.005 },
  'post.params.gradeSaturation': { label: 'Saturation', min: 0, max: 2, step: 0.005 },
  'post.params.gradeLift': { label: 'Lift', min: -0.1, max: 0.1, step: 0.001 },
  'post.params.gradeGamma': { label: 'Gamma', min: 0.5, max: 1.8, step: 0.005 },
  'post.params.gradeGain': { label: 'Gain', min: 0.5, max: 1.8, step: 0.005 },
  'post.params.gradeTemperature': { label: 'Temperature', min: -0.4, max: 0.4, step: 0.005 },
  'post.params.grainAmount': { label: 'Grain', min: 0, max: 0.12, step: 0.001 },
  'post.params.grainSize': { label: 'Grain size', min: 0.5, max: 4, step: 0.05 },
  'post.params.chromaticAmount': { label: 'Chromatic', min: 0, max: 0.02, step: 0.0001 },
  'post.params.vignetteAmount': { label: 'Vignette', min: 0, max: 1.2, step: 0.01 },
  'post.params.vignetteSmooth': { label: 'Vignette smooth', min: 0.1, max: 2, step: 0.01 },
  'post.params.crtAmount': { label: 'CRT amount', min: 0, max: 1, step: 0.01 },
  'post.params.crtScanlines': { label: 'Scanlines', min: 200, max: 1600, step: 10 },
  'post.params.crtCurvature': { label: 'CRT curve', min: 0, max: 0.3, step: 0.005 },

  'textures.resolution': { label: 'Texture res', options: [256, 512, 1024, 2048] },
  'textures.mipmaps': { label: 'Mipmaps' },
  'textures.normalStrength': { label: 'Normal strength', min: 0, max: 3, step: 0.02 },
  'textures.detailTiling': { label: 'Detail tiling', min: 0.25, max: 4, step: 0.05 },
  'textures.generateAO': { label: 'Bake AO maps' },
  'textures.generateDisplacement': { label: 'Displacement' },
  'textures.proceduralDetail': { label: 'Noise octaves', min: 0.25, max: 1.5, step: 0.05 },

  'particles.enabled': { label: 'Particles' },
  'particles.budget': { label: 'Particle budget', min: 200, max: 12000, step: 100 },
  'particles.softParticles': { label: 'Soft particles' },
  'particles.lit': { label: 'Lit particles' },
  'particles.sizeScale': { label: 'Particle size', min: 0.4, max: 2.5, step: 0.02 },

  'world.propDensity': { label: 'Prop density', min: 0, max: 2, step: 0.05 },
  'world.decalBudget': { label: 'Decal budget', min: 32, max: 1024, step: 16 },
  'world.skidBudget': { label: 'Skid ribbons', min: 8, max: 192, step: 4 },
  'world.grassDensity': { label: 'Grass density', min: 0, max: 2, step: 0.05 },
  'world.dustMotes': { label: 'Dust motes', min: 0, max: 2, step: 0.05 },
  'world.drawDistance': { label: 'Draw distance', min: 400, max: 2500, step: 25 },
  'world.lodBias': { label: 'LOD bias', min: 0.5, max: 2.5, step: 0.05 },

  'physics.gravity': { label: 'Gravity (u/s2)', min: 60, max: 900, step: 5 },
  'physics.fixedHz': { label: 'Fixed Hz', options: [60, 90, 120, 240] },
  'physics.substeps': { label: 'Substeps', min: 1, max: 4, step: 1 },
  'physics.maxCatchUpSteps': { label: 'Max catch-up', min: 1, max: 10, step: 1 },
  'physics.timeScale': { label: 'Time scale', min: 0.05, max: 2, step: 0.01 },
  'physics.contactIterations': { label: 'Contact iters', min: 1, max: 16, step: 1 },
  'physics.restitution': { label: 'Restitution', min: 0, max: 1, step: 0.01 },
  'physics.friction': { label: 'Friction mult', min: 0, max: 2, step: 0.01 },

  'audio.master': { label: 'Master', min: 0, max: 1, step: 0.01 },
  'audio.music': { label: 'Music', min: 0, max: 1, step: 0.01 },
  'audio.sfx': { label: 'SFX', min: 0, max: 1, step: 0.01 },
  'audio.engine': { label: 'Engine', min: 0, max: 1, step: 0.01 },
  'audio.ambience': { label: 'Ambience', min: 0, max: 1, step: 0.01 },
  'audio.muted': { label: 'Mute' },
  'audio.maxVoices': { label: 'Max voices', min: 4, max: 64, step: 1 },
  'audio.doppler': { label: 'Doppler' },

  'gameplay.assists': { label: 'Driving assists' },
  'gameplay.aiDifficulty': { label: 'AI difficulty', min: 0, max: 1, step: 0.01 },
  'gameplay.aiCount': { label: 'AI cars', min: 0, max: 11, step: 1 },
  'gameplay.laps': { label: 'Laps', min: 1, max: 9, step: 1 },
  'gameplay.rubberBanding': { label: 'Rubber band', min: 0, max: 0.06, step: 0.005 },
  'gameplay.damage': { label: 'Damage' },
  'gameplay.cameraShake': { label: 'Camera shake', min: 0, max: 2, step: 0.05 },
  'gameplay.uiScale': { label: 'UI scale', min: 0.6, max: 1.6, step: 0.05 },

  'camera.fov': { label: 'FOV', min: 22, max: 60, step: 0.5 },
  'camera.pitch': { label: 'Pitch', min: 30, max: 80, step: 0.5 },
  'camera.distance': { label: 'Distance', min: 18, max: 120, step: 0.5 },
  'camera.height': { label: 'Height', min: 6, max: 90, step: 0.5 },
  'camera.damping': { label: 'Damping', min: 0.02, max: 0.5, step: 0.005 },
  'camera.lookahead': { label: 'Lookahead', min: 0, max: 1.5, step: 0.01 },
};

/* ------------------------------------------------------------------- helpers */

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepClone(v) {
  if (Array.isArray(v)) return v.map(deepClone);
  if (isPlain(v)) {
    const out = {};
    for (const k in v) out[k] = deepClone(v[k]);
    return out;
  }
  return v;
}

function deepFreeze(v) {
  if (isPlain(v) || Array.isArray(v)) {
    Object.freeze(v);
    for (const k in v) deepFreeze(v[k]);
  }
  return v;
}

/** Merge in place so any system holding `Settings.post` keeps a live reference. */
function mergeInto(target, patch) {
  for (const k in patch) {
    const v = patch[k];
    if (isPlain(v)) {
      if (!isPlain(target[k])) target[k] = {};
      mergeInto(target[k], v);
    } else if (Array.isArray(v)) {
      target[k] = v.slice();
    } else {
      target[k] = v;
    }
  }
  return target;
}

/** Merge, but only keys the defaults already declare, and only with the same
 *  primitive type. Stops a stale or hand-edited localStorage blob from
 *  injecting junk (or a string where a number is expected) into live config. */
function mergeKnown(target, patch, shape, path) {
  if (!isPlain(patch)) return;
  for (const k in patch) {
    if (!Object.prototype.hasOwnProperty.call(shape, k)) continue;
    const p = path ? path + '.' + k : k;
    const v = patch[k];
    const s = shape[k];
    if (isPlain(s)) {
      if (isPlain(v)) mergeKnown(target[k], v, s, p);
    } else if (typeof v === typeof s && (typeof v === 'number' ? Number.isFinite(v) : true)) {
      target[k] = clampToMeta(p, v);
    }
  }
}

function clampToMeta(path, v) {
  const m = META[path];
  if (!m) return v;
  if (typeof v === 'number') {
    if (m.options) return m.options.includes(v) ? v : m.options[m.options.length - 1];
    let x = v;
    if (typeof m.min === 'number') x = Math.max(m.min, x);
    if (typeof m.max === 'number') x = Math.min(m.max, x);
    return x;
  }
  if (typeof v === 'string' && m.options) return m.options.includes(v) ? v : m.options[0];
  return v;
}

function getPathIn(obj, path) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length; i++) {
    if (o == null) return undefined;
    o = o[parts[i]];
  }
  return o;
}

function setPathIn(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlain(o[parts[i]])) o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
  return obj;
}

function safeStorage() {
  try {
    const s = globalThis.localStorage;
    // Touch it: privacy modes throw on access, not on read of the property.
    s.getItem(STORAGE_KEY);
    return s;
  } catch (_) {
    return null;
  }
}

function urlParam(name) {
  try {
    return new URLSearchParams(globalThis.location?.search || '').get(name);
  } catch (_) {
    return null;
  }
}

/* ---------------------------------------------------------------- GPU probing */

/**
 * Cheap, bounded capability probe. Creates a throwaway context, reads the
 * unmasked renderer string and a couple of limits, then runs a very small
 * fill-rate benchmark. Never throws; always disposes its context.
 */
export function probeGpu() {
  const out = {
    renderer: '', vendor: '', webgl2: false, maxTexture: 0, maxVaryings: 0,
    floatLinear: false, cores: 4, memory: 4, dpr: 1, mobile: false,
    fillMs: 0, score: 0, ok: false,
  };
  try {
    out.cores = Math.max(1, globalThis.navigator?.hardwareConcurrency || 4);
    out.memory = globalThis.navigator?.deviceMemory || 4;
    out.dpr = globalThis.devicePixelRatio || 1;
    const ua = globalThis.navigator?.userAgent || '';
    out.mobile = /android|iphone|ipad|ipod|mobile|tablet/i.test(ua);
  } catch (_) { /* non-browser host */ }

  let gl = null;
  let canvas = null;
  try {
    if (typeof document === 'undefined') return out;
    canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const attrs = { antialias: false, depth: false, stencil: false, alpha: false, powerPreference: 'high-performance', failIfMajorPerformanceCaveat: false };
    gl = canvas.getContext('webgl2', attrs);
    out.webgl2 = !!gl;
    if (!gl) gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
    if (!gl) return out;
    out.ok = true;

    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) {
      out.renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
      out.vendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || '');
    }
    out.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) | 0;
    out.maxVaryings = gl.getParameter(gl.MAX_VARYING_VECTORS) | 0;
    out.floatLinear = !!gl.getExtension('OES_texture_float_linear');
    out.fillMs = benchFill(gl);
  } catch (_) {
    /* probing must never be fatal */
  } finally {
    try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch (_) { /* ignore */ }
    canvas = null;
  }

  out.score = scoreGpu(out);
  return out;
}

// Draw a handful of ALU-heavy full-screen quads and time the pipeline flush.
// Bounded to a few milliseconds on anything that can run this game at all.
function benchFill(gl) {
  const vs = 'attribute vec2 p;varying vec2 v;void main(){v=p*0.5+0.5;gl_Position=vec4(p,0.0,1.0);}';
  const fs = [
    'precision highp float;varying vec2 v;uniform float s;',
    'void main(){',
    '  vec3 c = vec3(0.0);',
    '  vec2 q = v;',
    '  for (int i = 0; i < 32; i++) {',
    '    q = abs(q) / dot(q, q) - vec2(0.7 + s * 0.01, 0.4);',
    '    c += 0.02 * vec3(q.x, q.y, q.x * q.y);',
    '  }',
    '  gl_FragColor = vec4(fract(c), 1.0);',
    '}',
  ].join('\n');

  const prog = gl.createProgram();
  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  };
  const v = compile(gl.VERTEX_SHADER, vs);
  const f = compile(gl.FRAGMENT_SHADER, fs);
  gl.attachShader(prog, v);
  gl.attachShader(prog, f);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    gl.deleteProgram(prog); gl.deleteShader(v); gl.deleteShader(f);
    return 0;
  }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const uS = gl.getUniformLocation(prog, 's');

  gl.viewport(0, 0, 256, 256);
  // Warm-up: first draw pays shader upload and driver setup.
  gl.uniform1f(uS, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const px = new Uint8Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);

  // 16 x 256² x 32 iterations: a few ms on a discrete GPU, tens on weak
  // integrated parts, which is exactly the signal we want — and bounded enough
  // that it never becomes a visible stall at boot.
  const t0 = performance.now();
  for (let i = 0; i < 16; i++) {
    gl.uniform1f(uS, i);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // forces a sync
  const ms = performance.now() - t0;

  gl.deleteBuffer(buf);
  gl.deleteProgram(prog);
  gl.deleteShader(v);
  gl.deleteShader(f);
  return +ms.toFixed(2);
}

function scoreGpu(p) {
  const r = (p.renderer + ' ' + p.vendor).toLowerCase();
  if (!p.ok) return -10;
  if (/swiftshader|llvmpipe|softwarerasterizer|software|basic render|microsoft basic/.test(r)) return -10;

  let s = 0;
  if (/rtx\s?[45]0|rtx\s?[45]\d{3}|radeon rx 7|radeon rx 9|arc a7|apple m[3-9]/.test(r)) s += 4;
  else if (/rtx|radeon rx 6|radeon rx 5[67]|arc a|apple m[12]|quadro|geforce gtx 1[06]|radeon pro/.test(r)) s += 3;
  else if (/geforce|radeon|nvidia|amd|adreno 7|apple gpu/.test(r)) s += 2;
  else if (/iris xe|iris plus|uhd graphics 7|adreno 6|mali-g7|mali-g[89]/.test(r)) s += 1;
  else if (/uhd graphics|hd graphics|mali|powervr|adreno/.test(r)) s -= 1;

  if (p.webgl2) s += 1;
  if (p.maxTexture >= 16384) s += 1;
  else if (p.maxTexture < 8192) s -= 2;
  if (p.cores >= 8) s += 1;
  if (p.memory >= 8) s += 1;
  else if (p.memory <= 2) s -= 2;
  if (p.mobile) s -= 3;

  // Thresholds are calibrated against benchFill's exact workload — change one
  // and you must change the other.
  if (p.fillMs > 0) {
    if (p.fillMs < 1.5) s += 2;
    else if (p.fillMs < 4) s += 1;
    else if (p.fillMs > 15) s -= 3;
    else if (p.fillMs > 8) s -= 1;
  }
  return s;
}

/** Pick a tier from the probe. Honours ?quality=high in the URL. */
export function autoDetect(probe) {
  const forced = (urlParam('quality') || '').toLowerCase();
  if (QUALITY.includes(forced)) return forced;
  const p = probe || probeGpu();
  const s = p.score;
  if (s <= -4) return 'low';
  if (s <= 1) return 'medium';
  if (s <= 4) return 'high';
  return 'ultra';
}

/* -------------------------------------------------------------------- object */

const _listeners = new Set();

export const Settings = {
  ...deepClone(DEFAULTS),

  /** Frozen copy of the shipped defaults, for reset and for diffing on save. */
  defaults: deepFreeze(deepClone(DEFAULTS)),
  QUALITY,
  META,

  /** Last GPU probe result, populated by detect(). */
  gpu: null,

  /** Merge a partial patch in place and notify. */
  patch(obj, ctx) {
    if (!isPlain(obj)) return this;
    mergeInto(this, obj);
    this.resolve();
    notify('patch', obj);
    if (ctx) this.apply(ctx);
    return this;
  },

  get(path) { return getPathIn(this, path); },

  /** Set one dotted path, clamped to its META range. Applies + persists. */
  set(path, value, ctx) {
    const v = clampToMeta(path, value);
    const before = getPathIn(this, path);
    if (before === v) return this;
    setPathIn(this, path, v);
    this.resolve();
    notify(path, v);
    if (ctx) this.apply(ctx);
    return this;
  },

  /** Deep clone of a tier patch. Never hands out a live reference. */
  forQuality(tier) {
    const t = TIERS[tier] ? tier : 'high';
    return deepClone(TIERS[t]);
  },

  /** Switch tier: reset the tier-owned groups to defaults, then apply the patch.
   *  Physics, audio, gameplay and camera are user preferences and survive. */
  setQuality(tier, ctx) {
    const t = QUALITY.includes(tier) ? tier : 'high';
    for (const group of ['render', 'post', 'textures', 'particles', 'world']) {
      mergeInto(this[group], deepClone(DEFAULTS[group]));
    }
    mergeInto(this, TIERS[t]);
    this.quality = t;
    this.resolve();
    notify('quality', t);
    if (ctx) {
      this.apply(ctx);
      ctx.bus?.emit?.('quality:changed', t);
    }
    this.save();
    return this;
  },

  /** Recompute derived values. Cheap; safe to call often. */
  resolve() {
    const r = this.render;
    const dpr = (typeof globalThis.devicePixelRatio === 'number' && globalThis.devicePixelRatio > 0)
      ? globalThis.devicePixelRatio : 1;
    r.pixelRatio = Math.min(4, Math.max(0.4, Math.min(dpr, r.maxPixelRatio) * r.renderScale));
    // Texture resolution can never exceed what the tier budgeted for.
    const t = this.textures;
    if (t.resolution > t.maxResolution) t.resolution = t.maxResolution;
    // Keep the per-kind particle caps inside the global budget.
    const kinds = this.particles.kinds;
    let sum = 0;
    for (const k in kinds) sum += kinds[k];
    this.particles.totalRequested = sum;
    this.physics.fixedDt = 1 / this.physics.fixedHz;
    return this;
  },

  /* ------------------------------------------------------------ persistence */

  load() {
    const store = safeStorage();
    if (!store) return this;
    try {
      const raw = store.getItem(STORAGE_KEY);
      if (!raw) return this;
      const data = JSON.parse(raw);
      if (!isPlain(data)) return this;
      // Re-seat on the tier first so a stored tier's shape is the baseline,
      // then layer the user's individual overrides on top.
      if (typeof data.quality === 'string' && QUALITY.includes(data.quality)) {
        for (const group of ['render', 'post', 'textures', 'particles', 'world']) {
          mergeInto(this[group], deepClone(DEFAULTS[group]));
        }
        mergeInto(this, TIERS[data.quality]);
        this.quality = data.quality;
      }
      mergeKnown(this, data, DEFAULTS, '');
      this.resolve();
      notify('load', data);
    } catch (err) {
      console.warn('[Settings] ignoring unreadable saved settings', err);
    }
    return this;
  },

  save() {
    const store = safeStorage();
    if (!store) return this;
    try {
      const out = { quality: this.quality };
      for (const group of ['render', 'post', 'textures', 'particles', 'world', 'physics', 'audio', 'gameplay', 'camera']) {
        out[group] = deepClone(this[group]);
      }
      delete out.render.pixelRatio;      // derived
      delete out.physics.fixedDt;        // derived
      delete out.particles.totalRequested;
      store.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch (err) {
      console.warn('[Settings] could not persist settings', err);
    }
    return this;
  },

  /** Back to shipped defaults at the current tier. */
  reset(ctx) {
    mergeInto(this, deepClone(DEFAULTS));
    this.setQuality(this.quality, ctx);
    try { safeStorage()?.removeItem(STORAGE_KEY); } catch (_) { /* ignore */ }
    return this;
  },

  /** Probe the GPU, pick a tier, keep any tier the user already chose. */
  detect(ctx, { force = false } = {}) {
    this.gpu = probeGpu();
    let stored = null;
    try { stored = safeStorage()?.getItem(STORAGE_KEY) ?? null; } catch (_) { stored = null; }
    // A tier the player chose themselves always beats the probe.
    if (!force && stored) return this.quality;
    const tier = autoDetect(this.gpu);
    this.setQuality(tier, ctx);
    return tier;
  },

  /* ------------------------------------------------------------ propagation */

  /**
   * Push the live values into whatever systems currently exist. Every call is
   * optional-chained: peers are built in parallel and may still be stubs.
   */
  apply(ctx) {
    this.resolve();
    if (!ctx) return this;

    const gl = resolveRenderer(ctx);
    if (gl) {
      try {
        gl.setPixelRatio?.(this.render.pixelRatio);
        if (typeof gl.toneMappingExposure === 'number') gl.toneMappingExposure = this.render.exposure;
        if (gl.shadowMap) {
          gl.shadowMap.enabled = !!this.render.shadows;
          gl.shadowMap.needsUpdate = true;
        }
      } catch (err) {
        console.warn('[Settings] renderer apply failed', err);
      }
    }

    // Wrapper hooks — each owner decides what a settings change means for it.
    ctx.renderer?.applySettings?.(this);
    ctx.renderer?.setQuality?.(this.quality);
    ctx.lighting?.setQuality?.(this.quality);
    ctx.lighting?.applySettings?.(this);
    ctx.postfx?.setQuality?.(this.quality);
    ctx.postfx?.applySettings?.(this);
    ctx.sky?.applySettings?.(this);
    ctx.materials?.setAnisotropy?.(this.render.anisotropy);
    ctx.textures?.setAnisotropy?.(this.render.anisotropy);
    ctx.fx?.particles?.setBudget?.(this.particles.budget, this.particles.kinds);
    ctx.fx?.particles?.applySettings?.(this);
    ctx.fx?.trails?.applySettings?.(this);
    ctx.props?.applySettings?.(this);
    ctx.decals?.applySettings?.(this);
    ctx.audio?.applySettings?.(this);
    ctx.audio?.setVolumes?.({
      master: this.audio.muted ? 0 : this.audio.master,
      music: this.audio.music,
      sfx: this.audio.sfx,
      engine: this.audio.engine,
      ambience: this.audio.ambience,
    });
    ctx.hud?.applySettings?.(this);
    ctx.director?.applySettings?.(this);
    ctx.engine?.setFixedHz?.(this.physics.fixedHz);

    if (ctx.camera && ctx.camera.isPerspectiveCamera) {
      const c = this.camera;
      let dirty = false;
      if (ctx.camera.near !== c.near) { ctx.camera.near = c.near; dirty = true; }
      if (ctx.camera.far !== c.far) { ctx.camera.far = c.far; dirty = true; }
      if (dirty) ctx.camera.updateProjectionMatrix();
    }

    ctx.bus?.emit?.('settings:applied', this);
    return this;
  },

  /** Subscribe to any mutation made through set/patch/setQuality/load. */
  onChange(cb) {
    if (typeof cb !== 'function') return () => {};
    _listeners.add(cb);
    return () => _listeners.delete(cb);
  },

  /** Every tunable path, for the debug panel and the options menu. */
  paths() { return Object.keys(META); },

  describe(path) { return META[path] || null; },

  /** Compact snapshot for logging / bug reports. */
  snapshot() {
    return {
      quality: this.quality,
      pixelRatio: this.render.pixelRatio,
      shadowMapSize: this.render.shadowMapSize,
      anisotropy: this.render.anisotropy,
      textures: this.textures.resolution,
      particles: this.particles.budget,
      gpu: this.gpu ? { renderer: this.gpu.renderer, score: this.gpu.score, fillMs: this.gpu.fillMs } : null,
    };
  },
};

function notify(path, value) {
  for (const cb of _listeners) {
    try { cb(path, value, Settings); } catch (err) { console.warn('[Settings] change listener threw', err); }
  }
}

/** ctx.renderer may be the raw WebGLRenderer or A2's wrapper around one. */
export function resolveRenderer(ctx) {
  const r = ctx?.renderer;
  if (!r) return null;
  if (r.isWebGLRenderer) return r;
  if (r.renderer?.isWebGLRenderer) return r.renderer;
  if (r.gl?.isWebGLRenderer) return r.gl;
  if (typeof r.setPixelRatio === 'function' && typeof r.setSize === 'function') return r;
  return null;
}

Settings.resolve();

export default Settings;
