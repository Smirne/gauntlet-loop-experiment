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
    luminosityThreshold: { value: 1.25 },
    smoothWidth: { value: 0.45 },
    texelSize: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    specularity: { value: 0.85 },
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

      float key = mix( 1.0, clamp( pop * 1.9, 0.0, 1.0 ) * ( 1.0 - sat * 0.55 ), specularity );
      float gate = smoothstep( luminosityThreshold, luminosityThreshold + smoothWidth, l );

      gl_FragColor = vec4( c * gate * key, 1.0 );
    }
  `,
};

/* ========================================================================== */
/* 2. Tilt-shift depth of field                                               */
/* ========================================================================== */

const TILT_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2  uTexel;
uniform vec2  uDirection;
uniform vec2  uBandDir;      // ( sin, cos ) of the band angle
uniform float uFocusCenter;
uniform float uBandWidth;
uniform float uFalloff;
uniform float uMaxRadius;
uniform float uAspect;
uniform float uHighlight;
uniform float uEdge;
varying vec2 vUv;

// Circle of confusion from the tilt-shift gradient alone: distance from a tilted
// in-focus strip, ramped quadratically. This is what sells the miniature — a real
// macro lens has a plane of focus, and the eye reads a horizontally banded blur
// as "tiny object, lens very close".
float mgCoc( vec2 uv ) {
  vec2 d = vec2( ( uv.x - 0.5 ) * uAspect, uv.y - uFocusCenter );
  float dist = abs( d.y * uBandDir.y - d.x * uBandDir.x );
  float t = max( dist - uBandWidth, 0.0 ) / max( uFalloff, 1e-4 );
  float coc = clamp( t * t, 0.0, 1.0 );

  // A touch of corner defocus: even inside the strip a fast lens is not sharp
  // right out to the frame edge.
  float r = length( vec2( ( uv.x - 0.5 ) * uAspect, uv.y - 0.5 ) );
  coc = clamp( coc + uEdge * smoothstep( 0.40, 0.82, r ) * ( 1.0 - coc ), 0.0, 1.0 );
  return coc;
}

void main() {
  float coc = mgCoc( vUv );
  vec3 centre = texture2D( tDiffuse, vUv ).rgb;
  float radius = coc * uMaxRadius;

  if ( radius < 0.75 ) {
    gl_FragColor = vec4( centre, 1.0 );
    return;
  }

  vec2 stepUv = uDirection * uTexel * ( radius / float( MG_DOF_TAPS ) );

  vec3 sum = vec3( 0.0 );
  float wsum = 0.0;

  for ( int i = -MG_DOF_TAPS; i <= MG_DOF_TAPS; i ++ ) {
    float fi = float( i ) / float( MG_DOF_TAPS );
    vec2 uv = vUv + stepUv * float( i );
    vec3 s = texture2D( tDiffuse, uv ).rgb;

    // Flat-top kernel with a hard rim. Applied separably this converges on a
    // squircle rather than the pointy Gaussian profile that turns bokeh into
    // mush, so out-of-focus highlights keep a defined edge.
    float k = 1.0 - smoothstep( 0.86, 1.0, abs( fi ) );

    // Scatter-as-gather guard: a sharp pixel must not bleed into a blurred one,
    // only the other way round.
    k *= clamp( mgCoc( uv ) / max( coc, 1e-3 ), 0.12, 1.0 );

    // Weight highlights up before averaging so they resolve as bright discs
    // instead of being diluted by their dark surround.
    float lum = max( max( s.r, s.g ), s.b );
    float hw = 1.0 + uHighlight * max( lum - 0.80, 0.0 );

    float w = k * hw;
    sum += s * w;
    wsum += w;
  }

  gl_FragColor = vec4( sum / max( wsum, 1e-4 ), 1.0 );
}
`;

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
      uBandWidth: { value: 0.11 },
      uFalloff: { value: 0.30 },
      uMaxRadius: { value: 13 },
      uAspect: { value: width / Math.max(1, height) },
      uHighlight: { value: 2.6 },
      uEdge: { value: 0.18 },
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
    this._quad.dispose();
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
      c *= uExposure / 0.6;
      // White balance: cheap channel scaling is enough at this magnitude and
      // avoids two matrix multiplies per pixel.
      c *= vec3( 1.0 + uBalance.x * 0.14, 1.0 + uBalance.y * 0.07, 1.0 - uBalance.x * 0.14 );

      c = mgACES( c );

      // --- display-referred -------------------------------------------------
      c = clamp( c * uGain + uLift, 0.0, 1.0 );
      c = pow( c, 1.0 / max( uGamma, vec3( 1e-3 ) ) );
      c = clamp( ( c - 0.435 ) * uContrast + 0.435, 0.0, 1.0 );

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
    uAmount: { value: 0.38 },
    uInner: { value: 0.30 },
    uOuter: { value: 0.88 },
    uRoundness: { value: 0.35 },
    uAspect: { value: 16 / 9 },
    uDesat: { value: 0.30 },
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
 * regenerated only when the look changes).
 */
export const GRADE_LOOKS = {
  neutral: {
    cdl: { lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1], contrast: 1.0, saturation: 1.0, balance: [0, 0] },
    lut: { shadow: [1, 1, 1], mid: [1, 1, 1], high: [1, 1, 1], sat: 1.0, contrast: 1.0, crush: 0.0, bleach: 0.0 },
    bloom: 0.5,
  },
  morning: {
    cdl: {
      lift: [-0.006, -0.002, 0.010], gamma: [1.0, 1.0, 1.02], gain: [1.035, 1.005, 0.965],
      contrast: 1.07, saturation: 1.07, balance: [0.10, -0.02],
    },
    lut: {
      shadow: [0.93, 0.98, 1.13], mid: [1.02, 1.0, 0.975], high: [1.06, 1.015, 0.925],
      sat: 1.05, contrast: 1.07, crush: 0.010, bleach: 0.12,
    },
    bloom: 0.55,
  },
  noon: {
    cdl: {
      lift: [-0.004, -0.002, 0.006], gamma: [1, 1, 1], gain: [1.01, 1.005, 1.0],
      contrast: 1.10, saturation: 1.10, balance: [0.02, 0.0],
    },
    lut: {
      shadow: [0.95, 0.99, 1.10], mid: [1.0, 1.0, 1.0], high: [1.02, 1.01, 0.99],
      sat: 1.08, contrast: 1.10, crush: 0.014, bleach: 0.10,
    },
    bloom: 0.62,
  },
  goldenHour: {
    cdl: {
      lift: [0.004, -0.004, 0.014], gamma: [0.99, 1.0, 1.05], gain: [1.07, 1.005, 0.915],
      contrast: 1.06, saturation: 1.10, balance: [0.22, -0.04],
    },
    lut: {
      shadow: [0.88, 0.94, 1.20], mid: [1.05, 1.0, 0.93], high: [1.10, 1.02, 0.86],
      sat: 1.10, contrast: 1.05, crush: 0.008, bleach: 0.18,
    },
    bloom: 0.78,
  },
  overcast: {
    cdl: {
      lift: [0.012, 0.013, 0.018], gamma: [1.01, 1.0, 1.0], gain: [0.985, 0.995, 1.015],
      contrast: 1.02, saturation: 0.88, balance: [-0.06, 0.02],
    },
    lut: {
      shadow: [0.99, 1.01, 1.07], mid: [0.99, 1.0, 1.02], high: [0.99, 1.0, 1.03],
      sat: 0.88, contrast: 1.02, crush: 0.0, bleach: 0.06,
    },
    bloom: 0.38,
  },
  dusk: {
    cdl: {
      lift: [0.004, -0.002, 0.020], gamma: [1.0, 1.01, 1.06], gain: [1.05, 0.975, 1.02],
      contrast: 1.12, saturation: 1.06, balance: [0.08, -0.06],
    },
    lut: {
      shadow: [0.84, 0.90, 1.28], mid: [1.06, 0.98, 1.04], high: [1.10, 0.99, 0.94],
      sat: 1.05, contrast: 1.12, crush: 0.016, bleach: 0.15,
    },
    bloom: 0.85,
  },
  nightLamp: {
    cdl: {
      lift: [-0.002, 0.000, 0.014], gamma: [1.0, 1.0, 1.05], gain: [1.06, 0.99, 0.96],
      contrast: 1.16, saturation: 1.02, balance: [0.14, -0.05],
    },
    lut: {
      shadow: [0.80, 0.92, 1.34], mid: [1.06, 0.99, 0.96], high: [1.10, 1.01, 0.90],
      sat: 1.02, contrast: 1.16, crush: 0.020, bleach: 0.20,
    },
    bloom: 1.00,
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

const POST_TIERS = {
  low: {
    ao: 'none', bloom: true, bloomRes: 0.5, tilt: true, dofTaps: 4, motion: false,
    mbTaps: 5, grade: true, lut: true, chromatic: false, vignette: true,
    grain: 0.0, smaa: false, dofRadius: 0.0085, edgeDefocus: 0.10,
  },
  medium: {
    ao: 'ssao', bloom: true, bloomRes: 0.5, tilt: true, dofTaps: 6, motion: true,
    mbTaps: 7, grade: true, lut: true, chromatic: true, vignette: true,
    grain: 0.022, smaa: true, dofRadius: 0.0100, edgeDefocus: 0.13,
  },
  high: {
    ao: 'gtao', bloom: true, bloomRes: 0.5, tilt: true, dofTaps: 8, motion: true,
    mbTaps: 9, grade: true, lut: true, chromatic: true, vignette: true,
    grain: 0.028, smaa: true, dofRadius: 0.0115, edgeDefocus: 0.16,
  },
  ultra: {
    ao: 'gtao', bloom: true, bloomRes: 0.5, tilt: true, dofTaps: 10, motion: true,
    mbTaps: 12, grade: true, lut: true, chromatic: true, vignette: true,
    grain: 0.034, smaa: true, dofRadius: 0.0130, edgeDefocus: 0.18,
  },
};

/* ========================================================================== */
/* Scratch                                                                    */
/* ========================================================================== */

const _size = new THREE.Vector2();
const _vp = new THREE.Matrix4();
const _proj = new THREE.Vector3();

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
    this._prevVP = new THREE.Matrix4();
    this._time = 0;
    this._failures = 0;
    this._hardFail = false;
    this._gradeOwnsToneMap = false;
    this._sig = null;
    this._probeA = null;
    this._probeB = null;

    ctx.postfx = ctx.postfx || this;
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
        const p = new UnrealBloomPass(res, 0.55, 0.62, 1.25);

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
        tilt.uniforms.uMaxRadius.value = Math.max(4, dh * tier.dofRadius);
        tilt.uniforms.uEdge.value = tier.edgeDefocus;
        this.passes.tiltShift = tilt;
        composer.addPass(tilt);
      } else if (tilt) {
        tilt.dispose();
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

    const grade = this.passes.grade;
    if (grade) {
      const c = look.cdl;
      const u = grade.uniforms;
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
    if (bloom) bloom.strength = 0.42 + (look.bloom != null ? look.bloom : 0.5) * 0.34;
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
   * cutscenes and the intro orbit may want to pin it.
   * @param {?number} centre uv.y in [0,1], or null to resume tracking
   */
  setFocusBand(centre, width, falloff) {
    this._focusOverride = centre == null ? null : centre;
    const t = this.passes.tiltShift;
    if (!t) return;
    if (width != null) t.uniforms.uBandWidth.value = width;
    if (falloff != null) t.uniforms.uFalloff.value = falloff;
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
      p.tiltShift.uniforms.uMaxRadius.value = Math.max(4, dh * tier.dofRadius);
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

    if (p.grade) p.grade.uniforms.uExposure.value = renderer.toneMappingExposure;

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
      if (target != null) {
        // Critically damped, frame-rate independent: the band must never
        // overshoot or the whole frame breathes.
        const k = 1 - Math.exp(-dt / this._focusTau);
        this._focus += (target - this._focus) * k;
      }
      p.tiltShift.uniforms.uFocusCenter.value = this._focus;
    }

    /* motion blur ---------------------------------------------------------- */
    if (p.motionBlur && camera) {
      const u = p.motionBlur.uniforms;
      _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      u.uInvViewProj.value.copy(_vp).invert();
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
