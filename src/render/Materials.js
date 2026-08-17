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
//    that, metallic flake: two octaves of a two-lattice cell field in *object*
//    space (flakes are suspended in the paint, so they must not swim as the car
//    moves) whose tilted normal is handed to the basecoat's *direct* specular
//    lobe and to nothing else — not the diffuse term, not the environment lobe,
//    not the clearcoat. That is what makes the sparkle live inside the specular
//    sweep and look like it is under something, instead of dusting the whole
//    body in stipple. Each octave fades out on its own screen-space
//    footprint, and the two are sized so that the handover lands inside the
//    range of framings the game actually composes: the coarse grain carries the
//    race and results cameras, the fine one takes over in a close-up, and both
//    dissolve cleanly rather than aliasing into noise.
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

// The compiled shader is kept out of userData on purpose. THREE.Material.copy()
// deep-clones userData through JSON, and a shader object reaches the bound
// textures, whose sources are multi-megabyte typed arrays: serialising one is
// not a slow clone, it is a hung tab.
const _shaders = new WeakMap();

/**
 * Attach one compiled-in feature set to a material.
 *
 * All features share a single onBeforeCompile so they cannot clobber each
 * other, and the uniform objects are created once and handed to every program
 * the material compiles, so changing one at runtime reaches the GPU.
 *
 * @param {Function} [install] re-applied to clones, for the convenience setters
 *        a material exposes on top of its uniforms
 */
function patch(material, feat, uniforms, keyParts, install) {
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
    if (feat.flake) fDecl.push(FRAG_FLAKE_DECL);
    if (feat.clearcoatIor) fDecl.push('uniform float uMgCcIor;\nuniform float uMgCcRough;\nuniform float uMgCcFromRough;');
    if (feat.specAA) fDecl.push('uniform float uMgSaaVar;\nuniform float uMgSaaMax;\nuniform float uMgRoughMin;');
    if (feat.peel) fDecl.push('uniform float uMgPeelScale;\nuniform float uMgPeelAmount;');
    if (feat.glassFresnel) fDecl.push('uniform float uMgGlassEdge;\nuniform float uMgGlassBase;');
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
    // The flake field writes to mgFlakeNormal, never to `normal`, so everything
    // downstream of here — the diffuse term, the IBL irradiance, the specular
    // antialiasing filter — sees the paint's own smooth shading normal.
    if (feat.flake) normalBlock += FRAG_FLAKE;
    if (normalBlock !== '#include <normal_fragment_maps>') {
      fs = fs.replace('#include <normal_fragment_maps>', normalBlock);
    }

    /* ---- clearcoat: orange peel on its own normal, then its own IOR ---- */
    if (feat.peel) {
      fs = fs.replace('#include <clearcoat_normal_fragment_maps>',
        '#include <clearcoat_normal_fragment_maps>\n' + FRAG_PEEL);
    }

    /* ---- lobe tuning: clearcoat index, then specular antialiasing ----
       Order matters. FRAG_CC_IOR authors the coat's intended roughness; the
       antialiasing pass then widens whatever both lobes ended up with, so it
       has to run last or its correction would simply be overwritten. */
    let physBlock = '#include <lights_physical_fragment>';
    if (feat.flake) physBlock += '\n' + FRAG_FLAKE_SPEC;
    if (feat.clearcoatIor) physBlock += '\n' + FRAG_CC_IOR;
    if (feat.specAA) physBlock += '\n' + specAaBlock('normal');
    if (physBlock !== '#include <lights_physical_fragment>') {
      fs = fs.replace('#include <lights_physical_fragment>', physBlock);
    }

    /* ---- the flake's one and only consumer: the direct specular lobe ---- */
    if (feat.flake) {
      fs = fs.replace('#include <lights_physical_pars_fragment>',
        '#include <lights_physical_pars_fragment>\n' + FRAG_FLAKE_DIRECT);
    }

    /* ---- glazing: alpha rises toward the grazing angle ---- */
    if (feat.glassFresnel) {
      fs = fs.replace('#include <opaque_fragment>', FRAG_GLASS_FRESNEL + '\n#include <opaque_fragment>');
    }

    shader.vertexShader = vs;
    shader.fragmentShader = fs;
    _shaders.set(material, shader);
  };

  // Without this three would happily reuse a program compiled from a different
  // injection for any material with the same parameter hash.
  const key = 'mg:' + keyParts.join('|');
  material.customProgramCacheKey = () => key;

  // THREE.Material.copy() deliberately carries neither onBeforeCompile nor
  // customProgramCacheKey, so a plain .clone() of anything from this factory
  // comes back stripped of every injection in this file — the macro variation,
  // the triplanar projection, the clearcoat lobe and the specular
  // antialiasing — while still looking like a correctly configured PBR
  // material. TrackBuilder clones every surface material it takes from here,
  // which means the road and the ground, the two biggest things in frame, are
  // exactly the surfaces that would silently miss out. Overriding clone() on
  // the instance is the only hook available, since copy() is what drops them.
  //
  // Uniform holders are duplicated rather than shared so a clone can be tuned
  // on its own; the cache key is identical, so both still compile one program.
  material.clone = function mgClone() {
    const copy = new this.constructor();
    // Material.copy() JSON round-trips userData. Ours is safe, but a caller may
    // have parked something that is not, and this is not the place to find out.
    const keep = this.userData;
    this.userData = {};
    try { copy.copy(this); } finally { this.userData = keep; }

    const u = {};
    for (const k in uniforms) {
      const v = uniforms[k].value;
      u[k] = { value: v && typeof v.clone === 'function' ? v.clone() : v };
    }
    copy.userData = {};
    patch(copy, feat, u, keyParts, install);
    install?.(copy, u);
    return copy;
  };

  material.needsUpdate = true;
  return material;
}

// The flake field's outputs are file-scope globals because their only consumer,
// mgRE_Direct, is a function declared long before main() ever runs.
const FRAG_FLAKE_DECL = /* glsl */`
uniform float uMgFlakeScale;
uniform float uMgFlakeAmount;
uniform float uMgFlakeGlint;
uniform vec3 uMgFlakeColor;
vec3 mgFlakeNormal = vec3( 0.0, 0.0, 1.0 );
float mgFlakeGlint = 0.0;
float mgFlakeShow = 0.0;
float mgFlakeSharp = 0.0;
`;

// FLAKE IS A SPECULAR EFFECT AND NOTHING ELSE, and "specular" here means the
// *direct* lobe specifically. A flake is a two-micron mirror suspended in the
// binder; it is not a change of pigment and it is not a change of the surface
// the light meets.
//
// Two earlier versions each leaked it somewhere else and each leak read the
// same way — a dense, uniform, high-contrast stipple that looks like
// bead-blasted metal or stone-effect spray rather than paint. First the flake
// tint was mixed into `diffuseColor`. Then, after that was removed, the field
// still wrote to `normal` and to `roughnessFactor`, which is subtler but worse:
// `normal` feeds the Lambert term and the IBL irradiance as well as the
// specular, and `roughnessFactor` feeds the *environment* lobe, so a per-pixel
// random field arrived on every panel of the car at equal density whether it
// faced the key or sat in the shadow of the valance. Measured on a macro frame
// that was a high-frequency deviation of 13% of panel mean, four to five times
// the film-grain floor, and it sat on the livery bands and the deep shade
// exactly as strongly as on the specular sweep — which is the giveaway, because
// real flake only exists inside the sweep.
//
// So the field now writes to `mgFlakeNormal`, `mgFlakeGlint`, `mgFlakeShow` and
// `mgFlakeSharp` and touches nothing three will read on its own. mgRE_Direct
// (FRAG_FLAKE_DIRECT) is the only thing that consumes them, and it hands them
// to BRDF_GGX for the direct lobe alone. Diffuse, IBL irradiance, IBL radiance,
// the clearcoat and the specular-antialiasing filter all keep the smooth
// shading normal. A tilted flake then brightens only where the half-vector
// happens to swing onto it, which is what puts the sparkle in the sweep and
// nowhere else.
//
// `nonPerturbedNormal` (and therefore clearcoatNormal) was already left alone,
// which is the physical arrangement: aluminium flakes are suspended in the
// basecoat, underneath the lacquer.
//
// The field is also split into a statistical half and a resolved half.
// *Coverage* — what fraction of the basecoat is aluminium rather than binder —
// is a property of the paint, not of how many pixels the car happens to
// occupy, so it drives the specular colour at every distance and a minified
// car keeps its metallic sheen instead of collapsing to a matte slab. Only the
// per-flake glint and the normal tilt fade with the screen footprint, because
// those are the two parts that would alias.
const FRAG_FLAKE = /* glsl */`
mgFlakeNormal = normal;
{
  // Screen-space footprint of one flake cell, in cells per pixel. Past about
  // one cell per pixel the field is beyond Nyquist and is faded out rather
  // than allowed to crawl at race distance.
  float mgFw = max( length( fwidth( vMgObj ) ) * uMgFlakeScale, 1e-5 );
  float mgResolve = 1.0 - smoothstep( 0.35, 1.60, mgFw );
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
    vec3 mgTang = mgDirV - mgFlakeNormal * dot( mgDirV, mgFlakeNormal );
    // Milled aluminium flake floats nearly parallel to the film surface: the
    // spread is a few degrees, not the forty the old constants asked for. A
    // tangent offset of 0.17 is about ten degrees at the steepest flake.
    mgFlakeNormal = normalize( mgFlakeNormal + mgTang * mgAmt * ( 0.06 + mgGlint * 0.34 ) );
    // A tilted flake is a mirror, so the basecoat sharpens locally where one
    // catches the key. Accumulated rather than applied: it is a narrowing of
    // the direct lobe only, and the environment lobe must not see it.
    mgFlakeSharp = 1.0 - ( 1.0 - mgFlakeSharp ) * ( 1.0 - mgGlint * mgAmt * 0.85 );
    mgFlakeGlint = mgGlint;
    mgFlakeShow = mgAmt;
  }

  // A SECOND, COARSER OCTAVE.
  //
  // The lattice above is 0.014 cm and the window it is measured against
  // retires it at roughly one cell per pixel. Against the framing this game
  // actually composes that window never opens: Director holds the car at
  // 8.5-20 percent of frame height during a race and 42 percent in the
  // results hero pose, which over a 9 cm car works out at 18-35 px/cm racing
  // and 75-108 px/cm at the hero shot. One 0.014 cm cell is then a quarter of
  // a pixel to one and a half pixels, so mgResolve above is exactly zero in
  // every race frame and only wakes up, partially, in the results shot at a
  // high pixel ratio. The fine octave alone is a block that costs shader
  // instructions and returns nothing at the cameras that exist.
  //
  // Enlarging the fine cell is not the answer: 0.045 cm as the ONLY octave
  // read as confetti rather than as flake, which is why it was shrunk. So the
  // coarse grain is added ALONGSIDE at 3.2x the cell (0.014 -> 0.045 cm) and
  // about a third of the tilt, measured through the same window on its own
  // proportionally smaller footprint. It carries from race distance through
  // the hero shot and hands over to the fine octave in extreme close-up, and
  // it fades out on its own Nyquist limit exactly as the fine one does, so
  // nothing crawls at the establishing camera either.
  //
  // The scale is derived from uMgFlakeScale rather than uploaded as a second
  // uniform, deliberately: an undeclared fragment uniform is precisely how
  // this material rendered invisible once already.
  float mgFwC = mgFw / 3.2;
  float mgAmtC = uMgFlakeAmount * ( 1.0 - smoothstep( 0.35, 1.60, mgFwC ) );
  if ( mgAmtC > 0.002 ) {
    float mgScaleC = uMgFlakeScale / 3.2;
    vec3 mgCellC = floor( ( vMgObj + vec3( 2.17, 5.63, 8.09 ) ) * mgScaleC );
    vec3 mgRc1 = mgHash33( mgCellC + 3.9 ) * 2.0 - 1.0;
    // Same two-lattice trick as the fine octave, and it matters more here:
    // a bare cubic grid shows its rows far more readably at 0.045 cm.
    vec3 mgCellD = floor( ( vMgObj + vec3( 11.4, 3.27, 6.71 ) ) * ( mgScaleC * 1.618 ) );
    vec3 mgRc2 = mgHash33( mgCellD + 27.3 ) * 2.0 - 1.0;
    vec3 mgDirC = normalize( mgRc1 + mgRc2 * 0.72 + vec3( 1e-5 ) );
    float mgGlintC = pow( fract( mgRc1.x * 0.5 + mgRc2.y * 0.5 + 0.5 ), uMgFlakeGlint );
    vec3 mgDirCV = normalize( normalMatrix * mgDirC );
    vec3 mgTangC = mgDirCV - mgFlakeNormal * dot( mgDirCV, mgFlakeNormal );
    // A third of the fine octave's tilt: 0.13 against 0.40 at the steepest
    // flake, about three degrees rather than ten. A coarse grain carrying the
    // fine octave's amplitude is exactly what read as glitter before.
    mgFlakeNormal = normalize( mgFlakeNormal + mgTangC * mgAmtC * ( 0.02 + mgGlintC * 0.11 ) );
    mgFlakeSharp = 1.0 - ( 1.0 - mgFlakeSharp ) * ( 1.0 - mgGlintC * mgAmtC * 0.28 );
    // max, not sum: where both octaves resolve, the sparkle term handed to
    // mgRE_Direct must not double up on the coverage term already folded into
    // material.specularColor by FRAG_FLAKE_SPEC.
    mgFlakeGlint = max( mgFlakeGlint, mgGlintC );
    mgFlakeShow = max( mgFlakeShow, mgAmtC * 0.33 );
  }
}
`;

// The *statistical* half of the flake: coverage. In a metallic paint it is the
// aluminium, not the pigment, that owns F0 — that is why a black metallic panel
// is not black but a dim mirror, and why lifting the coverage term is what
// gives a dark livery a continuous basecoat instead of scattered glitter over a
// void. Coverage is a property of the paint, identical on every pixel, so it is
// safe here on `material` where both lobes will read it: a constant cannot
// stipple. The per-pixel half of the tint lives in mgRE_Direct instead.
const FRAG_FLAKE_SPEC = /* glsl */`
{
  float mgCov = clamp( uMgFlakeAmount * 1.15, 0.0, 1.0 );
  vec3 mgFlakeF0 = uMgFlakeColor * 0.92;
  material.specularColor = mix( material.specularColor, mgFlakeF0, clamp( mgCov * 0.55, 0.0, 1.0 ) );
}
`;

// The direct-lighting wrapper: the one place the resolved flake field is
// allowed to act.
//
// three routes diffuse and specular through a single geometryNormal inside
// RE_Direct_Physical, so there is no argument to hand a second normal to. The
// wrapper calls the stock function with the flake normal into a scratch
// accumulator, keeps its specular, throws its diffuse away, and re-derives the
// diffuse from the unperturbed normal — which is exactly the two lines
// RE_Direct_Physical would have run. Substituting the RE_Direct macro is what
// three's own material variants do, so the call site in lights_fragment_begin
// needs no patching.
//
// The cost is one extra saturate/dot/multiply per light on car paint only. The
// clearcoat and sheen accumulators are globals written inside the stock
// function, so it must be called exactly once — hence the scratch
// ReflectedLight rather than two calls with a difference taken.
const FRAG_FLAKE_DIRECT = /* glsl */`
void mgRE_Direct( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  PhysicalMaterial mgMat = material;
  mgMat.roughness = clamp( material.roughness * ( 1.0 - mgFlakeSharp ), 0.03, 1.0 );
  mgMat.specularColor = mix( material.specularColor, uMgFlakeColor * 0.92,
    clamp( mgFlakeShow * mgFlakeGlint * 0.55, 0.0, 1.0 ) );

  ReflectedLight mgRl = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
  RE_Direct_Physical( directLight, geometryPosition, mgFlakeNormal, geometryViewDir, geometryClearcoatNormal, mgMat, mgRl );
  reflectedLight.directSpecular += mgRl.directSpecular;

  float mgDotNL = saturate( dot( geometryNormal, directLight.direction ) );
  reflectedLight.directDiffuse += mgDotNL * directLight.color * BRDF_Lambert( material.diffuseColor );
}
#undef RE_Direct
#define RE_Direct mgRE_Direct
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
//
// The coat also takes a roughness floor from the substrate. A clear film is not
// a separate perfect sheet hovering above the surface: where the thing under it
// is scuffed, dusty or open-grained, the film follows that topography and
// scatters with it. Because `roughnessFactor` comes from the mip-filtered
// roughness map, this is also what makes the coat lose its mirror with
// distance instead of holding a razor reflection down to one pixel.
const FRAG_CC_IOR = /* glsl */`
#ifdef USE_CLEARCOAT
  {
    float mgF0 = ( uMgCcIor - 1.0 ) / ( uMgCcIor + 1.0 );
    material.clearcoatF0 = vec3( mgF0 * mgF0 );
    float mgCcR = max( uMgCcRough, roughnessFactor * uMgCcFromRough );
    material.clearcoatRoughness = clamp( mgCcR + geometryRoughness, 0.0125, 1.0 );
  }
#endif
`;

// GEOMETRIC SPECULAR ANTIALIASING — Tokuyoshi & Kaplanyan 2019, in Filament's
// formulation.
//
// A pixel does not see one normal. It sees a distribution of them, and the
// width of that distribution is physically indistinguishable from roughness:
// a smooth surface whose normal sweeps ten degrees across one pixel scatters
// exactly like a rough surface that stands still. Renderers that ignore this
// try to resolve the resulting highlight on the pixel grid, cannot, and alias —
// and because the environment being reflected is coloured, the aliasing is
// chromatic. That is the mechanism behind a varnished table combing into red
// and blue bands at a grazing angle: nothing about the wood is wrong, the
// specular lobe is simply narrower than the pixel that has to contain it.
//
// So the sweep is measured from the screen-space derivatives of the *shading*
// normal and folded into the GGX alpha. three already adds a geometryRoughness
// term, but it is computed from nonPerturbedNormal — the interpolated vertex
// normal — so it never sees the normal map, the triplanar blend or the paint
// flake field, which is where nearly all of the variance actually lives.
//
// alpha'^2 = alpha^2 + min(2 * sigma^2, ceiling), and perceptual roughness is
// sqrt(alpha), hence the fourth root. The ceiling is what keeps a silhouette or
// a hard crease from dissolving the material into flat grey.
const specAaBlock = (nrm) => /* glsl */`
{
  vec3 mgNdx = dFdx( ${nrm} );
  vec3 mgNdy = dFdy( ${nrm} );
  float mgKernel = min( 2.0 * uMgSaaVar * ( dot( mgNdx, mgNdx ) + dot( mgNdy, mgNdy ) ), uMgSaaMax );
  float mgA = material.roughness * material.roughness;
  material.roughness = clamp( sqrt( sqrt( clamp( mgA * mgA + mgKernel, 0.0, 1.0 ) ) ), uMgRoughMin, 1.0 );

  #ifdef USE_ANISOTROPY
    // alphaT was derived from material.roughness inside the chunk we just ran,
    // so it has to be rebuilt or the anisotropic lobe keeps the unfiltered
    // width and brushed metal goes on shimmering.
    material.alphaT = mix( pow2( material.roughness ), 1.0, pow2( material.anisotropy ) );
  #endif

  #ifdef USE_CLEARCOAT
    // The coat gets the same filter at a fraction of the strength, and that
    // asymmetry is deliberate. Its normal is the raw geometric one, so on a
    // die-cast the derivative is not measuring microfacet detail — it is
    // measuring the 0.3 u fillets the entire model is built out of, and those
    // fillets are exactly where the one highlight this material exists to
    // produce has to land. Filtered at full strength a 20-pixel fillet lifts
    // the coat from 0.045 to 0.23 and the highlight stops being a line, which
    // is why no panel on the car had one. Some shimmer on a rolling highlight
    // is the cheaper defect, and SMAA takes the edge off it.
    vec3 mgCdx = dFdx( clearcoatNormal );
    vec3 mgCdy = dFdy( clearcoatNormal );
    float mgCk = min( 2.0 * uMgSaaVar * 0.15 * ( dot( mgCdx, mgCdx ) + dot( mgCdy, mgCdy ) ), uMgSaaMax * 0.25 );
    float mgCa = material.clearcoatRoughness * material.clearcoatRoughness;
    material.clearcoatRoughness = clamp( sqrt( sqrt( clamp( mgCa * mgCa + mgCk, 0.0, 1.0 ) ) ), 0.0180, 1.0 );
  #endif
}
`;

// Glazing alpha has to be a function of angle or it is not glass. A flat 46%
// blend attenuates the reflection along with everything else, so a windscreen
// ends up a uniformly murky film — which is precisely how "painted-on glass"
// reads. Schlick on the shading normal instead: face-on the pane stays open
// and you see the cabin through it, at a grazing angle it goes almost opaque
// with sky. That gradient across a curved screen is the whole read.
const FRAG_GLASS_FRESNEL = /* glsl */`
{
  vec3 mgVdir = normalize( vViewPosition );
  float mgFres = pow( 1.0 - clamp( dot( normal, mgVdir ), 0.0, 1.0 ), 5.0 );
  diffuseColor.a = clamp( mix( uMgGlassBase, uMgGlassEdge, mgFres ) * ( diffuseColor.a / max( opacity, 1e-4 ) ), 0.0, 1.0 );
}
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
  // A clone carries its own version counter and its own mipmap array, so the
  // in-place resolution upgrade has to be told it exists or it can end up
  // re-uploading the draft chain over the sharp one.
  Surfaces?.linkDerived?.(tex, c);
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

// Defaults for the specular antialiasing filter. `variance` is the assumed
// screen-space variance of the pixel reconstruction filter (Filament ships
// 0.15; a little more suits a game whose signature look is a long lens with a
// bright key, where under-filtering shows immediately). `max` is the ceiling on
// how much GGX width one pixel of normal sweep may add.
const SAA_VAR = 0.25;
const SAA_MAX = 0.20;
// three's own floor. Anything below this is a lobe narrower than the pixel
// that has to contain it, which is where specular aliasing starts.
const SAA_MIN = 0.0525;

/** The antialiasing-only patch, for materials that need no other injection. */
function withSpecAA(mat, tag, variance = SAA_VAR, max = SAA_MAX, min = SAA_MIN) {
  patch(mat, { specAA: true }, {
    uMgSaaVar: { value: variance },
    uMgSaaMax: { value: max },
    uMgRoughMin: { value: min },
  }, ['saa', tag]);
  return mat;
}

/* =============================================================== car paint */

// Eight liveries' worth of range: the flake is not just "sparkle on/off", it is
// what separates a candy red from a solid red, and it wants to differ per car.
//
// METALNESS. These used to run 0.85-0.95, which is how you author a *metal*,
// not how you author a metallic paint, and it is why the cars read as black
// with sparkle on top. At metalness 0.9 the diffuse term is scaled by 0.1, so
// the pigment all but disappears; the only thing left is a specular lobe whose
// F0 is the pigment colour, and outside the highlight that returns almost
// nothing. A metallic basecoat is a *dielectric binder loaded with aluminium*,
// so the honest metalness is the flake coverage — a third or so — and the
// flake's own neutral F0 is added on top of that in FRAG_FLAKE_SPEC. Candy
// keeps a high value because a candy really is a transparent tinted lacquer
// over a bright metallic ground, and chromeish is a plated finish, not a paint.
const PAINT_PRESETS = {
  solid:    { metalness: 0.04, roughness: 0.36, flake: 0.0,  clearcoat: 1.0, clearcoatRoughness: 0.050, ccIor: 1.52 },
  metallic: { metalness: 0.34, roughness: 0.30, flake: 0.55, clearcoat: 1.0, clearcoatRoughness: 0.042, ccIor: 1.52 },
  pearl:    { metalness: 0.22, roughness: 0.26, flake: 0.35, clearcoat: 1.0, clearcoatRoughness: 0.034, ccIor: 1.58 },
  candy:    { metalness: 0.58, roughness: 0.20, flake: 0.75, clearcoat: 1.0, clearcoatRoughness: 0.026, ccIor: 1.60 },
  matte:    { metalness: 0.12, roughness: 0.62, flake: 0.10, clearcoat: 0.25, clearcoatRoughness: 0.42, ccIor: 1.46 },
  chromeish:{ metalness: 1.0,  roughness: 0.12, flake: 0.25, clearcoat: 1.0, clearcoatRoughness: 0.02, ccIor: 1.55 },
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

  // 0.045 cm is half a millimetre: on a 9 cm car that is glitter, not flake,
  // and as the sole octave it was reading as exactly that. Real automotive
  // flake is 10-50 microns; 0.014 cm is the fine octave, small enough to read
  // as a metallic grain rather than a scattering of confetti.
  //
  // On its own it also never resolves. Director frames the car at 8.5-20
  // percent of frame height racing and 42 percent in the results hero pose,
  // which is 18-35 px/cm and 75-108 px/cm respectively over a 9 cm car, so a
  // 0.014 cm cell is under two pixels even in the closest shot the game
  // composes and the Nyquist fade in FRAG_FLAKE has already retired it. That
  // is why FRAG_FLAKE now runs a second octave at 3.2x this figure, derived in
  // the shader rather than set here: the coarse grain carries the race and
  // hero cameras at a third the tilt, the fine one takes over only in an
  // extreme close-up, and each fades on its own footprint. Changing this value
  // moves both octaves together and keeps their 3.2:1 ratio.
  const flakeSize = o.flakeSize ?? 0.014;
  const uniforms = {
    uMgFlakeScale: { value: 1 / Math.max(0.004, flakeSize) },
    uMgFlakeAmount: { value: flake * 0.55 },
    uMgFlakeGlint: { value: 3.4 },
    uMgFlakeColor: { value: toColor(o.flakeColor ?? 0xfff4e0) },
    uMgCcIor: { value: o.clearcoatIor ?? preset.ccIor },
    uMgCcRough: { value: o.clearcoatRoughness ?? preset.clearcoatRoughness },
    // Fresh lacquer over a fresh basecoat: the coat does not inherit the
    // substrate's microtexture the way a wiped-on varnish does.
    uMgCcFromRough: { value: 0 },
    uMgPeelScale: { value: 1 / 0.55 },
    uMgPeelAmount: { value: (o.orangePeel ?? 1) * 0.55 },
    // The flake never reaches the shading normal, so the filter measures only
    // the paint's own normal map, which is gentle; the extra headroom the
    // sparkle field used to need is gone.
    uMgSaaVar: { value: 0.18 },
    uMgSaaMax: { value: 0.16 },
    uMgRoughMin: { value: SAA_MIN },
  };

  // Handy for a livery editor or a damage system to reach at runtime.
  const install = (m, u) => {
    m.userData.setFlake = (v) => { u.uMgFlakeAmount.value = v * 0.55; };
    m.userData.setClearcoatIor = (v) => { u.uMgCcIor.value = v; };
  };

  patch(mat, {
    objPos: true,
    flake: flake > 0.001,
    clearcoatIor: (o.clearcoat ?? preset.clearcoat) > 0.001,
    peel: (o.clearcoat ?? preset.clearcoat) > 0.001 && (o.orangePeel ?? 1) > 0.001,
    specAA: true,
  }, uniforms, ['paint', flake > 0.001 ? 'f' : '-', (o.clearcoat ?? preset.clearcoat) > 0.001 ? 'c' : '-', (o.orangePeel ?? 1) > 0.001 ? 'p' : '-'], install);
  install(mat, uniforms);

  _cache.set(key, mat);
  return remember(mat);
}

/* ================================================================ fixtures */

/**
 * Polished chrome: the plated normal map carries the orange peel, so the
 * roughness can go as low as it physically should without looking synthetic.
 *
 * `roughness: 1` is not a bug and must not be "fixed" downward. It is this
 * factory's convention throughout: the surface's roughness *map* carries the
 * absolute value and the material multiplier stays at unity, so `surface()`,
 * `plasticToy()` and this all read 1. `chromePlate` bakes 0.035-0.14, so the
 * product is already far sharper than a 1 cm rim wants — lowering the base
 * would drive it to a pinhole mirror of a low-resolution probe. What actually
 * flattened the rims is the antialiasing ceiling: a spoked wheel a few dozen
 * pixels across sweeps its normal so fast that the filter pinned the lobe at
 * (0.28)^0.25 = 0.73 over most of the wheel. So: a tight ceiling, and a
 * roughness *floor* instead of a lower multiplier. The floor cannot fight a
 * corrected map — it is inert the moment the map exceeds it — where a lower
 * multiplier would silently halve whatever the map ends up saying.
 */
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
  // A mirror has no diffuse term to hide its aliasing behind, so it still gets
  // filtered — but with a ceiling that leaves a lobe, and a floor of 0.26 that
  // lands the finish in the 0.25-0.35 band a small plated part wants.
  withSpecAA(mat, 'chrome2', 0.28, 0.09, o.roughnessMin ?? 0.26);
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
  patch(mat, { specAA: true, glassFresnel: true }, {
    uMgSaaVar: { value: 0.25 },
    uMgSaaMax: { value: 0.24 },
    uMgRoughMin: { value: SAA_MIN },
    // Face-on the pane is mostly open, edge-on it is almost solid sky. Those
    // two numbers are the whole difference between glazing and a tinted decal.
    uMgGlassBase: { value: o.opacity ?? 0.42 },
    uMgGlassEdge: { value: o.edgeOpacity ?? 0.97 },
  }, ['glassF']);
  _cache.set(key, mat);
  return remember(mat);
}

/**
 * Tyre rubber (DEFECTS D3). Uses the moulded rubber surface at a tight repeat
 * so the cavity texture reads even on a 1.15 u wheel.
 *
 * Rubber is not black. Carbon-black filled rubber sits around 0.05-0.08 linear
 * albedo, and the anti-ozonant bloom on a moulded tyre lifts it further; the
 * old material multiplied a white tint over an albedo map that bakes ~0.015,
 * which is a void, not a substance — 36.6 mean luma at 2.3 standard deviation
 * across a top-lit curved surface, i.e. no shading at all. Two changes: a
 * colour multiplier above unity to bring the map into the physical band (a
 * Color is a plain uniform, nothing clamps it to 1, and doing it here rather
 * than in the bake leaves the texture usable at its authored level elsewhere),
 * and a broad Charlie sheen. The sheen is what actually makes the sidewall
 * bulge and the tread shoulder read: it is a wide grazing-angle lobe, so it
 * traces the curvature of a dark object exactly where a GGX lobe gives nothing.
 */
export function rubber(o = {}) {
  const key = keyOf('rubber', o);
  const hit = _cache.get(key);
  if (hit) return hit;

  const set = safeSet('rubber');
  const rep = o.repeat ?? 2;
  const mat = new THREE.MeshPhysicalMaterial({
    color: toColor(o.color ?? 0xffffff),
    metalness: 0,
    roughness: o.roughness ?? 1,
    map: set ? withRepeat(set.map, rep, rep) : null,
    normalMap: set ? withRepeat(set.normalMap, rep, rep) : null,
    roughnessMap: set ? withRepeat(set.roughnessMap, rep, rep) : null,
    aoMap: set ? withRepeat(set.aoMap, rep, rep) : null,
    envMapIntensity: o.envMapIntensity ?? 0.85,
    sheen: o.sheen ?? 0.55,
    sheenRoughness: 0.82,
    sheenColor: toColor(o.sheenColor ?? 0x8e8880),
  });
  if (o.color === undefined) mat.color.setRGB(2.30, 2.24, 2.14);
  mat.normalScale.set(o.normalScale ?? 1, o.normalScale ?? 1);
  mat.name = 'rubber';
  if (_env) mat.envMap = _env;
  // A 1.15 u wheel is a few dozen pixels across with a moulded tread normal map
  // on it, so its normal variance per pixel is enormous even though the
  // material itself is dull.
  withSpecAA(mat, 'rubber2');
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
    // Moulded plastic's coat is the moulding itself, so it follows every bit of
    // the surface texture underneath it.
    uMgCcFromRough: { value: 0.45 },
    uMgPeelScale: { value: 1 / 0.8 },
    uMgPeelAmount: { value: 0.30 },
    uMgSaaVar: { value: SAA_VAR },
    uMgSaaMax: { value: 0.22 },
    uMgRoughMin: { value: SAA_MIN },
  };
  patch(mat, { objPos: true, clearcoatIor: gloss > 0.05, peel: gloss > 0.45, specAA: true },
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
  withSpecAA(mat, 'lamp', 0.25, 0.22);
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
  const hasCc = physical && (mat.clearcoat ?? 0) > 0.001;

  // Unlike the others this patch is unconditional: specular antialiasing is not
  // an effect a surface opts into, it is the difference between a material that
  // holds together when it is minified and one that does not.
  const uniforms = {
    uMgMacroScale: { value: macro.scale },
    uMgMacroColor: { value: macro.colorAmount * macroMul },
    uMgMacroRough: { value: macro.roughAmount * macroMul },
    uMgTriScale: { value: (1 / Math.max(0.01, d?.tileWorld ?? 40)) * (typeof o.repeat === 'number' ? o.repeat : 1) },
    uMgTriSharp: { value: o.triSharpness ?? 5.0 },
    uMgCcIor: { value: md.clearcoatIor ?? md.ior ?? 1.5 },
    uMgCcRough: { value: md.clearcoatRoughness ?? 0.1 },
    uMgCcFromRough: { value: md.ccFromRough ?? 0 },
    uMgSaaVar: { value: md.saaVariance ?? SAA_VAR },
    uMgSaaMax: { value: md.saaMax ?? SAA_MAX },
    uMgRoughMin: { value: md.roughnessMin ?? SAA_MIN },
  };
  patch(mat, {
    world: useMacro || triplanar,
    worldNormal: triplanar,
    macro: useMacro,
    triplanar,
    clearcoatIor: hasCc,
    specAA: true,
  }, uniforms, [
    'surf', triplanar ? 'tri' : 'uv', useMacro ? 'm' : '-',
    physical ? 'p' : 's', set?.metalnessMap ? 'me' : '-', hasCc ? 'c' : '-',
  ]);

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

  /** The compiled shader for one of our materials, once it has been drawn at
   *  least once. Lives in a WeakMap rather than on userData — see `_shaders`. */
  shaderFor(mat) { return _shaders.get(mat) || null; },

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
