// fx/Impacts.js — what a collision looks like, and what speed feels like.
//
// Two jobs that share one piece of state (how violent the last second was):
//
//   1. **Contact response.** physics/World.js calls `ctx.fx.impacts.onContact(ev)`
//      directly from its solver — see World._emitContact — with a pooled event
//      carrying { a, b, point, normal, impulse, relativeSpeed, tangentSpeed,
//      kind, surface, vehicleA, vehicleB }. From one impulse number this module
//      derives a spark burst, debris chips, a radial dust puff, a screen flash
//      and a camera shake, all scaled continuously so a kerb tap and a
//      hundred-unit-per-second shunt are the same effect at different volumes.
//
//   2. **Speed.** A single full-screen overlay carries the flash, the radial
//      speed lines in the last 10% of the car's top speed, and the boost field.
//      The speed lines are an event, not an ambience: they are gated on the
//      CAMERA's own travel as well as the subject's speed, they live at the
//      left and right edges of the frame, and at a normal racing pace they are
//      not there at all. See the tuning block and OVERLAY_FRAG's band. It is
//      one extra draw call, drawn in clip space with no matrices at all, and it
//      goes through the composer — so the flash blooms and the speed lines pick
//      up the tilt-shift like everything else in frame.
//
// ------------------------------------------------------------- on not shaking
//
// game/Director.js already subscribes to `vehicle:impact` and shakes itself
// (Director._onImpact, with its own on-camera weighting), and Vehicle.onContact
// emits that event for every contact physics reports. So this module checks
// whether anybody is already listening before it adds trauma of its own — two
// systems shaking for one hit is twice the shake, which reads as a bug. If the
// director is wired up we stay out of its way and only ever shake through the
// explicit `shake()` API. That check is deferred to the first real contact,
// because main.js constructs fx before the director exists.

import * as THREE from 'three';
import { clamp, saturate } from '../core/Random.js';
import { surfaceRecord } from '../vehicle/Tires.js';

/* ==========================================================================
 * Module scratch
 * ========================================================================== */

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
// Reserved for the bus fallback path, which synthesises a contact event and
// must not hand onContact() a vector that onContact() then writes through.
const _fbPoint = new THREE.Vector3();
const _fbNormal = new THREE.Vector3();
const _fbEvent = {
  point: _fbPoint, normal: _fbNormal, impulse: 0, relativeSpeed: 0,
  tangentSpeed: 0, kind: 'car-prop', surface: 'concrete',
  vehicleA: null, vehicleB: null,
};
const _col = new THREE.Color();
const _col2 = new THREE.Color();

/**
 * Impulse that counts as a maximum-violence hit.
 *
 * A mass-1 car arriving at a wall at 110 u/s and stopping delivers an impulse
 * on the order of 110; the arcade shunt terms in Collision.js multiply that
 * up, and game/Director.js already treats 460 as full trauma. Matching that
 * number keeps the shake, the flash and the spark count agreeing about what
 * "a big one" means.
 */
const IMPULSE_FULL = 460;

/** Below this a contact is a resting nudge and gets nothing at all. */
const IMPULSE_MIN = 3;

/* ==========================================================================
 * The overlay
 *
 * Drawn as a clip-space triangle pair: the vertex shader ignores every matrix
 * three offers, so the quad covers the viewport at any aspect, any fov, and
 * during the headless capture path's resize without needing to be told.
 * ========================================================================== */

const OVERLAY_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  // position is a unit plane at +-0.5; x2 puts it on the clip-space cube.
  gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
}
`;

const OVERLAY_FRAG = /* glsl */`
#include <common>

uniform float uTime;
uniform float uAspect;
uniform float uFlash;
uniform vec3  uFlashColor;
uniform vec2  uFlashPos;
uniform float uSpeed;
uniform float uBoost;

varying vec2 vUv;

/**
 * Radial rays.
 *
 * Three incommensurate harmonics of the polar angle, thresholded. Because the
 * frequencies share no common factor the pattern never repeats around the
 * circle, which is what stops it reading as a pinwheel — and it costs three
 * sines rather than a texture fetch and a matrix of UV gymnastics.
 *
 * The threshold is what decides whether this reads as LINES or as a WASH, and
 * it is the whole difference between the two. The sum of the three sines spans
 * +-2.43; a low threshold lights half the circle at some partial level, which
 * is a cream veil with a bit of structure in it rather than a set of streaks.
 * Measured on the sum: cutting in at 1.90 rather than 1.15 takes the lit
 * fraction of the circle from 48% to 24%, so the gaps between rays are as wide
 * as the rays and each one has somewhere dark to be seen against.
 */
float rays(float ang, float phase) {
  float r = sin(ang * 37.0 + phase * 0.7);
  r += sin(ang * 61.0 - phase * 1.1) * 0.82;
  r += sin(ang * 97.0 + 2.1) * 0.61;
  return smoothstep(1.90, 2.62, r + 1.2);
}

void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  // NOT normalised to 1.0 at the corners — it only would be at 1:1. At 16:9 r
  // is 0.71 at the top/bottom edges, 1.26 at the left/right ones and 1.45 in
  // the corners, which is the thing to hold on to when placing a band below.
  float r = length(p) * 1.42;
  float ang = atan(p.y, p.x);

  vec3 col = vec3(0.0);
  float amount = 0.0;

  float intensity = uSpeed + uBoost * 1.35;
  if (intensity > 0.001) {
    // Streaks hug the edge of the frame and stream outwards, so the centre of
    // the action — where the car is — stays completely readable.
    //
    // The old window (0.30 -> 0.74, fading out by 1.35) claimed to be "the
    // outer half" but was not: r reaches only 0.71 at the top and bottom edges
    // and 1.26 at the left and right ones, so a band that peaked at 0.74 and
    // was already dying at 1.0 was strongest across the MIDDLE of a 16:9 frame
    // and contributed almost nothing at the left and right edges. Measured
    // band strength, old vs new: top/bottom edge 0.99 -> 0.29, left/right edge
    // 0.14 -> 1.00, corner 0.00 -> 0.59. Forward motion throws the world past
    // you at the sides, which is now where the streaks actually are.
    float band = smoothstep(0.52, 1.05, r) * (1.0 - smoothstep(1.28, 1.66, r));
    float flow = fract(r * 1.9 - uTime * (1.5 + uBoost * 2.4) + ang * 0.37);
    // A short bright head with a short tail, not a ramp that stays lit across
    // 95% of the cycle — that left no radial gap between one streak and the
    // next, which is the other half of why this read as a sheet.
    float head = smoothstep(0.0, 0.16, flow) * (1.0 - smoothstep(0.16, 0.58, flow));
    float s = rays(ang, uTime) * band * head * intensity;
    // Boost runs cold and electric; raw speed is a near-neutral white so it
    // never pretends to be a power-up.
    vec3 tint = mix(vec3(0.86, 0.91, 1.0), vec3(0.36, 0.68, 1.0), saturate(uBoost));
    col += tint * s * 0.55;
    amount = max(amount, s * 0.55);

    // Boost also lifts a soft rim, which is the part that reads as the frame
    // being pushed outwards. A real screen-space warp needs a copy of the
    // frame buffer, which a forward renderer cannot hand out mid-pass.
    float rim = smoothstep(0.62, 1.25, r) * uBoost;
    col += vec3(0.20, 0.44, 0.92) * rim * 0.32;
    amount = max(amount, rim * 0.32);
  }

  if (uFlash > 0.001) {
    // Centred on where the hit actually happened in screen space, falling off
    // across the frame: the eye is told which side it came from.
    vec2 fp = (uFlashPos - 0.5) * vec2(uAspect, 1.0);
    float d = length(p - fp) * 1.1;
    float f = uFlash * (0.42 + 0.58 * (1.0 - smoothstep(0.0, 1.25, d)));
    col += uFlashColor * f;
    amount = max(amount, f);
  }

  if (amount < 0.002) discard;
  // Additive blending is (SrcAlpha, One), and every term above already carries
  // its own intensity in the colour — so alpha stays at 1 and "amount" is used
  // only to reject pixels that would contribute nothing.
  gl_FragColor = vec4(col, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ==========================================================================
 * Impacts
 * ========================================================================== */

export class Impacts {
  name = 'impacts';

  constructor(ctx = {}) {
    this.ctx = ctx;
    this.enabled = true;
    this.clock = 0;

    this.group = new THREE.Group();
    this.group.name = 'fx:impacts';
    this.group.matrixAutoUpdate = false;

    this.overlay = null;
    this.overlayMat = null;

    /* --- live channels ---------------------------------------------------- */
    this.flash = 0;
    this.flashDecay = 6;
    this.speedLines = 0;
    this.boost = 0;

    /* --- shake ownership, resolved on the first real contact -------------- */
    this._shakeOwner = null;      // null = undecided, true = ours, false = the director's
    this._sawDirectContact = false;
    this._synthesising = false;   // set while the bus fallback fakes an event

    this.tuning = {
      sparkThreshold: 14,       // impulse below which nothing sparks
      sparkPerImpulse: 0.085,   // sparks per unit of impulse at full hardness
      sparkMax: 46,
      debrisMax: 14,
      dustMax: 22,
      flashThreshold: 0.34,     // severity below which the screen does not flash
      flashGain: 0.55,
      shakeGain: 0.85,
      // Speed lines are an EVENT at the top of the rev range, not a state you
      // drive around in. At 0.80/0.9 a car at its usual racing pace sat at 0.59
      // intensity permanently, which is a veil; the last 10% of top speed is
      // somewhere you arrive on a straight and then leave.
      speedThreshold: 0.90,     // fraction of top speed the lines start at
      speedGain: 0.32,          // intensity at dead-on top speed
      scrapeSparkRate: 34,      // sparks/s while grinding along a barrier
      rivalRadius: 150,         // u — beyond this a rival's crash is off camera
    };

    this.stats = { contacts: 0, sparks: 0, flashes: 0, shakes: 0 };
    this._offBus = [];
    this._ready = false;
    this._scrape = new Map();   // vehicle -> accumulated scrape spark fraction
  }

  /* ------------------------------------------------------------------ init */

  async init() {
    const ctx = this.ctx;

    try {
      const geo = new THREE.PlaneGeometry(1, 1);
      const mat = new THREE.ShaderMaterial({
        name: 'fx:overlay',
        uniforms: {
          uTime: { value: 0 },
          uAspect: { value: 16 / 9 },
          uFlash: { value: 0 },
          uFlashColor: { value: new THREE.Color(1.0, 0.94, 0.82) },
          uFlashPos: { value: new THREE.Vector2(0.5, 0.5) },
          uSpeed: { value: 0 },
          uBoost: { value: 0 },
        },
        vertexShader: OVERLAY_VERT,
        fragmentShader: OVERLAY_FRAG,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        fog: false,
      });
      mat.customProgramCacheKey = () => 'mg:fx:overlay';
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'fx:overlay';
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // Last thing in the frame, after every particle and ribbon.
      mesh.renderOrder = 30000;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.visible = false;
      this.overlay = mesh;
      this.overlayMat = mat;
      this.group.add(mesh);
    } catch (err) {
      console.warn('[Impacts] screen overlay unavailable', err);
    }

    ctx.scene?.add?.(this.group);
    this.group.updateMatrixWorld(true);

    const bus = ctx.bus;
    if (bus?.on) {
      // Fallback path only: physics calls onContact() directly, and taking the
      // same event twice would double every burst. See _onVehicleImpact.
      this._offBus.push(bus.on('vehicle:impact', (p) => this._onVehicleImpact(p)));
      this._offBus.push(bus.on('physics:scrape', (p) => this._onScrape(p)));
      this._offBus.push(bus.on('race:reset', () => this.reset()));
      this._offBus.push(bus.on('race:restart', () => this.reset()));
      this._offBus.push(bus.on('race:countdown', (p) => {
        if (p?.value === 0) this.setFlash(0.28, 0xfff0c8, 0.5, 0.5);
      }));
    }

    if (typeof window !== 'undefined') {
      window.MG = window.MG || {};
      window.MG.impacts = this;
    }
    this._ready = true;
    return this;
  }

  /* ------------------------------------------------------- contact response */

  /**
   * Called by physics/World.js for every contact above CONTACT_TUNING.eventImpulse.
   * Must never throw: World wraps the call, but a thrown error there would be
   * swallowed silently and the effects would just stop happening.
   *
   * @param {{point:THREE.Vector3, normal:THREE.Vector3, impulse:number,
   *          relativeSpeed:number, tangentSpeed:number, kind:string,
   *          surface:string, vehicleA:object, vehicleB:object}} ev
   */
  onContact(ev) {
    if (!this._synthesising) this._sawDirectContact = true;
    if (!this.enabled || !this._ready || !ev) return;
    const impulse = Math.abs(ev.impulse || 0);
    if (impulse < IMPULSE_MIN) return;
    this.stats.contacts++;

    const kind = ev.kind || 'hit';
    // A car rides on raycast suspension, but its chassis box still registers
    // speculative contacts against the terrain while it is simply driving
    // along. Only a real landing is worth an effect.
    if (kind.endsWith('ground') && impulse < 40) return;

    const sev = saturate(impulse / IMPULSE_FULL);
    const car = ev.vehicleA || ev.vehicleB || null;
    const point = ev.point;
    if (!point || !Number.isFinite(point.x)) return;

    // Contact normal points A -> B; for the effects we want it pointing back
    // out of whatever was struck, which is the direction the debris leaves in.
    _v0.copy(ev.normal || _v0.set(0, 1, 0));
    if (_v0.lengthSq() < 1e-6) _v0.set(0, 1, 0);
    _v0.normalize();
    if (_v0.y < 0) _v0.negate();

    const rec = surfaceRecord(ev.surface);
    const hardness = rec.hardness ?? 1;
    const metallic = rec.category === 'metal' ? 1 : rec.category === 'hard' || rec.category === 'wood' ? 0.30 : 0;
    const groundY = kind.endsWith('ground') ? point.y : point.y - 1.2;

    /* --- sparks ---------------------------------------------------------- */
    // Die-cast bodies on a hard edge throw sparks; the same car into a felt
    // cushion or a sandbox does not, and pretending otherwise is the kind of
    // detail that makes an effects package read as generic.
    const sparkable = kind === 'car-wall' || kind === 'car-car' || kind === 'car-prop';
    if (sparkable && impulse > this.tuning.sparkThreshold) {
      const hardFactor = clamp(metallic * 0.75 + hardness * 0.45, 0, 1);
      const n = Math.round(clamp(impulse * this.tuning.sparkPerImpulse * hardFactor, 0, this.tuning.sparkMax));
      if (n > 0) {
        // Sparks leave along the reflection of the approach, biased outwards
        // and up, and bounce off the plane they were born over.
        _v1.copy(_v0).multiplyScalar(28 + sev * 90);
        _v1.y = Math.abs(_v1.y) + 16 + sev * 42;
        this._emit('sparks', {
          position: point,
          velocity: _v1,
          count: n,
          spread: 26 + sev * 70,
          jitter: 0.6,
          scale: 0.8 + sev * 0.7,
          opacity: 1,
          groundY,
        });
        this.stats.sparks += n;
      }
    }

    /* --- debris chips ---------------------------------------------------- */
    if (sev > 0.14 && hardness > 0.4) {
      const n = Math.round(clamp(sev * this.tuning.debrisMax, 1, this.tuning.debrisMax));
      _v1.copy(_v0).multiplyScalar(20 + sev * 46);
      _v1.y = Math.abs(_v1.y) + 14 + sev * 34;
      this._emit('debris', {
        position: point,
        velocity: _v1,
        count: n,
        spread: 20 + sev * 40,
        jitter: 0.8,
        color: this._chipColor(ev, rec),
        scale: 0.8 + sev * 0.9,
        life: 0.9 + sev * 0.5,
        groundY,
      });
    }

    /* --- radial dust puff ------------------------------------------------ */
    // Every hit disturbs the air. Emitted as a ring rather than a cone: a puff
    // that expands sideways from the contact reads as displacement, a puff that
    // fires along the normal reads as an explosion.
    const dustN = Math.round(clamp(2 + sev * this.tuning.dustMax, 2, this.tuning.dustMax));
    _v1.set(0, 6 + sev * 16, 0);
    this._emit('dust', {
      position: point,
      velocity: _v1,
      count: dustN,
      spread: 14 + sev * 40,
      jitter: 1.4,
      color: rec.particleColor,
      scale: 0.85 + sev * 1.1,
      opacity: 0.4 + sev * 0.7,
      life: 0.9 + sev * 0.4,
      groundY,
    });

    /* --- scrape: a long grind down a barrier ----------------------------- */
    const tangent = Math.abs(ev.tangentSpeed || 0);
    if (kind === 'car-wall' && tangent > 8 && metallic + hardness > 0.6) {
      this._scrapeSparks(car, point, _v0, tangent, hardness);
    }

    /* --- the camera ------------------------------------------------------ */
    this._reactCamera(car, sev, point, kind);
  }

  /**
   * Colour of the chips. Normally whatever was struck, but a car-car shunt
   * sheds paint flake as well, so half the tint comes from the striker's own
   * livery — which is why two specific cars trading paint looks like those two
   * cars and not like a generic grey burst.
   */
  _chipColor(ev, rec) {
    _col.setHex(rec.particleColor || 0x9a9184);
    const car = ev.vehicleA || ev.vehicleB;
    const base = car?.visual?.livery?.base;
    if (ev.kind === 'car-car' && Number.isFinite(base)) {
      _col2.setHex(base);
      _col.lerp(_col2, 0.45);
    }
    return _col;
  }

  /**
   * A continuous shower while a car grinds along a barrier. The contact events
   * arrive on a 45 ms cooldown, so each one has to carry a slice of time rather
   * than a fixed count, or the stream flickers with the event rate.
   */
  _scrapeSparks(car, point, normal, tangent, hardness) {
    if (!car) return;
    let acc = this._scrape.get(car) ?? 0;
    acc += this.tuning.scrapeSparkRate * saturate(tangent / 60) * hardness * 0.045;
    const n = Math.floor(acc);
    this._scrape.set(car, acc - n);
    if (n <= 0) return;
    // Along the wall, against the direction of travel: a grinding spark stream
    // trails the contact patch, it does not lead it.
    _v2.set(0, 0, 0);
    if (car.velocity) _v2.copy(car.velocity).multiplyScalar(-0.35);
    _v2.addScaledVector(normal, 22 + tangent * 0.4);
    _v2.y += 12;
    this._emit('sparks', {
      position: point,
      velocity: _v2,
      count: n,
      spread: 18 + tangent * 0.35,
      jitter: 0.5,
      scale: 0.7,
      groundY: point.y - 1.2,
    });
    this.stats.sparks += n;
  }

  /* ------------------------------------------------------------ the camera */

  /**
   * Screen flash and shake, weighted by whether the hit is even on camera.
   * A rival crashing forty units behind the player should register; the same
   * crash on the far side of the circuit should not.
   */
  _reactCamera(car, sev, point, kind) {
    const subject = this.ctx?.director?.focusTarget || this.ctx?.player || this.ctx?.vehicles?.[0];
    let weight = 1;
    if (car && subject && car !== subject) {
      if (!car.position || !subject.position) return;
      const d = car.position.distanceTo(subject.position);
      const R = this.tuning.rivalRadius;
      if (d > R) return;
      weight = 0.4 * (1 - d / R);
    } else if (!car) {
      // Prop-on-prop: only worth anything if it happens near the subject.
      if (!subject?.position || !point) return;
      const d = subject.position.distanceTo(point);
      if (d > 90) return;
      weight = 0.22 * (1 - d / 90);
    }

    if (sev * weight > this.tuning.flashThreshold) {
      const amount = saturate((sev * weight - this.tuning.flashThreshold) * this.tuning.flashGain * 2.2);
      // Metal-on-metal flashes cold, everything else warm.
      const hex = kind === 'car-car' ? 0xfff2dc : 0xffe6bc;
      const uv = this._project(point);
      this.setFlash(amount, hex, uv.x, uv.y);
    }

    // Trauma accumulates in Director.shake(), so a stream of negligible
    // contacts would otherwise integrate into a permanent wobble.
    const trauma = sev * weight * this.tuning.shakeGain;
    if (trauma > 0.05 && this._ownsShake()) this.shake(clamp(trauma, 0, 1), 0.28 + sev * 0.34);
  }

  /**
   * True when nobody else is already shaking for impacts.
   *
   * Resolved lazily rather than at init because main.js builds fx before
   * game/Director.js exists, so at construction time the answer is always
   * "nobody" and would always be wrong.
   */
  _ownsShake() {
    if (this._shakeOwner === null) {
      const bus = this.ctx?.bus;
      const listeners = typeof bus?.count === 'function' ? bus.count('vehicle:impact') : 0;
      // Our own 'vehicle:impact' subscription is one of them.
      this._shakeOwner = !(this.ctx?.director && listeners > 1);
    }
    return this._shakeOwner;
  }

  /** Screen-space position of a world point, in UV. Falls back to the centre. */
  _project(point) {
    const cam = this.ctx?.camera;
    _v3.set(0.5, 0.5, 0);
    if (!cam || !point) return _v3;
    _v2.copy(point).project(cam);
    if (!Number.isFinite(_v2.x) || _v2.z > 1) return _v3;
    _v3.set(clamp(_v2.x * 0.5 + 0.5, -0.4, 1.4), clamp(_v2.y * 0.5 + 0.5, -0.4, 1.4), 0);
    return _v3;
  }

  /* ----------------------------------------------------------------- public */

  /**
   * Punch the screen.
   * @param {number} amount 0..1, accumulates
   * @param {number|THREE.Color} [color]
   * @param {number} [u] screen U of the source, 0..1
   * @param {number} [v] screen V
   */
  setFlash(amount, color, u, v) {
    const a = clamp(Number(amount) || 0, 0, 1);
    if (a <= 0) return this;
    if (a > this.flash) {
      this.flash = Math.min(1, this.flash + a);
      const mat = this.overlayMat;
      if (mat) {
        if (color !== undefined && color !== null) {
          if (typeof color === 'number') mat.uniforms.uFlashColor.value.setHex(color);
          else mat.uniforms.uFlashColor.value.set(color);
        }
        if (Number.isFinite(u)) mat.uniforms.uFlashPos.value.set(u, Number.isFinite(v) ? v : 0.5);
      }
      this.stats.flashes++;
    } else {
      this.flash = Math.min(1, this.flash + a * 0.4);
    }
    return this;
  }

  /**
   * Ask the camera director for trauma. Signature matches Director.shake():
   * amount is 0..1 and accumulates, duration is how long this contribution
   * takes to decay. Falls back to the bus, which Director also listens on.
   */
  shake(amount, duration = 0.35) {
    const a = clamp(Number(amount) || 0, 0, 1);
    if (a <= 0) return this;
    const dir = this.ctx?.director;
    if (typeof dir?.shake === 'function') dir.shake(a, duration);
    else this.ctx?.bus?.emit?.('shake', { amount: a, duration });
    this.stats.shakes++;
    return this;
  }

  /** Fire a one-off burst by hand — used by pickups, respawns and the menu. */
  burst(kind, position, o = {}) {
    if (!position) return 0;
    return this._emit(kind, { position, ...o });
  }

  reset() {
    this.flash = 0;
    this.speedLines = 0;
    this.boost = 0;
    this._scrape.clear();
    return this;
  }

  /* ---------------------------------------------------------------- per tick */

  fixedUpdate(fdt) {
    // Flash decays on the fixed tick so `?t=12` never captures a stale white
    // frame left over from a shunt that happened ten seconds ago.
    if (this.flash > 0) this.flash = Math.max(0, this.flash - this.flashDecay * fdt);
  }

  /**
   * How much the camera is travelling, as a 0..1 gate on streaming speed lines.
   *
   * Normalised against the subject's own top speed so it reads the same on
   * every chassis: a camera keeping station with a car at full pace gates to 1,
   * a locked-off camera to 0.
   *
   * A camera CUT teleports the camera, which would otherwise register as an
   * enormous velocity and flash a frame of lines on the first frame of every
   * new shot. Anything past the cut threshold is treated as a jump, not as
   * motion, and returns the previous gate rather than a spike.
   */
  _cameraMotionGate(dt) {
    const cam = this.ctx?.camera;
    if (!cam || !(dt > 0)) return this._camGate ?? 0;

    const p = cam.position;
    const prev = this._prevCamPos;
    if (!prev) {
      this._prevCamPos = { x: p.x, y: p.y, z: p.z };
      this._camGate = 0;
      return 0;
    }

    const dx = p.x - prev.x, dy = p.y - prev.y, dz = p.z - prev.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    prev.x = p.x; prev.y = p.y; prev.z = p.z;

    // A real chase camera at 100 u/s covers under 1 u per frame. 40 u in one
    // frame is not a camera, it is a different shot.
    if (dist > 40) return this._camGate ?? 0;

    const subject = this.ctx?.director?.focusTarget || this.ctx?.player || this.ctx?.vehicles?.[0];
    const top = Math.max(1, subject?.topSpeed || 100);
    // Half top speed is enough camera travel to earn full lines; below a tenth
    // there is effectively no self-motion to report.
    const gate = saturate((dist / dt / top - 0.10) / 0.40);
    this._camGate = gate;
    return gate;
  }

  update(dt, ctx) {
    if (!this._ready) return;
    this.ctx = ctx || this.ctx;
    this.clock += dt;

    const mat = this.overlayMat;
    if (!mat || !this.enabled) {
      if (this.overlay) this.overlay.visible = false;
      return;
    }

    /* --- speed lines ------------------------------------------------------ */
    const subject = this.ctx?.director?.focusTarget || this.ctx?.player || this.ctx?.vehicles?.[0];
    let wantSpeed = 0;
    let wantBoost = 0;
    if (subject) {
      const top = Math.max(1, subject.topSpeed || 100);
      const frac = (subject.speed || 0) / top;
      const th = this.tuning.speedThreshold;
      wantSpeed = saturate((frac - th) / Math.max(0.01, 1 - th)) * this.tuning.speedGain;
      // Airborne, the ground reference disappears and streaming lines read as
      // a glitch rather than as speed.
      if (subject.isAirborne) wantSpeed *= 0.35;
      wantBoost = saturate(subject.boostAmount ?? (subject.boosting ? 1 : 0));
    }
    // SPEED LINES BELONG TO THE CAMERA, NOT THE SUBJECT.
    //
    // This was keyed purely to the subject's speed, so a wide establishing shot
    // of a motionless table carried a full-screen radial streak veil because a
    // 40-pixel toy car somewhere in frame happened to be going fast. Measured on
    // the round-3 wide: fx:overlay alone lifted the far wall from 125 to 176 of
    // 255, and the critic's phrasing was "nobody ships a static overview with
    // speed lines on it".
    //
    // Streaming lines are a cue about how fast the VIEWER is travelling. A chase
    // camera rides with the car and earns them; a locked-off wide does not,
    // however fast the subject is moving. So the subject term is now scaled by
    // how far the camera itself moved this frame.
    wantSpeed *= this._cameraMotionGate(dt);

    // Damped, like everything else the camera does: lines that snapped on at
    // exactly the threshold would strobe every time the car sat on the boundary.
    //
    // Asymmetric, though, because this is meant to land as a punch. Hitting the
    // top of the rev range should arrive quickly (~60 ms) while coming off it
    // decays over ~250 ms, so the effect trails the surge instead of blinking
    // out the instant a corner scrubs a unit of speed off.
    const rising = wantSpeed > this.speedLines;
    this.speedLines += (wantSpeed - this.speedLines) * (1 - Math.exp(-dt * (rising ? 16 : 6)));
    this.boost += (wantBoost - this.boost) * (1 - Math.exp(-dt * 7));

    const u = mat.uniforms;
    u.uTime.value = this.clock;
    u.uFlash.value = this.flash;
    u.uSpeed.value = this.speedLines;
    u.uBoost.value = this.boost;
    const cam = this.ctx?.camera;
    if (cam?.aspect) u.uAspect.value = cam.aspect;

    // The overlay is a full-screen quad; not drawing it at all when there is
    // nothing to show is worth more than the branch inside the shader.
    this.overlay.visible = this.flash > 0.002 || this.speedLines > 0.004 || this.boost > 0.004;
  }

  onResize(w, h) {
    if (this.overlayMat && w > 0 && h > 0) this.overlayMat.uniforms.uAspect.value = w / h;
  }

  /* ---------------------------------------------------------------- events */

  /**
   * Fallback contact path.
   *
   * physics/World.js calls onContact() directly AND, through
   * Vehicle.onContact, emits `vehicle:impact` for the same collision — the bus
   * event first. Acting on both would double every burst, and waiting for the
   * direct call to prove itself would still double the very first one. So the
   * test is whether a physics world exists at all: World._emitContact calls
   * `ctx.fx.impacts.onContact` unconditionally, so if physics is up, the direct
   * path is live. This branch is for a build with no physics world, where
   * `vehicle:impact` is the only signal there is.
   */
  _onVehicleImpact(p) {
    if (this._sawDirectContact || this.ctx?.physics || !this.enabled || !this._ready) return;
    const car = p?.vehicle;
    const impulse = Math.abs(p?.impulse || 0);
    if (!car || impulse < IMPULSE_MIN) return;

    // A prebuilt event record with its own vectors: onContact() writes through
    // the module scratch, so handing it _v0/_v1 would corrupt its own inputs.
    if (car.position) _fbPoint.copy(car.position);
    else _fbPoint.set(0, 0, 0);
    _fbNormal.set(0, 1, 0);
    _fbEvent.impulse = impulse;
    _fbEvent.relativeSpeed = car.speed || 0;
    _fbEvent.tangentSpeed = 0;
    _fbEvent.kind = p?.kind || 'car-prop';
    _fbEvent.surface = car.surface || 'concrete';
    _fbEvent.vehicleA = car;
    _fbEvent.vehicleB = p?.other?.vehicle || null;
    this._synthesising = true;
    try { this.onContact(_fbEvent); } finally { this._synthesising = false; }
  }

  /**
   * `physics:scrape` is emitted by the same World._emitContact call that
   * reaches onContact(), whose car-wall branch already showers sparks. This is
   * only here for a physics implementation that emits the event without the
   * direct call.
   */
  _onScrape(ev) {
    if (this._sawDirectContact || this.ctx?.physics) return;
    if (!this.enabled || !this._ready || !ev?.point) return;
    const car = ev.vehicleA || ev.vehicleB;
    const rec = surfaceRecord(ev.surface);
    _v0.copy(ev.normal || _v0.set(0, 1, 0)).normalize();
    if (_v0.y < 0) _v0.negate();
    this._scrapeSparks(car, ev.point, _v0, Math.abs(ev.tangentSpeed || 0), rec.hardness ?? 1);
  }

  /* --------------------------------------------------------------- plumbing */

  /** Every particle this module spawns goes through fx/Particles.js. */
  _emit(kind, opts) {
    const p = this.ctx?.fx?.particles;
    if (!p?.emit) return 0;
    try {
      return p.emit(kind, opts) || 0;
    } catch (_) {
      // A broken particle system must not stop the camera reacting to a crash.
      return 0;
    }
  }

  setEnabled(v) {
    this.enabled = !!v;
    this.group.visible = this.enabled;
    return this;
  }

  applySettings(settings) {
    const s = settings || this.ctx?.settings;
    this.setEnabled(s?.particles?.enabled !== false);
    const shakeScale = s?.gameplay?.cameraShake;
    if (Number.isFinite(shakeScale)) this.tuning.shakeGain = 0.85 * clamp(shakeScale, 0, 2);
    return this;
  }

  setQuality() { return this.applySettings(this.ctx?.settings); }

  info() {
    return {
      flash: +this.flash.toFixed(3),
      speedLines: +this.speedLines.toFixed(3),
      boost: +this.boost.toFixed(3),
      ownsShake: this._shakeOwner,
      directContacts: this._sawDirectContact,
      ...this.stats,
    };
  }

  dispose() {
    for (const off of this._offBus) { try { off?.(); } catch (_) { /* already gone */ } }
    this._offBus.length = 0;
    this.overlay?.geometry?.dispose?.();
    this.overlayMat?.dispose?.();
    this.overlay = null;
    this.overlayMat = null;
    this._scrape.clear();
    this.group.parent?.remove(this.group);
  }
}

export const ImpactSystem = Impacts;
export default Impacts;
