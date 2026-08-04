// Post-processing for MICRO GAUNTLET.
//
// Chain (fixed by the architecture contract, do not reorder):
//
//   RenderPass -> GTAO/SSAO -> specular-thresholded Bloom -> tilt-shift DOF
//   -> motion blur -> colour grade -> chromatic aberration -> vignette
//   -> film grain -> [CRT] -> SMAA -> OutputPass
//
// Colour space through the chain: the composer buffers are linear HDR (three only
// tone maps draws that target the canvas, so RenderPass output is untouched
// radiance). The grade pass owns exposure + ACES and emits display-referred
// linear; everything after it works in that space, and OutputPass is reduced to
// the sRGB transfer by temporarily parking renderer.toneMapping on NoToneMapping
// for the duration of the composer render.
//
// Nothing here is allowed to blank the screen. Every pass is built inside a
// try/catch, every hand-written pass is compiled once against a 4x4 probe target
// before it joins the chain, and render() degrades to a plain
// renderer.render(scene, camera) if the composer ever throws.
//
// Two numbers in this file are load-bearing and are documented where they live,
// because getting either wrong makes the frame look competent instead of made:
//   - the tilt-shift focus band, whose units are spelled out above TILT_FRAG;
//   - the bloom gate, solved against exposure in _updateUniforms so it keys off
//     speculars rather than off whatever the light rig is currently doing.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ========================================================================== */
/* Shared shader fragments                                                    */
/* ========================================================================== */

const POST_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const LUMA = /* glsl */ `
const vec3 MG_LUMA = vec3( 0.2126, 0.7152, 0.0722 );
float mgLuma( vec3 c ) { return dot( c, MG_LUMA ); }
`;

const HASH = /* glsl */ `
float mgHash13( vec3 p ) {
  p = fract( p * 0.1031 );
  p += dot( p, p.zyx + 31.32 );
  return fract( ( p.x + p.y ) * p.z );
}
`;

/* ========================================================================== */
/* 1. Bloom: specular-keyed high pass                                         */
/* ========================================================================== */

/**
 * Replacement for UnrealBloomPass's LuminosityHighPassShader.
 *
 * A pure luminance threshold blooms anything bright, which over a sunlit wooden
 * table means the whole table. What we actually want to bloom is specular: small,
 * very bright features that pop out of a darker surround and trend toward the
 * light's own colour rather than the surface albedo. Both of those are
 * measurable from the colour buffer alone.
 */
const SpecularHighPassShader = {
  name: 'MG.SpecularHighPass',
  uniforms: {
    tDiffuse: { value: null },
    // Overwritten every frame from PostFX._updateUniforms: UnrealBloomPass
    // copies its own `threshold` into this uniform on each render, so the
    // exposure-solved value has to be written to the pass, not to the uniform.
    luminosityThreshold: { value: 1.8 },
    smoothWidth: { value: 0.9 },
    texelSize: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    specularity: { value: 1.0 },
  },
  vertexShader: POST_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float luminosityThreshold;
    uniform float smoothWidth;
    uniform vec2 texelSize;
    uniform float specularity;
    varying vec2 vUv;
    ${LUMA}

    void main() {
      vec3 c = texture2D( tDiffuse, vUv ).rgb;
      float l = mgLuma( c );

      // Neighbourhood luminance at two radii.
      float n = 0.0;
      n += mgLuma( texture2D( tDiffuse, vUv + vec2(  3.0,  0.0 ) * texelSize ).rgb );
      n += mgLuma( texture2D( tDiffuse, vUv + vec2( -3.0,  0.0 ) * texelSize ).rgb );
      n += mgLuma( texture2D( tDiffuse, vUv + vec2(  0.0,  3.0 ) * texelSize ).rgb );
      n += mgLuma( texture2D( tDiffuse, vUv + vec2(  0.0, -3.0 ) * texelSize ).rgb );
      n += mgLuma( texture2D( tDiffuse, vUv + vec2(  7.0,  7.0 ) * texelSize ).rgb );
      n += mgLuma( texture2D( tDiffuse, vUv + vec2( -7.0,  7.0 ) * texelSize ).rgb );
      n += mgLuma( texture2D( tDiffuse, vUv + vec2(  7.0, -7.0 ) * texelSize ).rgb );
      n += mgLuma( texture2D( tDiffuse, vUv + vec2( -7.0, -7.0 ) * texelSize ).rgb );
      n *= 0.125;

      // How far this pixel stands proud of its surround, relative to it.
      float pop = clamp( ( l - n ) / max( n + 0.10, 1e-3 ), 0.0, 1.0 );

      float mx = max( c.r, max( c.g, c.b ) );
      float mn = min( c.r, min( c.g, c.b ) );
      float sat = ( mx - mn ) / max( mx, 1e-4 );

      // Two independent ways to be a specular. A small clearcoat glint stands
      // far proud of its surround but may only just clear the gate; a broad
      // blown highlight sits well past the gate but has a bright neighbourhood,
      // so the local-contrast test alone would reject it. Taking the max means
      // a merely-bright diffuse surface -- a sunlit table, which is most of the
      // frame -- satisfies neither and contributes nothing.
      float over = clamp( ( l - luminosityThreshold ) / max( luminosityThreshold, 1e-3 ), 0.0, 1.0 );
      float spec = max( smoothstep( 0.10, 0.55, pop ), over * over );

      // A specular takes the light's colour and so is less saturated than the
      // paint under it; saturated brightness is usually just bright pigment.
      spec *= 1.0 - sat * 0.35;

      float key = mix( 1.0, spec, specularity );
      float gate = smoothstep( luminosityThreshold, luminosityThreshold + smoothWidth, l );

      gl_FragColor = vec4( c * gate * key, 1.0 );
    }
  `,
};

/* ========================================================================== */
/* 2. Tilt-shift depth of field                                               */
/* ========================================================================== */

/*
 * THE UNIT CONTRACT FOR THE FOCUS BAND. Read before touching setFocusBand().
 *
 * `uBandWidth` and `uRamp` are distances in *normalised frame height* (uv.y).
 * `uPower` is a dimensionless exponent. Callers outside this module — Director
 * and Menu — hand us `Settings.post.params.tiltShiftFalloff`, which that file
 * documents as "quadratic ramp away from the band", i.e. an exponent, and ships
 * as 2. An earlier revision wrote that 2 straight into the ramp *distance*,
 * which is authored at 0.20 uv. The effect died silently and completely:
 *
 *   at uv.y 0.90 with the band on 0.52, band 0.22, ramp 2.0
 *     dist = 0.38, t = (0.38 - 0.22) / 2.0 = 0.080, coc = 0.0064
 *     radius = 0.0064 * 16.7 px = 0.11 px  ->  under the early-out, no blur
 *
 * Nothing anywhere in the frame cleared the early-out, so every pixel took the
 * passthrough branch and the signature effect was a no-op that still cost a
 * full-resolution copy. setFocusBand() now owns the conversion and clamps every
 * value it is handed; the ramp distance is never settable from outside.
 *
 * END-TO-END, 1920x1080, ultra, chase camera. Every number below is what the
 * shader actually sees, traced from the two places they come from:
 *
 *   uMaxRadius  Capture.js pins pixelRatio to 1 and setSize(1920,1080), then
 *               Engine.onResize forwards 1920x1080 to PostFX.onResize (PostFX is
 *               not a registered system, so it is reached by the explicit tail
 *               call in Engine.onResize). pr = 1, dh = 1080.
 *                 uMaxRadius = max( 4, 1080 * 0.0155 ) = 16.74 px
 *   uBandWidth  Director._feedFocusBand: 0.22 * (1 - 0.22 * speedNorm),
 *               so 0.172 flat out and 0.22 at rest -> clamped to 0.210.
 *   uPower      Director passes Settings' 2 -> clamp(2,1,4) = 2, quadratic.
 *   uRamp       0.200, owned here.
 *   uFocusCenter  tracks the player; ~0.45 in the reviewed chase frames.
 *
 *   coc(y) = clamp( ( ( |y - 0.45| - 0.210 ) / 0.200 )^2, 0, 1 )
 *
 *     y      dist    t      coc      radius
 *     0.66   0.21    0.00   0.000     0.00 px   band edge, fully sharp
 *     0.70   0.25    0.20   0.040     0.67 px   just past the early-out
 *     0.75   0.30    0.45   0.203     3.39 px
 *     0.85   0.40    0.95   0.903    15.11 px
 *     0.90   0.45    1.00   1.000    16.74 px   <- was 0.11 px, a 150x miss
 *     0.95   0.50    1.00   1.000    16.74 px   <- the oak grain in crit-1
 *
 *   Sharp band solves to y in [0.213, 0.687] — 47% of frame height in focus,
 *   the rest ramping quadratically to a 16.74 px kernel. 27 taps per direction
 *   at 16.74 / 13 = 1.29 px spacing, applied separably.
 */

const TILT_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2  uTexel;
uniform vec2  uDirection;
uniform vec2  uBandDir;      // ( sin, cos ) of the band angle
uniform float uFocusCenter;
uniform float uBandWidth;    // half-height of the sharp band, in uv.y
uniform float uRamp;         // uv.y distance over which coc climbs 0 -> 1
uniform float uPower;        // ramp exponent; 2 = quadratic
uniform float uMaxRadius;    // blur radius at coc 1, in device pixels
uniform float uAspect;
uniform float uHighlight;
uniform float uHlKnee;
uniform float uEdge;
varying vec2 vUv;
${HASH}

// Circle of confusion from the tilt-shift gradient alone: distance from a tilted
// in-focus strip, ramped quadratically. This is what sells the miniature — a real
// macro lens has a plane of focus, and the eye reads a horizontally banded blur
// as "tiny object, lens very close".
float mgCoc( vec2 uv ) {
  vec2 d = vec2( ( uv.x - 0.5 ) * uAspect, uv.y - uFocusCenter );
  float dist = abs( d.y * uBandDir.y - d.x * uBandDir.x );
  float t = clamp( max( dist - uBandWidth, 0.0 ) / max( uRamp, 1e-3 ), 0.0, 1.0 );
  // Base is floored off zero: pow( 0.0, x ) is not required to be well defined
  // and returns NaN on some drivers, and a NaN here would propagate through the
  // whole kernel weight sum.
  float coc = clamp( pow( max( t, 1e-5 ), uPower ), 0.0, 1.0 );

  // A touch of corner defocus: even inside the strip a fast lens is not sharp
  // right out to the frame edge.
  float r = length( vec2( ( uv.x - 0.5 ) * uAspect, uv.y - 0.5 ) );
  coc = clamp( coc + uEdge * smoothstep( 0.42, 0.95, r ) * ( 1.0 - coc ), 0.0, 1.0 );
  return coc;
}

void main() {
  float coc = mgCoc( vUv );
  vec3 centre = texture2D( tDiffuse, vUv ).rgb;
  float radius = coc * uMaxRadius;

  // A third of a pixel is the point below which a gather cannot move anything;
  // it must stay well under one pixel or the band edge becomes a visible seam
  // where blur switches on.
  if ( radius < 0.30 ) {
    gl_FragColor = vec4( centre, 1.0 );
    return;
  }

  float taps = float( MG_DOF_TAPS );
  vec2 stepUv = uDirection * uTexel * ( radius / taps );

  // Dither the tap phase by up to half a step. At full radius the taps land
  // ~1.3 px apart, which without this reads as concentric steps inside a bokeh
  // disc. The hash is spatial only — no time term — so the noise is stable
  // between frames and a still capture is reproducible.
  float jitter = mgHash13( vec3( gl_FragCoord.xy, 7.13 ) ) - 0.5;

  vec3 sum = vec3( 0.0 );
  float wsum = 0.0;

  for ( int i = -MG_DOF_TAPS; i <= MG_DOF_TAPS; i ++ ) {
    float fi = ( float( i ) + jitter ) / taps;
    vec2 uv = vUv + stepUv * ( float( i ) + jitter );
    vec3 s = texture2D( tDiffuse, uv ).rgb;

    // Flat-top kernel with a hard rim. Applied separably this converges on a
    // squircle rather than the pointy Gaussian profile that turns bokeh into
    // mush, so out-of-focus highlights keep a defined edge.
    float k = 1.0 - smoothstep( 0.82, 1.0, abs( fi ) );

    // Scatter-as-gather guard: a sharp pixel must not bleed into a blurred one,
    // only the other way round.
    k *= clamp( mgCoc( uv ) / max( coc, 1e-3 ), 0.10, 1.0 );

    // Weight highlights up before averaging so they resolve as bright discs
    // instead of being diluted by their dark surround. This buffer is linear
    // HDR, where a clearcoat glint can be fifty times diffuse white, so the
    // weight has to saturate: unbounded, one pixel would own the entire kernel
    // and erase everything around it instead of forming a disc inside it.
    float lum = max( max( s.r, s.g ), s.b );
    float hl = max( lum - uHlKnee, 0.0 );
    float hw = 1.0 + uHighlight * ( hl / ( hl + 1.0 ) );

    float w = k * hw;
    sum += s * w;
    wsum += w;
  }

  gl_FragColor = vec4( sum / max( wsum, 1e-4 ), 1.0 );
}
`;

/** Half-height of the sharp band, in uv.y. Clamps whatever a peer hands us. */
const BAND_MIN = 0.040;
const BAND_MAX = 0.210;
/** uv.y distance over which coc climbs 0 -> 1. Owned here; art direction. */
const DOF_RAMP = 0.200;

/**
 * Separable two-pass tilt-shift DOF. Owns its own intermediate target because a
 * pair of ShaderPasses would ping-pong the composer buffers and force the second
 * direction to read a half-finished frame.
 */
class TiltShiftPass extends Pass {
  constructor(width, height, taps = 8) {
    super();
    this.name = 'MG.TiltShift';
    this.needsSwap = true;

    this.uniforms = {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2(1 / width, 1 / height) },
      uDirection: { value: new THREE.Vector2(1, 0) },
      uBandDir: { value: new THREE.Vector2(0, 1) },
      uFocusCenter: { value: 0.52 },
      uBandWidth: { value: 0.130 },
      uRamp: { value: DOF_RAMP },
      uPower: { value: 2.0 },
      uMaxRadius: { value: 16 },
      uAspect: { value: width / Math.max(1, height) },
      uHighlight: { value: 2.2 },
      uHlKnee: { value: 0.85 },
      uEdge: { value: 0.16 },
    };

    const make = (dir) => {
      const u = THREE.UniformsUtils.clone(this.uniforms);
      // Everything except tDiffuse and uDirection is shared by reference so a
      // single write in JS reaches both directions.
      for (const k in u) {
        if (k !== 'tDiffuse' && k !== 'uDirection') u[k] = this.uniforms[k];
      }
      u.uDirection.value.copy(dir);
      return new THREE.ShaderMaterial({
        name: 'MG.TiltShift',
        defines: { MG_DOF_TAPS: taps },
        uniforms: u,
        vertexShader: POST_VERT,
        fragmentShader: TILT_FRAG,
        depthTest: false,
        depthWrite: false,
      });
    };

    this.materialH = make(new THREE.Vector2(1, 0));
    this.materialV = make(new THREE.Vector2(0, 1));

    this.rt = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.rt.texture.name = 'MG.TiltShift.h';
    this.rt.texture.generateMipmaps = false;

    this._quad = new FullScreenQuad(null);
  }

  setSize(width, height) {
    this.rt.setSize(width, height);
    this.uniforms.uTexel.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
    this.uniforms.uAspect.value = width / Math.max(1, height);
  }

  setTaps(taps) {
    this.materialH.defines.MG_DOF_TAPS = taps;
    this.materialV.defines.MG_DOF_TAPS = taps;
    this.materialH.needsUpdate = true;
    this.materialV.needsUpdate = true;
  }

  render(renderer, writeBuffer, readBuffer) {
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;

    this.materialH.uniforms.tDiffuse.value = readBuffer.texture;
    this._quad.material = this.materialH;
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    this._quad.render(renderer);

    this.materialV.uniforms.tDiffuse.value = this.rt.texture;
    this._quad.material = this.materialV;
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
    }
    this._quad.render(renderer);

    renderer.autoClear = autoClear;
  }

  dispose() {
    this.rt.dispose();
    this.materialH.dispose();
    this.materialV.dispose();
    // Deliberately not this._quad.dispose(): FullScreenQuad.dispose() frees the
    // module-level fullscreen triangle that every pass in the addon shares, so
    // one pass tearing down pulls the geometry out from under the rest of the
    // chain. three re-uploads it lazily, but only after the buffers have been
    // deleted and recreated once per disposed pass.
  }
}

/* ========================================================================== */
/* 3. Camera motion blur                                                      */
/* ========================================================================== */

/**
 * Camera-velocity reprojection without a depth buffer.
 *
 * Almost every pixel in this game is the playfield, and the tallest thing on it
 * is ~3 u against a ~130 u camera distance, so reprojecting each screen ray
 * through the ground plane recovers per-pixel camera velocity to well within a
 * pixel. That removes the need to thread a depth attachment through a
 * ping-ponging composer, which is where this kind of pass usually breaks.
 */
const MotionBlurShader = {
  name: 'MG.MotionBlur',
  defines: { MG_MB_TAPS: 9 },
  uniforms: {
    tDiffuse: { value: null },
    uInvViewProj: { value: new THREE.Matrix4() },
    uPrevViewProj: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() },
    uPlaneY: { value: 0 },
    uStrength: { value: 0.45 },
    uMaxVel: { value: 0.03 },
    uJitter: { value: 0 },
  },
  vertexShader: POST_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform mat4  uInvViewProj;
    uniform mat4  uPrevViewProj;
    uniform vec3  uCamPos;
    uniform float uPlaneY;
    uniform float uStrength;
    uniform float uMaxVel;
    uniform float uJitter;
    varying vec2 vUv;
    ${HASH}

    void main() {
      vec4 src = texture2D( tDiffuse, vUv );

      vec2 ndc = vUv * 2.0 - 1.0;
      vec4 farPoint = uInvViewProj * vec4( ndc, 1.0, 1.0 );
      vec3 world = farPoint.xyz / farPoint.w;
      vec3 dir = normalize( world - uCamPos );

      float denom = dir.y;
      float t = ( abs( denom ) > 1e-4 ) ? ( uPlaneY - uCamPos.y ) / denom : -1.0;
      vec3 P = ( t > 0.0 ) ? uCamPos + dir * t : uCamPos + dir * 1200.0;

      vec4 prev = uPrevViewProj * vec4( P, 1.0 );
      if ( prev.w <= 1e-4 ) { gl_FragColor = src; return; }
      vec2 prevUv = ( prev.xy / prev.w ) * 0.5 + 0.5;

      vec2 vel = ( vUv - prevUv ) * uStrength;
      float len = length( vel );
      if ( len < 0.0007 ) { gl_FragColor = src; return; }
      if ( len > uMaxVel ) vel *= uMaxVel / len;

      // Jitter the tap phase so a short blur reads as blur, not as ghosting.
      float j = mgHash13( vec3( gl_FragCoord.xy, uJitter ) );

      vec3 sum = vec3( 0.0 );
      for ( int i = 0; i < MG_MB_TAPS; i ++ ) {
        float f = ( float( i ) + j ) / float( MG_MB_TAPS ) - 0.5;
        sum += texture2D( tDiffuse, vUv - vel * f ).rgb;
      }
      gl_FragColor = vec4( sum / float( MG_MB_TAPS ), src.a );
    }
  `,
};

/* ========================================================================== */
/* 4. Colour grade                                                            */
/* ========================================================================== */

const GradeShader = {
  name: 'MG.Grade',
  uniforms: {
    tDiffuse: { value: null },
    tLut: { value: null },
    uLutSize: { value: 32 },
    uLutAmount: { value: 1.0 },
    uExposure: { value: 1.0 },
    uLookExposure: { value: 1.0 },
    uToe: { value: new THREE.Vector3(0.016, 0.018, 0.024) },
    uLift: { value: new THREE.Vector3(0, 0, 0) },
    uGamma: { value: new THREE.Vector3(1, 1, 1) },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
    uContrast: { value: 1.0 },
    uSaturation: { value: 1.0 },
    uBalance: { value: new THREE.Vector2(0, 0) },
    uShadowTint: { value: new THREE.Vector3(1, 1, 1) },
    uMidTint: { value: new THREE.Vector3(1, 1, 1) },
    uHighTint: { value: new THREE.Vector3(1, 1, 1) },
  },
  vertexShader: POST_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tLut;
    uniform float uLutSize;
    uniform float uLutAmount;
    uniform float uExposure;
    uniform float uLookExposure;
    uniform vec3  uToe;
    uniform vec3  uLift;
    uniform vec3  uGamma;
    uniform vec3  uGain;
    uniform float uContrast;
    uniform float uSaturation;
    uniform vec2  uBalance;
    uniform vec3  uShadowTint;
    uniform vec3  uMidTint;
    uniform vec3  uHighTint;
    varying vec2 vUv;
    ${LUMA}

    // Same fit three uses for ACESFilmicToneMapping, reproduced here so the
    // no-post path and the graded path agree on the curve.
    const mat3 MG_ACES_IN = mat3(
      vec3( 0.59719, 0.07600, 0.02840 ),
      vec3( 0.35458, 0.90834, 0.13383 ),
      vec3( 0.04823, 0.01566, 0.83777 )
    );
    const mat3 MG_ACES_OUT = mat3(
      vec3(  1.60475, -0.10208, -0.00327 ),
      vec3( -0.53108,  1.10813, -0.07276 ),
      vec3( -0.07367, -0.00605,  1.07602 )
    );

    vec3 mgRRTAndODTFit( vec3 v ) {
      vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
      vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
      return a / b;
    }

    vec3 mgACES( vec3 color ) {
      color = MG_ACES_IN * color;
      color = mgRRTAndODTFit( color );
      color = MG_ACES_OUT * color;
      return clamp( color, 0.0, 1.0 );
    }

    // The LUT is a 32^3 cube stored as a horizontal strip of blue slices:
    // width = size*size, height = size. Hardware filtering covers red and green;
    // blue is blended between the two neighbouring slices by hand.
    vec3 mgSampleLut( vec3 c ) {
      float size = uLutSize;
      c = clamp( c, 0.0, 1.0 );

      float sliceW = 1.0 / size;
      float texelW = sliceW / size;
      float innerW = texelW * ( size - 1.0 );

      float zPos = c.b * ( size - 1.0 );
      float z0 = floor( zPos );
      float z1 = min( z0 + 1.0, size - 1.0 );
      float fz = zPos - z0;

      float xo = texelW * 0.5 + c.r * innerW;
      float v = ( 0.5 + c.g * ( size - 1.0 ) ) / size;

      vec3 s0 = texture2D( tLut, vec2( xo + z0 * sliceW, v ) ).rgb;
      vec3 s1 = texture2D( tLut, vec2( xo + z1 * sliceW, v ) ).rgb;
      return mix( s0, s1, fz );
    }

    void main() {
      vec3 c = max( texture2D( tDiffuse, vUv ).rgb, vec3( 0.0 ) );

      // --- scene-referred ---------------------------------------------------
      // uLookExposure is the per-preset key trim (0.96 at noon, 1.04 under
      // overcast): the frame is keyed on purpose rather than by whatever the
      // light rig happened to leave toneMappingExposure at.
      c *= ( uExposure * uLookExposure ) / 0.6;
      // White balance: cheap channel scaling is enough at this magnitude and
      // avoids two matrix multiplies per pixel.
      c *= vec3( 1.0 + uBalance.x * 0.14, 1.0 + uBalance.y * 0.07, 1.0 - uBalance.x * 0.14 );

      c = mgACES( c );

      // --- display-referred -------------------------------------------------
      c = clamp( c * uGain + uLift, 0.0, 1.0 );
      c = pow( c, 1.0 / max( uGamma, vec3( 1e-3 ) ) );
      c = clamp( ( c - 0.435 ) * uContrast + 0.435, 0.0, 1.0 );

      // Film has no true black: a projected frame sits around 2% and the shadow
      // keeps the colour of whatever is filling it. Lifting the toe here — after
      // contrast, so nothing downstream can pull it back to zero — is the
      // difference between a shadow and a hole, and the tint is the single
      // strongest cue that five differently-lit tracks are one product.
      c = uToe + c * ( 1.0 - uToe );

      float l = mgLuma( c );
      float wS = 1.0 - smoothstep( 0.0, 0.44, l );
      float wH = smoothstep( 0.50, 1.0, l );
      float wM = max( 1.0 - wS - wH, 0.0 );
      c *= uShadowTint * wS + uMidTint * wM + uHighTint * wH;
      c = clamp( c, 0.0, 1.0 );

      float lum = mgLuma( c );
      // Bleach the very brightest values: film loses colour before it clips, and
      // without this every specular goes a hard tinted white.
      float satAmt = uSaturation * ( 1.0 - smoothstep( 0.74, 1.0, lum ) * 0.55 );
      c = clamp( mix( vec3( lum ), c, satAmt ), 0.0, 1.0 );

      c = mix( c, mgSampleLut( c ), uLutAmount );

      gl_FragColor = vec4( c, 1.0 );
    }
  `,
};

/* ========================================================================== */
/* 5. Chromatic aberration / 6. Vignette / 7. Grain / 8. CRT                   */
/* ========================================================================== */

const ChromaticShader = {
  name: 'MG.Chromatic',
  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    uAmount: { value: 1.7 },
    uFringe: { value: 0.35 },
  },
  vertexShader: POST_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform float uAmount;
    uniform float uFringe;
    varying vec2 vUv;

    void main() {
      vec2 c = vUv - 0.5;
      // Lateral chromatic aberration grows with the square of field height,
      // which is why it is invisible at the centre and obvious in the corners.
      vec2 off = c * dot( c, c ) * 4.0 * uTexel * uAmount;

      float r = texture2D( tDiffuse, vUv + off * ( 1.0 + uFringe ) ).r;
      vec2 ga = texture2D( tDiffuse, vUv ).ga;
      float b = texture2D( tDiffuse, vUv - off * ( 1.0 - uFringe * 0.5 ) ).b;

      gl_FragColor = vec4( r, ga.x, b, ga.y );
    }
  `,
};

const VignetteShader = {
  name: 'MG.Vignette',
  uniforms: {
    tDiffuse: { value: null },
    // Lighter than a stills vignette on purpose. The toe lift in the grade is
    // what keeps shadows readable, and a heavy corner falloff on top of it just
    // eats the environment the frame is meant to be showing. At 16:9 the corner
    // lands at d = 0.90, which smoothsteps to 0.91 of full effect: corners sit
    // at 73% luma, dark enough to hold the eye centre, light enough to read.
    uAmount: { value: 0.30 },
    uInner: { value: 0.36 },
    uOuter: { value: 1.02 },
    uRoundness: { value: 0.35 },
    uAspect: { value: 16 / 9 },
    uDesat: { value: 0.24 },
  },
  vertexShader: POST_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uAmount;
    uniform float uInner;
    uniform float uOuter;
    uniform float uRoundness;
    uniform float uAspect;
    uniform float uDesat;
    varying vec2 vUv;
    ${LUMA}

    void main() {
      vec4 src = texture2D( tDiffuse, vUv );
      vec2 p = vUv - 0.5;
      p.x *= mix( uAspect, 1.0, uRoundness );
      float d = length( p );

      float f = smoothstep( uInner, uOuter, d );
      float v = 1.0 - uAmount * f;

      // Corners lose saturation as well as light; a pure multiply reads as a
      // sticker over the image.
      vec3 c = mix( src.rgb, vec3( mgLuma( src.rgb ) ), f * uDesat );
      gl_FragColor = vec4( c * v, src.a );
    }
  `,
};

const GrainShader = {
  name: 'MG.Grain',
  uniforms: {
    tDiffuse: { value: null },
    uAmount: { value: 0.032 },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1920, 1080) },
    uSize: { value: 1.35 },
  },
  vertexShader: POST_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uAmount;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uSize;
    varying vec2 vUv;
    ${LUMA}
    ${HASH}

    void main() {
      vec4 src = texture2D( tDiffuse, vUv );
      // Quantised to 24 steps a second: grain that updates every frame at 60 fps
      // reads as electronic noise, not film.
      vec2 cell = floor( vUv * uResolution / max( uSize, 1.0 ) );
      float n = mgHash13( vec3( cell, floor( uTime * 24.0 ) ) ) * 2.0 - 1.0;

      float lum = mgLuma( src.rgb );
      float w = smoothstep( 0.0, 0.20, lum ) * ( 1.0 - smoothstep( 0.60, 1.0, lum ) * 0.80 );

      gl_FragColor = vec4( clamp( src.rgb + n * uAmount * w, 0.0, 1.0 ), src.a );
    }
  `,
};

const CrtShader = {
  name: 'MG.Crt',
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1920, 1080) },
    uAmount: { value: 0.0 },
    uScanline: { value: 0.34 },
    uCurvature: { value: 0.85 },
    uMask: { value: 0.55 },
  },
  vertexShader: POST_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uAmount;
    uniform float uScanline;
    uniform float uCurvature;
    uniform float uMask;
    varying vec2 vUv;

    vec2 mgCurve( vec2 uv, float k ) {
      uv = uv * 2.0 - 1.0;
      vec2 o = abs( uv.yx ) / vec2( 5.4, 4.2 );
      uv += uv * o * o * k;
      return uv * 0.5 + 0.5;
    }

    void main() {
      if ( uAmount <= 0.001 ) {
        gl_FragColor = texture2D( tDiffuse, vUv );
        return;
      }

      vec2 uv = mix( vUv, mgCurve( vUv, uCurvature ), uAmount );
      vec3 c = texture2D( tDiffuse, clamp( uv, 0.0, 1.0 ) ).rgb;
      if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) c = vec3( 0.0 );

      float sl = 0.5 + 0.5 * cos( uv.y * uResolution.y * 3.14159265 );
      c *= mix( 1.0, 1.0 - uScanline * sl, uAmount );

      // Aperture grille, normalised so the mask darkens rather than tints.
      float px = mod( uv.x * uResolution.x, 3.0 );
      vec3 grille = vec3( 1.0 ) - vec3(
        smoothstep( 0.0, 1.0, abs( px - 0.5 ) ),
        smoothstep( 0.0, 1.0, abs( px - 1.5 ) ),
        smoothstep( 0.0, 1.0, abs( px - 2.5 ) )
      );
      c *= mix( vec3( 1.0 ), 0.62 + grille * 0.95, uMask * uAmount );

      gl_FragColor = vec4( c, 1.0 );
    }
  `,
};

/* ========================================================================== */
/* Looks: grade parameters + procedural LUTs                                  */
/* ========================================================================== */

/**
 * One entry per lighting preset. `cdl` drives the analytic part of the grade
 * (uniforms, cheap to animate); `lut` drives the baked 3D table (expressive,
 * regenerated only when the look changes); `toe`, `exposure` and `bloomKnee`
 * are the three levers that give a preset an actual point of view.
 *
 * The house signature, held constant across all seven so that five tracks read
 * as one art-directed product rather than five demos:
 *
 *   - The toe is always lifted and always cooler than the midtones. Nothing in
 *     this game is allowed to fall into a black hole; a shadow is air, and air
 *     here is blue. `crush` is zero everywhere — it was the wrong tool.
 *   - Highlights always run warmer than the midtones and always bleach toward
 *     white in the top quarter, so a specular reads as light rather than as
 *     tinted paper.
 *   - Contrast never sits below 1.10. The earlier tables ran 1.02–1.16, which
 *     is inside the noise floor of the tone curve and is exactly why a reviewer
 *     called the grade intentionless.
 *   - `exposure` is a per-preset key trim on top of whatever Lighting sets, so
 *     the brightest presets are pulled back deliberately instead of blowing.
 *   - `bloomKnee` is in *graded-linear* units (see _updateUniforms): the value
 *     a pixel must reach after exposure and before ACES to start blooming.
 *     3.1 tonemaps to ~0.90 display, i.e. only the top of the curve.
 */
export const GRADE_LOOKS = {
  neutral: {
    cdl: { lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1], contrast: 1.06, saturation: 1.04, balance: [0, 0] },
    lut: {
      shadow: [0.96, 0.99, 1.06], mid: [1, 1, 1], high: [1.02, 1.01, 0.99],
      sat: 1.04, contrast: 1.06, crush: 0.0, bleach: 0.10,
    },
    toe: [0.016, 0.018, 0.024], exposure: 1.00, bloom: 0.45, bloomKnee: 3.1,
  },
  // Low warm window light raking across the table, cool skylight in the shade.
  morning: {
    cdl: {
      lift: [-0.004, -0.001, 0.008], gamma: [1.0, 1.0, 1.02], gain: [1.050, 1.005, 0.950],
      contrast: 1.13, saturation: 1.12, balance: [0.13, -0.02],
    },
    lut: {
      shadow: [0.86, 0.94, 1.20], mid: [1.03, 1.0, 0.965], high: [1.09, 1.02, 0.900],
      sat: 1.10, contrast: 1.12, crush: 0.0, bleach: 0.16,
    },
    toe: [0.018, 0.021, 0.032], exposure: 1.00, bloom: 0.45, bloomKnee: 3.1,
  },
  // Hard overhead sun. Whites stay white, shade goes properly blue, and the key
  // trim pulls the brightest preset back rather than letting it blow.
  noon: {
    cdl: {
      lift: [-0.002, -0.001, 0.006], gamma: [1, 1, 1], gain: [1.015, 1.005, 0.995],
      contrast: 1.16, saturation: 1.10, balance: [0.03, 0.0],
    },
    lut: {
      shadow: [0.90, 0.96, 1.16], mid: [1.0, 1.0, 1.0], high: [1.03, 1.015, 0.980],
      sat: 1.08, contrast: 1.14, crush: 0.0, bleach: 0.14,
    },
    toe: [0.014, 0.017, 0.028], exposure: 0.96, bloom: 0.50, bloomKnee: 3.4,
  },
  // Heavy amber key, violet shade. The most opinionated look in the set.
  goldenHour: {
    cdl: {
      lift: [0.006, -0.003, 0.012], gamma: [0.985, 1.0, 1.06], gain: [1.075, 1.005, 0.905],
      contrast: 1.12, saturation: 1.16, balance: [0.26, -0.05],
    },
    lut: {
      shadow: [0.80, 0.90, 1.26], mid: [1.07, 1.0, 0.900], high: [1.10, 1.02, 0.860],
      sat: 1.14, contrast: 1.10, crush: 0.0, bleach: 0.22,
    },
    toe: [0.024, 0.020, 0.038], exposure: 0.98, bloom: 0.70, bloomKnee: 2.6,
  },
  // A flat sky gives the frame nothing, so the grade supplies the contrast the
  // light will not, and desaturates rather than pretending there is colour.
  overcast: {
    cdl: {
      lift: [0.008, 0.009, 0.014], gamma: [1.01, 1.0, 0.995], gain: [0.985, 0.995, 1.020],
      contrast: 1.14, saturation: 0.92, balance: [-0.07, 0.02],
    },
    lut: {
      shadow: [0.97, 1.00, 1.10], mid: [0.99, 1.0, 1.02], high: [0.99, 1.00, 1.040],
      sat: 0.92, contrast: 1.10, crush: 0.0, bleach: 0.08,
    },
    toe: [0.022, 0.024, 0.032], exposure: 1.04, bloom: 0.32, bloomKnee: 3.6,
  },
  // Cyan-violet ambient, warm practicals. Highest contrast of the daylight set.
  dusk: {
    cdl: {
      lift: [0.004, -0.002, 0.018], gamma: [1.0, 1.01, 1.07], gain: [1.060, 0.970, 1.030],
      contrast: 1.20, saturation: 1.12, balance: [0.08, -0.07],
    },
    lut: {
      shadow: [0.74, 0.86, 1.34], mid: [1.07, 0.97, 1.06], high: [1.12, 0.99, 0.920],
      sat: 1.10, contrast: 1.16, crush: 0.0, bleach: 0.20,
    },
    toe: [0.020, 0.020, 0.044], exposure: 0.97, bloom: 0.85, bloomKnee: 2.1,
  },
  // One tungsten source; everything it does not reach falls into blue.
  nightLamp: {
    cdl: {
      lift: [-0.001, 0.001, 0.012], gamma: [1.0, 1.0, 1.06], gain: [1.090, 0.985, 0.940],
      contrast: 1.24, saturation: 1.08, balance: [0.18, -0.06],
    },
    lut: {
      shadow: [0.70, 0.85, 1.40], mid: [1.07, 0.99, 0.94], high: [1.13, 1.01, 0.860],
      sat: 1.06, contrast: 1.20, crush: 0.0, bleach: 0.24,
    },
    toe: [0.014, 0.016, 0.040], exposure: 1.02, bloom: 1.00, bloomKnee: 1.7,
  },
};

const LUT_SIZE = 32;

function smooth01(x, a, b) {
  const t = Math.min(1, Math.max(0, (x - a) / Math.max(1e-6, b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Procedural creative LUT: a filmic S-curve, a three-way colour balance, a
 * saturation pass, a toe and a highlight bleach. Display-referred in, display-
 * referred out, so it sits after the tone map exactly like a real .cube.
 */
export function buildLutTexture(look, size = LUT_SIZE) {
  const L = (look && look.lut) || GRADE_LOOKS.neutral.lut;
  const w = size * size;
  const h = size;
  const data = new Uint8Array(w * h * 4);
  const n1 = size - 1;

  const sCurve = (x) => x * x * (3 - 2 * x);
  const cAmt = L.contrast - 1;

  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        let r = ri / n1;
        let g = gi / n1;
        let b = bi / n1;

        r += (sCurve(r) - r) * cAmt;
        g += (sCurve(g) - g) * cAmt;
        b += (sCurve(b) - b) * cAmt;

        const lum0 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const wS = 1 - smooth01(lum0, 0.0, 0.46);
        const wH = smooth01(lum0, 0.50, 1.0);
        const wM = Math.max(0, 1 - wS - wH);

        r *= L.shadow[0] * wS + L.mid[0] * wM + L.high[0] * wH;
        g *= L.shadow[1] * wS + L.mid[1] * wM + L.high[1] * wH;
        b *= L.shadow[2] * wS + L.mid[2] * wM + L.high[2] * wH;

        const lum1 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = lum1 + (r - lum1) * L.sat;
        g = lum1 + (g - lum1) * L.sat;
        b = lum1 + (b - lum1) * L.sat;

        if (L.crush > 0) {
          const k = 1 / (1 - L.crush);
          r = Math.max(0, r - L.crush) * k;
          g = Math.max(0, g - L.crush) * k;
          b = Math.max(0, b - L.crush) * k;
        }

        if (L.bleach > 0) {
          const t = smooth01(lum1, 0.72, 1.0) * L.bleach;
          r += (1 - r) * t;
          g += (1 - g) * t;
          b += (1 - b) * t;
        }

        const px = bi * size + ri;
        const o = (gi * w + px) * 4;
        data[o] = Math.max(0, Math.min(255, Math.round(r * 255)));
        data[o + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
        data[o + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
        data[o + 3] = 255;
      }
    }
  }

  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  tex.needsUpdate = true;
  tex.name = 'MG.LUT';
  return tex;
}

/* ========================================================================== */
/* Quality tiers                                                              */
/* ========================================================================== */

/*
 * `dofRadius` is a fraction of the *drawing buffer height in device pixels*,
 * not of anything normalised. uMaxRadius = max(4, dh * dofRadius).
 *
 * At 1920x1080 (Capture.js pins pixelRatio to 1 and Engine.onResize forwards the
 * capture size straight to PostFX.onResize, so dh is exactly 1080):
 *
 *   low     1080 * 0.0090 =  9.7 px over  5 taps -> 1.94 px per tap
 *   medium  1080 * 0.0115 = 12.4 px over  8 taps -> 1.55 px
 *   high    1080 * 0.0135 = 14.6 px over 11 taps -> 1.33 px
 *   ultra   1080 * 0.0155 = 16.7 px over 13 taps -> 1.29 px
 *
 * Tap spacing is what governs whether a bokeh disc looks solid or ringed, so
 * dofTaps has to move with dofRadius. Cost at ultra is 27 taps in each of two
 * separable directions over 2.07 Mpx, and only outside the sharp band.
 */
const POST_TIERS = {
  low: {
    ao: 'none', bloom: true, bloomRes: 0.5, tilt: true, dofTaps: 5, motion: false,
    mbTaps: 5, grade: true, lut: true, chromatic: false, vignette: true,
    grain: 0.0, smaa: false, dofRadius: 0.0090, edgeDefocus: 0.10,
  },
  medium: {
    ao: 'ssao', bloom: true, bloomRes: 0.5, tilt: true, dofTaps: 8, motion: true,
    mbTaps: 7, grade: true, lut: true, chromatic: true, vignette: true,
    grain: 0.022, smaa: true, dofRadius: 0.0115, edgeDefocus: 0.13,
  },
  high: {
    ao: 'gtao', bloom: true, bloomRes: 0.5, tilt: true, dofTaps: 11, motion: true,
    mbTaps: 9, grade: true, lut: true, chromatic: true, vignette: true,
    grain: 0.028, smaa: true, dofRadius: 0.0135, edgeDefocus: 0.15,
  },
  ultra: {
    ao: 'gtao', bloom: true, bloomRes: 0.5, tilt: true, dofTaps: 13, motion: true,
    mbTaps: 12, grade: true, lut: true, chromatic: true, vignette: true,
    grain: 0.034, smaa: true, dofRadius: 0.0155, edgeDefocus: 0.16,
  },
};

/* ========================================================================== */
/* Scratch                                                                    */
/* ========================================================================== */

const _size = new THREE.Vector2();
const _vp = new THREE.Matrix4();
const _proj = new THREE.Vector3();
const _cutPos = new THREE.Vector3();
const _cutQuat = new THREE.Quaternion();

// Camera-cut thresholds for the motion blur reprojection. 1 unit = 1 cm, and a
// chase camera travels a few units per frame at racing speed, so 30 u (900 u²)
// in a single frame is a jump no follow camera makes. The dot is between
// successive world quaternions: 0.985 is a hair under 10 degrees of rotation in
// one frame, well outside what a damped camera does and well inside a cut.
const CUT_DIST_SQ = 900;
const CUT_DOT = 0.985;

/** Finite-or-default. Every number a peer hands us goes through this first —
 *  a NaN reaching a uniform is invisible until the whole pass renders black. */
function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clampNum(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Shallow clone of a shader descriptor so per-instance defines do not leak. */
function shaderCopy(shader, defines) {
  return {
    name: shader.name,
    defines: Object.assign({}, shader.defines, defines),
    uniforms: THREE.UniformsUtils.clone(shader.uniforms),
    vertexShader: shader.vertexShader,
    fragmentShader: shader.fragmentShader,
  };
}

/* ========================================================================== */
/* PostFX                                                                     */
/* ========================================================================== */

export class PostFX {
  name = 'postfx';

  constructor(ctx = {}, opts = {}) {
    this.ctx = ctx;
    this.enabled = true;
    this.composer = null;
    this.passes = {};
    this.disabled = new Set();

    this.tier = (ctx.settings && ctx.settings.quality) || 'ultra';
    this.lookName = opts.look || 'morning';
    this._lutCache = new Map();

    this.width = opts.width || 0;
    this.height = opts.height || 0;

    /** World height of the plane camera motion is reprojected through. */
    this.motionPlaneY = 0;

    this._focus = 0.52;
    this._focusOverride = null;
    this._focusTau = 0.13;
    /** Extra multiplier on uMaxRadius, from post.params.tiltShiftAmount. */
    this._dofAmount = 1;
    this._lookExposure = 1;
    this._bloomKnee = 3.1;
    this._prevVP = new THREE.Matrix4();
    // Previous camera pose, for telling a cut apart from fast camera motion.
    this._prevCamPos = new THREE.Vector3();
    this._prevCamQuat = new THREE.Quaternion();
    this._camHistory = false;
    this._cutPending = false;
    this._time = 0;
    this._failures = 0;
    this._hardFail = false;
    this._gradeOwnsToneMap = false;
    this._sig = null;
    this._probeA = null;
    this._probeB = null;

    ctx.postfx = ctx.postfx || this;
  }

  /**
   * Tell the motion blur that the camera teleported, so it skips reprojection
   * for one frame instead of smearing the cut across the screen.
   *
   * The pose heuristic in update() catches cuts on its own, but it can only
   * guess from a threshold. Anything that knowingly repositions the camera —
   * a director cut, a respawn, a replay seek, the review capture rig — should
   * call this and not rely on the guess.
   */
  notifyCameraCut() {
    this._cutPending = true;
    return this;
  }

  async init() {
    const ctx = this.ctx;
    if (ctx.lighting && ctx.lighting.preset) this.lookName = ctx.lighting.preset.look || this.lookName;
    this.build();
    ctx.bus?.on?.('lighting:preset', (e) => {
      if (e && (e.look || e.name)) this.setLook(e.look || e.name);
    });
    return this;
  }

  /* ---------------------------------------------------------------------- */
  /* Build                                                                   */
  /* ---------------------------------------------------------------------- */

  /** Assemble (or reassemble) the whole chain from Settings.post + quality. */
  build(force = false) {
    const ctx = this.ctx;
    const renderer = ctx.renderer;
    const scene = ctx.scene;
    const camera = ctx.camera;
    if (!renderer || !scene || !camera) return null;

    // Always take the live viewport, so a build triggered by a quality change
    // cannot resurrect a stale size.
    renderer.getSize(_size);
    this.width = Math.max(1, _size.x);
    this.height = Math.max(1, _size.y);

    // The bootstrap may call build() again right after init(); rebuilding the
    // whole chain (and recompiling every pass) for nothing costs tens of ms.
    const sig = this.tier + '|' + Math.round(this.width) + 'x' + Math.round(this.height) + '@' + renderer.getPixelRatio();
    if (!force && this.composer && this._sig === sig) return this.composer;
    this._sig = sig;

    this._teardown();

    const tier = POST_TIERS[this.tier] || POST_TIERS.ultra;
    const want = Object.assign(
      {
        ssao: true, bloom: true, tiltShift: true, motionBlur: true, grade: true,
        chromatic: true, vignette: true, grain: true, crt: false, smaa: true,
      },
      (ctx.settings && ctx.settings.post) || {}
    );

    const pr = renderer.getPixelRatio();
    const dw = Math.max(1, Math.round(this.width * pr));
    const dh = Math.max(1, Math.round(this.height * pr));

    let composer;
    try {
      composer = new EffectComposer(renderer);
      composer.setPixelRatio(pr);
      composer.setSize(this.width, this.height);
    } catch (e) {
      console.error('[MICRO GAUNTLET] postfx: composer could not be created', e);
      this._hardFail = true;
      return null;
    }
    this.composer = composer;

    this._probeA = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });
    this._probeB = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });

    /* -- 0. scene ------------------------------------------------------- */
    const renderPass = this._safe('render', () => new RenderPass(scene, camera));
    if (!renderPass) {
      this._hardFail = true;
      return null;
    }
    this.passes.render = renderPass;
    composer.addPass(renderPass);

    /* -- 1. ambient occlusion ------------------------------------------- */
    if (want.ssao !== false && tier.ao !== 'none') {
      if (tier.ao === 'gtao') {
        const gtao = this._safe('gtao', () => {
          const p = new GTAOPass(scene, camera, dw, dh);
          p.output = GTAOPass.OUTPUT.Default;
          p.blendIntensity = 0.95;
          // Radius is world units: 1 u = 1 cm, so ~6 cm bites into panel gaps,
          // kerb roots and the crevice where a tyre meets the surface without
          // painting a grey halo around whole objects.
          p.updateGtaoMaterial({
            radius: 6.0,
            distanceExponent: 1.0,
            thickness: 4.0,
            scale: 1.0,
            samples: this.tier === 'ultra' ? 16 : 11,
            distanceFallOff: 1.0,
            screenSpaceRadius: false,
          });
          p.updatePdMaterial({ lumaPhi: 8, depthPhi: 2.5, normalPhi: 3.5, radius: 6, samples: this.tier === 'ultra' ? 16 : 8 });
          return p;
        });
        if (gtao) {
          this.passes.ao = gtao;
          composer.addPass(gtao);
        }
      } else {
        const ssao = this._safe('ssao', () => {
          const p = new SSAOPass(scene, camera, dw, dh, 24);
          p.output = SSAOPass.OUTPUT.Default;
          p.kernelRadius = 6;
          p.minDistance = 0.0006;
          p.maxDistance = 0.018;
          return p;
        });
        if (ssao) {
          this.passes.ao = ssao;
          composer.addPass(ssao);
        }
      }
    }

    /* -- 2. bloom -------------------------------------------------------- */
    if (want.bloom !== false && tier.bloom) {
      const bloom = this._safe('bloom', () => {
        const res = new THREE.Vector2(Math.round(dw * tier.bloomRes), Math.round(dh * tier.bloomRes));
        // Strength and threshold are both overwritten before the first frame —
        // strength by setLook, threshold by _updateUniforms. Radius stays tight:
        // a specular halo is a halo, and a wide one is just a milky wash.
        const p = new UnrealBloomPass(res, 0.28, 0.42, 1.8);

        // Swap the addon's luminance threshold for the specular key. The addon
        // writes tDiffuse and luminosityThreshold into highPassUniforms every
        // frame, so those names have to survive.
        const u = THREE.UniformsUtils.clone(SpecularHighPassShader.uniforms);
        u.texelSize.value.set(1 / dw, 1 / dh);
        p.highPassUniforms = u;
        p.materialHighPassFilter = new THREE.ShaderMaterial({
          name: SpecularHighPassShader.name,
          uniforms: u,
          vertexShader: SpecularHighPassShader.vertexShader,
          fragmentShader: SpecularHighPassShader.fragmentShader,
        });
        return p;
      });
      if (bloom) {
        this.passes.bloom = bloom;
        composer.addPass(bloom);
      }
    }

    /* -- 3. tilt-shift DOF ----------------------------------------------- */
    if (want.tiltShift !== false && tier.tilt) {
      const tilt = this._safe('tiltShift', () => new TiltShiftPass(dw, dh, tier.dofTaps));
      if (tilt && this._validate(tilt, 'tiltShift')) {
        tilt.uniforms.uEdge.value = tier.edgeDefocus;
        this.passes.tiltShift = tilt;
        composer.addPass(tilt);
      } else if (tilt) {
        tilt.dispose();
        // This is the signature effect; losing it silently is how the frame ends
        // up uniformly sharp and nobody notices until a review.
        console.error('[MICRO GAUNTLET] postfx: tilt-shift unavailable — the miniature look is off.');
      }
    }

    /* -- 4. motion blur --------------------------------------------------- */
    if (want.motionBlur !== false && tier.motion) {
      const mb = this._safeShaderPass('motionBlur', MotionBlurShader, { MG_MB_TAPS: tier.mbTaps });
      if (mb) {
        this.passes.motionBlur = mb;
        composer.addPass(mb);
      }
    }

    /* -- 5. grade --------------------------------------------------------- */
    if (want.grade !== false && tier.grade) {
      const grade = this._safeShaderPass('grade', GradeShader);
      if (grade) {
        this.passes.grade = grade;
        composer.addPass(grade);
        this._gradeOwnsToneMap = true;
      }
    }

    /* -- 6. chromatic aberration ------------------------------------------ */
    if (want.chromatic !== false && tier.chromatic) {
      const ca = this._safeShaderPass('chromatic', ChromaticShader);
      if (ca) {
        ca.uniforms.uTexel.value.set(1 / dw, 1 / dh);
        this.passes.chromatic = ca;
        composer.addPass(ca);
      }
    }

    /* -- 7. vignette ------------------------------------------------------ */
    if (want.vignette !== false && tier.vignette) {
      const vig = this._safeShaderPass('vignette', VignetteShader);
      if (vig) {
        vig.uniforms.uAspect.value = dw / dh;
        this.passes.vignette = vig;
        composer.addPass(vig);
      }
    }

    /* -- 8. film grain ---------------------------------------------------- */
    if (want.grain !== false && tier.grain > 0) {
      const grain = this._safeShaderPass('grain', GrainShader);
      if (grain) {
        grain.uniforms.uAmount.value = tier.grain;
        grain.uniforms.uResolution.value.set(dw, dh);
        this.passes.grain = grain;
        composer.addPass(grain);
      }
    }

    /* -- 8b. CRT (optional, off by default) -------------------------------- */
    {
      const crt = this._safeShaderPass('crt', CrtShader);
      if (crt) {
        crt.uniforms.uResolution.value.set(dw, dh);
        crt.uniforms.uAmount.value = want.crt ? 1 : 0;
        crt.enabled = !!want.crt;
        this.passes.crt = crt;
        composer.addPass(crt);
      }
    }

    /* -- 9. SMAA ---------------------------------------------------------- */
    if (want.smaa !== false && tier.smaa) {
      const smaa = this._safe('smaa', () => new SMAAPass());
      if (smaa) {
        this.passes.smaa = smaa;
        composer.addPass(smaa);
      }
    }

    /* -- 10. output ------------------------------------------------------- */
    const out = this._safe('output', () => new OutputPass());
    if (out) {
      this.passes.output = out;
      composer.addPass(out);
    }

    this.setLook(this.lookName);
    this._applyResolutionUniforms(dw, dh);

    // Probes have done their job; every pass in the chain is known to compile.
    this._probeA.dispose();
    this._probeB.dispose();
    this._probeA = this._probeB = null;

    return composer;
  }

  _safe(key, factory) {
    try {
      return factory();
    } catch (e) {
      this.disabled.add(key);
      console.warn('[MICRO GAUNTLET] postfx: pass "' + key + '" failed to build, skipping.', e);
      return null;
    }
  }

  _safeShaderPass(key, shader, defines) {
    const pass = this._safe(key, () => new ShaderPass(shaderCopy(shader, defines)));
    if (!pass) return null;
    if (this._validate(pass, key)) return pass;
    pass.dispose?.();
    return null;
  }

  /**
   * Compile a hand-written pass against a 4x4 probe before it joins the chain.
   * A GLSL error in a post pass otherwise shows up as a black frame with a
   * console warning nobody sees until review.
   */
  _validate(pass, key) {
    const renderer = this.ctx.renderer;
    if (!renderer || !this._probeA) return true;

    let failed = false;
    const prevHook = renderer.debug.onShaderError;
    const prevTarget = renderer.getRenderTarget();
    renderer.debug.onShaderError = () => {
      failed = true;
    };
    try {
      pass.render(renderer, this._probeA, this._probeB, 1 / 60, false);
    } catch (e) {
      failed = true;
      console.warn('[MICRO GAUNTLET] postfx: pass "' + key + '" threw while compiling.', e);
    } finally {
      renderer.debug.onShaderError = prevHook;
      renderer.setRenderTarget(prevTarget);
    }

    if (failed) {
      this.disabled.add(key);
      console.warn('[MICRO GAUNTLET] postfx: pass "' + key + '" failed to compile, skipping.');
    }
    return !failed;
  }

  _teardown() {
    // UnrealBloomPass.dispose does not know about the high-pass material we
    // swapped in, so it has to go first.
    try {
      this.passes.bloom?.materialHighPassFilter?.dispose();
    } catch (e) {
      /* ignore */
    }
    if (this.composer) {
      for (const p of this.composer.passes.slice()) {
        try {
          p.dispose?.();
        } catch (e) {
          /* ignore */
        }
      }
      try {
        this.composer.dispose();
      } catch (e) {
        /* ignore */
      }
    }
    this._probeA?.dispose();
    this._probeB?.dispose();
    this._probeA = this._probeB = null;
    this.composer = null;
    this.passes = {};
    this._gradeOwnsToneMap = false;
  }

  /* ---------------------------------------------------------------------- */
  /* Configuration                                                           */
  /* ---------------------------------------------------------------------- */

  setQuality(tier) {
    if (!POST_TIERS[tier] || tier === this.tier) return;
    this.tier = tier;
    this.build(true);
  }

  /** Select a creative look; called by Lighting whenever the preset changes. */
  setLook(name) {
    const look = GRADE_LOOKS[name] || GRADE_LOOKS.neutral;
    this.lookName = GRADE_LOOKS[name] ? name : 'neutral';
    this._lookExposure = num(look.exposure, 1);
    this._bloomKnee = num(look.bloomKnee, 3.1);

    const grade = this.passes.grade;
    if (grade) {
      const c = look.cdl;
      const u = grade.uniforms;
      const toe = look.toe || GRADE_LOOKS.neutral.toe;
      u.uToe.value.set(toe[0], toe[1], toe[2]);
      u.uLookExposure.value = this._lookExposure;
      u.uLift.value.set(c.lift[0], c.lift[1], c.lift[2]);
      u.uGamma.value.set(c.gamma[0], c.gamma[1], c.gamma[2]);
      u.uGain.value.set(c.gain[0], c.gain[1], c.gain[2]);
      u.uContrast.value = c.contrast;
      u.uSaturation.value = c.saturation;
      u.uBalance.value.set(c.balance[0], c.balance[1]);
      u.uShadowTint.value.set(1, 1, 1);
      u.uMidTint.value.set(1, 1, 1);
      u.uHighTint.value.set(1, 1, 1);

      let lut = this._lutCache.get(this.lookName);
      if (!lut) {
        lut = buildLutTexture(look, LUT_SIZE);
        this._lutCache.set(this.lookName, lut);
      }
      u.tLut.value = lut;
      u.uLutSize.value = LUT_SIZE;
      const tier = POST_TIERS[this.tier] || POST_TIERS.ultra;
      u.uLutAmount.value = tier.lut ? 1 : 0;
    }

    const bloom = this.passes.bloom;
    if (bloom) {
      // 0.24 (morning) to 0.36 (a single lamp in the dark). The old range was
      // 0.55-0.76, which is glow-over-everything territory even with a perfect
      // high pass in front of it.
      bloom.strength = 0.14 + num(look.bloom, 0.45) * 0.22;
      bloom.radius = 0.42;
    }
    return this;
  }

  /**
   * Honour the handful of Settings.post.params dials this pass can act on
   * without inheriting their unit confusion. Called by Settings.apply().
   *
   * `tiltShiftMaxRadius` is deliberately ignored: it is documented in
   * core/Settings.js as "px at 1080p" and ships at 3.2, which is a quarter of
   * what the effect needs to be visible at all. The tier tables own the radius;
   * `tiltShiftAmount` (0..2, ships at 1) is the sanctioned way to scale it.
   */
  applySettings(settings) {
    const params = settings && settings.post && settings.post.params;
    if (!params) return this;
    this._dofAmount = clampNum(num(params.tiltShiftAmount, 1), 0, 2);
    const t = this.passes.tiltShift;
    if (t) {
      const tier = POST_TIERS[this.tier] || POST_TIERS.ultra;
      const dh = Math.max(1, Math.round(this.height * (this.ctx.renderer?.getPixelRatio?.() || 1)));
      t.uniforms.uMaxRadius.value = Math.max(4, dh * tier.dofRadius) * this._dofAmount;
    }
    return this;
  }

  /** Toggle the retro CRT/scanline grade. Off by default. */
  setCrt(on, amount = 1) {
    const crt = this.passes.crt;
    if (!crt) return;
    crt.enabled = !!on;
    crt.uniforms.uAmount.value = on ? amount : 0;
  }

  /**
   * Directly steer the tilt-shift band. Without a call it tracks the player car;
   * cutscenes and the intro orbit may want to pin it. Called every frame from
   * Director.lateUpdate, so it allocates nothing.
   *
   * @param {?number} centre  uv.y of the in-focus band, or null to resume
   *                          tracking the player.
   * @param {number} [width]  half-height of the sharp band in uv.y. Clamped to
   *                          [0.040, 0.210]: above that the band swallows the
   *                          frame and the miniature read goes with it, and the
   *                          intro deliberately asks for 0.46.
   * @param {number} [falloff] ramp EXPONENT, matching what
   *                          Settings.post.params.tiltShiftFalloff documents
   *                          ("quadratic ramp away from the band", ships as 2).
   *                          It is not a distance — see the unit contract above
   *                          TILT_FRAG for what happened when it was treated as
   *                          one. Clamped to [1, 4]; 2 is quadratic.
   */
  setFocusBand(centre, width, falloff) {
    this._focusOverride = Number.isFinite(centre) ? clampNum(centre, 0.06, 0.94) : null;
    const t = this.passes.tiltShift;
    if (!t) return this;
    const u = t.uniforms;
    if (Number.isFinite(width)) u.uBandWidth.value = clampNum(width, BAND_MIN, BAND_MAX);
    if (Number.isFinite(falloff)) u.uPower.value = clampNum(falloff, 1, 4);
    return this;
  }

  /** Tilt the plane of focus off horizontal. `deg` is the band's screen angle. */
  setFocusTilt(deg) {
    const t = this.passes.tiltShift;
    if (!t) return this;
    const a = num(deg, 0) * Math.PI / 180;
    t.uniforms.uBandDir.value.set(Math.sin(a), Math.cos(a));
    return this;
  }

  onResize(w, h) {
    this.width = w;
    this.height = h;
    const renderer = this.ctx.renderer;
    if (!this.composer || !renderer) return;
    const pr = renderer.getPixelRatio();
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this._applyResolutionUniforms(Math.round(w * pr), Math.round(h * pr));
  }

  _applyResolutionUniforms(dw, dh) {
    const p = this.passes;
    if (p.bloom && p.bloom.highPassUniforms && p.bloom.highPassUniforms.texelSize) {
      p.bloom.highPassUniforms.texelSize.value.set(1 / dw, 1 / dh);
    }
    if (p.tiltShift) {
      const tier = POST_TIERS[this.tier] || POST_TIERS.ultra;
      // dh is the drawing-buffer height in device pixels, so the blur is the
      // same fraction of the frame at every resolution: 16.7 px at 1080p ultra,
      // 11.2 px at 720p, 33.5 px at 2160p.
      p.tiltShift.uniforms.uMaxRadius.value = Math.max(4, dh * tier.dofRadius) * this._dofAmount;
      p.tiltShift.uniforms.uAspect.value = dw / dh;
    }
    if (p.chromatic) p.chromatic.uniforms.uTexel.value.set(1 / dw, 1 / dh);
    if (p.vignette) p.vignette.uniforms.uAspect.value = dw / dh;
    if (p.grain) p.grain.uniforms.uResolution.value.set(dw, dh);
    if (p.crt) p.crt.uniforms.uResolution.value.set(dw, dh);
  }

  /* ---------------------------------------------------------------------- */
  /* Frame                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Render one frame through the chain. This is the engine's render call.
   * @param {number} dt seconds
   */
  render(dt = 1 / 60) {
    const ctx = this.ctx;
    const renderer = ctx.renderer;
    if (!renderer) return;

    if (this._hardFail || !this.composer || !this.enabled) {
      this._fallback();
      return;
    }

    this._sync();
    this._updateUniforms(Math.min(dt, 0.1));

    // The grade pass carries exposure + ACES itself, so OutputPass must be left
    // with nothing to do but the sRGB transfer.
    const prevToneMapping = renderer.toneMapping;
    if (this._gradeOwnsToneMap) renderer.toneMapping = THREE.NoToneMapping;

    try {
      this.composer.render(dt);
    } catch (e) {
      this._failures++;
      console.warn('[MICRO GAUNTLET] postfx: composer render failed (' + this._failures + ')', e);
      if (this._failures >= 3) {
        this._hardFail = true;
        console.error('[MICRO GAUNTLET] postfx disabled; falling back to direct rendering.');
      }
      renderer.toneMapping = prevToneMapping;
      this._fallback();
    } finally {
      renderer.toneMapping = prevToneMapping;
    }
  }

  _fallback() {
    const { renderer, scene, camera } = this.ctx;
    if (!renderer || !scene || !camera) return;
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(scene, camera);
  }

  /** Follow scene/camera swaps (track reload, replay camera) without a rebuild. */
  _sync() {
    const { scene, camera } = this.ctx;
    const p = this.passes;
    if (p.render) {
      if (scene && p.render.scene !== scene) p.render.scene = scene;
      if (camera && p.render.camera !== camera) p.render.camera = camera;
    }
    if (p.ao) {
      if (scene && p.ao.scene !== scene) p.ao.scene = scene;
      if (camera && p.ao.camera !== camera) p.ao.camera = camera;
    }
  }

  _updateUniforms(dt) {
    const ctx = this.ctx;
    const camera = ctx.camera;
    const renderer = ctx.renderer;
    const p = this.passes;
    this._time += dt;

    const exposure = num(renderer && renderer.toneMappingExposure, 1);
    if (p.grade) p.grade.uniforms.uExposure.value = exposure;

    /* bloom gate ------------------------------------------------------------ */
    if (p.bloom) {
      // The high pass runs on scene radiance, but what the eye judges as "blown"
      // is what comes out of the tone curve, and the grade does
      //   graded = scene * exposure * lookExposure / 0.6
      // before ACES. A fixed scene-space threshold therefore drifts with the
      // light rig: key up by a stop and the whole table crosses it, which is
      // precisely the milky wash we are trying not to have. Solving for the
      // graded-linear knee instead pins the gate to speculars at every preset.
      //   knee 3.1 -> ACES ~0.90 display; at exposure 1.05 the scene-space
      //   threshold is 3.1 * 0.6 / 1.05 = 1.77, comfortably above sunlit
      //   diffuse white (~1.0-1.5) and far below a clearcoat glint (5-100).
      const e = Math.max(0.05, exposure * this._lookExposure);
      const th = (this._bloomKnee * 0.6) / e;
      p.bloom.threshold = th;
      const hp = p.bloom.highPassUniforms;
      // UnrealBloomPass republishes tDiffuse and luminosityThreshold itself but
      // never smoothWidth, so the soft edge of the gate has to track it here or
      // it stays at whatever the clone was built with.
      if (hp && hp.smoothWidth) hp.smoothWidth.value = th * 0.5;
    }

    // The renderer refreshes matrixWorldInverse inside render(), which is after
    // this runs, so both the screen-space focus projection and the motion-blur
    // matrices have to bring the camera up to date themselves.
    if (camera) {
      camera.updateMatrixWorld();
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    }

    /* tilt-shift band tracks the player in screen space -------------------- */
    if (p.tiltShift && camera) {
      let target = this._focusOverride;
      if (target == null) {
        const hero =
          (ctx.player && ctx.player.position) ||
          (ctx.vehicles && ctx.vehicles[0] && ctx.vehicles[0].position) ||
          null;
        if (hero) {
          _proj.copy(hero).project(camera);
          // z >= 1 means behind the far plane / behind the lens; keep the old band.
          if (Number.isFinite(_proj.y) && _proj.z < 1) {
            target = Math.min(0.86, Math.max(0.14, _proj.y * 0.5 + 0.5));
          }
        }
      }
      if (Number.isFinite(target)) {
        // Critically damped, frame-rate independent: the band must never
        // overshoot or the whole frame breathes.
        const k = 1 - Math.exp(-dt / this._focusTau);
        this._focus += (target - this._focus) * k;
      }
      // One NaN reaching uFocusCenter would make every mgCoc() call NaN, every
      // kernel weight NaN, and the whole pass output NaN — which composites as
      // black, not as an error.
      if (!Number.isFinite(this._focus)) this._focus = 0.52;
      p.tiltShift.uniforms.uFocusCenter.value = this._focus;
    }

    /* motion blur ---------------------------------------------------------- */
    if (p.motionBlur && camera) {
      const u = p.motionBlur.uniforms;
      _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      u.uInvViewProj.value.copy(_vp).invert();

      // A camera CUT is not camera MOTION. Reprojecting across one leaves
      // uPrevViewProj describing a completely different view, the per-pixel
      // velocity comes out enormous, and the pass smears the whole frame into
      // cream-coloured streaks radiating from the centre. The director cuts
      // between angles during a race, so this ships unless it is caught.
      //
      // Held for a frame rather than fixed up: with no trustworthy previous
      // view there is no correct blur to draw, and none is right.
      _cutPos.setFromMatrixPosition(camera.matrixWorld);
      camera.getWorldQuaternion(_cutQuat);
      const jumped =
        this._cutPending ||
        !this._camHistory ||
        _cutPos.distanceToSquared(this._prevCamPos) > CUT_DIST_SQ ||
        Math.abs(_cutQuat.dot(this._prevCamQuat)) < CUT_DOT;
      this._cutPending = false;
      this._camHistory = true;
      this._prevCamPos.copy(_cutPos);
      this._prevCamQuat.copy(_cutQuat);
      if (jumped) this._prevVP.copy(_vp);

      u.uPrevViewProj.value.copy(this._prevVP);
      // World position, not .position: the camera may be parented to a rig.
      u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
      u.uPlaneY.value = this.motionPlaneY;
      // Wrapped so the hash keeps its precision over a long session.
      u.uJitter.value = (this._time * 60) % 1024;
      this._prevVP.copy(_vp);
    }

    /* grain ---------------------------------------------------------------- */
    if (p.grain) p.grain.uniforms.uTime.value = this._time;
  }

  /* ---------------------------------------------------------------------- */

  dispose() {
    this._teardown();
    for (const [, tex] of this._lutCache) tex.dispose();
    this._lutCache.clear();
  }
}

export default PostFX;
export { TiltShiftPass, SpecularHighPassShader, MotionBlurShader, GradeShader, ChromaticShader, VignetteShader, GrainShader, CrtShader, POST_TIERS };
