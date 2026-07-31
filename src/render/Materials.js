// render/Materials.js — the shared material factory.
//
// Everything in the scene gets its material from here, and every material is
// cached by its full parameter signature, so a track with two hundred oak
// planks and eight cars compiles a handful of shader programs rather than
// hundreds.
//
// Three pieces of real shader work live in this file.
//
// 1. CAR PAINT. Die-cast toy paint is a metallic basecoat under a thick clear
//    lacquer, and getting that two-layer structure right is the single biggest
//    "is this AAA" tell on a racing game's cars. MeshPhysicalMaterial gives us
//    a clearcoat lobe but hard-codes its Fresnel at IOR 1.5, so we override
//    `material.clearcoatF0` from our own IOR uniform — a genuinely independent
//    second specular lobe with its own roughness and its own index. On top of
//    that, metallic flake: a two-lattice cell field in *object* space (flakes
//    are suspended in the paint, so they must not swim as the car moves) which
//    perturbs only the basecoat normal, never the clearcoat's. That ordering is
//    physically right and it is what makes the sparkle look like it is under
//    something. The flake field fades out on its own screen-space footprint, so
//    it resolves in close-ups and replays and dissolves cleanly at race
//    distance instead of aliasing into noise.
//
// 2. TRIPLANAR. Terrain, banking and ramp flanks have no sane UV layout; a
//    planar projection stretches into streaks the moment a surface tilts. The
//    triplanar path samples the albedo/ORM/normal on all three world axes and
//    blends by the world normal, with the whiteout blend for the normal map and
//    per-axis UV mirroring so the tangent frames agree. It is a genuine
//    implementation, not a lerp between two projections.
//
// 3. MACRO VARIATION. A tiling texture always eventually reads as tiling. Every
//    surface material gets a very low frequency world-space noise multiplied
//    into albedo and roughness — a few percent, invisible up close, and enough
//    to destroy the grid at gameplay distance.

import * as THREE from 'three';
import * as SurfacesMod from '../textures/Surfaces.js';
import * as Cfg from '../core/Settings.js';

const Surfaces = SurfacesMod.Surfaces ?? SurfacesMod.default ?? null;
const Settings = Cfg.Settings ?? Cfg.default ?? { render: { anisotropy: 8 }, textures: {} };

/* ================================================================ GLSL parts */

// Value noise on a sin-hash. Cheap, adequate for sub-percent modulation, and
// it costs no texture units — which matters because a physical material with
// albedo, ORM, normal, clearcoat and an env map is already close to the
// sampler budget on weaker hardware.
const GLSL_NOISE = /* glsl */`
float mgHash21( vec2 p ) {
  return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 );
}
float mgHash31( vec3 p ) {
  return fract( sin( dot( p, vec3( 127.1, 311.7, 74.7 ) ) ) * 43758.5453123 );
}
vec3 mgHash33( vec3 p ) {
  p = vec3( dot( p, vec3( 127.1, 311.7, 74.7 ) ),
            dot( p, vec3( 269.5, 183.3, 246.1 ) ),
            dot( p, vec3( 113.5, 271.9, 124.6 ) ) );
  return fract( sin( p ) * 43758.5453123 );
}
float mgValue2( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = mgHash21( i );
  float b = mgHash21( i + vec2( 1.0, 0.0 ) );
  float c = mgHash21( i + vec2( 0.0, 1.0 ) );
  float d = mgHash21( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}
float mgFbm2( vec2 p ) {
  return mgValue2( p ) * 0.55
       + mgValue2( p * 2.13 + 17.3 ) * 0.30
       + mgValue2( p * 4.71 + 41.7 ) * 0.15;
}
float mgValue3( vec3 p ) {
  vec3 i = floor( p );
  vec3 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float n000 = mgHash31( i );
  float n100 = mgHash31( i + vec3( 1.0, 0.0, 0.0 ) );
  float n010 = mgHash31( i + vec3( 0.0, 1.0, 0.0 ) );
  float n110 = mgHash31( i + vec3( 1.0, 1.0, 0.0 ) );
  float n001 = mgHash31( i + vec3( 0.0, 0.0, 1.0 ) );
  float n101 = mgHash31( i + vec3( 1.0, 0.0, 1.0 ) );
  float n011 = mgHash31( i + vec3( 0.0, 1.0, 1.0 ) );
  float n111 = mgHash31( i + vec3( 1.0, 1.0, 1.0 ) );
  return mix(
    mix( mix( n000, n100, f.x ), mix( n010, n110, f.x ), f.y ),
    mix( mix( n001, n101, f.x ), mix( n011, n111, f.x ), f.y ), f.z );
}
`;

const VERT_WORLD_DECL = 'varying vec3 vMgWorld;';
const VERT_NORMAL_DECL = 'varying vec3 vMgNormalW;';
const VERT_OBJ_DECL = 'varying vec3 vMgObj;';

// instanceMatrix is applied in <project_vertex>, not in <begin_vertex>, so a
// world position built here has to fold it in by hand or every instanced prop
// samples the texture as if it were still at the origin.
const VERT_WORLD_BODY = /* glsl */`
#ifdef USE_INSTANCING
  vMgWorld = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
#else
  vMgWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
#endif
`;

const VERT_NORMAL_BODY = /* glsl */`
#ifdef USE_INSTANCING
  vMgNormalW = mat3( modelMatrix ) * ( mat3( instanceMatrix ) * objectNormal );
#else
  vMgNormalW = mat3( modelMatrix ) * objectNormal;
#endif
`;

const FRAG_TRI_PRELUDE = /* glsl */`
vec3 mgWN = normalize( vMgNormalW );
vec3 mgBlend = pow( abs( mgWN ), vec3( uMgTriSharp ) );
mgBlend /= max( mgBlend.x + mgBlend.y + mgBlend.z, 1e-4 );
vec3 mgAxisSign = vec3(
  mgWN.x < 0.0 ? -1.0 : 1.0,
  mgWN.y < 0.0 ? -1.0 : 1.0,
  mgWN.z < 0.0 ? -1.0 : 1.0 );
vec3 mgP = vMgWorld * uMgTriScale;
vec2 mgUvX = vec2( mgP.z * mgAxisSign.x, mgP.y );
vec2 mgUvY = vec2( mgP.x * mgAxisSign.y, mgP.z );
vec2 mgUvZ = vec2( -mgP.x * mgAxisSign.z, mgP.y );
`;

const FRAG_TRI_MAP = /* glsl */`
#ifdef USE_MAP
  vec4 mgTexX = texture2D( map, mgUvX );
  vec4 mgTexY = texture2D( map, mgUvY );
  vec4 mgTexZ = texture2D( map, mgUvZ );
  vec4 sampledDiffuseColor = mgTexX * mgBlend.x + mgTexY * mgBlend.y + mgTexZ * mgBlend.z;
  diffuseColor *= sampledDiffuseColor;
#endif
`;

const FRAG_TRI_ROUGH = /* glsl */`
float roughnessFactor = roughness;
vec3 mgOrm = vec3( 1.0, 1.0, 0.0 );
#ifdef USE_ROUGHNESSMAP
  mgOrm = texture2D( roughnessMap, mgUvX ).rgb * mgBlend.x
        + texture2D( roughnessMap, mgUvY ).rgb * mgBlend.y
        + texture2D( roughnessMap, mgUvZ ).rgb * mgBlend.z;
  roughnessFactor *= mgOrm.g;
#endif
`;

const FRAG_TRI_METAL = /* glsl */`
float metalnessFactor = metalness;
#ifdef USE_METALNESSMAP
  metalnessFactor *= mgOrm.b;
#endif
`;

// The whiteout blend (Golus): reorient each projection's tangent-space normal
// into world space before the triblend, otherwise the three samples fight and
// the surface reads flat wherever two axes have similar weight.
const FRAG_TRI_NORMAL = /* glsl */`
#ifdef USE_NORMALMAP_TANGENTSPACE
  vec3 mgNx = texture2D( normalMap, mgUvX ).xyz * 2.0 - 1.0;
  vec3 mgNy = texture2D( normalMap, mgUvY ).xyz * 2.0 - 1.0;
  vec3 mgNz = texture2D( normalMap, mgUvZ ).xyz * 2.0 - 1.0;
  mgNx.xy *= normalScale;
  mgNy.xy *= normalScale;
  mgNz.xy *= normalScale;
  mgNx.x *= mgAxisSign.x;
  mgNy.x *= mgAxisSign.y;
  mgNz.x *= -mgAxisSign.z;
  mgNx = vec3( mgNx.xy + mgWN.zy, abs( mgNx.z ) * mgWN.x );
  mgNy = vec3( mgNy.xy + mgWN.xz, abs( mgNy.z ) * mgWN.y );
  mgNz = vec3( mgNz.xy + mgWN.xy, abs( mgNz.z ) * mgWN.z );
  vec3 mgWorldN = normalize(
    mgNx.zyx * mgBlend.x + mgNy.xzy * mgBlend.y + mgNz.xyz * mgBlend.z );
  normal = normalize( ( viewMatrix * vec4( mgWorldN, 0.0 ) ).xyz );
#endif
`;

const FRAG_TRI_AO = /* glsl */`
#ifdef USE_AOMAP
  float ambientOcclusion = ( mgOrm.r - 1.0 ) * aoMapIntensity + 1.0;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined( USE_CLEARCOAT )
    clearcoatSpecularIndirect *= ambientOcclusion;
  #endif
  #if defined( USE_SHEEN )
    sheenSpecularIndirect *= ambientOcclusion;
  #endif
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
  #endif
#endif
`;

/* ================================================================ injection */

const _ID = { n: 0 };

/**
 * Attach one compiled-in feature set to a material.
 *
 * All features share a single onBeforeCompile so they cannot clobber each
 * other, and the uniform objects are created once and handed to every program
 * the material compiles, so changing one at runtime reaches the GPU.
 */
function patch(material, feat, uniforms, keyParts) {
  material.userData.mgUniforms = uniforms;
  material.userData.mgFeatures = feat;

  material.onBeforeCompile = (shader) => {
    for (const k in uniforms) shader.uniforms[k] = uniforms[k];

    let vs = shader.vertexShader;
    let fs = shader.fragmentShader;

    /* ---- vertex varyings ---- */
    const vDecl = [];
    const vBody = [];
    if (feat.world) { vDecl.push(VERT_WORLD_DECL); vBody.push(VERT_WORLD_BODY); }
    if (feat.objPos) { vDecl.push(VERT_OBJ_DECL); vBody.push('vMgObj = transformed;'); }
    if (vDecl.length) {
      vs = vs.replace('#include <common>', `#include <common>\n${vDecl.join('\n')}`);
      vs = vs.replace('#include <begin_vertex>', `#include <begin_vertex>\n${vBody.join('\n')}`);
    }
    if (feat.worldNormal) {
      vs = vs.replace('#include <common>', `#include <common>\n${VERT_NORMAL_DECL}`);
      vs = vs.replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${VERT_NORMAL_BODY}`);
    }

    /* ---- fragment header ---- */
    const fDecl = [GLSL_NOISE];
    if (feat.world) fDecl.push(VERT_WORLD_DECL);
    if (feat.worldNormal) fDecl.push(VERT_NORMAL_DECL);
    if (feat.objPos) fDecl.push(VERT_OBJ_DECL);
    if (feat.macro) fDecl.push('uniform float uMgMacroScale;\nuniform float uMgMacroColor;\nuniform float uMgMacroRough;');
    if (feat.triplanar) fDecl.push('uniform float uMgTriScale;\nuniform float uMgTriSharp;');
    if (feat.flake) fDecl.push('uniform float uMgFlakeScale;\nuniform float uMgFlakeAmount;\nuniform float uMgFlakeGlint;\nuniform vec3 uMgFlakeColor;');
    if (feat.clearcoatIor) fDecl.push('uniform float uMgCcIor;\nuniform float uMgCcRough;');
    if (feat.peel) fDecl.push('uniform float uMgPeelScale;\nuniform float uMgPeelAmount;');
    // The flake and orange-peel blocks rotate an object-space direction into
    // view space with normalMatrix. three declares that uniform in the vertex
    // prefix only, so referencing it from the fragment stage is an undeclared
    // identifier and the whole program fails to link — the material then draws
    // nothing at all. GLSL uniforms are program-wide, so re-declaring it here
    // binds to the same value three already uploads.
    if ((feat.flake || feat.peel) && !/uniform\s+mat3\s+normalMatrix/.test(fs)) {
      fDecl.push('uniform mat3 normalMatrix;');
    }
    fs = fs.replace('#include <common>', `#include <common>\n${fDecl.join('\n')}`);

    /* ---- albedo: triplanar sampling, then macro variation ---- */
    let mapBlock = '';
    if (feat.triplanar) mapBlock += FRAG_TRI_PRELUDE;
    if (feat.macro) {
      mapBlock += 'float mgMacro = mgFbm2( vMgWorld.xz * uMgMacroScale );\n';
    }
    mapBlock += feat.triplanar ? FRAG_TRI_MAP : '#include <map_fragment>';
    if (feat.macro) {
      // One multiply gives both a brightness ripple and a slight warm/cool
      // drift, which is what stops the variation reading as a dirt overlay.
      mapBlock += `
diffuseColor.rgb *= 1.0 + ( mgMacro - 0.5 ) * uMgMacroColor * vec3( 2.10, 2.00, 1.82 );
`;
    }
    if (mapBlock !== '#include <map_fragment>') {
      fs = fs.replace('#include <map_fragment>', mapBlock);
    }

    /* ---- roughness / metalness ---- */
    let roughBlock = feat.triplanar ? FRAG_TRI_ROUGH : '#include <roughnessmap_fragment>';
    if (feat.macro) {
      roughBlock += `
roughnessFactor = clamp( roughnessFactor * ( 1.0 + ( mgMacro - 0.5 ) * uMgMacroRough * 2.0 ), 0.015, 1.0 );
`;
    }
    if (roughBlock !== '#include <roughnessmap_fragment>') {
      fs = fs.replace('#include <roughnessmap_fragment>', roughBlock);
    }
    if (feat.triplanar) {
      fs = fs.replace('#include <metalnessmap_fragment>', FRAG_TRI_METAL);
      fs = fs.replace('#include <aomap_fragment>', FRAG_TRI_AO);
    }

    /* ---- normal ---- */
    let normalBlock = feat.triplanar
      ? '#include <normal_fragment_maps>\n' + FRAG_TRI_NORMAL
      : '#include <normal_fragment_maps>';
    if (feat.flake) normalBlock += FRAG_FLAKE;
    if (normalBlock !== '#include <normal_fragment_maps>') {
      fs = fs.replace('#include <normal_fragment_maps>', normalBlock);
    }

    /* ---- clearcoat: orange peel on its own normal, then its own IOR ---- */
    if (feat.peel) {
      fs = fs.replace('#include <clearcoat_normal_fragment_maps>',
        '#include <clearcoat_normal_fragment_maps>\n' + FRAG_PEEL);
    }
    if (feat.clearcoatIor) {
      fs = fs.replace('#include <lights_physical_fragment>',
        '#include <lights_physical_fragment>\n' + FRAG_CC_IOR);
    }

    shader.vertexShader = vs;
    shader.fragmentShader = fs;
    material.userData.shader = shader;
  };

  // Without this three would happily reuse a program compiled from a different
  // injection for any material with the same parameter hash.
  const key = 'mg:' + keyParts.join('|');
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
  return material;
}

// Flakes perturb `normal` only. `nonPerturbedNormal` (and therefore
// clearcoatNormal) is left alone, which is exactly the physical arrangement:
// aluminium flakes are suspended in the basecoat, underneath the lacquer.
const FRAG_FLAKE = /* glsl */`
{
  // Screen-space footprint of one flake cell. Above roughly half a pixel the
  // field is past Nyquist, so it is faded out rather than allowed to alias
  // into a shimmering mess at race distance.
  float mgFw = max( length( fwidth( vMgObj ) ) * uMgFlakeScale, 1e-5 );
  float mgResolve = 1.0 - smoothstep( 0.20, 0.72, mgFw );
  float mgAmt = uMgFlakeAmount * mgResolve;
  if ( mgAmt > 0.002 ) {
    vec3 mgFp = vMgObj * uMgFlakeScale;
    vec3 mgCell = floor( mgFp );
    vec3 mgR1 = mgHash33( mgCell ) * 2.0 - 1.0;
    // A second lattice at an irrational relative scale and offset: a single
    // cubic grid shows its rows under a moving highlight.
    vec3 mgCell2 = floor( ( vMgObj + vec3( 7.31, 1.97, 4.13 ) ) * ( uMgFlakeScale * 1.618 ) );
    vec3 mgR2 = mgHash33( mgCell2 + 19.7 ) * 2.0 - 1.0;
    vec3 mgDir = normalize( mgR1 + mgR2 * 0.72 + vec3( 1e-5 ) );
    // Only a minority of flakes are steeply tilted; those are the glints.
    float mgGlint = pow( fract( mgR1.x * 0.5 + mgR2.y * 0.5 + 0.5 ), uMgFlakeGlint );
    vec3 mgDirV = normalize( normalMatrix * mgDir );
    vec3 mgTang = mgDirV - normal * dot( mgDirV, normal );
    normal = normalize( normal + mgTang * mgAmt * ( 0.30 + mgGlint * 1.7 ) );
    // A tilted flake is a mirror: locally the basecoat gets sharper, and it
    // takes the flake's own tint rather than the pigment's.
    roughnessFactor = clamp( roughnessFactor * ( 1.0 - mgGlint * mgAmt * 1.6 ), 0.02, 1.0 );
    diffuseColor.rgb = mix( diffuseColor.rgb, uMgFlakeColor, mgGlint * mgAmt * 0.55 );
  }
}
`;

// Orange peel: the long-wavelength ripple every sprayed lacquer has. Tiny
// amplitude, but it is what makes a reflected highlight crawl and wobble
// instead of sliding across the panel like glass.
const FRAG_PEEL = /* glsl */`
#ifdef USE_CLEARCOAT
{
  vec3 mgPp = vMgObj * uMgPeelScale;
  float mgH0 = mgValue3( mgPp );
  float mgE = 0.37;
  vec3 mgGrad = vec3(
    mgValue3( mgPp + vec3( mgE, 0.0, 0.0 ) ) - mgH0,
    mgValue3( mgPp + vec3( 0.0, mgE, 0.0 ) ) - mgH0,
    mgValue3( mgPp + vec3( 0.0, 0.0, mgE ) ) - mgH0 );
  vec3 mgGv = normalMatrix * mgGrad;
  vec3 mgT = mgGv - clearcoatNormal * dot( mgGv, clearcoatNormal );
  clearcoatNormal = normalize( clearcoatNormal + mgT * uMgPeelAmount );
}
#endif
`;

// three fixes the clearcoat Fresnel at vec3(0.04), i.e. IOR 1.5. Real
// automotive lacquer sits nearer 1.47-1.56 and a toy's thick dipped coat can
// read higher still, so the second lobe gets its own index here — which is
// what the contract means by a second specular lobe rather than a copy of the
// first with a different roughness.
const FRAG_CC_IOR = /* glsl */`
#ifdef USE_CLEARCOAT
  {
    float mgF0 = ( uMgCcIor - 1.0 ) / ( uMgCcIor + 1.0 );
    material.clearcoatF0 = vec3( mgF0 * mgF0 );
    material.clearcoatRoughness = clamp( uMgCcRough + geometryRoughness, 0.0125, 1.0 );
  }
#endif
`;

/* ================================================================== helpers */

const _cache = new Map();
const _texClones = new Map();
const _owned = new Set();
let _ctx = null;
let _env = null;
let _anisotropy = 8;

function keyOf(prefix, o) {
  const parts = [prefix];
  const keys = Object.keys(o || {}).sort();
  for (const k of keys) {
    const v = o[k];
    if (v === undefined) continue;
    parts.push(k + ':' + (v && v.isColor ? v.getHexString() : Array.isArray(v) ? v.join(',') : String(v)));
  }
  return parts.join(';');
}

/**
 * A repeat-adjusted view of a shared texture.
 *
 * Texture.clone() copies the wrapper but keeps the same Source, so all the
 * clones share one GPU upload — and, crucially, share the in-place resolution
 * upgrade Surfaces performs when the full-resolution bake lands.
 */
function withRepeat(tex, rx, ry, rot) {
  if (!tex) return null;
  if (rx === 1 && ry === 1 && !rot) return tex;
  const k = `${tex.uuid}|${rx}|${ry}|${rot || 0}`;
  const hit = _texClones.get(k);
  if (hit) return hit;
  const c = tex.clone();
  c.repeat.set(rx, ry);
  c.wrapS = THREE.RepeatWrapping;
  c.wrapT = THREE.RepeatWrapping;
  if (rot) { c.center.set(0.5, 0.5); c.rotation = rot; }
  c.needsUpdate = true;
  _texClones.set(k, c);
  return c;
}

/** Texture generation must never be able to take a frame down. If a bake
 *  throws we still hand back a lit, correctly-parameterised material — flat,
 *  but never a black mesh or a boot failure. */
function safeSet(kind) {
  try {
    return Surfaces?.textures?.(kind) ?? null;
  } catch (err) {
    console.error('[Materials] no textures for', kind, err);
    return null;
  }
}

function toColor(c, fallback = 0xffffff) {
  if (c === undefined || c === null) return new THREE.Color(fallback);
  return c.isColor ? c.clone() : new THREE.Color(c);
}

function remember(mat) {
  _owned.add(mat);
  return mat;
}

/* =============================================================== car paint */

// Eight liveries' worth of range: the flake is not just "sparkle on/off", it is
// what separates a candy red from a solid red, and it wants to differ per car.
const PAINT_PRESETS = {
  solid:    { metalness: 0.15, roughness: 0.34, flake: 0.0,  clearcoat: 1.0, clearcoatRoughness: 0.055, ccIor: 1.52 },
  metallic: { metalness: 0.85, roughness: 0.31, flake: 0.55, clearcoat: 1.0, clearcoatRoughness: 0.045, ccIor: 1.52 },
  pearl:    { metalness: 0.55, roughness: 0.26, flake: 0.35, clearcoat: 1.0, clearcoatRoughness: 0.035, ccIor: 1.58 },
  candy:    { metalness: 0.95, roughness: 0.20, flake: 0.75, clearcoat: 1.0, clearcoatRoughness: 0.028, ccIor: 1.60 },
  matte:    { metalness: 0.30, roughness: 0.62, flake: 0.10, clearcoat: 0.25, clearcoatRoughness: 0.42, ccIor: 1.46 },
  chromeish:{ metalness: 1.0,  roughness: 0.10, flake: 0.25, clearcoat: 1.0, clearcoatRoughness: 0.02, ccIor: 1.55 },
};

/**
 * The most important material in the game.
 *
 * @param {object} o
 * @param {number|THREE.Color} o.color basecoat pigment
 * @param {number} [o.flake] 0..1 flake density/strength
 * @param {number} [o.clearcoat] 0..1
 * @param {string} [o.preset] one of PAINT_PRESETS
 * @param {number} [o.flakeSize] flake cell size in world units (cm)
 */
export function carPaint(o = {}) {
  const preset = PAINT_PRESETS[o.preset] || PAINT_PRESETS.metallic;
  const color = toColor(o.color ?? 0xd6202a);
  const flake = o.flake ?? preset.flake;
  const key = keyOf('carPaint', {
    c: color.getHexString(), flake, cc: o.clearcoat ?? preset.clearcoat,
    p: o.preset || 'metallic', fs: o.flakeSize ?? 0, r: o.roughness ?? 0,
    m: o.metalness ?? 0, fc: o.flakeColor ?? 0, ior: o.clearcoatIor ?? 0,
  });
  const hit = _cache.get(key);
  if (hit) return hit;

  const mat = new THREE.MeshPhysicalMaterial({
    color,
    metalness: o.metalness ?? preset.metalness,
    roughness: o.roughness ?? preset.roughness,
    clearcoat: o.clearcoat ?? preset.clearcoat,
    clearcoatRoughness: o.clearcoatRoughness ?? preset.clearcoatRoughness,
    envMapIntensity: o.envMapIntensity ?? 1.35,
    ior: 1.48,
    sheen: 0,
  });
  mat.name = 'carPaint';
  if (_env) mat.envMap = _env;

  // A flake cell of ~0.045 cm on a 9 cm car sits at roughly two pixels at
  // race distance and several at replay distance: present but never crawling.
  const flakeSize = o.flakeSize ?? 0.045;
  const uniforms = {
    uMgFlakeScale: { value: 1 / Math.max(0.004, flakeSize) },
    uMgFlakeAmount: { value: flake * 0.55 },
    uMgFlakeGlint: { value: 3.4 },
    uMgFlakeColor: { value: toColor(o.flakeColor ?? 0xfff4e0) },
    uMgCcIor: { value: o.clearcoatIor ?? preset.ccIor },
    uMgCcRough: { value: o.clearcoatRoughness ?? preset.clearcoatRoughness },
    uMgPeelScale: { value: 1 / 0.55 },
    uMgPeelAmount: { value: (o.orangePeel ?? 1) * 0.55 },
  };

  patch(mat, {
    objPos: true,
    flake: flake > 0.001,
    clearcoatIor: (o.clearcoat ?? preset.clearcoat) > 0.001,
    peel: (o.clearcoat ?? preset.clearcoat) > 0.001 && (o.orangePeel ?? 1) > 0.001,
  }, uniforms, ['paint', flake > 0.001 ? 'f' : '-', (o.clearcoat ?? preset.clearcoat) > 0.001 ? 'c' : '-', (o.orangePeel ?? 1) > 0.001 ? 'p' : '-']);

  // Handy for a livery editor or a damage system to reach at runtime.
  mat.userData.setFlake = (v) => { uniforms.uMgFlakeAmount.value = v * 0.55; };
  mat.userData.setClearcoatIor = (v) => { uniforms.uMgCcIor.value = v; };

  _cache.set(key, mat);
  return remember(mat);
}

/* ================================================================ fixtures */

/** Polished chrome: the plated normal map carries the orange peel, so the
 *  roughness can go as low as it physically should without looking synthetic. */
export function chrome(o = {}) {
  const key = keyOf('chrome', o);
  const hit = _cache.get(key);
  if (hit) return hit;

  const set = safeSet('chromePlate');
  const rep = o.repeat ?? 1;
  const mat = new THREE.MeshPhysicalMaterial({
    color: toColor(o.color ?? 0xf4f5f6),
    metalness: 1,
    roughness: o.roughness ?? 1,
    map: set ? withRepeat(set.map, rep, rep) : null,
    normalMap: set ? withRepeat(set.normalMap, rep, rep) : null,
    roughnessMap: set ? withRepeat(set.roughnessMap, rep, rep) : null,
    metalnessMap: set ? withRepeat(set.ormMap, rep, rep) : null,
    envMapIntensity: o.envMapIntensity ?? 1.7,
    clearcoat: o.clearcoat ?? 0,
  });
  mat.normalScale.set(0.55, 0.55);
  mat.name = 'chrome';
  if (_env) mat.envMap = _env;
  _cache.set(key, mat);
  return remember(mat);
}

/**
 * Tinted window glazing. Real transmission is a second scene render, which is
 * not worth it for windows a centimetre across, so this is a thin transparent
 * dielectric with a clearcoat and a strong environment term — which is what
 * you actually see on a die-cast model anyway.
 */
export function glass(o = {}) {
  const key = keyOf('glass', o);
  const hit = _cache.get(key);
  if (hit) return hit;

  const mat = new THREE.MeshPhysicalMaterial({
    color: toColor(o.color ?? 0x2b3742),
    metalness: 0,
    roughness: o.roughness ?? 0.045,
    transparent: true,
    opacity: o.opacity ?? 0.42,
    ior: o.ior ?? 1.52,
    specularIntensity: 1,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
    envMapIntensity: o.envMapIntensity ?? 2.0,
    side: THREE.FrontSide,
    depthWrite: false,
  });
  if (o.transmission) {
    mat.transmission = o.transmission;
    mat.thickness = o.thickness ?? 0.4;
    mat.transparent = true;
  }
  mat.name = 'glass';
  if (_env) mat.envMap = _env;
  _cache.set(key, mat);
  return remember(mat);
}

/** Tyre rubber. Uses the moulded rubber surface at a tight repeat so the
 *  cavity texture reads even on a 1.15 u wheel. */
export function rubber(o = {}) {
  const key = keyOf('rubber', o);
  const hit = _cache.get(key);
  if (hit) return hit;

  const set = safeSet('rubber');
  const rep = o.repeat ?? 2;
  const mat = new THREE.MeshStandardMaterial({
    color: toColor(o.color ?? 0xffffff),
    metalness: 0,
    roughness: o.roughness ?? 1,
    map: set ? withRepeat(set.map, rep, rep) : null,
    normalMap: set ? withRepeat(set.normalMap, rep, rep) : null,
    roughnessMap: set ? withRepeat(set.roughnessMap, rep, rep) : null,
    aoMap: set ? withRepeat(set.aoMap, rep, rep) : null,
    envMapIntensity: o.envMapIntensity ?? 0.55,
  });
  mat.normalScale.set(o.normalScale ?? 1, o.normalScale ?? 1);
  mat.name = 'rubber';
  if (_env) mat.envMap = _env;
  _cache.set(key, mat);
  return remember(mat);
}

/** Moulded toy plastic — bumpers, spoilers, interior, props. */
export function plasticToy(o = {}) {
  const gloss = o.gloss ?? 0.75;
  const key = keyOf('plasticToy', { c: toColor(o.color ?? 0xffffff).getHexString(), gloss, rep: o.repeat ?? 3 });
  const hit = _cache.get(key);
  if (hit) return hit;

  const kind = gloss > 0.45 ? 'plasticGloss' : 'plasticMatte';
  const set = safeSet(kind);
  const rep = o.repeat ?? 3;
  const mat = new THREE.MeshPhysicalMaterial({
    color: toColor(o.color ?? 0xd23b2e),
    metalness: 0,
    roughness: 1,
    map: set ? withRepeat(set.map, rep, rep) : null,
    normalMap: set ? withRepeat(set.normalMap, rep, rep) : null,
    roughnessMap: set ? withRepeat(set.roughnessMap, rep, rep) : null,
    aoMap: set ? withRepeat(set.aoMap, rep, rep) : null,
    clearcoat: gloss * 0.9,
    clearcoatRoughness: 0.06 + (1 - gloss) * 0.35,
    ior: 1.5,
    envMapIntensity: o.envMapIntensity ?? 1,
  });
  mat.normalScale.set(0.8, 0.8);
  mat.name = 'plasticToy:' + kind;
  if (_env) mat.envMap = _env;

  const uniforms = {
    uMgCcIor: { value: 1.5 },
    uMgCcRough: { value: 0.06 + (1 - gloss) * 0.35 },
    uMgPeelScale: { value: 1 / 0.8 },
    uMgPeelAmount: { value: 0.30 },
  };
  patch(mat, { objPos: true, clearcoatIor: gloss > 0.05, peel: gloss > 0.45 },
    uniforms, ['plastic', gloss > 0.45 ? 'p' : '-']);

  _cache.set(key, mat);
  return remember(mat);
}

/**
 * Emissive lamp lens — headlights, brake lights, boost glow. Not in the
 * contract's list, but every one of these that is left as a flat coloured
 * quad is a visible failure at night, and the cars need them.
 */
export function lamp(o = {}) {
  const key = keyOf('lamp', o);
  const hit = _cache.get(key);
  if (hit) return hit;
  const c = toColor(o.color ?? 0xfff2d0);
  const mat = new THREE.MeshPhysicalMaterial({
    color: c,
    emissive: c,
    emissiveIntensity: o.intensity ?? 2.4,
    metalness: 0,
    roughness: 0.08,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    ior: 1.55,
    transparent: (o.opacity ?? 1) < 1,
    opacity: o.opacity ?? 1,
    envMapIntensity: 1.2,
  });
  mat.name = 'lamp';
  if (_env) mat.envMap = _env;
  mat.userData.setIntensity = (v) => { mat.emissiveIntensity = v; };
  _cache.set(key, mat);
  return remember(mat);
}

/* ================================================================ surfaces */

/**
 * A material for one of the named surfaces.
 *
 * @param {string} kind a Surfaces name
 * @param {object} [o]
 * @param {number|number[]} [o.repeat] texture repeats across the mesh UV, or
 *        repeats per world unit when `uvInWorldUnits` is set
 * @param {boolean} [o.triplanar] project on all three world axes instead of UVs
 * @param {boolean} [o.uvInWorldUnits] the mesh UVs are already in centimetres
 * @param {number|THREE.Color} [o.color] multiplied over the albedo
 */
export function surface(kind, o = {}) {
  const d = Surfaces?.def ? Surfaces.def(kind) : null;
  const name = d?.id ?? kind;

  const triplanar = !!o.triplanar;
  let rx = 1, ry = 1;
  if (Array.isArray(o.repeat)) { rx = o.repeat[0]; ry = o.repeat[1]; }
  else if (typeof o.repeat === 'number') { rx = ry = o.repeat; }
  if (o.uvInWorldUnits && d) {
    const s = 1 / Math.max(0.01, d.tileWorld);
    rx *= s; ry *= s;
  }

  const key = keyOf('surface:' + name, {
    rx: +rx.toFixed(5), ry: +ry.toFixed(5), tri: triplanar,
    col: o.color !== undefined ? toColor(o.color).getHexString() : '',
    ns: o.normalScale ?? 1, ao: o.aoIntensity ?? 1,
    env: o.envMapIntensity ?? '', side: o.side ?? '',
    rot: o.rotation ?? 0, macro: o.macro ?? '',
    disp: o.displacement ?? false, tr: o.transparent ?? '',
  });
  const hit = _cache.get(key);
  if (hit) return hit;

  const set = safeSet(name);
  const md = d?.material ?? {};
  const physical = md.type === 'physical' || md.clearcoat > 0 || md.sheen > 0 ||
    md.anisotropy > 0 || md.iridescence > 0;

  const params = {
    color: toColor(o.color ?? 0xffffff),
    metalness: md.metalness ?? 0,
    roughness: md.roughness ?? 1,
    envMapIntensity: o.envMapIntensity ?? md.envMapIntensity ?? 1,
  };

  if (set) {
    // Triplanar computes its own UVs in the shader, so the repeat must not
    // also be baked into the texture matrix or it would be applied twice.
    const R = triplanar ? 1 : rx;
    const RY = triplanar ? 1 : ry;
    const rot = triplanar ? 0 : (o.rotation ?? 0);
    params.map = withRepeat(set.map, R, RY, rot);
    params.normalMap = withRepeat(set.normalMap, R, RY, rot);
    params.roughnessMap = withRepeat(set.roughnessMap, R, RY, rot);
    params.aoMap = withRepeat(set.aoMap, R, RY, rot);
    if (set.metalnessMap) {
      params.metalnessMap = withRepeat(set.ormMap, R, RY, rot);
      params.metalness = 1;
    }
    if (o.displacement && set.displacementMap) {
      params.displacementMap = withRepeat(set.displacementMap, R, RY, rot);
      params.displacementScale = o.displacementScale ?? (d?.relief ?? 0.1);
    }
    if (set.hasAlpha || md.transparent) {
      params.transparent = o.transparent ?? true;
      params.alphaTest = o.alphaTest ?? md.alphaTest ?? 0.02;
    }
  }

  const mat = physical ? new THREE.MeshPhysicalMaterial(params) : new THREE.MeshStandardMaterial(params);
  mat.name = 'surface:' + name;

  if (physical) {
    if (md.clearcoat) { mat.clearcoat = md.clearcoat; mat.clearcoatRoughness = md.clearcoatRoughness ?? 0.1; }
    if (md.ior) mat.ior = md.ior;
    if (md.sheen) {
      mat.sheen = md.sheen;
      mat.sheenRoughness = md.sheenRoughness ?? 0.5;
      mat.sheenColor = toColor(md.sheenColor ?? 0xffffff);
    }
    // Anisotropic specular needs a tangent frame; the triplanar path replaces
    // the tangent-space normal path entirely, so the two cannot coexist.
    if (md.anisotropy && !triplanar) {
      mat.anisotropy = md.anisotropy;
      mat.anisotropyRotation = md.anisotropyRotation ?? 0;
    }
    if (md.iridescence) {
      mat.iridescence = md.iridescence;
      mat.iridescenceIOR = md.iridescenceIOR ?? 1.3;
      mat.iridescenceThicknessRange = md.iridescenceThicknessRange ?? [100, 400];
      if (set?.thicknessMap) mat.iridescenceThicknessMap = withRepeat(set.thicknessMap, triplanar ? 1 : rx, triplanar ? 1 : ry, 0);
    }
  }

  if (md.decal) {
    // Decals sit a hair above the surface they are laid on; polygon offset is
    // cheaper and steadier than nudging the geometry along the normal.
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = o.offsetFactor ?? -2;
    mat.polygonOffsetUnits = o.offsetUnits ?? -4;
    mat.depthWrite = o.depthWrite ?? false;
  }
  if (o.side !== undefined) mat.side = o.side;
  if (mat.normalScale) {
    const ns = o.normalScale ?? 1;
    mat.normalScale.set(ns, ns);
  }
  if (o.aoIntensity !== undefined) mat.aoMapIntensity = o.aoIntensity;
  if (_env) mat.envMap = _env;

  /* ---- shader features ---- */
  const macro = d?.macro ?? { colorAmount: 0.06, roughAmount: 0.1, scale: 0.004 };
  const macroMul = o.macro ?? 1;
  const useMacro = macroMul > 0.001 && (macro.colorAmount > 0 || macro.roughAmount > 0);

  if (useMacro || triplanar) {
    const uniforms = {
      uMgMacroScale: { value: macro.scale },
      uMgMacroColor: { value: macro.colorAmount * macroMul },
      uMgMacroRough: { value: macro.roughAmount * macroMul },
      uMgTriScale: { value: (1 / Math.max(0.01, d?.tileWorld ?? 40)) * (typeof o.repeat === 'number' ? o.repeat : 1) },
      uMgTriSharp: { value: o.triSharpness ?? 5.0 },
    };
    patch(mat, {
      world: true,
      worldNormal: triplanar,
      macro: useMacro,
      triplanar,
    }, uniforms, ['surf', triplanar ? 'tri' : 'uv', useMacro ? 'm' : '-', physical ? 'p' : 's', set?.metalnessMap ? 'me' : '-']);
  }

  _cache.set(key, mat);
  return remember(mat);
}

/* ================================================================== facade */

export const Materials = {
  name: 'materials',

  async init(ctx) {
    _ctx = ctx || null;
    _anisotropy = Math.max(1, Math.min(16, Settings.render?.anisotropy ?? 8));
    Surfaces?.setAnisotropy?.(_anisotropy);
    if (typeof window !== 'undefined') {
      window.MG = window.MG || {};
      window.MG.materials = Materials;
    }
    // Nothing is baked here: Surfaces hands back a draft immediately and
    // sharpens it on idle, so the boot never stalls on texture generation.
    return this;
  },

  /**
   * Generic accessor. `kind` is either one of the named surfaces or one of the
   * hand-authored materials ('carPaint', 'chrome', 'glass', 'rubber',
   * 'plasticToy', 'lamp').
   */
  get(kind, opts = {}) {
    switch (kind) {
      case 'carPaint': case 'paint': return carPaint(opts);
      case 'chrome': return chrome(opts);
      case 'glass': return glass(opts);
      case 'rubber': case 'tyre': return rubber(opts);
      case 'plasticToy': case 'plastic': return plasticToy(opts);
      case 'lamp': case 'light': return lamp(opts);
      default: return surface(kind, opts);
    }
  },

  carPaint,
  chrome,
  glass,
  rubber,
  plasticToy,
  lamp,
  surface,

  PAINT_PRESETS,

  /** Lighting pushes its PMREM environment here; three would apply
   *  scene.environment automatically, but an explicit handle lets a track use a
   *  different probe for its props than for its sky. */
  setEnvMap(tex, intensity) {
    _env = tex || null;
    for (const m of _owned) {
      m.envMap = _env;
      if (intensity !== undefined) m.envMapIntensity = intensity;
      m.needsUpdate = true;
    }
    return this;
  },

  setAnisotropy(v) {
    _anisotropy = Math.max(1, Math.min(16, v | 0));
    Surfaces?.setAnisotropy?.(_anisotropy);
    for (const t of _texClones.values()) { t.anisotropy = _anisotropy; t.needsUpdate = true; }
    return this;
  },

  applySettings(s) {
    if (s?.render?.anisotropy) this.setAnisotropy(s.render.anisotropy);
    return this;
  },

  /** Preload the surfaces a track declares, at full resolution, yielding
   *  between each so a loading bar can move. */
  async warm(kinds, onProgress) {
    return Surfaces?.warm?.(kinds, { onProgress }) ?? 0;
  },

  stats() {
    return {
      materials: _cache.size,
      textureClones: _texClones.size,
      surfaces: Surfaces?.stats?.() ?? null,
    };
  },

  dispose() {
    for (const m of _owned) m.dispose();
    _owned.clear();
    _cache.clear();
    for (const t of _texClones.values()) t.dispose();
    _texClones.clear();
    _env = null;
  },
};

export default Materials;
